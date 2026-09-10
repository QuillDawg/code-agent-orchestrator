import { describe, expect, it } from 'vitest';
import { versionAtLeast } from '../../src/runners/capabilities.js';
import { runnerReadinessError, type RunnerDetection } from '../../src/cli/app.js';

const ready = (over: Partial<RunnerDetection> = {}): RunnerDetection => ({
  runner: 'codex', command: 'codex', found: true, version: '0.153.0',
  authenticated: true, supportedVersion: true, minimumVersion: '0.153.0',
  capabilities: ['exec', 'appServer', 'autoReview', 'isolatedConfig'], requiredCapabilities: ['exec'],
  ...over,
});

describe('agent runtime readiness', () => {
  it('compares vendor-formatted versions', () => {
    expect(versionAtLeast('codex-cli 0.153.0', '0.153.0')).toBe(true);
    expect(versionAtLeast('2.1.258 (Claude Code)', '2.1.259')).toBe(false);
    expect(versionAtLeast('unknown', '2.1.259')).toBeUndefined();
  });

  it('requires authentication, a supported version and requested capabilities', () => {
    expect(runnerReadinessError(ready())).toBeUndefined();
    expect(runnerReadinessError(ready({ authenticated: false }))).toMatch(/not authenticated/i);
    expect(runnerReadinessError(ready({ supportedVersion: false }))).toMatch(/minimum 0\.153\.0/i);
    expect(runnerReadinessError(ready({ requiredCapabilities: ['appServer'], capabilities: ['exec'] }))).toMatch(/appServer/);
  });
});
