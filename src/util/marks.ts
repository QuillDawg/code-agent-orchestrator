/**
 * The line prefixes every text surface uses for advisories. One vocabulary across `run`, `resume` and
 * `validate`, so a warning looks the same wherever it is printed and can be grepped for. The glyphs
 * fall back to ASCII on a terminal that cannot draw them (see `util/glyphs.ts`).
 */
import { glyph } from './glyphs.js';

export type Mark = 'ok' | 'warn' | 'error';

export function mark(kind: Mark): string {
  return kind === 'warn' ? '!' : glyph(kind);
}

export function okLine(message: string): string {
  return `${mark('ok')} ${message}`;
}

export function warnLine(message: string): string {
  return `${mark('warn')} ${message}`;
}

export function errorLine(message: string): string {
  return `${mark('error')} ${message}`;
}
