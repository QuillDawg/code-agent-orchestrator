/**
 * Light markdown → styled terminal lines. Headings, emphasis, inline code, fenced code, bullets, numbered
 * lists, quotes and links; enough to make agent prose readable without a dependency.
 */
import { balanceStyles, paint, sanitizeText, visibleLength } from '../cli/color.js';

export interface MarkdownOptions {
  color: boolean;
  /** Wrap width in columns; 0 disables wrapping. */
  width: number;
}

function inline(text: string, color: boolean): string {
  if (!color) return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_, code: string) => paint(code, 'cyan'));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => paint(bold, 'bold'));
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:!?)]|$)/g, (_, pre: string, em: string) => `${pre}${paint(em, 'italic')}`);
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:!?)]|$)/g, (_, pre: string, em: string) => `${pre}${paint(em, 'italic')}`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => `${label} ${paint(`(${url})`, 'dim')}`);
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
  const { color, width } = opts;
  const out: string[] = [];
  let inFence = false;
  for (const raw of sanitizeText(text).split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(paint(inFence ? `┌ ${line.trim().slice(3).trim()}` : '└', 'dim', color));
      continue;
    }
    if (inFence) {
      out.push(`${paint('│ ', 'dim', color)}${paint(line, 'gray', color)}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const body = inline(heading[2]!, color);
      out.push(...wrapLine(level === 1 ? paint(body, ['bold', 'white'], color) : paint(body, 'bold', color), width));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = bullet[1]!;
      out.push(...wrapLine(`${indent}${paint('•', 'cyan', color)} ${inline(bullet[2]!, color)}`, width, `${indent}  `));
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const indent = numbered[1]!;
      const marker = `${numbered[2]}.`;
      out.push(...wrapLine(`${indent}${paint(marker, 'cyan', color)} ${inline(numbered[3]!, color)}`, width, `${indent}${' '.repeat(marker.length + 1)}`));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(...wrapLine(`${paint('▏', 'dim', color)} ${paint(inline(quote[1]!, color), 'italic', color)}`, width, '  '));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(paint('─'.repeat(Math.max(3, Math.min(40, width || 40))), 'dim', color));
      continue;
    }
    out.push(...wrapLine(inline(line, color), width));
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
