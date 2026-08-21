# Barbaro

> **Public alpha:** Barbaro is experimental and targets trusted local
> development on macOS and Linux with Node.js 22 or newer. Read the
> [alpha limitations](ALPHA.md), [installation guide](INSTALL.md), and
> [security policy](SECURITY.md) before enabling hooks.

Barbaro is a deterministic, project-local coordination layer for coding agents.
It reads Codex and Claude Code session JSONL without modifying the provider
trace, then materializes three small views:

- `.barbaro/feed/`: completed human-turn digests for default peer context.
- `.barbaro/evidence/`: supporting facts loaded only when needed.
- `.barbaro/active/`: expiring advisory snapshots of work in progress.

There is no token or word limit on the source trace and Barbaro never redacts,
truncates, rewrites, or deletes it. Only derived copies may be byte-bounded or
redacted, and those changes are recorded explicitly with fidelity, byte-count,
redaction, and source-reference metadata.

## Current status

| Area | Status |
|---|---|
| Shared `barbaro.turn.v1`, `barbaro.evidence.v1`, and `barbaro.active.v1` contracts | Implemented |
| Codex Desktop legacy JSONL parser, runner, checkpoint/resume, and hooks | Implemented and fixture-tested against `0.148.0-alpha.9` |
| Claude Code empirical schema, mapping, and sanitized fixtures | Implemented |
| Claude Code parser, bundle runner, fixtures, and hooks | Implemented with adversarial lineage and stale-pointer regression coverage |
| Peer event stream (`barbaro watch`) with echo suppression, consumed by the `/barbaro-watch` skill | Implemented |
| Codex paginated histories, missing-start synthesis, lease-expiry abandonment, and `.jsonl.zst` input | Follow-up; rejected or retained as private open state rather than guessed |

The raw Codex envelope is version-pinned but forward-tolerant: unknown record
types and fields are diagnosed without inventing shared semantics. The current
runner targets uncompressed legacy rollouts.

## Install

Install the tagged alpha as a normal npm-managed executable; no development
checkout or `npm link` is required:

```sh
npm install --global github:d4j3y2k/barbaro#v0.1.0-alpha.1
barbaro --help
```

Then follow [`INSTALL.md`](INSTALL.md) to copy the opt-in provider skills and
merge the hook templates without overwriting existing configuration. Installing
the CLI or hooks never enrolls a session.

## Build and verify from source

Requires Node.js 22 or newer.

```sh
npm ci
npm run typecheck
npm test
```

Run a one-off Codex ingest:

```sh
node dist/src/cli.js codex ingest \
  --trace /absolute/path/to/rollout.jsonl \
  --project-root /absolute/path/to/project
```

The first run reads all complete lines. Later runs resume from a byte-accurate
checkpoint and do not duplicate stable records. A partial final JSONL line is
left unconsumed until the provider completes it.

## Watch peer activity

Stream peer events — completed turns, joins, incidents, stale leases — as
they happen:

```sh
barbaro watch \
  --project-root /absolute/path/to/project \
  --provider claude --session-id "$CLAUDE_CODE_SESSION_ID"
```

`--json` emits one `barbaro.watch.event.v1` object per line for tooling;
omit `--provider`/`--session-id` to observe without excluding a session, or
pass `--once` for a single poll after the baseline. Turns caused by a
watcher's own wake-ups are suppressed by their provenance stamp, so two
watching sessions can never wake each other forever.

## Enable Codex live coordination

For Codex on one machine, install Barbaro once at user scope so it is available
from every repository:

1. Install the tagged package as described in [`INSTALL.md`](INSTALL.md) and
   confirm `command -v barbaro` resolves the npm-managed executable.
2. Copy the installed package's `.agents/skills/barbaro` directory to
   `$HOME/.agents/skills/barbaro`.
3. Merge the event entries from [`examples/codex-hooks.json`](examples/codex-hooks.json)
   into `$HOME/.codex/hooks.json`. The shipped commands invoke the portable
   `barbaro` executable on `PATH`.
4. Add `.barbaro/` to `$HOME/.config/git/ignore` so generated coordination
   state stays out of every Git repository.
5. Restart Codex if the skill does not appear, then review and trust the new
   user hook definitions with `/hooks`.

User-scoped hooks remain dormant in every repository until the user explicitly
joins a particular session. The `.barbaro/` store remains isolated under that
session's working project.

For a project-local installation instead, add this exact entry to the target
project's own `.gitignore`:

```gitignore
.barbaro/
```

Barbaro does not alter `.gitignore` automatically. Feed and evidence may contain
sensitive request/response excerpts, so verify the target project ignores this
directory before enabling hooks.

Installed hooks are dormant until the user explicitly joins each session.
Provider-native skills supply the join action:

- In Claude Code, invoke `/barbaro`.
- In Codex, choose **Barbaro** from the composer's slash menu or invoke the
  `$barbaro` skill directly. Codex reserves bare slash-command names, so the
  inserted prompt token is `$barbaro`.

The same prompt can include the first task. For example:

```text
/barbaro Refactor the session writer.
```

The match is deliberately narrow: the provider-native command or skill token
must lead the submitted prompt. Mentioning `/barbaro` or `$barbaro` elsewhere
does not opt in. When Barbaro is selected in Codex Desktop, Codex serializes
the leading token as a Markdown skill attachment. Barbaro accepts it only when
its destination resolves exactly to the current project's skill or the
user-wide `$HOME/.agents/skills/barbaro/SKILL.md`; arbitrary Markdown links do
not opt in.
Consent is scoped to the provider's native session ID.
Resuming that session stays joined; a new Codex or Claude session starts
dormant and must be joined separately. Before invocation, hooks do not publish
active leases or ingest transcript copies. Explicit one-off
`barbaro <provider> ingest` commands are unaffected.

Check enrollment without changing it:

```sh
barbaro codex status --session-id "$CODEX_SESSION_ID" --project-root "$PWD"
```

The result reports only the derived Barbaro session key and join status. For
Codex, use `CODEX_SESSION_ID`; `CODEX_THREAD_ID` can name a subagent's physical
rollout rather than the owning provider session.

Consent covers the whole provider session. If Barbaro is invoked after
earlier turns already completed, the next catch-up may ingest those earlier
turns. Start a fresh provider session before joining when the boundary must
exclude prior conversation.

For a joined session, the hook adapter keeps `.barbaro/active/` current during
prompts and tool use, then ingests completed root and subagent transcripts.
Codex persists
`task_complete` only after synchronous Stop hooks return, so the example uses
two handlers for terminal events: a synchronous `barbaro codex hook` writes the
idle tombstone, while an ingest-only `barbaro codex hook-ingest` runs in the
background and polls for that exact terminal turn. User-prompt and session-end
catch-up cover interrupted workers.

Confirm the packaged CLI is available before enabling project hooks:

```sh
command -v barbaro
barbaro --help
```

For a project-local installation, merge the event entries from
[`examples/codex-hooks.json`](examples/codex-hooks.json) into the target
project's `.codex/hooks.json`. Do not overwrite an existing hook file blindly.
Codex must trust the project and the user must approve its startup hook review
before project-local hooks run. Keep the active handler synchronous and the
Stop/SubagentStop ingest handler asynchronous as shown; making terminal
ingestion synchronous prevents Codex from writing the record it is waiting
for.

Whether hooks are user- or project-scoped, they still require the per-session
command. Installing Barbaro must not silently enroll work in another project.

## Enable Claude Code live coordination

For a user-wide installation available from every repository:

1. Install the tagged package as described in [`INSTALL.md`](INSTALL.md) and
   confirm `command -v barbaro` resolves the npm-managed executable.
2. Copy the installed package's `.claude/skills/barbaro` and
   `.claude/skills/barbaro-watch` directories into `$HOME/.claude/skills/`
   under those same directory names.
3. Merge the hook groups from
   [`examples/claude-hooks.json`](examples/claude-hooks.json) into
   `$HOME/.claude/settings.json`. Replace `BARBARO_BIN` with the absolute
   Barbaro command; append to existing event arrays instead of replacing other
   tools' hooks.
4. Restart Claude Code if its top-level user skills directory did not exist
   when the session started, then verify `/barbaro` and `/barbaro-watch` appear
   in `/skills` and the handlers appear in `/hooks`.

The activity handlers are short and synchronous; ingest handlers run
asynchronously except for the bounded SessionEnd fallback. SubagentStop
ingestion polls until the parent trace records the correlated completion, so
canonical output remains trace-derived rather than trusting hook timing. The
`/barbaro` skill disables model-initiated invocation. After joining, invoke
`/barbaro-watch` to arm peer wake-ups, or `/barbaro-watch off` to disarm them.

Project-scoped installs may use `.claude/skills/` and
`.claude/settings.json` instead, but do not register both user-wide and
project-local copies of the hooks: matching handlers from both scopes would
run twice.

The canonical feed and evidence stay complete. A busy turn can still be large;
peer readers must apply an explicit byte-budgeted projection and report N-of-M
actions rather than silently dropping canonical actions. That reader projection
is separate from—and never edits—the provider trace or stored canonical JSONL.

## Design references

- [`spec/barbaro-v1.md`](spec/barbaro-v1.md): normative shared contract.
- [`docs/codex-jsonl-mapping.md`](docs/codex-jsonl-mapping.md): authoritative
  Codex source mapping and durability policy.
- [`docs/claude-code-jsonl-schema.md`](docs/claude-code-jsonl-schema.md):
  empirical Claude Code source schema.
- [`docs/claude-to-barbaro-v1.md`](docs/claude-to-barbaro-v1.md): Claude Code
  normalization mapping.

This repository ignores its own `.barbaro/`; every target project must make the
same explicit choice. Treat it as sensitive local derived data unless the
project deliberately publishes it.

Barbaro is available under the [MIT License](LICENSE).
