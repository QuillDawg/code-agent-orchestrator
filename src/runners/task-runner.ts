import type {
  TaskResult,
  RunnerUsage,
  ResolvedTask,
  AttemptOutcome,
  TranscriptEntry,
  FileOp,
  Interaction,
  InteractionAnswer,
  PromptDelivery,
  RunnerFailure,
} from 'code-agent-orchestrator-protocol';
import type { PreflightProblem } from './preflight.js';

/**
 * Steering, the runner-neutral half (spec §3.5, `[D23]`, `[D24]`).
 *
 * Only two transports have a live channel into a turn that is already running — Claude with stdin open and
 * the Codex app-server — and each of them says something different about what became of a message. These
 * three shapes are the whole vocabulary the orchestrator needs: no agent name reaches `src/workflow/`.
 */

/** How a message got to (or failed to get to) the worker; the same values `PromptDelivery.transport` takes. */
export type PromptTransport = PromptDelivery['transport'];

/**
 * What the sender believed about the turn it is steering.
 *
 * `id` is not a belief but the delivery this text belongs to: it is quoted back on every later state change
 * (`RunnerHooks.onSteerUpdate`), which is what lets a transport answer `queued` now and `accepted` when the
 * CLI finally acknowledges — without the orchestrator having to guess which message an echo answered.
 */
export interface SteerExpectation {
  /** The `PromptDelivery.id` this text is being sent for. */
  id: string;
  /** The turn the sender believed was running. A transport that can check refuses once it has moved on. */
  turnId?: string;
}

/**
 * What one `steer` did, in the vocabulary `PromptDelivery` is persisted in.
 *
 * `rejected` is the transport's own answer (the app-server's sentence, verbatim); `failed` means the channel
 * died before the worker could take the message; `queued` means it is on its way and a later update will say
 * whether it arrived.
 */
export interface SteerResult {
  transport: PromptTransport;
  state: Extract<PromptDelivery['state'], 'queued' | 'accepted' | 'rejected' | 'failed'>;
  /** A sentence an operator can act on — never an error code. */
  reason?: string;
  turnId?: string;
}

/**
 * The live half of a running attempt: what an attempt can still be told while it runs.
 *
 * A runner offers one through `RunnerHooks.onChannel` the moment the channel exists, and the orchestrator
 * drops it when the attempt ends. An attempt that never offers one has no live channel at all, which is
 * reported as `transport: 'none'` and sends the §3.5 matrix to stop-and-continue.
 */
export interface AttemptChannel {
  steer(text: string, expected: SteerExpectation): Promise<SteerResult>;
}

/** What a transport can do at all, independent of any one attempt (`TaskRunner.capabilities`). */
export interface RunnerCapabilities {
  /**
   * True when *some* transport of this runner can steer a running turn. Whether the attempt in front of you
   * can is a different question, and only the presence of an `AttemptChannel` answers it: a Claude attempt
   * in deny mode and a Codex attempt on `exec` both run under a runner whose flag is true.
   */
  steer: boolean;
}

export interface RunnerInput {
  runId: string;
  task: ResolvedTask;
  attempt: number;
  /** Full prompt (context section + task prompt), already rendered. */
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  /** Directory the runner may use for its own artifacts (prompt.md, stdout.log, ...). */
  attemptDir: string;
  /** Optional override for the completion-contract system prompt (e.g. merge attempts). */
  systemPromptAddendum?: string;
  /** Continue this worker session instead of starting a fresh one (transient API error recovery). */
  resumeSessionId?: string;
  /** True when a human can answer permission prompts and questions (a dashboard is attached). */
  canInteract?: boolean;
}

export interface RunnerHooks {
  /** One-line status of what the worker is doing right now. */
  onActivity(line: string): void;
  /** Raw lines that were not understood (and stderr). */
  onOutput(stream: 'stdout' | 'stderr', line: string): void;
  onProcess(info: { pid: number; sessionId?: string }): void;
  /**
   * A live channel into this attempt has opened (§3.5). Called at most once, before the channel is useful;
   * the orchestrator forgets it when the attempt ends. Optional for hosts that never steer.
   */
  onChannel?(channel: AttemptChannel): void;
  /**
   * A delivery `steer` answered `queued` has moved on: `accepted` once the worker acknowledged it, `failed`
   * if the channel died first. `id` is the `SteerExpectation.id` the message was sent under.
   */
  onSteerUpdate?(id: string, update: SteerResult): void;
  /** A typed transcript entry (agent text, tool call, result, ...). */
  onTranscript(entry: TranscriptEntry): void;
  /** Live usage for the attempt: cumulative tokens/cost plus the current context size. */
  onUsage(usage: RunnerUsage): void;
  /** The worker edited or wrote a file. */
  onFileChange(change: { path: string; op: FileOp }): void;
  /** Something about the session the operator should know (shown as a run warning); optional for hosts that do not care. */
  onWarning?(message: string): void;
  /**
   * The worker is blocked on a human. Resolves with the answer to send back. `signal` aborts when the
   * runner withdraws the request (worker cancelled it, process exited); the promise must still settle.
   */
  onInteraction(interaction: Interaction, signal: AbortSignal): Promise<InteractionAnswer>;
}

export type RunnerOutcome =
  | { kind: 'result'; result: TaskResult; exitCode: number | null; usage?: RunnerUsage; rawResultText?: string }
  | {
      kind: 'error';
      outcome: Extract<AttemptOutcome, 'timeout' | 'crash' | 'api_error' | 'invalid_result' | 'cancelled' | 'config_error'>;
      message: string;
      exitCode?: number | null;
      signal?: string | null;
      usage?: RunnerUsage;
      failure?: RunnerFailure;
    };

/** A runner executes exactly one attempt in a fresh, isolated worker session and must never reject. */
export interface TaskRunner {
  readonly name: string;
  /** What this runner's transports can do (§3.5). Absent means nothing beyond running an attempt. */
  readonly capabilities?: RunnerCapabilities;
  run(input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome>;
  /**
   * Everything about the installed CLI that can be decided before the first worker is spawned: is it new
   * enough, does it advertise what these tasks selected. The scheduler calls this once per run, for the
   * tasks that would use this runner, and fails the ones it names without spending an attempt on them.
   * Optional: a runner that has nothing to check simply omits it.
   */
  preflight?(tasks: ResolvedTask[]): Promise<PreflightProblem[]>;
}

export class RunnerRegistry {
  private readonly runners = new Map<string, TaskRunner>();

  register(runner: TaskRunner): this {
    this.runners.set(runner.name, runner);
    return this;
  }

  get(name: string): TaskRunner {
    const r = this.runners.get(name);
    if (!r) throw new Error(`Unknown runner "${name}". Registered: ${[...this.runners.keys()].join(', ') || 'none'}`);
    return r;
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  names(): string[] {
    return [...this.runners.keys()];
  }
}
