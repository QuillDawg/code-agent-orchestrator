/**
 * The switch, driven the way a user drives it: a real `cao run` against the fake Claude, once with emit off
 * and once with it on. Spec §4.2.4, §4.2.7, §5.9, §12.1.
 *
 * The off case is the one that matters most. §12.1 asks for proof that the CLI is untouched, and the strongest
 * form of that proof is not an assertion about behaviour — it is that `~/.cao` does not exist afterwards.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { PROTOCOL_VERSION, type RegistryEntry } from 'code-agent-orchestrator-protocol';
import { runCommand } from '../../src/cli/commands/run.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { emitCommand } from '../../src/cli/commands/emit.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { entryFile, registryKey, runsDir, setRegistryWarner } from '../../src/persistence/registry.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { captureCli, FAKE_CLAUDE, tmpDir, tmpGitRepo } from '../helpers/index.js';

const NL = String.fromCharCode(10);
const YAML = ['name: emitted', 'tasks:', '  - id: implement-api', '    prompt: p'].join(NL) + NL;

let home: string;
let warnings: string[];
let restoreWarner: (message: string) => void;
const saved = { CAO_HOME: process.env.CAO_HOME, CAO_EMIT: process.env.CAO_EMIT };

beforeAll(() => clearDetectionCache());

beforeEach(async () => {
  home = path.join(await tmpDir('cao-emit-run-'), '.cao');
  process.env.CAO_HOME = home;
  delete process.env.CAO_EMIT;
  warnings = [];
  restoreWarner = setRegistryWarner((message) => warnings.push(message));
});

afterEach(() => {
  setRegistryWarner(restoreWarner);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function workflowIn(repo: string): Promise<string> {
  const file = path.join(repo, 'workflow.yaml');
  await fs.writeFile(file, YAML);
  return file;
}

async function readEntry(repo: string, runId: string): Promise<RegistryEntry> {
  return JSON.parse(await fs.readFile(entryFile(registryKey(repo, runId), home), 'utf8')) as RegistryEntry;
}

describe('cao run --emit (§4.2.4, §4.2.7)', () => {
  it('runs the workflow named after the flag and announces it, terminal state and all', async () => {
    const repo = await tmpGitRepo('cao-emit-');
    const configPath = await workflowIn(repo);

    const ran = await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false, emit: true }));
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('emitted');

    const [runId] = (await new FileRunStore(repo).listRuns()).map((r) => r.runId);
    const entry = await readEntry(repo, runId!);
    // A pointer plus a heartbeat (§4.2.3): the run directory it names is where everything else comes from.
    expect(entry).toMatchObject({
      protocol: PROTOCOL_VERSION,
      runId,
      state: 'completed',
      exitCode: 0,
      taskCount: 1,
      workflowName: 'emitted',
      pid: process.pid,
      feedUrl: null,
    });
    expect(entry.endedAt).toBeTruthy();
    // §4.2.3, §2.3 — what this build actually wired up: the request inbox and the three kinds its watcher
    // really acts on. `edit` and `prompt` are parsed and answered, but not applied, so they are not here.
    expect(entry.capabilities).toEqual(['requests', 'stop', 'kill', 'restart']);
    expect(Object.keys(entry)[0]).toBe('protocol');
    expect(existsSync(path.join(entry.orchestratorDir, 'runs', runId!))).toBe(true);
    expect(warnings).toEqual([]);

    // and `cao emit status` counts it as retained rather than live, the run having ended
    const shown = await captureCli(() => emitCommand('status', {}));
    expect(shown.stdout).toContain('0 live, 1 retained');
  }, 120_000);

  it('announces a resumed run on the same flag', async () => {
    const repo = await tmpGitRepo('cao-emit-resume-');
    const configPath = await workflowIn(repo);
    await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false }));
    const [runId] = (await new FileRunStore(repo).listRuns()).map((r) => r.runId);
    expect(existsSync(runsDir(home))).toBe(false);

    const resumed = await captureCli(() => resumeCommand(runId, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false, emit: true, task: ['implement-api'] }));
    expect(resumed.code).toBe(0);
    expect((await readEntry(repo, runId!)).state).toBe('completed');
  }, 120_000);

  it('announces on CAO_EMIT alone, with nothing on the command line', async () => {
    const repo = await tmpGitRepo('cao-emit-env-');
    const configPath = await workflowIn(repo);
    process.env.CAO_EMIT = '1';
    await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false }));
    const [runId] = (await new FileRunStore(repo).listRuns()).map((r) => r.runId);
    expect((await readEntry(repo, runId!)).runId).toBe(runId);
  }, 120_000);
});

describe('cao run with emit off is the release before it (§5.9, §12.1)', () => {
  it('never creates ~/.cao at all, by default or when the flag says no', async () => {
    const repo = await tmpGitRepo('cao-noemit-');
    const configPath = await workflowIn(repo);

    const ran = await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false }));
    expect(ran.code).toBe(0);
    expect(existsSync(home)).toBe(false);

    // …and --no-emit beats a config.json that says otherwise, still without touching the directory
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ protocol: 1, emit: true, retainDays: 14 }));
    await captureCli(() => runCommand(configPath, { repository: repo, claudeCommand: FAKE_CLAUDE, tui: false, emit: false, task: ['implement-api'] }));
    expect(existsSync(runsDir(home))).toBe(false);
  }, 120_000);
});
