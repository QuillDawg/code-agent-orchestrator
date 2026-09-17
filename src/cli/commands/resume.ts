import { openStore, parseList } from '../util.js';
import { reconcileForResume } from '../../workflow/run-factory.js';
import { executeRun } from './run.js';
import { renderHeader } from '../render/plain.js';
import { buildGraph } from '../../workflow/validator.js';
import { loadWorkflow } from '../../config/loader.js';
import { OrchestratorError, UsageError } from '../../util/errors.js';
import { pathExists } from '../../util/fs.js';
import { applyWorkflowOverrides, detectRunnersForWorkflow, runnerReadinessError } from '../app.js';
import { warnLine } from '../../util/marks.js';
import type { PermissionMode } from 'code-agent-orchestrator-protocol';

export interface ResumeOptions {
  repository?: string;
  retryFailed?: boolean;
  approve?: string[];
  reject?: string[];
  input?: string;
  task?: string[];
  from?: string[];
  verbose?: boolean;
  tui?: boolean;
  activity?: boolean;
  maxConcurrency?: number;
  permissionMode?: PermissionMode;
  claudeCommand?: string;
  /** `--emit` / `--no-emit`, exactly as on `cao run` (§4.2.7). */
  emit?: boolean;
  /** `--emit-feed`; reserved, and served by nothing yet. */
  emitFeed?: boolean;
  /** `--no-alt-screen` gives `false`; undefined lets `CAO_ALT_SCREEN` and `~/.cao/config.json` decide [D4]. */
  altScreen?: boolean;
  /** `--theme <name>`; `CAO_THEME` and `NO_COLOR` are read when it is absent [D35]. */
  theme?: string;
}

export async function resumeCommand(runRef: string | undefined, opts: ResumeOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
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
    out(warnLine(`Could not reload environment from ${run.configPath}: ${(err as Error).message}`));
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
  if (!lock.ok) throw new OrchestratorError(`Run ${runId} is owned by another orchestrator process (pid ${lock.lock.pid}, heartbeat ${lock.lock.heartbeatAt})`);

  const selection = only.length || from.length ? { only: input ? [] : only, from } : undefined;
  if (run.state === 'completed' && !selection) {
    out(`Run ${runId} already completed. Use --task <id> or --from <id> to re-run specific tasks.`);
    await store.releaseLock(runId);
    return 0;
  }

  const reconciliation = await reconcileForResume(run, { retryFailed: opts.retryFailed, approve: parseList(opts.approve), reject: parseList(opts.reject), input, selection });
  for (const n of reconciliation.notes) out(warnLine(n));

  const layers = buildGraph(run.workflow).layers();
  out(renderHeader({ workflow: run.workflow, runId, runners, layers, resumed: true, verbose: opts.verbose }));
  if (reconciliation.rerun.length) out(`Re-running: ${reconciliation.rerun.join(', ')}\n`);

  return executeRun({ run, environment, secrets, verbose: opts.verbose, tui: opts.tui, activity: opts.activity, isResume: true, emit: opts.emit, emitFeed: opts.emitFeed, altScreen: opts.altScreen, theme: opts.theme });
}
