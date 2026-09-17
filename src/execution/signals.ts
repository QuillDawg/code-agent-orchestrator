/** Ctrl+C / SIGTERM handling: stop scheduling, terminate workers, persist state, exit 130. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunController } from '../workflow/control/controller.js';
import { commandForRequest, controlEnvelope, envelopeForRequest } from '../workflow/control/commands.js';
import type { ProcessManager } from './process-manager.js';
import type { Logger } from '../logging/logger.js';
import type { CapabilityToken, ControlRequest, RunPaths } from 'code-agent-orchestrator-protocol';
import {
  controlAck,
  controlRequest,
  deleteRequest,
  deleteRequestSync,
  readPendingRequests,
  writeAck,
  writeAckSync,
} from '../persistence/requests.js';
import { pathExists, readJsonIfExists, writeFileAtomic } from '../util/fs.js';
import { nowIso } from '../util/misc.js';
import { sanitizeText } from '../util/text.js';

export interface InterruptControllerOptions {
  /**
   * The run controller, not the scheduler: a signal is one more caller asking the run to stop, and it goes
   * through the same door as a keystroke or an inbox request (spec §2.2).
   */
  controller: RunController;
  processManager: ProcessManager;
  logger: Logger;
  hardDeadlineMs?: number;
  /** Called on the first interrupt so a UI can show a notice. */
  onInterrupt?: () => void;
}

export interface InterruptController {
  /** Request a graceful stop (first call) or force-kill everything (second call). */
  interrupt(source?: string): void;
  /**
   * Everything a stop still has to do once the run's *state* has already been stopped: shut the workers
   * down gracefully and arm the hard deadline. A second call force-kills, exactly as a second Ctrl+C does.
   *
   * `interrupt()` is this plus the stop command. A stop that arrived through the inbox (§2.3) has already
   * been through the controller, so it calls this instead and the run is not asked to stop twice.
   */
  beginShutdown(source?: string): void;
  /**
   * What the second interrupt does, by name: kill every worker, persist what can be persisted, exit 130.
   * A `kill` control command escalates to this once the run's state has been stopped (§2.3); it is never
   * inferred from two clicks.
   */
  forceKill(): void;
  /** Install process signal handlers; returns a disposer. */
  install(): () => void;
  readonly interrupted: boolean;
}

export function createInterruptController(opts: InterruptControllerOptions): InterruptController {
  const { controller, processManager, logger } = opts;
  let interrupts = 0;
  let hardTimer: NodeJS.Timeout | undefined;

  const forceExit = (): void => {
    processManager.killAllSync();
    try {
      controller.persistInterruptedSync();
    } catch {
      /* ignore */
    }
    process.exit(130);
  };

  const beginShutdown = (source = 'signal'): void => {
    interrupts += 1;
    if (interrupts === 1) {
      logger.warn(`${source}: stopping workers (interrupt again to force)`);
      opts.onInterrupt?.();
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

  const interrupt = (source = 'signal'): void => {
    // Only the first one asks the run to stop; the second is the escalation and has nothing to tell it.
    if (interrupts === 0) void controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli')).catch(() => undefined);
    beginShutdown(source);
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
    beginShutdown,
    forceKill: forceExit,
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

/**
 * Answer and remove whatever was left in the inbox before this orchestrator took the run.
 *
 * The sibling of `clearStopRequest`, and for the same reason: a request nobody got to apply must not be
 * applied by the run that resumes afterwards, which would stop or kill it the moment it started. They are
 * **answered** rather than dropped, so a `cao stop` still waiting on an ack in another terminal learns that
 * the process it was talking to is gone instead of timing out.
 */
export async function clearPendingRequests(paths: RunPaths, runId: string): Promise<void> {
  for (const pending of await readPendingRequests(paths, runId)) {
    const ack = controlAck(
      pending.request.id,
      'rejected',
      `The orchestrator this was sent to is no longer running, so it was never applied. Send it again to the process that owns run ${runId} now.`,
    );
    await writeAck(paths, runId, ack).catch(() => undefined);
    await deleteRequest(pending.file);
  }
}

/**
 * What the inbox watcher really acts on, and therefore what a run may advertise (§2.3). `edit` and `prompt`
 * are accepted from disk and answered, but the controller does not apply them yet, so they are not here:
 * §4.2.3's rule is that a run advertises what it actually does, not what it can parse.
 */
export const INBOX_REQUEST_KINDS: readonly CapabilityToken[] = ['stop', 'kill', 'restart'];

export interface StopWatcherOptions {
  paths: RunPaths;
  runId: string;
  intervalMs?: number;
  /**
   * Called once a stop has been applied to run state and the workers still have to be shut down — the
   * `interrupt.beginShutdown` half of a Ctrl+C. It is **not** where the run is asked to stop: with a
   * `controller` the controller has already been asked, and without one this is the whole of it.
   */
  onStop: (request: StopRequest) => void;
  /**
   * When given, the same tick drains `requests/` into this controller (§2.3) and `stop.json` becomes a
   * `stop` request with a synthetic id rather than a callback of its own. Without it only `stop.json` is
   * watched, exactly as before the inbox existed.
   */
  controller?: RunController;
  logger?: Logger;
}

/**
 * The owner's 500 ms tick: drain the request inbox (§2.3), then consume `stop.json`.
 *
 * One timer, because there was already one and a second would be a second cadence to reason about. The
 * inbox goes first so that a request already waiting is answered before a legacy stop turns into a kill.
 *
 * `stop.json` keeps working untouched from the outside: an older `cao stop` in another terminal writes it
 * and this turns it into a `stop` command with an id of its own, so it is deduplicated, acknowledged and
 * applied inside the scheduler loop like every other control. A second one while a stop is already pending
 * becomes `kill`, which is what a second `cao stop` has always done.
 */
export function watchStopRequests(opts: StopWatcherOptions): () => void {
  const { paths, runId, controller, logger } = opts;
  const file = stopFile(paths, runId);
  let stopped = false;
  let stopSeen = false;
  let timer: NodeJS.Timeout | undefined;

  /**
   * One request, answered whatever the outcome (§2.3). The ack is on disk before the request file is
   * removed, so a crash in between leaves a request that is asked again rather than one nobody answered.
   */
  const apply = async (request: ControlRequest, requestFile?: string): Promise<void> => {
    const translation = commandForRequest(request);
    const ack = translation.ok
      ? await controller!.submit(translation.command, envelopeForRequest(request))
      : controlAck(request.id, 'rejected', translation.reason);
    const isKill = translation.ok && translation.command.kind === 'kill';
    if (isKill) {
      // The kill escalation runs from a timer scheduled the instant the ack resolves, and awaiting a write
      // yields to it. Answer and consume the request before control leaves this function.
      writeAckSync(paths, runId, ack);
      if (requestFile) deleteRequestSync(requestFile);
    } else {
      await writeAck(paths, runId, ack);
      if (requestFile) await deleteRequest(requestFile);
    }
    // `source` is free text written by another process, so it is display data like any other.
    logger?.info(`inbox: ${request.kind} from ${sanitizeText(request.source ?? 'unknown')} (pid ${request.pid}) ${ack.status}${ack.reason ? `: ${sanitizeText(ack.reason)}` : ''}`);
    if (translation.ok && translation.command.kind === 'stop' && ack.status === 'applied') {
      stopSeen = true;
      opts.onStop({ requestedAt: request.requestedAt, pid: request.pid, source: request.source });
    }
  };

  const drain = async (): Promise<void> => {
    if (controller) {
      for (const pending of await readPendingRequests(paths, runId)) {
        if (stopped) break;
        await apply(pending.request, pending.file);
      }
    }
    if (stopped || !(await pathExists(file))) return;
    const request = (await readStopRequest(paths, runId)) ?? { requestedAt: nowIso(), pid: 0 };
    await clearStopRequest(paths, runId);
    if (stopped) return;
    if (!controller) opts.onStop(request);
    else await apply(controlRequest(stopSeen ? 'kill' : 'stop', { source: request.source ?? 'cao stop', pid: request.pid }));
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await drain();
    } catch (err) {
      // A run directory that cannot be written is not a reason to stop watching it: the request was not
      // acked, so it is still there and the next tick asks again. Saying so once a tick is noise, so this
      // is a debug line; the operator's symptom is a `cao stop` that never gets its answer.
      logger?.debug(`inbox: could not drain requests: ${(err as Error).message}`);
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
