# Using Barbaro

This guide covers the normal product workflow after the package, skills, and
hooks in [`INSTALL.md`](../INSTALL.md) are installed.

## Before you start

- Run every participating session from the same checkout and project root.
  Barbaro stores coordination state under that checkout's `.barbaro/`
  directory; another worktree has a separate store and namespace.
- Ignore `.barbaro/` before enabling hooks. It can contain prompt, response,
  tool, path, and failure excerpts.
- Installing Barbaro does not enroll a session. Every provider session must
  opt in explicitly, and a newly created session starts dormant.

Barbaro shares completed turns. It does not expose a model response while that
turn is still in progress, and its file claims are advisory rather than locks.

## Diagnose installation and live evidence

```sh
barbaro doctor --project-root "$PWD"
barbaro doctor --project-root "$PWD" --json
```

Doctor is read-only. It checks effective hook layers, duplicates, interpreter
and build identity, skill copies, Git ignore rules, publication evidence and
delivery observations. The JSON schema is `barbaro.doctor.v1`. Exit status is
0 for pass, 1 for an actionable warning/failure, and 2 for invalid usage.
User-wide hooks are valid without project-local settings. Source paths and
coverage limits explain what was inspected; trust, provider launch overrides
and undiscovered plugin/managed settings still need provider confirmation.

`configured` describes files. Publication and model delivery separately report
`observed_working`, `stale`, `unverified` or `attention`. A reservation is not
delivery, an expired uncommitted read is visible, and an ingest attempt with a
publication blocker is not healthy even when its process outcome is `ok`.
Recent means within 15 minutes. Doctor selects the newest members by canonical
publication, main-lease or participation time before applying its eight-per-
provider display cap. Positive working evidence survives limited coverage;
other stale sessions and coverage warnings remain visible beside it. Missing live evidence calls for a real first
turn, parallel-tool turn and small model-visible read, not another installation.
The delivery adapter accepts Codex 0.153.2 and 0.153.3 literal exec forwarders or the
Claude Code 2.1.261 foreground success/batch shape. Claude's hook shape alone
does not attest a version; verify actual provider versions during live tests.
Codex observations carry the version from the session trace, separately from
the installed CLI command version; a desktop producer can differ from that command.

See [dogfood diagnostics](dogfood.md#the-public-doctor) for the evidence fields,
limits and distinction between development freshness and the running build.

## Join a workstream

A workstream is a named objective that scopes routine context, unread cursors,
and wake-ups. It can include one or more Codex sessions, Claude Code sessions,
or both.

In Codex Desktop, invoke the installed skill at the beginning of the prompt:

```text
$barbaro new api-cleanup Replace the deprecated endpoint.
$barbaro join api-cleanup Review the implementation.
```

In Claude Code, use the provider command:

```text
/barbaro new api-cleanup Replace the deprecated endpoint.
/barbaro join api-cleanup Review the implementation.
```

`new` creates the workstream and joins the current session. `join` enrolls the
current session in an existing open workstream. A bare `$barbaro` or
`/barbaro`, or one without a leading `new`/`join` verb, lists workstreams and
joins nothing.

A session belongs to one workstream at a time and can move forward to another
open one. Earlier records remain assigned to the workstream that was current
when they happened. Resuming the same provider session retains its membership;
opening a new provider session does not inherit it.

The CLI command `barbaro workstream new <name>` creates a workstream without
joining a provider session. Enrollment belongs to the provider skill and hook,
not to a hand-written `.barbaro/` marker.

Check the current session without changing it:

```sh
barbaro codex status \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"

barbaro claude status \
  --session-id "$CLAUDE_CODE_SESSION_ID" \
  --project-root "$PWD"
```

For Codex, use `CODEX_SESSION_ID`, not `CODEX_THREAD_ID`; a subagent can have a
different physical rollout ID from its owning session.

## Terminal dashboard

Run the interactive dashboard from the project root:

```sh
barbaro tui
```

The TUI centers one fixed comfort card in the terminal. With no scope flag the
TUI reads the project catalogue and opens on `Home · Open`. Open workstreams
are ordered by their newest known activity. Press `/` to switch to Completed,
where completed workstreams remain discoverable and can be reopened.

The dashboard reports Working, Waiting, and Blocked counts separately. A live
horse gallops only while shown work is Working; Space pauses or resumes that
motion. `--no-motion` replaces it with a text status while refreshes continue.
A read-only `--once` snapshot uses the same full horse on one fixed,
representative pose.

When no shown session is working, a scoped card prioritizes recent completed
responses. `j`/`k` highlights the selected session's completed-turn and detail
rows while the other rows recede. Plain snapshots and `--no-color` omit
styling.

### Controls

- `j`/`k` or the arrow keys select a workstream; Enter opens it.
- `/` switches between Open and Completed.
- `n` opens the create form. Tab and Shift-Tab move between fields, Ctrl-S
  creates, and Escape cancels.
- `x` completes an open workstream or reopens a completed one. Enter confirms
  and Escape refuses. Completion is reversible and does not stop sessions.
- Inside a workstream, `j`/`k` selects the session whose provenance is
  accented.
- `r` refreshes, `?` opens help, Escape returns, and `q` or Ctrl-C exits.
- Space pauses or resumes a visible gallop.

After creation, `c` performs Punch Out: it copies the selected Codex or Claude
join command when a supported clipboard path is available. Punch Out does not
run the join command. The interactive TUI changes project state only after an
explicit create submission or complete/reopen confirmation, using the public
`barbaro workstream` commands.

### Options and snapshots

```sh
barbaro tui --project-root /absolute/path/to/project --interval-ms 2000
barbaro tui --byte-budget 32768 --turns-per-session 8
barbaro tui --workstream api-cleanup
barbaro tui --all-workstreams
barbaro tui --no-color --no-motion
barbaro tui --once --width 120 --height 32
```

`--workstream <name|id>` opens one resolved workstream directly, including a
completed one. `--all-workstreams` explicitly requests the same project-wide
catalogue used by the default Home view. `NO_COLOR` has the same styling effect
as `--no-color`.

`--once` writes a plain, non-ANSI snapshot without taking terminal, clipboard,
animation, or lifecycle-action ownership. An unscoped snapshot is labeled
`Home · Open · snapshot`; a bare snapshot is exactly 64×28. Larger dimensions
center that same card in unused space rather than adding records. A request
below the 12×6 floor receives a true-size notice at the dimensions requested.
`--width` and `--height` are accepted only with `--once`.

Interactive mode refuses `TERM=dumb` or an unset `TERM` before emitting control
bytes and points to `--once`; stdin and stdout must also be attached to a TTY.

## Read peer context

`barbaro read context` returns byte-bounded live leases and the newest completed
turns. When provider identity is supplied, the result is scoped to that
session's current workstream:

```sh
barbaro read context \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"
```

Use `--workstream <name|id>` to read one workstream as an observer or
`--all-workstreams` for the entire checkout. `--byte-budget` and
`--turns-per-session` bound the projection; the result reports what was shown
or hidden. The default delivery budget is 8192 UTF-8 bytes for the complete
envelope and newline. The CLI never changes unread state. Main-agent hooks
acknowledge only full canonical responses (or requests when no response exists)
that successfully reach the model; exact pages accumulate by record/field hash
and byte range. Older gaps remain unread. `delivery.eligible` is only a candidate,
not proof of delivery. Failure, missing output, previews, truncation, unsupported
wrappers and actual output above the ceiling consume nothing.

Claude input queued while its main actor has a current working or waiting lease
keeps the unfinished turn's delivered-content suppression through its first Stop.
That terminal boundary consumes the suppression, so the queued input's later
turn can receive its once-per-revision Stop nudge even without another prompt
hook. Unread gaps stay unread throughout. An expired lease, including one that
expires during a long tool call, uses the ordinary-prompt fallback and can cause
one extra Stop nudge. Old pending reads remain fenced by their input generation.

Cursor capacity is bounded too. `delivery.reason: "coverage_capacity"` returns
an oldest-gap turn id and a `recovery_hint`: read that exact record from its first
page and follow every `next_cursor` in order. Delivered prefixes free sparse
coverage without crossing unread gaps. `pending_capacity` means outstanding
invocations must finish or expire before retrying one foreground read. The CLI
reports capacity without writing state; the committing hook checks it again.

Unread counts are lower bounds when a feed is unavailable. Nudges and await
say “at least”; their coverage reports name the failed feeds and retain counts
for omitted diagnostic details. Context reports `unavailable_feed` in history
coverage, and a scoped delivery read also reports `.value.unread` when its
cursor knows of a missing feed. Healthy feeds remain readable. Unavailable
feeds keep their prior cursor positions; restoring them restores their unread
gaps. Symlinks, hard links, nonregular paths, corrupt cursors and identity
violations still cause refusal.
Raising exact-reader limits can enable observation of larger files, but delivery
still uses its fixed 64 MiB feed and 8 MiB record bounds. Such a selected feed
returns observer output with `delivery.reason: "feed_unavailable"`. Raising
reader limits never restores acknowledgment.

Codex native delivery verification separately scans a pinned whole transcript,
bounded to 128 MiB per native file and 8 MiB per native record. Above either bound,
reads remain observers: unread and saved gaps are preserved, nudges continue,
and ordinary hook activity is not stopped by the resource refusal. Doctor reports
`native_trace_limit` with the bytes observed and the applicable bound; a record
count may be a lower bound if the rest of that record was not read. This bounded
capacity increase does not make delivery unlimited. Long sessions can cross it;
a future pinned-offset incremental reader is needed to avoid a whole-file scan
at each delivery boundary. Neither these native limits nor exact-reader options
raise the canonical-feed limits or the 8 KiB model-facing output ceiling.

Scoped delivery context allocates current-epoch peer turns before own-session
history so a long verdict cannot crowd out a short peer response. Legacy
observer context keeps its chronological ordering. Counts and history limits
still include own-session turns.

Run one foreground read per tool call with full unfiltered output. In Codex
0.153.2 or 0.153.3 code mode use a single literal forwarding expression such as
`text(await tools.exec_command({cmd:"barbaro read context ...",max_output_tokens:10000}));`
with the identity/project flags shown above. Claude uses foreground Bash.
Piping or filtering a `barbaro read` command makes it an observer and cannot
acknowledge turns, even when the command exits successfully.
Legacy `barbaro context`, `barbaro turn show`, turn lists, evidence reads and
foreign/all-workstream reads remain observers under alpha.6 hooks.

Scoped context includes a separate `.value.project_claims` view across the
checkout. Its claim entries name the workstream (`null` means unscoped), actor,
normalized project-relative path, confidence, unknown write scope and expiry.
It exposes foreign claims before your own hook has announced a planned write.
Conversation, intent and ordinary activity remain scoped. Claims are advisory,
never locks. Equal known paths overlap; a path and its slash-delimited descendant
also overlap with inferred confidence. Sibling name prefixes do not overlap.
Normalization is lexical and uses the hooks' POSIX path rules; it does not resolve
filesystem aliases or case differences. Names that differ only in case do not overlap even on a case-insensitive filesystem. Bash/sed writes retain unknown scope; concrete paths come from recognized editor-tool writes. Unknown scope alone asserts no collision. A scoped watcher with no local claims has nothing to compare against a foreign claim, so silence does not prove the path is free.

Check claims and overlaps `shown`/`total` and `coverage` before assuming a path
free. Invalid active records and byte-budget omissions make coverage limited;
unknown scope has its own actor count even when all rows fit. Increasing the
observer `barbaro context --byte-budget` in the same scope can reveal more paths.
If coverage remains incomplete, resolve the uncertainty before writing. The
workstream TUI shows advisory overlap, unknown-scope or incomplete-claims notices
in its caption; scoped context provides the path details. These notices are
separate from the workstream's activity and quiet status.

Treat context as an attention view, not as a complete transcript. Continue to
the lossless readers whenever completeness, older history, or absence matters:
the per-session context window can omit older turns even when
`turns.shown == turns.total`. Inspect `.value.coverage.history` and the
window/projection/attention counts. Always continue when any rendered content has
`truncated.projection: true`, `turns.shown < turns.total`, or a nudge reports
more unread turns than context showed. First page the canonical turn index in
the same scope, then page the response you need:

```sh
barbaro turn list \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"

barbaro read turn show <turn_id> \
  --field response \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"
```

Pass each returned `next_cursor` back through `--cursor` until it is absent.
`turn list` is an exhaustive newest-first index pinned to one feed snapshot;
`turn show` can page the exact `record`, `request`, `response`, or `actions`
field. Concatenating the `text` fields in range order reconstructs the selected
field, and the page reports its total UTF-8 byte count and SHA-256 digest. If a
direct-field page reports `representation: "json-string"`, JSON-parse the
complete concatenated value once. Use `--max-file-bytes` and
`--max-record-bytes` to raise the reader limits for larger stores or records.
Check `diagnostics.skipped_oversized_feed_files` and
`diagnostics.unavailable_feed_files`: a finished index traversal can still have
incomplete source coverage. Those counts remain pinned across its pages. Exact
lookup reports unproven absence when unavailable feeds could contain the target.

If a turn references evidence, retrieve it through its producer's canonical
provider and stable session identity:

```sh
barbaro evidence show <evidence_id> \
  --provider <claude|codex> \
  --session-id <ses_id> \
  --project-root "$PWD"
```

That command defaults to a bounded evidence projection. Add `--field` with
`record`, `content`, `request`, `response`, or `actions` and follow
`next_cursor` with `--cursor` for exact paging. Never read or parse
`.barbaro/**/*.jsonl` directly; those are generated stores, and the public readers
enforce identity, scope, snapshot, and cursor checks.

Here, within the readers' exposed file and record limits, lossless means every
UTF-8 byte of the canonical Barbaro turn plus every referenced canonical
Barbaro evidence record remains reachable through these interfaces.
Provider-raw fields or records that an adapter did not map into the canonical
contracts are outside that guarantee.

## Stream peer activity

`barbaro watch` emits completed turns, joins, incidents, stale leases and
changed cross-workstream path overlaps as they happen:

```sh
barbaro watch \
  --provider claude \
  --session-id "$CLAUDE_CODE_SESSION_ID" \
  --project-root "$PWD"
```

When the identified session is enrolled, the stream is scoped to its
workstream. `--workstream <name|id>` selects a scope explicitly;
`--all-workstreams` watches the whole checkout. `--json` emits one
`barbaro.watch.event.v1` object per line, and `--once` performs one poll after
the baseline. A scoped watcher compares all live known paths in its own
workstream against foreign workstreams, including unscoped actors. `CONFLICT`
contains only the overlapping actors and paths, with advisory confidence.
Routine renewals, command changes, unrelated claims and unchanged overlaps are
silent. Expiry removes a conflict; renewed overlap after expiry is new news.
The initial baseline absorbs existing conflicts; scoped context shows the
current set, including conflicts that predate the watcher.

Watcher-generated turns carry provenance and are suppressed from the event
stream so two watchers cannot wake each other indefinitely. They remain
visible in context and count as unread turns. Claude Code's `/barbaro-watch`
skill arms or disarms the provider-native background monitor around this
command.

## Wait once for unread work

`barbaro await` is a bounded, read-only cursor observer:

```sh
barbaro await \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD"
```

It observes the joined session's hook-owned unread cursor and returns
immediately when peer turns are already unread. Otherwise it waits until a peer
turn arrives or the timeout expires. Every peer turn counts, including one
published after a Monitor wake.

Await reports availability but does not acknowledge or consume a turn. Run
`barbaro read context` once with the same identity/project flags after it returns.
It acknowledges only content whose successful delivery the hooks verify. If the
notice reports gaps outside the delivered window, use its scoped turn index and
exact read commands instead; follow every page cursor.
Concurrent waits for the same session cannot consume or hide one another's
result, though launching duplicates does no useful work.

Identify the session with paired `--provider`/`--session-id` flags or its stable
`--self <ses_id>` identity. Await refuses identity-less, all-workstream, and
foreign-workstream reads because its cursor always belongs to the session's
current workstream. The default timeout is 600000 ms, the hard cap is 3600000
ms. A quiet timeout exits 0 only after a complete final scan. If feeds remain
unavailable at the deadline, await returns `kind: "incomplete"` in JSON (or
`AWAIT incomplete` in text) and exits 1. Healthy unread news still returns
immediately at exit 0 with its lower-bound count and incomplete coverage.

## Workstream lifecycle

```sh
barbaro workstream list --project-root "$PWD"
barbaro workstream list --all --project-root "$PWD"
barbaro workstream show api-cleanup --project-root "$PWD"
barbaro workstream new docs-refresh --title "Documentation refresh"
barbaro workstream complete api-cleanup --project-root "$PWD"
barbaro workstream reopen api-cleanup --project-root "$PWD"
```

Completing a workstream is a reversible statement, not enforcement. The CLI
warns when current members remain live or present but never stops them.

## What the stores mean

- `.barbaro/feed/` contains completed human-turn digests used for routine peer
  context.
- `.barbaro/evidence/` contains supporting facts loaded only when needed.
- `.barbaro/active/` contains expiring advisory snapshots of work in progress.

Canonical derived records are append-only coordination data, not necessarily
small. Reader commands and the TUI apply explicit bounds to their projections.
Never edit these stores by hand, and do not commit or upload them unless their
contents have been deliberately reviewed.
