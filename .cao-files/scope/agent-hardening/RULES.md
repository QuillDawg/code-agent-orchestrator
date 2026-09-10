# Ground rules for the agent-hardening workflow

The spec for every task is `docs/research/agent-integration-hardening.md` ("the spec"). Each
task's scope file names the section(s) it covers. Read the section and the code it cites before
changing anything. Do not implement other sections.

This run is a hardening pass before a release. Two rules override everything else:

1. **Nothing that works today may stop working.** No YAML key is removed or renamed, no default
   changes meaning, no example workflow needs editing. If a fix would break an existing
   workflow file, stop and put it in `followUp` with the reason instead.
2. **A fix without a test that fails before it does not count.** Write the failing test first,
   or verify afterwards that reverting the fix turns the new test red. Say in `decisions` which
   tests you checked this way.

## Feature tasks

- Keep the conventions: TypeScript ESM, zod schemas in `src/config/schema.ts`, normalisation in
  `src/config/normalize.ts`, semantic checks in `src/workflow/validator.ts`, one
  `TranscriptEntry` model in `src/types/transcript.ts`, agent-specific code only under
  `src/runners/<agent>/`, Ink for the TUI.
- Anything a *runner* learns must reach the orchestrator through the existing runner-neutral
  types (`RunnerOutcome`, `Interaction`, `TranscriptEntry`). Do not add an agent name check to
  `src/workflow/`, the TUI or the CLI.
- Tests are vitest against the fakes in `test/fixtures/`; no real API calls, ever, in
  `npm test`. Real-CLI checks live in the `test:agents` script and skip when the CLI is absent.
- `npm run typecheck`, `npm run lint` and `npm test` must be green before you finish. If a
  pre-existing test now fails because a fake got stricter, fix the runner - do not loosen the
  fake and do not delete the test.
- Update `docs/agent-cli-integration.md`, `docs/configuration.md`, `docs/capabilities.md` and
  `README.md` where the user-facing surface changed. Add a line under `## Unreleased` in
  `CHANGELOG.md`.
- Commit with a conventional message (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Stage only
  the files you changed. Never push.
- Result fields: `summary` = what now works, two or three sentences. `decisions` = design
  choices a reviewer should know, including which tests you verified fail without the fix.
  `warnings` = anything incomplete or risky. `followUp` = work deliberately left out.

## Iterate tasks

An iterate task follows a feature task and makes it good rather than merely done.

1. Use the feature the way a user would. Drive whole runs against the fakes
   (`CAO_CLAUDE_COMMAND="node test/fixtures/fake-claude.mjs"`,
   `CAO_CODEX_COMMAND="node test/fixtures/fake-codex.mjs"`; see `test/helpers/index.ts` and the
   e2e tests for how runs are driven), then use the commands and views the scope names. For TUI
   work drive the component with `ink-testing-library`.
2. Write down every rough edge: wrong or missing information, confusing output, broken edge
   cases, missing tests. The scope file's checklist is the minimum, not the maximum.
3. Fix them in order of user impact. Add a test for each fix.
4. Repeat 1-3 until a pass finds nothing worth fixing, or you have done three passes.
5. Same checks and commit rules as a feature task. `summary` says what each pass found and
   fixed; `followUp` lists what you saw and chose not to change.

## Review tasks

- Review every commit since the run's base commit (`git log <base>..HEAD`,
  `git diff <base>..HEAD`; the base is recorded in the baseline task's result).
- Judge against the named sections of the spec: does the code match it, is it tested, is it
  documented, does it keep the conventions above, and does it keep rule 1 (nothing that works
  today stops working).
- Run `npm run typecheck`, `npm run lint` and `npm test`; report the outcome. Spot-check rule 2
  by reverting one or two fixes in a scratch worktree and confirming the new tests go red.
- Do not fix anything. Each concrete finding is one entry in `warnings`, starting with
  `[high]`, `[medium]` or `[low]` and naming the file. Things that are fine but worth a second
  look go in `followUp`. `summary` is one paragraph.

## Fix tasks

- Work through the findings in context, highest severity first. Skip a finding only if it is
  wrong, and say why in `decisions`.
- Do not change unrelated code. Same checks and commit rules as a feature task; one `fix:`
  commit per logical fix.
- `summary` lists what was fixed and what was skipped.

## When you are the one who needs input

These tasks are about workers that get blocked on a human, so be careful not to become one. Do
not ask a question you can answer from the spec, the code or the git history. If you genuinely
cannot proceed, finish with `status: needs_input` and an `error` that states the decision you
need and the options you see - do not stall waiting for an answer.
