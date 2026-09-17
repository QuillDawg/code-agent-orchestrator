/**
 * A run controller for a run nobody is executing (spec §2.1, §2.4).
 *
 * `cao ui <run>` opens the workspace on a run that ended hours ago, or on one another process owns. There is
 * no scheduler in this process to ask, so every read comes from the run directory instead — the same files
 * `cao logs`, `cao diff` and `cao report` read, so the workspace and those commands cannot disagree — and
 * every command is refused with a sentence that says why and what to do instead.
 *
 * It is deliberately the *same* `RunController` interface the live one implements. The workspace holds one
 * object either way and never asks which kind it has; what changes between an owned run and a watched one is
 * the answer it gets back, not the shape of the call.
 */
import path from 'node:path';
import type { AttemptDiff, ControlAck, TranscriptEntry, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { RunStore } from '../../persistence/run-store.js';
import { OLDER_PAGE, readOlderAcrossAttempts, readOlderEntries, readTranscriptFile } from '../../persistence/transcript-log.js';
import { nowIso } from '../../util/misc.js';
import type { RunController } from './controller.js';

export interface DetachedControllerDeps {
  store: RunStore;
  /** The run as it was loaded from `workflow.json`; re-read by the caller, never mutated here. */
  run: WorkflowRun;
  /** Why commands are refused — "no orchestrator owns this run", or the pid of the one that does. */
  reason: string;
  /** How many entries of a task's newest attempt to hold in memory for `peek`. */
  bufferLines?: number;
}

/**
 * `peek` and `transcript` are synchronous on the interface because the live controller answers them out of
 * an in-memory ring buffer. Here they come from a file, so the first call starts the read and returns what
 * is already known; the workspace re-renders on its own one-second tick and picks the rest up then. Waiting
 * for the file instead would mean making every caller async for the one case where the run is not live.
 */
class TranscriptCache {
  private readonly entries = new Map<string, TranscriptEntry[]>();
  private readonly loading = new Set<string>();

  constructor(
    private readonly load: (taskId: string) => Promise<TranscriptEntry[]>,
    private readonly limit: number,
  ) {}

  get(taskId: string): TranscriptEntry[] {
    const known = this.entries.get(taskId);
    if (known) return known;
    if (!this.loading.has(taskId)) {
      this.loading.add(taskId);
      void this.load(taskId)
        .then((value) => this.entries.set(taskId, value.slice(-this.limit)))
        .catch(() => this.entries.set(taskId, []));
    }
    return [];
  }
}

export function createDetachedController(deps: DetachedControllerDeps): RunController {
  const { store, run, reason } = deps;
  const limit = deps.bufferLines ?? run.workflow.execution.outputBufferLines;
  const eventsFile = (taskId: string, attempt: number): string => path.join(store.paths.attemptDir(run.runId, taskId, attempt), 'events.jsonl');
  /** The attempt a task's live transcript would have been showing: its newest one. */
  const newestAttempt = (taskId: string): number | undefined => run.tasks[taskId]?.attempts[run.tasks[taskId]!.attempts.length - 1]?.number;
  const cache = new TranscriptCache(async (taskId) => {
    const attempt = newestAttempt(taskId);
    return attempt === undefined ? [] : readTranscriptFile(eventsFile(taskId, attempt));
  }, limit);

  const refuse = (id: string): ControlAck => ({ protocol: 1, id, status: 'rejected', reason, at: nowIso() });

  return {
    get run() {
      return run;
    },
    ended: true,
    stopping: false,
    canInteract: false,
    peek: (taskId, entries = 50) => cache.get(taskId).slice(-entries),
    transcript: (taskId) => cache.get(taskId),
    attemptTranscript: async (taskId, attempt) => (await readTranscriptFile(eventsFile(taskId, attempt))).slice(-limit),
    olderTranscript: (taskId, attempt, oldest, count = OLDER_PAGE) => readOlderEntries(eventsFile(taskId, attempt), oldest, count),
    olderTaskTranscript: (taskId, attempt, oldest, count = OLDER_PAGE) => {
      const files: string[] = [];
      for (let n = attempt; n >= 1; n -= 1) files.push(eventsFile(taskId, n));
      return readOlderAcrossAttempts(files, oldest, count);
    },
    async capturedDiff(taskId): Promise<{ attempt: number; diff: AttemptDiff; patch: string } | null> {
      const attempts = [...(run.tasks[taskId]?.attempts ?? [])].reverse().filter((a) => a.kind === 'task');
      for (const a of attempts) {
        const diff = await store.readDiff(run.runId, taskId, a.number).catch(() => null);
        if (diff) return { attempt: a.number, diff, patch: (await store.readDiffPatch(run.runId, taskId, a.number).catch(() => null)) ?? '' };
      }
      return null;
    },
    readReport: () => store.readReport(run.runId),
    // Nothing in this process is holding run state that is not already on disk.
    persistInterruptedSync: () => undefined,
    setKillHandler: () => undefined,
    submit: (_command, envelope) => Promise.resolve(refuse(envelope.id)),
  };
}
