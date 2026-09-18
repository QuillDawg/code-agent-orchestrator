/**
 * Prompting a task, the half that is not a transport (spec §3.5, `[D25]`, `[D27]`): the mode matrix, the
 * follow-up that becomes the next attempt, stop-and-continue, and the missing-session refusal.
 *
 * `test/unit/prompt-transport.test.ts` proves each transport's state machine and
 * `test/integration/prompting.test.ts` drives the real CLIs; this is the row-by-row table and the scheduler
 * behaviour around it, against a mock runner so every row is reachable without a process.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, waitFor } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { createRunController, type RunController } from '../../src/workflow/control/controller.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';
import { followUpAck, promptRow, selectPromptMode, MODE_LABEL } from '../../src/workflow/control/prompt.js';
import { adoptLegacyFollowUp, checkFollowUpSession, followUpText, pendingFollowUps, queueFollowUp, resumableSessionId } from '../../src/workflow/control/follow-up.js';
import { reconcileForResume } from '../../src/workflow/run-factory.js';
import { detectSessionPresence, unknownSessionPresence, type SessionProbe } from '../../src/runners/sessions.js';
import { claudeProjectSlug, claudeSessionPresence } from '../../src/runners/claude/session-file.js';
import { codexSessionPresence } from '../../src/runners/codex/session-file.js';
import { tmpDir } from '../helpers/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ResolvedTask, ResolvedWorkflow, TaskRunState, TaskState, WorkflowEvent } from 'code-agent-orchestrator-protocol';

const NL = String.fromCharCode(10);

async function wf(yaml: string): Promise<ResolvedWorkflow> {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join(NL));
  return workflow;
}

const stateIn = (state: TaskState, over: Partial<TaskRunState> = {}): TaskRunState =>
  ({ id: 'a', state, attempts: [], retryWindowStart: 1, ...over }) as TaskRunState;

// ---------------------------------------------------------------------------- the matrix (§3.5)

describe('which mode the §3.5 matrix offers', () => {
  it('offers steer to a running worker with a channel and stop-and-continue to one without', () => {
    expect(promptRow(stateIn('running'), true).mode).toBe('steer');
    expect(promptRow(stateIn('running'), false).mode).toBe('stopAndContinue');
  });

  it('offers a follow-up to every state a task stops in without succeeding', () => {
    for (const state of ['failed', 'blocked', 'cancelled', 'needs_input'] as const) {
      expect(promptRow(stateIn(state), false).mode, state).toBe('followUp');
    }
  });

  it('offers nothing to the four rows that have a different answer, and says which', () => {
    expect(promptRow(stateIn('waiting'), true).mode).toBeUndefined();
    expect(promptRow(stateIn('waiting'), true).reason).toContain('Answer the pending request first');
    expect(promptRow(stateIn('pending'), false).reason).toContain('Edit its prompt instead');
    expect(promptRow(stateIn('ready'), false).reason).toContain('Edit its prompt instead');
    // `[D27]`: a succeeded task is immutable, and so is a terminal skip.
    expect(promptRow(stateIn('success'), false).reason).toContain('immutable');
    expect(promptRow(stateIn('skipped'), false).reason).toContain('immutable');
    expect(promptRow(stateIn('awaiting_approval'), false).reason).toContain('Approve or reject it first');
  });

  it('honours a named mode only where the row agrees, and names the one that applies', () => {
    // Asking to steer something that has stopped is not a smaller follow-up: it is refused, with the way on.
    expect(selectPromptMode(stateIn('failed'), { hasChannel: false, requested: 'steer' }).reason).toContain('--follow-up');
    expect(selectPromptMode(stateIn('running'), { hasChannel: false, requested: 'steer' }).reason).toContain('--stop-and-continue');
    expect(selectPromptMode(stateIn('running'), { hasChannel: true, requested: 'followUp' }).reason).toContain('--steer');
    expect(selectPromptMode(stateIn('failed'), { hasChannel: false, requested: 'stopAndContinue' }).reason).toContain('--follow-up');
    // And a mode the row does offer passes straight through.
    expect(selectPromptMode(stateIn('running'), { hasChannel: true, requested: 'steer' }).mode).toBe('steer');
    expect(selectPromptMode(stateIn('failed'), { hasChannel: false, requested: 'followUp' }).mode).toBe('followUp');
    expect(MODE_LABEL.stopAndContinue).toBe('stop and continue');
  });

  /**
   * The composer has no flags. It picks the mode from the row it drew and is refused only when the task
   * moved between the frame and the submit — where "send it a follow-up instead (--follow-up)" told the
   * operator to type something their surface cannot type.
   */
  it('names the other mode without a flag when the sender has no command line', () => {
    const tui = (state: TaskRunState, requested: 'steer' | 'followUp' | 'stopAndContinue', hasChannel = false) =>
      selectPromptMode(state, { hasChannel, requested, source: 'tui' }).reason!;

    expect(tui(stateIn('failed'), 'steer')).toContain('Send it a follow-up instead');
    expect(tui(stateIn('failed'), 'stopAndContinue')).toContain('Send it a follow-up instead.');
    expect(tui(stateIn('running'), 'followUp', true)).toContain('Send it as a steer instead');
    for (const reason of [tui(stateIn('failed'), 'steer'), tui(stateIn('running'), 'steer'), tui(stateIn('running'), 'followUp', true)]) {
      expect(reason).not.toContain('--');
    }
    // A request file is another terminal's command line, so it keeps the flag.
    expect(selectPromptMode(stateIn('failed'), { hasChannel: false, requested: 'steer', source: 'inbox' }).reason).toContain('--follow-up');
  });
});

/**
 * The ack for a message that becomes the next attempt (§3.5).
 *
 * One function, because the run writes it when it takes the message and `cao task prompt` writes it when
 * nobody is executing the run - and the offline one had already drifted into different words and was the
 * only answer to a prompt that did not name the mode it chose.
 */
describe('what a task is told it is about to do with a message', () => {
  it('names the mode and the session, in the same words from the run and from the command', () => {
    expect(followUpAck('a', 'followUp', 's-1')).toBe('Follow-up: starting "a" again with your message. Its next attempt continues session s-1.');
    expect(followUpAck('a', 'followUp')).toContain('starts a fresh session with your message in the prompt');
    expect(followUpAck('a', 'stopAndContinue', 's-1')).toContain('Stop and continue: stopping the worker of "a"');
    for (const mode of ['followUp', 'stopAndContinue'] as const) expect(followUpAck('a', mode), mode).toMatch(/^(Follow-up|Stop and continue): /);
  });
});

// ---------------------------------------------------------------------------- the session check `[D25]`

const task = (over: Partial<ResolvedTask> = {}): ResolvedTask =>
  ({ id: 'a', agent: 'claude', workingDirectory: '/repo', retry: { resumeSession: true }, claude: {} , ...over }) as unknown as ResolvedTask;

const withAttempt = (sessionId?: string): TaskRunState =>
  stateIn('failed', { attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: 'x', cwd: '/repo', ...(sessionId ? { sessionId } : {}) }] as TaskRunState['attempts'] });

describe('the session a follow-up would continue (`[D25]`)', () => {
  const probe = (answer: Awaited<ReturnType<SessionProbe>>): SessionProbe => async () => answer;

  it('continues the session the task last reported', async () => {
    const check = await checkFollowUpSession(task(), withAttempt('sess-1'), { probe: probe('present') });
    expect(check).toEqual({ sessionId: 'sess-1' });
  });

  it('refuses when the transcript is gone in words that fit whichever mode asked, and names --fresh-session', async () => {
    const check = await checkFollowUpSession(task(), withAttempt('sess-1'), { probe: probe('missing') });
    expect(check.rejection).toContain('no longer on disk');
    expect(check.rejection).toContain('--fresh-session');
    // The one thing it must not do: quietly start a new session and say nothing.
    expect(check.rejection).toContain('silently start a new one');
    // This check guards the stop-and-continue row as well, where an operator who typed a sentence to a
    // running worker never asked for a follow-up and never ran a command that has that word in it.
    expect(check.rejection).toContain('Send the message again');
    expect(check.rejection).not.toContain('follow-up');
  });

  it('names a control the reader has: the flag on a command line, the key in the composer', async () => {
    // The same reasoning as `selectPromptMode`'s mode flags. A workspace operator has no command line to
    // type `--fresh-session` into, and the refusal that names one is a refusal they cannot act on.
    const cli = await checkFollowUpSession(task(), withAttempt('sess-1'), { probe: probe('missing'), source: 'cli' });
    expect(cli.rejection).toContain('--fresh-session');
    expect(cli.rejection).not.toContain('Ctrl+F');

    const tui = await checkFollowUpSession(task(), withAttempt('sess-1'), { probe: probe('missing'), source: 'tui' });
    expect(tui.rejection).toContain('Ctrl+F ("Start a fresh session")');
    expect(tui.rejection).not.toContain('--fresh-session');
  });

  it('starts fresh when asked, without consulting the disk at all', async () => {
    let probed = false;
    const check = await checkFollowUpSession(task(), withAttempt('sess-1'), {
      probe: async () => {
        probed = true;
        return 'missing';
      },
      freshSession: true,
    });
    expect(check).toEqual({});
    expect(probed).toBe(false);
  });

  it('says nothing about a task that never had a session, or one configured not to resume', async () => {
    expect(await checkFollowUpSession(task(), withAttempt(), { probe: probe('missing') })).toEqual({});
    const noResume = task({ retry: { resumeSession: false } as ResolvedTask['retry'] });
    expect(await checkFollowUpSession(noResume, withAttempt('sess-1'), { probe: probe('missing') })).toEqual({});
    expect(resumableSessionId(noResume, withAttempt('sess-1'))).toBeUndefined();
  });

  it('treats a probe that cannot tell as no reason to refuse', async () => {
    expect(await checkFollowUpSession(task(), withAttempt('sess-1'), { probe: probe('unknown') })).toEqual({ sessionId: 'sess-1' });
  });
});

// ---------------------------------------------------------------------------- the record on the task

describe('a follow-up on the task', () => {
  it('queues, carries its text into `userInput`, and stops being pending once an attempt takes it', () => {
    const state = withAttempt('sess-1');
    queueFollowUp(state, { source: 'tui', mode: 'followUp', text: 'also update the changelog', sessionId: 'sess-1' });
    expect(pendingFollowUps(state)).toHaveLength(1);
    expect(state.userInput).toBe('also update the changelog');
    expect(state.resumeSessionId).toBe('sess-1');

    queueFollowUp(state, { source: 'cli', mode: 'followUp', text: 'and the readme' });
    expect(followUpText(state)).toBe(`also update the changelog${NL}${NL}and the readme`);
    // A second follow-up with no session is a deliberate fresh start, and it wins.
    expect(state.resumeSessionId).toBeUndefined();
  });

  it('gives a run written before follow-ups were records the delivery its answer always was', () => {
    const carried = stateIn('failed', {
      userInput: 'use postgres',
      attempts: [{ number: 1, kind: 'task', triggeredBy: 'user_input', startedAt: 'x', cwd: '/repo' }] as TaskRunState['attempts'],
    });
    adoptLegacyFollowUp(carried);
    expect(carried.followUps).toHaveLength(1);
    expect(carried.followUps![0]).toMatchObject({ state: 'delivered', carriedByAttempt: 1, text: 'use postgres' });

    const owed = stateIn('needs_input', { userInput: 'use postgres' });
    adoptLegacyFollowUp(owed);
    expect(owed.followUps![0]!.state).toBe('queued');
    // Idempotent: a second resume does not add a second copy.
    adoptLegacyFollowUp(owed);
    expect(owed.followUps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------- through the scheduler

interface Harness {
  scheduler: WorkflowScheduler;
  controller: RunController;
  runner: MockRunner;
  bus: WorkflowEventBus;
  run: ReturnType<typeof makeRun>;
  events: WorkflowEvent[];
}

function harness(workflow: ResolvedWorkflow, runner: MockRunner): Harness {
  const run = makeRun(workflow);
  const bus = new WorkflowEventBus(run.runId);
  const events: WorkflowEvent[] = [];
  bus.onAny((e) => events.push(e));
  const scheduler = new WorkflowScheduler({
    run,
    store: new MemoryRunStore(),
    runners: new RunnerRegistry().register(runner),
    workspace: new MockWorkspace(workflow.repositoryRoot),
    bus,
    // No disk in a unit test: the probe answers "cannot tell", which is never a reason to refuse.
    sessionProbe: async () => 'unknown',
  });
  return { scheduler, controller: createRunController({ scheduler }), runner, bus, run, events };
}

/** `a` fails once and for all while `b` hangs, so the run stays alive with `a` in a followable state. */
const FAILING_PAIR = `
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    parallelGroup: g
    retries: 0
    onFailure: continue
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
`;

describe('a follow-up through the run controller (§3.5)', () => {
  it('starts a new attempt that continues the session and carries the message', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'hang' }]).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const ack = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'try it with -O2', mode: 'followUp' }, controlEnvelope('cli'));
    expect(ack.status).toBe('accepted');
    expect(ack.reason).toContain('continues session s-1');

    await waitFor(() => runner.calls.filter((c) => c.taskId === 'a').length === 2);
    const second = runner.calls.find((c) => c.taskId === 'a' && c.attempt === 2)!;
    expect(second.resumeSessionId).toBe('s-1');
    expect(second.prompt).toContain('try it with -O2');
    expect(second.prompt).toContain('Follow-up From The Operator');

    const state = h.run.tasks.a!;
    expect(state.attempts[1]).toMatchObject({ number: 2, triggeredBy: 'user_input', resumedSessionId: 's-1' });
    expect(state.followUps).toHaveLength(1);
    expect(state.followUps![0]).toMatchObject({ state: 'delivered', carriedByAttempt: 2, mode: 'followUp', source: 'cli' });

    // §2.6: the run log gets the summary, never the text.
    const prompted = h.events.filter((e) => e.type === 'task.prompted');
    expect(prompted.map((e) => (e as { state: string }).state)).toEqual(['queued', 'delivered']);
    expect(JSON.stringify(prompted)).not.toContain('-O2');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await execution;
  });

  it('starts a fresh session when asked, keeping the old attempt exactly as it was', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'hang' }]).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const ack = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'start over', mode: 'followUp', freshSession: true }, controlEnvelope('tui'));
    expect(ack.reason).toContain('fresh session');
    await waitFor(() => runner.calls.filter((c) => c.taskId === 'a').length === 2);
    const second = runner.calls.find((c) => c.taskId === 'a' && c.attempt === 2)!;
    expect(second.resumeSessionId).toBeUndefined();
    // The fresh prompt carries the message under `# User Input`, as `cao resume --input` has always done.
    expect(second.prompt).toContain('# User Input');
    expect(second.prompt).toContain('start over');
    expect(h.run.tasks.a!.attempts[0]).toMatchObject({ number: 1, sessionId: 's-1' });

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await execution;
  });

  it('refuses a follow-up whose session is gone, and takes it once --fresh-session is added', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'hang' }]).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    // This scheduler's probe says the transcript is gone, which is the one answer that stops a follow-up.
    (h.scheduler as unknown as { sessionProbe: SessionProbe }).sessionProbe = async () => 'missing';
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const refused = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'carry on', mode: 'followUp' }, controlEnvelope('cli'));
    expect(refused.status).toBe('rejected');
    expect(refused.reason).toContain('--fresh-session');
    expect(h.run.tasks.a!.state).toBe('failed');
    expect(h.run.tasks.a!.followUps).toBeUndefined();

    const taken = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'carry on', mode: 'followUp', freshSession: true }, controlEnvelope('cli'));
    expect(taken.status).toBe('accepted');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await execution;
  });

  it('stops a running worker and starts it again carrying the message, as one command with one ack', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'hang' }, { kind: 'hang' }]).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    const before = h.run.controls?.seen.length ?? 0;
    const ack = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'use the cache', mode: 'stopAndContinue' }, controlEnvelope('tui'));
    expect(ack.status).toBe('accepted');
    expect(ack.reason).toContain('Stop and continue: stopping the worker');
    // One command, one ack: the stop does not get an ack of its own.
    expect((h.run.controls?.seen.length ?? 0) - before).toBe(1);

    await waitFor(() => runner.calls.filter((c) => c.taskId === 'a').length === 2, 4000);
    const second = runner.calls.find((c) => c.taskId === 'a' && c.attempt === 2)!;
    expect(second.resumeSessionId).toBe('s-1');
    expect(second.prompt).toContain('use the cache');
    expect(h.run.tasks.a!.attempts[0]!.outcome).toBe('cancelled');
    expect(h.run.tasks.a!.followUps![0]).toMatchObject({ mode: 'stopAndContinue', state: 'delivered', carriedByAttempt: 2 });
    // The run log says what really happened to the task. It said "task manually restarted from dashboard",
    // which named neither the action (a message was sent) nor the surface (this one came from the CLI).
    const announced = h.events.filter((e) => e.type === 'workflow.warning' && 'code' in e && e.code === 'restart');
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ taskId: 'a', message: 'task started again to carry the message you sent' });

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await execution;
  });

  /**
   * `cao task prompt <task> --message ...` with no mode flag (§3.5).
   *
   * The command carries no mode, because the scheduler is the only thing that knows whether the attempt in
   * front of it has a live channel. A CLI that defaulted it to `followUp` refused every no-flag prompt sent
   * to a running task with "a follow-up has no attempt to start", which is the one sentence an operator who
   * named nothing cannot act on.
   */
  it('chooses the row itself when the caller named no mode, and says which it chose', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'hang' }]).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed' && h.run.tasks.b!.state === 'running');

    // `b` is running with a mock runner, which offers no channel: the stop-and-continue row.
    const running = await h.controller.submit({ kind: 'prompt', taskId: 'b', text: 'use the cache' }, controlEnvelope('cli'));
    expect(running.status).toBe('accepted');
    expect(running.reason).toContain('Stop and continue: stopping the worker of "b"');
    expect(h.run.tasks.b!.followUps![0]).toMatchObject({ mode: 'stopAndContinue' });

    // `a` has stopped: the follow-up row, and the ack names that instead.
    const stopped = await h.controller.submit({ kind: 'prompt', taskId: 'a', text: 'try it with -O2' }, controlEnvelope('cli'));
    expect(stopped.status).toBe('accepted');
    expect(stopped.reason).toContain('Follow-up: starting "a" again');
    expect(h.run.tasks.a!.followUps![0]).toMatchObject({ mode: 'followUp' });

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await execution;
  });

  it('refuses the rows that have a different answer, changing nothing', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'hang' }]).when('b', { kind: 'hang' });
    const h = harness(await wf(FAILING_PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const running = await h.controller.submit({ kind: 'prompt', taskId: 'b', text: 'x', mode: 'followUp' }, controlEnvelope('cli'));
    expect(running).toMatchObject({ status: 'rejected' });
    expect(running.reason).toContain('--stop-and-continue');
    const missing = await h.controller.submit({ kind: 'prompt', taskId: 'nope', text: 'x', mode: 'followUp' }, controlEnvelope('cli'));
    expect(missing.reason).toContain('no task "nope"');
    expect(h.run.tasks.b!.followUps).toBeUndefined();

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, controlEnvelope('cli'));
    await execution;
  });
});

// ---------------------------------------------------------------------------- offline, through a resume

describe('a follow-up carried by a resume', () => {
  const runFor = async (state: TaskState, over: Partial<TaskRunState> = {}) => {
    const workflow = await wf(FAILING_PAIR);
    const run = makeRun(workflow);
    run.tasks.a = stateIn(state, {
      attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: 'x', endedAt: 'y', outcome: 'crash', cwd: '.', sessionId: 'sess-9' }] as TaskRunState['attempts'],
      ...over,
    });
    run.tasks.b = stateIn('success', { id: 'b' });
    return run;
  };

  it('puts a stopped task back in the queue with the message on it', async () => {
    const run = await runFor('failed');
    const result = await reconcileForResume(run, { followUp: { taskId: 'a', text: 'try the other library' } });
    expect(run.tasks.a!.state).toBe('pending');
    expect(run.tasks.a!.resumeSessionId).toBe('sess-9');
    expect(pendingFollowUps(run.tasks.a!)).toHaveLength(1);
    expect(run.tasks.a!.userInput).toBe('try the other library');
    expect(result.rerun).toContain('a');
    // The retry budget is reset, or a task that had spent its retries would never run the new attempt.
    expect(run.tasks.a!.retryWindowStart).toBe(2);
  });

  it('starts fresh when the caller said so, and says so about a task that is not there', async () => {
    const run = await runFor('needs_input');
    await reconcileForResume(run, { followUp: { taskId: 'a', text: 'from the top', freshSession: true } });
    expect(run.tasks.a!.resumeSessionId).toBeUndefined();

    const missing = await runFor('failed');
    const result = await reconcileForResume(missing, { followUp: { taskId: 'nope', text: 'x' } });
    expect(result.notes.join(' ')).toContain('no task "nope"');
  });

  it('leaves `cao resume --input` doing exactly what it documents', async () => {
    const run = await runFor('needs_input');
    await reconcileForResume(run, { input: { taskId: 'a', text: 'use postgres' } });
    expect(run.tasks.a!.state).toBe('pending');
    expect(run.tasks.a!.userInput).toBe('use postgres');
    expect(run.tasks.a!.resumeSessionId).toBe('sess-9');
    expect(run.tasks.a!.followUps![0]).toMatchObject({ mode: 'followUp', source: 'cli', state: 'queued' });
  });
});

// ---------------------------------------------------------------------------- where each agent files a session

describe('finding the session on disk (`[D25]`, and the `sessions` doctor check of §3.7)', () => {
  it("finds a Claude transcript under the project slug, and under another project's when the tree has moved", async () => {
    const home = await tmpDir('cao-claude-home-');
    const cwd = process.platform === 'win32' ? ['C:', 'Projects', 'app'].join(path.sep) : '/projects/app';
    expect(claudeProjectSlug(cwd)).toMatch(/^[A-Za-z0-9-]+$/);
    const slug = claudeProjectSlug(cwd);
    await fs.mkdir(path.join(home, 'projects', slug), { recursive: true });
    await fs.writeFile(path.join(home, 'projects', slug, 'sess-1.jsonl'), '{}', 'utf8');
    const env = { CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv;

    expect(await claudeSessionPresence('sess-1', cwd, env)).toBe('present');
    // The worktree was removed and recreated elsewhere: the slug is wrong but the session is real.
    expect(await claudeSessionPresence('sess-1', path.join(home, 'somewhere-else'), env)).toBe('present');
    expect(await claudeSessionPresence('sess-2', cwd, env)).toBe('missing');
    // No projects directory at all is "cannot tell", never "gone".
    expect(await claudeSessionPresence('sess-1', cwd, { CLAUDE_CONFIG_DIR: path.join(home, 'nothing-here') } as NodeJS.ProcessEnv)).toBe('unknown');
    expect(await claudeSessionPresence('', cwd, env)).toBe('unknown');
  });

  it('finds a Codex rollout under the dated directories it files them in', async () => {
    const home = await tmpDir('cao-codex-home-');
    const day = path.join(home, 'sessions', '2026', '09', '18');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, 'rollout-2026-09-18T10-00-00-thread-9.jsonl'), '{}', 'utf8');
    const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;

    expect(await codexSessionPresence('thread-9', '/repo', env)).toBe('present');
    expect(await codexSessionPresence('thread-8', '/repo', env)).toBe('missing');
    expect(await codexSessionPresence('thread-9', '/repo', { CODEX_HOME: path.join(home, 'nothing-here') } as NodeJS.ProcessEnv)).toBe('unknown');
  });

  it('asks the right one per agent, and answers `unknown` for anything else', async () => {
    const home = await tmpDir('cao-probe-');
    const probe = detectSessionPresence({ CLAUDE_CONFIG_DIR: home, CODEX_HOME: home } as NodeJS.ProcessEnv);
    // Neither layout exists under this directory, so both say so rather than claiming the session is gone.
    expect(await probe(task(), 'sess-1', '/repo')).toBe('unknown');
    expect(await probe(task({ agent: 'codex' }), 'thread-1', '/repo')).toBe('unknown');
    expect(await probe(task({ agent: 'fable' as ResolvedTask['agent'] }), 'x', '/repo')).toBe('unknown');
    expect(await unknownSessionPresence(task(), 'x', '/repo')).toBe('unknown');
  });
});
