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
  /** The worker asked the human a question (AskUserQuestion). */
  | { kind: 'question'; ts: string; id: string; questions: InteractionQuestion[]; answer?: string }
  /** The worker needed a permission decision. */
  | { kind: 'permission'; ts: string; id: string; tool: string; title: string; decision?: 'allow' | 'deny'; message?: string }
  | { kind: 'result'; ts: string; status?: string; summary?: string; costUsd?: number; isError: boolean; error?: string }
  | { kind: 'error'; ts: string; text: string }
  /** Session start/resume, compaction, orchestrator notes. */
  | { kind: 'system'; ts: string; text: string };

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
    case 'question':
      return `? ${entry.questions[0]?.question ?? 'question'}${entry.answer ? ` -> ${entry.answer}` : ''}`;
    case 'permission':
      return `? ${entry.title}${entry.decision ? ` -> ${entry.decision}` : ''}`;
    case 'result':
      return `result: ${entry.status ?? (entry.isError ? 'error' : 'done')}${entry.summary ? ` - ${firstLine(entry.summary)}` : ''}`;
    case 'error':
      return `error: ${firstLine(entry.text)}`;
    case 'system':
      return entry.text;
  }
}

const KINDS: ReadonlySet<string> = new Set(['text', 'thinking', 'command', 'tool', 'tool_result', 'stderr', 'question', 'permission', 'result', 'error', 'system']);

/** Parse one events.jsonl line. Accepts the current entry shape and the legacy `type:` records of older runs. */
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
      return null;
  }
}
