/**
 * What Claude Code has spent recently, counted from the transcripts it already writes (spec §3.6, `[D29]`).
 *
 * There is no programmatic read of the Pro/Max windows, and `cao` makes no network calls of its own — but
 * the agent records every assistant message it receives under `~/.claude/projects/`, with a timestamp and
 * the API's own `usage` block. Adding those up inside a rolling window is arithmetic over a file the user's
 * own tool wrote, which is a different thing from asking Anthropic, and it is the only honest number
 * available here.
 *
 * **What this cannot know, and must not pretend to:** the limit. No local file records it — `~/.claude.json`
 * carries the tier's *name* (`default_claude_max_20x`) and no figure — so this reports what was spent and
 * never a percentage. `QuotaWindow.usedPercent` is null for everything here.
 *
 * Three things in the real data corrupt a naive reader, each measured rather than guessed:
 *
 * 1. **One assistant message is written once per content block, and every row carries the same complete
 *    `usage` object.** Over one day on the machine this was written for: 3870 rows, 1988 distinct
 *    `message.id`. Summing rows doubles every number, and nothing on screen would look wrong. Deduplication
 *    by message id is not an optimisation here, it is the difference between a number and a lie.
 * 2. **A resumed or forked session rewrites history under a new file name**, so the duplicates cross file
 *    boundaries and the ids have to be held for the whole scan rather than per file.
 * 3. **`apiBlockIndex` is not a usage window.** It indexes content blocks inside one response and resets
 *    within seconds; it looks like the five-hour block counter and is nothing of the kind.
 *
 * Cost: the tree was 309 MB across 195 files. The mtime prefilter is what makes this affordable — records
 * are appended in timestamp order, so a file untouched since the window opened holds nothing inside it —
 * and it takes the five-hour scan to a handful of files. Everything is streamed; nothing is read whole.
 */
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeConfigDir } from './session-file.js';

/** Token counts, kept apart because they are weighted differently and the split belongs in Diagnostics. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Every class added together: the volume that actually moved. */
  totalTokens: number;
  /** Distinct assistant messages, after deduplication. */
  messages: number;
}

export interface UsageWindow extends UsageTotals {
  /** The window's length in milliseconds, as asked for. */
  ms: number;
}

export interface ClaudeUsageReading {
  windows: UsageWindow[];
  /** The models seen inside the widest window, for Diagnostics. */
  models: string[];
  filesRead: number;
  /** Files that could not be statted, opened or parsed. Windows long paths are the usual cause. */
  filesSkipped: number;
  /** Nothing to read: no config directory, or no transcripts in it. */
  empty: boolean;
}

export interface ReadClaudeUsageOptions {
  /** Defaults to `<claudeConfigDir()>/projects`. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** Window lengths in milliseconds, longest last. */
  windows: number[];
  now: number;
  /** A ceiling on how much is parsed, so a very large tree cannot stall a frame. */
  maxBytes?: number;
}

/** Past this the scan gives up rather than holding a frame; the windows it has are still published. */
export const DEFAULT_MAX_BYTES = 400 * 1024 * 1024;

const empty = (ms: number): UsageWindow => ({ ms, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, messages: 0 });

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Every `*.jsonl` under `dir`, including the `<session>/subagents/` a delegating run writes. */
async function transcripts(dir: string): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      skipped += 1;
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  await walk(dir);
  return { files, skipped };
}

/**
 * Add up what Claude Code spent inside each window.
 *
 * Every file is streamed and every failure is counted rather than thrown: two of the 195 files on the
 * machine this was written for could not be statted at all, because a deep worktree slug had taken the path
 * past the Windows limit, and a reader that threw there would have reported nothing about the other 193.
 */
export async function readClaudeUsage(options: ReadClaudeUsageOptions): Promise<ClaudeUsageReading> {
  const root = options.dir ?? path.join(claudeConfigDir(options.env ?? process.env), 'projects');
  const windows = [...options.windows].sort((a, b) => a - b);
  const widest = windows[windows.length - 1] ?? 0;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totals = windows.map((ms) => empty(ms));
  const models = new Set<string>();
  // Held for the whole scan, not per file: a resumed session rewrites its history under a new file name,
  // so the same `message.id` appears in two of them.
  const seen = new Set<string>();
  let filesRead = 0;
  let bytes = 0;

  const found = await transcripts(root);
  let skipped = found.skipped;
  if (found.files.length === 0) {
    return { windows: totals, models: [], filesRead: 0, filesSkipped: skipped, empty: true };
  }

  // Newest first, so a scan that hits the byte ceiling has spent it on the rows most likely to be in range.
  const candidates: Array<{ file: string; size: number; mtimeMs: number }> = [];
  for (const file of found.files) {
    try {
      const stat = await fs.stat(file);
      // Records are appended in timestamp order, so a file untouched since the window opened holds nothing
      // inside it. This is what makes the five-hour window cost almost nothing.
      if (stat.mtimeMs >= options.now - widest) candidates.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      skipped += 1;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    if (bytes >= maxBytes) break;
    bytes += candidate.size;
    let stream;
    try {
      stream = createReadStream(candidate.file, { encoding: 'utf8' });
    } catch {
      skipped += 1;
      continue;
    }
    try {
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        // Cheap enough to matter over a quarter of a gigabyte: most rows are not assistant messages.
        if (!line.includes('"usage"')) continue;
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (row.type !== 'assistant') continue;
        const message = row.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        // `<synthetic>` is Claude Code's own marker for a message no API call produced.
        const model = typeof message?.model === 'string' ? message.model : '';
        if (model === '<synthetic>') continue;
        const id = (typeof message?.id === 'string' && message.id) || (typeof row.requestId === 'string' && row.requestId) || '';
        if (!id || seen.has(id)) continue;
        const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
        if (!Number.isFinite(at)) continue;
        const age = options.now - at;
        // The record's own timestamp decides which window it is in; the file's mtime only decided whether
        // the file was worth opening. A long-lived session has rows on both sides of the boundary.
        if (age < 0 || age > widest) continue;
        seen.add(id);
        if (model) models.add(model);
        const input = num(usage.input_tokens);
        const output = num(usage.output_tokens);
        const cacheRead = num(usage.cache_read_input_tokens);
        const cacheCreation = num(usage.cache_creation_input_tokens);
        for (const total of totals) {
          if (age > total.ms) continue;
          total.inputTokens += input;
          total.outputTokens += output;
          total.cacheReadTokens += cacheRead;
          total.cacheCreationTokens += cacheCreation;
          total.totalTokens += input + output + cacheRead + cacheCreation;
          total.messages += 1;
        }
      }
      filesRead += 1;
    } catch {
      skipped += 1;
    } finally {
      stream.destroy();
    }
  }

  return { windows: totals, models: [...models].sort(), filesRead, filesSkipped: skipped, empty: false };
}
