/**
 * Who owns a run, and what a window that does not own it may do (spec §2.1, §2.3, `[D3]`, `[D37]`).
 *
 * Two halves. The first is the state machine on its own: four states, and the two different ways an owner
 * can be lost. The second is the observer built on it — the poll that folds `live.json` over
 * `workflow.json`, the controls that leave as request files, and the thing that must never happen, which is
 * this process taking the lock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { buildWorkflow, captureCli, makeRun, tmpDir } from '../helpers/index.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { ownershipOf, ownershipBadge, ownershipBanner, ownershipRefusal, readOwnership } from '../../src/cli/ownership.js';
import { advertisedCapabilities, createRunObserver, mergeLive } from '../../src/workflow/control/observer.js';
import { observerActions, observerActionFor, pendingLines, answerElsewhere } from '../../src/tui/workspace/observer.js';
import { controlAck, readPendingRequests, writeAck } from '../../src/persistence/requests.js';
import { pathExists } from '../../src/util/fs.js';
import { nowIso } from '../../src/util/misc.js';
import type { LiveStatus, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { Orchestrator } from '../../src/cli/util.js';

const RUN_ID = '2026-01-01-001';
const YAML = ['name: watch', 'tasks:', '  - id: implement-api', '    prompt: p', '  - id: write-tests', '    prompt: p'].join('\n') + '\n';

async function run(): Promise<WorkflowRun> {
  const built = await buildWorkflow(YAML);
  return makeRun(built.workflow, RUN_ID);
}

/** A run directory with `workflow.json` in it, and nothing else. */
async function runDirectory(): Promise<{ store: FileRunStore; run: WorkflowRun; root: string }> {
  const root = await tmpDir('cao-observe-');
  const store = new FileRunStore(root);
  const value = await run();
  value.repositoryRoot = root;
  await store.saveRun(value);
  return { store, run: value, root };
}

const orchestrator = (over: Partial<Orchestrator> = {}): Orchestrator => ({ pid: 4242, heartbeatAt: nowIso(), source: 'lock', alive: true, ...over });

/**
 * A live process that is not this one, to be the owner in `lock.json`.
 *
 * `owned` is the one state that cannot be faked with a number: it means a pid that is *alive* and is not
 * ours, and `readOrchestrator` checks. A real child costs a few milliseconds and is the only honest way to
 * reach the state every control in this mode is gated on.
 */
const children: ChildProcess[] = [];
function otherProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  children.push(child);
  return child.pid!;
}
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

async function owns(store: FileRunStore, pid: number): Promise<void> {
  await fs.writeFile(store.paths.lockFile(RUN_ID), JSON.stringify({ pid, startedAt: nowIso(), heartbeatAt: nowIso() }));
}

describe('the ownership state machine (§2.1)', () => {
  it('calls the four states what §2.1 calls them', () => {
    expect(ownershipOf(null)).toMatchObject({ kind: 'ended', resumable: true });
    expect(ownershipOf(orchestrator({ pid: process.pid }))).toMatchObject({ kind: 'self', resumable: false });
    expect(ownershipOf(orchestrator())).toMatchObject({ kind: 'owned', pid: 4242, resumable: false });
  });

  it('is abandoned whether the owner died or only stopped beating', () => {
    // `lock.json` under a dead pid, and `live.json` whose heartbeat fell out of the 60 s window: both reach
    // `readOrchestrator` as `alive: false`, and both mean the same thing to a window looking at the run.
    const dead = ownershipOf(orchestrator({ source: 'lock', alive: false }));
    const stale = ownershipOf(orchestrator({ source: 'live', alive: false, heartbeatAt: new Date(Date.now() - 120_000).toISOString() }));
    expect(dead).toMatchObject({ kind: 'abandoned', resumable: true, source: 'lock' });
    expect(stale).toMatchObject({ kind: 'abandoned', resumable: true, source: 'live' });
  });

  it('writes a badge, a banner and a refusal that name the process', () => {
    const owned = ownershipOf(orchestrator());
    expect(ownershipBadge(owned)).toBe('observing · owner pid 4242');
    expect(ownershipBanner(owned, RUN_ID)).toContain('owned by pid 4242');
    expect(ownershipRefusal(owned, RUN_ID)).toContain('pid 4242');

    const gone = ownershipOf(orchestrator({ alive: false }));
    expect(ownershipBadge(gone)).toBe('abandoned · resume?');
    expect(ownershipBanner(gone, RUN_ID)).toContain('is gone');
    expect(ownershipRefusal(gone, RUN_ID)).toContain('cao resume');

    expect(ownershipBadge(ownershipOf(null))).toBe('owner');
    expect(ownershipBanner(ownershipOf(null), RUN_ID)).toBeUndefined();
  });

  it('is the answer cao status gives, so the two cannot disagree about a run (§2.1)', async () => {
    const { store, root } = await runDirectory();
    const ended = await captureCli(() => statusCommand(RUN_ID, { repository: root, json: true }));
    expect((JSON.parse(ended.stdout) as { ownership: string }).ownership).toBe('ended');

    await owns(store, otherProcess());
    const owned = await captureCli(() => statusCommand(RUN_ID, { repository: root, json: true }));
    const parsed = JSON.parse(owned.stdout) as { ownership: string; orchestratorAlive: boolean };
    expect(parsed.ownership).toBe('owned');
    // The line the command has always printed is unchanged: `orchestratorAlive` is the first two states.
    expect(parsed.orchestratorAlive).toBe(true);
  });

  it('re-reads the run directory, so an owner that exits flips the answer', async () => {
    const { store } = await runDirectory();
    expect(await readOwnership(store, RUN_ID)).toMatchObject({ kind: 'ended' });

    // A lock from a pid that is certainly not running: the owner is gone and the run is resumable.
    await fs.writeFile(store.paths.lockFile(RUN_ID), JSON.stringify({ pid: 0x7fffffff, startedAt: nowIso(), heartbeatAt: nowIso() }));
    expect(await readOwnership(store, RUN_ID)).toMatchObject({ kind: 'abandoned', pid: 0x7fffffff });

    // This process, which is alive: `self`, and the workspace keeps its own actions.
    await fs.writeFile(store.paths.lockFile(RUN_ID), JSON.stringify({ pid: process.pid, startedAt: nowIso(), heartbeatAt: nowIso() }));
    expect(await readOwnership(store, RUN_ID)).toMatchObject({ kind: 'self' });

    await fs.rm(store.paths.lockFile(RUN_ID));
    expect(await readOwnership(store, RUN_ID)).toMatchObject({ kind: 'ended' });
  });
});

describe('the live overlay (§2.1)', () => {
  it('folds live.json over workflow.json while an orchestrator is alive', async () => {
    const value = await run();
    value.tasks['implement-api']!.currentAttempt = 1;
    value.tasks['implement-api']!.attempts = [{ number: 1, kind: 'task', startedAt: nowIso(), cwd: '.', usage: {} } as never];
    const live: LiveStatus = {
      runId: RUN_ID,
      orchestratorPid: 4242,
      heartbeatAt: nowIso(),
      state: 'running',
      tasks: { 'implement-api': { state: 'running', attempt: 1, lastActivity: 'editing src/api.ts', usage: { costUsd: 0.25 } } as never },
    };
    const merged = mergeLive(value, live, true);
    expect(merged.state).toBe('running');
    expect(merged.tasks['implement-api']!.state).toBe('running');
    expect(merged.tasks['implement-api']!.lastActivity).toBe('editing src/api.ts');
    expect(merged.tasks['implement-api']!.attempts[0]!.usage).toMatchObject({ costUsd: 0.25 });
    // Untouched: the overlay only knows about the tasks it lists.
    expect(merged.tasks['write-tests']).toBe(value.tasks['write-tests']);
  });

  it('ignores a live.json left behind by a process that died', async () => {
    const value = await run();
    const live: LiveStatus = { runId: RUN_ID, orchestratorPid: 1, heartbeatAt: nowIso(), state: 'running', tasks: { 'implement-api': { state: 'running' } as never } };
    expect(mergeLive(value, live, false)).toBe(value);
  });

  it('drops a pending interaction the newer file no longer has', async () => {
    const value = await run();
    value.tasks['implement-api']!.pendingInteraction = { id: 'i1', kind: 'question', title: 'which database?', askedAt: nowIso() } as never;
    const live: LiveStatus = { runId: RUN_ID, orchestratorPid: 4242, heartbeatAt: nowIso(), state: 'running', tasks: { 'implement-api': { state: 'running' } as never } };
    expect(mergeLive(value, live, true).tasks['implement-api']!.pendingInteraction).toBeUndefined();
  });
});

describe('the observer (§2.1, §2.3, [D37])', () => {
  it('polls the run directory and never takes the lock', async () => {
    const { store, run: value } = await runDirectory();
    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: ['stop', 'kill', 'restart'] });
    const seen: string[] = [];
    observer.onChange((view) => seen.push(view.ownership.kind));

    await observer.tick();
    expect(seen).toEqual(['ended']);
    expect(observer.run.tasks['implement-api']!.state).toBe('pending');

    // Another process takes the run and moves a task on; the next tick shows both.
    const owner = otherProcess();
    await owns(store, owner);
    const moved = await store.loadRun(RUN_ID);
    moved.tasks['implement-api']!.state = 'running';
    moved.state = 'running';
    await store.saveRun(moved);
    await observer.tick();
    expect(observer.run.tasks['implement-api']!.state).toBe('running');
    expect(seen).toEqual(['ended', 'owned']);
    expect(observer.ownership.pid).toBe(owner);

    // And when that process goes, the very next tick says the run is abandoned and resumable (§2.1).
    children.splice(0).forEach((c) => c.kill());
    await new Promise((r) => setTimeout(r, 200));
    await observer.tick();
    expect(observer.ownership).toMatchObject({ kind: 'abandoned', resumable: true });

    observer.stop();
    // The constraint the whole mode rests on: nothing here wrote a lock, and the one that is there is the
    // one the test put there.
    const lock = JSON.parse(await fs.readFile(store.paths.lockFile(RUN_ID), 'utf8')) as { pid: number };
    expect(lock.pid).toBe(owner);
  });

  it('keeps the last good run when workflow.json is caught mid-write', async () => {
    const { store, run: value } = await runDirectory();
    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: [] });
    await observer.tick();
    await fs.writeFile(store.paths.workflowFile(RUN_ID), '{"runId": "2026-01-0');
    await observer.tick();
    expect(observer.run.runId).toBe(RUN_ID);
    expect(observer.run.workflow.tasks).toHaveLength(2);
    observer.stop();
  });

  it('sends a control as a request file and reports the ack', async () => {
    const { store, run: value } = await runDirectory();
    await owns(store, otherProcess());
    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: ['stop', 'restart'], ackWaitSeconds: 5 });
    await observer.tick();

    // The owner, played by hand: read the request the workspace wrote, answer it, and let the send resolve.
    const sending = observer.surface.send({ kind: 'stop' });
    let request: string | undefined;
    for (let i = 0; i < 200 && !request; i += 1) {
      const pending = await readPendingRequests(store.paths, RUN_ID);
      request = pending[0]?.request.id;
      if (request) await writeAck(store.paths, RUN_ID, controlAck(request, 'applied'));
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(await sending).toEqual({ status: 'applied' });
    observer.stop();
  });

  it('says nobody answered rather than calling an unanswered request a refusal', async () => {
    const { store, run: value } = await runDirectory();
    await owns(store, otherProcess());
    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: ['stop'], ackWaitSeconds: 0 });
    await observer.tick();
    const outcome = await observer.surface.send({ kind: 'stop' });
    expect(outcome.status).toBe('timeout');
    expect(outcome.reason).toContain('still in requests/');
    // And the request is still there for the owner to read, exactly as the sentence says.
    expect((await readPendingRequests(store.paths, RUN_ID)).map((p) => p.request.kind)).toEqual(['stop']);
    observer.stop();
  });

  it('refuses to send a kind the run does not advertise, and one there is no owner for', async () => {
    const { store, run: value } = await runDirectory();
    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: ['stop'] });
    await observer.tick();
    expect(await observer.surface.send({ kind: 'kill' })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('does not advertise kill') as unknown as string });
    // `stop` is advertised, but nothing owns the run, so there is nobody to send it to.
    expect(await observer.surface.send({ kind: 'stop' })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('cao resume') as unknown as string });
    expect(await pathExists(path.join(store.paths.requestsDir(RUN_ID)))).toBe(false);
    observer.stop();
  });

  it('refuses every controller command, because none of them belong to this process', async () => {
    const { store, run: value } = await runDirectory();
    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: ['stop'] });
    await observer.tick();
    const ack = await observer.controller.submit({ kind: 'stop', mode: 'cancel' }, { id: 'x', source: 'tui', pid: 1, at: nowIso() });
    expect(ack.status).toBe('rejected');
    expect(observer.controller.canInteract).toBe(false);
    observer.stop();
  });

  it('follows an attempt transcript as the owner appends to it', async () => {
    const { store, run: value } = await runDirectory();
    value.tasks['implement-api']!.attempts = [{ number: 1, kind: 'task', startedAt: nowIso(), cwd: '.', usage: {} } as never];
    await store.saveRun(value);
    const dir = store.paths.attemptDir(RUN_ID, 'implement-api', 1);
    await fs.mkdir(dir, { recursive: true });
    const events = path.join(dir, 'events.jsonl');
    await fs.writeFile(events, `${JSON.stringify({ kind: 'assistant', ts: nowIso(), text: 'first' })}\n`);

    const observer = createRunObserver({ store, runId: RUN_ID, run: value, capabilities: [] });
    await observer.tick();
    observer.controller.peek('implement-api'); // starts the follow
    for (let i = 0; i < 200 && observer.controller.peek('implement-api').length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(observer.controller.peek('implement-api')).toHaveLength(1);

    await fs.appendFile(events, `${JSON.stringify({ kind: 'assistant', ts: nowIso(), text: 'second' })}\n`);
    for (let i = 0; i < 300 && observer.controller.peek('implement-api').length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(observer.controller.peek('implement-api').map((e) => (e as { text: string }).text)).toEqual(['first', 'second']);
    observer.stop();
  });
});

describe('what a run advertises decides what is offered (§2.3)', () => {
  it('falls back to what an owner of this build acts on when there is no entry', async () => {
    const value = await run();
    // No `CAO_HOME` fixture and no entry for this run: the fallback is the inbox kinds, not silence.
    expect(await advertisedCapabilities(value, RUN_ID)).toEqual(['stop', 'kill', 'restart', 'edit', 'prompt', 'pause']);
  });

  it('hides a control the run never claimed, and invents none from an unknown token', async () => {
    const value = await run();
    value.state = 'running';
    value.tasks['implement-api']!.state = 'failed';
    const selected = value.workflow.tasks[0]!;
    expect(observerActions(value, selected, ['stop', 'kill', 'restart']).map((a) => a.kind)).toEqual(['stop', 'kill', 'restart']);
    expect(observerActions(value, selected, ['stop']).map((a) => a.kind)).toEqual(['stop']);
    expect(observerActions(value, selected, ['prompt' as never, 'edit' as never])).toEqual([]);
  });

  it('offers a re-run only for a task the owner could actually restart', async () => {
    const value = await run();
    value.state = 'running';
    value.tasks['implement-api']!.state = 'running';
    const selected = value.workflow.tasks[0]!;
    expect(observerActions(value, selected, ['restart'])).toEqual([]);
    value.tasks['implement-api']!.state = 'cancelled';
    expect(observerActionFor(observerActions(value, selected, ['restart']), 'r')).toMatchObject({ kind: 'restart', taskId: 'implement-api' });
  });

  it('names the terminal an approval or a question has to be answered in', async () => {
    const value = await run();
    value.tasks['implement-api']!.pendingInteraction = { id: 'i1', kind: 'question', title: 'which database?', askedAt: nowIso() } as never;
    value.tasks['write-tests']!.state = 'awaiting_approval';
    expect(pendingLines(value)).toEqual([
      { taskId: 'implement-api', what: 'question: which database?' },
      { taskId: 'write-tests', what: 'approval' },
    ]);
    expect(answerElsewhere(4242)).toBe('answer in the owning terminal (pid 4242)');
  });
});
