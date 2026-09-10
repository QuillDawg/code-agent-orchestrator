/**
 * `~/.cao/runs/<key>.json` — one entry per announced run. Spec §4.2.3.
 *
 * The entry is a **pointer plus a heartbeat**, never a second copy of run state: everything else a surface
 * shows comes from the run directory it points at. That is what keeps a stale entry harmless.
 */
import type { CapabilityToken, MachineIdentity, ProtocolVersion } from './protocol.js';
import type { RunState } from './run.js';

export interface RegistryEntry {
  protocol: ProtocolVersion;
  /**
   * `${runId}@${repoHash}` (§4.2.2). Run ids are allocated unique within one repository's runs directory, so
   * two repositories running on the same day both produce `2026-09-10-001`; a registry keyed on run id alone
   * silently loses runs. `repoHash` is the first 8 hex characters of the sha256 of the normalised repository
   * root, and is also the file name: `<runId>@<repoHash>.json`.
   */
  key: string;
  runId: string;
  repositoryRoot: string;
  orchestratorDir: string;
  workflowName: string;
  configPath: string;
  machine: MachineIdentity;
  pid: number;
  cliVersion: string;
  /** Mirrored from the run. The run directory stays the truth; this is what the list can show without opening it. */
  state: RunState;
  startedAt: string;
  /** Same 20 s tick as `lock.json`. An entry is stale once this is more than 60 s old (§4.2.5). */
  heartbeatAt: string;
  endedAt: string | null;
  exitCode: number | null;
  taskCount: number;
  /** What this run actually wired up, not what its version could in principle do (§4.2.3). */
  capabilities: CapabilityToken[];
  /** Set only when `feed` is in `capabilities` (§10.1). */
  feedUrl: string | null;
}
