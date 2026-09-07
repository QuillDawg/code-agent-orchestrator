/**
 * Builds the "# Previous Task Context" markdown that is prepended to a task prompt from the
 * structured results of explicitly selected upstream tasks. Never concatenates conversations.
 */
import type { ResolvedTask } from '../types/workflow.js';
import type { TaskRunState, TaskAttempt } from '../types/run.js';
import type { ContextField, EnrichedTaskResult } from '../types/result.js';
import { formatDiffStat } from '../workspace/diff.js';

export interface ContextBuildInput {
  task: ResolvedTask;
  tasks: Record<string, TaskRunState>;
  taskDefs: Map<string, ResolvedTask>;
  /** Previous failed attempt (retry with includePreviousFailure). */
  previousAttempt?: TaskAttempt;
  previousOutputTail?: string[];
  userInput?: string;
}

export interface ContextBuildOutput {
  markdown: string;
  sources: string[];
  truncated: boolean;
  warnings: string[];
}

const TRUNCATION_ORDER: ContextField[] = ['data', 'followUp', 'warnings', 'decisions', 'commits', 'filesChanged', 'git', 'error', 'summary'];

function list(items: string[] | undefined, max = 200): string {
  if (!items || items.length === 0) return '';
  const shown = items.slice(0, max).map((i) => `- ${i}`);
  if (items.length > max) shown.push(`- … and ${items.length - max} more`);
  return shown.join('\n');
}

function renderSource(id: string, def: ResolvedTask | undefined, state: TaskRunState, fields: Set<ContextField>): string {
  const result = state.result;
  const title = def?.name && def.name !== id ? `${id} — ${def.name}` : id;
  const status = result?.status ?? state.state;
  const lines: string[] = [`## ${title} (status: ${status})`];
  if (!result) {
    lines.push(`_No structured result available (task state: ${state.state}${state.message ? `, ${state.message}` : ''})._`);
    return lines.join('\n');
  }
  const section = (label: string, body: string): void => {
    if (body.trim()) lines.push(`**${label}:**\n${body}`);
  };
  if (fields.has('summary')) section('Summary', result.summary);
  if (fields.has('error') && result.error) section('Error', result.error);
  if (fields.has('filesChanged')) section('Files changed', list(result.filesChanged));
  if (fields.has('commits')) section('Commits', list(result.commits));
  if (fields.has('decisions')) section('Decisions', list(result.decisions));
  if (fields.has('warnings')) section('Warnings', list(result.warnings));
  if (fields.has('followUp')) section('Recommended follow-up', list(result.followUp));
  if (fields.has('git') && result.git) {
    const g = result.git;
    const parts: string[] = [];
    if (g.branch) parts.push(`branch \`${g.branch}\``);
    if (g.headSha) parts.push(`@ ${g.headSha.slice(0, 10)}`);
    if (g.baseSha) parts.push(`(base ${g.baseSha.slice(0, 10)})`);
    if (parts.length) section('Git', parts.join(' '));
    // The captured per-file stat is exact and covers shared-tree tasks too; diffStat is the worktree fallback.
    if (g.files?.length) {
      const shown = g.files.slice(0, 50);
      const more = g.files.length - shown.length;
      section('Diff summary', `\`\`\`\n${formatDiffStat(shown)}${more > 0 ? `\n… ${more} more file(s)` : ''}\n\`\`\``);
    } else if (g.diffStat) section('Diff summary', `\`\`\`\n${g.diffStat}\n\`\`\``);
    if (g.uncommittedFiles.length) section('Uncommitted files', list(g.uncommittedFiles, 50));
  }
  if (fields.has('data') && result.data && Object.keys(result.data).length) {
    section('Data', `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``);
  }
  return lines.join('\n\n');
}

export class ContextBuilder {
  build(input: ContextBuildInput): ContextBuildOutput {
    const { task, tasks, taskDefs } = input;
    const warnings: string[] = [];
    const sources: string[] = [];
    const blocks: string[] = [];
    let truncated = false;

    if (task.context && task.context.sources.length > 0) {
      const fieldSets = new Map<string, Set<ContextField>>();
      for (const src of task.context.sources) fieldSets.set(src.taskId, new Set(src.include));
      const ordered = [...fieldSets.keys()].sort((a, b) => (taskDefs.get(a)?.docIndex ?? 0) - (taskDefs.get(b)?.docIndex ?? 0));

      const rendered: Array<{ id: string; fields: Set<ContextField>; state: TaskRunState; text: string }> = [];
      for (const id of ordered) {
        const state = tasks[id];
        if (!state) {
          warnings.push(`context source "${id}" has no run state`);
          continue;
        }
        const ok = state.state === 'success' || (state.state === 'skipped' && state.result);
        if (!ok && !task.context.includeFailed) {
          warnings.push(`context source "${id}" is ${state.state}; skipped (set context.includeFailed: true to include it)`);
          continue;
        }
        const fields = fieldSets.get(id)!;
        rendered.push({ id, fields, state, text: renderSource(id, taskDefs.get(id), state, fields) });
        sources.push(id);
      }

      // Fit within maxChars by progressively dropping the least important fields of the largest sources.
      const max = task.context.maxChars;
      let total = rendered.reduce((n, r) => n + r.text.length, 0);
      let pass = 0;
      while (total > max && pass < TRUNCATION_ORDER.length) {
        const field = TRUNCATION_ORDER[pass++]!;
        for (const r of [...rendered].sort((a, b) => b.text.length - a.text.length)) {
          if (!r.fields.has(field) || (field === 'summary' && r.fields.size === 1)) continue;
          r.fields.delete(field);
          r.text = renderSource(r.id, taskDefs.get(r.id), r.state, r.fields);
          truncated = true;
          total = rendered.reduce((n, x) => n + x.text.length, 0);
          if (total <= max) break;
        }
      }
      if (total > max) {
        for (const r of rendered) {
          if (r.text.length > max / rendered.length) {
            r.text = `${r.text.slice(0, Math.floor(max / rendered.length))}\n\n_[context truncated]_`;
            truncated = true;
          }
        }
      }
      if (rendered.length) blocks.push(['# Previous Task Context', ...rendered.map((r) => r.text)].join('\n\n'));
    }

    if (input.previousAttempt && task.retry.includePreviousFailure) {
      const a = input.previousAttempt;
      const lines = [`# Previous Attempt`, `Attempt ${a.number} of this task failed (outcome: ${a.outcome ?? 'unknown'}).`];
      if (a.result?.summary) lines.push(`Summary: ${a.result.summary}`);
      if (a.result?.error) lines.push(`Error: ${a.result.error}`);
      if (a.error) lines.push(`Failure detail: ${a.error}`);
      if (a.result?.warnings?.length) lines.push(`Warnings:\n${list(a.result.warnings)}`);
      if (input.previousOutputTail?.length) {
        lines.push(`Last output lines:\n\`\`\`\n${input.previousOutputTail.join('\n')}\n\`\`\``);
      }
      lines.push('Please retry the original task and address the previous failure.');
      blocks.push(lines.join('\n\n'));
    }

    if (input.userInput) blocks.push(`# User Input\n\n${input.userInput}`);

    if (truncated) warnings.push('context was truncated to fit context.maxChars');
    return { markdown: blocks.join('\n\n'), sources, truncated, warnings };
  }

  /** Compose the final prompt: context (if any) + separator + task prompt. */
  static compose(contextMarkdown: string, prompt: string): string {
    if (!contextMarkdown.trim()) return prompt;
    return `${contextMarkdown.trim()}\n\n---\n\n# Task\n\n${prompt.trim()}\n`;
  }
}

export type { EnrichedTaskResult };
