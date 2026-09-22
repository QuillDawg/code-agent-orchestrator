/**
 * What a provider says is left of a rate-limited window (spec §2.6, §3.6).
 *
 * Normally a snapshot rather than a budget: `cao` repeats what the provider last told it and says when
 * that was. `state` carries the reason a number is missing, because "unavailable" and "0% left" look the
 * same to a footer that only has a percentage, and only one of them is worth waking someone for.
 *
 * One provider cannot be asked at all, so its snapshot is `cao`'s own arithmetic over files the agent had
 * already written. That one carries `estimated` and says so on its chip; the flag is what keeps a counted
 * number and a reported one from ever being read as the same thing.
 *
 * Read from S3; the shape is here from S0 so a surface can be built against it.
 */
import type { ProtocolVersion } from './protocol.js';

export interface QuotaWindow {
  /** What the provider calls it: `5-hour`, `weekly`. Displayed as written, never parsed. */
  label: string;
  /** Null when the provider names a window without saying how long it is. */
  durationMins: number | null;
  /**
   * Null when the usage is known but the limit is not, which is not the same as zero.
   *
   * An estimate read from local files can count what was spent and can never know what it was spent
   * against: no local file records the plan's limit. A reader that answered "0%" there would report as
   * certain the one thing the operator most needs to be told is unknown.
   */
  usedPercent: number | null;
  /** Absolute usage, for a window that can be counted but not divided. */
  usedTokens?: number;
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
  /**
   * `cao` computed this rather than being told it.
   *
   * A flag and not a seventh `state`: the six states are about *whether a number exists*, and this is
   * about *where it came from* - a state would make "stale and estimated" inexpressible.
   */
  estimated?: boolean;
  windows: QuotaWindow[];
}
