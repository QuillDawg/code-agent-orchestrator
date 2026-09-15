// spec.md §4.2.6, §4.2.7, §4.6, §5.4 — `cao emit enable | disable | status`.
/**
 * The persisted row of §4.2.7's precedence table, and the command that explains the other three.
 *
 * §5.4 says what `status` is for, and it is worth quoting because it decides the output: it is *"the first
 * thing to ask for when the app shows an empty window, or when a prompt is being denied that the user
 * expected to be asked about."* Both of those are questions about a chain — the setting, the row that set it,
 * the directory it writes to, whether that directory is usable, what is in it, and who is listening — and a
 * reader who can only see the end of the chain has to guess at the rest. So `status` prints all of it, and
 * then says in one sentence what to do about the state it found.
 */
import { PROTOCOL_VERSION, type PresenceFile } from 'code-agent-orchestrator-protocol';
import {
  caoHome,
  configFile,
  emitSetting,
  entryLiveness,
  homeRefusal,
  listEntries,
  listPresence,
  readConfig,
  writeConfig,
  type EmitSource,
} from '../../persistence/registry.js';
import { formatAge } from '../../util/duration.js';
import { OrchestratorError, UsageError } from '../../util/errors.js';
import { okLine, warnLine } from '../../util/marks.js';

export const EMIT_ACTIONS = ['enable', 'disable', 'status'] as const;
export type EmitAction = (typeof EMIT_ACTIONS)[number];

export interface EmitCommandOptions {
  json?: boolean;
  /**
   * `--emit` / `--no-emit`, resolved as if a run had been given it. `status` is the chain explainer, and the
   * top row of the chain is the one a reader is most likely to have forgotten is there — a `--no-emit` left
   * in a script is exactly the *"prompt being denied that the user expected to be asked about"* §5.4 names.
   * It is a question, never a setting: only `enable` and `disable` write anything.
   */
  emit?: boolean;
}

/** What `status` found, and what `--json` prints. Everything the §5.4 diagnosis needs, in one object. */
export interface EmitStatus {
  protocol: number;
  emit: boolean;
  /** Which row of §4.2.7 decided it. */
  source: EmitSource;
  /** The resolved `~/.cao`, in this platform's own spelling — it is a path the reader may have to type. */
  home: string;
  /** Whether `home` passed the §4.2.1 path-shape check. Nothing is announced when it did not. */
  homeUsable: boolean;
  /** Why not, in the same words the refusal warns with, or null when it is usable. */
  homeRefusal: string | null;
  runs: { live: number; retained: number; stale: number; unknown: number; total: number };
  surfaces: Array<{ pid: number; surface: string; heartbeatAt: string; understands: string[] }>;
}

/** The sentence beside the setting: which row of the precedence table it came from (§4.2.7). */
const SOURCE_TEXT: Record<EmitSource, string> = {
  flag: '--emit / --no-emit on the command line',
  env: 'CAO_EMIT in the environment',
  config: 'cao emit enable, in config.json',
  default: 'the default — announcing is opt-in',
};

export async function readEmitStatus(flag?: boolean): Promise<EmitStatus> {
  const home = caoHome();
  const refusal = homeRefusal(home);
  const decision = await emitSetting(flag);
  // A refused home is never read from either: `listEntries` would return nothing anyway, and reading a
  // directory this process has just refused to trust is not a thing to do for a nicer number (§11.2).
  const entries = refusal === null ? await listEntries() : [];
  const surfaces = refusal === null ? await listPresence() : [];
  const liveness = entries.map((entry) => entryLiveness(entry));
  const live = liveness.filter((l) => l === 'running').length;
  return {
    protocol: PROTOCOL_VERSION,
    emit: decision.enabled,
    source: decision.source,
    home,
    homeUsable: refusal === null,
    homeRefusal: refusal,
    runs: {
      live,
      retained: entries.length - live,
      stale: liveness.filter((l) => l === 'stale').length,
      unknown: liveness.filter((l) => l === 'unknown').length,
      total: entries.length,
    },
    surfaces: surfaces.map((p: PresenceFile) => ({
      pid: p.pid,
      surface: p.surface,
      heartbeatAt: p.heartbeatAt,
      understands: [...p.understands],
    })),
  };
}

const LABEL_WIDTH = 10;
const row = (label: string, value: string): string => `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;

/** The §5.4 block: the setting, its source, the home and its verdict, the entry counts, and who is present. */
export function emitStatusLines(status: EmitStatus, now = Date.now()): string[] {
  const { runs } = status;
  const qualifiers = [runs.stale ? `${runs.stale} stale` : '', runs.unknown ? `${runs.unknown} from another machine` : ''].filter(Boolean);
  const lines = [
    row('Emit', `${status.emit ? 'on' : 'off'}  (${SOURCE_TEXT[status.source]})`),
    row('Home', `${status.home}  ${status.homeUsable ? 'usable' : `REFUSED: ${status.homeRefusal}`}`),
    row('Runs', `${runs.live} live, ${runs.retained} retained${qualifiers.length ? ` (${qualifiers.join(', ')})` : ''}`),
    row(
      'Surfaces',
      status.surfaces.length
        ? status.surfaces.map((s) => `${s.surface} (pid ${s.pid}, ${formatAge(s.heartbeatAt, now)})`).join('; ')
        : 'none present',
    ),
    '',
  ];

  // Then the one sentence that says what this state means, for the two moments §5.4 names.
  if (!status.homeUsable) {
    lines.push(
      warnLine(`Nothing is announced: ${status.home} cannot be used because ${status.homeRefusal}.`),
      '  Point CAO_HOME at a local, owner-only directory that nothing syncs, or unset it to fall back to ~/.cao.',
    );
  } else if (!status.emit) {
    lines.push(
      'Runs are not announced, so a desktop app on this machine cannot see them.',
      '  Turn it on for this user with: cao emit enable      for one run with: cao run --emit',
    );
  } else if (status.surfaces.length === 0) {
    lines.push(
      'Runs are announced, but no surface is present to read them.',
      '  A run with nobody listening behaves exactly as it does with emit off, so a prompt is still denied without being asked.',
    );
  } else {
    lines.push(okLine(`Runs are announced and ${status.surfaces.length === 1 ? 'a surface is' : `${status.surfaces.length} surfaces are`} watching.`));
  }
  return lines;
}

/**
 * `enable` and `disable` are **not** best-effort, and that is deliberate. Every registry write on a run's
 * path swallows its errors, because announcing must never fail a run (§5.1) — but a command whose entire job
 * is to write `config.json` and that silently wrote nothing is the empty-window bug §5.4 exists to diagnose,
 * arriving one step earlier.
 */
async function setEmit(enabled: boolean): Promise<void> {
  const home = caoHome();
  const refusal = homeRefusal(home);
  if (refusal !== null) {
    throw new OrchestratorError(`Cannot write ${configFile(home)}: it ${refusal}. Point CAO_HOME at a local, owner-only directory that nothing syncs.`);
  }
  await writeConfig({ ...(await readConfig()), emit: enabled });
  // Read it back rather than trust the write: `writeConfig` is best-effort like everything else in the
  // registry, so on a read-only home it warns and returns, and only the file can say whether it took.
  const stored = await readConfig();
  if (stored.emit !== enabled) throw new OrchestratorError(`Could not write ${configFile(home)}; emit is still ${stored.emit ? 'enabled' : 'disabled'}.`);
}

export async function emitCommand(action: string | undefined, opts: EmitCommandOptions = {}): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  if (action !== undefined && !(EMIT_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown action "${action}" for cao emit; use one of ${EMIT_ACTIONS.join(', ')}`);
  }
  if (action === 'enable' || action === 'disable') {
    // Refusing beats quietly ignoring: `cao emit enable --no-emit` is someone expecting one of the two to
    // win, and neither answer is the one they meant.
    if (opts.emit !== undefined) throw new UsageError(`--emit / --no-emit ask what a run would do; they cannot be combined with cao emit ${action}`);
    await setEmit(action === 'enable');
  }

  const status = await readEmitStatus(opts.emit);
  if (opts.json) {
    out(JSON.stringify(status, null, 2));
    return 0;
  }
  if (action === 'enable') {
    out('Emit enabled for this user. Runs will announce themselves in ~/.cao/runs — a heartbeat file, and no network port.');
    // The sentence the onboarding button's one line has to be true about (§7.2, §4.6.2).
    out('Nothing else about how a run behaves changes: with no surface running it is byte-identical to emit off.');
    out('');
  } else if (action === 'disable') {
    out('Emit disabled for this user. Runs already announced keep their entries until they are reaped; nothing new is written.');
    out('');
  }
  for (const line of emitStatusLines(status)) out(line);
  return 0;
}
