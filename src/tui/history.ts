/**
 * Attempt and interaction history: what every attempt of a task did, and every time it stopped to ask a
 * human. All of it is already persisted on the attempt; these render it. Shared by `cao task` and the
 * dashboard detail view so both tell the same story about a task that was retried, resumed or kept waiting.
 */
import { ACTIVE_TASK_STATES, type AttemptOutcome, type TaskAttempt, type TaskRunState } from '../types/run.js';
import type { InteractionAnswerSource, InteractionRecord } from '../types/interaction.js';
import type { TaskResult } from '../types/result.js';
import { formatClock, formatDuration, formatDurationShort } from '../util/duration.js';
import { firstLine, truncate } from '../util/misc.js';
import { sanitizeText } from '../util/text.js';
import { formatCost } from './format.js';

export const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  success: 'success',
  failed: 'failed',
  blocked: 'blocked',
  needs_input: 'needs input',
  skipped: 'skipped',
  timeout: 'timed out',
  crash: 'crashed',
  api_error: 'transient API error',
  invalid_result: 'invalid result',
  merge_conflict: 'merge conflict',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

export const TRIGGER_LABEL: Record<TaskAttempt['triggeredBy'], string> = {
  initial: 'initial',
  retry: 'retry',
  resume: 'resume',
  user_input: 'user input',
};

/** How the orchestrator came back for another attempt; `initial` never has a previous attempt to explain. */
const TRIGGER_VERB: Record<TaskAttempt['triggeredBy'], string> = {
  initial: '',
  retry: 'retried',
  resume: 'resumed with the run',
  user_input: 'restarted with your answer',
};

const ANSWER_LABEL: Record<NonNullable<InteractionRecord['answer']>, string> = {
  allow: 'allowed',
  allow_always: 'allowed for the rest of the task',
  deny: 'denied',
  answer: 'answered',
};

const SOURCE_LABEL: Record<InteractionAnswerSource, string> = {
  handler: 'in the dashboard',
  no_handler: 'no dashboard attached',
  timeout: 'timed out',
  cancelled: 'withdrawn by the worker',
  aborted: 'the dashboard could not answer',
};

/** An error or a title as one short, terminal-safe line: these end up in a cell next to other fields. */
function oneLine(text: string | undefined, max = 160): string {
  return text ? truncate(firstLine(sanitizeText(text)), max) : '';
}

export function currentAttempt(state: TaskRunState): TaskAttempt | undefined {
  if (state.currentAttempt !== undefined) return state.attempts.find((a) => a.number === state.currentAttempt);
  return state.attempts[state.attempts.length - 1];
}

/** True while a live worker is on this attempt: it has not ended and the task is still running or waiting. */
function isLive(state: TaskRunState, a: TaskAttempt): boolean {
  if (a.endedAt || !ACTIVE_TASK_STATES.has(state.state)) return false;
  return state.currentAttempt === undefined || state.currentAttempt === a.number;
}

/** How long an attempt ran, or has been running. Undefined when it never ended and nothing is running it. */
export function attemptElapsedMs(state: TaskRunState, a: TaskAttempt, now = Date.now()): number | undefined {
  const start = new Date(a.startedAt).getTime();
  if (!Number.isFinite(start)) return undefined;
  const end = a.endedAt ? new Date(a.endedAt).getTime() : isLive(state, a) ? now : undefined;
  if (end === undefined || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

/**
 * Time the task actually spent working, summed over its attempts, and the current attempt on its own. The
 * gaps between attempts (retry backoff, a task sitting ready for a free slot) belong to the run, not to it.
 */
export function taskElapsed(state: TaskRunState, now = Date.now()): { totalMs: number; currentMs?: number; attempts: number } {
  let totalMs = 0;
  let known = false;
  for (const a of state.attempts) {
    const ms = attemptElapsedMs(state, a, now);
    if (ms !== undefined) {
      totalMs += ms;
      known = true;
    }
  }
  const current = currentAttempt(state);
  return { totalMs: known ? totalMs : 0, currentMs: current ? attemptElapsedMs(state, current, now) : undefined, attempts: state.attempts.length };
}

/**
 * The elapsed cell of a table row: total across attempts, plus the current attempt on its own once there is
 * more than one. Empty for a task that has not started, so a pending row stays blank rather than showing 0.
 */
export function elapsedParts(state: TaskRunState, now = Date.now()): { total: string; current?: string } {
  const { totalMs, currentMs, attempts } = taskElapsed(state, now);
  if (attempts === 0 || (totalMs === 0 && currentMs === undefined)) return { total: '' };
  return { total: formatDuration(totalMs), current: attempts > 1 && currentMs !== undefined ? formatDuration(currentMs) : undefined };
}

export function elapsedCell(state: TaskRunState, now = Date.now()): string {
  const { total, current } = elapsedParts(state, now);
  return current ? `${total} (${current})` : total;
}

/** What earned this attempt: how the orchestrator came back, and what the previous attempt left behind. */
export function attemptReason(attempts: TaskAttempt[], index: number): string | undefined {
  const a = attempts[index];
  const prev = index > 0 ? attempts[index - 1] : undefined;
  if (!a || !prev || a.triggeredBy === 'initial') return undefined;
  const outcome = prev.outcome ? (OUTCOME_LABEL[prev.outcome] ?? prev.outcome) : 'no recorded outcome';
  const session = a.resumedSessionId ? `, continuing session ${a.resumedSessionId.slice(0, 8)}` : '';
  // A run written by an older build can carry a trigger or an outcome this one has no word for; the sentence
  // still has to read as a sentence rather than putting `undefined` in front of a reader.
  return `${TRIGGER_VERB[a.triggeredBy] ?? 'started again'} after attempt ${prev.number} ${outcome}${session}`;
}

export interface AttemptRow {
  number: number;
  /** `#2  task  retry  10:12:30 → 10:15:00  02m 30s  success  exit 0  45s in tools  $1.20` */
  line: string;
  /** The retry reason, then this attempt's own error: one indented note each. */
  notes: string[];
  /** Why the orchestrator started this attempt; unset for the first one. */
  reason?: string;
  durationMs?: number;
}

export function attemptRows(state: TaskRunState, now = Date.now()): AttemptRow[] {
  return state.attempts.map((a, i) => {
    const durationMs = attemptElapsedMs(state, a, now);
    // A run directory written by another build can name a trigger or an outcome this one has no label for.
    // `attemptReason` and the report both fall back to the raw value; putting `undefined` in a cell here
    // would make the same records read differently in `cao task` than in `report.md`.
    const parts = [`#${a.number}`, a.kind === 'merge' ? 'merge resolution' : 'task', TRIGGER_LABEL[a.triggeredBy] ?? a.triggeredBy, `${formatClock(a.startedAt)}${a.endedAt ? ` → ${formatClock(a.endedAt)}` : ''}`];
    if (durationMs !== undefined) parts.push(formatDuration(durationMs));
    parts.push(a.outcome ? (OUTCOME_LABEL[a.outcome] ?? a.outcome) : isLive(state, a) ? 'running' : 'no outcome');
    if (a.signal) parts.push(`signal ${a.signal}`);
    else if (a.exitCode !== undefined && a.exitCode !== null) parts.push(`exit ${a.exitCode}`);
    if (a.usage?.toolMs !== undefined) parts.push(`${formatDurationShort(a.usage.toolMs)} in tools`);
    if (a.usage?.costUsd !== undefined) parts.push(formatCost(a.usage.costUsd));
    const notes: string[] = [];
    const reason = attemptReason(state.attempts, i);
    if (reason) notes.push(reason);
    const error = oneLine(a.error);
    if (error) notes.push(error);
    return { number: a.number, line: parts.join('  '), notes, reason, durationMs };
  });
}

/** How long the worker sat blocked on this request; still counting while nobody has answered. */
export function waitedMs(record: InteractionRecord, now = Date.now()): number {
  const from = new Date(record.requestedAt).getTime();
  const to = record.answeredAt ? new Date(record.answeredAt).getTime() : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, to - from);
}

export interface InteractionRow {
  attempt: number;
  record: InteractionRecord;
  waitedMs: number;
  /** `#1  permission  Bash: npm publish  10:12:03  waited 42s  denied (timed out)` */
  line: string;
}

export function interactionRows(state: TaskRunState, now = Date.now()): InteractionRow[] {
  const rows: InteractionRow[] = [];
  for (const a of state.attempts) {
    for (const record of a.interactions ?? []) {
      const ms = waitedMs(record, now);
      // Same fallback as the attempt rows: an answer or a source from another build is shown raw.
      const answered = record.answer ? `${ANSWER_LABEL[record.answer] ?? record.answer}${record.source ? ` (${SOURCE_LABEL[record.source] ?? record.source})` : ''}` : 'still waiting for you';
      rows.push({
        attempt: a.number,
        record,
        waitedMs: ms,
        line: `#${a.number}  ${record.kind}  ${oneLine(record.title, 80)}  ${formatClock(record.requestedAt)}  waited ${formatDurationShort(ms)}  ${answered}`,
      });
    }
  }
  return rows;
}

/**
 * The number that explains a three-hour run: how long the task stood still waiting for a human. Two prompts
 * open at once are counted once each, which overstates the wall clock but not the attention they cost.
 */
export function totalWaitedMs(rows: InteractionRow[]): number {
  return rows.reduce((sum, r) => sum + r.waitedMs, 0);
}

/** The parts of a result a reviewer actually reads, in the order they are worth reading. */
export function resultNotes(result: TaskResult | undefined): Array<{ label: string; items: string[] }> {
  if (!result) return [];
  return [
    { label: 'decisions', items: result.decisions ?? [] },
    { label: 'warnings', items: result.warnings ?? [] },
    { label: 'follow-up', items: result.followUp ?? [] },
  ].filter((g) => g.items.length > 0);
}
