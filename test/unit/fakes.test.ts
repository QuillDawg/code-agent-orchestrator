/**
 * The fakes are the contract. If `test/fixtures/fake-codex.mjs` and `test/fixtures/fake-claude.mjs` accept
 * whatever CAO sends them they agree with every bug CAO has, so these tests pin what they reject: the four
 * Codex command lines the real CLI refuses, an unknown Claude flag, a schema that is not OpenAI-strict, and
 * a stream-json session with no stdio permission tool.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import { buildCodexArgs } from '../../src/runners/codex/codex-runner.js';
import { buildCodexAppServerArgs } from '../../src/runners/codex/app-server.js';
import { buildClaudeArgs } from '../../src/runners/claude/claude-runner.js';
import { CODEX_COMPLETION_CONTRACT } from '../../src/runners/claude/contract.js';
import type { CodexOptions } from '../../src/types/workflow.js';
import { tmpDir } from '../helpers/index.js';

const FAKE_CODEX_SCRIPT = path.resolve('test/fixtures/fake-codex.mjs');
const FAKE_CLAUDE_SCRIPT = path.resolve('test/fixtures/fake-claude.mjs');

async function runFake(script: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  const result = await execa(process.execPath, [script, ...args], {
    reject: false, windowsHide: true, timeout: 20_000, input: opts.input ?? '',
    env: { ...opts.env },
  });
  return { code: result.exitCode, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** A schema that is valid JSON Schema but not OpenAI-strict: no `additionalProperties: false`. */
const LOOSE_SCHEMA = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };

describe('fake Codex CLI rejects what the real CLI rejects', () => {
  it('refuses the automatic-review preset next to an explicit sandbox', async () => {
    const { code, stderr } = await runFake(FAKE_CODEX_SCRIPT, ['--approve-for-me', '--sandbox', 'workspace-write', 'exec', '--json']);
    expect(code).toBe(2);
    expect(stderr).toContain("error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'");
  });

  it('refuses --ask-for-approval anywhere on an exec command line', async () => {
    const after = await runFake(FAKE_CODEX_SCRIPT, ['exec', '--ask-for-approval', 'on-request', '--json']);
    expect(after.code).toBe(2);
    expect(after.stderr).toContain("error: unexpected argument '--ask-for-approval' found");

    const before = await runFake(FAKE_CODEX_SCRIPT, ['--ask-for-approval', 'on-request', 'exec', '--json']);
    expect(before.code).toBe(2);
    expect(before.stderr).toMatch(/--ask-for-approval.*cannot be used with 'exec'/);
  });

  it('refuses a global flag placed after the exec subcommand', async () => {
    const { code, stderr } = await runFake(FAKE_CODEX_SCRIPT, ['exec', '--search', '--json']);
    expect(code).toBe(2);
    expect(stderr).toContain("error: unexpected argument '--search' found");
    expect(stderr).toContain('Usage: codex exec [OPTIONS] [PROMPT]');
  });

  it('refuses an exec flag CAO invented', async () => {
    const { code, stderr } = await runFake(FAKE_CODEX_SCRIPT, ['exec', '--stream-json']);
    expect(code).toBe(2);
    expect(stderr).toContain("error: unexpected argument '--stream-json' found");
  });

  it('accepts the argv the runner really builds, for exec, exec resume and app-server', async () => {
    const dir = await tmpDir('cao-fake-argv-');
    const schemaPath = path.join(dir, 'schema.json');
    const outputPath = path.join(dir, 'final.json');
    await fs.writeFile(schemaPath, JSON.stringify(CODEX_COMPLETION_CONTRACT.outputSchema), 'utf8');
    const options: CodexOptions = { permissionMode: 'readOnly', configMode: 'isolated', profile: 'ci', addDirs: [dir] };

    const fresh = await runFake(FAKE_CODEX_SCRIPT, buildCodexArgs(options, schemaPath, outputPath, undefined, 'gpt-5-codex', 'high'));
    expect(fresh.code).toBe(0);
    const resumed = await runFake(FAKE_CODEX_SCRIPT, buildCodexArgs(options, schemaPath, outputPath, 'thread-1', 'gpt-5-codex', 'high'));
    expect(resumed.code).toBe(0);
    const appServer = await runFake(FAKE_CODEX_SCRIPT, buildCodexAppServerArgs({ profile: 'ci' }));
    expect(appServer.code).toBe(0);
  });

  it('fails a schema that is not OpenAI-strict on every exec call, not only in strict-schema mode', async () => {
    const dir = await tmpDir('cao-fake-schema-');
    const schemaPath = path.join(dir, 'loose.json');
    await fs.writeFile(schemaPath, JSON.stringify(LOOSE_SCHEMA), 'utf8');
    const { code, stdout } = await runFake(FAKE_CODEX_SCRIPT, ['exec', '--json', '--output-schema', schemaPath]);
    expect(code).toBe(1);
    expect(stdout).toContain("Invalid schema for response_format 'codex_output_schema'");
    expect(stdout).toContain("'additionalProperties' is required to be supplied and to be false");
  });

  it('fails a schema that is not OpenAI-strict on turn/start too', async () => {
    const request = JSON.stringify({ id: 1, method: 'turn/start', params: { outputSchema: LOOSE_SCHEMA } });
    const { stdout } = await runFake(FAKE_CODEX_SCRIPT, ['app-server', '--stdio'], { input: `${request}\n` });
    const reply = JSON.parse(stdout.trim().split(/\r?\n/)[0]!) as { error?: { code: number; message: string } };
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain("Invalid schema for response_format 'codex_output_schema'");
  });

  it('accepts the strict completion schema the runner actually sends', async () => {
    const request = JSON.stringify({ id: 1, method: 'turn/start', params: { outputSchema: CODEX_COMPLETION_CONTRACT.outputSchema } });
    const { stdout } = await runFake(FAKE_CODEX_SCRIPT, ['app-server', '--stdio'], { input: `${request}\n` });
    const reply = JSON.parse(stdout.trim().split(/\r?\n/)[0]!) as { error?: unknown; result?: unknown };
    expect(reply.error).toBeUndefined();
    expect(reply.result).toBeDefined();
  });
});

describe('fake Claude CLI rejects what the real CLI rejects', () => {
  it('refuses an unknown flag', async () => {
    const { code, stderr } = await runFake(FAKE_CLAUDE_SCRIPT, ['-p', '--output-format', 'stream-json', '--definitely-not-a-flag']);
    expect(code).toBe(2);
    expect(stderr).toContain("error: unknown option '--definitely-not-a-flag'");
  });

  it('accepts the argv the runner really builds, in both prompt modes', async () => {
    for (const prompts of ['ask', 'deny'] as const) {
      const args = buildClaudeArgs(
        { permissionMode: 'acceptEdits', configMode: 'isolated', model: 'claude-opus-5', effort: 'high', maxBudgetUsd: 3, allowedTools: ['Bash'], disallowedTools: ['WebFetch'], addDirs: ['.'], sessionPersistence: false },
        '11111111-1111-1111-1111-111111111111', 'addendum', undefined, prompts, true,
      );
      const { code } = await runFake(FAKE_CLAUDE_SCRIPT, args, { input: '' });
      expect({ prompts, code }).toEqual({ prompts, code: 0 });
    }
  });

  it('does not answer control requests without a stdio permission prompt tool', async () => {
    const message = JSON.stringify({ type: 'user', message: { content: 'do it' } });
    const withoutTool = await runFake(
      FAKE_CLAUDE_SCRIPT,
      ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'],
      { input: `${message}\n`, env: { FAKE_CLAUDE_MODE: 'permission' } },
    );
    expect(withoutTool.stdout).not.toContain('control_request');
    expect(withoutTool.stderr).toContain('no permission prompt tool is configured');
    const result = withoutTool.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; structured_output?: { status: string } }).find((event) => event.type === 'result');
    expect(result?.structured_output?.status).toBe('needs_input');
  });

  it('asks the host when the session was started with --permission-prompt-tool stdio', async () => {
    const message = JSON.stringify({ type: 'user', message: { content: 'do it' } });
    const withTool = await runFake(
      FAKE_CLAUDE_SCRIPT,
      ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
      { input: `${message}\n`, env: { FAKE_CLAUDE_MODE: 'permission' } },
    );
    expect(withTool.stdout).toContain('control_request');
  });

  it('drops --forward-subagent-text from help and from the flags it accepts when the CLI is older', async () => {
    const env = { FAKE_CLAUDE_NO_SUBAGENT_TEXT: '1' };
    const help = await runFake(FAKE_CLAUDE_SCRIPT, ['--help'], { env });
    expect(help.stdout).not.toContain('--forward-subagent-text');
    const used = await runFake(FAKE_CLAUDE_SCRIPT, ['-p', '--forward-subagent-text'], { env });
    expect(used.code).toBe(2);
    expect(used.stderr).toContain("error: unknown option '--forward-subagent-text'");
  });
});
