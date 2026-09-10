/**
 * Text on its way to a human. Two concerns, both of them needed by the engine as well as the CLI:
 *
 * - Terminal-safe: anything an agent writes can reach a terminal — a transcript line, a permission prompt,
 *   a hook environment variable — and a terminal obeys escape sequences and carriage returns. These strip them.
 * - Operator-facing: the worker-facing instruction the scheduler appends to every deny message, and the
 *   helpers that take it back off for the surfaces that show an operator the same text.
 *
 * Lives in util/ rather than cli/ because the scheduler needs it too, and nothing in the engine should have to
 * reach into the CLI layer to make a string safe to show. The wire types these strings travel on live in
 * `code-agent-orchestrator-protocol`; this is presentation, so it stays here (spec §4.1).
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

/**
 * What every denied worker is told to do about it, appended to each deny message by the scheduler so the
 * instruction is written in one place rather than trusted to each dashboard, handler and timeout.
 *
 * It is addressed to the agent. An operator reading the same text back out of a paused task gets nothing
 * from it, so the surfaces that show them the question take it off again with `withoutWorkerInstructions`.
 */
export const NEEDS_INPUT_HINT = 'finish with status needs_input if you cannot continue';

/**
 * Agent-facing boilerplate removed, for text on its way to an operator rather than to a worker.
 *
 * The hint is usually appended to a sentence with `; `, and sometimes has a sentence of its own after it, so
 * the seam is closed up rather than left as the dangling `; ` and double space that taking the middle out of
 * a sentence would otherwise leave behind. Text that never carried the hint is returned as it was, down to
 * its final full stop: this runs over every operator-facing message, not only the ones an interaction wrote.
 */
export function withoutWorkerInstructions(text: string): string {
  if (!text.includes(NEEDS_INPUT_HINT)) return text;
  const parts = text.split(NEEDS_INPUT_HINT);
  let out = parts[0] ?? '';
  for (const part of parts.slice(1)) {
    const before = out.replace(/[;,\s]+$/, '');
    const after = part.replace(/^\s+/, '');
    // Punctuation the hint was standing in front of belongs to the sentence before it, so it stays put.
    out = before && after && !/^[.!?,;]/.test(after) ? `${before} ${after}` : `${before}${after}`;
  }
  return out.replace(/[;,.\s]+$/, '').trim();
}

/** One sentence of operator-facing text, terminated, so the next one does not run into it. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
