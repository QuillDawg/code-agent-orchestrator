/**
 * Per-attempt diff capture. Two sides are compared, each a commit or a tree object:
 *
 * - worktree attempts compare the task's base commit with its branch head (plus, when the tree is still
 *   dirty, a snapshot of the uncommitted work);
 * - shared-tree attempts compare working-tree snapshots taken at acquire and at finalize, because the
 *   agent never commits there.
 *
 * A snapshot writes a git tree object through a throwaway index (`GIT_INDEX_FILE`); the real index and the
 * working tree are never touched.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AttemptDiff, DiffFileRecord, DiffFileStatus } from '../types/result.js';
import type { Git } from './git.js';
import { ORCHESTRATOR_DIR, safeSegment } from '../persistence/paths.js';

/** An `AttemptDiff` together with the unified patch written to `diff.patch`. */
export interface CapturedDiff extends AttemptDiff {
  patch: string;
}

export interface CaptureOptions {
  /** Working directory git runs in; also the root of the compared subtree. */
  cwd: string;
  /** Cap on the bytes of `patch`; the file records are never truncated. */
  maxBytes: number;
}

const DIFF_FLAGS = ['-M', '--no-ext-diff', '--no-textconv'];
/**
 * Flags only the patch needs, so that `git apply` accepts the result: `--binary` carries the literal
 * content of a changed binary file (without it git only prints "Binary files ... differ" and refuses to
 * apply), and `--full-index` writes whole blob ids so `git apply -3` can fall back to a three-way merge.
 */
const PATCH_FLAGS = ['--binary', '--full-index'];

/** Git's status letters collapsed onto the four the records use (`C`opy counts as a new file). */
const STATUS: Record<string, DiffFileStatus> = { A: 'A', C: 'A', D: 'D', R: 'R' };

/**
 * Diff two commits/trees and return the per-file records plus the (possibly truncated) patch.
 * Returns undefined when git could not produce the diff (unknown object, no repository, ...).
 */
export async function captureDiff(git: Git, base: string, head: string, opts: CaptureOptions): Promise<CapturedDiff | undefined> {
  const args = (extra: string[]): string[] => ['diff', ...DIFF_FLAGS, ...extra, base, head];
  const nameStatus = await git.run(args(['--name-status', '-z']), { reject: false, cwd: opts.cwd, raw: true });
  if (nameStatus.exitCode !== 0) return undefined;
  const numstat = await git.run(args(['--numstat', '-z']), { reject: false, cwd: opts.cwd, raw: true });
  if (numstat.exitCode !== 0) return undefined;
  const files = mergeRecords(nameStatus.stdout, numstat.stdout);

  const maxBytes = Math.max(0, opts.maxBytes);
  // Read at most maxBytes characters so a runaway diff cannot be buffered whole; a character is never
  // shorter than a byte, so this can only over-read, and the byte truncation below finishes the job.
  const patchRes = await git.run(args(['-p', ...PATCH_FLAGS]), { reject: false, cwd: opts.cwd, raw: true, maxBuffer: maxBytes || 1 });
  if (patchRes.exitCode !== 0 && !patchRes.truncated) return undefined;
  const { patch, truncated } = capPatch(patchRes.stdout, maxBytes, patchRes.truncated, files.length);

  return {
    schemaVersion: 1,
    base,
    head,
    truncated,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files,
    patch,
  };
}

/** Cut the patch to `maxBytes` on a line boundary and say so at the end. */
function capPatch(raw: string, maxBytes: number, alreadyTruncated: boolean, fileCount: number): { patch: string; truncated: boolean } {
  const buf = Buffer.from(raw, 'utf8');
  if (!alreadyTruncated && buf.byteLength <= maxBytes) return { patch: raw, truncated: false };
  let patch = '';
  if (maxBytes > 0) {
    const cut = buf.subarray(0, maxBytes).toString('utf8');
    const lastNewline = cut.lastIndexOf('\n');
    patch = lastNewline >= 0 ? cut.slice(0, lastNewline + 1) : '';
  }
  const kept = Buffer.byteLength(patch, 'utf8');
  return {
    patch: `${patch}... diff truncated after ${kept} of at most ${maxBytes} bytes (git.maxDiffBytes); all ${fileCount} file(s) are listed in diff.json\n`,
    truncated: true,
  };
}

/**
 * Snapshot the working tree under `cwd` as a git tree object, using a throwaway index so neither the real
 * index nor the working tree is disturbed. Returns undefined if git refuses (e.g. no repository).
 */
export async function snapshotTree(git: Git, cwd: string, indexFile: string): Promise<string | undefined> {
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  await discardIndex(indexFile);
  try {
    // Seeding from the real index turns `add -A` into a stat-only refresh; an unreadable or stale index
    // only costs the rescan it saves, so any failure just falls through to the empty one.
    const gitDir = await git.gitDir(cwd);
    if (gitDir) await fs.copyFile(path.join(gitDir, 'index'), indexFile).catch(() => undefined);
    const env = { GIT_INDEX_FILE: indexFile };
    const add = ['add', '-A', '--', '.'];
    let res = await git.run(add, { reject: false, cwd, env });
    if (res.exitCode !== 0) {
      await discardIndex(indexFile);
      res = await git.run(add, { reject: false, cwd, env });
      if (res.exitCode !== 0) return undefined;
    }
    // The run directory holds this very index file and is normally git-excluded already; drop it from the
    // snapshot even when it is not, so the orchestrator's own files never surface in a task's diff.
    await git.run(['rm', '-r', '-f', '--cached', '-q', '--ignore-unmatch', '--', ORCHESTRATOR_DIR], { reject: false, cwd, env });
    const tree = await git.run(['write-tree'], { reject: false, cwd, env });
    return tree.exitCode === 0 && tree.stdout ? tree.stdout : undefined;
  } finally {
    await discardIndex(indexFile);
  }
}

async function discardIndex(indexFile: string): Promise<void> {
  await fs.rm(indexFile, { force: true }).catch(() => undefined);
  await fs.rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
}

/**
 * Directory holding one run's throwaway index files. Per run, so two runs in the same repository cannot
 * write each other's snapshot index, and so the whole directory can be removed when the run ends.
 */
export function snapshotIndexDir(repositoryRoot: string, runId: string): string {
  return path.join(repositoryRoot, ORCHESTRATOR_DIR, 'tmp', safeSegment(runId));
}

/** Path of the throwaway index for one snapshot. Lives beside the run data, outside every worktree. */
export function snapshotIndexPath(repositoryRoot: string, runId: string, label: string): string {
  return path.join(snapshotIndexDir(repositoryRoot, runId), `index-${label.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
}

/**
 * Drop a run's scratch directory, and the shared `tmp` parent once the last run has let go of it, so a
 * finished repository looks exactly as it did before the run.
 */
export async function removeSnapshotIndexDir(repositoryRoot: string, runId: string): Promise<void> {
  await fs.rm(snapshotIndexDir(repositoryRoot, runId), { recursive: true, force: true }).catch(() => undefined);
  // Fails while another run still has a directory here, which is exactly the wanted behaviour.
  await fs.rmdir(path.join(repositoryRoot, ORCHESTRATOR_DIR, 'tmp')).catch(() => undefined);
}

/**
 * Merge `--name-status -z` (authoritative for the status letter and rename pairing) with `--numstat -z`
 * (line counts, `-`/`-` for binary). Both are keyed by the new path.
 */
function mergeRecords(nameStatus: string, numstat: string): DiffFileRecord[] {
  const counts = parseNumstat(numstat);
  const records: DiffFileRecord[] = [];
  const tokens = nameStatus.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    const letter = status[0]!;
    const renamed = letter === 'R' || letter === 'C';
    const first = tokens[i++];
    const second = renamed ? tokens[i++] : undefined;
    const filePath = (renamed ? second : first) ?? '';
    if (!filePath) continue;
    const count = counts.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
    const record: DiffFileRecord = { path: filePath, status: STATUS[letter] ?? 'M', ...count };
    if (letter === 'R' && first) record.oldPath = first;
    records.push(record);
  }
  return records;
}

type Counts = { additions: number; deletions: number; binary: boolean };

/**
 * `--numstat -z` fields are NUL-terminated: `"1\t0\tpath"` normally, and for a rename `"1\t0\t"` followed
 * by two more tokens holding the old and the new path.
 */
function parseNumstat(out: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const tokens = out.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (!token) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!m) continue;
    let filePath = m[3]!;
    if (filePath === '') {
      i++; // old path
      filePath = tokens[i++] ?? '';
    }
    if (!filePath) continue;
    const binary = m[1] === '-' || m[2] === '-';
    counts.set(filePath, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return counts;
}

/** `git diff --stat`-like one-line-per-file summary built from the records, for context and CLI output. */
export function formatDiffStat(files: DiffFileRecord[]): string {
  return files
    .map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path}  ${f.binary ? 'binary' : `+${f.additions} -${f.deletions}`}`)
    .join('\n');
}

/** One file of real `git diff --stat` output, with the lines it moved and the `++--` graph if there was one. */
const STAT_FILE_RE = /^\s*(\S.*?)\s+\|\s+(Bin\b.*?|\d+)(?:\s+([+-]+))?\s*$/;
/** Its trailing line: `22 files changed, 1002 insertions(+), 86 deletions(-)`. */
const STAT_TOTAL_RE = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?\s*$/;

/** A file in a parsed `--stat`: the lines it moved, split into additions and deletions only when git said so. */
export interface DiffStatFile {
  path: string;
  oldPath?: string;
  /** Total lines the file changed. Zero for a binary or mode-only change. */
  changed: number;
  binary: boolean;
  /** Set only when the `++--` graph was unscaled, so the split is exact rather than a picture of one. */
  additions?: number;
  deletions?: number;
}

export interface ParsedDiffStat {
  files: DiffStatFile[];
  /** From the summary line, which is exact; undefined when the text had no summary line. */
  additions?: number;
  deletions?: number;
}

/**
 * Read back `git diff --stat` text — what `GitInfo.diffStat` holds for a run whose attempts captured no
 * `diff.json`. The summary line's insertion and deletion totals are exact; the per-file `++--` graph is
 * scaled to the terminal width whenever it would not fit, so a file's split is only trusted when the
 * graph's own characters add up to the number of lines beside it.
 */
export function parseDiffStat(text: string): ParsedDiffStat | undefined {
  const files: DiffStatFile[] = [];
  let additions: number | undefined;
  let deletions: number | undefined;
  let sawTotal = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const total = STAT_TOTAL_RE.exec(line);
    if (total) {
      sawTotal = true;
      additions = Number(total[2] ?? 0);
      deletions = Number(total[3] ?? 0);
      continue;
    }
    const m = STAT_FILE_RE.exec(line);
    if (!m) continue;
    const binary = m[2]!.startsWith('Bin');
    const changed = binary ? 0 : Number(m[2]);
    const graph = m[3] ?? '';
    const plus = graph.length - graph.replace(/\+/g, '').length;
    const minus = graph.length - plus;
    const exact = !binary && graph.length > 0 && plus + minus === changed;
    files.push({ ...splitRenamePath(m[1]!), changed, binary, ...(exact ? { additions: plus, deletions: minus } : {}) });
  }
  if (!files.length && !sawTotal) return undefined;
  return { files, additions, deletions };
}

/** `src/{old.ts => new.ts}` and `old.ts => new.ts`, the two shapes `--stat` writes a rename as. */
function splitRenamePath(spec: string): { path: string; oldPath?: string } {
  const brace = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(spec);
  if (brace) {
    const join = (mid: string): string => `${brace[1]}${mid}${brace[4]}`.replace(/\/{2,}/g, '/');
    return { path: join(brace[3]!), oldPath: join(brace[2]!) };
  }
  const arrow = /^(.*?) => (.*)$/.exec(spec);
  if (arrow) return { path: arrow[2]!, oldPath: arrow[1]! };
  return { path: spec };
}
