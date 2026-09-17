/**
 * Presentation state for the terminal workspace (spec §2.5, [D13]).
 *
 * What the operator is looking at — which view, which pane has the keys, where the cursor is, what notice is
 * on screen — belongs to the process that draws, not to the run. This is that state, in a zustand vanilla
 * store so it can be created, read and asserted on without mounting an Ink tree, and subscribed to from the
 * tree through `useStore`.
 *
 * Run state stays where it is: the scheduler owns it, `workflow.json` persists it, and this store only ever
 * holds a **snapshot** of it — a stamped wrapper taken on the same 80 ms coalescing window the dashboard
 * already uses (`app.tsx`), so a burst of events costs one re-render rather than one per event. Nothing
 * here is authoritative and nothing here is persisted; after a resume the run is re-read, never mirrored.
 *
 * `DashboardApp` is not on this store yet — stage 1 moves it. Stage 0 only puts the store here.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ResolvedTask, TaskRunState, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { EventBus } from '../events/event-bus.js';
import { systemClock, type Clock } from '../util/misc.js';

/** Which screen is up. The same set the dashboard renders today. */
export type View = { kind: 'dashboard' } | { kind: 'detail'; taskId: string } | { kind: 'follow'; taskId: string; attempt?: number } | { kind: 'usage' } | { kind: 'review' } | { kind: 'help' };

/** Which region of the current view has the keys. A prompt takes them from whatever had them. */
export type FocusRegion = 'tasks' | 'detail' | 'transcript' | 'review' | 'hunks' | 'modal';

/** The run as the screen last saw it, stamped so a subscriber can tell one coalesced update from the next. */
export interface RunSnapshot {
  /** The bus sequence number of the last event folded into this snapshot; 0 for the snapshot taken at attach. */
  seq: number;
  /** `clock.now()` when it was taken. */
  at: number;
  run: WorkflowRun;
}

export interface PresentationState {
  view: View;
  focus: FocusRegion;
  /** Index into the snapshot's task list; clamped to it whenever a snapshot lands. */
  cursor: number;
  notice: string | null;
  snapshot: RunSnapshot | null;

  setView(view: View): void;
  setFocus(focus: FocusRegion): void;
  setCursor(cursor: number): void;
  /** Move the cursor by `delta`, stopping at the ends of the task list rather than wrapping. */
  moveCursor(delta: number): void;
  /** Show `text` for `ttlMs`, replacing any notice already up. `null` clears it now. */
  setNotice(text: string | null, ttlMs?: number): void;
  setSnapshot(snapshot: RunSnapshot): void;
}

export type PresentationStore = StoreApi<PresentationState>;

/** How long a notice stays up; the dashboard's existing timeout. */
export const NOTICE_TTL_MS = 4000;
/** The coalescing window for bus events; the dashboard's existing debounce (`app.tsx`). */
export const COALESCE_MS = 80;

const taskList = (snapshot: RunSnapshot | null): ResolvedTask[] => snapshot?.run.workflow.tasks ?? [];
const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));

export function createPresentationStore(clock: Clock = systemClock): PresentationStore {
  let noticeTimer: unknown;
  const clearNoticeTimer = (): void => {
    if (noticeTimer !== undefined) clock.clearTimeout(noticeTimer);
    noticeTimer = undefined;
  };

  return createStore<PresentationState>((set, get) => ({
    view: { kind: 'dashboard' },
    focus: 'tasks',
    cursor: 0,
    notice: null,
    snapshot: null,

    setView: (view) => set({ view }),
    setFocus: (focus) => set({ focus }),
    setCursor: (cursor) => set({ cursor: clamp(cursor, Math.max(0, taskList(get().snapshot).length - 1)) }),
    moveCursor: (delta) => get().setCursor(get().cursor + delta),
    setNotice: (text, ttlMs = NOTICE_TTL_MS) => {
      clearNoticeTimer();
      set({ notice: text });
      if (text === null) return;
      // Through the injectable clock, so a test can expire a notice without waiting four seconds.
      noticeTimer = clock.setTimeout(() => {
        noticeTimer = undefined;
        if (get().notice === text) set({ notice: null });
      }, ttlMs);
    },
    // A task list can shrink between snapshots (a resume reads a different workflow), so the cursor is
    // re-clamped here rather than left pointing past the end until the next key press.
    setSnapshot: (snapshot) => set({ snapshot, cursor: clamp(get().cursor, Math.max(0, snapshot.run.workflow.tasks.length - 1)) }),
  }));
}

/** The run state the store snapshots. `WorkflowScheduler` satisfies it; a test can pass a plain object. */
export interface StoreRunSource {
  readonly run: WorkflowRun;
}

export interface AttachedStore {
  store: PresentationStore;
  /** Stop following the bus and drop any pending coalesce timer. Safe to call twice. */
  detach: () => void;
}

/**
 * Create a store and keep its snapshot current from `bus`.
 *
 * One snapshot is taken immediately, so a tree that mounts against the store has something to draw before
 * the first event; after that, events are coalesced on `COALESCE_MS` — the trailing edge, so the snapshot a
 * subscriber sees is the state after the burst rather than somewhere inside it.
 */
export function attachStore(bus: EventBus, scheduler: StoreRunSource, clock: Clock = systemClock): AttachedStore {
  const store = createPresentationStore(clock);
  let timer: unknown;
  let detached = false;

  const commit = (): void => {
    store.getState().setSnapshot({ seq: bus.seq, at: clock.now(), run: scheduler.run });
  };
  commit();

  const off = bus.onAny(() => {
    if (detached || timer !== undefined) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (!detached) commit();
    }, COALESCE_MS);
  });

  return {
    store,
    detach: () => {
      if (detached) return;
      detached = true;
      off();
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Selectors. Kept next to the state they read so a view never reaches into the shape by hand. */
export const selectView = (s: PresentationState): View => s.view;
export const selectFocus = (s: PresentationState): FocusRegion => s.focus;
export const selectCursor = (s: PresentationState): number => s.cursor;
export const selectNotice = (s: PresentationState): string | null => s.notice;
export const selectSnapshot = (s: PresentationState): RunSnapshot | null => s.snapshot;
export const selectRun = (s: PresentationState): WorkflowRun | null => s.snapshot?.run ?? null;
export const selectTasks = (s: PresentationState): ResolvedTask[] => taskList(s.snapshot);
export const selectSelectedTask = (s: PresentationState): ResolvedTask | null => taskList(s.snapshot)[s.cursor] ?? null;
export const selectTaskState =
  (taskId: string) =>
  (s: PresentationState): TaskRunState | null =>
    s.snapshot?.run.tasks[taskId] ?? null;
/** The task the current view is about, which is the cursor on the list views and the subject on the rest. */
export const selectFocusedTaskId = (s: PresentationState): string | null => {
  const { view } = s;
  if (view.kind === 'detail' || view.kind === 'follow') return view.taskId;
  return selectSelectedTask(s)?.id ?? null;
};
