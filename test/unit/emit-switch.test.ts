// spec.md §4.2.3, §4.2.7, §5.4, §12.1 — the emit switch: the flags, the precedence chain and `cao emit`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION, isFutureProtocol, stamp, type PresenceFile, type RegistryEntry } from 'code-agent-orchestrator-protocol';
import { buildProgram } from '../../src/cli/program.js';
import { planEmit, wiredCapabilities } from '../../src/cli/emit.js';
import { emitCommand, emitStatusLines, readEmitStatus } from '../../src/cli/commands/emit.js';
import { configFile, machineIdentity, presenceDir, registryKey, runsDir, setRegistryWarner, writeConfig } from '../../src/persistence/registry.js';
import { captureCli, tmpDir } from '../helpers/index.js';

const NL = String.fromCharCode(10);

let home: string;
let warnings: string[];
let restoreWarner: (message: string) => void;
const saved = { CAO_HOME: process.env.CAO_HOME, CAO_EMIT: process.env.CAO_EMIT, CAO_EMIT_FEED: process.env.CAO_EMIT_FEED };

beforeEach(async () => {
  home = path.join(await tmpDir('cao-emit-'), '.cao');
  process.env.CAO_HOME = home;
  delete process.env.CAO_EMIT;
  delete process.env.CAO_EMIT_FEED;
  warnings = [];
  restoreWarner = setRegistryWarner((message) => warnings.push(message));
});

afterEach(() => {
  setRegistryWarner(restoreWarner);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------- the parser (§4.2.7)

/**
 * Parse an argument vector with the real program and catch what the command would have been called with,
 * instead of running it. `.action()` called a second time replaces the handler, so the wiring under test is
 * the wiring `cao` ships — the grammar, not a copy of it.
 */
async function parse(argv: string[]): Promise<{ arg: string | undefined; opts: Record<string, unknown> }> {
  const program = buildProgram();
  const command = program.commands.find((c) => c.name() === argv[0]);
  if (!command) throw new Error(`no such command: ${argv[0]}`);
  let captured: { arg: string | undefined; opts: Record<string, unknown> } | undefined;
  command.action((arg: string | undefined, opts: Record<string, unknown>) => {
    captured = { arg, opts };
  });
  await program.parseAsync(['node', 'cao', ...argv]);
  if (!captured) throw new Error('the action never ran');
  return captured;
}

describe('emit: --emit is strictly boolean and takes no value (§4.2.7)', () => {
  it('runs the workflow named after it — the most-typed form of the command', async () => {
    // An optional-value option would consume the positional here, leaving `emit: "workflow.yaml"` and no
    // workflow. This one line is the whole reason the flag has no value form.
    expect(await parse(['run', '--emit', 'workflow.yaml'])).toEqual({ arg: 'workflow.yaml', opts: { tui: true, emit: true } });
  });

  it('refuses a value rather than quietly taking one', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      const attempt = await captureCli(async () => {
        await parse(['run', '--emit=stdio', 'workflow.yaml']).catch((err: Error) => err);
        return 0;
      });
      expect(attempt.stderr).toContain("unknown option '--emit=stdio'");
    } finally {
      exit.mockRestore();
    }
  });

  it('leaves the option absent when neither flag is given, so the rows below it decide', async () => {
    const parsed = await parse(['run', 'workflow.yaml']);
    expect('emit' in parsed.opts).toBe(false);
  });

  it('carries --emit, --no-emit and the reserved --emit-feed identically on run and resume', async () => {
    for (const [command, arg] of [
      ['run', 'workflow.yaml'],
      ['resume', '2026-09-10-001'],
    ] as const) {
      expect((await parse([command, '--emit', arg])).opts).toMatchObject({ emit: true });
      expect((await parse([command, '--no-emit', arg])).opts).toMatchObject({ emit: false });
      expect((await parse([command, '--emit-feed', arg])).opts).toMatchObject({ emitFeed: true });
      expect((await parse([command, arg])).arg).toBe(arg);
    }
  });

  it('shows the switch and the reserved transport in the help of both commands', () => {
    for (const name of ['run', 'resume']) {
      const help = buildProgram().commands.find((c) => c.name() === name)!.helpInformation();
      expect(help).toContain('--emit ');
      expect(help).toContain('--no-emit');
      expect(help).toContain('--emit-feed');
    }
    expect(buildProgram().helpInformation()).toContain('emit [options] [action]');
  });
});

// ---------------------------------------------------------------------------- precedence (§4.2.7)

async function planWith(rows: { flag?: boolean; env?: boolean; config?: boolean }): Promise<Awaited<ReturnType<typeof planEmit>>> {
  if (rows.config !== undefined) await writeConfig({ protocol: PROTOCOL_VERSION, emit: rows.config, retainDays: 14 });
  return planEmit({ emit: rows.flag, env: rows.env === undefined ? {} : { CAO_EMIT: rows.env ? '1' : '0' } });
}

describe('emit: the precedence chain, pairwise (§4.2.7)', () => {
  it('takes the flag over the environment', async () => {
    expect(await planWith({ flag: true, env: false })).toMatchObject({ decision: { enabled: true, source: 'flag' } });
    expect(await planWith({ flag: false, env: true })).toMatchObject({ decision: { enabled: false, source: 'flag' } });
  });

  it('takes the flag over config.json', async () => {
    expect(await planWith({ flag: true, config: false })).toMatchObject({ decision: { enabled: true, source: 'flag' } });
    expect(await planWith({ flag: false, config: true })).toMatchObject({ decision: { enabled: false, source: 'flag' } });
  });

  it('takes the flag over the default', async () => {
    expect(await planWith({ flag: true })).toMatchObject({ decision: { enabled: true, source: 'flag' } });
    expect(await planWith({ flag: false })).toMatchObject({ decision: { enabled: false, source: 'flag' } });
  });

  it('takes the environment over config.json', async () => {
    expect(await planWith({ env: true, config: false })).toMatchObject({ decision: { enabled: true, source: 'env' } });
    expect(await planWith({ env: false, config: true })).toMatchObject({ decision: { enabled: false, source: 'env' } });
  });

  it('takes the environment over the default', async () => {
    expect(await planWith({ env: true })).toMatchObject({ decision: { enabled: true, source: 'env' } });
    expect(await planWith({ env: false })).toMatchObject({ decision: { enabled: false, source: 'env' } });
  });

  it('takes config.json over the default', async () => {
    expect(await planWith({ config: true })).toMatchObject({ decision: { enabled: true, source: 'config' } });
    expect(await planWith({ config: false })).toMatchObject({ decision: { enabled: false, source: 'config' } });
  });

  it('is off by default, and off means the scheduler is handed nothing at all', async () => {
    const plan = await planWith({});
    expect(plan).toMatchObject({ decision: { enabled: false, source: 'default' } });
    // §5.9: absence is the off switch. A `{ capabilities: [] }` here would have the scheduler announcing.
    expect(plan.announcement).toBeUndefined();
    expect((await planWith({ flag: true })).announcement).toBeDefined();
  });

  it('spells a falsy CAO_EMIT the way CAO_ASCII and CAO_DEBUG already do', async () => {
    for (const raw of ['0', 'false', 'no', 'off', '']) {
      expect(await planEmit({ env: { CAO_EMIT: raw } })).toMatchObject({ decision: { enabled: false, source: 'env' } });
    }
    for (const raw of ['1', 'true', 'yes']) {
      expect(await planEmit({ env: { CAO_EMIT: raw } })).toMatchObject({ decision: { enabled: true, source: 'env' } });
    }
  });
});

describe('emit: the transport is its own flag (§4.2.7)', () => {
  it('is never implied by the persisted opt-in, and says so rather than pretending to serve one', async () => {
    const enabled = await planWith({ config: true });
    expect(enabled.announcement?.feedUrl).toBeNull();
    expect(enabled.announcement?.capabilities).not.toContain('feed');
    expect(enabled.notes).toEqual([]);

    const asked = await planEmit({ emit: true, emitFeed: true, env: {} });
    expect(asked.notes.join(NL)).toMatch(/--emit-feed is reserved/);
    expect(asked.announcement?.feedUrl).toBeNull();
    expect(asked.announcement?.capabilities).not.toContain('feed');
  });

  it('is reserved in the environment too, and does not turn the switch on by itself', async () => {
    const plan = await planEmit({ env: { CAO_EMIT_FEED: '1' } });
    expect(plan.decision).toEqual({ enabled: false, source: 'default' });
    expect(plan.notes.join(NL)).toMatch(/CAO_EMIT_FEED is reserved/);
  });
});

// ---------------------------------------------------------------------------- capabilities (§4.2.3)

describe('emit: capabilities are what the run wired up (§4.2.3)', () => {
  it('claims nothing at all in a build where nothing but the announcement is wired', async () => {
    expect(wiredCapabilities()).toEqual([]);
    expect((await planWith({ flag: true })).announcement).toEqual({ capabilities: [], feedUrl: null });
  });

  it('names each wired surface, in the order the constant lists them', () => {
    expect(
      wiredCapabilities({ requests: true, requestKinds: ['answer', 'stop', 'kill'], interactions: true, presence: true }),
    ).toEqual(['requests', 'stop', 'kill', 'answer', 'interactions', 'presence']);
  });

  it('does not advertise a kind nothing polls for', () => {
    expect(wiredCapabilities({ requestKinds: ['stop', 'kill'], presence: true })).toEqual(['presence']);
  });

  it('advertises the feed only beside a URL to reach it at', () => {
    expect(wiredCapabilities({ feedUrl: null })).toEqual([]);
    expect(wiredCapabilities({ feedUrl: 'http://127.0.0.1:7801/' })).toEqual(['feed']);
  });

  it('keeps a token it does not know rather than dropping it (§4.5)', () => {
    expect(wiredCapabilities({ requests: true, requestKinds: ['stop', 'teleport'] })).toEqual(['requests', 'stop', 'teleport']);
  });
});

// ---------------------------------------------------------------------------- PROTOCOL_VERSION (§4, §4.5)

describe('emit: PROTOCOL_VERSION is stamped first (§4)', () => {
  it('writes protocol as the first key, whatever the value arrived with', () => {
    const stamped = stamp({ pid: 1, protocol: 99 as number, surface: 'x' });
    expect(Object.keys(stamped)[0]).toBe('protocol');
    expect(stamped.protocol).toBe(PROTOCOL_VERSION);
    expect(Object.keys(JSON.parse(JSON.stringify(stamped)) as object)).toEqual(['protocol', 'pid', 'surface']);
  });

  it('recognises a file written by a newer major, and only that', () => {
    expect(isFutureProtocol({ protocol: PROTOCOL_VERSION + 1 })).toBe(true);
    expect(isFutureProtocol({ protocol: PROTOCOL_VERSION })).toBe(false);
    expect(isFutureProtocol({ protocol: 'tomorrow' })).toBe(false);
    expect(isFutureProtocol(undefined)).toBe(false);
  });

  it('stamps config.json through the same helper', async () => {
    await writeConfig({ protocol: 99, emit: true, retainDays: 14 });
    const written = JSON.parse(await fs.readFile(configFile(home), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written)[0]).toBe('protocol');
    expect(written.protocol).toBe(PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------- cao emit (§5.4)

async function putJson(dir: string, name: string, value: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2));
}

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  const repositoryRoot = over.repositoryRoot ?? 'C:/work/repo';
  const runId = over.runId ?? '2026-09-10-001';
  return {
    protocol: PROTOCOL_VERSION,
    key: registryKey(repositoryRoot, runId),
    runId,
    repositoryRoot,
    orchestratorDir: `${repositoryRoot}/.orchestrator`,
    workflowName: 'beta',
    configPath: `${repositoryRoot}/workflow.yaml`,
    machine: machineIdentity(),
    pid: process.pid,
    cliVersion: '0.1.0-beta.3',
    state: 'running',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    taskCount: 3,
    capabilities: [],
    feedUrl: null,
    ...over,
  };
}

function presence(over: Partial<PresenceFile> = {}): PresenceFile {
  return {
    protocol: PROTOCOL_VERSION,
    pid: 24188,
    machine: machineIdentity(),
    surface: 'cao-desktop 0.1.0',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    understands: ['requests', 'answer', 'presence'],
    ...over,
  };
}

const field = (stdout: string, label: string): string => stdout.split(NL).find((l) => l.startsWith(`${label}:`)) ?? '';

describe('cao emit status prints the whole chain (§5.4)', () => {
  it('reports emit off, the default that said so, the home, its verdict, no entries and no surfaces', async () => {
    const shown = await captureCli(() => emitCommand('status', {}));
    expect(shown.code).toBe(0);
    expect(field(shown.stdout, 'Emit')).toContain('off');
    expect(field(shown.stdout, 'Emit')).toContain('the default');
    expect(field(shown.stdout, 'Home')).toContain(home);
    expect(field(shown.stdout, 'Home')).toContain('usable');
    expect(field(shown.stdout, 'Runs')).toContain('0 live, 0 retained');
    expect(field(shown.stdout, 'Surfaces')).toContain('none present');
    expect(shown.stdout).toContain('cao emit enable');
  });

  it('names config.json when the persisted opt-in is what turned it on', async () => {
    await writeConfig({ protocol: PROTOCOL_VERSION, emit: true, retainDays: 14 });
    const shown = await captureCli(() => emitCommand('status', {}));
    expect(field(shown.stdout, 'Emit')).toContain('on');
    expect(field(shown.stdout, 'Emit')).toContain('config.json');
  });

  it('names the environment when CAO_EMIT is what turned it on, over a config that says otherwise', async () => {
    await writeConfig({ protocol: PROTOCOL_VERSION, emit: false, retainDays: 14 });
    process.env.CAO_EMIT = '1';
    const shown = await captureCli(() => emitCommand('status', {}));
    expect(field(shown.stdout, 'Emit')).toContain('on');
    expect(field(shown.stdout, 'Emit')).toContain('CAO_EMIT');
  });

  it('names the command line when asked what a run given the flag would do', async () => {
    process.env.CAO_EMIT = '1';
    const shown = await captureCli(() => emitCommand('status', { emit: false }));
    expect(field(shown.stdout, 'Emit')).toContain('off');
    expect(field(shown.stdout, 'Emit')).toContain('--emit / --no-emit on the command line');
  });

  it('refuses an unsafe CAO_HOME by name, and reads nothing out of it', async () => {
    process.env.CAO_HOME = '//fileserver/team/.cao';
    const shown = await captureCli(() => emitCommand('status', {}));
    expect(field(shown.stdout, 'Home')).toContain('REFUSED: it is a UNC path');
    expect(field(shown.stdout, 'Runs')).toContain('0 live, 0 retained');
    expect(shown.stdout).toContain('Nothing is announced');
    expect(shown.stdout).toContain('CAO_HOME');
  });

  it('counts live against retained, and separates stale from another machine entirely', async () => {
    await putJson(runsDir(home), 'live.json', entry({ runId: '2026-09-10-001' }));
    await putJson(runsDir(home), 'ended.json', entry({ runId: '2026-09-10-002', state: 'completed', endedAt: new Date().toISOString(), exitCode: 0 }));
    await putJson(runsDir(home), 'stale.json', entry({ runId: '2026-09-10-003', heartbeatAt: new Date(Date.now() - 120_000).toISOString() }));
    await putJson(runsDir(home), 'elsewhere.json', entry({ runId: '2026-09-10-004', machine: { ...machineIdentity(), platform: 'linux' } }));

    const status = await readEmitStatus();
    expect(status.runs).toEqual({ live: 1, retained: 3, stale: 1, unknown: 1, total: 4 });
    expect(emitStatusLines(status).join(NL)).toContain('1 live, 3 retained (1 stale, 1 from another machine)');
  });

  it('names every surface present, and says what it means when there is none (§4.6)', async () => {
    await writeConfig({ protocol: PROTOCOL_VERSION, emit: true, retainDays: 14 });
    const quiet = await captureCli(() => emitCommand('status', {}));
    expect(field(quiet.stdout, 'Surfaces')).toContain('none present');
    expect(quiet.stdout).toContain('behaves exactly as it does with emit off');

    await putJson(presenceDir(home), '24188.json', presence());
    // Stale by the 60 s window, and from another machine: neither is present.
    await putJson(presenceDir(home), '5.json', presence({ pid: 5, heartbeatAt: new Date(Date.now() - 90_000).toISOString() }));
    await putJson(presenceDir(home), '6.json', presence({ pid: 6, machine: { hostname: 'OTHER', platform: 'linux', arch: 'x64' } }));
    const busy = await captureCli(() => emitCommand('status', {}));
    expect(field(busy.stdout, 'Surfaces')).toContain('cao-desktop 0.1.0 (pid 24188');
    expect(field(busy.stdout, 'Surfaces')).not.toContain('pid 5');
    expect(field(busy.stdout, 'Surfaces')).not.toContain('pid 6');
    expect(busy.stdout).toContain('a surface is watching');
  });

  it('prints the same five things as JSON, stamped, for the app that has to read them', async () => {
    await putJson(presenceDir(home), '24188.json', presence());
    process.env.CAO_EMIT = '1';
    const shown = await captureCli(() => emitCommand('status', { json: true }));
    const parsed = JSON.parse(shown.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe('protocol');
    expect(parsed).toMatchObject({
      protocol: PROTOCOL_VERSION,
      emit: true,
      source: 'env',
      home,
      homeUsable: true,
      homeRefusal: null,
      runs: { live: 0, retained: 0, stale: 0, unknown: 0, total: 0 },
    });
    expect(parsed.surfaces).toEqual([{ pid: 24188, surface: 'cao-desktop 0.1.0', heartbeatAt: expect.any(String), understands: ['requests', 'answer', 'presence'] }]);
  });
});

describe('cao emit enable and disable (§4.2.6, §4.2.7)', () => {
  it('turns the persisted opt-in on and off, and says what it did and did not change', async () => {
    const enabled = await captureCli(() => emitCommand('enable', {}));
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toContain('no network port');
    expect(enabled.stdout).toContain('byte-identical to emit off');
    expect(await planEmit({ env: {} })).toMatchObject({ decision: { enabled: true, source: 'config' } });

    const disabled = await captureCli(() => emitCommand('disable', {}));
    expect(disabled.code).toBe(0);
    expect(await planEmit({ env: {} })).toMatchObject({ decision: { enabled: false, source: 'config' } });
  });

  it('preserves keys it does not understand, so a newer cao and an older one can share the file', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configFile(home), JSON.stringify({ protocol: 1, emit: false, retainDays: 30, notifications: { sound: true } }));
    await captureCli(() => emitCommand('enable', {}));
    expect(JSON.parse(await fs.readFile(configFile(home), 'utf8'))).toEqual({ protocol: PROTOCOL_VERSION, emit: true, retainDays: 30, notifications: { sound: true } });
  });

  it('fails loudly when it cannot write, instead of reporting success it did not have', async () => {
    process.env.CAO_HOME = '//fileserver/team/.cao';
    await expect(emitCommand('enable', {})).rejects.toThrow(/UNC path/);
  });

  it('refuses a flag that asks a question of a command that is making a change', async () => {
    await expect(emitCommand('enable', { emit: true })).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
    expect(await fs.readFile(configFile(home), 'utf8').catch(() => null)).toBeNull();
  });

  it('names the three actions when given a fourth', async () => {
    await expect(emitCommand('enabel', {})).rejects.toThrow(/enable, disable, status/);
    await expect(emitCommand('enabel', {})).rejects.toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it('shows status when no action is named', async () => {
    const shown = await captureCli(() => emitCommand(undefined, {}));
    expect(field(shown.stdout, 'Emit')).toContain('off');
  });
});
