import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { vi } from 'vitest';
import type { LoadedWorkflow } from '../../src/config/loader.js';
import { parseWorkflowText } from '../../src/config/loader.js';
import { normalizeWorkflow, type Diagnostic } from '../../src/config/normalize.js';
import { validateWorkflow, type ValidationResult } from '../../src/workflow/validator.js';
import type { ResolvedWorkflow } from '../../src/types/workflow.js';
import type { WorkflowRun, TaskAttempt, LiveStatus } from '../../src/types/run.js';
import type { AttemptDiff, EnrichedTaskResult, GitInfo, TaskResult } from '../../src/types/result.js';
import type { WorkflowEvent } from '../../src/types/events.js';
import type { RunStore, RunLock, RunListEntry } from '../../src/persistence/run-store.js';
import { createRunPaths } from '../../src/persistence/paths.js';
import type { TaskRunner, RunnerInput, RunnerHooks, RunnerOutcome } from '../../src/runners/task-runner.js';
import type { Interaction, InteractionAnswer } from '../../src/types/interaction.js';
import type { WorkspaceManager, RunPreparation, FinalizeResult } from '../../src/workspace/workspace-manager.js';
import type { CapturedDiff } from '../../src/workspace/diff.js';
import type { ResolvedTask } from '../../src/types/workflow.js';
import type { WorkspaceInfo } from '../../src/types/run.js';
import { Git } from '../../src/workspace/git.js';
import { KeyedMutex } from '../../src/util/async-queue.js';
import { nowIso } from '../../src/util/misc.js';

export const FAKE_CLAUDE = `node ${path.resolve(process.cwd(), 'test/fixtures/fake-claude.mjs').replace(/\\/g, '/')}`;

/** Temp directory as a canonical path (Windows tmp dirs are otherwise 8.3 short names). */
export async function tmpDir(prefix = 'cao-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * Whether a usable `git` is on PATH. The worktree and end-to-end suites drive a real repository, so
 * without git every one of their cases would fail somewhere inside `git init` with a spawn error. They
 * call this at collection time and skip themselves instead, printing why once.
 */
export async function gitAvailable(suite: string): Promise<boolean> {
  const ok = await Git.isAvailable();
  if (!ok) {
    process.stderr.write(
      `\n[skipped] ${suite}: no usable \`git\` on PATH. Install git, then re-run \`npm test\` to cover it.\n`,
    );
  }
  return ok;
}

export async function tmpGitRepo(prefix = 'cao-git-'): Promise<string> {
  const dir = await tmpDir(prefix);
  const git = (...args: string[]) => execa('git', args, { cwd: dir, windowsHide: true });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git('add', '.');
  await git('commit', '-qm', 'init');
  return dir;
}

export async function gitOut(dir: string, ...args: string[]): Promise<string> {
  const res = await execa('git', args, { cwd: dir, windowsHide: true, reject: false });
  return String(res.stdout).trim();
}

/** Exit code of a git command, for asserting that something like `git apply --check` succeeded. */
export async function gitExit(dir: string, ...args: string[]): Promise<number> {
  const res = await execa('git', args, { cwd: dir, windowsHide: true, reject: false });
  return res.exitCode ?? -1;
}

/**
 * Check a commit or a tree out into a fresh repository that borrows `repo`'s objects, so a captured
 * `diff.patch` can be replayed against exactly the state the attempt started from.
 */
export async function extractTree(repo: string, treeish: string): Promise<string> {
  const dir = await tmpDir('cao-base-');
  const git = (...args: string[]) => execa('git', args, { cwd: dir, windowsHide: true });
  await git('init', '-q', '-b', 'main');
  await git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(dir, '.git', 'objects', 'info', 'alternates'), `${path.join(repo, '.git', 'objects')}\n`);
  await git('read-tree', treeish);
  await git('checkout-index', '-a', '-f');
  return dir;
}

export interface BuildOptions {
  repositoryRoot?: string;
  launchDirectory?: string;
  gitRoot?: string;
  environment?: Record<string, string>;
}

/** Parse YAML text into a ResolvedWorkflow without touching the filesystem (except promptFile). */
export async function buildWorkflow(yaml: string, opts: BuildOptions = {}): Promise<{ workflow: ResolvedWorkflow; diagnostics: Diagnostic[]; validation: ValidationResult; loaded: LoadedWorkflow }> {
  const repositoryRoot = opts.repositoryRoot ?? path.resolve(process.cwd());
  const loaded: LoadedWorkflow = {
    file: parseWorkflowText(yaml, 'inline.yaml'),
    raw: yaml,
    configPath: path.join(repositoryRoot, 'inline.yaml'),
    launchDirectory: opts.launchDirectory ?? repositoryRoot,
    repositoryRoot,
    gitRoot: opts.gitRoot,
    environment: opts.environment ?? {},
    secrets: [],
  };
  const { workflow, diagnostics } = await normalizeWorkflow(loaded);
  const validation = validateWorkflow(workflow, diagnostics, { knownRunners: ['claude', 'mock'], gitAvailable: Boolean(opts.gitRoot) });
  return { workflow, diagnostics, validation, loaded };
}

export function makeRun(workflow: ResolvedWorkflow, runId = '2026-01-01-001'): WorkflowRun {
  const now = nowIso();
  const tasks: WorkflowRun['tasks'] = {};
  for (const t of workflow.tasks) tasks[t.id] = { id: t.id, state: 'pending', attempts: [], retryWindowStart: 1 };
  return {
    schemaVersion: 1,
    runId,
    workflowName: workflow.name,
    configPath: workflow.configPath,
    workflowHash: 'x',
    launchDirectory: workflow.launchDirectory,
    repositoryRoot: workflow.repositoryRoot,
    selection: {},
    workflow,
    tasks,
    state: 'created',
    createdAt: now,
    updatedAt: now,
    resumeCount: 0,
    eventSeq: 0,
  };
}

/** In-memory RunStore capturing everything the scheduler persists. */
export class MemoryRunStore implements RunStore {
  readonly paths = createRunPaths(path.join(os.tmpdir(), 'cao-memory-store'));
  snapshots: WorkflowRun[] = [];
  events: WorkflowEvent[] = [];
  attempts: TaskAttempt[] = [];
  results = new Map<string, EnrichedTaskResult>();
  prompts = new Map<string, string>();
  diffs = new Map<string, CapturedDiff>();
  contexts = new Map<string, string>();
  reports = new Map<string, string>();
  live: LiveStatus | null = null;
  runs = new Map<string, WorkflowRun>();
  lock: RunLock | null = null;
  private counter = 0;

  async allocateRunId(): Promise<string> {
    return `2026-01-01-${String(++this.counter).padStart(3, '0')}`;
  }
  async saveRun(run: WorkflowRun): Promise<void> {
    const copy = JSON.parse(JSON.stringify(run)) as WorkflowRun;
    this.snapshots.push(copy);
    this.runs.set(run.runId, copy);
  }
  saveRunSync(run: WorkflowRun): void {
    void this.saveRun(run);
  }
  async loadRun(runId: string): Promise<WorkflowRun> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`no run ${runId}`);
    return JSON.parse(JSON.stringify(r)) as WorkflowRun;
  }
  async resolveRunId(ref: string | undefined): Promise<string> {
    return ref ?? [...this.runs.keys()].pop() ?? '';
  }
  async listRuns(): Promise<RunListEntry[]> {
    return [...this.runs.values()].map((r) => ({ runId: r.runId, workflowName: r.workflowName, state: r.state, createdAt: r.createdAt, repositoryRoot: r.repositoryRoot, progress: { total: 0, done: 0 } }));
  }
  async appendEvent(event: WorkflowEvent): Promise<void> {
    this.events.push(event);
  }
  async attemptDir(runId: string, taskId: string, attempt: number): Promise<string> {
    return path.join(os.tmpdir(), 'cao-memory-store', runId, taskId, String(attempt));
  }
  async writeAttempt(_runId: string, _taskId: string, attempt: TaskAttempt): Promise<void> {
    this.attempts.push(JSON.parse(JSON.stringify(attempt)) as TaskAttempt);
  }
  async writePrompt(_runId: string, taskId: string, attempt: number, prompt: string): Promise<void> {
    this.prompts.set(`${taskId}#${attempt}`, prompt);
  }
  async writeDiff(_runId: string, taskId: string, attempt: number, diff: CapturedDiff): Promise<void> {
    this.diffs.set(`${taskId}#${attempt}`, diff);
  }
  async readDiff(_runId: string, taskId: string, attempt: number): Promise<AttemptDiff | null> {
    const diff = this.diffs.get(`${taskId}#${attempt}`);
    if (!diff) return null;
    const { patch: _patch, ...records } = diff;
    return records;
  }
  async readDiffPatch(_runId: string, taskId: string, attempt: number): Promise<string | null> {
    return this.diffs.get(`${taskId}#${attempt}`)?.patch ?? null;
  }
  async writeResult(_runId: string, taskId: string, result: EnrichedTaskResult): Promise<void> {
    this.results.set(taskId, result);
  }
  async writeContext(_runId: string, taskId: string, markdown: string): Promise<void> {
    this.contexts.set(taskId, markdown);
  }
  async writeReport(runId: string, markdown: string): Promise<void> {
    this.reports.set(runId, markdown);
  }
  async writeLive(_runId: string, live: LiveStatus): Promise<void> {
    this.live = live;
  }
  async readLive(): Promise<LiveStatus | null> {
    return this.live;
  }
  async acquireLock(): Promise<{ ok: true }> {
    this.lock = { pid: process.pid, startedAt: nowIso(), heartbeatAt: nowIso() };
    return { ok: true };
  }
  async heartbeat(): Promise<void> {
    /* noop */
  }
  async releaseLock(): Promise<void> {
    this.lock = null;
  }
  async readLock(): Promise<RunLock | null> {
    return this.lock;
  }
  eventsOf(type: string): WorkflowEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

export type MockBehaviour =
  | { kind: 'success'; result?: Partial<TaskResult>; delayMs?: number }
  /**
   * Ask the human through hooks.onInteraction, record the answer, then behave like `then` (a deny turns
   * success into needs_input). `concurrent` opens that many requests at once, as a worker making parallel
   * tool calls does.
   */
  | { kind: 'interact'; interaction: Partial<Interaction>; withdrawAfterMs?: number; concurrent?: number; then: MockBehaviour }
  | { kind: 'status'; status: TaskResult['status']; error?: string; delayMs?: number }
  | { kind: 'error'; outcome: 'timeout' | 'crash' | 'api_error' | 'invalid_result'; message?: string; delayMs?: number }
  | { kind: 'hang' }
  | { kind: 'throw' };

export interface MockCall {
  taskId: string;
  attempt: number;
  prompt: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  env: Record<string, string>;
  resumeSessionId?: string;
  canInteract?: boolean;
  answers?: InteractionAnswer[];
}

/** Scripted TaskRunner. Behaviours are looked up per task (optionally per attempt) and default to success. */
export class MockRunner implements TaskRunner {
  readonly name: string;
  calls: MockCall[] = [];
  private behaviours = new Map<string, MockBehaviour | MockBehaviour[]>();
  private resolvers = new Map<string, (o: RunnerOutcome) => void>();
  concurrent = 0;
  maxConcurrent = 0;

  constructor(name = 'claude') {
    this.name = name;
  }

  when(taskId: string, behaviour: MockBehaviour | MockBehaviour[]): this {
    this.behaviours.set(taskId, behaviour);
    return this;
  }

  /** Complete a hanging attempt from the test. */
  complete(taskId: string, attempt: number, outcome: RunnerOutcome): void {
    const r = this.resolvers.get(`${taskId}#${attempt}`);
    if (!r) throw new Error(`no hanging attempt ${taskId}#${attempt}`);
    this.resolvers.delete(`${taskId}#${attempt}`);
    r(outcome);
  }

  get running(): string[] {
    return [...this.resolvers.keys()];
  }

  async run(input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome> {
    const call: MockCall = { taskId: input.task.id, attempt: input.attempt, prompt: input.prompt, cwd: input.cwd, startedAt: Date.now(), env: input.env, resumeSessionId: input.resumeSessionId, canInteract: input.canInteract };
    this.calls.push(call);
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    hooks.onProcess({ pid: 1000 + this.calls.length, sessionId: `s-${this.calls.length}` });
    hooks.onActivity(`working on ${input.task.id}`);
    let b = this.behaviours.get(input.task.id) ?? { kind: 'success' };
    if (Array.isArray(b)) b = b[Math.min(input.attempt - 1, b.length - 1)] ?? { kind: 'success' };
    const finish = (o: RunnerOutcome): RunnerOutcome => {
      this.concurrent--;
      call.endedAt = Date.now();
      return o;
    };
    if (b.kind === 'throw') {
      this.concurrent--;
      throw new Error('mock runner exploded');
    }
    if (b.kind === 'interact') {
      const behaviour = b;
      const ask = async (n: number): Promise<InteractionAnswer> => {
        const controller = new AbortController();
        const interaction: Interaction = {
          id: `req-${this.calls.length}${n > 0 ? `-${n}` : ''}`,
          kind: behaviour.interaction.toolName === 'AskUserQuestion' ? 'question' : 'permission',
          taskId: input.task.id,
          attempt: input.attempt,
          agent: 'claude',
          toolName: 'Bash',
          title: 'Bash: rm -rf build',
          input: { command: 'rm -rf build' },
          requestedAt: nowIso(),
          ...behaviour.interaction,
          ...(n > 0 ? { id: `req-${this.calls.length}-${n}`, title: `${behaviour.interaction.title ?? 'Bash: rm -rf build'} #${n + 1}` } : {}),
        };
        if (behaviour.withdrawAfterMs) setTimeout(() => controller.abort(new Error('withdrawn')), behaviour.withdrawAfterMs);
        input.signal.addEventListener('abort', () => controller.abort(new Error('task aborted')), { once: true });
        return hooks.onInteraction(interaction, controller.signal);
      };
      const answers = await Promise.all(Array.from({ length: b.concurrent ?? 1 }, (_, n) => ask(n)));
      (call.answers ??= []).push(...answers);
      if (input.signal.aborted) return finish({ kind: 'error', outcome: 'cancelled', message: 'aborted' });
      const answer = answers[0]!;
      b = answer.kind === 'deny' && b.then.kind === 'success' && !b.withdrawAfterMs ? { kind: 'status', status: 'needs_input', error: answer.message } : b.then;
    }
    const beh = b as Exclude<MockBehaviour, { kind: 'interact' | 'throw' }>;
    const base: TaskResult = { status: 'success', summary: `done ${input.task.id}`, filesChanged: [`${input.task.id}.ts`], commits: [], decisions: [`d-${input.task.id}`], warnings: [], followUp: [] };
    if (beh.kind === 'hang') {
      const outcome = await new Promise<RunnerOutcome>((resolve) => {
        this.resolvers.set(`${input.task.id}#${input.attempt}`, resolve);
        input.signal.addEventListener('abort', () => {
          this.resolvers.delete(`${input.task.id}#${input.attempt}`);
          resolve({ kind: 'error', outcome: 'cancelled', message: 'aborted' });
        }, { once: true });
      });
      return finish(outcome);
    }
    if (beh.delayMs) await new Promise((r) => setTimeout(r, beh.delayMs));
    if (input.signal.aborted) return finish({ kind: 'error', outcome: 'cancelled', message: 'aborted' });
    if (beh.kind === 'success') return finish({ kind: 'result', result: { ...base, ...beh.result }, exitCode: 0, usage: { costUsd: 0.01 } });
    if (beh.kind === 'status') return finish({ kind: 'result', result: { ...base, status: beh.status, error: beh.error, summary: `${beh.status} ${input.task.id}` }, exitCode: 0 });
    return finish({ kind: 'error', outcome: beh.outcome, message: beh.message ?? beh.outcome, exitCode: 1, usage: { sessionId: `s-${this.calls.length}` } });
  }
}

/** Workspace manager double that records acquisitions and can simulate merge conflicts. */
export class MockWorkspace implements WorkspaceManager {
  readonly sharedRoot: string;
  private readonly mutex = new KeyedMutex();
  acquisitions: Array<{ taskId: string; attempt: number; mode: string }> = [];
  conflictFor = new Set<string>();
  mergeSucceeds = true;
  /** Set to make a worktree finalize return a git block, as the real manager does for a worktree attempt. */
  gitInfo: GitInfo | undefined;
  constructor(root: string) {
    this.sharedRoot = root;
  }
  lockShared(): Promise<() => void> {
    return this.mutex.acquire('shared');
  }
  async prepareRun(): Promise<RunPreparation> {
    return { baseBranch: 'main', baseCommit: 'base', warnings: [] };
  }
  async acquire(task: ResolvedTask, attempt: number, mode: 'shared' | 'worktree'): Promise<WorkspaceInfo> {
    this.acquisitions.push({ taskId: task.id, attempt, mode });
    if (mode === 'shared') return { kind: 'shared', path: this.sharedRoot, cwd: task.workingDirectory };
    return { kind: 'worktree', path: path.join(this.sharedRoot, '.orchestrator', 'worktrees', task.id), cwd: path.join(this.sharedRoot, '.orchestrator', 'worktrees', task.id), branch: `orchestrator/${task.id}`, baseSha: 'base' };
  }
  async finalize(task: ResolvedTask, info: WorkspaceInfo, outcome: string): Promise<FinalizeResult> {
    if (info.kind === 'worktree' && outcome === 'success') {
      const git = this.gitInfo ? { git: this.gitInfo } : {};
      if (this.conflictFor.has(task.id)) {
        return { workspace: info, warnings: [], ...git, merge: { status: 'conflict', branch: info.branch, into: 'main', conflicts: ['shared.txt'], output: 'CONFLICT' } };
      }
      return { workspace: { ...info, mergedSha: 'merged' }, warnings: [], ...git, merge: { status: 'merged', branch: info.branch, into: 'main', sha: 'mergedsha123' } };
    }
    return { workspace: info, warnings: [] };
  }
  async completeMerge(_task: ResolvedTask, info: WorkspaceInfo): Promise<FinalizeResult> {
    if (this.mergeSucceeds) return { workspace: { ...info, mergedSha: 'm2' }, warnings: [], merge: { status: 'merged', branch: info.branch, into: 'main', sha: 'm2sha12345' } };
    return { workspace: info, warnings: [], merge: { status: 'conflict', branch: info.branch, into: 'main', output: 'still conflicted' } };
  }
  async captureMergeAttempt(_task: ResolvedTask, info: WorkspaceInfo): Promise<FinalizeResult> {
    return { workspace: info, warnings: [], diff: fakeDiff(`merge-${info.branch ?? 'shared'}`) };
  }
  async cleanupWorktree(): Promise<void> {
    /* noop */
  }
  async cleanupRun(): Promise<void> {
    /* noop */
  }
}

/** A minimal CapturedDiff so tests can assert that an attempt's patch was persisted. */
function fakeDiff(label: string): CapturedDiff {
  return {
    schemaVersion: 1,
    base: 'base',
    head: 'head',
    truncated: false,
    additions: 1,
    deletions: 0,
    files: [{ path: `${label}.txt`, status: 'A', additions: 1, deletions: 0, binary: false }],
    patch: `--- /dev/null\n+++ b/${label}.txt\n@@ -0,0 +1 @@\n+${label}\n`,
  };
}

export function states(run: WorkflowRun): Record<string, string> {
  return Object.fromEntries(Object.entries(run.tasks).map(([id, t]) => [id, t.state]));
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Run a CLI command with stdout and stderr captured, exactly as a user would see them. */
export async function captureCli(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const collect = (append: (s: string) => void) => (chunk: unknown): boolean => {
    append(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(collect((s) => (stdout += s)) as typeof process.stdout.write);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(collect((s) => (stderr += s)) as typeof process.stderr.write);
  try {
    return { code: await fn(), stdout, stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}
