// spec.md §4.2, §4.6.1, §5.1, §11.2 — the registry: `~/.cao`, the entry, presence and the reaper.
/**
 * The first user-level state in this codebase. Everything else in `src/` derives its paths from a repository
 * root, so a run is findable only if you already know which checkout it belongs to (§3.3). The registry is
 * the one index that does not.
 *
 * `~/.cao/runs/<key>.json` is a **pointer plus a heartbeat, never a second copy of run state.** Everything a
 * surface shows comes from the run directory the entry points at, which is exactly what keeps a stale entry
 * harmless: the run directory is always the truth.
 *
 * **Every function here is best-effort.** A read-only home directory, a full disk or a permission error warns
 * once and never fails a run (§5.1). This is announcement, not orchestration — a `cao` that cannot write
 * `~/.cao` is a `cao` the desktop app cannot see, which is the state it is in by default anyway.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  createRunPaths,
  type CapabilityToken,
  type MachineIdentity,
  type PresenceFile,
  type RegistryEntry,
  type WorkflowRun,
} from 'code-agent-orchestrator-protocol';
import { isPlainObject, isProcessAlive, nowIso, sha256 } from '../util/misc.js';
import { packageInfo } from '../util/package-info.js';
import { isInside, writeFileAtomic } from '../util/fs.js';

/** The directory under `os.homedir()`, when `CAO_HOME` does not override the whole thing (§4.2.1). */
export const CAO_DIR_NAME = '.cao';

/**
 * How long a heartbeat stays fresh. The same 60 s window as `lock.json`, `live.json` and a fresh presence
 * file (§4.2.5, §4.6.1), so there is one number to reason about rather than four.
 */
export const STALE_MS = 60_000;

/** `retainDays` when `config.json` does not say otherwise (§4.2.5). */
export const DEFAULT_RETAIN_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * POSIX only: `~/.cao` and everything under it is owner-only (§11.2). `fs.mkdir(mode)` is a no-op on Windows,
 * where the directory inherits the per-user profile ACL — which this writer must not widen, and does not.
 */
const OWNER_ONLY = 0o700;

// ---------------------------------------------------------------------------- warnings

export type RegistryWarner = (message: string) => void;

/** stdout is reserved for machine-readable output, so a registry warning goes to stderr like every other. */
let warner: RegistryWarner = (message) => process.stderr.write(`${message}\n`);

const warned = new Set<string>();

/**
 * Route registry warnings somewhere else — a run's logger, a test. Returns the sink it replaced, so a caller
 * can put the previous one back.
 */
export function setRegistryWarner(next: RegistryWarner): RegistryWarner {
  const previous = warner;
  warner = next;
  return previous;
}

/**
 * One warning per home directory per process (§5.1). A registry that cannot be written is a fact about the
 * directory, not about the call that discovered it, and a run that announces itself every 20 s would
 * otherwise turn one permission error into a screenful.
 */
function warnOnce(home: string, message: string): void {
  if (warned.has(home)) return;
  warned.add(home);
  warner(message);
}

/** Every write in this module goes through here: it warns once and returns, and never rejects. */
async function bestEffort(home: string, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    warnOnce(
      home,
      `cao could not ${what} in ${home}: ${(err as Error).message}. This run will not be announced to the desktop app.`,
    );
  }
}

// ---------------------------------------------------------------------------- location

/**
 * `CAO_HOME ?? join(homedir(), '.cao')` (§4.2.1).
 *
 * A UNC override is handed back exactly as written: `assertSafeHome` refuses it by name, and `path.resolve`
 * would first mangle `\\server\share` into a relative path on a POSIX host, leaving the refusal unable to say
 * what it refused.
 */
export function caoHome(): string {
  const override = process.env.CAO_HOME?.trim();
  if (!override) return path.join(os.homedir(), CAO_DIR_NAME);
  return isUncPath(override) ? override : path.resolve(override);
}

export function runsDir(home: string = caoHome()): string {
  return path.join(home, 'runs');
}

export function presenceDir(home: string = caoHome()): string {
  return path.join(home, 'presence');
}

export function configFile(home: string = caoHome()): string {
  return path.join(home, 'config.json');
}

/**
 * The file a key names. Keys are derived here (§4.2.2), but `removeEntry` takes one read back off disk, so
 * the shape is checked rather than trusted: a key is a run id, `@`, and eight hex characters.
 */
export function entryFile(key: string, home: string = caoHome()): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*@[0-9a-f]{8}$/.test(key)) throw new Error(`Not a registry key: "${key}"`);
  return path.join(runsDir(home), `${key}.json`);
}

function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p);
}

// ---------------------------------------------------------------------------- machine identity

export function machineIdentity(): MachineIdentity {
  return { hostname: os.hostname(), platform: process.platform, arch: process.arch };
}

/**
 * Whether a pid recorded against `other` means anything here. §4.2.3: hostname **and** platform **and** arch
 * must all match. WSL2 takes the Windows host's hostname by default, so a hostname check alone passes on a
 * pid from a different pid namespace — and the answer is a finished run reported as running, with Stop
 * buttons writing into a directory the surface cannot reach. A mismatch is the honest unknown instead.
 */
export function sameMachine(other: MachineIdentity | undefined, self: MachineIdentity = machineIdentity()): boolean {
  return (
    other !== undefined &&
    other.hostname === self.hostname &&
    other.platform === self.platform &&
    other.arch === self.arch
  );
}

// ---------------------------------------------------------------------------- the key (§4.2.2)

/**
 * The absolute path with `\` replaced by `/`, its trailing separator removed, and — on Windows and macOS
 * only — lower-cased, so that two spellings of one case-insensitive path produce one hash (§4.2.2).
 *
 * `platform` is a parameter rather than a read of `process.platform` because this derivation is a contract
 * the Rust core reimplements (§12.2), and both halves of the rule have to be provable from one CI job.
 */
export function normalizedRepositoryRoot(repositoryRoot: string, platform: string = process.platform): string {
  const slashed = repositoryRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = slashed === '' ? '/' : slashed;
  return platform === 'win32' || platform === 'darwin' ? root.toLowerCase() : root;
}

export function repositoryHash(repositoryRoot: string, platform: string = process.platform): string {
  return sha256(normalizedRepositoryRoot(repositoryRoot, platform)).slice(0, 8);
}

/**
 * `${runId}@${repoHash}` (§4.2.2). `allocateRunId` allocates `YYYY-MM-DD-NNN` unique within *one repository's*
 * runs directory, so two repositories running on the same day both produce `2026-09-10-001`; a registry keyed
 * on the run id alone silently loses one of them. `@` is legal on every target filesystem and cannot appear
 * in a run id.
 */
export function registryKey(repositoryRoot: string, runId: string, platform: string = process.platform): string {
  return `${runId}@${repositoryHash(repositoryRoot, platform)}`;
}

// ---------------------------------------------------------------------------- home safety (§4.2.1, §11.2)

/** The platform and filesystem facts a refusal is decided from, injected so every clause is testable on every OS. */
export interface HomeChecks {
  platform: string;
  env: NodeJS.ProcessEnv;
  exists(p: string): boolean;
  /** The directory's POSIX mode, or null when it does not exist or cannot be read. */
  modeOf(p: string): number | null;
  /** Windows only: whether the drive named by this letter is a `DRIVE_REMOTE` mapping. */
  isNetworkDrive(driveLetter: string): boolean;
}

/**
 * `net use X:` succeeds exactly for a drive backed by a network mapping and fails for a local one, which is
 * `GetDriveTypeW() === DRIVE_REMOTE` without native code (§4.2.1). Reached at most once per process, only on
 * Windows, and only for a `CAO_HOME` that names a drive letter.
 */
function isMappedNetworkDrive(driveLetter: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('net', ['use', `${driveLetter}:`], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const systemHomeChecks: HomeChecks = {
  platform: process.platform,
  env: process.env,
  exists: (p) => existsSync(p),
  modeOf: (p) => {
    try {
      return statSync(p).mode;
    } catch {
      return null;
    }
  },
  isNetworkDrive: isMappedNetworkDrive,
};

/**
 * Files a sync client leaves in the root of the tree it syncs. Detection is deliberately about markers and
 * path shape rather than ACLs (§4.2.1): on a single-user Windows box the profile ACL is already correct, and
 * the failure that actually happens is a home directory that is shared or synced — which §11.2 forbids and,
 * without this, nothing would notice.
 */
const SYNC_MARKERS: ReadonlyArray<{ file: string; service: string }> = [
  { file: '.dropbox', service: 'Dropbox' },
  { file: '.dropbox.cache', service: 'Dropbox' },
  { file: '.dropbox.device', service: 'Dropbox' },
  // The hidden file OneDrive writes into the root of a folder it syncs.
  { file: '.849C9593-D756-4E56-8D6E-42412F2A707B', service: 'OneDrive' },
  { file: '.tmp.driveupload', service: 'Google Drive' },
  { file: '.tmp.drivedownload', service: 'Google Drive' },
  { file: '.shortcut-targets-by-id', service: 'Google Drive' },
];

/** Directory names only a sync root has. `OneDrive - Contoso` is the business form. */
const SYNC_DIR_NAMES: ReadonlyArray<{ match: RegExp; service: string }> = [
  { match: /^onedrive( -.*)?$/i, service: 'OneDrive' },
  { match: /^dropbox$/i, service: 'Dropbox' },
  { match: /^(google ?drive|my drive)$/i, service: 'Google Drive' },
];

/** OneDrive exports its roots; being told where it is beats guessing from a directory name. */
const SYNC_ENV_VARS = ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'];

function syncRootOf(dir: string, checks: HomeChecks): { service: string; at: string } | null {
  for (const name of SYNC_ENV_VARS) {
    const root = checks.env[name]?.trim();
    if (root && isInside(root, dir)) return { service: 'OneDrive', at: root };
  }
  let current = path.resolve(dir);
  for (;;) {
    const named = SYNC_DIR_NAMES.find((s) => s.match.test(path.basename(current)));
    if (named) return { service: named.service, at: current };
    const marker = SYNC_MARKERS.find((m) => checks.exists(path.join(current, m.file)));
    if (marker) return { service: marker.service, at: current };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Why this directory may not be used as `CAO_HOME`, or null when it may (§4.2.1). Separate from
 * `assertSafeHome` because `cao emit status` reports whether the home passed the shape check, and a status
 * command should not have to catch an exception to find out.
 */
export function homeRefusal(dir: string, checks: HomeChecks = systemHomeChecks): string | null {
  if (isUncPath(dir)) return 'it is a UNC path';
  const drive = /^([A-Za-z]):[\\/]/.exec(dir);
  if (checks.platform === 'win32' && drive && checks.isNetworkDrive(drive[1]!.toUpperCase())) {
    return `it is on network drive ${drive[1]!.toUpperCase()}:`;
  }
  const synced = syncRootOf(dir, checks);
  if (synced) return `it is inside a ${synced.service} folder (${synced.at})`;
  if (checks.platform !== 'win32') {
    // §4.2.1 spells this clause `mode & 0o077`: owner-only, not merely not-group-writable. `0700` is what
    // this module creates, and anything looser is a home another account can read a request file out of.
    const mode = checks.modeOf(dir);
    if (mode !== null && (mode & 0o077) !== 0) {
      return `it is not owner-only (mode ${(mode & 0o777).toString(8).padStart(4, '0')}, wanted 0700)`;
    }
  }
  return null;
}

/** Decided once per directory (§4.2.1): this is about path shape, which does not change under a process. */
const refusals = new Map<string, string | null>();

/**
 * Refuse a `CAO_HOME` that is shared, synced or reachable by another account (§4.2.1, §11.2). Whatever can
 * write a request file can approve a tool call in a process that runs arbitrary commands, so the home
 * directory is the trust boundary and its shape is checked before anything is written into it.
 *
 * Throws every time it is called, with the reason; warns once, because callers here are best-effort.
 */
export function assertSafeHome(dir: string, checks: HomeChecks = systemHomeChecks): void {
  let reason = refusals.get(dir);
  if (reason === undefined) {
    reason = homeRefusal(dir, checks);
    refusals.set(dir, reason);
  }
  if (reason === null) return;
  warnOnce(
    dir,
    `cao is not announcing runs: ${dir} cannot be used as CAO_HOME because ${reason}. ` +
      'It must be a local, owner-only directory that nothing syncs.',
  );
  throw new Error(`CAO_HOME is not usable: ${reason}`);
}

async function ensureOwnerOnlyDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: OWNER_ONLY });
}

// ---------------------------------------------------------------------------- reading a directory of files

/**
 * §4.2.1 — a synced directory produces conflict copies, and they are **ignored, never parsed**. A conflict
 * copy of a registry entry is a second pointer to the same run carrying a heartbeat that was true on another
 * machine at another time; parsing it is how a run gets listed twice, or reaped on someone else's clock.
 */
const SYNC_CONFLICT_NAMES: readonly RegExp[] = [
  /-DESKTOP-[^\\/]*\.json$/i, // OneDrive: `<name>-DESKTOP-K2R9.json`
  / \([^)]*conflicted copy[^)]*\)\.json$/i, // Dropbox: `<name> (Ada's conflicted copy 2026-09-10).json`
  /\.sync-conflict-/i, // Syncthing
];

export function isSyncConflictName(name: string): boolean {
  return SYNC_CONFLICT_NAMES.some((pattern) => pattern.test(name));
}

/**
 * Every `.json` in a directory that parses and passes `guard`. A missing directory is the normal state of a
 * home with no runs yet, not a failure, so it is silently empty rather than a warning.
 */
type Found<T> = Array<{ file: string; value: T }>;

async function readAll<T>(dir: string, guard: (value: unknown) => value is T): Promise<Found<T>> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Array<{ file: string; value: T }> = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || isSyncConflictName(name)) continue;
    const file = path.join(dir, name);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (guard(parsed)) out.push({ file, value: parsed });
  }
  return out;
}

function isMachineIdentity(value: unknown): value is MachineIdentity {
  return (
    isPlainObject(value) &&
    typeof value.hostname === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.arch === 'string'
  );
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return (
    isPlainObject(value) &&
    typeof value.key === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.repositoryRoot === 'string' &&
    typeof value.state === 'string' &&
    typeof value.heartbeatAt === 'string' &&
    typeof value.pid === 'number' &&
    isMachineIdentity(value.machine)
  );
}

function isPresenceFile(value: unknown): value is PresenceFile {
  return (
    isPlainObject(value) &&
    typeof value.pid === 'number' &&
    typeof value.surface === 'string' &&
    typeof value.heartbeatAt === 'string' &&
    isMachineIdentity(value.machine)
  );
}

function isFresh(iso: string, now: number): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at < STALE_MS;
}

// ---------------------------------------------------------------------------- the entry (§4.2.3)

/** `protocol` first, and always this writer's version: every file across the boundary is stamped (§4.5). */
function stamped(entry: RegistryEntry): RegistryEntry {
  const { protocol: _written, ...rest } = entry;
  return { protocol: PROTOCOL_VERSION, ...rest };
}

/** `\` → `/`, leaving case alone: the key lower-cases to collapse spellings, a path a human reads must not. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export interface AnnounceOptions {
  /**
   * What this run **actually wired up** at run start, not what this version could in principle do (§4.2.3).
   * A run whose inbox failed to start does not claim it can answer.
   */
  capabilities: CapabilityToken[];
  /** Set only when `feed` is among `capabilities` (§10.1). */
  feedUrl?: string | null;
  cliVersion?: string;
  pid?: number;
}

/**
 * The §4.2.3 entry for a run as it stands right now — a pointer plus a heartbeat, and nothing that is a
 * second copy of run state.
 *
 * Paths are `/`-joined, as §4.2.3's own example writes them: this file is read from Rust and from the browser
 * side of the app, where the run-directory layout is `/`-joined too (§4.1). `exitCode` is reported only
 * beside an `endedAt`, because a resumed run keeps the exit code of the attempt before it until it finalizes
 * again, and an entry that said `running` next to `exit 3` would be read as a contradiction.
 */
export function entryForRun(run: WorkflowRun, options: AnnounceOptions, at: string = nowIso()): RegistryEntry {
  const repositoryRoot = toPosix(run.repositoryRoot);
  const endedAt = run.endedAt ?? null;
  return {
    protocol: PROTOCOL_VERSION,
    key: registryKey(run.repositoryRoot, run.runId),
    runId: run.runId,
    repositoryRoot,
    orchestratorDir: createRunPaths(repositoryRoot).root,
    workflowName: run.workflowName,
    configPath: toPosix(run.configPath),
    machine: machineIdentity(),
    pid: options.pid ?? process.pid,
    cliVersion: options.cliVersion ?? packageInfo().version,
    state: run.state,
    startedAt: run.startedAt ?? run.createdAt,
    heartbeatAt: at,
    endedAt,
    exitCode: endedAt === null ? null : (run.exitCode ?? null),
    taskCount: run.workflow.tasks.length,
    capabilities: [...options.capabilities],
    feedUrl: options.feedUrl ?? null,
  };
}

/** Atomically (temp + rename, as `writeFileAtomic` already does) and best-effort. §4.2.4. */
export async function writeEntry(entry: RegistryEntry): Promise<void> {
  const home = caoHome();
  await bestEffort(home, 'write a registry entry', async () => {
    assertSafeHome(home);
    const file = entryFile(entry.key, home);
    await ensureOwnerOnlyDir(path.dirname(file));
    await writeFileAtomic(file, JSON.stringify(stamped(entry), null, 2));
  });
}

export async function removeEntry(key: string): Promise<void> {
  const home = caoHome();
  await bestEffort(home, 'remove a registry entry', async () => {
    await fs.rm(entryFile(key, home), { force: true });
  });
}

/**
 * Every entry in `~/.cao/runs`, conflict copies skipped rather than parsed (§4.2.1).
 *
 * Entries from another machine are **returned, not dropped**: §4.2.5 shows them with an unknown liveness
 * badge and no control affordances, which is what `entryLiveness` decides. Dropping them here would lose the
 * "which repositories do I have runs in" answer the retained entry exists to give (§4.2.4).
 */
export async function listEntries(): Promise<RegistryEntry[]> {
  return (await readAll(runsDir(caoHome()), isRegistryEntry)).map((found) => found.value);
}

// ---------------------------------------------------------------------------- liveness and reaping (§4.2.5)

/**
 * §4.2.5. `stale` is the orchestrator that died without saving — shown as stale, offered `cao resume`, and
 * **not deleted**. `unknown` is a run this machine cannot ask about at all, which is the honest answer rather
 * than a wrong one (§4.2.3).
 */
export type EntryLiveness = 'running' | 'stale' | 'ended' | 'unknown';

export function entryLiveness(
  entry: RegistryEntry,
  now: number = Date.now(),
  self: MachineIdentity = machineIdentity(),
): EntryLiveness {
  if (entry.state !== 'running' && entry.state !== 'created') return 'ended';
  if (!sameMachine(entry.machine, self)) return 'unknown';
  return isFresh(entry.heartbeatAt, now) && isProcessAlive(entry.pid) ? 'running' : 'stale';
}

function isExpired(entry: RegistryEntry, cutoff: number, now: number, self: MachineIdentity): boolean {
  switch (entryLiveness(entry, now, self)) {
    case 'ended': {
      // §4.2.5 clause 1 — `terminal state && endedAt < now - retainDays`. `paused` counts: `finalize()` sets
      // `endedAt` for a paused run too, and a state that satisfies neither clause is the tombstone clause 2
      // exists to eliminate. An ended entry with no `endedAt` at all falls back to its last heartbeat, for
      // the same reason.
      const at = Date.parse(entry.endedAt ?? entry.heartbeatAt);
      return Number.isFinite(at) && at < cutoff;
    }
    case 'stale': {
      // §4.2.5 clause 2 — `stale && heartbeatAt < now - retainDays`. A hard-killed orchestrator (`taskkill
      // /F`, a laptop dying on battery) leaves `state: 'running'` and `endedAt: null` forever; with only
      // clause 1 that entry is permanently stale and never expired, rendering in the landing view offering
      // `cao resume` for a checkout that may no longer exist.
      return Date.parse(entry.heartbeatAt) < cutoff;
    }
    default:
      // `running` is alive and `unknown` belongs to a machine that is not this one's to collect (§10.4).
      return false;
  }
}

/**
 * Both expiry clauses (§4.2.5). Deletes **pointers, never run directories**: an expired run is unlisted, not
 * lost. Every error is swallowed — reaping is opportunistic and must never fail a run.
 */
export async function reap(retainDays: number, now: number = Date.now()): Promise<void> {
  try {
    const cutoff = now - Math.max(0, retainDays) * DAY_MS;
    const self = machineIdentity();
    for (const { file, value } of await readAll(runsDir(caoHome()), isRegistryEntry)) {
      // A newer `cao` may mean something by fields this version cannot see. §4.5 says notice and refuse
      // rather than guess, and what guessing costs here is a deleted pointer.
      if (typeof value.protocol === 'number' && value.protocol > PROTOCOL_VERSION) continue;
      if (!isExpired(value, cutoff, now, self)) continue;
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  } catch {
    /* §4.2.5: reaping is best-effort and must never fail a run */
  }
}

// ---------------------------------------------------------------------------- config.json (§4.2.6)

export interface EmitConfig {
  protocol: number;
  /** Set by `cao emit enable` / `cao emit disable` (§4.2.7). */
  emit: boolean;
  /** How long a pointer is retained after its run ends, in days (§4.2.5). */
  retainDays: number;
  /** Unknown keys are preserved on rewrite, so a newer `cao` and an older one can share the file (§4.2.6). */
  [key: string]: unknown;
}

/** The raw record, so `emitSetting` can tell "the file says off" from "the file does not say". */
async function storedConfig(): Promise<Record<string, unknown>> {
  const home = caoHome();
  const text = await fs.readFile(configFile(home), 'utf8').catch(() => null);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    warnOnce(home, `cao could not read ${configFile(home)}: ${(err as Error).message}. Using defaults.`);
    return {};
  }
}

/** A retention a reader can act on; anything else is the default, never a crash or an instant reap. */
function usableRetainDays(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETAIN_DAYS;
}

export async function readConfig(): Promise<EmitConfig> {
  const stored = await storedConfig();
  return {
    // Spread first so unknown keys survive in the order the file had them (§4.2.6); the three known keys are
    // then replaced in place, which is what `writeConfig` writes back.
    ...stored,
    protocol: typeof stored.protocol === 'number' ? stored.protocol : PROTOCOL_VERSION,
    emit: typeof stored.emit === 'boolean' ? stored.emit : false,
    retainDays: usableRetainDays(stored.retainDays),
  };
}

export async function writeConfig(config: EmitConfig): Promise<void> {
  const home = caoHome();
  await bestEffort(home, 'write config.json', async () => {
    assertSafeHome(home);
    await ensureOwnerOnlyDir(home);
    const { protocol: _written, ...rest } = config;
    await writeFileAtomic(configFile(home), JSON.stringify({ protocol: PROTOCOL_VERSION, ...rest }, null, 2));
  });
}

// ---------------------------------------------------------------------------- the switch (§4.2.7)

export type EmitSource = 'flag' | 'env' | 'config' | 'default';

export interface EmitDecision {
  enabled: boolean;
  /** Which row of §4.2.7's precedence table decided it. `cao emit status` prints this. */
  source: EmitSource;
}

/** The spelling `CAO_ASCII`, `CAO_UNICODE` and `CAO_DEBUG` already use for a falsy environment flag. */
const OFF = new Set(['', '0', 'false', 'no', 'off']);

/**
 * §4.2.7 in precedence order: the per-invocation flag, then `CAO_EMIT`, then the persisted opt-in in
 * `config.json`, then off. Off is the default and stays the default: emit is what makes a run visible to
 * this machine's desktop app, and nothing else about the run changes with it.
 */
export async function emitSetting(flag?: boolean, env: NodeJS.ProcessEnv = process.env): Promise<EmitDecision> {
  if (flag !== undefined) return { enabled: flag, source: 'flag' };
  const raw = env.CAO_EMIT;
  if (raw !== undefined) return { enabled: !OFF.has(raw.trim().toLowerCase()), source: 'env' };
  const stored = await storedConfig();
  if (typeof stored.emit === 'boolean') return { enabled: stored.emit, source: 'config' };
  return { enabled: false, source: 'default' };
}

export async function emitEnabled(flag?: boolean, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await emitSetting(flag, env)).enabled;
}

// ---------------------------------------------------------------------------- presence (§4.6)

/**
 * The surfaces live on this machine right now (§4.6.1). Read-only from `cao`'s side: only a surface writes
 * one of these.
 *
 * A file whose `machine` does not match is ignored entirely — a pid from another pid namespace is not
 * something `isProcessAlive` can answer, and a surface that cannot be reached cannot answer a prompt either.
 * Freshness is the 60 s window alone and deliberately not a liveness check: §4.6.3's grace window is what
 * makes a Tauri auto-update survivable, and a crashed app's file expiring on its own is the design.
 */
export async function listPresence(now: number = Date.now()): Promise<PresenceFile[]> {
  const self = machineIdentity();
  const found = await readAll(presenceDir(caoHome()), isPresenceFile);
  return found.map((f) => f.value).filter((p) => sameMachine(p.machine, self) && isFresh(p.heartbeatAt, now));
}

/** The `canInteract` half of §4.6.2: `emit is on && some fresh presence exists on this machine`. */
export async function hasFreshPresence(now: number = Date.now()): Promise<boolean> {
  return (await listPresence(now)).length > 0;
}
