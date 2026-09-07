/** Rendering of a captured attempt diff: colour, `--file` filtering, `--stat`, headers, execution order. */
import { describe, it, expect } from 'vitest';
import {
  diffHeader,
  normalizeDiffPath,
  paintPatch,
  patchForFile,
  recordMatchesFile,
  renderNameOnly,
  renderStat,
  summarizeDiff,
} from '../../src/cli/render/diff.js';
import { executionOrder } from '../../src/cli/util.js';
import { stripAnsi } from '../../src/cli/color.js';
import type { DiffFileRecord } from '../../src/types/result.js';
import type { WorkflowRun } from '../../src/types/run.js';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-gone',
  '+added',
  'diff --git a/blob.bin b/blob.bin',
  'index 3333333..4444444 100644',
  'GIT binary patch',
  'literal 8',
  'zcmZQzU|?Yk0000',
  '',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 90%',
  'rename from old name.txt',
  'rename to new name.txt',
  '',
].join('\n');

// The two headers git writes differently from the plain case, built from character codes so the escapes
// stay literal: a bare path with a space gets a disambiguating tab, and a non-ASCII path is C-quoted whole
// with the octal *bytes* of its UTF-8 form. Both sides of `diff --git` are quoted independently.
const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const CAFE = `caf${BS}303${BS}251`;
const AWKWARD = [
  'diff --git a/spaced name.txt b/spaced name.txt',
  'index 1111111..2222222 100644',
  `--- a/spaced name.txt${TAB}`,
  `+++ b/spaced name.txt${TAB}`,
  '@@ -1 +1,2 @@',
  ' one',
  '+two',
  `diff --git "a/${CAFE}.txt" "b/${CAFE}.txt"`,
  'index 3333333..4444444 100644',
  `--- "a/${CAFE}.txt"`,
  `+++ "b/${CAFE}.txt"`,
  '@@ -1 +1,2 @@',
  ' one',
  '+deux',
  `diff --git "a/${CAFE}.bin" "b/${CAFE}.bin"`,
  'index 5555555..6666666 100644',
  `Binary files "a/${CAFE}.bin" and "b/${CAFE}.bin" differ`,
  `diff --git a/plain.txt "b/na${BS}303${BS}257ve.txt"`,
  'similarity index 100%',
  'rename from plain.txt',
  `rename to "na${BS}303${BS}257ve.txt"`,
  '',
].join('\n');

const RECORDS: DiffFileRecord[] = [
  { path: 'src/a.ts', status: 'M', additions: 1, deletions: 1, binary: false },
  { path: 'blob.bin', status: 'M', additions: 0, deletions: 0, binary: true },
  { path: 'new name.txt', oldPath: 'old name.txt', status: 'R', additions: 0, deletions: 0, binary: false },
];

describe('paintPatch', () => {
  it('leaves the patch byte for byte alone without colour', () => {
    expect(paintPatch(PATCH, false)).toBe(PATCH);
    expect(paintPatch('', true)).toBe('');
  });

  it('colours content lines but not the file headers they start like', () => {
    const painted = paintPatch(PATCH, true).split('\n');
    expect(painted[6]).toBe('[31m-gone[39m'); // red removal
    expect(painted[7]).toBe('[32m+added[39m'); // green addition
    expect(painted[4]).toBe('[36m@@ -1,3 +1,3 @@[39m'); // cyan hunk header
    expect(painted[2]).toBe('[1m--- a/src/a.ts[22m'); // `---`/`+++` are metadata, not removals
    expect(painted[3]).toBe('[1m+++ b/src/a.ts[22m');
    expect(painted[0]).toBe('[1mdiff --git a/src/a.ts b/src/a.ts[22m');
    expect(painted[5]).toBe(' keep'); // context lines stay plain
    expect(stripAnsi(paintPatch(PATCH, true))).toBe(PATCH);
  });

  it('keeps CRLF endings and the final newline', () => {
    const crlf = 'diff --git a/x b/x\r\n@@ -0,0 +1 @@\r\n+one\r\n';
    expect(stripAnsi(paintPatch(crlf, true))).toBe(crlf);
    expect(paintPatch(crlf, true).endsWith('\r[39m\n')).toBe(true);
  });
});

describe('patchForFile', () => {
  it('keeps only the section of the requested file, with its trailing newline', () => {
    const only = patchForFile(PATCH, 'src/a.ts');
    expect(only).toBe(
      ['diff --git a/src/a.ts b/src/a.ts', 'index 1111111..2222222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' keep', '-gone', '+added', ''].join('\n'),
    );
  });

  it('finds a binary section, which has no --- / +++ pair', () => {
    expect(patchForFile(PATCH, 'blob.bin')).toContain('GIT binary patch');
    expect(patchForFile(PATCH, 'blob.bin')).not.toContain('src/a.ts');
  });

  it('matches either side of a rename', () => {
    expect(patchForFile(PATCH, 'new name.txt')).toContain('rename to new name.txt');
    expect(patchForFile(PATCH, 'old name.txt')).toContain('rename from old name.txt');
  });

  it('returns nothing for a file the attempt did not touch', () => {
    expect(patchForFile(PATCH, 'src/nowhere.ts')).toBe('');
  });

  it('finds a section whose path git had to disambiguate with a tab or C-quote', () => {
    expect(patchForFile(AWKWARD, 'spaced name.txt')).toContain('+two');
    expect(patchForFile(AWKWARD, 'spaced name.txt')).not.toContain('deux');
    expect(patchForFile(AWKWARD, 'café.txt')).toContain('+deux');
    expect(patchForFile(AWKWARD, 'café.bin')).toContain('Binary files');
    // `diff --git` quotes each side only if that side needs it, so a rename can be half-quoted.
    expect(patchForFile(AWKWARD, 'naïve.txt')).toContain('rename to');
    expect(patchForFile(AWKWARD, 'plain.txt')).toContain('rename from plain.txt');
    expect(patchForFile(AWKWARD, 'café.tx')).toBe('');
  });

  it('carries the truncation note over, so a cut patch still says it was cut', () => {
    const truncated = `${patchForFile(PATCH, 'src/a.ts')}... diff truncated after 40 of at most 100 bytes (git.maxDiffBytes); all 3 file(s) are listed in diff.json\n`;
    const filtered = patchForFile(truncated, 'src/a.ts');
    expect(filtered).toMatch(/\+added\n\.\.\. diff truncated after 40 of at most 100 bytes/);
    expect(filtered.endsWith('\n')).toBe(true);
  });
});

describe('path matching', () => {
  it('normalises separators and a leading ./', () => {
    expect(normalizeDiffPath('src\\a.ts')).toBe('src/a.ts');
    expect(normalizeDiffPath('./src/a.ts')).toBe('src/a.ts');
  });

  it('matches a record on either path of a rename, however the user spelled it', () => {
    expect(recordMatchesFile(RECORDS[0]!, 'src\\a.ts')).toBe(true);
    expect(recordMatchesFile(RECORDS[2]!, 'old name.txt')).toBe(true);
    expect(recordMatchesFile(RECORDS[2]!, 'new name.txt')).toBe(true);
    expect(recordMatchesFile(RECORDS[0]!, 'a.ts')).toBe(false);
  });
});

describe('stat rendering', () => {
  it('aligns the paths and shows both sides of a rename', () => {
    expect(renderStat(RECORDS)).toEqual([
      'M src/a.ts                      +1 -1',
      'M blob.bin                      binary',
      'R old name.txt -> new name.txt  +0 -0',
    ]);
  });

  it('colours the status letter and the counts', () => {
    const [line] = renderStat([RECORDS[0]!], true);
    expect(line).toContain('[33mM[39m');
    expect(line).toContain('[32m+1[39m');
    expect(line).toContain('[31m-1[39m');
    expect(stripAnsi(line!)).toBe(renderStat([RECORDS[0]!])[0]);
  });

  it('summarises with git\'s wording, singular included', () => {
    expect(summarizeDiff(RECORDS)).toBe('3 files changed, +1 -1');
    expect(summarizeDiff([RECORDS[0]!])).toBe('1 file changed, +1 -1');
    expect(summarizeDiff([])).toBe('0 files changed, +0 -0');
  });

  it('lists the new path only, like git diff --name-only', () => {
    expect(renderNameOnly(RECORDS)).toEqual(['src/a.ts', 'blob.bin', 'new name.txt']);
  });
});

describe('diffHeader', () => {
  it('starts with # so git apply skips it, and names attempt, kind and counts', () => {
    const header = diffHeader('build', 2, { files: RECORDS, truncated: false }, 'task');
    expect(header).toBe('# build  attempt 2  3 files changed, +1 -1');
    expect(diffHeader('build', 3, { files: [], truncated: true }, 'merge')).toBe('# build  attempt 3 (merge)  0 files changed, +0 -0  patch truncated');
  });
});

describe('executionOrder', () => {
  const run = (starts: Record<string, string | undefined>): WorkflowRun =>
    ({
      workflow: { tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
      tasks: Object.fromEntries(Object.entries(starts).map(([id, at]) => [id, { attempts: at ? [{ startedAt: at }] : [] }])),
    }) as unknown as WorkflowRun;

  it('orders by when each task first started, not by the workflow file', () => {
    expect(executionOrder(run({ a: '2026-01-01T00:00:03Z', b: '2026-01-01T00:00:01Z', c: '2026-01-01T00:00:02Z', d: undefined }))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('keeps workflow order for tasks that started together or never started', () => {
    expect(executionOrder(run({ a: '2026-01-01T00:00:01Z', b: '2026-01-01T00:00:01Z', c: undefined, d: undefined }))).toEqual(['a', 'b', 'c', 'd']);
  });
});

// A worker can write an escape sequence into a source file, and can name a file with one; either way it
// travels through the captured patch into whatever renders it.
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const HOSTILE = [{ path: `src/${ESC}[31mred.ts`, status: 'M', additions: 1, deletions: 0, binary: false }] as DiffFileRecord[];

describe('escape sequences a worker put in the diff', () => {
  it('are dropped from a coloured patch and left alone in the byte-exact one', () => {
    const patch = ['diff --git a/x b/x', '@@ -0,0 +1 @@', `+${ESC}[2Jwiped${CR}not really`, ''].join('\n');
    expect(paintPatch(patch, false)).toBe(patch); // a pipe gets what git wrote, escape sequences included
    const painted = paintPatch(patch, true);
    expect(painted).not.toContain(`${ESC}[2J`);
    expect(painted).not.toContain(CR);
    // still an addition: the line is cleaned before it is classified, not after
    expect(painted).toContain(`${ESC}[32m+wipednot really${ESC}[39m`);
  });

  it('are dropped from a stat path when it is painted, and kept when it is piped', () => {
    expect(renderStat(HOSTILE)[0]).toContain(`src/${ESC}[31mred.ts`);
    expect(stripAnsi(renderStat(HOSTILE, true)[0]!)).toBe('M src/red.ts  +1 -0');
    expect(renderStat(HOSTILE, false, true)[0]).toBe('M src/red.ts  +1 -0'); // `cao task` always draws
  });

  it('are kept by --name-only unless asked otherwise, so the output still pipes into xargs', () => {
    expect(renderNameOnly(HOSTILE)).toEqual([`src/${ESC}[31mred.ts`]);
    expect(renderNameOnly(HOSTILE, true)).toEqual(['src/red.ts']);
  });
});
