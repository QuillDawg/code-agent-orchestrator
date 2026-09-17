/**
 * The workspace after the run has ended (spec §2.4, §3.1, [D5], [D36]).
 *
 * Every case is driven through the in-house harness at a real terminal size, because the whole point of
 * §2.4 is that there is still a frame to read: the old dashboard called `exit()` 50 ms after the run
 * finished, so the screen with the failure on it was the screen that disappeared. Each case therefore ends
 * the same way the rest of the workspace suite does — the frame fits the terminal it was laid out for.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import { stripAnsi } from '../../src/cli/color.js';
import type { ResumeRequest } from '../../src/workflow/resume-request.js';

const NL = String.fromCharCode(10);
const ts = '2026-09-17T09:12:34.000Z';
const ended = '2026-09-17T09:21:05.000Z';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const task = (id: string) => ({ id, agent: 'claude', dependsOn: [], retry: { attempts: 1 }, codex: {} });

interface TaskShape {
  state: string;
  outcome?: string;
  error?: string;
  message?: string;
  attempts?: number;
}

function endedRun(tasks: Record<string, TaskShape>, state = 'failed') {
  const ids = Object.keys(tasks);
  return {
    runId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
    workflowName: 'stack-upgrade',
    repositoryRoot: '/repo/code-agent-orchestrator',
    state,
    startedAt: ts,
    endedAt: ended,
    exitCode: state === 'completed' ? 0 : state === 'paused' ? 3 : 1,
    workflow: { execution: { maxConcurrency: 2 }, tasks: ids.map(task) },
    tasks: Object.fromEntries(
      ids.map((id) => {
        const shape = tasks[id]!;
        const count = shape.attempts ?? 1;
        return [
          id,
          {
            id,
            state: shape.state,
            message: shape.message,
            retryWindowStart: 1,
            attempts: Array.from({ length: count }, (_, i) => ({
              number: i + 1,
              kind: 'task',
              triggeredBy: 'initial',
              startedAt: ts,
              endedAt: ended,
              cwd: '.',
              files: {},
              ...(i === count - 1 ? { outcome: shape.outcome, error: shape.error } : { outcome: shape.outcome }),
            })),
          },
        ];
      }),
    ),
  };
}

const controllerStub = { peek: () => [], transcript: () => [], capturedDiff: async () => null, attemptTranscript: async () => [], readReport: async () => null };
const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

interface MountOptions {
  finished?: boolean;
  onResume?: (request: ResumeRequest) => void;
  onQuit?: () => void;
  onInterrupt?: () => void;
  onMinimise?: () => void;
  role?: 'owner' | 'observer';
  banner?: string;
  columns?: number;
  rows?: number;
}

function mount(run: unknown, opts: MountOptions = {}): { tree: RenderedTree; size: { columns: number; rows: number } } {
  const size = { columns: opts.columns ?? 100, rows: opts.rows ?? 30 };
  const tree = renderTree(
    <DashboardApp
      run={run as never}
      bus={{ onAny: () => () => undefined } as never}
      controller={controllerStub as never}
      shared={shared()}
      finished={opts.finished ?? true}
      onMinimise={opts.onMinimise ?? (() => undefined)}
      onInterrupt={opts.onInterrupt ?? (() => undefined)}
      onQuit={opts.onQuit ?? (() => undefined)}
      onResume={opts.onResume}
      role={opts.role}
      banner={opts.banner}
    />,
    size,
  );
  return { tree, size };
}

function fits(tree: RenderedTree, size: { columns: number; rows: number }): void {
  expect(frameHeight(tree.lastFrame()), 'taller than its terminal').toBeLessThanOrEqual(size.rows);
  for (const line of tree.lastText().split(NL)) expect([...line].length, `wider than its terminal: ${line}`).toBeLessThanOrEqual(size.columns);
}

describe('the workspace on an ended run', () => {
  it('leads with the outcome, the failed task and what can be done about it', async () => {
    const run = endedRun({
      'implement-parser': { state: 'success', outcome: 'success' },
      'implement-renderer': { state: 'failed', outcome: 'timeout', error: 'the worker did not answer in 2m', attempts: 3 },
      review: { state: 'cancelled', outcome: 'cancelled' },
    });
    const { tree, size } = mount(run, { onResume: () => undefined });
    try {
      await wait();
      const frame = tree.lastText();
      // §3.1: the outcome, the failed task with its AttemptOutcome, the latest error line, the attempts.
      expect(frame).toContain('Run failed');
      expect(frame).toContain('exit 1');
      expect(frame).toContain('implement-renderer timed out');
      expect(frame).toContain('after 3 attempts');
      expect(frame).toContain('the worker did not answer in 2m');
      // ...and the actions [D36]. `R re-run  F open logs  C open diff` is the *live* line; an ended run
      // offers resumes instead, because there is no scheduler left to restart anything in.
      expect(frame).toContain('S Resume run');
      expect(frame).not.toContain('R re-run    F open logs');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('offers the actions for the task it leads with, not for whatever the cursor was left on', async () => {
    // §3.1 asks the Overview to lead with the failed task *and the actions available for that task*. The
    // actions are built from the selection, and the selection was still on task 1 — so a run that failed
    // on the third task said "implement-renderer failed" and then offered "R Re-run implement-parser".
    const run = endedRun({
      'implement-parser': { state: 'success', outcome: 'success' },
      'port-schema': { state: 'success', outcome: 'success' },
      'implement-renderer': { state: 'failed', outcome: 'failed', error: 'the build failed', attempts: 2 },
      review: { state: 'pending' },
    });
    const requests: ResumeRequest[] = [];
    const { tree, size } = mount(run, { onResume: (r) => requests.push(r) });
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('implement-renderer failed');
      expect(frame).toContain('R Re-run implement-renderer');
      expect(frame).toContain('> Resume from implement-renderer');
      expect(frame).not.toContain('Re-run implement-parser');
      // The detail below the table is the same task, so the whole panel is about one thing.
      expect(frame).toContain('Status:       ✗ Failed');
      tree.write('r');
      await wait();
      expect(requests).toEqual([{ kind: 'task', taskId: 'implement-renderer' }]);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('leads a paused run with the task that is waiting for a person and what it asked', async () => {
    const run = endedRun(
      {
        'implement-parser': { state: 'success', outcome: 'success' },
        'ask-human': { state: 'needs_input', message: 'postgres or sqlite?' },
        review: { state: 'pending' },
      },
      'paused',
    );
    const { tree, size } = mount(run, { onResume: () => undefined });
    try {
      await wait();
      const frame = tree.lastText();
      // It used to say "Run paused   1/3 done   exit 3" and nothing else: the state without the one fact
      // that follows from it, which is who is waiting and what for.
      expect(frame).toContain('Run paused');
      expect(frame).toContain('ask-human needs input');
      expect(frame).toContain('postgres or sqlite?');
      // And the answer action is the one for that task, because the cursor moved to it.
      expect(frame).toContain('A Answer ask-human and resume');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('stops the clock in the header when the run ends', async () => {
    // The header read `now - startedAt` whatever the run was doing, so a workspace left open on a finished
    // run counted upwards for as long as it was open - and disagreed with the Overview's own outcome line,
    // which does use `endedAt`, on the same frame.
    const run = endedRun({ 'implement-parser': { state: 'failed', outcome: 'failed', error: 'boom' } });
    const { tree, size } = mount(run, { onResume: () => undefined });
    try {
      await wait();
      const header = tree.lastText().split(NL)[1] ?? '';
      // started 09:12:34, ended 09:21:05.
      expect(header).toContain('08m 31s');
      await wait(1100);
      expect(tree.lastText().split(NL)[1] ?? '').toContain('08m 31s');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('runs Resume run, Re-run task and Resume from task from their keys', async () => {
    const run = endedRun({ 'implement-parser': { state: 'failed', outcome: 'failed', error: 'boom' }, review: { state: 'cancelled', outcome: 'cancelled' } });
    const requests: ResumeRequest[] = [];
    const { tree, size } = mount(run, { onResume: (r) => requests.push(r) });
    try {
      await wait();
      tree.write('s');
      await wait();
      tree.write('r');
      await wait();
      tree.write('>');
      await wait();
      expect(requests).toEqual([{ kind: 'resume' }, { kind: 'task', taskId: 'implement-parser' }, { kind: 'from', taskId: 'implement-parser' }]);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('collects an answer for a needs_input task and resumes with it', async () => {
    const run = endedRun({ ask: { state: 'needs_input', outcome: 'needs_input', message: 'Which database?' } }, 'paused');
    const requests: ResumeRequest[] = [];
    const { tree, size } = mount(run, { onResume: (r) => requests.push(r) });
    try {
      await wait();
      expect(tree.lastText()).toContain('A Answer ask and resume');
      tree.write('a');
      await wait();
      expect(tree.lastText()).toContain('Answer ask and resume');
      expect(tree.lastText()).toContain('Which database?');
      for (const ch of 'postgres') {
        tree.write(ch);
        await wait(5);
      }
      await wait();
      expect(tree.lastText()).toContain('postgres');
      fits(tree, size);
      tree.write(KEYS.enter);
      await wait();
      expect(requests).toEqual([{ kind: 'answer', taskId: 'ask', text: 'postgres' }]);
      // The field closed behind the answer rather than staying up over the resume.
      expect(tree.lastText()).not.toContain('Enter send and resume');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('takes a newline with Ctrl+J and sends nothing on Esc', async () => {
    const run = endedRun({ ask: { state: 'needs_input', outcome: 'needs_input', message: 'Which database?' } }, 'paused');
    const requests: ResumeRequest[] = [];
    const { tree } = mount(run, { onResume: (r) => requests.push(r) });
    try {
      await wait();
      tree.write('a');
      await wait();
      tree.write('x');
      await wait();
      tree.write(KEYS.ctrlJ);
      await wait();
      tree.write('y');
      await wait();
      tree.write(KEYS.enter);
      await wait();
      expect(requests).toEqual([{ kind: 'answer', taskId: 'ask', text: `x${NL}y` }]);

      tree.write('a');
      await wait();
      tree.write('z');
      await wait();
      tree.write(KEYS.escape);
      await wait();
      expect(requests).toHaveLength(1);
      expect(tree.lastText()).not.toContain('Enter send and resume');
    } finally {
      tree.unmount();
    }
  });

  it('approves and rejects a paused gate', async () => {
    const run = endedRun({ deploy: { state: 'awaiting_approval', outcome: undefined } }, 'paused');
    const requests: ResumeRequest[] = [];
    const { tree, size } = mount(run, { onResume: (r) => requests.push(r) });
    try {
      await wait();
      expect(tree.lastText()).toContain('A Approve deploy');
      expect(tree.lastText()).toContain('X Reject deploy');
      tree.write('a');
      await wait();
      tree.write('x');
      await wait();
      expect(requests).toEqual([{ kind: 'approve', taskId: 'deploy' }, { kind: 'reject', taskId: 'deploy' }]);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('Q leaves at once on an ended run [D5]', async () => {
    const run = endedRun({ a: { state: 'failed', outcome: 'failed', error: 'boom' } });
    let quits = 0;
    const { tree } = mount(run, { onResume: () => undefined, onQuit: () => (quits += 1) });
    try {
      await wait();
      tree.write('q');
      await wait();
      expect(quits).toBe(1);
      // No prompt: there is nothing left to stop and nothing to carry on in plain output.
      expect(tree.lastText()).not.toContain('The run is still going');
    } finally {
      tree.unmount();
    }
  });

  it('shows the observer banner instead of the actions, and answers none of their keys [D37]', async () => {
    const run = endedRun({ a: { state: 'failed', outcome: 'failed', error: 'boom' } });
    const requests: ResumeRequest[] = [];
    const { tree, size } = mount(run, { onResume: (r) => requests.push(r), role: 'observer', banner: 'Another process (pid 4242) took this run; this window is watching.' });
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('[observer]');
      expect(frame).toContain('pid 4242');
      expect(frame).not.toContain('S Resume run');
      tree.write('s');
      await wait();
      expect(requests).toEqual([]);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });
});

describe('quitting while the run is still going [D5]', () => {
  const live = () => endedRun({ a: { state: 'running', outcome: undefined }, b: { state: 'pending', outcome: undefined } }, 'running');

  it('offers stay, stop and quit, and plain output', async () => {
    const { tree, size } = mount(live(), { finished: false });
    try {
      await wait();
      tree.write('q');
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('The run is still going');
      expect(frame).toContain('Stay');
      expect(frame).toContain('Stop and quit');
      expect(frame).toContain('Continue in plain output');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('shows what each answer means whole, at every terminal it can be asked on', async () => {
    // The box was capped at 72 columns inside a panel that was wider, so the sentence an operator reads to
    // choose between the three answers ended in "…leave with the run's exit c". This is the one prompt
    // whose whole job is that sentence: what does not fit on the row drops onto its own instead.
    for (const [columns, rows] of [
      [80, 24],
      [100, 30],
      [120, 40],
    ] as const) {
      const { tree, size } = mount(live(), { finished: false, columns, rows });
      try {
        await wait();
        tree.write('q');
        await wait();
        const frame = tree.lastText();
        for (const answer of ['go back to the workspace; nothing changes', "stop the workers, then leave with the run's exit code", 'the run carries on printing lines; D or Enter reopens this']) {
          expect(frame, `${columns}x${rows} cut "${answer}"`).toContain(answer);
        }
        fits(tree, size);
      } finally {
        tree.unmount();
      }
    }
  });

  it('stays on S and on Esc, and changes nothing', async () => {
    let quits = 0;
    let minimised = 0;
    const { tree } = mount(live(), { finished: false, onQuit: () => (quits += 1), onMinimise: () => (minimised += 1) });
    try {
      await wait();
      tree.write('q');
      await wait();
      tree.write('s');
      await wait();
      expect(tree.lastText()).not.toContain('The run is still going');
      tree.write('q');
      await wait();
      tree.write(KEYS.escape);
      await wait();
      expect(tree.lastText()).not.toContain('The run is still going');
      expect([quits, minimised]).toEqual([0, 0]);
    } finally {
      tree.unmount();
    }
  });

  it('stops and quits on Q, and minimises on P', async () => {
    let quits = 0;
    let interrupts = 0;
    let minimised = 0;
    const { tree } = mount(live(), { finished: false, onQuit: () => (quits += 1), onInterrupt: () => (interrupts += 1), onMinimise: () => (minimised += 1) });
    try {
      await wait();
      tree.write('q');
      await wait();
      tree.write('q');
      await wait();
      // Both, in that order: the run is asked to stop and the session is told to leave when it has.
      expect([interrupts, quits]).toEqual([1, 1]);
    } finally {
      tree.unmount();
    }

    const second = mount(live(), { finished: false, onQuit: () => (quits += 1), onMinimise: () => (minimised += 1) });
    try {
      await wait();
      second.tree.write('q');
      await wait();
      second.tree.write('p');
      await wait();
      expect(minimised).toBe(1);
    } finally {
      second.tree.unmount();
    }
  });

  it('chooses an answer with the arrow keys and Enter too', async () => {
    let minimised = 0;
    const { tree } = mount(live(), { finished: false, onMinimise: () => (minimised += 1) });
    try {
      await wait();
      tree.write('q');
      await wait();
      tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.enter);
      await wait();
      expect(minimised).toBe(1);
    } finally {
      tree.unmount();
    }
  });

  it('Ctrl+C asks the run to stop and the workspace stays on screen', async () => {
    let interrupts = 0;
    const { tree, size } = mount(live(), { finished: false, onInterrupt: () => (interrupts += 1) });
    try {
      await wait();
      tree.write(KEYS.ctrlC);
      await wait();
      expect(interrupts).toBe(1);
      const frame = tree.lastText();
      expect(frame).toContain('Stopping the run; the workspace stays open.');
      // Still a workspace: the header and the tab bar are where they were.
      expect(frame).toContain('stack-upgrade');
      expect(frame).toContain('[Overview]');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });
});

describe('the ended state at 80x24', () => {
  it('fits, and still names the outcome and an action', async () => {
    const run = endedRun({
      'implement-parser': { state: 'failed', outcome: 'crash', error: 'the worker exited with signal SIGSEGV before it wrote a result', attempts: 2 },
      'implement-renderer': { state: 'cancelled', outcome: 'cancelled' },
      review: { state: 'pending', outcome: undefined },
    });
    const size = { columns: 80, rows: 24 };
    const { tree } = mount(run, { onResume: () => undefined, ...size });
    try {
      await wait();
      const frame = stripAnsi(tree.lastFrame());
      expect(frame).toContain('Run failed');
      expect(frame).toContain('implement-parser crashed');
      expect(frame).toContain('S Resume run');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });
});
