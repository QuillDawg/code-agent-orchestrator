/** The process-level crash handlers `bin.ts` installs before it parses anything. */
import { describe, it, expect } from 'vitest';
import { crashMessage, installCrashHandlers, INTERNAL_ERROR_EXIT, type CrashTarget } from '../../src/cli/crash.js';

function fakeProcess() {
  const listeners = new Map<string, (reason: unknown) => void>();
  const written: string[] = [];
  const exits: number[] = [];
  const target: CrashTarget = {
    on(event, listener) {
      listeners.set(event, listener);
      return target;
    },
    stderr: { write: (chunk: string) => written.push(chunk) },
    exit: ((code: number) => {
      exits.push(code);
      // The real `process.exit` never returns; the double has to keep going so the test can assert.
      return undefined as never;
    }) as CrashTarget['exit'],
  };
  return { target, listeners, written, exits };
}

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
});
