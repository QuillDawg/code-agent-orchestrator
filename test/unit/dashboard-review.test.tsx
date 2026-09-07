/**
 * The dashboard's review view under the conditions a real run puts it in: a narrow terminal, a patch of
 * hundreds of hunks, a task that changed nothing, and a worker that wrote escape sequences into a file.
 *
 * `patchForFile` is spied on rather than replaced: the pane is only allowed to rebuild when the selection or
 * the patch behind it changes, and the dashboard hands this component a fresh task array eight times a second.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ReviewView, type LoadedDiff, type ReviewTaskInput } from '../../src/tui/dashboard/review.js';
import { buildPane, expandTabs } from '../../src/tui/dashboard/pane.js';
import { shortenLabel } from '../../src/tui/dashboard/files.js';
import { patchForFile } from '../../src/cli/render/diff.js';
import { stripAnsi } from '../../src/cli/color.js';

vi.mock('../../src/cli/render/diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/render/diff.js')>();
  return { ...actual, patchForFile: vi.fn(actual.patchForFile) };
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const ESCAPE = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const ELLIPSIS = String.fromCharCode(8230);

/** True when one line of the frame carries all of these; the columns are padded, so exact spacing is not asserted. */
function hasRow(frame: string, ...parts: string[]): boolean {
  return frame.split(NL).some((line) => parts.every((p) => line.includes(p)));
}

const deep = 'packages/orchestrator/src/very/deeply/nested/directory/tree/component-implementation.tsx';
const narrow: LoadedDiff = {
  attempt: 1,
  diff: { schemaVersion: 1, truncated: false, additions: 1, deletions: 0, files: [{ path: deep, status: 'M', additions: 1, deletions: 0, binary: false }] },
  patch: [`diff --git a/${deep} b/${deep}`, 'index 1111111..2222222 100644', `--- a/${deep}`, `+++ b/${deep}`, '@@ -1,2 +1,3 @@', ' kept', '+added', ''].join(NL),
};
const oneTask: ReviewTaskInput[] = [{ taskId: 'implement-102', state: 'success', live: false, attempts: 1, files: [] }];

describe('ReviewView at 80 columns', () => {
  it('shortens a long path from the left and keeps the counts and the footer on the row', async () => {
    const { lastFrame, stdin } = render(<ReviewView tasks={oneTask} width={80} height={13} color={false} loadDiff={async () => narrow} onExit={() => undefined} />);
    await wait();
    let lines = stripAnsi(lastFrame() ?? '').split(NL);
    // Nothing is left for the terminal to cut off: the view fits itself into the width it was given.
    expect(lines.every((l) => l.length <= 80)).toBe(true);
    // The tail identifies the file, and the counts it was cut for survive.
    expect(hasRow(lines.join(NL), 'component-implementation.tsx', '+1 -0')).toBe(true);
    expect(lines.some((l) => l.includes(ELLIPSIS) && l.includes('component-implementation.tsx'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('Esc/Q back');

    stdin.write(ENTER);
    await wait();
    lines = stripAnsi(lastFrame() ?? '').split(NL);
    // The pane title keeps the attempt and the position; only the path gives up columns.
    expect(lines[0]!.length).toBeLessThanOrEqual(80);
    expect(lines[0]).toContain('attempt 1');
    expect(lines[0]).toContain('file 1/1');
    expect(lines[0]).toContain('component-implementation.tsx');
    const footer = lines[lines.length - 1]!;
    expect(footer.length).toBeLessThanOrEqual(80);
    expect(footer).toContain('Esc list');
  });

  it('drops the header lines the title bar already carries, so the pane spends its rows on the hunk', async () => {
    const { lastFrame, stdin } = render(<ReviewView tasks={oneTask} width={80} height={13} color={false} loadDiff={async () => narrow} onExit={() => undefined} />);
    await wait();
    stdin.write(ENTER);
    await wait();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('@@ -1,2 +1,3 @@');
    expect(frame).toContain('+added');
    expect(frame).not.toContain('diff --git');
    expect(frame).not.toContain('index 1111111');
  });
});

describe('ReviewView with a task that changed nothing', () => {
  it('keeps the task on the list and says it changed no files', async () => {
    const nothing: LoadedDiff = { attempt: 3, diff: { schemaVersion: 1, truncated: false, additions: 0, deletions: 0, files: [] }, patch: '' };
    const tasks: ReviewTaskInput[] = [{ taskId: 'review', state: 'success', live: false, attempts: 3, files: [] }];
    const { lastFrame } = render(<ReviewView tasks={tasks} width={100} height={12} color={false} loadDiff={async () => nothing} onExit={() => undefined} />);
    await wait();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('review');
    expect(frame).toContain('attempt 3  changed no files');
    expect(frame).not.toContain('0 files changed');
  });

  it('keeps a task that ran but captured nothing, and says that is why the list is empty', async () => {
    const tasks: ReviewTaskInput[] = [
      { taskId: 'ran', state: 'failed', live: false, attempts: 2, files: [] },
      { taskId: 'not-started', state: 'pending', live: false, attempts: 0, files: [] },
    ];
    const { lastFrame } = render(<ReviewView tasks={tasks} width={100} height={12} color={false} loadDiff={async () => null} onExit={() => undefined} />);
    await wait();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('ran');
    expect(frame).toContain('no diff captured');
    expect(frame).not.toContain('not-started');
  });

  it('gives up the attempt number and the caveats before the counts when the terminal is narrow', async () => {
    const wide: LoadedDiff = {
      attempt: 4,
      diff: { schemaVersion: 1, truncated: true, additions: 10, deletions: 2, files: [{ path: 'a.ts', status: 'M', additions: 10, deletions: 2, binary: false }] },
      patch: '',
    };
    const tasks: ReviewTaskInput[] = [{ taskId: 'implement', state: 'success', live: false, attempts: 4, files: [] }];
    const at = async (width: number): Promise<string> => {
      const { lastFrame } = render(<ReviewView tasks={tasks} width={width} height={10} color={false} loadDiff={async () => wide} onExit={() => undefined} />);
      await wait();
      return stripAnsi(lastFrame() ?? '').split(NL)[0]!;
    };
    expect(await at(100)).toContain('attempt 4  1 file changed, +10 -2  patch truncated');
    // The attempt number goes first, then the warning; the counts are the last thing standing.
    expect(await at(60)).toBe('✓ implement  1 file changed, +10 -2  patch truncated');
    expect(await at(45)).toBe('✓ implement  1 file changed, +10 -2');
  });

  it('says a running task has changed nothing yet rather than counting zero files', async () => {
    const tasks: ReviewTaskInput[] = [{ taskId: 'implement', state: 'running', live: true, attempts: 1, files: [] }];
    const { lastFrame } = render(<ReviewView tasks={tasks} width={100} height={12} color={false} onExit={() => undefined} />);
    await wait();
    expect(stripAnsi(lastFrame() ?? '')).toContain('running, nothing changed yet');
  });
});

/** Three hundred hunks in one file: what `cao` produces for a task that reformatted something. */
const bigLines = ['diff --git a/src/big.ts b/src/big.ts', 'index 1111111..2222222 100644', '--- a/src/big.ts', '+++ b/src/big.ts'];
for (let i = 0; i < 300; i++) bigLines.push(`@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@ fn${i}`, ` context ${i}`, `-old ${i}`, `+new ${i}`);
const big: LoadedDiff = {
  attempt: 1,
  diff: { schemaVersion: 1, truncated: false, additions: 300, deletions: 300, files: [{ path: 'src/big.ts', status: 'M', additions: 300, deletions: 300, binary: false }] },
  patch: `${bigLines.join(NL)}${NL}`,
};
const bigTask: ReviewTaskInput[] = [{ taskId: 'big', state: 'success', live: false, attempts: 1, files: [] }];

describe('ReviewView with a patch of hundreds of hunks', () => {
  it('walks every hunk with n and p and says where in the patch the pane is', async () => {
    const { lastFrame, stdin } = render(<ReviewView tasks={bigTask} width={100} height={13} color={false} loadDiff={async () => big} onExit={() => undefined} />);
    await wait();
    stdin.write(ENTER);
    await wait();
    expect(stripAnsi(lastFrame() ?? '')).toContain('hunk 1/300');
    stdin.write('n');
    stdin.write('n');
    await wait();
    let frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('hunk 3/300');
    expect(frame).toContain('@@ -21,2 +21,2 @@ fn2');
    // The last hunk is reachable from the bottom of the patch, which is where G lands.
    stdin.write('G');
    await wait();
    for (let i = 0; i < 5; i++) stdin.write('n');
    await wait();
    frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('hunk 300/300');
    expect(frame).toContain('@@ -2991,2 +2991,2 @@ fn299');
    expect(frame).toContain('/1200'); // the four dropped header lines are not counted
    stdin.write('p');
    await wait();
    expect(stripAnsi(lastFrame() ?? '')).toContain('hunk 299/300');
  });

  it('does not rebuild the patch when the dashboard hands it a fresh task array', async () => {
    const spy = vi.mocked(patchForFile);
    spy.mockClear();
    const view = (tasks: ReviewTaskInput[]): React.JSX.Element => <ReviewView tasks={tasks} width={100} height={13} color={false} loadDiff={async () => big} onExit={() => undefined} />;
    const { stdin, rerender, lastFrame } = render(view([...bigTask]));
    await wait();
    stdin.write(ENTER);
    await wait();
    const built = spy.mock.calls.length;
    expect(built).toBeGreaterThan(0);

    // Twenty spinner frames: a new array every time, structurally the same task.
    for (let i = 0; i < 20; i++) rerender(view(bigTask.map((t) => ({ ...t }))));
    await wait();
    expect(stripAnsi(lastFrame() ?? '')).toContain('src/big.ts');
    expect(spy.mock.calls.length).toBe(built);
  });
});

describe('pane content', () => {
  it('expands tabs to the terminal tab stops so a line measures what it draws', () => {
    expect(expandTabs(`a${TAB}b`)).toBe('a       b');
    expect(expandTabs(`${TAB}${TAB}x`)).toBe(`${' '.repeat(16)}x`);
    expect(expandTabs('no tabs here')).toBe('no tabs here');
  });

  it('strips escape sequences a worker wrote into a file before the pane draws them', () => {
    const injected = `${ESCAPE}[31mred${ESCAPE}[0m`;
    const patch = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', `+${injected}`, `+${TAB}tabbed`, ''].join(NL);
    const { lines, hunks } = buildPane(patch, { path: 'src/a.ts', binary: false }, false);
    expect(lines).toEqual(['@@ -1,1 +1,2 @@', '+red', '+       tabbed']);
    expect(lines.join('')).not.toContain(ESCAPE);
    expect(hunks).toEqual([0]);
  });

  it('keeps a --- line that is hunk content rather than a file header', () => {
    const patch = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,2 +1,1 @@', '--- a heading underline', ' kept', ''].join(NL);
    expect(buildPane(patch, { path: 'a.md', binary: false }, false).lines).toEqual(['@@ -1,2 +1,1 @@', '--- a heading underline', ' kept']);
  });

  it('keeps the header lines that say something the title bar does not', () => {
    const patch = ['diff --git a/old.ts b/new.ts', 'similarity index 95%', 'rename from old.ts', 'rename to new.ts', 'index 1111111..2222222 100644', ''].join(NL);
    expect(buildPane(patch, { path: 'new.ts', binary: false }, false).lines).toEqual(['similarity index 95%', 'rename from old.ts', 'rename to new.ts']);
  });

  it('shortens a label from the left, keeping the end that identifies it', () => {
    expect(shortenLabel('src/a.ts', 20)).toBe('src/a.ts');
    expect(shortenLabel('src/deep/nested/file.ts', 12)).toBe(`${ELLIPSIS}ted/file.ts`);
    expect(shortenLabel('src/a.ts', 1)).toBe(ELLIPSIS);
    expect(shortenLabel('src/a.ts', 0)).toBe('');
  });
});
