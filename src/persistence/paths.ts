/**
 * The run-directory layout, spelled the way this platform spells a path.
 *
 * The layout itself lives in `code-agent-orchestrator-protocol` (spec §4.1), so that nothing outside it —
 * least of all the desktop app — ever builds one of these paths a second time. That package is browser-safe
 * and therefore joins on `/`. `cao` is a Node program whose paths a human reads in `cao status`, and whose
 * `reportPath` is persisted into `workflow.json`, so it normalises every string the package hands it back to
 * the platform separator: byte for byte what `path.join` produced before the move.
 *
 * This is one `path.normalize` per accessor, not a second copy of the layout. Which directories exist and
 * what they are called is still decided in exactly one place.
 */
import path from 'node:path';
import { createRunPaths, type RunPaths } from 'code-agent-orchestrator-protocol';

export function createNativeRunPaths(repositoryRoot: string): RunPaths {
  const p = createRunPaths(repositoryRoot);
  return {
    root: path.normalize(p.root),
    runsDir: path.normalize(p.runsDir),
    latestFile: path.normalize(p.latestFile),
    runDir: (runId) => path.normalize(p.runDir(runId)),
    workflowFile: (runId) => path.normalize(p.workflowFile(runId)),
    eventsFile: (runId) => path.normalize(p.eventsFile(runId)),
    liveFile: (runId) => path.normalize(p.liveFile(runId)),
    lockFile: (runId) => path.normalize(p.lockFile(runId)),
    runLogFile: (runId) => path.normalize(p.runLogFile(runId)),
    reportFile: (runId) => path.normalize(p.reportFile(runId)),
    requestsDir: (runId) => path.normalize(p.requestsDir(runId)),
    requestAcksDir: (runId) => path.normalize(p.requestAcksDir(runId)),
    requestRejectedDir: (runId) => path.normalize(p.requestRejectedDir(runId)),
    taskDir: (runId, taskId) => path.normalize(p.taskDir(runId, taskId)),
    resultFile: (runId, taskId) => path.normalize(p.resultFile(runId, taskId)),
    contextFile: (runId, taskId) => path.normalize(p.contextFile(runId, taskId)),
    attemptDir: (runId, taskId, attempt) => path.normalize(p.attemptDir(runId, taskId, attempt)),
    diffPatchFile: (runId, taskId, attempt) => path.normalize(p.diffPatchFile(runId, taskId, attempt)),
    diffJsonFile: (runId, taskId, attempt) => path.normalize(p.diffJsonFile(runId, taskId, attempt)),
  };
}
