/**
 * `cao diagnostics` and `--debug` (spec §3.7, `[D33]`, `[D34]`, §5 rows 4 and 12).
 *
 * Against a real run of the fake Claude CLI, so the bundle is built from a run directory that a scheduler
 * actually wrote: a prompt that carries an `envFile` secret, an `orchestrator.log`, an `events.jsonl`, an
 * `attempt.json`, a `stderr.log` and an inbox. What is asserted is exactly the row-12 list — the default
 * excludes the bulky content, each `--include` token adds its own key, and the secret never reaches the
 * file — plus `--debug` and `CAO_DEBUG=1` being the same switch.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { prepareWorkflow, requireValid } from '../../src/cli/app.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { Redactor } from '../../src/logging/redact.js';
import { clearDetectionCache } from '../../src/runners/claude/detect.js';
import { executeRun } from '../../src/cli/commands/run.js';
import { PROMPT_TEXT_OMITTED, diagnosticsCommand, parseIncludes, type DiagnosticsBundle } from '../../src/cli/commands/diagnostics.js';
import type { TaskAttempt, WorkflowRun } from 'code-agent-orchestrator-protocol';
import { writeControlRequest, controlRequest } from '../../src/persistence/requests.js';
import { createNativeRunPaths } from '../../src/persistence/paths.js';
import { captureCli, FAKE_CLAUDE, gitAvailable, tmpGitRepo } from '../helpers/index.js';
import { UsageError } from '../../src/util/errors.js';

const SECRET = 'sk-ant-thisisaverysecrettokenvalue0123456789';
/** What an operator typed into the follow-up box. Their words, and nobody else's business by default. */
const FOLLOW_UP = 'the customer name is Ada Lovelace, do not put it in the commit message';

const WORKFLOW = `
version: 1
name: Diagnostics fixture
repository: .
envFile: .env.orchestrator
execution:
  maxConcurrency: 1
defaults:
  timeout: 2m
tasks:
  - id: implement-parser
    type: implementation
    prompt: "Use the key SECRET_PLACEHOLDER when you call the service."
`;

interface Fixture {
  repo: string;
  runId: string;
  store: FileRunStore;
}

/** One completed run of the fake CLI, with a secret in the prompt and a request left in the inbox. */
async function runFixture(prefix: string): Promise<Fixture> {
  const repo = await tmpGitRepo(prefix);
  await fs.writeFile(path.join(repo, '.env.orchestrator'), `ANTHROPIC_API_KEY=${SECRET}\n`);
  await fs.writeFile(path.join(repo, 'workflow.yaml'), WORKFLOW.replace('SECRET_PLACEHOLDER', SECRET));
  const prepared = await prepareWorkflow(path.join(repo, 'workflow.yaml'), { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
  requireValid(prepared);
  const secrets = prepared.loaded.secrets;
  const store = new FileRunStore(prepared.workflow.repositoryRoot, new Redactor(secrets));
  const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
  // The real headless path, so the run directory the bundle reads is one an execution wrote: `verbose`
  // gives it an `orchestrator.log` with something in it.
  await captureCli(() =>
    executeRun({
      run,
      environment: { ...prepared.loaded.environment, FAKE_CLAUDE_MODE: 'success' },
      secrets,
      isResume: false,
      tui: false,
      verbose: true,
    }),
  );
  // A worker's stderr reaches `stderr.log` verbatim - `ProcessManager` streams it there without a redactor -
  // so this is the one thing in the run directory that is not already clean, and therefore the thing that
  // proves the bundle does its own redacting.
  const attemptDir = store.paths.attemptDir(run.runId, 'implement-parser', 1);
  await fs.appendFile(path.join(attemptDir, 'stderr.log'), `warning: ANTHROPIC_API_KEY=${SECRET} was rejected` + String.fromCharCode(10));
  // A request nobody answered, so the bundle has an inbox to carry (§2.3).
  await writeControlRequest(store.paths, run.runId, controlRequest('stop', { taskId: 'implement-parser', source: 'cao-desktop 0.1.0' }));
  // A follow-up somebody typed, recorded on the attempt (§2.6, `PromptDelivery`). Written into the stored
  // `workflow.json` rather than sent through the controller, because what is under test is what the bundle
  // does with one, not how it got there.
  await patchAttempt(store, run.runId, (attempt) => {
    attempt.prompts = [
      {
        id: 'p1',
        at: new Date().toISOString(),
        source: 'tui',
        mode: 'steer',
        transport: 'claude-stream',
        state: 'delivered',
        text: FOLLOW_UP,
      },
    ];
  });
  return { repo, runId: run.runId, store };
}

/** Edit the first attempt of the stored `workflow.json` in place. */
async function patchAttempt(store: FileRunStore, runId: string, edit: (attempt: TaskAttempt) => void): Promise<void> {
  const file = store.paths.workflowFile(runId);
  const run = JSON.parse(await fs.readFile(file, 'utf8')) as WorkflowRun;
  edit(run.tasks['implement-parser']!.attempts[0]!);
  await fs.writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
}

async function bundleOf(fixture: Fixture, include?: string[]): Promise<{ bundle: DiagnosticsBundle; out: string; text: string; shown: Awaited<ReturnType<typeof captureCli>> }> {
  const out = path.join(fixture.repo, `bundle-${include?.join('-') ?? 'default'}.json`);
  const shown = await captureCli(() => diagnosticsCommand(fixture.runId, { repository: fixture.repo, out, ...(include ? { include } : {}) }));
  const text = await fs.readFile(out, 'utf8');
  return { bundle: JSON.parse(text) as DiagnosticsBundle, out, text, shown };
}

const HAS_GIT = await gitAvailable('diagnostics suite');

describe.skipIf(!HAS_GIT)('cao diagnostics (§3.7, [D33])', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    clearDetectionCache();
    fixture = await runFixture('cao-diag-');
  }, 90_000);

  it('refuses a token that is not one of the three', () => {
    expect(parseIncludes(['prompts,diffs'])).toEqual(['prompts', 'diffs']);
    expect(parseIncludes(['prompts', 'prompts'])).toEqual(['prompts']);
    expect(() => parseIncludes(['everything'])).toThrow(/--include takes/);
  });

  it('writes one JSON file, prints its path, and exits 0', async () => {
    const { bundle, out, shown } = await bundleOf(fixture);
    expect(shown.code).toBe(0);
    expect(shown.stdout.trim()).toBe(path.resolve(out));
    expect(bundle.protocol).toBe(1);
    expect(bundle.cao).toMatch(/\d+\.\d+\.\d+/);
    expect(Date.parse(bundle.createdAt)).not.toBeNaN();
    // Everything §3.7 names, from the run directory and the doctor's cheap half.
    expect(bundle.doctor.node.version).toBe(process.version.replace(/^v/, ''));
    // Facts, never probes: every probe row is the "not probed" placeholder, so nothing was started and
    // nothing was spent by writing a bug report.
    for (const probe of bundle.doctor.probes ?? []) expect(probe.status).toBe('skip');
    expect(bundle.workflow.runId).toBe(fixture.runId);
    expect(bundle.events.length).toBeGreaterThan(0);
    expect(bundle.orchestratorLog).toContain('implement-parser');
    expect(bundle.attempts).toHaveLength(1);
    expect(bundle.attempts[0]!.taskId).toBe('implement-parser');
    expect(bundle.attempts[0]!.attempt.number).toBe(1);
    expect(Array.isArray(bundle.attempts[0]!.stderrTail)).toBe(true);
    expect(bundle.requests.map((r) => r.kind)).toEqual(['stop']);
    expect(Array.isArray(bundle.acks)).toBe(true);
    // Read-only (§3.7): writing a bug report must not consume, answer or reject the request it describes.
    const inboxDir = fixture.store.paths.requestsDir(fixture.runId);
    expect((await fs.readdir(inboxDir)).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    expect(await fs.readdir(fixture.store.paths.requestRejectedDir(fixture.runId)).catch(() => [])).toHaveLength(0);
  }, 60_000);

  it('leaves transcripts, prompts and diffs out unless they are asked for', async () => {
    const plain = await bundleOf(fixture);
    expect(plain.bundle.transcripts).toBeUndefined();
    expect(plain.bundle.prompts).toBeUndefined();
    expect(plain.bundle.diffs).toBeUndefined();

    const withTranscripts = await bundleOf(fixture, ['transcripts']);
    expect(withTranscripts.bundle.transcripts?.[0]?.entries.length).toBeGreaterThan(0);
    expect(withTranscripts.bundle.prompts).toBeUndefined();
    expect(withTranscripts.bundle.diffs).toBeUndefined();

    const withPrompts = await bundleOf(fixture, ['prompts']);
    expect(withPrompts.bundle.prompts?.[0]?.text).toContain('Use the key');
    expect(withPrompts.bundle.transcripts).toBeUndefined();

    // §3.7 says prompts are added "only with the flag", and a follow-up's text is a prompt wherever it is
    // recorded: `attempt.prompts[].text` is left out of the default bundle too, and says that it was.
    expect(plain.text).not.toContain(FOLLOW_UP);
    expect(plain.bundle.attempts[0]!.attempt.prompts?.[0]?.text).toBe(PROMPT_TEXT_OMITTED);
    // Everything else about the delivery stays: what was sent, how, and whether it arrived.
    expect(plain.bundle.attempts[0]!.attempt.prompts?.[0]?.state).toBe('delivered');
    expect(withPrompts.bundle.attempts[0]!.attempt.prompts?.[0]?.text).toBe(FOLLOW_UP);

    // One token per key, and all three together give all three.
    const all = await bundleOf(fixture, ['transcripts,prompts,diffs']);
    expect(all.bundle.transcripts).toBeDefined();
    expect(all.bundle.prompts).toBeDefined();
    expect(all.bundle.diffs).toBeDefined();
  }, 60_000);

  it('says so when the orchestrator log was too big to carry whole', async () => {
    const file = fixture.store.paths.runLogFile(fixture.runId);
    const original = await fs.readFile(file, 'utf8');
    try {
      expect((await bundleOf(fixture)).bundle.truncated).toEqual([]);
      // Past the page ceiling: §3.7 asks for this field in full, and a reader has to be able to tell the
      // one run where "in full" was not possible from the ones where it was.
      const filler = `${'2026-09-21T09:00:00.000Z debug the orchestrator said something at length'.padEnd(1023)}\n`;
      await fs.appendFile(file, filler.repeat(5 * 1024));
      const { bundle } = await bundleOf(fixture);
      expect(bundle.truncated).toEqual(['orchestratorLog']);
      expect(bundle.orchestratorLog.length).toBeGreaterThan(0);
    } finally {
      await fs.writeFile(file, original);
    }
  }, 60_000);

  it('redacts a secret from envFile wherever it reached, prompts and raw stderr included', async () => {
    const withPrompts = await bundleOf(fixture, ['prompts', 'transcripts']);
    expect(withPrompts.text).not.toContain(SECRET);
    expect(withPrompts.bundle.prompts?.[0]?.text).toContain('[REDACTED]');
    // The stderr tail is the line nothing else redacted, and it is in the default bundle.
    const plain = await bundleOf(fixture);
    expect(plain.text).not.toContain(SECRET);
    expect(plain.bundle.attempts[0]!.stderrTail.join(String.fromCharCode(10))).toContain('ANTHROPIC_API_KEY=[REDACTED]');
  }, 60_000);

  it('carries nothing from outside the run directory but the doctor facts', async () => {
    const { bundle } = await bundleOf(fixture, ['transcripts', 'prompts', 'diffs']);
    const keys = Object.keys(bundle).sort();
    expect(keys).toEqual(['acks', 'attempts', 'cao', 'createdAt', 'diffs', 'doctor', 'events', 'live', 'orchestratorLog', 'prompts', 'protocol', 'requests', 'transcripts', 'truncated', 'workflow']);
    // The environment values of the run are never persisted and are not put back here either: the workflow
    // carries the key *names* it passes to a worker, and no value of any of them.
    expect(bundle.workflow.workflow.environmentKeys).toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(bundle)).not.toContain(SECRET);
  }, 60_000);

  it('is a usage error, exit 2, for a run that does not exist', async () => {
    await expect(diagnosticsCommand('2099-01-01-999', { repository: fixture.repo, out: path.join(fixture.repo, 'nope.json') })).rejects.toThrow(UsageError);
    await expect(diagnosticsCommand(fixture.runId, { repository: fixture.repo })).rejects.toThrow(/--out/);
  }, 30_000);
});

describe.skipIf(!HAS_GIT)('--debug and CAO_DEBUG (§3.7, [D34])', () => {
  const previous = process.env.CAO_DEBUG;
  afterEach(() => {
    if (previous === undefined) delete process.env.CAO_DEBUG;
    else process.env.CAO_DEBUG = previous;
  });

  /** One headless execution, returning what landed in `orchestrator.log`. */
  async function headless(prefix: string, opts: { debug?: boolean; env?: string }): Promise<{ log: string; stderr: string; code: number }> {
    delete process.env.CAO_DEBUG;
    if (opts.env !== undefined) process.env.CAO_DEBUG = opts.env;
    const repo = await tmpGitRepo(prefix);
    await fs.writeFile(path.join(repo, '.env.orchestrator'), 'UNUSED=1\n');
    await fs.writeFile(path.join(repo, 'workflow.yaml'), WORKFLOW.replace('SECRET_PLACEHOLDER', 'nothing'));
    const prepared = await prepareWorkflow(path.join(repo, 'workflow.yaml'), { launchDirectory: repo, claudeCommand: FAKE_CLAUDE });
    requireValid(prepared);
    const store = new FileRunStore(prepared.workflow.repositoryRoot);
    const run = await createRun(store, { workflow: prepared.workflow, rawConfig: prepared.loaded.raw, selection: {} });
    const shown = await captureCli(() =>
      executeRun({
        run,
        environment: { ...prepared.loaded.environment, FAKE_CLAUDE_MODE: 'success' },
        secrets: prepared.loaded.secrets,
        isResume: false,
        tui: false,
        ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
      }),
    );
    const log = await fs.readFile(createNativeRunPaths(repo).runLogFile(run.runId), 'utf8').catch(() => '');
    return { log, stderr: shown.stderr, code: shown.code };
  }

  it('writes no debug line without it', async () => {
    const plain = await headless('cao-debug-off-', {});
    expect(plain.code).toBe(0);
    // A run at the default level writes no debug line anywhere; `orchestrator.log` may not exist at all.
    expect(plain.log).not.toContain('debug ');
    expect(plain.stderr).not.toContain('debug ');
  }, 90_000);

  it('writes debug lines into orchestrator.log and to stderr with --debug', async () => {
    const debug = await headless('cao-debug-flag-', { debug: true });
    expect(debug.code).toBe(0);
    expect(debug.log).toContain('debug ');
    expect(debug.stderr).toContain('debug ');
    // The flag is `CAO_DEBUG=1`, so everything that already reads it sees it too.
    expect(process.env.CAO_DEBUG).toBe('1');
  }, 90_000);

  it('still does the same for CAO_DEBUG=1, with no flag', async () => {
    const env = await headless('cao-debug-env-', { env: '1' });
    expect(env.code).toBe(0);
    expect(env.log).toContain('debug ');
  }, 90_000);

  /**
   * What the log has to *say*, not merely that it has a line in it.
   *
   * `--debug` used to leave an `orchestrator.log` holding one line — the pid the process manager spawned —
   * and nothing about what the orchestrator decided: not which run this was, not which agent the attempt
   * used, not how it ended. That is the one file a bug report is built from (§3.7), so each of those is
   * asserted by name here.
   */
  it('says what the orchestrator did, not only that it spawned something', async () => {
    const debug = await headless('cao-debug-content-', { debug: true });
    expect(debug.code).toBe(0);
    const lines = debug.log.split('\n').filter((line) => line.includes(' debug '));
    const has = (needle: string): boolean => lines.some((line) => line.includes(needle));
    // The run it is a log of, and how it ended.
    expect(has('1 task(s), concurrency 1')).toBe(true);
    expect(has('completed: exit 0,')).toBe(true);
    expect(has('succeeded,')).toBe(true);
    // The attempt: which agent, where, and with how much prompt.
    expect(has('implement-parser#1 start: agent claude')).toBe(true);
    expect(has('prompt ')).toBe(true);
    // How the attempt ended, which is what a retry decision is made from.
    expect(has('implement-parser#1 ended: success, exit 0')).toBe(true);
    // And the preflight, which happens before any of it.
    expect(has('claude: preflight over 1 task(s)')).toBe(true);
  }, 90_000);
});
