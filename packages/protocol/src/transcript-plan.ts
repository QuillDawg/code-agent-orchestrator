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
    case 'text':
      return entry.kind === 'text' || entry.kind === 'thinking' || entry.kind === 'result';
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
