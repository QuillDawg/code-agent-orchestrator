/**
 * What a workspace on a run it does not own can do, and what it can only read (spec §2.1, §2.3, `[D37]`).
 *
 * The same table the ended state has (`ended.ts`), for the same reason: the Overview lists these, the key
 * handler runs them, the palette offers them and `?` documents them, and one table is the only way those
 * four can agree.
 *
 * There are three of them, and there are three because that is what crosses a process boundary. `approve`,
 * `reject` and `answer` are refused from disk until presence gating ships `[D3]`, so a pending question is
 * rendered as a fact about the run and not as something this window can settle — and the line that says so
 * names the terminal that can.
 */
import type { CapabilityToken, ResolvedTask, WorkflowRun } from 'code-agent-orchestrator-protocol';
import { sanitizeText } from '../../cli/color.js';
import type { ObserverControlKind } from '../../workflow/control/observer.js';
import type { KeyHelp } from './keys.js';

export interface ObserverAction {
  /** The key that sends it, as it is printed. Compared case-insensitively. */
  key: string;
  label: string;
  /** What the footer calls it, where the line is shared with the panel's keys and the global chords. */
  short: string;
  kind: ObserverControlKind;
  taskId?: string;
}

/** The task states a `restart` request can actually move; the owner rejects the rest with a sentence. */
const RESTARTABLE = new Set(['failed', 'blocked', 'cancelled', 'skipped']);

/**
 * The controls this window may offer for this run and this selection.
 *
 * Gated twice: by what the run advertises (§2.3 — a capability token this build has no control for is not a
 * control, and one the run never claimed is not offered) and by what the selected task could accept. An
 * offered control the owner is certain to reject is worse than an absent one: the operator presses it, reads
 * a refusal, and stops believing the panel.
 */
export function observerActions(run: WorkflowRun, selected: ResolvedTask | undefined, capabilities: readonly CapabilityToken[]): ObserverAction[] {
  const has = (token: CapabilityToken): boolean => capabilities.includes(token);
  const actions: ObserverAction[] = [];
  const running = run.state === 'running';
  if (has('stop') && running) actions.push({ key: 'S', label: 'Stop the run', short: 'stop the run', kind: 'stop' });
  if (has('kill') && running) actions.push({ key: 'K', label: 'Kill the run', short: 'kill the run', kind: 'kill' });
  if (has('restart') && selected && RESTARTABLE.has(run.tasks[selected.id]?.state ?? '')) {
    actions.push({ key: 'R', label: `Re-run ${selected.id}`, short: 're-run task', kind: 'restart', taskId: selected.id });
  }
  return actions;
}

/** The action a key press sends, or undefined when the key means something else. */
export function observerActionFor(actions: ObserverAction[], input: string): ObserverAction | undefined {
  return actions.find((a) => a.key.toLowerCase() === input.toLowerCase());
}

/**
 * The observer's keys as help rows, for `?`.
 *
 * `Ctrl+C` and `Q` are not here: `globalKeys('observing')` says what they do in this mode, and listing them
 * twice in one help panel is what let the "Anywhere" section go on claiming the owner's meanings for both.
 */
export function observerKeys(actions: ObserverAction[]): KeyHelp[] {
  return actions.map((action) => ({ keys: action.key, what: `${action.label} — sent to the owner as a request`, short: action.label }));
}

/** One task the owner is waiting on a human for, as this window may show it: read-only (§2.1). */
export interface PendingLine {
  taskId: string;
  what: string;
}

/**
 * The approvals and questions in the run right now.
 *
 * Read out of the run the poll last saw, which is `live.json` folded over `workflow.json` — the same pair
 * `cao status` reads — so this window and the owner's own screen name the same request.
 */
export function pendingLines(run: WorkflowRun): PendingLine[] {
  const out: PendingLine[] = [];
  for (const task of run.workflow.tasks) {
    const state = run.tasks[task.id];
    if (!state) continue;
    const pending = state.pendingInteraction;
    if (pending) out.push({ taskId: task.id, what: `${pending.kind}: ${sanitizeText(pending.title)}` });
    else if (state.state === 'awaiting_approval') out.push({ taskId: task.id, what: 'approval' });
  }
  return out;
}

/** Where the answer has to be typed. One sentence, because it is printed under every pending line. */
export function answerElsewhere(ownerPid: number | undefined): string {
  return ownerPid === undefined ? 'answer in the owning terminal' : `answer in the owning terminal (pid ${ownerPid})`;
}
