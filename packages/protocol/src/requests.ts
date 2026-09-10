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
