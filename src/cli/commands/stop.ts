import { openStore, readOrchestrator } from '../util.js';
import { requestStop } from '../../execution/signals.js';
import { sleep } from '../../util/misc.js';
import { warnLine } from '../../util/marks.js';

export interface StopOptions {
  repository?: string;
  /** Seconds to wait for the orchestrator to let go of the run. 0 returns as soon as the request is written. */
  wait?: number;
}

/**
 * Interrupt a run from another terminal, the way Ctrl+C does in the terminal that owns it: the orchestrator
 * stops scheduling, terminates its workers, persists `interrupted` and exits 130. Stop it twice to force it.
 */
export async function stopCommand(runRef: string | undefined, opts: StopOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const runId = await store.resolveRunId(runRef);
  const run = await store.loadRun(runId);
  // Not `readLock`: a run whose lock file has gone missing under a live orchestrator would otherwise be
  // reported as "nothing to stop", and the reader sent to `cao resume` on top of it.
  const orchestrator = await readOrchestrator(store, runId);

  if (!orchestrator?.alive) {
    // "Run X is not running (state: running)" is the state the run last saved, not the state of the world:
    // an orchestrator killed hard never got to write `interrupted`. Report the process, not the record.
    out(
      warnLine(
        run.state === 'running'
          ? `No orchestrator is running for ${runId}; nothing to stop. It is still recorded as running because its orchestrator exited without saving.`
          : `Run ${runId} has already finished (state: ${run.state}); nothing to stop.`,
      ),
    );
    // A lock whose process is gone is not in the way: `cao resume` takes it over, so say that instead of
    // deleting a file that another orchestrator might yet be writing.
    if (orchestrator) out(`Its ${orchestrator.source === 'lock' ? 'lock' : 'live status'} is stale (pid ${orchestrator.pid} is gone).`);
    if (run.state !== 'completed' && run.state !== 'cancelled') out(`Continue the run with: cao resume ${runId}`);
    return 0;
  }

  await requestStop(store.paths, runId);
  out(`Stop requested for run ${runId} (orchestrator pid ${orchestrator.pid}).`);

  const deadlineMs = (opts.wait ?? 30) * 1000;
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    await sleep(250);
    const current = await readOrchestrator(store, runId);
    if (!current?.alive) {
      out(`Run ${runId} stopped. Resume it with: cao resume ${runId}`);
      return 0;
    }
  }
  out(deadlineMs > 0 ? warnLine(`The orchestrator is still shutting down. Run "cao stop ${runId}" again to kill its workers immediately.`) : `Run "cao status ${runId}" to see when it has stopped.`);
  return 0;
}
