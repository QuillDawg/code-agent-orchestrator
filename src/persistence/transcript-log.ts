/**
 * Reading an attempt's `events.jsonl` back as transcript entries, and reaching the part of it that is no
 * longer in memory.
 *
 * The live buffer keeps only the newest `execution.outputBufferLines` entries, so scrolling past its oldest
 * line has to go to the file. The file is the whole record of the attempt and is append-only, which is what
 * makes "the entries just before this one" answerable without any bookkeeping.
 */
import { promises as fs } from 'node:fs';
import { parseTranscriptLine, transcriptLine, type TranscriptEntry } from '../types/transcript.js';

/** How many older entries one page brings in. Roughly a screenful of scrolling at a time. */
export const OLDER_PAGE = 200;

/**
 * Identity of an entry across the memory/disk boundary: the same record read from `events.jsonl` and held
 * in the ring buffer are different objects with different key order, so they are matched on what they say.
 */
export function entryKey(entry: TranscriptEntry): string {
  return `${entry.ts}|${entry.kind}|${transcriptLine(entry)}`;
}

/** Every entry of one attempt's events.jsonl, oldest first. Lines that are not entries are skipped. */
export async function readTranscriptFile(file: string): Promise<TranscriptEntry[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const entries: TranscriptEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim() ? parseTranscriptLine(line) : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The `count` entries immediately before `oldest` in `all`.
 *
 * When `oldest` is not in the file there is nothing safe to return: the caller is showing entries from a
 * different attempt (the live buffer spans a task, the file spans one attempt), and guessing a slice would
 * duplicate what is already on screen. Empty means "you are already at the beginning".
 */
export function entriesBefore(all: readonly TranscriptEntry[], oldest: TranscriptEntry | undefined, count: number): TranscriptEntry[] {
  if (count <= 0) return [];
  if (!oldest) return all.slice(Math.max(0, all.length - count));
  const i = indexOfEntry(all, oldest);
  return i < 0 ? [] : all.slice(Math.max(0, i - count), i);
}

/** Where `entry` sits in `all`, matched on what it says; -1 when this file is not the one that holds it. */
function indexOfEntry(all: readonly TranscriptEntry[], entry: TranscriptEntry): number {
  const key = entryKey(entry);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (entryKey(all[i]!) === key) return i;
  }
  return -1;
}

/** `entriesBefore` against an attempt's events.jsonl. */
export async function readOlderEntries(file: string, oldest: TranscriptEntry | undefined, count = OLDER_PAGE): Promise<TranscriptEntry[]> {
  return entriesBefore(await readTranscriptFile(file), oldest, count);
}

/**
 * `entriesBefore` across a task's attempt files, newest attempt first.
 *
 * The dashboard's live buffer spans every attempt of a task while each `events.jsonl` covers one, so on a
 * task now on attempt 2 the oldest entry on screen usually belongs to attempt 1. Looking for it in attempt
 * 2's file alone finds nothing, and an empty answer reads as "you are already at the beginning" — which is
 * how paging came to switch itself off on exactly the tasks that have the most transcript to page through.
 *
 * So walk back until an attempt owns the entry, and when the beginning of that attempt is reached carry on
 * into the tail of the one before it, which is what "older" means for a buffer that spans them.
 */
export async function readOlderAcrossAttempts(files: readonly string[], oldest: TranscriptEntry | undefined, count = OLDER_PAGE): Promise<TranscriptEntry[]> {
  let target = oldest;
  for (const file of files) {
    const all = await readTranscriptFile(file);
    if (!target) {
      if (all.length) return all.slice(Math.max(0, all.length - count));
      continue;
    }
    const i = indexOfEntry(all, target);
    if (i < 0) continue;
    const page = all.slice(Math.max(0, i - count), i);
    if (page.length) return page;
    target = undefined;
  }
  return [];
}
