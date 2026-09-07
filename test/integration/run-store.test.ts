import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { createRun } from '../../src/workflow/run-factory.js';
import { Redactor } from '../../src/logging/redact.js';
import { buildWorkflow, tmpDir } from '../helpers/index.js';
import { followFile, readTail } from '../../src/tui/follow.js';

describe('FileRunStore', () => {
  it('allocates dated ids, persists runs, results, attempts and events with redaction', async () => {
    const root = await tmpDir();
    const store = new FileRunStore(root, new Redactor(['hunter2secret']));
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n', { repositoryRoot: root });
    const run = await createRun(store, { workflow, rawConfig: 'x' });
    expect(run.runId).toMatch(/^\d{4}-\d{2}-\d{2}-001$/);
    const run2 = await createRun(store, { workflow, rawConfig: 'x' });
    expect(run2.runId.endsWith('-002')).toBe(true);
    expect(await store.resolveRunId(undefined)).toBe(run2.runId);
    expect(await store.resolveRunId('002')).toBe(run2.runId);
    await expect(store.resolveRunId('nope')).rejects.toThrow(/not found/);

    await store.writeResult(run.runId, 'a', { taskId: 'a', attempt: 1, status: 'success', summary: 'token hunter2secret used', filesChanged: [], commits: [], decisions: [], warnings: [], followUp: [], completedAt: 'now' });
    const persisted = JSON.parse(await fs.readFile(store.paths.resultFile(run.runId, 'a'), 'utf8')) as { summary: string };
    expect(persisted.summary).toBe('token [REDACTED] used');

    await store.appendEvent({ seq: 1, ts: 'now', runId: run.runId, type: 'task.activity', taskId: 'a', attempt: 1, line: 'hunter2secret' });
    await store.appendEvent({ seq: 2, ts: 'now', runId: run.runId, type: 'task.output', taskId: 'a', attempt: 1, stream: 'stdout', line: 'x' });
    const events = (await fs.readFile(store.paths.eventsFile(run.runId), 'utf8')).trim().split('\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('[REDACTED]');

    await store.writePrompt(run.runId, 'a', 1, 'prompt with hunter2secret');
    expect(await fs.readFile(path.join(store.paths.attemptDir(run.runId, 'a', 1), 'prompt.md'), 'utf8')).toBe('prompt with [REDACTED]');

    const loaded = await store.loadRun(run.runId);
    expect(loaded.runId).toBe(run.runId);
    const list = await store.listRuns();
    expect(list.map((r) => r.runId)).toEqual([run2.runId, run.runId]);
  });

  it('locks runs per process and detects stale locks', async () => {
    const root = await tmpDir();
    const store = new FileRunStore(root);
    const runId = await store.allocateRunId();
    expect((await store.acquireLock(runId)).ok).toBe(true);
    // Another live process owning the lock → refused
    await fs.writeFile(store.paths.lockFile(runId), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    const denied = await store.acquireLock(runId);
    expect(denied.ok).toBe(false);
    // Stale heartbeat → taken over
    await fs.writeFile(store.paths.lockFile(runId), JSON.stringify({ pid: process.ppid, startedAt: 'x', heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect((await store.acquireLock(runId)).ok).toBe(true);
    await store.releaseLock(runId);
    expect(await store.readLock(runId)).toBeNull();
  });

  it('tails files that are being appended to', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'events.jsonl');
    await fs.writeFile(file, 'one\ntwo\n');
    expect(await readTail(file, 1)).toEqual(['two']);
    const seen: string[] = [];
    const controller = new AbortController();
    const done = followFile(file, (l) => seen.push(l), { intervalMs: 20, initialLines: 1, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 60));
    await fs.appendFile(file, 'three\nfour\n');
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await done;
    expect(seen).toEqual(['two', 'three', 'four']);
  });
});
