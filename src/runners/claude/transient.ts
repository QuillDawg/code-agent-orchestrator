import type { ConfigRejection } from '../outcomes.js';

/**
 * Classifies worker failures that are almost certainly temporary infrastructure problems rather than
 * something wrong with the task: API 5xx/overloaded/rate-limit responses and network drops. Claude Code in
 * print mode exits when such an error is not recovered by its own retries, so the orchestrator resumes the
 * session instead of counting the attempt as a real failure.
 */

const TRANSIENT_PATTERNS: RegExp[] = [
  /\bAPI Error:?\s*(?:5\d\d|429)\b/i,
  /\b(?:5\d\d|429)\b[^\n]{0,40}\b(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded|too many requests)/i,
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway time-?out\b/i,
  /\boverloaded(?:_error)?\b/i,
  /\brate[ _-]?limit(?:ed|_error)?\b/i,
  /\btoo many requests\b/i,
  /\bapi_error\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED)\b/,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\bnetwork error\b/i,
  /\bconnection (?:error|reset|closed|refused|timed out)\b/i,
  /\brequest timed out\b/i,
  /\bAPI (?:connection|request) (?:error|timeout|timed out)\b/i,
  /\bstream (?:error|closed|ended) unexpectedly\b/i,
  /\bmodel (?:is )?(?:currently )?(?:unavailable|overloaded)\b/i,
];

/** Errors that look transient on the surface but must never be retried automatically. */
const PERMANENT_PATTERNS: RegExp[] = [
  /\bAPI Error:?\s*(?:400|401|403|404|413|422)\b/i,
  /\b(?:invalid|expired) (?:api key|token|credentials)\b/i,
  /\bauthentication(?:_error)?\b/i,
  /\bpermission(?:_error| denied)\b/i,
  /\bbilling\b/i,
  /\binsufficient (?:credit|quota|funds)\b/i,
  /\bcontext (?:window|length) exceeded\b/i,
  /\bprompt is too long\b/i,
  /\bmax(?:imum)? (?:turns|budget)\b/i,
  /\bbudget exceeded\b/i,
];

/** True when the text describes a temporary API/network failure worth recovering from by resuming the session. */
export function isTransientApiError(text: string | undefined | null): boolean {
  if (!text) return false;
  if (PERMANENT_PATTERNS.some((re) => re.test(text))) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Configuration rejections (H4.2)
// ---------------------------------------------------------------------------

/**
 * The mirror image of the classifier above: a failure that is *never* worth another attempt because the CLI
 * refused what CAO sent it. Commander rejects an unknown or malformed option before the session starts and
 * exits with a usage block; the model API rejects a `--json-schema` that is not strict. Both used to be
 * `crash`, and both were then retried under `retry.attempts` for nothing.
 */
const CLAUDE_FLAG_KEYS: Array<[RegExp, string]> = [
  [/^--model$/, "the task's model (or claude.model)"],
  [/^--effort$/, "the task's effort (or claude.effort)"],
  [/^--permission-mode$/, 'claude.permissionMode'],
  [/^(?:--permission-prompt-tool|--permission-prompts|--input-format)$/, 'claude.permissionPrompts'],
  [/^--safe-mode$/, 'claude.configMode'],
  [/^--allowed-?[Tt]ools$/, 'claude.allowedTools'],
  [/^--disallowed-?[Tt]ools$/, 'claude.disallowedTools'],
  [/^--add-dir$/, 'claude.addDirs'],
  [/^--max-budget-usd$/, 'claude.maxBudgetUsd'],
  [/^--append-system-prompt$/, 'claude.appendSystemPrompt'],
  [/^--no-session-persistence$/, 'claude.sessionPersistence'],
  [/^--json-schema$/, 'the completion contract'],
  [/^(?:--output-format|--verbose|-p|--print)$/, 'the orchestrator itself'],
  [/^(?:--session-id|--resume)$/, 'retry.resumeSession'],
  [/^--forward-subagent-text$/, 'the detected CLI capabilities'],
];

/** The workflow key a Claude flag came from; anything else can only have come from raw passthrough. */
export function claudeOptionKey(option: string): string {
  const flag = option.replace(/[=<\s].*$/, '').trim();
  return CLAUDE_FLAG_KEYS.find(([pattern]) => pattern.test(flag))?.[1] ?? 'claude.extraArgs';
}

const CLAUDE_ERROR_LINE = /^\s*error:\s*(.+)$/m;
const CLAUDE_USAGE_BLOCK = /^\s*Usage:\s+\S/m;
const CLAUDE_SCHEMA_REJECTION = /invalid_json_schema|Invalid schema for response_format|json_schema.*(?:is invalid|must be)/i;
const CLAUDE_QUOTED_FLAG = /'(-{1,2}[A-Za-z][\w-]*)[^']*'/g;

function claudeLineMatching(text: string, pattern: RegExp): string | undefined {
  return text.split(/\r?\n/).find((line) => pattern.test(line));
}

/**
 * Argv-parsing complaints, in commander's wording. The exit code alone cannot be trusted (an ordinary
 * session failure also exits non-zero and may write `error:` lines of its own), so the shape of the
 * complaint is what marks it as parsing rather than working.
 */
const CLAUDE_ARGV_ERROR =
  /^(?:unknown option|unknown command|unknown argument|too many arguments|missing required (?:option|argument)|option .* argument (?:missing|invalid)|invalid (?:value|argument) )/i;

/**
 * Classify text a Claude session failed with (stderr, or the error result's text). Returns the rejection
 * when the CLI or the API refused CAO's invocation, and undefined for everything else.
 */
export function claudeConfigRejection(input: { exitCode?: number | null; stderr?: string; resultText?: string }): ConfigRejection | undefined {
  const stderr = input.stderr ?? '';
  const resultText = input.resultText ?? '';
  const schemaLine = claudeLineMatching(resultText, CLAUDE_SCHEMA_REJECTION) ?? claudeLineMatching(stderr, CLAUDE_SCHEMA_REJECTION);
  if (schemaLine) return { detail: schemaLine.trim(), option: '--json-schema', key: 'the completion contract' };
  const error = CLAUDE_ERROR_LINE.exec(stderr);
  if (!error) return undefined;
  const text = error[1]!.trim();
  if (!CLAUDE_ARGV_ERROR.test(text) && !CLAUDE_USAGE_BLOCK.test(stderr)) return undefined;
  const flags = [...new Set([...text.matchAll(CLAUDE_QUOTED_FLAG)].map((match) => match[1]!))];
  const keys = [...new Set(flags.map((flag) => claudeOptionKey(flag)))];
  return {
    detail: `error: ${text}`,
    ...(flags.length ? { option: flags.join(' with ') } : {}),
    ...(keys.length ? { key: keys.join(' and ') } : {}),
  };
}
