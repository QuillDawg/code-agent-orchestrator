import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, states, waitFor } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import type { ResolvedWorkflow } from '../../src/types/workflow.js';

interface Harness {
  scheduler: WorkflowScheduler;
  store: MemoryRunStore;
  runner: MockRunner;
  workspace: MockWorkspace;
  bus: WorkflowEventBus;
  run: ReturnType<typeof makeRun>;
}

function harness(workflow: ResolvedWorkflow, runner = new MockRunner(), extra: Partial<ConstructorParameters<typeof WorkflowScheduler>[0]> = {}): Harness {
  const run = makeRun(workflow);
  const store = new MemoryRunStore();
  const workspace = new MockWorkspace(workflow.repositoryRoot);
  const bus = new WorkflowEventBus(run.runId);
  bus.onAny((e) => void store.appendEvent(e));
  const scheduler = new WorkflowScheduler({ run, store, runners: new RunnerRegistry().register(runner), workspace, bus, ...extra });
  return { scheduler, store, runner, workspace, bus, run };
}

const NL = String.fromCharCode(10);
const SEQ = 'name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n  - id: c\n    prompt: p\n';
const DIAMOND = `
name: t
execution:
  maxConcurrency: 3
tasks:
  - id: a
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
  - id: c
    parallelGroup: g
    prompt: p
  - id: d
    prompt: p
`;

async function wf(yaml: string) {
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  if (!validation.ok) throw new Error(validation.diagnostics.map((d) => d.message).join('\n'));
  return workflow;
}

describe('scheduler: ordering', () => {
  it('runs an unadorned list strictly sequentially, one fresh attempt each', async () => {
    const h = harness(await wf(SEQ));
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(res.exitCode).toBe(0);
    expect(h.runner.calls.map((c) => c.taskId)).toEqual(['a', 'b', 'c']);
    expect(h.runner.maxConcurrent).toBe(1);
    expect(states(h.run)).toEqual({ a: 'success', b: 'success', c: 'success' });
    // task.started for b only after task.completed for a
    const types = h.store.events.map((e) => `${e.type}:${'taskId' in e ? e.taskId : ''}`);
    expect(types.indexOf('task.started:b')).toBeGreaterThan(types.indexOf('task.completed:a'));
    // a fresh session per task
    expect(new Set(h.run.workflow.tasks.map((t) => h.run.tasks[t.id]!.attempts[0]!.sessionId)).size).toBe(3);
  });

  it('runs parallel groups concurrently in worktrees and gates the join task', async () => {
    const runner = new MockRunner().when('b', { kind: 'success', delayMs: 60 }).when('c', { kind: 'success', delayMs: 60 });
    const h = harness(await wf(DIAMOND), runner);
    await h.scheduler.execute();
    expect(runner.maxConcurrent).toBe(2);
    const bStart = runner.calls.find((c) => c.taskId === 'b')!;
    const cStart = runner.calls.find((c) => c.taskId === 'c')!;
    const dStart = runner.calls.find((c) => c.taskId === 'd')!;
    expect(dStart.startedAt).toBeGreaterThanOrEqual(Math.max(bStart.endedAt!, cStart.endedAt!));
    expect(h.workspace.acquisitions.map((a) => `${a.taskId}:${a.mode}`)).toEqual(['a:shared', 'b:worktree', 'c:worktree', 'd:shared']);
    expect(h.store.eventsOf('task.merged').map((e) => (e as { taskId: string }).taskId).sort()).toEqual(['b', 'c']);
  });

  it('respects maxConcurrency', async () => {
    const yaml = `
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    prompt: p
${['b', 'c', 'd', 'e', 'f'].map((id) => `  - id: ${id}\n    parallelGroup: g\n    prompt: p`).join('\n')}
`;
    const runner = new MockRunner();
    for (const id of ['b', 'c', 'd', 'e', 'f']) runner.when(id, { kind: 'success', delayMs: 30 });
    const h = harness(await wf(yaml), runner);
    await h.scheduler.execute();
    expect(runner.maxConcurrent).toBe(2);
    expect(Object.values(states(h.run)).every((s) => s === 'success')).toBe(true);
  });

  it('persists running state before invoking the runner (persist-before-act)', async () => {
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'));
    const original = h.runner.run.bind(h.runner);
    let snapshotStateAtRun: string | undefined;
    h.runner.run = async (input, hooks) => {
      snapshotStateAtRun = h.store.snapshots[h.store.snapshots.length - 1]!.tasks.a!.state;
      return original(input, hooks);
    };
    await h.scheduler.execute();
    expect(snapshotStateAtRun).toBe('running');
  });

  it('never launches a task twice and numbers attempts monotonically', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'success' }]);
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 1\n    prompt: p\n'), runner);
    await h.scheduler.execute();
    expect(runner.calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(h.run.tasks.a!.attempts.map((a) => a.number)).toEqual([1, 2]);
  });
});

describe('scheduler: failures and retries', () => {
  it('stop: launches nothing new, waits for in-flight tasks, cancels the rest', async () => {
    const runner = new MockRunner().when('b', { kind: 'error', outcome: 'crash', message: 'boom' }).when('c', { kind: 'success', delayMs: 80 });
    const h = harness(await wf(DIAMOND), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    expect(res.exitCode).toBe(1);
    expect(states(h.run)).toEqual({ a: 'success', b: 'failed', c: 'success', d: 'cancelled' });
    expect(h.run.tasks.b!.reason).toBe('crash');
    expect(h.run.tasks.b!.message).toBe('boom');
    expect(h.run.tasks.d!.reason).toBe('stop_requested');
  });

  it('stopMode cancel aborts in-flight siblings', async () => {
    const runner = new MockRunner().when('b', { kind: 'error', outcome: 'crash' }).when('c', { kind: 'hang' });
    const h = harness(await wf(DIAMOND.replace('maxConcurrency: 3', 'maxConcurrency: 3\n  stopMode: cancel')), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    expect(states(h.run)).toEqual({ a: 'success', b: 'failed', c: 'cancelled', d: 'cancelled' });
  });

  it('skip_dependents blocks descendants but lets independent branches run', async () => {
    const yaml = `
name: t
execution:
  mode: dag
  maxConcurrency: 2
tasks:
  - id: a
    onFailure: skip_dependents
    prompt: p
  - id: b
    dependsOn: [a]
    prompt: p
  - id: c
    prompt: p
  - id: d
    dependsOn: [c]
    prompt: p
`;
    const runner = new MockRunner().when('a', { kind: 'status', status: 'failed', error: 'nope' });
    const h = harness(await wf(yaml), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    expect(states(h.run)).toEqual({ a: 'failed', b: 'blocked', c: 'success', d: 'success' });
    expect(h.run.tasks.b!.blockedBy).toBe('a');
    expect(h.run.tasks.b!.message).toContain('dependency "a" failed');
  });

  it('continue lets dependents run with the failure visible in context', async () => {
    const yaml = 'name: t\ntasks:\n  - id: a\n    onFailure: continue\n    prompt: p\n  - id: b\n    context:\n      from: [a]\n      includeFailed: true\n    prompt: p\n';
    const runner = new MockRunner().when('a', { kind: 'status', status: 'failed', error: 'bad' });
    const h = harness(await wf(yaml), runner);
    const res = await h.scheduler.execute();
    expect(states(h.run)).toEqual({ a: 'failed', b: 'success' });
    expect(res.state).toBe('failed');
    expect(h.runner.calls[1]!.prompt).toContain('# Previous Task Context');
    expect(h.runner.calls[1]!.prompt).toContain('(status: failed)');
  });

  it('retries with a fresh attempt, injecting the previous failure, then succeeds', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'invalid_result', message: 'bad json' }, { kind: 'status', status: 'failed', error: 'tests red' }, { kind: 'success' }]);
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 2\n    prompt: do it\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[1]!.prompt).toContain('# Previous Attempt');
    expect(runner.calls[1]!.prompt).toContain('bad json');
    expect(runner.calls[2]!.prompt).toContain('tests red');
    expect(runner.calls[2]!.prompt).toContain('# Task\n\ndo it');
    expect(h.store.eventsOf('task.retrying')).toHaveLength(2);
    expect(h.run.tasks.a!.attempts.map((a) => a.outcome)).toEqual(['invalid_result', 'failed', 'success']);
  });

  it('exhausts retries then applies onFailure', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'timeout' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 1\n    prompt: p\n  - id: b\n    prompt: p\n'), runner);
    await h.scheduler.execute();
    expect(runner.calls).toHaveLength(2);
    expect(states(h.run)).toEqual({ a: 'failed', b: 'cancelled' });
    expect(h.run.tasks.a!.reason).toBe('timeout');
  });

  it('a blocked result is not retried and blocks dependents', async () => {
    const runner = new MockRunner().when('a', { kind: 'status', status: 'blocked', error: 'missing creds' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 3\n    onFailure: continue\n    prompt: p\n  - id: b\n    prompt: p\n'), runner);
    await h.scheduler.execute();
    expect(runner.calls).toHaveLength(1);
    expect(states(h.run)).toEqual({ a: 'blocked', b: 'blocked' });
    expect(h.run.tasks.a!.reason).toBe('agent_blocked');
  });

  it('a runner that throws is treated as a crash', async () => {
    const runner = new MockRunner().when('a', { kind: 'throw' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    expect(h.run.tasks.a!.attempts[0]!.error).toMatch(/exploded/);
  });

  it('delays retries according to retry.delay', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'crash' }, { kind: 'success' }]);
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retry:\n      attempts: 1\n      delay: 120ms\n    prompt: p\n'), runner);
    await h.scheduler.execute();
    expect(runner.calls[1]!.startedAt - runner.calls[0]!.endedAt!).toBeGreaterThanOrEqual(100);
  });
});

describe('scheduler: conditions, selection, approvals, interrupts', () => {
  it('skips tasks whose when-condition is false; skipped satisfies dependents', async () => {
    const yaml = `
name: t
tasks:
  - id: a
    prompt: p
  - id: b
    when:
      expr: tasks.a.warnings.length > 0
    prompt: p
  - id: c
    prompt: p
`;
    const h = harness(await wf(yaml));
    await h.scheduler.execute();
    expect(states(h.run)).toEqual({ a: 'success', b: 'skipped', c: 'success' });
    expect(h.run.tasks.b!.reason).toBe('when_false');
  });

  it('runs conditional tasks when the condition holds', async () => {
    const runner = new MockRunner().when('a', { kind: 'success', result: { warnings: ['w'] } });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    when:\n      task: a\n      status: success\n    prompt: p\n'), runner);
    await h.scheduler.execute();
    expect(states(h.run)).toEqual({ a: 'success', b: 'success' });
  });

  it('--task runs only the selected task; --from runs downstream', async () => {
    const workflow = await wf(SEQ);
    const h1 = harness(workflow);
    h1.run.selection = { only: ['c'] };
    await h1.scheduler.execute();
    expect(states(h1.run)).toEqual({ a: 'skipped', b: 'skipped', c: 'success' });
    expect(h1.run.tasks.a!.reason).toBe('not_selected');
    const h2 = harness(workflow);
    h2.run.selection = { from: ['b'] };
    await h2.scheduler.execute();
    expect(states(h2.run)).toEqual({ a: 'skipped', b: 'success', c: 'success' });
  });

  it('pauses on approval gates without a handler and resumes with the handler', async () => {
    const yaml = 'name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: gate\n    type: approval\n    prompt: Continue?\n  - id: b\n    prompt: p\n';
    const h = harness(await wf(yaml));
    const res = await h.scheduler.execute();
    expect(res.state).toBe('paused');
    expect(res.exitCode).toBe(3);
    expect(states(h.run)).toEqual({ a: 'success', gate: 'awaiting_approval', b: 'pending' });

    const approved = harness(await wf(yaml), new MockRunner(), { approvalHandler: async () => ({ decision: 'approved', note: 'ship it' }) });
    const r2 = await approved.scheduler.execute();
    expect(r2.state).toBe('completed');
    expect(states(approved.run)).toEqual({ a: 'success', gate: 'success', b: 'success' });
    expect(approved.run.tasks.gate!.result?.summary).toContain('ship it');

    const rejected = harness(await wf(yaml), new MockRunner(), { approvalHandler: async () => ({ decision: 'rejected' }) });
    const r3 = await rejected.scheduler.execute();
    expect(r3.state).toBe('failed');
    expect(states(rejected.run)).toEqual({ a: 'success', gate: 'failed', b: 'cancelled' });
  });

  it('pauses on needs_input', async () => {
    const runner = new MockRunner().when('a', { kind: 'status', status: 'needs_input', error: 'which db?' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('paused');
    expect(states(h.run)).toEqual({ a: 'needs_input', b: 'pending' });
  });

  it('interrupt cancels running tasks, marks the run interrupted and keeps completed work', async () => {
    const runner = new MockRunner().when('b', { kind: 'hang' });
    const h = harness(await wf(SEQ), runner);
    const done = h.scheduler.execute();
    await waitFor(() => runner.running.includes('b#1'));
    h.scheduler.requestStop('cancel', 'signal');
    const res = await done;
    expect(res.state).toBe('interrupted');
    expect(res.exitCode).toBe(130);
    expect(states(h.run)).toEqual({ a: 'success', b: 'cancelled', c: 'cancelled' });
    expect(h.run.tasks.b!.reason).toBe('user_interrupt');
    expect(h.run.tasks.b!.attempts[0]!.outcome).toBe('cancelled');
  });

  it('agent-skipped results satisfy dependents', async () => {
    const runner = new MockRunner().when('a', { kind: 'status', status: 'skipped' });
    const h = harness(await wf(SEQ), runner);
    await h.scheduler.execute();
    expect(states(h.run)).toEqual({ a: 'skipped', b: 'success', c: 'success' });
  });
});

describe('scheduler: merge conflicts', () => {
  it('falls back to a Claude merge-resolution attempt and succeeds', async () => {
    const h = harness(await wf(DIAMOND));
    h.workspace.conflictFor.add('b');
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    const b = h.run.tasks.b!;
    expect(b.attempts.map((a) => a.kind)).toEqual(['task', 'merge']);
    expect(h.runner.calls.filter((c) => c.taskId === 'b').map((c) => c.env.CAO_ATTEMPT_KIND)).toEqual([undefined, 'merge']);
    expect(h.runner.calls.find((c) => c.env.CAO_ATTEMPT_KIND === 'merge')!.prompt).toContain('# Merge Conflict Resolution');
    expect(h.runner.calls.find((c) => c.env.CAO_ATTEMPT_KIND === 'merge')!.cwd).toBe(h.workspace.sharedRoot);
    expect(b.result?.summary).toBe('done b');
    expect(h.store.eventsOf('task.merging')).toHaveLength(1);
  });

  it('keeps the task attempt git block when a merge-resolution attempt finishes the task', async () => {
    const h = harness(await wf(DIAMOND));
    h.workspace.conflictFor.add('b');
    h.workspace.gitInfo = {
      branch: 'orchestrator/b',
      headSha: 'bbbbbbb',
      uncommittedFiles: [],
      files: [{ path: 'src/b.ts', status: 'M', additions: 3, deletions: 1, binary: false }],
    };
    await h.scheduler.execute();
    const b = h.run.tasks.b!;
    expect(b.attempts.map((a) => a.kind)).toEqual(['task', 'merge']);
    // completeMerge finalizes the shared tree and produces no git block of its own, so without carrying the
    // task attempt's block over, the result would lose its branch, head and per-file stat.
    expect(b.result?.git?.branch).toBe('orchestrator/b');
    expect(b.result?.git?.files?.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('fails the task when the merge-resolution attempt cannot merge', async () => {
    const h = harness(await wf(DIAMOND));
    h.workspace.conflictFor.add('b');
    h.workspace.mergeSucceeds = false;
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    expect(h.run.tasks.b!.state).toBe('failed');
    expect(h.run.tasks.b!.reason).toBe('merge_conflict');
  });

  it('still writes a diff for a merge-resolution session that failed', async () => {
    const runner = new MockRunner().when('b', [{ kind: 'success' }, { kind: 'error', outcome: 'crash', message: 'died mid-merge' }]);
    const h = harness(await wf(DIAMOND), runner);
    h.workspace.conflictFor.add('b');
    await h.scheduler.execute();
    const b = h.run.tasks.b!;
    expect(b.attempts[1]).toMatchObject({ kind: 'merge', outcome: 'crash' });
    // The half-finished resolution is still on disk as its own patch, not silently dropped.
    expect(h.store.diffs.get('b#2')?.files.map((f) => f.path)).toEqual(['merge-orchestrator/b.txt']);
  });

  it('hands the dashboard the newest ordinary attempt diff, never the merge one', async () => {
    const h = harness(await wf(DIAMOND));
    h.workspace.conflictFor.add('b');
    await h.scheduler.execute();
    expect(h.run.tasks.b!.attempts.map((a) => a.kind)).toEqual(['task', 'merge']);
    await h.store.writeDiff(h.run.runId, 'b', 1, {
      schemaVersion: 1,
      truncated: false,
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/b.ts', status: 'M', additions: 1, deletions: 0, binary: false }],
      patch: 'the task attempt patch',
    });
    // b#2 is the merge session's patch: it spans every task's work, so the review view is shown attempt 1.
    const captured = await h.scheduler.capturedDiff('b');
    expect(captured?.attempt).toBe(1);
    expect(captured?.patch).toBe('the task attempt patch');
    expect(await h.scheduler.capturedDiff('nobody')).toBeNull();
  });

  it('fails immediately with mergeConflictStrategy fail', async () => {
    const h = harness(await wf(DIAMOND.replace('maxConcurrency: 3', 'maxConcurrency: 3\n  worktree:\n    mergeConflictStrategy: fail')));
    h.workspace.conflictFor.add('c');
    await h.scheduler.execute();
    expect(h.run.tasks.c!.state).toBe('failed');
    expect(h.run.tasks.c!.attempts).toHaveLength(1);
    expect(h.run.tasks.c!.reason).toBe('merge_conflict');
  });
});

describe('scheduler: reading a finished attempt', () => {
  it('reads an attempt transcript from its events.jsonl, skipping lines that are not entries', async () => {
    const h = harness(await wf(SEQ));
    const dir = h.store.paths.attemptDir(h.run.runId, 'a', 1);
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ kind: 'text', ts: '2026-09-04T10:00:00.000Z', text: 'first attempt prose' }),
      'not json at all',
      JSON.stringify({ type: 'command', ts: '2026-09-04T10:00:01.000Z', command: 'npm test', tool: 'Bash' }),
      '',
    ];
    await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join(NL), 'utf8');
    const entries = await h.scheduler.attemptTranscript('a', 1);
    expect(entries.map((e) => e.kind)).toEqual(['text', 'command']);
    // An attempt that never wrote anything is empty rather than an error.
    expect(await h.scheduler.attemptTranscript('a', 9)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('pages the entries above the oldest one a view is showing', async () => {
    const h = harness(await wf(SEQ));
    const dir = h.store.paths.attemptDir(h.run.runId, 'a', 1);
    await fs.mkdir(dir, { recursive: true });
    const all = Array.from({ length: 6 }, (_, i) => ({ kind: 'text' as const, ts: new Date(Date.UTC(2026, 8, 4, 10, 0, i)).toISOString(), text: `line ${i}` }));
    await fs.writeFile(path.join(dir, 'events.jsonl'), `${all.map((e) => JSON.stringify(e)).join(NL)}${NL}`, 'utf8');

    const page = await h.scheduler.olderTranscript('a', 1, all[4], 2);
    expect(page.map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['line 2', 'line 3']);
    // The oldest entry of the file has nothing above it, and an attempt with no log has nothing at all.
    expect(await h.scheduler.olderTranscript('a', 1, all[0], 2)).toEqual([]);
    expect(await h.scheduler.olderTranscript('a', 9, all[4], 2)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('scheduler: transient API errors resume the session', () => {
  const API_500 = 'Claude reported an error: API Error: 500 Internal server error. This is a server-side issue, usually temporary';

  it('resumes the same session after a 500 without spending retry.attempts', async () => {
    const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'api_error', message: API_500 }, { kind: 'success' }]);
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retry:\n      transientDelay: 20ms\n    prompt: do it\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(runner.calls).toHaveLength(2);
    // attempt 1 ran fresh; attempt 2 continued the session reported by attempt 1
    expect(runner.calls[0]!.resumeSessionId).toBeUndefined();
    expect(runner.calls[1]!.resumeSessionId).toBe('s-1');
    expect(runner.calls[1]!.prompt).toContain('# Session Resumed');
    expect(runner.calls[1]!.prompt).toContain('API Error: 500');
    expect(runner.calls[1]!.prompt).not.toContain('# Previous Attempt');
    expect(runner.calls[1]!.prompt).not.toContain('# Task');
    const attempts = h.run.tasks.a!.attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(['api_error', 'success']);
    expect(attempts[1]!.resumedSessionId).toBe('s-1');
    expect(h.run.tasks.a!.resumeSessionId).toBeUndefined();
    const retrying = h.store.eventsOf('task.retrying');
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({ resumeSession: true, transient: true, delayMs: 20 });
    const failed = h.store.eventsOf('task.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: 'api_error', final: false });
  });

  it('backs off exponentially and gives up after retry.transientAttempts consecutive failures', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'api_error', message: API_500 });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retry:\n      transientAttempts: 2\n      transientDelay: 10ms\n      transientMaxDelay: 15ms\n    prompt: p\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    // first attempt + 2 transient recoveries, then the transient budget is spent and retry.attempts (0) applies
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.map((c) => c.resumeSessionId)).toEqual([undefined, 's-1', 's-2']);
    expect(h.store.eventsOf('task.retrying').map((e) => (e as { delayMs: number }).delayMs)).toEqual([10, 15]);
    expect(h.run.tasks.a!.state).toBe('failed');
    expect(h.run.tasks.a!.reason).toBe('api_error');
    expect(h.run.tasks.a!.message).toContain('API Error: 500');
  });

  it('after the transient budget is spent, retry.attempts still gets a fresh session with the failure injected', async () => {
    const runner = new MockRunner().when('a', [
      { kind: 'error', outcome: 'api_error', message: API_500 },
      { kind: 'error', outcome: 'api_error', message: API_500 },
      { kind: 'success' },
    ]);
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 1\n    retry:\n      transientAttempts: 1\n      transientDelay: 5ms\n    prompt: do it\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(runner.calls.map((c) => c.resumeSessionId)).toEqual([undefined, 's-1', undefined]);
    expect(runner.calls[2]!.prompt).toContain('# Previous Attempt');
    expect(runner.calls[2]!.prompt).toContain('# Task\n\ndo it');
    const retrying = h.store.eventsOf('task.retrying') as Array<{ transient?: boolean; resumeSession?: boolean }>;
    expect(retrying.map((e) => Boolean(e.transient))).toEqual([true, false]);
    expect(retrying.map((e) => Boolean(e.resumeSession))).toEqual([true, false]);
  });

  it('a real failure resets the transient streak so the next attempt has a full transient budget', async () => {
    const runner = new MockRunner().when('a', [
      { kind: 'error', outcome: 'api_error', message: API_500 },
      { kind: 'status', status: 'failed', error: 'tests red' },
      { kind: 'error', outcome: 'api_error', message: API_500 },
      { kind: 'success' },
    ]);
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retries: 1\n    retry:\n      transientAttempts: 1\n      transientDelay: 5ms\n    prompt: p\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('completed');
    expect(runner.calls.map((c) => c.resumeSessionId)).toEqual([undefined, 's-1', undefined, 's-3']);
    expect(h.run.tasks.a!.attempts.map((a) => a.outcome)).toEqual(['api_error', 'failed', 'api_error', 'success']);
  });

  it('starts a fresh session (with the failure injected) when resumeSession is off or sessions are not persisted', async () => {
    for (const yaml of [
      'name: t\ntasks:\n  - id: a\n    retry:\n      resumeSession: false\n      transientDelay: 5ms\n    prompt: do it\n',
      'name: t\nclaude:\n  sessionPersistence: false\ntasks:\n  - id: a\n    retry:\n      transientDelay: 5ms\n    prompt: do it\n',
    ]) {
      const runner = new MockRunner().when('a', [{ kind: 'error', outcome: 'api_error', message: API_500 }, { kind: 'success' }]);
      const h = harness(await wf(yaml), runner);
      const res = await h.scheduler.execute();
      expect(res.state).toBe('completed');
      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[1]!.resumeSessionId).toBeUndefined();
      expect(runner.calls[1]!.prompt).toContain('# Previous Attempt');
      expect(runner.calls[1]!.prompt).toContain('# Task\n\ndo it');
      expect(h.run.tasks.a!.attempts[1]!.resumedSessionId).toBeUndefined();
      expect(h.store.eventsOf('task.retrying')[0]).toMatchObject({ resumeSession: false, transient: true });
    }
  });

  it('transientAttempts: 0 disables recovery and treats the error like any crash', async () => {
    const runner = new MockRunner().when('a', { kind: 'error', outcome: 'api_error', message: API_500 });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retry:\n      transientAttempts: 0\n    prompt: p\n'), runner);
    const res = await h.scheduler.execute();
    expect(res.state).toBe('failed');
    expect(runner.calls).toHaveLength(1);
    expect(h.run.tasks.a!.reason).toBe('api_error');
  });

  it('does not resume a session once a stop was requested', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' });
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    retry:\n      transientDelay: 5ms\n    prompt: p\n'), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => runner.running.includes('a#1'));
    h.scheduler.requestStop('wait', 'signal');
    runner.complete('a', 1, { kind: 'error', outcome: 'api_error', message: API_500, usage: { sessionId: 's-1' } });
    const res = await execution;
    expect(runner.calls).toHaveLength(1);
    expect(h.run.tasks.a!.state).toBe('failed');
    expect(h.run.tasks.a!.reason).toBe('api_error');
    expect(h.store.eventsOf('task.retrying')).toHaveLength(0);
    expect(res.state).not.toBe('completed');
  });
});
