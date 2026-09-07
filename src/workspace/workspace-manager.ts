/**
 * Workspace strategies: `shared` (the repository working tree) and `worktree` (an isolated git
 * worktree + branch per task, merged back on success). Parallel workers never share a mutable tree.
 */
import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';
import type { ResolvedTask, ResolvedWorkflow, WorkspaceMode } from '../types/workflow.js';
import type { WorkflowRun, WorkspaceInfo, AttemptOutcome } from '../types/run.js';
import type { GitInfo } from '../types/result.js';
import { Git } from './git.js';
import { captureDiff, removeSnapshotIndexDir, snapshotIndexPath, snapshotTree, type CapturedDiff } from './diff.js';
import { KeyedMutex } from '../util/async-queue.js';
import { ensureDir, isInside, pathExists, removeDir } from '../util/fs.js';
import { shortRunId } from '../persistence/run-id.js';
import type { Logger } from '../logging/logger.js';
import { silentLogger } from '../logging/logger.js';

export interface RunPreparation {
  baseBranch?: string;
  baseCommit?: string;
  warnings: string[];
}

export interface MergeOutcome {
  status: 'merged' | 'conflict' | 'skipped' | 'nothing';
  branch?: string;
  into?: string;
  sha?: string;
  conflicts?: string[];
  output?: string;
  /** Shared-tree HEAD when the merge was attempted; the diff base of a merge-resolution attempt. */
  intoSha?: string;
}

export interface FinalizeResult {
  workspace: WorkspaceInfo;
  git?: GitInfo;
  merge?: MergeOutcome;
  warnings: string[];
  /** The attempt's own changes, written to the attempt directory as `diff.patch` / `diff.json`. */
  diff?: CapturedDiff;
}

export interface AcquireOptions {
  /** Keep the previous attempt's working tree untouched (ignore retry.resetWorkspace); used when resuming a session. */
  preserve?: boolean;
}

export interface WorkspaceManager {
  prepareRun(run: WorkflowRun): Promise<RunPreparation>;
  acquire(task: ResolvedTask, attempt: number, mode: WorkspaceMode, run: WorkflowRun, previous?: WorkspaceInfo, opts?: AcquireOptions): Promise<WorkspaceInfo>;
  /** Called after an attempt ends: captures git info and (for worktrees) merges back on success. */
  finalize(task: ResolvedTask, info: WorkspaceInfo, outcome: AttemptOutcome, run: WorkflowRun): Promise<FinalizeResult>;
  /** After a Claude merge-resolution attempt succeeded, verify and finish the merge bookkeeping. */
  completeMerge(task: ResolvedTask, info: WorkspaceInfo, run: WorkflowRun): Promise<FinalizeResult>;
  /** Diff-only counterpart of `completeMerge` for a merge-resolution attempt that did not succeed. */
  captureMergeAttempt(task: ResolvedTask, info: WorkspaceInfo, run: WorkflowRun): Promise<FinalizeResult>;
  cleanupWorktree(info: WorkspaceInfo): Promise<void>;
  cleanupRun(run: WorkflowRun): Promise<void>;
  /** Serialises access to the shared working tree. */
  lockShared(): Promise<() => void>;
  readonly sharedRoot: string;
}

export class GitWorkspaceManager implements WorkspaceManager {
  readonly sharedRoot: string;
  private readonly git: Git;
  private readonly mutex = new KeyedMutex();
  private readonly logger: Logger;

  constructor(
    private readonly workflow: ResolvedWorkflow,
    logger: Logger = silentLogger,
  ) {
    this.sharedRoot = workflow.repositoryRoot;
    this.git = new Git(workflow.repositoryRoot);
    this.logger = logger;
  }

  lockShared(): Promise<() => void> {
    return this.mutex.acquire('shared');
  }

  private get gitEnabled(): boolean {
    return this.workflow.git.enabled && Boolean(this.workflow.gitRoot);
  }

  private worktreeRoot(): string {
    return path.resolve(this.workflow.repositoryRoot, this.workflow.execution.worktree.directory);
  }

  async prepareRun(run: WorkflowRun): Promise<RunPreparation> {
    const warnings: string[] = [];
    if (!this.gitEnabled) return { warnings };
    if (!(await this.git.hasCommits())) {
      warnings.push('Repository has no commits yet; worktree isolation and git capture are unavailable until the first commit');
      return { warnings };
    }
    const baseBranch = await this.git.currentBranch();
    const baseCommit = await this.git.headSha();
    try {
      if (await this.git.ensureExcluded('.orchestrator/')) {
        warnings.push('Added ".orchestrator/" to .git/info/exclude (consider adding it to .gitignore)');
      }
    } catch (err) {
      warnings.push(`Could not update .git/info/exclude: ${(err as Error).message}`);
    }
    const dirty = await this.git.isDirty();
    if (dirty) {
      if (this.workflow.git.requireCleanWorkingTree) {
        throw new Error('git.requireCleanWorkingTree is set but the working tree has uncommitted changes');
      }
      warnings.push('Working tree has uncommitted changes; they will not be visible inside worktrees');
    }
    await this.git.worktreePrune();
    void run;
    return { baseBranch, baseCommit, warnings };
  }

  async acquire(task: ResolvedTask, attempt: number, mode: WorkspaceMode, run: WorkflowRun, previous?: WorkspaceInfo, opts: AcquireOptions = {}): Promise<WorkspaceInfo> {
    if (mode === 'shared' || !this.gitEnabled) {
      const baseSha = this.gitEnabled ? await this.git.headSha() : undefined;
      const info: WorkspaceInfo = { kind: 'shared', path: this.workflow.repositoryRoot, cwd: task.workingDirectory, baseSha };
      // The agent does not commit in the shared tree, so the base commit says nothing about what it changed:
      // snapshot the tree now and again at finalize, and diff the two snapshots.
      info.treeBefore = await this.snapshot(run.runId, this.workflow.repositoryRoot, `${task.id}-${attempt}-before`);
      return info;
    }
    const root = this.worktreeRoot();
    await ensureDir(root);
    const wtPath = path.join(root, task.id);
    const cwd = task.workingDirectoryRelative ? path.join(wtPath, task.workingDirectoryRelative) : wtPath;
    const prefix = this.workflow.execution.worktree.branchPrefix;
    const baseSha =
      this.workflow.execution.worktree.base === 'runStart' && run.baseCommit ? run.baseCommit : ((await this.git.headSha()) ?? run.baseCommit);
    if (!baseSha) throw new Error('Cannot create a worktree: repository has no commits');

    // Reuse a healthy worktree from a previous attempt (retry/resume).
    if (previous?.kind === 'worktree' && previous.branch) {
      const registered = await this.findRegisteredWorktree(previous.path);
      if (registered && (await pathExists(previous.path))) {
        if (task.retry.resetWorkspace && !opts.preserve && previous.baseSha) {
          await this.git.run(['reset', '--hard', previous.baseSha], { cwd: previous.path });
          await this.git.run(['clean', '-fd'], { cwd: previous.path, reject: false });
        }
        this.logger.debug(`reusing worktree ${previous.path} for ${task.id} attempt ${attempt}`);
        return { ...previous, cwd, headSha: undefined, dirtyAtEnd: undefined, cleanedUp: false };
      }
      await this.discardWorktreeDir(previous.path);
      if (await this.git.branchExists(previous.branch)) {
        await this.git.worktreeAdd(wtPath, { commitish: previous.branch });
        await this.copyIgnored(wtPath);
        return { kind: 'worktree', path: wtPath, cwd, branch: previous.branch, baseSha: previous.baseSha ?? baseSha };
      }
    }

    // Stale directory from an older run.
    if (await pathExists(wtPath)) await this.discardWorktreeDir(wtPath);

    let branch = `${prefix}${task.id}`;
    if (await this.git.branchExists(branch)) {
      const policy = this.workflow.execution.worktree.branchConflict;
      if (policy === 'fail') throw new Error(`Branch "${branch}" already exists (worktree.branchConflict: fail)`);
      if (policy === 'suffix') {
        branch = `${branch}-${shortRunId(run.runId)}`;
        let n = 2;
        while (await this.git.branchExists(branch)) branch = `${prefix}${task.id}-${shortRunId(run.runId)}-${n++}`;
      }
    }
    if (await this.git.branchExists(branch)) {
      await this.git.worktreeAdd(wtPath, { commitish: branch });
    } else {
      await this.git.worktreeAdd(wtPath, { newBranch: branch, commitish: baseSha });
    }
    await this.copyIgnored(wtPath);
    if (wtPath.length > 200) this.logger.warn(`worktree path is long (${wtPath.length} chars); consider execution.worktree.directory`);
    return { kind: 'worktree', path: wtPath, cwd, branch, baseSha };
  }

  /** Find the registered worktree entry for a directory, comparing canonical paths (Windows 8.3 names, symlinks). */
  private async findRegisteredWorktree(dir: string): Promise<{ path: string; branch?: string } | undefined> {
    const target = await canonical(dir);
    for (const w of await this.git.worktreeList()) {
      if ((await canonical(w.path)) === target) return w;
    }
    return undefined;
  }

  /** Remove a worktree directory (registered or orphaned) and prune git's bookkeeping. */
  private async discardWorktreeDir(dir: string): Promise<void> {
    if (await pathExists(dir)) {
      if (await this.findRegisteredWorktree(dir)) await this.git.worktreeRemove(dir).catch(() => undefined);
      if (await pathExists(dir)) await removeDir(dir);
    }
    await this.git.worktreePrune();
  }

  private async copyIgnored(wtPath: string): Promise<void> {
    for (const rel of this.workflow.execution.worktree.copyIgnored) {
      const src = path.resolve(this.workflow.repositoryRoot, rel);
      const dest = path.resolve(wtPath, rel);
      if (!isInside(this.workflow.repositoryRoot, src) || !isInside(wtPath, dest)) continue;
      if (!(await pathExists(src))) continue;
      await ensureDir(path.dirname(dest));
      await fs.cp(src, dest, { recursive: true, force: true }).catch((err) => this.logger.warn(`copyIgnored ${rel}: ${(err as Error).message}`));
    }
  }

  async finalize(task: ResolvedTask, info: WorkspaceInfo, outcome: AttemptOutcome, run: WorkflowRun): Promise<FinalizeResult> {
    const warnings: string[] = [];
    const workspace: WorkspaceInfo = { ...info };
    if (!this.gitEnabled) return { workspace, warnings };
    const capture = this.workflow.git.captureDiff;
    let git: GitInfo | undefined;
    const exists = await pathExists(info.path);
    if (exists) {
      git = await this.git.captureInfo(info.baseSha, info.path, { diffStat: capture }).catch(() => undefined);
      workspace.headSha = git?.headSha;
      workspace.dirtyAtEnd = (git?.uncommittedFiles.length ?? 0) > 0;
    }

    if (info.kind !== 'worktree') {
      // Shared tree: the attempt's changes are whatever moved between the two working-tree snapshots.
      workspace.treeAfter = exists ? await this.snapshot(run.runId, this.workflow.repositoryRoot, `${task.id}-after`) : undefined;
      const diff = await this.captureAttemptDiff(workspace.treeBefore, workspace.treeAfter, this.workflow.repositoryRoot);
      return { workspace, git: attachDiff(git, diff), warnings, diff };
    }

    if (outcome !== 'success') {
      // No checkpoint commit on this path, so diff against a snapshot of whatever the worker left behind.
      const diff = exists ? await this.captureWorktreeDiff(run.runId, task, workspace) : undefined;
      if (this.workflow.execution.worktree.cleanup === 'always') await this.safeCleanup(workspace, warnings);
      return { workspace, git: attachDiff(git, diff), warnings, diff };
    }

    // Success: checkpoint uncommitted work, then merge back.
    if (workspace.dirtyAtEnd) {
      if (this.workflow.execution.worktree.autoCommit) {
        const sha = await this.git.commitAll(`chore(orchestrator): checkpoint ${task.id}`, info.path);
        if (sha) {
          workspace.headSha = sha;
          workspace.dirtyAtEnd = false;
          git = await this.git.captureInfo(info.baseSha, info.path, { diffStat: capture }).catch(() => git);
          warnings.push(`Uncommitted changes in worktree for "${task.id}" were checkpoint-committed as ${sha.slice(0, 10)}`);
        }
      } else {
        warnings.push(`Worktree for "${task.id}" has uncommitted changes; they were not merged (worktree.autoCommit is false)`);
      }
    }
    // Capture before the merge-back, which may remove the worktree this diff is read from.
    const diff = exists ? await this.captureWorktreeDiff(run.runId, task, workspace) : undefined;

    let merge: MergeOutcome = { status: 'skipped' };
    if (this.workflow.execution.worktree.mergeBack && workspace.branch) {
      merge = await this.mergeBack(task, workspace, run);
      if (merge.status === 'merged') workspace.mergedSha = merge.sha;
    }
    if (merge.status !== 'conflict' && this.workflow.execution.worktree.cleanup !== 'never') {
      await this.safeCleanup(workspace, warnings);
    }
    return { workspace, git: attachDiff(git, diff), merge, warnings, diff };
  }

  /** A worktree attempt's own work: its base commit against the branch head, plus any uncommitted remainder. */
  private async captureWorktreeDiff(runId: string, task: ResolvedTask, workspace: WorkspaceInfo): Promise<CapturedDiff | undefined> {
    if (!this.workflow.git.captureDiff || !workspace.baseSha) return undefined;
    const head = workspace.dirtyAtEnd
      ? await this.snapshot(runId, workspace.path, `${task.id}-worktree`)
      : (workspace.headSha ?? (await this.git.headSha(workspace.path)));
    return this.captureAttemptDiff(workspace.baseSha, head, workspace.path);
  }

  private async captureAttemptDiff(base: string | undefined, head: string | undefined, cwd: string): Promise<CapturedDiff | undefined> {
    if (!this.workflow.git.captureDiff || !base || !head) return undefined;
    try {
      return await captureDiff(this.git, base, head, { cwd, maxBytes: this.workflow.git.maxDiffBytes });
    } catch (err) {
      this.logger.warn(`diff capture failed in ${cwd}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Write the working tree under `cwd` to a git tree object without touching the real index. */
  private async snapshot(runId: string, cwd: string, label: string): Promise<string | undefined> {
    if (!this.workflow.git.captureDiff) return undefined;
    try {
      return await snapshotTree(this.git, cwd, snapshotIndexPath(this.workflow.repositoryRoot, runId, label));
    } catch (err) {
      this.logger.warn(`tree snapshot for ${label} failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async mergeBack(task: ResolvedTask, workspace: WorkspaceInfo, run: WorkflowRun): Promise<MergeOutcome> {
    const branch = workspace.branch!;
    const into = run.baseBranch ?? 'HEAD';
    const release = await this.lockShared();
    try {
      const head = await this.git.headSha();
      const branchSha = await this.git.run(['rev-parse', branch]).then((r) => r.stdout);
      if (head === branchSha || workspace.headSha === workspace.baseSha) {
        return { status: 'nothing', branch, into };
      }
      const alreadyMerged = (await this.git.run(['merge-base', '--is-ancestor', branch, 'HEAD'], { reject: false })).exitCode === 0;
      if (alreadyMerged) return { status: 'nothing', branch, into, sha: head };
      // A merge into a dirty shared tree could clobber uncommitted work; stash-free approach: refuse and report.
      // The orchestrator's own edit of the workflow file (completion markers) is expected and never in the way.
      const configRel = path.relative(this.workflow.repositoryRoot, this.workflow.configPath).replace(/\\/g, '/');
      const dirty = (await this.git.statusPorcelain())
        .map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
        .filter((f) => f !== configRel);
      if (dirty.length > 0) {
        return {
          status: 'conflict',
          branch,
          into,
          intoSha: head,
          conflicts: [],
          output: `shared working tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}); merge-back refused to avoid clobbering them`,
        };
      }
      this.logger.info(`merging ${branch} into ${into}`);
      const res = await this.git.merge(branch, `Merge ${branch} (orchestrator task ${task.id})`);
      if (res.ok) return { status: 'merged', branch, into, sha: await this.git.headSha() };
      await this.git.mergeAbort();
      return { status: 'conflict', branch, into, intoSha: head, conflicts: res.conflicts, output: res.output };
    } finally {
      release();
    }
  }

  async completeMerge(task: ResolvedTask, info: WorkspaceInfo, run: WorkflowRun): Promise<FinalizeResult> {
    const warnings: string[] = [];
    const workspace: WorkspaceInfo = { ...info };
    const branch = info.branch!;
    const into = run.baseBranch ?? 'HEAD';
    let merge: MergeOutcome;
    let diff: CapturedDiff | undefined;
    const release = await this.lockShared();
    try {
      if (await this.git.mergeInProgress()) {
        warnings.push('merge left in progress by the conflict-resolution session; aborting it');
        await this.git.mergeAbort();
        merge = { status: 'conflict', branch, into, intoSha: info.mergeBaseSha, output: 'merge was not completed' };
      } else if ((await this.git.run(['merge-base', '--is-ancestor', branch, 'HEAD'], { reject: false })).exitCode !== 0) {
        merge = { status: 'conflict', branch, into, intoSha: info.mergeBaseSha, output: `branch ${branch} is not merged into HEAD` };
      } else {
        workspace.mergedSha = await this.git.headSha();
        merge = { status: 'merged', branch, into, intoSha: info.mergeBaseSha, sha: workspace.mergedSha };
      }
      // The resolution session works in the shared tree, so its own patch runs from the pre-merge HEAD.
      diff = await this.captureMergeDiff(run.runId, task, info);
    } finally {
      release();
    }
    if (merge.status === 'merged' && this.workflow.execution.worktree.cleanup !== 'never') await this.safeCleanup(workspace, warnings);
    return { workspace, warnings, merge, diff };
  }

  /**
   * A failed resolution session still moved the shared tree — usually into a half-resolved merge — and that
   * is exactly what someone reading the attempt wants to see. The merge bookkeeping stays in `completeMerge`;
   * here nothing is decided, only recorded.
   */
  async captureMergeAttempt(task: ResolvedTask, info: WorkspaceInfo, run: WorkflowRun): Promise<FinalizeResult> {
    const release = await this.lockShared();
    try {
      return { workspace: { ...info }, warnings: [], diff: await this.captureMergeDiff(run.runId, task, info) };
    } finally {
      release();
    }
  }

  /** A merge-resolution attempt's own patch: pre-merge shared HEAD against where the session left the tree. */
  private async captureMergeDiff(runId: string, task: ResolvedTask, info: WorkspaceInfo): Promise<CapturedDiff | undefined> {
    if (!this.workflow.git.captureDiff || !info.mergeBaseSha) return undefined;
    const root = this.workflow.repositoryRoot;
    const head = (await this.git.isDirty(root).catch(() => false))
      ? await this.snapshot(runId, root, `${task.id}-merge`)
      : await this.git.headSha(root);
    return this.captureAttemptDiff(info.mergeBaseSha, head, root);
  }

  private async safeCleanup(workspace: WorkspaceInfo, warnings: string[]): Promise<void> {
    try {
      await this.cleanupWorktree(workspace);
      workspace.cleanedUp = true;
    } catch (err) {
      warnings.push(`Could not remove worktree ${workspace.path}: ${(err as Error).message}`);
    }
  }

  async cleanupWorktree(info: WorkspaceInfo): Promise<void> {
    if (info.kind !== 'worktree') return;
    if (await pathExists(info.path)) {
      try {
        await this.git.worktreeRemove(info.path);
      } catch {
        await removeDir(info.path);
      }
    }
    await this.git.worktreePrune();
  }

  async cleanupRun(run: WorkflowRun): Promise<void> {
    // Snapshot index files are deleted as each snapshot finishes; the directory survives a hard kill, so
    // drop it here too — this also runs when the run was interrupted.
    await removeSnapshotIndexDir(this.workflow.repositoryRoot, run.runId);
    if (!this.gitEnabled) return;
    await this.git.worktreePrune();
  }
}

/** Fold the per-file stat into the result's git block so downstream context and `cao task` can read it. */
function attachDiff(git: GitInfo | undefined, diff: CapturedDiff | undefined): GitInfo | undefined {
  if (!git || !diff) return git;
  return { ...git, files: diff.files, ...(diff.truncated ? { diffTruncated: true } : {}) };
}

async function canonical(p: string): Promise<string> {
  let resolved = path.resolve(p).replace(/[\\/]+$/, '');
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    /* keep resolved */
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Workspace manager for repositories without git (or git disabled): everything is shared. */
export class SharedOnlyWorkspaceManager implements WorkspaceManager {
  readonly sharedRoot: string;
  private readonly mutex = new KeyedMutex();
  constructor(private readonly workflow: ResolvedWorkflow) {
    this.sharedRoot = workflow.repositoryRoot;
  }
  lockShared(): Promise<() => void> {
    return this.mutex.acquire('shared');
  }
  async prepareRun(): Promise<RunPreparation> {
    return { warnings: this.workflow.git.enabled ? ['Repository is not a git repository; git capture and worktrees are disabled'] : [] };
  }
  async acquire(task: ResolvedTask): Promise<WorkspaceInfo> {
    return { kind: 'shared', path: this.workflow.repositoryRoot, cwd: task.workingDirectory };
  }
  async finalize(_task: ResolvedTask, info: WorkspaceInfo): Promise<FinalizeResult> {
    return { workspace: info, warnings: [] };
  }
  async completeMerge(_task: ResolvedTask, info: WorkspaceInfo): Promise<FinalizeResult> {
    return { workspace: info, warnings: [] };
  }
  async captureMergeAttempt(_task: ResolvedTask, info: WorkspaceInfo): Promise<FinalizeResult> {
    return { workspace: info, warnings: [] };
  }
  async cleanupWorktree(): Promise<void> {
    /* nothing */
  }
  async cleanupRun(): Promise<void> {
    /* nothing */
  }
}
