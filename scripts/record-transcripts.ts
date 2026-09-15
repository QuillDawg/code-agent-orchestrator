/**
 * Records the shared transcript corpus (spec §12.2) into `test/fixtures/transcripts/`.
 *
 *     npx tsx scripts/record-transcripts.ts
 *
 * §12.2 asks that the app's frontend unit tests run over **the same `events.jsonl` fixtures `cao` uses**,
 * so that the two renderers cannot disagree about structure: one corpus, two consumers. The corpus is
 * checked in once, here, and the app reaches it rather than keeping a copy — copying a JSONL file into
 * `cao-desktop/` is the failure that sentence exists to prevent.
 *
 * Nothing here is hand-written. Each file is a real attempt log, produced by the real `ClaudeRunner`
 * driving `test/fixtures/fake-claude.mjs` in one of the modes it already scripts, and copied out of the
 * attempt directory byte for byte. A hand-rolled fixture would agree with whatever the planner does today;
 * a recorded one is what a worker actually writes.
 *
 * Re-running this rewrites every file, so timestamps and session ids change. Review the diff: a change to
 * the *shape* of a recording is a change to what a surface has to render, and the property test in
 * `test/unit/incremental-planner.test.ts` asserts each fixture still has the shape it is named for.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner } from '../src/runners/claude/claude-runner.js';
import { ProcessManager } from '../src/execution/process-manager.js';
import type { RunnerHooks } from '../src/runners/task-runner.js';
import type { ResolvedTask, RunnerUsage } from 'code-agent-orchestrator-protocol';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test', 'fixtures', 'transcripts');
const fakeClaude = `node ${path.join(root, 'test', 'fixtures', 'fake-claude.mjs').replace(/\\/g, '/')}`;

/** One `runner.run()` into `attemptDir`, appending to whatever `events.jsonl` is already there. */
async function record(attemptDir: string, mode: string, resumeSessionId?: string): Promise<string | undefined> {
  let sessionId: string | undefined;
  const hooks: RunnerHooks = {
    onActivity: () => {},
    onOutput: () => {},
    onProcess: (info) => {
      sessionId = info.sessionId ?? sessionId;
    },
    onTranscript: () => {},
    onUsage: (usage: RunnerUsage) => {
      sessionId = usage.sessionId ?? sessionId;
    },
    onFileChange: () => {},
    onWarning: () => {},
    onInteraction: () => Promise.reject(new Error('the corpus records no interactive mode')),
  };
  const runner = new ClaudeRunner({ processManager: new ProcessManager(), defaults: { command: fakeClaude } });
  await runner.run(
    {
      runId: 'corpus',
      task: { id: 'record', claude: {} } as ResolvedTask,
      attempt: 1,
      prompt: 'record the corpus',
      cwd: path.dirname(attemptDir),
      env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_DELAY_MS: '15' },
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      attemptDir,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    },
    hooks,
  );
  return sessionId;
}

/** A fresh attempt directory, run through `modes` in order, and the `events.jsonl` that came out. */
async function attempt(modes: readonly string[], resumeAfterFirst = false): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-corpus-'));
  const attemptDir = path.join(dir, 'attempt');
  await fs.mkdir(attemptDir, { recursive: true });
  let sessionId: string | undefined;
  for (const [index, mode] of modes.entries()) {
    sessionId = (await record(attemptDir, mode, resumeAfterFirst && index > 0 ? sessionId : undefined)) ?? sessionId;
  }
  const log = await fs.readFile(path.join(attemptDir, 'events.jsonl'), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return log;
}

async function main(): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const write = async (name: string, text: string): Promise<void> => {
    await fs.writeFile(path.join(outDir, name), text, 'utf8');
    written.push(`${name} (${text.trim().split('\n').length} lines)`);
  };

  // A plain attempt: prose, one tool call, a result. The baseline every other fixture is a complication of.
  await write('success.jsonl', await attempt(['success']));
  // Subagent nesting: an `Agent:` call, the entries it spawned, and its report.
  await write('subagent.jsonl', await attempt(['subagent']));
  // Two subagents at once, one delegating again, and a call whose result never arrives.
  await write('subagents.jsonl', await attempt(['subagents']));
  // Thinking blocks around prose, plus a redacted block the runner drops.
  await write('thinking.jsonl', await attempt(['thinking']));
  // The process leaves with a tool call still open, and no result event to explain it (§6.3.1 `unanswered`).
  await write('open-tool-exit.jsonl', await attempt(['open-tool-exit']));
  // A session resumed inside one attempt (§8.6): two runs appending to the same file. The fake's tool ids
  // restart at t1, so the second run's ids collide with the first's — which is exactly what a surface has
  // to render, and what `reset()` exists to stop happening across an attempt boundary.
  await write('resumed-session.jsonl', await attempt(['subagent', 'subagent'], true));
  // A tail caught mid-write: the last line is half a JSON object, as a reader sees it between two flushes.
  const whole = await attempt(['subagent']);
  const lines = whole.trim().split('\n');
  await write('truncated.jsonl', `${lines.slice(0, -1).join('\n')}\n${lines[lines.length - 1]!.slice(0, 40)}`);

  process.stdout.write(`recorded into ${path.relative(root, outDir).replace(/\\/g, '/')}:\n  ${written.join('\n  ')}\n`);
}

await main();
