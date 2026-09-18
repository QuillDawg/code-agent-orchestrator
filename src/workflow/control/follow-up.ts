/**
 * What a **follow-up** means to a task (spec §3.5, `[D25]`).
 *
 * A follow-up is the row of the matrix that cannot be delivered to anything running: the task has stopped —
 * failed, blocked, cancelled, or holding a question — and the message becomes the *next attempt*. It
 * continues the session the task last reported where `retry.resumeSession` allows and the agent gave one,
 * and otherwise rides in the fresh prompt under `# User Input`, which is what `cao resume --input` has
 * always done. This module is that path generalized, so the one `--input` case and the general one cannot
 * drift apart.
 *
 * Nothing here starts anything. It queues the delivery and says which session the next attempt should
 * continue; `launch()` reads that back and `decidePrompt` is what decides an attempt may start at all.
 */
import type { ControlSource, PromptDelivery, ResolvedTask, TaskAttempt, TaskRunState } from 'code-agent-orchestrator-protocol';
import type { SessionProbe } from '../../runners/sessions.js';
import { namesFlags, newDelivery, type DeliveryOrigin } from './prompt.js';
import { nowIso } from '../../util/misc.js';

export { FOLLOW_UP_STATES } from './prompt.js';

/** Whether a task's configuration lets an attempt continue a previous session at all. */
export function sessionResumable(task: ResolvedTask): boolean {
  return task.retry.resumeSession && (task.agent !== 'claude' || task.claude.sessionPersistence !== false);
}

/** The newest attempt that ran the task itself; a merge attempt has a session of its own and is not it. */
export function lastTaskAttempt(state: TaskRunState): TaskAttempt | undefined {
  for (let i = state.attempts.length - 1; i >= 0; i--) {
    const attempt = state.attempts[i]!;
    if (attempt.kind === 'task') return attempt;
  }
  return undefined;
}

/**
 * The session a follow-up would continue, or undefined when it would start a fresh one.
 *
 * `resumeSessionId` first: the scheduler sets it when a task stops in a state it already knows is
 * continuable (a question asked, a transient error), and it is the id that path has already vetted. For
 * everything else the last attempt's own id is what the agent reported, which is all a `--resume` needs.
 */
export function resumableSessionId(task: ResolvedTask, state: TaskRunState): string | undefined {
  if (!sessionResumable(task)) return undefined;
  const attempt = lastTaskAttempt(state);
  return state.resumeSessionId ?? attempt?.usage?.sessionId ?? attempt?.sessionId;
}

/** The working directory the session ran in, which is where its transcript was filed. */
export function lastAttemptCwd(state: TaskRunState, task: ResolvedTask): string {
  return lastTaskAttempt(state)?.cwd ?? task.workingDirectory;
}

/** Follow-ups no attempt has carried yet. */
export function pendingFollowUps(state: TaskRunState): PromptDelivery[] {
  return (state.followUps ?? []).filter((d) => d.state === 'queued');
}

/**
 * Every follow-up's text, oldest first — what the prompt carries.
 *
 * Delivered ones are included on purpose: a retry of an attempt that already carried the operator's words
 * still needs them, which is why `userInput` has always outlived the attempt that first used it.
 */
export function followUpText(state: TaskRunState): string | undefined {
  const texts = (state.followUps ?? []).map((d) => d.text).filter((t) => t.trim() !== '');
  return texts.length ? texts.join('\n\n') : undefined;
}

export interface QueueFollowUpOptions extends DeliveryOrigin {
  /** The session the next attempt should continue; undefined starts a fresh one. */
  sessionId?: string;
}

/**
 * Queue a follow-up on the task and say which session its attempt should continue.
 *
 * `userInput` is written here rather than derived at read time because it is persisted state a 0.1.x reader
 * and `cao task show` both look at, and because the prompt builder wants one string, not a list.
 */
export function queueFollowUp(state: TaskRunState, opts: QueueFollowUpOptions): PromptDelivery {
  const delivery = newDelivery({ source: opts.source, mode: opts.mode, text: opts.text });
  (state.followUps ??= []).push(delivery);
  state.userInput = followUpText(state);
  state.resumeSessionId = opts.sessionId;
  return delivery;
}

/**
 * An attempt is starting and carries whatever was queued: every pending delivery becomes `delivered` and
 * records the attempt that took it. Returns them, for the caller that emits the run-log summaries.
 */
export function markFollowUpsDelivered(state: TaskRunState, attempt: number): PromptDelivery[] {
  const carried = pendingFollowUps(state);
  for (const delivery of carried) {
    delivery.state = 'delivered';
    delivery.carriedByAttempt = attempt;
  }
  return carried;
}

/**
 * The session a follow-up is about to continue, checked against the disk (`[D25]`).
 *
 * Three answers, and only one of them stops anything: a session that is **gone** is refused with the
 * fresh-session option spelled out, because `claude --resume` and `codex resume` both answer a session they
 * cannot find by quietly starting a new one — and an operator who meant "carry on from there" would get a
 * worker that has forgotten everything without a word being said about it.
 */
export interface SessionCheck {
  /** The session the attempt will continue, or undefined for a fresh one. */
  sessionId?: string;
  /** Set when the follow-up must not be started: the sentence to refuse it with. */
  rejection?: string;
}

export interface SessionCheckOptions {
  probe: SessionProbe;
  /** `--fresh-session` / "Start a fresh session": start over deliberately, whatever is on disk. */
  freshSession?: boolean;
  /** Who is being refused, so the refusal names a control they have. Defaults to the command line's. */
  source?: ControlSource;
}

/**
 * How to say "start a fresh session" to the surface that is being refused (§3.5, `[D25]`).
 *
 * The same reasoning as `selectPromptMode`'s mode flags: a refusal is only actionable if it names something
 * the reader can actually do. Telling a workspace operator to "send it again with --fresh-session" names a
 * flag there is nowhere to type.
 */
export const FRESH_SESSION_KEY = 'Ctrl+F';

export function freshSessionOption(source?: ControlSource): string {
  return namesFlags(source) ? '--fresh-session' : `${FRESH_SESSION_KEY} ("Start a fresh session")`;
}

export async function checkFollowUpSession(task: ResolvedTask, state: TaskRunState, opts: SessionCheckOptions): Promise<SessionCheck> {
  if (opts.freshSession) return {};
  const sessionId = resumableSessionId(task, state);
  // No session to continue is not a problem to report: the message rides in a fresh prompt under
  // `# User Input`, which is the documented behaviour of every task with `resumeSession: false`.
  if (!sessionId) return {};
  const presence = await opts.probe(task, sessionId, lastAttemptCwd(state, task));
  if (presence !== 'missing') return { sessionId };
  return {
    sessionId,
    // "the message", not "the follow-up": this check guards the stop-and-continue row too, and telling an
    // operator who typed a sentence to a running worker to "send the follow-up again" names a mode they
    // never chose and a command they did not run.
    rejection:
      `The ${task.agent} session "${sessionId}" that "${state.id}" would continue is no longer on disk, so resuming it would silently start a new one instead. ` +
      `Send the message again with ${freshSessionOption(opts.source)} to run the task from the top with your message in its prompt.`,
  };
}

/**
 * A run written before follow-ups were records: its `userInput` becomes the delivery it always was.
 *
 * `cao resume --input` used to leave nothing but the text, so a run paused by 0.1.x and continued by this
 * version would otherwise have an answer in its prompt and nothing on screen saying where it came from. The
 * attempt that carried it is recoverable — it is the one `triggeredBy: 'user_input'` — so the reconstructed
 * delivery is honest about whether it is still owed an attempt.
 */
export function adoptLegacyFollowUp(state: TaskRunState): void {
  if (!state.userInput || state.followUps) return;
  const carried = lastTaskAttempt(state)?.triggeredBy === 'user_input' ? lastTaskAttempt(state)!.number : undefined;
  state.followUps = [
    {
      id: `legacy-${state.id}`,
      at: state.startedAt ?? nowIso(),
      source: 'cli',
      mode: 'followUp',
      transport: 'none',
      state: carried === undefined ? 'queued' : 'delivered',
      text: state.userInput,
      ...(carried === undefined ? {} : { carriedByAttempt: carried }),
    },
  ];
}
