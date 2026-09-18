/**
 * Editing an unfinished task (spec §3.4, `[D19]`-`[D22]`, `[D27]`).
 *
 * The whole of "what an edit means" lives here, away from the scheduler that applies one and away from the
 * CLI that sends one, because three callers need exactly the same answers and none of them may give a
 * different one:
 *
 * - the run controller, inside the scheduler loop, for a live run;
 * - `cao task edit` with no owner, writing the revision straight into `workflow.json`;
 * - the TUI form, which validates what has been typed without sending anything at all.
 *
 * Two rules shape it. **What is edited is the resolved task** `[D19]`: `ResolvedTask.prompt` with defaults,
 * templates and `foreach` already applied, never the YAML behind it — the source file is never written by an
 * edit. And **validation comes before any side effect** (§3.4): the edited task is put through the same
 * validator `cao validate` prints, and only the diagnostics the *edit itself* introduced are held against
 * it, so a workflow that already warned about something else is not blamed on the operator changing a model.
 */
import type {
  AgentName,
  Effort,
  ResolvedTask,
  ResolvedWorkflow,
  TaskEdit,
  TaskEditField,
  TaskRevision,
  TaskRunState,
  TaskState,
  WorkflowRun,
} from 'code-agent-orchestrator-protocol';
import { ACTIVE_TASK_STATES, TASK_EDIT_FIELDS } from 'code-agent-orchestrator-protocol';
import type { Diagnostic } from '../../config/normalize.js';
import { validateWorkflow } from '../validator.js';
import { parseDuration } from '../../util/duration.js';
import { detectClaude } from '../../runners/claude/detect.js';
import { detectCodex } from '../../runners/codex/detect.js';
import { claudeCapabilityNeeds } from '../../runners/claude/preflight.js';
import { codexCapabilityNeeds } from '../../runners/codex/preflight.js';
import { runnerReadinessError } from '../../runners/preflight.js';

/** The agents a task may be moved to. Named rather than inferred, so the rejection can list them. */
export const EDITABLE_AGENTS: readonly AgentName[] = ['claude', 'codex'];

const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** `retry.attempts` accepts 0-20 in `src/config/schema.ts`; an edit accepts exactly the same range. */
export const MAX_RETRIES = 20;

/**
 * The states an edit may be applied to without stopping anything (§3.4). `running` and `waiting` are not
 * here: they are reachable only with `restart: true`, which is the caller saying so out loud.
 */
export const EDITABLE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'pending',
  'ready',
  'failed',
  'blocked',
  'cancelled',
  'needs_input',
]);

/** What one field of an edit changed, for the `TaskRevision` and for the ack. */
export type EditChanges = TaskRevision['changes'];

export interface EditPlan {
  /** The task as it would be after the edit; `applyEdit` copies these fields onto the live definition. */
  task: ResolvedTask;
  changes: EditChanges;
  /** The fields that really differ, in `TASK_EDIT_FIELDS` order — what the `task.edited` event carries. */
  fields: TaskEditField[];
  /** Validator warnings the edit introduced, in the words `cao validate` uses. */
  warnings: string[];
}

export type EditDecision = { ok: true; plan: EditPlan } | { ok: false; reason: string };

/** What a restart after an edit would do, which is not the same thing in every state. */
export type RestartPlan = 'cancelAndRestart' | 'restart' | 'notStarted' | 'paused';

// ---------------------------------------------------------------------------- parsing one edit

function unknownValue(field: string, value: unknown, allowed: readonly string[]): string {
  return `${field} "${String(value)}" is not one of ${allowed.join(', ')}.`;
}

/**
 * Turn the wire shape into the fields of a `ResolvedTask`, or into the sentence that says why it cannot be.
 *
 * Everything here is a *format* question — is this a duration, is this an effort level, is a budget being set
 * on a Codex task `[D20]`. Whether the result is a workflow that can run is `validateEditedTask`'s question,
 * and it is asked second because its messages are the ones `cao validate` already prints.
 */
export function planEdit(task: ResolvedTask, edit: TaskEdit): EditDecision {
  const named = TASK_EDIT_FIELDS.filter((field) => edit[field] !== undefined);
  if (named.length === 0) {
    return { ok: false, reason: `An edit has to name at least one of ${TASK_EDIT_FIELDS.join(', ')}, and this one names none.` };
  }

  const next: ResolvedTask = { ...task, retry: { ...task.retry }, claude: { ...task.claude }, codex: { ...task.codex } };
  const changes: EditChanges = {};
  const record = (field: TaskEditField, from: unknown, to: unknown): void => {
    if (from === to) return;
    changes[field] = { from, to };
  };

  if (edit.prompt !== undefined) {
    if (edit.prompt.trim() === '') return { ok: false, reason: 'The prompt cannot be empty; a worker needs something to do.' };
    record('prompt', task.prompt, edit.prompt);
    next.prompt = edit.prompt;
  }

  if (edit.agent !== undefined) {
    if (!(EDITABLE_AGENTS as readonly string[]).includes(edit.agent)) return { ok: false, reason: unknownValue('agent', edit.agent, EDITABLE_AGENTS) };
    record('agent', task.agent, edit.agent);
    next.agent = edit.agent as AgentName;
    // The runner is the agent for every task CAO ships; leaving it behind would launch the old CLI.
    next.runner = edit.agent;
  }

  if (edit.model !== undefined) {
    const model = edit.model.trim();
    if (model === '') return { ok: false, reason: 'The model cannot be empty; leave it out to keep the one the task has.' };
    record('model', task.model, model);
    next.model = model;
  }

  if (edit.effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(edit.effort)) return { ok: false, reason: unknownValue('effort', edit.effort, EFFORTS) };
    record('effort', task.effort, edit.effort);
    next.effort = edit.effort as Effort;
  }

  if (edit.timeout !== undefined) {
    let timeoutMs: number;
    try {
      timeoutMs = parseDuration(edit.timeout);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    if (timeoutMs <= 0) return { ok: false, reason: `Timeout "${edit.timeout}" is not a length of time a task can be given.` };
    record('timeout', task.timeoutMs, timeoutMs);
    next.timeoutMs = timeoutMs;
  }

  if (edit.retries !== undefined) {
    if (!Number.isInteger(edit.retries) || edit.retries < 0 || edit.retries > MAX_RETRIES) {
      return { ok: false, reason: `Retries must be a whole number between 0 and ${MAX_RETRIES}; "${String(edit.retries)}" is not.` };
    }
    record('retries', task.retry.attempts, edit.retries);
    next.retry.attempts = edit.retries;
  }

  if (edit.maxBudgetUsd !== undefined) {
    // [D20]: budget is `claude.maxBudgetUsd` and Claude only. The agent that counts is the edited one, so
    // moving a task to Claude and giving it a budget in one edit is allowed, and the reverse is not.
    if (next.agent !== 'claude') {
      return { ok: false, reason: `Codex has no budget flag, so "${task.id}" cannot be given one. Set a budget on a Claude task, or change the agent in the same edit.` };
    }
    if (!Number.isFinite(edit.maxBudgetUsd) || edit.maxBudgetUsd <= 0) {
      return { ok: false, reason: `A budget is an amount in US dollars above zero; "${String(edit.maxBudgetUsd)}" is not.` };
    }
    record('maxBudgetUsd', task.claude.maxBudgetUsd, edit.maxBudgetUsd);
    next.claude.maxBudgetUsd = edit.maxBudgetUsd;
  }

  const fields = TASK_EDIT_FIELDS.filter((field) => changes[field] !== undefined);
  return { ok: true, plan: { task: next, changes, fields, warnings: [] } };
}

// ---------------------------------------------------------------------------- the validator, on one task

export interface ValidateEditOptions {
  knownRunners?: string[];
  gitAvailable?: boolean;
}

const sameDiagnostic = (a: Diagnostic, b: Diagnostic): boolean => a.level === b.level && a.message === b.message && a.taskId === b.taskId;

/**
 * Put the edited task through the workflow validator and keep only what the edit introduced (§3.4).
 *
 * The whole workflow has to be revalidated — a task moved to another agent can break a rule three tasks away
 * — but a workflow that already warns about something is not the operator's problem right now, and an edit
 * refused because of a warning that was there before it is an edit nobody can make.
 */
export function validateEditedTask(workflow: ResolvedWorkflow, edited: ResolvedTask, opts: ValidateEditOptions = {}): { errors: string[]; warnings: string[] } {
  const options = { knownRunners: opts.knownRunners, gitAvailable: opts.gitAvailable ?? Boolean(workflow.gitRoot) };
  const before = validateWorkflow(workflow, [], options).diagnostics;
  const after = validateWorkflow({ ...workflow, tasks: workflow.tasks.map((t) => (t.id === edited.id ? edited : t)) }, [], options).diagnostics;
  const added = after.filter((d) => !before.some((b) => sameDiagnostic(b, d)));
  return {
    errors: added.filter((d) => d.level === 'error').map((d) => d.message),
    warnings: added.filter((d) => d.level === 'warning').map((d) => d.message),
  };
}

/**
 * Whether the CLI the edited task would launch is installed, authenticated, new enough and capable of what
 * the task asks for — the check `cao run` makes before the first token, for one task.
 *
 * Injectable everywhere it is used, so a test never shells out and a caller that already detected its agents
 * can answer from what it knows.
 */
export type AgentReadiness = (task: ResolvedTask) => Promise<string | undefined>;

export const detectAgentReadiness =
  (environment?: Record<string, string>): AgentReadiness =>
  async (task) => {
    if (task.agent === 'codex') {
      const needs = codexCapabilityNeeds(task.codex);
      const detection = await detectCodex(task.codex.command, environment);
      return runnerReadinessError({ ...detection, runner: 'codex', capabilityNeeds: needs, requiredCapabilities: needs.map((n) => n.capability) });
    }
    const needs = claudeCapabilityNeeds(task.claude);
    const detection = await detectClaude(task.claude.command, environment);
    return runnerReadinessError({ ...detection, runner: 'claude', capabilityNeeds: needs, requiredCapabilities: needs.map((n) => n.capability) });
  };

/**
 * Parse, validate and check the agent: everything that has to be true before anything is stopped (§3.4).
 *
 * The order is deliberate. Format first, because "1h3x is not a duration" is a better answer than a
 * validator message about a timeout of zero; the validator second, because its wording is the wording
 * `cao validate` prints; the agent last, because it is the only step that can touch a process.
 */
export async function decideEdit(
  workflow: ResolvedWorkflow,
  task: ResolvedTask,
  edit: TaskEdit,
  opts: ValidateEditOptions & { readiness?: AgentReadiness } = {},
): Promise<EditDecision> {
  const planned = planEdit(task, edit);
  if (!planned.ok) return planned;
  const { errors, warnings } = validateEditedTask(workflow, planned.plan.task, opts);
  if (errors.length) return { ok: false, reason: errors.join(' ') };
  // Only when the agent itself changed: the one the task already runs was checked before the run started,
  // and re-probing it on every prompt edit would put a CLI spawn in the scheduler loop for nothing.
  if (planned.plan.changes.agent && opts.readiness) {
    const unavailable = await opts.readiness(planned.plan.task);
    if (unavailable) return { ok: false, reason: `${unavailable}. "${task.id}" is left on ${task.agent}.` };
  }
  return { ok: true, plan: { ...planned.plan, warnings } };
}

// ---------------------------------------------------------------------------- may this task be edited at all

/** A dependent standing in the way of an edit, and the word for what it is doing (§3.4). */
export interface BlockingDependent {
  taskId: string;
  doing: string;
}

/**
 * The first transitive dependent that has already consumed this task's result, or is consuming it now.
 *
 * A dependent that never ran — skipped because an upstream failed, blocked, still pending — has taken
 * nothing from this task and is no reason to refuse. One that ran and *reported* `skipped` did read it, so
 * it counts: that is what "skipped after a success" means in §3.4.
 */
export function blockingDependent(run: WorkflowRun, dependents: Iterable<string>): BlockingDependent | undefined {
  for (const id of dependents) {
    const state = run.tasks[id];
    if (!state) continue;
    if (ACTIVE_TASK_STATES.has(state.state)) return { taskId: id, doing: state.state === 'waiting' ? 'waiting for you' : 'running' };
    if (state.state === 'success') return { taskId: id, doing: 'has already succeeded' };
    if (state.state === 'skipped' && state.attempts.some((a) => a.kind === 'task')) return { taskId: id, doing: 'has already run and skipped itself' };
  }
  return undefined;
}

/** The sentence a blocked edit ends with: how to get the revised task run without rewriting history. */
export function revisedRunHint(run: WorkflowRun, taskId: string): string {
  return `Start a revised run instead: "cao run ${run.configPath} --from ${taskId}".`;
}

/** Why an edit may not touch this task's dependents, or undefined when none of them is in the way. */
export function dependentRejection(run: WorkflowRun, taskId: string, dependents: Iterable<string>): string | undefined {
  const blocking = blockingDependent(run, dependents);
  if (!blocking) return undefined;
  return `"${taskId}" cannot be edited: "${blocking.taskId}" depends on it and ${blocking.doing}, so the work it did was based on this task as it is. ${revisedRunHint(run, taskId)}`;
}

/**
 * Why this task cannot be edited, or undefined when it can (§3.4, `[D27]`).
 *
 * `restart` is part of the question rather than a separate one: a running task is editable *only* as
 * stop-edit-restart, and an operator who did not ask for that is told so here rather than having their edit
 * quietly queued behind a worker that may run for another hour.
 */
export function editRejection(task: ResolvedTask, state: TaskRunState, restart: boolean): string | undefined {
  if (task.isApproval) {
    return `"${task.id}" is an approval gate: it has no prompt, model or agent to edit. Approve or reject it instead.`;
  }
  if (state.state === 'success') return `"${task.id}" has already succeeded, and a successful task is immutable. Add a task or start a new run.`;
  if (state.state === 'skipped') return `"${task.id}" was skipped and this run will not come back to it. Start a new run to have it do anything.`;
  if (ACTIVE_TASK_STATES.has(state.state)) {
    if (!restart) {
      return `"${task.id}" is ${state.state === 'waiting' ? 'waiting for you' : 'running'}, so editing it means stopping its worker first. Send the edit again with --restart (the workspace asks) to stop it, apply the edit and start it again.`;
    }
    return undefined;
  }
  if (!EDITABLE_TASK_STATES.has(state.state)) {
    return `"${task.id}" is ${state.state}, which is not a state an edit can be applied to.`;
  }
  return undefined;
}

/** What `--restart` would do to a task in this state; `notStarted` and `paused` restart nothing. */
export function restartPlanFor(state: TaskRunState): RestartPlan {
  if (ACTIVE_TASK_STATES.has(state.state)) return 'cancelAndRestart';
  if (state.state === 'pending' || state.state === 'ready') return 'notStarted';
  if (state.state === 'needs_input') return 'paused';
  return 'restart';
}

/**
 * The note an ack carries when applying the edit will throw away work (§3.4).
 *
 * `retry.resetWorkspace` puts the worktree back to its base commit before the next attempt, so anything the
 * worker wrote and did not commit is gone. Nothing is discarded silently: the CLI prints this, and the TUI
 * shows it before the edit is applied rather than after.
 */
export function resetWorkspaceNote(task: ResolvedTask, restarting: boolean): string | undefined {
  if (!restarting || !task.retry.resetWorkspace) return undefined;
  return `"${task.id}" has retry.resetWorkspace on, so uncommitted changes in its worktree will be reset before the next attempt.`;
}

// ---------------------------------------------------------------------------- writing the revision down

export interface AppendRevisionOptions {
  source: TaskRevision['source'];
  pid: number;
  at: string;
  note?: string;
}

/**
 * Copy the edited fields onto the live task definition and append the `TaskRevision` `[D21]`.
 *
 * The definition mutated here is the one inside `run.workflow`, which is what `workflow.json` persists and
 * what a resume re-reads — so an edit applied offline and an edit applied by a live run land in exactly the
 * same place, and the source YAML is untouched either way.
 */
export function applyEdit(task: ResolvedTask, state: TaskRunState, plan: EditPlan, opts: AppendRevisionOptions): TaskRevision {
  if (plan.changes.prompt) task.prompt = plan.task.prompt;
  if (plan.changes.agent) {
    task.agent = plan.task.agent;
    task.runner = plan.task.runner;
  }
  if (plan.changes.model) task.model = plan.task.model;
  if (plan.changes.effort) task.effort = plan.task.effort;
  if (plan.changes.timeout) task.timeoutMs = plan.task.timeoutMs;
  if (plan.changes.retries) task.retry.attempts = plan.task.retry.attempts;
  if (plan.changes.maxBudgetUsd) task.claude = { ...task.claude, maxBudgetUsd: plan.task.claude.maxBudgetUsd };

  const revisions = (state.revisions ??= []);
  const revision: TaskRevision = {
    number: revisions.length + 1,
    at: opts.at,
    source: opts.source,
    pid: opts.pid,
    changes: plan.changes,
    ...(opts.note ? { note: opts.note } : {}),
  };
  revisions.push(revision);
  return revision;
}

/**
 * Whether the next attempt of this task must start a fresh session `[D27]`.
 *
 * Derived rather than stored: the newest revision has no `appliedToAttempt` exactly while no attempt has
 * carried it, which is precisely the window in which resuming the old session would hand the worker the
 * prompt the operator has just replaced. It survives a resume, because it is read from `workflow.json`.
 */
export function editPendingOnTask(state: TaskRunState): boolean {
  const newest = state.revisions?.[state.revisions.length - 1];
  return newest !== undefined && newest.appliedToAttempt === undefined;
}

/**
 * Mark every revision this attempt is the first to carry, and return the revision it ran with (§2.6).
 *
 * Every unapplied revision is stamped, not only the newest: two edits before a single restart are both
 * carried by that attempt, and a reader who sees only the last one stamped cannot tell when the first landed.
 */
export function markRevisionsApplied(state: TaskRunState, attempt: number): number | undefined {
  const revisions = state.revisions ?? [];
  for (const revision of revisions) {
    if (revision.appliedToAttempt === undefined) revision.appliedToAttempt = attempt;
  }
  return revisions[revisions.length - 1]?.number;
}
