# release-packaging

Research doc section: **5. Public beta checklist**, the "Blockers" list, plus these items
from "Strongly recommended": the `exports` map, dropping sourcemaps from the published build,
the `uncaughtException` handler in `src/bin.ts`, and the git guard for the worktree and e2e
test suites.

## Deliverables

- `LICENSE` (MIT, current year, author from `package.json` once you add it).
- `package.json`: `prepublishOnly` running typecheck, lint, test and build; `repository`,
  `homepage`, `bugs`, `keywords`, `author`, `publishConfig`; `exports` for `.` and
  `./package.json`; `files` narrowed so `docs/research` is not published.
- `.github/workflows/ci.yml`: typecheck, lint, test on Node 22 and 24, `ubuntu-latest` and
  `windows-latest`. `.github/ISSUE_TEMPLATE` with a "workflow fails" template that asks for
  `cao validate --json` output and the run directory listing; a PR template.
- `.editorconfig`, `.nvmrc` (22).
- `.agents/` and `scripts/install-cao-skills.ps1` are untracked and not ignored: add both to
  `.gitignore` and note it in `decisions`. Do not delete them.
- Decide whether `.cao-files/` is ignored; leave a comment in `.gitignore` either way.
- Verify with `npm pack --dry-run`; put the file list and size in `summary`.
