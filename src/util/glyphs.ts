/**
 * Every text surface draws with the same small set of glyphs, and not every terminal can render them.
 * A Windows console left on a legacy code page, `TERM=dumb`, a CI log viewer or a file the output was
 * redirected into all turn `─ ✓ ▸` into mojibake or question marks, and the columns stop lining up.
 * So the glyphs are named here rather than spelled out at each call site, and one switch picks the
 * ASCII table instead. Every ASCII form is chosen so a table padded by printable width still aligns:
 * the ones that sit in a column are a single character.
 */

export type GlyphName =
  | 'rule'
  | 'ellipsis'
  | 'dash'
  | 'arrow'
  | 'subArrow'
  | 'retry'
  | 'merge'
  | 'hook'
  | 'pause'
  | 'bullet'
  | 'tool'
  | 'fileOp'
  | 'say'
  | 'thinking'
  | 'warning'
  | 'ok'
  | 'error'
  | 'treeFirst'
  | 'treeMid'
  | 'treeLast';

const UNICODE: Record<GlyphName, string> = {
  rule: '─',
  ellipsis: '…',
  dash: '—',
  arrow: '→',
  subArrow: '↳',
  retry: '↻',
  merge: '⇄',
  hook: '⚙',
  pause: '⏸',
  bullet: '·',
  tool: '▸',
  fileOp: '✎',
  say: '›',
  thinking: '✻',
  warning: '⚠',
  ok: '✓',
  error: '✗',
  treeFirst: '┌',
  treeMid: '├',
  treeLast: '└',
};

const ASCII: Record<GlyphName, string> = {
  rule: '-',
  ellipsis: '...',
  dash: '--',
  arrow: '->',
  subArrow: '->',
  retry: '~',
  merge: '><',
  hook: '*',
  pause: '||',
  bullet: '.',
  tool: '>',
  fileOp: '*',
  say: ':',
  thinking: '~',
  warning: '!',
  ok: 'v',
  error: 'x',
  treeFirst: '+',
  treeMid: '|',
  treeLast: '+',
};

const OFF = new Set(['', '0', 'false', 'no', 'off']);

function flag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return !OFF.has(value.trim().toLowerCase());
}

/**
 * Whether to draw with Unicode. `CAO_ASCII=1` forces plain text and `CAO_UNICODE=1` forces the glyphs
 * back on; otherwise the guess is the conservative one, because a wrong "yes" is unreadable output
 * while a wrong "no" is merely plainer output. The Windows terminals that are known to be UTF-8
 * announce themselves; the classic console does not, so it is assumed not to be.
 */
export function useUnicode(): boolean {
  const unicode = flag('CAO_UNICODE');
  if (unicode !== undefined) return unicode;
  const ascii = flag('CAO_ASCII');
  if (ascii !== undefined) return !ascii;
  const term = process.env.TERM;
  if (term === 'dumb' || term === 'linux') return false;
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION || process.env.ConEmuTask || process.env.TERM_PROGRAM || process.env.MSYSTEM || process.env.WSLENV || term);
}

export function glyph(name: GlyphName): string {
  return (useUnicode() ? UNICODE : ASCII)[name];
}

/** A horizontal rule `width` columns wide, in whichever character the terminal can draw. */
export function rule(width: number): string {
  return glyph('rule').repeat(Math.max(0, width));
}
