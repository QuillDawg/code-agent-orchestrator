# Changelog

All notable changes to `code-agent-orchestrator-protocol` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) **on its own train**: it moves only when the
contract moves, so most `code-agent-orchestrator` releases do not bump it (spec §4.1.1).

`PROTOCOL_VERSION` is a different number and changes for a different reason. This file's version says
"is the shared code you compiled against still the shared code that is installed"; `PROTOCOL_VERSION` says
"can this artifact read this file at all".

## [Unreleased]

## [0.1.0]

### Added

- First release. The types and pure logic that both artifacts need, moved out of
  `code-agent-orchestrator` rather than copied (spec §4.1, §5.5):
  - the run-directory layout — `ORCHESTRATOR_DIR`, `RunPaths`, `createRunPaths`, `safeSegment` — joined on
    `/` instead of `node:path`;
  - the workflow types: `ResolvedWorkflow`, `ResolvedTask`, `AgentName`, `WorkspaceMode`, `RetryPolicy`,
    `OnFailure`, `Effort` and the rest of `types/workflow.ts`;
  - the run types: `TaskState`, `RunState`, `TaskReason`, `AttemptOutcome`, `WorkflowRun`, `TaskRunState`,
    `TaskAttempt`, `LiveStatus`, `LiveTaskStatus`, `WorkspaceInfo`, `RunSummary`, `TERMINAL_TASK_STATES`,
    `ACTIVE_TASK_STATES`, and `RunnerFailure`, which they record;
  - the result types: `TaskResult`, `EnrichedTaskResult`, `RunnerUsage`, `AttemptDiff`, `DiffFileRecord`,
    `GitInfo`, `addUsage`;
  - the event types: `WorkflowEvent`, `WorkflowEventBody`, `EventMeta`, `EventOf`;
  - the interaction types: `Interaction`, `InteractionAnswer`, `InteractionRecord`, `InteractionQuestion`,
    `InteractionAnswerSource`, `describeAnswer`, `canAllowAlways`, `toInteractionRecord`;
  - the transcript entry: `TranscriptEntry`, `FileOp`, `transcriptLine`, `parseTranscriptLine`;
  - transcript structure: `planTranscript`, `PlannedEntry`, `TranscriptFilter`, `TRANSCRIPT_FILTERS`,
    `FILTER_LABEL`, `nextFilter`, `filterEntries`.
- `createTranscriptPlan()` — the same tree, kept up to date as the log arrives (spec §6.3.1). `append()`
  takes the next entries and reports what moved as `{ added, changed }`; `plan()` returns the tree and is
  reference-equal to the previous call until something does move, with a node that did not change still the
  same object; `end()` marks every call nobody answered, as reaching the end of the log does; `reset()`
  forgets an attempt, because tool ids come from the agent process and do not pair across one (§8.6).
  `planTranscript` is unchanged and stays the one-shot path. The two are separate implementations tied by a
  property — for every fixture and every split point, `incremental(a).append(b).plan()` equals
  `planTranscript([...a, ...b])` — rather than one implementation with a mode flag. The property is also
  run over generated logs whose entries arrive in orders no agent produces, which is where two
  implementations of one algorithm actually drift.
- New to the contract, and consumed by nothing yet: `PROTOCOL_VERSION`, `CAPABILITIES`, `MachineIdentity`,
  `RegistryEntry` (§4.2.3), `ControlRequest` (§4.3.1), `PendingInteractionFile` (§4.4.2) and `PresenceFile`
  (§4.6.1).
