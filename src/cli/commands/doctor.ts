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
import { ORCHESTRATOR_DIR, PROTOCOL_VERSION, type ResolvedTask, type WorkflowRun } from 'code-agent-orchestrator-protocol';
import { createNativeRunPaths } from '../../persistence/paths.js';
import { FileRunStore, type RunLock } from '../../persistence/run-store.js';
import { readControlHistory, requestFileName } from '../../persistence/requests.js';
import { pathExists, readJsonIfExists, isInside } from '../../util/fs.js';
import { isProcessAlive } from '../../util/misc.js';
import { mark } from '../../util/marks.js';
import { glyph, useUnicode } from '../../util/glyphs.js';
import { packageInfo } from '../../util/package-info.js';
import { formatAgeMs } from '../../util/duration.js';
import { colorLevel } from '../color.js';
import { DEFAULT_WORKFLOW_FILES, findStoreRoot, readOrchestrator, HEARTBEAT_STALE_MS } from '../util.js';
import { resolveWorkflowPath } from '../util.js';
import type { AgentCapability, AgentRuntimeDetection } from '../../runners/capabilities.js';
import { controlSupport, type ControlSupport } from '../../runners/controls.js';
import { readAgentAuth, type AgentAuth } from '../../runners/auth.js';
import { detectSessionPresence, type SessionPresence, type SessionProbe } from '../../runners/sessions.js';
import { ProcessManager } from '../../execution/process-manager.js';
import { probeClaude } from '../../runners/claude/probe.js';
import { probeCodex } from '../../runners/codex/probe.js';
import type { AgentProbe } from '../../runners/probe.js';
import { detectRunnersForWorkflow, prepareWorkflow, requireValid, type RunnerDetection } from '../app.js';

export interface DoctorOptions {
  repository?: string;
  json?: boolean;
  config?: string;
  /**
   * Whether to start each agent mode for real. **Off unless it is exactly `true`** `[D32]`: the live probes
   * are the checks that catch what runs actually fail on, but one of them spends a small model call and they
   * take up to a minute per mode, and an ordinary `cao doctor` has to be free and fast. `--probe` opts in;
   * `--no-probe` is still accepted and still means no probes, which is now also the default.
   */
  probe?: boolean;
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
  /**
   * Start each mode of each installed agent, briefly, and say whether it started. Injectable because a test
   * of the *judging* must never spawn an agent CLI, and because a caller may want the cheap checks alone.
   */
  probeAgents: (agents: AgentFacts[], environment?: Record<string, string>) => Promise<AgentProbe[]>;
  /** What this terminal can do (§3.7). Injectable so a test does not have to be run from one. */
  readTerminal: () => TerminalFacts;
  /** Whether a session a task reported can still be resumed; the same probe the prompt path uses (`[D25]`). */
  sessionPresence: SessionProbe;
  /** How each installed agent is signed in, for the `quota` check. */
  readAgentAuth: (agents: readonly string[]) => Promise<AgentAuth[]>;
  /** The moment every age in the facts is measured from. */
  now: number;
}

/**
 * The default: every mode of every agent that is installed and authenticated. An agent that is missing has
 * already said so on its own line, and one that is logged out would fail every probe for a reason the
 * operator has been told; probing either would only add noise.
 */
export async function probeInstalledAgents(agents: AgentFacts[], environment?: Record<string, string>): Promise<AgentProbe[]> {
  const processManager = new ProcessManager({});
  const probes: AgentProbe[] = [];
  try {
    for (const agent of agents) {
      if (!agent.found || agent.authenticated === false) continue;
      const options = { command: agent.command, processManager, ...(environment ? { env: environment } : {}) };
      probes.push(...(agent.runner === 'claude' ? await probeClaude(options) : await probeCodex(options)));
    }
  } finally {
    // Belt and braces: every probe kills its own child, and nothing may outlive the command either way.
    await processManager.shutdown('force').catch(() => undefined);
  }
  return probes;
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

export interface AgentFacts extends AgentRuntimeDetection {
  runner: 'claude' | 'codex';
  requiredCapabilities?: AgentCapability[];
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

/** What the terminal `cao` was launched from can draw, and whether it can be typed into (§3.7). */
export interface TerminalFacts {
  platform: string;
  /** stdout is a terminal. Without one there is no workspace at all, only plain output. */
  tty: boolean;
  /** stdin can be put in raw mode, i.e. keys can be read one at a time. */
  rawMode: boolean;
  columns?: number;
  rows?: number;
  /** Whether glyphs will be drawn rather than the ASCII table (`useUnicode()`). */
  unicode: boolean;
  /** 0 none, 1 the sixteen ANSI colours, 2 256, 3 truecolor. */
  colorLevel: 0 | 1 | 2 | 3;
  /** What the terminal called itself. Absent on a console that announced nothing — a Windows console. */
  program?: string;
}

/** Whether run state can be written, and what an earlier run left in `.orchestrator/tmp/` (§3.7). */
export interface StorageFacts {
  /** The `.orchestrator` directory of this repository, whether or not it exists yet. */
  path: string;
  exists: boolean;
  writable: boolean;
  error?: string;
  /** Bytes available to this user on that volume, when the platform could say. */
  freeBytes?: number;
  /** `.orchestrator/tmp/<run>` scratch directories older than a day, with their age. */
  staleTemp: Array<{ path: string; ageMs: number }>;
}

export interface FutureRequestFacts {
  runId: string;
  /** The inbox file name, which is `<ULID>-<kind>.json`. */
  file: string;
  protocol: number;
  /** An orchestrator owns this run right now, so the request is one it is about to refuse. */
  live: boolean;
}

/** The versioned contract, as this repository's run directories were written with it (spec §4.5). */
export interface ProtocolFacts {
  /** What this build reads and writes. */
  version: number;
  /** The highest `protocol` any file in these runs carries; higher than `version` means a newer cao wrote it. */
  writer?: number;
  futureRequests: FutureRequestFacts[];
  rejected: Array<{ runId: string; file: string; reason?: string }>;
}

/** One task's resumable session, and whether the agent still has it (`[D25]`, §3.7). */
export interface SessionFactEntry {
  taskId: string;
  /** The agent's name, for the label only. */
  agent: string;
  sessionId: string;
  presence: SessionPresence;
}

export interface SessionFacts {
  /** The run these came from — the latest, because it is the one a follow-up would go to. */
  runId?: string;
  entries: SessionFactEntry[];
}

/** A run whose snapshot says `running` and whose owner is not (§3.7). */
export interface AbandonedRunFacts {
  runId: string;
  pid: number;
  heartbeatAt: string;
  /** Which file named the owner; `lock` is the truth whenever it is there. */
  source: 'lock' | 'live' | 'run';
  /** `dead`: no such process. `silent`: the process is there but has not beaten in a minute. */
  reason: 'dead' | 'silent';
}

export interface UnackedRequestFacts {
  runId: string;
  id: string;
  kind: string;
  requestedAt: string;
  ageMs: number;
}

export interface RunStateFacts {
  abandoned: AbandonedRunFacts[];
  unacked: UnackedRequestFacts[];
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
  /** One entry per agent mode that was started; absent when nothing could be probed. */
  probes?: AgentProbe[];
  terminal: TerminalFacts;
  storage: StorageFacts;
  protocol: ProtocolFacts;
  sessions: SessionFacts;
  /** What each installed CLI can carry of the workspace's controls; empty when none is installed. */
  controls: ControlSupport[];
  /** How each installed CLI is signed in; empty when none is installed. */
  auth: AgentAuth[];
  runState: RunStateFacts;
}

/** git learnt `worktree` in 2.5; everything below that can still run workflows in the shared tree. */
const WORKTREE_SINCE = [2, 5, 0];

const EXCLUDE_PATTERN = `${ORCHESTRATOR_DIR}/`;

/** The branch prefix `execution.worktree.branchPrefix` defaults to, and what `orchestrator/*` means here. */
const DEFAULT_BRANCH_PREFIX = 'orchestrator/';

/** The terminal the workspace is laid out for (§3.3). Below either number rows start being dropped. */
const MIN_COLUMNS = 80;
const MIN_ROWS = 24;

/** Under this much free space a run that captures diffs, transcripts and raw output will run out (§3.7). */
const MIN_FREE_BYTES = 200 * 1024 * 1024;

/** A `.orchestrator/tmp/<run>` scratch directory older than this outlived the run that made it. */
const TEMP_STALE_MS = 24 * 60 * 60 * 1000;

/** A request nobody has answered in this long is not being read by anybody (§2.3, §3.7). */
const UNACKED_STALE_MS = 60_000;

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
 * Whether the running Node satisfies `engines.node`. That field is `>=22.12.0` and is expected to stay a
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

/**
 * What this terminal can do, read once.
 *
 * `process.stdout.isTTY` and friends are the same values Ink sizes its frames from, so what this reports is
 * what the workspace would find. Injected in `DoctorDeps` because a vitest worker has no terminal at all and
 * would otherwise make every terminal assertion a test of the test runner.
 */
export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean; columns?: number; rows?: number } = process.stdout,
  stdin: { isTTY?: boolean; setRawMode?: unknown } = process.stdin,
  platform: string = process.platform,
): TerminalFacts {
  const tty = Boolean(stdout.isTTY);
  // In the order the terminal itself would be recognised elsewhere (`useUnicode`), most specific first.
  const program = env.WT_SESSION
    ? 'Windows Terminal'
    : env.TERM_PROGRAM || (env.ConEmuTask ? 'ConEmu' : undefined) || env.MSYSTEM || (env.WSLENV ? 'WSL' : undefined) || env.TERM || undefined;
  return {
    platform,
    tty,
    rawMode: Boolean(stdin.isTTY) && typeof stdin.setRawMode === 'function',
    ...(typeof stdout.columns === 'number' ? { columns: stdout.columns } : {}),
    ...(typeof stdout.rows === 'number' ? { rows: stdout.rows } : {}),
    unicode: useUnicode(),
    colorLevel: colorLevel(env, tty),
    ...(program ? { program } : {}),
  };
}

/**
 * Whether run state can be written, how much room is left for it, and what an earlier run left in `tmp/`.
 *
 * Writability is answered by writing: `fs.access(W_OK)` answers from the mode bits, which on Windows says
 * nothing about the ACL that actually refuses the write, and a read-only bind mount passes it too. The probe
 * file is removed in the same breath and is the only thing this command ever creates — it repairs nothing,
 * and in particular it does not create `.orchestrator/` itself, which is `cao run`'s to make.
 */
async function readStorage(repositoryRoot: string, now: number): Promise<StorageFacts> {
  const dir = path.join(repositoryRoot, ORCHESTRATOR_DIR);
  const exists = await pathExists(dir);
  const target = exists ? dir : repositoryRoot;
  const probe = path.join(target, `.cao-doctor-${process.pid}.tmp`);
  let writable = false;
  let error: string | undefined;
  try {
    await fs.writeFile(probe, '');
    writable = true;
  } catch (err) {
    error = (err as Error).message;
  } finally {
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
  let freeBytes: number | undefined;
  try {
    const stat = await fs.statfs(target);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // `statfs` is not on every platform Node runs on; not knowing is not a warning.
  }
  const staleTemp: StorageFacts['staleTemp'] = [];
  const tmp = path.join(dir, 'tmp');
  for (const entry of await fs.readdir(tmp).catch(() => [] as string[])) {
    const child = path.join(tmp, entry);
    const stat = await fs.stat(child).catch(() => null);
    if (!stat) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs > TEMP_STALE_MS) staleTemp.push({ path: child, ageMs });
  }
  return { path: dir, exists, writable, ...(error ? { error } : {}), ...(freeBytes !== undefined ? { freeBytes } : {}), staleTemp };
}

/** The `protocol` number on something parsed off disk, when it has one. */
function protocolOf(value: unknown): number | undefined {
  const protocol = (value as { protocol?: unknown } | null | undefined)?.protocol;
  return typeof protocol === 'number' ? protocol : undefined;
}

/** Everything `evaluate` judges, read from this machine. */
export async function gatherFacts(opts: DoctorOptions = {}, overrides: Partial<DoctorDeps> = {}, scopedAgents?: RunnerDetection[], environment?: Record<string, string>): Promise<DoctorFacts> {
  const deps: DoctorDeps = {
    detectClaude,
    detectCodex,
    isProcessAlive,
    nodeVersion: process.versions.node,
    requiredNode: packageInfo().node ?? '',
    gitCommand: 'git',
    cwd: process.cwd(),
    probeAgents: probeInstalledAgents,
    readTerminal: () => detectTerminal(),
    sessionPresence: detectSessionPresence(environment ? { ...process.env, ...environment } : process.env),
    readAgentAuth: (agents) => readAgentAuth(agents, environment ? { ...process.env, ...environment } : process.env),
    now: Date.now(),
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
    terminal: deps.readTerminal(),
    storage: await readStorage(repositoryRoot, deps.now),
    protocol: { version: PROTOCOL_VERSION, futureRequests: [], rejected: [] },
    sessions: { entries: [] },
    controls: [],
    auth: [],
    runState: { abandoned: [], unacked: [] },
  };

  const detected: RunnerDetection[] = scopedAgents ?? await Promise.all([
    deps.detectClaude().then((value) => ({ runner: 'claude' as const, ...value } as RunnerDetection)),
    deps.detectCodex().then((value) => ({ runner: 'codex' as const, ...value } as RunnerDetection)),
  ]);
  for (const agent of detected) {
    facts.agents.push({
      runner: agent.runner, command: agent.command, found: agent.found,
      ...(agent.version ? { version: agent.version } : {}), ...(agent.error ? { error: agent.error } : {}),
      ...(agent.authenticated !== undefined ? { authenticated: agent.authenticated } : {}),
      ...(agent.supportedVersion !== undefined ? { supportedVersion: agent.supportedVersion } : {}),
      ...(agent.minimumVersion ? { minimumVersion: agent.minimumVersion } : {}),
      ...(agent.capabilities ? { capabilities: agent.capabilities } : {}),
      ...(agent.requiredCapabilities ? { requiredCapabilities: agent.requiredCapabilities } : {}),
    });
  }

  // Each mode a workflow can select, started for real. This is the only check that runs an agent, and it
  // is the one that catches the failures users actually report: a flag combination the CLI refuses, an
  // output schema the API refuses, a transport this version does not have. It is also the only check that
  // costs anything, so `--probe` asks for it `[D32]`; without it the rows are still printed, saying they
  // were not run, rather than quietly leaving out the part of the report a reader is looking for.
  const probes = opts.probe === true
    ? await deps.probeAgents(facts.agents, environment).catch((err: unknown) => {
      return [{ runner: 'claude' as const, mode: 'live start', status: 'skip' as const, detail: `not probed: ${(err as Error).message}` }];
    })
    : facts.agents.filter((agent) => agent.found && agent.authenticated !== false).map((agent) => ({ runner: agent.runner, mode: 'live start', status: 'skip' as const, detail: 'not probed (pass --probe)' }));
  if (probes.length) facts.probes = probes;

  // Runs: which of them an orchestrator still owns, and which locks are left over from one that is gone.
  const runs = storeRoot ? await readRuns(createNativeRunPaths(storeRoot).runsDir) : [];
  const active = new Set<string>();
  if (storeRoot) {
    const paths = createNativeRunPaths(storeRoot);
    for (const run of runs) {
      const lock = await readJsonIfExists<RunLock>(paths.lockFile(run.runId)).catch(() => null);
      if (!lock || typeof lock.pid !== 'number') continue;
      if (deps.isProcessAlive(lock.pid)) active.add(run.runId);
      else facts.staleLocks.push({ runId: run.runId, pid: lock.pid, heartbeatAt: lock.heartbeatAt, file: paths.lockFile(run.runId) });
    }
    facts.runs = { total: runs.length, active: [...active] };

    // Who is actually at the wheel, and what the inbox is carrying. `readOrchestrator` is the one answer to
    // "is a process executing this run" — lock first, `live.json` with a fresh heartbeat as the fallback —
    // so `running` in the snapshot is only what makes a run worth asking about, never the answer itself.
    const store = new FileRunStore(storeRoot);
    for (const run of runs) {
      const owner = await readOrchestrator(store, run.runId, deps.isProcessAlive).catch(() => null);
      const pid = owner?.pid ?? run.orchestratorPid;
      const heartbeatAt = owner?.heartbeatAt ?? run.updatedAt;
      const dead = pid === undefined || !deps.isProcessAlive(pid);
      const age = deps.now - Date.parse(heartbeatAt ?? '');
      const silent = Number.isFinite(age) && age > HEARTBEAT_STALE_MS;
      const abandoned = run.state === 'running' && (dead || silent);
      if (abandoned) {
        facts.runState.abandoned.push({
          runId: run.runId,
          pid: pid ?? 0,
          heartbeatAt: heartbeatAt ?? 'never',
          source: owner?.source ?? 'run',
          reason: dead ? 'dead' : 'silent',
        });
      }

      // Read-only: `readControlHistory` never moves a request the way the owner's reader does, so opening
      // `cao doctor` on a live run cannot race the orchestrator for its own inbox.
      const history = await readControlHistory(paths, run.runId).catch(() => null);
      if (!history) continue;
      const answered = new Set(history.acks.map((ack) => ack.id));
      for (const request of history.pending) {
        const written = protocolOf(request);
        if (written !== undefined && written > PROTOCOL_VERSION) {
          facts.protocol.futureRequests.push({ runId: run.runId, file: requestFileName(request), protocol: written, live: owner?.alive === true });
        }
        const waited = deps.now - Date.parse(request.requestedAt ?? '');
        if (!answered.has(request.id) && Number.isFinite(waited) && waited > UNACKED_STALE_MS) {
          facts.runState.unacked.push({ runId: run.runId, id: request.id, kind: request.kind, requestedAt: request.requestedAt, ageMs: waited });
        }
      }
      for (const entry of history.rejected) {
        facts.protocol.rejected.push({ runId: run.runId, file: path.basename(entry.file), ...(entry.reason ? { reason: entry.reason } : {}) });
      }
      for (const value of [...history.pending, ...history.acks, ...history.rejected.map((entry) => entry.request)]) {
        const written = protocolOf(value);
        if (written !== undefined && (facts.protocol.writer === undefined || written > facts.protocol.writer)) facts.protocol.writer = written;
      }
    }

    // The sessions a follow-up would resume, which are the latest run's: `cao task prompt` with no run named
    // goes there, and a session the agent has deleted makes it start over instead `[D25]`.
    const latest = runs[runs.length - 1];
    if (latest) {
      facts.sessions.runId = latest.runId;
      const resolved = new Map<string, ResolvedTask>((latest.workflow?.tasks ?? []).map((task) => [task.id, task]));
      for (const [taskId, state] of Object.entries(latest.tasks ?? {})) {
        const task = resolved.get(taskId);
        if (!task) continue;
        const carrier = [...(state.attempts ?? [])].reverse().find((attempt) => attempt.sessionId);
        const sessionId = state.resumeSessionId ?? carrier?.sessionId;
        if (!sessionId) continue;
        const presence = await deps.sessionPresence(task, sessionId, carrier?.cwd ?? latest.repositoryRoot).catch((): SessionPresence => 'unknown');
        facts.sessions.entries.push({ taskId, agent: task.agent, sessionId, presence });
      }
    }
  }

  facts.controls = controlSupport(facts.agents);
  facts.auth = facts.agents.some((agent) => agent.found)
    ? await deps.readAgentAuth(facts.agents.filter((agent) => agent.found).map((agent) => agent.runner)).catch(() => [])
    : [];

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
    const unknownVersion = agent.found && Boolean(agent.minimumVersion) && agent.supportedVersion === undefined;
    const unsupported = agent.found && agent.supportedVersion === false;
    const loggedOut = agent.found && agent.authenticated === false;
    const missingCapabilities = (agent.requiredCapabilities ?? []).filter((capability) => !agent.capabilities?.includes(capability));
    const status: CheckStatus = unknownVersion || unsupported || loggedOut || missingCapabilities.length > 0 ? 'fail' : agent.found ? 'ok' : anyAgent ? 'warn' : 'fail';
    const detail = !agent.found
      ? `not found  (${agent.command})${agent.error ? `: ${agent.error.split('\n')[0]}` : ''}`
      : unknownVersion
        ? `could not verify ${agent.version ?? 'unknown version'} against minimum ${agent.minimumVersion}  (${agent.command})`
        : unsupported
        ? `${agent.version ?? 'installed'} is below supported minimum ${agent.minimumVersion ?? 'unknown'}  (${agent.command})`
        : loggedOut
          ? `${agent.version ?? 'installed'}, not authenticated  (${agent.command})`
          : missingCapabilities.length
            ? `${agent.version ?? 'installed'} is missing ${missingCapabilities.join(', ')}  (${agent.command})`
            : `${agent.version ?? 'installed'}${agent.capabilities?.length ? ` [${agent.capabilities.join(', ')}]` : ''}  (${agent.command})`;
    const hint = unknownVersion
      ? `upgrade ${agent.runner} or configure a CLI that reports a semantic version`
      : unsupported
      ? `upgrade ${agent.runner} to ${agent.minimumVersion} or newer`
      : loggedOut
        ? agent.runner === 'claude' ? 'authenticate with `claude auth login` or provide supported CI credentials' : 'authenticate with `codex login` or provide OPENAI_API_KEY/CODEX_API_KEY for CI'
        : missingCapabilities.length ? `upgrade ${agent.runner} or change the workflow transport/configuration` : !agent.found ? agentHint(agent.runner) : undefined;
    checks.push({
      id: `agent:${agent.runner}`,
      label: agent.runner,
      status,
      detail,
      ...(hint ? { hint } : {}),
    });
  }

  for (const probe of facts.probes ?? []) {
    checks.push({
      id: `probe:${probe.runner}:${probe.mode}`,
      label: `${probe.runner} ${probe.mode.replace(/^\w+\.\w+:\s*/, '')}`,
      status: probe.status,
      detail: `${probe.detail}${probe.durationMs !== undefined ? `  (${probe.durationMs}ms)` : ''}`,
      ...(probe.hint ? { hint: probe.hint } : {}),
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

  // The §3.7 checks, appended so that every id a `--json` reader already knows keeps its place. None of them
  // can stop a run on its own, so all but two grade at most `warn`: what they catch is a *silent* loss — a
  // control that quietly does nothing, a session that quietly starts over, a screen that quietly loses rows.
  checks.push(terminalCheck(facts.terminal));
  checks.push(storageCheck(facts.storage));
  checks.push(protocolCheck(facts.protocol));
  checks.push(sessionsCheck(facts.sessions));
  checks.push(controlsCheck(facts.controls));
  checks.push(quotaCheck(facts.auth));
  checks.push(runStateCheck(facts));

  return checks;
}

/** Whole megabytes; the threshold is 200 MB and nobody needs a third decimal of it. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Can this terminal draw the workspace, and can it be typed into?
 *
 * Every one of these is a warning and never a failure: `cao` runs headless perfectly well in all of them,
 * and the point of the check is that the degradation is otherwise invisible — nobody reports "the marks are
 * ASCII", they report that the output looks broken.
 */
function terminalCheck(terminal: TerminalFacts): DoctorCheck {
  const problems: string[] = [];
  const remedies: string[] = [];
  if (!terminal.tty) {
    problems.push('stdout is not a terminal, so the workspace cannot be drawn here');
    remedies.push('run cao from a terminal; piped and CI runs keep the plain output they have now');
  } else if (!terminal.rawMode) {
    problems.push('raw mode is unavailable, so keys cannot be read and the workspace would open read-only');
    remedies.push('run cao from a terminal that owns stdin');
  }
  if (terminal.tty && ((terminal.columns ?? MIN_COLUMNS) < MIN_COLUMNS || (terminal.rows ?? MIN_ROWS) < MIN_ROWS)) {
    problems.push(`the window is ${terminal.columns ?? '?'}x${terminal.rows ?? '?'}; the workspace is laid out for at least ${MIN_COLUMNS}x${MIN_ROWS}`);
    remedies.push('resize the window, or pass --no-alt-screen so the output scrolls in the normal buffer');
  }
  if (!terminal.unicode) {
    problems.push('unicode is not assumed here, so tables and status marks draw in ASCII');
    remedies.push('set CAO_UNICODE=1 if the glyphs do render, or CAO_ASCII=1 to keep the plain ones deliberately');
  }
  if (terminal.colorLevel === 0) {
    problems.push('no colour, so every state has to be told apart by its mark alone');
    remedies.push('unset NO_COLOR, or set FORCE_COLOR=1 when the output is piped somewhere that renders it');
  }
  if (terminal.platform === 'win32' && !terminal.program) {
    problems.push('this Windows console did not announce itself, so glyphs and colour are guessed conservatively');
    remedies.push('run in Windows Terminal');
  }
  const size = terminal.columns !== undefined && terminal.rows !== undefined ? `${terminal.columns}x${terminal.rows}` : 'unknown size';
  return {
    id: 'terminal',
    label: 'terminal',
    status: problems.length ? 'warn' : 'ok',
    detail: `${terminal.program ?? (terminal.tty ? 'terminal' : 'not a terminal')}, ${size}, ${terminal.unicode ? 'unicode' : 'ASCII'}, colour level ${terminal.colorLevel}`,
    ...(problems.length ? { items: problems, hint: remedies.join('; ') } : {}),
  };
}

/** Somewhere to write the run, and room to write it in. The only new check that can fail on its own. */
function storageCheck(storage: StorageFacts): DoctorCheck {
  const where = storage.exists ? storage.path : path.dirname(storage.path);
  if (!storage.writable) {
    return {
      id: 'storage',
      label: 'storage',
      status: 'fail',
      detail: `${where} is not writable${storage.error ? `: ${storage.error}` : ''}`,
      hint: `grant write access to ${where}; every run writes its state, logs and diffs there`,
    };
  }
  const problems: string[] = [];
  const remedies: string[] = [];
  const items: string[] = [];
  if (storage.freeBytes !== undefined && storage.freeBytes < MIN_FREE_BYTES) {
    problems.push(`${megabytes(storage.freeBytes)} free, under the ${megabytes(MIN_FREE_BYTES)} a run of any size needs`);
    remedies.push(`free space on the volume holding ${where}`);
  }
  if (storage.staleTemp.length) {
    problems.push(`${storage.staleTemp.length} scratch director(ies) in ${path.join(storage.path, 'tmp')} older than a day`);
    items.push(...storage.staleTemp.map((leftover) => `${leftover.path}  ${formatAgeMs(leftover.ageMs)} old`));
    remedies.push(`delete ${storage.staleTemp[0]!.path}${storage.staleTemp.length > 1 ? ' and the others listed above' : ''}`);
  }
  return {
    id: 'storage',
    label: 'storage',
    status: problems.length ? 'warn' : 'ok',
    detail: problems.length
      ? problems.join('; ')
      : `${where} is writable${storage.freeBytes !== undefined ? `, ${megabytes(storage.freeBytes)} free` : ''}`,
    ...(problems.length ? { ...(items.length ? { items } : {}), hint: remedies.join('; ') } : {}),
  };
}

/**
 * Whether these run directories were written by a `cao` this one can still read (§4.5).
 *
 * A future request in a run somebody is *executing* is the failing case, and it is the only one: the owner
 * will refuse that request, and the operator who sent it is waiting for something that is never going to
 * happen. Everywhere else a newer writer is a warning — the evidence is on disk and nothing is stuck on it.
 */
function protocolCheck(protocol: ProtocolFacts): DoctorCheck {
  const upgrade = 'npm i -g code-agent-orchestrator@beta';
  const live = protocol.futureRequests.filter((request) => request.live);
  if (live.length) {
    return {
      id: 'protocol',
      label: 'protocol',
      status: 'fail',
      detail: `${live.length} request(s) waiting in a live run were written for a protocol newer than ${protocol.version}`,
      items: live.map((request) => `${request.runId}  ${request.file}  protocol ${request.protocol}`),
      hint: `${upgrade} — the orchestrator holding that run will refuse these rather than act on them`,
    };
  }
  const problems: string[] = [];
  const items: string[] = [];
  // The remediation follows the problem, not the check. A newer writer is fixed by upgrading; a file in
  // `rejected/` is a request *this* cao already refused, and upgrading would not unrefuse it — the reason
  // is in the sidecar next to it, and deleting the pair is what clears the warning.
  const hints: string[] = [];
  if (protocol.futureRequests.length) {
    problems.push(`${protocol.futureRequests.length} request(s) written for a protocol newer than ${protocol.version}`);
    items.push(...protocol.futureRequests.map((request) => `${request.runId}  ${request.file}  protocol ${request.protocol}`));
    hints.push(upgrade);
  }
  if (protocol.rejected.length) {
    problems.push(`${protocol.rejected.length} request(s) in requests/rejected/`);
    items.push(...protocol.rejected.map((request) => `${request.runId}  ${request.file}${request.reason ? `  ${request.reason}` : ''}`));
    hints.push(
      'read <file>.reason.txt beside each one in .orchestrator/runs/<run>/requests/rejected/, then delete the pair; nothing is waiting on them and upgrading will not un-refuse them',
    );
  }
  if (protocol.writer !== undefined && protocol.writer > protocol.version && !protocol.futureRequests.length) {
    problems.push(`these runs were written with protocol ${protocol.writer}, and this cao understands ${protocol.version}`);
    if (!hints.includes(upgrade)) hints.push(upgrade);
  }
  return {
    id: 'protocol',
    label: 'protocol',
    status: problems.length ? 'warn' : 'ok',
    detail: problems.length ? problems.join('; ') : `protocol ${protocol.version}, and nothing on disk was written for a newer one`,
    ...(problems.length ? { ...(items.length ? { items } : {}), ...(hints.length ? { hint: hints.join('; ') } : {}) } : {}),
  };
}

/** Are the sessions a follow-up would continue still on disk? A missing one silently starts over `[D25]`. */
function sessionsCheck(sessions: SessionFacts): DoctorCheck {
  if (!sessions.entries.length) {
    return {
      id: 'sessions',
      label: 'sessions',
      status: 'skip',
      detail: sessions.runId ? `run ${sessions.runId} reported no resumable session` : 'no run to resume',
    };
  }
  const missing = sessions.entries.filter((entry) => entry.presence === 'missing');
  return {
    id: 'sessions',
    label: 'sessions',
    status: missing.length ? 'warn' : 'ok',
    detail: missing.length
      ? `${missing.length} of ${sessions.entries.length} session(s) of run ${sessions.runId} are no longer on disk`
      : `${sessions.entries.length} session(s) of run ${sessions.runId} can still be resumed`,
    ...(missing.length
      ? {
          items: missing.map((entry) => `${entry.taskId}  ${entry.agent}  ${entry.sessionId}`),
          hint: 'a follow-up to these would start a fresh session rather than continue one; send it with --fresh-session to say so deliberately',
        }
      : {}),
  };
}

/** Which of the workspace's controls the installed CLIs can actually carry (§3.7). */
function controlsCheck(controls: ControlSupport[]): DoctorCheck {
  if (!controls.length) return { id: 'controls', label: 'controls', status: 'skip', detail: 'no agent CLI to ask' };
  const degraded = controls.filter((control) => control.supported === false);
  const hints = [...new Set(degraded.map((control) => control.hint).filter((hint): hint is string => Boolean(hint)))];
  return {
    id: 'controls',
    label: 'controls',
    status: degraded.length ? 'warn' : 'ok',
    detail: degraded.length
      ? `${degraded.length} of ${controls.length} control(s) fall back to something older`
      : controls.map((control) => `${control.agent} ${control.control}`).join(', '),
    ...(degraded.length
      ? { items: degraded.map((control) => `${control.agent} ${control.control}: ${control.detail}`), hint: hints.join('; ') }
      : {}),
  };
}

/** Whether the credential in force can read a quota at all (§3.6, `[D29]`). */
function quotaCheck(auth: AgentAuth[]): DoctorCheck {
  const known = auth.filter((entry) => entry.mode !== 'unknown');
  if (!known.length) return { id: 'quota', label: 'quota', status: 'skip', detail: 'no provider reports a login mode this can read' };
  const refused = known.filter((entry) => entry.quotaHint);
  return {
    id: 'quota',
    label: 'quota',
    status: refused.length ? 'warn' : 'ok',
    detail: known.map((entry) => `${entry.agent} ${entry.mode}`).join(', '),
    ...(refused.length
      ? {
          items: refused.map((entry) => `${entry.agent} is authenticated with an API key, and quota reads are refused for one`),
          hint: refused[0]!.quotaHint!,
        }
      : {}),
  };
}

/**
 * Runs that say they are executing and are not, and requests nobody is answering.
 *
 * "Abandoned" is decided from the owner's identity, its pid and its heartbeat — never from the `running`
 * label, which is only what makes a run worth asking about. The snapshot is written before the process that
 * wrote it can crash, and a crashed run reads as `running` for ever.
 */
function runStateCheck(facts: DoctorFacts): DoctorCheck {
  if (!facts.storeRoot) {
    return { id: 'run-state', label: 'run state', status: 'skip', detail: `no ${ORCHESTRATOR_DIR}/runs directory at or above ${facts.repositoryRoot}` };
  }
  const { abandoned, unacked } = facts.runState;
  const problems: string[] = [];
  const items: string[] = [];
  if (abandoned.length) {
    problems.push(`${abandoned.length} run(s) marked running are abandoned`);
    items.push(
      ...abandoned.map(
        (run) => `${run.runId}  abandoned: pid ${run.pid} ${run.reason === 'dead' ? 'is gone' : `is alive but has not beaten since ${run.heartbeatAt}`}  (${run.source})`,
      ),
    );
  }
  if (unacked.length) {
    problems.push(`${unacked.length} request(s) unanswered for over a minute`);
    items.push(...unacked.map((request) => `${request.runId}  ${request.kind}  ${request.id}  waiting ${formatAgeMs(request.ageMs)}`));
  }
  const resumable = abandoned[0]?.runId;
  return {
    id: 'run-state',
    label: 'run state',
    status: problems.length ? 'warn' : 'ok',
    detail: problems.length ? problems.join('; ') : `${facts.runs?.active.length ?? 0} run(s) executing, and nothing waiting on an answer`,
    ...(problems.length
      ? {
          items,
          hint: resumable
            ? `cao resume ${resumable} to pick it up, or cao ui ${resumable} to look at it first`
            : `cao ui ${unacked[0]!.runId} — nothing is executing that run, so nothing is reading its inbox`,
        }
      : {}),
  };
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
  let scopedAgents: RunnerDetection[] | undefined;
  let environment: Record<string, string> | undefined;
  let workflowPath = opts.config;
  if (!workflowPath) {
    for (const name of DEFAULT_WORKFLOW_FILES) {
      const candidate = path.join(path.resolve(opts.repository ?? process.cwd()), name);
      if (await pathExists(candidate)) { workflowPath = candidate; break; }
    }
  }
  if (workflowPath) {
    const prepared = await prepareWorkflow(await resolveWorkflowPath(workflowPath), { repository: opts.repository });
    requireValid(prepared);
    scopedAgents = await detectRunnersForWorkflow(prepared.workflow, prepared.loaded.environment);
    environment = prepared.loaded.environment;
  }
  const facts = await gatherFacts(opts, overrides, scopedAgents, environment);
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
