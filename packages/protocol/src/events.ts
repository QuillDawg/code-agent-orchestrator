import type { AttemptOutcome, RunSummary, TaskReason, WorkspaceInfo } from './run.js';
import type { RunnerUsage, TaskResult } from './result.js';
import type { TranscriptEntry, FileOp } from './transcript.js';
import type { Interaction, InteractionAnswer, InteractionAnswerSource } from './interaction.js';

export interface EventMeta {
  seq: number;
  ts: string;
  runId: string;
}

export type WorkflowEventBody =
  | { type: 'workflow.started'; workflowName: string; taskCount: number }
  | { type: 'workflow.resumed'; resumeCount: number; rerun: string[] }
  | { type: 'workflow.warning'; code: string; message: string; taskId?: string }
  | { type: 'workflow.paused'; reason: 'approval' | 'needs_input'; taskIds: string[] }
  | { type: 'workflow.completed'; summary: RunSummary }
  | { type: 'workflow.failed'; summary: RunSummary }
  | { type: 'workflow.interrupted'; summary: RunSummary }
  | { type: 'task.ready'; taskId: string }
  | { type: 'task.started'; taskId: string; attempt: number; cwd: string; workspace?: WorkspaceInfo }
  | { type: 'task.process'; taskId: string; attempt: number; pid: number }
  | { type: 'task.activity'; taskId: string; attempt: number; line: string }
  | { type: 'task.output'; taskId: string; attempt: number; stream: 'stdout' | 'stderr'; line: string }
  /** One typed transcript entry from a worker (not persisted to the run event log; lives in the attempt's events.jsonl). */
  | { type: 'task.transcript'; taskId: string; attempt: number; entry: TranscriptEntry }
  /** Live usage snapshot for the current attempt (tokens, context size, cost). */
  | { type: 'task.usage'; taskId: string; attempt: number; usage: RunnerUsage }
  | { type: 'task.files'; taskId: string; attempt: number; path: string; op: FileOp; count: number }
  /** A worker is blocked on a human. In-process listeners get the whole request; the persisted run log keeps only its InteractionRecord summary, because `interaction.input` is raw file contents and shell commands. */
  | { type: 'task.interaction.requested'; taskId: string; attempt: number; interaction: Interaction }
  | { type: 'task.interaction.answered'; taskId: string; attempt: number; id: string; answer: InteractionAnswer; source: InteractionAnswerSource }
  | { type: 'task.completed'; taskId: string; attempt: number; result: TaskResult; workspace?: WorkspaceInfo }
  | {
      type: 'task.failed';
      taskId: string;
      attempt: number;
      outcome: AttemptOutcome;
      reason: TaskReason;
      message?: string;
      final: boolean;
    }
  | { type: 'task.retrying'; taskId: string; nextAttempt: number; delayMs: number; resumeSession?: boolean; transient?: boolean; nudge?: boolean }
  | { type: 'task.skipped'; taskId: string; reason: TaskReason; message?: string }
  | { type: 'task.blocked'; taskId: string; reason: TaskReason; by?: string; message?: string }
  | { type: 'task.cancelled'; taskId: string; attempt?: number; reason: TaskReason }
  | { type: 'task.awaiting_approval'; taskId: string; prompt: string }
  | { type: 'task.needs_input'; taskId: string; summary: string }
  | { type: 'task.merging'; taskId: string; branch: string; into: string }
  | { type: 'task.merged'; taskId: string; branch: string; into: string; sha: string }
  | { type: 'hook.started'; hook: string; command: string; taskId?: string }
  | { type: 'hook.finished'; hook: string; command: string; exitCode: number; taskId?: string };

export type WorkflowEvent = EventMeta & WorkflowEventBody;
export type WorkflowEventType = WorkflowEventBody['type'];
export type EventOf<T extends WorkflowEventType> = Extract<WorkflowEvent, { type: T }>;
