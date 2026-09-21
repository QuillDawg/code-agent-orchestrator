/**
 * Which of the workspace's controls each installed CLI can actually carry (spec §3.7, `[D23]`, `[D24]`).
 *
 * Steering a running turn, acknowledging a follow-up and reading a quota are not run-blocking: below the
 * version that has them the orchestrator falls back to stop-and-continue, leaves a delivery `queued`, or
 * shows no numbers. All three are silent degradations, which is exactly what `cao doctor` exists to name.
 *
 * The same seam as `src/runners/diagnostics.ts`: the per-agent knowledge is here and `cao doctor` renders a
 * `ControlSupport` without ever naming a CLI. Nothing here starts a process — it judges the detection the
 * preflight already did.
 */
import { CLAUDE_REPLAY_USER_MESSAGES, STEER_MINIMUM_VERSIONS, versionAtLeast } from './capabilities.js';
import { CODEX_QUOTA_MINIMUM_VERSION } from './codex/quota.js';
import type { AgentDetection } from './diagnostics.js';

export interface ControlSupport {
  /** The agent's name, for the label only; nothing above this file branches on it. */
  agent: string;
  /** The control in the words the workspace uses for it. */
  control: string;
  /** `false` is a degradation to report; `undefined` is "the CLI did not say", which grades nothing. */
  supported: boolean | undefined;
  /** The evidence, and what happens without it. */
  detail: string;
  /** The upgrade that would provide it; only ever set when `supported` is `false`. */
  hint?: string;
}

/** What to run to get a newer CLI. Named per agent because there is no neutral way to say it. */
const UPGRADE: Record<string, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code@latest',
  codex: 'npm i -g @openai/codex@latest',
};

/**
 * The evidence sentence for a row whose answer is a version comparison.
 *
 * Three answers, not two. A CLI that did not say which version it is has not been shown to be below a
 * floor, and the row used to say `this version is below 0.48.0` anyway — a sentence carried into
 * `doctor --json` and the Diagnostics panel as though it had been checked. It grades nothing either way;
 * that is no reason for it to state something nobody established.
 */
function detail(supported: boolean | undefined, version: string | undefined, words: { has: string; below: string; unknown: string; without: string }): string {
  if (supported === true) return words.has;
  if (supported === false) return `${version ?? 'this version'} ${words.below}; ${words.without}`;
  return `this CLI did not report a version, so ${words.unknown} could not be established; ${words.without} if it cannot`;
}

/**
 * One row per control a CLI either has or silently does without.
 *
 * An agent that is not installed contributes nothing: its own line has already said so, and repeating it
 * once per control would bury the rows that are about this machine's *version*.
 */
export function controlSupport(detections: readonly AgentDetection[]): ControlSupport[] {
  const out: ControlSupport[] = [];
  for (const detection of detections) {
    if (!detection.found) continue;
    const upgrade = UPGRADE[detection.runner];
    const row = (control: string, supported: boolean | undefined, detail: string): void => {
      out.push({ agent: detection.runner, control, supported, detail, ...(supported === false && upgrade ? { hint: upgrade } : {}) });
    };
    if (detection.runner === 'claude') {
      const advertised = detection.capabilities?.includes('replayUserMessages');
      row(
        'follow-up acknowledgment',
        advertised,
        advertised
          ? `${CLAUDE_REPLAY_USER_MESSAGES} is advertised`
          : `${CLAUDE_REPLAY_USER_MESSAGES} is not advertised, so a follow-up stays "queued" until the worker answers`,
      );
    }
    if (detection.runner === 'codex') {
      const steer = detection.capabilities?.includes('steer')
        ? true
        : versionAtLeast(detection.version, STEER_MINIMUM_VERSIONS.codex) === false
          ? false
          : undefined;
      row(
        'steer a running turn',
        steer,
        detail(steer, detection.version, {
          has: `turn/steer, from ${STEER_MINIMUM_VERSIONS.codex}`,
          below: `is below ${STEER_MINIMUM_VERSIONS.codex}, the first with turn/steer`,
          unknown: 'whether it has turn/steer',
          without: 'a follow-up stops the turn and continues instead',
        }),
      );
      const quotas = versionAtLeast(detection.version, CODEX_QUOTA_MINIMUM_VERSION);
      row(
        'quota reads',
        quotas,
        detail(quotas, detection.version, {
          has: `account/rateLimits/read, from ${CODEX_QUOTA_MINIMUM_VERSION}`,
          below: `is below ${CODEX_QUOTA_MINIMUM_VERSION}, the first that can report quotas`,
          unknown: 'whether it can report quotas',
          without: 'the footer chip stays empty',
        }),
      );
    }
  }
  return out;
}
