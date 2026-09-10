/**
 * Codex `exec --json` runner. Codex writes a schema-validated final answer to a file while JSONL carries activity.
 *
 * `codex exec` has no channel for answering approvals or `request_user_input`: it rejects them itself, so a
 * Codex task never waits on a human. Those rejections surface as `error` transcript entries.
 */
import path from 'node:path';
import { promises as fs, createWriteStream } from 'node:fs';
import type { TaskRunner, RunnerInput, RunnerHooks, RunnerOutcome } from '../task-runner.js';
import type { CodexOptions } from '../../types/workflow.js';
import type { RunnerUsage } from '../../types/result.js';
import type { TranscriptEntry, TranscriptEntryInput, FileOp } from '../../types/transcript.js';
import { ProcessManager } from '../../execution/process-manager.js';
import { detectCodex } from './detect.js';
import { splitCommand } from '../claude/detect.js';
import { CODEX_COMPLETION_CONTRACT } from '../claude/contract.js';
import { agentTextEvents } from '../claude/completion-text.js';
import { isTransientApiError } from '../claude/transient.js';
import { ensureDir } from '../../util/fs.js';
import { nowIso, truncate } from '../../util/misc.js';
import { runCodexAppServer } from './app-server.js';
import { codexFailureMetadata, normalizeCodexFailure } from './failure.js';
import { codexAutomaticReviewSandboxConflict, codexExtraArgsSecurityConflict, resolveCodexPermissions } from './permissions.js';
import { CODEX_EXEC_NO_HUMAN, codexExecHumanRequest, codexExecNeedsInput, type CodexExecBlock } from './exec-limits.js';

export interface CodexRunnerOptions {
  processManager: ProcessManager;
  defaults?: CodexOptions;
  bufferLines?: number;
}

const ENV_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'];
const MAX_OUTPUT_CHARS = 2000;

/**
 * `codex exec` rejects `--ask-for-approval` (it is a TUI-only flag), so the approval policy travels as a
 * config override, which is also what the official Codex SDK does. Model/effort come before extraArgs so
 * extraArgs can override them, like the Claude runner.
 */
export function buildCodexArgs(options: CodexOptions, schemaPath: string, outputPath: string, resumeSessionId?: string, model?: string, effort?: string): string[] {
  const conflict = codexExtraArgsSecurityConflict(options.extraArgs);
  if (conflict) throw new Error(`Codex extraArgs cannot override security option "${conflict}"; use the validated codex permission fields`);
  const permissions = resolveCodexPermissions(options, false);
  if (codexAutomaticReviewSandboxConflict(permissions)) {
    throw new Error('Codex automatic review requires the workspace-write sandbox');
  }
  const args = ['-c', `approval_policy="${permissions.approvalPolicy}"`];
  if (permissions.autoReview) args.unshift('--approve-for-me');
  else args.unshift('--sandbox', permissions.sandbox);
  if (options.profile) args.push('--profile', options.profile);
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir);
  args.push('exec');
  if (options.configMode === 'isolated') args.push('--ignore-user-config', '--ignore-rules');
  if (resumeSessionId) args.push('resume', resumeSessionId);
  args.push('--json', '--output-schema', schemaPath, '--output-last-message', outputPath);
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

const firstLine = (text: string): string => text.split(/\r?\n/)[0] ?? '';

const FILE_OPS: Record<string, FileOp> = { add: 'write', create: 'write', update: 'edit', modify: 'edit', delete: 'delete', remove: 'delete' };

export class CodexRunner implements TaskRunner {
  readonly name = 'codex';
  private readonly pm: ProcessManager;
  private readonly defaults: CodexOptions;
  private readonly bufferLines: number;
  /** Tasks whose run-log notice has already been written; the limit belongs to the task, not the attempt. */
  private readonly noticed = new Set<string>();

  constructor(opts: CodexRunnerOptions) {
    this.pm = opts.processManager;
    this.defaults = opts.defaults ?? {};
    this.bufferLines = opts.bufferLines ?? 500;
  }

  async run(input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome> {
    const options: CodexOptions = { ...this.defaults, ...input.task.codex };
    const unsafeExtraArg = codexExtraArgsSecurityConflict(options.extraArgs);
    if (unsafeExtraArg) return { kind: 'error', outcome: 'invalid_result', message: `Codex extraArgs cannot override security option "${unsafeExtraArg}"; use the validated codex permission fields` };
    const detection = await detectCodex(options.command);
    if (!detection.found) return { kind: 'error', outcome: 'crash', message: `Codex CLI not found (${detection.command}): ${detection.error ?? 'unknown error'}` };
    if (input.signal.aborted) return { kind: 'error', outcome: 'cancelled', message: 'cancelled before start' };
    if ((options.transport ?? 'exec') === 'appServer') {
      return runCodexAppServer({ processManager: this.pm, command: detection.command, options, bufferLines: this.bufferLines }, input, hooks);
    }

    await ensureDir(input.attemptDir);
    const schemaPath = path.join(input.attemptDir, 'result.schema.json');
    const outputPath = path.join(input.attemptDir, 'final.json');
    await fs.writeFile(schemaPath, JSON.stringify(CODEX_COMPLETION_CONTRACT.outputSchema), 'utf8');
    const { file, args: prefixArgs } = splitCommand(detection.command);
    const args = [...prefixArgs, ...buildCodexArgs(options, schemaPath, outputPath, input.resumeSessionId, input.task.model, input.task.effort)];
    const prompt = [CODEX_COMPLETION_CONTRACT.systemPrompt, input.systemPromptAddendum, input.prompt].filter(Boolean).join('\n\n');
    const eventsLog = createWriteStream(path.join(input.attemptDir, 'events.jsonl'), { flags: 'a' });
    const entry = (e: TranscriptEntry): void => {
      eventsLog.write(`${JSON.stringify(e)}\n`);
      hooks.onTranscript(e);
    };
    // A resumed attempt continues an earlier thread; without this its log reads like a fresh session.
    if (input.resumeSessionId) entry({ kind: 'system', ts: nowIso(), text: `resumed session ${input.resumeSessionId}` });
    // Say up front, in the attempt's own log and once per task in the run log, that nobody can be asked
    // anything during this transport: an operator should not have to learn it from a failure.
    entry({ kind: 'system', ts: nowIso(), text: CODEX_EXEC_NO_HUMAN });
    if (!this.noticed.has(input.task.id)) {
      this.noticed.add(input.task.id);
      hooks.onWarning?.(CODEX_EXEC_NO_HUMAN);
    }
    let sessionId = input.resumeSessionId;
    const model = input.task.model;
    const usage: RunnerUsage = { sessionId, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 0 };
    let sawTurn = false;
    const stderr: string[] = [];
    const commands = new Map<string, string>();
    let typedFailure: ReturnType<typeof normalizeCodexFailure> | undefined;
    // The rejection names the kind of decision Codex wanted but not the work behind it, so the command it
    // started and never completed is kept, to quote alongside the rejection.
    let pendingCommand: string | undefined;
    let blocked: CodexExecBlock | undefined;
    /** `codex exec` answers approvals and questions itself, with a rejection: recognise it, do not just log it. */
    const noteHumanRequest = (message: string): void => {
      const kind = codexExecHumanRequest(message);
      // Codex reports the same rejection twice - once as the error item, once on the failed turn - so the
      // first one is kept and reported and the echo is dropped, rather than telling the operator twice.
      if (!kind || blocked) return;
      blocked = { kind, message, wanted: kind === 'command' ? pendingCommand : undefined };
      hooks.onWarning?.(`Codex needed a human decision that \`codex exec\` rejected: ${message}`);
    };

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !ENV_TO_STRIP.includes(key)) env[key] = value;
    Object.assign(env, input.env);
    const proc = this.pm.spawn({
      taskId: input.task.id, attempt: input.attempt, command: file, args, cwd: input.cwd, env,
      timeoutMs: input.timeoutMs, stdinText: prompt, logDir: input.attemptDir, bufferLines: this.bufferLines,
      onStdoutLine: (line) => {
        let event: Record<string, any>;
        try {
          event = JSON.parse(line) as Record<string, any>;
        } catch {
          hooks.onOutput('stdout', line);
          return;
        }
        const ts = nowIso();
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          sessionId = event.thread_id;
          usage.sessionId = sessionId;
          hooks.onProcess({ pid: proc?.pid ?? -1, sessionId });
          entry({ kind: 'system', ts, text: `thread ${sessionId}${model ? ` (${model})` : ''}` });
          return;
        }
        const item = event.item as Record<string, any> | undefined;
        if (item?.type === 'command_execution') {
          const command = typeof item.command === 'string' ? item.command : Array.isArray(item.command) ? item.command.join(' ') : 'command';
          const id = String(item.id ?? command);
          if (event.type === 'item.started' || !commands.has(id)) {
            commands.set(id, command);
            pendingCommand = command;
            hooks.onActivity(`$ ${command.split(/\r?\n/)[0] ?? command}`);
            entry({ kind: 'command', ts, command, tool: 'shell' });
          }
          if (event.type === 'item.completed') {
            if (pendingCommand === command) pendingCommand = undefined;
            const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
            const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
            if (output.trim() || failed) entry({ kind: 'tool_result', ts, text: truncate(output.trim() || `exit ${item.exit_code ?? '?'}`, MAX_OUTPUT_CHARS), isError: failed });
          }
          return;
        }
        if (item?.type === 'file_change' && event.type !== 'item.started') {
          const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
          for (const c of changes) {
            const p = typeof c.path === 'string' ? c.path : undefined;
            if (!p) continue;
            const op = FILE_OPS[String(c.kind ?? 'update').toLowerCase()] ?? 'edit';
            hooks.onActivity(`${op === 'write' ? 'Write' : op === 'delete' ? 'Delete' : 'Edit'} ${p}`);
            entry({ kind: 'tool', ts, tool: 'file_change', line: `${op === 'write' ? 'Write' : op === 'delete' ? 'Delete' : 'Edit'} ${p}`, filePath: p, fileOp: op });
            hooks.onFileChange({ path: p, op });
          }
          return;
        }
        if (item?.type === 'agent_message' && typeof item.text === 'string' && event.type === 'item.completed') {
          // A completion object is protocol, not prose: it becomes a result entry. The attempt's own outcome
          // still comes from final.json below, so one the worker emitted mid-turn does not end anything.
          for (const produced of agentTextEvents(item.text, ts, { activity: firstLine, validate: CODEX_COMPLETION_CONTRACT.validate })) {
            hooks.onActivity(produced.activity);
            entry(produced.entry);
          }
          return;
        }
        if ((item?.type === 'mcp_tool_call' || item?.type === 'web_search') && event.type === 'item.started') {
          const line = item.type === 'web_search' ? `WebSearch: ${item.query ?? ''}` : `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`;
          hooks.onActivity(line);
          entry({ kind: 'tool', ts, tool: item.type, line });
          return;
        }
        if (item?.type === 'error') {
          const message = String(item.message ?? 'agent error');
          noteHumanRequest(message);
          entry({ kind: 'error', ts, text: message });
          return;
        }
        if (event.type === 'turn.completed') {
          sawTurn = true;
          const u = (event.usage ?? {}) as Record<string, unknown>;
          const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
          usage.inputTokens = (usage.inputTokens ?? 0) + n(u.input_tokens);
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + n(u.cached_input_tokens);
          usage.outputTokens = (usage.outputTokens ?? 0) + n(u.output_tokens);
          usage.contextTokens = n(u.input_tokens) + n(u.cached_input_tokens);
          usage.numTurns = (usage.numTurns ?? 0) + 1;
          hooks.onUsage({ ...usage });
          return;
        }
        if (event.type === 'error' || event.type === 'turn.failed') {
          const message = String(event.message ?? event.error?.message ?? event.error ?? line);
          const info = event.error?.codexErrorInfo ?? event.error?.codex_error_info ?? event.codexErrorInfo ?? event.codex_error_info;
          if (info !== undefined && info !== null) typedFailure = normalizeCodexFailure(info, { ...codexFailureMetadata(event.error), sessionId });
          noteHumanRequest(message);
          entry({ kind: 'error', ts, text: message });
        }
      },
      onStderrLine: (line) => {
        stderr.push(line);
        if (stderr.length > 40) stderr.shift();
        hooks.onOutput('stderr', line);
        entry({ kind: 'stderr', ts: nowIso(), text: line });
      },
    });
    hooks.onProcess({ pid: proc.pid, sessionId });
    const abort = (): void => {
      void proc?.kill('graceful');
    };
    input.signal.addEventListener('abort', abort, { once: true });
    const exit = await proc.exited;
    input.signal.removeEventListener('abort', abort);
    const finalUsage: RunnerUsage = { ...usage, sessionId, model, numTurns: sawTurn ? usage.numTurns : undefined };
    // The outcome goes through entry(), so the attempt's events.jsonl ends with the result rather than
    // stopping at the last tool call; the log is closed once, after the outcome has been decided.
    const finish = (e: Extract<TranscriptEntryInput, { kind: 'result' | 'error' }>): void => entry({ ...e, ts: nowIso() } as TranscriptEntry);
    const outcome = await (async (): Promise<RunnerOutcome> => {
      if (input.signal.aborted) return { kind: 'error', outcome: 'cancelled', message: 'cancelled by orchestrator', exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      if (exit.timedOut) {
        finish({ kind: 'error', text: `timed out after ${input.timeoutMs}ms` });
        return { kind: 'error', outcome: 'timeout', message: `timed out after ${input.timeoutMs}ms`, exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      }
      const final = await fs.readFile(outputPath, 'utf8').catch(() => '');
      if (final) {
        try {
          const parsed = CODEX_COMPLETION_CONTRACT.validate(JSON.parse(final));
          if (parsed.ok) {
            // The worker carried on after the rejection and answered the contract: its result stands.
            if (blocked) hooks.onWarning?.(`Codex was refused a human decision and finished the turn anyway: ${blocked.message}`);
            finish({ kind: 'result', status: parsed.result.status, summary: parsed.result.summary, isError: false, error: parsed.result.error });
            return { kind: 'result', result: parsed.result, exitCode: exit.code, usage: finalUsage, rawResultText: final };
          }
          if (blocked) {
            const result = codexExecNeedsInput(blocked, [parsed.error]);
            finish({ kind: 'result', status: result.status, summary: result.summary, isError: false, error: result.error });
            return { kind: 'result', result, exitCode: exit.code, usage: finalUsage };
          }
          finish({ kind: 'error', text: parsed.error });
          return { kind: 'error', outcome: 'invalid_result', message: parsed.error, exitCode: exit.code, usage: finalUsage };
        } catch { /* fall through to process result */ }
      }
      const detail = stderr.join('\n');
      // The CLI rejected an approval or a question of its own accord. Whatever the exit code says, the
      // attempt is over because a human was needed, not because the worker or the transport broke.
      if (blocked) {
        const why = exit.code !== 0 || exit.spawnError ? `Codex exited with code ${exit.code ?? 'null'}` : 'Codex finished without a schema-valid final response';
        const result = codexExecNeedsInput(blocked, [why]);
        finish({ kind: 'result', status: result.status, summary: result.summary, isError: false, error: result.error });
        return { kind: 'result', result, exitCode: exit.code, usage: finalUsage };
      }
      if (exit.code !== 0 || exit.spawnError) {
        const message = `Codex exited with code ${exit.code ?? 'null'}${detail ? `\nstderr:\n${detail}` : ''}`;
        finish({ kind: 'error', text: message });
        return { kind: 'error', outcome: typedFailure?.retryable || isTransientApiError(detail) ? 'api_error' : 'crash', message, exitCode: exit.code, signal: exit.signal, usage: finalUsage, failure: typedFailure };
      }
      finish({ kind: 'error', text: 'Codex finished without a schema-valid final response' });
      return { kind: 'error', outcome: 'invalid_result', message: 'Codex finished without a schema-valid final response', exitCode: exit.code, usage: finalUsage };
    })();
    await new Promise<void>((resolve) => eventsLog.end(() => resolve()));
    return outcome;
  }
}
