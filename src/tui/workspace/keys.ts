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

/**
 * The navigation table of spec §3.2, as this build binds it.
 *
 * It exists once, here, because it is written down in three places that have to agree: the `?` panel, the
 * `Navigating the workspace` table in `docs/capabilities.md`, and the handlers in `app.tsx`. The first two
 * are generated from this array - `test/unit/theme.test.ts` rebuilds the doc's table from it and fails if a
 * row has drifted - so a chord that is renamed here is renamed in the documentation in the same commit.
 *
 * Built per call rather than held in a constant for the same reason `UD()` is: the arrow names are glyphs,
 * and `CAO_ASCII` is read when a glyph is asked for.
 */
export interface NavigationKey {
  /** The chord, in the words the terminal sends it. */
  input: string;
  behaviour: string;
  /** What is worth knowing about it beyond what it does; empty where there is nothing. */
  note?: string;
}

export function navigationKeys(): NavigationKey[] {
  return [
    { input: 'Tab / Shift+Tab', behaviour: 'Move focus between panels', note: 'the `\\x1bOZ` variant some Windows terminals send is parsed too' },
    { input: `${UD()} ${LR()} PgUp/PgDn Home/End`, behaviour: 'Navigate the focused panel' },
    { input: 'Enter', behaviour: 'Open or activate' },
    { input: 'Esc', behaviour: 'Close a dialog, leave the composer, go back' },
    { input: 'Ctrl+P', behaviour: 'Command palette over every action and every task id' },
    { input: '/', behaviour: 'Search the focused list or transcript' },
    { input: '?', behaviour: 'The keys of whatever has focus' },
    { input: 'Q', behaviour: 'Quit request', note: 'not inside a composer' },
    { input: 'Ctrl+C', behaviour: 'Graceful stop; the workspace stays open' },
    { input: 'Ctrl+O', behaviour: 'In a composer: open it in $VISUAL / $EDITOR', note: 'mirrors `O` in the Changes view' },
    { input: 'Ctrl+J', behaviour: 'Newline in a composer; Enter submits', note: 'Shift+Enter works only where the kitty protocol is on' },
  ];
}

/** The navigation table as `?` shows it: the same rows, in the shape the help panel draws. */
export function navigationHelp(): KeyHelp[] {
  return navigationKeys().map((key) => ({ keys: key.input, what: key.note ? `${key.behaviour} ${glyph('dash')} ${key.note}` : key.behaviour }));
}

/** Answered everywhere, whatever has focus, in the words this mode makes true. */
export function globalKeys(mode: KeyMode = 'executing'): KeyHelp[] {
  return [
    { keys: 'Tab / Shift+Tab', what: 'cycle the task list, the tabs, the panel and the footer' },
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

/** The task editor `E` opens (§3.4). */
export function editKeys(): KeyHelp[] {
  return [
    { keys: `${UD()}`, what: 'move between the fields; Enter on the last one goes to Save' },
    { keys: 'Ctrl+O', what: 'write the prompt in $VISUAL / $EDITOR' },
    { keys: 'Ctrl+J', what: 'a newline (a trailing backslash then Enter does the same)' },
    { keys: 'Enter', what: 'Save; a running or waiting task is asked about first' },
    { keys: 'Esc', what: 'close the form; nothing is sent' },
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
  { keys: 'E', what: "edit an unfinished task (prompt, agent, model, limits)", short: 'edit' },
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
  { keys: 'E', what: 'edit the selected task; a running one is stopped and started again', short: 'edit' },
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

/**
 * The Logs panel (§3.7). Nearly every printable key is this panel's own, because it is four views of six
 * kinds of file with five filters over them, and there is no room for a key here to also mean what it
 * means in the task list.
 */
const logsKeys = (): KeyHelp[] => [
  { keys: `${UD()} PgUp/PgDn`, what: 'scroll; older pages are read from disk as you reach them', short: 'scroll' },
  { keys: 'g / G', what: 'the oldest line held / back to the newest', short: 'ends' },
  { keys: 'v', what: 'the next view: events, stderr, raw output, prompts (V goes back)', short: 'view' },
  { keys: '[ / ]', what: 'the previous / next file this view offers', short: 'file' },
  { keys: 't / k / m', what: 'filter by task / severity / time range (uppercase steps back)', short: 'filter' },
  { keys: '/ n N', what: 'search this file and step through the matches', short: 'search' },
  { keys: 'R', what: 'read the newest page again', short: 'reload' },
  { keys: LR(), what: 'another tab', short: 'tab' },
];

/** The Diagnostics panel (§3.7). It shows rather than does, so it scrolls and it re-reads. */
const diagnosticsKeys = (): KeyHelp[] => [
  { keys: `${UD()} PgUp/PgDn`, what: 'scroll; Home/End jump to the ends', short: 'scroll' },
  { keys: 'R', what: 'read the agent versions, the retry history and the inbox again', short: 'reload' },
  { keys: LR(), what: 'another tab', short: 'tab' },
];

/**
 * The Session tab: the transcript, what has been sent, and the key that opens the composer (§3.5).
 *
 * The composer's own keys are **not** here. They used to be, so that `?` could reach them, but the footer
 * reads this same list — and a Session panel with no composer open then advertised `Enter compose` and
 * `Enter send` on one line, one key with two meanings and only one of them true of the frame. `?` gets
 * them as a section of its own instead (`helpSections`).
 */
const sessionKeys = (): KeyHelp[] => [
  { keys: 'Enter', what: 'open the composer; the header says which mode the message will use', short: 'compose' },
  { keys: 'E', what: 'edit the selected task (the form opens over this panel)', short: 'edit' },
  { keys: 'F', what: "the full transcript in the viewer, with earlier attempts", short: 'transcript' },
  { keys: LR(), what: 'another tab', short: 'tab' },
];

/**
 * The composer's keys (§3.2, `[D15]`), shown by `?` as its own section because `?` cannot be pressed from
 * inside the composer — in a field every printable key is text, `?` included.
 */
export function composerKeys(): KeyHelp[] {
  return [
    { keys: 'Enter', what: 'send the message', short: 'send' },
    { keys: 'Ctrl+J', what: 'a newline (Shift+Enter too, where the terminal reports it)' },
    { keys: 'Ctrl+O', what: 'write the message in $VISUAL / $EDITOR' },
    { keys: 'Ctrl+F', what: 'Start a fresh session rather than resume the one it reported' },
    { keys: `Ctrl+Z / Ctrl+W`, what: 'undo the last edit / delete the word before the cursor' },
    { keys: `${LR()} / ${UD()} / Home / End`, what: 'move the cursor; Ctrl with an arrow moves by word' },
    { keys: 'Esc', what: 'close the composer; the draft is kept until you quit' },
  ];
}

/**
 * The footer (§3.6). One key, because the footer shows rather than does: the provider quota chips and how
 * old the picture is, and the only thing an operator can ask of them is "read it again".
 */
const footerKeys = (): KeyHelp[] => [{ keys: 'R', what: 'read the provider quotas again', short: 'refresh quotas' }];

const mainKeys = (tab: WorkspaceTab): KeyHelp[] =>
  ({
    overview: overviewKeys,
    session: sessionKeys,
    logs: logsKeys,
    changes: changesKeys,
    report: reportKeys,
    diagnostics: diagnosticsKeys,
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
  if (focus === 'footer') return { title: 'Footer', keys: keep(footerKeys()) };
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
