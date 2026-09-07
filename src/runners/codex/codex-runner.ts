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
import { TASK_RESULT_JSON_SCHEMA, validateTaskResult, CONTRACT_SYSTEM_PROMPT } from '../claude/contract.js';
import { isTransientApiError } from '../claude/transient.js';
import { ensureDir } from '../../util/fs.js';
import { nowIso, truncate } from '../../util/misc.js';

export interface CodexRunnerOptions {
  processManager: ProcessManager;
  defaults?: CodexOptions;
  bufferLines?: number;
}

const ENV_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'];
const MAX_OUTPUT_CHARS = 2000;

function resolvedPermissions(options: CodexOptions): { sandbox: NonNullable<CodexOptions['sandbox']>; approval: NonNullable<CodexOptions['approvalPolicy']> } {
  const preset = options.permissionMode ?? 'auto';
  const base = preset === 'readOnly'
    ? { sandbox: 'read-only' as const, approval: 'on-request' as const }
    : preset === 'fullAccess'
      ? { sandbox: 'danger-full-access' as const, approval: 'never' as const }
      : { sandbox: 'workspace-write' as const, approval: 'on-request' as const };
  return { sandbox: options.sandbox ?? base.sandbox, approval: options.approvalPolicy ?? base.approval };
}

/**
 * `codex exec` rejects `--ask-for-approval` (it is a TUI-only flag), so the approval policy travels as a
 * config override, which is also what the official Codex SDK does. Model/effort come before extraArgs so
 * extraArgs can override them, like the Claude runner.
 */
export function buildCodexArgs(options: CodexOptions, schemaPath: string, outputPath: string, resumeSessionId?: string, model?: string, effort?: string): string[] {
  const permissions = resolvedPermissions(options);
  const args = ['--sandbox', permissions.sandbox, '-c', `approval_policy="${permissions.approval}"`];
  if (options.profile) args.push('--profile', options.profile);
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir);
  args.push('exec');
  if (resumeSessionId) args.push('resume', resumeSessionId);
  args.push('--json', '--output-schema', schemaPath, '--output-last-message', outputPath);
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

const FILE_OPS: Record<string, FileOp> = { add: 'write', create: 'write', update: 'edit', modify: 'edit', delete: 'delete', remove: 'delete' };

export class CodexRunner implements TaskRunner {
  readonly name = 'codex';
  private readonly pm: ProcessManager;
  private readonly defaults: CodexOptions;
  private readonly bufferLines: number;

  constructor(opts: CodexRunnerOptions) {
    this.pm = opts.processManager;
    this.defaults = opts.defaults ?? {};
    this.bufferLines = opts.bufferLines ?? 500;
  }

  async run(input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome> {
    const options: CodexOptions = { ...this.defaults, ...input.task.codex };
    const detection = await detectCodex(options.command);
    if (!detection.found) return { kind: 'error', outcome: 'crash', message: `Codex CLI not found (${detection.command}): ${detection.error ?? 'unknown error'}` };
    if (input.signal.aborted) return { kind: 'error', outcome: 'cancelled', message: 'cancelled before start' };

    await ensureDir(input.attemptDir);
    const schemaPath = path.join(input.attemptDir, 'result.schema.json');
    const outputPath = path.join(input.attemptDir, 'final.json');
    await fs.writeFile(schemaPath, JSON.stringify(TASK_RESULT_JSON_SCHEMA), 'utf8');
    const { file, args: prefixArgs } = splitCommand(detection.command);
    const args = [...prefixArgs, ...buildCodexArgs(options, schemaPath, outputPath, input.resumeSessionId, input.task.model, input.task.effort)];
    const prompt = [CONTRACT_SYSTEM_PROMPT, input.systemPromptAddendum, input.prompt].filter(Boolean).join('\n\n');
    const eventsLog = createWriteStream(path.join(input.attemptDir, 'events.jsonl'), { flags: 'a' });
    const entry = (e: TranscriptEntry): void => {
      eventsLog.write(`${JSON.stringify(e)}\n`);
      hooks.onTranscript(e);
    };
    let sessionId = input.resumeSessionId;
    const model = input.task.model;
    const usage: RunnerUsage = { sessionId, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 0 };
    let sawTurn = false;
    const stderr: string[] = [];
    const commands = new Map<string, string>();

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
            hooks.onActivity(`$ ${command.split(/\r?\n/)[0] ?? command}`);
            entry({ kind: 'command', ts, command, tool: 'shell' });
          }
          if (event.type === 'item.completed') {
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
          hooks.onActivity(item.text.split(/\r?\n/)[0] ?? '');
          entry({ kind: 'text', ts, text: item.text });
          return;
        }
        if ((item?.type === 'mcp_tool_call' || item?.type === 'web_search') && event.type === 'item.started') {
          const line = item.type === 'web_search' ? `WebSearch: ${item.query ?? ''}` : `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`;
          hooks.onActivity(line);
          entry({ kind: 'tool', ts, tool: item.type, line });
          return;
        }
        if (item?.type === 'error') {
          entry({ kind: 'error', ts, text: String(item.message ?? 'agent error') });
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
          const parsed = validateTaskResult(JSON.parse(final));
          if (parsed.ok) {
            finish({ kind: 'result', status: parsed.result.status, summary: parsed.result.summary, isError: false, error: parsed.result.error });
            return { kind: 'result', result: parsed.result, exitCode: exit.code, usage: finalUsage, rawResultText: final };
          }
          finish({ kind: 'error', text: parsed.error });
          return { kind: 'error', outcome: 'invalid_result', message: parsed.error, exitCode: exit.code, usage: finalUsage };
        } catch { /* fall through to process result */ }
      }
      const detail = stderr.join('\n');
      if (exit.code !== 0 || exit.spawnError) {
        const message = `Codex exited with code ${exit.code ?? 'null'}${detail ? `\nstderr:\n${detail}` : ''}`;
        finish({ kind: 'error', text: message });
        return { kind: 'error', outcome: isTransientApiError(detail) ? 'api_error' : 'crash', message, exitCode: exit.code, signal: exit.signal, usage: finalUsage };
      }
      finish({ kind: 'error', text: 'Codex finished without a schema-valid final response' });
      return { kind: 'error', outcome: 'invalid_result', message: 'Codex finished without a schema-valid final response', exitCode: exit.code, usage: finalUsage };
    })();
    await new Promise<void>((resolve) => eventsLog.end(() => resolve()));
    return outcome;
  }
}
