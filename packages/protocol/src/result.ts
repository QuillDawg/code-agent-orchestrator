/** Structured result every worker must produce. This is the completion contract. */
export const TASK_RESULT_STATUSES = ['success', 'failed', 'blocked', 'needs_input', 'skipped'] as const;
export type TaskResultStatus = (typeof TASK_RESULT_STATUSES)[number];

export interface TaskResult {
  status: TaskResultStatus;
  summary: string;
  filesChanged: string[];
  commits: string[];
  decisions: string[];
  warnings: string[];
  followUp: string[];
  /** Free-form error/blocker description when status is not success. */
  error?: string;
  /** Free-form structured data a task may expose to downstream `when` conditions / context. */
  data?: Record<string, unknown>;
}

/** How a file changed between the two sides of an attempt's diff. `R` also covers copies. */
export type DiffFileStatus = 'A' | 'M' | 'D' | 'R';

export interface DiffFileRecord {
  path: string;
  /** Previous path; only set when `status` is `R`. */
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Contents of an attempt's `diff.json`: the per-file stat of everything that attempt changed. */
export interface AttemptDiff {
  schemaVersion: 1;
  /** Commit or tree object the attempt started from. */
  base?: string;
  /** Commit or tree object the attempt ended at. */
  head?: string;
  /** True when `diff.patch` was cut short at `git.maxDiffBytes`; `files` is always complete. */
  truncated: boolean;
  additions: number;
  deletions: number;
  files: DiffFileRecord[];
}

export interface GitInfo {
  branch?: string;
  headSha?: string;
  baseSha?: string;
  diffStat?: string;
  uncommittedFiles: string[];
  /** Per-file stat of the attempt's own changes; the same records as its `diff.json`. */
  files?: DiffFileRecord[];
  /** True when the captured `diff.patch` was truncated (`files` still lists everything). */
  diffTruncated?: boolean;
}

export interface RunnerUsage {
  sessionId?: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Size of the context sent on the latest model call (input + cache read + cache creation). */
  contextTokens?: number;
  contextWindow?: number;
  compactions?: number;
  /** Wall-clock time this attempt spent inside tool calls (paired call → result), when the agent reports tool ids. */
  toolMs?: number;
}

const ADDITIVE_USAGE: ReadonlySet<string> = new Set(['costUsd', 'durationMs', 'numTurns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'compactions', 'toolMs']);

/** Sum usage snapshots: additive fields add, everything else takes the later value. */
export function addUsage(...parts: Array<RunnerUsage | undefined>): RunnerUsage {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (v === undefined) continue;
      if (ADDITIVE_USAGE.has(k)) {
        const prev = out[k];
        out[k] = (typeof prev === 'number' ? prev : 0) + (v as number);
      } else out[k] = v;
    }
  }
  return out as RunnerUsage;
}

/** Result as persisted in tasks/<id>/result.json (contract + orchestrator enrichment). */
export interface EnrichedTaskResult extends TaskResult {
  taskId: string;
  attempt: number;
  git?: GitInfo;
  usage?: RunnerUsage;
  completedAt: string;
}

export const CONTEXT_FIELDS = [
  'summary',
  'filesChanged',
  'commits',
  'decisions',
  'warnings',
  'followUp',
  'error',
  'data',
  'git',
] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];
