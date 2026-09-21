/**
 * What a provider says is left of a rate-limited window (spec §2.6, §3.6).
 *
 * A snapshot, never a budget: `cao` does not compute it, it repeats what the provider last told it and says
 * when that was. `state` carries the reason a number is missing, because "unavailable" and "0% left" look
 * the same to a footer that only has a percentage, and only one of them is worth waking someone for.
 *
 * Read from S3; the shape is here from S0 so a surface can be built against it.
 */
import type { ProtocolVersion } from './protocol.js';

export interface QuotaWindow {
  /** What the provider calls it: `5-hour`, `weekly`. Displayed as written, never parsed. */
  label: string;
  /** Null when the provider names a window without saying how long it is. */
  durationMins: number | null;
  usedPercent: number;
  /** Null when the provider does not say when the window rolls over. */
  resetsAt: string | null;
}

export interface QuotaSnapshot {
  protocol: ProtocolVersion;
  provider: 'codex' | 'claude';
  readAt: string;
  /**
   * `loading` is the state of a provider that is being asked right now and has never answered: §3.6 lists
   * it beside the rest, and a reader that had to represent "no snapshot at all" separately would have two
   * ways to say the same thing. Nothing persists a snapshot, so no file has ever carried the other five.
   */
  state: 'loading' | 'ok' | 'stale' | 'unavailable' | 'authRequired' | 'error';
  reason?: string;
  planType?: string;
  windows: QuotaWindow[];
}
