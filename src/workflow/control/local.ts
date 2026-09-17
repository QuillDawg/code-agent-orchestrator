/**
 * The run controllers this process is holding, by run id.
 *
 * §2.2 makes the controller the only way execution state changes, and §2.3 gives a *different* process the
 * request inbox to reach it. A command raised in the process that already owns the run should not take the
 * long way round: writing a file for itself to poll would answer the operator half a second late, and only
 * if the scheduler happens to still be ticking.
 *
 * So `cao task stop|restart` looks here first (`self` ownership) and falls back to the inbox. That is the
 * only lookup today; it matters for an embedder that drives the scheduler and the CLI from one process, and
 * it keeps the "no second path" rule literally true rather than true-by-accident.
 *
 * A plain `Map`: no timer, no listener, one entry per run this process has executed, replaced when the same
 * run is executed again (§2.4 mounts a new runtime into the workspace that is already open).
 */
import type { RunController } from './controller.js';

const controllers = new Map<string, RunController>();

/** Record the controller for a run this process owns. Returns the function that forgets it again. */
export function registerLocalController(runId: string, controller: RunController): () => void {
  controllers.set(runId, controller);
  return () => {
    if (controllers.get(runId) === controller) controllers.delete(runId);
  };
}

/** The controller for a run this process owns, or undefined when the run belongs to another process. */
export function localController(runId: string): RunController | undefined {
  return controllers.get(runId);
}
