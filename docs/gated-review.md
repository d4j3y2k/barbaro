# Optional gated-review workflow

Barbaro does not require Goal mode, a watcher, or an approval ceremony. This
workflow is only for a builder whose next phase must be explicitly approved by
a peer reviewer.

Both sessions must be enrolled in the same workstream and use the same
checkout. The roles can use different providers or the same provider.

## Start the sessions

For example, enroll a Codex builder:

```text
$barbaro join api-cleanup Build the agreed change and request review before each gated phase.
```

Enroll a Claude Code reviewer:

```text
/barbaro join api-cleanup Review gated requests and answer with the verdict keyword first.
```

Claude Code can optionally arm `/barbaro-watch` so peer turns wake the reviewer.
Codex Goal mode can provide repeated turns, but Goal mode belongs to Codex and
is not a Barbaro command or requirement.

## Handshake

The builder ends a completed turn with one of these messages:

```text
PLAN REQUEST v1: <scope, files, verification, and proposed checkpoints>
CHECKPOINT 1: <what changed, commit SHA, and how to verify>
DONE: <commits>
```

The reviewer's verdict turn begins at byte zero with one of:

```text
PLAN APPROVED
PLAN REVISE: <required changes>
CHECKPOINT 1 APPROVED
CHECKPOINT 1 REVISE: <required changes>
```

No heading, greeting, or status line comes before the verdict keyword. A peer
turn that does not begin with one of those forms—including sideline direction
from a person—is context or instruction, not approval for the next gate.

## Wait without polling

The builder publishes the request by ending its turn. On a later active turn
or Goal iteration, it runs exactly one cursor observer:

```sh
barbaro await \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"
```

If that execution yields, resume it rather than launching a replacement. When
it returns—whether for unread work or a timeout—run one context read:

```sh
barbaro context \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"
```

Await observes but does not acknowledge the unread cursor; context
acknowledges it and exposes the peer turn. A pending review is `WAITING`, not
`BLOCKED`: reserve a blocker for something that genuinely requires a person or
external state before any useful work can continue.

Context is a bounded attention view, so it cannot prove that a verdict is
absent: its per-session window can omit older turns even when
`turns.shown == turns.total`. Before concluding that a verdict is absent, page
the same workstream's turn index and retrieve candidate review responses. Do
the same whenever any rendered content has `truncated.projection: true`,
`turns.shown < turns.total`, or the nudge count is greater than the number of
turns context showed:

```sh
barbaro turn list \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"

barbaro turn show <turn_id> \
  --field response \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"
```

Follow every `next_cursor` with `--cursor` until it is absent before deciding a
gate has no matching turn. `turn show` also supports exact `record`, `request`,
and `actions` fields. Retrieve any referenced evidence with
`barbaro evidence show <evidence_id>` and its producer's `--provider` and
`--session-id <ses_id>`; use its exact `record`, `content`, `request`,
`response`, or `actions` field when a bounded evidence projection is
insufficient.

If a direct-field page reports `representation: "json-string"`, concatenate all
page text and JSON-parse it once. Never read `.barbaro/**/*.jsonl` directly.

Within the readers' exposed `--max-file-bytes` and `--max-record-bytes` limits,
the lossless guarantee covers every byte of the canonical Barbaro turn and its
referenced canonical evidence. Raise those limits for larger stores or records.
It does not cover provider-raw content omitted when the provider adapter created
those canonical records.

Do not poll, send repeated pings, or create timers merely to republish a
finished turn. The provider hooks publish completed turns automatically.
