/**
 * The Diagnostics tab (spec §3.7): everything about *how* this run is executing, in one read-only list.
 *
 * Six questions, in the order an operator reaches them: which CLI is behind each agent and how a message
 * gets to it; what each task is actually configured to do, after every edit; which attempts were retried
 * and why; what the provider said when one failed; what has been asked of this run and what came back; and
 * what the providers say about the quota it is spending.
 *
 * It is a list of lines rather than a set of boxes because it is read by scrolling: `diagnosticsLines` is a
 * pure function of the run, so every section can be asserted on without mounting anything, and the panel
 * below it is a window onto what that function returned.
 *
 * Nothing here mutates state. Not the run, not the inbox (`readControlHistory` is the read-only reader),
 * not a file.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { QuotaSnapshot, TaskAttempt, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { AgentReport } from '../../runners/diagnostics.js';
import type { ControlHistory } from '../../persistence/requests.js';
import { sanitizeText } from '../../cli/color.js';
import { truncateVisible } from '../../cli/util.js';
import { glyph } from '../../util/glyphs.js';
import { formatClock, formatDurationShort } from '../../util/duration.js';
import { formatTokens, agentLabel } from '../format.js';
import { quotaChip } from './quota.js';
import { TAB_LABEL, type ControlRecord } from '../store.js';
import type { Theme, ThemeToken } from '../theme.js';
import { windowOf } from '../window.js';

/** One line of the panel. `token` paints it; `bold` is a section heading. */
export interface DiagLine {
  text: string;
  token?: ThemeToken;
  bold?: boolean;
}

/** One `task.retrying` event of the run's `events.jsonl`, which is where the retry history is recorded. */
export interface RetryRecord {
  at?: string;
  taskId: string;
  nextAttempt: number;
  delayMs: number;
  resumeSession?: boolean;
  transient?: boolean;
  nudge?: boolean;
}

/** The `task.retrying` events out of a page of the run's `events.jsonl`, oldest first. */
export function parseRetryEvents(lines: readonly string[]): RetryRecord[] {
  const out: RetryRecord[] = [];
  for (const line of lines) {
    if (!line.includes('task.retrying')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const event = value as Record<string, unknown>;
    if (event.type !== 'task.retrying' || typeof event.taskId !== 'string') continue;
    out.push({
      ...(typeof event.ts === 'string' ? { at: event.ts } : {}),
      taskId: event.taskId,
      nextAttempt: Number(event.nextAttempt ?? 0),
      delayMs: Number(event.delayMs ?? 0),
      ...(event.resumeSession !== undefined ? { resumeSession: Boolean(event.resumeSession) } : {}),
      ...(event.transient !== undefined ? { transient: Boolean(event.transient) } : {}),
      ...(event.nudge !== undefined ? { nudge: Boolean(event.nudge) } : {}),
    });
  }
  return out;
}

export interface DiagnosticsInput {
  run: WorkflowRun;
  /** The controls this window sent (§2.3); the inbox holds the ones every other window sent. */
  controls: readonly ControlRecord[];
  quotas: readonly QuotaSnapshot[];
  /** The preflight facts; undefined while they are still being read. */
  agents?: readonly AgentReport[];
  /** `task.retrying` events; undefined while the run log is still being read. */
  retries?: readonly RetryRecord[];
  /** `requests/`, `requests/acks/` and `requests/rejected/`; undefined while they are being read. */
  inbox?: ControlHistory;
  now: number;
}

/** What each control outcome is called on screen, and how it is painted (§2.3). */
const CONTROL_STATUS: Record<ControlRecord['status'], { label: string; token: ThemeToken }> = {
  sent: { label: `sent${glyph('ellipsis')}`, token: 'muted' },
  accepted: { label: 'accepted', token: 'accent2' },
  applied: { label: 'applied', token: 'ok' },
  rejected: { label: 'rejected', token: 'danger' },
  timeout: { label: 'no answer yet', token: 'warn' },
};

/** One row of the control history: when, what was asked, and what came back. */
export function controlLine(record: ControlRecord): string {
  const status = CONTROL_STATUS[record.status];
  return `${formatClock(new Date(record.at).toISOString())}  ${record.label} ${glyph('arrow')} ${status.label}${record.reason ? `: ${record.reason}` : ''}`;
}

const clock = (at: string | undefined): string => (at ? formatClock(at) : '        ');
const yesNo = (value: boolean | undefined): string => (value === undefined ? '?' : value ? 'yes' : 'no');

/**
 * Every line of the panel, top to bottom.
 *
 * `undefined` for a section's data means "still reading", and says so; an empty array means "there is none",
 * and says *that*. The two look the same on screen only if you conflate them, and an operator who cannot
 * tell "no retries" from "the retries have not loaded" has learnt nothing from the panel.
 */
export function diagnosticsLines(input: DiagnosticsInput): DiagLine[] {
  const { run } = input;
  const out: DiagLine[] = [];
  const head = (title: string): void => {
    if (out.length) out.push({ text: ' ' });
    out.push({ text: title, bold: true });
  };
  const note = (text: string): void => void out.push({ text: `  ${text}`, token: 'muted' });
  const row = (text: string, token?: ThemeToken): void => void out.push({ text: `  ${sanitizeText(text)}`, ...(token ? { token } : {}) });

  // ------------------------------------------------------------------ agents (transport and versions)
  head('Agents');
  if (!input.agents) note(`Reading the agent CLIs${glyph('ellipsis')}`);
  else if (!input.agents.length) note('This run uses no agent CLI.');
  else {
    for (const agent of input.agents) {
      const version = agent.found ? (agent.version ?? 'an unreadable version') : 'not installed';
      const support = agent.found && agent.supportedVersion === false ? ` (below the minimum ${agent.minimumVersion ?? '?'})` : '';
      row(`${agent.agent}  ${version}${support}  ${agent.command}`, agent.found && agent.supportedVersion !== false ? undefined : 'danger');
      row(`  transport ${agent.transports.join(', ') || 'none'}   ${agent.tasks} task${agent.tasks === 1 ? '' : 's'}   authenticated ${yesNo(agent.authenticated)}`, 'muted');
      if (agent.capabilities.length) row(`  advertises ${agent.capabilities.join(', ')}`, 'muted');
      if (agent.error) row(`  ${agent.error}`, 'danger');
    }
  }

  // ------------------------------------------------------------------ effective configuration per task
  head('Effective configuration');
  for (const task of run.workflow.tasks) {
    const state = run.tasks[task.id];
    const revisions = state?.revisions ?? [];
    const latest = revisions[revisions.length - 1];
    // Every field is read defensively: a run directory written by an older `cao` is readable by design
    // (§2.7), and a panel that threw on a missing key would take the whole workspace with it.
    const budget = task.claude?.maxBudgetUsd;
    row(
      [
        task.id,
        agentLabel(task.agent, task.model),
        task.effort ? `effort ${task.effort}` : '',
        task.timeoutMs !== undefined ? `timeout ${formatDurationShort(task.timeoutMs)}` : '',
        task.retry ? `retries ${task.retry.attempts}` : '',
        budget !== undefined ? `budget $${budget}` : '',
        task.onFailure ? `onFailure ${task.onFailure}` : '',
        task.workspace ? `workspace ${task.workspace}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
    if (latest) {
      row(`  revision ${latest.number} ${glyph('dash')} ${latest.source} pid ${latest.pid} at ${clock(latest.at)}: ${Object.keys(latest.changes).join(', ') || 'no field'}`, 'accent2');
      if (latest.appliedToAttempt !== undefined) row(`  carried by attempt ${latest.appliedToAttempt}`, 'muted');
      else row('  not carried by an attempt yet', 'muted');
    }
  }

  // ------------------------------------------------------------------ retry history
  head('Retries');
  if (!input.retries) note(`Reading the run log${glyph('ellipsis')}`);
  else if (!input.retries.length) note('Nothing has been retried.');
  else {
    for (const retry of input.retries) {
      const why = [retry.transient ? 'transient failure' : '', retry.nudge ? 'nudge for a missing result' : '', retry.resumeSession ? 'resuming the session' : 'fresh session'].filter(Boolean).join(', ');
      row(`${clock(retry.at)}  ${retry.taskId} ${glyph('arrow')} attempt ${retry.nextAttempt} after ${formatDurationShort(retry.delayMs)}  ${why}`, 'warn');
    }
  }

  // ------------------------------------------------------------------ failure metadata (RunnerFailure)
  head('Failures');
  const failures = failedAttempts(run);
  if (!failures.length) note('No attempt has failed.');
  for (const { taskId, attempt } of failures) {
    row(`${taskId} attempt ${attempt.number}  ${attempt.outcome ?? 'unknown'}${attempt.exitCode === null || attempt.exitCode === undefined ? '' : `  exit ${attempt.exitCode}`}${attempt.signal ? `  signal ${attempt.signal}` : ''}`, 'danger');
    if (attempt.error) row(`  ${attempt.error}`, 'muted');
    const failure = attempt.failure;
    if (failure) {
      row(
        `  ${[
          `retryable ${yesNo(failure.retryable)}`,
          failure.providerCode ? `code ${failure.providerCode}` : '',
          failure.httpStatus !== undefined ? `http ${failure.httpStatus}` : '',
          failure.retryAfterMs !== undefined ? `retry after ${formatDurationShort(failure.retryAfterMs)}` : '',
          failure.requestId ? `request ${failure.requestId}` : '',
          failure.sessionId ? `session ${failure.sessionId}` : '',
          failure.partialWork ? 'partial work applied' : '',
        ]
          .filter(Boolean)
          .join('  ')}`,
        'muted',
      );
    }
  }

  // ------------------------------------------------------------------ control history
  head('Controls sent from this window');
  if (!input.controls.length) note('none yet');
  for (const record of input.controls) row(controlLine(record), CONTROL_STATUS[record.status].token);

  head('The request inbox');
  if (!input.inbox) note(`Reading requests/${glyph('ellipsis')}`);
  else {
    const { pending, acks, rejected } = input.inbox;
    if (!pending.length && !acks.length && !rejected.length) note('No request has ever been written for this run.');
    for (const request of pending) row(`${clock(request.requestedAt)}  ${request.kind}${request.taskId ? ` ${request.taskId}` : ''} from ${request.source ?? 'unknown'} ${glyph('arrow')} waiting`, 'warn');
    for (const ack of acks) row(`${clock(ack.at)}  ack ${ack.id} ${glyph('arrow')} ${ack.status}${ack.reason ? `: ${ack.reason}` : ''}`, ack.status === 'rejected' ? 'danger' : 'muted');
    for (const entry of rejected) row(`rejected ${entry.file.split(/[\\/]/).pop() ?? entry.file}${entry.reason ? `: ${entry.reason}` : ''}`, 'danger');
  }

  // ------------------------------------------------------------------ quota snapshots
  head('Provider quotas');
  if (!input.quotas.length) note('No provider has reported yet.');
  for (const snapshot of input.quotas) {
    row(quotaChip(snapshot, input.now));
    row(
      `  read at ${clock(snapshot.readAt)}${snapshot.estimated ? '  estimated from local session logs' : ''}${snapshot.planType ? `  plan ${snapshot.planType}` : ''}${snapshot.reason ? `  ${snapshot.reason}` : ''}`,
      'muted',
    );
    for (const window of snapshot.windows) {
      // A window whose limit is unknown reports what was spent. "0% used" and "we cannot know the limit"
      // must never look the same, which is the rule the whole quota module is written to.
      const used = window.usedPercent !== null ? `${window.usedPercent}% used` : `${formatTokens(window.usedTokens ?? 0)} tokens`;
      row(`  ${window.label}  ${used}${window.resetsAt ? `, resets ${formatClock(window.resetsAt)}` : ''}`, 'muted');
    }
  }
  return out;
}

/** Every attempt worth a line under Failures: one that did not succeed, or one the provider explained. */
function failedAttempts(run: WorkflowRun): Array<{ taskId: string; attempt: TaskAttempt }> {
  const out: Array<{ taskId: string; attempt: TaskAttempt }> = [];
  for (const task of run.workflow.tasks) {
    for (const attempt of run.tasks[task.id]?.attempts ?? []) {
      if (attempt.failure || (attempt.outcome && attempt.outcome !== 'success' && attempt.outcome !== 'skipped')) out.push({ taskId: task.id, attempt });
    }
  }
  return out;
}

export interface DiagnosticsPanelProps extends DiagnosticsInput {
  rows: number;
  columns: number;
  theme: Theme;
  /** Where the scroll is, as a line index. */
  cursor: number;
  focused: boolean;
}

export function DiagnosticsPanel({ rows, columns, theme, cursor, focused, ...input }: DiagnosticsPanelProps): React.JSX.Element {
  const lines = diagnosticsLines(input);
  const slice = windowOf(lines, cursor, Math.max(1, rows - 2), { anchor: cursor });
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold wrap="truncate-end">
        {TAB_LABEL.diagnostics}
      </Text>
      {slice.items.map((line, i) => (
        <Text key={i} bold={line.bold} wrap="truncate-end">
          {line.token ? theme.paint(truncateVisible(line.text, columns), line.token) : truncateVisible(line.text, columns)}
        </Text>
      ))}
      <Text wrap="truncate-end">
        {theme.paint(
          `${slice.aboveMarker ?? ''}${slice.aboveMarker && slice.belowMarker ? '  ' : ''}${slice.belowMarker ?? ''}${focused ? '' : '   Tab to scroll'}`,
          'muted',
        )}
      </Text>
    </Box>
  );
}
