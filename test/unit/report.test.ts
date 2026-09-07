/**
 * The run report: the model `buildReport` assembles from a run directory, and the Markdown a run writes to
 * `report.md` and `cao report` prints. The fixture below is one run with everything a report has to cope
 * with: a task that succeeded and was merged, one that burned five attempts and failed, one whose changes
 * are only known from a recorded `git diff --stat`, one that was skipped, and one the run never reached.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildWorkflow, makeRun, MemoryRunStore } from '../helpers/index.js';
import { buildReport, renderReportMarkdown, type RunReport } from '../../src/workflow/report.js';
import { parseDiffStat } from '../../src/workspace/diff.js';
import type { TaskAttempt, WorkflowRun } from '../../src/types/run.js';
import type { CapturedDiff } from '../../src/workspace/diff.js';

const YAML = `
name: beta improvements
tasks:
  - id: baseline
    name: Record the base commit
    prompt: p
    model: claude-opus-5
  - id: implement
    prompt: p
  - id: docs
    prompt: p
  - id: review
    prompt: p
  - id: publish
    prompt: p
`;

/** 10:00:00Z plus `s` seconds, so every duration below is a plain arithmetic difference. */
const at = (s: number): string => new Date(Date.UTC(2026, 8, 4, 10, 0, s)).toISOString();

const NOW = new Date(at(1200)).getTime();

const BASELINE_DIFF: CapturedDiff = {
  schemaVersion: 1,
  base: 'abc1234567890',
  head: 'def4567890123',
  truncated: false,
  additions: 14,
  deletions: 3,
  files: [
    { path: 'src/base.ts', status: 'M', additions: 10, deletions: 3, binary: false },
    { path: 'docs/new.md', status: 'A', additions: 4, deletions: 0, binary: false },
    { path: 'assets/logo.png', status: 'A', additions: 0, deletions: 0, binary: true },
  ],
  patch: 'diff --git a/src/base.ts b/src/base.ts\n',
};

/**
 * Real `git diff --stat` output. The guide's graph is scaled (41 characters for 42 lines), as git's is on
 * any wide change, so only its total is knowable; README's adds up, so its split is exact.
 */
const DOCS_STAT = [
  ' docs/{old-guide.md => guide.md} | 42 +++++++++++++++++++++++++++++++++++++++++',
  ' docs/assets/logo.png            | Bin 0 -> 2048 bytes',
  ' README.md                       |  3 ++-',
  ' 3 files changed, 45 insertions(+), 1 deletion(-)',
].join('\n');

/** Agent prose that would take the document with it: an outline-breaking heading and an unclosed fence. */
const DOCS_SUMMARY = ['Rewrote the guide and moved it into place.', '', '## What changed', '', 'The generator reads the front matter:', '', '```yaml', 'title: Guide'].join('\n');

async function fixture(): Promise<{ run: WorkflowRun; store: MemoryRunStore }> {
  const { workflow, validation } = await buildWorkflow(YAML, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join('\n'));
  const run = makeRun(workflow, '2026-09-04-001');
  run.state = 'failed';
  run.baseBranch = 'main';
  run.baseCommit = 'abc1234567890abcdef';
  run.startedAt = at(0);
  run.endedAt = at(750);

  const attempt = (over: Partial<TaskAttempt> & { number: number }): TaskAttempt => ({ kind: 'task', triggeredBy: 'initial', startedAt: at(0), cwd: '/repo', ...over });

  run.tasks.baseline = {
    id: 'baseline',
    state: 'success',
    attempts: [
      attempt({
        number: 1,
        endedAt: at(62),
        exitCode: 0,
        outcome: 'success',
        usage: { costUsd: 0.1032, inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 1_200_000, cacheCreationTokens: 40_000, model: 'claude-opus-5' },
        workspace: { kind: 'worktree', path: '/wt', cwd: '/wt', branch: 'orchestrator/baseline', baseSha: 'abc1234567890abcdef', mergedSha: 'def4567890123456789' },
      }),
    ],
    retryWindowStart: 1,
    startedAt: at(0),
    endedAt: at(65),
    result: {
      taskId: 'baseline',
      attempt: 1,
      status: 'success',
      summary: 'Recorded the base commit and wrote the first docs page.\n\nIt reads the tree object rather than HEAD.',
      filesChanged: ['src/base.ts', 'docs/new.md'],
      commits: ['a1b2c3d chore: record the base commit'],
      decisions: ['Read the tree object rather than HEAD, so a dirty tree still diffs.'],
      warnings: [],
      followUp: [],
      completedAt: at(62),
    },
  };

  run.tasks.implement = {
    id: 'implement',
    state: 'failed',
    reason: 'exhausted_retries',
    message: 'the worker never produced a result',
    attempts: [
      attempt({
        number: 1,
        startedAt: at(70),
        endedAt: at(400),
        exitCode: 1,
        outcome: 'api_error',
        error: 'API Error: 500 Internal Server Error\n  at fetch (node:internal)',
        usage: { costUsd: 1.5, inputTokens: 240_000, outputTokens: 9_000, model: 'claude-sonnet-5' },
        interactions: [
          { id: 'i1', kind: 'permission', toolName: 'Bash', title: 'Bash: npm publish', requestedAt: at(120), answeredAt: at(180), answer: 'deny', source: 'handler' },
          { id: 'i2', kind: 'question', toolName: 'AskUserQuestion', title: 'Which database?', requestedAt: at(200), answeredAt: at(230), answer: 'answer', source: 'handler' },
        ],
      }),
      attempt({ number: 2, triggeredBy: 'retry', startedAt: at(410), endedAt: at(500), exitCode: 1, outcome: 'api_error', usage: { costUsd: 0.2, model: 'claude-sonnet-5' } }),
      attempt({ number: 3, triggeredBy: 'retry', startedAt: at(510), endedAt: at(600), exitCode: 1, outcome: 'crash', usage: { costUsd: 0.2, model: 'claude-sonnet-5' } }),
      attempt({ number: 4, triggeredBy: 'user_input', startedAt: at(610), endedAt: at(700), exitCode: 2, outcome: 'invalid_result', usage: { costUsd: 0.2, model: 'claude-sonnet-5' } }),
      attempt({
        number: 5,
        triggeredBy: 'retry',
        resumedSessionId: '8f2a1c34-dead-beef',
        startedAt: at(710),
        endedAt: at(745),
        exitCode: null,
        signal: 'SIGKILL',
        outcome: 'timeout',
        usage: { costUsd: 0.8, inputTokens: 80_000, outputTokens: 2_000, model: 'claude-sonnet-5' },
      }),
    ],
    retryWindowStart: 1,
    startedAt: at(70),
    endedAt: at(745),
    result: {
      taskId: 'implement',
      attempt: 1,
      status: 'failed',
      summary: 'Wired the parser up to the new schema but never got the tests green.',
      filesChanged: ['src/parser.ts', 'test/parser.test.ts'],
      commits: [],
      decisions: [],
      warnings: ['The schema migration is half-applied.'],
      followUp: ['Finish the migration | then delete the shim.'],
      error: 'timed out after 5m',
      completedAt: at(745),
    },
  };

  run.tasks.docs = {
    id: 'docs',
    state: 'success',
    attempts: [
      attempt({
        number: 1,
        startedAt: at(90),
        endedAt: at(300),
        exitCode: 0,
        outcome: 'success',
        usage: { costUsd: 0.5, inputTokens: 30_000, outputTokens: 4_000, model: 'claude-opus-5' },
        workspace: { kind: 'shared', path: '/repo', cwd: '/repo' },
      }),
    ],
    retryWindowStart: 1,
    startedAt: at(90),
    endedAt: at(300),
    result: {
      taskId: 'docs',
      attempt: 1,
      status: 'success',
      summary: DOCS_SUMMARY,
      filesChanged: ['docs/guide.md'],
      commits: ['b2c3d4e docs: rewrite the guide'],
      decisions: [],
      warnings: [],
      followUp: [],
      git: { branch: 'main', baseSha: 'abc1234567890abcdef', headSha: 'aaa1111111111111111', diffStat: DOCS_STAT, uncommittedFiles: [] },
      completedAt: at(300),
    },
  };

  run.tasks.review = { id: 'review', state: 'skipped', reason: 'upstream_failed', message: 'implement did not succeed', attempts: [], retryWindowStart: 1 };
  run.tasks.publish = { id: 'publish', state: 'pending', attempts: [], retryWindowStart: 1 };

  const store = new MemoryRunStore();
  await store.writeDiff(run.runId, 'baseline', 1, BASELINE_DIFF);
  return { run, store };
}

/** Machine-specific paths would make the document differ per checkout; the rendering is what is under test. */
function stable(report: RunReport): RunReport {
  return { ...report, repository: '/repo', configPath: '/repo/workflow.yaml' };
}

async function render(mutate?: (run: WorkflowRun) => void): Promise<string> {
  const { run, store } = await fixture();
  mutate?.(run);
  return renderReportMarkdown(stable(await buildReport(store, run, NOW)));
}

describe('parseDiffStat', () => {
  it('reads back file names, renames, binaries and the exact totals', () => {
    const stat = parseDiffStat(DOCS_STAT)!;
    expect(stat.additions).toBe(45);
    expect(stat.deletions).toBe(1);
    expect(stat.files).toEqual([
      { path: 'docs/guide.md', oldPath: 'docs/old-guide.md', changed: 42, binary: false },
      { path: 'docs/assets/logo.png', changed: 0, binary: true },
      // the graph adds up here, so the split is git's own rather than a guess
      { path: 'README.md', changed: 3, binary: false, additions: 2, deletions: 1 },
    ]);
  });

  it('takes a rename written without a shared prefix, and one written with an empty side', () => {
    const stat = parseDiffStat(' old.ts => new.ts | 2 +-\n src/{ => nested}/a.ts | 1 +\n 2 files changed, 2 insertions(+), 1 deletion(-)')!;
    expect(stat.files.map((f) => [f.oldPath, f.path])).toEqual([
      ['old.ts', 'new.ts'],
      ['src/a.ts', 'src/nested/a.ts'],
    ]);
  });

  it('is undefined for text that is not a stat at all', () => {
    expect(parseDiffStat('')).toBeUndefined();
    expect(parseDiffStat('fatal: bad revision')).toBeUndefined();
  });
});

describe('buildReport', () => {
  it('orders tasks by execution, and carries result, changes, attempts and interactions', async () => {
    const { run, store } = await fixture();
    const report = await buildReport(store, run, NOW);

    expect(report.tasks.map((t) => t.id)).toEqual(['baseline', 'implement', 'docs', 'review', 'publish']);
    expect(report.counts).toEqual({ total: 5, success: 2, failed: 1, blocked: 0, skipped: 1, cancelled: 0, pending: 1 });
    expect(report.durationMs).toBe(750_000);
    expect(report.usage.costUsd).toBeCloseTo(3.5032, 4);
    expect(report.models).toEqual([
      { model: 'claude-opus-5', tasks: 2 },
      { model: 'claude-sonnet-5', tasks: 1 },
    ]);
    // eight distinct files, and the lines of every task whose source could count them
    expect(report.changes).toEqual({ files: 8, additions: 59, deletions: 4, complete: false });
    // only the task the run never reached; a skipped one has a reason worth reading
    expect(report.notStarted).toEqual(['publish']);

    const baseline = report.tasks[0]!;
    expect(baseline.durationMs).toBe(62_000);
    expect(baseline.changes?.source).toBe('diff');
    expect(baseline.changes?.files).toHaveLength(3);
    expect(baseline.mergedSha).toBe('def4567890123456789');
    expect(baseline.decisions).toHaveLength(1);

    const implement = report.tasks[1]!;
    expect(implement.attempts.map((a) => a.outcome)).toEqual(['api_error', 'api_error', 'crash', 'invalid_result', 'timeout']);
    expect(implement.attempts[4]!.reason).toBe('retried after attempt 4 invalid result, continuing session 8f2a1c34');
    expect(implement.interactions).toEqual({ count: 2, waitedMs: 90_000 });

    expect(report.tasks[3]!.ran).toBe(true);
    expect(report.tasks[4]!.ran).toBe(false);
    // a task that never started has no duration to report rather than a zero one
    expect(report.tasks[4]!.durationMs).toBeUndefined();
    expect(report.tasks[4]!.attempts).toEqual([]);
  });

  it('falls back from a captured diff to the recorded stat, and from there to the agent word', async () => {
    const { run, store } = await fixture();
    const report = await buildReport(store, run, NOW);

    const docs = report.tasks.find((t) => t.id === 'docs')!;
    expect(docs.changes).toEqual({
      source: 'stat',
      attempt: 1,
      truncated: false,
      additions: 45,
      deletions: 1,
      files: [
        { path: 'docs/guide.md', oldPath: 'docs/old-guide.md', changed: 42, binary: false },
        { path: 'docs/assets/logo.png', changed: 0, binary: true },
        { path: 'README.md', changed: 3, binary: false, additions: 2, deletions: 1 },
      ],
    });

    const implement = report.tasks.find((t) => t.id === 'implement')!;
    expect(implement.changes).toEqual({ source: 'agent', truncated: false, files: [{ path: 'src/parser.ts' }, { path: 'test/parser.test.ts' }] });
  });

  it('prefers the per-file records folded into the result over the stat beside them', async () => {
    const { run, store } = await fixture();
    run.tasks.docs!.result!.git!.files = [{ path: 'docs/guide.md', status: 'M', additions: 40, deletions: 2, binary: false }];
    const report = await buildReport(store, run, NOW);
    const docs = report.tasks.find((t) => t.id === 'docs')!;
    expect(docs.changes).toMatchObject({ source: 'diff', additions: 40, deletions: 2 });
  });

  it('reports a run that is still going without inventing an end', async () => {
    const { run, store } = await fixture();
    run.state = 'running';
    run.endedAt = undefined;
    run.tasks.implement!.state = 'running';
    run.tasks.implement!.currentAttempt = 5;
    run.tasks.implement!.attempts[4]!.endedAt = undefined;
    run.tasks.implement!.attempts[4]!.outcome = undefined;
    const report = await buildReport(store, run, NOW);
    expect(report.endedAt).toBeUndefined();
    expect(report.durationMs).toBe(1_200_000);
    expect(report.tasks[1]!.attempts[4]!.durationMs).toBe(490_000);
    const md = renderReportMarkdown(stable(report));
    expect(md).toContain('still running');
    // a task in flight is not one the run never reached, however `counts.pending` lumps them together
    expect(md).toContain('2/5 tasks succeeded, 1 skipped, 1 still running, 1 never started');
  });
});

describe('renderReportMarkdown', () => {
  it('renders the whole fixture run as one pasteable document', async () => {
    expect(await render()).toBe(await expectedDocument());
  });

  it('keeps every table row the shape of its header, and multi-line agent text out of the cells', async () => {
    const md = await render();
    // the attempt's error is two lines on disk and one note here, so the table above it stays a table
    expect(md).toContain('- attempt 1 error: API Error: 500 Internal Server Error   at fetch (node:internal)');
    for (const block of md.split('\n\n')) {
      const rows = block.split('\n').filter((l) => l.startsWith('|'));
      if (rows.length < 2) continue;
      const cells = (row: string): number => row.split(/(?<!\\)\|/).length;
      for (const row of rows) expect(cells(row)).toBe(cells(rows[0]!));
    }
  });

  it('leaves a pipe inside a bullet alone rather than turning the list into a table', async () => {
    expect(await render()).toContain('- Finish the migration | then delete the shim.');
  });

  it('links every overview row to the section it summarises', async () => {
    const md = await render();
    expect(md).toContain('| [`baseline`](#baseline--record-the-base-commit) |');
    // every anchor a row points at is one GitHub will have generated for a heading the document contains
    const headings = md
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.slice(3).toLowerCase().replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim().replace(/\s/g, '-'));
    const targets = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(targets).toHaveLength(headings.length);
    for (const target of targets) expect(headings).toContain(target);
  });

  it('names the tasks the run never reached instead of giving each an empty section', async () => {
    const md = await render();
    expect(md).toContain('- **Never started:** `publish`');
    expect(md).not.toContain('## publish');
    // a skipped task keeps its section, because its message is the reason it was skipped
    expect(md).toContain('## review');
    expect(md).toContain('_implement did not succeed_');
  });

  it('leaves out a heading whose section would be empty', async () => {
    const md = await render();
    const docs = md.slice(md.indexOf('## docs'), md.indexOf('## review'));
    expect(docs).not.toContain('**Warnings**');
    expect(docs).not.toContain('**Follow-up**');
    expect(docs).not.toContain('**Decisions**');
    // one attempt that simply worked says nothing the head line has not already said
    expect(docs).not.toContain('**Attempts**');
  });

  it('shows the attempts table once a task needed more than one try', async () => {
    const md = await render();
    const implement = md.slice(md.indexOf('## implement'), md.indexOf('## docs'));
    expect(implement).toContain('**Attempts**');
    expect(implement.match(/^\| \d /gm)).toHaveLength(5);
    expect(implement).toContain('- attempt 5: retried after attempt 4 invalid result, continuing session 8f2a1c34');
  });

  it('closes a code fence the agent left open, and demotes a heading that would break the outline', async () => {
    const md = await render();
    expect(md).toContain('#### What changed');
    expect(md).not.toMatch(/^## What changed$/m);
    // the summary's ```yaml is closed before the next section starts
    const docs = md.slice(md.indexOf('## docs'), md.indexOf('## review'));
    expect(docs.match(/```/g)).toHaveLength(2);
  });

  it('sorts the file table by how much each file moved, and says where the counts came from', async () => {
    const md = await render();
    const docs = md.slice(md.indexOf('## docs'), md.indexOf('## review'));
    expect(docs).toContain('**Files changed** — 3 files, +45 -1 — from the recorded `git diff --stat`');
    expect(docs.match(/^\| `?docs.*\|$/gm)?.[0]).toContain('docs/old-guide.md` → `docs/guide.md');
    expect(docs).toContain('| ±42 |');
    expect(docs).toContain('| +2 -1 |');
    expect(docs).toContain('| binary |');
  });

  it('caps a long file table and says what it left out', async () => {
    const md = await render((run) => {
      run.tasks.docs!.result!.git!.files = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'M' as const, additions: 30 - i, deletions: 0, binary: false }));
    });
    const docs = md.slice(md.indexOf('## docs'), md.indexOf('## review'));
    expect(docs).toContain('| `src/f0.ts` | +30 -0 |');
    expect(docs).not.toContain('`src/f20.ts`');
    expect(docs).toContain('… and 10 smaller files, 55 lines between them.');
  });

  it('says so when a task produced no result at all', async () => {
    const md = await render((run) => {
      run.tasks.baseline!.result = undefined;
    });
    expect(md).toContain('_No result was recorded for this task._');
  });

  it('notes a truncated patch next to the file count', async () => {
    const { run, store } = await fixture();
    await store.writeDiff(run.runId, 'baseline', 1, { ...BASELINE_DIFF, truncated: true });
    const md = renderReportMarkdown(stable(await buildReport(store, run, NOW)));
    expect(md).toContain('3 files, +14 -3 (attempt 1) — patch truncated at `git.maxDiffBytes`');
  });

  it('never writes the word undefined, even for a trigger or outcome this build has no label for', async () => {
    const md = await render((run) => {
      const a = run.tasks.implement!.attempts[3]!;
      (a as { triggeredBy: string }).triggeredBy = 'from_the_future';
      (a as { outcome: string }).outcome = 'exploded';
    });
    expect(md).not.toContain('undefined');
    expect(md).toContain('| from_the_future |');
    expect(md).toContain('| exploded |');
    expect(md).toContain('- attempt 5: retried after attempt 4 exploded');
  });

  it('dates an attempt that did not start on the day the task did', async () => {
    const md = await render((run) => {
      const a = run.tasks.implement!.attempts[4]!;
      a.startedAt = new Date(Date.UTC(2026, 8, 5, 3, 0, 0)).toISOString();
      a.endedAt = new Date(Date.UTC(2026, 8, 5, 3, 0, 30)).toISOString();
    });
    expect(md).toContain('| 09-05 03:00:00 |');
  });
});

/** The document the fixture run should produce, kept beside the tests so it reads as a document. */
async function expectedDocument(): Promise<string> {
  const file = path.join(process.cwd(), 'test', 'fixtures', 'report.md');
  return (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
}
