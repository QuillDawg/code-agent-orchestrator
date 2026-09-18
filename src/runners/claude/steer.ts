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
   * Messages the CLI has taken but not yet turned into a turn. Stdin may not be closed while any are
   * outstanding: closing it is "no more input", and the turn they are waiting for would never run.
   *
   * A set, not a count. §7.1 says a message written while a turn runs "starts a new turn when the current
   * one ends" - one turn, carrying whatever was queued by then - so the boundary that opens that turn owes
   * nothing further. Counting instead meant two messages steered into a single turn left a second turn owed
   * for ever: nothing would answer it, stdin was never closed, and the worker sat on its timeout with the
   * work already done.
   */
  private owed: Queued[] = [];
  private closed = false;

  constructor(deps: ClaudeSteeringDeps) {
    this.deps = deps;
  }

  /** Whether a message is still on its way to the worker — what keeps stdin open past a turn boundary. */
  get turnsOwed(): number {
    return this.owed.length;
  }

  async steer(text: string, expected: SteerExpectation): Promise<SteerResult> {
    if (this.closed) {
      return { transport: CLAUDE_TRANSPORT, state: 'failed', reason: 'The Claude session has ended, so there is nothing left to steer.' };
    }
    if (!this.deps.write(encodeUserMessage(text))) {
      this.closed = true;
      return { transport: CLAUDE_TRANSPORT, state: 'failed', reason: 'The Claude session closed its input before the message could be written.' };
    }
    const message = { id: expected.id, text };
    this.queued.push(message);
    this.owed.push(message);
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
    // Anything that was already waiting when this turn began has had a whole turn of its own now. On a CLI
    // with no echo the worker speaking is the usual evidence, but a turn that produced no assistant line
    // gives none - and an entry left here for ever kept stdin open just as surely as an owed turn did.
    this.accept('Claude started a new turn with the message.');
    if (!this.deps.replay) {
      this.awaitingSpeech.push(...this.queued);
      this.queued = [];
    }
    // The turn that starts after this boundary carries everything the CLI has taken, so nothing is owed
    // past it; stdin stays open for that one turn and no longer.
    if (this.owed.length > 0) {
      this.owed = [];
      return true;
    }
    return this.awaitingSpeech.length > 0;
  }

  /** Everything waiting on the worker's next word, acknowledged. */
  private accept(reason: string): void {
    if (!this.awaitingSpeech.length) return;
    const accepted = this.awaitingSpeech;
    this.awaitingSpeech = [];
    for (const q of accepted) this.deps.update(q.id, { transport: CLAUDE_TRANSPORT, state: 'accepted', reason });
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
    this.accept('Claude started a new turn with the message.');
  }

  /** The process is gone. Anything still unacknowledged never reached the worker. */
  end(reason: string): void {
    this.closed = true;
    const lost = [...this.queued, ...this.awaitingSpeech];
    this.queued = [];
    this.awaitingSpeech = [];
    this.owed = [];
    for (const q of lost) this.deps.update(q.id, { transport: CLAUDE_TRANSPORT, state: 'failed', reason });
  }
}
