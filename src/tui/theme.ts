/**
 * The workspace's colours, in one token table [D35].
 *
 * Until this file existed the dashboard painted with a hard-coded `color = true` and literal style names at
 * each call site, which made two things impossible: honouring `NO_COLOR`, and giving the workspace an
 * identity without editing every component. A component now asks for a *token* — `danger`, `accent`,
 * `muted` — and the theme decides what that means. Stage 4 replaces the palette here and nothing else
 * changes.
 *
 * The palette below is deliberately neutral: the cyberpunk one is stage 4's, and a half-built identity in
 * its place would be worse than none. What matters now is the seam and the `mono` variant.
 *
 * `mono` is not "the same screen with the colour turned down": under it nothing is painted at all, so every
 * distinction has to survive in the text. That is the point of the variant — it is the check that the state
 * of a task is readable from its glyph and its word, as §3.2 requires, rather than from its being red.
 */
import type { TaskState } from 'code-agent-orchestrator-protocol';
import { paint, type Style } from '../cli/color.js';
import { STATE_COLOR } from '../workflow/states.js';

/** The themes this build has. `cyberpunk` arrives in stage 4 and is deliberately not accepted yet. */
export const THEME_NAMES = ['default', 'mono'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/**
 * What a surface is allowed to ask for. Named by meaning rather than by colour, so stage 4 can make
 * `accent` violet without a component ever mentioning violet.
 */
export type ThemeToken =
  | 'title'
  | 'muted'
  | 'accent'
  | 'border'
  | 'danger'
  | 'warning'
  | 'success'
  | 'info'
  | 'selection'
  | 'badge'
  | 'key'
  | 'tabActive'
  | 'tabIdle'
  | 'agent';

const NEUTRAL: Record<ThemeToken, Style[]> = {
  title: ['bold'],
  muted: ['dim'],
  accent: ['cyan'],
  border: ['gray'],
  danger: ['red'],
  warning: ['yellow'],
  success: ['green'],
  info: ['cyan'],
  selection: ['inverse', 'bold'],
  badge: ['cyan', 'bold'],
  key: ['bold'],
  tabActive: ['cyan', 'bold'],
  tabIdle: ['dim'],
  agent: ['magenta'],
};

export interface Theme {
  readonly name: ThemeName;
  /** False under `mono`: `paint` returns its text and `ink` returns undefined. */
  readonly color: boolean;
  /** Paint `text` with a token, or with literal styles where a surface has its own vocabulary. */
  paint(text: string, token: ThemeToken | Style | Style[]): string;
  /** The value for an Ink `<Text color=…>` prop, or undefined when nothing should be painted. */
  ink(token: ThemeToken): Style | undefined;
  /** The colour of a task state, or undefined under `mono` — where the glyph and the word carry it. */
  stateColor(state: TaskState): Style | undefined;
}

const OFF = new Set(['', '0', 'false', 'no', 'off']);

function truthy(value: string | undefined): boolean {
  return value !== undefined && !OFF.has(value.trim().toLowerCase());
}

function makeTheme(name: ThemeName): Theme {
  const color = name !== 'mono';
  const styles = (token: ThemeToken | Style | Style[]): Style[] => {
    if (Array.isArray(token)) return token;
    return (NEUTRAL as Record<string, Style[]>)[token] ?? [token as Style];
  };
  return {
    name,
    color,
    paint: (text, token) => paint(text, styles(token), color),
    ink: (token) => (color ? styles(token)[0] : undefined),
    stateColor: (state) => (color ? STATE_COLOR[state] : undefined),
  };
}

export interface ThemeRequest {
  /** `--theme <name>`; an unknown name is ignored rather than fatal, so a typo does not stop a run. */
  theme?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Which theme this terminal gets. `NO_COLOR` wins over everything, as the convention requires: a user who
 * set it did so for every program on the machine, and an explicit `--theme` is still a request for colour.
 */
export function resolveTheme(request: ThemeRequest = {}): Theme {
  const env = request.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return makeTheme('mono');
  const asked = request.theme?.trim() ?? env.CAO_THEME?.trim();
  if (asked && isThemeName(asked)) return makeTheme(asked);
  return makeTheme('default');
}

/**
 * Whether animation is off: the spinner and the activity pulse. `TERM=dumb` is included because a terminal
 * that cannot move the cursor turns every spinner frame into another line of output. Ink's screen-reader
 * flag is a hook, so the component combines it with this.
 */
export function reducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.CAO_REDUCED_MOTION) || env.TERM === 'dumb';
}
