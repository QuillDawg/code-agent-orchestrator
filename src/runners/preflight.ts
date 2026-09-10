/**
 * Preflight (H4.1): everything about a CLI that can be known before a worker is spawned.
 *
 * A misconfiguration used to be discovered halfway through a run, once per task, as a crash — and was then
 * retried until the budget ran out. The checks here run once per run per agent, before the first token, and
 * say which option was asked for, which YAML key asked for it, which version is installed and which version
 * it would take.
 *
 * The agent-specific half (which option a workflow key turns into) lives in `<agent>/preflight.ts`; this
 * module owns the shape, the comparison and the wording.
 */
import { MINIMUM_AGENT_VERSIONS, type AgentCapability, type AgentRuntimeDetection } from './capabilities.js';

/** A capability a workflow needs, and what made it need one. */
export interface CapabilityNeed {
  capability: AgentCapability;
  /** What CAO would put on the command line (or which protocol call it would make). */
  option: string;
  /** The workflow key that asked for it, as an operator would write it. */
  key: string;
}

/** One agent's preflight verdict for the tasks that would use it. */
export interface PreflightProblem {
  /** The tasks that cannot run. Empty means "every task of this agent". */
  taskIds: string[];
  message: string;
}

/** Merge needs from several tasks, keeping the first reason given for each capability. */
export function mergeCapabilityNeeds(needs: Iterable<CapabilityNeed>): CapabilityNeed[] {
  const byCapability = new Map<AgentCapability, CapabilityNeed>();
  for (const need of needs) if (!byCapability.has(need.capability)) byCapability.set(need.capability, need);
  return [...byCapability.values()];
}

function versionText(detection: AgentRuntimeDetection): string {
  return detection.version ? `"${detection.version}"` : 'an unknown version';
}

/**
 * The version and capability half of readiness: what a run can check without touching authentication or
 * PATH. Returns one message naming every problem, or undefined when the installed CLI can do the job.
 */
export function capabilityPreflight(agent: string, detection: AgentRuntimeDetection, needs: CapabilityNeed[]): string | undefined {
  if (!detection.found) return undefined;
  const minimum = detection.minimumVersion ?? MINIMUM_AGENT_VERSIONS[agent as keyof typeof MINIMUM_AGENT_VERSIONS];
  const problems: string[] = [];
  if (detection.supportedVersion === false) {
    problems.push(`${agent} ${versionText(detection)} at "${detection.command}" is below the minimum CAO supports (${minimum ?? 'unknown'})`);
  } else if (minimum && detection.supportedVersion === undefined) {
    problems.push(`${agent} at "${detection.command}" reported ${versionText(detection)}, which cannot be compared with the minimum CAO supports (${minimum})`);
  }
  const advertised = new Set(detection.capabilities ?? []);
  for (const need of mergeCapabilityNeeds(needs)) {
    if (advertised.has(need.capability)) continue;
    problems.push(
      `${agent} ${versionText(detection)} at "${detection.command}" does not advertise ${need.capability} (CAO would use \`${need.option}\`, asked for by ${need.key}); CAO needs ${agent} ${minimum ?? 'a newer version'} or newer`,
    );
  }
  if (!problems.length) return undefined;
  return `${problems.join('. ')}. This is a configuration error: no retry can change it. Upgrade the CLI, or change the workflow.`;
}

/**
 * Everything `cao run`, `cao resume` and `cao doctor` require of a CLI before a run starts: it is there, it
 * is authenticated, its version is readable and supported, and it advertises what the workflow selected.
 */
export function runnerReadinessError(runner: AgentRuntimeDetection & { runner: string; requiredCapabilities?: AgentCapability[]; capabilityNeeds?: CapabilityNeed[] }): string | undefined {
  if (!runner.found) return `${runner.runner} CLI not found (${runner.command}): ${runner.error ?? 'unknown error'}`;
  if (runner.authenticated === false) return `${runner.runner} CLI is not authenticated (${runner.command})`;
  if (runner.minimumVersion && runner.supportedVersion === undefined) return `could not verify ${runner.runner} version "${runner.version ?? 'unknown'}"; minimum ${runner.minimumVersion}`;
  if (runner.supportedVersion === false) return `${runner.runner} ${runner.version ?? 'version'} is unsupported; minimum ${runner.minimumVersion ?? 'version is unknown'}`;
  const available = new Set(runner.capabilities ?? []);
  const missing = (runner.requiredCapabilities ?? []).filter((capability) => !available.has(capability));
  if (!missing.length) return undefined;
  // The needs carry the option and the YAML key behind each capability; without them, name the capability.
  const explained = missing.map((capability) => {
    const need = runner.capabilityNeeds?.find((candidate) => candidate.capability === capability);
    return need ? `${capability} (\`${need.option}\`, asked for by ${need.key})` : capability;
  });
  return `${runner.runner} ${runner.version ?? 'version'} at "${runner.command}" lacks required capabilities: ${explained.join(', ')}; CAO needs ${runner.runner} ${runner.minimumVersion ?? 'a newer version'} or newer`;
}
