/** Tiny ANSI styling used by every text surface (plain output, and strings inside Ink <Text>). */
import { ESC, sanitizeText, stripAnsi } from '../util/text.js';

export { sanitizeText, stripAnsi };

export type ColorMode = 'auto' | 'always' | 'never';

/** FORCE_COLOR follows the usual convention: unset, empty or 0/false/no/off means "do not force". */
const FORCE_OFF = new Set(['', '0', 'false', 'no', 'off']);

function forcedColor(): boolean {
  const value = process.env.FORCE_COLOR;
  return value !== undefined && !FORCE_OFF.has(value.trim().toLowerCase());
}

export function useColor(mode: ColorMode = 'auto'): boolean {
  if (mode === 'never' || process.env.NO_COLOR) return false;
  if (mode === 'always' || forcedColor()) return true;
  return Boolean(process.stdout.isTTY);
}

/**
 * How much colour this terminal can show: `0` none, `1` the sixteen ANSI colours, `2` 256, `3` truecolor.
 *
 * `useColor` answers "may I paint", which is the question every call site has. This answers "how much of
 * what I paint will arrive", which is the question `cao doctor` asks: a level of `0` means every state has
 * to be told apart by its mark alone, and that is worth saying out loud before someone reports that the
 * failed task "looks the same as the others".
 */
export function colorLevel(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stdout.isTTY)): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR || env.TERM === 'dumb') return 0;
  const forced = env.FORCE_COLOR !== undefined && !FORCE_OFF.has(env.FORCE_COLOR.trim().toLowerCase());
  if (!isTTY && !forced) return 0;
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  // Windows Terminal and the modern conhost both do 24-bit and neither sets COLORTERM.
  if (env.WT_SESSION) return 3;
  const term = env.TERM ?? '';
  if (term.includes('256color') || env.TERM_PROGRAM || env.ConEmuTask) return 2;
  return 1;
}

export function ansi(text: string, code: number, mode?: ColorMode): string {
  return useColor(mode) ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

export type Style = 'bold' | 'dim' | 'italic' | 'inverse' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray';

const CODES: Record<Style, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
};

/** Apply one or more styles when `enabled`; nested styles close cleanly. */
export function paint(text: string, styles: Style | Style[], enabled = true): string {
  if (!enabled || text === '') return text;
  let out = text;
  for (const s of Array.isArray(styles) ? [...styles].reverse() : [styles]) {
    const [open, close] = CODES[s];
    out = `${ESC}[${open}m${out}${ESC}[${close}m`;
  }
  return out;
}

const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');

/** `#rrggbb` (or `#rgb`) to its three channels, or null when it is not a hex colour at all. */
export function hexRgb(hex: string): [number, number, number] | null {
  const body = hex.startsWith('#') ? hex.slice(1) : hex;
  const full = body.length === 3 ? [...body].map((c) => c + c).join('') : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * A colour's cell in the 256-colour palette: the 24-step grey ramp for a true grey, the 6x6x6 cube otherwise.
 *
 * This and `ansi256To16` below are `ansi-styles`' own algorithm rather than a nearest-neighbour search,
 * deliberately. Ink downsamples the `color` prop through `ansi-styles`; a surface that paints *inside* a
 * `<Text>` has to arrive at the same slot, or one violet word on a 16-colour terminal would be a different
 * colour from the violet word beside it that happened to be set as a prop.
 */
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

/** A 256-colour cell as one of the sixteen: the hue from the bits that are on, the brightness from the max. */
function ansi256To16(code: number): number {
  if (code < 8) return 30 + code;
  if (code < 16) return 90 + (code - 8);
  let r: number;
  let g: number;
  let b: number;
  if (code >= 232) {
    r = ((code - 232) * 10 + 8) / 255;
    g = r;
    b = r;
  } else {
    const offset = code - 16;
    const remainder = offset % 36;
    r = Math.floor(offset / 36) / 5;
    g = Math.floor(remainder / 6) / 5;
    b = (remainder % 6) / 5;
  }
  const value = Math.max(r, g, b) * 2;
  if (value === 0) return 30;
  const result = 30 + ((Math.round(b) << 2) | (Math.round(g) << 1) | Math.round(r));
  return value === 2 ? result + 60 : result;
}

/**
 * The SGR parameters that set `hex` as a foreground (or background) colour on a terminal of this depth.
 *
 * Truecolor terminals get the colour as written, a 256-colour one its cell of the cube, a 16-colour one the
 * slot that cell falls in. Level 0 has no colour to give and returns the empty string, which the caller
 * drops - so a token with nothing but a colour paints nothing there rather than an empty escape.
 */
export function sgrColor(hex: string, level: 0 | 1 | 2 | 3, background = false): string {
  const rgb = hexRgb(hex);
  if (rgb === null || level === 0) return '';
  const [r, g, b] = rgb;
  if (level === 3) return `${background ? 48 : 38};2;${r};${g};${b}`;
  const cell = rgbTo256(r, g, b);
  if (level === 2) return `${background ? 48 : 38};5;${cell}`;
  const code = ansi256To16(cell);
  return String(background ? code + 10 : code);
}

/** What closes an SGR parameter, or null for a reset (which closes everything). */
function closerFor(code: number): string | null {
  if (code === 1 || code === 2) return '22';
  if (code === 3) return '23';
  if (code === 4) return '24';
  if (code === 7) return '27';
  if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) return '39';
  if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) return '49';
  return null;
}

/**
 * One SGR escape's parameters as the styles it opens, in order; `null` is a reset, which closes everything.
 *
 * `38`/`48` take their colour from the parameters that follow them (`38;2;r;g;b`, `38;5;n`), so they cannot
 * be read one number at a time: split naively, a truecolor violet became six separate "styles" and every one
 * of its channels was re-opened as a colour of its own on the next wrapped line.
 */
function sgrStyles(params: string): Array<{ open: string; close: string } | null> {
  const parts = (params || '0').split(';');
  const out: Array<{ open: string; close: string } | null> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i]!;
    const code = Number(raw);
    if (raw === '' || code === 0 || !Number.isFinite(code)) {
      out.push(null);
      continue;
    }
    if (code === 38 || code === 48) {
      const take = Number(parts[i + 1]) === 2 ? 5 : Number(parts[i + 1]) === 5 ? 3 : 1;
      out.push({ open: parts.slice(i, i + take).join(';'), close: code === 38 ? '39' : '49' });
      i += take - 1;
      continue;
    }
    const close = closerFor(code);
    out.push(close === null ? null : { open: raw, close });
  }
  return out;
}

/**
 * Close the styles still open at the end of each line and re-open them on the next one. Wrapping splits a
 * painted string wherever a space falls, which otherwise leaves an opening code on one line and its reset on
 * another: the first line bleeds its color into everything after it and the continuations render unstyled.
 */
export function balanceStyles(lines: string[]): string[] {
  const open: Array<{ open: string; close: string }> = [];
  return lines.map((line) => {
    const prefix = open.map((style) => `${ESC}[${style.open}m`).join('');
    for (const match of line.matchAll(SGR_RE)) {
      for (const style of sgrStyles(match[1] ?? '')) {
        if (style === null) {
          open.length = 0;
          continue;
        }
        // A closer arrives as a parameter of its own (`22`, `39`, `49`): it shuts the newest style it closes.
        let closing = -1;
        for (let i = open.length - 1; i >= 0 && closing < 0; i -= 1) if (open[i]!.close === style.open) closing = i;
        if (closing >= 0) open.splice(closing, 1);
        else open.push(style);
      }
    }
    const suffix = [...open].reverse().map((style) => `${ESC}[${style.close}m`).join('');
    return `${prefix}${line}${suffix}`;
  });
}

/** Visible length (escapes and control characters stripped; wide glyphs counted as one column, which is good enough for alignment). */
export function visibleLength(text: string): number {
  return sanitizeText(text).length;
}
