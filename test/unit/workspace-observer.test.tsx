/**
 * The workspace on a run another process owns (spec §2.1, §2.3, `[D3]`, `[D37]`).
 *
 * Driven through the in-house harness at a real terminal size, like the rest of the workspace suite: what
 * observer mode *is* is a screen — a badge that says who has the run, a block that says where a question has
 * to be answered, and three keys that leave as files instead of changing anything here.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import type { ControlOutcome, ObserverControl, ObserverSurface } from '../../src/workflow/control/observer.js';
import type { CapabilityToken } from 'code-agent-orchestrator-protocol';

const NL = String.fromCharCode(10);
const ts = '2026-09-17T09:12:34.000Z';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const task = (id: string) => ({ id, agent: 'claude', dependsOn: [], retry: { attempts: 1 }, codex: {} });

interface TaskShape {
  state: string;
  pending?: { kind: string; title: string };
}

function liveRun(tasks: Record<string, TaskShape>, state = 'running') {
  const ids = Object.keys(tasks);
  return {
    runId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
    workflowName: 'stack-upgrade',
    repositoryRoot: '/repo/code-agent-orchestrator',
    state,
    startedAt: ts,
    workflow: { execution: { maxConcurrency: 2 }, tasks: ids.map(task) },
    tasks: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          state: tasks[id]!.state,
          retryWindowStart: 1,
          pendingInteraction: tasks[id]!.pending ? { id: `${id}-i`, askedAt: ts, ...tasks[id]!.pending } : undefined,
          attempts: [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: ts, cwd: '.', files: {} }],
        },
      ]),
    ),
  };
}

const controllerStub = { peek: () => [], transcript: () => [], capturedDiff: async () => null, steerable: () => false, attemptTranscript: async () => [], readReport: async () => null };
const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

/** The owner, as this window can reach it: a list of what it was asked, and whatever it was told to answer. */
function surfaceDouble(capabilities: readonly CapabilityToken[], answer: (control: ObserverControl) => ControlOutcome | Promise<ControlOutcome> = () => ({ status: 'applied' })) {
  const sent: ObserverControl[] = [];
  const surface: ObserverSurface = {
    ownerPid: 4242,
    capabilities,
    send: async (control) => {
      sent.push(control);
      return answer(control);
    },
  };
  return { sent, surface };
}

interface MountOptions {
  columns?: number;
  rows?: number;
  observer?: ObserverSurface;
  banner?: string;
  badge?: string;
  role?: 'owner' | 'observer';
  onInterrupt?: () => void;
}

function mount(run: unknown, opts: MountOptions = {}): { tree: RenderedTree; size: { columns: number; rows: number } } {
  const size = { columns: opts.columns ?? 110, rows: opts.rows ?? 32 };
  const tree = renderTree(
    <DashboardApp
      run={run as never}
      bus={{ onAny: () => () => undefined } as never}
      controller={controllerStub as never}
      shared={shared()}
      // `cao ui` on a run somebody else owns opens with nothing executing here, which is what `finished`
      // means to this tree: there is no scheduler in this process (§2.4).
      finished
      onMinimise={() => undefined}
      onInterrupt={opts.onInterrupt ?? (() => undefined)}
      onQuit={() => undefined}
      onResume={() => undefined}
      role={opts.role ?? 'observer'}
      banner={opts.banner ?? 'Run 01K5 is owned by pid 4242; this window is watching. Approvals and questions are answered in that terminal.'}
      badge={opts.badge ?? 'observing · owner pid 4242'}
      observer={opts.observer}
    />,
    size,
  );
  return { tree, size };
}

function fits(tree: RenderedTree, size: { columns: number; rows: number }): void {
  expect(frameHeight(tree.lastFrame()), 'taller than its terminal').toBeLessThanOrEqual(size.rows);
  for (const line of tree.lastText().split(NL)) expect([...line].length, `wider than its terminal: ${line}`).toBeLessThanOrEqual(size.columns);
}

describe('the workspace while another process owns the run', () => {
  it('says who has the run in the badge and in the banner', async () => {
    const { surface } = surfaceDouble(['stop', 'kill']);
    const { tree, size } = mount(liveRun({ 'implement-api': { state: 'running' } }), { observer: surface });
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('observing · owner pid 4242');
      expect(frame).toContain('owned by pid 4242');
      // Not the ended state: the run has not ended, it is being executed somewhere else (§2.1).
      expect(frame).toContain('Run running');
      expect(frame).not.toContain('S Resume run');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('shows a pending question read-only and opens no modal for it [D3]', async () => {
    const run = liveRun({ 'implement-api': { state: 'needs_input', pending: { kind: 'question', title: 'which database?' } }, review: { state: 'awaiting_approval' } });
    const { surface } = surfaceDouble(['stop']);
    const { tree, size } = mount(run, { observer: surface });
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('implement-api (question: which database?)');
      expect(frame).toContain('review (approval)');
      expect(frame).toContain('answer in the owning terminal (pid 4242)');
      // No answer keys and no prompt: `approve`, `reject` and `answer` do not cross the boundary [D3].
      expect(frame).not.toContain('A Answer');
      expect(frame).not.toContain('Y allow');
      tree.write('a');
      await wait();
      expect(tree.lastText()).not.toContain('Answer implement-api');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('sends stop, kill and re-run from their keys and shows what came back', async () => {
    const run = liveRun({ 'implement-api': { state: 'failed' } });
    const { sent, surface } = surfaceDouble(['stop', 'kill', 'restart'], (c) => (c.kind === 'restart' ? { status: 'rejected', reason: 'task is running' } : { status: 'applied' }));
    const { tree, size } = mount(run, { observer: surface });
    try {
      await wait();
      expect(tree.lastText()).toContain('S Stop the run');
      tree.write('s');
      await wait();
      expect(tree.lastText()).toContain('stop sent → applied');
      tree.write('k');
      await wait();
      tree.write('r');
      await wait();
      expect(sent).toEqual([{ kind: 'stop', taskId: undefined }, { kind: 'kill', taskId: undefined }, { kind: 'restart', taskId: 'implement-api' }]);
      // §2.3: a rejection carries a reason a human can act on, and it is the notice.
      expect(tree.lastText()).toContain('restart implement-api sent → rejected: task is running');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('offers nothing the run does not advertise', async () => {
    const run = liveRun({ 'implement-api': { state: 'failed' } });
    const { sent, surface } = surfaceDouble(['stop']);
    const { tree, size } = mount(run, { observer: surface });
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('S Stop the run');
      expect(frame).not.toContain('K Kill the run');
      expect(frame).not.toContain('R Re-run');
      tree.write('k');
      await wait();
      expect(sent).toEqual([]);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('turns Ctrl+C into a stop request, then into a kill, and interrupts nothing here', async () => {
    const run = liveRun({ 'implement-api': { state: 'running' } });
    const { sent, surface } = surfaceDouble(['stop', 'kill']);
    const interrupts: number[] = [];
    const { tree, size } = mount(run, { observer: surface, onInterrupt: () => interrupts.push(1) });
    try {
      await wait();
      tree.write(KEYS.ctrlC);
      await wait();
      tree.write(KEYS.ctrlC);
      await wait();
      expect(sent.map((c) => c.kind)).toEqual(['stop', 'kill']);
      // There is no scheduler in this process, so nothing local is asked to stop (§2.1).
      expect(interrupts).toEqual([]);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('keeps every control it sent in the Diagnostics panel after the notice has gone', async () => {
    const run = liveRun({ 'implement-api': { state: 'running' } });
    const { surface } = surfaceDouble(['stop'], () => ({ status: 'timeout', reason: 'the request is still in requests/' }));
    const { tree, size } = mount(run, { observer: surface });
    try {
      await wait();
      tree.write('s');
      await wait();
      // Tab to the tab bar, then to Diagnostics.
      tree.write(KEYS.tab);
      await wait();
      for (let i = 0; i < 5; i += 1) {
        tree.write(KEYS.right);
        await wait(10);
      }
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('Controls sent from this window');
      expect(frame).toContain('stop → no answer yet');
      expect(frame).toContain('the request is still in requests/');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('documents the observer keys under ? as the panel offers them', async () => {
    const run = liveRun({ 'implement-api': { state: 'running' } });
    const { surface } = surfaceDouble(['stop', 'kill']);
    const { tree, size } = mount(run, { observer: surface });
    try {
      await wait();
      tree.write('?');
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('Another process owns this run');
      expect(frame).toContain('Stop the run — sent to the owner as a request');
      expect(frame).toContain('ask the owner to stop the run');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('never reaches the controller in this process with R, whatever the selection is', async () => {
    // `restart` is advertised, but a task that has succeeded is not one the owner would take a request
    // for, so `R` used to fall through to the local restart — and the panel and `?` went on offering it as
    // "restart a failed, blocked, cancelled or skipped task", which is not what this window can do at all.
    const run = liveRun({ 'implement-api': { state: 'success' } });
    const submitted: unknown[] = [];
    const { sent, surface } = surfaceDouble(['stop', 'kill', 'restart']);
    const size = { columns: 110, rows: 32 };
    const tree = renderTree(
      <DashboardApp
        run={run as never}
        bus={{ onAny: () => () => undefined } as never}
        controller={{ ...controllerStub, submit: (command: unknown) => { submitted.push(command); return Promise.resolve({ status: 'applied' }); } } as never}
        shared={shared()}
        finished
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
        onQuit={() => undefined}
        role="observer"
        banner="owned by pid 4242"
        badge="observing · owner pid 4242"
        observer={surface}
      />,
      size,
    );
    try {
      await wait();
      expect(tree.lastText()).not.toContain('R restart');
      tree.write('r');
      await wait();
      expect(submitted, 'an observer submitted a command to this process').toEqual([]);
      expect(sent, 'an observer sent a request the owner would refuse').toEqual([]);
      expect(tree.lastText()).toContain('watching pid 4242');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('leaves at once on Q rather than asking the three questions about workers it does not have', async () => {
    // `?` and the footer both say `Q` closes the window. The quit prompt [D5] is about the workers in
    // *this* process, and an observer has none: "stop and quit" would stop nothing and "continue in plain
    // output" has no output to continue.
    const run = liveRun({ 'implement-api': { state: 'running' } });
    const { surface } = surfaceDouble(['stop']);
    const quits: number[] = [];
    const size = { columns: 110, rows: 32 };
    const tree = renderTree(
      <DashboardApp
        run={run as never}
        bus={{ onAny: () => () => undefined } as never}
        controller={controllerStub as never}
        shared={shared()}
        // Deliberately not `finished`: an observer that took over a window mid-session is still an observer.
        finished={false}
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
        onQuit={() => quits.push(1)}
        role="observer"
        banner="owned by pid 4242"
        badge="observing · owner pid 4242"
        observer={surface}
      />,
      size,
    );
    try {
      await wait();
      tree.write('q');
      await wait();
      expect(quits).toEqual([1]);
      expect(tree.lastText()).not.toContain('The run is still going. What now?');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('says abandoned rather than observing once the owner has gone', async () => {
    const run = liveRun({ 'implement-api': { state: 'failed' } }, 'running');
    // What the session does on the flip: the role goes back to owner, the surface goes away, §2.4 returns.
    const { tree, size } = mount(run, { role: 'owner', badge: 'abandoned · resume?', banner: undefined, observer: undefined });
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('abandoned · resume?');
      expect(frame).toContain('S Resume run');
      expect(frame).not.toContain('S Stop the run');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });
});
