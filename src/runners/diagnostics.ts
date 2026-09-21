/**
 * What the Diagnostics panel says about the agent CLIs (spec §3.7), behind one runner-neutral type.
 *
 * The same seam as `src/runners/quota.ts`: which agents exist and which transport each of their tasks will
 * use is decided here, and everything above — the TUI, `src/cli/` — renders an `AgentReport` without ever
 * naming an agent. Nothing in here starts an agent or spends anything; it is the preflight detection this
 * run already did, written out.
 */
import type { ResolvedWorkflow } from 'code-agent-orchestrator-protocol';
import type { AgentRuntimeDetection } from './capabilities.js';

/** One agent's preflight facts, as the panel shows them. */
export interface AgentReport {
  /** The agent's name, for the label only; nothing above this file branches on it. */
  agent: string;
  command: string;
  found: boolean;
  version?: string;
  minimumVersion?: string;
  supportedVersion?: boolean;
  authenticated?: boolean;
  /** What the CLI advertises, in the words `AgentCapability` uses. */
  capabilities: string[];
  /**
   * The transports the tasks of this agent will run through, in the words the run records them in
   * (`PromptDelivery.transport`), so a row here and a row in the Session panel say the same thing.
   */
  transports: string[];
  /** How many of this run's tasks use it. */
  tasks: number;
  error?: string;
}

/** A preflight detection with the agent it belongs to; what `detectRunnersForWorkflow` returns. */
export type AgentDetection = AgentRuntimeDetection & { runner: string };

/**
 * The transports the tasks of one agent will use.
 *
 * Claude has one and always has. Codex has two and the workflow chooses per task, which is why this is a
 * function of the resolved tasks rather than of the detection: two tasks of the same run may take different
 * routes to the same CLI, and a panel that named only one of them would be wrong for half the run.
 */
export function transportsFor(agent: string, workflow: ResolvedWorkflow): string[] {
  const tasks = workflow.tasks.filter((task) => task.agent === agent);
  if (!tasks.length) return [];
  if (agent === 'claude') return ['claude-stream'];
  if (agent === 'codex') {
    const out = new Set<string>();
    for (const task of tasks) out.add((task.codex.transport ?? 'exec') === 'appServer' ? 'codex-app-server' : 'codex-exec');
    return [...out];
  }
  return [];
}

/** The preflight detections of a run as `AgentReport`s, one per agent, in detection order. */
export function agentReports(detections: readonly AgentDetection[], workflow: ResolvedWorkflow): AgentReport[] {
  return detections.map((detection) => ({
    agent: detection.runner,
    command: detection.command,
    found: detection.found,
    ...(detection.version !== undefined ? { version: detection.version } : {}),
    ...(detection.minimumVersion !== undefined ? { minimumVersion: detection.minimumVersion } : {}),
    ...(detection.supportedVersion !== undefined ? { supportedVersion: detection.supportedVersion } : {}),
    ...(detection.authenticated !== undefined ? { authenticated: detection.authenticated } : {}),
    capabilities: [...(detection.capabilities ?? [])],
    transports: transportsFor(detection.runner, workflow),
    tasks: workflow.tasks.filter((task) => task.agent === detection.runner).length,
    ...(detection.error !== undefined ? { error: detection.error } : {}),
  }));
}
