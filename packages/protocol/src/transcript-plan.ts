/**
 * Structure, not presentation: how a flat list of transcript entries becomes the tree every surface renders.
 *
 * Spec §4.1 — stateful tool-call pairing, subagent nesting by `parentToolUseId` and elapsed-time attribution
 * have no terminal dependency of their own, so they live here and both artifacts share one implementation.
 * `code-agent-orchestrator`'s `tui/transcript.ts` keeps the ANSI-and-glyph layer and imports this; the
 * desktop app renders the same `PlannedEntry` tree to the DOM. There is no second pairing algorithm to drift.
 */
import type { TranscriptEntry } from './transcript.js';

/** Milliseconds for an entry timestamp, or undefined when it is not a date. */
export function timestampMs(ts: string): number | undefined {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** The tool call an entry is (calls carry an id, results carry their call's id). */
export function entryToolUseId(entry: TranscriptEntry): string | undefined {
  return entry.kind === 'tool' || entry.kind === 'command' || entry.kind === 'tool_result' ? entry.toolUseId : undefined;
}

/** The `Agent:` call an entry came from, if any. */
export function entryParentToolUseId(entry: TranscriptEntry): string | undefined {
  return 'parentToolUseId' in entry ? entry.parentToolUseId : undefined;
}

export interface PlannedEntry {
  entry: TranscriptEntry;
  /** How long this call's tool took, once its result has arrived. */
  elapsedMs?: number;
  /** What a subagent produced under this call, planned the same way (a subagent can delegate again). */
  children?: PlannedEntry[];
  /** Everything under this call at any depth: what the collapsed summary counts, so nothing is uncounted. */
  nested?: number;
  /** The result of this call. A delegating call keeps its report with it instead of leaving it in the stream. */
  result?: TranscriptEntry;
  /** This call never got a result and the attempt is over: the tool it was in is where the worker stopped. */
  unanswered?: boolean;
}

/** Entries hidden by collapsing this level: the children, their own children, and their reports. */
function countNested(children: PlannedEntry[]): number {
  return children.reduce((n, c) => n + 1 + (c.nested ?? 0) + (c.result ? 1 : 0), 0);
}

/**
 * The shape a transcript is rendered in: top-level entries in arrival order, each subagent's entries collected
 * under the `Agent:` call that spawned them, and every tool call's elapsed time taken from its result.
 *
 * The nesting is recursive, because a subagent can delegate in turn, and a delegating call takes its own
 * result with it: with two subagents running at once their reports would otherwise both land at the end of
 * the transcript, with nothing saying which call each one answers.
 *
 * A subagent entry whose parent call is not in `entries` (the buffer scrolled past it) stays where it is rather
 * than disappearing, so nothing is ever lost by nesting.
 */
export function planTranscript(entries: TranscriptEntry[]): PlannedEntry[] {
  const calls = new Map<string, number>();
  for (const e of entries) {
    const id = entryToolUseId(e);
    if (id && e.kind !== 'tool_result' && !calls.has(id)) calls.set(id, timestampMs(e.ts) ?? Number.NaN);
  }
  const elapsedById = new Map<string, number>();
  const resultById = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.kind !== 'tool_result' || !e.toolUseId) continue;
    if (!resultById.has(e.toolUseId)) resultById.set(e.toolUseId, e);
    const started = calls.get(e.toolUseId);
    const ended = timestampMs(e.ts);
    if (started !== undefined && ended !== undefined && Number.isFinite(started) && !elapsedById.has(e.toolUseId)) elapsedById.set(e.toolUseId, Math.max(0, ended - started));
  }

  const children = new Map<string, TranscriptEntry[]>();
  for (const e of entries) {
    const parent = entryParentToolUseId(e);
    if (parent && calls.has(parent)) children.set(parent, [...(children.get(parent) ?? []), e]);
  }
  // An attempt's log ends with its outcome. Only then is a call without a result a fact rather than a call
  // that is still running, so only then is it worth saying so.
  const last = entries[entries.length - 1];
  const over = last?.kind === 'result' || last?.kind === 'error';

  /** One level: `under` is the call whose entries `list` are, so its own children stay put and deeper ones nest. */
  const build = (list: readonly TranscriptEntry[], under: string | undefined): PlannedEntry[] => {
    const plan: PlannedEntry[] = [];
    for (const e of list) {
      const parent = entryParentToolUseId(e);
      if (parent !== under && parent && children.has(parent)) continue; // rendered under its own Agent line
      // Both a call and its result carry the id; only the call owns the subagent's entries and the elapsed time.
      const id = e.kind === 'tool_result' ? undefined : entryToolUseId(e);
      if (e.kind === 'tool_result' && e.toolUseId && children.has(e.toolUseId)) continue; // shown as its call's report
      const kids = id ? children.get(id) : undefined;
      const planned = kids ? build(kids, id) : undefined;
      plan.push({
        entry: e,
        elapsedMs: id ? elapsedById.get(id) : undefined,
        children: planned,
        nested: planned ? countNested(planned) : undefined,
        result: kids && id ? resultById.get(id) : undefined,
        unanswered: over && id !== undefined && !resultById.has(id) ? true : undefined,
      });
    }
    return plan;
  };
  return build(entries, undefined);
}

/**
 * The same tree, kept up to date as the log arrives. Spec §6.3.1.
 *
 * `planTranscript` above is global on purpose: `over` is decided by the *last* entry and flips `unanswered`
 * on every unmatched call in the array, so the only correct answer is a full pass. Behind a 250 ms tailer
 * over an attempt of "tens of thousands of entries" (§6.3) that is four passes and an entirely new tree four
 * times a second — which also hands a DOM renderer thirty thousand fresh objects to diff, defeating the
 * change detection that makes virtual scrolling worth having. A terminal follow view never hit this because
 * it renders a window, not a tree.
 *
 * So this planner keeps the four maps between appends and rebuilds only the nodes an append actually moved:
 *
 * ```ts
 * const planner = createTranscriptPlan();
 * planner.append(entries);   // → { added, changed }
 * planner.plan();            // → PlannedEntry[]
 * planner.end();             // marks unanswered calls, as `over` does today
 * planner.reset();           // at an attempt boundary (§8.6)
 * ```
 *
 * It is a second implementation of `planTranscript`, deliberately: one function with a mode flag would make
 * the one-shot path carry the incremental one's bookkeeping. What ties them together is a property, and it
 * is the reason either can be trusted —
 *
 * > for every fixture and every split point, `incremental(a).append(b).plan()` equals
 * > `planTranscript([...a, ...b])`.
 *
 * `test/unit/incremental-planner.test.ts` runs it over `test/fixtures/transcripts/` at every split point,
 * and over a thousand generated logs whose entries arrive in orders no agent produces — results before their
 * calls, parents that never arrive, one `toolUseId` owned by several calls. The generated half is not
 * thoroughness for its own sake: it is where two implementations of one algorithm actually drift, and it is
 * what caught this one reading a stale subtree when a call's id was reused inside an attempt.
 * **Change `planTranscript` and you change this too**; that test is what will tell you.
 */
export interface TranscriptPlanOptions {
  /**
   * Plan `thinking` entries. **Default `true`** — the pure function plans every entry it is handed and so
   * does this, which is what makes the equivalence property hold as written.
   *
   * Set it `false` for a surface that hides thinking (`renderTranscript` does exactly that, filtering
   * *before* it plans). Suppression has to happen before planning rather than after: a dropped entry is one
   * the subagent lists, the nested counts and `over` never saw. It is fixed for the life of the planner,
   * because the toggle changes the whole tree — `reset()` and re-append is how a surface changes it.
   */
  showThinking?: boolean;
}

/** What an `append` or an `end` moved, so a caller can update rows instead of re-rendering the tree. */
export interface PlanDelta {
  /** Nodes that entered the plan, in arrival order. */
  added: PlannedEntry[];
  /** Nodes that were already in the plan and now hold a different value: a new object, the same `entry`. */
  changed: PlannedEntry[];
}

export interface TranscriptPlan {
  /**
   * Take the next entries. Everything a node is derived from — its elapsed time, its subagent's entries, the
   * report of the call it delegated — can arrive long after the entry itself, so an append reports both the
   * nodes it created and the ones it rewrote.
   */
  append(entries: readonly TranscriptEntry[]): PlanDelta;
  /**
   * The tree. **Reference-equal to the previous call when nothing moved**, and a new array when something
   * did, so a signal or an `OnPush` input can short-circuit on identity. Nodes are immutable: one that did
   * not change is the same object it was, and one that did is a new object carrying the same `entry`. A row
   * keyed on `entry` therefore survives, and only the rows that moved re-render.
   */
  plan(): PlannedEntry[];
  /**
   * The attempt is over. A call with no result is now a fact rather than a tool that may simply be slow, so
   * every unmatched call is marked `unanswered` — exactly what `over` does in `planTranscript` when the log
   * ends with a `result` or an `error`. Appending a `result` or an `error` already does this on its own;
   * `end()` is for the surface that learns the attempt died some other way (the process is gone, the run
   * directory says failed) and is never going to see one.
   */
  end(): PlanDelta;
  /**
   * Forget everything, for the next attempt (§8.6). `toolUseId`s come from the agent process and do not pair
   * across attempts: without this, a retry's `tool_result` would be timed against attempt 1's call.
   */
  reset(): void;
}

/** What an entry that owns no call plans to, and the value every node starts at. */
function barePlanned(entry: TranscriptEntry): PlannedEntry {
  return { entry, elapsedMs: undefined, children: undefined, nested: undefined, result: undefined, unanswered: undefined };
}

/** One entry's place in the tree. `planned` is its node; the rest is what keeps that node current. */
interface PlanSlot {
  readonly entry: TranscriptEntry;
  /** The call this entry *is*: undefined on a result (which carries its call's id, not its own) and on anything with no tool id. */
  readonly id: string | undefined;
  /** The `Agent:` call this entry came from, whether or not that call is in the transcript. */
  readonly parent: string | undefined;
  /** The children list it renders in; undefined while it is a top-level row. */
  under: string | undefined;
  planned: PlannedEntry;
}

/** Append to a keyed list, creating it on first use, and say how long that list is now. */
function pushInto<T>(map: Map<string, T[]>, key: string, value: T): number {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return 1;
  }
  list.push(value);
  return list.length;
}

export function createTranscriptPlan(options: TranscriptPlanOptions = {}): TranscriptPlan {
  const showThinking = options.showThinking ?? true;

  /** Every entry taken, in arrival order. The top level is this list minus whatever renders somewhere else. */
  let slots: PlanSlot[] = [];
  /** `planTranscript`'s four maps, kept between appends instead of rebuilt on every one. */
  let calls = new Map<string, number>();
  let elapsedById = new Map<string, number>();
  let resultById = new Map<string, TranscriptEntry>();
  let children = new Map<string, PlanSlot[]>();
  /** Results naming a call the transcript has not reached yet: the call, when it lands, is dated by them. */
  let earlyResults = new Map<string, TranscriptEntry[]>();
  /** Entries naming a parent that is not a call yet. They render at the top level until it arrives. */
  let waiting = new Map<string, PlanSlot[]>();
  /** Slots by the call they own, so one lookup finds every node a new result or child changes. */
  let owners = new Map<string, PlanSlot[]>();
  /** Result slots by the call they answer: a call that gains children takes its report down with it. */
  let answers = new Map<string, PlanSlot[]>();
  /** Owned calls with no result yet — the only nodes an `over` flip can touch. */
  let openIds = new Set<string>();
  let last: TranscriptEntry | undefined;
  let ended = false;
  let over = false;
  let tree: PlannedEntry[] | null = null;
  const added = new Set<PlanSlot>();
  const changed = new Set<PlanSlot>();

  /** A result whose call has children is shown as that call's report, not left in the stream. */
  const hidden = (slot: PlanSlot): boolean => {
    const answered = slot.entry.kind === 'tool_result' ? slot.entry.toolUseId : undefined;
    return Boolean(answered) && children.has(answered!);
  };

  /**
   * One node from the current maps: the field-for-field twin of the object `planTranscript`'s `build` pushes.
   *
   * The slot field is `planned` rather than the obvious `node` because `test/unit/protocol-package.test.ts`
   * rejects the substring `node:` anywhere in the browser bundle — a blunt guard against an unresolved
   * `node:` import, which an object property called `node` trips for no reason. Cheaper to not write it.
   */
  const plannedFor = (slot: PlanSlot): PlannedEntry => {
    const id = slot.id;
    const kids = id ? children.get(id) : undefined;
    const childPlans = kids ? kids.filter((kid) => !hidden(kid)).map((kid) => kid.planned) : undefined;
    return {
      entry: slot.entry,
      elapsedMs: id ? elapsedById.get(id) : undefined,
      children: childPlans,
      nested: childPlans ? countNested(childPlans) : undefined,
      result: kids && id ? resultById.get(id) : undefined,
      unanswered: over && id !== undefined && !resultById.has(id) ? true : undefined,
    };
  };

  const same = (a: PlannedEntry, b: PlannedEntry): boolean => {
    if (a.elapsedMs !== b.elapsedMs || a.nested !== b.nested || a.result !== b.result || a.unanswered !== b.unanswered) return false;
    const x = a.children;
    const y = b.children;
    if (x === y) return true;
    if (!x || !y || x.length !== y.length) return false;
    return x.every((child, i) => child === y[i]);
  };

  /**
   * Rebuild the nodes an update moved, and the nodes that hold them — a subagent's entry changes its
   * `Agent:` call's children array, which changes that call's nested count, up to the row a renderer sees.
   *
   * Collect first, then settle, and the two halves are separate for different reasons.
   *
   * The collection walk needs `seen` because a transcript in which a call is its own ancestor is one
   * `planTranscript` recurses on forever, and a live tailer is not the place to discover that.
   *
   * The settling needs to repeat because a node's value *contains* its children's values, so a node is only
   * right once everything beneath it is — and "beneath" is not a tree. One `toolUseId` can be owned by more
   * than one entry (an agent session resumed inside a single attempt reuses them, §8.6, and the recorded
   * corpus has exactly that), so one call's entries hang under every owner of its id, and the same slot is
   * reached by paths of different lengths. Rebuilding upward from each seed as you go therefore reaches some
   * holder before a longer path into it has settled, and leaves it holding a child that has since moved.
   * Sweeping until nothing moves needs no order at all, and since every sweep settles at least one more
   * level, there can never be more sweeps than there are affected slots — which is also what stops a cyclic
   * log here: it degrades to a stale count rather than a hang.
   */
  const refresh = (seeds: Iterable<PlanSlot>): void => {
    const affected: PlanSlot[] = [];
    const seen = new Set<PlanSlot>();
    const stack = [...seeds];
    while (stack.length) {
      const slot = stack.pop()!;
      if (seen.has(slot)) continue;
      seen.add(slot);
      affected.push(slot);
      if (slot.under !== undefined) for (const owner of owners.get(slot.under) ?? []) stack.push(owner);
    }
    for (let sweep = 0; sweep < affected.length; sweep++) {
      let moved = false;
      for (const slot of affected) {
        const next = plannedFor(slot);
        if (same(next, slot.planned)) continue;
        slot.planned = next;
        if (!added.has(slot)) changed.add(slot);
        tree = null;
        moved = true;
      }
      if (!moved) break;
    }
  };

  /** The first result carrying a date times its call, once — as the second pass of `planTranscript` does. */
  const timeCall = (id: string, results: readonly TranscriptEntry[]): boolean => {
    const started = calls.get(id);
    if (started === undefined || !Number.isFinite(started) || elapsedById.has(id)) return false;
    for (const result of results) {
      const finished = timestampMs(result.ts);
      if (finished !== undefined) {
        elapsedById.set(id, Math.max(0, finished - started));
        return true;
      }
    }
    return false;
  };

  const take = (entry: TranscriptEntry): void => {
    if (!showThinking && entry.kind === 'thinking') return;
    last = entry;
    tree = null;

    const owned = entryToolUseId(entry);
    const id = entry.kind === 'tool_result' ? undefined : owned;
    const parent = entryParentToolUseId(entry);
    const slot: PlanSlot = { entry, id, parent, under: undefined, planned: barePlanned(entry) };
    /** Calls whose nodes this entry changed. Collected, then applied once every map is current. */
    const touched = new Set<string>();
    /** Results that have just become a call's report, and so left the list they were rendering in. */
    let reparented: PlanSlot[] = [];

    // A call the transcript had not seen: it dates the results already waiting on it, and adopts the entries
    // that named it as a parent before it arrived. Neither happens in a log an agent wrote in order — both
    // are what makes the property hold for one that was not.
    if (owned && entry.kind !== 'tool_result' && !calls.has(owned)) {
      calls.set(owned, timestampMs(entry.ts) ?? Number.NaN);
      const early = earlyResults.get(owned);
      if (early) {
        earlyResults.delete(owned);
        if (timeCall(owned, early)) touched.add(owned);
      }
      const orphans = waiting.get(owned);
      if (orphans) {
        waiting.delete(owned);
        for (const orphan of orphans) {
          orphan.under = owned;
          pushInto(children, owned, orphan);
        }
        touched.add(owned);
        reparented = answers.get(owned) ?? [];
      }
    }

    // The result of a call: the first one is its report, and the first one carrying a date times it.
    if (entry.kind === 'tool_result' && entry.toolUseId) {
      const answered = entry.toolUseId;
      if (!resultById.has(answered)) {
        resultById.set(answered, entry);
        openIds.delete(answered);
        touched.add(answered);
      }
      if (calls.has(answered)) {
        if (timeCall(answered, [entry])) touched.add(answered);
      } else pushInto(earlyResults, answered, entry);
      pushInto(answers, answered, slot);
    }

    // Where it renders: under the `Agent:` call that spawned it once that call is known, top level until then
    // — and a subagent entry whose call is not in the transcript at all stays put rather than disappearing.
    if (parent && calls.has(parent)) {
      slot.under = parent;
      if (pushInto(children, parent, slot) === 1) reparented = [...reparented, ...(answers.get(parent) ?? [])];
      touched.add(parent);
    } else if (parent) pushInto(waiting, parent, slot);

    slots.push(slot);
    if (id !== undefined) {
      pushInto(owners, id, slot);
      if (!resultById.has(id)) openIds.add(id);
    }
    slot.planned = plannedFor(slot);
    added.add(slot);

    // One walk over everything this entry moved, rather than one per touched call: two seeds that share a
    // holder have to settle it together, or the first leaves it reading the second's stale subtree.
    const seeds = new Set<PlanSlot>();
    for (const key of touched) for (const owner of owners.get(key) ?? []) seeds.add(owner);
    for (const moved of reparented) if (moved.under !== undefined) for (const owner of owners.get(moved.under) ?? []) seeds.add(owner);
    if (seeds.size) refresh(seeds);
  };

  /** `over`, from the last entry exactly as `planTranscript` reads it — and pinned once `end()` has said so. */
  const settle = (): void => {
    const next = ended || last?.kind === 'result' || last?.kind === 'error';
    if (next === over) return;
    over = next;
    tree = null;
    const seeds = new Set<PlanSlot>();
    for (const id of openIds) for (const owner of owners.get(id) ?? []) seeds.add(owner);
    if (seeds.size) refresh(seeds);
  };

  const delta = (): PlanDelta => ({
    added: [...added].filter((slot) => !hidden(slot)).map((slot) => slot.planned),
    changed: [...changed].filter((slot) => !hidden(slot)).map((slot) => slot.planned),
  });

  return {
    append(entries) {
      added.clear();
      changed.clear();
      for (const entry of entries) take(entry);
      settle();
      return delta();
    },
    plan() {
      if (!tree) tree = slots.filter((slot) => slot.under === undefined && !hidden(slot)).map((slot) => slot.planned);
      return tree;
    },
    end() {
      added.clear();
      changed.clear();
      ended = true;
      settle();
      return delta();
    },
    reset() {
      slots = [];
      calls = new Map();
      elapsedById = new Map();
      resultById = new Map();
      children = new Map();
      earlyResults = new Map();
      waiting = new Map();
      owners = new Map();
      answers = new Map();
      openIds = new Set();
      last = undefined;
      ended = false;
      over = false;
      tree = null;
      added.clear();
      changed.clear();
    },
  };
}

/**
 * The kind filter the viewer cycles with `k`. A transcript is four different documents depending on the
 * question: what did it say, what did it run, what went wrong, or everything in order.
 */
export type TranscriptFilter = 'all' | 'text' | 'tools' | 'issues';

export const TRANSCRIPT_FILTERS: readonly TranscriptFilter[] = ['all', 'text', 'tools', 'issues'];

export const FILTER_LABEL: Record<TranscriptFilter, string> = {
  all: 'all',
  text: 'text',
  tools: 'tools + commands',
  issues: 'errors + questions',
};

/** The next filter in the cycle, so `k` never needs to know the order. */
export function nextFilter(filter: TranscriptFilter): TranscriptFilter {
  return TRANSCRIPT_FILTERS[(TRANSCRIPT_FILTERS.indexOf(filter) + 1) % TRANSCRIPT_FILTERS.length]!;
}

function matchesFilter(entry: TranscriptEntry, filter: TranscriptFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    // The operator's own messages belong to "what was said": filtered out, the agent's replies in this view
    // would answer questions that are nowhere on the screen.
    case 'text':
      return entry.kind === 'text' || entry.kind === 'thinking' || entry.kind === 'result' || entry.kind === 'user';
    case 'tools':
      return entry.kind === 'tool' || entry.kind === 'command' || entry.kind === 'tool_result';
    case 'issues':
      return entry.kind === 'error' || entry.kind === 'stderr' || entry.kind === 'question' || entry.kind === 'permission' || (entry.kind === 'tool_result' && Boolean(entry.isError));
  }
}

/** Entries a surface should render: the kind filter, and thinking only where it was asked for. */
export function filterEntries(entries: readonly TranscriptEntry[], filter: TranscriptFilter, showThinking = false): TranscriptEntry[] {
  return entries.filter((e) => (e.kind !== 'thinking' || showThinking) && matchesFilter(e, filter));
}
