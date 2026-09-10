import { execa } from 'execa';
import { splitCommand } from '../claude/detect.js';
import { MINIMUM_AGENT_VERSIONS, versionAtLeast, type AgentCapability, type AgentRuntimeDetection } from '../capabilities.js';

export type CodexDetection = AgentRuntimeDetection;

const cache = new Map<string, CodexDetection>();

/** Resolve the Codex CLI once per configured command. */
export async function detectCodex(command?: string): Promise<CodexDetection> {
  const cmd = command ?? process.env.CAO_CODEX_COMMAND ?? 'codex';
  const cached = cache.get(cmd);
  if (cached) return cached;
  try {
    const { file, args } = splitCommand(cmd);
    const res = await execa(file, [...args, '--version'], { windowsHide: true, timeout: 15_000, reject: false });
    const detection: CodexDetection = res.exitCode === 0
      ? await inspectCodex(file, args, cmd, String(res.stdout ?? '').trim().split(/\r?\n/)[0] ?? '')
      : { command: cmd, found: false, error: String(res.stderr || res.stdout || `exit ${res.exitCode}`) };
    cache.set(cmd, detection);
    return detection;
  } catch (err) {
    const detection: CodexDetection = { command: cmd, found: false, error: (err as Error).message };
    cache.set(cmd, detection);
    return detection;
  }
}

async function inspectCodex(file: string, prefix: string[], command: string, version: string): Promise<CodexDetection> {
  const run = (args: string[]) => execa(file, [...prefix, ...args], { windowsHide: true, timeout: 15_000, reject: false }).catch(() => null);
  const [rootHelp, execHelp, appHelp, auth] = await Promise.all([run(['--help']), run(['exec', '--help']), run(['app-server', '--help']), run(['login', 'status'])]);
  const root = `${rootHelp?.stdout ?? ''}\n${rootHelp?.stderr ?? ''}`;
  const exec = `${execHelp?.stdout ?? ''}\n${execHelp?.stderr ?? ''}`;
  const capabilities: AgentCapability[] = [];
  if (execHelp?.exitCode === 0) capabilities.push('exec');
  if (appHelp?.exitCode === 0) capabilities.push('appServer');
  if (root.includes('--approve-for-me')) capabilities.push('autoReview');
  if (exec.includes('--ignore-user-config') && exec.includes('--ignore-rules')) capabilities.push('isolatedConfig');
  return {
    command,
    version,
    found: true,
    authenticated: auth?.exitCode === 0 || Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
    supportedVersion: versionAtLeast(version, MINIMUM_AGENT_VERSIONS.codex),
    minimumVersion: MINIMUM_AGENT_VERSIONS.codex,
    capabilities,
  };
}

export function clearCodexDetectionCache(): void {
  cache.clear();
}
