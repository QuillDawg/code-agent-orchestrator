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
import { capabilityPreflight, type CapabilityNeed, type PreflightProblem } from '../preflight.js';
import { claudeCapabilityNeeds } from './preflight.js';
import type {
  RunnerFailure,
  ClaudeOptions,
  ResolvedTask,
  RunnerUsage,
  TaskResult,
  TranscriptEntry,
  TranscriptEntryInput,
  InteractionAnswer,
} from 'code-agent-orchestrator-protocol';
import { ProcessManager } from '../../execution/process-manager.js';
import { detectClaude, splitCommand } from './detect.js';
import { parseClaudeEvents, activityFromText, type ClaudeResultEvent } from './event-parser.js';
import { CONTRACT_SYSTEM_PROMPT, TASK_RESULT_JSON_SCHEMA_STRING, extractJsonObject, validateTaskResult } from '../contract.js';
import { agentTextEvents, completionTranscript } from '../completion-text.js';
import { claudeConfigRejection, isTransientApiError } from './transient.js';
import { configErrorOutcome, killedMessage, openToolMessage } from '../outcomes.js';
import { contextWindowFor, supportsAutoMode, supportsEffort } from './models.js';
import { encodeUserMessage, encodeControlResponse, encodeErrorResponse, toInteraction, summarizeAnswer, describeDenials, PendingInteractions } from './protocol.js';
import { ensureDir } from '../../util/fs.js';
import { sanitizeText } from '../../util/text.js';
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
  if (!supportsEffort(options.model)) delete options.effort;
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
  if (options.configMode === 'isolated') args.push('--safe-mode');
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

/**
 * The CLI accepts every permission mode on the command line but does not run every model in every mode: auto
 * mode falls back to the ordinary prompting mode for models without it, and the only sign is the init event.
 * Returns the warning to show, or undefined when the session runs in the mode that was asked for.
 */
export function permissionModeDowngrade(requested: string, reported: string | undefined, model: string | undefined): string | undefined {
  if (!reported || reported === requested) return undefined;
  // cao's `manual` is the CLI's `default`; same thing under two names.
  if (requested === 'manual' && reported === 'default') return undefined;
  const why = requested === 'auto' && model && !supportsAutoMode(model) ? ` because ${model} has no auto mode` : '';
  const effect = reported === 'default' ? '; every file write and command will prompt' : '';
  return `Claude Code started this session in permission mode "${reported}", not the requested "${requested}"${why}${effect}. Set permissionMode to acceptEdits, dontAsk or bypassPermissions for this task to avoid the prompts.`;
}

/** Which prompt mode an attempt runs in: the explicit option wins, otherwise ask only when someone can answer. */
export function resolvePromptMode(options: ClaudeOptions, canInteract: boolean): PromptMode {
  return options.permissionPrompts ?? (canInteract ? 'ask' : 'deny');
}

function claudeFailure(message: string, retryable: boolean, sessionId: string | undefined, extras: Partial<RunnerFailure> = {}): RunnerFailure {
  const status = /\b(?:HTTP\s*)?(\d{3})\b/i.exec(message)?.[1];
  const requestId = /\brequest[_ -]?id[:= ]+([\w-]+)/i.exec(message)?.[1];
  return { retryable, sessionId, ...(status ? { httpStatus: Number(status) } : {}), ...(requestId ? { requestId } : {}), ...extras };
}

/**
 * A worker that was refused every prompt it raised is blocked on a human, not broken. Without this the
 * attempt ends as `crash` and the run reports a failure whose real cause — nobody could answer — appears
 * nowhere, so `cao resume --input` never looks like the next step.
 */
function deniedNeedsInput(denied: string[], detail: string, promptMode: PromptMode): TaskResult {
  const list = denied.map((d) => sanitizeText(d)).join(', ');
  const named = list ? `Claude Code denied ${list}` : 'Claude Code denied every permission prompt this session raised';
  const why =
    promptMode === 'deny'
      ? 'this attempt ran with claude.permissionPrompts "deny" (the default without a dashboard), so nothing could be asked'
      : 'the prompts were denied rather than answered';
  return {
    status: 'needs_input',
    summary: `${named} and the session could not continue`,
    error: `${named} itself: ${why}. The session then ended: ${detail}. Attach a dashboard (or set claude.permissionPrompts: ask) to answer prompts during the run, or answer this task with \`cao resume --task <id> --input "…"\`.`,
    filesChanged: [],
    commits: [],
    decisions: [],
    warnings: [detail],
    followUp: ['Set claude.permissionPrompts: ask and attach a dashboard to answer prompts during the run.'],
    data: { blockedOn: 'claudePermission' },
  };
}

function claudeProviderCode(retry: { httpStatus?: number; message?: string } | undefined, subtype?: string): string | undefined {
  if (retry?.httpStatus === 429) return 'rateLimitExceeded';
  if (retry?.httpStatus === 529 || /overload/i.test(retry?.message ?? '')) return 'serverOverloaded';
  if (retry?.httpStatus !== undefined && retry.httpStatus >= 500) return 'internalServerError';
  if (/connect|stream|socket|network/i.test(retry?.message ?? '')) return 'connectionFailed';
  return subtype;
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

  /**
   * Once per run, before anything is spawned: is the installed CLI new enough, and does it advertise what
   * these tasks selected. A CLI that is simply absent is left to `run()` (and to `cao run`'s own check), so
   * that a missing binary keeps reporting itself the way it always has.
   */
  async preflight(tasks: ResolvedTask[]): Promise<PreflightProblem[]> {
    const byCommand = new Map<string, { taskIds: string[]; needs: CapabilityNeed[] }>();
    for (const task of tasks) {
      const options = resolveClaudeOptions(this.defaults, task);
      const entry = byCommand.get(options.command ?? '') ?? { taskIds: [], needs: [] };
      entry.taskIds.push(task.id);
      entry.needs.push(...claudeCapabilityNeeds(options));
      byCommand.set(options.command ?? '', entry);
    }
    const problems: PreflightProblem[] = [];
    for (const [command, entry] of byCommand) {
      const message = capabilityPreflight('claude', await detectClaude(command || undefined), entry.needs);
      if (message) problems.push({ taskIds: entry.taskIds, message });
    }
    return problems;
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
    // A completion object the session ends on is that session's outcome rather than a checkpoint before it,
    // so the last one is held back until the outcome has been decided below.
    const transcript = completionTranscript((e: TranscriptEntry): void => {
      eventsLog.write(`${JSON.stringify(e)}\n`);
      hooks.onTranscript(e);
    });
    const entry = transcript.entry;
    if (resumeSessionId) entry({ kind: 'system', ts: nowIso(), text: `resumed session ${resumeSessionId}` });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !ENV_TO_STRIP.includes(k)) env[k] = v;
    Object.assign(env, input.env);

    let resultEvent: ClaudeResultEvent | undefined;
    let model: string | undefined = options.model;
    const stderrTail: string[] = [];
    let hadStdout = false;
    const initializationFailures: string[] = [];
    let lastApiRetry: { httpStatus?: number; retryDelayMs: number; message?: string } | undefined;

    // Live usage: per-message token counts are de-duplicated by message id (stream-json repeats a
    // message once per content block); the context size is that of the latest model call.
    const usage: RunnerUsage = { sessionId, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, compactions: 0, contextWindow: contextWindowFor(model) };
    let lastMessageId: string | undefined;

    // Tool timing: a call is remembered by its tool_use_id until its result arrives, and the gap is added to
    // the attempt's time-in-tools. Parallel calls overlap, so the total can exceed the attempt's wall clock.
    const toolStarts = new Map<string, number>();
    /** The same calls, by their one-line description: at exit these are the ones nobody ever answered. */
    const openTools = new Map<string, string>();
    const startTool = (toolUseId?: string, label?: string): void => {
      if (!toolUseId) return;
      toolStarts.set(toolUseId, Date.now());
      openTools.set(toolUseId, label ?? toolUseId);
    };
    const finishTool = (toolUseId?: string): boolean => {
      const started = toolUseId ? toolStarts.get(toolUseId) : undefined;
      if (!toolUseId) return false;
      openTools.delete(toolUseId);
      if (started === undefined) return false;
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
              if (ev.capabilities?.length) entry({ kind: 'system', ts, text: `Claude capabilities: ${ev.capabilities.join(', ')}` });
              for (const failure of ev.initializationFailures ?? []) {
                initializationFailures.push(failure);
                entry({ kind: 'error', ts, text: `Claude initialization failure: ${failure}` });
                hooks.onWarning?.(`Claude initialization failure: ${failure}`);
              }
              {
                const downgrade = permissionModeDowngrade(options.permissionMode ?? 'auto', ev.permissionMode, model);
                if (downgrade) {
                  entry({ kind: 'system', ts, text: downgrade });
                  hooks.onWarning?.(downgrade);
                }
              }
              break;
            case 'activity':
              hooks.onActivity(ev.line);
              startTool(ev.toolUseId, ev.line);
              entry({ kind: 'tool', ts, tool: ev.tool, line: ev.line, filePath: ev.filePath, fileOp: ev.fileOp, toolUseId: ev.toolUseId, parentToolUseId: ev.parentToolUseId });
              if (ev.filePath && ev.fileOp) hooks.onFileChange({ path: ev.filePath, op: ev.fileOp });
              break;
            case 'command':
              hooks.onActivity(`$ ${ev.command.split(/\r?\n/)[0] ?? ev.command}`);
              startTool(ev.toolUseId, `$ ${ev.command}`);
              entry({ kind: 'command', ts, command: ev.command, tool: ev.tool, toolUseId: ev.toolUseId, parentToolUseId: ev.parentToolUseId });
              break;
            case 'text':
              // The final answer of a structured-output session is the completion object itself, and a worker
              // can emit one mid-session and keep going: both are recorded as results rather than as prose.
              // The attempt's outcome still comes from the result event's structured_output below.
              for (const produced of agentTextEvents(ev.text, ts, { activity: activityFromText, parentToolUseId: ev.parentToolUseId })) {
                hooks.onActivity(produced.activity);
                entry(produced.entry);
              }
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
            case 'api_retry': {
              lastApiRetry = { retryDelayMs: ev.retryDelayMs, ...(ev.httpStatus !== undefined ? { httpStatus: ev.httpStatus } : {}), ...(ev.message ? { message: ev.message } : {}) };
              const detail = `Claude API retry ${ev.attempt}/${ev.maxRetries}${ev.httpStatus ? ` (HTTP ${ev.httpStatus})` : ''} in ${ev.retryDelayMs}ms${ev.message ? `: ${ev.message}` : ''}`;
              hooks.onActivity(detail);
              entry({ kind: 'system', ts, text: detail });
              break;
            }
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
      transcript.finish({ ...e, ts: nowIso() } as TranscriptEntry);
    };
    const outcome = ((): RunnerOutcome => {
      if (input.signal.aborted) return { kind: 'error', outcome: 'cancelled', message: 'cancelled by orchestrator', exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      if (exit.timedOut) {
        finishEntry({ kind: 'error', text: `timed out after ${input.timeoutMs}ms` });
        return { kind: 'error', outcome: 'timeout', message: `timed out after ${input.timeoutMs}ms`, exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      }
      if (exit.spawnError) return { kind: 'error', outcome: 'crash', message: `failed to start Claude: ${exit.spawnError}`, exitCode: exit.code, usage: finalUsage };

      if (initializationFailures.length) {
        const message = `Claude initialization failed: ${initializationFailures.join('; ')}`;
        finishEntry({ kind: 'error', text: message });
        return { kind: 'error', outcome: 'crash', message, exitCode: exit.code, usage: finalUsage, failure: claudeFailure(message, false, finalUsage.sessionId, { providerCode: 'initializationFailed' }) };
      }

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
          // A schema the API refused is a configuration error however the session reported it: it cannot
          // succeed on a retry, and the flag it came from is the only actionable thing about it.
          const rejection = claudeConfigRejection({ exitCode: exit.code, stderr: stderrTail.join('\n'), resultText: detail });
          if (rejection) {
            const rejected = configErrorOutcome('Claude Code', rejection, { exitCode: exit.code, signal: exit.signal, usage: finalUsage });
            finishEntry({ kind: 'error', text: rejected.message });
            return rejected;
          }
          const denied = describeDenials(resultEvent.permissionDenials);
          const denials = denied.length ? ` (${denied.length} permission denial(s))` : '';
          // A 5xx/overloaded/network failure ends the print-mode process; the session itself is intact and resumable.
          const outcome = isTransientApiError(detail) || isTransientApiError(stderrTail.join('\n')) ? 'api_error' : 'crash';
          // A session refused everything it asked for and then gave up is waiting on a human, not crashed.
          if (denied.length && outcome !== 'api_error') {
            const result = deniedNeedsInput(denied, detail, promptMode);
            finishEntry({ kind: 'result', status: result.status, summary: result.summary, costUsd: finalUsage.costUsd, isError: false, error: result.error });
            return { kind: 'result', result, exitCode: exit.code, usage: finalUsage };
          }
          finishEntry({ kind: 'result', status: resultEvent.subtype ?? 'error', costUsd: finalUsage.costUsd, isError: true, error: `${detail}${denials}` });
          return { kind: 'error', outcome, message: `Claude reported an error${denials}: ${detail}${stderrSummary}`, exitCode: exit.code, usage: finalUsage, failure: claudeFailure(detail, outcome === 'api_error', finalUsage.sessionId, { ...(claudeProviderCode(lastApiRetry, resultEvent.subtype) ? { providerCode: claudeProviderCode(lastApiRetry, resultEvent.subtype) } : {}), ...(lastApiRetry?.httpStatus !== undefined ? { httpStatus: lastApiRetry.httpStatus } : {}), ...(lastApiRetry ? { retryAfterMs: lastApiRetry.retryDelayMs } : {}) }) };
        }
        const message = `Claude finished without a machine-readable result (subtype: ${resultEvent.subtype ?? 'n/a'}, stop: ${resultEvent.stopReason ?? 'n/a'})`;
        finishEntry({ kind: 'error', text: message });
        return { kind: 'error', outcome: 'invalid_result', message, exitCode: exit.code, usage: finalUsage };
      }

      // The CLI never started a session because it could not parse what CAO gave it: a workflow bug, and
      // one that used to burn every retry the task had.
      const rejection = claudeConfigRejection({ exitCode: exit.code, stderr: stderrTail.join('\n') });
      if (rejection) {
        const rejected = configErrorOutcome('Claude Code', rejection, { exitCode: exit.code, signal: exit.signal, usage: finalUsage });
        finishEntry({ kind: 'error', text: rejected.message });
        return rejected;
      }
      if (exit.code !== 0) {
        const message = `${killedMessage('Claude', exit.code, exit.signal)}${stderrSummary}`;
        finishEntry({ kind: 'error', text: message });
        return {
          kind: 'error',
          outcome: isTransientApiError(stderrTail.join('\n')) ? 'api_error' : 'crash',
          message,
          exitCode: exit.code,
          signal: exit.signal,
          usage: finalUsage,
          failure: claudeFailure(stderrTail.join('\n'), isTransientApiError(stderrTail.join('\n')), finalUsage.sessionId),
        };
      }
      // The process left cleanly while a tool call it had made was still unanswered: the turn was cut
      // short rather than merely sloppy, and the transcript has to end with the call that was open.
      if (openTools.size) {
        const message = openToolMessage('Claude', [...openTools.values()]);
        finishEntry({ kind: 'error', text: message });
        return { kind: 'error', outcome: 'crash', message, exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      }
      const message = hadStdout ? 'Claude exited without emitting a result message' : `Claude produced no output${stderrSummary}`;
      finishEntry({ kind: 'error', text: message });
      return { kind: 'error', outcome: 'invalid_result', message, exitCode: exit.code, usage: finalUsage };
    })();
    // Cancellation and a failure to start return without recording an outcome: nothing held may be lost.
    transcript.flush();
    await new Promise<void>((resolve) => eventsLog.end(() => resolve()));
    return outcome;
  }
}
