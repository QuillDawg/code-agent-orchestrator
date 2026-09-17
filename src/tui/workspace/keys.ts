/**
 * Every key the workspace answers, written down once.
 *
 * The footer and the `?` panel both read this table, which is the only way the two can agree: a footer hint
 * maintained beside the handler and a help screen maintained somewhere else drift apart within a stage, and
 * the first thing an operator does when a key surprises them is press `?`.
 *
 * The transcript viewer and the prompt keep their own sections here rather than only in the views that own
 * them, because `?` in the workspace has to answer "what can I press" for the whole of it - including the
 * views it opens - and those keys have not changed.
 */
import { TAB_LABEL, type FocusRegion, type WorkspaceTab } from '../store.js';

export interface KeyHelp {
  keys: string;
  what: string;
  /** What the footer says, when the full sentence is too long for a line shared with five others. */
  short?: string;
}

export interface PanelHelp {
  title: string;
  keys: KeyHelp[];
}

/** Answered everywhere, whatever has focus. */
export const GLOBAL_KEYS: KeyHelp[] = [
  { keys: 'Tab / Shift+Tab', what: 'move between the task list, the tabs and the panel' },
  { keys: 'Ctrl+P', what: 'command palette: every action and every task id' },
  { keys: '?', what: 'the keys of whatever has focus' },
  { keys: 'Q', what: 'minimise the workspace (the run continues; D reopens it)' },
  { keys: 'Ctrl+C', what: 'stop the run (twice to force)' },
];

/** The transcript viewer, reached with `F` and shared with `cao logs --follow`. */
export const VIEWER_KEYS: KeyHelp[] = [
  { keys: '←→ / Tab / 1-9', what: 'switch task    P task picker    [ ] earlier/later attempt' },
  { keys: '↑↓ PgUp/PgDn', what: 'scroll    g oldest line    G newest line and follow again' },
  { keys: 't / T / k', what: 'tool output, thinking, kind filter' },
  { keys: '/ n N', what: 'search and step through matches' },
  { keys: 'Esc / Q', what: 'back to the workspace' },
];

/** The prompt that opens by itself when a worker needs a human. */
export const PROMPT_KEYS: KeyHelp[] = [
  { keys: 'Y / A / N / R', what: 'allow, allow for the rest of the task, deny, deny with a reason' },
  { keys: '1-9 / ↑↓ Enter', what: 'choose an answer    T type one    N decline' },
];

const TASK_LIST_KEYS: KeyHelp[] = [
  { keys: '↑↓', what: 'move through the tasks', short: 'select' },
  { keys: 'Enter', what: 'open the selected task in the panel', short: 'open' },
  { keys: 'F / L', what: "follow the task's live transcript", short: 'follow' },
  { keys: 'R', what: 'restart a failed, blocked, cancelled or skipped task', short: 'restart' },
  { keys: '/', what: 'search the task list', short: 'search' },
];

const TAB_BAR_KEYS: KeyHelp[] = [
  { keys: '←→', what: 'choose a tab; Home/End jump to the ends', short: 'tab' },
  { keys: 'Enter', what: 'open the tab and focus its panel', short: 'open' },
];

const OVERVIEW_KEYS: KeyHelp[] = [
  { keys: '↑↓', what: 'move through the task table; PgUp/PgDn and Home/End too', short: 'select' },
  { keys: 'F / L', what: "follow the selected task's transcript", short: 'follow' },
  { keys: 'R', what: 'restart the selected task', short: 'restart' },
  { keys: 'U', what: 'usage per task: tokens, context, cost, time in tools', short: 'usage' },
  { keys: 'C', what: 'the Changes tab: what each task changed', short: 'changes' },
];

const CHANGES_KEYS: KeyHelp[] = [
  { keys: '↑↓ PgUp/PgDn', what: 'select a file    g/G first/last', short: 'select' },
  { keys: 'Enter', what: 'open the hunks    N/P hunk    ←→ file', short: 'hunks' },
  { keys: 'O', what: 'open the file in $VISUAL / $EDITOR', short: 'editor' },
  { keys: 'Esc', what: 'back to the file list', short: 'back' },
];

const REPORT_KEYS: KeyHelp[] = [
  { keys: '↑↓', what: 'scroll the report; PgUp/PgDn and Home/End too', short: 'scroll' },
  { keys: '/', what: 'search the report', short: 'search' },
];

const PLACEHOLDER_KEYS: KeyHelp[] = [{ keys: '←→', what: 'another tab; this one is not filled in yet', short: 'tab' }];

const MAIN_KEYS: Record<WorkspaceTab, KeyHelp[]> = {
  overview: OVERVIEW_KEYS,
  session: PLACEHOLDER_KEYS,
  logs: PLACEHOLDER_KEYS,
  changes: CHANGES_KEYS,
  report: REPORT_KEYS,
  diagnostics: PLACEHOLDER_KEYS,
};

/** The keys of the panel that has focus, and what to call it. */
export function panelHelp(focus: FocusRegion, tab: WorkspaceTab): PanelHelp {
  if (focus === 'tabs') return { title: 'Tabs', keys: TAB_BAR_KEYS };
  if (focus === 'main') return { title: TAB_LABEL[tab], keys: MAIN_KEYS[tab] };
  return { title: 'Tasks', keys: TASK_LIST_KEYS };
}

const ALWAYS = ['Ctrl+P palette', '? help', 'Q minimise'];

/**
 * The same keys as one line for the footer: the key, a space, the short form of what it does.
 *
 * The Changes panel draws its own key line at the bottom of itself - it has two levels and different keys in
 * each - so the footer stays out of its way and only names the chords that work everywhere.
 */
export function footerHints(focus: FocusRegion, tab: WorkspaceTab): string {
  if (focus === 'main' && tab === 'changes') return ALWAYS.join('   ');
  const panel = panelHelp(focus, tab).keys.map((help) => `${help.keys} ${help.short ?? help.what}`);
  return [...panel, ...ALWAYS].join('   ');
}
