/**
 * The composer as an operator drives it in the workspace (spec §3.5, §3.2, `[D14]`-`[D16]`, `[D27]`).
 *
 * Driven through the in-house harness, because the point is the keys: Enter opens it and Enter sends it,
 * Ctrl+J is a newline, a printable key is text whatever it means outside, and a succeeded task refuses with
 * a sentence rather than an empty field.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { renderTree, KEYS, type RenderedTree } from '../helpers/ink-harness.js';
import { buildWorkflow, makeRun } from '../helpers/index.js';
import { stripAnsi } from '../../src/cli/color.js';
import type { ControlAck, TranscriptEntry, WorkflowRun } from 'code-agent-orchestrator-protocol';
import type { ControlCommand } from '../../src/workflow/control/commands.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const SIZE = { columns: 120, rows: 40 };
const NL = String.fromCharCode(10);

const YAML = `
name: stack-upgrade
tasks:
  - id: implement-api
    prompt: write the parser
  - id: review
    prompt: review it
    dependsOn: [implement-api]
`;

const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

interface Mounted {
  tree: RenderedTree;
  submits: ControlCommand[];
  run: WorkflowRun;
  frame: () => string;
}

async function mountWorkspace(over: (run: WorkflowRun) => void, opts: { steerable?: boolean; ack?: Partial<ControlAck>; transcript?: TranscriptEntry[] } = {}): Promise<Mounted> {
  const { workflow } = await buildWorkflow(YAML, { gitRoot: process.cwd() });
  const run = makeRun(workflow);
  run.state = 'running';
  run.startedAt = new Date().toISOString();
  over(run);
  const submits: ControlCommand[] = [];
  const controller = {
    peek: () => opts.transcript ?? [],
    transcript: () => opts.transcript ?? [],
    capturedDiff: async () => null,
    steerable: () => opts.steerable === true,
    attemptTranscript: async () => [],
    readReport: async () => null,
    ended: false,
    submit: async (command: ControlCommand): Promise<ControlAck> => {
      submits.push(command);
      return { protocol: 1, id: 'x', status: 'applied', reason: 'The message is queued for "implement-api".', at: new Date().toISOString(), ...opts.ack } as ControlAck;
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
  return { tree, submits, run, frame: () => stripAnsi(tree.lastText()) };
}

/** Open the Session tab on the selected task and focus its panel. */
async function openSession(tree: RenderedTree): Promise<void> {
  tree.write(KEYS.tab); // the tab bar
  await wait();
  tree.write(KEYS.right); // Session
  await wait();
  tree.write(KEYS.enter); // focus the panel
  await wait();
}

const running = (run: WorkflowRun): void => {
  const st = run.tasks['implement-api']!;
  st.state = 'running';
  st.attempts = [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: new Date().toISOString(), cwd: '.', sessionId: 'sess-8f2a' }];
  st.currentAttempt = 1;
};

describe('the composer in the Session panel (§3.5)', () => {
  it('says which mode a message will use, and sends it on Enter', async () => {
    const m = await mountWorkspace(running, { steerable: true });
    try {
      await openSession(m.tree);
      expect(m.frame()).toContain('steer');
      expect(m.frame()).toContain('queued until the turn ends');

      m.tree.write(KEYS.enter); // open the composer
      await wait();
      expect(m.frame()).toContain('Enter send');

      m.tree.write('also update the changelog');
      await wait();
      expect(m.frame()).toContain('also update the changelog');

      m.tree.write(KEYS.enter);
      await wait();
      expect(m.submits).toEqual([{ kind: 'prompt', taskId: 'implement-api', text: 'also update the changelog', mode: 'steer' }]);
      // The ack is the answer, shown where the operator is looking.
      expect(m.frame()).toContain('queued for "implement-api"');
    } finally {
      m.tree.unmount();
    }
  });

  it('says stop and continue when the running worker has no channel', async () => {
    const m = await mountWorkspace(running, { steerable: false });
    try {
      await openSession(m.tree);
      expect(m.frame()).toContain('stop and continue');
      m.tree.write(KEYS.enter);
      await wait();
      m.tree.write('use the cache');
      await wait();
      m.tree.write(KEYS.enter);
      await wait();
      expect(m.submits[0]).toMatchObject({ mode: 'stopAndContinue' });
    } finally {
      m.tree.unmount();
    }
  });

  it('names the session a follow-up would resume', async () => {
    const m = await mountWorkspace((run) => {
      running(run);
      run.tasks['implement-api']!.state = 'failed';
      run.tasks['implement-api']!.attempts[0]!.outcome = 'crash';
      run.tasks['implement-api']!.attempts[0]!.endedAt = new Date().toISOString();
    });
    try {
      await openSession(m.tree);
      expect(m.frame()).toContain('follow-up');
      expect(m.frame()).toContain('resumes session sess-8f2a');
    } finally {
      m.tree.unmount();
    }
  });

  it('offers Ctrl+F as the fresh-session option, and sends it with the message (`[D25]`)', async () => {
    const failed = (run: WorkflowRun): void => {
      running(run);
      run.tasks['implement-api']!.state = 'failed';
      run.tasks['implement-api']!.attempts[0]!.outcome = 'crash';
      run.tasks['implement-api']!.attempts[0]!.endedAt = new Date().toISOString();
    };
    const m = await mountWorkspace(failed);
    try {
      await openSession(m.tree);
      m.tree.write(KEYS.enter);
      await wait();
      // Off by default: the follow-up continues the session the task reported, which is what the header says.
      expect(m.frame()).toContain('resumes session sess-8f2a');
      expect(m.frame()).toContain('Start a fresh session: off');

      m.tree.write(KEYS.ctrlF);
      await wait();
      expect(m.frame()).toContain('Start a fresh session: on');
      expect(m.frame()).toContain('starts a fresh session with your message in the prompt');
      expect(m.frame()).not.toContain('resumes session sess-8f2a');

      m.tree.write('from the top please');
      await wait();
      m.tree.write(KEYS.enter);
      await wait();
      expect(m.submits).toEqual([
        { kind: 'prompt', taskId: 'implement-api', text: 'from the top please', mode: 'followUp', freshSession: true },
      ]);
    } finally {
      m.tree.unmount();
    }
  });

  it('leaves the fresh-session option off unless it is asked for, and off again after a second Ctrl+F', async () => {
    const m = await mountWorkspace((run) => {
      running(run);
      run.tasks['implement-api']!.state = 'failed';
      run.tasks['implement-api']!.attempts[0]!.outcome = 'crash';
      run.tasks['implement-api']!.attempts[0]!.endedAt = new Date().toISOString();
    });
    try {
      await openSession(m.tree);
      m.tree.write(KEYS.enter);
      await wait();
      m.tree.write(KEYS.ctrlF);
      await wait();
      m.tree.write(KEYS.ctrlF);
      await wait();
      expect(m.frame()).toContain('Start a fresh session: off');
      m.tree.write('carry on');
      await wait();
      m.tree.write(KEYS.enter);
      await wait();
      expect(m.submits[0]).not.toHaveProperty('freshSession');
    } finally {
      m.tree.unmount();
    }
  });

  it('takes Ctrl+J and a trailing backslash as newlines, and every other key as text', async () => {
    const m = await mountWorkspace(running, { steerable: true });
    try {
      await openSession(m.tree);
      m.tree.write(KEYS.enter);
      await wait();
      // `q` would quit outside the composer and `/` would search; inside, both are text `[D15]`.
      m.tree.write('q/first');
      await wait();
      m.tree.write(KEYS.ctrlJ);
      await wait();
      m.tree.write('second\\');
      await wait();
      m.tree.write(KEYS.enter); // the backslash becomes the newline rather than sending
      await wait();
      expect(m.submits).toHaveLength(0);
      m.tree.write('third');
      await wait();
      m.tree.write(KEYS.enter);
      await wait();
      expect((m.submits[0] as { text: string }).text).toBe(['q/first', 'second', 'third'].join(NL));
    } finally {
      m.tree.unmount();
    }
  });

  it('keeps the draft when Esc closes it, and hands it back when it opens again', async () => {
    const m = await mountWorkspace(running, { steerable: true });
    try {
      await openSession(m.tree);
      m.tree.write(KEYS.enter);
      await wait();
      m.tree.write('half a thought');
      await wait();
      m.tree.write(KEYS.escape);
      await wait();
      expect(m.frame()).toContain('Enter opens the composer');

      m.tree.write(KEYS.enter);
      await wait();
      expect(m.frame()).toContain('half a thought');
    } finally {
      m.tree.unmount();
    }
  });

  /**
   * How much of the panel a long message may have (§3.2).
   *
   * A third of it used to be the composer's ceiling as well as its floor, so a task whose transcript was
   * still empty showed seven lines of a thirty-line message above a dozen blank rows.
   */
  it('grows into the rows the transcript is not using, and gives them back when there is output', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const type = async (tree: RenderedTree): Promise<void> => {
      tree.write(KEYS.enter);
      await wait();
      for (const line of lines) {
        tree.write(line);
        await wait(2);
        tree.write(KEYS.ctrlJ);
        await wait(2);
      }
      await wait();
    };

    const empty = await mountWorkspace(running, { steerable: true });
    try {
      await openSession(empty.tree);
      await type(empty.tree);
      // Far more than the third of the panel the old ceiling allowed, and the blank rows are gone.
      expect(empty.frame()).toContain('line 10');
      expect(empty.frame()).toContain('line 29');
    } finally {
      empty.tree.unmount();
    }

    const busy = await mountWorkspace(running, {
      steerable: true,
      transcript: Array.from({ length: 40 }, (_, i) => ({ kind: 'text', ts: new Date().toISOString(), text: `output ${i}` }) as TranscriptEntry),
    });
    try {
      await openSession(busy.tree);
      await type(busy.tree);
      const frame = busy.frame();
      // The transcript is what a Session panel is mostly for: with output to read the composer is back to
      // its share, and the newest lines of the transcript are on screen.
      expect(frame).toContain('output 39');
      expect(frame).not.toContain('line 10');
      expect(frame).toContain('line 29');
    } finally {
      busy.tree.unmount();
    }
  });

  it('refuses to open on a succeeded task, with the sentence `[D27]` asks for', async () => {
    const m = await mountWorkspace((run) => {
      run.tasks['implement-api']!.state = 'success';
    });
    try {
      await openSession(m.tree);
      expect(m.frame()).toContain('immutable');
      m.tree.write(KEYS.enter);
      await wait();
      expect(m.frame()).toContain('immutable');
      expect(m.submits).toHaveLength(0);
    } finally {
      m.tree.unmount();
    }
  });

  it('shows what has already been sent, with its state and the first line of the text', async () => {
    const m = await mountWorkspace((run) => {
      running(run);
      run.tasks['implement-api']!.attempts[0]!.prompts = [
        { id: 'p1', at: new Date().toISOString(), source: 'tui', mode: 'steer', transport: 'claude-stream', state: 'accepted', text: `mind the lockfile${NL}and the changelog` },
      ];
    }, { steerable: true });
    try {
      await openSession(m.tree);
      const frame = m.frame();
      expect(frame).toContain('Sent to this task');
      expect(frame).toContain('mind the lockfile');
      expect(frame).toContain('accepted');
      // The identity line says who is on the other end (§3.5).
      expect(frame).toContain('sess-8f2a');
      expect(frame).toContain('attempt 1');
    } finally {
      m.tree.unmount();
    }
  });

  it('keeps the message on the row of a delivery that has a reason as well', async () => {
    // A queued or rejected delivery is exactly where an operator needs to know *which* of the messages they
    // sent is the one being talked about, and the reason used to take the row for itself.
    const m = await mountWorkspace((run) => {
      running(run);
      run.tasks['implement-api']!.attempts[0]!.prompts = [
        {
          id: 'p1', at: new Date().toISOString(), source: 'tui', mode: 'steer', transport: 'codex-app-server',
          state: 'rejected', text: 'mind the lockfile', reason: 'no active turn to steer',
        },
      ];
    }, { steerable: true });
    try {
      await openSession(m.tree);
      const frame = m.frame();
      expect(frame).toContain('mind the lockfile');
      expect(frame).toContain('no active turn to steer');
      expect(frame).toContain('rejected');
    } finally {
      m.tree.unmount();
    }
  });
});
