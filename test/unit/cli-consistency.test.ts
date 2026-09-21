import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DEFAULT_WORKFLOW_FILES, matchTask, questionLines, requireTask, resolveWorkflowPath, table, terminalWidth, truncateVisible } from '../../src/cli/util.js';
import { formatAge, formatClock, formatLocal, formatWhen } from '../../src/util/duration.js';
import { formatDiagnostics } from '../../src/workflow/validator.js';
import { logSource, jsonEntryLines } from '../../src/cli/commands/logs.js';
import { mark } from '../../src/util/marks.js';
import { glyph, useUnicode } from '../../src/util/glyphs.js';
import { stateGlyph } from '../../src/workflow/states.js';
import { attachPlainRenderer, formatAgents } from '../../src/cli/render/plain.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { renderExecutionPlan } from '../../src/workflow/plan.js';
import type { TaskState } from 'code-agent-orchestrator-protocol';
import { buildWorkflow, makeRun, tmpDir } from '../helpers/index.js';
import { paint, stripAnsi } from '../../src/cli/color.js';
import { Command, CommanderError } from 'commander';
import { buildProgram, COMMAND_GROUPS } from '../../src/cli/program.js';
import { globalKeys } from '../../src/tui/workspace/keys.js';

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

describe('questionLines', () => {
  const ESC = String.fromCharCode(27);
  const CR = String.fromCharCode(13);

  it('quotes a question an operator has to read, and lets an agent write none of the terminal', () => {
    expect(questionLines('Which database?')).toEqual(['| Which database?']);
    expect(questionLines(undefined)).toEqual([]);
    expect(questionLines('   ')).toEqual([]);
    // Blank lines dropped, so a question padded with them does not push the resume command off the screen.
    expect(questionLines('one\n\n\ntwo')).toEqual(['| one', '| two']);
    // Clipped at maxLines, and the reader is told where the rest is.
    expect(questionLines('a\nb\nc\nd\ne', 2)).toEqual(['| a', '| b', '| ... clipped; the whole question is in cao task <id>']);
    // Wrapped on word boundaries rather than cut: the end of a long question is the actionable part.
    expect(questionLines('one two three four five', 4, 10)).toEqual(['| one two', '| three four', '| five']);
    // The question is agent-written and lands next to the command an operator is about to run: an escape
    // sequence or a carriage return in it must not reach the terminal.
    expect(questionLines(`Run ${CR}rm -rf /${ESC}[2K${ESC}[G now?`)).toEqual(['| Run rm -rf / now?']);
    // A single unbroken token has no word boundary to break on, so it is cut at the width.
    expect(questionLines('x'.repeat(25), 4, 10)).toEqual([`| ${'x'.repeat(10)}`, `| ${'x'.repeat(10)}`, `| ${'x'.repeat(5)}`]);
  });
});

describe('the plain renderer', () => {
  const ESC = String.fromCharCode(27);
  const CR = String.fromCharCode(13);

  it('lets a warning write no more of the terminal than any other agent text', async () => {
    const written: string[] = [];
    const r = await run(['a']);
    const bus = new WorkflowEventBus(r.runId);
    attachPlainRenderer(bus, r, { write: (line) => written.push(line), color: false });
    // A warning carries agent-controlled text - a stream error, a rejection the CLI worded - and this
    // renderer writes straight to a terminal.
    bus.emit({ type: 'workflow.warning', code: 'agent', taskId: 'a', message: `Codex rejected it: ${CR}${ESC}[2K${ESC}[Gall clear${NL}second line` });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('a: Codex rejected it: all clear');
    expect(written[0]).not.toContain(ESC);
    expect(written[0]).not.toContain(CR);
    expect(written[0]).not.toContain('second line');
  });

  /**
   * The headless line for a message sent to a task (§3.5, §2.6).
   *
   * It said "followUp via none: delivered" - the wire's own spelling of the mode, and a `transport` of
   * `none` that every follow-up has by definition, because a follow-up is the row with no live channel.
   */
  it('writes a delivery in the words the rest of the surface uses, and never the message itself', async () => {
    const written: string[] = [];
    const r = await run(['a']);
    const bus = new WorkflowEventBus(r.runId);
    attachPlainRenderer(bus, r, { write: (line) => written.push(line), color: false });

    bus.emit({ type: 'task.prompted', taskId: 'a', attempt: 2, deliveryId: 'd1', mode: 'followUp', transport: 'none', state: 'delivered' });
    bus.emit({ type: 'task.prompted', taskId: 'a', attempt: 2, deliveryId: 'd2', mode: 'steer', transport: 'claude-stream', state: 'accepted' });

    expect(written[0]).toContain('a  follow-up: delivered');
    expect(written[0]).not.toContain('none');
    expect(written[1]).toContain("a  steer via Claude's open stdin: accepted");
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
    // Every state its own glyph, in both alphabets: the sidebar has room for the glyph and not the word, so
    // two states drawn the same there are one state to whoever is reading it.
    expect(new Set(states.map(stateGlyph)).size, 'two states share an ASCII glyph').toBe(states.length);
    delete process.env.CAO_ASCII;
    process.env.CAO_UNICODE = '1';
    for (const state of states) expect(stateGlyph(state), state).toHaveLength(1);
    expect(new Set(states.map(stateGlyph)).size, 'two states share a glyph').toBe(states.length);
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

// ------------------------------------------------------------------- CLI discovery and help (§3.3)

interface Dispatched {
  /** `task show`, `run`, ... - where the arguments actually landed. */
  path: string;
  args: unknown[];
  options: Record<string, unknown>;
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** The program a test parses with: real commands, real options, no side effects and no `process.exit`. */
function testProgram(): { program: Command; dispatched: Dispatched[]; written: string[] } {
  const program = buildProgram();
  const dispatched: Dispatched[] = [];
  const written: string[] = [];
  // Commander's own default: throw a CommanderError instead of leaving through `process.exit`.
  program.exitOverride();
  program.configureOutput({ writeOut: (s) => void written.push(s), writeErr: (s) => void written.push(s) });
  const stub = (command: Command): void => {
    command.exitOverride();
    command.action((...args: unknown[]) => {
      const self = args[args.length - 1] as Command;
      dispatched.push({ path: commandPath(self), args: args.slice(0, -2), options: self.opts() });
    });
    command.commands.forEach(stub);
  };
  program.commands.forEach(stub);
  return { program, dispatched, written };
}

function parseCli(argv: string[]): Dispatched {
  const { program, dispatched } = testProgram();
  program.parse(argv, { from: 'user' });
  if (dispatched.length !== 1) throw new Error(`expected one dispatch for "cao ${argv.join(' ')}", got ${dispatched.length}`);
  return dispatched[0]!;
}

/**
 * Parse and throw only on a real usage error. `--help` and `--version` leave through `CommanderError` too,
 * with exit code 0 - they are commands that worked, and README.md offers both.
 */
function parseOk(argv: string[]): void {
  try {
    testProgram().program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) return;
    throw err;
  }
}

/**
 * Help at a fixed width, for a command named by its path. `outputHelp`, not `helpInformation`: the Examples
 * and Exit blocks are `addHelpText('after', ...)`, which is an event only the former emits.
 */
function helpAt(columns: number, commandPathParts: string[] = []): string {
  let out = '';
  const config = { getOutHelpWidth: () => columns, getErrHelpWidth: () => columns, writeOut: (s: string) => void (out += s) };
  let command = buildProgram();
  command.configureOutput(config);
  for (const name of commandPathParts) {
    command = command.commands.find((c) => c.name() === name)!;
    command.configureOutput(config);
  }
  command.outputHelp();
  return out;
}

/**
 * CLI discovery and help (§3.3, `[D6]`, `[D18]`).
 *
 * Everything here drives the real `buildProgram()`. The actions are the only thing replaced, and only on the
 * subcommands: an action handler on the root would stop commander ever reaching `unknownCommand()`, which is
 * the behaviour half of these cases are about.
 */
describe('bare cao', () => {
  it('prints the root help to stdout and exits 0, instead of stderr and 2', () => {
    const { program, written } = testProgram();
    // `parse([])` is `cao` with nothing after it. Commander's own answer is `help({ error: true })`, which
    // writes to stderr and leaves with 1 — remapped to 2 by this CLI's exitOverride.
    let err: CommanderError | null = null;
    try {
      program.parse([], { from: 'user' });
    } catch (e) {
      err = e as CommanderError;
    }
    expect(err?.code).toBe('commander.help');
    expect(err?.exitCode).toBe(0);
    expect(written.join('')).toContain('Usage: cao [options] [command]');
    expect(written.join('')).toContain('Exit codes:');
  });

  it('still refuses an unknown command with a suggestion and exit 2', () => {
    const { program, written } = testProgram();
    expect(() => program.parse(['stauts'], { from: 'user' })).toThrow(expect.objectContaining({ code: 'commander.unknownCommand' }));
    expect(written.join('')).toContain("unknown command 'stauts'");
    expect(written.join('')).toContain('Did you mean status?');
  });
});

describe('root help groups', () => {
  const help = helpAt(100);

  it('lists every command under one of the four headings, in spec order', () => {
    const headings = [COMMAND_GROUPS.run, COMMAND_GROUPS.inspect, COMMAND_GROUPS.task, COMMAND_GROUPS.diagnostics];
    const positions = headings.map((h) => help.indexOf(`${NL}${h}${NL}`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));

    const groupOf = (name: string): string | undefined => {
      const at = help.indexOf(`${NL}  ${name} `);
      return headings.filter((h) => help.indexOf(`${NL}${h}${NL}`) < at).pop();
    };
    for (const name of ['run', 'resume', 'ui', 'stop', 'validate']) expect(groupOf(name), name).toBe(COMMAND_GROUPS.run);
    for (const name of ['status', 'list', 'logs', 'peek', 'diff', 'report']) expect(groupOf(name), name).toBe(COMMAND_GROUPS.inspect);
    expect(groupOf('task')).toBe(COMMAND_GROUPS.task);
    for (const name of ['doctor', 'clean', 'emit']) expect(groupOf(name), name).toBe(COMMAND_GROUPS.diagnostics);
  });

  it('fits 100 columns and reads the same every time', () => {
    for (const line of help.split(NL)) expect(line.length).toBeLessThanOrEqual(100);
    expect(help).toBe(helpAt(100));
    expect(help).toMatchSnapshot();
  });

  it('names the environment variables a workspace reads, not only the ones a run reads', () => {
    const names = ['CAO_CLAUDE_COMMAND', 'CAO_CODEX_COMMAND', 'CAO_EMIT', 'CAO_HOME', 'CAO_DEBUG', 'CAO_ASCII', 'CAO_ALT_SCREEN', 'CAO_THEME', 'CAO_REDUCED_MOTION', 'NO_COLOR', 'COLUMNS'];
    for (const name of names) expect(help).toContain(name);
  });
});

describe('cao task subcommands [D6]', () => {
  it('sends a bare reference to show, the default subcommand', () => {
    expect(parseCli(['task', 'review'])).toMatchObject({ path: 'task show', args: [['review']] });
    expect(parseCli(['task'])).toMatchObject({ path: 'task show', args: [[]] });
    expect(parseCli(['task', '002', 'review', '--json'])).toMatchObject({ path: 'task show', args: [['002', 'review']], options: { json: true } });
  });

  it('lets a literal subcommand name win, and show reach a task with that name', () => {
    expect(parseCli(['task', 'stop', 'review'])).toMatchObject({ path: 'task stop', args: [['review']] });
    expect(parseCli(['task', 'restart', 'review'])).toMatchObject({ path: 'task restart', args: [['review']] });
    // ...which is why a task called `edit` (or `stop`, from stage 2 on) needs the long form
    expect(parseCli(['task', 'show', 'edit'])).toMatchObject({ path: 'task show', args: [['edit']] });
    expect(parseCli(['task', 'show', 'stop'])).toMatchObject({ path: 'task show', args: [['stop']] });
  });

  it('gives stop and restart a --wait, and says so in the help', () => {
    expect(parseCli(['task', 'stop', 'review', '--wait', '0'])).toMatchObject({ path: 'task stop', options: { wait: 0 } });
    expect(parseCli(['task', 'restart', 'review']).options.wait).toBeUndefined();
    expect(helpAt(100, ['task', 'stop'])).toContain('default: 30');
    // The precedence rule is the surprising part, so the help for `task` has to state it.
    expect(helpAt(100, ['task'])).toContain('cao task show stop');
  });

  /**
   * `cao task prompt` with no mode flag (§3.5).
   *
   * Three mode flags in an option list read like a choice that has to be made before anything can be sent,
   * and the help said nothing to the contrary: it is the opposite, and the run's answer names what it did.
   */
  it('says in the help that the mode flags are optional and that the answer names the mode', () => {
    expect(parseCli(['task', 'prompt', 'review', '--message', 'x']).options.steer).toBeUndefined();
    const help = helpAt(100, ['task', 'prompt']);
    expect(help).toContain('The three mode flags are optional');
    expect(help).toContain('the run picks the one the task allows');
    for (const mode of ['Steer:', 'Stop and continue:', 'Follow-up:']) expect(help, mode).toContain(mode);
  });
});

describe('cao doctor probes are opt-in [D32]', () => {
  it('parses --probe, leaves the default unset, and still accepts --no-probe', () => {
    expect(parseCli(['doctor']).options.probe).toBeUndefined();
    expect(parseCli(['doctor', '--probe']).options.probe).toBe(true);
    expect(parseCli(['doctor', '--no-probe']).options.probe).toBe(false);
    expect(helpAt(100, ['doctor'])).toContain('deprecated');
  });
});

/**
 * Every example this CLI and its documentation offer, put through the parser (§3.3).
 *
 * The examples are the part of the help a reader copies, and the part nobody re-runs after renaming an
 * option. Both sources are scanned: the `Examples:` block of every command's own help, and the fenced
 * `cao …` lines of README.md and docs/capabilities.md.
 */
describe('the examples all parse', () => {
  /** `<run-id>` and friends stand for something a user types; substitute something the parsers accept. */
  const PLACEHOLDERS: Record<string, string> = { n: '1', seconds: '30', attempt: '1', mode: 'auto', theme: 'mono', text: 'hello' };
  const dummy = (token: string): string => token.replace(/<([a-z0-9.-]+)>/gi, (_m, name: string) => PLACEHOLDERS[name.toLowerCase()] ?? 'x');

  /** A shell line, without the comment a human reads and without the redirection a shell would handle. */
  function argvOf(line: string): string[] {
    const tokens = line.split('#')[0]!.match(/"[^"]*"|\S+/g) ?? [];
    const argv: string[] = [];
    for (const token of tokens) {
      if (['>', '>>', '|', '&&', ';'].includes(token)) break;
      argv.push(dummy(token).replace(/^"|"$/g, ''));
    }
    return argv.slice(1);
  }

  function examplesInHelp(): string[] {
    const found: string[] = [];
    const walk = (parts: string[], command: Command): void => {
      const helpLines = helpAt(100, parts).split(NL);
      const start = helpLines.indexOf('Examples:');
      if (start >= 0) {
        for (const line of helpLines.slice(start + 1)) {
          if (line.trim() === '') break;
          found.push(line.trim());
        }
      }
      for (const child of command.commands) walk([...parts, child.name()], child);
    };
    for (const command of buildProgram().commands) walk([command.name()], command);
    return found;
  }

  /**
   * Fenced `cao …` lines. A block that has a shell prompt (`$ …`) in it is a transcript: what follows the
   * prompt is output, and `cao 0.1.0-beta.3` there is a version banner rather than a command.
   */
  async function examplesInDoc(file: string): Promise<string[]> {
    const text = await fs.readFile(path.join(process.cwd(), file), 'utf8');
    const found: string[] = [];
    let block: string[] | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('```')) {
        if (block) {
          if (!block.some((l) => l.startsWith('$ '))) found.push(...block.filter((l) => l.startsWith('cao ')));
          block = null;
        } else block = [];
        continue;
      }
      block?.push(line);
    }
    return found;
  }

  it('every Examples: line in the help is a command this CLI accepts', () => {
    const examples = examplesInHelp();
    expect(examples.length).toBeGreaterThan(30);
    for (const example of examples) {
      expect(example.startsWith('cao '), example).toBe(true);
      expect(() => parseOk(argvOf(example)), example).not.toThrow();
    }
  });

  it('and so is every cao line in README.md and docs/capabilities.md', async () => {
    for (const file of ['README.md', 'docs/capabilities.md']) {
      const examples = await examplesInDoc(file);
      expect(examples.length, file).toBeGreaterThan(5);
      for (const example of examples) {
        expect(() => parseOk(argvOf(example)), `${file}: ${example}`).not.toThrow();
      }
    }
  });
});

/**
 * What the documentation promises about the keyboard (§3.2).
 *
 * The chord sentence is the kind of claim that rots quietly: it was written when `Ctrl+C` really was the
 * only one the workspace read, and it stayed on the page through `Ctrl+P` and the answer field's `Ctrl+J`,
 * contradicting the same README four lines above it. Both documents are checked against the table the
 * workspace itself answers from, so a chord added there is a failing test until the prose catches up.
 */
describe('the chords the docs promise', () => {
  const DOCS = ['README.md', 'docs/capabilities.md'];
  /** The two no table holds: the answer composer's newline (`app.tsx`) and the viewer's page up (`viewer.tsx`). */
  const INLINE_CHORDS = ['Ctrl+J', 'Ctrl+A'];

  it('name every chord the workspace reads, and call none of them the only one', async () => {
    const chords = [...new Set([...globalKeys('executing').map((k) => k.keys), ...INLINE_CHORDS])].filter((k) => k.startsWith('Ctrl+'));
    expect(chords).toEqual(expect.arrayContaining(['Ctrl+C', 'Ctrl+P', 'Ctrl+J', 'Ctrl+A']));
    for (const file of DOCS) {
      const text = await fs.readFile(path.join(process.cwd(), file), 'utf8');
      for (const chord of chords) expect(text, `${file} does not mention ${chord}`).toContain(chord);
      expect(text.match(/only chords?/g) ?? [], `${file} calls a chord the only one`).toEqual([]);
    }
  });
});

/**
 * The CLI reference table of README.md, against the program it describes (§3.3).
 *
 * Most rows name the options worth naming and leave the rest to `--help`, which is the point of a summary.
 * The three commands that can open the workspace are the exception: they share a set of options, an
 * operator comparing the rows is comparing that set, and a row that is short by two is read as a command
 * that does not take them. `--no-alt-screen` and `--theme` went missing from `cao run` that way.
 */
describe('the CLI reference table', () => {
  /** A row of the table: the command it names, and the long options its prose mentions. */
  function tableRows(text: string): { name: string; parts: string[]; flags: Set<string>; text: string }[] {
    return text
      .split(NL)
      .map((line) => line.replace(String.fromCharCode(13), ''))
      .filter((line) => line.startsWith('| `cao '))
      .map((line) => {
        const cells = line.split('|').map((cell) => cell.trim());
        const name = cells[1]!.replace(/`/g, '').trim();
        return { name, parts: name.split(' ').filter((token) => /^[a-z]+$/.test(token)).slice(1), flags: new Set(cells[2]!.match(/--[a-z][a-z-]*/g) ?? []), text: cells[2]! };
      });
  }

  /**
   * Every long option the named command answers, including its subcommands': one row covers a whole family
   * (`cao task <task>` is `cao task show`, and one row covers `cao task stop` and `cao task restart`).
   */
  function longOptionsOf(parts: string[]): string[] {
    let command: Command | undefined = buildProgram();
    for (const part of parts) command = command?.commands.find((child) => child.name() === part);
    expect(command, parts.join(' ')).toBeDefined();
    const longs = (of: Command): string[] => [...of.options.map((option) => option.long).filter((long): long is string => Boolean(long)), ...of.commands.flatMap(longs)];
    return [...new Set(longs(command!))];
  }

  it('names a real option of that command in every row', async () => {
    const rows = tableRows(await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8'));
    expect(rows.length).toBeGreaterThan(14);
    for (const row of rows) {
      if (!row.parts.length) continue;
      const real = longOptionsOf(row.parts);
      for (const flag of row.flags) expect(real, `${row.name} has no ${flag}`).toContain(flag);
    }
  });

  it('lists every option shared by the commands that open the workspace', async () => {
    const rows = tableRows(await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8'));
    const opening = ['run', 'resume', 'ui'];
    const shared = longOptionsOf(['run']).filter((long) => opening.every((name) => longOptionsOf([name]).includes(long)));
    expect(shared).toEqual(expect.arrayContaining(['--no-tui', '--no-alt-screen', '--theme', '--repository', '--verbose']));
    for (const name of opening) {
      const row = rows.find((candidate) => candidate.parts.join(' ') === name);
      expect(row, name).toBeDefined();
      // A row may defer to another instead of repeating it; `cao resume` does, and says so in its prose.
      const inherited = row!.text.includes('the `cao run` overrides') ? rows.find((candidate) => candidate.parts.join(' ') === 'run')!.flags : new Set<string>();
      for (const flag of shared) expect([...row!.flags, ...inherited], `cao ${name} does not list ${flag}`).toContain(flag);
    }
  });
});
