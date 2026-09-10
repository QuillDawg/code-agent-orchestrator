import type { RunnerFailure } from '../task-runner.js';

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
