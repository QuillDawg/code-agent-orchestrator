/**
 * Starting both Codex transports for real, for `cao doctor`.
 *
 * `exec` is started with a trivial OpenAI-strict output schema and a one-word prompt: that is the shortest
 * path through everything that broke real runs — the flag combination, the schema the API validates, and
 * authentication. `app-server` is taken through `initialize` and `thread/start` and then interrupted, which
 * proves the transport and the security envelope without spending a turn on it.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { splitCommand } from '../claude/detect.js';
import { codexConfigRejection } from './failure.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS, TRIVIAL_OUTPUT_SCHEMA, probeEnv, probeWorkspace, removeProbeWorkspace,
  type AgentProbe, type ProbeOptions,
} from '../probe.js';

const PROMPT = 'Reply with the JSON object {"ok": true} and nothing else. Do not run any commands.';

function fail(mode: string, detail: string, hint: string, startedAt: number): AgentProbe {
  return { runner: 'codex', mode, status: 'fail', detail, hint, durationMs: Date.now() - startedAt };
}

function ok(mode: string, detail: string, startedAt: number): AgentProbe {
  return { runner: 'codex', mode, status: 'ok', detail, durationMs: Date.now() - startedAt };
}

/**
 * `codex exec`, from the command line to the end of one trivial turn. Stopped the moment the turn resolves;
 * the CLI's own rejection wording is reported verbatim, because that is what the operator has to search for.
 */
export async function probeCodexExec(opts: ProbeOptions): Promise<AgentProbe> {
  const startedAt = Date.now();
  const dir = await probeWorkspace('cao-doctor-codex-');
  try {
    const schemaPath = path.join(dir, 'schema.json');
    const outputPath = path.join(dir, 'final.json');
    await fs.writeFile(schemaPath, JSON.stringify(TRIVIAL_OUTPUT_SCHEMA), 'utf8');
    const { file, args: prefix } = splitCommand(opts.command);
    const args = [
      ...prefix, '--sandbox', 'read-only', '-c', 'approval_policy="never"',
      'exec', '--skip-git-repo-check', '--json', '--output-schema', schemaPath, '--output-last-message', outputPath,
    ];
    let threadStarted = false;
    let failure: string | undefined;
    const stderr: string[] = [];
    const stream: string[] = [];
    let settle: (() => void) | undefined;
    const decided = new Promise<void>((resolve) => { settle = resolve; });
    const proc = opts.processManager.spawn({
      taskId: 'doctor:codex-exec', attempt: 0, command: file, args, cwd: dir, env: probeEnv(opts.env),
      timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, stdinText: PROMPT, bufferLines: 50,
      onStdoutLine: (line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (event.type === 'thread.started') { threadStarted = true; return; }
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'error') { stream.push(String(item.message ?? '')); failure ??= String(item.message ?? 'error'); }
        if (event.type === 'error' || event.type === 'turn.failed') {
          const error = event.error as Record<string, unknown> | undefined;
          const message = String(event.message ?? error?.message ?? line);
          stream.push(message);
          failure ??= message;
        }
        if (event.type === 'turn.completed' || event.type === 'turn.failed') settle?.();
      },
      onStderrLine: (line) => { stderr.push(line); if (stderr.length > 20) stderr.shift(); },
    });
    await Promise.race([decided, proc.exited]);
    await proc.kill('graceful');
    const exit = await proc.exited;
    const rejection = codexConfigRejection({ exitCode: exit.code, stderr: stderr.join('\n'), stream: stream.join('\n') });
    if (rejection) {
      return fail('codex.transport: exec', `rejected ${rejection.option ?? 'the invocation'}: ${rejection.detail}`, `fix ${rejection.key ?? 'the codex: block'} in the workflow, or upgrade the Codex CLI`, startedAt);
    }
    if (failure) return fail('codex.transport: exec', `the turn failed: ${failure}`, 'run `codex exec "hello"` by hand to see the whole error', startedAt);
    if (exit.timedOut) return fail('codex.transport: exec', `no turn resolved within ${opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS}ms`, 'check network access and `codex login status`', startedAt);
    if (!threadStarted) {
      return fail('codex.transport: exec', `no thread started (exit ${exit.code ?? 'null'})${stderr.length ? `: ${stderr[stderr.length - 1]}` : ''}`, 'run `codex exec "hello"` by hand to see the whole error', startedAt);
    }
    return ok('codex.transport: exec', 'started a turn and accepted the output schema', startedAt);
  } finally {
    await removeProbeWorkspace(dir);
  }
}

/** `codex app-server`: initialize, start a thread with the read-only envelope, then interrupt it. */
export async function probeCodexAppServer(opts: ProbeOptions): Promise<AgentProbe> {
  const startedAt = Date.now();
  const dir = await probeWorkspace('cao-doctor-codex-as-');
  try {
    const { file, args: prefix } = splitCommand(opts.command);
    let initialized = false;
    let threadId: string | undefined;
    let failure: string | undefined;
    const stderr: string[] = [];
    let settle: (() => void) | undefined;
    const decided = new Promise<void>((resolve) => { settle = resolve; });
    const proc = opts.processManager.spawn({
      taskId: 'doctor:codex-app-server', attempt: 0, command: file, args: [...prefix, 'app-server', '--stdio'], cwd: dir,
      env: probeEnv(opts.env), timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, stdin: 'keep-open', bufferLines: 50,
      onStdoutLine: (line) => {
        let message: Record<string, any>;
        try { message = JSON.parse(line) as Record<string, any>; } catch { return; }
        if (message.id === 1) {
          if (message.error) { failure = `initialize failed: ${String(message.error.message ?? JSON.stringify(message.error))}`; settle?.(); return; }
          initialized = true;
          proc.writeStdin(`${JSON.stringify({ method: 'initialized' })}\n`);
          proc.writeStdin(`${JSON.stringify({
            id: 2, method: 'thread/start',
            params: {
              cwd: dir, model: null, approvalPolicy: 'never', approvalsReviewer: 'user',
              sandbox: 'read-only', developerInstructions: '', ephemeral: true,
            },
          })}\n`);
          return;
        }
        if (message.id === 2) {
          if (message.error) failure = `thread/start failed: ${String(message.error.message ?? JSON.stringify(message.error))}`;
          else threadId = typeof message.result?.thread?.id === 'string' ? message.result.thread.id : 'started';
          settle?.();
        }
      },
      onStderrLine: (line) => { stderr.push(line); if (stderr.length > 20) stderr.shift(); },
    });
    proc.writeStdin(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'code-agent-orchestrator', title: 'cao doctor', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } } })}\n`);
    await Promise.race([decided, proc.exited]);
    // The interrupt: the thread is abandoned and the server is stopped, so nothing survives the probe.
    proc.endStdin();
    await proc.kill('graceful');
    const exit = await proc.exited;
    if (failure) {
      return fail('codex.transport: appServer', failure, 'upgrade the Codex CLI, or fix the codex: block this workflow sends', startedAt);
    }
    if (!initialized) {
      return fail('codex.transport: appServer', `the app-server did not answer initialize (exit ${exit.code ?? 'null'})${stderr.length ? `: ${stderr[stderr.length - 1]}` : ''}`, 'upgrade the Codex CLI; `codex app-server --stdio` must speak JSON-RPC on stdout', startedAt);
    }
    if (!threadId) {
      return fail('codex.transport: appServer', `initialize succeeded but no thread started (exit ${exit.code ?? 'null'})`, 'upgrade the Codex CLI', startedAt);
    }
    return ok('codex.transport: appServer', 'initialize + thread/start accepted, interrupted cleanly', startedAt);
  } finally {
    await removeProbeWorkspace(dir);
  }
}

/** Both transports, in the order `cao doctor` prints them. */
export async function probeCodex(opts: ProbeOptions): Promise<AgentProbe[]> {
  return [await probeCodexExec(opts), await probeCodexAppServer(opts)];
}
