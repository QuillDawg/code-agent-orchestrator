import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowCompletionStore } from '../../src/workflow/completion-store.js';
import type { ResolvedTask } from '../../src/types/workflow.js';

const task = (id: string, sourceId = id) => ({ id, sourceId }) as ResolvedTask;

describe('WorkflowCompletionStore', () => {
  it('round-trips comments and marks concrete and foreach tasks independently', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-completion-'));
    const workflow = path.join(dir, 'workflow.yaml');
    await fs.writeFile(workflow, '# keep this comment\nname: demo\nissues: [1, 2]\ntasks:\n  - id: one\n    prompt: p\n  - id: each\n    foreach: issues\n    prompt: p\n', 'utf8');
    const store = new WorkflowCompletionStore(workflow);
    await store.markCompleted(task('one'), { completedAt: '2026-01-01T00:00:00.000Z', runId: 'r1' });
    await store.markCompleted(task('each-1', 'each'), { completedAt: '2026-01-01T00:00:01.000Z', runId: 'r1' });
    const text = await fs.readFile(workflow, 'utf8');
    expect(text).toContain('# keep this comment');
    expect(text).toContain('state: completed');
    expect(text).toContain('each-1:');
    await store.clear(task('one'));
    expect(await fs.readFile(workflow, 'utf8')).not.toContain('state: completed');
  });
});
