/**
 * The hunk pane's content: one file's sections of a captured patch, made safe to draw and then coloured.
 *
 * A patch carries whatever the worker wrote into the files it changed, so every line goes through
 * sanitizeText() before it reaches Ink — the same boundary a transcript line crosses. Tabs survive that (they
 * are legitimate content, not control codes) but a terminal expands them against its own stops, which would
 * push a diff line past the right edge while the pane still measured it as short; they are expanded here
 * instead, so the length the pane sees is the width the terminal draws.
 *
 * Building the lines is a pure function of `(patch, file, colour)` so the view can memoise it on those three
 * and not rebuild a three-hundred-hunk patch on every spinner tick.
 */
import { paint } from '../../cli/color.js';
import { sanitizeText } from '../../util/text.js';
import { paintPatch, patchForFile } from '../../cli/render/diff.js';

const TAB = String.fromCharCode(9);
/** The terminal default. A diff line's `+`/`-`/space marker shifts the stops by one, exactly as a pager does. */
export const TAB_STOP = 8;

/** Replace tabs with spaces up to the next tab stop, so a line's length is the width it will draw at. */
export function expandTabs(line: string, stop = TAB_STOP): string {
  if (!line.includes(TAB)) return line;
  const parts = line.split(TAB);
  let out = parts[0]!;
  for (let i = 1; i < parts.length; i++) out += ' '.repeat(stop - (out.length % stop)) + parts[i]!;
  return out;
}

export interface PaneContent {
  /** Ready to draw: sanitized, tabs expanded, coloured when colour is on. */
  lines: string[];
  /** Line indexes of the `@@` headers, where `n`/`p` jump to. */
  hunks: number[];
}

export const EMPTY_PANE: PaneContent = { lines: [], hunks: [] };

/** The file this pane is for; only what the rendering depends on, so the view can pass primitives. */
export interface PaneFile {
  path: string;
  binary: boolean;
}

/**
 * The pane's lines for one file of `patch`. Empty when the patch has no section for it — the caller says why,
 * because only it knows whether the attempt is still running, captured nothing, or was truncated.
 */
export function buildPane(patch: string, file: PaneFile, color: boolean): PaneContent {
  const section = patchForFile(patch, file.path).replace(/\n$/, '');
  if (section === '') return EMPTY_PANE;
  // Sanitize before painting: the patch's own escapes must go, the ones paintPatch adds must stay.
  const plain = dropRedundantHeaders(section.split('\n')).map((line) => expandTabs(sanitizeText(line)));
  // Painting line by line keeps the coloured array lined up with the plain one the hunk offsets index.
  const lines = plain.map((line) => paintPatch(line, color));
  if (!file.binary) return { lines, hunks: hunkStarts(plain) };
  // A binary section carries the whole file base85-encoded (`--binary`, so that `git apply` can replay it).
  // That is for git, not for a reader: keep the headers and say what the rest is.
  const payload = plain.findIndex((l) => l.startsWith('GIT binary patch') || l.startsWith('Binary files '));
  if (payload < 0) return { lines, hunks: [] };
  return { lines: [...lines.slice(0, payload + 1), paint('  (binary contents omitted; the captured patch carries them)', 'dim', color)], hunks: [] };
}

/** Header lines whose content the pane already shows above it: the paths, and the blob hashes behind them. */
const REDUNDANT_HEADER = /^(diff --git |index |--- |\+\+\+ )/;

/**
 * Drop the header lines that only repeat the file the pane's own title bar names. Four of the thirteen rows a
 * 24-row terminal gives the pane would otherwise go to `diff --git`, `index` and the `---`/`+++` pair. The
 * lines that say something the title bar does not — a new or deleted file mode, a rename, a binary marker —
 * stay. Only the part before the first `@@` is considered: a removed line reading `-- x` becomes `--- x`
 * inside a hunk, and that is content.
 */
function dropRedundantHeaders(lines: string[]): string[] {
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const end = firstHunk < 0 ? lines.length : firstHunk;
  return [...lines.slice(0, end).filter((l) => !REDUNDANT_HEADER.test(l)), ...lines.slice(end)];
}

/** Line indexes of every `@@` header in a rendered patch. */
function hunkStarts(lines: string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('@@')) out.push(i);
  });
  return out;
}
