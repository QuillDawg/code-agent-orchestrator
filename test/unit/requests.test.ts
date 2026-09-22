/**
 * The request inbox (spec §2.3, `[D3]`, `[D38]`): what the owner reads, what it refuses, and what it writes
 * back.
 *
 * The draining half drives a real `WorkflowScheduler` through the real watcher, because the properties
 * being tested are cross-process ones — a duplicate id answered with the first ack, an ack on disk before
 * the request that asked for it is removed — and a stub controller would agree with any implementation.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, tmpDir, waitFor } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { createRunController, type RunController } from '../../src/workflow/control/controller.js';
import { createNativeRunPaths } from '../../src/persistence/paths.js';
import { clearPendingRequests, createInterruptController, watchStopRequests, type StopRequest } from '../../src/execution/signals.js';
import type { ProcessManager } from '../../src/execution/process-manager.js';
import {
  controlRequest,
  readAck,
  readPendingRequests,
  requestFileName,
  sendControlRequest,
  writeControlRequest,
} from '../../src/persistence/requests.js';
import { pathExists } from '../../src/util/fs.js';
import { silentLogger } from '../../src/logging/logger.js';
import { ESC } from '../../src/util/text.js';
import { PROTOCOL_VERSION, type ControlAck, type RunPaths } from 'code-agent-orchestrator-protocol';

const RUN_ID = '2026-01-01-001';

/** `waitFor` takes a synchronous predicate; these conditions are filesystem reads. */
async function until(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function inbox(): Promise<RunPaths> {
  const paths = createNativeRunPaths(await tmpDir('cao-inbox-'));
  await fs.mkdir(paths.requestsDir(RUN_ID), { recursive: true });
  return paths;
}

/** A request file written by hand, the way another process writes one. */
async function put(paths: RunPaths, name: string, body: unknown): Promise<string> {
  const file = path.join(paths.requestsDir(RUN_ID), name);
  await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return file;
}

function rejectedFile(paths: RunPaths, name: string): string {
  return path.join(paths.requestRejectedDir(RUN_ID), name);
}

describe('reading the inbox', () => {
  it('lists requests in ULID order, whatever order the kinds are in', async () => {
    const paths = await inbox();
    // Written newest first on purpose: the answer must come from the id, not from the write order.
    await put(paths, '01K7Q3N1B4000000000000000C-restart.json', { protocol: 1, id: '01K7Q3N1B4000000000000000C', kind: 'restart', taskId: 'c' });
    await put(paths, '01K7Q3M8XA000000000000000A-stop.json', { protocol: 1, id: '01K7Q3M8XA000000000000000A', kind: 'stop' });
    await put(paths, '01K7Q3N1B2000000000000000B-kill.json', { protocol: 1, id: '01K7Q3N1B2000000000000000B', kind: 'kill' });

    const pending = await readPendingRequests(paths, RUN_ID);
    expect(pending.map((p) => p.request.kind)).toEqual(['stop', 'kill', 'restart']);
  });

  it('skips a sync-conflict copy rather than parsing it', async () => {
    const paths = await inbox();
    const id = '01K7Q3M8XA000000000000000A';
    await put(paths, `${id}-stop.json`, { protocol: 1, id, kind: 'stop' });
    // A synced run directory produces these. The copy carries the same id, so dedup cannot save us from it.
    await put(paths, `${id}-stop-DESKTOP-K2R9.json`, { protocol: 1, id, kind: 'stop' });
    await put(paths, `${id}-stop.sync-conflict-20260917.json`, { protocol: 1, id, kind: 'stop' });

    const pending = await readPendingRequests(paths, RUN_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.file.endsWith(`${id}-stop.json`)).toBe(true);
    // Skipped, not moved: a conflict copy is somebody else's file and is left exactly where it was.
    expect(await pathExists(rejectedFile(paths, `${id}-stop-DESKTOP-K2R9.json`))).toBe(false);
  });

  it('moves a future-protocol request to rejected/ with the reason beside it', async () => {
    const paths = await inbox();
    const name = '01K7Q3M8XA000000000000000A-stop.json';
    await put(paths, name, { protocol: PROTOCOL_VERSION + 1, id: '01K7Q3M8XA000000000000000A', kind: 'stop' });

    expect(await readPendingRequests(paths, RUN_ID)).toEqual([]);
    expect(await pathExists(path.join(paths.requestsDir(RUN_ID), name))).toBe(false);
    expect(await pathExists(rejectedFile(paths, name))).toBe(true);
    const reason = await fs.readFile(`${rejectedFile(paths, name)}.reason.txt`, 'utf8');
    expect(reason).toContain(`written for protocol ${PROTOCOL_VERSION + 1}`);
    expect(reason).toContain(`this cao understands ${PROTOCOL_VERSION}`);
  });

  it('moves an unreadable file and one naming a kind it does not know', async () => {
    const paths = await inbox();
    await put(paths, '01K7Q3M8XA000000000000000A-stop.json', 'not json at all');
    await put(paths, '01K7Q3N1B2000000000000000B-teleport.json', { protocol: 1, id: '01K7Q3N1B2000000000000000B', kind: 'teleport' });
    // An id is also the name of its acknowledgment file, so one that is not a path segment is not an id.
    await put(paths, '01K7Q3N1B4000000000000000C-stop.json', { protocol: 1, id: '../../escape', kind: 'stop' });

    expect(await readPendingRequests(paths, RUN_ID)).toEqual([]);
    expect(await fs.readFile(`${rejectedFile(paths, '01K7Q3M8XA000000000000000A-stop.json')}.reason.txt`, 'utf8')).toContain('not valid JSON');
    expect(await fs.readFile(`${rejectedFile(paths, '01K7Q3N1B2000000000000000B-teleport.json')}.reason.txt`, 'utf8')).toContain('"teleport"');
    expect(await fs.readFile(`${rejectedFile(paths, '01K7Q3N1B4000000000000000C-stop.json')}.reason.txt`, 'utf8')).toContain('no usable id');
  });

  it('names a request file by its id and kind, so readdir is request order', async () => {
    const paths = await inbox();
    const request = controlRequest('restart', { taskId: 'implement-api' });
    const file = await writeControlRequest(paths, RUN_ID, request);
    expect(path.basename(file)).toBe(`${request.id}-restart.json`);
    expect(requestFileName(request)).toBe(`${request.id}-restart.json`);
    expect((await readPendingRequests(paths, RUN_ID))[0]!.request).toMatchObject({ kind: 'restart', taskId: 'implement-api', pid: process.pid });
  });
});

describe('sending a request and waiting for its ack', () => {
  it('returns the ack once the owner writes one', async () => {
    const paths = await inbox();
    const request = controlRequest('stop');
    const answered: ControlAck = { protocol: PROTOCOL_VERSION, id: request.id, status: 'applied', reason: 'Stopping.', at: new Date().toISOString() };
    // The owner is simulated here; the real one is exercised through the watcher below.
    setTimeout(() => {
      void fs.mkdir(paths.requestAcksDir(RUN_ID), { recursive: true }).then(() => fs.writeFile(path.join(paths.requestAcksDir(RUN_ID), `${request.id}.json`), JSON.stringify(answered)));
    }, 30);

    const sent = await sendControlRequest(paths, RUN_ID, request, { wait: 5, pollMs: 10 });
    expect(sent.ack).toMatchObject({ id: request.id, status: 'applied', reason: 'Stopping.' });
  });

  it('comes back with no ack rather than an error when nobody answers', async () => {
    const paths = await inbox();
    const sent = await sendControlRequest(paths, RUN_ID, controlRequest('stop'), { wait: 0 });
    expect(sent.ack).toBeNull();
    // The request is left where it is: an unanswered request is still pending, not withdrawn.
    expect(await pathExists(sent.file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------- the owner draining it

const ONE = `
name: t
tasks:
  - id: a
    prompt: p
`;

interface Drain {
  paths: RunPaths;
  controller: RunController;
  scheduler: WorkflowScheduler;
  runner: MockRunner;
  stops: StopRequest[];
  dispose: () => void;
  execution: Promise<unknown>;
  /** Stop the watcher, then the run, then wait for it: the hanging attempt only ends when it is aborted. */
  finish: () => Promise<void>;
}

async function draining(yaml = ONE): Promise<Drain> {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join('\n'));
  const run = makeRun(workflow, RUN_ID);
  const runner = new MockRunner();
  runner.when('a', { kind: 'hang' });
  const scheduler = new WorkflowScheduler({
    run,
    store: new MemoryRunStore(),
    runners: new RunnerRegistry().register(runner),
    workspace: new MockWorkspace(workflow.repositoryRoot),
    bus: new WorkflowEventBus(run.runId),
  });
  const controller = createRunController({ scheduler });
  const paths = await inbox();
  const stops: StopRequest[] = [];
  const dispose = watchStopRequests({ paths, runId: RUN_ID, intervalMs: 10, controller, onStop: (r) => stops.push(r) });
  const execution = scheduler.execute();
  await waitFor(() => runner.running.length > 0);
  const finish = async (): Promise<void> => {
    dispose();
    await controller.submit({ kind: 'stop', mode: 'cancel' }, { id: `teardown-${RUN_ID}`, source: 'cli', pid: process.pid, at: new Date().toISOString() });
    await execution;
  };
  return { paths, controller, scheduler, runner, stops, dispose, execution, finish };
}

describe('the owner draining the inbox', () => {
  it('refuses approve, reject and answer from disk without ever asking the controller', async () => {
    const d = await draining();
    try {
      for (const kind of ['approve', 'reject', 'answer'] as const) {
        const request = controlRequest(kind, { taskId: 'a' });
        await writeControlRequest(d.paths, RUN_ID, request);
        await until(async () => (await readAck(d.paths, RUN_ID, request.id)) !== null);
        const ack = await readAck(d.paths, RUN_ID, request.id);
        expect(ack!.status).toBe('rejected');
        expect(ack!.reason).toContain('permission controls are not accepted from disk until presence gating ships');
      }
      // Refused before the controller, so the run never even recorded the ids: `[D3]`'s trust boundary is
      // the translation, not a decision the scheduler took.
      expect(d.scheduler.run.controls?.seen ?? []).toEqual([]);
      expect(d.scheduler.run.tasks.a!.state).toBe('running');
    } finally {
      await d.finish();
    }
  }, 20_000);

  it('answers a second file carrying an id it has already seen with the first ack, and applies it once', async () => {
    const d = await draining();
    try {
      // A restart of a task that does not exist: refused, and the refusal is what has to be remembered —
      // a resent id must not be decided a second time against state that has moved on since (§2.2).
      const id = controlRequest('restart').id;
      await writeControlRequest(d.paths, RUN_ID, controlRequest('restart', { id, taskId: 'nope' }));
      await until(async () => (await readAck(d.paths, RUN_ID, id)) !== null);
      const first = await readAck(d.paths, RUN_ID, id);
      expect(first!.status).toBe('rejected');

      // The same id, now asking to stop the whole run. §2.2: the first answer, verbatim, and nothing done.
      const again = path.join(d.paths.requestsDir(RUN_ID), `${id}-stop.json`);
      await fs.writeFile(again, JSON.stringify({ protocol: PROTOCOL_VERSION, id, kind: 'stop', requestedAt: new Date().toISOString(), source: 'someone else', pid: 1 }));
      await until(async () => !(await pathExists(again)));
      expect(await readAck(d.paths, RUN_ID, id)).toEqual(first);
      expect(d.scheduler.run.controls!.seen.filter((a) => a.id === id)).toHaveLength(1);
      expect(d.stops).toEqual([]);
      expect(d.scheduler.run.tasks.a!.state).toBe('running');
    } finally {
      await d.finish();
    }
  }, 20_000);

  it('writes the ack before it deletes the request, so an unwritable ack leaves the request pending', async () => {
    const d = await draining();
    try {
      // `requests/acks` as a *file*: every write into it fails, on Windows and on Linux alike.
      await fs.writeFile(d.paths.requestAcksDir(RUN_ID), 'in the way');
      const request = controlRequest('restart', { taskId: 'a' });
      const file = await writeControlRequest(d.paths, RUN_ID, request);

      // Several ticks go by and the request is still there: deletion never runs without its ack.
      await new Promise((r) => setTimeout(r, 120));
      expect(await pathExists(file)).toBe(true);

      // Clear the way and the very next tick answers it and consumes it.
      await fs.rm(d.paths.requestAcksDir(RUN_ID), { force: true });
      await until(async () => !(await pathExists(file)));
      expect(await readAck(d.paths, RUN_ID, request.id)).toMatchObject({ id: request.id, status: 'rejected' });
    } finally {
      await d.finish();
    }
  }, 20_000);

  it('turns stop.json into a stop request with an id of its own', async () => {
    const d = await draining();
    try {
      const stopFile = path.join(d.paths.runDir(RUN_ID), 'stop.json');
      await fs.writeFile(stopFile, JSON.stringify({ requestedAt: new Date().toISOString(), pid: 4242, source: 'cao stop' }));
      await waitFor(() => d.stops.length === 1);
      // The pid of the process that asked, not this one: it is what the log line names.
      expect(d.stops[0]).toMatchObject({ pid: 4242, source: 'cao stop' });
      // It went through the controller like everything else, so the run remembers answering it.
      const acked = d.scheduler.run.controls!.seen;
      expect(acked).toHaveLength(1);
      expect(acked[0]!.status).toBe('applied');
      expect(await pathExists(path.join(d.paths.requestAcksDir(RUN_ID), `${acked[0]!.id}.json`))).toBe(true);
      // Consumed, so the same stop is not applied again on the next tick.
      expect(await pathExists(stopFile)).toBe(false);
    } finally {
      await d.finish();
    }
  }, 20_000);

  it('escalates a kill request to the force-kill once the run state has been stopped', async () => {
    const d = await draining();
    const killed: string[] = [];
    d.controller.setKillHandler(() => killed.push('kill'));
    try {
      const request = controlRequest('kill');
      await writeControlRequest(d.paths, RUN_ID, request);
      await waitFor(() => killed.length === 1);
      // The ack is on disk *before* the escalation runs, which is why that write is synchronous: the
      // process is about to end and the sender is waiting for this file.
      expect(await readAck(d.paths, RUN_ID, request.id)).toMatchObject({ id: request.id, status: 'applied' });
      expect(await pathExists(path.join(d.paths.requestsDir(RUN_ID), requestFileName(request)))).toBe(false);
    } finally {
      await d.finish();
    }
  }, 20_000);
});

describe('clearing the inbox at both ends of a run', () => {
  it('answers what is left behind rather than dropping it, and says which end it is', async () => {
    const paths = await inbox();
    const stale = controlRequest('stop');
    await writeControlRequest(paths, RUN_ID, stale);

    // Startup: something asked the orchestrator that used to own this run. Applying it now would stop the
    // run that is only just resuming, so it is refused - and the sender is told where to send it instead.
    await clearPendingRequests(paths, RUN_ID);
    const atStartup = await readAck(paths, RUN_ID, stale.id);
    expect(atStartup).toMatchObject({ id: stale.id, status: 'rejected' });
    expect(atStartup!.reason).toContain('no longer running');
    expect(atStartup!.reason).toContain(RUN_ID);
    expect(await pathExists(path.join(paths.requestsDir(RUN_ID), requestFileName(stale)))).toBe(false);

    // Shutdown: the watcher stops on a tick boundary, so a request written in the half second after it has
    // nobody left to apply it. Left alone it would sit there while its sender waited out the whole of
    // `--wait`; answered, the sender learns at once - with the sentence the controller uses for the same
    // thing, because it is the same thing.
    const late = controlRequest('restart', { taskId: 'implement-api' });
    await writeControlRequest(paths, RUN_ID, late);
    await clearPendingRequests(paths, RUN_ID, 'shutdown');
    const atShutdown = await readAck(paths, RUN_ID, late.id);
    expect(atShutdown).toMatchObject({ id: late.id, status: 'rejected' });
    expect(atShutdown!.reason).toBe(`This run has ended, so its execution state cannot be changed. Start it again with "cao resume ${RUN_ID}".`);
    expect(await pathExists(path.join(paths.requestsDir(RUN_ID), requestFileName(late)))).toBe(false);
  });
});

describe('the legacy stop.json escalation', () => {
  /** A controller that records what it was asked and agrees, so the translation can be read on its own. */
  function recorder(): { controller: RunController; kinds: string[] } {
    const kinds: string[] = [];
    const controller = {
      submit: (command: { kind: string }, envelope: { id: string }) => {
        kinds.push(command.kind);
        return Promise.resolve({ protocol: PROTOCOL_VERSION, id: envelope.id, status: 'applied' as const, at: new Date().toISOString() });
      },
      setKillHandler: () => undefined,
    } as unknown as RunController;
    return { controller, kinds };
  }

  it('makes the first stop.json a stop and the second one a kill, as a second cao stop has always done', async () => {
    const paths = await inbox();
    const { controller, kinds } = recorder();
    const stops: StopRequest[] = [];
    const dispose = watchStopRequests({ paths, runId: RUN_ID, intervalMs: 10, controller, onStop: (r) => stops.push(r) });
    try {
      const stopFile = path.join(paths.runDir(RUN_ID), 'stop.json');
      await fs.writeFile(stopFile, JSON.stringify({ requestedAt: new Date().toISOString(), pid: 1, source: 'cao stop' }));
      // On `stops`, not on `kinds`: the watcher calls `onStop` only after the ack has been written, so a
      // wait on the submission alone races the two filesystem writes between them and fails under load.
      await waitFor(() => stops.length === 1);
      expect(kinds).toEqual(['stop']);

      await fs.writeFile(stopFile, JSON.stringify({ requestedAt: new Date().toISOString(), pid: 2, source: 'cao stop again' }));
      await waitFor(() => kinds.length === 2);
      expect(kinds).toEqual(['stop', 'kill']);
      // A kill is not a second stop: the workers are not asked politely a second time.
      expect(stops).toHaveLength(1);
    } finally {
      dispose();
    }
  }, 20_000);

  /**
   * `requestProblem` validates the id and the kind and nothing else, so `pid` and `source` arrive exactly as
   * another process wrote them - and both are put in front of the operator, in the watcher's log line and in
   * the `beginShutdown` warning `onStop` produces. RULES.md: everything new that reaches a terminal goes
   * through `sanitizeText`.
   */
  it('never lets a request put escape sequences on the terminal through pid or source', async () => {
    const paths = await inbox();
    const { controller } = recorder();
    const lines: string[] = [];
    const logger = { ...silentLogger, info: (m: string) => lines.push(m) };
    const stops: StopRequest[] = [];
    const dispose = watchStopRequests({ paths, runId: RUN_ID, intervalMs: 10, controller, logger, onStop: (r) => stops.push(r) });
    try {
      const id = controlRequest('stop').id;
      const esc = ESC + '[2J' + ESC + '[H';
      await put(paths, `${id}-stop.json`, { protocol: PROTOCOL_VERSION, id, kind: 'stop', requestedAt: 12_345, pid: `${esc}999`, source: `wiped${esc}` });
      await waitFor(() => stops.length === 1);

      expect(lines.join(' ')).not.toContain(ESC);
      // A pid that is not a number is shown as the 0 the envelope already coerces it to, not as its text.
      expect(lines[0]).toContain('(pid 0)');
      expect(stops[0]!.source).toBe('wiped');
      expect(stops[0]!.pid).toBe(0);
      // A `requestedAt` that is not even a string falls back to now, exactly as the envelope's does.
      expect(Number.isNaN(Date.parse(stops[0]!.requestedAt))).toBe(false);
    } finally {
      dispose();
    }
  }, 20_000);

  /**
   * A request the command union refuses is answered without the scheduler, so it never reaches
   * `run.controls.seen` - and `deleteRequest` is best effort, so a file that will not go (a Windows lock, a
   * read-only run directory) comes back on the next tick. Nothing in the scheduler stops that one, so the
   * watcher keeps its own record of what it has answered.
   */
  it('answers a refused request once even when its file keeps coming back', async () => {
    const paths = await inbox();
    const { controller, kinds } = recorder();
    const lines: string[] = [];
    const logger = { ...silentLogger, info: (m: string) => lines.push(m) };
    const dispose = watchStopRequests({ paths, runId: RUN_ID, intervalMs: 10, controller, logger, onStop: () => undefined });
    try {
      const request = controlRequest('approve', { taskId: 'a' });
      const name = requestFileName(request);
      await writeControlRequest(paths, RUN_ID, request);
      await until(async () => (await readAck(paths, RUN_ID, request.id)) !== null);
      const first = await readAck(paths, RUN_ID, request.id);
      expect(first!.status).toBe('rejected');
      expect(lines).toHaveLength(1);

      // The file is back, byte for byte, which is what an undeletable one looks like to the next tick.
      for (let i = 0; i < 3; i += 1) {
        await put(paths, name, request);
        await until(async () => !(await pathExists(path.join(paths.requestsDir(RUN_ID), name))));
      }
      expect(lines).toHaveLength(1);
      expect(await readAck(paths, RUN_ID, request.id)).toEqual(first);
      // And it still never reached the controller.
      expect(kinds).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

describe('Ctrl+C: the stop is applied before the workers are torn down (§2.4)', () => {
  /**
   * The ordering, not the timing. `interrupt()` used to submit the stop and kill the workers in the same
   * breath, and whichever won decided how the attempt was written down: applying the stop is what marks an
   * attempt in flight as `cancelled`, so a worker killed first exits non-zero with nothing to explain it
   * and the runner records a `crash`. On Windows the kill spawns `taskkill` and always lost, which is why
   * only Linux ever saw it - and why this case asks the question with a controller that answers when it is
   * told to, rather than with a race.
   */
  it('waits for the stop command to be applied before shutting workers down', async () => {
    let applyStop = (): void => {};
    const applied = new Promise<void>((resolve) => {
      applyStop = resolve;
    });
    const shutdowns: string[] = [];
    const processManager = {
      shutdown: (mode: string) => {
        shutdowns.push(mode);
        return Promise.resolve();
      },
      killAllSync: () => {},
    } as unknown as ProcessManager;
    const submitted: string[] = [];
    const controller = {
      submit: async (command: { kind: string }): Promise<ControlAck> => {
        submitted.push(command.kind);
        await applied;
        return { protocol: PROTOCOL_VERSION, id: 'x', status: 'applied', at: '2026-01-01T00:00:00.000Z' };
      },
      setKillHandler: () => {},
    } as unknown as RunController;

    const interrupt = createInterruptController({ controller, processManager, logger: silentLogger });
    interrupt.interrupt('Ctrl+C');

    // The run has been asked to stop, and nothing has been killed on the strength of it yet.
    expect(submitted).toEqual(['stop']);
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdowns).toEqual([]);
    expect(interrupt.interrupted).toBe(true);

    applyStop();
    await waitFor(() => shutdowns.length > 0, 2_000);
    expect(shutdowns).toEqual(['graceful']);
  });
});
