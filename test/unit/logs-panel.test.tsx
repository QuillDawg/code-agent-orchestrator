/**
 * The Logs panel (spec §3.7, §5 row 12): sources, filters, search, and paging a log no process could hold.
 *
 * The model half is asserted directly, because it is a pure function of a line and a source. The paging
 * half is asserted through a mounted tree against a **real 50 MB file**, because that is the constraint the
 * scope states — "a 50 MB `stdout.log` must open in under a second" — and nothing short of a real file and
 * a real read proves it.
 */
import React from 'react';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createNativeRunPaths } from '../../src/persistence/paths.js';
import {
  filterLine,
  filterRecords,
  logLines,
  logSources,
  parseLogLine,
  searchMatches,
  sourceTaskIds,
  timeOfDayAt,
  visibleSources,
  type LogSource,
} from '../../src/tui/workspace/logs.js';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import { tmpDir } from '../helpers/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NL = String.fromCharCode(10);
const ts = '2026-09-17T09:12:34.000Z';

const wait = async (ms = 40): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

let root: string;
let runId: string;

const runFor = (repositoryRoot: string) => ({
  runId,
  workflowName: 'stack-upgrade',
  repositoryRoot,
  state: 'running',
  startedAt: ts,
  workflow: {
    // Small on purpose: four page-ups take the panel past the first page, so the older-page read is
    // what the assertions below are actually standing on.
    execution: { maxConcurrency: 1, outputBufferLines: 120 },
    tasks: [
      { id: 'implement-parser', agent: 'claude', dependsOn: [], retry: { attempts: 1 }, claude: {}, codex: {}, timeoutMs: 60_000, onFailure: 'stop', workspace: 'shared' },
      { id: 'render', agent: 'codex', dependsOn: [], retry: { attempts: 1 }, claude: {}, codex: {}, timeoutMs: 60_000, onFailure: 'stop', workspace: 'shared' },
    ],
  },
  tasks: {
    'implement-parser': {
      id: 'implement-parser',
      state: 'running',
      retryWindowStart: 1,
      attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: ts, cwd: '.', files: {} }],
    },
    render: {
      id: 'render',
      state: 'running',
      retryWindowStart: 1,
      attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: ts, cwd: '.', files: {} }],
    },
  },
});

const controllerStub = {
  peek: () => [],
  transcript: () => [],
  capturedDiff: async () => null,
  steerable: () => false,
  attemptTranscript: async () => [],
  readReport: async () => '',
  submit: async () => ({ status: 'applied' as const }),
};
const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

const SIZE = { columns: 140, rows: 40 };

function mount(over: Record<string, unknown> = {}): RenderedTree {
  return renderTree(
    <DashboardApp
      run={runFor(root) as never}
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
}

/** Tab to the tab bar, then right twice: Overview -> Session -> Logs, and focus the panel. */
async function openLogs(tree: RenderedTree): Promise<void> {
  await wait();
  tree.write(KEYS.tab);
  await wait();
  tree.write(KEYS.right);
  await wait();
  tree.write(KEYS.right);
  await wait();
  tree.write(KEYS.enter);
  await wait(120);
}

beforeAll(async () => {
  root = await tmpDir('cao-logs-panel-');
  runId = '2026-09-17-001';
  const paths = createNativeRunPaths(root);
  const attempt = paths.attemptDir(runId, 'implement-parser', 1);
  await fs.mkdir(attempt, { recursive: true });
  await fs.writeFile(paths.runLogFile(runId), ['09:12:34 info  workflow started', '09:12:40 debug scheduler tick', '09:13:01 warn  retrying implement-parser', '09:13:30 error worker exploded'].join('\n') + '\n');
  await fs.writeFile(path.join(attempt, 'stderr.log'), 'a stderr line from the worker\n');
  const second = paths.attemptDir(runId, 'render', 1);
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(second, 'stderr.log'), 'the renderer complained\n');
  await fs.writeFile(path.join(second, 'events.jsonl'), `{"kind":"text","ts":"${ts}","text":"the renderer said something"}\n`);
  await fs.writeFile(path.join(attempt, 'prompt.md'), '# Task\nthe prompt that was sent\n');
  // ~52 MB of raw output, which is the file §3.7 says must open in under a second.
  const handle = await fs.open(path.join(attempt, 'stdout.log'), 'w');
  const block = Array.from({ length: 10_000 }, (_, i) => `{"type":"assistant","line":"stream message ${i}"}`).join('\n');
  for (let i = 0; i < 100; i += 1) await handle.write(`${block}\n`);
  await handle.close();
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('the Logs model (§3.7)', () => {
  it('lists the run files and the attempt files, newest attempt first', () => {
    const paths = createNativeRunPaths(root);
    const sources = logSources(runFor(root) as never, paths);
    expect(sources.slice(0, 2).map((s) => s.id)).toEqual(['orchestrator', 'run-events']);
    expect(sources.map((s) => s.kind)).toContain('stdout');
    expect(sourceTaskIds(sources)).toEqual(['implement-parser', 'render']);
    // The events view offers the run's own two plus each attempt's events.jsonl; stderr offers only stderr.
    expect(visibleSources(sources, 'events', {}).map((s) => s.id)).toEqual(['orchestrator', 'run-events', 'implement-parser#1:events', 'render#1:events']);
    expect(visibleSources(sources, 'stderr', {}).map((s) => s.id)).toEqual(['implement-parser#1:stderr', 'render#1:stderr']);
    expect(visibleSources(sources, 'raw', { taskId: 'nobody' })).toEqual([]);
  });

  it('reads the level and the time out of an orchestrator line, and a run event out of JSON', () => {
    const orchestrator: LogSource = { id: 'o', kind: 'orchestrator', label: 'orchestrator.log', file: '' };
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    const warn = parseLogLine('09:13:01 warn  retrying implement-parser', orchestrator, { width: 80, color: false, now })!;
    expect(warn.severity).toBe('warn');
    expect(warn.at).toBe(timeOfDayAt(9, 13, 1, now));
    // A line the logger did not write is still a line; it is never dropped for being unparsable.
    expect(parseLogLine('a stack frame', orchestrator, { width: 80, color: false, now })!.severity).toBe('info');
    expect(parseLogLine('   ', orchestrator, { width: 80, color: false, now })).toBeNull();

    const events: LogSource = { id: 'e', kind: 'run-events', label: 'run events.jsonl', file: '' };
    const failed = parseLogLine(`{"type":"task.failed","ts":"${ts}","taskId":"a","reason":"timeout"}`, events, { width: 120, color: false, now })!;
    expect(failed.severity).toBe('error');
    expect(failed.lines[0]).toContain('task.failed a');
    expect(failed.lines[0]).toContain('reason=timeout');
  });

  it('filters by severity and by time range, and never hides a line that has no time', () => {
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    const records = [
      { severity: 'debug' as const, at: now - 1000, lines: ['d'] },
      { severity: 'error' as const, at: now - 10 * 60_000, lines: ['e'] },
      { severity: 'info' as const, lines: ['no clock'] },
    ];
    expect(logLines(records, {}, now)).toEqual(['d', 'e', 'no clock']);
    expect(logLines(records, { severity: 'warn' }, now)).toEqual(['e']);
    // "last 5m" drops the error from ten minutes ago and keeps the line that never said when it was.
    expect(logLines(records, { range: 1 }, now)).toEqual(['d', 'no clock']);
    expect(filterRecords(records, { severity: 'error', range: 1 }, now)).toEqual([]);
  });

  it('finds every matching line, case-insensitively', () => {
    expect(searchMatches(['Alpha', 'beta', 'alphabet'], 'alpha')).toEqual([0, 2]);
    expect(searchMatches(['a'], '')).toEqual([]);
  });

  it('says what is being shown and what is filtered, in one line', () => {
    const source: LogSource = { id: 'x', kind: 'stderr', label: 'a#1 stderr.log', file: '' };
    const line = filterLine('stderr', source, { taskId: 'a', severity: 'warn', range: 2 });
    for (const part of ['view stderr', 'source a#1 stderr.log', 'task a', 'severity warn', 'time last 1h']) expect(line).toContain(part);
  });
});

describe('the Logs panel (§3.7, §5 row 12)', () => {
  it('opens on the orchestrator log and pages older lines in as it is scrolled', async () => {
    const tree = mount();
    try {
      await openLogs(tree);
      await tree.waitFor((frame) => frame.includes('workflow started'));
      const frame = tree.lastText();
      expect(frame).toContain('source orchestrator.log');
      expect(frame).toContain('worker exploded');
      expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(SIZE.rows);
    } finally {
      tree.unmount();
    }
  });

  it('opens a 50 MB stdout.log in under a second and scrolls back through it', async () => {
    const tree = mount();
    try {
      await openLogs(tree);
      // v steps events -> stderr -> raw; raw is stdout.log.
      const started = Date.now();
      tree.write('v');
      await wait();
      tree.write('v');
      await wait();
      await tree.waitFor((frame) => frame.includes('stdout.log') && frame.includes('stream message'));
      expect(Date.now() - started).toBeLessThan(1000);
      // The newest line of the file, which is the last line of the last block written.
      expect(tree.lastText()).toContain('stream message 9999');

      // Scrolling up past the first page reaches lines that were never in it, a page at a time from disk.
      for (let i = 0; i < 8; i += 1) {
        tree.write(KEYS.pageUp);
        await wait(80);
      }
      const scrolled = tree.lastText();
      expect(scrolled).not.toContain('stream message 9999');
      // Held, not whole: the buffer is still bounded by `execution.outputBufferLines`.
      expect(scrolled).toContain('held');
      // Far enough back that the lines on screen were never in the first page.
      expect(scrolled).toMatch(/stream message \d+/);
      expect(scrolled).not.toMatch(/stream message 99\d\d/);
      expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(SIZE.rows);
      for (const line of scrolled.split(NL)) expect([...line].length).toBeLessThanOrEqual(SIZE.columns);

      // G goes back to the newest line, whatever was paged in on the way.
      tree.write('G');
      await wait(60);
      expect(tree.lastText()).toContain('stream message 9999');
    } finally {
      tree.unmount();
    }
  }, 30_000);

  it('filters by severity and searches with / and n', async () => {
    const tree = mount();
    try {
      await openLogs(tree);
      await tree.waitFor((frame) => frame.includes('workflow started'));

      // k steps the severity floor: all -> debug -> info -> warn.
      for (let i = 0; i < 3; i += 1) {
        tree.write('k');
        await wait();
      }
      const filtered = tree.lastText();
      expect(filtered).toContain('severity warn');
      expect(filtered).toContain('retrying implement-parser');
      expect(filtered).not.toContain('workflow started');

      // Two more steps and the floor is back at `all`: the key cycles through the five states.
      for (let i = 0; i < 2; i += 1) {
        tree.write('k');
        await wait();
      }
      expect(tree.lastText()).toContain('severity all');
      tree.write('/');
      await wait();
      for (const ch of 'scheduler') {
        tree.write(ch);
        await wait(10);
      }
      tree.write(KEYS.enter);
      await wait();
      expect(tree.lastText()).toContain('1 match');
      tree.write('n');
      await wait();
      expect(tree.lastText()).toContain('scheduler tick');
    } finally {
      tree.unmount();
    }
  }, 30_000);

  it('keeps the attempt when a view change has a file for it (§3.7)', async () => {
    const tree = mount();
    try {
      await openLogs(tree);
      // Three files along the events view: orchestrator -> run events -> implement-parser#1 -> render#1.
      for (let i = 0; i < 3; i += 1) {
        tree.write(']');
        await wait(40);
      }
      expect(tree.lastText()).toContain('render#1 events');
      // `v` moves to stderr, whose *first* file belongs to the other task. The attempt on screen wins.
      tree.write('v');
      await wait(120);
      expect(tree.lastText()).toContain('render#1 stderr.log');
      await tree.waitFor((frame) => frame.includes('the renderer complained'));
    } finally {
      tree.unmount();
    }
  }, 30_000);
});
