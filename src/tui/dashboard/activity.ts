/**
 * The dashboard table's activity cell: one line saying what a worker is doing right now.
 *
 * It answers three questions the table used to get wrong: which *action* is running (a long tool result
 * used to mask the tool that produced it), whether a silent worker is still alive (the idle marker), and
 * why a row that is neither running nor finished is sitting there (a retry backoff).
 */
import type { TaskRunState } from '../../types/run.js';
import { ACTIVE_TASK_STATES } from '../../types/run.js';
import type { ResolvedTask } from '../../types/workflow.js';
import { transcriptLine, type TranscriptEntry } from '../../types/transcript.js';
import { budgetedFailures } from '../../workflow/scheduler.js';
import { formatDurationShort } from '../../util/duration.js';
import { paint, sanitizeText } from '../../cli/color.js';

/**
 * A worker that has produced nothing for this long is thinking, stuck in a tool, or waiting on the API —
 * either way the operator wants to see it. Deliberately a constant: a threshold nobody would tune.
 */
export const IDLE_AFTER_MS = 30_000;

/** How many recent entries the cell needs to see to find the last action behind a run of tool results. */
export const ACTIVITY_LOOKBACK = 30;

/**
 * The newest entry that says what the worker is *doing*; a `tool_result` is the answer, not the action, and
 * thinking is opt-in, so neither may claim the cell. The idle marker still counts thinking, because an
 * agent that is thinking is alive.
 */
export function lastAction(entries: readonly TranscriptEntry[]): TranscriptEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind !== 'tool_result' && entry.kind !== 'thinking') return entry;
  }
  return undefined;
}

function millisSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : now - t;
}

/** Time since the newest entry of any kind (or since the attempt started), once it passes the threshold. */
export function idleMs(entries: readonly TranscriptEntry[], startedAt: string | undefined, now: number): number | undefined {
  const ms = millisSince(entries[entries.length - 1]?.ts, now) ?? millisSince(startedAt, now);
  return ms !== undefined && ms >= IDLE_AFTER_MS ? ms : undefined;
}

/**
 * `api retry 2/5 in 12s` while a transient API error backs off, `retry 1/2 in 30s` for an ordinary retry —
 * the same counters the scheduler is spending, so the row matches what it decided (`task.retrying`).
 */
export function retryLabel(state: TaskRunState, task: ResolvedTask, now: number): string | undefined {
  if (state.state !== 'ready' || !state.retryNotBefore) return undefined;
  const left = new Date(state.retryNotBefore).getTime() - now;
  const when = Number.isNaN(left) ? '' : left > 0 ? ` in ${formatDurationShort(left)}` : ' now';
  const budget = budgetedFailures(state, task);
  if (state.reason === 'api_error' && budget.transientStreak > 0) return `api retry ${budget.transientStreak}/${task.retry.transientAttempts}${when}`;
  const counted = Math.min(Math.max(1, budget.counted), task.retry.attempts);
  return task.retry.attempts > 0 ? `retry ${counted}/${task.retry.attempts}${when}` : `retry${when}`;
}

export interface ActivityCellInput {
  task: ResolvedTask;
  state: TaskRunState;
  /** The task's most recent transcript entries, oldest first (`scheduler.peek`). */
  entries: readonly TranscriptEntry[];
  /** When the current attempt started, so a worker that has said nothing yet can still look idle. */
  startedAt?: string;
  /** Dependencies that have not finished, for a task still waiting its turn. */
  pendingDeps?: readonly string[];
  now: number;
  color?: boolean;
}

/** The activity cell, already coloured. Empty when there is nothing worth saying about the row. */
export function activityCell(input: ActivityCellInput): string {
  const { task, state, entries, startedAt, pendingDeps = [], now, color = true } = input;
  if (state.state === 'waiting' && state.pendingInteraction) {
    return paint(`needs you: ${sanitizeText(state.pendingInteraction.title)}`, ['yellow', 'bold'], color);
  }
  const retry = retryLabel(state, task, now);
  if (retry) return paint(retry, state.reason === 'api_error' ? 'yellow' : 'dim', color);

  if (ACTIVE_TASK_STATES.has(state.state)) {
    const idle = idleMs(entries, startedAt, now);
    const marker = idle === undefined ? '' : paint(`  … ${formatDurationShort(idle)} idle`, 'dim', color);
    const action = lastAction(entries);
    if (!action) return marker.trimStart();
    const line = sanitizeText(transcriptLine(action));
    const style = action.kind === 'command' ? 'yellow' : action.kind === 'tool' ? 'cyan' : action.kind === 'error' || action.kind === 'stderr' ? 'red' : undefined;
    return `${style ? paint(line, style, color) : line}${marker}`;
  }
  if (pendingDeps.length) return paint(`waiting for: ${pendingDeps.join(', ')}`, 'dim', color);
  if (state.message) return paint(sanitizeText(state.message).split('\n')[0] ?? '', state.state === 'failed' || state.state === 'blocked' ? 'red' : 'dim', color);
  return '';
}
