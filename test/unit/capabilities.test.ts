import { afterEach, describe, expect, it } from 'vitest';
import { versionAtLeast } from '../../src/runners/capabilities.js';
import { detectRunnersForWorkflow, runnerReadinessError, type RunnerDetection } from '../../src/cli/app.js';
import { clearCodexDetectionCache, detectCodex } from '../../src/runners/codex/detect.js';
import { buildWorkflow, FAKE_CODEX } from '../helpers/index.js';

const ready = (over: Partial<RunnerDetection> = {}): RunnerDetection => ({
  runner: 'codex', command: 'codex', found: true, version: '0.153.0',
  authenticated: true, supportedVersion: true, minimumVersion: '0.153.0',
  capabilities: ['exec', 'appServer', 'autoReview', 'isolatedConfig'], requiredCapabilities: ['exec'],
  ...over,
});

describe('agent runtime readiness', () => {
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  const savedCodexKey = process.env.CODEX_API_KEY;
  afterEach(() => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenAiKey;
    if (savedCodexKey === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = savedCodexKey;
    delete process.env.FAKE_CODEX_AUTH;
    clearCodexDetectionCache();
  });

  it('compares vendor-formatted versions', () => {
    expect(versionAtLeast('codex-cli 0.153.0', '0.153.0')).toBe(true);
    expect(versionAtLeast('2.1.258 (Claude Code)', '2.1.259')).toBe(false);
    expect(versionAtLeast('unknown', '2.1.259')).toBeUndefined();
  });

  it('requires authentication, a supported version and requested capabilities', () => {
    expect(runnerReadinessError(ready())).toBeUndefined();
    expect(runnerReadinessError(ready({ authenticated: false }))).toMatch(/not authenticated/i);
    expect(runnerReadinessError(ready({ supportedVersion: false }))).toMatch(/minimum 0\.153\.0/i);
    expect(runnerReadinessError(ready({ version: 'unknown', supportedVersion: undefined }))).toMatch(/could not verify/i);
    expect(runnerReadinessError(ready({ requiredCapabilities: ['appServer'], capabilities: ['exec'] }))).toMatch(/appServer/);
  });

  it('detects a present but unauthenticated Codex CLI', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    process.env.FAKE_CODEX_AUTH = '0';
    expect(await detectCodex(FAKE_CODEX)).toMatchObject({ found: true, authenticated: false, supportedVersion: true });
    expect(await detectCodex(FAKE_CODEX, { OPENAI_API_KEY: 'workflow-secret', FAKE_CODEX_AUTH: '0' })).toMatchObject({ found: true, authenticated: true });
  });

  it('requires automatic review support for unattended app-server approvals', async () => {
    const { workflow } = await buildWorkflow(`
name: app-server-auto
codex:
  command: ${JSON.stringify(FAKE_CODEX)}
  transport: appServer
  approvals: auto
tasks: [{ id: review, agent: codex, prompt: review }]
`);
    const [codex] = await detectRunnersForWorkflow(workflow);
    expect(codex).toMatchObject({ runner: 'codex', requiredCapabilities: expect.arrayContaining(['appServer', 'autoReview']) });
  });
});
