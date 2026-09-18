/**
 * The run controller (spec §2.2): deduplication, staleness, serialization, `cancelTask` and what happens to
 * a command that arrives after the run has ended.
 *
 * Everything here drives a real `WorkflowScheduler` against the fakes, because what is being tested is that
 * commands land *inside* its loop: a controller that applied them on the side would pass any test that only
 * looked at the ack.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, waitFor } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { createRunController, type RunController } from '../../src/workflow/control/controller.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';
import { NEEDS_INPUT_HINT } from '../../src/util/text.js';
import { ulid } from '../../src/util/ulid.js';
import type { Clock } from '../../src/util/misc.js';
import type { FinalizeResult } from '../../src/workspace/workspace-manager.js';
import type { InteractionAnswer, ResolvedTask, ResolvedWorkflow, WorkspaceInfo } from 'code-agent-orchestrator-protocol';

interface Harness {
  scheduler: WorkflowScheduler;
  controller: RunController;
  store: MemoryRunStore;
  runner: MockRunner;
  workspace: MockWorkspace;
  bus: WorkflowEventBus;
  run: ReturnType<typeof makeRun>;
}

function harness(
  workflow: ResolvedWorkflow,
  runner = new MockRunner(),
  extra: Partial<ConstructorParameters<typeof WorkflowScheduler>[0]> = {},
  opts: { workspace?: MockWorkspace; clock?: Clock; onKill?: () => void } = {},
): Harness {
  const run = makeRun(workflow);
  const store = new MemoryRunStore();
  const workspace = opts.workspace ?? new MockWorkspace(workflow.repositoryRoot);
  const bus = new WorkflowEventBus(run.runId);
  bus.onAny((e) => void store.appendEvent(e));
  const scheduler = new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace, bus, ...extra });
  const controller = createRunController({ scheduler, clock: opts.clock, onKill: opts.onKill });
  return { scheduler, controller, store, runner, workspace, bus, run };
}

async function wf(yaml: string): Promise<ResolvedWorkflow> {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join('\n'));
  return workflow;
}

/** Two tasks that run at the same time, so one can be cancelled while the other is watched. */
const PAIR = `
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
`;

/** The same, with `a` failing once and for all while `b` keeps the loop alive. */
const FAILING_PAIR = `
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    parallelGroup: g
    retries: 0
    onFailure: continue
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
`;

const tui = (expected?: { attempt?: number; revision?: number }) => controlEnvelope('tui', expected);

describe('run controller: identity and staleness', () => {
  it('applies a duplicate id once and answers the resend with the first ack', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const envelope = tui();
    const first = await h.controller.submit({ kind: 'restart', taskId: 'a' }, envelope);
    const again = await h.controller.submit({ kind: 'restart', taskId: 'a' }, envelope);

    expect(first.status).toBe('applied');
    expect(again).toEqual(first);
    // One restart warning, not two: the resend was answered, not acted on.
    expect(h.store.events.filter((e) => e.type === 'workflow.warning' && 'code' in e && e.code === 'restart')).toHaveLength(1);
    expect(h.run.controls!.seen.map((a) => a.id)).toEqual([envelope.id]);
    expect(h.run.controls!.seen[0]!.protocol).toBe(1);
    // Persist-before-act: the answer is in the snapshot the scheduler saved, not only in memory.
    expect(h.store.snapshots.some((s) => s.controls?.seen.some((a) => a.id === envelope.id))).toBe(true);

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses a command built on an attempt the task has already left', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const stale = await h.controller.submit({ kind: 'restart', taskId: 'a' }, tui({ attempt: 0 }));
    expect(stale.status).toBe('rejected');
    expect(stale.reason).toBe('Task "a" is on attempt 1, request expected 0.');

    // Revisions ship in stage 2; until then every task is at revision 0, and a request that expects one is
    // still refused rather than quietly applied.
    const staleRevision = await h.controller.submit({ kind: 'restart', taskId: 'a' }, tui({ revision: 2 }));
    expect(staleRevision.status).toBe('rejected');
    expect(staleRevision.reason).toBe('Task "a" is at revision 0, request expected 2.');

    const fresh = await h.controller.submit({ kind: 'restart', taskId: 'a' }, tui({ attempt: 1, revision: 0 }));
    expect(fresh.status).toBe('applied');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('applies two commands submitted in one tick in the order they were submitted', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const [first, second] = await Promise.all([
      h.controller.submit({ kind: 'restart', taskId: 'a' }, tui()),
      h.controller.submit({ kind: 'restart', taskId: 'a' }, tui()),
    ]);

    // The second sees what the first did. The loop promotes and relaunches "a" before it takes the second
    // command off the queue, so by the time that one is decided the task is running again and cannot be
    // restarted. Interleaved, both would have been applied to a task that was still `failed`.
    expect(first.status).toBe('applied');
    expect(second.status).toBe('rejected');
    expect(second.reason).toBe('Task "a" is still running. Cancel it first, then restart it.');
    expect(h.run.controls!.seen.map((a) => a.status)).toEqual(['applied', 'rejected']);

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  /**
   * §2.2 defines `restart` as "terminal non-success → pending", which is every state a task can finish in
   * except `success` - `skipped` included. A task skipped because its condition was false, or because the
   * dependency it was waiting on failed, is exactly the task an operator restarts once that is dealt with,
   * and `scheduler.requestRestart` has accepted it since before the controller existed.
   */
  it('restarts a skipped task, not only a failed, blocked or cancelled one', async () => {
    const runner = new MockRunner().when('b', { kind: 'hang' });
    const h = harness(
      await wf(`
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    parallelGroup: g
    when:
      expr: 1 > 2
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
`),
      runner,
    );
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'skipped');

    const ack = await h.controller.submit({ kind: 'restart', taskId: 'a' }, tui());
    expect(ack.status).toBe('applied');
    expect(h.run.tasks.a!.state).not.toBe('skipped');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });
});

describe('run controller: cancelTask', () => {
  it('cancels the attempt that is running and leaves the task beside it alone', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'success', delayMs: 30 });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running' && h.run.tasks.b!.state === 'running');

    const ack = await h.controller.submit({ kind: 'cancelTask', taskId: 'a' }, tui());
    expect(ack.status).toBe('applied');
    // Not "was cancelled": the abort has been delivered but the task is still running until its worker dies.
    expect(ack.reason).toBe('Attempt 1 of "a" is being aborted; the task ends as cancelled once its worker has stopped.');
    expect(h.run.tasks.a!.state).toBe('running');

    const result = await execution;
    expect(h.run.tasks.a!.state).toBe('cancelled');
    // A task an operator cancelled was interrupted; `stop_requested` would claim the whole run was stopping.
    expect(h.run.tasks.a!.reason).toBe('user_interrupt');
    expect(h.run.tasks.a!.attempts[0]!.outcome).toBe('cancelled');
    expect(h.run.tasks.b!.state).toBe('success');
    expect(result.summary.cancelled).toBe(1);
  });

  it('denies what a waiting task was asking before it aborts it, with the hint the worker needs', async () => {
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: { title: 'Bash: rm -rf build' }, then: { kind: 'success' } });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'), runner, {
      // A human is looking at the prompt and has not decided: exactly the state `cancelTask` has to break.
      interactionHandler: () => new Promise<InteractionAnswer>(() => undefined),
    });
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'waiting');

    const ack = await h.controller.submit({ kind: 'cancelTask', taskId: 'a' }, tui());
    expect(ack.status).toBe('applied');
    await execution;

    const answer = h.runner.calls[0]!.answers![0]!;
    expect(answer.kind).toBe('deny');
    const message = answer.kind === 'deny' ? answer.message : '';
    expect(message).toContain('The task was cancelled');
    expect(message).toContain('Bash: rm -rf build');
    expect(message).toContain(NEEDS_INPUT_HINT);
    expect(h.run.tasks.a!.attempts[0]!.interactions![0]).toMatchObject({ answer: 'deny', source: 'stopped' });
    expect(h.run.tasks.a!.state).toBe('cancelled');
    expect(h.run.tasks.a!.pendingInteraction).toBeUndefined();
  });

  it('waits for merge-back when the attempt has already ended, and cancels instead of retrying', async () => {
    const workspace = new GatedWorkspace(path.resolve(process.cwd()));
    const runner = new MockRunner().when('a', { kind: 'hang' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 3\n    prompt: p\n'), runner, {}, { workspace });
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    // The attempt ends and its workspace starts merging back; the finalize is held open right there.
    runner.complete('a', 1, { kind: 'error', outcome: 'crash', message: 'boom' });
    await waitFor(() => workspace.gated);

    const ack = await h.controller.submit({ kind: 'cancelTask', taskId: 'a' }, tui());
    expect(ack.status).toBe('accepted');
    expect(ack.reason).toBe('Attempt 1 of "a" has ended and is merging back; the task is cancelled as soon as that finishes.');
    // Nothing has changed yet: the attempt owns the workspace until it is done with it.
    expect(h.run.tasks.a!.state).toBe('running');

    workspace.release();
    const result = await execution;
    // Three retries were left, and none of them was spent: the cancel is what ended the task.
    expect(h.run.tasks.a!.attempts).toHaveLength(1);
    expect(h.run.tasks.a!.state).toBe('cancelled');
    expect(h.run.tasks.a!.reason).toBe('user_interrupt');
    expect(h.run.tasks.a!.message).toBe('cancelled by the operator');
    expect(result.summary.cancelled).toBe(1);
  });

  it('tells an operator to wait rather than to cancel again, while the cancel they asked for lands', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running' && h.run.tasks.b!.state === 'running');

    await h.controller.submit({ kind: 'cancelTask', taskId: 'a' }, tui());
    // The window this covers: the abort is in flight, the task still reads `running`, and the operator
    // reaches for restart because the ack said the task was being cancelled. "Cancel it first" would be
    // telling them to do again what they just did.
    const tooSoon = await h.controller.submit({ kind: 'restart', taskId: 'a' }, tui());
    expect(tooSoon.status).toBe('rejected');
    expect(tooSoon.reason).toBe('Task "a" is being cancelled and has not stopped yet. Restart it once it is showing as cancelled.');

    await waitFor(() => h.run.tasks.a!.state === 'cancelled');
    const now = await h.controller.submit({ kind: 'restart', taskId: 'a' }, tui());
    expect(now.status).toBe('applied');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses to cancel a task that has not started and one that has already finished', async () => {
    // `c` comes after the pair, so it is still `pending` while they run and `b` keeps the loop alive after
    // `a` has been cancelled.
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(`${PAIR}  - id: c\n    prompt: p\n`), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running' && h.run.tasks.b!.state === 'running');

    const notStarted = await h.controller.submit({ kind: 'cancelTask', taskId: 'c' }, tui());
    expect(notStarted.status).toBe('rejected');
    expect(notStarted.reason).toContain('has not started, so there is nothing to cancel');

    const unknown = await h.controller.submit({ kind: 'cancelTask', taskId: 'nope' }, tui());
    expect(unknown.status).toBe('rejected');
    expect(unknown.reason).toContain('There is no task "nope" in this run');

    await h.controller.submit({ kind: 'cancelTask', taskId: 'a' }, tui());
    await waitFor(() => h.run.tasks.a!.state === 'cancelled');
    const finished = await h.controller.submit({ kind: 'cancelTask', taskId: 'a' }, tui());
    expect(finished.status).toBe('rejected');
    expect(finished.reason).toBe('Task "a" already finished as cancelled, so there is nothing to cancel.');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });
});

describe('run controller: run-level commands', () => {
  it('stops the run through the controller and escalates a kill to its handler', async () => {
    let killed = 0;
    // A clock that fires at once, so the escalation the controller schedules after the ack is observable
    // without waiting on a real timer.
    const clock: Clock = { now: () => Date.now(), setTimeout: (fn) => (fn(), undefined), clearTimeout: () => undefined };
    const runner = new MockRunner().when('a', { kind: 'hang' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'), runner, {}, { clock, onKill: () => killed++ });
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    const ack = await h.controller.submit({ kind: 'kill' }, tui());
    expect(ack.status).toBe('applied');
    expect(killed).toBe(1);
    expect(h.controller.stopping).toBe(true);

    const result = await execution;
    expect(result.state).toBe('interrupted');
  });

  it('declares the permission commands but does not apply them yet, and answers a prompt with the transport', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    // §3.5: a worker whose runner offered no live channel cannot be steered, and the refusal says so
    // rather than pretending the feature does not exist. A follow-up to a task that is still running has no
    // attempt to start, and is refused with the row that does apply to it.
    const prompt = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'hi', mode: 'steer' }, tui());
    const followUp = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'hi', mode: 'followUp' }, tui());
    const approve = await h.controller.submit({ kind: 'approve', taskId: 'a' }, tui());
    const answer = await h.controller.submit({ kind: 'answer', taskId: 'a', interactionId: 'r1', answer: { kind: 'allow', scope: 'once' } }, tui());

    for (const ack of [prompt, followUp, approve, answer]) expect(ack.status).toBe('rejected');
    expect(prompt.reason).toContain('has no channel to steer through');
    expect(followUp.reason).toContain('so a follow-up has no attempt to start');
    expect(approve.reason).toContain('Approve or reject "a" in the terminal that owns this run');
    expect(answer.reason).toContain('Answer "a" in the terminal that owns this run');
    // Nothing was touched by any of them.
    expect(h.run.tasks.a!.state).toBe('running');
    expect(h.run.tasks.a!.attempts[0]!.prompts).toBeUndefined();

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });
});

describe('run controller: after the run has ended', () => {
  it('keeps reading and refuses every command with a sentence that says the run ended', async () => {
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'));
    const result = await h.scheduler.execute();
    expect(result.state).toBe('completed');

    const commands = [
      { kind: 'stop', mode: 'cancel' },
      { kind: 'kill' },
      { kind: 'cancelTask', taskId: 'a' },
      { kind: 'restart', taskId: 'a' },
      { kind: 'edit', taskId: 'a', changes: {}, restart: false },
      { kind: 'prompt', taskId: 'a', text: 'x', mode: 'followUp' },
    ] as const;
    for (const command of commands) {
      const ack = await h.controller.submit(command, tui());
      expect(ack.status).toBe('rejected');
      expect(ack.reason).toContain('This run has ended');
    }

    // Read-only accessors keep working, which is what lets a workspace stay open on an ended run (§2.4).
    expect(h.controller.ended).toBe(true);
    expect(h.controller.run.state).toBe('completed');
    expect(h.controller.run.tasks.a!.state).toBe('success');
    expect(h.controller.peek('a')).toEqual(h.scheduler.peek('a'));
    expect(await h.controller.capturedDiff('a')).toBeNull();
  });

  it('answers a resend that crosses the end of the run with the first ack, not with "the run has ended"', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    const envelope = tui();
    const first = await h.controller.submit({ kind: 'stop', mode: 'cancel' }, envelope);
    expect(first.status).toBe('applied');
    await execution;

    // A sender whose ack was lost resends the same id. It is the same request, and it was applied: telling
    // it the run has ended says the opposite of what happened, and on the inbox path that answer overwrites
    // the ack already on disk.
    const again = await h.controller.submit({ kind: 'stop', mode: 'cancel' }, envelope);
    expect(again).toEqual(first);
    expect(h.run.controls!.seen.filter((ack) => ack.id === envelope.id)).toHaveLength(1);

    // Something the run never saw still gets the sentence that says the run is over.
    const fresh = await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    expect(fresh.status).toBe('rejected');
    expect(fresh.reason).toContain('This run has ended');
  });

  it('answers a command still queued when the loop ends rather than leaving its caller waiting', async () => {
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'));
    const execution = h.scheduler.execute();
    // Submitted blind, without waiting for a state: some of these land after the loop has broken, and the
    // point is that every one of them is answered either way.
    const acks = await Promise.all(Array.from({ length: 6 }, () => h.controller.submit({ kind: 'restart', taskId: 'a' }, tui())));
    await execution;
    expect(acks).toHaveLength(6);
    for (const ack of acks) expect(['applied', 'rejected']).toContain(ack.status);
  });
});

describe('ulid', () => {
  it('sorts by time and keeps the order of ids minted in the same millisecond', () => {
    const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000));
    expect(ids.every((id) => id.length === 26)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ulid(1_700_000_000_000) < ulid(1_700_000_001_000)).toBe(true);
  });
});

/** A workspace whose `finalize` can be held open, so a test can look at an attempt while it merges back. */
class GatedWorkspace extends MockWorkspace {
  gated = false;
  private open?: () => void;

  override async finalize(task: ResolvedTask, info: WorkspaceInfo, outcome: string): Promise<FinalizeResult> {
    this.gated = true;
    await new Promise<void>((resolve) => {
      this.open = resolve;
    });
    this.gated = false;
    return super.finalize(task, info, outcome);
  }

  release(): void {
    this.open?.();
  }
}
