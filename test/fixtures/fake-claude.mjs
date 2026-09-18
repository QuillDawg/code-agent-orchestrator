#!/usr/bin/env node
/**
 * Fake Claude Code CLI for tests. Emits stream-json like `claude -p --output-format stream-json`.
 *
 * Behaviour is controlled by env FAKE_CLAUDE_SCRIPT (JSON) or FAKE_CLAUDE_MODE:
 *   success (default) | failed | blocked | needs_input | skipped | invalid | no-result | crash | hang | slow | prose | echo | commit
 *   shell (creates and deletes a file through the shell, invisible to the tool stream) | big (FAKE_CLAUDE_BIG_LINES)
 *   subagent (an Agent call whose entries carry parent_tool_use_id, with paired tool results)
 *   subagents (two concurrent Agent calls, one delegating again, plus a call that is never answered)
 *   orphan-tool (a single tool call whose result never arrives)
 *   open-tool-exit (a tool call, then the process leaves cleanly with no result event at all)
 *   bad-schema (the API rejects the --json-schema this session was started with)
 *   thinking (thinking blocks around a line of prose, plus a redacted_thinking block)
 *   edge (rename into a path with a space, binary change, delete+recreate, CRLF file) | noop (changes nothing)
 *   permission | permission-always | question | question-multi | permission-cancel | permission-hang
 *   permission-two (two prompts open at once, answerable in either order)
 *   permission-cancel-late (withdraws a request that has already been answered)
 *   permission-give-up (asks, is refused, and ends with an error result carrying permission_denials)
 *     (interactive modes; all but permission-give-up need --input-format stream-json)
 *   prose-no-json (ends with prose that reads like a result and no JSON at all; a --resume of the session answers with the object)
 *   question-resumable (asks one question, then completes when the session is resumed with the answer)
 *   steer (takes a user message mid-turn, ends the turn, and starts a new one from it)
 *   steer-exit (takes a user message mid-turn and dies without acknowledging it)
 *     (both need --input-format stream-json; FAKE_CLAUDE_STEER_WAIT_MS bounds the wait)
 * FAKE_CLAUDE_NO_SUBAGENT_TEXT=1 drops --forward-subagent-text from the --help text.
 * FAKE_CLAUDE_NO_REPLAY=1 drops --replay-user-messages from it, so nothing echoes a steered message back.
 * FAKE_CLAUDE_DELAY_MS delays between events. FAKE_CLAUDE_TRACE=<file> appends one line per invocation
 * with cwd + prompt so tests can assert isolation and context passing; control responses received on stdin
 * are appended to <file>.control.
 */
import { appendFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const args = process.argv.slice(2);

/**
 * The single list of flags this fake accepts, mirroring `claude --help`. `0` means the flag takes no
 * value; a string is the value placeholder shown in `--help` (the runner's capability probe reads it, so
 * `stream-json` has to appear there literally). Extending the fake is one edit, here.
 */
const FLAGS = {
  '-p': 0, '--print': 0, '--verbose': 0, '--output-format': 'stream-json', '--input-format': 'stream-json',
  '--json-schema': '<schema>', '--safe-mode': 0, '--permission-mode': '<mode>', '--permission-prompt-tool': '<tool>',
  '--permission-prompts': '<target>', '--session-id': '<uuid>', '--resume': '<uuid>', '--fork-session': 0,
  '--append-system-prompt': '<prompt>', '--system-prompt': '<prompt>', '--model': '<model>', '--effort': '<level>',
  '--max-budget-usd': '<amount>', '--allowedTools': '<tools...>', '--allowed-tools': '<tools...>',
  '--disallowedTools': '<tools...>', '--disallowed-tools': '<tools...>', '--add-dir': '<directories...>',
  '--no-session-persistence': 0, '--fallback-model': '<model>', '--settings': '<file-or-json>',
  '--mcp-config': '<configs...>', '--strict-mcp-config': 0, '--setting-sources': '<sources>',
  '--include-partial-messages': 0, '--bare': 0, '--forward-subagent-text': 0, '--replay-user-messages': 0,
  '--help': 0, '--version': 0,
};
// The flag is new: a CLI that does not advertise it does not accept it either.
if (process.env.FAKE_CLAUDE_NO_SUBAGENT_TEXT === '1') delete FLAGS['--forward-subagent-text'];
// An older CLI with no echo at all: the host can still steer, it just cannot be told the message arrived.
if (process.env.FAKE_CLAUDE_NO_REPLAY === '1') delete FLAGS['--replay-user-messages'];

if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('{"loggedIn":true,"authMethod":"fake"}\n');
  process.exit(0);
}

// The capability probe: the runner only passes flags this help text advertises.
if (args.includes('--help')) {
  const flags = Object.entries(FLAGS).map(([flag, value]) => `${flag}${value ? ` ${value}` : ''}`);
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${flags.map((f) => `  ${f}\n`).join('')}`);
  process.exit(0);
}

// Commander rejects anything it was not given a definition for; so does the real CLI.
for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (!token.startsWith('-') || token === '-' || token === '--') continue;
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  if (!(name in FLAGS)) {
    process.stderr.write(`error: unknown option '${name}'\n`);
    process.exit(2);
  }
  if (FLAGS[name] && !token.includes('=')) {
    if (i + 1 >= args.length) {
      process.stderr.write(`error: option '${name} ${FLAGS[name]}' argument missing\n`);
      process.exit(2);
    }
    i++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// Declared before stdin is read: with `--replay-user-messages` the very first user message is echoed back
// the moment it arrives, which is while the promise below is still being awaited.
const sessionIdx = args.indexOf('--session-id');
const resumeIdx = args.indexOf('--resume');
const resumedSessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;
const sessionId = resumedSessionId ?? (sessionIdx >= 0 ? args[sessionIdx + 1] : 'fake-session');

const streamInput = args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json';
// Control requests are only routed to stdin when the session was started with a stdio permission tool;
// without it the CLI answers them itself (it denies), and the host never sees them.
const canAskHost = streamInput && args.includes('--permission-prompt-tool') && args[args.indexOf('--permission-prompt-tool') + 1] === 'stdio';
const replayUserMessages = args.includes('--replay-user-messages');
const controlWaiters = new Map();
const controlResponses = new Map();

/**
 * User messages after the first, i.e. what the host steered in while a turn was running. The real CLI queues
 * one and starts a new turn when the current one ends; `finished` is set once the last result has gone out,
 * and a message arriving after that is refused the way the real CLI refuses input on a closed session.
 */
let firstUserMessage = false;
let finished = false;
let stdinClosed = false;
const steered = [];
let steerWaiter = null;

/** Wait for the next steered message, or give up after `ms` so no mode can hang the suite. */
const nextSteer = (ms = 2000) =>
  new Promise((resolve) => {
    if (steered.length) return resolve(steered.shift());
    const timer = setTimeout(() => {
      steerWaiter = null;
      resolve(undefined);
    }, ms);
    steerWaiter = (text) => {
      clearTimeout(timer);
      steerWaiter = null;
      resolve(text);
    };
  });

const prompt = await new Promise((resolve) => {
  if (streamInput) {
    // Interactive mode: the first user message is the prompt; control responses keep arriving afterwards.
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'user') {
        const content = msg.message?.content;
        const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        if (finished) {
          // Nothing can be sent to a session that has already produced its final result.
          process.stderr.write('error: the session has ended and is no longer accepting input\n');
          process.exit(4);
        }
        // `--replay-user-messages` re-emits every user message the CLI was handed, the prompt included.
        if (replayUserMessages) emit({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId });
        if (!firstUserMessage) {
          firstUserMessage = true;
          resolve(text);
        } else if (steerWaiter) steerWaiter(text);
        else steered.push(text);
      } else if (msg.type === 'control_response') {
        const id = msg.response?.request_id;
        if (process.env.FAKE_CLAUDE_TRACE) appendFileSync(`${process.env.FAKE_CLAUDE_TRACE}.control`, `${JSON.stringify(msg)}\n`);
        const waiter = controlWaiters.get(id);
        if (waiter) waiter(msg.response);
        else controlResponses.set(id, msg.response);
      }
    });
    rl.on('close', () => {
      // "No more input": the real CLI finishes what it is doing and leaves. A message it had queued for a
      // new turn never gets that turn, which is why the host must not close stdin while one is owed.
      stdinClosed = true;
      resolve('');
    });
    setTimeout(() => resolve(''), 5000);
    return;
  }
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', () => resolve(data));
  setTimeout(() => resolve(data), 2000);
});

const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
const taskId = process.env.CAO_TASK_ID ?? 'unknown';
const attempt = Number(process.env.CAO_ATTEMPT ?? 1);

if (process.env.FAKE_CLAUDE_TRACE) {
  mkdirSync(path.dirname(process.env.FAKE_CLAUDE_TRACE), { recursive: true });
  appendFileSync(
    process.env.FAKE_CLAUDE_TRACE,
    `${JSON.stringify({ taskId, attempt, cwd: process.cwd(), pid: process.pid, args, prompt, streamInput, env: { CAO_ATTEMPT_KIND: process.env.CAO_ATTEMPT_KIND } })}\n`,
  );
}

// Per-task overrides: FAKE_CLAUDE_TASK_MODES='{"issue-102":"failed"}' and FAKE_CLAUDE_FAIL_UNTIL_ATTEMPT='{"issue-103":2}'
// FAKE_CLAUDE_API_ERROR_UNTIL_ATTEMPT='{"issue-104":3}' emits a transient API error result for attempts below 3.
const taskModes = JSON.parse(process.env.FAKE_CLAUDE_TASK_MODES ?? '{}');
const failUntil = JSON.parse(process.env.FAKE_CLAUDE_FAIL_UNTIL_ATTEMPT ?? '{}');
const apiErrorUntil = JSON.parse(process.env.FAKE_CLAUDE_API_ERROR_UNTIL_ATTEMPT ?? '{}');
let effectiveMode = taskModes[taskId] ?? mode;
if (failUntil[taskId] !== undefined && attempt < failUntil[taskId]) effectiveMode = 'failed';
if (apiErrorUntil[taskId] !== undefined && attempt < apiErrorUntil[taskId]) effectiveMode = 'api-error';
if (process.env.CAO_ATTEMPT_KIND === 'merge') effectiveMode = process.env.FAKE_CLAUDE_MERGE_MODE ?? 'merge';

// The real CLI reports the mode it actually runs in; FAKE_CLAUDE_PERMISSION_MODE simulates a model it downgrades.
const permissionModeIdx = args.indexOf('--permission-mode');
const permissionMode = process.env.FAKE_CLAUDE_PERMISSION_MODE ?? (permissionModeIdx >= 0 ? args[permissionModeIdx + 1] : 'default');
emit({
  type: 'system', subtype: 'init', session_id: sessionId, model: process.env.FAKE_CLAUDE_MODEL ?? 'fake-model', cwd: process.cwd(), permissionMode,
  capabilities: ['stream-json', 'structured-output'],
  ...(process.env.FAKE_CLAUDE_INIT_FAILURE === '1' ? { mcp_server_errors: [{ name: 'required', error: 'connection refused' }] } : {}),
});
await sleep(delay);

const result = (status, extra = {}) => ({
  status,
  summary: `Fake ${status} for ${taskId} (attempt ${attempt})`,
  filesChanged: [`src/${taskId}.ts`],
  commits: [],
  decisions: [`decision-${taskId}`],
  warnings: [],
  followUp: [],
  ...extra,
});

const finish = (structured, opts = {}, last = true) => {
  // The real CLI says its final answer twice: once as the last assistant message (which, in a structured-output
  // session, is the completion object itself) and once in the result event. A fake that only emits the second
  // one agrees with any runner that renders the first as agent prose.
  const finalMessage = opts.text ?? (structured ? JSON.stringify(structured) : '');
  if (finalMessage && !opts.isError) text(finalMessage);
  emit({
    type: 'result',
    subtype: opts.subtype ?? 'success',
    is_error: opts.isError ?? false,
    result: opts.text ?? (structured ? JSON.stringify(structured) : ''),
    structured_output: structured,
    session_id: sessionId,
    total_cost_usd: 0.01,
    duration_ms: 100,
    num_turns: 2,
    stop_reason: 'end_turn',
    ...(opts.permissionDenials ? { permission_denials: opts.permissionDenials } : {}),
    modelUsage: { 'fake-model': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, contextWindow: 200000, maxOutputTokens: 32000 } },
  });
  // A turn boundary that another turn follows is not the end of the session; only the last one is.
  finished = last;
};

let toolSeq = 0;
/** Emit a tool call and return its tool_use id. `parent` marks it as coming from a subagent. */
const toolUse = (name, input, parent) => {
  const id = `t${++toolSeq}`;
  emit({
    type: 'assistant',
    parent_tool_use_id: parent ?? null,
    message: { id: `msg_${toolSeq}`, model: 'fake-model', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 100 + toolSeq, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  return id;
};
/** The result of a tool call, addressed to the id `toolUse` returned. */
const toolResult = (toolUseId, content, parent) =>
  emit({ type: 'user', parent_tool_use_id: parent ?? null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }] } });
const text = (t, parent) => emit({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { id: `msg_${++toolSeq}`, model: 'fake-model', content: [{ type: 'text', text: t }], usage: { input_tokens: 100 + toolSeq, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
/** A thinking block, in the shape the real CLI emits it. */
const thinking = (t, parent) => emit({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { id: `msg_${++toolSeq}`, model: 'fake-model', content: [{ type: 'thinking', thinking: t, signature: 'sig' }] } });

let requestSeq = 0;
/** Ask the host for permission (or an answer) and wait for its control_response. */
const askHost = (toolName, input, extra = {}) => {
  const requestId = `req-${process.pid}-${++requestSeq}`;
  // No stdio permission tool: the CLI answers for the host, and the host is never asked.
  if (!canAskHost) {
    process.stderr.write(`Permission request for ${toolName} denied: no permission prompt tool is configured for this session\n`);
    return Promise.resolve({ subtype: 'success', response: { behavior: 'deny', message: 'no permission prompt tool is configured for this session' } });
  }
  emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, display_name: toolName, input, tool_use_id: `tu-${requestSeq}`, ...extra } });
  const known = controlResponses.get(requestId);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => controlWaiters.set(requestId, resolve));
};

switch (effectiveMode) {
  case 'success': {
    toolUse('Read', { file_path: `src/${taskId}.ts` });
    await sleep(delay);
    text(`Working on ${taskId}`);
    await sleep(delay);
    finish(result('success'));
    break;
  }
  // A turn the host steers into: the second user message arrives while turn 1 is running, turn 1 ends with
  // its own result, and turn 2 starts from the steered text. `--replay-user-messages` (when the runner
  // passed it) has already echoed the message by the time this sees it.
  case 'steer': {
    text(`Working on ${taskId}`);
    const message = await nextSteer(Number(process.env.FAKE_CLAUDE_STEER_WAIT_MS ?? 3000));
    if (!message) {
      finish(result('success', { summary: `Nothing was steered into ${taskId}` }));
      break;
    }
    // Turn 1's own boundary. Not the session's last result: turn 2 follows and overwrites it.
    finish(undefined, { text: 'Stopping here to take your message.' }, false);
    // Long enough for a host that closed stdin at the boundary to have done so. The queued turn only runs
    // while the session is still accepting input, exactly as the real CLI behaves.
    await sleep(Math.max(delay, 100));
    if (stdinClosed) {
      process.stderr.write('error: input was closed before the queued message could start its turn\n');
      process.exit(6);
    }
    text(`Continuing with: ${message}`);
    finish(result('success', { summary: `Steered ${taskId}`, data: { steered: message } }));
    break;
  }
  // Takes the message and dies before acknowledging it: the delivery must end up `failed`, not `queued`.
  case 'steer-exit': {
    text(`Working on ${taskId}`);
    const message = await nextSteer(Number(process.env.FAKE_CLAUDE_STEER_WAIT_MS ?? 3000));
    process.stderr.write(`fatal: crashed while holding ${message ? 'a steered message' : 'nothing'}\n`);
    process.exit(5);
    break;
  }
  case 'thinking': {
    // Thinking, prose and a redacted block: only the readable ones become entries.
    thinking('Let me consider the options here.');
    text(`Working on ${taskId}`);
    emit({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_redacted', model: 'fake-model', content: [{ type: 'redacted_thinking', data: 'opaque' }] } });
    thinking('Second thought.');
    finish(result('success'));
    break;
  }
  case 'subagent': {
    // A delegating session: an Agent call, the subagent's own text and tool calls (each tagged with
    // parent_tool_use_id), then the Agent's result. Every call is paired with a result so timing shows up.
    const read = toolUse('Read', { file_path: `src/${taskId}.ts` });
    await sleep(delay || 20);
    toolResult(read, 'file contents');
    const agent = toolUse('Agent', { description: 'Review the diff', prompt: 'Review the diff and report findings' });
    text('Reviewing the diff', agent);
    const grep = toolUse('Grep', { pattern: 'TODO', path: 'src' }, agent);
    await sleep(delay || 20);
    toolResult(grep, 'src/a.ts:1:TODO', agent);
    toolResult(agent, 'Found 1 TODO');
    text(`Delegated review of ${taskId}`);
    finish(result('success'));
    break;
  }
  case 'subagents': {
    // Two subagents at once, one of which delegates again, plus a call whose result never arrives (the
    // shapes a transcript has to survive: interleaved parents, a grandchild, and a tool left open).
    const alpha = toolUse('Agent', { description: 'Review the diff' });
    const beta = toolUse('Agent', { description: 'Check the tests' });
    text('Reviewing the diff', alpha);
    const grep = toolUse('Grep', { pattern: 'TODO', path: 'src' }, alpha);
    const check = toolUse('Bash', { command: 'npm test' }, beta);
    await sleep(delay || 20);
    toolResult(grep, 'src/a.ts:1:TODO', alpha);
    const gamma = toolUse('Agent', { description: 'Dig into src/a.ts' }, alpha);
    text('Digging in', gamma);
    const read = toolUse('Read', { file_path: 'src/a.ts' }, gamma);
    await sleep(delay || 20);
    toolResult(read, 'the contents', gamma);
    toolResult(gamma, 'One stale TODO', alpha);
    toolResult(check, 'tests passed', beta);
    // Never answered: the session ends with this tool still open.
    toolUse('Write', { file_path: 'src/never.ts' });
    toolResult(alpha, 'Found 1 TODO');
    toolResult(beta, 'Tests are fine');
    finish(result('success'));
    break;
  }
  case 'open-tool-exit': {
    // The process leaves while a tool call it made is still unanswered: the turn was cut short, and there
    // is no result event to explain it. Nothing may report this as "the worker forgot the JSON".
    toolUse('Bash', { command: 'npm run build' });
    await sleep(delay || 20);
    process.exit(0);
    break;
  }
  case 'bad-schema': {
    // The `invalid_json_schema` 400 the API returns when the structured-output schema is not strict.
    finish(undefined, {
      isError: true,
      subtype: 'error_during_execution',
      text: "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid_json_schema: output schema is invalid: 'additionalProperties' is required to be supplied and to be false.\"}}",
    });
    break;
  }
  case 'orphan-tool': {
    // One tool call, no result: nothing may be counted as time spent in it.
    toolUse('Bash', { command: 'sleep 100' });
    await sleep(delay || 60);
    finish(result('success'));
    break;
  }
  case 'commit': {
    // Simulate an implementation task that writes a file and commits it (used for worktree tests).
    const file = path.join(process.cwd(), `${taskId}.txt`);
    writeFileSync(file, `${taskId} attempt ${attempt}\n`);
    toolUse('Write', { file_path: file });
    try {
      execSync('git add -A', { stdio: 'ignore' });
      execSync(`git -c user.name=fake -c user.email=fake@example.com commit -q -m "feat: ${taskId}"`, { stdio: 'ignore' });
    } catch {
      /* not a git repo */
    }
    finish(result('success', { commits: [`feat: ${taskId}`] }));
    break;
  }
  case 'shell': {
    // Everything happens through the shell: the tool stream carries a command, never a file path, so only a
    // real diff of the working tree can see the created and the deleted file.
    const created = `${taskId}-created.txt`;
    toolUse('Bash', { command: `echo created > ${created} && rm README.md` });
    execSync(`echo created > ${created}`, { stdio: 'ignore' });
    execSync(process.platform === 'win32' ? 'del /f /q README.md' : 'rm -f README.md', { stdio: 'ignore' });
    finish(result('success', { filesChanged: [created, 'README.md'] }));
    break;
  }
  case 'big': {
    // A change far larger than a small git.maxDiffBytes, to exercise patch truncation.
    const lines = Number(process.env.FAKE_CLAUDE_BIG_LINES ?? 500);
    const file = `${taskId}-big.txt`;
    writeFileSync(path.join(process.cwd(), file), `${Array.from({ length: lines }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n')}\n`);
    toolUse('Write', { file_path: file });
    finish(result('success', { filesChanged: [file] }));
    break;
  }
  case 'edge': {
    // The shapes a diff has to survive: a rename into a directory whose name has a space, a modified binary
    // file, a file deleted and re-created with different content, and a new file with CRLF line endings.
    const at = (p) => path.join(process.cwd(), p);
    mkdirSync(at('renamed dir'), { recursive: true });
    renameSync(at('moved.txt'), at('renamed dir/renamed file.txt'));
    writeFileSync(at('blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 253]));
    rmSync(at('deleted-recreated.txt'), { force: true });
    writeFileSync(at('deleted-recreated.txt'), 'recreated\n');
    writeFileSync(at('crlf.txt'), 'one\r\ntwo\r\n');
    toolUse('Write', { file_path: 'crlf.txt' });
    finish(result('success', { filesChanged: ['renamed dir/renamed file.txt', 'blob.bin', 'deleted-recreated.txt', 'crlf.txt'] }));
    break;
  }
  case 'noop':
    // A session that changes nothing at all: the diff must be empty, not missing.
    text('nothing to change');
    finish(result('success', { filesChanged: [] }));
    break;
  case 'conflict': {
    // Every task writes the same file with different content to force merge conflicts.
    const file = path.join(process.cwd(), 'shared.txt');
    writeFileSync(file, `content from ${taskId}\n`);
    try {
      execSync('git add -A', { stdio: 'ignore' });
      execSync(`git -c user.name=fake -c user.email=fake@example.com commit -q -m "feat: ${taskId} shared"`, { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    finish(result('success'));
    break;
  }
  case 'merge': {
    // Merge-resolution session: perform the merge favouring "theirs" and commit.
    const m = /git merge --no-ff (\S+)/.exec(prompt);
    const branch = m ? m[1].replace(/`/g, '') : null;
    if (branch) {
      try {
        execSync(`git merge --no-ff --no-commit ${branch}`, { stdio: 'ignore' });
      } catch {
        /* conflicts expected */
      }
      try {
        execSync(`git checkout --theirs .`, { stdio: 'ignore' });
        execSync('git add -A', { stdio: 'ignore' });
        execSync(`git -c user.name=fake -c user.email=fake@example.com commit -q --no-edit -m "Merge ${branch} (resolved by fake claude)"`, { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
    finish(result('success', { summary: `Merged ${branch ?? '?'}` }));
    break;
  }
  case 'merge-fail':
    finish(result('failed', { error: 'could not resolve' }));
    break;
  case 'failed':
    text('Something went wrong');
    finish(result('failed', { error: `simulated failure for ${taskId}` }));
    break;
  case 'blocked':
    finish(result('blocked', { error: 'blocked by missing dependency' }));
    break;
  case 'needs_input':
    finish(result('needs_input', { error: 'Which database should I use?' }));
    break;
  case 'skipped':
    finish(result('skipped', { summary: 'nothing to do' }));
    break;
  case 'invalid':
    finish({ foo: 'bar' });
    break;
  case 'prose':
    // No structured_output, but a JSON block in the result text.
    finish(undefined, { text: `Done!\n\n\`\`\`json\n${JSON.stringify(result('success'))}\n\`\`\`` });
    break;
  case 'no-result':
    text('I stopped early');
    break;
  case 'prose-no-json': {
    // A weaker model's ending: prose that reads like a result, but no JSON anywhere. The orchestrator's nudge
    // resumes the session, and only then does the object arrive.
    if (resumedSessionId) {
      finish(result('success', { summary: `Nudged ${taskId}` }));
      break;
    }
    finish(undefined, { text: 'Success - implemented the change and ran the tests.' });
    break;
  }
  case 'error-result':
    finish(undefined, { isError: true, subtype: 'error_max_turns', text: 'max turns reached' });
    break;
  case 'api-error':
    // What the real CLI prints when its own retries give up on a 5xx: an error result, then exit.
    toolUse('Read', { file_path: `src/${taskId}.ts` });
    finish(undefined, {
      isError: true,
      subtype: 'error_during_execution',
      text: 'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
    });
    break;
  case 'api-error-stderr':
    process.stderr.write('TypeError: fetch failed\n    at node:internal/deps/undici/undici (ECONNRESET)\n');
    process.exit(1);
    break;
  case 'crash':
    process.stderr.write('fatal: boom\n');
    process.exit(3);
    break;
  case 'hang':
    text('hanging forever');
    // Spawn a grandchild to verify tree kill.
    (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise(() => {});
    break;
  case 'slow': {
    for (let i = 0; i < 5; i++) {
      toolUse('Bash', { command: `step ${i}` });
      await sleep(delay || 200);
    }
    finish(result('success'));
    break;
  }
  case 'echo':
    finish(result('success', { summary: prompt.slice(0, 2000), data: { promptLength: prompt.length } }));
    break;
  case 'permission':
  case 'permission-always': {
    // A tool call the permission mode does not auto-approve: the host must answer.
    const response = await askHost('Bash', { command: 'rm -rf build', description: 'Clean the build directory' }, { description: 'Clean the build directory', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'localSettings' }] });
    if (response.subtype === 'success' && response.response?.behavior === 'allow') {
      toolUse('Bash', { command: 'rm -rf build' });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'removed build/', is_error: false }] } });
      finish(result('success', { data: { permission: 'allowed', updatedPermissions: response.response.updatedPermissions ?? null } }));
    } else {
      finish(result('needs_input', { error: response.response?.message ?? response.error ?? 'denied' }));
    }
    break;
  }
  // Asked once; a --resume of the session carries the operator's answer as the next user message, and the
  // worker continues from there rather than asking again.
  case 'question-resumable': {
    if (resumedSessionId) {
      finish(result('success', { data: { resumedWith: prompt } }));
      break;
    }
    const questions = [{ question: 'Which database?', header: 'Database', options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }], multiSelect: false }];
    const response = await askHost('AskUserQuestion', { questions }, { requires_user_interaction: true });
    if (response.subtype === 'success' && response.response?.behavior === 'allow') {
      finish(result('success', { data: { answers: response.response.updatedInput?.answers ?? {} } }));
    } else {
      finish(result('needs_input', { error: response.response?.message ?? 'no answer' }));
    }
    break;
  }
  case 'question': {
    const questions = [{ question: 'Which database?', header: 'Database', options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }], multiSelect: false }];
    const response = await askHost('AskUserQuestion', { questions }, { requires_user_interaction: true });
    if (response.subtype === 'success' && response.response?.behavior === 'allow') {
      const answers = response.response.updatedInput?.answers ?? {};
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: `Your questions have been answered: ${JSON.stringify(answers)}` }] } });
      finish(result('success', { data: { answers } }));
    } else {
      finish(result('needs_input', { error: response.response?.message ?? 'no answer' }));
    }
    break;
  }
  case 'permission-two': {
    // Two tool calls in flight at once: both requests are on the wire before either is answered, so the
    // host can answer them in any order. The worker only carries on once it has both.
    const build = askHost('Bash', { command: 'npm run build' }, { description: 'Build the project', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }], behavior: 'allow', destination: 'localSettings' }] });
    const write = askHost('Write', { file_path: 'src/new.ts' });
    const settled = [];
    const both = await Promise.all([build.then((r) => (settled.push('build'), r)), write.then((r) => (settled.push('write'), r))]);
    const allowed = both.every((r) => r.subtype === 'success' && r.response?.behavior === 'allow');
    finish(result(allowed ? 'success' : 'needs_input', { data: { settled, decisions: both.map((r) => r.response?.behavior ?? r.subtype) }, ...(allowed ? {} : { error: both.map((r) => r.response?.message ?? 'denied').join(' | ') }) }));
    break;
  }
  case 'permission-cancel-late': {
    // The worker withdraws a request it has already had an answer to. A host that forgot a settled request
    // can be settled twice would answer the next prompt with this one's decision.
    const requestId = `req-${process.pid}-late`;
    emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo late' }, tool_use_id: 'tu-l' } });
    const answered = await new Promise((resolve) => {
      const known = controlResponses.get(requestId);
      if (known) resolve(known);
      else controlWaiters.set(requestId, resolve);
    });
    emit({ type: 'control_cancel_request', request_id: requestId });
    await sleep(50);
    // A second prompt afterwards proves the late cancel did not disturb the next request.
    const second = await askHost('Bash', { command: 'echo after' });
    finish(result('success', { data: { first: answered.response?.behavior ?? answered.subtype, second: second.response?.behavior ?? second.subtype } }));
    break;
  }
  case 'permission-give-up': {
    // Refused, and unable to go on: the session ends with an error result and the CLI's own denial record.
    const response = await askHost('Bash', { command: 'npm publish', description: 'Publish the package' });
    if (response.subtype === 'success' && response.response?.behavior === 'allow') {
      finish(result('success', { data: { permission: 'allowed' } }));
      break;
    }
    finish(undefined, {
      isError: true,
      subtype: 'error_during_execution',
      text: 'I could not continue without running npm publish.',
      permissionDenials: [{ tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'npm publish' } }],
    });
    break;
  }
  case 'question-multi': {
    const questions = [
      { question: 'Which database?', header: 'Database', options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }], multiSelect: false },
      { question: 'Which regions?', header: 'Regions', options: [{ label: 'eu', description: 'Europe' }, { label: 'us', description: 'North America' }], multiSelect: true },
    ];
    const response = await askHost('AskUserQuestion', { questions }, { requires_user_interaction: true });
    if (response.subtype === 'success' && response.response?.behavior === 'allow') {
      finish(result('success', { data: { answers: response.response.updatedInput?.answers ?? {} } }));
    } else {
      finish(result('needs_input', { error: response.response?.message ?? 'no answer' }));
    }
    break;
  }
  case 'permission-cancel': {
    // The worker withdraws its own request (e.g. the turn was interrupted) and carries on.
    const requestId = `req-${process.pid}-cancel`;
    emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'tu-c' } });
    await sleep(100);
    emit({ type: 'control_cancel_request', request_id: requestId });
    await sleep(50);
    finish(result('success', { data: { cancelled: true } }));
    break;
  }
  case 'permission-hang': {
    // Asks and never gets on with it: used for abort/timeout tests. Whatever the host answers, keep waiting.
    await askHost('Bash', { command: 'sleep forever' });
    await new Promise(() => {});
    break;
  }
  default:
    finish(result('success'));
}
process.exit(0);
