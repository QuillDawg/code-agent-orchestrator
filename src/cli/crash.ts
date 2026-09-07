/**
 * The last line of defence for the CLI process: an error that escapes every command handler.
 *
 * Both kinds are the same failure from a user's point of view — the orchestrator broke rather than the
 * workflow — so both print one message and exit 70, the internal-error code the rest of the CLI uses.
 */

/** The minimum of `process` these handlers touch, so a test can pass a double instead of the real one. */
export interface CrashTarget {
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

export function installCrashHandlers(target: CrashTarget = process as unknown as CrashTarget): void {
  target.on('unhandledRejection', (reason) => {
    target.stderr.write(crashMessage('Unhandled error', reason));
    target.exit(INTERNAL_ERROR_EXIT);
  });
  target.on('uncaughtException', (error) => {
    target.stderr.write(crashMessage('Uncaught exception', error));
    target.exit(INTERNAL_ERROR_EXIT);
  });
}
