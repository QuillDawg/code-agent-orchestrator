import { openStore, parseList } from '../util.js';
import { reconcileForResume } from '../../workflow/run-factory.js';
import { executeRun } from './run.js';
import { renderHeader } from '../render/plain.js';
import { buildGraph } from '../../workflow/validator.js';
import { loadWorkflow } from '../../config/loader.js';
import { OrchestratorError, UsageError } from '../../util/errors.js';
import { pathExists } from '../../util/fs.js';
import { applyWorkflowOverrides, detectRunnersForWorkflow } from '../app.js';
import { warnLine } from '../../util/marks.js';
import type { PermissionMode } from '../../types/workflow.js';

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

  const lock = await store.acquireLock(runId);
  if (!lock.ok) throw new OrchestratorError(`Run ${runId} is owned by another orchestrator process (pid ${lock.lock.pid}, heartbeat ${lock.lock.heartbeatAt})`);

  const only = parseList(opts.task);
  const from = parseList(opts.from);
  const input = opts.input !== undefined ? { taskId: only[0] ?? '', text: opts.input } : undefined;
  if (input && !input.taskId) throw new UsageError('--input requires --task <id> to name the task that needs input');
  const selection = only.length || from.length ? { only: input ? [] : only, from } : undefined;
  if (run.state === 'completed' && !selection) {
    out(`Run ${runId} already completed. Use --task <id> or --from <id> to re-run specific tasks.`);
    await store.releaseLock(runId);
    return 0;
  }

  const reconciliation = await reconcileForResume(run, { retryFailed: opts.retryFailed, approve: parseList(opts.approve), reject: parseList(opts.reject), input, selection });
  for (const n of reconciliation.notes) out(warnLine(n));

  // Environment values are never persisted: reload them from the workflow file when it still exists.
  let environment: Record<string, string> = {};
  let secrets: string[] = [];
  try {
    const loaded = await loadWorkflow(run.configPath, { launchDirectory: run.launchDirectory, repository: run.repositoryRoot });
    environment = loaded.environment;
    secrets = loaded.secrets;
  } catch (err) {
    out(warnLine(`Could not reload environment from ${run.configPath}: ${(err as Error).message}`));
  }

  const runners = await detectRunnersForWorkflow(run.workflow);
  const missing = runners.find((runner) => !runner.found);
  if (missing) throw new OrchestratorError(`${missing.runner} CLI not found (${missing.command}): ${missing.error ?? ''}`);
  const layers = buildGraph(run.workflow).layers();
  out(renderHeader({ workflow: run.workflow, runId, runners, layers, resumed: true, verbose: opts.verbose }));
  if (reconciliation.rerun.length) out(`Re-running: ${reconciliation.rerun.join(', ')}\n`);

  return executeRun({ run, environment, secrets, verbose: opts.verbose, tui: opts.tui, activity: opts.activity, isResume: true });
}
