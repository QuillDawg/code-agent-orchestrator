/**
 * Telling the completion object apart from what the agent actually said.
 *
 * Every worker is told to end with a single JSON completion object. That object is protocol, not speech: if a
 * runner records it as agent prose then `cao logs`, `cao peek`, the dashboard follow view and the one-line
 * activity column all print `{"status":"success","summary":"..."` where the agent's own words belong. Workers
 * also emit one mid-turn and keep working, so this is not only about the last message of an attempt.
 *
 * Both Codex runners and the Claude runner route agent text through here, so the three of them classify it the
 * same way. Nothing agent-specific lives in this file beyond the validator the caller passes in, which is why
 * it sits in `src/runners/` rather than under one agent's directory.
 */
import { findJsonObject, validateTaskResult, type ParseFailure, type ParsedResult } from './contract.js';
import { transcriptLine, type TranscriptEntry, type TaskResult } from 'code-agent-orchestrator-protocol';
import { truncate } from '../util/misc.js';

/** The contract validator to judge a candidate with: the shared one, or a runner's own decoding of it. */
export type CompletionValidator = (value: unknown) => ParsedResult | ParseFailure;

/** Same budget as the activity lines the runners produce themselves. */
const MAX_ACTIVITY = 120;

export interface AgentText {
  /** What the agent said around the object; empty when the message was nothing but the object. */
  prose: string;
  /** The completion object the message carried, when it carried one. */
  completion?: { result: TaskResult; raw: string };
}

/**
 * Split one agent message into the prose it is and the completion object it may contain.
 *
 * A completion object is a JSON object - bare, fenced, or surrounded by prose - that carries a `status` and
 * satisfies the contract. Anything else is prose and stays prose: a JSON object with no `status` (a config the
 * worker was showing off, a tool result it pasted), malformed JSON, and text that merely talks about JSON.
 */
export function splitCompletionObject(text: string, validate: CompletionValidator = validateTaskResult): AgentText {
  const message = text ?? '';
  // A completion object always spells its `status` key, so a message without one cannot contain one. This runs
  // on every agent message, including pasted dumps, and the check keeps those off the brace scanner entirely.
  if (!message.includes('"status"')) return { prose: message };
  const match = findJsonObject(message);
  if (!match || !('status' in match.value)) return { prose: message };
  const validated = validate(match.value);
  if (!validated.ok) return { prose: message };
  // Prose on both sides of the object closes back up into one message; a runner records that, and the object
  // separately, so nothing the agent said is lost and nothing it emitted is shown as speech.
  const before = message.slice(0, match.start).trim();
  const after = message.slice(match.end).trim();
  return { prose: before && after ? `${before}\n\n${after}` : before || after, completion: { result: validated.result, raw: match.text } };
}

/** One transcript entry and the activity line that announces it. */
export interface AgentTextEvent {
  entry: TranscriptEntry;
  activity: string;
}

/**
 * What one agent message becomes in the transcript: prose stays a `text` entry, and a completion object
 * becomes a `result` entry instead. A message that is both is recorded as both, prose first.
 *
 * The result entry is marked `intermediate`: at the moment a message arrives the attempt is still running,
 * and the authoritative outcome is decided afterwards from `final.json` (Codex exec), the last agent message
 * (Codex app-server) or `structured_output` (Claude). One message cannot tell whether it is the last, so the
 * flag is provisional here and `completionTranscript` below takes it off again when the object turns out to
 * be the outcome. It carries the object verbatim in `raw` so `cao logs --json` and a debugger still see
 * exactly what the worker produced.
 *
 * `activity` is how this runner summarises prose for the activity line; a completion object is summarised here
 * instead, because that line must never start with `{`.
 */
export function agentTextEvents(text: string, ts: string, opts: { activity: (prose: string) => string; validate?: CompletionValidator; parentToolUseId?: string }): AgentTextEvent[] {
  const parent = opts.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {};
  const { prose, completion } = splitCompletionObject(text, opts.validate);
  if (!completion) return [{ entry: { kind: 'text', ts, text, ...parent }, activity: opts.activity(text) }];
  const events: AgentTextEvent[] = [];
  if (prose) events.push({ entry: { kind: 'text', ts, text: prose, ...parent }, activity: opts.activity(prose) });
  const entry: TranscriptEntry = {
    kind: 'result',
    ts,
    status: completion.result.status,
    summary: completion.result.summary,
    isError: false,
    intermediate: true,
    raw: completion.raw,
    ...(completion.result.error ? { error: completion.result.error } : {}),
  };
  events.push({ entry, activity: truncate(transcriptLine(entry), MAX_ACTIVITY) });
  return events;
}

/** A `result` entry, named for the places below that hold one back. */
type ResultEntry = Extract<TranscriptEntry, { kind: 'result' }>;

/**
 * The attempt's transcript, with the completion object it ends on held back until the outcome is known.
 *
 * `agentTextEvents` sees one message at a time, so it cannot tell the object a worker emitted mid-turn from
 * the one it finished on: it marks both intermediate. Left at that, every successful attempt ends with the
 * same summary twice - once as `intermediate result: success - …` and once as the outcome - and the entry
 * that is genuinely authoritative is the one labelled provisional.
 *
 * So the most recent completion object is held here. Anything that follows it proves it was a checkpoint and
 * it is written as one; if instead the attempt's outcome turns out to be that same object, the two are one
 * event and are written once, as the outcome, keeping the object's own bytes in `raw`.
 */
export interface CompletionTranscript {
  /** Record an entry, in order. A completion object is held until something follows it. */
  entry: (value: TranscriptEntry) => void;
  /** Close the log with the attempt's outcome, decided by the runner. */
  finish: (value: TranscriptEntry) => void;
  /** Write anything still held: for the outcomes a runner returns without recording an entry for. */
  flush: () => void;
}

/** Whether a held completion object and the attempt's outcome are the same event rather than two. */
function sameOutcome(held: ResultEntry, final: ResultEntry): boolean {
  return !final.intermediate && held.status === final.status && (held.summary ?? '') === (final.summary ?? '') && (held.error ?? '') === (final.error ?? '');
}

export function completionTranscript(write: (value: TranscriptEntry) => void): CompletionTranscript {
  let held: ResultEntry | undefined;
  const flush = (): void => {
    if (!held) return;
    const value = held;
    held = undefined;
    write(value);
  };
  return {
    entry: (value) => {
      flush();
      if (value.kind === 'result' && value.intermediate) held = value;
      else write(value);
    },
    finish: (value) => {
      if (held && value.kind === 'result' && sameOutcome(held, value)) {
        const { raw } = held;
        held = undefined;
        write(raw === undefined ? value : { ...value, raw });
        return;
      }
      flush();
      write(value);
    },
    flush,
  };
}
