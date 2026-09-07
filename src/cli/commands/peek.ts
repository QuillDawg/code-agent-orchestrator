import path from 'node:path';
import readline from 'node:readline';
import { openStore, readOrchestrator, resolveRunAndTask, currentAttempt, taskDuration, sectionRule } from '../util.js';
import { followFile, readTail } from '../../tui/follow.js';
import { eventLineRenderer, jsonEntryLines } from './logs.js';
import { warnLine } from '../../util/marks.js';
import { glyph } from '../../util/glyphs.js';
import { STATE_LABEL } from '../../workflow/states.js';
import { ACTIVE_TASK_STATES } from '../../types/run.js';
import { pathExists } from '../../util/fs.js';
import { agentLabel, formatCost, formatTokens } from '../../tui/format.js';
import { sanitizeText, type ColorMode } from '../color.js';

export interface PeekOptions {
  repository?: string;
  lines?: number;
  follow?: boolean;
  json?: boolean;
  color?: ColorMode;
}

/** Show what a worker is doing right now, from another terminal (reads live.json + attempt events). */
export async function peekCommand(refs: string[], opts: PeekOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveRunAndTask(store, refs, 'cao peek [run] <task>');
  const live = await store.readLive(run.runId);
  const st = run.tasks[taskId]!;
  const liveTask = live?.tasks[taskId];
  const attempt = currentAttempt(st);
  const orchestratorAlive = (await readOrchestrator(store, run.runId))?.alive ?? false;
  const state = liveTask?.state ?? st.state;
  const usage = liveTask?.usage ?? attempt?.usage;
  const def = run.workflow.tasks.find((t) => t.id === taskId);
  const pending = liveTask?.pendingInteraction ?? st.pendingInteraction;
  const filesChanged = liveTask?.filesChanged ?? (attempt?.files ? Object.keys(attempt.files).length : undefined);

  // --json is JSON Lines: this status object first, then the attempt's transcript entries, one per line.
  if (opts.json) {
    out(
      JSON.stringify({
        kind: 'peek',
        runId: run.runId,
        taskId,
        state,
        message: st.message,
        agent: def?.agent,
        model: usage?.model ?? def?.model,
        pid: liveTask?.pid ?? attempt?.pid,
        attempt: attempt?.number,
        elapsed: taskDuration(st),
        usage,
        filesChanged,
        workingDirectory: liveTask?.workingDirectory ?? attempt?.cwd,
        branch: liveTask?.branch ?? attempt?.workspace?.branch,
        pendingInteraction: pending,
        orchestratorAlive,
      }),
    );
  }

  if (!opts.json) {
    out(`Task: ${taskId}`);
    out(`Status: ${STATE_LABEL[state].toUpperCase()}${st.message ? `  (${sanitizeText(st.message).split('\n')[0]})` : ''}`);
    if (pending) out(`Needs you: ${pending.kind} ${glyph('dash')} ${sanitizeText(pending.title)}  (answer it in the dashboard of the running orchestrator)`);
    // As in `cao task`: a pid outlives its process, so it is labelled once the worker is gone.
    const pid = liveTask?.pid ?? attempt?.pid;
    const pidCell = pid === undefined ? '-' : `${pid}${ACTIVE_TASK_STATES.has(st.state) ? '' : ' (exited)'}`;
    out(`Agent: ${def ? agentLabel(def.agent, usage?.model ?? def.model) : '-'}   PID: ${pidCell}   Attempt: ${attempt?.number ?? '-'}   Elapsed: ${taskDuration(st)}`);
    if (usage) {
      const ctx = usage.contextTokens !== undefined ? `context ${formatTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ''}` : '';
      const cost = usage.costUsd !== undefined ? `cost ${formatCost(usage.costUsd)}` : '';
      const tokens = usage.inputTokens !== undefined ? `tokens in ${formatTokens(usage.inputTokens)} out ${formatTokens(usage.outputTokens ?? 0)}` : '';
      out(`Usage: ${[ctx, tokens, cost].filter(Boolean).join('   ')}`);
    }
    if (filesChanged) out(`Files changed: ${filesChanged}`);
    out(`Working Dir: ${liveTask?.workingDirectory ?? attempt?.cwd ?? '-'}`);
    if (liveTask?.branch ?? attempt?.workspace?.branch) out(`Branch: ${liveTask?.branch ?? attempt?.workspace?.branch}`);
    if (!orchestratorAlive && (ACTIVE_TASK_STATES.has(st.state) || run.state === 'running')) out(warnLine('The orchestrator process is not running (stale run); use cao resume to recover.'));
    out('');
    out(sectionRule('Worker output'));
  }
  if (!attempt) {
    if (!opts.json) out('(task has not started)');
    return 0;
  }
  const eventsFile = path.join(store.paths.attemptDir(run.runId, taskId, attempt.number), 'events.jsonl');
  const renderer = eventLineRenderer(opts.color);
  const print = (line: string): void => void (opts.json ? jsonEntryLines([line]) : renderer.line(line)).forEach(out);
  if (await pathExists(eventsFile)) {
    const tail = await readTail(eventsFile, opts.lines ?? 40);
    for (const l of opts.json ? jsonEntryLines(tail) : renderer.batch(tail)) out(l);
  } else if (!opts.json) {
    for (const l of liveTask?.lastLines ?? []) out(sanitizeText(l));
  }
  if (!opts.follow) return 0;
  const fresh = await store.loadRun(run.runId).catch(() => run);
  if (!ACTIVE_TASK_STATES.has(fresh.tasks[taskId]?.state ?? 'pending')) return 0;

  if (!opts.json) {
    out('');
    out('Following live output. Press q to return (the worker keeps running).');
  }
  const controller = new AbortController();
  const onKey = (_s: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) controller.abort();
  };
  const onSigint = (): void => controller.abort();
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
  }
  process.on('SIGINT', onSigint);
  await followFile(eventsFile, print, {
    signal: controller.signal,
    shouldStop: async () => {
      const now = await store.loadRun(run.runId).catch(() => run);
      // The lock file is not the only sign of life: following would otherwise end the moment something
      // removed it, mid-task, with no explanation on screen.
      const orchestrator = await readOrchestrator(store, run.runId);
      return !orchestrator?.alive || !ACTIVE_TASK_STATES.has(now.tasks[taskId]?.state ?? 'pending');
    },
  });
  process.off('SIGINT', onSigint);
  if (process.stdin.isTTY) {
    process.stdin.off('keypress', onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return 0;
}
