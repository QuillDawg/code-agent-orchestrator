/** The attempt and interaction history helpers behind `cao task` and the dashboard detail view. */
import { describe, it, expect } from 'vitest';
import type { TaskAttempt, TaskRunState, TaskState } from '../../src/types/run.js';
import type { InteractionRecord } from '../../src/types/interaction.js';
import { attemptElapsedMs, attemptReason, attemptRows, elapsedCell, elapsedParts, interactionRows, resultNotes, taskElapsed, totalWaitedMs, waitedMs } from '../../src/tui/history.js';

/** 10:00:00Z plus `s` seconds, so every expectation below is a plain arithmetic difference. */
const at = (s: number): string => new Date(Date.UTC(2026, 8, 4, 10, 0, s)).toISOString();
const clock = (s: number): string => new Date(at(s)).toTimeString().slice(0, 8);
const now = new Date(at(600)).getTime();

const attempt = (over: Partial<TaskAttempt> & { number: number }): TaskAttempt => ({ kind: 'task', triggeredBy: 'initial', startedAt: at(0), cwd: '.', ...over });

const state = (over: Partial<TaskRunState> & { attempts: TaskAttempt[] }): TaskRunState => ({ id: 't', state: 'success' as TaskState, retryWindowStart: 1, ...over });

const record = (over: Partial<InteractionRecord> = {}): InteractionRecord => ({
  id: 'i1',
  kind: 'permission',
  toolName: 'Bash',
  title: 'Bash: npm publish',
  requestedAt: at(10),
  ...over,
});

describe('attempt history', () => {
  it('renders number, kind, trigger, clock, duration, outcome, exit code and cost', () => {
    const st = state({
      attempts: [attempt({ number: 1, startedAt: at(0), endedAt: at(152), exitCode: 1, outcome: 'api_error', usage: { costUsd: 0.1032 } })],
    });
    const [row] = attemptRows(st, now);
    expect(row!.line).toBe(`#1  task  initial  ${clock(0)} → ${clock(152)}  02m 32s  transient API error  exit 1  $0.10`);
    expect(row!.durationMs).toBe(152_000);
    expect(row!.notes).toEqual([]);
  });

  it('names the signal instead of the exit code, and labels a merge attempt', () => {
    const st = state({
      state: 'failed',
      attempts: [attempt({ number: 1, endedAt: at(30), kind: 'merge', triggeredBy: 'retry', exitCode: null, signal: 'SIGKILL', outcome: 'timeout' })],
    });
    expect(attemptRows(st, now)[0]!.line).toContain('merge resolution');
    expect(attemptRows(st, now)[0]!.line).toContain('timed out  signal SIGKILL');
    expect(attemptRows(st, now)[0]!.line).not.toContain('exit');
  });

  it('explains each retry with the previous outcome and the session it continued', () => {
    const attempts = [
      attempt({ number: 1, startedAt: at(0), endedAt: at(60), outcome: 'api_error', error: 'API Error: 500 Internal Server Error\nstack line' }),
      attempt({ number: 2, triggeredBy: 'retry', resumedSessionId: '8f2a1c34-dead-beef', startedAt: at(90), endedAt: at(150), outcome: 'invalid_result' }),
      attempt({ number: 3, triggeredBy: 'user_input', startedAt: at(200), endedAt: at(260), outcome: 'success' }),
    ];
    const rows = attemptRows(state({ attempts }), now);
    expect(rows[0]!.notes).toEqual(['API Error: 500 Internal Server Error']);
    expect(rows[1]!.notes).toEqual(['retried after attempt 1 transient API error, continuing session 8f2a1c34']);
    expect(rows[2]!.notes).toEqual(['restarted with your answer after attempt 2 invalid result']);
    expect(attemptReason(attempts, 0)).toBeUndefined();
  });

  it('never writes the word undefined, even for a trigger or outcome this build has no label for', () => {
    // A run directory written by another build, read by this one: `report.md` already shows the raw value
    // rather than an empty cell, and `cao task` and the dashboard detail view have to agree with it.
    const attempts = [
      attempt({ number: 1, endedAt: at(60), outcome: 'quarantined' as TaskAttempt['outcome'] }),
      attempt({ number: 2, triggeredBy: 'rescheduled' as TaskAttempt['triggeredBy'], startedAt: at(90), endedAt: at(150), outcome: 'success' }),
    ];
    const rows = attemptRows(state({ attempts }), now);
    expect(rows[0]!.line).toBe(`#1  task  initial  ${clock(0)} → ${clock(60)}  01m 00s  quarantined`);
    expect(rows[1]!.line).toContain('  rescheduled  ');
    for (const row of rows) expect(row.line).not.toContain('undefined');
    expect(rows[1]!.reason).toBe('started again after attempt 1 quarantined');
  });

  it('cuts a long error down to one line', () => {
    const st = state({ attempts: [attempt({ number: 1, endedAt: at(5), outcome: 'crash', error: `${'x'.repeat(400)}\nsecond` })] });
    const note = attemptRows(st, now)[0]!.notes[0]!;
    expect(note).toHaveLength(160);
    expect(note.endsWith('…')).toBe(true);
  });

  it('keeps counting the live attempt and stops at endedAt for a finished one', () => {
    const running = state({ state: 'running', currentAttempt: 2, attempts: [attempt({ number: 1, endedAt: at(60), outcome: 'api_error' }), attempt({ number: 2, triggeredBy: 'retry', startedAt: at(300) })] });
    expect(attemptElapsedMs(running, running.attempts[1]!, now)).toBe(300_000);
    expect(attemptRows(running, now)[1]!.line).toContain('05m 00s  running');
    // the same attempt on a task nobody is running any more has no duration to report
    const abandoned = state({ state: 'cancelled', attempts: running.attempts });
    expect(attemptElapsedMs(abandoned, abandoned.attempts[1]!, now)).toBeUndefined();
    expect(attemptRows(abandoned, now)[1]!.line).toContain('no outcome');
  });
});

describe('elapsed across attempts', () => {
  it('sums the attempts and shows the current one in parentheses', () => {
    const st = state({ state: 'running', currentAttempt: 2, attempts: [attempt({ number: 1, endedAt: at(60), outcome: 'api_error' }), attempt({ number: 2, triggeredBy: 'retry', startedAt: at(480) })] });
    // 60s of attempt 1 plus 120s of attempt 2 so far; the 7 minutes between them are the run's, not the task's
    expect(taskElapsed(st, now)).toEqual({ totalMs: 180_000, currentMs: 120_000, attempts: 2 });
    expect(elapsedParts(st, now)).toEqual({ total: '03m 00s', current: '02m 00s' });
    expect(elapsedCell(st, now)).toBe('03m 00s (02m 00s)');
  });

  it('leaves a single attempt unparenthesised and a task that never started blank', () => {
    expect(elapsedCell(state({ attempts: [attempt({ number: 1, endedAt: at(45) })] }), now)).toBe('00m 45s');
    expect(elapsedCell(state({ state: 'pending', attempts: [] }), now)).toBe('');
  });
});

describe('interaction history', () => {
  it('reports what was asked, how long the worker waited and how it was answered', () => {
    const st = state({
      attempts: [
        attempt({ number: 1, endedAt: at(300), interactions: [record({ answeredAt: at(52), answer: 'deny', source: 'timeout' })] }),
        attempt({ number: 2, triggeredBy: 'retry', startedAt: at(310), interactions: [record({ id: 'i2', kind: 'question', toolName: 'AskUserQuestion', title: 'Which database?', requestedAt: at(320), answeredAt: at(325), answer: 'answer', source: 'handler' })] }),
      ],
    });
    const rows = interactionRows(st, now);
    expect(rows[0]!.line).toBe(`#1  permission  Bash: npm publish  ${clock(10)}  waited 42s  denied (timed out)`);
    expect(rows[1]!.line).toBe(`#2  question  Which database?  ${clock(320)}  waited 5s  answered (in the dashboard)`);
    expect(totalWaitedMs(rows)).toBe(47_000);
  });

  it('shows an answer or a source it has no label for raw, rather than as undefined', () => {
    const st = state({
      attempts: [attempt({ number: 1, interactions: [record({ answeredAt: at(15), answer: 'defer' as InteractionRecord['answer'], source: 'relay' as InteractionRecord['source'] })] })],
    });
    const [row] = interactionRows(st, now);
    expect(row!.line).toContain('defer (relay)');
    expect(row!.line).not.toContain('undefined');
  });

  it('keeps counting an unanswered request and names the headless denial', () => {
    const st = state({ state: 'waiting', attempts: [attempt({ number: 1, interactions: [record(), record({ id: 'i2', answeredAt: at(11), answer: 'deny', source: 'no_handler' })] })] });
    const rows = interactionRows(st, now);
    expect(waitedMs(rows[0]!.record, now)).toBe(590_000);
    expect(rows[0]!.line).toContain('waited 9m  still waiting for you');
    expect(rows[1]!.line).toContain('denied (no dashboard attached)');
  });
});

describe('result notes', () => {
  it('lists decisions, warnings and follow-ups, skipping the empty ones', () => {
    expect(resultNotes({ status: 'success', summary: 's', filesChanged: [], commits: [], decisions: ['d1'], warnings: [], followUp: ['f1', 'f2'] })).toEqual([
      { label: 'decisions', items: ['d1'] },
      { label: 'follow-up', items: ['f1', 'f2'] },
    ]);
    expect(resultNotes(undefined)).toEqual([]);
  });
});
