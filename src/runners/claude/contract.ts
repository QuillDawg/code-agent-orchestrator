/** The worker completion contract: JSON schema handed to Claude and the validator applied to its output. */
import { z } from 'zod';
import { TASK_RESULT_STATUSES, type TaskResult, type TaskResultStatus } from '../../types/result.js';

const stringArray = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .transform((arr) => arr.filter((v) => v !== null).map((v) => String(v)));

export const taskResultSchema = z
  .object({
    status: z.enum(TASK_RESULT_STATUSES),
    summary: z.string().optional(),
    filesChanged: stringArray.optional().default([]),
    commits: stringArray.optional().default([]),
    decisions: stringArray.optional().default([]),
    warnings: stringArray.optional().default([]),
    followUp: stringArray.optional().default([]),
    error: z.string().optional(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** JSON Schema string passed to `claude --json-schema`. Kept compact to stay well under argv limits. */
export const TASK_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...TASK_RESULT_STATUSES] },
    summary: { type: 'string', description: 'Concise summary of what was done and the outcome' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' }, description: 'Commit SHAs or messages created' },
    decisions: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    followUp: { type: 'array', items: { type: 'string' } },
    error: { type: 'string', description: 'Why the task failed or is blocked (when status is not success)' },
    data: { type: 'object', additionalProperties: true },
  },
  required: ['status', 'summary'],
  additionalProperties: true,
} as const;

export const TASK_RESULT_JSON_SCHEMA_STRING = JSON.stringify(TASK_RESULT_JSON_SCHEMA);

export const CONTRACT_SYSTEM_PROMPT = [
  'You are an autonomous worker inside an orchestrated workflow. Ask with AskUserQuestion only when you are truly blocked on a decision only the user can make; a human may take a while to answer or may be unavailable. If a permission or question is denied, do not retry it: finish with status "needs_input" (or "blocked") and explain exactly what you need.',
  'When your work is complete, your FINAL response must be a single JSON object (no surrounding prose) matching this shape:',
  '{"status":"success|failed|blocked|needs_input|skipped","summary":"...","filesChanged":["..."],"commits":["..."],"decisions":["..."],"warnings":["..."],"followUp":["..."],"error":"..."}',
  'Use "success" only if the requested work is actually done and verified. Use "failed" when you could not complete it.',
].join('\n');

/** Words a model reaches for instead of the contract's status vocabulary. Matched after trimming and lower-casing. */
const STATUS_ALIASES: Record<string, TaskResultStatus> = {
  succeeded: 'success',
  successful: 'success',
  completed: 'success',
  complete: 'success',
  done: 'success',
  ok: 'success',
  failure: 'failed',
  error: 'failed',
  errored: 'failed',
  'needs input': 'needs_input',
  'needs-input': 'needs_input',
  needsinput: 'needs_input',
  input_required: 'needs_input',
  'input required': 'needs_input',
  block: 'blocked',
  skip: 'skipped',
};

export const MISSING_SUMMARY = '(no summary provided)';

/**
 * What a weaker model gets wrong without meaning anything different: `null` for fields that do not apply
 * (the schema only allows omission), and a status in the wrong case or a synonym of the contract's word.
 * Everything else is left for the schema to judge.
 */
export function normalizeCandidate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null) out[k] = v;
  if (typeof out.status === 'string') {
    const key = out.status.trim().toLowerCase();
    out.status = STATUS_ALIASES[key] ?? key;
  }
  return out;
}

export interface ParsedResult {
  ok: true;
  result: TaskResult;
}
export interface ParseFailure {
  ok: false;
  error: string;
}

export function validateTaskResult(value: unknown): ParsedResult | ParseFailure {
  const parsed = taskResultSchema.safeParse(normalizeCandidate(value));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `Result does not match the completion contract: ${issues}` };
  }
  const { status, summary, filesChanged, commits, decisions, warnings, followUp, error, data } = parsed.data;
  const result: TaskResult = { status, summary: summary?.trim() || '', filesChanged, commits, decisions, warnings, followUp };
  if (!result.summary) {
    // A valid status with nothing said about it is still a usable result; the gap is recorded where a reviewer looks.
    result.summary = error?.trim() || MISSING_SUMMARY;
    result.warnings = [...warnings, 'The worker returned no summary'];
  }
  if (error) result.error = error;
  if (data) result.data = data;
  return { ok: true, result };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fallback: find the completion object in free-form text. Fenced blocks are tried last-to-first, preferring
 * one that carries a `status` over a trailing fence that merely happens to be JSON (a config the worker was
 * showing off); then the last balanced object with a `status` key.
 */
export function extractJsonObject(text: string): unknown | undefined {
  if (!text) return undefined;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => parseObject((m[1] ?? '').trim())).filter((o): o is Record<string, unknown> => o !== undefined);
  const withStatus = [...fences].reverse().find((o) => 'status' in o);
  if (withStatus) return withStatus;
  // Scan for a balanced object from the last "{" that contains "status".
  let end = text.length;
  while (end > 0) {
    const close = text.lastIndexOf('}', end - 1);
    if (close < 0) break;
    let depth = 0;
    for (let i = close; i >= 0; i--) {
      const ch = text[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        depth--;
        if (depth === 0) {
          const parsed = parseObject(text.slice(i, close + 1));
          if (parsed && 'status' in parsed) return parsed;
          break;
        }
      }
    }
    end = close;
  }
  return fences[fences.length - 1];
}
