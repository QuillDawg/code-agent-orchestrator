import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { renderMarkdown, wrapLine } from '../../src/tui/markdown.js';
import { renderTranscript, renderEntry, planTranscript, createTranscriptStream, filterEntries, nextFilter, stampWidth, FILTER_LABEL, TRANSCRIPT_FILTERS } from '../../src/tui/transcript.js';
import { entriesBefore, entryKey, readOlderAcrossAttempts, readOlderEntries, readTranscriptFile } from '../../src/persistence/transcript-log.js';
import { tmpDir } from '../helpers/index.js';
import { parseTranscriptLine, transcriptLine, type TranscriptEntry } from '../../src/types/transcript.js';
import { paint, sanitizeText, stripAnsi, useColor, visibleLength } from '../../src/cli/color.js';
import { formatCost, formatElapsed, formatTokens, bar, contextRatio } from '../../src/tui/format.js';

const ts = '2026-09-03T10:11:12.000Z';
// Transcript stamps are local wall clock, like every other absolute time this CLI prints.
const clock = (iso: string): string => new Date(iso).toTimeString().slice(0, 8);

describe('colour helpers', () => {
  it('paints and strips ANSI, measuring visible width', () => {
    const s = paint('hi', ['bold', 'red']);
    expect(s).toContain('[31m');
    expect(s).toContain('[1m');
    expect(stripAnsi(s)).toBe('hi');
    expect(visibleLength(s)).toBe(2);
    expect(paint('x', 'red', false)).toBe('x');
  });
});

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CR = String.fromCharCode(13);

describe('terminal-safe text', () => {
  it('strips cursor control and OSC sequences, not only colour', () => {
    expect(sanitizeText(`evil${ESC}[2K${ESC}[Gsafe`)).toBe('evilsafe');
    expect(sanitizeText(`${ESC}]0;pwned${BEL}ok`)).toBe('ok');
    expect(sanitizeText(`npm publish${CR}git status`)).toBe('npm publishgit status');
    expect(sanitizeText('keeps\ttabs\nand newlines')).toBe('keeps\ttabs\nand newlines');
    // A malformed sequence loses only the escape, and the visible width stops counting invisible bytes.
    expect(sanitizeText(`a${ESC}5mb`)).toBe('a5mb');
    expect(visibleLength(`abc${CR}def`)).toBe(6);
  });

  it('honours FORCE_COLOR=0 instead of treating any value as "on"', () => {
    const original = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR };
    delete process.env.NO_COLOR;
    try {
      for (const off of ['0', 'false', '']) {
        process.env.FORCE_COLOR = off;
        expect(useColor('auto')).toBe(Boolean(process.stdout.isTTY));
      }
      process.env.FORCE_COLOR = '1';
      expect(useColor('auto')).toBe(true);
      expect(useColor('never')).toBe(false);
    } finally {
      if (original.force === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = original.force;
      if (original.no !== undefined) process.env.NO_COLOR = original.no;
    }
  });

  it('closes and re-opens styles across wrapped lines', () => {
    const lines = wrapLine(paint('aaa bbb ccc', 'red'), 4);
    expect(lines.map(stripAnsi)).toEqual(['aaa', 'bbb', 'ccc']);
    for (const line of lines) {
      expect(line.startsWith(`${ESC}[31m`)).toBe(true);
      expect(line.endsWith(`${ESC}[39m`)).toBe(true);
    }
  });

  it('never lets agent output escape a rendered transcript entry', () => {
    const [line] = renderEntry({ kind: 'tool_result', ts, text: `${ESC}]0;pwned${BEL}ok`, isError: false }, { color: false, width: 0 });
    expect(line).toBe('    ok');
    const wrapped = renderEntry({ kind: 'error', ts, text: 'the quick brown fox jumps over the lazy dog again', color: true } as TranscriptEntry, { color: true, width: 30 });
    for (const l of wrapped) expect(stripAnsi(l)).not.toContain(ESC);
  });
});

describe('markdown', () => {
  it('renders headings, emphasis, code, lists and fences without colour', () => {
    const out = renderMarkdown('# Title\n\nSome **bold** and `code` here.\n\n- one\n- two\n\n1. first\n\n```ts\nconst x = 1;\n```\n', { color: false, width: 0 });
    expect(out).toEqual(['Title', '', 'Some bold and code here.', '', '• one', '• two', '', '1. first', '', '┌ ts', '│ const x = 1;', '└']);
  });

  it('wraps long lines at the width keeping the indent', () => {
    const wrapped = wrapLine('aaa bbb ccc ddd', 7, '  ');
    expect(wrapped).toEqual(['aaa bbb', '  ccc', '  ddd']);
    const out = renderMarkdown('- a very long bullet line that needs wrapping', { color: false, width: 20 });
    expect(out[0]).toBe('• a very long bullet');
    expect(out[1]?.startsWith('  ')).toBe(true);
  });

  it('styles inline code and bold when colour is on', () => {
    const [line] = renderMarkdown('use `npm test` **now**', { color: true, width: 0 });
    expect(stripAnsi(line!)).toBe('use npm test now');
    expect(line).toContain('[36m');
    expect(line).toContain('[1m');
  });
});

describe('transcript rendering', () => {
  const entries: TranscriptEntry[] = [
    { kind: 'system', ts, text: 'session abc' },
    { kind: 'text', ts, text: 'Looking at **auth**' },
    { kind: 'command', ts, command: 'npm test', tool: 'Bash' },
    { kind: 'tool', ts, tool: 'Edit', line: 'Edit src/a.ts', filePath: 'src/a.ts', fileOp: 'edit' },
    { kind: 'tool_result', ts, text: 'l1\nl2\nl3\nl4\nl5', isError: false },
    { kind: 'permission', ts, id: 'r', tool: 'Bash', title: 'Bash: rm -rf build', decision: 'deny', message: 'nope' },
    { kind: 'question', ts, id: 'q', questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b', description: 'bee' }], multiSelect: false }], answer: 'b' },
    { kind: 'result', ts, status: 'success', summary: 'done', costUsd: 0.1234, isError: false },
    { kind: 'error', ts, text: 'boom' },
  ];

  it('gives every kind a distinct gutter and collapses tool results', () => {
    const lines = renderTranscript(entries, { color: false, width: 0 });
    expect(lines).toContain('· session abc');
    expect(lines).toContain('› Looking at bold'.replace('bold', 'auth'));
    expect(lines).toContain('$ npm test');
    expect(lines).toContain('✎ Edit src/a.ts');
    expect(lines.some((l) => l.includes('… 2 more lines'))).toBe(true);
    expect(lines).toContain('? Permission: Bash: rm -rf build');
    expect(lines).toContain('  → denied: nope');
    expect(lines).toContain('? Which?');
    expect(lines).toContain('    2) b — bee');
    expect(lines).toContain('  → b');
    expect(lines).toContain('✓ success — done');
    expect(lines).toContain('  cost $0.1234');
    expect(lines).toContain('✗ boom');
  });

  it('expands tool results on request and prefixes timestamps', () => {
    const full = renderEntry(entries[4]!, { color: false, width: 0, showToolResults: true });
    expect(full).toHaveLength(5);
    const stamped = renderTranscript([entries[2]!], { color: false, width: 0, timestamps: true });
    expect(stamped[0]).toBe(`${clock(ts)} $ npm test`);
  });

  it('parses current and legacy events.jsonl lines', () => {
    expect(parseTranscriptLine(JSON.stringify({ kind: 'text', ts, text: 'x' }))).toEqual({ kind: 'text', ts, text: 'x' });
    expect(parseTranscriptLine(JSON.stringify({ type: 'activity', ts, line: 'Read a', tool: 'Read' }))).toEqual({ kind: 'tool', ts, tool: 'Read', line: 'Read a' });
    expect(parseTranscriptLine(JSON.stringify({ type: 'command', ts, command: 'ls' }))).toEqual({ kind: 'command', ts, command: 'ls', tool: 'Bash' });
    expect(parseTranscriptLine(JSON.stringify({ type: 'init', ts, sessionId: 's', model: 'm' }))).toEqual({ kind: 'system', ts, text: 'session s (m)' });
    expect(parseTranscriptLine('garbage')).toBeNull();
    expect(transcriptLine({ kind: 'text', ts, text: '## Heading\nbody' })).toBe('Heading');
    expect(transcriptLine({ kind: 'command', ts, command: 'a\nb', tool: 'Bash' })).toBe('$ a');
  });
});

describe('tool timing and subagent nesting', () => {
  const at = (ms: number): string => new Date(Date.parse(ts) + ms).toISOString();
  const agentRun: TranscriptEntry[] = [
    { kind: 'tool', ts, tool: 'Read', line: 'Read src/a.ts', toolUseId: 'tu-read' },
    { kind: 'tool_result', ts: at(400), text: 'contents', toolUseId: 'tu-read' },
    { kind: 'command', ts: at(400), command: 'npm test', tool: 'Bash', toolUseId: 'tu-bash' },
    { kind: 'tool_result', ts: at(75_400), text: 'passed', toolUseId: 'tu-bash' },
    { kind: 'tool', ts: at(76_000), tool: 'Agent', line: 'Agent: Review the diff', toolUseId: 'tu-agent' },
    { kind: 'text', ts: at(76_100), text: 'Reviewing the diff', parentToolUseId: 'tu-agent' },
    { kind: 'tool', ts: at(76_200), tool: 'Grep', line: 'Grep: TODO in src', toolUseId: 'tu-grep', parentToolUseId: 'tu-agent' },
    { kind: 'tool_result', ts: at(76_700), text: 'src/a.ts:1:TODO', toolUseId: 'tu-grep', parentToolUseId: 'tu-agent' },
    { kind: 'tool_result', ts: at(78_000), text: 'Found 1 TODO', toolUseId: 'tu-agent' },
  ];

  it('renders the elapsed time of a call once its result has arrived', () => {
    const lines = renderTranscript(agentRun, { color: false, width: 0 });
    expect(lines).toContain('▸ Read src/a.ts · 0.4s');
    expect(lines).toContain('$ npm test · 1m 15s');
    expect(lines).toContain('▸ Agent: Review the diff · 2.0s');
    // A call whose result has not arrived yet carries no time at all, rather than a zero.
    const open = renderTranscript(agentRun.slice(0, 1), { color: false, width: 0 });
    expect(open).toEqual(['▸ Read src/a.ts']);
  });

  it('collapses a subagent under its Agent line and expands it with the tool-output key', () => {
    const collapsed = renderTranscript(agentRun, { color: false, width: 0 });
    expect(collapsed).toContain('  … 3 subagent entries (t to expand)');
    expect(collapsed.some((l) => l.includes('Reviewing the diff'))).toBe(false);
    expect(collapsed.some((l) => l.includes('Grep: TODO'))).toBe(false);
    // The summary sits directly under the call that spawned it.
    expect(collapsed.indexOf('  … 3 subagent entries (t to expand)')).toBe(collapsed.indexOf('▸ Agent: Review the diff · 2.0s') + 1);

    // Once, not twice: a call and its result share the tool id, but only the call owns the subagent.
    expect(collapsed.filter((l) => l.includes('subagent entries'))).toHaveLength(1);

    const expanded = renderTranscript(agentRun, { color: false, width: 0, showToolResults: true });
    expect(expanded).toContain('  › Reviewing the diff');
    expect(expanded.filter((l) => l.includes('Reviewing the diff'))).toHaveLength(1);
    expect(expanded).toContain('  ▸ Grep: TODO in src · 0.5s');
    expect(expanded).toContain('      src/a.ts:1:TODO');
    expect(expanded.some((l) => l.includes('subagent entries'))).toBe(false);
  });

  it('leaves the timestamp column blank on the collapsed summary line', () => {
    const lines = renderTranscript(agentRun, { color: false, width: 0, timestamps: true });
    expect(lines).toContain(`${' '.repeat(9)}  … 3 subagent entries (t to expand)`);
    expect(lines).toContain(`${clock('2026-09-03T10:12:28.000Z')} ▸ Agent: Review the diff · 2.0s`);
  });

  it('keeps a subagent entry whose Agent call is no longer in the buffer', () => {
    const orphan = agentRun.slice(5); // the Agent call scrolled off the top
    const lines = renderTranscript(orphan, { color: false, width: 0 });
    expect(lines).toContain('› Reviewing the diff');
    expect(lines).toContain('▸ Grep: TODO in src · 0.5s');
    expect(lines.some((l) => l.includes('subagent entries'))).toBe(false);
  });

  it('plans one item per top-level entry, with the subagent entries as children', () => {
    const plan = planTranscript(agentRun);
    // The Agent's own result is not left in the stream: it is the report of the call above it.
    expect(plan.map((p) => p.entry.kind)).toEqual(['tool', 'tool_result', 'command', 'tool_result', 'tool']);
    const agent = plan.find((p) => p.entry.kind === 'tool' && p.entry.tool === 'Agent')!;
    expect(agent.elapsedMs).toBe(2000);
    expect(agent.children).toHaveLength(3);
    expect(plan.filter((p) => p.children !== undefined)).toHaveLength(1);
    expect(plan.filter((p) => p.elapsedMs !== undefined)).toHaveLength(3);
  });
});

describe('subagents that delegate, run together, or never come back', () => {
  const at = (ms: number): string => new Date(Date.parse(ts) + ms).toISOString();

  const deep: TranscriptEntry[] = [
    { kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: outer', toolUseId: 'outer' },
    { kind: 'text', ts: at(100), text: 'outer speaking', parentToolUseId: 'outer' },
    { kind: 'tool', ts: at(200), tool: 'Agent', line: 'Agent: inner', toolUseId: 'inner', parentToolUseId: 'outer' },
    { kind: 'text', ts: at(300), text: 'inner speaking', parentToolUseId: 'inner' },
    { kind: 'tool_result', ts: at(400), text: 'inner report', toolUseId: 'inner', parentToolUseId: 'outer' },
    { kind: 'tool_result', ts: at(500), text: 'outer report', toolUseId: 'outer' },
  ];

  it('keeps everything a subagent that delegates again produced, and counts all of it', () => {
    const expanded = renderTranscript(deep, { color: false, width: 0, showToolResults: true });
    expect(expanded).toContain('  › outer speaking');
    expect(expanded).toContain('  ▸ Agent: inner · 0.2s');
    expect(expanded).toContain('    › inner speaking'); // a grandchild used to be dropped entirely
    expect(expanded).toContain('        inner report');
    expect(expanded).toContain('      outer report');

    // Collapsed, the count covers the whole subtree: four entries plus the inner subagent's own report.
    const collapsed = renderTranscript(deep, { color: false, width: 0 });
    expect(collapsed).toContain('  … 4 subagent entries (t to expand)');
    expect(collapsed.some((l) => l.includes('inner speaking'))).toBe(false);
    // The outer subagent's report stays visible: it is what the parent agent actually acted on.
    expect(collapsed).toContain('      outer report');
  });

  it('keeps each concurrent subagent report under its own call', () => {
    const both: TranscriptEntry[] = [
      { kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: alpha', toolUseId: 'A' },
      { kind: 'tool', ts: at(10), tool: 'Agent', line: 'Agent: beta', toolUseId: 'B' },
      { kind: 'command', ts: at(20), command: 'ls a', tool: 'Bash', toolUseId: 'a1', parentToolUseId: 'A' },
      { kind: 'command', ts: at(30), command: 'ls b', tool: 'Bash', toolUseId: 'b1', parentToolUseId: 'B' },
      { kind: 'tool_result', ts: at(40), text: 'a out', toolUseId: 'a1', parentToolUseId: 'A' },
      { kind: 'tool_result', ts: at(50), text: 'b out', toolUseId: 'b1', parentToolUseId: 'B' },
      { kind: 'tool_result', ts: at(60), text: 'alpha says so', toolUseId: 'A' },
      { kind: 'tool_result', ts: at(70), text: 'beta says so', toolUseId: 'B' },
    ];
    const lines = renderTranscript(both, { color: false, width: 0 });
    // Both reports used to end up at the bottom, in a row, with nothing saying which call each answered.
    expect(lines.indexOf('      alpha says so')).toBe(lines.indexOf('▸ Agent: alpha · 60ms') + 2);
    expect(lines.indexOf('      beta says so')).toBe(lines.indexOf('▸ Agent: beta · 60ms') + 2);
  });

  it('says which tool a finished attempt was still waiting on', () => {
    const crashed: TranscriptEntry[] = [
      { kind: 'command', ts: at(0), command: 'npm test', tool: 'Bash', toolUseId: 'open' },
      { kind: 'error', ts: at(90_000), text: 'timed out after 90000ms' },
    ];
    expect(renderTranscript(crashed, { color: false, width: 0 })).toContain('$ npm test · no result');
    // While the attempt is still running the same call says nothing: it may simply be slow.
    expect(renderTranscript(crashed.slice(0, 1), { color: false, width: 0 })).toEqual(['$ npm test']);
  });
});

describe('rendering events.jsonl line by line', () => {
  const at = (ms: number): string => new Date(Date.parse(ts) + ms).toISOString();
  const line = (e: TranscriptEntry): string => JSON.stringify(e);
  const stream = (over: Partial<Parameters<typeof createTranscriptStream>[0]> = {}) => createTranscriptStream({ color: false, width: 0, showToolResults: true, ...over });

  it('renders the tail as one transcript, so calls are paired and subagents nest', () => {
    const out = stream().batch([
      line({ kind: 'command', ts: at(0), command: 'npm test', tool: 'Bash', toolUseId: 'c1' }),
      line({ kind: 'tool_result', ts: at(1500), text: 'passed', toolUseId: 'c1' }),
      line({ kind: 'tool', ts: at(2000), tool: 'Agent', line: 'Agent: review', toolUseId: 'a1' }),
      line({ kind: 'text', ts: at(2100), text: 'looking', parentToolUseId: 'a1' }),
      line({ kind: 'tool_result', ts: at(2500), text: 'all good', toolUseId: 'a1' }),
    ]);
    expect(out).toContain('$ npm test · 1.5s');
    expect(out).toContain('  › looking');
    expect(out).toContain('      all good');
  });

  it('still times and indents what arrives after the tail', () => {
    const s = stream();
    s.batch([line({ kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: review', toolUseId: 'a1' })]);
    // The call is long gone from the output, so its result is the only place left to put the number.
    expect(s.line(line({ kind: 'tool', ts: at(500), tool: 'Grep', line: 'Grep: TODO', toolUseId: 'g1', parentToolUseId: 'a1' }))).toEqual(['  ▸ Grep: TODO']);
    expect(s.line(line({ kind: 'tool_result', ts: at(900), text: 'found', toolUseId: 'g1', parentToolUseId: 'a1' }))).toEqual(['      found · 0.4s']);
    // The Agent's report nests under its call here exactly as it does when the same log is rendered whole.
    expect(s.line(line({ kind: 'tool_result', ts: at(1000), text: 'done', toolUseId: 'a1' }))).toEqual(['      done · 1.0s']);
  });

  it('renders a subagent the same way whether the log is read whole or line by line', () => {
    const log = [
      line({ kind: 'tool', ts: at(0), tool: 'Agent', line: 'Agent: review', toolUseId: 'a1' }),
      line({ kind: 'text', ts: at(100), text: 'looking', parentToolUseId: 'a1' }),
      line({ kind: 'tool', ts: at(200), tool: 'Grep', line: 'Grep: TODO', toolUseId: 'g1', parentToolUseId: 'a1' }),
      line({ kind: 'tool_result', ts: at(600), text: 'found', toolUseId: 'g1', parentToolUseId: 'a1' }),
      line({ kind: 'tool_result', ts: at(900), text: 'all good', toolUseId: 'a1' }),
    ];
    const whole = stream().batch(log);
    // Following it live: the tail is the first line, the rest arrives one at a time.
    const live = stream();
    const streamed = [...live.batch(log.slice(0, 1)), ...log.slice(1).flatMap((l) => live.line(l))];
    // Only the times differ (a streamed call is already printed when its result arrives).
    expect(streamed.map((l) => l.replace(/ · [\dms.]+$/, ''))).toEqual(whole.map((l) => l.replace(/ · [\dms.]+$/, '')));
  });

  it('passes a line that is not an entry through, and hides thinking unless asked', () => {
    expect(stream().line('Fatal error: something else wrote here')).toEqual(['Fatal error: something else wrote here']);
    const thought = line({ kind: 'thinking', ts: at(0), text: 'hmm' });
    expect(stream().line(thought)).toEqual([]);
    expect(stream({ showThinking: true }).line(thought)).toEqual(['✻ hmm']);
    // A batch of a half-written file keeps the unparseable line where it was.
    expect(stream().batch([line({ kind: 'text', ts: at(0), text: 'a' }), '{"kind":"tex'])).toEqual(['› a', '{"kind":"tex']);
  });
});

describe('thinking entries', () => {
  const withThought: TranscriptEntry[] = [
    { kind: 'thinking', ts, text: 'Let me consider the options.' },
    { kind: 'text', ts, text: 'Working on it' },
  ];

  it('is hidden by every surface until it is asked for', () => {
    expect(renderTranscript(withThought, { color: false, width: 0 })).toEqual(['› Working on it']);
    const shown = renderTranscript(withThought, { color: false, width: 0, showThinking: true });
    expect(shown).toEqual(['✻ Let me consider the options.', '› Working on it']);
  });

  it('nests under the Agent call that produced it, and is dropped there too', () => {
    const nested: TranscriptEntry[] = [
      { kind: 'tool', ts, tool: 'Agent', line: 'Agent: Review', toolUseId: 'tu-agent' },
      { kind: 'thinking', ts, text: 'sub thought', parentToolUseId: 'tu-agent' },
      { kind: 'text', ts, text: 'sub prose', parentToolUseId: 'tu-agent' },
    ];
    // Hidden, the collapsed summary counts only what would actually be shown.
    expect(renderTranscript(nested, { color: false, width: 0 })).toContain('  … 1 subagent entry (t to expand)');
    expect(renderTranscript(nested, { color: false, width: 0, showThinking: true })).toContain('  … 2 subagent entries (t to expand)');
    expect(renderTranscript(nested, { color: false, width: 0, showThinking: true, showToolResults: true })).toContain('  ✻ sub thought');
  });

  it('summarises as a thought and round-trips through events.jsonl', () => {
    expect(transcriptLine({ kind: 'thinking', ts, text: 'weighing it up\nmore' })).toBe('(thinking) weighing it up');
    expect(parseTranscriptLine(JSON.stringify({ kind: 'thinking', ts, text: 'x' }))).toEqual({ kind: 'thinking', ts, text: 'x' });
  });
});

describe('timestamps on a narrow terminal', () => {
  const entry: TranscriptEntry = { kind: 'command', ts, command: 'npm test', tool: 'Bash' };

  it('falls back to MM:SS instead of dropping the column', () => {
    expect(renderTranscript([entry], { color: false, width: 0, timestamps: true })[0]).toBe(`${clock(ts)} $ npm test`);
    expect(renderTranscript([entry], { color: false, width: 0, timestamps: 'short' })[0]).toBe(`${clock(ts).slice(3)} $ npm test`);
    expect(stampWidth(true)).toBe(9);
    expect(stampWidth('short')).toBe(6);
    expect(stampWidth(undefined)).toBe(0);
  });

  it('keeps continuation lines aligned under the shorter column', () => {
    const lines = renderTranscript([{ kind: 'tool_result', ts, text: 'a\nb', isError: false }], { color: false, width: 0, timestamps: 'short' });
    expect(lines).toEqual(['11:12     a', '          b']);
  });
});

describe('kind filter', () => {
  const mixed: TranscriptEntry[] = [
    { kind: 'text', ts, text: 'prose' },
    { kind: 'thinking', ts, text: 'thought' },
    { kind: 'command', ts, command: 'npm test', tool: 'Bash' },
    { kind: 'tool', ts, tool: 'Read', line: 'Read a.ts' },
    { kind: 'tool_result', ts, text: 'ok', isError: false },
    { kind: 'tool_result', ts, text: 'exploded', isError: true },
    { kind: 'question', ts, id: 'q', questions: [{ question: 'Which?', options: [{ label: 'a' }], multiSelect: false }] },
    { kind: 'error', ts, text: 'boom' },
    { kind: 'system', ts, text: 'session abc' },
    { kind: 'result', ts, status: 'success', isError: false },
  ];

  it('cycles all → text → tools → errors and back', () => {
    expect(TRANSCRIPT_FILTERS).toEqual(['all', 'text', 'tools', 'issues']);
    expect(TRANSCRIPT_FILTERS.map(nextFilter)).toEqual(['text', 'tools', 'issues', 'all']);
    expect(FILTER_LABEL.tools).toBe('tools + commands');
  });

  it('keeps only the entries each mode is about', () => {
    // "all" is every *visible* kind: thinking still needs its own switch.
    expect(filterEntries(mixed, 'all').length).toBe(mixed.length - 1);
    expect(filterEntries(mixed, 'text').map((e) => e.kind)).toEqual(['text', 'result']);
    expect(filterEntries(mixed, 'tools').map((e) => e.kind)).toEqual(['command', 'tool', 'tool_result', 'tool_result']);
    // An errored tool result is an error, so `issues` shows it while the successful one stays out.
    expect(filterEntries(mixed, 'issues').map((e) => e.kind)).toEqual(['tool_result', 'question', 'error']);
    expect(filterEntries(mixed, 'issues').every((e) => e.kind !== 'tool_result' || e.isError)).toBe(true);
  });

  it('shows thinking in the text filter only once thinking itself is on', () => {
    expect(filterEntries(mixed, 'text', false).some((e) => e.kind === 'thinking')).toBe(false);
    expect(filterEntries(mixed, 'text', true).map((e) => e.kind)).toEqual(['text', 'thinking', 'result']);
    expect(filterEntries(mixed, 'all', true).length).toBe(mixed.length);
  });
});

describe('paging older entries', () => {
  const at = (n: number): string => new Date(Date.parse(ts) + n * 1000).toISOString();
  const all: TranscriptEntry[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'text', ts: at(i), text: `line ${i}` }));

  it('returns the page immediately before the oldest entry on screen', () => {
    expect(entriesBefore(all, all[6], 3).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['line 3', 'line 4', 'line 5']);
    // At the very beginning there is a short page and then nothing.
    expect(entriesBefore(all, all[2], 5).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['line 0', 'line 1']);
    expect(entriesBefore(all, all[0], 5)).toEqual([]);
  });

  it('matches an entry that came back from disk with a different key order', () => {
    const fromDisk = parseTranscriptLine(JSON.stringify({ text: 'line 4', kind: 'text', ts: at(4) }))!;
    expect(entryKey(fromDisk)).toBe(entryKey(all[4]!));
    expect(entriesBefore(all, fromDisk, 2).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['line 2', 'line 3']);
  });

  it('returns nothing when the oldest entry is not in this attempt, rather than duplicating the screen', () => {
    // The live buffer spans a task and can hold entries of an earlier attempt; this file spans one attempt.
    expect(entriesBefore(all, { kind: 'text', ts: at(99), text: 'from attempt 1' }, 5)).toEqual([]);
    expect(entriesBefore(all, undefined, 3).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['line 7', 'line 8', 'line 9']);
  });

  it('walks back through the attempts when the oldest entry belongs to an earlier one', async () => {
    // What the dashboard's live follow view actually has on screen: one buffer over two attempt files.
    const dir = await tmpDir('cao-paging-attempts-');
    const first: TranscriptEntry[] = Array.from({ length: 6 }, (_, i) => ({ kind: 'text', ts: at(i), text: `a1 line ${i}` }));
    const second: TranscriptEntry[] = Array.from({ length: 4 }, (_, i) => ({ kind: 'text', ts: at(100 + i), text: `a2 line ${i}` }));
    const write = async (name: string, entries: TranscriptEntry[]): Promise<string> => {
      const file = path.join(dir, name);
      await fs.writeFile(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
      return file;
    };
    const files = [await write('a2.jsonl', second), await write('a1.jsonl', first)];
    const texts = (entries: TranscriptEntry[]): string[] => entries.map((e) => (e.kind === 'text' ? e.text : ''));

    // the oldest on screen is attempt 1's: attempt 2's file cannot find it, so the search carries on
    expect(texts(await readOlderAcrossAttempts(files, first[4], 2))).toEqual(['a1 line 2', 'a1 line 3']);
    // and the beginning of attempt 2 continues into the tail of attempt 1 rather than stopping there
    expect(texts(await readOlderAcrossAttempts(files, second[0], 2))).toEqual(['a1 line 4', 'a1 line 5']);
    // the real beginning is still the beginning
    expect(await readOlderAcrossAttempts(files, first[0], 5)).toEqual([]);
    // an entry from no attempt at all is not guessed at
    expect(await readOlderAcrossAttempts(files, { kind: 'text', ts: at(999), text: 'nowhere' }, 5)).toEqual([]);
    // attempt-scoped paging is what stops at the file, and is what `cao logs -a N` still gets
    expect(await readOlderEntries(files[0]!, first[4], 2)).toEqual([]);
  });

  it('reads a page straight out of an attempt events.jsonl', async () => {
    const dir = await tmpDir('cao-paging-');
    const file = path.join(dir, 'events.jsonl');
    await fs.writeFile(file, `${all.map((e) => JSON.stringify(e)).join('\n')}\nnot json\n`, 'utf8');
    expect((await readTranscriptFile(file)).length).toBe(10);
    expect((await readOlderEntries(file, all[5], 2)).map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['line 3', 'line 4']);
    expect(await readOlderEntries(path.join(dir, 'missing.jsonl'), all[5], 2)).toEqual([]);
  });
});

describe('number formatting', () => {
  it('formats tokens, cost and bars', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(42_300)).toBe('42.3k');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatCost(0.004)).toBe('$0.0040');
    expect(formatElapsed(45)).toBe('45ms');
    expect(formatElapsed(400)).toBe('0.4s');
    expect(formatElapsed(1500)).toBe('1.5s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(184_000)).toBe('3m 04s');
    expect(formatCost(1.234)).toBe('$1.23');
    expect(bar(0.5, 4)).toBe('██░░');
    expect(contextRatio({ contextTokens: 50, contextWindow: 200 })).toBe(0.25);
    expect(contextRatio({ contextTokens: 50 })).toBeUndefined();
  });
});
