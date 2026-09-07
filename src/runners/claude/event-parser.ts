/**
 * Parses Claude Code `--output-format stream-json` NDJSON lines into normalized events.
 * Everything Claude-specific about the transport lives here.
 */
import { firstLine, truncate } from '../../util/misc.js';
import type { RunnerUsage } from '../../types/result.js';
import type { FileOp } from '../../types/transcript.js';

export interface ClaudeInitEvent {
  kind: 'init';
  sessionId?: string;
  model?: string;
  /** The permission mode the CLI actually started the session in, which can differ from the one requested. */
  permissionMode?: string;
}
export interface ClaudeActivityEvent {
  kind: 'activity';
  line: string;
  tool: string;
  filePath?: string;
  fileOp?: FileOp;
  toolUseId?: string;
  parentToolUseId?: string;
}
export interface ClaudeCommandEvent {
  kind: 'command';
  command: string;
  tool: string;
  toolUseId?: string;
  parentToolUseId?: string;
}
export interface ClaudeTextEvent {
  kind: 'text';
  text: string;
  parentToolUseId?: string;
}
/** A `thinking` content block. Only ever shown on request, so nothing else in the pipeline reacts to it. */
export interface ClaudeThinkingEvent {
  kind: 'thinking';
  text: string;
  parentToolUseId?: string;
}
export interface ClaudeToolResultEvent {
  kind: 'tool_result';
  toolUseId?: string;
  parentToolUseId?: string;
  text: string;
  isError: boolean;
}
/** Usage of one assistant message: the context size of that call plus per-message token counts. */
export interface ClaudeUsageEvent {
  kind: 'usage';
  messageId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
export interface ClaudeCompactEvent {
  kind: 'compact';
}
export interface ClaudeControlRequestEvent {
  kind: 'control_request';
  requestId: string;
  subtype: string;
  request: Record<string, unknown>;
}
export interface ClaudeControlCancelEvent {
  kind: 'control_cancel';
  requestId: string;
}
export interface ClaudeResultEvent {
  kind: 'result';
  subtype?: string;
  isError: boolean;
  resultText?: string;
  structuredOutput?: unknown;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  stopReason?: string;
  permissionDenials?: unknown[];
  /** Totals across every model call of the session (from `modelUsage`), when present. */
  usage?: RunnerUsage;
}
export interface ClaudeOtherEvent {
  kind: 'other';
  type: string;
}
export type ClaudeEvent =
  | ClaudeInitEvent
  | ClaudeActivityEvent
  | ClaudeCommandEvent
  | ClaudeTextEvent
  | ClaudeThinkingEvent
  | ClaudeToolResultEvent
  | ClaudeUsageEvent
  | ClaudeCompactEvent
  | ClaudeControlRequestEvent
  | ClaudeControlCancelEvent
  | ClaudeResultEvent
  | ClaudeOtherEvent;

const MAX_ACTIVITY = 120;
const MAX_TOOL_RESULT_CHARS = 2000;
const MAX_TOOL_RESULT_LINES = 20;

const FILE_TOOLS: Record<string, FileOp> = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };

function str(input: Record<string, unknown>, k: string): string | undefined {
  return typeof input[k] === 'string' ? (input[k] as string) : undefined;
}

/** Human-readable one-liner for a tool call. */
export function describeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name} ${str(input, 'file_path') ?? str(input, 'notebook_path') ?? ''}`.trim();
    case 'Bash':
    case 'PowerShell':
      return `${name}: ${firstLine(str(input, 'command') ?? '')}`;
    case 'Grep':
      return `Grep: ${str(input, 'pattern') ?? ''}${str(input, 'path') ? ` in ${str(input, 'path')}` : ''}`;
    case 'Glob':
      return `Glob: ${str(input, 'pattern') ?? ''}`;
    case 'Agent':
    case 'Task':
      return `Agent: ${str(input, 'description') ?? firstLine(str(input, 'prompt') ?? '')}`;
    case 'WebFetch':
      return `WebFetch: ${str(input, 'url') ?? ''}`;
    case 'WebSearch':
      return `WebSearch: ${str(input, 'query') ?? ''}`;
    case 'Skill':
      return `Skill: /${str(input, 'skill') ?? ''} ${str(input, 'args') ?? ''}`.trim();
    case 'TodoWrite':
      return 'Updating todo list';
    case 'StructuredOutput':
      return 'Reporting the result';
    case 'AskUserQuestion': {
      const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
      const first = questions[0] ? str(questions[0], 'question') : undefined;
      return `Asking: ${first ?? 'a question'}`;
    }
    default: {
      const first = Object.entries(input).find(([, v]) => typeof v === 'string');
      return first ? `${name}: ${firstLine(first[1] as string)}` : name;
    }
  }
}

/** Flatten a tool_result content value (string or content blocks) into text. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string') return (block as Record<string, unknown>).text as string;
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function truncateResult(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.length > MAX_TOOL_RESULT_LINES ? `${lines.slice(0, MAX_TOOL_RESULT_LINES).join('\n')}\n… (${lines.length - MAX_TOOL_RESULT_LINES} more lines)` : text;
  return truncate(cut, MAX_TOOL_RESULT_CHARS);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse one stream-json line into zero or more events (an assistant message may carry several blocks). */
export function parseClaudeEvents(line: string): ClaudeEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(msg.type ?? '');
  if (type === 'system') {
    if (msg.subtype === 'init') {
      return [{ kind: 'init', sessionId: msg.session_id as string | undefined, model: msg.model as string | undefined, permissionMode: str(msg, 'permissionMode') }];
    }
    if (msg.subtype === 'compact_boundary') return [{ kind: 'compact' }];
    return [{ kind: 'other', type: `system.${String(msg.subtype ?? '')}` }];
  }
  // Set on every message a subagent produced; names the Agent/Task tool call that spawned it.
  const parentToolUseId = str(msg, 'parent_tool_use_id');
  if (type === 'assistant') {
    const message = msg.message as { id?: string; model?: string; content?: unknown; usage?: Record<string, unknown> } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
    const events: ClaudeEvent[] = [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const input = (block.input ?? {}) as Record<string, unknown>;
        const toolUseId = str(block, 'id');
        if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
          events.push({ kind: 'command', command: input.command, tool: name, toolUseId, parentToolUseId });
          continue;
        }
        const ev: ClaudeActivityEvent = { kind: 'activity', line: truncate(describeToolUse(name, input), MAX_ACTIVITY), tool: name, toolUseId, parentToolUseId };
        const fileOp = FILE_TOOLS[name];
        const filePath = str(input, 'file_path') ?? str(input, 'notebook_path');
        if (fileOp && filePath) {
          ev.filePath = filePath;
          ev.fileOp = fileOp;
        }
        events.push(ev);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'text', text: block.text, parentToolUseId });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        // `redacted_thinking` blocks carry no readable text and are deliberately dropped.
        events.push({ kind: 'thinking', text: block.thinking, parentToolUseId });
      }
    }
    const usage = message?.usage;
    if (usage && typeof usage === 'object') {
      events.push({
        kind: 'usage',
        messageId: typeof message?.id === 'string' ? message.id : undefined,
        model: typeof message?.model === 'string' ? message.model : undefined,
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
      });
    }
    return events.length ? events : [{ kind: 'other', type: 'assistant' }];
  }
  if (type === 'user') {
    const message = msg.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
    const events: ClaudeEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const text = truncateResult(flattenContent(block.content));
      events.push({ kind: 'tool_result', toolUseId: str(block, 'tool_use_id'), parentToolUseId, text, isError: Boolean(block.is_error) });
    }
    return events.length ? events : [{ kind: 'other', type: 'user' }];
  }
  if (type === 'control_request') {
    const request = (msg.request ?? {}) as Record<string, unknown>;
    return [{ kind: 'control_request', requestId: String(msg.request_id ?? ''), subtype: String(request.subtype ?? ''), request }];
  }
  if (type === 'control_cancel_request') return [{ kind: 'control_cancel', requestId: String(msg.request_id ?? '') }];
  if (type === 'result') {
    const modelUsage = msg.modelUsage && typeof msg.modelUsage === 'object' ? (msg.modelUsage as Record<string, Record<string, unknown>>) : undefined;
    let usage: RunnerUsage | undefined;
    if (modelUsage) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
      let biggestWindow = 0;
      for (const [model, u] of Object.entries(modelUsage)) {
        usage.inputTokens! += num(u.inputTokens);
        usage.outputTokens! += num(u.outputTokens);
        usage.cacheReadTokens! += num(u.cacheReadInputTokens);
        usage.cacheCreationTokens! += num(u.cacheCreationInputTokens);
        usage.costUsd! += num(u.costUSD);
        if (num(u.contextWindow) > biggestWindow) {
          biggestWindow = num(u.contextWindow);
          usage.contextWindow = biggestWindow;
          usage.model = model;
        }
      }
    }
    return [
      {
        kind: 'result',
        subtype: msg.subtype as string | undefined,
        isError: Boolean(msg.is_error),
        resultText: typeof msg.result === 'string' ? msg.result : undefined,
        structuredOutput: msg.structured_output,
        sessionId: msg.session_id as string | undefined,
        costUsd: (msg.total_cost_usd as number | undefined) ?? (msg.cost_usd as number | undefined),
        durationMs: msg.duration_ms as number | undefined,
        numTurns: msg.num_turns as number | undefined,
        stopReason: msg.stop_reason as string | undefined,
        permissionDenials: Array.isArray(msg.permission_denials) ? (msg.permission_denials as unknown[]) : undefined,
        usage,
      },
    ];
  }
  return [{ kind: 'other', type: type || 'unknown' }];
}

/** First event of a line, or null when the line is not stream-json. Kept for API compatibility. */
export function parseClaudeLine(line: string): ClaudeEvent | null {
  return parseClaudeEvents(line)[0] ?? null;
}

/** Human-readable activity line for a text block (first meaningful line). */
export function activityFromText(text: string): string {
  return truncate(firstLine(text.replace(/^#+\s*/gm, '')), MAX_ACTIVITY);
}
