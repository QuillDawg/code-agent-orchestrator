import { describe, it, expect } from 'vitest';
import { buildWorkflow, makeRun } from '../helpers/index.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import type { EnrichedTaskResult } from '../../src/types/result.js';

const YAML = `
name: t
tasks:
  - id: impl-1
    type: implementation
    prompt: p
  - id: impl-2
    type: implementation
    prompt: p
  - id: review
    context:
      from:
        - task: impl-1
          include: [summary, filesChanged]
        - impl-2
    prompt: Review it
  - id: none
    prompt: p
  - id: agg
    context:
      fromType: implementation
      maxChars: 400
    prompt: p
`;

function result(id: string, extra: Partial<EnrichedTaskResult> = {}): EnrichedTaskResult {
  return {
    taskId: id,
    attempt: 1,
    status: 'success',
    summary: `Implemented ${id}`,
    filesChanged: [`src/${id}.ts`],
    commits: ['abc'],
    decisions: [`used pattern X in ${id}`],
    warnings: [`watch out ${id}`],
    followUp: [],
    git: { branch: `orchestrator/${id}`, headSha: '1234567890ab', baseSha: 'fedcba098765', uncommittedFiles: [] },
    completedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('ContextBuilder', () => {
  it('renders selected fields from multiple parents in document order', async () => {
    const { workflow } = await buildWorkflow(YAML);
    const run = makeRun(workflow);
    run.tasks['impl-1']!.state = 'success';
    run.tasks['impl-1']!.result = result('impl-1');
    run.tasks['impl-2']!.state = 'success';
    run.tasks['impl-2']!.result = result('impl-2');
    const task = workflow.tasks.find((t) => t.id === 'review')!;
    const out = new ContextBuilder().build({ task, tasks: run.tasks, taskDefs: new Map(workflow.tasks.map((t) => [t.id, t])) });
    expect(out.sources).toEqual(['impl-1', 'impl-2']);
    expect(out.markdown).toMatch(/^# Previous Task Context/);
    expect(out.markdown).toContain('## impl-1 (status: success)');
    expect(out.markdown).toContain('Implemented impl-1');
    expect(out.markdown).toContain('- src/impl-1.ts');
    // impl-1 is filtered to summary + filesChanged
    expect(out.markdown).not.toContain('used pattern X in impl-1');
    expect(out.markdown).not.toContain('watch out impl-1');
    // impl-2 has default fields
    expect(out.markdown).toContain('used pattern X in impl-2');
    expect(out.markdown).toContain('watch out impl-2');
    expect(out.markdown).toContain('branch `orchestrator/impl-2` @ 1234567890');
    const prompt = ContextBuilder.compose(out.markdown, task.prompt);
    expect(prompt.endsWith('# Task\n\nReview it\n')).toBe(true);
  });

  it('produces no context for tasks without sources', async () => {
    const { workflow } = await buildWorkflow(YAML);
    const run = makeRun(workflow);
    const task = workflow.tasks.find((t) => t.id === 'none')!;
    const out = new ContextBuilder().build({ task, tasks: run.tasks, taskDefs: new Map(workflow.tasks.map((t) => [t.id, t])) });
    expect(out.markdown).toBe('');
    expect(ContextBuilder.compose(out.markdown, 'p')).toBe('p');
  });

  it('skips missing or failed sources with warnings unless includeFailed', async () => {
    const { workflow } = await buildWorkflow(YAML);
    const run = makeRun(workflow);
    run.tasks['impl-1']!.state = 'failed';
    run.tasks['impl-1']!.message = 'boom';
    run.tasks['impl-2']!.state = 'success';
    run.tasks['impl-2']!.result = result('impl-2');
    const task = workflow.tasks.find((t) => t.id === 'review')!;
    const defs = new Map(workflow.tasks.map((t) => [t.id, t]));
    const out = new ContextBuilder().build({ task, tasks: run.tasks, taskDefs: defs });
    expect(out.sources).toEqual(['impl-2']);
    expect(out.warnings[0]).toMatch(/impl-1.*failed/);
    const out2 = new ContextBuilder().build({ task: { ...task, context: { ...task.context!, includeFailed: true } }, tasks: run.tasks, taskDefs: defs });
    expect(out2.sources).toEqual(['impl-1', 'impl-2']);
    expect(out2.markdown).toContain('No structured result available (task state: failed, boom)');
  });

  it('aggregates by type and truncates to maxChars', async () => {
    const { workflow } = await buildWorkflow(YAML);
    const run = makeRun(workflow);
    for (const id of ['impl-1', 'impl-2']) {
      run.tasks[id]!.state = 'success';
      run.tasks[id]!.result = result(id, { decisions: Array.from({ length: 50 }, (_, i) => `decision ${i} for ${id} with some longer text`) });
    }
    const task = workflow.tasks.find((t) => t.id === 'agg')!;
    const out = new ContextBuilder().build({ task, tasks: run.tasks, taskDefs: new Map(workflow.tasks.map((t) => [t.id, t])) });
    expect(out.sources).toEqual(['impl-1', 'impl-2']);
    expect(out.truncated).toBe(true);
    expect(out.markdown.length).toBeLessThanOrEqual(600);
    expect(out.markdown).toContain('Implemented impl-1');
  });

  it('adds previous-attempt and user-input sections', async () => {
    const { workflow } = await buildWorkflow(YAML);
    const run = makeRun(workflow);
    const task = workflow.tasks.find((t) => t.id === 'none')!;
    const out = new ContextBuilder().build({
      task,
      tasks: run.tasks,
      taskDefs: new Map(workflow.tasks.map((t) => [t.id, t])),
      previousAttempt: { number: 1, kind: 'task', triggeredBy: 'initial', startedAt: 'x', cwd: '.', outcome: 'failed', error: 'tests failed', result: { status: 'failed', summary: 's', filesChanged: [], commits: [], decisions: [], warnings: ['w1'], followUp: [], error: 'e1' } },
      previousOutputTail: ['line1', 'line2'],
      userInput: 'Use Postgres.',
    });
    expect(out.markdown).toContain('# Previous Attempt');
    expect(out.markdown).toContain('Attempt 1 of this task failed (outcome: failed)');
    expect(out.markdown).toContain('Error: e1');
    expect(out.markdown).toContain('line2');
    expect(out.markdown).toContain('# User Input\n\nUse Postgres.');
  });
});
