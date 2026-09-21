/**
 * The workspace session: the thing that outlives a run (spec §2.4, §3.1, [D5], [D36]).
 *
 * Before this existed, an interactive run was one execution and the screen was part of it — `executeRun`
 * mounted the dashboard, ran the scheduler and unmounted, so the frame with the failure on it was the frame
 * that disappeared. The session inverts that. It owns the Ink tree, the plain-output fallback, the
 * operator's intentions and the exit code; an execution is something that happens *inside* it, and there
 * can be several, because resuming an ended run from the workspace is just another one.
 *
 * Three things live here and nowhere else:
 *
 * - **The loop.** Execute, enter ended state, wait for what the operator wants, prepare the next execution
 *   through `startRuntime` — the same function `cao resume` calls, so a workspace resume and a command-line
 *   resume cannot validate differently or take the lock differently.
 * - **The quit answers** [D5]. Quitting during execution is a question with three answers, and two of them
 *   (stop and quit; carry on in plain output) need something that is neither the run nor the screen.
 * - **What the exit code is.** The latest execution's, or 0 for a session that only looked (§2.4).
 *
 * The session holds no lock while it is idle. Between executions the run is unowned, exactly as it is
 * between two `cao resume` invocations, and another terminal may take it — which is what flips this one to
 * observer.
 */
import readline from 'node:readline';
import type { EventBus } from '../events/event-bus.js';
import type { InterruptController } from '../execution/signals.js';
import type { FileRunStore } from '../persistence/run-store.js';
import type { RunController } from '../workflow/control/controller.js';
import type { SchedulerResult } from '../workflow/scheduler.js';
import { resumeRequestLabel, type ResumeRequest } from '../workflow/resume-request.js';
import { RunLockedError, startRuntime, type StartRuntimeOptions } from './app.js';
import { attachPlainRenderer } from './render/plain.js';
import { glyph } from '../util/glyphs.js';
import { BELL } from '../util/misc.js';
import { errorMessage } from '../util/errors.js';
import type { WorkspaceRole } from '../tui/workspace/chrome.js';
import type { DashboardController, DashboardOptions, QuotaFactory, WorkspaceView } from '../tui/app.js';
import { startQuotaMonitors } from '../runners/quota.js';
import { ownershipBadge, ownershipBanner } from './ownership.js';
import type { RunObserver } from '../workflow/control/observer.js';
import type { Interaction, InteractionAnswer, ResolvedTask, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { ExecuteOptions } from './commands/run.js';

/** One execution, as the session sees it: what to draw from, and what a Ctrl+C has to reach. */
export interface ExecutionHandle {
  run: WorkflowRun;
  bus: EventBus;
  controller: RunController;
  interrupt: InterruptController;
}

/** What `executeOnce` is given. Deliberately small: an execution knows nothing about what comes after it. */
export interface WorkspaceSession {
  /** Whether the workspace currently has the screen; false while minimised, so logs may use stderr. */
  readonly isOpen: boolean;
  /** This execution is starting: draw from it, and send its Ctrl+C here. */
  attach(execution: ExecutionHandle): void;
  /** A line that would have gone to stdout if the screen were not in the way. */
  notify(text: string): void;
  requestApproval(task: ResolvedTask): Promise<{ decision: 'approved' | 'rejected'; note?: string } | 'defer'>;
  requestInteraction(interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer>;
}

/** What the operator decided to do once an execution ended. */
type SessionIntent = { kind: 'quit' } | { kind: 'resume'; request: ResumeRequest };

/** The run the session shows when it was not entered by executing anything (`cao ui <run>`). */
export interface IdleRun {
  run: WorkflowRun;
  store: FileRunStore;
  /** A read-only controller over the run directory; see `createDetachedController`. */
  controller: RunController;
  role: WorkspaceRole;
  /** The observer banner naming the owning process, when there is one (§2.1). */
  banner?: string;
  /** The header badge; `owner` unless another process holds the run (§2.1). */
  badge?: string;
  /**
   * The poll that keeps the picture current while another process owns this run (§2.1, `[D37]`). Present
   * only when there is an owner to watch: a run nobody is executing does not change under the window.
   */
  observer?: RunObserver;
}

/** How the session mounts a workspace. Resolved before the loop starts, so `attach` never has to wait. */
export type DashboardFactory = (options: DashboardOptions) => DashboardController;

export interface WorkspaceSessionOptions {
  /** The execution the session was entered by, for `cao run` and `cao resume`. */
  first?: ExecuteOptions;
  /** The run to open on when there is no first execution, for `cao ui <run>`. */
  idle?: IdleRun;
  /**
   * How an execution is run. Injected rather than imported so this module does not have to depend on the
   * command that depends on it; there is exactly one implementation (`executeOnce`).
   */
  execute: (options: ExecuteOptions, session: WorkspaceSession) => Promise<SchedulerResult>;
  /**
   * How an ended-state action becomes the next execution. The default is `startRuntime` — the same
   * function `cao resume` calls — and it is injectable for the same reason `execute` is: the loop can then
   * be tested without a run directory, a lock or an agent CLI.
   */
  prepare?: (request: ResumeRequest, session: WorkspaceSession & { readonly runId: string | undefined }) => Promise<ExecuteOptions | undefined>;
  /**
   * How a run this window no longer owns is watched (§2.1, `[D37]`). Used when another process takes the
   * lock while this session is idle; `cao ui` builds its own and passes it in `idle` instead. Injected for
   * the same reason `execute` and `prepare` are: the flip is then testable without a second process.
   */
  observe?: (runId: string) => Promise<RunObserver | undefined> | RunObserver | undefined;
  /** What the tail lines are written with once the workspace has let the terminal go. */
  writeTail?: (run: WorkflowRun, result: SchedulerResult) => void;
  repository?: string;
  altScreen?: boolean;
  theme?: string;
  verbose?: boolean;
  activity?: boolean;
  /**
   * Injected by tests: the dashboard to drive instead of mounting a real Ink tree. `runWorkspaceSession`
   * imports the real one before the loop starts, so `src/tui/` is still never loaded by a headless run.
   */
  createDashboard?: DashboardFactory;
  /**
   * Injected by tests: the provider quota readers to start when the workspace mounts (§3.6). Left out, the
   * real ones are used; a test that mounts a real tree passes a fake so that `npm test` spawns no
   * `codex app-server` and makes no call of any kind.
   */
  quota?: QuotaFactory;
}

interface Session extends WorkspaceSession {
  /** Mount the workspace on a run nobody is executing. */
  openIdle(idle: IdleRun): void;
  /** The execution that was running has finished; the workspace stays and shows the outcome. */
  executionEnded(result: SchedulerResult): void;
  /** Resolve once the operator says what happens next. */
  next(): Promise<SessionIntent>;
  /** Let the terminal go. */
  close(): Promise<void>;
  /** Another process took the lock while this session was idle (§2.1, [D36]). */
  becomeObserver(pid: number): void;
  readonly exitCode: number;
  readonly runId: string | undefined;
}

export function createWorkspaceSession(opts: WorkspaceSessionOptions & { createDashboard: DashboardFactory }): Session {
  let dashboard: DashboardController | undefined;
  let execution: ExecutionHandle | undefined;
  /** Whether a scheduler is running right now: what decides whether a Ctrl+C has anything to stop. */
  let executing = false;
  let minimised = false;
  let exitCode = 0;
  let closed = false;
  let detachPlain: (() => void) | undefined;
  let offBus: (() => void) | undefined;
  let pendingIntent: SessionIntent | undefined;
  let waiting: ((intent: SessionIntent) => void) | undefined;
  let idleRun: WorkflowRun | undefined = opts.idle?.run;
  let observer: RunObserver | undefined;
  let offObserver: (() => void) | undefined;
  /** The banner on screen, so an unchanged one does not redraw the frame on every 500 ms tick. */
  let lastBanner: string | undefined;

  const settle = (intent: SessionIntent): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(intent);
      return;
    }
    // Recorded rather than dropped: "stop and quit" is answered while the scheduler is still winding down,
    // and the loop only asks for an intention once it has stopped [D5].
    pendingIntent ??= intent;
  };

  const notify = (text: string): void => {
    if (dashboard?.isOpen) dashboard.notify(text);
    else process.stdout.write(`${text}\n`);
  };

  // ---------------------------------------------------------------- plain output (the third quit answer)
  const attachPlain = (): void => {
    if (detachPlain || !execution) return;
    detachPlain = attachPlainRenderer(execution.bus, execution.run, { verbose: opts.verbose, showActivity: opts.activity });
  };
  const detachPlainRenderer = (): void => {
    detachPlain?.();
    detachPlain = undefined;
  };

  let minimisedKeys: ((s: string, key: { name?: string; ctrl?: boolean }) => void) | undefined;
  const stopMinimisedKeys = (): void => {
    if (!minimisedKeys) return;
    process.stdin.off('keypress', minimisedKeys);
    minimisedKeys = undefined;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };
  const reopen = (): void => {
    if (!dashboard || dashboard.isOpen) return;
    stopMinimisedKeys();
    detachPlainRenderer();
    minimised = false;
    dashboard.open();
  };
  const startMinimisedKeys = (): void => {
    if (!process.stdin.isTTY || minimisedKeys) return;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    minimisedKeys = (_s, key) => {
      if (key.ctrl && key.name === 'c') interrupt();
      else if (key.name === 'd' || key.name === 'return') reopen();
      // `Q` leaves, but only once there is nothing left to stop: while the run is going the operator asked
      // for plain output precisely so it could carry on.
      else if (key.name === 'q' && !executing) settle({ kind: 'quit' });
    };
    process.stdin.on('keypress', minimisedKeys);
  };

  const minimise = (): void => {
    minimised = true;
    process.stdout.write(`\nWorkspace minimised ${glyph('dash')} the run continues. Press D to reopen, Ctrl+C to stop.\n`);
    attachPlain();
    startMinimisedKeys();
  };

  /**
   * Ctrl+C (§2.4). The first one asks the run to stop and the workspace stays open on the result; a second
   * one goes straight through to the force-kill and its exit code 130, which is the one place the old
   * second-interrupt behaviour is deliberately unchanged.
   */
  const interrupt = (): void => {
    const current = execution;
    if (current && (executing || current.interrupt.interrupted)) current.interrupt.interrupt('Ctrl+C');
    else notify('The run has ended; there is nothing to stop. Q leaves with its exit code.');
  };

  // ---------------------------------------------------------------- the workspace itself
  const dashboardOptions = (run: WorkflowRun, bus: EventBus, controller: RunController, view: WorkspaceView): DashboardOptions => ({
    run,
    bus,
    controller,
    role: view.role,
    banner: view.banner,
    badge: view.badge,
    observer: view.observer,
    onMinimise: minimise,
    onInterrupt: interrupt,
    onQuit: () => settle({ kind: 'quit' }),
    onResume: (request) => settle({ kind: 'resume', request }),
    altScreen: opts.altScreen,
    theme: opts.theme,
    // The provider quota readers (§3.6, `[D31]`). A factory: nothing starts until the Ink tree mounts, and
    // nothing at all in a headless run, which never gets this far.
    quota: opts.quota ?? ((handlers) => startQuotaMonitors({ ...handlers, cwd: run.repositoryRoot })),
  });

  const ensureDashboard = (run: WorkflowRun, bus: EventBus, controller: RunController, view: WorkspaceView): DashboardController => {
    if (dashboard) {
      dashboard.attach({ run, bus, controller });
      dashboard.setOwnership(view);
      if (!dashboard.isOpen && !minimised) dashboard.open();
      return dashboard;
    }
    dashboard = opts.createDashboard(dashboardOptions(run, bus, controller, view));
    dashboard.open();
    return dashboard;
  };

  // ---------------------------------------------------------------- observing (§2.1, [D37])
  /**
   * Follow a run another process owns.
   *
   * The poll is the only thing that moves while this is up: it re-reads `workflow.json`, `live.json` and the
   * ownership on every tick, and each tick is pushed into the same store the owner's bus fills. When the
   * ownership stops being "owned" — the other process finished, or died — the watching stops and this window
   * becomes what it was before it flipped: a workspace on a run nobody is executing, with the actions §2.4
   * gives it.
   */
  const stopObserving = (): void => {
    offObserver?.();
    offObserver = undefined;
    observer?.stop();
    observer = undefined;
    lastBanner = undefined;
  };

  const observe = (next: RunObserver): void => {
    stopObserving();
    observer = next;
    offObserver = next.onChange((view) => {
      if (observer !== next) return;
      if (view.ownership.kind === 'owned') {
        const banner = ownershipBanner(view.ownership, view.run.runId);
        if (banner !== lastBanner) {
          lastBanner = banner;
          dashboard?.setOwnership({ role: 'observer', banner, badge: ownershipBadge(view.ownership), observer: next.surface });
        }
        dashboard?.update(view.run);
        return;
      }
      // The owner let go. Nothing is executing the run now, so this window may take it: the badge goes back
      // to the owner's, the controls that crossed the boundary go away, and §2.4's actions come back.
      idleRun = view.run;
      stopObserving();
      dashboard?.update(view.run);
      dashboard?.setOwnership({ role: 'owner', badge: ownershipBadge(view.ownership) });
      notify(`The process that was executing this run has gone; nothing owns it now. ${view.ownership.kind === 'abandoned' ? 'Resume it from here.' : ''}`.trim());
    });
    next.start();
  };

  const session: Session = {
    get isOpen() {
      return dashboard?.isOpen ?? false;
    },
    get exitCode() {
      return exitCode;
    },
    get runId() {
      return execution?.run.runId ?? idleRun?.runId;
    },
    notify,
    attach(next) {
      offBus?.();
      detachPlainRenderer();
      execution = next;
      executing = true;
      idleRun = undefined;
      // This process is the owner again, so there is nothing left to watch and nothing left to send.
      stopObserving();
      ensureDashboard(next.run, next.bus, next.controller, { role: 'owner', badge: 'owner' });
      // A request for a human reopens a minimised workspace: switch the surfaces back.
      offBus = next.bus.onAny((ev) => {
        if ((ev.type === 'task.interaction.requested' || ev.type === 'task.awaiting_approval') && dashboard && !dashboard.isOpen) {
          process.stdout.write(BELL);
          reopen();
        }
      });
      if (minimised) attachPlain();
    },
    openIdle(idle) {
      idleRun = idle.run;
      lastBanner = idle.banner;
      ensureDashboard(idle.run, emptyBus(idle.run), idle.controller, {
        role: idle.role,
        banner: idle.banner,
        badge: idle.badge,
        observer: idle.observer?.surface,
      }).executionEnded();
      if (idle.observer) observe(idle.observer);
    },
    executionEnded(result) {
      executing = false;
      exitCode = result.exitCode;
      dashboard?.executionEnded();
      if (minimised) {
        process.stdout.write(`\nRun ${result.state}. Press D to open the workspace, or Q to quit (exit ${result.exitCode}).\n`);
      }
    },
    becomeObserver(pid) {
      const banner = `Another process (pid ${pid}) took this run; this window is watching. Actions are disabled until it lets go.`;
      lastBanner = banner;
      dashboard?.setOwnership({ role: 'observer', banner, badge: `observing · owner pid ${pid}` });
      notify(banner);
      // And now follow it: the banner alone is a window that has stopped telling the truth within a second.
      // The first tick replaces the sentence above with `ownershipBanner`'s and wires the controls up.
      const runId = session.runId;
      if (!runId || !opts.observe) return;
      void Promise.resolve(opts.observe(runId))
        .then((next) => {
          if (next) observe(next);
        })
        .catch(() => undefined);
    },
    requestApproval(task) {
      return dashboard ? dashboard.requestApproval(task) : Promise.resolve('defer' as const);
    },
    requestInteraction(interaction, signal) {
      return dashboard
        ? dashboard.requestInteraction(interaction, signal)
        : Promise.resolve<InteractionAnswer>({ kind: 'deny', message: 'No dashboard is attached; finish with status needs_input if you cannot continue' });
    },
    async next() {
      if (pendingIntent) {
        const intent = pendingIntent;
        pendingIntent = undefined;
        return intent;
      }
      return new Promise<SessionIntent>((resolve) => {
        waiting = resolve;
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      stopObserving();
      offBus?.();
      stopMinimisedKeys();
      detachPlainRenderer();
      await dashboard?.finish();
    },
  };
  return session;
}

/**
 * The observer the session flips to when another process takes the run (§2.1, `[D36]`, `[D37]`).
 *
 * Imported here rather than at the top of the file so a headless run never loads it: the module reaches the
 * file tailer, and §2.4's rule is that `--no-tui` pulls in nothing the workspace needs.
 */
async function defaultObserver(runId: string, opts: WorkspaceSessionOptions): Promise<RunObserver | undefined> {
  try {
    const { openStore } = await import('./util.js');
    const { createRunObserver } = await import('../workflow/control/observer.js');
    const store = await openStore(opts.first?.repository ?? opts.repository);
    return createRunObserver({ store, runId, run: await store.loadRun(runId) });
  } catch {
    // The banner is already up and says who has the run; failing to *follow* it is not worth an error on
    // top of that, and the operator can still read everything the last frame showed.
    return undefined;
  }
}

/** A bus nothing writes to, for a run this process is not executing. */
function emptyBus(run: WorkflowRun): EventBus {
  return { seq: run.eventSeq ?? 0, onAny: () => () => undefined } as unknown as EventBus;
}

/** The `startRuntime` arguments that carry out one ended-state action ([D36]); one place, so they agree. */
export function resumeRequestOptions(request: ResumeRequest): Partial<StartRuntimeOptions> {
  switch (request.kind) {
    case 'resume':
      return {};
    case 'task':
      return { task: [request.taskId] };
    case 'from':
      return { from: [request.taskId] };
    case 'answer':
      return { task: [request.taskId], input: request.text };
    case 'followUp':
      return { task: [request.taskId], followUp: { taskId: request.taskId, text: request.text, source: 'tui', freshSession: request.freshSession } };
    case 'approve':
      return { approve: [request.taskId] };
    case 'reject':
      return { reject: [request.taskId] };
  }
}

/**
 * Enter the workspace and stay in it until the operator leaves.
 *
 * The loop is the whole of §2.4: execute, show the outcome, offer the actions, and run whichever one was
 * chosen as another execution of the same run. It returns the exit code of the last execution — or 0 for a
 * session that only ever looked at a run.
 */
export async function runWorkspaceSession(opts: WorkspaceSessionOptions): Promise<number> {
  // Ink is imported here and nowhere higher: a headless run must not load the TUI, let alone the timers
  // and listeners it would create (§2.4, and the constraint the headless e2e asserts).
  const createDashboard = opts.createDashboard ?? (await import('../tui/app.js')).createDashboard;
  const session = createWorkspaceSession({ ...opts, observe: opts.observe ?? ((runId) => defaultObserver(runId, opts)), createDashboard });
  let pending: ExecuteOptions | undefined = opts.first;
  let last: { run: WorkflowRun; result: SchedulerResult } | undefined;
  if (!pending && opts.idle) session.openIdle(opts.idle);

  for (;;) {
    if (pending) {
      const target = pending;
      pending = undefined;
      const result = await opts.execute(target, session);
      last = { run: target.run, result };
      session.executionEnded(result);
    }
    const intent = await session.next();
    if (intent.kind === 'quit') break;
    const prepare = opts.prepare ?? ((request, target) => prepareResume(target, request, opts));
    try {
      pending = await prepare(intent.request, session);
    } catch (err) {
      // Every failure is a notice: the workspace is still on screen and the operator can try something
      // else. The one that changes the session is another process taking the lock (§2.1, [D36]).
      if (err instanceof RunLockedError) session.becomeObserver(err.pid);
      else session.notify(errorMessage(err));
      pending = undefined;
    }
  }

  await session.close();
  if (last && opts.writeTail) opts.writeTail(last.run, last.result);
  return session.exitCode;
}

/**
 * One ended-state action, turned into the next execution, through the same `startRuntime` `cao resume`
 * calls: the same validation, the same lock, the same reconciliation ([D36]).
 *
 * Errors leave by throwing; the loop above turns them into notices, and a `RunLockedError` into observer
 * mode. What is answered here is only what is not an error: a run there is nothing left to do to.
 */
async function prepareResume(session: WorkspaceSession & { readonly runId: string | undefined }, request: ResumeRequest, opts: WorkspaceSessionOptions): Promise<ExecuteOptions | undefined> {
  const runId = session.runId;
  if (!runId) {
    session.notify('There is no run to resume here.');
    return undefined;
  }
  const started = await startRuntime(runId, {
    repository: opts.first?.repository ?? opts.repository,
    verbose: opts.verbose,
    ...resumeRequestOptions(request),
    onNote: (note) => session.notify(note),
  });
  if (started.kind === 'nothing-to-do') {
    session.notify(started.message);
    return undefined;
  }
  session.notify(`${resumeRequestLabel(request)}…`);
  return resumeExecuteOptions(started, opts);
}

/**
 * What the resume produced, under the flags the session was entered with.
 *
 * Every choice the first execution was given that outlives it belongs here, because `executeOnce` resolves
 * each one again from scratch: an option this misses is not inherited, it is re-decided from the
 * environment and `~/.cao/config.json`. `emit` was missing, so a run started `cao run --no-emit` by someone
 * who had run `cao emit enable` announced itself the moment it was resumed from inside the workspace —
 * inverting the precedence the flag is documented to have.
 */
export function resumeExecuteOptions(started: Pick<ExecuteOptions, 'run' | 'environment' | 'secrets'>, opts: WorkspaceSessionOptions): ExecuteOptions {
  return {
    run: started.run,
    environment: started.environment,
    secrets: started.secrets,
    isResume: true,
    verbose: opts.verbose,
    activity: opts.activity,
    altScreen: opts.altScreen,
    theme: opts.theme,
    emit: opts.first?.emit,
    emitFeed: opts.first?.emitFeed,
    repository: opts.first?.repository ?? opts.repository,
    tui: true,
  };
}
