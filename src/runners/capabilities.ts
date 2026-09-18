export const MINIMUM_AGENT_VERSIONS = { claude: '2.1.259', codex: '0.153.0' } as const;

/**
 * The version each vendor first shipped the steering call in (spec §7.2, `[D23]`). Below it the transport
 * simply does not exist and a follow-up falls back to stop-and-continue; it is **not** a run-blocking
 * minimum, which is why it is separate from `MINIMUM_AGENT_VERSIONS`.
 */
export const STEER_MINIMUM_VERSIONS = { codex: '0.99.0' } as const;

/**
 * The flag that makes Claude echo the user messages it was handed on stdin, which is the only
 * acknowledgment its stream-json protocol offers (spec §7.1, `[D24]`). Only ever passed when `claude --help`
 * advertises it: an older CLI rejects the whole invocation over an unknown flag.
 */
export const CLAUDE_REPLAY_USER_MESSAGES = '--replay-user-messages';

export type AgentCapability =
  | 'streamJson'
  | 'structuredOutput'
  | 'isolatedConfig'
  | 'exec'
  | 'appServer'
  | 'autoReview'
  /** Claude: `--replay-user-messages`, so a steered message can be acknowledged rather than left `queued`. */
  | 'replayUserMessages'
  /** Codex: `turn/steer` on the app-server, i.e. the CLI is at or above `STEER_MINIMUM_VERSIONS.codex`. */
  | 'steer';

export interface AgentRuntimeDetection {
  command: string;
  version?: string;
  found: boolean;
  error?: string;
  authenticated?: boolean;
  supportedVersion?: boolean;
  minimumVersion?: string;
  capabilities?: AgentCapability[];
}

function numericVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

/** Compare the first semantic-looking version in vendor-formatted output. */
export function versionAtLeast(actual: string | undefined, minimum: string): boolean | undefined {
  const have = actual ? numericVersion(actual) : undefined;
  const need = numericVersion(minimum);
  if (!have || !need) return undefined;
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }
  return true;
}
