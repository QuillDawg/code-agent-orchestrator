/**
 * Light markdown → styled terminal lines. Headings, emphasis, inline code, fenced code, bullets, numbered
 * lists, quotes and links; enough to make agent prose readable without a dependency.
 */
import { balanceStyles, sanitizeText, visibleLength } from '../cli/color.js';
import { glyph, useUnicode } from '../util/glyphs.js';
import { themeFor, type Theme } from './theme.js';

export interface MarkdownOptions {
  color: boolean;
  /**
   * The theme to paint with. Absent from the plain-CLI callers, which have only `color`: they get the
   * do-nothing theme when it is false and the default palette when it is true (`themeFor`).
   */
  theme?: Theme;
  /** Wrap width in columns; 0 disables wrapping. */
  width: number;
}

function inline(text: string, theme: Theme): string {
  if (!theme.styled) return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_, code: string) => theme.paint(code, 'accent2'));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => theme.paint(bold, 'bold'));
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:!?)]|$)/g, (_, pre: string, em: string) => `${pre}${theme.paint(em, 'italic')}`);
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:!?)]|$)/g, (_, pre: string, em: string) => `${pre}${theme.paint(em, 'italic')}`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => `${label} ${theme.paint(`(${url})`, 'dim')}`);
  return out;
}

/**
 * Word-wrap a styled line to `width` columns, keeping `indent` on continuation lines. The split happens on
 * spaces in the styled string, so each resulting line is re-balanced: an opening code left on one line would
 * otherwise bleed into everything printed after it.
 */
export function wrapLine(line: string, width: number, indent = ''): string[] {
  if (width <= 0 || visibleLength(line) <= width) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleLength(candidate) > width && current) {
      out.push(current);
      current = `${indent}${word}`;
    } else current = candidate;
  }
  if (current) out.push(current);
  return balanceStyles(out);
}

export function renderMarkdown(text: string, opts: MarkdownOptions): string[] {
  const { width } = opts;
  const theme = themeFor(opts.color, opts.theme);
  const out: string[] = [];
  let inFence = false;
  for (const raw of sanitizeText(text).split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(theme.paint(inFence ? `${glyph('treeFirst')} ${line.trim().slice(3).trim()}` : glyph('treeLast'), 'dim'));
      continue;
    }
    if (inFence) {
      out.push(`${theme.paint(`${glyph('vrule')} `, 'dim')}${theme.paint(line, 'muted')}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const body = inline(heading[2]!, theme);
      out.push(...wrapLine(level === 1 ? theme.paint(body, ['bold', 'text']) : theme.paint(body, 'bold'), width));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = bullet[1]!;
      out.push(...wrapLine(`${indent}${theme.paint(useUnicode() ? '•' : '-', 'accent2')} ${inline(bullet[2]!, theme)}`, width, `${indent}  `));
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const indent = numbered[1]!;
      const marker = `${numbered[2]}.`;
      out.push(...wrapLine(`${indent}${theme.paint(marker, 'accent2')} ${inline(numbered[3]!, theme)}`, width, `${indent}${' '.repeat(marker.length + 1)}`));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(...wrapLine(`${theme.paint(useUnicode() ? '▏' : '|', 'dim')} ${theme.paint(inline(quote[1]!, theme), 'italic')}`, width, '  '));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(theme.paint(glyph('rule').repeat(Math.max(3, Math.min(40, width || 40))), 'dim'));
      continue;
    }
    out.push(...wrapLine(inline(line, theme), width));
  }
  // Collapse runs of blank lines so prose stays compact in a small pane.
  const compact: string[] = [];
  for (const l of out) {
    if (l.trim() === '' && compact[compact.length - 1]?.trim() === '') continue;
    compact.push(l);
  }
  while (compact.length && compact[compact.length - 1]!.trim() === '') compact.pop();
  return compact;
}
