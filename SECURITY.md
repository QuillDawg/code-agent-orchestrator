# Security policy

## Supported versions

Pre-1.0, only the newest published release gets fixes. There are no backports to earlier `0.x` versions.

| Version | Supported |
|---|---|
| `0.1.x` (beta) | yes |
| anything older | no |

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/QuillDawg/code-agent-orchestrator/security/advisories/new)
— Security → Advisories → Report a vulnerability on the repository.

Please include:

- what an attacker can do, and what they need to start (a workflow file? a repository they can write to? a
  prompt the agent reads?);
- the smallest workflow YAML or command that reproduces it, ideally against
  `test/fixtures/fake-claude.mjs` rather than a real model, so it can be reproduced for free;
- `cao doctor --json` output and the version (`cao --version`);
- the run directory listing if a run is involved.

**Redact before you attach anything.** A run directory holds prompts, transcripts and diffs of real work.

You should get an acknowledgement within a few working days. Once a fix ships, the advisory names the
reporter unless you prefer otherwise.

## What this tool does, and what that means

`cao` is a process orchestrator for coding agents. It is worth being explicit about the boundary:

- It **starts the agent CLIs you configure** (`claude`, `codex`, or whatever `CAO_CLAUDE_COMMAND` /
  `CAO_CODEX_COMMAND` names), `git`, and the shell commands your workflow's `hooks` declare. Those agents run
  with your credentials and whatever tool permissions you gave them.
- It **makes no network calls of its own** and sends no telemetry. All traffic belongs to the agent
  processes.
- It **runs no code an agent produced.** Worker output is data: schema-validated into state, redacted into
  logs, escape-stripped before it reaches a terminal. It is never evaluated as a command.
- **Workflow YAML is executable configuration.** Only `hooks` run shell commands, but they do run them, from
  the repository root. Treat a workflow file from someone else the way you would treat their `Makefile`.
- Permission decisions are yours. With a dashboard attached, Claude workers default to
  `permissionPrompts: ask`; unattended runs should set `permissionPrompts: deny` or pass `--no-tui`.
  "Allow for the rest of this task" only ever replays a rule scoped to that request by the CLI itself.

### In scope

Anything that lets a worker, a prompt injection steering one, or a repository under an attacker's control
escape those rules. For example:

- reaching outside the repository through `workingDirectory`, `promptFile`, `envFile` or `copyIgnored`;
- getting agent-written text executed, or getting it onto the terminal with escape sequences intact — the
  permission prompt an operator is about to answer above all;
- secrets (`envFile` values, token-shaped strings) surviving redaction into a prompt, a result, a log,
  `report.md` or a captured diff;
- one task reading or corrupting another's worktree, branch or run state;
- a crafted workflow file causing arbitrary code execution through anything other than `hooks`;
- privilege gained through the run directory, the lock file or the `stop.json` request file.

### Out of scope

- What an agent does with permissions you granted it. `--permission-mode bypassPermissions`, a broad
  `claude.allowedTools`, `codex.sandbox: danger-full-access` and `addDirs` outside the repository are all
  doing what you asked.
- Vulnerabilities in Claude Code, Codex or Node itself — report those to their own projects.
- Shell commands in `hooks`, which are yours by definition.
- Running a workflow file you do not trust. That is equivalent to running its author's scripts.

## Handling of your data

Everything `cao` records — prompts, transcripts, results, diffs, costs — stays under `.orchestrator/` in your
repository, and `cao` adds that directory to `.git/info/exclude` on first use so it is not committed by
accident. Nothing is uploaded. `cao doctor` and `cao report --json` are the two outputs meant for sharing;
both can still contain paths, branch names and agent prose, so read them before you paste them into a ticket.
