import type { ContextField } from './result.js';

export type OnFailure = 'stop' | 'continue' | 'skip_dependents';
export type WorkspaceMode = 'shared' | 'worktree';
export type WorkspacePreference = 'auto' | WorkspaceMode;
export type WorkingDirectoryStrategy = 'repositoryRoot' | 'launchDirectory';
export type ExecutionMode = 'sequential' | 'dag';
export type AgentName = 'claude' | 'codex';
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RetryPolicy {
  /** Maximum number of retries after the first attempt (0 = no retry). */
  attempts: number;
  includePreviousFailure: boolean;
  /** Reset a reused worktree to its base commit before retrying. */
  resetWorkspace: boolean;
  delayMs: number;
  /**
   * Automatic recoveries from transient API errors (5xx, overloaded, rate limit, network). These do not
   * consume `attempts`; the worker's session is resumed so completed work is kept.
   */
  transientAttempts: number;
  /** Base delay before the first transient recovery; doubles on each consecutive transient failure. */
  transientDelayMs: number;
  /** Upper bound for the transient backoff delay. */
  transientMaxDelayMs: number;
  /** Resume the same Claude session (`--resume`) instead of starting fresh after a transient failure. */
  resumeSession: boolean;
}

export type PermissionMode = 'auto' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'manual';

export interface ClaudeOptions {
  command?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: Exclude<Effort, 'none' | 'minimal'>;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  sessionPersistence?: boolean;
  extraArgs?: string[];
  /** Additional text appended to the system prompt for every worker. */
  appendSystemPrompt?: string;
  /**
   * ask: route permission prompts and AskUserQuestion to the dashboard (default when one is attached);
   * deny: never prompt, anything that would is denied (the only option without a dashboard).
   */
  permissionPrompts?: 'ask' | 'deny';
}

/** Codex CLI controls. `permissionMode` is an ergonomic preset; raw controls win when supplied. */
export interface CodexOptions {
  command?: string;
  permissionMode?: 'auto' | 'readOnly' | 'fullAccess';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'on-request' | 'never';
  addDirs?: string[];
  profile?: string;
  extraArgs?: string[];
}

export interface WorktreeConfig {
  directory: string;
  branchPrefix: string;
  base: 'runStart' | 'headAtStart';
  branchConflict: 'suffix' | 'reuse' | 'fail';
  mergeBack: boolean;
  mergeConflictStrategy: 'agent' | 'claude' | 'codex' | 'fail';
  autoCommit: boolean;
  cleanup: 'onSuccess' | 'always' | 'never';
  copyIgnored: string[];
}

export interface ExecutionConfig {
  mode: ExecutionMode;
  maxConcurrency: number;
  workingDirectoryStrategy: WorkingDirectoryStrategy;
  workspaceStrategy: { sequential: WorkspaceMode; parallel: WorkspaceMode };
  allowUnsafeSharedParallel: boolean;
  worktree: WorktreeConfig;
  stopMode: 'wait' | 'cancel';
  killGraceMs: number;
  outputBufferLines: number;
  /** How long a worker may wait for a human answer before the prompt is denied; null = forever. */
  interactionTimeoutMs: number | null;
}

export interface GitConfig {
  enabled: boolean;
  requireCleanWorkingTree: boolean;
  captureDiff: boolean;
  /** Cap on the bytes written to an attempt's `diff.patch`; `diff.json` is never truncated. */
  maxDiffBytes: number;
}

export interface HooksConfig {
  beforeWorkflow: string[];
  afterWorkflow: string[];
  beforeTask: string[];
  afterTask: string[];
  onTaskFailure: string[];
  /** Runs when a worker is waiting for a human (permission prompt, question); use it to notify yourself. */
  onInputRequired: string[];
}

export type WhenSpec = { task: string; status: string | string[] } | { expr: string };

export interface ContextSource {
  taskId: string;
  include: ContextField[];
}

export interface ResolvedContextSpec {
  sources: ContextSource[];
  includeFailed: boolean;
  maxChars: number;
}

/** A task after templates, foreach expansion, defaults and DAG rules have been applied. */
export interface ResolvedTask {
  id: string;
  sourceId: string;
  name: string;
  type: string;
  docIndex: number;
  dependsOn: string[];
  implicitDeps: string[];
  parallelGroup?: string;
  runner: string;
  agent: AgentName;
  model?: string;
  effort?: Effort;
  /** Prompt with template variables substituted; context is prepended at run time. */
  prompt: string;
  /** Absolute working directory for the shared strategy. */
  workingDirectory: string;
  /** Relative to repositoryRoot ('' = root); re-applied inside worktrees. */
  workingDirectoryRelative: string;
  timeoutMs: number;
  retry: RetryPolicy;
  onFailure: OnFailure;
  runIfDependencyFailed: boolean;
  context: ResolvedContextSpec | null;
  when?: WhenSpec;
  env: Record<string, string>;
  claude: ClaudeOptions;
  codex: CodexOptions;
  /** Completion supplied by the editable workflow file rather than a prior run snapshot. */
  completed?: { completedAt?: string; runId?: string };
  isApproval: boolean;
  workspace: WorkspacePreference;
  vars: Record<string, unknown>;
}

export interface ResolvedWorkflow {
  version: 1;
  name: string;
  configPath: string;
  launchDirectory: string;
  repositoryRoot: string;
  /** Git top-level, if the repository is inside a git repo. */
  gitRoot?: string;
  variables: Record<string, unknown>;
  /** Environment key names supplied to workers (values are never persisted). */
  environmentKeys: string[];
  execution: ExecutionConfig;
  git: GitConfig;
  hooks: HooksConfig;
  claude: ClaudeOptions;
  codex: CodexOptions;
  agent: AgentName;
  model?: string;
  effort?: Effort;
  tasks: ResolvedTask[];
}

/** Runtime-only (never persisted) secrets and env values. */
export interface WorkflowRuntimeEnv {
  environment: Record<string, string>;
  secrets: string[];
}
