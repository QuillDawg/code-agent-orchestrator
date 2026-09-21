/** The presentation store (`src/tui/store.ts`): navigation state, notices, and the coalesced run snapshot. */
import { describe, it, expect } from 'vitest';
import type { WorkflowRun } from 'code-agent-orchestrator-protocol';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import type { Clock } from '../../src/util/misc.js';
import {
  attachStore,
  createPresentationStore,
  COALESCE_MS,
  NOTICE_TTL_MS,
  selectCursor,
  selectFocusedTaskId,
  selectNotice,
  selectSelectedTask,
  selectActivity,
  selectSnapshot,
  selectTaskState,
  selectTasks,
  selectView,
  selectTab,
  selectOverlay,
  selectDraft,
  selectListCursor,
  FOCUS_PANELS,
  WORKSPACE_TABS,
} from '../../src/tui/store.js';

/** A clock whose timers only fire when the test says so, so nothing here waits on wall time. */
function fakeClock(): Clock & { tick(ms: number): void; pending: number } {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    tick(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

const task = (id: string) => ({ id, agent: 'claude', dependsOn: [], retry: {}, codex: {} });

function makeRun(ids: string[]): WorkflowRun {
  return {
    runId: 'run-1',
    workflowName: 'beta',
    repositoryRoot: '/repo',
    state: 'running',
    startedAt: '2026-09-17T09:00:00.000Z',
    workflow: { execution: { maxConcurrency: 2 }, tasks: ids.map(task) },
    tasks: Object.fromEntries(ids.map((id) => [id, { id, state: 'pending', attempts: [], retryWindowStart: 1 }])),
  } as unknown as WorkflowRun;
}

describe('presentation store', () => {
  it('starts on the dashboard with the task list focused and nothing selected beyond the first task', () => {
    const store = createPresentationStore(fakeClock());
    const state = store.getState();
    expect(selectView(state)).toEqual({ kind: 'dashboard' });
    expect(state.focus).toBe('tasks');
    expect(selectCursor(state)).toBe(0);
    expect(selectNotice(state)).toBeNull();
    expect(selectSnapshot(state)).toBeNull();
    expect(selectTasks(state)).toEqual([]);
    expect(selectSelectedTask(state)).toBeNull();
  });

  it('keeps the cursor inside the task list, in both directions', () => {
    const clock = fakeClock();
    const store = createPresentationStore(clock);
    store.getState().setSnapshot({ seq: 1, at: clock.now(), run: makeRun(['a', 'b', 'c']) });
    store.getState().moveCursor(2);
    expect(selectCursor(store.getState())).toBe(2);
    // Past the end stops at the end rather than wrapping round to the top, which would look like a jump.
    store.getState().moveCursor(5);
    expect(selectCursor(store.getState())).toBe(2);
    store.getState().moveCursor(-10);
    expect(selectCursor(store.getState())).toBe(0);
    store.getState().setCursor(1);
    expect(selectSelectedTask(store.getState())?.id).toBe('b');
  });

  it('pulls the cursor back when a later snapshot has fewer tasks', () => {
    const clock = fakeClock();
    const store = createPresentationStore(clock);
    store.getState().setSnapshot({ seq: 1, at: clock.now(), run: makeRun(['a', 'b', 'c']) });
    store.getState().setCursor(2);
    store.getState().setSnapshot({ seq: 2, at: clock.now(), run: makeRun(['a']) });
    expect(selectCursor(store.getState())).toBe(0);
    expect(selectSelectedTask(store.getState())?.id).toBe('a');
  });

  it('expires a notice on the injected clock and lets a newer one replace it', () => {
    const clock = fakeClock();
    const store = createPresentationStore(clock);
    store.getState().setNotice('Restarting build…');
    expect(selectNotice(store.getState())).toBe('Restarting build…');
    clock.tick(NOTICE_TTL_MS - 1);
    expect(selectNotice(store.getState())).toBe('Restarting build…');
    clock.tick(1);
    expect(selectNotice(store.getState())).toBeNull();

    store.getState().setNotice('first');
    store.getState().setNotice('second');
    // The first notice's timer must not clear the second one early.
    clock.tick(NOTICE_TTL_MS - 1);
    expect(selectNotice(store.getState())).toBe('second');
    store.getState().setNotice(null);
    expect(selectNotice(store.getState())).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it('reports the task a view is about: the cursor on a list, the subject on a detail or follow view', () => {
    const clock = fakeClock();
    const store = createPresentationStore(clock);
    store.getState().setSnapshot({ seq: 1, at: clock.now(), run: makeRun(['a', 'b']) });
    expect(selectFocusedTaskId(store.getState())).toBe('a');
    store.getState().setView({ kind: 'follow', taskId: 'b' });
    expect(selectFocusedTaskId(store.getState())).toBe('b');
    store.getState().setView({ kind: 'usage' });
    store.getState().setCursor(1);
    expect(selectFocusedTaskId(store.getState())).toBe('b');
    expect(selectTaskState('b')(store.getState())?.state).toBe('pending');
    expect(selectTaskState('missing')(store.getState())).toBeNull();
  });
});

describe('the workspace shell state', () => {
  it('starts on Overview with nothing open over it', () => {
    const store = createPresentationStore(fakeClock());
    expect(selectTab(store.getState())).toBe('overview');
    expect(selectOverlay(store.getState())).toEqual({ kind: 'none' });
    expect(selectDraft('palette')(store.getState())).toBe('');
    expect(selectListCursor('report')(store.getState())).toBe(0);
  });

  it('moves along the tab bar and stops at both ends rather than wrapping', () => {
    const store = createPresentationStore(fakeClock());
    store.getState().moveTab(1);
    expect(selectTab(store.getState())).toBe(WORKSPACE_TABS[1]);
    store.getState().moveTab(99);
    expect(selectTab(store.getState())).toBe(WORKSPACE_TABS[WORKSPACE_TABS.length - 1]);
    store.getState().moveTab(-99);
    expect(selectTab(store.getState())).toBe(WORKSPACE_TABS[0]);
    store.getState().setTab('changes');
    expect(selectTab(store.getState())).toBe('changes');
  });

  it('cycles focus through the panels, wrapping as Tab does', () => {
    const store = createPresentationStore(fakeClock());
    const seen: string[] = [store.getState().focus];
    for (let i = 0; i < FOCUS_PANELS.length; i += 1) {
      store.getState().moveFocus(1);
      seen.push(store.getState().focus);
    }
    // The footer is a stop from stage 3: it is where the quota chips are and `R` re-reads them (§3.6).
    expect(seen).toEqual(['tasks', 'tabs', 'main', 'footer', 'tasks']);
    store.getState().moveFocus(-1);
    expect(store.getState().focus).toBe('footer');
    // A focus a full-screen view took (a prompt, the transcript) rejoins the cycle at the first panel.
    store.getState().setFocus('modal');
    store.getState().moveFocus(1);
    expect(store.getState().focus).toBe('tasks');
  });

  it('keeps a cursor per list, each clamped to the length its own panel knows', () => {
    const store = createPresentationStore(fakeClock());
    store.getState().setListCursor('report', 400, 120);
    expect(selectListCursor('report')(store.getState())).toBe(119);
    store.getState().moveListCursor('report', -10, 120);
    expect(selectListCursor('report')(store.getState())).toBe(109);
    store.getState().moveListCursor('palette', -5, 10);
    expect(selectListCursor('palette')(store.getState())).toBe(0);
    // One list's cursor is not another's.
    expect(selectListCursor('report')(store.getState())).toBe(109);
  });

  it('holds half-typed text per field so an overlay can be re-rendered under it', () => {
    const store = createPresentationStore(fakeClock());
    store.getState().setDraft('palette', 'rest');
    store.getState().setDraft('search', 'impl');
    expect(selectDraft('palette')(store.getState())).toBe('rest');
    expect(selectDraft('search')(store.getState())).toBe('impl');
    store.getState().setOverlay({ kind: 'palette' });
    expect(selectOverlay(store.getState())).toEqual({ kind: 'palette' });
    expect(selectDraft('palette')(store.getState())).toBe('rest');
  });
});

describe('attachStore', () => {
  const emit = (bus: WorkflowEventBus): void => {
    bus.emit({ type: 'task.started', taskId: 'a', attempt: 1 } as never);
  };

  it('snapshots the run once at attach, before any event has been emitted', () => {
    const clock = fakeClock();
    const bus = new WorkflowEventBus('run-1');
    const { store, detach } = attachStore(bus, { run: makeRun(['a', 'b']) }, clock);
    // `activity` is empty at attach: nothing has produced output yet, so nothing is pulsing (§3.2).
    expect(selectSnapshot(store.getState())).toEqual({ seq: 0, at: 1000, run: expect.anything(), activity: {} });
    expect(selectTasks(store.getState()).map((t) => t.id)).toEqual(['a', 'b']);
    detach();
  });

  it('stamps when each task last produced output, for the sidebar pulse (§3.2)', () => {
    const clock = fakeClock();
    const bus = new WorkflowEventBus('run-1');
    const { store, detach } = attachStore(bus, { run: makeRun(['a', 'b']) }, clock);
    try {
      bus.emit({ type: 'task.output', taskId: 'a', attempt: 1, stream: 'stdout', line: 'building' } as never);
      clock.tick(COALESCE_MS);
      expect(selectActivity(store.getState())).toEqual({ a: 1000 });

      // A later line moves the stamp; a task that has said nothing has none, and an event that is not
      // output - a state change, a usage report - is not a task producing output and does not pulse.
      clock.tick(500);
      bus.emit({ type: 'task.transcript', taskId: 'a', attempt: 1, entry: { kind: 'system', ts: '', text: 'x' } } as never);
      bus.emit({ type: 'task.usage', taskId: 'b', attempt: 1, usage: {} } as never);
      clock.tick(COALESCE_MS);
      expect(selectActivity(store.getState())).toEqual({ a: 1580 });

      bus.emit({ type: 'task.activity', taskId: 'b', attempt: 1, line: 'npm test' } as never);
      clock.tick(COALESCE_MS);
      expect(Object.keys(selectActivity(store.getState())).sort()).toEqual(['a', 'b']);
    } finally {
      detach();
    }
  });

  it('coalesces a burst of events into one snapshot on the trailing edge of the window', () => {
    const clock = fakeClock();
    const bus = new WorkflowEventBus('run-1');
    const run = makeRun(['a']);
    const { store, detach } = attachStore(bus, { run }, clock);
    const snapshots: number[] = [];
    store.subscribe((state, previous) => {
      if (state.snapshot !== previous.snapshot) snapshots.push(state.snapshot!.seq);
    });

    for (let i = 0; i < 20; i += 1) emit(bus);
    // Still inside the window: the screen has not been asked to redraw yet.
    clock.tick(COALESCE_MS - 1);
    expect(snapshots).toEqual([]);
    clock.tick(1);
    // One redraw for the whole burst, stamped with the last event in it.
    expect(snapshots).toEqual([20]);

    emit(bus);
    clock.tick(COALESCE_MS);
    expect(snapshots).toEqual([20, 21]);
    detach();
  });

  it('takes a fresh snapshot object each time, so a subscriber sees a mutated run change', () => {
    const clock = fakeClock();
    const bus = new WorkflowEventBus('run-1');
    const run = makeRun(['a']);
    const { store, detach } = attachStore(bus, { run }, clock);
    const first = selectSnapshot(store.getState());
    // The scheduler mutates the run in place, so identity of `run` cannot be the change signal.
    run.tasks['a']!.state = 'running';
    emit(bus);
    clock.tick(COALESCE_MS);
    const second = selectSnapshot(store.getState());
    expect(second).not.toBe(first);
    expect(second!.run).toBe(run);
    expect(selectTaskState('a')(store.getState())?.state).toBe('running');
    detach();
  });

  it('stops following the bus on detach and leaves no timer behind', () => {
    const clock = fakeClock();
    const bus = new WorkflowEventBus('run-1');
    const { store, detach } = attachStore(bus, { run: makeRun(['a']) }, clock);
    emit(bus);
    expect(clock.pending).toBe(1);
    detach();
    expect(clock.pending).toBe(0);
    emit(bus);
    clock.tick(COALESCE_MS * 2);
    expect(selectSnapshot(store.getState())!.seq).toBe(0);
    // Detaching twice is what an unmount racing a run end looks like; it must not throw.
    expect(() => detach()).not.toThrow();
  });
});
