/**
 * Wire protocol for interactive `claude -p --input-format stream-json` sessions: the host writes the prompt
 * as a user message, keeps stdin open, and answers `control_request` / `can_use_tool` lines (permission
 * prompts and AskUserQuestion) with `control_response` lines. Pure functions plus a settle-once tracker.
 */
import type { Interaction, InteractionAnswer, InteractionQuestion } from '../../types/interaction.js';
import type { AgentName } from '../../types/workflow.js';
import { describeToolUse } from './event-parser.js';
import { nowIso } from '../../util/misc.js';

export const ASK_USER_QUESTION = 'AskUserQuestion';

/** The prompt, framed as the first user turn. */
export function encodeUserMessage(prompt: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' })}\n`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parseQuestions(input: Record<string, unknown>): InteractionQuestion[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  return raw.map((q) => ({
    question: str(q.question) ?? '',
    header: str(q.header),
    options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []).map((o) => ({ label: str(o.label) ?? '', description: str(o.description) })),
    multiSelect: Boolean(q.multiSelect),
  }));
}

/** Build the runner-agnostic Interaction from a `can_use_tool` request. */
export function toInteraction(requestId: string, request: Record<string, unknown>, ctx: { taskId: string; attempt: number; agent: AgentName }): Interaction {
  const toolName = str(request.tool_name) ?? 'tool';
  const input = (request.input && typeof request.input === 'object' ? request.input : {}) as Record<string, unknown>;
  const isQuestion = toolName === ASK_USER_QUESTION;
  const interaction: Interaction = {
    id: requestId,
    kind: isQuestion ? 'question' : 'permission',
    taskId: ctx.taskId,
    attempt: ctx.attempt,
    agent: ctx.agent,
    toolName,
    toolUseId: str(request.tool_use_id),
    title: str(request.title) ?? describeToolUse(toolName, input),
    description: str(request.description),
    decisionReason: str(request.decision_reason),
    defaultToNo: request.default_to_no === true ? true : undefined,
    suppressAlwaysAllow: request.suppress_always_allow_rule === true ? true : undefined,
    input,
    requestedAt: nowIso(),
  };
  if (isQuestion) interaction.questions = parseQuestions(input);
  else {
    const rules = addRuleSuggestions(request.permission_suggestions);
    if (rules.length) interaction.suggestions = rules;
  }
  return interaction;
}

/** The CLI's `addRules` suggestions; anything else it proposes (mode changes, directories) is not a rule we can reuse. */
function addRuleSuggestions(suggestions: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && (s as Record<string, unknown>).type === 'addRules');
}

/**
 * Rules for "allow for the rest of this task": the CLI's own suggestions, forced to `session` so nothing is
 * written to a settings file. When the CLI suggested nothing there is no scoped rule to send — the
 * orchestrator does not fall back to allowing the whole tool, because the operator only approved this
 * request. The answer then behaves as "allow once" and the dashboard does not offer the key at all.
 */
export function sessionRules(interaction: Interaction): unknown[] {
  return addRuleSuggestions(interaction.suggestions).map((s) => ({ ...s, destination: 'session' }));
}

/** The `response` payload (PermissionResult) for an answer. */
export function permissionResult(interaction: Interaction, answer: InteractionAnswer): Record<string, unknown> {
  switch (answer.kind) {
    case 'allow': {
      const rules = answer.scope === 'always' ? sessionRules(interaction) : [];
      return rules.length ? { behavior: 'allow', updatedPermissions: rules } : { behavior: 'allow' };
    }
    case 'deny':
      return { behavior: 'deny', message: answer.message };
    case 'answer':
      return { behavior: 'allow', updatedInput: { ...interaction.input, answers: answer.answers } };
  }
}

export function encodeControlResponse(interaction: Interaction, answer: InteractionAnswer): string {
  return `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: interaction.id, response: permissionResult(interaction, answer) } })}\n`;
}

export function encodeErrorResponse(requestId: string, error: string): string {
  return `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })}\n`;
}

/** One-line summary of a question answer for transcripts. */
export function summarizeAnswer(answer: InteractionAnswer): string {
  if (answer.kind === 'answer') return Object.values(answer.answers).join(' / ');
  if (answer.kind === 'allow') return answer.scope === 'always' ? 'allowed (always)' : 'allowed';
  return `denied: ${answer.message}`;
}

/** Tracks in-flight requests so each settles exactly once across answer, cancel, abort and process exit. */
export class PendingInteractions {
  private readonly open_ = new Map<string, AbortController>();

  open(id: string): AbortSignal {
    const controller = new AbortController();
    this.open_.set(id, controller);
    return controller.signal;
  }

  /** True when the request was still open (the caller may write its answer); closes it. */
  settle(id: string): boolean {
    return this.open_.delete(id);
  }

  /** The worker withdrew the request: abort the waiting handler and drop it. */
  cancel(id: string, reason: string): void {
    const c = this.open_.get(id);
    if (!c) return;
    this.open_.delete(id);
    c.abort(new Error(reason));
  }

  /** Abort every open request; each waiting handler settles through its own abort signal. */
  abortAll(reason: string): void {
    for (const [, c] of this.open_) c.abort(new Error(reason));
    this.open_.clear();
  }

  get size(): number {
    return this.open_.size;
  }
}
