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
import { attentionBadge, fitCells, headerRowsFor } from '../../src/tui/workspace/chrome.js';
import { trimToRows } from '../../src/tui/workspace/overview.js';
import { resolveTheme, reducedMotion, isThemeName, THEME_NAMES } from '../../src/tui/theme.js';
import { altScreenEnabled, readUserConfig, BASE_RENDER_OPTIONS, workspaceRenderOptions } from '../../src/tui/render-options.js';
import { WORKSPACE_TABS } from '../../src/tui/store.js';

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

  it('spends every row once: header, tabs, body and footer add up to the terminal', () => {
    for (const [columns, rows] of [
      [80, 24],
      [120, 40],
      [200, 60],
      [60, 10],
    ] as const) {
      for (const notice of [false, true]) {
        const layout = workspaceLayout({ columns, rows, headerRows: notice ? 3 : 2, notice });
        expect(layout.headerRows + layout.tabRows + layout.bodyRows + layout.footerRows).toBeLessThanOrEqual(rows);
        expect(layout.mainRows).toBeGreaterThan(0);
        expect(layout.mainWidth).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('drops the footer freshness column before the quota chips', () => {
    expect(footerColumnsFor(120)).toEqual(['shortcuts', 'quota', 'freshness']);
    expect(footerColumnsFor(80)).toEqual(['shortcuts', 'quota']);
    expect(footerColumnsFor(50)).toEqual(['shortcuts']);
  });

  it('gives the header its third row only when something is waiting for a human', () => {
    const run = (state: string) =>
      ({ workflow: { tasks: [{ id: 'a' }] }, tasks: { a: { state } } }) as never;
    expect(headerRowsFor(run('running'))).toBe(2);
    expect(headerRowsFor(run('waiting'))).toBe(3);
  });
});

describe('theme', () => {
  it('paints with the default theme and with nothing at all under mono', () => {
    const colour = resolveTheme({ env: {} });
    expect(colour.name).toBe('default');
    expect(colour.color).toBe(true);
    expect(colour.paint('failed', 'danger')).not.toBe('failed');
    expect(colour.stateColor('failed')).toBe('red');

    const mono = resolveTheme({ theme: 'mono', env: {} });
    expect(mono.color).toBe(false);
    expect(mono.paint('failed', 'danger')).toBe('failed');
    expect(mono.ink('accent')).toBeUndefined();
    expect(mono.stateColor('failed')).toBeUndefined();
  });

  it('lets NO_COLOR win over an explicit theme, and reads CAO_THEME when nothing was asked for', () => {
    expect(resolveTheme({ theme: 'default', env: { NO_COLOR: '1' } }).name).toBe('mono');
    expect(resolveTheme({ env: { CAO_THEME: 'mono' } }).name).toBe('mono');
    // A typo is not fatal: the run keeps its colours rather than stopping over a flag.
    expect(resolveTheme({ theme: 'cyberpunk', env: {} }).name).toBe('default');
    expect(THEME_NAMES.every(isThemeName)).toBe(true);
    expect(isThemeName('cyberpunk')).toBe(false);
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
      // The Changes panel draws its own key line; the footer would only repeat it.
      if (tab === 'changes') continue;
      for (const key of panelHelp('main', tab).keys) expect(hints).toContain(key.keys);
    }
    // Kept out of `footerHints` on purpose: the footer truncates the panel keys into what is left after
    // these, so the way out of the workspace is never the thing a narrow terminal drops.
    expect(alwaysHints('executing')).toContain('Ctrl+P palette');
    expect(alwaysHints('executing')).toContain('? help');
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
  it('says which stage fills each of them', () => {
    expect(PLACEHOLDER_TEXT.session?.[0]).toContain('stage 2');
    expect(PLACEHOLDER_TEXT.logs?.[0]).toContain('stage 3');
    expect(PLACEHOLDER_TEXT.diagnostics?.[0]).toContain('stage 3');
    // And what answers the same question today, so the panel is never merely empty.
    for (const lines of Object.values(PLACEHOLDER_TEXT)) expect(lines.join(' ')).toContain('Until then');
  });

  it('wraps that prose to the panel instead of cutting the half that says what to do instead', () => {
    for (const columns of [60, 84, 120]) {
      const lines = wrapLines(PLACEHOLDER_TEXT.session!, columns);
      for (const line of lines) expect([...line].length, `${columns}: ${line}`).toBeLessThanOrEqual(Math.max(20, columns));
      // Nothing is lost in the wrapping: the sentence naming today's answer survives whole.
      expect(lines.join(' ')).toContain('cao task <id> shows everything recorded about it.');
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
