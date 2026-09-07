import { describe, it, expect } from 'vitest';
import { renderTemplate, templateReferences } from '../../src/templates/engine.js';
import { parseExpression, evaluateExpression, evaluateWhen, compileWhen, referencedTasks } from '../../src/conditions/evaluator.js';
import { TaskGraph } from '../../src/workflow/graph.js';
import { validateTaskResult, extractJsonObject, TASK_RESULT_JSON_SCHEMA } from '../../src/runners/claude/contract.js';
import { parseClaudeLine } from '../../src/runners/claude/event-parser.js';
import { buildClaudeArgs } from '../../src/runners/claude/claude-runner.js';
import { parseDuration, formatDuration, formatDurationShort } from '../../src/util/duration.js';
import { Redactor } from '../../src/logging/redact.js';
import { KeyedMutex, RingBuffer, AsyncQueue } from '../../src/util/async-queue.js';
import { assertTaskTransition } from '../../src/workflow/states.js';

describe('template engine', () => {
  it('substitutes dotted paths and reports missing ones', () => {
    const r = renderTemplate('Hello {{ user.name }} #{{issue}} {{nope}}', { user: { name: 'Ann' }, issue: 7 });
    expect(r.text).toBe('Hello Ann #7 {{nope}}');
    expect(r.missing).toEqual(['nope']);
  });
  it('never evaluates code', () => {
    const r = renderTemplate('{{constructor.constructor}} {{__proto__.x}}', {});
    expect(r.missing).toEqual(['constructor.constructor', '__proto__.x']);
    expect(r.text).toContain('{{constructor.constructor}}');
  });
  it('lists references', () => {
    expect(templateReferences('{{a}} {{b.c}} {{a}}')).toEqual(['a', 'b.c']);
  });
  it('stringifies arrays and objects', () => {
    expect(renderTemplate('{{list}} {{obj}}', { list: [1, 'a'], obj: { k: 1 } }).text).toBe('1, a {"k":1}');
  });
});

describe('condition evaluator', () => {
  const scope = { tasks: { 'code-review': { status: 'success', warnings: ['a', 'b'], data: { risk: 'high' } }, x: { status: 'failed' } }, vars: { skipDocs: true } };
  it('evaluates object-form when', () => {
    expect(evaluateWhen({ task: 'code-review', status: 'success' }, scope)).toBe(true);
    expect(evaluateWhen({ task: 'code-review', status: ['failed', 'blocked'] }, scope)).toBe(false);
    expect(compileWhen({ task: 'x', status: 'failed' }).refs).toEqual(['x']);
  });
  it('evaluates expressions', () => {
    const t = (e: string) => evaluateExpression(parseExpression(e), scope);
    expect(t('tasks.code-review.warnings.length > 0')).toBe(true);
    expect(t('tasks["code-review"].status == "success" && !(vars.skipDocs in [false])')).toBe(true);
    expect(t('tasks.x.status in ["success", "skipped"]')).toBe(false);
    expect(t('tasks.code-review.data.risk == "high" || false')).toBe(true);
    expect(t('tasks.code-review.warnings contains "a"')).toBe(true);
    expect(t('tasks.missing.status == null')).toBe(true);
    expect(t('2 >= 1')).toBe(true);
  });
  it('rejects code and reports references', () => {
    expect(() => parseExpression('process.exit(1)')).toThrow();
    expect(() => parseExpression('a; b')).toThrow();
    expect(() => parseExpression('"unterminated')).toThrow(/Unterminated/);
    expect(referencedTasks(parseExpression('tasks.a.status == "x" && tasks["b"].warnings.length > 1'))).toEqual(['a', 'b']);
  });
});

describe('TaskGraph', () => {
  it('computes layers and closures', () => {
    const g = new TaskGraph([
      { id: 'a', dependsOn: [], docIndex: 0 },
      { id: 'b', dependsOn: ['a'], docIndex: 1 },
      { id: 'c', dependsOn: ['a'], docIndex: 2 },
      { id: 'd', dependsOn: ['b', 'c'], docIndex: 3 },
    ]);
    expect(g.layers()).toEqual([['a'], ['b', 'c'], ['d']]);
    expect([...g.ancestors('d')].sort()).toEqual(['a', 'b', 'c']);
    expect([...g.descendants('a')].sort()).toEqual(['b', 'c', 'd']);
    expect(g.findCycle()).toBeNull();
  });
  it('finds cycles', () => {
    const g = new TaskGraph([
      { id: 'a', dependsOn: ['c'], docIndex: 0 },
      { id: 'b', dependsOn: ['a'], docIndex: 1 },
      { id: 'c', dependsOn: ['b'], docIndex: 2 },
    ]);
    expect(g.findCycle()).toEqual(['a', 'c', 'b', 'a']);
    expect(() => g.layers()).toThrow(/Circular/);
  });
});

describe('completion contract', () => {
  it('validates and normalizes results', () => {
    const r = validateTaskResult({ status: 'success', summary: 'ok', filesChanged: ['a', 1], extra: true });
    expect(r.ok && r.result).toEqual({ status: 'success', summary: 'ok', filesChanged: ['a', '1'], commits: [], decisions: [], warnings: [], followUp: [] });
    expect(validateTaskResult({ status: 'done', summary: 'x' }).ok).toBe(false);
    expect(validateTaskResult({ status: 'success' }).ok).toBe(false);
    expect(validateTaskResult('nope').ok).toBe(false);
  });
  it('extracts JSON from prose', () => {
    expect(extractJsonObject('Done.\n```json\n{"status":"success","summary":"s"}\n```')).toEqual({ status: 'success', summary: 's' });
    expect(extractJsonObject('blah {"status":"failed","summary":"x","data":{"k":[1,2]}} trailing')).toEqual({ status: 'failed', summary: 'x', data: { k: [1, 2] } });
    expect(extractJsonObject('no json here')).toBeUndefined();
  });
  it('json schema requires status and summary', () => {
    expect(TASK_RESULT_JSON_SCHEMA.required).toEqual(['status', 'summary']);
  });
});

describe('claude event parser', () => {
  it('parses init, tool_use, text and result messages', () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}')).toEqual({ kind: 'init', sessionId: 's1', model: 'm' });
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\nsecond' } }] } }))).toEqual({ kind: 'command', command: 'npm test\nsecond', tool: 'Bash' });
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] } }))).toMatchObject({ line: 'Read src/a.ts' });
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at auth...' }] } }))).toEqual({ kind: 'text', text: 'Looking at auth...' });
    const res = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x', structured_output: { status: 'success' }, total_cost_usd: 0.5, num_turns: 3 }));
    expect(res).toMatchObject({ kind: 'result', isError: false, structuredOutput: { status: 'success' }, costUsd: 0.5, numTurns: 3 });
    expect(parseClaudeLine('not json')).toBeNull();
    expect(parseClaudeLine('{"type":"weird"}')).toEqual({ kind: 'other', type: 'weird' });
  });
});

describe('claude args', () => {
  it('builds a headless invocation with the contract', () => {
    const args = buildClaudeArgs({ permissionMode: 'acceptEdits', model: 'sonnet', maxBudgetUsd: 2, allowedTools: ['Bash(git *)', 'Edit'], sessionPersistence: false, extraArgs: ['--bare'] }, 'sid');
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toContain('--json-schema');
    expect(args).toContain('--permission-prompts');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sid');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash(git *),Edit');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.length - 1]).toBe('--bare');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toMatch(/FINAL response must be a single JSON object/);
  });
  it('defaults to auto permission mode', () => {
    const args = buildClaudeArgs({}, 'sid');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
  });
});

describe('utilities', () => {
  it('parses and formats durations', () => {
    expect(parseDuration('60m')).toBe(3_600_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration('250ms')).toBe(250);
    expect(() => parseDuration('soon')).toThrow();
    expect(formatDuration(65_000)).toBe('01m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m 05s');
    // The compact form the dashboard's activity cell uses.
    expect(formatDurationShort(12_400)).toBe('12s');
    expect(formatDurationShort(125_000)).toBe('2m');
    expect(formatDurationShort(3_725_000)).toBe('1h02m');
    expect(formatDurationShort(-1)).toBe('--');
  });
  it('redacts secrets by value and key', () => {
    const r = new Redactor(['supersecretvalue']);
    expect(r.redact('token=supersecretvalue key=sk-ant-abcdefghijklmnopqrstuvwxyz')).toBe('token=[REDACTED] key=[REDACTED]');
    expect(r.redactValue({ API_KEY: 'plain', nested: { password: 'p' }, ok: 'fine' })).toEqual({ API_KEY: '[REDACTED]', nested: { password: '[REDACTED]' }, ok: 'fine' });
  });
  it('mutex serializes, ring buffer caps, queue delivers in order', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const r1 = await m.acquire('k');
    const p2 = m.acquire('k').then((rel) => {
      order.push('second');
      rel();
    });
    order.push('first');
    r1();
    await p2;
    expect(order).toEqual(['first', 'second']);
    const rb = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => rb.push(n));
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.last(2)).toEqual([4, 5]);
    const q = new AsyncQueue<number>();
    q.push(1);
    const p = q.next();
    q.push(2);
    expect(await p).toBe(1);
    expect(await q.next()).toBe(2);
  });
  it('rejects illegal task transitions', () => {
    expect(() => assertTaskTransition('success', 'running', 't')).toThrow(/Illegal/);
    expect(() => assertTaskTransition('ready', 'running', 't')).not.toThrow();
  });
});
