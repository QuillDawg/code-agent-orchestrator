import path from 'node:path';
import { createWriteStream } from 'node:fs';
import type { ProcessManager, ManagedProcess } from '../../execution/process-manager.js';
import type {
  CodexOptions,
  InteractionQuestion,
  RunnerUsage,
  TaskResult,
  TranscriptEntry,
} from 'code-agent-orchestrator-protocol';
import { asSentence, withoutWorkerInstructions } from '../../util/text.js';
import type { RunnerHooks, RunnerInput, RunnerOutcome } from '../task-runner.js';
import { splitCommand } from '../claude/detect.js';
import { CODEX_COMPLETION_CONTRACT } from '../contract.js';
import { agentTextEvents, completionTranscript } from '../completion-text.js';
import { codexFailureMetadata, codexProtocolRejection, normalizeCodexFailure } from './failure.js';
import { configErrorOutcome, killedMessage, openToolMessage, type ConfigRejection } from '../outcomes.js';
import { ensureDir } from '../../util/fs.js';
import { nowIso, truncate } from '../../util/misc.js';
import { codexExtraArgsSecurityConflict, resolveCodexPermissions } from './permissions.js';
import {
  REQUEST_DECLINED, REQUEST_UNSUPPORTED, approvalResponse, cancelResponse, interactionFromRequest,
  isAnswerableRequest, parseQuestions, quoteQuestions, userInputResponse,
} from './app-server-protocol.js';

export interface CodexAppServerOptions {
  processManager: ProcessManager;
  command: string;
  options: CodexOptions;
  bufferLines: number;
}

interface JsonObject extends Record<string, unknown> {
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: JsonObject;
  data?: JsonObject;
  code?: number;
  message?: string;
  sandbox?: JsonObject;
  type?: string;
  status?: string;
  name?: string;
  model?: string | null;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  instructionSources?: unknown[];
  thread?: JsonObject;
  turn?: JsonObject;
  item?: JsonObject;
  tokenUsage?: JsonObject;
  total?: JsonObject;
  last?: JsonObject;
  exitCode?: number;
  codexErrorInfo?: unknown;
}
const MAX_OUTPUT_CHARS = 2000;

/**
 * The app-server command line. The security envelope travels in the `thread/start` params rather than in
 * argv, so only the profile (a global flag) and raw passthrough appear here.
 */
export function buildCodexAppServerArgs(options: CodexOptions): string[] {
  const args: string[] = [];
  if (options.profile) args.push('--profile', options.profile);
  args.push('app-server', '--stdio');
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

function sandboxPolicy(mode: NonNullable<CodexOptions['sandbox']>, cwd: string, addDirs: string[]): JsonObject {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: [cwd, ...addDirs], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/**
 * A question CAO cannot put in front of a human. The request is declined through the protocol and the
 * worker gets to finish its own turn; only if it cannot does this become the attempt's result, quoting
 * what Codex asked instead of a fixed sentence.
 */
interface BlockedOnHuman {
  questions: InteractionQuestion[];
  /** What the worker was told when the request was declined. */
  reason: string;
  /** What the operator would have to change for the next run to be able to answer. */
  fix: string;
}

export function needsInputResult(blocked: BlockedOnHuman, warnings: string[] = []): TaskResult {
  const quoted = quoteQuestions(blocked.questions);
  const summary = `Codex asked ${quoted} and no one could answer it`;
  // `reason` is what the *worker* was told when its request was declined. On its way to an operator the
  // instruction addressed to the worker comes off, and what is left is punctuated as its own sentence -
  // without that, the reason and the fix run into each other as one unreadable line.
  const why = asSentence(withoutWorkerInstructions(blocked.reason));
  const error = [`Codex asked ${quoted}.`, why, `${blocked.fix}, or answer this task with \`cao resume --task <id> --input "…"\`.`].filter(Boolean).join(' ');
  return { status: 'needs_input', summary, error, filesChanged: [], commits: [], decisions: [], warnings, followUp: [`${blocked.fix}.`], data: { blockedOn: 'codexUserInput' } };
}

export async function runCodexAppServer(config: CodexAppServerOptions, input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome> {
  await ensureDir(input.attemptDir);
  const options = config.options;
  const unsafeExtraArg = codexExtraArgsSecurityConflict(options.extraArgs);
  if (unsafeExtraArg) return { kind: 'error', outcome: 'invalid_result', message: `Codex extraArgs cannot override security option "${unsafeExtraArg}"; use the validated codex permission fields` };
  const resolved = resolveCodexPermissions(options, Boolean(input.canInteract));
  if (resolved.host && !input.canInteract) {
    // The task asked for approvals a human answers and there is no human. That is a run waiting on one,
    // not a broken worker: failing the task here would hide the one thing that fixes it.
    const message =
      'This task sets codex.approvals: host, so every command and file change waits for a dashboard, and none is attached. Run it with the dashboard, or set codex.approvals: autoReview to let Codex review its own actions.';
    return { kind: 'result', result: { status: 'needs_input', summary: 'Codex host approvals need a dashboard, and none is attached', error: message, filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [message], data: { blockedOn: 'codexApproval' } }, exitCode: null };
  }
  if (options.configMode === 'isolated') {
    return { kind: 'error', outcome: 'invalid_result', message: 'Codex app-server cannot isolate ambient configuration while preserving saved authentication; use transport "exec" or configMode "inherit"' };
  }

  const { file, args: prefix } = splitCommand(config.command);
  const args = [...prefix, ...buildCodexAppServerArgs(options)];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key)) env[key] = value;
  Object.assign(env, input.env);

  const eventsLog = createWriteStream(path.join(input.attemptDir, 'events.jsonl'), { flags: 'a' });
  // A completion object the turn ends on is the attempt's outcome rather than a checkpoint before it, so
  // the last one is held back until the outcome has been decided below.
  const transcript = completionTranscript((value: TranscriptEntry): void => { eventsLog.write(`${JSON.stringify(value)}\n`); hooks.onTranscript(value); });
  const entry = transcript.entry;
  // A resumed attempt continues an earlier thread; without this its log reads like a fresh session.
  if (input.resumeSessionId) entry({ kind: 'system', ts: nowIso(), text: `resumed session ${input.resumeSessionId}` });
  const usage: RunnerUsage = { sessionId: input.resumeSessionId, model: input.task.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 0 };
  const pending = new Map<string, AbortController>();
  /** Commands the turn started and never completed; at exit they are what the worker was still inside. */
  const openCommands = new Map<string, string>();
  let proc: ManagedProcess;
  let threadId = input.resumeSessionId;
  let turnId: string | undefined;
  let finalText = '';
  let terminal: JsonObject | undefined;
  /**
   * A mismatch between what CAO asked for and what the server did with it. Every one of these is a
   * misconfiguration (or a CLI too old to honour the request), never something a retry can fix, so it is
   * carried as a rejection with the workflow key behind it rather than as a bare crash message.
   */
  let protocolError: ConfigRejection | undefined;
  let blocked: BlockedOnHuman | undefined;
  let killed: string | undefined;
  let nextId = 1;
  const initializeId = nextId++;
  let threadRequestId = 0;
  let turnRequestId = 0;
  const send = (value: JsonObject): boolean => proc.writeStdin(`${JSON.stringify(value)}\n`);
  const inflightRequests = new Map<number, { method: string; params: JsonObject; overloads: number }>();
  const request = (id: number, method: string, params: JsonObject): boolean => {
    inflightRequests.set(id, { method, params, overloads: inflightRequests.get(id)?.overloads ?? 0 });
    return send({ id, method, params });
  };
  const retryOverloaded = (message: JsonObject): boolean => {
    if (message.error?.code !== -32001 || typeof message.id !== 'number') return false;
    const pendingRequest = inflightRequests.get(message.id);
    if (!pendingRequest || pendingRequest.overloads >= 3) return false;
    pendingRequest.overloads += 1;
    const jitter = ((message.id as number) * 17 + pendingRequest.overloads * 13) % 25;
    const delay = Math.min(1000, 25 * (2 ** (pendingRequest.overloads - 1))) + jitter;
    hooks.onWarning?.(`Codex app-server queue overloaded; retrying ${pendingRequest.method} in ${delay}ms`);
    setTimeout(() => request(message.id as number, pendingRequest.method, pendingRequest.params), delay);
    return true;
  };

  /**
   * A question that cannot be answered is declined *through the protocol*: the worker keeps its turn and
   * whatever work is in it, and gets told what to do. Killing the process throws that work away, so it is
   * left to the last resort (and recorded when it happens).
   */
  const declineUserInput = (message: JsonObject, code: number, reason: string): void => {
    const questions = parseQuestions(message.params ?? {});
    const fix = options.experimentalUserInput
      ? 'Run this task with the dashboard attached to answer its questions during the run'
      : 'Set codex.experimentalUserInput: true (with codex.transport: appServer and a dashboard attached) to answer questions during the run';
    blocked ??= { questions, reason, fix };
    entry({ kind: 'question', ts: nowIso(), id: String(message.id), questions, answer: `declined: ${reason}` });
    hooks.onActivity(`? declined: ${quoteQuestions(questions)}`);
    hooks.onWarning?.(`Codex asked ${quoteQuestions(questions)}; ${asSentence(withoutWorkerInstructions(reason))}`);
    send({ id: message.id, error: { code, message: reason } });
  };

  const answerRequest = (message: JsonObject): void => {
    const id = String(message.id);
    const method = String(message.method ?? '');
    // Fail closed: an unknown request is never guessed at, and a permission-affecting one is never allowed.
    if (!isAnswerableRequest(method)) {
      entry({ kind: 'system', ts: nowIso(), text: `refused unsupported Codex request ${method}` });
      send({ id: message.id, error: { code: REQUEST_UNSUPPORTED, message: `${method} is not supported by CAO` } });
      return;
    }
    if (method === 'item/tool/requestUserInput' && !options.experimentalUserInput) {
      declineUserInput(message, REQUEST_UNSUPPORTED, 'This task runs with codex.experimentalUserInput disabled, so questions cannot be answered; finish with status needs_input if you cannot continue.');
      return;
    }
    const interaction = interactionFromRequest(id, method, message.params ?? {}, { taskId: input.task.id, attempt: input.attempt });
    const controller = new AbortController();
    pending.set(id, controller);
    const ts = nowIso();
    entry(interaction.kind === 'question' ? { kind: 'question', ts, id, questions: interaction.questions ?? [] } : { kind: 'permission', ts, id, tool: interaction.toolName, title: interaction.title });
    hooks.onActivity(`? ${interaction.title}`);
    hooks.onInteraction(interaction, controller.signal).then((answer) => {
      if (!pending.delete(id)) return;
      const done = nowIso();
      if (interaction.kind === 'question') {
        // A question the orchestrator denied has no answer to send: the protocol's only reply carries
        // answers, so it is declined the same way a disabled one is, and the worker is told why.
        if (answer.kind !== 'answer') {
          declineUserInput(message, REQUEST_DECLINED, answer.kind === 'deny' ? answer.message : 'the question was not answered');
          return;
        }
        send({ id: message.id, result: userInputResponse(interaction, answer) });
        entry({ kind: 'question', ts: done, id, questions: interaction.questions ?? [], answer: Object.values(answer.answers).join(' / ') });
        return;
      }
      send({ id: message.id, result: approvalResponse(interaction, answer) });
      entry({ kind: 'permission', ts: done, id, tool: interaction.toolName, title: interaction.title, decision: answer.kind === 'allow' ? 'allow' : 'deny', message: answer.kind === 'deny' ? answer.message : undefined });
    }, (error: unknown) => {
      if (!pending.delete(id)) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (interaction.kind === 'question') declineUserInput(message, REQUEST_DECLINED, `the orchestrator could not answer (${detail})`);
      else send({ id: message.id, result: cancelResponse() });
      entry({ kind: 'error', ts: nowIso(), text: `could not answer ${interaction.title}: ${detail}` });
    });
  };

  proc = config.processManager.spawn({
    taskId: input.task.id, attempt: input.attempt, command: file, args, cwd: input.cwd, env, timeoutMs: input.timeoutMs,
    stdin: 'keep-open', logDir: input.attemptDir, bufferLines: config.bufferLines,
    onStdoutLine: (line) => {
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; } catch { hooks.onOutput('stdout', line); return; }
      if (message.id !== undefined && message.method) { answerRequest(message); return; }
      if (retryOverloaded(message)) return;
      if (typeof message.id === 'number') inflightRequests.delete(message.id);
      if (message.id === initializeId) {
        if (message.error) {
          const detail = `initialize failed: ${String(message.error.message ?? JSON.stringify(message.error))}`;
          protocolError = codexProtocolRejection({ message: detail }) ?? { detail };
          void proc.kill('graceful');
          return;
        }
        send({ method: 'initialized' });
        threadRequestId = nextId++;
        const method = input.resumeSessionId ? 'thread/resume' : 'thread/start';
        const params = (input.resumeSessionId ? { threadId: input.resumeSessionId } : {
          cwd: input.cwd, model: input.task.model ?? null, approvalPolicy: resolved.approvalPolicy, approvalsReviewer: resolved.reviewer, sandbox: resolved.sandbox,
          developerInstructions: [CODEX_COMPLETION_CONTRACT.systemPrompt, input.systemPromptAddendum].filter(Boolean).join('\n\n'), ephemeral: false,
        }) as JsonObject;
        request(threadRequestId, method, params);
        return;
      }
      if (message.id === threadRequestId) {
        if (message.error) {
          const detail = `${input.resumeSessionId ? 'thread/resume' : 'thread/start'} failed: ${String(message.error.message ?? JSON.stringify(message.error))}`;
          protocolError = codexProtocolRejection({ message: detail, key: 'the codex: block of this task' }) ?? { detail };
          void proc.kill('graceful');
          return;
        }
        const result = message.result ?? {};
        const actualSandbox = String(result.sandbox?.type ?? '').replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`);
        const expectedSandbox = resolved.sandbox;
        if (!actualSandbox) {
          protocolError = { detail: 'the app-server did not report its resolved sandbox', key: 'codex.sandbox' };
          void proc.kill('graceful');
          return;
        }
        if (actualSandbox !== expectedSandbox) {
          protocolError = { detail: `the app-server resolved sandbox "${actualSandbox}", not the requested "${expectedSandbox}"`, key: 'codex.sandbox' };
          void proc.kill('graceful');
          return;
        }
        if (!result.approvalPolicy) {
          protocolError = { detail: 'the app-server did not report its resolved approval policy', key: 'codex.approvalPolicy' };
          void proc.kill('graceful');
          return;
        }
        if (result.approvalPolicy !== resolved.approvalPolicy) {
          protocolError = { detail: `the app-server resolved approval policy ${JSON.stringify(result.approvalPolicy)}, not the requested "${resolved.approvalPolicy}"`, key: 'codex.approvalPolicy' };
          void proc.kill('graceful');
          return;
        }
        if (!result.approvalsReviewer) {
          protocolError = { detail: 'the app-server did not report its resolved approval reviewer', key: 'codex.approvals' };
          void proc.kill('graceful');
          return;
        }
        if (result.approvalsReviewer !== resolved.reviewer) {
          protocolError = { detail: `the app-server resolved approval reviewer "${String(result.approvalsReviewer)}", not the requested "${resolved.reviewer}"`, key: 'codex.approvals' };
          void proc.kill('graceful');
          return;
        }
        if (input.task.model && result.model !== input.task.model) {
          protocolError = { detail: `the app-server resolved model "${String(result.model ?? 'unknown')}", not the requested "${input.task.model}"`, key: "the task's model" };
          void proc.kill('graceful');
          return;
        }
        if (!Array.isArray(result.instructionSources)) {
          protocolError = { detail: 'the app-server did not report its instruction sources', key: 'codex.configMode' };
          void proc.kill('graceful');
          return;
        }
        if (result.instructionSources.length) {
          entry({ kind: 'system', ts: nowIso(), text: `Codex loaded instructions from ${result.instructionSources.join(', ')}` });
        }
        threadId = typeof result.thread?.id === 'string' ? result.thread.id : input.resumeSessionId;
        usage.sessionId = threadId;
        usage.model = result.model ?? usage.model;
        hooks.onProcess({ pid: proc.pid, sessionId: threadId });
        entry({ kind: 'system', ts: nowIso(), text: `thread ${threadId ?? 'unknown'}${usage.model ? ` (${usage.model})` : ''}` });
        turnRequestId = nextId++;
        request(turnRequestId, 'turn/start', {
          threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], cwd: input.cwd,
          approvalPolicy: resolved.approvalPolicy, approvalsReviewer: resolved.reviewer,
          sandboxPolicy: sandboxPolicy(resolved.sandbox, input.cwd, options.addDirs ?? []), model: input.task.model ?? null,
          effort: input.task.effort && input.task.effort !== 'none' ? input.task.effort : null, outputSchema: CODEX_COMPLETION_CONTRACT.outputSchema,
        });
        return;
      }
      if (message.id === turnRequestId) {
        if (message.error) {
          const detail = `turn/start failed: ${String(message.error.message ?? JSON.stringify(message.error))}`;
          protocolError = codexProtocolRejection({ message: detail }) ?? { detail };
          void proc.kill('graceful');
          return;
        }
        turnId = typeof message.result?.turn?.id === 'string' ? message.result.turn.id : undefined;
        return;
      }
      const params = message.params ?? {};
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = params.item ?? {};
        if (item.type === 'commandExecution') {
          const commandId = String(item.id ?? item.command ?? 'command');
          if (message.method === 'item/started') {
            openCommands.set(commandId, String(item.command ?? ''));
            hooks.onActivity(`$ ${String(item.command ?? '').split(/\r?\n/)[0]}`);
            entry({ kind: 'command', ts: nowIso(), command: String(item.command ?? ''), tool: 'shell' });
          } else {
            openCommands.delete(commandId);
            if (item.aggregatedOutput || item.status === 'failed') entry({ kind: 'tool_result', ts: nowIso(), text: truncate(String(item.aggregatedOutput ?? `exit ${item.exitCode ?? '?'}`), MAX_OUTPUT_CHARS), isError: item.status === 'failed' || Number(item.exitCode ?? 0) > 0 });
          }
        } else if (item.type === 'agentMessage' && message.method === 'item/completed') {
          // The last agent message is still the authoritative result, decided once the turn completes; here a
          // completion object is only classified, so that no surface renders it as something the agent said.
          finalText = String(item.text ?? '');
          for (const produced of agentTextEvents(finalText, nowIso(), { activity: (text) => text.split(/\r?\n/)[0] ?? '', validate: CODEX_COMPLETION_CONTRACT.validate })) {
            hooks.onActivity(produced.activity);
            entry(produced.entry);
          }
        } else if (item.type === 'fileChange' && message.method === 'item/completed') {
          for (const change of Array.isArray(item.changes) ? item.changes : []) {
            const filePath = String(change.path ?? ''); if (!filePath) continue;
            const kind = String(change.kind ?? 'update').toLowerCase(); const op = kind.includes('delete') ? 'delete' : kind.includes('add') || kind.includes('create') ? 'write' : 'edit';
            hooks.onFileChange({ path: filePath, op }); entry({ kind: 'tool', ts: nowIso(), tool: 'fileChange', line: `${op} ${filePath}`, filePath, fileOp: op });
          }
        }
        return;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const token = params.tokenUsage ?? {}; const total = token.total ?? {};
        usage.inputTokens = Number(total.inputTokens ?? 0); usage.outputTokens = Number(total.outputTokens ?? 0); usage.cacheReadTokens = Number(total.cachedInputTokens ?? 0);
        usage.contextTokens = Number((token.last ?? total).inputTokens ?? 0) + Number((token.last ?? total).cachedInputTokens ?? 0);
        usage.contextWindow = typeof token.modelContextWindow === 'number' ? token.modelContextWindow : usage.contextWindow;
        hooks.onUsage({ ...usage }); return;
      }
      if (message.method === 'mcpServer/startupStatus/updated' && params.status === 'failed') {
        const text = `Codex MCP server "${String(params.name ?? 'unknown')}" failed to start${params.error ? `: ${String(params.error)}` : ''}`;
        hooks.onWarning?.(text); entry({ kind: 'error', ts: nowIso(), text }); return;
      }
      if (message.method === 'turn/completed') {
        terminal = params.turn ?? {}; usage.numTurns = (usage.numTurns ?? 0) + 1; hooks.onUsage({ ...usage }); proc.endStdin(); return;
      }
      if (message.method === 'error' || message.method === 'warning' || message.method === 'configWarning') {
        const text = String(params.message ?? params.error?.message ?? line); entry({ kind: message.method === 'error' ? 'error' : 'system', ts: nowIso(), text });
      }
    },
    onStderrLine: (line) => { hooks.onOutput('stderr', line); entry({ kind: 'stderr', ts: nowIso(), text: line }); },
  });
  hooks.onProcess({ pid: proc.pid, sessionId: threadId });
  request(initializeId, 'initialize', { clientInfo: { name: 'code-agent-orchestrator', title: 'CAO', version: '1' }, capabilities: { experimentalApi: Boolean(options.experimentalUserInput), requestAttestation: false } });
  const abort = (): void => { if (threadId && turnId) request(nextId++, 'turn/interrupt', { threadId, turnId }); killed = 'the orchestrator cancelled the run'; void proc.kill('graceful'); };
  input.signal.addEventListener('abort', abort, { once: true });
  const exit = await proc.exited;
  input.signal.removeEventListener('abort', abort);
  for (const controller of pending.values()) controller.abort(new Error('worker exited'));
  pending.clear();
  // A declined question is only the attempt's outcome when the worker could not finish its turn without an
  // answer. Whatever went wrong instead is kept as a warning, so the result says both what was asked and
  // what the turn did afterwards.
  const blockedOutcome = (why: string): RunnerOutcome => ({ kind: 'result', result: needsInputResult(blocked!, [why]), exitCode: exit.code, usage });
  let outcome: RunnerOutcome;
  if (input.signal.aborted) outcome = { kind: 'error', outcome: 'cancelled', message: 'cancelled by orchestrator', exitCode: exit.code, usage };
  else if (exit.timedOut) {
    const message = `timed out after ${input.timeoutMs}ms`;
    outcome = blocked ? blockedOutcome(`the turn was still running ${message} and the process had to be killed`) : { kind: 'error', outcome: 'timeout', message, exitCode: exit.code, usage };
  } else if (protocolError) outcome = configErrorOutcome('Codex app-server', protocolError, { exitCode: exit.code, signal: exit.signal, usage });
  else if (!terminal) {
    // The turn never completed. Whether the process was killed from outside or simply went away, the most
    // useful things the message can carry are the signal and the tool call the worker was still inside.
    const message = openCommands.size
      ? openToolMessage('Codex app-server', [...openCommands.values()])
      : `${killedMessage('Codex app-server', exit.code, exit.signal)} before the turn completed`;
    outcome = blocked ? blockedOutcome(message) : { kind: 'error', outcome: 'crash', message, exitCode: exit.code, signal: exit.signal, usage };
  } else if (terminal.status === 'failed') {
    const failure = normalizeCodexFailure(terminal.error?.codexErrorInfo, { ...codexFailureMetadata(terminal.error), sessionId: threadId });
    const message = String(terminal.error?.message ?? 'Codex turn failed');
    // A retryable transport failure is still worth retrying; anything else after a declined question is the
    // question, not a crash.
    outcome = blocked && !failure.retryable ? blockedOutcome(`the turn then failed: ${message}`) : { kind: 'error', outcome: failure.retryable ? 'api_error' : 'crash', message, exitCode: exit.code, usage, failure };
  } else if (terminal.status !== 'completed') {
    const message = `Codex turn ended with status ${String(terminal.status ?? 'unknown')}`;
    outcome = blocked ? blockedOutcome(message) : { kind: 'error', outcome: 'crash', message, exitCode: exit.code, usage, failure: { retryable: false, sessionId: threadId, partialWork: true } };
  } else {
    if (!finalText && Array.isArray(terminal.items)) {
      const finalMessage = [...terminal.items].reverse().find((item: JsonObject) => item?.type === 'agentMessage' && typeof item.text === 'string');
      if (finalMessage) finalText = finalMessage.text;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(finalText); } catch { parsed = undefined; }
    const valid = CODEX_COMPLETION_CONTRACT.validate(parsed);
    if (valid.ok) {
      // The worker finished its own turn after the decline: its result stands, and the question is a warning.
      if (blocked) hooks.onWarning?.(`Codex asked ${quoteQuestions(blocked.questions)} and finished the turn without an answer`);
      outcome = { kind: 'result', result: valid.result, exitCode: exit.code, usage, rawResultText: finalText };
    } else {
      outcome = blocked ? blockedOutcome(valid.error) : { kind: 'error', outcome: 'invalid_result', message: valid.error, exitCode: exit.code, usage };
    }
  }
  // Killing the app-server discards the turn and any work in it, so an attempt that ended that way says so.
  if (killed || (exit.timedOut && blocked)) entry({ kind: 'system', ts: nowIso(), text: `the Codex app-server process was killed: ${killed ?? `the turn was still running after ${input.timeoutMs}ms`}` });
  transcript.finish(outcome.kind === 'result'
    ? { kind: 'result', ts: nowIso(), status: outcome.result.status, summary: outcome.result.summary, isError: false, error: outcome.result.error }
    : { kind: 'error', ts: nowIso(), text: outcome.message });
  await new Promise<void>((resolve) => eventsLog.end(() => resolve()));
  return outcome;
}
