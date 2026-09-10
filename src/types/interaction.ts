/** A worker blocked on a human: a permission prompt or a question. Runner-agnostic. */
import type { AgentName } from './workflow.js';

export type InteractionKind = 'permission' | 'question';

export interface InteractionQuestion {
  /**
   * The runner's own id for this question, when it has one, so an answer can be routed back on the wire.
   * A dashboard keys its answers by `question` text; a runner that needs the id maps them itself.
   */
  id?: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface Interaction {
  /** Runner-side request id (Claude: control_request.request_id); unique per attempt. */
  id: string;
  kind: InteractionKind;
  taskId: string;
  attempt: number;
  agent: AgentName;
  /** 'Bash' | 'Edit' | 'Write' | 'AskUserQuestion' | ... */
  toolName: string;
  toolUseId?: string;
  /** Short human title, e.g. "Bash: npm publish". */
  title: string;
  description?: string;
  decisionReason?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllow?: boolean;
  /** Raw tool input, unmodified (the dashboard renders command / file_path / content). */
  input: Record<string, unknown>;
  /**
   * Permission only: the runner's own rule suggestions for "allow for the rest of this task", passed through
   * opaquely. Only set when the runner offered at least one rule scoped to this request; the orchestrator
   * never invents one, so an empty list means the choice is not offered.
   */
  suggestions?: unknown[];
  /** Question only. */
  questions?: InteractionQuestion[];
  requestedAt: string;
}

export type InteractionAnswer =
  | { kind: 'allow'; scope: 'once' | 'always' }
  | { kind: 'deny'; message: string }
  /** Question text -> chosen label(s) or free text; multi-select labels are comma-joined. */
  | { kind: 'answer'; answers: Record<string, string> };

/** `cancelled` = the worker withdrew the request; `stopped` = the operator stopped the run while it was open. */
export type InteractionAnswerSource = 'handler' | 'no_handler' | 'timeout' | 'cancelled' | 'stopped' | 'aborted';

/** Persisted summary of an interaction (on the attempt and, while pending, on the task). */
export interface InteractionRecord {
  id: string;
  kind: InteractionKind;
  toolName: string;
  title: string;
  requestedAt: string;
  answeredAt?: string;
  answer?: 'allow' | 'allow_always' | 'deny' | 'answer';
  source?: InteractionAnswerSource;
}

export function describeAnswer(answer: InteractionAnswer): NonNullable<InteractionRecord['answer']> {
  if (answer.kind === 'allow') return answer.scope === 'always' ? 'allow_always' : 'allow';
  return answer.kind;
}

/**
 * Whether "allow for the rest of this task" can be honoured. It needs a rule from the runner that is scoped
 * to this request; without one the only rule the orchestrator could send is a blanket allow for the whole
 * tool, which is not what the key offers, so the choice is withheld instead.
 */
export function canAllowAlways(interaction: Interaction): boolean {
  return !interaction.suppressAlwaysAllow && (interaction.suggestions?.length ?? 0) > 0;
}

/** The summary kept on the attempt, the task and the run event log; never carries the raw tool input. */
export function toInteractionRecord(interaction: Interaction): InteractionRecord {
  return { id: interaction.id, kind: interaction.kind, toolName: interaction.toolName, title: interaction.title, requestedAt: interaction.requestedAt };
}

/**
 * What every denied worker is told to do about it, appended to each deny message by the scheduler so the
 * instruction is written in one place rather than trusted to each dashboard, handler and timeout.
 *
 * It is addressed to the agent. An operator reading the same text back out of a paused task gets nothing
 * from it, so the surfaces that show them the question take it off again with `withoutWorkerInstructions`.
 */
export const NEEDS_INPUT_HINT = 'finish with status needs_input if you cannot continue';

/** Agent-facing boilerplate removed, for text on its way to an operator rather than to a worker. */
export function withoutWorkerInstructions(text: string): string {
  return text
    .split(NEEDS_INPUT_HINT)
    .join('')
    .replace(/[;,.\s]+$/, '')
    .trim();
}
