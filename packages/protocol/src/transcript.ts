/**
 * One typed entry of a worker transcript. Every surface (dashboard follow view, `cao logs`, `cao peek`,
 * the line renderer) renders this same shape, and the per-attempt events.jsonl stores exactly these entries.
 */
import type { InteractionQuestion } from './interaction.js';

export type FileOp = 'edit' | 'write' | 'delete';

/**
 * Two ids tie the transcript together, both carried by the agent's own stream:
 *  - `toolUseId` on a call and on its result, so a surface can pair them (and show how long the tool took).
 *  - `parentToolUseId` on everything a subagent produced, naming the `Agent:` call that spawned it.
 */
export type TranscriptEntry =
  /** Agent prose (markdown). */
  | { kind: 'text'; ts: string; text: string; parentToolUseId?: string }
  /** A thinking block. Stored in the attempt's events.jsonl, hidden by every surface until asked for. */
  | { kind: 'thinking'; ts: string; text: string; parentToolUseId?: string }
  /** A shell command (Bash/PowerShell). */
  | { kind: 'command'; ts: string; command: string; tool: string; toolUseId?: string; parentToolUseId?: string }
  /** Any other tool call, described in one line. */
  | { kind: 'tool'; ts: string; tool: string; line: string; filePath?: string; fileOp?: FileOp; toolUseId?: string; parentToolUseId?: string }
  /** Tool output, truncated. */
  | { kind: 'tool_result'; ts: string; text: string; isError?: boolean; toolUseId?: string; parentToolUseId?: string }
  | { kind: 'stderr'; ts: string; text: string }
  /**
   * A message the **operator** sent into the running session (spec §3.5, `[D26]`). Not agent output: every
   * surface draws it as the human's turn, so a transcript reads as the conversation it was. `deliveryId`
   * names the `PromptDelivery` on the attempt whose state (queued, accepted, …) this message is at.
   */
  | { kind: 'user'; ts: string; text: string; deliveryId?: string }
  /** The worker asked the human a question (AskUserQuestion). */
  | { kind: 'question'; ts: string; id: string; questions: InteractionQuestion[]; answer?: string }
  /** The worker needed a permission decision. */
  | { kind: 'permission'; ts: string; id: string; tool: string; title: string; decision?: 'allow' | 'deny'; message?: string }
  /**
   * A completion result. The attempt's own outcome is written by the runner once, at the end; an
   * `intermediate` one is a completion object the worker emitted mid-turn and then kept working past, and
   * `raw` is that object exactly as the worker wrote it, so nothing an agent produced is lost by classifying it.
   */
  | { kind: 'result'; ts: string; status?: string; summary?: string; costUsd?: number; isError: boolean; error?: string; intermediate?: boolean; raw?: string }
  | { kind: 'error'; ts: string; text: string }
  /** Session start/resume, compaction, orchestrator notes. */
  | { kind: 'system'; ts: string; text: string }
  /**
   * An event type this build does not know (spec §4.5). The transcript is an **open enum**: new kinds land in
   * `cao` first and are read by an older surface, so one that is dropped is a worker's work made invisible by a
   * version number. `type` is the `kind` (or legacy `type`) as it was written, and `raw` is the line itself,
   * unparsed — which is also how "unknown fields are preserved on any round-trip" is satisfied here.
   */
  | { kind: 'unknown'; ts: string; type: string; raw: string };

export type TranscriptKind = TranscriptEntry['kind'];

/** An entry without its timestamp (distributes over the union). */
export type TranscriptEntryInput = TranscriptEntry extends infer E ? (E extends TranscriptEntry ? Omit<E, 'ts'> : never) : never;

const firstLine = (text: string): string => (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim();

/** One-line plain summary (status column, live.json, failure context). */
export function transcriptLine(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'text':
      return firstLine(entry.text.replace(/^#+\s*/gm, ''));
    case 'thinking':
      return `(thinking) ${firstLine(entry.text)}`;
    case 'command':
      return `$ ${firstLine(entry.command)}`;
    case 'tool':
      return entry.line;
    case 'tool_result':
      return `${entry.isError ? '! ' : '-> '}${firstLine(entry.text)}`;
    case 'stderr':
      return `[stderr] ${entry.text}`;
    case 'user':
      return `> ${firstLine(entry.text)}`;
    case 'question':
      return `? ${entry.questions[0]?.question ?? 'question'}${entry.answer ? ` -> ${entry.answer}` : ''}`;
    case 'permission':
      return `? ${entry.title}${entry.decision ? ` -> ${entry.decision}` : ''}`;
    case 'result':
      // Never the raw object: this line is the activity column, live.json and the failure context.
      return `${entry.intermediate ? 'intermediate result' : 'result'}: ${entry.status ?? (entry.isError ? 'error' : 'done')}${entry.summary ? ` - ${firstLine(entry.summary)}` : ''}`;
    case 'error':
      return `error: ${firstLine(entry.text)}`;
    case 'system':
      return entry.text;
    // Never the raw record: this line is the activity column and live.json, where one line is all there is.
    // The surface that can afford the detail renders it from `raw` (§4.5's "JSON detail expander").
    case 'unknown':
      return `(${entry.type})`;
  }
}

const KINDS: ReadonlySet<string> = new Set(['text', 'thinking', 'command', 'tool', 'tool_result', 'stderr', 'user', 'question', 'permission', 'result', 'error', 'system']);

/**
 * Parse one events.jsonl line. Accepts the current entry shape and the legacy `type:` records of older runs.
 *
 * `null` means **unreadable** — not "unknown". A line that is not JSON, or JSON that names no event type at
 * all, is the only thing this drops; a type it simply does not recognise becomes an `unknown` entry and is
 * rendered generically (§4.5).
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const ts = typeof raw.ts === 'string' ? raw.ts : '';
  if (typeof raw.kind === 'string' && KINDS.has(raw.kind)) return { ...(raw as object), ts } as TranscriptEntry;
  // Legacy records written by runners before the typed transcript existed.
  switch (raw.type) {
    case 'activity':
      return { kind: 'tool', ts, tool: String(raw.tool ?? 'tool'), line: String(raw.line ?? '') };
    case 'command':
      return { kind: 'command', ts, command: String(raw.command ?? ''), tool: String(raw.tool ?? 'Bash') };
    case 'text':
      return { kind: 'text', ts, text: String(raw.text ?? '') };
    case 'result':
      return { kind: 'result', ts, status: raw.subtype as string | undefined, costUsd: raw.costUsd as number | undefined, isError: Boolean(raw.isError) };
    case 'error':
      return { kind: 'error', ts, text: String(raw.message ?? 'agent error') };
    case 'init':
      return { kind: 'system', ts, text: `session ${raw.sessionId ?? ''}${raw.model ? ` (${raw.model})` : ''}` };
    case 'resume':
      return { kind: 'system', ts, text: `resumed session ${raw.sessionId ?? ''}` };
    case 'raw':
      return { kind: 'stderr', ts, text: String(raw.line ?? '') };
    default:
      break;
  }
  // §4.5 — "Unknown event types: rendered generically ... never dropped." Carried through with its name and
  // the line exactly as written; a record that names no type at all is the unreadable case above.
  const type = typeof raw.kind === 'string' ? raw.kind : typeof raw.type === 'string' ? raw.type : null;
  return type === null ? null : { kind: 'unknown', ts, type, raw: line };
}
