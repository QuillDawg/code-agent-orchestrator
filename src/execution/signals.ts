/** Ctrl+C / SIGTERM handling: stop scheduling, terminate workers, persist state, exit 130. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkflowScheduler } from '../workflow/scheduler.js';
import type { ProcessManager } from './process-manager.js';
import type { Logger } from '../logging/logger.js';
import type { RunPaths } from '../persistence/paths.js';
import { pathExists, readJsonIfExists, writeFileAtomic } from '../util/fs.js';
import { nowIso } from '../util/misc.js';

export interface InterruptControllerOptions {
  scheduler: WorkflowScheduler;
  processManager: ProcessManager;
  logger: Logger;
  hardDeadlineMs?: number;
  /** Called on the first interrupt so a UI can show a notice. */
  onInterrupt?: () => void;
}

export interface InterruptController {
  /** Request a graceful stop (first call) or force-kill everything (second call). */
  interrupt(source?: string): void;
  /** Install process signal handlers; returns a disposer. */
  install(): () => void;
  readonly interrupted: boolean;
}

export function createInterruptController(opts: InterruptControllerOptions): InterruptController {
  const { scheduler, processManager, logger } = opts;
  let interrupts = 0;
  let hardTimer: NodeJS.Timeout | undefined;

  const forceExit = (): void => {
    processManager.killAllSync();
    try {
      scheduler.persistInterruptedSync();
    } catch {
      /* ignore */
    }
    process.exit(130);
  };

  const interrupt = (source = 'signal'): void => {
    interrupts += 1;
    if (interrupts === 1) {
      logger.warn(`${source}: stopping workers (interrupt again to force)`);
      opts.onInterrupt?.();
      scheduler.requestStop('cancel', 'signal');
      void processManager.shutdown('graceful');
      hardTimer = setTimeout(() => {
        logger.error('workers did not exit in time; forcing');
        forceExit();
      }, opts.hardDeadlineMs ?? 20_000);
      hardTimer.unref();
      return;
    }
    logger.error('second interrupt: killing workers immediately');
    forceExit();
  };

  const install = (): (() => void) => {
    const onSignal = (signal: NodeJS.Signals): void => interrupt(signal);
    const onExit = (): void => processManager.killAllSync();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (process.platform !== 'win32') process.on('SIGHUP', onSignal);
    process.on('exit', onExit);
    return () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (process.platform !== 'win32') process.off('SIGHUP', onSignal);
      process.off('exit', onExit);
      if (hardTimer) clearTimeout(hardTimer);
    };
  };

  return {
    interrupt,
    install,
    get interrupted() {
      return interrupts > 0;
    },
  };
}

/**
 * `cao stop` runs in another terminal, so it cannot deliver Ctrl+C to the orchestrator: Windows has no way
 * to send SIGINT to an unrelated process, and every other signal kills it before it can stop its workers and
 * persist the run. Instead the request is a file in the run directory that the running orchestrator polls,
 * which behaves the same on every platform and needs no permissions beyond the ones it already has.
 */
export interface StopRequest {
  requestedAt: string;
  /** Pid of the `cao stop` process, for the log line. */
  pid: number;
  source?: string;
}

const stopFile = (paths: RunPaths, runId: string): string => path.join(paths.runDir(runId), 'stop.json');

export async function requestStop(paths: RunPaths, runId: string, source = 'cao stop'): Promise<void> {
  await writeFileAtomic(stopFile(paths, runId), JSON.stringify({ requestedAt: nowIso(), pid: process.pid, source } satisfies StopRequest, null, 2));
}

export async function readStopRequest(paths: RunPaths, runId: string): Promise<StopRequest | null> {
  return readJsonIfExists<StopRequest>(stopFile(paths, runId)).catch(() => null);
}

export async function clearStopRequest(paths: RunPaths, runId: string): Promise<void> {
  await fs.rm(stopFile(paths, runId), { force: true }).catch(() => undefined);
}

export interface StopWatcherOptions {
  paths: RunPaths;
  runId: string;
  intervalMs?: number;
  onStop: (request: StopRequest) => void;
}

/**
 * Poll for a stop request and hand each one to `onStop`; the request is consumed first, so a second
 * `cao stop` reaches the interrupt controller a second time and forces the kill, exactly like Ctrl+C twice.
 */
export function watchStopRequests(opts: StopWatcherOptions): () => void {
  const file = stopFile(opts.paths, opts.runId);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (await pathExists(file)) {
      const request = (await readStopRequest(opts.paths, opts.runId)) ?? { requestedAt: nowIso(), pid: 0 };
      await clearStopRequest(opts.paths, opts.runId);
      if (!stopped) opts.onStop(request);
    }
    if (!stopped) schedule();
  };
  const schedule = (): void => {
    timer = setTimeout(() => void tick(), opts.intervalMs ?? 500);
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
