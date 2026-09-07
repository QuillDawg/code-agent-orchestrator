/**
 * `cao diff [run] [task]`: print what an attempt actually changed, from the `diff.patch` / `diff.json` the
 * workspace manager captured when the attempt finished. Nothing here touches git or the working tree, so
 * the answer stays the same however much the repository has moved on since.
 */
import { openStore, resolveRunAndOptionalTask, executionOrder, findCapturedDiff } from '../util.js';
import { useColor, type ColorMode } from '../color.js';
import { diffHeader, paintPatch, patchForFile, recordMatchesFile, renderNameOnly, renderStat, summarizeDiff } from '../render/diff.js';
import type { AttemptDiff, DiffFileRecord } from '../../types/result.js';

export interface DiffOptions {
  repository?: string;
  stat?: boolean;
  nameOnly?: boolean;
  file?: string;
  attempt?: number;
  json?: boolean;
  color?: ColorMode;
}

/** One task's captured diff, already filtered by `--file`. */
interface TaskDiff {
  taskId: string;
  attempt: number;
  kind: 'task' | 'merge';
  diff: AttemptDiff;
  patch: string;
}

export async function diffCommand(refs: string[], opts: DiffOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const note = (s: string): boolean => process.stderr.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveRunAndOptionalTask(store, refs, 'cao diff [run] [task]');
  const taskIds = taskId ? [taskId] : executionOrder(run);
  const color = useColor(opts.color);

  const found: TaskDiff[] = [];
  for (const id of taskIds) {
    const captured = await findCapturedDiff(store, run, id, opts.attempt);
    if (!captured) continue;
    const patch = (await store.readDiffPatch(run.runId, id, captured.attempt)) ?? '';
    found.push({
      taskId: id,
      attempt: captured.attempt,
      kind: captured.kind,
      diff: opts.file ? filterDiff(captured.diff, opts.file) : captured.diff,
      patch: opts.file ? patchForFile(patch, opts.file) : patch,
    });
  }

  // With --file, a task that did not touch it is not an empty section but simply not part of the answer.
  const shown = opts.file ? found.filter((t) => t.diff.files.length > 0) : found;

  if (opts.json) {
    out(JSON.stringify({ runId: run.runId, tasks: shown.map(({ patch: _patch, ...rest }) => rest) }, null, 2));
    return 0;
  }

  if (shown.length === 0) {
    note(found.length ? `No attempt in run ${run.runId} changed "${opts.file}".` : explainNothing(run.runId, taskId, taskIds, opts));
    return 0;
  }

  // A header would be noise when the user already named the task, and would break `--name-only | xargs`.
  const headers = shown.length > 1;
  for (const t of shown) {
    if (headers) out(diffHeader(t.taskId, t.attempt, t.diff, t.kind, color));
    if (opts.nameOnly) {
      for (const line of renderNameOnly(t.diff.files, color)) out(line);
    } else if (opts.stat) {
      for (const line of renderStat(t.diff.files, color)) out(line);
      out(summarizeDiff(t.diff.files));
      if (headers) out('');
    } else if (t.patch !== '') {
      process.stdout.write(paintPatch(t.patch.endsWith('\n') ? t.patch : `${t.patch}\n`, color));
    } else if (!headers) {
      // Nothing on stdout would look like a failure; the header carries the same news when there is one.
      note(`${t.taskId} attempt ${t.attempt} changed nothing.`);
    }
  }
  return 0;
}

/** Keep only the records for `--file`; the totals follow the records so `--stat` adds up to what is shown. */
function filterDiff(diff: AttemptDiff, file: string): AttemptDiff {
  const files = diff.files.filter((f: DiffFileRecord) => recordMatchesFile(f, file));
  return {
    ...diff,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** Why there is nothing to print: an empty run, a task that has not run, or a capture that was switched off. */
function explainNothing(runId: string, taskId: string | undefined, taskIds: string[], opts: DiffOptions): string {
  const where = taskId ? `Task "${taskId}" of run ${runId}` : `Run ${runId}`;
  if (opts.attempt !== undefined) return `${where} has no captured diff for attempt ${opts.attempt}.`;
  if (taskIds.length === 0) return `${where} has no tasks.`;
  return `${where} captured no diff. Attempts before this feature and runs with git.captureDiff: false have none.`;
}
