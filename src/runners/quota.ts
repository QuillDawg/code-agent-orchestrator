/**
 * Every provider quota the footer can show, behind one runner-neutral handle (spec §3.6).
 *
 * The surfaces above this never name an agent: they start one thing, stop one thing, and draw whatever
 * `QuotaSnapshot`s arrive, under whatever labels the provider chose `[D30]`. Which providers exist, and
 * which of them can answer at all, is decided here.
 *
 * Nothing in this file runs unless a workspace mounts `[D31]`; a headless command never calls it.
 */
import type { QuotaSnapshot } from 'code-agent-orchestrator-protocol';
import { PROTOCOL_VERSION } from 'code-agent-orchestrator-protocol';
import { backgroundClock, nowIso, type Clock } from '../util/misc.js';
import { packageInfo } from '../util/package-info.js';
import { startCodexQuota, type CodexQuotaOptions, type QuotaMonitor } from './codex/quota.js';

export type { QuotaMonitor } from './codex/quota.js';

/** What the Claude chip says, always `[D29]`. */
export const CLAUDE_QUOTA_HINT = 'see /usage in Claude Code';

/**
 * Claude's chip `[D29]`.
 *
 * There is no documented programmatic read of the Pro/Max bars, and the undocumented OAuth usage endpoint
 * is a network call of `cao`'s own - which this beta does not make, not even behind a flag. So the chip is
 * a signpost to the one place that does know, rather than a number nothing measured.
 */
export function claudeQuotaSnapshot(readAt: string = nowIso()): QuotaSnapshot {
  return { protocol: PROTOCOL_VERSION, provider: 'claude', readAt, state: 'unavailable', reason: CLAUDE_QUOTA_HINT, windows: [] };
}

export interface QuotaMonitorsOptions {
  onSnapshot(snapshot: QuotaSnapshot): void;
  /** Defaults to `backgroundClock`, whose timers do not hold the process open (§3.6, `[D31]`). */
  clock?: Clock;
  cwd?: string;
  /** The orchestrator's version, sent as `clientInfo`; defaults to this package's. */
  version?: string;
  /** Injected by tests so no process is spawned. */
  codex?: (options: CodexQuotaOptions) => QuotaMonitor;
}

/**
 * Start every provider's quota reader. Returns at once; snapshots arrive through `onSnapshot`.
 *
 * `stop()` is what the workspace calls on unmount, and it has to reach all of them - a quota process left
 * behind is a `codex app-server` nobody owns for as long as the terminal lives.
 */
export function startQuotaMonitors(options: QuotaMonitorsOptions): QuotaMonitor {
  const clock = options.clock ?? backgroundClock;
  const start = options.codex ?? startCodexQuota;

  // Claude first and once: it is a fixed answer, so there is nothing to refresh and nothing to stop.
  options.onSnapshot(claudeQuotaSnapshot(nowIso()));

  const codex = start({
    version: options.version ?? packageInfo().version,
    clock,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    onSnapshot: (snapshot) => options.onSnapshot(snapshot),
  });

  return {
    refresh: () => codex.refresh(),
    stop: () => codex.stop(),
  };
}
