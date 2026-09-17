/**
 * The last line of defence for the CLI process: an error that escapes every command handler.
 *
 * Both kinds are the same failure from a user's point of view — the orchestrator broke rather than the
 * workflow — so both print one message and exit 70, the internal-error code the rest of the CLI uses.
 *
 * The terminal is put back **before** the message is printed (§2.4). A workspace that crashed still has the
 * alternate screen and raw mode, so a stack trace written first lands on a buffer the terminal is about to
 * discard: the user sees `cao` disappear and nothing else. Leaving the alternate screen first puts the trace
 * in the scrollback of the shell they started from, where they can read it and paste it into a bug report.
 */
import { restoreTerminal, type TerminalStreams } from '../tui/terminal.js';

/** The minimum of `process` these handlers touch, so a test can pass a double instead of the real one. */
export interface CrashTarget extends TerminalStreams {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): unknown;
  stderr: { write(chunk: string): unknown };
  exit(code: number): never;
}

/** "The orchestrator itself failed" — the same code `program.ts` gives an error with no exit code of its own. */
export const INTERNAL_ERROR_EXIT = 70;

export function crashMessage(label: string, reason: unknown): string {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  return `\n${label}: ${detail}\n`;
}

/**
 * The run this process is executing, if it is executing one.
 *
 * A crash is the one exit that has no `finally` to run, so whatever the scheduler can write synchronously is
 * written from here or not at all (§2.4). It is a module-level slot rather than an argument because the
 * handlers are installed in `bin.ts`, long before a command decides whether it will execute anything.
 */
let lastChanceToPersist: (() => void) | undefined;

/** Register (or, with `undefined`, clear) the synchronous persist a crash should attempt before exiting. */
export function setCrashPersist(persist: (() => void) | undefined): void {
  lastChanceToPersist = persist;
}

export interface CrashHandlerOptions {
  /** Injected by tests; the default leaves the alternate screen and drops raw mode on `target`. */
  restore?: (target: CrashTarget) => void;
}

export function installCrashHandlers(target: CrashTarget = process as unknown as CrashTarget, opts: CrashHandlerOptions = {}): void {
  const restore = opts.restore ?? ((t: CrashTarget) => restoreTerminal(t));
  const crash = (label: string) => (reason: unknown) => {
    // The terminal first: a stack trace printed onto the alternate screen is a stack trace nobody reads.
    restore(target);
    target.stderr.write(crashMessage(label, reason));
    try {
      lastChanceToPersist?.();
    } catch {
      /* the run directory is unwritable, or the scheduler is already gone; the message above still stands */
    }
    target.exit(INTERNAL_ERROR_EXIT);
  };
  target.on('unhandledRejection', crash('Unhandled error'));
  target.on('uncaughtException', crash('Uncaught exception'));
}
