import { describe, it, expect } from 'vitest';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, states } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import type { ResolvedWorkflow } from '../../src/types/workflow.js';
import type { Interaction, InteractionAnswer } from '../../src/types/interaction.js';
import type { HookRunner } from '../../src/execution/hooks.js';
import type { Clock } from '../../src/util/misc.js';
import type { TaskState } from '../../src/types/run.js';

function harness(workflow: ResolvedWorkflow, runner: MockRunner, extra: Partial<ConstructorParameters<typeof WorkflowScheduler>[0]> = {}) {
  const run = makeRun(workflow);
  const store = new MemoryRunStore();
  const workspace = new MockWorkspace(workflow.repositoryRoot);
  const bus = new WorkflowEventBus(run.runId);
  bus.onAny((e) => void store.appendEvent(e));
  const scheduler = new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace, bus, ...extra });
  return { scheduler, store, runner, bus, run };
}

async function wf(yaml: string) {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join('\n'));
  return workflow;
}

const ONE = 'name: t\ntasks:\n  - id: a\n    prompt: p\n';

describe('scheduler: worker interactions', () => {
  it('routes a permission prompt through the handler and returns to running', async () => {
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: { toolName: 'Bash', title: 'Bash: npm publish' }, then: { kind: 'success' } });
    const seen: TaskState[] = [];
    const h = harness(await wf(ONE), runner, {
      interactionHandler: async (i: Interaction): Promise<InteractionAnswer> => {
        seen.push(h.run.tasks['a']!.state);
        expect(i.kind).toBe('permission');
        expect(i.taskId).toBe('a');
        return { kind: 'allow', scope: 'always' };
      },
    });
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(seen).toEqual(['waiting']);
    expect(states(h.run)).toEqual({ a: 'success' });
    expect(runner.calls[0]!.answers).toEqual([{ kind: 'allow', scope: 'always' }]);
    const attempt = h.run.tasks['a']!.attempts[0]!;
    expect(attempt.interactions).toHaveLength(1);
    expect(attempt.interactions![0]).toMatchObject({ kind: 'permission', toolName: 'Bash', answer: 'allow_always', source: 'handler' });
    expect(h.run.tasks['a']!.pendingInteraction).toBeUndefined();
    const types = h.store.events.map((e) => e.type);
    expect(types).toContain('task.interaction.requested');
    expect(types).toContain('task.interaction.answered');
    expect(h.store.snapshots.some((s) => s.tasks['a']!.state === 'waiting' && s.tasks['a']!.pendingInteraction?.title === 'Bash: npm publish')).toBe(true);
    expect(runner.calls[0]!.canInteract).toBe(true);
  });

  it('denies immediately when no handler is attached, without entering waiting', async () => {
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: {}, then: { kind: 'success' } });
    const h = harness(await wf(ONE), runner);
    await h.scheduler.execute();
    const answer = runner.calls[0]!.answers![0]!;
    expect(answer.kind).toBe('deny');
    expect((answer as { message: string }).message).toMatch(/No human is available/);
    expect(h.store.snapshots.some((s) => s.tasks['a']!.state === 'waiting')).toBe(false);
    expect(h.run.tasks['a']!.attempts[0]!.interactions![0]!.source).toBe('no_handler');
    expect(runner.calls[0]!.canInteract).toBe(false);
  });

  it('stays waiting until every concurrent request has been answered', async () => {
    // A worker making parallel tool calls can have two prompts open at once. Answering the second must not
    // report the task as running while the first is still blocking it.
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: { toolName: 'Bash' }, concurrent: 2, then: { kind: 'success' } });
    const open: Array<() => void> = [];
    const stateWhenAnswering: TaskState[] = [];
    const h = harness(await wf(ONE), runner, {
      interactionHandler: (_i): Promise<InteractionAnswer> =>
        new Promise((resolve) => {
          open.push(() => {
            stateWhenAnswering.push(h.run.tasks['a']!.state);
            resolve({ kind: 'allow', scope: 'once' });
          });
        }),
    });
    const done = h.scheduler.execute();
    for (let i = 0; i < 200 && open.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(open).toHaveLength(2);
    expect(h.run.tasks['a']!.state).toBe('waiting');
    expect(h.run.tasks['a']!.pendingInteraction).toBeDefined();

    open[1]!(); // answer the newer prompt first
    await new Promise((r) => setTimeout(r, 20));
    expect(h.run.tasks['a']!.state).toBe('waiting');
    expect(h.run.tasks['a']!.pendingInteraction?.id).toBe('req-1');

    open[0]!();
    const res = await done;
    expect(res.state).toBe('completed');
    expect(stateWhenAnswering).toEqual(['waiting', 'waiting']);
    expect(h.run.tasks['a']!.pendingInteraction).toBeUndefined();
    expect(h.run.tasks['a']!.attempts[0]!.interactions).toHaveLength(2);
  });

  it('denies after the interaction timeout', async () => {
    const workflow = await wf('name: t\nexecution:\n  interactionTimeout: 5s\ntasks:\n  - id: a\n    prompt: p\n');
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const clock: Clock = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        const i = timers.indexOf(h as { fn: () => void; ms: number });
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: {}, then: { kind: 'success' } });
    // A handler that only ever settles when its signal is aborted: the dashboard is exactly this shape, and
    // if the timeout does not withdraw the request the modal stays on screen for a decision already made.
    let withdrawn = false;
    const h = harness(workflow, runner, {
      clock,
      interactionHandler: (_i, signal) =>
        new Promise(() =>
          signal.addEventListener('abort', () => {
            withdrawn = true;
          }),
        ),
    });
    const done = h.scheduler.execute();
    // Wait for the timer to be armed by the interaction, then fire it.
    for (let i = 0; i < 200 && !timers.some((t) => t.ms === 5000); i++) await new Promise((r) => setTimeout(r, 5));
    const timer = timers.find((t) => t.ms === 5000)!;
    expect(timer).toBeDefined();
    timer.fn();
    const res = await done;
    expect(withdrawn).toBe(true);
    expect(res.state).toBe('paused');
    expect(states(h.run)).toEqual({ a: 'needs_input' });
    const answer = runner.calls[0]!.answers![0]!;
    expect(answer.kind).toBe('deny');
    expect((answer as { message: string }).message).toMatch(/within 00m 05s/);
    expect(h.run.tasks['a']!.attempts[0]!.interactions![0]!.source).toBe('timeout');
  });

  it('runs the onInputRequired hook and records a withdrawn request as cancelled', async () => {
    const workflow = await wf('name: t\nhooks:\n  onInputRequired: notify\ntasks:\n  - id: a\n    prompt: p\n');
    const hookCalls: Array<{ hook: string; env?: Record<string, string> }> = [];
    const hooks: HookRunner = { run: async (hook, ctx) => void hookCalls.push({ hook, env: ctx?.env }) };
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: { toolName: 'Edit', title: 'Edit x.ts' }, withdrawAfterMs: 20, then: { kind: 'success' } });
    let signalAborted = false;
    const h = harness(workflow, runner, {
      hooks,
      interactionHandler: (_i, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            signalAborted = true;
            resolve({ kind: 'deny', message: 'withdrawn' });
          });
        }),
    });
    await h.scheduler.execute();
    expect(signalAborted).toBe(true);
    expect(hookCalls.find((c) => c.hook === 'onInputRequired')?.env).toMatchObject({ CAO_INTERACTION_KIND: 'permission', CAO_INTERACTION_TITLE: 'Edit x.ts', CAO_INTERACTION_TOOL: 'Edit' });
    expect(h.run.tasks['a']!.attempts[0]!.interactions![0]!.source).toBe('cancelled');
    expect(states(h.run)).toEqual({ a: 'success' });
  });

  it('a stop request while waiting aborts the handler and cancels the task', async () => {
    const runner = new MockRunner().when('a', { kind: 'interact', interaction: {}, then: { kind: 'success' } });
    const h = harness(await wf(ONE), runner, {
      interactionHandler: (_i, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ kind: 'deny', message: 'aborted' }))),
    });
    const done = h.scheduler.execute();
    for (let i = 0; i < 200 && h.run.tasks['a']!.state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(h.run.tasks['a']!.state).toBe('waiting');
    h.scheduler.requestStop('cancel', 'signal');
    const res = await done;
    expect(res.state).toBe('interrupted');
    expect(states(h.run)).toEqual({ a: 'cancelled' });
  });
});
