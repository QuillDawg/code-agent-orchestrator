/**
 * Watching a run another process owns (spec §2.1, §2.3, `[D37]`).
 *
 * `createDetachedController` next door reads a run that has stopped moving. This reads one that has not: the
 * owner is writing `workflow.json`, `live.json` and each attempt's `events.jsonl` while this process draws
 * them, so everything here is a **poll of the run directory** at the 500 ms cadence the stop watcher already
 * runs at, and nothing here holds a lock, a scheduler or a worker.
 *
 * Two rules shape the whole file:
 *
 * - **No lock, ever.** Nothing in this module calls `acquireLock`, `heartbeat` or `saveRun`. The only file
 *   it writes is a request in `requests/`, which is the one thing §2.3 says a process that owns nothing may
 *   do. Becoming the owner is the lifecycle path (`startRuntime`), never this one.
 * - **Only what the run says it accepts.** A control is offered when the run's registry entry advertises
 *   its token (§2.3, §4.2.3), and a token this build has no control for is not a control. With no entry —
 *   which is every run started with emit off, the default — the fallback is what an owner *of this build*
 *   acts on, because that is the only other honest answer available from here.
 *
 * Reads tolerate a file caught mid-write. `live.json` already answers `null` rather than throwing;
 * `workflow.json` is retried once and then left at the last good copy, so a single unlucky read costs one
 * tick of freshness rather than the window.
 */
import path from 'node:path';
import type {
  AttemptDiff,
  CapabilityToken,
  ControlAck,
  LiveStatus,
  TaskRunState,
  TranscriptEntry,
  WorkflowRun,
} from 'code-agent-orchestrator-protocol';
import type { FileRunStore } from '../../persistence/run-store.js';
import { OLDER_PAGE, readOlderAcrossAttempts, readOlderEntries, readTranscriptFile } from '../../persistence/transcript-log.js';
import { controlRequest, sendControlRequest } from '../../persistence/requests.js';
import { listEntries, registryKey } from '../../persistence/registry.js';
import { followFile } from '../../tui/follow.js';
import { INBOX_REQUEST_KINDS } from '../../execution/signals.js';
import { nowIso, sleep, systemClock, type Clock } from '../../util/misc.js';
import { sanitizeText } from '../../util/text.js';
import { readOwnership, ownershipRefusal, type RunOwnership } from '../../cli/ownership.js';
import type { RunController } from './controller.js';

/** The owner's own tick; one cadence for the whole cross-process conversation (§2.1, §2.3). */
export const OBSERVE_INTERVAL_MS = 500;

/** Seconds a control sent from the workspace waits for its ack before it says nobody answered (§2.3). */
export const OBSERVER_ACK_WAIT_SECONDS = 10;

/** The controls that cross a process boundary, in the order the workspace offers them. */
export const OBSERVER_CONTROL_KINDS = ['stop', 'kill', 'restart'] as const;
export type ObserverControlKind = (typeof OBSERVER_CONTROL_KINDS)[number];

/**
 * What came back from the owner.
 *
 * `timeout` is its own outcome and not a rejection: §2.3 is explicit that a `--wait` that elapses means
 * nobody answered *yet*, and the request is still in `requests/` waiting to be read. Calling that "rejected"
 * would tell an operator their stop was refused when it is about to be applied.
 */
export interface ControlOutcome {
  status: 'accepted' | 'applied' | 'rejected' | 'timeout';
  reason?: string;
}

/** One control the observer can offer, as the workspace names it. */
export interface ObserverControl {
  kind: ObserverControlKind;
  taskId?: string;
}

/**
 * The surface the workspace is given in observer mode. Deliberately not the `RunController`: a controller
 * command is applied in this process, and none of these are — each is a file the owner reads (§2.3).
 */
export interface ObserverSurface {
  /** The pid this window is watching, for the sentences that name it. */
  readonly ownerPid: number | undefined;
  /** The tokens the run advertises; a control whose token is missing is not offered at all. */
  readonly capabilities: readonly CapabilityToken[];
  send(control: ObserverControl): Promise<ControlOutcome>;
}

export interface ObservedRun {
  run: WorkflowRun;
  ownership: RunOwnership;
}

export interface RunObserverDeps {
  store: FileRunStore;
  runId: string;
  /** The run as it was first loaded, so the workspace has something to draw before the first tick. */
  run: WorkflowRun;
  /** Overrides the registry lookup; tests and callers that already read the entry pass it in. */
  capabilities?: readonly CapabilityToken[];
  clock?: Clock;
  intervalMs?: number;
  ackWaitSeconds?: number;
}

export interface RunObserver {
  /** The run as the last tick read it: `workflow.json` with `live.json` folded over it. */
  readonly run: WorkflowRun;
  readonly ownership: RunOwnership;
  /** Reads from the run directory; every command is refused, because none of them belong to this process. */
  readonly controller: RunController;
  /** Stop, kill and restart through the inbox (§2.3). */
  readonly surface: ObserverSurface;
  start(): void;
  stop(): void;
  /** One poll, awaited. The timer calls it; a test calls it instead of waiting 500 ms. */
  tick(): Promise<void>;
  /** Called after every tick, with the run and the ownership that tick read. */
  onChange(listener: (view: ObservedRun) => void): () => void;
}

// ---------------------------------------------------------------------------- the live overlay

/**
 * `workflow.json` with `live.json` folded over it, the same way `cao status` reads the pair.
 *
 * The persisted run is authoritative for everything that has finished; `live.json` is the only thing that
 * knows what is happening inside the attempt running right now, and the orchestrator rewrites it at least
 * once a second. The overlay is applied **only while an orchestrator is alive**: a `live.json` left behind
 * by a process that died still says `running`, and folding that over a run whose tasks are recorded as
 * cancelled would show an operator workers that no longer exist.
 */
export function mergeLive(run: WorkflowRun, live: LiveStatus | null, alive: boolean): WorkflowRun {
  if (!live || !alive || live.runId !== run.runId) return run;
  const tasks: Record<string, TaskRunState> = {};
  for (const [id, state] of Object.entries(run.tasks)) {
    const current = live.tasks[id];
    if (!current) {
      tasks[id] = state;
      continue;
    }
    const attempts =
      current.usage && state.currentAttempt !== undefined
        ? state.attempts.map((a) => (a.number === state.currentAttempt ? { ...a, usage: current.usage } : a))
        : state.attempts;
    tasks[id] = {
      ...state,
      attempts,
      state: current.state,
      lastActivity: current.lastActivity ?? state.lastActivity,
      // Taken outright rather than with `??`: a question that has just been answered is absent from the
      // newer file, and falling back to the older one would leave "waiting for you" on a task that is not.
      pendingInteraction: current.pendingInteraction,
    };
  }
  return { ...run, state: live.state, tasks };
}

// ---------------------------------------------------------------------------- transcripts

interface Tail {
  attempt: number;
  buffer: TranscriptEntry[];
  shown: TranscriptEntry[];
  dirty: boolean;
  abort: AbortController;
}

/**
 * The tail of each task's newest attempt, followed on disk.
 *
 * `peek` and `transcript` are synchronous on `RunController` because the owner answers them out of an
 * in-memory ring buffer. Here the buffer is filled by the same tailer `cao logs --follow` uses
 * (`src/tui/follow.ts`): the first call for a task starts the follow and returns what is already known, and
 * the workspace's own tick picks the rest up. An attempt that gives way to a retry is a different file, so
 * the follow is torn down and started again on the new one rather than appending one attempt to another.
 */
class TranscriptTails {
  private readonly tails = new Map<string, Tail>();

  constructor(
    private readonly fileFor: (taskId: string, attempt: number) => string,
    private readonly newestAttempt: (taskId: string) => number | undefined,
    private readonly limit: number,
  ) {}

  get(taskId: string): TranscriptEntry[] {
    const attempt = this.newestAttempt(taskId);
    if (attempt === undefined) return [];
    const open = this.tails.get(taskId);
    if (open && open.attempt === attempt) {
      // Rebuilt only when a line has arrived: the array's identity is what tells the viewer it has grown,
      // and a fresh copy on every frame would defeat the viewer's own memo instead.
      if (open.dirty) {
        open.shown = open.buffer.slice();
        open.dirty = false;
      }
      return open.shown;
    }
    open?.abort.abort();
    const tail: Tail = { attempt, buffer: [], shown: [], dirty: false, abort: new AbortController() };
    this.tails.set(taskId, tail);
    const take = (line: string): void => {
      const entry = parseEntry(line);
      if (!entry) return;
      tail.buffer.push(entry);
      if (tail.buffer.length > this.limit) tail.buffer.splice(0, tail.buffer.length - this.limit);
      tail.dirty = true;
    };
    void followFile(this.fileFor(taskId, attempt), take, {
      initialLines: this.limit,
      onInitial: (lines) => lines.forEach(take),
      signal: tail.abort.signal,
    }).catch(() => undefined);
    return tail.shown;
  }

  stop(): void {
    for (const tail of this.tails.values()) tail.abort.abort();
    this.tails.clear();
  }
}

function parseEntry(line: string): TranscriptEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && typeof (parsed as TranscriptEntry).kind === 'string' ? (parsed as TranscriptEntry) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- capabilities

/**
 * What the run advertises (§2.3, §4.2.3), narrowed to controls this build can actually offer.
 *
 * A run announces itself only with emit on, so most runs have no entry at all. The fallback is not "offer
 * nothing" — that would make the observer a viewer for every run started with the default settings — but
 * the kinds an owner of *this* build acts on, which is the same list the entry would have carried had it
 * been written. A token from a newer `cao` that this one has no control for is ignored either way: an
 * unknown token hides a control, it never invents one.
 */
export async function advertisedCapabilities(run: WorkflowRun, runId: string): Promise<readonly CapabilityToken[]> {
  const key = registryKey(run.repositoryRoot, runId);
  const entry = await listEntries()
    .then((entries) => entries.find((e) => e.key === key))
    .catch(() => undefined);
  const advertised = entry?.capabilities;
  if (!advertised) return INBOX_REQUEST_KINDS;
  return OBSERVER_CONTROL_KINDS.filter((kind) => advertised.includes(kind));
}

// ---------------------------------------------------------------------------- the observer

export function createRunObserver(deps: RunObserverDeps): RunObserver {
  const { store, runId } = deps;
  const clock = deps.clock ?? systemClock;
  const interval = deps.intervalMs ?? OBSERVE_INTERVAL_MS;
  const ackWait = deps.ackWaitSeconds ?? OBSERVER_ACK_WAIT_SECONDS;
  const limit = deps.run.workflow.execution.outputBufferLines;

  let run = deps.run;
  let ownership: RunOwnership = { kind: 'owned', resumable: false };
  let capabilities: readonly CapabilityToken[] = deps.capabilities ?? [];
  let capabilitiesRead = deps.capabilities !== undefined;
  let timer: unknown;
  let stopped = false;
  let ticking = false;
  const listeners = new Set<(view: ObservedRun) => void>();

  const eventsFile = (taskId: string, attempt: number): string => path.join(store.paths.attemptDir(runId, taskId, attempt), 'events.jsonl');
  const newestAttempt = (taskId: string): number | undefined => {
    const attempts = run.tasks[taskId]?.attempts;
    return attempts?.[attempts.length - 1]?.number;
  };
  const tails = new TranscriptTails(eventsFile, newestAttempt, limit);

  /** `workflow.json`, retried once and then left alone: one unlucky read costs a tick, not the window. */
  const readRun = async (): Promise<WorkflowRun> => {
    try {
      return await store.loadRun(runId);
    } catch {
      await sleep(50);
      return store.loadRun(runId).catch(() => run);
    }
  };

  const announce = (): void => {
    const view: ObservedRun = { run, ownership };
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        /* a subscriber that throws must not stop the poll */
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const next = await readOwnership(store, runId);
      const alive = next.kind === 'owned' || next.kind === 'self';
      const loaded = await readRun();
      const live = alive ? await store.readLive(runId) : null;
      ownership = next;
      run = mergeLive(loaded, live, alive);
      if (!capabilitiesRead) {
        capabilitiesRead = true;
        capabilities = await advertisedCapabilities(run, runId);
      }
      announce();
    } finally {
      ticking = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      void tick()
        .catch(() => undefined)
        .finally(schedule);
    }, interval);
  };

  const refusal = (id: string): ControlAck => ({ protocol: 1, id, status: 'rejected', reason: ownershipRefusal(ownership, runId), at: nowIso() });

  const surface: ObserverSurface = {
    get ownerPid() {
      return ownership.pid;
    },
    get capabilities() {
      return capabilities;
    },
    async send(control) {
      if (!capabilities.includes(control.kind)) {
        return { status: 'rejected', reason: `Run ${runId} does not advertise ${control.kind}, so this window will not send one.` };
      }
      if (ownership.kind !== 'owned') {
        return { status: 'rejected', reason: ownershipRefusal(ownership, runId) };
      }
      const pid = ownership.pid;
      const request = controlRequest(control.kind, control.taskId ? { taskId: control.taskId } : {});
      const sent = await sendControlRequest(store.paths, runId, request, { wait: ackWait });
      if (!sent.ack) {
        return { status: 'timeout', reason: `No answer from pid ${pid} in ${ackWait}s; the request is still in requests/ and is applied when the owner reads it.` };
      }
      const status = sent.ack.status === 'accepted' || sent.ack.status === 'applied' ? sent.ack.status : 'rejected';
      // The reason was written by another process, and it is about to be drawn in a terminal.
      return { status, ...(sent.ack.reason ? { reason: sanitizeText(sent.ack.reason) } : {}) };
    },
  };

  const controller: RunController = {
    get run() {
      return run;
    },
    // Nothing in this process is executing it, so every command is refused and every read comes from disk.
    ended: true,
    stopping: false,
    canInteract: false,
    peek: (taskId, entries = 50) => tails.get(taskId).slice(-entries),
    transcript: (taskId) => tails.get(taskId),
    attemptTranscript: async (taskId, attempt) => (await readTranscriptFile(eventsFile(taskId, attempt))).slice(-limit),
    olderTranscript: (taskId, attempt, oldest, count = OLDER_PAGE) => readOlderEntries(eventsFile(taskId, attempt), oldest, count),
    olderTaskTranscript: (taskId, attempt, oldest, count = OLDER_PAGE) => {
      const files: string[] = [];
      for (let n = attempt; n >= 1; n -= 1) files.push(eventsFile(taskId, n));
      return readOlderAcrossAttempts(files, oldest, count);
    },
    // Nothing is executing this run here, so no worker of it has a channel this process can reach.
    steerable: () => false,

    async capturedDiff(taskId): Promise<{ attempt: number; diff: AttemptDiff; patch: string } | null> {
      const attempts = [...(run.tasks[taskId]?.attempts ?? [])].reverse().filter((a) => a.kind === 'task');
      for (const a of attempts) {
        const diff = await store.readDiff(runId, taskId, a.number).catch(() => null);
        if (diff) return { attempt: a.number, diff, patch: (await store.readDiffPatch(runId, taskId, a.number).catch(() => null)) ?? '' };
      }
      return null;
    },
    readReport: () => store.readReport(runId),
    persistInterruptedSync: () => undefined,
    setKillHandler: () => undefined,
    submit: (_command, envelope) => Promise.resolve(refusal(envelope.id)),
  };

  return {
    get run() {
      return run;
    },
    get ownership() {
      return ownership;
    },
    controller,
    surface,
    start() {
      if (stopped || timer !== undefined) return;
      void tick()
        .catch(() => undefined)
        .finally(schedule);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      listeners.clear();
      tails.stop();
    },
    tick,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
