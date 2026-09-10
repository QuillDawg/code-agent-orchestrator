/**
 * The Codex app-server's server→client requests, mapped onto the runner-neutral `Interaction`, and answers
 * mapped back onto the wire. Pure functions, so the shapes can be tested without a process.
 *
 * Verified against the protocol bundle of codex-cli 0.154.0
 * (`codex app-server generate-json-schema --experimental`):
 *
 *  - `CommandExecutionRequestApprovalParams`: `command`, `cwd`, `reason`, `availableDecisions` and
 *    `proposedExecpolicyAmendment` (an array of *strings*, not an object).
 *    `CommandExecutionRequestApprovalResponse.decision` is `accept` | `acceptForSession` |
 *    `{acceptWithExecpolicyAmendment: {execpolicy_amendment: string[]}}` |
 *    `{applyNetworkPolicyAmendment: …}` | `decline` | `cancel`.
 *  - `FileChangeRequestApprovalParams`: `reason` and `grantRoot`. Its response has no amendment variant at
 *    all — `accept` | `acceptForSession` | `decline` | `cancel` — so a granted root is honoured by
 *    accepting for the session, which is what the field's own description asks for.
 *  - `ToolRequestUserInputParams`: `questions[]` of `{id, header, question, options?, isOther, isSecret}`,
 *    each option `{label, description}`. `ToolRequestUserInputResponse` is
 *    `{answers: {[question id]: {answers: string[]}}}` — keyed by the question's **id**, not its text.
 *
 * `decline` lets the agent carry on with the turn; `cancel` interrupts it. A refused request is not a
 * reason to throw a turn's work away, so a denial declines and only a failure to answer at all cancels.
 */
import type { Interaction, InteractionAnswer, InteractionQuestion } from 'code-agent-orchestrator-protocol';
import { nowIso, truncate } from '../../util/misc.js';
import { sanitizeText } from '../../util/text.js';

export type JsonRecord = Record<string, unknown>;

/** The three server requests CAO can answer. Everything else fails closed with -32601. */
export const CODEX_ANSWERABLE_REQUESTS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'] as const;
export type CodexAnswerableRequest = (typeof CODEX_ANSWERABLE_REQUESTS)[number];

export function isAnswerableRequest(method: string): method is CodexAnswerableRequest {
  return (CODEX_ANSWERABLE_REQUESTS as readonly string[]).includes(method);
}

/** JSON-RPC "method not found": this client genuinely does not implement the request. */
export const REQUEST_UNSUPPORTED = -32601;
/** JSON-RPC implementation-defined error: the request is understood, and refused. */
export const REQUEST_DECLINED = -32000;

/**
 * What the server said "allow for the rest of this task" would mean for one request. Carried opaquely in
 * `Interaction.suggestions`, which the orchestrator only ever counts (`canAllowAlways`).
 */
export type CodexAlwaysAllow = { kind: 'execpolicy'; amendment: string[] } | { kind: 'session' };

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/** Only offered when the server itself proposed one: CAO never invents a standing permission. */
function alwaysAllowFor(method: string, params: JsonRecord): CodexAlwaysAllow | undefined {
  if (method === 'item/commandExecution/requestApproval') {
    const amendment = stringList(params.proposedExecpolicyAmendment);
    if (amendment) return { kind: 'execpolicy', amendment };
    const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
    return available?.includes('acceptForSession') ? { kind: 'session' } : undefined;
  }
  // grantRoot: "allow writes under this root for the remainder of the session".
  return str(params.grantRoot) ? { kind: 'session' } : undefined;
}

export function alwaysAllowOf(interaction: Interaction): CodexAlwaysAllow | undefined {
  const first = interaction.suggestions?.[0];
  if (!first || typeof first !== 'object') return undefined;
  const kind = (first as { kind?: unknown }).kind;
  return kind === 'execpolicy' || kind === 'session' ? (first as CodexAlwaysAllow) : undefined;
}

/** The questions of a `item/tool/requestUserInput`, with the ids the answer has to be keyed by. */
export function parseQuestions(params: JsonRecord): InteractionQuestion[] {
  const raw = Array.isArray(params.questions) ? (params.questions as JsonRecord[]) : [];
  return raw.map((question, index) => ({
    id: str(question.id) ?? String(index),
    question: String(question.question ?? ''),
    header: str(question.header),
    // `options` is nullable: a question with none is a free-text prompt (`isOther`).
    options: (Array.isArray(question.options) ? (question.options as JsonRecord[]) : []).map((option) => ({
      label: String(option.label ?? ''),
      description: str(option.description),
    })),
    // The protocol has no multi-select: a question carries `options`, `isOther` and `isSecret`, and nothing
    // that says several may be chosen. One answer per question is what the server asks for.
    multiSelect: false,
  }));
}

export function interactionFromRequest(id: string, method: string, params: JsonRecord, ctx: { taskId: string; attempt: number }): Interaction {
  const base = { id, taskId: ctx.taskId, attempt: ctx.attempt, agent: 'codex' as const, input: params, requestedAt: nowIso() };
  if (method === 'item/tool/requestUserInput') {
    const questions = parseQuestions(params);
    const first = questions[0]?.question;
    const title = first ? (questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first) : 'Codex needs input';
    return { ...base, kind: 'question', toolName: 'requestUserInput', title, questions };
  }
  const isCommand = method === 'item/commandExecution/requestApproval';
  const command = str(params.command);
  const reason = str(params.reason);
  const always = alwaysAllowFor(method, params);
  const title = isCommand
    ? command
      ? `Command: ${command}`
      : (reason ?? 'Approve a command')
    : (reason ?? (str(params.grantRoot) ? `Approve writes under ${String(params.grantRoot)}` : 'Approve file changes'));
  return {
    ...base,
    kind: 'permission',
    toolName: isCommand ? 'command' : 'fileChange',
    title,
    description: reason,
    suggestions: always ? [always] : undefined,
    suppressAlwaysAllow: always ? undefined : true,
  };
}

/** The `result` payload for a command or file-change approval. */
export function approvalResponse(interaction: Interaction, answer: InteractionAnswer): JsonRecord {
  if (answer.kind === 'allow') {
    if (answer.scope !== 'always') return { decision: 'accept' };
    const always = alwaysAllowOf(interaction);
    if (always?.kind === 'execpolicy') return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: always.amendment } } };
    if (always?.kind === 'session') return { decision: 'acceptForSession' };
    // No standing permission was offered, so "always" is honoured as the allow-once it really is.
    return { decision: 'accept' };
  }
  return { decision: 'decline' };
}

/** Nobody could answer at all (the handler threw, the process is going away): stop the turn rather than guess. */
export function cancelResponse(): JsonRecord {
  return { decision: 'cancel' };
}

/**
 * The `result` payload for `item/tool/requestUserInput`. The dashboard keys its answers by question text;
 * the wire wants the server's own question ids, so they are mapped back here. A question nobody answered
 * is sent as an empty answer list rather than dropped, so the server still sees a reply for each one.
 */
export function userInputResponse(interaction: Interaction, answer: InteractionAnswer): JsonRecord {
  const byText = answer.kind === 'answer' ? answer.answers : {};
  const answers: JsonRecord = {};
  for (const [index, question] of (interaction.questions ?? []).entries()) {
    const value = byText[question.question];
    answers[question.id ?? String(index)] = { answers: value ? [value] : [] };
  }
  return { answers };
}

const MAX_QUOTED = 300;

/** One line quoting what Codex asked, safe to put in a result summary or on a terminal. */
export function quoteQuestions(questions: InteractionQuestion[]): string {
  const first = sanitizeText(questions[0]?.question ?? '').trim();
  const quoted = first ? `"${truncate(first, MAX_QUOTED)}"` : 'a question with no text';
  return questions.length > 1 ? `${quoted} (and ${questions.length - 1} more)` : quoted;
}
