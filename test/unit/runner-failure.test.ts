/**
 * How a failed attempt is classified, on both agents.
 *
 * The rows of `OUTCOME_MAP` are the contract: every one of them is exercised here against the fakes, on
 * whichever runner can produce it, so a runner that starts answering the same situation differently from
 * the other one (or from the documentation) turns this file red.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { codexConfigRejection, codexFailureMetadata, codexOptionKey, codexProtocolRejection, normalizeCodexFailure } from '../../src/runners/codex/failure.js';
import { claudeConfigRejection, claudeOptionKey } from '../../src/runners/claude/transient.js';
import { OUTCOME_MAP, configErrorMessage, configErrorOutcome, killedMessage, openToolMessage, outcomeMapTable } from '../../src/runners/outcomes.js';
import { capabilityPreflight } from '../../src/runners/preflight.js';
import { codexCapabilityNeeds } from '../../src/runners/codex/preflight.js';
import { claudeCapabilityNeeds } from '../../src/runners/claude/preflight.js';
import { CodexRunner } from '../../src/runners/codex/codex-runner.js';
import { ClaudeRunner } from '../../src/runners/claude/claude-runner.js';
import { clearCodexDetectionCache } from '../../src/runners/codex/detect.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { ProcessManager } from '../../src/execution/process-manager.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import type { RunnerHooks, RunnerOutcome } from '../../src/runners/task-runner.js';
import type { ResolvedTask, ResolvedWorkflow, CodexOptions, ClaudeOptions } from '../../src/types/workflow.js';
import { parseTranscriptLine, type TranscriptEntry } from '../../src/types/transcript.js';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, FAKE_CLAUDE, FAKE_CODEX, tmpDir, waitFor } from '../helpers/index.js';

const NL = String.fromCharCode(10);

const silentHooks = (): RunnerHooks => ({
  onActivity: () => {}, onOutput: () => {}, onProcess: () => {}, onTranscript: () => {},
  onFileChange: () => {}, onUsage: () => {}, onInteraction: async () => ({ kind: 'deny', message: 'headless test' }),
});

interface FakeRun {
  outcome: RunnerOutcome;
  entries: TranscriptEntry[];
}

async function readEntries(attemptDir: string): Promise<TranscriptEntry[]> {
  const log = await fs.readFile(path.join(attemptDir, 'events.jsonl'), 'utf8').catch(() => '');
  return log.trim().split(/\r?\n/).map(parseTranscriptLine).filter((e): e is TranscriptEntry => e !== null);
}

/** One Codex attempt against the fake CLI. */
async function runCodex(opts: { mode?: string; codex?: CodexOptions; pm?: ProcessManager; taskId?: string }): Promise<FakeRun> {
  const root = await tmpDir('cao-fail-codex-');
  const attemptDir = path.join(root, 'attempt');
  const runner = new CodexRunner({ processManager: opts.pm ?? new ProcessManager(), defaults: { command: FAKE_CODEX } });
  const outcome = await runner.run({
    runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir, timeoutMs: 10_000,
    env: opts.mode ? { FAKE_CODEX_MODE: opts.mode } : {},
    signal: new AbortController().signal, canInteract: false,
    task: { id: opts.taskId ?? 'a', codex: { transport: 'exec', ...opts.codex }, claude: {} } as ResolvedTask,
  }, silentHooks());
  return { outcome, entries: await readEntries(attemptDir) };
}

/** One Claude attempt against the fake CLI. */
async function runClaude(opts: { mode?: string; claude?: ClaudeOptions; pm?: ProcessManager; taskId?: string; timeoutMs?: number }): Promise<FakeRun> {
  const root = await tmpDir('cao-fail-claude-');
  const attemptDir = path.join(root, 'attempt');
  const runner = new ClaudeRunner({ processManager: opts.pm ?? new ProcessManager(), defaults: { command: FAKE_CLAUDE } });
  const outcome = await runner.run({
    runId: 'r1', attempt: 1, prompt: 'do it', cwd: root, attemptDir, timeoutMs: opts.timeoutMs ?? 10_000,
    env: opts.mode ? { FAKE_CLAUDE_MODE: opts.mode } : {},
    signal: new AbortController().signal, canInteract: false,
    task: { id: opts.taskId ?? 'a', claude: { ...opts.claude }, codex: {} } as ResolvedTask,
  }, silentHooks());
  return { outcome, entries: await readEntries(attemptDir) };
}

describe('Codex typed failures', () => {
  it('marks transport, rate-limit and server failures retryable', () => {
    expect(normalizeCodexFailure('rateLimitExceeded')).toMatchObject({ providerCode: 'rateLimitExceeded', retryable: true });
    expect(normalizeCodexFailure({ httpConnectionFailed: { httpStatusCode: 503 } })).toMatchObject({ providerCode: 'httpConnectionFailed', httpStatus: 503, retryable: true });
    expect(normalizeCodexFailure({ responseStreamDisconnected: { httpStatusCode: 409 } })).toMatchObject({ providerCode: 'responseStreamDisconnected', httpStatus: 409, retryable: true, partialWork: true });
  });

  it('does not retry authentication, quota, context, request or sandbox failures', () => {
    for (const code of ['unauthorized', 'usageLimitExceeded', 'contextWindowExceeded', 'badRequest', 'sandboxError']) {
      expect(normalizeCodexFailure(code), code).toMatchObject({ providerCode: code, retryable: false });
    }
  });

  it('preserves provider request and retry timing metadata when available', () => {
    expect(codexFailureMetadata({ data: { requestId: 'req-1', retryAfterSeconds: 2.5 } })).toEqual({ requestId: 'req-1', retryAfterMs: 2500 });
  });
});

describe('the outcome map', () => {
  it('covers every situation the two runners have to agree about', () => {
    expect(OUTCOME_MAP.map((rule) => rule.id)).toEqual([
      'no_result', 'invalid_result', 'api_error', 'config_error', 'agent_error', 'killed', 'open_tool', 'spawn_failure', 'cancelled', 'timeout',
    ]);
  });

  /** The map replaced a table per agent, so every row has to say how each runner recognises it. */
  it('says how both runners recognise every row', () => {
    for (const rule of OUTCOME_MAP) {
      expect(rule.claude.length, rule.id).toBeGreaterThan(0);
      expect(rule.codex.length, rule.id).toBeGreaterThan(0);
    }
  });

  /** The documentation is generated from the map; if they part company, the map is the one that is right. */
  it('is the table docs/agent-cli-integration.md carries, verbatim', async () => {
    const doc = await fs.readFile(path.resolve('docs/agent-cli-integration.md'), 'utf8');
    expect(doc.replace(/\r\n/g, '\n')).toContain(outcomeMapTable());
  });

  it('describes a configuration rejection as non-retryable, with the option and the key', () => {
    const outcome = configErrorOutcome('Codex', { detail: "error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'", option: '--approve-for-me', key: 'codex.approvals' });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'config_error', failure: { retryable: false } });
    expect(outcome.message).toContain('--approve-for-me');
    expect(outcome.message).toContain('codex.approvals');
    expect(outcome.message).toMatch(/no retry can change it/i);
  });

  it('names the signal a process was killed with, and the tool call left open', () => {
    expect(killedMessage('Claude', null, 'SIGKILL')).toContain('killed by signal SIGKILL');
    expect(killedMessage('Claude', 3, null)).toContain('exited with code 3');
    expect(openToolMessage('Claude', ['$ npm run build'])).toContain('npm run build');
    expect(openToolMessage('Claude', ['a', 'b'])).toContain('2 tool calls');
  });

  it('keeps a multi-line rejection to one bounded line', () => {
    const message = configErrorMessage('Codex', { detail: `first line${NL}second line` });
    expect(message).toContain('first line');
    expect(message).not.toContain('second line');
  });
});

describe('configuration rejections: Codex', () => {
  const usage = ['Usage: codex exec [OPTIONS] [PROMPT]', "For more information, try '--help'."].join(NL);

  it('recognises a clap conflict and traces both flags to their workflow keys', () => {
    const rejection = codexConfigRejection({
      exitCode: 2,
      stderr: `error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'${NL}${usage}`,
    });
    expect(rejection).toMatchObject({ option: '--approve-for-me with --sandbox', key: 'codex.approvals and codex.sandbox' });
    expect(rejection!.detail).toContain('cannot be used with');
  });

  it('recognises an invented flag as raw passthrough', () => {
    const rejection = codexConfigRejection({ exitCode: 2, stderr: `error: unexpected argument '--nope' found${NL}${usage}` });
    expect(rejection).toMatchObject({ option: '--nope', key: 'codex.extraArgs' });
  });

  it('recognises the invalid_json_schema the API returns for a non-strict output schema', () => {
    const rejection = codexConfigRejection({
      exitCode: 1,
      stream: "Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    });
    expect(rejection).toMatchObject({ option: '--output-schema', key: "the completion contract's output schema" });
  });

  it('recognises JSON-RPC -32602 and leaves every other code alone', () => {
    expect(codexProtocolRejection({ code: -32602, message: 'thread/start failed: unknown field `sandbox`' })).toMatchObject({ detail: expect.stringContaining('unknown field') });
    expect(codexProtocolRejection({ code: -32001, message: 'server overloaded' })).toBeUndefined();
  });

  it('leaves an ordinary failed turn alone', () => {
    expect(codexConfigRejection({ exitCode: 1, stderr: 'stream error: fetch failed (ECONNRESET)' })).toBeUndefined();
    expect(codexConfigRejection({ exitCode: 1, stream: 'the model refused to continue' })).toBeUndefined();
  });

  it('maps every flag CAO puts on a Codex command line to the key it came from', () => {
    expect(codexOptionKey('--approve-for-me')).toBe('codex.approvals');
    expect(codexOptionKey('--sandbox <SANDBOX_MODE>')).toBe('codex.sandbox');
    expect(codexOptionKey('--ignore-user-config')).toBe('codex.configMode');
    expect(codexOptionKey('--profile')).toBe('codex.profile');
    expect(codexOptionKey('--whatever-this-is')).toBe('codex.extraArgs');
  });
});

describe('configuration rejections: Claude', () => {
  it("recognises commander's unknown option and traces it to raw passthrough", () => {
    const rejection = claudeConfigRejection({ exitCode: 2, stderr: "error: unknown option '--nope'" });
    expect(rejection).toMatchObject({ option: '--nope', key: 'claude.extraArgs' });
  });

  it('traces a rejected flag CAO builds itself to the key that produced it', () => {
    expect(claudeConfigRejection({ exitCode: 2, stderr: "error: unknown option '--safe-mode'" })).toMatchObject({ key: 'claude.configMode' });
    expect(claudeOptionKey('--permission-prompt-tool')).toBe('claude.permissionPrompts');
    expect(claudeOptionKey('--allowedTools')).toBe('claude.allowedTools');
  });

  it('recognises invalid_json_schema wherever the session reported it', () => {
    expect(claudeConfigRejection({ resultText: 'API Error: 400 invalid_json_schema: output schema is invalid' })).toMatchObject({ option: '--json-schema', key: 'the completion contract' });
  });

  it('leaves a transient failure and an ordinary crash alone', () => {
    expect(claudeConfigRejection({ exitCode: 1, stderr: 'API Error: 500 Internal server error' })).toBeUndefined();
    expect(claudeConfigRejection({ exitCode: 3, stderr: 'fatal: boom' })).toBeUndefined();
  });
});

describe('one outcome map, against the real fakes', () => {
  beforeEach(() => {
    clearCodexDetectionCache();
    clearDetectionCache();
  });

  it('Codex: an argument the CLI refuses is a configuration error, not a crash', async () => {
    const { outcome, entries } = await runCodex({ codex: { extraArgs: ['--definitely-not-a-flag'] } });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'config_error', failure: { retryable: false } });
    expect((outcome as { message: string }).message).toContain('--definitely-not-a-flag');
    expect((outcome as { message: string }).message).toContain('codex.extraArgs');
    expect(entries.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('configuration error') });
  });

  it('Codex: an output schema the API refuses is a configuration error', async () => {
    const { outcome } = await runCodex({ mode: 'schema-rejected' });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'config_error' });
    expect((outcome as { message: string }).message).toContain('--output-schema');
  });

  it('Codex app-server: a -32602 on turn/start is a configuration error', async () => {
    const { outcome } = await runCodex({ mode: 'schema-rejected', codex: { transport: 'appServer' } });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'config_error' });
    expect((outcome as { message: string }).message).toContain('turn/start');
  });

  it('Codex: a command the stream never completed ends the attempt as a crash naming it', async () => {
    const { outcome, entries } = await runCodex({ mode: 'open-command' });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'crash' });
    expect((outcome as { message: string }).message).toContain('npm run build');
    expect(entries.some((e) => e.kind === 'command' && e.command === 'npm run build')).toBe(true);
  });

  it('Claude: an argument the CLI refuses is a configuration error, not a crash', async () => {
    const { outcome } = await runClaude({ claude: { extraArgs: ['--definitely-not-a-flag'] } });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'config_error', failure: { retryable: false } });
    expect((outcome as { message: string }).message).toContain('claude.extraArgs');
  });

  it('Claude: an output schema the API refuses is a configuration error', async () => {
    const { outcome } = await runClaude({ mode: 'bad-schema' });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'config_error' });
    expect((outcome as { message: string }).message).toContain('--json-schema');
  });

  it('Claude: a tool call left unanswered at exit is a crash naming it', async () => {
    const { outcome, entries } = await runClaude({ mode: 'open-tool-exit' });
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'crash' });
    expect((outcome as { message: string }).message).toContain('npm run build');
    expect(entries.some((e) => e.kind === 'command' && e.command.includes('npm run build'))).toBe(true);
  });

  it('Claude: a process killed from outside is a crash that records how it died', async () => {
    const pm = new ProcessManager();
    const running = runClaude({ mode: 'hang', pm, taskId: 'killed', timeoutMs: 30_000 });
    await waitFor(() => pm.get('killed') !== undefined);
    await pm.get('killed')!.kill('force');
    const { outcome } = await running;
    expect(outcome).toMatchObject({ kind: 'error', outcome: 'crash' });
    const error = outcome as { message: string; signal?: string | null; exitCode?: number | null };
    // Windows has no signals: either way the attempt records how the process died and says so.
    expect('signal' in error).toBe(true);
    expect(error.message).toMatch(/killed by signal|exited with code/);
  });
});

describe('preflight', () => {
  const codexDetection = (over: Record<string, unknown> = {}) => ({
    command: 'codex', found: true, version: 'codex-cli 0.140.0', supportedVersion: false,
    minimumVersion: '0.153.0', capabilities: ['exec'] as never, ...over,
  });

  it('names the option, the workflow key, the version found and the version needed', () => {
    const message = capabilityPreflight('codex', codexDetection({ version: 'codex-cli 0.140.0', supportedVersion: true }), codexCapabilityNeeds({ transport: 'appServer', approvals: 'deny' }));
    expect(message).toContain('appServer');
    expect(message).toContain('codex app-server --stdio');
    expect(message).toContain('codex.transport: appServer');
    expect(message).toContain('codex-cli 0.140.0');
    expect(message).toContain('0.153.0');
  });

  it('fails a CLI below the supported minimum', () => {
    expect(capabilityPreflight('codex', codexDetection(), codexCapabilityNeeds({}))).toMatch(/below the minimum CAO supports/);
  });

  it('says nothing about a CLI that can do the job, or one that is not installed at all', () => {
    expect(capabilityPreflight('codex', codexDetection({ supportedVersion: true, capabilities: ['exec', 'autoReview'] }), codexCapabilityNeeds({}))).toBeUndefined();
    expect(capabilityPreflight('codex', { command: 'codex', found: false, error: 'ENOENT' }, codexCapabilityNeeds({}))).toBeUndefined();
  });

  it('asks Claude for the two capabilities every attempt needs', () => {
    expect(claudeCapabilityNeeds({}).map((need) => need.capability)).toEqual(['streamJson', 'structuredOutput']);
    expect(claudeCapabilityNeeds({ configMode: 'isolated' }).map((need) => need.capability)).toContain('isolatedConfig');
  });
});

// ---------------------------------------------------------------------------
// The scheduler's half: a configuration failure spends nothing and obeys onFailure.
// ---------------------------------------------------------------------------

async function wf(yaml: string): Promise<ResolvedWorkflow> {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join(NL));
  return workflow;
}

function harness(workflow: ResolvedWorkflow, runner: MockRunner) {
  const run = makeRun(workflow);
  const store = new MemoryRunStore();
  const bus = new WorkflowEventBus(run.runId);
  bus.onAny((e) => void store.appendEvent(e));
  const scheduler = new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace: new MockWorkspace(workflow.repositoryRoot), bus });
  return { scheduler, store, run, runner };
}

const RETRY_YAML = `
name: config-failure
defaults:
  retry:
    attempts: 3
    delay: 0
    resultNudges: 0
tasks:
  - id: a
    prompt: p
    onFailure: __ON_FAILURE__
  - id: b
    prompt: p
    dependsOn: [a]
`;

const retryYaml = (onFailure: 'stop' | 'continue' | 'skip_dependents'): string => RETRY_YAML.replace('__ON_FAILURE__', onFailure);

describe('scheduler: a configuration failure', () => {
  it('does not consume retry.attempts and never runs a second attempt', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'config_error', message: 'Codex rejected --approve-for-me (codex.approvals)' });
    const h = harness(await wf(retryYaml('stop')), runner);
    await h.scheduler.execute();
    expect(runner.calls.filter((c) => c.taskId === 'a')).toHaveLength(1);
    expect(h.run.tasks.a!.state).toBe('failed');
    expect(h.run.tasks.a!.reason).toBe('config_error');
    expect(h.run.tasks.a!.attempts).toHaveLength(1);
    // The task failed on its first attempt: nothing in the retry window was spent on it.
    expect(h.store.eventsOf('task.retrying')).toEqual([]);
    expect(h.store.eventsOf('task.failed').at(-1)).toMatchObject({ taskId: 'a', outcome: 'config_error', final: true });
  });

  it('still lets a retryable crash spend the same budget', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'crash', message: 'boom' });
    const h = harness(await wf(retryYaml('stop')), runner);
    await h.scheduler.execute();
    expect(runner.calls.filter((c) => c.taskId === 'a')).toHaveLength(4);
  });

  it('stops or continues the run exactly as onFailure says', async () => {
    const stopping = new MockRunner().when('a', { kind: 'error', outcome: 'config_error', message: 'rejected' });
    const stop = harness(await wf(retryYaml('stop')), stopping);
    const stopped = await stop.scheduler.execute();
    expect(stopped.state).toBe('failed');
    expect(stop.run.tasks.b!.state).toBe('cancelled');

    const continuing = new MockRunner().when('a', { kind: 'error', outcome: 'config_error', message: 'rejected' });
    const carry = harness(await wf(retryYaml('continue')), continuing);
    await carry.scheduler.execute();
    expect(carry.run.tasks.b!.state).toBe('success');
  });
});

describe('scheduler: preflight', () => {
  const PREFLIGHT_YAML = `
name: preflight
defaults:
  onFailure: continue
  retry:
    attempts: 2
    delay: 0
tasks:
  - id: a
    prompt: p
  - id: b
    prompt: p
`;

  it('fails every task an unusable CLI would have run, once, before anything is spawned', async () => {
    const runner = new MockRunner();
    runner.preflightProblems = [{ taskIds: ['a', 'b'], message: 'codex "0.140.0" does not advertise appServer (codex.transport: appServer)' }];
    const h = harness(await wf(PREFLIGHT_YAML), runner);
    const result = await h.scheduler.execute();
    expect(runner.preflightCalls).toBe(1);
    expect(runner.calls).toEqual([]);
    expect(result.state).toBe('failed');
    for (const id of ['a', 'b']) {
      expect(h.run.tasks[id]!.state).toBe('failed');
      expect(h.run.tasks[id]!.reason).toBe('config_error');
      expect(h.run.tasks[id]!.message).toContain('does not advertise appServer');
      expect(h.run.tasks[id]!.attempts).toEqual([]);
    }
  });

  it('leaves the tasks a problem does not name alone', async () => {
    const runner = new MockRunner();
    runner.preflightProblems = [{ taskIds: ['a'], message: 'codex is too old for codex.configMode: isolated' }];
    const h = harness(await wf(PREFLIGHT_YAML), runner);
    await h.scheduler.execute();
    expect(h.run.tasks.a!.state).toBe('failed');
    expect(h.run.tasks.b!.state).toBe('success');
  });

  it('does not stop a run whose preflight itself cannot answer', async () => {
    const runner = new MockRunner();
    runner.preflight = async () => { throw new Error('detection exploded'); };
    const h = harness(await wf(PREFLIGHT_YAML), runner);
    const result = await h.scheduler.execute();
    expect(result.state).toBe('completed');
    expect(h.store.eventsOf('workflow.warning').at(-1)).toMatchObject({ message: expect.stringContaining('detection exploded') });
  });
});
