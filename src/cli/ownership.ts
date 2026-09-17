/**
 * Who is executing a run right now (spec §2.1, `[D37]`).
 *
 * `readOrchestrator` already answers "is there a process at the wheel"; this turns that answer into the
 * four states the workspace and `cao status` both reason about, so the badge in a header, the sentence in a
 * banner and the line `cao status` prints can never disagree about the same run directory.
 *
 * The four states are the ones §2.1 names:
 *
 * - **self** — this process holds the run. `canInteract` keeps its meaning: the dashboard is attached here.
 * - **owned** — another live process holds it. This window observes: it reads files and sends requests, and
 *   it takes no lock.
 * - **abandoned** — there is a record of an owner, and the owner is gone: the pid is dead, or (when the lock
 *   file went with it) its heartbeat is older than the 60 s window. The run is inspectable and resumable.
 * - **ended** — nothing claims the run. It finished, or it never started.
 *
 * The *detection* is deliberately not re-derived here. `readOrchestrator` is what `cao status` has always
 * used, including its asymmetry: a live `lock.json` is believed on the strength of the pid alone, because
 * reporting "nothing is running" over a live orchestrator invites a second `cao run` into the same working
 * tree, while the `live.json` fallback additionally requires a fresh heartbeat because a pid can be
 * recycled. Both ways of losing an owner therefore arrive here as `alive: false`.
 */
import type { FileRunStore } from '../persistence/run-store.js';
import { readOrchestrator, type Orchestrator } from './util.js';

export type OwnershipKind = 'self' | 'owned' | 'abandoned' | 'ended';

export interface RunOwnership {
  kind: OwnershipKind;
  /** The owning process, for every state but `ended`. */
  pid?: number;
  heartbeatAt?: string;
  /** Which file answered; `live` means `lock.json` was missing. */
  source?: 'lock' | 'live';
  /** Whether this window may take the run: only when no live process holds it (§2.1). */
  resumable: boolean;
}

/** The classification itself, with no I/O in it, so the state machine can be tested as one. */
export function ownershipOf(orchestrator: Orchestrator | null, selfPid: number = process.pid): RunOwnership {
  if (!orchestrator) return { kind: 'ended', resumable: true };
  const { pid, heartbeatAt, source, alive } = orchestrator;
  const common = { pid, heartbeatAt, source };
  if (!alive) return { ...common, kind: 'abandoned', resumable: true };
  if (pid === selfPid) return { ...common, kind: 'self', resumable: false };
  return { ...common, kind: 'owned', resumable: false };
}

/**
 * Read it now. Called again on every poll tick rather than once at open, because the answer changes under
 * the window: an owner that exits turns an observer into "abandoned, resumable" (§2.1).
 */
export async function readOwnership(store: FileRunStore, runId: string, selfPid: number = process.pid): Promise<RunOwnership> {
  return ownershipOf(await readOrchestrator(store, runId), selfPid);
}

/** The header badge (§2.1, §3.2). Short, because it shares a line with the progress bar and the clock. */
export function ownershipBadge(ownership: RunOwnership): string {
  switch (ownership.kind) {
    case 'owned':
      return `observing · owner pid ${ownership.pid}`;
    case 'abandoned':
      return 'abandoned · resume?';
    default:
      return 'owner';
  }
}

/**
 * The sentence under the badge, or nothing when this window is the owner.
 *
 * It says where the keys are: an observer cannot answer a question the worker asked, because `approve`,
 * `reject` and `answer` do not cross the process boundary until presence gating ships `[D3]`.
 */
export function ownershipBanner(ownership: RunOwnership, runId: string): string | undefined {
  if (ownership.kind === 'owned') {
    return `Run ${runId} is owned by pid ${ownership.pid}; this window is watching. Approvals and questions are answered in that terminal.`;
  }
  if (ownership.kind === 'abandoned') {
    return `The process that owned run ${runId} (pid ${ownership.pid}) is gone. Nothing is executing it; resume it from here.`;
  }
  return undefined;
}

/** Why a command raised here cannot be applied here, in the words the refusing controller answers with. */
export function ownershipRefusal(ownership: RunOwnership, runId: string): string {
  if (ownership.kind === 'owned') {
    return `Run ${runId} is owned by another process (pid ${ownership.pid}); send controls from there, or with "cao stop ${runId}".`;
  }
  return `No orchestrator owns run ${runId}. Start it again from here, or with "cao resume ${runId}".`;
}
