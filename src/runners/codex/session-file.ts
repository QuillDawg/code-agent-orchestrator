/**
 * Where Codex keeps a thread's rollout, and whether the one a task reported is still there.
 *
 * `codex exec resume <thread>` and `thread/resume` both need the rollout file; without it the CLI starts
 * over, which is the silent fallback `[D25]` forbids. Looked for before the attempt is launched, so a
 * missing thread is a refusal with the fresh-session option rather than an attempt that lost the thread.
 *
 * Never throws. Anything this cannot see answers `unknown`, and an unknown thread is launched exactly as it
 * would have been before this existed.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionPresence } from '../claude/session-file.js';

/** `CODEX_HOME` when it is set, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

/** `sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl`: three levels of dated directories. */
const MAX_DEPTH = 3;

async function findRollout(dir: string, suffix: string, depth: number): Promise<boolean> {
  let entries: { name: string; file: boolean; directory: boolean }[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, file: e.isFile(), directory: e.isDirectory() }));
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.file && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) return true;
    // Newest first: a thread being followed up on is almost always today's, and the walk stops on the hit.
  }
  if (depth >= MAX_DEPTH) return false;
  const dirs = entries.filter((e) => e.directory).map((e) => e.name).sort().reverse();
  for (const name of dirs) {
    if (await findRollout(path.join(dir, name), suffix, depth + 1)) return true;
  }
  return false;
}

export async function codexSessionPresence(sessionId: string, _cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionPresence> {
  if (!sessionId) return 'unknown';
  const sessions = path.join(codexHome(env), 'sessions');
  try {
    await fs.stat(sessions);
  } catch {
    // No sessions directory: this machine has never run Codex, or `CODEX_HOME` points elsewhere. Not
    // evidence that the thread is gone.
    return 'unknown';
  }
  return (await findRollout(sessions, `-${sessionId}.jsonl`, 0)) ? 'present' : 'missing';
}
