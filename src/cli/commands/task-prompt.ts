/**
 * `cao task prompt [run] <task>` — say something to a task that is already running, or start it again with
 * your message (spec §3.5, `[D25]`, `[D27]`).
 *
 * The same three-way errand as `cao task stop|restart|edit`, and the same fourth case editing has: a run
 * nobody is executing. There the message cannot be *delivered* to anything, so it is carried by the next
 * attempt — which means resuming the run, exactly as `cao resume --task <id> --input` has always done for a
 * task holding a question. That is the whole of the offline path: no second execution engine, no queueing
 * something for a process that may never come back.
 *
 * Without a mode flag the row of the §3.5 matrix that applies is chosen and printed, because "it was
 * steered" and "it was stopped and started again" are very different things to have happened to an hour of
 * work.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PromptDeliveryMode } from 'code-agent-orchestrator-protocol';
import { openStore, resolveRunAndTask, readOrchestrator } from '../util.js';
import { ownershipOf } from '../ownership.js';
import { controlEnvelope } from '../../workflow/control/commands.js';
import { localController } from '../../workflow/control/local.js';
import { controlRequest, sendControlRequest, DEFAULT_ACK_WAIT_SECONDS } from '../../persistence/requests.js';
import { MODE_LABEL, promptRow, selectPromptMode } from '../../workflow/control/prompt.js';
import { checkFollowUpSession } from '../../workflow/control/follow-up.js';
import { detectSessionPresence } from '../../runners/sessions.js';
import { resumeCommand } from './resume.js';
import { UsageError } from '../../util/errors.js';
import { sanitizeText } from '../color.js';
import { mark, warnLine } from '../../util/marks.js';

export interface TaskPromptOptions {
  repository?: string;
  message?: string;
  file?: string;
  steer?: boolean;
  followUp?: boolean;
  stopAndContinue?: boolean;
  freshSession?: boolean;
  /** Seconds to wait for the owning process to answer. 0 returns as soon as the request is on disk. */
  wait?: number;
  /** Passed through to the resume the offline path runs, so `--no-tui` still means headless. */
  tui?: boolean;
  verbose?: boolean;
}

/** The text to deliver, from the flag or the file. One of them, never both and never neither. */
export async function collectMessage(opts: TaskPromptOptions): Promise<string> {
  if (opts.message !== undefined && opts.file !== undefined) {
    throw new UsageError('Use --message or --file, not both: they are two ways of saying the same thing.');
  }
  if (opts.file !== undefined) {
    const file = path.resolve(opts.file);
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.trim() === '') throw new UsageError(`${file} is empty, so there is nothing to send.`);
      return text;
    } catch (err) {
      if (err instanceof UsageError) throw err;
      throw new UsageError(`Could not read the message from ${file}: ${(err as Error).message}`);
    }
  }
  if (opts.message === undefined || opts.message.trim() === '') {
    throw new UsageError('A prompt needs something to say: give --message "<text>" or --file <path>.');
  }
  return opts.message;
}

/** The mode the flags named, or undefined to let the matrix choose. At most one flag. */
export function requestedMode(opts: TaskPromptOptions): PromptDeliveryMode | undefined {
  const named = [
    opts.steer ? ('steer' as const) : undefined,
    opts.followUp ? ('followUp' as const) : undefined,
    opts.stopAndContinue ? ('stopAndContinue' as const) : undefined,
  ].filter((m): m is PromptDeliveryMode => m !== undefined);
  if (named.length > 1) throw new UsageError('Choose one of --steer, --follow-up or --stop-and-continue; they are three different things to do to one task.');
  return named[0];
}

export async function taskPromptCommand(refs: string[], opts: TaskPromptOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const text = await collectMessage(opts);
  const requested = requestedMode(opts);
  const freshSession = opts.freshSession === true;
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveRunAndTask(store, refs, 'cao task prompt [run] <task>');
  const runId = run.runId;
  const ownership = ownershipOf(await readOrchestrator(store, runId));
  const here = ownership.kind === 'self' ? localController(runId) : undefined;

  if (here) {
    // The mode the *live* run chooses may differ from anything this file could work out — only the
    // scheduler knows whether the attempt in front of it has a channel — so the mode goes over as asked (or
    // not asked) and the controller's own answer is printed.
    // No mode where none was asked for: the scheduler is the only thing that knows whether the attempt in
    // front of it has a live channel, so a default of `followUp` here would refuse every no-flag prompt sent
    // to a running task ("a follow-up has no attempt to start"). Its ack names the row it chose.
    const ack = await here.submit({ kind: 'prompt', taskId, text, ...(requested ? { mode: requested } : {}), ...(freshSession ? { freshSession } : {}) }, controlEnvelope('cli'));
    out(`prompt ${taskId} (run ${runId}, this process): ${ack.status}${ack.reason ? ` ${sanitizeText(ack.reason)}` : ''}`);
    return ack.status === 'rejected' ? 2 : 0;
  }

  if (ownership.kind === 'owned') {
    const wait = opts.wait ?? DEFAULT_ACK_WAIT_SECONDS;
    const sent = await sendControlRequest(
      store.paths,
      runId,
      controlRequest('prompt', { taskId, text, ...(requested ? { mode: requested } : {}), ...(freshSession ? { freshSession: true } : {}) }),
      { wait },
    );
    out(`prompt ${taskId} (run ${runId}) sent to pid ${ownership.pid}.`);
    if (!sent.ack) {
      out(warnLine(`No answer in ${wait}s. The request is still in requests/ and is applied when pid ${ownership.pid} reads it; "cao task ${taskId}" shows the result.`));
      return 0;
    }
    const reason = sent.ack.reason ? ` ${sanitizeText(sent.ack.reason)}` : '';
    out(`${mark(sent.ack.status === 'rejected' ? 'error' : 'ok')} ${sent.ack.status}${reason}`);
    return sent.ack.status === 'rejected' ? 2 : 0;
  }

  return offlinePrompt();

  /**
   * Nobody is executing the run. The only mode that means anything here is the follow-up: there is no
   * worker to steer and none to stop, so the message becomes the task's next attempt and the run is resumed
   * to carry it.
   */
  async function offlinePrompt(): Promise<number> {
    const state = run.tasks[taskId]!;
    const task = run.workflow.tasks.find((t) => t.id === taskId)!;
    // `hasChannel: false` is the literal truth for a run nothing is executing, and it is what makes the
    // matrix answer `stopAndContinue` for a task the run directory still says is `running` — a task whose
    // orchestrator has gone. Say so rather than pretending its worker is there to be stopped.
    const chosen = selectPromptMode(state, { hasChannel: false, requested });
    if (chosen.mode !== 'followUp') {
      const why =
        chosen.reason ??
        `Nothing is executing run ${runId}, so "${taskId}" has no worker to ${MODE_LABEL[chosen.mode!]}. Resume the run first with "cao resume ${runId}".`;
      out(`${mark('error')} rejected ${sanitizeText(why)}`);
      return 2;
    }
    const session = await checkFollowUpSession(task, state, { probe: detectSessionPresence(), freshSession });
    if (session.rejection) {
      out(`${mark('error')} rejected ${sanitizeText(session.rejection)}`);
      return 2;
    }
    out(
      `${mark('ok')} Continuing "${taskId}" with your message. ${session.sessionId ? `Its next attempt continues session ${session.sessionId}.` : 'Its next attempt starts a fresh session with your message in the prompt.'}`,
    );
    // The resume is the delivery. Written through `startRuntime` like every other resume, so the follow-up
    // lands in `workflow.json` inside the same lock that executes it and never on its own.
    return resumeCommand(runId, {
      repository: opts.repository,
      task: [taskId],
      followUp: { taskId, text, source: 'cli', freshSession },
      tui: opts.tui,
      verbose: opts.verbose,
    });
  }
}

/** What `cao task prompt` would do, for a caller that wants to say so before sending. Exported for tests. */
export function offeredMode(state: Parameters<typeof promptRow>[0], hasChannel: boolean): ReturnType<typeof promptRow> {
  return promptRow(state, hasChannel);
}
