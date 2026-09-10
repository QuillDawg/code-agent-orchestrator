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
import { tmpGitRepo, captureCli, waitFor, FAKE_CLAUDE } from '../helpers/index.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import type { Interaction, InteractionAnswer } from '../../src/types/interaction.js';
import { canAllowAlways } from '../../src/types/interaction.js';
import type { SchedulerDeps } from '../../src/workflow/scheduler.js';
import { parseTranscriptLine } from '../../src/types/transcript.js';

interface Trace { taskId: string; args: string[]; streamInput?: boolean }

async function prepare(repo: string, yaml: string, env: Record<string, string>, interactionHandler?: SchedulerDeps['interactionHandler']) {
  const configPath = path.join(repo, 'workflow.yaml');
  await fs.writeFile(configPath, yaml, 'utf8');
  const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  const store = new FileRunStore(prepared.workflow.repositoryRoot);
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
  const tracePath = path.join(repo, '.orchestrator', 'trace.jsonl');
  const runtime = createRuntime({ run, environment: { FAKE_CLAUDE_TRACE: tracePath, ...env }, secrets: [], logger: silentLogger, interactionHandler });
  return { run, store, runtime, tracePath };
}

/** The control responses the fake CLI received, so the exact wire answer can be asserted. */
async function controlResponses(tracePath: string): Promise<Array<{ response: { request_id: string; response?: Record<string, unknown> } }>> {
  const text = await fs.readFile(`${tracePath}.control`, 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { response: { request_id: string; response?: Record<string, unknown> } });
}

async function execute(repo: string, yaml: string, env: Record<string, string>, interactionHandler?: SchedulerDeps['interactionHandler']) {
  const prepared = await prepare(repo, yaml, env, interactionHandler);
  const result = await prepared.runtime.scheduler.execute();
  const traceText = await fs.readFile(prepared.tracePath, 'utf8').catch(() => '');
  const trace = traceText.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Trace);
  return { ...prepared, result, trace };
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
    // The worker is told what was refused and how to end the attempt, whatever the dashboard's own wording
    // was, and both survive into the task's result.
    expect(denied.run.tasks['a']!.message).toBe('not on my machine (Bash: rm -rf build); finish with status needs_input if you cannot continue');
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

/**
 * The H3.7 acceptance matrix for Claude, rows 1-5 and 12, driven through the scheduler against the fake CLI
 * in both configurations: **attended** (an interaction handler is registered, so the CLI is started in ask
 * mode) and **headless** (none is). A worker blocked on a human must always end in exactly one of two
 * states - `waiting` while someone can still answer, `needs_input` once the attempt is over - and the
 * question or the permission has to survive into the task's result either way.
 */
describe('blocked on a human: Claude (H3.7 rows 1-5, 12)', () => {
  beforeAll(() => clearDetectionCache());

  // Headless with `permissionPrompts: ask`: nobody can answer, but the orchestrator still sees the request,
  // so its denial can name what was refused. The plain headless default is row 5 below.
  const ASK = 'name: i\nexecution:\n  workspaceStrategy: shared\nclaude:\n  permissionPrompts: ask\ntasks:\n  - id: a\n    prompt: do it\n';

  it('row 1 headless: an unanswerable permission prompt reaches needs_input naming the tool', async () => {
    const repo = await tmpGitRepo('cao-h3-perm-headless-');
    const { run, result, store } = await execute(repo, ASK, { FAKE_CLAUDE_MODE: 'permission' });
    expect(result.state).toBe('paused');
    const task = run.tasks['a']!;
    expect(task.state).toBe('needs_input');
    expect(task.result?.status).toBe('needs_input');
    // Not a generic "denied": the worker was told what was refused and how to end the attempt, and both
    // survive into the stored result an operator reads.
    expect(task.result?.error).toContain('Bash: rm -rf build');
    expect(task.result?.error).toContain('finish with status needs_input');
    expect(task.attempts[0]!.interactions![0]).toMatchObject({ kind: 'permission', answer: 'deny', source: 'no_handler' });
    const events = (await fs.readFile(path.join(store.paths.attemptDir(run.runId, 'a', 1), 'events.jsonl'), 'utf8')).trim().split('\n').map(parseTranscriptLine);
    expect(events.filter((e) => e?.kind === 'permission')).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({ kind: 'result', status: 'needs_input' });
  }, 30_000);

  it('row 2: a question is answered attended, and quoted in the result headless', async () => {
    const attended = await tmpGitRepo('cao-h3-question-on-');
    const asked: Interaction[] = [];
    const on = await execute(attended, ONE, { FAKE_CLAUDE_MODE: 'question-multi' }, async (i): Promise<InteractionAnswer> => {
      asked.push(i);
      return { kind: 'answer', answers: { 'Which database?': 'postgres', 'Which regions?': 'eu, us' } };
    });
    expect(on.result.state).toBe('completed');
    expect(asked[0]!.questions).toEqual([
      { question: 'Which database?', header: 'Database', options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }], multiSelect: false },
      { question: 'Which regions?', header: 'Regions', options: [{ label: 'eu', description: 'Europe' }, { label: 'us', description: 'North America' }], multiSelect: true },
    ]);
    expect(on.run.tasks['a']!.result?.data).toEqual({ answers: { 'Which database?': 'postgres', 'Which regions?': 'eu, us' } });

    const headless = await tmpGitRepo('cao-h3-question-off-');
    const off = await execute(headless, ASK, { FAKE_CLAUDE_MODE: 'question-multi' });
    expect(off.run.tasks['a']!.state).toBe('needs_input');
    // The question itself, not "denied": an operator reading `cao status` can answer it.
    expect(off.run.tasks['a']!.result?.error).toContain('Which database?');
  }, 60_000);

  it('row 4: nobody answers, the request times out, and the worker finishes with needs_input', async () => {
    const repo = await tmpGitRepo('cao-h3-timeout-');
    const yaml = 'name: i\nexecution:\n  workspaceStrategy: shared\n  interactionTimeout: 300ms\ntasks:\n  - id: a\n    timeout: 20s\n    prompt: p\n';
    const { run, result } = await execute(repo, yaml, { FAKE_CLAUDE_MODE: 'permission' }, () => new Promise(() => undefined));
    expect(result.state).toBe('paused');
    expect(run.tasks['a']!.state).toBe('needs_input');
    expect(run.tasks['a']!.attempts[0]!.interactions![0]!.source).toBe('timeout');
    expect(run.tasks['a']!.result?.error).toMatch(/Bash: rm -rf build within 00m 00s/);
    expect(run.tasks['a']!.result?.error).toContain('finish with status needs_input');
  }, 40_000);

  it('interactionTimeout "never" leaves the request open until the task timeout bounds it', async () => {
    const repo = await tmpGitRepo('cao-h3-never-');
    const yaml = 'name: i\nexecution:\n  workspaceStrategy: shared\n  interactionTimeout: never\ntasks:\n  - id: a\n    timeout: 2s\n    retries: 0\n    prompt: p\n';
    let sawWaiting = false;
    const { run, result } = await execute(repo, yaml, { FAKE_CLAUDE_MODE: 'permission-hang' }, (_i, signal) =>
      new Promise<InteractionAnswer>((resolve) => {
        sawWaiting = true;
        signal.addEventListener('abort', () => resolve({ kind: 'deny', message: 'gone' }));
      }),
    );
    expect(sawWaiting).toBe(true);
    // No interaction timeout fired: the attempt ended on the task's own timeout, which is the only bound.
    expect(run.tasks['a']!.attempts[0]!.interactions![0]!.source).not.toBe('timeout');
    expect(run.tasks['a']!.attempts[0]!.outcome).toBe('timeout');
    expect(result.state).toBe('failed');
  }, 40_000);

  it('row 5: prompts denied by the CLI itself end as needs_input, not failed', async () => {
    // Headless default: no handler, so the worker runs with --permission-prompts none and Claude Code
    // refuses the tool without the orchestrator ever seeing the request.
    const repo = await tmpGitRepo('cao-h3-cli-deny-');
    const { run, result, trace } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'permission-give-up' });
    expect(trace[0]!.args).toEqual(expect.arrayContaining(['--permission-prompts', 'none']));
    expect(result.state).toBe('paused');
    const task = run.tasks['a']!;
    expect(task.state).toBe('needs_input');
    expect(task.attempts[0]!.outcome).toBe('needs_input');
    // The session ended with an error result, which used to be reported as a crash. What it really was is
    // a worker that could not get permission, and the result says which tool and what to do about it.
    expect(task.result?.error).toContain('Bash: npm publish');
    expect(task.result?.error).toContain('permissionPrompts');
    expect(task.result?.warnings).toEqual(['I could not continue without running npm publish.']);
    expect(task.attempts[0]!.interactions ?? []).toHaveLength(0);
  }, 30_000);

  it('row 5 with permissionPrompts: deny explicitly set keeps the same ending', async () => {
    const repo = await tmpGitRepo('cao-h3-deny-mode-');
    const yaml = 'name: i\nexecution:\n  workspaceStrategy: shared\nclaude:\n  permissionPrompts: deny\ntasks:\n  - id: a\n    prompt: p\n';
    const asked: Interaction[] = [];
    const { run, trace } = await execute(repo, yaml, { FAKE_CLAUDE_MODE: 'permission-give-up' }, async (i): Promise<InteractionAnswer> => {
      asked.push(i);
      return { kind: 'allow', scope: 'once' };
    });
    // A dashboard is attached, but the task asked for deny mode: the CLI never routes the prompt to it.
    expect(asked).toEqual([]);
    expect(trace[0]!.args).toEqual(expect.arrayContaining(['--permission-prompts', 'none']));
    expect(run.tasks['a']!.state).toBe('needs_input');
    expect(run.tasks['a']!.result?.error).toContain('Bash: npm publish');
  }, 30_000);

  it('row 12: two prompts open at once are answerable in either order', async () => {
    const repo = await tmpGitRepo('cao-h3-two-');
    const open: Array<{ interaction: Interaction; resolve: (a: InteractionAnswer) => void }> = [];
    const prepared = await prepare(repo, ONE, { FAKE_CLAUDE_MODE: 'permission-two' }, (interaction) =>
      new Promise<InteractionAnswer>((resolve) => open.push({ interaction, resolve })),
    );
    const done = prepared.runtime.scheduler.execute();
    await waitFor(() => open.length === 2, 20_000);
    const task = prepared.run.tasks['a']!;
    expect(task.state).toBe('waiting');
    expect(open.map((o) => o.interaction.toolName)).toEqual(['Bash', 'Write']);
    // "Allow for the rest of this task" is offered only where the CLI proposed a rule for it.
    expect(canAllowAlways(open[0]!.interaction)).toBe(true);
    expect(canAllowAlways(open[1]!.interaction)).toBe(false);
    const first = task.pendingInteraction!.id;
    expect(first).toBe(open[0]!.interaction.id);

    open[1]!.resolve({ kind: 'allow', scope: 'always' }); // the newer one first
    await waitFor(() => (task.attempts[0]!.interactions ?? []).some((i) => i.answeredAt), 10_000);
    // Still blocked: the older request has not been answered, so the task has not gone back to running.
    expect(task.state).toBe('waiting');
    expect(task.pendingInteraction?.id).toBe(first);

    open[0]!.resolve({ kind: 'allow', scope: 'always' });
    const result = await done;
    expect(result.state).toBe('completed');
    expect(prepared.run.tasks['a']!.state).toBe('success');
    expect(prepared.run.tasks['a']!.pendingInteraction).toBeUndefined();
    expect(prepared.run.tasks['a']!.result?.data).toMatchObject({ settled: ['write', 'build'], decisions: ['allow', 'allow'] });

    const responses = await controlResponses(prepared.tracePath);
    const byId = new Map(responses.map((r) => [r.response.request_id, r.response.response]));
    // The rule the CLI itself suggested, forced to the session so nothing outlives the worker process...
    expect(byId.get(open[0]!.interaction.id)).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }], behavior: 'allow', destination: 'session' }],
    });
    // ...and no rule at all for the request that carried no suggestion: "always" degrades to allow once.
    expect(byId.get(open[1]!.interaction.id)).toEqual({ behavior: 'allow' });
  }, 40_000);

  it('row 12 headless: both prompts are denied and the task pauses holding them', async () => {
    const repo = await tmpGitRepo('cao-h3-two-headless-');
    const { run, result } = await execute(repo, ASK, { FAKE_CLAUDE_MODE: 'permission-two' });
    expect(result.state).toBe('paused');
    expect(run.tasks['a']!.state).toBe('needs_input');
    expect(run.tasks['a']!.attempts[0]!.interactions).toHaveLength(2);
    expect(run.tasks['a']!.attempts[0]!.interactions!.every((i) => i.answer === 'deny' && i.source === 'no_handler')).toBe(true);
    expect(run.tasks['a']!.result?.error).toContain('Bash: npm run build');
    expect(run.tasks['a']!.result?.error).toContain('Write src/new.ts');
  }, 30_000);

  it('row 3: a request withdrawn after it was answered is ignored, and the next one still works', async () => {
    const repo = await tmpGitRepo('cao-h3-late-cancel-');
    const answers: string[] = [];
    const { run, result } = await execute(repo, ONE, { FAKE_CLAUDE_MODE: 'permission-cancel-late' }, async (i): Promise<InteractionAnswer> => {
      answers.push(i.id);
      return { kind: 'allow', scope: 'once' };
    });
    expect(result.state).toBe('completed');
    expect(answers).toHaveLength(2);
    // The late cancel settled nothing: both requests were answered by the handler, not by a withdrawal.
    expect(run.tasks['a']!.attempts[0]!.interactions!.map((i) => i.source)).toEqual(['handler', 'handler']);
    expect(run.tasks['a']!.result?.data).toEqual({ first: 'allow', second: 'allow' });
  }, 30_000);
});
