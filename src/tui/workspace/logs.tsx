/**
 * The Logs tab (spec §3.7): everything this run wrote to disk, read a page at a time.
 *
 * Six kinds of file are in here — the orchestrator's own log, the run's `events.jsonl`, and each attempt's
 * `events.jsonl`, `stdout.log`, `stderr.log` and `prompt.md` — and exactly one of them is on screen at a
 * time. That is not a simplification: a `stdout.log` is unbounded, so the panel can only ever be a window
 * onto one file, and a window onto six at once would be a window onto none of them.
 *
 * Three rules hold it together:
 *
 * - **Nothing is read whole.** Every page comes from `log-pager.ts`, which reads backwards from the end,
 *   and what is kept is capped at `execution.outputBufferLines` — so a 50 MB log costs two small reads
 *   however long it has been running.
 * - **The position is counted from the newest line, not from the oldest.** An older page is prepended
 *   while the operator is reading, and an index from the top would jump under them every time one lands.
 * - **Every line goes through `sanitizeText`.** All of this is agent-written text.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { parseTranscriptLine, type RunPaths, type WorkflowRun } from 'code-agent-orchestrator-protocol';
import { sanitizeText } from '../../cli/color.js';
import { truncateVisible } from '../../cli/util.js';
import { glyph } from '../../util/glyphs.js';
import { renderEntry } from '../transcript.js';
import type { Theme, ThemeToken } from '../theme.js';

// ---------------------------------------------------------------------------------------------- sources

/** Which file a log line came out of. One kind per file name in the run directory (§4.1). */
export type LogSourceKind = 'orchestrator' | 'run-events' | 'attempt-events' | 'stdout' | 'stderr' | 'prompt';

export interface LogSource {
  id: string;
  kind: LogSourceKind;
  /** What the filter line calls it. */
  label: string;
  file: string;
  taskId?: string;
  attempt?: number;
}

/** The four views of §3.7, and the file kinds each one is a view of. */
export const LOG_VIEWS = ['events', 'stderr', 'raw', 'prompts'] as const;
export type LogView = (typeof LOG_VIEWS)[number];

export const LOG_VIEW_LABEL: Record<LogView, string> = {
  events: 'events',
  stderr: 'stderr',
  raw: 'raw output',
  prompts: 'prompts',
};

const VIEW_KINDS: Record<LogView, readonly LogSourceKind[]> = {
  events: ['orchestrator', 'run-events', 'attempt-events'],
  stderr: ['stderr'],
  raw: ['stdout'],
  prompts: ['prompt'],
};

/**
 * Every file of this run the panel can show, in the order the filter line steps through them: the run's own
 * two first, then each task in workflow order, newest attempt first.
 *
 * Built from the run and the layout accessor alone, so a source exists in the list whether or not the file
 * behind it does; an attempt that wrote no stderr is an empty page, which is the truth, rather than a
 * missing entry that reads as though the attempt never ran.
 */
export function logSources(run: WorkflowRun, paths: RunPaths): LogSource[] {
  const out: LogSource[] = [
    { id: 'orchestrator', kind: 'orchestrator', label: 'orchestrator.log', file: paths.runLogFile(run.runId) },
    { id: 'run-events', kind: 'run-events', label: 'run events.jsonl', file: paths.eventsFile(run.runId) },
  ];
  for (const task of run.workflow.tasks) {
    const attempts = [...(run.tasks[task.id]?.attempts ?? [])].sort((a, b) => b.number - a.number);
    for (const attempt of attempts) {
      const dir = paths.attemptDir(run.runId, task.id, attempt.number);
      const at = `${task.id}#${attempt.number}`;
      out.push({ id: `${at}:events`, kind: 'attempt-events', label: `${at} events`, file: join(dir, 'events.jsonl'), taskId: task.id, attempt: attempt.number });
      out.push({ id: `${at}:stdout`, kind: 'stdout', label: `${at} stdout.log`, file: join(dir, 'stdout.log'), taskId: task.id, attempt: attempt.number });
      out.push({ id: `${at}:stderr`, kind: 'stderr', label: `${at} stderr.log`, file: join(dir, 'stderr.log'), taskId: task.id, attempt: attempt.number });
      out.push({ id: `${at}:prompt`, kind: 'prompt', label: `${at} prompt.md`, file: join(dir, 'prompt.md'), taskId: task.id, attempt: attempt.number });
    }
  }
  return out;
}

/**
 * A file name under a directory `RunPaths` has already spelled for this platform.
 *
 * Not `path.join`: the separator was decided by the layout accessor, and choosing one again here would be a
 * second place that decision is made.
 */
function join(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${name}`;
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

// ---------------------------------------------------------------------------------------------- filters

export const LOG_SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

const SEVERITY_RANK: Record<LogSeverity, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The time ranges the `m` key steps through; `null` is "everything this file holds". */
export const LOG_RANGES: Array<{ label: string; ms: number | null }> = [
  { label: 'all', ms: null },
  { label: 'last 5m', ms: 5 * 60_000 },
  { label: 'last 1h', ms: 60 * 60_000 },
  { label: 'last 24h', ms: 24 * 60 * 60_000 },
];

export interface LogFilters {
  /** Only the sources of this task; undefined is every task and the run's own files. */
  taskId?: string;
  /** Only this attempt of it. */
  attempt?: number;
  /** The least severe level kept. */
  severity?: LogSeverity;
  /** Index into `LOG_RANGES`. */
  range?: number;
}

/** The sources this view and these filters allow, in `logSources` order. */
export function visibleSources(sources: readonly LogSource[], view: LogView, filters: LogFilters): LogSource[] {
  const kinds = VIEW_KINDS[view];
  return sources.filter((source) => {
    if (!kinds.includes(source.kind)) return false;
    if (filters.taskId !== undefined && source.taskId !== filters.taskId) return false;
    if (filters.attempt !== undefined && source.attempt !== filters.attempt) return false;
    return true;
  });
}

/** Every task that has a file in this list, for the `t` key to step through. */
export function sourceTaskIds(sources: readonly LogSource[]): string[] {
  const out: string[] = [];
  for (const source of sources) if (source.taskId && !out.includes(source.taskId)) out.push(source.taskId);
  return out;
}

// ---------------------------------------------------------------------------------------------- records

/** One line of one file, parsed far enough to filter it and rendered far enough to draw it. */
export interface LogRecord {
  /** Epoch milliseconds, when the line says when it happened. */
  at?: number;
  severity: LogSeverity;
  /** The display lines, sanitized. One raw line may render to several. */
  lines: string[];
}

/** `HH:MM:SS level  message`, which is what `ConsoleLogger` writes into `orchestrator.log`. */
const ORCHESTRATOR_LINE = /^(\d{2}):(\d{2}):(\d{2}) (debug|info|warn|error)\s{0,2}([\s\S]*)$/;

/**
 * The wall-clock a `HH:MM:SS` stamp meant.
 *
 * `orchestrator.log` records the time of day and nothing else, so the date has to come from somewhere: the
 * most recent moment with that time of day at or before `now`. A run started yesterday evening therefore
 * dates correctly right up to the point where the log is more than a day old, and beyond that the time
 * filter simply stops hiding things — which is the safe direction for a filter to be wrong in.
 */
export function timeOfDayAt(hours: number, minutes: number, seconds: number, now: number): number {
  const date = new Date(now);
  date.setHours(hours, minutes, seconds, 0);
  const at = date.getTime();
  return at > now ? at - 24 * 60 * 60_000 : at;
}

export interface LogRenderOptions {
  width: number;
  color: boolean;
  /** The frame's clock, which is what dates an `HH:MM:SS` stamp. */
  now: number;
}

/** The blank gutter a line with no timestamp of its own gets, so the columns still line up. */
const NO_CLOCK = ' '.repeat(9);

/**
 * One raw line as the panel shows it. `null` for a blank line, which is spacing in the file and noise here.
 *
 * Each kind knows its own severity: the orchestrator writes one, a run event carries its type, a transcript
 * entry carries its kind, and a line on stderr is a line on stderr — the file it came out of is the level.
 */
export function parseLogLine(raw: string, source: LogSource, opts: LogRenderOptions): LogRecord | null {
  if (!raw.trim()) return null;
  const width = Math.max(20, opts.width);
  if (source.kind === 'orchestrator') {
    const match = ORCHESTRATOR_LINE.exec(raw);
    if (!match) return { severity: 'info', lines: [text(raw)] };
    const at = timeOfDayAt(Number(match[1]), Number(match[2]), Number(match[3]), opts.now);
    return { at, severity: match[4] as LogSeverity, lines: [text(raw)] };
  }
  if (source.kind === 'run-events') {
    const event = parseJson(raw);
    if (!event) return { severity: 'info', lines: [text(raw)] };
    const type = String(event.type ?? 'event');
    const at = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    return {
      ...(Number.isFinite(at) ? { at } : {}),
      severity: eventSeverity(type),
      lines: [text(`${clockOf(at)}${type}${event.taskId ? ` ${String(event.taskId)}` : ''}${eventDetail(event)}`)],
    };
  }
  if (source.kind === 'attempt-events') {
    const entry = parseTranscriptLine(raw);
    if (!entry) return { severity: 'info', lines: [text(raw)] };
    const at = Date.parse(entry.ts);
    const severity: LogSeverity = entry.kind === 'error' || entry.kind === 'stderr' ? 'error' : entry.kind === 'thinking' ? 'debug' : 'info';
    const rendered = renderEntry(entry, { color: opts.color, width: Math.max(20, width - NO_CLOCK.length), showToolResults: true, showThinking: true });
    return {
      ...(Number.isFinite(at) ? { at } : {}),
      severity,
      lines: rendered.map((line, i) => text(`${i === 0 ? clockOf(at) : NO_CLOCK}${line}`)),
    };
  }
  // stdout.log, stderr.log and prompt.md are what the worker wrote, verbatim. A `stderr` line is an error
  // by the file it is in; the other two carry no level of their own and take the file's.
  return { severity: source.kind === 'stderr' ? 'error' : source.kind === 'stdout' ? 'debug' : 'info', lines: [text(raw)] };
}

const text = (value: string): string => sanitizeText(value);

const clockOf = (at: number): string => (Number.isFinite(at) ? `${new Date(at).toTimeString().slice(0, 8)} ` : NO_CLOCK);

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function eventSeverity(type: string): LogSeverity {
  if (type.endsWith('.failed') || type.endsWith('.blocked') || type.endsWith('.cancelled') || type.endsWith('.interrupted')) return 'error';
  if (type.endsWith('.warning') || type === 'task.retrying') return 'warn';
  if (type === 'task.activity' || type === 'task.process' || type === 'task.output') return 'debug';
  return 'info';
}

/** The one thing worth saying about a run event on a single line; the whole record is in the JSON. */
function eventDetail(event: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['attempt', 'reason', 'message', 'summary', 'state', 'mode', 'nextAttempt', 'revision', 'code'] as const) {
    const value = event[key];
    if (value !== undefined && value !== null && typeof value !== 'object') parts.push(`${key}=${String(value)}`);
  }
  return parts.length ? `  ${parts.join(' ')}` : '';
}

/** The records a filter lets through. A record with no timestamp is never hidden by a filter about time. */
export function filterRecords(records: readonly LogRecord[], filters: LogFilters, now: number): LogRecord[] {
  const floor = filters.severity ? SEVERITY_RANK[filters.severity] : 0;
  const window = LOG_RANGES[filters.range ?? 0]?.ms ?? null;
  return records.filter((record) => {
    if (SEVERITY_RANK[record.severity] < floor) return false;
    if (window !== null && record.at !== undefined && record.at < now - window) return false;
    return true;
  });
}

/** The display lines of a page, after filtering. */
export function logLines(records: readonly LogRecord[], filters: LogFilters, now: number): string[] {
  return filterRecords(records, filters, now).flatMap((record) => record.lines);
}

/** The indexes of the lines matching `query`, oldest first. Case-insensitive, like the viewer's `/`. */
export function searchMatches(lines: readonly string[], query: string): number[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) if (lines[i]!.toLowerCase().includes(needle)) out.push(i);
  return out;
}

// -------------------------------------------------------------------------------------------- the panel

export interface LogsPanelProps {
  /** The sources this view and these filters allow; `source` is the one on screen. */
  sources: readonly LogSource[];
  source?: LogSource;
  view: LogView;
  filters: LogFilters;
  /** The page's display lines, oldest first. */
  lines: readonly string[];
  /** How many lines up from the newest the bottom of the window sits. 0 is "following the end". */
  offset: number;
  /** Whether the oldest line held is the oldest line in the file. */
  atStart: boolean;
  /** No page has come back yet. */
  loading: boolean;
  search?: string;
  /** Which match `n`/`N` is on, as an index into `lines`; undefined when nothing is being stepped through. */
  match?: number;
  rows: number;
  columns: number;
  theme: Theme;
  focused: boolean;
}

/** The filter line, so the panel and its test read the same string. */
export function filterLine(view: LogView, source: LogSource | undefined, filters: LogFilters): string {
  return [
    `view ${LOG_VIEW_LABEL[view]}`,
    `source ${source?.label ?? 'none'}`,
    `task ${filters.taskId ?? 'all'}`,
    `severity ${filters.severity ?? 'all'}`,
    `time ${LOG_RANGES[filters.range ?? 0]?.label ?? 'all'}`,
  ].join(`  ${glyph('bullet')} `);
}

export function LogsPanel({ sources, source, view, filters, lines, offset, atStart, loading, search, match, rows, columns, theme, focused }: LogsPanelProps): React.JSX.Element {
  const headerRows = 2 + (search !== undefined ? 1 : 0);
  const height = Math.max(1, rows - headerRows - 1);
  const end = Math.max(0, lines.length - offset);
  const from = Math.max(0, end - height);
  const shown = lines.slice(from, end);
  const matches = search ? searchMatches(lines, search) : [];
  const position = sources.findIndex((s) => s.id === source?.id) + 1;
  const status = [
    lines.length ? `${from + 1}-${end} of ${atStart ? `${lines.length}` : `${lines.length} held${glyph('ellipsis')}`}` : 'nothing here',
    offset === 0 ? 'newest line' : `${offset} back`,
    sources.length > 1 ? `file ${position}/${sources.length}` : '',
  ]
    .filter(Boolean)
    .join(`  ${glyph('bullet')} `);

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold wrap="truncate-end">
        Logs
      </Text>
      <Text wrap="truncate-end">{theme.paint(truncateVisible(filterLine(view, source, filters), columns), focused ? 'title' : 'muted')}</Text>
      {search !== undefined && (
        <Text wrap="truncate-end">{theme.paint(truncateVisible(`/${search}   ${matches.length} match${matches.length === 1 ? '' : 'es'}`, columns), 'accent')}</Text>
      )}
      {loading && shown.length === 0 ? (
        <Text wrap="truncate-end">{theme.paint(`Reading ${source?.label ?? 'the log'}${glyph('ellipsis')}`, 'muted')}</Text>
      ) : shown.length === 0 ? (
        <Text wrap="truncate-end">{theme.paint(truncateVisible(emptyNote(source, filters), columns), 'muted')}</Text>
      ) : (
        shown.map((line, i) => {
          const index = from + i;
          const token: ThemeToken | undefined = index === match ? 'selection' : matches.includes(index) ? 'accent' : undefined;
          const body = truncateVisible(line, columns);
          return (
            <Text key={index} wrap="truncate-end">
              {token ? theme.paint(body, token) : body}
            </Text>
          );
        })
      )}
      <Text wrap="truncate-end">{theme.paint(truncateVisible(status, columns), 'muted')}</Text>
    </Box>
  );
}

/**
 * Why a page is empty, which is never the same sentence twice — and what to press about it.
 *
 * A note that says only "nothing here" makes an empty panel look like a broken one. Each of these names
 * the key that would widen the filter, or the flag that would have written the file, because every one of
 * these states is reached by an operator who was expecting to read something.
 */
export function emptyNote(source: LogSource | undefined, filters: LogFilters): string {
  if (!source) return 'No file of this run matches these filters. Press t or v to widen them.';
  if (filters.severity || (filters.range ?? 0) > 0) {
    // Only three of the six kinds carry a level of their own; a `stdout.log` is all `debug` and a
    // `prompt.md` is all `info`, so a floor above those empties the whole file rather than part of it.
    return `${source.label} has nothing at this severity or in this time range. Press k or m to widen them.`;
  }
  if (source.kind === 'orchestrator') {
    // The one empty file that is empty by default: the orchestrator logs only warnings and errors unless
    // it was asked for more, so an ordinary run leaves nothing here at all (§3.7).
    return `${source.label} is empty. Run with --debug to record what the orchestrator did.`;
  }
  return `${source.label} is empty.`;
}

// -------------------------------------------------------------------------------------------- the pager

/** How many of the page's lines are kept; `execution.outputBufferLines` bounds what is held (§3.7). */
const held = (run: WorkflowRun): number => Math.max(50, run.workflow.execution.outputBufferLines);

/** How many lines one "page above" brings in; the pager's own page size. */
const PAGE = 200;

/** A source that cannot exist, so `parseLogLine` always has one to work from. */
const ORPHAN: LogSource = { id: '', kind: 'orchestrator', label: '', file: '' };

/** What one file looks like to the panel while it is being read. */
interface Page {
  sourceId: string;
  /** The raw lines held, oldest first. */
  raw: string[];
  /** Byte offset of the first line held; where the next older page ends. */
  start: number;
  atStart: boolean;
  /** Whether the newest line held is still the newest line of the file. */
  atEnd: boolean;
  loading: boolean;
}

/** One page of a file, in the only three fields the panel needs of it. */
export interface RawPage {
  lines: string[];
  start: number;
  atStart: boolean;
}

export interface LogsController {
  view: LogView;
  filters: LogFilters;
  /** The files this view and these filters allow. */
  sources: LogSource[];
  source?: LogSource;
  lines: string[];
  offset: number;
  atStart: boolean;
  loading: boolean;
  /** The line `n`/`N` last landed on, as an index into `lines`. */
  match?: number;
  scroll(delta: number): void;
  toNewest(): void;
  toOldest(): void;
  cycleView(delta: number): void;
  cycleSource(delta: number): void;
  cycleTask(delta: number): void;
  cycleSeverity(delta: number): void;
  cycleRange(delta: number): void;
  /** `n` / `N`: the next or previous line matching the search. */
  stepMatch(direction: 1 | -1): void;
  /** Read the newest page again. */
  reload(): void;
}

export interface UseLogsOptions {
  run: WorkflowRun;
  paths: RunPaths;
  /** The panel's width, and how many of its rows are body. */
  width: number;
  height: number;
  color: boolean;
  /** The `/` query; the empty string is "not searching". */
  search: string;
  /** Whether the panel is on screen. Nothing is read while it is not. */
  active: boolean;
  /** Injected by tests; the real ones read the run directory through `log-pager.ts`. */
  readTail?: (file: string, lines: number) => Promise<RawPage>;
  readBefore?: (file: string, offset: number, lines: number) => Promise<RawPage>;
}

/**
 * The Logs panel's whole state machine: which file, which view, which filters, and where in it we are.
 *
 * Held here rather than in the zustand store because none of it is something another panel has to agree
 * about, and a page of a 50 MB log mirrored through a store `set` would re-render the entire shell every
 * time one landed.
 */
export function useLogs(opts: UseLogsOptions): LogsController {
  const { run, paths, active } = opts;
  const readTail = opts.readTail ?? defaultReadTail;
  const readBefore = opts.readBefore ?? defaultReadBefore;

  // The list only changes when a task gains an attempt, so it is keyed on exactly that.
  const signature = run.workflow.tasks.map((task) => `${task.id}:${run.tasks[task.id]?.attempts.length ?? 0}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = React.useMemo(() => logSources(run, paths), [signature, run.runId, paths]);

  const [view, setView] = React.useState<LogView>('events');
  const [filters, setFilters] = React.useState<LogFilters>({});
  const [sourceId, setSourceId] = React.useState<string | undefined>(undefined);
  const [offset, setOffset] = React.useState(0);
  const [match, setMatch] = React.useState<number | undefined>(undefined);
  const [generation, setGeneration] = React.useState(0);
  const [page, setPage] = React.useState<Page | null>(null);
  /**
   * When the time filter was last set. Filtering against `Date.now()` on every frame would re-derive the
   * whole page eight times a second and move the boundary under the operator while they read it.
   */
  const [rangeAnchor, setRangeAnchor] = React.useState(() => Date.now());

  const sources = React.useMemo(() => visibleSources(all, view, filters), [all, view, filters]);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0];
  const currentId = source?.id;
  const file = source?.file;
  const limit = held(run);

  React.useEffect(() => {
    if (!active || !file || !currentId) return undefined;
    let cancelled = false;
    setPage({ sourceId: currentId, raw: [], start: 0, atStart: false, atEnd: true, loading: true });
    void readTail(file, limit)
      .then((tail) => {
        if (!cancelled) setPage({ sourceId: currentId, raw: tail.lines, start: tail.start, atStart: tail.atStart, atEnd: true, loading: false });
      })
      .catch(() => {
        if (!cancelled) setPage({ sourceId: currentId, raw: [], start: 0, atStart: true, atEnd: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, file, currentId, limit, generation]);

  const records = React.useMemo(
    () =>
      (page?.raw ?? [])
        .map((raw) => parseLogLine(raw, source ?? ORPHAN, { width: opts.width, color: opts.color, now: rangeAnchor }))
        .filter((record): record is LogRecord => record !== null),
    [page, source, opts.width, opts.color, rangeAnchor],
  );
  const lines = React.useMemo(() => logLines(records, filters, rangeAnchor), [records, filters, rangeAnchor]);

  /**
   * One older page, prepended — and, when that takes the buffer over `outputBufferLines`, the same number
   * of lines given up at the newest end. That is what "bounded" means while scrolling *backwards* (§3.7).
   *
   * Giving them up moves what "the newest line held" is, so the offset — which counts from it — is moved by
   * exactly the display lines that went, and the window in front of the operator does not shift by a row.
   */
  const loadOlder = React.useCallback(() => {
    const current = page;
    if (!current || current.atStart || current.loading || !file || !source) return;
    setPage({ ...current, loading: true });
    // Never more than the buffer can take while still holding a screenful in front of the operator: the
    // lines shed at the newest end are exactly the ones the offset is then moved past, and a page bigger
    // than that would shed the window itself and jump the panel *forwards* while it was scrolling back.
    const step = Math.max(1, Math.min(PAGE, limit - opts.height > 0 ? limit - opts.height : Math.floor(limit / 2)));
    void readBefore(file, current.start, step)
      .then((older) => {
        let shed = 0;
        setPage((latest) => {
          if (!latest || latest.sourceId !== current.sourceId) return latest;
          const merged = [...older.lines, ...latest.raw];
          const overflow = Math.max(0, merged.length - limit);
          if (overflow) {
            const dropped = merged.slice(merged.length - overflow).map((raw) => parseLogLine(raw, source, { width: opts.width, color: opts.color, now: rangeAnchor })).filter((r): r is LogRecord => r !== null);
            shed = logLines(dropped, filters, rangeAnchor).length;
          }
          return {
            ...latest,
            raw: overflow ? merged.slice(0, limit) : merged,
            start: older.start,
            atStart: older.atStart,
            atEnd: latest.atEnd && overflow === 0,
            loading: false,
          };
        });
        if (shed) setOffset((current2) => Math.max(0, current2 - shed));
      })
      .catch(() => setPage((latest) => (latest ? { ...latest, loading: false } : latest)));
  }, [page, file, source, readBefore, limit, opts.width, opts.height, opts.color, rangeAnchor, filters]);

  // The oldest the window may sit is the oldest line held at the *top* of a full window, not at the bottom
  // of an empty one: clamping to `length - 1` left a one-row panel with 119 lines above it out of reach.
  const clampOffset = (next: number): number => Math.max(0, Math.min(next, Math.max(0, lines.length - opts.height)));

  const resetPosition = (): void => {
    setOffset(0);
    setMatch(undefined);
  };

  const scroll = (delta: number): void => {
    const next = clampOffset(offset - delta);
    setOffset(next);
    setMatch(undefined);
    // Within a screenful of the oldest line held: fetch the page above before the operator reaches it.
    if (lines.length - next <= opts.height && !page?.atStart) loadOlder();
  };

  return {
    view,
    filters,
    sources,
    ...(source ? { source } : {}),
    lines,
    offset,
    atStart: page?.atStart ?? false,
    loading: page?.loading ?? true,
    ...(match !== undefined ? { match } : {}),
    scroll,
    toNewest: () => {
      // The newest line of the *file*, not of the buffer: once paging back has shed the tail, getting back
      // to it means reading it again.
      if (page && !page.atEnd) {
        setGeneration((n) => n + 1);
      }
      resetPosition();
    },
    toOldest: () => {
      setOffset(clampOffset(lines.length));
      setMatch(undefined);
      if (!page?.atStart) loadOlder();
    },
    cycleView: (delta) => {
      const next = LOG_VIEWS[(LOG_VIEWS.indexOf(view) + delta + LOG_VIEWS.length) % LOG_VIEWS.length]!;
      // §3.7: "switching a view keeps the position when the same attempt is shown". The same attempt is
      // the same place only when the new view has a file for it; otherwise the position means nothing.
      const same = source && visibleSources(all, next, filters).find((candidate) => candidate.taskId === source.taskId && candidate.attempt === source.attempt);
      setView(next);
      setSourceId(same?.id);
      if (!same) resetPosition();
    },
    cycleSource: (delta) => {
      if (!sources.length) return;
      const index = Math.max(0, sources.findIndex((candidate) => candidate.id === currentId));
      setSourceId(sources[(index + delta + sources.length) % sources.length]!.id);
      resetPosition();
    },
    cycleTask: (delta) => {
      const options: Array<string | undefined> = [undefined, ...sourceTaskIds(all)];
      const index = options.indexOf(filters.taskId);
      const next = options[(Math.max(0, index) + delta + options.length) % options.length];
      setFilters((current) => ({ ...current, taskId: next }));
      setSourceId(undefined);
      resetPosition();
    },
    cycleSeverity: (delta) => {
      const options: Array<LogSeverity | undefined> = [undefined, ...LOG_SEVERITIES];
      const index = options.indexOf(filters.severity);
      setFilters((current) => ({ ...current, severity: options[(Math.max(0, index) + delta + options.length) % options.length] }));
      resetPosition();
    },
    cycleRange: (delta) => {
      setRangeAnchor(Date.now());
      setFilters((current) => ({ ...current, range: ((current.range ?? 0) + delta + LOG_RANGES.length) % LOG_RANGES.length }));
      resetPosition();
    },
    stepMatch: (direction) => {
      const matches = searchMatches(lines, opts.search);
      if (!matches.length) return;
      const current = match ?? lines.length - offset - 1;
      const next =
        direction === 1
          ? (matches.find((index) => index > current) ?? matches[0]!)
          : ([...matches].reverse().find((index) => index < current) ?? matches[matches.length - 1]!);
      setMatch(next);
      // Put the match a third of the way up the window, which is where the eye looks for it.
      setOffset(clampOffset(lines.length - next - Math.floor(opts.height / 3) - 1));
    },
    reload: () => {
      setGeneration((n) => n + 1);
      resetPosition();
    },
  };
}

async function defaultReadTail(file: string, lines: number): Promise<RawPage> {
  const { readTailPage } = await import('../../persistence/log-pager.js');
  return readTailPage(file, lines);
}

async function defaultReadBefore(file: string, offset: number, lines: number): Promise<RawPage> {
  const { readPageBefore } = await import('../../persistence/log-pager.js');
  return readPageBefore(file, offset, lines);
}
