import { describe, it, expect } from 'vitest';
import { encodeUserMessage, encodeControlResponse, encodeErrorResponse, toInteraction, permissionResult, sessionRules, summarizeAnswer, PendingInteractions } from '../../src/runners/claude/protocol.js';
import { canAllowAlways } from '../../src/types/interaction.js';
import { parseClaudeEvents, parseClaudeLine, describeToolUse } from '../../src/runners/claude/event-parser.js';

const ctx = { taskId: 't1', attempt: 1, agent: 'claude' as const };

describe('claude stdio protocol', () => {
  it('frames the prompt as a single user message line', () => {
    const line = encodeUserMessage('hello\nworld');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: 'hello\nworld' }, parent_tool_use_id: null, session_id: '' });
  });

  it('builds a permission interaction from a can_use_tool request', () => {
    const i = toInteraction('r1', { tool_name: 'Bash', input: { command: 'npm publish' }, description: 'Publish', tool_use_id: 'tu1', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm publish' }], behavior: 'allow', destination: 'localSettings' }], default_to_no: true }, ctx);
    expect(i).toMatchObject({ id: 'r1', kind: 'permission', toolName: 'Bash', title: 'Bash: npm publish', description: 'Publish', toolUseId: 'tu1', defaultToNo: true, taskId: 't1', attempt: 1 });
    expect(i.suggestions).toHaveLength(1);
    expect(i.questions).toBeUndefined();
  });

  it('builds a question interaction from AskUserQuestion', () => {
    const questions = [{ question: 'Which db?', header: 'DB', options: [{ label: 'pg', description: 'relational' }, { label: 'mongo' }], multiSelect: true }];
    const i = toInteraction('r2', { tool_name: 'AskUserQuestion', input: { questions } }, ctx);
    expect(i.kind).toBe('question');
    expect(i.title).toBe('Asking: Which db?');
    expect(i.questions).toEqual([{ question: 'Which db?', header: 'DB', options: [{ label: 'pg', description: 'relational' }, { label: 'mongo', description: undefined }], multiSelect: true }]);
  });

  it('encodes allow once, allow always (session-scoped), deny and answers', () => {
    const perm = toInteraction('r1', { tool_name: 'Bash', input: { command: 'x' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x' }], behavior: 'allow', destination: 'localSettings' }, { type: 'addDirectories', directories: ['/tmp'], destination: 'session' }] }, ctx);
    expect(permissionResult(perm, { kind: 'allow', scope: 'once' })).toEqual({ behavior: 'allow' });
    expect(permissionResult(perm, { kind: 'allow', scope: 'always' })).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x' }], behavior: 'allow', destination: 'session' }] });
    expect(permissionResult(perm, { kind: 'deny', message: 'no' })).toEqual({ behavior: 'deny', message: 'no' });

    // Only `addRules` can be reused as a session rule; a mode change is not one, so nothing is remembered.
    expect(toInteraction('r4', { tool_name: 'Bash', input: {}, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] }, ctx).suggestions).toBeUndefined();

    const questions = [{ question: 'Which db?', options: [{ label: 'pg' }, { label: 'mongo' }], multiSelect: true }];
    const q = toInteraction('r2', { tool_name: 'AskUserQuestion', input: { questions } }, ctx);
    const line = encodeControlResponse(q, { kind: 'answer', answers: { 'Which db?': 'pg, mongo' } });
    expect(JSON.parse(line)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r2', response: { behavior: 'allow', updatedInput: { questions, answers: { 'Which db?': 'pg, mongo' } } } } });
    expect(summarizeAnswer({ kind: 'answer', answers: { a: 'x', b: 'y' } })).toBe('x / y');
    expect(JSON.parse(encodeErrorResponse('r9', 'nope'))).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'r9', error: 'nope' } });
  });

  it('settles each pending request exactly once', () => {
    const p = new PendingInteractions();
    const s1 = p.open('a');
    p.open('b');
    expect(p.size).toBe(2);
    expect(p.settle('a')).toBe(true);
    expect(p.settle('a')).toBe(false);
    expect(s1.aborted).toBe(false);
    p.cancel('b', 'withdrawn');
    expect(p.settle('b')).toBe(false);
    const s3 = p.open('c');
    p.abortAll('exit');
    expect(s3.aborted).toBe(true);
    expect(p.size).toBe(0);
  });

  it('never invents a blanket allow when the CLI suggested no rule', () => {
    // Pressing A on one `rm -rf build` must not authorize every later shell command in the session.
    const bare = toInteraction('r3', { tool_name: 'Bash', input: { command: 'rm -rf build' } }, ctx);
    expect(bare.suggestions).toBeUndefined();
    expect(canAllowAlways(bare)).toBe(false);
    expect(sessionRules(bare)).toEqual([]);
    expect(permissionResult(bare, { kind: 'allow', scope: 'always' })).toEqual({ behavior: 'allow' });

    const suggested = toInteraction('r5', { tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow' }] }, ctx);
    expect(canAllowAlways(suggested)).toBe(true);
    expect(canAllowAlways({ ...suggested, suppressAlwaysAllow: true })).toBe(false);
  });
});

describe('stream-json parser', () => {
  it('emits every block of an assistant message plus its usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-x',
        content: [
          { type: 'text', text: 'Let me look' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'b.ts', old_string: 'x', new_string: 'y' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      },
    });
    const events = parseClaudeEvents(line);
    expect(events.map((e) => e.kind)).toEqual(['text', 'activity', 'activity', 'command', 'usage']);
    expect(events[2]).toMatchObject({ kind: 'activity', tool: 'Edit', filePath: 'b.ts', fileOp: 'edit' });
    expect(events[4]).toMatchObject({ kind: 'usage', messageId: 'm1', model: 'claude-x', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 });
    expect(parseClaudeLine(line)).toEqual(events[0]);
  });

  it('parses tool results, control requests, cancels and compaction', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const user = parseClaudeEvents(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: [{ type: 'text', text: long }], is_error: true }] } }));
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'tu', isError: true });
    expect((user[0] as { text: string }).text).toContain('… (10 more lines)');
    expect(parseClaudeEvents(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }))).toEqual([{ kind: 'control_request', requestId: 'r', subtype: 'can_use_tool', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }]);
    expect(parseClaudeEvents(JSON.stringify({ type: 'control_cancel_request', request_id: 'r' }))).toEqual([{ kind: 'control_cancel', requestId: 'r' }]);
    expect(parseClaudeEvents(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))).toEqual([{ kind: 'compact' }]);
    expect(parseClaudeEvents('nope')).toEqual([]);
  });

  it('sums modelUsage totals on the result and picks the context window', () => {
    const [res] = parseClaudeEvents(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, num_turns: 3, modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.2, contextWindow: 200000 }, b: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.3, contextWindow: 1000000 } } }));
    expect(res).toMatchObject({ kind: 'result', costUsd: 0.5, numTurns: 3, usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44, contextWindow: 1000000, model: 'b' } });
    expect((res as { usage: { costUsd: number } }).usage.costUsd).toBeCloseTo(0.5);
  });

  it('describes tool calls in one line', () => {
    expect(describeToolUse('AskUserQuestion', { questions: [{ question: 'A or B?' }] })).toBe('Asking: A or B?');
    expect(describeToolUse('Grep', { pattern: 'foo', path: 'src' })).toBe('Grep: foo in src');
    expect(describeToolUse('Custom', { thing: 'x' })).toBe('Custom: x');
  });
});
