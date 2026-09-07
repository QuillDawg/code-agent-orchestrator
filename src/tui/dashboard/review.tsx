/**
 * The dashboard's review view (`C`): every task's changed files, and the hunks of the one under the cursor.
 *
 * Two levels. The list groups files by task, with the status letter and `+N -M` per file; it scrolls rather
 * than truncating, so a run that touched two hundred files is still reachable. `Enter` opens the selected
 * file's hunks in a pane that scrolls with the transcript viewer's keys, plus `n`/`p` between hunks and
 * `←`/`→` between files. Nothing here runs git: a finished attempt's hunks come from the `diff.patch` it
 * captured, and a running one shows the live file list until its own patch exists.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TaskState } from '../../types/run.js';
import type { AttemptDiff, DiffFileStatus } from '../../types/result.js';
import { STATE_COLOR, stateGlyph, STATE_LABEL } from '../../workflow/states.js';
import { paint, type Style } from '../../cli/color.js';
import { summarizeDiff } from '../../cli/render/diff.js';
import { fileLabel, recordFiles, shortenLabel, type ReviewFile } from './files.js';
import { buildPane, EMPTY_PANE } from './pane.js';
import { openInEditor } from './editor.js';

const STATUS_STYLE: Record<DiffFileStatus, Style> = { A: 'green', M: 'yellow', D: 'red', R: 'cyan' };

/** The captured diff of one attempt: `diff.json` plus the `diff.patch` beside it. */
export interface LoadedDiff {
  attempt: number;
  diff: AttemptDiff;
  patch: string;
}

/** One task as the dashboard knows it before anything has been read from the run directory. */
export interface ReviewTaskInput {
  taskId: string;
  state: TaskState;
  /** True while an attempt is still running: `files` is the live tool-stream list and there is no patch yet. */
  live: boolean;
  /** How many attempts the task has had; a new one invalidates what was read for the previous one. */
  attempts: number;
  files: ReviewFile[];
}

export interface ReviewViewProps {
  tasks: ReviewTaskInput[];
  width: number;
  /** Rows the view may draw into, header and footer included. */
  height: number;
  color?: boolean;
  /** Reads a finished task's captured diff. Called once per attempt and cached; omitted in tests that only drive the list. */
  loadDiff?: (taskId: string) => Promise<LoadedDiff | null>;
  /** Directory relative paths are resolved against when opening an editor. */
  root?: string;
  /** Injected by tests; the default hands the file to `$VISUAL`/`$EDITOR`. */
  openFile?: (path: string) => string;
  onExit: () => void;
  isActive?: boolean;
}

/** A task's group in the list, after the captured records have replaced the live ones. */
interface Group extends ReviewTaskInput {
  attempt?: number;
  truncated?: boolean;
  /** The diff is still being read from the run directory. */
  loading: boolean;
  /** The files come from the attempt's own `diff.json`, not from the tool stream. */
  captured: boolean;
}

type Row = { kind: 'task'; group: Group } | { kind: 'file'; group: Group; file: ReviewFile; index: number };

const cacheKey = (t: Pick<ReviewTaskInput, 'taskId' | 'attempts'>): string => `${t.taskId}#${t.attempts}`;

/** First visible row so that `cursor` is on screen, with the same window kept while the cursor moves inside it. */
function windowStart(total: number, cursor: number, size: number, previous: number): number {
  const max = Math.max(0, total - size);
  let start = Math.min(previous, max);
  if (cursor < start) start = cursor;
  else if (cursor >= start + size) start = cursor - size + 1;
  return Math.max(0, Math.min(start, max));
}

/**
 * The footer, with the least important hints dropped until it fits. The first hint (how to move) and the last
 * (how to get out) are always kept: a narrow terminal is exactly where a user needs to be told the way back.
 */
function footerLine(parts: string[], width: number): string {
  const kept = parts.filter(Boolean);
  while (kept.length > 2 && kept.join('   ').length > width) kept.splice(kept.length - 2, 1);
  return kept.join('   ');
}

export function ReviewView(props: ReviewViewProps): React.JSX.Element {
  const { tasks, width, height, color = false, loadDiff, isActive = true } = props;
  const [cache, setCache] = useState<Record<string, LoadedDiff | null>>({});
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<'list' | 'pane'>('list');
  const [offset, setOffset] = useState(0);
  // Which hunk n/p last jumped to. Null once the user scrolls by hand, and the position is read off the offset
  // again — a short patch cannot always put a hunk at the top, so the offset alone would report the wrong one.
  const [hunkCursor, setHunkCursor] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listTop = useRef(0);
  const offsetRef = useRef(0);
  const hunkRef = useRef<number | null>(null);

  // Every finished task, keyed by attempt so that a task which starts another one is read again rather than
  // keeping the previous attempt's patch on screen. The effect fires on the key; the array behind it lives in
  // a ref, because the dashboard hands this component a fresh one on every frame.
  const wanted = tasks.filter((t) => !t.live).map((t) => ({ taskId: t.taskId, key: cacheKey(t) }));
  const wantedKey = wanted.map((w) => w.key).join(', ');
  const pending = useRef({ wanted, cache });
  pending.current = { wanted, cache };
  useEffect(() => {
    if (!loadDiff) return undefined;
    const missing = pending.current.wanted.filter((w) => !(w.key in pending.current.cache));
    if (!missing.length) return undefined;
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, LoadedDiff | null> = {};
      for (const { taskId, key } of missing) {
        loaded[key] = await Promise.resolve(loadDiff(taskId)).catch(() => null);
      }
      if (!cancelled) setCache((c) => ({ ...c, ...loaded }));
    })();
    return () => {
      cancelled = true;
    };
  }, [wantedKey, loadDiff]);

  const groups = useMemo<Group[]>(() => {
    return (
      tasks
        .map((t) => {
          const key = cacheKey(t);
          const loaded = t.live ? undefined : cache[key];
          return {
            ...t,
            files: loaded ? recordFiles(loaded.diff.files) : t.files,
            attempt: loaded?.attempt,
            truncated: loaded?.diff.truncated,
            loading: !t.live && loadDiff !== undefined && !(key in cache),
            captured: Boolean(loaded),
          };
        })
        // Every task that has started keeps its header line, even with nothing under it: "changed no files"
        // and "no diff captured" are answers, while a task missing from the list is indistinguishable from
        // one that has not run yet. Tasks still waiting their turn (no attempts) stay out.
        .filter((g) => g.files.length > 0 || g.loading || g.live || g.attempts > 0)
    );
  }, [tasks, cache, loadDiff]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let index = 0;
    for (const group of groups) {
      out.push({ kind: 'task', group });
      for (const file of group.files) out.push({ kind: 'file', group, file, index: index++ });
    }
    return out;
  }, [groups]);
  const files = useMemo(() => rows.filter((r): r is Extract<Row, { kind: 'file' }> => r.kind === 'file'), [rows]);

  const selectedIndex = files.length ? Math.min(cursor, files.length - 1) : -1;
  const selected = selectedIndex >= 0 ? files[selectedIndex]! : undefined;

  // Header, footer, and the row a notice takes while it is on screen: the body gives up a line rather than
  // pushing the footer past the bottom of the terminal.
  const bodyHeight = Math.max(3, height - 3 - (notice ? 1 : 0));

  // The pane's lines: the selected file's sections of its task's captured patch, coloured like `cao diff`.
  // Memoised on primitives only — the dashboard rebuilds the task array on every spinner tick, so a dependency
  // on `selected` would re-sanitize and re-paint a several-thousand-line patch eight times a second.
  const selectedPath = selected?.file.path ?? '';
  const selectedBinary = selected?.file.binary ?? false;
  const selectedPatch = selected ? cache[cacheKey(selected.group)]?.patch ?? '' : '';
  const pane = useMemo(
    () => (selectedPath === '' || selectedPatch === '' ? EMPTY_PANE : buildPane(selectedPatch, { path: selectedPath, binary: selectedBinary }, color)),
    [selectedPath, selectedBinary, selectedPatch, color],
  );
  const paneLines = pane.lines;
  const hunks = pane.hunks;

  const maxOffset = Math.max(0, paneLines.length - bodyHeight);
  const paneOffset = Math.min(offset, maxOffset);

  useEffect(() => {
    offsetRef.current = 0;
    hunkRef.current = null;
    setOffset(0);
    setHunkCursor(null);
  }, [selectedIndex]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The hunk the pane is showing: the one n/p last jumped to, else the last one at or above the top line.
  const hunkAt = hunkCursor ?? Math.max(0, hunks.filter((h) => h <= paneOffset).length - 1);

  /**
   * The position is mirrored into refs so that a held-down key works. Ink delivers every keystroke that
   * arrived in one tick to the same handler, before React has re-rendered, so a second `n` computed from the
   * rendered state would jump to the hunk the first one already went to.
   */
  const move = (nextOffset: number, nextHunk: number | null): void => {
    offsetRef.current = Math.max(0, Math.min(nextOffset, maxOffset));
    hunkRef.current = nextHunk;
    setOffset(offsetRef.current);
    setHunkCursor(nextHunk);
  };
  const scrollTo = (next: (from: number) => number): void => move(next(Math.min(offsetRef.current, maxOffset)), null);
  const byHunk = (delta: number): void => {
    if (!hunks.length) return;
    const from = hunkRef.current ?? Math.max(0, hunks.filter((h) => h <= Math.min(offsetRef.current, maxOffset)).length - 1);
    const next = Math.max(0, Math.min(from + delta, hunks.length - 1));
    move(hunks[next]!, next);
  };

  const openSelected = (): void => {
    if (!selected) return;
    const open = props.openFile ?? ((p: string) => openInEditor(p, { root: props.root }));
    setNotice(open(selected.file.path));
  };
  const moveFile = (delta: number): void => {
    if (!files.length) return;
    setCursor((c) => (Math.min(c, files.length - 1) + delta + files.length) % files.length);
  };

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (lower === 'o') return openSelected();
      if (mode === 'pane') {
        if (key.escape || lower === 'q' || key.backspace) setMode('list');
        else if (key.leftArrow) moveFile(-1);
        else if (key.rightArrow) moveFile(1);
        else if (key.upArrow) scrollTo((o) => Math.max(0, o - 1));
        else if (key.downArrow) scrollTo((o) => Math.min(maxOffset, o + 1));
        else if (key.pageUp) scrollTo((o) => Math.max(0, o - bodyHeight));
        else if (key.pageDown) scrollTo((o) => Math.min(maxOffset, o + bodyHeight));
        // Same convention as the transcript viewer: g to the top, Shift+G to the bottom.
        else if (input === 'G') scrollTo(() => maxOffset);
        else if (input === 'g') scrollTo(() => 0);
        else if (lower === 'n') byHunk(1);
        else if (lower === 'p') byHunk(-1);
        return;
      }
      if (key.escape || lower === 'q' || key.backspace) props.onExit();
      else if (key.return) {
        if (selected) setMode('pane');
      } else if (key.upArrow) setCursor((c) => Math.max(0, Math.min(c, files.length - 1) - 1));
      else if (key.downArrow) setCursor((c) => Math.min(files.length - 1, c + 1));
      else if (key.pageUp) setCursor((c) => Math.max(0, Math.min(c, files.length - 1) - bodyHeight));
      else if (key.pageDown) setCursor((c) => Math.min(files.length - 1, c + bodyHeight));
      else if (input === 'G') setCursor(Math.max(0, files.length - 1));
      else if (input === 'g') setCursor(0);
    },
    { isActive },
  );

  if (mode === 'pane' && selected) {
    const { group, file } = selected;
    const visible = paneLines.slice(paneOffset, paneOffset + bodyHeight);
    const position = hunks.length ? `hunk ${hunkAt + 1}/${hunks.length}` : '';
    const scrolled = paneLines.length > bodyHeight ? `${paneOffset + 1}-${Math.min(paneLines.length, paneOffset + bodyHeight)}/${paneLines.length}` : '';
    // The path gives up columns first: which file this is stays readable from its tail, while the attempt and
    // the position in the file list have nowhere else to be shown.
    const counts = countsLabel(file, false);
    const attemptText = group.attempt !== undefined ? `  attempt ${group.attempt}` : '';
    const positionText = `  file ${selectedIndex + 1}/${files.length}`;
    const label = shortenLabel(fileLabel(file), Math.max(12, width - group.taskId.length - counts.length - attemptText.length - positionText.length - 2));
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {paint(group.taskId, STATE_COLOR[group.state], color)} {paint(label, 'bold', color)} {countsLabel(file, color)}
          {paint(attemptText, 'dim', color)}
          {paint(positionText, 'dim', color)}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {[position, scrolled].filter(Boolean).join('   ')}
        </Text>
        {visible.length === 0 && (
          <Text dimColor wrap="truncate-end">
            {`  ${emptyPaneReason(group, file)}`}
          </Text>
        )}
        {visible.map((line, i) => (
          <Text key={paneOffset + i} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {notice && (
          <Text color="yellow" wrap="truncate-end">
            {notice}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {footerLine(['↑↓ PgUp/PgDn scroll', 'g/G top/bottom', hunks.length > 1 ? 'n/p hunk' : '', files.length > 1 ? '←→ file' : '', 'o editor', 'Esc list'], width)}
        </Text>
      </Box>
    );
  }

  const cursorRow = selected ? rows.indexOf(selected) : 0;
  listTop.current = windowStart(rows.length, cursorRow, bodyHeight, listTop.current);
  const visibleRows = rows.slice(listTop.current, listTop.current + bodyHeight);
  // What is left after the row's own furniture: two levels of indent, the cursor, the status letter, and the
  // widest counts column in the list — those are the numbers the user came for, so the path yields to them.
  const countsWidth = Math.max(0, ...files.map((f) => countsLabel(f.file, false).length));
  const pathWidth = Math.min(Math.max(10, width - countsWidth - 9), Math.max(0, ...files.map((f) => fileLabel(f.file).length)));

  return (
    <Box flexDirection="column">
      {rows.length === 0 && <Text dimColor>  (no files changed yet)</Text>}
      {visibleRows.map((row) =>
        row.kind === 'task' ? (
          <Text key={`h-${row.group.taskId}`} wrap="truncate-end">
            {paint(stateGlyph(row.group.state), STATE_COLOR[row.group.state], color)} {paint(row.group.taskId, 'bold', color)}
            {paint(`  ${groupSummary(row.group, width - row.group.taskId.length - 4)}`, 'dim', color)}
          </Text>
        ) : (
          <Text key={`${row.group.taskId}:${row.file.path}`} wrap="truncate-end">
            {'  '}
            {row.index === selectedIndex ? paint('▶ ', 'cyan', color) : '  '}
            {paint(row.file.status, STATUS_STYLE[row.file.status], color)}{' '}
            {paint(shortenLabel(fileLabel(row.file), pathWidth).padEnd(pathWidth), row.index === selectedIndex ? ['inverse', 'bold'] : [], color)}
            {'  '}
            {countsLabel(row.file, color)}
          </Text>
        ),
      )}
      {rows.length > bodyHeight && (
        <Text dimColor wrap="truncate-end">
          {'  '}… {files.length} files, showing {listTop.current + 1}-{listTop.current + visibleRows.length} of {rows.length} rows
        </Text>
      )}
      {notice && (
        <Text color="yellow" wrap="truncate-end">
          {notice}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {footerLine(['↑↓ PgUp/PgDn select', 'g/G first/last', 'Enter hunks', 'o editor', 'Esc/Q back'], width)}
      </Text>
    </Box>
  );
}

/** `+12 -4` for a captured record, `binary`, or `×3` for a file only the tool stream has seen. */
function countsLabel(file: ReviewFile, color: boolean): string {
  if (file.binary) return paint('binary', 'gray', color);
  if (file.ops !== undefined) return paint(file.ops > 1 ? `×${file.ops} edits` : 'edited', 'dim', color);
  return `${paint(`+${file.additions}`, 'green', color)} ${paint(`-${file.deletions}`, 'red', color)}`;
}

/** The first of `candidates` that fits `room`, or the shortest one when none does. */
function fit(candidates: string[], room: number): string {
  return candidates.find((c) => c.length <= room) ?? candidates[candidates.length - 1]!;
}

/**
 * The dim part of a task's header line: what is known about its diff, and where that knowledge comes from.
 * Each case offers the terminal a full phrasing and shorter ones behind it — how much changed is the part
 * that has to survive a narrow window, while the attempt number and the caveats can give up their columns.
 */
function groupSummary(group: Group, room = Number.POSITIVE_INFINITY): string {
  const count = `${group.files.length} file${group.files.length === 1 ? '' : 's'}`;
  const state = STATE_LABEL[group.state].toLowerCase();
  if (group.loading) return 'reading the captured diff…';
  if (group.live) return group.files.length ? fit([`${state}, ${count} so far`, `${count} so far`], room) : fit([`${state}, nothing changed yet`, 'nothing yet'], room);
  if (!group.captured) {
    if (!group.files.length) return fit(['no diff captured (git.captureDiff is off, or no attempt finished)', 'no diff captured'], room);
    return fit([`${count} seen while it ran; no patch captured`, `${count}, no patch captured`, count], room);
  }
  if (!group.files.length) return fit([`attempt ${group.attempt}  changed no files`, 'changed no files'], room);
  const counts = summarizeDiff(group.files);
  const attempt = `attempt ${group.attempt}`;
  const truncated = group.truncated ? 'patch truncated' : '';
  const join = (...parts: string[]): string => parts.filter(Boolean).join('  ');
  return fit([join(attempt, counts, truncated), join(counts, truncated), counts], room);
}

/** Why the pane has nothing to show for this file. */
function emptyPaneReason(group: Group, file: ReviewFile): string {
  if (group.loading) return 'reading the captured diff…';
  if (group.live) return 'the attempt is still running; its patch is captured when it finishes.';
  if (!group.captured) return 'this attempt captured no patch (git.captureDiff is off, or the run predates the capture).';
  if (group.truncated) return `${file.path} is not in the captured patch: it was cut at git.maxDiffBytes.`;
  return 'no hunks: the patch records this file without content.';
}
