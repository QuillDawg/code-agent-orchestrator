/**
 * What can be done to a run that has ended (spec §2.4, [D36]), written down once.
 *
 * The Overview's ended block lists these, the key handler runs them, the command palette offers them and
 * `?` documents them. One table, because an action that a panel advertises and no key answers is worse than
 * an action nobody knew about: the operator presses it, nothing happens, and they stop trusting the footer.
 *
 * Which actions exist depends on the run and on the selected task, so the list is computed per frame rather
 * than being a constant: "Approve" on a task with no gate to approve would be a lie, and `cao resume
 * --approve` would reject it a second later anyway.
 */
import type { ResolvedTask, WorkflowRun } from 'code-agent-orchestrator-protocol';

/** An ended-state action. `answer` opens the field first; the rest resume the run straight away. */
export type EndedActionKind = 'resume' | 'task' | 'from' | 'answer' | 'approve' | 'reject';

export interface EndedAction {
  /** The key that runs it, as it is printed. Compared case-insensitively. */
  key: string;
  label: string;
  /**
   * What the footer calls it. The label names the task, which is what the Overview block and `?` want; the
   * footer shares one line with the panel's own keys and the chords, and three labels carrying the same
   * task id three times pushed "follow the transcript" off the end of it — on the one screen where reading
   * the logs is the next thing anybody does.
   */
  short: string;
  kind: EndedActionKind;
  /** The task it applies to; absent only for `resume`, which is about the whole run. */
  taskId?: string;
}

/**
 * The actions for this run and this selection, in the order the Overview lists them: the run first, then
 * the selected task, then whatever that task is waiting for.
 */
export function endedActions(run: WorkflowRun, selected: ResolvedTask | undefined): EndedAction[] {
  const actions: EndedAction[] = [{ key: 'S', label: 'Resume run', short: 'resume run', kind: 'resume' }];
  if (!selected) return actions;
  const state = run.tasks[selected.id]?.state;
  actions.push({ key: 'R', label: `Re-run ${selected.id}`, short: 're-run task', kind: 'task', taskId: selected.id });
  actions.push({ key: '>', label: `Resume from ${selected.id}`, short: 'resume from here', kind: 'from', taskId: selected.id });
  if (state === 'needs_input') actions.push({ key: 'A', label: `Answer ${selected.id} and resume`, short: 'answer', kind: 'answer', taskId: selected.id });
  if (state === 'awaiting_approval') {
    actions.push({ key: 'A', label: `Approve ${selected.id}`, short: 'approve', kind: 'approve', taskId: selected.id });
    actions.push({ key: 'X', label: `Reject ${selected.id}`, short: 'reject', kind: 'reject', taskId: selected.id });
  }
  return actions;
}

/** The action a key press runs, or undefined when the key means something else. */
export function endedActionFor(actions: EndedAction[], input: string): EndedAction | undefined {
  return actions.find((a) => a.key.toLowerCase() === input.toLowerCase());
}
