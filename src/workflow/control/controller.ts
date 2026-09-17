/**
 * The run controller (spec §2.2): the one object through which anything outside `src/workflow/` changes a
 * run's execution state.
 *
 * It is not a second engine. The scheduler stays the sole owner of run state; every command here enters that
 * scheduler's wake queue and is applied between two of its own events, so a keystroke, a `cao stop` from
 * another terminal and an attempt finishing can never interleave halfway through each other.
 *
 * It outlives the scheduler it drives. After `finalize()` a surface still holds this object - the workspace
 * stays open on an ended run (§2.4) - so the read-only accessors keep answering and every command is
 * refused with a sentence that says the run has ended. A finalized scheduler is never reused.
 */
import type { AttemptDiff, ControlAck, TranscriptEntry, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { WorkflowScheduler } from '../scheduler.js';
import { systemClock, type Clock } from '../../util/misc.js';
import type { ControlCommand, ControlEnvelope } from './commands.js';

export type { ControlCommand, ControlCommandKind, ControlEnvelope, TaskEdit } from './commands.js';

/**
 * What a surface may read. None of it changes anything, all of it keeps working after the run has ended, and
 * it is here rather than on the scheduler so a dashboard holds one object instead of two.
 */
export interface RunControllerReads {
  readonly run: WorkflowRun;
  /** Whether the run has been finalized. Commands are refused from here on; reads are not. */
  readonly ended: boolean;
  /** Whether a stop has been requested and the run is winding down. */
  readonly stopping: boolean;
  /** Whether an interactive dashboard is attached to *this* process (§2.1). */
  readonly canInteract: boolean;
  peek(taskId: string, entries?: number): TranscriptEntry[];
  transcript(taskId: string): TranscriptEntry[];
  attemptTranscript(taskId: string, attempt: number): Promise<TranscriptEntry[]>;
  olderTranscript(taskId: string, attempt: number, oldest: TranscriptEntry | undefined, count?: number): Promise<TranscriptEntry[]>;
  olderTaskTranscript(taskId: string, attempt: number, oldest: TranscriptEntry | undefined, count?: number): Promise<TranscriptEntry[]>;
  capturedDiff(taskId: string): Promise<{ attempt: number; diff: AttemptDiff; patch: string } | null>;
  /** Last-resort synchronous persistence on a force-kill; the crash handler's only chance to save state. */
  persistInterruptedSync(): void;
}

export interface RunController extends RunControllerReads {
  /**
   * Ask the run to do something, and get back the one answer to that request.
   *
   * The same `envelope.id` submitted twice is applied once and answered with the first ack, verbatim, so a
   * sender that resends after losing an ack is safe. A rejection carries a `reason` that is a sentence for a
   * human: it is the text the TUI shows as a notice and the CLI prints before exiting 2.
   */
  submit(command: ControlCommand, envelope: ControlEnvelope): Promise<ControlAck>;
  /**
   * What a `kill` command escalates to once the run's state has been stopped: killing the worker processes
   * and leaving. Wired after construction because the thing that does it (`createInterruptController`) needs
   * this controller to exist first.
   */
  setKillHandler(handler: () => void): void;
}

export interface RunControllerDeps {
  scheduler: WorkflowScheduler;
  clock?: Clock;
  /** See `setKillHandler`; may also be given up front when the caller already has one. */
  onKill?: () => void;
}

export function createRunController(deps: RunControllerDeps): RunController {
  const { scheduler } = deps;
  const clock = deps.clock ?? systemClock;
  let onKill = deps.onKill;

  return {
    get run() {
      return scheduler.run;
    },
    get ended() {
      return scheduler.ended;
    },
    get stopping() {
      return scheduler.stopping;
    },
    get canInteract() {
      return scheduler.canInteract;
    },
    peek: (taskId, entries) => scheduler.peek(taskId, entries),
    transcript: (taskId) => scheduler.transcript(taskId),
    attemptTranscript: (taskId, attempt) => scheduler.attemptTranscript(taskId, attempt),
    olderTranscript: (taskId, attempt, oldest, count) => scheduler.olderTranscript(taskId, attempt, oldest, count),
    olderTaskTranscript: (taskId, attempt, oldest, count) => scheduler.olderTaskTranscript(taskId, attempt, oldest, count),
    capturedDiff: (taskId) => scheduler.capturedDiff(taskId),
    persistInterruptedSync: () => scheduler.persistInterruptedSync(),

    setKillHandler: (handler) => {
      onKill = handler;
    },

    async submit(command, envelope) {
      const ack = await scheduler.submitControl(command, envelope);
      if (command.kind === 'kill' && ack.status === 'applied' && onKill) {
        // After the ack, not before it: the escalation ends this process, and a caller waiting on the answer
        // to its own request - the inbox writing `requests/acks/` - has to get it written first.
        clock.setTimeout(() => onKill?.(), 0);
      }
      return ack;
    },
  };
}
