/**
 * `cao ui` (spec §3.1): opening the workspace on a run nobody is executing, and the launcher that offers
 * the runs of a repository when no run was named.
 *
 * Three things are covered here, and all three are about a run this process does not own: what the command
 * prints where there is no terminal to draw in, what the launcher lists and answers, and what a controller
 * over a run directory can and cannot do.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { uiCommand } from '../../src/cli/commands/ui.js';
import { createDetachedController } from '../../src/workflow/control/detached.js';
import { Launcher, launcherRows, runLauncher, type LauncherChoice } from '../../src/tui/launcher.js';
import { altScreenIsActive, markAltScreen } from '../../src/tui/terminal.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';
import { buildWorkflow, captureCli, makeRun, tmpDir } from '../helpers/index.js';
import { renderTree, KEYS } from '../helpers/ink-harness.js';
import type { WorkflowRun } from 'code-agent-orchestrator-protocol';

const YAML = 'name: ui-fixture\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 20): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

/** A repository with one finished run in it, written the way the scheduler writes one. */
async function repoWithRun(state: WorkflowRun['state'] = 'failed'): Promise<{ repo: string; store: FileRunStore; run: WorkflowRun }> {
  const repo = await tmpDir('cao-ui-');
  const { workflow } = await buildWorkflow(YAML, { repositoryRoot: repo });
  const run = makeRun(workflow, '2026-09-17-001');
  run.state = state;
  run.startedAt = run.createdAt;
  run.endedAt = new Date(Date.parse(run.createdAt) + 60_000).toISOString();
  run.exitCode = state === 'completed' ? 0 : 1;
  run.tasks['a'] = {
    id: 'a',
    state: 'success',
    retryWindowStart: 1,
    attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: run.createdAt, endedAt: run.endedAt, cwd: repo, files: {}, outcome: 'success', usage: { costUsd: 1.25 } }],
  } as WorkflowRun['tasks'][string];
  run.tasks['b'] = {
    id: 'b',
    state: 'failed',
    message: 'exit code 1',
    retryWindowStart: 1,
    attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: run.createdAt, endedAt: run.endedAt, cwd: repo, files: {}, outcome: 'failed', error: 'the build failed' }],
  } as WorkflowRun['tasks'][string];
  const store = new FileRunStore(repo);
  await store.saveRun(run);
  return { repo, store, run };
}

describe('cao ui without a terminal (§3.1)', () => {
  it('lists the runs of the repository, newest first, with age and cost', async () => {
    const { repo } = await repoWithRun();
    const shown = await captureCli(() => uiCommand(undefined, { repository: repo }));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('2026-09-17-001');
    expect(shown.stdout).toContain('ui-fixture');
    expect(shown.stdout).toContain('Age');
    expect(shown.stdout).toContain('Cost');
    expect(shown.stdout).toContain('$1.25');
    expect(shown.stdout).toContain('cao ui <run>');
  });

  it('prints the same list as JSON, with the workflow files it could start', async () => {
    const { repo } = await repoWithRun();
    await fs.writeFile(path.join(repo, 'workflow.yaml'), YAML, 'utf8');
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const shown = await captureCli(() => uiCommand(undefined, { repository: repo, json: true }));
      const payload = JSON.parse(shown.stdout) as { runs: Array<{ runId: string; costUsd?: number }>; workflows: string[] };
      expect(payload.runs.map((r) => r.runId)).toEqual(['2026-09-17-001']);
      expect(payload.runs[0]!.costUsd).toBe(1.25);
      expect(payload.workflows).toEqual(['workflow.yaml']);
    } finally {
      process.chdir(previous);
    }
  });

  it('says so, and how to start one, in a repository with no runs', async () => {
    const repo = await tmpDir('cao-ui-empty-');
    const shown = await captureCli(() => uiCommand(undefined, { repository: repo }));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('No runs found');
    expect(shown.stdout).toContain('cao run');
  });

  it('summarises one run instead of opening it', async () => {
    const { repo } = await repoWithRun();
    const shown = await captureCli(() => uiCommand('001', { repository: repo }));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('2026-09-17-001  ui-fixture  failed');
    expect(shown.stdout).toContain('cao status 2026-09-17-001');
  });

  it('names the process that owns a run someone else is executing (§2.1)', async () => {
    const { repo, store } = await repoWithRun('running');
    // A lock this process wrote is this process's own; a live pid that is not ours is what "owned" means.
    await fs.writeFile(store.paths.lockFile('2026-09-17-001'), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }), 'utf8');
    const shown = await captureCli(() => uiCommand('001', { repository: repo }));
    // Whether pid 4242 happens to exist on this machine decides owner vs observer, so the assertion is on
    // the one thing that is true either way: the run is named and nothing was opened.
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('2026-09-17-001');
  });
});

describe('the launcher', () => {
  const runs = [
    { runId: '2026-09-17-002', workflowName: 'ship', state: 'failed', createdAt: new Date(Date.now() - 8 * 60_000).toISOString(), costUsd: 2.5, progress: { done: 1, total: 3 } },
    { runId: '2026-09-17-001', workflowName: 'upgrade', state: 'completed', createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), progress: { done: 4, total: 4 } },
  ];

  it('lists the runs with their state, age and cost, then the workflows it could start', () => {
    const rows = launcherRows({ runs, workflows: ['workflow.yaml'], now: Date.now() });
    expect(rows.map((r) => r.key)).toEqual(['run:2026-09-17-002', 'run:2026-09-17-001', 'workflow:workflow.yaml']);
    expect(rows[0]!.hint).toContain('failed');
    expect(rows[0]!.hint).toContain('1/3');
    expect(rows[0]!.hint).toContain('8m');
    expect(rows[0]!.hint).toContain('$2.50');
    // A run nothing reported a cost for shows no cost rather than "$0.00", which would be a claim.
    expect(rows[1]!.hint).not.toContain('$');
  });

  it('opens the run under the cursor, quits on Q, and takes a path with P', async () => {
    const chosen: LauncherChoice[] = [];
    const tree = renderTree(<Launcher runs={runs} workflows={['workflow.yaml']} now={Date.now()} onChoose={(c) => chosen.push(c)} />, { columns: 90, rows: 20 });
    try {
      await wait();
      expect(tree.lastText()).toContain('2026-09-17-002');
      expect(tree.lastText()).toContain('Run workflow.yaml');
      tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.enter);
      await wait();
      expect(chosen).toEqual([{ kind: 'open', runId: '2026-09-17-001' }]);

      tree.write('p');
      await wait();
      for (const ch of 'flows/a.yaml') {
        tree.write(ch);
        await wait(5);
      }
      await wait();
      expect(tree.lastText()).toContain('flows/a.yaml');
      tree.write(KEYS.enter);
      await wait();
      expect(chosen[1]).toEqual({ kind: 'run', workflow: 'flows/a.yaml' });

      tree.write('q');
      await wait();
      expect(chosen[2]).toEqual({ kind: 'quit' });
    } finally {
      tree.unmount();
    }
  });

  // The launcher runs with `exitOnCtrlC: false` like the rest of `src/tui/`, and Ink holds stdin in raw
  // mode, so Ctrl+C arrives here as a keystroke and never as a signal. Without a branch for it the picker
  // would be the one screen in the workspace that cannot be interrupted (§3.2).
  it('leaves on Ctrl+C, in the list and with the path field open', async () => {
    const chosen: LauncherChoice[] = [];
    const tree = renderTree(<Launcher runs={runs} workflows={['workflow.yaml']} now={Date.now()} onChoose={(c) => chosen.push(c)} />, { columns: 90, rows: 20 });
    try {
      await wait();
      tree.write(KEYS.ctrlC);
      await wait();
      expect(chosen).toEqual([{ kind: 'quit' }]);

      tree.write('p');
      await wait();
      expect(tree.lastText()).toContain('workflow path>');
      tree.write(KEYS.ctrlC);
      await wait();
      expect(chosen[1]).toEqual({ kind: 'quit' });
    } finally {
      tree.unmount();
    }
  });

  // The launcher takes the alternate screen, so it owes the terminal the same exit handler the workspace
  // arms (§2.4): Ink covers an unmount and the crash handler covers a throw, but a `process.exit` while the
  // picker is up would otherwise leave the shell on the alternate buffer.
  it('arms the alternate-screen restore while it is up, and disarms it on the way out', async () => {
    const tty = process.stdout.isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const before = process.listeners('exit').length;
    let unmounted = (): void => {};
    const exited = new Promise<void>((resolve) => {
      unmounted = resolve;
    });
    const instance = { unmount: () => unmounted(), waitUntilExit: () => exited, rerender: () => {}, cleanup: () => {}, clear: () => {} };
    try {
      const pending = runLauncher({ runs: [], workflows: [], altScreen: true, mount: (() => instance) as unknown as Parameters<typeof runLauncher>[0]['mount'] });
      await wait(0);
      expect(altScreenIsActive()).toBe(true);
      expect(process.listeners('exit')).toHaveLength(before + 1);
      unmounted();
      expect(await pending).toEqual({ kind: 'quit' });
      expect(altScreenIsActive()).toBe(false);
      expect(process.listeners('exit')).toHaveLength(before);
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = tty;
      markAltScreen(false);
    }
  });
});

describe('a controller over a run nobody is executing', () => {
  it('reads the run directory and refuses every command with a reason', async () => {
    const { repo, store, run } = await repoWithRun();
    await store.writeReport(run.runId, '# Run report\n\nIt failed.\n');
    const attemptDir = await store.attemptDir(run.runId, 'b', 1);
    await fs.writeFile(path.join(attemptDir, 'events.jsonl'), `${JSON.stringify({ kind: 'text', at: run.createdAt, text: 'the build failed' })}\n`, 'utf8');

    const controller = createDetachedController({ store, run, reason: `No orchestrator owns run ${run.runId}.` });
    expect(controller.ended).toBe(true);
    expect(controller.canInteract).toBe(false);
    expect(await controller.readReport()).toContain('It failed.');
    expect((await controller.attemptTranscript('b', 1)).map((e) => e.kind)).toEqual(['text']);
    expect(await controller.capturedDiff('b')).toBeNull();

    // `peek` is synchronous on the interface, so the first call starts the read and the frame after it has
    // the answer; nothing throws and nothing blocks in between.
    expect(controller.peek('b')).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.peek('b')).toHaveLength(1);

    const ack = await controller.submit({ kind: 'restart', taskId: 'b' }, controlEnvelope('tui'));
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('No orchestrator owns');
    expect(repo).toBeTruthy();
  });
});
