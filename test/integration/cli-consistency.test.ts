/**
 * The CLI consistency pass, driven the way a user drives it: one real run against the fake Claude, then the
 * read-only commands over its run directory.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa, type Options } from 'execa';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { captureCli, FAKE_CLAUDE, tmpDir, tmpGitRepo, waitFor } from '../helpers/index.js';
import { pathExists } from '../../src/util/fs.js';
import { findActiveRun, readOrchestrator } from '../../src/cli/util.js';
import { nowIso } from '../../src/util/misc.js';
import { type WorkflowRun } from 'code-agent-orchestrator-protocol';
import { createNativeRunPaths } from '../../src/persistence/paths.js';
import { clearStopRequest, readStopRequest, requestStop, watchStopRequests } from '../../src/execution/signals.js';
import { listCommand } from '../../src/cli/commands/list.js';
import { logsCommand } from '../../src/cli/commands/logs.js';
import { peekCommand } from '../../src/cli/commands/peek.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { stopCommand } from '../../src/cli/commands/stop.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import { taskControlCommand } from '../../src/cli/commands/task-control.js';
import { taskEditCommand } from '../../src/cli/commands/task-edit.js';
import { diffCommand } from '../../src/cli/commands/diff.js';
import { emitCommand } from '../../src/cli/commands/emit.js';
import { entryFile, registryKey } from '../../src/persistence/registry.js';
import { controlRequest, readAck, writeControlRequest } from '../../src/persistence/requests.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';

const NL = String.fromCharCode(10);

/** `waitFor` takes a synchronous predicate; waiting on another process means waiting on the filesystem. */
async function until(cond: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const YAML = ['name: consistency', 'tasks:', '  - id: implement-api', '    prompt: p', '  - id: implement-ui', '    prompt: p'].join(NL) + NL;

/** Two tasks in one layer, so one can be cancelled and restarted while the other keeps the run alive. */
const PAIR = ['name: pair', 'execution:', '  maxConcurrency: 2', 'tasks:', '  - id: a', '    parallelGroup: g', '    onFailure: continue', '    prompt: p', '  - id: b', '    parallelGroup: g', '    prompt: p'].join(NL) + NL;

async function writeWorkflow(repo: string, yaml = YAML): Promise<string> {
  const file = path.join(repo, 'workflow.yaml');
  await fs.writeFile(file, yaml);
  return file;
}

async function execute(repo: string): Promise<{ run: WorkflowRun; store: FileRunStore }> {
  const configPath = await writeWorkflow(repo);
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
  const runtime = createRuntime({ run, environment: {}, secrets: [], logger: silentLogger });
  await runtime.scheduler.execute();
  return { run, store };
}

describe('CLI consistency', () => {
  beforeAll(() => clearDetectionCache());

  it('resolves tasks by prefix, prints JSON Lines and shows where the run lives', async () => {
    const repo = await tmpGitRepo('cao-cli-');
    const { run } = await execute(repo);

    // a unique prefix names a task, exactly as a unique prefix names a run
    const byPrefix = await captureCli(() => taskCommand(['implement-a'], { repository: repo }));
    expect(byPrefix.code).toBe(0);
    expect(byPrefix.stdout).toContain('Task: implement-api');
    // an ambiguous one is refused with the candidates, and both mistakes exit 2
    await expect(taskCommand(['implement'], { repository: repo })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    await expect(taskCommand(['implement'], { repository: repo })).rejects.toThrow(/implement-api, implement-ui/);
    // `cao task` with no reference is a usage error that lists what it could have been
    await expect(taskCommand([], { repository: repo })).rejects.toThrow(/task id is required.*Tasks in run .*implement-api/s);
    await expect(taskCommand([], { repository: repo })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));

    // cao logs --json: entries only, one JSON object per line, no prose header
    const logs = await captureCli(() => logsCommand([run.runId, 'implement-a'], { repository: repo, json: true }));
    const entries = logs.stdout.trim().split(NL).map((l) => JSON.parse(l) as { kind: string });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => typeof e.kind === 'string')).toBe(true);
    expect(logs.stdout.startsWith('#')).toBe(false);
    expect(entries.some((e) => e.kind === 'thinking')).toBe(false);

    // cao peek --json: the status object first, then the same entries
    const peek = await captureCli(() => peekCommand(['implement-api'], { repository: repo, json: true }));
    const peeked = peek.stdout.trim().split(NL).map((l) => JSON.parse(l) as { kind: string; taskId?: string; state?: string });
    expect(peeked[0]).toMatchObject({ kind: 'peek', taskId: 'implement-api', state: 'success' });
    expect(peeked.length).toBeGreaterThan(1);

    // cao status names the orchestrator and the directory holding everything above
    const status = await captureCli(() => statusCommand(undefined, { repository: repo }));
    expect(status.stdout).toContain(`Directory:    ${path.join(repo, '.orchestrator', 'runs', run.runId)}`);
    expect(status.stdout).toContain('Orchestrator: not running');
    expect(status.stdout).toMatch(/Started: {6}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}\(\d+[smhd] ago\)/);

    // cao list is newest first, with the age beside the local timestamp
    const list = await captureCli(() => listCommand({ repository: repo }));
    expect(list.stdout).toMatch(/Run.*Created *Age *Repository/);
    expect(list.stdout).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} +\d+[smhd] ago/);
  }, 60_000);

  it('exits 2 for a run that does not exist and for a repository with no runs', async () => {
    const empty = await tmpDir('cao-empty-');
    await fs.mkdir(path.join(empty, '.orchestrator', 'runs'), { recursive: true });
    await expect(statusCommand(undefined, { repository: empty })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    await expect(statusCommand(undefined, { repository: empty })).rejects.toThrow(/No runs found/);

    const repo = await tmpGitRepo('cao-cli-missing-');
    await execute(repo);
    await expect(statusCommand('2020-01-01-999', { repository: repo })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    await expect(statusCommand('2020-01-01-999', { repository: repo })).rejects.toThrow(/not found/);
  }, 60_000);

  it('refuses to start a second run while another orchestrator owns one in the same repository', async () => {
    const repo = await tmpGitRepo('cao-cli-lock-');
    const configPath = await writeWorkflow(repo);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    const store = new FileRunStore(repo);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
    run.state = 'running';
    await store.saveRun(run);
    // a live process (this test's parent) holding a fresh lock: the situation `cao run` used to ignore
    await fs.writeFile(store.paths.lockFile(run.runId), JSON.stringify({ pid: process.ppid, startedAt: nowIso(), heartbeatAt: nowIso() }));

    const started = await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false })).catch((err: Error) => err);
    expect(started).toBeInstanceOf(Error);
    expect((started as Error).message).toMatch(new RegExp(`Run ${run.runId} is already running`));
    expect(started).toMatchObject({ exitCode: 2 });
    // nothing was created: the second run never got an id
    expect((await store.listRuns()).map((r) => r.runId)).toEqual([run.runId]);
  }, 60_000);

  it('names the file when a run directory is unreadable, instead of leaking a JSON parser message', async () => {
    const repo = await tmpGitRepo('cao-cli-corrupt-');
    const { run, store } = await execute(repo);
    await fs.writeFile(store.paths.workflowFile(run.runId), '{ truncated');

    // the message says which run, which file and what to do; it is a usage error, not an internal one
    await expect(statusCommand(undefined, { repository: repo })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    await expect(statusCommand(undefined, { repository: repo })).rejects.toThrow(new RegExp(`Run "${run.runId}" cannot be read`));
    await expect(statusCommand(undefined, { repository: repo })).rejects.toThrow(/is not valid JSON/);

    // and cao list, which skips what it cannot read, says so rather than reporting an empty directory
    const list = await captureCli(() => listCommand({ repository: repo }));
    expect(list.code).toBe(0);
    expect(list.stderr).toContain(`Skipped 1 unreadable run directory: ${run.runId}`);
    expect(list.stdout).toContain('No runs found under');
  }, 60_000);

  it('refuses a third reference rather than silently ignoring it', async () => {
    const repo = await tmpGitRepo('cao-cli-refs-');
    const { run } = await execute(repo);
    await expect(taskCommand([run.runId, 'implement-api', 'extra'], { repository: repo })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    await expect(taskCommand([run.runId, 'implement-api', 'extra'], { repository: repo })).rejects.toThrow(/Too many arguments.*cao task/);
    await expect(diffCommand([run.runId, 'implement-api', 'extra'], { repository: repo })).rejects.toThrow(/Too many arguments.*cao diff/);
  }, 60_000);

  it('prints attempt paths a shell can take back, and does not offer a dead pid as the worker', async () => {
    const repo = await tmpGitRepo('cao-cli-paths-');
    const { run } = await execute(repo);
    const shown = await captureCli(() => taskCommand(['implement-api'], { repository: repo }));
    const attempt = path.join(repo, '.orchestrator', 'runs', run.runId, 'tasks', 'implement-api', 'attempts', '1');
    for (const name of ['stdout.log', 'stderr.log', 'events.jsonl', 'prompt.md']) expect(shown.stdout).toContain(path.join(attempt, name));
    expect(shown.stdout).toMatch(/PID: +\d+ \(exited\)/);

    // an empty stderr.log is a fact about the agent, not a command that produced nothing
    const stderr = await captureCli(() => logsCommand(['implement-api'], { repository: repo, stderr: true }));
    expect(stderr.stdout).toContain('(stderr.log is empty)');
  }, 60_000);

  it('hides a status column no task filled and never pads a row out to trailing spaces', async () => {
    const repo = await tmpGitRepo('cao-cli-cols-');
    await execute(repo);
    const status = await captureCli(() => statusCommand(undefined, { repository: repo }));
    // Context is live-only: with every task finished the heading would sit over blank space
    expect(status.stdout).toContain('Detail');
    expect(status.stdout).not.toContain('Context');
    for (const line of status.stdout.split(NL)) expect(line).toBe(line.replace(/ +$/, ''));
  }, 60_000);

  // Spawned rather than called in-process: commander writes its own errors and exits itself, and what is
  // being checked is exactly that exit, plus that every subcommand inherits the override.
  it('exits 2 for commander usage errors too, as cao --help promises', async () => {
    const cli = (...args: string[]) => execa('npx', ['tsx', 'src/bin.ts', ...args], { cwd: process.cwd(), reject: false, windowsHide: true });
    const frobnicate = await cli('frobnicate');
    expect(frobnicate.exitCode).toBe(2);
    expect((await cli('logs', 'x', '--lines', '0')).exitCode).toBe(2);
    const help = await cli('--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Exit codes:');
    expect((await cli('status', '--help')).exitCode).toBe(0);
    expect((await cli('task', '--help')).exitCode).toBe(0);

    // §3.3: `cao` alone is not a mistake. Help on **stdout**, exit 0 - it used to be stderr and 2.
    const bare = await cli();
    expect(bare.exitCode).toBe(0);
    expect(bare.stderr).toBe('');
    expect(bare.stdout).toContain('Usage: cao [options] [command]');
    expect(bare.stdout).toContain('Task controls:');

    // A mistyped command still is a mistake, and now says what was probably meant.
    expect(frobnicate.stderr).toContain("unknown command 'frobnicate'");
    const mistyped = await cli('stauts');
    expect(mistyped.exitCode).toBe(2);
    expect(mistyped.stderr).toContain('Did you mean status?');
  }, 120_000);

  it('cao stop reports a stale lock and requests an interrupt from a live orchestrator', async () => {
    const repo = await tmpGitRepo('cao-cli-stop-');
    const { run, store } = await execute(repo);

    // nothing running: say so rather than pretending, and point at the command that takes the run over
    await fs.writeFile(store.paths.lockFile(run.runId), JSON.stringify({ pid: 999_999_999, startedAt: nowIso(), heartbeatAt: nowIso() }));
    const stale = await captureCli(() => stopCommand(run.runId, { repository: repo }));
    expect(stale.code).toBe(0);
    expect(stale.stdout).toContain('has already finished (state: completed)');
    expect(stale.stdout).toContain('Its lock is stale (pid 999999999 is gone)');

    // a live orchestrator: the request lands in the run directory for its watcher to pick up
    await fs.writeFile(store.paths.lockFile(run.runId), JSON.stringify({ pid: process.pid, startedAt: nowIso(), heartbeatAt: nowIso() }));
    const asked = await captureCli(() => stopCommand(run.runId, { repository: repo, wait: 0 }));
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain(`Stop requested for run ${run.runId}`);
    expect(await readStopRequest(store.paths, run.runId)).toMatchObject({ pid: process.pid, source: 'cao stop' });
  }, 60_000);

  it('finds a live orchestrator through a missing lock file, from live.json', async () => {
    const repo = await tmpGitRepo('cao-cli-nolock-');
    const { run, store } = await execute(repo);
    // The state this fixes: a run whose orchestrator is alive but whose lock.json has gone. Reading only
    // the lock, every one of these commands reports "nothing is running" over a live orchestrator.
    run.state = 'running';
    await store.saveRun(run);
    await store.writeLive(run.runId, { runId: run.runId, orchestratorPid: process.pid, heartbeatAt: nowIso(), state: 'running', tasks: {} });
    await fs.rm(store.paths.lockFile(run.runId), { force: true });
    expect(await pathExists(store.paths.lockFile(run.runId))).toBe(false);

    const found = await readOrchestrator(store, run.runId);
    expect(found).toMatchObject({ pid: process.pid, source: 'live', alive: true });
    expect(await findActiveRun(new FileRunStore(repo))).toBeNull(); // ...except to this process, which is it

    // cao stop asks the orchestrator to stop instead of sending the reader to `cao resume` on top of it
    await clearStopRequest(store.paths, run.runId);
    const asked = await captureCli(() => stopCommand(run.runId, { repository: repo, wait: 0 }));
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain(`Stop requested for run ${run.runId}`);
    expect(asked.stdout).not.toContain('nothing to stop');
    expect(await readStopRequest(store.paths, run.runId)).toMatchObject({ pid: process.pid });

    // and cao status says the orchestrator is running, naming the file it had to fall back to
    const status = await captureCli(() => statusCommand(run.runId, { repository: repo }));
    expect(status.stdout).toContain(`Orchestrator: pid ${process.pid}  running  (lock.json is missing)`);
    expect(status.stdout).not.toContain('orchestrator process not running');

    // a dead pid in live.json is still "not running": the fallback widens the check, it does not weaken it
    await store.writeLive(run.runId, { runId: run.runId, orchestratorPid: 999_999_999, heartbeatAt: nowIso(), state: 'running', tasks: {} });
    expect(await readOrchestrator(store, run.runId)).toMatchObject({ alive: false });
    // nor does a live.json left behind by a run that has ended
    await store.writeLive(run.runId, { runId: run.runId, orchestratorPid: process.pid, heartbeatAt: nowIso(), state: 'completed', tasks: {} });
    expect(await readOrchestrator(store, run.runId)).toBeNull();
  }, 60_000);

  it('a second cao run is refused when the live run has lost its lock file', async () => {
    const repo = await tmpGitRepo('cao-cli-nolock-run-');
    const configPath = await writeWorkflow(repo);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    const store = new FileRunStore(repo);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
    run.state = 'running';
    await store.saveRun(run);
    // no lock at all, only the live status this test's parent process is standing in for
    await store.writeLive(run.runId, { runId: run.runId, orchestratorPid: process.ppid, heartbeatAt: nowIso(), state: 'running', tasks: {} });

    const started = await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false })).catch((err: Error) => err);
    expect(started).toBeInstanceOf(Error);
    expect((started as Error).message).toMatch(new RegExp(`Run ${run.runId} is already running`));
    expect((await store.listRuns()).map((r) => r.runId)).toEqual([run.runId]);
  }, 60_000);

  it('the heartbeat puts a lock file back when something removes it under a live orchestrator', async () => {
    const repo = await tmpGitRepo('cao-cli-heal-');
    const store = new FileRunStore(repo);
    const configPath = await writeWorkflow(repo);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });

    expect(await store.acquireLock(run.runId)).toEqual({ ok: true });
    await fs.rm(store.paths.lockFile(run.runId), { force: true });
    await store.heartbeat(run.runId);
    expect(await store.readLock(run.runId)).toMatchObject({ pid: process.pid });

    // but it never takes a lock that belongs to someone else
    await fs.writeFile(store.paths.lockFile(run.runId), JSON.stringify({ pid: process.ppid, startedAt: nowIso(), heartbeatAt: nowIso() }));
    await store.heartbeat(run.runId);
    expect(await store.readLock(run.runId)).toMatchObject({ pid: process.ppid });
  }, 60_000);

  it('the stop watcher consumes each request, so a second stop forces the kill', async () => {
    const dir = await tmpDir('cao-stop-watch-');
    const paths = createNativeRunPaths(dir);
    const runId = '2026-01-01-001';
    await fs.mkdir(paths.runDir(runId), { recursive: true });
    const seen: string[] = [];
    const dispose = watchStopRequests({ paths, runId, intervalMs: 20, onStop: (request) => seen.push(request.source ?? '?') });
    try {
      await requestStop(paths, runId);
      await waitFor(() => seen.length === 1);
      // consumed, so the watcher does not fire again on the same request
      expect(await pathExists(path.join(paths.runDir(runId), 'stop.json'))).toBe(false);
      await requestStop(paths, runId, 'cao stop again');
      await waitFor(() => seen.length === 2);
      expect(seen).toEqual(['cao stop', 'cao stop again']);
    } finally {
      dispose();
      await clearStopRequest(paths, runId);
    }
  }, 20_000);

  // Everything `cao task` prints from the worker goes through sanitizeText: the result block and the file
  // lists are read by someone deciding whether to trust the result, and a worker chooses every byte of them.
  it('cao task strips escape sequences a worker put in its result and its file names', async () => {
    const repo = await tmpGitRepo('cao-cli-safe-');
    const configPath = await writeWorkflow(repo);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    const store = new FileRunStore(repo);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const task = run.tasks['implement-api']!;
    task.state = 'success';
    task.attempts = [
      { number: 1, kind: 'task', triggeredBy: 'initial', startedAt: nowIso(), endedAt: nowIso(), cwd: repo, files: { [`src/${ESC}[2Jhidden.ts`]: { ops: 1, lastOp: 'write' } } },
    ];
    task.result = {
      taskId: 'implement-api',
      attempt: 1,
      completedAt: nowIso(),
      status: 'success',
      summary: `done${ESC}[2J${CR}status: failed`,
      filesChanged: [`src/${ESC}[31mred.ts`],
      commits: [],
      decisions: [],
      warnings: [],
      followUp: [],
    };
    await store.saveRun(run);

    const shown = await captureCli(() => taskCommand([run.runId, 'implement-api'], { repository: repo }));
    expect(shown.code).toBe(0);
    expect(shown.stdout).not.toContain(ESC);
    expect(shown.stdout).not.toContain(CR);
    expect(shown.stdout).toContain('summary: donestatus: failed');
    expect(shown.stdout).toContain('filesChanged: src/red.ts');
    expect(shown.stdout).toContain('W src/hidden.ts');
  }, 30_000);

  /**
   * `cao task stop|restart` with the run owned by *this* process (§3.3, §2.3): the controller is right
   * here, so the command is a call rather than a file, and the answer is the ack itself.
   */
  it('cao task stop and restart reach the controller in this process when it owns the run', async () => {
    const repo = await tmpGitRepo('cao-task-local-');
    const configPath = await writeWorkflow(repo, PAIR);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(repo);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
    // Workers that take their time, so there is something to cancel and something still running afterwards.
    const runtime = createRuntime({ run, environment: { FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '4000' }, secrets: [], logger: silentLogger });
    expect(await store.acquireLock(run.runId)).toEqual({ ok: true });
    const execution = runtime.scheduler.execute();
    try {
      await waitFor(() => run.tasks['a']!.state === 'running' && run.tasks['b']!.state === 'running');

      const stopped = await captureCli(() => taskControlCommand('stop', [run.runId, 'a'], { repository: repo }));
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain('stop a');
      expect(stopped.stdout).toContain('applied');
      await waitFor(() => run.tasks['a']!.state === 'cancelled');

      // ...and a cancelled task is exactly the state `restart` takes [D22], so the pair works as one tool.
      const restarted = await captureCli(() => taskControlCommand('restart', [run.runId, 'a'], { repository: repo }));
      expect(restarted.code).toBe(0);
      expect(restarted.stdout).toContain('applied');
      await waitFor(() => run.tasks['a']!.state !== 'cancelled');

      // A control the run refuses is exit 2 with the owner's own sentence, not a silent success.
      const refused = await captureCli(() => taskControlCommand('restart', [run.runId, 'b'], { repository: repo }));
      expect(refused.code).toBe(2);
      expect(refused.stdout).toContain('rejected');
      expect(refused.stdout).toContain('still running');
    } finally {
      await runtime.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
      await execution;
      await store.releaseLock(run.runId);
    }
  }, 120_000);

  it('cao task stop refuses when no orchestrator owns the run, and says what does move it on', async () => {
    const repo = await tmpGitRepo('cao-task-noowner-');
    const { run } = await execute(repo);
    for (const kind of ['stop', 'restart'] as const) {
      await expect(taskControlCommand(kind, [run.runId, 'implement-api'], { repository: repo })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
      await expect(taskControlCommand(kind, [run.runId, 'implement-api'], { repository: repo })).rejects.toThrow(new RegExp(`No orchestrator owns run ${run.runId}.*cao resume ${run.runId}`));
    }
    // ...and the reference itself is still resolved the way every other command resolves one
    await expect(taskControlCommand('stop', [run.runId, 'implement'], { repository: repo })).rejects.toThrow(/implement-api, implement-ui/);
  }, 60_000);
});

/**
 * The request inbox across a real process boundary (§2.3).
 *
 * Everything else in this file drives the CLI in-process, which cannot show the property that matters here:
 * that a **second `cao`** can reach a run it does not own, and that the run answers it on disk. So this one
 * starts `node dist/bin.js run` as a child, talks to it through the run directory, and reads what it wrote
 * back.
 */
describe('the request inbox, from another process', () => {
  const root = process.cwd();
  /**
   * The child is `node --import tsx src/bin.ts`, not `dist/bin.js`: the property under test is the process
   * boundary, and running the sources keeps `npm test` from depending on a build - which would mean writing
   * into `dist/` from a test run, and a first `npm test` on a fresh checkout paying for one.
   */
  // Resolved here rather than passed as `--import tsx`: the child runs with the temporary repository as its
  // cwd, where the bare specifier does not resolve.
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const cao = (args: string[], options: Options) => execa(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'bin.ts'), ...args], options);
  const saved = { CAO_HOME: process.env.CAO_HOME, CAO_EMIT: process.env.CAO_EMIT };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('leaves nothing in the inbox unanswered when the orchestrator goes, whenever the request landed', async () => {
    const repo = await tmpGitRepo('cao-inbox-late-');
    const configPath = await writeWorkflow(repo, ['name: late', 'tasks:', '  - id: implement-api', '    prompt: p'].join(NL) + NL);
    const paths = createNativeRunPaths(repo);
    const store = new FileRunStore(repo);

    // The guarantee §2.3 makes is that a request is always answered, and there are two ways to keep it: the
    // watcher drains it on a tick, or `executeRun` answers what is left on its way out. Which one wins here
    // depends on where the run ends inside the 500 ms tick, so this pins the guarantee rather than one of
    // the paths; the shutdown sentence itself is checked in test/unit/requests.test.ts.
    //
    // The task the request names is one this run does not have, deliberately: both paths then answer the
    // same way, so the assertion below is about *being* answered rather than about which answer. A prompt
    // for `implement-api` would be drained as `accepted` on one tick and `rejected` on the next, and the
    // accepted one would stop and restart the task on its way past — a race, not a guarantee.
    const late = controlRequest('prompt', { taskId: 'no-such-task', text: 'carry on' });
    const writer = (async () => {
      await until(async () => (await store.listRuns().catch(() => []))[0] !== undefined, 30_000);
      const runId = (await store.listRuns())[0]!.runId;
      await writeControlRequest(paths, runId, late);
      return runId;
    })();
    const [, runId] = await Promise.all([captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false })), writer]);

    const ack = await readAck(paths, runId, late.id);
    expect(ack).toMatchObject({ protocol: 1, id: late.id, status: 'rejected' });
    expect(await fs.readdir(paths.requestsDir(runId))).not.toContain(`${late.id}-prompt.json`);
  }, 120_000);

  it('answers a request from a second cao, stops the run when one arrives, and advertises what it wired', async () => {
    const repo = await tmpGitRepo('cao-inbox-proc-');
    const home = path.join(await tmpDir('cao-inbox-home-'), '.cao');
    // A worker that takes its time, so there is a run to talk to while it is still going.
    const env = { CAO_HOME: home, CAO_EMIT: '1', CAO_CLAUDE_COMMAND: FAKE_CLAUDE, FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '1500' };
    await writeWorkflow(repo, ['name: inbox', 'tasks:', '  - id: implement-api', '    prompt: p'].join(NL) + NL);

    const orchestrator = cao(['run', 'workflow.yaml', '--no-tui'], { cwd: repo, env, reject: false });
    try {
      const store = new FileRunStore(repo);
      const paths = createNativeRunPaths(repo);
      let runId = '';
      await until(async () => {
        runId = (await store.listRuns().catch(() => []))[0]?.runId ?? '';
        return runId !== '' && (await pathExists(paths.lockFile(runId)));
      }, 30_000);

      // A request this run can read but cannot grant: the task is running, so it cannot be restarted. The
      // point is the round trip — a file written by a process that owns nothing, answered by the one that does.
      const refused = controlRequest('restart', { taskId: 'implement-api' });
      await writeControlRequest(paths, runId, refused);
      await until(async () => (await readAck(paths, runId, refused.id)) !== null, 30_000);
      const refusal = await readAck(paths, runId, refused.id);
      expect(refusal).toMatchObject({ protocol: 1, id: refused.id, status: 'rejected' });
      expect(refusal!.reason).toContain('still running');
      expect(await pathExists(path.join(paths.requestsDir(runId), `${refused.id}-restart.json`))).toBe(false);

      // And `cao stop` in a second terminal, which still writes `stop.json` in this beta (§2.7): the owner
      // turns it into a stop request with an id of its own and answers that too.
      const stopped = await cao(['stop', runId], { cwd: repo, env, reject: false });
      expect(stopped.exitCode).toBe(0);
      const finished = await orchestrator;
      expect(finished.exitCode).not.toBe(0);

      const ackNames = await fs.readdir(paths.requestAcksDir(runId));
      const acks = await Promise.all(ackNames.map(async (n) => JSON.parse(await fs.readFile(path.join(paths.requestAcksDir(runId), n), 'utf8')) as { id: string; status: string }));
      expect(acks.map((a) => a.status).sort()).toEqual(['applied', 'rejected']);
      expect((await store.loadRun(runId)).state).toBe('interrupted');

      // §2.3, §4.2.3 — the entry advertises exactly the kinds the inbox really acts on, and `cao emit status`
      // answers the same question for someone whose request is having no effect.
      const entry = JSON.parse(await fs.readFile(entryFile(registryKey(repo, runId), home), 'utf8')) as { capabilities: string[] };
      expect(entry.capabilities).toEqual(['requests', 'stop', 'kill', 'restart', 'edit', 'prompt']);
      process.env.CAO_HOME = home;
      const status = await captureCli(() => emitCommand('status', { json: true }));
      expect(JSON.parse(status.stdout).capabilities).toEqual(['requests', 'stop', 'kill', 'restart', 'edit', 'prompt']);
    } finally {
      orchestrator.kill();
      await orchestrator.catch(() => undefined);
    }
  }, 180_000);

  /**
   * `cao task stop <task>` from a terminal that owns nothing (§2.3, §3.3). The same errand as the test
   * above, across a real process boundary: a `stop` request that names a task is the cancel of one attempt,
   * and the owner answers it on disk while the run carries on.
   */
  it('cao task stop cancels one task in a run another process owns, and is refused once that process is gone', async () => {
    const repo = await tmpGitRepo('cao-task-inbox-');
    const env = { CAO_CLAUDE_COMMAND: FAKE_CLAUDE, FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '4000' };
    // Two tasks, because the property under test is that *one* of them stops: a `stop` request that names a
    // task must not be the run-level stop `stop.json` has always been.
    await writeWorkflow(repo, PAIR);

    const orchestrator = cao(['run', 'workflow.yaml', '--no-tui'], { cwd: repo, env, reject: false });
    let runId = '';
    try {
      const store = new FileRunStore(repo);
      const paths = createNativeRunPaths(repo);
      await until(async () => {
        runId = (await store.listRuns().catch(() => []))[0]?.runId ?? '';
        return runId !== '' && (await pathExists(paths.lockFile(runId)));
      }, 30_000);
      await until(async () => (await store.readLive(runId))?.tasks['a']?.state === 'running', 30_000);

      const stopped = await captureCli(() => taskControlCommand('stop', [runId, 'a'], { repository: repo }));
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toMatch(new RegExp(`sent to pid ${orchestrator.pid}`));
      expect(stopped.stdout).toContain('applied');
      expect(await fs.readdir(paths.requestAcksDir(runId))).toHaveLength(1);

      await orchestrator;
      const finished = await store.loadRun(runId);
      expect(finished.tasks['a']!.state).toBe('cancelled');
      expect(finished.tasks['b']!.state).toBe('success');
      expect(finished.state).not.toBe('interrupted');

      // The owner has gone with the run: there is nothing to ask, and saying so beats a request nobody reads.
      await expect(taskControlCommand('restart', [runId, 'a'], { repository: repo })).rejects.toThrow(/No orchestrator owns run/);
    } finally {
      orchestrator.kill();
      await orchestrator.catch(() => undefined);
    }
  }, 180_000);

  /**
   * `cao task edit` across the process boundary, and then with nobody at the wheel (spec §3.4).
   *
   * The same round trip as the stop above, with the one thing an edit adds: when the request is answered the
   * revision is in the owner's `workflow.json`, and the attempt that follows it runs the new prompt. The
   * second half is the offline path - the run has ended, so the edit goes straight into the file and waits
   * for a resume, which is the only route `--restart` is refused on.
   */
  it('cao task edit reaches the owner, then writes straight into the run once that owner is gone', async () => {
    const repo = await tmpGitRepo('cao-task-edit-');
    const env = { CAO_CLAUDE_COMMAND: FAKE_CLAUDE, FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '4000' };
    await writeWorkflow(repo, PAIR);

    const orchestrator = cao(['run', 'workflow.yaml', '--no-tui'], { cwd: repo, env, reject: false });
    let runId = '';
    try {
      const store = new FileRunStore(repo);
      const paths = createNativeRunPaths(repo);
      await until(async () => {
        runId = (await store.listRuns().catch(() => []))[0]?.runId ?? '';
        return runId !== '' && (await pathExists(paths.lockFile(runId)));
      }, 30_000);
      await until(async () => (await store.readLive(runId))?.tasks['a']?.state === 'running', 30_000);

      // Rejected first, and the worker is still running when it is: validation comes before anything stops.
      const bad = await captureCli(() => taskEditCommand([runId, 'a'], { repository: repo, timeout: 'soon', restart: true }));
      expect(bad.code).toBe(2);
      expect(bad.stdout).toContain('Invalid duration');
      expect((await store.readLive(runId))?.tasks['a']?.state).toBe('running');

      const edited = await captureCli(() => taskEditCommand([runId, 'a'], { repository: repo, prompt: 'the second-terminal prompt', restart: true }));
      expect(edited.code).toBe(0);
      expect(edited.stdout).toMatch(new RegExp(`sent to pid ${orchestrator.pid}`));
      expect(edited.stdout).toContain('applied');
      expect(edited.stdout).toContain('fresh session');

      // Stop the run once the restarted attempt is under way, so `a` ends unfinished: the offline half below
      // is about a run that has something left to do, which is the only kind a resume has a use for.
      await until(async () => ((await store.readLive(runId))?.tasks['a']?.attempt ?? 0) >= 2, 30_000);
      await cao(['stop', runId], { cwd: repo, env, reject: false });
      await orchestrator;
      const finished = await store.loadRun(runId);
      const state = finished.tasks['a']!;
      expect(state.state).not.toBe('success');
      expect(state.revisions).toHaveLength(1);
      expect(state.revisions![0]).toMatchObject({ number: 1, source: 'inbox', appliedToAttempt: 2 });
      expect(finished.workflow.tasks.find((t) => t.id === 'a')!.prompt).toBe('the second-terminal prompt');
      expect(await fs.readFile(path.join(paths.attemptDir(runId, 'a', 2), 'prompt.md'), 'utf8')).toContain('the second-terminal prompt');
      // The first attempt is exactly as it was, which is the whole of "nothing is discarded silently".
      expect(await fs.readFile(path.join(paths.attemptDir(runId, 'a', 1), 'prompt.md'), 'utf8')).not.toContain('the second-terminal prompt');
      // The run log has the summary and not the text (§2.6).
      const events = await fs.readFile(paths.eventsFile(runId), 'utf8');
      expect(events).toContain('"type":"task.edited"');
      expect(events).not.toContain('the second-terminal prompt');

      // Nobody owns the run now, so the edit is written into it and the resume is named.
      await expect(taskEditCommand([runId, 'a'], { repository: repo, prompt: 'x', restart: true })).rejects.toThrow(/no worker to restart/);
      const offline = await captureCli(() => taskEditCommand([runId, 'a'], { repository: repo, retries: 3 }));
      expect(offline.code).toBe(0);
      expect(offline.stdout).toContain('as revision 2: retries');
      expect(offline.stdout).toContain(`cao resume ${runId}`);
      const after = await store.loadRun(runId);
      expect(after.workflow.tasks.find((t) => t.id === 'a')!.retry.attempts).toBe(3);
      expect(after.tasks['a']!.revisions).toHaveLength(2);
      expect(after.tasks['a']!.revisions![1]!.source).toBe('cli');
    } finally {
      orchestrator.kill();
      await orchestrator.catch(() => undefined);
    }
  }, 180_000);
});
