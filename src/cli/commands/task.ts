import path from 'node:path';
import { openStore, resolveRunAndTask, currentAttempt, findCapturedDiff, taskDuration, headingRule } from '../util.js';
import { ACTIVE_TASK_STATES } from '../../types/run.js';
import { renderStat, summarizeDiff } from '../render/diff.js';
import { stateGlyph, STATE_LABEL } from '../../workflow/states.js';
import { formatDuration, formatWhen } from '../../util/duration.js';
import { addUsage } from '../../types/result.js';
import { formatCost, formatTokens } from '../../tui/format.js';
import { attemptRows, interactionRows, resultNotes, totalWaitedMs } from '../../tui/history.js';
import { sanitizeText, useColor } from '../color.js';
import { glyph } from '../../util/glyphs.js';

export interface TaskOptions {
  repository?: string;
  json?: boolean;
}

export async function taskCommand(refs: string[], opts: TaskOptions): Promise<number> {
  const out = (s: string): boolean => process.stdout.write(`${s}\n`);
  const store = await openStore(opts.repository);
  const { run, taskId } = await resolveRunAndTask(store, refs, 'cao task [run] <task>');
  const st = run.tasks[taskId]!;
  const def = run.workflow.tasks.find((t) => t.id === taskId)!;
  const live = await store.readLive(run.runId);
  if (opts.json) {
    // The records themselves are already inside `state`; these repeat them with the numbers the text output
    // derives: how long each attempt ran, why it exists, and how long each request kept the worker waiting.
    const attempts = attemptRows(st).map((row, i) => ({ ...st.attempts[i]!, durationMs: row.durationMs, reason: row.reason }));
    const interactions = interactionRows(st).map((row) => ({ attempt: row.attempt, ...row.record, waitedMs: row.waitedMs }));
    out(JSON.stringify({ task: def, state: st, live: live?.tasks[taskId], attempts, interactions }, null, 2));
    return 0;
  }
  const a = currentAttempt(st);
  out(`Task: ${taskId}${def.name !== taskId ? ` ${glyph('dash')} ${def.name}` : ''}`);
  out(headingRule(50));
  out(`Status:           ${STATE_LABEL[st.state]}${st.message ? `  (${st.message.split('\n')[0]})` : ''}`);
  const usage = live?.tasks[taskId]?.usage ?? addUsage(...st.attempts.map((x) => x.usage));
  const model = def.model ?? (usage.model ? `CLI default (${usage.model})` : 'CLI default');
  out(`Type:             ${def.type}   Agent: ${def.agent}   Model: ${model}   Effort: ${def.effort ?? 'CLI default'}`);
  if (def.agent === 'codex') out(`Permissions:      ${def.codex.permissionMode ?? 'auto'}${def.codex.sandbox ? `  sandbox ${def.codex.sandbox}` : ''}${def.codex.approvalPolicy ? `  approval ${def.codex.approvalPolicy}` : ''}`);
  out(`Attempt:          ${a ? `${a.number} / ${def.retry.attempts + 1}` : '-'}`);
  // The pid of a finished attempt belongs to whatever process the OS has since given that number to, so it
  // is shown as the worker's pid only while there is a worker.
  const pid = live?.tasks[taskId]?.pid ?? a?.pid;
  if (pid !== undefined) out(`PID:              ${pid}${ACTIVE_TASK_STATES.has(st.state) ? '' : ' (exited)'}`);
  out(`Started:          ${a ? formatWhen(a.startedAt) : '-'}`);
  out(`Elapsed:          ${taskDuration(st)}`);
  out('');
  out('Depends On:');
  for (const d of def.dependsOn) out(`  ${stateGlyph(run.tasks[d]?.state ?? 'pending')} ${d}${def.implicitDeps.includes(d) ? ' (implicit)' : ''}`);
  if (def.dependsOn.length === 0) out('  (none)');
  out('');
  out('Working Directory:');
  out(`  ${a?.cwd ?? def.workingDirectory}`);
  if (a?.workspace?.branch) {
    out('');
    out('Git Branch:');
    out(`  ${a.workspace.branch}${a.workspace.baseSha ? ` (base ${a.workspace.baseSha.slice(0, 10)})` : ''}${a.workspace.mergedSha ? `  merged as ${a.workspace.mergedSha.slice(0, 10)}` : ''}`);
  }
  if (st.pendingInteraction) {
    out('');
    out('Needs you:');
    out(`  ${st.pendingInteraction.kind}: ${sanitizeText(st.pendingInteraction.title)}  (since ${formatWhen(st.pendingInteraction.requestedAt)}; answer it in the dashboard)`);
  }
  if (st.lastActivity) {
    out('');
    out('Latest activity:');
    out(`  ${sanitizeText(st.lastActivity)}`);
  }
  if (usage.costUsd !== undefined || usage.inputTokens !== undefined) {
    out('');
    out('Usage:');
    if (usage.costUsd !== undefined) out(`  cost: ${formatCost(usage.costUsd)}`);
    if (usage.inputTokens !== undefined) {
      const cache = [usage.cacheReadTokens ? `${formatTokens(usage.cacheReadTokens)} cache read` : '', usage.cacheCreationTokens ? `${formatTokens(usage.cacheCreationTokens)} cache write` : ''].filter(Boolean);
      out(`  tokens: ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens ?? 0)} out${cache.length ? ` (${cache.join(', ')})` : ''}`);
    }
    if (usage.durationMs !== undefined) out(`  agent time: ${formatDuration(usage.durationMs)}`);
    if (usage.contextTokens !== undefined) out(`  context: ${formatTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)}` : ''}${usage.compactions ? `  (${usage.compactions} compaction${usage.compactions === 1 ? '' : 's'})` : ''}`);
    if (usage.numTurns !== undefined) out(`  turns: ${usage.numTurns}`);
  }
  // While the task runs, the live tool-stream list is all there is; once an attempt has finished, its
  // captured diff is both complete (it sees shell edits too) and quantified, so it replaces the list.
  const captured = ACTIVE_TASK_STATES.has(st.state) ? null : await findCapturedDiff(store, run, taskId);
  if (captured) {
    const color = useColor();
    out('');
    out(`Changes (attempt ${captured.attempt}${captured.kind === 'merge' ? ', merge resolution' : ''}):`);
    for (const line of renderStat(captured.diff.files, color, true)) out(`  ${line}`);
    out(`  ${summarizeDiff(captured.diff.files)}${captured.diff.truncated ? '  (patch truncated at git.maxDiffBytes)' : ''}`);
  } else {
    const files = new Map<string, { ops: number; lastOp: string }>();
    for (const at of st.attempts) for (const [p, f] of Object.entries(at.files ?? {})) files.set(p, { ops: (files.get(p)?.ops ?? 0) + f.ops, lastOp: f.lastOp });
    if (files.size) {
      out('');
      out(`Files touched (${files.size}):`);
      for (const [p, f] of [...files.entries()].sort(([x], [y]) => x.localeCompare(y))) out(`  ${f.lastOp === 'write' ? 'W' : f.lastOp === 'delete' ? 'D' : 'M'} ${sanitizeText(p)}${f.ops > 1 ? `  x${f.ops}` : ''}`);
    }
  }
  const rows = attemptRows(st);
  if (rows.length) {
    out('');
    out('Attempts:');
    for (const row of rows) {
      out(`  ${row.line}`);
      for (const note of row.notes) out(`      ${glyph('subArrow')} ${note}`);
    }
  }
  const interactions = interactionRows(st);
  if (interactions.length) {
    out('');
    out('Interactions:');
    for (const i of interactions) out(`  ${i.line}`);
    out(`  waited ${formatDuration(totalWaitedMs(interactions))} in total across ${interactions.length} request${interactions.length === 1 ? '' : 's'}`);
  }
  if (def.context?.sources.length) {
    out('');
    out('Context Sources:');
    for (const s of def.context.sources) out(`  ${s.taskId}  [${s.include.join(', ')}]`);
  }
  if (st.result) {
    out('');
    out('Result:');
    out(`  status: ${st.result.status}`);
    out(`  summary: ${sanitizeText(st.result.summary)}`);
    if (st.result.filesChanged.length) out(`  filesChanged: ${st.result.filesChanged.map((f) => sanitizeText(f)).join(', ')}`);
    for (const group of resultNotes(st.result)) {
      out(`  ${group.label}:`);
      for (const item of group.items) out(`    - ${sanitizeText(item)}`);
    }
    if (st.result.usage?.costUsd !== undefined) out(`  cost: $${st.result.usage.costUsd.toFixed(4)}  turns: ${st.result.usage.numTurns ?? '-'}`);
  }
  out('');
  out('Logs:');
  if (a) {
    const dir = store.paths.attemptDir(run.runId, taskId, a.number);
    // path.join, not string concatenation: on Windows the run directory is already backslash-separated and
    // a `/` appended to it produces a path no one can paste back into a shell.
    for (const name of ['stdout.log', 'stderr.log', 'events.jsonl', 'prompt.md']) out(`  ${path.join(dir, name)}`);
    if (captured) out(`  ${store.paths.diffPatchFile(run.runId, taskId, captured.attempt)}   (cao diff ${run.runId} ${taskId})`);
  } else out('  (none yet)');
  return 0;
}
