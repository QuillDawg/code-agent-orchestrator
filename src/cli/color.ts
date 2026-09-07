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
const CLOSE_FOR = new Map(Object.values(CODES).map(([open, close]) => [String(open), String(close)]));
const CLOSERS = new Set(CLOSE_FOR.values());

/**
 * Close the styles still open at the end of each line and re-open them on the next one. Wrapping splits a
 * painted string wherever a space falls, which otherwise leaves an opening code on one line and its reset on
 * another: the first line bleeds its color into everything after it and the continuations render unstyled.
 */
export function balanceStyles(lines: string[]): string[] {
  const open: string[] = [];
  return lines.map((line) => {
    const prefix = open.map((c) => `${ESC}[${c}m`).join('');
    for (const match of line.matchAll(SGR_RE)) {
      for (const code of (match[1] || '0').split(';')) {
        if (code === '' || code === '0') open.length = 0;
        else if (CLOSERS.has(code)) {
          for (let i = open.length - 1; i >= 0; i--) if (CLOSE_FOR.get(open[i]!) === code) open.splice(i, 1);
        } else open.push(code);
      }
    }
    const suffix = [...open].reverse().map((c) => `${ESC}[${CLOSE_FOR.get(c) ?? '0'}m`).join('');
    return `${prefix}${line}${suffix}`;
  });
}

/** Visible length (escapes and control characters stripped; wide glyphs counted as one column, which is good enough for alignment). */
export function visibleLength(text: string): number {
  return sanitizeText(text).length;
}
