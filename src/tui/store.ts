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
 * The workspace tree reads all of this through `useStore` and writes it through the actions below; nothing
 * in `src/tui/` keeps a `useState` for something another panel has to agree about.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ResolvedTask, TaskRunState, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { EventBus } from '../events/event-bus.js';
import { systemClock, type Clock } from '../util/misc.js';

/**
 * Which screen is up. `dashboard` is the workspace shell - header, sidebar, tabs, footer - and the rest are
 * the full-screen views it opens over itself: the transcript viewer, the usage table.
 *
 * `detail`, `review` and `help` are regions of the shell now rather than screens of their own; they survive
 * in this union as the targets `selectFocusedTaskId` and the command palette still name.
 */
export type View = { kind: 'dashboard' } | { kind: 'detail'; taskId: string } | { kind: 'follow'; taskId: string; attempt?: number } | { kind: 'usage' } | { kind: 'review' } | { kind: 'help' };

/** The main panel's tabs (3.2), in the order the tab bar draws them. */
export const WORKSPACE_TABS = ['overview', 'session', 'logs', 'changes', 'report', 'diagnostics'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const TAB_LABEL: Record<WorkspaceTab, string> = {
  overview: 'Overview',
  session: 'Session',
  logs: 'Logs',
  changes: 'Changes',
  report: 'Report',
  diagnostics: 'Diagnostics',
};

/**
 * Which region has the keys. `tasks` is the sidebar list, `tabs` the tab bar and `main` the panel under it;
 * Tab and Shift+Tab move between those three. The rest are regions a full-screen view owns, and `modal` is
 * a prompt, which takes the keys from whatever had them.
 */
export type FocusRegion = 'tasks' | 'tabs' | 'main' | 'detail' | 'transcript' | 'review' | 'hunks' | 'modal';

/** The three panels Tab cycles through, in the order it visits them. */
export const FOCUS_PANELS = ['tasks', 'tabs', 'main'] as const satisfies readonly FocusRegion[];

/**
 * What is open over the shell and holds the keys: the command palette, the search field of the focused
 * list, or the contextual help. Their text lives in `drafts`, so a half-typed query survives the panel
 * being re-rendered under it.
 */
export type Overlay = { kind: 'none' } | { kind: 'palette' } | { kind: 'search' } | { kind: 'help' };

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
  tab: WorkspaceTab;
  focus: FocusRegion;
  /** Index into the snapshot's task list; clamped to it whenever a snapshot lands. */
  cursor: number;
  /**
   * The cursor of every *other* list - the palette, the report, anything a panel scrolls. The task list has
   * its own field because it is the one list whose length the store knows and can clamp to by itself; these
   * are clamped against the length the caller passes, which is the only thing that knows it this frame.
   */
  cursors: Record<string, number>;
  /** Half-typed text keyed by field: the palette query, a list's search, later a composer [D14]. */
  drafts: Record<string, string>;
  overlay: Overlay;
  notice: string | null;
  snapshot: RunSnapshot | null;

  setView(view: View): void;
  setTab(tab: WorkspaceTab): void;
  /** Move `delta` tabs along the bar, stopping at the ends. */
  moveTab(delta: number): void;
  setFocus(focus: FocusRegion): void;
  /** Move focus `delta` panels along `FOCUS_PANELS`, wrapping as Tab does. */
  moveFocus(delta: number): void;
  setCursor(cursor: number): void;
  /** Move the cursor by `delta`, stopping at the ends of the task list rather than wrapping. */
  moveCursor(delta: number): void;
  setListCursor(list: string, cursor: number, length: number): void;
  moveListCursor(list: string, delta: number, length: number): void;
  setDraft(field: string, text: string): void;
  setOverlay(overlay: Overlay): void;
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
    tab: 'overview',
    focus: 'tasks',
    cursor: 0,
    cursors: {},
    drafts: {},
    overlay: { kind: 'none' },
    notice: null,
    snapshot: null,

    setView: (view) => set({ view }),
    setTab: (tab) => set({ tab }),
    moveTab: (delta) => set({ tab: WORKSPACE_TABS[clamp(WORKSPACE_TABS.indexOf(get().tab) + delta, WORKSPACE_TABS.length - 1)]! }),
    setFocus: (focus) => set({ focus }),
    moveFocus: (delta) => {
      const panels = FOCUS_PANELS as readonly FocusRegion[];
      const at = panels.indexOf(get().focus);
      // A focus that is not one of the three panels (a modal, a viewer) counts as "before the first", so
      // the next Tab lands on the sidebar rather than nowhere.
      const next = (((at < 0 ? 0 : at + delta) % panels.length) + panels.length) % panels.length;
      set({ focus: panels[next]! });
    },
    setCursor: (cursor) => set({ cursor: clamp(cursor, Math.max(0, taskList(get().snapshot).length - 1)) }),
    moveCursor: (delta) => get().setCursor(get().cursor + delta),
    setListCursor: (list, cursor, length) => set({ cursors: { ...get().cursors, [list]: clamp(cursor, Math.max(0, length - 1)) } }),
    moveListCursor: (list, delta, length) => get().setListCursor(list, (get().cursors[list] ?? 0) + delta, length),
    setDraft: (field, text) => set({ drafts: { ...get().drafts, [field]: text } }),
    setOverlay: (overlay) => set({ overlay }),
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
export const selectTab = (s: PresentationState): WorkspaceTab => s.tab;
export const selectOverlay = (s: PresentationState): Overlay => s.overlay;
export const selectDraft =
  (field: string) =>
  (s: PresentationState): string =>
    s.drafts[field] ?? '';
export const selectListCursor =
  (list: string) =>
  (s: PresentationState): number =>
    s.cursors[list] ?? 0;
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
