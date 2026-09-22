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
  | 'treeLast'
  | 'scrollUp'
  | 'scrollDown'
  | 'scrollTrack'
  | 'scrollThumb'
  | 'cursor'
  | 'focus'
  | 'pulse'
  | 'vrule'
  | 'teeDown'
  | 'teeUp'
  | 'barFull'
  | 'barEmpty'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'plusMinus';

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
  scrollUp: '▲',
  scrollDown: '▼',
  scrollTrack: '│',
  scrollThumb: '█',
  cursor: '▶',
  focus: '▸',
  pulse: '▪',
  vrule: '│',
  teeDown: '┬',
  teeUp: '┴',
  barFull: '█',
  barEmpty: '░',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  plusMinus: '±',
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
  scrollUp: '^',
  scrollDown: 'v',
  scrollTrack: '|',
  scrollThumb: '#',
  cursor: '>',
  focus: '>',
  pulse: '*',
  vrule: '|',
  teeDown: '+',
  teeUp: '+',
  barFull: '#',
  barEmpty: '-',
  up: '^',
  down: 'v',
  left: '<',
  right: '>',
  plusMinus: '+/-',
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

/**
 * The frames of the running spinner, in whichever alphabet this terminal can draw. Braille dots are the
 * nicest animation a terminal has and mojibake in a console that cannot render them, where a task that is
 * running is the row an operator is looking at.
 */
const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_ASCII = ['|', '/', '-', '\\'];

export function spinnerFrames(): readonly string[] {
  return useUnicode() ? SPINNER_UNICODE : SPINNER_ASCII;
}

/** A horizontal rule `width` columns wide, in whichever character the terminal can draw. */
export function rule(width: number): string {
  return glyph('rule').repeat(Math.max(0, width));
}

/**
 * A labelled divider, `── label ───────`, exactly `width` columns wide.
 *
 * Pure: it is told its width rather than reading the terminal, because the workspace sizes every row from
 * `useWindowSize()` and nothing under `src/tui/` may consult `process.stdout` for itself. `src/cli/util.ts`
 * wraps this for the command line, where reading the terminal *is* the right thing to do.
 */
export function labelledRule(label: string, width: number): string {
  const total = Math.max(0, width);
  const text = label.trim();
  if (!text) return rule(total);
  // Two for the spaces either side of the label, three so the lead-in still reads as a rule. Below that
  // there is no room for a divider that is also a label, and the label is what carries the meaning.
  const lead = 2;
  if (total < text.length + lead + 3) return text.slice(0, total);
  return `${rule(lead)} ${text} ${rule(Math.max(0, total - lead - text.length - 2))}`;
}
