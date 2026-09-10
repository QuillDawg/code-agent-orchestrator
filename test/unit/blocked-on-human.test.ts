/**
 * The pure parts of "the worker needs a human": what a Codex `exec` rejection means, what the app-server's
 * requests and answers look like on the wire, and what Claude's own denials look like once the CLI has
 * answered them itself.
 *
 * The shapes are checked against the protocol bundle of codex-cli 0.154.0
 * (`codex app-server generate-json-schema --experimental`) and against the wording in the shipped binary;
 * the end-to-end suites then prove the same shapes survive a real process.
 */
import { describe, it, expect } from 'vitest';
import { CODEX_EXEC_NO_HUMAN, codexExecHumanRequest, codexExecNeedsInput, codexExecNoHumanNotice } from '../../src/runners/codex/exec-limits.js';
import {
  REQUEST_DECLINED, REQUEST_UNSUPPORTED, approvalResponse, cancelResponse, interactionFromRequest, isAnswerableRequest,
  parseQuestions, quoteQuestions, userInputResponse,
} from '../../src/runners/codex/app-server-protocol.js';
import { describeDenials } from '../../src/runners/claude/protocol.js';
import { canAllowAlways, type Interaction } from '../../src/types/interaction.js';
import { ESC } from '../../src/util/text.js';

const ctx = { taskId: 'a', attempt: 1 };
const thread = 'codex-exec-thread-1';

describe('codex exec: recognising a rejection that needed a human', () => {
  it('names the kind of decision for every wording the CLI uses', () => {
    const cases: Array<[string, string]> = [
      [`command execution approval is not supported in exec mode for thread \`${thread}\``, 'command'],
      [`exec command approval is not supported in exec mode for thread \`${thread}\``, 'command'],
      [`file change approval is not supported in exec mode for thread \`${thread}\``, 'fileChange'],
      [`apply_patch approval is not supported in exec mode for thread \`${thread}\``, 'fileChange'],
      [`permissions approval is not supported in exec mode for thread \`${thread}\``, 'permissions'],
      [`request_user_input is not supported in exec mode for thread \`${thread}\``, 'userInput'],
      [`mcpServer/elicitation/request is not supported in exec mode for thread \`${thread}\``, 'userInput'],
    ];
    for (const [message, kind] of cases) expect([message, codexExecHumanRequest(message)]).toEqual([message, kind]);
  });

  it('ignores rejections no human could have answered either', () => {
    // These are capability gaps, not questions: pausing the run holding one would tell an operator to
    // answer something nobody can answer.
    for (const message of [
      'chatgpt auth token refresh is not supported in exec mode',
      'attestation generation is not supported in exec mode',
      'external current time is not supported in exec mode',
      `dynamic tool calls are not supported in exec mode for thread \`${thread}\``,
      'stream error: fetch failed (ECONNRESET)',
      'command execution approval is not supported',
    ]) {
      expect([message, codexExecHumanRequest(message)]).toEqual([message, undefined]);
    }
  });

  it('builds a result that names the transport, the option and what Codex was asking about', () => {
    const result = codexExecNeedsInput({ kind: 'command', message: `command execution approval is not supported in exec mode for thread \`${thread}\``, wanted: 'npm publish' }, ['Codex exited with code 1']);
    expect(result.status).toBe('needs_input');
    expect(result.summary).toContain('approval to run a command');
    expect(result.error).toContain('npm publish');
    expect(result.error).toContain('codex.transport: appServer');
    expect(result.error).toContain('codex.approvals: host');
    expect(result.warnings).toEqual(['Codex exited with code 1']);
    expect(result.followUp).toEqual([expect.stringContaining('codex.approvals: host')]);

    // A question points at the switch that would have let one be answered, not at approvals.
    const asked = codexExecNeedsInput({ kind: 'userInput', message: 'request_user_input is not supported in exec mode' });
    expect(asked.error).toContain('codex.experimentalUserInput: true');
    expect(asked.error).not.toContain('codex.approvals: host');
  });

  it('strips escape sequences and keeps the quoted text bounded', () => {
    const result = codexExecNeedsInput({ kind: 'command', message: 'command execution approval is not supported in exec mode', wanted: `${ESC}[2Kfake prompt\nsecond line` });
    expect(result.error).not.toContain(ESC);
    expect(result.error).toContain('fake prompt');
    expect(result.error).not.toContain('second line');
    const long = codexExecNeedsInput({ kind: 'command', message: 'command execution approval is not supported in exec mode', wanted: 'x'.repeat(1000) });
    expect(long.error!.length).toBeLessThan(800);
  });

  it('states the limit once for the run and once for cao validate', () => {
    expect(CODEX_EXEC_NO_HUMAN).toContain('cannot reach a human');
    expect(codexExecNoHumanNotice(['build'])).toContain('Task "build" runs');
    expect(codexExecNoHumanNotice(['build', 'ship'])).toContain('Tasks "build", "ship" run');
    expect(codexExecNoHumanNotice(['build'])).toContain('appServer');
  });
});

describe('codex app-server: requests and answers on the wire', () => {
  it('answers only the three requests it implements', () => {
    expect(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].every(isAnswerableRequest)).toBe(true);
    // Permission-affecting, and never guessed at: the runner refuses these with -32601.
    expect(['item/permissions/requestApproval', 'mcpServer/elicitation/request', 'applyPatchApproval', 'execCommandApproval', 'item/tool/call'].some(isAnswerableRequest)).toBe(false);
    expect([REQUEST_UNSUPPORTED, REQUEST_DECLINED]).toEqual([-32601, -32000]);
  });

  it('offers "allow for the rest of this task" only where the server proposed one', () => {
    const amendment = interactionFromRequest('1', 'item/commandExecution/requestApproval', { command: 'npm test', proposedExecpolicyAmendment: ['npm', 'test'] }, ctx);
    expect(amendment).toMatchObject({ kind: 'permission', toolName: 'command', title: 'Command: npm test' });
    expect(canAllowAlways(amendment)).toBe(true);
    expect(approvalResponse(amendment, { kind: 'allow', scope: 'always' })).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } } });

    const forSession = interactionFromRequest('2', 'item/commandExecution/requestApproval', { command: 'npm test', availableDecisions: ['accept', 'acceptForSession', 'decline'] }, ctx);
    expect(canAllowAlways(forSession)).toBe(true);
    expect(approvalResponse(forSession, { kind: 'allow', scope: 'always' })).toEqual({ decision: 'acceptForSession' });

    // Nothing proposed and no session decision offered: "always" is honoured as the allow-once it is.
    const plain = interactionFromRequest('3', 'item/commandExecution/requestApproval', { command: 'npm test', availableDecisions: ['accept', 'decline'], proposedExecpolicyAmendment: null }, ctx);
    expect(canAllowAlways(plain)).toBe(false);
    expect(approvalResponse(plain, { kind: 'allow', scope: 'always' })).toEqual({ decision: 'accept' });
    expect(approvalResponse(plain, { kind: 'allow', scope: 'once' })).toEqual({ decision: 'accept' });
    // Declining lets the agent carry on with the turn; only a failure to answer at all cancels it.
    expect(approvalResponse(plain, { kind: 'deny', message: 'no' })).toEqual({ decision: 'decline' });
    expect(cancelResponse()).toEqual({ decision: 'cancel' });
  });

  it('maps a file-change request onto the decisions its response actually allows', () => {
    const granted = interactionFromRequest('4', 'item/fileChange/requestApproval', { reason: 'update fixture', grantRoot: '/repo' }, ctx);
    expect(granted).toMatchObject({ kind: 'permission', toolName: 'fileChange', title: 'update fixture', description: 'update fixture' });
    expect(canAllowAlways(granted)).toBe(true);
    // FileChangeRequestApprovalResponse has no amendment variant at all.
    expect(approvalResponse(granted, { kind: 'allow', scope: 'always' })).toEqual({ decision: 'acceptForSession' });

    const bare = interactionFromRequest('5', 'item/fileChange/requestApproval', {}, ctx);
    expect(bare.title).toBe('Approve file changes');
    expect(canAllowAlways(bare)).toBe(false);
    const rooted = interactionFromRequest('6', 'item/fileChange/requestApproval', { grantRoot: '/repo/src' }, ctx);
    expect(rooted.title).toBe('Approve writes under /repo/src');
  });

  it('keys a requestUserInput answer by the question id, not the text the modal used', () => {
    const params = {
      questions: [
        { id: 'db', header: 'Database', question: 'Which database?', options: [{ label: 'postgres', description: 'Relational' }] },
        { id: 'deploy', header: 'Deploy', question: 'Deploy where?', isOther: true, options: null },
      ],
    };
    expect(parseQuestions(params)).toEqual([
      { id: 'db', header: 'Database', question: 'Which database?', options: [{ label: 'postgres', description: 'Relational' }], multiSelect: false },
      { id: 'deploy', header: 'Deploy', question: 'Deploy where?', options: [], multiSelect: false },
    ]);
    const interaction = interactionFromRequest('7', 'item/tool/requestUserInput', params, ctx);
    expect(interaction).toMatchObject({ kind: 'question', toolName: 'requestUserInput', title: 'Which database? (+1 more)' });
    expect(userInputResponse(interaction, { kind: 'answer', answers: { 'Which database?': 'postgres', 'Deploy where?': 'eu-west-1' } })).toEqual({
      answers: { db: { answers: ['postgres'] }, deploy: { answers: ['eu-west-1'] } },
    });
    // Every question the server asked gets a reply, even the ones nobody answered.
    expect(userInputResponse(interaction, { kind: 'answer', answers: { 'Which database?': 'mongo' } })).toEqual({
      answers: { db: { answers: ['mongo'] }, deploy: { answers: [] } },
    });
    // A question with no id of its own still round-trips: the server keys those by position.
    const positional = interactionFromRequest('8', 'item/tool/requestUserInput', { questions: [{ question: 'Which?' }] }, ctx);
    expect(userInputResponse(positional, { kind: 'answer', answers: { 'Which?': 'A' } })).toEqual({ answers: { '0': { answers: ['A'] } } });
  });

  it('quotes a question safely for a result summary', () => {
    expect(quoteQuestions([{ question: `${ESC}[31mWhich database?`, options: [], multiSelect: false }])).toBe('"Which database?"');
    expect(quoteQuestions([{ question: 'a', options: [], multiSelect: false }, { question: 'b', options: [], multiSelect: false }])).toBe('"a" (and 1 more)');
    expect(quoteQuestions([])).toBe('a question with no text');
  });

  it('has no title to lose when the request carries neither a command nor a reason', () => {
    const interaction: Interaction = interactionFromRequest('9', 'item/commandExecution/requestApproval', { reason: 'network access' }, ctx);
    expect(interaction.title).toBe('network access');
    expect(interactionFromRequest('10', 'item/commandExecution/requestApproval', {}, ctx).title).toBe('Approve a command');
  });
});

describe('claude: the denials the CLI answered itself', () => {
  it('describes each denied tool the way the dashboard would have', () => {
    expect(
      describeDenials([
        { tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'npm publish' } },
        { toolName: 'Edit', input: { file_path: 'src/a.ts' } },
        { tool_name: 'WebFetch' },
        'not an object',
        null,
      ]),
    ).toEqual(['Bash: npm publish', 'Edit src/a.ts', 'WebFetch']);
    expect(describeDenials(undefined)).toEqual([]);
    expect(describeDenials([{}])).toEqual(['a tool']);
  });
});
