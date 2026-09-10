/**
 * The run-directory layout: `<repositoryRoot>/.orchestrator/runs/<runId>/...`.
 *
 * Spec §4.1 — this is in the protocol package so that nothing outside it ever builds one of these paths by
 * hand. A second implementation of the layout is the exact drift the package exists to prevent (§6.4.1): the
 * desktop app is handed a path, it does not concatenate `.orchestrator` with a run id.
 *
 * Segments are joined with `/` rather than `node:path`, because the package is browser-safe and carries no
 * Node builtins (§4.1). Every platform CAO runs on accepts `/` in a filesystem call, and a caller that wants
 * the native separator normalises the string it was handed.
 */

export const ORCHESTRATOR_DIR = '.orchestrator';

export interface RunPaths {
  root: string;
  runsDir: string;
  latestFile: string;
  runDir(runId: string): string;
  workflowFile(runId: string): string;
  eventsFile(runId: string): string;
  liveFile(runId: string): string;
  lockFile(runId: string): string;
  runLogFile(runId: string): string;
  reportFile(runId: string): string;
  taskDir(runId: string, taskId: string): string;
  resultFile(runId: string, taskId: string): string;
  contextFile(runId: string, taskId: string): string;
  attemptDir(runId: string, taskId: string, attempt: number): string;
  diffPatchFile(runId: string, taskId: string, attempt: number): string;
  diffJsonFile(runId: string, taskId: string, attempt: number): string;
}

/** Task ids are validated against a strict pattern, but guard anyway against path traversal. */
export function safeSegment(segment: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment) || segment.includes('..')) {
    throw new Error(`Unsafe path segment: "${segment}"`);
  }
  return segment;
}

/**
 * Append segments with `/`, keeping whatever separators the base already uses.
 *
 * A base that is nothing but separators (`/`, `C:/`) keeps one: `''` is not the filesystem root, and a bare
 * `C:` is drive-*relative* on Windows, which names a different directory than the drive root does.
 */
function join(base: string, ...segments: string[]): string {
  const trimmed = base.replace(/[\\/]+$/, '');
  let out = trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
  for (const segment of segments) out += out.endsWith('/') ? segment : `/${segment}`;
  return out;
}

export function createRunPaths(repositoryRoot: string): RunPaths {
  const root = join(repositoryRoot, ORCHESTRATOR_DIR);
  const runsDir = join(root, 'runs');
  const runDir = (runId: string): string => join(runsDir, safeSegment(runId));
  const taskDir = (runId: string, taskId: string): string => join(runDir(runId), 'tasks', safeSegment(taskId));
  const attemptDir = (runId: string, taskId: string, attempt: number): string =>
    join(taskDir(runId, taskId), 'attempts', String(attempt));
  return {
    root,
    runsDir,
    latestFile: join(root, 'latest'),
    runDir,
    workflowFile: (runId) => join(runDir(runId), 'workflow.json'),
    eventsFile: (runId) => join(runDir(runId), 'events.jsonl'),
    liveFile: (runId) => join(runDir(runId), 'live.json'),
    lockFile: (runId) => join(runDir(runId), 'lock.json'),
    runLogFile: (runId) => join(runDir(runId), 'orchestrator.log'),
    reportFile: (runId) => join(runDir(runId), 'report.md'),
    taskDir,
    resultFile: (runId, taskId) => join(taskDir(runId, taskId), 'result.json'),
    contextFile: (runId, taskId) => join(taskDir(runId, taskId), 'context.md'),
    attemptDir,
    diffPatchFile: (runId, taskId, attempt) => join(attemptDir(runId, taskId, attempt), 'diff.patch'),
    diffJsonFile: (runId, taskId, attempt) => join(attemptDir(runId, taskId, attempt), 'diff.json'),
  };
}
