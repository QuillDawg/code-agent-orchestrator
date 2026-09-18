/**
 * Is the session a task last reported still on disk? (spec §3.5, `[D25]`, and the `sessions` doctor check of
 * §3.7.)
 *
 * The one place that knows both agents' on-disk layouts, so nothing outside `src/runners/` has to. What
 * leaves here is a `SessionPresence` and nothing else: `src/workflow/` asks a `SessionProbe` it was handed
 * and never learns which CLI answered.
 */
import type { ResolvedTask } from 'code-agent-orchestrator-protocol';
import { claudeSessionPresence, type SessionPresence } from './claude/session-file.js';
import { codexSessionPresence } from './codex/session-file.js';

export type { SessionPresence };

/**
 * Whether this task's `sessionId` can still be resumed. Injectable everywhere it is used, so no test has to
 * have a real `~/.claude` or `~/.codex` to run.
 */
export type SessionProbe = (task: ResolvedTask, sessionId: string, cwd: string) => Promise<SessionPresence>;

export const detectSessionPresence =
  (env?: NodeJS.ProcessEnv): SessionProbe =>
  async (task, sessionId, cwd) => {
    try {
      if (task.agent === 'claude') return await claudeSessionPresence(sessionId, cwd, env);
      if (task.agent === 'codex') return await codexSessionPresence(sessionId, cwd, env);
    } catch {
      return 'unknown';
    }
    return 'unknown';
  };

/** A probe that never claims anything is missing; the default wherever one has not been wired. */
export const unknownSessionPresence: SessionProbe = async () => 'unknown';
