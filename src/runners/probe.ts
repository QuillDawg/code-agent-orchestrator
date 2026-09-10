/**
 * Live probes (H4.3): starting each mode a workflow can select, far enough to prove it starts.
 *
 * `cao doctor` used to answer "is the binary there and are you logged in", which is not the question a run
 * fails on. The questions it fails on are "does this CLI accept the command line CAO builds" and "does it
 * accept the output schema CAO sends" — and the only honest way to answer them is to start the thing.
 *
 * A probe never writes into the user's repository (it runs in a temporary directory, read-only), never
 * leaves a process behind (every one is spawned through the ProcessManager and killed as soon as it has
 * answered), and reports itself as one line an operator can act on.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ProcessManager } from '../execution/process-manager.js';

/** One mode of one agent, started for real. */
export interface AgentProbe {
  runner: 'claude' | 'codex';
  /** The mode as a workflow selects it (`codex.transport: exec`, `claude.permissionPrompts: ask`, ...). */
  mode: string;
  status: 'ok' | 'fail' | 'skip';
  detail: string;
  /** What to do about it; only ever set on `fail`. */
  hint?: string;
  durationMs?: number;
}

export interface ProbeOptions {
  /** The configured command, exactly as a run would launch it. */
  command: string;
  processManager: ProcessManager;
  /** Hard budget for the probe; it is killed at this point and reported as a timeout. */
  timeoutMs?: number;
  env?: Record<string, string>;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** A scratch directory for a probe: nothing a probe does may touch the repository it was run from. */
export async function probeWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeProbeWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** The child's environment: the parent's, minus the markers that make an agent think it is a subagent. */
export function probeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** The smallest OpenAI-strict object schema there is; enough to prove the CLI and the API accept one. */
export const TRIVIAL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
} as const;
