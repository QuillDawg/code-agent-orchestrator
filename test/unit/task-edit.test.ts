/**
 * Editing an unfinished task (spec §3.4, §2.6, §5 rows 6-8; `[D19]`-`[D22]`, `[D27]`).
 *
 * The controller half drives a real `WorkflowScheduler` against the fakes, for the same reason
 * `controller.test.ts` does: what is under test is that the edit lands *inside* the loop, in the order §3.4
 * prescribes — validate, stop, record, restart — and an implementation that applied it on the side would
 * pass any test that only looked at the ack.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildWorkflow, makeRun, MemoryRunStore, MockRunner, MockWorkspace, tmpDir, waitFor, captureCli } from '../helpers/index.js';
import { WorkflowScheduler } from '../../src/workflow/scheduler.js';
import { WorkflowEventBus } from '../../src/events/event-bus.js';
import { RunnerRegistry } from '../../src/runners/task-runner.js';
import { createRunController, type RunController } from '../../src/workflow/control/controller.js';
import { controlEnvelope } from '../../src/workflow/control/commands.js';
import { commandForRequest, envelopeForRequest } from '../../src/workflow/control/commands.js';
import { controlRequest } from '../../src/persistence/requests.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { reconcileForResume } from '../../src/workflow/run-factory.js';
import { taskEditCommand } from '../../src/cli/commands/task-edit.js';
import { taskCommand } from '../../src/cli/commands/task.js';
import { durationText, draftEdit, initialDrafts, editDraftKey, validateDraft } from '../../src/tui/workspace/edit.js';
import { planEdit, editPendingOnTask, markRevisionsApplied } from '../../src/workflow/control/edit.js';
import { revisionRows } from '../../src/tui/history.js';
import type { ResolvedWorkflow, TaskEditField } from 'code-agent-orchestrator-protocol';

interface Harness {
  scheduler: WorkflowScheduler;
  controller: RunController;
  store: MemoryRunStore;
  runner: MockRunner;
  bus: WorkflowEventBus;
  run: ReturnType<typeof makeRun>;
}

/** Every agent is installed unless a case says otherwise; no test here may shell out to a real CLI. */
const installed = async (): Promise<undefined> => undefined;

function harness(workflow: ResolvedWorkflow, runner = new MockRunner(), extra: Partial<ConstructorParameters<typeof WorkflowScheduler>[0]> = {}): Harness {
  const run = extra.run ?? makeRun(workflow);
  const store = new MemoryRunStore();
  const workspace = new MockWorkspace(workflow.repositoryRoot);
  const bus = new WorkflowEventBus(run.runId);
  bus.onAny((e) => void store.appendEvent(e));
  // Both agents are registered, because `validateEditedTask` asks the registry which runners exist: an edit
  // that moves a task to Codex must be answered by the readiness check, not by "unknown runner".
  const runners = new RunnerRegistry().register(runner);
  if (runner.name !== 'codex') runners.register(new MockRunner('codex'));
  const scheduler = new WorkflowScheduler({ run, store, runners, workspace, bus, agentReadiness: installed, ...extra });
  return { scheduler, controller: createRunController({ scheduler }), store, runner, bus, run };
}

async function wf(yaml: string): Promise<ResolvedWorkflow> {
  // `buildWorkflow`'s own `knownRunners` is claude and mock, so a Codex workflow is "invalid" to it and
  // perfectly runnable here; the runner list the scheduler validates an edit against is the registry's.
  const { workflow, validation } = await buildWorkflow(yaml, { gitRoot: process.cwd() });
  const real = validation.diagnostics.filter((d) => d.level === 'error' && !d.message.includes('unknown runner'));
  if (real.length) throw new Error(real.map((d) => d.message).join('\n'));
  return workflow;
}

const tui = (expected?: { attempt?: number; revision?: number }) => controlEnvelope('tui', expected);

/** One task that hangs, plus a second that keeps the loop alive while the first is talked to. */
const PAIR = `
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    parallelGroup: g
    prompt: the original prompt
  - id: b
    parallelGroup: g
    prompt: p
`;

/**
 * `a` fails for good while `b` keeps the loop alive beside it, and nothing depends on either: a failed task
 * an edit may be aimed at, which a task with a running dependent is not.
 */
const FAILING_PAIR = `
name: t
execution:
  maxConcurrency: 2
tasks:
  - id: a
    parallelGroup: g
    retries: 0
    onFailure: continue
    prompt: the original prompt
  - id: b
    parallelGroup: g
    prompt: p
`;

/**
 * A dependency and its dependent, where the dependent runs even though `a` failed - which is exactly the
 * situation §3.4 refuses an edit in, because `b`'s work was based on `a` as it is.
 */
const CHAIN = `
name: t
tasks:
  - id: a
    prompt: the original prompt
    retries: 0
    onFailure: continue
  - id: b
    prompt: p
    dependsOn: [a]
    runIfDependencyFailed: true
`;

describe('what an edit may change (§3.4, [D20])', () => {
  it('parses each field and refuses what is not one', async () => {
    const workflow = await wf(PAIR);
    const task = workflow.tasks[0]!;

    expect(planEdit(task, {})).toMatchObject({ ok: false });
    expect((planEdit(task, { timeout: '1h3x' }) as { reason: string }).reason).toContain('Invalid duration');
    expect((planEdit(task, { retries: 21 }) as { reason: string }).reason).toContain('between 0 and 20');
    expect((planEdit(task, { retries: 1.5 }) as { reason: string }).reason).toContain('between 0 and 20');
    expect((planEdit(task, { effort: 'sideways' }) as { reason: string }).reason).toContain('not one of none, minimal');
    expect((planEdit(task, { agent: 'gemini' }) as { reason: string }).reason).toContain('not one of claude, codex');
    expect((planEdit(task, { prompt: '   ' }) as { reason: string }).reason).toContain('cannot be empty');
    expect((planEdit(task, { maxBudgetUsd: 0 }) as { reason: string }).reason).toContain('above zero');

    const ok = planEdit(task, { timeout: '90m', retries: 3, model: 'claude-opus-5' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.plan.fields).toEqual(['model', 'timeout', 'retries']);
    expect(ok.plan.task.timeoutMs).toBe(90 * 60_000);
    expect(ok.plan.task.retry.attempts).toBe(3);
    // The task itself is untouched until `applyEdit` is called: a plan is not a change.
    expect(task.model).toBeUndefined();
  });

  it('refuses a budget on Codex and allows one on a task the same edit moves to Claude [D20]', async () => {
    const codex = await wf('name: t\nagent: codex\ntasks:\n  - id: a\n    prompt: p\n');
    const task = codex.tasks[0]!;
    expect((planEdit(task, { maxBudgetUsd: 5 }) as { reason: string }).reason).toContain('Codex has no budget flag');
    const moved = planEdit(task, { agent: 'claude', maxBudgetUsd: 5 });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.plan.task.claude.maxBudgetUsd).toBe(5);
  });

  it('names only the fields that really differ, so an unchanged value is not a revision', async () => {
    const workflow = await wf(PAIR);
    const task = workflow.tasks[0]!;
    const same = planEdit(task, { prompt: task.prompt, retries: task.retry.attempts });
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.plan.fields).toEqual([]);
  });
});

describe('editing a running task (§5 row 6)', () => {
  it('validates before stopping, keeps the old attempt, starts a fresh session and records a revision', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running' && h.run.tasks.b!.state === 'running');
    const firstPrompt = h.store.prompts.get('a#1');
    const firstSession = h.run.tasks.a!.attempts[0]!.sessionId;
    expect(firstSession).toBeTruthy();

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'the revised prompt', retries: 2 }, restart: true }, tui());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('prompt, retries');
    expect(ack.reason).toContain('fresh session');

    await waitFor(() => h.run.tasks.a!.attempts.length === 2);
    const state = h.run.tasks.a!;

    // The old attempt is exactly as it was: its prompt.md, its session and its outcome all survive the edit.
    expect(h.store.prompts.get('a#1')).toBe(firstPrompt);
    expect(state.attempts[0]!.sessionId).toBe(firstSession);
    expect(state.attempts[0]!.outcome).toBe('cancelled');
    expect(state.attempts[0]!.revision).toBeUndefined();

    // The new one runs the revised prompt from a session of its own [D27].
    expect(h.store.prompts.get('a#2')).toContain('the revised prompt');
    expect(h.store.prompts.get('a#2')).not.toContain('the original prompt');
    expect(state.attempts[1]!.resumedSessionId).toBeUndefined();
    expect(state.attempts[1]!.sessionId).not.toBe(firstSession);
    expect(state.attempts[1]!.revision).toBe(1);

    // The revision says what changed and where it landed; the run log says only which fields (§2.6).
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions![0]).toMatchObject({ number: 1, source: 'tui', pid: process.pid, appliedToAttempt: 2 });
    expect(state.revisions![0]!.changes.prompt).toEqual({ from: 'the original prompt', to: 'the revised prompt' });
    expect(state.revisions![0]!.changes.retries).toMatchObject({ to: 2 });
    const edited = h.store.eventsOf('task.edited');
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ taskId: 'a', revision: 1, fields: ['prompt', 'retries'] });
    expect(JSON.stringify(edited[0])).not.toContain('revised prompt');
    // The task really carries the new configuration, not just a record of having been asked to.
    expect(h.run.workflow.tasks.find((t) => t.id === 'a')!.retry.attempts).toBe(2);
    // `b` was never touched: one task was edited, not the run.
    expect(h.run.tasks.b!.state).toBe('running');
    // What the run log says happened, which for an edit-and-restart is not "manually restarted from
    // dashboard": the operator edited a task and the run started it again to run the edit.
    const announced = h.store.eventsOf('workflow.warning').filter((e) => 'code' in e && e.code === 'restart');
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ taskId: 'a', message: 'task restarted to run the edit' });

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses an edit it cannot validate without stopping the worker', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');
    const attempts = h.runner.calls.length;

    const bad = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { timeout: 'whenever' }, restart: true }, tui());
    expect(bad.status).toBe('rejected');
    expect(bad.reason).toContain('Invalid duration');

    // The Codex CLI is not installed here, so moving the task to it is refused before anything is aborted.
    const missing = harness(await wf(PAIR), new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' }), {
      agentReadiness: async () => 'codex CLI not found (codex): no such file',
    });
    const missingRun = missing.scheduler.execute();
    await waitFor(() => missing.run.tasks.a!.state === 'running');
    const moved = await missing.controller.submit({ kind: 'edit', taskId: 'a', changes: { agent: 'codex' }, restart: true }, tui());
    expect(moved.status).toBe('rejected');
    expect(moved.reason).toContain('codex CLI not found');
    expect(moved.reason).toContain('is left on claude');
    expect(missing.run.tasks.a!.state).toBe('running');
    expect(missing.run.workflow.tasks.find((t) => t.id === 'a')!.agent).toBe('claude');
    await missing.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await missingRun;

    // Nothing stopped, nothing recorded, no second attempt.
    expect(h.run.tasks.a!.state).toBe('running');
    expect(h.run.tasks.a!.revisions).toBeUndefined();
    expect(h.runner.calls.length).toBe(attempts);
    expect(h.store.eventsOf('task.edited')).toHaveLength(0);

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses a running task an edit did not ask to restart, and says how to ask', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'x' }, restart: false }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('--restart');
    expect(h.run.tasks.a!.state).toBe('running');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('carries the warnings cao validate prints into the ack rather than refusing', async () => {
    const runner = new MockRunner().when('a', { kind: 'hang' }).when('b', { kind: 'hang' });
    const h = harness(await wf(PAIR), runner);
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    // Haiku has no effort levels: the validator warns and drops the level, it does not fail the workflow.
    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { model: 'claude-haiku-4-5', effort: 'high' }, restart: true }, tui());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('has no effort levels');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });
});

describe('what an edit is refused for (§5 row 8, [D27])', () => {
  it('refuses a task that has succeeded', async () => {
    const h = harness(await wf(CHAIN), new MockRunner().when('b', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'success');

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'x' }, restart: false }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('immutable');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses a task whose dependent is already running, and names the revised run', async () => {
    // `a` fails, so it is editable; `b` runs anyway, which is what makes the edit unsafe.
    const h = harness(await wf(CHAIN), new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.b!.state === 'running');

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'x' }, restart: false }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('"b" depends on it and running');
    expect(ack.reason).toContain('--from a');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses an approval gate, which has nothing to edit', async () => {
    // An operator is looking at the gate and has not answered yet: that is the state the edit is aimed at,
    // and a handler the test resolves is what holds the run in it until the ack is in hand.
    let answer: (decision: 'defer') => void = () => undefined;
    const h = harness(await wf('name: t\ntasks:\n  - id: gate\n    type: approval\n    prompt: ok?\n'), new MockRunner(), {
      approvalHandler: () => new Promise((resolve) => (answer = resolve)),
    });
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.gate!.state === 'awaiting_approval');

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'gate', changes: { prompt: 'x' }, restart: true }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('approval gate');

    answer('defer');
    await execution;
  });

  it('refuses a task whose work is merging back into the shared tree', async () => {
    const workspace = new MockWorkspace(process.cwd());
    workspace.conflictFor.add('a');
    // `a` succeeds, its worktree conflicts on merge-back, and the resolution session hangs. That window -
    // the attempt over, the shared tree half-merged - is exactly the one §3.4 refuses an edit in.
    const runner = new MockRunner().when('a', [{ kind: 'success' }, { kind: 'hang' }]);
    const h = harness(
      await wf('name: t\ngit:\n  enabled: true\nexecution:\n  workspaceStrategy:\n    sequential: worktree\ntasks:\n  - id: a\n    prompt: p\n'),
      runner,
      { workspace },
    );
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.attempts.some((x) => x.kind === 'merge'));

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'x' }, restart: true }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('merging its work back');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses a task this run has never heard of', async () => {
    const h = harness(await wf(CHAIN), new MockRunner().when('a', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');
    const ack = await h.controller.submit({ kind: 'edit', taskId: 'nope', changes: { prompt: 'x' }, restart: false }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('no task "nope"');
    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });
});

describe('duplicate, stale and second-process edits (§5 row 7)', () => {
  it('applies a resent edit once and answers it with the first ack', async () => {
    const h = harness(await wf(FAILING_PAIR), new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const envelope = tui();
    const first = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { retries: 4 }, restart: false }, envelope);
    const again = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { retries: 4 }, restart: false }, envelope);
    expect(first.status).toBe('applied');
    expect(again).toEqual(first);
    expect(h.run.tasks.a!.revisions).toHaveLength(1);
    expect(h.store.eventsOf('task.edited')).toHaveLength(1);

    // A second, different edit is a second revision, and `expected.revision` is what makes a stale one safe.
    const stale = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { retries: 5 }, restart: false }, tui({ revision: 0 }));
    expect(stale.status).toBe('rejected');
    expect(stale.reason).toBe('Task "a" is at revision 1, request expected 0.');
    const fresh = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { retries: 5 }, restart: false }, tui({ revision: 1 }));
    expect(fresh.status).toBe('applied');
    expect(h.run.tasks.a!.revisions).toHaveLength(2);
    expect(h.run.tasks.a!.revisions![1]!.number).toBe(2);

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('takes an edit from a request file exactly as it takes one from this process (§2.3)', async () => {
    const h = harness(await wf(FAILING_PAIR), new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const request = controlRequest('edit', { taskId: 'a', changes: { prompt: 'from another terminal' }, restart: true, source: 'cao-desktop 0.1.0' });
    const translated = commandForRequest(request);
    expect(translated).toMatchObject({ ok: true, command: { kind: 'edit', taskId: 'a', restart: true } });
    if (!translated.ok) return;
    const ack = await h.controller.submit(translated.command, envelopeForRequest(request));
    expect(ack.status).toBe('applied');
    expect(ack.id).toBe(request.id);
    expect(h.run.tasks.a!.revisions![0]!.source).toBe('inbox');
    await waitFor(() => h.run.tasks.a!.attempts.length === 2);
    expect(h.store.prompts.get('a#2')).toContain('from another terminal');

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses an edit once the run has ended, without losing the answer it already gave', async () => {
    const h = harness(await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n'));
    await h.scheduler.execute();
    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'x' }, restart: false }, tui());
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('This run has ended');
  });
});

describe('an edit that does not restart (§3.4)', () => {
  it('leaves a pending task pending and is carried by the attempt it eventually runs', async () => {
    const h = harness(await wf(CHAIN), new MockRunner().when('a', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'running');

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'b', changes: { prompt: 'b, revised' }, restart: false }, tui());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('has not started yet');
    expect(h.run.tasks.b!.state).toBe('pending');
    expect(h.run.tasks.b!.revisions![0]!.appliedToAttempt).toBeUndefined();
    expect(editPendingOnTask(h.run.tasks.b!)).toBe(true);

    h.runner.complete('a', 1, { kind: 'result', result: { status: 'success', summary: 'ok', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] }, exitCode: 0 });
    await execution;
    expect(h.store.prompts.get('b#1')).toContain('b, revised');
    expect(h.run.tasks.b!.attempts[0]!.revision).toBe(1);
    expect(h.run.tasks.b!.revisions![0]!.appliedToAttempt).toBe(1);
    expect(editPendingOnTask(h.run.tasks.b!)).toBe(false);
  });

  it('applies to a failed task and says how to run it again', async () => {
    const h = harness(await wf(FAILING_PAIR), new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');
    const before = h.run.tasks.a!.attempts.length;

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'try this instead' }, restart: false }, tui());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('cao task restart a');
    expect(h.run.tasks.a!.state).toBe('failed');
    expect(h.run.tasks.a!.attempts).toHaveLength(before);

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('answers an edit that changes nothing without recording a revision', async () => {
    const h = harness(await wf(FAILING_PAIR), new MockRunner().when('a', { kind: 'error', outcome: 'crash' }).when('b', { kind: 'hang' }));
    const execution = h.scheduler.execute();
    await waitFor(() => h.run.tasks.a!.state === 'failed');

    const ack = await h.controller.submit({ kind: 'edit', taskId: 'a', changes: { prompt: 'the original prompt' }, restart: false }, tui());
    expect(ack.status).toBe('applied');
    expect(ack.reason).toContain('already has those values');
    expect(h.run.tasks.a!.revisions).toBeUndefined();

    await h.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });
});

describe('an edit with no owner, and the resume that picks it up (§3.4)', () => {
  /** A run directory with one failed task, as an interrupted run leaves behind. */
  async function offlineRun(): Promise<{ repo: string; store: FileRunStore; runId: string }> {
    const repo = await tmpDir('cao-edit-offline-');
    const workflow = await buildWorkflow(CHAIN, { repositoryRoot: repo });
    const run = makeRun(workflow.workflow, '2026-09-18-001');
    run.state = 'failed';
    run.tasks.a!.state = 'failed';
    run.tasks.a!.attempts = [{ number: 1, kind: 'task', triggeredBy: 'initial', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: 'crash', cwd: repo, sessionId: 'old-session' }];
    const store = new FileRunStore(repo);
    await store.saveRun(run);
    return { repo, store, runId: run.runId };
  }

  it('writes the revision into workflow.json and says which resume applies it', async () => {
    const { repo, store, runId } = await offlineRun();
    const promptFile = path.join(repo, 'prompt.md');
    await fs.writeFile(promptFile, 'the offline prompt\n', 'utf8');

    const result = await captureCli(() => taskEditCommand([runId, 'a'], { repository: repo, promptFile, retries: 3 }));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('as revision 1: prompt, retries');
    expect(result.stdout).toContain(`cao resume ${runId}`);

    // The stored workflow is what a resume executes, so this is the edit taking effect (`startRuntime`).
    const saved = await store.loadRun(runId);
    expect(saved.workflow.tasks.find((t) => t.id === 'a')!.prompt).toBe('the offline prompt\n');
    expect(saved.workflow.tasks.find((t) => t.id === 'a')!.retry.attempts).toBe(3);
    expect(saved.tasks.a!.revisions![0]).toMatchObject({ number: 1, source: 'cli' });
    // And the run log records the summary, without the text (§2.6).
    const events = await fs.readFile(store.paths.eventsFile(runId), 'utf8');
    expect(events).toContain('"type":"task.edited"');
    expect(events).not.toContain('the offline prompt');

    // ...and the resume runs it from a fresh session, because no attempt has carried the edit yet [D27].
    // `reconcileForResume` is the step `cao resume --task a` takes before the scheduler is built.
    await reconcileForResume(saved, { selection: { only: ['a'] } });
    const resumed = harness(saved.workflow, new MockRunner().when('b', { kind: 'hang' }), { run: saved, isResume: true });
    const execution = resumed.scheduler.execute();
    await waitFor(() => resumed.run.tasks.a!.attempts.length === 2);
    expect(resumed.store.prompts.get('a#2')).toContain('the offline prompt');
    expect(resumed.run.tasks.a!.attempts[1]!.resumedSessionId).toBeUndefined();
    expect(resumed.run.tasks.a!.attempts[1]!.revision).toBe(1);
    await resumed.controller.submit({ kind: 'stop', mode: 'cancel' }, tui());
    await execution;
  });

  it('refuses --restart with no owner and names the resume instead', async () => {
    const { repo, runId } = await offlineRun();
    await expect(taskEditCommand([runId, 'a'], { repository: repo, prompt: 'x', restart: true })).rejects.toThrow(/no worker to restart/);
  });

  it('refuses an edit offline for the same reasons a live run does', async () => {
    const { repo, store, runId } = await offlineRun();
    const run = await store.loadRun(runId);
    run.tasks.a!.state = 'success';
    await store.saveRun(run);
    const refused = await captureCli(() => taskEditCommand([runId, 'a'], { repository: repo, prompt: 'x' }));
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain('immutable');
    expect((await store.loadRun(runId)).tasks.a!.revisions).toBeUndefined();
  });

  it('needs at least one field, and refuses two ways of saying the prompt', async () => {
    const { repo, runId } = await offlineRun();
    await expect(taskEditCommand([runId, 'a'], { repository: repo })).rejects.toThrow(/at least one of --prompt/);
    await expect(taskEditCommand([runId, 'a'], { repository: repo, prompt: 'x', promptFile: 'y' })).rejects.toThrow(/not both/);
  });

  it('prints the revision history under Attempts in cao task show', async () => {
    const { repo, store, runId } = await offlineRun();
    await captureCli(() => taskEditCommand([runId, 'a'], { repository: repo, prompt: 'the offline prompt', model: 'claude-opus-5' }));
    const shown = await captureCli(() => taskCommand([runId, 'a'], { repository: repo }));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Edits:');
    expect(shown.stdout).toMatch(/r1 {2}\d\d:\d\d:\d\d {2}cli {2}prompt, model {2}not run yet/);
    // Fields, never values: the prompt itself belongs to the attempt directory, not to a summary table.
    expect(shown.stdout.split('Edits:')[1]).not.toContain('the offline prompt');

    const rows = revisionRows((await store.loadRun(runId)).tasks.a!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.line).toContain('prompt, model');
  });
});

describe('the form the workspace opens (§3.4)', () => {
  it('round-trips every field, so an untouched Save sends nothing', async () => {
    const workflow = await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n    timeout: 90m\n    retries: 2\n    model: claude-opus-5\n    effort: high\n');
    const task = workflow.tasks[0]!;
    const drafts = initialDrafts(task);
    expect(drafts[editDraftKey('timeout')]).toBe('90m');
    expect(drafts[editDraftKey('retries')]).toBe('2');
    expect(draftEdit(task, drafts).edit).toEqual({});
    expect(validateDraft(workflow, task, drafts).fields).toEqual([]);
  });

  it('puts the validator message on the row that caused it, and the workflow message under the form', async () => {
    const workflow = await wf('name: t\ntasks:\n  - id: a\n    prompt: p\n');
    const task = workflow.tasks[0]!;
    const drafts = { ...initialDrafts(task), [editDraftKey('timeout')]: 'whenever', [editDraftKey('retries')]: 'lots' };
    const validation = validateDraft(workflow, task, drafts);
    expect(validation.errors.timeout).toContain('Invalid duration');
    expect(validation.errors.retries).toContain('whole number between 0 and 20');
    expect(validation.fields).toEqual([]);

    // A warning is not an error: Save is still offered, with the sentence `cao validate` prints.
    const warned = validateDraft(workflow, task, { ...initialDrafts(task), [editDraftKey('model')]: 'claude-haiku-4-5', [editDraftKey('effort')]: 'high' });
    expect(warned.errors).toEqual({});
    expect(warned.fields).toEqual(['model', 'effort'] satisfies TaskEditField[]);
    expect(warned.warnings.join(' ')).toContain('has no effort levels');
  });

  it('writes a timeout back in the grammar it accepts', () => {
    expect(durationText(90 * 60_000)).toBe('90m');
    expect(durationText(2 * 3_600_000)).toBe('2h');
    expect(durationText(45_000)).toBe('45s');
    expect(durationText(1500)).toBe('1500ms');
  });
});

describe('where a revision is carried (§2.6)', () => {
  it('stamps every revision an attempt is the first to run, not only the newest', () => {
    const state = {
      id: 'a',
      state: 'pending' as const,
      attempts: [],
      retryWindowStart: 1,
      revisions: [
        { number: 1, at: 'x', source: 'cli' as const, pid: 1, changes: {}, appliedToAttempt: 1 },
        { number: 2, at: 'x', source: 'cli' as const, pid: 1, changes: {} },
        { number: 3, at: 'x', source: 'cli' as const, pid: 1, changes: {} },
      ],
    };
    expect(markRevisionsApplied(state, 2)).toBe(3);
    expect(state.revisions.map((r) => r.appliedToAttempt)).toEqual([1, 2, 2]);
    expect(editPendingOnTask(state)).toBe(false);
  });
});
