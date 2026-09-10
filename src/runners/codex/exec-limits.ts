/**
 * What `codex exec` does when the worker needs a human, and how CAO reports it.
 *
 * `codex exec` has no channel for approvals or questions: the CLI answers the request itself, with a
 * rejection, and that rejection arrives in the JSONL stream as an error. Without recognising it the attempt
 * ends as `invalid_result` or `crash` depending on the exit code, which tells the operator nothing about the
 * only thing that would fix it. Recognised, it ends as `needs_input` carrying what Codex wanted.
 *
 * The wording is codex-cli 0.154.0's, verified against the shipped binary:
 *   "command execution approval is not supported in exec mode for thread `<id>`"
 *   "exec command approval is not supported in exec mode for thread `<id>`"
 *   "file change approval is not supported in exec mode for thread `<id>`"
 *   "apply_patch approval is not supported in exec mode for thread `<id>`"
 *   "permissions approval is not supported in exec mode for thread `<id>`"
 *   "request_user_input is not supported in exec mode for thread `<id>`"
 * Rejections of things no human could answer either (auth token refresh, attestation, the current time,
 * dynamic tool calls) are deliberately *not* matched: they are capability gaps, not questions.
 */
import type { TaskResult } from 'code-agent-orchestrator-protocol';
import { truncate } from '../../util/misc.js';
import { sanitizeText } from '../../util/text.js';

export type CodexExecRequestKind = 'command' | 'fileChange' | 'permissions' | 'userInput';

/** Recorded once per Codex `exec` task, so a run log says up front that nobody can be asked anything. */
export const CODEX_EXEC_NO_HUMAN =
  'Codex transport "exec" cannot reach a human: the CLI rejects command approvals, file-change approvals and questions itself, so a task that needs one ends as needs_input. Use codex.transport: appServer (with codex.approvals: host, and codex.experimentalUserInput: true for questions) to answer during the run.';

/** The same statement, for `cao validate`, where the tasks that run on the transport are known statically. */
export function codexExecNoHumanNotice(taskIds: string[]): string {
  return `${taskIds.length === 1 ? `Task "${taskIds[0]}" runs` : `Tasks ${taskIds.map((id) => `"${id}"`).join(', ')} run`} on Codex transport "exec", which cannot reach a human: the CLI rejects command approvals, file-change approvals and questions itself, so such a task ends as needs_input rather than waiting for anyone. Use transport "appServer" (with approvals: host, and experimentalUserInput: true for questions) to answer during the run.`;
}

const SUBJECTS: Array<[RegExp, CodexExecRequestKind]> = [
  [/^(?:command execution|exec command) approval$/i, 'command'],
  [/^(?:file change|apply_patch) approval$/i, 'fileChange'],
  [/^permissions approval$/i, 'permissions'],
  [/^(?:request_user_input|mcpServer\/elicitation\/request)$/i, 'userInput'],
];

const LABELS: Record<CodexExecRequestKind, string> = {
  command: 'approval to run a command',
  fileChange: 'approval to change files',
  permissions: 'a permission decision',
  userInput: 'an answer to a question',
};

/**
 * The kind of human decision a Codex `exec` rejection was about, or undefined when the message is not one of
 * those rejections.
 */
export function codexExecHumanRequest(message: string): CodexExecRequestKind | undefined {
  const match = /^\s*(.+?)\s+(?:is|are)\s+not supported in exec mode\b/i.exec(message);
  if (!match) return undefined;
  const subject = match[1]!.trim();
  return SUBJECTS.find(([re]) => re.test(subject))?.[1];
}

export interface CodexExecBlock {
  kind: CodexExecRequestKind;
  /** The rejection exactly as Codex worded it. */
  message: string;
  /** What the worker was doing when it was rejected, when the stream said so (a command it had started). */
  wanted?: string;
}

const MAX_QUOTED = 300;

const quote = (text: string): string => `"${truncate(sanitizeText(text).trim().split(/\r?\n/)[0] ?? '', MAX_QUOTED)}"`;

/**
 * The attempt's result: what Codex wanted, that the transport is why nobody could answer, and the two
 * options that would have let someone.
 */
export function codexExecNeedsInput(block: CodexExecBlock, warnings: string[] = []): TaskResult {
  const wanted = block.wanted ? ` It was asking about ${quote(block.wanted)}.` : '';
  const summary = `Codex needed ${LABELS[block.kind]} and \`codex exec\` cannot ask for one`;
  const fix =
    block.kind === 'userInput'
      ? 'Set codex.transport: appServer with codex.experimentalUserInput: true to answer questions during the run'
      : 'Set codex.transport: appServer with codex.approvals: host to answer approvals during the run';
  return {
    status: 'needs_input',
    summary,
    error: `Codex needed ${LABELS[block.kind]}, and the \`exec\` transport has no channel for it, so the CLI rejected the request itself: ${quote(block.message)}.${wanted} ${fix}, or answer this task with \`cao resume --task <id> --input "…"\`.`,
    filesChanged: [],
    commits: [],
    decisions: [],
    warnings,
    followUp: [`${fix}.`],
    data: { blockedOn: block.kind === 'userInput' ? 'codexUserInput' : 'codexApproval' },
  };
}
