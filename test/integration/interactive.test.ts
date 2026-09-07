/**
 * Round-trips through the real Claude runner and the fake CLI in `--input-format stream-json` mode:
 * permission prompts and questions answered by an orchestrator-side handler.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { tmpGitRepo, captureCli, FAKE_CLAUDE } from '../helpers/index.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import type { Interaction, InteractionAnswer } from '../../src/types/interaction.js';
import type { SchedulerDeps } from '../../src/workflow/scheduler.js';
import { parseTranscriptLine } from '../../src/types/transcript.js';

interface Trace { taskId: string; args: string[]; streamInput?: boolean }

async function execute(repo: string, yaml: string, env: Record<string, string>, interactionHandler?: SchedulerDeps['interactionHandler']) {
  const configPath = path.join(repo, 'workflow.yaml');
  await fs.writeFile(configPath, yaml, 'utf8');
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
  const runtime = createRuntime({ run, environment: { FAKE_CLAUDE_TRACE: path.join(repo, '.orchestrator', 'trace.jsonl'), ...env }, secrets: [], logger: silentLogger, interactionHandler });
  const result = await runtime.scheduler.execute();
  const traceText = await fs.readFile(path.join(repo, '.orchestrator', 'trace.jsonl'), 'utf8').catch(() => '');
  const trace = traceText.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Trace);
  return { run, result, store, trace };
}

const ONE = 'name: i\nexecution:\n  workspaceStrategy: shared\ntasks:\n  - id: a\n    prompt: do it\n';

describe('interactive worker round-trips (fake Claude, stream-json input)', () => {
  beforeAll(() => clearDetectionCache());

  it('allows a permission prompt and the worker continues', async () => {
    const repo = await tmpGitRepo('cao-int-allow-');
    const asked: Interaction[] = [];
    const { run, result, trace, store } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'permission' }, async (i) => {
      asked.push(i);
      return { kind: 'allow', scope: 'once' };
    });
    expect(result.state).toBe('completed');
    expect(run.tasks['a']!.result?.data).toMatchObject({ permission: 'allowed' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'permission', toolName: 'Bash', title: 'Bash: rm -rf build', description: 'Clean the build directory' });
    expect(trace[0]!.streamInput).toBe(true);
    expect(trace[0]!.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']));
    expect(trace[0]!.args).not.toContain('--permission-prompts');
    const attempt = run.tasks['a']!.attempts[0]!;
    expect(attempt.interactions).toHaveLength(1);
    expect(attempt.interactions![0]).toMatchObject({ kind: 'permission', answer: 'allow', source: 'handler' });
    expect(attempt.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, contextWindow: 200000, costUsd: 0.01 });
    const events = (await fs.readFile(path.join(store.paths.attemptDir(run.runId, 'a', 1), 'events.jsonl'), 'utf8')).trim().split('\n').map(parseTranscriptLine);
    const perms = events.filter((e) => e?.kind === 'permission');
    expect(perms).toHaveLength(2);
    expect(perms[1]).toMatchObject({ decision: 'allow' });
    expect(events.some((e) => e?.kind === 'tool_result')).toBe(true);
    // The attempt log has to end with the outcome, otherwise `cao logs` and `cao peek` show the work but
    // never say how it went.
    expect(events[events.length - 1]).toMatchObject({ kind: 'result', status: 'success', isError: false });

    // The run-level log keeps only the interaction summary: raw tool input belongs to the attempt directory.
    const runEvents = (await fs.readFile(store.paths.eventsFile(run.runId), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; interaction?: Record<string, unknown> });
    const requested = runEvents.find((e) => e.type === 'task.interaction.requested')!;
    expect(requested.interaction).toMatchObject({ kind: 'permission', toolName: 'Bash', title: 'Bash: rm -rf build' });
    expect(requested.interaction!.input).toBeUndefined();

    // cao task reports what the worker asked for, how long it waited and who answered
    const shown = await captureCli(() => taskCommand(['a'], { repository: repo }));
    expect(shown.stdout).toMatch(/ {2}#1 {2}permission {2}Bash: rm -rf build {2}\d\d:\d\d:\d\d {2}waited \d+s {2}allowed \(in the dashboard\)/);
    expect(shown.stdout).toMatch(/waited \d\dm \d\ds in total across 1 request$/m);
    const shape = JSON.parse((await captureCli(() => taskCommand(['a'], { repository: repo, json: true }))).stdout) as {
      interactions: Array<{ attempt: number; kind: string; title: string; answer: string; source: string; waitedMs: number }>;
    };
    expect(shape.interactions).toHaveLength(1);
    expect(shape.interactions[0]).toMatchObject({ attempt: 1, kind: 'permission', title: 'Bash: rm -rf build', answer: 'allow', source: 'handler' });
    expect(shape.interactions[0]!.waitedMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('passes "allow always" as session-scoped rules and forwards deny messages', async () => {
    const repo = await tmpGitRepo('cao-int-always-');
    const { run } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'permission-always' }, async () => ({ kind: 'allow', scope: 'always' }));
    expect(run.tasks['a']!.result?.data?.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'session' }]);

    const repo2 = await tmpGitRepo('cao-int-deny-');
    const denied = await execute(repo2, ONE, { FAKE_CLAUDE_MODE: 'permission' }, async () => ({ kind: 'deny', message: 'not on my machine' }));
    expect(denied.result.state).toBe('paused');
    expect(denied.run.tasks['a']!.state).toBe('needs_input');
    expect(denied.run.tasks['a']!.message).toBe('not on my machine');
  }, 30_000);

  it('answers a question', async () => {
    const repo = await tmpGitRepo('cao-int-question-');
    const { run } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'question' }, async (i): Promise<InteractionAnswer> => {
      expect(i.kind).toBe('question');
      expect(i.questions).toEqual([{ question: 'Which database?', header: 'Database', options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }], multiSelect: false }]);
      return { kind: 'answer', answers: { 'Which database?': 'postgres' } };
    });
    expect(run.tasks['a']!.result?.data).toEqual({ answers: { 'Which database?': 'postgres' } });
    expect(run.tasks['a']!.attempts[0]!.interactions![0]).toMatchObject({ kind: 'question', answer: 'answer' });
  }, 30_000);

  it('denies everything itself in headless mode (no handler) and keeps the old flags', async () => {
    const repo = await tmpGitRepo('cao-int-headless-');
    const { run, trace } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'success' });
    expect(run.tasks['a']!.state).toBe('success');
    expect(trace[0]!.streamInput).toBe(false);
    expect(trace[0]!.args).toEqual(expect.arrayContaining(['--permission-prompts', 'none']));
  }, 30_000);

  it('handles a withdrawn request and an abort while waiting', async () => {
    const repo = await tmpGitRepo('cao-int-cancel-');
    let aborted = false;
    const { run } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'permission-cancel' }, (_i, signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ kind: 'deny', message: 'withdrawn' });
      })),
    );
    expect(aborted).toBe(true);
    expect(run.tasks['a']!.state).toBe('success');
    expect(run.tasks['a']!.attempts[0]!.interactions![0]!.source).toBe('cancelled');

    const repo2 = await tmpGitRepo('cao-int-hang-');
    const yaml = 'name: i\nexecution:\n  workspaceStrategy: shared\n  interactionTimeout: 300ms\ntasks:\n  - id: a\n    prompt: p\n    timeout: 5s\n';
    const hung = await execute(repo2, yaml, { FAKE_CLAUDE_MODE: 'permission-hang' }, () => new Promise(() => undefined));
    expect(hung.run.tasks['a']!.attempts[0]!.interactions![0]!.source).toBe('timeout');
    expect(hung.run.tasks['a']!.attempts[0]!.outcome).toBe('timeout');
  }, 40_000);
});
