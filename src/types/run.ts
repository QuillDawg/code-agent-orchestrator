import type { EnrichedTaskResult, RunnerUsage, TaskResult } from './result.js';
import type { ResolvedWorkflow, WorkspaceMode } from './workflow.js';
import type { InteractionRecord } from './interaction.js';
import type { FileOp } from './transcript.js';

export const TASK_STATES = [
  'pending',
  'ready',
  'running',
  'waiting',
  'awaiting_approval',
  'needs_input',
  'success',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'success',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
]);

/** States with a live worker process (`waiting` = the worker is blocked on a human answer). */
export const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['running', 'waiting']);

export type TaskReason =
  | 'when_false'
  | 'not_selected'
  | 'agent_skipped'
  | 'upstream_failed'
  | 'upstream_skipped'
  | 'agent_blocked'
  | 'exhausted_retries'
  | 'timeout'
  | 'invalid_result'
  | 'crash'
  | 'api_error'
  | 'rejected'
  | 'merge_conflict'
  | 'needs_input'
  | 'stop_requested'
  | 'user_interrupt';

export type RunState = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export type AttemptOutcome =
  | 'success'
  | 'failed'
  | 'blocked'
  | 'needs_input'
  | 'skipped'
  | 'timeout'
  | 'crash'
  /** Transient API/network failure (5xx, overloaded, rate limit, connection reset). Retried by resuming the session. */
  | 'api_error'
  | 'invalid_result'
  | 'merge_conflict'
  | 'cancelled'
  | 'interrupted';

export interface WorkspaceInfo {
  kind: WorkspaceMode;
  path: string;
  cwd: string;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  mergedSha?: string;
  dirtyAtEnd?: boolean;
  cleanedUp?: boolean;
  /** Shared tree only: git tree object of the working tree when the attempt started. */
  treeBefore?: string;
  /** Shared tree only: git tree object of the working tree when the attempt ended. */
  treeAfter?: string;
  /** Merge attempts only: shared-tree HEAD before the conflicting merge, i.e. the merge attempt's diff base. */
  mergeBaseSha?: string;
}

export interface FileTouch {
  ops: number;
  lastOp: FileOp;
}

export interface TaskAttempt {
  number: number;
  kind: 'task' | 'merge';
  triggeredBy: 'initial' | 'retry' | 'resume' | 'user_input';
  sessionId?: string;
  /** Set when this attempt continued a previous attempt's Claude session (transient API error recovery). */
  resumedSessionId?: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  outcome?: AttemptOutcome;
  error?: string;
  cwd: string;
  workspace?: WorkspaceInfo;
  result?: TaskResult;
  /** Live while the attempt runs (tokens, context size), final totals once it ends. */
  usage?: RunnerUsage;
  /** Files the worker edited or wrote, keyed by path relative to the repository root. */
  files?: Record<string, FileTouch>;
  /** Every human interaction (permission prompt / question) this attempt went through. */
  interactions?: InteractionRecord[];
}

export interface TaskRunState {
  id: string;
  state: TaskState;
  reason?: TaskReason;
  message?: string;
  blockedBy?: string;
  attempts: TaskAttempt[];
  currentAttempt?: number;
  /** Attempt number at which the current retry budget started (reset on resume). */
  retryWindowStart: number;
  retryNotBefore?: string;
  /** Claude session to resume on the next attempt (set after a transient API error). */
  resumeSessionId?: string;
  result?: EnrichedTaskResult;
  startedAt?: string;
  endedAt?: string;
  lastActivity?: string;
  userInput?: string;
  approval?: { decision: 'approved' | 'rejected'; at: string; note?: string };
  /** Set while state === 'waiting': what the worker is waiting on. */
  pendingInteraction?: InteractionRecord;
}

export interface RunSelection {
  only?: string[];
  from?: string[];
}

export interface WorkflowRun {
  schemaVersion: 1;
  runId: string;
  workflowName: string;
  configPath: string;
  workflowHash: string;
  launchDirectory: string;
  repositoryRoot: string;
  baseBranch?: string;
  baseCommit?: string;
  claudeVersion?: string;
  selection: RunSelection;
  workflow: ResolvedWorkflow;
  tasks: Record<string, TaskRunState>;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  orchestratorPid?: number;
  resumeCount: number;
  eventSeq: number;
  exitCode?: number;
  /** Where the run wrote its `report.md` when it ended; relative to `repositoryRoot` when it is inside it. */
  reportPath?: string;
}

export interface RunSummary {
  total: number;
  success: number;
  failed: number;
  blocked: number;
  skipped: number;
  cancelled: number;
  pending: number;
}

export interface ActiveProcess {
  taskId: string;
  attempt: number;
  pid: number;
  startedAt: string;
  workingDirectory: string;
  status: 'starting' | 'running' | 'terminating' | 'exited';
}

export interface LiveTaskStatus {
  state: TaskState;
  attempt?: number;
  pid?: number;
  startedAt?: string;
  workingDirectory?: string;
  branch?: string;
  lastActivity?: string;
  lastLines: string[];
  usage?: RunnerUsage;
  filesChanged?: number;
  pendingInteraction?: InteractionRecord;
}

export interface LiveStatus {
  runId: string;
  orchestratorPid: number;
  heartbeatAt: string;
  state: RunState;
  tasks: Record<string, LiveTaskStatus>;
}
