/**
 * The local Claude usage reader (spec §3.6, `[D29]`).
 *
 * Everything here is against a fixture tree, never against the real `~/.claude`: the numbers this produces
 * are the footer's only Claude figures, and a test that read the machine it runs on could not assert one.
 *
 * The first case is the one that matters. Claude Code writes one row per *content block* and gives every
 * row the same complete `usage` object, so a reader that sums rows reports roughly double and nothing on
 * screen looks wrong. Measured on a real tree: 3870 rows, 1988 distinct message ids.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/index.js';
import { readClaudeUsage } from '../../src/runners/claude/usage-log.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

interface RowOptions {
  id: string;
  minutesAgo: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  model?: string;
  type?: string;
  requestId?: string;
}

function row(o: RowOptions): string {
  return JSON.stringify({
    type: o.type ?? 'assistant',
    timestamp: new Date(NOW - o.minutesAgo * 60_000).toISOString(),
    requestId: o.requestId ?? `req_${o.id}`,
    message: {
      id: o.id,
      model: o.model ?? 'claude-opus-5',
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: o.cacheCreation ?? 0,
      },
    },
  });
}

/** A projects tree with the given files, each a list of JSONL lines. */
async function tree(files: Record<string, string[]>): Promise<string> {
  const dir = await tmpDir('claude-usage-');
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const projects = path.join(dir, 'projects');
  for (const [relative, lines] of Object.entries(files)) {
    const file = path.join(projects, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  }
  await fs.mkdir(projects, { recursive: true });
  return projects;
}

const read = (dir: string, windows = [FIVE_HOURS, SEVEN_DAYS]) => readClaudeUsage({ dir, windows, now: NOW });

describe('reading what Claude Code has spent, from its own transcripts', () => {
  it('counts one assistant message once, however many content blocks it was written as', async () => {
    // The five rows below are one API response: same `message.id`, same `requestId`, and each carrying the
    // whole `usage` object rather than a share of it. Summing rows gives 5x.
    const dir = await tree({
      'proj-a/session-1.jsonl': [0, 1, 2, 3, 4].map(() => row({ id: 'msg-1', minutesAgo: 10, input: 2, output: 1696, cacheRead: 33_576 })),
    });
    const usage = await read(dir);
    const five = usage.windows.find((w) => w.ms === FIVE_HOURS)!;
    expect(five.messages).toBe(1);
    expect(five.inputTokens).toBe(2);
    expect(five.outputTokens).toBe(1696);
    expect(five.cacheReadTokens).toBe(33_576);
    expect(five.totalTokens).toBe(2 + 1696 + 33_576);
  });

  it('counts a message once when a resumed session rewrote it into a second file', async () => {
    // A resume forks the transcript under a new session id and replays the history into it, so the same
    // message id is in two files. Deduplicating per file would count it twice.
    const dir = await tree({
      'proj-a/session-1.jsonl': [row({ id: 'msg-1', minutesAgo: 20, output: 100 })],
      'proj-a/session-2.jsonl': [row({ id: 'msg-1', minutesAgo: 20, output: 100 }), row({ id: 'msg-2', minutesAgo: 5, output: 7 })],
    });
    const five = (await read(dir)).windows.find((w) => w.ms === FIVE_HOURS)!;
    expect(five.messages).toBe(2);
    expect(five.outputTokens).toBe(107);
  });

  it("counts a subagent's own transcript, which is a file in a directory beside the session", async () => {
    const dir = await tree({
      'proj-a/session-1.jsonl': [row({ id: 'msg-1', minutesAgo: 5, output: 10 })],
      'proj-a/session-1/subagents/agent-explore.jsonl': [row({ id: 'msg-sub', minutesAgo: 4, output: 90 })],
    });
    const five = (await read(dir)).windows.find((w) => w.ms === FIVE_HOURS)!;
    expect(five.messages).toBe(2);
    expect(five.outputTokens).toBe(100);
  });

  it('skips a synthetic message, which no API call produced', async () => {
    const dir = await tree({
      'proj-a/session-1.jsonl': [row({ id: 'msg-1', minutesAgo: 5, output: 10, model: '<synthetic>' }), row({ id: 'msg-2', minutesAgo: 5, output: 4 })],
    });
    const five = (await read(dir)).windows.find((w) => w.ms === FIVE_HOURS)!;
    expect(five.messages).toBe(1);
    expect(five.outputTokens).toBe(4);
    expect((await read(dir)).models).toEqual(['claude-opus-5']);
  });

  it("takes the window from the record's own timestamp, not from the file it is in", async () => {
    // One long-lived session with rows on both sides of the five-hour boundary. The file was written a
    // minute ago, so the mtime prefilter keeps it; only the timestamps decide what is counted.
    const dir = await tree({
      'proj-a/session-1.jsonl': [
        row({ id: 'old', minutesAgo: 60 * 8, output: 1000 }),
        row({ id: 'new', minutesAgo: 30, output: 7 }),
      ],
    });
    const usage = await read(dir);
    const five = usage.windows.find((w) => w.ms === FIVE_HOURS)!;
    const week = usage.windows.find((w) => w.ms === SEVEN_DAYS)!;
    expect(five.outputTokens).toBe(7);
    expect(five.messages).toBe(1);
    expect(week.outputTokens).toBe(1007);
    expect(week.messages).toBe(2);
  });

  it('drops a row from the future rather than counting it', async () => {
    const dir = await tree({ 'proj-a/s.jsonl': [row({ id: 'ahead', minutesAgo: -60, output: 500 })] });
    const five = (await read(dir)).windows.find((w) => w.ms === FIVE_HOURS)!;
    expect(five.messages).toBe(0);
  });

  it('steps over a malformed line and keeps the rest of the file', async () => {
    const dir = await tree({
      'proj-a/s.jsonl': ['{"usage": not json at all', row({ id: 'msg-1', minutesAgo: 5, output: 12 }), '', '{"type":"user","message":{"content":"hi"}}'],
    });
    const usage = await read(dir);
    expect(usage.windows.find((w) => w.ms === FIVE_HOURS)!.outputTokens).toBe(12);
    expect(usage.filesRead).toBe(1);
  });

  it('says it has nothing to read rather than reporting zero, when there are no transcripts', async () => {
    // "Nothing to estimate from" and "you have spent nothing" are different answers, and only one of them
    // should ever reach a chip.
    const dir = await tree({});
    const usage = await read(dir);
    expect(usage.empty).toBe(true);
    expect(usage.filesRead).toBe(0);
    const missing = await readClaudeUsage({ dir: path.join(dir, 'nowhere'), windows: [FIVE_HOURS], now: NOW });
    expect(missing.empty).toBe(true);
  });

  it('stops at the byte ceiling rather than holding a frame, and still answers', async () => {
    const dir = await tree({
      'proj-a/s1.jsonl': [row({ id: 'a', minutesAgo: 5, output: 10 })],
      'proj-a/s2.jsonl': [row({ id: 'b', minutesAgo: 5, output: 10 })],
    });
    const usage = await readClaudeUsage({ dir, windows: [FIVE_HOURS], now: NOW, maxBytes: 1 });
    expect(usage.filesRead).toBe(1);
    expect(usage.empty).toBe(false);
  });
});
