# diff-capture-iterate

Exercise and harden the diff capture from `diff-capture.md`.

## Minimum checklist

- Run a shared-tree workflow and a worktree workflow against the fake agent; open the
  produced `diff.patch` and `diff.json` and check them by hand against `git diff`.
- A tree that is already dirty when the run starts: the task's patch must contain only the
  task's own changes.
- Renames, binary files, an empty change set, a file deleted and re-created, CRLF line
  endings on Windows, paths with spaces.
- The temporary index never leaks into `git status` of the real repository, and is removed
  on failure paths (timeout, crash, Ctrl+C).
- `git.captureDiff: false` produces no files and no errors.
- `diff.patch` applies cleanly with `git apply --check` on a checkout of the base.
- Cost: time the snapshot on this repository; if it is noticeably slow, say so in `warnings`.
