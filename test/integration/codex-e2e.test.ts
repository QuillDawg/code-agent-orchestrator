/**
 * End-to-end through the real service layer (loader → normalize → validate → runtime → scheduler →
 * CodexRunner → child process) with the fake Codex CLI, on both transports. No real Codex calls.
 *
 * Codex had unit coverage only, so a failure that only shows up once the scheduler is involved - a nudge
 * that does not resume the thread, a transient error that starts a fresh session, an attempt log that stops
 * before the outcome - was invisible. Every case here asserts the persisted run state, the stored
 * TaskResult and the attempt's events.jsonl, not just what the runner returned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearCodexDetectionCache } from '../../src/runners/codex/detect.js';
import { parseTranscriptLine, type TranscriptEntry } from '../../src/types/transcript.js';
import type { EnrichedTaskResult } from '../../src/types/result.js';
import type { Interaction, InteractionAnswer } from '../../src/types/interaction.js';
import { canAllowAlways } from '../../src/types/interaction.js';
import type { SchedulerDeps } from '../../src/workflow/scheduler.js';
import { tmpGitRepo, gitAvailable, waitFor, FAKE_CODEX } from '../helpers/index.js';

type Transport = 'exec' | 'appServer';

interface CodexTrace {
  taskId: string;
  attempt: number;
  scope: string;
  args: string[];
  prompt?: string;
  resumed?: boolean;
  transport?: string;
}

interface RunOptions {
  modes?: Record<string, string>;
  interactionHandler?: SchedulerDeps['interactionHandler'];
  env?: Record<string, string>;
}

function workflowYaml(transport: Transport, body: string, extra = ''): string {
  return [
    'name: codex-e2e',
    'agent: codex',
    'execution:',
    '  workspaceStrategy: shared',
    '  maxConcurrency: 4',
    'codex:',
    `  transport: ${transport}`,
    ...(extra ? extra.split('\n') : []),
    'tasks:',
    body,
    '',
  ].join('\n');
}

/** Prepare a workflow, point every task at the fake CLI and run it through the scheduler. */
async function prepare(repo: string, yaml: string, options: RunOptions = {}) {
  const configPath = path.join(repo, 'workflow.yaml');
  await fs.writeFile(configPath, yaml, 'utf8');
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo });
  requireValid(prepared);
  prepared.workflow.codex.command = FAKE_CODEX;
  for (const task of prepared.workflow.tasks) task.codex.command = FAKE_CODEX;
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
  const tracePath = path.join(repo, '.orchestrator', 'codex-trace.jsonl');
  const environment: Record<string, string> = {
    FAKE_CODEX_TRACE: tracePath,
    ...(options.modes ? { FAKE_CODEX_TASK_MODES: JSON.stringify(options.modes) } : {}),
    ...options.env,
  };
  const runtime = createRuntime({ run, environment, secrets: [], logger: silentLogger, interactionHandler: options.interactionHandler });
  return { run, store, runtime, tracePath };
}

async function execute(repo: string, yaml: string, options: RunOptions = {}) {
  const prepared = await prepare(repo, yaml, options);
  const result = await prepared.runtime.scheduler.execute();
  return { ...prepared, result, trace: await readTrace(prepared.tracePath) };
}

async function readTrace(file: string): Promise<CodexTrace[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CodexTrace);
}

async function attemptEvents(store: FileRunStore, runId: string, taskId: string, attempt: number): Promise<TranscriptEntry[]> {
  const file = path.join(store.paths.attemptDir(runId, taskId, attempt), 'events.jsonl');
  const text = await fs.readFile(file, 'utf8');
  return text.trim().split('\n').filter(Boolean).map(parseTranscriptLine).filter((entry): entry is TranscriptEntry => entry !== null);
}

async function storedResult(store: FileRunStore, runId: string, taskId: string): Promise<EnrichedTaskResult> {
  return JSON.parse(await fs.readFile(store.paths.resultFile(runId, taskId), 'utf8')) as EnrichedTaskResult;
}

const HAS_GIT = await gitAvailable('codex end-to-end suite');

describe.skipIf(!HAS_GIT)('codex end-to-end with the fake CLI', () => {
  beforeAll(() => clearCodexDetectionCache());

  for (const transport of ['exec', 'appServer'] as Transport[]) {
    describe(`${transport} transport`, () => {
      it('completes a task and persists the run state, the result and the attempt log', async () => {
        const repo = await tmpGitRepo(`cao-codex-${transport}-ok-`);
        const yaml = workflowYaml(transport, '  - id: build\n    prompt: do it');
        const { run, result, store } = await execute(repo, yaml);
        expect(result.state).toBe('completed');

        const persisted = await store.loadRun(run.runId);
        expect(persisted.tasks.build!.state).toBe('success');
        expect(persisted.tasks.build!.attempts).toHaveLength(1);
        expect(persisted.tasks.build!.attempts[0]!.outcome).toBe('success');
        expect(persisted.tasks.build!.attempts[0]!.usage?.sessionId).toBe(transport === 'exec' ? 'codex-exec-thread-1' : 'codex-thread-1');

        const stored = await storedResult(store, run.runId, 'build');
        expect(stored.status).toBe('success');
        expect(stored.summary).toContain('fake');

        const events = await attemptEvents(store, run.runId, 'build', 1);
        // An `exec` attempt says up front that nobody can be asked anything during it; both transports
        // then record the thread they are working in.
        if (transport === 'exec') expect(events[0]).toMatchObject({ kind: 'system', text: expect.stringContaining('cannot reach a human') });
        expect(events.some((e) => e.kind === 'system' && e.text.startsWith('thread '))).toBe(true);
        // The attempt log has to end with the outcome, or `cao logs` shows the work and never says how it went.
        expect(events[events.length - 1]).toMatchObject({ kind: 'result', status: 'success', isError: false });
      }, 60_000);

      it('asks a session that produced no valid completion object for it before spending a retry', async () => {
        const repo = await tmpGitRepo(`cao-codex-${transport}-nudge-`);
        const yaml = workflowYaml(transport, '  - id: chatty\n    prompt: do it');
        const { run, result, store, trace } = await execute(repo, yaml, { modes: { chatty: 'invalid' } });
        expect(result.state).toBe('completed');

        const persisted = await store.loadRun(run.runId);
        const chatty = persisted.tasks.chatty!;
        expect(chatty.state).toBe('success');
        expect(chatty.attempts.map((a) => a.outcome)).toEqual(['invalid_result', 'success']);
        expect(chatty.attempts.map((a) => a.triggeredBy)).toEqual(['initial', 'nudge']);
        const session = chatty.attempts[0]!.usage?.sessionId ?? chatty.attempts[0]!.sessionId;
        expect(session).toBeTruthy();
        expect(chatty.attempts[1]!.resumedSessionId).toBe(session);

        const calls = trace.filter((t) => t.taskId === 'chatty').sort((a, b) => a.attempt - b.attempt);
        expect(calls).toHaveLength(2);
        if (transport === 'exec') {
          // The second call resumes the recorded thread rather than starting a new one.
          expect(calls[1]!.scope).toBe('exec resume');
          expect(calls[1]!.args[calls[1]!.args.indexOf('resume') + 1]).toBe(session);
          expect(calls[1]!.prompt).toContain('# Completion Object Required');
        }

        expect((await storedResult(store, run.runId, 'chatty')).summary).toContain('resumed');
        const first = await attemptEvents(store, run.runId, 'chatty', 1);
        expect(first[first.length - 1]).toMatchObject({ kind: 'error' });
        const second = await attemptEvents(store, run.runId, 'chatty', 2);
        expect(second[0]).toMatchObject({ kind: 'system', text: `resumed session ${session}` });
        expect(second[second.length - 1]).toMatchObject({ kind: 'result', status: 'success' });
      }, 60_000);

      it('recovers from a transient failure by resuming the same thread', async () => {
        const repo = await tmpGitRepo(`cao-codex-${transport}-transient-`);
        const yaml = workflowYaml(transport, '  - id: flaky\n    retry:\n      transientDelay: 20ms\n    prompt: do it');
        const mode = transport === 'exec' ? 'api-error' : 'failure';
        const { run, result, store, trace } = await execute(repo, yaml, { modes: { flaky: mode } });
        expect(result.state).toBe('completed');

        const persisted = await store.loadRun(run.runId);
        const flaky = persisted.tasks.flaky!;
        expect(flaky.state).toBe('success');
        expect(flaky.attempts.map((a) => a.outcome)).toEqual(['api_error', 'success']);
        const session = flaky.attempts[0]!.usage?.sessionId ?? flaky.attempts[0]!.sessionId;
        expect(session).toBeTruthy();
        expect(flaky.attempts[1]!.resumedSessionId).toBe(session);
        if (transport === 'exec') {
          const calls = trace.filter((t) => t.taskId === 'flaky').sort((a, b) => a.attempt - b.attempt);
          expect(calls.map((c) => c.scope)).toEqual(['exec', 'exec resume']);
          expect(calls[1]!.prompt).toContain('# Session Resumed');
        }

        expect((await storedResult(store, run.runId, 'flaky')).status).toBe('success');
        const events = await attemptEvents(store, run.runId, 'flaky', 1);
        expect(events.some((e) => e.kind === 'error')).toBe(true);
        expect(events[events.length - 1]!.kind).toBe('error');
      }, 60_000);

      it('fails a task that runs past its timeout and leaves no process behind', async () => {
        const repo = await tmpGitRepo(`cao-codex-${transport}-timeout-`);
        const yaml = workflowYaml(transport, '  - id: slowpoke\n    timeout: 1500ms\n    retries: 0\n    prompt: do it');
        const { run, result, store } = await execute(repo, yaml, { modes: { slowpoke: 'hang' } });
        expect(result.state).toBe('failed');

        const persisted = await store.loadRun(run.runId);
        expect(persisted.tasks.slowpoke!.state).toBe('failed');
        expect(persisted.tasks.slowpoke!.reason).toBe('timeout');
        expect(persisted.tasks.slowpoke!.message).toMatch(/timed out after 1500ms/);
        // A timed-out attempt produces no completion object, so no result.json is written for it.
        expect(persisted.tasks.slowpoke!.result).toBeUndefined();
        expect(await fs.access(store.paths.resultFile(run.runId, 'slowpoke')).then(() => true, () => false)).toBe(false);

        const events = await attemptEvents(store, run.runId, 'slowpoke', 1);
        expect(events[events.length - 1]).toMatchObject({ kind: 'error', text: expect.stringContaining('timed out') });
      }, 60_000);

      it('cancels a turn in flight when the run is stopped', async () => {
        const repo = await tmpGitRepo(`cao-codex-${transport}-cancel-`);
        const yaml = workflowYaml(transport, '  - id: waiter\n    prompt: do it');
        const { run, store, runtime, tracePath } = await prepare(repo, yaml, { modes: { waiter: 'hang' } });
        const execution = runtime.scheduler.execute();
        await waitFor(() => run.tasks.waiter?.state === 'running' && run.tasks.waiter.attempts[0]?.pid !== undefined, 20_000);
        for (const start = Date.now(); !(await readTrace(tracePath)).some((t) => t.taskId === 'waiter'); ) {
          if (Date.now() - start > 20_000) throw new Error('the fake Codex CLI never wrote its trace line');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        runtime.scheduler.requestStop('cancel', 'signal');
        await runtime.processManager.shutdown('graceful');
        const result = await execution;
        expect(result.state).toBe('interrupted');

        const persisted = await store.loadRun(run.runId);
        expect(persisted.tasks.waiter!.state).toBe('cancelled');
        expect(persisted.tasks.waiter!.attempts[0]!.outcome).toBe('cancelled');
        const events = await attemptEvents(store, run.runId, 'waiter', 1);
        expect(events.some((e) => e.kind === 'system' && e.text.startsWith('thread '))).toBe(true);
      }, 60_000);
    });
  }

  describe('appServer transport, host-mediated turns', () => {
    const allow = async (interaction: Interaction, asked: Interaction[]): Promise<InteractionAnswer> => {
      asked.push(interaction);
      return interaction.kind === 'question' ? { kind: 'answer', answers: { choice: 'A' } } : { kind: 'allow', scope: 'once' };
    };

    it('routes a command approval to the host and records both sides in the attempt log', async () => {
      const repo = await tmpGitRepo('cao-codex-approval-');
      const asked: Interaction[] = [];
      const yaml = workflowYaml('appServer', '  - id: approve\n    prompt: do it', '  approvals: host');
      const { run, result, store } = await execute(repo, yaml, { modes: { approve: 'approval' }, interactionHandler: (i) => allow(i, asked) });
      expect(result.state).toBe('completed');
      expect(asked).toEqual([expect.objectContaining({ kind: 'permission', agent: 'codex', toolName: 'command', title: expect.stringContaining('npm test') })]);

      const persisted = await store.loadRun(run.runId);
      expect(persisted.tasks.approve!.state).toBe('success');
      expect(persisted.tasks.approve!.attempts[0]!.interactions).toEqual([expect.objectContaining({ kind: 'permission', answer: 'allow', source: 'handler' })]);
      expect((await storedResult(store, run.runId, 'approve')).status).toBe('success');
      const permissions = (await attemptEvents(store, run.runId, 'approve', 1)).filter((e) => e.kind === 'permission');
      expect(permissions).toHaveLength(2);
      expect(permissions[1]).toMatchObject({ decision: 'allow' });
    }, 60_000);

    it('routes a file-change approval to the host', async () => {
      const repo = await tmpGitRepo('cao-codex-file-approval-');
      const asked: Interaction[] = [];
      const yaml = workflowYaml('appServer', '  - id: edit\n    prompt: do it', '  approvals: host');
      const { run, result, store } = await execute(repo, yaml, { modes: { edit: 'file-approval' }, interactionHandler: (i) => allow(i, asked) });
      expect(result.state).toBe('completed');
      expect(asked[0]).toMatchObject({ kind: 'permission', toolName: 'fileChange', agent: 'codex' });
      const persisted = await store.loadRun(run.runId);
      expect(persisted.tasks.edit!.state).toBe('success');
      expect((await attemptEvents(store, run.runId, 'edit', 1)).filter((e) => e.kind === 'permission')).toHaveLength(2);
    }, 60_000);

    it('answers requestUserInput only when experimentalUserInput is on, and stops for a human otherwise', async () => {
      const asked: Interaction[] = [];
      const enabled = await tmpGitRepo('cao-codex-question-on-');
      const yamlOn = workflowYaml('appServer', '  - id: ask\n    prompt: do it', '  approvals: host\n  experimentalUserInput: true');
      const on = await execute(enabled, yamlOn, { modes: { ask: 'question' }, interactionHandler: (i) => allow(i, asked) });
      expect(on.result.state).toBe('completed');
      expect(asked[0]).toMatchObject({ kind: 'question', agent: 'codex', questions: [expect.objectContaining({ question: 'Which?' })] });
      const answered = await on.store.loadRun(on.run.runId);
      expect(answered.tasks.ask!.state).toBe('success');
      expect((await attemptEvents(on.store, on.run.runId, 'ask', 1)).filter((e) => e.kind === 'question')).toHaveLength(2);

      const gatedAsked: Interaction[] = [];
      const gated = await tmpGitRepo('cao-codex-question-off-');
      const yamlOff = workflowYaml('appServer', '  - id: ask\n    prompt: do it', '  approvals: host');
      const off = await execute(gated, yamlOff, { modes: { ask: 'question' }, interactionHandler: (i) => allow(i, gatedAsked) });
      expect(gatedAsked).toEqual([]);
      const stopped = await off.store.loadRun(off.run.runId);
      expect(stopped.tasks.ask!.state).toBe('needs_input');
      const stored = await storedResult(off.store, off.run.runId, 'ask');
      expect(stored.status).toBe('needs_input');
      // The question Codex actually asked, not a fixed sentence about a configuration key.
      expect(stored.error).toContain('Codex asked "Which?"');
      expect(stored.error).toMatch(/codex.experimentalUserInput/);
    }, 90_000);

    it('reports an interrupted turn as a failure that kept partial work', async () => {
      const repo = await tmpGitRepo('cao-codex-interrupted-');
      const yaml = workflowYaml('appServer', '  - id: stopped\n    retries: 0\n    prompt: do it');
      const { run, result, store } = await execute(repo, yaml, { modes: { stopped: 'interrupted' } });
      expect(result.state).toBe('failed');
      const persisted = await store.loadRun(run.runId);
      expect(persisted.tasks.stopped!.state).toBe('failed');
      expect(persisted.tasks.stopped!.reason).toBe('crash');
      expect(persisted.tasks.stopped!.message).toMatch(/status interrupted/);
      const events = await attemptEvents(store, run.runId, 'stopped', 1);
      expect(events[events.length - 1]).toMatchObject({ kind: 'error', text: expect.stringContaining('interrupted') });
    }, 60_000);

    it('gives up on a turn that keeps failing once the transient budget is spent', async () => {
      const repo = await tmpGitRepo('cao-codex-failed-turn-');
      const yaml = workflowYaml('appServer', '  - id: doomed\n    retries: 0\n    retry:\n      transientAttempts: 1\n      transientDelay: 20ms\n      resumeSession: false\n    prompt: do it');
      const { run, result, store } = await execute(repo, yaml, { modes: { doomed: 'failure' } });
      expect(result.state).toBe('failed');
      const persisted = await store.loadRun(run.runId);
      expect(persisted.tasks.doomed!.state).toBe('failed');
      expect(persisted.tasks.doomed!.reason).toBe('api_error');
      expect(persisted.tasks.doomed!.attempts.every((a) => a.outcome === 'api_error')).toBe(true);
      expect(persisted.tasks.doomed!.attempts.length).toBeGreaterThan(1);
      expect(persisted.tasks.doomed!.message).toMatch(/overloaded/);
      const events = await attemptEvents(store, run.runId, 'doomed', 1);
      expect(events[events.length - 1]).toMatchObject({ kind: 'error', text: expect.stringContaining('overloaded') });
    }, 60_000);

    it('retries an overloaded thread/start instead of failing the task', async () => {
      const repo = await tmpGitRepo('cao-codex-overload-');
      const yaml = workflowYaml('appServer', '  - id: busy\n    prompt: do it');
      const { run, result, store } = await execute(repo, yaml, { modes: { busy: 'overload-once' } });
      expect(result.state).toBe('completed');
      const persisted = await store.loadRun(run.runId);
      expect(persisted.tasks.busy!.state).toBe('success');
      // One attempt: the -32001 retry happens inside the transport, not by re-running the task.
      expect(persisted.tasks.busy!.attempts).toHaveLength(1);
      expect((await storedResult(store, run.runId, 'busy')).status).toBe('success');
    }, 60_000);
  });
});

/**
 * The H3.7 acceptance matrix for Codex, rows 6-10, driven through the scheduler against the fake CLI in
 * both configurations: **attended** (an interaction handler is registered) and **headless** (none is).
 *
 * The fake validates every answer against the app-server protocol schemas of codex-cli 0.154.0, so a
 * decision or an answer map of the wrong shape fails the turn instead of being quietly accepted. What CAO
 * actually put on the wire is asserted from the `response:` lines the fake echoes to stderr, which the
 * runner records in the attempt's events.jsonl.
 */
describe.skipIf(!HAS_GIT)('blocked on a human: Codex (H3.7 rows 6-10)', () => {
  beforeAll(() => clearCodexDetectionCache());

  /** The wire payloads the fake received for its own requests, in order. */
  async function wireResponses(store: FileRunStore, runId: string, taskId: string, attempt = 1): Promise<Array<Record<string, unknown>>> {
    const events = await attemptEvents(store, runId, taskId, attempt);
    return events
      .filter((e): e is Extract<TranscriptEntry, { kind: 'stderr' }> => e.kind === 'stderr' && e.text.startsWith('response:'))
      .map((e) => JSON.parse(e.text.slice('response:'.length)) as Record<string, unknown>);
  }

  const HOST = '  approvals: host';

  it('row 6: a command approval round-trips allow-once, allow-always and decline', async () => {
    // allow once -> "accept"
    const once = await tmpGitRepo('cao-h3-cmd-once-');
    const onceAsked: Interaction[] = [];
    const onceRun = await execute(once, workflowYaml('appServer', '  - id: approve\n    prompt: do it', HOST), {
      modes: { approve: 'approval' },
      interactionHandler: async (i) => { onceAsked.push(i); return { kind: 'allow', scope: 'once' }; },
    });
    expect(onceRun.result.state).toBe('completed');
    // The server offered `accept` and `decline` only, so "allow for the rest of this task" is not on offer.
    expect(canAllowAlways(onceAsked[0]!)).toBe(false);
    expect(await wireResponses(onceRun.store, onceRun.run.runId, 'approve')).toEqual([expect.objectContaining({ result: { decision: 'accept' } })]);

    // allow always, with the amendment the server proposed -> acceptWithExecpolicyAmendment
    const always = await tmpGitRepo('cao-h3-cmd-always-');
    const alwaysAsked: Interaction[] = [];
    const alwaysRun = await execute(always, workflowYaml('appServer', '  - id: approve\n    prompt: do it', HOST), {
      modes: { approve: 'approval-always' },
      interactionHandler: async (i) => { alwaysAsked.push(i); return { kind: 'allow', scope: 'always' }; },
    });
    expect(alwaysRun.result.state).toBe('completed');
    expect(canAllowAlways(alwaysAsked[0]!)).toBe(true);
    expect(await wireResponses(alwaysRun.store, alwaysRun.run.runId, 'approve')).toEqual([
      expect.objectContaining({ result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } } } }),
    ]);

    // decline -> the agent keeps its turn and finishes it
    const declined = await tmpGitRepo('cao-h3-cmd-decline-');
    const declineRun = await execute(declined, workflowYaml('appServer', '  - id: approve\n    prompt: do it', HOST), {
      modes: { approve: 'approval-decline' },
      interactionHandler: async () => ({ kind: 'deny', message: 'not on my machine' }),
    });
    expect(declineRun.result.state).toBe('completed');
    expect(await wireResponses(declineRun.store, declineRun.run.runId, 'approve')).toEqual([expect.objectContaining({ result: { decision: 'decline' } })]);
    const persisted = await declineRun.store.loadRun(declineRun.run.runId);
    expect(persisted.tasks.approve!.attempts[0]!.interactions).toEqual([expect.objectContaining({ answer: 'deny', source: 'handler' })]);
  }, 90_000);

  it('row 7: a file-change approval honours grantRoot as an accept for the session', async () => {
    const repo = await tmpGitRepo('cao-h3-file-always-');
    const asked: Interaction[] = [];
    const { run, result, store } = await execute(repo, workflowYaml('appServer', '  - id: edit\n    prompt: do it', HOST), {
      modes: { edit: 'file-approval' },
      interactionHandler: async (i) => { asked.push(i); return { kind: 'allow', scope: 'always' }; },
    });
    expect(result.state).toBe('completed');
    expect(canAllowAlways(asked[0]!)).toBe(true);
    // A file-change response has no amendment variant at all: the granted root is honoured by accepting for
    // the session. Sending the command form here would fail the fake's own schema check.
    expect(await wireResponses(store, run.runId, 'edit')).toEqual([expect.objectContaining({ result: { decision: 'acceptForSession' } })]);
  }, 60_000);

  it('rows 6-7 headless: a task configured for host approvals pauses instead of failing', async () => {
    const repo = await tmpGitRepo('cao-h3-host-headless-');
    const { run, result, store } = await execute(repo, workflowYaml('appServer', '  - id: approve\n    retries: 0\n    prompt: do it', HOST), { modes: { approve: 'approval' } });
    expect(result.state).toBe('paused');
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.approve!.state).toBe('needs_input');
    const stored = await storedResult(store, run.runId, 'approve');
    expect(stored.error).toContain('codex.approvals: host');
    expect(stored.error).toContain('codex.approvals: autoReview');
  }, 60_000);

  it('row 8: a multi-question requestUserInput is answered by question id', async () => {
    const repo = await tmpGitRepo('cao-h3-question-multi-');
    const asked: Interaction[] = [];
    const { run, result, store } = await execute(repo, workflowYaml('appServer', '  - id: ask\n    prompt: do it', `${HOST}\n  experimentalUserInput: true`), {
      modes: { ask: 'question-multi' },
      interactionHandler: async (i): Promise<InteractionAnswer> => {
        asked.push(i);
        return { kind: 'answer', answers: { 'Which database?': 'postgres', 'Deploy where?': 'eu-west-1' } };
      },
    });
    expect(result.state).toBe('completed');
    // Both questions reach the dashboard with their ids, their headers and their option descriptions; a
    // question with no options at all (the server's `isOther` free-text form) survives as an empty list.
    expect(asked[0]!.questions).toEqual([
      { id: 'db', question: 'Which database?', header: 'Database', options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }], multiSelect: false },
      { id: 'deploy', question: 'Deploy where?', header: 'Deploy', options: [], multiSelect: false },
    ]);
    expect(asked[0]!.title).toBe('Which database? (+1 more)');
    // The dashboard keys its answers by question text; the wire wants the server's own ids.
    expect(await wireResponses(store, run.runId, 'ask')).toEqual([
      expect.objectContaining({ result: { answers: { db: { answers: ['postgres'] }, deploy: { answers: ['eu-west-1'] } } } }),
    ]);
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.ask!.state).toBe('success');
  }, 60_000);

  it('row 8 headless: an enabled question nobody can answer is declined and quoted in the result', async () => {
    const repo = await tmpGitRepo('cao-h3-question-headless-');
    const { run, result, store } = await execute(repo, workflowYaml('appServer', '  - id: ask\n    retries: 0\n    prompt: do it', '  experimentalUserInput: true'), { modes: { ask: 'question' } });
    expect(result.state).toBe('paused');
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.ask!.state).toBe('needs_input');
    const stored = await storedResult(store, run.runId, 'ask');
    expect(stored.error).toContain('Codex asked "Which?"');
    // The switch is already on, so the advice is to attach a dashboard, not to set the switch again.
    expect(stored.error).toContain('with the dashboard attached');
    expect(stored.error).not.toContain('codex.experimentalUserInput: true');
    // Declined through the protocol, not by killing the process: the worker had its turn to finish.
    expect(await wireResponses(store, run.runId, 'ask')).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: -32000 }) })]);
    const events = await attemptEvents(store, run.runId, 'ask', 1);
    expect(events.some((e) => e.kind === 'system' && e.text.includes('was killed'))).toBe(false);
    expect(events[events.length - 1]).toMatchObject({ kind: 'result', status: 'needs_input' });
  }, 60_000);

  it('row 9: a disabled question is declined through the protocol and the worker keeps its turn', async () => {
    // The worker can carry on without an answer: its own result stands, and the question is only a warning.
    const recovers = await tmpGitRepo('cao-h3-question-recovers-');
    const carried = await execute(recovers, workflowYaml('appServer', '  - id: ask\n    prompt: do it', HOST), { modes: { ask: 'question-recovers' }, interactionHandler: async () => ({ kind: 'allow', scope: 'once' }) });
    expect(carried.result.state).toBe('completed');
    const persisted = await carried.store.loadRun(carried.run.runId);
    expect(persisted.tasks.ask!.state).toBe('success');
    expect((await storedResult(carried.store, carried.run.runId, 'ask')).summary).toBe('fake app-server continued without an answer');
    // Refused with -32601: with the capability off, the method genuinely is not one this client implements.
    expect(await wireResponses(carried.store, carried.run.runId, 'ask')).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: -32601 }) })]);
    const events = await attemptEvents(carried.store, carried.run.runId, 'ask', 1);
    // The process was not killed, so the work the worker did after the decline is still there.
    expect(events.some((e) => e.kind === 'tool_result' && e.text === 'built')).toBe(true);
    expect(events.some((e) => e.kind === 'system' && e.text.includes('was killed'))).toBe(false);
    expect(events.some((e) => e.kind === 'question' && e.answer?.startsWith('declined:'))).toBe(true);
  }, 60_000);

  it('unknown and permission-affecting server requests keep failing closed', async () => {
    const repo = await tmpGitRepo('cao-h3-unknown-');
    const asked: Interaction[] = [];
    const { run, result, store } = await execute(repo, workflowYaml('appServer', '  - id: probe\n    prompt: do it', `${HOST}\n  experimentalUserInput: true`), {
      modes: { probe: 'unknown-request' },
      interactionHandler: async (i) => { asked.push(i); return { kind: 'allow', scope: 'always' }; },
    });
    expect(result.state).toBe('completed');
    // Neither `item/permissions/requestApproval` nor an MCP elicitation is ever put in front of a human or
    // answered on their behalf, even with a dashboard attached and every experimental switch on.
    expect(asked).toEqual([]);
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.probe!.state).toBe('success');
    const events = await attemptEvents(store, run.runId, 'probe', 1);
    const refusals = events.filter((e) => e.kind === 'system' && e.text.startsWith('refused unsupported Codex request'));
    expect(refusals.map((e) => (e as Extract<TranscriptEntry, { kind: 'system' }>).text)).toEqual([
      'refused unsupported Codex request item/permissions/requestApproval',
      'refused unsupported Codex request mcpServer/elicitation/request',
    ]);
    const unsupported = events
      .filter((e): e is Extract<TranscriptEntry, { kind: 'stderr' }> => e.kind === 'stderr' && e.text.startsWith('unsupported:'))
      .map((e) => JSON.parse(e.text.slice('unsupported:'.length)) as { error?: { code?: number } });
    expect(unsupported.map((u) => u.error?.code)).toEqual([-32601, -32601]);
  }, 60_000);

  for (const attended of [false, true]) {
    it(`row 10 ${attended ? 'attended' : 'headless'}: codex exec turns a rejected approval into needs_input`, async () => {
      const repo = await tmpGitRepo(`cao-h3-exec-approval-${attended ? 'on' : 'off'}-`);
      const asked: Interaction[] = [];
      const { run, result, store } = await execute(repo, workflowYaml('exec', '  - id: blocked\n    retries: 0\n    prompt: do it'), {
        modes: { blocked: 'exec-approval' },
        ...(attended ? { interactionHandler: async (i: Interaction): Promise<InteractionAnswer> => { asked.push(i); return { kind: 'allow', scope: 'once' }; } } : {}),
      });
      // `codex exec` has no channel for approvals, so a dashboard changes nothing: it is never asked.
      expect(asked).toEqual([]);
      expect(result.state).toBe('paused');
      const persisted = await store.loadRun(run.runId);
      expect(persisted.tasks.blocked!.state).toBe('needs_input');
      expect(persisted.tasks.blocked!.attempts).toHaveLength(1);
      expect(persisted.tasks.blocked!.attempts[0]!.outcome).toBe('needs_input');

      const stored = await storedResult(store, run.runId, 'blocked');
      expect(stored.status).toBe('needs_input');
      // What Codex wanted, quoted, plus the command it was about and the option that would have allowed it.
      expect(stored.error).toContain('command execution approval is not supported in exec mode');
      expect(stored.error).toContain('npm publish --tag latest');
      expect(stored.error).toContain('codex.transport: appServer');
      expect(stored.error).toContain('codex.approvals: host');
      expect(stored.warnings).toEqual(['Codex exited with code 1']);

      const events = await attemptEvents(store, run.runId, 'blocked', 1);
      expect(events[0]).toMatchObject({ kind: 'system', text: expect.stringContaining('cannot reach a human') });
      expect(events.some((e) => e.kind === 'error' && e.text.includes('not supported in exec mode'))).toBe(true);
      expect(events[events.length - 1]).toMatchObject({ kind: 'result', status: 'needs_input' });

      // The run log says once, per task, that nobody could have been reached during it.
      const runEvents = (await fs.readFile(store.paths.eventsFile(run.runId), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; code?: string; taskId?: string; message?: string });
      const notices = runEvents.filter((e) => e.type === 'workflow.warning' && e.taskId === 'blocked' && e.message?.includes('cannot reach a human'));
      expect(notices).toHaveLength(1);
    }, 60_000);
  }

  it('states the exec transport limit once per task, not once per attempt', async () => {
    const repo = await tmpGitRepo('cao-h3-exec-notice-');
    // Two attempts (the nudge resumes the same session) and two tasks: two notices, not four.
    const yaml = workflowYaml('exec', '  - id: chatty\n    prompt: do it\n  - id: quiet\n    prompt: do it');
    const { run, store } = await execute(repo, yaml, { modes: { chatty: 'invalid' } });
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.chatty!.attempts).toHaveLength(2);
    const runEvents = (await fs.readFile(store.paths.eventsFile(run.runId), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; taskId?: string; message?: string });
    const notices = runEvents.filter((e) => e.type === 'workflow.warning' && e.message?.includes('cannot reach a human'));
    expect(notices.map((n) => n.taskId).sort()).toEqual(['chatty', 'quiet']);
    // Both attempts still open their own log with it, so `cao logs` on either says so.
    for (const attempt of [1, 2]) {
      const events = await attemptEvents(store, run.runId, 'chatty', attempt);
      expect(events.some((e) => e.kind === 'system' && e.text.includes('cannot reach a human'))).toBe(true);
    }
  }, 60_000);

  it('row 10: codex exec turns a rejected question into needs_input naming the option that enables one', async () => {
    const repo = await tmpGitRepo('cao-h3-exec-question-');
    const { run, result, store } = await execute(repo, workflowYaml('exec', '  - id: asked\n    retries: 0\n    prompt: do it'), { modes: { asked: 'exec-user-input' } });
    expect(result.state).toBe('paused');
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.asked!.state).toBe('needs_input');
    // Exit 0 and no schema-valid final answer: this used to be an `invalid_result`, which spent a nudge and
    // then a retry on a session that could never have finished.
    expect(persisted.tasks.asked!.attempts).toHaveLength(1);
    const stored = await storedResult(store, run.runId, 'asked');
    expect(stored.error).toContain('request_user_input is not supported in exec mode');
    expect(stored.error).toContain('codex.experimentalUserInput: true');
    expect(stored.followUp).toEqual([expect.stringContaining('codex.transport: appServer')]);
  }, 60_000);
});
