/**
 * The changed-file list of a task, as the dashboard shows it.
 *
 * Two sources, in this order of trust: the per-file records the attempt captured when it finished
 * (`diff.json`, mirrored into the result's `git.files`), and — while the attempt is still running, or when
 * `git.captureDiff` is off — the file operations seen in the tool stream. The tool stream knows which files
 * were touched but not how many lines changed; a captured record knows both, so it wins whenever it exists.
 */
import { sanitizeText } from '../../util/text.js';
import type { TaskRunState } from '../../types/run.js';
import type { DiffFileRecord, DiffFileStatus } from '../../types/result.js';
import type { FileOp } from '../../types/transcript.js';

export interface ReviewFile {
  path: string;
  /** Previous path of a rename; only set when `status` is `R`. */
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Live list only: how many operations the tool stream has seen on this file. Undefined for a captured record. */
  ops?: number;
}

/** A tool-stream operation only says what the worker did to the file, which maps onto three of the four letters. */
const OP_STATUS: Record<FileOp, DiffFileStatus> = { write: 'A', edit: 'M', delete: 'D' };

function byPath(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

/** Captured records, in the shape the review view renders. */
export function recordFiles(records: readonly DiffFileRecord[]): ReviewFile[] {
  return records.map((r) => ({ ...r })).sort(byPath);
}

/** What the tool stream saw across every attempt, with no line counts to give. */
export function liveFiles(st: TaskRunState): ReviewFile[] {
  const out = new Map<string, ReviewFile>();
  for (const attempt of st.attempts) {
    for (const [path, touch] of Object.entries(attempt.files ?? {})) {
      const previous = out.get(path);
      out.set(path, { path, status: OP_STATUS[touch.lastOp] ?? 'M', additions: 0, deletions: 0, binary: false, ops: (previous?.ops ?? 0) + touch.ops });
    }
  }
  return [...out.values()].sort(byPath);
}

/**
 * The best list available without reading the run directory: the result's captured records when the task
 * finished with them, the live tool-stream list otherwise. An empty captured list means "this attempt
 * changed nothing" and is returned as such — falling back to the tool stream there would list files the
 * worker wrote and then reverted.
 */
export function taskFiles(st: TaskRunState): ReviewFile[] {
  const captured = st.result?.git?.files;
  return captured ? recordFiles(captured) : liveFiles(st);
}

/**
 * `src/x.ts`, or `old.ts -> new.ts` for a rename. Sanitized: a path is whatever the worker named the file,
 * and a file name can hold an escape sequence just as a transcript line can.
 */
export function fileLabel(file: ReviewFile): string {
  return sanitizeText(file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path);
}

/**
 * A label cut to `width`, keeping the end. The tail of a path is what identifies it — the file name and the
 * directory holding it — and the columns after it carry the line counts, so a path too long for the row is
 * shortened rather than left to push them off the edge.
 */
export function shortenLabel(label: string, width: number): string {
  if (width <= 0) return '';
  if (label.length <= width) return label;
  return width === 1 ? '…' : `…${label.slice(label.length - width + 1)}`;
}

/** `+12 -4`, `binary`, or the operation count while only the tool stream knows about the file. */
export function fileCounts(file: ReviewFile): { additions?: string; deletions?: string; note?: string } {
  if (file.binary) return { note: 'binary' };
  if (file.ops !== undefined) return { note: file.ops > 1 ? `×${file.ops}` : '' };
  return { additions: `+${file.additions}`, deletions: `-${file.deletions}` };
}
