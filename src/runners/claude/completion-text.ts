/**
 * Telling the completion object apart from what the agent actually said.
 *
 * Every worker is told to end with a single JSON completion object. That object is protocol, not speech: if a
 * runner records it as agent prose then `cao logs`, `cao peek`, the dashboard follow view and the one-line
 * activity column all print `{"status":"success","summary":"..."` where the agent's own words belong. Workers
 * also emit one mid-turn and keep working, so this is not only about the last message of an attempt.
 *
 * Both Codex runners and the Claude runner route agent text through here, so the three of them classify it the
 * same way. Nothing agent-specific lives in this file beyond the validator the caller passes in.
 */
import { findJsonObject, validateTaskResult, type ParseFailure, type ParsedResult } from './contract.js';
import { transcriptLine, type TranscriptEntry } from '../../types/transcript.js';
import type { TaskResult } from '../../types/result.js';
import { truncate } from '../../util/misc.js';

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
 * The result entry is always `intermediate`: at the moment a message arrives the attempt is still running, and
 * the authoritative outcome is decided afterwards from `final.json` (Codex exec), the last agent message
 * (Codex app-server) or `structured_output` (Claude). It carries the object verbatim in `raw` so
 * `cao logs --json` and a debugger still see exactly what the worker produced.
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
