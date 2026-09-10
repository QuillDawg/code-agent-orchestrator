# failure-consistency

Spec sections: **H4.1, H4.2, H4.3, H4.4**.

The complaint behind this run is "constant failures". Most of them were configuration errors
that only surfaced after a worker had been spawned, were then reported as crashes, and were
then retried until the budget ran out. Make a misconfiguration fail once, immediately, with the
flag and the YAML key that caused it.

## Deliverables

### Preflight (H4.1)

- Before spawning, validate the resolved argv against the detected CLI's advertised
  capabilities (`src/runners/capabilities.ts` already models `exec`, `appServer`, `autoReview`,
  `isolatedConfig`, `structuredOutput`; `detectCodex` / `detectClaude` populate them). A
  capability the installed version lacks is an immediate, non-retryable failure naming the
  option, the version found and the version needed.
- A CLI below `MINIMUM_AGENT_VERSIONS` fails at run start for every task that would use it, not
  once per task mid-run.
- The preflight runs once per run per agent, not once per attempt.

### Argument and schema rejections are configuration errors (H4.2)

`error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'` is
currently outcome `crash`, which `retry.attempts` then retries. It cannot succeed on a retry.

- Classify these as non-retryable: exit 2 with a usage block on stderr, `invalid_json_schema`
  from the model API, JSON-RPC `-32602`, and an app-server `initialize`/`thread/start` protocol
  mismatch.
- The message names the offending flag and, where it can be traced, the YAML key that produced
  it (`codex.approvals`, `codex.sandbox`, `claude.extraArgs`, ...).
- `retry.attempts` is not consumed. `onFailure` decides whether the run stops, exactly as
  today.
- Add the classification next to the existing Codex failure typing in
  `src/runners/codex/failure.ts` and the transient classifier in
  `src/runners/claude/transient.ts` rather than in a third place.

### `cao doctor` covers what a run will do (H4.3)

Extend `src/cli/commands/doctor.ts` so each agent reports: binary and version against the
minimum, authentication, and a live start of each mode a workflow can select - Codex `exec`
with a trivial schema, Codex `app-server` `initialize` + `thread/start` + interrupt, Claude
ask-mode and deny-mode argv. Each is one actionable line. No network access beyond what the
CLIs do themselves, no process left behind, and a clean exit when a CLI is simply not
installed.

### One outcome map (H4.4)

The two runners must map the same situation to the same `RunnerOutcome`. Write the mapping in
one place in the code and make `docs/agent-cli-integration.md` match it. Test at least the
cases that differ today:

| Situation | Outcome |
|---|---|
| exit 0, no result | `invalid_result` (then the nudge path) |
| result present, fails the contract | `invalid_result` |
| transient network/API error | `api_error`, session resumed |
| argument or schema rejection | non-retryable configuration failure |
| process killed externally | `crash`, with the signal recorded |
| worker still holding an unanswered tool at exit | `crash`, and the transcript shows the open call |
| abort from the orchestrator | `cancelled` |
| task timeout | `timeout`, process tree killed |

## Tests

`test/unit/runner-failure.test.ts` for the classification (both runners, one case per row),
plus scheduler-level tests that a configuration failure does not consume `retry.attempts` and
that the run stops or continues per `onFailure`. `test/unit/doctor.test.ts` for the new doctor
lines, including the "not installed" path.

## Constraint

Do not change what a *successful* run does, and do not change any default retry count, timeout
or `onFailure` value. This task changes classification and messages, not policy.
