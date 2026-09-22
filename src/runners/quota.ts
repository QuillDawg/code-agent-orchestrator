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
import { startClaudeQuota, type ClaudeQuotaOptions } from './claude/quota.js';

export type { QuotaMonitor } from './codex/quota.js';

/** Where an operator finds the account's real bars, since nothing local records them `[D29]`. */
export const CLAUDE_QUOTA_HINT = 'see /usage in Claude Code';

/**
 * Claude's chip when there is nothing to estimate from `[D29]`.
 *
 * There is still no documented programmatic read of the Pro/Max bars, and the undocumented OAuth usage
 * endpoint is a network call of `cao`'s own, which this beta does not make. What `startClaudeQuota` does
 * instead is add up the transcripts the agent has already written; this is what is left when there are
 * none of those either, and it is a signpost rather than a number nothing measured.
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
  /** Injected by tests so no home directory is read. */
  claude?: (options: ClaudeQuotaOptions) => QuotaMonitor;
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
  const startClaude = options.claude ?? startClaudeQuota;

  const codex = start({
    version: options.version ?? packageInfo().version,
    clock,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    onSnapshot: (snapshot) => options.onSnapshot(snapshot),
  });

  // Claude used to be one fixed line published here and forgotten. It is a reader now, with a timer of its
  // own, so both of the calls below have to reach both of them: a five-minute timer nobody stops is quieter
  // than an orphaned app-server and lives exactly as long.
  const claude = startClaude({
    clock,
    onSnapshot: (snapshot) => options.onSnapshot(snapshot),
  });

  return {
    refresh: () => {
      codex.refresh();
      claude.refresh();
    },
    stop: () => {
      codex.stop();
      claude.stop();
    },
  };
}
