# harness

Spec sections: **H1.1, H1.2, H1.3**.

This task comes first because everything after it is only as trustworthy as the harness. The
Codex integration shipped bugs that a green 471-test suite could not see, because
`test/fixtures/fake-codex.mjs` accepts whatever CAO sends it.

## Deliverables

### Faithful fakes (H1.1)

- `test/fixtures/fake-codex.mjs` validates its own argv like the real CLI and exits 2 with the
  vendor wording for: `--approve-for-me` combined with `--sandbox`; `--ask-for-approval` on an
  `exec` line; a global flag placed after the `exec` subcommand; an `exec` flag CAO invented.
- The strict-schema check (`strictSchemaError`) applies to every `exec` and `turn/start` call,
  not only under `FAKE_CODEX_MODE=strict-schema`. Keep the mode so a test can still assert the
  400 wording, but a non-strict schema must fail by default.
- `test/fixtures/fake-claude.mjs` gets the same treatment: an unknown flag exits 2, and
  `--input-format stream-json` without `--permission-prompt-tool stdio` refuses to answer
  control requests.
- Both fakes keep a single place listing the flags they accept, so extending them is one edit.

Existing tests that pass only because the fakes were permissive are evidence of a runner bug.
Fix the runner. Do not loosen the fake, and do not delete the test.

### Real-CLI surface check (H1.2)

- New `test/integration/agent-surface.test.ts`. For a matrix of options (every
  `permissionMode`, every `approvals` value, both transports, `configMode`, `profile`,
  `addDirs`, model and effort set and unset) it builds the argv through the real
  `buildCodexArgs` and the Claude argv builder, then checks each emitted flag against the help
  text of the installed CLI (`codex --help`, `codex exec --help`, `codex app-server --help`,
  `claude --help`), including whether the flag belongs before or after the subcommand.
- It skips - loudly, with the reason in the skip message - when the binary is missing or below
  `MINIMUM_AGENT_VERSIONS`. It must never fail a machine that has no CLI installed.
- New `npm run test:agents` script runs it (and only the real-CLI checks). `npm test` keeps its
  current meaning and stays offline.

### Codex end-to-end coverage (H1.3)

New scheduler-level tests (extend `test/integration/e2e.test.ts` or add
`test/integration/codex-e2e.test.ts`) covering, per transport:

- `exec`: success; `invalid_result` -> nudge -> success; non-zero exit with a transient network
  error -> `api_error` -> resumed session; task timeout; cancellation mid-turn.
- `appServer`: the same set, plus command approval, file-change approval, `requestUserInput`
  with and without `experimentalUserInput`, `turn/completed` with `status: failed` and with
  `interrupted`, and an overloaded (`-32001`) `thread/start` retry.

Each case asserts the persisted `run.json` task state, the stored `TaskResult`, and the
attempt's `events.jsonl` - not only the value the runner returned.

## Checks

`npm run typecheck`, `npm run lint`, `npm test` green. `npm run test:agents` green or skipped
with a stated reason. Note in `decisions` any runner bug the stricter fakes exposed, and either
fix it here (small) or record it in `warnings` for the task that owns that section.
