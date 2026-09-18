/**
 * Steering a live worker, per transport (spec §3.5 mechanism column, §2.6, §7.1-§7.2; `[D23]`, `[D24]`,
 * `[D26]`).
 *
 * One state machine per transport, and each of them is only ever wrong in production: a delivery stuck at
 * `queued` forever, an acknowledgment attached to the wrong message, a `turn/start` that the server quietly
 * turned into a steer. So every transition is driven here against the fakes, through the real runners.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ClaudeRunner } from '../../src/runners/claude/claude-runner.js';
import { CodexRunner } from '../../src/runners/codex/codex-runner.js';
import { clearDetectionCache, detectClaude } from '../../src/runners/claude/detect.js';
import { clearCodexDetectionCache } from '../../src/runners/codex/detect.js';
import { ProcessManager } from '../../src/execution/process-manager.js';
import { parseTranscriptLine, type ResolvedTask, type TranscriptEntry } from 'code-agent-orchestrator-protocol';
import type { AttemptChannel, RunnerHooks, RunnerOutcome, SteerResult } from '../../src/runners/task-runner.js';
import { FAKE_CLAUDE, FAKE_CODEX, tmpDir } from '../helpers/index.js';

interface Steered {
  outcome: RunnerOutcome;
  /** What `steer` answered, in the order the messages were sent. */
  sent: SteerResult[];
  /** Every later state change, as `[deliveryId, update]`. */
  updates: Array<[string, SteerResult]>;
  /** Whether the runner offered a live channel at all — the difference between a transport and `none`. */
  channelOffered: boolean;
  entries: TranscriptEntry[];
  persisted: TranscriptEntry[];
  stderr: string[];
  argv: string[];
}

/** The state a delivery ended in: its first answer, then whatever moved it afterwards. */
function finalState(run: Steered, index = 0, id = `D${index + 1}`): SteerResult {
  const last = [...run.updates].reverse().find(([updated]) => updated === id);
  return last ? last[1] : run.sent[index]!;
}

/**
 * Run one attempt and steer `messages` into it as soon as the runner offers a channel. Nothing is faked
 * between the test and the worker: the message really goes down the CLI's stdin (or the app-server's
 * stdio), and what comes back is what the runner made of the CLI's answer.
 */
async function steerThrough(
  agent: 'claude' | 'codex',
  mode: string,
  messages: string[],
  extraEnv: Record<string, string> = {},
  taskBits: Partial<ResolvedTask> = {},
  resumeSessionId?: string,
  runnerBits: { callTimeoutMs?: number } = {},
): Promise<Steered> {
  clearDetectionCache();
  clearCodexDetectionCache();
  const dir = await tmpDir(`cao-steer-${agent}-`);
  const attemptDir = path.join(dir, 'attempt');
  const entries: TranscriptEntry[] = [];
  const stderr: string[] = [];
  const sent: SteerResult[] = [];
  const updates: Array<[string, SteerResult]> = [];
  let delivered: Promise<void> = Promise.resolve();
  let channelOffered = false;

  const hooks: RunnerHooks = {
    onActivity: () => {},
    onOutput: (stream, line) => {
      if (stream === 'stderr') stderr.push(line);
    },
    onProcess: () => {},
    onTranscript: (e) => entries.push(e),
    onUsage: () => {},
    onFileChange: () => {},
    onInteraction: () => Promise.reject(new Error('no interaction expected')),
    onChannel: (channel: AttemptChannel) => {
      channelOffered = true;
      delivered = (async () => {
        for (const [index, text] of messages.entries()) sent.push(await channel.steer(text, { id: `D${index + 1}` }));
      })();
    },
    onSteerUpdate: (id, update) => updates.push([id, update]),
  };

  const envKey = agent === 'claude' ? 'FAKE_CLAUDE_MODE' : 'FAKE_CODEX_MODE';
  const trace = path.join(dir, 'trace.jsonl');
  const traceKey = agent === 'claude' ? 'FAKE_CLAUDE_TRACE' : 'FAKE_CODEX_TRACE';
  const runner =
    agent === 'claude'
      ? new ClaudeRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CLAUDE } })
      : new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX }, ...runnerBits });
  const outcome = await runner.run(
    {
      runId: 'r1',
      task: { id: 'a', claude: {}, codex: {}, ...taskBits } as ResolvedTask,
      attempt: 1,
      prompt: 'do it',
      cwd: dir,
      env: { [envKey]: mode, [traceKey]: trace, ...extraEnv },
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      attemptDir,
      canInteract: true,
      resumeSessionId,
    },
    hooks,
  );
  await delivered;
  const log = await fs.readFile(path.join(attemptDir, 'events.jsonl'), 'utf8').catch(() => '');
  const persisted = log.trim() ? log.trim().split('\n').map(parseTranscriptLine).filter((e): e is TranscriptEntry => e !== null) : [];
  const traceText = await fs.readFile(trace, 'utf8').catch(() => '');
  const argv = traceText.trim() ? ((JSON.parse(traceText.trim().split('\n')[0]!) as { args?: string[] }).args ?? []) : [];
  return { outcome, sent, updates, channelOffered, entries, persisted, stderr, argv };
}

describe('Claude: steering a live stream-json session', () => {
  beforeEach(() => clearDetectionCache());
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_NO_REPLAY;
    clearDetectionCache();
  });

  it('passes --replay-user-messages only when the installed CLI advertises it, and never in deny mode', async () => {
    const supported = await detectClaude(FAKE_CLAUDE);
    expect(supported).toMatchObject({ found: true, replayUserMessages: true, capabilities: expect.arrayContaining(['replayUserMessages']) });

    process.env.FAKE_CLAUDE_NO_REPLAY = '1';
    clearDetectionCache();
    const older = await detectClaude(FAKE_CLAUDE);
    expect(older.replayUserMessages).toBe(false);
    expect(older.capabilities).not.toContain('replayUserMessages');
  });

  it('queues the message, then accepts it when the CLI echoes it back', async () => {
    const run = await steerThrough('claude', 'steer', ['focus on the tests']);

    // The flag is on the command line, and the echo is what moved the delivery on.
    expect(run.argv).toContain('--replay-user-messages');
    expect(run.sent[0]).toMatchObject({ transport: 'claude-stream', state: 'queued' });
    expect(run.updates).toEqual([['D1', expect.objectContaining({ transport: 'claude-stream', state: 'accepted' })]]);
    // The queued message really started a second turn, and that turn's result is the attempt's outcome.
    expect(run.outcome).toMatchObject({ kind: 'result', result: { status: 'success', data: { steered: 'focus on the tests' } } });
  });

  it('leaves it queued until the turn boundary when the CLI cannot echo, then accepts it', async () => {
    // Set on this process too, because the capability probe runs here and the worker inherits it: an older
    // CLI neither advertises the flag nor accepts it.
    process.env.FAKE_CLAUDE_NO_REPLAY = '1';
    const run = await steerThrough('claude', 'steer', ['focus on the tests']);

    expect(run.argv).not.toContain('--replay-user-messages');
    expect(run.sent[0]).toMatchObject({ state: 'queued', reason: expect.stringMatching(/does not echo user messages/) });
    expect(run.updates).toEqual([['D1', expect.objectContaining({ state: 'accepted', reason: expect.stringMatching(/started a new turn/) })]]);
    expect(run.outcome).toMatchObject({ kind: 'result', result: { data: { steered: 'focus on the tests' } } });
  });

  it('records the operator\'s message as a `user` transcript entry, in the attempt log too', async () => {
    const run = await steerThrough('claude', 'steer', ['focus on the tests']);

    expect(run.entries).toContainEqual(expect.objectContaining({ kind: 'user', text: 'focus on the tests', deliveryId: 'D1' }));
    expect(run.persisted).toContainEqual(expect.objectContaining({ kind: 'user', text: 'focus on the tests', deliveryId: 'D1' }));
  });

  it('reports no transport at all in deny mode, where stdin was closed at spawn', async () => {
    // Deny mode is what a headless run uses: the prompt is written and stdin is closed behind it, so there
    // is no channel to offer and the matrix falls back to stop-and-continue.
    clearDetectionCache();
    const dir = await tmpDir('cao-steer-deny-');
    let offered = false;
    const runner = new ClaudeRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CLAUDE } });
    const outcome = await runner.run(
      {
        runId: 'r1',
        task: { id: 'a', claude: {} } as ResolvedTask,
        attempt: 1,
        prompt: 'do it',
        cwd: dir,
        env: { FAKE_CLAUDE_MODE: 'success' },
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        attemptDir: path.join(dir, 'attempt'),
        canInteract: false,
      },
      {
        onActivity: () => {}, onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onUsage: () => {},
        onFileChange: () => {}, onInteraction: () => Promise.reject(new Error('none')),
        onChannel: () => {
          offered = true;
        },
      },
    );

    expect(offered).toBe(false);
    expect(outcome.kind).toBe('result');
  });

  it('fails a delivery the session died before acknowledging', async () => {
    process.env.FAKE_CLAUDE_NO_REPLAY = '1';
    const run = await steerThrough('claude', 'steer-exit', ['focus on the tests']);

    expect(run.sent[0]).toMatchObject({ state: 'queued' });
    expect(finalState(run)).toMatchObject({ transport: 'claude-stream', state: 'failed', reason: expect.stringMatching(/ended before it acknowledged/) });
    expect(run.outcome.kind).toBe('error');
  });
});

describe('Codex app-server: turn/steer', () => {
  beforeEach(() => clearCodexDetectionCache());

  const appServer = { codex: { transport: 'appServer' as const }, model: 'fake-codex' };

  it('accepts the message into the running turn and names the turn it went into', async () => {
    const run = await steerThrough('codex', 'steer', ['focus on the tests'], {}, appServer);

    expect(run.sent[0]).toMatchObject({ transport: 'codex-app-server', state: 'accepted', turnId: 'turn-1' });
    expect(run.updates).toEqual([]);
    expect(run.outcome).toMatchObject({ kind: 'result', result: { summary: expect.stringContaining('focus on the tests') } });
    expect(run.entries).toContainEqual(expect.objectContaining({ kind: 'user', text: 'focus on the tests', deliveryId: 'D1' }));
  });

  it('sends the expected turn id with the message', async () => {
    const run = await steerThrough('codex', 'steer', ['focus on the tests'], {}, appServer);
    const steer = run.stderr.find((line) => line.startsWith('steer:'));

    expect(steer).toBeDefined();
    expect(JSON.parse(steer!.slice('steer:'.length))).toEqual({
      threadId: 'codex-thread-1',
      input: [{ type: 'text', text: 'focus on the tests' }],
      expectedTurnId: 'turn-1',
    });
  });

  // Each of these is a different thing the operator has to do next, and only the server knows which one it
  // is; a runner that flattened them into "steering failed" would make the difference invisible (§7.2).
  it.each([
    ['no-turn', /no active turn to steer/],
    ['review', /cannot steer a review turn/],
    ['compact', /cannot steer a compact turn/],
    ['empty-input', /input must not be empty/],
    ['schema', /active turn uses a different output schema/],
  ])('rejects with the server\'s own message for %s', async (refusal, expected) => {
    const run = await steerThrough('codex', 'steer', ['focus on the tests'], { FAKE_CODEX_STEER: refusal, FAKE_CODEX_STEER_WAIT_MS: '400' }, appServer);

    expect(run.sent[0]).toMatchObject({ transport: 'codex-app-server', state: 'rejected', reason: expect.stringMatching(expected) });
    // A refused message never reached the worker, so nothing pretends it did.
    expect(run.entries.some((e) => e.kind === 'user')).toBe(false);
  });

  it('gives up on a server that takes the message and never answers, rather than holding the run', async () => {
    // The waiter is the scheduler's single loop (§2.2): `decideSteer` awaits this answer between two of the
    // loop's events, so an app-server that never replies used to freeze every other task's launch and the
    // stop until the attempt's own timeout killed it. 300 ms here for what is 30 s in production.
    const run = await steerThrough(
      'codex',
      'steer',
      ['focus on the tests'],
      { FAKE_CODEX_STEER: 'wedged', FAKE_CODEX_STEER_WAIT_MS: '2000' },
      appServer,
      undefined,
      { callTimeoutMs: 300 },
    );

    expect(run.stderr).toContain('steer-swallowed');
    expect(run.sent[0]).toMatchObject({ transport: 'codex-app-server', state: 'rejected', reason: expect.stringMatching(/did not answer turn\/steer within/) });
    // Nothing pretends the worker took it, and the attempt itself carries on to its own end.
    expect(run.entries.some((e) => e.kind === 'user')).toBe(false);
  });

  it('never sends turn/start while a turn is active, which the server would route to steer', async () => {
    const run = await steerThrough('codex', 'steer', ['focus on the tests'], {}, appServer);

    expect(run.stderr.filter((line) => line.startsWith('turn-start-routed-to-steer:'))).toEqual([]);
    // And nothing reaches for the experimental settings call either (§3.5: "turn/settings/update is not used").
    expect(run.stderr.some((line) => line.includes('turn/settings/update'))).toBe(false);
  });

  it('refuses to resume a thread another writer holds, in the server\'s words', async () => {
    const run = await steerThrough('codex', 'success', [], { FAKE_CODEX_RESUME_CONFLICT: '1' }, appServer, 'held-thread');

    expect(run.outcome).toMatchObject({ kind: 'error', message: expect.stringMatching(/already has an active writer/) });
    // Nothing was steered anywhere: the thread never opened, so no channel was ever offered.
    expect(run.channelOffered).toBe(false);
  });
});

describe('Codex exec: no live channel at all', () => {
  beforeEach(() => clearCodexDetectionCache());

  it('offers no channel, so a follow-up has transport "none" and falls back to stop-and-continue', async () => {
    // `codex exec` sends one turn and exits (§7.2); there is nothing to write into mid-run, and the runner
    // is unchanged by this stage.
    const run = await steerThrough('codex', 'success', [], {}, { model: 'fake-codex' });

    expect(run.channelOffered).toBe(false);
    expect(run.outcome.kind).toBe('result');
  });

  it('still reports a runner-level steer capability, because its other transport has one', async () => {
    // The static flag is about the runner; whether *this* attempt can be steered is the channel's answer.
    expect(new CodexRunner({ processManager: new ProcessManager() }).capabilities).toEqual({ steer: true });
    expect(new ClaudeRunner({ processManager: new ProcessManager() }).capabilities).toEqual({ steer: true });
  });
});
