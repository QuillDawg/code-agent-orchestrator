/**
 * `packages/protocol/` — the contract shared with CAO Desktop (spec §4.1, §4.1.1, §5.5).
 *
 * Three properties, each of which is only noticed when it is already broken:
 *
 * 1. **The package is browser-safe.** The whole reason it exists is that the app cannot bundle
 *    `code-agent-orchestrator`, whose entry point reaches `node:fs` through `FileRunStore` and dies in a Vite
 *    build. One `node:path` added here for convenience reproduces that failure in the package meant to
 *    prevent it, and nothing in `npm test` would otherwise notice — `cao` itself runs on Node.
 * 2. **Every moved symbol moved.** §4.1 lists what crosses; if one is still declared in `src/` as well, the
 *    two copies are free to drift and the app has no way to tell which one it is compiled against.
 * 3. **`code-agent-orchestrator`'s published surface is unchanged.** A consumer importing it sees what it saw
 *    before the move.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = process.cwd();
const pkgDir = path.join(root, 'packages', 'protocol');
const distEntry = path.join(pkgDir, 'dist', 'index.js');

/** Names declared and exported by a TypeScript module, at the top level. */
const DECLARATION = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

async function declarationsIn(dir: string, extensions: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        await walk(full);
      } else if (extensions.some((e) => entry.name.endsWith(e))) {
        const text = await fs.readFile(full, 'utf8');
        for (const match of text.matchAll(DECLARATION)) {
          const name = match[1]!;
          found.set(name, [...(found.get(name) ?? []), path.relative(root, full).replace(/\\/g, '/')]);
        }
      }
    }
  };
  await walk(dir);
  return found;
}

/**
 * §4.1's move list, verbatim. Written out rather than derived, because deriving it from what the package
 * happens to export would make this test agree with any mistake.
 */
const MOVE_LIST = [
  // types/workflow.ts — the whole file
  'ResolvedWorkflow', 'ResolvedTask', 'AgentName', 'WorkspaceMode', 'RetryPolicy', 'OnFailure', 'Effort',
  // runners/task-runner.ts
  'RunnerFailure',
  // persistence/paths.ts
  'ORCHESTRATOR_DIR', 'RunPaths', 'createRunPaths',
  // types/events.ts
  'WorkflowEvent', 'WorkflowEventBody', 'EventMeta', 'EventOf',
  // types/run.ts
  'TaskState', 'RunState', 'TaskReason', 'AttemptOutcome', 'WorkflowRun', 'TaskRunState', 'TaskAttempt',
  'LiveStatus', 'LiveTaskStatus', 'WorkspaceInfo', 'RunSummary', 'TERMINAL_TASK_STATES', 'ACTIVE_TASK_STATES',
  // types/result.ts
  'TaskResult', 'EnrichedTaskResult', 'RunnerUsage', 'AttemptDiff', 'DiffFileRecord', 'GitInfo', 'addUsage',
  // types/interaction.ts
  'Interaction', 'InteractionAnswer', 'InteractionRecord', 'InteractionQuestion', 'InteractionAnswerSource',
  'describeAnswer', 'canAllowAlways', 'toInteractionRecord',
  // types/transcript.ts
  'TranscriptEntry', 'FileOp', 'transcriptLine', 'parseTranscriptLine',
  // tui/transcript.ts
  'planTranscript', 'PlannedEntry', 'TranscriptFilter', 'TRANSCRIPT_FILTERS', 'FILTER_LABEL', 'nextFilter',
  'filterEntries',
  // new to the contract
  'RegistryEntry', 'ControlRequest', 'PendingInteractionFile', 'PresenceFile', 'CAPABILITIES', 'PROTOCOL_VERSION',
  // §2.2, §2.3 and §2.6 — the control contract and what an applied edit or prompt leaves behind
  'ControlAck', 'ControlSource', 'ControlExpectation', 'TaskEdit', 'TaskRevision', 'PromptDelivery', 'QuotaSnapshot',
];

beforeAll(() => {
  // `npm test` builds it first; a bare `vitest run` does not, and this suite reads the built output.
  if (!existsSync(distEntry)) {
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(pkgDir, 'tsconfig.json')], { stdio: 'inherit' });
  }
}, 120_000);

describe('the protocol package is browser-safe', () => {
  it('declares no runtime dependency of any kind', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.name).toBe('code-agent-orchestrator-protocol');
    // Its own semver, moved only when the contract moves (§4.1.1) — never pinned to `cao`'s version.
    const cao = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string>; workspaces: string[] };
    expect(manifest.version).not.toBe(cao.version);
    expect(cao.workspaces).toContain('packages/*');
    // A caret range, not a file: link — the published artifact must resolve the same way a consumer's does.
    expect(cao.dependencies['code-agent-orchestrator-protocol']).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it('bundles for a browser with nothing external, so no import escapes the package', async () => {
    // Any `node:` specifier, and any bare specifier at all, fails to resolve here and throws. That is the
    // check: a browser bundle with an empty `external` list has nowhere to put an import it cannot inline.
    const result = await build({
      entryPoints: [distEntry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      external: [],
      write: false,
      logLevel: 'silent',
    });
    const code = result.outputFiles!.map((f) => f.text).join('\n');
    expect(code.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    // Belt and braces: esbuild would have thrown above, but a future config change must not make it quiet.
    for (const forbidden of ['node:', 'require(', '__dirname', '__filename', 'process.env']) {
      expect(code).not.toContain(forbidden);
    }
  }, 60_000);

  it('emits no import that leaves the package', async () => {
    const dist = path.join(pkgDir, 'dist');
    const specifiers: string[] = [];
    for (const name of await fs.readdir(dist)) {
      if (!name.endsWith('.js') && !name.endsWith('.d.ts')) continue;
      const text = await fs.readFile(path.join(dist, name), 'utf8');
      // Both forms: `import … from 'x'` / `export … from 'x'`, and the side-effect `import 'x'`.
      for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+'([^']+)'/g)) specifiers.push(match[1]!);
      for (const match of text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) specifiers.push(match[1]!);
    }
    expect(specifiers.length).toBeGreaterThan(0);
    // Relative only: no builtin, no dependency, and nothing a `.d.ts` consumer has to install separately.
    expect(specifiers.filter((s) => !s.startsWith('./') && !s.startsWith('../'))).toEqual([]);
  });
});

describe('the move list moved rather than being copied', () => {
  it('declares every symbol §4.1 lists, exactly once, inside the package', async () => {
    const declared = await declarationsIn(path.join(pkgDir, 'src'), ['.ts']);
    const missing = MOVE_LIST.filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
    const twice = [...declared.entries()].filter(([, files]) => files.length > 1);
    expect(twice).toEqual([]);
  });

  it('leaves no second declaration of any of them behind in src/', async () => {
    const inPackage = await declarationsIn(path.join(pkgDir, 'src'), ['.ts']);
    const inCao = await declarationsIn(path.join(root, 'src'), ['.ts', '.tsx']);
    const declaredTwice = [...inPackage.keys()].filter((name) => inCao.has(name)).map((name) => `${name}: ${inCao.get(name)!.join(', ')}`);
    expect(declaredTwice).toEqual([]);
  });

  it('keeps the ANSI-and-glyph layer in the CLI and imports the structure from the package', async () => {
    const transcript = await fs.readFile(path.join(root, 'src', 'tui', 'transcript.ts'), 'utf8');
    expect(transcript).toContain('export function renderTranscript');
    expect(transcript).toContain('export function renderEntry');
    expect(transcript).toMatch(/import \{[\s\S]*?planTranscript[\s\S]*?\} from 'code-agent-orchestrator-protocol';/);
    expect(transcript).not.toContain('export function planTranscript');
  });

  it('builds run paths in one place, so nobody hand-rolls the layout (§6.4.1)', async () => {
    // A `.orchestrator` string literal outside the package is how a second implementation of the layout
    // starts; `ORCHESTRATOR_DIR` is the package's own constant and is what code is meant to reach for.
    // Comments are stripped first: the directory is named all over the prose, and prose cannot drift.
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const code = (await fs.readFile(full, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          if (/['"`]\.orchestrator\b/.test(code)) offenders.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    };
    await walk(path.join(root, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe("code-agent-orchestrator's published surface", () => {
  it('still exports everything the move list took away', async () => {
    const surface = (await import('../../src/index.js')) as Record<string, unknown>;
    const values = ['ORCHESTRATOR_DIR', 'createRunPaths', 'TERMINAL_TASK_STATES', 'ACTIVE_TASK_STATES', 'addUsage',
      'describeAnswer', 'canAllowAlways', 'toInteractionRecord', 'transcriptLine', 'parseTranscriptLine',
      'planTranscript', 'TRANSCRIPT_FILTERS', 'FILTER_LABEL', 'nextFilter', 'filterEntries', 'CAPABILITIES',
      'PROTOCOL_VERSION', 'renderTranscript', 'renderEntry'];
    expect(values.filter((name) => surface[name] === undefined)).toEqual([]);
    // Stayed behind with the CLI when the interaction types left, and was exported before the move.
    expect(typeof surface.withoutWorkerInstructions).toBe('function');
    expect(typeof surface.asSentence).toBe('function');
    expect(typeof surface.NEEDS_INPUT_HINT).toBe('string');
  });
});

describe('the new contract types (§4.2.3, §4.3.1, §4.4.2, §4.6.1)', () => {
  it('fixes PROTOCOL_VERSION at 1 and names every capability token the spec uses', async () => {
    const { PROTOCOL_VERSION, CAPABILITIES } = (await import('code-agent-orchestrator-protocol')) as typeof import('code-agent-orchestrator-protocol');
    expect(PROTOCOL_VERSION).toBe(1);
    // The eight §4.2.3 advertises, plus `feed` (§10.1), which `feedUrl` is conditioned on, and the two
    // control kinds §2.6 adds — a run advertises `edit` and `prompt` only once it applies them.
    expect([...CAPABILITIES]).toEqual([
      'requests', 'stop', 'kill', 'answer', 'approve', 'restart', 'edit', 'prompt', 'interactions', 'presence', 'feed',
    ]);
  });

  it('types a registry entry with the fields, nullability and machine identity §4.2.3 specifies', async () => {
    const { PROTOCOL_VERSION } = await import('code-agent-orchestrator-protocol');
    type Entry = import('code-agent-orchestrator-protocol').RegistryEntry;
    // A run that is still going: every "not yet" field is present and null, never absent (§4.2.3's JSON).
    const entry: Entry = {
      protocol: PROTOCOL_VERSION,
      key: '2026-09-10-001@a1b2c3d4',
      runId: '2026-09-10-001',
      repositoryRoot: 'C:/Projects/CodeAgentOrchestrator',
      orchestratorDir: 'C:/Projects/CodeAgentOrchestrator/.orchestrator',
      workflowName: 'beta-improvements',
      configPath: 'C:/Projects/workflows/beta.yaml',
      machine: { hostname: 'DESKTOP-K2R9', platform: 'win32', arch: 'x64' },
      pid: 24188,
      cliVersion: '0.1.0-beta.3',
      state: 'running',
      startedAt: '2026-09-10T08:14:02.411Z',
      heartbeatAt: '2026-09-10T09:02:22.108Z',
      endedAt: null,
      exitCode: null,
      taskCount: 7,
      capabilities: ['requests', 'stop', 'kill', 'answer', 'approve', 'restart', 'interactions', 'presence'],
      feedUrl: null,
    };
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    // Unknown capability tokens are read, not rejected: each side ignores what it does not know (§4.5).
    const newer: Entry = { ...entry, capabilities: [...entry.capabilities, 'something-later'] };
    expect(newer.capabilities).toContain('something-later');
  });

  it('types a control request whose kind-specific fields are optional (§4.3.1)', async () => {
    const { CONTROL_REQUEST_KINDS, PROTOCOL_VERSION } = await import('code-agent-orchestrator-protocol');
    type Request = import('code-agent-orchestrator-protocol').ControlRequest;
    expect([...CONTROL_REQUEST_KINDS]).toEqual(['stop', 'kill', 'approve', 'reject', 'answer', 'restart', 'edit', 'prompt', 'pause', 'resume']);
    const stop: Request = { protocol: PROTOCOL_VERSION, id: '01K7Q3M8XA', kind: 'stop', requestedAt: '2026-09-10T09:03:11.008Z', source: 'cao-desktop 0.1.0', pid: 4188 };
    const answer: Request = { ...stop, id: '01K7Q3N1B2', kind: 'answer', taskId: 'implement-api', uid: 'implement-api.2.1', answer: { kind: 'allow', scope: 'once' } };
    expect(Object.keys(stop)).toEqual(['protocol', 'id', 'kind', 'requestedAt', 'source', 'pid']);
    expect(answer.answer).toEqual({ kind: 'allow', scope: 'once' });

    // §2.3 adds `edit` and `prompt` to the kinds a file may name, and `expected` to every kind: a request
    // built on a task that has since moved on is refused rather than applied to work nobody looked at.
    const edit: Request = { ...stop, id: '01K7Q3N1B3', kind: 'edit', taskId: 'implement-api', changes: { model: 'opus', note: 'try the bigger model' }, restart: true, expected: { attempt: 2, revision: 0 } };
    const prompt: Request = { ...stop, id: '01K7Q3N1B4', kind: 'prompt', taskId: 'implement-api', text: 'use the repo helper', mode: 'steer' };
    expect(edit.expected).toEqual({ attempt: 2, revision: 0 });
    expect(prompt.mode).toBe('steer');
  });

  it('types a revision, a delivery and a quota snapshot the way §2.6 writes them', async () => {
    const { PROMPT_DELIVERY_MODES, PROTOCOL_VERSION, TASK_EDIT_FIELDS } = await import('code-agent-orchestrator-protocol');
    type Revision = import('code-agent-orchestrator-protocol').TaskRevision;
    type Delivery = import('code-agent-orchestrator-protocol').PromptDelivery;
    type Quota = import('code-agent-orchestrator-protocol').QuotaSnapshot;
    expect([...PROMPT_DELIVERY_MODES]).toEqual(['steer', 'followUp', 'stopAndContinue']);
    expect([...TASK_EDIT_FIELDS]).toEqual(['prompt', 'agent', 'model', 'effort', 'timeout', 'retries', 'maxBudgetUsd']);

    const revision: Revision = {
      number: 1, at: '2026-09-17T09:03:11.008Z', source: 'inbox', pid: 4188,
      changes: { model: { from: 'sonnet', to: 'opus' } }, note: 'try the bigger model', appliedToAttempt: 3,
    };
    const delivery: Delivery = {
      id: '01K7Q3N1B4', at: '2026-09-17T09:04:00.000Z', source: 'tui', mode: 'followUp',
      transport: 'claude-stream', state: 'queued', text: 'use the repo helper',
    };
    const quota: Quota = {
      protocol: PROTOCOL_VERSION, provider: 'claude', readAt: '2026-09-17T09:05:00.000Z', state: 'ok',
      planType: 'max', windows: [{ label: '5-hour', durationMins: 300, usedPercent: 41, resetsAt: '2026-09-17T12:00:00.000Z' }],
    };
    expect(JSON.parse(JSON.stringify({ revision, delivery, quota }))).toEqual({ revision, delivery, quota });

    // They hang off the run state the same way, and both are optional: a run that has never been edited
    // carries neither field, and `schemaVersion` stays 1 (§2.6).
    type Task = import('code-agent-orchestrator-protocol').TaskRunState;
    const task: Task = { id: 'implement-api', state: 'running', attempts: [], retryWindowStart: 1, revisions: [revision] };
    expect(task.revisions?.[0]?.number).toBe(1);
  });

  it('types a pending interaction and a presence file the way §4.4.2 and §4.6.1 write them', async () => {
    const { PROTOCOL_VERSION } = await import('code-agent-orchestrator-protocol');
    type Pending = import('code-agent-orchestrator-protocol').PendingInteractionFile;
    type Presence = import('code-agent-orchestrator-protocol').PresenceFile;
    const pending: Pending = {
      protocol: PROTOCOL_VERSION,
      uid: 'implement-api.2.1',
      taskId: 'implement-api',
      attempt: 2,
      runnerRequestId: 'req_17',
      interaction: {
        id: 'req_17', kind: 'permission', taskId: 'implement-api', attempt: 2, agent: 'claude',
        toolName: 'Bash', title: 'Bash: npm publish', input: { command: 'npm publish' },
        requestedAt: '2026-09-10T09:03:11.008Z',
      },
      canAllowAlways: true,
      redactions: 1,
      expiresAt: '2026-09-10T09:08:11.008Z',
    };
    // `interactionTimeout: never` is the null case, not a missing field.
    const forever: Pending = { ...pending, expiresAt: null };
    expect(forever.expiresAt).toBeNull();

    const presence: Presence = {
      protocol: PROTOCOL_VERSION,
      pid: 24188,
      machine: { hostname: 'DESKTOP-K2R9', platform: 'win32', arch: 'x64' },
      surface: 'cao-desktop 0.1.0',
      startedAt: '2026-09-10T08:02:11.004Z',
      heartbeatAt: '2026-09-10T09:02:31.660Z',
      understands: ['requests', 'answer', 'approve', 'restart', 'interactions', 'presence'],
    };
    expect(JSON.parse(JSON.stringify(presence))).toEqual(presence);
  });
});

describe('run paths', () => {
  it('joins on / in the package, and on the platform separator in the CLI', async () => {
    const { createRunPaths } = await import('code-agent-orchestrator-protocol');
    const { createNativeRunPaths } = await import('../../src/persistence/paths.js');
    const repo = path.sep === '\\' ? 'C:\\work\\repo' : '/work/repo';

    // The package is browser-safe, so it has no `node:path` to ask and says `/` everywhere.
    expect(createRunPaths('/work/repo').eventsFile('2026-09-10-001')).toBe('/work/repo/.orchestrator/runs/2026-09-10-001/events.jsonl');
    expect(createRunPaths('C:/work/repo').attemptDir('2026-09-10-001', 'implement-api', 2)).toBe(
      'C:/work/repo/.orchestrator/runs/2026-09-10-001/tasks/implement-api/attempts/2',
    );
    // A trailing separator does not double up, and a drive root keeps the separator that gives it meaning.
    expect(createRunPaths('/work/repo/').root).toBe('/work/repo/.orchestrator');
    expect(createRunPaths('C:/').root).toBe('C:/.orchestrator');

    // The CLI writes these paths into workflow.json and prints them in `cao status`, so they stay native.
    const native = createNativeRunPaths(repo);
    expect(native.eventsFile('2026-09-10-001')).toBe(path.join(repo, '.orchestrator', 'runs', '2026-09-10-001', 'events.jsonl'));
    expect(native.attemptDir('2026-09-10-001', 'implement-api', 2)).toBe(path.join(repo, '.orchestrator', 'runs', '2026-09-10-001', 'tasks', 'implement-api', 'attempts', '2'));
    expect(native.root).toBe(path.join(repo, '.orchestrator'));
  });

  it('still refuses a traversing segment', async () => {
    const { createRunPaths } = await import('code-agent-orchestrator-protocol');
    expect(() => createRunPaths('/work/repo').runDir('../../etc')).toThrow(/Unsafe path segment/);
    expect(() => createRunPaths('/work/repo').taskDir('2026-09-10-001', '..')).toThrow(/Unsafe path segment/);
  });
});
