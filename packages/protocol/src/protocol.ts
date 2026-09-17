/**
 * The versioned contract itself. Spec §4: every file either side writes across the boundary carries
 * `"protocol": 1` as its first field, and a reader that sees a higher major degrades or refuses explicitly.
 */

/** Spec §4. Bumped only when a reader of the previous major can no longer make sense of what is written. */
export const PROTOCOL_VERSION = 1;

/**
 * The `protocol` field as it appears on a file being *read*.
 *
 * Deliberately `number`, not `typeof PROTOCOL_VERSION`: these are shapes parsed off disk, possibly written by
 * a newer `cao` or a newer app, and §4.5 requires a reader to notice a higher major and say so rather than
 * open a blank window. A writer sets it to `PROTOCOL_VERSION`.
 */
export type ProtocolVersion = number;

/**
 * Which machine a pid means. Spec §4.2.3: a bare hostname does not identify a machine — WSL2 takes the
 * Windows host's hostname by default, so a pid from a different pid namespace would pass a hostname check.
 * `isProcessAlive(pid)` is meaningful only when hostname *and* platform *and* arch all match.
 */
export interface MachineIdentity {
  hostname: string;
  /** `process.platform` in Node; the same spelling from Rust (`win32`, `darwin`, `linux`). */
  platform: string;
  arch: string;
}

/**
 * What an orchestrator can do, and what a surface knows how to ask for. Spec §4.2.3: not a boolean and not a
 * version range — the things the app needs to know ship across three phases, and `cliVersion` gating puts a
 * hand-maintained table in the app that is wrong the first time a capability lands in a patch release.
 *
 * The orchestrator writes the list from what it actually wired up at run start, so a run whose inbox failed
 * to start does not claim it can answer.
 */
export const CAPABILITIES = [
  /** Polls `requests/` for control requests (§4.3). */
  'requests',
  /** Accepts a `stop` request — the graceful interrupt (§4.3.3). */
  'stop',
  /** Accepts a `kill` request — the named escalation, never inferred from two clicks (§4.3.3). */
  'kill',
  /** Resolves an open interaction named by its uid (§4.4.1). */
  'answer',
  /** Resolves a pending approval gate, and its `reject` counterpart (§4.3.3). */
  'approve',
  /** Accepts a `restart` request for a task (§4.3.3). */
  'restart',
  /** Applies an `edit` to an unfinished task (spec §3.4). Advertised once the controller applies one. */
  'edit',
  /** Delivers a `prompt` to a task's worker (spec §3.5). Advertised once the controller applies one. */
  'prompt',
  /** Writes pending-interaction payloads to `interactions/<uid>.json` (§4.4.2). */
  'interactions',
  /** Reads `~/.cao/presence/` and gates `canInteract` on it (§4.6). */
  'presence',
  /** Serves the in-process HTTP + SSE feed named by `feedUrl` (§10.1). */
  'feed',
] as const;

/** A capability this version knows about. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * A capability token as it appears on the wire. Open by §4.5: each side **ignores tokens it does not know**,
 * the same forward-compatible rule that applies to unknown enum members, so a newer peer advertising a
 * capability this version has never heard of is read without complaint.
 */
export type CapabilityToken = Capability | (string & {});

/**
 * `protocol` first, and always this writer's version. Spec §4: every file either side writes across the
 * boundary carries `"protocol": 1` **as its first field** — registry entries, request files, interaction
 * payloads and presence files alike.
 *
 * First is not decoration. A reader that has to parse the whole object before it can tell whether it
 * understands the object has already done the thing §4.5 forbids, and a human running `head` on a file in
 * `~/.cao` should see the version before anything it governs. `JSON.stringify` preserves insertion order for
 * string keys, so putting it first here is what puts it first on disk.
 *
 * Any `protocol` already on the value is replaced rather than trusted: a shape read off disk, edited and
 * written back is written by *this* build, and says so.
 */
export function stamp<T extends { protocol: ProtocolVersion }>(value: T): T {
  const { protocol: _replaced, ...rest } = value;
  return { protocol: PROTOCOL_VERSION, ...rest } as T;
}

/**
 * Whether something read off disk was written by a **newer major than this build understands** (§4.5).
 *
 * The rule either side applies to one is to degrade or refuse *explicitly* and say so — never to guess at
 * it, and never to silently drop it. What guessing costs differs by file (a reaped pointer, a request
 * answered with the wrong semantics), which is why the predicate is shared and the reaction is not.
 */
export function isFutureProtocol(value: unknown): boolean {
  const protocol = (value as { protocol?: unknown } | null | undefined)?.protocol;
  return typeof protocol === 'number' && protocol > PROTOCOL_VERSION;
}
