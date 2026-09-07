/**
 * WorkflowScheduler: the deterministic engine. A single loop owns all task state; runners, the
 * workspace manager and the store are injected so the scheduler is testable without a TTY or Claude.
 *
 * Invariants
 *  - persist-before-act: a task is saved as `running` before its worker is spawned
 *  - attempt numbers are monotonic per task and never reused
 *  - a process exit code is never a result; only a validated TaskResult produces `success`
 */
import path from 'node:path';
import type { WorkflowRun, TaskRunState, TaskAttempt, TaskState, TaskReason, AttemptOutcome, RunSummary, LiveStatus, WorkspaceInfo } from '../types/run.js';
import { TERMINAL_TASK_STATES, ACTIVE_TASK_STATES } from '../types/run.js';
import type { ResolvedTask, ResolvedWorkflow, WorkspaceMode } from '../types/workflow.js';
import type { AttemptDiff, EnrichedTaskResult, GitInfo, TaskResult, RunnerUsage } from '../types/result.js';
import { transcriptLine, type TranscriptEntry } from '../types/transcript.js';
import { describeAnswer, toInteractionRecord, type Interaction, type InteractionAnswer, type InteractionAnswerSource, type InteractionRecord } from '../types/interaction.js';
import { sanitizeText } from '../util/text.js';
import { formatDuration } from '../util/duration.js';
import type { RunStore } from '../persistence/run-store.js';
import { OLDER_PAGE, readOlderAcrossAttempts, readOlderEntries, readTranscriptFile } from '../persistence/transcript-log.js';
import type { RunnerRegistry, RunnerOutcome, RunnerHooks } from '../runners/task-runner.js';
import type { WorkspaceManager, FinalizeResult } from '../workspace/workspace-manager.js';
import type { EventBus } from '../events/event-bus.js';
import type { HookRunner } from '../execution/hooks.js';
import { noopHookRunner } from '../execution/hooks.js';
import { ContextBuilder } from '../context/context-builder.js';
import { evaluateWhen } from '../conditions/evaluator.js';
import { assertRunTransition, assertTaskTransition, summarize } from './states.js';
import { buildReport, renderReportMarkdown } from './report.js';
import { TaskGraph } from './graph.js';
import { effectiveWorkspace } from './validator.js';
import { AsyncQueue, RingBuffer } from '../util/async-queue.js';
import { nowIso, systemClock, type Clock } from '../util/misc.js';
import type { Logger } from '../logging/logger.js';
import { silentLogger } from '../logging/logger.js';
import type { WorkflowCompletionStore } from './completion-store.js';
import { readJsonIfExists } from '../util/fs.js';

export type StopCause = 'signal' | 'on_failure' | 'pause';

type Wake =
  | { kind: 'attempt_done'; taskId: string; attempt: number; outcome: RunnerOutcome }
  | { kind: 'finalized'; taskId: string; attempt: number; fin: FinalizeResult | undefined }
  | { kind: 'approval'; taskId: string; decision: 'approved' | 'rejected'; note?: string }
  | { kind: 'retry_due' }
  | { kind: 'stop'; mode: 'wait' | 'cancel'; cause: StopCause }
  | { kind: 'restart'; taskId: string };

export interface SchedulerDeps {
  run: WorkflowRun;
  store: RunStore;
  runners: RunnerRegistry;
  workspace: WorkspaceManager;
  bus: EventBus;
  context?: ContextBuilder;
  hooks?: HookRunner;
  clock?: Clock;
  logger?: Logger;
  /** Runtime environment for workers (never persisted). */
  environment?: Record<string, string>;
  /** Interactive approval handler; when absent the run pauses on approval gates. */
  approvalHandler?: (task: ResolvedTask) => Promise<{ decision: 'approved' | 'rejected'; note?: string } | 'defer'>;
  /**
   * Answers a worker's permission prompt or question. When absent, every prompt is denied immediately
   * (headless runs). `signal` aborts when the worker withdraws the request or exits.
   */
  interactionHandler?: (interaction: Interaction, signal: AbortSignal) => Promise<InteractionAnswer>;
  isResume?: boolean;
  completion?: WorkflowCompletionStore;
}

export interface SchedulerResult {
  state: WorkflowRun['state'];
  exitCode: number;
  summary: RunSummary;
}

/** A workspace that takes longer than this to prepare gets a warning, so a long checkout is not mistaken for a stuck worker. */
const SLOW_WORKSPACE_MS = 30_000;

const FAILURE_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(['failed', 'timeout', 'crash', 'api_error', 'invalid_result', 'merge_conflict']);

/**
 * Failures that count against `retry.attempts` in the current retry window. A run of consecutive `api_error`
 * attempts is free up to `retry.transientAttempts` (they are recovered by resuming the session); the attempt
 * that exceeds the transient budget counts as one real failure and starts a fresh transient budget.
 *
 * Exported so the dashboard can label a waiting row with the same counters the scheduler is spending.
 */
export function budgetedFailures(state: TaskRunState, task: ResolvedTask): { counted: number; transientStreak: number } {
  let counted = 0;
  let streak = 0;
  for (let i = 0; i < state.attempts.length; i++) {
    const a = state.attempts[i]!;
    if (a.number < state.retryWindowStart || a.kind !== 'task' || !a.outcome) continue;
    if (a.outcome === 'api_error') {
      streak++;
      if (streak > task.retry.transientAttempts) {
        counted++;
        streak = 0;
      }
    } else {
      // A session asked for the completion object it forgot is the same attempt continuing, not a failure yet.
      if (a.outcome === 'invalid_result' && state.attempts[i + 1]?.triggeredBy === 'nudge') continue;
      if (FAILURE_OUTCOMES.has(a.outcome)) counted++;
      streak = 0;
    }
  }
  return { counted, transientStreak: streak };
}

/** Nudges already spent on the attempt that is being judged: the run of `nudge` attempts ending at the newest one. */
function nudgesUsed(state: TaskRunState): number {
  let n = 0;
  for (let i = state.attempts.length - 1; i >= 0 && state.attempts[i]!.triggeredBy === 'nudge'; i--) n++;
  return n;
}

/** Delay before transient recovery `n` (1-based): doubles from `baseMs`, capped at `maxMs`. */
export function transientBackoffMs(n: number, baseMs: number, maxMs: number): number {
  const exp = Math.max(0, Math.min(n - 1, 16));
  return Math.min(maxMs, baseMs * 2 ** exp);
}

function sessionResumable(task: ResolvedTask): boolean {
  return task.retry.resumeSession && (task.agent !== 'claude' || task.claude.sessionPersistence !== false);
}

/**
 * A hook environment value derived from agent-controlled text (an interaction title is, for Bash, the first
 * line of the command). Hooks run through a shell, so it is collapsed to one bounded line with no control
 * characters — a hook that forgets to quote the variable then has much less to work with.
 */
function hookValue(text: string): string {
  return sanitizeText(text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Prompt for a resumed session: the transcript already holds the task and context, so only explain the interruption. */
function resumePrompt(previous: TaskAttempt | undefined): string {
  const detail = previous?.error?.split('\n')[0]?.trim();
  return [
    '# Session Resumed',
    `Your previous turn in this session was cut short by a transient API error${detail ? ` (${detail})` : ''}. The task and its context are unchanged.`,
    'Continue exactly where you left off. Re-check the working tree if you are unsure what was already done, finish the remaining work, and end with the single JSON completion object required by the contract.',
  ].join('\n\n');
}

/** Prompt for a nudge: the session did the work but ended without the completion object, so ask for only that. */
function nudgePrompt(previous: TaskAttempt | undefined): string {
  const detail = previous?.error?.split('\n')[0]?.trim();
  return [
    '# Completion Object Required',
    `Your previous turn in this session ended without the JSON completion object the contract requires${detail ? ` (${detail})` : ''}.`,
    'Do no further work. Reply now with only the single JSON object describing what you already did, with no prose around it:',
    '{"status":"success|failed|blocked|needs_input|skipped","summary":"...","filesChanged":["..."],"commits":["..."],"decisions":["..."],"warnings":["..."],"followUp":["..."],"error":"..."}',
  ].join('\n\n');
}

export function exitCodeFor(state: WorkflowRun['state']): number {
  switch (state) {
    case 'completed':
      return 0;
    case 'paused':
      return 3;
    case 'interrupted':
      return 130;
    default:
      return 1;
  }
}

export class WorkflowScheduler {
  readonly run: WorkflowRun;
  private readonly workflow: ResolvedWorkflow;
  private readonly store: RunStore;
  private readonly runners: RunnerRegistry;
  private readonly workspace: WorkspaceManager;
  private readonly bus: EventBus;
  private readonly context: ContextBuilder;
  private readonly hooks: HookRunner;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly environment: Record<string, string>;
  private readonly approvalHandler?: SchedulerDeps['approvalHandler'];
  private readonly interactionHandler?: SchedulerDeps['interactionHandler'];
  private readonly isResume: boolean;
  private readonly completion?: WorkflowCompletionStore;

  private readonly taskDefs: Map<string, ResolvedTask>;
  private readonly graph: TaskGraph;
  private readonly topo: string[];
  private readonly parallelLayerTasks: Set<string>;
  private readonly wake = new AsyncQueue<Wake>();
  private readonly inflight = new Map<
    string,
    {
      attempt: number;
      abort: AbortController;
      release?: () => void;
      workspace?: WorkspaceInfo;
      kind: 'task' | 'merge';
      /** Merge attempts only: the git block of the task's own attempt, which finalizing the merge cannot rebuild. */
      priorGit?: GitInfo;
    }
  >();
  private readonly buffers = new Map<string, RingBuffer<TranscriptEntry>>();
  private readonly pendingApprovals = new Set<string>();
  /** Merge-resolution sessions waiting for the shared tree, which another attempt owns right now. */
  private readonly pendingMerges = new Map<string, { task: ResolvedTask; state: TaskRunState; attempt: TaskAttempt; fin: FinalizeResult }>();
  /** taskId -> still-open interactions by request id; a worker can block on several at once (parallel tool calls). */
  private readonly openInteractions = new Map<string, Map<string, InteractionRecord>>();
  private stop?: { mode: 'wait' | 'cancel'; cause: StopCause };
  private retryTimer: unknown;
  private liveTimer: unknown;
  private liveDirty = false;
  private lastLiveWrite = 0;
  private heartbeatTimer: unknown;
  private finished = false;

  constructor(deps: SchedulerDeps) {
    this.run = deps.run;
    this.workflow = deps.run.workflow;
    this.store = deps.store;
    this.runners = deps.runners;
    this.workspace = deps.workspace;
    this.bus = deps.bus;
    this.context = deps.context ?? new ContextBuilder();
    this.hooks = deps.hooks ?? noopHookRunner;
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? silentLogger;
    this.environment = deps.environment ?? {};
    this.approvalHandler = deps.approvalHandler;
    this.interactionHandler = deps.interactionHandler;
    this.isResume = deps.isResume ?? false;
    this.completion = deps.completion;
    this.taskDefs = new Map(this.workflow.tasks.map((t) => [t.id, t]));
    this.graph = new TaskGraph(this.workflow.tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn, docIndex: t.docIndex })));
    const layers = this.graph.layers();
    this.topo = layers.flat();
    this.parallelLayerTasks = new Set(layers.filter((l) => l.length > 1).flat());
    for (const t of this.workflow.tasks) {
      if (!this.run.tasks[t.id]) this.run.tasks[t.id] = { id: t.id, state: 'pending', attempts: [], retryWindowStart: 1 };
      if (t.completed && this.run.tasks[t.id]!.state === 'pending') {
        const state = this.run.tasks[t.id]!;
        state.state = 'success';
        state.startedAt = t.completed.completedAt;
        state.endedAt = t.completed.completedAt;
        state.message = `completed in workflow${t.completed.completedAt ? ` (${t.completed.completedAt})` : ''}`;
      }
    }
  }

  // ------------------------------------------------------------------ public API

  requestStop(mode: 'wait' | 'cancel', cause: StopCause = 'signal'): void {
    this.wake.push({ kind: 'stop', mode, cause });
  }

  /** Dashboard-only manual retry for terminal tasks while the workflow remains active. */
  requestRestart(taskId: string): void {
    this.wake.push({ kind: 'restart', taskId });
  }

  /** Recent transcript entries of a task (in-process; other terminals read the attempt's events.jsonl). */
  peek(taskId: string, entries = 50): TranscriptEntry[] {
    return this.buffers.get(taskId)?.last(entries) ?? [];
  }

  /** Everything buffered for a task (bounded by execution.outputBufferLines). */
  transcript(taskId: string): TranscriptEntry[] {
    return this.buffers.get(taskId)?.toArray() ?? [];
  }

  /**
   * One attempt's transcript, read from its `events.jsonl`. The in-memory buffer is per task and keeps only
   * the newest `outputBufferLines` entries across every attempt, so an earlier attempt can only come from
   * disk — which is also where `cao logs --follow` reads it, so both views show the same thing.
   */
  async attemptTranscript(taskId: string, attempt: number): Promise<TranscriptEntry[]> {
    const entries = await readTranscriptFile(this.attemptEventsFile(taskId, attempt));
    return entries.slice(-this.workflow.execution.outputBufferLines);
  }

  /**
   * The page of entries just before `oldest` in an attempt's `events.jsonl`, so scrolling above the oldest
   * buffered entry reaches the rest of the transcript instead of stopping at the ring buffer's edge.
   */
  async olderTranscript(taskId: string, attempt: number, oldest: TranscriptEntry | undefined, count = OLDER_PAGE): Promise<TranscriptEntry[]> {
    return readOlderEntries(this.attemptEventsFile(taskId, attempt), oldest, count);
  }

  /**
   * The same, for the dashboard's live follow view, whose buffer is the task's — every attempt of it, not
   * one. `oldest` there usually belongs to an earlier attempt than the one running, so the search walks back
   * through the attempt files and keeps paging into the attempt before when it reaches a beginning.
   */
  async olderTaskTranscript(taskId: string, attempt: number, oldest: TranscriptEntry | undefined, count = OLDER_PAGE): Promise<TranscriptEntry[]> {
    const files: string[] = [];
    for (let n = attempt; n >= 1; n -= 1) files.push(this.attemptEventsFile(taskId, n));
    return readOlderAcrossAttempts(files, oldest, count);
  }

  private attemptEventsFile(taskId: string, attempt: number): string {
    return path.join(this.store.paths.attemptDir(this.run.runId, taskId, attempt), 'events.jsonl');
  }

  /**
   * The diff the task's newest finished attempt captured, for the dashboard's review view: `diff.json` and
   * the `diff.patch` beside it. Null when nothing was captured (`git.captureDiff: false`, or no attempt has
   * finished yet). A merge-resolution attempt is skipped, exactly as `cao diff` skips it: its patch spans
   * the whole merge, which is never the answer to "what did this task change".
   */
  async capturedDiff(taskId: string): Promise<{ attempt: number; diff: AttemptDiff; patch: string } | null> {
    const attempts = [...(this.run.tasks[taskId]?.attempts ?? [])].reverse().filter((a) => a.kind === 'task');
    for (const a of attempts) {
      const diff = await this.store.readDiff(this.run.runId, taskId, a.number).catch(() => null);
      if (diff) return { attempt: a.number, diff, patch: (await this.store.readDiffPatch(this.run.runId, taskId, a.number).catch(() => null)) ?? '' };
    }
    return null;
  }

  get canInteract(): boolean {
    return this.interactionHandler !== undefined;
  }

  get stopping(): boolean {
    return this.stop !== undefined;
  }

  async execute(): Promise<SchedulerResult> {
    this.transitionRun('running');
    this.run.startedAt ??= nowIso();
    this.run.orchestratorPid = process.pid;
    this.run.endedAt = undefined;
    await this.persist();
    await this.hydrateWorkflowCompletions();

    if (this.isResume) {
      const rerun = Object.values(this.run.tasks)
        .filter((t) => t.state === 'pending' && t.attempts.length > 0)
        .map((t) => t.id);
      this.bus.emit({ type: 'workflow.resumed', resumeCount: this.run.resumeCount, rerun });
    } else {
      this.bus.emit({ type: 'workflow.started', workflowName: this.run.workflowName, taskCount: this.workflow.tasks.length });
    }
    // Prepare the repository: record the base commit/branch, exclude .orchestrator/, prune stale worktrees.
    try {
      const prep = await this.workspace.prepareRun(this.run);
      if (!this.isResume || !this.run.baseCommit) {
        this.run.baseBranch = prep.baseBranch;
        this.run.baseCommit = prep.baseCommit;
      }
      for (const w of prep.warnings) this.bus.emit({ type: 'workflow.warning', code: 'workspace', message: w });
      await this.persist();
    } catch (err) {
      this.logger.error((err as Error).message);
      this.bus.emit({ type: 'workflow.warning', code: 'workspace', message: (err as Error).message });
      this.stop = { mode: 'cancel', cause: 'on_failure' };
    }
    if (!this.isResume && !this.stop) {
      try {
        await this.hooks.run('beforeWorkflow');
      } catch (err) {
        this.logger.error((err as Error).message);
        this.bus.emit({ type: 'workflow.warning', code: 'hook_failed', message: (err as Error).message });
        this.stop = { mode: 'cancel', cause: 'on_failure' };
      }
    }
    await this.applySelection();
    this.startHeartbeat();

    try {
      for (;;) {
        this.promoteReady();
        await this.launchPendingMerges();
        await this.launchReady();
        if (this.inflight.size === 0 && this.pendingApprovals.size === 0 && this.pendingMerges.size === 0 && this.wake.size === 0 && !this.hasDelayedReady()) break;
        const w = await this.wake.next();
        await this.handleWake(w);
        await this.persist();
      }
    } finally {
      this.stopHeartbeat();
    }
    return this.finalize();
  }

  /** Reuse the prior structured result when a YAML-completed dependency supplies context. */
  private async hydrateWorkflowCompletions(): Promise<void> {
    for (const task of this.workflow.tasks) {
      if (!task.completed?.runId) continue;
      const state = this.run.tasks[task.id];
      if (!state || state.result) continue;
      const result = await readJsonIfExists<EnrichedTaskResult>(this.store.paths.resultFile(task.completed.runId, task.id)).catch(() => null);
      if (result) state.result = result;
      else this.bus.emit({ type: 'workflow.warning', code: 'completion', taskId: task.id, message: `completed workflow task has no saved result in run ${task.completed.runId}; downstream context will omit it` });
    }
  }

  // ------------------------------------------------------------------ selection

  private async applySelection(): Promise<void> {
    const { only, from } = this.run.selection;
    if (!only?.length && !from?.length) return;
    const selected = new Set<string>();
    for (const id of only ?? []) selected.add(id);
    for (const id of from ?? []) {
      selected.add(id);
      for (const d of this.graph.descendants(id)) selected.add(d);
    }
    for (const id of this.topo) {
      const state = this.run.tasks[id]!;
      if (selected.has(id)) {
        // On resume an explicit selection re-runs the named tasks and, for --from, everything downstream.
        if ((this.isResume || state.message?.startsWith('completed in workflow')) && (state.state === 'success' || state.state === 'skipped' || state.state === 'failed' || state.state === 'blocked' || state.state === 'cancelled')) {
          const wasCompletedInWorkflow = state.message?.startsWith('completed in workflow') ?? false;
          this.setState(state, 'pending', undefined, 'selected for re-run');
          state.result = undefined;
          state.retryWindowStart = (state.attempts[state.attempts.length - 1]?.number ?? 0) + 1;
          if (wasCompletedInWorkflow && this.completion) {
            try { await this.completion.clear(this.taskDefs.get(id)!); }
            catch (err) { this.bus.emit({ type: 'workflow.warning', code: 'completion', taskId: id, message: `could not clear workflow completion: ${(err as Error).message}` }); }
          }
        }
        continue;
      }
      if (state.state === 'pending' || state.state === 'ready') {
        this.setState(state, 'skipped', 'not_selected', 'not selected by --task/--from');
        this.bus.emit({ type: 'task.skipped', taskId: id, reason: 'not_selected', message: state.message });
      }
    }
  }

  // ------------------------------------------------------------------ readiness

  private depSatisfied(task: ResolvedTask, depId: string): 'wait' | 'ok' | 'blocked' {
    const dep = this.run.tasks[depId];
    if (!dep) return 'blocked';
    if (!TERMINAL_TASK_STATES.has(dep.state)) return 'wait';
    if (dep.state === 'success' || dep.state === 'skipped') return 'ok';
    if (task.runIfDependencyFailed) return 'ok';
    const depDef = this.taskDefs.get(depId);
    if (depDef?.onFailure === 'continue' && dep.state === 'failed') return 'ok';
    return 'blocked';
  }

  private promoteReady(): void {
    // Once a stop is requested nothing is promoted; finalize() cancels what is left with a clear reason.
    if (this.stop) return;
    for (const id of this.topo) {
      const state = this.run.tasks[id]!;
      if (state.state !== 'pending') continue;
      const task = this.taskDefs.get(id)!;
      let blockedBy: string | undefined;
      let wait = false;
      for (const dep of task.dependsOn) {
        const r = this.depSatisfied(task, dep);
        if (r === 'wait') {
          wait = true;
          break;
        }
        if (r === 'blocked') {
          blockedBy = dep;
          break;
        }
      }
      if (wait) continue;
      if (blockedBy) {
        const depState = this.run.tasks[blockedBy]!;
        const reason: TaskReason = depState.state === 'skipped' ? 'upstream_skipped' : 'upstream_failed';
        this.setState(state, 'blocked', reason, `dependency "${blockedBy}" ${depState.state}`);
        state.blockedBy = blockedBy;
        this.bus.emit({ type: 'task.blocked', taskId: id, reason, by: blockedBy, message: state.message });
        continue;
      }
      if (this.stop) continue;
      if (task.when) {
        let ok = false;
        try {
          ok = evaluateWhen(task.when, this.conditionScope(task));
        } catch (err) {
          this.setState(state, 'failed', 'crash', `when evaluation failed: ${(err as Error).message}`);
          this.bus.emit({ type: 'task.failed', taskId: id, attempt: 0, outcome: 'crash', reason: 'crash', message: state.message, final: true });
          this.applyOnFailure(task);
          continue;
        }
        if (!ok) {
          this.setState(state, 'skipped', 'when_false', 'condition evaluated to false');
          this.bus.emit({ type: 'task.skipped', taskId: id, reason: 'when_false', message: state.message });
          continue;
        }
      }
      if (task.isApproval) {
        this.setState(state, 'awaiting_approval');
        this.bus.emit({ type: 'task.awaiting_approval', taskId: id, prompt: task.prompt });
        if (this.approvalHandler) {
          this.pendingApprovals.add(id);
          void this.approvalHandler(task).then(
            (res) => {
              this.pendingApprovals.delete(id);
              if (res === 'defer') this.wake.push({ kind: 'stop', mode: 'wait', cause: 'pause' });
              else this.wake.push({ kind: 'approval', taskId: id, decision: res.decision, note: res.note });
            },
            () => {
              this.pendingApprovals.delete(id);
              this.wake.push({ kind: 'stop', mode: 'wait', cause: 'pause' });
            },
          );
        } else {
          this.stop = { mode: 'wait', cause: 'pause' };
          this.bus.emit({ type: 'workflow.paused', reason: 'approval', taskIds: [id] });
        }
        continue;
      }
      this.setState(state, 'ready');
      this.bus.emit({ type: 'task.ready', taskId: id });
    }
  }

  private conditionScope(task: ResolvedTask): Record<string, unknown> {
    const tasks: Record<string, unknown> = {};
    for (const [id, st] of Object.entries(this.run.tasks)) {
      tasks[id] = { ...(st.result ?? {}), status: st.state, state: st.state, reason: st.reason, attempts: st.attempts.length };
    }
    return { tasks, variables: this.workflow.variables, vars: this.workflow.variables, env: this.environment, item: task.vars.item, index: task.vars.index, ...task.vars };
  }

  private hasDelayedReady(): boolean {
    return Object.values(this.run.tasks).some((t) => t.state === 'ready' && !this.stop);
  }

  // ------------------------------------------------------------------ launching

  private async launchReady(): Promise<void> {
    if (this.stop) return;
    const now = this.clock.now();
    let earliest: number | undefined;
    const ready = this.topo.filter((id) => this.run.tasks[id]!.state === 'ready');
    for (const id of ready) {
      if (this.inflight.size >= this.workflow.execution.maxConcurrency) break;
      const state = this.run.tasks[id]!;
      if (state.retryNotBefore) {
        const due = new Date(state.retryNotBefore).getTime();
        if (due > now) {
          earliest = earliest === undefined ? due : Math.min(earliest, due);
          continue;
        }
      }
      const task = this.taskDefs.get(id)!;
      let release: (() => void) | undefined;
      if (this.workspaceMode(task) === 'shared' && !this.workflow.execution.allowUnsafeSharedParallel) {
        // Never wait for the shared tree here: the attempt holding it can only release it through this loop.
        // With allowUnsafeSharedParallel the operator has said the tasks may share the tree, so no lock is
        // taken at all: taking it would queue them one behind the other, which is exactly what the flag waives.
        release = this.workspace.tryLockShared();
        if (!release) continue;
      }
      await this.launch(task, release);
    }
    if (earliest !== undefined && this.retryTimer === undefined) {
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = undefined;
        this.wake.push({ kind: 'retry_due' });
      }, Math.max(1, earliest - now));
    }
  }

  /** Which workspace a task gets: its own worktree when it may run beside another task, else the shared tree. */
  private workspaceMode(task: ResolvedTask): WorkspaceMode {
    const parallel = this.parallelLayerTasks.has(task.id) && this.workflow.execution.maxConcurrency > 1;
    return effectiveWorkspace(task, this.workflow, parallel);
  }

  /**
   * A line from the orchestrator in a task's transcript, for the stretch before the worker says anything
   * itself: the activity cell would otherwise show a launching task as idle. Not part of the attempt's
   * events.jsonl, which the runner owns.
   */
  private note(taskId: string, attempt: number, text: string): void {
    const entry: TranscriptEntry = { kind: 'system', ts: nowIso(), text };
    this.bufferFor(taskId).push(entry);
    const state = this.run.tasks[taskId];
    if (state) state.lastActivity = text;
    this.bus.emit({ type: 'task.transcript', taskId, attempt, entry });
    this.markLive(false);
  }

  /** `release` is the shared-tree lock `launchReady` already holds for a shared-mode task. */
  private async launch(task: ResolvedTask, release?: () => void): Promise<void> {
    const state = this.run.tasks[task.id]!;
    if (state.state !== 'ready' || this.inflight.has(task.id)) {
      release?.();
      throw new Error(`Internal error: attempted to launch "${task.id}" while ${state.state}/inflight`);
    }
    const lastAttempt = state.attempts[state.attempts.length - 1];
    const number = (lastAttempt?.number ?? 0) + 1;
    const mode = this.workspaceMode(task);
    // After a transient API error the worker's session is intact: continue it instead of starting over. The
    // same goes for a session that finished its turn without the completion object: it is asked for just that.
    const resumable = lastAttempt?.outcome === 'api_error' || lastAttempt?.outcome === 'invalid_result';
    const resumeSessionId = resumable && sessionResumable(task) ? state.resumeSessionId : undefined;
    const nudge = resumeSessionId !== undefined && lastAttempt?.outcome === 'invalid_result';
    state.resumeSessionId = undefined;
    const triggeredBy: TaskAttempt['triggeredBy'] = state.userInput && lastAttempt
      ? 'user_input'
      : lastAttempt
        ? nudge
          ? 'nudge'
          : this.isResume && (lastAttempt.outcome === 'interrupted' || lastAttempt.outcome === 'cancelled')
            ? 'resume'
            : 'retry'
        : 'initial';
    const attempt: TaskAttempt = { number, kind: 'task', triggeredBy, startedAt: nowIso(), cwd: task.workingDirectory };
    if (resumeSessionId) attempt.resumedSessionId = resumeSessionId;
    state.attempts.push(attempt);
    state.currentAttempt = number;
    state.retryNotBefore = undefined;
    state.startedAt ??= attempt.startedAt;
    state.endedAt = undefined;
    this.setState(state, 'running');
    await this.persist(); // persist-before-act

    const abort = new AbortController();
    const entry: (typeof this.inflight extends Map<string, infer V> ? V : never) = { attempt: number, abort, kind: 'task' };
    this.inflight.set(task.id, entry);

    try {
      entry.release = release;
      const previousWs = [...state.attempts].reverse().find((a) => a.number < number && a.kind === 'task' && a.workspace?.kind === 'worktree')?.workspace;
      this.note(task.id, number, mode === 'worktree' ? 'preparing worktree' : 'preparing workspace');
      const acquireStart = this.clock.now();
      const ws = await this.workspace.acquire(task, number, mode, this.run, previousWs, { preserve: Boolean(resumeSessionId) });
      const acquireMs = this.clock.now() - acquireStart;
      if (acquireMs > SLOW_WORKSPACE_MS) {
        this.bus.emit({ type: 'workflow.warning', code: 'workspace', taskId: task.id, message: `workspace for "${task.id}" took ${formatDuration(acquireMs)} to prepare` });
      }
      entry.workspace = ws;
      attempt.workspace = ws;
      attempt.cwd = ws.cwd;

      const previousFailed = [...state.attempts].reverse().find((a) => a.number < number && a.kind === 'task' && a.outcome && FAILURE_OUTCOMES.has(a.outcome));
      const ctx = this.context.build({
        task,
        tasks: this.run.tasks,
        taskDefs: this.taskDefs,
        previousAttempt: resumeSessionId ? undefined : previousFailed,
        previousOutputTail: previousFailed && !resumeSessionId ? this.buffers.get(task.id)?.last(30).map(transcriptLine) : undefined,
        userInput: state.userInput,
      });
      for (const w of ctx.warnings) this.bus.emit({ type: 'workflow.warning', code: 'context', message: w, taskId: task.id });
      const prompt = resumeSessionId ? (nudge ? nudgePrompt(lastAttempt) : resumePrompt(lastAttempt)) : ContextBuilder.compose(ctx.markdown, task.prompt);
      await this.store.writeContext(this.run.runId, task.id, ctx.markdown);
      await this.store.writePrompt(this.run.runId, task.id, number, prompt);
      await this.store.writeAttempt(this.run.runId, task.id, attempt);
      this.bus.emit({ type: 'task.started', taskId: task.id, attempt: number, cwd: ws.cwd, workspace: ws });
      if (this.workflow.hooks.beforeTask.length) this.note(task.id, number, 'running beforeTask hook');
      await this.hooks.run('beforeTask', { taskId: task.id, env: this.hookEnv(task, ws) });

      const attemptDir = await this.store.attemptDir(this.run.runId, task.id, number);
      const runner = this.runners.get(task.runner);
      this.note(task.id, number, nudge ? `asking ${task.agent} for the completion object` : resumeSessionId ? `resuming ${task.agent} session` : `starting ${task.agent}`);
      const promise = runner.run(
        {
          runId: this.run.runId,
          task,
          attempt: number,
          prompt,
          cwd: ws.cwd,
          env: { ...this.environment, ...task.env, CAO_RUN_ID: this.run.runId, CAO_TASK_ID: task.id, CAO_ATTEMPT: String(number) },
          timeoutMs: task.timeoutMs,
          signal: abort.signal,
          attemptDir,
          resumeSessionId,
          canInteract: this.canInteract,
        },
        this.runnerHooks(task.id, number),
      );
      promise.then(
        (outcome) => this.wake.push({ kind: 'attempt_done', taskId: task.id, attempt: number, outcome }),
        (err) => this.wake.push({ kind: 'attempt_done', taskId: task.id, attempt: number, outcome: { kind: 'error', outcome: 'crash', message: `runner threw: ${(err as Error).message}` } }),
      );
    } catch (err) {
      this.wake.push({ kind: 'attempt_done', taskId: task.id, attempt: number, outcome: { kind: 'error', outcome: 'crash', message: (err as Error).message } });
    }
  }

  private runnerHooks(taskId: string, attempt: number): RunnerHooks {
    const buffer = this.bufferFor(taskId);
    const attemptOf = (): TaskAttempt | undefined => this.run.tasks[taskId]?.attempts.find((x) => x.number === attempt);
    return {
      onActivity: (line) => {
        const state = this.run.tasks[taskId];
        if (state) state.lastActivity = line;
        this.bus.emit({ type: 'task.activity', taskId, attempt, line });
        this.markLive(false);
      },
      onOutput: (stream, line) => {
        this.bus.emit({ type: 'task.output', taskId, attempt, stream, line });
      },
      onTranscript: (entry) => {
        buffer.push(entry);
        this.bus.emit({ type: 'task.transcript', taskId, attempt, entry });
        this.markLive(false);
      },
      onUsage: (usage) => {
        const a = attemptOf();
        if (a) a.usage = { ...a.usage, ...usage };
        this.bus.emit({ type: 'task.usage', taskId, attempt, usage });
        this.markLive(false);
      },
      onFileChange: ({ path: filePath, op }) => {
        const a = attemptOf();
        if (!a) return;
        const rel = this.relativePath(filePath, a.cwd);
        a.files ??= {};
        const touch = a.files[rel] ?? { ops: 0, lastOp: op };
        touch.ops += 1;
        touch.lastOp = op;
        a.files[rel] = touch;
        this.bus.emit({ type: 'task.files', taskId, attempt, path: rel, op, count: Object.keys(a.files).length });
        this.markLive(false);
      },
      onInteraction: (interaction, signal) => this.handleInteraction(taskId, attempt, interaction, signal),
      onWarning: (message) => {
        this.bus.emit({ type: 'workflow.warning', code: 'permission', taskId, message });
      },
      onProcess: ({ pid, sessionId }) => {
        const state = this.run.tasks[taskId];
        const a = state?.attempts.find((x) => x.number === attempt);
        if (a) {
          if (a.pid !== pid) {
            a.pid = pid;
            this.bus.emit({ type: 'task.process', taskId, attempt, pid });
          }
          if (sessionId) a.sessionId = sessionId;
        }
        // Persist promptly so a crashed orchestrator can still find (and kill) orphaned workers on resume.
        void this.persist().catch(() => undefined);
        this.markLive(true);
      },
    };
  }

  private bufferFor(taskId: string): RingBuffer<TranscriptEntry> {
    let b = this.buffers.get(taskId);
    if (!b) {
      b = new RingBuffer<TranscriptEntry>(this.workflow.execution.outputBufferLines);
      this.buffers.set(taskId, b);
    }
    return b;
  }

  /** Paths are shown relative to the repository root (worktree paths map onto the same relative path). */
  private relativePath(filePath: string, cwd: string): string {
    const norm = (p: string): string => p.replace(/\\/g, '/');
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    for (const root of [cwd, this.workflow.repositoryRoot]) {
      const rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return norm(rel);
    }
    return norm(filePath);
  }

  /** The oldest request a task is still blocked on — the one a dashboard is showing. */
  private refreshPending(taskId: string): void {
    const state = this.run.tasks[taskId];
    if (!state) return;
    const open = this.openInteractions.get(taskId);
    state.pendingInteraction = open?.size ? [...open.values()][0] : undefined;
  }

  /** Every request a task is blocked on is settled elsewhere; drop the bookkeeping (attempt end, interrupt). */
  private clearInteractions(taskId: string): void {
    this.openInteractions.delete(taskId);
    const state = this.run.tasks[taskId];
    if (state) state.pendingInteraction = undefined;
  }

  /**
   * A worker is blocked on a human. The task shows as `waiting` until every open request has been answered,
   * the timeout elapses, or the worker withdraws it. Without a handler the prompt is denied at once.
   */
  private async handleInteraction(taskId: string, attempt: number, interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer> {
    const state = this.run.tasks[taskId];
    const a = state?.attempts.find((x) => x.number === attempt);
    const task = this.taskDefs.get(taskId);
    const record = toInteractionRecord(interaction);
    if (a) (a.interactions ??= []).push(record);
    this.bus.emit({ type: 'task.interaction.requested', taskId, attempt, interaction });
    const finish = (answer: InteractionAnswer, source: InteractionAnswerSource): InteractionAnswer => {
      record.answeredAt = nowIso();
      record.answer = describeAnswer(answer);
      record.source = source;
      const open = this.openInteractions.get(taskId);
      if (open?.delete(interaction.id)) {
        if (open.size === 0) this.openInteractions.delete(taskId);
        this.refreshPending(taskId);
        // Only leave `waiting` once nothing else is blocking the worker: answering the second of two
        // concurrent prompts must not report the task as running while the first still holds it.
        if (state && !state.pendingInteraction && state.state === 'waiting' && state.currentAttempt === attempt) this.setState(state, 'running');
      }
      this.bus.emit({ type: 'task.interaction.answered', taskId, attempt, id: interaction.id, answer, source });
      void this.persist().catch(() => undefined);
      this.markLive(true);
      return answer;
    };
    const deny = (message: string): InteractionAnswer => ({ kind: 'deny', message: `${message}; finish with status needs_input if you cannot continue` });
    if (!this.interactionHandler || !state || !a || state.currentAttempt !== attempt) {
      return finish(deny(`No human is available to answer ${interaction.title}`), 'no_handler');
    }
    if (state.state === 'running') this.setState(state, 'waiting');
    const open = this.openInteractions.get(taskId) ?? new Map<string, InteractionRecord>();
    this.openInteractions.set(taskId, open);
    open.set(interaction.id, record);
    this.refreshPending(taskId);
    await this.persist().catch(() => undefined);
    if (task) {
      void this.hooks
        .run('onInputRequired', {
          taskId,
          taskState: 'waiting',
          env: {
            ...this.hookEnv(task, a.workspace),
            CAO_INTERACTION_KIND: interaction.kind,
            CAO_INTERACTION_TITLE: hookValue(interaction.title),
            CAO_INTERACTION_TOOL: hookValue(interaction.toolName),
          },
        })
        .catch(() => undefined);
    }
    const timeoutMs = this.workflow.execution.interactionTimeoutMs;
    // The handler waits on its own signal, aborted whenever this request stops needing an answer: the worker
    // withdrew it, the timeout expired, or it has just been answered. A dashboard that is not told loses its
    // only cue to take the modal down, and would leave a decided prompt on screen ahead of the next one.
    const handler = new AbortController();
    let timer: unknown;
    let onAbort: (() => void) | undefined;
    try {
      const answer = await new Promise<{ answer: InteractionAnswer; source: InteractionAnswerSource }>((resolve) => {
        if (timeoutMs !== null) {
          timer = this.clock.setTimeout(() => {
            handler.abort(new Error('interaction timed out'));
            resolve({ answer: deny(`No one answered ${interaction.title} within ${formatDuration(timeoutMs)}`), source: 'timeout' });
          }, timeoutMs);
        }
        onAbort = () => {
          handler.abort(new Error('the request was withdrawn'));
          resolve({ answer: deny('The request was withdrawn'), source: 'cancelled' });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        this.interactionHandler!(interaction, handler.signal).then(
          (res) => resolve({ answer: res, source: 'handler' }),
          (err: unknown) => resolve({ answer: deny(`The dashboard could not answer (${(err as Error)?.message ?? String(err)})`), source: 'aborted' }),
        );
      });
      return finish(answer.answer, answer.source);
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      handler.abort(new Error('the request has been answered'));
    }
  }

  private hookEnv(task: ResolvedTask, ws?: WorkspaceInfo): Record<string, string> {
    const env: Record<string, string> = { CAO_RUN_ID: this.run.runId, CAO_TASK_TYPE: task.type, CAO_WORKDIR: ws?.cwd ?? task.workingDirectory };
    if (ws?.branch) env.CAO_BRANCH = ws.branch;
    return env;
  }

  // ------------------------------------------------------------------ wake handling

  private async handleWake(w: Wake): Promise<void> {
    switch (w.kind) {
      case 'attempt_done':
        await this.handleAttemptDone(w.taskId, w.attempt, w.outcome);
        break;
      case 'finalized':
        await this.handleFinalized(w.taskId, w.attempt, w.fin);
        break;
      case 'approval':
        await this.handleApproval(w.taskId, w.decision, w.note);
        break;
      case 'retry_due':
        break;
      case 'stop':
        if (!this.stop || (this.stop.mode === 'wait' && w.mode === 'cancel') || w.cause === 'signal') {
          this.stop = { mode: w.mode, cause: w.cause };
        }
        if (w.mode === 'cancel') for (const e of this.inflight.values()) e.abort.abort();
        break;
      case 'restart': {
        if (this.stop || this.inflight.has(w.taskId)) break;
        const state = this.run.tasks[w.taskId];
        if (!state || !TERMINAL_TASK_STATES.has(state.state) || state.state === 'success') break;
        this.setState(state, 'pending', undefined, 'manually restarted from dashboard');
        state.blockedBy = undefined;
        state.retryWindowStart = (state.attempts[state.attempts.length - 1]?.number ?? 0) + 1;
        this.bus.emit({ type: 'workflow.warning', code: 'restart', taskId: w.taskId, message: 'task manually restarted from dashboard' });
        await this.persist();
        break;
      }
    }
  }

  private async handleApproval(taskId: string, decision: 'approved' | 'rejected', note?: string): Promise<void> {
    const state = this.run.tasks[taskId]!;
    const task = this.taskDefs.get(taskId)!;
    if (state.state !== 'awaiting_approval') return;
    state.approval = { decision, at: nowIso(), note };
    if (decision === 'approved') {
      const result: EnrichedTaskResult = {
        taskId,
        attempt: 0,
        status: 'success',
        summary: `Approved${note ? `: ${note}` : ''}`,
        filesChanged: [],
        commits: [],
        decisions: [],
        warnings: [],
        followUp: [],
        completedAt: nowIso(),
      };
      state.result = result;
      state.endedAt = nowIso();
      this.setState(state, 'success');
      // Persist before announcing, like the task-success path: a crash right after an approval must not lose it.
      try {
        await this.completion?.markCompleted(task, { completedAt: result.completedAt, runId: this.run.runId });
      } catch (err) {
        this.bus.emit({ type: 'workflow.warning', code: 'completion', taskId, message: `task succeeded but workflow YAML was not updated: ${(err as Error).message}` });
      }
      await this.store.writeResult(this.run.runId, taskId, result).catch((err) => this.bus.emit({ type: 'workflow.warning', code: 'persist', taskId, message: `approval result not written: ${(err as Error).message}` }));
      this.bus.emit({ type: 'task.completed', taskId, attempt: 0, result });
    } else {
      state.endedAt = nowIso();
      this.setState(state, 'failed', 'rejected', note ? `rejected: ${note}` : 'rejected');
      this.bus.emit({ type: 'task.failed', taskId, attempt: 0, outcome: 'failed', reason: 'rejected', message: state.message, final: true });
      this.applyOnFailure(task);
    }
  }

  private async handleAttemptDone(taskId: string, attemptNo: number, outcome: RunnerOutcome): Promise<void> {
    const state = this.run.tasks[taskId]!;
    const task = this.taskDefs.get(taskId)!;
    const attempt = state.attempts.find((a) => a.number === attemptNo);
    const entry = this.inflight.get(taskId);
    if (!attempt || !entry || entry.attempt !== attemptNo) {
      this.logger.warn(`ignoring stale completion for ${taskId}#${attemptNo}`);
      return;
    }
    attempt.endedAt = nowIso();
    const mergeUsage = (u?: RunnerUsage): RunnerUsage | undefined => (u || attempt.usage ? { ...attempt.usage, ...u } : undefined);
    if (outcome.kind === 'result') {
      attempt.result = outcome.result;
      attempt.exitCode = outcome.exitCode;
      attempt.usage = mergeUsage(outcome.usage);
      attempt.outcome = outcome.result.status;
    } else {
      attempt.outcome = outcome.outcome;
      attempt.error = outcome.message;
      attempt.exitCode = outcome.exitCode ?? null;
      attempt.signal = outcome.signal ?? null;
      attempt.usage = mergeUsage(outcome.usage);
    }
    this.clearInteractions(taskId);
    if (attempt.outcome === 'cancelled' && this.stop?.cause !== 'signal' && !entry.abort.signal.aborted) attempt.outcome = 'crash';

    // A merge attempt holds the shared-tree lock; release it first so completeMerge can take it.
    if (entry.kind === 'merge') {
      entry.release?.();
      entry.release = undefined;
    }
    // Workspace finalization (git capture, merge back) may wait for the shared-tree lock held by another
    // task's merge-resolution session, so it runs off the loop and re-enters through a `finalized` wake.
    void this.finalizeWorkspace(task, entry, attempt).then((fin) => this.wake.push({ kind: 'finalized', taskId, attempt: attemptNo, fin }));
  }

  private async finalizeWorkspace(task: ResolvedTask, entry: { kind: 'task' | 'merge'; workspace?: WorkspaceInfo }, attempt: TaskAttempt): Promise<FinalizeResult | undefined> {
    try {
      if (entry.kind === 'merge') {
        if (!entry.workspace) return undefined;
        // A resolution session that failed gets no merge bookkeeping, but it still gets its patch.
        return attempt.outcome === 'success'
          ? await this.workspace.completeMerge(task, entry.workspace, this.run)
          : await this.workspace.captureMergeAttempt(task, entry.workspace, this.run);
      }
      if (entry.workspace) return await this.workspace.finalize(task, entry.workspace, attempt.outcome ?? 'crash', this.run);
      return undefined;
    } catch (err) {
      this.bus.emit({ type: 'workflow.warning', code: 'workspace', message: `workspace finalize failed for "${task.id}": ${(err as Error).message}`, taskId: task.id });
      return undefined;
    }
  }

  /** Second half of attempt completion, after the workspace work: merge conflicts may trigger an agent merge attempt. */
  private async handleFinalized(taskId: string, attemptNo: number, fin: FinalizeResult | undefined): Promise<void> {
    const state = this.run.tasks[taskId]!;
    const task = this.taskDefs.get(taskId)!;
    const attempt = state.attempts.find((a) => a.number === attemptNo);
    const entry = this.inflight.get(taskId);
    if (!attempt || !entry || entry.attempt !== attemptNo) {
      this.logger.warn(`ignoring stale finalization for ${taskId}#${attemptNo}`);
      return;
    }
    if (fin) {
      attempt.workspace = fin.workspace;
      for (const w of fin.warnings) this.bus.emit({ type: 'workflow.warning', code: 'workspace', message: w, taskId });
      if (fin.merge?.status === 'merged' && fin.merge.branch && fin.merge.sha) {
        this.bus.emit({ type: 'task.merged', taskId, branch: fin.merge.branch, into: fin.merge.into ?? 'HEAD', sha: fin.merge.sha });
      }
      if (fin.diff) {
        await this.store
          .writeDiff(this.run.runId, taskId, attemptNo, fin.diff)
          .catch((err) => this.bus.emit({ type: 'workflow.warning', code: 'persist', taskId, message: `diff not written: ${(err as Error).message}` }));
      }
    }
    entry.release?.();
    this.inflight.delete(taskId);
    await this.store.writeAttempt(this.run.runId, taskId, attempt);

    // Merge conflict handling
    if (fin?.merge?.status === 'conflict') {
      const strategy = this.workflow.execution.worktree.mergeConflictStrategy;
      const conflictMsg = `merge of ${fin.merge.branch} into ${fin.merge.into} conflicted${fin.merge.conflicts?.length ? ` in ${fin.merge.conflicts.join(', ')}` : ''}: ${fin.merge.output ?? ''}`.trim();
      const mergeAgent = strategy === 'agent' ? task.agent : strategy;
      if (mergeAgent !== 'fail' && entry.kind === 'task' && !this.stop) {
        const mergeTask = { ...task, agent: mergeAgent, runner: mergeAgent };
        const release = this.workspace.tryLockShared();
        if (release) {
          await this.launchMergeAttempt(mergeTask, state, attempt, fin, release);
        } else {
          // Another attempt owns the shared tree. Waiting for it here would park the loop that lets it finish.
          this.pendingMerges.set(taskId, { task: mergeTask, state, attempt, fin });
        }
        return;
      }
      await this.abandonMerge(taskId, attempt, conflictMsg);
    }

    const taskResult: TaskResult | undefined = entry.kind === 'merge' ? this.originalResult(state, attemptNo) : attempt.result;
    // A merge-resolution attempt captures its own patch but no git block: it finalizes the shared tree, not
    // the task's worktree. The branch, head and per-file stat the task's own attempt produced are still what
    // the result should carry, so they are carried over rather than dropped along with the merge.
    const outcome = fin && entry.kind === 'merge' && !fin.git && entry.priorGit ? { ...fin, git: entry.priorGit } : fin;
    await this.applyAttemptOutcome(task, state, attempt, taskResult, outcome);
  }

  private async abandonMerge(taskId: string, attempt: TaskAttempt, conflictMsg: string): Promise<void> {
    attempt.outcome = 'merge_conflict';
    attempt.error = conflictMsg;
    await this.store.writeAttempt(this.run.runId, taskId, attempt);
  }

  /** Start the merge-resolution sessions whose shared tree has since been released; on a stop they fail instead. */
  private async launchPendingMerges(): Promise<void> {
    for (const [taskId, pm] of [...this.pendingMerges]) {
      if (this.stop) {
        this.pendingMerges.delete(taskId);
        const merge = pm.fin.merge!;
        await this.abandonMerge(taskId, pm.attempt, `merge of ${merge.branch} into ${merge.into} conflicted: ${merge.output ?? ''}`.trim());
        await this.applyAttemptOutcome(pm.task, pm.state, pm.attempt, pm.attempt.result, pm.fin);
        continue;
      }
      const release = this.workspace.tryLockShared();
      if (!release) return;
      this.pendingMerges.delete(taskId);
      await this.launchMergeAttempt(pm.task, pm.state, pm.attempt, pm.fin, release);
    }
  }

  private originalResult(state: TaskRunState, mergeAttemptNo: number): TaskResult | undefined {
    const original = [...state.attempts].reverse().find((a) => a.number < mergeAttemptNo && a.kind === 'task' && a.result);
    return original?.result;
  }

  private async launchMergeAttempt(task: ResolvedTask, state: TaskRunState, previous: TaskAttempt, fin: FinalizeResult, release: () => void): Promise<void> {
    const merge = fin.merge!;
    const number = previous.number + 1;
    // The resolution session works in the shared tree; remember where that tree was so its own diff has a base.
    const workspace: WorkspaceInfo = { ...fin.workspace, mergeBaseSha: merge.intoSha };
    const attempt: TaskAttempt = { number, kind: 'merge', triggeredBy: 'retry', startedAt: nowIso(), cwd: this.workspace.sharedRoot, workspace };
    state.attempts.push(attempt);
    state.currentAttempt = number;
    await this.persist();
    const abort = new AbortController();
    const entry = { attempt: number, abort, kind: 'merge' as const, workspace, release: release as (() => void) | undefined, priorGit: fin.git };
    this.inflight.set(task.id, entry);
    this.bus.emit({ type: 'task.merging', taskId: task.id, branch: merge.branch ?? '', into: merge.into ?? 'HEAD' });
    try {
      const conflicts = merge.conflicts?.length ? merge.conflicts.map((c) => `- ${c}`).join('\n') : '(see merge output)';
      const prompt = [
        `# Merge Conflict Resolution`,
        `The orchestrator tried to merge branch \`${merge.branch}\` into \`${merge.into}\` (task "${task.id}": ${task.name}) and hit conflicts.`,
        `Conflicting files:\n${conflicts}`,
        merge.output ? `Merge output:\n\`\`\`\n${merge.output}\n\`\`\`` : '',
        `Steps:\n1. Run \`git merge --no-ff ${merge.branch}\` in this repository.\n2. Resolve every conflict preserving the intent of BOTH sides; do not discard either side's changes.\n3. Run a quick build/test if the project makes that cheap.\n4. Commit the merge (keep the default merge message).\n5. Report status "success" only if the merge commit exists and the working tree is clean.`,
        `Original task summary: ${previous.result?.summary ?? 'n/a'}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      await this.store.writePrompt(this.run.runId, task.id, number, prompt);
      await this.store.writeAttempt(this.run.runId, task.id, attempt);
      this.bus.emit({ type: 'task.started', taskId: task.id, attempt: number, cwd: this.workspace.sharedRoot, workspace });
      const attemptDir = await this.store.attemptDir(this.run.runId, task.id, number);
      const runner = this.runners.get(task.runner);
      runner
        .run(
          {
            runId: this.run.runId,
            task,
            attempt: number,
            prompt,
            cwd: this.workspace.sharedRoot,
            env: { ...this.environment, ...task.env, CAO_RUN_ID: this.run.runId, CAO_TASK_ID: task.id, CAO_ATTEMPT: String(number), CAO_ATTEMPT_KIND: 'merge' },
            timeoutMs: task.timeoutMs,
            signal: abort.signal,
            attemptDir,
            systemPromptAddendum: 'This session resolves a git merge conflict on behalf of the orchestrator. Do not start unrelated work.',
            canInteract: this.canInteract,
          },
          this.runnerHooks(task.id, number),
        )
        .then(
          (outcome) => this.wake.push({ kind: 'attempt_done', taskId: task.id, attempt: number, outcome }),
          (err) => this.wake.push({ kind: 'attempt_done', taskId: task.id, attempt: number, outcome: { kind: 'error', outcome: 'crash', message: `runner threw: ${(err as Error).message}` } }),
        );
    } catch (err) {
      this.wake.push({ kind: 'attempt_done', taskId: task.id, attempt: number, outcome: { kind: 'error', outcome: 'crash', message: (err as Error).message } });
    }
  }

  private async applyAttemptOutcome(task: ResolvedTask, state: TaskRunState, attempt: TaskAttempt, result: TaskResult | undefined, fin?: FinalizeResult): Promise<void> {
    const outcome = attempt.outcome ?? 'crash';
    const mergeFailed = fin?.merge?.status === 'conflict';
    state.currentAttempt = undefined;

    if (outcome === 'success' && result && !mergeFailed) {
      const enriched: EnrichedTaskResult = { ...result, taskId: task.id, attempt: attempt.number, git: fin?.git, usage: attempt.usage, completedAt: nowIso() };
      if (fin?.merge?.status === 'merged' && fin.merge.sha) enriched.commits = [...enriched.commits, `merge ${fin.merge.sha.slice(0, 10)}`];
      if (fin?.warnings.length) enriched.warnings = [...enriched.warnings, ...fin.warnings];
      state.result = enriched;
      state.endedAt = nowIso();
      state.userInput = undefined;
      this.setState(state, 'success');
      if (this.completion) {
        try {
          await this.completion.markCompleted(task, { completedAt: enriched.completedAt, runId: this.run.runId });
        } catch (err) {
          this.bus.emit({ type: 'workflow.warning', code: 'completion', taskId: task.id, message: `task succeeded but workflow YAML was not updated: ${(err as Error).message}` });
        }
      }
      await this.store.writeResult(this.run.runId, task.id, enriched);
      this.bus.emit({ type: 'task.completed', taskId: task.id, attempt: attempt.number, result: enriched, workspace: attempt.workspace });
      await this.hooks.run('afterTask', { taskId: task.id, taskState: 'success', env: this.hookEnv(task, attempt.workspace) }).catch(() => undefined);
      return;
    }

    if (outcome === 'skipped' && result) {
      state.result = { ...result, taskId: task.id, attempt: attempt.number, usage: attempt.usage, completedAt: nowIso() };
      state.endedAt = nowIso();
      this.setState(state, 'skipped', 'agent_skipped', result.summary);
      await this.store.writeResult(this.run.runId, task.id, state.result);
      this.bus.emit({ type: 'task.skipped', taskId: task.id, reason: 'agent_skipped', message: result.summary });
      return;
    }

    if (outcome === 'needs_input' && result) {
      state.result = { ...result, taskId: task.id, attempt: attempt.number, usage: attempt.usage, completedAt: nowIso() };
      await this.store.writeResult(this.run.runId, task.id, state.result);
      this.setState(state, 'needs_input', 'needs_input', result.error ?? result.summary);
      this.bus.emit({ type: 'task.needs_input', taskId: task.id, summary: result.error ?? result.summary });
      this.stop = this.stop ?? { mode: 'wait', cause: 'pause' };
      this.bus.emit({ type: 'workflow.paused', reason: 'needs_input', taskIds: [task.id] });
      return;
    }

    if (outcome === 'blocked' && result) {
      state.result = { ...result, taskId: task.id, attempt: attempt.number, usage: attempt.usage, completedAt: nowIso() };
      await this.store.writeResult(this.run.runId, task.id, state.result);
      state.endedAt = nowIso();
      this.setState(state, 'blocked', 'agent_blocked', result.error ?? result.summary);
      this.bus.emit({ type: 'task.failed', taskId: task.id, attempt: attempt.number, outcome: 'blocked', reason: 'agent_blocked', message: state.message, final: true });
      await this.hooks.run('onTaskFailure', { taskId: task.id, taskState: 'blocked', env: this.hookEnv(task, attempt.workspace) }).catch(() => undefined);
      this.applyOnFailure(task);
      return;
    }

    if (outcome === 'cancelled' || outcome === 'interrupted') {
      const reason: TaskReason = this.stop?.cause === 'signal' ? 'user_interrupt' : 'stop_requested';
      state.endedAt = nowIso();
      this.setState(state, 'cancelled', reason, attempt.error);
      this.bus.emit({ type: 'task.cancelled', taskId: task.id, attempt: attempt.number, reason });
      return;
    }

    // Retryable failure
    const failureReason: TaskReason = mergeFailed
      ? 'merge_conflict'
      : outcome === 'timeout'
        ? 'timeout'
        : outcome === 'invalid_result'
          ? 'invalid_result'
          : outcome === 'crash'
            ? 'crash'
            : outcome === 'api_error'
              ? 'api_error'
              : 'exhausted_retries';
    const message = mergeFailed ? (attempt.error ?? 'merge conflict') : (result?.error ?? result?.summary ?? attempt.error ?? outcome);
    if (result && !state.result) {
      // keep the failed result for context/inspection (not marked as the final result)
      await this.store.writeResult(this.run.runId, task.id, { ...result, taskId: task.id, attempt: attempt.number, usage: attempt.usage, completedAt: nowIso() });
    }
    const budget = budgetedFailures(state, task);

    // Transient API error (5xx, overloaded, network): the worker process is gone but its session is not.
    // Wait with backoff, then continue the same session; this does not spend retry.attempts.
    if (outcome === 'api_error' && attempt.kind === 'task' && budget.transientStreak > 0 && !mergeFailed && !this.stop) {
      const sessionId = attempt.usage?.sessionId ?? attempt.sessionId;
      const resumeSession = sessionResumable(task) && Boolean(sessionId);
      state.resumeSessionId = resumeSession ? sessionId : undefined;
      const delayMs = transientBackoffMs(budget.transientStreak, task.retry.transientDelayMs, task.retry.transientMaxDelayMs);
      state.retryNotBefore = new Date(this.clock.now() + delayMs).toISOString();
      this.setState(state, 'ready', 'api_error', message);
      this.logger.warn(
        `${task.id}: transient API error on attempt ${attempt.number} (${budget.transientStreak}/${task.retry.transientAttempts}); ${resumeSession ? `resuming session ${sessionId}` : 'starting a fresh session'} in ${delayMs}ms`,
      );
      this.bus.emit({ type: 'task.failed', taskId: task.id, attempt: attempt.number, outcome, reason: 'api_error', message, final: false });
      this.bus.emit({ type: 'task.retrying', taskId: task.id, nextAttempt: attempt.number + 1, delayMs, resumeSession, transient: true });
      return;
    }

    // The worker ended its turn without the completion object. Its session already holds the work, so ask
    // that session for just the JSON before spending a fresh attempt on doing everything again.
    if (outcome === 'invalid_result' && attempt.kind === 'task' && !mergeFailed && !this.stop && nudgesUsed(state) < task.retry.resultNudges) {
      const sessionId = attempt.usage?.sessionId ?? attempt.sessionId;
      if (sessionResumable(task) && sessionId) {
        state.resumeSessionId = sessionId;
        state.retryNotBefore = new Date(this.clock.now()).toISOString();
        this.setState(state, 'ready', 'invalid_result', message);
        this.logger.warn(`${task.id}: attempt ${attempt.number} ended without a completion object (${nudgesUsed(state) + 1}/${task.retry.resultNudges}); asking session ${sessionId} for it`);
        this.bus.emit({ type: 'task.failed', taskId: task.id, attempt: attempt.number, outcome, reason: 'invalid_result', message, final: false });
        this.bus.emit({ type: 'task.retrying', taskId: task.id, nextAttempt: attempt.number + 1, delayMs: 0, resumeSession: true, nudge: true });
        return;
      }
    }
    state.resumeSessionId = undefined;

    const failedAttempts = budget.counted;
    const retriesLeft = task.retry.attempts - (failedAttempts - 1);
    if (!mergeFailed && retriesLeft > 0 && !this.stop) {
      const delayMs = task.retry.delayMs;
      state.retryNotBefore = new Date(this.clock.now() + delayMs).toISOString();
      this.setState(state, 'ready', failureReason, message);
      this.bus.emit({ type: 'task.failed', taskId: task.id, attempt: attempt.number, outcome, reason: failureReason, message, final: false });
      this.bus.emit({ type: 'task.retrying', taskId: task.id, nextAttempt: attempt.number + 1, delayMs });
      return;
    }
    state.endedAt = nowIso();
    this.setState(state, 'failed', failureReason, message);
    this.bus.emit({ type: 'task.failed', taskId: task.id, attempt: attempt.number, outcome, reason: failureReason, message, final: true });
    await this.hooks.run('onTaskFailure', { taskId: task.id, taskState: 'failed', env: this.hookEnv(task, attempt.workspace) }).catch(() => undefined);
    this.applyOnFailure(task);
  }

  private applyOnFailure(task: ResolvedTask): void {
    switch (task.onFailure) {
      case 'stop':
        if (!this.stop) this.stop = { mode: this.workflow.execution.stopMode, cause: 'on_failure' };
        if (this.stop.mode === 'cancel') for (const e of this.inflight.values()) e.abort.abort();
        break;
      case 'skip_dependents':
        for (const depId of this.graph.descendants(task.id)) {
          const st = this.run.tasks[depId]!;
          if (st.state === 'pending' || st.state === 'ready') {
            this.setState(st, 'blocked', 'upstream_failed', `dependency "${task.id}" ${this.run.tasks[task.id]!.state}`);
            st.blockedBy = task.id;
            this.bus.emit({ type: 'task.blocked', taskId: depId, reason: 'upstream_failed', by: task.id, message: st.message });
          }
        }
        break;
      case 'continue':
        break;
    }
  }

  // ------------------------------------------------------------------ finalization

  private async finalize(): Promise<SchedulerResult> {
    this.finished = true;
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    for (const id of this.topo) {
      const st = this.run.tasks[id]!;
      if (st.state === 'pending' || st.state === 'ready') {
        if (this.stop && this.stop.cause !== 'pause') {
          const reason: TaskReason = this.stop.cause === 'signal' ? 'user_interrupt' : 'stop_requested';
          this.setState(st, 'cancelled', reason, this.stop.cause === 'signal' ? 'interrupted' : 'workflow stopped after a failure');
          this.bus.emit({ type: 'task.cancelled', taskId: id, reason });
        }
      }
    }
    const tasks = Object.values(this.run.tasks);
    let state: WorkflowRun['state'];
    if (this.stop?.cause === 'signal') state = 'interrupted';
    else if (this.stop?.cause === 'pause' || tasks.some((t) => t.state === 'awaiting_approval' || t.state === 'needs_input')) state = 'paused';
    else if (tasks.some((t) => t.state === 'failed' || t.state === 'blocked' || t.state === 'cancelled')) state = 'failed';
    else state = 'completed';
    this.transitionRun(state);
    this.run.endedAt = nowIso();
    this.run.exitCode = exitCodeFor(state);
    try {
      await this.workspace.cleanupRun(this.run);
    } catch (err) {
      this.bus.emit({ type: 'workflow.warning', code: 'workspace', message: `cleanup failed: ${(err as Error).message}` });
    }
    if (state !== 'interrupted') await this.hooks.run('afterWorkflow', { env: { CAO_RUN_STATE: state } }).catch(() => undefined);
    await this.writeReport();
    await this.persist();
    await this.writeLive().catch(() => undefined);
    await this.store.releaseLock(this.run.runId).catch(() => undefined);
    const summary = summarize(this.run);
    if (state === 'completed') this.bus.emit({ type: 'workflow.completed', summary });
    else if (state === 'interrupted') this.bus.emit({ type: 'workflow.interrupted', summary });
    else if (state === 'paused') {
      /* workflow.paused already emitted */
    } else this.bus.emit({ type: 'workflow.failed', summary });
    return { state, exitCode: this.run.exitCode, summary };
  }

  /**
   * The run's report of itself, written into the run directory whenever the run ends (including an
   * interrupted or paused one, where it is the only account of how far things got). A failure here is a
   * warning: the run is already finished, and everything the report is made of is on disk anyway.
   */
  private async writeReport(): Promise<void> {
    try {
      const report = await buildReport(this.store, this.run);
      await this.store.writeReport(this.run.runId, renderReportMarkdown(report));
      const file = this.store.paths.reportFile(this.run.runId);
      const rel = path.relative(this.run.repositoryRoot, file);
      this.run.reportPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
    } catch (err) {
      this.bus.emit({ type: 'workflow.warning', code: 'report', message: `report not written: ${(err as Error).message}` });
    }
  }

  /** Synchronous best-effort persistence for exit handlers. */
  persistInterruptedSync(): void {
    if (this.finished) return;
    this.openInteractions.clear();
    for (const st of Object.values(this.run.tasks)) {
      if (ACTIVE_TASK_STATES.has(st.state)) {
        st.pendingInteraction = undefined;
        const a = st.attempts.find((x) => x.number === st.currentAttempt);
        if (a && !a.outcome) {
          a.outcome = 'interrupted';
          a.endedAt = nowIso();
        }
        st.state = 'cancelled';
        st.reason = 'user_interrupt';
        st.currentAttempt = undefined;
      } else if (st.state === 'ready') {
        st.state = 'cancelled';
        st.reason = 'user_interrupt';
      }
    }
    this.run.state = 'interrupted';
    this.run.endedAt = nowIso();
    this.run.exitCode = 130;
    this.store.saveRunSync(this.run);
  }

  // ------------------------------------------------------------------ helpers

  private setState(state: TaskRunState, to: TaskState, reason?: TaskReason, message?: string): void {
    assertTaskTransition(state.state, to, state.id);
    state.state = to;
    state.reason = reason;
    state.message = message;
    if (to !== 'blocked') state.blockedBy = undefined;
    this.markLive(true);
  }

  private transitionRun(to: WorkflowRun['state']): void {
    assertRunTransition(this.run.state, to);
    this.run.state = to;
  }

  private saveChain: Promise<void> = Promise.resolve();

  /** Saves are serialized so a later snapshot can never be overwritten by an earlier, slower write. */
  private async persist(): Promise<void> {
    this.run.eventSeq = this.bus.seq;
    this.saveChain = this.saveChain.then(() => this.store.saveRun(this.run));
    await this.saveChain;
    if (this.liveDirty) await this.writeLive().catch(() => undefined);
  }

  private markLive(immediate: boolean): void {
    this.liveDirty = true;
    const elapsed = this.clock.now() - this.lastLiveWrite;
    if (immediate || elapsed > 1000) {
      void this.writeLive().catch(() => undefined);
    } else if (this.liveTimer === undefined) {
      this.liveTimer = this.clock.setTimeout(() => {
        this.liveTimer = undefined;
        void this.writeLive().catch(() => undefined);
      }, 1000 - elapsed);
    }
  }

  private async writeLive(): Promise<void> {
    this.liveDirty = false;
    this.lastLiveWrite = this.clock.now();
    const live: LiveStatus = { runId: this.run.runId, orchestratorPid: process.pid, heartbeatAt: nowIso(), state: this.run.state, tasks: {} };
    for (const [id, st] of Object.entries(this.run.tasks)) {
      const a = st.currentAttempt !== undefined ? st.attempts.find((x) => x.number === st.currentAttempt) : undefined;
      live.tasks[id] = {
        state: st.state,
        attempt: a?.number,
        pid: a?.pid,
        startedAt: a?.startedAt,
        workingDirectory: a?.cwd,
        branch: a?.workspace?.branch,
        lastActivity: st.lastActivity,
        // Thinking is opt-in everywhere; live.json is read by cao status and cao peek, which never ask for it.
        lastLines: (this.buffers.get(id)?.last(20) ?? []).filter((e) => e.kind !== 'thinking').slice(-5).map(transcriptLine),
        usage: a?.usage,
        filesChanged: a?.files ? Object.keys(a.files).length : undefined,
        pendingInteraction: st.pendingInteraction,
      };
    }
    await this.store.writeLive(this.run.runId, live);
  }

  private startHeartbeat(): void {
    const tick = (): void => {
      void this.store.heartbeat(this.run.runId).catch(() => undefined);
      void this.writeLive().catch(() => undefined);
      this.heartbeatTimer = this.clock.setTimeout(tick, 20_000);
    };
    this.heartbeatTimer = this.clock.setTimeout(tick, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.clock.clearTimeout(this.heartbeatTimer);
    if (this.liveTimer !== undefined) this.clock.clearTimeout(this.liveTimer);
    this.heartbeatTimer = undefined;
    this.liveTimer = undefined;
  }
}

