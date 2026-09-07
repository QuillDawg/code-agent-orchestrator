import path from 'node:path';

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

export function createRunPaths(repositoryRoot: string): RunPaths {
  const root = path.join(repositoryRoot, ORCHESTRATOR_DIR);
  const runsDir = path.join(root, 'runs');
  const runDir = (runId: string): string => path.join(runsDir, safeSegment(runId));
  const taskDir = (runId: string, taskId: string): string => path.join(runDir(runId), 'tasks', safeSegment(taskId));
  const attemptDir = (runId: string, taskId: string, attempt: number): string =>
    path.join(taskDir(runId, taskId), 'attempts', String(attempt));
  return {
    root,
    runsDir,
    latestFile: path.join(root, 'latest'),
    runDir,
    workflowFile: (runId) => path.join(runDir(runId), 'workflow.json'),
    eventsFile: (runId) => path.join(runDir(runId), 'events.jsonl'),
    liveFile: (runId) => path.join(runDir(runId), 'live.json'),
    lockFile: (runId) => path.join(runDir(runId), 'lock.json'),
    runLogFile: (runId) => path.join(runDir(runId), 'orchestrator.log'),
    reportFile: (runId) => path.join(runDir(runId), 'report.md'),
    taskDir,
    resultFile: (runId, taskId) => path.join(taskDir(runId, taskId), 'result.json'),
    contextFile: (runId, taskId) => path.join(taskDir(runId, taskId), 'context.md'),
    attemptDir,
    diffPatchFile: (runId, taskId, attempt) => path.join(attemptDir(runId, taskId, attempt), 'diff.patch'),
    diffJsonFile: (runId, taskId, attempt) => path.join(attemptDir(runId, taskId, attempt), 'diff.json'),
  };
}
