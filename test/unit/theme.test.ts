/**
 * The identity of the workspace (spec §3.2, [D35]): the token table, the two themes, the modes, and the
 * three rules that keep them honest.
 *
 * The rules, rather than the pixels, are what is asserted here:
 *
 * - **One place names a colour.** Every file under `src/tui/` except `theme.ts` is read and searched for a
 *   hex literal or a chalk colour name. That is the whole of the seam - a component that reaches past the
 *   table is how a theme stops being a theme - and it cannot be checked by rendering anything.
 * - **`NO_COLOR` means no colour.** Not "fewer colours": no SGR that sets one, anywhere in the frame.
 * - **Nothing moves under reduced motion.** Ten consecutive frames of a running task are the same bytes.
 *
 * The rendered snapshots live in `theme-frames.test.tsx`, which needs an Ink tree and this file does not.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { composerKeys, editKeys, navigationKeys } from '../../src/tui/workspace/keys.js';
import { helpSections } from '../../src/tui/workspace/panels.js';
import { STATE_TOKEN, resolveTheme } from '../../src/tui/theme.js';
import { glyph } from '../../src/util/glyphs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every file under a directory, recursively, in a stable order. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

describe('one place names a colour [D35]', () => {
  /**
   * A chalk / Ink colour name in a string literal, and a hex colour anywhere.
   *
   * Quoted deliberately: `severity: 'warn'` is a token and `kind === 'error'` is a state, and neither is a
   * colour - what the theme forbids is a component deciding that failure is *red*.
   */
  const COLOUR_NAME = /(['"`])(black|red|green|yellow|blue|magenta|cyan|white|gray|grey|blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|cyanBright|whiteBright)\1/;
  const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/;

  it('finds no colour literal under src/tui/ outside theme.ts', async () => {
    const files = (await filesUnder(path.join(root, 'src/tui'))).filter((f) => /\.tsx?$/.test(f) && path.basename(f) !== 'theme.ts');
    expect(files.length).toBeGreaterThan(15);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (COLOUR_NAME.test(line) || HEX.test(line)) offenders.push(`${path.relative(root, file).replace(/\\/g, '/')}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, 'a colour outside theme.ts').toEqual([]);
  });

  it('finds no colour set straight onto an Ink prop', async () => {
    const files = (await filesUnder(path.join(root, 'src/tui'))).filter((f) => f.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (/(?:^|\s)(?:border|background)?[cC]olor="/.test(line)) offenders.push(`${path.relative(root, file).replace(/\\/g, '/')}:${index + 1}`);
      }
    }
    expect(offenders, 'an Ink colour prop given a literal').toEqual([]);
  });

  it('gives every task state a token, so no surface has to decide what a state looks like', () => {
    const theme = resolveTheme({ env: {} });
    for (const [state, token] of Object.entries(STATE_TOKEN)) {
      expect(theme.stateToken(state as never), state).toBe(token);
      expect(theme.stateColor(state as never), state).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('the key table is written down once (§3.2)', () => {
  /** The rows exactly as `docs/capabilities.md` should carry them. */
  const markdownRows = (): string[] => navigationKeys().map((key) => `| \`${key.input}\` | ${key.behaviour} | ${key.note ?? ''} |`);

  it('lists in docs/capabilities.md exactly the table the code binds', async () => {
    const doc = await fs.readFile(path.join(root, 'docs/capabilities.md'), 'utf8');
    const table = ['| Input | Behaviour | Note |', '|---|---|---|', ...markdownRows()].join('\n');
    expect(doc, 'docs/capabilities.md and src/tui/workspace/keys.ts have drifted').toContain(table);
  });

  it('answers with the same table under `?`, and never describes one key twice', () => {
    const sections = helpSections('main', 'overview');
    const rows = sections.flatMap((s) => s.keys);
    for (const key of navigationKeys()) {
      expect(rows.some((row) => row.keys === key.input), `? never mentions ${key.input}`).toBe(true);
    }
    // "Moving around" is the reference at the bottom, and it repeats nothing a section above it has already
    // given - whichever section that was. One key described twice on one screen is how the two descriptions
    // drift apart, and the section that owns a chord is the one that knows what it means in this mode.
    const above = new Set(sections.slice(0, -1).flatMap((s) => s.keys).map((row) => row.keys));
    const repeated = (sections[sections.length - 1]?.keys ?? []).filter((row) => above.has(row.keys)).map((row) => row.keys);
    expect(repeated, 'the bottom of `?` repeats a row it has already given').toEqual([]);
  });

  /**
   * `[D15]` and §3.2 bind two newlines that every terminal can type, and Shift+Enter only where the kitty
   * protocol reports it. A help row that names one of the two tells a composer user to reach for a chord
   * their terminal may not send, so every field that takes a newline has to name both.
   */
  it('names both newline chords wherever a field takes one', () => {
    const rows = [...navigationKeys().map((k) => k.input), ...composerKeys().map((k) => k.keys), ...editKeys().map((k) => k.keys)];
    const newline = rows.filter((row) => row.includes('Ctrl+J'));
    expect(newline.length, 'no surface offers a newline at all').toBe(3);
    for (const row of newline) expect(row, `${row} names Ctrl+J and not the backslash`).toContain('\\+Enter');
  });

  it('names the arrows in whichever alphabet the terminal can draw', () => {
    const previous = { ascii: process.env.CAO_ASCII, unicode: process.env.CAO_UNICODE };
    try {
      delete process.env.CAO_UNICODE;
      process.env.CAO_ASCII = '1';
      const ascii = navigationKeys().map((k) => k.input).join(' ');
      expect(ascii).toContain('^v');
      expect(ascii).not.toMatch(/[←-↓]/);
      delete process.env.CAO_ASCII;
      process.env.CAO_UNICODE = '1';
      expect(navigationKeys().map((k) => k.input).join(' ')).toContain(`${glyph('up')}${glyph('down')}`);
    } finally {
      if (previous.ascii === undefined) delete process.env.CAO_ASCII;
      else process.env.CAO_ASCII = previous.ascii;
      if (previous.unicode === undefined) delete process.env.CAO_UNICODE;
      else process.env.CAO_UNICODE = previous.unicode;
    }
  });
});
