/**
 * The Codex quota process and the footer chips (spec §3.6, §2.6, §7.2, `[D28]`–`[D31]`; §5 row 10).
 *
 * Nothing here spawns anything: the app-server is an injected `QuotaChannel` and time is an injected
 * `Clock`, so the five-minute cadence, a crash, a refused read and a reset can all be driven exactly and in
 * milliseconds. The wire format the channel fakes is checked against the real fake CLI in
 * `test/integration/quota.test.ts`, which is the half this cannot prove.
 */
import { describe, it, expect } from 'vitest';
import type { QuotaSnapshot } from 'code-agent-orchestrator-protocol';
import {
  CODEX_QUOTA_MINIMUM_VERSION,
  QUOTA_HANDSHAKE_TIMEOUT_MS,
  QUOTA_REFRESH_MS,
  SIGN_IN_FOR_QUOTAS,
  forwardCodexRateLimits,
  mergeRateLimits,
  quotaWindows,
  startCodexQuota,
  windowLabel,
  type QuotaChannel,
  type QuotaChannelHandlers,
} from '../../src/runners/codex/quota.js';
import { claudeQuotaSnapshot, startQuotaMonitors } from '../../src/runners/quota.js';
import { quotaChip, resetTime } from '../../src/tui/workspace/quota.js';
import type { Clock } from '../../src/util/misc.js';

function fakeClock(): Clock & { tick(ms: number): void; pending: number } {
  let now = Date.parse('2026-09-21T09:00:00.000Z');
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    tick(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/** One scripted app-server: what it was sent, what it answers, and whether it is still alive. */
function fakeServer() {
  let handlers: QuotaChannelHandlers | undefined;
  const sent: Sent[] = [];
  let stopped = false;
  let stdinClosed = false;
  let opens = 0;

  const channel: QuotaChannel = {
    send: (message) => {
      if (stopped) return false;
      sent.push(message as Sent);
      return true;
    },
    stop: () => {
      stdinClosed = true;
      stopped = true;
      handlers?.onExit();
    },
  };

  return {
    sent,
    get opens() {
      return opens;
    },
    get stopped() {
      return stopped;
    },
    get stdinClosed() {
      return stdinClosed;
    },
    open: (given: QuotaChannelHandlers): QuotaChannel => {
      opens += 1;
      stopped = false;
      handlers = given;
      return channel;
    },
    /** The id of the last request with this method, which is what an answer has to carry. */
    idOf(method: string): number {
      for (let i = sent.length - 1; i >= 0; i -= 1) if (sent[i]?.method === method) return sent[i]!.id!;
      throw new Error(`the client never sent ${method}; it sent ${sent.map((m) => m.method).join(', ')}`);
    },
    answer(message: Record<string, unknown>): void {
      handlers?.onMessage(message);
    },
    /** The process dies on its own: a crash, not a stop. */
    crash(): void {
      stopped = true;
      handlers?.onExit();
    },
  };
}

const found = (version: string) => async () => ({ command: 'codex', found: true, version });
const missing = async () => ({ command: 'codex', found: false, error: 'not on PATH' });

interface Harness {
  snapshots: QuotaSnapshot[];
  latest(): QuotaSnapshot;
  server: ReturnType<typeof fakeServer>;
  clock: ReturnType<typeof fakeClock>;
  monitor: ReturnType<typeof startCodexQuota>;
  settled(): Promise<void>;
}

function start(over: { detect?: () => Promise<{ command: string; found: boolean; version?: string }> } = {}): Harness {
  const clock = fakeClock();
  const server = fakeServer();
  const snapshots: QuotaSnapshot[] = [];
  const monitor = startCodexQuota({
    version: '0.1.0-test',
    clock,
    detect: over.detect ?? found('0.154.0'),
    open: server.open,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return {
    snapshots,
    latest: () => snapshots[snapshots.length - 1]!,
    server,
    clock,
    monitor,
    // The detection is a promise; one turn of the microtask queue is all it takes to settle.
    settled: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Bring a harness all the way to a first good reading. */
async function reading(harness: Harness, result: Record<string, unknown> = defaultLimits()): Promise<void> {
  await harness.settled();
  harness.server.answer({ id: harness.server.idOf('initialize'), result: { userAgent: 'fake' } });
  harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'chatgpt', planType: 'Pro' } } });
  harness.server.answer({ id: harness.server.idOf('account/rateLimits/read'), result });
}

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const defaultLimits = (usedPercent = 42) => ({
  rateLimits: {
    primary: { usedPercent, windowDurationMins: 300, resetsAt: unix('2026-09-21T14:05:00.000Z') },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: null },
    planType: 'Pro',
    limitId: 'default',
  },
});

describe('quota windows as the provider reports them (§3.6, [D30])', () => {
  it('labels a window from its duration: 5h, 7d, else Nm', () => {
    expect(windowLabel(300)).toBe('5h');
    expect(windowLabel(10080)).toBe('7d');
    expect(windowLabel(45)).toBe('45m');
    expect(windowLabel(1440)).toBe('1d');
    expect(windowLabel(null)).toBe('');
  });

  it('orders primary, secondary, then the limits beyond the default, and never invents one', () => {
    const windows = quotaWindows(
      { primary: { usedPercent: 42, windowDurationMins: 300 }, secondary: { usedPercent: 61, windowDurationMins: 10080 }, limitId: 'default' },
      {
        // Out of alphabetical order on purpose: the extras are sorted by limitId, and `default` is the
        // snapshot already drawn above rather than a third window.
        zeta: { primary: { usedPercent: 3, windowDurationMins: 60 } },
        default: { primary: { usedPercent: 42, windowDurationMins: 300 } },
        alpha: { primary: { usedPercent: 9, windowDurationMins: 30 } },
      },
    );
    expect(windows.map((w) => w.label)).toEqual(['5h', '7d', 'alpha 30m', 'zeta 1h']);
  });

  it('keeps a window the provider named without a duration, under the provider name', () => {
    expect(quotaWindows({ primary: { usedPercent: 12 } }).map((w) => w.label)).toEqual(['primary']);
  });

  it('drops nothing but a window that carries no percentage', () => {
    expect(quotaWindows({ primary: null, secondary: { usedPercent: 61, windowDurationMins: 10080 } }).map((w) => w.label)).toEqual(['7d']);
    expect(quotaWindows({ primary: { windowDurationMins: 300 } })).toEqual([]);
  });

  it('merges a sparse update into the last read rather than replacing it', () => {
    const previous = { primary: { usedPercent: 42, windowDurationMins: 300 }, secondary: { usedPercent: 61, windowDurationMins: 10080 } };
    const merged = mergeRateLimits(previous, { primary: { usedPercent: 77, windowDurationMins: 300 } });
    expect(merged?.primary).toEqual({ usedPercent: 77, windowDurationMins: 300 });
    expect(merged?.secondary).toEqual({ usedPercent: 61, windowDurationMins: 10080 });
    // An explicit null is the server saying the window is gone, which is not the same as saying nothing.
    expect(mergeRateLimits(previous, { secondary: null })?.secondary).toBeNull();
  });
});

describe('the Codex quota process (§3.6, [D28])', () => {
  it('handshakes, reads the account and the limits, and publishes a reading', async () => {
    const harness = start();
    expect(harness.snapshots[0]!.state).toBe('loading');
    await reading(harness);

    const initialize = harness.server.sent.find((m) => m.method === 'initialize')!;
    expect(initialize.params).toEqual({ clientInfo: { name: 'cao', version: '0.1.0-test' } });
    // No `experimentalApi`: this client asks for nothing beyond the two account reads.
    expect(JSON.stringify(initialize.params)).not.toContain('experimentalApi');
    expect(harness.server.sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
    // No thread is started and no turn: the reads are account-scoped and non-billable (§7.2).
    expect(harness.server.sent.some((m) => String(m.method).startsWith('thread/') || String(m.method).startsWith('turn/'))).toBe(false);

    const snapshot = harness.latest();
    expect(snapshot.state).toBe('ok');
    expect(snapshot.provider).toBe('codex');
    expect(snapshot.planType).toBe('Pro');
    expect(snapshot.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5h', 42],
      ['7d', 61],
    ]);
    expect(snapshot.windows[0]!.resetsAt).toBe('2026-09-21T14:05:00.000Z');
    harness.monitor.stop();
  });

  it('re-reads every five minutes and not before', async () => {
    const harness = start();
    await reading(harness);
    const after = harness.server.sent.filter((m) => m.method === 'account/rateLimits/read').length;

    harness.clock.tick(QUOTA_REFRESH_MS - 1000);
    expect(harness.server.sent.filter((m) => m.method === 'account/rateLimits/read')).toHaveLength(after);
    harness.clock.tick(1000);
    expect(harness.server.sent.filter((m) => m.method === 'account/rateLimits/read')).toHaveLength(after + 1);
    harness.clock.tick(QUOTA_REFRESH_MS);
    expect(harness.server.sent.filter((m) => m.method === 'account/rateLimits/read')).toHaveLength(after + 2);
    harness.monitor.stop();
  });

  it('shows the reset window afresh once resetsAt has passed and the next read lands', async () => {
    const harness = start();
    await reading(harness);
    expect(harness.latest().windows[0]!.usedPercent).toBe(42);

    // Past 14:05, the moment the five-hour window rolls over. The chip does not guess: it is the *read*
    // after the reset that brings the new number, which is why the cadence matters at all.
    harness.clock.tick(QUOTA_REFRESH_MS);
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'chatgpt', planType: 'Pro' } } });
    harness.server.answer({
      id: harness.server.idOf('account/rateLimits/read'),
      result: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: unix('2026-09-21T19:05:00.000Z') }, planType: 'Pro' } },
    });
    expect(harness.latest().state).toBe('ok');
    expect(harness.latest().windows.map((w) => [w.label, w.usedPercent])).toEqual([['5h', 0]]);
    harness.monitor.stop();
  });

  it('merges an account/rateLimits/updated notification into the last read', async () => {
    const harness = start();
    await reading(harness);
    harness.server.answer({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 77, windowDurationMins: 300 } } } });

    const snapshot = harness.latest();
    expect(snapshot.state).toBe('ok');
    // The sparse update moved the five-hour window and left the weekly one exactly where it was.
    expect(snapshot.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5h', 77],
      ['7d', 61],
    ]);
    harness.monitor.stop();
  });

  it('takes an update an attempt process forwarded, without a read of its own', async () => {
    const harness = start();
    await reading(harness);
    const reads = harness.server.sent.filter((m) => m.method === 'account/rateLimits/read').length;

    forwardCodexRateLimits({ primary: { usedPercent: 88, windowDurationMins: 300 } });
    expect(harness.latest().windows[0]!.usedPercent).toBe(88);
    expect(harness.server.sent.filter((m) => m.method === 'account/rateLimits/read')).toHaveLength(reads);

    // And the forwarding stops with the monitor: a stopped workspace has no footer to fill.
    harness.monitor.stop();
    const last = harness.snapshots.length;
    forwardCodexRateLimits({ primary: { usedPercent: 99, windowDurationMins: 300 } });
    expect(harness.snapshots).toHaveLength(last);
  });

  it('renders whatever windows the server reports when the secondary is missing', async () => {
    const harness = start();
    await reading(harness, { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 }, secondary: null, planType: 'Pro' } });
    expect(harness.latest().windows.map((w) => w.label)).toEqual(['5h']);
    harness.monitor.stop();
  });

  it('keeps the last good reading as stale when a refresh fails, and never blanks it', async () => {
    const harness = start();
    await reading(harness);

    harness.clock.tick(QUOTA_REFRESH_MS);
    harness.server.answer({ id: harness.server.idOf('account/rateLimits/read'), error: { code: -32000, message: 'the backend is down' } });

    const snapshot = harness.latest();
    expect(snapshot.state).toBe('stale');
    expect(snapshot.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5h', 42],
      ['7d', 61],
    ]);
    // The age counts from the good reading, not from the failure that followed it.
    expect(snapshot.readAt).toBe(harness.snapshots.find((s) => s.state === 'ok')!.readAt);
    expect(snapshot.reason).toContain('the backend is down');
    harness.monitor.stop();
  });

  it('is error, not stale, when there has never been a reading to keep', async () => {
    const harness = start();
    await harness.settled();
    harness.server.answer({ id: harness.server.idOf('initialize'), result: {} });
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'chatgpt' } } });
    harness.server.answer({ id: harness.server.idOf('account/rateLimits/read'), error: { message: 'the backend is down' } });
    expect(harness.latest().state).toBe('error');
    expect(harness.latest().windows).toEqual([]);
    harness.monitor.stop();
  });

  it('is authRequired for an API-key login, and asks again only at the next interval', async () => {
    const harness = start();
    await harness.settled();
    harness.server.answer({ id: harness.server.idOf('initialize'), result: {} });
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'apiKey' } } });

    expect(harness.latest().state).toBe('authRequired');
    expect(harness.latest().reason).toBe(SIGN_IN_FOR_QUOTAS);

    const asked = harness.server.sent.filter((m) => m.method === 'account/read').length;
    harness.clock.tick(QUOTA_REFRESH_MS - 1);
    expect(harness.server.sent.filter((m) => m.method === 'account/read')).toHaveLength(asked);
    harness.clock.tick(1);
    expect(harness.server.sent.filter((m) => m.method === 'account/read')).toHaveLength(asked + 1);
    harness.monitor.stop();
  });

  /**
   * The two reads are sent together, so their answers race. An `account/read` that says the account cannot
   * read quotas has to win: the chip used to say "sign in with ChatGPT for quotas" and then, when the
   * limits answer landed a moment later, show a percentage instead.
   */
  it('keeps authRequired when a rate-limit answer arrives after it', async () => {
    const harness = start();
    await harness.settled();
    harness.server.answer({ id: harness.server.idOf('initialize'), result: {} });
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'apiKey' } } });
    expect(harness.latest().state).toBe('authRequired');
    harness.server.answer({
      id: harness.server.idOf('account/rateLimits/read'),
      result: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000 }, planType: 'Pro' } },
    });
    expect(harness.latest().state).toBe('authRequired');
    expect(harness.latest().windows).toEqual([]);
    // An update forwarded from an attempt's own app-server must not talk the chip round either.
    forwardCodexRateLimits({ primary: { usedPercent: 43, windowDurationMins: 300, resetsAt: 1790000000 } });
    expect(harness.latest().state).toBe('authRequired');

    // Signing in is picked up by the next round: the verdict is per read, not for the life of the process.
    harness.clock.tick(QUOTA_REFRESH_MS);
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'chatgpt', planType: 'Pro' } } });
    harness.server.answer({
      id: harness.server.idOf('account/rateLimits/read'),
      result: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000 }, planType: 'Pro' } },
    });
    expect(harness.latest().state).toBe('ok');
    expect(harness.latest().windows).toHaveLength(1);
    harness.monitor.stop();
  });

  /**
   * The other half of the same race, on the failure side. `publishReading` learned to respect the account
   * read's verdict; a failure did not, so the process exiting — or any rate-limit error whose wording is
   * not the auth one — published `error` or `stale` over "sign in with ChatGPT for quotas".
   */
  it('keeps authRequired when the quota process exits under it', async () => {
    const harness = start();
    await harness.settled();
    harness.server.answer({ id: harness.server.idOf('initialize'), result: {} });
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'apiKey' } } });
    expect(harness.latest().state).toBe('authRequired');

    harness.server.crash();
    expect(harness.latest().state).toBe('authRequired');
    expect(harness.latest().reason).toBe(SIGN_IN_FOR_QUOTAS);

    // And a limits error that is *not* the auth message does not talk it round either.
    const other = start();
    await other.settled();
    other.server.answer({ id: other.server.idOf('initialize'), result: {} });
    other.server.answer({ id: other.server.idOf('account/read'), result: { account: { type: 'apiKey' } } });
    other.server.answer({ id: other.server.idOf('account/rateLimits/read'), error: { code: -32000, message: 'upstream is busy' } });
    expect(other.latest().state).toBe('authRequired');

    harness.monitor.stop();
    other.monitor.stop();
  });

  it('gives up on a handshake nobody answers rather than loading for ever', async () => {
    const harness = start();
    await harness.settled();
    expect(harness.latest().state).toBe('loading');
    expect(harness.server.sent.filter((m) => m.method === 'initialize')).toHaveLength(1);
    // The pipe opened and the server said nothing. Neither the five-minute timer nor `R` acts on a channel
    // that is open but not ready, so without a timeout the chip loads for the life of the workspace.
    harness.clock.tick(QUOTA_HANDSHAKE_TIMEOUT_MS - 1);
    expect(harness.latest().state).toBe('loading');

    harness.clock.tick(1);
    expect(harness.latest().state).toBe('error');
    expect(harness.latest().reason).toContain('handshake');
    expect(harness.server.stopped).toBe(true);

    // And the next five-minute read starts one again, exactly as a crash would.
    harness.clock.tick(QUOTA_REFRESH_MS);
    expect(harness.server.opens).toBe(2);
    harness.monitor.stop();
  });

  it('is authRequired when the server refuses the read itself', async () => {
    const harness = start();
    await harness.settled();
    harness.server.answer({ id: harness.server.idOf('initialize'), result: {} });
    harness.server.answer({ id: harness.server.idOf('account/read'), result: { account: { type: 'chatgpt', planType: 'Pro' } } });
    harness.server.answer({
      id: harness.server.idOf('account/rateLimits/read'),
      error: { code: -32600, message: 'chatgpt authentication required to read rate limits' },
    });
    expect(harness.latest().state).toBe('authRequired');
    expect(harness.latest().reason).toBe(SIGN_IN_FOR_QUOTAS);
    harness.monitor.stop();
  });

  it('is unavailable below the version floor, and spawns nothing', async () => {
    const harness = start({ detect: found('0.47.9') });
    await harness.settled();
    expect(harness.latest().state).toBe('unavailable');
    expect(harness.latest().reason).toContain(CODEX_QUOTA_MINIMUM_VERSION);
    expect(harness.server.opens).toBe(0);
    expect(harness.clock.pending).toBe(0);
    harness.monitor.stop();
  });

  it('is unavailable when the Codex CLI is not installed, and spawns nothing', async () => {
    const harness = start({ detect: missing });
    await harness.settled();
    expect(harness.latest().state).toBe('unavailable');
    expect(harness.latest().reason).toContain('was not found');
    expect(harness.server.opens).toBe(0);
    expect(harness.clock.pending).toBe(0);
    harness.monitor.stop();
  });

  it('starts a crashed quota process again at most once per five minutes', async () => {
    const harness = start();
    await reading(harness);
    expect(harness.server.opens).toBe(1);

    harness.server.crash();
    expect(harness.latest().state).toBe('stale');
    expect(harness.latest().reason).toContain('exited');

    // Pressing R as often as you like does not turn a crash loop into a spawn loop.
    harness.monitor.refresh();
    harness.monitor.refresh();
    expect(harness.server.opens).toBe(1);

    harness.clock.tick(QUOTA_REFRESH_MS);
    expect(harness.server.opens).toBe(2);
    expect(harness.server.sent.filter((m) => m.method === 'initialize')).toHaveLength(2);
    harness.monitor.stop();
  });

  it('reads again on a manual refresh while the process is healthy', async () => {
    const harness = start();
    await reading(harness);
    const reads = harness.server.sent.filter((m) => m.method === 'account/rateLimits/read').length;
    harness.monitor.refresh();
    expect(harness.server.sent.filter((m) => m.method === 'account/rateLimits/read')).toHaveLength(reads + 1);
    harness.monitor.stop();
  });

  it('closes stdin, kills the process and drops the timer when the workspace unmounts', async () => {
    const harness = start();
    await reading(harness);
    expect(harness.clock.pending).toBe(1);

    harness.monitor.stop();
    expect(harness.server.stdinClosed).toBe(true);
    expect(harness.server.stopped).toBe(true);
    expect(harness.clock.pending).toBe(0);

    // Nothing is published, read or started after the stop, however long the terminal lives.
    const last = harness.snapshots.length;
    harness.clock.tick(QUOTA_REFRESH_MS * 10);
    expect(harness.snapshots).toHaveLength(last);
    expect(harness.server.opens).toBe(1);
    harness.monitor.stop();
  });
});

describe('the provider set (§3.6, [D29], [D31])', () => {
  it('publishes the Claude chip at once and makes no call for it', () => {
    const snapshots: QuotaSnapshot[] = [];
    const monitor = startQuotaMonitors({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      clock: fakeClock(),
      codex: () => ({ refresh: () => undefined, stop: () => undefined }),
    });
    expect(snapshots.map((s) => s.provider)).toEqual(['claude']);
    expect(snapshots[0]!.state).toBe('unavailable');
    expect(snapshots[0]!.reason).toBe('see /usage in Claude Code');
    expect(snapshots[0]!.windows).toEqual([]);
    monitor.stop();
  });

  it('gives the readers a timer that does not hold the process open [D31]', () => {
    let clock: Clock | undefined;
    const monitor = startQuotaMonitors({
      onSnapshot: () => undefined,
      codex: (options) => {
        clock = options.clock;
        return { refresh: () => undefined, stop: () => undefined };
      },
    });
    const handle = clock!.setTimeout(() => undefined, 60_000) as NodeJS.Timeout;
    // Unref'd: a five-minute refresh must never be the reason a finished run's process is still alive.
    expect(handle.hasRef()).toBe(false);
    clock!.clearTimeout(handle);
    monitor.stop();
  });

  it('passes refresh and stop through to every provider that has a process', () => {
    let refreshed = 0;
    let stopped = 0;
    const monitor = startQuotaMonitors({
      onSnapshot: () => undefined,
      clock: fakeClock(),
      codex: () => ({ refresh: () => (refreshed += 1), stop: () => (stopped += 1) }),
    });
    monitor.refresh();
    monitor.stop();
    expect([refreshed, stopped]).toEqual([1, 1]);
  });
});

describe('the footer chips (§3.6)', () => {
  const at = Date.parse('2026-09-21T09:10:00.000Z');
  const ok = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    protocol: 1,
    provider: 'codex',
    readAt: '2026-09-21T09:08:00.000Z',
    state: 'ok',
    planType: 'Pro',
    windows: [
      // Built from a *local* 14:05 rather than a UTC one: the reset is shown in the reader's own time
      // zone, so an expectation written in UTC would pass only on a machine that happens to be there.
      { label: '5h', durationMins: 300, usedPercent: 42, resetsAt: new Date(2026, 8, 21, 14, 5).toISOString() },
      { label: '7d', durationMins: 10080, usedPercent: 61, resetsAt: null },
    ],
    ...over,
  });

  it('shows the plan, every window the provider reported, and how old the reading is', () => {
    const chip = quotaChip(ok(), at);
    expect(chip).toBe('codex · Pro · 5h 42% · resets 14:05 · 7d 61% · ok · 2m ago');
  });

  /**
   * A weekly window resets at the same time of day a week from now, so a bare clock time reads as
   * "in a few minutes" when it means "next Monday". Real numbers off `codex app-server`: the 7d window
   * showed `resets 13:12` at 13:00.
   */
  it('says which day a reset is on when it is not today', () => {
    const noon = new Date(2026, 8, 21, 13, 0); // a Monday
    // Today: the clock time is the whole answer.
    expect(resetTime(new Date(2026, 8, 21, 18, 12).toISOString(), noon)).toBe('18:12');
    // Tomorrow and within the week: the weekday comes with it.
    expect(resetTime(new Date(2026, 8, 22, 13, 12).toISOString(), noon)).toBe('Tue 13:12');
    expect(resetTime(new Date(2026, 8, 26, 9, 5).toISOString(), noon)).toBe('Sat 09:05');
    // A week out, where a weekday would come round to the same one it started on: the date instead.
    expect(resetTime(new Date(2026, 8, 28, 13, 12).toISOString(), noon)).toBe('28 Sep');
    expect(resetTime('not a date', noon)).toBe('');

    const chip = quotaChip(
      ok({
        windows: [
          { label: '5h', durationMins: 300, usedPercent: 42, resetsAt: new Date(2026, 8, 21, 18, 12).toISOString() },
          { label: '7d', durationMins: 10080, usedPercent: 61, resetsAt: new Date(2026, 8, 28, 13, 12).toISOString() },
        ],
      }),
      noon.getTime(),
    );
    expect(chip).toContain('5h 42% · resets 18:12');
    expect(chip).toContain('7d 61% · resets 28 Sep');
  });

  it('keeps the numbers and says stale when the last refresh failed', () => {
    const chip = quotaChip(ok({ state: 'stale', readAt: '2026-09-20T21:10:00.000Z', reason: 'the backend is down' }), at);
    expect(chip).toContain('5h 42%');
    expect(chip).toContain('stale · 12h00m ago');
  });

  it('says what to do about an API-key login rather than naming the state', () => {
    const chip = quotaChip({ protocol: 1, provider: 'codex', readAt: '2026-09-21T09:10:00.000Z', state: 'authRequired', reason: SIGN_IN_FOR_QUOTAS, windows: [] }, at);
    expect(chip).toBe('codex · sign in with ChatGPT for quotas');
  });

  it('points Claude at the only place that knows [D29]', () => {
    expect(quotaChip(claudeQuotaSnapshot('2026-09-21T09:10:00.000Z'), at)).toBe('claude · unavailable · see /usage in Claude Code');
  });

  it('says loading before the first answer and error when there is nothing to keep', () => {
    expect(quotaChip({ protocol: 1, provider: 'codex', readAt: '2026-09-21T09:10:00.000Z', state: 'loading', windows: [] }, at)).toBe('codex · loading');
    expect(quotaChip({ protocol: 1, provider: 'codex', readAt: '2026-09-21T09:10:00.000Z', state: 'error', reason: 'the backend is down', windows: [] }, at)).toBe(
      'codex · error · the backend is down',
    );
  });

  it('never renders a percentage cell for a provider that reported no window', () => {
    expect(quotaChip({ protocol: 1, provider: 'codex', readAt: '2026-09-21T09:10:00.000Z', state: 'unavailable', reason: 'not installed', windows: [] }, at)).not.toContain('%');
  });
});
