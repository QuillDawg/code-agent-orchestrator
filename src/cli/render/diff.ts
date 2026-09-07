/**
 * Rendering for `cao diff` and the file-stat block in `cao task`, built from what an attempt captured in
 * `diff.json` and `diff.patch`.
 *
 * Colour is the only thing this adds to a patch. Without it every rendering is plain text: the patch comes
 * out exactly as git wrote it, so `git apply`, `delta` or an editor take the piped output unchanged.
 *
 * Colour is also where the escape sequences a worker wrote into a file — or into a file name — are dropped.
 * The two go together: a coloured rendering is already not the captured patch, and it is the one a human
 * looks at, while an uncoloured one is what a pipe gets and has to stay byte for byte what git wrote.
 */
import type { AttemptDiff, DiffFileRecord } from '../../types/result.js';
import { paint, sanitizeText, type Style } from '../color.js';

/** Metadata lines of a unified patch. Painted like git's `color.diff.meta`, not as additions or removals. */
const META =
  /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch$|literal \d|delta \d)/;

const STATUS_STYLE: Record<DiffFileRecord['status'], Style> = { A: 'green', M: 'yellow', D: 'red', R: 'cyan' };

/** The note `captureDiff` appends when a patch was cut at `git.maxDiffBytes`. */
const TRUNCATION_NOTE = /^\.\.\. diff truncated /;

/** A trailing CR is the first half of a CRLF line ending, not a cursor move an agent chose. */
const CR = String.fromCharCode(13);

/**
 * One patch line as it is safe to draw: escape sequences and control characters the worker put in the file
 * removed, the CRLF ending left where it was. Sanitizing before the prefix tests is deliberate — a line
 * beginning with an escape sequence is still an addition, and is painted as one.
 */
function safeLine(line: string): string {
  const crlf = line.endsWith(CR);
  return sanitizeText(crlf ? line.slice(0, -1) : line) + (crlf ? CR : '');
}

/**
 * Colour `+`, `-` and `@@` lines the way git does. Line endings are preserved byte for byte, so a coloured
 * patch still has its CRLFs and its final newline; the only escape sequences left are the ones added here.
 */
export function paintPatch(patch: string, color: boolean): string {
  if (!color || patch === '') return patch;
  return patch
    .split('\n')
    .map((raw) => {
      const line = safeLine(raw);
      // `+++`/`---` first: they start with a `+`/`-` but are file headers, not content.
      if (line.startsWith('+++') || line.startsWith('---')) return paint(line, 'bold');
      if (line.startsWith('@@')) return paint(line, 'cyan');
      if (line.startsWith('+')) return paint(line, 'green');
      if (line.startsWith('-')) return paint(line, 'red');
      if (META.test(line)) return paint(line, 'bold');
      return line;
    })
    .join('\n');
}

/** Normalise a path for comparison: `src\x.ts` and `./src/x.ts` both mean `src/x.ts`. */
export function normalizeDiffPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** True when a record is the file the user asked for, matching either side of a rename. */
export function recordMatchesFile(record: DiffFileRecord, file: string): boolean {
  const wanted = normalizeDiffPath(file);
  return normalizeDiffPath(record.path) === wanted || (record.oldPath !== undefined && normalizeDiffPath(record.oldPath) === wanted);
}

/**
 * Cut a patch down to the sections belonging to one file. Sections start at a `diff --git` line, which
 * cannot occur inside a hunk (content lines are prefixed with a space, `+` or `-`), so splitting on it is
 * exact. A truncation note is kept whichever section it followed.
 */
export function patchForFile(patch: string, file: string): string {
  const wanted = normalizeDiffPath(file);
  const sections: string[][] = [];
  const notes: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) sections.push([line]);
    else if (TRUNCATION_NOTE.test(line)) notes.push(line);
    else sections[sections.length - 1]?.push(line);
  }
  const kept = sections.filter((s) => {
    const { oldPath, newPath } = sectionPaths(s);
    return oldPath === wanted || newPath === wanted;
  });
  const lines = kept.flat();
  // Splitting kept the empty string the patch's final newline produced; put the note before it.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(...notes);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** The old and new path of one patch section, from its file headers, its rename lines or its `diff --git`. */
function sectionPaths(section: string[]): { oldPath?: string; newPath?: string } {
  let oldPath: string | undefined;
  let newPath: string | undefined;
  for (const line of section) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('--- ')) oldPath ??= headerPath(line.slice(4));
    else if (line.startsWith('+++ ')) newPath ??= headerPath(line.slice(4));
    else if (line.startsWith('rename from ')) oldPath ??= headerPath(line.slice('rename from '.length), false);
    else if (line.startsWith('rename to ')) newPath ??= headerPath(line.slice('rename to '.length), false);
  }
  if (oldPath === undefined && newPath === undefined) {
    // A binary or mode-only change has no `---`/`+++` pair; the `diff --git` line is all there is.
    return diffGitPaths(section[0] ?? '');
  }
  return { oldPath, newPath };
}

/** A C-quoted path argument: `"…"` with `\"` and `\\` escaped inside. */
const QUOTED = /^"(?:[^"\\]|\\[\s\S])*"/;

/**
 * The two path arguments of a `diff --git` line. Git C-quotes each side only if that side needs it, so
 * `diff --git a/plain.txt "b/na\303\257ve.txt"` is a real header and the sides have to be read
 * independently. A bare path may itself contain spaces, so when neither side is quoted the only thing to
 * go on is the `a/… b/…` split, which the greedy match resolves at the last ` b/`.
 */
function diffGitPaths(line: string): { oldPath?: string; newPath?: string } {
  const rest = line.startsWith('diff --git ') ? line.slice('diff --git '.length) : '';
  const quotedFirst = QUOTED.exec(rest);
  if (quotedFirst) return { oldPath: headerPath(quotedFirst[0]), newPath: headerPath(rest.slice(quotedFirst[0].length + 1)) };
  const quotedSecond = rest.indexOf(' "b/');
  if (quotedSecond > 0) return { oldPath: headerPath(rest.slice(0, quotedSecond)), newPath: headerPath(rest.slice(quotedSecond + 1)) };
  const m = /^(a\/.*) (b\/.*)$/.exec(rest);
  return m ? { oldPath: headerPath(m[1]!), newPath: headerPath(m[2]!) } : {};
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → undefined; a C-quoted path is unquoted first. */
function headerPath(raw: string, stripSide = true): string | undefined {
  if (raw === '/dev/null') return undefined;
  // Git disambiguates a bare path containing spaces by appending a tab on the `---`/`+++` lines. A path
  // that itself contains a tab is always quoted, so an unquoted header ends at its first tab.
  const quoted = QUOTED.exec(raw);
  const p = quoted ? unquoteCPath(quoted[0]) : raw.replace(/\t[\s\S]*$/, '');
  if (p === '/dev/null') return undefined;
  return normalizeDiffPath(stripSide ? p.replace(/^[ab]\//, '') : p);
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * Undo git's C-style quoting: `"caf\303\251.txt"` → `café.txt`. The octal escapes are the *bytes* of a
 * UTF-8 sequence, not code points, so they are collected as bytes and decoded once at the end — which is
 * why `JSON.parse` cannot do this job (it rejects `\303` outright).
 */
function unquoteCPath(quoted: string): string {
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    const simple = C_ESCAPES[next];
    // An escape git does not produce is taken literally, which is what git's own unquote does.
    bytes.push(...(simple === undefined ? Buffer.from(next, 'utf8') : [simple]));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `src/x.ts`, or `old.ts -> new.ts` for a rename; cleaned when the row is for a human to read. */
function statLabel(f: DiffFileRecord, sanitize: boolean): string {
  const label = f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
  return sanitize ? sanitizeText(label) : label;
}

/**
 * `A src/x.ts  +10 -2`, aligned, one line per file. Renames show both paths. A path is whatever the worker
 * named the file, so it is cleaned wherever the rendering is drawn rather than piped — which is what
 * `sanitize` says, and why it follows `color` unless a caller (`cao task`) always draws.
 */
export function renderStat(files: DiffFileRecord[], color = false, sanitize = color): string[] {
  const rows = files.map((f) => ({ file: f, label: statLabel(f, sanitize) }));
  const width = rows.reduce((w, r) => Math.max(w, r.label.length), 0);
  return rows.map(({ file, label }) => {
    const counts = file.binary ? paint('binary', 'gray', color) : `${paint(`+${file.additions}`, 'green', color)} ${paint(`-${file.deletions}`, 'red', color)}`;
    return `${paint(file.status, STATUS_STYLE[file.status], color)} ${label.padEnd(width)}  ${counts}`;
  });
}

/** `3 files changed, +12 -4`, git's summary line for the same records. */
export function summarizeDiff(files: DiffFileRecord[]): string {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return `${files.length} file${files.length === 1 ? '' : 's'} changed, +${additions} -${deletions}`;
}

/** One path per line, the new path for a rename, exactly like `git diff --name-only`; `sanitize` as `renderStat`. */
export function renderNameOnly(files: DiffFileRecord[], sanitize = false): string[] {
  return files.map((f) => (sanitize ? sanitizeText(f.path) : f.path));
}

/**
 * The line `cao diff` prints above each task when it shows more than one: id, attempt, kind and the summary
 * counts. It starts with `#`, which `git apply` skips along with anything else that is not a patch line.
 */
export function diffHeader(taskId: string, attempt: number, diff: Pick<AttemptDiff, 'files' | 'truncated'>, kind?: string, color = false): string {
  const parts = [taskId, `attempt ${attempt}${kind === 'merge' ? ' (merge)' : ''}`, summarizeDiff(diff.files)];
  if (diff.truncated) parts.push('patch truncated');
  return `# ${paint(parts.join('  '), 'bold', color)}`;
}
