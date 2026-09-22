/**
 * The usage footer inside the workspace (spec §3.6, §5 row 10).
 *
 * The chips themselves are asserted as text in `test/unit/quota.test.ts`; what is proved here is the part
 * only a mounted tree can show: the readers start when the workspace mounts and stop when it unmounts
 * `[D31]`, the chips reach the footer, `R` re-reads them once the footer has the keys, and none of it
 * makes the frame taller than the terminal.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import type { QuotaSnapshot } from 'code-agent-orchestrator-protocol';
import { DashboardApp, type DashboardShared, type QuotaFactory } from '../../src/tui/app.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import { claudeQuotaSnapshot } from '../../src/runners/quota.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NL = String.fromCharCode(10);
const ts = '2026-09-17T09:12:34.000Z';

const wait = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const run = {
  runId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
  workflowName: 'stack-upgrade',
  repositoryRoot: '/repo/code-agent-orchestrator',
  state: 'running',
  startedAt: ts,
  workflow: { execution: { maxConcurrency: 2 }, tasks: [{ id: 'implement-parser', agent: 'codex', dependsOn: [], retry: { attempts: 1 }, codex: {} }] },
  tasks: { 'implement-parser': { id: 'implement-parser', state: 'running', retryWindowStart: 1, attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: ts, cwd: '.', files: {} }] } },
};

const controllerStub = {
  peek: () => [],
  transcript: () => [],
  capturedDiff: async () => null,
  steerable: () => false,
  attemptTranscript: async () => [],
  readReport: async () => '',
  // Only here so the "R on the task list is a restart" probe below has something to reach.
  submit: async () => ({ status: 'applied' as const }),
};
const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

/** A reader that spawns nothing: it records what the workspace asked of it and publishes on demand. */
function fakeReaders() {
  const calls = { started: 0, refreshed: 0, stopped: 0 };
  let publish: ((snapshot: QuotaSnapshot) => void) | undefined;
  const quota: QuotaFactory = (handlers) => {
    calls.started += 1;
    publish = handlers.onSnapshot;
    handlers.onSnapshot(claudeQuotaSnapshot('2026-09-17T09:12:00.000Z'));
    return {
      refresh: () => {
        calls.refreshed += 1;
      },
      stop: () => {
        calls.stopped += 1;
        publish = undefined;
      },
    };
  };
  return {
    calls,
    quota,
    async push(snapshot: QuotaSnapshot): Promise<void> {
      await React.act(async () => {
        publish?.(snapshot);
      });
    },
  };
}

const codexOk = (): QuotaSnapshot => ({
  protocol: 1,
  provider: 'codex',
  readAt: new Date().toISOString(),
  state: 'ok',
  planType: 'Pro',
  windows: [
    { label: '5h', durationMins: 300, usedPercent: 42, resetsAt: null },
    { label: '7d', durationMins: 10080, usedPercent: 61, resetsAt: null },
  ],
});

function mount(size: { columns: number; rows: number }, over: Record<string, unknown> = {}): RenderedTree {
  return renderTree(
    <DashboardApp
      run={run as never}
      bus={{ onAny: () => () => undefined } as never}
      controller={controllerStub as never}
      shared={shared()}
      finished={false}
      onMinimise={() => undefined}
      onInterrupt={() => undefined}
      {...over}
    />,
    size,
  );
}

const fits = (tree: RenderedTree, size: { columns: number; rows: number }): void => {
  expect(frameHeight(tree.lastFrame()), 'taller than its terminal').toBeLessThanOrEqual(size.rows);
  for (const line of tree.lastText().split(NL)) expect([...line].length, `wider than its terminal: ${line}`).toBeLessThanOrEqual(size.columns);
};

const SIZE = { columns: 160, rows: 40 };

describe('the usage footer (§3.6)', () => {
  it('starts the readers on mount and stops them on unmount [D31]', async () => {
    const readers = fakeReaders();
    const tree = mount(SIZE, { quota: readers.quota });
    await wait();
    expect(readers.calls.started).toBe(1);
    expect(readers.calls.stopped).toBe(0);

    tree.unmount();
    await wait();
    expect(readers.calls.stopped).toBe(1);
  });

  it('claims no quota at all when the workspace was given no readers', async () => {
    const tree = mount(SIZE);
    try {
      await wait();
      // No chip, no placeholder, no claim about a quota nothing measured. Deliberately about *quotas*: the
      // run's own spend is not a reading and is not gated on one, which the next case is about.
      expect(tree.lastText()).not.toContain('codex ·');
      expect(tree.lastText()).not.toContain('claude ·');
      fits(tree, SIZE);
    } finally {
      tree.unmount();
    }
  });

  it('draws the run own spend with no readers at all, because it is the run own number', async () => {
    // The spend cell is measured by `cao` from the attempts in front of it, not asked of a provider, so it
    // must render in a workspace that was given no quota factory. Without this test the case above reads as
    // "the footer shows nothing without readers" and the next person deletes the feature.
    const spent = {
      ...run,
      tasks: {
        'implement-parser': {
          ...run.tasks['implement-parser'],
          attempts: [{ ...run.tasks['implement-parser']!.attempts[0], usage: { inputTokens: 24_000, outputTokens: 6800, costUsd: 0.84 } }],
        },
      },
    };
    const tree = mount(SIZE, { run: spent });
    try {
      await wait();
      expect(tree.lastText()).toContain('spend $0.84');
      expect(tree.lastText()).not.toContain('codex ·');
      fits(tree, SIZE);
    } finally {
      tree.unmount();
    }
  });

  it('draws one chip per provider, and replaces a provider rather than adding to it', async () => {
    const readers = fakeReaders();
    const tree = mount(SIZE, { quota: readers.quota });
    try {
      await wait();
      expect(tree.lastText()).toContain('see /usage in Claude Code');

      await readers.push(codexOk());
      await wait();
      expect(tree.lastText()).toContain('5h 42%');
      expect(tree.lastText()).toContain('7d 61%');

      await readers.push({ ...codexOk(), planType: 'Plus', windows: [{ label: '5h', durationMins: 300, usedPercent: 91, resetsAt: null }] });
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('5h 91%');
      // The refresh replaced the reading; it did not leave the old one on the line beside it.
      expect(frame).not.toContain('5h 42%');
      expect(frame.match(/codex ·/g) ?? []).toHaveLength(1);
      fits(tree, SIZE);
    } finally {
      tree.unmount();
    }
  });

  it('gives the footer the keys on the fourth Tab, where R re-reads the quotas', async () => {
    const readers = fakeReaders();
    const tree = mount(SIZE, { quota: readers.quota });
    try {
      await wait();
      // R on the task list is "restart a task", which is exactly why the footer needs focus of its own.
      await React.act(async () => tree.write('r'));
      await wait();
      expect(readers.calls.refreshed).toBe(0);

      // tasks -> tabs -> main -> footer
      for (let i = 0; i < 3; i += 1) {
        await React.act(async () => tree.write(KEYS.tab));
        await wait();
      }
      expect(tree.lastText()).toContain('R refresh quotas');

      await React.act(async () => tree.write('r'));
      await wait();
      expect(readers.calls.refreshed).toBe(1);
      expect(tree.lastText()).toContain('Reading the provider quotas again');
      fits(tree, SIZE);
    } finally {
      tree.unmount();
    }
  });

  it('refreshes from the command palette too, wherever the focus is', async () => {
    const readers = fakeReaders();
    const tree = mount(SIZE, { quota: readers.quota });
    try {
      await wait();
      await React.act(async () => tree.write(KEYS.ctrlP));
      await wait();
      await React.act(async () => tree.write('quota'));
      await wait();
      expect(tree.lastText()).toContain('Refresh the provider quotas');
      await React.act(async () => tree.write(KEYS.enter));
      await wait();
      expect(readers.calls.refreshed).toBe(1);
      fits(tree, SIZE);
    } finally {
      tree.unmount();
    }
  });

  it('sheds the chips before the keys when the terminal is narrow', async () => {
    const readers = fakeReaders();
    const small = { columns: 80, rows: 24 };
    const tree = mount(small, { quota: readers.quota });
    try {
      await wait();
      await readers.push(codexOk());
      await wait();
      // Whatever else goes, the footer still says how to leave and where the rest of the keys are (§3.2).
      expect(tree.lastText()).toContain('? help');
      expect(tree.lastText()).toContain('Q quit');
      fits(tree, small);
    } finally {
      tree.unmount();
    }
  });
});
