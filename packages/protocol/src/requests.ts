/**
 * `.orchestrator/runs/<run-id>/requests/<ULID>-<kind>.json` — the request inbox. Spec §4.3.1.
 *
 * `stop.json` generalized: same directory, same polling watcher, same platform reasoning. ULID file-name
 * prefixes sort by time, so a lexicographic `readdir` is request order (§4.3.2).
 */
import type { InteractionAnswer } from './interaction.js';
import type { ProtocolVersion } from './protocol.js';

export const CONTROL_REQUEST_KINDS = ['stop', 'kill', 'approve', 'reject', 'answer', 'restart', 'edit', 'prompt'] as const;

/**
 * Closed on purpose, unlike the enums §4.5 leaves open: this is the *written* side of the wire, and the
 * orchestrator moves a request whose `kind` it does not know to `requests/rejected/` with a warning rather
 * than rendering it (§4.3.2). Nothing has to display an unknown kind.
 */
export type ControlRequestKind = (typeof CONTROL_REQUEST_KINDS)[number];

/**
 * How a follow-up reaches a worker (spec §3.5): `steer` interrupts the turn in progress, `followUp` waits
 * for it to finish, `stopAndContinue` ends the attempt and starts the next one carrying the text.
 *
 * Applied from S2; the shape is here so a sender can be built against it. Named for the delivery rather
 * than just "mode" because `src/runners/claude/` already has a prompt mode, and it means something else.
 */
export const PROMPT_DELIVERY_MODES = ['steer', 'followUp', 'stopAndContinue'] as const;
export type PromptDeliveryMode = (typeof PROMPT_DELIVERY_MODES)[number];

/** The fields an edit may change (spec §3.4), and the keys a `TaskRevision` records a before and after for. */
export const TASK_EDIT_FIELDS = ['prompt', 'agent', 'model', 'effort', 'timeout', 'retries', 'maxBudgetUsd'] as const;
export type TaskEditField = (typeof TASK_EDIT_FIELDS)[number];

/**
 * What an `edit` asks to change (spec §3.4). Every field is optional, and an edit that names none of them is
 * a no-op rather than a reset: absence means "leave it alone", which is what lets one screen send only the
 * field the operator touched.
 */
export interface TaskEdit {
  prompt?: string;
  agent?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  retries?: number;
  maxBudgetUsd?: number;
  note?: string;
}

/**
 * The state a sender believed the task was in when it built the request (spec §2.2). A command built on a
 * screen drawn some milliseconds ago is refused once the task has moved on, instead of being applied to work
 * nobody looked at.
 */
export interface ControlExpectation {
  attempt?: number;
  revision?: number;
}

export interface ControlRequest {
  protocol: ProtocolVersion;
  /** ULID; also the file-name prefix, which is what makes `readdir` order request order. */
  id: string;
  kind: ControlRequestKind;
  requestedAt: string;
  /** Free text, for the log line: e.g. `cao-desktop 0.1.0`. */
  source: string;
  pid: number;

  /**
   * `approve` | `reject` | `restart` | `answer` | `edit` | `prompt`, and `stop`, where naming a task means
   * "cancel this attempt" rather than "stop the run".
   */
  taskId?: string;
  /**
   * `answer` only: the interaction uid (§4.4.1), **opaque** — never parsed to recover a task id or an attempt
   * number. An answer names its interaction by uid and nothing else; the orchestrator does not accept the
   * runner's own request id, because that id is unique only per attempt and two concurrent workers collide.
   */
  uid?: string;
  /** `answer` only: an `InteractionAnswer` verbatim, so there is no second encoding to keep in step. */
  answer?: InteractionAnswer;
  /** `approve` | `reject`. */
  note?: string;
  /** `edit` only: the fields to change (§3.4). */
  changes?: TaskEdit;
  /** `edit` only: whether to restart the task once the edit is applied. */
  restart?: boolean;
  /** `prompt` only: the text to deliver, verbatim. */
  text?: string;
  /**
   * `prompt` only: how to deliver it. A `stop` request carries no mode — `stop.json` has never had one, and
   * a stop from another terminal has always meant the cancelling kind, as Ctrl+C does.
   */
  mode?: PromptDeliveryMode;
  /** Refuse the request if the task has moved on (§2.2). */
  expected?: ControlExpectation;
}

/** Where a control command came from. Spec §2.2; `TaskRevision` records it too (§2.6). */
export const CONTROL_SOURCES = ['tui', 'cli', 'inbox', 'desktop'] as const;
export type ControlSource = (typeof CONTROL_SOURCES)[number];

/**
 * What became of a command the run controller was given (spec §2.2).
 *
 * `accepted` and `applied` are not the same answer: `applied` means the run's state already reflects the
 * command when the ack is written, `accepted` means the controller has taken it and something else has to
 * finish first — a task in merge-back is cancelled once its finalization lands, not before.
 */
export const CONTROL_ACK_STATUSES = ['accepted', 'applied', 'rejected'] as const;
export type ControlAckStatus = (typeof CONTROL_ACK_STATUSES)[number];

/**
 * The answer to one control command: written to `requests/acks/<ULID>.json` when the command came from the
 * inbox (§2.3), returned directly when it came from this process.
 *
 * `reason` is a sentence an operator can act on, because it is the text the TUI shows as a notice and the
 * CLI prints before exiting 2 — never an error code and never the shape of the internal state that refused.
 */
export interface ControlAck {
  protocol: ProtocolVersion;
  /** The `id` of the command being answered; a duplicate id is answered with the first ack, verbatim. */
  id: string;
  status: ControlAckStatus;
  reason?: string;
  at: string;
}

/**
 * How many answered command ids a run remembers (spec §2.2). Deduplication has to outlive a retry of the
 * writer, not the whole run: an inbox request is deleted once acked, so the window only has to cover a
 * sender that resends, and a thousand of them is far more than a human-driven run ever produces.
 */
export const CONTROL_SEEN_LIMIT = 1000;
