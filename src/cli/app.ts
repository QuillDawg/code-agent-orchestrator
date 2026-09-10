/** Application service layer shared by CLI commands: load → normalize → validate → wire runtime. */
import { loadWorkflow, type LoadedWorkflow } from '../config/loader.js';
import { normalizeWorkflow, type Diagnostic } from '../config/normalize.js';
import { validateWorkflow, assertValid, type ValidationResult } from '../workflow/validator.js';
import type { ResolvedWorkflow, WorkflowRun } from 'code-agent-orchestrator-protocol';
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
import { Redactor } from '../logging/redact.js';
import { ConsoleLogger, type Logger } from '../logging/logger.js';
import { Git } from '../workspace/git.js';
import { WorkflowCompletionStore } from '../workflow/completion-store.js';

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
  onError?: (err: unknown) => void;
}

export interface Runtime {
  store: FileRunStore;
  processManager: ProcessManager;
  runners: RunnerRegistry;
  workspace: WorkspaceManager;
  bus: WorkflowEventBus;
  scheduler: WorkflowScheduler;
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
    completion: new WorkflowCompletionStore(run.configPath),
  });
  return { store, processManager, runners, workspace, bus, scheduler, logger, redactor };
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
