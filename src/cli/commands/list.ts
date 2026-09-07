import { openStore, table } from '../util.js';
import { formatAge, formatLocal } from '../../util/duration.js';
import { warnLine } from '../../util/marks.js';

export interface ListOptions {
  repository?: string;
  json?: boolean;
  limit?: number;
}

export async function listCommand(opts: ListOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const runs = (await store.listRuns()).slice(0, opts.limit ?? 50);
  if (opts.json) {
    out(JSON.stringify(runs, null, 2));
    return 0;
  }
  // A directory that cannot be read is still a run the user made, and saying nothing about it turns a
  // corrupt file into "my run vanished".
  const unreadable = await store.listUnreadableRuns();
  if (unreadable.length) process.stderr.write(`${warnLine(`Skipped ${unreadable.length} unreadable run director${unreadable.length === 1 ? 'y' : 'ies'}: ${unreadable.join(', ')}`)}\n`);
  if (runs.length === 0) {
    out(`No runs found under ${store.paths.runsDir}. Start one with "cao run".`);
    return 0;
  }
  // Newest first (listRuns sorts by creation), with the age beside the local timestamp: "which run was that"
  // is answered by "8m ago" far more often than by a date.
  const now = Date.now();
  out(
    table(
      runs.map((r) => [r.runId, r.workflowName, r.state, `${r.progress.done}/${r.progress.total}`, formatLocal(r.createdAt), formatAge(r.createdAt, now), r.repositoryRoot]),
      { header: ['Run', 'Workflow', 'State', 'Done', 'Created', 'Age', 'Repository'] },
    ),
  );
  return 0;
}
