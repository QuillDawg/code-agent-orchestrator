// spec.md §4.2, §4.6.1, §5.1, §11.2, §12.1 — the `registry` suite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type PresenceFile, type RegistryEntry } from 'code-agent-orchestrator-protocol';
import {
  DEFAULT_RETAIN_DAYS,
  assertSafeHome,
  caoHome,
  configFile,
  emitEnabled,
  emitSetting,
  entryFile,
  entryForRun,
  entryLiveness,
  hasFreshPresence,
  homeRefusal,
  isSyncConflictName,
  listEntries,
  listPresence,
  machineIdentity,
  normalizedRepositoryRoot,
  presenceDir,
  readConfig,
  reap,
  registryKey,
  removeEntry,
  runsDir,
  setRegistryWarner,
  systemHomeChecks,
  writeConfig,
  writeEntry,
  type HomeChecks,
} from '../../src/persistence/registry.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { buildWorkflow, makeRun, MemoryRunStore, mkdirHome, MockRunner, MockWorkspace, tmpDir, waitFor } from '../helpers/index.js';
import type { Clock } from '../../src/util/misc.js';

const DAY_MS = 86_400_000;
const CAPABILITIES = ['presence'];

let home: string;
let warnings: string[];
let restoreWarner: (message: string) => void;
const originalHome = process.env.CAO_HOME;

beforeEach(async () => {
  home = path.join(await tmpDir('cao-registry-'), '.cao');
  process.env.CAO_HOME = home;
  warnings = [];
  restoreWarner = setRegistryWarner((message) => warnings.push(message));
});

afterEach(() => {
  setRegistryWarner(restoreWarner);
  if (originalHome === undefined) delete process.env.CAO_HOME;
  else process.env.CAO_HOME = originalHome;
});

/** An entry with every §4.2.3 field set, so a test only has to say what it is about. */
function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  const repositoryRoot = over.repositoryRoot ?? 'C:/work/repo';
  const runId = over.runId ?? '2026-09-10-001';
  return {
    protocol: PROTOCOL_VERSION,
    key: registryKey(repositoryRoot, runId),
    runId,
    repositoryRoot,
    orchestratorDir: `${repositoryRoot}/.orchestrator`,
    workflowName: 'beta-improvements',
    configPath: `${repositoryRoot}/workflows/beta.yaml`,
    machine: machineIdentity(),
    pid: process.pid,
    cliVersion: '0.1.0-beta.3',
    state: 'running',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    taskCount: 7,
    capabilities: ['requests', 'stop', 'presence'],
    feedUrl: null,
    ...over,
  };
}

/** Write a file into `runs/` under a name of the test's choosing, bypassing key validation. */
async function putRaw(dir: string, name: string, body: string): Promise<string> {
  await mkdirHome(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, body, 'utf8');
  return file;
}

async function readEntryFile(key: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(entryFile(key, home), 'utf8')) as Record<string, unknown>;
}

/** `waitFor` takes a synchronous predicate; a registry write is only ever visible by reading it back. */
async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('registry: the key (§4.2.2)', () => {
  it('gives two repositories that both allocate 2026-09-10-001 on one day two entries, not one', async () => {
    // `allocateRunId` is unique within one repository's runs directory. A registry keyed on the run id alone
    // silently loses one of these two runs, and the design proposal's sketch had exactly that bug.
    const runId = '2026-09-10-001';
    await writeEntry(entry({ repositoryRoot: 'C:/work/alpha', runId }));
    await writeEntry(entry({ repositoryRoot: 'C:/work/beta', runId }));

    const found = await listEntries();
    expect(found).toHaveLength(2);
    expect(new Set(found.map((e) => e.key)).size).toBe(2);
    expect(found.every((e) => e.runId === runId)).toBe(true);
    expect((await fs.readdir(runsDir(home))).sort()).toEqual(found.map((e) => `${e.key}.json`).sort());
  });

  it('collapses two spellings of one case-insensitive path into one hash', () => {
    const runId = '2026-09-10-001';
    for (const platform of ['win32', 'darwin']) {
      expect(registryKey('C:\\Projects\\Repo\\', runId, platform)).toBe(registryKey('c:/projects/repo', runId, platform));
    }
    // POSIX filesystems are case-sensitive, so two spellings really are two directories there.
    expect(registryKey('/Work/Repo', runId, 'linux')).not.toBe(registryKey('/work/repo', runId, 'linux'));
    expect(registryKey('C:/work/repo', runId)).toBe(registryKey('C:/work/repo', runId, process.platform));
  });

  it('normalises separators and the trailing one before hashing', () => {
    expect(normalizedRepositoryRoot('C:\\work\\repo\\', 'linux')).toBe('C:/work/repo');
    expect(normalizedRepositoryRoot('/work/repo//', 'linux')).toBe('/work/repo');
    expect(normalizedRepositoryRoot('/work/Repo', 'darwin')).toBe('/work/repo');
  });

  it('is a run id, @, and eight hex characters — and @ cannot appear in a run id', () => {
    const key = registryKey('C:/work/repo', '2026-09-10-001');
    expect(key).toMatch(/^2026-09-10-001@[0-9a-f]{8}$/);
    expect(key.split('@')).toHaveLength(2);
  });
});

describe('registry: the entry (§4.2.3)', () => {
  it('stamps the protocol version as the first field on disk', async () => {
    await writeEntry(entry({ protocol: 99 }));
    const raw = await fs.readFile(entryFile(registryKey('C:/work/repo', '2026-09-10-001'), home), 'utf8');
    expect(Object.keys(JSON.parse(raw) as object)[0]).toBe('protocol');
    expect((JSON.parse(raw) as RegistryEntry).protocol).toBe(PROTOCOL_VERSION);
  });

  it('carries hostname and platform and arch, and /-joined paths', async () => {
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n', { repositoryRoot: 'C:\\work\\repo' });
    const run = makeRun(workflow, '2026-09-10-001');
    const built = entryForRun(run, { capabilities: CAPABILITIES });

    expect(built.machine).toEqual({ hostname: os.hostname(), platform: process.platform, arch: process.arch });
    expect(built.repositoryRoot).toBe('C:/work/repo');
    expect(built.orchestratorDir).toBe('C:/work/repo/.orchestrator');
    expect(built.configPath).not.toContain('\\');
    expect(built.taskCount).toBe(1);
    expect(built.capabilities).toEqual(CAPABILITIES);
    expect(built.feedUrl).toBeNull();
  });

  it('reports no exit code while the run has not ended', async () => {
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n');
    const run = { ...makeRun(workflow), state: 'running' as const, exitCode: 3, endedAt: undefined };
    expect(entryForRun(run, { capabilities: [] }).exitCode).toBeNull();
    expect(entryForRun({ ...run, endedAt: '2026-09-10T10:00:00.000Z' }, { capabilities: [] }).exitCode).toBe(3);
  });

  it('removes an entry by key', async () => {
    const e = entry();
    await writeEntry(e);
    expect(await listEntries()).toHaveLength(1);
    await removeEntry(e.key);
    expect(await listEntries()).toEqual([]);
  });
});

describe('registry: lifecycle (§4.2.4)', () => {
  it('writes at run start, rewrites on the 20 s tick, and finishes with the terminal entry', async () => {
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n', { gitRoot: process.cwd() });
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const clock: Clock = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        const i = timers.indexOf(h as { fn: () => void; ms: number });
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const run = makeRun(workflow, '2026-09-10-001');
    const runner = new MockRunner().when('a', { kind: 'hang' });
    const store = new MemoryRunStore();
    const bus = new WorkflowEventBus(run.runId);
    const scheduler = new WorkflowScheduler({
      run,
      store,
      runners: new RunnerRegistry().register(runner),
      workspace: new MockWorkspace(workflow.repositoryRoot),
      bus,
      clock,
      emit: { capabilities: CAPABILITIES },
    });
    const key = registryKey(run.repositoryRoot, run.runId);
    const done = scheduler.execute();

    // Run start: the entry exists, says running, and points at the run directory rather than copying it.
    await until(async () => Boolean(await fs.stat(entryFile(key, home)).catch(() => null)), 'the entry to be written');
    const started = (await readEntryFile(key)) as unknown as RegistryEntry;
    expect(started.state).toBe('running');
    expect(started.endedAt).toBeNull();
    expect(started.exitCode).toBeNull();
    expect(started.pid).toBe(process.pid);
    expect(started.capabilities).toEqual(CAPABILITIES);
    expect(started.orchestratorDir).toBe(`${started.repositoryRoot}/.orchestrator`);

    // The heartbeat: the same 20 s tick that rewrites lock.json and live.json rewrites heartbeatAt.
    await waitFor(() => timers.some((t) => t.ms === 20_000));
    await new Promise((r) => setTimeout(r, 5));
    timers.find((t) => t.ms === 20_000)!.fn();
    await until(async () => (await readEntryFile(key)).heartbeatAt !== started.heartbeatAt, 'the heartbeat to rewrite it');
    const beating = (await readEntryFile(key)) as unknown as RegistryEntry;
    expect(beating.state).toBe('running');
    expect(Date.parse(beating.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(started.heartbeatAt));

    // The terminal write, and the entry is retained rather than removed.
    runner.complete('a', 1, { kind: 'result', result: { status: 'success', summary: 's', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    const result = await done;
    expect(result.state).toBe('completed');
    const ended = (await readEntryFile(key)) as unknown as RegistryEntry;
    expect(ended.state).toBe('completed');
    expect(ended.endedAt).not.toBeNull();
    expect(ended.exitCode).toBe(0);
    expect(await listEntries()).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('never touches ~/.cao with emit off', async () => {
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n', { gitRoot: process.cwd() });
    const run = makeRun(workflow, '2026-09-10-002');
    const bus = new WorkflowEventBus(run.runId);
    const scheduler = new WorkflowScheduler({
      run,
      store: new MemoryRunStore(),
      runners: new RunnerRegistry().register(new MockRunner()),
      workspace: new MockWorkspace(workflow.repositoryRoot),
      bus,
    });
    expect((await scheduler.execute()).state).toBe('completed');
    // Registry writes are fire-and-forget; give one that should not exist time to land before looking.
    await new Promise((r) => setTimeout(r, 250));
    expect(await fs.readdir(home).catch(() => null)).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe('registry: reaping (§4.2.5)', () => {
  const old = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

  it('collects a run that ended longer ago than retainDays', async () => {
    await writeEntry(entry({ runId: '2026-01-01-001', state: 'completed', endedAt: old(20), exitCode: 0 }));
    await writeEntry(entry({ runId: '2026-01-02-001', state: 'failed', endedAt: old(3), exitCode: 1 }));
    await reap(DEFAULT_RETAIN_DAYS);
    expect((await listEntries()).map((e) => e.runId)).toEqual(['2026-01-02-001']);
  });

  it('collects a hard-killed run by heartbeatAt age, though its endedAt is null — the tombstone clause', async () => {
    // `taskkill /F`, a laptop dying on battery, an editor window closed on a running task: the entry keeps
    // `state: 'running'` and `endedAt: null` forever. With only the first clause it is permanently stale and
    // never expired — a tombstone nothing can ever collect.
    await writeEntry(entry({ runId: '2026-01-01-001', state: 'running', endedAt: null, heartbeatAt: old(20) }));
    expect(await listEntries()).toHaveLength(1);
    await reap(DEFAULT_RETAIN_DAYS);
    expect(await listEntries()).toEqual([]);
  });

  it('keeps a stale entry inside the window: stale is not expired', async () => {
    // The app shows this run as stale and offers `cao resume`; deleting the pointer would take that away.
    const e = entry({ state: 'running', endedAt: null, heartbeatAt: old(1) });
    await writeEntry(e);
    expect(entryLiveness(e)).toBe('stale');
    await reap(DEFAULT_RETAIN_DAYS);
    expect(await listEntries()).toHaveLength(1);
  });

  it('deletes pointers, never run directories', async () => {
    const repositoryRoot = await tmpDir('cao-registry-repo-');
    const runDir = path.join(repositoryRoot, '.orchestrator', 'runs', '2026-01-01-001');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'workflow.json'), '{}', 'utf8');
    await writeEntry(entry({ repositoryRoot, runId: '2026-01-01-001', state: 'completed', endedAt: old(20) }));

    await reap(DEFAULT_RETAIN_DAYS);
    expect(await listEntries()).toEqual([]);
    expect(await fs.readFile(path.join(runDir, 'workflow.json'), 'utf8')).toBe('{}');
  });

  it('leaves an entry from another machine alone, and reports its liveness as unknown', async () => {
    const e = entry({ machine: { hostname: 'OTHER-BOX', platform: process.platform, arch: process.arch }, heartbeatAt: old(30) });
    await writeEntry(e);
    expect(entryLiveness(e)).toBe('unknown');
    await reap(DEFAULT_RETAIN_DAYS);
    expect(await listEntries()).toHaveLength(1);
  });

  it('will not reap an entry written by a newer protocol', async () => {
    await writeEntry(entry({ state: 'completed', endedAt: old(30) }));
    const key = registryKey('C:/work/repo', '2026-09-10-001');
    const stored = await readEntryFile(key);
    await fs.writeFile(entryFile(key, home), JSON.stringify({ ...stored, protocol: PROTOCOL_VERSION + 1 }), 'utf8');
    await reap(DEFAULT_RETAIN_DAYS);
    expect(await listEntries()).toHaveLength(1);
  });

  it('swallows every error', async () => {
    const blocked = await tmpDir('cao-registry-blocked-');
    await fs.writeFile(path.join(blocked, 'wall'), 'not a directory', 'utf8');
    process.env.CAO_HOME = path.join(blocked, 'wall', '.cao');
    await expect(reap(DEFAULT_RETAIN_DAYS)).resolves.toBeUndefined();
    await expect(reap(-1)).resolves.toBeUndefined();
  });
});

describe('registry: machine identity suppresses liveness (§4.2.3)', () => {
  it('reports unknown, not a wrong answer, for a linux entry carrying this hostname (WSL2)', () => {
    // WSL2 takes the Windows host's hostname by default. A hostname check alone passes here, on a pid from a
    // different pid namespace — and `process.pid` below really is alive on the machine asking.
    const wsl = entry({ machine: { hostname: os.hostname(), platform: 'linux', arch: 'x64' }, pid: process.pid });
    const windows = { hostname: os.hostname(), platform: 'win32', arch: 'x64' };
    expect(entryLiveness(wsl, Date.now(), windows)).toBe('unknown');
    // The same entry, asked by the machine that wrote it, is the run it says it is.
    expect(entryLiveness(wsl, Date.now(), wsl.machine)).toBe('running');
  });

  it('distinguishes arch as well as platform', () => {
    const self = machineIdentity();
    const e = entry({ machine: { ...self, arch: `${self.arch}-other` } });
    expect(entryLiveness(e)).toBe('unknown');
  });

  it('calls a run whose heartbeat has gone quiet stale, not running', () => {
    const e = entry({ heartbeatAt: new Date(Date.now() - 120_000).toISOString(), pid: process.pid });
    expect(entryLiveness(e)).toBe('stale');
  });

  it('calls an entry whose state is terminal ended, whoever wrote it', () => {
    expect(entryLiveness(entry({ state: 'completed', endedAt: new Date().toISOString() }))).toBe('ended');
    expect(entryLiveness(entry({ state: 'paused', endedAt: new Date().toISOString() }))).toBe('ended');
  });
});

describe('registry: sync-conflict files are ignored, never parsed (§4.2.1)', () => {
  it('recognises every shape §4.2.1 names', () => {
    expect(isSyncConflictName('2026-09-10-001@a1b2c3d4-DESKTOP-K2R9.json')).toBe(true);
    expect(isSyncConflictName("2026-09-10-001@a1b2c3d4 (Ada's conflicted copy 2026-09-10).json")).toBe(true);
    expect(isSyncConflictName('2026-09-10-001@a1b2c3d4.sync-conflict-20260910-120000-ABCDEFG.json')).toBe(true);
    expect(isSyncConflictName('2026-09-10-001@a1b2c3d4.json')).toBe(false);
  });

  it('skips them in runs/ without reading them, and does not reap them', async () => {
    const real = entry({ state: 'completed', endedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() });
    await writeEntry(real);
    // A conflict copy carrying *valid* JSON for a second run: if the name were not enough, this one would be
    // listed as a run of its own, with a heartbeat that was true on another machine at another time.
    const copies = [
      await putRaw(runsDir(home), `${real.key}-DESKTOP-K2R9.json`, JSON.stringify(entry({ runId: '2026-09-10-999' }))),
      await putRaw(runsDir(home), `${real.key} (Ada's conflicted copy 2026-09-10).json`, '{ this is not json'),
      await putRaw(runsDir(home), `${real.key}.sync-conflict-20260910-120000-ABCDEFG.json`, '{ nor is this'),
    ];

    expect((await listEntries()).map((e) => e.key)).toEqual([real.key]);
    await reap(DEFAULT_RETAIN_DAYS);
    expect(await listEntries()).toEqual([]);
    for (const copy of copies) expect(await fs.stat(copy).then(() => true)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('skips them in presence/ too', async () => {
    await putRaw(presenceDir(home), '24188.json', JSON.stringify(presence()));
    await putRaw(presenceDir(home), '24188-DESKTOP-K2R9.json', JSON.stringify(presence({ pid: 99 })));
    expect((await listPresence()).map((p) => p.pid)).toEqual([24188]);
  });
});

describe('registry: home safety (§4.2.1, §11.2)', () => {
  const checks = (over: Partial<HomeChecks> = {}): HomeChecks => ({
    platform: 'win32',
    env: {},
    exists: () => false,
    modeOf: () => null,
    isNetworkDrive: () => false,
    ...over,
  });

  it('refuses a UNC path, with a reason', () => {
    expect(homeRefusal('\\\\server\\share\\cao', checks())).toBe('it is a UNC path');
    expect(homeRefusal('//server/share/cao', checks({ platform: 'linux' }))).toBe('it is a UNC path');
    // A UNC path of its own: `assertSafeHome` warns once per home directory per process (§5.1), and the
    // end-to-end case below spends the one for the home it uses.
    expect(() => assertSafeHome('\\\\nas\\share\\cao', checks())).toThrow(/UNC path/);
  });

  it('refuses a network-mapped drive, and only because the drive is remote', () => {
    expect(homeRefusal('Z:\\cao', checks({ isNetworkDrive: () => true }))).toBe('it is on network drive Z:');
    expect(homeRefusal('Z:\\cao', checks({ isNetworkDrive: () => false }))).toBeNull();
    // The probe is a Windows one; on POSIX a drive letter is just a directory name.
    expect(homeRefusal('Z:/cao', checks({ platform: 'linux', isNetworkDrive: () => true }))).toBeNull();
  });

  it('refuses a directory inside a detectable sync root', async () => {
    const root = await tmpDir('cao-registry-sync-');
    const inOneDrive = path.join(root, 'OneDrive - Contoso', 'dotfiles', '.cao');
    expect(homeRefusal(inOneDrive, checks())).toMatch(/inside a OneDrive folder/);
    expect(homeRefusal(path.join(root, 'Dropbox', '.cao'), checks())).toMatch(/inside a Dropbox folder/);

    // A marker file, for a sync root whose directory is named anything at all.
    const synced = path.join(root, 'sync');
    await fs.mkdir(synced, { recursive: true });
    await fs.writeFile(path.join(synced, '.dropbox'), '', 'utf8');
    expect(homeRefusal(path.join(synced, '.cao'), systemHomeChecks)).toMatch(/inside a Dropbox folder/);

    // And OneDrive says where it is, so the check does not have to guess from a directory name.
    const moved = path.join(root, 'Redirected');
    expect(homeRefusal(path.join(moved, '.cao'), checks({ env: { OneDrive: moved } }))).toMatch(/inside a OneDrive folder/);
  });

  it('refuses a group- or world-accessible home on POSIX, and does not try on Windows', () => {
    expect(homeRefusal('/home/ada/.cao', checks({ platform: 'linux', modeOf: () => 0o40755 }))).toMatch(/not owner-only \(mode 0755/);
    expect(homeRefusal('/home/ada/.cao', checks({ platform: 'linux', modeOf: () => 0o40700 }))).toBeNull();
    // `stat().mode` is a fiction on NTFS, which is why §4.2.1 is about path shape on this platform.
    expect(homeRefusal('C:\\Users\\ada\\.cao', checks({ platform: 'win32', modeOf: () => 0o40777 }))).toBeNull();
  });

  it('refuses through CAO_HOME end to end, warning once and failing nothing', async () => {
    process.env.CAO_HOME = '\\\\server\\share\\cao';
    expect(caoHome()).toBe('\\\\server\\share\\cao');
    await writeEntry(entry());
    await writeEntry(entry({ runId: '2026-09-10-002' }));
    await writeConfig({ protocol: PROTOCOL_VERSION, emit: true, retainDays: 14 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/UNC path/);
    expect(await listEntries()).toEqual([]);
  });

  it('creates the home owner-only on POSIX', async () => {
    await writeEntry(entry());
    expect(warnings).toEqual([]);
    if (process.platform === 'win32') {
      // `fs.mkdir(mode)` is a no-op here; the directory inherits the per-user profile ACL, unwidened.
      expect(statSync(home).isDirectory()).toBe(true);
      return;
    }
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(runsDir(home)).mode & 0o777).toBe(0o700);
  });
});

describe('registry: best effort (§5.1)', () => {
  it('warns once for a CAO_HOME it cannot write, and does not fail the run', async () => {
    const blocked = await tmpDir('cao-registry-readonly-');
    await fs.writeFile(path.join(blocked, 'wall'), 'not a directory', 'utf8');
    process.env.CAO_HOME = path.join(blocked, 'wall', '.cao');

    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n', { gitRoot: process.cwd() });
    const run = makeRun(workflow, '2026-09-10-003');
    const scheduler = new WorkflowScheduler({
      run,
      store: new MemoryRunStore(),
      runners: new RunnerRegistry().register(new MockRunner()),
      workspace: new MockWorkspace(workflow.repositoryRoot),
      bus: new WorkflowEventBus(run.runId),
      emit: { capabilities: CAPABILITIES },
    });

    const result = await scheduler.execute();
    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not write a registry entry/);
  });

  it('is silent and empty on a home that does not exist yet', async () => {
    expect(await listEntries()).toEqual([]);
    expect(await listPresence()).toEqual([]);
    expect(await hasFreshPresence()).toBe(false);
    expect(await readConfig()).toEqual({ protocol: PROTOCOL_VERSION, emit: false, retainDays: DEFAULT_RETAIN_DAYS });
    expect(warnings).toEqual([]);
  });

  it('skips a malformed entry rather than failing the list', async () => {
    await writeEntry(entry());
    await putRaw(runsDir(home), 'garbage.json', '{ not json');
    await putRaw(runsDir(home), 'wrong-shape.json', JSON.stringify({ hello: 'world' }));
    expect(await listEntries()).toHaveLength(1);
  });
});

describe('registry: config.json (§4.2.6)', () => {
  it('preserves unknown keys on rewrite, so a newer cao and an older one can share the file', async () => {
    await putRaw(home, 'config.json', JSON.stringify({ protocol: 1, emit: false, retainDays: 30, notifications: { sound: true } }));
    const config = await readConfig();
    expect(config.retainDays).toBe(30);
    await writeConfig({ ...config, emit: true });

    const rewritten = JSON.parse(await fs.readFile(configFile(home), 'utf8')) as Record<string, unknown>;
    expect(rewritten).toEqual({ protocol: PROTOCOL_VERSION, emit: true, retainDays: 30, notifications: { sound: true } });
    expect(Object.keys(rewritten)[0]).toBe('protocol');
  });

  it('falls back to the defaults for a value it cannot use, and warns once about a file it cannot parse', async () => {
    await putRaw(home, 'config.json', JSON.stringify({ emit: 'yes please', retainDays: -4 }));
    expect(await readConfig()).toMatchObject({ emit: false, retainDays: DEFAULT_RETAIN_DAYS });

    await putRaw(home, 'config.json', '{ truncated');
    expect(await readConfig()).toMatchObject({ emit: false, retainDays: DEFAULT_RETAIN_DAYS });
    await readConfig();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/config\.json/);
  });
});

describe('registry: the switch (§4.2.7)', () => {
  it('takes the flag over the environment over config.json over off', async () => {
    expect(await emitSetting(undefined, {})).toEqual({ enabled: false, source: 'default' });

    await writeConfig({ protocol: PROTOCOL_VERSION, emit: true, retainDays: 14 });
    expect(await emitSetting(undefined, {})).toEqual({ enabled: true, source: 'config' });
    expect(await emitSetting(undefined, { CAO_EMIT: '0' })).toEqual({ enabled: false, source: 'env' });
    expect(await emitSetting(false, { CAO_EMIT: '1' })).toEqual({ enabled: false, source: 'flag' });

    await writeConfig({ protocol: PROTOCOL_VERSION, emit: false, retainDays: 14 });
    expect(await emitEnabled(undefined, {})).toBe(false);
    expect(await emitEnabled(undefined, { CAO_EMIT: '1' })).toBe(true);
    expect(await emitEnabled(true, { CAO_EMIT: '0' })).toBe(true);
  });
});

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

describe('registry: presence (§4.6.1)', () => {
  it('lists only files that are fresh and from this machine', async () => {
    await putRaw(presenceDir(home), '1.json', JSON.stringify(presence({ pid: 1 })));
    await putRaw(presenceDir(home), '2.json', JSON.stringify(presence({ pid: 2, heartbeatAt: new Date(Date.now() - 90_000).toISOString() })));
    await putRaw(presenceDir(home), '3.json', JSON.stringify(presence({ pid: 3, machine: { hostname: 'OTHER-BOX', platform: 'linux', arch: 'x64' } })));

    expect((await listPresence()).map((p) => p.pid)).toEqual([1]);
    expect(await hasFreshPresence()).toBe(true);
  });

  it('has no fresh presence once every file has gone quiet for 60 s', async () => {
    await putRaw(presenceDir(home), '1.json', JSON.stringify(presence({ heartbeatAt: new Date(Date.now() - 61_000).toISOString() })));
    expect(await hasFreshPresence()).toBe(false);
  });
});
