/**
 * One modal for everything that needs a human: approval gates, permission prompts and questions.
 *
 * Every string an agent controls is passed through sanitizeText() before it is rendered. This is the surface
 * an operator reads to decide allow/deny, so a worker must not be able to emit a carriage return or a cursor
 * escape that repaints the command it is asking permission to run.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  type ResolvedTask,
  type Interaction,
  type InteractionAnswer,
  canAllowAlways,
} from 'code-agent-orchestrator-protocol';
import { paint, sanitizeText } from '../../cli/color.js';

export type PendingItem =
  | { kind: 'approval'; id: string; task: ResolvedTask; resolve: (r: { decision: 'approved' | 'rejected'; note?: string } | 'defer') => void }
  | { kind: 'interaction'; id: string; interaction: Interaction; resolve: (a: InteractionAnswer) => void };

export interface ModalProps {
  item: PendingItem;
  queued: number;
  width: number;
  height: number;
  onDone: () => void;
}

const MAX_INPUT_LINES = 12;

/**
 * Agent-written prose, clamped to a box: sanitized, wrapped at `width` and cut to `maxLines`. Nothing an
 * agent writes may be long enough to push the answer keys off the bottom of the terminal - an operator who
 * cannot see "Y allow / N deny" cannot answer, and the worker waits out `interactionTimeout` for nothing.
 */
export function clampText(text: string, maxLines: number, width: number): string[] {
  const wrapWidth = Math.max(20, width);
  const out: string[] = [];
  for (const raw of sanitizeText(text).replace(/\r\n?/g, '\n').split('\n')) {
    let rest = raw;
    do {
      out.push(rest.slice(0, wrapWidth));
      rest = rest.slice(wrapWidth);
      if (out.length > maxLines) break;
    } while (rest.length > 0);
    if (out.length > maxLines) break;
  }
  if (out.length <= maxLines) return out;
  return [...out.slice(0, maxLines), `... clipped; the full text is in the task's events.jsonl`];
}

/** A window of `size` options around the cursor, so a question with fifty of them still fits the screen. */
export function optionWindow(count: number, cursor: number, size: number): { from: number; to: number } {
  if (count <= size) return { from: 0, to: count };
  const from = Math.max(0, Math.min(count - size, cursor - Math.floor(size / 2)));
  return { from, to: from + size };
}

/** Lines describing a tool input for the permission modal; every line is sanitized and clipped to the box width. */
export function describeInput(toolName: string, input: Record<string, unknown>, width: number): string[] {
  const clip = (s: string): string[] =>
    sanitizeText(s.replace(/\r\n?/g, '\n'))
      .split('\n')
      .slice(0, MAX_INPUT_LINES)
      .map((l) => (width > 4 && l.length > width - 4 ? `${l.slice(0, width - 5)}…` : l));
  const str = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const label = (text: string): string => sanitizeText(text).slice(0, Math.max(8, width));
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return clip(str('command') ?? '');
    case 'Write': {
      const content = str('content') ?? '';
      return [`file: ${label(str('file_path') ?? '')}`, `${content.split('\n').length} lines`, ...clip(content).slice(0, 6)];
    }
    case 'Edit':
      return [`file: ${label(str('file_path') ?? '')}`, '--- old', ...clip(str('old_string') ?? '').slice(0, 4), '+++ new', ...clip(str('new_string') ?? '').slice(0, 4)];
    case 'WebFetch':
      return [`url: ${label(str('url') ?? '')}`];
    default: {
      const json = JSON.stringify(input, null, 1) ?? '';
      return clip(json).slice(0, 8);
    }
  }
}

function useTextInput(active: boolean, onSubmit: (text: string) => void, onCancel: () => void): { value: string } {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (!active) setValue('');
  }, [active]);
  useInput(
    (input, key) => {
      if (key.return) onSubmit(value);
      else if (key.escape) onCancel();
      // Ink 7 reports Backspace as `key.backspace`; before 7.0.0 it arrived as `key.delete`, which is why
      // both were accepted here. `key.delete` is now the forward-delete key and must not erase backwards.
      else if (key.backspace) setValue((v) => v.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
    },
    { isActive: active },
  );
  return { value };
}

function ApprovalBody(props: { item: Extract<PendingItem, { kind: 'approval' }>; onDone: () => void }): React.JSX.Element {
  const [note, setNote] = useState<'approve' | 'reject' | null>(null);
  const text = useTextInput(
    note !== null,
    (value) => {
      props.item.resolve({ decision: note === 'approve' ? 'approved' : 'rejected', note: value || undefined });
      props.onDone();
    },
    () => setNote(null),
  );
  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (lower === 'y' || key.return) {
        props.item.resolve({ decision: 'approved' });
        props.onDone();
      } else if (lower === 'n') {
        props.item.resolve({ decision: 'rejected' });
        props.onDone();
      } else if (lower === 'd') {
        props.item.resolve('defer');
        props.onDone();
      } else if (lower === 'm') setNote('approve');
      else if (lower === 'r') setNote('reject');
    },
    { isActive: note === null },
  );
  return (
    <Box flexDirection="column">
      <Text color="yellow" bold>
        ⏸ Approval required: {props.item.task.id}
      </Text>
      <Text>{props.item.task.prompt}</Text>
      <Text> </Text>
      {note !== null ? (
        <Text>
          {note === 'approve' ? 'Approve' : 'Reject'} with note: <Text color="cyan">{text.value}</Text>
          <Text dimColor>▏  Enter confirm   Esc back</Text>
        </Text>
      ) : (
        <Text>
          <Text bold>Y</Text>/Enter approve   <Text bold>N</Text> reject   <Text bold>M</Text> approve with note   <Text bold>R</Text> reject with note   <Text bold>D</Text> defer (pause run; resume with --approve)
        </Text>
      )}
    </Box>
  );
}

function PermissionBody(props: { interaction: Interaction; resolve: (a: InteractionAnswer) => void; width: number; height: number; onDone: () => void }): React.JSX.Element {
  const { interaction } = props;
  const [denying, setDenying] = useState(false);
  // "Allow for the rest of this task" is only offered when the CLI supplied a rule scoped to this request;
  // without one there is nothing to remember but "every use of this tool", which is not what the key says.
  const allowAlways = canAllowAlways(interaction);
  const text = useTextInput(
    denying,
    (value) => {
      props.resolve({ kind: 'deny', message: value || 'Denied by the user' });
      props.onDone();
    },
    () => setDenying(false),
  );
  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (lower === 'y' || (key.return && !interaction.defaultToNo)) {
        props.resolve({ kind: 'allow', scope: 'once' });
        props.onDone();
      } else if (lower === 'a' && allowAlways) {
        props.resolve({ kind: 'allow', scope: 'always' });
        props.onDone();
      } else if (lower === 'n' || (key.return && interaction.defaultToNo)) {
        props.resolve({ kind: 'deny', message: 'Denied by the user' });
        props.onDone();
      } else if (lower === 'r') setDenying(true);
    },
    { isActive: !denying },
  );
  const lines = describeInput(interaction.toolName, interaction.input, props.width);
  // The box, the keys and the header take about a dozen rows; whatever is left is the title's budget.
  const titleLines = clampText(interaction.title, Math.max(2, Math.min(8, props.height - 16)), props.width);
  return (
    <Box flexDirection="column">
      <Text color="yellow" bold>
        ? {interaction.taskId} wants to use {sanitizeText(interaction.toolName)}
      </Text>
      {titleLines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      {interaction.description && interaction.description !== interaction.title && (
        <Text dimColor>{clampText(interaction.description, 3, props.width).join('\n')}</Text>
      )}
      {interaction.decisionReason && <Text color="magenta">{sanitizeText(interaction.decisionReason)}</Text>}
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} marginBottom={1}>
        {lines.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {paint(l, 'yellow')}
          </Text>
        ))}
        {lines.length === 0 && <Text dimColor>(no input)</Text>}
      </Box>
      {denying ? (
        <Text>
          Deny with reason: <Text color="cyan">{text.value}</Text>
          <Text dimColor>▏  Enter send   Esc back</Text>
        </Text>
      ) : (
        <Text>
          <Text bold>Y</Text>
          {interaction.defaultToNo ? '' : '/Enter'} allow once{'   '}
          {allowAlways && (
            <>
              <Text bold>A</Text> allow for the rest of this task{'   '}
            </>
          )}
          <Text bold>N</Text>
          {interaction.defaultToNo ? '/Enter' : ''} deny{'   '}
          <Text bold>R</Text> deny with reason
        </Text>
      )}
    </Box>
  );
}

function QuestionBody(props: { interaction: Interaction; resolve: (a: InteractionAnswer) => void; width: number; height: number; onDone: () => void }): React.JSX.Element {
  const questions = props.interaction.questions ?? [];
  const [qi, setQi] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Record<number, Set<number>>>({});
  const [free, setFree] = useState<Record<number, string>>({});
  const [typing, setTyping] = useState(false);
  const q = questions[qi];
  const text = useTextInput(
    typing,
    (value) => {
      setFree((f) => ({ ...f, [qi]: value }));
      setTyping(false);
      advance();
    },
    () => setTyping(false),
  );

  const answerOf = (i: number): string | undefined => {
    const question = questions[i];
    if (!question) return undefined;
    if (free[i] !== undefined) return free[i];
    const set = chosen[i];
    if (!set || set.size === 0) return undefined;
    return [...set].sort((a, b) => a - b).map((k) => question.options[k]?.label ?? '').filter(Boolean).join(', ');
  };
  const submit = (): void => {
    const answers: Record<string, string> = {};
    questions.forEach((question, i) => {
      answers[question.question] = answerOf(i) ?? '';
    });
    props.resolve({ kind: 'answer', answers });
    props.onDone();
  };
  const advance = (): void => {
    if (qi < questions.length - 1) {
      setQi(qi + 1);
      setCursor(0);
    }
  };
  const select = (index: number): void => {
    if (!q || index < 0 || index >= q.options.length) return;
    setChosen((c) => {
      const set = new Set(q.multiSelect ? c[qi] ?? [] : []);
      if (q.multiSelect && set.has(index)) set.delete(index);
      else set.add(index);
      return { ...c, [qi]: set };
    });
    setFree((f) => {
      const copy = { ...f };
      delete copy[qi];
      return copy;
    });
    if (!q.multiSelect) advance();
  };

  useInput(
    (input, key) => {
      const lower = input.toLowerCase();
      if (!q) return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(q.options.length - 1, c + 1));
      else if (/^[1-9]$/.test(input)) select(Number(input) - 1);
      else if (input === ' ') select(cursor);
      else if (key.return) {
        if (answerOf(qi) === undefined) select(cursor);
        else if (questions.every((_, i) => answerOf(i) !== undefined)) submit();
        else advance();
      } else if (key.tab) advance();
      else if (lower === 't') setTyping(true);
      else if (lower === 's' && questions.every((_, i) => answerOf(i) !== undefined)) submit();
      else if (lower === 'n' || key.escape) {
        props.resolve({ kind: 'deny', message: 'The user declined to answer' });
        props.onDone();
      }
    },
    { isActive: !typing },
  );

  if (!q) {
    return <Text color="red">Question without content; press N to decline.</Text>;
  }
  const allAnswered = questions.every((_, i) => answerOf(i) !== undefined);
  // The options list is the part that has to stay on screen, so the question text yields to it first.
  const room = Math.max(6, props.height - 10);
  const optionRows = Math.max(3, Math.min(q.options.length, room - 4));
  const questionLines = Math.max(2, Math.min(8, room - optionRows));
  const shown = optionWindow(q.options.length, cursor, optionRows);
  return (
    <Box flexDirection="column">
      <Text color="yellow" bold>
        ? {props.interaction.taskId} asks{questions.length > 1 ? ` (${qi + 1}/${questions.length})` : ''}: {sanitizeText(q.header ?? '')}
      </Text>
      {clampText(q.question, questionLines, props.width).map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {shown.from > 0 && <Text dimColor>↑ {shown.from} more above</Text>}
        {q.options.slice(shown.from, shown.to).map((o, n) => {
          const i = shown.from + n;
          const picked = chosen[qi]?.has(i) ?? false;
          return (
            <Text key={i} inverse={i === cursor} wrap="truncate-end">
              {picked ? '◉ ' : '○ '}
              <Text bold>{i + 1}</Text>) {sanitizeText(o.label)}
              {o.description ? <Text dimColor> — {sanitizeText(o.description)}</Text> : null}
            </Text>
          );
        })}
        {shown.to < q.options.length && <Text dimColor>↓ {q.options.length - shown.to} more below</Text>}
        {free[qi] !== undefined && <Text color="green">Free text: {free[qi]}</Text>}
        {q.multiSelect && <Text dimColor>(multiple answers allowed)</Text>}
      </Box>
      {typing ? (
        <Text>
          Your answer: <Text color="cyan">{text.value}</Text>
          <Text dimColor>▏  Enter confirm   Esc back</Text>
        </Text>
      ) : (
        <Text>
          <Text bold>1-9</Text>/↑↓+Enter choose   <Text bold>Space</Text> toggle   <Text bold>T</Text> type an answer   {questions.length > 1 ? 'Tab next   ' : ''}
          {allAnswered ? (
            <>
              <Text bold>Enter</Text>/<Text bold>S</Text> send
            </>
          ) : null}
          <Text bold>N</Text> decline
        </Text>
      )}
    </Box>
  );
}

export function Modal(props: ModalProps): React.JSX.Element {
  const { item } = props;
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      {item.kind === 'approval' ? (
        <ApprovalBody item={item} onDone={props.onDone} />
      ) : item.interaction.kind === 'question' ? (
        <QuestionBody interaction={item.interaction} resolve={item.resolve} width={props.width - 8} height={props.height} onDone={props.onDone} />
      ) : (
        <PermissionBody interaction={item.interaction} resolve={item.resolve} width={props.width - 8} height={props.height} onDone={props.onDone} />
      )}
      {props.queued > 0 && <Text dimColor>{props.queued} more waiting</Text>}
    </Box>
  );
}
