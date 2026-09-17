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
import { glyph } from '../../util/glyphs.js';
import { TAB_LABEL, type FocusRegion, type WorkspaceTab } from '../store.js';
import type { EndedAction } from './ended.js';

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

/**
 * What the workspace is doing right now, which is what `Q` and `Ctrl+C` mean this frame.
 *
 * The three modes differ in exactly the two keys an operator reaches for when they want out, so a single
 * "anywhere" table has to be wrong in two of the three - and it was: `?` told an observer that `Q` asks
 * before quitting and that `Ctrl+C` stops the workers in this process, while the section above it on the
 * same screen said the opposite of both.
 */
export type KeyMode = 'executing' | 'ended' | 'observing';

/** The two keys that mean something different in each mode; the rest of `globalKeys` is fixed. */
const LEAVING_KEYS: Record<KeyMode, [KeyHelp, KeyHelp]> = {
  executing: [
    { keys: 'Q', what: 'quit: stay, stop and quit, or carry on in plain output', short: 'quit' },
    { keys: 'Ctrl+C', what: 'stop the run and stay here; again within 20s forces it' },
  ],
  ended: [
    { keys: 'Q', what: "quit and return the run's exit code", short: 'quit' },
    { keys: 'Ctrl+C', what: 'nothing left to stop: the run has already ended' },
  ],
  observing: [
    { keys: 'Q', what: 'close this window; the run carries on where it is', short: 'close' },
    { keys: 'Ctrl+C', what: 'ask the owner to stop the run; again to kill it' },
  ],
};

/** Answered everywhere, whatever has focus, in the words this mode makes true. */
export function globalKeys(mode: KeyMode = 'executing'): KeyHelp[] {
  return [
    { keys: 'Tab / Shift+Tab', what: 'move between the task list, the tabs and the panel' },
    { keys: 'Ctrl+P', what: 'command palette: every action and every task id' },
    { keys: '?', what: 'the keys of whatever has focus' },
    ...LEAVING_KEYS[mode],
  ];
}

/**
 * The arrow key names, in whichever alphabet this terminal can draw (§3.2).
 *
 * Built per call rather than held in a module constant: `CAO_ASCII` is read when a glyph is asked for, and
 * a table built at import time would have answered for whatever the environment said then.
 */
const UD = (): string => `${glyph('up')}${glyph('down')}`;
const LR = (): string => `${glyph('left')}${glyph('right')}`;

/** What a quit request offers while execution is still running [D5]. */
export type QuitAnswerKind = 'stay' | 'stopAndQuit' | 'plain';

export interface QuitAnswer {
  key: string;
  kind: QuitAnswerKind;
  label: string;
  what: string;
}

export const QUIT_ANSWERS: QuitAnswer[] = [
  { key: 'S', kind: 'stay', label: 'Stay', what: 'go back to the workspace; nothing changes' },
  { key: 'Q', kind: 'stopAndQuit', label: 'Stop and quit', what: "stop the workers, then leave with the run's exit code" },
  { key: 'P', kind: 'plain', label: 'Continue in plain output', what: 'the run carries on printing lines; D or Enter reopens this' },
];

/** The keys of the quit prompt, for `?`. */
export function quitKeys(): KeyHelp[] {
  return [
    ...QUIT_ANSWERS.map((answer) => ({ keys: answer.key, what: `${answer.label} ${glyph('dash')} ${answer.what}` })),
    { keys: `${UD()} / Enter`, what: 'choose an answer    Esc stays' },
  ];
}

/**
 * The ended-state actions as help rows (§2.4); empty while a run is still executing.
 *
 * `Q` is not repeated here: `globalKeys('ended')` already says what it does, and one key described twice in
 * one help panel is how the two descriptions drift apart.
 */
export function endedKeys(actions: EndedAction[]): KeyHelp[] {
  return actions.map((action) => ({ keys: action.key, what: action.label, short: action.label }));
}

/** The transcript viewer, reached with `F` and shared with `cao logs --follow`. */
export function viewerKeys(): KeyHelp[] {
  return [
    { keys: `${LR()} / Tab / 1-9`, what: 'switch task    P task picker    [ ] earlier/later attempt' },
    { keys: `${UD()} PgUp/PgDn`, what: 'scroll    g oldest line    G newest line and follow again' },
    { keys: 't / T / k', what: 'tool output, thinking, kind filter' },
    { keys: '/ n N', what: 'search and step through matches' },
    { keys: 'Esc / Q', what: 'back to the workspace' },
  ];
}

/** The prompt that opens by itself when a worker needs a human. */
export function promptKeys(): KeyHelp[] {
  return [
    { keys: 'Y / A / N / R', what: 'allow, allow for the rest of the task, deny, deny with a reason' },
    { keys: `1-9 / ${UD()} Enter`, what: 'choose an answer    T type one    N decline' },
  ];
}

const taskListKeys = (): KeyHelp[] => [
  { keys: UD(), what: 'move through the tasks', short: 'select' },
  { keys: 'Enter', what: 'open the selected task in the panel', short: 'open' },
  { keys: 'F / L', what: "follow the task's live transcript", short: 'follow' },
  { keys: 'R', what: 'restart a failed, blocked, cancelled or skipped task', short: 'restart' },
  { keys: '/', what: 'search the task list', short: 'search' },
];

const tabBarKeys = (): KeyHelp[] => [
  { keys: LR(), what: 'choose a tab; Home/End jump to the ends', short: 'tab' },
  { keys: 'Enter', what: 'open the tab and focus its panel', short: 'open' },
];

const overviewKeys = (): KeyHelp[] => [
  { keys: UD(), what: 'move through the task table; PgUp/PgDn and Home/End too', short: 'select' },
  { keys: 'F / L', what: "follow the selected task's transcript", short: 'follow' },
  { keys: 'R', what: 'restart the selected task', short: 'restart' },
  { keys: 'U', what: 'usage per task: tokens, context, cost, time in tools', short: 'usage' },
  { keys: 'C', what: 'the Changes tab: what each task changed', short: 'changes' },
];

const changesKeys = (): KeyHelp[] => [
  { keys: `${UD()} PgUp/PgDn`, what: 'select a file    g/G first/last', short: 'select' },
  { keys: 'Enter', what: `open the hunks    N/P hunk    ${LR()} file`, short: 'hunks' },
  { keys: 'O', what: 'open the file in $VISUAL / $EDITOR', short: 'editor' },
  { keys: 'Esc', what: 'back to the file list', short: 'back' },
];

const reportKeys = (): KeyHelp[] => [
  { keys: UD(), what: 'scroll the report; PgUp/PgDn and Home/End too', short: 'scroll' },
  { keys: '/', what: 'search the report', short: 'search' },
];

const placeholderKeys = (): KeyHelp[] => [{ keys: LR(), what: 'another tab; this one is not filled in yet', short: 'tab' }];

const mainKeys = (tab: WorkspaceTab): KeyHelp[] =>
  ({
    overview: overviewKeys,
    session: placeholderKeys,
    logs: placeholderKeys,
    changes: changesKeys,
    report: reportKeys,
    diagnostics: placeholderKeys,
  })[tab]();

/**
 * The keys of the panel that has focus, and what to call it.
 *
 * `taken` is the set of keys an ended run's actions or an observer's controls have claimed this frame.
 * Those handlers run before the panel's own, so a panel row for a key they answer describes something that
 * cannot happen: on an ended run `R` re-runs the task through a fresh resume, and the Tasks panel's
 * "R restart a failed task" is a second meaning for a key that no longer has it.
 */
export function panelHelp(focus: FocusRegion, tab: WorkspaceTab, taken: ReadonlySet<string> = new Set()): PanelHelp {
  const keep = (keys: KeyHelp[]): KeyHelp[] => (taken.size === 0 ? keys : keys.filter((help) => !(help.keys.length === 1 && taken.has(help.keys.toUpperCase()))));
  if (focus === 'tabs') return { title: 'Tabs', keys: keep(tabBarKeys()) };
  if (focus === 'main') return { title: TAB_LABEL[tab], keys: keep(mainKeys(tab)) };
  return { title: 'Tasks', keys: keep(taskListKeys()) };
}

/**
 * The chords that work in every panel, for the footer.
 *
 * Kept apart from the rest of the line because the footer is truncated to the terminal and these are the
 * ones that have to survive it: a footer that has run out of room for `Q` is a footer that never says how
 * to leave, which is what a 120-column terminal showed on every ended run. `Footer` reserves their width
 * and truncates the panel keys into whatever is left.
 */
export function alwaysHintCells(mode: KeyMode = 'executing'): string[] {
  const leaving = LEAVING_KEYS[mode][0];
  // In the order the footer gives them up: the palette chord first, the way out last.
  return ['Ctrl+P palette', '? help', `${leaving.keys} ${leaving.short ?? leaving.what}`];
}

/** The same cells as one string, for a caller that only wants to read them. */
export function alwaysHints(mode: KeyMode = 'executing'): string {
  return alwaysHintCells(mode).join('   ');
}

export interface FooterHintOptions {
  /** The ended run's actions or the observer's controls, which lead the line. */
  lead?: readonly { key: string; label: string; short?: string }[];
  /** Keys those actions have claimed, so the panel does not advertise its own meaning for them. */
  taken?: ReadonlySet<string>;
}

/**
 * The same keys as one line for the footer: the key, a space, the short form of what it does.
 *
 * The chords of `alwaysHints` are not in here; the footer adds them where truncation cannot reach them.
 * The Changes panel draws its own key line at the bottom of itself - it has two levels and different keys
 * in each - so the footer stays out of its way and names only the lead actions.
 */
export function footerHints(focus: FocusRegion, tab: WorkspaceTab, options: FooterHintOptions = {}): string {
  // An ended run's actions come first wherever they apply: they are the reason the workspace is still open
  // (§2.4), and an operator looking for "how do I retry this" should not have to press `?` to find out. The
  // observer's controls lead for the same reason and are passed in the same way (§2.1).
  const lead = options.lead?.length ? options.lead.map((action) => `${action.key} ${action.short ?? action.label}`) : [];
  if (focus === 'main' && tab === 'changes') return lead.join('   ');
  const panel = panelHelp(focus, tab, options.taken).keys.map((help) => `${help.keys} ${help.short ?? help.what}`);
  return [...lead, ...panel].join('   ');
}
