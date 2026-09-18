/** Creates new runs and reconciles persisted runs for `cao resume`. */
import { TERMINAL_TASK_STATES } from 'code-agent-orchestrator-protocol';
import type { ControlSource, ResolvedTask, WorkflowRun, RunSelection, TaskRunState, ResolvedWorkflow } from 'code-agent-orchestrator-protocol';
import { adoptLegacyFollowUp, queueFollowUp, resumableSessionId } from './control/follow-up.js';
import type { RunStore } from '../persistence/run-store.js';
import { sha256, nowIso, isProcessAlive } from '../util/misc.js';
import { killTree } from '../execution/process-manager.js';

export interface CreateRunInput {
  workflow: ResolvedWorkflow;
  rawConfig: string;
  selection?: RunSelection;
  claudeVersion?: string;
}

export async function createRun(store: RunStore, input: CreateRunInput): Promise<WorkflowRun> {
  const runId = await store.allocateRunId();
  const now = nowIso();
  const tasks: Record<string, TaskRunState> = {};
  for (const t of input.workflow.tasks) tasks[t.id] = { id: t.id, state: 'pending', attempts: [], retryWindowStart: 1 };
  const run: WorkflowRun = {
    schemaVersion: 1,
    runId,
    workflowName: input.workflow.name,
    configPath: input.workflow.configPath,
    workflowHash: sha256(input.rawConfig),
    launchDirectory: input.workflow.launchDirectory,
    repositoryRoot: input.workflow.repositoryRoot,
    claudeVersion: input.claudeVersion,
    selection: input.selection ?? {},
    workflow: input.workflow,
    tasks,
    state: 'created',
    createdAt: now,
    updatedAt: now,
    resumeCount: 0,
    eventSeq: 0,
  };
  await store.saveRun(run);
  return run;
}

export interface ResumeOptions {
  retryFailed?: boolean;
  approve?: string[];
  reject?: string[];
  input?: { taskId: string; text: string };
  /**
   * A follow-up to carry into the next attempt of one task (spec §3.5, `[D25]`).
   *
   * The same errand as `input` with the `needs_input` restriction lifted: a follow-up reaches any task that
   * has stopped, and `input` is the one row of it that also answers a question. Both end in `queueFollowUp`.
   */
  followUp?: { taskId: string; text: string; source?: ControlSource; freshSession?: boolean; sessionId?: string };
  selection?: RunSelection;
}

export interface ResumeReconciliation {
  rerun: string[];
  notes: string[];
  orphansKilled: number[];
}

/** The resolved task behind a run state; the stored workflow is what a resume executes. */
function taskDef(run: WorkflowRun, taskId: string): ResolvedTask {
  return run.workflow.tasks.find((t) => t.id === taskId)!;
}

/**
 * A follow-up carried into the next attempt of a task that has stopped (§3.5).
 *
 * Applied after the state machine above, so the state it reads is the one this resume will execute: a
 * `running` task has already become `pending` and a `failed` one has already been given its retry budget.
 */
function applyFollowUp(run: WorkflowRun, followUp: NonNullable<ResumeOptions['followUp']>, rerun: string[], notes: string[]): void {
  const st = run.tasks[followUp.taskId];
  const task = taskDef(run, followUp.taskId);
  if (!st || !task) {
    notes.push(`there is no task "${followUp.taskId}" to send a follow-up to`);
    return;
  }
  queueFollowUp(st, {
    source: followUp.source ?? 'cli',
    mode: 'followUp',
    text: followUp.text,
    sessionId: followUp.freshSession ? undefined : (followUp.sessionId ?? resumableSessionId(task, st)),
  });
  if (TERMINAL_TASK_STATES.has(st.state) || st.state === 'needs_input') {
    st.state = 'pending';
    st.reason = undefined;
    st.message = undefined;
    st.blockedBy = undefined;
    st.endedAt = undefined;
    st.retryNotBefore = undefined;
    st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
  }
  if (!rerun.includes(st.id)) rerun.push(st.id);
}

/** Mutates `run` so the scheduler can continue it. Running attempts become `interrupted`. */
export async function reconcileForResume(run: WorkflowRun, opts: ResumeOptions = {}): Promise<ResumeReconciliation> {
  const notes: string[] = [];
  const rerun: string[] = [];
  const orphansKilled: number[] = [];
  const retryFailed = opts.retryFailed ?? true;
  const named = new Set([...(opts.selection?.only ?? []), ...(opts.selection?.from ?? [])]);
  // A run written before follow-ups were records still has its answer in `userInput` alone; give it the
  // delivery it always was, so this resume reads the task the same way a run started today would.
  for (const st of Object.values(run.tasks)) adoptLegacyFollowUp(st);

  for (const st of Object.values(run.tasks)) {
    switch (st.state) {
      case 'running':
      case 'waiting': {
        st.pendingInteraction = undefined;
        const a = st.attempts.find((x) => x.number === st.currentAttempt) ?? st.attempts[st.attempts.length - 1];
        if (a && a.pid && isProcessAlive(a.pid)) {
          await killTree(a.pid, true).catch(() => undefined);
          orphansKilled.push(a.pid);
          notes.push(`killed orphaned worker pid ${a.pid} for "${st.id}"`);
        }
        if (a && !a.outcome) {
          a.outcome = 'interrupted';
          a.endedAt = a.endedAt ?? nowIso();
          a.error = a.error ?? 'orchestrator stopped while the attempt was running';
        }
        st.state = 'pending';
        st.currentAttempt = undefined;
        st.reason = undefined;
        st.message = undefined;
        rerun.push(st.id);
        break;
      }
      case 'ready':
        st.state = 'pending';
        st.retryNotBefore = undefined;
        rerun.push(st.id);
        break;
      case 'failed':
      case 'cancelled':
        if (st.state === 'failed' && !retryFailed) break;
        st.state = 'pending';
        st.reason = undefined;
        st.message = undefined;
        st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
        rerun.push(st.id);
        break;
      case 'blocked':
        st.state = 'pending';
        st.reason = undefined;
        st.message = undefined;
        st.blockedBy = undefined;
        break;
      case 'skipped':
        if (st.reason === 'when_false' || st.reason === 'not_selected') {
          st.state = 'pending';
          st.reason = undefined;
          st.message = undefined;
        }
        break;
      case 'awaiting_approval':
        if (opts.approve?.includes(st.id)) {
          st.state = 'pending';
          st.approval = { decision: 'approved', at: nowIso() };
          notes.push(`"${st.id}" approved`);
        } else if (opts.reject?.includes(st.id)) {
          st.state = 'pending';
          st.approval = { decision: 'rejected', at: nowIso() };
          notes.push(`"${st.id}" rejected`);
        } else {
          st.state = 'pending';
          notes.push(`"${st.id}" still requires approval (use --approve ${st.id} or --reject ${st.id})`);
        }
        break;
      case 'needs_input':
        if (opts.input && opts.input.taskId === st.id) {
          queueFollowUp(st, {
            source: 'cli',
            mode: 'followUp',
            text: opts.input.text,
            sessionId: resumableSessionId(taskDef(run, st.id), st),
          });
          st.state = 'pending';
          st.reason = undefined;
          st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
          rerun.push(st.id);
        } else if (named.has(st.id)) {
          // Named without an answer: the operator asked for the task itself again, so start it over.
          st.state = 'pending';
          st.reason = undefined;
          st.message = undefined;
          st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
          rerun.push(st.id);
        } else {
          // Left holding its question. Restarting it unanswered would spend a whole attempt to arrive back
          // at the same question, so the run stays paused on it and says how to answer it - and how to run
          // it again anyway, for an operator holding a question they cannot answer.
          notes.push(`"${st.id}" still needs input: cao resume ${run.runId} --task ${st.id} --input "<your answer>" (or --task ${st.id} on its own to run it again from the top)`);
        }
        break;
      default:
        break;
    }
  }

  // Explicit selection on resume forces the named tasks to re-run even if they succeeded.
  if (opts.selection) {
    const named = [...(opts.selection.only ?? []), ...(opts.selection.from ?? [])];
    for (const id of named) {
      const st = run.tasks[id];
      if (st && (st.state === 'success' || st.state === 'skipped')) {
        st.state = 'pending';
        st.reason = undefined;
        st.message = undefined;
        st.result = undefined;
        // Asking for an approval gate again means asking the human again: the scheduler honours a recorded
        // decision rather than re-gating, so leaving the old one here would approve it without a word.
        st.approval = undefined;
        st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
        rerun.push(id);
      }
    }
    run.selection = opts.selection;
  }

  if (opts.followUp) applyFollowUp(run, opts.followUp, rerun, notes);

  run.resumeCount += 1;
  run.state = run.state === 'cancelled' ? 'cancelled' : run.state;
  // "rerun" lists tasks that had already started; tasks that never ran simply continue normally.
  const rerunStarted = [...new Set(rerun)].filter((id) => (run.tasks[id]?.attempts.length ?? 0) > 0);
  return { rerun: rerunStarted, notes, orphansKilled };
}
