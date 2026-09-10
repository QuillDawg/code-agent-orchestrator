# transcript-fidelity

Spec section: **H2 Never show the completion object as agent prose**.

## The bug

Workers are told to end with a single JSON completion object. Every runner then records that
object as a `text` transcript entry, which every surface renders as agent prose. Real evidence,
`.orchestrator/runs/2026-09-10-004/tasks/improve-validation-docs/attempts/1/events.jsonl`:

```
{"kind":"text","ts":"2026-09-10T14:31:02.693Z","text":"{\"status\":\"needs_input\",\"summary\":\"...\"}"}
{"kind":"text","ts":"2026-09-10T14:31:18.408Z","text":"{\"status\":\"success\",\"summary\":\"...\"}"}
```

Two of them in one attempt: Codex emitted a completion object mid-turn, kept working, and
emitted another at the end. `cao logs --follow`, `cao peek`, the dashboard follow view and the
activity column all show the raw JSON where the agent's own words belong.

## Deliverables

- A shared classifier - next to `extractJsonObject` in `src/runners/claude/contract.ts`, or in
  a small module beside it - that answers, for one piece of agent text: is this the completion
  object, does it *contain* one, and what is the prose around it? Reuse `extractJsonObject` and
  the contract validator. A JSON object with no `status` is not a completion object.
- `src/runners/codex/codex-runner.ts` (`agent_message`), `src/runners/codex/app-server.ts`
  (`agentMessage`) and `src/runners/claude/claude-runner.ts` (`case 'text'`) all route agent
  text through it:
  - whole message is the object -> record a `result`-shaped entry, not `text`;
  - prose plus object -> record the prose as `text`, the object as the result entry;
  - anything else -> unchanged.
- The activity line never starts with `{`. For a completion object it shows the summary
  (`hooks.onActivity`, `transcriptLine` in `src/types/transcript.ts`, the dashboard task
  column, `live.json`).
- An *intermediate* completion object does not end the attempt and does not look like the final
  outcome in the transcript. The authoritative result stays `final.json` (exec), the last
  `agentMessage` (app-server) and `structured_output` (Claude).
- `events.jsonl` still holds what the agent produced - the raw object must remain recoverable
  for `cao logs --json` and for debugging. If a `result` entry cannot carry it, keep the raw
  text on the entry rather than dropping it.
- `cao logs --json` output shape is unchanged.

## Tests

- `test/unit/transcript.test.ts`: bare object; object in a fenced block; prose before and after
  an object; an object without `status`; malformed JSON that starts with `{`; a message that is
  merely about JSON; a very large blob.
- One assertion per runner (`test/unit/codex-runner.test.ts`, `test/unit/claude-runner.test.ts`
  or the new e2e tests): after a successful attempt, no `text` entry in `events.jsonl` parses as
  a completion result.
- A rendering assertion: `eventLineRenderer` output for such an attempt contains the summary
  text and does not contain `"status":`.

## Out of scope

Hiding or truncating other JSON a worker prints. Tool results, config dumps and code blocks
render exactly as they do today.
