/**
 * The review view against a real run: a workflow executed by the fake Claude CLI, then the dashboard driven
 * with the keys a user presses. Everything the view shows travels the whole path — the workspace manager
 * captures the diff, the store writes `diff.json` and `diff.patch`, the scheduler reads them back — so this
 * is where a wiring mistake between those and the two-level view shows up.
 */
import React from 'react';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { render } from 'ink-testing-library';
import { prepareWorkflow, createRuntime, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { silentLogger } from '../../src/logging/logger.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { stripAnsi } from '../../src/cli/color.js';
import { tmpGitRepo, gitOut, FAKE_CLAUDE } from '../helpers/index.js';

const ENTER = String.fromCharCode(13);
const ESCAPE = String.fromCharCode(27);
const NL = String.fromCharCode(10);
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

/** True when one line of the frame carries all of these; the columns are padded, so exact spacing is not asserted. */
function hasRow(frame: string, ...parts: string[]): boolean {
  return frame.split(NL).some((line) => parts.every((p) => line.includes(p)));
}

describe('the review view over a real run', () => {
  beforeAll(() => clearDetectionCache());

  it('shows what each task actually changed, and opens the hunks git captured', async () => {
    const repo = await tmpGitRepo('cao-review-');
    await fs.writeFile(path.join(repo, 'moved.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(repo, 'deleted-recreated.txt'), 'before\n');
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await gitOut(repo, 'add', '-A');
    await gitOut(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixtures');

    const yaml = 'name: review-view\ntasks:\n  - id: edge-task\n    prompt: p\n  - id: quiet-task\n    prompt: p\n';
    const configPath = path.join(repo, 'workflow.yaml');
    await fs.writeFile(configPath, yaml);
    const prepared = await prepareWorkflow(configPath, { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw });
    const runtime = createRuntime({
      run,
      environment: { FAKE_CLAUDE_TASK_MODES: JSON.stringify({ 'edge-task': 'edge', 'quiet-task': 'noop' }) },
      secrets: [],
      logger: silentLogger,
    });
    expect((await runtime.scheduler.execute()).state).toBe('completed');

    const { lastFrame, stdin, unmount } = render(
      <DashboardApp run={run} bus={runtime.bus} scheduler={runtime.scheduler} shared={shared()} finished={false} onMinimise={() => undefined} onInterrupt={() => undefined} />,
    );
    try {
      await wait();
      stdin.write('c');
      await wait();
      let frame = stripAnsi(lastFrame() ?? '');

      // Every shape the capture has to survive, read back through the store: a rename into a directory whose
      // name has a space, a binary file, a delete-and-recreate, and a new file with CRLF endings.
      expect(hasRow(frame, 'edge-task', 'attempt 1', '4 files changed')).toBe(true);
      expect(hasRow(frame, 'A crlf.txt', '+2 -0')).toBe(true);
      expect(hasRow(frame, 'M blob.bin', 'binary')).toBe(true);
      expect(hasRow(frame, 'R', 'moved.txt', 'renamed file.txt')).toBe(true);
      // The task that changed nothing is still listed, and says so rather than vanishing.
      expect(hasRow(frame, 'quiet-task', 'changed no files')).toBe(true);

      // The hunks of the first file, straight from the captured patch; the CRLF is not drawn as a control code.
      stdin.write(ENTER);
      await wait();
      frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('blob.bin');
      expect(frame).toContain('binary contents omitted');

      // → walks to the next file without leaving the pane; crlf.txt is next in path order.
      stdin.write(`${ESCAPE}[C`);
      await wait();
      frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('crlf.txt');
      expect(frame).toContain('hunk 1/1');
      expect(frame).toContain('+one');
      expect(frame).toContain('+two');
      expect(frame).not.toContain(String.fromCharCode(13));
    } finally {
      unmount();
    }
  }, 60_000);
});
