/**
 * `createTranscriptPlan()` — the incremental planner (spec §6.3.1, §8.6) and the property that makes it
 * safe to trust (§12.2):
 *
 * > for every fixture and every split point, `incremental(a).append(b).plan()` equals
 * > `planTranscript([...a, ...b])`.
 *
 * Two implementations of one algorithm are only worth having while something proves they agree, so the
 * split point is property-tested rather than sampled: every single split, every prefix one entry at a time,
 * and seeded random partitions on top. `planTranscript` is the oracle — if this suite goes red, the
 * incremental planner is wrong, and weakening the property is not the fix.
 *
 * The corpus in `test/fixtures/transcripts/` is recorded from the fakes by `scripts/record-transcripts.ts`
 * and is the same corpus the app's own tests read (§12.2): one corpus, two consumers, so the two renderers
 * cannot disagree about structure.
 *
 * `provesEquivalentToPlanTranscript` is the battery, and three kinds of log run through all of it: the
 * recorded corpus, the hand-written logs further down whose entries arrive out of order, and a thousand
 * generated ones. The last two are what a recording never produces and `planTranscript` handles anyway,
 * because its maps are global — so they are where the incremental planner has to *move* what it already
 * placed, and the only place the per-prefix form of the property has anything to say that the final-state
 * form does not. The generated half earned its keep: it is what found the planner reading a stale subtree
 * when one `toolUseId` was owned by two calls at different depths, which no fixture reaches.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createTranscriptPlan, entryParentToolUseId, entryToolUseId, parseTranscriptLine, planTranscript, type PlannedEntry, type TranscriptEntry } from 'code-agent-orchestrator-protocol';

const corpusDir = path.join(process.cwd(), 'test', 'fixtures', 'transcripts');

/** One recorded `events.jsonl`, read the way every surface reads it: line by line, dropping what is not an entry. */
function readCorpus(name: string): { text: string; entries: TranscriptEntry[] } {
  const text = readFileSync(path.join(corpusDir, name), 'utf8');
  return { text, entries: text.split('\n').map(parseTranscriptLine).filter((e): e is TranscriptEntry => e !== null) };
}

const corpus = readdirSync(corpusDir)
  .filter((name) => name.endsWith('.jsonl'))
  .sort()
  .map((name) => ({ name, ...readCorpus(name) }));

/** Deterministic PRNG: a random partition that cannot pass on Monday and fail on Tuesday. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `entries` cut into 1..4 pieces at random, in order. */
function partition(entries: readonly TranscriptEntry[], random: () => number): TranscriptEntry[][] {
  const cuts = [...new Set([0, entries.length, ...Array.from({ length: 3 }, () => Math.floor(random() * (entries.length + 1)))])].sort((a, b) => a - b);
  return cuts.slice(1).map((end, i) => entries.slice(cuts[i]!, end));
}

/** The plan a planner fed `batches` in order arrives at. */
function incremental(batches: readonly (readonly TranscriptEntry[])[], showThinking = true): PlannedEntry[] {
  const planner = createTranscriptPlan({ showThinking });
  for (const batch of batches) planner.append(batch);
  return planner.plan();
}

const at = (ms: number): string => new Date(Date.parse('2026-09-03T10:11:12.000Z') + ms).toISOString();

/**
 * The property, in every form it has, for one log.
 *
 * §12.2 states it over "every fixture and every split point". The prefix form is strictly stronger and is
 * what a 250 ms tailer actually does, so every log here gets both — the recorded corpus and the hand-written
 * out-of-order logs alike. A log checked only at its final state hides the planner that is wrong in the
 * middle and right by the end, which is precisely the planner a live view would show.
 */
function provesEquivalentToPlanTranscript(entries: TranscriptEntry[]): void {
  it('plans the same tree at every split point', () => {
    const expected = planTranscript(entries);
    for (let cut = 0; cut <= entries.length; cut++) {
      expect(incremental([entries.slice(0, cut), entries.slice(cut)])).toStrictEqual(expected);
    }
  });

  it('plans the same tree at every prefix, fed one entry at a time', () => {
    // What a 250 ms tailer actually does, and the strongest form of the property: the planner agrees with
    // the pure function after every single line, not only once the attempt is over.
    const planner = createTranscriptPlan();
    for (let count = 1; count <= entries.length; count++) {
      planner.append([entries[count - 1]!]);
      expect(planner.plan()).toStrictEqual(planTranscript(entries.slice(0, count)));
    }
  });

  it('plans the same tree however the batches fall', () => {
    const expected = planTranscript(entries);
    const random = seeded(20260910);
    for (let round = 0; round < 25; round++) {
      expect(incremental(partition(entries, random))).toStrictEqual(expected);
    }
  });

  it('suppresses thinking before it plans, exactly as renderTranscript does', () => {
    // Filtering after planning is a different tree: a dropped entry is one the subagent lists, the nested
    // counts and `over` never saw. So the option drops it on the way in, and the oracle is the filtered log.
    const shown = entries.filter((e) => e.kind !== 'thinking');
    const expected = planTranscript(shown);
    for (let cut = 0; cut <= entries.length; cut++) {
      expect(incremental([entries.slice(0, cut), entries.slice(cut)], false)).toStrictEqual(expected);
    }
  });

  it('marks every unmatched call once end() says the attempt is over', () => {
    // `end()` is `over` reached the other way: appending a result or an error already sets it, and this is
    // for the surface that learns the attempt died without one. So an appended `error` is the oracle —
    // it flips `over` and adds exactly one top-level row, which is the one sliced off again.
    const sentinel: TranscriptEntry = { kind: 'error', ts: at(9_000_000), text: 'the attempt is over' };
    const expected = planTranscript([...entries, sentinel]).slice(0, -1);
    const planner = createTranscriptPlan();
    planner.append(entries);
    planner.end();

    expect(planner.plan()).toStrictEqual(expected);
    // And it stays over: a late line does not un-end an attempt that has ended.
    planner.append([{ kind: 'text', ts: at(9_100_000), text: 'trailing' }]);
    expect(planner.plan().slice(0, -1)).toStrictEqual(expected);
  });
}

describe.each(corpus)('$name, against planTranscript', ({ entries }) => {
  provesEquivalentToPlanTranscript(entries);
});

describe('the recorded corpus still holds the shapes the property needs', () => {
  const named = (name: string): TranscriptEntry[] => corpus.find((f) => f.name === name)!.entries;
  const flatten = (plan: readonly PlannedEntry[]): PlannedEntry[] => plan.flatMap((item) => [item, ...flatten(item.children ?? [])]);

  it('nests a subagent under the Agent call that spawned it', () => {
    const agent = planTranscript(named('subagent.jsonl')).find((item) => item.children?.length);
    expect(agent?.entry).toMatchObject({ kind: 'tool', tool: 'Agent' });
    expect(agent?.result).toBeDefined(); // the Agent's report goes with its call, not into the stream
    expect(agent?.nested).toBeGreaterThan(0);
  });

  it('nests a subagent that delegated again, and leaves a call nobody answered', () => {
    const plan = planTranscript(named('subagents.jsonl'));
    expect(flatten(plan).filter((item) => item.children?.length)).toHaveLength(3); // alpha, beta, and alpha's own delegate
    expect(flatten(plan).some((item) => item.children?.some((kid) => kid.children?.length))).toBe(true);
    expect(plan.filter((item) => item.unanswered)).toHaveLength(1);
  });

  it('records thinking entries, which every surface hides until asked', () => {
    expect(named('thinking.jsonl').filter((e) => e.kind === 'thinking').length).toBeGreaterThan(1);
  });

  it('resumes a session inside one attempt, reusing the tool ids of the first half', () => {
    const entries = named('resumed-session.jsonl');
    const resumed = entries.findIndex((e) => e.kind === 'system' && e.text.startsWith('resumed session'));
    expect(resumed).toBeGreaterThan(0);
    const idsBefore = entries.slice(0, resumed).flatMap((e) => ('toolUseId' in e && e.toolUseId ? [e.toolUseId] : []));
    const idsAfter = entries.slice(resumed).flatMap((e) => ('toolUseId' in e && e.toolUseId ? [e.toolUseId] : []));
    expect(idsAfter.filter((id) => idsBefore.includes(id)).length).toBeGreaterThan(0);
  });

  it('ends with a call whose result never arrived, and with a line cut in half', () => {
    expect(planTranscript(named('open-tool-exit.jsonl')).filter((item) => item.unanswered)).toHaveLength(1);
    const truncated = corpus.find((f) => f.name === 'truncated.jsonl')!;
    const lines = truncated.text.split('\n');
    expect(parseTranscriptLine(lines[lines.length - 1]!)).toBeNull();
    expect(truncated.entries.length).toBe(lines.length - 1);
  });
});

describe('a log that did not arrive in order', () => {
  // Nothing an agent writes looks like this, and `planTranscript` handles it anyway because its maps are
  // global: a result pairs with a call further down the array, and a subagent entry nests under an `Agent:`
  // line that has not been read yet. The incremental planner has to reach the same answer by moving what it
  // already placed, which is the only part of it a well-behaved recording never exercises.
  const backwards: TranscriptEntry[] = [
    { kind: 'text', ts: at(0), text: 'the subagent speaks before its call is known', parentToolUseId: 'a1' },
    { kind: 'tool_result', ts: at(500), text: 'the result of a call not yet read', toolUseId: 'c1' },
    { kind: 'tool', ts: at(1000), tool: 'Agent', line: 'Agent: review', toolUseId: 'a1' },
    { kind: 'command', ts: at(1200), command: 'npm test', tool: 'Bash', toolUseId: 'c1' },
    { kind: 'tool_result', ts: at(1500), text: 'the Agent report', toolUseId: 'a1' },
    { kind: 'result', ts: at(2000), status: 'success', isError: false },
  ];

  it('is a log planTranscript reads by pairing across the whole array', () => {
    const expected = planTranscript(backwards);
    // The oracle first: the entry that named a parent read later is nested rather than stranded (so it is
    // not a top-level row), the `Agent:` report is that call's rather than a row of its own, and the call
    // read after its own result is still timed by it — backwards, so the clamp at zero is what shows.
    expect(expected.map((item) => item.entry.kind)).toEqual(['tool_result', 'tool', 'command', 'result']);
    expect(expected[1]?.children?.map((kid) => kid.entry)).toEqual([backwards[0]]);
    expect(expected[1]?.result).toBe(backwards[4]);
    expect(expected[2]?.elapsedMs).toBe(0);
  });

  provesEquivalentToPlanTranscript(backwards);

  // A subagent's report read before the entries it is the report *of*: once those arrive the report stops
  // being a row of its own and becomes the call's, inside a list one level further up.
  const reportFirst: TranscriptEntry[] = [
    { kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: outer', toolUseId: 'outer' },
    { kind: 'tool_result', ts: at(100), text: 'inner report', toolUseId: 'inner', parentToolUseId: 'outer' },
    { kind: 'tool', ts: at(200), tool: 'Agent', line: 'Agent: inner', toolUseId: 'inner', parentToolUseId: 'outer' },
    { kind: 'text', ts: at(300), text: 'inner speaking', parentToolUseId: 'inner' },
    { kind: 'tool_result', ts: at(400), text: 'outer report', toolUseId: 'outer' },
    { kind: 'result', ts: at(500), status: 'success', isError: false },
  ];

  it('takes a report out of the list it was rendering in when its own call gains entries', () => {
    const expected = planTranscript(reportFirst);
    expect(expected[0]?.children?.map((kid) => kid.entry)).toEqual([reportFirst[2]]); // not the report as well
    expect(expected[0]?.children?.[0]?.result).toBe(reportFirst[1]);
    expect(expected[0]?.nested).toBe(3);
  });

  provesEquivalentToPlanTranscript(reportFirst);

  // The same move, but the report is filed under a *different* call than the one it answers, so the list it
  // has to leave is not on the path from the call that changed. Nothing writes this; `planTranscript` reads
  // it anyway, because its maps are global and know nothing about who is whose ancestor.
  const filedElsewhere: TranscriptEntry[] = [
    { kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: first', toolUseId: 'p1' },
    { kind: 'tool_result', ts: at(100), text: 'the report of a call read later', toolUseId: 'x', parentToolUseId: 'p1' },
    { kind: 'text', ts: at(200), text: 'inside x', parentToolUseId: 'x' },
    { kind: 'tool', ts: at(300), tool: 'Agent', line: 'Agent: x', toolUseId: 'x' },
    { kind: 'tool_result', ts: at(400), text: 'the first report', toolUseId: 'p1' },
    { kind: 'result', ts: at(500), status: 'success', isError: false },
  ];

  it('empties the list a report leaves even when nothing else on that branch moved', () => {
    const expected = planTranscript(filedElsewhere);
    expect(expected.map((item) => item.entry)).toEqual([filedElsewhere[0], filedElsewhere[3], filedElsewhere[5]]);
    expect(expected[0]).toMatchObject({ children: [], nested: 0, result: filedElsewhere[4] });
    expect(expected[1]?.result).toBe(filedElsewhere[1]);
  });

  provesEquivalentToPlanTranscript(filedElsewhere);

  // One call reported more than once, every report read before the call itself. `planTranscript` decides
  // both questions by array order in a single pass — the first report is the call's, and the first report
  // carrying a date is what times it. The incremental planner is holding a queue rather than making a pass,
  // so it has to reach the same two answers from the other side, and an undated report first is what tells
  // the two apart: taking the *last* dated report instead would time this call at 800 ms.
  const reportedTwice: TranscriptEntry[] = [
    { kind: 'tool_result', ts: '', text: 'the first report, with no date on it', toolUseId: 'c1' },
    { kind: 'tool_result', ts: at(400), text: 'reported again, dated', toolUseId: 'c1' },
    { kind: 'tool_result', ts: at(900), text: 'and again, later', toolUseId: 'c1' },
    { kind: 'command', ts: at(100), command: 'npm test', tool: 'Bash', toolUseId: 'c1' },
    { kind: 'result', ts: at(1000), status: 'success', isError: false },
  ];

  it('times a call from the first dated report of it, not the last', () => {
    const expected = planTranscript(reportedTwice);
    expect(expected[3]?.elapsedMs).toBe(400 - 100);
    expect(expected[3]?.unanswered).toBeUndefined(); // reported, however many times
  });

  provesEquivalentToPlanTranscript(reportedTwice);
});

describe('one tool id, and more than one call that owns it', () => {
  // A resumed session inside a single attempt reuses the ids of the first half (§8.6, and
  // `resumed-session.jsonl` records it), so `owners` holds several slots for one id and a call's entries
  // hang under every one of them. That makes the thing a node has to be rebuilt *after* — everything
  // beneath it — a graph rather than a tree, reached by paths of different lengths: here `w` is two levels
  // under `y` through `z shallow` and four levels under it through `x`. Rebuilding upward from the entry
  // that moved, one holder at a time, settles the short path first and then finds `y` already done when the
  // long one arrives, leaving `y` holding a copy of `x` from before its subtree was timed.
  const reusedId: TranscriptEntry[] = [
    { kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: y', toolUseId: 'y' },
    { kind: 'tool', ts: at(100), tool: 'Agent', line: 'Agent: x', toolUseId: 'x', parentToolUseId: 'y' },
    { kind: 'tool', ts: at(200), tool: 'Agent', line: 'Agent: z, the deep one', toolUseId: 'z', parentToolUseId: 'x' },
    { kind: 'tool', ts: at(300), tool: 'Agent', line: 'Agent: z, the shallow one', toolUseId: 'z', parentToolUseId: 'y' },
    { kind: 'command', ts: at(400), command: 'npm test', tool: 'Bash', toolUseId: 'w', parentToolUseId: 'z' },
    { kind: 'tool_result', ts: at(900), text: 'passed', isError: false, toolUseId: 'w' },
  ];

  it('times the call on every path that reaches it, not only the shortest', () => {
    const plan = planTranscript(reusedId);
    const deep = plan[0]?.children?.[0]?.children?.[0]?.children?.[0];
    const shallow = plan[0]?.children?.[1]?.children?.[0];
    expect(deep?.entry).toBe(reusedId[4]);
    expect(shallow?.entry).toBe(reusedId[4]);
    expect(deep?.elapsedMs).toBe(500);
    expect(shallow?.elapsedMs).toBe(500);
  });

  provesEquivalentToPlanTranscript(reusedId);
});

describe('a log whose entries carry no usable date', () => {
  // Legacy records written before the typed transcript existed reach `parseTranscriptLine` with no `ts` at
  // all, so every call is dated `NaN` and nothing is ever timed. Pairing still has to happen: which call a
  // report answers, and which call nobody answered, do not depend on the clock.
  const undated: TranscriptEntry[] = [
    { kind: 'tool', ts: '', tool: 'Agent', line: 'Agent: review', toolUseId: 'a1' },
    { kind: 'text', ts: '', text: 'reviewing', parentToolUseId: 'a1' },
    { kind: 'tool_result', ts: '', text: 'the report', toolUseId: 'a1' },
    { kind: 'command', ts: '', command: 'npm test', tool: 'Bash', toolUseId: 'c1' },
    { kind: 'result', ts: '', status: 'success', isError: false },
  ];

  it('still pairs a call with its report when nothing can be timed', () => {
    const expected = planTranscript(undated);
    expect(expected.map((item) => item.entry.kind)).toEqual(['tool', 'command', 'result']);
    expect(expected[0]?.result).toBe(undated[2]);
    expect(expected.map((item) => item.elapsedMs)).toEqual([undefined, undefined, undefined]);
    expect(expected[1]?.unanswered).toBe(true);
  });

  provesEquivalentToPlanTranscript(undated);
});

describe('logs nobody wrote down', () => {
  // The fixtures and the hand-written logs above are the shapes somebody thought of. This is the rest: logs
  // generated against a deliberately tiny id space, so ids collide, results arrive before their calls,
  // parents never arrive, timestamps run backwards and some are missing entirely. It is the check that found
  // the reused-id bug the block above now pins, which no recording reaches and nobody had thought to write.
  //
  // Seeded, so a failure is reproducible: the seed is in the test name.
  const idSpace = ['x', 'y', 'z', 'w'];

  function randomLog(rnd: () => number): TranscriptEntry[] {
    const n = 2 + Math.floor(rnd() * 26);
    const pick = (): string => idSpace[Math.floor(rnd() * idSpace.length)]!;
    const base = Date.parse('2026-09-03T10:00:00.000Z');
    const out: TranscriptEntry[] = [];
    for (let i = 0; i < n; i++) {
      const ts = rnd() < 0.15 ? '' : new Date(base + Math.floor(rnd() * 4000)).toISOString();
      const p = rnd() < 0.45 ? { parentToolUseId: pick() } : {};
      const roll = rnd();
      if (roll < 0.3) out.push({ kind: 'tool_result', ts, text: `r${i}`, isError: rnd() < 0.2, toolUseId: pick(), ...p });
      else if (roll < 0.5) out.push({ kind: 'tool', ts, tool: rnd() < 0.5 ? 'Agent' : 'Read', line: `l${i}`, toolUseId: pick(), ...p });
      else if (roll < 0.62) out.push({ kind: 'command', ts, command: `c${i}`, tool: 'Bash', toolUseId: pick(), ...p });
      else if (roll < 0.74) out.push({ kind: 'thinking', ts, text: `t${i}`, ...p });
      else if (roll < 0.88) out.push({ kind: 'text', ts, text: `s${i}`, ...p });
      else if (roll < 0.94) out.push({ kind: 'error', ts, text: `e${i}` });
      else out.push({ kind: 'result', ts, status: 'success', isError: false });
    }
    return out;
  }

  /**
   * A log `planTranscript` cannot be the oracle for, because it does not return on one: a call filed under
   * an id that leads back to itself, which its `build` recurses into forever. Nothing an agent writes looks
   * like this and fixing it is not this task's to do, so the generator skips them — and the test below says
   * what the incremental planner does with one instead.
   */
  function cyclic(log: readonly TranscriptEntry[]): boolean {
    const edges = new Map<string, Set<string>>();
    for (const e of log) {
      const id = e.kind === 'tool_result' ? undefined : entryToolUseId(e);
      const parent = entryParentToolUseId(e);
      if (!id || !parent) continue;
      if (!edges.has(parent)) edges.set(parent, new Set());
      edges.get(parent)!.add(id);
    }
    const walk = (id: string, seen: Set<string>): boolean => {
      if (seen.has(id)) return true;
      seen.add(id);
      for (const next of edges.get(id) ?? []) if (walk(next, seen)) return true;
      seen.delete(id);
      return false;
    };
    return [...edges.keys()].some((id) => walk(id, new Set()));
  }

  const logs = (() => {
    const out: { seed: number; entries: TranscriptEntry[] }[] = [];
    for (let seed = 1; out.length < 1000; seed++) {
      const entries = randomLog(seeded(seed));
      if (!cyclic(entries)) out.push({ seed, entries });
    }
    return out;
  })();

  it('agrees with planTranscript at every split point of every generated log', () => {
    for (const { seed, entries } of logs) {
      const expected = planTranscript(entries);
      for (let cut = 0; cut <= entries.length; cut++) {
        expect(incremental([entries.slice(0, cut), entries.slice(cut)]), `seed ${seed}, cut ${cut}`).toStrictEqual(expected);
      }
    }
  });

  it('agrees with planTranscript after every single entry of every generated log', () => {
    for (const { seed, entries } of logs) {
      const planner = createTranscriptPlan();
      for (let count = 1; count <= entries.length; count++) {
        planner.append([entries[count - 1]!]);
        expect(planner.plan(), `seed ${seed}, after ${count}`).toStrictEqual(planTranscript(entries.slice(0, count)));
      }
    }
  });

  it('returns on a call that is its own ancestor, where the pure function does not', () => {
    // `planTranscript` overflows the stack on this log. That is pre-existing, unreachable from anything an
    // agent writes, and not this task's to fix — but the incremental planner is what a desktop surface will
    // point at files it did not write, so it has to come back with something rather than take the app down.
    const log: TranscriptEntry[] = [
      { kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: outer', toolUseId: 'w' },
      { kind: 'tool', ts: at(100), tool: 'Agent', line: 'Agent: itself', toolUseId: 'w', parentToolUseId: 'w' },
    ];
    const planner = createTranscriptPlan();
    expect(() => planner.append(log)).not.toThrow();
    const plan = planner.plan();
    expect(plan).toHaveLength(1);
    expect(plan[0]?.entry).toBe(log[0]);
    const depth = (item: PlannedEntry): number => 1 + Math.max(0, ...(item.children ?? []).map(depth));
    expect(depth(plan[0]!)).toBeLessThan(10); // finite, which is the whole claim
  });
});

describe('what an append moved', () => {
  const log: TranscriptEntry[] = [
    { kind: 'command', ts: at(0), command: 'npm test', tool: 'Bash', toolUseId: 'c1' },
    { kind: 'tool', ts: at(100), tool: 'Agent', line: 'Agent: review', toolUseId: 'a1' },
    { kind: 'tool_result', ts: at(1500), text: 'passed', toolUseId: 'c1' },
    { kind: 'text', ts: at(1600), text: 'reviewing', parentToolUseId: 'a1' },
    { kind: 'tool_result', ts: at(2000), text: 'looks fine', toolUseId: 'a1' },
  ];

  it('leaves the nodes of entries nothing touched alone', () => {
    const planner = createTranscriptPlan();
    planner.append(log.slice(0, 2));
    const [command, agent] = planner.plan();

    planner.append(log.slice(2, 3)); // the Bash result: only the command line it answers moves
    expect(planner.plan()[1]).toBe(agent);
    expect(planner.plan()[0]).not.toBe(command);
    expect(planner.plan()[0]?.entry).toBe(command!.entry); // same entry, new value — what a keyed row needs
    expect(planner.plan()[0]?.elapsedMs).toBe(1500);
  });

  it('names the nodes that moved, and only those', () => {
    const planner = createTranscriptPlan();
    planner.append(log.slice(0, 2));
    const delta = planner.append(log.slice(2, 3));

    expect(delta.added.map((item) => item.entry.kind)).toEqual(['tool_result']);
    expect(delta.changed).toEqual([planner.plan()[0]]);
    // A subagent entry is added under its Agent call, and the call it changed is reported with it.
    const nested = planner.append(log.slice(3, 4));
    expect(nested.added.map((item) => item.entry)).toEqual([log[3]]);
    expect(planner.plan().map((item) => item.entry)).toEqual([log[0], log[1], log[2]]);
    expect(nested.changed).toEqual([planner.plan()[1]]);
    // The Agent's own report leaves the stream: it is the call's `result`, so it is not a row of its own.
    const report = planner.append(log.slice(4));
    expect(report.added).toEqual([]);
    expect(report.changed.map((item) => item.entry)).toEqual([log[1]]);
    expect(planner.plan().map((item) => item.entry)).toEqual([log[0], log[1], log[2]]);
    expect(planner.plan()[1]?.result).toBe(log[4]);
  });

  it('keeps the node of a row whose value did not move, even when its facts did', () => {
    // A legacy record with no usable date (`ts: ''`): the result pairs with its call — the call stops being
    // an open one — but the call renders no elapsed time, no children and no report, so nothing about the
    // row moved. Rebuilding it anyway would hand a renderer a fresh object for a row that looks identical,
    // which is the cost §6.3.1 exists to avoid; the equivalence property cannot see it, because both
    // planners agree on the *value*. So it is pinned here instead.
    const planner = createTranscriptPlan();
    planner.append([{ kind: 'command', ts: '', command: 'npm test', tool: 'Bash', toolUseId: 'c1' }]);
    const [call] = planner.plan();

    const delta = planner.append([{ kind: 'tool_result', ts: '', text: 'passed', toolUseId: 'c1' }]);
    expect(delta.changed).toEqual([]);
    expect(planner.plan()[0]).toBe(call);
    // And the fact did land: end() now has nothing to mark, where an unpaired call would have been marked.
    planner.end();
    expect(planner.plan()[0]).toBe(call);
    expect(planner.plan()[0]?.unanswered).toBeUndefined();
  });

  it('hands back the same array until something moves', () => {
    const planner = createTranscriptPlan();
    planner.append(log);
    const first = planner.plan();

    expect(planner.plan()).toBe(first);
    expect(planner.append([])).toEqual({ added: [], changed: [] });
    expect(planner.plan()).toBe(first);

    planner.append([{ kind: 'text', ts: at(3000), text: 'done' }]);
    expect(planner.plan()).not.toBe(first);
    expect(first.map((item) => item.entry)).toEqual([log[0], log[1], log[2]]); // the array handed out is a snapshot
  });
});

describe('an attempt boundary (§8.6)', () => {
  const entries = corpus.find((f) => f.name === 'resumed-session.jsonl')!.entries;
  const boundary = entries.findIndex((e) => e.kind === 'system' && e.text.startsWith('resumed session'));
  const first = entries.slice(0, boundary);
  const second = entries.slice(boundary);

  it('does not pair a tool id across a reset', () => {
    const planner = createTranscriptPlan();
    planner.append(first);
    planner.reset();
    planner.append(second);

    expect(planner.plan()).toStrictEqual(planTranscript(second));
    // The hazard the reset exists for, in the numbers: the two halves reuse `t2` for their `Agent:` call, so
    // read as one log each of the two calls collects all six subagent entries — three of them from a session
    // it never spawned. Reset, and each call shows its own three.
    const subagents = (plan: readonly PlannedEntry[]): number[] => plan.filter((item) => item.children?.length).map((item) => item.children!.length);
    expect(subagents(planTranscript(entries))).toEqual([6, 6]);
    expect(subagents(planner.plan())).toEqual([3]);
  });

  it('is a planner nobody has to throw away', () => {
    const planner = createTranscriptPlan();
    planner.append(entries);
    planner.end();
    planner.reset();

    expect(planner.plan()).toEqual([]);
    // `end()` does not survive the reset either: attempt 2 is running, and its open calls are not unanswered.
    planner.append(first.slice(0, 3));
    expect(planner.plan()).toStrictEqual(planTranscript(first.slice(0, 3)));
    expect(planner.plan().some((item) => item.unanswered)).toBe(false);
  });
});
