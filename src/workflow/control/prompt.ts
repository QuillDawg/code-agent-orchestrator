/**
 * What a `prompt` command means to a run (spec §3.5, §2.6, `[D23]`, `[D24]`, `[D26]`).
 *
 * This module owns the *record*: the `PromptDelivery` appended to an attempt, and the sentences a steer is
 * refused with. The mechanism lives behind `AttemptChannel` in the runners, and nothing here knows which
 * agent is on the other end — `transport` is the only thing a runner tells the orchestrator about itself.
 *
 * Mode selection across the whole §3.5 matrix (follow-ups, stop-and-continue) is not here yet: this stage
 * wires the transport half, and `steer` is the row that needs one.
 */
import { ACTIVE_TASK_STATES, TERMINAL_TASK_STATES } from 'code-agent-orchestrator-protocol';
import type { PromptDelivery, PromptDeliveryMode, TaskAttempt, TaskRunState } from 'code-agent-orchestrator-protocol';
import type { SteerResult } from '../../runners/task-runner.js';
import { ulid } from '../../util/ulid.js';
import { nowIso } from '../../util/misc.js';

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
  if (state.state === 'success' || state.state === 'skipped') {
    return `Task "${state.id}" finished as ${state.state} and is immutable. Add a task or start a new run to take this further.`;
  }
  if (state.state === 'pending' || state.state === 'ready') {
    return `Task "${state.id}" has not started, so there is no session to steer. Edit its prompt instead with "cao task edit ${state.id}".`;
  }
  if (TERMINAL_TASK_STATES.has(state.state)) {
    return `Task "${state.id}" finished as ${state.state}, so there is no live session to steer. Send it a follow-up instead, which starts a new attempt.`;
  }
  if (state.state === 'waiting') {
    return `Task "${state.id}" is waiting on you. Answer the pending request first; a prompt and an answer are not the same thing.`;
  }
  if (!ACTIVE_TASK_STATES.has(state.state)) {
    return `Task "${state.id}" is ${state.state} and has no worker running, so there is nothing to steer.`;
  }
  if (!hasChannel) {
    return `The worker running "${state.id}" has no channel to steer through: this agent and transport cannot be spoken to mid-turn. Stop it and continue with the message instead.`;
  }
  return undefined;
}

/** The ack sentence for a delivery, in the state the transport left it. */
export function deliveryReason(taskId: string, delivery: PromptDelivery): string {
  const detail = delivery.reason ? ` ${delivery.reason}` : '';
  switch (delivery.state) {
    case 'accepted':
      return `The message was delivered to "${taskId}".${detail}`;
    case 'queued':
      return `The message is queued for "${taskId}".${detail}`;
    case 'rejected':
      return `"${taskId}" refused the message.${detail}`;
    case 'failed':
      return `The message did not reach "${taskId}".${detail}`;
    case 'delivered':
      return `The message was carried into "${taskId}".${detail}`;
  }
}
