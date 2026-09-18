/**
 * Renders transcript entries to styled lines. Shared by the dashboard follow view (Ink <Text> per line),
 * `cao logs`, `cao peek` and the line renderer, so every surface looks the same.
 *
 * Everything an agent controls passes through sanitizeText() here: this is the boundary between the raw
 * bytes kept in events.jsonl and a terminal that would otherwise obey any escape sequence it is handed.
 *
 * The ANSI-and-glyph layer only. What a transcript *is* — pairing a call with its result, nesting a
 * subagent under the call that spawned it, attributing elapsed time — is `planTranscript` in
 * `code-agent-orchestrator-protocol`, which the desktop app renders to the DOM from the same tree
 * (spec §4.1). Nothing about that structure is decided twice.
 */
import {
  entryParentToolUseId as parentToolUseId,
  entryToolUseId as toolUseId,
  parseTranscriptLine,
  planTranscript,
  timestampMs as millis,
  type PlannedEntry,
  type TranscriptEntry,
} from 'code-agent-orchestrator-protocol';
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
    // The operator's own message. Deliberately not `say`/green: a transcript is unreadable if the human's
    // turn and the agent's turn are drawn the same way, and the only mark a mono terminal has is the gutter.
    case 'user':
      return block(
        textLines(entry.text).map((l) => paint(l, ['blue', 'bold'], color)),
        '> ',
        ['blue', 'bold'],
        color,
        width,
      );
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
      // A worker that stopped for a human neither succeeded nor failed. Drawn as a tick it reads as a task
      // that is done, which is the opposite of what the log is there to say: the run is paused on it.
      const waiting = !entry.isError && entry.status === 'needs_input';
      const ok = !entry.isError && !waiting && entry.status !== 'failed' && entry.status !== 'blocked';
      // A completion object the worker emitted and then kept working past is a checkpoint, not the outcome:
      // it says so, and it is drawn dim rather than as a second green tick at the end of the attempt.
      const label = entry.intermediate ? 'intermediate result: ' : '';
      const head = `${label}${sanitizeText(entry.status ?? (entry.isError ? 'error' : 'done'))}${entry.summary ? ` ${glyph('dash')} ${textLines(entry.summary)[0]}` : ''}`;
      const style: Style[] = entry.intermediate ? ['dim'] : waiting ? ['yellow', 'bold'] : ok ? ['green', 'bold'] : ['red', 'bold'];
      const lines = [paint(head, style, color)];
      if (entry.error) lines.push(paint(textLines(entry.error)[0] ?? '', entry.intermediate ? 'dim' : waiting ? 'yellow' : 'red', color));
      if (entry.costUsd !== undefined) lines.push(paint(`cost $${entry.costUsd.toFixed(4)}`, 'dim', color));
      // '?' is the marker every other surface uses for a task that needs you, in both alphabets.
      const gutter = entry.intermediate ? `${glyph('bullet')} ` : waiting ? '? ' : ok ? `${glyph('ok')} ` : `${glyph('error')} `;
      return block(lines, gutter, entry.intermediate ? 'dim' : waiting ? 'yellow' : ok ? 'green' : 'red', color, width);
    }
    case 'error':
      return block([paint(sanitizeText(entry.text), 'red', color)], `${glyph('error')} `, ['red', 'bold'], color, width);
    case 'system':
      return block([paint(sanitizeText(entry.text), 'dim', color)], `${glyph('bullet')} `, 'dim', color, width);
    // §4.5 — an event type this build does not know is still a line: its name, then the record as it was
    // written. The terminal has no expander, so the detail is simply there, dim, below the name.
    case 'unknown':
      return block(
        [paint(sanitizeText(entry.type), 'dim', color), ...textLines(entry.raw).map((l) => paint(l, 'dim', color))],
        `${glyph('bullet')} `,
        'dim',
        color,
        width,
      );
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
