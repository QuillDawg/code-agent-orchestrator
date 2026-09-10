# baseline

Record what "working" means today, so every later task and the final gate can be measured
against it. Change no source file.

## Do

1. `git rev-parse HEAD` and `git status --porcelain`. The working tree must be clean; if it is
   not, stop and finish with `status: blocked` listing the dirty paths.
2. Run `npm run typecheck`, `npm run lint`, `npm test`. Record the pass/fail counts and the
   duration.
3. Record the installed agent CLIs: `claude --version`, `codex --version`, and whether each is
   at or above `MINIMUM_AGENT_VERSIONS` in `src/runners/capabilities.ts`. If one is missing,
   record that - it is not a failure, it decides which later checks skip.
4. Capture the real help surface for later comparison, into
   `.cao-files/scope/agent-hardening/baseline-help.txt` (one file, sections labelled):
   `codex --help`, `codex exec --help`, `codex app-server --help`, `claude --help`. Skip any
   section whose binary is absent and say so in the file.
5. Note the current count of test files and tests, so the harness task's additions are visible.

## Result

- `summary`: the base commit sha, the three check results, and the CLI versions found.
- `decisions`: the base commit sha on its own line, in the form `base: <sha>` - later review
  tasks diff against it.
- `warnings`: anything already failing, or a missing CLI that will make later checks skip.
- `data`: `{"base":"<sha>","claude":"<version|absent>","codex":"<version|absent>"}`.

Commit only `baseline-help.txt`, with a `chore:` message.
