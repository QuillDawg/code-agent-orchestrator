/**
 * `cao pause [run]` and `cao pause [run] --off` — hold a run's scheduling from another terminal (§3.2).
 *
 * A hold is not a stop. Whatever is already running finishes its turn, nothing new is started, and the run
 * does not end: no report is written, no lock is released, and `cao resume` is not involved. It is the
 * command for "let this settle for a minute" rather than "I am done with this".
 *
 * `--off` rather than a second command. `cao resume` already means "start an ended run again", and a
 * `cao resume` that sometimes meant "un-hold a live one" would be one word with two jobs on the one
 * surface where being wrong costs an hour of agent time.
 *
 * The same three-way errand as `cao task stop|restart`: this process when it owns the run, a request file
 * when another one does, and a usage error when nobody is executing it — there is no scheduler to hold.
 */
import { openStore, readOrchestrator } from '../util.js';
import { ownershipOf } from '../ownership.js';
import { controlEnvelope } from '../../workflow/control/commands.js';
import { localController } from '../../workflow/control/local.js';
import { controlRequest, sendControlRequest, DEFAULT_ACK_WAIT_SECONDS } from '../../persistence/requests.js';
import { UsageError } from '../../util/errors.js';
import { sanitizeText } from '../color.js';
import { mark, warnLine } from '../../util/marks.js';

export interface PauseOptions {
  repository?: string;
  /** Schedule again, rather than holding. */
  off?: boolean;
  /** Seconds to wait for the owning process to answer. 0 returns as soon as the request is on disk. */
  wait?: number;
}

export async function pauseCommand(runRef: string | undefined, opts: PauseOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const releasing = opts.off === true;
  const verb = releasing ? 'continue' : 'pause';
  const store = await openStore(opts.repository);
  const runId = await store.resolveRunId(runRef);
  const ownership = ownershipOf(await readOrchestrator(store, runId));

  // `self` with nothing registered is a lock file naming a pid the OS has since handed to this process:
  // there is no controller here, and no other process to ask either.
  const here = ownership.kind === 'self' ? localController(runId) : undefined;
  if (ownership.kind !== 'owned' && !here) {
    throw new UsageError(
      `No orchestrator is executing run ${runId}, so there is nothing to ${verb}. "cao resume ${runId}" starts it again.`,
    );
  }

  const command = releasing ? ({ kind: 'resume' } as const) : ({ kind: 'pause' } as const);
  if (here) {
    const ack = await here.submit(command, controlEnvelope('cli'));
    out(`${verb} (run ${runId}, this process): ${ack.status}${ack.reason ? ` ${sanitizeText(ack.reason)}` : ''}`);
    return ack.status === 'rejected' ? 2 : 0;
  }

  const pid = ownership.pid;
  const wait = opts.wait ?? DEFAULT_ACK_WAIT_SECONDS;
  const sent = await sendControlRequest(store.paths, runId, controlRequest(releasing ? 'resume' : 'pause'), { wait });
  out(`${verb} (run ${runId}) sent to pid ${pid}.`);
  if (!sent.ack) {
    out(warnLine(`No answer in ${wait}s. The request is still in requests/ and is applied when pid ${pid} reads it; "cao status ${runId}" shows the result.`));
    return 0;
  }
  const reason = sent.ack.reason ? ` ${sanitizeText(sent.ack.reason)}` : '';
  out(`${mark(sent.ack.status === 'rejected' ? 'error' : 'ok')} ${sent.ack.status}${reason}`);
  return sent.ack.status === 'rejected' ? 2 : 0;
}
