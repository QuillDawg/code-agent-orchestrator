/**
 * `cao ui [run]` — open the workspace on a run, or on this repository (spec §3.1, §2.1).
 *
 * The other two ways into the workspace (`cao run`, `cao resume`) start by executing something. This one
 * does not: it opens on a run that has already ended, or on one another terminal is executing, and the run
 * is only started if the operator asks for it from inside. That is why it needs a controller that reads the
 * run directory rather than a scheduler (`createDetachedController`), and why it takes no lock — the
 * workspace holds none while it is idle.
 *
 * Without a run it is a launcher: the runs of this repository and the workflow files beside them. With no
 * terminal to draw in it degrades to what `cao list` would have printed, and exits 0.
 */
import path from 'node:path';
import { FileRunStore, type RunListEntry } from '../../persistence/run-store.js';
import { createDetachedController } from '../../workflow/control/detached.js';
import { createRunObserver } from '../../workflow/control/observer.js';
import { runWorkspaceSession } from '../workspace-session.js';
import { executeOnce, runCommand, writeRunTail } from './run.js';
import { DEFAULT_WORKFLOW_FILES, findStoreRoot, isInteractive, table } from '../util.js';
import { ownershipBadge, ownershipBanner, ownershipRefusal, readOwnership } from '../ownership.js';
import { formatAge, formatLocal } from '../../util/duration.js';
import { formatCost } from '../../tui/format.js';
import { pathExists } from '../../util/fs.js';
import { UsageError } from '../../util/errors.js';
import type { WorkspaceRole } from '../../tui/workspace/chrome.js';

export interface UiOptions {
  repository?: string;
  /** With no terminal, or with `--json`, the list is printed instead of drawn. */
  json?: boolean;
  limit?: number;
  /** `--no-tui`: print the list and stop, even on a terminal that could draw it. */
  tui?: boolean;
  altScreen?: boolean;
  theme?: string;
  verbose?: boolean;
}

/** The runs of this repository, or none at all when it has no `.orchestrator` yet. */
async function listRuns(repository: string | undefined, limit: number): Promise<{ store: FileRunStore | null; runs: RunListEntry[] }> {
  let root: string;
  try {
    root = await findStoreRoot(repository);
  } catch {
    // A repository that has never been run in is not an error for `cao ui`: it is the case the launcher
    // exists for, where the only thing on offer is the workflow file in this directory.
    return { store: null, runs: [] };
  }
  const store = new FileRunStore(root);
  return { store, runs: (await store.listRuns()).slice(0, limit) };
}

/** The workflow files `cao run` would pick up here, as paths to offer. */
async function workflowsHere(cwd = process.cwd()): Promise<string[]> {
  const found: string[] = [];
  for (const name of DEFAULT_WORKFLOW_FILES) {
    if (await pathExists(path.join(cwd, name))) found.push(name);
  }
  return found;
}

export async function uiCommand(runRef: string | undefined, opts: UiOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const interactive = (opts.tui ?? true) && isInteractive() && !opts.json;

  if (runRef !== undefined) {
    const root = await findStoreRoot(opts.repository);
    const store = new FileRunStore(root);
    const runId = await store.resolveRunId(runRef);
    const run = await store.loadRun(runId);
    // §2.1: which of the four states this run is in decides everything below — the badge, the banner, whether
    // there is anything to poll, and whether a key press is a command or a request.
    const ownership = await readOwnership(store, runId);
    const owned = ownership.kind === 'owned';
    const role: WorkspaceRole = owned ? 'observer' : 'owner';
    if (!interactive) {
      out(`${runId}  ${run.workflowName}  ${run.state}${owned ? `  owned by pid ${ownership.pid}` : ''}`);
      out(`Inspect it with "cao status ${runId}"; open it with "cao ui ${runId}" on a terminal.`);
      return 0;
    }
    // A run nobody is executing does not change under the window, so it gets the reader that does not poll.
    const observer = owned ? createRunObserver({ store, runId, run }) : undefined;
    return runWorkspaceSession({
      idle: {
        run,
        store,
        role,
        banner: ownershipBanner(ownership, runId),
        badge: ownershipBadge(ownership),
        observer,
        controller: observer?.controller ?? createDetachedController({ store, run, reason: ownershipRefusal(ownership, runId) }),
      },
      execute: executeOnce,
      writeTail: (endedRun, result) => writeRunTail(endedRun, result, { summary: true }),
      repository: opts.repository,
      altScreen: opts.altScreen,
      theme: opts.theme,
      verbose: opts.verbose,
    });
  }

  const limit = opts.limit ?? 20;
  const { runs } = await listRuns(opts.repository, limit);
  const workflows = await workflowsHere();

  if (opts.json) {
    out(JSON.stringify({ runs, workflows }, null, 2));
    return 0;
  }
  if (!interactive) {
    if (runs.length === 0) out(`No runs found. Start one with "cao run${workflows[0] ? ` ${workflows[0]}` : ' <workflow.yaml>'}".`);
    else {
      const now = Date.now();
      out(
        table(
          runs.map((r) => [r.runId, r.workflowName, r.state, `${r.progress.done}/${r.progress.total}`, formatLocal(r.createdAt), formatAge(r.createdAt, now), r.costUsd !== undefined ? formatCost(r.costUsd) : '']),
          { header: ['Run', 'Workflow', 'State', 'Done', 'Created', 'Age', 'Cost'], hideEmptyColumns: true },
        ),
      );
      out(`\nOpen one on a terminal with "cao ui <run>".`);
    }
    return 0;
  }

  const { runLauncher } = await import('../../tui/launcher.js');
  const choice = await runLauncher({
    runs: runs.map((r) => ({ runId: r.runId, workflowName: r.workflowName, state: r.state, createdAt: r.createdAt, costUsd: r.costUsd, progress: r.progress })),
    workflows,
    altScreen: opts.altScreen,
    theme: opts.theme,
  });
  if (choice.kind === 'quit') return 0;
  if (choice.kind === 'open') return uiCommand(choice.runId, opts);
  if (!(await pathExists(choice.workflow))) throw new UsageError(`No workflow file at ${choice.workflow}.`);
  return runCommand(choice.workflow, { repository: opts.repository, altScreen: opts.altScreen, theme: opts.theme, verbose: opts.verbose });
}
