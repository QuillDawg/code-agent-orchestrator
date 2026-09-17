/**
 * What the workspace did to the terminal, and how to undo it from anywhere (spec §2.4).
 *
 * Ink puts the terminal back on unmount, which covers every ordinary exit. This module is for the exits that
 * are not ordinary: an uncaught exception, a force-kill, a second Ctrl+C. All of them print something and
 * leave — and printing onto the alternate screen writes the one message that matters onto a buffer that is
 * about to be thrown away, which is how a crash becomes "cao just vanished".
 *
 * It is a module-level flag rather than a handle passed around because the crash handler is installed in
 * `bin.ts` before anything knows whether a workspace will ever be mounted, and it has to work whether or not
 * one was.
 */

/** Leave the alternate screen, and show the cursor Ink hid. */
export const LEAVE_ALT_SCREEN = '[?1049l';
export const SHOW_CURSOR = '[?25h';

/** The minimum of `process` this module touches, so a test can hand it a double. */
export interface TerminalStreams {
  stdout: { write(chunk: string): unknown };
  stdin?: { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
}

let altScreenActive = false;

/** Called by the workspace when it enters (`true`) or leaves (`false`) the alternate screen. */
export function markAltScreen(active: boolean): void {
  altScreenActive = active;
}

/** Whether a workspace currently has the alternate screen. */
export function altScreenIsActive(): boolean {
  return altScreenActive;
}

/**
 * Put the terminal back: leave the alternate screen if the workspace took it, show the cursor, and drop raw
 * mode so the shell that gets the terminal back can be typed into.
 *
 * Safe to call twice and safe to call when no workspace was ever mounted — the alternate screen is left only
 * if this process entered it, and every step is best effort because the caller is usually on its way out.
 */
export function restoreTerminal(streams: TerminalStreams = process as unknown as TerminalStreams): void {
  try {
    if (streams.stdin?.isTTY && streams.stdin.setRawMode) streams.stdin.setRawMode(false);
  } catch {
    /* the stream is already gone; there is nothing left to restore */
  }
  try {
    streams.stdout.write(`${altScreenActive ? LEAVE_ALT_SCREEN : ''}${SHOW_CURSOR}`);
  } catch {
    /* same */
  }
  altScreenActive = false;
}
