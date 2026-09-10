/**
 * `.orchestrator/runs/<run-id>/interactions/<uid>.json` — what a worker is blocked on, in full. Spec §4.4.2.
 *
 * Written only when emit is on, when `handleInteraction` opens the request, and **deleted** the moment it is
 * answered, withdrawn or times out: a file that outlives its interaction is a stale prompt on someone's
 * screen. It exists because the run event log and `live.json` keep only a `toInteractionRecord` summary, so a
 * prompt built from those could say "Bash: npm publish" and not show the command (§4.4).
 */
import type { Interaction } from './interaction.js';
import type { ProtocolVersion } from './protocol.js';

export interface PendingInteractionFile {
  protocol: ProtocolVersion;
  /**
   * The run-unique handle the scheduler minted for this interaction, and the file's own name. Opaque,
   * filename-safe and case-folded (§4.4.1): it is never parsed to recover `taskId` or `attempt`, because task
   * ids may contain `.` and no delimiter is safe.
   */
  uid: string;
  taskId: string;
  attempt: number;
  /**
   * The runner's own request id, for correlation only. It is a string from a child process, unique only per
   * attempt, so it never addresses an interaction and never lands on a path segment (§4.4.1).
   */
  runnerRequestId: string;
  /** The full `Interaction`, through the `Redactor` with §11.3's named placeholders. */
  interaction: Interaction;
  /** `canAllowAlways(interaction)`, so a surface need not re-derive it. */
  canAllowAlways: boolean;
  /** How many values the Redactor removed; 0 means what you see is all of it. */
  redactions: number;
  /** `null` when `execution.interactionTimeout` is `never`. */
  expiresAt: string | null;
}
