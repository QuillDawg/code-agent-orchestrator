/**
 * The composer's buffer (spec §3.2, §3.5; `[D14]`, `[D16]`).
 *
 * Every edit is a pure function, so these are asserted directly rather than through a rendered frame: a
 * cursor that walks into the middle of an emoji is invisible in a screenshot and obvious here.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PASTE_COLLAPSE_LINES,
  UNDO_LIMIT,
  backspace,
  composerFromText,
  composerRows,
  composerText,
  cursorRow,
  deleteForward,
  deleteWordLeft,
  emptyComposer,
  insertNewline,
  insertPaste,
  insertText,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  replaceAll,
  splitAtCursor,
  undo,
  wordLeft,
  wordRight,
  type ComposerState,
} from '../../src/tui/composer.js';
import { editPromptExternally } from '../../src/tui/workspace/prompt-editor.js';

const FAKE_EDITOR = `node ${path.resolve(fileURLToPath(new URL('../fixtures/fake-editor.mjs', import.meta.url)))}`;

/** Type a string one code point at a time, the way `useInput` delivers it. */
const type = (state: ComposerState, text: string): ComposerState => [...text].reduce((s, ch) => insertText(s, ch), state);

describe('the composer buffer', () => {
  it('starts empty and takes typed text', () => {
    const state = type(emptyComposer(), 'also update the changelog');
    expect(composerText(state)).toBe('also update the changelog');
    expect(state.line).toBe(0);
    expect(state.column).toBe(25);
  });

  it('counts the cursor in code points, so a move never lands inside an astral character', () => {
    // Two astral code points among plain ones: the string is 7 UTF-16 units and 5 code points.
    const text = '🙂a👍éx';
    const state = composerFromText(text);
    expect(state.column).toBe([...text].length);
    expect(state.column).toBeLessThan(text.length);

    // Left off the end lands before `x`, not inside the surrogate pair before it.
    const left = moveLeft(state);
    expect(splitAtCursor(left).at).toBe('x');

    // Backspacing over an emoji removes the whole thing rather than half of it.
    let at = composerFromText('ok 👍');
    at = backspace(at);
    expect(composerText(at)).toBe('ok ');
    expect([...composerText(at)]).toHaveLength(3);
  });

  it('moves by word, to the ends of a line, and between lines', () => {
    const state = composerFromText('first line here\nsecond line');
    expect(state.line).toBe(1);

    const home = moveHome(state);
    expect(home.column).toBe(0);
    expect(moveEnd(home).column).toBe('second line'.length);

    const up = moveUp(moveEnd(home));
    expect(up.line).toBe(0);
    // The column is clamped to the shorter line rather than pointing past its end.
    expect(up.column).toBeLessThanOrEqual('first line here'.length);

    const wordBack = wordLeft(wordLeft(moveEnd(moveUp(state))));
    expect(splitAtCursor(wordBack).before).toBe('first ');
    expect(wordRight(wordBack).column).toBe('first line '.length);

    // Left at the start of a line wraps to the end of the one above, and right wraps back.
    const wrapped = moveLeft(moveHome(state));
    expect(wrapped.line).toBe(0);
    expect(wrapped.column).toBe('first line here'.length);
    expect(moveRight(wrapped)).toMatchObject({ line: 1, column: 0 });
    expect(moveDown(state).column).toBe('second line'.length);
  });

  it('joins and splits lines with backspace, delete and a newline', () => {
    let state = type(emptyComposer(), 'one');
    state = insertNewline(state);
    state = type(state, 'two');
    expect(composerText(state)).toBe(`one${String.fromCharCode(10)}two`);
    expect(state.lines).toHaveLength(2);

    state = backspace(moveHome(state));
    expect(composerText(state)).toBe('onetwo');
    expect(state).toMatchObject({ line: 0, column: 3 });

    state = deleteForward(state);
    expect(composerText(state)).toBe('onewo');

    state = deleteWordLeft(moveEnd(state));
    expect(composerText(state)).toBe('');
  });

  it('undoes the last edit and nothing else, up to a hundred of them', () => {
    let state = type(emptyComposer(), 'abc');
    // A cursor move is not an edit: undoing after one still goes back to the text before the last keystroke.
    state = moveLeft(state);
    expect(composerText(undo(state))).toBe('ab');

    let many = emptyComposer();
    for (let i = 0; i < UNDO_LIMIT + 20; i++) many = insertText(many, 'x');
    expect(many.history).toHaveLength(UNDO_LIMIT);
    let walked = many;
    for (let i = 0; i < UNDO_LIMIT; i++) walked = undo(walked);
    // Everything inside the window comes back; what fell out of it does not, and undo stops rather than throwing.
    expect(composerText(walked)).toBe('x'.repeat(20));
    expect(composerText(undo(walked))).toBe('x'.repeat(20));
  });

  it('keeps a long paste byte for byte and shows it as one row', () => {
    const short = Array.from({ length: PASTE_COLLAPSE_LINES }, (_, i) => `line ${i + 1}`).join(String.fromCharCode(10));
    const shortState = insertPaste(emptyComposer(), short);
    expect(shortState.pastes).toEqual([]);
    expect(composerRows(shortState)).toHaveLength(PASTE_COLLAPSE_LINES);

    // One more line than the threshold is the first that collapses (§3.5, `[D16]`).
    const long = Array.from({ length: PASTE_COLLAPSE_LINES + 1 }, (_, i) => `line ${i + 1}`).join(String.fromCharCode(10));
    const state = insertPaste(emptyComposer(), long);
    expect(composerText(state)).toBe(long);
    expect(state.lines).toHaveLength(PASTE_COLLAPSE_LINES + 1);

    const rows = composerRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: `[pasted ${PASTE_COLLAPSE_LINES + 1} lines]`, covers: PASTE_COLLAPSE_LINES + 1, collapsed: true });
    // The cursor is on that row, where the paste left it, rather than nowhere on screen.
    expect(cursorRow(state)).toBe(0);

    // Typing on after a paste is writing after the block, not into it: it stays one row.
    const after = insertText(state, '!');
    expect(composerRows(after).filter((r) => r.collapsed)).toHaveLength(1);
    // A rebuilt buffer (a draft read back from the store) has no marks at all; nothing is hidden by surprise.
    expect(composerRows(moveHome(composerFromText(composerText(state))))).toHaveLength(PASTE_COLLAPSE_LINES + 1);
  });

  it('keeps a thousand-line paste whole, including its blank lines and trailing spaces', () => {
    const huge = Array.from({ length: 1000 }, (_, i) => (i % 7 === 0 ? '' : `line ${i} with trailing space `)).join(String.fromCharCode(10));
    const state = insertPaste(emptyComposer(), huge);
    expect(composerText(state)).toBe(huge);
    expect(Buffer.byteLength(composerText(state))).toBe(Buffer.byteLength(huge));
    expect(state.lines).toHaveLength(1000);
    // One row on screen, a thousand in the buffer: the point of the collapse.
    expect(composerRows(state)).toEqual([{ text: '[pasted 1000 lines]', covers: 1000, collapsed: true }]);
    // And a newline after it still leaves the block whole, with the new line beneath it.
    const continued = insertNewline(state);
    expect(composerRows(continued)).toHaveLength(2);
    expect(continued.lines).toHaveLength(1001);
    expect(composerText(continued).startsWith(huge)).toBe(true);
  });

  it('stops collapsing a pasted block once it has been typed into', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(String.fromCharCode(10));
    let state = insertPaste(emptyComposer(), long);
    state = { ...state, line: 5, column: 0 };
    state = insertText(state, '!');
    expect(state.pastes).toEqual([]);
    expect(composerRows(state).some((r) => r.collapsed)).toBe(false);
  });

  it('collapses a second paste that lands at the end of the first, rather than drawing it line by line', () => {
    // What an operator does when they build a message out of two clipboard trips: paste, then paste again
    // where the first one left the cursor - on the last line of a block that is already collapsed. The
    // second mark used to start *inside* the first, which `composerRows` walks straight past, so a thousand
    // pasted lines were drawn one per row and the panel filled with them (`[D16]`).
    const first = Array.from({ length: 50 }, (_, i) => `first ${i + 1}`).join(String.fromCharCode(10));
    const second = Array.from({ length: 1000 }, (_, i) => `second ${i + 1}`).join(String.fromCharCode(10));
    let state = insertPaste(emptyComposer(), first);
    expect(composerRows(state)).toEqual([{ text: '[pasted 50 lines]', covers: 50, collapsed: true }]);

    state = insertPaste(state, second);
    // Every byte of both is still in the buffer.
    expect(state.lines).toHaveLength(1049);
    expect(composerText(state).endsWith('second 1000')).toBe(true);
    // And the screen is one row, not a thousand and forty-nine.
    const rows = composerRows(state);
    expect(rows.filter((row) => !row.collapsed)).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.covers).toBe(1049);
    expect(cursorRow(state)).toBe(0);
  });

  it('normalizes CRLF so a Windows paste does not leave carriage returns in the message', () => {
    const state = insertPaste(emptyComposer(), 'one\r\ntwo\r\nthree');
    expect(composerText(state)).toBe(['one', 'two', 'three'].join(String.fromCharCode(10)));
    expect(composerText(state)).not.toContain('\r');
  });

  it('replaces the whole buffer and can be undone back to the draft', () => {
    const state = replaceAll(composerFromText('draft'), 'from the editor');
    expect(composerText(state)).toBe('from the editor');
    expect(composerText(undo(state))).toBe('draft');
  });
});

describe('Ctrl+O: the draft through $VISUAL / $EDITOR (§3.2, `[D14]`)', () => {
  it('round-trips the text the editor wrote back', async () => {
    const result = await editPromptExternally('also update the changelog', {
      env: { VISUAL: FAKE_EDITOR },
      suspend: async (action) => action(),
    });
    expect(result.text).toBe(`also update the changelog${String.fromCharCode(10)}edited by the fake editor`);
    expect(composerText(replaceAll(composerFromText('also update the changelog'), result.text!))).toContain('fake editor');
  });

  it('leaves the draft alone when the editor fails, and says so', async () => {
    const result = await editPromptExternally('keep me', {
      env: { VISUAL: FAKE_EDITOR, CAO_FAKE_EDITOR_EXIT: '3' } as NodeJS.ProcessEnv,
      suspend: async (action) => action(),
      run: async (file, args) => {
        const { execa } = await import('execa');
        const res = await execa(file, args, { reject: false, env: { CAO_FAKE_EDITOR_EXIT: '3' } });
        return res.exitCode ?? 1;
      },
    });
    expect(result.text).toBeUndefined();
    expect(result.notice).toContain('exited 3');
  });

  it('says what to set when neither $VISUAL nor $EDITOR is set', async () => {
    const result = await editPromptExternally('anything', { env: {} });
    expect(result.text).toBeUndefined();
    expect(result.notice).toContain('$VISUAL');
  });
});
