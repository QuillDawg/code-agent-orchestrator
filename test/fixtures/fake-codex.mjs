#!/usr/bin/env node
/**
 * Fake Codex CLI for tests. Speaks `codex exec --json` JSONL and the `codex app-server` JSON-RPC dialect.
 *
 * It is deliberately as strict as the real binary about its own command line: FLAGS below is the single
 * list of flags it accepts (mirroring `codex --help`, `codex exec --help`, `codex exec resume --help` and
 * `codex app-server --help` of codex-cli 0.154.0), and anything else exits 2 with clap's wording. Adding a
 * flag to the fake is one edit, in FLAGS.
 *
 * Every `exec` and `turn/start` call also validates its output schema the way the API does: a schema that
 * is not OpenAI-strict fails with the `invalid_json_schema` 400, whatever the mode.
 *
 * Behaviour is controlled by env FAKE_CODEX_MODE, or per task by FAKE_CODEX_TASK_MODES='{"a":"hang"}':
 *   success (default) | invalid | api-error | hang | strict-schema | interim | schema-rejected
 *   schema-rejected: the API refuses the output schema (exec: an error item and a failed turn;
 *                    app-server: JSON-RPC -32602 on turn/start), whatever schema was actually sent
 *   exec only:       open-command (a command is started and the process leaves without completing it) |
 *                    exec-approval (the CLI rejects a command approval mid-turn and the turn fails) |
 *                    exec-user-input (the CLI rejects request_user_input; the turn ends with no result)
 *   app-server only: approval | approval-always | approval-decline | file-approval | two-approvals |
 *                    steer (holds the turn open for a `turn/steer`; FAKE_CODEX_STEER selects a refusal:
 *                    no-turn | review | compact | empty-input | schema, or `wedged` to take the request
 *                    and never answer it, and FAKE_CODEX_STEER_WAIT_MS
 *                    bounds how long the turn waits) |
 *                    question |
 *                    question-multi | question-recovers | question-then-resume | unknown-request |
 *                    failure | interrupted |
 *                    mcp-failure | malformed | overload-once | wrong-model | missing-policy
 * Responses to the server's own requests are validated against the app-server protocol schemas of
 * codex-cli 0.154.0 the way the real server would: a decision or an answer map of the wrong shape fails
 * the turn with the violation, instead of being quietly accepted.
 * `interim` emits a completion object mid-turn, keeps working, and finishes with a different one.
 * `invalid`, `api-error` and `failure` recover when the session is resumed, so a run can exercise
 * nudge-then-success and transient-error-then-resume.
 * FAKE_CODEX_RESUME_CONFLICT=1 makes `thread/resume` answer "already has an active writer".
 * FAKE_CODEX_AUTH=0 makes `login status` fail. FAKE_CODEX_TRACE=<file> appends one JSON line per
 * invocation (task, attempt, cwd, argv, prompt) so tests can assert what CAO actually launched.
 *
 * The account methods the usage footer reads (spec §3.6, §7.2), app-server only. Both are account-scoped:
 * they need no thread and start no turn, and each one appends a trace line naming the method, so a test can
 * prove a headless run never asked.
 *   FAKE_CODEX_ACCOUNT = chatgpt (default) | apiKey | none | refused
 *     chatgpt: `account/read` answers {type:'chatgpt', email, planType}; apiKey and none answer the shapes
 *     the server gives an API-key login and a machine with no login; refused additionally makes
 *     `account/rateLimits/read` fail with the server's -32600 "chatgpt authentication required" message.
 *   FAKE_CODEX_RATE_LIMITS = default (300-minute primary, 10080-minute secondary) | no-secondary (the
 *     secondary window is null) | by-limit-id (the default pair plus a `rateLimitsByLimitId` map)
 *   FAKE_CODEX_RATE_LIMITS_UPDATE=1 emits one sparse `account/rateLimits/updated` during the turn.
 */
import readline from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const print = (text) => process.stdout.write(`${text}\n`);
const emit = (value) => print(JSON.stringify(value));

// ---------------------------------------------------------------------------
// The command line the real binary accepts. `1` marks a flag that takes a value.
// ---------------------------------------------------------------------------
const ROOT_ONLY = { '--remote': 1, '--remote-auth-token-env': 1, '-a': 1, '--ask-for-approval': 1, '--search': 0, '--no-alt-screen': 0 };
const SHARED = {
  '-c': 1, '--config': 1, '--enable': 1, '--disable': 1, '--strict-config': 0, '-i': 1, '--image': 1,
  '-m': 1, '--model': 1, '--oss': 0, '--local-provider': 1, '-h': 0, '--help': 0, '-V': 0, '--version': 0,
};
const SESSION = {
  '-p': 1, '--profile': 1, '-s': 1, '--sandbox': 1, '--approve-for-me': 0,
  '--dangerously-bypass-approvals-and-sandbox': 0, '--dangerously-bypass-hook-trust': 0,
  '-C': 1, '--cd': 1, '--worktree': 0, '--add-dir': 1,
};
const EXEC_ONLY = {
  '--thread-source': 1, '--skip-git-repo-check': 0, '--ephemeral': 0, '--ignore-user-config': 0,
  '--ignore-rules': 0, '--output-schema': 1, '--color': 1, '--json': 0, '-o': 1, '--output-last-message': 1,
};

/** Every command line this fake understands, with its flags, its subcommands and its usage banner. */
const FLAGS = {
  '': {
    flags: { ...SHARED, ...SESSION, ...ROOT_ONLY },
    subcommands: ['exec', 'app-server', 'login', 'logout', 'review', 'doctor', 'resume', 'fork', 'help'],
    usage: ['Usage: codex [OPTIONS] [PROMPT]', '       codex [OPTIONS] <COMMAND> [ARGS]'],
  },
  exec: {
    flags: { ...SHARED, ...SESSION, ...EXEC_ONLY },
    subcommands: ['resume', 'fork', 'review', 'help'],
    usage: ['Usage: codex exec [OPTIONS] [PROMPT]', '       codex exec [OPTIONS] <COMMAND> [ARGS]'],
  },
  // `exec resume` re-declares only the flags it can still honour: no sandbox, profile, add-dir or cd.
  'exec resume': {
    flags: {
      ...SHARED, ...EXEC_ONLY, '--last': 0, '--all': 0, '--worktree': 0,
      '--dangerously-bypass-approvals-and-sandbox': 0, '--dangerously-bypass-hook-trust': 0,
    },
    subcommands: [],
    usage: ['Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]'],
  },
  'app-server': {
    flags: {
      '-c': 1, '--config': 1, '--enable': 1, '--disable': 1, '--code-mode-host': 1, '--strict-config': 0,
      '--listen': 1, '--stdio': 0, '--analytics-default-enabled': 0, '--ws-auth': 1, '--ws-token-file': 1,
      '--ws-token-sha256': 1, '--ws-shared-secret-file': 1, '--ws-issuer': 1, '--ws-audience': 1,
      '--ws-max-clock-skew-seconds': 1, '-h': 0, '--help': 0,
    },
    subcommands: ['daemon', 'proxy', 'generate-ts', 'generate-json-schema', 'help'],
    usage: ['Usage: codex app-server [OPTIONS] [COMMAND]'],
  },
};

/** Exit the way clap does: the error, an optional tip, the usage banner of the scope that rejected it. */
function fail(message, scope, tipFor) {
  const tip = tipFor ? `\n  tip: to pass '${tipFor}' as a value, use '-- ${tipFor}'\n` : '';
  const usage = FLAGS[scope] ? `\n${FLAGS[scope].usage.join('\n')}\n` : '';
  process.stderr.write(`error: ${message}\n${tip}${usage}\nFor more information, try '--help'.\n`);
  process.exit(2);
}

/**
 * Walk the command line the way clap does: a flag is looked up in the scope it appears in, so a global
 * flag written after `exec` is as unknown as one CAO invented.
 */
function parseCommandLine(argv) {
  let scope = '';
  let positionals = 0;
  const seen = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') break;
    if (token.startsWith('-') && token !== '-') {
      const equals = token.indexOf('=');
      const name = equals >= 0 ? token.slice(0, equals) : token;
      const table = FLAGS[scope].flags;
      if (!(name in table)) fail(`unexpected argument '${name}' found`, scope, name);
      seen.push({ name, value: equals >= 0 ? token.slice(equals + 1) : argv[index + 1] });
      if (table[name] === 1 && equals < 0) {
        if (index + 1 >= argv.length) fail(`a value is required for '${name} <VALUE>' but none was supplied`, scope);
        index++;
      }
      continue;
    }
    if (!positionals && FLAGS[scope].subcommands.includes(token)) {
      const nested = scope ? `${scope} ${token}` : token;
      if (!FLAGS[nested]) fail(`the subcommand '${token}' is not modelled by the fake Codex CLI`, scope);
      scope = nested;
      continue;
    }
    positionals++;
  }
  const has = (...names) => seen.some((flag) => names.includes(flag.name));
  const valueOf = (...names) => seen.find((flag) => names.includes(flag.name))?.value;
  // Mutually exclusive in the real CLI: the automatic-review preset owns the sandbox.
  if (has('--approve-for-me') && has('--sandbox', '-s')) {
    fail("the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'", scope);
  }
  // `--ask-for-approval` is interactive-only; an `exec` line never accepts it, in either position.
  if (scope.startsWith('exec') && has('--ask-for-approval', '-a')) {
    fail("the argument '--ask-for-approval <APPROVAL_POLICY>' cannot be used with 'exec'", scope);
  }
  return { scope, has, valueOf };
}

// --version, --help and `login status` answer before argv validation, exactly as the real binary does.
if (args.includes('--version') || args.includes('-V')) { print('codex-cli 0.154.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_AUTH === '0') { print('Not logged in'); process.exit(1); }
  print('Logged in'); process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  const scope = args[0] === 'exec' && args[1] === 'resume' ? 'exec resume' : args[0] === 'exec' ? 'exec' : args[0] === 'app-server' ? 'app-server' : '';
  const entry = FLAGS[scope];
  print(entry.usage.join('\n'));
  if (entry.subcommands.length) print(`\nCommands:\n${entry.subcommands.map((name) => `  ${name}`).join('\n')}`);
  print(`\nOptions:\n${Object.entries(entry.flags).map(([flag, arity]) => `  ${flag}${arity ? ' <VALUE>' : ''}`).join('\n')}`);
  process.exit(0);
}

const line = parseCommandLine(args);
const taskId = process.env.CAO_TASK_ID ?? 'unknown';
const attempt = Number(process.env.CAO_ATTEMPT ?? 1);
const taskModes = JSON.parse(process.env.FAKE_CODEX_TASK_MODES ?? '{}');
const mode = taskModes[taskId] ?? process.env.FAKE_CODEX_MODE ?? 'success';

const trace = (extra) => {
  if (!process.env.FAKE_CODEX_TRACE) return;
  mkdirSync(path.dirname(process.env.FAKE_CODEX_TRACE), { recursive: true });
  appendFileSync(process.env.FAKE_CODEX_TRACE, `${JSON.stringify({ taskId, attempt, cwd: process.cwd(), pid: process.pid, scope: line.scope, args, ...extra })}\n`);
};

const result = { status: 'success', summary: 'fake app-server completed', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [] };
const strictResult = { ...result, error: null, data: JSON.stringify({ risk: 'low', nested: { count: 2 } }) };

/** The `invalid_json_schema` 400 the API returns for a schema that is not OpenAI-strict. */
function strictSchemaError(schema, context = '()') {
  if (!schema || typeof schema !== 'object') return null;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    if (schema.additionalProperties !== false) {
      return `Invalid schema for response_format 'codex_output_schema': In context=${context}, 'additionalProperties' is required to be supplied and to be false.`;
    }
    const properties = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    const missing = properties.filter((key) => !required.has(key));
    if (missing.length) return `Invalid schema for response_format 'codex_output_schema': In context=${context}, 'required' must include every key in properties.`;
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      const error = strictSchemaError(value, `${context}.${key}`);
      if (error) return error;
    }
  }
  if (schema.items) {
    const error = strictSchemaError(schema.items, `${context}[]`);
    if (error) return error;
  }
  for (const value of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const error = strictSchemaError(value, context);
    if (error) return error;
  }
  return null;
}

if (line.scope.startsWith('exec')) {
  const resumed = line.scope === 'exec resume';
  const outputPath = line.valueOf('--output-last-message', '-o');
  const schemaPath = line.valueOf('--output-schema');
  const prompt = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    process.stdin.resume();
  });
  trace({ prompt, resumed });
  const schemaError = mode === 'schema-rejected'
    ? "Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false."
    : strictSchemaError(schemaPath ? JSON.parse(readFileSync(schemaPath, 'utf8')) : undefined);
  if (schemaError) {
    emit({ type: 'thread.started', thread_id: 'codex-exec-thread-1' });
    emit({ type: 'turn.started' });
    emit({ type: 'error', message: schemaError });
    emit({ type: 'turn.failed', error: { message: schemaError } });
    process.exit(1);
  }
  emit({ type: 'thread.started', thread_id: 'codex-exec-thread-1' });
  // `codex exec` has no channel for approvals or questions: the CLI rejects the request itself, and the
  // wording below is the shipped binary's. The two shapes it can arrive in are both covered.
  // A resumed exec session is one the operator has already answered with `cao resume --input`: the answer
  // arrives as the next user message and the worker no longer needs the approval it was refused.
  if (mode === 'exec-approval' && !resumed) {
    emit({ type: 'turn.started' });
    emit({ type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'npm publish --tag latest' } });
    emit({ type: 'error', message: 'command execution approval is not supported in exec mode for thread `codex-exec-thread-1`' });
    emit({ type: 'turn.failed', error: { message: 'command execution approval is not supported in exec mode for thread `codex-exec-thread-1`' } });
    process.exit(1);
  }
  if (mode === 'exec-user-input' && !resumed) {
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { type: 'error', id: 'err-1', message: 'request_user_input is not supported in exec mode for thread `codex-exec-thread-1`' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 1 } });
    process.exit(0);
  }
  if (mode === 'open-command' && !resumed) {
    // The process leaves cleanly while a command it started is still running: nothing completed it, and
    // there is no final answer to read. The transcript has to end with that command.
    emit({ type: 'turn.started' });
    emit({ type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'npm run build' } });
    process.exit(0);
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000); // An unresolved promise alone would let node exit.
    await new Promise(() => {});
  }
  if (mode === 'api-error' && !resumed) {
    emit({ type: 'turn.started' });
    process.stderr.write('stream error: fetch failed (ECONNRESET); retrying in 1s\n');
    process.stderr.write('stream error: exceeded retry limit\n');
    process.exit(1);
  }
  const execResult = { ...(mode === 'strict-schema' ? strictResult : result), summary: resumed ? `fake exec resumed ${taskId}` : 'fake exec completed' };
  // No `status` at all: prose that reads like a result but does not satisfy the completion contract.
  const text = mode === 'invalid' && !resumed ? '{"note":"I finished the work"}' : JSON.stringify(execResult);
  if (outputPath) writeFileSync(outputPath, text, 'utf8');
  if (mode === 'interim' && !resumed) {
    // A worker that answers the completion contract mid-turn and then keeps working, as run 2026-09-10-004
    // did: the attempt must not end here, and neither object may be rendered as something the agent said.
    emit({ type: 'item.completed', item: { type: 'agent_message', id: 'msg-0', text: JSON.stringify({ ...result, status: 'needs_input', summary: 'Checking whether the docs still build' }) } });
    emit({ type: 'item.completed', item: { type: 'agent_message', id: 'msg-0b', text: 'Now running the tests.' } });
  }
  emit({ type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'npm test' } });
  emit({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', command: 'npm test', status: 'completed', exit_code: 0, aggregated_output: 'ok' } });
  emit({ type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } });
  process.exit(0);
}
if (line.scope !== 'app-server') fail('a subcommand is required but none was supplied', line.scope);

trace({ transport: 'appServer' });

/**
 * The real app-server persists a thread's resolved settings and reports them again on `thread/resume`,
 * which sends nothing but the id. The fake keeps them next to its trace file (or in the temp directory)
 * so a resumed turn answers with the envelope the thread was started with, not with defaults.
 */
const stateDir = process.env.FAKE_CODEX_TRACE ? path.dirname(process.env.FAKE_CODEX_TRACE) : os.tmpdir();
const stateFile = (id) => path.join(stateDir, `fake-codex-thread-${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
const rememberThread = (id, settings) => {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(id), JSON.stringify(settings), 'utf8');
  } catch {
    /* the fallback below is good enough */
  }
};
const recallThread = (id) => {
  try {
    return existsSync(stateFile(id)) ? JSON.parse(readFileSync(stateFile(id), 'utf8')) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `turn/steer` (§7.2). The success answer is a turn id; `FAKE_CODEX_STEER` selects one of the refusals the
 * real server produces instead, so every rejection row of the §3.5 matrix is reachable from a test.
 *
 * `expectedTurnId must not be empty` and `expected active turn id X but found Y` are decided from the
 * request itself rather than from the env, because those two are the server checking what the client sent.
 */
const STEER_REJECTIONS = {
  'no-turn': 'no active turn to steer',
  review: 'cannot steer a review turn',
  compact: 'cannot steer a compact turn',
  'empty-input': 'input must not be empty',
  schema: 'active turn uses a different output schema',
};
const NOT_STEERABLE = new Set(['review', 'compact']);
const steerMode = process.env.FAKE_CODEX_STEER ?? '';
/** Set once `turn/start` has been answered and cleared at `turn/completed`: the window a steer is legal in. */
let activeTurnId = null;

let unsupportedOutstanding = 2;
/** `two-approvals`: the turn ends only once both of the requests it opened have been answered. */
let bothOutstanding = 2;
const bothSettled = [];
let threadId = 'codex-thread-1';
let overloaded = false;
let isResume = false;
/** Questions the fake asked, by request id, so their answers can be checked against what it sent. */
const askedQuestions = new Map();

/** Fail the turn the way the server would if a client answered off-protocol; the test then says why. */
function protocolViolation(detail) {
  process.stderr.write(`protocol violation: ${detail}\n`);
  emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'failed', items: [], itemsView: 'full', error: { message: `client response violates the app-server protocol: ${detail}`, codexErrorInfo: 'badRequest', additionalDetails: null } } } });
}

// ---------------------------------------------------------------------------
// The account methods the usage footer reads (§3.6, §7.2). Account-scoped: no thread, no turn, no billing.
// ---------------------------------------------------------------------------

const accountMode = process.env.FAKE_CODEX_ACCOUNT ?? 'chatgpt';

/** `account/read` answers one of these; `null` is what a machine with no login gets. */
const ACCOUNTS = {
  chatgpt: { type: 'chatgpt', email: 'operator@example.com', planType: 'Pro' },
  refused: { type: 'chatgpt', email: 'operator@example.com', planType: 'Pro' },
  apiKey: { type: 'apiKey' },
  none: null,
};

/** A window is `usedPercent`, how long it runs, and when it rolls over — `resetsAt` in unix **seconds**. */
const window = (usedPercent, windowDurationMins, resetsInMins) => ({
  usedPercent,
  windowDurationMins,
  resetsAt: Math.floor(Date.now() / 1000) + resetsInMins * 60,
});

/**
 * `account/rateLimits/read`. The default pair is the one the real server reports for a ChatGPT plan: a
 * 300-minute primary and a 10080-minute secondary. The variants are the two shapes a client must not
 * assume away — a missing secondary, and extra limits keyed by `limitId`.
 */
function rateLimitsResult() {
  const shape = process.env.FAKE_CODEX_RATE_LIMITS ?? 'default';
  const primary = window(42, 300, 53);
  const secondary = shape === 'no-secondary' ? null : window(61, 10080, 4320);
  const rateLimits = { primary, secondary, planType: 'Pro', limitId: 'default' };
  if (shape !== 'by-limit-id') return { rateLimits };
  return {
    rateLimits,
    rateLimitsByLimitId: {
      // `default` is the snapshot above, so a client that drew it twice would be drawing one window twice.
      default: rateLimits,
      'gpt-5-codex': { primary: window(8, 60, 12), secondary: null },
    },
  };
}

/** The sparse notification the server emits during a turn: the window that moved, and nothing else. */
function emitRateLimitsUpdate() {
  emit({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: window(77, 300, 41) } } });
}

const COMMAND_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];

/**
 * Validate a response the way the schemas do (CommandExecutionRequestApprovalResponse,
 * FileChangeRequestApprovalResponse, ToolRequestUserInputResponse). Returns false when it failed the turn.
 */
function validateResponse(message) {
  const result = message.result;
  if (!result || typeof result !== 'object') return protocolViolation('the response carries no result object') ?? false;
  if (message.id === 99 || message.id === 98) {
    const decision = result.decision;
    if (typeof decision === 'string') {
      if (!COMMAND_DECISIONS.includes(decision)) return protocolViolation(`unknown decision "${decision}"`) ?? false;
      return true;
    }
    // Only a command approval has an amendment variant; a file change response has none at all.
    if (message.id === 98) return protocolViolation(`a file change decision must be one of ${COMMAND_DECISIONS.join(', ')}, got ${JSON.stringify(decision)}`) ?? false;
    const amendment = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
    if (!Array.isArray(amendment) || !amendment.every((v) => typeof v === 'string')) {
      return protocolViolation(`acceptWithExecpolicyAmendment needs execpolicy_amendment: string[], got ${JSON.stringify(decision)}`) ?? false;
    }
    return true;
  }
  const answers = result.answers;
  if (!answers || typeof answers !== 'object') return protocolViolation('a requestUserInput response needs an answers object') ?? false;
  const asked = askedQuestions.get(message.id) ?? [];
  const expected = asked.map((q) => q.id).sort();
  const got = Object.keys(answers).sort();
  if (expected.join('|') !== got.join('|')) {
    return protocolViolation(`answers must be keyed by question id (${expected.join(', ')}), got ${got.join(', ') || '(none)'}`) ?? false;
  }
  for (const [id, value] of Object.entries(answers)) {
    if (!value || !Array.isArray(value.answers) || !value.answers.every((v) => typeof v === 'string')) {
      return protocolViolation(`answer for "${id}" must be {answers: string[]}, got ${JSON.stringify(value)}`) ?? false;
    }
  }
  return true;
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  const message = JSON.parse(raw);
  if (message.method === 'initialize') {
    emit({ id: message.id, result: { userAgent: 'fake-codex' } });
  } else if (message.method === 'account/read') {
    trace({ method: 'account/read' });
    // `Object.hasOwn`, not `??`: `ACCOUNTS.none` *is* null, which is the shape a machine with no login
    // gets, and `??` turned the one mode that tests it back into a signed-in ChatGPT account.
    emit({ id: message.id, result: { account: Object.hasOwn(ACCOUNTS, accountMode) ? ACCOUNTS[accountMode] : ACCOUNTS.chatgpt } });
  } else if (message.method === 'account/rateLimits/read') {
    trace({ method: 'account/rateLimits/read' });
    // The one refusal that is not a failure: the server will not read quotas for an API-key login (§7.2).
    if (accountMode === 'refused') emit({ id: message.id, error: { code: -32600, message: 'chatgpt authentication required to read rate limits' } });
    else emit({ id: message.id, result: rateLimitsResult() });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (mode === 'overload-once' && !overloaded) {
      overloaded = true;
      emit({ id: message.id, error: { code: -32001, message: 'server overloaded' } });
      return;
    }
    isResume = message.method === 'thread/resume';
    threadId = message.params?.threadId ?? threadId;
    // One writer per thread (§7.2): a second process resuming a thread someone else holds is refused.
    if (isResume && process.env.FAKE_CODEX_RESUME_CONFLICT === '1') {
      emit({ id: message.id, error: { code: -32600, message: `thread ${threadId} already has an active writer` } });
      return;
    }
    const stored = isResume ? recallThread(threadId) : undefined;
    const settings = {
      model: message.params?.model ?? stored?.model ?? 'fake-codex',
      approvalPolicy: message.params?.approvalPolicy ?? stored?.approvalPolicy ?? 'on-request',
      approvalsReviewer: message.params?.approvalsReviewer ?? stored?.approvalsReviewer ?? 'user',
      sandbox: message.params?.sandbox ?? stored?.sandbox ?? 'workspace-write',
    };
    if (!isResume) rememberThread(threadId, settings);
    // The security envelope of an app-server turn travels in these params rather than in argv, so it is
    // echoed the way the responses below are: a test reads it back out of the attempt's log.
    process.stderr.write(`envelope:${JSON.stringify({ approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandbox: settings.sandbox })}` + String.fromCharCode(10));
    const sandboxType = settings.sandbox.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    emit({ id: message.id, result: {
      thread: { id: threadId }, model: mode === 'wrong-model' ? 'other-model' : settings.model, modelProvider: 'openai', cwd: message.params?.cwd ?? process.cwd(),
      instructionSources: [], approvalPolicy: mode === 'missing-policy' ? null : settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
      sandbox: { type: sandboxType, writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null,
    } });
  } else if (message.method === 'turn/steer') {
    process.stderr.write(`steer:${JSON.stringify(message.params)}\n`);
    const input = Array.isArray(message.params?.input) ? message.params.input : [];
    const text = input.map((part) => part?.text ?? '').join('');
    const expected = message.params?.expectedTurnId;
    // The server's own argument checks come first, then the turn's state, then the selected refusal.
    if (!expected) emit({ id: message.id, error: { code: -32600, message: 'expectedTurnId must not be empty' } });
    else if (!activeTurnId) emit({ id: message.id, error: { code: -32600, message: 'no active turn to steer' } });
    else if (expected !== activeTurnId) emit({ id: message.id, error: { code: -32600, message: `expected active turn id ${expected} but found ${activeTurnId}` } });
    else if (!text) emit({ id: message.id, error: { code: -32600, message: 'input must not be empty' } });
    // A server that takes the request and never answers it (§3.5, and the bound `CALL_TIMEOUT_MS` puts on
    // how long that may hold up the scheduler's loop). Not a refusal: nothing is emitted at all.
    else if (steerMode === 'wedged') process.stderr.write(`steer-swallowed${String.fromCharCode(10)}`);
    else if (STEER_REJECTIONS[steerMode]) {
      emit({
        id: message.id,
        error: { code: -32600, message: STEER_REJECTIONS[steerMode], ...(NOT_STEERABLE.has(steerMode) ? { data: { codexErrorInfo: 'activeTurnNotSteerable' } } : {}) },
      });
    } else {
      emit({ id: message.id, result: { turnId: activeTurnId } });
      if (mode === 'steer') {
        emit({ method: 'item/completed', params: { threadId, turnId: activeTurnId, item: { type: 'agentMessage', id: 'msg-steer', text: `Taking your note: ${text}`, phase: null, memoryCitation: null, delivery: null, questions: null } } });
        finish({ ...result, summary: `fake app-server steered with ${text}` });
      }
    }
  } else if (message.method === 'turn/start') {
    // §7.2: the real server routes a `turn/start` on a thread with an active turn to steer, silently. The
    // fake does the same and says so on stderr, so a test can catch a client that ever sends one.
    if (activeTurnId) {
      process.stderr.write(`turn-start-routed-to-steer:${JSON.stringify(message.params?.input ?? null)}\n`);
      emit({ id: message.id, result: { turn: { id: activeTurnId, status: 'inProgress', items: [], itemsView: 'full', error: null } } });
      return;
    }
    const schemaError = mode === 'schema-rejected'
      ? "Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false."
      : strictSchemaError(message.params?.outputSchema);
    if (schemaError) {
      emit({ id: message.id, error: { code: -32602, message: schemaError } });
      return;
    }
    emit({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full', error: null } } });
    activeTurnId = 'turn-1';
    // Rate limits move while a turn runs, and this is the only moment the server says so (§7.2).
    if (process.env.FAKE_CODEX_RATE_LIMITS_UPDATE === '1') emitRateLimitsUpdate();
    if (mode === 'steer') {
      // The turn stays open so the host has something to steer into. Bounded, so a test that never steers
      // (or one whose steer is refused) still ends instead of hanging the suite.
      setTimeout(() => {
        if (activeTurnId) finish({ ...result, summary: 'fake app-server finished without a steer' });
      }, Number(process.env.FAKE_CODEX_STEER_WAIT_MS ?? 3000)).unref?.();
    } else if (mode === 'approval' || mode === 'approval-decline') {
      // No amendment proposed and no acceptForSession offered: "allow for the rest of this task" is not on.
      emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: Date.now(), kind: 'command', command: 'npm test', cwd: process.cwd(), availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null } });
    } else if (mode === 'approval-always') {
      emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: Date.now(), kind: 'command', command: 'npm test', cwd: process.cwd(), availableDecisions: ['accept', 'acceptForSession', 'decline'], proposedExecpolicyAmendment: ['npm', 'test'] } });
    } else if (mode === 'two-approvals') {
      // Two requests open at once, from one turn: whichever order the client answers them in, both have to
      // be answered before the turn can end.
      emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: Date.now(), kind: 'command', command: 'npm test', cwd: process.cwd(), availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null } });
      emit({ id: 98, method: 'item/fileChange/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'file-1', startedAtMs: Date.now(), reason: 'update fixture', grantRoot: process.cwd() } });
    } else if (mode === 'file-approval') {
      emit({ id: 98, method: 'item/fileChange/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'file-1', startedAtMs: Date.now(), reason: 'update fixture', grantRoot: process.cwd() } });
    } else if (mode === 'question-then-resume' && !isResume) {
      // Asked once; a thread/resume carrying the operator's answer completes the turn instead.
      ask(100, [{ id: 'db', header: 'Database', question: 'Which database?', isOther: false, isSecret: false, options: [{ label: 'postgres', description: 'Relational' }] }]);
    } else if (mode === 'question' || mode === 'question-recovers') {
      ask(100, [{ id: 'choice', header: 'Choice', question: 'Which?', isOther: false, isSecret: false, options: [{ label: 'A', description: 'first' }] }]);
    } else if (mode === 'question-multi') {
      ask(100, [
        { id: 'db', header: 'Database', question: 'Which database?', isOther: false, isSecret: false, options: [{ label: 'postgres', description: 'Relational' }, { label: 'mongo', description: 'Document' }] },
        { id: 'deploy', header: 'Deploy', question: 'Deploy where?', isOther: true, isSecret: false, options: null },
      ]);
    } else if (mode === 'unknown-request') {
      // Neither is answerable, and both are permission-affecting: the client must refuse, not guess.
      emit({ id: 97, method: 'item/permissions/requestApproval', params: { threadId, turnId: 'turn-1', itemId: 'perm-1' } });
      emit({ id: 96, method: 'mcpServer/elicitation/request', params: { threadId, turnId: 'turn-1', itemId: 'elicit-1' } });
    } else if (mode === 'failure' && !isResume) {
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
    } else if (mode === 'invalid' && !isResume) {
      finish({ unrelated: true });
    } else if (mode === 'hang') {
      // Wait for the orchestrator to interrupt and terminate this process.
    } else if (mode === 'interim' && !isResume) {
      // A completion object mid-turn, then more work, then the real one: only the last is the outcome.
      emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-0', text: JSON.stringify({ ...result, status: 'needs_input', summary: 'Checking whether the docs still build' }), phase: null, memoryCitation: null, delivery: null, questions: null } } });
      emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-0b', text: 'Now running the tests.', phase: null, memoryCitation: null, delivery: null, questions: null } } });
      finish();
    } else finish(mode === 'strict-schema' ? strictResult : { ...result, summary: isResume ? `fake app-server resumed ${taskId}` : result.summary });
  } else if (message.id === 96 || message.id === 97) {
    // The client refused an unsupported request. A -32601 is the only acceptable answer; anything else
    // (least of all a result) would mean it had decided a permission question on its own.
    process.stderr.write(`unsupported:${JSON.stringify(message)}\n`);
    if (message.error?.code !== -32601) protocolViolation(`an unsupported request must be refused with -32601, got ${JSON.stringify(message)}`);
    else if (--unsupportedOutstanding === 0) finish();
  } else if (message.id === 98 || message.id === 99 || message.id === 100) {
    process.stderr.write(`response:${JSON.stringify(message)}\n`);
    if (mode === 'two-approvals') {
      // The turn is waiting on both. The answers are recorded in the order they arrive, so a test can see
      // that the order the client chose did not decide which request each answer belonged to.
      if (!message.error && !validateResponse(message)) return;
      bothSettled.push(`${message.id === 99 ? 'command' : 'file'}:${message.error ? 'declined' : JSON.stringify(message.result.decision)}`);
      if (--bothOutstanding === 0) finish({ ...result, summary: `fake app-server honoured ${bothSettled.join(' ')}` });
      return;
    }
    if (message.error) {
      // Declined through the protocol. A worker that can carry on does; one that truly needed the answer
      // ends its turn without the completion object, which is what the operator has to be told about.
      if (mode === 'question-recovers') {
        // Keep working for a moment before finishing: a client that killed the process instead of
        // declining through the protocol would never see this, or the turn that follows it.
        setTimeout(() => {
          emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-9', command: 'npm run docs', status: 'completed', exitCode: 0, aggregatedOutput: 'built' } } });
          finish({ ...result, summary: 'fake app-server continued without an answer' });
        }, 300);
      } else finish({ note: 'I cannot continue without an answer' });
    } else if (validateResponse(message)) {
      finish({ ...result, summary: `fake app-server honoured ${JSON.stringify(message.result)}` });
    }
  }
});
rl.on('close', () => process.exit(0));

/** Ask the client something, remembering the questions so the answer can be checked against them. */
function ask(id, questions) {
  askedQuestions.set(id, questions);
  emit({ id, method: 'item/tool/requestUserInput', params: { threadId, turnId: 'turn-1', itemId: 'q-1', isBlocking: true, autoResolutionMs: null, questions } });
}

function finish(value = result) {
  activeTurnId = null;
  emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: JSON.stringify(value), phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: { total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 }, last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 }, modelContextWindow: 200000 } } });
  emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [], itemsView: 'full', error: null } } });
}
