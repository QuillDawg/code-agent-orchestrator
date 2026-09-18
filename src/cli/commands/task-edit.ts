/**
 * `cao task edit [run] <task>` — change an unfinished task's prompt, agent, model, effort, timeout, retries
 * or budget (spec §3.4, `[D19]`-`[D22]`).
 *
 * The same three-way errand as `cao task stop|restart`: ask the process that owns the run, in this process
 * when it owns it, through `requests/` when another one does. Editing adds a fourth case the other two do
 * not have — **offline**. A stopped run still has a `workflow.json`, and that file is what a resume executes
 * (`startRuntime` loads the stored workflow, it does not re-read the YAML), so an edit with no owner is
 * written straight into it and picked up by the next `cao resume`. `--restart` is refused there, because
 * there is nothing running to restart and a resume is the thing that starts it.
 *
 * Whatever the route, the validation is the same one the scheduler runs (`src/workflow/control/edit.ts`):
 * the offline path must not be able to write a task into `workflow.json` that the run would then refuse.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskEdit } from 'code-agent-orchestrator-protocol';
import { openStore, resolveRunAndTask, readOrchestrator } from '../util.js';
import { ownershipOf } from '../ownership.js';
import { controlEnvelope } from '../../workflow/control/commands.js';
import { localController } from '../../workflow/control/local.js';
import { controlRequest, sendControlRequest, DEFAULT_ACK_WAIT_SECONDS } from '../../persistence/requests.js';
import { buildGraph } from '../../workflow/validator.js';
import {
  applyEdit,
  decideEdit,
  dependentRejection,
  detectAgentReadiness,
  editFieldList,
  editRejection,
  resetWorkspaceNote,
  restartPlanFor,
} from '../../workflow/control/edit.js';
import { UsageError } from '../../util/errors.js';
import { sanitizeText } from '../color.js';
import { mark, warnLine } from '../../util/marks.js';
import { nowIso } from '../../util/misc.js';

export interface TaskEditOptions {
  repository?: string;
  prompt?: string;
  promptFile?: string;
  agent?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  retries?: number;
  budget?: number;
  restart?: boolean;
  /** Seconds to wait for the owning process to answer. 0 returns as soon as the request is on disk. */
  wait?: number;
}

/** The fields the flags name, as the wire shape. Absent means "leave it alone", never "reset it" (§3.4). */
async function collectEdit(opts: TaskEditOptions): Promise<TaskEdit> {
  if (opts.prompt !== undefined && opts.promptFile !== undefined) {
    throw new UsageError('Use --prompt or --prompt-file, not both: they are two ways of saying the same thing.');
  }
  const edit: TaskEdit = {};
  if (opts.prompt !== undefined) edit.prompt = opts.prompt;
  if (opts.promptFile !== undefined) {
    const file = path.resolve(opts.promptFile);
    try {
      edit.prompt = await fs.readFile(file, 'utf8');
    } catch (err) {
      throw new UsageError(`Could not read the prompt from ${file}: ${(err as Error).message}`);
    }
  }
  if (opts.agent !== undefined) edit.agent = opts.agent;
  if (opts.model !== undefined) edit.model = opts.model;
  if (opts.effort !== undefined) edit.effort = opts.effort;
  if (opts.timeout !== undefined) edit.timeout = opts.timeout;
  if (opts.retries !== undefined) edit.retries = opts.retries;
  if (opts.budget !== undefined) edit.maxBudgetUsd = opts.budget;
  if (Object.keys(edit).length === 0) {
    throw new UsageError('An edit has to change something: give at least one of --prompt, --prompt-file, --agent, --model, --effort, --timeout, --retries or --budget.');
  }
  return edit;
}

export async function taskEditCommand(refs: string[], opts: TaskEditOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const changes = await collectEdit(opts);
  const restart = opts.restart === true;
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveRunAndTask(store, refs, 'cao task edit [run] <task>');
  const runId = run.runId;
  const ownership = ownershipOf(await readOrchestrator(store, runId));
  const here = ownership.kind === 'self' ? localController(runId) : undefined;

  if (here) {
    const ack = await here.submit({ kind: 'edit', taskId, changes, restart }, controlEnvelope('cli'));
    out(`edit ${taskId} (run ${runId}, this process): ${ack.status}${ack.reason ? ` ${sanitizeText(ack.reason)}` : ''}`);
    return ack.status === 'rejected' ? 2 : 0;
  }

  if (ownership.kind === 'owned') {
    const wait = opts.wait ?? DEFAULT_ACK_WAIT_SECONDS;
    const sent = await sendControlRequest(store.paths, runId, controlRequest('edit', { taskId, changes, restart }), { wait });
    out(`edit ${taskId} (run ${runId}) sent to pid ${ownership.pid}.`);
    if (!sent.ack) {
      out(warnLine(`No answer in ${wait}s. The request is still in requests/ and is applied when pid ${ownership.pid} reads it; "cao task ${taskId}" shows the result.`));
      return 0;
    }
    const reason = sent.ack.reason ? ` ${sanitizeText(sent.ack.reason)}` : '';
    out(`${mark(sent.ack.status === 'rejected' ? 'error' : 'ok')} ${sent.ack.status}${reason}`);
    return sent.ack.status === 'rejected' ? 2 : 0;
  }

  return offlineEdit();

  /**
   * Nobody is executing the run: the edit goes into `workflow.json` and waits there for the resume.
   *
   * Every gate the scheduler applies is applied here too, in the same order and with the same sentences. An
   * offline edit that skipped them would leave a run the next `cao resume` refuses to start, which is the
   * worst possible place to discover that a model name was wrong.
   */
  async function offlineEdit(): Promise<number> {
    if (restart) {
      throw new UsageError(`Nothing is executing run ${runId}, so there is no worker to restart. Apply the edit without --restart, then "cao resume ${runId} --task ${taskId}" runs it.`);
    }
    const state = run.tasks[taskId]!;
    const task = run.workflow.tasks.find((t) => t.id === taskId)!;
    const refusal = editRejection(task, state, false) ?? dependentRejection(run, taskId, buildGraph(run.workflow).descendants(taskId));
    if (refusal) {
      out(`${mark('error')} rejected ${sanitizeText(refusal)}`);
      return 2;
    }
    const decided = await decideEdit(run.workflow, task, changes, {
      knownRunners: ['claude', 'codex'],
      gitAvailable: Boolean(run.workflow.gitRoot),
      readiness: detectAgentReadiness(),
    });
    if (!decided.ok) {
      out(`${mark('error')} rejected ${sanitizeText(decided.reason)}`);
      return 2;
    }
    const plan = decided.plan;
    if (plan.fields.length === 0) {
      out(`${mark('ok')} "${taskId}" already has those values, so nothing was changed.`);
      return 0;
    }
    const note = [...plan.warnings, ...(resetWorkspaceNote(plan.task, restartPlanFor(state) !== 'notStarted') ? [resetWorkspaceNote(plan.task, true)!] : [])];
    const revision = applyEdit(task, state, plan, { source: 'cli', pid: process.pid, at: nowIso(), note: note.length ? note.join(' ') : undefined });
    // The same summary event a live run records (§2.6), so the run log tells the whole story whether the
    // edit was applied by an orchestrator or by this command with nobody at the wheel. Fields, never values.
    run.eventSeq += 1;
    await store
      .appendEvent({ seq: run.eventSeq, ts: nowIso(), runId, type: 'task.edited', taskId, revision: revision.number, fields: plan.fields })
      .catch(() => undefined);
    // The revision has to be on disk before the operator is told it landed; `saveRun` writes atomically, so
    // a crash here leaves either the run as it was or the run with the whole edit in it.
    await store.saveRun(run);
    out(`${mark('ok')} edited "${taskId}" as revision ${revision.number}: ${editFieldList(plan.fields)}.`);
    for (const line of note) out(warnLine(sanitizeText(line)));
    out(`Nothing is executing run ${runId}. Run "cao resume ${runId}" to carry on with the edit, or "cao resume ${runId} --task ${taskId}" to run just this task.`);
    return 0;
  }
}
