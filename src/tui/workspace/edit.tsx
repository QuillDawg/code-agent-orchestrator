/**
 * The task editor (spec §3.4): the form the Session panel opens over a task that has not finished.
 *
 * One row per editable field with the value the task has now, the validator's answer inline under whichever
 * row caused it, and the automatic context section read-only beneath the prompt `[D19]` — because the thing
 * an operator most needs to know before rewriting a prompt is what is already being prepended to it.
 *
 * Nothing here changes a run. The form produces a `TaskEdit`, the shell submits it to the run controller,
 * and the controller's answer is what the operator is shown: the validation done here is the same code the
 * controller runs (`src/workflow/control/edit.ts`), so the form can say "that model has no effort levels"
 * without a round trip, and it is still the controller that decides.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { ResolvedTask, ResolvedWorkflow, TaskEdit, TaskEditField, TaskRunState } from 'code-agent-orchestrator-protocol';
import { ContextBuilder } from '../../context/context-builder.js';
import { planEdit, validateEditedTask } from '../../workflow/control/edit.js';
import { EDIT_FIELD_LABEL } from '../history.js';
import { sanitizeText } from '../../cli/color.js';
import { truncateVisible } from '../../cli/util.js';
import { glyph } from '../../util/glyphs.js';
import type { Theme } from '../theme.js';
import { wrapPlain } from './detail.js';
import { windowOf } from '../window.js';

/** The fields the form offers, top to bottom; `TASK_EDIT_FIELDS` order with the prompt first. */
export const EDIT_ROWS: readonly TaskEditField[] = ['prompt', 'agent', 'model', 'effort', 'timeout', 'retries', 'maxBudgetUsd'];

/** The Save row sits one past the last field, so one cursor walks the whole form. */
export const SAVE_ROW = EDIT_ROWS.length;

/** Half-typed field values live in the store's `drafts`, so a re-render under the form keeps them. */
export const editDraftKey = (field: TaskEditField): string => `edit:${field}`;

/** The list cursor the form walks; named once so the shell and the form cannot disagree. */
export const EDIT_CURSOR = 'edit';

/**
 * A timeout as something `parseDuration` reads back: `90m`, `1h`, `45s`.
 *
 * The form's fields round-trip — what is shown is what an unedited Save would send — so a timeout has to be
 * rendered in the grammar the same form accepts, not as `5400000` or as `01h 30m 00s`.
 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** What the task holds for a field right now, as the text the form starts from. */
export function currentValue(task: ResolvedTask, field: TaskEditField): string {
  switch (field) {
    case 'prompt':
      return task.prompt;
    case 'agent':
      return task.agent;
    case 'model':
      return task.model ?? '';
    case 'effort':
      return task.effort ?? '';
    case 'timeout':
      return durationText(task.timeoutMs);
    case 'retries':
      return String(task.retry.attempts);
    case 'maxBudgetUsd':
      return task.claude.maxBudgetUsd === undefined ? '' : String(task.claude.maxBudgetUsd);
  }
}

/** Every field of the task as the form's starting drafts. */
export function initialDrafts(task: ResolvedTask): Record<string, string> {
  return Object.fromEntries(EDIT_ROWS.map((field) => [editDraftKey(field), currentValue(task, field)]));
}

const draftOf = (drafts: Record<string, string>, task: ResolvedTask, field: TaskEditField): string => drafts[editDraftKey(field)] ?? currentValue(task, field);

export interface DraftEdit {
  /** Only the fields whose text differs from the task's; an untouched field is never sent (§3.4). */
  edit: TaskEdit;
  /** A field whose text is not a number at all, keyed by field: the form's own message, not the validator's. */
  malformed: Partial<Record<TaskEditField, string>>;
}

/**
 * The `TaskEdit` the form would send, and the fields whose text is not yet a value at all.
 *
 * "Not a number" is answered here rather than by `planEdit`, because a half-typed `1` in the budget row is
 * not an error the operator has made yet — it is a row they are in the middle of — and the difference
 * between the two is whether Save is offered.
 */
export function draftEdit(task: ResolvedTask, drafts: Record<string, string>): DraftEdit {
  const edit: TaskEdit = {};
  const malformed: DraftEdit['malformed'] = {};
  for (const field of EDIT_ROWS) {
    const text = draftOf(drafts, task, field);
    if (text === currentValue(task, field)) continue;
    if (field === 'retries') {
      const n = Number(text.trim());
      if (text.trim() === '' || !Number.isInteger(n)) {
        malformed.retries = 'Retries is a whole number between 0 and 20.';
        continue;
      }
      edit.retries = n;
    } else if (field === 'maxBudgetUsd') {
      if (text.trim() === '') continue; // clearing a budget is not the same as setting one; leave it alone
      const n = Number(text.trim());
      if (!Number.isFinite(n)) {
        malformed.maxBudgetUsd = 'A budget is an amount in US dollars, such as 5 or 12.50.';
        continue;
      }
      edit.maxBudgetUsd = n;
    } else if (field === 'prompt') {
      edit.prompt = text;
    } else {
      edit[field] = text;
    }
  }
  return { edit, malformed };
}

export interface EditValidation {
  edit: TaskEdit;
  /** The fields that really change; empty means Save would do nothing. */
  fields: TaskEditField[];
  /** Blocking messages, by field where one is to blame and under `form` where the workflow is. */
  errors: Partial<Record<TaskEditField | 'form', string>>;
  /** What the edit would be allowed to do but probably should not, in `cao validate`'s words. */
  warnings: string[];
}

/**
 * Everything the form can decide without touching a process: format, then the workflow validator (§3.4).
 *
 * The per-field pass runs each changed field through `planEdit` on its own, so the message lands on the row
 * that caused it; the agent travels with the budget, because whether a budget is allowed at all depends on
 * which agent the *edited* task would run `[D20]`.
 */
export function validateDraft(workflow: ResolvedWorkflow, task: ResolvedTask, drafts: Record<string, string>): EditValidation {
  const { edit, malformed } = draftEdit(task, drafts);
  const errors: EditValidation['errors'] = { ...malformed };
  for (const field of EDIT_ROWS) {
    if (edit[field] === undefined || errors[field]) continue;
    const one = field === 'maxBudgetUsd' && edit.agent !== undefined ? { agent: edit.agent, maxBudgetUsd: edit.maxBudgetUsd } : { [field]: edit[field] };
    const planned = planEdit(task, one as TaskEdit);
    if (!planned.ok) errors[field] = planned.reason;
  }
  if (Object.keys(errors).length) return { edit, fields: [], errors, warnings: [] };

  const planned = planEdit(task, edit);
  if (!planned.ok) return { edit, fields: [], errors: { form: planned.reason }, warnings: [] };
  const { errors: validatorErrors, warnings } = validateEditedTask(workflow, planned.plan.task);
  if (validatorErrors.length) return { edit, fields: planned.plan.fields, errors: { form: validatorErrors.join(' ') }, warnings };
  return { edit, fields: planned.plan.fields, errors: {}, warnings };
}

/**
 * The context section that will be prepended to whatever prompt is saved `[D19]`.
 *
 * Built from the same `ContextBuilder` the scheduler uses at launch, so the panel is showing the text that
 * will really be there rather than a description of it. Empty for a task with no context sources.
 */
export function contextPreview(workflow: ResolvedWorkflow, tasks: Record<string, TaskRunState>, task: ResolvedTask): string {
  try {
    return new ContextBuilder().build({ task, tasks, taskDefs: new Map(workflow.tasks.map((t) => [t.id, t])) }).markdown;
  } catch {
    // A context source a half-finished run has nothing for is not a reason to refuse to draw the form.
    return '';
  }
}

/** What each row says about itself when there is nothing to validate. */
const ROW_HINT: Partial<Record<TaskEditField, string>> = {
  agent: 'claude or codex',
  model: 'a model id, or empty for the CLI default',
  effort: 'none, minimal, low, medium, high, xhigh, max',
  timeout: 'e.g. 90m, 1h30m, 45s',
  retries: '0-20, after the first attempt',
};

export interface EditFormProps {
  task: ResolvedTask;
  state: TaskRunState;
  workflow: ResolvedWorkflow;
  tasks: Record<string, TaskRunState>;
  drafts: Record<string, string>;
  cursor: number;
  rows: number;
  columns: number;
  theme: Theme;
  /** Set while the form is asking "restart now?" after Save (§3.4); the answer is the shell's. */
  confirmRestart?: { note?: string };
}

export function EditForm({ task, state, workflow, tasks, drafts, cursor, rows, columns, theme, confirmRestart }: EditFormProps): React.JSX.Element {
  const width = Math.max(24, columns);
  const validation = validateDraft(workflow, task, drafts);
  const labelWidth = Math.max(...EDIT_ROWS.map((f) => EDIT_FIELD_LABEL[f].length)) + 1;
  const valueWidth = Math.max(10, width - labelWidth - 4);
  const revisions = state.revisions?.length ?? 0;

  const lines: Array<{ text: string; token?: Parameters<Theme['paint']>[1]; bold?: boolean }> = [];
  const push = (text: string, token?: Parameters<Theme['paint']>[1], bold?: boolean): void => void lines.push({ text, token, bold });

  for (const [index, field] of EDIT_ROWS.entries()) {
    const selected = index === cursor;
    const label = `${selected ? glyph('cursor') : ' '} ${EDIT_FIELD_LABEL[field].padEnd(labelWidth)}`;
    const codexBudget = field === 'maxBudgetUsd' && (validation.edit.agent ?? task.agent) !== 'claude';
    if (field === 'prompt') {
      const text = drafts[editDraftKey('prompt')] ?? task.prompt;
      const body = wrapPlain(sanitizeText(text), valueWidth);
      // The prompt is the field an operator came here for, so it gets the rows: three when it is not
      // selected, as many as the form can spare when it is.
      const budget = selected ? Math.max(3, Math.min(body.length, Math.floor(rows / 3))) : Math.min(3, body.length);
      const shown = selected ? body.slice(-budget) : body.slice(0, budget);
      push(`${label}${shown[0] ?? ''}${selected && shown.length === 1 ? glyph('barFull') : ''}`, selected ? 'selection' : undefined);
      for (const [i, line] of shown.slice(1).entries()) {
        push(`${' '.repeat(labelWidth + 2)}${line}${selected && i === shown.length - 2 ? glyph('barFull') : ''}`);
      }
      if (body.length > shown.length) push(`${' '.repeat(labelWidth + 2)}${glyph('ellipsis')} ${body.length - shown.length} more line${body.length - shown.length === 1 ? '' : 's'}`, 'muted');
    } else {
      const value = codexBudget ? 'not supported by Codex' : (drafts[editDraftKey(field)] ?? currentValue(task, field)) || '(CLI default)';
      push(`${label}${truncateVisible(sanitizeText(value), valueWidth)}${selected && !codexBudget ? glyph('barFull') : ''}`, selected ? 'selection' : codexBudget ? 'muted' : undefined);
    }
    const message = validation.errors[field];
    if (message) push(`${' '.repeat(labelWidth + 2)}${glyph('subArrow')} ${message}`, 'danger');
    else if (selected && ROW_HINT[field]) push(`${' '.repeat(labelWidth + 2)}${ROW_HINT[field]!}`, 'muted');
  }

  if (validation.errors.form) push(`${glyph('subArrow')} ${validation.errors.form}`, 'danger');
  for (const warning of validation.warnings) push(`${glyph('subArrow')} ${warning}`, 'warn');

  const context = contextPreview(workflow, tasks, task);
  push(' ');
  push(`Context added at launch (read-only)${context ? '' : ': none for this task'}`, 'title');
  for (const line of context ? wrapPlain(sanitizeText(context), valueWidth).slice(0, 6) : []) push(`  ${line}`, 'muted');

  const saveSelected = cursor === SAVE_ROW;
  const blocked = Object.keys(validation.errors).length > 0;
  const nothing = validation.fields.length === 0;
  push(' ');
  push(
    `${saveSelected ? glyph('cursor') : ' '} Save${nothing ? '  (nothing to change yet)' : `  ${validation.fields.map((f) => EDIT_FIELD_LABEL[f]).join(', ')}`}`,
    blocked ? 'danger' : saveSelected ? 'selection' : undefined,
    true,
  );

  const slice = windowOf(lines, Math.min(cursor === SAVE_ROW ? lines.length - 1 : cursor, Math.max(0, lines.length - 1)), Math.max(1, rows - 3), { anchor: 0 });
  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate-end">
        {`Edit ${task.id}`}
        {theme.paint(`   ${state.state}${revisions ? `   revision ${revisions}` : ''}`, 'muted')}
      </Text>
      {confirmRestart ? (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{theme.paint(`${task.id} is ${state.state}. Restart it now with the edit applied?`, 'warn')}</Text>
          {confirmRestart.note ? <Text wrap="truncate-end">{theme.paint(truncateVisible(confirmRestart.note, width), 'warn')}</Text> : null}
          <Text wrap="truncate-end">{theme.paint('Y stop it and start again   N apply the edit only   Esc go back to the form', 'muted')}</Text>
        </Box>
      ) : null}
      {slice.items.map((line, i) => (
        <Text key={i} bold={line.bold} wrap="truncate-end">
          {line.token ? theme.paint(truncateVisible(line.text, width), line.token) : truncateVisible(line.text, width)}
        </Text>
      ))}
      <Text wrap="truncate-end">
        {theme.paint(`${slice.belowMarker ? `${slice.belowMarker}   ` : ''}${glyph('up')}${glyph('down')} field   Ctrl+O prompt in $EDITOR   Enter save   Esc cancel`, 'muted')}
      </Text>
    </Box>
  );
}
