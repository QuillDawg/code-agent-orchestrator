import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DEFAULT_WORKFLOW_FILES, matchTask, requireTask, resolveWorkflowPath, table, terminalWidth, truncateVisible } from '../../src/cli/util.js';
import { formatAge, formatClock, formatLocal, formatWhen } from '../../src/util/duration.js';
import { formatDiagnostics } from '../../src/workflow/validator.js';
import { logSource, jsonEntryLines } from '../../src/cli/commands/logs.js';
import { mark } from '../../src/util/marks.js';
import { glyph, useUnicode } from '../../src/util/glyphs.js';
import { stateGlyph } from '../../src/workflow/states.js';
import { formatAgents } from '../../src/cli/render/plain.js';
import { renderExecutionPlan } from '../../src/workflow/plan.js';
import type { TaskState } from '../../src/types/run.js';
import { buildWorkflow, makeRun, tmpDir } from '../helpers/index.js';
import { paint, stripAnsi } from '../../src/cli/color.js';

const NL = String.fromCharCode(10);
const lines = (text: string): string[] => text.split(NL).map(stripAnsi);

const run = async (ids: string[]) => {
  const { workflow } = await buildWorkflow(`name: t${NL}tasks:${NL}${ids.map((id) => `  - id: ${id}${NL}    prompt: p${NL}`).join('')}`);
  return makeRun(workflow);
};

describe('task references', () => {
  it('match exactly, or by a prefix that names one task', async () => {
    const r = await run(['implement-api', 'implement-ui', 'review']);
    expect(requireTask(r, 'review')).toBe('review');
    expect(requireTask(r, 'rev')).toBe('review');
    expect(requireTask(r, 'implement-a')).toBe('implement-api');
    expect(matchTask(r, 'nothing')).toBeNull();
  });

  it('refuse an ambiguous prefix and name the candidates', async () => {
    const r = await run(['implement-api', 'implement-ui']);
    expect(() => requireTask(r, 'implement')).toThrow(/ambiguous.*implement-api, implement-ui/);
    expect(() => requireTask(r, 'implement')).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it('prefer an exact id over a longer task it is also a prefix of', async () => {
    const r = await run(['build', 'build-docs']);
    expect(requireTask(r, 'build')).toBe('build');
  });

  it('report an unknown task as a usage error listing the run tasks', async () => {
    const r = await run(['a', 'b']);
    expect(() => requireTask(r, 'zz')).toThrow(/not part of run .*Tasks: a, b/);
    expect(() => requireTask(r, 'zz')).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
});

describe('default workflow file', () => {
  it('picks the conventional names in order', async () => {
    const dir = await tmpDir('cao-default-');
    await fs.writeFile(path.join(dir, 'cao.yaml'), 'name: t');
    expect(await resolveWorkflowPath(undefined, dir)).toBe(path.join(dir, 'cao.yaml'));
    await fs.writeFile(path.join(dir, 'workflow.yaml'), 'name: t');
    expect(await resolveWorkflowPath(undefined, dir)).toBe(path.join(dir, 'workflow.yaml'));
    expect(await resolveWorkflowPath('other.yaml', dir)).toBe('other.yaml');
  });

  it('is a usage error when nothing matches', async () => {
    const dir = await tmpDir('cao-default-');
    await expect(resolveWorkflowPath(undefined, dir)).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    await expect(resolveWorkflowPath(undefined, dir)).rejects.toThrow(new RegExp(DEFAULT_WORKFLOW_FILES.join(', ')));
  });
});

describe('table', () => {
  it('pads by printable width, so a coloured cell does not shift the row', () => {
    const out = table([[paint('ok', 'green', true), 'x'], ['longer', 'y']], { width: 0 });
    expect(lines(out)).toEqual(['ok      x', 'longer  y']);
  });

  it('clamps to the terminal width, narrowing the widest column first', () => {
    const rows = [['a', 'short', 'a very long detail line that would wrap']];
    const out = table(rows, { header: ['Task', 'State', 'Detail'], width: 30 });
    for (const line of lines(out)) expect(line.length).toBeLessThanOrEqual(30);
    expect(out).toContain('…');
    expect(out).toContain('short');
  });

  it('leaves the table alone when it fits', () => {
    expect(table([['a', 'b']], { width: 80 })).toBe('a  b');
  });

  it('never narrows a column below the minimum, even in a tiny terminal', () => {
    const out = table([['aaaaaaaa', 'bbbbbbbb']], { width: 4, minColumn: 3 });
    expect(out).toBe('aa…  bb…');
  });
});

describe('truncateVisible', () => {
  it('cuts by printable width and marks the cut', () => {
    expect(truncateVisible('abcdef', 4)).toBe('abc…');
    expect(truncateVisible('abc', 4)).toBe('abc');
    expect(truncateVisible(paint('abcdef', 'red', true), 4)).toBe('abc…');
  });
});

describe('time formats', () => {
  const iso = '2026-09-04T12:00:00.000Z';
  const at = (offsetMs: number): number => new Date(iso).getTime() + offsetMs;

  it('prints local date and time', () => {
    const local = new Date(iso);
    const two = (n: number): string => String(n).padStart(2, '0');
    expect(formatLocal(iso)).toBe(`${local.getFullYear()}-${two(local.getMonth() + 1)}-${two(local.getDate())} ${two(local.getHours())}:${two(local.getMinutes())}`);
    expect(formatLocal('not a date')).toBe('not a date');
  });

  it('prints the age in one unit', () => {
    expect(formatAge(iso, at(5_000))).toBe('5s ago');
    expect(formatAge(iso, at(7 * 60_000))).toBe('7m ago');
    expect(formatAge(iso, at(3 * 3_600_000))).toBe('3h ago');
    expect(formatAge(iso, at(50 * 3_600_000))).toBe('2d ago');
    expect(formatAge(iso, at(-5_000))).toBe('0s ago');
  });

  it('combines both for status and task', () => {
    expect(formatWhen(iso, at(120_000))).toBe(`${formatLocal(iso)}  (2m ago)`);
  });
});

describe('one warning prefix', () => {
  it('marks every diagnostic the same way, whichever command prints it', () => {
    const text = formatDiagnostics([
      { level: 'warning', message: 'a note' },
      { level: 'error', message: 'a problem' },
    ]);
    expect(lines(text)).toEqual([`${mark('warn')} a note`, `${mark('error')} a problem`]);
  });
});

describe('logs sources and --json', () => {
  it('reads --events instead of ignoring it', () => {
    expect(logSource({})).toBe('events.jsonl');
    expect(logSource({ raw: true })).toBe('stdout.log');
    expect(logSource({ stderr: true })).toBe('stderr.log');
    expect(logSource({ prompt: true })).toBe('prompt.md');
    expect(logSource({ events: true, raw: true })).toBe('events.jsonl');
    expect(logSource({ json: true })).toBe('events.jsonl');
  });

  it('refuses --json beside a flag that names a raw file, instead of quietly ignoring it', () => {
    // --json is the normalized entries of events.jsonl; --raw/--stderr/--prompt name a file that holds
    // something else. Taking one and dropping the other without a word is the part worth fixing.
    for (const opts of [{ json: true, raw: true }, { json: true, stderr: true }, { json: true, prompt: true }]) {
      expect(() => logSource(opts)).toThrow(expect.objectContaining({ exitCode: 2 }));
      expect(() => logSource(opts)).toThrow(/--json cannot be combined with --(raw|stderr|prompt)/);
    }
    expect(() => logSource({ json: true, raw: true })).toThrow(/--json prints the normalized entries of events.jsonl/);
    // --events still wins over the raw flags, exactly as its help text says
    expect(logSource({ events: true, json: true, raw: true })).toBe('events.jsonl');
  });

  it('emits one entry per line, dropping junk and thinking unless asked', () => {
    const raw = [
      JSON.stringify({ kind: 'text', ts: 't', text: 'hello' }),
      'not json',
      '',
      JSON.stringify({ kind: 'thinking', ts: 't', text: 'hmm' }),
    ];
    expect(jsonEntryLines(raw).map((l) => JSON.parse(l) as { kind: string })).toEqual([{ kind: 'text', ts: 't', text: 'hello' }]);
    expect(jsonEntryLines(raw, { thinking: true })).toHaveLength(2);
  });
});

describe('ASCII fallback for terminals that cannot draw the glyphs', () => {
  const KEYS = ['CAO_UNICODE', 'CAO_ASCII', 'TERM', 'WT_SESSION', 'ConEmuTask', 'TERM_PROGRAM', 'MSYSTEM', 'WSLENV'] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is chosen by CAO_ASCII and overridden by CAO_UNICODE', () => {
    process.env.CAO_ASCII = '1';
    expect(useUnicode()).toBe(false);
    expect(glyph('rule')).toBe('-');
    expect(mark('ok')).toBe('v');
    process.env.CAO_UNICODE = '1';
    expect(useUnicode()).toBe(true);
    expect(glyph('rule')).toBe('─');
    expect(mark('ok')).toBe('✓');
  });

  it('treats a terminal that announces itself as incapable as incapable', () => {
    process.env.TERM = 'dumb';
    expect(useUnicode()).toBe(false);
    process.env.CAO_ASCII = '0';
    expect(useUnicode()).toBe(true);
  });

  it('keeps every state glyph one column wide, so the status table still lines up', () => {
    process.env.CAO_ASCII = '1';
    const states: TaskState[] = ['pending', 'ready', 'running', 'waiting', 'awaiting_approval', 'needs_input', 'success', 'failed', 'blocked', 'skipped', 'cancelled'];
    for (const state of states) expect(stateGlyph(state)).toHaveLength(1);
    expect(new Set(states.map(stateGlyph)).size).toBeGreaterThanOrEqual(states.length - 1); // waiting and needs_input share '?'
  });

  it('marks a truncation with an ellipsis the terminal can print, and still fits the budget', () => {
    process.env.CAO_ASCII = '1';
    expect(truncateVisible('abcdefgh', 6)).toBe('abc...');
    expect(truncateVisible('abcdefgh', 2)).toBe('ab');
    expect(table([['a', 'a very long detail']], { width: 12 })).not.toContain('…');
  });
});

describe('terminal width', () => {
  it('falls back to $COLUMNS when there is no TTY, then to a readable default', () => {
    const saved = process.env.COLUMNS;
    try {
      process.env.COLUMNS = '80';
      expect(terminalWidth()).toBe(80);
      process.env.COLUMNS = 'not a number';
      expect(terminalWidth()).toBe(120);
      delete process.env.COLUMNS;
      expect(terminalWidth()).toBe(120);
    } finally {
      if (saved === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = saved;
    }
  });
});

describe('table shape', () => {
  it('drops a column no row fills, on request', () => {
    const rows = [
      ['a', '', 'x'],
      ['b', '', 'y'],
    ];
    expect(table(rows, { header: ['Task', 'Context', 'Detail'], width: 0, hideEmptyColumns: true })).not.toContain('Context');
    expect(table(rows, { header: ['Task', 'Context', 'Detail'], width: 0 })).toContain('Context');
  });

  it('never ends a row in whitespace, even when the last cell is empty', () => {
    for (const line of lines(table([['a', 'bbbb', ''], ['cc', 'd', '']], { width: 0 }))) {
      expect(line).toBe(line.replace(/ +$/, ''));
    }
  });
});

describe('one Agents line', () => {
  it('reads the same in cao run and cao validate', () => {
    expect(formatAgents([{ runner: 'claude', version: '2.1.0', command: 'claude', found: true }])).toBe('claude 2.1.0 (claude)');
    expect(formatAgents([{ runner: 'codex', command: 'codex', found: false, error: 'ENOENT' }])).toBe('codex NOT FOUND (codex): ENOENT');
    expect(formatAgents([], { version: '1.0', command: 'my-claude' })).toBe('claude 1.0 (my-claude)');
    expect(formatAgents(undefined)).toBe('not detected');
  });
});

describe('transcript timestamps', () => {
  it('are the local wall clock, like every other absolute time', () => {
    const iso = '2026-09-04T12:00:00.000Z';
    const local = new Date(iso);
    const two = (n: number): string => String(n).padStart(2, '0');
    expect(formatClock(iso)).toBe(`${two(local.getHours())}:${two(local.getMinutes())}:${two(local.getSeconds())}`);
    expect(formatClock(iso, true)).toBe(`${two(local.getMinutes())}:${two(local.getSeconds())}`);
    expect(formatClock('not a date')).toBe('not a date');
  });
});

describe('a workflow whose tasks are already recorded as done', () => {
  const YAML = [
    'name: t',
    'tasks:',
    '  - id: build',
    '    prompt: p',
    '    state: completed',
    '    completion:',
    '      runId: 2026-09-04-001',
    '  - id: ship',
    '    prompt: p',
  ].join(NL);

  it('says so in the plan, rather than listing work that will not happen', async () => {
    const { workflow, validation } = await buildWorkflow(YAML);
    const plan = renderExecutionPlan(workflow, validation.layers ?? [['build'], ['ship']], { verbose: true });
    expect(plan).toContain('already done in run 2026-09-04-001, will not run');
    expect(plan.split(NL).find((l) => l.includes('ship'))).not.toContain('already done');
  });

  it('and the Agents line says nothing needs launching rather than "not detected"', () => {
    expect(formatAgents([])).toBe('none to launch (every task is already completed)');
  });
});
