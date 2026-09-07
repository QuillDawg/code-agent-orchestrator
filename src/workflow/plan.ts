/** Execution plan rendering for --dry-run and the startup header. */
import type { ResolvedWorkflow } from '../types/workflow.js';
import { effectiveWorkspace } from './validator.js';
import { glyph } from '../util/glyphs.js';

export interface PlanOptions {
  verbose?: boolean;
}

export function renderExecutionPlan(workflow: ResolvedWorkflow, layers: string[][], opts: PlanOptions = {}): string {
  const byId = new Map(workflow.tasks.map((t) => [t.id, t]));
  const lines: string[] = [];
  const width = String(layers.length).length;
  layers.forEach((layer, i) => {
    const num = `${String(i + 1).padStart(width)}.`;
    const parallel = layer.length > 1;
    layer.forEach((id, j) => {
      const task = byId.get(id)!;
      let prefix: string;
      const bar = glyph('rule');
      if (!parallel) prefix = `${num} `;
      else if (j === 0) prefix = `${num} ${glyph('treeFirst')}${bar} `;
      else if (j === layer.length - 1) prefix = `${' '.repeat(num.length)} ${glyph('treeLast')}${bar} `;
      else prefix = `${' '.repeat(num.length)} ${glyph('treeMid')}${bar} `;
      const details: string[] = [];
      if (task.isApproval) details.push('approval gate');
      if (task.type !== 'task' && !task.isApproval) details.push(task.type);
      // A task the workflow file records as done will not start. The plan used to list it like any other,
      // so a run of an already-finished workflow reported three tasks "Completed" in no time at all.
      if (task.completed) details.push(`already done${task.completed.runId ? ` in run ${task.completed.runId}` : ''}, will not run`);
      if (opts.verbose) {
        const ws = effectiveWorkspace(task, workflow, parallel);
        details.push(ws);
        if (task.workingDirectoryRelative) details.push(`cwd ./${task.workingDirectoryRelative}`);
        if (task.implicitDeps.length) details.push(`after ${task.implicitDeps.join(', ')} (implicit)`);
        const explicit = task.dependsOn.filter((d) => !task.implicitDeps.includes(d));
        if (explicit.length) details.push(`dependsOn ${explicit.join(', ')}`);
        if (task.context?.sources.length) details.push(`context from ${task.context.sources.map((s) => s.taskId).join(', ')}`);
        if (task.when) details.push(`when ${'expr' in task.when ? task.when.expr : `${task.when.task} is ${task.when.status}`}`);
        if (task.retry.attempts) details.push(`retries ${task.retry.attempts}`);
      }
      lines.push(`${prefix}${id}${details.length ? `  (${details.join('; ')})` : ''}`);
    });
  });
  return lines.join('\n');
}
