import type { TaskResult, RunnerUsage } from '../types/result.js';
import type { ResolvedTask } from '../types/workflow.js';
import type { AttemptOutcome } from '../types/run.js';
import type { TranscriptEntry, FileOp } from '../types/transcript.js';
import type { Interaction, InteractionAnswer } from '../types/interaction.js';

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
      outcome: Extract<AttemptOutcome, 'timeout' | 'crash' | 'api_error' | 'invalid_result' | 'cancelled'>;
      message: string;
      exitCode?: number | null;
      signal?: string | null;
      usage?: RunnerUsage;
    };

/** A runner executes exactly one attempt in a fresh, isolated worker session and must never reject. */
export interface TaskRunner {
  readonly name: string;
  run(input: RunnerInput, hooks: RunnerHooks): Promise<RunnerOutcome>;
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
