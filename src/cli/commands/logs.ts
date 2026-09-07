import path from 'node:path';
import { openStore, readOrchestrator, resolveRunAndTask, currentAttempt } from '../util.js';
import { followFile, readTail } from '../../tui/follow.js';
import { pathExists } from '../../util/fs.js';
import { UsageError } from '../../util/errors.js';
import { isInteractive } from '../util.js';
import { useColor, type ColorMode } from '../color.js';
import { ACTIVE_TASK_STATES, type WorkflowRun } from '../../types/run.js';
import { createTranscriptStream } from '../../tui/transcript.js';
import type { TranscriptEntry } from '../../types/transcript.js';
import type { FileRunStore } from '../../persistence/run-store.js';

export interface LogsOptions {
  repository?: string;
  attempt?: number;
  stderr?: boolean;
  events?: boolean;
  prompt?: boolean;
  follow?: boolean;
  lines?: number;
  raw?: boolean;
  thinking?: boolean;
  json?: boolean;
  color?: ColorMode;
}

/**
 * Which file of the attempt directory the flags select. `--events` and `--json` name the default explicitly.
 *
 * `--json` is a stream of normalized entries, which only `events.jsonl` holds; asking for it alongside a
 * flag that names a raw file is a contradiction rather than a preference, so it is refused instead of
 * quietly winning. `--events` says in its own help text that it wins, so it still does.
 */
export function logSource(opts: LogsOptions): 'events.jsonl' | 'stdout.log' | 'stderr.log' | 'prompt.md' {
  if (opts.events) return 'events.jsonl';
  const raw = ([['--prompt', opts.prompt], ['--stderr', opts.stderr], ['--raw', opts.raw]] as const).filter(([, on]) => on);
  if (opts.json && raw.length) {
    throw new UsageError(
      `--json cannot be combined with ${raw.map(([flag]) => flag).join(' or ')}: --json prints the normalized entries of events.jsonl, and ${raw[0]![0]} prints a raw file. Drop one of them.`,
    );
  }
  if (opts.prompt) return 'prompt.md';
  if (opts.stderr) return 'stderr.log';
  if (opts.raw) return 'stdout.log';
  return 'events.jsonl';
}

/**
 * `--json`: the normalized entries, one JSON object per line, so `cao logs --json | jq` works on the same
 * model every surface renders. Unparsable lines are dropped, and thinking stays opt-in as everywhere else.
 */
export function jsonEntryLines(lines: string[], opts: { thinking?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.kind === 'thinking' && !opts.thinking) continue;
    out.push(JSON.stringify(entry));
  }
  return out;
}

/**
 * A renderer for one attempt's events.jsonl on a plain terminal, shared with `cao peek`.
 *
 * It is stateful on purpose: the tail is rendered as one transcript (so a call is paired with its result and
 * a subagent's entries nest under the `Agent:` call), and lines that arrive afterwards under `--follow` are
 * rendered against the calls those earlier lines established.
 */
export function eventLineRenderer(color?: ColorMode, opts: { thinking?: boolean } = {}): ReturnType<typeof createTranscriptStream> {
  return createTranscriptStream({ color: useColor(color), width: process.stdout.columns ?? 0, timestamps: true, showToolResults: true, showThinking: opts.thinking });
}

/** `cao logs [run] [task]`: with --follow the task is optional (defaults to the first active task). */
async function resolveTarget(store: FileRunStore, refs: string[], follow: boolean | undefined): Promise<{ run: WorkflowRun; taskId: string }> {
  try {
    return await resolveRunAndTask(store, refs, 'cao logs [run] <task>');
  } catch (err) {
    if (!follow || refs.length > 1) throw err;
    const runId = await store.resolveRunId(refs[0]);
    const run = await store.loadRun(runId);
    const first =
      run.workflow.tasks.find((t) => ACTIVE_TASK_STATES.has(run.tasks[t.id]?.state ?? 'pending')) ??
      run.workflow.tasks.find((t) => run.tasks[t.id]?.attempts.length) ??
      run.workflow.tasks[0];
    if (!first) throw new UsageError(`Run ${runId} has no tasks`);
    return { run, taskId: first.id };
  }
}

export async function logsCommand(refs: string[], opts: LogsOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveTarget(store, refs, opts.follow);
  const state = run.tasks[taskId]!;
  const file = logSource(opts);
  const pretty = file === 'events.jsonl' && !opts.json;
  if (opts.follow && pretty && isInteractive()) {
    const { followLogsInTui } = await import('../../tui/logs.js');
    await followLogsInTui({ store, run, taskId, attempt: opts.attempt, lines: opts.lines ?? 400, color: useColor(opts.color), thinking: opts.thinking });
    return 0;
  }
  const attempt = opts.attempt ?? currentAttempt(state)?.number;
  if (!attempt) {
    if (opts.json) return 0;
    out(`Task "${taskId}" has not started yet (state: ${state.state}).`);
    return 0;
  }
  const dir = store.paths.attemptDir(run.runId, taskId, attempt);
  const filePath = path.join(dir, file);
  if (!(await pathExists(filePath))) throw new UsageError(`No ${file} for ${taskId} attempt ${attempt} (${filePath})`);
  const renderer = eventLineRenderer(opts.color, { thinking: opts.thinking });
  const print = (line: string): void => {
    if (opts.json) {
      for (const l of jsonEntryLines([line], { thinking: opts.thinking })) out(l);
      return;
    }
    if (!pretty) {
      out(line);
      return;
    }
    for (const l of renderer.line(line)) out(l);
  };
  // The header is prose: --json is a stream of entries and nothing else, so it can be piped straight into jq.
  if (!opts.json) out(`# ${run.runId} / ${taskId} / attempt ${attempt} / ${file}`);
  if (!opts.follow) {
    const tail = await readTail(filePath, opts.lines ?? 200);
    if (opts.json) for (const l of jsonEntryLines(tail, { thinking: opts.thinking })) out(l);
    else if (pretty) for (const l of renderer.batch(tail)) out(l);
    else for (const l of tail) out(l);
    // A header and nothing under it reads as a broken command rather than as "the agent wrote no stderr".
    if (!opts.json && tail.every((l) => !l.trim())) out(`(${file} is empty)`);
    return 0;
  }
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);
  const shouldStop = async (): Promise<boolean> => {
    const fresh = await store.loadRun(run.runId).catch(() => run);
    const st = fresh.tasks[taskId];
    const orchestrator = await readOrchestrator(store, run.runId);
    return !orchestrator?.alive || !st || !ACTIVE_TASK_STATES.has(st.state);
  };
  await followFile(filePath, print, {
    initialLines: opts.lines ?? 50,
    onInitial: opts.json
      ? (lines) => void jsonEntryLines(lines, { thinking: opts.thinking }).forEach(out)
      : pretty
        ? (lines) => void renderer.batch(lines).forEach(out)
        : undefined,
    signal: controller.signal,
    shouldStop,
  });
  process.off('SIGINT', onSigint);
  return 0;
}
