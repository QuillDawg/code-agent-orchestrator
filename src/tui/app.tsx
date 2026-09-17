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
import { render, Box, Text, useInput, useApp, useFocus, useFocusManager, useIsScreenReaderEnabled, useWindowSize, type Instance } from 'ink';
import { useStore } from 'zustand';
import {
  type WorkflowRun,
  type TaskRunState,
  type ResolvedTask,
  type Interaction,
  type InteractionAnswer,
  addUsage,
  type TranscriptEntry,
} from 'code-agent-orchestrator-protocol';
import type { EventBus } from '../events/event-bus.js';
import type { RunController } from '../workflow/control/controller.js';
import { controlEnvelope } from '../workflow/control/commands.js';
import { STATE_LABEL, stateGlyph } from '../workflow/states.js';
import { spinnerFrames } from '../util/glyphs.js';
import { formatDuration, formatDurationShort } from '../util/duration.js';
import { TranscriptViewer, type ViewerTask } from './viewer.js';
import { Modal, type PendingItem } from './dashboard/modal.js';
import { ReviewView, type ReviewTaskInput } from './dashboard/review.js';
import { taskFiles } from './dashboard/files.js';
import { sanitizeText } from '../cli/color.js';
import { truncateVisible } from '../cli/util.js';
import { BELL } from '../util/misc.js';
import { bar, contextRatio, formatCost, formatTokens } from './format.js';
import { currentAttempt, elapsedCell } from './history.js';
import {
  attachStore,
  selectCursor,
  selectDraft,
  selectFocus,
  selectListCursor,
  selectNotice,
  selectOverlay,
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
import { anyActive, Footer, Header, headerRowsFor, Sidebar, TabBar, TaskStrip, waitingTasks, type WorkspaceRole } from './workspace/chrome.js';
import { workspaceLayout } from './workspace/layout.js';
import { footerHints } from './workspace/keys.js';
import { Overview } from './workspace/overview.js';
import { filterPalette, HelpPanel, Palette, Placeholder, ReportPanel, type PaletteEntry } from './workspace/panels.js';

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
}

export interface DashboardController {
  /** Mount the workspace (no-op when already open). */
  open(): void;
  /** Unmount it, leaving the run going. */
  close(): void;
  readonly isOpen: boolean;
  requestApproval(task: ResolvedTask): Promise<{ decision: 'approved' | 'rejected'; note?: string } | 'defer'>;
  requestInteraction(interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer>;
  /** The run ended: show the final frame, then unmount. */
  finish(): Promise<void>;
}

/**
 * The Shift+Tab some Windows terminals send. Ink parses `\x1b[Z` and moves focus itself; `\x1bOZ` reaches
 * `useInput` with no name at all and its escape prefix stripped, which leaves exactly these two characters
 * (§3.2, [D40]). No key produces them any other way — a typed `O` and `Z` arrive as two separate reads.
 */
const SHIFT_TAB_SS3 = 'OZ';

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

  const [, setTick] = useState(0);
  const [pending, setPending] = useState<PendingItem | null>(props.shared.queue[0] ?? null);
  const [usageSort, setUsageSort] = useState<'order' | 'cost'>('order');
  const [pastAttempt, setPastAttempt] = useState<{ taskId: string; attempt: number; entries: TranscriptEntry[] } | null>(null);
  const [report, setReport] = useState<string | null | undefined>(undefined);
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
  const { activeId, focus: focusPanel, focusPrevious, enableFocus, disableFocus } = useFocusManager();
  const focus: FocusRegion = activeId === 'tabs' ? 'tabs' : activeId === 'main' ? 'main' : 'tasks';
  const overlayOpen = overlay.kind !== 'none';
  // Ink's focus manager answers Tab itself, including inside a text field; while one is open the panels are
  // taken out of the cycle so a Tab in the palette cannot silently move the focus behind it.
  useEffect(() => {
    if (overlayOpen) disableFocus();
    else enableFocus();
  }, [overlayOpen, enableFocus, disableFocus]);
  const lastPanel = useRef<string>('tasks');
  useEffect(() => {
    if (overlayOpen) return;
    if (activeId) lastPanel.current = activeId;
    if (storedFocus !== focus) store.getState().setFocus(focus);
  }, [activeId, focus, overlayOpen, storedFocus, store]);
  useEffect(() => {
    if (!overlayOpen) focusPanel(lastPanel.current);
  }, [overlayOpen, focusPanel]);

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

  useEffect(() => {
    if (props.finished) {
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [props.finished, exit]);

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

  // ------------------------------------------------------------------ actions
  const setNotice = (text: string) => store.getState().setNotice(text);
  // Stable, so the review view's own per-attempt cache is not thrown away on every spinner frame.
  const loadDiff = useMemo(() => (taskId: string) => controller.capturedDiff(taskId), [controller]);
  const restart = (task: ResolvedTask | undefined): void => {
    if (!task) return;
    // The controller decides, not the screen: it holds the run state this frame is only a picture of, and
    // its rejection is already a sentence written for this notice.
    const attempts = run.tasks[task.id]?.attempts;
    const expected = attempts?.[attempts.length - 1]?.number;
    void controller
      .submit({ kind: 'restart', taskId: task.id }, controlEnvelope('tui', expected ? { attempt: expected } : undefined))
      .then((ack) => setNotice(ack.status === 'rejected' ? (ack.reason ?? `"${task.id}" cannot be restarted.`) : `Restarting ${task.id}…`))
      .catch((err: unknown) => setNotice(`Could not restart ${task.id}: ${(err as Error).message}`));
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

  const paletteEntries: PaletteEntry[] = useMemo(() => {
    const entries: PaletteEntry[] = WORKSPACE_TABS.map((name) => ({
      id: `tab:${name}`,
      label: `Go to ${TAB_LABEL[name]}`,
      hint: 'tab',
      run: () => openTab(name),
    }));
    entries.push(
      { id: 'action:follow', label: 'Follow the selected task', hint: 'F', run: () => follow(selected) },
      { id: 'action:restart', label: 'Restart the selected task', hint: 'R', run: () => restart(selected) },
      { id: 'action:usage', label: 'Usage per task', hint: 'U', run: () => store.getState().setView({ kind: 'usage' }) },
      { id: 'action:help', label: 'Help for the focused panel', hint: '?', run: () => store.getState().setOverlay({ kind: 'help' }) },
      { id: 'action:minimise', label: 'Minimise the workspace', hint: 'Q', run: minimise },
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
  }, [tasks, run, selected, store]);
  const paletteMatches = useMemo(() => filterPalette(paletteEntries, paletteQuery), [paletteEntries, paletteQuery]);

  // ------------------------------------------------------------------ keys
  const inWorkspace = view.kind === 'dashboard' && !pending;
  // The review view owns its own keys (Esc leaves the hunk pane before it leaves the view), so it is not here.
  const detailKeys = (view.kind === 'usage' || view.kind === 'detail') && !pending;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      setNotice('Interrupting: stopping workers… (Ctrl+C again to force)');
      onInterrupt();
    }
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
      } else if (!overlayOpen && input === SHIFT_TAB_SS3 && !key.ctrl && !key.meta) focusPrevious();
    },
    { isActive: inWorkspace },
  );

  // Both of the handlers below are subscribed whenever the shell is up, and each decides from the current
  // overlay whether the key is theirs. Gating them with `isActive` instead reads better but loses keys: Ink
  // subscribes and unsubscribes in a passive effect, so a key that arrives between the press that opened an
  // overlay and React flushing that effect reaches the handler that is on its way out - which is how Esc
  // stopped closing the help panel.
  useInput(
    (input, key) => {
      if (!overlayOpen) return;
      const state = store.getState();
      if (overlay.kind === 'help') {
        if (key.upArrow) state.moveListCursor('help', -1, 200);
        else if (key.downArrow) state.moveListCursor('help', 1, 200);
        else if (key.pageUp) state.moveListCursor('help', -10, 200);
        else if (key.pageDown) state.moveListCursor('help', 10, 200);
        else if (key.escape || input === '?' || input.toLowerCase() === 'q') closeOverlay();
        return;
      }
      const field = overlay.kind === 'palette' ? 'palette' : 'search';
      const query = field === 'palette' ? paletteQuery : search;
      if (key.escape) {
        if (field === 'search') {
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
        else state.setListCursor('palette', 0, paletteEntries.length);
      } else if (field === 'palette' && (key.upArrow || key.downArrow)) {
        state.moveListCursor('palette', key.upArrow ? -1 : 1, paletteMatches.length);
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        // [D15]: inside a text field a printable key is text, whatever it would mean outside it.
        state.setDraft(field, query + input);
        if (field === 'search') state.setCursor(0);
        else state.setListCursor('palette', 0, paletteEntries.length);
      }
    },
    { isActive: inWorkspace },
  );

  useInput(
    (input, key) => {
      if (overlayOpen) return;
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
        if (focus === 'tabs') focusPanel('main');
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
      else if (lower === 'h') state.setOverlay({ kind: 'help' });
      else if (lower === 'q') minimise();
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
          const p = run.tasks[t.id]?.pendingInteraction;
          return `${t.id}${p ? ` (${p.kind}: ${sanitizeText(p.title)})` : ' (approval)'}`;
        })
        .join('   ')
    : undefined;
  const headerRows = headerRowsFor(run);
  const layout = workspaceLayout({ columns, rows, headerRows, notice: Boolean(notice) });
  const spinner = spinnerFrames();
  const runningGlyph = motion ? spinner[frame.current % spinner.length]! : stateGlyph('running');
  const header = <Header run={run} theme={theme} columns={columns} now={now} role={props.role ?? 'owner'} attention={attention} />;

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
              ) : (
                <HelpPanel focus={focus} tab={tab} rows={layout.mainRows} columns={layout.mainWidth} theme={theme} cursor={helpCursor} />
              )
            ) : (
              mainPanel()
            )}
          </Box>
        </Box>
      </Box>
      <Footer
        hints={overlayOpen ? 'Esc close   ↑↓ move   Enter choose' : footerHints(focus, tab)}
        columns={columns}
        theme={theme}
        columnsShown={layout.footerColumns}
        snapshotAge={now - (snapshot?.at ?? now)}
        notice={notice}
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
  const budget = Math.max(1, rows - headerRows - 5 - legend.length);
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

/**
 * Leave the alternate screen if the process dies without unmounting — a crash, a force-kill. Ink restores
 * the primary buffer on unmount, which covers every ordinary exit; this covers the one where the error
 * message would otherwise be printed onto a screen that is about to disappear.
 */
function armAltScreenRestore(): () => void {
  const restore = (): void => {
    try {
      process.stdout.write('[?1049l[?25h');
    } catch {
      /* the stream is already gone; there is nothing left to restore */
    }
  };
  process.once('exit', restore);
  return () => process.removeListener('exit', restore);
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
  let seq = 0;
  let disarm: (() => void) | undefined;

  // One store for the life of the workspace, fed from the bus: a store created per mount would lose the tab
  // and the cursor every time the workspace was minimised and reopened.
  const attached = attachStore(opts.bus, opts.controller);
  const renderTree = opts.mount ?? render;
  const options = workspaceRenderOptions({ flag: opts.altScreen });

  const mount = (): Instance => {
    const created = renderTree(<DashboardApp {...opts} shared={shared} finished={finished} store={attached.store} />, options);
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
      if (instance || finished) return;
      const current = mount();
      void current.waitUntilExit().then(() => {
        if (instance === current) instance = undefined;
      });
    },
    close() {
      if (!instance) return;
      const current = instance;
      instance = undefined;
      current.unmount();
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
      finished = true;
      for (const item of shared.queue.splice(0)) {
        if (item.kind === 'approval') item.resolve('defer');
        else item.resolve({ kind: 'deny', message: 'The run ended' });
      }
      if (!instance) {
        attached.detach();
        disarm?.();
        return;
      }
      const current = instance;
      current.rerender(<DashboardApp {...opts} shared={shared} finished store={attached.store} />);
      await current.waitUntilExit().catch(() => undefined);
      instance = undefined;
      attached.detach();
      disarm?.();
      disarm = undefined;
    },
  };
  return controller;
}
