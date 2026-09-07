/** Creates new runs and reconciles persisted runs for `cao resume`. */
import type { WorkflowRun, RunSelection, TaskRunState } from '../types/run.js';
import type { ResolvedWorkflow } from '../types/workflow.js';
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
  selection?: RunSelection;
}

export interface ResumeReconciliation {
  rerun: string[];
  notes: string[];
  orphansKilled: number[];
}

/** Mutates `run` so the scheduler can continue it. Running attempts become `interrupted`. */
export async function reconcileForResume(run: WorkflowRun, opts: ResumeOptions = {}): Promise<ResumeReconciliation> {
  const notes: string[] = [];
  const rerun: string[] = [];
  const orphansKilled: number[] = [];
  const retryFailed = opts.retryFailed ?? true;

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
          st.userInput = opts.input.text;
          st.state = 'pending';
          st.reason = undefined;
          st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
          rerun.push(st.id);
        } else {
          st.state = 'pending';
          notes.push(`"${st.id}" still needs input (use --input "<text>" --task ${st.id})`);
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
        st.retryWindowStart = (st.attempts[st.attempts.length - 1]?.number ?? 0) + 1;
        rerun.push(id);
      }
    }
    run.selection = opts.selection;
  }

  run.resumeCount += 1;
  run.state = run.state === 'cancelled' ? 'cancelled' : run.state;
  // "rerun" lists tasks that had already started; tasks that never ran simply continue normally.
  const rerunStarted = [...new Set(rerun)].filter((id) => (run.tasks[id]?.attempts.length ?? 0) > 0);
  return { rerun: rerunStarted, notes, orphansKilled };
}
