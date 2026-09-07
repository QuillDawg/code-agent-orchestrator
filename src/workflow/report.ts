/**
 * The run report: one document assembled from what the run directory already holds — the run state, each
 * task's result, and the `diff.json` its attempts captured. Nothing new is recorded for it, and nothing is
 * read from git or the working tree, so a report built a week later says the same thing.
 *
 * `buildReport` produces the model and `renderReportMarkdown` renders it, so `cao report --json` and
 * `cao report --md` are two views of one structure and cannot disagree about what happened.
 *
 * Times are rendered in UTC. A report exists to be pasted somewhere else — a pull request, an issue, a chat
 * — where the reader's clock is not the one the run was on, and where a bare `10:12` is a guess.
 */
import type { AttemptOutcome, RunState, RunSummary, TaskAttempt, TaskReason, TaskState, WorkflowRun } from '../types/run.js';
import type { DiffFileStatus, EnrichedTaskResult, RunnerUsage } from '../types/result.js';
import { addUsage } from '../types/result.js';
import type { RunStore } from '../persistence/run-store.js';
import { parseDiffStat } from '../workspace/diff.js';
import { formatCost, formatTokens } from '../tui/format.js';
import { attemptReason, attemptElapsedMs, interactionRows, taskElapsed, totalWaitedMs, OUTCOME_LABEL, TRIGGER_LABEL } from '../tui/history.js';
import { formatDuration } from '../util/duration.js';
import { sanitizeText } from '../util/text.js';
import { STATE_LABEL, summarize } from './states.js';
import { executionOrder, findCapturedDiff, type CapturedAttemptDiff } from './run-view.js';

export interface ReportAttempt {
  number: number;
  kind: TaskAttempt['kind'];
  triggeredBy: TaskAttempt['triggeredBy'];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome?: AttemptOutcome;
  exitCode?: number | null;
  signal?: string | null;
  costUsd?: number;
  /** Why the orchestrator started this attempt; unset for the first one. */
  reason?: string;
  error?: string;
}

/**
 * Where a task's file list came from. `diff` is the attempt's captured per-file stat and is exact; `stat` is
 * the `git diff --stat` the orchestrator recorded, whose totals are exact but whose per-file split usually is
 * not; `agent` is the list the worker reported for itself, with no line counts at all.
 */
export type ChangeSource = 'diff' | 'stat' | 'agent';

export interface ReportFile {
  path: string;
  /** Previous path of a renamed file. */
  oldPath?: string;
  /** Unknown for a `stat` source, which cannot tell an added file from a modified one, and for `agent`. */
  status?: DiffFileStatus;
  additions?: number;
  deletions?: number;
  /** Lines the file moved, when the source could not split them into additions and deletions. */
  changed?: number;
  binary?: boolean;
}

/** What one task changed, from the best source the run directory holds for it. */
export interface ReportChanges {
  source: ChangeSource;
  /** The attempt whose diff this is; unset when it came from the result rather than an attempt's `diff.json`. */
  attempt?: number;
  kind?: TaskAttempt['kind'];
  files: ReportFile[];
  /** Total lines added and removed; unset when the source reported none. */
  additions?: number;
  deletions?: number;
  /** True when the attempt's `diff.patch` was cut at `git.maxDiffBytes`; the file records are complete. */
  truncated: boolean;
}

export interface ReportTask {
  id: string;
  name: string;
  type: string;
  agent: string;
  model?: string;
  state: TaskState;
  reason?: TaskReason;
  message?: string;
  dependsOn: string[];
  /** False only for a task the run never got to: still pending, no attempt, no result, nothing to say. */
  ran: boolean;
  startedAt?: string;
  endedAt?: string;
  /** Time the task spent working, summed over its attempts (retry backoff belongs to the run). */
  durationMs?: number;
  usage: RunnerUsage;
  status?: string;
  summary?: string;
  decisions: string[];
  warnings: string[];
  followUp: string[];
  error?: string;
  commits: string[];
  changes?: ReportChanges;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  mergedSha?: string;
  attempts: ReportAttempt[];
  /** How often the task stopped for a human and how long it stood still doing so. */
  interactions: { count: number; waitedMs: number };
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  workflow: string;
  configPath: string;
  repository: string;
  baseBranch?: string;
  baseCommit?: string;
  state: RunState;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  counts: RunSummary;
  usage: RunnerUsage;
  /** Every model a task actually ran on, most used first. */
  models: Array<{ model: string; tasks: number }>;
  /** Distinct files touched across the run, and the lines added and removed in total. */
  changes: {
    files: number;
    additions: number;
    deletions: number;
    /** False when a task listed files without line counts, so the totals are a floor rather than the number. */
    complete: boolean;
  };
  /** Ids of the tasks the run never got to, in workflow order. */
  notStarted: string[];
  tasks: ReportTask[];
}

/** States a task can be in before the run has done anything with it; anything else is worth a section. */
const WAITING_STATES: ReadonlySet<TaskState> = new Set(['pending', 'ready']);

/** States a task is finished in. Anything else, once it has run, is still in flight. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['success', 'failed', 'blocked', 'skipped', 'cancelled']);

/**
 * Assemble the report for a finished (or half-finished) run. Every task the run knows about gets an entry,
 * in the order the run executed them; the ones that never ran are marked so a renderer can collapse them.
 */
export async function buildReport(store: Pick<RunStore, 'readDiff'>, run: WorkflowRun, now = Date.now()): Promise<RunReport> {
  const tasks: ReportTask[] = [];
  for (const id of executionOrder(run)) {
    const state = run.tasks[id];
    const def = run.workflow.tasks.find((t) => t.id === id);
    if (!state || !def) continue;
    const usage = addUsage(...state.attempts.map((a) => a.usage));
    const captured = await findCapturedDiff(store, run, id);
    const elapsed = taskElapsed(state, now);
    const interactions = interactionRows(state, now);
    const last = state.attempts[state.attempts.length - 1];
    const result = state.result;
    tasks.push({
      id,
      name: def.name,
      type: def.type,
      agent: def.agent,
      model: usage.model ?? def.model,
      state: state.state,
      reason: state.reason,
      message: state.message,
      dependsOn: def.dependsOn,
      ran: state.attempts.length > 0 || result !== undefined || state.message !== undefined || !WAITING_STATES.has(state.state),
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      durationMs: elapsed.attempts > 0 ? elapsed.totalMs : undefined,
      usage,
      status: result?.status,
      summary: result?.summary,
      decisions: result?.decisions ?? [],
      warnings: result?.warnings ?? [],
      followUp: result?.followUp ?? [],
      error: result?.error,
      commits: result?.commits ?? [],
      changes: taskChanges(captured, result),
      branch: last?.workspace?.branch ?? result?.git?.branch,
      baseSha: last?.workspace?.baseSha ?? result?.git?.baseSha,
      headSha: last?.workspace?.headSha ?? result?.git?.headSha,
      mergedSha: last?.workspace?.mergedSha,
      attempts: state.attempts.map((a, i) => ({
        number: a.number,
        kind: a.kind,
        triggeredBy: a.triggeredBy,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        durationMs: attemptElapsedMs(state, a, now),
        outcome: a.outcome,
        exitCode: a.exitCode,
        signal: a.signal,
        costUsd: a.usage?.costUsd,
        reason: attemptReason(state.attempts, i),
        error: a.error ? sanitizeText(a.error).trim() : undefined,
      })),
      interactions: { count: interactions.length, waitedMs: totalWaitedMs(interactions) },
    });
  }

  // A file two tasks both touched is one changed file, but both tasks' lines count.
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let complete = true;
  for (const t of tasks) {
    if (!t.changes) continue;
    for (const f of t.changes.files) paths.add(f.path);
    additions += t.changes.additions ?? 0;
    deletions += t.changes.deletions ?? 0;
    if (t.changes.additions === undefined && t.changes.deletions === undefined) complete = false;
  }

  const models = new Map<string, number>();
  for (const t of tasks) if (t.model && t.attempts.length > 0) models.set(t.model, (models.get(t.model) ?? 0) + 1);

  return {
    schemaVersion: 1,
    runId: run.runId,
    workflow: run.workflowName,
    configPath: run.configPath,
    repository: run.repositoryRoot,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.startedAt ? Math.max(0, new Date(run.endedAt ?? new Date(now).toISOString()).getTime() - new Date(run.startedAt).getTime()) : undefined,
    counts: summarize(run),
    usage: addUsage(...Object.values(run.tasks).flatMap((t) => t.attempts.map((a) => a.usage))),
    models: [...models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model, count]) => ({ model, tasks: count })),
    changes: { files: paths.size, additions, deletions, complete },
    notStarted: run.workflow.tasks.map((t) => t.id).filter((id) => !tasks.some((t) => t.id === id && t.ran)),
    tasks,
  };
}

/**
 * The best account of what a task changed that the run directory can give, in descending order of trust:
 * the attempt's captured `diff.json`, the same per-file records folded into the result's git block, the
 * `git diff --stat` recorded beside them, and finally the file list the agent claimed for itself.
 *
 * The last two tiers matter more than they look: a run whose orchestrator predates diff capture, or one
 * configured with `git.captureDiff: false`, has no `diff.json` at all, and without them the report would
 * say a run that landed a thousand lines changed nothing.
 */
function taskChanges(captured: CapturedAttemptDiff | null, result: EnrichedTaskResult | undefined): ReportChanges | undefined {
  if (captured) {
    return {
      source: 'diff',
      attempt: captured.attempt,
      kind: captured.kind,
      files: captured.diff.files,
      additions: captured.diff.additions,
      deletions: captured.diff.deletions,
      truncated: captured.diff.truncated,
    };
  }
  const git = result?.git;
  if (git?.files?.length) {
    return {
      source: 'diff',
      attempt: result?.attempt,
      files: git.files,
      additions: git.files.reduce((n, f) => n + f.additions, 0),
      deletions: git.files.reduce((n, f) => n + f.deletions, 0),
      truncated: git.diffTruncated === true,
    };
  }
  const stat = git?.diffStat ? parseDiffStat(git.diffStat) : undefined;
  if (stat?.files.length) {
    return { source: 'stat', attempt: result?.attempt, files: stat.files, additions: stat.additions, deletions: stat.deletions, truncated: false };
  }
  if (result?.filesChanged.length) {
    return { source: 'agent', files: result.filesChanged.map((path) => ({ path })), truncated: false };
  }
  return undefined;
}

// ------------------------------------------------------------------ markdown

const RUN_STATE_LABEL: Record<RunState, string> = {
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

/**
 * Files listed per task before the table stops being something a reviewer reads and starts being a wall.
 * The cut only happens when it hides more than a couple: trimming 22 files to 20 costs a reader more in the
 * "… and 2 more" line than it saves.
 */
const MAX_FILE_ROWS = 20;
const FILE_ROW_SLACK = 3;

/** `2026-09-04 10:12 UTC` — minute precision, which is all a header needs. */
function stamp(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * `10:12:30` in UTC, for a column that already sits under a dated header — with `09-05 ` in front when the
 * attempt did not start on the day the run did, so a run that crosses midnight still reads unambiguously.
 */
function clock(iso: string | undefined, runDay?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toISOString().slice(0, 10);
  return `${runDay && day !== runDay ? `${day.slice(5)} ` : ''}${d.toISOString().slice(11, 19)}`;
}

/** Agent text inside a table cell: one line, and no `|` to break the row apart. */
function cell(text: string): string {
  return sanitizeText(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Inline code that survives a path or a commit subject containing backticks of its own. */
function code(text: string): string {
  const inner = cell(text);
  if (inner === '') return '';
  const longest = Math.max(0, ...[...inner.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = inner.startsWith('`') || inner.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${inner}${pad}${fence}`;
}

/**
 * Agent prose dropped into the document as-is, made safe for the document around it: an unclosed code fence
 * would swallow every section below it, and a `#` heading would insert itself into the report's own outline.
 * Headings are demoted rather than escaped, so a worker that writes structured Markdown still gets structure.
 */
function prose(text: string): string {
  const lines = sanitizeText(text).trim().split(/\r?\n/);
  let fence: string | undefined;
  const out = lines.map((line) => {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && line.trim().startsWith(fence) && line.trim().replace(/^[`~]+/, '').trim() === '') fence = undefined;
      return line;
    }
    if (open) {
      fence = open[1]!;
      return line;
    }
    // Two levels down, so the worker's own outline survives intact underneath this task's `##` heading.
    return line.replace(/^(\s{0,3})(#{1,6})(\s|$)/, (_m, pad: string, hashes: string, tail: string) => `${pad}${`##${hashes}`.slice(0, 6)}${tail}`);
  });
  if (fence) out.push(fence);
  return out.join('\n');
}

/** A bullet whose continuation lines stay inside the bullet rather than ending the list. */
function bullet(text: string): string {
  const lines = prose(text).split(/\r?\n/);
  return lines.map((line, i) => (i === 0 ? `- ${line.trim()}` : `  ${line}`)).join('\n');
}

function mdTable(header: string[], rows: string[][]): string[] {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

/** GitHub's heading anchor: lower-cased, punctuation dropped, spaces hyphenated. */
function anchor(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim().replace(/\s/g, '-');
}

/** The `## …` line a task's section opens with. Computed once so its anchor and its text cannot drift. */
function taskHeading(task: ReportTask): string {
  return `${cell(task.id)}${task.name !== task.id ? ` — ${cell(task.name)}` : ''}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `+12 -4`, or `±16` when the source knew how many lines moved but not which way. */
function lineCount(additions: number | undefined, deletions: number | undefined, changed: number | undefined): string {
  if (additions !== undefined || deletions !== undefined) return `+${additions ?? 0} -${deletions ?? 0}`;
  return changed === undefined ? '' : `±${changed}`;
}

/** `3 files, +12 -4` — what the overview table's last column and each section's file headline both say. */
function changeSummary(changes: ReportChanges | undefined): string {
  if (!changes) return '';
  const lines = lineCount(changes.additions, changes.deletions, undefined);
  return `${plural(changes.files.length, 'file')}${lines ? `, ${lines}` : ''}`;
}

/** How much a file moved, for sorting the biggest change to the top of the table where it gets read. */
function fileWeight(f: ReportFile): number {
  return f.changed ?? (f.additions ?? 0) + (f.deletions ?? 0);
}

function shortSha(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 10) : undefined;
}

/** The result column of the overview table: the state, and for anything but success why it ended that way. */
function taskOutcome(task: ReportTask): string {
  if (task.state === 'success') return STATE_LABEL.success;
  return task.reason ? `${STATE_LABEL[task.state]} (${task.reason})` : STATE_LABEL[task.state];
}

/**
 * The whole report as Markdown, shaped to paste into a pull request: a header block of facts, one overview
 * table, then a section per task that ran. Tasks the run never reached are named once and left at that.
 */
export function renderReportMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# ${cell(report.workflow)} — run ${report.runId}`, '');

  const done = report.counts.success;
  const outcome = [`${done}/${report.counts.total} tasks succeeded`];
  if (report.counts.failed) outcome.push(`${report.counts.failed} failed`);
  if (report.counts.blocked) outcome.push(`${report.counts.blocked} blocked`);
  if (report.counts.skipped) outcome.push(`${report.counts.skipped} skipped`);
  if (report.counts.cancelled) outcome.push(`${report.counts.cancelled} cancelled`);
  // `counts.pending` lumps a task that is running in with one that has not been reached; the two are not
  // the same news to a reader, so they are counted apart here.
  const inFlight = report.tasks.filter((t) => t.ran && !TERMINAL_STATES.has(t.state)).length;
  if (inFlight) outcome.push(`${inFlight} still running`);
  if (report.notStarted.length) outcome.push(`${report.notStarted.length} never started`);
  lines.push(`- **Result:** ${RUN_STATE_LABEL[report.state]} — ${outcome.join(', ')}`);

  const base = [report.baseBranch ? `branch ${code(report.baseBranch)}` : '', report.baseCommit ? `base commit ${code(shortSha(report.baseCommit)!)}` : ''].filter(Boolean);
  lines.push(`- **Repository:** ${code(report.repository)}${base.length ? ` — ${base.join(', ')}` : ''}`);
  lines.push(`- **Workflow file:** ${code(report.configPath)}`);
  const when = report.startedAt ? ` (${stamp(report.startedAt)} → ${report.endedAt ? stamp(report.endedAt) : 'still running'})` : '';
  lines.push(`- **Duration:** ${report.durationMs === undefined ? 'not started' : formatDuration(report.durationMs)}${when}`);
  // Cache reads dwarf fresh input on any long run; leaving them out makes the token line read as a mistake.
  const cache = [
    report.usage.cacheReadTokens ? `${formatTokens(report.usage.cacheReadTokens)} cache read` : '',
    report.usage.cacheCreationTokens ? `${formatTokens(report.usage.cacheCreationTokens)} cache write` : '',
  ].filter(Boolean);
  const tokens = report.usage.inputTokens !== undefined ? ` — ${formatTokens(report.usage.inputTokens)} tokens in / ${formatTokens(report.usage.outputTokens ?? 0)} out${cache.length ? ` (${cache.join(', ')})` : ''}` : '';
  lines.push(`- **Cost:** ${report.usage.costUsd === undefined ? 'not reported' : formatCost(report.usage.costUsd)}${tokens}`);
  if (report.models.length) lines.push(`- **Models:** ${report.models.map((m) => `${code(m.model)} (${plural(m.tasks, 'task')})`).join(', ')}`);
  // Summed per task, so a line one task wrote and a later one rewrote is counted twice. Saying which tasks
  // the sum is over stops a reader reading it as `git diff base..head` and finding it does not match.
  const changed = report.tasks.filter((t) => t.changes).length;
  const across = changed > 1 ? ` across ${plural(changed, 'task')}` : '';
  const atLeast = report.changes.complete ? '' : ' (at least; some tasks reported file names without line counts)';
  lines.push(`- **Changes:** ${plural(report.changes.files, 'file')} changed, +${report.changes.additions} -${report.changes.deletions}${across}${atLeast}`);
  // Named rather than sectioned: a task the run never reached has nothing to report but its own absence.
  if (report.notStarted.length) lines.push(`- **Never started:** ${report.notStarted.map((id) => code(id)).join(', ')}`);
  lines.push('');

  const ran = report.tasks.filter((t) => t.ran);
  if (ran.length) {
    lines.push(
      ...mdTable(
        ['Task', 'Result', 'Duration', 'Cost', 'Changes'],
        ran.map((t) => [
          `[${code(t.id)}](#${anchor(taskHeading(t))})`,
          taskOutcome(t),
          t.durationMs === undefined ? '—' : formatDuration(t.durationMs),
          t.usage.costUsd === undefined ? '—' : formatCost(t.usage.costUsd),
          t.changes ? changeSummary(t.changes) : '—',
        ]),
      ),
      '',
    );
  }

  for (const task of ran) lines.push(...renderTaskSection(task), '');

  // A trailing blank line from the last section is one too many; the document ends with a single newline.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** The `**Files changed**` block: a headline sentence, then the biggest files first, capped so it stays read. */
function renderFiles(changes: ReportChanges): string[] {
  const lines: string[] = [];
  const provenance =
    changes.source === 'agent'
      ? ' — the agent\'s own list; no diff was captured'
      : changes.source === 'stat'
        ? ' — from the recorded `git diff --stat`, where `±` is a file\'s total rather than a split'
        : changes.attempt === undefined
          ? ''
          : ` (attempt ${changes.attempt}${changes.kind === 'merge' ? ', merge resolution' : ''})`;
  const truncated = changes.truncated ? ' — patch truncated at `git.maxDiffBytes`' : '';
  lines.push(`**Files changed** — ${changeSummary(changes)}${provenance}${truncated}`, '');
  if (!changes.files.length) return lines;

  const sorted = [...changes.files].sort((a, b) => fileWeight(b) - fileWeight(a) || a.path.localeCompare(b.path));
  const trim = sorted.length > MAX_FILE_ROWS + FILE_ROW_SLACK;
  const shown = trim ? sorted.slice(0, MAX_FILE_ROWS) : sorted;
  const hidden = trim ? sorted.slice(MAX_FILE_ROWS) : [];
  if (changes.source === 'agent') {
    // No counts to put in a second column, so a bullet list says the same thing without a table's ceremony.
    lines.push(...shown.map((f) => `- ${code(f.path)}`));
  } else {
    // A `--stat` cannot tell an added file from a modified one, so the status column is dropped rather than
    // rendered as a column of blanks.
    const status = shown.some((f) => f.status);
    lines.push(
      ...mdTable(
        status ? ['', 'File', 'Lines'] : ['File', 'Lines'],
        shown.map((f) => [
          ...(status ? [f.status ?? ''] : []),
          f.oldPath ? `${code(f.oldPath)} → ${code(f.path)}` : code(f.path),
          f.binary ? 'binary' : lineCount(f.additions, f.deletions, f.changed) || '—',
        ]),
      ),
    );
  }
  if (hidden.length) {
    const rest = hidden.reduce((n, f) => n + fileWeight(f), 0);
    lines.push('', `… and ${plural(hidden.length, 'smaller file')}${rest ? `, ${plural(rest, 'line')} between them` : ''}.`);
  }
  lines.push('');
  return lines;
}

function renderTaskSection(task: ReportTask): string[] {
  const lines: string[] = [];
  lines.push(`## ${taskHeading(task)}`, '');
  const head = [`**${taskOutcome(task)}**`, `${task.type} · ${task.agent}${task.model ? ` · ${code(task.model)}` : ''}`];
  if (task.durationMs !== undefined) head.push(formatDuration(task.durationMs));
  if (task.usage.costUsd !== undefined) head.push(formatCost(task.usage.costUsd));
  lines.push(head.join(' · '), '');

  if (task.summary) lines.push(prose(task.summary), '');
  else if (task.message) lines.push(`_${cell(task.message)}_`, '');
  // A task still working has no result yet, which is not the same news as a finished one that produced none.
  else if (!TERMINAL_STATES.has(task.state)) lines.push('_Still going; there is no result to report yet._', '');
  else lines.push('_No result was recorded for this task._', '');

  if (task.error) lines.push('**Error**', '', ...prose(task.error).split('\n').map((l) => `> ${l}`), '');

  // What the task changed comes before what it thought about it: a reviewer reads the diff first.
  if (task.changes) lines.push(...renderFiles(task.changes));
  if (task.commits.length) lines.push('**Commits**', '', ...task.commits.map(bullet), '');

  for (const [label, items] of [
    ['Decisions', task.decisions],
    ['Warnings', task.warnings],
    ['Follow-up', task.followUp],
  ] as const) {
    if (items.length) lines.push(`**${label}**`, '', ...items.map(bullet), '');
  }

  const git = [
    task.branch ? `branch ${code(task.branch)}` : '',
    task.baseSha ? `base ${code(shortSha(task.baseSha)!)}` : '',
    task.headSha && task.headSha !== task.baseSha ? `head ${code(shortSha(task.headSha)!)}` : '',
    task.mergedSha ? `merged as ${code(shortSha(task.mergedSha)!)}` : '',
  ].filter(Boolean);
  if (git.length) lines.push(`**Git** — ${git.join(', ')}`, '');

  if (task.attempts.length) {
    // One attempt that simply worked is the head line's `success` all over again; the table earns its space
    // only once there is a retry, a merge resolution, or something that did not end cleanly.
    const first = task.attempts[0]!;
    const routine = task.attempts.length === 1 && first.kind === 'task' && first.outcome === 'success' && !first.error;
    if (!routine) lines.push(...renderAttempts(task), '');
  }

  if (task.interactions.count) {
    lines.push(`_Stopped for a human ${plural(task.interactions.count, 'time')}, waiting ${formatDuration(task.interactions.waitedMs)} in total._`, '');
  }

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function renderAttempts(task: ReportTask): string[] {
  const runDay = task.attempts[0]?.startedAt.slice(0, 10);
  const lines = [
    '**Attempts**',
    '',
    ...mdTable(
      ['#', 'Kind', 'Trigger', 'Started', 'Duration', 'Outcome', 'Exit', 'Cost'],
      task.attempts.map((a) => [
        String(a.number),
        a.kind === 'merge' ? 'merge resolution' : 'task',
        // A run written by an older build can name a trigger or an outcome this one has no label for; show
        // the raw value rather than an empty cell or the word `undefined`.
        TRIGGER_LABEL[a.triggeredBy] ?? cell(a.triggeredBy),
        clock(a.startedAt, runDay) || '—',
        a.durationMs === undefined ? '—' : formatDuration(a.durationMs),
        a.outcome ? (OUTCOME_LABEL[a.outcome] ?? cell(a.outcome)) : '—',
        a.signal ? `signal ${a.signal}` : a.exitCode === undefined || a.exitCode === null ? '—' : String(a.exitCode),
        a.costUsd === undefined ? '—' : formatCost(a.costUsd),
      ]),
    ),
  ];
  // The reasons and errors do not fit a cell, and are the part of the table a reviewer actually reads.
  const notes = task.attempts.flatMap((a) => [a.reason ? `attempt ${a.number}: ${cell(a.reason)}` : '', a.error ? `attempt ${a.number} error: ${cell(a.error)}` : ''].filter(Boolean));
  if (notes.length) lines.push('', ...notes.map((n) => `- ${n}`));
  return lines;
}
