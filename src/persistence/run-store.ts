/** File-backed run persistence under <repository>/.orchestrator/runs/<run-id>/. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorkflowRun, TaskAttempt, LiveStatus } from '../types/run.js';
import type { AttemptDiff, EnrichedTaskResult } from '../types/result.js';
import type { CapturedDiff } from '../workspace/diff.js';
import type { WorkflowEvent } from '../types/events.js';
import { toInteractionRecord } from '../types/interaction.js';
import { createRunPaths, type RunPaths } from './paths.js';
import { allocateRunId } from './run-id.js';
import { appendLine, ensureDir, pathExists, readJson, readJsonIfExists, writeFileAtomic, writeFileAtomicSync } from '../util/fs.js';
import { Redactor } from '../logging/redact.js';
import { errorMessage, UsageError } from '../util/errors.js';
import { isProcessAlive, nowIso } from '../util/misc.js';

export interface RunLock {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface RunListEntry {
  runId: string;
  workflowName: string;
  state: WorkflowRun['state'];
  createdAt: string;
  endedAt?: string;
  repositoryRoot: string;
  progress: { total: number; done: number };
}

export interface RunStore {
  readonly paths: RunPaths;
  allocateRunId(): Promise<string>;
  saveRun(run: WorkflowRun): Promise<void>;
  saveRunSync(run: WorkflowRun): void;
  loadRun(runId: string): Promise<WorkflowRun>;
  resolveRunId(ref: string | undefined): Promise<string>;
  listRuns(): Promise<RunListEntry[]>;
  appendEvent(event: WorkflowEvent): Promise<void>;
  attemptDir(runId: string, taskId: string, attempt: number): Promise<string>;
  writeAttempt(runId: string, taskId: string, attempt: TaskAttempt): Promise<void>;
  writePrompt(runId: string, taskId: string, attempt: number, prompt: string): Promise<void>;
  writeDiff(runId: string, taskId: string, attempt: number, diff: CapturedDiff): Promise<void>;
  readDiff(runId: string, taskId: string, attempt: number): Promise<AttemptDiff | null>;
  readDiffPatch(runId: string, taskId: string, attempt: number): Promise<string | null>;
  writeResult(runId: string, taskId: string, result: EnrichedTaskResult): Promise<void>;
  writeContext(runId: string, taskId: string, markdown: string): Promise<void>;
  writeReport(runId: string, markdown: string): Promise<void>;
  writeLive(runId: string, live: LiveStatus): Promise<void>;
  readLive(runId: string): Promise<LiveStatus | null>;
  acquireLock(runId: string): Promise<{ ok: true } | { ok: false; lock: RunLock }>;
  heartbeat(runId: string): Promise<void>;
  releaseLock(runId: string): Promise<void>;
  readLock(runId: string): Promise<RunLock | null>;
}

export class FileRunStore implements RunStore {
  readonly paths: RunPaths;
  private redactor: Redactor;

  constructor(repositoryRoot: string, redactor = new Redactor()) {
    this.paths = createRunPaths(repositoryRoot);
    this.redactor = redactor;
  }

  setRedactor(redactor: Redactor): void {
    this.redactor = redactor;
  }

  async allocateRunId(): Promise<string> {
    const id = await allocateRunId(this.paths.runsDir);
    await ensureDir(this.paths.runDir(id));
    return id;
  }

  private serialize(run: WorkflowRun): string {
    return JSON.stringify(this.redactor.redactValue({ ...run, updatedAt: nowIso() }), null, 2);
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    await writeFileAtomic(this.paths.workflowFile(run.runId), this.serialize(run));
    await writeFileAtomic(this.paths.latestFile, run.runId).catch(() => undefined);
  }

  saveRunSync(run: WorkflowRun): void {
    writeFileAtomicSync(this.paths.workflowFile(run.runId), this.serialize(run));
  }

  async loadRun(runId: string): Promise<WorkflowRun> {
    const file = this.paths.workflowFile(runId);
    if (!(await pathExists(file))) throw new UsageError(`Run "${runId}" not found (${file})`);
    try {
      return await readJson<WorkflowRun>(file);
    } catch (err) {
      // A truncated workflow.json — a machine that lost power mid-save — otherwise surfaces as a bare
      // "Expected property name or '}'" with no hint of which file, or which run, to look at.
      throw new UsageError(`Run "${runId}" cannot be read: ${file} is not valid JSON (${errorMessage(err)}). Delete ${this.paths.runDir(runId)} or pick another run with "cao list".`);
    }
  }

  async resolveRunId(ref: string | undefined): Promise<string> {
    if (!ref || ref === 'latest') {
      try {
        const latest = (await fs.readFile(this.paths.latestFile, 'utf8')).trim();
        if (latest && (await pathExists(this.paths.workflowFile(latest)))) return latest;
      } catch {
        /* fall through */
      }
      const runs = await this.listRuns();
      if (runs.length === 0) throw new UsageError(`No runs found under ${this.paths.runsDir}. Start one with "cao run".`);
      return runs[0]!.runId;
    }
    if (await pathExists(this.paths.workflowFile(ref))) return ref;
    const runs = await this.listRuns();
    const matches = runs.filter((r) => r.runId.startsWith(ref) || r.runId.endsWith(ref));
    if (matches.length === 1) return matches[0]!.runId;
    if (matches.length > 1) throw new UsageError(`Run id "${ref}" is ambiguous: ${matches.map((m) => m.runId).join(', ')}`);
    throw new UsageError(`Run "${ref}" not found under ${this.paths.runsDir}. List them with "cao list".`);
  }

  async listRuns(): Promise<RunListEntry[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.paths.runsDir);
    } catch {
      return [];
    }
    const entries: RunListEntry[] = [];
    for (const name of names) {
      const run = await readJsonIfExists<WorkflowRun>(this.paths.workflowFile(name)).catch(() => null);
      if (!run) continue;
      const states = Object.values(run.tasks);
      entries.push({
        runId: run.runId,
        workflowName: run.workflowName,
        state: run.state,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
        repositoryRoot: run.repositoryRoot,
        progress: {
          total: states.length,
          done: states.filter((t) => ['success', 'skipped'].includes(t.state)).length,
        },
      });
    }
    // Newest first: run ids are allocated per day, so a run created after midnight must not sort under yesterday's.
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
  }

  /**
   * Run directories `listRuns` had to skip. A run whose workflow.json is missing or corrupt is dropped
   * silently there, which leaves `cao list` saying "No runs found" next to a directory full of them.
   */
  async listUnreadableRuns(): Promise<string[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.paths.runsDir, { withFileTypes: true }).then((all) => all.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      return [];
    }
    const bad: string[] = [];
    for (const name of names) {
      const run = await readJsonIfExists<WorkflowRun>(this.paths.workflowFile(name)).catch(() => null);
      if (!run) bad.push(name);
    }
    return bad.sort();
  }

  async appendEvent(event: WorkflowEvent): Promise<void> {
    if (event.type === 'task.output' || event.type === 'task.transcript' || event.type === 'task.usage') return; // per-attempt detail lives in the attempt directory
    // Same rule for an interaction: its raw tool input is whole file contents and complete shell commands,
    // which the redactor cannot vet, so the run log keeps only the summary and the input stays in the attempt.
    const body: unknown = event.type === 'task.interaction.requested' ? { ...event, interaction: toInteractionRecord(event.interaction) } : event;
    await appendLine(this.paths.eventsFile(event.runId), JSON.stringify(this.redactor.redactValue(body)));
  }

  async attemptDir(runId: string, taskId: string, attempt: number): Promise<string> {
    const dir = this.paths.attemptDir(runId, taskId, attempt);
    await ensureDir(dir);
    return dir;
  }

  async writeAttempt(runId: string, taskId: string, attempt: TaskAttempt): Promise<void> {
    const dir = await this.attemptDir(runId, taskId, attempt.number);
    await writeFileAtomic(path.join(dir, 'attempt.json'), JSON.stringify(this.redactor.redactValue(attempt), null, 2));
  }

  async writePrompt(runId: string, taskId: string, attempt: number, prompt: string): Promise<void> {
    const dir = await this.attemptDir(runId, taskId, attempt);
    await writeFileAtomic(path.join(dir, 'prompt.md'), this.redactor.redact(prompt));
  }

  /** `diff.patch` and `diff.json` for one attempt. Both go through the redactor, like every other artifact. */
  async writeDiff(runId: string, taskId: string, attempt: number, diff: CapturedDiff): Promise<void> {
    const { patch, ...records } = diff;
    await this.attemptDir(runId, taskId, attempt);
    await writeFileAtomic(this.paths.diffPatchFile(runId, taskId, attempt), this.redactor.redact(patch));
    await writeFileAtomic(
      this.paths.diffJsonFile(runId, taskId, attempt),
      JSON.stringify(this.redactor.redactValue(records satisfies AttemptDiff), null, 2),
    );
  }

  /** The `diff.json` of one attempt, or null when the attempt captured none (older run, `git.captureDiff: false`). */
  async readDiff(runId: string, taskId: string, attempt: number): Promise<AttemptDiff | null> {
    return readJsonIfExists<AttemptDiff>(this.paths.diffJsonFile(runId, taskId, attempt)).catch(() => null);
  }

  /** The `diff.patch` of one attempt, verbatim; null when there is none. An empty patch means "changed nothing". */
  async readDiffPatch(runId: string, taskId: string, attempt: number): Promise<string | null> {
    try {
      return await fs.readFile(this.paths.diffPatchFile(runId, taskId, attempt), 'utf8');
    } catch {
      return null;
    }
  }

  async writeResult(runId: string, taskId: string, result: EnrichedTaskResult): Promise<void> {
    await writeFileAtomic(this.paths.resultFile(runId, taskId), JSON.stringify(this.redactor.redactValue(result), null, 2));
  }

  async writeContext(runId: string, taskId: string, markdown: string): Promise<void> {
    await writeFileAtomic(this.paths.contextFile(runId, taskId), this.redactor.redact(markdown));
  }

  /** `report.md` in the run directory: the run's own summary of itself, rewritten whenever the run ends. */
  async writeReport(runId: string, markdown: string): Promise<void> {
    await writeFileAtomic(this.paths.reportFile(runId), this.redactor.redact(markdown));
  }

  async writeLive(runId: string, live: LiveStatus): Promise<void> {
    await writeFileAtomic(this.paths.liveFile(runId), JSON.stringify(this.redactor.redactValue(live), null, 2));
  }

  async readLive(runId: string): Promise<LiveStatus | null> {
    return readJsonIfExists<LiveStatus>(this.paths.liveFile(runId)).catch(() => null);
  }

  async readLock(runId: string): Promise<RunLock | null> {
    return readJsonIfExists<RunLock>(this.paths.lockFile(runId)).catch(() => null);
  }

  async acquireLock(runId: string): Promise<{ ok: true } | { ok: false; lock: RunLock }> {
    const existing = await this.readLock(runId);
    if (existing && existing.pid !== process.pid) {
      const fresh = Date.now() - new Date(existing.heartbeatAt).getTime() < 60_000;
      if (fresh && isProcessAlive(existing.pid)) return { ok: false, lock: existing };
    }
    const now = nowIso();
    await writeFileAtomic(this.paths.lockFile(runId), JSON.stringify({ pid: process.pid, startedAt: now, heartbeatAt: now }, null, 2));
    return { ok: true };
  }

  /**
   * Announce that this process still owns the run, and put the lock back if it has gone missing.
   *
   * The lock file is what tells `cao run`, `cao resume` and `cao stop` that an orchestrator is working in
   * this tree; losing it while the orchestrator is alive invites a second one in. Nothing here can find out
   * what removed it, but the owner is the authority on whether the run is still being executed, so the
   * heartbeat rewrites it. The heartbeat is stopped before `releaseLock`, so this never resurrects a
   * released lock.
   */
  async heartbeat(runId: string): Promise<void> {
    const lock = await this.readLock(runId);
    if (lock && lock.pid !== process.pid) return;
    const now = nowIso();
    const next: RunLock = lock ? { ...lock, heartbeatAt: now } : { pid: process.pid, startedAt: now, heartbeatAt: now };
    await writeFileAtomic(this.paths.lockFile(runId), JSON.stringify(next, null, 2));
  }

  async releaseLock(runId: string): Promise<void> {
    const lock = await this.readLock(runId);
    if (lock && lock.pid !== process.pid) return;
    await fs.rm(this.paths.lockFile(runId), { force: true }).catch(() => undefined);
  }
}
