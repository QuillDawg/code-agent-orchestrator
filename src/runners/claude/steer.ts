/**
 * Steering a live `claude -p --input-format stream-json` session (spec §3.5, §7.1, `[D23]`, `[D24]`).
 *
 * The whole mechanism is one line on the still-open stdin: a `user` message, which the CLI queues and turns
 * into a new turn once the one in flight ends. There is no interrupt in the protocol and no acknowledgment
 * either, so "did it arrive" has to be inferred, and this module owns that inference:
 *
 *  - with `--replay-user-messages`, the CLI echoes the message back and the echo *is* the acknowledgment;
 *  - without it, the only evidence is the session carrying on — the turn boundary, then the worker speaking
 *    again — so a delivery stays `queued` until both have been seen.
 *
 * Kept out of `claude-runner.ts` because it is a small state machine with four inputs, and a state machine
 * spread through a 200-line stdout switch is one nobody can check.
 */
import type { AttemptChannel, SteerExpectation, SteerResult } from '../task-runner.js';
import { encodeUserMessage } from './protocol.js';

export const CLAUDE_TRANSPORT = 'claude-stream' as const;

export interface ClaudeSteeringDeps {
  /** Write one line on the worker's stdin. False means stdin is closed or the process has gone. */
  write: (line: string) => boolean;
  /** Record the operator's message in the attempt's transcript, the moment it goes out. */
  record: (text: string, deliveryId: string) => void;
  /** A delivery that was answered `queued` has moved on. */
  update: (id: string, result: SteerResult) => void;
  /** The session was started with `--replay-user-messages`, so an echo will acknowledge each message. */
  replay: boolean;
}

interface Queued {
  id: string;
  text: string;
}

/**
 * The live channel of one Claude attempt. Created only for a session whose stdin stayed open (ask mode);
 * a deny-mode attempt has no channel at all, and the orchestrator reports `transport: 'none'` for it.
 */
export class ClaudeSteering implements AttemptChannel {
  private readonly deps: ClaudeSteeringDeps;
  /** Sent, not yet acknowledged. */
  private queued: Queued[] = [];
  /** Queued when the turn ended; waiting for the worker to speak again (the no-replay path). */
  private awaitingSpeech: Queued[] = [];
  /**
   * Messages the CLI has taken but not yet turned into a turn. Each one costs one `result` event, and stdin
   * may not be closed while any are outstanding: closing it is "no more input", and the queued turn would
   * never run.
   */
  private owedTurns = 0;
  private closed = false;

  constructor(deps: ClaudeSteeringDeps) {
    this.deps = deps;
  }

  /** Whether a message is still on its way to the worker — what keeps stdin open past a turn boundary. */
  get turnsOwed(): number {
    return this.owedTurns;
  }

  async steer(text: string, expected: SteerExpectation): Promise<SteerResult> {
    if (this.closed) {
      return { transport: CLAUDE_TRANSPORT, state: 'failed', reason: 'The Claude session has ended, so there is nothing left to steer.' };
    }
    if (!this.deps.write(encodeUserMessage(text))) {
      this.closed = true;
      return { transport: CLAUDE_TRANSPORT, state: 'failed', reason: 'The Claude session closed its input before the message could be written.' };
    }
    this.queued.push({ id: expected.id, text });
    this.owedTurns += 1;
    this.deps.record(text, expected.id);
    return {
      transport: CLAUDE_TRANSPORT,
      state: 'queued',
      reason: this.deps.replay
        ? 'Claude has the message and will start a new turn when this one ends.'
        : 'Claude has the message and will start a new turn when this one ends. This CLI does not echo user messages, so it can only be confirmed once the next turn begins.',
    };
  }

  /**
   * A `result` event: the turn in flight has ended. Returns true when stdin must stay open because a
   * message is still owed a turn.
   */
  turnEnded(): boolean {
    if (!this.deps.replay) {
      this.awaitingSpeech.push(...this.queued);
      this.queued = [];
    }
    // One owed turn means one *more* turn is coming after this boundary, so the answer is taken before the
    // decrement: a message acknowledged by its echo during turn 1 has still not had its own turn.
    if (this.owedTurns > 0) {
      this.owedTurns -= 1;
      return true;
    }
    return this.awaitingSpeech.length > 0;
  }

  /** The CLI echoed a user message back (`--replay-user-messages`). */
  replayed(text: string): void {
    if (!this.deps.replay) return;
    const index = this.queued.findIndex((q) => q.text === text);
    // The prompt that started the attempt is replayed too, and so is anything else CAO wrote; only a message
    // that answers a delivery still waiting is an acknowledgment of one.
    if (index < 0) return;
    const [accepted] = this.queued.splice(index, 1);
    this.deps.update(accepted!.id, { transport: CLAUDE_TRANSPORT, state: 'accepted', reason: 'Claude echoed the message back.' });
  }

  /** The worker spoke: on a CLI without the echo, the first one after a turn boundary is the acknowledgment. */
  spoke(): void {
    if (!this.awaitingSpeech.length) return;
    const accepted = this.awaitingSpeech;
    this.awaitingSpeech = [];
    for (const q of accepted) {
      this.deps.update(q.id, { transport: CLAUDE_TRANSPORT, state: 'accepted', reason: 'Claude started a new turn with the message.' });
    }
  }

  /** The process is gone. Anything still unacknowledged never reached the worker. */
  end(reason: string): void {
    this.closed = true;
    const lost = [...this.queued, ...this.awaitingSpeech];
    this.queued = [];
    this.awaitingSpeech = [];
    this.owedTurns = 0;
    for (const q of lost) this.deps.update(q.id, { transport: CLAUDE_TRANSPORT, state: 'failed', reason });
  }
}
