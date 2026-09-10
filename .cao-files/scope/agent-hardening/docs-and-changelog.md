# docs-and-changelog

Spec section: **H5**.

Every earlier task updated the docs it touched. This task makes the whole set coherent and
honest, and is the last chance to catch a document that still describes the old behaviour.

## Deliverables

- `docs/agent-cli-integration.md`
  - The invocation lines for both agents match the argv the runners actually build. Verify
    against `buildCodexArgs` and the Claude argv builder, not against memory.
  - One outcome-mapping table shared by both agents (H4.4), replacing the two tables that can
    drift apart.
  - A "waiting for a human" section carrying the H3.7 acceptance matrix, including what Codex
    `exec` cannot do and which option changes that.
- `docs/configuration.md`: `codex.transport`, `codex.approvals`, `experimentalUserInput`,
  `execution.interactionTimeout`, `hooks.onInputRequired`, the `needs_input` round trip and the
  task-state table all match the code after this run. Correct anything the H3 work disproved.
- `docs/capabilities.md` and `README.md`: state the Codex support level plainly - which
  transport is stable, which is experimental, what is not supported.
- `CHANGELOG.md`: one line per user-visible change under `## Unreleased`, in the existing
  style. Group them so a reader can tell fixes from behaviour changes.
- `CONTRIBUTING.md`: document `npm run test:agents`, and state the rule that a runner change
  without a matching fake update is incomplete.
- `examples/`: if any example workflow would now behave differently, say so in a comment in
  that file. Do not change what an example does.

## Checks

- Every command, flag and YAML key quoted in the docs exists. Check the CLI ones by running
  them; check the YAML ones against `src/config/schema.ts`.
- Every relative link resolves.
- `npm run typecheck`, `npm run lint` and `npm test` still green (docs tests exist in
  `test/unit/cli-consistency.test.ts` and `test/unit/branding.test.ts`).

`summary` lists the documents changed and any place where the docs had been wrong.
