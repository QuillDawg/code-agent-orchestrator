import path from 'node:path';
import { FileRunStore } from '../persistence/run-store.js';
import { ORCHESTRATOR_DIR } from '../persistence/paths.js';
import { pathExists } from '../util/fs.js';
import { Git } from '../workspace/git.js';
import { UsageError } from '../util/errors.js';
import { isProcessAlive } from '../util/misc.js';
import { stripAnsi } from '../util/text.js';
import { glyph, rule } from '../util/glyphs.js';
import type { WorkflowRun, TaskRunState } from '../types/run.js';
import { currentAttempt, elapsedCell } from '../tui/history.js';

/** Tried in order when `cao run` / `cao validate` is given no workflow path. */
export const DEFAULT_WORKFLOW_FILES = ['workflow.yaml', 'workflow.yml', 'cao.yaml'];

/** `cao run` with no argument: the conventional workflow file in the launch directory. */
export async function resolveWorkflowPath(explicit: string | undefined, cwd = process.cwd()): Promise<string> {
  if (explicit) return explicit;
  for (const name of DEFAULT_WORKFLOW_FILES) {
    const candidate = path.join(cwd, name);
    if (await pathExists(candidate)) return candidate;
  }
  throw new UsageError(`No workflow file given and none of ${DEFAULT_WORKFLOW_FILES.join(', ')} found in ${cwd}. Pass one: cao run <workflow.yaml>.`);
}

/** Locate the repository that owns `.orchestrator/` for read-only commands (status, logs, ...). */
export async function findStoreRoot(explicit?: string): Promise<string> {
  const start = path.resolve(explicit ?? process.cwd());
  let dir = start;
  for (;;) {
    if (await pathExists(path.join(dir, ORCHESTRATOR_DIR, 'runs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const gitRoot = await Git.topLevel(start);
  if (gitRoot && (await pathExists(path.join(gitRoot, ORCHESTRATOR_DIR)))) return gitRoot;
  throw new UsageError(`No ${ORCHESTRATOR_DIR}/runs directory found at or above ${start}. Run a workflow first or pass --repository.`);
}

export async function openStore(explicitRoot?: string): Promise<FileRunStore> {
  return new FileRunStore(await findStoreRoot(explicitRoot));
}

/** How long after its last heartbeat an orchestrator is still believed to be at the wheel. */
const HEARTBEAT_STALE_MS = 60_000;

export interface Orchestrator {
  pid: number;
  heartbeatAt: string;
  /** `lock` is the run's lock file; `live` is the status file it rewrites on the same heartbeat. */
  source: 'lock' | 'live';
  /** The process still exists, and (for `live`) has beaten recently enough to be believed. */
  alive: boolean;
}

/**
 * The orchestrator executing a run right now, if there is one.
 *
 * `lock.json` is the answer whenever it is there, but it is a single file that anything in the tree can
 * remove, and reporting "nothing is running" over a live orchestrator is the dangerous direction to be
 * wrong in: it invites a second `cao run` or `cao resume` into the same working tree. So when the lock is
 * gone, `live.json` answers instead — the orchestrator rewrites it on the same 20-second heartbeat, and it
 * carries the same pid. A pid can be recycled, so the live fallback also requires a fresh heartbeat.
 */
export async function readOrchestrator(store: FileRunStore, runId: string): Promise<Orchestrator | null> {
  const lock = await store.readLock(runId);
  if (lock) return { pid: lock.pid, heartbeatAt: lock.heartbeatAt, source: 'lock', alive: isProcessAlive(lock.pid) };
  const live = await store.readLive(runId);
  if (!live || live.state !== 'running') return null;
  const fresh = Date.now() - new Date(live.heartbeatAt).getTime() < HEARTBEAT_STALE_MS;
  return { pid: live.orchestratorPid, heartbeatAt: live.heartbeatAt, source: 'live', alive: fresh && isProcessAlive(live.orchestratorPid) };
}

/** The run of this repository that an orchestrator process is executing right now, if there is one. */
export async function findActiveRun(store: FileRunStore): Promise<{ runId: string; orchestrator: Orchestrator } | null> {
  for (const entry of await store.listRuns()) {
    if (entry.state !== 'running') continue;
    const orchestrator = await readOrchestrator(store, entry.runId);
    if (!orchestrator || orchestrator.pid === process.pid) continue;
    const fresh = Date.now() - new Date(orchestrator.heartbeatAt).getTime() < HEARTBEAT_STALE_MS;
    if (fresh && orchestrator.alive) return { runId: entry.runId, orchestrator };
  }
  return null;
}

/** A third reference is a typo, not a third thing to show; saying so beats silently ignoring it. */
function rejectExtraRefs(refs: string[], usage: string): void {
  if (refs.length > 2) throw new UsageError(`Too many arguments (${refs.map((r) => `"${r}"`).join(' ')}): ${usage}`);
}

/** `cao logs <task>` or `cao logs <run> <task>`: resolve both. */
export async function resolveRunAndTask(store: FileRunStore, refs: string[], usage = 'cao <command> [run] <task>'): Promise<{ run: WorkflowRun; taskId: string }> {
  rejectExtraRefs(refs, usage);
  if (refs.length === 0) {
    const latest = await store.loadRun(await store.resolveRunId(undefined)).catch(() => null);
    throw new UsageError(`A task id is required: ${usage}${latest ? `. Tasks in run ${latest.runId}: ${Object.keys(latest.tasks).join(', ')}` : ''}`);
  }
  if (refs.length === 1) {
    const runId = await store.resolveRunId(undefined);
    const run = await store.loadRun(runId);
    return { run, taskId: requireTask(run, refs[0]!) };
  }
  const runId = await store.resolveRunId(refs[0]);
  const run = await store.loadRun(runId);
  return { run, taskId: requireTask(run, refs[1]!) };
}

/**
 * `cao diff`, `cao diff <task>`, `cao diff <run>` and `cao diff <run> <task>`: the task is optional, so a
 * single reference is a task of the latest run when one matches, and a run id otherwise.
 */
export async function resolveRunAndOptionalTask(store: FileRunStore, refs: string[], usage = 'cao <command> [run] [task]'): Promise<{ run: WorkflowRun; taskId?: string }> {
  rejectExtraRefs(refs, usage);
  if (refs.length === 0) return { run: await store.loadRun(await store.resolveRunId(undefined)) };
  if (refs.length === 1) {
    const ref = refs[0]!;
    const latest = await store.loadRun(await store.resolveRunId(undefined)).catch(() => null);
    const taskId = latest ? matchTask(latest, ref) : null;
    if (latest && taskId) return { run: latest, taskId };
    const runId = await store.resolveRunId(ref).catch(() => null);
    if (runId) return { run: await store.loadRun(runId) };
    throw new UsageError(
      `"${ref}" is neither a run id nor a task of run ${latest?.runId ?? '(none)'}${latest ? `. Tasks: ${Object.keys(latest.tasks).join(', ')}` : ''}`,
    );
  }
  const run = await store.loadRun(await store.resolveRunId(refs[0]));
  return { run, taskId: requireTask(run, refs[1]!) };
}

/**
 * Task references match like run ids do: exactly, or by a prefix that names exactly one task. Returns null
 * when nothing matches and throws only for an ambiguous prefix, which is a mistake either way.
 */
export function matchTask(run: WorkflowRun, ref: string): string | null {
  if (run.tasks[ref]) return ref;
  const matches = Object.keys(run.tasks).filter((id) => id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new UsageError(`Task "${ref}" is ambiguous in run ${run.runId}: ${matches.join(', ')}`);
  return null;
}

export function requireTask(run: WorkflowRun, ref: string): string {
  const taskId = matchTask(run, ref);
  if (!taskId) throw new UsageError(`Task "${ref}" is not part of run ${run.runId}. Tasks: ${Object.keys(run.tasks).join(', ')}`);
  return taskId;
}

export { currentAttempt };
export { executionOrder, findCapturedDiff } from '../workflow/run-view.js';

/** Total elapsed across attempts, with the current attempt in parentheses when there is more than one. */
export function taskDuration(state: TaskRunState, now = Date.now()): string {
  return elapsedCell(state, now);
}

/** Printable width: styling bytes take no columns, so padding must not count them. */
export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Cut to `max` printable columns, marking the cut with an ellipsis. Styling is dropped rather than left open. */
export function truncateVisible(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  if (max <= 0) return '';
  const plain = stripAnsi(text);
  const mark = glyph('ellipsis');
  return max <= mark.length ? plain.slice(0, max) : `${plain.slice(0, max - mark.length)}${mark}`;
}

/**
 * Columns to lay a table out in: the terminal's own width, else `$COLUMNS` — which is what a user who
 * pipes output through `less` or runs under a harness that has no TTY can actually set. Failing both,
 * 120, which keeps a CI log readable rather than unbounded.
 */
export function terminalWidth(fallback = 120): number {
  if (process.stdout.columns && process.stdout.columns > 0) return process.stdout.columns;
  const env = Number(process.env.COLUMNS);
  if (Number.isInteger(env) && env > 0) return env;
  return fallback;
}

/** The horizontal rule under a heading: `width` columns, never wider than the terminal. */
export function headingRule(width: number): string {
  return rule(Math.min(width, terminalWidth()));
}

/** A labelled divider, `─── label ───`, filling `width` columns or the terminal, whichever is narrower. */
export function sectionRule(label: string, width = 48): string {
  const total = Math.min(width, terminalWidth());
  const side = Math.max(3, Math.floor((total - label.length - 2) / 2));
  return `${rule(side)} ${label} ${rule(side)}`;
}

export interface TableOptions {
  header?: string[];
  gap?: number;
  /** Columns available; 0 means "do not clamp". Defaults to the terminal width. */
  width?: number;
  /** Columns never narrowed below this when the table has to fit. */
  minColumn?: number;
  /** Drop a column no row has anything in — a heading over blank space costs width and says nothing. */
  hideEmptyColumns?: boolean;
}

/**
 * A plain column table. Cells are padded by printable width (so a coloured cell does not shift the row) and
 * the whole table is clamped to the terminal, narrowing the widest columns first rather than being wrapped
 * into unreadable fragments by the terminal itself.
 */
export function table(inputRows: string[][], opts: TableOptions = {}): string {
  let rows = inputRows;
  let header = opts.header;
  if (opts.hideEmptyColumns && rows.length) {
    const columnCount = Math.max(...rows.map((r) => r.length));
    const keep = Array.from({ length: columnCount }, (_, i) => rows.some((r) => displayWidth(r[i] ?? '') > 0));
    if (keep.some((k) => !k)) {
      rows = rows.map((r) => r.filter((_, i) => keep[i]));
      header = header?.filter((_, i) => keep[i]);
    }
  }
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return '';
  const gapSize = opts.gap ?? 2;
  const gap = ' '.repeat(gapSize);
  const columns = Math.max(...all.map((row) => row.length));
  const widths: number[] = new Array<number>(columns).fill(0);
  for (const row of all) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell))));

  const available = opts.width ?? terminalWidth();
  if (available > 0) {
    const minColumn = opts.minColumn ?? 6;
    const total = (): number => widths.reduce((sum, w) => sum + w, 0) + gapSize * (columns - 1);
    // Shave the widest column one column at a time, so the table degrades evenly instead of losing its tail.
    // The first column is the one you act on (a task or run id), so it is given up only once nothing else is left.
    while (total() > available) {
      let target = -1;
      for (let i = 1; i < columns; i++) {
        if ((widths[i] ?? 0) > minColumn && (target === -1 || (widths[i] ?? 0) > (widths[target] ?? 0))) target = i;
      }
      if (target === -1) {
        if ((widths[0] ?? 0) <= minColumn) break;
        target = 0;
      }
      widths[target] = (widths[target] ?? 0) - 1;
    }
  }

  const fmt = (row: string[]): string =>
    row
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        const clipped = truncateVisible(cell, width);
        // The last cell of a row needs no trailing padding.
        return i === row.length - 1 ? clipped : clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
      })
      .join(gap)
      // An empty trailing cell still leaves the padding of the one before it; nothing should end in spaces.
      .replace(/ +$/, '');
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, widths.map((w) => rule(w)).join(gap));
  return lines.join('\n');
}

export function parseList(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY && !process.env.CI && process.env.TERM !== 'dumb');
}
