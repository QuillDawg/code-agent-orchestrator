/**
 * Frame comparison for the dashboard.
 *
 * The Ink 5 -> Ink 7 / React 18 -> 19 upgrade is meant to be invisible: the same tree, laid out the same
 * way, in the same number of columns and rows. These goldens were captured from the dashboard fixtures
 * below on the stack that preceded the upgrade, and the upgrade is only done when they still match.
 *
 * Two normalisations keep the comparison about layout rather than about the machine it runs on. Colour is
 * stripped, because whether `paint()` emits anything depends on the environment; and every digit becomes
 * `#`, because a clock reading, a run id or a duration would otherwise change from run to run and from
 * timezone to timezone. Digits are one column wide, so alignment, wrapping, padding and truncation — the
 * things a renderer upgrade actually breaks — survive the substitution intact.
 *
 * The Ink 5 -> Ink 7 move changed exactly one of the eight: at 80 columns the summary line is too long for
 * the terminal, and Ink 7 picks a different word to break it at (`… Concurrency 0/2   Cost` / ` $0.42 …`
 * where Ink 5 gave `… Concurrency 0/2` / `Cost $0.42 …`). That is upstream word wrapping, not a layout
 * change here, and the goldens record it. Everything else is byte for byte what it was.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { renderTree } from '../helpers/ink-harness.js';
import type { TranscriptEntry } from 'code-agent-orchestrator-protocol';

const FIXTURE_DIR = path.join(process.cwd(), 'test', 'fixtures', 'frames');
/** Set to re-capture every golden. Only ever legitimate when the dashboard itself was meant to change. */
const UPDATE = process.env['CAO_UPDATE_FRAMES'] === '1';

const FROZEN = new Date('2026-09-17T09:30:00.000Z');
const started = '2026-09-17T09:12:34.000Z';
const ended = '2026-09-17T09:21:05.000Z';

const task = (id: string, agent: 'claude' | 'codex', dependsOn: string[] = []) => ({
  id,
  agent,
  dependsOn,
  retry: { attempts: 2 },
  codex: {},
});

const run = {
  runId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
  workflowName: 'stack-upgrade',
  repositoryRoot: '/repo/code-agent-orchestrator',
  state: 'running',
  startedAt: started,
  workflow: {
    execution: { maxConcurrency: 2 },
    tasks: [task('implement-parser', 'claude'), task('implement-renderer', 'codex'), task('review-and-merge', 'claude', ['implement-parser', 'implement-renderer'])],
  },
  tasks: {
    'implement-parser': {
      id: 'implement-parser',
      state: 'success',
      retryWindowStart: 1,
      attempts: [
        {
          number: 1,
          kind: 'task',
          triggeredBy: 'initial',
          startedAt: started,
          endedAt: ended,
          cwd: '/repo/.orchestrator/worktrees/implement-parser',
          pid: 4242,
          sessionId: 'sess-abc123',
          files: { 'src/parser.ts': { status: 'modified', additions: 31, deletions: 4 } },
          usage: { costUsd: 0.42, inputTokens: 18_000, outputTokens: 2_400, cacheReadTokens: 9_000, cacheCreationTokens: 1_200, numTurns: 7, durationMs: 511_000, toolMs: 61_000, contextTokens: 42_000, contextWindow: 200_000, model: 'claude-opus-5' },
        },
      ],
    },
    'implement-renderer': {
      id: 'implement-renderer',
      state: 'failed',
      message: 'exit code 1',
      retryWindowStart: 1,
      attempts: [
        {
          number: 1,
          kind: 'task',
          triggeredBy: 'initial',
          startedAt: started,
          endedAt: ended,
          cwd: '/repo/.orchestrator/worktrees/implement-renderer',
          pid: 4243,
          files: {},
          usage: { costUsd: 0.11, inputTokens: 6_000, outputTokens: 900, numTurns: 3, durationMs: 120_000, toolMs: 8_000, contextTokens: 160_000, contextWindow: 200_000, model: 'gpt-5-codex' },
        },
      ],
    },
    'review-and-merge': { id: 'review-and-merge', state: 'pending', retryWindowStart: 1, attempts: [] },
  },
};

const entries: TranscriptEntry[] = [
  { kind: 'text', ts: started, text: 'Reading the parser' },
  { kind: 'command', ts: started, command: 'npm test', tool: 'Bash' },
];

const scheduler = {
  peek: () => entries,
  transcript: () => entries,
  capturedDiff: async () => undefined,
  attemptTranscript: async () => [],
};

const shared: DashboardShared = { queue: [], listeners: new Set(), notify: () => undefined, remove: () => false };

const element = (
  <DashboardApp run={run as never} bus={{ onAny: () => () => undefined } as never} controller={scheduler as never} shared={shared} finished={false} onMinimise={() => undefined} onInterrupt={() => undefined} />
);

/** Colour out, digits flattened: what is left is the shape of the frame. */
const normalise = (text: string): string =>
  text
    .replace(/\d/g, '#')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

// See test/unit/dashboard.test.tsx: React 19 commits and flushes effects on scheduler tasks, and a key
// written before Ink has subscribed the view's `useInput` is simply dropped. `act` drains that queue.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 40): Promise<void> => {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

async function capture(name: string, size: { columns: number; rows: number }, marker: string, keys?: string): Promise<void> {
  const tree = renderTree(element, size);
  try {
    await wait();
    if (keys) {
      tree.write(keys);
      await wait();
    }
    // The view is only worth comparing once it is the one on screen; a dropped key would otherwise be
    // captured as "the dashboard renders fine", four times over.
    await tree.waitFor((frame) => frame.includes(marker));
    const actual = normalise(tree.lastText());
    const file = path.join(FIXTURE_DIR, `${name}.txt`);
    if (UPDATE) {
      await fs.mkdir(FIXTURE_DIR, { recursive: true });
      await fs.writeFile(file, `${actual}\n`, 'utf8');
      return;
    }
    const golden = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    expect(actual).toBe(golden);
  } finally {
    tree.unmount();
  }
}

describe('dashboard frames', () => {
  beforeAll(() => {
    // Only `Date` is faked: Ink, React and the harness all need real timers to commit a frame at all.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  const sizes = [
    { name: '80x24', columns: 80, rows: 24 },
    { name: '120x40', columns: 120, rows: 40 },
  ];

  for (const size of sizes) {
    it(`renders the task list unchanged at ${size.name}`, async () => {
      await capture(`dashboard-${size.name}`, size, 'R restart');
    });

    it(`renders the usage view unchanged at ${size.name}`, async () => {
      await capture(`usage-${size.name}`, size, 'Cache r/w', 'u');
    });

    it(`renders the help view unchanged at ${size.name}`, async () => {
      await capture(`help-${size.name}`, size, 'minimise the dashboard', '?');
    });

    it(`renders the task detail unchanged at ${size.name}`, async () => {
      await capture(`detail-${size.name}`, size, 'Latest activity', '\r');
    });
  }
});
