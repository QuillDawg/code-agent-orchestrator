/**
 * The run's own spend, as the footer says it (spec §3.6).
 *
 * The case that matters is `partial`. `costUsd` is written once, when an attempt's `result` event arrives,
 * and Codex never writes one at all — so a run with finished and live attempts together has a cost that is
 * a floor rather than a total, and a footer that showed it without the `+` would be confidently short.
 */
import { describe, it, expect } from 'vitest';
import type { RunnerUsage, WorkflowRun } from 'code-agent-orchestrator-protocol';
import { runSpend, spendCells } from '../../src/tui/workspace/spend.js';

const runWith = (attempts: Array<RunnerUsage | undefined>): WorkflowRun =>
  ({
    workflow: { tasks: attempts.map((_, i) => ({ id: `t${i}` })) },
    tasks: Object.fromEntries(attempts.map((usage, i) => [`t${i}`, { attempts: [{ number: 1, ...(usage ? { usage } : {}) }] }])),
  }) as unknown as WorkflowRun;

describe('what this run has spent', () => {
  it('says nothing at all before anything has been measured', () => {
    // Not "$0": a fresh run has not spent nothing, it has not been measured, and the two are different
    // answers to a question the operator has not asked yet.
    const spend = runSpend(runWith([undefined, undefined]));
    expect(spend.empty).toBe(true);
    expect(spendCells(spend)).toEqual([]);
  });

  it('shows tokens while an attempt is still running, because the cost does not exist yet', () => {
    const spend = runSpend(runWith([{ inputTokens: 20_000, outputTokens: 4000 }]));
    expect(spend.empty).toBe(false);
    expect(spend.costUsd).toBeUndefined();
    expect(spend.tokens).toBe(24_000);
    expect(spendCells(spend)).toEqual(['24.0k tok']);
  });

  it('adds up every token class, not just the ones that were billed as input', () => {
    const spend = runSpend(runWith([{ inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 4000 }]));
    expect(spend.tokens).toBe(4330);
  });

  it('gives a total without a plus when every contributor reported a cost', () => {
    const spend = runSpend(runWith([
      { inputTokens: 1000, outputTokens: 100, costUsd: 0.42 },
      { inputTokens: 1000, outputTokens: 100, costUsd: 0.42 },
    ]));
    expect(spend.partial).toBe(false);
    expect(spend.costUsd).toBeCloseTo(0.84);
    expect(spendCells(spend)).toEqual(['spend $0.84', '2.2k tok']);
  });

  it('marks the total a floor when one attempt has tokens and no cost', () => {
    const spend = runSpend(runWith([
      { inputTokens: 1000, outputTokens: 100, costUsd: 0.42 },
      { inputTokens: 1000, outputTokens: 100 },
    ]));
    expect(spend.partial).toBe(true);
    expect(spendCells(spend)[0]).toBe('spend $0.42+');
  });

  it('never claims a cost for a Codex-only run, which reports none', () => {
    const spend = runSpend(runWith([{ inputTokens: 5000, outputTokens: 500 }, { inputTokens: 5000, outputTokens: 500 }]));
    expect(spend.costUsd).toBeUndefined();
    // `partial` is about a cost that is short, and there is no cost at all here to be short.
    expect(spend.partial).toBe(false);
    expect(spendCells(spend)).toEqual(['11.0k tok']);
  });

  it('puts the cost before the tokens, so a narrow footer keeps the number being watched', () => {
    const spend = runSpend(runWith([{ inputTokens: 1_500_000, outputTokens: 400_000, costUsd: 12.5 }]));
    expect(spendCells(spend)).toEqual(['spend $12.50', '1.9M tok']);
  });
});
