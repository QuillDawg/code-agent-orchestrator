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
 *   thinking (thinking blocks around a line of prose, plus a redacted_thinking block)
 *   edge (rename into a path with a space, binary change, delete+recreate, CRLF file) | noop (changes nothing)
 *   permission | permission-always | question | permission-cancel | permission-hang   (interactive modes, need --input-format stream-json)
 * FAKE_CLAUDE_NO_SUBAGENT_TEXT=1 drops --forward-subagent-text from the --help text.
 * FAKE_CLAUDE_DELAY_MS delays between events. FAKE_CLAUDE_TRACE=<file> appends one line per invocation
 * with cwd + prompt so tests can assert isolation and context passing; control responses received on stdin
 * are appended to <file>.control.
 */
import { appendFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude)\n');
  process.exit(0);
}

// The capability probe: the runner only passes flags this help text advertises.
if (args.includes('--help')) {
  const flags = ['--output-format <fmt>', '--input-format <fmt>', '--permission-prompt-tool <tool>', '--session-id <uuid>', '--resume <uuid>'];
  if (process.env.FAKE_CLAUDE_NO_SUBAGENT_TEXT !== '1') flags.push('--forward-subagent-text');
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${flags.map((f) => `  ${f}\n`).join('')}`);
  process.exit(0);
}

const streamInput = args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json';
const controlWaiters = new Map();
const controlResponses = new Map();

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
        resolve(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
      } else if (msg.type === 'control_response') {
        const id = msg.response?.request_id;
        if (process.env.FAKE_CLAUDE_TRACE) appendFileSync(`${process.env.FAKE_CLAUDE_TRACE}.control`, `${JSON.stringify(msg)}\n`);
        const waiter = controlWaiters.get(id);
        if (waiter) waiter(msg.response);
        else controlResponses.set(id, msg.response);
      }
    });
    rl.on('close', () => resolve(''));
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

const sessionIdx = args.indexOf('--session-id');
const resumeIdx = args.indexOf('--resume');
const resumedSessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;
const sessionId = resumedSessionId ?? (sessionIdx >= 0 ? args[sessionIdx + 1] : 'fake-session');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// Per-task overrides: FAKE_CLAUDE_TASK_MODES='{"issue-102":"failed"}' and FAKE_CLAUDE_FAIL_UNTIL_ATTEMPT='{"issue-103":2}'
// FAKE_CLAUDE_API_ERROR_UNTIL_ATTEMPT='{"issue-104":3}' emits a transient API error result for attempts below 3.
const taskModes = JSON.parse(process.env.FAKE_CLAUDE_TASK_MODES ?? '{}');
const failUntil = JSON.parse(process.env.FAKE_CLAUDE_FAIL_UNTIL_ATTEMPT ?? '{}');
const apiErrorUntil = JSON.parse(process.env.FAKE_CLAUDE_API_ERROR_UNTIL_ATTEMPT ?? '{}');
let effectiveMode = taskModes[taskId] ?? mode;
if (failUntil[taskId] !== undefined && attempt < failUntil[taskId]) effectiveMode = 'failed';
if (apiErrorUntil[taskId] !== undefined && attempt < apiErrorUntil[taskId]) effectiveMode = 'api-error';
if (process.env.CAO_ATTEMPT_KIND === 'merge') effectiveMode = process.env.FAKE_CLAUDE_MERGE_MODE ?? 'merge';

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd() });
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

const finish = (structured, opts = {}) => {
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
    modelUsage: { 'fake-model': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, contextWindow: 200000, maxOutputTokens: 32000 } },
  });
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
