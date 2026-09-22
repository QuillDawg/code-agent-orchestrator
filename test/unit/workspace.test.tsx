/**
 * The workspace shell, driven through the in-house harness at the two terminal sizes the spec names (§2.5,
 * §3.2): 80x24, where the sidebar collapses and the footer sheds a column, and 120x40, where everything is
 * on screen at once.
 *
 * Every case ends with the same assertion — the frame is not taller than the terminal it was laid out for —
 * because that is the property Ink 7 needs in order not to wipe the scrollback or tear on Windows, and it is
 * the one a new panel breaks without anything else looking wrong.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { attachStore, TAB_LABEL, WORKSPACE_TABS, type WorkspaceTab } from '../../src/tui/store.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { createRunController } from '../../src/workflow/control/controller.js';
import { stripAnsi } from '../../src/cli/color.js';
import { glyph } from '../../src/util/glyphs.js';
import { render as renderInk } from 'ink-testing-library';
import { Footer, Sidebar, TabBar } from '../../src/tui/workspace/chrome.js';
import { alwaysHintCells, footerHints } from '../../src/tui/workspace/keys.js';
import { footerColumnsFor } from '../../src/tui/workspace/layout.js';
import { Overview } from '../../src/tui/workspace/overview.js';
import { resolveTheme } from '../../src/tui/theme.js';

const ESC = String.fromCharCode(27);
/** Any SGR that sets a colour: the sixteen, the 256-colour cube and truecolor, foreground or background. */
const SGR_COLOUR = new RegExp(`${ESC}\\[[0-9;]*?(3[0-7]|4[0-7]|9[0-7]|10[0-7]|[34]8;[25];)`);
const NL = String.fromCharCode(10);
const ts = '2026-09-17T09:12:34.000Z';

// See test/unit/dashboard.test.tsx: React 19 commits a keystroke on a scheduler task and flushes the
// effects after it, so each step is drained before the next key is written.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const task = (id: string, agent: 'claude' | 'codex' = 'claude') => ({ id, agent, dependsOn: [], retry: { attempts: 1 }, codex: {} });

/**
 * A frame as one line, with the sidebar seam taken out.
 *
 * The workspace draws a rule between the task list and the panel, so a panel row that wraps has that
 * character between its two halves. Flattening without removing it splices the rule into the middle of
 * every wrapped sentence, which is a fact about the frame rather than about the sentence.
 */
const unseam = (frame: string): string => frame.replace(/[\u2502|]/g, ' ').replace(/\s+/g, ' ');

const runWith = (ids: string[], over: Record<string, unknown> = {}) => ({
  runId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
  workflowName: 'stack-upgrade',
  repositoryRoot: '/repo/code-agent-orchestrator',
  state: 'running',
  startedAt: ts,
  workflow: { execution: { maxConcurrency: 2 }, tasks: ids.map((id) => task(id)) },
  tasks: Object.fromEntries(
    ids.map((id, i) => [
      id,
      {
        id,
        state: i === 0 ? 'running' : i === 1 ? 'failed' : 'pending',
        message: i === 1 ? 'exit code 1' : undefined,
        retryWindowStart: 1,
        attempts: i < 2 ? [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: ts, cwd: '.', files: {}, ...(i === 1 ? { endedAt: ts, outcome: 'failed', error: 'the build failed' } : {}) }] : [],
      },
    ]),
  ),
  ...over,
});

const controllerStub = {
  peek: () => [],
  transcript: () => [],
  capturedDiff: async () => null,
  steerable: () => false,
  attemptTranscript: async () => [],
  readReport: async () => '# Run report\n\nTask **implement-parser** succeeded.\n',
};

const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

function mount(run: unknown, size: { columns: number; rows: number }, over: Record<string, unknown> = {}): RenderedTree {
  return renderTree(
    <DashboardApp
      run={run as never}
      bus={{ onAny: () => () => undefined } as never}
      controller={{ ...controllerStub, ...over } as never}
      shared={shared()}
      finished={false}
      onMinimise={() => undefined}
      onInterrupt={() => undefined}
    />,
    size,
  );
}

/**
 * Poll a frame from inside `act`. `IS_REACT_ACT_ENVIRONMENT` makes React hold its work until an `act`
 * boundary, so a bare poll loop never sees the frame the event it is waiting for produced.
 */
async function waitForFrame(tree: RenderedTree, predicate: (text: string) => boolean, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate(stripAnsi(tree.lastFrame()))) return;
    if (Date.now() > deadline) throw new Error(`timed out. Last frame:
${stripAnsi(tree.lastFrame())}`);
    await wait(20);
  }
}

/** The assertion every case here ends with (§2.5). */
function fits(tree: RenderedTree, size: { columns: number; rows: number }): void {
  expect(frameHeight(tree.lastFrame()), 'taller than its terminal').toBeLessThanOrEqual(size.rows);
  for (const line of tree.lastText().split(NL)) expect([...line].length, `wider than its terminal: ${line}`).toBeLessThanOrEqual(size.columns);
}

const SIZES = [
  { name: '80x24', columns: 80, rows: 24 },
  { name: '120x40', columns: 120, rows: 40 },
] as const;

describe('the workspace at each terminal size', () => {
  for (const size of SIZES) {
    it(`shows the header, the task list and the footer at ${size.name}`, async () => {
      const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
      try {
        await wait();
        const frame = tree.lastText();
        // Everything §3.2 asks the header for.
        expect(frame).toContain('stack-upgrade');
        expect(frame).toContain('01K5ABCDEFGHJKMNPQRSTVWXYZ');
        expect(frame).toContain('/repo/code-agent-orchestrator');
        expect(frame).toContain('Running');
        expect(frame).toContain('[owner]');
        expect(frame).toContain('1/2'); // concurrency
        // The sidebar at 120x40, the one-line strip at 80x24.
        // The sidebar at 120x40; the one-line strip it collapses to at 80x24.
        expect(frame.includes('Tasks 1/3')).toBe(size.columns >= 100);
        expect(frame.includes('Task 1/3 ')).toBe(size.columns < 100);
        // Whatever else it drops, the footer says how to leave and where the rest of the keys are.
        expect(frame).toContain('? help');
        expect(frame).toContain('Q quit');
        fits(tree, size);
      } finally {
        tree.unmount();
      }
    });

    it(`opens every tab at ${size.name} and each one says what it is`, async () => {
      const expected: Record<WorkspaceTab, string> = {
        overview: 'Status:',
        session: 'Enter opens the composer',
        logs: 'view events',
        changes: 'no diff captured',
        report: 'Run report',
        diagnostics: 'Effective configuration',
      };
      const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
      try {
        await wait();
        tree.write(KEYS.tab); // focus the tab bar
        await wait();
        for (const [i, tab] of WORKSPACE_TABS.entries()) {
          if (i > 0) {
            tree.write(KEYS.right);
            await wait(60);
          }
          const frame = tree.lastText();
          expect(frame, `${tab} is not the open tab`).toContain(`[${TAB_LABEL[tab]}]`);
          expect(frame, `${tab} says nothing`).toContain(expected[tab]);
          fits(tree, size);
        }
      } finally {
        tree.unmount();
      }
    });

    it(`leads the Overview with the failed task at ${size.name}`, async () => {
      const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
      try {
        await wait();
        const frame = tree.lastText();
        // §3.1: the task, the category, the error line, the attempt count and what can be done about it.
        expect(frame).toContain('implement-renderer failed');
        expect(frame).toContain('after 1 attempt');
        expect(frame).toContain('the build failed');
        expect(frame).toContain('R re-run');
        fits(tree, size);
      } finally {
        tree.unmount();
      }
    });
  }
});

describe('navigation', () => {
  const size = { columns: 120, rows: 40 };

  it('cycles focus with Tab and back with Shift+Tab, in both of the sequences a terminal sends', async () => {
    const tree = mount(runWith(['a', 'b', 'c']), size);
    try {
      await wait();
      // The footer names the panel that has the keys, which is how focus is visible at all. Each of the
      // three has a key the other two do not, so the assertion cannot pass on the wrong panel.
      expect(tree.lastText()).toContain('/ search');
      tree.write(KEYS.tab);
      await wait();
      expect(tree.lastText()).toContain('←→ tab');
      tree.write(KEYS.tab);
      await wait();
      expect(tree.lastText()).toContain('U usage');
      tree.write(KEYS.shiftTab);
      await wait();
      expect(tree.lastText()).toContain('←→ tab');
      // The `\x1bOZ` variant some Windows terminals send for Shift+Tab (§3.2, [D40]).
      tree.write(`${ESC}OZ`);
      await wait();
      expect(tree.lastText()).toContain('/ search');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('moves the cursor with the arrows, PgUp/PgDn and Home/End without leaving the list', async () => {
    const tree = mount(runWith(['a', 'b', 'c', 'd', 'e']), size);
    try {
      await wait();
      // The sidebar's title line, which says where the cursor is; the rest of the line is the main panel.
      const selected = (): string => /Tasks \d+\/\d+/.exec(tree.lastText())?.[0] ?? '';
      expect(selected()).toBe('Tasks 1/5');
      tree.write(KEYS.down);
      await wait();
      expect(selected()).toBe('Tasks 2/5');
      tree.write(KEYS.end);
      await wait();
      expect(selected()).toBe('Tasks 5/5');
      tree.write(KEYS.pageDown);
      await wait();
      expect(selected()).toBe('Tasks 5/5');
      tree.write(KEYS.home);
      await wait();
      expect(selected()).toBe('Tasks 1/5');
      tree.write(KEYS.up);
      await wait();
      expect(selected()).toBe('Tasks 1/5');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('filters the command palette with Ctrl+P and runs what Enter lands on', async () => {
    const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
    try {
      await wait();
      tree.write(KEYS.ctrlP);
      await wait();
      expect(tree.lastText()).toContain('Go to Overview');
      expect(tree.lastText()).toContain('Restart the selected task');
      fits(tree, size);

      for (const ch of 'report') {
        tree.write(ch);
        await wait(10);
      }
      await wait();
      const filtered = tree.lastText();
      expect(filtered).toContain('Go to Report');
      expect(filtered).not.toContain('Restart the selected task');
      fits(tree, size);

      tree.write(KEYS.enter);
      await wait(60);
      expect(tree.lastText()).toContain('[Report]');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('wraps a help row rather than cutting the half of the sentence that matters', async () => {
    // `?` is the panel an operator opens *because* a key surprised them, and at 80 columns its rows ended
    // mid-answer: "Q  quit: while a run is going it asks first; on an ended run it le…".
    for (const small of [
      { columns: 80, rows: 24 },
      { columns: 120, rows: 40 },
    ]) {
      const tree = mount(runWith(['a', 'b']), small);
      try {
        await wait();
        tree.write('?');
        await wait();
        const frame = tree.lastText();
        expect(frame).toContain('the panel with the keys');
        // The whole of each sentence is on screen, across two rows when it has to be.
        // The sidebar seam is taken out first: a panel row that wraps has the seam's rule between its two
        // halves, which the reader's eye skips and a naive flatten would splice into the sentence.
        const flat = unseam(frame);
        expect(flat, `${small.columns} cut a help row`).toContain('quit: stay, stop and quit, or carry on in plain output');
        expect(flat, `${small.columns} cut a help row`).toContain('stop the run and stay here; again within 20s forces it');
        expect(flat, `${small.columns} cut a help row`).toContain('restart a failed, blocked, cancelled or skipped task');
        // The longest row in the table, and the one an 80-column panel has no room for on a single line.
        // Paged to rather than counted to: the panel grows a section whenever the spec does, and a fixed
        // number of PgDn presses is a test that goes red for the wrong reason the next time it does.
        let found = '';
        for (let page = 0; page < 12 && !found.includes('allow, allow for the rest of the task'); page += 1) {
          tree.write(KEYS.pageDown);
          await wait();
          found = unseam(tree.lastText());
        }
        expect(found, `${small.columns} cut the longest help row`).toContain('allow, allow for the rest of the task, deny, deny with a reason');
        fits(tree, small);
      } finally {
        tree.unmount();
      }
    }
  });

  it('sends a pause on P, and a resume on P again once the run is held', async () => {
    const sent: Array<{ kind: string; taskId?: string }> = [];
    const submit = async (command: { kind: string }) => {
      sent.push(command as never);
      return { protocol: 1, id: 'x', status: 'applied' as const, reason: 'Paused.', at: ts };
    };
    const tree = mount(runWith(['implement-parser', 'review']), size, { submit });
    try {
      await wait();
      tree.write('p');
      await wait();
      expect(sent).toEqual([{ kind: 'pause' }]);
      tree.unmount();
    } finally {
      // A second press on a run the snapshot now reports as held means the other half of the same key.
      const held = mount(runWith(['implement-parser', 'review'], { state: 'paused' }), size, { submit });
      await wait();
      held.write('p');
      await wait();
      expect(sent[sent.length - 1]).toEqual({ kind: 'resume' });
      held.unmount();
    }
  });

  it('sends a suspend on Z, and a continue on Z once the task is suspended', async () => {
    const sent: Array<{ kind: string; taskId?: string }> = [];
    const submit = async (command: { kind: string }) => {
      sent.push(command as never);
      return { protocol: 1, id: 'x', status: 'applied' as const, reason: 'ok', at: ts };
    };
    const run = runWith(['implement-parser', 'review']);
    const tree = mount(run, size, { submit });
    try {
      await wait();
      tree.write('z');
      await wait();
      expect(sent).toEqual([{ kind: 'suspendTask', taskId: 'implement-parser' }]);
    } finally {
      tree.unmount();
    }

    const suspended = runWith(['implement-parser', 'review']) as { tasks: Record<string, { state: string }> };
    suspended.tasks['implement-parser']!.state = 'suspended';
    const back = mount(suspended, size, { submit });
    try {
      await wait();
      back.write('z');
      await wait();
      expect(sent[sent.length - 1]).toEqual({ kind: 'resumeTask', taskId: 'implement-parser' });
      // And the state is drawn under its own name rather than borrowing another one's.
      expect(back.lastText()).toContain('Suspended');
    } finally {
      back.unmount();
    }
  });

  it('does not offer R, F and C under a failed task while the cursor is on another one', async () => {
    // `R`, `F` and `C` act on the *selected* task, and while a run is going the selection is wherever the
    // operator left it — so a run that failed on its third task offered "R re-run" under the name of that
    // task and restarted the first one instead, without a word.
    const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
    try {
      await wait();
      expect(tree.lastText()).toContain('implement-renderer failed');
      expect(tree.lastText()).toContain('to implement-renderer, then R re-run');
      expect(tree.lastText()).not.toContain('  R re-run    F open logs');
      // On the failed task itself the keys do what the line says, so the line is the plain one again.
      tree.write(KEYS.down);
      await wait();
      expect(tree.lastText()).toContain('R re-run    F open logs    C open diff');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('keeps the usage view inside the terminal, header and all', async () => {
    // The `N more` marker was not in the view's row budget, so on a run too long to fit the tree was one
    // row taller than the terminal and Yoga took the row out of the first child: the header's own title.
    const many = Array.from({ length: 60 }, (_, i) => `fan-out-${String(i + 1).padStart(3, '0')}`);
    for (const small of [
      { columns: 80, rows: 24 },
      { columns: 120, rows: 40 },
    ]) {
      const tree = mount(runWith(many), small);
      try {
        await wait();
        tree.write('u');
        await wait(80);
        const frame = tree.lastText();
        expect(frame).toContain('S sort by cost');
        expect(frame, `${small.columns}x${small.rows} lost the header`).toContain('stack-upgrade');
        expect(frame).toContain('more');
        fits(tree, small);
      } finally {
        tree.unmount();
      }
    }
  });

  it('means the same thing by Q in the Changes tab as in every other panel', async () => {
    // The review view was a screen of its own, where `Q` meant "back to the dashboard". As a panel of the
    // workspace that made `Q` the only key with two meanings on one screen: back to the task list here,
    // leave the workspace everywhere else. `Esc` is the way back now and `Q` is the way out.
    let quits = 0;
    const tree = renderTree(
      <DashboardApp
        run={runWith(['a', 'b']) as never}
        bus={{ onAny: () => () => undefined } as never}
        controller={controllerStub as never}
        shared={shared()}
        finished={false}
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
        onQuit={() => (quits += 1)}
      />,
      size,
    );
    try {
      await wait();
      tree.write('c');
      await wait(80);
      expect(tree.lastText()).toContain('[Changes]');
      expect(tree.lastText()).toContain('Esc back');
      expect(tree.lastText()).not.toContain('Esc/Q back');
      tree.write('q');
      await wait(60);
      // A run that is still going asks first [D5], which is the same thing `Q` does in the other panels.
      expect(tree.lastText()).toContain('The run is still going');
      expect(quits).toBe(0);
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('names what a waiting task is waiting for, not "approval" for every one of them', async () => {
    const run = runWith(['a', 'ask-human']) as unknown as { tasks: Record<string, { state: string; message?: string }> };
    run.tasks['ask-human'] = { ...run.tasks['ask-human']!, state: 'needs_input', message: 'postgres or sqlite?' };
    const tree = mount(run, size);
    try {
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('Needs you: ask-human (postgres or sqlite?)');
      expect(frame).not.toContain('ask-human (approval)');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('shows what has been typed into the palette, at every terminal it opens on', async () => {
    // The box had no height of its own, so on a terminal with fewer rows than it wanted Yoga shrank it and
    // took the shrink out of the first child: at 80x24 the palette drew its matches with no sign at all of
    // the query that had found them.
    for (const small of [
      { columns: 80, rows: 24 },
      { columns: 100, rows: 30 },
      { columns: 120, rows: 40 },
    ]) {
      // Enough tasks that the entry list is longer than the panel: that is when Yoga has to take the rows
      // from somewhere, and the somewhere used to be the query line.
      const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review', 'port-schema', 'migrate-runner', 'update-docs', 'final-review', 'ship']), small);
      try {
        await wait();
        tree.write(KEYS.ctrlP);
        await wait();
        // With nothing typed the list is at its longest, which is when the box has to give rows up.
        expect(tree.lastText(), `${small.columns}x${small.rows} lost the query line`).toMatch(/> [█_]/);
        expect(tree.lastText()).toContain('Enter run');
        fits(tree, small);
        for (const ch of 'rep') {
          tree.write(ch);
          await wait(10);
        }
        await wait();
        expect(tree.lastText(), `${small.columns}x${small.rows} lost the query`).toContain('> rep');
        fits(tree, small);
      } finally {
        tree.unmount();
      }
    }
  });

  it('closes the palette with Esc and leaves the workspace where it was', async () => {
    const tree = mount(runWith(['a', 'b']), size);
    try {
      await wait();
      tree.write(KEYS.ctrlP);
      await wait();
      expect(tree.lastText()).toContain('Enter run');
      tree.write(KEYS.escape);
      await wait();
      expect(tree.lastText()).not.toContain('Enter run');
      expect(tree.lastText()).toContain('[Overview]');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('narrows the task list with / and puts it back on Esc', async () => {
    const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
    try {
      await wait();
      tree.write('/');
      await wait();
      for (const ch of 'render') {
        tree.write(ch);
        await wait(10);
      }
      await wait();
      const filtered = tree.lastText();
      expect(filtered).toContain('/render');
      expect(filtered).toContain('Tasks 1/1');
      expect(filtered).not.toContain('review  ');
      fits(tree, size);

      tree.write(KEYS.escape);
      await wait();
      expect(tree.lastText()).toContain('Tasks 1/3');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });

  it('answers ? with the keys of the focused panel, and only those', async () => {
    const tree = mount(runWith(['a', 'b']), size);
    try {
      await wait();
      tree.write('?');
      await wait();
      expect(tree.lastText()).toContain('Tasks — the panel with the keys');
      expect(tree.lastText()).toContain('restart a failed, blocked, cancelled or skipped task');
      fits(tree, size);

      tree.write(KEYS.escape);
      await wait();
      tree.write(KEYS.tab);
      await wait();
      tree.write('?');
      await wait();
      expect(tree.lastText()).toContain('Tabs — the panel with the keys');
      expect(tree.lastText()).toContain('open the tab and focus its panel');
      fits(tree, size);
    } finally {
      tree.unmount();
    }
  });
});

describe('modes', () => {
  const size = { columns: 120, rows: 40 };

  it('paints no colour under --theme mono, and every state still reads as a glyph and a word', async () => {
    const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size, {});
    try {
      await wait();
      expect(tree.lastFrame()).not.toBe(tree.lastText());
    } finally {
      tree.unmount();
    }

    const mono = renderTree(
      <DashboardApp
        run={runWith(['implement-parser', 'implement-renderer', 'review']) as never}
        bus={{ onAny: () => () => undefined } as never}
        controller={controllerStub as never}
        shared={shared()}
        finished={false}
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
        theme="mono"
      />,
      size,
    );
    try {
      await wait();
      // `mono` has bold, dim and inverse and no colour at all: that is what makes focus and selection
      // visible on a terminal that cannot paint them (§3.2). Nothing in the frame sets a colour.
      expect(mono.lastFrame()).not.toMatch(SGR_COLOUR);
      expect(mono.lastFrame()).not.toBe(mono.lastText());
      const frame = mono.lastText();
      expect(frame).toContain('Running');
      expect(frame).toContain('Failed');
      expect(frame).toContain('Waiting');
      expect(frame).toContain('[Overview]');
      fits(mono, size);
    } finally {
      mono.unmount();
    }
  });

  it('draws with ASCII glyphs under CAO_ASCII, so a legacy console still lines up', async () => {
    // The suite pins CAO_UNICODE=1 so that expected output does not depend on the runner's terminal; the
    // case that covers the ASCII path has to clear it, because it wins over CAO_ASCII by design.
    const previous = { ascii: process.env.CAO_ASCII, unicode: process.env.CAO_UNICODE };
    process.env.CAO_ASCII = '1';
    delete process.env.CAO_UNICODE;
    const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
    try {
      await wait();
      const frame = tree.lastText();
      // Every mark the shell draws has an ASCII form: the state glyphs, the cursor, the progress bar and
      // the header's own counters, which used to be spelled out in Unicode at the call site.
      // Not the ellipsis: Ink's own `wrap="truncate-end"` marks a cut line with one, and that is Ink's
      // string rather than a glyph any surface here chooses.
      for (const unicode of ['✓', '✗', '▶', '█', '░', '│']) expect(frame, `${unicode} is still drawn`).not.toContain(unicode);
      // The state marks, the spinner and the cursor all come out of the ASCII table.
      expect(frame).toContain('x implement-renderer');
      expect(frame).toContain('o review');
      expect(frame).toMatch(new RegExp('[|/\\-] implement-parser'));
      fits(tree, size);

      // And so does everything the key hints, the header and the detail spell out: the arrows a key is
      // named after, the separators, the attempt notes and the file counter were literals at the call
      // site, so `CAO_ASCII=1` left a legacy console with mojibake in exactly the panel that explains it.
      tree.write('?');
      await wait();
      const help = tree.lastText();
      for (const unicode of ['↑', '↓', '←', '→', '↳', '·', '±', '—', '’']) {
        expect(frame + help, `${unicode} is still drawn`).not.toContain(unicode);
      }
      expect(help).toContain('^v');
      expect(help).toContain('the panel with the keys');
    } finally {
      tree.unmount();
      if (previous.ascii === undefined) delete process.env.CAO_ASCII;
      else process.env.CAO_ASCII = previous.ascii;
      if (previous.unicode === undefined) delete process.env.CAO_UNICODE;
      else process.env.CAO_UNICODE = previous.unicode;
    }
  });

  it('stops the spinner under CAO_REDUCED_MOTION and shows the running state as its own glyph', async () => {
    const previous = process.env.CAO_REDUCED_MOTION;
    process.env.CAO_REDUCED_MOTION = '1';
    const tree = mount(runWith(['implement-parser', 'implement-renderer', 'review']), size);
    try {
      await wait(200);
      const frames = tree.frames.slice(-4).map(stripAnsi);
      // Whatever else changes on a tick, the glyph does not.
      for (const frame of frames) expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(tree.lastText()).toContain('▶ implement-parser');
      fits(tree, size);
    } finally {
      tree.unmount();
      if (previous === undefined) delete process.env.CAO_REDUCED_MOTION;
      else process.env.CAO_REDUCED_MOTION = previous;
    }
  });
});

describe('a run with two hundred tasks', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `fan-out-${String(i + 1).padStart(3, '0')}`);

  for (const size of SIZES) {
    it(`keeps the sidebar and the table inside the window at ${size.name}`, async () => {
      const tree = mount(runWith(ids), size);
      try {
        await wait();
        fits(tree, size);
        expect(tree.lastText()).toContain('200 tasks, showing');

        // Walk to the end of the list: the window follows the cursor and never grows.
        for (let i = 0; i < 40; i += 1) tree.write(KEYS.pageDown);
        await wait(80);
        fits(tree, size);
        expect(tree.lastText()).toContain('fan-out-200');
        tree.write(KEYS.home);
        await wait();
        fits(tree, size);
        expect(tree.lastText()).toContain('fan-out-001');
      } finally {
        tree.unmount();
      }
    });
  }
});

describe('the panels on their own', () => {
  // Rendered outside the shell, where nothing clips them: the shell's root Box hides its overflow, which is
  // the belt to this braces and would hide a panel that handed Ink two hundred children to lay out [D9].
  const theme = resolveTheme({ theme: 'mono', env: {} });
  const many = Array.from({ length: 200 }, (_, i) => `fan-out-${String(i + 1).padStart(3, '0')}`);
  const run = runWith(many) as never;

  /**
   * §3.2's focus mark costs the same columns whether or not the region has it, so that nothing on the row
   * moves as focus travels. The tab bar had two marks and only the first obeyed that: the glyph in front of
   * the open tab appeared when the *panel* took the keys, which slid every tab to its right one column
   * sideways on a Tab press - on the one row whose whole job is to say where you are.
   */
  it('keeps every tab in the same column whether the bar, the panel or neither has the keys', () => {
    const row = (focused: boolean, mainFocused: boolean): string =>
      stripAnsi(renderInk(<TabBar tab="session" focused={focused} mainFocused={mainFocused} theme={theme} columns={120} />).lastFrame() ?? '');
    const onBar = row(true, false);
    const onPanel = row(false, true);
    const neither = row(false, false);
    for (const label of WORKSPACE_TABS.map((name) => TAB_LABEL[name])) {
      expect(onPanel.indexOf(label), `${label} moved when focus entered the panel`).toBe(onBar.indexOf(label));
      expect(neither.indexOf(label), `${label} moved when focus left the bar`).toBe(onBar.indexOf(label));
    }
    // The mark is still drawn where it means something: on the open tab, when the panel below has the keys.
    expect(onPanel).toContain(`${glyph('focus')}[${TAB_LABEL.session}]`);
    expect(onBar).not.toContain(`${glyph('focus')}[${TAB_LABEL.session}]`);
  });

  it('draws no more rows than the sidebar was given, whatever the run did', () => {
    for (const rows of [4, 10, 25]) {
      for (const cursor of [0, 99, 199]) {
        const { lastFrame } = renderInk(<Sidebar tasks={(run as { workflow: { tasks: never[] } }).workflow.tasks} run={run} cursor={cursor} width={30} rows={rows} theme={theme} focused runningGlyph=">" />);
        const drawn = (lastFrame() ?? '').split(NL).length;
        expect(drawn, `${rows} rows, cursor ${cursor}`).toBeLessThanOrEqual(rows);
        expect(lastFrame()).toContain('more');
      }
    }
  });

  it('keeps the attention badge off the agent column, and charges nothing for it when no row has one', () => {
    // The agent cell is padded to its full width, so the `!` of a failed task ran straight into it and the
    // sidebar read `claude|sonnet!`. The space in front of it is only reserved when a row is using it.
    // A model that fills the agent cell exactly: `claude|sonnet` is the 13 columns the column is padded to.
    const withModel = (ids: string[]) => {
      const r = runWith(ids) as { workflow: { tasks: { model?: string }[] } };
      for (const t of r.workflow.tasks) t.model = 'sonnet';
      return r as never;
    };
    const quiet = withModel(['implement-parser', 'implement-renderer']);
    (quiet as unknown as { tasks: Record<string, { state: string }> }).tasks['implement-renderer']!.state = 'running';
    const loudRun = withModel(['implement-parser', 'implement-renderer']);
    const calm = renderInk(<Sidebar tasks={(quiet as { workflow: { tasks: never[] } }).workflow.tasks} run={quiet} cursor={0} width={40} rows={6} theme={theme} focused runningGlyph=">" />).lastFrame() ?? '';
    const loud = renderInk(<Sidebar tasks={(loudRun as { workflow: { tasks: never[] } }).workflow.tasks} run={loudRun} cursor={1} width={40} rows={6} theme={theme} focused runningGlyph=">" />).lastFrame() ?? '';
    // `runWith` makes the second task the failed one, so its row is the one with a badge.
    // Stripped: under `mono` the agent cell is dim and the badge is bold, so the two are no longer
    // adjacent characters in the raw frame even when they are adjacent columns on screen.
    expect(stripAnsi(loud)).toContain('claude|sonnet !');
    expect(stripAnsi(loud)).not.toContain('claude|sonnet!');
    // With nothing to badge, the task names get the column back.
    expect(stripAnsi(calm)).not.toContain('claude|sonnet !');
    expect(stripAnsi(calm)).toContain('implement-renderer');
  });

  it('keeps the footer inside the terminal once the focus mark is on it', () => {
    // The mark is part of the line, so the cells have to be fitted into what is left after it. Fitted into
    // the whole width instead, the footer came out exactly two columns too long on every frame and Ink cut
    // the last chip mid-word - which is the failure `fitCells` exists to prevent.
    const hints = footerHints('main', 'overview');
    for (const columns of [50, 80, 120, 200]) {
      for (const focused of [false, true]) {
        const frame = stripAnsi(
          renderInk(
            <Footer
              hints={hints}
              always={alwaysHintCells('executing')}
              columns={columns}
              theme={theme}
              columnsShown={footerColumnsFor(columns)}
              snapshotAge={0}
              focused={focused}
            />,
          ).lastFrame() ?? '',
        );
        for (const line of frame.split(NL)) expect([...line].length, `${columns} focused=${focused}: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('pulses the gutter of a task that just produced output, and only on the frame that is on', () => {
    // §3.2: two frames, on the sidebar row of a task that has said something in the last second. The
    // cursor wins the gutter when the row is selected - two columns, one meaning at a time - and under
    // reduced motion `pulsing` is never handed over at all, so nothing in the gutter ever changes.
    const ids = ['implement-parser', 'implement-renderer'];
    const r = runWith(ids) as never;
    const sidebar = (over: { pulsing?: ReadonlySet<string>; pulseOn?: boolean }) =>
      stripAnsi(
        renderInk(
          <Sidebar
            tasks={(r as { workflow: { tasks: never[] } }).workflow.tasks}
            run={r}
            cursor={0}
            width={40}
            rows={6}
            theme={theme}
            focused
            runningGlyph=">"
            {...over}
          />,
        ).lastFrame() ?? '',
      );

    const pulse = glyph('pulse');
    const quiet = sidebar({});
    const on = sidebar({ pulsing: new Set(['implement-renderer']), pulseOn: true });
    const off = sidebar({ pulsing: new Set(['implement-renderer']), pulseOn: false });
    expect(quiet).not.toContain(`${pulse} implement-renderer`);
    expect(on).toContain(`${pulse} `);
    expect(off).not.toContain(`${pulse} `);
    // The pulse never takes the cursor's place on the selected row, and never changes the row's width.
    const selected = sidebar({ pulsing: new Set(ids), pulseOn: true });
    expect(selected.split(NL)[1]).toContain(`${glyph('cursor')} `);
    for (const frame of [quiet, on, off]) {
      for (const line of frame.split(NL)) expect([...line].length).toBeLessThanOrEqual(40);
    }
  });

  it('draws no more rows than the Overview panel was given', () => {
    for (const rows of [6, 12, 30]) {
      const { lastFrame } = renderInk(
        <Overview run={run} tasks={(run as { workflow: { tasks: never[] } }).workflow.tasks} cursor={120} now={Date.now()} columns={100} rows={rows} theme={theme} focused runningGlyph=">" peek={() => []} />,
      );
      expect((lastFrame() ?? '').split(NL).length, `${rows} rows`).toBeLessThanOrEqual(rows);
    }
  });
});

describe('a live run against the fakes', () => {
  const WORKFLOW = `
name: live
execution:
  maxConcurrency: 2
tasks:
  - id: implement
    parallelGroup: g
    prompt: p
  - id: review
    parallelGroup: g
    prompt: p
`;

  it('follows the run and re-lays out on a resize while it is still going', async () => {
    const { workflow, validation } = await buildWorkflow(WORKFLOW, { gitRoot: process.cwd() });
    expect(validation.ok).toBe(true);
    const run = makeRun(workflow);
    const store = new MemoryRunStore();
    const bus = new WorkflowEventBus(run.runId);
    // Named `claude` because that is the agent the workflow asks for; the run is otherwise entirely fake.
    const runner = new MockRunner().when('implement', { kind: 'success', delayMs: 400 }).when('review', { kind: 'success', delayMs: 700 });
    const scheduler = new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace: new MockWorkspace(workflow.repositoryRoot), bus });
    const controller = createRunController({ scheduler });
    const attached = attachStore(bus, controller);

    const execution = scheduler.execute();
    const big = { columns: 120, rows: 40 };
    const small = { columns: 80, rows: 24 };
    const tree = renderTree(
      <DashboardApp run={run as never} bus={bus} controller={controller} shared={shared()} finished={false} onMinimise={() => undefined} onInterrupt={() => undefined} store={attached.store} />,
      big,
    );
    try {
      // The store is fed from the bus, so the frame follows the run without the tree knowing about it.
      await waitForFrame(tree, (f) => f.includes('Running'));
      fits(tree, big);

      await React.act(async () => {
        await tree.resize(small.columns, small.rows);
      });
      // The resize itself re-lays the frame out, not the next spinner tick (§2.5).
      fits(tree, small);
      expect(tree.lastText()).toContain('Task 1/2'); // the sidebar has collapsed into the strip

      await execution;
      await waitForFrame(tree, (f) => f.includes('Completed'));
      fits(tree, small);

      await React.act(async () => {
        await tree.resize(big.columns, big.rows);
      });
      fits(tree, big);
      expect(tree.lastText()).toContain('Tasks 1/2');
    } finally {
      tree.unmount();
      attached.detach();
      await execution.catch(() => undefined);
    }
  }, 20_000);
});
