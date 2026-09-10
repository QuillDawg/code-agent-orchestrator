import { describe, it, expect } from 'vitest';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, states, waitFor } from '../helpers/index.js';
import { attemptReason } from '../../src/tui/history.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { reconcileForResume } from '../../src/workflow/run-factory.js';
import type { WorkflowRun } from 'code-agent-orchestrator-protocol';

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

  it('answers a needs_input task by continuing the session that asked', async () => {
    const wf = await workflow();
    const run = makeRun(wf);
    const runner = new MockRunner().when('b', { kind: 'status', status: 'needs_input', error: 'Which database should I use?' });
    const first = schedule(run, runner);
    expect((await first.scheduler.execute()).state).toBe('paused');
    const sessionId = run.tasks.b!.attempts[0]!.sessionId;
    expect(sessionId).toBeDefined();

    await reconcileForResume(run, { input: { taskId: 'b', text: 'Use Postgres' } });
    const runner2 = new MockRunner();
    const res = await schedule(run, runner2, new MemoryRunStore(), true).scheduler.execute();
    expect(res.state).toBe('completed');
    // The worker is not made to do the whole task again: its own session is continued with the answer, and
    // the answer arrives next to the question it answers.
    const call = runner2.calls.find((c) => c.taskId === 'b')!;
    expect(call.resumeSessionId).toBe(sessionId);
    expect(call.prompt).toContain('# Your Question Was Answered');
    expect(call.prompt).toContain('> Which database should I use?');
    expect(call.prompt).toContain('Use Postgres');
    expect(call.prompt).not.toContain('# Task');
    const attempt = run.tasks.b!.attempts[1]!;
    expect(attempt.triggeredBy).toBe('user_input');
    expect(attempt.resumedSessionId).toBe(sessionId);
    expect(attemptReason(run.tasks.b!.attempts, 1)).toContain('continued with your answer');
  });

  it('restarts a task whose session cannot be resumed, and still tells it what it is answering', async () => {
    const { workflow: wf } = await buildWorkflow(
      'name: t\ntasks:\n  - id: b\n    prompt: p\n    retry:\n      resumeSession: false\n',
      { gitRoot: process.cwd() },
    );
    const run = makeRun(wf);
    const runner = new MockRunner().when('b', { kind: 'status', status: 'needs_input', error: 'Which database should I use?' });
    expect((await schedule(run, runner).scheduler.execute()).state).toBe('paused');
    await reconcileForResume(run, { input: { taskId: 'b', text: 'Use Postgres' } });
    const runner2 = new MockRunner();
    expect((await schedule(run, runner2, new MemoryRunStore(), true).scheduler.execute()).state).toBe('completed');
    const call = runner2.calls[0]!;
    expect(call.resumeSessionId).toBeUndefined();
    // A fresh session redoes the task, so it has to be told what the answer is an answer to.
    expect(call.prompt).toContain('# User Input');
    expect(call.prompt).toContain('> Which database should I use?');
    expect(call.prompt).toContain('Use Postgres');
    expect(call.prompt).toContain('# Task');
    expect(attemptReason(run.tasks.b!.attempts, 1)).toContain('restarted with your answer');
  });

  it('leaves the other paused tasks holding their questions instead of restarting them unanswered', async () => {
    // Both have to be in flight when the first one pauses the run, so they run side by side.
    const { workflow: wf } = await buildWorkflow(
      'name: t\nexecution:\n  mode: dag\n  maxConcurrency: 2\ntasks:\n  - id: b\n    prompt: p\n  - id: c\n    prompt: p\n',
      { gitRoot: process.cwd() },
    );
    const run = makeRun(wf);
    const runner = new MockRunner()
      .when('b', { kind: 'status', status: 'needs_input', error: 'Which database?' })
      .when('c', { kind: 'status', status: 'needs_input', error: 'Which region?' });
    expect((await schedule(run, runner).scheduler.execute()).state).toBe('paused');

    const reconciled = await reconcileForResume(run, { input: { taskId: 'b', text: 'Use Postgres' } });
    expect(run.tasks.c!.state).toBe('needs_input');
    expect(reconciled.notes.join(' ')).toContain('--task c --input');
    const runner2 = new MockRunner();
    const res = await schedule(run, runner2, new MemoryRunStore(), true).scheduler.execute();
    // Only the answered task ran again; the run is still paused on the one nobody has answered.
    expect(res.state).toBe('paused');
    expect(runner2.calls.map((call) => call.taskId)).toEqual(['b']);
    expect(run.tasks.c!.attempts).toHaveLength(1);

    // Naming the task without an answer is how an operator asks for it to be started over regardless.
    await reconcileForResume(run, { selection: { only: ['c'] } });
    expect(run.tasks.c!.state).toBe('pending');
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

  it('calls only the attempt that carries the answer a user-input attempt', async () => {
    // Answered, then the answering attempt crashes and is retried: the retry is a retry, not a second answer.
    const { workflow: wf } = await buildWorkflow('name: t\ntasks:\n  - id: b\n    prompt: p\n    retries: 2\n', { gitRoot: process.cwd() });
    const run = makeRun(wf);
    const runner = new MockRunner().when('b', { kind: 'status', status: 'needs_input', error: 'Which database?' });
    expect((await schedule(run, runner).scheduler.execute()).state).toBe('paused');
    await reconcileForResume(run, { input: { taskId: 'b', text: 'Use Postgres' } });
    // MockRunner indexes its behaviours by attempt number, and this run starts at attempt 2.
    const runner2 = new MockRunner().when('b', [{ kind: 'success' }, { kind: 'error', outcome: 'crash' }, { kind: 'success' }]);
    expect((await schedule(run, runner2, new MemoryRunStore(), true).scheduler.execute()).state).toBe('completed');
    expect(run.tasks.b!.attempts.map((a) => a.triggeredBy)).toEqual(['initial', 'user_input', 'retry']);
    // The answer is still in front of the retried worker; only the label changed.
    expect(runner2.calls[1]!.prompt).toContain('Use Postgres');
  });

  it('does not treat a task waiting for a human as a failed dependency', async () => {
    // needs_input is not a failure, so onFailure must not fire and dependents must wait rather than be
    // skipped - including one that opted into running when its dependency fails.
    const { workflow: wf } = await buildWorkflow(
      [
        'name: t',
        'tasks:',
        '  - id: a',
        '    prompt: p',
        '    onFailure: skip_dependents',
        '  - id: b',
        '    prompt: p',
        '    dependsOn: [a]',
        '  - id: c',
        '    prompt: p',
        '    dependsOn: [a]',
        '    runIfDependencyFailed: true',
        '',
      ].join('\n'),
      { gitRoot: process.cwd() },
    );
    const run = makeRun(wf);
    const runner = new MockRunner().when('a', { kind: 'status', status: 'needs_input', error: 'Which database?' });
    expect((await schedule(run, runner).scheduler.execute()).state).toBe('paused');
    expect(states(run)).toEqual({ a: 'needs_input', b: 'pending', c: 'pending' });

    await reconcileForResume(run, { input: { taskId: 'a', text: 'Use Postgres' } });
    const runner2 = new MockRunner();
    expect((await schedule(run, runner2, new MemoryRunStore(), true).scheduler.execute()).state).toBe('completed');
    expect(states(run)).toEqual({ a: 'success', b: 'success', c: 'success' });
  });
});
