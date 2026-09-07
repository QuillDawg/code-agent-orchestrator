/**
 * Read-only derivations over a persisted run, shared by every surface that reads the run directory rather
 * than the live scheduler: the order the tasks actually executed in, and the diff an attempt captured.
 */
import type { WorkflowRun, TaskAttempt } from '../types/run.js';
import type { AttemptDiff } from '../types/result.js';
import type { RunStore } from '../persistence/run-store.js';

/**
 * Task ids in the order the run actually executed them (first attempt start), with tasks that never started
 * last in workflow order. Two tasks starting in the same millisecond keep their workflow order.
 */
export function executionOrder(run: WorkflowRun): string[] {
  const ids = run.workflow.tasks.map((t) => t.id);
  const rank = new Map(ids.map((id, i) => [id, i]));
  const startedAt = (id: string): string | undefined => run.tasks[id]?.attempts[0]?.startedAt;
  return [...ids].sort((a, b) => {
    const sa = startedAt(a);
    const sb = startedAt(b);
    if (sa && sb && sa !== sb) return sa < sb ? -1 : 1;
    if (sa && !sb) return -1;
    if (!sa && sb) return 1;
    return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  });
}

export interface CapturedAttemptDiff {
  attempt: number;
  kind: TaskAttempt['kind'];
  diff: AttemptDiff;
}

/**
 * The captured `diff.json` of one attempt: the requested one, or the newest attempt that has one. Returns
 * null when nothing was captured (run predates the capture, `git.captureDiff: false`, task never ran).
 *
 * A merge-resolution attempt is only chosen when asked for by number. Its patch spans the whole merge —
 * every other task's work included — which is never the answer to "what did this task change".
 */
export async function findCapturedDiff(
  store: Pick<RunStore, 'readDiff'>,
  run: WorkflowRun,
  taskId: string,
  attempt?: number,
): Promise<CapturedAttemptDiff | null> {
  const attempts = run.tasks[taskId]?.attempts ?? [];
  const newestFirst = [...attempts].reverse();
  const candidates = attempt !== undefined ? attempts.filter((a) => a.number === attempt) : newestFirst.filter((a) => a.kind === 'task');
  for (const a of candidates) {
    const diff = await store.readDiff(run.runId, taskId, a.number);
    if (diff) return { attempt: a.number, kind: a.kind, diff };
  }
  // An explicitly named attempt the run state no longer lists may still be on disk; look there before giving up.
  if (attempt !== undefined && candidates.length === 0) {
    const diff = await store.readDiff(run.runId, taskId, attempt);
    if (diff) return { attempt, kind: 'task', diff };
  }
  return null;
}
