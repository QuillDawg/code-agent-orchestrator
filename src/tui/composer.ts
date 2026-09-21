/**
 * The multiline composer's buffer (spec §3.2, §3.5; `[D14]`, `[D16]`).
 *
 * An in-house controlled buffer, because no ecosystem package qualifies `[D14]`: lines as a `string[]`, a
 * cursor counted in **code points** rather than UTF-16 units, and every edit a pure function from one state
 * to the next. That last part is what makes it testable without a terminal — the component below it only
 * draws what these functions return and hands key presses back.
 *
 * Code points, not characters: a cursor that counts UTF-16 units walks into the middle of an emoji and
 * leaves a lone surrogate in the text an operator is about to send. Grapheme clusters would be more correct
 * still (a flag is several code points), but they need a segmenter for every edit and the failure they
 * prevent — a cursor between two regional indicators — is visible and recoverable, where a broken surrogate
 * is neither.
 */

/** A paste longer than this is drawn collapsed; the buffer keeps every byte of it `[D16]`. */
export const PASTE_COLLAPSE_LINES = 20;

/** How many edits `undo` can walk back `[D14]`. */
export const UNDO_LIMIT = 100;

/** A pasted block the buffer holds whole and the screen shows as one row. */
export interface PasteMark {
  /** First line of the pasted block. */
  at: number;
  /** How many lines it covers. */
  count: number;
}

export interface ComposerState {
  lines: string[];
  /** 0-based line the cursor is on. */
  line: number;
  /** 0-based **code point** offset within that line. */
  column: number;
  pastes: PasteMark[];
  /** Newest last, capped at `UNDO_LIMIT`. */
  history: ComposerSnapshot[];
}

export type ComposerSnapshot = Pick<ComposerState, 'lines' | 'line' | 'column' | 'pastes'>;

/** The code points of a string, so every index below is one the cursor can sit on. */
const points = (text: string): string[] => [...text];

const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));

export function emptyComposer(): ComposerState {
  return { lines: [''], line: 0, column: 0, pastes: [], history: [] };
}

/** A composer holding `text`, cursor at the end — where a draft is picked back up. */
export function composerFromText(text: string): ComposerState {
  const lines = text.split('\n');
  const last = lines.length - 1;
  return { lines, line: last, column: points(lines[last] ?? '').length, pastes: [], history: [] };
}

export function composerText(state: ComposerState): string {
  return state.lines.join('\n');
}

export function isEmpty(state: ComposerState): boolean {
  return composerText(state).trim() === '';
}

/** The state without its history, for the undo stack. */
const snapshot = (state: ComposerState): ComposerSnapshot => ({ lines: state.lines, line: state.line, column: state.column, pastes: state.pastes });

/**
 * The next state of an edit, with the one before it pushed onto the undo stack.
 *
 * Every mutation goes through here, so "undo goes back one edit" is true by construction rather than by
 * each function remembering to say so.
 */
function edited(state: ComposerState, next: ComposerSnapshot): ComposerState {
  const history = [...state.history, snapshot(state)].slice(-UNDO_LIMIT);
  return { ...next, history };
}

/**
 * Paste marks after an edit at `line` that added `delta` lines.
 *
 * A mark whose block was typed into stops being a paste: it is the operator's text now, and drawing it
 * collapsed would hide what they just wrote. Marks below the edit move with it.
 *
 * `appending` is the one exception, and it is the common case: the cursor sits at the end of the last
 * pasted line — where a paste leaves it — and the operator carries on typing. That is writing *after* the
 * block, not into it, and expanding a thousand rows because someone typed the next word would make the
 * collapse useless exactly when it matters most.
 */
function adjustMarks(pastes: PasteMark[], line: number, delta: number, appending = false): PasteMark[] {
  const kept: PasteMark[] = [];
  for (const mark of pastes) {
    const inside = line >= mark.at && line < mark.at + mark.count;
    if (inside && !(appending && line === mark.at + mark.count - 1)) continue;
    kept.push(line < mark.at ? { at: mark.at + delta, count: mark.count } : mark);
  }
  return kept;
}

/** True when the cursor is at the end of the last line of a pasted block, so an edit there appends to it. */
function appendingAfterBlock(state: ComposerState): boolean {
  if (state.column !== points(state.lines[state.line] ?? '').length) return false;
  return state.pastes.some((m) => state.line === m.at + m.count - 1);
}

/** Cursor moves; they record no history, because a move is not an edit. */
const moved = (state: ComposerState, line: number, column: number): ComposerState => ({ ...state, line, column });

export function moveLeft(state: ComposerState): ComposerState {
  if (state.column > 0) return moved(state, state.line, state.column - 1);
  if (state.line === 0) return state;
  return moved(state, state.line - 1, points(state.lines[state.line - 1] ?? '').length);
}

export function moveRight(state: ComposerState): ComposerState {
  const width = points(state.lines[state.line] ?? '').length;
  if (state.column < width) return moved(state, state.line, state.column + 1);
  if (state.line >= state.lines.length - 1) return state;
  return moved(state, state.line + 1, 0);
}

export function moveUp(state: ComposerState): ComposerState {
  if (state.line === 0) return moved(state, 0, 0);
  const line = state.line - 1;
  return moved(state, line, clamp(state.column, points(state.lines[line] ?? '').length));
}

export function moveDown(state: ComposerState): ComposerState {
  if (state.line >= state.lines.length - 1) return moved(state, state.line, points(state.lines[state.line] ?? '').length);
  const line = state.line + 1;
  return moved(state, line, clamp(state.column, points(state.lines[line] ?? '').length));
}

export function moveHome(state: ComposerState): ComposerState {
  return moved(state, state.line, 0);
}

export function moveEnd(state: ComposerState): ComposerState {
  return moved(state, state.line, points(state.lines[state.line] ?? '').length);
}

const isWord = (ch: string | undefined): boolean => ch !== undefined && !/\s/u.test(ch);

/** The column a word-left move lands on: over the whitespace before the cursor, then over the word. */
export function wordLeftColumn(line: string, column: number): number {
  const cp = points(line);
  let at = column;
  while (at > 0 && !isWord(cp[at - 1])) at--;
  while (at > 0 && isWord(cp[at - 1])) at--;
  return at;
}

export function wordRightColumn(line: string, column: number): number {
  const cp = points(line);
  let at = column;
  while (at < cp.length && isWord(cp[at])) at++;
  while (at < cp.length && !isWord(cp[at])) at++;
  return at;
}

export function wordLeft(state: ComposerState): ComposerState {
  if (state.column === 0) return moveLeft(state);
  return moved(state, state.line, wordLeftColumn(state.lines[state.line] ?? '', state.column));
}

export function wordRight(state: ComposerState): ComposerState {
  const width = points(state.lines[state.line] ?? '').length;
  if (state.column === width) return moveRight(state);
  return moved(state, state.line, wordRightColumn(state.lines[state.line] ?? '', state.column));
}

/** Replace the current line and put the cursor at `column`. */
function withLine(state: ComposerState, text: string, column: number): ComposerSnapshot {
  const lines = [...state.lines];
  lines[state.line] = text;
  return { lines, line: state.line, column, pastes: adjustMarks(state.pastes, state.line, 0, appendingAfterBlock(state)) };
}

/** Insert typed text at the cursor. Newlines in it are honoured, so one path handles `\r\n` too. */
export function insertText(state: ComposerState, text: string): ComposerState {
  if (text === '') return state;
  const normalized = text.replace(/\r\n?/g, '\n');
  const cp = points(state.lines[state.line] ?? '');
  const before = cp.slice(0, state.column).join('');
  const after = cp.slice(state.column).join('');
  const parts = normalized.split('\n');
  if (parts.length === 1) return edited(state, withLine(state, `${before}${parts[0]}${after}`, state.column + points(parts[0]!).length));
  const appending = appendingAfterBlock(state);
  const lines = [...state.lines];
  const inserted = [`${before}${parts[0]}`, ...parts.slice(1, -1), `${parts[parts.length - 1]}${after}`];
  lines.splice(state.line, 1, ...inserted);
  const line = state.line + parts.length - 1;
  return edited(state, {
    lines,
    line,
    column: points(parts[parts.length - 1]!).length,
    pastes: adjustMarks(state.pastes, state.line, parts.length - 1, appending),
  });
}

/**
 * A bracketed paste `[D16]`: the bytes go in verbatim, and a block over `PASTE_COLLAPSE_LINES` lines is
 * marked so the screen can show it as one row instead of scrolling the composer off the panel.
 *
 * A paste that lands at the end of a block that is already collapsed **grows that block** rather than
 * starting a second mark inside it. `composerRows` walks the outer mark and skips every line it covers, so
 * a mark that begins inside another is a mark the screen never reaches - which is how a second thousand-line
 * paste ended up drawn one row per line, exactly where the collapse matters most. Pasting twice is what an
 * operator does when a message takes two trips to the clipboard, and the cursor sits at the end of the first
 * block when they do.
 */
export function insertPaste(state: ComposerState, text: string): ComposerState {
  const startLine = state.line;
  const next = insertText(state, text);
  const count = next.line - startLine + 1;
  if (count <= PASTE_COLLAPSE_LINES) return next;
  // The first line of the paste joins the block's existing last line, so only the rest are new rows.
  const enclosing = next.pastes.find((mark) => startLine >= mark.at && startLine < mark.at + mark.count);
  if (enclosing) {
    const grown: PasteMark = { at: enclosing.at, count: enclosing.count + count - 1 };
    return { ...next, pastes: next.pastes.map((mark) => (mark === enclosing ? grown : mark)) };
  }
  return { ...next, pastes: [...next.pastes, { at: startLine, count }] };
}

export function insertNewline(state: ComposerState): ComposerState {
  return insertText(state, '\n');
}

export function backspace(state: ComposerState): ComposerState {
  if (state.column > 0) {
    const cp = points(state.lines[state.line] ?? '');
    return edited(state, withLine(state, [...cp.slice(0, state.column - 1), ...cp.slice(state.column)].join(''), state.column - 1));
  }
  if (state.line === 0) return state;
  const previous = state.lines[state.line - 1] ?? '';
  const lines = [...state.lines];
  const joined = `${previous}${lines[state.line] ?? ''}`;
  lines.splice(state.line - 1, 2, joined);
  return edited(state, { lines, line: state.line - 1, column: points(previous).length, pastes: adjustMarks(state.pastes, state.line - 1, -1) });
}

export function deleteForward(state: ComposerState): ComposerState {
  const cp = points(state.lines[state.line] ?? '');
  if (state.column < cp.length) {
    return edited(state, withLine(state, [...cp.slice(0, state.column), ...cp.slice(state.column + 1)].join(''), state.column));
  }
  if (state.line >= state.lines.length - 1) return state;
  const lines = [...state.lines];
  lines.splice(state.line, 2, `${lines[state.line] ?? ''}${lines[state.line + 1] ?? ''}`);
  return edited(state, { lines, line: state.line, column: state.column, pastes: adjustMarks(state.pastes, state.line, -1) });
}

export function deleteWordLeft(state: ComposerState): ComposerState {
  if (state.column === 0) return backspace(state);
  const cp = points(state.lines[state.line] ?? '');
  const to = wordLeftColumn(state.lines[state.line] ?? '', state.column);
  return edited(state, withLine(state, [...cp.slice(0, to), ...cp.slice(state.column)].join(''), to));
}

/** Undo the last edit. Cursor moves are not edits, so this always goes back to a different text. */
export function undo(state: ComposerState): ComposerState {
  const previous = state.history[state.history.length - 1];
  if (!previous) return state;
  return { ...previous, history: state.history.slice(0, -1) };
}

/** Replace the whole buffer, e.g. after `$EDITOR` wrote it back. Undoable like any other edit. */
export function replaceAll(state: ComposerState, text: string): ComposerState {
  const next = composerFromText(text);
  return edited(state, { lines: next.lines, line: next.line, column: next.column, pastes: [] });
}

/** One row as the composer draws it: a line of the buffer, or a collapsed paste standing in for many. */
export interface ComposerRow {
  text: string;
  /** How many buffer lines this row stands for; 1 for an ordinary line. */
  covers: number;
  collapsed?: boolean;
}

/**
 * The rows to draw, with each long paste standing in for its block `[D16]`.
 *
 * A block stays collapsed even while the cursor is on it — which it is the instant after a paste. Editing
 * *into* it is what expands it, and that is decided when the edit happens (`adjustMarks`), not when the
 * frame is drawn: a block that expanded merely because the cursor passed over it would make scrolling
 * through a long message jump by a thousand rows.
 */
export function composerRows(state: ComposerState): ComposerRow[] {
  const rows: ComposerRow[] = [];
  for (let i = 0; i < state.lines.length; ) {
    const mark = state.pastes.find((m) => m.at === i);
    if (mark) {
      rows.push({ text: `[pasted ${mark.count} lines]`, covers: mark.count, collapsed: true });
      i += mark.count;
      continue;
    }
    rows.push({ text: state.lines[i] ?? '', covers: 1 });
    i += 1;
  }
  return rows;
}

/** Which of `composerRows` holds the cursor. */
export function cursorRow(state: ComposerState): number {
  let line = 0;
  for (const [index, row] of composerRows(state).entries()) {
    if (state.line < line + row.covers) return index;
    line += row.covers;
  }
  return Math.max(0, composerRows(state).length - 1);
}

/** The current line split at the cursor, for drawing the caret in the right place. */
export function splitAtCursor(state: ComposerState): { before: string; at: string; after: string } {
  const cp = points(state.lines[state.line] ?? '');
  return {
    before: cp.slice(0, state.column).join(''),
    at: cp[state.column] ?? ' ',
    after: cp.slice(state.column + 1).join(''),
  };
}
