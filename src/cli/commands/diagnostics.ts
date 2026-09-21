/**
 * `cao diagnostics [run] --out <file>` — one JSON file that says everything about a run (spec §3.7, `[D33]`).
 *
 * The thing you attach to a bug report. Three rules decide what is in it:
 *
 * - **Only the run directory, plus the doctor facts.** Nothing from `~/.cao`, no environment values,
 *   nothing outside `.orchestrator/runs/<id>/`. The doctor facts are the one exception and they are about
 *   this machine, not about this user.
 * - **Everything through the `Redactor`.** The same one the run itself wrote with, rebuilt from the
 *   workflow's `envFile` — so a secret that reached a prompt is `[REDACTED]` here as well.
 * - **Nothing bulky unless it is asked for.** Transcripts, prompts and diffs are where the size and the
 *   sensitivity are, so each needs its own `--include` token.
 *
 * No upload, no telemetry, no probe: the file is written and its path is printed.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PROTOCOL_VERSION, type ControlAck, type ControlRequest, type LiveStatus, type TaskAttempt, type WorkflowRun } from 'code-agent-orchestrator-protocol';
import { openStore } from '../util.js';
import { loadWorkflow } from '../../config/loader.js';
import { Redactor } from '../../logging/redact.js';
import { readControlHistory } from '../../persistence/requests.js';
import { readTailPage } from '../../persistence/log-pager.js';
import { writeFileAtomic } from '../../util/fs.js';
import { nowIso } from '../../util/misc.js';
import { packageInfo } from '../../util/package-info.js';
import { UsageError } from '../../util/errors.js';
import { gatherFacts, type DoctorFacts } from './doctor.js';
import type { FileRunStore } from '../../persistence/run-store.js';

/** What `--include` accepts, and therefore what is left out by default. */
export const DIAGNOSTICS_INCLUDES = ['transcripts', 'prompts', 'diffs'] as const;
export type DiagnosticsInclude = (typeof DIAGNOSTICS_INCLUDES)[number];

/** Lines of each attempt's `stderr.log` (spec §3.7). */
export const STDERR_TAIL_LINES = 200;

/**
 * The ceiling on the two whole-file fields, in lines.
 *
 * §3.7 asks for `orchestratorLog` and `events` in full, and for every run either has ever produced this is
 * the full thing. It is a ceiling rather than a size because the alternative is a bug report that cannot be
 * written at all on the one run that needed it most — a `--debug` run that logged for six hours.
 *
 * It is not the only ceiling: the pager clamps any page at `MAX_PAGE_BYTES` (4 MB), which for ordinary log
 * lines bites long before 50 000 lines do. Which of the two cut is not worth reporting; *that* something
 * was cut is, and `truncated` says so.
 */
export const BUNDLE_TAIL_LINES = 50_000;

/** What stands in for a prompt's text when `--include prompts` did not ask for it. */
export const PROMPT_TEXT_OMITTED = '[omitted; add --include prompts]';

export interface DiagnosticsOptions {
  repository?: string;
  /** Where to write the bundle. Required: this command's whole output is a file. */
  out?: string;
  /** `--include transcripts,prompts,diffs`, repeatable and comma-separated. */
  include?: string[];
}

/** One attempt of the bundle: what the run recorded about it, and the tail of what the worker said. */
export interface BundleAttempt {
  taskId: string;
  attempt: TaskAttempt;
  stderrTail: string[];
}

/** The bundle, exactly as it is written. */
export interface DiagnosticsBundle {
  protocol: number;
  cao: string;
  createdAt: string;
  doctor: DoctorFacts;
  workflow: WorkflowRun;
  events: unknown[];
  live: LiveStatus | null;
  orchestratorLog: string;
  attempts: BundleAttempt[];
  requests: ControlRequest[];
  acks: ControlAck[];
  /**
   * The fields above that did not fit and are the *end* of their file rather than the whole of it.
   *
   * Empty on every ordinary run. Without it a reader of a `--debug` run's bundle cannot tell a log that
   * was cut from one that simply started where it starts.
   */
  truncated: Array<'orchestratorLog' | 'events'>;
  /** `--include transcripts`: each attempt's `events.jsonl`, one parsed entry per element. */
  transcripts?: Array<{ taskId: string; attempt: number; entries: unknown[] }>;
  /** `--include prompts`: each attempt's `prompt.md`. */
  prompts?: Array<{ taskId: string; attempt: number; text: string }>;
  /** `--include diffs`: each attempt's captured `diff.json` and `diff.patch`. */
  diffs?: Array<{ taskId: string; attempt: number; diff: unknown; patch: string }>;
}

/** `--include a,b --include c` in either spelling, refusing a token that is not one of ours. */
export function parseIncludes(values: string[] | undefined): DiagnosticsInclude[] {
  const out: DiagnosticsInclude[] = [];
  for (const value of values ?? []) {
    for (const token of value.split(',').map((t) => t.trim()).filter(Boolean)) {
      if (!(DIAGNOSTICS_INCLUDES as readonly string[]).includes(token)) {
        throw new UsageError(`--include takes ${DIAGNOSTICS_INCLUDES.join(', ')}; "${token}" is none of them`);
      }
      if (!out.includes(token as DiagnosticsInclude)) out.push(token as DiagnosticsInclude);
    }
  }
  return out;
}

/**
 * The run with every follow-up's text taken out of it, for a bundle that was not asked for prompts.
 *
 * `attempt.prompts[].text` is a prompt wherever §2.6 happens to record it, and §3.7 says prompts are added
 * "only with the flag". It is redacted either way, but redaction is about secrets and this is about an
 * operator's own words: whoever attaches a bug report without `--include prompts` should not be sending
 * every follow-up they typed. The delivery itself stays — what was sent, how, and whether it arrived is
 * exactly the diagnostic — and the text says that it was left out rather than quietly becoming empty.
 */
function withoutPromptText(run: WorkflowRun): WorkflowRun {
  const copy = structuredClone(run);
  for (const task of Object.values(copy.tasks)) {
    for (const attempt of task?.attempts ?? []) {
      for (const prompt of attempt.prompts ?? []) prompt.text = PROMPT_TEXT_OMITTED;
    }
  }
  return copy;
}

/** Every attempt of the run, in task order then attempt order. */
function everyAttempt(run: WorkflowRun): Array<{ taskId: string; attempt: TaskAttempt }> {
  const out: Array<{ taskId: string; attempt: TaskAttempt }> = [];
  for (const task of run.workflow.tasks) {
    for (const attempt of run.tasks[task.id]?.attempts ?? []) out.push({ taskId: task.id, attempt });
  }
  return out;
}

const readText = async (file: string): Promise<string> => fs.readFile(file, 'utf8').catch(() => '');

/** Lines of a JSONL file as parsed values; a line that is not JSON is kept as the string it was. */
function parseLines(lines: readonly string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push(line);
    }
  }
  return out;
}

/**
 * The redactor this run wrote with, rebuilt.
 *
 * Environment values are never persisted, so the secrets have to come from the workflow file again — the
 * same reload `cao resume` does. A workflow that has since been deleted or changed leaves the pattern-based
 * half of the `Redactor`, which still catches the shapes every provider's keys have.
 */
async function redactorFor(run: WorkflowRun): Promise<Redactor> {
  try {
    const loaded = await loadWorkflow(run.configPath, { launchDirectory: run.launchDirectory, repository: run.repositoryRoot });
    return new Redactor(loaded.secrets);
  } catch {
    return new Redactor();
  }
}

/** Build the bundle. Separated from the command so a test asserts on the object rather than on a file. */
export async function buildDiagnosticsBundle(store: FileRunStore, source: WorkflowRun, includes: readonly DiagnosticsInclude[]): Promise<DiagnosticsBundle> {
  const redactor = await redactorFor(source);
  const run = includes.includes('prompts') ? source : withoutPromptText(source);
  const paths = store.paths;
  const runId = run.runId;

  const [doctor, log, events, live, inbox] = await Promise.all([
    // Facts, never probes: §3.7 says the bundle carries the doctor's cheap half, and a probe would spend a
    // model call on a command whose entire job is to describe what already happened.
    gatherFacts({ repository: run.repositoryRoot, probe: false }),
    readTailPage(paths.runLogFile(runId), BUNDLE_TAIL_LINES),
    readTailPage(paths.eventsFile(runId), BUNDLE_TAIL_LINES),
    store.readLive(runId).catch(() => null),
    readControlHistory(paths, runId),
  ]);

  const attempts: BundleAttempt[] = [];
  const transcripts: DiagnosticsBundle['transcripts'] = [];
  const prompts: DiagnosticsBundle['prompts'] = [];
  const diffs: DiagnosticsBundle['diffs'] = [];
  for (const { taskId, attempt } of everyAttempt(run)) {
    const dir = paths.attemptDir(runId, taskId, attempt.number);
    const stderr = await readTailPage(path.join(dir, 'stderr.log'), STDERR_TAIL_LINES);
    attempts.push({ taskId, attempt, stderrTail: stderr.lines });
    if (includes.includes('transcripts')) {
      const page = await readTailPage(path.join(dir, 'events.jsonl'), BUNDLE_TAIL_LINES);
      transcripts.push({ taskId, attempt: attempt.number, entries: parseLines(page.lines) });
    }
    if (includes.includes('prompts')) {
      prompts.push({ taskId, attempt: attempt.number, text: await readText(path.join(dir, 'prompt.md')) });
    }
    if (includes.includes('diffs')) {
      const diff = await store.readDiff(runId, taskId, attempt.number).catch(() => null);
      const patch = await store.readDiffPatch(runId, taskId, attempt.number).catch(() => null);
      if (diff || patch) diffs.push({ taskId, attempt: attempt.number, diff, patch: patch ?? '' });
    }
  }

  const bundle: DiagnosticsBundle = {
    protocol: PROTOCOL_VERSION,
    cao: packageInfo().version,
    createdAt: nowIso(),
    doctor,
    workflow: run,
    events: parseLines(events.lines),
    live,
    orchestratorLog: log.lines.join('\n'),
    attempts,
    requests: inbox.pending,
    acks: inbox.acks,
    // `atStart` is the pager saying it reached the beginning of the file; anything else is a tail.
    truncated: ([['orchestratorLog', log], ['events', events]] as const).filter(([, page]) => !page.atStart).map(([field]) => field),
    ...(includes.includes('transcripts') ? { transcripts } : {}),
    ...(includes.includes('prompts') ? { prompts } : {}),
    ...(includes.includes('diffs') ? { diffs } : {}),
  };
  // One pass over the finished object rather than per field: a value that reaches the file by a route added
  // later is redacted by virtue of being in the file, which is the only rule that stays true.
  return redactor.redactValue(bundle);
}

export async function diagnosticsCommand(runRef: string | undefined, opts: DiagnosticsOptions): Promise<number> {
  const includes = parseIncludes(opts.include);
  if (!opts.out) throw new UsageError('cao diagnostics writes a file: name it with --out <file>');
  const store = await openStore(opts.repository);
  // `resolveRunId` is a usage error (exit 2) for a run that does not exist, which is what §3.7 asks for.
  const run = await store.loadRun(await store.resolveRunId(runRef));
  const bundle = await buildDiagnosticsBundle(store, run, includes);
  const file = path.resolve(opts.out);
  await writeFileAtomic(file, `${JSON.stringify(bundle, null, 2)}\n`);
  process.stdout.write(`${file}\n`);
  return 0;
}
