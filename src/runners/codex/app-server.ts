import path from 'node:path';
import { createWriteStream } from 'node:fs';
import type { ProcessManager, ManagedProcess } from '../../execution/process-manager.js';
import type { CodexOptions } from '../../types/workflow.js';
import type { Interaction, InteractionAnswer, InteractionQuestion } from '../../types/interaction.js';
import type { RunnerHooks, RunnerInput, RunnerOutcome } from '../task-runner.js';
import type { RunnerUsage, TaskResult } from '../../types/result.js';
import type { TranscriptEntry } from '../../types/transcript.js';
import { splitCommand } from '../claude/detect.js';
import { CODEX_COMPLETION_CONTRACT } from '../claude/contract.js';
import { agentTextEvents } from '../claude/completion-text.js';
import { codexFailureMetadata, normalizeCodexFailure } from './failure.js';
import { ensureDir } from '../../util/fs.js';
import { nowIso, truncate } from '../../util/misc.js';
import { codexExtraArgsSecurityConflict, resolveCodexPermissions } from './permissions.js';

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

function interactionFromRequest(id: string, method: string, params: JsonObject, input: RunnerInput): Interaction {
  if (method === 'item/tool/requestUserInput') {
    const questions: InteractionQuestion[] = (Array.isArray(params.questions) ? params.questions : []).map((question: JsonObject) => ({
      question: String(question.question ?? ''), header: typeof question.header === 'string' ? question.header : undefined,
      options: (Array.isArray(question.options) ? question.options : []).map((option: JsonObject) => ({ label: String(option.label ?? ''), description: typeof option.description === 'string' ? option.description : undefined })),
      multiSelect: false,
    }));
    return { id, kind: 'question', taskId: input.task.id, attempt: input.attempt, agent: 'codex', toolName: 'requestUserInput', title: questions[0]?.question ?? 'Codex needs input', input: params, questions, requestedAt: nowIso() };
  }
  const command = typeof params.command === 'string' ? params.command : undefined;
  const isCommand = method === 'item/commandExecution/requestApproval';
  const suggestions = isCommand && params.proposedExecpolicyAmendment ? [params.proposedExecpolicyAmendment] : !isCommand && params.grantRoot ? [params.grantRoot] : undefined;
  return {
    id, kind: 'permission', taskId: input.task.id, attempt: input.attempt, agent: 'codex', toolName: isCommand ? 'command' : 'fileChange',
    title: command ? `Command: ${command}` : params.reason ? String(params.reason) : 'Approve file changes', description: typeof params.reason === 'string' ? params.reason : undefined,
    input: params, suggestions, suppressAlwaysAllow: !suggestions?.length, requestedAt: nowIso(),
  };
}

function responseFor(interaction: Interaction, answer: InteractionAnswer): JsonObject {
  if (interaction.kind === 'question') {
    const answers: JsonObject = {};
    for (const [id, value] of Object.entries(answer.kind === 'answer' ? answer.answers : {})) answers[id] = { answers: [value] };
    return { answers };
  }
  if (answer.kind === 'allow') return { decision: answer.scope === 'always' ? 'acceptForSession' : 'accept' };
  return { decision: answer.kind === 'deny' ? 'decline' : 'cancel' };
}

function emptyNeedsInput(message: string): TaskResult {
  return { status: 'needs_input', summary: message, error: message, filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] };
}

export async function runCodexAppServer(config: CodexAppServerOptions, input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome> {
  await ensureDir(input.attemptDir);
  const options = config.options;
  const unsafeExtraArg = codexExtraArgsSecurityConflict(options.extraArgs);
  if (unsafeExtraArg) return { kind: 'error', outcome: 'invalid_result', message: `Codex extraArgs cannot override security option "${unsafeExtraArg}"; use the validated codex permission fields` };
  const resolved = resolveCodexPermissions(options, Boolean(input.canInteract));
  if (resolved.host && !input.canInteract) return { kind: 'error', outcome: 'invalid_result', message: 'Codex host approvals require an interactive handler' };
  if (options.configMode === 'isolated') {
    return { kind: 'error', outcome: 'invalid_result', message: 'Codex app-server cannot isolate ambient configuration while preserving saved authentication; use transport "exec" or configMode "inherit"' };
  }

  const { file, args: prefix } = splitCommand(config.command);
  const args = [...prefix, ...buildCodexAppServerArgs(options)];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key)) env[key] = value;
  Object.assign(env, input.env);

  const eventsLog = createWriteStream(path.join(input.attemptDir, 'events.jsonl'), { flags: 'a' });
  const entry = (value: TranscriptEntry): void => { eventsLog.write(`${JSON.stringify(value)}\n`); hooks.onTranscript(value); };
  // A resumed attempt continues an earlier thread; without this its log reads like a fresh session.
  if (input.resumeSessionId) entry({ kind: 'system', ts: nowIso(), text: `resumed session ${input.resumeSessionId}` });
  const usage: RunnerUsage = { sessionId: input.resumeSessionId, model: input.task.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 0 };
  const pending = new Map<string, AbortController>();
  let proc: ManagedProcess;
  let threadId = input.resumeSessionId;
  let turnId: string | undefined;
  let finalText = '';
  let terminal: JsonObject | undefined;
  let protocolError: string | undefined;
  let gatedResult: TaskResult | undefined;
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

  const answerRequest = (message: JsonObject): void => {
    const id = String(message.id);
    const method = String(message.method ?? '');
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(method)) {
      send({ id: message.id, error: { code: -32601, message: `${method} is not supported by CAO` } });
      return;
    }
    if (method === 'item/tool/requestUserInput' && !options.experimentalUserInput) {
      const reason = 'Codex requested user input, but experimentalUserInput is disabled';
      gatedResult = emptyNeedsInput(reason);
      send({ id: message.id, error: { code: -32601, message: reason } });
      void proc.kill('graceful');
      return;
    }
    const interaction = interactionFromRequest(id, method, message.params ?? {}, input);
    const controller = new AbortController();
    pending.set(id, controller);
    const ts = nowIso();
    entry(interaction.kind === 'question' ? { kind: 'question', ts, id, questions: interaction.questions ?? [] } : { kind: 'permission', ts, id, tool: interaction.toolName, title: interaction.title });
    hooks.onActivity(`? ${interaction.title}`);
    hooks.onInteraction(interaction, controller.signal).then((answer) => {
      if (!pending.delete(id)) return;
      send({ id: message.id, result: responseFor(interaction, answer) });
      const done = nowIso();
      entry(interaction.kind === 'question'
        ? { kind: 'question', ts: done, id, questions: interaction.questions ?? [], answer: answer.kind === 'answer' ? Object.values(answer.answers).join(' / ') : answer.kind }
        : { kind: 'permission', ts: done, id, tool: interaction.toolName, title: interaction.title, decision: answer.kind === 'allow' ? 'allow' : 'deny' });
    }, (error: unknown) => {
      if (!pending.delete(id)) return;
      send({ id: message.id, result: { decision: 'cancel' } });
      entry({ kind: 'error', ts: nowIso(), text: `could not answer ${interaction.title}: ${error instanceof Error ? error.message : String(error)}` });
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
        if (message.error) { protocolError = `Codex app-server initialize failed: ${message.error.message ?? JSON.stringify(message.error)}`; void proc.kill('graceful'); return; }
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
        if (message.error) { protocolError = `Codex thread start failed: ${message.error.message ?? JSON.stringify(message.error)}`; void proc.kill('graceful'); return; }
        const result = message.result ?? {};
        const actualSandbox = String(result.sandbox?.type ?? '').replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`);
        const expectedSandbox = resolved.sandbox;
        if (!actualSandbox) {
          protocolError = 'Codex app-server did not report its resolved sandbox';
          void proc.kill('graceful');
          return;
        }
        if (actualSandbox !== expectedSandbox) {
          protocolError = `Codex app-server resolved sandbox "${actualSandbox}", not requested "${expectedSandbox}"`;
          void proc.kill('graceful');
          return;
        }
        if (!result.approvalPolicy) {
          protocolError = 'Codex app-server did not report its resolved approval policy';
          void proc.kill('graceful');
          return;
        }
        if (result.approvalPolicy !== resolved.approvalPolicy) {
          protocolError = `Codex app-server resolved approval policy "${JSON.stringify(result.approvalPolicy)}", not requested "${resolved.approvalPolicy}"`;
          void proc.kill('graceful');
          return;
        }
        if (!result.approvalsReviewer) {
          protocolError = 'Codex app-server did not report its resolved approval reviewer';
          void proc.kill('graceful');
          return;
        }
        if (result.approvalsReviewer !== resolved.reviewer) {
          protocolError = `Codex app-server resolved approval reviewer "${result.approvalsReviewer}", not requested "${resolved.reviewer}"`;
          void proc.kill('graceful');
          return;
        }
        if (input.task.model && result.model !== input.task.model) {
          protocolError = `Codex app-server resolved model "${String(result.model ?? 'unknown')}", not requested "${input.task.model}"`;
          void proc.kill('graceful');
          return;
        }
        if (!Array.isArray(result.instructionSources)) {
          protocolError = 'Codex app-server did not report its instruction sources';
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
        if (message.error) { protocolError = `Codex turn start failed: ${message.error.message ?? JSON.stringify(message.error)}`; void proc.kill('graceful'); return; }
        turnId = typeof message.result?.turn?.id === 'string' ? message.result.turn.id : undefined;
        return;
      }
      const params = message.params ?? {};
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = params.item ?? {};
        if (item.type === 'commandExecution') {
          if (message.method === 'item/started') { hooks.onActivity(`$ ${String(item.command ?? '').split(/\r?\n/)[0]}`); entry({ kind: 'command', ts: nowIso(), command: String(item.command ?? ''), tool: 'shell' }); }
          else if (item.aggregatedOutput || item.status === 'failed') entry({ kind: 'tool_result', ts: nowIso(), text: truncate(String(item.aggregatedOutput ?? `exit ${item.exitCode ?? '?'}`), MAX_OUTPUT_CHARS), isError: item.status === 'failed' || Number(item.exitCode ?? 0) > 0 });
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
  const abort = (): void => { if (threadId && turnId) request(nextId++, 'turn/interrupt', { threadId, turnId }); void proc.kill('graceful'); };
  input.signal.addEventListener('abort', abort, { once: true });
  const exit = await proc.exited;
  input.signal.removeEventListener('abort', abort);
  for (const controller of pending.values()) controller.abort(new Error('worker exited'));
  pending.clear();
  let outcome: RunnerOutcome;
  if (input.signal.aborted) outcome = { kind: 'error', outcome: 'cancelled', message: 'cancelled by orchestrator', exitCode: exit.code, usage };
  else if (exit.timedOut) outcome = { kind: 'error', outcome: 'timeout', message: `timed out after ${input.timeoutMs}ms`, exitCode: exit.code, usage };
  else if (gatedResult) outcome = { kind: 'result', result: gatedResult, exitCode: exit.code, usage };
  else if (protocolError) outcome = { kind: 'error', outcome: 'crash', message: protocolError, exitCode: exit.code, usage };
  else if (!terminal) outcome = { kind: 'error', outcome: 'crash', message: `Codex app-server exited before turn completion (code ${exit.code ?? 'null'})`, exitCode: exit.code, usage };
  else if (terminal.status === 'failed') {
    const failure = normalizeCodexFailure(terminal.error?.codexErrorInfo, { ...codexFailureMetadata(terminal.error), sessionId: threadId });
    outcome = { kind: 'error', outcome: failure.retryable ? 'api_error' : 'crash', message: String(terminal.error?.message ?? 'Codex turn failed'), exitCode: exit.code, usage, failure };
  } else if (terminal.status !== 'completed') {
    outcome = { kind: 'error', outcome: 'crash', message: `Codex turn ended with status ${String(terminal.status ?? 'unknown')}`, exitCode: exit.code, usage, failure: { retryable: false, sessionId: threadId, partialWork: true } };
  } else {
    if (!finalText && Array.isArray(terminal.items)) {
      const finalMessage = [...terminal.items].reverse().find((item: JsonObject) => item?.type === 'agentMessage' && typeof item.text === 'string');
      if (finalMessage) finalText = finalMessage.text;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(finalText); } catch { parsed = undefined; }
    const valid = CODEX_COMPLETION_CONTRACT.validate(parsed);
    outcome = valid.ok
      ? { kind: 'result', result: valid.result, exitCode: exit.code, usage, rawResultText: finalText }
      : { kind: 'error', outcome: 'invalid_result', message: valid.error, exitCode: exit.code, usage };
  }
  entry(outcome.kind === 'result'
    ? { kind: 'result', ts: nowIso(), status: outcome.result.status, summary: outcome.result.summary, isError: false, error: outcome.result.error }
    : { kind: 'error', ts: nowIso(), text: outcome.message });
  await new Promise<void>((resolve) => eventsLog.end(() => resolve()));
  return outcome;
}
