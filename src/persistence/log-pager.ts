/**
 * Reading the tail of a log file, and the page before it, without ever holding the file (spec §3.7).
 *
 * `readTail` in `src/tui/follow.ts` reads the whole file and keeps the last N lines of it. That is the right
 * shape for an attempt's `events.jsonl`, which is bounded by the attempt; it is the wrong shape for
 * `stdout.log`, which is bounded by nothing. A worker that streams for two hours writes tens of megabytes,
 * and the Logs panel has to open on it in the time it takes to draw a frame.
 *
 * So the file is read backwards from its end in chunks, stopping as soon as enough newlines have gone past,
 * and every page carries the byte offsets it covers so the next one starts where this one ended. Nothing
 * here decodes more than `lines * MAX_LINE_BYTES` bytes, whatever the file weighs.
 */
import { promises as fs } from 'node:fs';

/** How many lines one page holds. A screenful of scrolling at a time, like the transcript pager's `OLDER_PAGE`. */
export const LOG_PAGE_LINES = 200;

/** How much of a single line is kept. A `stdout.log` line is one whole stream-json message; some are enormous. */
export const MAX_LINE_BYTES = 8192;

/** How much is read in one `read()`. Big enough that a page of ordinary log lines needs one of them. */
const CHUNK = 64 * 1024;

/** The hard ceiling on one page, whatever `lines` asks for: a file of one 50 MB line still costs 4 MB. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

export interface LogPage {
  /** The lines of this page, oldest first. A line longer than `MAX_LINE_BYTES` is cut and marked. */
  lines: string[];
  /** Byte offset of the first byte of the first line. */
  start: number;
  /** Byte offset just past the last line, i.e. where the next page begins. */
  end: number;
  /** The file's size when this page was read. */
  size: number;
  /** Nothing precedes this page. */
  atStart: boolean;
  /** Nothing follows it. */
  atEnd: boolean;
  /**
   * How many bytes were read from disk to produce this page.
   *
   * The bound §3.7 asks for, made visible: a page of a 50 MB log costs a chunk or two, not 50 MB, and a
   * test can say so in bytes rather than in milliseconds on whichever disk it happens to run on.
   */
  scanned: number;
}

/** What `MAX_LINE_BYTES` leaves behind, so a cut line reads as cut rather than as a line that ended there. */
export const TRUNCATION_MARK = '…';

const EMPTY = (size = 0): LogPage => ({ lines: [], start: 0, end: 0, size, atStart: true, atEnd: true, scanned: 0 });

function cap(lines: number): number {
  return Math.min(MAX_PAGE_BYTES, Math.max(CHUNK, lines * MAX_LINE_BYTES));
}

/** Split a decoded chunk into lines, cutting the ones no terminal could show anyway. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => (line.length > MAX_LINE_BYTES ? `${line.slice(0, MAX_LINE_BYTES)}${TRUNCATION_MARK}` : line));
}

async function withFile<T>(file: string, fn: (handle: fs.FileHandle, size: number) => Promise<T>, fallback: T): Promise<T> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    return await fn(handle, stat.size);
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The `lines` lines ending at byte `until`.
 *
 * Reads backwards a chunk at a time and stops at the first newline *before* the oldest line it needs, so
 * the page never starts halfway through a line — except at byte 0, where there is nothing before it.
 */
async function pageEndingAt(file: string, until: number, lines: number): Promise<LogPage> {
  if (lines <= 0) return EMPTY();
  return withFile(
    file,
    async (handle, size) => {
      const end = Math.max(0, Math.min(until, size));
      if (end === 0) return { lines: [], start: 0, end: 0, size, atStart: true, atEnd: size === 0, scanned: 0 };
      const budget = cap(lines);
      let from = end;
      let text = '';
      let scanned = 0;
      let complete = false;
      while (from > 0 && end - from < budget) {
        const length = Math.min(CHUNK, from);
        from -= length;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, from);
        scanned += length;
        text = buf.toString('utf8') + text;
        // One more newline than the lines wanted: the extra one is the boundary this page starts after.
        const seen = countNewlines(text);
        if (seen > lines) {
          complete = true;
          break;
        }
      }
      // Drop the trailing newline so the last line is not an empty string, then take the newest `lines`.
      const body = text.endsWith('\n') ? text.slice(0, -1) : text;
      let all = splitLines(body);
      let start = from;
      if (complete || from > 0) {
        // The first entry is whatever preceded the boundary newline; it is not a whole line, so it goes.
        const first = all.shift() ?? '';
        start += Buffer.byteLength(first, 'utf8') + 1;
      }
      if (all.length > lines) {
        const dropped = all.slice(0, all.length - lines);
        start += dropped.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0);
        all = all.slice(-lines);
      }
      return { lines: all, start, end, size, atStart: start <= 0, atEnd: end >= size, scanned };
    },
    EMPTY(),
  );
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** The newest `lines` lines of `file`. An unreadable or missing file is an empty page, never a throw. */
export async function readTailPage(file: string, lines = LOG_PAGE_LINES): Promise<LogPage> {
  const size = await fs.stat(file).then((s) => s.size).catch(() => -1);
  if (size < 0) return EMPTY();
  return pageEndingAt(file, size, lines);
}

/** The `lines` lines immediately before byte `offset`, i.e. the page above the one that starts there. */
export async function readPageBefore(file: string, offset: number, lines = LOG_PAGE_LINES): Promise<LogPage> {
  if (offset <= 0) return EMPTY();
  return pageEndingAt(file, offset, lines);
}

/** The `lines` lines starting at byte `offset`, i.e. the page below the one that ends there. */
export async function readPageAfter(file: string, offset: number, lines = LOG_PAGE_LINES): Promise<LogPage> {
  if (lines <= 0) return EMPTY();
  return withFile(
    file,
    async (handle, size) => {
      const start = Math.max(0, Math.min(offset, size));
      if (start >= size) return { lines: [], start, end: start, size, atStart: start <= 0, atEnd: true, scanned: 0 };
      const budget = cap(lines);
      let to = start;
      let text = '';
      let scanned = 0;
      while (to < size && to - start < budget) {
        const length = Math.min(CHUNK, size - to);
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, to);
        scanned += length;
        to += length;
        text += buf.toString('utf8');
        if (countNewlines(text) > lines) break;
      }
      let all = splitLines(text);
      // The last entry ends at a chunk boundary rather than at a newline unless the file ended there.
      if (to < size) all.pop();
      else if (text.endsWith('\n')) all.pop();
      let end = start;
      if (all.length > lines) all = all.slice(0, lines);
      for (const line of all) end += Buffer.byteLength(line, 'utf8') + 1;
      return { lines: all, start, end: Math.min(end, size), size, atStart: start <= 0, atEnd: end >= size, scanned };
    },
    EMPTY(),
  );
}
