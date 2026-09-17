import { executeRun } from './run.js';
import { renderHeader } from '../render/plain.js';
import { startRuntime } from '../app.js';
import { warnLine } from '../../util/marks.js';
import type { PermissionMode } from 'code-agent-orchestrator-protocol';

export interface ResumeOptions {
  repository?: string;
  retryFailed?: boolean;
  approve?: string[];
  reject?: string[];
  input?: string;
  task?: string[];
  from?: string[];
  verbose?: boolean;
  tui?: boolean;
  activity?: boolean;
  maxConcurrency?: number;
  permissionMode?: PermissionMode;
  claudeCommand?: string;
  /** `--emit` / `--no-emit`, exactly as on `cao run` (§4.2.7). */
  emit?: boolean;
  /** `--emit-feed`; reserved, and served by nothing yet. */
  emitFeed?: boolean;
  /** `--no-alt-screen` gives `false`; undefined lets `CAO_ALT_SCREEN` and `~/.cao/config.json` decide [D4]. */
  altScreen?: boolean;
  /** `--theme <name>`; `CAO_THEME` and `NO_COLOR` are read when it is absent [D35]. */
  theme?: string;
}

/**
 * `cao resume`: the printed half of `startRuntime`.
 *
 * Everything that decides whether a resume is possible — the arguments, the environment, the agents, the
 * lock, the reconciliation — is in `startRuntime`, because the workspace's ended-state actions run exactly
 * the same sequence (§2.4). What is left here is the part only a command line has: a header, the notes, and
 * the exit code.
 */
export async function resumeCommand(runRef: string | undefined, opts: ResumeOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const started = await startRuntime(runRef, { ...opts, onNote: (n) => out(warnLine(n)) });
  if (started.kind === 'nothing-to-do') {
    out(started.message);
    return 0;
  }
  const { run, runners, layers } = started;
  out(renderHeader({ workflow: run.workflow, runId: run.runId, runners, layers, resumed: true, verbose: opts.verbose }));
  if (started.rerun.length) out(`Re-running: ${started.rerun.join(', ')}\n`);

  return executeRun({
    run,
    environment: started.environment,
    secrets: started.secrets,
    verbose: opts.verbose,
    tui: opts.tui,
    activity: opts.activity,
    isResume: true,
    emit: opts.emit,
    emitFeed: opts.emitFeed,
    altScreen: opts.altScreen,
    theme: opts.theme,
    repository: opts.repository,
  });
}
