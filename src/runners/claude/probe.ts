/**
 * Starting both Claude prompt modes for real, for `cao doctor`.
 *
 * The argv differs between them in exactly the place that breaks (`--input-format stream-json
 * --permission-prompt-tool stdio` versus `--permission-prompts none`), and a CLI that does not know one of
 * those flags refuses to start at all. The probe therefore sends the argv a run would send and waits for
 * the session's own `init` event, which the CLI emits before it calls the model: proof that the command
 * line was accepted, at no cost.
 */
import { splitCommand } from './detect.js';
import { buildClaudeArgs, type PromptMode } from './claude-runner.js';
import { parseClaudeEvents } from './event-parser.js';
import { claudeConfigRejection } from './transient.js';
import { uuid } from '../../util/misc.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS, probeEnv, probeWorkspace, removeProbeWorkspace,
  type AgentProbe, type ProbeOptions,
} from '../probe.js';

const PROMPT = 'Reply with the completion object and nothing else.';

/**
 * One prompt mode. The session is asked for nothing: as soon as it says it has started, it is killed, so
 * the probe costs a process and no tokens.
 */
export async function probeClaudePromptMode(mode: PromptMode, opts: ProbeOptions): Promise<AgentProbe> {
  const startedAt = Date.now();
  const label = `claude.permissionPrompts: ${mode}`;
  const dir = await probeWorkspace('cao-doctor-claude-');
  try {
    const { file, args: prefix } = splitCommand(opts.command);
    // `sessionPersistence: false` is the one thing the probe changes about a real invocation: a diagnostic
    // must not leave a saved session behind for every run of `cao doctor`.
    const args = [...prefix, ...buildClaudeArgs({ sessionPersistence: false }, uuid(), undefined, undefined, mode, false)];
    let started = false;
    let initializationFailure: string | undefined;
    const stderr: string[] = [];
    let settle: (() => void) | undefined;
    const decided = new Promise<void>((resolve) => { settle = resolve; });
    const proc = opts.processManager.spawn({
      taskId: `doctor:claude-${mode}`, attempt: 0, command: file, args, cwd: dir, env: probeEnv(opts.env),
      timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, bufferLines: 50,
      stdinText: mode === 'ask' ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n` : PROMPT,
      stdin: mode === 'ask' ? 'keep-open' : 'close',
      onStdoutLine: (line) => {
        for (const event of parseClaudeEvents(line)) {
          if (event.kind !== 'init') continue;
          started = true;
          initializationFailure ??= event.initializationFailures?.[0];
          settle?.();
        }
      },
      onStderrLine: (line) => { stderr.push(line); if (stderr.length > 20) stderr.shift(); },
    });
    await Promise.race([decided, proc.exited]);
    proc.endStdin();
    await proc.kill('graceful');
    const exit = await proc.exited;
    const rejection = claudeConfigRejection({ exitCode: exit.code, stderr: stderr.join('\n') });
    if (rejection) {
      return { runner: 'claude', mode: label, status: 'fail', detail: `rejected ${rejection.option ?? 'the invocation'}: ${rejection.detail}`, hint: `fix ${rejection.key ?? 'the claude: block'} in the workflow, or upgrade Claude Code`, durationMs: Date.now() - startedAt };
    }
    if (initializationFailure) {
      return { runner: 'claude', mode: label, status: 'fail', detail: `the session reported an initialization failure: ${initializationFailure}`, hint: 'check the MCP servers and settings this machine loads', durationMs: Date.now() - startedAt };
    }
    if (!started) {
      const last = stderr[stderr.length - 1];
      return {
        runner: 'claude', mode: label, status: 'fail',
        detail: `no session started (exit ${exit.code ?? 'null'}${exit.timedOut ? ', timed out' : ''})${last ? `: ${last}` : ''}`,
        hint: 'run `claude -p --output-format stream-json --verbose "hi"` by hand to see the whole error',
        durationMs: Date.now() - startedAt,
      };
    }
    return { runner: 'claude', mode: label, status: 'ok', detail: `${mode === 'ask' ? 'ask' : 'deny'}-mode argv accepted; the session started`, durationMs: Date.now() - startedAt };
  } finally {
    await removeProbeWorkspace(dir);
  }
}

/** Both prompt modes, in the order `cao doctor` prints them. */
export async function probeClaude(opts: ProbeOptions): Promise<AgentProbe[]> {
  return [await probeClaudePromptMode('ask', opts), await probeClaudePromptMode('deny', opts)];
}
