import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import {
  satisfiesNode,
  detectTerminal,
  evaluate,
  renderChecks,
  gatherFacts,
  doctorCommand,
  type DoctorCheck,
  type DoctorDeps,
  type DoctorFacts,
  type TerminalFacts,
} from '../../src/cli/commands/doctor.js';
import { controlSupport } from '../../src/runners/controls.js';
import { codexAuthMode } from '../../src/runners/codex/auth.js';
import { codexSessionPresence } from '../../src/runners/codex/session-file.js';
import { colorLevel } from '../../src/cli/color.js';
import { controlRequest, writeControlRequest, writeAck, controlAck } from '../../src/persistence/requests.js';
import { type WorkflowRun } from 'code-agent-orchestrator-protocol';
import { createNativeRunPaths } from '../../src/persistence/paths.js';
import { buildWorkflow, captureCli, FAKE_CLAUDE, FAKE_CODEX, gitAvailable, makeRun, tmpDir, tmpGitRepo } from '../helpers/index.js';
import { ProcessManager } from '../../src/execution/process-manager.js';
import { probeCodexAppServer, probeCodexExec } from '../../src/runners/codex/probe.js';
import { probeClaudePromptMode } from '../../src/runners/claude/probe.js';
import { probeInstalledAgents } from '../../src/cli/commands/doctor.js';
import type { AgentProbe } from '../../src/runners/probe.js';
import { stripAnsi } from '../../src/cli/color.js';

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
  terminal: { platform: 'linux', tty: true, rawMode: true, columns: 120, rows: 40, unicode: true, colorLevel: 3, program: 'xterm-256color' },
  storage: { path: '/repo/.orchestrator', exists: true, writable: true, freeBytes: 40 * 1024 * 1024 * 1024, staleTemp: [] },
  protocol: { version: 1, futureRequests: [], rejected: [] },
  sessions: { runId: '2026-01-01-001', entries: [{ taskId: 'build', agent: 'claude', sessionId: 'abc', presence: 'present' }] },
  controls: [{ agent: 'claude', control: 'follow-up acknowledgment', supported: true, detail: '--replay-user-messages is advertised' }],
  auth: [{ agent: 'codex', mode: 'subscription' }],
  runState: { abandoned: [], unacked: [] },
  ...over,
});

const check = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check "${id}" in ${checks.map((c) => c.id).join(', ')}`);
  return found;
};

/**
 * Detection stubs: nothing in these tests may reach a real `claude`, `codex` or PATH lookup — including the
 * live probes, which would otherwise start whatever `claude`/`codex` happens to be on this machine's PATH.
 */
const TERMINAL: TerminalFacts = { platform: 'linux', tty: true, rawMode: true, columns: 120, rows: 40, unicode: true, colorLevel: 3, program: 'xterm-256color' };

const stubDetect = (opts: { claude?: boolean; codex?: boolean } = {}): Partial<DoctorDeps> => ({
  detectClaude: async () => (opts.claude === false ? { command: 'claude', found: false, error: 'spawn claude ENOENT' } : { command: 'claude', found: true, version: '9.9.9 (Fake Claude)' }),
  detectCodex: async () => (opts.codex === false ? { command: 'codex', found: false, error: 'spawn codex ENOENT' } : { command: 'codex', found: true, version: 'codex-cli 0.1.0' }),
  probeAgents: async () => [],
  // Nothing in these tests may read the machine's terminal, home directory or Codex login.
  readTerminal: () => TERMINAL,
  readAgentAuth: async (agents) => agents.map((agent) => ({ agent, mode: 'unknown' as const })),
  sessionPresence: async () => 'unknown',
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

  it('fails installed agents that are logged out or below the supported minimum', () => {
    const loggedOut = evaluate(facts({ agents: [
      { runner: 'claude', command: 'claude', found: true, version: '2.1.265', authenticated: true, supportedVersion: true, minimumVersion: '2.1.259' },
      { runner: 'codex', command: 'codex', found: true, version: '0.153.0', authenticated: false, supportedVersion: true, minimumVersion: '0.153.0', capabilities: ['exec'] },
    ] }));
    expect(check(loggedOut, 'agent:codex')).toMatchObject({ status: 'fail' });
    expect(check(loggedOut, 'agent:codex').detail).toContain('not authenticated');

    const old = evaluate(facts({ agents: [
      { runner: 'claude', command: 'claude', found: true, version: '2.0.1', authenticated: true, supportedVersion: false, minimumVersion: '2.1.259' },
      { runner: 'codex', command: 'codex', found: false },
    ] }));
    expect(check(old, 'agent:claude')).toMatchObject({ status: 'fail' });
    expect(check(old, 'agent:claude').hint).toContain('2.1.259');
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
  const paths = createNativeRunPaths(repo);
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

  /**
   * The live probes start each agent mode for real, which costs a small model call and up to a minute per
   * mode - so `cao doctor` does not start one unless it is asked to `[D32]`. The report still has to say
   * that it did not, rather than quietly leaving the probe rows out, and `--no-probe` has to keep parsing
   * and keep meaning "no probes" for everyone who already has it in a script.
   */
  it('starts no agent unless --probe asks for one, and says so instead of dropping the probe rows', async () => {
    const repo = await tmpGitRepo('cao-doctor-noprobe-');
    let started = 0;
    const deps = { ...stubDetect(), probeAgents: async () => { started++; return []; } };

    const notProbed = [
      { runner: 'claude', mode: 'live start', status: 'skip', detail: 'not probed (pass --probe)' },
      { runner: 'codex', mode: 'live start', status: 'skip', detail: 'not probed (pass --probe)' },
    ];
    // The default, and the deprecated flag that used to be the only way to get it: no child process at all.
    for (const opts of [{ repository: repo }, { repository: repo, probe: false }]) {
      const skipped = await gatherFacts(opts, deps);
      expect(started).toBe(0);
      expect(skipped.probes).toEqual(notProbed);
      const checks = evaluate(skipped);
      expect(check(checks, 'probe:claude:live start').status).toBe('skip');
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    }

    const probed = await gatherFacts({ repository: repo, probe: true }, deps);
    expect(started).toBe(1);
    expect(probed.probes).toBeUndefined(); // the stub found nothing to report
  });

  it('finds a lock whose orchestrator process is gone, and leaves a live one alone', async () => {
    const repo = await tmpGitRepo('cao-doctor-');
    const paths = createNativeRunPaths(repo);
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
    // The probe rows are there without a probe having run: they say so, rather than being left out [D32].
    // Additive: every id a reader already knew is still there, in the same order, and the §3.7 checks follow.
    expect(parsed.checks.map((c) => c.id)).toEqual([
      'node', 'git', 'agent:claude', 'agent:codex', 'probe:claude:live start', 'probe:codex:live start', 'locks', 'worktrees', 'branches', 'exclude',
      'terminal', 'storage', 'protocol', 'sessions', 'controls', 'quota', 'run-state',
    ]);
    expect(parsed.facts.terminal).toEqual(TERMINAL);
    expect(parsed.facts.protocol).toMatchObject({ version: 1, futureRequests: [], rejected: [] });
    expect(parsed.facts.agents[0]).toMatchObject({ runner: 'claude', found: true });
    expect(parsed.cao).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('scopes agent probes and capability checks to a supplied workflow', async () => {
    const repo = await tmpGitRepo('cao-doctor-scoped-');
    const config = path.join(repo, 'workflow.yaml');
    await fs.writeFile(config, `name: scoped\ncodex:\n  command: ${JSON.stringify(FAKE_CODEX)}\n  transport: appServer\n  approvals: host\ntasks:\n  - id: review\n    agent: codex\n    prompt: review\n`);
    const { code, stdout } = await captureCli(() => doctorCommand({ repository: repo, config, json: true, probe: true }));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { checks: DoctorCheck[]; facts: DoctorFacts };
    expect(parsed.facts.agents).toEqual([expect.objectContaining({ runner: 'codex', authenticated: true, requiredCapabilities: ['appServer'] })]);
    // Both transports were started for real; a green `cao doctor` now means more than "the binary exists".
    expect(parsed.facts.probes?.map((p) => `${p.mode}:${p.status}`)).toEqual(['codex.transport: exec:ok', 'codex.transport: appServer:ok']);
    expect(parsed.checks.filter((c) => c.id.startsWith('probe:'))).toHaveLength(2);
  });

  it('discovers the default workflow relative to --repository', async () => {
    const repo = await tmpGitRepo('cao-doctor-repository-');
    await fs.writeFile(path.join(repo, 'workflow.yaml'), `name: discovered\ncodex:\n  command: ${JSON.stringify(FAKE_CODEX)}\ntasks:\n  - id: review\n    agent: codex\n    prompt: review\n`);
    const { code, stdout } = await captureCli(() => doctorCommand({ repository: repo, json: true }));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { facts: DoctorFacts };
    expect(parsed.facts.agents).toEqual([expect.objectContaining({ runner: 'codex', authenticated: true, requiredCapabilities: ['exec', 'autoReview'] })]);
  });
});

/**
 * The live probes (H4.3). `cao doctor` used to answer "is the binary there", which is not the question a
 * run fails on; these start each mode a workflow can select and report whether it started.
 */
describe('agent probes', () => {
  const probe = (over: Partial<AgentProbe> = {}): AgentProbe => ({ runner: 'codex', mode: 'codex.transport: exec', status: 'ok', detail: 'started a turn', durationMs: 12, ...over });

  it('gives every probed mode its own actionable line', () => {
    const checks = evaluate(facts({ probes: [probe(), probe({ mode: 'codex.transport: appServer', status: 'fail', detail: 'initialize failed', hint: 'upgrade the Codex CLI' })] }));
    expect(check(checks, 'probe:codex:codex.transport: exec')).toMatchObject({ status: 'ok', detail: expect.stringContaining('started a turn') });
    expect(check(checks, 'probe:codex:codex.transport: appServer')).toMatchObject({ status: 'fail', hint: 'upgrade the Codex CLI' });
    // A failing probe is a failing check: `cao doctor` must not exit 0 on a transport that cannot start.
    expect(checks.filter((c) => c.status === 'fail').map((c) => c.id)).toContain('probe:codex:codex.transport: appServer');
  });

  it('adds nothing when nothing was probed', () => {
    expect(evaluate(facts()).some((c) => c.id.startsWith('probe:'))).toBe(false);
  });

  it('probes nothing for a CLI that is not installed, or one that is logged out', async () => {
    const probes = await probeInstalledAgents([
      { runner: 'claude', command: 'claude', found: false, error: 'spawn claude ENOENT' },
      { runner: 'codex', command: 'codex', found: true, authenticated: false },
    ]);
    expect(probes).toEqual([]);
  });

  it('starts a Codex exec turn against the CLI and says so', async () => {
    const pm = new ProcessManager();
    const result = await probeCodexExec({ command: FAKE_CODEX, processManager: pm, timeoutMs: 15_000 });
    expect(result).toMatchObject({ runner: 'codex', mode: 'codex.transport: exec', status: 'ok' });
    expect(pm.list()).toEqual([]);
  });

  it('reports a rejected output schema as the failing exec line, with the key behind it', async () => {
    const result = await probeCodexExec({ command: FAKE_CODEX, processManager: new ProcessManager(), timeoutMs: 15_000, env: { FAKE_CODEX_MODE: 'schema-rejected' } });
    expect(result).toMatchObject({ status: 'fail', detail: expect.stringContaining('--output-schema') });
    expect(result.hint).toContain("the completion contract's output schema");
  });

  it('takes the Codex app-server through initialize and thread/start, then interrupts it', async () => {
    const pm = new ProcessManager();
    const result = await probeCodexAppServer({ command: FAKE_CODEX, processManager: pm, timeoutMs: 15_000 });
    expect(result).toMatchObject({ status: 'ok', detail: expect.stringContaining('thread/start') });
    expect(pm.list()).toEqual([]);
  });

  it('starts both Claude prompt modes and leaves no process behind', async () => {
    const pm = new ProcessManager();
    for (const mode of ['ask', 'deny'] as const) {
      const result = await probeClaudePromptMode(mode, { command: FAKE_CLAUDE, processManager: pm, timeoutMs: 15_000 });
      expect(result, mode).toMatchObject({ runner: 'claude', mode: `claude.permissionPrompts: ${mode}`, status: 'ok' });
    }
    expect(pm.list()).toEqual([]);
  });

  it('reports a CLI that refuses the argv rather than blaming the session', async () => {
    const result = await probeClaudePromptMode('deny', { command: `${FAKE_CLAUDE} --definitely-not-a-flag`, processManager: new ProcessManager(), timeoutMs: 15_000 });
    expect(result).toMatchObject({ status: 'fail', detail: expect.stringContaining('--definitely-not-a-flag') });
  });
});

/**
 * The §3.7 checks. Every one of them grades something that is otherwise invisible - a control that quietly
 * falls back, a session that quietly starts over, a screen that quietly loses rows - so each row of the
 * table gets both of its grades here, judged from facts rather than from whatever this machine looks like.
 */
describe('doctor checks: the environment (S3)', () => {
  const terminal = (over: Partial<TerminalFacts> = {}): DoctorFacts => facts({ terminal: { ...TERMINAL, ...over } });

  it('passes a terminal that can draw the workspace', () => {
    const check_ = check(evaluate(terminal()), 'terminal');
    expect(check_.status).toBe('ok');
    expect(check_.detail).toBe('xterm-256color, 120x40, unicode, colour level 3');
    expect(check_.hint).toBeUndefined();
  });

  it('warns for each way a terminal cannot draw the workspace, and names the switch that helps', () => {
    const piped = check(evaluate(terminal({ tty: false, rawMode: false, colorLevel: 0 })), 'terminal');
    expect(piped.status).toBe('warn');
    expect(piped.items?.[0]).toContain('stdout is not a terminal');
    // Not a TTY subsumes raw mode: one line about the cause, not two about the symptom.
    expect(piped.items?.some((i) => i.includes('raw mode'))).toBe(false);

    const noKeys = check(evaluate(terminal({ rawMode: false })), 'terminal');
    expect(noKeys.status).toBe('warn');
    expect(noKeys.items?.[0]).toContain('raw mode is unavailable');

    const small = check(evaluate(terminal({ columns: 72, rows: 18 })), 'terminal');
    expect(small.items?.[0]).toContain('72x18');
    expect(small.hint).toContain('--no-alt-screen');

    const ascii = check(evaluate(terminal({ unicode: false })), 'terminal');
    expect(ascii.detail).toContain('ASCII');
    expect(ascii.hint).toContain('CAO_ASCII=1');

    const mono = check(evaluate(terminal({ colorLevel: 0 })), 'terminal');
    expect(mono.status).toBe('warn');
    expect(mono.items?.[0]).toContain('no colour');

    const console_ = check(evaluate(terminal({ platform: 'win32', program: undefined })), 'terminal');
    expect(console_.status).toBe('warn');
    expect(console_.hint).toContain('Windows Terminal');
    // A Windows console that did announce itself is not a warning.
    expect(check(evaluate(terminal({ platform: 'win32', program: 'Windows Terminal' })), 'terminal').status).toBe('ok');
  });

  it('fails a run directory it cannot write to and names the path', () => {
    const ok = check(evaluate(facts()), 'storage');
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain('is writable');

    const readOnly = check(evaluate(facts({ storage: { path: '/repo/.orchestrator', exists: true, writable: false, error: 'EACCES', staleTemp: [] } })), 'storage');
    expect(readOnly.status).toBe('fail');
    expect(readOnly.detail).toContain('/repo/.orchestrator');
    expect(readOnly.hint).toContain('grant write access to /repo/.orchestrator');
  });

  it('warns about a nearly full volume and about scratch directories older than a day', () => {
    const full = check(evaluate(facts({ storage: { path: '/repo/.orchestrator', exists: true, writable: true, freeBytes: 40 * 1024 * 1024, staleTemp: [] } })), 'storage');
    expect(full.status).toBe('warn');
    expect(full.detail).toContain('40 MB free');
    expect(full.detail).toContain('200 MB');
    expect(full.hint).toContain('free space on the volume holding /repo/.orchestrator');

    const leftovers = check(
      evaluate(
        facts({
          storage: {
            path: '/repo/.orchestrator',
            exists: true,
            writable: true,
            freeBytes: 40 * 1024 * 1024 * 1024,
            staleTemp: [{ path: '/repo/.orchestrator/tmp/2026-01-01-001', ageMs: 50 * 60 * 60 * 1000 }],
          },
        }),
      ),
      'storage',
    );
    expect(leftovers.status).toBe('warn');
    expect(leftovers.items?.[0]).toContain('/repo/.orchestrator/tmp/2026-01-01-001');
    expect(leftovers.hint).toContain('delete /repo/.orchestrator/tmp/2026-01-01-001');
  });

  it('fails a future-protocol request the live orchestrator will refuse, and warns about one nobody holds', () => {
    const clean = check(evaluate(facts()), 'protocol');
    expect(clean.status).toBe('ok');

    const live = check(
      evaluate(facts({ protocol: { version: 1, writer: 2, futureRequests: [{ runId: '2026-01-01-001', file: '01J-stop.json', protocol: 2, live: true }], rejected: [] } })),
      'protocol',
    );
    expect(live.status).toBe('fail');
    expect(live.items?.[0]).toContain('protocol 2');
    expect(live.hint).toContain('npm i -g code-agent-orchestrator@beta');

    const dead = check(
      evaluate(facts({ protocol: { version: 1, writer: 2, futureRequests: [{ runId: '2026-01-01-001', file: '01J-stop.json', protocol: 2, live: false }], rejected: [] } })),
      'protocol',
    );
    expect(dead.status).toBe('warn');
  });

  it('warns about rejected requests and about a run written by a newer cao', () => {
    const rejected = check(
      evaluate(facts({ protocol: { version: 1, futureRequests: [], rejected: [{ runId: '2026-01-01-001', file: '01J-stop.json', reason: 'not valid JSON' }] } })),
      'protocol',
    );
    expect(rejected.status).toBe('warn');
    expect(rejected.items?.[0]).toContain('not valid JSON');
    expect(rejected.hint).toBe('npm i -g code-agent-orchestrator@beta');

    const newer = check(evaluate(facts({ protocol: { version: 1, writer: 3, futureRequests: [], rejected: [] } })), 'protocol');
    expect(newer.status).toBe('warn');
    expect(newer.detail).toContain('written with protocol 3');
  });

  it('warns when a session a follow-up would continue is no longer on disk', () => {
    expect(check(evaluate(facts({ sessions: { entries: [] } })), 'sessions').status).toBe('skip');
    expect(check(evaluate(facts()), 'sessions').status).toBe('ok');

    const gone = facts({
      sessions: {
        runId: '2026-01-01-001',
        entries: [
          { taskId: 'build', agent: 'claude', sessionId: 'abc', presence: 'missing' },
          { taskId: 'review', agent: 'codex', sessionId: 'def', presence: 'present' },
        ],
      },
    });
    const check_ = check(evaluate(gone), 'sessions');
    expect(check_.status).toBe('warn');
    expect(check_.detail).toContain('1 of 2');
    expect(check_.items).toEqual(['build  claude  abc']);
    expect(check_.hint).toContain('--fresh-session');

    // "unknown" is never a verdict: a machine this cannot read is not evidence that the session is gone.
    const unknown = facts({ sessions: { runId: '2026-01-01-001', entries: [{ taskId: 'build', agent: 'claude', sessionId: 'abc', presence: 'unknown' }] } });
    expect(check(evaluate(unknown), 'sessions').status).toBe('ok');
  });

  it('warns about a control the installed CLI cannot carry, and names the upgrade', () => {
    expect(check(evaluate(facts({ controls: [] })), 'controls').status).toBe('skip');

    const supported = facts({
      controls: [
        { agent: 'claude', control: 'follow-up acknowledgment', supported: true, detail: '--replay-user-messages is advertised' },
        { agent: 'codex', control: 'steer a running turn', supported: true, detail: 'turn/steer, from 0.99.0' },
      ],
    });
    expect(check(evaluate(supported), 'controls').status).toBe('ok');

    const degraded = facts({
      controls: [
        { agent: 'claude', control: 'follow-up acknowledgment', supported: false, detail: 'not advertised', hint: 'npm i -g @anthropic-ai/claude-code@latest' },
        { agent: 'codex', control: 'quota reads', supported: true, detail: 'from 0.48.0' },
      ],
    });
    const check_ = check(evaluate(degraded), 'controls');
    expect(check_.status).toBe('warn');
    expect(check_.detail).toBe('1 of 2 control(s) fall back to something older');
    expect(check_.hint).toBe('npm i -g @anthropic-ai/claude-code@latest');
  });

  it('warns when the credential in force cannot read a quota, and says so with the login command', () => {
    expect(check(evaluate(facts({ auth: [] })), 'quota').status).toBe('skip');
    // Every mode unknown is still nothing to grade: it is "not readable", not "not working".
    expect(check(evaluate(facts({ auth: [{ agent: 'claude', mode: 'unknown' }] })), 'quota').status).toBe('skip');

    const seat = check(evaluate(facts({ auth: [{ agent: 'codex', mode: 'subscription' }] })), 'quota');
    expect(seat.status).toBe('ok');
    expect(seat.detail).toBe('codex subscription');

    const key = check(evaluate(facts({ auth: [{ agent: 'codex', mode: 'apiKey', quotaHint: '`codex login` to sign in with ChatGPT for quotas; an API key cannot read them' }] })), 'quota');
    expect(key.status).toBe('warn');
    expect(key.items?.[0]).toContain('API key');
    expect(key.hint).toContain('codex login');
  });

  it('calls a running run whose owner is gone abandoned, and offers the resume that picks it up', () => {
    expect(check(evaluate(facts()), 'run-state').status).toBe('ok');

    const dead = check(
      evaluate(facts({ runState: { abandoned: [{ runId: '2026-01-01-001', pid: 4242, heartbeatAt: '2026-01-01T00:00:00.000Z', source: 'lock', reason: 'dead' }], unacked: [] } })),
      'run-state',
    );
    expect(dead.status).toBe('warn');
    expect(dead.items?.[0]).toContain('abandoned: pid 4242 is gone');
    expect(dead.hint).toBe('cao resume 2026-01-01-001 to pick it up, or cao ui 2026-01-01-001 to look at it first');

    const silent = check(
      evaluate(facts({ runState: { abandoned: [{ runId: '2026-01-01-001', pid: 4242, heartbeatAt: '2026-01-01T00:00:00.000Z', source: 'live', reason: 'silent' }], unacked: [] } })),
      'run-state',
    );
    expect(silent.items?.[0]).toContain('has not beaten since 2026-01-01T00:00:00.000Z');
  });

  it('warns about a request nobody has answered in a minute', () => {
    const check_ = check(
      evaluate(facts({ runState: { abandoned: [], unacked: [{ runId: '2026-01-01-001', id: '01J', kind: 'stop', requestedAt: '2026-01-01T00:00:00.000Z', ageMs: 300_000 }] } })),
      'run-state',
    );
    expect(check_.status).toBe('warn');
    expect(check_.detail).toContain('1 request(s) unanswered');
    expect(check_.items?.[0]).toContain('stop');
    expect(check_.hint).toContain('cao ui 2026-01-01-001');
  });

  it('skips the run-state check where there is no run directory', () => {
    const bare = facts({ storeRoot: undefined, runs: undefined });
    expect(check(evaluate(bare), 'run-state').status).toBe('skip');
  });
});

/** The per-agent knowledge behind the `controls` and `quota` rows, which lives under `src/runners/`. */
describe('control and quota support', () => {
  it('reports the controls each CLI advertises, and the upgrade for the ones it does not', () => {
    const rows = controlSupport([
      { runner: 'claude', command: 'claude', found: true, version: '2.1.267', capabilities: ['streamJson'] },
      { runner: 'codex', command: 'codex', found: true, version: '0.153.0', capabilities: ['exec', 'appServer', 'steer'] },
    ]);
    expect(rows.map((r) => `${r.agent} ${r.control} ${String(r.supported)}`)).toEqual([
      'claude follow-up acknowledgment false',
      'codex steer a running turn true',
      'codex quota reads true',
    ]);
    expect(rows[0]!.hint).toBe('npm i -g @anthropic-ai/claude-code@latest');
    expect(rows[0]!.detail).toContain('--replay-user-messages');
  });

  it('names the two Codex version floors separately', () => {
    const rows = controlSupport([{ runner: 'codex', command: 'codex', found: true, version: '0.40.0', capabilities: ['exec'] }]);
    expect(rows.map((r) => r.supported)).toEqual([false, false]);
    expect(rows[0]!.detail).toContain('0.99.0');
    expect(rows[1]!.detail).toContain('0.48.0');
  });

  it('says nothing about a CLI that is not installed: its own line already did', () => {
    expect(controlSupport([{ runner: 'codex', command: 'codex', found: false }])).toEqual([]);
  });

  it('reads the Codex login mode from the files the CLI writes, never from a process', async () => {
    const home = await tmpDir('cao-codex-home-');
    expect(await codexAuthMode({ CODEX_HOME: home })).toBe('none');

    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'x' } }));
    expect(await codexAuthMode({ CODEX_HOME: home })).toBe('subscription');

    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
    expect(await codexAuthMode({ CODEX_HOME: home })).toBe('apiKey');

    // The environment wins, because it is what the next `codex` invocation will use.
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: 'x' } }));
    expect(await codexAuthMode({ CODEX_HOME: home, OPENAI_API_KEY: 'sk-env' })).toBe('apiKey');

    await fs.writeFile(path.join(home, 'auth.json'), 'not json');
    expect(await codexAuthMode({ CODEX_HOME: home })).toBe('unknown');
  });

  it('finds a Codex rollout that has been compressed since the thread ended', async () => {
    const home = await tmpDir('cao-codex-rollout-');
    const day = path.join(home, 'sessions', '2026', '01', '02');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, 'rollout-2026-01-02T10-00-00-thread-1.jsonl.gz'), '');
    expect(await codexSessionPresence('thread-1', home, { CODEX_HOME: home })).toBe('present');
    expect(await codexSessionPresence('thread-2', home, { CODEX_HOME: home })).toBe('missing');
  });
});

describe('terminal capability reading', () => {
  it('grades colour from what the terminal announced', () => {
    expect(colorLevel({ NO_COLOR: '1' }, true)).toBe(0);
    expect(colorLevel({ TERM: 'dumb' }, true)).toBe(0);
    expect(colorLevel({}, false)).toBe(0);
    expect(colorLevel({ FORCE_COLOR: '1' }, false)).toBe(1);
    expect(colorLevel({ COLORTERM: 'truecolor' }, true)).toBe(3);
    expect(colorLevel({ WT_SESSION: 'abc' }, true)).toBe(3);
    expect(colorLevel({ TERM: 'xterm-256color' }, true)).toBe(2);
    expect(colorLevel({ TERM: 'xterm' }, true)).toBe(1);
  });

  it('reads the size, the raw-mode capability and the name the terminal gave itself', () => {
    const found = detectTerminal(
      { TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor' },
      { isTTY: true, columns: 100, rows: 30 },
      { isTTY: true, setRawMode: () => undefined },
      'darwin',
    );
    expect(found).toMatchObject({ platform: 'darwin', tty: true, rawMode: true, columns: 100, rows: 30, colorLevel: 3, program: 'vscode' });

    const piped = detectTerminal({}, {}, {}, 'win32');
    expect(piped).toMatchObject({ tty: false, rawMode: false, colorLevel: 0 });
    expect(piped.program).toBeUndefined();
    expect(piped.columns).toBeUndefined();
  });
});

describe.skipIf(!HAS_GIT)('the environment checks against a real run directory', () => {
  /**
   * The integration half of the `run state` row: a run whose snapshot says `running` and whose owner pid is
   * gone. Nothing about the stored label decides this - the pid does, which is why the liveness test is the
   * injected one and not this machine's.
   */
  it('reports a run whose owner pid is dead as abandoned, with the resume that picks it up', async () => {
    const repo = await tmpGitRepo('cao-doctor-abandoned-');
    const paths = createNativeRunPaths(repo);
    const run = await writeRun(repo, '2026-01-01-001', path.join(repo, '.orchestrator', 'worktrees', 'build'), 'orchestrator/build');
    run.state = 'running';
    run.orchestratorPid = 4242;
    await fs.writeFile(paths.workflowFile(run.runId), JSON.stringify(run, null, 2));
    await fs.writeFile(paths.lockFile(run.runId), JSON.stringify({ pid: 4242, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z' }));

    const gathered = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => false });
    expect(gathered.runState.abandoned).toEqual([
      { runId: '2026-01-01-001', pid: 4242, heartbeatAt: '2026-01-01T00:00:00.000Z', source: 'lock', reason: 'dead' },
    ]);
    const check_ = check(evaluate(gathered), 'run-state');
    expect(check_.status).toBe('warn');
    expect(check_.items?.[0]).toContain('abandoned');
    expect(check_.hint).toContain('cao resume 2026-01-01-001');

    // A pid that is alive but has stopped beating is the other half of the rule, and is abandoned too.
    const hung = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => true });
    expect(hung.runState.abandoned).toEqual([
      { runId: '2026-01-01-001', pid: 4242, heartbeatAt: '2026-01-01T00:00:00.000Z', source: 'lock', reason: 'silent' },
    ]);

    // Alive and beating: not abandoned, however long the snapshot has said `running`.
    const now = Date.now();
    await fs.writeFile(paths.lockFile(run.runId), JSON.stringify({ pid: 4242, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: new Date(now).toISOString() }));
    const held = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => true, now });
    expect(held.runState.abandoned).toEqual([]);
  });

  it('reads the inbox without consuming it, and reports what is stuck in it', async () => {
    const repo = await tmpGitRepo('cao-doctor-inbox-');
    const paths = createNativeRunPaths(repo);
    await writeRun(repo, '2026-01-01-001', path.join(repo, '.orchestrator', 'worktrees', 'build'), 'orchestrator/build');
    await fs.mkdir(paths.requestsDir('2026-01-01-001'), { recursive: true });
    await fs.mkdir(paths.requestAcksDir('2026-01-01-001'), { recursive: true });
    await fs.mkdir(paths.requestRejectedDir('2026-01-01-001'), { recursive: true });

    const waiting = controlRequest('stop', { requestedAt: '2026-01-01T00:00:00.000Z' });
    const answered = controlRequest('stop', { requestedAt: '2026-01-01T00:00:00.000Z' });
    await writeControlRequest(paths, '2026-01-01-001', waiting);
    await writeControlRequest(paths, '2026-01-01-001', answered);
    await writeAck(paths, '2026-01-01-001', controlAck(answered.id, 'applied'));
    const future = { ...controlRequest('stop', { requestedAt: '2026-01-01T00:00:00.000Z' }), protocol: 9 };
    await fs.writeFile(path.join(paths.requestsDir('2026-01-01-001'), `${future.id}-stop.json`), JSON.stringify(future));
    await fs.writeFile(path.join(paths.requestRejectedDir('2026-01-01-001'), '01JREJECTED-stop.json'), JSON.stringify({ protocol: 1, id: '01JREJECTED', kind: 'stop' }));
    await fs.writeFile(path.join(paths.requestRejectedDir('2026-01-01-001'), '01JREJECTED-stop.json.reason.txt'), 'the file is not valid JSON\n');

    const gathered = await gatherFacts({ repository: repo }, { ...stubDetect(), isProcessAlive: () => false });
    expect(gathered.protocol).toMatchObject({ version: 1, writer: 9 });
    expect(gathered.protocol.futureRequests).toEqual([{ runId: '2026-01-01-001', file: `${future.id}-stop.json`, protocol: 9, live: false }]);
    expect(gathered.protocol.rejected).toEqual([{ runId: '2026-01-01-001', file: '01JREJECTED-stop.json', reason: 'the file is not valid JSON' }]);
    // The acked one is answered; the other two have been waiting since 2026 and nobody is reading them.
    expect(gathered.runState.unacked.map((r) => r.id).sort()).toEqual([future.id, waiting.id].sort());

    const protocolCheck_ = check(evaluate(gathered), 'protocol');
    expect(protocolCheck_.status).toBe('warn'); // nothing owns the run, so nothing is about to refuse it
    expect(protocolCheck_.hint).toBe('npm i -g code-agent-orchestrator@beta');

    // Read-only by definition: doctor must not move a request the way the owner's reader does.
    expect((await fs.readdir(paths.requestsDir('2026-01-01-001'))).filter((name) => name.endsWith('.json'))).toHaveLength(3);
  });

  it('reads the latest run session ids through the injected probe and warns about the ones that are gone', async () => {
    const repo = await tmpGitRepo('cao-doctor-sessions-');
    const paths = createNativeRunPaths(repo);
    const run = await writeRun(repo, '2026-01-01-001', repo, 'orchestrator/build');
    run.tasks.build!.attempts[0]!.sessionId = 'session-abc';
    await fs.writeFile(paths.workflowFile(run.runId), JSON.stringify(run, null, 2));

    const asked: string[] = [];
    const gathered = await gatherFacts({ repository: repo }, {
      ...stubDetect(),
      sessionPresence: async (_task, sessionId) => {
        asked.push(sessionId);
        return 'missing';
      },
    });
    expect(asked).toEqual(['session-abc']);
    expect(gathered.sessions).toEqual({ runId: '2026-01-01-001', entries: [{ taskId: 'build', agent: 'claude', sessionId: 'session-abc', presence: 'missing' }] });
    expect(check(evaluate(gathered), 'sessions').hint).toContain('--fresh-session');
  });

  it('finds the scratch directories a finished run left in .orchestrator/tmp', async () => {
    const repo = await tmpGitRepo('cao-doctor-storage-');
    const tmp = path.join(repo, '.orchestrator', 'tmp', '2026-01-01-001');
    await fs.mkdir(tmp, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(tmp, twoDaysAgo, twoDaysAgo);

    const gathered = await gatherFacts({ repository: repo }, stubDetect());
    expect(gathered.storage.exists).toBe(true);
    expect(gathered.storage.writable).toBe(true);
    expect(gathered.storage.staleTemp.map((t) => t.path)).toEqual([tmp]);
    expect(check(evaluate(gathered), 'storage').status).toBe('warn');

    // And it leaves nothing of its own behind: the probe file is removed in the same breath.
    expect((await fs.readdir(path.join(repo, '.orchestrator'))).filter((n) => n.startsWith('.cao-doctor-'))).toEqual([]);

    const fresh = new Date();
    await fs.utimes(tmp, fresh, fresh);
    expect((await gatherFacts({ repository: repo }, stubDetect())).storage.staleTemp).toEqual([]);
  });
});
