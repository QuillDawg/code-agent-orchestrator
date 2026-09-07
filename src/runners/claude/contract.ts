/** The worker completion contract: JSON schema handed to Claude and the validator applied to its output. */
import { z } from 'zod';
import { TASK_RESULT_STATUSES, type TaskResult } from '../../types/result.js';

const stringArray = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .transform((arr) => arr.filter((v) => v !== null).map((v) => String(v)));

export const taskResultSchema = z
  .object({
    status: z.enum(TASK_RESULT_STATUSES),
    summary: z.string().min(1),
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

export interface ParsedResult {
  ok: true;
  result: TaskResult;
}
export interface ParseFailure {
  ok: false;
  error: string;
}

export function validateTaskResult(value: unknown): ParsedResult | ParseFailure {
  const parsed = taskResultSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `Result does not match the completion contract: ${issues}` };
  }
  const { status, summary, filesChanged, commits, decisions, warnings, followUp, error, data } = parsed.data;
  const result: TaskResult = { status, summary, filesChanged, commits, decisions, warnings, followUp };
  if (error) result.error = error;
  if (data) result.data = data;
  return { ok: true, result };
}

/** Fallback: find the last JSON object in free-form text (```json fences or bare). */
export function extractJsonObject(text: string): unknown | undefined {
  if (!text) return undefined;
  const fence = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fence.length - 1; i >= 0; i--) {
    try {
      return JSON.parse((fence[i]![1] ?? '').trim());
    } catch {
      /* try next */
    }
  }
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
          const candidate = text.slice(i, close + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
          } catch {
            /* keep scanning */
          }
          break;
        }
      }
    }
    end = close;
  }
  return undefined;
}
