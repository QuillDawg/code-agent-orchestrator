/**
 * The Codex quota process (spec §3.6, §7.2, `[D28]`, `[D31]`).
 *
 * One `codex app-server --stdio` per workspace **session**, never per attempt. It is handed no thread and
 * starts no turn: `account/read` and `account/rateLimits/read` are account-scoped backend reads, which is
 * the whole reason the footer may have numbers at all without costing anyone a token.
 *
 * Three things here are less obvious than they look:
 *
 * - **A failed read never blanks a good one.** The last reading is kept and re-published as `stale` with
 *   its original `readAt`, so the chip ages honestly instead of flicking to a blank. `error` is for the
 *   case where there has never been a reading to keep.
 * - **The server refuses API-key auth.** That is not an error, it is `authRequired`, and the chip says what
 *   to do about it. Nothing asks again before the next interval.
 * - **Updates arrive from elsewhere.** `account/rateLimits/updated` is emitted only during turns, which
 *   this process never runs - so the *attempt* app-servers forward theirs here (`forwardCodexRateLimits`)
 *   and a busy run refreshes faster than the timer.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { QuotaSnapshot, QuotaWindow } from 'code-agent-orchestrator-protocol';
import { PROTOCOL_VERSION } from 'code-agent-orchestrator-protocol';
import { nowIso, systemClock, type Clock } from '../../util/misc.js';
import { sanitizeText } from '../../util/text.js';
import { splitCommand } from '../claude/detect.js';
import { versionAtLeast, type AgentRuntimeDetection } from '../capabilities.js';
import { detectCodex } from './detect.js';

/** The first Codex CLI with `account/rateLimits/read`; below it the chip is `unavailable` (§3.6, §7.2). */
export const CODEX_QUOTA_MINIMUM_VERSION = '0.48.0';

/**
 * How often the quota is re-read, and therefore also the most often a crashed quota process is started
 * again. Five minutes is what §3.6 asks for; one number for both because a restart *is* the next read.
 */
export const QUOTA_REFRESH_MS = 5 * 60_000;

/**
 * How long the handshake may go unanswered before the process is treated as gone.
 *
 * Every other path here waits for a *ready* channel: the five-minute timer and `R` both do nothing while
 * one is open but has not answered `initialize`, so a server that accepts the pipe and then says nothing
 * left the chip on `loading` for the life of the workspace and only a process exit could recover it. Thirty
 * seconds is far longer than a local process needs to answer a method that reads nothing.
 */
export const QUOTA_HANDSHAKE_TIMEOUT_MS = 30_000;

/** What the app-server calls this client. Short on purpose: it appears in Codex's own logs. */
export const QUOTA_CLIENT_NAME = 'cao';

/** The message the server refuses a quota read with when the account is authenticated by API key (§7.2). */
const AUTH_REQUIRED_MESSAGE = 'authentication required';

/** What the chip says when the server will not answer without a ChatGPT login (§3.6). */
export const SIGN_IN_FOR_QUOTAS = 'sign in with ChatGPT for quotas';

/** One rate-limited window as the server reports it (§7.2, `RateLimitWindow`). */
export interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  /** Unix **seconds**, which is why it is converted rather than passed through. */
  resetsAt?: number | null;
}

/** §7.2, `RateLimitSnapshot`. Everything is optional: never assume which windows exist. */
export interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
  /** Which entry of `rateLimitsByLimitId` the snapshot above already is. */
  limitId?: string | null;
  [key: string]: unknown;
}

/** What `startCodexQuota` (and `startQuotaMonitors`) hands back: re-read on demand, and stop. */
export interface QuotaMonitor {
  /** Read again now: `R` in the footer and the palette action (§3.6). */
  refresh(): void;
  /** The workspace is unmounting: stop the timer, close stdin, kill the process. Safe to call twice. */
  stop(): void;
}

/**
 * The pipe to one app-server process.
 *
 * An interface rather than a `ChildProcess` so the whole state machine below can be driven from a test
 * without spawning anything - which is also what keeps `npm test` free of real Codex calls.
 */
export interface QuotaChannel {
  /** Send one message, newline-framed. False once the pipe has gone. */
  send(message: unknown): boolean;
  /** Close stdin (the server exits on EOF) and make sure the process is gone. Idempotent. */
  stop(): void;
}

export interface QuotaChannelHandlers {
  onMessage(message: Record<string, unknown>): void;
  /** The process is gone, for any reason - including `stop()`. */
  onExit(): void;
}

export type QuotaChannelFactory = (handlers: QuotaChannelHandlers) => QuotaChannel;

export interface CodexQuotaOptions {
  /** The Codex command line, as `codex.command` or `CAO_CODEX_COMMAND` gives it. */
  command?: string;
  /** The orchestrator's own version, for `clientInfo`. */
  version: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Every timer here goes through it, so a test can drive five minutes without waiting them. */
  clock?: Clock;
  /** Resolves the CLI. Injected so a test can put it below the floor or take it away. */
  detect?: (command: string) => Promise<AgentRuntimeDetection>;
  /** Opens the app-server. Injected so a test never spawns a process. */
  open?: QuotaChannelFactory;
  onSnapshot(snapshot: QuotaSnapshot): void;
}

// ---------------------------------------------------------------------------------------------- shapes

/**
 * How a window is labelled: `5h`, `7d`, else `Nm` (§3.6). Empty when the server named a window without
 * saying how long it is, and the caller then falls back to the name the server gave it.
 */
export function windowLabel(durationMins: number | null): string {
  if (durationMins === null || !Number.isFinite(durationMins) || durationMins <= 0) return '';
  if (durationMins % (24 * 60) === 0) return `${durationMins / (24 * 60)}d`;
  if (durationMins % 60 === 0) return `${durationMins / 60}h`;
  return `${durationMins}m`;
}

function toWindow(name: string, prefix: string, raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const window = raw as CodexRateLimitWindow;
  if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  const durationMins =
    typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null;
  const resetsAt =
    typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000).toISOString() : null;
  const label = [prefix, windowLabel(durationMins) || name].filter(Boolean).join(' ');
  return { label: sanitizeText(label), durationMins, usedPercent: window.usedPercent, resetsAt };
}

/**
 * The windows to draw, in the order §3.6 asks for: primary, secondary, then whatever `rateLimitsByLimitId`
 * adds beyond the one the default snapshot already is.
 *
 * Nothing here assumes a window exists. A server that reports only a primary produces one cell, and a
 * server that invents a third limit gets a cell under its own `limitId`.
 */
export function quotaWindows(
  rateLimits: CodexRateLimits | undefined,
  byLimitId?: Record<string, CodexRateLimits>,
): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  const push = (window: QuotaWindow | null): void => {
    if (window) out.push(window);
  };
  push(toWindow('primary', '', rateLimits?.primary));
  push(toWindow('secondary', '', rateLimits?.secondary));
  const already = typeof rateLimits?.limitId === 'string' ? rateLimits.limitId : undefined;
  for (const id of Object.keys(byLimitId ?? {}).sort()) {
    if (id === already) continue;
    const entry = byLimitId?.[id];
    push(toWindow('primary', id, entry?.primary));
    push(toWindow('secondary', id, entry?.secondary));
  }
  return out;
}

/**
 * Fold an `account/rateLimits/updated` into the last read (§7.2).
 *
 * The notification is **sparse**: it carries the windows that moved and says nothing about the rest, so a
 * replace would delete the weekly window every time the five-hour one ticked. A key that is explicitly
 * `null` does clear - that is the server saying the window is gone, not saying nothing.
 */
export function mergeRateLimits(previous: CodexRateLimits | undefined, update: unknown): CodexRateLimits | undefined {
  if (!update || typeof update !== 'object') return previous;
  const merged: CodexRateLimits = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

// --------------------------------------------------------------- updates forwarded from attempt processes

type RateLimitsListener = (rateLimits: unknown) => void;
const forwarders = new Set<RateLimitsListener>();

/**
 * An attempt's app-server saw an `account/rateLimits/updated` and passes it on (§3.6, `[D28]`).
 *
 * A module-level hand-off rather than a hook through the scheduler because the two ends are in the same
 * process and neither is about the run: the attempt learns something about the *account*, and the only
 * thing that wants it is the footer. Nothing subscribes in a headless run, so nothing happens there.
 */
export function forwardCodexRateLimits(rateLimits: unknown): void {
  for (const listener of [...forwarders]) listener(rateLimits);
}

/** Listen for those forwarded updates; the returned function stops listening. */
export function onCodexRateLimits(listener: RateLimitsListener): () => void {
  forwarders.add(listener);
  return () => {
    forwarders.delete(listener);
  };
}

// ------------------------------------------------------------------------------------------ the process

/** The default channel: a real `codex app-server --stdio`, framed as newline-delimited JSON (§7.2). */
export function spawnQuotaChannel(options: { command: string; cwd?: string; env?: Record<string, string> }): QuotaChannelFactory {
  return (handlers) => {
    const { file, args } = splitCommand(options.command);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, options.env ?? {});
    const child = spawn(file, [...args, 'app-server', '--stdio'], {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let gone = false;
    const done = (): void => {
      if (gone) return;
      gone = true;
      handlers.onExit();
    };
    child.on('error', done);
    child.on('exit', done);
    // Nothing reads stderr: a quota process has no transcript and no attempt directory to log into, and a
    // pipe nobody drains eventually blocks the child.
    child.stderr?.resume();
    if (child.stdout) {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        handlers.onMessage(message);
      });
    }
    return {
      send: (message) => {
        if (gone || !child.stdin?.writable) return false;
        return child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      stop: () => {
        // stdin first: the stdio server exits on EOF (§7.2), and a server that leaves by itself is a
        // server that has finished writing whatever it was in the middle of.
        try {
          child.stdin?.end();
        } catch {
          /* already gone */
        }
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        done();
      },
    };
  };
}

/**
 * Start reading the Codex quota. Returns at once; the first snapshot is `loading`.
 *
 * Every state the chip can show is published through `onSnapshot`, including the ones that mean "there
 * will never be a number here" - `unavailable` and `authRequired` are answers, and a footer that showed
 * nothing for them would look like a footer that was still loading.
 */
export function startCodexQuota(options: CodexQuotaOptions): QuotaMonitor {
  const clock = options.clock ?? systemClock;
  const command = options.command ?? process.env.CAO_CODEX_COMMAND ?? 'codex';
  const detect = options.detect ?? ((cmd: string) => detectCodex(cmd));
  const open = options.open ?? spawnQuotaChannel({ command, cwd: options.cwd, env: options.env });

  let stopped = false;
  /** False until the CLI has been found at or above the floor; nothing is spawned before it is true. */
  let usable = false;
  let channel: QuotaChannel | undefined;
  let ready = false;
  let nextId = 1;
  let initializeId = 0;
  let accountId = 0;
  let limitsId = 0;
  let timer: unknown;
  /** Armed while an `initialize` is outstanding; a server that never answers is a server that has gone. */
  let handshakeTimer: unknown;
  /** When the process last went away, so a restart happens at most once per interval (§3.6). */
  let crashedAt: number | undefined;
  let rateLimits: CodexRateLimits | undefined;
  let byLimitId: Record<string, CodexRateLimits> | undefined;
  let planType: string | undefined;
  /** When the kept reading was taken. It is what makes `stale · 12m ago` count from the right moment. */
  let readAt: string | undefined;
  /**
   * The account cannot read quotas: `account/read` said `apiKey`, or said there is no account at all.
   *
   * `account/read` and `account/rateLimits/read` are sent together, so their answers race. Without this the
   * limits answer published numbers *over* the `sign in with ChatGPT` sentence — a chip that told the
   * operator to sign in and then, a millisecond later, showed them a percentage. The verdict on whether
   * there is anything to show belongs to the account read; the limits read only supplies the numbers.
   * Cleared at the start of each round, so signing in is picked up by the next read.
   */
  let authBlocked = false;

  const publish = (snapshot: QuotaSnapshot): void => {
    if (!stopped) options.onSnapshot(snapshot);
  };
  const base = (state: QuotaSnapshot['state'], windows: QuotaWindow[], at: string): QuotaSnapshot => ({
    protocol: PROTOCOL_VERSION,
    provider: 'codex',
    readAt: at,
    state,
    windows,
    ...(planType ? { planType } : {}),
  });

  const publishReading = (): void => {
    if (authBlocked) return;
    const windows = quotaWindows(rateLimits, byLimitId);
    readAt = nowIso();
    publish(base('ok', windows, readAt));
  };

  /**
   * A read failed. Keep the last good one and age it; only a chip that never had one says `error`.
   *
   * Silent once the account read has settled `authRequired`, for the same reason `publishReading` is: the
   * verdict on whether there is anything to show belongs to the account read, and a failure arriving after
   * it — the process exiting, or a rate-limit error whose wording is not the auth one — would otherwise
   * publish `error` or `stale` over the one sentence that tells the operator what to do about it.
   */
  const degrade = (reason: string): void => {
    if (authBlocked) return;
    const windows = quotaWindows(rateLimits, byLimitId);
    const at = readAt ?? nowIso();
    publish({ ...base(windows.length ? 'stale' : 'error', windows, at), reason: sanitizeText(reason) });
  };

  const settle = (state: 'unavailable' | 'authRequired', reason: string): void => {
    if (state === 'authRequired') authBlocked = true;
    publish({ ...base(state, [], nowIso()), reason: sanitizeText(reason) });
  };

  const clearHandshakeTimer = (): void => {
    if (handshakeTimer !== undefined) clock.clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
  };

  const closeChannel = (): void => {
    const current = channel;
    channel = undefined;
    ready = false;
    clearHandshakeTimer();
    current?.stop();
  };

  const read = (): void => {
    if (!channel || !ready) return;
    // A new round asks the account again, so last round's verdict stops standing in the way of this one's.
    authBlocked = false;
    accountId = nextId++;
    limitsId = nextId++;
    channel.send({ id: accountId, method: 'account/read', params: {} });
    channel.send({ id: limitsId, method: 'account/rateLimits/read', params: {} });
  };

  /** Merge one update - from this process or forwarded from an attempt - and republish. */
  const fold = (update: unknown): void => {
    const merged = mergeRateLimits(rateLimits, update);
    if (!merged) return;
    rateLimits = merged;
    if (typeof merged.planType === 'string' && merged.planType) planType = sanitizeText(merged.planType);
    publishReading();
  };

  const handle = (message: Record<string, unknown>): void => {
    if (message.method === 'account/rateLimits/updated') {
      const params = message.params as { rateLimits?: unknown } | undefined;
      fold(params?.rateLimits);
      return;
    }
    const error = message.error as { message?: unknown } | undefined;
    if (message.id === initializeId) {
      clearHandshakeTimer();
      if (error) {
        degrade(`the Codex quota process refused the handshake: ${String(error.message ?? 'no reason given')}`);
        closeChannel();
        crashedAt = clock.now();
        return;
      }
      // §7.2: `initialized` before any other method, or every call is -32600 `Not initialized`.
      channel?.send({ method: 'initialized' });
      ready = true;
      read();
      return;
    }
    if (message.id === accountId) {
      if (error) {
        degrade(`the Codex account could not be read: ${String(error.message ?? 'no reason given')}`);
        return;
      }
      const account = (message.result as { account?: { type?: unknown; planType?: unknown } | null } | undefined)?.account;
      if (!account || account.type === 'apiKey') {
        // The server refuses quota reads for API-key auth, and has nothing to say about no account at all.
        // Both are fixed by the same thing, so both get the same sentence (§3.6).
        settle('authRequired', SIGN_IN_FOR_QUOTAS);
        return;
      }
      if (typeof account.planType === 'string' && account.planType) planType = sanitizeText(account.planType);
      return;
    }
    if (message.id === limitsId) {
      if (error) {
        const said = String(error.message ?? '');
        if (said.toLowerCase().includes(AUTH_REQUIRED_MESSAGE)) settle('authRequired', SIGN_IN_FOR_QUOTAS);
        else degrade(`the Codex quota read failed: ${said || 'no reason given'}`);
        return;
      }
      const result = message.result as { rateLimits?: unknown; rateLimitsByLimitId?: unknown } | undefined;
      rateLimits = (result?.rateLimits as CodexRateLimits | undefined) ?? rateLimits;
      if (result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object') {
        byLimitId = result.rateLimitsByLimitId as Record<string, CodexRateLimits>;
      }
      if (typeof rateLimits?.planType === 'string' && rateLimits.planType) planType = sanitizeText(rateLimits.planType);
      publishReading();
    }
  };

  const connect = (): void => {
    if (stopped || channel || !usable) return;
    crashedAt = undefined;
    ready = false;
    initializeId = nextId++;
    const opened = open({
      onMessage: handle,
      onExit: () => {
        if (channel !== opened) return;
        channel = undefined;
        ready = false;
        clearHandshakeTimer();
        if (stopped) return;
        crashedAt = clock.now();
        degrade('the Codex quota process exited; it is started again at the next five-minute read');
      },
    });
    channel = opened;
    // No `experimentalApi`: this client asks for nothing beyond the two account reads (§3.6).
    opened.send({ id: initializeId, method: 'initialize', params: { clientInfo: { name: QUOTA_CLIENT_NAME, version: options.version } } });
    handshakeTimer = clock.setTimeout(() => {
      handshakeTimer = undefined;
      if (stopped || ready || channel !== opened) return;
      degrade('the Codex quota process did not answer the handshake; it is started again at the next five-minute read');
      closeChannel();
      crashedAt = clock.now();
    }, QUOTA_HANDSHAKE_TIMEOUT_MS);
  };

  const tick = (): void => {
    if (channel && ready) read();
    else if (!channel) connect();
  };

  const arm = (): void => {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      tick();
      arm();
    }, QUOTA_REFRESH_MS);
  };

  const offForward = onCodexRateLimits((update) => {
    if (!stopped) fold(update);
  });

  publish(base('loading', [], nowIso()));

  void (async () => {
    let detection: AgentRuntimeDetection;
    try {
      detection = await detect(command);
    } catch (err) {
      detection = { command, found: false, error: (err as Error).message };
    }
    if (stopped) return;
    if (!detection.found) {
      settle('unavailable', `the Codex CLI was not found (${command})`);
      return;
    }
    if (versionAtLeast(detection.version, CODEX_QUOTA_MINIMUM_VERSION) !== true) {
      const said = detection.version ? `codex ${detection.version}` : 'this Codex CLI';
      settle('unavailable', `${said} is below ${CODEX_QUOTA_MINIMUM_VERSION}, the first version that can report quotas`);
      return;
    }
    usable = true;
    connect();
    arm();
  })();

  return {
    refresh: () => {
      if (stopped) return;
      if (channel && ready) read();
      // A crashed process is started again at most once per interval, however often `R` is pressed.
      else if (!channel && (crashedAt === undefined || clock.now() - crashedAt >= QUOTA_REFRESH_MS)) connect();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      offForward();
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      closeChannel();
    },
  };
}
