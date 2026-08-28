# Workstreams — design RFC

Status: **phase 1 implemented; phase 2 partly implemented (scoped reader and
watcher); phase 3 partly implemented (complete/reopen and TUI lifecycle;
rename pending).** This document is the
coordination-layer model; `barbaro tui` is a consumer of the model and does
not shape it.

Revision 3 records what phase 1 shipped and folds in the final review items:
the enrollment skill update moved into phase 1; `new` checks and locks the
session's participation before any workstream is created, with a documented
participation → workstream lock order; and the Claude Code exit-2 refusal
was verified against the documented hook contract and deliberately left off
(see "The held task").

Revision 4 records the hook-driven unread cursor, model-visible nudges, the
Stop continuation protocol, and the cursor-based replacement for the original
`WatchEngine` await. `barbaro watch` remains a separate, echo-suppressed event
stream.

## Problem

One project can host several unrelated efforts at once, each with its own
Codex and Claude sessions. Before workstreams every joined session shared one
project-wide peer context (`barbaro context`) and one project-wide wake-up
stream (`barbaro watch`). Unrelated sessions therefore woke each other, spent
context budget on turns that did not concern them, and looked like one
coordination group when they were several.

## Model

```text
project → workstream → session → agent
```

- **project**: one `.barbaro/` store under one checkout root (unchanged).
- **workstream**: one shared objective inside a project. Provider-neutral.
- **session**: one provider session (`ses_…`), exactly as today.
- **agent**: `main` or a subagent actor inside a session, exactly as today.

### Invariants

1. A joined session has exactly one workstream at a time. It may move forward
   to another open workstream; membership changes append to its consent log
   and never rewrite an earlier membership or published record.
2. Subagents carry their parent session's membership history. No separate
   mechanism is needed: leases use its current workstream, while every turn
   and evidence record already carries the timestamps needed to resolve the
   workstream in effect when it happened.
3. Every derived turn, evidence record, active lease, joined-session
   incident, and (phase 2) watch event carries `workstream_id` **by value**,
   stamped at publication and never rewritten. Completed history keeps the
   workstream in effect when it happened because the stamp is part of the
   immutable record.
4. Default peer context and routine wake-ups are scoped to the session's
   workstream (phase 2).
5. Write-claim overlap is project-wide. A scoped reader still sees every
   non-idle claim in the project, compactly, labeled with its workstream,
   and a scoped watcher is woken when a foreign claim overlaps its own
   (phase 2).
6. Workstream identity and batch composition never participate in any
   `turn_`/`ev_`/`lease_`/`act_` ID or stamp decision. IDs stay
   provider-native, and a stamp reads only the record's own timestamp and the
   append-only membership log, so reset reprocessing stays byte-identical.
7. Model configuration (reasoning effort, model name) is not membership data.

## Identity and naming

- `workstream_id`: `ws_` + 32 lowercase hex, **random** (`randomBytes(16)`).
  Every other Barbaro ID is a deterministic hash of provider-native identity;
  a workstream is authored, not derived, so there is nothing to hash. Random
  IDs also make two checkouts that each create `tui-design` mergeable later
  without a collision.
- `name`: a slug, `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, unique among
  workstreams in one project store, renameable (phase 3). Humans type the
  name; records store the ID; renderers resolve ID → current name.
- `title`: optional free text, renameable (phase 3).

## Storage (implemented)

```text
.barbaro/
  workstreams/
    <ws_id>.json                barbaro.workstream.v1 (atomic temp+rename)
    names/<name>                {"workstream_id"} — a uniqueness index only
  sessions/<provider>/<ses_id>.json
                                barbaro.session-participation.v2
                                (+current workstream_id, memberships[])
```

`barbaro.workstream.v1`:

```json
{
  "schema": "barbaro.workstream.v1",
  "workstream_id": "ws_9f2c…",
  "name": "tui-design",
  "title": "Control-terminal design",
  "status": "open",
  "created_at": "2026-08-21T05:00:00.000Z",
  "created_by": { "provider": "codex", "session_id": "ses_…" },
  "updated_at": "2026-08-21T05:00:00.000Z",
  "revision": 1
}
```

`created_by` is `{ "kind": "cli" }` when created by `barbaro workstream new`
without a joining session. Records are never deleted; history references
them.

`barbaro.session-participation.v2` has a required current `workstream_id` and
an optional append-only `memberships: [{ workstream_id, from }]` log. The
current ID always equals the last log entry. An older v2 record without the
log means one membership beginning at `joined_at`; a v1 record means unscoped
until its first forward move (see Legacy sessions). Membership is derived by
scanning `sessions/`; there is deliberately no second member list to drift. A
`role` field is **not** reserved: it has no consumer yet, and an optional field
can be added later without migration.

Implementation: `src/workstreams/` (store, types), `src/hooks/participation.ts`
(grammar, v2 consent, enrollment), `src/core/atomic-json.ts` (shared atomic
JSON writer).

### Concurrency and crash recovery (implemented)

All workstream and participation writes go through the existing
`withDirectoryLock` (`src/output/directory-lock.ts`): a cross-process mkdir
lock with an owner record, immediate recovery of a dead same-host holder,
and a 60 s stale bound. Hook processes are killed at 3–15 s, so no writer
can outlive the stale bound.

**Lock order: participation → workstreams, never the reverse.** A `new`
takes the session's participation lock first, checks that the session is not
already a member of something else, and only then takes the workstream
store's lock (nested) to create. A refused join therefore never leaves an
orphan workstream. The workstream store itself never takes a participation
lock.

**Enrollment.** Two hook processes routinely race on one prompt (`hook` and
`hook-ingest` both call `admit`), and a delayed hook from one prompt can race
a new prompt. The participation write is a read-compare-write under
`withDirectoryLock(<participation file>)`:

- no record → write v2 (temp + rename inside the lock);
- record for the **same** workstream → idempotent success;
- record for a **different** open workstream → append a membership and update
  the current `workstream_id`; the earlier entries remain untouched.

A read-only pre-check runs before the lock so that a refusal creates no
directories at all; the locked pass re-derives the decision on fresh reads.
The lock serializes concurrent moves into one strictly ordered append-only
log.

**Workstream creation.** The record is authoritative for the name; the
`names/<name>` claim is a uniqueness index, never a source of truth. Every
creator holds `withDirectoryLock(workstreams/)` for the whole operation, so
the only way to observe a half-finished one is a crash mid-sequence, and the
resolver is written to treat that as noise:

- resolve `name` → read claim → `ws_id` → read record → valid only if the
  record exists **and** `record.name === name`; otherwise the claim is
  *stale* and ignored;
- list → from records, never from claims;
- `new <name>` under the lock: a live claim → refused as existing (open or
  completed); a missing or stale claim → write the claim, then the record.

A crash leaves at most a stale claim, which the next writer repairs under the
lock. No age heuristic is needed because the record, not the claim, decides.
A completed workstream keeps its claim, so an old name always resolves to its
history; reusing a name means reopening, not re-creating. Rename (phase 3)
follows the same rule: write the new claim, write the record with the new
name, unlink the old claim if it still points at this ID.

### Stamp placement and contract evolution (implemented)

Optional top-level `workstream_id` on `barbaro.turn.v1`,
`barbaro.evidence.v1`, and `barbaro.active.v1`, plus the incident marker.
`extensions.barbaro` was rejected as a permanent home: that slot is reserved
for provider data, and a first-class concept should be a first-class field.

The v1 schemas are closed (`additionalProperties: false`, `schema` is a
`const`), so this is a contract revision. `spec/barbaro-v1.md` now carries a
**Contract evolution** section and a revision log (v1 rev 2, 2026-08-21):
optional top-level fields may be added within v1; readers treat absence as
"not known"; a validator pinned to an older schema copy rejects newer
records and that is the documented cost; removal, renaming, or changed
required semantics is a v2 bump.

Determinism: the stamp is resolved **by the runner** from the participation
store (`src/runner/workstream-stamp.ts`), never passed in by the caller. Each
turn selects the latest membership whose `from` is at or before `started_at`;
each evidence record does the same with `occurred_at`; a record before the
first entry stays unscoped. `barbaro claude hook-ingest`, manual ingest, and a
`--reset` re-ingest of the same session therefore produce byte-identical
records even after later moves (pinned by tests).

Incidents: `session_dormant` markers never name the session and therefore
never carry a workstream. `hook_error` markers for a joined session do.

## Lifecycle

Explicit status, set by a person:

| `status` | Meaning | Accepts joins |
|---|---|---|
| `open` | Work is ongoing or may resume | yes |
| `completed` | A person declared the objective reached | no — reopen first |

Transitions: `open → completed` and `completed → open` (reopen). The store
implements `setStatus`; the CLI verbs land in phase 3. A third `archived`
state is deliberately deferred until a real listing is long enough to want
it.

Liveness is **derived**, never stored (phase 3 roster), following the
existing rule that enrollment is forever and presence is a lease:

- `live`: at least one member whose `main` lease is unexpired and non-idle;
- `present`: at least one member with any unexpired `main` lease;
- `quiet`: neither.

Nothing auto-completes a workstream; a quiet open workstream is just quiet.
Completion is a statement, not enforcement: members of a completed workstream
may keep working and their turns still stamp that workstream. Two rules keep
that from hiding anything (phase 3):

- `barbaro workstream list` shows every open workstream **and every
  completed workstream that is still `live` or `present`**, flagged; `--all`
  shows the rest;
- `barbaro workstream complete` warns when members are live or present, and
  a scoped `barbaro context` reports `workstream.status` so a member can see
  it is working inside a completed workstream.

Status changes and renames are CLI commands, not hook-gated: they publish
nothing about a session, so the consent rule does not apply, and they are
reversible. The model may run them when a user asks in plain language.

## Enrollment: two phases (implemented)

The hook parses a small grammar on the first line:

```text
/barbaro                      bare      → no enrollment; roster
/barbaro new <name> [task…]   create+join
/barbaro join <name> [task…]  join
/barbaro <anything else>      bare + task text → bare; the task is held
$barbaro …                    same, Codex token form
[$barbaro](…/SKILL.md)&#x20;new <name> …
                              same, Codex composer-attachment form
[$barbaro](…/SKILL.md)&#x20;
new <name> …                  Desktop puts a newline after the attachment;
                              the arguments are the first words that follow,
                              on that line or the next non-empty one, and a
                              repeated `$barbaro`/`/barbaro` there is ignored
```

`join` always names its target. A "join the only open workstream" shortcut
was considered and rejected: moving the current session is consequential and
must name its target explicitly; the roster already puts the name on screen.

Hook behavior (`SessionParticipationStore.admit`):

- **bare**: returns `pending: "workstream-selection"` with a roster message.
  Writes nothing — not even a directory — and records **no**
  `session_dormant` incident (it is the intended first phase, not a
  failure); later non-Barbaro prompts in a still-dormant session record it
  as before. In an already-joined session a bare invocation is a no-op that
  reports the current workstream.
- **new**: under the participation lock, checks membership, then creates the
  workstream (nested lock) and writes participation v2. For an unjoined
  session, a name that already exists is **refused** with a reason. For a
  joined session, a different open target is a forward move (including an
  open target concurrently created after the read-only check); a free name is
  created and then becomes the new current workstream. A completed target is
  refused.
- **join**: resolves the name to an open workstream and writes participation
  v2. Idempotent for the current workstream; a different open target appends
  a forward membership. Joining a completed or unknown workstream is refused.
  An invalid slug is refused with the rule.

Only the provider hook, carrying the user's exact leading invocation, may
write participation. That rule is unchanged: the second phase is still a
typed `/barbaro join <name>` or `/barbaro new <name>`, so the skills never
create consent on the model's behalf.

**The held task.** A bare invocation that carries task text (`/barbaro Fix
the writer`) is a user asking for coordination *and* work. The work does
not proceed uncoordinated: the `/barbaro` and `$barbaro` skills instruct the
model to present the roster, ask for `join`/`new`, and not start the task;
after the user re-invokes with a target, the model continues the task from
the earlier prompt, which is still in the conversation.

A hook-level refusal on Claude Code was evaluated and **not enabled**. A
`UserPromptSubmit` hook exiting 2 blocks the prompt and shows stderr to the
user, but the documented contract also erases the blocked prompt from
context, so the held task would not survive into the model's view and the
user would have to re-send it. The skill-level hold keeps the task in
context, which is the better trade. If it is ever enabled, it must fire only
on an unjoined `pending: "workstream-selection"` result — never on a
refusal, never in a joined session — and the message must tell the user to
re-send the task with the verb.

**Feedback channel.** On Claude Code the synchronous `barbaro claude hook`
prints the admission message (roster, confirmation, refusal) to stdout on
join-related invocations only; Claude Code adds `UserPromptSubmit` hook
stdout to the model's context. The async `hook-ingest` never prints.
`barbaro codex hook` stays silent until Codex's hook stdout semantics are
verified; the Codex skill reads the outcome back through
`barbaro codex status` and `barbaro workstream list`. `status` now reports
`workstream: { workstream_id, name, status }` for a v2 consent record and
`unscoped: true` for a v1 one. Joined status also reports the resolved
`memberships` list (including the synthetic first entry of an older v2
record); v1 status reports an empty list until the session moves.

Both Claude events (`UserPromptSubmit` with the raw prompt,
`UserPromptExpansion` with `command_name: "barbaro"`) fire for one prompt.
`UserPromptSubmit` always carries the raw first line and is parsed
authoritatively; the expansion event is parsed if it carries the line and
treated as bare otherwise. Bare never undoes a join, so double delivery is
harmless.

## Scoping semantics (phase 2)

Shipped so far (first slice): `readProjectContext` and `WatchEngine` accept a
`workstreamId` and filter leases, turns, joins, and stale events by the
record's stamp (incidents pass when they name that workstream or none);
`barbaro context`/`barbaro watch` resolve the scope from
`--provider/--session-id` (the session's own workstream), `--workstream
<name|id>`, or `--all-workstreams`; watch lines carry `ws=`; the context
projection reports `workstream_id`; `/barbaro-watch` reads context scoped.
Still pending from this section: `foreign_claims`, the roster, the
`conflict` event, and the armed summary's project totals.

### TUI status views and explicit lifecycle writes

The project-scoped TUI opens on `Home · Open`. Its Home rows, activity totals,
and News carousel draw only from open workstreams; `/` switches to the
Completed view so completed records remain discoverable and can be reopened.
Both views retain their own selection and report the open and completed
populations explicitly instead of presenting a filtered list as the whole
catalogue. A direct `--workstream <name|id>` scope may still inspect either
status.

Ordinary navigation, refresh, filtering, help, and `--once` are read-only. The
interactive TUI has exactly three explicit write paths: create, complete, and
reopen. Each invokes the corresponding public `barbaro workstream
new|complete|reopen` CLI command; complete and reopen require confirmation, and
the TUI rereads the catalogue before it reports success. It never writes a
workstream record or provider trace directly. Completion remains a reversible
statement, not enforcement, and therefore does not stop active sessions.
Unscoped `--once` captures and labels the default Open view; it exposes no
lifecycle keys. A completed workstream remains directly snapshot-able with
`--workstream`.

### Peer context (`readProjectContext`)

Scope is chosen by the caller: `--provider/--session-id` (self → own
workstream), `--workstream <name|id>`, or `--all-workstreams`. A caller with
an unscoped (legacy) self, or no self, reads project-wide as today.

A scoped `barbaro.reader.context.v1` gains:

- `workstream`: `{ workstream_id, name, status }` for the scope;
- `active` / `turns`: members of the scope only;
- `foreign_claims`: bounded, compact `{ path, confidence, provider,
  session_id, agent_id, state, expires_at, workstream_id?, workstream? }`
  for every non-idle, unexpired lease **outside** the scope, including
  unscoped sessions, plus a count of foreign leases with
  `unknown_write_scope`;
- `workstreams`: bounded roster `{ workstream_id, name, status, liveness,
  enrolled_sessions }`;
- `diagnostics` gains `workstream_records`, `invalid_workstream_records`,
  `unscoped_sessions`.

The projection remains noncanonical and byte-bounded; the new sections
participate in the same budget. Phase 1 already carries `workstream_id` on
each projected turn and lease so consumers can group by it today.

### Wake-ups (`WatchEngine`)

`barbaro watch --provider … --session-id …` resolves self's workstream and
scopes automatically; `--all-workstreams` observes everything (TUI,
observers). Per event kind:

| Event | Scoped watcher receives |
|---|---|
| `turn` | own workstream only |
| `join` | own workstream only |
| `stale` | own workstream only |
| `incident` | own workstream, plus unscoped markers (`session_dormant`, pre-workstream `hook_error`) — rare, deduped, write-once |
| `conflict` | **project-wide**: any other session's claim that overlaps one of self's current claims |
| `armed` | own workstream's `live`/`enrolled` plus project totals |

Events carry `workstream_id` and the name at observation time.

`conflict` is new and is the one lease-derived event the engine emits. The
engine has so far refused to treat `active/` churn as news because a lease
revision per tool call is noise; a foreign claim on a path this session is
writing right now is the single fact the watch skill already names as worth
stopping for, and waiting for the next `barbaro context` read to reveal it
leaves a gap. Mechanics: each poll reads self's snapshots (main and
subagents) and every other non-idle unexpired lease, emits one event per
`(foreign lease_id, path)` pair when the pair first overlaps, and re-arms
that pair once it stops overlapping. Only `exact`/`inferred` claims can
overlap; `unknown_write_scope` leases are reported in context counts, not as
events. Claims live between `PreToolUse` and `PostToolBatch`/`PostToolUse`,
so a 2 s poll can miss a brief overlap; the `turn` event's `changed=` list
remains the durable after-the-fact signal. By invariant 5 this event is
project-wide: overlap inside one workstream matters exactly as much as
overlap across two.

### What stays visible across workstreams

- the roster: names, status, liveness, member counts;
- foreign write claims (paths only) and `unknown_write_scope` counts;
- `conflict` events;
- unscoped incidents;
- everything else on explicit request (`--workstream X`,
  `--all-workstreams`).

Not visible by default: other workstreams' turns, joins, and stale leases.

## Forward membership moves (accepted and implemented 2026-08-22)

Invariant 1 as shipped — one workstream per session for life — is right for
builders and reviewers, which are cheap to start per effort, and wrong for
the seat that holds a person's long-lived context: a main agent the user
talks to across efforts should be able to walk from a finished workstream to
the next one without losing its conversation. The relaxation keeps every
determinism guarantee by making membership an append-only log and stamping
records by time:

- **Membership is a log.** The consent record (`barbaro.session-participation.v2`)
  gains an optional `memberships: [{ workstream_id, from }]` (append-only,
  `from` strictly increasing). `workstream_id` always equals the last entry
  and is what every current reader, the hooks, and `status` treat as "the
  session's workstream"; `joined_at` stays the first join time. A record
  without `memberships` means one membership from `joined_at`.
- **Moves go forward only.** `/barbaro join <other>` (or `new <other>`) in an
  already-joined session appends a membership to that open workstream and
  reports "moved … from …; earlier turns stay where they were". Moving to a
  completed workstream, or to the one already current, is refused/idempotent
  as today. Nothing ever rewrites an earlier entry. Lock order is unchanged.
- **Pre-workstream sessions may move forward too.** A v1 (unscoped) record
  moving to a workstream becomes v2 with `memberships: [{ws, from: now}]`:
  its earlier turns carry no stamp and stay unscoped; only turns started
  after `from` are scoped. This replaces "unscoped forever" with "unscoped
  until it moves", without adoption — no published record changes.
- **Stamp by time, not by session.** The runner stamps each published record
  with the membership in effect at the record's own moment: turns by
  `started_at`, evidence by `occurred_at`; records before the first
  membership get no stamp. Leases, incidents, and scoped reads/wake-ups use
  the current membership. Because the log is append-only and the rule reads
  only the record's timestamp, a reset re-ingest recomputes identical bytes;
  a move mid-turn may leave a turn and some of its evidence in different
  workstreams, which is accepted and documented rather than guessed around.
  The move turn itself is stamped with the new workstream: the hook appends
  the membership before the prompt record lands. Codex persists its native
  `task_started` event before running the prompt hook, so that hook anchors
  the new entry's `from` to the same durable `started_at` value the normalizer
  will publish; it does not substitute the later hook wall-clock time.
- **Wake-ups.** A scoped watcher in the target workstream receives a `join`
  event for the move (the engine keys known sessions by session and current
  workstream); the source workstream receives nothing. `status` reports the
  current workstream and the log.
- **Unchanged.** Being in two workstreams at once is still not a thing — a
  record belongs to one — and any session can still read any workstream
  with `--workstream`/`--all-workstreams`.

Invariants 1 and 6 above now encode the shipped rule: a session has one
workstream *at a time*; it may move forward to another open workstream; every
record keeps the workstream in effect when it happened.

## Barbaro nudges (accepted 2026-08-23; implemented)

Agents in one workstream cannot interrupt each other, but Barbaro already runs
inside each participating agent's synchronous provider hooks. Nudges use those
existing boundaries to add one short model-visible line to activity that is
already happening. A nudge never starts a turn, sends a ping, arms a timer, or
runs a background poll. It is content-agnostic: every completed peer turn in
the current workstream counts, including a `task-notification` turn produced
when a reviewer answers from a Monitor wake.

### Cursor state and ownership

Each joined provider session has one cursor at
`.barbaro/state/nudge/<provider>/<ses_id>.json`. Its
`barbaro.nudge-cursor.v2` record contains the stable provider/session identity,
current `workstream_id`, the current membership's `from` timestamp,
`cursor_revision`, a byte checkpoint for each peer feed, one revision-bound
`stop` latch, and a delivery ledger. The ledger records the highest unread
count announced by any channel and, when known, the exact provider turn that
received the last delivery. Codex supplies its stable derived `turn_id`;
because Claude does not expose a turn id to hooks, its cursor carries a strictly positive
synthetic generation that advances on each admitted main `UserPromptSubmit`
and remains monotonic across context acknowledgements.

Existing `barbaro.nudge-cursor.v1` records remain strictly accepted. Readers
observe v1 or v2 byte-for-byte without migration. The next hook-writer
transaction upgrades a valid v1 record conservatively: any legacy delivery
marker seeds the current unread count as already announced, a legacy `stop`
marker preserves the Stop latch, and only a definite new prompt is treated as
a new turn. Both schemas reject unknown fields, malformed identities, and
markers that do not equal `cursor_revision`; corrupt bytes are left untouched
and surface through the provider hook's existing fail-open incident path.

The cursor is **hook-owned**. Only synchronous provider hooks may create or
replace it, under the cursor file's directory lock and atomic-replace boundary.
The unread inspector used by cursor-based `barbaro await` is an observer: it
never initializes, advances, repairs, claims, or clears cursor state.
`barbaro context` and the TUI's catalogue/refresh paths likewise leave the
cursor read-only; the TUI's only writes are the explicit public-CLI lifecycle
actions described above. In particular, two concurrent awaits read the same
state and cannot consume news from one another. A leading `barbaro context`
tool call is separately acknowledged by that session's main-agent
`PreToolUse` hook after the event passes its provider turn fence. For Codex,
that means either the current active lease turn or a trace-attested fresh goal
turn. On admission the hook pins the scan endpoints, increments
`cursor_revision`, clears the Stop latch and delivery high-water, and preserves
Claude's synthetic turn generation before the command runs. This fully re-arms
all channels. A stale or unattested Codex boundary leaves both lease and cursor
untouched.

The membership epoch is part of the cursor identity. Every scan rechecks the
current participation record around the cursor operation and retries a bounded
number of times if it moves. Only another session's turn in the current
workstream with `ended_at` strictly later than the current membership's `from`
counts. This `membership_from` fence prevents both cross-workstream history and
a late-backfilled pre-membership turn from becoming news. Moving forward to a
new workstream re-fences the cursor and advances its revision; published
history is never rewritten.

Unread is computed from persistent feed checkpoints, not from a fresh watcher
baseline. An absent cursor is a valid uninitialized state: observers build a
read-only virtual cursor at the current membership fence and scan qualifying
post-membership history without creating a file. A turn that completed before
the hook or await began is therefore still unread. Scanning counts **all**
qualifying peer turns and does not call `isEchoTurn`; echo provenance continues
to govern `barbaro watch` only. An existing malformed, oversized, or
path-inconsistent cursor is not guessed around or silently repaired: cursor
access fails closed, while the surrounding provider hook remains fail-open.

### Delivery and acknowledgement

After enrollment admission, only the session's `main` actor may claim a nudge.
Prompt and tool boundaries share one revision-wide announcement high-water,
without advancing the unread checkpoints. Once any channel announces an
unread count, later `UserPromptSubmit` and tool-boundary hooks stay silent
until the count grows; a peer turn arriving mid-turn therefore produces one
new tool-boundary nudge, while repeated boundaries at the same count cannot
spam the model. Claims are serialized by the cursor lock, so concurrent prompt
and tool hooks can announce a new count only once.

Stop uses the same last-delivery turn identity plus its separate
revision-bound latch. It never blocks a turn that already received a delivery
for the current revision. That decline leaves the latch untouched, allowing a
later still-unread turn to block exactly once; after a successful block, every
later Stop at that revision is silent even if it carries a different turn id.
An admitted context acknowledgement advances the revision and re-arms the
high-water and Stop latch; an event rejected by the turn fence advances
neither cursor state nor delivery state.

The line reports the unread count, a bounded one-line preview of the newest
peer response, and `run barbaro context`. Claude `UserPromptSubmit` keeps its
stdout wholly plain text; Claude tool boundaries use the event's
`additionalContext`; Stop uses the provider's blocking decision shape. Codex
uses only hook output channels verified against its pinned schema.
`PermissionRequest` remains lease-only: it is not another nudge channel, but
it participates in Codex turn admission so the activity lease is honestly
`waiting`.

Consent remains the first fence. An unjoined or workstream-pending session
gets no cursor, marker, nudge, feed publication, or named activity lease.
Subagents keep their independent advisory leases but cannot claim or clear the
parent session's unread cursor.

### Stop continuation protocol

A main-agent Stop first writes an idle tombstone, before any fallible cursor
scan. If `stop_hook_active !== true`, unread is nonzero, the `stop` latch has
not been claimed at this revision, and the current provider turn has received
no delivery, the hook reopens only that exact idle lease revision as `working`,
with no write claims. It holds the actor lock through the cursor claim, coupling
the latch to the continuation that emits the block: newer activity either wins
before the continuation and no latch is claimed, or follows a successfully
reopened Stop. The hook returns
`decision:block` with the nudge, a bounded preview of
`last_assistant_message`, and instructions to run `barbaro context` and then
resend the actual previous response verbatim unless peer context changes it.

The Stop caused by that continuation arrives with `stop_hook_active:true`.
Its handling is unchanged: it cannot block again and settles the lease to
idle. A repeated Stop at the same cursor likewise cannot reclaim the latch and
remains honestly idle. If cursor inspection fails, the cursor is left
untouched, the provider is not blocked, and the idle tombstone remains the
truthful terminal state. If the cursor claim succeeds but the exact active
continuation cannot be persisted, the hook conditionally rolls back that Stop
latch while it still holds the actor lock. It restores the prior delivery
ledger only if no newer informational announcement changed it, so a concurrent
higher unread count remains announced and the next eligible turn can retry
Stop safely. A lock cleanup failure after either atomic replacement is treated
as a committed outcome: the hook still emits the block and records a local
incident instead of misclassifying durable state as an uncommitted failure.

Codex goal iterations apply the same identity-and-latest-turn fence to
main-agent `PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop`, because
a text-only continuation may have no `UserPromptSubmit`. A boundary may roll
over an idle older-turn lease to a different turn only when one validated
rollout snapshot matches the session/project, has no malformed or partial
tail, and its latest `task_started` attests the event's native turn. An idle
same-turn tool boundary is terminal or delayed and stays stale. An admitted
`PreToolUse` writes the new turn as `waiting` for `barbaro await` and `working` otherwise;
`PermissionRequest` writes `waiting`, and `PostToolUse` writes `working`.
Active-lease mismatches, delayed older events, and malformed, partial, or
unattested rollout tails stay stale; a mismatched rollout identity is rejected.
None can mutate the lease, cursor, or delivery markers, and a delayed older
Stop cannot consume the current turn's marker.

When a Stop is deliberately blocked, its reopened lease carries a turn-bound
`barbaro_stop_continuation` extension. The asynchronous ingest hook observes
that marker and returns an intentional nonterminal result rather than timing
out while Codex has not yet written `task_complete`; the following active
Stop, next prompt, or session end remains the normal catch-up boundary.

### Found in probe (2026-08-23)

A live reviewer turn exposed a Claude publication stall in the interaction
between PreToolUse nudges and a stale `last-prompt`. Claude Code records a
PreToolUse hook's `additionalContext` as a UUID-bearing attachment side branch
from the assistant's `tool_use`: `hook_success` then
`hook_additional_context`. The `tool_result` is a second child of that same
tool call. The runner counted both children as competing continuations, then
also treated the off-chain attachment UUIDs as a disconnected tail, so it
withheld the completed verdict as `ambiguous_pointer_continuation` until the
next turn rewrote the pointer.

The stale-pointer rule now treats a child branch as transparent only when the
child and its entire descendant subtree are attachment records. The same
exception applies when checking for stray post-pointer rows. An attachment
that leads to a user, assistant, or system record remains part of the unique
continuation, while two semantic children, rewinds, cycles, and disconnected
semantic tails remain ambiguous. This applies to attachment sidecars from any
PreToolUse hook, not only Barbaro.

A sanitized replay preserves the observed topology through the Stop-blocked
context read, verbatim re-send, and `turn_duration`; it must publish one turn
at that Stop. A paired replay adds a second semantic child and must still
withhold. The five stale-pointer/truncated-turn regressions introduced with
`403ea27` remain unchanged. PreToolUse delivery stays enabled because it gives
the model useful early notice and the runner now models its sidecar honestly.
The v2 delivery ledger adds the reliable same-turn identity and shared unread
high-water needed to suppress a redundant later Stop without losing the next
turn's once-per-revision safeguard.

### The three repaired failures

- **Baseline race:** no `WatchEngine.prime()` is involved. Persistent cursor
  checkpoints make an already-landed peer turn immediately unread.
- **Echo collision:** unread scanning has no echo filter, so a Monitor-wake
  `task-notification` verdict counts even though `watch` still suppresses it.
- **Double waiter:** context and await are observers. Any number of waiters see
  the same unread state; none advances it. The context `PreToolUse` hook is the
  single acknowledgement writer.

## Codex wake: cursor-based `barbaro await` (revised 2026-08-23)

Claude's Monitor remains its primary external wake. Codex has no external
wake, so an agent with nothing else to do may explicitly block on unread peer
turns. `barbaro await` is a bounded, one-shot observer, not a watcher mode and
not a nudge scheduler.

- **CLI.** `barbaro await [--project-root <p>]
  [--provider <claude|codex> --session-id <id> | --self <ses_id>]
  [--workstream <name|ws_id>] [--timeout-ms <n>] [--interval-ms <n>]
  [--json]`. It requires one joined session identity and its cursor is always
  fenced to that session's current workstream. Identity-less,
  `--all-workstreams`, and foreign-workstream awaits are refused. `watch`
  remains unchanged.
- **Unread, not events.** Await repeatedly calls the observer-only unread
  projection. It returns immediately when `unread_count > 0`, printing
  `<n> unread — run barbaro context` (or the corresponding
  `barbaro.await.v1` JSON record with `kind:"unread"`, provider, stable
  session ID, workstream ID, cursor revision, and unread count), without
  consuming the cursor. Otherwise it blocks until unread appears or the
  deadline passes. A peer turn that landed before await started and a
  Monitor-wake echo turn are both visible.
- **Acknowledge, then react.** Await reports availability, not content. After
  it returns, run `barbaro context` once; the main-session hook advances the
  cursor, and the command shows what changed. Then react and end the turn.
  One await per later turn or goal iteration keeps the workflow legible.
  Provider execution may yield while the child command continues, but
  correctness no longer depends on preserving one privileged waiter:
  concurrent waits are nondestructive observers. Do not start polling loops,
  replacement waits, pings, or timers.
- **Timeout is not failure.** On timeout print
  `AWAIT timeout after <n> ms — no peer event` (JSON:
  `{"schema":"barbaro.await.v1","kind":"timeout","timeout_ms":n}`) and exit
  0. Run context once before posting `WAITING` to close the deadline boundary.
  Exit nonzero only for real errors such as a missing store, unjoined or
  mismatched identity, corrupt cursor, or bad flags. Default timeout is
  600000 ms; the hard cap is 3600000 ms.
- **Waiting looks like waiting.** The activity hooks recognize a command whose
  leading tokens are `barbaro await` and write `state:"waiting"`, the command
  as `current_action`, no claims, and a lease lifetime covering the bounded
  wait plus grace. The next provider boundary restores `working` with the
  default lifetime.
- **Not an action.** Whole-simple-command `barbaro await` and
  `barbaro context` invocations are excluded from both provider digests.
  Shell composition, redirection, a newline, or command substitution remains
  a recorded action.

### Known limitation (updated 2026-08-23)

`isEchoTurn` still suppresses Monitor-wake `task-notification` turns from
`barbaro watch`, preserving the watcher's loop breaker. It no longer makes
nudges or await blind: cursor unread deliberately counts all peer turns. Await
still cannot start or resume an agent turn; it is useful only inside activity
the user or goal runner already started, while lifecycle hooks provide nudges
at the boundaries that activity naturally reaches.

## Legacy (pre-workstream) sessions

A v1 participation record means *unscoped*. Unscoped sessions:

- keep working exactly as today until they move; their reader and watcher are
  project-wide while v1 remains current;
- appear to scoped readers only through `foreign_claims`, `conflict`
  events, and the `unscoped_sessions` count, never through turns;
- may move forward with `new`/`join`, which rewrites only the mutable consent
  marker as v2 with its first membership beginning at the move time. Earlier
  records remain unscoped because their own timestamps precede that entry;
  they are never adopted or rewritten, and reset re-ingest reproduces them
  without a stamp.

The sessions that predate workstreams stay unscoped until they explicitly
move; new sessions opt into a workstream at their first join.

## Worktrees and project identity

The store stays **per checkout** for this change. `projectRoot` is the hook
`cwd`, Codex asserts it equals `session_meta.cwd`, and conflicts are framed
throughout as a shared-checkout concern. Two worktrees are two projects with
two `.barbaro/` stores and two workstream namespaces; claims on the same
repo-relative path in different worktrees do not collide on disk, so
per-checkout stores are also semantically correct for claims.

A workstream that spans worktrees (implementer in A, reviewer in B) needs a
**repo-level store** — most naturally under the Git common dir, which would
also remove the `.gitignore` requirement — plus a `checkout` qualifier on
claims, a rewritten doctor, and a store-root resolver. That is a separate
RFC. Random workstream IDs and checkout-free records keep the door open.

## CLI surface

```text
barbaro workstream list     [--project-root <p>] [--all]            # phase 1 (liveness flags: phase 3)
barbaro workstream show     <name|ws_id>                            # phase 1
barbaro workstream new      <name> [--title <t>]                    # phase 1: create without joining
barbaro workstream rename   <name|ws_id> --name <new> [--title <t>] # phase 3
barbaro workstream complete <name|ws_id>                            # phase 3: warns if live/present
barbaro workstream reopen   <name|ws_id>                            # phase 3

barbaro claude|codex status --session-id <id>   # + current workstream, memberships[] | unscoped
barbaro context  … [--provider <p> --session-id <id> | --workstream <name|id> | --all-workstreams]   # phase 2
barbaro watch    … (self → own workstream) [--all-workstreams]      # phase 2
barbaro await    … (joined self cursor only) [--timeout-ms <n>]     # cursor wait
barbaro tui      … [--workstream <name|id>]                         # reader + explicit new/complete/reopen
```

Skills (phase 1, shipped): `/barbaro` and the Codex `$barbaro` skill document
the grammar; on a bare or refused invocation they present the roster, ask
for `join`/`new`, and hold any supplied task; they never create consent on
the model's behalf. `/barbaro-watch` passes self so the watcher is scoped
and receives `conflict` (phase 2).

## Implementation map

| Area | Change | Phase |
|---|---|---|
| `src/workstreams/` (new) | `WorkstreamStore`: create, get, list, resolve, setStatus; record-authoritative names; every writer under `withDirectoryLock(workstreams/)` | 1 ✔ |
| `src/core/atomic-json.ts` (new) | shared atomic JSON file writer | 1 ✔ |
| `src/hooks/participation.ts` | grammar parser (token and attachment forms); participation v2; locked read-compare-write join with read-only pre-check; `admit` → join/new/bare/refused with messages | 1 ✔ |
| `src/hooks/claude.ts`, `codex.ts` | pending/refused handling; no incident on bare or refusal; `workstream_id` on lease identity; message surfaced (Claude stdout) | 1 ✔ |
| `src/runner/workstream-stamp.ts` (new), `runner/claude.ts`, `runner/codex.ts` | runner-side stamp from the consent record | 1 ✔ |
| `src/contracts/v1.ts`, `src/active/{types,validation,store}.ts`, `spec/*.schema.json`, `spec/barbaro-v1.md`, `examples/v1/active-workstream.json` | optional `workstream_id`; Contract evolution section and revision log | 1 ✔ |
| `src/reader/{types,store,projection}.ts` | `workstream_id` carried through guards and projections | 1 ✔ (scoping: 2) |
| `src/hooks/incidents.ts` | optional `workstream_id` | 1 ✔ |
| `src/cli.ts` | `workstream list|show|new`; richer `status`; Claude hook message printing | 1 ✔ |
| skills ×2 + `openai.yaml`, README, `docs/claude-to-barbaro-v1.md`, `docs/dogfood.md` | grammar, two-phase flow, held task | 1 ✔ |
| `src/reader/store.ts`, `src/watch/{engine,format,types}.ts`, `src/cli.ts`, `/barbaro-watch` | scope by `workstreamId`; `--workstream`/`--all-workstreams`/self-scoping flags; `ws=` on watch lines | 2 ✔ (first slice) |
| `src/reader/*`, `src/watch/*` | `foreign_claims`, roster, `conflict`, armed project totals | 2 |
| `src/workstreams/store.ts`, `src/cli.ts` | `rename`, `complete`, `reopen`; liveness; completed-but-live listing | 3 (complete/reopen ✔; rename pending) |
| `src/nudge/{types,store,unread,delivery}.ts`, `src/hooks/{claude,codex}.ts`, `src/cli.ts`, provider skills ×2 | hook-owned membership-fenced v1/v2 cursor; revision-wide unread high-water; provider-turn delivery identity; prompt/tool news-only nudges; idle-first, same-turn-gated, block-once Stop continuation; Codex text-only attestation and ingest deferral | Nudges ✔ |
| `src/watch/await.ts`, `src/core/barbaro-command.ts`, `src/providers/{claude,codex}/normalizer.ts`, `src/cli.ts`, skills ×3, README | read-only cursor wait; immediate pre-existing unread; no echo filter; joined-self scoping; `waiting` leases; whole-simple-command digest exclusion; await → context → react guidance | Codex wake, revised ✔ |

Tests added in phase 1 and the forward-move revision: grammar (both providers, attachment form, `&#x20;`
boundary, invalid slug); name-claim race (8 concurrent creators → one
winner); stale-claim recovery (claim without record; claim whose record has
another name); enrollment race (6 same-workstream joins → one record; mixed
joins → one record); two-phase hooks (bare writes nothing and no incident;
refusal writes nothing; new; join; forward move; idempotent re-join; completed
target refused; legacy v1 forward move; concurrent moves serialize); stamp
determinism (Claude and Codex moves preserve old stamps across reset,
pre-membership records stay unscoped, evidence uses `occurred_at`); moved
session watch joins; schema example with the field; lease validation of the
field; CLI `workstream` commands and status membership history.

## Still to verify

- Claude Code: whether `UserPromptSubmit` hook stdout is shown to the user
  as well as added to model context; whether `UserPromptExpansion` carries
  the raw first line in every Claude Code version.
- Codex (`0.148.0-alpha.9`): whether `UserPromptSubmit` hook stdout reaches
  the model or user; until then the Codex hook stays silent.
