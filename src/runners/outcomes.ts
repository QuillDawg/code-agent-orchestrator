/**
 * The one outcome map (H4.4).
 *
 * Both runners answer the same question — "what does this situation mean for the attempt?" — and used to
 * answer it in two places, differently. `OUTCOME_MAP` is that answer, written down once: the table in
 * `docs/agent-cli-integration.md` is generated from it and checked against it by a test, so a runner, the
 * documentation and the reader cannot drift apart.
 *
 * The constructors below are the only way either runner builds the rows that used to differ. Everything
 * agent-specific (which stderr means a rejected flag, which YAML key produced a flag) stays in
 * `codex/failure.ts` and `claude/transient.ts`; this module owns the shape and the wording.
 */
import type { AttemptOutcome } from '../types/run.js';
import type { RunnerFailure, RunnerOutcome } from './task-runner.js';
import { firstLine, truncate } from '../util/misc.js';
import { sanitizeText } from '../util/text.js';

/** The outcomes a runner may report for an attempt that produced no `TaskResult`. */
export type ErrorOutcome = Extract<AttemptOutcome, 'timeout' | 'crash' | 'api_error' | 'invalid_result' | 'cancelled' | 'config_error'>;

export interface OutcomeRule {
  /** Stable id, used by tests and by the runners to name the row they are applying. */
  id: string;
  /** What happened, in the words the documentation uses. */
  situation: string;
  outcome: ErrorOutcome;
  /** What the scheduler does next, and anything the attempt must record. */
  follows: string;
}

/**
 * Every situation in which an attempt ends without a result, and the outcome both runners must report for
 * it. Order is the documented order.
 */
export const OUTCOME_MAP: readonly OutcomeRule[] = [
  { id: 'no_result', situation: 'exit 0, no result', outcome: 'invalid_result', follows: 'the same session is asked for the completion object (`retry.resultNudges`), then the task is retried' },
  { id: 'invalid_result', situation: 'result present, fails the contract', outcome: 'invalid_result', follows: 'same as above: nudge, then retry' },
  { id: 'api_error', situation: 'transient network/API error', outcome: 'api_error', follows: 'backoff, then the session is resumed; free up to `retry.transientAttempts`' },
  { id: 'config_error', situation: 'argument or schema rejection', outcome: 'config_error', follows: 'the task fails immediately without spending `retry.attempts`; `onFailure` decides the run' },
  { id: 'killed', situation: 'process killed externally', outcome: 'crash', follows: '`retry.attempts` as usual; the signal is recorded on the attempt and named in the message' },
  { id: 'open_tool', situation: 'worker still holding an unanswered tool at exit', outcome: 'crash', follows: '`retry.attempts` as usual; the transcript ends with the tool call that was never answered' },
  { id: 'cancelled', situation: 'abort from the orchestrator', outcome: 'cancelled', follows: 'the task is cancelled, not retried' },
  { id: 'timeout', situation: 'task timeout', outcome: 'timeout', follows: 'the process tree is killed, then `retry.attempts` as usual' },
];

/** The map as the markdown table `docs/agent-cli-integration.md` carries; the doc test compares against it. */
export function outcomeMapTable(): string {
  const rows = OUTCOME_MAP.map((rule) => `| ${rule.situation} | \`${rule.outcome}\` | ${rule.follows} |`);
  return ['| Situation | Outcome | What follows |', '|---|---|---|', ...rows].join('\n');
}

/** A CLI refusing what CAO sent it: the flag, schema or protocol field, and the YAML key behind it. */
export interface ConfigRejection {
  /** The rejection in the CLI's own words. */
  detail: string;
  /** The flag, schema or protocol field the CLI named. */
  option?: string;
  /** The workflow key that produced it (`codex.approvals`, `claude.extraArgs`, ...), when it can be traced. */
  key?: string;
}

const MAX_DETAIL = 400;

/**
 * The operator-facing sentence for a configuration rejection: what was refused, where it came from, and
 * that waiting or retrying will not help. Every one of these was a "constant failure" that burnt the whole
 * retry budget before anybody saw the first line of it.
 */
export function configErrorMessage(agent: string, rejection: ConfigRejection): string {
  const detail = truncate(sanitizeText(firstLine(rejection.detail)).trim(), MAX_DETAIL) || 'the CLI rejected the request';
  const named = rejection.option ? ` The offending option is \`${rejection.option}\`.` : '';
  const from = rejection.key ? ` It comes from ${rejection.key}.` : '';
  return `${agent} rejected the configuration this run sent it: ${detail}.${named}${from} This is a configuration error: no retry can change it, so none was spent. Fix the workflow and run again.`;
}

/** The `config_error` row of the map, for either runner. */
export function configErrorOutcome(
  agent: string,
  rejection: ConfigRejection,
  extras: Omit<Extract<RunnerOutcome, { kind: 'error' }>, 'kind' | 'outcome' | 'message' | 'failure'> & { failure?: Partial<RunnerFailure> } = {},
): Extract<RunnerOutcome, { kind: 'error' }> {
  const { failure, ...rest } = extras;
  return {
    kind: 'error',
    outcome: 'config_error',
    message: configErrorMessage(agent, rejection),
    ...rest,
    failure: { ...failure, retryable: false, providerCode: failure?.providerCode ?? 'configurationRejected' },
  };
}

/** The `killed` row: a signal is the most useful thing the message can carry, so it always names it. */
export function killedMessage(agent: string, exitCode: number | null | undefined, signal: string | null | undefined, detail = ''): string {
  const how = signal ? `was killed by signal ${signal}` : `exited with code ${exitCode ?? 'null'}`;
  return `${agent} ${how}${detail ? `\n${detail}` : ''}`;
}

/** The `open_tool` row: the attempt ended while the worker was still inside a tool call. */
export function openToolMessage(agent: string, calls: string[]): string {
  const list = calls.map((call) => `"${truncate(sanitizeText(firstLine(call)).trim(), 120)}"`).join(', ');
  return `${agent} exited while still waiting on ${calls.length === 1 ? 'a tool call' : `${calls.length} tool calls`} it had started: ${list}. The work in that call was lost; the attempt's transcript ends with it.`;
}
