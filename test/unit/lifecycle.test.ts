/**
 * The workspace session (spec §2.4, [D5], [D36]): what happens between a run ending and the operator
 * leaving.
 *
 * Driven without Ink. The session is given a dashboard double that reacts to what the session does to it
 * the way an operator reacts to what they see — press `S` on the ended screen, press `Q` once the banner
 * says another terminal took the run — so every case here is about the *loop*: which execution runs next,
 * what the exit code ends up being, what a quit answer does. How any of it is drawn is
 * `workspace-lifecycle.test.tsx`; the whole path against the fake CLIs is
 * `test/integration/lifecycle.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { createWorkspaceSession, resumeRequestOptions, runWorkspaceSession, type ExecutionHandle } from '../../src/cli/workspace-session.js';
import { RunLockedError } from '../../src/cli/app.js';
import type { DashboardController, DashboardOptions } from '../../src/tui/app.js';
import type { ObservedRun, RunObserver } from '../../src/workflow/control/observer.js';
import type { SchedulerResult } from '../../src/workflow/scheduler.js';
import type { WorkflowRun } from 'code-agent-orchestrator-protocol';

const ts = '2026-09-17T09:12:34.000Z';

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({
    runId: '2026-09-17-001',
    workflowName: 'w',
    repositoryRoot: '/repo',
    state: 'failed',
    createdAt: ts,
    startedAt: ts,
    eventSeq: 0,
    workflow: { execution: { maxConcurrency: 1, outputBufferLines: 200 }, tasks: [{ id: 'a' }] },
    tasks: { a: { id: 'a', state: 'failed', attempts: [] } },
    ...over,
  }) as unknown as WorkflowRun;

const result = (state: SchedulerResult['state'], exitCode: number): SchedulerResult => ({ state, exitCode, summary: {} as SchedulerResult['summary'] });

type Reaction = (event: 'ended' | 'role' | 'notice', options: DashboardOptions, detail: string) => void;

/** A dashboard that records what was done to it, and lets the test answer as an operator would. */
function fakeDashboard(react?: Reaction) {
  const calls: string[] = [];
  let captured: DashboardOptions | undefined;
  let open = false;
  const fire = (event: 'ended' | 'role' | 'notice', detail = ''): void => react?.(event, captured!, detail);
  const controller: DashboardController = {
    get isOpen() {
      return open;
    },
    open: () => {
      open = true;
      calls.push('open');
    },
    close: () => {
      open = false;
      calls.push('close');
    },
    attach: () => calls.push('attach'),
    executionEnded: () => {
      calls.push('executionEnded');
      fire('ended');
    },
    setOwnership: (view) => {
      calls.push(`role:${view.role}${view.banner ? ':banner' : ''}${view.observer ? ':surface' : ''}`);
      fire('role', view.role);
    },
    update: (run) => calls.push(`update:${run.runId}`),
    notify: (text) => {
      calls.push(`notify:${text}`);
      fire('notice', text);
    },
    requestApproval: () => Promise.resolve('defer' as const),
    requestInteraction: () => Promise.resolve({ kind: 'deny', message: 'no' }),
    finish: async () => {
      open = false;
      calls.push('finish');
    },
  };
  return {
    calls,
    controller,
    get options() {
      return captured!;
    },
    factory: (options: DashboardOptions) => {
      captured = options;
      return controller;
    },
  };
}

const handle = (target: WorkflowRun, interrupts: string[] = []): ExecutionHandle => ({
  run: target,
  bus: { seq: 0, onAny: () => () => undefined } as unknown as ExecutionHandle['bus'],
  controller: {} as ExecutionHandle['controller'],
  interrupt: {
    interrupt: (source?: string) => interrupts.push(source ?? 'signal'),
    beginShutdown: () => undefined,
    forceKill: () => interrupts.push('force'),
    install: () => () => undefined,
    get interrupted() {
      return interrupts.length > 0;
    },
  },
});

describe('the workspace session', () => {
  it('stays open when the run ends and leaves with that run’s exit code', async () => {
    let endedWhileMounted: string[] = [];
    const dashboard = fakeDashboard((event, options) => {
      if (event !== 'ended') return;
      endedWhileMounted = [...dashboard.calls];
      options.onQuit!();
    });
    const target = run();
    const code = await runWorkspaceSession({
      first: { run: target, environment: {}, secrets: [], isResume: false },
      createDashboard: dashboard.factory,
      execute: async (_options, session) => {
        session.attach(handle(target));
        return result('failed', 1);
      },
    });
    expect(code).toBe(1);
    // The workspace was still up when the ended state was drawn: nothing finished it before the operator
    // asked to leave. This is the §1.2 bug, asserted the only way it can be.
    expect(endedWhileMounted).not.toContain('finish');
    expect(dashboard.calls.indexOf('executionEnded')).toBeLessThan(dashboard.calls.indexOf('finish'));
    expect(dashboard.calls.filter((c) => c === 'finish')).toHaveLength(1);
  });

  it('returns 0 for a session that never executed anything', async () => {
    const dashboard = fakeDashboard((event, options) => {
      if (event === 'ended') options.onQuit!();
    });
    const target = run({ state: 'completed' });
    const code = await runWorkspaceSession({
      idle: { run: target, store: {} as never, controller: {} as never, role: 'owner' },
      createDashboard: dashboard.factory,
      execute: async () => {
        throw new Error('nothing should execute');
      },
    });
    expect(code).toBe(0);
    expect(dashboard.calls).toContain('executionEnded');
  });

  it('runs the next execution when an ended-run action asks for one, and keeps its exit code', async () => {
    let ends = 0;
    const dashboard = fakeDashboard((event, options) => {
      if (event !== 'ended') return;
      ends += 1;
      if (ends === 1) options.onResume!({ kind: 'resume' });
      else options.onQuit!();
    });
    const first = run();
    const second = run({ state: 'completed' });
    const executed: Array<boolean | undefined> = [];
    const code = await runWorkspaceSession({
      first: { run: first, environment: {}, secrets: [], isResume: false },
      createDashboard: dashboard.factory,
      // `startRuntime` is what the real session prepares with; here the preparation is stubbed so the case
      // stays about the loop. The full path is exercised in test/integration/lifecycle.test.ts.
      prepare: async () => ({ run: second, environment: {}, secrets: [], isResume: true }),
      execute: async (options, session) => {
        executed.push(options.isResume);
        session.attach(handle(options.run));
        return executed.length === 1 ? result('failed', 1) : result('completed', 0);
      },
    });
    expect(executed).toEqual([false, true]);
    expect(code).toBe(0);
  });

  it('remembers a quit asked for while the run was still going [D5]', async () => {
    const dashboard = fakeDashboard();
    const target = run();
    const interrupts: string[] = [];
    const code = await runWorkspaceSession({
      first: { run: target, environment: {}, secrets: [], isResume: false },
      createDashboard: dashboard.factory,
      execute: async (_options, session) => {
        session.attach(handle(target, interrupts));
        // "Stop and quit": the workspace asks for the stop and records the quit; the loop only reads the
        // intention once the scheduler has come back.
        dashboard.options.onInterrupt();
        dashboard.options.onQuit!();
        return result('interrupted', 130);
      },
    });
    expect(interrupts).toEqual(['Ctrl+C']);
    expect(code).toBe(130);
  });

  it('flips to observer when another process took the lock, and stays open', async () => {
    const dashboard = fakeDashboard((event, options, detail) => {
      if (event === 'ended') options.onResume!({ kind: 'resume' });
      if (event === 'role' && detail === 'observer') options.onQuit!();
    });
    const target = run();
    let executions = 0;
    const code = await runWorkspaceSession({
      first: { run: target, environment: {}, secrets: [], isResume: false },
      createDashboard: dashboard.factory,
      prepare: () => {
        throw new RunLockedError('2026-09-17-001', 4242, ts);
      },
      execute: async (_options, session) => {
        executions += 1;
        session.attach(handle(target));
        return result('failed', 1);
      },
    });
    expect(code).toBe(1);
    expect(dashboard.calls).toContain('role:observer:banner');
    expect(dashboard.calls.some((c) => c.startsWith('notify:') && c.includes('pid 4242'))).toBe(true);
    // One execution only: the action that could not take the lock did not start a second.
    expect(executions).toBe(1);
  });

  /**
   * The observer the session flips to, without a run directory behind it: a thing that can be started, told
   * what to say on its next tick, and stopped. Everything the session does with a real one it does with
   * this — subscribe, redraw, and let go when the ownership stops being "owned" (§2.1, [D37]).
   */
  function fakeObserver(runValue: WorkflowRun, onStarted?: () => void) {
    const listeners = new Set<(view: ObservedRun) => void>();
    const calls: string[] = [];
    let view: ObservedRun = { run: runValue, ownership: { kind: 'owned', pid: 4242, resumable: false } };
    const surface = { ownerPid: 4242, capabilities: ['stop'] as never, send: async () => ({ status: 'applied' as const }) };
    const observer: RunObserver = {
      get run() {
        return view.run;
      },
      get ownership() {
        return view.ownership;
      },
      controller: {} as never,
      surface,
      start: () => {
        calls.push('start');
        for (const l of [...listeners]) l(view);
        onStarted?.();
      },
      stop: () => {
        calls.push('stop');
        listeners.clear();
      },
      tick: async () => undefined,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      observer,
      calls,
      /** The next tick, as the poll would deliver it. */
      report(next: ObservedRun) {
        view = next;
        for (const l of [...listeners]) l(next);
      },
    };
  }

  it('follows the run it lost, and stops following when the owner lets go (§2.1)', async () => {
    const target = run();
    // The poll's first tick reports the run as owned; its second reports the owner gone.
    const watcher = fakeObserver(target, () => watcher.report({ run: target, ownership: { kind: 'abandoned', pid: 4242, resumable: true } }));
    const dashboard = fakeDashboard((event, options, detail) => {
      if (event === 'ended') options.onResume!({ kind: 'resume' });
      if (event === 'notice' && detail.includes('nothing owns it now')) {
        // Into the observer's own log: what is asserted is that the poll had already been dropped by the
        // time the operator was told the run was theirs to take, not merely that it stopped eventually.
        watcher.calls.push('notice');
        options.onQuit!();
      }
    });
    const code = await runWorkspaceSession({
      first: { run: target, environment: {}, secrets: [], isResume: false },
      createDashboard: dashboard.factory,
      observe: () => watcher.observer,
      prepare: () => {
        throw new RunLockedError('2026-09-17-001', 4242, ts);
      },
      execute: async (_options, session) => {
        session.attach(handle(target));
        return result('failed', 1);
      },
    });
    expect(code).toBe(1);
    // The poll ran while another process had the run, and the surface was wired up with it...
    expect(watcher.calls).toEqual(['start', 'stop', 'notice']);
    expect(dashboard.calls).toContain('role:observer:banner:surface');
    // ...and once the owner had gone the window took the badge back, with no surface to send controls to.
    expect(dashboard.calls).toContain('role:owner');
    expect(dashboard.calls.some((c) => c.startsWith('update:'))).toBe(true);
  });

  it('stops watching the moment this process starts executing the run again', async () => {
    const target = run();
    const watcher = fakeObserver(target);
    let ends = 0;
    const dashboard = fakeDashboard((event, options) => {
      if (event !== 'ended') return;
      ends += 1;
      if (ends === 1) options.onResume!({ kind: 'resume' });
      else options.onQuit!();
    });
    await runWorkspaceSession({
      idle: { run: target, store: {} as never, controller: {} as never, role: 'observer', banner: 'watching', observer: watcher.observer },
      createDashboard: dashboard.factory,
      prepare: async () => ({ run: target, environment: {}, secrets: [], isResume: true }),
      execute: async (_options, session) => {
        // Into the observer's own log, so the order of the two is what is asserted rather than the fact of
        // them: the session closing would stop the poll eventually either way.
        session.attach(handle(target));
        watcher.calls.push('attached');
        return result('completed', 0);
      },
    });
    // `attach` is this process becoming the owner: the poll is dropped *before* the execution it is now
    // the owner of starts, so nothing is left watching a run this process is executing.
    expect(watcher.calls).toEqual(['start', 'stop', 'attached']);
    expect(dashboard.calls).toContain('role:owner');
  });

  it('turns a resume that cannot start into a notice and stays open', async () => {
    const dashboard = fakeDashboard((event, options, detail) => {
      if (event === 'ended') options.onResume!({ kind: 'task', taskId: 'nope' });
      // Reading the notice is what tells the operator the action did not happen; then they leave.
      if (event === 'notice' && detail.includes('no task')) options.onQuit!();
    });
    const target = run();
    let executions = 0;
    const code = await runWorkspaceSession({
      first: { run: target, environment: {}, secrets: [], isResume: false },
      createDashboard: dashboard.factory,
      prepare: () => {
        throw new Error('Run 2026-09-17-001 has no task "nope"');
      },
      execute: async (_options, session) => {
        executions += 1;
        session.attach(handle(target));
        return result('failed', 1);
      },
    });
    expect(dashboard.calls.some((c) => c === 'notify:Run 2026-09-17-001 has no task "nope"')).toBe(true);
    expect(code).toBe(1);
    // Only one execution, and the workspace was still up when the notice was shown.
    expect(executions).toBe(1);
    expect(dashboard.calls.indexOf('notify:Run 2026-09-17-001 has no task "nope"')).toBeLessThan(dashboard.calls.indexOf('finish'));
  });

  it('Ctrl+C on a run that already ended without one says so instead of forcing', () => {
    const dashboard = fakeDashboard();
    const target = run({ state: 'completed' });
    const interrupts: string[] = [];
    const session = createWorkspaceSession({ createDashboard: dashboard.factory, execute: async () => result('completed', 0) });
    session.attach(handle(target, interrupts));
    session.executionEnded(result('completed', 0));

    dashboard.options.onInterrupt();
    expect(interrupts).toEqual([]);
    expect(dashboard.calls.some((c) => c.startsWith('notify:') && c.includes('nothing to stop'))).toBe(true);
  });

  it('a second Ctrl+C after a stop goes straight to the force-kill', () => {
    const dashboard = fakeDashboard();
    const target = run();
    const interrupts: string[] = [];
    const session = createWorkspaceSession({ createDashboard: dashboard.factory, execute: async () => result('interrupted', 130) });
    session.attach(handle(target, interrupts));

    dashboard.options.onInterrupt();
    expect(interrupts).toEqual(['Ctrl+C']);
    // The run has ended by now, but it ended *because* of that stop, so the escalation is still live: the
    // interrupt controller's own second call is the force-kill and its exit code 130.
    session.executionEnded(result('interrupted', 130));
    dashboard.options.onInterrupt();
    expect(interrupts).toEqual(['Ctrl+C', 'Ctrl+C']);
  });
});

describe('an ended-state action as cao resume arguments [D36]', () => {
  it('maps every action to the arguments cao resume takes', () => {
    expect(resumeRequestOptions({ kind: 'resume' })).toEqual({});
    expect(resumeRequestOptions({ kind: 'task', taskId: 'a' })).toEqual({ task: ['a'] });
    expect(resumeRequestOptions({ kind: 'from', taskId: 'a' })).toEqual({ from: ['a'] });
    expect(resumeRequestOptions({ kind: 'answer', taskId: 'a', text: 'postgres' })).toEqual({ task: ['a'], input: 'postgres' });
    expect(resumeRequestOptions({ kind: 'approve', taskId: 'a' })).toEqual({ approve: ['a'] });
    expect(resumeRequestOptions({ kind: 'reject', taskId: 'a' })).toEqual({ reject: ['a'] });
  });
});
