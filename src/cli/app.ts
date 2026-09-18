/** Application service layer shared by CLI commands: load → normalize → validate → wire runtime. */
import { loadWorkflow, type LoadedWorkflow } from '../config/loader.js';
import { normalizeWorkflow, type Diagnostic } from '../config/normalize.js';
import { validateWorkflow, assertValid, buildGraph, type ValidationResult } from '../workflow/validator.js';
import type { ControlSource, PermissionMode, ResolvedWorkflow, WorkflowRun } from 'code-agent-orchestrator-protocol';
import { FileRunStore } from '../persistence/run-store.js';
import { ProcessManager } from '../execution/process-manager.js';
import { RunnerRegistry } from '../runners/task-runner.js';
import { ClaudeRunner } from '../runners/claude/claude-runner.js';
import { detectClaude } from '../runners/claude/detect.js';
import { CodexRunner } from '../runners/codex/codex-runner.js';
import { detectCodex } from '../runners/codex/detect.js';
import type { AgentCapability, AgentRuntimeDetection } from '../runners/capabilities.js';
import { mergeCapabilityNeeds, runnerReadinessError, type CapabilityNeed } from '../runners/preflight.js';
import { claudeCapabilityNeeds } from '../runners/claude/preflight.js';
import { codexCapabilityNeeds } from '../runners/codex/preflight.js';
import { GitWorkspaceManager, SharedOnlyWorkspaceManager, type WorkspaceManager } from '../workspace/workspace-manager.js';
import { WorkflowEventBus } from '../events/event-bus.js';
import { ShellHookRunner } from '../execution/hooks.js';
import { WorkflowScheduler, type SchedulerDeps } from '../workflow/scheduler.js';
import { createRunController, type RunController } from '../workflow/control/controller.js';
import { registerLocalController } from '../workflow/control/local.js';
import { Redactor } from '../logging/redact.js';
import { ConsoleLogger, type Logger } from '../logging/logger.js';
import { Git } from '../workspace/git.js';
import { WorkflowCompletionStore } from '../workflow/completion-store.js';
import { reconcileForResume } from '../workflow/run-factory.js';
import { OrchestratorError, UsageError } from '../util/errors.js';
import { pathExists } from '../util/fs.js';
import { openStore, parseList } from './util.js';

export interface PreparedWorkflow {
  loaded: LoadedWorkflow;
  workflow: ResolvedWorkflow;
  validation: ValidationResult;
  diagnostics: Diagnostic[];
  layers: string[][];
}

export interface PrepareOptions {
  launchDirectory?: string;
  repository?: string;
  maxConcurrency?: number;
  permissionMode?: ResolvedWorkflow['claude']['permissionMode'];
  claudeCommand?: string;
  knownRunners?: string[];
}

export interface WorkflowOverrides {
  maxConcurrency?: number;
  permissionMode?: ResolvedWorkflow['claude']['permissionMode'];
  claudeCommand?: string;
}

/** The CLI flags that override a workflow in place. `run` applies them while loading, `resume` on the stored copy. */
export function applyWorkflowOverrides(workflow: ResolvedWorkflow, opts: WorkflowOverrides): void {
  if (opts.maxConcurrency !== undefined) workflow.execution.maxConcurrency = opts.maxConcurrency;
  if (opts.permissionMode) {
    workflow.claude.permissionMode = opts.permissionMode;
    for (const t of workflow.tasks) t.claude.permissionMode = opts.permissionMode;
  }
  if (opts.claudeCommand) {
    workflow.claude.command = opts.claudeCommand;
    for (const t of workflow.tasks) t.claude.command = opts.claudeCommand;
  }
}

export async function prepareWorkflow(configPath: string, opts: PrepareOptions = {}): Promise<PreparedWorkflow> {
  const loaded = await loadWorkflow(configPath, { launchDirectory: opts.launchDirectory, repository: opts.repository });
  const { workflow, diagnostics } = await normalizeWorkflow(loaded);
  applyWorkflowOverrides(workflow, opts);
  const gitAvailable = Boolean(workflow.gitRoot) && (await Git.isAvailable());
  const validation = validateWorkflow(workflow, diagnostics, { knownRunners: opts.knownRunners ?? ['claude', 'codex'], gitAvailable });
  return { loaded, workflow, validation, diagnostics: validation.diagnostics, layers: validation.layers ?? [] };
}

export function requireValid(prepared: PreparedWorkflow): void {
  assertValid(prepared.validation);
}

export interface RuntimeOptions {
  run: WorkflowRun;
  environment: Record<string, string>;
  secrets: string[];
  logger?: Logger;
  verbose?: boolean;
  isResume?: boolean;
  approvalHandler?: SchedulerDeps['approvalHandler'];
  interactionHandler?: SchedulerDeps['interactionHandler'];
  /**
   * Announce this run in `~/.cao/runs` (§4.2.4). **Absent means off** — `planEmit` returns it only when
   * §4.2.7 says emit is on, and with it absent the scheduler never touches `~/.cao`.
   */
  emit?: SchedulerDeps['emit'];
  onError?: (err: unknown) => void;
}

export interface Runtime {
  store: FileRunStore;
  processManager: ProcessManager;
  runners: RunnerRegistry;
  workspace: WorkspaceManager;
  bus: WorkflowEventBus;
  scheduler: WorkflowScheduler;
  /**
   * The only way anything outside `src/workflow/` changes this run's execution state (spec §2.2). The
   * dashboard and the CLI commands hold this; nothing but `src/workflow/` holds the scheduler.
   */
  controller: RunController;
  logger: Logger;
  redactor: Redactor;
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { run } = opts;
  const redactor = new Redactor(opts.secrets);
  const logger = opts.logger ?? new ConsoleLogger({ level: opts.verbose ? 'debug' : 'info', redactor });
  const store = new FileRunStore(run.repositoryRoot, redactor);
  const processManager = new ProcessManager({ killGraceMs: run.workflow.execution.killGraceMs, logger });
  const runners = new RunnerRegistry()
    .register(new ClaudeRunner({ processManager, defaults: run.workflow.claude, bufferLines: run.workflow.execution.outputBufferLines }))
    .register(new CodexRunner({ processManager, defaults: run.workflow.codex, bufferLines: run.workflow.execution.outputBufferLines }));
  const workspace: WorkspaceManager = run.workflow.gitRoot && run.workflow.git.enabled
    ? new GitWorkspaceManager(run.workflow, logger)
    : new SharedOnlyWorkspaceManager(run.workflow);
  const bus = new WorkflowEventBus(run.runId, run.eventSeq, (err) => logger.error(`event handler failed: ${(err as Error).message}`));
  bus.onAny((ev) => {
    void store.appendEvent(ev).catch((err) => logger.error(`cannot append event: ${(err as Error).message}`));
  });
  const hooks = new ShellHookRunner(run.workflow, bus, opts.environment, logger);
  const scheduler = new WorkflowScheduler({
    run,
    store,
    runners,
    workspace,
    bus,
    hooks,
    logger,
    environment: opts.environment,
    approvalHandler: opts.approvalHandler,
    interactionHandler: opts.interactionHandler,
    isResume: opts.isResume,
    emit: opts.emit,
    completion: new WorkflowCompletionStore(run.configPath),
  });
  const controller = createRunController({ scheduler });
  // So a command raised in this process reaches the controller directly instead of writing a request file
  // for itself to poll (§2.2); `cao task stop|restart` is the caller.
  registerLocalController(run.runId, controller);
  return { store, processManager, runners, workspace, bus, scheduler, controller, logger, redactor };
}

/**
 * The run is owned by a process that is still alive.
 *
 * A distinct type rather than a message, because the two callers need different things from it: `cao resume`
 * prints it and stops, and the workspace flips to observer and names the pid in its banner (§2.1, [D36]).
 */
export class RunLockedError extends OrchestratorError {
  readonly pid: number;
  constructor(runId: string, pid: number, heartbeatAt: string) {
    super(`Run ${runId} is owned by another orchestrator process (pid ${pid}, heartbeat ${heartbeatAt})`);
    this.name = 'RunLockedError';
    this.pid = pid;
  }
}

export interface StartRuntimeOptions {
  repository?: string;
  retryFailed?: boolean;
  approve?: string[];
  reject?: string[];
  input?: string;
  /**
   * A follow-up to carry into the next attempt of one task (§3.5, `[D25]`): what `cao task prompt` sends to
   * a run nobody is executing, and what the workspace's composer sends on an ended run. `input` is the same
   * errand restricted to a task holding a question, and is left exactly as documented.
   */
  followUp?: { taskId: string; text: string; source?: ControlSource; freshSession?: boolean };
  task?: string[];
  from?: string[];
  maxConcurrency?: number;
  permissionMode?: PermissionMode;
  claudeCommand?: string;
  verbose?: boolean;
  /**
   * Where the warnings this used to print go. `cao resume` writes them to stdout above the header; the
   * workspace turns them into notices, because it has no stdout to write to while it holds the screen.
   */
  onNote?: (note: string) => void;
}

/** A run reconciled, locked and ready for `executeRun`, or a reason there is nothing to execute. */
export type StartedRuntime =
  | {
      kind: 'ready';
      run: WorkflowRun;
      store: FileRunStore;
      environment: Record<string, string>;
      secrets: string[];
      runners: RunnerDetection[];
      layers: string[][];
      /** Tasks `reconcileForResume` put back to pending, for the line `cao resume` prints. */
      rerun: string[];
    }
  | { kind: 'nothing-to-do'; run: WorkflowRun; message: string };

/**
 * Everything between "resume this run" and "execute it": validate the arguments against the persisted run,
 * reload the environment, probe the agents, take `lock.json`, and reconcile the run for another pass.
 *
 * `cao resume` is this plus a header and `executeRun`; every ended-state action in the workspace is this
 * plus the same `executeRun` into the workspace that is already open (§2.4). Factored out so those two can
 * never drift: an action that skipped one of these steps would leave the run owned by a process that then
 * refused to execute it, or start a second orchestrator in a tree that already has one.
 *
 * Nothing here mutates anything before it is sure: a mistyped task id, a repository that has moved and an
 * agent CLI that has gone missing are all discovered before the lock is taken.
 */
export async function startRuntime(runRef: string | undefined, opts: StartRuntimeOptions = {}): Promise<StartedRuntime> {
  const note = opts.onNote ?? ((): void => undefined);
  const store = await openStore(opts.repository);
  const runId = await store.resolveRunId(runRef);
  const run = await store.loadRun(runId);
  // The stored workflow is what a resumed run executes, so the same overrides `cao run` accepts apply here.
  applyWorkflowOverrides(run.workflow, { maxConcurrency: opts.maxConcurrency, permissionMode: opts.permissionMode, claudeCommand: opts.claudeCommand });

  if (run.state === 'cancelled') throw new OrchestratorError(`Run ${runId} was cancelled and cannot be resumed`);
  if (!(await pathExists(run.repositoryRoot))) throw new OrchestratorError(`Repository for run ${runId} no longer exists: ${run.repositoryRoot}`);

  // Environment values are never persisted: reload them before auth/capability probes and execution.
  let environment: Record<string, string> = {};
  let secrets: string[] = [];
  try {
    const loaded = await loadWorkflow(run.configPath, { launchDirectory: run.launchDirectory, repository: run.repositoryRoot });
    environment = loaded.environment;
    secrets = loaded.secrets;
  } catch (err) {
    note(`Could not reload environment from ${run.configPath}: ${(err as Error).message}`);
  }

  // Everything that can be decided from the arguments and the persisted run is decided before the lock is
  // taken: a mistyped --task must not leave the run owned by a process that then exits.
  const only = parseList(opts.task);
  const from = parseList(opts.from);
  const input = opts.input !== undefined ? { taskId: only[0] ?? '', text: opts.input } : undefined;
  if (input && !input.taskId) throw new UsageError('--input requires --task <id> to name the task that needs input');
  if (input) {
    // Answers are delivered one task at a time: an answer belongs to the question one worker asked, and
    // pairing several of them with several --task values on one line is guesswork the operator cannot see.
    if (only.length > 1) throw new UsageError(`--input answers one task at a time; name a single --task (got ${only.join(', ')}) and resume again for the next one`);
    const target = run.tasks[input.taskId];
    if (!target) throw new UsageError(`Run ${runId} has no task "${input.taskId}"`);
    if (target.state !== 'needs_input') {
      const waiting = Object.values(run.tasks).filter((t) => t.state === 'needs_input').map((t) => t.id);
      const alternative = waiting.length ? ` Waiting for an answer: ${waiting.join(', ')}.` : ' No task in this run is waiting for an answer.';
      throw new UsageError(`Task "${input.taskId}" is ${target.state}, not needs_input, so there is no question for --input to answer.${alternative}`);
    }
  }

  // Probe workers before acquiring the run lock or killing/reclassifying orphaned attempts. A bad CLI
  // should leave the persisted run and any recoverable worker exactly as they were.
  const runners = await detectRunnersForWorkflow(run.workflow, environment);
  const unavailable = runners.map((runner) => runnerReadinessError(runner)).find(Boolean);
  if (unavailable) throw new OrchestratorError(unavailable);

  const lock = await store.acquireLock(runId);
  if (!lock.ok) throw new RunLockedError(runId, lock.lock.pid, lock.lock.heartbeatAt);

  if (opts.followUp) {
    const target = run.tasks[opts.followUp.taskId];
    if (!target) throw new UsageError(`Run ${runId} has no task "${opts.followUp.taskId}"`);
  }
  // A follow-up continues the run around the task it names, exactly as an answer does: `--task` is how the
  // task is named, not a request to run only it.
  const restrict = input || opts.followUp ? [] : only;
  const selection = only.length || from.length ? { only: restrict, from } : undefined;
  if (run.state === 'completed' && !selection) {
    await store.releaseLock(runId);
    return { kind: 'nothing-to-do', run, message: `Run ${runId} already completed. Use --task <id> or --from <id> to re-run specific tasks.` };
  }

  const reconciliation = await reconcileForResume(run, {
    retryFailed: opts.retryFailed,
    approve: parseList(opts.approve),
    reject: parseList(opts.reject),
    input,
    followUp: opts.followUp,
    selection,
  });
  for (const n of reconciliation.notes) note(n);

  return { kind: 'ready', run, store, environment, secrets, runners, layers: buildGraph(run.workflow).layers(), rerun: reconciliation.rerun };
}

export async function detectClaudeForWorkflow(workflow: ResolvedWorkflow): Promise<{ version?: string; command: string; found: boolean; error?: string }> {
  const d = await detectClaude(workflow.claude.command);
  return { version: d.version, command: d.command, found: d.found, error: d.error };
}

export interface RunnerDetection extends AgentRuntimeDetection {
  runner: 'claude' | 'codex';
  requiredCapabilities?: AgentCapability[];
  /** The same capabilities with the option and the workflow key that asked for each of them. */
  capabilityNeeds?: CapabilityNeed[];
}

export { runnerReadinessError };

/** Detect only runners that can be launched by this workflow. */
export async function detectRunnersForWorkflow(workflow: ResolvedWorkflow, environment?: Record<string, string>): Promise<RunnerDetection[]> {
  const active = workflow.tasks.filter((task) => !task.completed);
  const claudeCommands = new Map<string | undefined, CapabilityNeed[]>();
  const codexCommands = new Map<string | undefined, CapabilityNeed[]>();
  for (const task of active) {
    if (task.agent === 'claude') {
      claudeCommands.set(task.claude.command, [...(claudeCommands.get(task.claude.command) ?? []), ...claudeCapabilityNeeds(task.claude)]);
    } else if (task.agent === 'codex') {
      codexCommands.set(task.codex.command, [...(codexCommands.get(task.codex.command) ?? []), ...codexCapabilityNeeds(task.codex)]);
    }
  }
  const detected: RunnerDetection[] = [];
  for (const [command, needs] of claudeCommands) {
    const value = await detectClaude(command ?? workflow.claude.command, environment);
    const merged = mergeCapabilityNeeds(needs);
    detected.push({ runner: 'claude', ...value, requiredCapabilities: merged.map((need) => need.capability), capabilityNeeds: merged });
  }
  for (const [command, needs] of codexCommands) {
    const value = await detectCodex(command ?? workflow.codex.command, environment);
    const merged = mergeCapabilityNeeds(needs);
    detected.push({ runner: 'codex', ...value, requiredCapabilities: merged.map((need) => need.capability), capabilityNeeds: merged });
  }
  return detected;
}
