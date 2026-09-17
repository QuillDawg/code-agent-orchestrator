/**
 * The panels the main area can show that are not the Overview: the tabs stage 2 and stage 3 fill, the
 * report, the command palette and the contextual help.
 *
 * The placeholders are deliberately explicit about which stage fills them. A blank panel reads as a bug and
 * costs an operator the time it takes to find out it is not one; a sentence naming the stage costs nothing
 * and is true until the stage lands.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { go as fuzzyGo } from 'fuzzysort';
import { truncateVisible } from '../../cli/util.js';
import { glyph } from '../../util/glyphs.js';
import { formatClock } from '../../util/duration.js';
import { renderMarkdown } from '../markdown.js';
import { endedKeys, globalKeys, PROMPT_KEYS, QUIT_ANSWERS, VIEWER_KEYS, panelHelp, type KeyHelp, type KeyMode } from './keys.js';
import type { EndedAction } from './ended.js';
import { wrapPlain } from './detail.js';
import { observerKeys, type ObserverAction } from './observer.js';
import { TAB_LABEL, type ControlRecord, type FocusRegion, type WorkspaceTab } from '../store.js';
import type { Theme, ThemeToken } from '../theme.js';
import { windowOf } from '../window.js';

/** What each unfilled tab is for, and when it arrives. Kept here so `?`, the tab and the docs agree. */
export const PLACEHOLDER_TEXT: Partial<Record<WorkspaceTab, string[]>> = {
  session: [
    'The Session panel arrives in stage 2.',
    'It will hold the live transcript, the composer, editing an unfinished task and sending a worker a follow-up.',
    '',
    'Until then: F follows the selected task, and cao task <id> shows everything recorded about it.',
  ],
  logs: [
    'The Logs panel arrives in stage 3.',
    'It will hold this run’s own log: the orchestrator’s events, the runner’s stderr and the doctor probes.',
    '',
    'Until then: F opens the transcript viewer that cao logs --follow shares, and cao logs <task> prints it.',
  ],
  diagnostics: [
    'The rest of the Diagnostics panel arrives in stage 3.',
    'It will hold the agent versions, the probe results and the lock.',
    '',
    'Until then: cao doctor answers the same questions.',
  ],
};

/** What each control outcome is called on screen, and how it is painted (§2.3). */
const CONTROL_STATUS: Record<ControlRecord['status'], { label: string; token: ThemeToken }> = {
  sent: { label: 'sent…', token: 'muted' },
  accepted: { label: 'accepted', token: 'info' },
  applied: { label: 'applied', token: 'success' },
  rejected: { label: 'rejected', token: 'danger' },
  timeout: { label: 'no answer yet', token: 'warning' },
};

/** One row of the control history: when, what was asked, and what came back. */
export function controlLine(record: ControlRecord): string {
  const status = CONTROL_STATUS[record.status];
  return `${formatClock(new Date(record.at).toISOString())}  ${record.label} ${glyph('arrow')} ${status.label}${record.reason ? `: ${record.reason}` : ''}`;
}

export interface DiagnosticsPanelProps {
  controls: readonly ControlRecord[];
  rows: number;
  columns: number;
  theme: Theme;
}

/**
 * The Diagnostics tab: the controls this window has sent, then what the panel will hold in stage 3.
 *
 * The history is here rather than only in the notice area because a notice lasts four seconds and the
 * question it answers — "did the stop I sent get through to the other terminal" — outlasts it (§2.3). The
 * newest row is at the bottom, so the panel reads as the log it is.
 */
export function DiagnosticsPanel({ controls, rows, columns, theme }: DiagnosticsPanelProps): React.JSX.Element {
  const notes = wrapLines(PLACEHOLDER_TEXT.diagnostics ?? [], columns);
  // The history first, the stage-3 note with whatever is left: a row of it is worth more than a row of a
  // sentence that says the same thing on every frame.
  const historyRows = Math.max(0, Math.min(controls.length + 1, rows - 2));
  const shown = controls.slice(-Math.max(0, historyRows - 1));
  const noteRows = Math.max(0, rows - 1 - historyRows - 1);
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>{TAB_LABEL.diagnostics}</Text>
      <Text wrap="truncate-end">{theme.paint('Controls sent from this window', 'title')}</Text>
      {shown.length === 0 ? (
        <Text wrap="truncate-end">{theme.paint('  none yet', 'muted')}</Text>
      ) : (
        shown.map((record) => (
          <Text key={record.id} wrap="truncate-end">
            {'  '}
            {theme.paint(truncateVisible(controlLine(record), Math.max(10, columns - 2)), CONTROL_STATUS[record.status].token)}
          </Text>
        ))
      )}
      {noteRows > 0 && <Text> </Text>}
      {notes.slice(0, noteRows).map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {theme.paint(truncateVisible(line, columns), 'muted')}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Paragraphs to lines that fit `columns`.
 *
 * The placeholders and the Diagnostics note are prose, and prose that is truncated has lost the half of the
 * sentence that says what to do instead — "Until then: F follows the selected task, and cao task <id> shows
 * everything record…" was the whole answer the panel existed to give.
 */
export function wrapLines(paragraphs: readonly string[], columns: number): string[] {
  return paragraphs.flatMap((line) => (line.trim() === '' ? [''] : wrapPlain(line, Math.max(20, columns))));
}

export interface PlaceholderProps {
  tab: WorkspaceTab;
  rows: number;
  columns: number;
  theme: Theme;
}

export function Placeholder({ tab, rows, columns, theme }: PlaceholderProps): React.JSX.Element {
  const lines = wrapLines(PLACEHOLDER_TEXT[tab] ?? [`The ${TAB_LABEL[tab]} panel is not filled in yet.`], columns);
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>{TAB_LABEL[tab]}</Text>
      {lines.slice(0, Math.max(0, rows - 1)).map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {theme.paint(truncateVisible(line, columns), 'muted')}
        </Text>
      ))}
    </Box>
  );
}

export interface ReportPanelProps {
  /** `report.md` from the run directory, null while it is being read, undefined when there is none yet. */
  markdown: string | null | undefined;
  rows: number;
  columns: number;
  theme: Theme;
  cursor: number;
  /** `/` in this panel: only the lines that match are shown. */
  search?: string;
  focused: boolean;
}

/** The lines a report renders to, so the panel and a test measure the same thing. */
export function reportLines(markdown: string, columns: number, color: boolean, search?: string): string[] {
  const lines = renderMarkdown(markdown, { color, width: Math.max(20, columns - 2) });
  if (!search) return lines;
  const needle = search.toLowerCase();
  return lines.filter((line) => line.toLowerCase().includes(needle));
}

export function ReportPanel({ markdown, rows, columns, theme, cursor, search, focused }: ReportPanelProps): React.JSX.Element {
  if (markdown === null) return <Text dimColor>{'Reading report.md…'}</Text>;
  if (markdown === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>Report</Text>
        <Text dimColor wrap="truncate-end">
          The run writes report.md when it ends; cao report prints the same document from what is on disk.
        </Text>
      </Box>
    );
  }
  const lines = reportLines(markdown, columns, theme.color, search);
  const header = search !== undefined ? 1 : 0;
  const slice = windowOf(lines, cursor, Math.max(1, rows - header - 1), { anchor: cursor });
  return (
    <Box flexDirection="column" width={columns}>
      {search !== undefined && <Text wrap="truncate-end">{theme.paint(`/${search}   ${lines.length} line${lines.length === 1 ? '' : 's'}`, 'accent')}</Text>}
      {slice.items.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text wrap="truncate-end">
        {theme.paint(`${slice.aboveMarker ?? ''}${slice.aboveMarker && slice.belowMarker ? '  ' : ''}${slice.belowMarker ?? ''}${focused ? '' : '   Tab to scroll'}`, 'muted')}
      </Text>
    </Box>
  );
}

/** One thing the palette can do: an action of the workspace, or a task to select. */
export interface PaletteEntry {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

/**
 * The palette's entries for a query [D12]. An empty query keeps the natural order - actions first, then the
 * tasks in workflow order - because the palette is also how the actions are discovered at all.
 */
export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim();
  if (!q) return entries;
  return fuzzyGo(q, entries, { keys: ['label', 'id'], limit: 50, threshold: 0.3 }).map((r) => r.obj);
}

export interface PaletteProps {
  entries: PaletteEntry[];
  query: string;
  cursor: number;
  rows: number;
  columns: number;
  theme: Theme;
}

export function Palette({ entries, query, cursor, rows, columns, theme }: PaletteProps): React.JSX.Element {
  // Two rows of border, the query and the key line: what is left is entries. Without the explicit height
  // Yoga shrank the box to the rows it had and took the shrink out of the first child, so at 80x24 the
  // palette drew its matches with no sign of what had been typed to find them.
  const slice = windowOf(entries, cursor, Math.max(1, rows - 4), { anchor: 0 });
  const width = Math.max(20, Math.min(columns - 2, 72));
  const height = Math.min(rows, Math.max(4, slice.items.length + 4));
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} borderStyle="round" borderColor={theme.ink('border')}>
      <Text wrap="truncate-end">
        {theme.paint('> ', 'accent')}
        {query}
        {theme.paint(glyph('barFull'), 'accent')}
      </Text>
      {slice.items.map((entry, i) => {
        const index = slice.start + i;
        const label = truncateVisible(entry.label, width - 6);
        return (
          <Text key={entry.id} wrap="truncate-end">
            {index === cursor ? theme.paint(`${glyph('cursor')} `, 'accent') : '  '}
            {index === cursor ? theme.paint(label, 'selection') : label}
            {entry.hint ? theme.paint(`  ${entry.hint}`, 'muted') : ''}
          </Text>
        );
      })}
      {entries.length === 0 && <Text dimColor>no match</Text>}
      <Text wrap="truncate-end">{theme.paint('↑↓ choose   Enter run   Esc close', 'muted')}</Text>
    </Box>
  );
}

export interface HelpPanelProps {
  focus: FocusRegion;
  tab: WorkspaceTab;
  rows: number;
  columns: number;
  theme: Theme;
  cursor: number;
  /** The ended-state actions, when the run has ended and this process may run them (§2.4). */
  ended?: EndedAction[];
  /** The controls this window may send to the process that owns the run (§2.1, [D37]). */
  observer?: ObserverAction[];
  /** What the workspace is doing, which decides what "Anywhere" says about Q and Ctrl+C. */
  mode?: KeyMode;
}

/**
 * The help sections for the focused panel, most relevant first.
 *
 * `mode` decides what "Anywhere" says about `Q` and `Ctrl+C`, and the keys the lead sections have claimed
 * are taken out of the panel's own list — so every row of this panel is true of the frame behind it, which
 * is the only thing `?` is for.
 */
export function helpSections(focus: FocusRegion, tab: WorkspaceTab, ended?: EndedAction[], observer?: ObserverAction[], mode: KeyMode = 'executing'): Array<{ title: string; keys: KeyHelp[] }> {
  const taken = new Set([...(observer ?? []), ...(ended ?? [])].map((action) => action.key.toUpperCase()));
  if (mode === 'observing') taken.add('R');
  const panel = panelHelp(focus, tab, taken);
  return [
    ...(observer ? [{ title: 'Another process owns this run', keys: observerKeys(observer) }] : []),
    ...(ended?.length ? [{ title: 'This run has ended', keys: endedKeys(ended) }] : []),
    { title: `${panel.title} — the panel with the keys`, keys: panel.keys },
    { title: 'Anywhere', keys: globalKeys(mode) },
    { title: 'Transcript viewer (F)', keys: VIEWER_KEYS },
    { title: 'When a worker needs you', keys: PROMPT_KEYS },
  ];
}

export function HelpPanel({ focus, tab, rows, columns, theme, cursor, ended, observer, mode }: HelpPanelProps): React.JSX.Element {
  const sections = helpSections(focus, tab, ended, observer, mode);
  const keyWidth = Math.min(22, Math.max(...sections.flatMap((s) => s.keys.map((k) => k.keys.length))));
  const lines: Array<{ text: string; bold?: boolean; dim?: boolean }> = [];
  // Wrapped under the key column rather than truncated. This is the panel an operator opens *because* a key
  // surprised them, and at 80 columns a truncated row ended in the half of the sentence that mattered:
  // "Q  quit: while a run is going it asks first; on an ended run it le…".
  const whatWidth = Math.max(16, columns - keyWidth - 4);
  for (const section of sections) {
    if (lines.length) lines.push({ text: ' ' });
    lines.push({ text: section.title, bold: true });
    for (const key of section.keys) {
      const [first, ...rest] = wrapPlain(key.what, whatWidth);
      lines.push({ text: `  ${key.keys.padEnd(keyWidth)}  ${first ?? ''}`, dim: false });
      for (const line of rest) lines.push({ text: `  ${' '.repeat(keyWidth)}  ${line}`, dim: true });
    }
  }
  const slice = windowOf(lines, cursor, Math.max(1, rows - 1), { anchor: cursor });
  return (
    <Box flexDirection="column" width={columns}>
      {slice.items.map((line, i) => (
        <Text key={i} bold={line.bold} dimColor={line.dim} wrap="truncate-end">
          {truncateVisible(line.text, columns)}
        </Text>
      ))}
      <Text wrap="truncate-end">{theme.paint(`${slice.belowMarker ? `${slice.belowMarker}   ` : ''}↑↓ scroll   Esc close`, 'muted')}</Text>
    </Box>
  );
}

export interface QuitPromptProps {
  cursor: number;
  rows: number;
  columns: number;
  theme: Theme;
}

/**
 * What `Q` asks while a run is still going [D5]: stay, stop and quit, or carry on in plain output.
 *
 * Three answers rather than two because the third is the old `Q` — the run keeps going and the screen gets
 * out of the way — and taking it away would have broken the one workflow people already had for "let this
 * finish while I do something else".
 */
export function QuitPrompt({ cursor, rows, columns, theme }: QuitPromptProps): React.JSX.Element {
  // As wide as the panel allows, not 72: this is the one prompt whose whole job is the sentence explaining
  // each answer, and at 120 columns the box was capped narrow enough to cut "…with the run's exit code" off
  // the answer it describes. What still does not fit drops onto its own indented line rather than being cut.
  const width = Math.max(20, columns - 2);
  const inline = QUIT_ANSWERS.every((answer) => 4 + answer.key.length + answer.label.length + answer.what.length <= width - 2);
  const height = Math.min(rows, QUIT_ANSWERS.length * (inline ? 1 : 2) + 3);
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} borderStyle="round" borderColor={theme.ink('border')}>
      <Text bold wrap="truncate-end">
        The run is still going. What now?
      </Text>
      {QUIT_ANSWERS.map((answer, i) => (
        <Box key={answer.kind} flexDirection="column">
          <Text wrap="truncate-end">
            {i === cursor ? theme.paint(`${glyph('cursor')} `, 'accent') : '  '}
            {theme.paint(answer.key, 'key')} {i === cursor ? theme.paint(answer.label, 'selection') : answer.label}
            {inline ? theme.paint(`  ${answer.what}`, 'muted') : ''}
          </Text>
          {inline ? null : <Text wrap="truncate-end">{theme.paint(`      ${answer.what}`, 'muted')}</Text>}
        </Box>
      ))}
    </Box>
  );
}

export interface AnswerFieldProps {
  taskId: string;
  /** What the worker asked, already sanitized by the caller. */
  question?: string;
  text: string;
  rows: number;
  columns: number;
  theme: Theme;
}

/**
 * The field an answer to a `needs_input` task is typed into before the run is resumed (§2.4).
 *
 * Deliberately the simplest thing that works: a buffer, `Ctrl+J` for a newline and `Enter` to send. The
 * composer of §3.5 — history, `$EDITOR`, paste handling, per-task drafts — is stage 2's, and half of one
 * here would be in its way.
 */
export function AnswerField({ taskId, question, text, rows, columns, theme }: AnswerFieldProps): React.JSX.Element {
  const width = Math.max(20, Math.min(columns - 2, 88));
  const questionRows = question ? 2 : 0;
  const lines = text.split('\n');
  const body = lines.slice(-Math.max(1, rows - 4 - questionRows));
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={theme.ink('border')}>
      <Text bold wrap="truncate-end">
        Answer {taskId} and resume
      </Text>
      {question ? (
        <Text wrap="truncate-end">{theme.paint(truncateVisible(question, width - 2), 'muted')}</Text>
      ) : null}
      {body.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line}
          {i === body.length - 1 ? theme.paint(glyph('barFull'), 'accent') : ''}
        </Text>
      ))}
      <Text wrap="truncate-end">{theme.paint('Enter send and resume   Ctrl+J newline   Esc cancel', 'muted')}</Text>
    </Box>
  );
}
