/**
 * Read-only derivations over a persisted run, shared by every surface that reads the run directory rather
 * than the live scheduler: the order the tasks actually executed in, and the diff an attempt captured.
 */
import type { WorkflowRun, TaskAttempt, TaskRunState, AttemptDiff } from 'code-agent-orchestrator-protocol';
import { withoutWorkerInstructions } from '../util/text.js';
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

/** The first line with anything on it: a gate's prompt is often a paragraph, and this is one line of it. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

/**
 * The first of `parts` with readable content, with the instruction the orchestrator appends for the worker
 * taken back off: these strings are on their way to an operator, and "finish with status needs_input if you
 * cannot continue" is an instruction to the agent that buries the question underneath it.
 */
function firstText(...parts: Array<string | undefined>): string | undefined {
  for (const p of parts) {
    const t = withoutWorkerInstructions(p ?? '');
    if (t) return t;
  }
  return undefined;
}

/**
 * What an attempt stopped to ask. A worker that cannot reach a human ends its attempt as `needs_input`
 * carrying the question in the result, whichever agent it was and whichever transport could not answer, so
 * this is the one place that knows where the question lives.
 */
export function attemptQuestion(attempt: TaskAttempt | undefined): string | undefined {
  if (attempt?.outcome !== 'needs_input') return undefined;
  return firstText(attempt.result?.error, attempt.result?.summary, attempt.error);
}

/** The same, for a task sitting in `needs_input`: what `cao resume --input` is expected to answer. */
export function taskQuestion(state: TaskRunState | undefined): string | undefined {
  if (state?.state !== 'needs_input') return undefined;
  return firstText(state.result?.error, state.result?.summary, state.message);
}

export interface PausedNeed {
  taskId: string;
  kind: 'approval' | 'input';
  /** The question the worker asked, or the approval gate's prompt. Agent-written; sanitize before printing. */
  question?: string;
  /** The exact command that answers it. */
  command: string;
}

/**
 * Every task holding the run paused, with what it wants and the command that answers it. One derivation so
 * the paused block `cao run` prints, `cao status`, `cao task` and `report.md` cannot drift apart - and so an
 * operator is told the same next step wherever they happen to be looking.
 *
 * Answers are delivered one task at a time: `--input` names a single task, because the answer belongs to
 * the question that one worker asked.
 */
export function pausedNeeds(run: WorkflowRun): PausedNeed[] {
  const needs: PausedNeed[] = [];
  for (const task of run.workflow.tasks) {
    const st = run.tasks[task.id];
    if (!st) continue;
    if (st.state === 'awaiting_approval') {
      // The gate's first line, not the whole prompt: this is a one-line "what is wanted" next to the
      // command that answers it, and an approval prompt is often a paragraph. `cao task <id>` has the rest.
      needs.push({ taskId: task.id, kind: 'approval', question: firstLine(task.prompt), command: `cao resume ${run.runId} --approve ${task.id}   (or --reject ${task.id})` });
    } else if (st.state === 'needs_input') {
      needs.push({ taskId: task.id, kind: 'input', question: taskQuestion(st), command: `cao resume ${run.runId} --task ${task.id} --input "<your answer>"` });
    } else if (st.state === 'suspended') {
      // No question to quote: the operator is the one who stopped it, and what they need is the way back.
      needs.push({ taskId: task.id, kind: 'input', question: 'suspended by the operator; its session was kept', command: `cao resume ${run.runId}` });
    }
  }
  return needs;
}
