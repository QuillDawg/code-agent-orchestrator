# Agent integration hardening (H1-H6)

The spec for the `.cao-files/agent-hardening.yaml` workflow. It takes the Claude and Codex
runners from "works when nothing goes wrong" to a release we can put in front of users.

Read this whole document before touching code. Each task's scope file in
`.cao-files/scope/agent-hardening/` names the sections it owns.

---

## Where we actually are

The Codex integration landed over commits `0d08256..f40c4bc`. It works on the happy path and
the design in `docs/agent-cli-integration.md` is described accurately. Three things are
nevertheless true today:

1. **The test suite cannot see the failures users see.** `npm run typecheck` and `npm test`
   (471 tests, 33 files) are green on `f40c4bc`, and were green while every real Codex run in
   `.orchestrator/runs/2026-09-10-002` and `-003` failed:

   ```
   error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'
   Invalid schema for response_format 'codex_output_schema': In context=(),
     'additionalProperties' is required to be supplied and to be false.
   ```

   Both were fixed (`63af206`, `273d2a3`), and both were found by a human running the real CLI.
   `test/fixtures/fake-codex.mjs` accepts whatever CAO sends it, so it agrees with every bug
   CAO has. That is the root cause of "it kept breaking": the loop that should have caught
   these is missing, not the individual fixes.

2. **Human-facing surfaces show the wire format instead of the agent.** Every worker is told to
   end with a single JSON completion object, and every runner records that object as a `text`
   transcript entry - agent prose. From
   `.orchestrator/runs/2026-09-10-004/tasks/improve-validation-docs/attempts/1/events.jsonl`:

   ```json
   {"kind":"text","ts":"...","text":"{\"status\":\"success\",\"summary\":\"Added the requested ...\"}"}
   ```

   So `cao logs --follow`, `cao peek`, the dashboard follow view and the one-line activity
   column all render `{"status":"success","summary":"...` where they should render what the
   agent said. The same attempt shows Codex emitting a *second*, earlier completion object
   mid-turn (`"status":"needs_input"`), so this is not only about the last message.

3. **"The agent is waiting for a human" is three different mechanisms.** Claude ask-mode routes
   control requests to the dashboard; Codex `appServer` routes two of three request types and
   kills the process for the third; Codex `exec` has no channel at all and surfaces the
   rejection as an `error` transcript entry. The states (`waiting`, `needs_input`), the
   `execution.interactionTimeout` budget, `hooks.onInputRequired` and the
   `cao resume --task <id> --input "..."` round trip are documented as agent-neutral in
   `docs/configuration.md`, and are not yet agent-neutral in the code.

**Goal.** A release where a run either finishes, or stops and says exactly what it needs from
you - on either agent, attended or headless - and where the next flag or schema change in
either vendor CLI is caught by `npm test`, not by a user.

**Non-goals.** New workflow features, new agents, new CLI commands, changes to the DAG,
workspace or context engines. This is a hardening pass: every change is a bug fix, a test, or a
documentation correction.

**Compatibility rule.** Existing workflow files must keep working unchanged. No YAML key is
removed or renamed, and no default changes meaning. Where behaviour must change, it changes
toward what `docs/configuration.md` already promises.

---

## H1 A test harness that can fail

The fakes are the contract. Today they are a mirror.

### H1.1 The fakes must reject what the real CLI rejects

`test/fixtures/fake-codex.mjs` and `test/fixtures/fake-claude.mjs` must validate their own
argv the way the real binaries do, and exit non-zero with the vendor's own wording when CAO
sends something invalid. At minimum, `fake-codex.mjs` must reproduce:

- `--approve-for-me` together with `--sandbox` -> exit 2, "the argument '--approve-for-me'
  cannot be used with '--sandbox <SANDBOX_MODE>'".
- `--ask-for-approval` anywhere on an `exec` command line -> exit 2 (it is TUI-only).
- an `--output-schema` file that is not OpenAI-strict (any object without
  `additionalProperties: false`, or with a property missing from `required`) -> the
  `invalid_json_schema` 400 already modelled by `FAKE_CODEX_MODE=strict-schema`, on by default
  rather than opt-in.
- flags after the `exec` subcommand that `exec` does not take, and global flags placed after
  the subcommand.

`fake-claude.mjs` gets the same treatment for the flags in
`docs/agent-cli-integration.md`: an unknown flag exits 2, and `--input-format stream-json`
without `--permission-prompt-tool` refuses to answer control requests.

Existing tests that relied on the permissive fakes are updated, not deleted. If a test breaks
because the fake got stricter, the runner is what needs fixing.

### H1.2 A real-CLI surface check

One test file (`test/integration/agent-surface.test.ts`) that, **when the real binary is on
PATH**, runs `codex --help`, `codex exec --help`, `codex app-server --help` and
`claude --help`, and asserts that every flag CAO can emit appears in the right help output and
in the right position (global vs subcommand). It builds the argv through the real
`buildCodexArgs` / the Claude argv builder for a matrix of options rather than hard-coding
strings, so a new option cannot be added without being covered.

It **skips with a stated reason** when the binary is absent or below
`MINIMUM_AGENT_VERSIONS`, so CI and contributors without both CLIs stay green. It is wired into
a new `npm run test:agents` script and named in `CONTRIBUTING.md` as the check to run before
touching a runner.

### H1.3 End-to-end coverage for Codex

`test/integration/` drives Claude through the scheduler (`e2e.test.ts`, `interactive.test.ts`)
and Codex not at all - Codex has unit coverage only. Add scheduler-level coverage, against the
fake, for both transports:

- `exec`: success, `invalid_result` -> nudge -> success, non-zero exit with a transient error
  -> `api_error` -> session resume, timeout, cancellation mid-turn.
- `appServer`: the same, plus command approval, file-change approval, `requestUserInput` with
  and without `experimentalUserInput`, `turn/completed` with `status: failed` and
  `interrupted`, and an overloaded (`-32001`) `thread/start`.

Each case asserts the persisted run state, the task result and the attempt's `events.jsonl` -
not just the runner's return value.

---

## H2 Never show the completion object as agent prose

### H2.1 The rule

The completion object is protocol, not speech. No human-facing surface may render it as agent
text. It stays in `events.jsonl` byte-for-byte (it is evidence, and `cao logs --json` is a pipe
target), but every renderer treats it as the result it is.

### H2.2 Where it comes from

- `src/runners/codex/codex-runner.ts`: the `item.type === 'agent_message'` branch.
- `src/runners/codex/app-server.ts`: the `item.type === 'agentMessage'` branch.
- `src/runners/claude/claude-runner.ts`: the `case 'text'` branch, fed by `parseClaudeEvents`.

### H2.3 Requirements

- A shared helper decides whether a piece of agent text *is* the completion object. It must
  recognise the bare object, an object inside a fenced block, and an object preceded or
  followed by prose, reusing `extractJsonObject` and the contract validator in
  `src/runners/claude/contract.ts` rather than a new parser. Text that merely mentions JSON, or
  a JSON object that is not a completion result (no `status`), is prose and stays prose.
- When the whole message is the completion object, the runner records a `result`-shaped entry
  instead of a `text` entry. When prose surrounds it, the prose is kept as `text` and the
  object is stripped out of it.
- The **activity line** (`hooks.onActivity`, the dashboard task column, `live.json`,
  `transcriptLine`) never shows a `{`-leading string. For a completion object it shows the
  summary.
- **Intermediate** completion objects (a worker that emits one, keeps working, emits another)
  are recorded and rendered as results but do not end the attempt: the authoritative result is
  still `final.json` for `exec`, the last `agentMessage` for `appServer` and `structured_output`
  for Claude. The transcript must make an intermediate one visibly intermediate rather than
  looking like a second outcome.
- `cao logs --json` output is unchanged in shape. `cao logs`, `cao logs --follow`, `cao peek`,
  the dashboard follow view and `cao report` all pick the change up from the shared renderer.
- Any *other* JSON a worker prints (a config it was showing off, a tool result) still renders
  as before. This is not a "hide JSON" feature.

### H2.4 Tests

`test/unit/transcript.test.ts` for the classifier (bare object, fenced, prose plus object,
object without `status`, malformed JSON, a very large blob), and one assertion per runner that
a completed attempt's `events.jsonl` contains no `text` entry whose content parses as a
completion result.

---

## H3 Blocked on a human, on either agent

This is the section that decides whether the release is usable. Everything here answers one
question: **the worker cannot proceed without a human - what happens?**

### H3.1 The two states, and what they mean

| State | Meaning | Who answers | How |
|---|---|---|---|
| `waiting` | The worker process is alive and blocked on a request the orchestrator can answer | the attached dashboard | a keypress in the modal |
| `needs_input` | The attempt is over; the run is paused holding a question | the operator, later | `cao resume <run> --task <id> --input "..."` |

Every path a worker can take to "I need a human" must end in exactly one of these, on both
agents, attended and headless. A worker must never sit blocked with nothing on screen, and a
run must never end `failed`/`crash` when the real cause was an unanswered question.

### H3.2 Claude

Ask mode already implements this. Harden it and prove it:

- Concurrent prompts: two open requests answered out of order; the task leaves `waiting` only
  when the last one is answered (`scheduler.ts` already intends this - test it).
- `control_cancel_request` for a request that is on screen, and for one already answered.
- Timeout (`execution.interactionTimeout`), including `never`.
- The deny message the worker receives must always tell it to finish with `needs_input`, and
  the resulting task result must carry the question text, not a generic "denied".
- `permissionPrompts: deny` and `--no-tui`: the prompt is denied by the CLI, and the task must
  still reach `needs_input` with a usable message rather than `failed`.
- "Allow for the rest of this task" is offered only when the CLI supplied a suggestion
  (`canAllowAlways`), and the rule never outlives the session.

### H3.3 Codex app-server

- Command and file-change approvals already map to `Interaction`. Cover both, including
  `proposedExecpolicyAmendment` and `grantRoot` as always-allow suggestions, and a decline.
- `item/tool/requestUserInput` with `experimentalUserInput: true` must round-trip: question ->
  modal -> answers -> the worker continues. The current mapping hard-codes `multiSelect: false`
  and answers as `{[id]: {answers: [value]}}`; verify that shape against the app-server
  protocol and cover multi-question payloads.
- With `experimentalUserInput` disabled the current code sends an error and *kills the
  process*, discarding the turn and any work in it, then reports `needs_input` with a fixed
  sentence. Instead: decline the request through the protocol, let the worker finish its own
  turn, and if it cannot, end the attempt as `needs_input` whose `summary`/`error` **quotes the
  question Codex asked**. Killing the process is the last resort, and when it happens the
  transcript must say so.
- An unknown server request still fails closed (`-32601`), and a permission-affecting one is
  never auto-allowed. Keep this, and test it.

### H3.4 Codex exec

`codex exec` cannot be asked anything: it rejects approvals and user input itself, and the
rejection arrives as an `error` item. That is a legitimate transport, but it must be honest:

- **Up front.** `cao validate` and the run preflight must state, for every Codex `exec` task,
  that no human can be reached during it. `approvals: host` is already a validation error; at
  minimum the run log must record the transport's limits once per task.
- **At runtime.** An approval or user-input rejection in the JSONL stream must be recognised
  (not merely logged as `error`) and must end the attempt as `needs_input` carrying the text of
  what Codex wanted, so `cao resume --input` is a real next step. Today it falls through to
  `invalid_result` or `crash` depending on the exit code.
- The `needs_input` result must name the transport and the option that would have allowed an
  answer (`codex.transport: appServer`, `codex.approvals: host`), so the operator can fix the
  workflow instead of guessing.

### H3.5 The answer round trip

`cao resume <run> --task <id> --input "text"` currently sets `state.userInput`, resets the task
to `pending` and starts a **fresh attempt** with the answer appended as a `# User Input`
context block (`src/context/context-builder.ts`). The worker therefore redoes everything it had
already done.

- When the previous attempt has a resumable session (`sessionResumable`, and Codex `exec`
  supports `exec resume <id>`), the answer must continue that session rather than restart the
  task, with the answer sent as the user's next message. `triggeredBy: 'user_input'` already
  distinguishes the attempt.
- When it does not, the fresh attempt must still receive the original question alongside the
  answer, so the worker knows what it is answering.
- `cao resume --task X --input` on a task that is not in `needs_input` must be a `UsageError`
  naming the task's actual state, not a silent no-op.
- Multiple tasks paused on input in one run must each be answerable in one `cao resume`
  invocation, or the command must say plainly that they are answered one at a time.

### H3.6 Headless behaviour is a contract

With no dashboard (`--no-tui`, CI, non-TTY) nothing may block:

- Every interaction is denied within `interactionTimeout` (default 30m) at the latest, and the
  denial message tells the worker to finish with `needs_input`.
- The run ends `paused`; the exit code and the printed summary tell the operator which tasks
  need what, and `cao status` shows the question text.
- `hooks.onInputRequired` fires for both agents with `CAO_INTERACTION_KIND`,
  `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL` populated, and never blocks the answer.

### H3.7 Acceptance

A test for each row, driven through the scheduler against the fakes:

| # | Agent / transport | Situation | Attended (dashboard) | Headless |
|---|---|---|---|---|
| 1 | claude ask | permission prompt | `waiting` -> answered -> continues | denied -> `needs_input` with the question |
| 2 | claude ask | `AskUserQuestion` | `waiting` -> answer -> continues | denied -> `needs_input` with the question |
| 3 | claude ask | prompt withdrawn by the worker | modal closes, task returns to `running` | n/a |
| 4 | claude ask | nobody answers | timeout -> denied -> `needs_input` | same |
| 5 | claude deny | any prompt | denied by the CLI -> `needs_input` | same |
| 6 | codex appServer | command approval | `waiting` -> allow/decline honoured | auto-review or `needs_input` |
| 7 | codex appServer | file-change approval | `waiting` -> allow/decline honoured | auto-review or `needs_input` |
| 8 | codex appServer | `requestUserInput`, enabled | `waiting` -> answers delivered -> continues | `needs_input` with the question |
| 9 | codex appServer | `requestUserInput`, disabled | `needs_input` quoting the question | same |
| 10 | codex exec | approval rejected by the CLI | `needs_input` quoting the request and how to enable answers | same |
| 11 | either | answered later with `--input` | session resumed, work continues | same |
| 12 | either | two prompts open at once | both answerable, order-independent | both denied |

---

## H4 Fail fast, fail honestly

### H4.1 Preflight before the first token

Before spawning a worker the runner already checks that the binary exists. Extend the check so
a misconfiguration cannot be discovered halfway through a run:

- The resolved argv is validated against the detected CLI's advertised capabilities
  (`src/runners/capabilities.ts` already models `exec`, `appServer`, `autoReview`,
  `isolatedConfig`, `structuredOutput`). A capability the installed version lacks is an
  immediate, non-retryable failure naming the option, the version found and the version needed.
- A version below `MINIMUM_AGENT_VERSIONS` fails at run start, not as a per-task surprise, and
  `cao doctor` reports it the same way.

### H4.2 A CLI that rejects our arguments is our bug, not the model's

`error: the argument '--approve-for-me' cannot be used with '--sandbox'` currently becomes a
`crash` outcome and is then **retried** under `retry.attempts`, burning the budget on an
outcome that cannot change. Classify argument and schema rejections (exit 2 with a usage block,
`invalid_json_schema`, JSON-RPC `-32602`) as non-retryable configuration errors, report them
with the offending flag and the YAML key that produced it, and stop the run per `onFailure`.

### H4.3 `cao doctor` covers what a run will actually do

`cao doctor` must exercise both Codex transports and both Claude prompt modes far enough to
prove they start: version, authentication, `exec` with a trivial schema, and app-server
`initialize` + `thread/start` + interrupt, reporting each as a line the user can act on. It
must not need network access beyond what the CLIs do themselves, and must never leave a process
behind.

### H4.4 Consistent outcome mapping

The two runners must map the same situation to the same `RunnerOutcome`. Write the mapping down
in one place in the code, make `docs/agent-cli-integration.md` match it, and test the pairs
that differ today: no result at exit 0, a result present but invalid, a transient network
error, a process killed externally, and a worker still holding an unanswered tool at exit.

---

## H5 Documentation and changelog

Every behaviour change lands with its documentation.

- `docs/agent-cli-integration.md`: corrected invocation lines, the outcome table from H4.4, and
  a "waiting for a human" section carrying the H3.7 matrix.
- `docs/configuration.md`: `codex.transport`, `approvals`, `experimentalUserInput`,
  `interactionTimeout`, `hooks.onInputRequired` and the `needs_input` round trip, matching what
  the code now does. Fix anything H3 proves wrong.
- `docs/capabilities.md` and `README.md`: the Codex support level, honestly stated.
- `CHANGELOG.md`: one line per user-visible change under `## Unreleased`.
- `CONTRIBUTING.md`: `npm run test:agents`, and the rule that a runner change without a fake
  update is incomplete.

---

## H6 Release gate

The run is releasable when all of this is true, checked by the final task:

1. `npm run typecheck`, `npm run lint` and `npm test` are green, and the new tests fail when
   their fix is reverted (spot-check at least H2 and one H3 row).
2. `npm run test:agents` is green against the real CLIs, or skipped with a stated reason.
3. `examples/documentation-claude.yaml` and `examples/documentation-codex.yaml` each complete
   against the real CLI with `--no-tui`, and `cao logs <task>` afterwards shows agent prose -
   no completion object rendered as text, no raw JSONL.
4. A workflow that deliberately needs input (H3.7 rows 1, 8, 9 and 10) pauses with a readable
   question, and `cao resume --task <id> --input "..."` finishes it.
5. `cao doctor` is clean on a machine with both CLIs, and says precisely what is missing on a
   machine without them.
6. No workflow file in `examples/` or `.cao-files/` needs editing to keep working.
