/**
 * `cao task stop <task>` and `cao task restart <task>` (spec §3.3, §2.3, `[D6]`).
 *
 * Both are the same errand with a different command in it: find the process that owns the run, ask it, and
 * print what it answered. Which of the three answers applies is decided by ownership (§2.1), not by trying
 * one path and falling back:
 *
 * - **self** — this process holds the run, so the controller is right here (§2.2 makes it the only way
 *   execution state changes, and it is a function call away). Writing a file for this process to poll would
 *   answer half a second late and only while the scheduler is still ticking.
 * - **owned** — another live process holds it. The request goes into `requests/` and this command waits up
 *   to `--wait` seconds for the ack that process writes back. An elapsed wait is **not** a refusal: the file
 *   is still there and is applied when the owner next reads it.
 * - **abandoned or ended** — nobody is executing the run, so there is nothing to ask. A usage error naming
 *   `cao resume`, which is what actually gets the task moving again.
 *
 * No `expected` on the envelope. This command's view of the run comes from `workflow.json`, which the owner
 * rewrites on its own schedule, so an attempt number read here can be one behind the truth — and a staleness
 * check built on it would refuse a perfectly good restart. The owner's own decision (`still running`,
 * `already succeeded`) is the guard that matters, and it is made against live state.
 */
import { openStore, resolveRunAndTask, readOrchestrator } from '../util.js';
import { ownershipOf } from '../ownership.js';
import { controlEnvelope, type ControlCommand } from '../../workflow/control/commands.js';
import { localController } from '../../workflow/control/local.js';
import { controlRequest, sendControlRequest, DEFAULT_ACK_WAIT_SECONDS } from '../../persistence/requests.js';
import { UsageError } from '../../util/errors.js';
import { sanitizeText } from '../color.js';
import { mark, warnLine } from '../../util/marks.js';

export type TaskControlKind = 'stop' | 'restart';

export interface TaskControlOptions {
  repository?: string;
  /** Seconds to wait for the owning process to answer. 0 returns as soon as the request is on disk. */
  wait?: number;
}

/** What each control is called in the output, and what it asks the controller for. */
const CONTROLS: Record<TaskControlKind, { verb: string; command: (taskId: string) => ControlCommand }> = {
  stop: { verb: 'stop', command: (taskId) => ({ kind: 'cancelTask', taskId }) },
  restart: { verb: 'restart', command: (taskId) => ({ kind: 'restart', taskId }) },
};

export async function taskControlCommand(kind: TaskControlKind, refs: string[], opts: TaskControlOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const control = CONTROLS[kind];
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveRunAndTask(store, refs, `cao task ${kind} [run] <task>`);
  const runId = run.runId;
  const ownership = ownershipOf(await readOrchestrator(store, runId));

  // `self` with nothing registered is a lock file naming a pid the OS has since given to this process:
  // there is no controller here, and no other process to ask either.
  const here = ownership.kind === 'self' ? localController(runId) : undefined;
  if (ownership.kind !== 'owned' && !here) {
    throw new UsageError(
      `No orchestrator owns run ${runId}; use "cao resume ${runId}" to start it again${kind === 'restart' ? `, with --task ${taskId} to re-run just this task` : ''}.`,
    );
  }

  if (here) {
    const ack = await here.submit(control.command(taskId), controlEnvelope('cli'));
    out(`${control.verb} ${taskId} (run ${runId}, this process): ${ack.status}${ack.reason ? ` ${sanitizeText(ack.reason)}` : ''}`);
    return ack.status === 'rejected' ? 2 : 0;
  }

  const pid = ownership.pid;
  const wait = opts.wait ?? DEFAULT_ACK_WAIT_SECONDS;
  // `stop` naming a task means "cancel this attempt" on the wire; the run-level stop is `cao stop` (§2.3).
  const sent = await sendControlRequest(store.paths, runId, controlRequest(kind, { taskId }), { wait });
  out(`${control.verb} ${taskId} (run ${runId}) sent to pid ${pid}.`);
  if (!sent.ack) {
    out(warnLine(`No answer in ${wait}s. The request is still in requests/ and is applied when pid ${pid} reads it; "cao task ${taskId}" shows the result.`));
    return 0;
  }
  const reason = sent.ack.reason ? ` ${sanitizeText(sent.ack.reason)}` : '';
  out(`${mark(sent.ack.status === 'rejected' ? 'error' : 'ok')} ${sent.ack.status}${reason}`);
  return sent.ack.status === 'rejected' ? 2 : 0;
}
