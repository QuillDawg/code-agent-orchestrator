/**
 * The CLI consistency pass, driven the way a user drives it: one real run against the fake Claude, then the
 * read-only commands over its run directory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { captureCli, FAKE_CLAUDE, tmpDir, tmpGitRepo, waitFor } from '../helpers/index.js';
import { pathExists } from '../../src/util/fs.js';
import { findActiveRun, readOrchestrator } from '../../src/cli/util.js';
import { nowIso } from '../../src/util/misc.js';
import { createRunPaths } from '../../src/persistence/paths.js';
import { clearStopRequest, readStopRequest, requestStop, watchStopRequests } from '../../src/execution/signals.js';
import { listCommand } from '../../src/cli/commands/list.js';
import { logsCommand } from '../../src/cli/commands/logs.js';
import { peekCommand } from '../../src/cli/commands/peek.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { stopCommand } from '../../src/cli/commands/stop.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import { diffCommand } from '../../src/cli/commands/diff.js';
import type { WorkflowRun } from '../../src/types/run.js';

const NL = String.fromCharCode(10);
const YAML = ['name: consistency', 'tasks:', '  - id: implement-api', '    prompt: p', '  - id: implement-ui', '    prompt: p'].join(NL) + NL;

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
    expect((await cli('frobnicate')).exitCode).toBe(2);
    expect((await cli('logs', 'x', '--lines', '0')).exitCode).toBe(2);
    const help = await cli('--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Exit codes:');
    expect((await cli('status', '--help')).exitCode).toBe(0);
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
    const paths = createRunPaths(dir);
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
});
