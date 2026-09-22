/**
 * What this run has cost so far, as the one cell the footer has room for (spec §3.6).
 *
 * Pure text, like `quota.ts` beside it, so the wording is asserted directly rather than through a rendered
 * frame. Two rules, and the second is the whole reason this file exists rather than an `addUsage` call at
 * the call site:
 *
 * - **A run with nothing measured says nothing.** Not `$0`: a fresh run has not spent nothing, it has not
 *   been measured yet, and a confident zero is the wrong answer to a question nobody has asked yet.
 * - **A total that is missing a contributor says so.** `costUsd` is written once, when an attempt's
 *   `result` event arrives, so a live Claude attempt has tokens and no cost — and Codex never reports a
 *   cost at all. `addUsage` sums what is there and cannot tell you what is not, so a run with three
 *   finished attempts and two in flight would show a confident total that is simply short. The `+` is what
 *   makes it a floor instead of a lie.
 *
 * Nothing here estimates a cost from tokens. That needs a price list `cao` would have to keep correct, and
 * a stale price is the same failure as a stale context window, which `models.ts` already refuses to guess.
 */
import type { WorkflowRun } from 'code-agent-orchestrator-protocol';
import { formatCost, formatTokens } from '../format.js';

export interface RunSpend {
  /** Every token class added together: the volume that actually moved. */
  tokens: number;
  /** The costs that were reported. Undefined when none were. */
  costUsd?: number;
  /** Something contributed tokens without a cost, so `costUsd` is a floor rather than a total. */
  partial: boolean;
  /** Nothing has been measured yet; the cell is omitted rather than showing a zero. */
  empty: boolean;
}

/** Fold every attempt of every task. Walked rather than `addUsage`d, for the `partial` flag. */
export function runSpend(run: WorkflowRun): RunSpend {
  let tokens = 0;
  let cost = 0;
  let costed = false;
  let partial = false;
  let measured = false;
  for (const task of run.workflow.tasks) {
    for (const attempt of run.tasks[task.id]?.attempts ?? []) {
      const usage = attempt.usage;
      if (!usage) continue;
      const attemptTokens =
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
      if (attemptTokens > 0) measured = true;
      tokens += attemptTokens;
      if (usage.costUsd !== undefined) {
        cost += usage.costUsd;
        costed = true;
      } else if (attemptTokens > 0) {
        // Tokens with no cost: a Claude attempt still running, or any Codex attempt.
        partial = true;
      }
    }
  }
  return {
    tokens,
    ...(costed ? { costUsd: cost } : {}),
    partial: partial && costed,
    empty: !measured && !costed,
  };
}

/**
 * The footer cells, most worth the space first, or empty when there is nothing honest to put there.
 *
 * Two cells rather than one string, because `fitCells` gives up whole cells: the cost is the number
 * somebody is watching and the token count is the one they can do without, so on a terminal with room for
 * one of them it should be the cost that stays. One string would have been all or nothing.
 *
 * `$1.84+` reads as "at least". It costs one column and is the only truthful shape available while an
 * attempt is still open, because `costUsd` does not exist until the attempt's result arrives.
 */
export function spendCells(spend: RunSpend): string[] {
  if (spend.empty) return [];
  const cells: string[] = [];
  if (spend.costUsd !== undefined) cells.push(`spend ${formatCost(spend.costUsd)}${spend.partial ? '+' : ''}`);
  if (spend.tokens > 0) cells.push(`${formatTokens(spend.tokens)} tok`);
  return cells;
}
