/**
 * What a `prompt` command means to a run (spec §3.5, §2.6, `[D23]`, `[D24]`, `[D26]`).
 *
 * This module owns the *record*: the `PromptDelivery` appended to an attempt, and the sentences a steer is
 * refused with. The mechanism lives behind `AttemptChannel` in the runners, and nothing here knows which
 * agent is on the other end — `transport` is the only thing a runner tells the orchestrator about itself.
 *
 * Mode selection across the whole §3.5 matrix lives here too (`promptRow`): one table, read by the CLI when
 * no mode flag was given, by the composer's header, and by the scheduler when a mode was named and the row
 * does not offer it.
 */
import { ACTIVE_TASK_STATES, TERMINAL_TASK_STATES } from 'code-agent-orchestrator-protocol';
import type { ControlSource, PromptDelivery, PromptDeliveryMode, TaskAttempt, TaskRunState, TaskState } from 'code-agent-orchestrator-protocol';
import type { SteerResult } from '../../runners/task-runner.js';
import { ulid } from '../../util/ulid.js';
import { nowIso } from '../../util/misc.js';

/**
 * The states a follow-up may be sent to (§3.5).
 *
 * `interrupted` is not among them because it is not a task state: a run interrupted by Ctrl+C lands its
 * tasks as `cancelled`, which is.
 */
export const FOLLOW_UP_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['failed', 'blocked', 'cancelled', 'needs_input', 'suspended']);

/** How a follow-up reached (or failed to reach) a worker, with no live channel as an honest answer. */
export const NO_TRANSPORT = 'none' satisfies PromptDelivery['transport'];

export interface DeliveryOrigin {
  source: PromptDelivery['source'];
  mode: PromptDeliveryMode;
  text: string;
}

/**
 * A delivery in its opening state, `queued`, with an id the transport quotes back on every later update.
 *
 * `queued` before anything has been attempted, deliberately: the id has to exist before the message is sent,
 * or an acknowledgment that arrives during the send has nothing to attach itself to.
 */
export function newDelivery(origin: DeliveryOrigin): PromptDelivery {
  return { id: ulid(), at: nowIso(), source: origin.source, mode: origin.mode, transport: NO_TRANSPORT, state: 'queued', text: origin.text };
}

/** Fold a transport's answer into the delivery, in place — the record is one row that moves, not a log. */
export function applyDelivery(delivery: PromptDelivery, result: SteerResult): PromptDelivery {
  delivery.transport = result.transport;
  delivery.state = result.state;
  if (result.reason) delivery.reason = result.reason;
  else delete delivery.reason;
  if (result.turnId) delivery.turnId = result.turnId;
  return delivery;
}

/** Append a delivery to the attempt it was sent into. */
export function recordDelivery(attempt: TaskAttempt, delivery: PromptDelivery): PromptDelivery {
  (attempt.prompts ??= []).push(delivery);
  return delivery;
}

/** The delivery an update names, across every attempt of the task — an update can outlive its attempt's end. */
export function findDelivery(state: TaskRunState, id: string): { attempt: TaskAttempt; delivery: PromptDelivery } | undefined {
  for (const attempt of state.attempts) {
    const delivery = attempt.prompts?.find((p) => p.id === id);
    if (delivery) return { attempt, delivery };
  }
  return undefined;
}

/**
 * Why this task cannot be steered, in the row's own words (§3.5), or undefined when it can be tried.
 *
 * Only the states are judged here. Whether the attempt that *is* running has a live channel is the runner's
 * answer, not the scheduler's, and it comes back as `transport: 'none'`.
 */
export function steerRejection(state: TaskRunState, hasChannel: boolean): string | undefined {
  if (TERMINAL_TASK_STATES.has(state.state) && state.state !== 'success' && state.state !== 'skipped') {
    return `Task "${state.id}" finished as ${state.state}, so there is no live session to steer. Send it a follow-up instead, which starts a new attempt.`;
  }
  const row = promptRow(state, hasChannel);
  if (row.reason) return row.reason;
  if (row.mode === 'steer') return undefined;
  return selectPromptMode(state, { hasChannel, requested: 'steer' }).reason;
}

/**
 * What the §3.5 matrix offers for a task in this state, and why when it offers nothing.
 *
 * `hasChannel` is the runner's answer, not the scheduler's: whether the attempt that is running right now
 * has a live transport. A Claude deny-mode attempt and a `codex exec` attempt are both `running` with no
 * channel, which is the stop-and-continue row.
 */
export interface PromptRow {
  mode?: PromptDeliveryMode;
  /** Present exactly when `mode` is absent: the row's own sentence. */
  reason?: string;
}

export function promptRow(state: TaskRunState, hasChannel: boolean): PromptRow {
  if (state.state === 'success' || state.state === 'skipped') {
    return { reason: `Task "${state.id}" finished as ${state.state} and is immutable. Add a task or start a new run to take this further.` };
  }
  if (state.state === 'pending' || state.state === 'ready') {
    return { reason: `Task "${state.id}" has not started, so there is no session to speak to. Edit its prompt instead with "cao task edit ${state.id}".` };
  }
  if (state.state === 'waiting') {
    return { reason: `Task "${state.id}" is waiting on you. Answer the pending request first; a prompt and an answer are not the same thing.` };
  }
  if (state.state === 'awaiting_approval') {
    return { reason: `Task "${state.id}" is waiting for an approval decision, not for a prompt. Approve or reject it first.` };
  }
  if (ACTIVE_TASK_STATES.has(state.state)) return { mode: hasChannel ? 'steer' : 'stopAndContinue' };
  if (FOLLOW_UP_STATES.has(state.state)) return { mode: 'followUp' };
  return { reason: `Task "${state.id}" is ${state.state}, which is not a state a prompt can reach.` };
}

/** What each mode is called in a sentence an operator reads. */
export const MODE_LABEL: Record<PromptDeliveryMode, string> = {
  steer: 'steer',
  followUp: 'follow-up',
  stopAndContinue: 'stop and continue',
};

/** The flag that names each mode on the command line. */
const MODE_FLAG: Record<PromptDeliveryMode, string> = {
  steer: '--steer',
  followUp: '--follow-up',
  stopAndContinue: '--stop-and-continue',
};

/**
 * A refusal that points at another mode names the flag for it — but only where there is a command line.
 *
 * `cao task prompt` and a request file both come from something that typed flags, and naming the one to type
 * next is the whole of the answer. The composer has no flags: it chose the mode itself from the row it drew,
 * and it is refused only when the task moved between the frame and the submit. "Send it a follow-up instead
 * (--follow-up)" told that operator to type something that is not a thing they can type.
 */
export const namesFlags = (source?: ControlSource): boolean => source !== 'tui' && source !== 'desktop';

const instead = (mode: PromptDeliveryMode, flags: boolean): string => (flags ? `${MODE_LABEL[mode]} (${MODE_FLAG[mode]})` : MODE_LABEL[mode]);

/**
 * The mode to use, or the sentence to refuse with (§3.5).
 *
 * A caller that named no mode gets the row's. A caller that named one gets it only where the row agrees:
 * asking to steer a task that has already stopped is not a smaller version of a follow-up, it is a different
 * thing done to a different attempt, and doing it silently is how an operator loses a session they meant to
 * continue.
 */
export function selectPromptMode(state: TaskRunState, opts: { hasChannel: boolean; requested?: PromptDeliveryMode; source?: ControlSource }): PromptRow {
  const row = promptRow(state, opts.hasChannel);
  if (!opts.requested || !row.mode || row.mode === opts.requested) return row;
  const flags = namesFlags(opts.source);
  if (opts.requested === 'steer') {
    return {
      reason:
        state.state === 'running'
          ? `The worker running "${state.id}" has no channel to steer through: this agent and transport cannot be spoken to mid-turn. Send it as a ${instead('stopAndContinue', flags)} instead, which stops the worker and starts the task again with your message.`
          : `Task "${state.id}" is ${state.state}, so there is no live turn to steer. Send it a ${instead('followUp', flags)} instead, which starts a new attempt.`,
    };
  }
  if (opts.requested === 'stopAndContinue' && row.mode === 'followUp') {
    return { reason: `Task "${state.id}" is ${state.state} and has no worker to stop. Send it a ${instead('followUp', flags)} instead.` };
  }
  if (opts.requested === 'followUp' && (row.mode === 'steer' || row.mode === 'stopAndContinue')) {
    return {
      reason: `Task "${state.id}" is still running, so a follow-up has no attempt to start. Send it as a ${instead(row.mode, flags)} instead, or stop it first.`,
    };
  }
  return { reason: `Task "${state.id}" is ${state.state}; ${MODE_LABEL[opts.requested]} does not apply to it.` };
}

/**
 * The ack for a message that becomes the task's **next attempt** (§3.5): the follow-up and stop-and-continue
 * rows, from the run that takes it and from `cao task prompt` with nobody executing the run.
 *
 * One function for both, because they are one sentence an operator reads in two places and the offline one
 * had already drifted: it said "Continuing ..." where the live one said "Starting ... again", and it was the
 * only answer to a prompt that did not name the mode it had chosen.
 */
export function followUpAck(taskId: string, mode: PromptDeliveryMode, sessionId?: string): string {
  const continues = sessionId
    ? `Its next attempt continues session ${sessionId}.`
    : 'Its next attempt starts a fresh session with your message in the prompt.';
  return mode === 'stopAndContinue'
    ? `Stop and continue: stopping the worker of "${taskId}" and starting it again with your message. ${continues}`
    : `Follow-up: starting "${taskId}" again with your message. ${continues}`;
}

/** How each transport is named in a sentence an operator reads; `none` has no name because it is not one. */
export const TRANSPORT_LABEL: Record<PromptDelivery['transport'], string | undefined> = {
  'claude-stream': "Claude's open stdin",
  'codex-app-server': 'the Codex app-server',
  'codex-exec': 'a new codex exec session',
  none: undefined,
};

/**
 * The mode as a sentence opens with it, so every ack says which row of the matrix it used (§3.5).
 *
 * Separate from `MODE_LABEL`, which is the mid-sentence form the delivery list and the composer header use:
 * "stop and continue: ..." at the start of an ack and "  stop and continue  delivered" in a list are the
 * same fact written for two different places, and one string cannot be right in both.
 */
const MODE_LEAD: Record<PromptDeliveryMode, string> = {
  steer: 'Steer',
  followUp: 'Follow-up',
  stopAndContinue: 'Stop and continue',
};

/**
 * The ack sentence for a delivery, in the state the transport left it.
 *
 * It leads with the mode because the caller may not have chosen one: §3.5 lets `cao task prompt` be given a
 * message and nothing else, and "the message is queued" answers neither of the two questions an operator
 * then has — was it steered into the turn that is running, or did it stop the worker and start a new attempt.
 */
export function deliveryReason(taskId: string, delivery: PromptDelivery): string {
  const detail = delivery.reason ? ` ${delivery.reason}` : '';
  const lead = MODE_LEAD[delivery.mode];
  switch (delivery.state) {
    case 'accepted':
      return `${lead}: the message was delivered to "${taskId}".${detail}`;
    case 'queued':
      return `${lead}: the message is queued for "${taskId}" and starts a new turn when the current one ends.${detail}`;
    case 'rejected':
      return `${lead}: "${taskId}" refused the message.${detail}`;
    case 'failed':
      return `${lead}: the message did not reach "${taskId}".${detail}`;
    case 'delivered':
      return `${lead}: the message was carried into "${taskId}".${detail}`;
  }
}
