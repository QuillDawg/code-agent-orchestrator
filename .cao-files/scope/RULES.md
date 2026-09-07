# Ground rules for the beta-improvements workflow

The spec for every task is `docs/research/improvement-proposals.md` ("the research doc").
Each task's scope file names the section(s) it covers. Read the section and the code it
cites before changing anything. Do not implement other sections.

## Feature tasks

- Keep the conventions: TypeScript ESM, zod schemas in `src/config/schema.ts`, normalisation
  in `src/config/normalize.ts`, one `TranscriptEntry` model, Ink for the TUI, new CLI commands
  as one file under `src/cli/commands/` registered in `src/cli/program.ts`.
- Tests are vitest, against the fake agent in `test/fixtures/fake-claude.mjs`; no real API
  calls. Add or extend tests for everything you add.
- `npm run typecheck`, `npm run lint` and `npm test` must be green before you finish.
- Update `docs/capabilities.md`, `docs/configuration.md` and `README.md` where the
  user-facing surface changed. Add a line under `## Unreleased` in `CHANGELOG.md`.
- Commit with a conventional message (`feat:`, `fix:`, `docs:`, `chore:`). Stage only the
  files you changed. Never push.
- Result fields: `summary` = what now works, two or three sentences. `decisions` = design
  choices a reviewer should know. `warnings` = anything incomplete or risky. `followUp` =
  work deliberately left out.

## Iterate tasks

An iterate task follows a feature task and makes it good rather than merely done.

1. Use the feature the way a user would. Run a workflow against the fake agent
   (`CAO_CLAUDE_COMMAND="node test/fixtures/fake-claude.mjs"`, see `test/helpers/index.ts`
   and the e2e tests for how runs are driven), then use the commands, views or files the
   scope names. For TUI work drive the component with `ink-testing-library`.
2. Write down every rough edge you find: wrong or missing information, confusing output,
   broken edge cases, missing tests. Use the scope file's checklist as a minimum.
3. Fix them, in order of user impact. Add a test for each fix.
4. Repeat 1-3 until a pass finds nothing worth fixing, or you have done three passes.
5. Same checks and commit rules as a feature task. `summary` says what each pass found and
   fixed; `followUp` lists what you saw but chose not to change.

## Review tasks

- Review every commit since the run's base commit (`git log <base>..HEAD`,
  `git diff <base>..HEAD`; the base is the commit the run started from, also recorded in
  the baseline task's result).
- Judge against the named sections of the research doc: does the code match the spec, is
  it tested, is it documented, does it keep the conventions above.
- Run `npm run typecheck`, `npm run lint` and `npm test`; report the outcome.
- Do not fix anything. Each concrete finding is one entry in `warnings`, starting with
  `[high]`, `[medium]` or `[low]` and naming the file. Things that are fine but worth a
  second look go in `followUp`. `summary` is one paragraph.

## Fix tasks

- Work through the findings in context, highest severity first. Skip a finding only if it
  is wrong, and say why in `decisions`.
- Do not change unrelated code. Same checks and commit rules as a feature task; one `fix:`
  commit per logical fix.
- `summary` lists what was fixed and what was skipped.
