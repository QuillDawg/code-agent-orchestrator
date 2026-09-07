# doctor-command

Research doc section: **5. Public beta checklist**, the `cao doctor` item.

## Deliverables

- `cao doctor` in `src/cli/commands/doctor.ts`: Node version against `engines`, git present
  and worktree-capable, each agent CLI found with its version (reuse
  `src/runners/*/detect.ts`), stale `lock.json` files under `.orchestrator/runs`, orphaned
  worktrees and `orchestrator/*` branches, the `.git/info/exclude` entry.
- One line per check with a fix hint on failure; exit 1 when any check fails; `--json`.
- README CLI table and `docs/capabilities.md`.

## Tests

Unit tests with the detection functions stubbed.
