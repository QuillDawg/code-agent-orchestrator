import { execa } from 'execa';
import { splitCommand } from '../claude/detect.js';

export interface CodexDetection {
  command: string;
  version?: string;
  found: boolean;
  error?: string;
}

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
      ? { command: cmd, version: String(res.stdout ?? '').trim().split(/\r?\n/)[0], found: true }
      : { command: cmd, found: false, error: String(res.stderr || res.stdout || `exit ${res.exitCode}`) };
    cache.set(cmd, detection);
    return detection;
  } catch (err) {
    const detection: CodexDetection = { command: cmd, found: false, error: (err as Error).message };
    cache.set(cmd, detection);
    return detection;
  }
}

export function clearCodexDetectionCache(): void {
  cache.clear();
}
