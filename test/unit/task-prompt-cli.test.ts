/**
 * `cao task prompt` (spec §3.5, §3.3): the flags, the mode it chooses, the owner in this process, the
 * request written for another one, and the refusals a run nobody is executing gives.
 *
 * The resume the offline path ends in is not driven here — `test/unit/prompting.test.ts` proves what
 * `reconcileForResume` does with a follow-up, and starting a real runtime from a unit test would spend a
 * worker to assert an argument list.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { taskPromptCommand, collectMessage, requestedMode } from '../../src/cli/commands/task-prompt.js';
import { startRuntime } from '../../src/cli/app.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import { registerLocalController } from '../../src/workflow/control/local.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { controlRequest, readPendingRequests } from '../../src/persistence/requests.js';
import { buildWorkflow, captureCli, FAKE_CLAUDE, makeRun, tmpDir } from '../helpers/index.js';
import type { ControlAck, TaskState, WorkflowRun } from 'code-agent-orchestrator-protocol';
import { commandForRequest } from '../../src/workflow/control/commands.js';
import type { ControlCommand } from '../../src/workflow/control/commands.js';

const NL = String.fromCharCode(10);

const CHAIN = `
name: t
tasks:
  - id: a
    prompt: the original prompt
  - id: b
    prompt: p
    dependsOn: [a]
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A run directory with one task in `state`, as an ended run leaves behind. */
async function offlineRun(state: TaskState = 'failed'): Promise<{ repo: string; store: FileRunStore; runId: string; run: WorkflowRun }> {
  const repo = await tmpDir('cao-prompt-cli-');
  const { workflow } = await buildWorkflow(CHAIN, { repositoryRoot: repo });
  const run = makeRun(workflow, '2026-09-18-001');
  run.state = 'failed';
  run.tasks.a!.state = state;
  run.tasks.a!.attempts = [
    { number: 1, kind: 'task', triggeredBy: 'initial', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: 'crash', cwd: repo, sessionId: 'old-session' },
  ];
  const store = new FileRunStore(repo);
  await store.saveRun(run);
  return { repo, store, runId: run.runId, run };
}

/** Claim the run for this process, so the command finds a controller instead of writing a file. */
async function writeLock(repo: string, runId: string, pid: number): Promise<void> {
  const store = new FileRunStore(repo);
  const file = store.paths.lockFile(runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify({ pid, startedAt: now, heartbeatAt: now }), 'utf8');
}

async function ownHere(repo: string, runId: string, answer: ControlAck, seen: ControlCommand[]): Promise<void> {
  await writeLock(repo, runId, process.pid);
  cleanups.push(
    registerLocalController(runId, {
      submit: async (command: ControlCommand) => {
        seen.push(command);
        return answer;
      },
    } as never),
  );
}

describe('cao task prompt: the flags', () => {
  it('takes the message from --message or --file, and refuses both or neither', async () => {
    const repo = await tmpDir('cao-prompt-msg-');
    const file = path.join(repo, 'note.md');
    await fs.writeFile(file, 'read this instead', 'utf8');
    expect(await collectMessage({ message: 'hello' })).toBe('hello');
    expect(await collectMessage({ file })).toBe('read this instead');
    await expect(collectMessage({ message: 'a', file })).rejects.toThrow(/not both/);
    await expect(collectMessage({})).rejects.toThrow(/--message/);
    await expect(collectMessage({ message: '   ' })).rejects.toThrow(/--message/);
    await expect(collectMessage({ file: path.join(repo, 'missing.md') })).rejects.toThrow(/Could not read/);
  });

  it('takes one mode flag and no more', () => {
    expect(requestedMode({})).toBeUndefined();
    expect(requestedMode({ steer: true })).toBe('steer');
    expect(requestedMode({ followUp: true })).toBe('followUp');
    expect(requestedMode({ stopAndContinue: true })).toBe('stopAndContinue');
    expect(() => requestedMode({ steer: true, followUp: true })).toThrow(/three different things/);
  });
});

describe('cao task prompt: the run this process owns', () => {
  it('submits to the controller and prints its ack', async () => {
    const { repo, runId } = await offlineRun();
    const seen: ControlCommand[] = [];
    await ownHere(repo, runId, { protocol: 1, id: 'x', status: 'accepted', reason: 'Starting "a" again with your message.', at: 'now' } as ControlAck, seen);

    const result = await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'try the other library' }));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('this process');
    expect(result.stdout).toContain('Starting "a" again');
    // No mode on the command: the operator named none, and only the run knows whether the attempt in front
    // of it has a live channel. Sending `followUp` here refused every no-flag prompt to a running task.
    expect(seen).toEqual([{ kind: 'prompt', taskId: 'a', text: 'try the other library' }]);
  });

  it('carries --steer and --fresh-session over as asked, and exits 2 on a refusal', async () => {
    const { repo, runId } = await offlineRun();
    const seen: ControlCommand[] = [];
    await ownHere(repo, runId, { protocol: 1, id: 'x', status: 'rejected', reason: 'no live session to steer.', at: 'now' } as ControlAck, seen);

    const result = await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'x', steer: true, freshSession: true }));
    expect(result.code).toBe(2);
    expect(seen[0]).toMatchObject({ mode: 'steer', freshSession: true });
  });
});

describe('cao task prompt: a run another process owns', () => {
  it('writes a prompt request the inbox can read, and says it was sent', async () => {
    const { repo, store, runId } = await offlineRun();
    // A pid that is really alive and really is not this process: the ownership check reads the process
    // table, so a made-up number would be read as an abandoned run and take the offline path instead.
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 30_000)'], { stdio: 'ignore' });
    cleanups.push(() => owner.kill());
    await writeLock(repo, runId, owner.pid!);

    const result = await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'mind the lockfile', stopAndContinue: true, wait: 0 }));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`sent to pid ${owner.pid}`);

    const requests = await readPendingRequests(store.paths, runId);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request).toMatchObject({ kind: 'prompt', taskId: 'a', text: 'mind the lockfile', mode: 'stopAndContinue' });
  });

  it('leaves the mode out of the request when no flag named one, and the inbox leaves it out too', async () => {
    const { repo, store, runId } = await offlineRun();
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 30_000)'], { stdio: 'ignore' });
    cleanups.push(() => owner.kill());
    await writeLock(repo, runId, owner.pid!);

    await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'mind the lockfile', wait: 0 }));
    const requests = await readPendingRequests(store.paths, runId);
    expect(requests[0]!.request.mode).toBeUndefined();

    // The file crosses a process boundary, so the absence has to survive the translation as an absence: a
    // request read as `followUp` would refuse every no-flag prompt sent to a running task.
    const translated = commandForRequest(requests[0]!.request);
    expect(translated).toMatchObject({ ok: true, command: { kind: 'prompt', taskId: 'a', text: 'mind the lockfile' } });
    expect(translated.ok && 'mode' in translated.command).toBe(false);
  });

  it('refuses a request whose mode this build does not know, rather than reading it as a follow-up', () => {
    const request = controlRequest('prompt', { taskId: 'a', text: 'x', mode: 'interrupt' as never });
    const translated = commandForRequest(request);
    expect(translated).toMatchObject({ ok: false });
    expect(!translated.ok && translated.reason).toMatch(/does not know.*steer/s);
  });
});

describe('what cao task show says about the messages sent to a task (§3.5)', () => {
  it('lists every delivery with its state, the attempt that carried it, and the first line of the text', async () => {
    const { repo, store, runId } = await offlineRun('needs_input');
    const run = await store.loadRun(runId);
    run.tasks.a!.followUps = [
      { id: 'd1', at: '2026-09-18T10:12:30.000Z', source: 'cli', mode: 'followUp', transport: 'none', state: 'delivered', text: `use postgres${NL}and pin the version`, carriedByAttempt: 2 },
      { id: 'd2', at: '2026-09-18T10:14:00.000Z', source: 'tui', mode: 'followUp', transport: 'none', state: 'queued', text: 'and run the migrations' },
    ];
    run.tasks.a!.attempts[0]!.prompts = [
      { id: 'd0', at: '2026-09-18T10:10:00.000Z', source: 'inbox', mode: 'steer', transport: 'codex-app-server', state: 'rejected', text: 'wait', reason: 'no active turn to steer' },
    ];
    await store.saveRun(run);

    const shown = await captureCli(() => taskCommand([runId, 'a'], { repository: repo }));
    expect(shown.code).toBe(0);
    const section = shown.stdout.split('Sent to this task:')[1]!;
    // Oldest first, whether it was recorded on an attempt (a steer) or on the task (a follow-up).
    expect(section.indexOf('steer')).toBeLessThan(section.indexOf('delivered'));
    expect(section).toContain('no active turn to steer');
    expect(section).toContain('delivered  attempt 2  use postgres');
    // The one an operator most needs to see: a message nobody has carried yet.
    expect(section).toContain('queued');
    expect(section).toContain('and run the migrations');
    // One line each: the rest of a long message is in the attempt's prompt.md, not in this table.
    expect(section).not.toContain('and pin the version');
  });
});

describe('cao task prompt: nobody is executing the run', () => {
  it('refuses a mode that needs a worker, naming what there is instead', async () => {
    const { repo, runId } = await offlineRun('running');
    // The run directory still says `running`, but nothing owns it: there is no worker to steer or to stop.
    const result = await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'x', steer: true }));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('rejected');
  });

  it('refuses a succeeded task with the immutability sentence `[D27]`', async () => {
    const { repo, runId } = await offlineRun('success');
    const result = await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'one more thing' }));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('immutable');
  });

  it('refuses a task that has not started, pointing at the editor', async () => {
    const { repo, store, runId } = await offlineRun();
    const run = await store.loadRun(runId);
    run.tasks.a!.state = 'pending';
    run.tasks.a!.attempts = [];
    await store.saveRun(run);
    const result = await captureCli(() => taskPromptCommand([runId, 'a'], { repository: repo, message: 'x' }));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('cao task edit a');
  });
});

/**
 * `[D25]` on the *resume* that carries a follow-up, which is the path the workspace's composer takes on an
 * ended run: it calls `startRuntime` directly and never goes near `cao task prompt`'s own check.
 */
describe('the resume that carries a follow-up checks the session too (`[D25]`)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  /** A Claude config directory that exists and has run other projects, but not this session. */
  async function configWithoutTheSession(): Promise<string> {
    const home = await tmpDir('cao-claude-home-');
    await fs.mkdir(path.join(home, 'projects', 'some-other-project'), { recursive: true });
    return home;
  }

  it('refuses when the transcript the follow-up would resume is gone, before taking the lock', async () => {
    const { repo, store, runId } = await offlineRun();
    process.env.CLAUDE_CONFIG_DIR = await configWithoutTheSession();

    await expect(startRuntime(runId, { repository: repo, task: ['a'], followUp: { taskId: 'a', text: 'carry on', source: 'tui' } }))
      .rejects.toThrow(/no longer on disk/);
    // The sentence names what the workspace operator can actually press, and the lock was never taken.
    await expect(startRuntime(runId, { repository: repo, task: ['a'], followUp: { taskId: 'a', text: 'carry on', source: 'tui' } }))
      .rejects.toThrow(/Ctrl\+F/);
    expect(await fs.readFile(store.paths.lockFile(runId), 'utf8').then(() => true, () => false)).toBe(false);
  });

  it('takes it once the fresh session was asked for, without consulting the disk', async () => {
    const { repo, runId } = await offlineRun();
    process.env.CLAUDE_CONFIG_DIR = await configWithoutTheSession();

    // Past the check: it fails later on the agent probe or the lock, never on `[D25]`.
    const started = await startRuntime(runId, {
      repository: repo,
      task: ['a'],
      followUp: { taskId: 'a', text: 'carry on', source: 'tui', freshSession: true },
      claudeCommand: FAKE_CLAUDE,
    });
    expect(started.kind).toBe('ready');
    expect(started.run.tasks.a!.followUps?.[0]).toMatchObject({ text: 'carry on', source: 'tui', state: 'queued' });
    expect(started.run.tasks.a!.resumeSessionId).toBeUndefined();
  });
});
