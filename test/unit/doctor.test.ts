import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import {
  satisfiesNode,
  evaluate,
  renderChecks,
  gatherFacts,
  doctorCommand,
  type DoctorCheck,
  type DoctorDeps,
  type DoctorFacts,
} from '../../src/cli/commands/doctor.js';
import { createRunPaths } from '../../src/persistence/paths.js';
import { buildWorkflow, captureCli, gitAvailable, makeRun, tmpDir, tmpGitRepo } from '../helpers/index.js';
import { stripAnsi } from '../../src/cli/color.js';
import type { WorkflowRun } from '../../src/types/run.js';

const NL = String.fromCharCode(10);

const facts = (over: Partial<DoctorFacts> = {}): DoctorFacts => ({
  node: { version: '22.11.0', required: '>=22', satisfied: true },
  git: { found: true, version: '2.47.0', worktrees: true },
  agents: [
    { runner: 'claude', command: 'claude', found: true, version: '2.0.1' },
    { runner: 'codex', command: 'codex', found: true, version: '0.5.0' },
  ],
  repositoryRoot: '/repo',
  gitRoot: '/repo',
  storeRoot: '/repo',
  runs: { total: 2, active: [] },
  staleLocks: [],
  orphanWorktrees: [],
  orphanBranches: [],
  exclude: { status: 'ignored', via: 'exclude' },
  ...over,
});

const check = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check "${id}" in ${checks.map((c) => c.id).join(', ')}`);
  return found;
};

/** Detection stubs: nothing in these tests may reach a real `claude`, `codex` or PATH lookup. */
const stubDetect = (opts: { claude?: boolean; codex?: boolean } = {}): Partial<DoctorDeps> => ({
  detectClaude: async () => (opts.claude === false ? { command: 'claude', found: false, error: 'spawn claude ENOENT' } : { command: 'claude', found: true, version: '9.9.9 (Fake Claude)' }),
  detectCodex: async () => (opts.codex === false ? { command: 'codex', found: false, error: 'spawn codex ENOENT' } : { command: 'codex', found: true, version: 'codex-cli 0.1.0' }),
});

describe('engines.node comparison', () => {
  it('compares the running Node against a lower bound', () => {
    expect(satisfiesNode('22.11.0', '>=22')).toBe(true);
    expect(satisfiesNode('v24.0.1', '>= 22.0.0')).toBe(true);
    expect(satisfiesNode('20.19.0', '>=22')).toBe(false);
    expect(satisfiesNode('22.0.0', '>=22.1')).toBe(false);
  });

  it('says "unknown" rather than guessing at a range it cannot read', () => {
    expect(satisfiesNode('22.11.0', '^22 || ^24')).toBeUndefined();
    expect(satisfiesNode('not-a-version', '>=22')).toBeUndefined();
  });
});

describe('doctor checks', () => {
  it('passes on a healthy machine', () => {
    const checks = evaluate(facts());
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(check(checks, 'node').detail).toContain('requires >=22');
    expect(check(checks, 'agent:claude').detail).toContain('2.0.1');
  });

  it('fails an out-of-date Node and says what to upgrade to', () => {
    const checks = evaluate(facts({ node: { version: '20.19.0', required: '>=22', satisfied: false } }));
    expect(check(checks, 'node').status).toBe('fail');
    expect(check(checks, 'node').hint).toContain('>=22');
  });

  it('does not fail a Node it could not compare', () => {
    const checks = evaluate(facts({ node: { version: '22.11.0', required: '^22 || ^24', satisfied: undefined } }));
    expect(check(checks, 'node').status).toBe('ok');
    expect(check(checks, 'node').detail).toContain('not compared');
  });

  it('fails a missing git and warns when git cannot do worktrees', () => {
    const missing = evaluate(facts({ git: { found: false, worktrees: false, error: 'spawn git ENOENT' } }));
    expect(check(missing, 'git').status).toBe('fail');
    expect(check(missing, 'git').detail).toContain('spawn git ENOENT');
    expect(check(missing, 'git').hint).toContain('install git');

    const old = evaluate(facts({ git: { found: true, version: '2.3.0', worktrees: false } }));
    expect(check(old, 'git').status).toBe('warn');
    expect(check(old, 'git').hint).toContain('2.5');
  });

  it('warns for one missing agent CLI but fails when neither is there', () => {
    const one = evaluate(
      facts({ agents: [{ runner: 'claude', command: 'claude', found: true, version: '2.0.1' }, { runner: 'codex', command: 'codex', found: false, error: 'spawn codex ENOENT' }] }),
    );
    expect(check(one, 'agent:codex').status).toBe('warn');
    expect(check(one, 'agent:codex').hint).toContain('CAO_CODEX_COMMAND');

    const none = evaluate(
      facts({ agents: [{ runner: 'claude', command: 'claude', found: false, error: 'x' }, { runner: 'codex', command: 'codex', found: false, error: 'x' }] }),
    );
    expect(check(none, 'agent:claude').status).toBe('fail');
    expect(check(none, 'agent:codex').status).toBe('fail');
    expect(check(none, 'agent:claude').hint).toContain('CAO_CLAUDE_COMMAND');
  });

  it('warns about a stale lock and names the file to delete', () => {
    const checks = evaluate(
      facts({ staleLocks: [{ runId: '2026-01-01-001', pid: 4242, heartbeatAt: '2026-01-01T00:00:00.000Z', file: '/repo/.orchestrator/runs/2026-01-01-001/lock.json' }] }),
    );
    expect(check(checks, 'locks').status).toBe('warn');
    expect(check(checks, 'locks').items?.[0]).toContain('pid 4242');
    expect(check(checks, 'locks').hint).toContain('lock.json');
  });

  it('warns about leftover worktrees and branches with the cao clean line that removes them', () => {
    const checks = evaluate(
      facts({
        orphanWorktrees: [{ path: '/repo/.orchestrator/worktrees/build', branch: 'orchestrator/build', runId: '2026-01-01-001' }],
        orphanBranches: [{ branch: 'orchestrator/build', runId: '2026-01-01-001' }],
      }),
    );
    expect(check(checks, 'worktrees').status).toBe('warn');
    expect(check(checks, 'worktrees').hint).toBe('cao clean 2026-01-01-001 --all');
    expect(check(checks, 'branches').hint).toBe('cao clean 2026-01-01-001 --branches');
  });

  it('names every run when the leftovers come from more than one, and says so when none claims them', () => {
    const many = evaluate(facts({ orphanWorktrees: [{ path: '/a', runId: 'r1' }, { path: '/b', runId: 'r2' }] }));
    expect(check(many, 'worktrees').hint).toContain('r1, r2');

    const unclaimed = evaluate(facts({ orphanBranches: [{ branch: 'orchestrator/gone' }] }));
    expect(check(unclaimed, 'branches').hint).toContain('git branch -D');
    expect(check(evaluate(facts({ orphanWorktrees: [{ path: '/gone' }] })), 'worktrees').hint).toContain('git worktree remove');
  });

  it('warns when .orchestrator/ is not ignored by git', () => {
    const checks = evaluate(facts({ exclude: { status: 'missing' } }));
    expect(check(checks, 'exclude').status).toBe('warn');
    expect(check(checks, 'exclude').hint).toContain('.gitignore');
  });

  it('skips the repository checks outside a git repository and before the first run', () => {
    const checks = evaluate(facts({ gitRoot: undefined, storeRoot: undefined, runs: undefined, exclude: { status: 'unknown', reason: 'not a git repository' } }));
    for (const id of ['locks', 'worktrees', 'branches', 'exclude']) expect(check(checks, id).status).toBe('skip');
    expect(checks.some((c) => c.status === 'fail')).toBe(false);
  });
});

describe('doctor output', () => {
  it('prints one line per check and the fix hint under the ones that need it', () => {
    const lines = renderChecks(evaluate(facts({ git: { found: false, worktrees: false, error: 'spawn git ENOENT' } }))).split(NL);
    expect(lines.filter((l) => l.includes('Node.js'))).toHaveLength(1);
    const git = lines.findIndex((l) => l.includes('git ') && l.includes('not found'));
    expect(git).toBeGreaterThanOrEqual(0);
    expect(lines[git + 1]).toContain('install git');
    // A passing check never carries a hint.
    expect(lines.find((l) => l.includes('Node.js'))).not.toContain('upgrade');
  });

  it('lists the offenders under a failing check only', () => {
    const withItems = renderChecks(evaluate(facts({ orphanBranches: [{ branch: 'orchestrator/a' }, { branch: 'orchestrator/b' }] })));
    expect(withItems).toContain('orchestrator/a');
    expect(withItems).toContain('orchestrator/b');
    expect(renderChecks(evaluate(facts()))).not.toContain('orchestrator/a');
  });
});

const HAS_GIT = await gitAvailable('cao doctor suite');

/** A run directory holding one finished task whose attempt used `worktree` at `wtPath` on `branch`. */
async function writeRun(repo: string, runId: string, wtPath: string, branch: string): Promise<WorkflowRun> {
  const { workflow } = await buildWorkflow(`name: t${NL}tasks:${NL}  - id: build${NL}    prompt: p${NL}`, { repositoryRoot: repo, gitRoot: repo });
  const run = makeRun(workflow, runId);
  run.state = 'completed';
  run.tasks.build = {
    id: 'build',
    state: 'success',
    retryWindowStart: 1,
    attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: new Date().toISOString(), cwd: wtPath, workspace: { kind: 'worktree', path: wtPath, cwd: wtPath, branch } }],
  };
  const paths = createRunPaths(repo);
  await fs.mkdir(paths.runDir(runId), { recursive: true });
  await fs.writeFile(paths.workflowFile(runId), JSON.stringify(run, null, 2));
  await fs.writeFile(paths.latestFile, runId);
  return run;
}

describe.skipIf(!HAS_GIT)('gathering the facts', () => {
  it('reports the agent CLIs the detection functions found', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const found = await gatherFacts({ repository: repo }, stubDetect());
    expect(found.agents).toEqual([
      { runner: 'claude', command: 'claude', found: true, version: '9.9.9 (Fake Claude)' },
      { runner: 'codex', command: 'codex', found: true, version: 'codex-cli 0.1.0' },
    ]);

    const missing = await gatherFacts({ repository: repo }, stubDetect({ codex: false }));
    expect(missing.agents[1]).toMatchObject({ runner: 'codex', found: false, error: 'spawn codex ENOENT' });
    expect(missing.git).toMatchObject({ found: true, worktrees: true });
    expect(missing.gitRoot).toBe(repo);
  });

  it('finds a lock whose orchestrator process is gone, and leaves a live one alone', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const paths = createRunPaths(repo);
    await writeRun(repo, '2026-01-01-001', path.join(repo, '.orchestrator', 'worktrees', 'build'), 'orchestrator/build');
    await fs.writeFile(paths.lockFile('2026-01-01-001'), JSON.stringify({ pid: 4242, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z' }));

    const dead = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => false });
    expect(dead.staleLocks).toHaveLength(1);
    expect(dead.staleLocks[0]).toMatchObject({ runId: '2026-01-01-001', pid: 4242, file: paths.lockFile('2026-01-01-001') });

    const alive = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => true });
    expect(alive.staleLocks).toEqual([]);
    expect(alive.runs).toEqual({ total: 1, active: ['2026-01-01-001'] });
  });

  it('finds the worktree and branch a finished run left behind, and offers the cao clean line for them', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const wt = path.join(repo, '.orchestrator', 'worktrees', 'build');
    await execa('git', ['worktree', 'add', '-b', 'orchestrator/build', wt, 'HEAD'], { cwd: repo, windowsHide: true });
    await writeRun(repo, '2026-01-01-001', wt, 'orchestrator/build');

    const gathered = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => false });
    expect(gathered.orphanWorktrees).toEqual([{ path: wt, branch: 'orchestrator/build', runId: '2026-01-01-001' }]);
    // The branch is checked out in that worktree, so the worktree is the thing to act on, not the branch.
    expect(gathered.orphanBranches).toEqual([]);
    expect(check(evaluate(gathered), 'worktrees').hint).toBe('cao clean 2026-01-01-001 --all');

    await execa('git', ['worktree', 'remove', '--force', wt], { cwd: repo, windowsHide: true });
    const afterClean = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => false });
    expect(afterClean.orphanWorktrees).toEqual([]);
    expect(afterClean.orphanBranches).toEqual([{ branch: 'orchestrator/build', runId: '2026-01-01-001' }]);
  });

  it('reports an orchestrator/* branch no run directory claims', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    await execa('git', ['branch', 'orchestrator/left-over'], { cwd: repo, windowsHide: true });
    const gathered = await gatherFacts({ repository: repo }, stubDetect());
    expect(gathered.orphanBranches).toEqual([{ branch: 'orchestrator/left-over' }]);
    expect(check(evaluate(gathered), 'branches').hint).toContain('git branch -D');
  });

  it('never reports the branch that is checked out', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    await execa('git', ['checkout', '-q', '-b', 'orchestrator/current'], { cwd: repo, windowsHide: true });
    expect((await gatherFacts({ repository: repo }, stubDetect())).orphanBranches).toEqual([]);
  });

  it('says whether .orchestrator/ is ignored, and how', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    expect((await gatherFacts({ repository: repo }, stubDetect())).exclude).toEqual({ status: 'missing' });

    await fs.mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'info', 'exclude'), '.orchestrator/\n');
    expect((await gatherFacts({ repository: repo }, stubDetect())).exclude).toEqual({ status: 'ignored', via: 'exclude' });

    await fs.writeFile(path.join(repo, '.git', 'info', 'exclude'), '');
    await fs.writeFile(path.join(repo, '.gitignore'), '.orchestrator/\n');
    expect((await gatherFacts({ repository: repo }, stubDetect())).exclude).toEqual({ status: 'ignored', via: 'gitignore' });
  });

  it('works in a directory that is neither a repository nor has run anything', async () => {
    const dir = await tmpDir('cao-doctor-bare-');
    const gathered = await gatherFacts({ repository: dir }, stubDetect());
    expect(gathered.gitRoot).toBeUndefined();
    expect(gathered.storeRoot).toBeUndefined();
    expect(gathered.runs).toBeUndefined();
    // Outside a repository `git worktree list` cannot answer, and its failure is not git's fault.
    expect(gathered.git).toMatchObject({ found: true, worktrees: true });
  });
});

describe.skipIf(!HAS_GIT)('cao doctor', () => {
  it('exits 0 with a summary line when nothing failed', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const { code, stdout } = await captureCli(() => doctorCommand({ repository: repo }, stubDetect()));
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain(repo);
    expect(stripAnsi(stdout)).toMatch(/All (checks passed|required checks passed)/);
  });

  it('exits 1 when a check fails', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const { code, stdout } = await captureCli(() => doctorCommand({ repository: repo }, { ...stubDetect({ claude: false, codex: false }) }));
    expect(code).toBe(1);
    expect(stripAnsi(stdout)).toContain('check(s) failed');
  });

  it('--json carries every check and the facts behind them', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const { code, stdout } = await captureCli(() => doctorCommand({ repository: repo, json: true }, stubDetect()));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; cao: string; checks: DoctorCheck[]; facts: DoctorFacts };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((c) => c.id)).toEqual(['node', 'git', 'agent:claude', 'agent:codex', 'locks', 'worktrees', 'branches', 'exclude']);
    expect(parsed.facts.agents[0]).toMatchObject({ runner: 'claude', found: true });
    expect(parsed.cao).toMatch(/^\d+\.\d+\.\d+/);
  });
});
