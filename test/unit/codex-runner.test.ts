import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildCodexArgs, CodexRunner } from '../../src/runners/codex/codex-runner.js';
import { clearCodexDetectionCache } from '../../src/runners/codex/detect.js';
import { ProcessManager } from '../../src/execution/process-manager.js';
import type { RunnerHooks } from '../../src/runners/task-runner.js';
import type { ResolvedTask } from '../../src/types/workflow.js';
import type { Interaction } from '../../src/types/interaction.js';
import { FAKE_CODEX, tmpDir } from '../helpers/index.js';
import { parseTranscriptLine, type TranscriptEntry } from '../../src/types/transcript.js';
import { splitCompletionObject } from '../../src/runners/completion-text.js';
import { eventLineRenderer } from '../../src/cli/commands/logs.js';

/** The lines of an attempt's events.jsonl, as a surface reads them back. */
async function readEventLines(attemptDir: string): Promise<string[]> {
  const log = await fs.readFile(path.join(attemptDir, 'events.jsonl'), 'utf8');
  return log.trim().split(/\r?\n/);
}

/** The attempt's events.jsonl, as the entries every surface renders. */
async function readEntries(attemptDir: string): Promise<TranscriptEntry[]> {
  return (await readEventLines(attemptDir)).map(parseTranscriptLine).filter((e): e is TranscriptEntry => e !== null);
}

/**
 * What H2 forbids: an entry a surface renders as agent prose whose text is in fact the completion object.
 * Checked with the same classifier the runners use, which is what "parses as a completion result" means.
 */
function proseThatIsReallyAResult(entries: TranscriptEntry[]): string[] {
  return entries.filter((e) => e.kind === 'text' && splitCompletionObject(e.text).completion !== undefined).map((e) => (e.kind === 'text' ? e.text : ''));
}

describe('Codex runner arguments', () => {
  it('uses the Codex automatic-review preset without its mutually exclusive sandbox flag', () => {
    const args = buildCodexArgs({ permissionMode: 'auto' }, 'schema.json', 'final.json');
    expect(args).toEqual(expect.arrayContaining(['--approve-for-me', '-c', 'approval_policy="on-request"', 'exec', '--json', '--output-schema', 'schema.json', '--output-last-message', 'final.json']));
    expect(args).not.toContain('--sandbox');
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

  it('rejects automatic review with a sandbox the Codex preset cannot preserve', () => {
    expect(() => buildCodexArgs({ approvals: 'autoReview', sandbox: 'read-only' }, 'schema.json', 'final.json'))
      .toThrow('Codex automatic review requires the workspace-write sandbox');
  });

  it('uses an explicit session for a resumed worker', () => {
    const args = buildCodexArgs({ permissionMode: 'readOnly' }, 'schema.json', 'final.json', 'thread-1');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', 'exec', 'resume', 'thread-1']));
  });

  /**
   * The invariants the CLI enforces at runtime and no help text can express. `npm run test:agents` checks
   * that every flag exists and sits on the right side of the subcommand; this checks, offline and over the
   * whole option matrix, the two combinations the real binary refuses outright.
   */
  it('never emits a combination the real CLI refuses, for any option combination', () => {
    const problems: string[] = [];
    let built = 0;
    for (const permissionMode of [undefined, 'auto', 'readOnly', 'fullAccess'] as const) {
      for (const approvals of [undefined, 'auto', 'host', 'autoReview', 'deny'] as const) {
        for (const sandbox of [undefined, 'read-only', 'workspace-write', 'danger-full-access'] as const) {
          for (const approvalPolicy of [undefined, 'on-request', 'never'] as const) {
            for (const configMode of [undefined, 'inherit', 'isolated'] as const) {
              for (const resume of [undefined, 'thread-1']) {
                let args: string[];
                try {
                  args = buildCodexArgs({ permissionMode, approvals, sandbox, approvalPolicy, configMode, profile: 'ci', addDirs: ['../shared'] }, 's.json', 'f.json', resume, 'gpt-5-codex', 'high');
                } catch {
                  continue; // A combination CAO refuses to build cannot reach the CLI.
                }
                built++;
                const label = `${permissionMode}/${approvals}/${sandbox}/${approvalPolicy}/${configMode}/${resume ?? 'fresh'}`;
                if (args.includes('--approve-for-me') && (args.includes('--sandbox') || args.includes('-s'))) problems.push(`${label}: --approve-for-me with --sandbox`);
                if (args.includes('--ask-for-approval') || args.includes('-a')) problems.push(`${label}: --ask-for-approval on an exec line`);
                const boundary = args.indexOf('exec');
                if (boundary < 0) problems.push(`${label}: no exec subcommand`);
                for (const flag of ['--sandbox', '--approve-for-me', '--profile', '--add-dir']) {
                  const at = args.indexOf(flag);
                  if (at >= 0 && at > boundary) problems.push(`${label}: ${flag} after exec`);
                }
              }
            }
          }
        }
      }
    }
    expect(built).toBeGreaterThan(200);
    expect(problems).toEqual([]);
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

  /**
   * H3.4 asks for the limit to be stated once per task. Said once per *attempt* it is said again by every
   * retry, and `cao logs <task>` - which reads the attempts end to end - opens with the same paragraph
   * three times, on top of the once-per-workflow `cao validate` warning.
   */
  it('states the transport limit once per task, not once per attempt', async () => {
    const root = await tmpDir('cao-codex-notice-');
    const warnings: string[] = [];
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    const task = { id: 'a', model: 'fake-codex', codex: { transport: 'exec' }, claude: {} } as ResolvedTask;
    const hooks = {
      onActivity: () => {}, onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {}, onUsage: () => {},
      onWarning: (value: string) => warnings.push(value),
      onInteraction: async () => ({ kind: 'deny', message: 'headless test' } as const),
    };
    const attempts = [path.join(root, 'attempt-1'), path.join(root, 'attempt-2')];
    for (const [i, attemptDir] of attempts.entries()) {
      await runner.run({
        runId: 'r1', attempt: i + 1, prompt: 'do it', cwd: root, attemptDir, env: {}, timeoutMs: 5000,
        signal: new AbortController().signal, canInteract: false, task,
      }, hooks);
    }

    const notices = async (dir: string): Promise<TranscriptEntry[]> => (await readEntries(dir)).filter((e) => e.kind === 'system' && e.text.includes('cannot reach a human'));
    expect(await notices(attempts[0]!)).toHaveLength(1);
    expect(await notices(attempts[1]!)).toHaveLength(0);
    expect(warnings.filter((w) => w.includes('cannot reach a human'))).toHaveLength(1);
  });

  it('sends a strict output schema and decodes free-form result data', async () => {
    const root = await tmpDir('cao-codex-schema-');
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    const outcome = await runner.run({
      runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir: path.join(root, 'attempt'), env: { FAKE_CODEX_MODE: 'strict-schema' }, timeoutMs: 5000,
      signal: new AbortController().signal, canInteract: false,
      task: { id: 'a', model: 'fake-codex', effort: 'high', codex: { transport: 'exec' }, claude: {} } as ResolvedTask,
    }, {
      onActivity: () => {}, onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {}, onUsage: () => {},
      onInteraction: async () => ({ kind: 'deny', message: 'headless test' }),
    });

    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', data: { risk: 'low', nested: { count: 2 } } } });
  });

  /**
   * The bug H2 is about, on the transport it was seen on: a worker that answers the contract mid-turn, keeps
   * working, and answers again. Neither object may reach a surface as something the agent said, and the first
   * one may not end the attempt.
   */
  it('records a completion object as a result, mid-turn and at the end, never as agent prose', async () => {
    const root = await tmpDir('cao-codex-interim-');
    const attemptDir = path.join(root, 'attempt');
    const activities: string[] = [];
    const runner = new CodexRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CODEX } });
    const outcome = await runner.run({
      runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir, env: { FAKE_CODEX_MODE: 'interim' }, timeoutMs: 5000,
      signal: new AbortController().signal, canInteract: false,
      task: { id: 'a', model: 'fake-codex', codex: { transport: 'exec' }, claude: {} } as ResolvedTask,
    }, {
      onActivity: (value) => activities.push(value), onOutput: () => {}, onProcess: () => {}, onTranscript: () => {}, onFileChange: () => {},
      onUsage: () => {}, onInteraction: async () => ({ kind: 'deny', message: 'headless test' }),
    });

    // The mid-turn object did not end the attempt: final.json is still what the task result comes from.
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', summary: 'fake exec completed' } });

    const entries = await readEntries(attemptDir);
    expect(proseThatIsReallyAResult(entries)).toEqual([]);
    // The prose the worker wrote between the two objects is untouched.
    expect(entries.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['Now running the tests.']);
    // The mid-turn object is a result, and says it is not the outcome; the outcome is the last entry, and
    // is written once even though the worker's last message was that same object.
    const results = entries.filter((e): e is Extract<TranscriptEntry, { kind: 'result' }> => e.kind === 'result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: 'needs_input', summary: 'Checking whether the docs still build', intermediate: true });
    expect(results[0]!.raw).toContain('"status":"needs_input"');
    expect(entries.at(-1)).toMatchObject({ kind: 'result', status: 'success', summary: 'fake exec completed' });
    expect(entries.at(-1)).not.toHaveProperty('intermediate');

    // The activity line - hooks.onActivity, live.json, the dashboard task column - never shows the wire format.
    expect(activities.some((line) => line.trimStart().startsWith('{'))).toBe(false);
    expect(activities.some((line) => line.includes('Checking whether the docs still build'))).toBe(true);

    // And what `cao logs` / `cao peek` print for this attempt is the summary, not the object.
    const rendered = eventLineRenderer('never').batch(await readEventLines(attemptDir)).join('\n');
    expect(rendered).toContain('Checking whether the docs still build');
    expect(rendered).toContain('fake exec completed');
    expect(rendered).not.toContain('"status":');
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
    return { outcome, interactions, usage, warnings, rawOutput, attemptDir: path.join(root, 'attempt') };
  }

  it('runs a schema-constrained turn and reports usage', async () => {
    const { outcome, usage } = await run('success');
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', summary: 'fake app-server completed' } });
    expect(usage.at(-1)).toMatchObject({ sessionId: 'codex-thread-1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, contextWindow: 200000 });
  });

  it('sends a strict output schema and decodes free-form result data', async () => {
    const { outcome } = await run('strict-schema');
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', data: { risk: 'low', nested: { count: 2 } } } });
  });

  it('retries bounded app-server queue overloads without changing transport', async () => {
    const { outcome } = await run('overload-once');
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success' } });
  });

  // A server that does not honour the envelope CAO asked for is a misconfiguration (or a CLI too old to
  // honour it), never something another attempt can fix: `config_error`, not `crash`.
  it('fails closed when the server omits or changes resolved security/model settings', async () => {
    expect((await run('missing-policy')).outcome).toMatchObject({ kind: 'error', outcome: 'config_error', message: expect.stringMatching(/did not report.*approval policy/i) });
    expect((await run('missing-policy')).outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('codex.approvalPolicy') });
    expect((await run('wrong-model')).outcome).toMatchObject({ kind: 'error', outcome: 'config_error', message: expect.stringMatching(/resolved model/i) });
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

  it('records a completion object as a result here too, and keeps the last agent message authoritative', async () => {
    const { outcome, attemptDir } = await run('interim');
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'success', summary: 'fake app-server completed' } });

    const entries = await readEntries(attemptDir);
    expect(proseThatIsReallyAResult(entries)).toEqual([]);
    expect(entries.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['Now running the tests.']);
    // Two entries, not three: the object the turn ended on is the outcome, not a checkpoint before it.
    expect(entries.filter((e) => e.kind === 'result')).toMatchObject([
      { status: 'needs_input', intermediate: true },
      { status: 'success', summary: 'fake app-server completed', raw: expect.stringContaining('"status":"success"') },
    ]);
    expect(entries.at(-1)).not.toHaveProperty('intermediate');
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
