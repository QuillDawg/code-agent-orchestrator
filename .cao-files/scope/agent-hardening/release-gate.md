# release-gate

Spec section: **H6**.

Final verification. Decide whether this run can be released. Do not implement anything; if a
gate fails, say exactly which one and why.

## The gate

1. **Offline suite.** `npm run typecheck`, `npm run lint`, `npm test` green. Then spot-check
   that the new tests are real: in a scratch worktree (`git worktree add`), revert the H2 fix
   and one H3 fix and confirm the corresponding tests go red. Never leave the scratch worktree
   behind.
2. **Real CLI surface.** `npm run test:agents`. Green, or skipped with the reason stated (which
   CLI is missing or too old).
3. **Real smoke runs.** With both CLIs installed, run each against the real agent and check the
   transcript afterwards:
   ```
   cao run examples/documentation-claude.yaml --no-tui
   cao run examples/documentation-codex.yaml  --no-tui
   cao logs <run-id> <task-id>
   ```
   Both must complete, and neither transcript may render a completion object as agent text or
   raw JSONL as prose. Revert the smoke target file afterwards
   (`git checkout -- examples/documentation-smoke-target.md`) so the tree stays clean.
   If a CLI is absent, record the gate as skipped rather than passed.
4. **Needs-input round trip.** Build a throwaway workflow under the scratchpad covering H3.7
   rows 1, 8, 9 and 10 (Claude permission prompt; Codex app-server `requestUserInput` enabled
   and disabled; Codex `exec` approval rejection). Run it `--no-tui`. Every task must pause with
   a readable question rather than hang or crash, and
   `cao resume <run> --task <id> --input "..."` must finish it. Against the fakes is
   acceptable; against the real CLIs is better - say which you did.
5. **Doctor.** `cao doctor` is clean and its output is actionable. Read it as someone who has
   just installed CAO.
6. **No regressions.** `cao validate` passes for every file in `examples/` and `.cao-files/`,
   unchanged. `git diff <base>..HEAD --stat` contains no edit to an example workflow's
   behaviour.

## Result

- `summary`: one paragraph - releasable or not, and on what evidence.
- `decisions`: each of the six gates with pass / fail / skipped and one line of evidence.
- `warnings`: every unresolved problem, `[high]`/`[medium]`/`[low]`, naming the file.
- `followUp`: what a follow-up run should pick up.
- `status`: `success` only if gates 1, 4, 5 and 6 pass and gates 2 and 3 pass or are skipped
  for a stated missing-CLI reason. Otherwise `failed`, with the reason in `error`.
