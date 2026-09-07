/**
 * Terminal-safe text. Anything an agent writes can reach a terminal — a transcript line, a permission prompt,
 * a hook environment variable — and a terminal obeys escape sequences and carriage returns. These strip them.
 *
 * Lives in util/ rather than cli/ because the scheduler needs it too, and nothing in the engine should have to
 * reach into the CLI layer to make a string safe to show.
 */

/** Control characters are built from their code points: a literal one in the source is invisible and easily lost. */
const ch = (code: number): string => String.fromCharCode(code);
export const ESC = ch(27);
const BEL = ch(7);

/** Every escape sequence, not only SGR: OSC (terminated by BEL or ST), CSI, two-character escapes, stray ESC. */
const ESCAPE_RE = new RegExp(
  [`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, `${ESC}\\[[0-?]*[ -/]*[@-~]?`, `${ESC}[@-_]`, ESC].join('|'),
  'g',
);
/** C0 controls and DEL, except newline and tab. */
const CONTROL_RE = new RegExp(`[${ch(0)}-${ch(8)}${ch(11)}-${ch(31)}${ch(127)}]`, 'g');

/** Remove ANSI escape sequences, keeping every printable character (including carriage returns). */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE_RE, '');
}

/**
 * Make agent-controlled text safe to show a human. Escape sequences and bare carriage returns let a worker —
 * or a prompt injection steering it — repaint the line being read, including the permission prompt an
 * operator is about to answer, so they are dropped at every render boundary. The raw bytes still go to the
 * attempt's events.jsonl; only what reaches a terminal is cleaned.
 */
export function sanitizeText(text: string): string {
  return stripAnsi(text).replace(CONTROL_RE, '');
}
