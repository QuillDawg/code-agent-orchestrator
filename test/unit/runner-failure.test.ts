import { describe, expect, it } from 'vitest';
import { normalizeCodexFailure } from '../../src/runners/codex/failure.js';

describe('Codex typed failures', () => {
  it('marks transport, rate-limit and server failures retryable', () => {
    expect(normalizeCodexFailure('rateLimitExceeded')).toMatchObject({ providerCode: 'rateLimitExceeded', retryable: true });
    expect(normalizeCodexFailure({ httpConnectionFailed: { httpStatusCode: 503 } })).toMatchObject({ providerCode: 'httpConnectionFailed', httpStatus: 503, retryable: true });
    expect(normalizeCodexFailure({ responseStreamDisconnected: { httpStatusCode: 409 } })).toMatchObject({ providerCode: 'responseStreamDisconnected', httpStatus: 409, retryable: true, partialWork: true });
  });

  it('does not retry authentication, quota, context, request or sandbox failures', () => {
    for (const code of ['unauthorized', 'usageLimitExceeded', 'contextWindowExceeded', 'badRequest', 'sandboxError']) {
      expect(normalizeCodexFailure(code), code).toMatchObject({ providerCode: code, retryable: false });
    }
  });
});
