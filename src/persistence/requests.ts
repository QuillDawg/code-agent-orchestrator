/**
 * `.orchestrator/runs/<run-id>/requests/` — the request inbox (spec §2.3, `[D38]`).
 *
 * The cross-process transport for the run controller. A terminal that does not own a run cannot call the
 * controller, and it cannot signal the owner either: Windows has no way to send SIGINT to an unrelated
 * process, and every other signal kills the orchestrator before it can stop its workers and persist. So the
 * request is a file, polled by the owner, answered with a file — which behaves the same on every platform
 * and needs no permission this process does not already have. `stop.json` has worked this way all along;
 * this is the same mechanism with a name, an id and an answer.
 *
 * **Nothing read here is executed.** A request names something the controller would already do, is checked
 * against the command union before it is submitted, and widens no permission: `approve`, `reject` and
 * `answer` are refused from disk outright until presence gating ships (`[D3]`).
 *
 * The id is a ULID and is also the file-name prefix, so a lexicographic `readdir` is request order with no
 * index and no parsing (§2.3).
 */
import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import {
  CONTROL_REQUEST_KINDS,
  PROTOCOL_VERSION,
  isFutureProtocol,
  stamp,
  type ControlAck,
  type ControlAckStatus,
  type ControlRequest,
  type ControlRequestKind,
  type RunPaths,
} from 'code-agent-orchestrator-protocol';
import { isPlainObject, nowIso, sleep } from '../util/misc.js';
import { packageInfo } from '../util/package-info.js';
import { writeFileAtomic, writeFileAtomicSync } from '../util/fs.js';
import { ulid } from '../util/ulid.js';
import { isSyncConflictName } from './registry.js';

/** Seconds `cao` waits for an ack before it says so and leaves the request behind (§2.3). */
export const DEFAULT_ACK_WAIT_SECONDS = 30;

/** How often the sender looks for its ack. The owner polls on a 500 ms tick, so half of that is timely. */
const ACK_POLL_MS = 250;

/** A request file and what was in it. The file comes back too: the owner deletes it *after* its ack is written. */
export interface PendingRequest {
  file: string;
  request: ControlRequest;
}

// ---------------------------------------------------------------------------- writing a request

/** `cao 0.1.0` — free text on the wire, for the owner's log line. */
function selfSource(): string {
  return `cao ${packageInfo().version}`;
}

/**
 * A fresh request, stamped and identified. The caller fills in what its kind needs and may state an id, a
 * source, a pid or a time of its own — the legacy `stop.json` translation keeps the pid of the process that
 * wrote the file, which is the one the log line should name.
 */
export function controlRequest(kind: ControlRequestKind, fields: Partial<ControlRequest> = {}): ControlRequest {
  return stamp<ControlRequest>({
    ...fields,
    protocol: PROTOCOL_VERSION,
    id: fields.id ?? ulid(),
    kind,
    requestedAt: fields.requestedAt ?? nowIso(),
    source: fields.source ?? selfSource(),
    pid: fields.pid ?? process.pid,
  });
}

/** `<ULID>-<kind>.json` (§2.3). The prefix is what makes `readdir` request order. */
export function requestFileName(request: ControlRequest): string {
  return `${request.id}-${request.kind}.json`;
}

/** Write one request into the inbox; returns the file it was written to. */
export async function writeControlRequest(paths: RunPaths, runId: string, request: ControlRequest): Promise<string> {
  const file = path.join(paths.requestsDir(runId), requestFileName(request));
  await writeFileAtomic(file, `${JSON.stringify(request, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------- acks

/** An ack built outside the scheduler: the inbox answers a request the controller never sees this way. */
export function controlAck(id: string, status: ControlAckStatus, reason?: string): ControlAck {
  return stamp<ControlAck>({ protocol: PROTOCOL_VERSION, id, status, ...(reason ? { reason } : {}), at: nowIso() });
}

function ackFile(paths: RunPaths, runId: string, id: string): string {
  return path.join(paths.requestAcksDir(runId), `${id}.json`);
}

/** `requests/acks/<ULID>.json`, atomically — the request is deleted only once this has landed (§2.3). */
export async function writeAck(paths: RunPaths, runId: string, ack: ControlAck): Promise<void> {
  await writeFileAtomic(ackFile(paths, runId, ack.id), `${JSON.stringify(ack, null, 2)}\n`);
}

/**
 * The same write, synchronously.
 *
 * Used for exactly one command: a `kill` ends this process from a timer scheduled the moment its ack
 * resolves, and an `await` on a filesystem write yields to that timer. Answering the request that asked for
 * the kill, and consuming it so the next orchestrator does not find it and kill itself too, has to happen
 * before control returns to the event loop.
 */
export function writeAckSync(paths: RunPaths, runId: string, ack: ControlAck): void {
  writeFileAtomicSync(ackFile(paths, runId, ack.id), `${JSON.stringify(ack, null, 2)}\n`);
}

/** The same deletion, synchronously, for the `kill` path. See `writeAckSync`. */
export function deleteRequestSync(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* already gone is the outcome we wanted */
  }
}

/** The ack for one id, or null while there is none. Never throws: a half-written file is simply "not yet". */
export async function readAck(paths: RunPaths, runId: string, id: string): Promise<ControlAck | null> {
  const text = await fs.readFile(ackFile(paths, runId, id), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) && typeof parsed.id === 'string' && typeof parsed.status === 'string' ? (parsed as unknown as ControlAck) : null;
  } catch {
    return null;
  }
}

/** Remove a request once its ack is on disk. Best-effort: a file already gone is the outcome we wanted. */
export async function deleteRequest(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------- reading the inbox

/**
 * A request this build cannot act on is **moved, not deleted** (§2.3): the operator gets to see what was
 * refused, and the sidecar says why in the same words the log line used.
 */
async function rejectFile(paths: RunPaths, runId: string, file: string, reason: string): Promise<void> {
  const dir = paths.requestRejectedDir(runId);
  const name = path.basename(file);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  const target = path.join(dir, name);
  await fs.rename(file, target).catch(async () => {
    // A cross-device rename cannot happen inside one run directory, but a Windows lock on the source can.
    await fs.copyFile(file, target).catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
  });
  await writeFileAtomic(`${target}.reason.txt`, `${reason}\n`).catch(() => undefined);
}

/** `id` is the ack's file name, so it has to be one path segment and nothing clever. */
function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..');
}

const KNOWN_KINDS = new Set<string>(CONTROL_REQUEST_KINDS);

/**
 * Structure only. Whether a *known* kind makes sense — a `restart` with no task, a `prompt` with no text —
 * is the command union's question and is answered with an ack, not by moving the file.
 */
function requestProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'the file is not a JSON object';
  if (!isSafeId(value.id)) return 'the request has no usable id, and an id is also the name of its acknowledgment file';
  if (typeof value.kind !== 'string') return 'the request names no kind';
  if (!KNOWN_KINDS.has(value.kind)) return `this cao does not know the request kind "${value.kind}"`;
  return null;
}

/**
 * Every request waiting in the inbox, in ULID order.
 *
 * Sync-conflict copies are skipped rather than parsed, exactly as the registry reader skips them: a synced
 * run directory produces a second copy of a request that was already answered on another machine, and
 * acting on it twice is the one thing dedup cannot save you from, because the copy carries the same id.
 */
export async function readPendingRequests(paths: RunPaths, runId: string): Promise<PendingRequest[]> {
  const dir = paths.requestsDir(runId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: PendingRequest[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || isSyncConflictName(name)) continue;
    const file = path.join(dir, name);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue; // a directory, or a file that has just been consumed
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await rejectFile(paths, runId, file, 'the file is not valid JSON');
      continue;
    }
    if (isFutureProtocol(parsed)) {
      const written = (parsed as { protocol?: unknown }).protocol;
      await rejectFile(paths, runId, file, `written for protocol ${String(written)}, and this cao understands ${PROTOCOL_VERSION}`);
      continue;
    }
    const problem = requestProblem(parsed);
    if (problem !== null) {
      await rejectFile(paths, runId, file, problem);
      continue;
    }
    out.push({ file, request: parsed as ControlRequest });
  }
  return out;
}

// ---------------------------------------------------------------------------- sending one and waiting

export interface SendControlRequestOptions {
  /** Seconds to wait for the ack. `0` returns as soon as the request is on disk. */
  wait?: number;
  /** Test seam; the owner polls every 500 ms, so there is nothing to gain from a smaller value in practice. */
  pollMs?: number;
}

export interface SentControlRequest {
  id: string;
  file: string;
  /** The owner's answer, or **null** when `wait` elapsed without one — which is not a refusal (§2.3). */
  ack: ControlAck | null;
}

/**
 * Write a request and wait for its ack (§2.3). What the caller prints is its business: a `null` ack means
 * nobody answered in time, which is a different thing from a rejection and is reported as one.
 */
export async function sendControlRequest(
  paths: RunPaths,
  runId: string,
  request: ControlRequest,
  opts: SendControlRequestOptions = {},
): Promise<SentControlRequest> {
  const file = await writeControlRequest(paths, runId, request);
  const deadline = Date.now() + Math.max(0, opts.wait ?? DEFAULT_ACK_WAIT_SECONDS) * 1000;
  const poll = opts.pollMs ?? ACK_POLL_MS;
  for (;;) {
    const ack = await readAck(paths, runId, request.id);
    if (ack) return { id: request.id, file, ack };
    if (Date.now() >= deadline) return { id: request.id, file, ack: null };
    await sleep(Math.min(poll, Math.max(1, deadline - Date.now())));
  }
}

// ---------------------------------------------------------------------------- reading it read-only

/** Every request and answer this run's inbox holds, for the Diagnostics panel and `cao diagnostics` (§3.7). */
export interface ControlHistory {
  /** Requests still waiting in `requests/`, in ULID order. */
  pending: ControlRequest[];
  /** Answers in `requests/acks/`, in ULID order. */
  acks: ControlAck[];
  /** What was moved to `requests/rejected/`, with the sidecar reason beside it. */
  rejected: Array<{ file: string; request: unknown; reason?: string }>;
}

/**
 * The inbox as it is, changing nothing.
 *
 * Deliberately not `readPendingRequests`: that one is the *owner's* reader and moves a request it cannot act
 * on into `rejected/` as it goes. Diagnostics is read-only by definition (§3.7), and a panel that rejected
 * a request merely by being opened would be a second inbox consumer racing the real one.
 */
export async function readControlHistory(paths: RunPaths, runId: string): Promise<ControlHistory> {
  const readAll = async <T>(dir: string, keep: (value: unknown, file: string) => T | null): Promise<T[]> => {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: T[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || isSyncConflictName(name)) continue;
      const file = path.join(dir, name);
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const value = keep(parsed, file);
      if (value !== null) out.push(value);
    }
    return out;
  };

  const pending = await readAll(paths.requestsDir(runId), (value) => (isPlainObject(value) && typeof value.kind === 'string' ? (value as unknown as ControlRequest) : null));
  const acks = await readAll(paths.requestAcksDir(runId), (value) => (isPlainObject(value) && typeof value.status === 'string' ? (value as unknown as ControlAck) : null));
  const rejectedDir = paths.requestRejectedDir(runId);
  const rejected = await readAll(rejectedDir, (value, file): ControlHistory['rejected'][number] => ({ file, request: value }));
  for (const entry of rejected) {
    const reason = await fs.readFile(`${entry.file}.reason.txt`, 'utf8').catch(() => null);
    if (reason !== null) entry.reason = reason.trim();
  }
  return { pending, acks, rejected };
}
