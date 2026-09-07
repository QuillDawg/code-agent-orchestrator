/**
 * `cao report [run]`: the run's own account of itself, rendered from the run directory — header, one section
 * per task, and the attempts table. The Markdown form is shaped to paste into a pull request; `--json` is
 * the same structure for tooling. Every run also writes this document to `report.md` when it ends.
 */
import path from 'node:path';
import { openStore } from '../util.js';
import { buildReport, renderReportMarkdown } from '../../workflow/report.js';
import { writeFileAtomic } from '../../util/fs.js';
import { UsageError } from '../../util/errors.js';

export interface ReportOptions {
  repository?: string;
  md?: boolean;
  json?: boolean;
  out?: string;
}

export async function reportCommand(runRef: string | undefined, opts: ReportOptions): Promise<number> {
  if (opts.md && opts.json) throw new UsageError('--md and --json are mutually exclusive');
  const store = await openStore(opts.repository);
  const run = await store.loadRun(await store.resolveRunId(runRef));
  const report = await buildReport(store, run);
  const text = opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderReportMarkdown(report);

  if (opts.out) {
    const file = path.resolve(opts.out);
    await writeFileAtomic(file, text);
    process.stdout.write(`${file}\n`);
    return 0;
  }
  process.stdout.write(text);
  return 0;
}
