/**
 * `cao doctor`: the environment questions every "it does not work" report comes down to, answered in
 * one screen. Nothing here changes anything — it reads the same things the orchestrator reads when it
 * starts (Node, git, the agent CLIs, the run directory) and says what it found and what to do about it.
 *
 * Gathering the facts and judging them are separate on purpose: `gatherFacts` talks to the machine and
 * `evaluate` is a pure function of what it found, so the interesting states (no git, no agent, a stale
 * lock, a leftover worktree) are unit-testable without having to produce them.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import { detectClaude, type ClaudeDetection } from '../../runners/claude/detect.js';
import { detectCodex, type CodexDetection } from '../../runners/codex/detect.js';
import { Git } from '../../workspace/git.js';
import { createRunPaths, ORCHESTRATOR_DIR } from '../../persistence/paths.js';
import type { RunLock } from '../../persistence/run-store.js';
import type { WorkflowRun } from '../../types/run.js';
import { pathExists, readJsonIfExists, isInside } from '../../util/fs.js';
import { isProcessAlive } from '../../util/misc.js';
import { mark } from '../../util/marks.js';
import { glyph } from '../../util/glyphs.js';
import { packageInfo } from '../../util/package-info.js';
import { findStoreRoot } from '../util.js';

export interface DoctorOptions {
  repository?: string;
  json?: boolean;
}

/** The parts of the environment a test wants to speak for. */
export interface DoctorDeps {
  detectClaude: (command?: string) => Promise<ClaudeDetection>;
  detectCodex: (command?: string) => Promise<CodexDetection>;
  isProcessAlive: (pid: number) => boolean;
  nodeVersion: string;
  /** The `engines.node` range this build declares. */
  requiredNode: string;
  gitCommand: string;
  cwd: string;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it; only ever set on `warn` and `fail`. */
  hint?: string;
  /** The names behind a count, for the JSON output and the lines under a failing check. */
  items?: string[];
}

export interface AgentFacts {
  runner: 'claude' | 'codex';
  command: string;
  found: boolean;
  version?: string;
  error?: string;
}

export interface StaleLockFacts {
  runId: string;
  pid: number;
  heartbeatAt: string;
  file: string;
}

export interface OrphanWorktreeFacts {
  path: string;
  branch?: string;
  runId?: string;
  /** True when git no longer has the worktree registered, i.e. only the directory is left. */
  unregistered?: boolean;
}

export interface OrphanBranchFacts {
  branch: string;
  runId?: string;
}

export interface DoctorFacts {
  node: { version: string; required: string; satisfied?: boolean };
  git: { found: boolean; version?: string; worktrees: boolean; error?: string };
  agents: AgentFacts[];
  repositoryRoot: string;
  gitRoot?: string;
  /** The repository that owns `.orchestrator/runs`, when there is one. */
  storeRoot?: string;
  runs?: { total: number; active: string[] };
  staleLocks: StaleLockFacts[];
  orphanWorktrees: OrphanWorktreeFacts[];
  orphanBranches: OrphanBranchFacts[];
  exclude: { status: 'ignored' | 'missing' | 'unknown'; via?: 'exclude' | 'gitignore'; reason?: string };
}

/** git learnt `worktree` in 2.5; everything below that can still run workflows in the shared tree. */
const WORKTREE_SINCE = [2, 5, 0];

const EXCLUDE_PATTERN = `${ORCHESTRATOR_DIR}/`;

/** The branch prefix `execution.worktree.branchPrefix` defaults to, and what `orchestrator/*` means here. */
const DEFAULT_BRANCH_PREFIX = 'orchestrator/';

function compareVersions(have: number[], want: number[]): number {
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function parseVersion(text: string): number[] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/**
 * Whether the running Node satisfies `engines.node`. That field is `>=22` and is expected to stay a
 * single lower bound; a range this cannot read is reported as unknown rather than guessed at, because
 * telling a working installation that its Node is wrong is worse than saying nothing.
 */
export function satisfiesNode(version: string, range: string): boolean | undefined {
  const m = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  const have = parseVersion(version.replace(/^v/, ''));
  if (!m || !have) return undefined;
  return compareVersions(have, [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]) >= 0;
}

/**
 * Whether git is there and can do worktrees. `--version` answers the first half; the second is only
 * asked of a real repository, because `git worktree list` outside one fails for a reason that has
 * nothing to do with git's capabilities.
 */
async function probeGit(command: string, repositoryRoot: string | undefined): Promise<DoctorFacts['git']> {
  let version: string | undefined;
  try {
    const res = await execa(command, ['--version'], { windowsHide: true, timeout: 15_000, reject: false });
    if (res.exitCode !== 0) {
      return { found: false, worktrees: false, error: String(res.stderr || res.stdout || `exit ${res.exitCode}`) };
    }
    version = String(res.stdout ?? '').trim().replace(/^git version\s*/i, '');
  } catch (err) {
    return { found: false, worktrees: false, error: (err as Error).message };
  }
  const parsed = parseVersion(version);
  const newEnough = parsed ? compareVersions(parsed, WORKTREE_SINCE) >= 0 : true;
  if (!newEnough || !repositoryRoot) return { found: true, version, worktrees: newEnough };
  // The version says the subcommand exists; running it says this repository can use it — a `.git` file
  // pointing at a directory that is gone fails here while `git --version` is perfectly happy.
  const res = await execa(command, ['worktree', 'list', '--porcelain'], { cwd: repositoryRoot, windowsHide: true, timeout: 15_000, reject: false }).catch(() => null);
  return { found: true, version, worktrees: res?.exitCode === 0 };
}

async function readRuns(runsDir: string): Promise<WorkflowRun[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const runs: WorkflowRun[] = [];
  for (const name of names.sort()) {
    const run = await readJsonIfExists<WorkflowRun>(path.join(runsDir, name, 'workflow.json')).catch(() => null);
    if (run?.runId) runs.push(run);
  }
  return runs;
}

/** Everything `evaluate` judges, read from this machine. */
export async function gatherFacts(opts: DoctorOptions = {}, overrides: Partial<DoctorDeps> = {}): Promise<DoctorFacts> {
  const deps: DoctorDeps = {
    detectClaude,
    detectCodex,
    isProcessAlive,
    nodeVersion: process.versions.node,
    requiredNode: packageInfo().node ?? '',
    gitCommand: 'git',
    cwd: process.cwd(),
    ...overrides,
  };
  const start = path.resolve(opts.repository ?? deps.cwd);
  const storeRoot = await findStoreRoot(start).catch(() => undefined);
  const gitRoot = (await Git.topLevel(storeRoot ?? start, deps.gitCommand)) ?? undefined;
  const repositoryRoot = storeRoot ?? gitRoot ?? start;

  const facts: DoctorFacts = {
    node: { version: deps.nodeVersion, required: deps.requiredNode, satisfied: deps.requiredNode ? satisfiesNode(deps.nodeVersion, deps.requiredNode) : undefined },
    git: await probeGit(deps.gitCommand, gitRoot),
    agents: [],
    repositoryRoot,
    ...(gitRoot ? { gitRoot } : {}),
    ...(storeRoot ? { storeRoot } : {}),
    staleLocks: [],
    orphanWorktrees: [],
    orphanBranches: [],
    exclude: { status: 'unknown', reason: 'not a git repository' },
  };

  const claude = await deps.detectClaude();
  facts.agents.push({ runner: 'claude', command: claude.command, found: claude.found, ...(claude.version ? { version: claude.version } : {}), ...(claude.error ? { error: claude.error } : {}) });
  const codex = await deps.detectCodex();
  facts.agents.push({ runner: 'codex', command: codex.command, found: codex.found, ...(codex.version ? { version: codex.version } : {}), ...(codex.error ? { error: codex.error } : {}) });

  // Runs: which of them an orchestrator still owns, and which locks are left over from one that is gone.
  const runs = storeRoot ? await readRuns(createRunPaths(storeRoot).runsDir) : [];
  const active = new Set<string>();
  if (storeRoot) {
    const paths = createRunPaths(storeRoot);
    for (const run of runs) {
      const lock = await readJsonIfExists<RunLock>(paths.lockFile(run.runId)).catch(() => null);
      if (!lock || typeof lock.pid !== 'number') continue;
      if (deps.isProcessAlive(lock.pid)) active.add(run.runId);
      else facts.staleLocks.push({ runId: run.runId, pid: lock.pid, heartbeatAt: lock.heartbeatAt, file: paths.lockFile(run.runId) });
    }
    facts.runs = { total: runs.length, active: [...active] };
  }

  if (!gitRoot || !facts.git.found) return facts;
  const git = new Git(repositoryRoot, deps.gitCommand);

  // Worktrees and branches a finished run left behind. A run an orchestrator still owns is working in
  // its worktrees right now, so its leftovers are not leftovers.
  const registered = await git.worktreeList().catch(() => []);
  const claimed = new Map<string, { runId: string; branch?: string; active: boolean }>();
  for (const run of runs) {
    for (const state of Object.values(run.tasks ?? {})) {
      for (const attempt of state.attempts ?? []) {
        const ws = attempt.workspace;
        if (!ws || ws.kind !== 'worktree') continue;
        claimed.set(path.resolve(ws.path), { runId: run.runId, ...(ws.branch ? { branch: ws.branch } : {}), active: active.has(run.runId) });
      }
    }
  }
  const seen = new Set<string>();
  for (const [wtPath, owner] of claimed) {
    if (owner.active || seen.has(wtPath) || !(await pathExists(wtPath))) continue;
    seen.add(wtPath);
    const isRegistered = registered.some((w) => path.resolve(w.path) === wtPath);
    facts.orphanWorktrees.push({ path: wtPath, ...(owner.branch ? { branch: owner.branch } : {}), runId: owner.runId, ...(isRegistered ? {} : { unregistered: true }) });
  }
  // A worktree git still knows about inside `.orchestrator/` that no run claims: the run directory was
  // deleted, or the worktree outlived it. `cao clean` cannot find it either, so it has to be named here.
  const orchestratorDir = path.join(repositoryRoot, ORCHESTRATOR_DIR);
  for (const wt of registered) {
    const resolved = path.resolve(wt.path);
    if (seen.has(resolved) || claimed.has(resolved) || !isInside(orchestratorDir, resolved)) continue;
    seen.add(resolved);
    facts.orphanWorktrees.push({ path: resolved, ...(wt.branch ? { branch: wt.branch } : {}) });
  }

  const prefixes = new Set([DEFAULT_BRANCH_PREFIX, ...runs.map((r) => r.workflow?.execution?.worktree?.branchPrefix).filter((p): p is string => Boolean(p))]);
  const current = await git.currentBranch();
  const checkedOut = new Set(registered.map((w) => w.branch).filter(Boolean));
  const owners = new Map<string, { runId: string; active: boolean }>();
  for (const [, owner] of claimed) if (owner.branch) owners.set(owner.branch, { runId: owner.runId, active: owner.active });
  const branches = new Set<string>();
  for (const prefix of prefixes) {
    for (const branch of await git.listBranches(`${prefix.replace(/\/$/, '')}/*`)) branches.add(branch);
  }
  for (const branch of [...branches].sort()) {
    const owner = owners.get(branch);
    // Checked out somewhere means a worktree still holds it; that worktree is the thing to report.
    if (owner?.active || branch === current || checkedOut.has(branch)) continue;
    facts.orphanBranches.push({ branch, ...(owner ? { runId: owner.runId } : {}) });
  }

  // `.orchestrator/` is written into the working tree, so git has to be told to ignore it. The
  // orchestrator adds it to `.git/info/exclude` on the first run; a `.gitignore` entry is just as good.
  try {
    // The trailing slash matters: a `.orchestrator/` rule only matches a directory, and `check-ignore`
    // cannot tell that a path which does not exist yet is one. Asked with the slash, it can.
    if (await git.isIgnored(EXCLUDE_PATTERN)) {
      const commonDir = (await git.run(['rev-parse', '--git-common-dir'])).stdout;
      const excludeFile = path.resolve(repositoryRoot, commonDir, 'info', 'exclude');
      const existing = await fs.readFile(excludeFile, 'utf8').catch(() => '');
      facts.exclude = { status: 'ignored', via: existing.split(/\r?\n/).includes(EXCLUDE_PATTERN) ? 'exclude' : 'gitignore' };
    } else {
      facts.exclude = { status: 'missing' };
    }
  } catch (err) {
    facts.exclude = { status: 'unknown', reason: (err as Error).message };
  }
  return facts;
}

function agentHint(runner: 'claude' | 'codex'): string {
  return runner === 'claude'
    ? 'install Claude Code and check `claude --version`, or point CAO_CLAUDE_COMMAND at the binary'
    : 'install the Codex CLI and check `codex --version`, or point CAO_CODEX_COMMAND at the binary';
}

/** The checks, in the order they are printed. Pure: everything it needs is in `facts`. */
export function evaluate(facts: DoctorFacts): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const { version, required, satisfied } = facts.node;
  checks.push({
    id: 'node',
    label: 'Node.js',
    status: satisfied === false ? 'fail' : 'ok',
    detail: `v${version.replace(/^v/, '')}${required ? ` (requires ${required}${satisfied === undefined ? ', not compared' : ''})` : ''}`,
    ...(satisfied === false ? { hint: `upgrade Node to ${required}` } : {}),
  });

  checks.push(
    facts.git.found
      ? {
          id: 'git',
          label: 'git',
          status: facts.git.worktrees ? 'ok' : 'warn',
          detail: `${facts.git.version ?? 'installed'}${facts.git.worktrees ? ', worktrees supported' : ', worktrees unavailable here'}`,
          ...(facts.git.worktrees ? {} : { hint: 'upgrade git to 2.5 or newer, or set workspace: shared — worktree isolation needs `git worktree`' }),
        }
      : { id: 'git', label: 'git', status: 'fail' as const, detail: `not found${facts.git.error ? `: ${facts.git.error}` : ''}`, hint: 'install git and put it on PATH; without it there is no worktree isolation and no diff capture' },
  );

  // A missing agent CLI is only a warning while the other one is there — plenty of workflows use one
  // agent. With neither, nothing can run at all, so both checks fail and the command exits 1.
  const anyAgent = facts.agents.some((a) => a.found);
  for (const agent of facts.agents) {
    checks.push({
      id: `agent:${agent.runner}`,
      label: agent.runner,
      status: agent.found ? 'ok' : anyAgent ? 'warn' : 'fail',
      detail: agent.found ? `${agent.version ?? 'installed'}  (${agent.command})` : `not found  (${agent.command})${agent.error ? `: ${agent.error.split('\n')[0]}` : ''}`,
      ...(agent.found ? {} : { hint: agentHint(agent.runner) }),
    });
  }

  checks.push(
    facts.storeRoot
      ? {
          id: 'locks',
          label: 'run locks',
          status: facts.staleLocks.length ? 'warn' : 'ok',
          detail: facts.staleLocks.length
            ? `${facts.staleLocks.length} stale lock(s); the orchestrator that held them is gone`
            : `${facts.runs?.total ?? 0} run(s), ${facts.runs?.active.length ?? 0} owned by a live orchestrator`,
          ...(facts.staleLocks.length
            ? { items: facts.staleLocks.map((l) => `${l.runId}  pid ${l.pid}  last heartbeat ${l.heartbeatAt}`), hint: `resume the run, or delete ${facts.staleLocks[0]!.file}` }
            : {}),
        }
      : { id: 'locks', label: 'run locks', status: 'skip' as const, detail: `no ${ORCHESTRATOR_DIR}/runs directory at or above ${facts.repositoryRoot}` },
  );

  const worktreeStatus: CheckStatus = !facts.gitRoot || !facts.git.found ? 'skip' : facts.orphanWorktrees.length ? 'warn' : 'ok';
  checks.push({
    id: 'worktrees',
    label: 'worktrees',
    status: worktreeStatus,
    detail:
      worktreeStatus === 'skip'
        ? 'not a git repository'
        : facts.orphanWorktrees.length
          ? `${facts.orphanWorktrees.length} left over from a finished run`
          : 'none left over',
    ...(facts.orphanWorktrees.length
      ? {
          items: facts.orphanWorktrees.map((w) => `${w.path}${w.runId ? `  (run ${w.runId})` : '  (no run claims it)'}${w.unregistered ? '  [directory only, git has pruned it]' : ''}`),
          hint: orphanHint(facts.orphanWorktrees.map((w) => w.runId), '--all', 'git worktree remove'),
        }
      : {}),
  });

  const branchStatus: CheckStatus = !facts.gitRoot || !facts.git.found ? 'skip' : facts.orphanBranches.length ? 'warn' : 'ok';
  checks.push({
    id: 'branches',
    label: 'branches',
    status: branchStatus,
    detail:
      branchStatus === 'skip'
        ? 'not a git repository'
        : facts.orphanBranches.length
          ? `${facts.orphanBranches.length} ${DEFAULT_BRANCH_PREFIX}* branch(es) with no worktree`
          : `no ${DEFAULT_BRANCH_PREFIX}* branches left over`,
    ...(facts.orphanBranches.length
      ? { items: facts.orphanBranches.map((b) => `${b.branch}${b.runId ? `  (run ${b.runId})` : ''}`), hint: orphanHint(facts.orphanBranches.map((b) => b.runId), '--branches', 'git branch -D') }
      : {}),
  });

  checks.push({
    id: 'exclude',
    label: 'git ignore',
    status: facts.exclude.status === 'ignored' ? 'ok' : facts.exclude.status === 'missing' ? 'warn' : 'skip',
    detail:
      facts.exclude.status === 'ignored'
        ? `${EXCLUDE_PATTERN} is ignored (${facts.exclude.via === 'exclude' ? '.git/info/exclude' : '.gitignore'})`
        : facts.exclude.status === 'missing'
          ? `${EXCLUDE_PATTERN} is not ignored; run state would show up in git status`
          : `not checked: ${facts.exclude.reason ?? 'unknown'}`,
    ...(facts.exclude.status === 'missing'
      ? { hint: `add ${EXCLUDE_PATTERN} to .gitignore, or to .git/info/exclude — the next \`cao run\` does the latter for you` }
      : {}),
  });

  return checks;
}

/**
 * One `cao clean` line, naming the run when exactly one is responsible. `cao clean` works from a run
 * directory, so leftovers no run claims have to fall back to the git command that removes them by hand.
 */
function orphanHint(runIds: Array<string | undefined>, flags: string, byHand: string): string {
  const named = [...new Set(runIds.filter((id): id is string => Boolean(id)))];
  if (named.length === 1) return `cao clean ${named[0]} ${flags}`;
  if (named.length > 1) return `cao clean <run> ${flags} for each: ${named.join(', ')}`;
  return `no run directory claims them; remove them with \`${byHand}\``;
}

const STATUS_MARK: Record<CheckStatus, () => string> = {
  ok: () => mark('ok'),
  warn: () => mark('warn'),
  fail: () => mark('error'),
  // Never a glyph: a skipped check is not a verdict, and a dash is one column in every terminal.
  skip: () => '-',
};

export function renderChecks(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${STATUS_MARK[check.status]()} ${check.label.padEnd(width)}  ${check.detail}`);
    const indent = ' '.repeat(width + 4);
    if (check.status !== 'ok' && check.status !== 'skip') for (const item of check.items ?? []) lines.push(`${indent}${glyph('bullet')} ${item}`);
    if (check.hint) lines.push(`${indent}${glyph('arrow')} ${check.hint}`);
  }
  return lines.join('\n');
}

export async function doctorCommand(opts: DoctorOptions, overrides: Partial<DoctorDeps> = {}): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const facts = await gatherFacts(opts, overrides);
  const checks = evaluate(facts);
  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  if (opts.json) {
    out(JSON.stringify({ ok: failed.length === 0, cao: packageInfo().version, checks, facts }, null, 2));
    return failed.length ? 1 : 0;
  }
  out(`cao ${packageInfo().version}`);
  out(`Repository: ${facts.repositoryRoot}${facts.gitRoot ? '' : '  (not a git repository)'}`);
  out(`Run state:  ${facts.storeRoot ? path.join(facts.storeRoot, ORCHESTRATOR_DIR, 'runs') : 'none yet'}`);
  out('');
  out(renderChecks(checks));
  out('');
  out(
    failed.length
      ? `${mark('error')} ${failed.length} check(s) failed${warned.length ? `, ${warned.length} warning(s)` : ''}.`
      : warned.length
        ? `${mark('warn')} All required checks passed, ${warned.length} warning(s).`
        : `${mark('ok')} All checks passed.`,
  );
  return failed.length ? 1 : 0;
}
