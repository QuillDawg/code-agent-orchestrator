import path from 'node:path';
import readline from 'node:readline';
import { prepareWorkflow, requireValid, createRuntime, detectRunnersForWorkflow } from '../app.js';
import { createRun } from '../../workflow/run-factory.js';
import { FileRunStore } from '../../persistence/run-store.js';
import { formatDiagnostics } from '../../workflow/validator.js';
import { warnLine } from '../../util/marks.js';
import { glyph } from '../../util/glyphs.js';
import { renderHeader, attachPlainRenderer, renderSummary } from '../render/plain.js';
import { createInterruptController, clearStopRequest, watchStopRequests } from '../../execution/signals.js';
import { ConsoleLogger, type Logger } from '../../logging/logger.js';
import { Redactor } from '../../logging/redact.js';
import { findActiveRun, isInteractive, parseList, resolveWorkflowPath } from '../util.js';
import { ConfigError, OrchestratorError, UsageError } from '../../util/errors.js';
import type { WorkflowRun } from '../../types/run.js';
import type { Runtime } from '../app.js';
import type { PermissionMode } from '../../types/workflow.js';
import type { Interaction, InteractionAnswer } from '../../types/interaction.js';
import { appendLine } from '../../util/fs.js';
import { BELL } from '../../util/misc.js';
import type { DashboardController } from '../../tui/app.js';

export interface RunCommandOptions {
  dryRun?: boolean;
  task?: string[];
  from?: string[];
  verbose?: boolean;
  tui?: boolean;
  maxConcurrency?: number;
  permissionMode?: PermissionMode;
  repository?: string;
  claudeCommand?: string;
  activity?: boolean;
}

export async function runCommand(configPath: string | undefined, opts: RunCommandOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const prepared = await prepareWorkflow(await resolveWorkflowPath(configPath), {
    repository: opts.repository,
    maxConcurrency: opts.maxConcurrency,
    permissionMode: opts.permissionMode,
    claudeCommand: opts.claudeCommand,
  });
  const warnings = prepared.diagnostics.filter((d) => d.level === 'warning');
  if (warnings.length) out(formatDiagnostics(warnings));
  requireValid(prepared);
  const { workflow, layers, loaded } = prepared;

  const runners = await detectRunnersForWorkflow(workflow);
  const only = parseList(opts.task);
  const from = parseList(opts.from);
  for (const id of [...only, ...from]) {
    if (!workflow.tasks.some((t) => t.id === id)) throw new ConfigError(`Unknown task "${id}" in --task/--from`);
  }

  if (opts.dryRun) {
    out(renderHeader({ workflow, runId: '(dry run)', runners, layers, verbose: true }));
    for (const runner of runners) if (!runner.found) out(warnLine(`${runner.runner} CLI not detected (${runner.command}): ${runner.error ?? ''}`));
    out('Dry run: no agent sessions were started.');
    return 0;
  }
  const missing = runners.find((runner) => !runner.found);
  if (missing) throw new OrchestratorError(`${missing.runner} CLI not found (${missing.command}): ${missing.error ?? 'unknown error'}. Install it or configure that runner in the workflow.`);

  const redactor = new Redactor(loaded.secrets);
  const store = new FileRunStore(workflow.repositoryRoot, redactor);
  // Two orchestrators in one repository fight over the shared worktree and the same branch names, so every
  // run is checked before a new one is created, not only the (always free) lock of this one.
  const active = await findActiveRun(store);
  if (active) {
    throw new UsageError(
      `Run ${active.runId} is already running in ${workflow.repositoryRoot} (orchestrator pid ${active.orchestrator.pid}). Watch it with "cao status ${active.runId}" or stop it with "cao stop ${active.runId}".`,
    );
  }
  const run = await createRun(store, { workflow, rawConfig: loaded.raw, selection: { only, from }, claudeVersion: runners.find((runner) => runner.runner === 'claude')?.version });
  const lock = await store.acquireLock(run.runId);
  if (!lock.ok) throw new UsageError(`Run ${run.runId} is owned by another orchestrator process (pid ${lock.lock.pid}, heartbeat ${lock.lock.heartbeatAt})`);

  out(renderHeader({ workflow, runId: run.runId, runners, layers, verbose: opts.verbose }));
  return executeRun({ run, environment: loaded.environment, secrets: loaded.secrets, verbose: opts.verbose, tui: opts.tui, activity: opts.activity, isResume: false });
}

export interface ExecuteOptions {
  run: WorkflowRun;
  environment: Record<string, string>;
  secrets: string[];
  verbose?: boolean;
  tui?: boolean;
  activity?: boolean;
  isResume: boolean;
}

/** Shared by `run` and `resume`: wires renderer, signal handling and executes the scheduler. */
export async function executeRun(opts: ExecuteOptions): Promise<number> {
  const { run } = opts;
  const useTui = (opts.tui ?? true) && isInteractive();
  const redactor = new Redactor(opts.secrets);
  const logFile = path.join(run.repositoryRoot, '.orchestrator', 'runs', run.runId, 'orchestrator.log');
  const fileSink = (line: string): void => {
    void appendLine(logFile, line).catch(() => undefined);
  };
  let dashboard: DashboardController | undefined;
  const logger: Logger = new ConsoleLogger({
    level: opts.verbose ? 'debug' : 'info',
    redactor,
    sink: (line) => {
      // Never write over an open dashboard frame; line mode gets the log on stderr as before.
      if (!dashboard?.isOpen) process.stderr.write(`${line}\n`);
      fileSink(line);
    },
  });

  const approvalHandler = useTui ? async (task: import('../../types/workflow.js').ResolvedTask) => (dashboard ? dashboard.requestApproval(task) : ('defer' as const)) : undefined;
  const interactionHandler = useTui
    ? async (interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer> =>
        dashboard ? dashboard.requestInteraction(interaction, signal) : { kind: 'deny', message: 'No dashboard is attached; finish with status needs_input if you cannot continue' }
    : undefined;
  const runtime: Runtime = createRuntime({ run, environment: opts.environment, secrets: opts.secrets, logger, verbose: opts.verbose, isResume: opts.isResume, approvalHandler, interactionHandler });
  const { scheduler, bus, processManager, store } = runtime;

  const interrupt = createInterruptController({ scheduler, processManager, logger });
  const disposeSignals = interrupt.install();
  // A leftover request from the run that was stopped must not stop the one resuming it.
  await clearStopRequest(store.paths, run.runId);
  const disposeStopWatcher = watchStopRequests({
    paths: store.paths,
    runId: run.runId,
    onStop: (request) => interrupt.interrupt(`${request.source ?? 'cao stop'} (pid ${request.pid})`),
  });

  let detachPlain: (() => void) | undefined;
  const attachPlain = (): void => {
    if (detachPlain) return;
    detachPlain = attachPlainRenderer(bus, run, { verbose: opts.verbose, showActivity: opts.activity });
  };
  const detach = (): void => {
    detachPlain?.();
    detachPlain = undefined;
  };

  // While minimised, a raw-mode key listener lets D/Enter reopen the dashboard and Ctrl+C still interrupts.
  let minimisedKeys: ((s: string, key: { name?: string; ctrl?: boolean }) => void) | undefined;
  const stopMinimisedKeys = (): void => {
    if (!minimisedKeys) return;
    process.stdin.off('keypress', minimisedKeys);
    minimisedKeys = undefined;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };
  const reopen = (): void => {
    if (!dashboard || dashboard.isOpen) return;
    stopMinimisedKeys();
    detach();
    dashboard.open();
  };
  const startMinimisedKeys = (): void => {
    if (!process.stdin.isTTY || minimisedKeys) return;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    minimisedKeys = (_s, key) => {
      if (key.ctrl && key.name === 'c') interrupt.interrupt('Ctrl+C');
      else if (key.name === 'd' || key.name === 'return') reopen();
    };
    process.stdin.on('keypress', minimisedKeys);
  };

  if (useTui) {
    const { createDashboard } = await import('../../tui/app.js');
    dashboard = createDashboard({
      run,
      bus,
      scheduler,
      onMinimise: () => {
        process.stdout.write(`\nDashboard minimised ${glyph('dash')} the run continues. Press D to reopen, Ctrl+C to stop.\n`);
        attachPlain();
        startMinimisedKeys();
      },
      onInterrupt: () => interrupt.interrupt('Ctrl+C'),
    });
    // A request for a human reopens a minimised dashboard: switch the surfaces back.
    bus.onAny((ev) => {
      if ((ev.type === 'task.interaction.requested' || ev.type === 'task.awaiting_approval') && dashboard && !dashboard.isOpen) {
        process.stdout.write(BELL);
        reopen();
      }
    });
    dashboard.open();
  } else {
    attachPlain();
  }

  let result;
  try {
    result = await scheduler.execute();
  } finally {
    disposeSignals();
    disposeStopWatcher();
    await clearStopRequest(store.paths, run.runId);
    stopMinimisedKeys();
    if (dashboard) {
      await dashboard.finish();
      detach();
      process.stdout.write(`\n${renderSummary(run)}\n`);
    }
  }
  if (result.state === 'paused') {
    const waiting = Object.values(run.tasks).filter((t) => t.state === 'awaiting_approval' || t.state === 'needs_input');
    process.stdout.write('\nWorkflow paused.\n');
    for (const t of waiting) {
      if (t.state === 'awaiting_approval') process.stdout.write(`  Approval required for "${t.id}": cao resume ${run.runId} --approve ${t.id}   (or --reject ${t.id})\n`);
      else process.stdout.write(`  Input required for "${t.id}": cao resume ${run.runId} --task ${t.id} --input "<your answer>"\n`);
    }
  } else if (result.state === 'interrupted') {
    process.stdout.write(`\nRun interrupted. Resume with: cao resume ${run.runId}\n`);
  } else if (result.state === 'failed') {
    process.stdout.write(`\nRun failed. Inspect with: cao status ${run.runId}   Retry with: cao resume ${run.runId}\n`);
  }
  return result.exitCode;
}
