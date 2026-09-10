import type { RunnerFailure } from 'code-agent-orchestrator-protocol';
import type { ConfigRejection } from '../outcomes.js';

const RETRYABLE_CODES = new Set([
  'rateLimitExceeded',
  'serverOverloaded',
  'internalServerError',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

function unpack(info: unknown): { code?: string; httpStatus?: number } {
  if (typeof info === 'string') return { code: info };
  if (!info || typeof info !== 'object' || Array.isArray(info)) return {};
  const [code, details] = Object.entries(info as Record<string, unknown>)[0] ?? [];
  const status = details && typeof details === 'object' ? (details as Record<string, unknown>).httpStatusCode : undefined;
  return { code, ...(typeof status === 'number' ? { httpStatus: status } : {}) };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Extract optional request metadata emitted by newer providers without making it part of protocol validity. */
export function codexFailureMetadata(error: unknown): Partial<RunnerFailure> {
  const root = object(error);
  if (!root) return {};
  const data = object(root.data);
  let details = object(root.additionalDetails);
  if (!details && typeof root.additionalDetails === 'string') {
    try { details = object(JSON.parse(root.additionalDetails)); } catch { /* human-readable detail */ }
  }
  const sources = [root, data, details].filter((value): value is Record<string, unknown> => Boolean(value));
  const pick = (...keys: string[]): unknown => {
    for (const source of sources) for (const key of keys) if (source[key] !== undefined) return source[key];
    return undefined;
  };
  const requestId = pick('requestId', 'request_id');
  const retryMs = pick('retryAfterMs', 'retry_after_ms');
  const retrySeconds = pick('retryAfterSeconds', 'retry_after_seconds');
  return {
    ...(typeof requestId === 'string' ? { requestId } : {}),
    ...(typeof retryMs === 'number' ? { retryAfterMs: retryMs } : typeof retrySeconds === 'number' ? { retryAfterMs: retrySeconds * 1000 } : {}),
  };
}

/** Normalize the stable app-server CodexErrorInfo union without relying on message text. */
export function normalizeCodexFailure(info: unknown, extras: Partial<RunnerFailure> = {}): RunnerFailure {
  const { code, httpStatus } = unpack(info);
  const retryableStatus = httpStatus !== undefined && (httpStatus === 408 || httpStatus === 409 || httpStatus === 429 || httpStatus === 529 || httpStatus >= 500);
  const retryable = Boolean(code && RETRYABLE_CODES.has(code)) || retryableStatus;
  const partialWork = code === 'responseStreamDisconnected' || code === 'responseTooManyFailedAttempts';
  return { ...extras, ...(code ? { providerCode: code } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}), retryable, ...(partialWork ? { partialWork: true } : {}) };
}

// ---------------------------------------------------------------------------
// Configuration rejections (H4.2)
// ---------------------------------------------------------------------------

/**
 * A Codex CLI that refuses our command line, our output schema or our protocol params is reporting a bug in
 * the workflow, not a flaky model. Those failures used to arrive as `crash` and were retried until
 * `retry.attempts` ran out, which is how `--approve-for-me cannot be used with --sandbox` turned into
 * "constant failures". Recognised here, they end the task once, naming the flag and the YAML key behind it.
 */
/** JSON-RPC "invalid params": the server understood the call and refused what it carried. */
export const JSON_RPC_INVALID_PARAMS = -32602;

const CODEX_FLAG_KEYS: Array<[RegExp, string]> = [
  [/^--approve-for-me$/, 'codex.approvals'],
  [/^(?:--sandbox|-s)$/, 'codex.sandbox'],
  [/^(?:--ask-for-approval|-a)$/, 'codex.approvalPolicy'],
  [/^(?:--profile|-p)$/, 'codex.profile'],
  [/^--add-dir$/, 'codex.addDirs'],
  [/^(?:--ignore-user-config|--ignore-rules)$/, 'codex.configMode'],
  [/^--output-schema$/, "the completion contract's output schema"],
  [/^(?:--model|-m)$/, "the task's model"],
  [/^(?:--config|-c)$/, 'a codex option passed as a -c override'],
];

/** The workflow key a Codex flag came from; raw passthrough is the only place an unknown flag can come from. */
export function codexOptionKey(option: string): string {
  const flag = option.replace(/[=<\s].*$/, '').trim();
  return CODEX_FLAG_KEYS.find(([pattern]) => pattern.test(flag))?.[1] ?? 'codex.extraArgs';
}

const USAGE_BLOCK = /^\s*Usage:\s+\S/m;
const ERROR_LINE = /^\s*error:\s*(.+)$/m;
const SCHEMA_REJECTION = /invalid_json_schema|Invalid schema for response_format/i;
/** Every `'--flag'` clap quoted in its complaint, in the order it named them. */
const QUOTED_FLAG = /'(-{1,2}[A-Za-z][\w-]*)[^']*'/g;

function lineMatching(text: string, pattern: RegExp): string | undefined {
  return text.split(/\r?\n/).find((line) => pattern.test(line));
}

function flagsIn(text: string): string[] {
  return [...new Set([...text.matchAll(QUOTED_FLAG)].map((match) => match[1]!))];
}

/**
 * Classify a finished `codex exec` process. Returns the rejection when the CLI (or the model API through
 * it) refused what CAO sent, and undefined for everything else — including an ordinary failed turn.
 */
export function codexConfigRejection(input: { exitCode?: number | null; stderr?: string; stream?: string }): ConfigRejection | undefined {
  const stderr = input.stderr ?? '';
  const stream = input.stream ?? '';
  const schemaLine = lineMatching(stream, SCHEMA_REJECTION) ?? lineMatching(stderr, SCHEMA_REJECTION);
  if (schemaLine) {
    return { detail: schemaLine.trim(), option: '--output-schema', key: "the completion contract's output schema" };
  }
  // clap: an `error:` line followed by the usage banner of the scope that rejected it. The exit code is 2,
  // but a wrapper around the CLI may not preserve it, so the banner is what makes this unambiguous.
  const error = ERROR_LINE.exec(stderr);
  if (!error || (!USAGE_BLOCK.test(stderr) && input.exitCode !== 2)) return undefined;
  const flags = flagsIn(error[1]!);
  const keys = [...new Set(flags.map((flag) => codexOptionKey(flag)))];
  return {
    detail: `error: ${error[1]!.trim()}`,
    ...(flags.length ? { option: flags.join(' with ') } : {}),
    ...(keys.length ? { key: keys.join(' and ') } : {}),
  };
}

/**
 * A JSON-RPC failure from the app-server. `-32602` (invalid params) is by definition CAO sending something
 * the server cannot accept; an `initialize`/`thread/start` mismatch is the same thing one layer up, and both
 * are passed here by the transport with the key that produced them.
 */
export function codexProtocolRejection(input: { code?: number; message: string; key?: string }): ConfigRejection | undefined {
  if (input.code !== undefined && input.code !== JSON_RPC_INVALID_PARAMS) return undefined;
  if (SCHEMA_REJECTION.test(input.message)) {
    return { detail: input.message, option: 'turn/start outputSchema', key: "the completion contract's output schema" };
  }
  return { detail: input.message, ...(input.key ? { key: input.key } : {}) };
}
