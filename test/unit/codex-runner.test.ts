import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildCodexArgs, CodexRunner } from '../../src/runners/codex/codex-runner.js';
import { clearCodexDetectionCache } from '../../src/runners/codex/detect.js';
import { ProcessManager } from '../../src/execution/process-manager.js';
import type { RunnerHooks } from '../../src/runners/task-runner.js';
import type { ResolvedTask } from '../../src/types/workflow.js';
import type { Interaction } from '../../src/types/interaction.js';
import { FAKE_CODEX, tmpDir } from '../helpers/index.js';

describe('Codex runner arguments', () => {
  it('maps the auto permission preset and includes structured output files', () => {
    const args = buildCodexArgs({ permissionMode: 'auto' }, 'schema.json', 'final.json');
    expect(args).toEqual(expect.arrayContaining(['--approve-for-me', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"', 'exec', '--json', '--output-schema', 'schema.json', '--output-last-message', 'final.json']));
  });

  it('denies approvals in read-only mode and isolates ambient configuration when requested', () => {
    const args = buildCodexArgs({ permissionMode: 'readOnly', configMode: 'isolated' }, 'schema.json', 'final.json');
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '-c', 'approval_policy="never"']));
    expect(args).not.toContain('--approve-for-me');
  });

  it('uses automatic review for an unattended explicit on-request policy', () => {
    const args = buildCodexArgs({ approvalPolicy: 'on-request', approvals: 'autoReview' }, 'schema.json', 'final.json');
    expect(args).toContain('--approve-for-me');
  });

  it('uses an explicit session for a resumed worker', () => {
    const args = buildCodexArgs({ permissionMode: 'readOnly' }, 'schema.json', 'final.json', 'thread-1');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', 'exec', 'resume', 'thread-1']));
  });
});

describe('Codex exec transport', () => {
  beforeEach(() => clearCodexDetectionCache());

  it('runs the fake CLI end to end and captures its session and usage', async () => {
    const root = await tmpDir('cao-codex-exec-');
    const usage: unknown[] = [];
    const activities: string[] = [];
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    const outcome = await runner.run({
      runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir: path.join(root, 'attempt'), env: {}, timeoutMs: 5000,
      signal: new AbortController().signal, canInteract: false,
      task: { id: 'a', model: 'fake-codex', effort: 'high', codex: { transport: 'exec' }, claude: {} } as ResolvedTask,
    }, {
      onActivity: (value) => activities.push(value), onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {},
      onUsage: (value) => usage.push(value), onInteraction: async () => ({ kind: 'deny', message: 'headless test' }),
    });

    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', summary: 'fake exec completed' }, usage: { sessionId: 'codex-exec-thread-1', inputTokens: 10, cacheReadTokens: 2, outputTokens: 5 } });
    expect(activities).toContain('$ npm test');
    expect(usage.at(-1)).toMatchObject({ sessionId: 'codex-exec-thread-1', numTurns: 1 });
  });
});

describe('Codex app-server transport', () => {
  beforeEach(() => clearCodexDetectionCache());

  async function run(mode: string, experimentalUserInput = false) {
    const root = await tmpDir('cao-codex-app-');
    const interactions: Interaction[] = [];
    const usage: unknown[] = [];
    const hooks: RunnerHooks = {
      onActivity: () => {}, onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {},
      onUsage: (value) => usage.push(value),
      onInteraction: async (interaction) => {
        interactions.push(interaction);
        return interaction.kind === 'question' ? { kind: 'answer', answers: { choice: 'A' } } : { kind: 'allow', scope: 'once' };
      },
    };
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    const outcome = await runner.run({
      runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir: path.join(root, 'attempt'), env: { FAKE_CODEX_MODE: mode },
      timeoutMs: 5000, signal: new AbortController().signal, canInteract: true,
      task: { id: 'a', model: 'fake-codex', effort: 'high', codex: { transport: 'appServer', approvals: 'host', experimentalUserInput }, claude: {} } as ResolvedTask,
    }, hooks);
    return { outcome, interactions, usage };
  }

  it('runs a schema-constrained turn and reports usage', async () => {
    const { outcome, usage } = await run('success');
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', summary: 'fake app-server completed' } });
    expect(usage.at(-1)).toMatchObject({ sessionId: 'codex-thread-1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, contextWindow: 200000 });
  });

  it('retries bounded app-server queue overloads without changing transport', async () => {
    const { outcome } = await run('overload-once');
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success' } });
  });

  it('routes stable command approvals through the shared interaction seam', async () => {
    const { outcome, interactions } = await run('approval');
    expect(outcome.kind).toBe('result');
    expect(interactions).toEqual([expect.objectContaining({ kind: 'permission', agent: 'codex', toolName: 'command', title: expect.stringContaining('npm test') })]);
  });

  it('gates experimental questions and preserves typed retry diagnostics', async () => {
    const gated = await run('question');
    expect(gated.outcome).toMatchObject({ kind: 'result', result: { status: 'needs_input' } });
    expect(gated.interactions).toEqual([]);

    const question = await run('question', true);
    expect(question.outcome.kind).toBe('result');
    expect(question.interactions[0]).toMatchObject({ kind: 'question', questions: [{ question: 'Which?' }] });

    const failure = await run('failure');
    expect(failure.outcome).toMatchObject({ kind: 'error', outcome: 'api_error', failure: { providerCode: 'serverOverloaded', retryable: true } });
  });
});
