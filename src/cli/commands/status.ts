import { openStore, readOrchestrator, table, taskDuration, currentAttempt, headingRule } from '../util.js';
import { stateGlyph, STATE_LABEL, summarize } from '../../workflow/states.js';
import { formatDuration, formatWhen } from '../../util/duration.js';
import { ACTIVE_TASK_STATES } from '../../types/run.js';
import { addUsage } from '../../types/result.js';
import { agentLabel, formatCost, formatTokens } from '../../tui/format.js';
import { sanitizeText } from '../color.js';
import { runUsage } from '../render/plain.js';

export interface StatusOptions {
  repository?: string;
  json?: boolean;
}

export async function statusCommand(runRef: string | undefined, opts: StatusOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const runId = await store.resolveRunId(runRef);
  const run = await store.loadRun(runId);
  const live = await store.readLive(runId);
  const lock = await store.readLock(runId);
  const orchestrator = await readOrchestrator(store, runId);
  const orchestratorAlive = orchestrator?.alive ?? false;
  const summary = summarize(run);
  const usage = runUsage(run);
  if (opts.json) {
    out(JSON.stringify({ run: { ...run, workflow: undefined }, summary, usage, live, lock, orchestrator, orchestratorAlive }, null, 2));
    return 0;
  }
  const now = Date.now();
  const elapsed = run.startedAt ? formatDuration((run.endedAt ? new Date(run.endedAt).getTime() : now) - new Date(run.startedAt).getTime()) : '';
  out(run.workflowName);
  out(headingRule(60));
  out(`Run:          ${run.runId}`);
  out(`State:        ${run.state}${run.state === 'running' && !orchestratorAlive ? '  (orchestrator process not running: stale; resume to recover)' : ''}`);
  out(`Repository:   ${run.repositoryRoot}`);
  out(`Launch dir:   ${run.launchDirectory}`);
  out(`Directory:    ${store.paths.runDir(run.runId)}`);
  out(
    `Orchestrator: ${
      orchestrator
        ? `pid ${orchestrator.pid}  ${orchestratorAlive ? 'running' : `not running (stale ${orchestrator.source === 'lock' ? 'lock' : 'live status'})`}${orchestrator.source === 'live' ? '  (lock.json is missing)' : ''}`
        : 'not running'
    }`,
  );
  out(`Started:      ${run.startedAt ? formatWhen(run.startedAt, now) : '-'}   Elapsed: ${elapsed}`);
  out(`Progress:     ${summary.success + summary.skipped} / ${summary.total} completed`);
  if (usage.hasCost || usage.inputTokens) out(`Usage:        ${formatCost(usage.costUsd)}   ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`);
  out('');
  const rows = run.workflow.tasks.map((t) => {
    const st = run.tasks[t.id]!;
    const a = currentAttempt(st);
    const liveTask = live?.tasks[t.id];
    const state = liveTask?.state ?? st.state;
    const pending = liveTask?.pendingInteraction ?? st.pendingInteraction;
    const detail = sanitizeText(
      pending
        ? `waiting for your answer in the dashboard: ${pending.title}`
        : ACTIVE_TASK_STATES.has(state)
          ? `pid ${a?.pid ?? '-'}  ${liveTask?.lastActivity ?? st.lastActivity ?? ''}`
          : st.message
            ? st.message.split('\n')[0] ?? ''
            : st.result?.summary.split('\n')[0] ?? '',
    );
    const u = liveTask?.usage ?? addUsage(...st.attempts.map((x) => x.usage));
    const ctx = u.contextTokens !== undefined && ACTIVE_TASK_STATES.has(state) ? `${formatTokens(u.contextTokens)}${u.contextWindow ? `/${formatTokens(u.contextWindow)}` : ''}` : '';
    const cost = u.costUsd !== undefined ? formatCost(u.costUsd) : '';
    const files = liveTask?.filesChanged ?? (a?.files ? Object.keys(a.files).length : st.result?.filesChanged.length);
    return [`${stateGlyph(state)} ${t.id}`, STATE_LABEL[state], taskDuration(st, now), a ? `#${a.number}` : '', agentLabel(t.agent, u.model ?? t.model), ctx, cost, files ? String(files) : '', detail];
  });
  out(table(rows, { header: ['Task', 'Status', 'Duration', 'Attempt', 'Agent', 'Context', 'Cost', 'Files', 'Detail'], hideEmptyColumns: true }));
  out('');
  out(`Running: ${Object.values(run.tasks).filter((t) => ACTIVE_TASK_STATES.has(t.state)).length} / ${run.workflow.execution.maxConcurrency}   Completed: ${summary.success}   Failed: ${summary.failed}   Blocked: ${summary.blocked}   Skipped: ${summary.skipped}   Cancelled: ${summary.cancelled}`);
  return 0;
}
