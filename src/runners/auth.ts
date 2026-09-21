/**
 * How each provider is signed in, behind one runner-neutral type (spec §3.7, `[D29]`).
 *
 * The same seam as `src/runners/quota.ts` and `src/runners/diagnostics.ts`: which agents have a login mode
 * worth reporting, and how to read it without starting anything, is decided here — `cao doctor` renders an
 * `AgentAuth` and never names a CLI. Nothing in this file spawns a process or makes a network call.
 */
import { codexAuthMode } from './codex/auth.js';
import { SIGN_IN_FOR_QUOTAS } from './codex/quota.js';

/**
 * Which credential a provider is using. `subscription` is a seat (ChatGPT, a Claude plan), `apiKey` is a
 * key billed per token, `none` is signed out, and `unknown` is "this could not be read" — never a verdict.
 */
export type AuthMode = 'subscription' | 'apiKey' | 'none' | 'unknown';

export interface AgentAuth {
  /** The agent's name, for the label only; nothing above this file branches on it. */
  agent: string;
  mode: AuthMode;
  /**
   * Set when this provider refuses to report its quota in this mode (§3.6), with the command that fixes it.
   * Absent means the mode says nothing about quota reads either way.
   */
  quotaHint?: string;
}

/**
 * The login mode of each agent named, in the order they were named.
 *
 * An agent with nothing readable is reported as `unknown` rather than left out, so a caller iterating these
 * gets one row per agent whatever the machine looks like.
 */
export async function readAgentAuth(agents: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<AgentAuth[]> {
  const out: AgentAuth[] = [];
  for (const agent of agents) {
    if (agent !== 'codex') {
      // No other provider has a mode this can read without a network call, which this beta does not make.
      out.push({ agent, mode: 'unknown' });
      continue;
    }
    const mode = await codexAuthMode(env).catch((): AuthMode => 'unknown');
    out.push({ agent, mode, ...(mode === 'apiKey' ? { quotaHint: `\`codex login\` to ${SIGN_IN_FOR_QUOTAS}; an API key cannot read them` } : {}) });
  }
  return out;
}
