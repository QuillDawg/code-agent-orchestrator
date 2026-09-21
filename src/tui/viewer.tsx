/**
 * Transcript viewer shared by the dashboard follow view and `cao logs --follow`: a task strip on top,
 * the styled transcript below, scrolling with auto-follow, and task/attempt switching.
 *
 * Everything that makes a long transcript navigable lives here: `/` search with `n`/`N`, the `k` kind
 * filter, `T` for thinking, and paging older entries in from the attempt's events.jsonl once scrolling
 * reaches the top of what is still in memory.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { stateGlyph, STATE_LABEL } from '../workflow/states.js';
import { renderTranscript } from './transcript.js';
import {
  filterEntries,
  nextFilter,
  FILTER_LABEL,
  type TranscriptFilter,
  type TaskState,
  type TranscriptEntry,
  type RunnerUsage,
} from 'code-agent-orchestrator-protocol';
import { entryKey } from '../persistence/transcript-log.js';
import { glyph } from '../util/glyphs.js';
import { sanitizeText, stripAnsi } from '../cli/color.js';
import { themeFor, type Theme } from './theme.js';
import { formatCost, formatTokens } from './format.js';

export interface ViewerTask {
  id: string;
  state: TaskState;
  attempts: number[];
  elapsed?: string;
  usage?: RunnerUsage;
  filesChanged?: number;
  /** Shown under the strip while the worker waits for a human. */
  pending?: string;
}

export interface TranscriptViewerProps {
  tasks: ViewerTask[];
  taskId: string;
  attempt?: number;
  entries: TranscriptEntry[];
  width: number;
  height: number;
  color: boolean;
  /** The workspace's theme. `cao logs --follow` has only `color` and gets `themeFor`'s answer. */
  theme?: Theme;
  onSelectTask: (id: string) => void;
  onSelectAttempt?: (attempt: number) => void;
  onExit: () => void;
  /** Extra footer hint (e.g. the dashboard's own keys). */
  footerHint?: string;
  isActive?: boolean;
  /** Start with thinking shown (`cao logs --thinking`). */
  thinking?: boolean;
  /**
   * Entries older than `oldest`, read from the attempt's events.jsonl. Returning an empty array means the
   * transcript has no more history, and the viewer stops asking.
   */
  loadOlder?: (oldest: TranscriptEntry | undefined) => Promise<TranscriptEntry[]>;
}

const MAX_STRIP_TASKS = 6;

function stripLine(tasks: ViewerTask[], selected: number, width: number, theme: Theme): string {
  const start = Math.max(0, Math.min(selected - Math.floor(MAX_STRIP_TASKS / 2), tasks.length - MAX_STRIP_TASKS));
  const shown = tasks.slice(start, start + MAX_STRIP_TASKS);
  const parts = shown.map((t, i) => {
    const idx = start + i;
    const label = `${stateGlyph(t.state)} ${t.id}`;
    return idx === selected ? theme.paint(` ${label} `, 'selection') : theme.paint(` ${label} `, theme.stateToken(t.state));
  });
  const more = tasks.length > shown.length ? theme.paint(` +${tasks.length - shown.length} `, 'dim') : '';
  const left = start > 0 ? theme.paint(`${glyph('left')} `, 'dim') : '';
  const right = start + shown.length < tasks.length ? theme.paint(` ${glyph('right')}`, 'dim') : '';
  const line = `${left}${parts.join(' ')}${more}${right}`;
  return width > 0 && line.length > width * 3 ? line.slice(0, width * 3) : line;
}

export function TranscriptViewer(props: TranscriptViewerProps): React.JSX.Element {
  const { tasks, taskId, entries, width, height, color, isActive = true } = props;
  const theme = themeFor(color, props.theme);
  const selected = Math.max(0, tasks.findIndex((t) => t.id === taskId));
  const task = tasks[selected];
  const [offset, setOffset] = useState(0); // lines scrolled up from the bottom; 0 = auto-follow
  const [showToolResults, setShowToolResults] = useState(false);
  const [showThinking, setShowThinking] = useState(Boolean(props.thinking));
  const [picker, setPicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState(selected);
  const [filter, setFilter] = useState<TranscriptFilter>('all');
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState<string | null>(null); // the `/` prompt, null when it is closed
  const [matchCursor, setMatchCursor] = useState(0);
  // Entries paged in from disk, older than anything the caller passed. Prepended, never re-fetched.
  const [older, setOlder] = useState<TranscriptEntry[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The entry the source last said it had nothing before, rather than a plain "we are at the start" flag.
  const [startBefore, setStartBefore] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
    setOlder([]);
    setStartBefore(null);
    setLoadingOlder(false);
  }, [taskId, props.attempt]);

  const all = useMemo(() => (older.length ? [...older, ...entries] : entries), [older, entries]);
  /**
   * "No more history" is true of the entry it was said about, not of the task forever. A live buffer drops
   * its oldest entries as it fills, so the next oldest one may well be reachable; a flag that latched on the
   * first empty page turned paging off for the rest of the session, silently and with nothing on screen.
   */
  const oldestKey = all.length ? entryKey(all[0]!) : '';
  const atStart = startBefore !== null && startBefore === oldestKey;
  const shown = useMemo(() => filterEntries(all, filter, showThinking), [all, filter, showThinking]);
  const lines = useMemo(
    () => renderTranscript(shown, { color, theme, width: Math.max(20, width - 1), showToolResults, showThinking, timestamps: width >= 100 ? true : 'short' }),
    [shown, color, theme, width, showToolResults, showThinking],
  );
  const bodyHeight = Math.max(3, height - 6);
  const maxOffset = Math.max(0, lines.length - bodyHeight);
  const clamped = Math.min(offset, maxOffset);

  const end = lines.length - clamped;
  const visible = lines.slice(Math.max(0, end - bodyHeight), end);
  const firstVisible = Math.max(0, end - bodyHeight);

  /**
   * Two ways the scroll position would otherwise be lost, both while reading something older than the end.
   *
   * The offset counts lines from the end, so a worker that keeps writing drags what you are reading off the
   * top of the screen: growing the offset by whatever was appended keeps the view on the same lines and the
   * "n lines above the end" counter true. (Paging older entries in prepends instead, which an offset from the
   * end already survives.) And `t`, `T` or `k` re-render every entry, so the line you were on moves by an
   * amount nothing can predict: `keep` is that line, put back where it was.
   *
   * `Shift+G` still returns to the end either way.
   */
  const anchor = React.useRef<{ lines: number; older: number; keep: string | null }>({ lines: 0, older: 0, keep: null });
  const keepTop = (): void => {
    anchor.current.keep = clamped > 0 ? stripAnsi(visible[0] ?? '') || null : null;
  };
  useEffect(() => {
    const before = anchor.current;
    anchor.current = { lines: lines.length, older: older.length, keep: null };
    if (before.keep !== null) {
      const at = lines.findIndex((l) => stripAnsi(l) === before.keep);
      // Gone (a filter dropped it): back to the end, which is at least somewhere you asked to be.
      setOffset(at < 0 ? 0 : Math.max(0, Math.min(lines.length - bodyHeight, lines.length - bodyHeight - at)));
      return;
    }
    const appended = lines.length - before.lines;
    if (before.older === older.length && appended > 0) setOffset((o) => (o > 0 ? o + appended : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, older.length]);

  const matches = useMemo(() => {
    if (!query) return [];
    const needle = query.toLowerCase();
    const found: number[] = [];
    lines.forEach((l, i) => {
      if (stripAnsi(l).toLowerCase().includes(needle)) found.push(i);
    });
    return found;
  }, [lines, query]);
  const current = matches.length ? matches[Math.min(matchCursor, matches.length - 1)]! : -1;

  /**
   * Matches in what is collapsed away: the tail of a long tool result, and every entry of a subagent. Without
   * this a search for a string that is on screen-but-collapsed answers "no matches", which is simply untrue.
   */
  const hiddenMatches = useMemo(() => {
    if (!query || showToolResults) return 0;
    const needle = query.toLowerCase();
    const expanded = renderTranscript(shown, { color, theme, width: Math.max(20, width - 1), showToolResults: true, showThinking, timestamps: width >= 100 ? true : 'short' });
    return Math.max(0, expanded.filter((l) => stripAnsi(l).toLowerCase().includes(needle)).length - matches.length);
  }, [query, showToolResults, shown, color, theme, width, showThinking, matches.length]);

  /** Scroll so `line` sits in the middle of the body. */
  const jumpTo = (line: number): void => {
    const bottom = Math.min(lines.length, line + Math.ceil(bodyHeight / 2));
    setOffset(Math.max(0, Math.min(Math.max(0, lines.length - bodyHeight), lines.length - bottom)));
  };

  // A committed search moves the view to its first match; without this `/` would only change the counter.
  useEffect(() => {
    if (query && matches.length) jumpTo(matches[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const step = (delta: number): void => {
    if (!matches.length) return;
    const next = (Math.min(matchCursor, matches.length - 1) + delta + matches.length) % matches.length;
    setMatchCursor(next);
    jumpTo(matches[next]!);
  };

  /** Ask for the page before the oldest entry on screen; once the source says "no more", stop asking. */
  const pageOlder = (): void => {
    if (!props.loadOlder || loadingOlder || atStart) return;
    const asked = all[0];
    const askedKey = asked ? entryKey(asked) : '';
    setLoadingOlder(true);
    void props.loadOlder(asked).then(
      (page) => {
        setLoadingOlder(false);
        if (page.length) setOlder((prev) => [...page, ...prev]);
        else setStartBefore(askedKey);
      },
      () => {
        setLoadingOlder(false);
        setStartBefore(askedKey);
      },
    );
  };

  const scrollUp = (by: number): void => {
    if (clamped >= maxOffset) pageOlder();
    setOffset(() => Math.min(maxOffset, clamped + by));
  };

  const selectBy = (delta: number): void => {
    if (!tasks.length) return;
    const next = (selected + delta + tasks.length) % tasks.length;
    props.onSelectTask(tasks[next]!.id);
  };

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (typing !== null) {
        if (key.escape) setTyping(null);
        else if (key.return) {
          setQuery(typing);
          setTyping(null);
          setMatchCursor(0);
          // Ink 7 reports Backspace as `key.backspace`; `key.delete` is the forward-delete key (see modal.tsx).
        } else if (key.backspace) setTyping((t) => (t ?? '').slice(0, -1));
        else if (input && !key.ctrl && !key.meta) setTyping((t) => `${t ?? ''}${input}`);
        return;
      }
      // Ctrl+A is this view's one deliberate chord; everything below matches on the letter alone, so any
      // other modifier press would act as that letter (Ctrl+Q would leave, Ctrl+P open the picker).
      if (key.ctrl && input === 'a') return scrollUp(maxOffset);
      if (key.ctrl || key.meta) return;
      if (picker) {
        if (key.escape || lower === 'q' || lower === 'p') setPicker(false);
        else if (key.upArrow) setPickerCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow) setPickerCursor((c) => Math.min(tasks.length - 1, c + 1));
        else if (key.return) {
          const t = tasks[pickerCursor];
          if (t) props.onSelectTask(t.id);
          setPicker(false);
        }
        return;
      }
      if (key.escape || lower === 'q') props.onExit();
      else if (key.leftArrow || (key.tab && key.shift)) selectBy(-1);
      else if (key.rightArrow || key.tab) selectBy(1);
      else if (/^[1-9]$/.test(input)) {
        const t = tasks[Number(input) - 1];
        if (t) props.onSelectTask(t.id);
      } else if (lower === 'p') {
        setPickerCursor(selected);
        setPicker(true);
      } else if (input === 't') {
        keepTop();
        setShowToolResults((v) => !v);
      } else if (input === 'T') {
        keepTop();
        setShowThinking((v) => !v);
      } else if (input === '/') setTyping('');
      else if (input === 'n') step(1);
      else if (input === 'N') step(-1);
      else if (input === 'k') {
        keepTop();
        setFilter(nextFilter(filter));
      } else if (key.upArrow) scrollUp(1);
      else if (key.downArrow) setOffset(() => Math.max(0, clamped - 1));
      else if (key.pageUp) scrollUp(bodyHeight);
      else if (key.pageDown) setOffset(() => Math.max(0, clamped - bodyHeight));
      // vim/less convention: g jumps to the oldest line, Shift+G returns to the end and resumes auto-follow.
      else if (lower === 'g' && key.shift) setOffset(0);
      else if (input === 'g') scrollUp(maxOffset);
      else if (input === '[' && props.onSelectAttempt && task) {
        const i = task.attempts.indexOf(props.attempt ?? task.attempts[task.attempts.length - 1]!);
        if (i > 0) props.onSelectAttempt(task.attempts[i - 1]!);
      } else if (input === ']' && props.onSelectAttempt && task) {
        const i = task.attempts.indexOf(props.attempt ?? task.attempts[task.attempts.length - 1]!);
        if (i >= 0 && i < task.attempts.length - 1) props.onSelectAttempt(task.attempts[i + 1]!);
      }
    },
    { isActive },
  );

  const attemptInfo = task && task.attempts.length ? `attempt ${props.attempt ?? task.attempts[task.attempts.length - 1]}${task.attempts.length > 1 ? `/${task.attempts.length}` : ''}` : '';
  const usage = task?.usage;
  const ctx = usage?.contextTokens !== undefined ? `ctx ${formatTokens(usage.contextTokens)}${usage.contextWindow ? `/${formatTokens(usage.contextWindow)}` : ''}` : '';
  const cost = usage?.costUsd !== undefined ? formatCost(usage.costUsd) : '';
  const files = task?.filesChanged ? `±${task.filesChanged} files` : '';
  const meta = [task ? theme.paint(STATE_LABEL[task.state], theme.stateToken(task.state)) : '', attemptInfo, task?.elapsed, ctx, cost, files].filter(Boolean).join('  ');
  // Below 100 columns both the meta line and the key list are wider than the terminal, and truncating them
  // drops exactly what a narrow terminal needs most: where you are, and how to get out.
  const narrow = width < 100;
  const scrolled = clamped > 0 ? theme.paint(narrow ? `  ${glyph('up')} ${clamped} lines (G to follow)` : `  ${glyph('up')} ${clamped} lines above the end (Shift+G to follow)`, 'warn') : '';
  const keys = narrow
    ? `←→ task   P pick   [ ] attempt   ↑↓ scroll   g/G ends   ${props.footerHint ?? 'Q back'}`
    : `←→/Tab task   1-9 jump   P pick   [ ] attempt   ↑↓ PgUp PgDn scroll   g oldest   G follow   ${props.footerHint ?? 'Q/Esc back'}`;

  // What the search found, including what it could only find behind `t`.
  const collapsed = hiddenMatches ? `${hiddenMatches} in collapsed output (t to expand)` : '';
  const matchCounter = matches.length
    ? `${Math.min(matchCursor, matches.length - 1) + 1}/${matches.length}${collapsed ? ` +${collapsed}` : ''}`
    : collapsed || 'no matches';

  const modes = [
    filter === 'all' ? '' : theme.paint(`filter: ${FILTER_LABEL[filter]}`, ['accent2', 'bold']),
    showThinking ? theme.paint('thinking', ['agent', 'bold']) : '',
    query ? theme.paint(`/${sanitizeText(query)} ${matchCounter}`, matches.length ? ['warn', 'bold'] : hiddenMatches ? 'warn' : 'danger') : '',
    loadingOlder ? theme.paint(`loading older${glyph('ellipsis')}`, 'dim') : '',
    atStart ? theme.paint('start of the transcript', 'dim') : '',
  ].filter(Boolean);

  if (picker) {
    return (
      <Box flexDirection="column">
        <Text bold>Switch task</Text>
        <Text dimColor>↑↓ move   Enter open   Esc back</Text>
        {tasks.map((t, i) => (
          <Text key={t.id} inverse={i === pickerCursor} wrap="truncate-end">
            {i === pickerCursor ? '> ' : '  '}
            {theme.paint(`${stateGlyph(t.state)} `, theme.stateToken(t.state))}
            {t.id.padEnd(28)} {STATE_LABEL[t.state].padEnd(12)} {(t.elapsed ?? '').padStart(9)}  {t.usage?.costUsd !== undefined ? formatCost(t.usage.costUsd) : ''}  {t.filesChanged ? `±${t.filesChanged}` : ''}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{stripLine(tasks, selected, width, theme)}</Text>
      <Text wrap="truncate-end" dimColor={!task?.pending}>
        {task?.pending ? theme.paint(`? Needs you: ${sanitizeText(task.pending)}`, ['warn', 'bold']) : meta}
        {scrolled}
      </Text>
      {visible.length === 0 && <Text dimColor>  {shown.length === 0 && all.length ? '(nothing matches this filter)' : '(no output yet)'}</Text>}
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {firstVisible + i === current ? theme.paint(stripAnsi(l), 'selection') : l}
        </Text>
      ))}
      {/* One line that is the search prompt while typing, otherwise whatever modes are on, then the keys. */}
      {typing !== null ? (
        <Text wrap="truncate-end">
          {theme.paint(`/${sanitizeText(typing)}`, ['warn', 'bold'])}
          {theme.paint('   Enter search   Esc cancel', 'dim')}
        </Text>
      ) : (
        <Text wrap="truncate-end">
          {modes.length ? `${modes.join('  ')}   ` : ''}
                {theme.paint(narrow ? '/ search   n/N match   k filter   T think   t expand' : '/ search   n/N match   k filter   T thinking   t tool output + subagents', 'dim')}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {keys}
      </Text>
    </Box>
  );
}
