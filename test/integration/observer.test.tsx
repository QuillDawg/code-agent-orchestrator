/**
 * The workspace on a run **another process** is executing (spec §2.1, §2.3, `[D3]`, `[D37]`).
 *
 * Everything else about observer mode can be tested in one process — the state machine, the merge, the
 * frame. The property this file exists for cannot: that a second `cao` can open a workspace on a run
 * directory somebody else owns, see it move, reach the owner through `requests/`, and notice when the owner
 * stops existing. So the owner here is a real child process running the real scheduler against the fake
 * CLIs, and the workspace is the real Ink tree in the in-house harness, reading the same run directory.
 *
 * The child is `node --import tsx src/bin.ts`, not `dist/bin.js`, for the reason the inbox test in
 * `cli-consistency.test.ts` gives: the property under test is the process boundary, and running the sources
 * keeps `npm test` from depending on a build.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execa, type ResultPromise } from 'execa';
import { spawn, type ChildProcess } from 'node:child_process';
import { DashboardApp, type DashboardShared } from '../../src/tui/app.js';
import { createPresentationStore, type PresentationStore } from '../../src/tui/store.js';
import { renderTree, type RenderedTree } from '../helpers/ink-harness.js';
import { FileRunStore } from '../../src/persistence/run-store.js';
import { createRunObserver, type RunObserver } from '../../src/workflow/control/observer.js';
import { ownershipBadge, ownershipBanner } from '../../src/cli/ownership.js';
import { readAck } from '../../src/persistence/requests.js';
import { pathExists } from '../../src/util/fs.js';
import { nowIso } from '../../src/util/misc.js';
import { tmpGitRepo, gitAvailable, FAKE_CLAUDE } from '../helpers/index.js';
import type { LiveStatus } from 'code-agent-orchestrator-protocol';

const HAS_GIT = await gitAvailable('observer suite');
const NL = String.fromCharCode(10);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = async (ms = 30): Promise<void> => {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

async function until(cond: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const require_ = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require_.resolve('tsx')).href;
const root = process.cwd();
const cao = (args: string[], cwd: string, env: Record<string, string>): ResultPromise =>
  execa(process.execPath, ['--import', tsxLoader, path.join(root, 'src', 'bin.ts'), ...args], { cwd, env, reject: false, windowsHide: true });

const shared = (): DashboardShared => ({ queue: [], listeners: new Set(), notify: () => undefined, remove: () => false });

/**
 * The workspace, mounted the way `cao ui` mounts it on a run somebody else owns: the observer's controller
 * and surface, and the presentation store fed from the poll tick rather than from an event bus.
 */
function openWorkspace(observer: RunObserver, runId: string, size = { columns: 120, rows: 36 }): { tree: RenderedTree; store: PresentationStore } {
  const store = createPresentationStore();
  let seq = 0;
  const element = (): React.JSX.Element => {
    const ownership = observer.ownership;
    const owned = ownership.kind === 'owned';
    return (
      <DashboardApp
        run={observer.run}
        bus={{ onAny: () => () => undefined } as never}
        controller={observer.controller}
        shared={shared()}
        finished
        store={store}
        onMinimise={() => undefined}
        onInterrupt={() => undefined}
        onQuit={() => undefined}
        onResume={() => undefined}
        role={owned ? 'observer' : 'owner'}
        badge={ownershipBadge(ownership)}
        banner={ownershipBanner(ownership, runId)}
        observer={owned ? observer.surface : undefined}
      />
    );
  };
  const tree = renderTree(element(), size);
  observer.onChange((view) => {
    store.getState().setSnapshot({ seq: (seq += 1), at: Date.now(), run: view.run });
    tree.rerender(element());
  });
  observer.start();
  return { tree, store };
}

const trees: RenderedTree[] = [];
const children: Array<ResultPromise | ChildProcess> = [];
const observers: RunObserver[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) tree.unmount();
  for (const observer of observers.splice(0)) observer.stop();
  for (const child of children.splice(0)) child.kill();
});

async function startOwner(): Promise<{ repo: string; store: FileRunStore; runId: string; child: ResultPromise }> {
  const repo = await tmpGitRepo('cao-observer-');
  await fs.writeFile(path.join(repo, 'workflow.yaml'), ['name: watched', 'tasks:', '  - id: implement-api', '    prompt: p'].join(NL) + NL, 'utf8');
  const env = { CAO_CLAUDE_COMMAND: FAKE_CLAUDE, FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '2000' };
  const child = cao(['run', 'workflow.yaml', '--no-tui'], repo, env);
  children.push(child);
  const store = new FileRunStore(repo);
  let runId = '';
  await until(async () => {
    runId = (await store.listRuns().catch(() => []))[0]?.runId ?? '';
    return runId !== '' && (await pathExists(store.paths.lockFile(runId)));
  });
  return { repo, store, runId, child };
}

describe.skipIf(!HAS_GIT)('a workspace on a run another process owns', () => {
  it('shows the run moving under it, and reaches its owner through the inbox', async () => {
    const { store, runId, child } = await startOwner();
    const observer = createRunObserver({ store, runId, run: await store.loadRun(runId), intervalMs: 200 });
    observers.push(observer);
    const { tree } = openWorkspace(observer, runId);
    trees.push(tree);

    // The banner names the process that has the run, and the badge says this window is only watching (§2.1).
    await act();
    await tree.waitFor((text) => text.includes(`observing · owner pid ${child.pid}`), { timeout: 20_000 });
    expect(tree.lastText()).toContain(`owned by pid ${child.pid}`);

    // And the picture moves: `workflow.json` and `live.json` are re-read on the poll, not mirrored from an
    // event bus this process has no access to.
    await tree.waitFor((text) => text.includes('Running'), { timeout: 20_000 });

    // `S` is a file in `requests/`, answered by the owner on its own tick (§2.3). The notice is the ack.
    await React.act(async () => {
      tree.write('s');
      await new Promise((r) => setTimeout(r, 50));
    });
    await tree.waitFor((text) => text.includes('stop sent → applied'), { timeout: 20_000 });

    const finished = await child;
    expect(finished.exitCode).not.toBe(0);
    expect((await store.loadRun(runId)).state).toBe('interrupted');

    // The ack really is on disk under the id the workspace sent, and the request was consumed.
    const ackNames = await fs.readdir(store.paths.requestAcksDir(runId));
    const acks = await Promise.all(ackNames.map((n) => readAck(store.paths, runId, n.replace(/\.json$/, ''))));
    expect(acks.map((a) => a!.status)).toContain('applied');
    // `acks/` is a subdirectory of `requests/`; nothing else is left, because the owner deletes a request
    // once its answer is on disk (§2.3).
    expect((await fs.readdir(store.paths.requestsDir(runId))).filter((n) => n.endsWith('.json'))).toEqual([]);
  }, 180_000);

  it('says the run is abandoned once the process holding it is gone', async () => {
    const { store, runId, child } = await startOwner();
    const observer = createRunObserver({ store, runId, run: await store.loadRun(runId), intervalMs: 200 });
    observers.push(observer);
    const { tree } = openWorkspace(observer, runId);
    trees.push(tree);
    await act();
    await tree.waitFor((text) => text.includes(`observing · owner pid ${child.pid}`), { timeout: 20_000 });

    // Killed rather than stopped: the lock stays behind, which is exactly the case §2.1 calls abandoned —
    // a record of an owner, and no owner.
    child.kill('SIGKILL');
    await child.catch(() => undefined);
    expect(await pathExists(store.paths.lockFile(runId))).toBe(true);

    await tree.waitFor((text) => text.includes('abandoned · resume?'), { timeout: 20_000 });
    // And with nobody holding it, this window is an owner candidate again: §2.4's actions are back and the
    // observer's are gone.
    expect(tree.lastText()).toContain('S Resume run');
    expect(tree.lastText()).not.toContain('S Stop the run');
  }, 180_000);

  it('renders a question the owner is holding read-only, and names the terminal that can answer it', async () => {
    // The owner here is a process that holds the lock and writes `live.json` — which is all §2.1 says an
    // observer reads. A real orchestrator run headlessly cannot hold a question open (`--no-tui` has no
    // handler, so the prompt is denied at once), and the property under test is what this window does with
    // one, across a process boundary: show it, name the pid, and offer no way to answer it `[D3]`.
    const { store, runId, child } = await startOwner();
    await child;
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(holder);
    await fs.writeFile(store.paths.lockFile(runId), JSON.stringify({ pid: holder.pid, startedAt: nowIso(), heartbeatAt: nowIso() }));
    const live: LiveStatus = {
      runId,
      orchestratorPid: holder.pid!,
      heartbeatAt: nowIso(),
      state: 'running',
      tasks: { 'implement-api': { state: 'needs_input', pendingInteraction: { id: 'i1', kind: 'question', title: 'which database?', askedAt: nowIso() } } as never },
    };
    await store.writeLive(runId, live);

    const observer = createRunObserver({ store, runId, run: await store.loadRun(runId), intervalMs: 200 });
    observers.push(observer);
    const { tree } = openWorkspace(observer, runId);
    trees.push(tree);
    await act();
    await tree.waitFor((text) => text.includes('answer in the owning terminal'), { timeout: 20_000 });
    const frame = tree.lastText();
    expect(frame).toContain('implement-api (question: which database?)');
    expect(frame).toContain(`answer in the owning terminal (pid ${holder.pid})`);

    // No modal, no answer keys: the permission controls do not cross the boundary [D3].
    await React.act(async () => {
      tree.write('a');
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(tree.lastText()).not.toContain('Answer implement-api');
    expect(tree.lastText()).toContain('answer in the owning terminal');
  }, 180_000);
});
