/**
 * The number §6.3.1's phase gate asks for: entries per second for `createTranscriptPlan()` against
 * `planTranscript` re-run, at 1 000, 10 000 and 30 000 entries.
 *
 *     npx tsx scripts/bench-transcript-plan.ts [--entries 1000,10000,30000] [--batch 50] [--rounds 5]
 *
 * What is measured is the thing the app actually does behind a 250 ms tailer (§6.3): replay a whole attempt
 * in batches, planning after each one. The re-run column is today's only option — `planTranscript` over the
 * whole buffer, four passes and a fresh tree, every time a batch lands. The incremental column is the same
 * replay through the stateful planner. Both are handed the *same* pre-computed batches, and the re-run path
 * appends into a growing array rather than re-slicing, so neither pays for the harness.
 *
 * `slowest update` is the number that decides whether a frame is dropped: the single worst batch, which for
 * the re-run path is always the last one, because that is when the array it re-reads is longest.
 *
 * Nothing here is a test. It prints; it asserts nothing. The correctness claim is
 * `test/unit/incremental-planner.test.ts`.
 */
import { createTranscriptPlan, planTranscript, type TranscriptEntry } from 'code-agent-orchestrator-protocol';

/** Deterministic PRNG, so two runs of this script measure the same log. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An attempt log of `count` entries with the shape a real one has: prose and thinking around tool calls
 * whose results land a few entries later, `Agent:` calls that spawn a run of nested entries, and a `result`
 * at the end. Roughly a fifth of the calls are still open when the attempt ends, which is what gives `over`
 * something to flip.
 */
function syntheticLog(count: number): TranscriptEntry[] {
  const random = seeded(count);
  const start = Date.parse('2026-09-03T10:11:12.000Z');
  const at = (i: number): string => new Date(start + i * 40).toISOString();
  const out: TranscriptEntry[] = [];
  const open: { id: string; parent?: string }[] = [];
  let agent: { id: string; left: number } | undefined;

  while (out.length < count - 1) {
    const i = out.length;
    const under = agent && agent.left > 0 ? agent.id : undefined;
    if (agent && agent.left > 0) agent.left -= 1;
    const inherit = under ? { parentToolUseId: under } : {};
    const roll = random();
    if (open.length > 3 && roll < 0.34) {
      const call = open.shift()!;
      out.push({ kind: 'tool_result', ts: at(i), text: 'ok', isError: false, toolUseId: call.id, ...(call.parent ? { parentToolUseId: call.parent } : {}) });
    } else if (roll < 0.5) {
      out.push({ kind: 'thinking', ts: at(i), text: `considering step ${i}`, ...inherit });
    } else if (roll < 0.7) {
      out.push({ kind: 'text', ts: at(i), text: `line ${i}`, ...inherit });
    } else if (!under && roll < 0.76) {
      const id = `a${i}`;
      out.push({ kind: 'tool', ts: at(i), tool: 'Agent', line: `Agent: task ${i}`, toolUseId: id });
      open.push({ id });
      agent = { id, left: 12 };
    } else {
      const id = `t${i}`;
      out.push({ kind: 'command', ts: at(i), command: `npm run step-${i}`, tool: 'Bash', toolUseId: id, ...inherit });
      open.push({ id, parent: under });
    }
  }
  out.push({ kind: 'result', ts: at(out.length), status: 'success', isError: false });
  return out;
}

/** What one replay cost: the whole attempt, and the single worst batch in it. */
interface Cost {
  totalMs: number;
  slowestMs: number;
}

const best = (runs: readonly Cost[]): Cost => runs.reduce((a, b) => (b.totalMs < a.totalMs ? b : a));

function replayIncremental(batches: readonly TranscriptEntry[][]): Cost {
  const planner = createTranscriptPlan();
  let slowest = 0;
  const started = performance.now();
  for (const batch of batches) {
    const at = performance.now();
    planner.append(batch);
    planner.plan();
    slowest = Math.max(slowest, performance.now() - at);
  }
  return { totalMs: performance.now() - started, slowestMs: slowest };
}

/**
 * The same replay, driven by the delta instead: `append` reports what moved and the caller updates those
 * rows, so the whole tree is asked for once at the end rather than on every batch. This is the mode
 * `{ added, changed }` exists for, and the one that separates the planner's own cost from the unavoidable
 * cost of handing a renderer an N-element list.
 */
function replayDelta(batches: readonly TranscriptEntry[][]): Cost {
  const planner = createTranscriptPlan();
  let slowest = 0;
  const started = performance.now();
  for (const batch of batches) {
    const at = performance.now();
    const moved = planner.append(batch);
    if (moved.added.length < 0) throw new Error('unreachable: the delta must not be optimised away');
    slowest = Math.max(slowest, performance.now() - at);
  }
  planner.plan();
  return { totalMs: performance.now() - started, slowestMs: slowest };
}

function replayRerun(batches: readonly TranscriptEntry[][]): Cost {
  const buffer: TranscriptEntry[] = [];
  let slowest = 0;
  const started = performance.now();
  for (const batch of batches) {
    const at = performance.now();
    for (const entry of batch) buffer.push(entry);
    planTranscript(buffer);
    slowest = Math.max(slowest, performance.now() - at);
  }
  return { totalMs: performance.now() - started, slowestMs: slowest };
}

function chunk(entries: readonly TranscriptEntry[], size: number): TranscriptEntry[][] {
  const out: TranscriptEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const counts = flag('entries', '1000,10000,30000').split(',').map((n) => Number(n.trim()));
const batchSize = Number(flag('batch', '50'));
const rounds = Number(flag('rounds', '5'));
const rate = (count: number, ms: number): string => `${Math.round(count / (ms / 1000)).toLocaleString('en-US')}/s`;

process.stdout.write(`replaying an attempt in batches of ${batchSize}, best of ${rounds}

`);
const head = ['entries', 'delta only', 'plan() each batch', 're-run', 'speedup (delta / plan)', 'slowest update'];
const widths = [8, 13, 18, 13, 22, 26];
const row = (cells: readonly string[]): string => `${cells.map((c, i) => c.padStart(widths[i]!)).join('  ')}
`;
process.stdout.write(row(head));

for (const count of counts) {
  const batches = chunk(syntheticLog(count), batchSize);
  const delta = best(Array.from({ length: rounds }, () => replayDelta(batches)));
  const eachBatch = best(Array.from({ length: rounds }, () => replayIncremental(batches)));
  const rerun = best(Array.from({ length: rounds }, () => replayRerun(batches)));
  process.stdout.write(
    row([
      count.toLocaleString('en-US'),
      rate(count, delta.totalMs),
      rate(count, eachBatch.totalMs),
      rate(count, rerun.totalMs),
      `${(rerun.totalMs / delta.totalMs).toFixed(0)}x / ${(rerun.totalMs / eachBatch.totalMs).toFixed(1)}x`,
      `${delta.slowestMs.toFixed(1)} / ${eachBatch.slowestMs.toFixed(1)} / ${rerun.slowestMs.toFixed(1)} ms`,
    ]),
  );
}
