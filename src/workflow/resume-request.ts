/**
 * What an ended run can be asked to do next (spec §2.4, [D36]).
 *
 * These are not control commands: a control command is applied by a live scheduler, and by the time these
 * are offered there is none — the run has finalized and let go of its lock. Each of them is a `cao resume`
 * with different arguments, which is exactly how the workspace runs them (`startRuntime`), so there is one
 * resume path and not two.
 *
 * The type lives here, next to `reconcileForResume`, rather than in the CLI or the TUI: both of those call
 * it, and neither should have to import the other to name what it is asking for.
 */

export type ResumeRequest =
  /** `cao resume`: failed, blocked and cancelled tasks return to pending. */
  | { kind: 'resume' }
  /** `cao resume --task <id>`: re-run one task. */
  | { kind: 'task'; taskId: string }
  /** `cao resume --from <id>`: re-run one task and everything downstream. */
  | { kind: 'from'; taskId: string }
  /** `cao resume --task <id> --input <text>`: answer a task in `needs_input` and carry on. */
  | { kind: 'answer'; taskId: string; text: string }
  /** The composer on an ended run (§3.5): carry a follow-up into the task's next attempt. */
  | { kind: 'followUp'; taskId: string; text: string; freshSession?: boolean }
  /** `cao resume --approve <id>` / `--reject <id>`: settle a paused approval gate. */
  | { kind: 'approve'; taskId: string }
  | { kind: 'reject'; taskId: string };

/** What the request is called on screen, in the words [D36] uses. */
export function resumeRequestLabel(request: ResumeRequest): string {
  switch (request.kind) {
    case 'resume':
      return 'Resume run';
    case 'task':
      return `Re-run ${request.taskId}`;
    case 'from':
      return `Resume from ${request.taskId}`;
    case 'answer':
      return `Answer ${request.taskId} and resume`;
    case 'followUp':
      return `Continue ${request.taskId} with your message`;
    case 'approve':
      return `Approve ${request.taskId}`;
    case 'reject':
      return `Reject ${request.taskId}`;
  }
}

/**
 * The `cao resume` arguments that do the same thing, for the notice that says what was started and for the
 * documentation. The answer text is left out: it is the operator's prose, not a command line.
 */
export function resumeRequestArguments(request: ResumeRequest): string[] {
  switch (request.kind) {
    case 'resume':
      return [];
    case 'task':
      return ['--task', request.taskId];
    case 'from':
      return ['--from', request.taskId];
    case 'answer':
      return ['--task', request.taskId, '--input', '<your answer>'];
    case 'followUp':
      return ['task', 'prompt', request.taskId, '--message', '<your message>', ...(request.freshSession ? ['--fresh-session'] : [])];
    case 'approve':
      return ['--approve', request.taskId];
    case 'reject':
      return ['--reject', request.taskId];
  }
}
