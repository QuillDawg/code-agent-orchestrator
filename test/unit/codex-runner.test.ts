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
    const args = buildCodexArgs({ permissionMode: 'readOnly', configMode: 'isolated', sandbox: 'danger-full-access', approvalPolicy: 'on-request' }, 'schema.json', 'final.json');
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

  it('rejects raw arguments that could override the security envelope', () => {
    expect(() => buildCodexArgs({ permissionMode: 'readOnly', extraArgs: ['--sandbox', 'danger-full-access'] }, 'schema.json', 'final.json')).toThrow(/cannot override security/i);
    expect(() => buildCodexArgs({ extraArgs: ['-c', 'approval_policy="never"'] }, 'schema.json', 'final.json')).toThrow(/approval_policy/i);
    expect(() => buildCodexArgs({ extraArgs: ['--config=approval_policy="never"'] }, 'schema.json', 'final.json')).toThrow(/approval_policy/i);
    expect(() => buildCodexArgs({ extraArgs: ['-csandbox_workspace_write.network_access=true'] }, 'schema.json', 'final.json')).toThrow(/sandbox_workspace_write/i);
  });
});

describe('Codex app-server transport', () => {
  beforeEach(() => clearCodexDetectionCache());

  async function run(mode: string, experimentalUserInput = false, resumeSessionId?: string) {
    const root = await tmpDir('cao-codex-app-');
    const interactions: Interaction[] = [];
    const usage: unknown[] = [];
    const warnings: string[] = [];
    const rawOutput: string[] = [];
    const controller = new AbortController();
    const hooks: RunnerHooks = {
      onActivity: () => {}, onOutput: (_stream, line) => rawOutput.push(line), onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {},
      onUsage: (value) => usage.push(value),
      onWarning: (value) => warnings.push(value),
      onInteraction: async (interaction) => {
        interactions.push(interaction);
        return interaction.kind === 'question' ? { kind: 'answer', answers: { choice: 'A' } } : { kind: 'allow', scope: 'once' };
      },
    };
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    const outcome = await runner.run({
      runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir: path.join(root, 'attempt'), env: { FAKE_CODEX_MODE: mode },
      timeoutMs: 5000, signal: controller.signal, canInteract: true, resumeSessionId,
      task: { id: 'a', model: 'fake-codex', effort: 'high', codex: { transport: 'appServer', approvals: 'host', experimentalUserInput }, claude: {} } as ResolvedTask,
    }, hooks);
    return { outcome, interactions, usage, warnings, rawOutput };
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

  it('fails closed when the server omits or changes resolved security/model settings', async () => {
    expect((await run('missing-policy')).outcome).toMatchObject({ kind: 'error', outcome: 'crash', message: expect.stringMatching(/did not report.*approval policy/i) });
    expect((await run('wrong-model')).outcome).toMatchObject({ kind: 'error', outcome: 'crash', message: expect.stringMatching(/resolved model/i) });
  });

  it('routes stable command approvals through the shared interaction seam', async () => {
    const { outcome, interactions } = await run('approval');
    expect(outcome.kind).toBe('result');
    expect(interactions).toEqual([expect.objectContaining({ kind: 'permission', agent: 'codex', toolName: 'command', title: expect.stringContaining('npm test') })]);
  });

  it('routes file approvals and resumes the requested thread', async () => {
    const file = await run('file-approval');
    expect(file.outcome.kind).toBe('result');
    expect(file.interactions[0]).toMatchObject({ kind: 'permission', toolName: 'fileChange' });

    const resumed = await run('success', false, 'resume-thread');
    expect(resumed.outcome).toMatchObject({ kind: 'result', usage: { sessionId: 'resume-thread' } });
  });

  it('tolerates malformed lines and unknown additive notifications', async () => {
    const result = await run('malformed');
    expect(result.outcome.kind).toBe('result');
    expect(result.rawOutput).toContain('not-json');
  });

  it('classifies interruption, invalid output and required MCP failure', async () => {
    expect((await run('interrupted')).outcome).toMatchObject({ kind: 'error', outcome: 'crash', failure: { partialWork: true, retryable: false } });
    expect((await run('invalid')).outcome).toMatchObject({ kind: 'error', outcome: 'invalid_result' });
    const mcp = await run('mcp-failure');
    expect(mcp.outcome).toMatchObject({ kind: 'error', failure: { providerCode: 'badRequest', retryable: false } });
    expect(mcp.warnings).toEqual([expect.stringMatching(/required.*failed to start/i)]);
  });

  it('interrupts and cancels a hanging turn', async () => {
    const root = await tmpDir('cao-codex-cancel-');
    const controller = new AbortController();
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    setTimeout(() => controller.abort(), 50);
    const outcome = await runner.run({
      runId: 'r1', attempt: 1, prompt: 'wait', cwd: root, attemptDir: path.join(root, 'attempt'), env: { FAKE_CODEX_MODE: 'hang' },
      timeoutMs: 5000, signal: controller.signal, canInteract: true,
      task: { id: 'a', model: 'fake-codex', codex: { transport: 'appServer', approvals: 'host' }, claude: {} } as ResolvedTask,
    }, { onActivity: () => {}, onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {}, onUsage: () => {}, onInteraction: async () => ({ kind: 'deny', message: 'no' }) });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'cancelled' });
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
