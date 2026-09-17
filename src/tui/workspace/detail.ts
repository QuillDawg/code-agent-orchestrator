/**
 * The Overview panel's prose, as lines rather than as elements.
 *
 * The detail block and the failure block share a panel with the task table, so both have to fit whatever
 * rows are left after it - and a block that is JSX cannot be measured before it is drawn, let alone cut to a
 * budget. Producing lines instead means the panel slices them, the harness can assert on them, and nothing
 * is ever handed to Ink that it would lay out below the bottom of the terminal.
 *
 * The content is the old detail view's, unchanged: status, attempt, agent, session, usage, files, the
 * attempt and interaction history, the result notes and the tail of the transcript.
 */
import { type ResolvedTask, type TaskRunState, type TranscriptEntry, type WorkflowRun } from 'code-agent-orchestrator-protocol';
import { STATE_LABEL, stateGlyph } from '../../workflow/states.js';
import { glyph } from '../../util/glyphs.js';
import { formatClock, formatDuration } from '../../util/duration.js';
import { firstLine } from '../../util/misc.js';
import { sanitizeText } from '../../cli/color.js';
import { bar, contextRatio, formatCost, formatTokens } from '../format.js';
import { attemptRows, currentAttempt, elapsedCell, interactionRows, resultNotes, totalWaitedMs, OUTCOME_LABEL } from '../history.js';
import { renderTranscript } from '../transcript.js';
import { fileLabel, taskFiles } from '../dashboard/files.js';
import type { Theme } from '../theme.js';

export interface DetailLine {
  text: string;
  dim?: boolean;
  bold?: boolean;
}

/** Attempts and interactions shown here; the rest are one `cao task` away. */
export const MAX_HISTORY_ROWS = 6;

export interface DetailInput {
  task: ResolvedTask;
  state: TaskRunState;
  run: WorkflowRun;
  now: number;
  columns: number;
  theme: Theme;
  /** The tail of the task's transcript, for the "Latest activity" block. */
  entries: TranscriptEntry[];
  /** How many transcript lines the panel can spare; 0 drops the block. */
  activityRows: number;
}

export function detailLines(input: DetailInput): DetailLine[] {
  const { task, state, run, now, columns, theme } = input;
  const out: DetailLine[] = [];
  const attempt = currentAttempt(state);
  const usage = attempt?.usage ?? state.result?.usage;
  const files = taskFiles(state);

  out.push({ text: task.id, bold: true });
  out.push({
    text:
      `Status:       ${theme.paint(`${stateGlyph(state.state)} ${STATE_LABEL[state.state]}`, theme.stateColor(state.state) ?? [])}` +
      (state.message ? `  (${firstLine(sanitizeText(state.message))})` : '') +
      (state.pendingInteraction ? theme.paint(`  waiting for you: ${sanitizeText(state.pendingInteraction.title)}`, 'warning') : ''),
  });
  if (attempt) {
    out.push({ text: `Attempt:      ${attempt.number}${task.retry.attempts ? ` / ${task.retry.attempts + 1}` : ''}${attempt.kind === 'merge' ? ' (merge resolution)' : ''}` });
    out.push({ text: `Agent:        ${task.agent}  Model: ${usage?.model ?? task.model ?? 'CLI default'}  Effort: ${task.effort ?? 'CLI default'}` });
    if (task.agent === 'codex') out.push({ text: `Permissions:  ${task.codex.permissionMode ?? 'auto'}  ${task.codex.sandbox ?? ''} ${task.codex.approvalPolicy ?? ''}` });
    out.push({ text: `Started:      ${formatClock(attempt.startedAt)}   Elapsed: ${elapsedCell(state, now)}` });
    out.push({ text: `PID:          ${attempt.pid ?? '-'}   Session: ${attempt.sessionId ?? '-'}` });
    out.push({ text: `Working Dir:  ${attempt.cwd}` });
    if (attempt.workspace?.branch) out.push({ text: `Branch:       ${attempt.workspace.branch}` });
  }
  if (task.dependsOn.length > 0) out.push({ text: `Depends On:   ${task.dependsOn.map((d) => `${stateGlyph(run.tasks[d]?.state ?? 'pending')} ${d}`).join('  ')}` });
  if (task.context?.sources.length) out.push({ text: `Context:      ${task.context.sources.map((s) => s.taskId).join(', ')}` });
  if (usage) {
    const ratio = contextRatio(usage);
    out.push({
      text:
        `Usage:        ${usage.costUsd !== undefined ? `${formatCost(usage.costUsd)}  ` : ''}` +
        `${usage.inputTokens !== undefined ? `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens ?? 0)} out  ` : ''}` +
        `${usage.numTurns !== undefined ? `${usage.numTurns} turns  ` : ''}` +
        `${ratio !== undefined ? `context ${theme.paint(`[${bar(ratio, 12)}] ${Math.round(ratio * 100)}%`, ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : 'success')} ${formatTokens(usage.contextTokens ?? 0)}/${formatTokens(usage.contextWindow ?? 0)}` : ''}` +
        `${usage.compactions ? theme.paint(`  ${usage.compactions} compaction${usage.compactions === 1 ? '' : 's'}`, 'muted') : ''}`,
    });
  }
  if (files.length > 0) {
    out.push({ text: `Files:        ±${files.length}  ${files.slice(0, 6).map(fileLabel).join(', ')}${files.length > 6 ? ` … +${files.length - 6} (C for all)` : ''}` });
  }

  const history = attemptRows(state, now);
  const shownHistory = history.slice(-MAX_HISTORY_ROWS);
  if (shownHistory.length > 0) {
    out.push({ text: ' ' });
    out.push({ text: 'Attempts', bold: true });
    if (history.length > shownHistory.length) {
      out.push({ text: `  … ${history.length - shownHistory.length} earlier attempt${history.length - shownHistory.length === 1 ? '' : 's'} (cao task ${task.id})`, dim: true });
    }
    for (const row of shownHistory) {
      out.push({ text: `  ${row.line}` });
      for (const note of row.notes) out.push({ text: `      ↳ ${note}`, dim: true });
    }
  }

  const interactions = interactionRows(state, now);
  const shownInteractions = interactions.slice(-MAX_HISTORY_ROWS);
  if (shownInteractions.length > 0) {
    out.push({ text: ' ' });
    out.push({ text: 'Interactions', bold: true });
    if (interactions.length > shownInteractions.length) {
      out.push({ text: `  … ${interactions.length - shownInteractions.length} earlier (cao task ${task.id})`, dim: true });
    }
    for (const row of shownInteractions) out.push({ text: `  ${row.line}` });
    out.push({ text: `  waited ${formatDuration(totalWaitedMs(interactions))} in total across ${interactions.length} request${interactions.length === 1 ? '' : 's'}`, dim: true });
  }

  const notes = resultNotes(state.result);
  if (notes.length > 0) {
    out.push({ text: ' ' });
    out.push({ text: 'Result', bold: true });
    for (const group of notes) {
      out.push({ text: `  ${group.label}:` });
      for (const item of group.items) out.push({ text: `    - ${sanitizeText(item)}` });
    }
  }

  if (input.activityRows > 0) {
    out.push({ text: ' ' });
    out.push({ text: 'Latest activity', bold: true });
    const lines = renderTranscript(input.entries, { color: theme.color, width: Math.max(20, columns - 4), timestamps: columns >= 100 ? true : 'short' }).slice(-input.activityRows);
    for (const line of lines) out.push({ text: `  ${line}` });
    if (lines.length === 0) out.push({ text: '  (no output yet)', dim: true });
  }
  return out;
}

/**
 * The block the Overview leads with after a failure (§3.1): which task, what kind of failure, the latest
 * error line, how many attempts it took, and what can be done about it from here.
 *
 * The actions listed are the ones this build has. Editing a task and sending it a prompt are stage 2's, and
 * an action offered before it exists is worse than one that is not offered yet.
 */
export function failureLines(run: WorkflowRun, theme: Theme): DetailLine[] {
  const failed = run.workflow.tasks
    .map((t) => ({ task: t, state: run.tasks[t.id] }))
    .filter((row): row is { task: ResolvedTask; state: TaskRunState } => row.state !== undefined && (row.state.state === 'failed' || row.state.state === 'blocked'));
  if (failed.length === 0) return [];
  const lead = failed[0]!;
  const last = lead.state.attempts[lead.state.attempts.length - 1];
  const category = last?.outcome ? OUTCOME_LABEL[last.outcome] : lead.state.state === 'blocked' ? 'blocked' : 'failed';
  const error = firstLine(sanitizeText(last?.error ?? lead.state.message ?? ''));
  return [
    { text: theme.paint(`${glyph('error')} ${lead.task.id} ${category}`, 'danger') + `  after ${lead.state.attempts.length} attempt${lead.state.attempts.length === 1 ? '' : 's'}` + (failed.length > 1 ? `   (+${failed.length - 1} more failed)` : ''), bold: true },
    ...(error ? [{ text: `  ${error}`, dim: true }] : []),
    { text: '  R re-run    F open logs    C open diff', dim: true },
    { text: ' ' },
  ];
}
