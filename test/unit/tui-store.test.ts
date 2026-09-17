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
  selectSnapshot,
  selectTaskState,
  selectTasks,
  selectView,
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

describe('attachStore', () => {
  const emit = (bus: WorkflowEventBus): void => {
    bus.emit({ type: 'task.started', taskId: 'a', attempt: 1 } as never);
  };

  it('snapshots the run once at attach, before any event has been emitted', () => {
    const clock = fakeClock();
    const bus = new WorkflowEventBus('run-1');
    const { store, detach } = attachStore(bus, { run: makeRun(['a', 'b']) }, clock);
    expect(selectSnapshot(store.getState())).toEqual({ seq: 0, at: 1000, run: expect.anything() });
    expect(selectTasks(store.getState()).map((t) => t.id)).toEqual(['a', 'b']);
    detach();
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
