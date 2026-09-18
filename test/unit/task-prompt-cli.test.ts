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
import { registerLocalController } from '../../src/workflow/control/local.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { readPendingRequests } from '../../src/persistence/requests.js';
import { buildWorkflow, captureCli, makeRun, tmpDir } from '../helpers/index.js';
import type { ControlAck, TaskState, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { ControlCommand } from '../../src/workflow/control/commands.js';

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
    expect(seen).toEqual([{ kind: 'prompt', taskId: 'a', text: 'try the other library', mode: 'followUp' }]);
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
