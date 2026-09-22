/**
 * The Overview tab: the failure summary, the task table, and the selected task's detail (§3.1, §3.2).
 *
 * All three were separate screens before - the dashboard, `Enter`, and nothing at all for the failure - and
 * an operator had to remember which one answered which question. They are one panel now, in the order a run
 * is read in: what went wrong, what every task is doing, and everything about the one under the cursor.
 *
 * The panel is given a number of rows and never draws more of them. Each block gets a share and the detail
 * takes what is left, so the same tree fits an 80x24 terminal and fills a 120x40 one.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { type ResolvedTask, type TranscriptEntry, type WorkflowRun, ACTIVE_TASK_STATES } from 'code-agent-orchestrator-protocol';
import { STATE_LABEL, stateGlyph } from '../../workflow/states.js';
import { glyph, labelledRule } from '../../util/glyphs.js';
import { truncateVisible } from '../../cli/util.js';
import { agentLabel, contextRatio, formatCost, formatTokens } from '../format.js';
import { currentAttempt, elapsedParts } from '../history.js';
import { activityCell, ACTIVITY_LOOKBACK } from '../dashboard/activity.js';
import { taskFiles } from '../dashboard/files.js';
import type { Theme } from '../theme.js';
import { windowOf } from '../window.js';
import { detailLines, endedLines, failureLines, observerLines, type DetailLine, type EndedBlock, type ObserverBlock } from './detail.js';

export interface OverviewProps {
  run: WorkflowRun;
  /** The task list as the panel should show it: filtered by `/` when a search is on. */
  tasks: ResolvedTask[];
  cursor: number;
  now: number;
  columns: number;
  rows: number;
  theme: Theme;
  focused: boolean;
  runningGlyph: string;
  peek(taskId: string, entries?: number): TranscriptEntry[];
  /** Present once the run has ended: the outcome and the actions replace the live failure block (§2.4). */
  ended?: EndedBlock;
  /**
   * Present while another process owns the run (§2.1, [D37]): who owns it, what it is waiting on a human
   * for, and the controls that cross the boundary. Takes the lead block from `ended`, because an observed
   * run has not ended — it is being executed somewhere this window cannot reach.
   */
  observer?: ObserverBlock;
}

/**
 * Cut a block of lines to `rows` from the *middle*, not from the end.
 *
 * The detail reads head first - which task, what state, which agent - and ends with what the worker is
 * doing right now, and those are the two halves worth keeping. Cutting the tail instead throws away the
 * live transcript, which on a small terminal is the only part that changes.
 */
export function trimToRows(lines: DetailLine[], rows: number, marker: string): DetailLine[] {
  if (rows <= 0) return [];
  if (lines.length <= rows) return lines;
  if (rows === 1) return [{ text: marker, dim: true }];
  const head = Math.ceil((rows - 1) * 0.6);
  const tail = rows - 1 - head;
  // A tail that starts with a continuation starts with a note whose row was cut away with the middle, so
  // it reads as a sentence hanging under nothing. Drop those and let the block be a line shorter.
  let end = tail > 0 ? lines.slice(-tail) : [];
  while (end.length > 0 && end[0]!.continuation) end = end.slice(1);
  return [...lines.slice(0, head), { text: marker, dim: true }, ...end];
}

export function Overview(props: OverviewProps): React.JSX.Element {
  const { run, tasks, cursor, now, columns, rows, theme, focused, runningGlyph } = props;
  // The budget, in the order the blocks matter: the failure block leads, the table gets about half of what
  // is left, and the detail takes the rest. Every one of them is capped against the rows actually left, so
  // the panel adds up to `rows` on a terminal too small for all three rather than running past the bottom.
  const failure = (props.observer ? observerLines(run, theme, props.observer) : props.ended ? endedLines(run, theme, props.ended) : failureLines(run, theme, { selected: tasks[cursor]?.id })).slice(0, Math.max(0, rows - 1));
  // Three blocks used to be stacked with one blank line between the last two and no headings at all, which
  // is most of why this panel read as a slab. Each gets a labelled rule - but only where there are rows to
  // spend on one, and the detail's heading takes the place of the blank line rather than adding to it.
  const headings = rows >= 12;
  const tableHeadRows = headings ? 1 : 0;
  const afterFailure = Math.max(0, rows - failure.length - tableHeadRows);
  const tableRows = Math.min(tasks.length, Math.max(0, Math.min(afterFailure, Math.max(3, Math.floor(afterFailure / 2)))));
  const slice = windowOf(tasks, cursor, tableRows);
  const hidden = slice.above > 0 || slice.below > 0;
  const marker = hidden && failure.length + slice.items.length + 1 <= rows;
  const detailRows = Math.max(0, rows - failure.length - tableHeadRows - slice.items.length - (marker ? 1 : 0) - 1);

  const idWidth = Math.min(28, Math.max(12, ...tasks.map((t) => t.id.length)));
  const taskCell = (id: string): string => truncateVisible(id, idWidth).padEnd(idWidth);
  // The current attempt sits in parentheses after the total, and only a retried task has one. Padded to the
  // widest one on screen it is a column like any other; padded to nothing, one retried task shifts every
  // cell after it - agent, ctx, cost, files, activity - right on that row alone.
  const currentWidth = Math.max(0, ...slice.items.map((t) => elapsedParts(run.tasks[t.id]!, now).current).map((c) => (c ? c.length + 3 : 0)));

  const selected = tasks[cursor];
  const selectedState = selected ? run.tasks[selected.id] : undefined;
  let detail: DetailLine[] = [];
  if (selected && selectedState && detailRows > 0) {
    const lines = detailLines({
      task: selected,
      state: selectedState,
      run,
      now,
      columns,
      theme,
      entries: props.peek(selected.id, 8),
      // At least one line of transcript as soon as there is any room at all: on a small terminal what the
      // worker is doing right now is worth more than the last line of the interaction history.
      activityRows: Math.max(detailRows >= 8 ? 1 : 0, Math.min(10, detailRows - 14)),
      // The labelled rule above these lines already carries the id.
      title: !headings,
    });
    detail = trimToRows(lines, detailRows, `  ${glyph('ellipsis')} cao task ${selected.id} for the rest`);
  }

  return (
    <Box flexDirection="column" width={columns}>
      {failure.map((line, i) => (
        <Text key={`failure-${i}`} bold={line.bold} dimColor={line.dim} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
      {headings && <Text wrap="truncate-end">{theme.paint(labelledRule(`Tasks ${slice.start + 1}-${slice.end} of ${tasks.length}`, columns), 'border')}</Text>}
      {slice.items.map((task, i) => {
        const index = slice.start + i;
        const state = run.tasks[task.id]!;
        const attempt = currentAttempt(state);
        const usage = attempt?.usage ?? state.result?.usage;
        const mark = state.state === 'running' ? runningGlyph : state.state === 'waiting' ? '?' : stateGlyph(state.state);
        const files = taskFiles(state).length;
        const elapsed = elapsedParts(state, now);
        const ratio = contextRatio(usage);
        const ctx =
          usage?.contextTokens !== undefined && ACTIVE_TASK_STATES.has(state.state)
            ? theme.paint(`ctx ${formatTokens(usage.contextTokens)}${usage.contextWindow ? `/${formatTokens(usage.contextWindow)}` : ''}`, ratio !== undefined && ratio >= 0.9 ? 'danger' : ratio !== undefined && ratio >= 0.7 ? 'warn' : 'muted')
            : '';
        const cost = usage?.costUsd !== undefined ? theme.paint(formatCost(usage.costUsd), 'muted') : '';
        const activity = activityCell({
          task,
          state,
          entries: props.peek(task.id, ACTIVITY_LOOKBACK),
          startedAt: attempt?.startedAt,
          pendingDeps: state.state === 'pending' ? task.dependsOn.filter((d) => !['success', 'skipped'].includes(run.tasks[d]?.state ?? '')) : [],
          now,
          color: theme.color,
        });
        return (
          <Text key={task.id} wrap="truncate-end">
            {index === cursor ? theme.paint(`${glyph('cursor')} `, 'accent') : '  '}
            <Text color={theme.stateColor(state.state)}>{mark}</Text>{' '}
            {index === cursor && focused ? theme.paint(taskCell(task.id), 'selection') : taskCell(task.id)}{'  '}
            <Text color={theme.stateColor(state.state)}>{STATE_LABEL[state.state].padEnd(11)}</Text> {elapsed.total.padStart(9)}
            {currentWidth ? theme.paint((elapsed.current ? ` (${elapsed.current})` : '').padEnd(currentWidth), 'muted') : ''}
            {'  '}
            {theme.paint(agentLabel(task.agent, usage?.model ?? task.model), 'agent')}
            {ctx ? `  ${ctx}` : ''}
            {cost ? `  ${cost}` : ''}
            {files ? theme.paint(`  ${glyph('plusMinus')}${files}`, 'muted') : ''}
            {activity ? `  ${glyph('vrule')} ${activity}` : ''}
          </Text>
        );
      })}
      {marker && (
        <Text wrap="truncate-end">
          {theme.paint(`  ${glyph('ellipsis')} ${tasks.length} tasks, showing ${slice.start + 1}-${slice.end}`, 'muted')}
        </Text>
      )}
      {detail.length > 0 && (
        <Text wrap="truncate-end">{theme.paint(headings ? labelledRule(selected?.id ?? 'Task', columns) : ' ', 'border')}</Text>
      )}
      {detail.map((line, i) => (
        <Text key={`detail-${i}`} bold={line.bold} dimColor={line.dim} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
