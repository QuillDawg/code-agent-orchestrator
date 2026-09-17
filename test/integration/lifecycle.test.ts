/**
 * The whole of §2.4 against the fake CLIs: a run ends, the workspace stays, and the actions it offers
 * really do start another execution.
 *
 * This is the acceptance rows 1–3 of §5, driven through the real code path — `executeOnce` with a real
 * scheduler, `startRuntime` with a real lock and a real `reconcileForResume` — with only the Ink tree
 * replaced by a double. What is being tested is the lifecycle, not the drawing: that the run directory,
 * the lock and the exit code come out right when an operator retries from inside the workspace instead of
 * from a second `cao resume`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareWorkflow, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { executeOnce, executeRun, type ExecuteOptions } from '../../src/cli/commands/run.js';
import { runWorkspaceSession } from '../../src/cli/workspace-session.js';
import type { DashboardController, DashboardOptions } from '../../src/tui/app.js';
import type { RunController } from '../../src/workflow/control/controller.js';
import { tmpGitRepo, gitAvailable, captureCli, FAKE_CLAUDE } from '../helpers/index.js';
import { pathExists } from '../../src/util/fs.js';

const HAS_GIT = await gitAvailable('workspace lifecycle suite');

type Reaction = (event: 'ended', options: DashboardOptions, seen: number) => void | Promise<void>;

/** The workspace, minus Ink: it records what it was told and hands the test the run it is drawing. */
function workspaceDouble(react: Reaction) {
  const attached: Array<{ run: unknown; controller: RunController }> = [];
  const notices: string[] = [];
  let options: DashboardOptions | undefined;
  let ends = 0;
  let open = false;
  let failure: unknown;
  const controller: DashboardController = {
    get isOpen() {
      return open;
    },
    open: () => {
      open = true;
    },
    close: () => {
      open = false;
    },
    attach: (source) => attached.push({ run: source.run, controller: source.controller }),
    executionEnded: () => {
      ends += 1;
      // A reaction that throws would otherwise leave the loop waiting for an intention that never comes,
      // and the case would fail as a timeout with nothing to read.
      void Promise.resolve(react('ended', options!, ends)).catch((err: unknown) => {
        failure = err;
        options!.onQuit!();
      });
    },
    setOwnership: () => undefined,
    update: () => undefined,
    notify: (text) => notices.push(text),
    requestApproval: () => Promise.resolve('defer' as const),
    requestInteraction: () => Promise.resolve({ kind: 'deny', message: 'no dashboard' }),
    finish: async () => {
      open = false;
    },
  };
  return {
    attached,
    notices,
    /** Rethrown by the test once the loop has come back, so the real error is what it reports. */
    get failure(): unknown {
      return failure;
    },
    /** The live run controller of the execution on screen, which is what the panels read from. */
    get current(): RunController {
      return attached[attached.length - 1]!.controller;
    },
    /** The callbacks the session wired the workspace with, for the keys a test wants to press. */
    get options(): DashboardOptions {
      return options!;
    },
    factory: (given: DashboardOptions) => {
      options = given;
      attached.push({ run: given.run, controller: given.controller });
      return controller;
    },
  };
}

async function firstExecution(repo: string, yaml: string, environment: Record<string, string> = {}): Promise<{ options: ExecuteOptions; store: FileRunStore }> {
  const configPath = path.join(repo, 'workflow.yaml');
  await fs.writeFile(configPath, yaml, 'utf8');
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
  const lock = await store.acquireLock(run.runId);
  expect(lock.ok).toBe(true);
  // The workflow's own `environment:` block, exactly as `cao run` passes it — and exactly what
  // `startRuntime` reloads for the resumed executions, so both halves of a case see the same fake.
  return { options: { run, environment: { ...prepared.loaded.environment, ...environment }, secrets: [], isResume: false, repository: repo, tui: true }, store };
}

const ONE_TASK = `
version: 1
name: lifecycle
repository: .
execution:
  maxConcurrency: 1
tasks:
  - id: a
    prompt: do it
    retries: 0
`;

describe.skipIf(!HAS_GIT)('the workspace stays open when a run ends (§2.4)', () => {
  beforeAll(() => clearDetectionCache());

  it('fails, stays inspectable, resumes to success from the workspace, and quits 0', async () => {
    const repo = await tmpGitRepo('cao-life-fail-');
    const yaml = `${ONE_TASK}environment:\n  FAKE_CLAUDE_MODE: commit\n  FAKE_CLAUDE_FAIL_UNTIL_ATTEMPT: '{"a":2}'\n`;
    const { options, store } = await firstExecution(repo, yaml);
    const runId = options.run.runId;

    const inspected: Record<string, unknown> = {};
    const workspace = workspaceDouble(async (_event, dashboard, seen) => {
      if (seen === 1) {
        const controller = workspace.current;
        // §3.1: after a failure the run is still there to be read — attempts, the transcript, the report.
        inspected.state = controller.run.state;
        inspected.attempts = controller.run.tasks['a']!.attempts.length;
        inspected.outcome = controller.run.tasks['a']!.attempts[0]!.outcome;
        inspected.transcript = (await controller.attemptTranscript('a', 1)).length;
        inspected.report = (await controller.readReport())?.includes(runId);
        // The lock is released at finalize, so the workspace holds nothing while it waits.
        inspected.locked = await pathExists(store.paths.lockFile(runId));
        dashboard.onResume!({ kind: 'resume' });
        return;
      }
      const controller = workspace.current;
      inspected.finalState = controller.run.state;
      inspected.finalAttempts = controller.run.tasks['a']!.attempts.length;
      inspected.diff = Boolean(await controller.capturedDiff('a'));
      dashboard.onQuit!();
    });

    const code = await runWorkspaceSession({
      first: options,
      repository: repo,
      execute: executeOnce,
      createDashboard: workspace.factory,
    });

    if (workspace.failure) throw workspace.failure instanceof Error ? workspace.failure : new Error(String(workspace.failure));
    expect(inspected.state).toBe('failed');
    expect(inspected.attempts).toBe(1);
    expect(inspected.outcome).toBe('failed');
    expect(inspected.transcript).toBeGreaterThan(0);
    expect(inspected.report).toBe(true);
    expect(inspected.locked).toBe(false);

    expect(inspected.finalState).toBe('completed');
    expect(inspected.finalAttempts).toBe(2);
    expect(inspected.diff).toBe(true);
    // The exit code is the latest execution's, not the first one's (§2.4).
    expect(code).toBe(0);

    // The run directory agrees, and nothing is left holding the lock.
    const reloaded = await store.loadRun(runId);
    expect(reloaded.state).toBe('completed');
    expect(reloaded.exitCode).toBe(0);
    expect(await pathExists(store.paths.lockFile(runId))).toBe(false);
  }, 60_000);


  // The constraint §2.4 puts on this stage in one assertion: whatever the workspace needs to stay open —
  // the spinner, the freshness clock, the reopen key listener, the Ink tree itself — must not exist on a
  // run that never asked for a workspace.
  it('leaves no timer and no process listener behind on the headless path', async () => {
    const repo = await tmpGitRepo('cao-life-headless-');
    const yaml = `${ONE_TASK}environment:
  FAKE_CLAUDE_MODE: success
`;
    const { options, store } = await firstExecution(repo, yaml);
    const count = () => ({
      timers: process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout' || kind === 'Immediate').length,
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      exit: process.listenerCount('exit'),
      stdin: process.stdin.listenerCount('keypress'),
    });
    const before = count();
    const shown = await captureCli(() => executeRun({ ...options, tui: false }));
    const after = count();

    expect(shown.code).toBe(0);
    expect(await store.loadRun(options.run.runId)).toMatchObject({ state: 'completed' });
    expect(after.timers).toBeLessThanOrEqual(before.timers);
    expect(after.sigint).toBe(before.sigint);
    expect(after.sigterm).toBe(before.sigterm);
    expect(after.exit).toBe(before.exit);
    expect(after.stdin).toBe(before.stdin);
  }, 60_000);

  it('stops on Ctrl+C, stays open in interrupted state, and resumes from there', async () => {
    const repo = await tmpGitRepo('cao-life-int-');
    const previous = process.env.FAKE_CLAUDE_MODE;
    // Not the workflow's `environment:` block: the resumed execution reloads that from the file, and this
    // case needs the second attempt to behave differently from the first.
    process.env.FAKE_CLAUDE_MODE = 'hang';
    try {
      const { options, store } = await firstExecution(repo, ONE_TASK);
      const runId = options.run.runId;
      const states: string[] = [];
      const workspace = workspaceDouble((_event, dashboard, seen) => {
        states.push(workspace.current.run.state);
        if (seen === 1) {
          process.env.FAKE_CLAUDE_MODE = 'success';
          dashboard.onResume!({ kind: 'resume' });
        } else dashboard.onQuit!();
      });

      const code = await runWorkspaceSession({
        first: options,
        repository: repo,
        // The Ctrl+C is sent once the worker is really running, which is the only moment there is
        // anything for it to stop; the second execution is left alone.
        execute: async (target, session) => {
          const running = executeOnce(target, session);
          await waitUntil(() => target.run.tasks['a']!.state === 'running', 20_000);
          if (target.run.tasks['a']!.attempts.length === 1) workspace.options.onInterrupt();
          return running;
        },
        createDashboard: workspace.factory,
      });

      if (workspace.failure) throw workspace.failure instanceof Error ? workspace.failure : new Error(String(workspace.failure));
      expect(states[0]).toBe('interrupted');
      expect(states[1]).toBe('completed');
      expect(code).toBe(0);
      const reloaded = await store.loadRun(runId);
      expect(reloaded.tasks['a']!.attempts).toHaveLength(2);
      // The worker was killed by the stop, so the attempt is recorded as cancelled; what makes the *run*
      // interrupted is the cause of the stop, which is what the first ended state showed.
      expect(reloaded.tasks['a']!.attempts[0]!.outcome).toBe('cancelled');
      expect(reloaded.tasks['a']!.attempts[1]!.outcome).toBe('success');
    } finally {
      if (previous === undefined) delete process.env.FAKE_CLAUDE_MODE;
      else process.env.FAKE_CLAUDE_MODE = previous;
    }
  }, 90_000);

  it('approves a paused gate from the workspace and carries the run on', async () => {
    const repo = await tmpGitRepo('cao-life-gate-');
    const yaml = `
version: 1
name: lifecycle-gate
repository: .
execution:
  maxConcurrency: 1
tasks:
  - id: gate
    prompt: ship it
    approval: true
    retries: 0
environment:
  FAKE_CLAUDE_MODE: success
`;
    const { options, store } = await firstExecution(repo, yaml);
    const runId = options.run.runId;
    const states: string[] = [];
    const workspace = workspaceDouble((_event, dashboard, seen) => {
      states.push(workspace.current.run.state);
      // The double defers every approval, which is what a workspace does when nobody answers: the run
      // pauses and the gate is settled from the ended state instead ([D36]).
      if (seen === 1) dashboard.onResume!({ kind: 'approve', taskId: 'gate' });
      else dashboard.onQuit!();
    });

    const code = await runWorkspaceSession({ first: options, repository: repo, execute: executeOnce, createDashboard: workspace.factory });

    if (workspace.failure) throw workspace.failure instanceof Error ? workspace.failure : new Error(String(workspace.failure));
    expect(states[0]).toBe('paused');
    expect(states[1]).toBe('completed');
    expect(code).toBe(0);
    const reloaded = await store.loadRun(runId);
    expect(reloaded.tasks['gate']!.state).toBe('success');
  }, 60_000);
});

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the worker to start');
    await new Promise((r) => setTimeout(r, 25));
  }
}
