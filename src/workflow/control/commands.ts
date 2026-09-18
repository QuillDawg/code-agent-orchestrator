/**
 * What can be asked of a run, and who asked (spec §2.2).
 *
 * Separate from `controller.ts` so `scheduler.ts` can carry a command on its wake queue without importing
 * the controller that submits it: the scheduler applies commands, the controller is one of its callers.
 *
 * `ControlAck` lives in the protocol package instead, because an ack is written to disk for the inbox to
 * read (§2.3); the command union and the envelope never leave the process that built them.
 */
import { PROMPT_DELIVERY_MODES } from 'code-agent-orchestrator-protocol';
import type {
  ControlExpectation,
  ControlRequest,
  ControlSource,
  InteractionAnswer,
  PromptDeliveryMode,
  TaskEdit,
} from 'code-agent-orchestrator-protocol';
import { nowIso } from '../../util/misc.js';
import { ulid } from '../../util/ulid.js';

/**
 * The fields an edit may change (spec §3.4). The shape itself lives in the protocol package, because a
 * request file carries one across the process boundary (§2.3); **applying** an edit ships in stage 2.
 */
export type { TaskEdit };

export type ControlCommand =
  /** Run-level, exactly as today: `wait` lets workers finish their turn, `cancel` aborts them. */
  | { kind: 'stop'; mode: 'wait' | 'cancel' }
  /** The named escalation — never inferred from two clicks (§2.3). */
  | { kind: 'kill' }
  /** Abort one in-flight attempt and end its task as `cancelled` `[D22]`. */
  | { kind: 'cancelTask'; taskId: string }
  /** Return a terminal non-success task to `pending` so the run picks it up again. */
  | { kind: 'restart'; taskId: string }
  | { kind: 'edit'; taskId: string; changes: TaskEdit; restart: boolean }
  /** §3.5. `freshSession` is the explicit half of `[D25]`: start over rather than continue the session. */
  | { kind: 'prompt'; taskId: string; text: string; mode: PromptDeliveryMode; freshSession?: boolean }
  | { kind: 'approve'; taskId: string; note?: string }
  | { kind: 'reject'; taskId: string; note?: string }
  | { kind: 'answer'; taskId: string; interactionId: string; answer: InteractionAnswer };

export type ControlCommandKind = ControlCommand['kind'];

/**
 * What a run that has already ended says to anything still asking it to do something (§2.2).
 *
 * One sentence, because a sender sees it from two places: the controller refuses a command with it, and the
 * inbox answers with it whatever was still waiting in `requests/` when the orchestrator left.
 */
export function runEndedReason(runId: string): string {
  return `This run has ended, so its execution state cannot be changed. Start it again with "cao resume ${runId}".`;
}

/**
 * Who sent a command, when, and what state they believed the run was in.
 *
 * `id` is the deduplication key for the life of the run: the same id submitted twice is answered with the
 * first ack and applied once, which is what makes a resend after a lost ack safe (§2.2).
 *
 * `expected` is how a surface that drew a screen some milliseconds ago says so. A restart built on attempt 2
 * is refused once the task has moved on to attempt 3, instead of quietly restarting work the operator never
 * looked at.
 */
export interface ControlEnvelope {
  /** ULID; `src/util/ulid.ts`. */
  id: string;
  source: ControlSource;
  pid: number;
  at: string;
  expected?: ControlExpectation;
}

/**
 * A fresh envelope for a command raised in this process. `expected` is the state the caller drew its screen
 * from, when it has one: pass it and a command built on a stale view is refused instead of applied to
 * something the operator never saw.
 */
export function controlEnvelope(source: ControlSource, expected?: ControlEnvelope['expected']): ControlEnvelope {
  return { id: ulid(), source, pid: process.pid, at: nowIso(), ...(expected ? { expected } : {}) };
}

/** The task a command names, or undefined for the run-level ones. */
export function commandTaskId(command: ControlCommand): string | undefined {
  return 'taskId' in command ? command.taskId : undefined;
}

/**
 * How many revisions a task has. Stage 2 (§3.4) appends them; until then every task is at revision 0, and
 * `expected.revision` still has something truthful to compare against.
 */
export function revisionCount(state: unknown): number {
  const revisions = (state as { revisions?: readonly unknown[] } | null | undefined)?.revisions;
  return Array.isArray(revisions) ? revisions.length : 0;
}

// ---------------------------------------------------------------------------- from the inbox (§2.3)

/**
 * What a request file turned into: a command to submit, or the sentence to acknowledge it with.
 *
 * This is the whole trust boundary of the inbox. A file cannot ask for anything the union cannot express,
 * and the three permission kinds never become a command at all - they are refused here, before the
 * controller is called, because `[D3]` puts them behind presence gating rather than behind a file anyone
 * with write access to the run directory can create.
 */
export type RequestTranslation = { ok: true; command: ControlCommand } | { ok: false; reason: string };

/** §2.3: `approve`, `reject` and `answer` are not taken from disk, whatever the run is doing. */
const PERMISSION_FROM_DISK =
  'permission controls are not accepted from disk until presence gating ships';

function needsTask(kind: string): RequestTranslation {
  return { ok: false, reason: `A ${kind} request has to name a task, and this one does not.` };
}

/** The envelope a request arrives in: its own id, so the ack on disk answers the file that asked. */
export function envelopeForRequest(request: ControlRequest): ControlEnvelope {
  return {
    id: request.id,
    source: 'inbox',
    pid: typeof request.pid === 'number' ? request.pid : 0,
    at: typeof request.requestedAt === 'string' ? request.requestedAt : nowIso(),
    ...(request.expected ? { expected: request.expected } : {}),
  };
}

export function commandForRequest(request: ControlRequest): RequestTranslation {
  const taskId = typeof request.taskId === 'string' && request.taskId !== '' ? request.taskId : undefined;
  switch (request.kind) {
    case 'stop':
      // A stop that names a task is `cao task stop <task>` from another terminal (§2.3): one attempt is
      // aborted and the run carries on. Without a task it is the run-level stop `stop.json` has always been.
      // No mode on the wire either way: a stop from another terminal has always meant the cancelling kind,
      // the way Ctrl+C does, and `stop.json` has never carried one.
      return taskId ? { ok: true, command: { kind: 'cancelTask', taskId } } : { ok: true, command: { kind: 'stop', mode: 'cancel' } };
    case 'kill':
      return { ok: true, command: { kind: 'kill' } };
    case 'restart':
      return taskId ? { ok: true, command: { kind: 'restart', taskId } } : needsTask('restart');
    case 'edit':
      if (!taskId) return needsTask('edit');
      return { ok: true, command: { kind: 'edit', taskId, changes: request.changes ?? {}, restart: request.restart === true } };
    case 'prompt': {
      if (!taskId) return needsTask('prompt');
      const text = typeof request.text === 'string' ? request.text : '';
      if (text.trim() === '') return { ok: false, reason: 'A prompt request has to carry the text to deliver, and this one is empty.' };
      const mode = request.mode !== undefined && (PROMPT_DELIVERY_MODES as readonly string[]).includes(request.mode) ? request.mode : 'followUp';
      return { ok: true, command: { kind: 'prompt', taskId, text, mode, ...(request.freshSession === true ? { freshSession: true } : {}) } };
    }
    case 'approve':
    case 'reject':
    case 'answer':
      return {
        ok: false,
        reason: `Do this in the terminal that owns this run${taskId ? ` (task "${taskId}")` : ''}: ${PERMISSION_FROM_DISK}.`,
      };
  }
}
