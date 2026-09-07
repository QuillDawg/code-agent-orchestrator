/**
 * Renders transcript entries to styled lines. Shared by the dashboard follow view (Ink <Text> per line),
 * `cao logs`, `cao peek` and the line renderer, so every surface looks the same.
 *
 * Everything an agent controls passes through sanitizeText() here: this is the boundary between the raw
 * bytes kept in events.jsonl and a terminal that would otherwise obey any escape sequence it is handed.
 */
import { parseTranscriptLine, type TranscriptEntry } from '../types/transcript.js';
import { paint, sanitizeText, type Style } from '../cli/color.js';
import { renderMarkdown, wrapLine } from './markdown.js';
import { formatElapsed } from './format.js';
import { formatClock } from '../util/duration.js';
import { glyph } from '../util/glyphs.js';

export interface TranscriptRenderOptions {
  color: boolean;
  /** Wrap width in columns; 0 disables wrapping. */
  width: number;
  /** Show full tool output, and the entries of every subagent, instead of a collapsed summary. */
  showToolResults?: boolean;
  /** Include `thinking` entries. They are recorded everywhere and shown only where this is set. */
  showThinking?: boolean;
  /** Prefix each entry's first line with a timestamp: `HH:MM:SS`, or `MM:SS` on a narrow terminal. */
  timestamps?: boolean | 'short';
}

/** What only an entry's neighbours know: how long its tool took, and how deeply it is nested. */
export interface EntryContext {
  /** Milliseconds between this tool call and its result; shown on the call line. */
  elapsedMs?: number;
  /** Indent level; 1 for the entries of a subagent. */
  depth?: number;
  /** The attempt ended with this call still open — the tool it was in is where the worker stopped. */
  unanswered?: boolean;
}

const COLLAPSED_RESULT_LINES = 3;
const NEST_INDENT = '  ';

/**
 * Width of the timestamp column. The short form exists because the viewer used to drop timestamps entirely
 * below 100 columns: `MM:SS` costs three columns less and still says when something happened.
 */
export function stampWidth(timestamps: TranscriptRenderOptions['timestamps']): number {
  return timestamps === 'short' ? 6 : timestamps ? 9 : 0;
}

function stamp(ts: string, opts: TranscriptRenderOptions): string {
  const short = opts.timestamps === 'short';
  const width = stampWidth(opts.timestamps) - 1;
  const clock = Number.isNaN(new Date(ts).getTime()) ? '' : formatClock(ts, short);
  return paint(`${clock.padEnd(width)} `, 'dim', opts.color);
}

/** Sanitized lines of agent text (CRLF and lone CR both end a line). */
function textLines(text: string): string[] {
  return sanitizeText(text.replace(/\r\n?/g, '\n')).split('\n');
}

function block(lines: string[], gutter: string, styles: Style | Style[], color: boolean, width: number): string[] {
  const g = paint(gutter, styles, color);
  const pad = ' '.repeat(gutter.length);
  const out: string[] = [];
  lines.forEach((l, i) => {
    for (const w of wrapLine(l, width > 0 ? Math.max(20, width - gutter.length) : 0)) out.push(`${i === 0 && out.length === 0 ? g : pad}${w}`);
  });
  return out;
}

/**
 * The tail of a tool call line: ` · 0.4s` once the result has arrived, ` · no result` when the attempt ended
 * without one (which is exactly the tool a crashed or timed-out worker was sitting in), nothing while it runs.
 */
function elapsed(ctx: EntryContext, color: boolean): string {
  if (ctx.elapsedMs !== undefined) return paint(` ${glyph('bullet')} ${formatElapsed(ctx.elapsedMs)}`, 'dim', color);
  return ctx.unanswered ? paint(` ${glyph('bullet')} no result`, ['yellow', 'dim'], color) : '';
}

/** Lines for one entry (no timestamp), already wrapped to `width`. */
function entryLines(entry: TranscriptEntry, opts: TranscriptRenderOptions, ctx: EntryContext, width: number): string[] {
  const { color } = opts;
  switch (entry.kind) {
    case 'text':
      return block(renderMarkdown(entry.text, { color, width: width > 0 ? width - 2 : 0 }), `${glyph('say')} `, 'green', color, width);
    case 'thinking':
      return block(
        textLines(entry.text).map((l) => paint(l, ['magenta', 'dim'], color)),
        `${glyph('thinking')} `,
        ['magenta', 'dim'],
        color,
        width,
      );
    case 'command': {
      const lines = textLines(entry.command);
      return block(lines.map((l, i) => `${paint(l, 'yellow', color)}${i === 0 ? elapsed(ctx, color) : ''}`), '$ ', ['yellow', 'bold'], color, width);
    }
    case 'tool': {
      const icon = entry.fileOp ? `${glyph('fileOp')} ` : `${glyph('tool')} `;
      return block([`${paint(sanitizeText(entry.line), 'cyan', color)}${elapsed(ctx, color)}`], icon, 'cyan', color, width);
    }
    case 'tool_result': {
      const all = textLines(entry.text);
      const shown = opts.showToolResults ? all : all.slice(0, COLLAPSED_RESULT_LINES);
      const hidden = all.length - shown.length;
      const style: Style[] = entry.isError ? ['red', 'dim'] : ['gray'];
      // A result normally carries no time (its call line does), except when a surface renders line by line and
      // the call has already scrolled past — then this is the only place the number can go.
      const lines = shown.map((l, i) => `${paint(l, style, color)}${i === 0 ? elapsed(ctx, color) : ''}`);
      if (hidden > 0) lines.push(paint(`${glyph('ellipsis')} ${hidden} more line${hidden === 1 ? '' : 's'} (t to expand)`, 'dim', color));
      return block(lines, '    ', 'dim', color, width);
    }
    case 'stderr':
      return block([paint(sanitizeText(entry.text), ['red', 'dim'], color)], `  ${glyph('warning')} `, ['red', 'dim'], color, width);
    case 'question': {
      const lines: string[] = [];
      for (const q of entry.questions) {
        lines.push(paint(sanitizeText(q.question), ['yellow', 'bold'], color));
        q.options.forEach((o, i) =>
          lines.push(`  ${paint(`${i + 1})`, 'yellow', color)} ${sanitizeText(o.label)}${o.description ? paint(` ${glyph('dash')} ${sanitizeText(o.description)}`, 'dim', color) : ''}`),
        );
      }
      lines.push(entry.answer !== undefined ? paint(`${glyph('arrow')} ${sanitizeText(entry.answer)}`, 'green', color) : paint(`${glyph('arrow')} waiting for your answer`, 'yellow', color));
      return block(lines, '? ', ['yellow', 'bold'], color, width);
    }
    case 'permission': {
      const lines = [paint(`Permission: ${sanitizeText(entry.title)}`, ['yellow', 'bold'], color)];
      if (entry.decision === 'allow') lines.push(paint(`${glyph('arrow')} allowed`, 'green', color));
      else if (entry.decision === 'deny') lines.push(paint(`${glyph('arrow')} denied${entry.message ? `: ${sanitizeText(entry.message)}` : ''}`, 'red', color));
      else lines.push(paint(`${glyph('arrow')} waiting for your decision`, 'yellow', color));
      return block(lines, '? ', ['yellow', 'bold'], color, width);
    }
    case 'result': {
      const ok = !entry.isError && entry.status !== 'failed' && entry.status !== 'blocked';
      const head = `${sanitizeText(entry.status ?? (entry.isError ? 'error' : 'done'))}${entry.summary ? ` ${glyph('dash')} ${textLines(entry.summary)[0]}` : ''}`;
      const lines = [paint(head, ok ? ['green', 'bold'] : ['red', 'bold'], color)];
      if (entry.error) lines.push(paint(textLines(entry.error)[0] ?? '', 'red', color));
      if (entry.costUsd !== undefined) lines.push(paint(`cost $${entry.costUsd.toFixed(4)}`, 'dim', color));
      return block(lines, ok ? `${glyph('ok')} ` : `${glyph('error')} `, ok ? 'green' : 'red', color, width);
    }
    case 'error':
      return block([paint(sanitizeText(entry.text), 'red', color)], `${glyph('error')} `, ['red', 'bold'], color, width);
    case 'system':
      return block([paint(sanitizeText(entry.text), 'dim', color)], `${glyph('bullet')} `, 'dim', color, width);
  }
}

/**
 * Rendered lines, per entry, per way of rendering it. Entries are immutable records, so the lines an entry
 * produces only depend on the options — and a live transcript re-renders the same thousands of entries on
 * every new one. The cache turns that into work proportional to what actually changed.
 *
 * The arrays it hands out are shared: callers read them, never mutate them.
 */
const renderCache = new WeakMap<TranscriptEntry, Map<string, string[]>>();

/** Lines for one entry (no timestamp), indented by its nesting depth. */
export function renderEntry(entry: TranscriptEntry, opts: TranscriptRenderOptions, ctx: EntryContext = {}): string[] {
  const depth = ctx.depth ?? 0;
  const key = `${opts.color ? 1 : 0}|${opts.width}|${opts.timestamps ?? ''}|${opts.showToolResults ? 1 : 0}|${depth}|${ctx.elapsedMs ?? ''}|${ctx.unanswered ? 1 : 0}`;
  const cached = renderCache.get(entry);
  const hit = cached?.get(key);
  if (hit) return hit;
  const indent = NEST_INDENT.repeat(depth);
  const full = opts.timestamps && opts.width > 0 ? Math.max(20, opts.width - stampWidth(opts.timestamps)) : opts.width;
  const lines = entryLines(entry, opts, ctx, full > 0 ? Math.max(20, full - indent.length) : full);
  const out = indent ? lines.map((l) => `${indent}${l}`) : lines;
  if (cached) cached.set(key, out);
  else renderCache.set(entry, new Map([[key, out]]));
  return out;
}

const millis = (ts: string): number | undefined => {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : undefined;
};

/** The tool call an entry is (calls carry an id, results carry their call's id). */
function toolUseId(entry: TranscriptEntry): string | undefined {
  return entry.kind === 'tool' || entry.kind === 'command' || entry.kind === 'tool_result' ? entry.toolUseId : undefined;
}

/** The `Agent:` call an entry came from, if any. */
function parentToolUseId(entry: TranscriptEntry): string | undefined {
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
    const id = toolUseId(e);
    if (id && e.kind !== 'tool_result' && !calls.has(id)) calls.set(id, millis(e.ts) ?? Number.NaN);
  }
  const elapsedById = new Map<string, number>();
  const resultById = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.kind !== 'tool_result' || !e.toolUseId) continue;
    if (!resultById.has(e.toolUseId)) resultById.set(e.toolUseId, e);
    const started = calls.get(e.toolUseId);
    const ended = millis(e.ts);
    if (started !== undefined && ended !== undefined && Number.isFinite(started) && !elapsedById.has(e.toolUseId)) elapsedById.set(e.toolUseId, Math.max(0, ended - started));
  }

  const children = new Map<string, TranscriptEntry[]>();
  for (const e of entries) {
    const parent = parentToolUseId(e);
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
      const parent = parentToolUseId(e);
      if (parent !== under && parent && children.has(parent)) continue; // rendered under its own Agent line
      // Both a call and its result carry the id; only the call owns the subagent's entries and the elapsed time.
      const id = e.kind === 'tool_result' ? undefined : toolUseId(e);
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

/**
 * Prefix rendered lines with the timestamp column. `ts: null` keeps that column blank, for a line that
 * continues the entry above (the collapsed-subagent summary).
 */
function stamped(ts: string | null, lines: string[], opts: TranscriptRenderOptions): string[] {
  if (!opts.timestamps) return lines;
  const gutter = ' '.repeat(stampWidth(opts.timestamps));
  return lines.map((l, i) => `${i === 0 && ts !== null ? stamp(ts, opts) : gutter}${l}`);
}

/** Lines for many entries, with an optional timestamp column. */
export function renderTranscript(entries: TranscriptEntry[], opts: TranscriptRenderOptions): string[] {
  const out: string[] = [];
  const push = (ts: string | null, lines: string[]): void => void out.push(...stamped(ts, lines, opts));
  const render = (plan: PlannedEntry[], depth: number): void => {
    for (const item of plan) {
      push(item.entry.ts, renderEntry(item.entry, opts, { elapsedMs: item.elapsedMs, depth, unanswered: item.unanswered }));
      if (item.children?.length) {
        if (opts.showToolResults) render(item.children, depth + 1);
        else {
          const n = item.nested ?? item.children.length;
          push(null, [`${NEST_INDENT.repeat(depth + 1)}${paint(`${glyph('ellipsis')} ${n} subagent ${n === 1 ? 'entry' : 'entries'} (t to expand)`, 'dim', opts.color)}`]);
        }
      }
      // The report of a delegating call, always shown: it is the answer the parent agent actually acted on.
      if (item.result) push(item.result.ts, renderEntry(item.result, opts, { depth: depth + 1 }));
    }
  };
  // Thinking is dropped here rather than in every caller, so a surface that never heard of it never shows it.
  render(planTranscript(opts.showThinking ? entries : entries.filter((e) => e.kind !== 'thinking')), 0);
  return out;
}

/** How many calls a streaming renderer keeps waiting for a result before it forgets the oldest. */
const MAX_OPEN_CALLS = 500;

/**
 * Renders an attempt's `events.jsonl` as it is read, for the surfaces that print lines rather than redraw a
 * screen (`cao logs`, `cao peek`).
 *
 * `batch` is the whole tail at once, and is what `renderTranscript` does. `line` is a single line that has just
 * been appended, and can only use what earlier lines established: the call a result answers (so it can still
 * say how long the tool took) and the `Agent:` call an entry belongs to (so it can still be indented under it).
 * A call whose result never arrives — the process crashed mid-tool — is simply forgotten, oldest first.
 */
export function createTranscriptStream(opts: TranscriptRenderOptions): { batch(lines: string[]): string[]; line(text: string): string[] } {
  /** Open calls: id → when it started and how deep it renders. */
  const open = new Map<string, { at: number | undefined; depth: number }>();
  /** Calls that have produced a subagent entry: their result is that subagent's report, and nests like one. */
  const delegated = new Set<string>();

  const note = (entry: TranscriptEntry, depth: number): void => {
    const id = toolUseId(entry);
    if (!id || entry.kind === 'tool_result') return;
    if (open.size >= MAX_OPEN_CALLS) open.delete(open.keys().next().value!);
    open.set(id, { at: millis(entry.ts), depth });
  };

  const depthOf = (entry: TranscriptEntry): number => {
    const parent = parentToolUseId(entry);
    if (parent) {
      delegated.add(parent);
      const call = open.get(parent);
      if (call) return call.depth + 1;
    }
    // The report of a call a subagent worked under, nested like the entries it is answering for.
    const own = entry.kind === 'tool_result' ? entry.toolUseId : undefined;
    const owner = own && delegated.has(own) ? open.get(own) : undefined;
    return owner ? owner.depth + 1 : 0;
  };

  return {
    batch(lines) {
      const entries: TranscriptEntry[] = [];
      const out: string[] = [];
      const flush = (): void => {
        if (!entries.length) return;
        const render = (plan: PlannedEntry[], depth: number): void => {
          for (const item of plan) {
            if (item.elapsedMs === undefined) note(item.entry, depth);
            if (!item.children) continue;
            const id = toolUseId(item.entry);
            if (id && !item.result) delegated.add(id);
            render(item.children, depth + 1);
          }
        };
        render(planTranscript(entries), 0);
        out.push(...renderTranscript(entries, opts));
        entries.length = 0;
      };
      for (const line of lines) {
        const entry = line.trim() ? parseTranscriptLine(line) : null;
        if (entry) entries.push(entry);
        else {
          // Not an entry (a half-written line, or a runner that logged something else): pass it through in place.
          flush();
          out.push(sanitizeText(line));
        }
      }
      flush();
      return out;
    },
    line(text) {
      const entry = text.trim() ? parseTranscriptLine(text) : null;
      if (!entry) return [sanitizeText(text)];
      if (entry.kind === 'thinking' && !opts.showThinking) return [];
      const depth = depthOf(entry);
      let elapsedMs: number | undefined;
      if (entry.kind === 'tool_result' && entry.toolUseId) {
        const call = open.get(entry.toolUseId);
        const ended = millis(entry.ts);
        if (call?.at !== undefined && ended !== undefined) elapsedMs = Math.max(0, ended - call.at);
        if (call) open.delete(entry.toolUseId);
        delegated.delete(entry.toolUseId);
      }
      note(entry, depth);
      return stamped(entry.ts, renderEntry(entry, opts, { elapsedMs, depth }), opts);
    },
  };
}
