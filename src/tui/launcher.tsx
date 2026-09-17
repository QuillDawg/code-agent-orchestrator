/**
 * What `cao ui` shows when it was given no run (spec §3.1): the runs of this repository, newest first, and
 * the workflow files it could start instead.
 *
 * It is a picker, not a workspace. There is no run to draw a header, a sidebar or a tab bar from yet, and
 * putting an empty one up would be a frame full of placeholders — so this is one list and one line of keys,
 * sized to the terminal like everything else in `src/tui/` (§2.5).
 */
import React, { useState } from 'react';
import { Box, Text, render, useInput, useWindowSize } from 'ink';
import { formatAge } from '../util/duration.js';
import { glyph } from '../util/glyphs.js';
import { truncateVisible } from '../cli/util.js';
import { formatCost } from './format.js';
import { workspaceRenderOptions } from './render-options.js';
import { armAltScreenRestore } from './terminal.js';
import { resolveTheme, type Theme } from './theme.js';
import { windowOf } from './window.js';

/** One run, as the launcher lists it: what `cao list` knows plus how old it is and what it cost (§3.1). */
export interface LauncherRun {
  runId: string;
  workflowName: string;
  state: string;
  createdAt: string;
  costUsd?: number;
  progress: { done: number; total: number };
}

export type LauncherChoice = { kind: 'open'; runId: string } | { kind: 'run'; workflow: string } | { kind: 'quit' };

export interface LauncherProps {
  runs: LauncherRun[];
  /** Workflow files found in the launch directory, as paths to show and to run. */
  workflows: string[];
  now: number;
  onChoose(choice: LauncherChoice): void;
  theme?: Theme;
}

interface Row {
  key: string;
  label: string;
  hint: string;
  choice: LauncherChoice;
}

/** The rows, in the order the launcher offers them: runs to reopen, then workflows to start. */
export function launcherRows(props: Pick<LauncherProps, 'runs' | 'workflows' | 'now'>): Row[] {
  const rows: Row[] = props.runs.map((run) => ({
    key: `run:${run.runId}`,
    label: `${run.runId}  ${run.workflowName}`,
    hint: [run.state, `${run.progress.done}/${run.progress.total}`, formatAge(run.createdAt, props.now), run.costUsd !== undefined ? formatCost(run.costUsd) : ''].filter(Boolean).join('   '),
    choice: { kind: 'open', runId: run.runId },
  }));
  for (const workflow of props.workflows) {
    rows.push({ key: `workflow:${workflow}`, label: `Run ${workflow}`, hint: 'start a new run', choice: { kind: 'run', workflow } });
  }
  return rows;
}

export function Launcher(props: LauncherProps): React.JSX.Element {
  const { rows: terminalRows, columns } = useWindowSize();
  const theme = props.theme ?? resolveTheme();
  const rows = launcherRows(props);
  const [cursor, setCursor] = useState(0);
  const [path, setPath] = useState<string | null>(null);

  useInput((input, key) => {
    // §3.2 gives Ctrl+C a meaning everywhere in the workspace, and `workspaceRenderOptions` pins
    // `exitOnCtrlC: false`, so Ink delivers it as a keystroke and no signal handler will ever see it. There
    // is no run here to stop, so the honest meaning of an interrupt in a picker is the one Q has: leave
    // without choosing. It reads before the path field, like the other chords a composer does not swallow.
    if (key.ctrl && input === 'c') {
      props.onChoose({ kind: 'quit' });
      return;
    }
    if (path !== null) {
      if (key.escape) setPath(null);
      else if (key.return) {
        const typed = path.trim();
        setPath(null);
        if (typed) props.onChoose({ kind: 'run', workflow: typed });
      } else if (key.backspace || key.delete) setPath(path.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab) setPath(path + input);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(Math.max(0, rows.length - 1), c + 1));
    else if (key.return) {
      const row = rows[cursor];
      if (row) props.onChoose(row.choice);
    } else if (input.toLowerCase() === 'p') setPath('');
    else if (input.toLowerCase() === 'q' || key.escape) props.onChoose({ kind: 'quit' });
  });

  // Title, blank, the key line, and the path field when it is open: what is left is the list.
  const budget = Math.max(1, terminalRows - 3 - (path !== null ? 1 : 0));
  const slice = windowOf(rows, cursor, budget, { anchor: cursor });
  const hintWidth = Math.min(38, Math.max(0, columns - 30));

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} overflow="hidden">
      <Text bold wrap="truncate-end">
        cao {theme.paint(glyph('dash'), 'muted')} {rows.length ? 'choose a run to open, or a workflow to start' : 'no runs here yet'}
      </Text>
      {slice.items.map((row, i) => {
        const index = slice.start + i;
        const label = truncateVisible(row.label, Math.max(10, columns - hintWidth - 4));
        return (
          <Text key={row.key} wrap="truncate-end">
            {index === cursor ? theme.paint(`${glyph('cursor')} `, 'accent') : '  '}
            {index === cursor ? theme.paint(label, 'selection') : label}
            {'  '}
            {theme.paint(truncateVisible(row.hint, hintWidth), 'muted')}
          </Text>
        );
      })}
      {rows.length === 0 && <Text dimColor>Start one with "cao run &lt;workflow.yaml&gt;", or press P to type a path.</Text>}
      <Box flexGrow={1} />
      {path !== null && (
        <Text wrap="truncate-end">
          {theme.paint('workflow path> ', 'accent')}
          {path}
          {theme.paint(glyph('barFull'), 'accent')}
        </Text>
      )}
      <Text wrap="truncate-end">{theme.paint('↑↓ choose   Enter open   P type a workflow path   Q quit', 'muted')}</Text>
    </Box>
  );
}

export interface LauncherOptions {
  runs: LauncherRun[];
  workflows: string[];
  altScreen?: boolean;
  theme?: string;
  now?: number;
  /** Injected by tests; defaults to Ink's `render`. */
  mount?: typeof render;
}

/** Put the launcher up and resolve with what was chosen. */
export async function runLauncher(opts: LauncherOptions): Promise<LauncherChoice> {
  const options = workspaceRenderOptions({ flag: opts.altScreen });
  let choice: LauncherChoice = { kind: 'quit' };
  const mount = opts.mount ?? render;
  const instance: ReturnType<typeof render> = mount(
    <Launcher
      runs={opts.runs}
      workflows={opts.workflows}
      now={opts.now ?? Date.now()}
      theme={resolveTheme({ theme: opts.theme })}
      onChoose={(next) => {
        choice = next;
        // Assigned by the time a key can be pressed: `mount` commits the first frame and returns before
        // Ink subscribes to stdin.
        instance.unmount();
      }}
    />,
    options,
  );
  // Ink leaves the alternate screen itself on unmount and the crash handler covers a throw; arming this
  // covers the remainder — a `process.exit` while the picker is up — exactly as the workspace does (§2.4).
  const disarm = options.alternateScreen && process.stdout.isTTY ? armAltScreenRestore() : undefined;
  try {
    await instance.waitUntilExit().catch(() => undefined);
  } finally {
    disarm?.();
  }
  return choice;
}
