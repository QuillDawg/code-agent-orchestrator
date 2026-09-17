/**
 * The frame around the workspace: header, tab bar, sidebar (or the strip it collapses to) and footer.
 *
 * Everything here is told its size and draws exactly that many rows and columns. None of it wraps: a line
 * that spills onto a second row pushes the panel below it off the bottom of the terminal, which is the
 * failure §2.5 is about, so every line is truncated instead and the compact layout shortens what it can
 * before it comes to that.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { type ResolvedTask, type TaskRunState, type WorkflowRun, ACTIVE_TASK_STATES, addUsage } from 'code-agent-orchestrator-protocol';
import { STATE_LABEL, stateGlyph, summarize } from '../../workflow/states.js';
import { glyph } from '../../util/glyphs.js';
import { formatDuration, formatDurationShort } from '../../util/duration.js';
import { truncateVisible } from '../../cli/util.js';
import { visibleLength } from '../../cli/color.js';
import { agentLabel, formatCost, formatTokens } from '../format.js';
import { TAB_LABEL, WORKSPACE_TABS, type WorkspaceTab } from '../store.js';
import type { Theme } from '../theme.js';
import { windowOf } from '../window.js';
import type { FooterColumn } from './layout.js';

/** Who is driving: this process holds the run, or it is watching one another process owns (§2.1). */
export type WorkspaceRole = 'owner' | 'observer';

/** Tasks whose row is asking for a human rather than reporting a state. */
const NEEDS_HUMAN = new Set(['waiting', 'awaiting_approval', 'needs_input']);
const WENT_WRONG = new Set(['failed', 'blocked', 'cancelled']);

/**
 * The attention badge of one task (§3.2). `editing` and `prompt pending` are stage 2's, and a badge for a
 * state nothing can reach yet would be a lie on every frame, so there are two of them for now.
 */
export function attentionBadge(state: TaskRunState | undefined): string {
  if (!state) return ' ';
  if (NEEDS_HUMAN.has(state.state)) return '?';
  if (WENT_WRONG.has(state.state)) return '!';
  return ' ';
}

/**
 * How many cells of a `width`-wide bar each count gets.
 *
 * Rounding alone gave a 200-task run with three tasks done an entirely empty bar: 3/200 of 20 cells rounds
 * to nothing, and so does the one that failed. A count that is not zero is worth at least one cell — that is
 * the whole point of the bar — so each is rounded up to one and the largest gives cells back if the three
 * together no longer fit.
 */
export function progressSegments(counts: readonly number[], total: number, width: number): number[] {
  const segments = counts.map((n) => (n <= 0 ? 0 : Math.max(1, Math.round((n / Math.max(1, total)) * width))));
  let used = segments.reduce((a, n) => a + n, 0);
  while (used > width) {
    let biggest = 0;
    for (let i = 1; i < segments.length; i += 1) if (segments[i]! > segments[biggest]!) biggest = i;
    if (segments[biggest]! <= 0) break;
    segments[biggest] = segments[biggest]! - 1;
    used -= 1;
  }
  return segments;
}

/** How many rows the header needs this frame, so the layout can be computed before it is drawn. */
export function headerRowsFor(run: WorkflowRun): number {
  return waitingTasks(run).length > 0 ? 3 : 2;
}

export function waitingTasks(run: WorkflowRun): ResolvedTask[] {
  return run.workflow.tasks.filter((t) => NEEDS_HUMAN.has(run.tasks[t.id]?.state ?? ''));
}

export interface HeaderProps {
  run: WorkflowRun;
  theme: Theme;
  columns: number;
  now: number;
  role: WorkspaceRole;
  /**
   * What the badge says (§2.1, §3.2): `owner`, `observing · owner pid N`, `abandoned · resume?`. The role
   * decides how it is painted; the text comes from `ownershipBadge`, so the header, `cao status` and the
   * banner cannot disagree about the same run.
   */
  badge?: string;
  /** The "needs you" line, already sanitized by the caller; omitted when nothing is waiting. */
  attention?: string;
}

export function Header({ run, theme, columns, now, role, badge, attention }: HeaderProps): React.JSX.Element {
  const summary = summarize(run);
  const running = run.workflow.tasks.filter((t) => run.tasks[t.id]?.state === 'running').length;
  const waiting = waitingTasks(run).length;
  const done = summary.success + summary.skipped;
  const narrow = columns < 100;
  // An ended run's clock stops where the run stopped. It used to be `now - startedAt` whatever the run was
  // doing, so a workspace left open on a finished run counted upwards for as long as it was open — and the
  // Overview's own outcome line, which does use `endedAt`, disagreed with the header on the same frame.
  const elapsed = run.startedAt ? formatDuration((run.endedAt ? new Date(run.endedAt).getTime() : now) - new Date(run.startedAt).getTime()) : '';
  const usage = addUsage(...run.workflow.tasks.flatMap((t) => run.tasks[t.id]?.attempts.map((a) => a.usage) ?? []));

  const width = narrow ? 10 : 20;
  const failed = summary.failed + summary.blocked + summary.cancelled;
  const segments = progressSegments([summary.success, failed, running + waiting], summary.total, width);
  const full = glyph('barFull');
  const bar =
    theme.paint(full.repeat(segments[0]!), 'success') +
    theme.paint(full.repeat(segments[1]!), 'danger') +
    theme.paint(full.repeat(segments[2]!), 'info') +
    theme.paint(glyph('barEmpty').repeat(Math.max(0, width - segments.reduce((a, n) => a + n, 0))), 'muted');

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{run.workflowName}</Text>
        <Text dimColor>
          {'  '}run {run.runId} {glyph('bullet')} {run.repositoryRoot}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        [{bar}] {done}/{summary.total} {'  '}
        {theme.paint(`${glyph('ok')}${summary.success}`, 'success')} {theme.paint(`${glyph('error')}${summary.failed + summary.blocked}`, failed ? 'danger' : 'muted')} {theme.paint(`${stateGlyph('running')}${running}`, 'info')}
        {waiting ? ` ${theme.paint(`?${waiting}`, 'warning')}` : ''}
        {'   '}
        {stateGlyph(run.state === 'running' ? 'running' : run.state === 'failed' ? 'failed' : run.state === 'completed' ? 'success' : 'pending')} {RUN_STATE_LABEL[run.state] ?? run.state}
        {'   '}
        {elapsed}
        {'   '}
        {running}/{run.workflow.execution.maxConcurrency}
        {'   '}
        {theme.paint(`[${badge ?? role}]`, role === 'owner' ? 'badge' : 'warning')}
        {usage.costUsd !== undefined ? `   ${formatCost(usage.costUsd)}` : ''}
        {!narrow && usage.inputTokens ? theme.paint(`   ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens ?? 0)} out`, 'muted') : ''}
      </Text>
      {attention !== undefined && (
        <Text wrap="truncate-end">
          {theme.paint('? Needs you: ', 'warning')}
          {attention}
        </Text>
      )}
    </Box>
  );
}

/** The run states, in the words the rest of the surfaces use. */
const RUN_STATE_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export interface TabBarProps {
  tab: WorkspaceTab;
  focused: boolean;
  theme: Theme;
  columns: number;
}

/**
 * The tab bar. The open tab is in brackets rather than merely a different colour, because under `mono` the
 * colour is not there and "which tab am I on" is the one thing the bar exists to answer.
 */
export function TabBar({ tab, focused, theme, columns }: TabBarProps): React.JSX.Element {
  const cells = WORKSPACE_TABS.map((name) => {
    const label = TAB_LABEL[name];
    if (name !== tab) return theme.paint(` ${label} `, 'tabIdle');
    return theme.paint(`[${label}]`, focused ? 'selection' : 'tabActive');
  });
  return (
    <Text wrap="truncate-end">{truncateVisible(cells.join(theme.paint(glyph('vrule'), 'border')), columns)}</Text>
  );
}

export interface SidebarProps {
  tasks: ResolvedTask[];
  run: WorkflowRun;
  cursor: number;
  width: number;
  rows: number;
  theme: Theme;
  focused: boolean;
  /** The glyph a running task gets this frame: a spinner frame, or its static state glyph under reduced motion. */
  runningGlyph: string;
  /** What `/` is filtering by, shown in the title so an empty list is never a mystery. */
  search?: string;
}

/**
 * The task list down the left. One row per task and never more rows than it was given: a 200-task run
 * scrolls inside the window rather than drawing 200 children for Ink to lay out [D9].
 */
export function Sidebar({ tasks, run, cursor, width, rows, theme, focused, runningGlyph, search }: SidebarProps): React.JSX.Element {
  const listRows = Math.max(1, rows - 1 - (search !== undefined ? 1 : 0));
  const slice = windowOf(tasks, cursor, listRows);
  const marker = slice.aboveMarker ?? slice.belowMarker;
  const bodyRows = marker ? Math.max(1, listRows - 1) : listRows;
  const shown = marker ? windowOf(tasks, cursor, bodyRows) : slice;
  // 2 for the cursor column, 2 for the glyph and its space, 1 of gap, 1 for the scrollbar, and the badge
  // column with the space in front of it — but only when something in this list actually has a badge. The
  // agent cell is padded to its full width, so without that space `claude|sonnet` and the `!` of a failed
  // task ran together as `claude|sonnet!`; charging the task names a column for a badge no row is showing
  // is the other half of the same mistake.
  // `claude|gpt-5-codex` is 13 columns after `shortModelName`; below that there is no room for an agent
  // column that says anything, so the task name takes it back rather than both being cut to nothing.
  const badgeWidth = tasks.some((t) => attentionBadge(run.tasks[t.id]) !== ' ') ? 2 : 0;
  const agentWidth = width >= 34 ? 13 : 0;
  const idWidth = Math.max(6, width - 6 - badgeWidth - (agentWidth ? agentWidth + 1 : 0));

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end">
        {theme.paint(truncateVisible(`Tasks ${tasks.length ? cursor + 1 : 0}/${tasks.length}`, width), focused ? 'selection' : 'title')}
      </Text>
      {search !== undefined && <Text wrap="truncate-end">{theme.paint(truncateVisible(`/${search}`, width), 'accent')}</Text>}
      {shown.items.map((task, i) => {
        const index = shown.start + i;
        const state = run.tasks[task.id];
        const kind = state?.state ?? 'pending';
        const mark = kind === 'running' ? runningGlyph : stateGlyph(kind);
        const selected = index === cursor;
        const id = truncateVisible(task.id, idWidth).padEnd(idWidth);
        const agent = agentWidth > 2 ? truncateVisible(agentLabel(task.agent, state?.attempts[state.attempts.length - 1]?.usage?.model ?? task.model), agentWidth).padEnd(agentWidth) : '';
        return (
          <Text key={task.id} wrap="truncate-end">
            {selected ? theme.paint(`${glyph('cursor')} `, 'accent') : '  '}
            <Text color={theme.stateColor(kind)}>{mark}</Text>{' '}
            {selected && focused ? theme.paint(id, 'selection') : id}
            {agent ? theme.paint(` ${agent}`, 'agent') : ''}
            {badgeWidth ? ' ' : ''}
            {badgeWidth ? theme.paint(attentionBadge(state), 'warning') : ''}
            {theme.paint(shown.scrollbar[i] ?? '', 'border')}
          </Text>
        );
      })}
      {marker && <Text wrap="truncate-end">{theme.paint(`  ${slice.aboveMarker ?? ''}${slice.aboveMarker && slice.belowMarker ? '  ' : ''}${slice.belowMarker ?? ''}`, 'muted')}</Text>}
    </Box>
  );
}

export interface TaskStripProps {
  tasks: ResolvedTask[];
  run: WorkflowRun;
  cursor: number;
  columns: number;
  theme: Theme;
  focused: boolean;
  runningGlyph: string;
}

/** What the sidebar collapses to at 80x24: the selected task, where it sits in the list, and its state. */
export function TaskStrip({ tasks, run, cursor, columns, theme, focused, runningGlyph }: TaskStripProps): React.JSX.Element {
  const task = tasks[cursor];
  const state = task ? run.tasks[task.id] : undefined;
  const kind = state?.state ?? 'pending';
  const mark = kind === 'running' ? runningGlyph : stateGlyph(kind);
  const badge = attentionBadge(state).trim();
  const label = task ? `${mark} ${task.id}  ${STATE_LABEL[kind]}  ${agentLabel(task.agent, state?.attempts[state.attempts.length - 1]?.usage?.model ?? task.model)}${badge ? ` ${badge}` : ''}` : 'no tasks';
  const position = `${tasks.length ? cursor + 1 : 0}/${tasks.length}`;
  return (
    <Text wrap="truncate-end">
      {theme.paint(`Task ${position}`, focused ? 'selection' : 'muted')} {truncateVisible(label, Math.max(4, columns - position.length - 7))}
    </Text>
  );
}

/** The separator `footerHints` joins its cells with, and therefore the only place the line may be cut. */
export const HINT_GAP = '   ';

/**
 * Fit a footer line into `columns` by dropping whole cells, least important first.
 *
 * Two rules the old single-truncation footer broke. Cutting the string mid-cell produced `> resume fr…`,
 * which reads as an action whose name has been shortened rather than as a list that has run out of room —
 * and the cell it half-showed was still taking the space two whole ones would have. And the cell it always
 * reached first was the last one, which is `Q`: on a 120-column terminal an ended run's footer never said
 * how to leave. What is dropped instead is what `?` is for, and `? help` is one of the last cells to go.
 *
 * `cells` is in display order; `priority` is the order they are given up, least important first.
 */
export function fitCells(cells: readonly string[], priority: readonly number[], columns: number): string[] {
  const widths = cells.map(visibleLength);
  const width = (kept: ReadonlySet<number>): number => {
    let total = 0;
    for (const i of kept) total += widths[i]! + HINT_GAP.length;
    return Math.max(0, total - HINT_GAP.length);
  };
  const kept = new Set(cells.map((_, i) => i));
  for (const index of priority) {
    if (width(kept) <= columns || kept.size <= 1) break;
    kept.delete(index);
  }
  const out = cells.filter((_, i) => kept.has(i));
  // Not even the most important cell fits: show as much of it as there is room for rather than nothing.
  if (out.length === 1 && visibleLength(out[0]!) > columns) return [truncateVisible(out[0]!, Math.max(1, columns))];
  return out;
}

export interface FooterProps {
  hints: string;
  /**
   * The chords that work in every panel (`alwaysHintCells`), least important first. Kept apart from
   * `hints` because they are the last cells the footer gives up rather than the first.
   */
  always?: readonly string[];
  columns: number;
  theme: Theme;
  columnsShown: FooterColumn[];
  /** When the displayed snapshot was taken, for the freshness column. */
  snapshotAge: number;
  notice?: string | null;
}

/**
 * The footer: the keys of the focused panel, then the chords that always work, then the provider quota
 * chips, then how old the picture is. The chips are a placeholder until stage 3 reads a real quota; they
 * say so rather than showing a number nothing measured.
 *
 * `columnsShown` says which chips the terminal's *width* allows (`footerColumnsFor`); what is drawn also
 * has to leave room for the keys, so a chip is dropped here too when the line is full — in the same order,
 * freshness before quota.
 */
export function Footer({ hints, always, columns, theme, columnsShown, snapshotAge, notice }: FooterProps): React.JSX.Element {
  const hintCells = hints ? hints.split(HINT_GAP) : [];
  const alwaysCells = always ?? [];
  const chipCells: string[] = [];
  if (columnsShown.includes('quota')) chipCells.push('quota: stage 3');
  if (columnsShown.includes('freshness')) chipCells.push(`updated ${formatDurationShort(Math.max(0, snapshotAge))} ago`);

  const cells = [...hintCells, ...alwaysCells, ...chipCells];
  // Given up in this order: the freshness chip, then the quota chip, then the panel's keys from the right,
  // then the palette chord — and `? help` and the way out only if even they do not fit.
  const priority = [
    ...chipCells.map((_, i) => hintCells.length + alwaysCells.length + chipCells.length - 1 - i),
    ...hintCells.map((_, i) => hintCells.length - 1 - i),
    ...alwaysCells.map((_, i) => hintCells.length + i),
  ];
  const kept = fitCells(cells, priority, columns);
  return (
    <Box flexDirection="column">
      {notice ? <Text wrap="truncate-end">{theme.paint(notice, 'warning')}</Text> : null}
      <Text wrap="truncate-end">{theme.paint(kept.join(HINT_GAP), 'muted')}</Text>
    </Box>
  );
}

/** Whether anything in the run is still moving; the spinner runs at its fast rate only then. */
export function anyActive(run: WorkflowRun): boolean {
  return run.workflow.tasks.some((t) => ACTIVE_TASK_STATES.has(run.tasks[t.id]?.state ?? 'pending'));
}
