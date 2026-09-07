import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { GitWorkspaceManager } from '../../src/workspace/workspace-manager.js';
import { Git } from '../../src/workspace/git.js';
import { buildWorkflow, makeRun, tmpGitRepo, gitOut, gitExit, extractTree, gitAvailable } from '../helpers/index.js';
import { pathExists } from '../../src/util/fs.js';
import { snapshotIndexDir } from '../../src/workspace/diff.js';
import { patchForFile } from '../../src/cli/render/diff.js';

const YAML = (executionExtra = '', topLevelExtra = '') => `
name: t
execution:
  maxConcurrency: 2
${executionExtra}
${topLevelExtra}
tasks:
  - id: a
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
  - id: c
    parallelGroup: g
    prompt: p
`;

async function setup(executionExtra = '', topLevelExtra = '') {
  const repo = await tmpGitRepo();
  const { workflow, validation } = await buildWorkflow(YAML(executionExtra, topLevelExtra), { repositoryRoot: repo, gitRoot: repo });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join());
  const run = makeRun(workflow);
  const manager = new GitWorkspaceManager(workflow);
  const prep = await manager.prepareRun(run);
  run.baseBranch = prep.baseBranch;
  run.baseCommit = prep.baseCommit;
  return { repo, workflow, run, manager, git: new Git(repo) };
}

async function commitFile(dir: string, name: string, content: string): Promise<string> {
  await fs.writeFile(path.join(dir, name), content);
  await gitOut(dir, 'add', '-A');
  await gitOut(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `add ${name}`);
  return gitOut(dir, 'rev-parse', 'HEAD');
}

const HAS_GIT = await gitAvailable('GitWorkspaceManager suite');

describe.skipIf(!HAS_GIT)('GitWorkspaceManager', () => {
  it('prepares the run: base commit, .git/info/exclude', async () => {
    const { repo, run } = await setup();
    expect(run.baseBranch).toBe('main');
    expect(run.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    const exclude = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.orchestrator/');
    await fs.mkdir(path.join(repo, '.orchestrator', 'runs'), { recursive: true });
    await fs.writeFile(path.join(repo, '.orchestrator', 'runs', 'x.json'), '{}');
    expect(await gitOut(repo, 'status', '--porcelain')).toBe('');
  });

  it('creates isolated worktrees from the run-start commit and merges them back', async () => {
    const { repo, workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const taskC = workflow.tasks.find((t) => t.id === 'c')!;
    // a sequential commit in the shared tree after run start
    await commitFile(repo, 'a.txt', 'a');

    const wsB = await manager.acquire(taskB, 1, 'worktree', run);
    const wsC = await manager.acquire(taskC, 1, 'worktree', run);
    expect(wsB.path).toBe(path.join(repo, '.orchestrator', 'worktrees', 'b'));
    expect(wsB.branch).toBe('orchestrator/b');
    expect(wsB.baseSha).toBe(run.baseCommit); // runStart policy
    expect(await pathExists(path.join(wsB.path, 'a.txt'))).toBe(false); // not based on the later commit
    expect(await gitOut(wsB.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('orchestrator/b');

    await commitFile(wsB.path, 'b.txt', 'b');
    await commitFile(wsC.path, 'c.txt', 'c');
    const finB = await manager.finalize(taskB, wsB, 'success', run);
    expect(finB.merge?.status).toBe('merged');
    expect(finB.git?.headSha).toBeDefined();
    const finC = await manager.finalize(taskC, wsC, 'success', run);
    expect(finC.merge?.status).toBe('merged');
    expect(await pathExists(path.join(repo, 'b.txt'))).toBe(true);
    expect(await pathExists(path.join(repo, 'c.txt'))).toBe(true);
    expect(await pathExists(path.join(repo, 'a.txt'))).toBe(true);
    // cleanup onSuccess removed the worktree dirs but kept branches
    expect(await pathExists(wsB.path)).toBe(false);
    expect(await gitOut(repo, 'branch', '--list', 'orchestrator/b')).toContain('orchestrator/b');
    expect(await gitOut(repo, 'status', '--porcelain')).toBe('');
  });

  it('checkpoint-commits uncommitted worktree changes before merging', async () => {
    const { repo, workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await fs.writeFile(path.join(ws.path, 'dirty.txt'), 'x');
    const fin = await manager.finalize(taskB, ws, 'success', run);
    expect(fin.warnings.some((w) => w.includes('checkpoint-committed'))).toBe(true);
    expect(fin.merge?.status).toBe('merged');
    expect(await pathExists(path.join(repo, 'dirty.txt'))).toBe(true);
  });

  it('reports merge conflicts and leaves the shared tree clean', async () => {
    const { repo, workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await commitFile(repo, 'shared.txt', 'from main');
    await commitFile(ws.path, 'shared.txt', 'from b');
    const fin = await manager.finalize(taskB, ws, 'success', run);
    expect(fin.merge?.status).toBe('conflict');
    expect(fin.merge?.conflicts).toEqual(['shared.txt']);
    expect(await gitOut(repo, 'status', '--porcelain')).toBe('');
    expect(await new Git(repo).mergeInProgress()).toBe(false);
    // worktree kept for inspection/resolution
    expect(await pathExists(ws.path)).toBe(true);

    // simulate a resolution session merging manually, then completeMerge verifies it
    await gitOut(repo, 'merge', '--no-ff', '--no-commit', 'orchestrator/b');
    await gitOut(repo, 'checkout', '--theirs', 'shared.txt');
    await gitOut(repo, 'add', '-A');
    await gitOut(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'resolved');
    const done = await manager.completeMerge(taskB, fin.workspace, run);
    expect(done.merge?.status).toBe('merged');
    expect(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8')).toBe('from b');
  });

  it('suffixes branch names that already exist and reuses worktrees on retry', async () => {
    const { repo, workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    await gitOut(repo, 'branch', 'orchestrator/b');
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    expect(ws.branch).toMatch(/^orchestrator\/b-/);
    await fs.writeFile(path.join(ws.path, 'partial.txt'), 'wip');
    const fin = await manager.finalize(taskB, ws, 'failed', run);
    expect(await pathExists(ws.path)).toBe(true); // kept after failure
    const again = await manager.acquire(taskB, 2, 'worktree', run, fin.workspace);
    expect(again.path).toBe(ws.path);
    expect(again.branch).toBe(ws.branch);
    expect(await pathExists(path.join(again.path, 'partial.txt'))).toBe(true);
  });

  it('recreates a worktree whose directory was deleted', async () => {
    const { workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await commitFile(ws.path, 'b.txt', 'b');
    await fs.rm(ws.path, { recursive: true, force: true });
    const again = await manager.acquire(taskB, 2, 'worktree', run, ws);
    expect(again.branch).toBe('orchestrator/b');
    expect(await pathExists(path.join(again.path, 'b.txt'))).toBe(true);
  });

  it('headAtStart policy bases worktrees on the current HEAD', async () => {
    const { repo, workflow, run, manager } = await setup('  worktree:\n    base: headAtStart\n');
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const sha = await commitFile(repo, 'later.txt', 'x');
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    expect(ws.baseSha).toBe(sha);
    expect(await pathExists(path.join(ws.path, 'later.txt'))).toBe(true);
  });

  it('captures a worktree attempt diff of committed and checkpointed work', async () => {
    const { repo, workflow, run, manager } = await setup('  worktree:\n    base: headAtStart\n');
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    await commitFile(repo, 'keep.txt', 'a\nb\nc\n');
    await commitFile(repo, 'gone.txt', 'x\n');
    await commitFile(repo, 'moved.txt', 'one\ntwo\nthree\nfour\n');

    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await fs.writeFile(path.join(ws.path, 'keep.txt'), 'a\nB\nc\nd\n');
    await fs.rm(path.join(ws.path, 'gone.txt'));
    await fs.rename(path.join(ws.path, 'moved.txt'), path.join(ws.path, 'renamed.txt'));
    await fs.writeFile(path.join(ws.path, 'new.txt'), 'new\n');
    await fs.writeFile(path.join(ws.path, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 0]));
    const fin = await manager.finalize(taskB, ws, 'success', run);

    const diff = fin.diff!;
    expect(diff.truncated).toBe(false);
    expect(diff.base).toBe(ws.baseSha);
    expect(diff.head).toBe(fin.workspace.headSha);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['blob.bin', 'gone.txt', 'keep.txt', 'new.txt', 'renamed.txt']);
    expect(byPath['blob.bin']).toEqual({ path: 'blob.bin', status: 'A', additions: 0, deletions: 0, binary: true });
    expect(byPath['gone.txt']).toEqual({ path: 'gone.txt', status: 'D', additions: 0, deletions: 1, binary: false });
    expect(byPath['keep.txt']).toEqual({ path: 'keep.txt', status: 'M', additions: 2, deletions: 1, binary: false });
    expect(byPath['new.txt']).toEqual({ path: 'new.txt', status: 'A', additions: 1, deletions: 0, binary: false });
    expect(byPath['renamed.txt']).toMatchObject({ status: 'R', oldPath: 'moved.txt', binary: false });
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(2);
    expect(diff.patch).toContain('diff --git a/keep.txt b/keep.txt');
    expect(diff.patch).toContain('\n+d\n');
    expect(diff.patch).toContain('rename from moved.txt');
    // the same records ride along in the result's git block
    expect(fin.git?.files).toEqual(diff.files);
    expect(fin.git?.diffTruncated).toBeUndefined();
  });

  it('captures the uncommitted work of a failed worktree attempt', async () => {
    const { workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await fs.writeFile(path.join(ws.path, 'partial.txt'), 'wip\n');
    const fin = await manager.finalize(taskB, ws, 'failed', run);
    expect(fin.workspace.dirtyAtEnd).toBe(true);
    expect(fin.diff?.files).toEqual([{ path: 'partial.txt', status: 'A', additions: 1, deletions: 0, binary: false }]);
    expect(fin.diff?.patch).toContain('+wip');
  });

  it('captures a shared-tree diff from working-tree snapshots without touching the index', async () => {
    const { repo, workflow, run, manager } = await setup();
    const taskA = workflow.tasks.find((t) => t.id === 'a')!;
    await commitFile(repo, 'gone.txt', 'x\n');

    const ws = await manager.acquire(taskA, 1, 'shared', run);
    expect(ws.treeBefore).toMatch(/^[0-9a-f]{40}$/);
    // Changes a worker made through the shell: never committed, never seen by the tool stream.
    await fs.writeFile(path.join(repo, 'shell-made.txt'), 'created by bash\n');
    await fs.rm(path.join(repo, 'gone.txt'));
    await fs.appendFile(path.join(repo, 'README.md'), 'more\n');
    const fin = await manager.finalize(taskA, ws, 'success', run);

    expect(fin.workspace.treeAfter).toMatch(/^[0-9a-f]{40}$/);
    expect(fin.workspace.treeAfter).not.toBe(ws.treeBefore);
    expect(fin.diff?.files).toEqual([
      { path: 'README.md', status: 'M', additions: 1, deletions: 0, binary: false },
      { path: 'gone.txt', status: 'D', additions: 0, deletions: 1, binary: false },
      { path: 'shell-made.txt', status: 'A', additions: 1, deletions: 0, binary: false },
    ]);
    expect(fin.diff?.patch).toContain('+created by bash');
    // Snapshots go through a throwaway index: nothing is staged, the working tree is as the worker left it,
    // and no temp index survives.
    expect(await gitOut(repo, 'diff', '--cached', '--name-only')).toBe('');
    const status = (await gitOut(repo, 'status', '--porcelain', '--untracked-files=all')).split(/\r?\n/).map((l) => l.trim());
    expect(status.sort()).toEqual(['?? shell-made.txt', 'D gone.txt', 'M README.md']);
    expect(await fs.readdir(snapshotIndexDir(repo, run.runId))).toEqual([]);
    // ... and the per-run scratch directory itself goes when the run ends, however it ended.
    await manager.cleanupRun(run);
    expect(await pathExists(snapshotIndexDir(repo, run.runId))).toBe(false);
    expect(await pathExists(path.join(repo, '.orchestrator', 'tmp'))).toBe(false);
  });

  it('produces patches that git apply accepts for renames, spaces, binaries, CRLF and delete-then-recreate', async () => {
    const { repo, workflow, run, manager } = await setup();
    await commitFile(repo, 'moved.txt', 'one\ntwo\n');
    await commitFile(repo, 'recreated.txt', 'before\n');
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
    await gitOut(repo, 'add', '-A');
    await gitOut(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'binary');

    // The shared tree is already dirty before the task starts: none of this may end up in the task's patch.
    await fs.appendFile(path.join(repo, 'README.md'), 'edited by the human\n');
    await fs.writeFile(path.join(repo, 'untracked-before.txt'), 'not the task\n');

    const taskA = workflow.tasks.find((t) => t.id === 'a')!;
    const ws = await manager.acquire(taskA, 1, 'shared', run);
    await fs.mkdir(path.join(repo, 'renamed dir'));
    await fs.rename(path.join(repo, 'moved.txt'), path.join(repo, 'renamed dir', 'renamed file.txt'));
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([9, 8, 7, 0, 6]));
    await fs.rm(path.join(repo, 'recreated.txt'));
    await fs.writeFile(path.join(repo, 'recreated.txt'), 'after\n');
    await fs.writeFile(path.join(repo, 'crlf.txt'), 'one\r\ntwo\r\n');
    const fin = await manager.finalize(taskA, ws, 'success', run);

    const diff = fin.diff!;
    expect(diff.files.map((f) => f.path).sort()).toEqual(['blob.bin', 'crlf.txt', 'recreated.txt', 'renamed dir/renamed file.txt']);
    expect(diff.files.find((f) => f.path === 'blob.bin')).toEqual({ path: 'blob.bin', status: 'M', additions: 0, deletions: 0, binary: true });
    expect(diff.files.find((f) => f.path === 'renamed dir/renamed file.txt')).toMatchObject({ status: 'R', oldPath: 'moved.txt' });
    // CRLF survives the round trip, and the patch keeps the final newline git wrote.
    expect(diff.patch).toContain('+one\r\n+two\r\n');
    expect(diff.patch.endsWith('\n')).toBe(true);

    // The patch reconstructs the task's work exactly on a checkout of its base, including the binary file.
    const base = await extractTree(repo, diff.base!);
    const patchFile = path.join(base, 'attempt.patch');
    await fs.writeFile(patchFile, diff.patch);
    expect(await gitExit(base, 'apply', '--check', patchFile)).toBe(0);
    expect(await gitExit(base, 'apply', patchFile)).toBe(0);
    expect(await fs.readFile(path.join(base, 'renamed dir', 'renamed file.txt'), 'utf8')).toBe('one\ntwo\n');
    expect([...(await fs.readFile(path.join(base, 'blob.bin')))]).toEqual([9, 8, 7, 0, 6]);
    expect(await fs.readFile(path.join(base, 'recreated.txt'), 'utf8')).toBe('after\n');
    expect(await pathExists(path.join(base, 'moved.txt'))).toBe(false);
    // The base already carries the human's edits, and the patch never touches them.
    expect(await fs.readFile(path.join(base, 'README.md'), 'utf8')).toContain('edited by the human');
    expect(diff.patch).not.toContain('README.md');
    expect(diff.patch).not.toContain('untracked-before.txt');
    // Every record has to be findable in the patch, or `cao diff --file` and the review view show nothing.
    for (const f of diff.files) expect(patchForFile(diff.patch, f.path), f.path).not.toBe('');
  });

  it('lets --file find a section whose path git had to quote or disambiguate', async () => {
    const { repo, workflow, run, manager } = await setup();
    // Three paths git writes differently from the records in diff.json: a space makes git append a
    // disambiguating tab to the `---`/`+++` lines, and a non-ASCII byte makes it C-quote the whole path.
    await commitFile(repo, 'spaced name.txt', 'one\n');
    await commitFile(repo, 'café.txt', 'one\n');
    await fs.writeFile(path.join(repo, 'café.bin'), Buffer.from([0, 1, 2, 3, 0]));
    await gitOut(repo, 'add', '-A');
    await gitOut(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'binary');

    const taskA = workflow.tasks.find((t) => t.id === 'a')!;
    const ws = await manager.acquire(taskA, 1, 'shared', run);
    await fs.appendFile(path.join(repo, 'spaced name.txt'), 'two\n');
    await fs.appendFile(path.join(repo, 'café.txt'), 'deux\n');
    await fs.writeFile(path.join(repo, 'café.bin'), Buffer.from([9, 8, 7, 0, 6]));
    const diff = (await manager.finalize(taskA, ws, 'success', run)).diff!;

    expect(diff.files.map((f) => f.path).sort()).toEqual(['café.bin', 'café.txt', 'spaced name.txt']);
    expect(patchForFile(diff.patch, 'spaced name.txt')).toContain('+two\n');
    expect(patchForFile(diff.patch, 'café.txt')).toContain('+deux\n');
    expect(patchForFile(diff.patch, 'café.bin')).toContain('GIT binary patch');
    // One file's section is only that file's section, and it still applies on its own.
    const single = patchForFile(diff.patch, 'spaced name.txt');
    expect(single).not.toContain('café');
    const base = await extractTree(repo, diff.base!);
    const patchFile = path.join(base, 'one.patch');
    await fs.writeFile(patchFile, single);
    expect(await gitExit(base, 'apply', patchFile)).toBe(0);
    expect(await fs.readFile(path.join(base, 'spaced name.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('writes an empty diff for an attempt that changed nothing', async () => {
    const { workflow, run, manager } = await setup();
    const taskA = workflow.tasks.find((t) => t.id === 'a')!;
    const ws = await manager.acquire(taskA, 1, 'shared', run);
    const fin = await manager.finalize(taskA, ws, 'success', run);
    expect(fin.diff).toBeDefined();
    expect(fin.diff?.files).toEqual([]);
    expect(fin.diff?.patch).toBe('');
    expect(fin.diff?.truncated).toBe(false);
    expect(fin.diff?.base).toBe(fin.diff?.head);
  });

  it('truncates diff.patch at git.maxDiffBytes and keeps the file records complete', async () => {
    const { workflow, run, manager } = await setup('', 'git:\n  maxDiffBytes: 300\n');
    expect(workflow.git.maxDiffBytes).toBe(300);
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await fs.writeFile(path.join(ws.path, 'big.txt'), `${Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')}\n`);
    const fin = await manager.finalize(taskB, ws, 'success', run);

    const diff = fin.diff!;
    expect(diff.truncated).toBe(true);
    expect(diff.files).toEqual([{ path: 'big.txt', status: 'A', additions: 400, deletions: 0, binary: false }]);
    expect(diff.patch).toMatch(/\n\.\.\. diff truncated after \d+ of at most 300 bytes \(git\.maxDiffBytes\); all 1 file\(s\) are listed in diff\.json\n$/);
    const note = diff.patch.slice(diff.patch.lastIndexOf('\n... diff truncated'));
    expect(Buffer.byteLength(diff.patch.slice(0, diff.patch.length - note.length), 'utf8')).toBeLessThanOrEqual(300);
    expect(fin.git?.diffTruncated).toBe(true);
  });

  it('captures nothing when git.captureDiff is false', async () => {
    const { repo, workflow, run, manager } = await setup('', 'git:\n  captureDiff: false\n');
    const taskA = workflow.tasks.find((t) => t.id === 'a')!;
    const ws = await manager.acquire(taskA, 1, 'shared', run);
    expect(ws.treeBefore).toBeUndefined();
    await fs.writeFile(path.join(repo, 'x.txt'), 'x\n');
    const shared = await manager.finalize(taskA, ws, 'success', run);
    expect(shared.diff).toBeUndefined();
    expect(shared.git?.files).toBeUndefined();

    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const wt = await manager.acquire(taskB, 1, 'worktree', run);
    await commitFile(wt.path, 'b.txt', 'b\n');
    const fin = await manager.finalize(taskB, wt, 'success', run);
    expect(fin.diff).toBeUndefined();
    expect(fin.git?.diffStat).toBeUndefined();
    expect(fin.git?.headSha).toBeDefined();
  });

  it('gives the merge-resolution attempt its own patch from the pre-merge head', async () => {
    const { repo, workflow, run, manager } = await setup();
    const taskB = workflow.tasks.find((t) => t.id === 'b')!;
    const ws = await manager.acquire(taskB, 1, 'worktree', run);
    await commitFile(repo, 'shared.txt', 'from main\n');
    await commitFile(ws.path, 'shared.txt', 'from b\n');
    const fin = await manager.finalize(taskB, ws, 'success', run);
    expect(fin.merge?.status).toBe('conflict');
    expect(fin.merge?.intoSha).toBe(await gitOut(repo, 'rev-parse', 'HEAD'));

    // The scheduler hands the pre-merge head to the resolution attempt; resolve it as that session would.
    const mergeWorkspace = { ...fin.workspace, mergeBaseSha: fin.merge!.intoSha };
    await gitOut(repo, 'merge', '--no-ff', '--no-commit', ws.branch!);
    await gitOut(repo, 'checkout', '--theirs', 'shared.txt');
    await gitOut(repo, 'add', '-A');
    await gitOut(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'resolved');
    const done = await manager.completeMerge(taskB, mergeWorkspace, run);
    expect(done.merge?.status).toBe('merged');
    expect(done.diff?.base).toBe(fin.merge!.intoSha);
    expect(done.diff?.files.map((f) => f.path)).toEqual(['shared.txt']);
    expect(done.diff?.patch).toContain('+from b');
  });

  it('refuses to start when requireCleanWorkingTree is set and the tree is dirty', async () => {
    const repo = await tmpGitRepo();
    const { workflow } = await buildWorkflow('name: t\ngit:\n  requireCleanWorkingTree: true\ntasks:\n  - id: a\n    prompt: p\n', { repositoryRoot: repo, gitRoot: repo });
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'x');
    await expect(new GitWorkspaceManager(workflow).prepareRun(makeRun(workflow))).rejects.toThrow(/requireCleanWorkingTree/);
  });
});
