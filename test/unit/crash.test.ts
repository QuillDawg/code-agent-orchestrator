/** The process-level crash handlers `bin.ts` installs before it parses anything. */
import { describe, it, expect, afterEach } from 'vitest';
import { crashMessage, installCrashHandlers, setCrashPersist, INTERNAL_ERROR_EXIT, type CrashTarget } from '../../src/cli/crash.js';
import { markAltScreen, restoreTerminal, LEAVE_ALT_SCREEN, SHOW_CURSOR } from '../../src/tui/terminal.js';

function fakeProcess() {
  const listeners = new Map<string, (reason: unknown) => void>();
  const written: string[] = [];
  const drawn: string[] = [];
  const exits: number[] = [];
  const rawModes: boolean[] = [];
  const target: CrashTarget = {
    on(event, listener) {
      listeners.set(event, listener);
      return target;
    },
    stderr: { write: (chunk: string) => written.push(chunk) },
    stdout: { write: (chunk: string) => drawn.push(chunk) },
    stdin: { isTTY: true, setRawMode: (mode: boolean) => rawModes.push(mode) },
    exit: ((code: number) => {
      exits.push(code);
      // The real `process.exit` never returns; the double has to keep going so the test can assert.
      return undefined as never;
    }) as CrashTarget['exit'],
  };
  return { target, listeners, written, drawn, exits, rawModes };
}

afterEach(() => {
  markAltScreen(false);
  setCrashPersist(undefined);
});

describe('crash handlers', () => {
  it('formats an Error with its stack and anything else with String()', () => {
    const err = new Error('boom');
    expect(crashMessage('Uncaught exception', err)).toBe(`\nUncaught exception: ${err.stack}\n`);
    const stackless = new Error('no stack');
    stackless.stack = undefined;
    expect(crashMessage('Unhandled error', stackless)).toBe('\nUnhandled error: no stack\n');
    expect(crashMessage('Unhandled error', 'a string reason')).toBe('\nUnhandled error: a string reason\n');
    expect(crashMessage('Unhandled error', undefined)).toBe('\nUnhandled error: undefined\n');
  });

  it('registers both handlers, each printing one message and exiting 70', () => {
    const { target, listeners, written, exits } = fakeProcess();
    installCrashHandlers(target);
    expect([...listeners.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);

    listeners.get('unhandledRejection')!(new Error('rejected'));
    listeners.get('uncaughtException')!(new Error('thrown'));

    expect(written[0]).toContain('Unhandled error: Error: rejected');
    expect(written[1]).toContain('Uncaught exception: Error: thrown');
    expect(written.every((line) => line.startsWith('\n') && line.endsWith('\n'))).toBe(true);
    expect(exits).toEqual([INTERNAL_ERROR_EXIT, INTERNAL_ERROR_EXIT]);
    expect(INTERNAL_ERROR_EXIT).toBe(70);
  });

  // §2.4: the stack trace has to land in the shell's scrollback, not on the alternate screen the workspace
  // is about to take with it.
  it('leaves the alternate screen and drops raw mode before it prints', () => {
    const { target, listeners, drawn, rawModes, exits } = fakeProcess();
    installCrashHandlers(target);
    markAltScreen(true);
    let printedWhileOnAltScreen: boolean | undefined;
    target.stderr.write = () => {
      printedWhileOnAltScreen = drawn.length === 0;
      return 0;
    };

    listeners.get('uncaughtException')!(new Error('thrown'));

    expect(drawn.join('')).toContain(LEAVE_ALT_SCREEN);
    expect(drawn.join('')).toContain(SHOW_CURSOR);
    expect(rawModes).toEqual([false]);
    expect(printedWhileOnAltScreen, 'the message was printed before the terminal was restored').toBe(false);
    expect(exits).toEqual([INTERNAL_ERROR_EXIT]);
  });

  it('does not leave the alternate screen when no workspace took it', () => {
    const { target, listeners, drawn } = fakeProcess();
    installCrashHandlers(target);
    listeners.get('uncaughtException')!(new Error('thrown'));
    expect(drawn.join('')).not.toContain(LEAVE_ALT_SCREEN);
    expect(drawn.join('')).toContain(SHOW_CURSOR);
  });

  it('gives the scheduler its last chance to persist, and survives one that throws', () => {
    const { target, listeners, exits } = fakeProcess();
    installCrashHandlers(target);
    const persisted: string[] = [];
    setCrashPersist(() => persisted.push('saved'));
    listeners.get('uncaughtException')!(new Error('thrown'));
    expect(persisted).toEqual(['saved']);

    setCrashPersist(() => {
      throw new Error('the run directory is gone');
    });
    listeners.get('unhandledRejection')!(new Error('rejected'));
    expect(exits).toEqual([INTERNAL_ERROR_EXIT, INTERNAL_ERROR_EXIT]);
  });

  it('restoreTerminal is safe to call twice and forgets the alternate screen after the first', () => {
    const drawn: string[] = [];
    const streams = { stdout: { write: (chunk: string) => drawn.push(chunk) } };
    markAltScreen(true);
    restoreTerminal(streams);
    restoreTerminal(streams);
    expect(drawn.filter((chunk) => chunk.includes(LEAVE_ALT_SCREEN))).toHaveLength(1);
  });
});
