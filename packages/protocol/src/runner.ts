/**
 * The one runner type that crosses the boundary. Spec §4.1 / §5.5: `run.ts` records it on every attempt, so
 * the move list does not close without it. The rest of `runners/task-runner.ts` is the CLI's own execution
 * interface and stays in `code-agent-orchestrator`.
 */

/** Provider-neutral diagnostics used for retry policy and operator-facing reports. */
export interface RunnerFailure {
  providerCode?: string;
  httpStatus?: number;
  requestId?: string;
  retryAfterMs?: number;
  retryable: boolean;
  sessionId?: string;
  /** The provider may have applied tools before the transport failed. */
  partialWork?: boolean;
}
