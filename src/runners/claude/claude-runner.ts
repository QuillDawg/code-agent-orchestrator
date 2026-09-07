/**
 * Runs one task attempt in a `claude -p` session (fresh, or resumed after a transient API error). Events are
 * consumed from stream-json and the completion contract is enforced via --json-schema + validation.
 *
 * Two prompt modes:
 *  - ask  (default when a dashboard is attached): `--input-format stream-json --permission-prompt-tool stdio`.
 *         The prompt is written as a user message, stdin stays open, and every permission prompt or
 *         AskUserQuestion arrives as a `control_request` that the orchestrator answers on stdin.
 *  - deny (headless): `--permission-prompts none`; anything that would prompt is denied by the CLI.
 */
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import type { TaskRunner, RunnerInput, RunnerHooks, RunnerOutcome } from '../task-runner.js';
import type { ClaudeOptions, ResolvedTask } from '../../types/workflow.js';
import type { RunnerUsage } from '../../types/result.js';
import type { TranscriptEntry, TranscriptEntryInput } from '../../types/transcript.js';
import type { InteractionAnswer } from '../../types/interaction.js';
import { ProcessManager } from '../../execution/process-manager.js';
import { detectClaude, splitCommand } from './detect.js';
import { parseClaudeEvents, activityFromText, type ClaudeResultEvent } from './event-parser.js';
import { CONTRACT_SYSTEM_PROMPT, TASK_RESULT_JSON_SCHEMA_STRING, extractJsonObject, validateTaskResult } from './contract.js';
import { isTransientApiError } from './transient.js';
import { contextWindowFor } from './models.js';
import { encodeUserMessage, encodeControlResponse, encodeErrorResponse, toInteraction, summarizeAnswer, PendingInteractions } from './protocol.js';
import { ensureDir } from '../../util/fs.js';
import { nowIso, uuid } from '../../util/misc.js';

export interface ClaudeRunnerOptions {
  processManager: ProcessManager;
  defaults?: ClaudeOptions;
  bufferLines?: number;
}

export type PromptMode = 'ask' | 'deny';

const ENV_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'];

/**
 * Runner defaults (workflow `claude:`) merged with the task's own `claude:` block, then the resolved
 * generic `model`/`effort` promoted over both. normalize() already folded `claude.model`/`claude.effort`
 * in as the legacy fallback, so this only ever promotes an already-resolved value; without it the
 * generic keys would show up in `cao validate` but never reach the CLI.
 * `none`/`minimal` are Codex-only effort levels and are dropped rather than passed to Claude.
 */
export function resolveClaudeOptions(defaults: ClaudeOptions, task: Pick<ResolvedTask, 'claude' | 'model' | 'effort'>): ClaudeOptions {
  const options: ClaudeOptions = { ...defaults, ...task.claude };
  if (task.model) options.model = task.model;
  if (task.effort && task.effort !== 'none' && task.effort !== 'minimal') options.effort = task.effort;
  return options;
}

export function buildClaudeArgs(
  options: ClaudeOptions,
  sessionId: string,
  systemPromptAddendum?: string,
  resumeSessionId?: string,
  prompts: PromptMode = 'deny',
  forwardSubagentText = false,
): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', TASK_RESULT_JSON_SCHEMA_STRING];
  args.push('--permission-mode', options.permissionMode ?? 'auto');
  if (prompts === 'ask') args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  else args.push('--permission-prompts', 'none');
  // Without it a subagent's prose never reaches the stream; its tool calls arrive either way.
  if (forwardSubagentText) args.push('--forward-subagent-text');
  // A resumed session keeps its transcript (and id); a fresh one gets an orchestrator-generated id.
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  else args.push('--session-id', sessionId);
  const systemPrompt = [CONTRACT_SYSTEM_PROMPT, options.appendSystemPrompt, systemPromptAddendum].filter(Boolean).join('\n\n');
  args.push('--append-system-prompt', systemPrompt);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd));
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  if (options.disallowedTools?.length) args.push('--disallowedTools', options.disallowedTools.join(','));
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir);
  if (options.sessionPersistence === false) args.push('--no-session-persistence');
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

/** Which prompt mode an attempt runs in: the explicit option wins, otherwise ask only when someone can answer. */
export function resolvePromptMode(options: ClaudeOptions, canInteract: boolean): PromptMode {
  return options.permissionPrompts ?? (canInteract ? 'ask' : 'deny');
}

export class ClaudeRunner implements TaskRunner {
  readonly name = 'claude';
  private readonly pm: ProcessManager;
  private readonly defaults: ClaudeOptions;
  private readonly bufferLines: number;

  constructor(opts: ClaudeRunnerOptions) {
    this.pm = opts.processManager;
    this.defaults = opts.defaults ?? {};
    this.bufferLines = opts.bufferLines ?? 500;
  }

  async run(input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome> {
    const options = resolveClaudeOptions(this.defaults, input.task);
    const detection = await detectClaude(options.command);
    if (!detection.found) {
      return { kind: 'error', outcome: 'crash', message: `Claude Code CLI not found (${detection.command}): ${detection.error ?? 'unknown error'}` };
    }
    if (input.signal.aborted) return { kind: 'error', outcome: 'cancelled', message: 'cancelled before start' };

    const promptMode = resolvePromptMode(options, Boolean(input.canInteract));
    const resumeSessionId = input.resumeSessionId && options.sessionPersistence !== false ? input.resumeSessionId : undefined;
    const sessionId = resumeSessionId ?? uuid();
    const { file, args: prefixArgs } = splitCommand(detection.command);
    const args = [...prefixArgs, ...buildClaudeArgs(options, sessionId, input.systemPromptAddendum, resumeSessionId, promptMode, detection.forwardSubagentText ?? false)];

    await ensureDir(input.attemptDir);
    const eventsLog = createWriteStream(path.join(input.attemptDir, 'events.jsonl'), { flags: 'a' });
    const entry = (e: TranscriptEntry): void => {
      eventsLog.write(`${JSON.stringify(e)}\n`);
      hooks.onTranscript(e);
    };
    if (resumeSessionId) entry({ kind: 'system', ts: nowIso(), text: `resumed session ${resumeSessionId}` });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !ENV_TO_STRIP.includes(k)) env[k] = v;
    Object.assign(env, input.env);

    let resultEvent: ClaudeResultEvent | undefined;
    let model: string | undefined = options.model;
    const stderrTail: string[] = [];
    let hadStdout = false;

    // Live usage: per-message token counts are de-duplicated by message id (stream-json repeats a
    // message once per content block); the context size is that of the latest model call.
    const usage: RunnerUsage = { sessionId, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, compactions: 0, contextWindow: contextWindowFor(model) };
    let lastMessageId: string | undefined;

    // Tool timing: a call is remembered by its tool_use_id until its result arrives, and the gap is added to
    // the attempt's time-in-tools. Parallel calls overlap, so the total can exceed the attempt's wall clock.
    const toolStarts = new Map<string, number>();
    const startTool = (toolUseId?: string): void => {
      if (toolUseId) toolStarts.set(toolUseId, Date.now());
    };
    const finishTool = (toolUseId?: string): boolean => {
      const started = toolUseId ? toolStarts.get(toolUseId) : undefined;
      if (started === undefined || !toolUseId) return false;
      toolStarts.delete(toolUseId);
      usage.toolMs = (usage.toolMs ?? 0) + Math.max(0, Date.now() - started);
      return true;
    };

    const pending = new PendingInteractions();
    let proc: ReturnType<ProcessManager['spawn']> | undefined;

    const answer = (requestId: string, request: Record<string, unknown>): void => {
      const interaction = toInteraction(requestId, request, { taskId: input.task.id, attempt: input.attempt, agent: 'claude' });
      const signal = pending.open(requestId);
      const ts = nowIso();
      if (interaction.kind === 'question') entry({ kind: 'question', ts, id: requestId, questions: interaction.questions ?? [] });
      else entry({ kind: 'permission', ts, id: requestId, tool: interaction.toolName, title: interaction.title });
      hooks.onActivity(`? ${interaction.title}`);
      const settle = (result: InteractionAnswer | Error): void => {
        if (!pending.settle(requestId)) return;
        const line = result instanceof Error ? encodeErrorResponse(requestId, result.message) : encodeControlResponse(interaction, result);
        proc?.writeStdin(line);
        const done = nowIso();
        if (result instanceof Error) entry({ kind: 'error', ts: done, text: `could not answer ${interaction.title}: ${result.message}` });
        else if (interaction.kind === 'question') entry({ kind: 'question', ts: done, id: requestId, questions: interaction.questions ?? [], answer: summarizeAnswer(result) });
        else entry({ kind: 'permission', ts: done, id: requestId, tool: interaction.toolName, title: interaction.title, decision: result.kind === 'deny' ? 'deny' : 'allow', message: result.kind === 'deny' ? result.message : undefined });
      };
      hooks.onInteraction(interaction, signal).then(settle, (err: unknown) => settle(err instanceof Error ? err : new Error(String(err))));
    };

    proc = this.pm.spawn({
      taskId: input.task.id,
      attempt: input.attempt,
      command: file,
      args,
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs,
      stdinText: promptMode === 'ask' ? encodeUserMessage(input.prompt) : input.prompt,
      stdin: promptMode === 'ask' ? 'keep-open' : 'close',
      logDir: input.attemptDir,
      bufferLines: this.bufferLines,
      onStdoutLine: (line) => {
        hadStdout = true;
        const events = parseClaudeEvents(line);
        if (events.length === 0) {
          hooks.onOutput('stdout', line);
          return;
        }
        const ts = nowIso();
        for (const ev of events) {
          switch (ev.kind) {
            case 'init':
              model = ev.model ?? model;
              usage.model = model;
              usage.contextWindow = contextWindowFor(model);
              hooks.onProcess({ pid: proc?.pid ?? -1, sessionId: ev.sessionId ?? sessionId });
              entry({ kind: 'system', ts, text: `session ${ev.sessionId ?? sessionId}${model ? ` (${model})` : ''}` });
              break;
            case 'activity':
              hooks.onActivity(ev.line);
              startTool(ev.toolUseId);
              entry({ kind: 'tool', ts, tool: ev.tool, line: ev.line, filePath: ev.filePath, fileOp: ev.fileOp, toolUseId: ev.toolUseId, parentToolUseId: ev.parentToolUseId });
              if (ev.filePath && ev.fileOp) hooks.onFileChange({ path: ev.filePath, op: ev.fileOp });
              break;
            case 'command':
              hooks.onActivity(`$ ${ev.command.split(/\r?\n/)[0] ?? ev.command}`);
              startTool(ev.toolUseId);
              entry({ kind: 'command', ts, command: ev.command, tool: ev.tool, toolUseId: ev.toolUseId, parentToolUseId: ev.parentToolUseId });
              break;
            case 'text':
              hooks.onActivity(activityFromText(ev.text));
              entry({ kind: 'text', ts, text: ev.text, parentToolUseId: ev.parentToolUseId });
              break;
            // Thinking is recorded but never announced: it stays out of the activity line, live.json and the
            // run-level log, and only surfaces where someone asked for it (T in the viewer, `cao logs --thinking`).
            case 'thinking':
              entry({ kind: 'thinking', ts, text: ev.text, parentToolUseId: ev.parentToolUseId });
              break;
            case 'tool_result':
              if (finishTool(ev.toolUseId)) hooks.onUsage({ ...usage });
              entry({ kind: 'tool_result', ts, text: ev.text, isError: ev.isError, toolUseId: ev.toolUseId, parentToolUseId: ev.parentToolUseId });
              break;
            case 'usage': {
              if (!ev.messageId || ev.messageId !== lastMessageId) {
                lastMessageId = ev.messageId;
                usage.inputTokens! += ev.inputTokens;
                usage.outputTokens! += ev.outputTokens;
                usage.cacheReadTokens! += ev.cacheReadTokens;
                usage.cacheCreationTokens! += ev.cacheCreationTokens;
              }
              usage.contextTokens = ev.inputTokens + ev.cacheReadTokens + ev.cacheCreationTokens;
              if (ev.model) {
                usage.model = ev.model;
                if (ev.model !== model) usage.contextWindow = contextWindowFor(ev.model);
                model = ev.model;
              }
              hooks.onUsage({ ...usage });
              break;
            }
            case 'compact':
              usage.compactions = (usage.compactions ?? 0) + 1;
              entry({ kind: 'system', ts, text: 'context compacted' });
              hooks.onUsage({ ...usage });
              break;
            case 'control_request':
              if (ev.subtype === 'can_use_tool') answer(ev.requestId, ev.request);
              else proc?.writeStdin(encodeErrorResponse(ev.requestId, `${ev.subtype} is not supported by the orchestrator`));
              break;
            case 'control_cancel':
              pending.cancel(ev.requestId, 'withdrawn by the worker');
              break;
            case 'result':
              resultEvent = ev;
              if (ev.usage) {
                Object.assign(usage, ev.usage);
                if (ev.usage.model) model = ev.usage.model;
              }
              usage.costUsd = ev.costUsd ?? usage.costUsd;
              usage.durationMs = ev.durationMs;
              usage.numTurns = ev.numTurns;
              usage.sessionId = ev.sessionId ?? sessionId;
              hooks.onUsage({ ...usage });
              proc?.endStdin();
              break;
            default:
              break;
          }
        }
      },
      onStderrLine: (line) => {
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        hooks.onOutput('stderr', line);
        entry({ kind: 'stderr', ts: nowIso(), text: line });
      },
    });
    hooks.onProcess({ pid: proc.pid, sessionId });

    const onAbort = (): void => {
      // Answer anything the worker is still waiting on so no promise dangles, then stop the process.
      pending.abortAll('cancelled by orchestrator');
      void proc?.kill('graceful');
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    const exit = await proc.exited;
    input.signal.removeEventListener('abort', onAbort);
    pending.abortAll('worker exited');

    const finalUsage: RunnerUsage = { ...usage, sessionId: resultEvent?.sessionId ?? sessionId, model };
    const stderrSummary = stderrTail.length ? `\nstderr:\n${stderrTail.slice(-10).join('\n')}` : '';
    // The outcome is written through entry(), so the attempt's events.jsonl ends with the result rather than
    // stopping at the last tool call; the log is closed once, after the outcome has been decided.
    const finishEntry = (e: Extract<TranscriptEntryInput, { kind: 'result' | 'error' }>): void => {
      entry({ ...e, ts: nowIso() } as TranscriptEntry);
    };
    const outcome = ((): RunnerOutcome => {
      if (input.signal.aborted) return { kind: 'error', outcome: 'cancelled', message: 'cancelled by orchestrator', exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      if (exit.timedOut) {
        finishEntry({ kind: 'error', text: `timed out after ${input.timeoutMs}ms` });
        return { kind: 'error', outcome: 'timeout', message: `timed out after ${input.timeoutMs}ms`, exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      }
      if (exit.spawnError) return { kind: 'error', outcome: 'crash', message: `failed to start Claude: ${exit.spawnError}`, exitCode: exit.code, usage: finalUsage };

      if (resultEvent) {
        const candidate = resultEvent.structuredOutput ?? extractJsonObject(resultEvent.resultText ?? '');
        if (candidate !== undefined) {
          const validated = validateTaskResult(candidate);
          if (validated.ok) {
            finishEntry({ kind: 'result', status: validated.result.status, summary: validated.result.summary, costUsd: finalUsage.costUsd, isError: false, error: validated.result.error });
            return { kind: 'result', result: validated.result, exitCode: exit.code, usage: finalUsage, rawResultText: resultEvent.resultText };
          }
          if (!resultEvent.isError) {
            finishEntry({ kind: 'error', text: validated.error });
            return { kind: 'error', outcome: 'invalid_result', message: validated.error, exitCode: exit.code, usage: finalUsage };
          }
        }
        if (resultEvent.isError) {
          const detail = resultEvent.resultText ?? resultEvent.subtype ?? 'unknown error';
          const denials = resultEvent.permissionDenials?.length ? ` (${resultEvent.permissionDenials.length} permission denial(s))` : '';
          // A 5xx/overloaded/network failure ends the print-mode process; the session itself is intact and resumable.
          const outcome = isTransientApiError(detail) || isTransientApiError(stderrTail.join('\n')) ? 'api_error' : 'crash';
          finishEntry({ kind: 'result', status: resultEvent.subtype ?? 'error', costUsd: finalUsage.costUsd, isError: true, error: `${detail}${denials}` });
          return { kind: 'error', outcome, message: `Claude reported an error${denials}: ${detail}${stderrSummary}`, exitCode: exit.code, usage: finalUsage };
        }
        const message = `Claude finished without a machine-readable result (subtype: ${resultEvent.subtype ?? 'n/a'}, stop: ${resultEvent.stopReason ?? 'n/a'})`;
        finishEntry({ kind: 'error', text: message });
        return { kind: 'error', outcome: 'invalid_result', message, exitCode: exit.code, usage: finalUsage };
      }

      if (exit.code !== 0) {
        const message = `Claude exited with code ${exit.code ?? 'null'}${exit.signal ? ` (signal ${exit.signal})` : ''}${stderrSummary}`;
        finishEntry({ kind: 'error', text: message });
        return {
          kind: 'error',
          outcome: isTransientApiError(stderrTail.join('\n')) ? 'api_error' : 'crash',
          message,
          exitCode: exit.code,
          signal: exit.signal,
          usage: finalUsage,
        };
      }
      const message = hadStdout ? 'Claude exited without emitting a result message' : `Claude produced no output${stderrSummary}`;
      finishEntry({ kind: 'error', text: message });
      return { kind: 'error', outcome: 'invalid_result', message, exitCode: exit.code, usage: finalUsage };
    })();
    await new Promise<void>((resolve) => eventsLog.end(() => resolve()));
    return outcome;
  }
}
