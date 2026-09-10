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

/** Normalize the stable app-server CodexErrorInfo union without relying on message text. */
export function normalizeCodexFailure(info: unknown, extras: Partial<RunnerFailure> = {}): RunnerFailure {
  const { code, httpStatus } = unpack(info);
  const retryableStatus = httpStatus !== undefined && (httpStatus === 408 || httpStatus === 409 || httpStatus === 429 || httpStatus === 529 || httpStatus >= 500);
  const retryable = Boolean(code && RETRYABLE_CODES.has(code)) || retryableStatus;
  const partialWork = code === 'responseStreamDisconnected' || code === 'responseTooManyFailedAttempts';
  return { ...extras, ...(code ? { providerCode: code } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}), retryable, ...(partialWork ? { partialWork: true } : {}) };
}
