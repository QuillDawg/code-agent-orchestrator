import { execa } from 'execa';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MINIMUM_AGENT_VERSIONS, versionAtLeast } from '../capabilities.js';

export interface ClaudeDetection {
  command: string;
  version?: string;
  found: boolean;
  error?: string;
  /** True when `--help` lists `--forward-subagent-text`; older CLIs reject the flag, so it is only passed when advertised. */
  forwardSubagentText?: boolean;
  authenticated?: boolean;
  supportedVersion?: boolean;
  minimumVersion?: string;
  capabilities?: string[];
}

const cache = new Map<string, ClaudeDetection>();

const FORWARD_SUBAGENT_TEXT = '--forward-subagent-text';

/** One `--help` probe per command: the flag is new, and passing it to a CLI that does not know it fails the run. */
async function probeRuntime(cmd: string): Promise<{ forwardSubagentText: boolean; authenticated: boolean; capabilities: string[] }> {
  try {
    const { file, args } = splitCommand(cmd);
    const [help, auth] = await Promise.all([
      execa(file, [...args, '--help'], { windowsHide: true, timeout: 15_000, reject: false }),
      execa(file, [...args, 'auth', 'status', '--json'], { windowsHide: true, timeout: 15_000, reject: false }),
    ]);
    const text = `${help.stdout ?? ''}${help.stderr ?? ''}`;
    let authenticated = auth.exitCode === 0;
    try {
      authenticated = authenticated && JSON.parse(String(auth.stdout ?? '{}')).loggedIn === true;
    } catch {
      authenticated = false;
    }
    authenticated ||= Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
    const capabilities = [];
    if (text.includes('stream-json')) capabilities.push('streamJson');
    if (text.includes('--json-schema')) capabilities.push('structuredOutput');
    if (text.includes('--safe-mode')) capabilities.push('isolatedConfig');
    return { forwardSubagentText: text.includes(FORWARD_SUBAGENT_TEXT), authenticated, capabilities };
  } catch {
    return { forwardSubagentText: false, authenticated: false, capabilities: [] };
  }
}

/** Resolve the Claude Code binary and its version. Honours CAO_CLAUDE_COMMAND for tests/overrides. */
export async function detectClaude(command?: string): Promise<ClaudeDetection> {
  const cmd = command ?? process.env.CAO_CLAUDE_COMMAND ?? 'claude';
  const cached = cache.get(cmd);
  if (cached) return cached;
  let detection: ClaudeDetection;
  try {
    const { file, args } = splitCommand(cmd);
    const res = await execa(file, [...args, '--version'], { windowsHide: true, timeout: 15_000, reject: false });
    if (res.exitCode === 0) {
      const version = String(res.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
      const runtime = await probeRuntime(cmd);
      detection = {
        command: cmd,
        version,
        found: true,
        ...runtime,
        supportedVersion: versionAtLeast(version, MINIMUM_AGENT_VERSIONS.claude),
        minimumVersion: MINIMUM_AGENT_VERSIONS.claude,
      };
    } else {
      detection = { command: cmd, found: false, error: String(res.stderr || res.stdout || `exit ${res.exitCode}`) };
    }
  } catch (err) {
    detection = { command: cmd, found: false, error: (err as Error).message };
  }
  cache.set(cmd, detection);
  return detection;
}

export function clearDetectionCache(): void {
  cache.clear();
}

/** A command may be "node path/to/script.mjs" (used by tests) or a plain binary. */
export function splitCommand(command: string): { file: string; args: string[] } {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
  const [file, ...args] = parts.map((p) => p.replace(/^"|"$/g, ''));
  return { file: file ?? command, args };
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(p));
    return true;
  } catch {
    return false;
  }
}
