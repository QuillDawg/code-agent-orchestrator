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
/** Take it again, for a workspace coming back from an editor that owned the terminal (§3.4). */
export const ENTER_ALT_SCREEN = '[?1049h';
export const SHOW_CURSOR = '[?25h';

/** The minimum of `process` this module touches, so a test can hand it a double. */
export interface TerminalStreams {
  stdout: { write(chunk: string): unknown };
  stdin?: { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
}

/** The part of `process` that `armAltScreenRestore` registers on; a test hands it an `EventEmitter`. */
export interface ExitHooks {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
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

/**
 * Take the alternate screen and leave it again if the process dies without unmounting — a force-kill, a
 * `process.exit` from a signal path. Ink restores the primary buffer on unmount, which covers every
 * ordinary exit, and `installCrashHandlers` covers an uncaught error; this is the remainder.
 *
 * Every screen that takes the alternate buffer arms this, so that the remainder is covered wherever the
 * process happens to be when it goes: the workspace and the `cao ui` launcher alike (§2.4).
 */
export function armAltScreenRestore(streams?: TerminalStreams, hooks: ExitHooks = process): () => void {
  const restore = (): void => (streams ? restoreTerminal(streams) : restoreTerminal());
  markAltScreen(true);
  hooks.once('exit', restore);
  return () => {
    markAltScreen(false);
    hooks.removeListener('exit', restore);
  };
}

/**
 * Hand the terminal to something that needs to own it, then take it back (spec §3.4).
 *
 * `Ctrl+O` in the task editor opens `$VISUAL`/`$EDITOR` on the prompt, and a terminal editor cannot share a
 * screen with Ink: vim would draw into a buffer Ink repaints eight times a second. So the workspace steps
 * out of the way properly — out of raw mode, off the alternate screen, cursor visible — runs the action with
 * the terminal to itself, and puts everything back exactly as it found it.
 *
 * `finally` rather than `then`, and every step best effort: an editor that crashes must not leave the
 * operator in a raw-mode terminal with no cursor, which is a shell nobody can type into.
 */
export async function suspendTerminal<T>(action: () => Promise<T> | T, streams: TerminalStreams = process as unknown as TerminalStreams): Promise<T> {
  const wasAlt = altScreenIsActive();
  const setRawMode = streams.stdin?.isTTY ? streams.stdin.setRawMode?.bind(streams.stdin) : undefined;
  try {
    setRawMode?.(false);
  } catch {
    /* not a TTY any more; there is nothing to hand over */
  }
  try {
    streams.stdout.write(`${wasAlt ? LEAVE_ALT_SCREEN : ''}${SHOW_CURSOR}`);
  } catch {
    /* same */
  }
  try {
    return await action();
  } finally {
    try {
      if (wasAlt) streams.stdout.write(ENTER_ALT_SCREEN);
    } catch {
      /* the stream is gone; the process is on its way out anyway */
    }
    try {
      setRawMode?.(true);
    } catch {
      /* same */
    }
    markAltScreen(wasAlt);
  }
}
