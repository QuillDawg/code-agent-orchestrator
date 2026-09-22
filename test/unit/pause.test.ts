/**
 * Holding a run, and suspending one task (spec §3.2, §3.5).
 *
 * The two are different instructions to the same loop and have to be tested as such. A **hold** stops the
 * scheduler *starting* things and must leave everything already running alone — and, critically, must not
 * let the loop break, because breaking is what writes the report and releases the lock. A **suspend** ends
 * one attempt keeping its session, and the task it leaves behind must stay non-terminal: `cancelled` is
 * terminal, so a task suspended as cancelled would block every dependent on the next pass and make the run
 * report `failed` at the end.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, waitFor } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { createRunController, type RunController } from '../../src/workflow/control/controller.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';
import type { ResolvedWorkflow } from 'code-agent-orchestrator-protocol';

async function wf(yaml: string): Promise<ResolvedWorkflow> {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join('\n'));
  return workflow;
}

function harness(workflow: ResolvedWorkflow, runner: MockRunner) {
  const run = makeRun(workflow);
  const store = new MemoryRunStore();
  const workspace = new MockWorkspace(workflow.repositoryRoot);
  const bus = new WorkflowEventBus(run.runId);
  bus.onAny((e) => void store.appendEvent(e));
  const scheduler = new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace, bus });
  const controller: RunController = createRunController({ scheduler });
  return { scheduler, controller, store, runner, run };
}

const env = () => controlEnvelope('tui');

/** Two run at once; two more are waiting behind them for a slot. */
const FOUR = `
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    parallelGroup: g
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
  - id: c
    parallelGroup: g
    prompt: p
  - id: d
    parallelGroup: g
    prompt: p
`;

/** One task, and a second that depends on it: the shape that proves a suspend does not block dependents. */
const CHAIN = `
name: t
tasks:
  - id: first
    prompt: p
  - id: second
    dependsOn: [first]
    prompt: p
`;

describe('pausing the run (§3.2)', () => {
  it('lets what is running finish, starts nothing new, and does not end the run', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' }).when('c', { kind: 'hang' }).when('d', { kind: 'hang' });
    const h = harness(await wf(FOUR), runner);
    let ended = false;
    const execution = h.scheduler.execute().then((r) => {
      ended = true;
      return r;
    });
    await waitFor(() => runner.calls.length === 2);

    const ack = await h.controller.submit({ kind: 'pause' }, env());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('Nothing new will start');
    expect(h.run.state).toBe('paused');

    // The two in flight finish their turn. Nothing takes the slots they free.
    runner.complete('a', 1, { kind: 'result', result: { status: 'success', summary: 'done a', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    runner.complete('b', 1, { kind: 'result', result: { status: 'success', summary: 'done b', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    await waitFor(() => h.run.tasks.a!.state === 'success' && h.run.tasks.b!.state === 'success');
    await new Promise((r) => setTimeout(r, 60));
    expect(runner.calls.map((c) => c.taskId).sort()).toEqual(['a', 'b']);
    // The whole point: idle, and still going.
    expect(ended).toBe(false);
    expect(h.run.endedAt).toBeUndefined();

    await h.controller.submit({ kind: 'resume' }, env());
    await waitFor(() => runner.calls.length === 4);
    runner.complete('c', 1, { kind: 'result', result: { status: 'success', summary: 'done c', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    runner.complete('d', 1, { kind: 'result', result: { status: 'success', summary: 'done d', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(h.run.state).toBe('completed');
  });

  it('is released by a stop, so a held run can still be stopped', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' }).when('c', { kind: 'hang' }).when('d', { kind: 'hang' });
    const h = harness(await wf(FOUR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 2);
    await h.controller.submit({ kind: 'pause' }, env());
    runner.complete('a', 1, { kind: 'result', result: { status: 'success', summary: 'done a', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    runner.complete('b', 1, { kind: 'result', result: { status: 'success', summary: 'done b', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    await waitFor(() => h.run.tasks.b!.state === 'success');

    // Nothing is in flight and the loop is parked. A stop has to reach it anyway.
    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, env());
    const result = await execution;
    expect(h.run.endedAt).toBeDefined();
    expect(result.exitCode).not.toBe(0);
  });

  it('refuses a second pause, and a resume when nothing is held', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' }).when('c', { kind: 'hang' }).when('d', { kind: 'hang' });
    const h = harness(await wf(FOUR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 2);

    expect((await h.controller.submit({ kind: 'resume' }, env())).status).toBe('rejected');
    expect((await h.controller.submit({ kind: 'pause' }, env())).status).toBe('applied');
    const again = await h.controller.submit({ kind: 'pause' }, env());
    expect(again.status).toBe('rejected');
    expect(again.reason).toContain('already paused');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, env());
    await execution;
  });

  it('finalizes normally when a pause has nothing left to hold open', async () => {
    // A hold on a run with no unfinished task releases itself rather than parking on a finished run.
    const runner = new MockRunner().when('first', { kind: 'hang' }).when('second', { kind: 'success' });
    const h = harness(await wf(CHAIN), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);
    await h.controller.submit({ kind: 'pause' }, env());
    runner.complete('first', 1, { kind: 'result', result: { status: 'success', summary: 'done first', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    // `second` never starts, because the run is held; releasing lets it through and the run ends.
    await waitFor(() => h.run.tasks.first!.state === 'success');
    await h.controller.submit({ kind: 'resume' }, env());
    const result = await execution;
    expect(result.exitCode).toBe(0);
  });
});

describe('suspending one task (§3.5)', () => {
  it('keeps the session, leaves the task non-terminal, and does not block its dependents', async () => {
    const runner = new MockRunner().when('first', { kind: 'hang' });
    const h = harness(await wf(CHAIN), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);

    const ack = await h.controller.submit({ kind: 'suspendTask', taskId: 'first' }, env());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('session is kept');
    await waitFor(() => h.run.tasks.first!.state === 'suspended');

    const state = h.run.tasks.first!;
    expect(state.resumeSessionId).toBe('s-1');
    expect(state.attempts[state.attempts.length - 1]!.outcome).toBe('suspended');
    // Not terminal: had this been `cancelled`, the dependent would already be `blocked` and the run would
    // be on its way to reporting `failed`.
    expect(h.run.tasks.second!.state).toBe('pending');
    expect(h.run.endedAt).toBeUndefined();

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, env());
    await execution;
  });

  it('continues from the session it kept, rather than starting over', async () => {
    const runner = new MockRunner().when('first', [{ kind: 'hang' }, { kind: 'success' }]).when('second', { kind: 'success' });
    const h = harness(await wf(CHAIN), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);
    await h.controller.submit({ kind: 'suspendTask', taskId: 'first' }, env());
    await waitFor(() => h.run.tasks.first!.state === 'suspended');

    const ack = await h.controller.submit({ kind: 'resumeTask', taskId: 'first' }, env());
    expect(ack.status).toBe('applied');
    const result = await execution;
    expect(result.exitCode).toBe(0);
    // The second attempt of `first`, not the second call overall: `second` runs as soon as `first` lands.
    const attempts = runner.calls.filter((c) => c.taskId === 'first');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.resumeSessionId).toBe('s-1');
  });

  it('starts over on a plain restart, because restart has never meant continue', async () => {
    const runner = new MockRunner().when('first', [{ kind: 'hang' }, { kind: 'success' }]).when('second', { kind: 'success' });
    const h = harness(await wf(CHAIN), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);
    await h.controller.submit({ kind: 'suspendTask', taskId: 'first' }, env());
    await waitFor(() => h.run.tasks.first!.state === 'suspended');

    await h.controller.submit({ kind: 'restart', taskId: 'first' }, env());
    await execution;
    const attempts = runner.calls.filter((c) => c.taskId === 'first');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.resumeSessionId).toBeUndefined();
  });

  it('refuses rather than quietly cancelling when no session was reported', async () => {
    // `[D25]`: the difference between suspend and cancel is the session, so a suspend that cannot keep one
    // is refused. Downgrading it silently would throw away the turn the operator was trying to protect.
    const runner = new MockRunner().when('first', { kind: 'hang' });
    const h = harness(await wf(`
name: t
tasks:
  - id: first
    retry:
      resumeSession: false
    prompt: p
`), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);

    const ack = await h.controller.submit({ kind: 'suspendTask', taskId: 'first' }, env());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('cao task stop first');
    expect(h.run.tasks.first!.state).toBe('running');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, env());
    await execution;
  });

  it('refuses to continue a task that is not suspended', async () => {
    const runner = new MockRunner().when('first', { kind: 'hang' });
    const h = harness(await wf(CHAIN), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);
    const ack = await h.controller.submit({ kind: 'resumeTask', taskId: 'first' }, env());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('is running');
    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, env());
    await execution;
  });

  it('keeps the suspension across a stop, so a resume can still continue it', async () => {
    const runner = new MockRunner().when('first', { kind: 'hang' });
    const h = harness(await wf(CHAIN), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.calls.length === 1);
    await h.controller.submit({ kind: 'suspendTask', taskId: 'first' }, env());
    await waitFor(() => h.run.tasks.first!.state === 'suspended');

    await h.controller.submit({ kind: 'stop', mode: 'wait' }, env());
    await execution;
    // The stop is an interruption, as any stop is — what matters is that the suspension survived it with
    // the session attached, because that is what `cao resume` picks back up.
    expect(h.run.state).toBe('interrupted');
    expect(h.run.tasks.first!.state).toBe('suspended');
    expect(h.run.tasks.first!.resumeSessionId).toBe('s-1');
  });
});
