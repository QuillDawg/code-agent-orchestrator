import { useUnicode } from '../util/glyphs.js';
import type { RunState, RunSummary, TaskState, WorkflowRun } from '../types/run.js';

const RUNNING_EXITS: TaskState[] = ['success', 'failed', 'ready', 'blocked', 'skipped', 'needs_input', 'cancelled', 'pending', 'awaiting_approval'];

const TASK_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  pending: new Set(['ready', 'skipped', 'blocked', 'cancelled', 'awaiting_approval']),
  ready: new Set(['running', 'pending', 'skipped', 'blocked', 'cancelled']),
  running: new Set([...RUNNING_EXITS, 'waiting']),
  // A worker blocked on a human keeps every exit `running` has (its process may still end) and returns to running.
  waiting: new Set([...RUNNING_EXITS, 'running']),
  awaiting_approval: new Set(['success', 'failed', 'cancelled', 'pending']),
  needs_input: new Set(['pending', 'ready', 'cancelled', 'failed']),
  success: new Set(['pending']),
  failed: new Set(['pending', 'ready']),
  blocked: new Set(['pending']),
  skipped: new Set(['pending']),
  cancelled: new Set(['pending']),
};

const RUN_TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
  created: new Set(['running', 'cancelled']),
  running: new Set(['completed', 'failed', 'interrupted', 'paused', 'cancelled']),
  paused: new Set(['running', 'cancelled']),
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

export const STATE_GLYPH: Record<TaskState, string> = {
  pending: '○',
  ready: '◌',
  running: '▶',
  waiting: '?',
  awaiting_approval: '⏸',
  needs_input: '?',
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
  needs_input: '?',
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
