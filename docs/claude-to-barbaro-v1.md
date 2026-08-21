# Claude Code → Barbaro v1 mapping

How the Claude Code provider adapter derives `barbaro.turn.v1`, `barbaro.evidence.v1`, and
`barbaro.active.v1` from Claude Code JSONL traces.

Companion to [`claude-code-jsonl-schema.md`](./claude-code-jsonl-schema.md) (source format) and
[`../spec/barbaro-v1.md`](../spec/barbaro-v1.md) (frozen contract). Where this document and the
schemas disagree, the schemas win and the disagreement is a contract bug — see §7.

`provider` is the literal `"claude"`. Extensions live under `extensions.claude`.

---

## 1. Trace discovery and identity

```
~/.claude/projects/<encoded-cwd>/
  <session-uuid>.jsonl                                             → main thread
  <session-uuid>/subagents/agent-<agentId>.jsonl                   → direct subagent
  <session-uuid>/subagents/workflows/<wf-id>/agent-<agentId>.jsonl → workflow agent
  <session-uuid>/subagents/workflows/<wf-id>/journal.jsonl         → workflow journal
```

Workspace binding uses the `cwd` **field**, never the `<encoded-cwd>` directory name, which is lossy.
A session belongs to a project when `cwd` equals the project root or is nested under it.

| Barbaro | Derivation |
|---|---|
| `session_id` | `ses_` + typed hash of `["claude", <session-uuid>]` |
| `trace_id` (in `source_ref`) | `"claude:" + <session-uuid>` |
| `agent_id` | `"main"` for the session file; the native `agentId` for a subagent file |
| `turn_id` | `turn_` + typed hash of `["claude", <session-uuid>, <agent_id>, <native turn key>]` |

**Native turn key** is the `uuid` of the turn-initiating record (§2). It is a stable native record ID,
which the contract prefers. Fall back to the one-based physical line ordinal of that record only when
the record has no `uuid`. Never derive a key from prompt text, timestamps, or filtered positions.

`message.id` never participates in `turn_id`. It is used for exactly one thing: usage deduplication.

---

## 2. Turn segmentation

A Barbaro turn runs **from a genuine human prompt through the terminal outcome** of that interaction,
spanning every API response and tool loop between.

### Identifying the turn-initiating record

A candidate is a `type:"user"` record that is not a tool result and not injected:

```
type == "user"
  AND NOT (message.content is an array containing a tool_result block)
  AND isMeta is not true
  AND (isSidechain == false  OR  the file being read is a subagent trace)
  AND the record is not an `attachment`
```

The sidechain clause is conditional, not absolute. In a session file a sidechain record must never
start a main-thread turn; in a subagent file **every** record is `isSidechain: true` and its DAG-root
user record is that subagent's own prompt. Rejecting sidechain records unconditionally yields zero
turns for every subagent file.

Among candidates, classify by provenance, in order:

| Signal | Meaning | Starts a turn? |
|---|---|---|
| `origin.kind == "human"` | genuine human prompt (`promptSource`: `typed`, `queued`, `suggestion_accepted`) | **yes** |
| `origin.kind == "task-notification"` | system-injected notification | no — see §7-M3 |
| `promptSource == "sdk"` | programmatic driver | no — see §7-M3 |
| neither field present | **older/other entrypoint — fall back to structure** | **yes**, marked inferred |

**The fallback is mandatory.** `origin`/`promptSource` are *not* reliably present: version 2.1.220
emits human prompts both with and without `origin`. Corpus counts for candidate records:

```
human               651
(neither present)   129   ← lost entirely without the fallback
sdk                 103
task-notification    63
```

Without the fallback, ~16% of turn starts vanish and their work becomes invisible to peers. When the
fallback fires, set `extensions.claude.turn_start = {"method": "structural", "reason": "no-origin"}`.

### Terminating the turn

`stop_reason` is **repeated on every line of one API response**, including the first. A response
whose `thinking` block is written before its `text` block reports `end_turn` on both lines, so
closing the turn at the first `end_turn` discards the response. Observing `end_turn` therefore only
*marks* the turn terminal; it does not close it.

A marked turn is emitted at the earliest of:

1. the next turn-initiating record; or
2. end of input (`finish()`).

A turn that never reached a terminal record is **withheld**, not published. Emitting it would force a
later run to contradict a digest peers had already read, and the append store would reject the
revision as an ID conflict. Its bytes are re-read on the next run instead. `finish({ includeIncomplete: true })`
overrides this for a trace known to be final, such as a subagent file whose parent already recorded a result.

`stop_reason: null` marks non-final streaming-shaped records and never marks a turn terminal.

### `sequence`

Ordinal of the turn among top-level turns of that session on the **active branch**, starting at 1.
The active branch is resolved via `last-prompt.leafUuid` (§5). Turns on abandoned branches are still
emitted but their sequencing is a known contract gap (§7-M5).

### `outcome`

| Condition | `outcome` |
|---|---|
| terminal `end_turn`, no unresolved failure or denial | `success` |
| terminal `end_turn`, but a `file_change`/`command` action failed or was denied | `partial` |
| `AskUserQuestion` is the **final** action of a terminal turn | `blocked` |
| `toolDenialKind` present and no subsequent recovery | `partial` |
| no terminal record, and some action was interrupted | `cancelled` |
| no terminal record, and input ended (`finish` with `includeIncomplete`) | `abandoned` |
| no terminal record, closed by the next prompt | `unknown` |

`blocked` requires the question to be the *last* action. A question the agent asked and then worked
past did not block the turn.

Unknown values are omitted, never `null`.

---

## 3. Digest fields

### `request`

From the turn-initiating record's text content. `message.content` may be a **bare string** (1,158
records) rather than an array — handle both.

Strip the injected wrappers Claude Code adds around user text (`<system-reminder>` blocks,
`<command-name>`/`<command-message>`/`<local-command-stdout>` blocks). Stripping makes the copy
`fidelity: "normalized"`, not `"verbatim"`; byte-limit truncation sets `truncated: true` with
`original_utf8_bytes` measured **before** stripping.

### `response`

The **terminal** assistant `text` block of the turn — the agent's own closing account. Intermediate
progress text goes to evidence (`kind: "response"`), not the digest.

`thinking` blocks are excluded from Barbaro entirely, at every tier.

### `actions`

Source order preserved. One action per `tool_use` block, paired to its `tool_result` by `tool_use_id`.

| Claude tool | `kind` | Notes |
|---|---|---|
| `Edit`, `Write`, `NotebookEdit` | `file_change` | `operation` from whether `originalFile` was empty/absent (`create`) or present (`modify`) |
| `Bash` | `command`, or `test` when classified | see §4 |
| `Agent`, `Task` | not an action — feeds the subagent rollup (§5) |
| `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `ToolSearch` | `tool` | non-mutating; `summary` only |
| `mcp__*` | `tool` | `tool_name` verbatim, including the `mcp__server__tool` prefix |
| everything else | `other` | never guess a richer kind |

`added_lines`/`removed_lines` come from `toolUseResult.structuredPatch` hunk counts. File **bodies**
(`originalFile`, `content`, `oldString`, `newString`) are never copied into a digest.

**Paths.** `toolUseResult.filePath` is absolute. Relativize against the workspace root to produce a
`repoPath`. **15.2% of file edits fall outside the workspace** (`~/.claude/**` memory files, scratchpad
paths) and cannot be represented — see §7-M1.

**`.barbaro/` self-exclusion.** Actions whose path resolves under `.barbaro/feed/`,
`.barbaro/evidence/`, or `.barbaro/active/` are dropped before emission, as are `Read`/`Grep` actions
targeting them. Without this, agents observing each other generate an unbounded echo loop.

### `subagents`

Structured rollup only (§5). Search-only subagents stay in evidence.

### `source_refs`

`trace_id` plus `line_start`/`line_end` of the turn's records in the session file, plus
`native_record_ids` for the initiating and terminal records. Because subagents live in separate files,
a top-level turn's line range in the session file **is** contiguous, so the range is exact rather than
a bounding box.

Line numbers are one-based against the unmodified file. Record the range at parse time; the file is
append-only in normal operation, but a rewritten file invalidates prior ranges — `native_record_ids`
remain authoritative.

### Excluded from the digest

Token accounting, `thinking`, file bodies, images, successful command stdout, attachment boilerplate,
and anything Barbaro itself read or wrote.

---

## 4. Commands, tests, and exit codes

> **Corrected 2026-08-16.** An earlier revision of this document claimed Bash failures were
> unobservable. That was wrong, and the measurement behind it was circular: it filtered on
> `toolUseResult.stdout != null`, which selects only object-shaped results — precisely the population
> where `is_error` is always `false`. Failing Bash calls carry a **string** `toolUseResult` and were
> excluded by the very filter used to prove they did not exist.

Corpus-wide over 9,893 paired Bash results:

| Signal | Count |
|---|---:|
| `is_error: true` | 251 |
| …of those, without a denial | 216 |
| `toolUseResult` shape on failure | string |
| Failure content prefixed `Exit code <N>` | 202 of 358 error results |

**Outcome precedence** — `denied` → `interrupted` → `is_error: true` ⇒ `failed` → otherwise `unknown`.

**Exit codes are recoverable.** A failing Bash result begins with a literal `Exit code <N>\n` line;
that is the only place Claude records a numeric shell status. `parseExitCode` matches it with an
anchored `^Exit code (\d{1,5})(\n…)?$` pattern, so prose that merely mentions an exit code elsewhere
in output can never be mistaken for a status. Observed values include 1, 2, 128, and 143.

What remains genuinely unavailable:

- **Success is never provable.** No `Exit code 0` is recorded, so a Bash call that merely returned
  output stays `unknown`. This is the residual M2 gap and it is real, but far narrower than claimed.
- `test.passed`/`test.failed` counts are unavailable and omitted.

`failure_excerpt` carries the output *after* the status line, redacted and bounded, so the status is
not duplicated into the excerpt.

Classifying a `command` as `test` uses a deterministic prefix match on the command text
(`npm test`, `pytest`, `cargo test`, `go test`, `jest`, `vitest`). No match means `command`. The
classifier never asserts an outcome.

---

## 5. Subagents, workflows, and branches

### Parent joining

A subagent file's DAG root has `parentUuid: null`. Two joins, by kind:

**Direct subagents** — index the parent session's `Agent`/`Task` records by `toolUseResult.agentId`;
that record's `tool_use_id` locates the parent turn. Verified 6/6 on sampled files.

```
parent_link = { method: "joined", native_key: <agentId> }
```

`toolUseResult` also yields the role (`subagent_type`/`description`), `resolvedModel`, and `status`.

**Workflow agents** — no per-agent `Agent` call exists in the parent. Join via the `<wf-id>` path
component to the parent session's `Workflow` tool call, corroborated by `journal.jsonl`
`started`/`result` records keyed by `agentId`.

```
parent_link = { method: "joined", native_key: "<wf-id>/<agentId>" }
```

197 of 275 subagent files are workflow-nested, so this is the common case. The extra
session → workflow → agent level does not fit `parent_turn_id` cleanly — see §7-M4.

An unresolved parent stays `{ method: "unresolved" }`. Never guessed.

### Promotion

Search-only subagents remain in evidence with a rollup line in the parent digest. A subagent is
promoted into the parent digest's `changed_paths` and `outcomes` when it mutates the workspace,
returns a meaningful conclusion, fails, or blocks.

### Branch selection

`last-prompt.leafUuid` names the active leaf. Walk parents from it to recover the active branch;
44 of 142 sessions contain forks (404 fork points). Turns on abandoned branches are emitted with
`extensions.claude.branch = {"active": false, "superseded_by": <uuid>}` pending §7-M5.

### Compaction

`system/compact_boundary` sets `parentUuid: null` and moves the real edge to `logicalParentUuid`.
Traverse `parentUuid ?? logicalParentUuid`, otherwise one session parses as disconnected components.

A compact boundary is **not** a turn boundary. It is emitted as evidence
(`kind: "provider_event"`) carrying `compactMetadata` counters, and the turn continues across it.

---

## 6. Evidence and active

### Evidence

| `kind` | Source |
|---|---|
| `prompt` | full turn-initiating text when the digest copy was truncated |
| `response` | intermediate assistant `text` blocks |
| `command` | full command text |
| `tool_call` / `tool_result` | tool metadata; payload bodies excluded |
| `failure_excerpt` | bounded excerpt where failure is established (§4) |
| `usage` | **deduplicated by `message.id`**, summed across the turn |
| `attachment_metadata` | `attachment.type` and size only, never content |
| `subagent_turn` | a full subagent turn, with `parent_link` |
| `provider_event` | `compact_boundary`, hook errors, `turn_duration` |

`evidence_id` = `ev_` + typed hash of `[turn_id, <source record uuid>, <occurrence index>]`.

### Active leases

The trace alone cannot describe the present — it is written as things complete.
Installed hooks stay dormant until the user invokes the project skill with
`/barbaro`. The raw `UserPromptSubmit` and the `UserPromptExpansion` event for
`command_name: "barbaro"` both recognize that explicit consent idempotently.
Consent is scoped to the Claude session ID; a resumed session remains joined
and a new one must opt in. Before consent, neither leases nor transcript copies
are written. After consent, leases come from hooks:

| Hook | Lease write |
|---|---|
| `SessionStart` | For a resumed joined session, `state: "idle"`; a dormant session writes nothing |
| `UserPromptSubmit` / `UserPromptExpansion` | An explicit `/barbaro` invocation establishes consent; joined sessions write `state: "working"`, `intent` from the prompt, claims cleared |
| `PreToolUse` | for `Edit`/`Write`: add a `claims` entry, `confidence: "exact"`; for `Bash`: `unknown_write_scope: true` |
| `Stop` | `state: "idle"` tombstone, claims cleared |

`lease_id` = `lease_` + typed hash of `["claude", <session-uuid>, <agent_id>]`. Writes are atomic
temp-file replacements with strictly increasing `revision`. Claims are advisory; never call them locks.

`Bash` write scope is not statically knowable, so the adapter sets `unknown_write_scope: true` and
invents no paths.

---

## 7. Contract mismatches — flagged, not changed

Schemas are frozen. Nothing below has been altered; each needs a decision.

**M1 (decided) — out-of-workspace changes become a constant generic `other` action.** `repoPath`
forbids a leading `/` and any `..`, and 408 real file actions fall outside the workspace. They are
emitted as `kind: "other"` with the fixed summary `"file change outside workspace"` — no absolute
path, no basename, and `original_utf8_bytes` measures the emitted constant so the discarded path's
length cannot be inferred either. The action is counted in `diagnostics.external_path_actions`.

**M2 (narrowed) — Bash success is unprovable; failure is fully observable.** Failures now yield
`failed` plus a real numeric `exit_code` (§4). What remains is that no `Exit code 0` is ever written,
so a Bash call that returned output cannot be distinguished from one that succeeded. Codex rollouts
*do* carry exit codes for both outcomes, so `outcome: "unknown"` still means different things per
provider — "not recorded for this call" from Codex, "success is unrecordable" from Claude. That
asymmetry is the part still worth a contract decision; the fidelity gap itself is largely closed.

**M3 — `request` is required, but 23% of turn-initiating records are not human.** `sdk` (103),
`task-notification` (63). If those never start turns, their work is invisible to peers; if they do,
`request` is being populated from a non-human source with no field to say so. *Options:* an optional
`request_origin` enum; or explicitly scope v1 to human-initiated turns and document the blind spot.

**M4 — workflow agents have a two-level parent hierarchy.** `session → workflow → agent`, but
`parent_turn_id` is a single link, and 197 of 275 subagent files are workflow-nested. Currently
flattened to the parent turn with the workflow ID buried in `parent_link.native_key`. *Option:* an
optional `group_id` on evidence.

**M5 (decided) — `sequence` is source append order; rewinds carry supersession forward.** Nothing
already emitted is ever rewritten. A turn whose start record shares a `parentUuid` with an earlier
turn start is a replacement branch and carries
`extensions.claude.supersedes_turn_ids: [<earlier turn ids>]`. 405 forks observed corpus-wide.

**M6 — actions cannot carry provider extensions.** Action subschemas use
`unevaluatedProperties: false` with no `extensions` property, so `extensions.claude` is unavailable per
action. This blocks the "patch/content hash" that the design discussion called for on `file_change`.
*Option:* add `extensions` to `actionBase`.

**M8 — digest size is dominated by action count, and the tail is large.** Measured over 744 real
turns: p50 5.6 KB (~1.4k tokens), p90 19 KB, p99 79 KB, max 115 KB (~29k tokens). The floor is the
contract itself — each action costs ~530 bytes for `action_id`, the `content` envelope, and a
`source_ref` — so a 200-action turn is ~100 KB no matter how terse the prose. Reading the last few
turns of a busy session could cost a peer more context than it has. §Actions requires that any cap be
logged rather than silent, but no field exists to declare a truncated action list. *Options:* cap
actions in the digest with a declared overflow count and the remainder in evidence; or accept the
tail and let readers page.

**M7 (decided) — one direct, provider-neutral record per child turn.** The evidence schema keeps
`content` open for compatibility, while the shared TypeScript contract and semantic tests require
`role`, child-local `sequence`, `outcome`, `started_at`, `ended_at`, `request`, optional `response`,
and `actions`. Top-level `turn_id` is the child turn; `parent_turn_id` is the owning human turn.
Provider topology lives under `extensions`, never in the common content object, and there is no
`turn`, `turns`, or redundant `child_turn_id` wrapper.

**Non-issues, checked and cleared:** all three `examples/v1/*.json` validate against the schemas
(ajv 2020-12 with `ajv-formats`); `actionOutcome`'s `denied`/`interrupted` map cleanly to
`toolDenialKind`/`interrupted`; contiguous `line_start`/`line_end` are valid for Claude because
subagents are separate files.

---

## 8. Implementation

| Piece | Location |
|---|---|
| Record decoding | `src/providers/claude/records.ts` |
| Content copying, tool classification | `src/providers/claude/content.ts` |
| Turn segmentation and normalization | `src/providers/claude/normalizer.ts` |
| Resumable runner + subagent discovery | `src/runner/claude.ts` |
| Turn-boundary checkpoint state | `src/runner/claude-state.ts` |
| Active leases from hooks | `src/hooks/claude.ts` |
| CLI | `barbaro claude ingest`, `barbaro claude hook` |

Provider-neutral content helpers were moved from `src/providers/codex/content.ts` to
`src/core/content.ts` so both adapters share one redactor and one repo-path rule; the Codex module
re-exports them, and its tests were unchanged.

**Ingestion is a deterministic full replay; the checkpoint only detects change.** Partial resumption
was implemented and then removed. A Claude digest depends on state spanning the whole session — the
fork index behind `supersedes_turn_ids`, the Agent and Workflow parent-join indexes, the sequence
counter — so a normalizer starting mid-file silently emits *different* records for the same turn. The
incremental-polling test caught exactly that: a resumed run dropped `supersedes_turn_ids`. Full replay
costs ~28 ms per session and makes repeated polling converge byte-for-byte on the one-shot result.

**Finality is a caller assertion, not an inference.** A turn keeps absorbing records after its
terminal marker — the remaining text blocks of the same API response, a following compact boundary —
so flushing a trailing turn while the file is still growing publishes a digest the next run must
revise. `runClaudeTrace({ final: false })` (CLI `--live`) withholds it until the next prompt closes
it or a final run flushes it.

**`UserPromptSubmit` catches up only after the prompt exists in the trace.** Claude fires the hook
before appending its corresponding `user` record. When a prior successful checkpoint exists, the
ingest hook scans complete records after that checkpoint read-only for a record the canonical
classifier identifies as human. `mode`, file-history, and other sidecar growth cannot release the
wait. Once the prompt appears, the normal runner executes and the prompt closes the preceding turn;
a snapshot refused because it is still being written retries within the same two-second budget. If
the prompt does not appear in that budget, the hook returns a quiet not-yet: no feed or evidence is
appended, the checkpoint is unchanged, and no incident is created. A session with no prior checkpoint
retains the safe one-shot runner path. If an existing boundary becomes invalid through replacement,
truncation, or rewrite, the hook instead returns quietly without ingesting. Stop remains conservative
and never invents a successor prompt.

The branch pointer can lag too. A usable `last-prompt` selects everything back through its effective
parent chain. UUID-bearing rows physically after that pointer may extend the selection only while they
form one unique child chain from its leaf; this admits a late terminal response and the next human
prompt without resurrecting descendants the pointer had already rejected. `logicalParentUuid` carries
the chain across compaction, while UUID-less sidecars are transparent. Competing children, a rewind
from an older ancestor, a cycle, or a disconnected UUID-bearing tail makes the continuation ambiguous,
so the entire snapshot is withheld — including at `SessionEnd` — and its checkpoint is not advanced.

Claude supplies no hook ID that can be joined to a particular prompt record. If multiple queued
`UserPromptSubmit` workers overlap, they can observe the same first human record after their shared
checkpoint. ID-keyed append remains safe and deduplicated, but the newest trailing turn may still wait
for a later catch-up event. The probe and publishing replay are also separate snapshots; the runner's
own identity, size, and rewrite checks preserve canonical-output safety if the source changes between
them, with delay rather than speculative publication as the fallback.

### Fixtures

[`../test/fixtures/claude/`](../test/fixtures/claude/) — sanitized, structurally faithful traces
covering missing `origin.kind`, a failed tool loop, subagent parent joining, compaction with forks,
and a split terminal response. See the fixtures README for what each asserts.

### Release behaviour

| Concern | Rule |
|---|---|
| Partial tail | A torn final line means bytes are still arriving; the run never finalizes. |
| Response selection | Every row of the terminal `message.id` is grouped before the response is chosen. |
| Bundle | Main + subagents + workflow agents are normalized in full **before** anything is appended. |
| Pending children | A child that is unresolved or still running is withheld — **and so is the parent that would summarize it**, because a rollup, once appended, can never be corrected. |
| Child identity | `evidence_id` derives from the child's own turn and artifact, never from the parent, so a child keeps its identity when its parent resolves later. |
| Child completion | Attested from **outside** the child's file: a direct subagent's `Agent` tool result, or a workflow journal `result` record. Only 19 of 60 real subagent files contain any `end_turn`; 33 stop on `tool_use`. A child proven terminal but with no recorded outcome is `unknown`, never `abandoned`. |
| Canonical size (M8) | Request, response and command text are copied **in full**. Only excerpts are bounded. Readers apply their own byte budget; an oversized single record requires a noncanonical field/action projection rather than record-count paging alone. |
| Machine-driven input | `sdk` and unrecognized `promptSource` are barriers. A task notification is a **continuation** only when it names a `tool_use` issued by the currently open turn **and** sits on the active-leaf ancestry. One on a superseded path still records completion and linkage; only its span is suppressed. |
| Result membership | A `tool_result` is judged by the call it closes, not by its own position. An accepted parallel call's result is almost always off the single leaf chain — all 58 such results in the corpus are — so rejecting result rows by uuid leaves those calls permanently unpaired. An on-ancestry result wins when one exists; two competing off-path results for one call make the snapshot ambiguous and it is withheld. |
| Finality, two claims | `final` means the trailing turn may close; `sourceFinal` means the file will not change again. A Stop hook knows the first, not the second, so it passes `final: true, sourceFinal: false`. A turn already closed by successor records may publish, but the trace-terminal turn at EOF is withheld because it can still absorb late rows. The next `UserPromptSubmit` waits briefly for its actual human prompt record, then publishes the preceding turn as that record closes it; SessionEnd/offline ingestion can instead assert `sourceFinal`. A pointerless fork likewise waits for `sourceFinal`. |
| Snapshot safety | Branch selection and normalization read **one** bounded snapshot, pinned to a size observed before reading and re-verified (identity and size) immediately before anything is appended — the gap between reading and appending is exactly where a replacement pointer lands. `last-prompt` is rewritten in place, so reading it separately can select a branch the normalized rows never belonged to — and a digest published under the wrong branch can never be corrected. A snapshot that is partial, malformed, changed identity or shrank, or (in live mode) contains a fork with no pointer yet, appends **nothing** and retries later. |
| Membership granularity | Decided per `message.id` response group, not per row. One response spans many rows and only some lie on the leaf path; row-by-row filtering tore 46 live responses apart and dropped 58 sibling `tool_use` blocks corpus-wide (22 Bash, 11 Read, 11 TaskUpdate, 9 memory reads, 2 ToolSearch, 2 Agent, 1 trace query). |
| Membership scope | Applied uniformly to assistant rows, tool results, task notifications and system records. A result or boundary on a rewound path would otherwise set the live turn's outcome or become its evidence. |
| Lineage-only recovery | Registers parent edges and completion; never touches the active turn's timing, actions or provenance. |
| Usage citation | Names the first row of every response that contributed usage. A line span alone is not checkable — a suppressed foreign response can sit between the first and last contributor. |
| Active branch | Resolved from that snapshot: `last-prompt.leafUuid` walks back through `parentUuid ?? logicalParentUuid`. Because the pointer may trail the append stream, one unique UUID-bearing child chain written physically after the selected pointer row extends that ancestry; any competing or disconnected post-pointer continuation withholds the snapshot. Descendants already present before the pointer remain excluded because they may be the branch it rejected. A trace with no `last-prompt` treats every record as on-branch rather than guessing. |
| Off-branch records | While an active-branch turn is open, a record off the active ancestry is dropped from the digest but still registers the calls it issued — otherwise a child launched on a superseded record is orphaned. Turns that themselves began off-branch are untouched: they are still emitted in append order carrying supersession. |
| Suppressed spans | A foreign prompt arriving mid-turn cannot close it without orphaning outstanding tool results, so the assistant work answering it is dropped instead — and suppression lifts when that span reaches its own `end_turn`, not at the next human prompt. A sticky flag loses the human turn entirely. |
| Workflow journals | Discovered by walking `subagents/workflows/`, never inferred from the child files present — otherwise a workflow whose only child has not appeared looks like one expecting nothing. |
| Late lineage | A tool result whose issuing turn already closed still registers its parent edge. The action is lost with its turn; the lineage must not be, or the child trace is orphaned. |
| Stale hook events | A `PreToolUse`/`PostToolUse` landing after the lease settled to idle is ignored outright — resurrecting it would advertise a claim for work that already stopped. |
| Child evidence (M7) | One evidence record per child turn. Its top-level `turn_id` is the child, `parent_turn_id` is the human owner, and the common content carries the turn substance directly. Provider topology is in `extensions`; the parent digest names every child evidence ID. |

### Measured against real traces

Sweep over the full local corpus (132 sessions, 45,787 records) on 2026-08-16:

| | |
|---|---:|
| Sessions ingested / failed | 132 / 0 |
| Malformed records | 0 |
| Turns emitted | 744 |
| Evidence records emitted | 3,234 |
| Schema validation failures | **0** |
| Subagent parents resolved | **275 / 275** |
| Turns recovered by the structural fallback | **128 of 752 (17%)** |
| Subagent children published / withheld | 271 / 4 (all genuinely still running) |
| Unresolved parents | 0 |
| Out-of-workspace file actions (M1) | 407 |
| Forks observed | 405 |
| Unpaired tool uses / unknown record types | 0 / 0 |
| Throughput | 45,787 lines in 3.8 s (~28 ms per session) |

Every emitted record validates against the frozen schemas (ajv 2020-12 with `ajv-formats`). The 17%
recovered by the structural fallback is the empirical case for §2: without it, one turn in six
vanishes from the feed.
