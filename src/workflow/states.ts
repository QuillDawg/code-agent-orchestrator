import { useUnicode } from '../util/glyphs.js';
import type { RunState, RunSummary, TaskState, WorkflowRun } from 'code-agent-orchestrator-protocol';

const RUNNING_EXITS: TaskState[] = ['success', 'failed', 'ready', 'blocked', 'skipped', 'needs_input', 'cancelled', 'pending', 'awaiting_approval', 'suspended'];

const TASK_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  // `failed` is reachable straight from `pending`: the per-run preflight fails a task before it can
  // ever become ready, and that verdict is as final as any other failure.
  pending: new Set(['ready', 'skipped', 'blocked', 'cancelled', 'awaiting_approval', 'failed']),
  ready: new Set(['running', 'pending', 'skipped', 'blocked', 'cancelled']),
  running: new Set([...RUNNING_EXITS, 'waiting']),
  // A worker blocked on a human keeps every exit `running` has (its process may still end) and returns to running.
  waiting: new Set([...RUNNING_EXITS, 'running']),
  awaiting_approval: new Set(['success', 'failed', 'cancelled', 'pending']),
  needs_input: new Set(['pending', 'ready', 'cancelled', 'failed']),
  // Every way out of a stopped task that a human might choose: continue it, start it over, give up on it.
  // Reached from `running` and from `waiting` alike, through `RUNNING_EXITS`, because a worker blocked on
  // a permission prompt is exactly as suspendable as one in the middle of a turn.
  suspended: new Set(['pending', 'ready', 'cancelled', 'failed', 'skipped', 'blocked']),
  success: new Set(['pending']),
  failed: new Set(['pending', 'ready']),
  blocked: new Set(['pending']),
  skipped: new Set(['pending']),
  cancelled: new Set(['pending']),
};

/**
 * Whether the run has not finished: something is executing it, or something should be.
 *
 * One predicate, because five places asked this question as `state === 'running'` and a held run answers
 * no to that while being every bit as live — it has an orchestrator, a heartbeat and a lock. The registry
 * was the one that mattered: a run held for ten minutes would have dropped out of `cao list`, out of the
 * launcher, and into the reaper's sights.
 */
export function isRunExecuting(run: { state: RunState; endedAt?: string }): boolean {
  if (run.endedAt) return false;
  return run.state === 'running' || run.state === 'created' || run.state === 'paused';
}

const RUN_TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
  created: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'interrupted', 'paused', 'cancelled']),
  // A held run is still `running` as far as the scheduler is concerned, but `finalize()` transitions out
  // of whatever state the run is in - and a run that was held when it was stopped is in this one.
  paused: new Set(['running', 'cancelled', 'completed', 'failed', 'interrupted']),
  completed: new Set(['running']),
  failed: new Set(['running']),
  interrupted: new Set(['running']),
  cancelled: new Set([]),
};

export function assertTaskTransition(from: TaskState, to: TaskState, taskId: string): void {
  if (from === to) return;
  if (!TASK_TRANSITIONS[from].has(to)) {
    throw new Error(`Illegal task state transition for "${taskId}": ${from} -> ${to}`);
  }
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (from === to) return;
  if (!RUN_TRANSITIONS[from].has(to)) {
    throw new Error(`Illegal run state transition: ${from} -> ${to}`);
  }
}

/**
 * One glyph per state, and no two states share one.
 *
 * `waiting` and `needs_input` both used `?`, which made them the same row on the one surface that has
 * room for the glyph and not the word - the sidebar - even though they are opposite halves of the same
 * story: `waiting` is a worker still running that someone can answer *now*, `needs_input` is an attempt
 * that has already ended holding the question, and only a resume will move it. `!` is the one that has
 * stopped.
 */
export const STATE_GLYPH: Record<TaskState, string> = {
  pending: '○',
  ready: '◌',
  running: '▶',
  waiting: '?',
  awaiting_approval: '⏸',
  // Not `⏸`, which `awaiting_approval` already owns: no two states may share a glyph, because the sidebar
  // has room for the mark and not the word.
  suspended: '⏹',
  needs_input: '!',
  success: '✓',
  failed: '✗',
  blocked: '⊘',
  skipped: '–',
  cancelled: '⨯',
};

/** One column each, so a state column keeps its width when the terminal cannot draw the glyphs above. */
const STATE_GLYPH_ASCII: Record<TaskState, string> = {
  pending: 'o',
  ready: '.',
  running: '>',
  waiting: '?',
  awaiting_approval: '=',
  suspended: 's',
  needs_input: '!',
  success: 'v',
  failed: 'x',
  blocked: '#',
  skipped: '-',
  cancelled: '~',
};

/** The glyph for a task state, in whichever alphabet this terminal can render. */
export function stateGlyph(state: TaskState): string {
  return (useUnicode() ? STATE_GLYPH : STATE_GLYPH_ASCII)[state];
}

export const STATE_LABEL: Record<TaskState, string> = {
  pending: 'Waiting',
  ready: 'Ready',
  running: 'Running',
  waiting: 'Needs you',
  awaiting_approval: 'Approval',
  suspended: 'Suspended',
  needs_input: 'Needs input',
  success: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** Ink / ANSI colour name per state, shared by every surface. */
export const STATE_COLOR: Record<TaskState, 'gray' | 'cyan' | 'yellow' | 'green' | 'red' | 'magenta'> = {
  pending: 'gray',
  ready: 'gray',
  running: 'cyan',
  waiting: 'yellow',
  awaiting_approval: 'yellow',
  // With `cancelled`: the family an operator stopped on purpose, rather than one that went wrong.
  suspended: 'magenta',
  needs_input: 'yellow',
  success: 'green',
  failed: 'red',
  blocked: 'red',
  skipped: 'gray',
  cancelled: 'magenta',
};

/** How many tasks of a run sit in each terminal state; anything not yet terminal counts as pending. */
export function summarize(run: WorkflowRun): RunSummary {
  const s: RunSummary = { total: 0, success: 0, failed: 0, blocked: 0, skipped: 0, cancelled: 0, pending: 0 };
  for (const t of Object.values(run.tasks)) {
    s.total++;
    switch (t.state) {
      case 'success':
        s.success++;
        break;
      case 'failed':
        s.failed++;
        break;
      case 'blocked':
        s.blocked++;
        break;
      case 'skipped':
        s.skipped++;
        break;
      case 'cancelled':
        s.cancelled++;
        break;
      default:
        s.pending++;
    }
  }
  return s;
}
