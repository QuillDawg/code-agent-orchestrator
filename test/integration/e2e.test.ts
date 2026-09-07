/**
 * End-to-end through the real service layer (loader → normalize → validate → runtime → scheduler →
 * ClaudeRunner → child process) using the fake Claude CLI. No real Claude calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun, reconcileForResume } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { tmpGitRepo, gitOut, gitExit, extractTree, captureCli, FAKE_CLAUDE, waitFor, gitAvailable } from '../helpers/index.js';
import { isProcessAlive } from '../../src/util/misc.js';
import { pathExists } from '../../src/util/fs.js';
import type { AttemptDiff } from '../../src/types/result.js';
import { diffCommand } from '../../src/cli/commands/diff.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import { logsCommand } from '../../src/cli/commands/logs.js';
import { reportCommand } from '../../src/cli/commands/report.js';
import { renderSummary } from '../../src/cli/render/plain.js';
import type { RunReport } from '../../src/workflow/report.js';

const ACCEPTANCE = `
version: 1
name: Acceptance V1
repository: .
execution:
  maxConcurrency: 3
defaults:
  timeout: 2m
templates:
  implementIssue:
    type: implementation
    prompt: "/implement {{issueNumber}}"
tasks:
  - id: implement-101
    template: implementIssue
    issueNumber: 101
  - id: implement-102
    template: implementIssue
    issueNumber: 102
    parallelGroup: core
  - id: implement-103
    template: implementIssue
    issueNumber: 103
    parallelGroup: core
  - id: implement-104
    template: implementIssue
    issueNumber: 104
  - id: prd-review
    type: review
    context:
      fromType: implementation
    prompt: Review the PRD against the implementation.
  - id: code-review
    type: review
    context:
      from: [prd-review, "implement-*"]
    prompt: Code review.
  - id: final-review
    type: verification
    context:
      from:
        - task: prd-review
          include: [summary]
        - task: code-review
          include: [summary, warnings]
    prompt: Final verification.
`;

interface Trace {
  taskId: string;
  attempt: number;
  cwd: string;
  prompt: string;
  args: string[];
  env: { CAO_ATTEMPT_KIND?: string };
}

async function writeWorkflow(repo: string, yaml: string): Promise<string> {
  const p = path.join(repo, 'workflow.yaml');
  await fs.writeFile(p, yaml);
  return p;
}

async function readTrace(file: string): Promise<Trace[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Trace);
}

function fakeEnv(repo: string, extra: Record<string, string> = {}): Record<string, string> {
  return { FAKE_CLAUDE_TRACE: path.join(repo, '.orchestrator', 'trace.jsonl'), ...extra };
}

async function execute(repo: string, yaml: string, env: Record<string, string>, opts: { only?: string[] } = {}) {
  const configPath = await writeWorkflow(repo, yaml);
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: { only: opts.only } });
  const runtime = createRuntime({ run, environment: env, secrets: [], logger: silentLogger });
  const result = await runtime.scheduler.execute();
  return { run, result, runtime, store, prepared };
}

/** Options for one `cao diff` invocation in a test, plus the positional refs. */
type DiffOptions = Parameters<typeof diffCommand>[1] & { refs?: string[] };

const HAS_GIT = await gitAvailable('end-to-end suite');

describe.skipIf(!HAS_GIT)('end-to-end with fake Claude', () => {
  beforeAll(() => clearDetectionCache());

  it('runs the V1 acceptance workflow: isolation, worktrees, merge-back, context passing', async () => {
    const repo = await tmpGitRepo('cao-e2e-');
    const { run, result, store } = await execute(repo, ACCEPTANCE, fakeEnv(repo, { FAKE_CLAUDE_MODE: 'commit' }));
    expect(result.state).toBe('completed');
    expect(Object.values(run.tasks).every((t) => t.state === 'success')).toBe(true);

    const trace = await readTrace(path.join(repo, '.orchestrator', 'trace.jsonl'));
    expect(trace.map((t) => t.taskId)).toEqual(expect.arrayContaining(['implement-101', 'implement-102', 'implement-103', 'implement-104', 'prd-review', 'code-review', 'final-review']));
    // every task ran as its own process with its own session id
    const sessions = trace.map((t) => t.args[t.args.indexOf('--session-id') + 1]);
    expect(new Set(sessions).size).toBe(trace.length);
    // headless flags present
    expect(trace[0]!.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--json-schema', '--permission-mode', 'auto', '--permission-prompts', 'none']));
    // sequential tasks ran in the repository, parallel tasks in worktrees
    const cwd = Object.fromEntries(trace.map((t) => [t.taskId, path.resolve(t.cwd)]));
    expect(cwd['implement-101']).toBe(path.resolve(repo));
    expect(cwd['implement-102']).toBe(path.resolve(repo, '.orchestrator', 'worktrees', 'implement-102'));
    expect(cwd['implement-103']).toBe(path.resolve(repo, '.orchestrator', 'worktrees', 'implement-103'));
    expect(cwd['implement-104']).toBe(path.resolve(repo));
    // 104 started only after both parallel tasks succeeded, and their work was merged back
    const idx = (id: string) => trace.findIndex((t) => t.taskId === id);
    expect(idx('implement-104')).toBeGreaterThan(Math.max(idx('implement-102'), idx('implement-103')));
    expect(await pathExists(path.join(repo, 'implement-102.txt'))).toBe(true);
    expect(await pathExists(path.join(repo, 'implement-103.txt'))).toBe(true);
    expect(await gitOut(repo, 'log', '--oneline')).toMatch(/Merge orchestrator\/implement-10[23]/);
    // The completion marker edits the (committed) workflow file; nothing else may be left dirty.
    expect((await gitOut(repo, 'status', '--porcelain')).split(/\r?\n/).filter((l) => l.trim() && !/workflow.yaml$/.test(l))).toEqual([]);
    // context passing
    const prd = trace.find((t) => t.taskId === 'prd-review')!;
    expect(prd.prompt).toContain('# Previous Task Context');
    for (const id of ['implement-101', 'implement-102', 'implement-103', 'implement-104']) expect(prd.prompt).toContain(`## ${id}`);
    expect(prd.prompt).toContain('Fake success for implement-102');
    expect(prd.prompt.endsWith('# Task\n\nReview the PRD against the implementation.\n')).toBe(true);
    const finalReview = trace.find((t) => t.taskId === 'final-review')!;
    expect(finalReview.prompt).toContain('## prd-review');
    expect(finalReview.prompt).toContain('## code-review');
    expect(finalReview.prompt).not.toContain('## implement-101');
    expect(finalReview.prompt).not.toContain('decision-prd-review'); // summary-only selector
    // artifacts
    const runDir = store.paths.runDir(run.runId);
    expect(await pathExists(path.join(runDir, 'workflow.json'))).toBe(true);
    expect(await pathExists(path.join(runDir, 'events.jsonl'))).toBe(true);
    for (const f of ['stdout.log', 'stderr.log', 'events.jsonl', 'prompt.md', 'attempt.json']) {
      expect(await pathExists(path.join(runDir, 'tasks', 'implement-102', 'attempts', '1', f))).toBe(true);
    }
    // every attempt carries its own patch: the worktree task from its branch, the shared one from snapshots
    for (const id of ['implement-101', 'implement-102']) {
      const diff = JSON.parse(await fs.readFile(store.paths.diffJsonFile(run.runId, id, 1), 'utf8')) as AttemptDiff;
      expect(diff.files).toEqual([{ path: `${id}.txt`, status: 'A', additions: 1, deletions: 0, binary: false }]);
      expect(diff.truncated).toBe(false);
      const patch = await fs.readFile(store.paths.diffPatchFile(run.runId, id, 1), 'utf8');
      expect(patch).toContain(`+++ b/${id}.txt`);
      expect(patch).toContain(`+${id} attempt 1`);
      expect(run.tasks[id]!.result?.git?.files).toEqual(diff.files);
    }
    // the completion marker the orchestrator writes between attempts belongs to no task's diff
    const reviewDiff = JSON.parse(await fs.readFile(store.paths.diffJsonFile(run.runId, 'prd-review', 1), 'utf8')) as AttemptDiff;
    expect(reviewDiff.files.map((f) => f.path)).toEqual(['prd-review.txt']);
    expect(await pathExists(path.join(runDir, 'tasks', 'prd-review', 'context.md'))).toBe(true);
    expect(await pathExists(path.join(runDir, 'tasks', 'implement-101', 'result.json'))).toBe(true);
    const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(events[0]!.type).toBe('workflow.started');
    expect(events[events.length - 1]!.type).toBe('workflow.completed');
    expect(run.tasks['implement-101']!.result?.git?.headSha).toBeDefined();
    expect(run.tasks['implement-101']!.result?.usage?.costUsd).toBe(0.01);
  }, 60_000);

  it('captures shell-only changes in the diff and truncates a patch at git.maxDiffBytes', async () => {
    const repo = await tmpGitRepo('cao-e2e-diff-');
    const yaml = [
      'name: diffs',
      'git:',
      '  maxDiffBytes: 2000',
      'tasks:',
      '  - id: shell-task',
      '    prompt: p',
      '  - id: big-task',
      '    prompt: p',
      '  - id: quiet-task',
      '    prompt: p',
      '',
    ].join('\n');
    const env = fakeEnv(repo, {
      FAKE_CLAUDE_TASK_MODES: JSON.stringify({ 'shell-task': 'shell', 'big-task': 'big', 'quiet-task': 'noop' }),
      FAKE_CLAUDE_BIG_LINES: '400',
    });
    const { run, result, store } = await execute(repo, yaml, env);
    expect(result.state).toBe('completed');
    const readDiff = async (taskId: string): Promise<AttemptDiff> =>
      JSON.parse(await fs.readFile(store.paths.diffJsonFile(run.runId, taskId, 1), 'utf8')) as AttemptDiff;

    // The worker created one file and deleted another through the shell; the tool stream saw neither path.
    expect(Object.keys(run.tasks['shell-task']!.attempts[0]!.files ?? {})).toEqual([]);
    const shell = await readDiff('shell-task');
    expect(shell.truncated).toBe(false);
    expect(shell.files.map((f) => [f.path, f.status])).toEqual([
      ['README.md', 'D'],
      ['shell-task-created.txt', 'A'],
    ]);
    const shellPatch = await fs.readFile(store.paths.diffPatchFile(run.runId, 'shell-task', 1), 'utf8');
    expect(shellPatch).toContain('deleted file mode');
    expect(shellPatch).toContain('+++ b/shell-task-created.txt');
    // The file on disk is a patch git will take back: nothing trimmed its last line on the way out.
    const base = await extractTree(repo, shell.base!);
    expect(await gitExit(base, 'apply', '--check', store.paths.diffPatchFile(run.runId, 'shell-task', 1))).toBe(0);

    // 400 long lines are far past maxDiffBytes: the patch is cut, the records are not.
    const big = await readDiff('big-task');
    expect(big.truncated).toBe(true);
    expect(big.files).toEqual([{ path: 'big-task-big.txt', status: 'A', additions: 400, deletions: 0, binary: false }]);
    const bigPatch = await fs.readFile(store.paths.diffPatchFile(run.runId, 'big-task', 1), 'utf8');
    expect(bigPatch).toMatch(/\n\.\.\. diff truncated after \d+ of at most 2000 bytes \(git\.maxDiffBytes\); all 1 file\(s\) are listed in diff\.json\n$/);
    expect(Buffer.byteLength(bigPatch, 'utf8')).toBeLessThan(2000 + 200);
    expect(run.tasks['big-task']!.result?.git?.diffTruncated).toBe(true);

    // A session that changed nothing still leaves both files behind, saying so.
    expect(await readDiff('quiet-task')).toMatchObject({ files: [], additions: 0, deletions: 0, truncated: false });
    expect(await fs.readFile(store.paths.diffPatchFile(run.runId, 'quiet-task', 1), 'utf8')).toBe('');
  }, 60_000);

  it('writes a diff.patch that git apply accepts after it has been through the store', async () => {
    const repo = await tmpGitRepo('cao-e2e-apply-');
    await fs.writeFile(path.join(repo, 'moved.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(repo, 'deleted-recreated.txt'), 'before\n');
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await gitOut(repo, 'add', '-A');
    await gitOut(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixtures');

    const yaml = 'name: apply\ntasks:\n  - id: edge-task\n    prompt: p\n';
    const { run, result, store } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_MODE: 'edge' }));
    expect(result.state).toBe('completed');
    const diff = JSON.parse(await fs.readFile(store.paths.diffJsonFile(run.runId, 'edge-task', 1), 'utf8')) as AttemptDiff;
    expect(diff.files.map((f) => f.path).sort()).toEqual(['blob.bin', 'crlf.txt', 'deleted-recreated.txt', 'renamed dir/renamed file.txt']);

    // The binary hunk and the trailing newline survive redaction and the atomic write, so the file on disk
    // is still a patch: replaying it on the attempt's base reproduces what the agent did.
    const base = await extractTree(repo, diff.base!);
    const patchFile = store.paths.diffPatchFile(run.runId, 'edge-task', 1);
    expect(await gitExit(base, 'apply', '--check', patchFile)).toBe(0);
    expect(await gitExit(base, 'apply', patchFile)).toBe(0);
    expect([...(await fs.readFile(path.join(base, 'blob.bin')))]).toEqual([0, 1, 2, 3, 0, 255, 254, 253]);
    expect(await fs.readFile(path.join(base, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(await pathExists(path.join(base, 'renamed dir', 'renamed file.txt'))).toBe(true);
  }, 60_000);

  it('cao diff prints the captured records, a stat table and a patch git apply still accepts', async () => {
    const repo = await tmpGitRepo('cao-e2e-diffcmd-');
    const yaml = 'name: diffcmd\ntasks:\n  - id: alpha\n    prompt: p\n  - id: beta\n    prompt: p\n  - id: quiet\n    prompt: p\n';
    const modes = JSON.stringify({ alpha: 'commit', beta: 'shell', quiet: 'noop' });
    const { run, result, store } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_TASK_MODES: modes }));
    expect(result.state).toBe('completed');
    const cli = (opts: DiffOptions) => captureCli(() => diffCommand(opts.refs ?? [], { repository: repo, ...opts }));

    // --json hands back exactly what the attempts captured, every task in execution order
    const json = JSON.parse((await cli({ json: true })).stdout) as { runId: string; tasks: { taskId: string; attempt: number; kind: string; diff: AttemptDiff }[] };
    expect(json.runId).toBe(run.runId);
    expect(json.tasks.map((t) => t.taskId)).toEqual(['alpha', 'beta', 'quiet']);
    for (const t of json.tasks) {
      expect(t.diff).toEqual(JSON.parse(await fs.readFile(store.paths.diffJsonFile(run.runId, t.taskId, t.attempt), 'utf8')));
    }
    expect(json.tasks[0]!.diff.files).toEqual([{ path: 'alpha.txt', status: 'A', additions: 1, deletions: 0, binary: false }]);

    // one task, no header: the bytes are the captured patch, so a pipe into git works
    const alpha = await cli({ refs: ['alpha'] });
    expect(alpha.stdout).toBe(await fs.readFile(store.paths.diffPatchFile(run.runId, 'alpha', 1), 'utf8'));
    expect(alpha.stderr).toBe('');

    // --stat reuses the numbers from diff.json; --name-only lists paths
    expect((await cli({ refs: ['beta'], stat: true })).stdout).toBe('D README.md         +0 -1\nA beta-created.txt  +1 -0\n2 files changed, +1 -1\n');
    expect((await cli({ refs: ['beta'], nameOnly: true })).stdout).toBe('README.md\nbeta-created.txt\n');

    // --file narrows to one path, across every task, and drops the tasks that never touched it
    const readme = await cli({ file: 'README.md' });
    expect(readme.stdout).toContain('--- a/README.md');
    expect(readme.stdout).not.toContain('beta-created.txt');
    expect(readme.stdout).not.toContain('# beta'); // one task left, so no header
    expect((await cli({ file: 'src/nowhere.ts' })).stdout).toBe('');
    expect((await cli({ file: 'src/nowhere.ts' })).stderr).toContain('No attempt in run');

    // a task that changed nothing says so on stderr, leaving stdout a valid (empty) patch
    const quiet = await cli({ refs: ['quiet'] });
    expect(quiet.stdout).toBe('');
    expect(quiet.stderr).toContain('quiet attempt 1 changed nothing.');
    expect((await cli({ refs: ['alpha'], attempt: 7 })).stderr).toContain('no captured diff for attempt 7');

    // the whole run: one header per task, and git apply still finds every patch between them
    const all = await cli({});
    expect(all.code).toBe(0);
    expect(all.stdout).toMatch(/^# alpha {2}attempt 1 {2}1 file changed, \+1 -0$/m);
    expect(all.stdout).toMatch(/^# quiet {2}attempt 1 {2}0 files changed, \+0 -0$/m);
    const base = await extractTree(repo, json.tasks[0]!.diff.base!);
    await fs.writeFile(path.join(base, 'run.patch'), all.stdout);
    expect(await gitExit(base, 'apply', '--check', 'run.patch')).toBe(0);
    expect(await gitExit(base, 'apply', 'run.patch')).toBe(0);
    expect(await pathExists(path.join(base, 'alpha.txt'))).toBe(true);
    expect(await pathExists(path.join(base, 'beta-created.txt'))).toBe(true);
    expect(await pathExists(path.join(base, 'README.md'))).toBe(false);

    // cao task swaps the live W/M/D list for the stat table once the attempt has finished
    const task = await captureCli(() => taskCommand(['beta'], { repository: repo }));
    expect(task.stdout).toContain('Changes (attempt 1):');
    expect(task.stdout).toContain('  D README.md         +0 -1');
    expect(task.stdout).toContain('  2 files changed, +1 -1');
    expect(task.stdout).not.toContain('Files touched');
  }, 60_000);

  it('writes report.md at the end of the run and cao report renders the same document', async () => {
    const repo = await tmpGitRepo('cao-e2e-report-');
    const yaml = 'name: reported\ntasks:\n  - id: alpha\n    prompt: p\n  - id: beta\n    prompt: p\n';
    const modes = JSON.stringify({ alpha: 'commit', beta: 'shell' });
    const { run, result, store } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_TASK_MODES: modes }));
    expect(result.state).toBe('completed');

    // the run wrote its own report, and the end-of-run summary table points at it
    const file = store.paths.reportFile(run.runId);
    const onDisk = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    expect(run.reportPath).toBe(`.orchestrator/runs/${run.runId}/report.md`);
    expect(renderSummary(run, { color: false })).toContain(`Report: ${run.reportPath}`);
    expect((await store.loadRun(run.runId)).reportPath).toBe(run.reportPath);

    expect(onDisk).toContain(`# reported — run ${run.runId}`);
    expect(onDisk).toContain('- **Result:** Completed — 2/2 tasks succeeded');
    expect(onDisk).toContain('## alpha');
    // the overview row links to the section below it, by the anchor GitHub gives that heading
    expect(onDisk).toContain('| [`alpha`](#alpha) | Completed |');
    // the +/- come from the attempt's own diff.json, shell-driven deletions included
    expect(onDisk).toContain('| A | `alpha.txt` | +1 -0 |');
    expect(onDisk).toContain('| D | `README.md` | +0 -1 |');

    // `cao report` builds the same document from the same directory
    const md = await captureCli(() => reportCommand(undefined, { repository: repo }));
    expect(md.code).toBe(0);
    expect(md.stdout).toBe(onDisk);

    const json = JSON.parse((await captureCli(() => reportCommand(run.runId, { repository: repo, json: true }))).stdout) as RunReport;
    expect(json.runId).toBe(run.runId);
    expect(json.tasks.map((t) => t.id)).toEqual(['alpha', 'beta']);
    expect(json.tasks[1]!.changes?.files.map((f) => f.path)).toEqual(['README.md', 'beta-created.txt']);
    expect(json.changes.files).toBe(3);

    const out = path.join(repo, 'pr-body.md');
    const written = await captureCli(() => reportCommand(undefined, { repository: repo, out }));
    expect(written.stdout.trim()).toBe(out);
    expect((await fs.readFile(out, 'utf8')).replace(/\r\n/g, '\n')).toBe(onDisk);
  }, 60_000);

  it('resolves merge conflicts through a Claude merge session', async () => {
    const repo = await tmpGitRepo('cao-e2e-conflict-');
    const { run, result, store } = await execute(repo, ACCEPTANCE, fakeEnv(repo, { FAKE_CLAUDE_MODE: 'commit', FAKE_CLAUDE_TASK_MODES: JSON.stringify({ 'implement-102': 'conflict', 'implement-103': 'conflict' }) }));
    expect(result.state).toBe('completed');
    const conflicted = ['implement-102', 'implement-103'].filter((id) => run.tasks[id]!.attempts.some((a) => a.kind === 'merge'));
    expect(conflicted).toHaveLength(1);
    // the resolution attempt gets its own patch, distinct from the task's own work
    const mergeAttempt = run.tasks[conflicted[0]!]!.attempts.find((a) => a.kind === 'merge')!;
    expect(mergeAttempt.workspace?.mergeBaseSha).toMatch(/^[0-9a-f]{40}$/);
    const mergeDiff = JSON.parse(await fs.readFile(store.paths.diffJsonFile(run.runId, conflicted[0]!, mergeAttempt.number), 'utf8')) as AttemptDiff;
    expect(mergeDiff.base).toBe(mergeAttempt.workspace?.mergeBaseSha);
    expect(mergeDiff.files.map((f) => f.path)).toContain('shared.txt');
    const trace = await readTrace(path.join(repo, '.orchestrator', 'trace.jsonl'));
    const mergeCall = trace.find((t) => t.env.CAO_ATTEMPT_KIND === 'merge')!;
    expect(mergeCall.prompt).toContain('# Merge Conflict Resolution');
    expect(path.resolve(mergeCall.cwd)).toBe(path.resolve(repo));
    // The completion marker edits the (committed) workflow file; nothing else may be left dirty.
    expect((await gitOut(repo, 'status', '--porcelain')).split(/\r?\n/).filter((l) => l.trim() && !/workflow.yaml$/.test(l))).toEqual([]);
    expect(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8')).toMatch(/content from implement-10[23]/);
  }, 60_000);

  it('maps runner outcomes: invalid result, crash, timeout, prose fallback, error result', async () => {
    const repo = await tmpGitRepo('cao-e2e-outcomes-');
    const yaml = `
name: outcomes
execution:
  mode: dag
  maxConcurrency: 5
defaults:
  onFailure: continue
tasks:
  - id: ok
    prompt: p
  - id: invalid
    prompt: p
  - id: crash
    prompt: p
  - id: slowpoke
    timeout: 1500ms
    prompt: p
  - id: prose
    prompt: p
  - id: errored
    prompt: p
  - id: failed
    retries: 1
    prompt: p
`;
    const { run, result } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_TASK_MODES: JSON.stringify({ invalid: 'invalid', crash: 'crash', slowpoke: 'hang', prose: 'prose', errored: 'error-result', failed: 'failed' }) }));
    expect(result.state).toBe('failed');
    const t = run.tasks;
    expect(t.ok!.state).toBe('success');
    expect(t.prose!.state).toBe('success'); // JSON extracted from the result text
    expect(t.invalid!.state).toBe('failed');
    expect(t.invalid!.reason).toBe('invalid_result');
    expect(t.crash!.state).toBe('failed');
    expect(t.crash!.reason).toBe('crash');
    expect(t.crash!.message).toMatch(/exited with code 3/);
    expect(t.slowpoke!.state).toBe('failed');
    expect(t.slowpoke!.reason).toBe('timeout');
    expect(t.errored!.state).toBe('failed');
    expect(t.errored!.message).toMatch(/max turns/);
    expect(t.failed!.state).toBe('failed');
    expect(t.failed!.attempts).toHaveLength(2);
    expect(t.failed!.message).toContain('simulated failure');
    // hang mode spawned a grandchild; nothing must be left running
    const pid = t.slowpoke!.attempts[0]!.pid!;
    expect(isProcessAlive(pid)).toBe(false);
  }, 60_000);

  it('recovers from a transient API error by resuming the same Claude session', async () => {
    const repo = await tmpGitRepo('cao-e2e-api-error-');
    const yaml = [
      'name: api',
      'tasks:',
      '  - id: flaky',
      '    retry:',
      '      transientDelay: 20ms',
      '    prompt: p',
      '  - id: netdrop',
      '    retry:',
      '      transientDelay: 20ms',
      '    prompt: p',
      '',
    ].join('\n');
    const env = fakeEnv(repo, {
      FAKE_CLAUDE_API_ERROR_UNTIL_ATTEMPT: JSON.stringify({ flaky: 3 }),
      FAKE_CLAUDE_TASK_MODES: JSON.stringify({ netdrop: 'api-error-stderr' }),
    });
    const { run, result, store } = await execute(repo, yaml, env);
    const trace = await readTrace(env.FAKE_CLAUDE_TRACE!);

    // flaky: two 500s, each recovered by resuming the same session, then success on attempt 3
    const flaky = run.tasks.flaky!;
    expect(flaky.state).toBe('success');
    expect(flaky.attempts.map((a) => a.outcome)).toEqual(['api_error', 'api_error', 'success']);
    const firstSession = flaky.attempts[0]!.usage?.sessionId ?? flaky.attempts[0]!.sessionId;
    expect(firstSession).toBeTruthy();
    expect(flaky.attempts[1]!.resumedSessionId).toBe(firstSession);
    expect(flaky.attempts[2]!.resumedSessionId).toBe(firstSession);
    const flakyCalls = trace.filter((t) => t.taskId === 'flaky').sort((a, b) => a.attempt - b.attempt);
    expect(flakyCalls).toHaveLength(3);
    expect(flakyCalls[0]!.args).toContain('--session-id');
    expect(flakyCalls[0]!.args).not.toContain('--resume');
    for (const call of flakyCalls.slice(1)) {
      expect(call.args[call.args.indexOf('--resume') + 1]).toBe(firstSession);
      expect(call.args).not.toContain('--session-id');
      expect(call.prompt).toContain('# Session Resumed');
    }
    expect(flaky.attempts[0]!.error).toMatch(/API Error: 500/);

    // cao task renders that history: every attempt with its outcome, and why each retry happened
    const shown = await captureCli(() => taskCommand(['flaky'], { repository: repo }));
    const attemptLines = shown.stdout.split(/\r?\n/).filter((l) => /^ {2}#\d/.test(l));
    expect(attemptLines).toHaveLength(3);
    expect(attemptLines[0]).toMatch(/^ {2}#1 {2}task {2}initial {2}\d\d:\d\d:\d\d → \d\d:\d\d:\d\d {2}\d\dm \d\ds {2}transient API error {2}exit 0 {2}\$/);
    expect(attemptLines[2]).toContain('#3  task  retry');
    expect(shown.stdout).toContain(`↳ retried after attempt 2 transient API error, continuing session ${firstSession!.slice(0, 8)}`);
    expect(shown.stdout).toMatch(/↳ .*API Error: 500/);
    expect(shown.stdout).toContain('decisions:');

    // --json carries the same records, with the numbers the text output derives
    const shape = JSON.parse((await captureCli(() => taskCommand(['flaky'], { repository: repo, json: true }))).stdout) as {
      attempts: Array<{ number: number; triggeredBy: string; outcome: string; durationMs: number; reason?: string; interactions?: unknown[] }>;
      interactions: unknown[];
    };
    expect(shape.attempts.map((a) => a.number)).toEqual([1, 2, 3]);
    expect(shape.attempts.map((a) => a.triggeredBy)).toEqual(['initial', 'retry', 'retry']);
    expect(shape.attempts.every((a) => Number.isFinite(a.durationMs))).toBe(true);
    expect(shape.attempts[0]!.reason).toBeUndefined();
    expect(shape.attempts[1]!.reason).toContain('retried after attempt 1 transient API error');
    expect(shape.interactions).toEqual([]);

    // netdrop: a network failure on stderr with a non-zero exit is transient too; the fake keeps failing until the
    // transient budget (3) is spent, then the task fails for real with the stderr detail
    const netdrop = run.tasks.netdrop!;
    expect(netdrop.state).toBe('failed');
    expect(netdrop.reason).toBe('api_error');
    expect(netdrop.attempts).toHaveLength(4);
    expect(netdrop.attempts.every((a) => a.outcome === 'api_error')).toBe(true);
    expect(netdrop.message).toMatch(/fetch failed|ECONNRESET/);

    expect(result.state).toBe('failed');

    const runDir = store.paths.runDir(run.runId);
    const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; resumeSession?: boolean });
    expect(events.filter((e) => e.type === 'task.retrying' && e.resumeSession)).toHaveLength(5);
    const attemptEvents = (await fs.readFile(path.join(store.paths.attemptDir(run.runId, 'flaky', 2), 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; sessionId?: string });
    expect(attemptEvents[0]).toMatchObject({ kind: 'system', text: `resumed session ${firstSession}` });
  }, 60_000);

  it('interrupts a running workflow, persists state and resumes without re-running completed tasks', async () => {
    const repo = await tmpGitRepo('cao-e2e-resume-');
    const yaml = 'name: r\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n  - id: c\n    prompt: p\n';
    const configPath = await writeWorkflow(repo, yaml);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
    const env = fakeEnv(repo, { FAKE_CLAUDE_TASK_MODES: JSON.stringify({ b: 'hang' }) });
    const runtime = createRuntime({ run, environment: env, secrets: [], logger: silentLogger });
    const execution = runtime.scheduler.execute();
    await waitFor(() => run.tasks.b?.state === 'running' && run.tasks.b.attempts[0]?.pid !== undefined, 15_000);
    const pid = run.tasks.b!.attempts[0]!.pid!;
    // The orchestrator records the pid the moment it spawns the fake, but the fake writes its trace line only
    // once node has booted its script. Stopping in between races the kill against that startup (Linux wins
    // the race, Windows usually does not), and the trace asserted below would then lack b#1.
    const traceFile = path.join(repo, '.orchestrator', 'trace.jsonl');
    for (const start = Date.now(); !(await readTrace(traceFile)).some((t) => t.taskId === 'b'); ) {
      if (Date.now() - start > 15_000) throw new Error('fake Claude for task b never wrote its trace line');
      await new Promise((r) => setTimeout(r, 20));
    }
    runtime.scheduler.requestStop('cancel', 'signal');
    await runtime.processManager.shutdown('graceful');
    const result = await execution;
    expect(result.state).toBe('interrupted');
    expect(result.exitCode).toBe(130);
    await waitFor(() => !isProcessAlive(pid), 10_000);

    const reloaded = await store.loadRun(run.runId);
    expect(reloaded.state).toBe('interrupted');
    expect(reloaded.tasks.a!.state).toBe('success');
    expect(reloaded.tasks.b!.state).toBe('cancelled');
    expect(reloaded.repositoryRoot).toBe(prepared.workflow.repositoryRoot);
    expect(reloaded.launchDirectory).toBe(path.resolve(repo));

    const rec = await reconcileForResume(reloaded);
    expect(rec.rerun).toEqual(['b']);
    const runtime2 = createRuntime({ run: reloaded, environment: fakeEnv(repo), secrets: [], logger: silentLogger, isResume: true });
    const result2 = await runtime2.scheduler.execute();
    expect(result2.state).toBe('completed');
    const trace = await readTrace(traceFile);
    expect(trace.map((t) => `${t.taskId}#${t.attempt}`)).toEqual(['a#1', 'b#1', 'b#2', 'c#1']);
    expect(reloaded.tasks.b!.attempts[1]!.triggeredBy).toBe('resume');
  }, 60_000);

  it('runs a single selected task with --task', async () => {
    const repo = await tmpGitRepo('cao-e2e-select-');
    const yaml = 'name: s\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n';
    const { run, result } = await execute(repo, yaml, fakeEnv(repo), { only: ['b'] });
    expect(result.state).toBe('completed');
    expect(run.tasks.a!.state).toBe('skipped');
    expect(run.tasks.b!.state).toBe('success');
    const trace = await readTrace(path.join(repo, '.orchestrator', 'trace.jsonl'));
    expect(trace.map((t) => t.taskId)).toEqual(['b']);
  }, 30_000);

  it('shows tool timing and nested subagents in cao logs, not one bare line per event', async () => {
    const repo = await tmpGitRepo('cao-e2e-logs-');
    const yaml = 'name: l\ntasks:\n  - id: a\n    prompt: p\n';
    const { run, result } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_MODE: 'subagents' }));
    expect(result.state).toBe('completed');

    const { stdout } = await captureCli(() => logsCommand([run.runId, 'a'], { repository: repo, color: 'never' }));
    // The tail is one transcript, so a call knows its result: every answered call carries a time.
    expect(stdout).toMatch(/Grep: TODO in src · \d/);
    // A subagent's entries are indented under the Agent call, its grandchildren one level deeper again.
    expect(stdout).toMatch(/\n\d\d:\d\d:\d\d {3}▸ Agent: Dig into src\/a\.ts/);
    expect(stdout).toMatch(/\n\d\d:\d\d:\d\d {5}▸ Read src\/a\.ts/);
    // Nothing is dropped on the way, and the report of each subagent sits under its own call.
    expect(stdout).toContain('One stale TODO');
    expect(stdout).toContain('tests passed');
    expect(stdout.indexOf('Found 1 TODO')).toBeLessThan(stdout.indexOf('Agent: Check the tests'));
    // The session ended with a tool still open; the log says which one instead of quietly showing nothing.
    expect(stdout).toContain('Write src/never.ts · no result');
  }, 30_000);

  it('keeps thinking in the attempt log only, and shows it in cao logs on request', async () => {
    const repo = await tmpGitRepo('cao-e2e-think-');
    const yaml = 'name: t\ntasks:\n  - id: a\n    prompt: p\n';
    const { run, result, store } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_MODE: 'thinking' }));
    expect(result.state).toBe('completed');

    // The attempt's own log is the record: it has the thinking blocks the CLI emitted, in order.
    const attemptEvents = (await fs.readFile(path.join(store.paths.attemptDir(run.runId, 'a', 1), 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; text?: string });
    expect(attemptEvents.filter((e) => e.kind === 'thinking').map((e) => e.text)).toEqual(['Let me consider the options here.', 'Second thought.']);

    // The run-level log is the artefact people attach to tickets; a thought must never reach it.
    const runEvents = await fs.readFile(store.paths.eventsFile(run.runId), 'utf8');
    expect(runEvents).not.toContain('consider the options');
    expect(runEvents).not.toContain('thinking');

    // `cao logs` hides it without leaving a blank line behind, and `--thinking` shows it.
    const hidden = await captureCli(() => logsCommand([run.runId, 'a'], { repository: repo, color: 'never' }));
    expect(hidden.stdout).not.toContain('consider the options');
    expect(hidden.stdout).toContain('Working on a');
    expect(hidden.stdout.split(/\r?\n/).filter((l) => l.trim() === '')).toHaveLength(1); // only the trailing newline
    const shown = await captureCli(() => logsCommand([run.runId, 'a'], { repository: repo, color: 'never', thinking: true }));
    expect(shown.stdout).toContain('consider the options');
    expect(shown.stdout).toContain('Second thought.');
  }, 30_000);

  it('runs lifecycle hooks only when declared and passes env to workers', async () => {
    const repo = await tmpGitRepo('cao-e2e-hooks-');
    const marker = path.join(repo, 'hook.txt').replace(/\\/g, '/');
    const yaml = `
name: h
environment:
  MY_FLAG: from-workflow
hooks:
  beforeWorkflow: "node -e \\"require('fs').writeFileSync('${marker}','before')\\""
  afterTask: "node -e \\"require('fs').appendFileSync('${marker}','|'+process.env.CAO_TASK_ID)\\""
tasks:
  - id: a
    env:
      TASK_VAR: task-level
    prompt: p
`;
    const { result } = await execute(repo, yaml, fakeEnv(repo, { FAKE_CLAUDE_MODE: 'echo' }));
    expect(result.state).toBe('completed');
    expect(await fs.readFile(path.join(repo, 'hook.txt'), 'utf8')).toBe('before|a');
  }, 30_000);
});
