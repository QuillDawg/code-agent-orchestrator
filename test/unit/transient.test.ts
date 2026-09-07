import { describe, it, expect } from 'vitest';
import { isTransientApiError } from '../../src/runners/claude/transient.js';
import { buildClaudeArgs } from '../../src/runners/claude/claude-runner.js';
import { transientBackoffMs } from '../../src/workflow/scheduler.js';
import { buildWorkflow } from '../helpers/index.js';

describe('transient API error classification', () => {
  it('recognises the errors Claude Code prints when its own retries give up', () => {
    const samples = [
      'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'API Error: 503 Service Unavailable',
      'API Error: 502 Bad Gateway',
      'API Error: 504 Gateway Timeout',
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
      'API Error (Connection error.)',
      'TypeError: fetch failed',
      'Error: read ECONNRESET',
      'connect ETIMEDOUT 1.2.3.4:443',
      'socket hang up',
      'Request timed out.',
    ];
    for (const s of samples) expect(isTransientApiError(s), s).toBe(true);
  });

  it('never treats permanent failures as transient', () => {
    const samples = [
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
      'API Error: 403 permission_error',
      'max turns reached',
      'Reached max budget of $2.00',
      'Something went wrong while editing the file',
      'Task failed: tests are red',
      '',
    ];
    for (const s of samples) expect(isTransientApiError(s), s).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
  });

  it('a rate-limit message that also mentions billing is not retried automatically', () => {
    expect(isTransientApiError('API Error: 429 rate limit exceeded; your billing plan does not allow more requests')).toBe(false);
  });
});

describe('session resume arguments', () => {
  it('uses --resume instead of --session-id when continuing a session', () => {
    const fresh = buildClaudeArgs({}, 'sid');
    expect(fresh).toContain('--session-id');
    expect(fresh).not.toContain('--resume');

    const resumed = buildClaudeArgs({}, 'sid', undefined, 'sid');
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe('sid');
    expect(resumed).not.toContain('--session-id');
    // everything else (contract, permissions, schema) is still enforced on the resumed session
    expect(resumed).toContain('--json-schema');
    expect(resumed).toContain('--append-system-prompt');
    expect(resumed[resumed.indexOf('--permission-prompts') + 1]).toBe('none');
  });
});

describe('transient backoff', () => {
  it('doubles from the base delay and respects the cap', () => {
    expect(transientBackoffMs(1, 30_000, 300_000)).toBe(30_000);
    expect(transientBackoffMs(2, 30_000, 300_000)).toBe(60_000);
    expect(transientBackoffMs(3, 30_000, 300_000)).toBe(120_000);
    expect(transientBackoffMs(4, 30_000, 300_000)).toBe(240_000);
    expect(transientBackoffMs(5, 30_000, 300_000)).toBe(300_000);
    expect(transientBackoffMs(50, 30_000, 300_000)).toBe(300_000);
    expect(transientBackoffMs(0, 100, 1000)).toBe(100);
  });
});

describe('retry config: transient settings', () => {
  it('defaults to 3 session resumes with 30s..5m backoff', async () => {
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n');
    const retry = workflow.tasks[0]!.retry;
    expect(retry.attempts).toBe(0);
    expect(retry.transientAttempts).toBe(3);
    expect(retry.transientDelayMs).toBe(30_000);
    expect(retry.transientMaxDelayMs).toBe(300_000);
    expect(retry.resumeSession).toBe(true);
  });

  it('accepts overrides and rejects an inverted delay range', async () => {
    const ok = await buildWorkflow('name: t\ntasks:\n  - id: a\n    retry:\n      transientAttempts: 5\n      transientDelay: 5s\n      transientMaxDelay: 1m\n      resumeSession: false\n    prompt: p\n');
    const retry = ok.workflow.tasks[0]!.retry;
    expect(retry.transientAttempts).toBe(5);
    expect(retry.transientDelayMs).toBe(5000);
    expect(retry.transientMaxDelayMs).toBe(60_000);
    expect(retry.resumeSession).toBe(false);

    const bad = await buildWorkflow('name: t\ntasks:\n  - id: a\n    retry:\n      transientDelay: 2m\n      transientMaxDelay: 1m\n    prompt: p\n');
    expect(bad.diagnostics.some((d) => d.level === 'error' && /transientMaxDelay/.test(d.message))).toBe(true);
  });
});
