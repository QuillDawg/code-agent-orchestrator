/**
 * Steering a running task end to end (spec §3.5, §2.6; `[D23]`, `[D24]`, `[D26]`): the real service layer,
 * the real scheduler, the run controller, the real runners, and the fake CLIs on the other end of a pipe.
 *
 * The unit suite (`test/unit/prompt-transport.test.ts`) proves each transport's state machine. This proves
 * the seam around it: that a `prompt` command taken by the controller reaches the worker that is running
 * *right now*, that what comes back is written onto the attempt as a `PromptDelivery`, that the run log
 * gets the summary and **not** the text, and that a `user` entry lands in the attempt's transcript.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { clearCodexDetectionCache } from '../../src/runners/codex/detect.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';
import { controlRequest, readAck, writeControlRequest } from '../../src/persistence/requests.js';
import { INBOX_REQUEST_KINDS, watchStopRequests } from '../../src/execution/signals.js';
import { parseTranscriptLine, type PromptDelivery, type TranscriptEntry, type WorkflowEvent } from 'code-agent-orchestrator-protocol';
import { tmpGitRepo, gitAvailable, waitFor, FAKE_CLAUDE, FAKE_CODEX } from '../helpers/index.js';

const MESSAGE = 'also update the changelog';

interface Steered {
  delivery: PromptDelivery | undefined;
  ack: { status: string; reason?: string };
  events: WorkflowEvent[];
  entries: TranscriptEntry[];
  state: string;
}

/**
 * Start a one-task run, wait until its worker is really running, steer one message into it through the
 * controller, and let the run finish.
 */
async function steerOneTask(repo: string, yaml: string, environment: Record<string, string>): Promise<Steered> {
  const configPath = path.join(repo, 'workflow.yaml');
  await fs.writeFile(configPath, yaml, 'utf8');
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  prepared.workflow.codex.command = FAKE_CODEX;
  for (const task of prepared.workflow.tasks) task.codex.command = FAKE_CODEX;
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
  const events: WorkflowEvent[] = [];
  // An interaction handler is what makes the run interactive, and Claude only keeps stdin open when it is.
  const runtime = createRuntime({ run, environment, secrets: [], logger: silentLogger, interactionHandler: async () => ({ kind: 'deny', message: 'no' }) });
  runtime.bus.onAny((event) => events.push(event));

  const finished = runtime.scheduler.execute();
  // The session id is the last thing set before a runner offers its channel — for Claude at spawn, for the
  // Codex app-server once the thread is open. Waiting on the pid alone would steer into a thread that has
  // not been created yet, which is a race a test must not have.
  await waitFor(() => run.tasks['a']?.state === 'running' && Boolean(run.tasks['a']?.attempts[0]?.sessionId));
  const ack = await runtime.controller.submit({ kind: 'prompt', taskId: 'a', text: MESSAGE, mode: 'steer' }, controlEnvelope('cli'));
  await finished;

  const attempt = run.tasks['a']!.attempts[0]!;
  const log = await fs.readFile(path.join(store.paths.attemptDir(run.runId, 'a', 1), 'events.jsonl'), 'utf8').catch(() => '');
  const entries = log.trim() ? log.trim().split('\n').map(parseTranscriptLine).filter((e): e is TranscriptEntry => e !== null) : [];
  return { delivery: attempt.prompts?.[0], ack, events, entries, state: run.tasks['a']!.state };
}

const CLAUDE_YAML = 'name: steer\nexecution:\n  workspaceStrategy: shared\n  maxConcurrency: 2\n  allowUnsafeSharedParallel: true\ntasks:\n  - id: a\n    parallelGroup: g\n    prompt: do it\n';
/** `a` fails once and `b` steers forever, so the run stays alive with `a` in a followable state. */
const FOLLOW_UP_YAML =
  'name: follow-up\nexecution:\n  workspaceStrategy: shared\n  maxConcurrency: 2\n  allowUnsafeSharedParallel: true\ntasks:\n  - id: a\n    parallelGroup: g\n    retries: 0\n    onFailure: continue\n    prompt: do it\n  - id: b\n    parallelGroup: g\n    prompt: hold\n';

const CODEX_YAML = 'name: steer\nagent: codex\nexecution:\n  workspaceStrategy: shared\ncodex:\n  transport: appServer\n  approvals: host\ntasks:\n  - id: a\n    model: fake-codex\n    prompt: do it\n';

const HAS_GIT = await gitAvailable('prompting end-to-end suite');

describe.skipIf(!HAS_GIT)('prompting a running task through the controller', () => {
  beforeAll(() => {
    clearDetectionCache();
    clearCodexDetectionCache();
  });

  it('steers a live Claude session and records the delivery on the attempt', async () => {
    const repo = await tmpGitRepo('cao-steer-claude-');
    const run = await steerOneTask(repo, CLAUDE_YAML, { FAKE_CLAUDE_MODE: 'steer', FAKE_CLAUDE_STEER_WAIT_MS: '6000' });

    // `accepted`, not `applied`: the CLI has the message and the acknowledgment is still to come, which is
    // exactly the difference §2.2 draws between the two ack statuses.
    expect(run.ack).toMatchObject({ status: 'accepted', reason: expect.stringMatching(/queued for "a"/) });
    expect(run.delivery).toMatchObject({ mode: 'steer', transport: 'claude-stream', state: 'accepted', text: MESSAGE, source: 'cli' });
    // The message really reached the worker: the second turn it started is what finished the task.
    expect(run.state).toBe('success');
    expect(run.entries).toContainEqual(expect.objectContaining({ kind: 'user', text: MESSAGE, deliveryId: run.delivery!.id }));
  });

  it('steers a live Codex app-server turn and records the turn it went into', async () => {
    const repo = await tmpGitRepo('cao-steer-codex-');
    const run = await steerOneTask(repo, CODEX_YAML, { FAKE_CODEX_MODE: 'steer', FAKE_CODEX_STEER_WAIT_MS: '6000' });

    // The app-server answers the steer itself, so the ack is `applied` the moment it is written.
    expect(run.ack).toMatchObject({ status: 'applied', reason: expect.stringMatching(/delivered to "a"/) });
    expect(run.delivery).toMatchObject({ mode: 'steer', transport: 'codex-app-server', state: 'accepted', turnId: 'turn-1', text: MESSAGE });
    expect(run.state).toBe('success');
    expect(run.entries).toContainEqual(expect.objectContaining({ kind: 'user', text: MESSAGE }));
  });

  it('records the run-level event without the message, and keeps the text out of events.jsonl', async () => {
    const repo = await tmpGitRepo('cao-steer-log-');
    const run = await steerOneTask(repo, CLAUDE_YAML, { FAKE_CLAUDE_MODE: 'steer', FAKE_CLAUDE_STEER_WAIT_MS: '6000' });

    const prompted = run.events.filter((e) => e.type === 'task.prompted');
    expect(prompted.map((e) => (e as { state: string }).state)).toEqual(['queued', 'accepted']);
    expect(prompted.at(-1)).toMatchObject({ taskId: 'a', attempt: 1, mode: 'steer', transport: 'claude-stream', state: 'accepted', deliveryId: run.delivery!.id });
    // §2.6 — the run log's own prompt lines carry the state, never the text. (`task.completed` quotes the
    // worker's result, which is the agent's words about the work, not the operator's message.)
    const runLog = await fs.readFile(path.join(repo, '.orchestrator', 'runs', run.events[0]!.runId, 'events.jsonl'), 'utf8');
    const lines = runLog.trim().split('\n').filter((line) => line.includes('"task.prompted"'));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain(MESSAGE);
  });

  it('carries a follow-up into the next attempt, resuming the session the task reported', async () => {
    const repo = await tmpGitRepo('cao-followup-claude-');
    const configPath = path.join(repo, 'workflow.yaml');
    // `a` fails its first attempt and `b` holds the run open, so the follow-up is taken by a live run.
    await fs.writeFile(configPath, `${FOLLOW_UP_YAML}`, 'utf8');
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const created = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
    const runtime = createRuntime({
      run: created,
      environment: {
        FAKE_CLAUDE_TASK_MODES: JSON.stringify({ b: 'steer' }),
        FAKE_CLAUDE_FAIL_UNTIL_ATTEMPT: JSON.stringify({ a: 2 }),
        FAKE_CLAUDE_STEER_WAIT_MS: '10000',
        // The fake CLI files no transcript anywhere, so `[D25]`'s check is pointed at a directory with no
        // `projects/` in it: the probe cannot tell, which is never a reason to refuse a follow-up.
        CLAUDE_CONFIG_DIR: path.join(repo, '.claude'),
      },
      secrets: [],
      logger: silentLogger,
      interactionHandler: async () => ({ kind: 'deny', message: 'no' }),
    });
    const finished = runtime.scheduler.execute();
    await waitFor(() => created.tasks['a']?.state === 'failed');
    const session = created.tasks['a']!.attempts[0]!.sessionId ?? created.tasks['a']!.attempts[0]!.usage?.sessionId;
    expect(session).toBeTruthy();

    const ack = await runtime.controller.submit({ kind: 'prompt', taskId: 'a', text: MESSAGE, mode: 'followUp' }, controlEnvelope('tui'));
    expect(ack).toMatchObject({ status: 'accepted', reason: expect.stringContaining(`continues session ${session}`) });

    await waitFor(() => created.tasks['a']!.attempts.length === 2 && Boolean(created.tasks['a']!.attempts[1]!.endedAt), 20_000);
    const second = created.tasks['a']!.attempts[1]!;
    // The real CLI was launched with `--resume <session>` and the operator's words in its prompt.
    expect(second).toMatchObject({ triggeredBy: 'user_input', resumedSessionId: session });
    const promptFile = await fs.readFile(path.join(store.paths.attemptDir(created.runId, 'a', 2), 'prompt.md'), 'utf8');
    expect(promptFile).toContain(MESSAGE);
    expect(created.tasks['a']!.followUps![0]).toMatchObject({ mode: 'followUp', state: 'delivered', carriedByAttempt: 2, source: 'tui' });

    await runtime.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await finished;
  }, 40_000);

  it('takes a prompt request another process wrote and writes the ack back to it', async () => {
    const repo = await tmpGitRepo('cao-prompt-inbox-');
    const configPath = path.join(repo, 'workflow.yaml');
    await fs.writeFile(configPath, CLAUDE_YAML, 'utf8');
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const created = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
    const runtime = createRuntime({
      run: created,
      environment: { FAKE_CLAUDE_MODE: 'steer', FAKE_CLAUDE_STEER_WAIT_MS: '10000' },
      secrets: [],
      logger: silentLogger,
      interactionHandler: async () => ({ kind: 'deny', message: 'no' }),
    });
    // The inbox `cao run` starts (§2.3): this is the whole path a second terminal's request takes.
    const unwatch = watchStopRequests({ paths: store.paths, runId: created.runId, controller: runtime.controller, onStop: () => undefined });
    const finished = runtime.scheduler.execute();
    try {
      await waitFor(() => created.tasks['a']?.state === 'running' && Boolean(created.tasks['a']?.attempts[0]?.sessionId));

      const request = controlRequest('prompt', { taskId: 'a', text: MESSAGE, mode: 'steer', source: 'another cao' });
      await writeControlRequest(store.paths, created.runId, request);
      let ack: Awaited<ReturnType<typeof readAck>> = null;
      await waitFor(() => {
        void readAck(store.paths, created.runId, request.id).then((a) => (ack = a));
        return ack !== null;
      }, 10_000);
      expect(ack).toMatchObject({ id: request.id, status: expect.stringMatching(/accepted|applied/) });

      await waitFor(() => (created.tasks['a']!.attempts[0]!.prompts?.length ?? 0) > 0);
      expect(created.tasks['a']!.attempts[0]!.prompts![0]).toMatchObject({ source: 'inbox', mode: 'steer', text: MESSAGE });
      // A run started by this `cao` advertises the kind, or the second terminal would not have offered it.
      expect(INBOX_REQUEST_KINDS).toContain('prompt');
    } finally {
      unwatch();
      await finished;
    }
  }, 40_000);

  it('refuses a follow-up to a task that has already succeeded, which is immutable', async () => {
    const repo = await tmpGitRepo('cao-steer-done-');
    const configPath = path.join(repo, 'workflow.yaml');
    // `b` holds the run open while `a` is finished with, so the refusal is the matrix's and not "the run has ended".
    await fs.writeFile(configPath, `${CLAUDE_YAML}  - id: b\n    parallelGroup: g\n    prompt: hold\n`, 'utf8');
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const created = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
    const runtime = createRuntime({
      run: created,
      environment: { FAKE_CLAUDE_TASK_MODES: JSON.stringify({ a: 'success', b: 'steer' }), FAKE_CLAUDE_STEER_WAIT_MS: '6000' },
      secrets: [],
      logger: silentLogger,
      interactionHandler: async () => ({ kind: 'deny', message: 'no' }),
    });
    const finished = runtime.scheduler.execute();
    await waitFor(() => created.tasks['a']?.state === 'success' && created.tasks['b']?.state === 'running');

    const ack = await runtime.controller.submit({ kind: 'prompt', taskId: 'a', text: MESSAGE, mode: 'steer' }, controlEnvelope('cli'));
    expect(ack).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/immutable/) });
    expect(created.tasks['a']!.attempts[0]!.prompts).toBeUndefined();

    await runtime.controller.submit({ kind: 'prompt', taskId: 'b', text: 'finish up', mode: 'steer' }, controlEnvelope('cli'));
    await finished;
  });
});
