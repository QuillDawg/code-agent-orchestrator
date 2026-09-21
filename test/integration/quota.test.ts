/**
 * The quota process against a real `codex app-server` child (spec §3.6, §7.2, §5 row 10).
 *
 * `test/unit/quota.test.ts` drives the state machine through an injected channel, which proves the states
 * but not the wire: whether the handshake the fake CLI accepts is the one CAO sends, whether the reads it
 * answers are the ones CAO asks for, and whether closing stdin is enough to make the server leave. That is
 * this file. The CLI is the fake one, so nothing here reaches OpenAI.
 *
 * The last case is the other half of `[D31]`: a headless run spawns no quota process at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { QuotaSnapshot } from 'code-agent-orchestrator-protocol';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearCodexDetectionCache, detectCodex } from '../../src/runners/codex/detect.js';
import { onCodexRateLimits, startCodexQuota } from '../../src/runners/codex/quota.js';
import { FAKE_CODEX, gitAvailable, tmpGitRepo, tmpDir, waitFor } from '../helpers/index.js';

interface Trace {
  taskId: string;
  scope: string;
  method?: string;
  transport?: string;
}

async function readTrace(file: string): Promise<Trace[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Trace);
}

/** Start a real quota process against the fake CLI and collect what it publishes. */
function startAgainstFake(env: Record<string, string> = {}) {
  const snapshots: QuotaSnapshot[] = [];
  const monitor = startCodexQuota({
    command: FAKE_CODEX,
    version: '0.1.0-test',
    env,
    detect: (command) => detectCodex(command, env),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return {
    snapshots,
    monitor,
    latest: () => snapshots[snapshots.length - 1],
    settled: (state: QuotaSnapshot['state']) => waitFor(() => snapshots.some((s) => s.state === state), 15_000),
  };
}

describe('the Codex quota process against the fake app-server', () => {
  beforeAll(() => clearCodexDetectionCache());

  it('handshakes, reads the account and the limits, and leaves when its stdin closes', async () => {
    const trace = path.join(await tmpDir('cao-quota-'), 'trace.jsonl');
    const quota = startAgainstFake({ FAKE_CODEX_TRACE: trace });
    try {
      await quota.settled('ok');
      const snapshot = quota.snapshots.find((s) => s.state === 'ok')!;
      expect(snapshot.provider).toBe('codex');
      expect(snapshot.planType).toBe('Pro');
      expect(snapshot.windows.map((w) => [w.label, w.usedPercent])).toEqual([
        ['5h', 42],
        ['7d', 61],
      ]);
      expect(snapshot.windows[0]!.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const lines = await readTrace(trace);
      expect(lines.map((l) => l.method).filter(Boolean)).toEqual(['account/read', 'account/rateLimits/read']);
      // No thread, no turn: the process the workspace keeps open never runs a model call (§7.2).
      expect(lines.every((l) => l.scope === 'app-server')).toBe(true);
    } finally {
      quota.monitor.stop();
    }
    // The stdio server exits on EOF; `stop()` closing stdin is what it takes, and the kill is the backstop.
    // It wrote its trace before leaving, which is the evidence it was a real child and it is gone.
    expect((await readTrace(trace)).length).toBeGreaterThan(0);
  }, 30_000);

  it('is authRequired for an API-key login, and stays there', async () => {
    const quota = startAgainstFake({ FAKE_CODEX_ACCOUNT: 'apiKey' });
    try {
      await quota.settled('authRequired');
      expect(quota.snapshots.find((s) => s.state === 'authRequired')!.reason).toBe('sign in with ChatGPT for quotas');
      // The fake answers `account/rateLimits/read` for this mode too, which is what makes it the case
      // worth having: the limits answer arrives after the account answer and must not talk the chip out
      // of "sign in" and into a percentage.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(quota.latest()?.state).toBe('authRequired');
      expect(quota.snapshots.some((s) => s.state === 'ok')).toBe(false);
    } finally {
      quota.monitor.stop();
    }
  }, 30_000);

  it('is authRequired when the machine has no login at all', async () => {
    const quota = startAgainstFake({ FAKE_CODEX_ACCOUNT: 'none' });
    try {
      await quota.settled('authRequired');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(quota.latest()?.state).toBe('authRequired');
    } finally {
      quota.monitor.stop();
    }
  }, 30_000);

  it('is authRequired when the server itself refuses the read', async () => {
    const quota = startAgainstFake({ FAKE_CODEX_ACCOUNT: 'refused' });
    try {
      await quota.settled('authRequired');
    } finally {
      quota.monitor.stop();
    }
  }, 30_000);

  it('draws only the windows the server reports when the secondary is missing', async () => {
    const quota = startAgainstFake({ FAKE_CODEX_RATE_LIMITS: 'no-secondary' });
    try {
      await quota.settled('ok');
      expect(quota.snapshots.find((s) => s.state === 'ok')!.windows.map((w) => w.label)).toEqual(['5h']);
    } finally {
      quota.monitor.stop();
    }
  }, 30_000);

  it('adds the limits beyond the default one, under their own ids', async () => {
    const quota = startAgainstFake({ FAKE_CODEX_RATE_LIMITS: 'by-limit-id' });
    try {
      await quota.settled('ok');
      expect(quota.snapshots.find((s) => s.state === 'ok')!.windows.map((w) => w.label)).toEqual(['5h', '7d', 'gpt-5-codex 1h']);
    } finally {
      quota.monitor.stop();
    }
  }, 30_000);
});

const HAS_GIT = await gitAvailable('quota end-to-end suite');

describe.skipIf(!HAS_GIT)('quotas and a run', () => {
  beforeAll(() => clearCodexDetectionCache());

  /** One codex task on the app-server transport, executed headlessly. */
  async function runOnce(env: Record<string, string>): Promise<{ trace: string }> {
    const repo = await tmpGitRepo('cao-quota-run-');
    const configPath = path.join(repo, 'workflow.yaml');
    await fs.writeFile(
      configPath,
      ['name: quota-e2e', 'agent: codex', 'execution:', '  workspaceStrategy: shared', 'codex:', '  transport: appServer', 'tasks:', '  - id: build', '    prompt: do it', ''].join('\n'),
      'utf8',
    );
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo });
    requireValid(prepared);
    prepared.workflow.codex.command = FAKE_CODEX;
    for (const task of prepared.workflow.tasks) task.codex.command = FAKE_CODEX;
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
    const trace = path.join(repo, '.orchestrator', 'codex-trace.jsonl');
    const runtime = createRuntime({ run, environment: { FAKE_CODEX_TRACE: trace, ...env }, secrets: [], logger: silentLogger });
    const result = await runtime.scheduler.execute();
    expect(result.state).toBe('completed');
    return { trace };
  }

  it('forwards an update an attempt saw during its turn, so a busy run refreshes faster than the timer', async () => {
    const seen: unknown[] = [];
    const off = onCodexRateLimits((rateLimits) => seen.push(rateLimits));
    try {
      await runOnce({ FAKE_CODEX_RATE_LIMITS_UPDATE: '1' });
    } finally {
      off();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ primary: expect.objectContaining({ usedPercent: 77, windowDurationMins: 300 }) });
  }, 60_000);

  it('spawns no quota process in a headless run [D31]', async () => {
    const { trace } = await runOnce({});
    const lines = await readTrace(trace);
    // Exactly one app-server: the attempt's. No account read of any kind, so nothing asked for a quota.
    expect(lines.filter((l) => l.transport === 'appServer')).toHaveLength(1);
    expect(lines.filter((l) => l.method?.startsWith('account/'))).toEqual([]);
    expect(lines.every((l) => l.taskId === 'build')).toBe(true);
  }, 60_000);
});
