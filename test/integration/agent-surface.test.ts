/**
 * Real-CLI surface check. For a matrix of workflow options it builds the argv through the production
 * argument builders and asserts that every flag CAO can emit is one the *installed* binary advertises, in
 * the position it is emitted in: global flags in `codex --help`, subcommand flags in `codex exec --help`,
 * `codex exec resume --help` and `codex app-server --help`, and every Claude flag in `claude --help`.
 *
 * This is the check that would have caught `--approve-for-me` next to `--sandbox`. It is deliberately not
 * part of `npm test`: run it with `npm run test:agents`. It skips - loudly, with the reason - when a
 * binary is missing or below MINIMUM_AGENT_VERSIONS, so a machine without both CLIs is never failed.
 */
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { buildCodexArgs } from '../../src/runners/codex/codex-runner.js';
import { buildCodexAppServerArgs } from '../../src/runners/codex/app-server.js';
import { buildClaudeArgs, resolveClaudeOptions, type PromptMode } from '../../src/runners/claude/claude-runner.js';
import { MINIMUM_AGENT_VERSIONS, versionAtLeast } from '../../src/runners/capabilities.js';
import type { ClaudeOptions, CodexOptions, PermissionMode } from 'code-agent-orchestrator-protocol';

/** One `--help` output, reduced to the flags it advertises and the values they accept. */
interface Surface {
  label: string;
  flags: Map<string, { takesValue: boolean; choices?: string[] }>;
}

async function capture(binary: string, args: string[]): Promise<string | undefined> {
  const result = await execa(binary, args, { reject: false, windowsHide: true, timeout: 30_000, env: { COLUMNS: '100' } }).catch(() => null);
  if (!result || result.exitCode !== 0) return undefined;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/**
 * Split a help text into one block per option: the line the option is declared on plus its wrapped
 * description. Both clap (codex) and commander (claude) declare options indented two to seven columns and
 * wrap descriptions further in, which is all this needs to know.
 */
function optionBlocks(help: string): string[] {
  const blocks: string[] = [];
  let index = -1;
  for (const line of help.split(/\r?\n/)) {
    if (/^\s{2,7}--?[A-Za-z]/.test(line)) {
      blocks.push(line.trim());
      index = blocks.length - 1;
    } else if (index >= 0 && /^\s{8,}\S/.test(line)) {
      blocks[index] += ` ${line.trim()}`;
    } else if (index >= 0 && line.trim() && !/^\s/.test(line)) {
      index = -1;
    }
  }
  return blocks;
}

function choicesOf(block: string): string[] | undefined {
  const clap = /\[possible values:\s*([^\]]+)\]/.exec(block);
  if (clap) return clap[1]!.split(',').map((value) => value.trim()).filter(Boolean);
  const commander = /\(choices:\s*([^)]+)\)/.exec(block);
  if (!commander) return undefined;
  const quoted = [...commander[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  return quoted.length ? quoted : undefined;
}

function parseSurface(label: string, help: string): Surface {
  const flags = new Map<string, { takesValue: boolean; choices?: string[] }>();
  for (const block of optionBlocks(help)) {
    const head = block.split(/\s{2,}/)[0] ?? block;
    const takesValue = /[<[]/.test(head);
    const choices = choicesOf(block);
    for (const token of head.split(/[\s,]+/)) {
      if (!/^--?[A-Za-z0-9][-A-Za-z0-9]*$/.test(token)) continue;
      flags.set(token, { takesValue, ...(choices ? { choices } : {}) });
    }
  }
  return { label, flags };
}

/**
 * Walk an argv the way the CLI's parser does and report every flag that the scope it appears in does not
 * advertise, plus every enumerated value outside the advertised set.
 */
function audit(argv: string[], start: Surface, descend: (token: string, scope: Surface) => Surface | undefined): string[] {
  const problems: string[] = [];
  let scope = start;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token.startsWith('-') && token !== '-') {
      const equals = token.indexOf('=');
      const name = equals >= 0 ? token.slice(0, equals) : token;
      const flag = scope.flags.get(name);
      if (!flag) {
        problems.push(`${name} is not accepted by \`${scope.label}\` (argv: ${argv.slice(0, index + 1).join(' ')})`);
        continue;
      }
      const value = equals >= 0 ? token.slice(equals + 1) : flag.takesValue ? argv[++index] : undefined;
      if (flag.choices && value !== undefined && !flag.choices.includes(value)) {
        problems.push(`${name} value "${value}" is not one of ${flag.choices.join(', ')} in \`${scope.label}\``);
      }
      continue;
    }
    const nested = descend(token, scope);
    if (nested) scope = nested;
  }
  return problems;
}

const CODEX_PERMISSION_MODES: Array<CodexOptions['permissionMode']> = [undefined, 'auto', 'readOnly', 'fullAccess'];
const CODEX_APPROVALS: Array<CodexOptions['approvals']> = [undefined, 'auto', 'host', 'autoReview', 'deny'];
const CODEX_CONFIG_MODES: Array<CodexOptions['configMode']> = [undefined, 'inherit', 'isolated'];
const CODEX_SANDBOXES: Array<CodexOptions['sandbox']> = [undefined, 'read-only', 'workspace-write', 'danger-full-access'];
const CODEX_POLICIES: Array<CodexOptions['approvalPolicy']> = [undefined, 'on-request', 'never'];
const CLAUDE_PERMISSION_MODES: Array<PermissionMode | undefined> = [undefined, 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'manual'];

/** Every Codex option combination, each in a bare and a fully-loaded variant. */
function codexMatrix(): CodexOptions[] {
  const cases: CodexOptions[] = [];
  for (const permissionMode of CODEX_PERMISSION_MODES) {
    for (const approvals of CODEX_APPROVALS) {
      for (const configMode of CODEX_CONFIG_MODES) {
        for (const sandbox of CODEX_SANDBOXES) {
          for (const approvalPolicy of CODEX_POLICIES) {
            const base: CodexOptions = { permissionMode, approvals, configMode, sandbox, approvalPolicy };
            cases.push(base, { ...base, profile: 'ci', addDirs: ['../shared', '../docs'] });
          }
        }
      }
    }
  }
  return cases;
}

function claudeMatrix(): Array<{ options: ClaudeOptions; prompts: PromptMode; resume?: string; forward: boolean }> {
  const cases: Array<{ options: ClaudeOptions; prompts: PromptMode; resume?: string; forward: boolean }> = [];
  for (const permissionMode of CLAUDE_PERMISSION_MODES) {
    for (const configMode of [undefined, 'inherit', 'isolated'] as Array<ClaudeOptions['configMode']>) {
      for (const prompts of ['ask', 'deny'] as PromptMode[]) {
        for (const forward of [false, true]) {
          cases.push({ options: { permissionMode, configMode }, prompts, forward });
          cases.push({
            options: {
              permissionMode, configMode, model: 'claude-opus-5', effort: 'high', maxBudgetUsd: 5,
              allowedTools: ['Bash(git *)', 'Edit'], disallowedTools: ['WebFetch'], addDirs: ['../shared'],
              sessionPersistence: false, appendSystemPrompt: 'be terse',
            },
            prompts,
            forward,
            resume: '11111111-2222-3333-4444-555555555555',
          });
        }
      }
    }
  }
  return cases;
}

/**
 * Flags the CLI accepts but does not list in `--help`. Each one is verified to be *mentioned* in the help
 * text below, so the test still goes red if the vendor drops it entirely.
 *
 * `--permission-prompt-tool` is hidden as of claude 2.1.267: `--help` names it only inside the description
 * of `--permission-prompts`. `claude --permission-prompt-tool stdio mcp list` succeeds, while an invented
 * flag exits 1 with "unknown option", so the flag is real. Ask mode depends on it.
 */
const UNDOCUMENTED: Record<string, string[]> = { claude: ['--permission-prompt-tool'] };

interface AgentSurfaces {
  skip?: string;
  version?: string;
  help: string;
  surfaces: Record<string, Surface>;
}

async function loadSurfaces(binary: string, minimum: string, helps: Record<string, string[]>): Promise<AgentSurfaces> {
  const versionOutput = await capture(binary, ['--version']);
  if (versionOutput === undefined) return { skip: `\`${binary}\` is not on PATH (or \`${binary} --version\` failed)`, help: '', surfaces: {} };
  const version = versionOutput.trim().split(/\r?\n/)[0] ?? '';
  const supported = versionAtLeast(version, minimum);
  if (supported === undefined) return { skip: `could not read a version from \`${binary} --version\` ("${version}"); minimum is ${minimum}`, help: '', surfaces: {} };
  if (!supported) return { skip: `${binary} ${version} is below the supported minimum ${minimum}`, version, help: '', surfaces: {} };
  const surfaces: Record<string, Surface> = {};
  let combined = '';
  for (const [key, args] of Object.entries(helps)) {
    const help = await capture(binary, args);
    if (help === undefined) return { skip: `\`${binary} ${args.join(' ')}\` failed on this machine`, version, help: '', surfaces: {} };
    combined += help;
    const surface = parseSurface(`${binary} ${args.join(' ')}`, help);
    for (const flag of UNDOCUMENTED[binary] ?? []) if (!surface.flags.has(flag)) surface.flags.set(flag, { takesValue: true });
    surfaces[key] = surface;
  }
  return { version, help: combined, surfaces };
}

function announceSkip(agent: string, reason: string): void {
  process.stderr.write(`\n[skipped] ${agent} surface check: ${reason}. Install the CLI and re-run \`npm run test:agents\` to cover it.\n`);
}

const codex = await loadSurfaces('codex', MINIMUM_AGENT_VERSIONS.codex, {
  root: ['--help'],
  exec: ['exec', '--help'],
  resume: ['exec', 'resume', '--help'],
  appServer: ['app-server', '--help'],
});
if (codex.skip) announceSkip('codex', codex.skip);

const claude = await loadSurfaces('claude', MINIMUM_AGENT_VERSIONS.claude, { root: ['--help'] });
if (claude.skip) announceSkip('claude', claude.skip);

describe.skipIf(Boolean(codex.skip))('codex argv against the installed CLI', () => {
  const { root, exec, resume, appServer } = codex.surfaces as Record<'root' | 'exec' | 'resume' | 'appServer', Surface>;
  const descend = (token: string, scope: Surface): Surface | undefined => {
    if (scope === root && token === 'exec') return exec;
    if (scope === root && token === 'app-server') return appServer;
    if (scope === exec && token === 'resume') return resume;
    return undefined;
  };

  it(`accepts every exec flag the option matrix can produce (codex ${codex.version})`, () => {
    const problems: string[] = [];
    const emitted = new Set<string>();
    let built = 0;
    for (const options of codexMatrix()) {
      for (const [resumeId, model, effort] of [[undefined, undefined, undefined], ['thread-1', 'gpt-5-codex', 'high']] as const) {
        let argv: string[];
        try {
          argv = buildCodexArgs(options, '/tmp/schema.json', '/tmp/final.json', resumeId, model, effort);
        } catch {
          continue; // A combination CAO refuses to build is not a surface problem.
        }
        built++;
        for (const token of argv) if (token.startsWith('--') || /^-[A-Za-z]$/.test(token)) emitted.add(token);
        problems.push(...audit(argv, root, descend));
      }
    }
    expect(built).toBeGreaterThan(500);
    // The matrix has to actually reach the interesting flags, or an empty problem list means nothing.
    expect([...emitted].sort()).toEqual(expect.arrayContaining([
      '--add-dir', '--approve-for-me', '--ignore-rules', '--ignore-user-config', '--json',
      '--output-last-message', '--output-schema', '--profile', '--sandbox', '-c', '--model',
    ]));
    expect([...new Set(problems)]).toEqual([]);
  });

  it('accepts every app-server flag the option matrix can produce', () => {
    const problems: string[] = [];
    for (const options of codexMatrix()) {
      problems.push(...audit(buildCodexAppServerArgs(options), root, descend));
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('puts exec-only flags after the subcommand and session flags before it', () => {
    const argv = buildCodexArgs({ permissionMode: 'readOnly', configMode: 'isolated', profile: 'ci', addDirs: ['../shared'] }, 's.json', 'f.json');
    const boundary = argv.indexOf('exec');
    expect(boundary).toBeGreaterThan(0);
    for (const flag of argv.slice(0, boundary).filter((token) => token.startsWith('-'))) {
      expect({ flag, inRoot: root.flags.has(flag) }).toEqual({ flag, inRoot: true });
    }
    for (const flag of ['--json', '--output-schema', '--output-last-message', '--ignore-user-config', '--ignore-rules']) {
      expect({ flag, after: argv.indexOf(flag) > boundary }).toEqual({ flag, after: true });
      expect({ flag, inExec: exec.flags.has(flag) }).toEqual({ flag, inExec: true });
    }
    // The sandbox and the profile are session-wide: `codex exec resume` no longer accepts them.
    for (const flag of ['--sandbox', '--profile', '--add-dir']) {
      expect({ flag, before: argv.indexOf(flag) < boundary && argv.indexOf(flag) >= 0 }).toEqual({ flag, before: true });
    }
  });
});

describe.skipIf(Boolean(claude.skip))('claude argv against the installed CLI', () => {
  it('still mentions the flags CAO relies on that --help does not list as options', () => {
    for (const flag of UNDOCUMENTED.claude!) expect({ flag, mentioned: claude.help.includes(flag) }).toEqual({ flag, mentioned: true });
  });

  it(`accepts every flag the option matrix can produce (claude ${claude.version})`, () => {
    const root = claude.surfaces.root!;
    const problems: string[] = [];
    const emitted = new Set<string>();
    for (const testCase of claudeMatrix()) {
      const options = resolveClaudeOptions(testCase.options, { claude: {}, model: undefined, effort: undefined });
      const argv = buildClaudeArgs(options, '11111111-1111-1111-1111-111111111111', 'addendum', testCase.resume, testCase.prompts, testCase.forward);
      for (const token of argv) if (token.startsWith('--') || /^-[A-Za-z]$/.test(token)) emitted.add(token);
      problems.push(...audit(argv, root, () => undefined));
    }
    expect([...emitted].sort()).toEqual(expect.arrayContaining([
      '--add-dir', '--allowedTools', '--append-system-prompt', '--disallowedTools', '--effort',
      '--forward-subagent-text', '--input-format', '--json-schema', '--max-budget-usd', '--model',
      '--no-session-persistence', '--output-format', '--permission-mode', '--permission-prompt-tool',
      '--permission-prompts', '--resume', '--safe-mode', '--session-id', '--verbose', '-p',
    ]));
    expect([...new Set(problems)]).toEqual([]);
  });
});
