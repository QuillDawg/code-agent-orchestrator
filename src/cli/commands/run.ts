import { prepareWorkflow, requireValid, createRuntime, detectRunnersForWorkflow, runnerReadinessError } from '../app.js';
import { createRun } from '../../workflow/run-factory.js';
import { FileRunStore } from '../../persistence/run-store.js';
import { createNativeRunPaths } from '../../persistence/paths.js';
import { formatDiagnostics } from '../../workflow/validator.js';
import { warnLine } from '../../util/marks.js';
import { renderHeader, attachPlainRenderer, renderSummary } from '../render/plain.js';
import { createInterruptController, clearPendingRequests, clearStopRequest, watchStopRequests, INBOX_REQUEST_KINDS } from '../../execution/signals.js';
import { ConsoleLogger, type Logger } from '../../logging/logger.js';
import { Redactor } from '../../logging/redact.js';
import { findActiveRun, isInteractive, parseList, questionLines, resolveWorkflowPath } from '../util.js';
import { planEmit } from '../emit.js';
import { pausedNeeds } from '../../workflow/run-view.js';
import { ConfigError, OrchestratorError, UsageError } from '../../util/errors.js';
import { setCrashPersist } from '../crash.js';
import { runWorkspaceSession, type WorkspaceSession } from '../workspace-session.js';
import type { Runtime } from '../app.js';
import type { SchedulerResult } from '../../workflow/scheduler.js';
import type { WorkflowRun, PermissionMode, Interaction, InteractionAnswer } from 'code-agent-orchestrator-protocol';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

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
  /** `--emit` / `--no-emit`; undefined when neither was given, which lets `CAO_EMIT` and `config.json` decide (§4.2.7). */
  emit?: boolean;
  /** `--emit-feed`; reserved by §4.2.7's transport row and served by nothing yet. */
  emitFeed?: boolean;
  /** `--no-alt-screen` gives `false`; undefined lets `CAO_ALT_SCREEN` and `~/.cao/config.json` decide [D4]. */
  altScreen?: boolean;
  /** `--theme <name>`; `CAO_THEME` and `NO_COLOR` are read when it is absent [D35]. */
  theme?: string;
  /** `--debug`, the same thing as `CAO_DEBUG=1` [D34]. See `applyDebugFlag`. */
  debug?: boolean;
}

/**
 * `--debug` is `CAO_DEBUG=1` and nothing else [D34].
 *
 * Set into the environment rather than threaded through every caller, because that is what makes the two
 * *identical* rather than merely similar: everything that already reads `CAO_DEBUG` - the stack traces on a
 * failed command, and anything a later stage adds - sees exactly what it would have seen had the operator
 * exported it. The flag is one-way: it never turns a `CAO_DEBUG` that is already set off.
 */
export function applyDebugFlag(debug: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (debug) env.CAO_DEBUG = '1';
  return Boolean(env.CAO_DEBUG);
}

export async function runCommand(configPath: string | undefined, opts: RunCommandOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  applyDebugFlag(opts.debug);
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

  const runners = await detectRunnersForWorkflow(workflow, loaded.environment);
  const only = parseList(opts.task);
  const from = parseList(opts.from);
  for (const id of [...only, ...from]) {
    if (!workflow.tasks.some((t) => t.id === id)) throw new ConfigError(`Unknown task "${id}" in --task/--from`);
  }

  if (opts.dryRun) {
    out(renderHeader({ workflow, runId: '(dry run)', runners, layers, verbose: true }));
    for (const runner of runners) {
      const problem = runnerReadinessError(runner);
      if (problem) out(warnLine(problem));
    }
    out('Dry run: no agent sessions were started.');
    return 0;
  }
  const unavailable = runners.map((runner) => runnerReadinessError(runner)).find(Boolean);
  if (unavailable) throw new OrchestratorError(unavailable);

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
  return executeRun({ run, environment: loaded.environment, secrets: loaded.secrets, verbose: opts.verbose, tui: opts.tui, activity: opts.activity, isResume: false, emit: opts.emit, emitFeed: opts.emitFeed, altScreen: opts.altScreen, theme: opts.theme, repository: opts.repository, debug: opts.debug });
}

export interface ExecuteOptions {
  run: WorkflowRun;
  environment: Record<string, string>;
  secrets: string[];
  verbose?: boolean;
  tui?: boolean;
  activity?: boolean;
  isResume: boolean;
  emit?: boolean;
  emitFeed?: boolean;
  /** Passed through to the workspace; both are ignored on the `--no-tui` path, which mounts nothing. */
  altScreen?: boolean;
  theme?: string;
  /** `--repository`, kept so the workspace can re-open the same store when it resumes the run (§2.4). */
  repository?: string;
  /** `--debug` / `CAO_DEBUG=1`: debug into `orchestrator.log`, and the workspace opens on Diagnostics [D34]. */
  debug?: boolean;
}

/**
 * Shared by `run` and `resume`: wires renderer, signal handling and executes the scheduler.
 *
 * Interactive and headless part company here and nowhere else. Headless is exactly what it was — one
 * execution, then the documented tail lines and the exit code. Interactive hands over to the workspace
 * session, which stays open after the run ends, may execute the run again, and returns the exit code of the
 * last execution when the operator leaves (§2.4).
 */
export async function executeRun(opts: ExecuteOptions): Promise<number> {
  if ((opts.tui ?? true) && isInteractive()) {
    return runWorkspaceSession({
      first: opts,
      execute: executeOnce,
      // Printed once the workspace has let the terminal go, so it lands in the shell's scrollback [D4].
      writeTail: (run, result) => writeRunTail(run, result, { summary: true }),
      repository: opts.repository,
      altScreen: opts.altScreen,
      theme: opts.theme,
      verbose: opts.verbose,
      activity: opts.activity,
      // The workspace opens on Diagnostics when the operator has asked for debugging [D34].
      ...(applyDebugFlag(opts.debug) ? { initialTab: 'diagnostics' as const } : {}),
    });
  }
  const result = await executeOnce(opts);
  writeRunTail(opts.run, result);
  return result.exitCode;
}

/**
 * One execution of one run, from wiring the runtime to the scheduler returning.
 *
 * With a `session` the workspace is already on screen and owns everything that outlives an execution — the
 * Ink tree, the plain-output fallback, the exit code, the operator's next intention. Without one this is
 * the headless path, unchanged: a plain renderer for the duration and nothing left behind.
 */
export async function executeOnce(opts: ExecuteOptions, session?: WorkspaceSession): Promise<SchedulerResult> {
  const { run } = opts;
  // §4.2.7, resolved before anything is printed and before the dashboard takes the screen. `announcement` is
  // undefined unless emit is on, and its absence is what keeps a run with emit off from touching `~/.cao`.
  // The inbox is wired below on every path this function takes, so the entry advertises it (§2.3, §4.2.3).
  const emit = await planEmit({ emit: opts.emit, emitFeed: opts.emitFeed, wired: { requests: true, requestKinds: INBOX_REQUEST_KINDS } });
  for (const note of emit.notes) {
    if (session) session.notify(note);
    else process.stdout.write(`${warnLine(note)}\n`);
  }
  const redactor = new Redactor(opts.secrets);
  // `--debug` and `CAO_DEBUG=1` are the same switch [D34]: debug level into `orchestrator.log`, and - on the
  // headless path, where nothing owns the screen - those lines on stderr too.
  const debug = applyDebugFlag(opts.debug);
  // Through the layout accessor, not a hand-built string: the run directory is described in exactly one
  // place, and that place is the protocol package (spec §4.1, §6.4.1).
  const logFile = createNativeRunPaths(run.repositoryRoot).runLogFile(run.runId);
  /**
   * `orchestrator.log`, written synchronously.
   *
   * Two things an async `appendFile` per line got wrong, and both of them show up in the one file a bug
   * report is built from. Concurrent appends have no ordering guarantee, so a timestamped log could come
   * out with its lines shuffled; and a fire-and-forget write in flight when the process leaves is a write
   * that never lands — which is exactly the last line, the one saying how the run ended. A log line is a
   * few dozen bytes and, below `--debug`, only a warning or an error, so the cost of being sure is nil.
   */
  const fileSink = (line: string): void => {
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      /* a log that cannot be written must not stop the run it is a log of */
    }
  };
  const logger: Logger = new ConsoleLogger({
    level: opts.verbose || debug ? 'debug' : 'info',
    redactor,
    sink: (line) => {
      // Never write over an open dashboard frame; line mode gets the log on stderr as before.
      if (!session?.isOpen) process.stderr.write(`${line}\n`);
      fileSink(line);
    },
  });

  const approvalHandler = session ? (task: import('code-agent-orchestrator-protocol').ResolvedTask) => session.requestApproval(task) : undefined;
  const interactionHandler = session ? (interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer> => session.requestInteraction(interaction, signal) : undefined;
  const runtime: Runtime = createRuntime({ run, environment: opts.environment, secrets: opts.secrets, logger, verbose: opts.verbose, isResume: opts.isResume, approvalHandler, interactionHandler, emit: emit.announcement });
  const { scheduler, controller, bus, processManager, store } = runtime;

  const interrupt = createInterruptController({ controller, processManager, logger });
  // The escalation a `kill` command asks for, wired here because the interrupt controller needs the run
  // controller to exist first and the run controller needs somewhere to escalate to (§2.2).
  controller.setKillHandler(() => interrupt.forceKill());
  const disposeSignals = interrupt.install();
  // A crash has no `finally`; this is the scheduler's only chance to write what it knows (§2.4).
  setCrashPersist(() => controller.persistInterruptedSync());
  // A leftover request from the run that was stopped must not stop the one resuming it.
  await clearStopRequest(store.paths, run.runId);
  await clearPendingRequests(store.paths, run.runId);
  const disposeStopWatcher = watchStopRequests({
    paths: store.paths,
    runId: run.runId,
    controller,
    logger,
    // The controller has already applied the stop by the time this runs, so this is the other half of a
    // Ctrl+C and nothing more: shut the workers down, and force it if a second stop arrives.
    onStop: (request) => interrupt.beginShutdown(`${request.source ?? 'cao stop'} (pid ${request.pid})`),
  });

  let detachPlain: (() => void) | undefined;
  if (session) session.attach({ run, bus, controller, interrupt });
  else detachPlain = attachPlainRenderer(bus, run, { verbose: opts.verbose, showActivity: opts.activity });

  try {
    return await scheduler.execute();
  } finally {
    disposeSignals();
    disposeStopWatcher();
    setCrashPersist(undefined);
    await clearStopRequest(store.paths, run.runId);
    // The watcher stops on a tick boundary, so a request written in the half second after it would be left
    // in `requests/` with nobody to answer it and its sender would wait out the whole of `--wait` (§2.3).
    await clearPendingRequests(store.paths, run.runId, 'shutdown');
    detachPlain?.();
  }
}

/**
 * What a run prints about itself once nothing is going to change it any more: the summary table, then the
 * one line that says what to do next.
 *
 * Headless prints it as the process ends. The workspace prints it after it has left the alternate screen,
 * so it lands in the scrollback of the shell the run was started from [D4].
 */
export function writeRunTail(run: WorkflowRun, result: SchedulerResult, opts: { summary?: boolean } = {}): void {
  if (opts.summary) process.stdout.write(`\n${renderSummary(run)}\n`);
  if (result.state === 'paused') {
    const needs = pausedNeeds(run);
    process.stdout.write('\nWorkflow paused.\n');
    for (const need of needs) {
      process.stdout.write(`  ${need.kind === 'approval' ? 'Approval' : 'Input'} required for "${need.taskId}":\n`);
      // The question itself, indented under the task: an operator who has to answer it should not have to
      // run another command to find out what was asked.
      for (const line of questionLines(need.question, 6)) process.stdout.write(`    ${line}\n`);
      process.stdout.write(`    ${need.command}\n`);
    }
    // One answer per invocation, so a run paused on several questions needs one resume each.
    if (needs.filter((n) => n.kind === 'input').length > 1) process.stdout.write('  Answers are given one task at a time; each cao resume carries the run on to the next.\n');
  } else if (result.state === 'interrupted') {
    process.stdout.write(`\nRun interrupted. Resume with: cao resume ${run.runId}\n`);
  } else if (result.state === 'failed') {
    process.stdout.write(`\nRun failed. Inspect with: cao status ${run.runId}   Retry with: cao resume ${run.runId}\n`);
  }
}
