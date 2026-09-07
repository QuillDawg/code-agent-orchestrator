/**
 * Interactive dashboard (Ink). Subscribes to the event bus and reads the run state owned by the
 * scheduler; it never drives orchestration. Minimising the dashboard (Q) leaves the run going and it can
 * be reopened; anything that needs a human (approval gate, permission prompt, question) reopens it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useInput, useApp, useStdout, type Instance } from 'ink';
import type { WorkflowRun, TaskRunState } from '../types/run.js';
import { ACTIVE_TASK_STATES } from '../types/run.js';
import type { ResolvedTask } from '../types/workflow.js';
import type { EventBus } from '../events/event-bus.js';
import type { WorkflowScheduler } from '../workflow/scheduler.js';
import type { Interaction, InteractionAnswer } from '../types/interaction.js';
import { addUsage } from '../types/result.js';
import { stateGlyph, STATE_LABEL, STATE_COLOR, summarize } from '../workflow/states.js';
import { formatDuration, formatDurationShort, formatClock } from '../util/duration.js';
import type { TranscriptEntry } from '../types/transcript.js';
import { renderTranscript } from './transcript.js';
import { TranscriptViewer, type ViewerTask } from './viewer.js';
import { Modal, type PendingItem } from './dashboard/modal.js';
import { ReviewView, type ReviewTaskInput } from './dashboard/review.js';
import { fileLabel, taskFiles } from './dashboard/files.js';
import { activityCell, ACTIVITY_LOOKBACK } from './dashboard/activity.js';
import { paint, sanitizeText } from '../cli/color.js';
import { BELL } from '../util/misc.js';
import { agentLabel, bar, contextRatio, formatCost, formatTokens } from './format.js';
import { attemptRows, currentAttempt, elapsedCell, elapsedParts, interactionRows, resultNotes, totalWaitedMs } from './history.js';

export interface DashboardOptions {
  run: WorkflowRun;
  bus: EventBus;
  scheduler: WorkflowScheduler;
  /** Q pressed: the controller unmounts; the caller switches to line output until reopen. */
  onMinimise: () => void;
  onInterrupt: () => void;
  /** Mounts the Ink tree; defaults to ink's render. Injected by tests so the queue can be driven without a TTY. */
  mount?: typeof render;
}

export interface DashboardController {
  /** Mount the dashboard (no-op when already open). */
  open(): void;
  /** Unmount it, leaving the run going. */
  close(): void;
  readonly isOpen: boolean;
  requestApproval(task: ResolvedTask): Promise<{ decision: 'approved' | 'rejected'; note?: string } | 'defer'>;
  requestInteraction(interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer>;
  /** The run ended: show the final frame, then unmount. */
  finish(): Promise<void>;
}

type View = { kind: 'dashboard' } | { kind: 'detail'; taskId: string } | { kind: 'follow'; taskId: string; attempt?: number } | { kind: 'usage' } | { kind: 'review' } | { kind: 'help' };

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Attempts and interactions shown in the detail view; the rest are one `cao task` away. */
const MAX_HISTORY_ROWS = 6;

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
}

/** The dashboard component; exported for rendering in tests. */
export function DashboardApp(props: AppProps): React.JSX.Element {
  const { run, bus, scheduler, onMinimise, onInterrupt } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, setTick] = useState(0);
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingItem | null>(props.shared.queue[0] ?? null);
  const [usageSort, setUsageSort] = useState<'order' | 'cost'>('order');
  const [pastAttempt, setPastAttempt] = useState<{ taskId: string; attempt: number; entries: TranscriptEntry[] } | null>(null);
  const frame = useRef(0);
  const entriesCache = useRef<{ taskId: string; value: TranscriptEntry[] } | undefined>(undefined);
  const tasks = useMemo(() => run.workflow.tasks, [run]);
  // Stable, so the review view's own cache is not thrown away on every spinner frame.
  const loadDiff = useMemo(() => (taskId: string) => scheduler.capturedDiff(taskId), [scheduler]);
  const rows = stdout?.rows ?? 30;
  const columns = stdout?.columns ?? 100;
  const color = true;
  const anyRunning = tasks.some((t) => ACTIVE_TASK_STATES.has(run.tasks[t.id]?.state ?? 'pending'));

  useEffect(() => {
    let scheduled = false;
    const off = bus.onAny(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        setTick((t) => t + 1);
      }, 80);
    });
    const onQueue = (): void => setPending(props.shared.queue[0] ?? null);
    props.shared.listeners.add(onQueue);
    onQueue();
    return () => {
      off();
      props.shared.listeners.delete(onQueue);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus]);

  useEffect(() => {
    const timer = setInterval(() => {
      frame.current = (frame.current + 1) % SPINNER.length;
      setTick((t) => t + 1);
    }, anyRunning ? 120 : 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  useEffect(() => {
    if (props.finished) {
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [props.finished, exit]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

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
    void scheduler
      .attemptTranscript(pastTaskId, pastAttemptNumber)
      .then(done)
      .catch(() => done([]));
    return () => {
      cancelled = true;
    };
  }, [pastTaskId, pastAttemptNumber, scheduler]);

  const dashboardKeys = view.kind === 'dashboard' && !pending;
  // The review view owns its own keys (Esc leaves the hunk pane before it leaves the view), so it is not here.
  const detailKeys = (view.kind === 'detail' || view.kind === 'usage' || view.kind === 'help') && !pending;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      setNotice('Interrupting: stopping workers… (Ctrl+C again to force)');
      onInterrupt();
    }
  });

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (key.escape || lower === 'q' || key.backspace) setView({ kind: 'dashboard' });
      else if (view.kind === 'detail' && (lower === 'f' || lower === 'l' || key.return)) setView({ kind: 'follow', taskId: view.taskId });
      else if (view.kind === 'usage' && lower === 's') setUsageSort((s) => (s === 'order' ? 'cost' : 'order'));
    },
    { isActive: detailKeys },
  );

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(tasks.length - 1, c + 1));
      else if (key.return) {
        const waiting = tasks.find((t) => run.tasks[t.id]?.state === 'waiting');
        if (waiting && props.shared.queue.length) return; // the modal is about to show
        setView({ kind: 'detail', taskId: tasks[cursor]!.id });
      } else if (lower === 'l' || lower === 'f') setView({ kind: 'follow', taskId: tasks[cursor]!.id });
      else if (lower === 'u') setView({ kind: 'usage' });
      else if (lower === 'c') setView({ kind: 'review' });
      else if (input === '?' || lower === 'h') setView({ kind: 'help' });
      else if (lower === 'r') {
        const selected = tasks[cursor]!;
        const state = run.tasks[selected.id]?.state;
        if (state && ['failed', 'blocked', 'cancelled'].includes(state)) {
          scheduler.requestRestart(selected.id);
          setNotice(`Restarting ${selected.id}…`);
        } else setNotice('Only failed, blocked, or cancelled tasks can be restarted while this run is active.');
      } else if (lower === 'q') {
        onMinimise();
        exit();
      }
    },
    { isActive: dashboardKeys },
  );

  const now = Date.now();
  const summary = summarize(run);
  const running = tasks.filter((t) => run.tasks[t.id]?.state === 'running').length;
  const waitingTasks = tasks.filter((t) => run.tasks[t.id]?.state === 'waiting' || run.tasks[t.id]?.state === 'awaiting_approval');
  const done = summary.success + summary.skipped;
  const elapsed = run.startedAt ? formatDuration(now - new Date(run.startedAt).getTime()) : '';
  const totalUsage = addUsage(...tasks.flatMap((t) => run.tasks[t.id]?.attempts.map((a) => a.usage) ?? []));
  const idWidth = Math.min(28, Math.max(12, ...tasks.map((t) => t.id.length)));

  const progressBar = (): string => {
    const width = 20;
    const seg = (n: number): number => Math.round((n / Math.max(1, summary.total)) * width);
    let s = paint('█'.repeat(seg(summary.success)), 'green');
    s += paint('█'.repeat(seg(summary.failed + summary.blocked + summary.cancelled)), 'red');
    s += paint('█'.repeat(seg(running + waitingTasks.length)), 'cyan');
    const used = seg(summary.success) + seg(summary.failed + summary.blocked + summary.cancelled) + seg(running + waitingTasks.length);
    s += paint('░'.repeat(Math.max(0, width - used)), 'gray');
    return s;
  };

  const header = (
    <Box flexDirection="column">
      <Text>
        <Text bold>{run.workflowName}</Text>
        <Text dimColor>
          {'  '}run {run.runId}  ·  {run.repositoryRoot}
        </Text>
      </Text>
      <Text>
        [{progressBar()}] {done}/{summary.total}   {paint(`✓${summary.success}`, 'green')} {paint(`✗${summary.failed + summary.blocked}`, summary.failed + summary.blocked ? 'red' : 'gray')} {paint(`▶${running}`, 'cyan')}
        {waitingTasks.length ? ` ${paint(`?${waitingTasks.length}`, ['yellow', 'bold'])}` : ''}   Elapsed {elapsed}   Concurrency {running}/{run.workflow.execution.maxConcurrency}
        {totalUsage.costUsd !== undefined ? `   Cost ${formatCost(totalUsage.costUsd)}` : ''}
        {totalUsage.inputTokens ? paint(`   ${formatTokens(totalUsage.inputTokens)} in / ${formatTokens(totalUsage.outputTokens ?? 0)} out`, 'dim') : ''}
        {props.finished ? `   State: ${run.state}` : ''}
      </Text>
      {waitingTasks.length > 0 && (
        <Text wrap="truncate-end">
          {paint('? Needs you: ', ['yellow', 'bold'])}
          {waitingTasks
            .map((t) => {
              const p = run.tasks[t.id]?.pendingInteraction;
              return `${t.id}${p ? ` (${p.kind}: ${sanitizeText(p.title)})` : ' (approval)'}`;
            })
            .join('   ')}
        </Text>
      )}
    </Box>
  );

  if (pending) {
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Modal
          key={pending.id}
          item={pending}
          queued={props.shared.queue.length - 1}
          width={columns}
          height={rows}
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

  /** What the review view starts from: the live tool-stream list, until it has read the attempt's own diff. */
  const reviewTasks = (): ReviewTaskInput[] =>
    tasks.map((t) => {
      const st = run.tasks[t.id]!;
      return { taskId: t.id, state: st.state, live: ACTIVE_TASK_STATES.has(st.state), attempts: st.attempts.length, files: taskFiles(st) };
    });

  /**
   * The buffer is re-read on every frame (the spinner ticks ~8x/second), and a fresh array would defeat the
   * viewer's own memo, re-wrapping and re-highlighting the whole transcript each time. Reuse the previous
   * array while the buffer has not grown or been replaced.
   */
  const followEntries = (taskId: string): TranscriptEntry[] => {
    const next = scheduler.transcript(taskId);
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
        color={color}
        onSelectTask={(id) => {
          setView({ kind: 'follow', taskId: id });
          setCursor(Math.max(0, tasks.findIndex((t) => t.id === id)));
        }}
        // Choosing the newest attempt goes back to the live buffer, so the view keeps following the worker.
        onSelectAttempt={(attempt) => setView({ kind: 'follow', taskId: view.taskId, attempt: attempt === live ? undefined : attempt })}
        // The live view's buffer spans every attempt of the task, so its pager has to as well; a chosen past
        // attempt is scoped to that attempt's file, exactly as `cao logs -a N` is.
        loadOlder={
          followAttempt === undefined
            ? undefined
            : view.attempt === undefined
              ? (oldest) => scheduler.olderTaskTranscript(view.taskId, followAttempt, oldest)
              : (oldest) => scheduler.olderTranscript(view.taskId, followAttempt, oldest)
        }
        onExit={() => setView({ kind: 'dashboard' })}
        footerHint="Q/Esc dashboard"
      />
    );
  }

  if (view.kind === 'help') {
    return (
      <Box flexDirection="column">
        <Text bold>Keys</Text>
        <Text> </Text>
        <Text>  ↑↓        select a task            Enter     task details</Text>
        <Text>  F / L     follow a task's transcript</Text>
        <Text dimColor>              ←→/Tab or 1-9 switch task   P task picker   [ ] earlier/later attempt</Text>
        <Text dimColor>              ↑↓ PgUp/PgDn scroll   g oldest line   G newest line and follow again</Text>
        <Text dimColor>              t expand tool output and subagent entries   T show thinking</Text>
        <Text dimColor>              / search   n/N next/previous match   k cycle the kind filter</Text>
        <Text dimColor>              scrolling past the top pages older entries in from disk   Esc/Q back</Text>
        <Text>  U         usage: tokens, context, cost, time in tools per task    (S sort by cost)</Text>
        <Text>  C         review what each task changed</Text>
        <Text dimColor>              list: ↑↓ PgUp/PgDn select   g/G first/last   Enter open the hunks   O $VISUAL/$EDITOR   Esc back</Text>
        <Text dimColor>              hunks: ↑↓ PgUp/PgDn scroll   g/G top/bottom   N/P hunk   ←→ file   O editor   Esc back to the list</Text>
        <Text>  R         restart a failed, blocked or cancelled task</Text>
        <Text>  Q         minimise the dashboard (the run continues; D reopens it)</Text>
        <Text>  Ctrl+C    stop the run (twice to force)</Text>
        <Text> </Text>
        <Text>  When a worker needs you, a prompt appears here automatically:</Text>
        <Text>  Y allow   A allow for the rest of the task   N deny   R deny with a reason</Text>
        <Text>  1-9 / ↑↓ Enter choose an answer   T type an answer   N decline</Text>
        <Text> </Text>
        <Text dimColor>Esc/Q back</Text>
      </Box>
    );
  }

  if (view.kind === 'usage') {
    const list = [...tasks].map((t) => ({ t, st: run.tasks[t.id]!, u: taskUsage(run.tasks[t.id]!) }));
    if (usageSort === 'cost') list.sort((a, b) => (b.u.costUsd ?? 0) - (a.u.costUsd ?? 0));
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Text bold>
          {'  '}
          {'Task'.padEnd(idWidth)}  {'State'.padEnd(11)} {'Cost'.padStart(7)} {'In'.padStart(7)} {'Out'.padStart(7)} {'Cache r/w'.padStart(11)} {'Turns'.padStart(5)} {'Time'.padStart(6)} {'Tools'.padStart(6)}  Context
        </Text>
        {list.map(({ t, st, u }) => {
          const ratio = contextRatio(u);
          const ctx = u.contextTokens !== undefined ? `${formatTokens(u.contextTokens)}${u.contextWindow ? `/${formatTokens(u.contextWindow)}` : ''}` : '';
          const ctxStyle = ratio === undefined ? 'dim' : ratio >= 0.9 ? 'red' : ratio >= 0.7 ? 'yellow' : 'green';
          // Cache reads and cache writes share one cell: two more full columns would push the context bar off
          // an 80-column terminal, and the pair is only ever read together.
          const cache = u.cacheReadTokens !== undefined || u.cacheCreationTokens !== undefined ? `${formatTokens(u.cacheReadTokens ?? 0)}/${formatTokens(u.cacheCreationTokens ?? 0)}` : '';
          return (
            <Text key={t.id} wrap="truncate-end">
              {'  '}
              {t.id.padEnd(idWidth)}  {paint(STATE_LABEL[st.state].padEnd(11), STATE_COLOR[st.state])} {(u.costUsd !== undefined ? formatCost(u.costUsd) : '').padStart(7)} {(u.inputTokens !== undefined ? formatTokens(u.inputTokens) : '').padStart(7)}{' '}
              {(u.outputTokens !== undefined ? formatTokens(u.outputTokens) : '').padStart(7)} {cache.padStart(11)} {String(u.numTurns ?? '').padStart(5)} {(u.durationMs !== undefined ? formatDurationShort(u.durationMs) : '').padStart(6)} {paint((u.toolMs !== undefined ? formatDurationShort(u.toolMs) : '').padStart(6), 'cyan')}  {ratio !== undefined ? paint(`[${bar(ratio, 8)}] `, ctxStyle as 'red') : ''}
              {paint(ctx, ctxStyle as 'red')}
              {u.compactions ? paint(`  ${u.compactions} compaction${u.compactions === 1 ? '' : 's'}`, 'dim') : ''}
            </Text>
          );
        })}
        <Text> </Text>
        <Text>
          Total: {formatCost(totalUsage.costUsd ?? 0)}   {formatTokens(totalUsage.inputTokens ?? 0)} in / {formatTokens(totalUsage.outputTokens ?? 0)} out
          {totalUsage.cacheCreationTokens ? `   ${formatTokens(totalUsage.cacheCreationTokens)} cache write` : ''}
          {totalUsage.durationMs !== undefined ? `   ${formatDuration(totalUsage.durationMs)} of agent time` : ''}
          {totalUsage.toolMs !== undefined ? `   ${formatDuration(totalUsage.toolMs)} in tools` : ''}
        </Text>
        <Text dimColor>Cache r/w = tokens read from / written to the prompt cache   Time = duration the agent reported   Tools = time spent inside tool calls</Text>
        <Text dimColor>S sort by {usageSort === 'order' ? 'cost' : 'workflow order'}   Esc/Q back</Text>
      </Box>
    );
  }

  if (view.kind === 'review') {
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Text bold>Review</Text>
        <ReviewView
          tasks={reviewTasks()}
          width={columns}
          height={Math.max(6, rows - 8)}
          color={color}
          root={run.repositoryRoot}
          loadDiff={loadDiff}
          isActive={!pending}
          onExit={() => setView({ kind: 'dashboard' })}
        />
      </Box>
    );
  }

  if (view.kind === 'detail') {
    const task = tasks.find((t) => t.id === view.taskId)!;
    const st = run.tasks[task.id]!;
    const attempt = currentAttempt(st);
    const u = attempt?.usage ?? st.result?.usage;
    const files = taskFiles(st);
    const history = attemptRows(st, now);
    const shownHistory = history.slice(-MAX_HISTORY_ROWS);
    const interactions = interactionRows(st, now);
    const shownInteractions = interactions.slice(-MAX_HISTORY_ROWS);
    const notes = resultNotes(st.result);
    // The blocks below push the transcript down, so it gets what is left rather than a fixed ten lines.
    const blockLines =
      (shownHistory.length ? 2 + shownHistory.reduce((n, r) => n + 1 + r.notes.length, 0) + (history.length > shownHistory.length ? 1 : 0) : 0) +
      (shownInteractions.length ? 3 + shownInteractions.length + (interactions.length > shownInteractions.length ? 1 : 0) : 0) +
      (notes.length ? 2 + notes.reduce((n, g) => n + 1 + g.items.length, 0) : 0);
    const entries = scheduler.peek(task.id, 8);
    const lines = renderTranscript(entries, { color, width: Math.max(20, columns - 4), timestamps: columns >= 100 ? true : 'short' }).slice(-Math.max(3, Math.min(10, rows - 18 - blockLines)));
    const ratio = contextRatio(u);
    return (
      <Box flexDirection="column">
        <Text bold>{task.id}</Text>
        <Text dimColor>{'─'.repeat(Math.min(60, columns))}</Text>
        <Text>
          Status:       <Text color={STATE_COLOR[st.state]}>{STATE_LABEL[st.state]}</Text>
          {st.message ? `  (${sanitizeText(st.message).split('\n')[0]})` : ''}
          {st.pendingInteraction ? paint(`  waiting for you: ${sanitizeText(st.pendingInteraction.title)}`, 'yellow') : ''}
        </Text>
        {attempt && (
          <>
            <Text>
              Attempt:      {attempt.number}
              {task.retry.attempts ? ` / ${task.retry.attempts + 1}` : ''}
              {attempt.kind === 'merge' ? ' (merge resolution)' : ''}
            </Text>
            <Text>
              Agent:        {task.agent}  Model: {u?.model ?? task.model ?? 'CLI default'}  Effort: {task.effort ?? 'CLI default'}
            </Text>
            {task.agent === 'codex' && (
              <Text>
                Permissions:  {task.codex.permissionMode ?? 'auto'}  {task.codex.sandbox ?? ''} {task.codex.approvalPolicy ?? ''}
              </Text>
            )}
            <Text>
              Started:      {formatClock(attempt.startedAt)}   Elapsed: {elapsedCell(st, now)}
            </Text>
            <Text>
              PID:          {attempt.pid ?? '-'}   Session: {attempt.sessionId ?? '-'}
            </Text>
            <Text>Working Dir:  {attempt.cwd}</Text>
            {attempt.workspace?.branch && <Text>Branch:       {attempt.workspace.branch}</Text>}
          </>
        )}
        {task.dependsOn.length > 0 && <Text>Depends On:   {task.dependsOn.map((d) => `${stateGlyph(run.tasks[d]?.state ?? 'pending')} ${d}`).join('  ')}</Text>}
        {task.context?.sources.length ? <Text>Context:      {task.context.sources.map((s) => s.taskId).join(', ')}</Text> : null}
        {u && (
          <Text>
            Usage:        {u.costUsd !== undefined ? `${formatCost(u.costUsd)}  ` : ''}
            {u.inputTokens !== undefined ? `${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens ?? 0)} out  ` : ''}
            {u.numTurns !== undefined ? `${u.numTurns} turns  ` : ''}
            {ratio !== undefined ? `context ${paint(`[${bar(ratio, 12)}] ${Math.round(ratio * 100)}%`, ratio >= 0.9 ? 'red' : ratio >= 0.7 ? 'yellow' : 'green')} ${formatTokens(u.contextTokens ?? 0)}/${formatTokens(u.contextWindow ?? 0)}` : ''}
            {u.compactions ? paint(`  ${u.compactions} compaction${u.compactions === 1 ? '' : 's'}`, 'dim') : ''}
          </Text>
        )}
        {files.length > 0 && (
          <Text wrap="truncate-end">
            Files:        ±{files.length}  {files.slice(0, 6).map(fileLabel).join(', ')}
            {files.length > 6 ? ` … +${files.length - 6} (C for all)` : ''}
          </Text>
        )}
        {shownHistory.length > 0 && (
          <>
            <Text> </Text>
            <Text bold>Attempts</Text>
            {history.length > shownHistory.length && <Text dimColor>{`  … ${history.length - shownHistory.length} earlier attempt${history.length - shownHistory.length === 1 ? '' : 's'} (cao task ${task.id})`}</Text>}
            {shownHistory.map((row) => (
              <React.Fragment key={row.number}>
                <Text wrap="truncate-end">{`  ${row.line}`}</Text>
                {row.notes.map((note, i) => (
                  <Text key={i} dimColor wrap="truncate-end">{`      ↳ ${note}`}</Text>
                ))}
              </React.Fragment>
            ))}
          </>
        )}
        {shownInteractions.length > 0 && (
          <>
            <Text> </Text>
            <Text bold>Interactions</Text>
            {interactions.length > shownInteractions.length && <Text dimColor>{`  … ${interactions.length - shownInteractions.length} earlier (cao task ${task.id})`}</Text>}
            {shownInteractions.map((row) => (
              <Text key={`${row.attempt}-${row.record.id}`} wrap="truncate-end">{`  ${row.line}`}</Text>
            ))}
            <Text dimColor>{`  waited ${formatDuration(totalWaitedMs(interactions))} in total across ${interactions.length} request${interactions.length === 1 ? '' : 's'}`}</Text>
          </>
        )}
        {notes.length > 0 && (
          <>
            <Text> </Text>
            <Text bold>Result</Text>
            {notes.map((group) => (
              <React.Fragment key={group.label}>
                <Text>{`  ${group.label}:`}</Text>
                {group.items.map((item, i) => (
                  <Text key={i} wrap="truncate-end">{`    - ${sanitizeText(item)}`}</Text>
                ))}
              </React.Fragment>
            ))}
          </>
        )}
        <Text> </Text>
        <Text bold>Latest activity</Text>
        {lines.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {'  '}
            {l}
          </Text>
        ))}
        {lines.length === 0 && <Text dimColor>  (no output yet)</Text>}
        <Text> </Text>
        <Text dimColor>F/Enter follow live transcript   Esc/Q back</Text>
      </Box>
    );
  }

  const maxRows = Math.max(3, rows - 12);
  const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), tasks.length - maxRows));
  const visible = tasks.slice(start, start + maxRows);
  // The current attempt sits in parentheses after the total, and only a retried task has one. Padded to the
  // widest one on screen it is a column like any other; padded to nothing, one retried task shifts every
  // cell after it — agent, ctx, cost, ±files, activity — right on that row alone, exactly when the table is
  // worth reading. Zero when no task was retried, so nothing is paid for the common case.
  const currentWidth = Math.max(0, ...visible.map((t) => elapsedParts(run.tasks[t.id]!, now).current).map((c) => (c ? c.length + 3 : 0)));
  return (
    <Box flexDirection="column">
      {header}
      <Text> </Text>
      {visible.map((t, i) => {
        const idx = start + i;
        const st = run.tasks[t.id]!;
        const a = currentAttempt(st);
        const u = a?.usage ?? st.result?.usage;
        const glyph = st.state === 'running' ? SPINNER[frame.current]! : st.state === 'waiting' ? (frame.current % 4 < 2 ? '?' : ' ') : stateGlyph(st.state);
        const files = taskFiles(st).length;
        const elapsed = elapsedParts(st, now);
        const ratio = contextRatio(u);
        const ctx = u?.contextTokens !== undefined && ACTIVE_TASK_STATES.has(st.state) ? paint(`ctx ${formatTokens(u.contextTokens)}${u.contextWindow ? `/${formatTokens(u.contextWindow)}` : ''}`, ratio !== undefined && ratio >= 0.9 ? 'red' : ratio !== undefined && ratio >= 0.7 ? 'yellow' : 'dim') : '';
        const cost = u?.costUsd !== undefined ? paint(formatCost(u.costUsd), 'dim') : '';
        const activity = activityCell({
          task: t,
          state: st,
          entries: scheduler.peek(t.id, ACTIVITY_LOOKBACK),
          startedAt: a?.startedAt,
          pendingDeps: st.state === 'pending' ? t.dependsOn.filter((d) => !['success', 'skipped'].includes(run.tasks[d]?.state ?? '')) : [],
          now,
          color,
        });
        return (
          <Text key={t.id} wrap="truncate-end">
            {idx === cursor ? paint('▶ ', 'cyan') : '  '}
            {paint(glyph, STATE_COLOR[st.state])} {idx === cursor ? paint(t.id.padEnd(idWidth), ['inverse', 'bold']) : t.id.padEnd(idWidth)}  {paint(STATE_LABEL[st.state].padEnd(11), STATE_COLOR[st.state])} {elapsed.total.padStart(9)}
            {currentWidth ? paint((elapsed.current ? ` (${elapsed.current})` : '').padEnd(currentWidth), 'dim') : ''}  {paint(agentLabel(t.agent, u?.model ?? t.model), 'magenta')}
            {ctx ? `  ${ctx}` : ''}
            {cost ? `  ${cost}` : ''}
            {files ? paint(`  ±${files}`, 'dim') : ''}
            {activity ? `  │ ${activity}` : ''}
          </Text>
        );
      })}
      {tasks.length > maxRows && (
        <Text dimColor>
          {'  '}… {tasks.length} tasks, showing {start + 1}-{start + visible.length}
        </Text>
      )}
      <Text> </Text>
      {notice && <Text color="yellow">{notice}</Text>}
      <Text dimColor wrap="truncate-end">
        ↑↓ select  Enter details  F follow  U usage  C files  R restart  ? help  Q minimise (run continues)  Ctrl+C stop
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
  let seq = 0;

  const renderTree = opts.mount ?? render;
  const mount = (): Instance => {
    const created = renderTree(<DashboardApp {...opts} shared={shared} finished={finished} />, { exitOnCtrlC: false, patchConsole: false });
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
      if (!instance) return;
      const current = instance;
      current.rerender(<DashboardApp {...opts} shared={shared} finished />);
      await current.waitUntilExit().catch(() => undefined);
      instance = undefined;
    },
  };
  return controller;
}
