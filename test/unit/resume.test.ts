import { describe, it, expect } from 'vitest';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, states, waitFor } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { reconcileForResume } from '../../src/workflow/run-factory.js';
import type { WorkflowRun } from '../../src/types/run.js';

const YAML = 'name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n  - id: c\n    prompt: p\n  - id: d\n    prompt: p\n';

async function workflow() {
  const { workflow } = await buildWorkflow(YAML, { gitRoot: process.cwd() });
  return workflow;
}

function schedule(run: WorkflowRun, runner: MockRunner, store = new MemoryRunStore(), isResume = false) {
  const bus = new WorkflowEventBus(run.runId, run.eventSeq);
  bus.onAny((e) => void store.appendEvent(e));
  const workspace = new MockWorkspace(run.repositoryRoot);
  return { scheduler: new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace, bus, isResume }), store, bus };
}

describe('resume', () => {
  it('A=success, B=success, C=running when the process dies → only C and D re-run', async () => {
    const wf = await workflow();
    const run = makeRun(wf);
    const runner = new MockRunner().when('c', { kind: 'hang' });
    const first = schedule(run, runner);
    const execution = first.scheduler.execute();
    await waitFor(() => runner.running.includes('c#1'));
    // the worker pid is persisted shortly after the process starts
    await waitFor(() => first.store.snapshots[first.store.snapshots.length - 1]?.tasks.c?.attempts[0]?.pid !== undefined);

    // Simulate the orchestrator process dying: take the last persisted snapshot as if reloaded from disk.
    const snapshot = first.store.snapshots[first.store.snapshots.length - 1]!;
    expect(snapshot.tasks.c!.state).toBe('running');
    expect(snapshot.tasks.c!.attempts[0]!.pid).toBeDefined();
    snapshot.tasks.c!.attempts[0]!.pid = 999_999_999; // definitely not alive
    runner.complete('c', 1, { kind: 'error', outcome: 'cancelled', message: 'killed' });
    await execution.catch(() => undefined);

    const reconciled = await reconcileForResume(snapshot);
    expect(reconciled.rerun).toEqual(['c']);
    expect(snapshot.tasks.c!.attempts[0]!.outcome).toBe('interrupted');
    expect(states(snapshot)).toEqual({ a: 'success', b: 'success', c: 'pending', d: 'pending' });
    expect(snapshot.resumeCount).toBe(1);

    const runner2 = new MockRunner();
    const second = schedule(snapshot, runner2, new MemoryRunStore(), true);
    const res = await second.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(runner2.calls.map((c) => `${c.taskId}#${c.attempt}`)).toEqual(['c#2', 'd#1']);
    expect(snapshot.tasks.a!.attempts).toHaveLength(1);
    expect(snapshot.tasks.c!.attempts.map((a) => a.number)).toEqual([1, 2]);
    expect(snapshot.tasks.c!.attempts[1]!.triggeredBy).toBe('resume');
    expect(second.store.eventsOf('workflow.resumed')).toHaveLength(1);
  });

  it('retries failed tasks by default with a fresh retry budget, keeps them with --no-retry-failed', async () => {
    const wf = await workflow();
    const run = makeRun(wf);
    const runner = new MockRunner().when('b', { kind: 'error', outcome: 'crash' });
    const first = schedule(run, runner);
    await first.scheduler.execute();
    expect(states(run)).toEqual({ a: 'success', b: 'failed', c: 'cancelled', d: 'cancelled' });

    const keep = JSON.parse(JSON.stringify(run)) as WorkflowRun;
    await reconcileForResume(keep, { retryFailed: false });
    expect(keep.tasks.b!.state).toBe('failed');
    expect(keep.tasks.c!.state).toBe('pending');

    await reconcileForResume(run);
    expect(states(run)).toEqual({ a: 'success', b: 'pending', c: 'pending', d: 'pending' });
    expect(run.tasks.b!.retryWindowStart).toBe(2);
    const second = schedule(run, new MockRunner(), new MemoryRunStore(), true);
    const res = await second.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(run.tasks.b!.attempts.map((a) => a.number)).toEqual([1, 2]);
  });

  it('approves or rejects paused approval gates', async () => {
    const { workflow: wf } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: gate\n    type: approval\n    prompt: ok?\n  - id: b\n    prompt: p\n', { gitRoot: process.cwd() });
    const run = makeRun(wf);
    const first = schedule(run, new MockRunner());
    expect((await first.scheduler.execute()).state).toBe('paused');
    await reconcileForResume(run, { approve: ['gate'] });
    expect(run.tasks.gate!.state).toBe('pending');
    expect(run.tasks.gate!.approval?.decision).toBe('approved');
    // the scheduler re-encounters the gate; with an approval recorded the handler decides
    const second = schedule(run, new MockRunner(), new MemoryRunStore(), true);
    const bus = second.bus;
    void bus;
    const res = await new WorkflowScheduler({
      run,
      store: second.store,
      runners: new RunnerRegistry().register(new MockRunner()),
      workspace: new MockWorkspace(run.repositoryRoot),
      bus: new WorkflowEventBus(run.runId),
      isResume: true,
      approvalHandler: async (task) => (run.tasks[task.id]?.approval ? { decision: run.tasks[task.id]!.approval!.decision } : 'defer'),
    }).execute();
    expect(res.state).toBe('completed');
    expect(states(run)).toEqual({ a: 'success', gate: 'success', b: 'success' });
  });

  it('feeds user input back into a needs_input task', async () => {
    const wf = await workflow();
    const run = makeRun(wf);
    const runner = new MockRunner().when('b', { kind: 'status', status: 'needs_input', error: 'which?' });
    const first = schedule(run, runner);
    expect((await first.scheduler.execute()).state).toBe('paused');
    await reconcileForResume(run, { input: { taskId: 'b', text: 'Use Postgres' } });
    const runner2 = new MockRunner();
    const res = await schedule(run, runner2, new MemoryRunStore(), true).scheduler.execute();
    expect(res.state).toBe('completed');
    expect(runner2.calls[0]!.prompt).toContain('# User Input\n\nUse Postgres');
    expect(run.tasks.b!.attempts[1]!.triggeredBy).toBe('user_input');
  });

  it('re-runs explicitly selected successful tasks on resume', async () => {
    const wf = await workflow();
    const run = makeRun(wf);
    await schedule(run, new MockRunner()).scheduler.execute();
    await reconcileForResume(run, { selection: { from: ['c'] } });
    expect(states(run)).toEqual({ a: 'success', b: 'success', c: 'pending', d: 'success' });
    const runner = new MockRunner();
    await schedule(run, runner, new MemoryRunStore(), true).scheduler.execute();
    expect(runner.calls.map((c) => c.taskId)).toEqual(['c', 'd']);
  });
});
