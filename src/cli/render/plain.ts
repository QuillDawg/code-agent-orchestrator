/** Line-based renderer for non-TTY environments and --no-tui. One line per meaningful transition. */
import type { EventBus } from '../../events/event-bus.js';
import type { WorkflowRun } from '../../types/run.js';
import type { ResolvedWorkflow } from '../../types/workflow.js';
import { addUsage } from '../../types/result.js';
import { formatDuration } from '../../util/duration.js';
import { stateGlyph, STATE_COLOR, STATE_LABEL, summarize } from '../../workflow/states.js';
import { renderExecutionPlan } from '../../workflow/plan.js';
import { renderTranscript } from '../../tui/transcript.js';
import { paint, sanitizeText, useColor } from '../color.js';
import { glyph, rule } from '../../util/glyphs.js';
import { displayWidth, headingRule, table } from '../util.js';
import { formatCost, formatTokens } from '../../tui/format.js';

/** First line of agent-controlled text, safe to hand to a terminal. */
function firstLine(text: string): string {
  return sanitizeText(text).split('\n')[0] ?? '';
}

export interface PlainRendererOptions {
  verbose?: boolean;
  write?: (line: string) => void;
  showActivity?: boolean;
  color?: boolean;
}

export function attachPlainRenderer(bus: EventBus, run: WorkflowRun, opts: PlainRendererOptions = {}): () => void {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const color = opts.color ?? useColor();
  const started = new Map<string, number>();
  const lastActivity = new Map<string, string>();
  const elapsed = (taskId: string): string => {
    const s = started.get(taskId);
    return s ? formatDuration(Date.now() - s) : '';
  };
  const stamp = (): string => paint(new Date().toTimeString().slice(0, 8), 'dim', color);
  const id = (taskId: string): string => paint(taskId, 'bold', color);
  return bus.onAny((ev) => {
    switch (ev.type) {
      case 'workflow.started':
        write(`${stamp()} ${stateGlyph('running')} workflow "${ev.workflowName}" started (${ev.taskCount} tasks)`);
        break;
      case 'workflow.resumed':
        write(`${stamp()} ${stateGlyph('running')} workflow resumed (#${ev.resumeCount})${ev.rerun.length ? `; re-running: ${ev.rerun.join(', ')}` : ''}`);
        break;
      case 'task.started':
        started.set(ev.taskId, Date.now());
        write(`${stamp()} ${paint(stateGlyph('running'), 'cyan', color)} ${id(ev.taskId)}  attempt ${ev.attempt}  cwd ${ev.cwd}${ev.workspace?.branch ? `  branch ${ev.workspace.branch}` : ''}`);
        break;
      case 'task.process':
        if (opts.verbose) write(`${stamp()}   ${ev.taskId}  pid ${ev.pid}`);
        break;
      case 'task.activity':
        if ((opts.showActivity || opts.verbose) && lastActivity.get(ev.taskId) !== ev.line) {
          lastActivity.set(ev.taskId, ev.line);
          write(`${stamp()}   ${ev.taskId}  ${paint(firstLine(ev.line), 'dim', color)}`);
        }
        break;
      case 'task.transcript':
        if (opts.verbose && ev.entry.kind === 'text') for (const l of renderTranscript([ev.entry], { color, width: 0 })) write(`${stamp()}   ${ev.taskId}  ${l}`);
        break;
      case 'task.completed': {
        const cost = ev.result && 'usage' in ev.result && (ev.result as { usage?: { costUsd?: number } }).usage?.costUsd !== undefined ? `  ${formatCost((ev.result as { usage?: { costUsd?: number } }).usage!.costUsd!)}` : '';
        write(`${stamp()} ${paint(stateGlyph('success'), 'green', color)} ${id(ev.taskId)}  completed  ${elapsed(ev.taskId)}${cost}  ${firstLine(ev.result.summary)}`);
        break;
      }
      case 'task.failed':
        write(`${stamp()} ${paint(stateGlyph('failed'), 'red', color)} ${id(ev.taskId)}  ${ev.final ? 'failed' : 'attempt failed'} (${ev.reason})  ${elapsed(ev.taskId)}${ev.message ? `  ${firstLine(ev.message)}` : ''}`);
        break;
      case 'task.retrying':
        write(
          `${stamp()} ${glyph('retry')} ${ev.taskId}  ${ev.nudge ? 'no completion object; asking the session for it' : `${ev.transient ? 'transient API error; ' : ''}${ev.resumeSession ? 'resuming session' : 'retrying'}`} (attempt ${ev.nextAttempt}${ev.delayMs ? ` in ${formatDuration(ev.delayMs)}` : ''})`,
        );
        break;
      case 'task.skipped':
        write(`${stamp()} ${stateGlyph('skipped')} ${ev.taskId}  skipped (${ev.reason})${ev.message ? `: ${firstLine(ev.message)}` : ''}`);
        break;
      case 'task.blocked':
        write(`${stamp()} ${paint(stateGlyph('blocked'), 'red', color)} ${id(ev.taskId)}  blocked${ev.by ? ` by ${ev.by}` : ''}${ev.message ? `: ${firstLine(ev.message)}` : ''}`);
        break;
      case 'task.cancelled':
        write(`${stamp()} ${paint(stateGlyph('cancelled'), 'magenta', color)} ${ev.taskId}  cancelled (${ev.reason})`);
        break;
      case 'task.awaiting_approval':
        write(`${stamp()} ${paint(`${stateGlyph('awaiting_approval')} ${ev.taskId}  approval required: ${ev.prompt.split('\n')[0]}`, 'yellow', color)}`);
        break;
      case 'task.needs_input':
        write(`${stamp()} ${paint(`${stateGlyph('needs_input')} ${ev.taskId}  needs input: ${firstLine(ev.summary)}`, 'yellow', color)}`);
        break;
      case 'task.interaction.requested':
        write(`${stamp()} ${paint(`? ${ev.taskId}  needs you (${ev.interaction.kind}): ${firstLine(ev.interaction.title)}`, ['yellow', 'bold'], color)}`);
        break;
      case 'task.interaction.answered': {
        const text = ev.answer.kind === 'deny' ? `denied: ${ev.answer.message}` : ev.answer.kind === 'allow' ? `allowed${ev.answer.scope === 'always' ? ' (always)' : ''}` : `answered: ${Object.values(ev.answer.answers).join(' / ')}`;
        write(`${stamp()}   ${ev.taskId}  ${paint(firstLine(text), ev.answer.kind === 'deny' ? 'red' : 'green', color)} (${ev.source})`);
        break;
      }
      case 'task.merging':
        write(`${stamp()} ${glyph('merge')} ${ev.taskId}  merge conflict on ${ev.branch}; starting agent merge-resolution session`);
        break;
      case 'task.merged':
        write(`${stamp()} ${glyph('merge')} ${ev.taskId}  merged ${ev.branch} into ${ev.into} (${ev.sha.slice(0, 10)})`);
        break;
      case 'workflow.warning':
        write(`${stamp()} ${paint('!', 'yellow', color)} ${ev.taskId ? `${ev.taskId}: ` : ''}${ev.message}`);
        break;
      case 'workflow.paused':
        write(`${stamp()} ${paint(`${glyph('pause')} workflow paused (${ev.reason}): ${ev.taskIds.join(', ')}`, 'yellow', color)}`);
        break;
      case 'hook.started':
        if (opts.verbose) write(`${stamp()} ${glyph('hook')} hook ${ev.hook}: ${ev.command}`);
        break;
      case 'hook.finished':
        if (opts.verbose || ev.exitCode !== 0) write(`${stamp()} ${glyph('hook')} hook ${ev.hook} exited ${ev.exitCode}`);
        break;
      case 'workflow.completed':
      case 'workflow.failed':
      case 'workflow.interrupted':
        write('');
        write(renderSummary(run, { color }));
        break;
      default:
        break;
    }
  });
}

/** Total usage across every attempt of the run. */
export function runUsage(run: WorkflowRun): { costUsd: number; inputTokens: number; outputTokens: number; hasCost: boolean } {
  const total = addUsage(...Object.values(run.tasks).flatMap((t) => t.attempts.map((a) => a.usage)));
  return { costUsd: total.costUsd ?? 0, inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0, hasCost: total.costUsd !== undefined };
}

export function renderSummary(run: WorkflowRun, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? useColor();
  const s = summarize(run);
  const lines: string[] = [];
  const total = run.startedAt ? formatDuration(new Date(run.endedAt ?? new Date().toISOString()).getTime() - new Date(run.startedAt).getTime()) : '';
  // The same column machinery `cao status` uses, so a long task id or a long failure message is clamped to
  // the terminal here too rather than wrapping the last table a run prints into fragments.
  const rows = run.workflow.tasks.flatMap((t) => {
    const st = run.tasks[t.id];
    if (!st) return [];
    const dur = st.startedAt && st.endedAt ? formatDuration(new Date(st.endedAt).getTime() - new Date(st.startedAt).getTime()) : '';
    const usage = addUsage(...st.attempts.map((a) => a.usage));
    const cost = usage.costUsd !== undefined ? formatCost(usage.costUsd) : '';
    const note = st.state === 'success' ? '' : st.message ? firstLine(st.message) : '';
    // STATE_LABEL, not the raw state name, so the last table of a run says "Completed" like `cao status` does.
    return [[`${paint(stateGlyph(st.state), STATE_COLOR[st.state], color)} ${t.id}`, STATE_LABEL[st.state], dur, cost, note]];
  });
  const body = table(rows, { hideEmptyColumns: true });
  const width = Math.max(20, ...body.split('\n').map(displayWidth));
  lines.push(paint(`Workflow ${run.state.toUpperCase()}  ${total}`, 'bold', color));
  lines.push(rule(width));
  if (body) lines.push(body);
  lines.push(rule(width));
  lines.push(`Completed: ${s.success}  Failed: ${s.failed}  Blocked: ${s.blocked}  Skipped: ${s.skipped}  Cancelled: ${s.cancelled}  Pending: ${s.pending}`);
  const usage = runUsage(run);
  if (usage.hasCost || usage.inputTokens) lines.push(`Cost: ${formatCost(usage.costUsd)}  Tokens: ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`);
  lines.push(`Run: ${run.runId}  ${glyph('arrow')}  .orchestrator/runs/${run.runId}`);
  if (run.reportPath) lines.push(`Report: ${run.reportPath}`);
  return lines.join('\n');
}

export interface DetectedRunner {
  runner: string;
  version?: string;
  command: string;
  found: boolean;
  error?: string;
}

/**
 * The `Agents:` line, in the one shape `cao run`, `cao resume` and `cao validate` all print: which CLI, what
 * it reported as its version, and the command it was found under, because that last part is what a user
 * changes when the wrong binary is picked up.
 */
export function formatAgents(runners: DetectedRunner[] | undefined, fallback?: { version?: string; command?: string }): string {
  if (fallback?.version && !runners?.length) return `claude ${fallback.version} (${fallback.command ?? 'claude'})`;
  // An empty list means detection ran and found nothing to launch — every task is already recorded as done.
  if (runners?.length === 0) return 'none to launch (every task is already completed)';
  if (!runners?.length) return 'not detected';
  return runners.map((r) => (r.found ? `${r.runner} ${r.version ?? '(version unknown)'} (${r.command})` : `${r.runner} NOT FOUND (${r.command})${r.error ? `: ${r.error}` : ''}`)).join('  ');
}

export interface HeaderInfo {
  workflow: ResolvedWorkflow;
  runId: string;
  runners?: DetectedRunner[];
  claudeVersion?: string;
  claudeCommand?: string;
  layers: string[][];
  resumed?: boolean;
  verbose?: boolean;
}

export function renderHeader(info: HeaderInfo): string {
  const { workflow } = info;
  const ws = workflow.execution.workspaceStrategy;
  const lines = [
    'Code Agent Orchestrator',
    headingRule(52),
    '',
    `Workflow:       ${workflow.name}`,
    `Run:            ${info.runId}${info.resumed ? ' (resumed)' : ''}`,
    `Repository:     ${workflow.repositoryRoot}`,
    `Launch dir:     ${workflow.launchDirectory}`,
    `Config:         ${workflow.configPath}`,
    `Agents:         ${formatAgents(info.runners, { version: info.claudeVersion, command: info.claudeCommand })}`,
    `Concurrency:    ${workflow.execution.maxConcurrency}`,
    `Workspace:      ${ws.sequential} / ${ws.parallel}${workflow.gitRoot ? '' : ' (no git repository: shared only)'}`,
    '',
    'Execution Plan',
    '',
    renderExecutionPlan(workflow, info.layers, { verbose: info.verbose }),
    '',
  ];
  return lines.join('\n');
}
