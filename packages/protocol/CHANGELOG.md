# Changelog

All notable changes to `code-agent-orchestrator-protocol` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) **on its own train**: it moves only when the
contract moves, so most `code-agent-orchestrator` releases do not bump it.

`PROTOCOL_VERSION` is a different number and changes for a different reason. This file's version says
"is the shared code you compiled against still the shared code that is installed"; `PROTOCOL_VERSION` says
"can this artifact read this file at all".

## [Unreleased]

## [0.3.0] - 2026-09-22

Additive except for one field that became nullable. `PROTOCOL_VERSION` stays `1`: every file a `0.2.0`
reader could open, it can still open.

### Changed

- **`QuotaWindow.usedPercent` is now `number | null`.** A window can be counted without being divided: an
  estimate read from local files knows what was spent and can never know what it was spent against, because
  no local file records the plan's limit. A reader that answered `0%` there would report as certain the one
  thing the operator most needs to be told is unknown. A `0.2.0` consumer that treats the field as a number
  must handle the null; that is the only reason this is a minor rather than a patch.

### Added

- **`QuotaWindow.usedTokens?`** - absolute usage, for a window that can be counted but not divided.
- **`QuotaSnapshot.estimated?`** - `cao` computed this snapshot rather than being told it. A flag and not a
  seventh `state`: the states are about whether a number exists, this is about where it came from, and a
  state would make "stale and estimated" inexpressible.
- **`TASK_STATES` gains `suspended`**, with `TaskReason` and `AttemptOutcome` gaining the same token. A task
  the operator stopped while keeping its session, and **non-terminal**: `cancelled` is terminal, so a task
  suspended as cancelled would block every dependent and end the run as `failed`. The outcome is not one of
  `FAILURE_OUTCOMES` either - a suspend is not a way of failing, and must not spend a retry.
- **`CONTROL_REQUEST_KINDS` gains `pause` and `resume`** - holding a run's scheduling from another process,
  and letting it go again. Eleven kinds; as before, a reader ignores kinds it does not know.
- **`workflow.paused` gains the reason `operator`**, beside `approval` and `needs_input`.

As at `0.2.0`, an exhaustive `switch` over `TASK_STATES`, `TaskReason`, `AttemptOutcome` or
`CONTROL_REQUEST_KINDS` is where a consumer feels an addition; a `default` arm does not.

## [0.2.0] - 2026-09-21

The first minor since the package was cut. Everything in it is additive: no existing field changed meaning,
`PROTOCOL_VERSION` stays `1`, and a `0.1.0` consumer compiles against `0.2.0` unchanged except for the one
exhaustive-switch note below.

### Added

- **`RunPaths` gains the request inbox**: `requestsDir(runId)`, `requestAcksDir(runId)` and
  `requestRejectedDir(runId)` — `requests/`, `requests/acks/` and `requests/rejected/` under a run
  directory. As with every other accessor, nothing outside this package builds those paths.
- **`CONTROL_REQUEST_KINDS` gains `edit` and `prompt`**, and `ControlRequest` gains the fields their kinds
  need — `changes`, `restart`, `text`, `mode` — plus `expected?: ControlExpectation`
  (`{ attempt?, revision? }`), which applies to every kind: a request built on a task that has since moved
  on is refused rather than applied to work nobody looked at.
- **`TaskEdit`** — what an `edit` asks to change — and **`TASK_EDIT_FIELDS`**, the keys a revision records a
  before and after for.
- **`PROMPT_DELIVERY_MODES`** / **`PromptDeliveryMode`** (`steer` | `followUp` | `stopAndContinue`).
- **`TaskRevision`** (`TaskRunState.revisions?`) and **`PromptDelivery`** (`TaskAttempt.prompts?`,
  `TaskAttempt.revision?`): what an applied edit and a delivered follow-up leave behind on a run.
  `cao` writes both: a `TaskRevision` for every `cao task edit`, a `PromptDelivery` for every steer,
  stop-and-continue and follow-up sent through `cao task prompt`.
- **`QuotaSnapshot`** and `QuotaWindow`: what a provider last said was left of a rate-limited window.
- Two capability tokens, **`edit`** and **`prompt`**. A `CAPABILITIES` list that was nine long is now
  eleven; a reader of this contract ignores tokens it does not know, so this is not a breaking change.

  **For a consumer:** a run advertises a token only when it really wires that affordance up; `edit` and
  `prompt` now appear in a registry entry's `capabilities`, since `cao` applies both.

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
  of `null`. An unknown event type is to be rendered generically and never dropped, and a `null` was
  indistinguishable from a corrupt line. `raw` is the line exactly as written, which is also how unknown
  fields survive the round trip.

  **For a consumer:** a `switch` over `TranscriptEntry['kind']` that was exhaustive now has one more member
  to answer for — which is the point. No switch over a wire enum may be exhaustive without a default
  branch. `null` from `parseTranscriptLine` now means only "unreadable": not JSON, or JSON naming no
  event type at all.

## [0.1.0]

### Added

- First release. The types and pure logic that both artifacts need, moved out of `code-agent-orchestrator`
  rather than copied:
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
- `createTranscriptPlan()` — the same tree, kept up to date as the log arrives. `append()` takes the next
  entries and reports what moved as `{ added, changed }`; `plan()` returns the tree and is reference-equal
  to the previous call until something does move, with a node that did not change still the same object;
  `end()` marks every call nobody answered, as reaching the end of the log does; `reset()` forgets an
  attempt, because tool ids come from the agent process and do not pair across one.
  `planTranscript` is unchanged and stays the one-shot path. The two are separate implementations tied by a
  property — for every fixture and every split point, `incremental(a).append(b).plan()` equals
  `planTranscript([...a, ...b])` — rather than one implementation with a mode flag. The property is also
  run over generated logs whose entries arrive in orders no agent produces, which is where two
  implementations of one algorithm actually drift.
- New to the contract, and consumed by nothing yet: `PROTOCOL_VERSION`, `CAPABILITIES`, `MachineIdentity`,
  `RegistryEntry`, `ControlRequest`, `PendingInteractionFile` and `PresenceFile`.
