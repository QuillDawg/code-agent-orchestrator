/**
 * Claude's footer chip (spec §3.6, `[D29]`), estimated from the transcripts Claude Code already writes.
 *
 * Deliberately the same shape as `startCodexQuota`: a factory that returns `{ refresh, stop }`, publishes
 * `loading` at once, re-reads on the same five-minute tick, and keeps the last good reading rather than
 * blanking it when a read fails. The two differ in one thing only — Codex is *told* its numbers by a server
 * and this counts its own — and that difference is carried by `estimated` on the snapshot rather than by
 * two different shapes on the surfaces above.
 *
 * **No network call.** `cao` still makes none of its own; this reads files the user's own agent wrote. That
 * is the distinction `[D29]` turns on, and it is why the decision can be honoured rather than reversed.
 *
 * **No percentage, ever.** Nothing local records the plan's limit — `~/.claude.json` has the tier's *name*
 * and no figure — so every window here has `usedPercent: null` and carries absolute tokens instead. A
 * percentage would have to be divided by a number nobody has.
 *
 * **No reset time.** The real five-hour window is anchored to the first message after the last one closed,
 * and the weekly one to something account-specific. Neither anchor is in any local file, so `resetsAt` is
 * null and the chip simply does not show one. A guessed reset is the most harmful thing this could print.
 */
import type { QuotaSnapshot, QuotaWindow } from 'code-agent-orchestrator-protocol';
import { PROTOCOL_VERSION } from 'code-agent-orchestrator-protocol';
import { backgroundClock, nowIso, type Clock } from '../../util/misc.js';
import { windowLabel } from '../codex/quota.js';
import type { QuotaMonitor } from '../codex/quota.js';
import { readClaudeUsage, type ClaudeUsageReading } from './usage-log.js';

/** The same cadence as Codex's reader: one number for both, so the footer ages at one rate. */
export const CLAUDE_QUOTA_REFRESH_MS = 5 * 60_000;

/** The windows this estimates, in minutes. Five hours and a week, the two Anthropic itself talks about. */
export const CLAUDE_WINDOW_MINUTES = [5 * 60, 7 * 24 * 60];

/** What the chip says when there are no transcripts to add up. Not an error: there is simply nothing yet. */
export const NO_LOCAL_LOGS = 'no local Claude Code sessions to estimate from';

export interface ClaudeQuotaOptions {
  onSnapshot(snapshot: QuotaSnapshot): void;
  /** Defaults to `backgroundClock`, whose timers do not hold the process open (§3.6, `[D31]`). */
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests so no real home directory is read. */
  read?: (windows: number[], now: number) => Promise<ClaudeUsageReading>;
}

function toWindows(reading: ClaudeUsageReading): QuotaWindow[] {
  return reading.windows
    .map((window) => ({
      label: windowLabel(Math.round(window.ms / 60_000)) || `${Math.round(window.ms / 60_000)}m`,
      durationMins: Math.round(window.ms / 60_000),
      // Counted, never divided: see the file comment.
      usedPercent: null,
      usedTokens: window.totalTokens,
      resetsAt: null,
    }))
    .sort((a, b) => (a.durationMins ?? 0) - (b.durationMins ?? 0));
}

/**
 * Start the reader. Returns at once; snapshots arrive through `onSnapshot`.
 *
 * The first read is deferred to a macrotask so mounting the workspace never waits on the filesystem, and
 * the five-hour window is published on its own before the weekly one is attempted: the narrow window costs
 * almost nothing and the wide one can be a quarter of a gigabyte, and two honest snapshots a few seconds
 * apart beat one after four seconds of `loading`.
 */
export function startClaudeQuota(options: ClaudeQuotaOptions): QuotaMonitor {
  const clock = options.clock ?? backgroundClock;
  const read = options.read ?? ((windows, now) => readClaudeUsage({ windows, now, env: options.env ?? process.env }));
  let timer: unknown;
  let stopped = false;
  let running = false;
  /** The last reading that produced numbers, kept so a failed refresh ages rather than blanks it. */
  let good: { snapshot: QuotaSnapshot } | undefined;

  const publish = (snapshot: QuotaSnapshot): void => {
    if (stopped) return;
    options.onSnapshot(snapshot);
  };

  const settle = (reading: ClaudeUsageReading, state: 'ok'): void => {
    const snapshot: QuotaSnapshot = {
      protocol: PROTOCOL_VERSION,
      provider: 'claude',
      readAt: nowIso(),
      state,
      estimated: true,
      windows: toWindows(reading),
    };
    good = { snapshot };
    publish(snapshot);
  };

  /** A read that failed, or a tree with nothing in it. A good reading is kept and aged rather than lost. */
  const degrade = (reason: string, kind: 'unavailable' | 'error'): void => {
    if (good) {
      publish({ ...good.snapshot, state: 'stale', reason });
      return;
    }
    publish({ protocol: PROTOCOL_VERSION, provider: 'claude', readAt: nowIso(), state: kind, reason, estimated: true, windows: [] });
  };

  const cycle = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const windows = CLAUDE_WINDOW_MINUTES.map((m) => m * 60_000).sort((a, b) => a - b);
      const now = clock.now();
      // The narrow window first and on its own: it is roughly fifty times cheaper than the wide one, and it
      // is the number somebody watching a run actually wants.
      const narrow = await read([windows[0]!], now);
      if (stopped) return;
      if (narrow.empty) {
        degrade(NO_LOCAL_LOGS, 'unavailable');
        return;
      }
      settle(narrow, 'ok');
      if (windows.length > 1) {
        const all = await read(windows, now);
        if (stopped || all.empty) return;
        settle(all, 'ok');
      }
    } catch (err) {
      degrade((err as Error).message, 'error');
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      void cycle().finally(schedule);
    }, CLAUDE_QUOTA_REFRESH_MS);
  };

  publish({ protocol: PROTOCOL_VERSION, provider: 'claude', readAt: nowIso(), state: 'loading', estimated: true, windows: [] });
  // Deferred, so mounting the workspace never waits on a filesystem walk.
  clock.setTimeout(() => {
    void cycle().finally(schedule);
  }, 0);

  return {
    refresh: () => {
      void cycle();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
