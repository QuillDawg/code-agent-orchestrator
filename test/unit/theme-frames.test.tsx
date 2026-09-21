/**
 * The workspace as it is actually drawn, in every mode §3.2 names (spec §5 row 13, [D35]).
 *
 * Five panels, two terminal sizes, three modes: `cyberpunk`, `mono` and `CAO_ASCII=1`. The snapshots are of
 * the **stripped** frame, because what a snapshot is for here is the layout and the words - a palette that
 * is retuned should not turn five hundred lines of snapshot red - and the colour is asserted as the
 * property it has to have instead: `cyberpunk` sets colours, `mono` sets none, `CAO_ASCII` writes nothing
 * the ASCII table cannot spell.
 *
 * The run is an ended one with fixed timestamps so that every frame is a function of the fixture and not of
 * the second the suite happened to run in; what is left of the clock is scrubbed by `stable()`.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { WORKSPACE_TABS, type WorkspaceTab } from '../../src/tui/store.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ESC = String.fromCharCode(27);
/** The filled cell of the header's progress bar, which a screen reader is not read. */
const GLYPH_BAR = String.fromCharCode(0x2588);
/** Any SGR that sets a colour: the sixteen, the 256-colour cube and truecolor, foreground or background. */
const SGR_COLOUR = new RegExp(`${ESC}\\[[0-9;]*?(3[0-7]|4[0-7]|9[0-7]|10[0-7]|[34]8;[25];)`);

const wait = async (ms = 40): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const started = '2026-09-17T09:12:34.000Z';
const ended = '2026-09-17T09:41:02.000Z';

const attempt = (over: Record<string, unknown> = {}) => ({
  number: 1,
  kind: 'task',
  triggeredBy: 'initial',
  startedAt: started,
  endedAt: ended,
  cwd: '.',
  files: {},
  usage: { costUsd: 0.42, inputTokens: 12_000, outputTokens: 3400, contextTokens: 42_000, contextWindow: 200_000, model: 'opus-5' },
  ...over,
});

/**
 * An ended run: one task succeeded, one failed, one was never reached.
 *
 * Ended on purpose. A running task's elapsed column counts in real time, and a snapshot of it is a snapshot
 * of when the suite was started; the header's clock stops at `endedAt`, so this frame is the same one every
 * time. The spinner and the pulse are covered by the reduced-motion case below, which is where they matter.
 */
const run = () =>
  ({
    runId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
    workflowName: 'stack-upgrade',
    repositoryRoot: '/repo/code-agent-orchestrator',
    state: 'failed',
    startedAt: started,
    endedAt: ended,
    exitCode: 1,
    workflow: {
      execution: { maxConcurrency: 2 },
      tasks: [
        { id: 'implement-parser', agent: 'claude', model: 'opus-5', dependsOn: [], retry: { attempts: 2 }, codex: {} },
        { id: 'implement-renderer', agent: 'codex', model: 'gpt-5-codex', dependsOn: [], retry: { attempts: 2 }, codex: {} },
        { id: 'review', agent: 'claude', dependsOn: ['implement-parser'], retry: { attempts: 1 }, codex: {} },
      ],
    },
    tasks: {
      'implement-parser': { id: 'implement-parser', state: 'success', retryWindowStart: 1, attempts: [attempt({ outcome: 'success' })] },
      'implement-renderer': {
        id: 'implement-renderer',
        state: 'failed',
        message: 'exit code 1',
        retryWindowStart: 1,
        attempts: [attempt({ outcome: 'failed', error: 'the build failed: cannot find module ./render' })],
      },
      review: { id: 'review', state: 'blocked', message: 'implement-renderer failed', retryWindowStart: 1, attempts: [] },
    },
  }) as never;

const controllerStub = {
  peek: () => [{ kind: 'text', ts: started, text: 'Rewrote the renderer entry point.' }],
  transcript: () => [],
  capturedDiff: async () => null,
  steerable: () => false,
  attemptTranscript: async () => [],
  readReport: async () => '# Run report\n\nTask **implement-parser** succeeded.\n',
};

const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

function mount(size: { columns: number; rows: number }, theme?: string): RenderedTree {
  return renderTree(
    <DashboardApp
      run={run()}
      bus={{ onAny: () => () => undefined } as never}
      controller={controllerStub as never}
      shared={shared()}
      finished
      theme={theme}
      onMinimise={() => undefined}
      onInterrupt={() => undefined}
    />,
    size,
  );
}

/** Walk to `tab` the way an operator does: Tab onto the tab bar, arrow across, Enter into the panel. */
async function openTab(tree: RenderedTree, tab: WorkspaceTab): Promise<void> {
  tree.write(KEYS.tab);
  await wait();
  for (let i = 0; i < WORKSPACE_TABS.indexOf(tab); i += 1) {
    tree.write(KEYS.right);
    await wait();
  }
  tree.write(KEYS.enter);
  await wait();
}

/**
 * What is left of a frame once the parts that cannot repeat are taken out: the freshness chip, and any
 * clock or duration. Everything else is a function of the fixture.
 */
function stable(text: string): string {
  return text
    .replace(/updated [^\s]+ ago/g, 'updated <age> ago')
    .replace(/\b\d+h \d+m \d+s\b/g, '<elapsed>')
    .replace(/\b\d+m \d+s\b/g, '<elapsed>')
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<clock>')
    .replace(/[ \t]+$/gm, '');
}

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
] as const;
/** Report is left out: it is prose from a file, and §5 row 13 names these five. */
const TABS: WorkspaceTab[] = ['overview', 'session', 'logs', 'changes', 'diagnostics'];

const env = { ascii: process.env.CAO_ASCII, unicode: process.env.CAO_UNICODE, noColor: process.env.NO_COLOR };
afterEach(() => {
  for (const [name, value] of [
    ['CAO_ASCII', env.ascii],
    ['CAO_UNICODE', env.unicode],
    ['NO_COLOR', env.noColor],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the panels in every mode (§3.2)', () => {
  for (const size of SIZES) {
    for (const tab of TABS) {
      it(`draws ${tab} at ${size.columns}x${size.rows} in cyberpunk, mono and ASCII`, async () => {
        const colour = mount(size, 'cyberpunk');
        try {
          await openTab(colour, tab);
          expect(stable(colour.lastText())).toMatchSnapshot(`${tab} ${size.columns}x${size.rows}`);
          expect(colour.lastFrame(), 'cyberpunk painted nothing').toMatch(SGR_COLOUR);
          expect(frameHeight(colour.lastFrame())).toBeLessThanOrEqual(size.rows);
        } finally {
          colour.unmount();
        }

        const mono = mount(size, 'mono');
        try {
          await openTab(mono, tab);
          // The same screen, word for word: mono is not a shorter workspace, it is the same one with the
          // colour taken out - which is only true if every state was already a glyph and a word.
          expect(stable(mono.lastText())).toBe(stable(colour.lastText()));
          expect(mono.lastFrame(), 'mono set a colour').not.toMatch(SGR_COLOUR);
          expect(frameHeight(mono.lastFrame())).toBeLessThanOrEqual(size.rows);
        } finally {
          mono.unmount();
        }

        // `CAO_UNICODE` wins over `CAO_ASCII` by design, so the case that covers ASCII has to clear it.
        delete process.env.CAO_UNICODE;
        process.env.CAO_ASCII = '1';
        const ascii = mount(size, 'cyberpunk');
        try {
          await openTab(ascii, tab);
          const text = ascii.lastText();
          expect(stable(text)).toMatchSnapshot(`${tab} ${size.columns}x${size.rows} ascii`);
          // Every glyph this build chooses has an ASCII form. The one character that may still be outside
          // it is Ink's own truncation mark at the end of a row it had to cut (`wrap="truncate-end"`),
          // which is not ours to choose - so it is allowed there and nowhere else.
          const nonAscii = text
            .split(String.fromCharCode(10))
            .map((row) => row.replace(/\u2026$/, ''))
            .filter((row) => [...row].some((ch) => (ch.codePointAt(0) ?? 0) > 127));
          expect(nonAscii, 'a glyph the ASCII table has no form for').toEqual([]);
          expect(frameHeight(ascii.lastFrame())).toBeLessThanOrEqual(size.rows);
        } finally {
          ascii.unmount();
        }
      });
    }
  }

  it('sets no colour anywhere under NO_COLOR, whatever --theme asked for', async () => {
    process.env.NO_COLOR = '1';
    const tree = mount({ columns: 120, rows: 40 }, 'cyberpunk');
    try {
      await wait();
      for (const tab of TABS) {
        await openTab(tree, tab);
        expect(tree.lastFrame(), `${tab} set a colour under NO_COLOR`).not.toMatch(SGR_COLOUR);
      }
    } finally {
      tree.unmount();
    }
  });
});

describe('a screen reader is attached (§3.2)', () => {
  function mountFor(screenReader: boolean): RenderedTree {
    return renderTree(
      <DashboardApp
        run={run()}
        bus={{ onAny: () => () => undefined } as never}
        controller={controllerStub as never}
        shared={shared()}
        finished
        theme="cyberpunk"
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
      />,
      { columns: 120, rows: 40, screenReader },
    );
  }

  it('collapses the header and the footer to one line each, and announces N of M', async () => {
    const plain = mountFor(false);
    const reader = mountFor(true);
    try {
      await wait();
      await wait();
      const lines = reader.lastText().split(String.fromCharCode(10));
      // One header line, carrying the same facts the two-row header carries.
      expect(lines[0]).toContain('cao stack-upgrade');
      expect(lines[0]).toContain('run 01K5ABCDEFGHJKMNPQRSTVWXYZ');
      expect(lines[0]).toContain('1 of 3 done');
      expect(lines[0]).toContain('owner');
      // The header is that one line: the progress bar and the counters it normally carries on a second
      // row are gone, and the tab bar has moved up into their place.
      expect(lines[1]).toContain('Overview');
      expect(lines[1]).not.toContain(GLYPH_BAR);
      expect(plain.lastText().split(String.fromCharCode(10))[1]).toContain(GLYPH_BAR);
      // The lists say where the cursor is in words rather than as a fraction.
      expect(reader.lastText()).toContain('Tasks 2 of 3');
      expect(reader.lastText()).not.toContain('Tasks 2/3');
      expect(plain.lastText()).toContain('Tasks 2/3');
    } finally {
      plain.unmount();
      reader.unmount();
    }
  });
});

describe('animation (§3.2)', () => {
  const running = () => {
    const base = run() as unknown as { state: string; endedAt?: string; exitCode?: number; tasks: Record<string, { state: string; attempts: unknown[] }> };
    base.state = 'running';
    delete base.endedAt;
    delete base.exitCode;
    base.tasks['implement-parser']!.state = 'running';
    return base as never;
  };

  function mountRunning(theme?: string, screenReader = false): RenderedTree {
    return renderTree(
      <DashboardApp
        run={running()}
        bus={{ onAny: () => () => undefined } as never}
        controller={controllerStub as never}
        shared={shared()}
        finished={false}
        theme={theme}
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
      />,
      { columns: 120, rows: 40, screenReader },
    );
  }

  it('moves nothing at all under CAO_REDUCED_MOTION', async () => {
    const previous = process.env.CAO_REDUCED_MOTION;
    process.env.CAO_REDUCED_MOTION = '1';
    const tree = mountRunning('cyberpunk');
    try {
      await wait(200);
      const frames: string[] = [];
      // Ten consecutive frames, sampled well past the 120 ms the spinner would tick at: byte for byte the
      // same, with the running task marked by its own glyph and its own word.
      for (let i = 0; i < 10; i += 1) {
        await wait(150);
        frames.push(stable(tree.lastText()));
      }
      expect(new Set(frames).size, 'something moved under reduced motion').toBe(1);
      expect(frames[0]).toContain('Running');
    } finally {
      tree.unmount();
      if (previous === undefined) delete process.env.CAO_REDUCED_MOTION;
      else process.env.CAO_REDUCED_MOTION = previous;
    }
  }, 15_000);

  /**
   * Ink's own screen-reader flag, which is the third thing that turns the animation off (§3.2). It is a
   * hook rather than an environment variable, so it cannot be covered by the two cases above: the spinner
   * and the pulse have to be stopped by the component that reads it, and nothing else in this file would
   * notice if that half of the condition were deleted.
   */
  it('moves nothing when Ink reports a screen reader, which no environment variable says', async () => {
    const tree = mountRunning('cyberpunk', true);
    try {
      await wait(200);
      const frames: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await wait(150);
        frames.push(stable(tree.lastText()));
      }
      expect(new Set(frames).size, 'something moved with a screen reader attached').toBe(1);
      // Still says what the task is doing: the spinner is replaced by the static glyph and the word.
      expect(frames[0]).toContain('Running');
    } finally {
      tree.unmount();
    }
  }, 15_000);

  it('moves nothing under TERM=dumb either, which is the terminal that cannot take it', async () => {
    const previous = process.env.TERM;
    process.env.TERM = 'dumb';
    const tree = mountRunning();
    try {
      await wait(200);
      const first = stable(tree.lastText());
      await wait(600);
      expect(stable(tree.lastText())).toBe(first);
      // `TERM=dumb` reports no colour at all, so it gets mono as well as stillness.
      expect(tree.lastFrame()).not.toMatch(SGR_COLOUR);
    } finally {
      tree.unmount();
      if (previous === undefined) delete process.env.TERM;
      else process.env.TERM = previous;
    }
  });
});
