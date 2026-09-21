/**
 * The terminal workspace (spec §3.1, §3.2): the one screen a run is watched, read and driven from.
 *
 * It is a shell rather than a screen — header, sidebar, tabbed main panel, footer — and everything the old
 * dashboard showed lives in it: the task table and the task detail are the Overview tab, the review view is
 * the Changes tab, `report.md` is the Report tab, and Session, Logs and Diagnostics are the panels stages 2
 * and 3 fill. The transcript viewer and the usage table still open over the whole terminal, because both are
 * about one thing at a time and both are shared with a CLI command that has no shell around it.
 *
 * Three rules hold the whole file together:
 *
 * - **Every frame is sized to `useWindowSize()` and never taller than `rows`.** That is the condition under
 *   which Ink 7 neither wipes the scrollback nor tears on Windows (§2.5, §7.3), so each panel is given a row
 *   budget and slices itself to it rather than handing Ink a list and hoping.
 * - **Presentation state lives in the zustand store** [D13], not in this component: which tab is open, what
 *   has focus, where each cursor is, what is half-typed. The run itself is read from the store's coalesced
 *   snapshot, which is fed from the event bus by `attachStore`.
 * - **Nothing here changes the run.** A key press becomes a command submitted to the run controller (§2.2),
 *   and the controller's answer becomes the notice.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useInput, usePaste, useApp, useFocus, useFocusManager, useIsScreenReaderEnabled, useWindowSize, type Instance, type Key } from 'ink';
import { useStore } from 'zustand';
import {
  type WorkflowRun,
  type TaskRunState,
  type ResolvedTask,
  type Interaction,
  type InteractionAnswer,
  addUsage,
  type QuotaSnapshot,
  type TranscriptEntry,
} from 'code-agent-orchestrator-protocol';
import type { QuotaMonitor } from '../runners/quota.js';
import type { AgentReport } from '../runners/diagnostics.js';
import { createNativeRunPaths } from '../persistence/paths.js';
import { readControlHistory, type ControlHistory } from '../persistence/requests.js';
import { readTailPage } from '../persistence/log-pager.js';
import type { EventBus } from '../events/event-bus.js';
import type { RunController } from '../workflow/control/controller.js';
import { controlEnvelope } from '../workflow/control/commands.js';
import { editRejection, resetWorkspaceNote, restartPlanFor } from '../workflow/control/edit.js';
import { STATE_LABEL, stateGlyph } from '../workflow/states.js';
import { glyph, spinnerFrames } from '../util/glyphs.js';
import { formatDuration, formatDurationShort } from '../util/duration.js';
import { TranscriptViewer, type ViewerTask } from './viewer.js';
import { Modal, type PendingItem } from './dashboard/modal.js';
import { ReviewView, type ReviewTaskInput } from './dashboard/review.js';
import { taskFiles } from './dashboard/files.js';
import { sanitizeText } from '../cli/color.js';
import { truncateVisible } from '../cli/util.js';
import { BELL, firstLine } from '../util/misc.js';
import { bar, contextRatio, formatCost, formatTokens } from './format.js';
import { currentAttempt, elapsedCell } from './history.js';
import {
  ANSWER_DRAFT,
  attachStore,
  selectDrafts,
  setDrafts,
  createPresentationStore,
  followRun,
  selectCursor,
  selectDraft,
  selectFocus,
  selectControls,
  selectListCursor,
  selectNotice,
  selectOverlay,
  selectQuotas,
  selectSnapshot,
  selectTab,
  selectView,
  TAB_LABEL,
  WORKSPACE_TABS,
  type AttachedStore,
  type FocusRegion,
  type PresentationStore,
  type WorkspaceTab,
} from './store.js';
import { reducedMotion, resolveTheme, type Theme } from './theme.js';
import { windowOf } from './window.js';
import { workspaceRenderOptions } from './render-options.js';
import { armAltScreenRestore } from './terminal.js';
import type { ResumeRequest } from '../workflow/resume-request.js';
import { anyActive, Footer, Header, headerRowsFor, Sidebar, TabBar, TaskStrip, waitingTasks, type WorkspaceRole } from './workspace/chrome.js';
import { workspaceLayout } from './workspace/layout.js';
import { alwaysHintCells, footerHints, QUIT_ANSWERS, type KeyMode } from './workspace/keys.js';
import { Overview } from './workspace/overview.js';
import { AnswerField, filterPalette, HelpPanel, Palette, Placeholder, QuitPrompt, ReportPanel, type PaletteEntry } from './workspace/panels.js';
import { DiagnosticsPanel, parseRetryEvents, type RetryRecord } from './workspace/diagnostics.js';
import { LogsPanel, useLogs } from './workspace/logs.js';
import { EDIT_CURSOR, EDIT_ROWS, EditForm, editDraftKey, initialDrafts, SAVE_ROW, validateDraft } from './workspace/edit.js';
import { editPromptExternally } from './workspace/prompt-editor.js';
import { SessionPanel, composerDraftKey } from './workspace/session.js';
import { promptRow } from '../workflow/control/prompt.js';
import {
  backspace,
  composerFromText,
  composerText,
  deleteForward,
  deleteWordLeft,
  insertNewline,
  insertPaste,
  insertText,
  isEmpty,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  replaceAll,
  undo,
  wordLeft,
  wordRight,
  type ComposerState,
} from './composer.js';
import { endedActionFor, endedActions } from './workspace/ended.js';
import { leadTaskId } from './workspace/detail.js';
import { answerElsewhere, observerActionFor, observerActions, pendingLines, type ObserverAction } from './workspace/observer.js';
import type { ObserverSurface } from '../workflow/control/observer.js';

export interface DashboardOptions {
  run: WorkflowRun;
  bus: EventBus;
  /**
   * Everything the workspace reads from the run, and the only way it changes anything (spec §2.2). It never
   * holds the scheduler: a key press is a command like any other, submitted and answered.
   */
  controller: RunController;
  /** Q pressed: the controller unmounts; the caller switches to line output until reopen. */
  onMinimise: () => void;
  onInterrupt: () => void;
  /** Mounts the Ink tree; defaults to ink's render. Injected by tests so the queue can be driven without a TTY. */
  mount?: typeof render;
  /** `--no-alt-screen` gives `false`; undefined lets `CAO_ALT_SCREEN` and `~/.cao/config.json` decide [D4]. */
  altScreen?: boolean;
  /** `--theme <name>`; `CAO_THEME` and `NO_COLOR` are read when this is absent [D35]. */
  theme?: string;
  /** Whether this process holds the run or is watching one another process owns (§2.1). */
  role?: WorkspaceRole;
  /** The observer banner, naming the process that owns the run (§2.1, [D37]). */
  banner?: string;
  /** What the header badge says: `owner`, `observing · owner pid N`, `abandoned · resume?` (§2.1). */
  badge?: string;
  /**
   * How a run another process owns is driven (§2.1, §2.3, [D37]): stop, kill and restart as requests in
   * `requests/`, and the tokens that run advertises. Absent for a run this process owns, which is what
   * takes the observer's keys off the screen rather than leaving them there to be refused.
   */
  observer?: ObserverSurface;
  /**
   * Leave the workspace. Given by the session that owns the Ink tree: on an ended run `Q` calls it at once,
   * and "stop and quit" calls it alongside `onInterrupt` so the session leaves when the stop has landed
   * [D5]. Without it `Q` falls back to minimising, which is what the workspace did before §2.4.
   */
  onQuit?: () => void;
  /** Start another execution of this run (§2.4, [D36]); absent, and in observer mode, the actions are off. */
  onResume?: (request: ResumeRequest) => void;
  /**
   * Starts the provider quota readers when this tree mounts, and is stopped when it unmounts (§3.6,
   * `[D31]`).
   *
   * A factory rather than a started monitor, and optional, because the two together are what keeps the
   * quota process out of everywhere it does not belong: a headless command never builds one, and a tree
   * mounted in a test spawns nothing unless the test hands it something to spawn. `createWorkspaceSession`
   * fills it in for the real workspace.
   */
  quota?: QuotaFactory;
  /**
   * The run's preflight facts, for the Diagnostics panel (§3.7): which CLI is behind each agent, which
   * version it is and which transport its tasks take.
   *
   * A function, and called only when the tab is opened, for the same reason `quota` is a factory: reading it
   * runs `claude --version` and `codex --version`, and a workspace that never opens Diagnostics should spawn
   * neither. Absent, the panel says the facts were not recorded.
   */
  preflight?: () => Promise<AgentReport[]>;
  /**
   * The tab to open on, once, when this tree first mounts. `--debug` asks for Diagnostics [D34].
   *
   * Once: the store outlives an execution (§2.4), so a resume from inside the workspace must not drag the
   * operator back to the tab the command line asked for twenty minutes ago.
   */
  initialTab?: WorkspaceTab;
}

/** What `DashboardOptions.quota` is: given somewhere to publish snapshots, it returns the running readers. */
export type QuotaFactory = (handlers: { onSnapshot: (snapshot: QuotaSnapshot) => void }) => QuotaMonitor;

/** Who owns the run this workspace is showing, and what that lets it do (§2.1, [D37]). */
export interface WorkspaceView {
  role: WorkspaceRole;
  /** The sentence naming the owning process, or nothing when this window is the owner. */
  banner?: string;
  /** The header badge; `ownershipBadge` writes it. */
  badge?: string;
  /** Present only in observer mode: stop, kill and restart through the inbox (§2.3). */
  observer?: ObserverSurface;
}

export interface DashboardController {
  /** Mount the workspace (no-op when already open). */
  open(): void;
  /** Unmount it, leaving the run going. */
  close(): void;
  readonly isOpen: boolean;
  requestApproval(task: ResolvedTask): Promise<{ decision: 'approved' | 'rejected'; note?: string } | 'defer'>;
  requestInteraction(interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer>;
  /**
   * Point the workspace at a new execution of the run (§2.4): a new scheduler, a new bus, the **same**
   * presentation store — so the tab, the cursor and a half-typed search survive a resume.
   */
  attach(source: { run: WorkflowRun; bus: EventBus; controller: RunController }): void;
  /** That execution ended: settle what the modal still holds and draw the ended state. Stays mounted. */
  executionEnded(): void;
  /**
   * Who is driving this run, and everything that follows from it (§2.1): the badge, the banner and — when
   * another process owns it — the surface the observer's controls are sent through.
   *
   * One call rather than four setters because the four are one fact. A window that showed `observing` with
   * no surface behind it would offer keys nothing could answer, and one that kept a surface after taking
   * the run would send a request to itself.
   */
  setOwnership(view: WorkspaceView): void;
  /**
   * A file-backed view of the run moved on (§2.1, [D37]): take a snapshot of `run` and redraw.
   *
   * The owner's workspace is fed by the event bus through `followRun`; an observer has no bus to subscribe
   * to, because the events it would carry are happening in another process. This is the same store, filled
   * from the poll tick instead, so every panel renders from the shape it already renders from.
   */
  update(run: WorkflowRun): void;
  /**
   * Put a line in front of the operator that would otherwise have gone to stdout: a rejected action, a
   * resume that could not start, a note from `startRuntime`. The workspace has the screen, so there is
   * nowhere else for it to go (§2.4, "operational errors are notices inside the workspace").
   */
  notify(text: string): void;
  /** The workspace is going away: settle what is queued, show the final frame, then unmount. */
  finish(): Promise<void>;
}

/**
 * The Shift+Tab some Windows terminals send. Ink parses `\x1b[Z` and moves focus itself; `\x1bOZ` reaches
 * `useInput` with no name at all and its escape prefix stripped, which leaves exactly these two characters
 * (§3.2, [D40]). No key produces them any other way — a typed `O` and `Z` arrive as two separate reads.
 */
const SHIFT_TAB_SS3 = 'OZ';

/** What Ctrl+J is by the time `useInput` sees it: a line feed, named `enter`, with no `ctrl` flag (§3.2). */
const LINE_FEED = '\n';

/**
 * How much transcript the Session panel asks the buffer for.
 *
 * A bound, not a row count: the panel renders far fewer than this, and the renderer wraps, so it asks for
 * enough entries to fill a tall terminal and slices what it drew. `F` is still the way to read all of it.
 */
const SESSION_TRANSCRIPT_LINES = 60;

function taskUsage(st: TaskRunState) {
  return addUsage(...st.attempts.map((a) => a.usage));
}

export interface DashboardShared {
  queue: PendingItem[];
  listeners: Set<() => void>;
  notify(): void;
  /** Drop one queued item by id (answered here, or withdrawn by the scheduler); true when it was still queued. */
  remove(id: string): boolean;
}
type Shared = DashboardShared;

export interface AppProps extends DashboardOptions {
  shared: Shared;
  finished: boolean;
  /** The store the tree reads. `createDashboard` attaches one to the bus; a test may mount without it. */
  store?: PresentationStore;
}

/** The workspace component; exported for rendering in tests. */
export function DashboardApp(props: AppProps): React.JSX.Element {
  const { bus, controller, onMinimise, onInterrupt } = props;
  const { exit } = useApp();
  // `useWindowSize()`, not `useStdout()`: it subscribes to the terminal's `resize` and re-renders on it.
  // Reading `stdout.columns` during render only picks a new size up when something else happens to
  // re-render, which is the spinner tick — so the layout and every row budget below stayed a second behind
  // a resize (§2.5).
  const { rows, columns } = useWindowSize();
  const screenReader = useIsScreenReaderEnabled();
  const theme = useMemo(() => resolveTheme({ theme: props.theme }), [props.theme]);
  const motion = useMemo(() => !reducedMotion() && !screenReader, [screenReader]);

  // The run object the scheduler mutates is stable, so a ref keeps the snapshot source honest without
  // re-attaching the store on every render.
  const runRef = useRef(props.run);
  runRef.current = props.run;
  const [attached] = useState<AttachedStore>(() =>
    props.store ? { store: props.store, detach: () => undefined } : attachStore(bus, { get run() { return runRef.current; } }),
  );
  const store = attached.store;
  useEffect(() => () => attached.detach(), [attached]);

  const snapshot = useStore(store, selectSnapshot);
  const view = useStore(store, selectView);
  const tab = useStore(store, selectTab);
  const storedFocus = useStore(store, selectFocus);
  const cursor = useStore(store, selectCursor);
  const notice = useStore(store, selectNotice);
  const overlay = useStore(store, selectOverlay);
  const paletteQuery = useStore(store, selectDraft('palette'));
  const search = useStore(store, selectDraft('search'));
  const paletteCursor = useStore(store, selectListCursor('palette'));
  const reportCursor = useStore(store, selectListCursor('report'));
  const helpCursor = useStore(store, selectListCursor('help'));
  const quitCursor = useStore(store, selectListCursor('quit'));
  const answerDraft = useStore(store, selectDraft(ANSWER_DRAFT));
  const drafts = useStore(store, selectDrafts);
  const editCursor = useStore(store, selectListCursor(EDIT_CURSOR));
  const controls = useStore(store, selectControls);
  const quotas = useStore(store, selectQuotas);
  const logsSearch = useStore(store, selectDraft('logs-search'));
  const diagnosticsCursor = useStore(store, selectListCursor('diagnostics'));

  const [, setTick] = useState(0);
  const [pending, setPending] = useState<PendingItem | null>(props.shared.queue[0] ?? null);
  const [usageSort, setUsageSort] = useState<'order' | 'cost'>('order');
  const [pastAttempt, setPastAttempt] = useState<{ taskId: string; attempt: number; entries: TranscriptEntry[] } | null>(null);
  const [report, setReport] = useState<string | null | undefined>(undefined);
  /**
   * What the Diagnostics panel reads off disk (§3.7): the preflight facts, the `task.retrying` events of the
   * run log, and the request inbox. All three are read when the tab is opened and never before — the panel
   * is read-only, so re-reading it costs nothing that has to be undone.
   */
  const [diagnostics, setDiagnostics] = useState<{ agents?: AgentReport[]; retries?: RetryRecord[]; inbox?: ControlHistory }>({});
  /** Bumped by `R` in the Diagnostics panel; the reader below runs again for it. */
  const [diagnosticsRead, setDiagnosticsRead] = useState(0);
  /**
   * The composer, when one is open (§3.5, `[D14]`).
   *
   * Held here rather than in the store because its cursor and undo stack are not something another panel
   * has to agree about, and mirroring a hundred undo snapshots through a zustand set on every keystroke
   * costs a re-render of the whole shell per character. The **text** is mirrored into the store's drafts,
   * which is the part the spec asks to survive — a draft is kept per task and lost only on quit.
   */
  const [composer, setComposer] = useState<{ taskId: string; state: ComposerState; freshSession?: boolean } | null>(null);
  const [sendingNote, setSendingNote] = useState<string | undefined>(undefined);
  const frame = useRef(0);
  const entriesCache = useRef<{ taskId: string; value: TranscriptEntry[] } | undefined>(undefined);

  const run = snapshot?.run ?? props.run;
  const tasks = run.workflow.tasks;
  const searching = overlay.kind === 'search' || search !== '';
  // The list every task cursor indexes: `/` narrows it, so the cursor is reset when the query changes.
  const visible = useMemo(() => (searching && search ? filterTasks(tasks, search) : tasks), [tasks, search, searching]);
  const selected = visible[Math.min(cursor, Math.max(0, visible.length - 1))];
  const now = Date.now();
  const active = anyActive(run);

  // ------------------------------------------------------------------ focus (Tab / Shift+Tab)
  useFocus({ id: 'tasks', autoFocus: true });
  useFocus({ id: 'tabs' });
  useFocus({ id: 'main' });
  // The footer is a focus stop from stage 3: it is where the provider quota chips are, and §3.6 gives them
  // a key of their own. `useFocus` is registered in the order Tab visits, so it is last.
  useFocus({ id: 'footer' });
  const { activeId, focus: focusPanel, focusPrevious, enableFocus, disableFocus } = useFocusManager();
  const focus: FocusRegion = activeId === 'tabs' ? 'tabs' : activeId === 'main' ? 'main' : activeId === 'footer' ? 'footer' : 'tasks';
  const overlayOpen = overlay.kind !== 'none';
  /**
   * The composer holds the keys exactly as an overlay does (§3.2, `[D15]`), even though it is part of a
   * panel rather than drawn over one: inside it Tab is text and Esc closes it.
   *
   * It has to be taken out of Ink's focus manager for both of those to be true. Ink answers Tab itself, and
   * it clears the active focus on **Esc** — so without this the Esc that closes the composer also dropped
   * the workspace back to the task list, and the panel the operator was in was gone when it reopened.
   */
  const composerHasFocus = Boolean(composer) && tab === 'session' && !overlayOpen;
  const keysTaken = overlayOpen || composerHasFocus;
  // Ink's focus manager answers Tab itself, including inside a text field; while one is open the panels are
  // taken out of the cycle so a Tab in the palette cannot silently move the focus behind it.
  useEffect(() => {
    if (keysTaken) disableFocus();
    else enableFocus();
  }, [keysTaken, enableFocus, disableFocus]);
  const lastPanel = useRef<string>('tasks');
  useEffect(() => {
    if (keysTaken) return;
    if (activeId) lastPanel.current = activeId;
    if (storedFocus !== focus) store.getState().setFocus(focus);
  }, [activeId, focus, keysTaken, storedFocus, store]);
  useEffect(() => {
    if (!keysTaken) focusPanel(lastPanel.current);
  }, [keysTaken, focusPanel]);

  // ------------------------------------------------------------------ quotas (§3.6, [D31])
  /**
   * The readers, for as long as this tree is on screen.
   *
   * Started here rather than by the session because "the workspace is mounted" is exactly the condition
   * §3.6 attaches them to: a minimised workspace has no footer to fill, and an unmounted one must leave no
   * `codex app-server` behind. The cleanup is the kill.
   */
  // `--debug` opens on Diagnostics [D34]. Applied on mount and never again; see `initialTab`.
  const initialTab = props.initialTab;
  const openedOn = useRef(false);
  useEffect(() => {
    if (openedOn.current || !initialTab) return;
    openedOn.current = true;
    store.getState().setTab(initialTab);
  }, [initialTab, store]);

  const quotaMonitor = useRef<QuotaMonitor | null>(null);
  const startQuota = props.quota;
  useEffect(() => {
    if (!startQuota) return;
    const monitor = startQuota({ onSnapshot: (snapshot) => store.getState().setQuota(snapshot) });
    quotaMonitor.current = monitor;
    return () => {
      quotaMonitor.current = null;
      monitor.stop();
    };
  }, [startQuota, store]);

  const refreshQuotas = (): void => {
    const monitor = quotaMonitor.current;
    if (!monitor) {
      store.getState().setNotice('This window is not reading any provider quotas.');
      return;
    }
    monitor.refresh();
    store.getState().setNotice(`Reading the provider quotas again${glyph('ellipsis')}`);
  };

  // ------------------------------------------------------------------ layout
  // Computed here rather than beside the frame it sizes: the Logs pager below needs to know how many rows
  // its window has before it can decide when the page above is worth fetching.
  const headerRows = headerRowsFor(run);
  const layout = workspaceLayout({ columns, rows, headerRows, notice: Boolean(notice) });

  // ------------------------------------------------------------------ the Logs tab (§3.7)
  const paths = useMemo(() => createNativeRunPaths(run.repositoryRoot), [run.repositoryRoot]);
  const logs = useLogs({
    run,
    paths,
    width: layout.mainWidth,
    // The panel spends a row on its title, one on the filter line and one on the status line.
    height: Math.max(1, layout.mainRows - 3 - (logsSearch ? 1 : 0)),
    color: theme.color,
    search: logsSearch,
    // Nothing is read while the tab is shut, which is what keeps a workspace that never opens it from
    // touching the run directory at all.
    active: tab === 'logs',
  });

  // ------------------------------------------------------------------ effects
  useEffect(() => {
    const onQueue = (): void => setPending(props.shared.queue[0] ?? null);
    props.shared.listeners.add(onQueue);
    onQueue();
    return () => {
      props.shared.listeners.delete(onQueue);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus]);

  // One timer, whether or not it animates: the elapsed columns and the freshness chip still have to move.
  useEffect(() => {
    const timer = setInterval(() => {
      if (motion) frame.current += 1;
      setTick((t) => t + 1);
    }, motion && active ? 120 : 1000);
    return () => clearInterval(timer);
  }, [active, motion]);

  // There is deliberately no "the run finished, so leave" effect here. Until §2.4 the workspace called
  // `exit()` 50 ms after `finished` turned true, which is the whole reason a failed run could not be read:
  // the screen with the failure on it was the screen that disappeared. The workspace now stays and offers
  // the actions below; the session that mounted it decides when the process leaves.

  // An earlier attempt selected with [ / ] in the follow view: its transcript only exists on disk, because
  // the live buffer is bounded and shared by every attempt of the task. Undefined means "follow the worker".
  const pastTaskId = view.kind === 'follow' ? view.taskId : undefined;
  const pastAttemptNumber = view.kind === 'follow' ? view.attempt : undefined;
  useEffect(() => {
    if (pastTaskId === undefined || pastAttemptNumber === undefined) {
      setPastAttempt(null);
      return undefined;
    }
    let cancelled = false;
    const done = (entries: TranscriptEntry[]): void => {
      if (!cancelled) setPastAttempt({ taskId: pastTaskId, attempt: pastAttemptNumber, entries });
    };
    void controller
      .attemptTranscript(pastTaskId, pastAttemptNumber)
      .then(done)
      .catch(() => done([]));
    return () => {
      cancelled = true;
    };
  }, [pastTaskId, pastAttemptNumber, controller]);

  // `report.md` exists once the run has ended; re-read when it does, so the tab is not stuck on "not yet".
  useEffect(() => {
    if (tab !== 'report') return undefined;
    let cancelled = false;
    setReport(null);
    void Promise.resolve(controller.readReport())
      .then((markdown) => {
        if (!cancelled) setReport(markdown ?? undefined);
      })
      .catch(() => {
        if (!cancelled) setReport(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, controller, props.finished]);

  /**
   * What the Diagnostics tab reads (§3.7). Re-read whenever it is opened and whenever the execution ends,
   * because all three answers move while a run is going and none of them is on the event bus.
   */
  const preflight = props.preflight;
  useEffect(() => {
    if (tab !== 'diagnostics') return undefined;
    let cancelled = false;
    const runId = run.runId;
    void Promise.resolve(preflight?.() ?? undefined)
      .then((agents) => {
        if (!cancelled) setDiagnostics((current) => ({ ...current, agents: agents ?? [] }));
      })
      .catch(() => {
        if (!cancelled) setDiagnostics((current) => ({ ...current, agents: [] }));
      });
    // The tail of the run log, not the whole of it: the retry history an operator is looking for is the
    // recent one, and `events.jsonl` grows with the run.
    void readTailPage(paths.eventsFile(runId), 2000)
      .then((page) => {
        if (!cancelled) setDiagnostics((current) => ({ ...current, retries: parseRetryEvents(page.lines) }));
      })
      .catch(() => {
        if (!cancelled) setDiagnostics((current) => ({ ...current, retries: [] }));
      });
    void readControlHistory(paths, runId)
      .then((inbox) => {
        if (!cancelled) setDiagnostics((current) => ({ ...current, inbox }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, paths, run.runId, preflight, props.finished, diagnosticsRead]);

  // ------------------------------------------------------------------ who is driving (§2.1, [D37])
  // Read before the actions below, because every one of them asks it first: an observer has no lock to
  // take and no scheduler to submit to, and a control it sends is a request file rather than a call.
  const canResume = Boolean(props.onResume) && (props.role ?? 'owner') === 'owner';
  const observing = (props.role ?? 'owner') === 'observer' && Boolean(props.observer);

  // ------------------------------------------------------------------ actions
  const setNotice = (text: string) => store.getState().setNotice(text);
  // Stable, so the review view's own per-attempt cache is not thrown away on every spinner frame.
  const loadDiff = useMemo(() => (taskId: string) => controller.capturedDiff(taskId), [controller]);
  /**
   * One control this window sent, in the Diagnostics history and in the notice (§2.2, §2.3).
   *
   * Both halves of the workspace record here, the owner's in-process commands and the observer's requests,
   * because the question they answer is the same one — "what did I ask this run to do, and what came back" —
   * and a notice that is gone in four seconds is not an answer to it.
   */
  const recordControl = (id: string, label: string): void => store.getState().recordControl({ id, label });
  const settleControl = (id: string, label: string, status: 'accepted' | 'applied' | 'rejected' | 'timeout', reason?: string): void => {
    store.getState().settleControl(id, status, reason);
    setNotice(`${label} sent ${glyph('arrow')} ${status}${reason ? `: ${reason}` : ''}`);
  };

  /**
   * A control sent to the process that owns the run (§2.3, [D37]). It is a file, not a call: nothing here
   * changes the run, the owner reads the request on its own tick and its answer comes back as an ack.
   *
   * The id is this window's own, not the request's: it keys the history row, and the row exists from the
   * moment the operator presses the key rather than from the moment the file lands.
   */
  const sendControl = (action: ObserverAction): void => {
    const surface = props.observer;
    if (!surface) return;
    const id = controlEnvelope('tui').id;
    const label = `${action.kind}${action.taskId ? ` ${action.taskId}` : ''}`;
    recordControl(id, label);
    setNotice(`${label} sent to pid ${surface.ownerPid ?? '?'}${glyph('ellipsis')}`);
    void surface
      .send({ kind: action.kind, taskId: action.taskId })
      .then((outcome) => settleControl(id, label, outcome.status, outcome.reason))
      .catch((err: unknown) => settleControl(id, label, 'rejected', (err as Error).message));
  };

  const restart = (task: ResolvedTask | undefined): void => {
    if (!task) return;
    // Nothing a window that does not own the run may reach the controller with (§2.1, [D37]). `R` is the
    // observer's re-run request when the selected task can take one, and this is every other case: the
    // controller here is a read-only view of the run directory, and submitting to it is not a control.
    if (observing) {
      setNotice(`This window is watching ${props.observer?.ownerPid !== undefined ? `pid ${props.observer.ownerPid}` : 'another process'}. A re-run can only be asked for on a task that has failed, been blocked, cancelled or skipped.`);
      return;
    }
    // The controller decides, not the screen: it holds the run state this frame is only a picture of, and
    // its rejection is already a sentence written for this notice.
    const attempts = run.tasks[task.id]?.attempts;
    const expected = attempts?.[attempts.length - 1]?.number;
    const envelope = controlEnvelope('tui', expected ? { attempt: expected } : undefined);
    recordControl(envelope.id, `restart ${task.id}`);
    void controller
      .submit({ kind: 'restart', taskId: task.id }, envelope)
      .then((ack) => {
        store.getState().settleControl(envelope.id, ack.status, ack.reason);
        setNotice(ack.status === 'rejected' ? (ack.reason ?? `"${task.id}" cannot be restarted.`) : `Restarting ${task.id}${glyph('ellipsis')}`);
      })
      .catch((err: unknown) => {
        store.getState().settleControl(envelope.id, 'rejected', (err as Error).message);
        setNotice(`Could not restart ${task.id}: ${(err as Error).message}`);
      });
  };
  /**
   * Open the task editor over the selected task (§3.4).
   *
   * The refusal is the controller's own sentence, asked for here rather than after a form has been filled
   * in: a succeeded task has nothing to edit, and finding that out on Save is finding it out too late.
   * A running task is not refused — the form is where the operator says "yes, stop it" — so `restart: true`
   * is what is asked of `editRejection`.
   */
  const openEdit = (task: ResolvedTask | undefined): void => {
    if (!task) return;
    if (observing) {
      setNotice(`This window is watching ${props.observer?.ownerPid !== undefined ? `pid ${props.observer.ownerPid}` : 'another process'}; edit the task in the terminal that owns the run, or with "cao task edit ${task.id}".`);
      return;
    }
    if (props.finished) {
      // The controller outlives the scheduler but refuses every command once the run has ended (§2.2), so
      // the form would fill in and then be turned away. The offline path is the one that works here.
      setNotice(`Run ${run.runId} has ended, so nothing is executing "${task.id}". Edit it with "cao task edit ${task.id}", then resume the run.`);
      return;
    }
    const state = run.tasks[task.id];
    const refusal = state ? editRejection(task, state, true) : undefined;
    if (refusal) {
      setNotice(refusal);
      return;
    }
    setDrafts(store, initialDrafts(task));
    store.getState().setListCursor(EDIT_CURSOR, 0, EDIT_ROWS.length + 1);
    store.getState().setOverlay({ kind: 'edit', taskId: task.id });
  };

  // ------------------------------------------------------------------ the composer (§3.5)

  /** The mode a message to this task would use right now — the same table the scheduler decides with. */
  const promptModeFor = (taskId: string) => promptRow(run.tasks[taskId]!, !observing && !props.finished && controller.steerable(taskId));

  /** Put the composer's text where a re-render, a tab change and a resume can all find it again. */
  const saveComposerDraft = (taskId: string, state: ComposerState): void => {
    store.getState().setDraft(composerDraftKey(taskId), composerText(state));
  };

  const editComposer = (fn: (state: ComposerState) => ComposerState): void => {
    setComposer((current) => {
      if (!current) return current;
      const next = fn(current.state);
      saveComposerDraft(current.taskId, next);
      return { ...current, state: next };
    });
  };

  /**
   * Ctrl+F: "Start a fresh session", the explicit half of `[D25]`.
   *
   * A follow-up and a stop-and-continue both resume the session the task last reported, and a session that
   * has been deleted is refused rather than silently swapped for a new one. This is the control that
   * refusal names - and the one an operator who *wants* to start over reaches for before typing anything.
   * It is off again with the next Ctrl+F and whenever the composer is closed, so "start from the top" is
   * never something a draft carries into a message that did not ask for it.
   */
  const toggleFreshSession = (): void => {
    setComposer((current) => (current ? { ...current, freshSession: !current.freshSession } : current));
  };

  /**
   * Open the composer over the Session panel, refusing where the matrix has nothing to offer (§3.5).
   *
   * The refusal is asked for here rather than after a message has been typed: a succeeded task is
   * immutable `[D27]`, and finding that out on Enter is finding it out after the work of writing it.
   */
  const openComposer = (task: ResolvedTask | undefined): void => {
    if (!task) return;
    const state = run.tasks[task.id];
    if (!state) return;
    const row = promptModeFor(task.id);
    if (!row.mode) {
      setNotice(row.reason ?? `There is nothing to send "${task.id}".`);
      return;
    }
    setSendingNote(undefined);
    setComposer({ taskId: task.id, state: composerFromText(store.getState().drafts[composerDraftKey(task.id)] ?? '') });
  };

  const closeComposer = (): void => {
    setComposer((current) => {
      if (current) saveComposerDraft(current.taskId, current.state);
      return null;
    });
  };

  /**
   * Send what the composer holds (§3.5).
   *
   * On a live run this is one controller command and its ack is the answer. On an ended one there is no
   * scheduler to take it, so a follow-up becomes the resume that carries it — the same `startRuntime` path
   * every other ended-state action uses (§2.4, `[D36]`), and the only way a message reaches a run that has
   * already let go of its lock.
   */
  const submitPrompt = (taskId: string, text: string, freshSession = false): void => {
    const state = run.tasks[taskId];
    if (!state) return;
    if (observing) {
      setNotice(`This window is watching ${props.observer?.ownerPid !== undefined ? `pid ${props.observer.ownerPid}` : 'another process'}; send the message from the terminal that owns the run, or with "cao task prompt ${taskId} --message ...".`);
      return;
    }
    const row = promptModeFor(taskId);
    if (!row.mode) {
      setNotice(row.reason ?? `There is nothing to send "${taskId}".`);
      return;
    }
    if (props.finished || controller.ended) {
      if (row.mode !== 'followUp' || !canResume) {
        setNotice(`Run ${run.runId} has ended, so nothing is executing "${taskId}". Send the message with "cao task prompt ${taskId} --message ...", which resumes the run to carry it.`);
        return;
      }
      store.getState().setDraft(composerDraftKey(taskId), '');
      setComposer(null);
      resume({ kind: 'followUp', taskId, text, freshSession });
      return;
    }
    const envelope = controlEnvelope('tui', { attempt: state.attempts[state.attempts.length - 1]?.number ?? 0 });
    recordControl(envelope.id, `prompt ${taskId}`);
    setSendingNote(`sending${glyph('ellipsis')}`);
    void controller
      .submit({ kind: 'prompt', taskId, text, mode: row.mode, ...(freshSession ? { freshSession: true } : {}) }, envelope)
      .then((ack) => {
        store.getState().settleControl(envelope.id, ack.status, ack.reason);
        setSendingNote(ack.reason ?? ack.status);
        setNotice(ack.reason ?? (ack.status === 'rejected' ? `"${taskId}" did not take the message.` : `Sent to "${taskId}".`));
        // The draft is only cleared once the run has taken it: a rejection an operator has to act on must
        // not also cost them what they wrote.
        if (ack.status !== 'rejected') {
          store.getState().setDraft(composerDraftKey(taskId), '');
          setComposer((current) => (current?.taskId === taskId ? { taskId, state: composerFromText('') } : current));
        }
      })
      .catch((err: unknown) => {
        store.getState().settleControl(envelope.id, 'rejected', (err as Error).message);
        setSendingNote(undefined);
        setNotice(`Could not send to ${taskId}: ${(err as Error).message}`);
      });
  };

  /** Ctrl+O in the composer: the draft in `$VISUAL`/`$EDITOR`, the same handover the task editor uses. */
  const composeInEditor = (): void => {
    const current = composer;
    if (!current) return;
    void editPromptExternally(composerText(current.state)).then((result) => {
      if (result.text !== undefined) editComposer((state) => replaceAll(state, result.text!));
      setNotice(result.notice);
    });
  };

  /** Send the form's edit to the controller and let its ack be the answer, exactly as `restart` does. */
  const submitEdit = (taskId: string, restartNow: boolean): void => {
    const task = tasks.find((t) => t.id === taskId);
    const state = run.tasks[taskId];
    if (!task || !state) return;
    const { edit, fields } = validateDraft(run.workflow, task, store.getState().drafts);
    if (fields.length === 0) {
      setNotice(`Nothing to change on "${taskId}".`);
      return;
    }
    closeOverlay();
    const attempts = state.attempts;
    const expected = attempts[attempts.length - 1]?.number;
    const envelope = controlEnvelope('tui', expected ? { attempt: expected } : undefined);
    recordControl(envelope.id, `edit ${taskId}`);
    void controller
      .submit({ kind: 'edit', taskId, changes: edit, restart: restartNow }, envelope)
      .then((ack) => {
        store.getState().settleControl(envelope.id, ack.status, ack.reason);
        setNotice(ack.reason ?? (ack.status === 'rejected' ? `"${taskId}" could not be edited.` : `Edited "${taskId}".`));
      })
      .catch((err: unknown) => {
        store.getState().settleControl(envelope.id, 'rejected', (err as Error).message);
        setNotice(`Could not edit ${taskId}: ${(err as Error).message}`);
      });
  };

  /** `Ctrl+O` on the prompt row: hand the terminal to `$EDITOR` and take what it wrote back (§3.4). */
  const editPromptInEditor = (taskId: string): void => {
    const current = store.getState().drafts[editDraftKey('prompt')] ?? tasks.find((t) => t.id === taskId)?.prompt ?? '';
    void editPromptExternally(current).then((result) => {
      if (result.text !== undefined) store.getState().setDraft(editDraftKey('prompt'), result.text);
      setNotice(result.notice);
    });
  };

  const follow = (task: ResolvedTask | undefined): void => {
    if (task) store.getState().setView({ kind: 'follow', taskId: task.id });
  };
  const openTab = (next: WorkspaceTab): void => {
    store.getState().setTab(next);
    focusPanel('main');
  };
  const minimise = (): void => {
    onMinimise();
    exit();
  };
  const closeOverlay = (): void => store.getState().setOverlay({ kind: 'none' });

  // ------------------------------------------------------------------ lifecycle (§2.4)
  // The controls an observer may send: the ones the run advertises and the selected task could accept.
  // Everything else on its screen is read-only, including the questions a worker is waiting on.
  const obsActions = useMemo(
    () => (observing && props.observer ? observerActions(run, selected, props.observer.capabilities) : []),
    [observing, props.observer, run, selected],
  );
  /** Whether this window has already asked the owner to stop; the next Ctrl+C escalates to kill (§2.3). */
  const stopSent = useRef(false);
  const actions = useMemo(() => (props.finished && canResume ? endedActions(run, selected) : []), [props.finished, canResume, run, selected]);
  /** What this window is doing, which is what `Q` and `Ctrl+C` mean and what `?` is allowed to say (§2.1, §2.4). */
  const mode: KeyMode = observing ? 'observing' : props.finished ? 'ended' : 'executing';
  /** The keys the lead actions have claimed this frame, so the panel does not advertise its own meaning for them. */
  const takenKeys = useMemo(() => {
    const taken = new Set([...obsActions, ...actions].map((action) => action.key.toUpperCase()));
    // `R` is never the local restart while observing: there is no scheduler here to restart anything in.
    if (observing) taken.add('R');
    return taken;
  }, [obsActions, actions, observing]);
  /**
   * When the run ends, move to the task the ended state is about (§3.1).
   *
   * The Overview leads with the failed task and the actions under it are for the *selected* one, so a run
   * that failed on task 3 led with "migrate-runner failed" and offered "R Re-run scaffold-config" — the
   * cursor had never left task 1. This is the one moment the workspace moves the cursor on its own, and it
   * is the moment the operator's attention moves too.
   */
  const jumped = useRef(false);
  useEffect(() => {
    if (!props.finished) {
      jumped.current = false;
      return;
    }
    if (jumped.current) return;
    jumped.current = true;
    const id = leadTaskId(run);
    const index = id ? visible.findIndex((t) => t.id === id) : -1;
    if (index >= 0) store.getState().setCursor(index);
    // The run object is mutated in place, so the effect has to key off the ended flag, not off `run`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.finished, store]);
  const resume = (request: ResumeRequest): void => {
    props.onResume?.(request);
  };
  const runAction = (action: { kind: string; taskId?: string }): void => {
    if (action.kind === 'answer' && action.taskId) {
      store.getState().setDraft(ANSWER_DRAFT, '');
      store.getState().setOverlay({ kind: 'answer', taskId: action.taskId });
      return;
    }
    if (action.kind === 'resume') resume({ kind: 'resume' });
    else if (action.taskId) resume({ kind: action.kind as 'task' | 'from' | 'approve' | 'reject', taskId: action.taskId });
  };
  /**
   * `Q`. On an ended run it leaves at once; while something is still executing it asks first, because the
   * three answers mean three different things to a worker that is halfway through a task [D5].
   */
  const requestQuit = (): void => {
    if (!props.onQuit) {
      minimise();
      return;
    }
    // An observer leaves at once too. The three quit answers are all about the workers in *this* process
    // [D5]: there are none here, "stop and quit" would stop nothing and "continue in plain output" has no
    // output to continue. `?` and the footer have always said `Q` closes the window; now it does.
    if (props.finished || observing) {
      props.onQuit();
      return;
    }
    store.getState().setListCursor('quit', 0, QUIT_ANSWERS.length);
    store.getState().setOverlay({ kind: 'quit' });
  };
  const answerQuit = (kind: 'stay' | 'stopAndQuit' | 'plain'): void => {
    closeOverlay();
    if (kind === 'stay') return;
    if (kind === 'plain') {
      minimise();
      return;
    }
    // Stop, then leave: the session is already waiting on the scheduler, so the quit it records here is
    // acted on the moment the run comes to a halt, with that run's exit code.
    setNotice(`Stopping the run, then leaving${glyph('ellipsis')}`);
    onInterrupt();
    props.onQuit?.();
  };

  const paletteEntries: PaletteEntry[] = useMemo(() => {
    const entries: PaletteEntry[] = WORKSPACE_TABS.map((name) => ({
      id: `tab:${name}`,
      label: `Go to ${TAB_LABEL[name]}`,
      hint: 'tab',
      run: () => openTab(name),
    }));
    for (const action of actions) {
      entries.push({ id: `ended:${action.kind}:${action.taskId ?? ''}`, label: action.label, hint: action.key, run: () => runAction(action) });
    }
    for (const action of obsActions) {
      entries.push({ id: `observer:${action.kind}:${action.taskId ?? ''}`, label: `${action.label} (request to pid ${props.observer?.ownerPid ?? '?'})`, hint: action.key, run: () => sendControl(action) });
    }
    entries.push(
      { id: 'action:follow', label: 'Follow the selected task', hint: 'F', run: () => follow(selected) },
      ...(props.finished || observing ? [] : [{ id: 'action:restart', label: 'Restart the selected task', hint: 'R', run: () => restart(selected) }]),
      ...(observing ? [] : [{ id: 'action:edit', label: 'Edit the selected task', hint: 'E', run: () => openEdit(selected) }]),
      ...(observing
        ? []
        : [
            {
              id: 'action:prompt',
              label: 'Send the selected task a message',
              hint: 'Session tab, Enter',
              run: () => {
                store.getState().setTab('session');
                focusPanel('main');
                openComposer(selected);
              },
            },
          ]),
      { id: 'action:usage', label: 'Usage per task', hint: 'U', run: () => store.getState().setView({ kind: 'usage' }) },
      { id: 'action:quota', label: 'Refresh the provider quotas', hint: 'R in the footer', run: () => refreshQuotas() },
      { id: 'action:help', label: 'Help for the focused panel', hint: '?', run: () => store.getState().setOverlay({ kind: 'help' }) },
      { id: 'action:quit', label: props.finished ? 'Quit the workspace' : 'Quit: stay, stop and quit, or plain output', hint: 'Q', run: requestQuit },
    );
    for (const task of tasks) {
      entries.push({
        id: task.id,
        label: task.id,
        hint: STATE_LABEL[run.tasks[task.id]?.state ?? 'pending'],
        run: () => {
          store.getState().setDraft('search', '');
          store.getState().setCursor(tasks.indexOf(task));
          store.getState().setTab('overview');
          focusPanel('tasks');
        },
      });
    }
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, run, selected, store, actions, obsActions, observing, props.finished]);
  const paletteMatches = useMemo(() => filterPalette(paletteEntries, paletteQuery), [paletteEntries, paletteQuery]);

  // ------------------------------------------------------------------ keys
  const inWorkspace = view.kind === 'dashboard' && !pending;
  // The composer owns the keys while it is up: inside it a printable key is text, whatever it means
  // outside (§3.2, `[D15]`). Esc, Ctrl+P, Ctrl+O, Ctrl+J, Ctrl+F and Ctrl+C are the chords there.
  const composerOpen = composerHasFocus && inWorkspace;

  /**
   * Bracketed paste `[D16]`: the whole block arrives as one string and goes in verbatim.
   *
   * Only while the composer is up. Ink enables bracketed paste for as long as this hook is active, and a
   * workspace that enabled it everywhere would change what every other panel's keys look like for the sake
   * of one field.
   */
  usePaste((text) => editComposer((state) => insertPaste(state, text)), { isActive: composerOpen });

  /**
   * The composer's keys (§3.2, `[D15]`).
   *
   * Enter submits, Ctrl+J and a trailing backslash before Enter are the two newlines every terminal can
   * type, and Shift+Enter is the third where the kitty protocol reports it — documented as a bonus, never
   * required. Ctrl+F is "Start a fresh session" (`[D25]`). Everything else printable is text.
   */
  const composerKey = (input: string, key: Key, open: { taskId: string; state: ComposerState; freshSession?: boolean }): void => {
    if (key.ctrl && input === 'o') {
      composeInEditor();
      return;
    }
    if (key.ctrl && input === 'f') {
      toggleFreshSession();
      return;
    }
    if (key.escape) {
      closeComposer();
      return;
    }
    if (input === LINE_FEED || (key.return && key.shift)) {
      editComposer(insertNewline);
      return;
    }
    if (key.return) {
      const line = open.state.lines[open.state.line] ?? '';
      if (line.endsWith('\\')) {
        // `\` then Enter: the backslash becomes the newline, as it does in the task editor and the answer
        // field, so one habit works in all three.
        editComposer((state) => insertNewline(backspace(state)));
        return;
      }
      if (isEmpty(open.state)) {
        setNotice('Type a message first, or press Esc to close the composer.');
        return;
      }
      submitPrompt(open.taskId, composerText(open.state), open.freshSession === true);
      return;
    }
    if (key.ctrl && input === 'z') {
      editComposer(undo);
      return;
    }
    if (key.ctrl && input === 'w') {
      editComposer(deleteWordLeft);
      return;
    }
    if (key.backspace) {
      editComposer(key.meta ? deleteWordLeft : backspace);
      return;
    }
    if (key.delete) {
      editComposer(deleteForward);
      return;
    }
    if (key.leftArrow) {
      editComposer(key.ctrl || key.meta ? wordLeft : moveLeft);
      return;
    }
    if (key.rightArrow) {
      editComposer(key.ctrl || key.meta ? wordRight : moveRight);
      return;
    }
    if (key.upArrow) {
      editComposer(moveUp);
      return;
    }
    if (key.downArrow) {
      editComposer(moveDown);
      return;
    }
    if (key.home) {
      editComposer(moveHome);
      return;
    }
    if (key.end) {
      editComposer(moveEnd);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) editComposer((state) => insertText(state, input));
  };
  // The review view owns its own keys (Esc leaves the hunk pane before it leaves the view), so it is not here.
  const detailKeys = (view.kind === 'usage' || view.kind === 'detail') && !pending;

  useInput((input, key) => {
    if (!key.ctrl || input !== 'c') return;
    if (observing) {
      // There is no worker in this process to interrupt (§2.1). Ctrl+C means the same thing it means in the
      // owner's window - stop this run - but it travels as a request, and the second one escalates to kill
      // exactly as a second `cao stop` always has (§2.3).
      const stop = obsActions.find((a) => a.kind === 'stop');
      const kill = obsActions.find((a) => a.kind === 'kill');
      const action = stopSent.current && kill ? kill : stop;
      if (!action) {
        setNotice(`This run does not accept a stop from another process. Stop it in the terminal that owns it (pid ${props.observer?.ownerPid ?? '?'}).`);
        return;
      }
      if (action.kind === 'stop') stopSent.current = true;
      sendControl(action);
      return;
    }
    // The workspace does not leave on Ctrl+C any more (§2.4): the run is asked to stop and this screen is
    // where the operator reads how it went. A second one inside the hard deadline still forces and exits.
    setNotice(props.finished ? 'The run has already ended. Q leaves with its exit code.' : 'Stopping the run; the workspace stays open. (Ctrl+C again to force)');
    onInterrupt();
  });

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'p') {
        if (overlay.kind === 'palette') closeOverlay();
        else {
          store.getState().setDraft('palette', '');
          store.getState().setListCursor('palette', 0, paletteEntries.length);
          store.getState().setOverlay({ kind: 'palette' });
        }
      } else if (!overlayOpen && !composerOpen && input === SHIFT_TAB_SS3 && !key.ctrl && !key.meta) focusPrevious();
    },
    { isActive: inWorkspace },
  );

  /**
   * The task editor's keys (§3.4, `[D15]`).
   *
   * Inside a field every printable key is text, whatever it would mean outside it: `q` types a `q`, `r`
   * types an `r`, and the only chords are the two that are not text — `Ctrl+O` for the editor and `Ctrl+J`
   * for a newline in the prompt. Enter on Save asks a running task "restart now?" rather than deciding.
   */
  const editKey = (input: string, key: Key, overlay: { kind: 'edit'; taskId: string; confirmRestart?: boolean }): void => {
    const state = store.getState();
    const task = tasks.find((t) => t.id === overlay.taskId);
    if (!task) {
      closeOverlay();
      return;
    }
    if (overlay.confirmRestart) {
      if (key.escape) state.setOverlay({ kind: 'edit', taskId: overlay.taskId });
      else if (input.toLowerCase() === 'y' || key.return) submitEdit(overlay.taskId, true);
      else if (input.toLowerCase() === 'n') submitEdit(overlay.taskId, false);
      return;
    }
    if (key.ctrl && input === 'o') {
      if (state.cursors[EDIT_CURSOR] === 0) editPromptInEditor(overlay.taskId);
      else setNotice('Ctrl+O opens the prompt in $EDITOR; move to the Prompt row first.');
      return;
    }
    if (key.escape) {
      closeOverlay();
      return;
    }
    if (key.upArrow || key.downArrow) {
      state.moveListCursor(EDIT_CURSOR, key.upArrow ? -1 : 1, EDIT_ROWS.length + 1);
      return;
    }
    const at = state.cursors[EDIT_CURSOR] ?? 0;
    if (at === SAVE_ROW) {
      if (key.return) {
        // A running or waiting task is stopped by this edit, so it is asked for rather than assumed (§3.4).
        const runState = run.tasks[overlay.taskId];
        const plan = runState ? restartPlanFor(runState) : 'restart';
        if (plan === 'cancelAndRestart') state.setOverlay({ kind: 'edit', taskId: overlay.taskId, confirmRestart: true });
        else submitEdit(overlay.taskId, false);
      }
      return;
    }
    const field = EDIT_ROWS[at]!;
    const draft = state.drafts[editDraftKey(field)] ?? '';
    // Ctrl+J and `\` then Enter are the two newlines every terminal can type (§3.2); they are the prompt's
    // alone, because a newline in a model id or a timeout is not a thing anyone means.
    if (input === LINE_FEED && field === 'prompt') state.setDraft(editDraftKey(field), `${draft}${LINE_FEED}`);
    else if (key.return && field === 'prompt' && draft.endsWith('\\')) state.setDraft(editDraftKey(field), `${draft.slice(0, -1)}${LINE_FEED}`);
    else if (key.return) state.setListCursor(EDIT_CURSOR, SAVE_ROW, EDIT_ROWS.length + 1);
    else if (key.backspace || key.delete) state.setDraft(editDraftKey(field), draft.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && !key.tab) state.setDraft(editDraftKey(field), draft + input);
  };

  // Both of the handlers below are subscribed whenever the shell is up, and each decides from the current
  // overlay whether the key is theirs. Gating them with `isActive` instead reads better but loses keys: Ink
  // subscribes and unsubscribes in a passive effect, so a key that arrives between the press that opened an
  // overlay and React flushing that effect reaches the handler that is on its way out - which is how Esc
  // stopped closing the help panel.
  useInput(
    (input, key) => {
      if (!overlayOpen) return;
      const state = store.getState();
      if (overlay.kind === 'quit') {
        const at = state.cursors['quit'] ?? 0;
        if (key.upArrow) state.moveListCursor('quit', -1, QUIT_ANSWERS.length);
        else if (key.downArrow) state.moveListCursor('quit', 1, QUIT_ANSWERS.length);
        else if (key.return) answerQuit(QUIT_ANSWERS[at]!.kind);
        else if (key.escape) closeOverlay();
        else {
          const chosen = QUIT_ANSWERS.find((a) => a.key.toLowerCase() === input.toLowerCase());
          if (chosen) answerQuit(chosen.kind);
        }
        return;
      }
      if (overlay.kind === 'edit') {
        editKey(input, key, overlay);
        return;
      }
      if (overlay.kind === 'answer') {
        // [D15] and §3.2: inside a field every printable key is text, Ctrl+J is a newline and Enter sends.
        const draft = state.drafts[ANSWER_DRAFT] ?? '';
        if (key.escape) {
          state.setDraft(ANSWER_DRAFT, '');
          closeOverlay();
        } else if (input === LINE_FEED) {
          // Ctrl+J reaches `useInput` as a bare line feed named `enter`, not as `return` with `ctrl` set.
          state.setDraft(ANSWER_DRAFT, `${draft}\n`);
        } else if (key.return && draft.endsWith('\\')) {
          // `\` then Enter, the newline every terminal can type (§3.2): the backslash becomes the newline.
          state.setDraft(ANSWER_DRAFT, `${draft.slice(0, -1)}\n`);
        } else if (key.return) {
          const text = draft.trim();
          if (!text) {
            setNotice('Type an answer first, or press Esc to cancel.');
            return;
          }
          closeOverlay();
          state.setDraft(ANSWER_DRAFT, '');
          resume({ kind: 'answer', taskId: overlay.taskId, text });
        } else if (key.backspace || key.delete) state.setDraft(ANSWER_DRAFT, draft.slice(0, -1));
        else if (input && !key.ctrl && !key.meta && !key.tab) state.setDraft(ANSWER_DRAFT, draft + input);
        return;
      }
      if (overlay.kind === 'help') {
        if (key.upArrow) state.moveListCursor('help', -1, 200);
        else if (key.downArrow) state.moveListCursor('help', 1, 200);
        else if (key.pageUp) state.moveListCursor('help', -10, 200);
        else if (key.pageDown) state.moveListCursor('help', 10, 200);
        else if (key.escape || input === '?' || input.toLowerCase() === 'q') closeOverlay();
        return;
      }
      // Which list `/` is searching this time. The Logs panel has a query of its own because the task-list
      // filter and "find this in 50 MB of stdout" are not the same question, and one draft cannot be both.
      const field = overlay.kind === 'palette' ? 'palette' : focus === 'main' && tab === 'logs' ? 'logs-search' : 'search';
      const query = field === 'palette' ? paletteQuery : field === 'logs-search' ? logsSearch : search;
      if (key.escape) {
        if (field === 'logs-search') state.setDraft('logs-search', '');
        else if (field === 'search') {
          state.setDraft('search', '');
          state.setCursor(0);
        }
        closeOverlay();
      } else if (key.return) {
        if (field === 'palette') {
          const entry = paletteMatches[paletteCursor];
          closeOverlay();
          entry?.run();
        } else closeOverlay();
      } else if (key.backspace || key.delete) {
        state.setDraft(field, query.slice(0, -1));
        if (field === 'search') state.setCursor(0);
        else if (field === 'palette') state.setListCursor('palette', 0, paletteEntries.length);
      } else if (field === 'palette' && (key.upArrow || key.downArrow)) {
        state.moveListCursor('palette', key.upArrow ? -1 : 1, paletteMatches.length);
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        // [D15]: inside a text field a printable key is text, whatever it would mean outside it.
        state.setDraft(field, query + input);
        if (field === 'search') state.setCursor(0);
        else if (field === 'palette') state.setListCursor('palette', 0, paletteEntries.length);
      }
    },
    { isActive: inWorkspace },
  );

  useInput(
    (input, key) => {
      if (overlayOpen) return;
      // Before the chord guard below: Ctrl+J and Ctrl+O are the composer's, and a `return` there would eat
      // them. The composer answers every key it is given and nothing falls through to the panel.
      if (composerOpen && composer) {
        composerKey(input, key, composer);
        return;
      }
      const state = store.getState();
      // Ctrl+C is handled above and every other chord belongs to the terminal, not to this screen. Without
      // this line Ctrl+C also arrives here as a plain `c` and opens the Changes tab over the frame that was
      // about to say the run is stopping; Ctrl+L, Ctrl+R and Ctrl+U are the same story.
      if (key.ctrl || key.meta || key.tab) return;
      const lower = input.toLowerCase();
      const list = focus === 'tabs' ? 'tabs' : focus === 'main' && tab === 'report' ? 'report' : 'tasks';
      // Every move reads the cursor back out of the store rather than using the one this frame was drawn
      // with: Ink hands the whole of a held-down key's burst to the handler before React re-renders, and a
      // move computed from the rendered value would move by one however many arrived.
      const step = (delta: number): void => {
        if (list === 'tabs') state.moveTab(delta);
        else if (list === 'report') state.moveListCursor('report', delta, 10_000);
        else state.setCursor(Math.max(0, Math.min(store.getState().cursor + delta, visible.length - 1)));
      };

      // The footer's one key comes before everything else that answers `R` (§3.6): while the footer holds
      // the keys, `R` reads the quotas again rather than re-running a task, which is the whole reason the
      // footer is a focus stop rather than a fourth meaning for a chord.
      if (focus === 'footer') {
        if (lower === 'r') refreshQuotas();
        else if (input === '?') state.setOverlay({ kind: 'help' });
        else if (key.escape) focusPanel('tasks');
        else if (lower === 'q') requestQuit();
        return;
      }

      // The Logs panel answers nearly every printable key itself (§3.7): it has four views, five filters and
      // a search, and a key that meant "restart the selected task" in the middle of that would be a
      // surprise. Placed before the observer and ended-state actions for exactly that reason.
      if (focus === 'main' && tab === 'logs') {
        if (key.upArrow) logs.scroll(-1);
        else if (key.downArrow) logs.scroll(1);
        else if (key.pageUp) logs.scroll(-Math.max(1, layout.mainRows - 4));
        else if (key.pageDown) logs.scroll(Math.max(1, layout.mainRows - 4));
        else if (key.leftArrow) state.moveTab(-1);
        else if (key.rightArrow) state.moveTab(1);
        else if (input === 'g') logs.toOldest();
        else if (input === 'G') logs.toNewest();
        else if (input === '/') {
          state.setDraft('logs-search', '');
          state.setOverlay({ kind: 'search' });
        } else if (input === 'n') logs.stepMatch(1);
        else if (input === 'N') logs.stepMatch(-1);
        else if (lower === 'v') logs.cycleView(input === 'V' ? -1 : 1);
        else if (input === ']') logs.cycleSource(1);
        else if (input === '[') logs.cycleSource(-1);
        else if (lower === 't') logs.cycleTask(input === 'T' ? -1 : 1);
        else if (lower === 'k') logs.cycleSeverity(input === 'K' ? -1 : 1);
        else if (lower === 'm') logs.cycleRange(input === 'M' ? -1 : 1);
        else if (lower === 'r') logs.reload();
        else if (input === '?') state.setOverlay({ kind: 'help' });
        else if (key.escape) {
          if (logsSearch) state.setDraft('logs-search', '');
          else focusPanel('tasks');
        } else if (lower === 'q') requestQuit();
        return;
      }

      // The Diagnostics panel is one long list and scrolls like one; `R` re-reads what it read on open.
      if (focus === 'main' && tab === 'diagnostics') {
        const length = 10_000;
        if (key.upArrow) state.moveListCursor('diagnostics', -1, length);
        else if (key.downArrow) state.moveListCursor('diagnostics', 1, length);
        else if (key.pageUp) state.moveListCursor('diagnostics', -10, length);
        else if (key.pageDown) state.moveListCursor('diagnostics', 10, length);
        else if (key.home) state.setListCursor('diagnostics', 0, length);
        else if (key.end) state.setListCursor('diagnostics', length, length);
        else if (key.leftArrow) state.moveTab(-1);
        else if (key.rightArrow) state.moveTab(1);
        else if (lower === 'r') {
          setDiagnostics({});
          setDiagnosticsRead((n) => n + 1);
        }
        else if (input === '?') state.setOverlay({ kind: 'help' });
        else if (key.escape) focusPanel('tasks');
        else if (lower === 'q') requestQuit();
        return;
      }

      // The observer's controls come first, for the same reason the ended run's do below: `R` here means
      // "ask the owner to re-run this", and the local restart it would otherwise reach has nothing to act on.
      const observerAction = obsActions.length && input ? observerActionFor(obsActions, input) : undefined;
      if (observerAction) {
        sendControl(observerAction);
        return;
      }

      // An ended run's actions come first: `R` means "re-run this task through a fresh resume" rather than
      // "restart it in the running scheduler", and there is no scheduler left to restart anything in.
      const endedAction = actions.length && input ? endedActionFor(actions, input) : undefined;
      if (endedAction) {
        runAction(endedAction);
        return;
      }

      if (input === '?') state.setOverlay({ kind: 'help' });
      else if (input === '/') {
        state.setDraft(list === 'report' ? 'report-search' : 'search', '');
        state.setOverlay({ kind: 'search' });
      } else if (key.upArrow) step(-1);
      else if (key.downArrow) step(1);
      else if (key.leftArrow) step(list === 'tasks' ? 0 : -1);
      else if (key.rightArrow) step(list === 'tasks' ? 0 : 1);
      else if (key.pageUp) step(-10);
      else if (key.pageDown) step(10);
      else if (key.home) {
        if (list === 'tabs') state.setTab('overview');
        else if (list === 'report') state.setListCursor('report', 0, 10_000);
        else state.setCursor(0);
      } else if (key.end) {
        if (list === 'tabs') state.setTab('diagnostics');
        else if (list === 'report') state.setListCursor('report', 10_000, 10_000);
        else state.setCursor(visible.length - 1);
      } else if (key.return) {
        if (focus === 'main' && tab === 'session') openComposer(selected);
        else if (focus === 'tabs') focusPanel('main');
        else {
          const waiting = tasks.find((t) => run.tasks[t.id]?.state === 'waiting');
          if (waiting && props.shared.queue.length) return; // the modal is about to show
          state.setTab('overview');
          focusPanel('main');
        }
      } else if (key.escape) {
        if (search) {
          state.setDraft('search', '');
          state.setCursor(0);
        } else if (focus !== 'tasks') focusPanel('tasks');
      } else if (lower === 'l' || lower === 'f') follow(selected);
      else if (lower === 'u') state.setView({ kind: 'usage' });
      else if (lower === 'c') openTab('changes');
      else if (lower === 'r') restart(selected);
      else if (lower === 'e') openEdit(selected);
      else if (lower === 'h') state.setOverlay({ kind: 'help' });
      else if (lower === 'q') requestQuit();
    },
    { isActive: inWorkspace && !(focus === 'main' && tab === 'changes') },
  );

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const lower = input.toLowerCase();
      if (key.escape || lower === 'q' || key.backspace) store.getState().setView({ kind: 'dashboard' });
      else if (view.kind === 'usage' && lower === 's') setUsageSort((s) => (s === 'order' ? 'cost' : 'order'));
    },
    { isActive: detailKeys },
  );

  // ------------------------------------------------------------------ layout
  const waiting = waitingTasks(run);
  const attention = waiting.length
    ? waiting
        .map((t) => {
          const st = run.tasks[t.id];
          const p = st?.pendingInteraction;
          // Without the state the fallback said "(approval)" for every task with no interaction attached,
          // which is the wrong word for a `needs_input` task — and `needs_input` is the state a run most
          // often stops in with nothing attached, because the question is in `message`.
          const what = p ? `${p.kind}: ${sanitizeText(p.title)}` : st?.message ? firstLine(sanitizeText(st.message)) : STATE_LABEL[st?.state ?? 'waiting'].toLowerCase();
          return `${t.id} (${what})`;
        })
        .join('   ')
    : undefined;
  const spinner = spinnerFrames();
  const runningGlyph = motion ? spinner[frame.current % spinner.length]! : stateGlyph('running');
  const header = <Header run={run} theme={theme} columns={columns} now={now} role={props.role ?? 'owner'} badge={props.badge} attention={attention} />;

  if (pending) {
    return (
      <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
        {header}
        <Text> </Text>
        <Modal
          key={pending.id}
          item={pending}
          queued={props.shared.queue.length - 1}
          width={columns}
          height={Math.max(4, rows - headerRows - 1)}
          onDone={() => {
            // By id, not shift(): a request withdrawn while this one was on screen has already been spliced out.
            props.shared.remove(pending.id);
            process.stdout.write(BELL);
          }}
        />
      </Box>
    );
  }

  const viewerTasks = (): ViewerTask[] =>
    tasks.map((t) => {
      const st = run.tasks[t.id]!;
      const a = currentAttempt(st);
      return {
        id: t.id,
        state: st.state,
        attempts: st.attempts.map((x) => x.number),
        elapsed: elapsedCell(st, now),
        usage: a?.usage ?? st.result?.usage,
        filesChanged: taskFiles(st).length || undefined,
        pending: st.pendingInteraction && sanitizeText(st.pendingInteraction.title),
      };
    });

  /**
   * The buffer is re-read on every frame (the spinner ticks ~8x/second), and a fresh array would defeat the
   * viewer's own memo, re-wrapping and re-highlighting the whole transcript each time. Reuse the previous
   * array while the buffer has not grown or been replaced.
   */
  const followEntries = (taskId: string): TranscriptEntry[] => {
    const next = controller.transcript(taskId);
    const cached = entriesCache.current;
    if (cached && cached.taskId === taskId && cached.value.length === next.length && cached.value[next.length - 1] === next[next.length - 1]) return cached.value;
    entriesCache.current = { taskId, value: next };
    return next;
  };

  if (view.kind === 'follow') {
    const st = run.tasks[view.taskId];
    const live = st ? (currentAttempt(st)?.number ?? st.attempts[st.attempts.length - 1]?.number) : undefined;
    const showing = pastAttempt && pastAttempt.taskId === view.taskId && pastAttempt.attempt === view.attempt ? pastAttempt.entries : undefined;
    // Scrolling above the oldest buffered entry pages the rest in from that attempt's events.jsonl, so the
    // whole transcript is reachable even though only outputBufferLines of it are ever in memory.
    const followAttempt = view.attempt ?? live;
    return (
      <TranscriptViewer
        tasks={viewerTasks()}
        taskId={view.taskId}
        attempt={view.attempt}
        entries={view.attempt === undefined ? followEntries(view.taskId) : (showing ?? [])}
        width={columns}
        height={rows}
        color={theme.color}
        onSelectTask={(id) => {
          store.getState().setView({ kind: 'follow', taskId: id });
          store.getState().setCursor(Math.max(0, tasks.findIndex((t) => t.id === id)));
        }}
        // Choosing the newest attempt goes back to the live buffer, so the view keeps following the worker.
        onSelectAttempt={(attempt) => store.getState().setView({ kind: 'follow', taskId: view.taskId, attempt: attempt === live ? undefined : attempt })}
        // The live view's buffer spans every attempt of the task, so its pager has to as well; a chosen past
        // attempt is scoped to that attempt's file, exactly as `cao logs -a N` is.
        loadOlder={
          followAttempt === undefined
            ? undefined
            : view.attempt === undefined
              ? (oldest) => controller.olderTaskTranscript(view.taskId, followAttempt, oldest)
              : (oldest) => controller.olderTranscript(view.taskId, followAttempt, oldest)
        }
        onExit={() => store.getState().setView({ kind: 'dashboard' })}
        footerHint="Q/Esc workspace"
      />
    );
  }

  if (view.kind === 'usage') {
    return <UsageView run={run} theme={theme} columns={columns} rows={rows} sort={usageSort} header={header} headerRows={headerRows} />;
  }

  // ------------------------------------------------------------------ the shell
  const mainPanel = (): React.JSX.Element => {
    switch (tab) {
      case 'overview':
        return (
          <Overview
            run={run}
            tasks={visible}
            cursor={Math.min(cursor, Math.max(0, visible.length - 1))}
            now={now}
            columns={layout.mainWidth}
            rows={layout.mainRows}
            theme={theme}
            focused={focus === 'main'}
            runningGlyph={runningGlyph}
            peek={(taskId, entries) => controller.peek(taskId, entries)}
            ended={!observing && props.finished ? { actions, banner: canResume ? undefined : props.banner, columns: layout.mainWidth } : undefined}
            observer={
              observing
                ? {
                    banner: props.banner ?? '',
                    actions: obsActions,
                    pending: pendingLines(run),
                    answerHint: answerElsewhere(props.observer?.ownerPid),
                    columns: layout.mainWidth,
                  }
                : undefined
            }
          />
        );
      case 'changes':
        return (
          <ReviewView
            tasks={reviewTasks(run)}
            width={layout.mainWidth}
            height={layout.mainRows}
            color={theme.color}
            root={run.repositoryRoot}
            loadDiff={loadDiff}
            isActive={focus === 'main' && !overlayOpen}
            onExit={() => focusPanel('tasks')}
            onQuit={requestQuit}
          />
        );
      case 'report':
        return (
          <ReportPanel
            markdown={report}
            rows={layout.mainRows}
            columns={layout.mainWidth}
            theme={theme}
            cursor={reportCursor}
            focused={focus === 'main'}
          />
        );
      case 'session':
        return (
          <SessionPanel
            task={selected ?? null}
            state={selected ? (run.tasks[selected.id] ?? null) : null}
            entries={selected ? controller.peek(selected.id, SESSION_TRANSCRIPT_LINES) : []}
            hasChannel={Boolean(selected) && !observing && !props.finished && controller.steerable(selected!.id)}
            composer={composer?.taskId === selected?.id ? (composer?.state ?? null) : null}
            freshSession={composer?.taskId === selected?.id && composer?.freshSession === true}
            focused={composerOpen && composer?.taskId === selected?.id}
            sending={sendingNote}
            rows={layout.mainRows}
            columns={layout.mainWidth}
            theme={theme}
          />
        );
      case 'logs':
        return (
          <LogsPanel
            sources={logs.sources}
            source={logs.source}
            view={logs.view}
            filters={logs.filters}
            lines={logs.lines}
            offset={logs.offset}
            atStart={logs.atStart}
            loading={logs.loading}
            search={overlay.kind === 'search' || logsSearch ? logsSearch : undefined}
            match={logs.match}
            rows={layout.mainRows}
            columns={layout.mainWidth}
            theme={theme}
            focused={focus === 'main'}
          />
        );
      case 'diagnostics':
        return (
          <DiagnosticsPanel
            run={run}
            controls={controls}
            quotas={quotas}
            agents={diagnostics.agents}
            retries={diagnostics.retries}
            inbox={diagnostics.inbox}
            now={now}
            rows={layout.mainRows}
            columns={layout.mainWidth}
            theme={theme}
            cursor={diagnosticsCursor}
            focused={focus === 'main'}
          />
        );
      default:
        return <Placeholder tab={tab} rows={layout.mainRows} columns={layout.mainWidth} theme={theme} />;
    }
  };

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {header}
      <TabBar tab={tab} focused={focus === 'tabs'} theme={theme} columns={columns} />
      <Box flexDirection="column" height={layout.bodyRows} overflow="hidden">
        {layout.compact && (
          <TaskStrip tasks={visible} run={run} cursor={Math.min(cursor, Math.max(0, visible.length - 1))} columns={columns} theme={theme} focused={focus === 'tasks'} runningGlyph={runningGlyph} />
        )}
        <Box flexDirection="row" height={layout.mainRows} overflow="hidden">
          {!layout.compact && (
            <>
              <Sidebar
                tasks={visible}
                run={run}
                cursor={Math.min(cursor, Math.max(0, visible.length - 1))}
                width={layout.sidebarWidth}
                rows={layout.mainRows}
                theme={theme}
                focused={focus === 'tasks'}
                runningGlyph={runningGlyph}
                search={searching ? search : undefined}
              />
              <Text> </Text>
            </>
          )}
          <Box flexDirection="column" width={layout.mainWidth} overflow="hidden">
            {overlayOpen && overlay.kind !== 'search' ? (
              overlay.kind === 'palette' ? (
                <Palette entries={paletteMatches} query={paletteQuery} cursor={paletteCursor} rows={layout.mainRows} columns={layout.mainWidth} theme={theme} />
              ) : overlay.kind === 'quit' ? (
                <QuitPrompt cursor={quitCursor} rows={layout.mainRows} columns={layout.mainWidth} theme={theme} />
              ) : overlay.kind === 'edit' ? (
                <EditForm
                  task={tasks.find((t) => t.id === overlay.taskId)!}
                  state={run.tasks[overlay.taskId]!}
                  workflow={run.workflow}
                  tasks={run.tasks}
                  drafts={drafts}
                  cursor={editCursor}
                  rows={layout.mainRows}
                  columns={layout.mainWidth}
                  theme={theme}
                  confirmRestart={
                    overlay.confirmRestart
                      ? { note: resetWorkspaceNote(tasks.find((t) => t.id === overlay.taskId)!, true) }
                      : undefined
                  }
                />
              ) : overlay.kind === 'answer' ? (
                <AnswerField
                  taskId={overlay.taskId}
                  question={run.tasks[overlay.taskId]?.message ? sanitizeText(run.tasks[overlay.taskId]!.message!) : undefined}
                  text={answerDraft}
                  rows={layout.mainRows}
                  columns={layout.mainWidth}
                  theme={theme}
                />
              ) : (
                <HelpPanel focus={focus} tab={tab} rows={layout.mainRows} columns={layout.mainWidth} theme={theme} cursor={helpCursor} ended={actions} observer={observing ? obsActions : undefined} mode={mode} />
              )
            ) : (
              mainPanel()
            )}
          </Box>
        </Box>
      </Box>
      <Footer
        hints={
          composerOpen
            ? `Enter send   Ctrl+J newline   Ctrl+O $EDITOR   Ctrl+F fresh session   Ctrl+Z undo   Esc close`
            : overlayOpen
            ? overlay.kind === 'answer'
              ? 'Enter send   Ctrl+J newline   Esc cancel'
              : overlay.kind === 'edit'
                ? overlay.confirmRestart
                  ? 'Y restart now   N apply only   Esc back to the form'
                  : `${glyph('up')}${glyph('down')} field   Ctrl+O prompt in $EDITOR   Enter save   Esc cancel`
                : `Esc close   ${glyph('up')}${glyph('down')} move   Enter choose`
            : footerHints(focus, tab, { lead: observing ? obsActions : actions, taken: takenKeys })
        }
        always={overlayOpen || composerOpen ? undefined : alwaysHintCells(mode)}
        columns={columns}
        theme={theme}
        columnsShown={layout.footerColumns}
        snapshotAge={now - (snapshot?.at ?? now)}
        notice={notice}
        quotas={quotas}
        now={now}
        focused={focus === 'footer' && !overlayOpen && !composerOpen}
      />
    </Box>
  );
}

/** What the review view starts from: the live tool-stream list, until it has read the attempt's own diff. */
function reviewTasks(run: WorkflowRun): ReviewTaskInput[] {
  return run.workflow.tasks.map((t) => {
    const st = run.tasks[t.id]!;
    return { taskId: t.id, state: st.state, live: st.state === 'running' || st.state === 'waiting', attempts: st.attempts.length, files: taskFiles(st) };
  });
}

/** `/` over a task list [D12]: the same matcher the palette uses, so one query means one thing. */
function filterTasks(tasks: ResolvedTask[], query: string): ResolvedTask[] {
  const matches = filterPalette(
    tasks.map((t) => ({ id: t.id, label: t.id, run: () => undefined })),
    query,
  );
  const order = new Map(matches.map((m, i) => [m.id, i]));
  return tasks.filter((t) => order.has(t.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

interface UsageViewProps {
  run: WorkflowRun;
  theme: Theme;
  columns: number;
  rows: number;
  sort: 'order' | 'cost';
  header: React.JSX.Element;
  headerRows: number;
}

/**
 * `U`: tokens, context, cost and time in tools per task. Still a screen of its own rather than a tab,
 * because it is the whole run at once and stage 3 replaces it with the usage footer (§3.6).
 */
function UsageView({ run, theme, columns, rows, sort, header, headerRows }: UsageViewProps): React.JSX.Element {
  const tasks = run.workflow.tasks;
  const narrow = columns < 100;
  const idWidth = Math.min(28, Math.max(12, ...tasks.map((t) => t.id.length)));
  const taskCell = (id: string): string => truncateVisible(id, idWidth).padEnd(idWidth);
  const totalUsage = addUsage(...tasks.flatMap((t) => run.tasks[t.id]?.attempts.map((a) => a.usage) ?? []));
  const list = tasks.map((t) => ({ t, st: run.tasks[t.id]!, u: taskUsage(run.tasks[t.id]!) }));
  if (sort === 'cost') list.sort((a, b) => (b.u.costUsd ?? 0) - (a.u.costUsd ?? 0));
  // Header, blank, column headings, blank, total, two legend lines, the footer hint: what is left is rows.
  const legend = narrow ? ['Context = tokens in the session window'] : ['Cache r/w = tokens read from / written to the prompt cache', 'Time = duration the agent reported   Tools = time spent inside tool calls'];
  const fits = Math.max(1, rows - headerRows - 5 - legend.length);
  // The `N more` marker is a row like any other. Unreserved, the tree was one row taller than the terminal
  // on any run that did not fit, and Yoga took the row back out of the first child - the header's own title.
  const budget = Math.max(1, list.length > fits ? fits - 1 : fits);
  const slice = windowOf(list, 0, budget, { anchor: 0 });

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {header}
      <Text> </Text>
      {/* Below 100 columns the four detail columns do not fit beside the task name, and a header that wraps
          takes its continuation from the middle of a column heading. They are dropped instead; what is left
          is the four numbers an operator opens this view for, plus the context bar. */}
      <Text bold wrap="truncate-end">
        {'  '}
        {'Task'.padEnd(idWidth)}  {'State'.padEnd(11)} {'Cost'.padStart(7)} {'In'.padStart(7)} {'Out'.padStart(7)}
        {narrow ? '' : ` ${'Cache r/w'.padStart(11)} ${'Turns'.padStart(5)} ${'Time'.padStart(6)} ${'Tools'.padStart(6)}`}
        {'  '}Context
      </Text>
      {slice.items.map(({ t, st, u }) => {
        const ratio = contextRatio(u);
        const ctx = u.contextTokens !== undefined ? `${formatTokens(u.contextTokens)}${u.contextWindow ? `/${formatTokens(u.contextWindow)}` : ''}` : '';
        const ctxToken = ratio === undefined ? 'muted' : ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : 'success';
        // Cache reads and cache writes share one cell: two more full columns would push the context bar off
        // an 80-column terminal, and the pair is only ever read together.
        const cache = u.cacheReadTokens !== undefined || u.cacheCreationTokens !== undefined ? `${formatTokens(u.cacheReadTokens ?? 0)}/${formatTokens(u.cacheCreationTokens ?? 0)}` : '';
        return (
          <Text key={t.id} wrap="truncate-end">
            {'  '}
            {taskCell(t.id)}  <Text color={theme.stateColor(st.state)}>{STATE_LABEL[st.state].padEnd(11)}</Text> {(u.costUsd !== undefined ? formatCost(u.costUsd) : '').padStart(7)} {(u.inputTokens !== undefined ? formatTokens(u.inputTokens) : '').padStart(7)}{' '}
            {(u.outputTokens !== undefined ? formatTokens(u.outputTokens) : '').padStart(7)}
            {narrow ? '' : ` ${cache.padStart(11)} ${String(u.numTurns ?? '').padStart(5)} ${(u.durationMs !== undefined ? formatDurationShort(u.durationMs) : '').padStart(6)} `}
            {narrow ? '' : theme.paint((u.toolMs !== undefined ? formatDurationShort(u.toolMs) : '').padStart(6), 'info')}
            {'  '}
            {ratio !== undefined ? theme.paint(`[${bar(ratio, narrow ? 5 : 8)}] `, ctxToken) : ''}
            {theme.paint(ctx, ctxToken)}
            {u.compactions ? theme.paint(`  ${u.compactions} compaction${u.compactions === 1 ? '' : 's'}`, 'muted') : ''}
          </Text>
        );
      })}
      {slice.belowMarker && <Text wrap="truncate-end">{theme.paint(`  ${slice.belowMarker}`, 'muted')}</Text>}
      <Text> </Text>
      <Text wrap="truncate-end">
        Total: {formatCost(totalUsage.costUsd ?? 0)}   {formatTokens(totalUsage.inputTokens ?? 0)} in / {formatTokens(totalUsage.outputTokens ?? 0)} out
        {!narrow && totalUsage.cacheCreationTokens ? `   ${formatTokens(totalUsage.cacheCreationTokens)} cache write` : ''}
        {totalUsage.durationMs !== undefined ? `   ${formatDuration(totalUsage.durationMs)} of agent time` : ''}
        {!narrow && totalUsage.toolMs !== undefined ? `   ${formatDuration(totalUsage.toolMs)} in tools` : ''}
      </Text>
      {/* Two lines rather than one: the single legend is 133 columns and wrapped even on a wide terminal,
          which put "Tools = time spent inside tool calls" halfway through a sentence. */}
      {legend.map((line) => (
        <Text key={line} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        S sort by {sort === 'order' ? 'cost' : 'workflow order'}   Esc/Q back
      </Text>
    </Box>
  );
}

export function createDashboard(opts: DashboardOptions): DashboardController {
  const shared: Shared = {
    queue: [],
    listeners: new Set(),
    notify() {
      for (const l of this.listeners) l();
    },
    remove(id) {
      const i = this.queue.findIndex((item) => item.id === id);
      if (i < 0) return false;
      this.queue.splice(i, 1);
      this.notify();
      return true;
    },
  };
  let instance: Instance | undefined;
  let finished = false;
  let closing = false;
  let seq = 0;
  let observedSeq = 0;
  let disarm: (() => void) | undefined;

  // One store for the life of the workspace, fed from whichever execution is current: a store created per
  // mount would lose the tab and the cursor every time the workspace was minimised and reopened, and a
  // store created per execution would lose them every time an ended run was resumed (§2.4).
  const store = createPresentationStore();
  let current: DashboardOptions = opts;
  let unfollow: () => void = followRun(store, opts.bus, opts.controller);
  const renderTree = opts.mount ?? render;
  const options = workspaceRenderOptions({ flag: opts.altScreen });

  const element = (): React.JSX.Element => <DashboardApp {...current} shared={shared} finished={finished} store={store} />;
  const refresh = (): void => instance?.rerender(element());

  const mount = (): Instance => {
    const created = renderTree(element(), options);
    if (options.alternateScreen && process.stdout.isTTY) disarm ??= armAltScreenRestore();
    instance = created;
    return created;
  };
  const enqueue = (item: PendingItem): void => {
    shared.queue.push(item);
    shared.notify();
    process.stdout.write(BELL);
    if (!instance) controller.open();
  };

  const controller: DashboardController = {
    get isOpen() {
      return instance !== undefined;
    },
    open() {
      // `finished` no longer bars a mount: an ended run is exactly what the workspace stays open for
      // (§2.4). Only a workspace that is on its way out refuses to come back.
      if (instance || closing) return;
      const mounted = mount();
      void mounted.waitUntilExit().then(() => {
        if (instance === mounted) instance = undefined;
      });
    },
    close() {
      if (!instance) return;
      const mounted = instance;
      instance = undefined;
      mounted.unmount();
    },
    attach(source) {
      unfollow();
      current = { ...current, run: source.run, bus: source.bus, controller: source.controller };
      unfollow = followRun(store, source.bus, source.controller);
      finished = false;
      refresh();
    },
    executionEnded() {
      finished = true;
      // A worker that was waiting on a human when the run stopped has nobody to answer it now; settle what
      // is queued rather than leaving a modal in front of the ended state.
      for (const item of shared.queue.splice(0)) {
        if (item.kind === 'approval') item.resolve('defer');
        else item.resolve({ kind: 'deny', message: 'The run ended' });
      }
      shared.notify();
      refresh();
    },
    setOwnership(view) {
      current = { ...current, role: view.role, banner: view.banner, badge: view.badge, observer: view.observer };
      refresh();
    },
    update(run) {
      current = { ...current, run };
      // `seq` counts the polls this window has folded in. Nothing here shares a sequence with the owner's
      // bus, and nothing needs to: it exists so a subscriber can tell one update from the next.
      store.getState().setSnapshot({ seq: (observedSeq += 1), at: Date.now(), run });
      refresh();
    },
    notify(text) {
      store.getState().setNotice(text);
    },
    requestApproval(task) {
      return new Promise((resolve) => enqueue({ kind: 'approval', id: `approval-${++seq}`, task, resolve }));
    },
    requestInteraction(interaction, signal) {
      return new Promise((resolve) => {
        const id = `interaction-${++seq}`;
        // The scheduler aborts the signal as soon as this request no longer needs an answer (the worker
        // withdrew it, or it timed out). Take the modal down then: a prompt left on screen for a decided
        // request sits in front of the next real one, which is how an operator answers the wrong thing.
        const onAbort = (): void => {
          shared.remove(id);
          resolve({ kind: 'deny', message: 'The request was withdrawn' });
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        enqueue({
          kind: 'interaction',
          id,
          interaction,
          resolve: (a: InteractionAnswer) => {
            signal.removeEventListener('abort', onAbort);
            resolve(a);
          },
        });
      });
    },
    async finish() {
      controller.executionEnded();
      closing = true;
      if (!instance) {
        unfollow();
        disarm?.();
        disarm = undefined;
        return;
      }
      const mounted = instance;
      // Unmount rather than waiting for the tree to leave by itself: since §2.4 nothing in the tree exits
      // on `finished`, so a `waitUntilExit` on its own would never resolve.
      instance = undefined;
      mounted.unmount();
      await mounted.waitUntilExit().catch(() => undefined);
      unfollow();
      disarm?.();
      disarm = undefined;
    },
  };
  return controller;
}
