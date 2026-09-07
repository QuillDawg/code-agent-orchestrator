import path from 'node:path';
import { openStore } from '../util.js';
import { Git } from '../../workspace/git.js';
import { removeSnapshotIndexDir } from '../../workspace/diff.js';
import { pathExists, removeDir } from '../../util/fs.js';
import { OrchestratorError } from '../../util/errors.js';
import { isProcessAlive } from '../../util/misc.js';

export interface CleanOptions {
  repository?: string;
  worktrees?: boolean;
  branches?: boolean;
  all?: boolean;
}

/** Remove worktrees (and optionally branches) left behind by a run. Never touches the shared tree. */
export async function cleanCommand(runRef: string | undefined, opts: CleanOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const runId = await store.resolveRunId(runRef);
  const run = await store.loadRun(runId);
  const lock = await store.readLock(runId);
  if (lock && isProcessAlive(lock.pid)) throw new OrchestratorError(`Run ${runId} is still active (pid ${lock.pid}); stop it before cleaning`);
  const doWorktrees = opts.worktrees || opts.all || (!opts.branches && !opts.all);
  const doBranches = opts.branches || opts.all;
  const git = new Git(run.repositoryRoot);
  const gitOk = Boolean(run.workflow.gitRoot) && (await Git.isAvailable());
  let removed = 0;
  for (const st of Object.values(run.tasks)) {
    for (const a of st.attempts) {
      const ws = a.workspace;
      if (!ws || ws.kind !== 'worktree') continue;
      if (doWorktrees && (await pathExists(ws.path))) {
        if (gitOk) await git.worktreeRemove(ws.path).catch(() => undefined);
        if (await pathExists(ws.path)) await removeDir(ws.path);
        out(`removed worktree ${path.relative(run.repositoryRoot, ws.path) || ws.path}`);
        removed++;
      }
      if (doBranches && ws.branch && gitOk && (await git.branchExists(ws.branch))) {
        await git.deleteBranch(ws.branch);
        out(`deleted branch ${ws.branch}`);
        removed++;
      }
    }
  }
  if (gitOk) await git.worktreePrune();
  // A run killed hard never got to drop its diff-snapshot scratch directory.
  await removeSnapshotIndexDir(run.repositoryRoot, runId);
  out(removed ? `Cleaned ${removed} item(s) for run ${runId}.` : `Nothing to clean for run ${runId}.`);
  return 0;
}
