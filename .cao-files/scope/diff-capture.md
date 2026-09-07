# diff-capture

Research doc section: **P1 Capture a real per-task diff at attempt end**.

## Deliverables

- At the end of every attempt write `diff.patch` and `diff.json` into the attempt directory
  (`RunPaths` in `src/persistence/paths.ts`). `diff.json` has one record per file: path,
  status (`A`/`M`/`D`/`R`), additions, deletions, binary flag.
- Worktree attempts: diff base sha to branch head after the checkpoint commit, inside
  `WorkspaceManager.finalize` (`src/workspace/workspace-manager.ts`).
- Shared-tree attempts: snapshot the working tree as a git tree object at acquire and at
  finalize using a temporary index (`GIT_INDEX_FILE` under `.orchestrator/`), then
  `git diff-tree -p` and `--numstat` between the two trees. Store both tree ids on
  `attempt.workspace`. The snapshot must never touch the real index or working tree.
- Merge-resolution attempts (`kind: merge`) get their own patch.
- Honour the existing `git.captureDiff` option (currently never read) and add
  `git.maxDiffBytes` (default 2 MB). Over the limit: full `diff.json`, truncated `diff.patch`
  with a trailing note.
- Extend `GitInfo` in the result with the per-file stat so downstream context and
  `cao task` can use it.

## Tests

Extend `test/integration/worktree.test.ts` and `e2e.test.ts` to assert `diff.patch` and
`diff.json` for: a worktree task, a shared task, a Bash-driven change (one file created and
one deleted through the shell, which the tool stream does not see), and `maxDiffBytes`
truncation.
