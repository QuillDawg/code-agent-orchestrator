#!/usr/bin/env node
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const print = (text) => process.stdout.write(`${text}\n`);
if (args.includes('--version')) { print('codex-cli 0.153.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_AUTH === '0') { print('Not logged in'); process.exit(1); }
  print('Logged in'); process.exit(0);
}
if (args.includes('--help')) {
  if (args[0] === 'exec') print('Usage: codex exec --json --output-schema --ignore-user-config --ignore-rules');
  else if (args[0] === 'app-server') print('Usage: codex app-server --stdio');
  else print('Usage: codex --approve-for-me');
  process.exit(0);
}
const mode = process.env.FAKE_CODEX_MODE ?? 'success';
const emit = (value) => print(JSON.stringify(value));
const result = { status: 'success', summary: 'fake app-server completed', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] };
if (args.includes('exec')) {
  const outputFlag = args.indexOf('--output-last-message');
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.on('end', () => {
      const execResult = { ...result, summary: 'fake exec completed' };
      if (outputFlag >= 0 && args[outputFlag + 1]) writeFileSync(args[outputFlag + 1], mode === 'invalid' ? '{"status":"success"}' : JSON.stringify(execResult), 'utf8');
      emit({ type: 'thread.started', thread_id: 'codex-exec-thread-1' });
      emit({ type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'npm test' } });
      emit({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', command: 'npm test', status: 'completed', exit_code: 0, aggregated_output: 'ok' } });
      emit({ type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: JSON.stringify(execResult) } });
      emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } });
      resolve();
    });
  });
  process.exit(0);
}
if (!args.includes('app-server')) process.exit(2);

let threadId = 'codex-thread-1';
let overloaded = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    emit({ id: message.id, result: { userAgent: 'fake-codex' } });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (mode === 'overload-once' && !overloaded) {
      overloaded = true;
      emit({ id: message.id, error: { code: -32001, message: 'server overloaded' } });
      return;
    }
    threadId = message.params?.threadId ?? threadId;
    emit({ id: message.id, result: {
      thread: { id: threadId }, model: mode === 'wrong-model' ? 'other-model' : message.params?.model ?? 'fake-codex', modelProvider: 'openai', cwd: message.params?.cwd ?? process.cwd(),
      instructionSources: [], approvalPolicy: mode === 'missing-policy' ? null : message.params?.approvalPolicy ?? 'on-request', approvalsReviewer: message.params?.approvalsReviewer ?? 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null,
    } });
  } else if (message.method === 'turn/start') {
    emit({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full', error: null } } });
    if (mode === 'approval') {
      emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: Date.now(), kind: 'command', command: 'npm test', cwd: process.cwd(), proposedExecpolicyAmendment: { command: ['npm', 'test'] } } });
    } else if (mode === 'file-approval') {
      emit({ id: 98, method: 'item/fileChange/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'file-1', reason: 'update fixture', grantRoot: process.cwd() } });
    } else if (mode === 'question') {
      emit({ id: 100, method: 'item/tool/requestUserInput', params: { threadId, turnId: 'turn-1', itemId: 'q-1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'choice', header: 'Choice', question: 'Which?', isOther: false, isSecret: false, options: [{ label: 'A', description: 'first' }] }] } });
    } else if (mode === 'failure') {
      emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'failed', items: [], itemsView: 'full', error: { message: 'overloaded', codexErrorInfo: 'serverOverloaded', additionalDetails: null } } } });
    } else if (mode === 'interrupted') {
      emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'interrupted', items: [], itemsView: 'full', error: null } } });
    } else if (mode === 'mcp-failure') {
      emit({ method: 'mcpServer/startupStatus/updated', params: { threadId, name: 'required', status: 'failed', error: 'connection refused', failureReason: null } });
      emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'failed', items: [], itemsView: 'full', error: { message: 'required MCP failed', codexErrorInfo: 'badRequest', additionalDetails: null } } } });
    } else if (mode === 'malformed') {
      print('not-json');
      emit({ method: 'future/additiveNotification', params: { value: 1 } });
      finish();
    } else if (mode === 'invalid') {
      finish({ unrelated: true });
    } else if (mode === 'hang') {
      // Wait for the orchestrator to interrupt and terminate this process.
    } else finish();
  } else if (message.id === 98 || message.id === 99 || message.id === 100) {
    if (process.env.FAKE_CODEX_TRACE) process.stderr.write(`response:${JSON.stringify(message)}\n`);
    finish();
  }
});
rl.on('close', () => process.exit(0));

function finish(value = result) {
  emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: JSON.stringify(value), phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: { total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 }, last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 }, modelContextWindow: 200000 } } });
  emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [], itemsView: 'full', error: null } } });
}
