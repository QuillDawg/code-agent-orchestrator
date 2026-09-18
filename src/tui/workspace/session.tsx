/**
 * The Session panel (spec §3.5): everything about the task in front of you that is a conversation.
 *
 * Top to bottom, in the order the spec lists them: who is on the other end, what they have been saying,
 * what they are waiting on, what you have already sent them, and the composer to send the next thing. The
 * transcript is the existing renderer (`renderTranscript`), so the panel and `cao logs --follow` cannot
 * disagree about what a tool call looks like.
 *
 * Nothing here changes a run. The panel decides only what it would send — which mode of the §3.5 matrix
 * applies, and whether the composer is offered at all — and the shell submits it to the run controller.
 * The mode shown is computed by the same `promptRow` the scheduler decides with, so the header cannot
 * promise a steer the controller is about to refuse.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { PromptDelivery, ResolvedTask, TaskRunState, TranscriptEntry } from 'code-agent-orchestrator-protocol';
import { MODE_LABEL, promptRow, type PromptRow } from '../../workflow/control/prompt.js';
import { resumableSessionId } from '../../workflow/control/follow-up.js';
import { sanitizeText } from '../../cli/color.js';
import { truncateVisible } from '../../cli/util.js';
import { glyph } from '../../util/glyphs.js';
import { formatClock } from '../../util/duration.js';
import { renderTranscript } from '../transcript.js';
import { currentAttempt, deliveriesOf } from '../history.js';
import { windowOf } from '../window.js';
import { wrapPlain } from './detail.js';
import { composerRows, cursorRow, splitAtCursor, type ComposerState } from '../composer.js';
import type { Theme, ThemeToken } from '../theme.js';

/** The draft of the composer for one task; kept in the store so it survives a re-render and a resume. */
export const composerDraftKey = (taskId: string): string => `composer:${taskId}`;

/** How a delivery is painted, and what it is called on screen (§3.5). */
const DELIVERY_STATE: Record<PromptDelivery['state'], { label: string; token: ThemeToken }> = {
  queued: { label: `queued${glyph('ellipsis')}`, token: 'muted' },
  accepted: { label: 'accepted', token: 'success' },
  delivered: { label: 'delivered', token: 'success' },
  rejected: { label: 'rejected', token: 'danger' },
  failed: { label: 'failed', token: 'danger' },
};

/** One row of the delivery list: time, mode, state, reason, and the first line of what was said. */
export function deliveryLine(delivery: PromptDelivery, width: number): string {
  const first = sanitizeText(delivery.text).split('\n')[0] ?? '';
  const parts = [
    formatClock(delivery.at),
    MODE_LABEL[delivery.mode],
    DELIVERY_STATE[delivery.state].label,
    delivery.reason ? sanitizeText(delivery.reason) : first,
  ];
  return truncateVisible(parts.join('  '), width);
}

/**
 * The identity line: who this session is with, as the agent itself reported it (§3.5).
 *
 * The model is the attempt's reported one where there is one, because a task that asked for no model runs
 * whatever the CLI defaults to — and "(CLI default)" is the honest answer for a task that has not started
 * rather than a guess at what that default is.
 */
export function identityLine(task: ResolvedTask, state: TaskRunState): string {
  const attempt = currentAttempt(state) ?? state.attempts[state.attempts.length - 1];
  const session = attempt?.usage?.sessionId ?? attempt?.sessionId;
  const revisions = state.revisions?.length ?? 0;
  return [
    task.agent,
    attempt?.usage?.model ?? task.model ?? '(CLI default)',
    session ? `session ${session}` : 'no session yet',
    attempt ? `attempt ${attempt.number}` : 'not started',
    revisions ? `revision ${revisions}` : undefined,
  ]
    .filter((p): p is string => p !== undefined)
    .join('   ');
}

/**
 * What the composer's header says about the mode it would use (§3.5), or why there is no mode at all.
 *
 * The session id is in the follow-up line because it is the one fact that decides whether the next attempt
 * remembers anything, and an operator about to send a long message deserves to know which it will be.
 */
export function composerHeader(task: ResolvedTask, state: TaskRunState, row: PromptRow, freshSession = false): string {
  if (!row.mode) return row.reason ?? 'There is nothing to send this task.';
  switch (row.mode) {
    case 'steer':
      return `steer ${glyph('dash')} queued until the turn ends`;
    case 'followUp': {
      const session = freshSession ? undefined : resumableSessionId(task, state);
      return `follow-up ${glyph('dash')} ${session ? `resumes session ${session}` : 'starts a fresh session with your message in the prompt'}`;
    }
    case 'stopAndContinue':
      return `stop and continue ${glyph('dash')} its worker is stopped, then started again with your message`;
  }
}

/**
 * The "Start a fresh session" option under the header (§3.5, `[D25]`), or nothing where it would mean
 * nothing.
 *
 * Offered exactly where there is a session to *not* resume: a task whose next attempt would start fresh
 * anyway has nothing to choose, and a steer never starts an attempt at all. The line says which of the two
 * it is on, because "fresh session" with no state next to it is the kind of option an operator toggles
 * twice to find out what it was.
 */
export function freshSessionLine(task: ResolvedTask, state: TaskRunState, row: PromptRow, freshSession: boolean): string | undefined {
  if (row.mode !== 'followUp' && row.mode !== 'stopAndContinue') return undefined;
  if (!resumableSessionId(task, state)) return undefined;
  return `Ctrl+F  Start a fresh session: ${freshSession ? 'on, the next attempt starts from the top' : 'off, the next attempt continues where it left off'}`;
}

export interface SessionPanelProps {
  task: ResolvedTask | null;
  state: TaskRunState | null;
  entries: readonly TranscriptEntry[];
  /** Whether the attempt running right now has a live channel; false whenever nothing is running. */
  hasChannel: boolean;
  composer: ComposerState | null;
  /** Whether the composer is armed to start over rather than resume the session (`[D25]`). */
  freshSession?: boolean;
  /** True while the composer has the keys; false draws it as the line that says how to open it. */
  focused: boolean;
  /** Set while a submission is in flight or has just been answered (§3.5). */
  sending?: string;
  rows: number;
  columns: number;
  theme: Theme;
}

interface Line {
  text: string;
  token?: ThemeToken;
  bold?: boolean;
}

export function SessionPanel({ task, state, entries, hasChannel, composer, freshSession = false, focused, sending, rows, columns, theme }: SessionPanelProps): React.JSX.Element {
  const width = Math.max(24, columns);
  if (!task || !state) {
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="truncate-end">{theme.paint('Select a task to see its session.', 'muted')}</Text>
      </Box>
    );
  }

  const row = promptRow(state, hasChannel);
  const deliveries = deliveriesOf(state);
  const lines: Line[] = [];
  const push = (text: string, token?: ThemeToken, bold?: boolean): void => void lines.push({ text, token, bold });

  push(identityLine(task, state), 'muted');

  const pending = state.pendingInteraction;
  if (pending) {
    push(' ');
    push(`Waiting on you ${glyph('dash')} ${pending.kind}`, 'warning', true);
    for (const line of wrapPlain(sanitizeText(`${pending.toolName}: ${pending.title}`), width).slice(0, 3)) push(`  ${line}`, 'warning');
  }

  const deliveryRowCount = deliveries.length ? Math.min(deliveries.length, 4) + 1 : 0;
  const rendered = renderTranscript([...entries], { width, color: false, timestamps: width < 100 ? 'short' : true });

  // The transcript and the composer share whatever the fixed parts leave, and the transcript absorbs a small
  // terminal: it is the part with more to show than any panel can hold.
  //
  // A third of the panel is the composer's **floor**, not its ceiling. It used to be both, so a task whose
  // transcript was still empty showed seven lines of a thirty-line message above twelve blank rows — the
  // composer losing an argument it was not having. It takes what the transcript does not want, and gives it
  // straight back the moment there is output to read.
  const freshRows = focused && composer && freshSessionLine(task, state, row, freshSession) ? 1 : 0;
  const spare = Math.max(2, rows - lines.length - deliveryRowCount - freshRows - 4);
  const wanted = focused && composer ? Math.max(3, composerRows(composer).length) : 1;
  const share = Math.min(wanted, Math.max(3, Math.floor(rows / 3)));
  const composerRowCount = focused && composer ? Math.min(wanted, Math.max(share, spare - Math.max(1, rendered.length))) : 1;
  const transcriptRows = Math.max(1, spare - composerRowCount);

  push(' ');
  if (rendered.length === 0) push('No output from this task yet.', 'muted');
  for (const line of rendered.slice(-transcriptRows)) push(line);

  if (deliveries.length) {
    push(' ');
    push('Sent to this task', 'title', true);
    for (const delivery of deliveries.slice(-4)) push(`  ${deliveryLine(delivery, width - 2)}`, DELIVERY_STATE[delivery.state].token);
  }

  push(' ');
  push(composerHeader(task, state, row, freshSession), row.mode ? 'info' : 'muted', true);
  const fresh = freshSessionLine(task, state, row, freshSession);
  if (fresh && focused && composer) push(fresh, freshSession ? 'warning' : 'muted');
  if (sending) push(sanitizeText(sending), 'muted');

  if (!row.mode) {
    push('The composer is closed for this task.', 'muted');
  } else if (!focused || !composer) {
    push(`Enter opens the composer${deliveries.length ? '' : ' to send this task a message'}.`, 'muted');
  } else {
    const all = composerRows(composer);
    const slice = windowOf(all, cursorRow(composer), composerRowCount, { anchor: 0 });
    let line = 0;
    for (const [index, entry] of all.entries()) {
      const isCursor = composer.line >= line && composer.line < line + entry.covers;
      line += entry.covers;
      if (index < slice.start || index >= slice.start + slice.items.length) continue;
      if (entry.collapsed) {
        // The cursor can sit on a collapsed block — it does the instant after a paste — so the row says so
        // rather than leaving the caret nowhere on screen.
        push(`${isCursor ? glyph('cursor') : ' '} ${entry.text}`, isCursor ? 'selection' : 'muted');
        continue;
      }
      if (!isCursor) {
        push(`  ${truncateVisible(sanitizeText(entry.text), width - 2)}`);
        continue;
      }
      const { before, at, after } = splitAtCursor(composer);
      push(`${glyph('cursor')} ${truncateVisible(sanitizeText(`${before}${at === '' ? ' ' : at}${after}`), width - 2)}`, 'selection');
    }
  }

  const body = windowOf(lines, lines.length - 1, Math.max(1, rows - 1), { anchor: 0 });
  return (
    <Box flexDirection="column" width={width}>
      {body.items.map((l, i) => (
        <Text key={i} bold={l.bold} wrap="truncate-end">
          {l.token ? theme.paint(truncateVisible(l.text, width), l.token) : truncateVisible(l.text, width)}
        </Text>
      ))}
    </Box>
  );
}
