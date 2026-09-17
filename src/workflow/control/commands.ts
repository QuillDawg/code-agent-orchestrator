/**
 * What can be asked of a run, and who asked (spec §2.2).
 *
 * Separate from `controller.ts` so `scheduler.ts` can carry a command on its wake queue without importing
 * the controller that submits it: the scheduler applies commands, the controller is one of its callers.
 *
 * `ControlAck` lives in the protocol package instead, because an ack is written to disk for the inbox to
 * read (§2.3); the command union and the envelope never leave the process that built them.
 */
import type { ControlSource, InteractionAnswer } from 'code-agent-orchestrator-protocol';
import { nowIso } from '../../util/misc.js';
import { ulid } from '../../util/ulid.js';

/**
 * The fields an edit may change (spec §3.4). Declared here so the inbox, the CLI and the TUI can be built
 * against the whole command shape now; **applying** an edit ships in stage 2.
 */
export interface TaskEdit {
  prompt?: string;
  agent?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  retries?: number;
  maxBudgetUsd?: number;
  note?: string;
}

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
  | { kind: 'prompt'; taskId: string; text: string; mode: 'steer' | 'followUp' | 'stopAndContinue' }
  | { kind: 'approve'; taskId: string; note?: string }
  | { kind: 'reject'; taskId: string; note?: string }
  | { kind: 'answer'; taskId: string; interactionId: string; answer: InteractionAnswer };

export type ControlCommandKind = ControlCommand['kind'];

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
  expected?: { attempt?: number; revision?: number };
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
