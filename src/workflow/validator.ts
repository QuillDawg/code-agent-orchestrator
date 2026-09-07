/** Semantic validation of a ResolvedWorkflow. Never lets a broken workflow reach a Claude session. */
import type { ResolvedWorkflow, ResolvedTask } from '../types/workflow.js';
import type { Diagnostic } from '../config/normalize.js';
import { TaskGraph } from './graph.js';
import { compileWhen } from '../conditions/evaluator.js';
import { ConfigError } from '../util/errors.js';
import { errorLine, warnLine } from '../util/marks.js';

export interface ValidationOptions {
  knownRunners?: string[];
  /** Whether the repository is inside a git repo (worktrees need it). */
  gitAvailable?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  graph?: TaskGraph;
  layers?: string[][];
}

export function buildGraph(workflow: ResolvedWorkflow): TaskGraph {
  return new TaskGraph(workflow.tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn, docIndex: t.docIndex })));
}

export function validateWorkflow(
  workflow: ResolvedWorkflow,
  previous: Diagnostic[] = [],
  opts: ValidationOptions = {},
): ValidationResult {
  const diagnostics: Diagnostic[] = [...previous];
  const error = (message: string, taskId?: string): void => {
    diagnostics.push({ level: 'error', message, taskId });
  };
  const warn = (message: string, taskId?: string): void => {
    diagnostics.push({ level: 'warning', message, taskId });
  };

  const ids = new Set<string>();
  for (const t of workflow.tasks) {
    if (ids.has(t.id)) error(`Task id "${t.id}" is duplicated`, t.id);
    ids.add(t.id);
  }
  if (workflow.tasks.length === 0) error('Workflow defines no tasks');

  for (const t of workflow.tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) error(`Task "${t.id}": unknown dependency "${d}"`, t.id);
    }
    if (opts.knownRunners && !opts.knownRunners.includes(t.runner)) {
      error(`Task "${t.id}": unknown runner "${t.runner}" (available: ${opts.knownRunners.join(', ')})`, t.id);
    }
    if (t.retry.attempts > 0 && t.isApproval) warn(`Task "${t.id}": retries are ignored for approval gates`, t.id);
    if (t.agent === 'claude' && t.claude.permissionMode === 'manual') {
      warn(t.claude.permissionPrompts === 'deny' ? `Task "${t.id}": permissionMode "manual" with permissionPrompts "deny" denies every permission prompt` : `Task "${t.id}": permissionMode "manual" prompts for every tool; prompts are answered in the dashboard and denied without one (--no-tui, CI)`, t.id);
    }
    if (t.agent === 'claude' && t.claude.permissionMode === 'bypassPermissions' && t.claude.permissionPrompts === 'ask') {
      warn(`Task "${t.id}": permissionPrompts "ask" has no effect with permissionMode "bypassPermissions"`, t.id);
    }
    if (t.agent === 'claude' && (t.effort === 'none' || t.effort === 'minimal')) {
      warn(`Task "${t.id}": effort "${t.effort}" is Codex-only; Claude accepts low, medium, high, xhigh or max, so it will be ignored`, t.id);
    }
  }

  if (workflow.execution.maxConcurrency < 1) error('execution.maxConcurrency must be >= 1');

  let graph: TaskGraph | undefined;
  let layers: string[][] | undefined;
  if (diagnostics.every((d) => d.level !== 'error' || !d.message.includes('unknown dependency'))) {
    graph = buildGraph(workflow);
    const cycle = graph.findCycle();
    if (cycle) error(`Circular dependency detected: ${cycle.join(' -> ')}`);
    else layers = graph.layers();
  }

  if (graph && layers) {
    const byId = new Map(workflow.tasks.map((t) => [t.id, t]));
    for (const t of workflow.tasks) {
      const ancestors = graph.ancestors(t.id);
      if (t.when) {
        try {
          const { refs } = compileWhen(t.when);
          for (const ref of refs) {
            if (!ids.has(ref)) error(`Task "${t.id}": when refers to unknown task "${ref}"`, t.id);
            else if (!ancestors.has(ref)) {
              error(`Task "${t.id}": when refers to "${ref}" which is not a (transitive) dependency, so its result is not guaranteed`, t.id);
            }
          }
        } catch (err) {
          error(`Task "${t.id}": invalid when expression: ${(err as Error).message}`, t.id);
        }
      }
      if (t.context) {
        for (const src of t.context.sources) {
          if (!ancestors.has(src.taskId)) {
            error(`Task "${t.id}": context source "${src.taskId}" is not a (transitive) dependency; add it to dependsOn`, t.id);
          }
        }
      }
      if (t.isApproval && t.runner !== 'claude') warn(`Task "${t.id}": approval gates do not use a runner`, t.id);
    }

    // Concurrency safety: two tasks that may run simultaneously must not share a mutable working tree.
    const parallelIsShared = workflow.execution.workspaceStrategy.parallel === 'shared';
    if (workflow.execution.maxConcurrency > 1 || parallelIsShared) {
      for (const layer of layers) {
        if (layer.length < 2) continue;
        const sharedTasks = layer.filter((id) => {
          const t = byId.get(id)!;
          return effectiveWorkspace(t, workflow, true) === 'shared' && !t.isApproval;
        });
        if (sharedTasks.length > 1 && workflow.execution.maxConcurrency > 1 && !workflow.execution.allowUnsafeSharedParallel) {
          const wd = new Map<string, string[]>();
          for (const id of sharedTasks) {
            const t = byId.get(id)!;
            wd.set(t.workingDirectory, [...(wd.get(t.workingDirectory) ?? []), id]);
          }
          for (const [dir, group] of wd) {
            if (group.length > 1) {
              error(
                `Tasks ${group.map((g) => `"${g}"`).join(', ')} may run concurrently in the same working tree (${dir}). ` +
                  'Use workspaceStrategy.parallel: worktree, or set execution.allowUnsafeSharedParallel: true.',
              );
            }
          }
        }
      }
    }
    if (workflow.execution.maxConcurrency === 1 && layers.some((l) => l.length > 1)) {
      warn('The graph allows parallel execution but execution.maxConcurrency is 1; tasks will run one at a time');
    }
    const needsWorktree = workflow.tasks.some((t) => effectiveWorkspace(t, workflow, true) === 'worktree');
    if (needsWorktree && opts.gitAvailable === false) {
      error('Worktree isolation requires the repository to be a git repository (git rev-parse failed)');
    }
    if (needsWorktree && !workflow.git.enabled) error('Worktree isolation requires git.enabled: true');
  }

  return { ok: diagnostics.every((d) => d.level !== 'error'), diagnostics, graph, layers };
}

/** Which workspace a task would use if it ran concurrently (`parallel` = true) or alone. */
export function effectiveWorkspace(task: ResolvedTask, workflow: ResolvedWorkflow, parallel: boolean): 'shared' | 'worktree' {
  if (task.workspace !== 'auto') return task.workspace;
  if (!workflow.git.enabled) return 'shared';
  return parallel ? workflow.execution.workspaceStrategy.parallel : workflow.execution.workspaceStrategy.sequential;
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics.map((d) => (d.level === 'error' ? errorLine(d.message) : warnLine(d.message))).join('\n');
}

export function assertValid(result: ValidationResult): void {
  if (!result.ok) {
    throw new ConfigError(`Workflow validation failed:\n${formatDiagnostics(result.diagnostics.filter((d) => d.level === 'error'))}`);
  }
}
