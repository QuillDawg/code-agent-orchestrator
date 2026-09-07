# CAO workflow authoring reference

## Artifact contract

Write the workflow below the target project's `.cao-files/` directory. The file is a reviewable project artifact: do not add it to `.gitignore` and do not overwrite an existing file. Run validation from the target project's root because `repository: .` is resolved from CAO's launch directory, not from the YAML file's directory.

Use a filename of `YYMMDD--<stage>--<slug>.yaml`, where stage is one of `workflow`, `wayfinder`, `spec`, `tickets`, or `implement`. If it exists, append a two-digit sequence before `.yaml`.

Every workflow starts with:

```yaml
version: 1
name: <human-readable name>
description: <what this stage does and its source>
repository: .
agent: <codex or claude>
```

Only add `model` and `effort` when the user selected them. Quote user-controlled prompt text safely with a YAML block scalar. Keep URLs and source paths in `variables` where multiple prompts need them.

## Workflow design

- Use `git: { enabled: false }` for planning/tracker-only stages. Use normal Git capture and worktrees for code implementation.
- Use `type: approval` for a human gate. Every tracker-writing task must depend on an approval task that is visibly named for the pending mutation.
- In a dependency graph, use `execution.mode: dag` and explicit `dependsOn`. Independent code tasks may use `parallelGroup` and `execution.maxConcurrency: 3`; never put concurrent code tasks in a shared workspace.
- Let implementation tasks use worktrees, pass summaries/results with `context`, then add focused test, code-review, and final-verification tasks. A review task reports findings; it should not absorb unrelated feature work.
- Keep generated worker prompts concrete: source URL/path, desired result, scope boundary, and whether GitHub mutation is permitted after the approval gate. Include the relevant Matt skill slash command when the target environment has that skill installed.

## GitHub input and safety

For an issue reference, load the live issue with `gh issue view <reference> --comments --json number,title,body,labels,state,url,assignees`. Read linked issues, PRDs, maps, and artifacts only when they affect this stage. Never expose auth tokens or copy secrets into YAML.

If a map, spec, or ticket needs to be published or changed, split the workflow into: prepare/draft (read-only), approval, then publish/update. The authoring skill itself remains read-only toward GitHub.

## Validation and handoff

Run `cao validate .cao-files/<filename>.yaml`. If `cao` is unavailable, report that validation could not be run and give the exact command; do not replace it with a guessed schema check. Report the artifact path, selected agent, source references used, and the command to execute later: `cao run .cao-files/<filename>.yaml`.
