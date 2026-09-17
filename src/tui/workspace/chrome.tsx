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
  const elapsed = run.startedAt ? formatDuration(now - new Date(run.startedAt).getTime()) : '';
  const usage = addUsage(...run.workflow.tasks.flatMap((t) => run.tasks[t.id]?.attempts.map((a) => a.usage) ?? []));

  const width = narrow ? 10 : 20;
  const seg = (n: number): number => Math.round((n / Math.max(1, summary.total)) * width);
  const failed = summary.failed + summary.blocked + summary.cancelled;
  const used = seg(summary.success) + seg(failed) + seg(running + waiting);
  const full = glyph('barFull');
  const bar =
    theme.paint(full.repeat(seg(summary.success)), 'success') +
    theme.paint(full.repeat(seg(failed)), 'danger') +
    theme.paint(full.repeat(seg(running + waiting)), 'info') +
    theme.paint(glyph('barEmpty').repeat(Math.max(0, width - used)), 'muted');

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{run.workflowName}</Text>
        <Text dimColor>
          {'  '}run {run.runId} {'·'} {run.repositoryRoot}
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
  // 2 for the cursor column, 2 for the glyph and its space, 1 of gap, 1 for the badge, 1 for the scrollbar.
  // `claude|gpt-5-codex` is 13 columns after `shortModelName`; below that there is no room for an agent
  // column that says anything, so the task name takes it back rather than both being cut to nothing.
  const agentWidth = width >= 34 ? 13 : 0;
  const idWidth = Math.max(6, width - 7 - (agentWidth ? agentWidth + 1 : 0));

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
            {theme.paint(attentionBadge(state), 'warning')}
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
  const label = task ? `${mark} ${task.id}  ${STATE_LABEL[kind]}  ${agentLabel(task.agent, state?.attempts[state.attempts.length - 1]?.usage?.model ?? task.model)}${attentionBadge(state).trim()}` : 'no tasks';
  const position = `${tasks.length ? cursor + 1 : 0}/${tasks.length}`;
  return (
    <Text wrap="truncate-end">
      {theme.paint(`Task ${position}`, focused ? 'selection' : 'muted')} {truncateVisible(label, Math.max(4, columns - position.length - 7))}
    </Text>
  );
}

export interface FooterProps {
  hints: string;
  columns: number;
  theme: Theme;
  columnsShown: FooterColumn[];
  /** When the displayed snapshot was taken, for the freshness column. */
  snapshotAge: number;
  notice?: string | null;
}

/**
 * The footer: the keys of the focused panel, then the provider quota chips, then how old the picture is.
 * The chips are a placeholder until stage 3 reads a real quota; they say so rather than showing a number
 * nothing measured.
 */
export function Footer({ hints, columns, theme, columnsShown, snapshotAge, notice }: FooterProps): React.JSX.Element {
  const chips: string[] = [];
  if (columnsShown.includes('quota')) chips.push(theme.paint('quota: stage 3', 'muted'));
  if (columnsShown.includes('freshness')) chips.push(theme.paint(`updated ${formatDurationShort(Math.max(0, snapshotAge))} ago`, 'muted'));
  const right = chips.join('  ');
  const left = truncateVisible(hints, Math.max(4, columns - visibleLength(right) - 2));
  return (
    <Box flexDirection="column">
      {notice ? <Text wrap="truncate-end">{theme.paint(notice, 'warning')}</Text> : null}
      <Text wrap="truncate-end">
        {theme.paint(left, 'muted')}
        {right ? `  ${right}` : ''}
      </Text>
    </Box>
  );
}

/** Whether anything in the run is still moving; the spinner runs at its fast rate only then. */
export function anyActive(run: WorkflowRun): boolean {
  return run.workflow.tasks.some((t) => ACTIVE_TASK_STATES.has(run.tasks[t.id]?.state ?? 'pending'));
}
