/**
 * The pieces the workspace shell is built from, tested without mounting anything: the windowing rule every
 * list shares [D9], the row and column budget each panel is given (§2.5), the theme token table [D35], the
 * alternate-screen decision [D4] and the palette's matcher [D12].
 *
 * These are the parts where "the frame is never taller than the terminal" is actually decided, so they are
 * asserted on directly rather than only through a rendered frame, which can only ever cover the sizes the
 * test happened to pick.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { tmpDir } from '../helpers/index.js';
import { windowOf, scrollbarColumn } from '../../src/tui/window.js';
import { workspaceLayout, footerColumnsFor } from '../../src/tui/workspace/layout.js';
import { alwaysHints, footerHints, panelHelp, globalKeys, viewerKeys, type KeyMode } from '../../src/tui/workspace/keys.js';
import { filterPalette, helpSections, PLACEHOLDER_TEXT, reportLines, wrapLines, type PaletteEntry } from '../../src/tui/workspace/panels.js';
import { attentionBadge, fitCells, headerRowsFor, progressSegments, ruleLine } from '../../src/tui/workspace/chrome.js';
import { trimToRows } from '../../src/tui/workspace/overview.js';
import { resolveTheme, reducedMotion, isThemeName, themeFor, themeNameOf, THEME_NAMES, STATE_TOKEN } from '../../src/tui/theme.js';
import { sgrColor, stripAnsi } from '../../src/cli/color.js';
import { altScreenEnabled, readUserConfig, BASE_RENDER_OPTIONS, workspaceRenderOptions } from '../../src/tui/render-options.js';
import { WORKSPACE_TABS } from '../../src/tui/store.js';

const ESC = String.fromCharCode(27);
/** Any SGR that sets a colour: the sixteen, the 256-colour cube and truecolor, foreground or background. */
const SGR_COLOUR = new RegExp(`${ESC}\\[[0-9;]*?(3[0-7]|4[0-7]|9[0-7]|10[0-7]|[34]8;[25];)`);
/** Every token the table has; derived from the state map plus the names the components ask for. */
const THEME_TOKENS = [
  'accent',
  'accent2',
  'ok',
  'warn',
  'danger',
  'muted',
  'text',
  'border',
  'borderFocused',
  'badgeBg',
  'selection',
  'progress',
  'title',
  'key',
  'tabActive',
  'tabIdle',
  'agent',
  ...Object.values(STATE_TOKEN),
] as const;

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `task-${i + 1}`);

describe('windowOf', () => {
  it('never returns more rows than it was given, whatever the cursor is', () => {
    const items = ids(200);
    for (const cursor of [0, 1, 99, 198, 199]) {
      const slice = windowOf(items, cursor, 12);
      expect(slice.items).toHaveLength(12);
      expect(slice.scrollbar).toHaveLength(12);
      expect(slice.above + slice.items.length + slice.below).toBe(200);
    }
  });

  it('keeps the cursor on screen and stops at both ends of the list', () => {
    const items = ids(50);
    expect(windowOf(items, 0, 10).start).toBe(0);
    expect(windowOf(items, 49, 10).start).toBe(40);
    const middle = windowOf(items, 25, 10);
    expect(middle.start).toBeLessThanOrEqual(25);
    expect(middle.start + middle.items.length).toBeGreaterThan(25);
  });

  it('says how much is off screen, in both directions', () => {
    const slice = windowOf(ids(30), 15, 5);
    expect(slice.aboveMarker).toMatch(/1[0-9] more$/);
    expect(slice.belowMarker).toMatch(/[0-9]+ more$/);
    expect(windowOf(ids(3), 0, 10).aboveMarker).toBeUndefined();
    expect(windowOf(ids(3), 0, 10).belowMarker).toBeUndefined();
  });

  it('scrolls from an anchor instead of centring when the caller keeps one', () => {
    const items = ids(50);
    // The window stays where it was while the cursor is inside it...
    expect(windowOf(items, 3, 10, { anchor: 0 }).start).toBe(0);
    // ...and moves by exactly the rows needed when it is not.
    expect(windowOf(items, 12, 10, { anchor: 0 }).start).toBe(3);
    expect(windowOf(items, 1, 10, { anchor: 5 }).start).toBe(1);
  });

  it('survives an empty list, no rows and a cursor past the end', () => {
    expect(windowOf([], 0, 10).items).toEqual([]);
    expect(windowOf(ids(5), 0, 0).items).toEqual([]);
    expect(windowOf(ids(5), 99, 3).items).toHaveLength(3);
  });

  it('draws a scrollbar that is all thumb when the list fits and moves when it does not', () => {
    expect(new Set(scrollbarColumn(3, 0, 3)).size).toBe(1);
    const top = scrollbarColumn(100, 0, 10);
    const bottom = scrollbarColumn(100, 90, 10);
    expect(top[0]).not.toBe(top[9]);
    expect(bottom[9]).not.toBe(bottom[0]);
    expect(top[0]).toBe(bottom[9]);
  });
});

describe('workspace layout', () => {
  const at = (columns: number, rows: number) => workspaceLayout({ columns, rows, headerRows: 2, notice: false });

  it('collapses the sidebar into a one-line strip on a small terminal', () => {
    const small = at(80, 24);
    expect(small.compact).toBe(true);
    expect(small.sidebarWidth).toBe(0);
    expect(small.stripRows).toBe(1);
    const large = at(120, 40);
    expect(large.compact).toBe(false);
    expect(large.sidebarWidth).toBeGreaterThan(20);
    expect(large.stripRows).toBe(0);
  });

  it('spends every row once: header, tabs, rules, body and footer add up to the terminal', () => {
    // Swept rather than sampled, because the rules are the first thing given up as the terminal shrinks and
    // the row it happens on is exactly where an off-by-one would hide.
    for (const columns of [60, 80, 100, 120, 200]) {
      for (let rows = 6; rows <= 60; rows += 1) {
        for (const headerRows of [1, 2, 3]) {
          for (const notice of [false, true]) {
            const layout = workspaceLayout({ columns, rows, headerRows, notice });
            const chrome = layout.headerRows + layout.tabRows + layout.footerRows;
            const rules = (layout.topRule ? 1 : 0) + (layout.bottomRule ? 1 : 0);
            expect(chrome + rules + layout.bodyRows, `${columns}x${rows} overflowed`).toBeLessThanOrEqual(rows);
            // The strip and its rule come out of the body, not out of the terminal a second time.
            expect(layout.stripRows + (layout.stripRule ? 1 : 0) + layout.mainRows).toBeLessThanOrEqual(layout.bodyRows);
            expect(layout.mainRows).toBeGreaterThan(0);
            expect(layout.mainWidth).toBeLessThanOrEqual(columns);
          }
        }
      }
    }
  });

  it('gives the rules up before the last rows of the body', () => {
    // A fixed two-row cost is wrong on a terminal the header has already eaten: the rules are what goes.
    expect(workspaceLayout({ columns: 120, rows: 10, headerRows: 2, notice: false }).ruleRows).toBe(0);
    expect(workspaceLayout({ columns: 120, rows: 12, headerRows: 3, notice: true }).ruleRows).toBe(0);
    const bare = workspaceLayout({ columns: 120, rows: 10, headerRows: 2, notice: false });
    expect(bare.bodyRows).toBe(10 - 2 - 1 - 1);
  });

  it('draws no rule under a screen reader, for the reason the header collapses', () => {
    const reader = workspaceLayout({ columns: 120, rows: 40, headerRows: 1, notice: false, screenReader: true });
    const seeing = workspaceLayout({ columns: 120, rows: 40, headerRows: 1, notice: false });
    expect(reader.ruleRows).toBe(0);
    expect(reader.topRule).toBe(false);
    expect(reader.bottomRule).toBe(false);
    expect(reader.mainRows).toBeGreaterThan(seeing.mainRows);
  });

  it('spends the single compact rule under the task strip, not under the tab bar', () => {
    const small = workspaceLayout({ columns: 80, rows: 24, headerRows: 2, notice: false });
    expect(small.ruleRows).toBe(1);
    expect(small.stripRule).toBe(true);
    expect(small.topRule).toBe(false);
    expect(small.bottomRule).toBe(false);
    const large = workspaceLayout({ columns: 120, rows: 40, headerRows: 2, notice: false });
    expect(large.topRule).toBe(true);
    expect(large.bottomRule).toBe(true);
    expect(large.stripRule).toBe(false);
  });

  it('charges the sidebar seam to the panel, so the three add up to the terminal', () => {
    for (const columns of [100, 120, 200]) {
      const layout = workspaceLayout({ columns, rows: 40, headerRows: 2, notice: false });
      expect(layout.sidebarWidth + layout.gutterColumns + layout.mainWidth).toBe(columns);
    }
    // Collapsed, there is no seam to charge for.
    const compact = workspaceLayout({ columns: 80, rows: 24, headerRows: 2, notice: false });
    expect(compact.gutterColumns).toBe(0);
    expect(compact.mainWidth).toBe(80);
  });

  it('draws a rule exactly as wide as the frame, with the tee where the seam is, in both alphabets', () => {
    const previous = { ascii: process.env.CAO_ASCII, unicode: process.env.CAO_UNICODE };
    try {
      process.env.CAO_UNICODE = '1';
      delete process.env.CAO_ASCII;
      expect([...ruleLine(40)].length).toBe(40);
      expect([...ruleLine(40, { at: 12, kind: 'top' })][12]).toBe('┬');
      expect([...ruleLine(40, { at: 12, kind: 'bottom' })][12]).toBe('┴');
      // A join off the end is a plain rule rather than a throw or a short line.
      expect(ruleLine(40, { at: 99, kind: 'top' })).toBe(ruleLine(40));
      expect([...ruleLine(40, { at: 99, kind: 'top' })].length).toBe(40);

      delete process.env.CAO_UNICODE;
      process.env.CAO_ASCII = '1';
      expect([...ruleLine(40, { at: 12, kind: 'top' })][12]).toBe('+');
      expect([...ruleLine(40, { at: 12, kind: 'bottom' })][12]).toBe('+');
      expect([...ruleLine(40, { at: 12, kind: 'top' })].length).toBe(40);
    } finally {
      if (previous.ascii === undefined) delete process.env.CAO_ASCII;
      else process.env.CAO_ASCII = previous.ascii;
      if (previous.unicode === undefined) delete process.env.CAO_UNICODE;
      else process.env.CAO_UNICODE = previous.unicode;
    }
  });

  it('drops the footer freshness column before the quota chips, and never the run own number', () => {
    // The spend cell has no width gate of its own: `fitCells` decides whether it fits, which is the one
    // place that knows what else is on the line.
    expect(footerColumnsFor(120)).toEqual(['shortcuts', 'spend', 'quota', 'freshness']);
    expect(footerColumnsFor(80)).toEqual(['shortcuts', 'quota']);
    expect(footerColumnsFor(50)).toEqual(['shortcuts']);
  });

  it('gives a bar cell to every count that is not zero', () => {
    // Rounding alone gave a 200-task run with three done and one failed an entirely empty bar: 3/200 of 20
    // cells rounds to nothing, and so does 1/200 — the two facts the bar exists to show.
    expect(progressSegments([3, 1, 3], 200, 20)).toEqual([1, 1, 1]);
    expect(progressSegments([0, 0, 0], 200, 20)).toEqual([0, 0, 0]);
    // A whole run of successes fills it, and the three together never overflow the width.
    expect(progressSegments([200, 0, 0], 200, 20)).toEqual([20, 0, 0]);
    for (const counts of [
      [9, 9, 9],
      [1, 1, 18],
      [7, 7, 6],
      [1, 0, 1],
    ]) {
      const segments = progressSegments(counts, 20, 10);
      expect(segments.reduce((a, n) => a + n, 0), `${counts} overflowed`).toBeLessThanOrEqual(10);
      for (const [i, n] of counts.entries()) expect(segments[i]! > 0, `${counts} lost ${n}`).toBe(n > 0);
    }
  });

  it('gives the header its third row only when something is waiting for a human', () => {
    const run = (state: string) =>
      ({ workflow: { tasks: [{ id: 'a' }] }, tasks: { a: { state } } }) as never;
    expect(headerRowsFor(run('running'))).toBe(2);
    expect(headerRowsFor(run('waiting'))).toBe(3);
  });
});

describe('theme', () => {
  it('paints with the cyberpunk palette and with no colour at all under mono', () => {
    const colour = resolveTheme({ env: {} });
    expect(colour.name).toBe('cyberpunk');
    expect(colour.color).toBe(true);
    expect(colour.paint('failed', 'danger')).not.toBe('failed');
    expect(colour.stateColor('failed')).toMatch(/^#[0-9a-f]{6}$/i);

    const mono = resolveTheme({ theme: 'mono', env: {} });
    expect(mono.color).toBe(false);
    expect(mono.ink('accent')).toBeUndefined();
    expect(mono.inkBg('badgeBg')).toBeUndefined();
    expect(mono.stateColor('failed')).toBeUndefined();
    // Not "the same screen with the colour turned down": mono still has bold, dim and inverse, and no
    // colour of any kind, which is how focus and selection survive on a terminal that cannot paint.
    expect(mono.paint('failed', 'danger')).not.toBe('failed');
    expect(mono.paint('failed', 'danger')).not.toMatch(SGR_COLOUR);
    expect(mono.paint('row', 'selection')).not.toMatch(SGR_COLOUR);
    // Still *styled*: a selected row that is painted with nothing is a selection nobody can see, which is
    // what mono used to be - inverse is the only mark a terminal with no colour has left for it.
    expect(mono.paint('row', 'selection')).not.toBe('row');
    expect(stripAnsi(mono.paint('row', 'selection'))).toBe('row');
  });

  it('gives every token a value in both themes, and only theme.ts a colour', () => {
    const cyberpunk = resolveTheme({ env: {} });
    const mono = resolveTheme({ theme: 'mono', env: {} });
    for (const token of THEME_TOKENS) {
      expect(typeof cyberpunk.paint('x', token), token).toBe('string');
      expect(mono.paint('x', token), token).not.toMatch(SGR_COLOUR);
    }
    // The twelve §3.2 names are all there; the rest are the roles defined in terms of them.
    for (const token of ['accent', 'accent2', 'ok', 'warn', 'danger', 'muted', 'text', 'border', 'borderFocused', 'badgeBg', 'selection', 'progress'] as const) {
      expect(THEME_TOKENS).toContain(token);
    }
  });

  it('takes the theme from the flag, then the environment, then ~/.cao/config.json, then the default', () => {
    const stored = () => ({ theme: 'mono' });
    expect(resolveTheme({ theme: 'cyberpunk', env: { CAO_THEME: 'mono' }, config: stored }).name).toBe('cyberpunk');
    expect(resolveTheme({ env: { CAO_THEME: 'mono' }, config: () => ({ theme: 'cyberpunk' }) }).name).toBe('mono');
    expect(resolveTheme({ env: {}, config: stored }).name).toBe('mono');
    expect(resolveTheme({ env: {}, config: () => null }).name).toBe('cyberpunk');
    // A config that says something else entirely says nothing.
    expect(resolveTheme({ env: {}, config: () => ({ theme: 7 }) }).name).toBe('cyberpunk');
  });

  it('lets NO_COLOR and a terminal with no colour win over an explicit theme', () => {
    expect(resolveTheme({ theme: 'cyberpunk', env: { NO_COLOR: '1' } }).name).toBe('mono');
    expect(resolveTheme({ theme: 'cyberpunk', env: { TERM: 'dumb' } }).name).toBe('mono');
    expect(resolveTheme({ theme: 'cyberpunk', env: {}, level: 0 }).name).toBe('mono');
    expect(resolveTheme({ env: { CAO_THEME: 'mono' } }).name).toBe('mono');
    // A typo is not fatal: the run keeps its colours rather than stopping over a flag.
    expect(resolveTheme({ theme: 'nonsense', env: {} }).name).toBe('cyberpunk');
    expect(THEME_NAMES.every(isThemeName)).toBe(true);
    expect(isThemeName('default')).toBe(false);
    // `default` was this palette's name before stage 4 gave it one, and still reaches it.
    expect(themeNameOf('default')).toBe('cyberpunk');
    expect(themeNameOf('  MONO ')).toBe('mono');
    expect(themeNameOf(undefined)).toBeUndefined();
  });

  it('downsamples a hex colour to what the terminal can show, and paints nothing at level 0', () => {
    const violet = '#a855f7';
    expect(sgrColor(violet, 3)).toBe('38;2;168;85;247');
    expect(sgrColor(violet, 2)).toMatch(/^38;5;\d+$/);
    // The nearest of the sixteen, as a single parameter; and as a background ten codes higher.
    expect(sgrColor(violet, 1)).toBe('95');
    expect(sgrColor(violet, 1, true)).toBe('105');
    expect(sgrColor(violet, 0)).toBe('');
    expect(sgrColor('not a colour', 3)).toBe('');
    expect(resolveTheme({ env: {}, level: 1 }).paint('x', 'accent')).toContain('[95m');
  });

  it('paints nothing at all for a caller that was only told "no colour"', () => {
    // `cao logs` into a pipe: `false` has to mean the bytes it always produced, not mono's bold and dim.
    expect(themeFor(false).paint('x', 'danger')).toBe('x');
    expect(themeFor(false).paint('x', 'bold')).toBe('x');
    expect(themeFor(true).paint('x', 'danger')).not.toBe('x');
    // A caller that has a theme keeps it whatever the boolean says.
    const mono = resolveTheme({ theme: 'mono', env: {} });
    expect(themeFor(true, mono)).toBe(mono);
  });

  it('says which border a panel gets, and says it without colour too', () => {
    const cyberpunk = resolveTheme({ env: {} });
    expect(cyberpunk.border(true)).toEqual({ borderStyle: 'double', borderColor: cyberpunk.ink('borderFocused') });
    expect(cyberpunk.border(false)).toEqual({ borderStyle: 'round', borderColor: cyberpunk.ink('border') });
    const mono = resolveTheme({ theme: 'mono', env: {} });
    expect(mono.border(true).borderStyle).toBe('double');
    expect(mono.border(false).borderStyle).toBe('round');
    expect(mono.border(true).borderColor).toBeUndefined();
  });

  it('draws a border the ASCII alphabet can actually spell', () => {
    // cli-boxes spells 'round' and 'double' with box-drawing characters, so a terminal CAO_ASCII=1 was
    // chosen for drew mojibake around the palette, the quit prompt, the answer field and every modal. The
    // frame tests never open one, which is why nothing caught it.
    const previous = { ascii: process.env.CAO_ASCII, unicode: process.env.CAO_UNICODE };
    try {
      delete process.env.CAO_UNICODE;
      process.env.CAO_ASCII = '1';
      const theme = resolveTheme({ env: {} });
      expect(theme.border(true).borderStyle).toBe('classic');
      expect(theme.border(false).borderStyle).toBe('classic');
      // Focus still has to be visible, and under ASCII the colour is the only carrier left.
      expect(theme.border(true).borderColor).not.toBe(theme.border(false).borderColor);
    } finally {
      if (previous.ascii === undefined) delete process.env.CAO_ASCII;
      else process.env.CAO_ASCII = previous.ascii;
      if (previous.unicode === undefined) delete process.env.CAO_UNICODE;
      else process.env.CAO_UNICODE = previous.unicode;
    }
  });

  it('turns the animation off for reduced motion and for a terminal that cannot move the cursor', () => {
    expect(reducedMotion({})).toBe(false);
    expect(reducedMotion({ CAO_REDUCED_MOTION: '1' })).toBe(true);
    expect(reducedMotion({ CAO_REDUCED_MOTION: '0' })).toBe(false);
    expect(reducedMotion({ TERM: 'dumb' })).toBe(true);
  });
});

describe('alternate screen [D4]', () => {
  const home = process.env.CAO_HOME;
  afterEach(() => {
    if (home === undefined) delete process.env.CAO_HOME;
    else process.env.CAO_HOME = home;
  });

  it('is on by default and off for the flag, the environment and the config key, in that order', () => {
    expect(altScreenEnabled({ env: {}, config: () => null })).toBe(true);
    // The flag on this invocation beats everything the machine has been told.
    expect(altScreenEnabled({ flag: false, env: { CAO_ALT_SCREEN: '1' }, config: () => ({ altScreen: true }) })).toBe(false);
    expect(altScreenEnabled({ env: { CAO_ALT_SCREEN: '0' }, config: () => ({ altScreen: true }) })).toBe(false);
    expect(altScreenEnabled({ env: {}, config: () => ({ altScreen: false }) })).toBe(false);
    // A config that says nothing about it is not a config that says no.
    expect(altScreenEnabled({ env: {}, config: () => ({ emit: false }) })).toBe(true);
  });

  it('reads ~/.cao/config.json only if it is already there, and never creates it', async () => {
    const dir = path.join(await tmpDir('cao-altscreen-'), 'home');
    process.env.CAO_HOME = dir;
    expect(readUserConfig(dir)).toBeNull();
    // The point of the decision: a `cao` with emit off must not touch `~/.cao` to find out about a flag.
    await expect(fs.stat(dir)).rejects.toThrow();
    expect(altScreenEnabled({ env: {} })).toBe(true);
    await expect(fs.stat(dir)).rejects.toThrow();

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ protocol: 1, emit: false, altScreen: false }));
    expect(readUserConfig(dir)).toMatchObject({ altScreen: false });
    expect(altScreenEnabled({ env: {} })).toBe(false);

    // Nonsense in the file is not a crash on the first frame of a run.
    await fs.writeFile(path.join(dir, 'config.json'), '{ not json');
    expect(readUserConfig(dir)).toBeNull();
    expect(altScreenEnabled({ env: {} })).toBe(true);
  });

  it('carries the render options §2.5 names alongside it', () => {
    expect(BASE_RENDER_OPTIONS).toEqual({ incrementalRendering: true, exitOnCtrlC: false, patchConsole: false, kittyKeyboard: { mode: 'auto' } });
    expect(workspaceRenderOptions({ flag: false })).toEqual({ ...BASE_RENDER_OPTIONS, alternateScreen: false });
  });
});

describe('command palette [D12]', () => {
  const entry = (id: string, label = id): PaletteEntry => ({ id, label, run: () => undefined });
  const entries = [entry('tab:overview', 'Go to Overview'), entry('action:restart', 'Restart the selected task'), entry('implement-parser'), entry('review-and-merge')];

  it('keeps every entry in order for an empty query, so the actions are discoverable', () => {
    expect(filterPalette(entries, '').map((e) => e.id)).toEqual(entries.map((e) => e.id));
    expect(filterPalette(entries, '   ').map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('matches loosely on the label and on the id, and returns nothing for a query that matches nothing', () => {
    expect(filterPalette(entries, 'parser').map((e) => e.id)).toEqual(['implement-parser']);
    expect(filterPalette(entries, 'restart').map((e) => e.id)).toEqual(['action:restart']);
    // A subsequence rather than a substring: that is what makes a palette worth opening.
    expect(filterPalette(entries, 'ovrvw').map((e) => e.id)).toEqual(['tab:overview']);
    expect(filterPalette(entries, 'zzzzz')).toEqual([]);
  });
});

describe('the keys the footer and ? agree on', () => {
  it('names the focused panel and answers with its keys', () => {
    expect(panelHelp('tasks', 'overview').title).toBe('Tasks');
    expect(panelHelp('tabs', 'overview').title).toBe('Tabs');
    expect(panelHelp('main', 'report').title).toBe('Report');
    expect(panelHelp('main', 'changes').keys.some((k) => k.keys === 'O')).toBe(true);
  });

  it('puts every panel key in the footer line, and the chords that work anywhere in their own', () => {
    for (const tab of WORKSPACE_TABS) {
      const hints = footerHints('main', tab);
      // The Changes panel answers its own keys and reports them, so the footer is given them rather than
      // deriving them; `footerHints` with nothing passed has nothing to say about that tab.
      if (tab === 'changes') continue;
      for (const key of panelHelp('main', tab).keys) {
        // A key marked `footer: false` is documented rather than advertised: the footer is one row shared
        // with the provider chips, and it shed a quota reading for every key added to it.
        if (key.footer === false) expect(hints).not.toContain(`${key.keys} `);
        else expect(hints).toContain(key.keys);
      }
    }
    // Kept out of `footerHints` on purpose: the footer truncates the panel keys into what is left after
    // these, so the way out of the workspace is never the thing a narrow terminal drops.
    expect(alwaysHints('executing')).toContain('Ctrl+P palette');
    expect(alwaysHints('executing')).toContain('? help');
  });

  it('still documents a key it keeps off the footer, so nothing is merely hidden', () => {
    // The flag trades footer space for `?`; a key that fell out of both would just be gone.
    const suspend = panelHelp('tasks', 'overview').keys.find((k) => k.keys === 'Z');
    expect(suspend?.footer).toBe(false);
    expect(suspend?.what).toContain('suspend');
    expect(footerHints('tasks', 'overview')).not.toContain('Z ');
    const shown = helpSections('tasks', 'overview').flatMap((section) => section.keys.map((k) => k.keys));
    expect(shown).toContain('Z');
    expect(shown).toContain('P');
  });

  it('keeps the composer keys out of the Session footer and gives them their own section in ?', () => {
    // The composer's keys were listed under the Session panel so `?` could reach them - `?` cannot be
    // pressed inside a field, where it is text. But the footer reads the same list, so a Session panel with
    // no composer open advertised `Enter compose` and `Enter send` on one line: one key, two meanings, one
    // of them not true of the frame it was drawn on.
    const footer = footerHints('main', 'session');
    expect(footer).toContain('Enter compose');
    expect(footer).not.toContain('Enter send');
    expect(footer).not.toContain('Ctrl+F');
    expect(footer.match(/Enter /g) ?? []).toHaveLength(1);

    // `?` still answers "what can I press in the composer", in a section that says which field it means.
    const sections = helpSections('main', 'session');
    const composer = sections.find((section) => /composer/i.test(section.title));
    expect(composer, 'the composer has no section in ?').toBeDefined();
    expect(composer!.keys.map((k) => k.keys)).toContain('Ctrl+J or \\+Enter');
    expect(composer!.keys.map((k) => k.keys)).toContain('Ctrl+O');
    // And no other panel grows one.
    expect(helpSections('main', 'overview').some((s) => /composer/i.test(s.title))).toBe(false);

    // The reference table at the bottom of `?` leaves out whatever the sections above it have already
    // explained, and moving the composer keys into a section of their own must not put them back: `Ctrl+J`
    // and `Ctrl+O` are answered there in the words of the field they are pressed in.
    const reference = (sections.find((section) => /Moving around/.test(section.title))?.keys ?? []).map((key) => key.keys);
    expect(reference).not.toContain('Ctrl+J or \\+Enter');
    expect(reference).not.toContain('Ctrl+O');
  });

  it('gives up whole footer cells, least important first, and never the way out', () => {
    const cells = ['↑↓ select', 'Enter open', 'F / L follow', 'R restart', '/ search', 'Ctrl+P palette', '? help', 'Q quit', 'quota: stage 3', 'updated 4s ago'];
    // Display order above; drop order below: the chips, then the panel keys from the right, then the chords.
    const priority = [9, 8, 4, 3, 2, 1, 0, 5, 6, 7];
    expect(fitCells(cells, priority, 200)).toEqual(cells);
    const at120 = fitCells(cells, priority, 120);
    expect(at120.join('   ').length).toBeLessThanOrEqual(120);
    expect(at120).not.toContain('updated 4s ago');
    expect(at120).toContain('/ search');
    const at60 = fitCells(cells, priority, 60);
    expect(at60.join('   ').length).toBeLessThanOrEqual(60);
    // Whatever else goes, `? help` and the way out are the last two standing.
    expect(at60).toContain('? help');
    expect(at60).toContain('Q quit');
    // A cell is kept whole or not at all; nothing is cut in the middle to look like a shorter action.
    for (const cell of at60) expect(cells).toContain(cell);
    // Except when even the most important one does not fit, where something beats an empty footer.
    expect(fitCells(['Q quit and return the exit code'], [0], 8)).toEqual(['Q quit …']);
  });

  it('says what Q does in the mode the workspace is actually in', () => {
    // It used to say "Q minimise" in every mode, which stopped being true when §2.4 gave `Q` three answers
    // during execution, an immediate exit on an ended run, and "close this window" for an observer.
    expect(alwaysHints('executing')).toContain('Q quit');
    expect(alwaysHints('ended')).toContain('Q quit');
    expect(alwaysHints('observing')).toContain('Q close');
    expect(alwaysHints('executing')).not.toContain('minimise');
  });

  it('answers with one meaning per key: ? never describes Q or Ctrl+C twice', () => {
    const observer = [{ key: 'S', label: 'Stop the run', short: 'stop', kind: 'stop' as const }];
    const ended = [{ key: 'S', label: 'Resume run', short: 'resume run', kind: 'resume' as const }];
    const cases: Array<[KeyMode, ReturnType<typeof helpSections>]> = [
      ['observing', helpSections('tasks', 'overview', undefined, observer, 'observing')],
      ['ended', helpSections('tasks', 'overview', ended, undefined, 'ended')],
      ['executing', helpSections('tasks', 'overview', undefined, undefined, 'executing')],
    ];
    for (const [mode, sections] of cases) {
      const rows = sections.flatMap((s) => s.keys);
      for (const key of ['Q', 'Ctrl+C']) {
        expect(rows.filter((r) => r.keys === key), `${mode} describes ${key} more than once`).toHaveLength(1);
      }
    }
  });

  it('drops a panel key an ended run or an observer has taken over', () => {
    // `R` is the local restart in the Tasks panel and a resume-backed re-run once the run has ended; the
    // ended handler runs first, so the panel's own row for it is a description of something impossible.
    expect(panelHelp('tasks', 'overview').keys.some((k) => k.keys === 'R')).toBe(true);
    expect(panelHelp('tasks', 'overview', new Set(['R'])).keys.some((k) => k.keys === 'R')).toBe(false);
    expect(panelHelp('main', 'overview', new Set(['R'])).keys.some((k) => k.keys === 'R')).toBe(false);
    // Only whole single-key rows are dropped: "F / L" is still the follow key even when F is not taken.
    expect(panelHelp('tasks', 'overview', new Set(['R'])).keys.some((k) => k.keys === 'F / L')).toBe(true);
    const observing = helpSections('tasks', 'overview', undefined, [], 'observing');
    expect(observing.find((s) => s.title.startsWith('Tasks'))!.keys.some((k) => k.keys === 'R')).toBe(false);
  });

  it('still lists the transcript viewer and the global chords, so no old key is lost', () => {
    const keys = [...globalKeys(), ...viewerKeys()].map((k) => `${k.keys} ${k.what}`).join('\n');
    for (const old of ['Ctrl+C', 'Q', '?', 'P task picker', '[ ]', 'g oldest line', 'k']) expect(keys).toContain(old);
  });
});

describe('the panels a later stage fills', () => {
  it('has none left: every tab of the shell is filled in', () => {
    // Logs and Diagnostics were the last two (§3.7) and are panels of their own from stage 3. A placeholder
    // for a panel that has content is a sentence nobody will ever read, so there are none.
    expect(Object.keys(PLACEHOLDER_TEXT)).toHaveLength(0);
    for (const tab of WORKSPACE_TABS) expect(PLACEHOLDER_TEXT[tab], tab).toBeUndefined();
  });

  it('wraps a placeholder to the panel instead of cutting the half that says what to do instead', () => {
    // The wrapping is still what a tab added later would be drawn with, so it is still checked.
    const prose = ['The Turbo panel arrives in stage 9.', '', 'Until then: cao turbo --status prints it.'];
    for (const columns of [60, 84, 120]) {
      const lines = wrapLines(prose, columns);
      for (const line of lines) expect([...line].length, `${columns}: ${line}`).toBeLessThanOrEqual(Math.max(20, columns));
      // Nothing is lost in the wrapping: the sentence naming today's answer survives whole.
      expect(lines.join(' ')).toContain('cao turbo --status prints it.');
    }
  });

  it('cuts a trimmed detail block above a note, not below the row it belongs to', () => {
    // The detail is cut from the middle, and the tail used to be able to start with the `->` notes of an
    // attempt row that had just been cut away: two sentences hanging under nothing.
    const lines = [
      { text: 'task-id' },
      { text: 'Status:       failed' },
      { text: 'Attempts' },
      { text: '  #1  task  initial' },
      { text: '      -> retried after attempt 1 failed', continuation: true },
      { text: '      -> the build failed', continuation: true },
    ];
    // head 2, marker, tail 1 — and that one line used to be the second note of a row no longer on screen.
    const trimmed = trimToRows(lines, 4, '  ... more');
    expect(trimmed.map((l) => l.text)).not.toContain('      -> the build failed');
    expect(trimmed.map((l) => l.text)).toEqual(['task-id', 'Status:       failed', '  ... more']);
    // Nothing is dropped when it all fits.
    expect(trimToRows(lines, 20, '  ... more')).toHaveLength(lines.length);
    // ...and an ordinary tail is kept.
    expect(trimToRows([...lines, { text: 'Latest activity' }, { text: '  npm test' }], 4, '  ... more').map((l) => l.text)).toContain('  npm test');
  });

  it('renders the markdown of a report in ASCII when the terminal cannot draw the glyphs', () => {
    const previous = { ascii: process.env.CAO_ASCII, unicode: process.env.CAO_UNICODE };
    process.env.CAO_ASCII = '1';
    delete process.env.CAO_UNICODE;
    try {
      const lines = reportLines('# Report\n\n- one\n- two\n\n> a quote\n\n---\n', 60, false).join('\n');
      for (const unicode of ['•', '▏', '─']) expect(lines, `${unicode} is still drawn`).not.toContain(unicode);
      expect(lines).toContain('- one');
    } finally {
      if (previous.ascii === undefined) delete process.env.CAO_ASCII;
      else process.env.CAO_ASCII = previous.ascii;
      if (previous.unicode === undefined) delete process.env.CAO_UNICODE;
      else process.env.CAO_UNICODE = previous.unicode;
    }
  });

  it('renders report.md through the markdown renderer and filters it with a search', () => {
    const lines = reportLines('# Run report\n\nTask **a** succeeded.\n', 80, false);
    expect(lines.join('\n')).toContain('Run report');
    expect(lines.join('\n')).toContain('Task a succeeded.');
    expect(reportLines('# Run report\n\nTask a failed.\n', 80, false, 'failed').join('\n')).toBe('Task a failed.');
  });
});

describe('attention badges', () => {
  it('marks what needs a human and what went wrong, and nothing else', () => {
    expect(attentionBadge({ state: 'waiting' } as never)).toBe('?');
    expect(attentionBadge({ state: 'needs_input' } as never)).toBe('?');
    expect(attentionBadge({ state: 'failed' } as never)).toBe('!');
    expect(attentionBadge({ state: 'running' } as never)).toBe(' ');
    expect(attentionBadge(undefined)).toBe(' ');
  });
});
