/**
 * `.orchestrator/runs/<run-id>/requests/<ULID>-<kind>.json` — the request inbox. Spec §4.3.1.
 *
 * `stop.json` generalized: same directory, same polling watcher, same platform reasoning. ULID file-name
 * prefixes sort by time, so a lexicographic `readdir` is request order (§4.3.2).
 */
import type { InteractionAnswer } from './interaction.js';
import type { ProtocolVersion } from './protocol.js';

export const CONTROL_REQUEST_KINDS = ['stop', 'kill', 'approve', 'reject', 'answer', 'restart'] as const;

/**
 * Closed on purpose, unlike the enums §4.5 leaves open: this is the *written* side of the wire, and the
 * orchestrator moves a request whose `kind` it does not know to `requests/rejected/` with a warning rather
 * than rendering it (§4.3.2). Nothing has to display an unknown kind.
 */
export type ControlRequestKind = (typeof CONTROL_REQUEST_KINDS)[number];

export interface ControlRequest {
  protocol: ProtocolVersion;
  /** ULID; also the file-name prefix, which is what makes `readdir` order request order. */
  id: string;
  kind: ControlRequestKind;
  requestedAt: string;
  /** Free text, for the log line: e.g. `cao-desktop 0.1.0`. */
  source: string;
  pid: number;

  /** `approve` | `reject` | `restart` | `answer`. */
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
