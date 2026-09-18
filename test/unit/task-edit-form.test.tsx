/**
 * The task editor as an operator drives it (spec §3.4, §3.2, `[D15]`): `E` opens it, the rows carry the
 * values the task has now, typing is text and nothing else, Save asks before it stops a running worker, and
 * a successful task is refused with a sentence rather than an empty form.
 *
 * Driven through the in-house harness against a real `ResolvedWorkflow`, because the form validates with the
 * workflow validator: a stub task would let a message through that the real one would not.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { frameHeight, renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import { buildWorkflow, makeRun, tmpDir } from '../helpers/index.js';
import { stripAnsi } from '../../src/cli/color.js';
import { suspendTerminal, markAltScreen, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from '../../src/tui/terminal.js';
import { editPromptExternally } from '../../src/tui/workspace/prompt-editor.js';
import type { ControlAck, WorkflowRun } from 'code-agent-orchestrator-protocol';

const NL = String.fromCharCode(10);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const SIZE = { columns: 120, rows: 40 };

const YAML = `
name: stack-upgrade
tasks:
  - id: implement-api
    prompt: write the parser
    timeout: 90m
    retries: 1
  - id: review
    prompt: review it
    dependsOn: [implement-api]
`;

const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

async function mountWorkspace(over: (run: WorkflowRun) => void = () => undefined): Promise<{
  tree: RenderedTree;
  submits: Array<{ kind: string; taskId?: string; changes?: unknown; restart?: boolean }>;
  run: WorkflowRun;
}> {
  const { workflow } = await buildWorkflow(YAML, { gitRoot: process.cwd() });
  const run = makeRun(workflow);
  run.state = 'running';
  run.startedAt = new Date().toISOString();
  over(run);
  const submits: Array<{ kind: string; taskId?: string; changes?: unknown; restart?: boolean }> = [];
  const controller = {
    peek: () => [],
    transcript: () => [],
    capturedDiff: async () => null,
    steerable: () => false,
    attemptTranscript: async () => [],
    readReport: async () => null,
    submit: async (command: { kind: string }): Promise<ControlAck> => {
      submits.push(command as never);
      return { protocol: 1, id: 'x', status: 'applied', reason: 'Edited "implement-api": prompt.', at: new Date().toISOString() };
    },
  };
  const tree = renderTree(
    <DashboardApp
      run={run as never}
      bus={{ onAny: () => () => undefined } as never}
      controller={controller as never}
      shared={shared()}
      finished={false}
      onMinimise={() => undefined}
      onInterrupt={() => undefined}
    />,
    SIZE,
  );
  await wait();
  return { tree, submits, run };
}

/** Every case ends here (§2.5): a frame taller than its terminal is what tears on Windows. */
function fits(tree: RenderedTree): void {
  expect(frameHeight(tree.lastFrame())).toBeLessThanOrEqual(SIZE.rows);
  for (const line of tree.lastText().split(NL)) expect([...line].length, `wider than its terminal: ${line}`).toBeLessThanOrEqual(SIZE.columns);
}

describe('the Session panel editor (§3.4)', () => {
  it('opens on E with the values the task has now, and the context section beneath the prompt', async () => {
    const { tree, run } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'pending';
      // A context source, so the read-only section below the prompt has something to show [D19].
      const review = r.workflow.tasks.find((t) => t.id === 'review')!;
      review.context = { sources: [{ taskId: 'implement-api', include: ['summary'] }], includeFailed: false, maxChars: 10_000 };
    });
    try {
      tree.write('e');
      await wait();
      const frame = tree.lastText();
      expect(frame).toContain('Edit implement-api');
      expect(frame).toContain('write the parser');
      expect(frame).toContain('90m');
      expect(frame).toContain('Context added at launch (read-only)');
      expect(frame).toContain('Ctrl+O prompt in $EDITOR');
      expect(frame).toContain('Save');
      expect(run.tasks['implement-api']!.revisions).toBeUndefined();
      fits(tree);
    } finally {
      tree.unmount();
    }
  });

  it('treats a printable key as text, sends only the field that changed, and cancels on Esc', async () => {
    const { tree, submits } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'pending';
    });
    try {
      tree.write('e');
      await wait();
      // `q` would quit the workspace outside a field, and `r` would restart the task: inside one they type.
      tree.write('qr!');
      await wait();
      expect(tree.lastText()).toContain('write the parserqr!');
      expect(tree.lastText()).toContain('Edit implement-api');

      // Down to Save and Enter: a pending task is not running, so nothing is asked and the edit goes.
      for (let i = 0; i < 7; i += 1) tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.enter);
      await wait();
      expect(submits).toHaveLength(1);
      expect(submits[0]).toMatchObject({ kind: 'edit', taskId: 'implement-api', restart: false });
      expect(submits[0]!.changes).toEqual({ prompt: 'write the parserqr!' });
      fits(tree);
    } finally {
      tree.unmount();
    }
  });

  it('asks before it stops a running worker, and sends restart only when the answer is yes', async () => {
    const { tree, submits } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'running';
      r.tasks['implement-api']!.attempts = [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: new Date().toISOString(), cwd: '.' }];
    });
    try {
      tree.write('e');
      await wait();
      tree.write('!');
      for (let i = 0; i < 7; i += 1) tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.enter);
      await wait();
      expect(tree.lastText()).toContain('Restart it now with the edit applied?');
      expect(submits).toHaveLength(0);
      fits(tree);

      // N applies the edit without stopping anything; Y is the stop-edit-restart of §3.4.
      tree.write('n');
      await wait();
      expect(submits[0]).toMatchObject({ restart: false });

      tree.write('e');
      await wait();
      tree.write('?');
      for (let i = 0; i < 7; i += 1) tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.enter);
      await wait();
      tree.write('y');
      await wait();
      expect(submits[1]).toMatchObject({ kind: 'edit', restart: true });
    } finally {
      tree.unmount();
    }
  });

  it('refuses a successful task with a sentence instead of an empty form [D27]', async () => {
    const { tree, submits } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'success';
    });
    try {
      tree.write('e');
      await wait();
      expect(tree.lastText()).not.toContain('Edit implement-api');
      expect(tree.lastText()).toContain('immutable');
      expect(submits).toHaveLength(0);
      fits(tree);
    } finally {
      tree.unmount();
    }
  });

  it('shows the validator message on the row that caused it and will not save through it', async () => {
    const { tree, submits } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'pending';
    });
    try {
      tree.write('e');
      await wait();
      // Down to Timeout, clear it and type something that is not a duration.
      for (let i = 0; i < 4; i += 1) tree.write(KEYS.down);
      await wait();
      for (let i = 0; i < 4; i += 1) tree.write(KEYS.backspace);
      tree.write('soon');
      await wait();
      expect(tree.lastText()).toContain('Invalid duration');
      for (let i = 0; i < 3; i += 1) tree.write(KEYS.down);
      await wait();
      tree.write(KEYS.enter);
      await wait();
      expect(submits).toHaveLength(0);
      fits(tree);
    } finally {
      tree.unmount();
    }
  });
});

describe('handing the terminal to $EDITOR (§3.4)', () => {
  it('leaves the alternate screen and raw mode, and puts both back afterwards', async () => {
    const writes: string[] = [];
    const raw: boolean[] = [];
    const streams = {
      stdout: { write: (chunk: string) => writes.push(chunk) },
      stdin: { isTTY: true, setRawMode: (mode: boolean) => raw.push(mode) },
    };
    markAltScreen(true);
    try {
      const result = await suspendTerminal(() => {
        // The editor owns the terminal at this point: raw mode off, primary buffer back, cursor visible.
        expect(raw).toEqual([false]);
        expect(writes.join('')).toContain(LEAVE_ALT_SCREEN);
        return 0;
      }, streams as never);
      expect(result).toBe(0);
      expect(writes.join('')).toContain(ENTER_ALT_SCREEN);
      expect(raw).toEqual([false, true]);
    } finally {
      markAltScreen(false);
    }
  });

  it('puts the terminal back even when the editor throws', async () => {
    const writes: string[] = [];
    const raw: boolean[] = [];
    const streams = { stdout: { write: (c: string) => writes.push(c) }, stdin: { isTTY: true, setRawMode: (m: boolean) => raw.push(m) } };
    markAltScreen(true);
    await expect(
      suspendTerminal(() => {
        throw new Error('vim exploded');
      }, streams as never),
    ).rejects.toThrow('vim exploded');
    expect(writes.join('')).toContain(ENTER_ALT_SCREEN);
    expect(raw).toEqual([false, true]);
    markAltScreen(false);
  });

  it('round-trips the prompt through the editor and cleans up after itself', async () => {
    const directory = await tmpDir('cao-prompt-editor-');
    const seen: string[] = [];
    const result = await editPromptExternally('the old prompt', {
      env: { EDITOR: 'vim' },
      directory,
      suspend: async (action) => action(),
      run: async (file, args) => {
        expect(file).toBe('vim');
        const scratch = args[args.length - 1]!;
        seen.push(await fs.readFile(scratch, 'utf8'));
        await fs.writeFile(scratch, 'the new prompt', 'utf8');
        return 0;
      },
    });
    expect(seen).toEqual(['the old prompt']);
    expect(result.text).toBe('the new prompt');
    expect(result.notice).toContain('vim');
    // The scratch file is not left behind in the operator's temp directory.
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('keeps the draft when the editor fails, is empty, or is not configured at all', async () => {
    const directory = await tmpDir('cao-prompt-editor-fail-');
    const suspend = async <T,>(action: () => Promise<T> | T): Promise<T> => action();

    const none = await editPromptExternally('x', { env: {}, directory, suspend });
    expect(none.text).toBeUndefined();
    expect(none.notice).toContain('Set $VISUAL or $EDITOR');

    const failed = await editPromptExternally('x', { env: { EDITOR: 'vim' }, directory, suspend, run: async () => 1 });
    expect(failed.text).toBeUndefined();
    expect(failed.notice).toContain('exited 1');

    const emptied = await editPromptExternally('x', {
      env: { EDITOR: 'vim' },
      directory,
      suspend,
      run: async (_file, args) => {
        await fs.writeFile(args[args.length - 1]!, '   ', 'utf8');
        return 0;
      },
    });
    expect(emptied.text).toBeUndefined();
    expect(emptied.notice).toContain('empty prompt');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('is what Ctrl+O on the prompt row reaches for', async () => {
    const { tree } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'pending';
    });
    // No $EDITOR in the test environment, so the notice is the one that names the variable - which is also
    // the proof that the chord reached the editor path rather than being swallowed as text.
    const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    try {
      tree.write('e');
      await wait();
      tree.write(KEYS.ctrlO);
      await wait(60);
      expect(tree.lastText()).toContain('Set $VISUAL or $EDITOR');
      // The chord is not text: the prompt row is untouched.
      expect(tree.lastText()).toContain('write the parser');
      fits(tree);
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      tree.unmount();
    }
  });
});

describe('the palette and the help agree with the keys (§3.2)', () => {
  it('offers the editor as an action and names its chord', async () => {
    const { tree } = await mountWorkspace((r) => {
      r.tasks['implement-api']!.state = 'pending';
    });
    try {
      tree.write(KEYS.ctrlP);
      await wait();
      tree.write('edit');
      await wait();
      expect(stripAnsi(tree.lastFrame())).toContain('Edit the selected task');
      tree.write(KEYS.enter);
      await wait();
      expect(tree.lastText()).toContain('Edit implement-api');
      fits(tree);
    } finally {
      tree.unmount();
    }
  });
});

// The suspend/editor cases above spawn nothing; this guards that, since a stray `execa` here would run a
// real editor on a developer's machine and hang the suite.
describe('no test here starts an editor', () => {
  it('never reaches the default runner', async () => {
    const spy = vi.fn();
    const directory = await tmpDir('cao-prompt-editor-guard-');
    await editPromptExternally('x', { env: { EDITOR: path.join(directory, 'nope') }, directory, suspend: async (a) => a(), run: async () => (spy(), 0) });
    expect(spy).toHaveBeenCalledOnce();
  });
});
