# Changelog

All notable changes to `code-agent-orchestrator-protocol` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) **on its own train**: it moves only when the
contract moves, so most `code-agent-orchestrator` releases do not bump it (spec §4.1.1).

`PROTOCOL_VERSION` is a different number and changes for a different reason. This file's version says
"is the shared code you compiled against still the shared code that is installed"; `PROTOCOL_VERSION` says
"can this artifact read this file at all".

## [0.2.0]

The first minor since the package was cut. Everything in it is additive: no existing field changed meaning,
`PROTOCOL_VERSION` stays `1`, and a `0.1.0` consumer compiles against `0.2.0` unchanged except for the one
exhaustive-switch note below.

### Added

- **`RunPaths` gains the request inbox**: `requestsDir(runId)`, `requestAcksDir(runId)` and
  `requestRejectedDir(runId)` — `requests/`, `requests/acks/` and `requests/rejected/` under a run
  directory (spec §2.3). As with every other accessor, nothing outside this package builds those paths.
- **`CONTROL_REQUEST_KINDS` gains `edit` and `prompt`**, and `ControlRequest` gains the fields their kinds
  need — `changes`, `restart`, `text`, `mode` — plus `expected?: ControlExpectation`
  (`{ attempt?, revision? }`), which applies to every kind: a request built on a task that has since moved
  on is refused rather than applied to work nobody looked at.
- **`TaskEdit`** — what an `edit` asks to change — and **`TASK_EDIT_FIELDS`**, the keys a revision records a
  before and after for.
- **`PROMPT_DELIVERY_MODES`** / **`PromptDeliveryMode`** (`steer` | `followUp` | `stopAndContinue`).
- **`TaskRevision`** (`TaskRunState.revisions?`) and **`PromptDelivery`** (`TaskAttempt.prompts?`,
  `TaskAttempt.revision?`): what an applied edit and a delivered follow-up leave behind on a run (§2.6).
  The shapes are here from this release; `cao` writes them from a later one.
- **`QuotaSnapshot`** and `QuotaWindow`: what a provider last said was left of a rate-limited window.
- Two capability tokens, **`edit`** and **`prompt`**. A `CAPABILITIES` list that was nine long is now
  eleven; as §4.5 requires, a reader ignores tokens it does not know, so this is not a breaking change.

  **For a consumer:** a run advertises a token only when it really wires that affordance up, so `edit` and
  `prompt` will not appear in a registry entry until the orchestrator applies them.

- **`ControlAck`**, the answer to one control command: `{ protocol, id, status, reason?, at }` with
  `status` one of `CONTROL_ACK_STATUSES` (`accepted` | `applied` | `rejected`). It is returned in process by
  the run controller and written to `requests/acks/<ULID>.json` when the command came from disk, so both
  sides read one shape. `reason` is a sentence for a human, never a code.
- **`ControlSource`** (`CONTROL_SOURCES`: `tui` | `cli` | `inbox` | `desktop`) — who sent a command.
- **`CONTROL_SEEN_LIMIT`** (1000): how many answered command ids a run remembers, so a resend after a lost
  ack is answered rather than applied twice.
- **`WorkflowRun.controls?: RunControls`** — `{ seen: ControlAck[] }`, oldest first. Additive and optional;
  `schemaVersion` stays `1` and a reader that does not know the field ignores it.

- `TranscriptEntry` gains an **`unknown`** member: `{ kind: 'unknown'; ts; type; raw }`. It is what
  `parseTranscriptLine` now returns for a `kind` (or legacy `type`) this build does not recognise, instead
  of `null`. Spec §4.5 requires an unknown event type to be rendered generically and never dropped, and a
  `null` was indistinguishable from a corrupt line. `raw` is the line exactly as written, which is also how
  unknown fields survive the round trip.

  **For a consumer:** a `switch` over `TranscriptEntry['kind']` that was exhaustive now has one more member
  to answer for — which is the point. §4.5: no switch over a wire enum may be exhaustive without a default
  branch. `null` from `parseTranscriptLine` now means only "unreadable": not JSON, or JSON naming no event
  type at all.

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
