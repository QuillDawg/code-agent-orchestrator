import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildClaudeArgs, ClaudeRunner, permissionModeDowngrade, resolveClaudeOptions } from '../../src/runners/claude/claude-runner.js';
import { clearDetectionCache, detectClaude } from '../../src/runners/claude/detect.js';
import { parseClaudeEvents } from '../../src/runners/claude/event-parser.js';
import { ProcessManager } from '../../src/execution/process-manager.js';
import { parseTranscriptLine, type TranscriptEntry } from '../../src/types/transcript.js';
import type { RunnerUsage } from '../../src/types/result.js';
import type { RunnerHooks } from '../../src/runners/task-runner.js';
import type { ResolvedTask } from '../../src/types/workflow.js';
import { renderTranscript } from '../../src/tui/transcript.js';
import { FAKE_CLAUDE, tmpDir } from '../helpers/index.js';

type ModelBits = Pick<ResolvedTask, 'claude' | 'model' | 'effort'>;

const task = (bits: Partial<ModelBits> = {}): ModelBits => ({ claude: {}, ...bits });

/** The value that follows `flag` in an argv array, or undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('Claude runner model/effort resolution', () => {
  it('passes the resolved generic model and effort to the CLI', () => {
    // `model:`/`effort:` at workflow, defaults, template or task level all arrive as task.model/effort.
    const options = resolveClaudeOptions({}, task({ model: 'sonnet', effort: 'high' }));
    const args = buildClaudeArgs(options, 'session-1');

    expect(flagValue(args, '--model')).toBe('sonnet');
    expect(flagValue(args, '--effort')).toBe('high');
  });

  it('still honours the legacy claude.model / claude.effort block', () => {
    const options = resolveClaudeOptions({}, task({ claude: { model: 'opus', effort: 'max' } }));
    const args = buildClaudeArgs(options, 'session-1');

    expect(flagValue(args, '--model')).toBe('opus');
    expect(flagValue(args, '--effort')).toBe('max');
  });

  it('lets the resolved generic keys win over the legacy claude block', () => {
    const options = resolveClaudeOptions({}, task({ model: 'sonnet', effort: 'low', claude: { model: 'opus', effort: 'max' } }));

    expect(options.model).toBe('sonnet');
    expect(options.effort).toBe('low');
  });

  it('drops effort for Haiku, which has no effort levels, wherever the effort came from', () => {
    for (const options of [resolveClaudeOptions({ effort: 'high' }, task({ model: 'claude-haiku-4-5' })), resolveClaudeOptions({}, task({ model: 'haiku', effort: 'low' }))]) {
      expect(options.effort).toBeUndefined();
      const args = buildClaudeArgs(options, 'session-1');
      expect(flagValue(args, '--model')).toMatch(/haiku/);
      expect(args).not.toContain('--effort');
    }
  });

  it('keeps workflow-level claude defaults that the task does not override', () => {
    const options = resolveClaudeOptions({ model: 'opus', maxBudgetUsd: 5 }, task({ effort: 'high' }));

    expect(options.model).toBe('opus');
    expect(options.maxBudgetUsd).toBe(5);
    expect(options.effort).toBe('high');
  });

  it.each(['none', 'minimal'] as const)('drops the Codex-only effort level "%s"', (effort) => {
    const args = buildClaudeArgs(resolveClaudeOptions({}, task({ effort })), 'session-1');

    expect(args).not.toContain('--effort');
  });

  it('omits both flags when nothing is configured, leaving the CLI default in place', () => {
    const args = buildClaudeArgs(resolveClaudeOptions({}, task()), 'session-1');

    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });
});

describe('Claude stream events: tool ids and subagent parentage', () => {
  const assistant = (content: unknown[], parent?: string): string =>
    JSON.stringify({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { id: 'm1', model: 'fake', content } });

  it('keeps the tool_use id on a call and on the result that answers it', () => {
    const [call] = parseClaudeEvents(assistant([{ type: 'tool_use', id: 'tu-1', name: 'Grep', input: { pattern: 'TODO', path: 'src' } }]));
    expect(call).toMatchObject({ kind: 'activity', tool: 'Grep', toolUseId: 'tu-1' });
    const [bash] = parseClaudeEvents(assistant([{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'npm test' } }]));
    expect(bash).toMatchObject({ kind: 'command', toolUseId: 'tu-2' });
    const [res] = parseClaudeEvents(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'hit' }] } }));
    expect(res).toMatchObject({ kind: 'tool_result', toolUseId: 'tu-1', text: 'hit' });
  });

  it('marks everything a subagent produced with the Agent call that spawned it', () => {
    const [text] = parseClaudeEvents(assistant([{ type: 'text', text: 'Reviewing' }], 'tu-agent'));
    expect(text).toMatchObject({ kind: 'text', parentToolUseId: 'tu-agent' });
    const [nested] = parseClaudeEvents(assistant([{ type: 'tool_use', id: 'tu-3', name: 'Read', input: { file_path: 'a.ts' } }], 'tu-agent'));
    expect(nested).toMatchObject({ kind: 'activity', toolUseId: 'tu-3', parentToolUseId: 'tu-agent' });
    const [nestedResult] = parseClaudeEvents(
      JSON.stringify({ type: 'user', parent_tool_use_id: 'tu-agent', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'ok' }] } }),
    );
    expect(nestedResult).toMatchObject({ kind: 'tool_result', toolUseId: 'tu-3', parentToolUseId: 'tu-agent' });
    // A top-level message says so with null, which must not become a parent id.
    const [top] = parseClaudeEvents(assistant([{ type: 'text', text: 'Back in the parent' }]));
    expect(top).toMatchObject({ kind: 'text' });
    expect((top as { parentToolUseId?: string }).parentToolUseId).toBeUndefined();
  });

  it('parses thinking blocks and skips the ones with nothing readable in them', () => {
    const [thought] = parseClaudeEvents(assistant([{ type: 'thinking', thinking: 'Let me consider the options.', signature: 'sig' }]));
    expect(thought).toMatchObject({ kind: 'thinking', text: 'Let me consider the options.' });

    // A subagent's thinking is attributed like anything else it produced.
    const [nested] = parseClaudeEvents(assistant([{ type: 'thinking', thinking: 'Sub-thought', signature: 'sig' }], 'tu-agent'));
    expect(nested).toMatchObject({ kind: 'thinking', parentToolUseId: 'tu-agent' });

    // `redacted_thinking` carries an opaque blob, and an empty block carries nothing worth an entry.
    expect(parseClaudeEvents(assistant([{ type: 'redacted_thinking', data: 'opaque' }]))).toEqual([{ kind: 'other', type: 'assistant' }]);
    expect(parseClaudeEvents(assistant([{ type: 'thinking', thinking: '   ' }]))).toEqual([{ kind: 'other', type: 'assistant' }]);

    // One message can carry a thought and the prose that followed it; both become entries, in order.
    const both = parseClaudeEvents(assistant([{ type: 'thinking', thinking: 'first' }, { type: 'text', text: 'then' }]));
    expect(both.map((e) => e.kind)).toEqual(['thinking', 'text']);
  });
});

describe('Claude CLI capability probe', () => {
  beforeEach(() => clearDetectionCache());
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_NO_SUBAGENT_TEXT;
    clearDetectionCache();
  });

  it('passes --forward-subagent-text only when the installed CLI advertises it', async () => {
    const supported = await detectClaude(FAKE_CLAUDE);
    expect(supported).toMatchObject({ found: true, forwardSubagentText: true });
    expect(buildClaudeArgs({}, 's', undefined, undefined, 'deny', supported.forwardSubagentText)).toContain('--forward-subagent-text');

    process.env.FAKE_CLAUDE_NO_SUBAGENT_TEXT = '1';
    clearDetectionCache();
    const older = await detectClaude(FAKE_CLAUDE);
    expect(older.forwardSubagentText).toBe(false);
    expect(buildClaudeArgs({}, 's', undefined, undefined, 'deny', older.forwardSubagentText)).not.toContain('--forward-subagent-text');
  });

  it('omits the flag by default, so a runner that never probed cannot send it', () => {
    expect(buildClaudeArgs(resolveClaudeOptions({}, task()), 'session-1')).not.toContain('--forward-subagent-text');
  });
});

interface Trace {
  args: string[];
}

/** Run one attempt of the fake CLI through the real runner and collect what the orchestrator saw. */
async function runFake(mode: string, extraEnv: Record<string, string> = {}): Promise<{ entries: TranscriptEntry[]; activity: string[]; usage: RunnerUsage | undefined; persisted: TranscriptEntry[]; trace: Trace[]; warnings: string[] }> {
  clearDetectionCache();
  const dir = await tmpDir('cao-runner-');
  const attemptDir = path.join(dir, 'attempt');
  const entries: TranscriptEntry[] = [];
  const activity: string[] = [];
  const warnings: string[] = [];
  let usage: RunnerUsage | undefined;
  const hooks: RunnerHooks = {
    onActivity: (line) => activity.push(line),
    onOutput: () => {},
    onProcess: () => {},
    onTranscript: (e) => entries.push(e),
    onUsage: (u) => {
      usage = u;
    },
    onFileChange: () => {},
    onWarning: (message) => warnings.push(message),
    onInteraction: () => Promise.reject(new Error('no interaction expected')),
  };
  const runner = new ClaudeRunner({ processManager: new ProcessManager(), defaults: { command: FAKE_CLAUDE } });
  const outcome = await runner.run(
    {
      runId: 'r1',
      task: { id: 'a', claude: {} } as ResolvedTask,
      attempt: 1,
      prompt: 'do it',
      cwd: dir,
      env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_TRACE: path.join(dir, 'trace.jsonl'), ...extraEnv },
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      attemptDir,
    },
    hooks,
  );
  expect(outcome.kind).toBe('result');
  const log = await fs.readFile(path.join(attemptDir, 'events.jsonl'), 'utf8');
  const persisted = log.trim().split('\n').map(parseTranscriptLine).filter((e): e is TranscriptEntry => e !== null);
  const traceText = await fs.readFile(path.join(dir, 'trace.jsonl'), 'utf8');
  const trace = traceText.trim().split('\n').map((l) => JSON.parse(l) as Trace);
  return { entries, activity, usage, persisted, trace, warnings };
}

describe('Claude runner: the permission mode the CLI actually runs', () => {
  afterEach(() => clearDetectionCache());

  it('names the model when auto mode is the reason, and stays quiet when the modes agree', () => {
    expect(permissionModeDowngrade('auto', 'auto', 'sonnet')).toBeUndefined();
    expect(permissionModeDowngrade('manual', 'default', 'sonnet')).toBeUndefined();
    expect(permissionModeDowngrade('auto', undefined, 'claude-haiku-4-5')).toBeUndefined();
    expect(permissionModeDowngrade('auto', 'default', 'claude-haiku-4-5')).toMatch(/"default", not the requested "auto" because claude-haiku-4-5 has no auto mode; every file write and command will prompt/);
    expect(permissionModeDowngrade('acceptEdits', 'default', 'sonnet')).toMatch(/"default", not the requested "acceptEdits"; every file write/);
  });

  it('warns, in the transcript and to the host, when a session starts in a different mode than requested', async () => {
    const downgraded = await runFake('success', { FAKE_CLAUDE_PERMISSION_MODE: 'default', FAKE_CLAUDE_MODEL: 'claude-haiku-4-5' });
    expect(downgraded.warnings).toHaveLength(1);
    expect(downgraded.warnings[0]).toMatch(/because claude-haiku-4-5 has no auto mode/);
    expect(downgraded.entries.filter((e) => e.kind === 'system').map((e) => (e as { text: string }).text)).toEqual(expect.arrayContaining([expect.stringMatching(/not the requested "auto"/)]));
    expect(downgraded.persisted.some((e) => e.kind === 'system' && /not the requested "auto"/.test((e as { text: string }).text))).toBe(true);
    const honoured = await runFake('success');
    expect(honoured.warnings).toEqual([]);
  });
});

describe('Claude runner: tool timing and subagent entries', () => {
  afterEach(() => clearDetectionCache());

  it('keeps tool ids and parentage on the transcript and counts the time spent in tools', async () => {
    const { entries, usage, persisted, trace } = await runFake('subagent');

    expect(trace[0]!.args).toContain('--forward-subagent-text');

    const agent = entries.find((e) => e.kind === 'tool' && e.tool === 'Agent')!;
    const agentId = agent.kind === 'tool' ? agent.toolUseId : undefined;
    expect(agentId).toBeTruthy();
    expect(entries.find((e) => e.kind === 'tool' && e.tool === 'Grep')).toMatchObject({ parentToolUseId: agentId });
    expect(entries.find((e) => e.kind === 'text' && e.text.startsWith('Reviewing'))).toMatchObject({ parentToolUseId: agentId });
    // The parent's own prose is not attributed to the subagent.
    const parentText = entries.find((e) => e.kind === 'text' && e.text.startsWith('Delegated'))!;
    expect((parentText as { parentToolUseId?: string }).parentToolUseId).toBeUndefined();

    // Every result names the call it answers, so a viewer can pair them.
    const results = entries.filter((e) => e.kind === 'tool_result');
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.kind === 'tool_result' && r.toolUseId).toBeTruthy();

    expect(usage?.toolMs).toBeGreaterThan(0);

    // events.jsonl carries the same ids, so an attempt read back from disk nests exactly as the live view did.
    expect(persisted.find((e) => e.kind === 'tool' && e.tool === 'Grep')).toMatchObject({ parentToolUseId: agentId });
  });

  it('nests two concurrent subagents and a subagent that delegates again, losing nothing', async () => {
    const { entries } = await runFake('subagents');
    const idOf = (line: string): string | undefined => {
      const e = entries.find((x) => x.kind === 'tool' && x.line.includes(line));
      return e?.kind === 'tool' ? e.toolUseId : undefined;
    };
    const alpha = idOf('Review the diff')!;
    const gamma = idOf('Dig into')!;
    expect(alpha).toBeTruthy();
    // The grandchild names the subagent that spawned it, not the one at the top.
    expect(entries.find((e) => e.kind === 'tool' && e.line.startsWith('Read'))).toMatchObject({ parentToolUseId: gamma });
    expect(entries.find((e) => e.kind === 'tool' && e.line.includes('Dig into'))).toMatchObject({ parentToolUseId: alpha });

    const lines = renderTranscript(entries, { color: false, width: 0, showToolResults: true });
    const text = lines.join('\n');
    for (const expected of ['Reviewing the diff', 'Digging in', 'Grep: TODO in src', 'Read src/a.ts', 'the contents', 'One stale TODO', 'tests passed']) {
      expect(text).toContain(expected);
    }
    // Each report sits under the call it answers, not in a heap at the end.
    expect(lines.indexOf('      Found 1 TODO')).toBeLessThan(lines.findIndex((l) => l.includes('Agent: Check the tests')));
    // And the call the session never answered says so instead of showing a time.
    expect(text).toContain('Write src/never.ts · no result');
  });

  it('leaves a tool whose result never arrives out of the time spent in tools', async () => {
    const { usage, entries } = await runFake('orphan-tool');
    // The call opened a timer that nothing ever closed; counting it would invent time the worker never spent.
    expect(usage?.toolMs).toBeUndefined();
    expect(entries.some((e) => e.kind === 'command')).toBe(true);
  });

  it('records thinking in the attempt log without announcing it anywhere else', async () => {
    const { entries, activity, persisted } = await runFake('thinking');

    const thoughts = entries.filter((e) => e.kind === 'thinking');
    expect(thoughts.map((e) => (e.kind === 'thinking' ? e.text : ''))).toEqual(['Let me consider the options here.', 'Second thought.']);
    // The attempt's own log is where thinking is kept; nothing is dropped on the way to disk.
    expect(persisted.filter((e) => e.kind === 'thinking')).toHaveLength(2);
    // The activity line feeds the table, live.json and the plain renderer, so a thought must never reach it.
    expect(activity.some((l) => l.includes('consider the options'))).toBe(false);
    expect(activity.some((l) => l.startsWith('Working on '))).toBe(true);
  });
});
