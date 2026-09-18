/**
 * Where Claude Code keeps the transcript of a session, and whether the one a task reported is still there.
 *
 * A follow-up that resumes a session is `claude --resume <id>`, and the CLI answers a session it cannot find
 * by starting a *fresh* one — which is exactly the silent fallback `[D25]` forbids. So the file is looked
 * for before the attempt is launched, and a missing one becomes a refusal with the fresh-session option in
 * it rather than an attempt that quietly forgets everything the operator was continuing.
 *
 * Never throws and never guesses: an unreadable home directory, a relocated `CLAUDE_CONFIG_DIR` whose layout
 * this does not recognise, or anything else it cannot see answers `unknown`, and an unknown session is
 * launched exactly as it would have been before this existed.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What a probe could tell. `unknown` is "cannot say", and is never treated as a reason to refuse. */
export type SessionPresence = 'present' | 'missing' | 'unknown';

/**
 * The directory name Claude Code gives a project: its absolute path with every character that is not a
 * letter, a digit or a hyphen replaced by one. `C:\Projects\app` becomes `C--Projects-app`.
 */
export function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

/** `CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.claude');
}

const isFile = async (file: string): Promise<boolean> => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};

/**
 * Whether `sessionId` is still on disk for a worker that ran in `cwd`.
 *
 * The slug is tried first, because it is one `stat` and it is right whenever the working directory has not
 * moved. A worktree that has since been removed and recreated elsewhere makes the slug wrong but the
 * session real, so the projects directory is scanned as well before anything is called missing.
 */
export async function claudeSessionPresence(sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionPresence> {
  if (!sessionId) return 'unknown';
  const projects = path.join(claudeConfigDir(env), 'projects');
  if (await isFile(path.join(projects, claudeProjectSlug(cwd), `${sessionId}.jsonl`))) return 'present';
  let entries: string[];
  try {
    entries = (await fs.readdir(projects, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No projects directory at all: this machine has never run Claude Code, or the config lives somewhere
    // this does not know about. Either way it is not evidence that the session is gone.
    return 'unknown';
  }
  for (const entry of entries) {
    if (await isFile(path.join(projects, entry, `${sessionId}.jsonl`))) return 'present';
  }
  return 'missing';
}
