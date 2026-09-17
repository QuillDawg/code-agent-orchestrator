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
import { renderMarkdown } from '../markdown.js';
import { GLOBAL_KEYS, PROMPT_KEYS, VIEWER_KEYS, panelHelp, type KeyHelp } from './keys.js';
import { TAB_LABEL, type FocusRegion, type WorkspaceTab } from '../store.js';
import type { Theme } from '../theme.js';
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
    'The Diagnostics panel arrives in stage 3.',
    'It will hold the agent versions, the probe results, the lock and the request inbox.',
    '',
    'Until then: cao doctor answers the same questions.',
  ],
};

export interface PlaceholderProps {
  tab: WorkspaceTab;
  rows: number;
  columns: number;
  theme: Theme;
}

export function Placeholder({ tab, rows, columns, theme }: PlaceholderProps): React.JSX.Element {
  const lines = PLACEHOLDER_TEXT[tab] ?? [`The ${TAB_LABEL[tab]} panel is not filled in yet.`];
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
  const slice = windowOf(entries, cursor, Math.max(1, rows - 3), { anchor: 0 });
  const width = Math.max(20, Math.min(columns - 2, 72));
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={theme.ink('border')}>
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
}

/** The help sections for the focused panel, most relevant first. */
export function helpSections(focus: FocusRegion, tab: WorkspaceTab): Array<{ title: string; keys: KeyHelp[] }> {
  const panel = panelHelp(focus, tab);
  return [
    { title: `${panel.title} — the panel with the keys`, keys: panel.keys },
    { title: 'Anywhere', keys: GLOBAL_KEYS },
    { title: 'Transcript viewer (F)', keys: VIEWER_KEYS },
    { title: 'When a worker needs you', keys: PROMPT_KEYS },
  ];
}

export function HelpPanel({ focus, tab, rows, columns, theme, cursor }: HelpPanelProps): React.JSX.Element {
  const keyWidth = Math.min(22, Math.max(...helpSections(focus, tab).flatMap((s) => s.keys.map((k) => k.keys.length))));
  const lines: Array<{ text: string; bold?: boolean; dim?: boolean }> = [];
  for (const section of helpSections(focus, tab)) {
    if (lines.length) lines.push({ text: ' ' });
    lines.push({ text: section.title, bold: true });
    for (const key of section.keys) lines.push({ text: `  ${key.keys.padEnd(keyWidth)}  ${key.what}`, dim: false });
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
