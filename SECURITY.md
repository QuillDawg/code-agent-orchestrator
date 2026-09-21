# Security policy

## Supported versions

Pre-1.0, only the newest published release gets fixes. There are no backports to earlier `0.x` versions.

| Version | Supported |
|---|---|
| `2.0.x` (beta) | yes |
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
- if a run is involved, `cao diagnostics <run-id> --out report.json` — one redacted file holding that run's
  doctor facts, workflow, events, orchestrator log and attempt records.

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
- privilege gained through the run directory, the lock file or the request inbox (`stop.json`, `requests/`).

### Out of scope

- What an agent does with permissions you granted it. `--permission-mode bypassPermissions`, a broad
  `claude.allowedTools`, `codex.sandbox: danger-full-access` and `addDirs` outside the repository are all
  doing what you asked.
- Vulnerabilities in Claude Code, Codex or Node itself — report those to their own projects.
- Shell commands in `hooks`, which are yours by definition.
- Running a workflow file you do not trust. That is equivalent to running its author's scripts.

## The request inbox trust boundary

Every run keeps a small inbox at `.orchestrator/runs/<run-id>/requests/`: the file-based channel a second
terminal, a script, or eventually `cao-desktop` uses to ask the owning orchestrator to stop, kill, restart,
edit or prompt a task without holding its lock. The owner treats every file it finds there as a request,
never a command — it is checked against the same validation and staleness rules a call made in-process
would get, and it only ever does what it already names. `approve`, `reject` and `answer` are refused from
disk outright, with the reason spelled out in the ack (`permission controls are not accepted from disk
until presence gating ships`): a permission decision is exactly the thing that must not be grantable by
anyone who can write a file into the repository. See [docs/desktop.md](docs/desktop.md) for the full
inbox, registry and presence contract.

## The desktop app trust boundary

When [announcing is turned on](docs/desktop.md) (off by default), `cao` writes a small amount of
state outside your repository, to `~/.cao` (`CAO_HOME` to override). This is the one place `cao`
and a separate desktop application, `cao-desktop`, meet, and it deserves its own boundary because of
what it is eventually for: **whatever can write into that directory can approve a tool call in a
process that runs arbitrary commands.**

- `~/.cao`, and everything under it, is created owner-only: `0700` on POSIX, and on Windows the
  per-user profile ACL it inherits by being under your home directory — never widened by `cao`.
- **Never point `CAO_HOME` at a shared location** — no network drive, no UNC path, no `/tmp`, no
  directory shared between users or machines. `cao` refuses to write into a `CAO_HOME` it detects as
  a UNC path, a mapped network drive, or a folder synced by OneDrive, Dropbox or Google Drive, and
  (on POSIX) refuses one that is group- or world-writable.
  - This is a check on **path shape**, not on access control lists, and it is worth being honest
    about the difference: `fs.mkdir(mode)` is a no-op on Windows and a POSIX mode bit is a fiction on
    an NTFS volume, so neither artifact can lean on filesystem permissions alone on that platform.
    What the check catches is the failure that actually happens — a home directory that turns out to
    be shared or silently synced to a cloud drive — not a weakened permission on an otherwise
    single-user machine. Real DACL inspection on Windows is future hardening, not yet implemented.
- `cao` treats anything it ever reads back out of `~/.cao` as a **request**, never as a command: it
  is designed to require that a request name something already open (an interaction id that is
  currently waiting on a human, say) and a value that parses as one of a fixed set of shapes. It can
  never introduce a new tool call, widen a permission a workflow did not already grant, or reach a
  run it was not already told about.

Full detail — the registry, presence, and exactly what is and is not implemented yet — is in
[docs/desktop.md](docs/desktop.md).

## Handling of your data

Everything `cao` records — prompts, transcripts, results, diffs, costs — stays under `.orchestrator/` in your
repository, and `cao` adds that directory to `.git/info/exclude` on first use so it is not committed by
accident. Nothing is uploaded. `cao doctor`, `cao report --json` and `cao diagnostics --out` are the outputs meant for
sharing — the last of them is the single redacted bundle to attach to a report, and it leaves out
transcripts, prompts and diffs unless you ask for them with `--include`. All three can still contain paths,
branch names and agent prose, so read them before you paste them into a ticket.
