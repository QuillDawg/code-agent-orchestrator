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
import {
  type WorkflowRun,
  type TaskRunState,
  type TaskAttempt,
  type TaskState,
  type TaskReason,
  type AttemptOutcome,
  type RunSummary,
  type LiveStatus,
  type WorkspaceInfo,
  TERMINAL_TASK_STATES,
  ACTIVE_TASK_STATES,
  type ResolvedTask,
  type ResolvedWorkflow,
  type WorkspaceMode,
  type AttemptDiff,
  type EnrichedTaskResult,
  type GitInfo,
  type TaskResult,
  type RunnerUsage,
  transcriptLine,
  type TranscriptEntry,
  describeAnswer,
  toInteractionRecord,
  type Interaction,
  type InteractionAnswer,
  type InteractionAnswerSource,
  type InteractionRecord,
  type CapabilityToken,
  type ControlAck,
  type ControlAckStatus,
  type PromptDelivery,
  CONTROL_SEEN_LIMIT,
  PROTOCOL_VERSION,
  stamp,
} from 'code-agent-orchestrator-protocol';
import { entryForRun, readConfig, reap, writeEntry } from '../persistence/registry.js';
import { NEEDS_INPUT_HINT, sanitizeText } from '../util/text.js';
import { formatDuration } from '../util/duration.js';
import type { RunStore } from '../persistence/run-store.js';
import { OLDER_PAGE, readOlderAcrossAttempts, readOlderEntries, readTranscriptFile } from '../persistence/transcript-log.js';
import type { AttemptChannel, RunnerRegistry, RunnerOutcome, RunnerHooks, SteerResult } from '../runners/task-runner.js';
import type { PreflightProblem } from '../runners/preflight.js';
import type { WorkspaceManager, FinalizeResult } from '../workspace/workspace-manager.js';
import type { EventBus } from '../events/event-bus.js';
import type { HookRunner } from '../execution/hooks.js';
import { noopHookRunner } from '../execution/hooks.js';
import { attemptQuestion } from './run-view.js';
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
import { commandTaskId, revisionCount, runEndedReason, type ControlCommand, type ControlEnvelope } from './control/commands.js';
import {
  applyEdit,
  decideEdit,
  dependentRejection,
  detectAgentReadiness,
  editFieldList,
  editPendingOnTask,
  editRejection,
  markRevisionsApplied,
  resetWorkspaceNote,
  restartPlanFor,
  type AgentReadiness,
} from './control/edit.js';
import { applyDelivery, deliveryReason, findDelivery, followUpAck, newDelivery, recordDelivery, selectPromptMode, steerRejection } from './control/prompt.js';
import {
  checkFollowUpSession,
  followUpText,
  markFollowUpsDelivered,
  pendingFollowUps,
  queueFollowUp,
  sessionResumable,
} from './control/follow-up.js';
import { detectSessionPresence, type SessionProbe } from '../runners/sessions.js';

export type StopCause = 'signal' | 'on_failure' | 'pause';

/**
 * Terminal states a manual restart returns to `pending`: every task that has finished without succeeding
 * (§2.2, "terminal non-success"). `skipped` is one of them - a task skipped because a dependency failed is
 * exactly the task an operator restarts after fixing that dependency - and leaving it out silently turned
 * `requestRestart('some-skipped-task')`, which is on the exported library surface, into a no-op.
 */
const RESTARTABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([...TERMINAL_TASK_STATES].filter((s) => s !== 'success'));

/**
 * Why a task is being started again, in the words the run log and `cao task` show (§2.6).
 *
 * Three routes reach `applyRestart` and they are three different things: `cao task restart` or `R`, the
 * second half of an edit-and-restart (§3.4), and the stop-and-continue row of §3.5. All three used to say
 * "manually restarted from dashboard", which was the wrong action and the wrong surface for two of them.
 */
const RESTART_BY_OPERATOR = 'restarted by the operator';
const RESTART_FOR_EDIT = 'restarted to run the edit';
const RESTART_FOR_MESSAGE = 'started again to carry the message you sent';

function noSuchTaskReason(taskId: string, runId: string): string {
  return `There is no task "${taskId}" in this run. Run "cao status ${runId}" to see the tasks it has.`;
}

/** What `decideControl` concluded: the ack to record, and the change to make once that ack is on disk. */
interface ControlDecision {
  status: ControlAckStatus;
  reason?: string;
  apply?: () => void | Promise<void>;
}

type Wake =
  | { kind: 'attempt_done'; taskId: string; attempt: number; outcome: RunnerOutcome }
  | { kind: 'finalized'; taskId: string; attempt: number; fin: FinalizeResult | undefined }
  | { kind: 'approval'; taskId: string; decision: 'approved' | 'rejected'; note?: string }
  | { kind: 'retry_due' }
  | { kind: 'stop'; mode: 'wait' | 'cancel'; cause: StopCause }
  | { kind: 'restart'; taskId: string }
  /** §2.2 — a control command, applied in the loop so it is serialized with every other state change. */
  | { kind: 'control'; command: ControlCommand; envelope: ControlEnvelope; settle: (ack: ControlAck) => void };

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
  /**
   * Announce this run in `~/.cao/runs` and keep its heartbeat current (§4.2.4). **Absent means off**, and
   * with it absent the scheduler never touches `~/.cao` at all — which is what keeps a `cao` with emit off
   * byte-identical to the release before it (§5.9).
   */
  emit?: EmitAnnouncement;
  /**
   * Whether the CLI an edited task would launch is installed and capable (§3.4). Injected so a test never
   * shells out; the default probes the agent exactly as `cao run` does before the first token.
   */
  agentReadiness?: AgentReadiness;
  /**
   * Whether the session a follow-up would continue is still on disk (§3.5, `[D25]`). Injected so no test
   * needs a real `~/.claude` or `~/.codex`; the default looks where each agent files its transcripts.
   */
  sessionProbe?: SessionProbe;
}

/** spec.md §4.2.3 — what this run announces about itself. */
export interface EmitAnnouncement {
  /**
   * What this run **actually wired up** at run start, not what this version could in principle do. A run
   * whose inbox failed to start does not claim it can answer.
   */
  capabilities: CapabilityToken[];
  /** Set only when `feed` is among `capabilities` (§10.1). */
  feedUrl?: string | null;
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

/**
 * Agent-controlled text, reduced to one bounded line with no control characters. Used for a hook's
 * environment (hooks run through a shell, so a hook that forgets to quote the variable has much less to
 * work with) and for the deny messages below, which travel back to the worker and on into its result.
 */
function oneLine(text: string): string {
  return sanitizeText(text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * A deny message the worker can act on: what was refused, and how to end the attempt. Every deny reaches
 * the worker through `handleInteraction`, whoever produced it — the dashboard, a host handler, the timeout
 * — so the instruction is added here rather than trusted to each of them. Without the title a dashboard's
 * "Denied by the user" reaches the operator again as a task result that says nothing about which prompt it
 * was.
 */
function denyMessage(message: string, title: string): string {
  const subject = oneLine(title);
  const named = !subject || message.includes(subject) ? message : `${message} (${subject})`;
  return named.includes(NEEDS_INPUT_HINT) ? named : `${named}; ${NEEDS_INPUT_HINT}`;
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

/** Prompt for a session continued with `cao resume --input`: the answer, and the question it answers. */
function answerPrompt(question: string | undefined, answer: string): string {
  const quoted = question ? question.split('\n').map((l) => `> ${l}`).join('\n') : '';
  return [
    '# Your Question Was Answered',
    question
      ? `You ended your previous turn in this session needing a human decision:\n\n${quoted}`
      : 'You ended your previous turn in this session needing a human decision.',
    `The operator answered:\n\n${answer}`,
    'The task and its context are unchanged. Continue from where you left off using this answer, and end with the single JSON completion object required by the contract.',
  ].join('\n\n');
}

/**
 * Prompt for a session continued by a follow-up (§3.5): the operator's message, and the question it answers
 * when there was one.
 *
 * A task that stopped holding a question gets exactly the prompt `cao resume --input` has always written —
 * that path is a follow-up now, and its wording must not change with it. A task that stopped for any other
 * reason was not asking anything, and saying it "needed a human decision" would be inventing one.
 */
function followUpPrompt(question: string | undefined, text: string): string {
  if (question) return answerPrompt(question, text);
  return [
    '# Follow-up From The Operator',
    'The operator has sent you a message about this task:',
    text,
    'The task and its context are unchanged. Take this into account, continue from where you left off, and end with the single JSON completion object required by the contract.',
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
      /** The live channel this attempt's runner offered, while it has one (§3.5). Absent means no transport. */
      channel?: AttemptChannel;
    }
  >();
  private readonly buffers = new Map<string, RingBuffer<TranscriptEntry>>();
  private readonly pendingApprovals = new Set<string>();
  /** Merge-resolution sessions waiting for the shared tree, which another attempt owns right now. */
  private readonly pendingMerges = new Map<string, { task: ResolvedTask; state: TaskRunState; attempt: TaskAttempt; fin: FinalizeResult }>();
  /** taskId -> still-open interactions by request id; a worker can block on several at once (parallel tool calls). */
  private readonly openInteractions = new Map<string, Map<string, InteractionRecord>>();
  /** The same requests, as callbacks that settle them from outside the handler (the operator stopped the run). */
  private readonly interactionSettlers = new Map<string, Map<string, (reason: string) => void>>();
  /**
   * Tasks an operator has asked to cancel (§2.2). Set when the abort goes out, and again when the cancel
   * arrived too late to abort anything — a task already merging back finishes that first, and this is what
   * remembers to end it as `cancelled` instead of retrying it once the `finalized` wake lands.
   */
  private readonly cancelRequests = new Set<string>();
  /**
   * Tasks whose cancellation is the first half of an edit-and-restart (§3.4, `[D22]`) or of a
   * stop-and-continue (§3.5): the abort has gone out, and the restart is owed the moment the worker's death
   * lands as a `cancelled` task. Kept apart from `cancelRequests` because a plain `cao task stop` must not
   * start anything again.
   *
   * The value is why, because the three things that reach `applyRestart` are three different things to have
   * happened to a task and the run log is where an operator reads which: a message sent to a worker said
   * "task manually restarted from dashboard" whatever had sent it and from wherever.
   */
  private readonly restartAfterCancel = new Map<string, string>();
  private stop?: { mode: 'wait' | 'cancel'; cause: StopCause };
  private retryTimer: unknown;
  private liveTimer: unknown;
  private liveDirty = false;
  private lastLiveWrite = 0;
  private heartbeatTimer: unknown;
  private finished = false;
  private readonly emit?: EmitAnnouncement;
  private readonly agentReadiness: AgentReadiness;
  private readonly sessionProbe: SessionProbe;
  /** Registry writes are serialized so a heartbeat can never land on top of the terminal entry (§4.2.4). */
  private announceChain: Promise<void> = Promise.resolve();
  private announcing = false;

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
    this.emit = deps.emit;
    this.agentReadiness = deps.agentReadiness ?? detectAgentReadiness(deps.environment);
    // The process environment under the workflow's own: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are set in the
    // operator's shell far more often than in a workflow file, and a probe that could not see them would
    // call every session of a relocated config directory missing.
    this.sessionProbe = deps.sessionProbe ?? detectSessionPresence({ ...process.env, ...deps.environment });
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

  /**
   * Ask the run to stop. Scheduler-internal and for the run's own policies (`onFailure`, a pause); anything
   * outside `src/workflow/` goes through the run controller instead, which is the only way in (§2.2).
   */
  requestStop(mode: 'wait' | 'cancel', cause: StopCause = 'signal'): void {
    this.wake.push({ kind: 'stop', mode, cause });
  }

  /** Manual retry for a terminal task while the workflow remains active; the controller's `restart`. */
  requestRestart(taskId: string): void {
    this.wake.push({ kind: 'restart', taskId });
  }

  /** Whether `finalize()` has run. The run controller outlives it; this scheduler is never reused (§2.2). */
  get ended(): boolean {
    return this.finished;
  }

  /**
   * Apply one control command and answer it (§2.2).
   *
   * The command enters the same `AsyncQueue<Wake>` as `attempt_done`, `finalized`, `approval`, `retry_due`,
   * `stop` and `restart`, so it is applied between two of those and never inside one: two commands submitted
   * in the same tick apply in the order they were submitted, and the second sees what the first did.
   */
  submitControl(command: ControlCommand, envelope: ControlEnvelope): Promise<ControlAck> {
    // Identity before liveness. A sender that resends after losing an ack gets the first answer back even
    // when the run has ended in between - otherwise a stop that *was* applied is reported as refused, and
    // the ack already on disk is overwritten with that refusal.
    const prior = this.priorAck(envelope.id);
    if (prior) return Promise.resolve(prior);
    if (this.finished) return Promise.resolve(this.buildAck(envelope, 'rejected', runEndedReason(this.run.runId)));
    return new Promise<ControlAck>((settle) => this.wake.push({ kind: 'control', command, envelope, settle }));
  }

  /** The answer this run already gave to `id`, if it gave one (§2.2: a duplicate returns the first ack). */
  private priorAck(id: string): ControlAck | undefined {
    return this.run.controls?.seen.find((a) => a.id === id);
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
  /**
   * Whether the attempt running for this task has a live channel to steer through (§3.5).
   *
   * A read, not a control: the Session panel's header says which mode a message would use, and only the
   * scheduler knows whether the worker in front of it offered a channel. Without this the panel would have
   * to guess from the agent name — the one thing §4 forbids the TUI to do — and would offer to steer a
   * deny-mode Claude the controller is about to refuse.
   */
  steerable(taskId: string): boolean {
    const entry = this.inflight.get(taskId);
    return entry?.kind === 'task' && Boolean(entry.channel);
  }

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
    // §4.2.4 — announce the run once it is on disk as running, and reap opportunistically (§4.2.5). Both are
    // no-ops with emit off, and neither can fail the run.
    this.announcing = true;
    this.announce();
    this.kickOffReap();
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
    await this.preflightRunners();
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

  /**
   * Ask every runner this run will use what it can already tell about the installed CLI, once, before the
   * first worker is spawned (H4.1). A CLI that is too old, or that does not advertise a transport the
   * workflow selected, used to be discovered per task, mid-run, as a crash — and was then retried. Here it
   * fails the tasks it affects immediately, as a configuration error, and `onFailure` decides the run.
   */
  private async preflightRunners(): Promise<void> {
    const byAgent = new Map<string, ResolvedTask[]>();
    for (const id of this.topo) {
      const task = this.taskDefs.get(id);
      const state = this.run.tasks[id];
      if (!task || !state || TERMINAL_TASK_STATES.has(state.state)) continue;
      byAgent.set(task.agent, [...(byAgent.get(task.agent) ?? []), task]);
    }
    for (const [agent, tasks] of byAgent) {
      if (!this.runners.has(agent)) continue;
      let problems: PreflightProblem[] = [];
      try {
        problems = (await this.runners.get(agent).preflight?.(tasks)) ?? [];
      } catch (err) {
        // A preflight that cannot answer must not stop a run that would otherwise work.
        this.bus.emit({ type: 'workflow.warning', code: 'agent', message: `${agent} preflight could not run: ${(err as Error).message}` });
        continue;
      }
      for (const problem of problems) {
        const affected = problem.taskIds.length ? problem.taskIds : tasks.map((task) => task.id);
        this.logger.error(problem.message);
        for (const id of affected) {
          const state = this.run.tasks[id];
          const task = this.taskDefs.get(id);
          if (!state || !task || TERMINAL_TASK_STATES.has(state.state)) continue;
          state.endedAt = nowIso();
          this.setState(state, 'failed', 'config_error', problem.message);
          this.bus.emit({ type: 'task.failed', taskId: id, attempt: 0, outcome: 'config_error', reason: 'config_error', message: problem.message, final: true });
          this.applyOnFailure(task);
        }
      }
    }
    await this.persist();
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
        // The state goes to `awaiting_approval` either way: it is the state `handleApproval` answers from,
        // including for a decision that is already recorded.
        this.setState(state, 'awaiting_approval');
        // A decision already recorded on the task is the answer. `cao resume --approve <id>` writes one,
        // and so does the workspace's Approve action, which is the same path (§2.4, [D36]); without this
        // the gate asked again the moment the run resumed and the answer was silently thrown away.
        // `reconcileForResume` clears it whenever the gate is meant to be asked afresh.
        //
        // Nothing is announced in that case, and the check is above the event for that reason: everything
        // downstream of `task.awaiting_approval` is a way of fetching a human - the plain renderer's
        // "approval required" line, and the workspace reopening a minimised window with a BELL - and this
        // gate needs nobody.
        if (state.approval) {
          this.wake.push({ kind: 'approval', taskId: id, decision: state.approval.decision, note: state.approval.note });
          continue;
        }
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

  /**
   * The operator's follow-up in the task's live transcript, as the `user` entry `[D26]` calls for.
   *
   * Sanitized like every other agent-adjacent string that reaches a terminal, and carrying the delivery id
   * so the composer can line the message up with the state it is in.
   */
  private noteUser(taskId: string, attempt: number, delivery: PromptDelivery): void {
    const entry: TranscriptEntry = { kind: 'user', ts: nowIso(), text: sanitizeText(delivery.text), deliveryId: delivery.id };
    this.bufferFor(taskId).push(entry);
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
    // An answer to a question the worker asked is the same conversation continuing too: `cao resume --input`
    // continues the session that asked rather than paying for the whole task again.
    // ...unless the task has been edited since that session ran [D27]: the worker would be continuing a
    // conversation about the prompt the operator has just replaced, which is the one thing an edit must not
    // do. The previous attempt keeps its own `sessionId`; this attempt simply does not reuse it.
    const editPending = editPendingOnTask(state);
    // A follow-up waiting to be carried is what makes this attempt an answer rather than a retry (§3.5).
    // `cao resume --input` queues one too, so the question-answering case and the general one are one path
    // and cannot drift: `queueFollowUp` already decided which session this attempt should continue.
    const followUps = editPending ? [] : pendingFollowUps(state);
    const answering = followUps.length > 0;
    const resumable = !editPending && (lastAttempt?.outcome === 'api_error' || lastAttempt?.outcome === 'invalid_result' || answering);
    const resumeSessionId = resumable && sessionResumable(task) ? state.resumeSessionId : undefined;
    const nudge = resumeSessionId !== undefined && lastAttempt?.outcome === 'invalid_result';
    state.resumeSessionId = undefined;
    // `answering`, not merely "an answer exists": the text stays on the task so a later retry still has it,
    // and an attempt that retries a failed answering attempt is a retry, not a second answer.
    const triggeredBy: TaskAttempt['triggeredBy'] = answering
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
    // Which revision of the task this attempt is running (§2.6), and where each edit landed, recorded before
    // the worker starts so a crash mid-attempt still leaves a run that knows what it was told to do.
    const revision = markRevisionsApplied(state, number);
    if (revision !== undefined) attempt.revision = revision;
    state.attempts.push(attempt);
    // The follow-ups this attempt carries stop being queued the moment it exists: a crash between here and
    // the worker starting must not deliver the same message twice on the retry.
    for (const delivery of markFollowUpsDelivered(state, number)) this.emitPrompted(task.id, number, delivery);
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
        // A restarted task has forgotten what it asked, so the answer travels with the question it answers.
        userInputQuestion: attemptQuestion(lastAttempt),
      });
      for (const w of ctx.warnings) this.bus.emit({ type: 'workflow.warning', code: 'context', message: w, taskId: task.id });
      const prompt = resumeSessionId
        ? answering
          ? followUpPrompt(attemptQuestion(lastAttempt), followUpText(state) ?? '')
          : nudge
            ? nudgePrompt(lastAttempt)
            : resumePrompt(lastAttempt)
        : ContextBuilder.compose(ctx.markdown, task.prompt);
      await this.store.writeContext(this.run.runId, task.id, ctx.markdown);
      await this.store.writePrompt(this.run.runId, task.id, number, prompt);
      await this.store.writeAttempt(this.run.runId, task.id, attempt);
      this.bus.emit({ type: 'task.started', taskId: task.id, attempt: number, cwd: ws.cwd, workspace: ws });
      if (this.workflow.hooks.beforeTask.length) this.note(task.id, number, 'running beforeTask hook');
      await this.hooks.run('beforeTask', { taskId: task.id, env: this.hookEnv(task, ws) });

      const attemptDir = await this.store.attemptDir(this.run.runId, task.id, number);
      const runner = this.runners.get(task.runner);
      this.note(
        task.id,
        number,
        nudge ? `asking ${task.agent} for the completion object` : resumeSessionId ? `${answering ? 'answering the' : 'resuming'} ${task.agent} session` : `starting ${task.agent}`,
      );
      // The operator's own words in the live transcript, next to the worker's (§3.5, `[D26]`). The record
      // that survives a reload is the `PromptDelivery` on the task and this attempt's `prompt.md`, which is
      // where the text really went; the attempt's own events.jsonl belongs to the runner.
      for (const delivery of followUps) this.noteUser(task.id, number, delivery);
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
      onChannel: (channel) => {
        // Only for the attempt that is actually in flight: a channel offered by an attempt the scheduler has
        // already moved past would let a follow-up reach a worker nobody is watching.
        const live = this.inflight.get(taskId);
        if (live?.attempt === attempt) live.channel = channel;
      },
      onSteerUpdate: (id, update) => {
        void this.applySteerUpdate(taskId, id, update);
      },
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
    this.interactionSettlers.delete(taskId);
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
    const deny = (message: string): InteractionAnswer => ({ kind: 'deny', message: denyMessage(message, interaction.title) });
    /** Whatever answered, a denied worker is told what was refused and how to finish. */
    const normalize = (answer: InteractionAnswer): InteractionAnswer => (answer.kind === 'deny' ? { kind: 'deny', message: denyMessage(answer.message, interaction.title) } : answer);
    /** Fire-and-forget: the hook is a notification, so it never stands between the worker and its answer. */
    const notify = (taskState: 'waiting' | 'needs_input'): void => {
      if (!task || !this.workflow.hooks.onInputRequired.length) return;
      void this.hooks
        .run('onInputRequired', {
          taskId,
          taskState,
          env: {
            ...this.hookEnv(task, a?.workspace),
            CAO_INTERACTION_KIND: interaction.kind,
            CAO_INTERACTION_TITLE: oneLine(interaction.title),
            CAO_INTERACTION_TOOL: oneLine(interaction.toolName),
          },
        })
        .catch(() => undefined);
    };
    if (!this.interactionHandler || !state || !a || state.currentAttempt !== attempt) {
      // Headless is exactly when nobody is watching the terminal, so the notification matters most here
      // even though the answer is already decided: the hook is how an operator finds out at all.
      notify('needs_input');
      return finish(deny(`No human is available to answer ${interaction.title}`), 'no_handler');
    }
    if (state.state === 'running') this.setState(state, 'waiting');
    const open = this.openInteractions.get(taskId) ?? new Map<string, InteractionRecord>();
    this.openInteractions.set(taskId, open);
    open.set(interaction.id, record);
    this.refreshPending(taskId);
    await this.persist().catch(() => undefined);
    notify('waiting');
    const timeoutMs = this.workflow.execution.interactionTimeoutMs;
    // The handler waits on its own signal, aborted whenever this request stops needing an answer: the worker
    // withdrew it, the timeout expired, or it has just been answered. A dashboard that is not told loses its
    // only cue to take the modal down, and would leave a decided prompt on screen ahead of the next one.
    const handler = new AbortController();
    let timer: unknown;
    let onAbort: (() => void) | undefined;
    try {
      const answer = await new Promise<{ answer: InteractionAnswer; source: InteractionAnswerSource }>((resolve) => {
        // A stop request settles the prompt from outside: an operator who has asked the run to stop must not
        // then be held by a modal, and a worker left blocked would otherwise wait out `interactionTimeout`.
        const settlers = this.interactionSettlers.get(taskId) ?? new Map<string, (reason: string) => void>();
        this.interactionSettlers.set(taskId, settlers);
        settlers.set(interaction.id, (reason) => {
          handler.abort(new Error(reason));
          resolve({ answer: deny(reason), source: 'stopped' });
        });
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
          (res) => resolve({ answer: normalize(res), source: 'handler' }),
          (err: unknown) => resolve({ answer: deny(`The dashboard could not answer (${(err as Error)?.message ?? String(err)})`), source: 'aborted' }),
        );
      });
      return finish(answer.answer, answer.source);
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      const settlers = this.interactionSettlers.get(taskId);
      if (settlers?.delete(interaction.id) && settlers.size === 0) this.interactionSettlers.delete(taskId);
      handler.abort(new Error('the request has been answered'));
    }
  }

  /** Deny every request still waiting for a human, in every task. Safe to call twice: settling is idempotent. */
  private settleOpenInteractions(reason: string): void {
    for (const taskId of [...this.interactionSettlers.keys()]) this.settleTaskInteractions(taskId, reason);
  }

  /**
   * The same, for one task. `cancelTask` needs it: cancelling one attempt must not answer the prompt another
   * task has on the operator's screen. `reason` reaches the worker as the deny message, so it goes through
   * the same `denyMessage` wrapping and carries the "finish with status needs_input" hint with it.
   */
  private settleTaskInteractions(taskId: string, reason: string): void {
    const settlers = this.interactionSettlers.get(taskId);
    if (!settlers) return;
    for (const settle of [...settlers.values()]) settle(reason);
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
        this.applyStop(w.mode, w.cause);
        break;
      case 'restart':
        await this.applyRestart(w.taskId);
        break;
      case 'control':
        await this.handleControl(w);
        break;
    }
  }

  private applyStop(mode: 'wait' | 'cancel', cause: StopCause): void {
    if (!this.stop || (this.stop.mode === 'wait' && mode === 'cancel') || cause === 'signal') {
      this.stop = { mode, cause };
    }
    // A run that is stopping starts nothing again, including the task half-way through an edit-and-restart.
    this.restartAfterCancel.clear();
    if (mode === 'cancel') for (const e of this.inflight.values()) e.abort.abort();
    // Whatever the stop mode, nothing may still be asking the operator who just stopped the run: with
    // `wait` the worker is left to finish its turn, and a denial is what lets it.
    this.settleOpenInteractions(cause === 'signal' ? 'The run was interrupted' : 'The run is stopping');
  }

  private async applyRestart(taskId: string, why = RESTART_BY_OPERATOR): Promise<void> {
    if (this.stop || this.inflight.has(taskId)) return;
    const state = this.run.tasks[taskId];
    if (!state || !RESTARTABLE_STATES.has(state.state)) return;
    this.setState(state, 'pending', undefined, why);
    state.blockedBy = undefined;
    state.retryWindowStart = (state.attempts[state.attempts.length - 1]?.number ?? 0) + 1;
    this.bus.emit({ type: 'workflow.warning', code: 'restart', taskId, message: `task ${why}` });
    await this.persist();
  }

  // ------------------------------------------------------------------ control commands (§2.2)

  private buildAck(envelope: ControlEnvelope, status: ControlAckStatus, reason?: string): ControlAck {
    return stamp<ControlAck>({ protocol: PROTOCOL_VERSION, id: envelope.id, status, ...(reason ? { reason } : {}), at: nowIso() });
  }

  private async handleControl(w: Extract<Wake, { kind: 'control' }>): Promise<void> {
    const { command, envelope } = w;
    const prior = this.priorAck(envelope.id);
    if (prior) {
      // A resend after an ack was lost on the way back. The first answer, verbatim, and nothing applied twice.
      w.settle(prior);
      return;
    }
    const decision = await this.decideControl(command, envelope);
    const ack = this.recordControl(envelope, decision.status, decision.reason);
    // Persist-before-act, as everywhere else in this loop: the command is answered on disk before it changes
    // anything, so a crash in the middle leaves a run that knows what it was told rather than one that did it
    // twice.
    await this.persist();
    try {
      await decision.apply?.();
    } catch (err) {
      this.logger.error(`control ${command.kind} was recorded but could not be applied: ${(err as Error).message}`);
    }
    w.settle(ack);
  }

  private recordControl(envelope: ControlEnvelope, status: ControlAckStatus, reason?: string): ControlAck {
    const ack = this.buildAck(envelope, status, reason);
    const controls = (this.run.controls ??= { seen: [] });
    controls.seen.push(ack);
    if (controls.seen.length > CONTROL_SEEN_LIMIT) controls.seen.splice(0, controls.seen.length - CONTROL_SEEN_LIMIT);
    return ack;
  }

  /**
   * What one command does to this run, decided against the state as it is right now - which is why this runs
   * inside the loop and not at the point of submission.
   */
  private async decideControl(command: ControlCommand, envelope: ControlEnvelope): Promise<ControlDecision> {
    const stale = this.staleness(command, envelope);
    if (stale) return { status: 'rejected', reason: stale };
    switch (command.kind) {
      case 'stop':
        return {
          status: 'applied',
          reason: command.mode === 'cancel' ? 'Stopping the run and aborting its workers.' : 'Stopping the run once its workers finish their turn.',
          apply: () => this.applyStop(command.mode, 'signal'),
        };
      case 'kill':
        // The state change is a cancel-mode stop; killing the worker processes belongs to the caller that owns
        // them, because this scheduler owns run state and never a process table.
        return { status: 'applied', reason: 'Stopping the run and killing its workers now.', apply: () => this.applyStop('cancel', 'signal') };
      case 'restart':
        return this.decideRestart(command.taskId);
      case 'cancelTask':
        return this.decideCancelTask(command.taskId);
      case 'edit':
        return this.decideEdit(command, envelope);
      case 'prompt':
        return this.decidePrompt(command, envelope);
      case 'approve':
      case 'reject':
        return { status: 'rejected', reason: `Approval decisions are not taken by the run controller yet. Approve or reject "${command.taskId}" in the terminal that owns this run.` };
      case 'answer':
        return { status: 'rejected', reason: `Open requests are not answered through the run controller yet. Answer "${command.taskId}" in the terminal that owns this run.` };
    }
  }

  /**
   * Whether the sender built this command on a view of the task that has since moved on (§2.2). Only a command
   * that names a task can be stale; a run-level stop means the same thing whenever it arrives.
   */
  private staleness(command: ControlCommand, envelope: ControlEnvelope): string | undefined {
    const expected = envelope.expected;
    const taskId = commandTaskId(command);
    if (!expected || !taskId) return undefined;
    const state = this.run.tasks[taskId];
    if (!state) return undefined; // the command's own rejection says it better than a staleness message would
    if (expected.attempt !== undefined) {
      const attempt = state.attempts[state.attempts.length - 1]?.number ?? 0;
      if (attempt !== expected.attempt) return `Task "${taskId}" is on attempt ${attempt}, request expected ${expected.attempt}.`;
    }
    if (expected.revision !== undefined) {
      const revision = revisionCount(state);
      if (revision !== expected.revision) return `Task "${taskId}" is at revision ${revision}, request expected ${expected.revision}.`;
    }
    return undefined;
  }

  private decideRestart(taskId: string): ControlDecision {
    const state = this.run.tasks[taskId];
    if (!state) return { status: 'rejected', reason: noSuchTaskReason(taskId, this.run.runId) };
    if (this.stop) return { status: 'rejected', reason: `The run is stopping, so "${taskId}" cannot be restarted. Start it again with "cao resume ${this.run.runId}" once the run has ended.` };
    // A cancel already asked for is seconds away from ending this task, and telling the operator to "cancel
    // it first" is telling them to do again what they just did. Name the wait instead.
    if (this.cancelRequests.has(taskId)) {
      return { status: 'rejected', reason: `Task "${taskId}" is being cancelled and has not stopped yet. Restart it once it is showing as cancelled.` };
    }
    if (this.inflight.has(taskId) || ACTIVE_TASK_STATES.has(state.state)) return { status: 'rejected', reason: `Task "${taskId}" is still running. Cancel it first, then restart it.` };
    if (!RESTARTABLE_STATES.has(state.state)) {
      return { status: 'rejected', reason: `Only a task that has finished without succeeding can be restarted while this run is active; "${taskId}" is ${state.state}.` };
    }
    return { status: 'applied', reason: `Restarting "${taskId}".`, apply: () => this.applyRestart(taskId) };
  }

  /**
   * `cancelTask` [D22]: abort the attempt that is running, settle whatever it was asking a human first, and
   * let the existing `cancelled` outcome carry it to a `cancelled` task - the state `restart` already takes.
   *
   * A task whose attempt has already ended is past the point where aborting achieves anything: its workspace
   * is merging back, and the command waits for that `finalized` wake rather than racing it.
   */
  private decideCancelTask(taskId: string): ControlDecision {
    const state = this.run.tasks[taskId];
    if (!state) return { status: 'rejected', reason: noSuchTaskReason(taskId, this.run.runId) };
    if (this.pendingMerges.has(taskId)) {
      return {
        status: 'accepted',
        reason: `Task "${taskId}" is waiting for the shared tree to merge back; it is cancelled as soon as that finishes.`,
        apply: () => void this.cancelRequests.add(taskId),
      };
    }
    const entry = this.inflight.get(taskId);
    if (entry) {
      const attempt = state.attempts.find((a) => a.number === entry.attempt);
      if (attempt?.endedAt) {
        return {
          status: 'accepted',
          reason: `Attempt ${entry.attempt} of "${taskId}" has ended and is merging back; the task is cancelled as soon as that finishes.`,
          apply: () => void this.cancelRequests.add(taskId),
        };
      }
      return {
        status: 'applied',
        // Not "was cancelled": the abort has been delivered, but the worker takes a moment to die and the
        // task stays `running` until it does. An operator told the task is already cancelled reaches for
        // restart, and gets refused.
        reason: `Attempt ${entry.attempt} of "${taskId}" is being aborted; the task ends as cancelled once its worker has stopped.`,
        apply: () => {
          this.cancelRequests.add(taskId);
          // Deny first, then abort [D22]. A worker blocked on a permission prompt is not reading its abort
          // signal; denying is what returns it to its own loop, and it leaves the operator's screen clear.
          this.settleTaskInteractions(taskId, 'The task was cancelled');
          entry.abort.abort(new Error(`task "${taskId}" was cancelled`));
        },
      };
    }
    if (state.state === 'pending' || state.state === 'ready') {
      return { status: 'rejected', reason: `Task "${taskId}" has not started, so there is nothing to cancel. Stop the run instead if it should not run at all.` };
    }
    if (TERMINAL_TASK_STATES.has(state.state)) {
      return { status: 'rejected', reason: `Task "${taskId}" already finished as ${state.state}, so there is nothing to cancel.` };
    }
    return { status: 'rejected', reason: `Task "${taskId}" is ${state.state} and has no attempt running, so there is nothing to cancel.` };
  }

  /**
   * `prompt` (§3.5, `[D23]`-`[D26]`): the whole matrix, from one command.
   *
   * The mode is chosen from the task's state and whether the attempt in front of it has a live channel, and
   * a mode the caller *named* is honoured only where that row agrees — asking to steer a task that has
   * already stopped is a different thing done to a different attempt, and doing it silently is how an
   * operator loses the session they meant to continue.
   */
  private async decidePrompt(command: Extract<ControlCommand, { kind: 'prompt' }>, envelope: ControlEnvelope): Promise<ControlDecision> {
    const { taskId } = command;
    const state = this.run.tasks[taskId];
    const task = this.taskDefs.get(taskId);
    if (!state || !task) return { status: 'rejected', reason: noSuchTaskReason(taskId, this.run.runId) };
    const entry = this.inflight.get(taskId);
    const channel = entry?.kind === 'task' ? entry.channel : undefined;
    // The sender's own surface decides how the refusal offers the other mode: a flag to type, or the name
    // of the mode for a composer that has no flags to type.
    const chosen = selectPromptMode(state, { hasChannel: Boolean(channel), requested: command.mode, source: envelope.source });
    if (!chosen.mode) return { status: 'rejected', reason: chosen.reason ?? steerRejection(state, Boolean(channel))! };
    if (chosen.mode === 'steer') return this.decideSteer(command, envelope, state, entry!.attempt, channel!);
    return this.decideFollowUp(command, envelope, task, state, chosen.mode === 'stopAndContinue');
  }

  /**
   * The steer row: hand the text to the live channel of the attempt that is running, and record what the
   * transport said about it.
   *
   * The send happens here, inside the loop, rather than in `apply`, because the ack is the answer: an
   * operator is told `accepted`, `queued` or the server's own refusal, and none of those is knowable before
   * the message has actually been offered to the worker. Nothing about the run's state changes either way,
   * so there is nothing for a crash between the two to leave half-done - `apply` only writes the record.
   */
  private async decideSteer(
    command: Extract<ControlCommand, { kind: 'prompt' }>,
    envelope: ControlEnvelope,
    state: TaskRunState,
    attemptNumber: number,
    channel: AttemptChannel,
  ): Promise<ControlDecision> {
    const taskId = command.taskId;
    const attempt = state.attempts.find((a) => a.number === attemptNumber);
    if (!attempt || attempt.endedAt) {
      return { status: 'rejected', reason: `The worker of "${taskId}" has finished its turn, so there is nothing left to steer.` };
    }

    const delivery = newDelivery({ source: envelope.source, mode: 'steer', text: command.text });
    // No `turnId` from here: the attempt's own runner is the only thing that knows which turn is running,
    // and a scheduler that guessed would refuse a perfectly good steer over a stale number.
    applyDelivery(delivery, await channel.steer(command.text, { id: delivery.id }));
    const reason = deliveryReason(taskId, delivery);
    // A transport that refused took nothing: there is no delivery to record, and the ack carries its words.
    if (delivery.state === 'rejected' || delivery.state === 'failed') return { status: 'rejected', reason };
    return {
      status: delivery.state === 'accepted' ? 'applied' : 'accepted',
      reason,
      apply: async () => {
        recordDelivery(attempt, delivery);
        this.emitPrompted(taskId, attempt.number, delivery);
        await this.persist();
      },
    };
  }

  /**
   * The follow-up and stop-and-continue rows (§3.5, `[D25]`): the message becomes the task's **next**
   * attempt, continuing the session it last reported where that is possible.
   *
   * Stop-and-continue is the same thing with a cancel in front of it, and it is one command with one ack:
   * the worker is aborted here rather than through `decideCancelTask`, because a second ack for the stop
   * would be a second answer to a request that only asked once. The restart is owed the moment the worker's
   * death lands, which `restartAfterCancel` is already how the editor says it.
   *
   * The session is checked against the disk before anything is stopped. A session that is gone is refused
   * with the fresh-session option spelled out, never swapped silently for a new one `[D25]`.
   */
  private async decideFollowUp(
    command: Extract<ControlCommand, { kind: 'prompt' }>,
    envelope: ControlEnvelope,
    task: ResolvedTask,
    state: TaskRunState,
    stopFirst: boolean,
  ): Promise<ControlDecision> {
    const taskId = command.taskId;
    const mode = stopFirst ? 'stopAndContinue' : 'followUp';
    if (this.stop) {
      return {
        status: 'rejected',
        reason: `The run is stopping, so "${taskId}" cannot be started again with your message. Send it once the run has ended: "cao task prompt ${this.run.runId} ${taskId} --message ..." resumes the run to carry it.`,
      };
    }
    if (this.pendingMerges.has(taskId) || this.inflight.get(taskId)?.kind === 'merge') {
      return { status: 'rejected', reason: `"${taskId}" is merging its work back into the shared tree; send the follow-up once that has finished.` };
    }
    const entry = stopFirst ? this.inflight.get(taskId) : undefined;
    if (stopFirst) {
      const attempt = entry ? state.attempts.find((a) => a.number === entry.attempt) : undefined;
      if (!entry || !attempt || attempt.endedAt) {
        return { status: 'rejected', reason: `The worker of "${taskId}" has already finished; send a follow-up once the task is showing as finished.` };
      }
    } else if (this.inflight.has(taskId)) {
      return { status: 'rejected', reason: `Task "${taskId}" still has an attempt in flight, so a follow-up has nothing to start. Stop it first, or send the message with --stop-and-continue.` };
    }

    const session = await checkFollowUpSession(task, state, { probe: this.sessionProbe, freshSession: command.freshSession === true });
    if (session.rejection) return { status: 'rejected', reason: session.rejection };

    // Named, not implied: a caller that gave no mode flag has to be told which row of the matrix answered
    // it, because "stopped its worker and started a new attempt" and "queued into the turn it is running"
    // are very different things to have done to an hour of work (§3.5).
    const reason = followUpAck(taskId, mode, session.sessionId);

    return {
      status: 'accepted',
      reason,
      apply: async () => {
        const delivery = queueFollowUp(state, { source: envelope.source, mode, text: command.text, sessionId: session.sessionId });
        this.emitPrompted(taskId, state.attempts[state.attempts.length - 1]?.number ?? 0, delivery);
        if (stopFirst) this.cancelForFollowUp(taskId);
        await this.persist();
        if (!stopFirst) await this.startFollowUp(taskId);
      },
    };
  }

  /** Abort the worker of a task being stopped-and-continued, denying whatever it was asking a human first. */
  private cancelForFollowUp(taskId: string): void {
    const entry = this.inflight.get(taskId);
    if (!entry) return;
    this.cancelRequests.add(taskId);
    this.restartAfterCancel.set(taskId, RESTART_FOR_MESSAGE);
    this.settleTaskInteractions(taskId, 'The task was stopped to be continued with a follow-up');
    entry.abort.abort(new Error(`task "${taskId}" was stopped to continue with a follow-up`));
  }

  /**
   * Put a stopped task back in the queue so its follow-up gets an attempt.
   *
   * `applyRestart` in all but name, except that `needs_input` is not a terminal state and so is not
   * restartable — and it is the state most follow-ups are sent to. The retry window is reset for the same
   * reason a restart resets it: a task that has spent its retries must still be able to run the attempt the
   * operator just asked for.
   */
  private async startFollowUp(taskId: string): Promise<void> {
    const state = this.run.tasks[taskId];
    if (!state || this.stop || this.inflight.has(taskId)) return;
    state.blockedBy = undefined;
    state.endedAt = undefined;
    state.retryNotBefore = undefined;
    state.retryWindowStart = (state.attempts[state.attempts.length - 1]?.number ?? 0) + 1;
    this.setState(state, 'pending', undefined, 'a follow-up was sent by the operator');
    await this.persist();
  }

  /**
   * A delivery the transport answered `queued` has moved on. Written straight into the attempt rather than
   * through the wake queue: it changes one record and starts nothing, and an acknowledgment that waited for
   * the loop would arrive after the turn it acknowledges.
   */
  private async applySteerUpdate(taskId: string, id: string, update: SteerResult): Promise<void> {
    const state = this.run.tasks[taskId];
    const found = state ? findDelivery(state, id) : undefined;
    if (!found) return;
    applyDelivery(found.delivery, update);
    this.emitPrompted(taskId, found.attempt.number, found.delivery);
    await this.persist().catch(() => undefined);
  }

  /** The run-log summary of a delivery (§2.6): every field of it except the one that matters to a reader. */
  private emitPrompted(taskId: string, attempt: number, delivery: PromptDelivery): void {
    this.bus.emit({
      type: 'task.prompted',
      taskId,
      attempt,
      deliveryId: delivery.id,
      mode: delivery.mode,
      transport: delivery.transport,
      state: delivery.state,
      ...(delivery.reason ? { reason: delivery.reason } : {}),
    });
  }

  /**
   * `edit` (§3.4): validate, then stop, then record, then restart - in that order and never another.
   *
   * Validation is first because everything after it is destructive: an invalid model must not cost an
   * operator the hour of work a running attempt represents. The revision is written before the restart for
   * the same reason `handleControl` persists the ack before applying it - an attempt that starts must
   * already be able to say which revision it is running.
   */
  private async decideEdit(command: Extract<ControlCommand, { kind: 'edit' }>, envelope: ControlEnvelope): Promise<ControlDecision> {
    const { taskId, restart } = command;
    const state = this.run.tasks[taskId];
    const task = this.taskDefs.get(taskId);
    if (!state || !task) return { status: 'rejected', reason: noSuchTaskReason(taskId, this.run.runId) };

    const rejection = editRejection(task, state, restart);
    if (rejection) return { status: 'rejected', reason: rejection };
    // Merge-back is the one window where the task's own attempt has ended but its workspace has not: the
    // tree is being merged right now, and an edit that restarted the task would race that merge.
    if (this.pendingMerges.has(taskId) || this.inflight.get(taskId)?.kind === 'merge') {
      return { status: 'rejected', reason: `"${taskId}" is merging its work back into the shared tree; it cannot be edited until that has finished.` };
    }
    const attempt = this.inflight.get(taskId) ? state.attempts.find((a) => a.number === this.inflight.get(taskId)!.attempt) : undefined;
    if (attempt?.endedAt) {
      return { status: 'rejected', reason: `Attempt ${attempt.number} of "${taskId}" has ended and is being finalized; edit it once the task is showing as finished.` };
    }
    const blocked = dependentRejection(this.run, taskId, this.graph.descendants(taskId));
    if (blocked) return { status: 'rejected', reason: blocked };

    const decided = await decideEdit(this.workflow, task, command.changes, {
      knownRunners: this.runners.names(),
      gitAvailable: Boolean(this.workflow.gitRoot),
      readiness: this.agentReadiness,
    });
    if (!decided.ok) return { status: 'rejected', reason: decided.reason };
    const plan = decided.plan;

    const wanted = restartPlanFor(state);
    const restarting = restart && (wanted === 'cancelAndRestart' || wanted === 'restart');
    const note = [
      ...plan.warnings,
      ...(resetWorkspaceNote(plan.task, restarting) ? [resetWorkspaceNote(plan.task, restarting)!] : []),
    ];
    if (plan.fields.length === 0) {
      // Every named field already holds the value asked for. Nothing is recorded - a revision that changed
      // nothing is noise in a history whose whole job is to say what changed - but a restart still happens,
      // because the operator asked for one and refusing it here would be a second, silent decision.
      return {
        status: 'applied',
        reason: `"${taskId}" already has those values, so nothing was changed.${restarting ? ' It is being started again.' : ''}`,
        apply: restarting ? () => this.restartAfterEdit(taskId, wanted) : undefined,
      };
    }

    const reason = [
      `Edited "${taskId}": ${editFieldList(plan.fields)}.`,
      wanted === 'cancelAndRestart' && restart
        ? 'Its worker is being stopped and the task starts again from a fresh session.'
        : restarting
          ? 'It is being started again from a fresh session.'
          : wanted === 'notStarted'
            ? 'It has not started yet, so it will run with the new settings when it does.'
            : wanted === 'paused'
              ? `The run is paused on it; "cao resume ${this.run.runId}" picks the edit up.`
              : `Restart it with "cao task restart ${taskId}" when you want it to run again.`,
      ...note,
    ].join(' ');

    return {
      status: 'applied',
      reason,
      apply: async () => {
        // Stop first, record second, restart third (§3.4). The cancel is delivered here rather than through
        // `decideCancelTask` because this is one command with one ack: a second ack for the stop would be a
        // second answer to a request that only asked once.
        if (restarting && wanted === 'cancelAndRestart') this.cancelForEdit(taskId);
        const revision = applyEdit(task, state, plan, { source: envelope.source, pid: envelope.pid, at: nowIso(), note: note.length ? note.join(' ') : undefined });
        // A restart after an edit always starts a fresh session [D27]; the previous attempt keeps its own.
        state.resumeSessionId = undefined;
        this.bus.emit({ type: 'task.edited', taskId, revision: revision.number, fields: plan.fields });
        await this.persist();
        if (restarting) await this.restartAfterEdit(taskId, wanted);
      },
    };
  }

  /** Abort the worker of a task being edited, denying whatever it was asking a human first `[D22]`. */
  private cancelForEdit(taskId: string): void {
    const entry = this.inflight.get(taskId);
    if (!entry) return;
    this.cancelRequests.add(taskId);
    this.restartAfterCancel.set(taskId, RESTART_FOR_EDIT);
    this.settleTaskInteractions(taskId, 'The task was edited and is being started again');
    entry.abort.abort(new Error(`task "${taskId}" was edited and restarted`));
  }

  /**
   * The restart half of an edit. A task whose worker is still dying cannot be restarted yet, so the request
   * is left with `restartAfterCancel` and honoured by `applyAttemptOutcome` the moment the task lands as
   * `cancelled` - the same place a plain `cancelTask` finishes.
   */
  private async restartAfterEdit(taskId: string, wanted: ReturnType<typeof restartPlanFor>): Promise<void> {
    if (wanted === 'cancelAndRestart') {
      this.restartAfterCancel.set(taskId, RESTART_FOR_EDIT);
      return;
    }
    await this.applyRestart(taskId, RESTART_FOR_EDIT);
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
      attempt.failure = outcome.failure;
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
    await this.applyOutcome(task, state, attempt, result, fin);
    await this.applyPendingCancel(task, state, attempt);
    // The second half of an edit-and-restart (§3.4): the worker the edit stopped has finished dying, so the
    // task is in a state a restart can act on. One command, one ack - the ack was written when the edit was
    // taken, and this is the rest of what it promised.
    const owed = this.restartAfterCancel.get(task.id);
    if (owed !== undefined) this.restartAfterCancel.delete(task.id);
    if (owed !== undefined && state.state === 'cancelled') await this.applyRestart(task.id, owed);
  }

  /**
   * A `cancelTask` that arrived while the task was finishing its attempt or merging back (§2.2). The attempt's
   * own outcome is recorded first and truthfully - the work it did is what it did - and the cancel only stops
   * what would have happened next, which is the retry.
   */
  private async applyPendingCancel(task: ResolvedTask, state: TaskRunState, attempt: TaskAttempt): Promise<void> {
    if (!this.cancelRequests.delete(task.id)) return;
    if (TERMINAL_TASK_STATES.has(state.state)) return;
    state.endedAt = nowIso();
    state.retryNotBefore = undefined;
    // ...unless a follow-up is waiting for this task: it has already chosen the session its attempt
    // continues (§3.5), and clearing it here is what would turn a stop-and-continue into a fresh start.
    if (!pendingFollowUps(state).length) state.resumeSessionId = undefined;
    this.setState(state, 'cancelled', 'user_interrupt', 'cancelled by the operator');
    this.bus.emit({ type: 'task.cancelled', taskId: task.id, attempt: attempt.number, reason: 'user_interrupt' });
    await this.persist();
  }

  private async applyOutcome(task: ResolvedTask, state: TaskRunState, attempt: TaskAttempt, result: TaskResult | undefined, fin?: FinalizeResult): Promise<void> {
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
      // Keep the session that asked the question: `cao resume --input` continues it instead of restarting.
      const sessionId = attempt.usage?.sessionId ?? attempt.sessionId;
      state.resumeSessionId = sessionResumable(task) && sessionId ? sessionId : undefined;
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
      // An operator who cancelled this one task interrupted it as surely as a Ctrl+C did, and the run around
      // it is not stopping: `stop_requested` would say the opposite of what happened.
      const requested = this.cancelRequests.delete(task.id);
      const reason: TaskReason = requested || this.stop?.cause === 'signal' ? 'user_interrupt' : 'stop_requested';
      state.endedAt = nowIso();
      this.setState(state, 'cancelled', reason, requested ? 'cancelled by the operator' : attempt.error);
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
          : outcome === 'config_error'
            ? 'config_error'
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
      const delayMs = Math.max(
        transientBackoffMs(budget.transientStreak, task.retry.transientDelayMs, task.retry.transientMaxDelayMs),
        attempt.failure?.retryAfterMs ?? 0,
      );
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
    if (!pendingFollowUps(state).length) state.resumeSessionId = undefined;

    const failedAttempts = budget.counted;
    const retriesLeft = task.retry.attempts - (failedAttempts - 1);
    // A configuration rejection cannot succeed on a retry, so it neither takes one nor counts as one:
    // `budgetedFailures` ignores the outcome and the run stops or continues purely per `onFailure`.
    if (!mergeFailed && outcome !== 'config_error' && retriesLeft > 0 && attempt.failure?.retryable !== false && !this.stop) {
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
    // Whatever is still queued can no longer be applied. A control command waiting here is answered rather
    // than left on a promise nothing will ever settle: the controller outlives this scheduler (§2.2).
    for (const queued of this.wake.drain()) {
      if (queued.kind === 'control') queued.settle(this.priorAck(queued.envelope.id) ?? this.buildAck(queued.envelope, 'rejected', runEndedReason(this.run.runId)));
    }
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
    // §4.2.4 — the final write, with the terminal state, `endedAt` and `exitCode`. The entry is **retained**:
    // that is what lets a surface answer "which repositories do I have runs in" on a cold start.
    await this.announceFinal();
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
   * `report.md` as the run directory holds it, for the Report panel of the workspace. Read rather than
   * rebuilt: `cao report` and the panel must show the same document, and the one on disk is the one a
   * reader is going to paste somewhere. Null until the run ends and writes it.
   */
  readReport(): Promise<string | null> {
    return this.store.readReport(this.run.runId);
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
    this.announce();
  }

  // ------------------------------------------------------------------ the registry (spec.md §4.2.4)

  /**
   * Rewrite this run's registry entry. Fire-and-forget: the entry is a snapshot taken synchronously here, the
   * writes are chained so they land in the order they were asked for, and `writeEntry` itself never throws.
   *
   * Nothing is announced before `execute()` has the run on disk as running, and nothing between
   * `finalize()` marking the run finished and its own final write — the bare terminal state, without the
   * `endedAt` and `exitCode` that arrive a few lines later, is a write nobody could use.
   */
  private announce(): void {
    if (!this.emit || !this.announcing || this.finished) return;
    const entry = entryForRun(this.run, this.emit);
    this.announceChain = this.announceChain.then(() => writeEntry(entry));
  }

  /** The run is over; the entry must be on disk before the process is. */
  private async announceFinal(): Promise<void> {
    if (!this.emit) return;
    const entry = entryForRun(this.run, this.emit);
    this.announceChain = this.announceChain.then(() => writeEntry(entry));
    await this.announceChain.catch(() => undefined);
  }

  /** §4.2.5 — reaping runs on every `cao run`/`cao resume` that writes an entry. Off the loop, never awaited. */
  private kickOffReap(): void {
    if (!this.emit) return;
    void readConfig()
      .then((config) => reap(config.retainDays))
      .catch(() => undefined);
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
      // §4.2.4 — the registry heartbeat is this same 20 s tick, so `lock.json`, `live.json` and the entry
      // never disagree about when this orchestrator was last seen.
      this.announce();
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

