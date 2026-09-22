/**
 * The workspace's identity, in one token table [D35] (§3.2).
 *
 * Until this file existed the dashboard painted with a hard-coded `color = true` and literal style names at
 * each call site, which made two things impossible: honouring `NO_COLOR`, and giving the workspace an
 * identity without editing every component. A component asks for a *token* - `danger`, `accent`, `muted` -
 * and the theme decides what that means. **This is the only file under `src/tui/` that is allowed to name a
 * colour**, and `test/unit/theme.test.ts` fails the build if another one starts to.
 *
 * Two themes, and they are not the same screen with the colour turned down:
 *
 * - `cyberpunk` is the default. Violet and cyan accents, one warning colour and one danger colour, panel
 *   borders in the accent, given as hex so a truecolor terminal gets the shade that was chosen. Ink
 *   downsamples its own `color` prop and `sgrColor` downsamples the strings a surface paints inside a
 *   `<Text>`, so a 256-colour or 16-colour terminal gets the nearest slot rather than an escape it cannot
 *   render.
 * - `mono` paints no colour at all and has only bold, dim and inverse to tell things apart with. That is the
 *   point of it: it is the standing check that a task's state is readable from its glyph and its word rather
 *   than from its being red, as §3.2 requires. It is what `NO_COLOR` and a terminal with no colour get.
 *
 * `plainTheme()` is a third one and is not a theme a user can pick: it is what a surface that was told "no
 * colour" by an older, boolean-shaped caller paints with - nothing at all, not even bold - so `cao logs`
 * piped into a file keeps producing exactly the bytes it always has.
 */
import type { TaskState } from 'code-agent-orchestrator-protocol';
import { colorLevel, sgrColor } from '../cli/color.js';
import { ESC } from '../util/text.js';
import { useUnicode } from '../util/glyphs.js';
import { readUserConfig } from './render-options.js';

/** The themes a user may ask for. `default` is still accepted as the old name of `cyberpunk`. */
export const THEME_NAMES = ['cyberpunk', 'mono'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** What `--theme default` meant before stage 4 named the identity it had been standing in for. */
const THEME_ALIASES: Record<string, ThemeName> = { default: 'cyberpunk' };

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/** A theme name, an accepted alias of one, or undefined - which means "the user did not say". */
export function themeNameOf(value: string | undefined): ThemeName | undefined {
  const asked = value?.trim().toLowerCase();
  if (!asked) return undefined;
  if (isThemeName(asked)) return asked;
  return THEME_ALIASES[asked];
}

/** Everything a token may set beyond a colour. `mono` has only these. */
export type Attr = 'bold' | 'dim' | 'italic' | 'underline' | 'inverse';

/** What `paint` takes: a token from the table, or a bare attribute that means the same in every theme. */
export type Paintable = ThemeToken | Attr;

const ATTR_CODES: Record<Attr, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
};

/**
 * What a surface is allowed to ask for.
 *
 * The first twelve are the table §3.2 names. The five after them are *roles*: a name for a recurring job on
 * the screen, defined in terms of the twelve, so that "the key in a hint" and "the accent of a border" can
 * stop being the same colour later without every call site being visited again.
 */
export type ThemeToken =
  | 'accent'
  | 'accent2'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'muted'
  | 'text'
  | 'border'
  | 'borderFocused'
  | 'badgeBg'
  | 'selection'
  | 'progress'
  | 'title'
  | 'key'
  | 'tabActive'
  | 'tabIdle'
  | 'agent';

export interface TokenSpec {
  /** Foreground, as hex. Absent under `mono`, where no colour is painted. */
  readonly fg?: string;
  /** Background, as hex. Only a colour theme has one: a badge under `mono` is bold, not inverse by accident. */
  readonly bg?: string;
  readonly attrs?: readonly Attr[];
}

/**
 * The cyberpunk palette (§3.2): violet and cyan accents over a dark violet chrome.
 *
 * Each value is chosen for what it downsamples to as well as for the shade itself. On a 16-colour terminal
 * these land on eight different slots - `ok` on green, `warn` on bright yellow, `danger` on bright red,
 * `accent` and `agent` on bright magenta, `accent2` on bright cyan, `border` on blue, `muted` on white and
 * `text` on bright white - so the states an operator tells apart by colour are still told apart there.
 */
const CYBERPUNK: Record<ThemeToken, TokenSpec> = {
  accent: { fg: '#a855f7' },
  accent2: { fg: '#22d3ee' },
  ok: { fg: '#22c55e' },
  warn: { fg: '#fbbf24' },
  danger: { fg: '#f43f5e' },
  muted: { fg: '#8b8ca7' },
  text: { fg: '#e4e4f4' },
  border: { fg: '#6d5aa0' },
  borderFocused: { fg: '#a855f7' },
  badgeBg: { fg: '#f3e8ff', bg: '#4c1d95' },
  selection: { fg: '#140b22', bg: '#a855f7', attrs: ['bold'] },
  progress: { fg: '#22d3ee' },
  title: { fg: '#e4e4f4', attrs: ['bold'] },
  key: { fg: '#22d3ee', attrs: ['bold'] },
  tabActive: { fg: '#a855f7', attrs: ['bold'] },
  tabIdle: { fg: '#8b8ca7' },
  agent: { fg: '#d946ef' },
};

/**
 * `mono`: bold, dim and inverse, and nothing else.
 *
 * `ok`, `text` and `progress` are deliberately empty. A screen where everything is bold says no more than a
 * screen where nothing is, so the emphasis is spent on the three things an operator is looking for -
 * something went wrong, something needs them, something has focus - and the rest is left plain.
 */
const MONO: Record<ThemeToken, TokenSpec> = {
  accent: { attrs: ['bold'] },
  accent2: { attrs: ['bold'] },
  ok: {},
  warn: { attrs: ['bold'] },
  danger: { attrs: ['bold'] },
  muted: { attrs: ['dim'] },
  text: {},
  border: { attrs: ['dim'] },
  borderFocused: { attrs: ['bold'] },
  badgeBg: { attrs: ['bold'] },
  selection: { attrs: ['inverse', 'bold'] },
  progress: {},
  title: { attrs: ['bold'] },
  key: { attrs: ['bold'] },
  tabActive: { attrs: ['bold'] },
  tabIdle: { attrs: ['dim'] },
  agent: { attrs: ['dim'] },
};

/**
 * The token each task state is drawn in, so `running` is the same accent on every surface at once.
 *
 * The states that need a human share `warn` and the ones that went wrong share `danger`: the difference
 * between `failed` and `blocked` is carried by the glyph and the word, which is the only place it can be
 * carried on a terminal with no colour.
 */
export const STATE_TOKEN: Record<TaskState, ThemeToken> = {
  pending: 'muted',
  ready: 'muted',
  running: 'accent2',
  waiting: 'warn',
  awaiting_approval: 'warn',
  needs_input: 'warn',
  success: 'ok',
  failed: 'danger',
  blocked: 'danger',
  skipped: 'muted',
  cancelled: 'agent',
  suspended: 'agent',
};

/**
 * What a panel's box is drawn with. The *style* carries focus, so `mono` shows it too (§3.2).
 *
 * `classic` is the ASCII alphabet's answer. cli-boxes spells `round` and `double` with box-drawing
 * characters, so every dialog drew mojibake on a terminal `CAO_ASCII=1` was chosen for - and nothing caught
 * it, because the ASCII frame tests never open one.
 */
export interface BorderProps {
  borderStyle: 'round' | 'double' | 'classic';
  borderColor: string | undefined;
}

export interface Theme {
  readonly name: ThemeName;
  /** False under `mono`: no colour is painted, and `ink` returns undefined. */
  readonly color: boolean;
  /** How much colour this terminal can show, which is what a hex token is downsampled to. */
  readonly level: 0 | 1 | 2 | 3;
  /**
   * Whether this theme styles at all. False only for `plainTheme()`, where even `bold` is dropped: a
   * surface told "no colour" by a plain-CLI caller must produce the bytes it always has.
   */
  readonly styled: boolean;
  /**
   * Paint `text` with a token, with a bare attribute, or with several of either - the outermost one's colour
   * wins and the attributes add up.
   *
   * `bold`, `dim` and `italic` are accepted by name because they are structure rather than identity: a
   * heading is bold in every theme, and inventing a token per emphasis would say nothing the word does not.
   * A *colour* has no name here, which is the whole point of the table.
   */
  paint(text: string, token: Paintable | readonly Paintable[]): string;
  /** The value for an Ink `<Text color=…>` prop, or undefined when nothing should be painted. */
  ink(token: ThemeToken): string | undefined;
  /** The value for an Ink `<Text backgroundColor=…>` prop; only a colour theme has one. */
  inkBg(token: ThemeToken): string | undefined;
  /** The colour of a task state, or undefined under `mono` - where the glyph and the word carry it. */
  stateColor(state: TaskState): string | undefined;
  /** The token of a task state, for a surface that paints rather than sets a prop. */
  stateToken(state: TaskState): ThemeToken;
  /** The border of a panel: `double` when it has the keys, `round` when it does not. */
  border(focused: boolean): BorderProps;
}

const OFF = new Set(['', '0', 'false', 'no', 'off']);

function truthy(value: string | undefined): boolean {
  return value !== undefined && !OFF.has(value.trim().toLowerCase());
}

/** The open and close escapes of one token at this terminal's colour depth, built once per theme. */
function escapesFor(spec: TokenSpec, level: 0 | 1 | 2 | 3): [string, string] | null {
  const open: string[] = [];
  const close: string[] = [];
  for (const attr of spec.attrs ?? []) {
    const [on, off] = ATTR_CODES[attr];
    open.push(String(on));
    close.unshift(String(off));
  }
  for (const [hex, background] of [
    [spec.fg, false],
    [spec.bg, true],
  ] as const) {
    if (hex === undefined) continue;
    const params = sgrColor(hex, level, background);
    if (params === '') continue;
    open.push(params);
    close.unshift(background ? '49' : '39');
  }
  if (open.length === 0) return null;
  return [`${ESC}[${open.join(';')}m`, `${ESC}[${close.join(';')}m`];
}

function makeTheme(name: ThemeName, table: Record<ThemeToken, TokenSpec>, level: 0 | 1 | 2 | 3, styled = true): Theme {
  const color = styled && table === CYBERPUNK && level > 0;
  const escapes = new Map<Paintable, [string, string] | null>();
  const wrap = (token: Paintable): [string, string] | null => {
    if (!escapes.has(token)) escapes.set(token, styled ? escapesFor(token in ATTR_CODES ? { attrs: [token as Attr] } : table[token as ThemeToken], level) : null);
    return escapes.get(token) ?? null;
  };
  return {
    name,
    color,
    styled,
    level,
    paint(text, token) {
      if (text === '' || !styled) return text;
      const tokens = Array.isArray(token) ? (token as readonly Paintable[]) : [token as Paintable];
      let out = text;
      for (const one of [...tokens].reverse()) {
        const pair = wrap(one);
        if (pair) out = `${pair[0]}${out}${pair[1]}`;
      }
      return out;
    },
    ink: (token) => (color ? table[token].fg : undefined),
    inkBg: (token) => (color ? table[token].bg : undefined),
    stateColor: (state) => (color ? table[STATE_TOKEN[state]].fg : undefined),
    stateToken: (state) => STATE_TOKEN[state],
    border: (focused) => ({
      borderStyle: useUnicode() ? (focused ? 'double' : 'round') : 'classic',
      borderColor: color ? table[focused ? 'borderFocused' : 'border'].fg : undefined,
    }),
  };
}

export interface ThemeRequest {
  /** `--theme <name>`; an unknown name is ignored rather than fatal, so a typo does not stop a run. */
  theme?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; the default reads `~/.cao/config.json` if it already exists, and never writes it. */
  config?: () => Record<string, unknown> | null;
  /**
   * What this terminal can show. The default asks `colorLevel` with `isTTY` forced true, because the
   * workspace only ever opens on a terminal - what is left of the answer is `NO_COLOR` and `TERM=dumb`,
   * which are the two the user meant.
   */
  level?: 0 | 1 | 2 | 3;
}

/**
 * Which theme this terminal gets (§3.2, [D35]).
 *
 * `NO_COLOR` wins over everything, as the convention requires: a user who set it did so for every program on
 * the machine, and an explicit `--theme cyberpunk` is still a request for colour. A terminal that reports no
 * colour at all gets `mono` for the same reason - a violet escape it will not render arrives as nothing, and
 * then only the glyph and the word are left, which is what `mono` is built for.
 *
 * After those two the order is the one every other option in `cao` uses: the flag on this invocation, then
 * the environment, then `~/.cao/config.json`'s `theme` key - read, never written, exactly as `altScreen` is
 * [D4] - then the default.
 */
export function resolveTheme(request: ThemeRequest = {}): Theme {
  const env = request.env ?? process.env;
  const level = request.level ?? colorLevel(env, true);
  if (truthy(env.NO_COLOR) || level === 0) return makeTheme('mono', MONO, level);
  const asked = themeNameOf(request.theme) ?? themeNameOf(env.CAO_THEME) ?? themeNameOf(storedTheme(request));
  const name = asked ?? 'cyberpunk';
  return makeTheme(name, name === 'mono' ? MONO : CYBERPUNK, level);
}

function storedTheme(request: ThemeRequest): string | undefined {
  const stored = (request.config ?? (() => readUserConfig()))();
  return stored && typeof stored.theme === 'string' ? stored.theme : undefined;
}

let colourTheme: Theme | undefined;
let plain: Theme | undefined;

/**
 * The theme a surface that was only told "colour: yes or no" should paint with.
 *
 * Several text surfaces older than the token table take a boolean instead of a theme - `renderTranscript`,
 * the markdown renderer, the diff panes - and they are shared with the plain CLI, where `false` means the
 * output is going into a pipe or a file. `false` therefore has to mean *nothing at all* rather than "mono",
 * or `cao logs > run.txt` would start writing bold codes into a file that never had them. A caller that has
 * a real theme passes it and gets that theme's styling instead.
 */
export function themeFor(color: boolean, theme?: Theme): Theme {
  if (theme) return theme;
  if (!color) return plainTheme();
  // At least the sixteen: the caller has already decided colour is wanted (`--color always`, or a TTY),
  // and a depth of 0 here would hand it a theme that paints nothing, which is the opposite of what it said.
  colourTheme ??= makeTheme('cyberpunk', CYBERPUNK, Math.max(1, colorLevel(process.env, true)) as 1 | 2 | 3);
  return colourTheme;
}

/** A theme that paints nothing at all, for a caller that wants the text and none of the escapes. */
export function plainTheme(): Theme {
  plain ??= makeTheme('mono', MONO, 0, false);
  return plain;
}

/**
 * Whether animation is off: the spinner and the activity pulse (§3.2). `TERM=dumb` is included because a
 * terminal that cannot move the cursor turns every spinner frame into another line of output. Ink's
 * screen-reader flag is a hook, so the component combines it with this.
 */
export function reducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.CAO_REDUCED_MOTION) || env.TERM === 'dumb';
}
