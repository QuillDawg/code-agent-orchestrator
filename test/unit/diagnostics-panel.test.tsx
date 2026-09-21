/**
 * The Diagnostics panel (spec §3.7, §5 row 12).
 *
 * `diagnosticsLines` is a pure function of the run and what was read off disk, so every section of §3.7 is
 * asserted here as text rather than through a frame: the transports and CLI versions, the effective
 * configuration with its active revision, the retry history, the `RunnerFailure` metadata, the control
 * history including a rejected request, and the quota snapshots.
 *
 * The distinction the panel exists to keep is asserted too: "still reading" and "there is none" are
 * different sentences, because an operator who cannot tell them apart has learnt nothing.
 *
 * The last block mounts the shell, because two of the rules are about *when* rather than about what: the
 * preflight facts are read when the tab is opened and not before, and `--debug` opens on this tab `[D34]`.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import type { QuotaSnapshot, WorkflowRun } from 'code-agent-orchestrator-protocol';
import { diagnosticsLines, parseRetryEvents } from '../../src/tui/workspace/diagnostics.js';
import { agentReports, transportsFor } from '../../src/runners/diagnostics.js';
import type { ControlHistory } from '../../src/persistence/requests.js';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ts = '2026-09-17T09:12:34.000Z';
const now = Date.parse('2026-09-17T09:30:00.000Z');

const task = (id: string, agent: 'claude' | 'codex', over: Record<string, unknown> = {}) => ({
  id,
  agent,
  dependsOn: [],
  model: agent === 'claude' ? 'claude-opus-5' : 'gpt-5-codex',
  timeoutMs: 90 * 60_000,
  retry: { attempts: 2 },
  onFailure: 'stop',
  workspace: 'shared',
  claude: {},
  codex: {},
  ...over,
});

const run = (): WorkflowRun =>
  ({
    runId: '2026-09-17-001',
    workflowName: 'stack-upgrade',
    repositoryRoot: '/repo',
    workflow: { execution: { maxConcurrency: 1, outputBufferLines: 500 }, tasks: [task('implement-parser', 'claude'), task('render', 'codex', { codex: { transport: 'appServer' } })] },
    tasks: {
      'implement-parser': {
        id: 'implement-parser',
        state: 'failed',
        retryWindowStart: 1,
        revisions: [{ number: 1, at: ts, source: 'cli', pid: 4242, changes: { model: { from: 'claude-sonnet-5', to: 'claude-opus-5' } }, appliedToAttempt: 2 }],
        attempts: [
          { number: 1, kind: 'task', triggeredBy: 'initial', startedAt: ts, cwd: '.', outcome: 'api_error', error: 'overloaded_error', failure: { retryable: true, providerCode: 'overloaded_error', httpStatus: 529, retryAfterMs: 30_000, sessionId: 'sess-abc', partialWork: true } },
          { number: 2, kind: 'task', triggeredBy: 'retry', startedAt: ts, cwd: '.', outcome: 'success' },
        ],
      },
      render: { id: 'render', state: 'pending', retryWindowStart: 1, attempts: [] },
    },
  }) as unknown as WorkflowRun;

const text = (input: Parameters<typeof diagnosticsLines>[0]): string => diagnosticsLines(input).map((line) => line.text).join('\n');

const base = { run: run(), controls: [], quotas: [] as QuotaSnapshot[], now };

describe('the Diagnostics panel (§3.7)', () => {
  it('says which transport each agent takes, from the resolved tasks rather than from the detection', () => {
    const workflow = run().workflow;
    expect(transportsFor('claude', workflow)).toEqual(['claude-stream']);
    expect(transportsFor('codex', workflow)).toEqual(['codex-app-server']);
    // An agent with no task in this run has no transport in it either.
    expect(transportsFor('codex', { ...workflow, tasks: [task('a', 'claude')] } as never)).toEqual([]);

    const reports = agentReports(
      [
        { runner: 'claude', command: 'claude', found: true, version: '2.1.300', capabilities: ['streamJson', 'replayUserMessages'], authenticated: true },
        { runner: 'codex', command: 'codex', found: false, error: 'not on PATH' },
      ],
      workflow,
    );
    const shown = text({ ...base, agents: reports });
    expect(shown).toContain('claude  2.1.300');
    expect(shown).toContain('transport claude-stream');
    expect(shown).toContain('advertises streamJson, replayUserMessages');
    expect(shown).toContain('codex  not installed');
    expect(shown).toContain('not on PATH');
  });

  it('tells "still reading" apart from "there is none"', () => {
    const reading = text(base);
    expect(reading).toContain('Reading the agent CLIs');
    expect(reading).toContain('Reading the run log');
    expect(reading).toContain('Reading requests/');

    const empty = text({ ...base, agents: [], retries: [], inbox: { pending: [], acks: [], rejected: [] } });
    expect(empty).toContain('This run uses no agent CLI.');
    expect(empty).toContain('Nothing has been retried.');
    expect(empty).toContain('No request has ever been written for this run.');
  });

  it('shows the effective configuration of each task and the revision that is active', () => {
    const shown = text(base);
    expect(shown).toContain('implement-parser  claude|opus-5');
    expect(shown).toContain('timeout 1h30m  retries 2');
    expect(shown).toContain('revision 1');
    expect(shown).toContain('cli pid 4242');
    expect(shown).toContain('model');
    expect(shown).toContain('carried by attempt 2');
  });

  it('shows the retry history with its reasons, and the failure metadata behind it', () => {
    const retries = parseRetryEvents([
      'not json at all',
      `{"type":"task.started","ts":"${ts}","taskId":"implement-parser"}`,
      `{"type":"task.retrying","ts":"${ts}","taskId":"implement-parser","nextAttempt":2,"delayMs":30000,"transient":true,"resumeSession":true}`,
    ]);
    expect(retries).toHaveLength(1);
    const shown = text({ ...base, retries });
    expect(shown).toContain('implement-parser → attempt 2 after 30s');
    expect(shown).toContain('transient failure');
    expect(shown).toContain('resuming the session');
    // The `RunnerFailure` of the attempt that caused it, field by field (§3.7).
    expect(shown).toContain('implement-parser attempt 1  api_error');
    expect(shown).toContain('retryable yes');
    expect(shown).toContain('code overloaded_error');
    expect(shown).toContain('http 529');
    expect(shown).toContain('retry after 30s');
    expect(shown).toContain('session sess-abc');
    expect(shown).toContain('partial work applied');
  });

  it('shows the controls this window sent and the inbox behind it, rejections included', () => {
    const inbox: ControlHistory = {
      pending: [{ protocol: 1, id: '01ABC', kind: 'stop', requestedAt: ts, source: 'cao-desktop 0.1.0', pid: 991, taskId: 'implement-parser' } as never],
      acks: [{ protocol: 1, id: '01AAA', status: 'rejected', reason: 'the task has already succeeded', at: ts } as never],
      rejected: [{ file: '/repo/.orchestrator/runs/2026-09-17-001/requests/rejected/01ZZZ-teleport.json', request: {}, reason: 'this cao does not know the request kind "teleport"' }],
    };
    const shown = text({
      ...base,
      controls: [{ id: 'c1', at: Date.parse(ts), label: 'stop implement-parser', status: 'timeout', reason: 'the request is still in requests/' }],
      inbox,
    });
    expect(shown).toContain('Controls sent from this window');
    expect(shown).toContain('stop implement-parser → no answer yet');
    expect(shown).toContain('the request is still in requests/');
    expect(shown).toContain('stop implement-parser from cao-desktop 0.1.0 → waiting');
    expect(shown).toContain('ack 01AAA → rejected: the task has already succeeded');
    expect(shown).toContain('rejected 01ZZZ-teleport.json');
    expect(shown).toContain('does not know the request kind');
  });

  it('shows what each provider last said about its quota', () => {
    const quotas: QuotaSnapshot[] = [
      { protocol: 1, provider: 'codex', readAt: ts, state: 'ok', planType: 'Pro', windows: [{ label: '5h', durationMins: 300, usedPercent: 42, resetsAt: null }] },
      { protocol: 1, provider: 'claude', readAt: ts, state: 'unavailable', reason: 'see /usage in Claude Code', windows: [] },
    ];
    const shown = text({ ...base, quotas });
    expect(shown).toContain('Provider quotas');
    expect(shown).toContain('5h 42%');
    expect(shown).toContain('plan Pro');
    expect(shown).toContain('see /usage in Claude Code');
  });
});

describe('the Diagnostics tab in the workspace (§3.7, [D34])', () => {
  const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });
  const controllerStub = {
    peek: () => [],
    transcript: () => [],
    capturedDiff: async () => null,
    steerable: () => false,
    attemptTranscript: async () => [],
    readReport: async () => '',
    submit: async () => ({ status: 'applied' as const }),
  };
  const SIZE = { columns: 140, rows: 40 };

  const mount = (over: Record<string, unknown> = {}): RenderedTree =>
    renderTree(
      <DashboardApp
        run={run() as never}
        bus={{ onAny: () => () => undefined } as never}
        controller={controllerStub as never}
        shared={shared()}
        finished={false}
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
        {...over}
      />,
      SIZE,
    );

  const wait = async (ms = 60): Promise<void> => {
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };

  it('asks for the preflight facts only once the tab is opened, and draws them', async () => {
    let asked = 0;
    const preflight = async () => {
      asked += 1;
      return agentReports([{ runner: 'claude', command: 'claude', found: true, version: '2.1.300', capabilities: ['streamJson'] }], run().workflow);
    };
    const tree = mount({ preflight });
    try {
      await wait();
      // Nothing is read while the tab is shut: `--version` on two CLIs is two processes.
      expect(asked).toBe(0);
      tree.write(KEYS.tab);
      await wait();
      for (let i = 0; i < 5; i += 1) {
        tree.write(KEYS.right);
        await wait(20);
      }
      await tree.waitFor((frame) => frame.includes('claude  2.1.300'));
      expect(asked).toBe(1);
      expect(tree.lastText()).toContain('transport claude-stream');
      expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(SIZE.rows);
    } finally {
      tree.unmount();
    }
  }, 30_000);

  it('opens on Diagnostics when the command line asked for it (--debug)', async () => {
    const tree = mount({ initialTab: 'diagnostics' });
    try {
      await wait();
      expect(tree.lastText()).toContain('[Diagnostics]');
      expect(tree.lastText()).toContain('Effective configuration');
    } finally {
      tree.unmount();
    }
  }, 30_000);

  it('opens on the Overview without it, as it always has', async () => {
    const tree = mount();
    try {
      await wait();
      expect(tree.lastText()).toContain('[Overview]');
    } finally {
      tree.unmount();
    }
  }, 30_000);
});
