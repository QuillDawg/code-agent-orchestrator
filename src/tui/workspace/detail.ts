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
import { STATE_LABEL, stateGlyph, summarize } from '../../workflow/states.js';
import type { EndedAction } from './ended.js';
import type { PendingLine } from './observer.js';
import { glyph } from '../../util/glyphs.js';
import { truncateVisible } from '../../cli/util.js';
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
  /**
   * This line only makes sense under the one above it: the `->` notes of an attempt row.
   *
   * `trimToRows` cuts the detail from the middle, and without this the tail could begin with two notes
   * whose attempt row had just been cut away - two sentences hanging under a heading that is not there.
   */
  continuation?: boolean;
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
  /**
   * Whether to lead with the task id. False where the caller already names the task above these lines -
   * the Overview's labelled rule does - because the id on two consecutive rows is a wasted row on a panel
   * that is counting them.
   */
  title?: boolean;
}

export function detailLines(input: DetailInput): DetailLine[] {
  const { task, state, run, now, columns, theme } = input;
  const out: DetailLine[] = [];
  const attempt = currentAttempt(state);
  const usage = attempt?.usage ?? state.result?.usage;
  const files = taskFiles(state);

  if (input.title !== false) out.push({ text: task.id, bold: true });
  out.push({
    text:
      `Status:       ${theme.paint(`${stateGlyph(state.state)} ${STATE_LABEL[state.state]}`, theme.stateToken(state.state))}` +
      (state.message ? `  (${firstLine(sanitizeText(state.message))})` : '') +
      (state.pendingInteraction ? theme.paint(`  waiting for you: ${sanitizeText(state.pendingInteraction.title)}`, 'warn') : ''),
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
        `${ratio !== undefined ? `context ${theme.paint(`[${bar(ratio, 12)}] ${Math.round(ratio * 100)}%`, ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok')} ${formatTokens(usage.contextTokens ?? 0)}/${formatTokens(usage.contextWindow ?? 0)}` : ''}` +
        `${usage.compactions ? theme.paint(`  ${usage.compactions} compaction${usage.compactions === 1 ? '' : 's'}`, 'muted') : ''}`,
    });
  }
  if (files.length > 0) {
    out.push({ text: `Files:        ${glyph('plusMinus')}${files.length}  ${files.slice(0, 6).map(fileLabel).join(', ')}${files.length > 6 ? ` ${glyph('ellipsis')} +${files.length - 6} (C for all)` : ''}` });
  }

  const history = attemptRows(state, now);
  const shownHistory = history.slice(-MAX_HISTORY_ROWS);
  if (shownHistory.length > 0) {
    out.push({ text: ' ' });
    out.push({ text: 'Attempts', bold: true });
    if (history.length > shownHistory.length) {
      out.push({ text: `  ${glyph('ellipsis')} ${history.length - shownHistory.length} earlier attempt${history.length - shownHistory.length === 1 ? '' : 's'} (cao task ${task.id})`, dim: true });
    }
    for (const row of shownHistory) {
      out.push({ text: `  ${row.line}` });
      for (const note of row.notes) out.push({ text: `      ${glyph('subArrow')} ${note}`, dim: true, continuation: true });
    }
  }

  const interactions = interactionRows(state, now);
  const shownInteractions = interactions.slice(-MAX_HISTORY_ROWS);
  if (shownInteractions.length > 0) {
    out.push({ text: ' ' });
    out.push({ text: 'Interactions', bold: true });
    if (interactions.length > shownInteractions.length) {
      out.push({ text: `  ${glyph('ellipsis')} ${interactions.length - shownInteractions.length} earlier (cao task ${task.id})`, dim: true });
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

/** Every task a failure block would lead with, in workflow order. */
function failedTasks(run: WorkflowRun): Array<{ task: ResolvedTask; state: TaskRunState }> {
  return run.workflow.tasks
    .map((t) => ({ task: t, state: run.tasks[t.id] }))
    .filter((row): row is { task: ResolvedTask; state: TaskRunState } => row.state !== undefined && (row.state.state === 'failed' || row.state.state === 'blocked'));
}

/** The states a run stops in that are waiting for a person rather than for a worker. */
const WAITING_ON_A_HUMAN = new Set(['needs_input', 'awaiting_approval', 'waiting']);

/**
 * The task the ended state is about: the first failure, or failing that the first thing waiting for a
 * person (§2.4, §3.1).
 *
 * One function because three things have to agree on it — the lead block names it, the actions under that
 * block are the actions *for* it, and the cursor is moved to it when the run ends. Before they agreed, a
 * run that failed on task 3 led with "migrate-runner failed" and then offered "R Re-run scaffold-config",
 * because the actions were built from wherever the cursor happened to be left.
 */
export function leadTaskId(run: WorkflowRun): string | undefined {
  const failed = failedTasks(run)[0];
  if (failed) return failed.task.id;
  return run.workflow.tasks.find((t) => WAITING_ON_A_HUMAN.has(run.tasks[t.id]?.state ?? ''))?.id;
}

/**
 * The block the Overview leads with after a failure (§3.1): which task, what kind of failure, the latest
 * error line, how many attempts it took, and what can be done about it from here.
 *
 * The actions listed are the ones this build has. Editing a task and sending it a prompt are stage 2's, and
 * an action offered before it exists is worse than one that is not offered yet.
 */
export function failureLines(run: WorkflowRun, theme: Theme, opts: { actions?: string | false; selected?: string } = {}): DetailLine[] {
  const failed = failedTasks(run);
  if (failed.length === 0) return [];
  const lead = failed[0]!;
  const last = lead.state.attempts[lead.state.attempts.length - 1];
  const category = last?.outcome ? OUTCOME_LABEL[last.outcome] : lead.state.state === 'blocked' ? 'blocked' : 'failed';
  const error = firstLine(sanitizeText(last?.error ?? lead.state.message ?? ''));
  // `R`, `F` and `C` act on the *selected* task, and while a run is still going the selection is wherever
  // the operator left it. The block used to offer them under the name of the failed task whatever was
  // selected, so on a run that failed on its seventh task `R` restarted the first one without a word.
  const onLead = opts.selected === undefined || opts.selected === lead.task.id;
  const actions = opts.actions ?? (onLead ? '  R re-run    F open logs    C open diff' : `  ${glyph('up')}${glyph('down')} to ${lead.task.id}, then R re-run   F open logs   C open diff`);
  return [
    { text: theme.paint(`${glyph('error')} ${lead.task.id} ${category}`, 'danger') + `  after ${lead.state.attempts.length} attempt${lead.state.attempts.length === 1 ? '' : 's'}` + (failed.length > 1 ? `   (+${failed.length - 1} more failed)` : ''), bold: true },
    ...(error ? [{ text: `  ${error}`, dim: true }] : []),
    ...(actions === false ? [] : [{ text: actions, dim: true }]),
    { text: ' ' },
  ];
}

/**
 * What the Overview leads with when a run stopped without anything failing (§2.4): the task that is waiting
 * for a person, and what it asked for.
 *
 * A paused run used to lead with "Run paused   1/3 done   exit 3" and nothing else — the run state without
 * the one fact that follows from it, which is *who* is waiting and *what for*. That is in the table further
 * down, but the table is not where the eye goes and it is not what the actions underneath are about.
 */
function attentionLines(run: WorkflowRun, theme: Theme, columns: number): DetailLine[] {
  const id = leadTaskId(run);
  const state = id ? run.tasks[id] : undefined;
  if (!id || !state) return [];
  const asked = state.pendingInteraction ? `${state.pendingInteraction.kind}: ${sanitizeText(state.pendingInteraction.title)}` : firstLine(sanitizeText(state.message ?? ''));
  return [
    { text: theme.paint(`${stateGlyph(state.state)} ${id} ${STATE_LABEL[state.state].toLowerCase()}`, 'warn'), bold: true },
    ...(asked ? [{ text: `  ${truncateVisible(asked, Math.max(10, columns - 2))}`, dim: true }] : []),
  ];
}

/** What the run states are called on the ended line, matching the words the header and `cao status` use. */
const RUN_OUTCOME: Record<string, string> = {
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  running: 'Running',
  pending: 'Pending',
};

export interface EndedBlock {
  /** The actions offered, already in the order [D36] lists them; empty in observer mode. */
  actions: EndedAction[];
  /** The observer banner naming the owning process, shown instead of the actions (§2.1). */
  banner?: string;
  /** Columns the panel has, so the action list wraps rather than losing its tail to a truncation. */
  columns: number;
}

/**
 * Break `text` on spaces so every line fits `width`; a banner or a paragraph is a sentence, not a list.
 *
 * The newlines already in the text are line breaks, not characters to wrap over. They have to be, because
 * every caller draws one returned element per row: a returned string that still held a `\n` was drawn as
 * several rows by the terminal, so the panel used more rows than it had counted, and the wrap landed
 * wherever `width` ran out rather than at the author's line ends. That is what a `prompt: |` block looked
 * like in the task editor - `- write the tests` cut into `- write` and `the tests`, one of them indented as
 * a continuation and one not (§3.2, §3.4).
 *
 * A blank line between two paragraphs is part of the shape and is kept; empty text is no lines at all, and
 * the trailing newline a YAML block scalar ends with is not a row.
 */
export function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > width) {
      const space = rest.lastIndexOf(' ', width);
      const cut = space > width / 2 ? space : width;
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * The actions as lines that fit `columns`.
 *
 * Wrapped rather than truncated, which is what every other line in the workspace does: a line of task
 * names cut short still says what it is, but a list of actions cut short is a list of actions the operator
 * cannot see and therefore does not have. On a narrow terminal that meant losing Approve and Reject, which
 * are the only two things a paused run can be moved on with.
 */
export function actionLines(actions: readonly { key: string; label: string }[], columns: number): string[] {
  const width = Math.max(10, columns - 2);
  const lines: string[] = [];
  let current = '';
  for (const action of actions) {
    const cell = `${action.key} ${action.label}`;
    if (current && current.length + 4 + cell.length > width) {
      lines.push(current);
      current = cell;
    } else current = current ? `${current}    ${cell}` : cell;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * What the Overview leads with once the run has ended (§2.4, §3.1): the outcome, then the failure, then
 * what can be done about it from right here.
 *
 * The outcome line exists because the header says the run state in three characters at the far right, and
 * the first question after a run ends is not "what state" but "did it work, and what do I do now". The
 * failure block below it is the same one a live run shows, minus its action line: the actions in an ended
 * run are resumes, not restarts, so offering `R re-run` twice with two different meanings would be worse
 * than offering it once.
 */
export function endedLines(run: WorkflowRun, theme: Theme, block: EndedBlock): DetailLine[] {
  const summary = summarize(run);
  const outcome = RUN_OUTCOME[run.state] ?? run.state;
  const token = run.state === 'completed' ? 'ok' : run.state === 'failed' ? 'danger' : 'warn';
  const elapsed = run.startedAt && run.endedAt ? formatDuration(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) : '';
  const parts = [
    theme.paint(`Run ${outcome.toLowerCase()}`, token),
    `${summary.success + summary.skipped}/${summary.total} done`,
    ...(summary.failed + summary.blocked ? [`${summary.failed + summary.blocked} failed`] : []),
    ...(elapsed ? [elapsed] : []),
    ...(run.exitCode !== undefined ? [`exit ${run.exitCode}`] : []),
  ];
  const lines: DetailLine[] = [{ text: parts.join('   '), bold: true }];
  const failure = failureLines(run, theme, { actions: false }).slice(0, -1);
  lines.push(...(failure.length ? failure : attentionLines(run, theme, block.columns)));
  if (block.banner) for (const line of wrapPlain(block.banner, Math.max(20, block.columns - 2))) lines.push({ text: `  ${theme.paint(line, 'warn')}` });
  else for (const line of actionLines(block.actions, block.columns)) lines.push({ text: `  ${line}`, dim: true });
  lines.push({ text: ' ' });
  return lines;
}

export interface ObserverBlock {
  /** The sentence naming the process that owns the run (§2.1). */
  banner: string;
  /** The controls this window may send; empty when the run advertises none. */
  actions: readonly { key: string; label: string }[];
  /** What the owner is waiting on a human for, shown read-only (`[D37]`). */
  pending: PendingLine[];
  /** Where those are answered: "answer in the owning terminal (pid N)". */
  answerHint: string;
  columns: number;
}

/**
 * What the Overview leads with while this window is watching a run another process owns (§2.1, `[D37]`).
 *
 * The order is the order the questions come in: what the run is doing, who is driving it, what it is waiting
 * on a human for — and only then what can be done from here. The pending block comes **above** the actions
 * deliberately: it is the one thing on the screen this window cannot act on, and an operator who reads it
 * after a list of keys has already tried to press one.
 */
export function observerLines(run: WorkflowRun, theme: Theme, block: ObserverBlock): DetailLine[] {
  const summary = summarize(run);
  const outcome = RUN_OUTCOME[run.state] ?? run.state;
  const token = run.state === 'running' ? 'accent2' : run.state === 'failed' ? 'danger' : 'warn';
  const width = Math.max(20, block.columns - 2);
  const lines: DetailLine[] = [
    { text: [theme.paint(`Run ${outcome.toLowerCase()}`, token), `${summary.success + summary.skipped}/${summary.total} done`, ...(summary.failed + summary.blocked ? [`${summary.failed + summary.blocked} failed`] : [])].join('   '), bold: true },
  ];
  for (const line of wrapPlain(block.banner, width)) lines.push({ text: `  ${theme.paint(line, 'warn')}` });
  lines.push(...failureLines(run, theme, { actions: false }).slice(0, -1));
  for (const pending of block.pending) {
    const what = truncateVisible(`${pending.taskId} (${pending.what})`, Math.max(10, width - block.answerHint.length - 6));
    lines.push({ text: `  ${theme.paint('?', 'warn')} ${what}  ${theme.paint(block.answerHint, 'muted')}` });
  }
  for (const line of actionLines(block.actions, block.columns)) lines.push({ text: `  ${line}`, dim: true });
  lines.push({ text: ' ' });
  return lines;
}
