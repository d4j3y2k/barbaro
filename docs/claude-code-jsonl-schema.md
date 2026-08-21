# Claude Code JSONL trace schema

Derived empirically, not from docs.

**Corpus measured 2026-08-16T22:05Z:** 417 files (142 session + 275 subagent) / 234 MB / 70,314
records across 24 project directories, spanning `2026-07-17` → `2026-08-16`, Claude Code versions
`2.1.212`–`2.1.233` (16 distinct).

> The store is **live and mutable**. An earlier measurement the same day showed 449 files / 74,376
> records / 262 MB; sessions are cleaned up and added continuously. Never treat a file count, a record
> count, or a file's line count as stable. Re-derive per run.

> This is a **private, versionable on-disk format**, not a public API. Treat every field as optional
> and every shape as drift-prone. The parser must never hard-fail on an unknown `type` or missing key.

---

## 0. Read-only, never redacted at the source

**Barbaro opens these files read-only.** Adapters never rewrite, truncate, redact, rotate, reorder, or
delete a provider trace. Redaction, excerpting and truncation happen only while *copying* content into
`.barbaro/`, and every such alteration is declared explicitly in the derived record's `content` object
(`fidelity`, `truncated`, `original_utf8_bytes`, `redactions`) with a retained `source_ref`.

The trace is the raw source of truth; `.barbaro/` holds derived copies. Barbaro cannot restore content
the provider never recorded.

Operationally this also means: open with read intent only, tolerate a truncated final line (a live
session may be mid-write), and never take a lock that could block the writing agent.

---

## 1. Location and layout

```
~/.claude/projects/<encoded-cwd>/
  <session-uuid>.jsonl                                             # main thread
  <session-uuid>/subagents/agent-<agentId>.jsonl                   # direct subagents
  <session-uuid>/subagents/workflows/<wf-id>/agent-<agentId>.jsonl # workflow agents
  <session-uuid>/subagents/workflows/<wf-id>/journal.jsonl         # workflow journal
```

- `<encoded-cwd>` is the project's absolute path with `/` and `.` replaced by `-`. **This encoding is
  lossy** — you cannot reverse it into a path, and paths differing only in `.` vs `/` collide. Recover
  the real path from the `cwd` field on any record; use the directory name only as a grouping key.
- The session filename UUID equals the `sessionId` on records inside.
- **Subagent traces are separate files, not interleaved into the session file.** Verified: session
  files contain 31,628 `isSidechain:false` and zero `true`; `agent-*.jsonl` files contain 24,586
  `true` and zero `false`. A session file therefore holds exactly one linear main thread.
- The parent session ID is recoverable **from the path** (the `<session-uuid>` directory above
  `subagents/`) as well as from the `sessionId` field inside the subagent file.

---

## 2. Record types

Every line is a JSON object with a `type` discriminator. 18 observed:

| type | count | what it is |
|---|---:|---|
| `assistant` | 32,444 | model output (see §4 — **one API response spans many lines**) |
| `user` | 19,023 | human prompts *and* tool results |
| `attachment` | 3,019 | injected context (reminders, skill listings, hook output) |
| `last-prompt` | 2,640 | resume pointer: `{lastPrompt, leafUuid}` — names the **active branch leaf** |
| `mode` | 2,575 | `{mode}` |
| `permission-mode` | 2,537 | `{permissionMode}` |
| `ai-title` | 2,483 | generated session title |
| `system` | 1,728 | lifecycle/meta, keyed by `subtype` (§6) |
| `bridge-session` | 933 | remote/bridge linkage + `lastSequenceNum` |
| `file-history-snapshot` | 688 | full file state for undo |
| `queue-operation` | 686 | queued user commands |
| `file-history-delta` | 584 | per-edit backup + `trackingPath` |
| `pr-link` | 465 | `{prNumber, prRepository, prUrl}` |
| `started` | 224 | **workflow journal only** — agent start `{agentId, key}` |
| `result` | 222 | **workflow journal only** — agent result `{agentId, key, result}` |
| `custom-title` | 43 | user-set title |
| `agent-name` | 18 | named agent |
| `frame-link` | 2 | unexplained |

`started`/`result` appear **only in `workflows/<wf-id>/journal.jsonl`**, never in session or agent
files. They are the workflow's own bookkeeping.

**Sidecar types carry no `timestamp` and no `uuid`.** `mode`, `permission-mode`, `ai-title`,
`last-prompt`, `bridge-session`, `file-history-*`, `custom-title`, `agent-name` are session-scoped
state, rewritten repeatedly (2,575 `mode` records across ~142 sessions = last-write-wins, not history).
Fold them into a session header; do not place them on the timeline.

---

## 3. Event envelope

Timeline records (`user`, `assistant`, `system`, `attachment`) share:

```jsonc
{
  "uuid":        "…",        // this record's id
  "parentUuid":  "…"|null,   // DAG edge (§5)
  "sessionId":   "…",
  "timestamp":   "2026-08-16T22:02:55.066Z",  // ISO-8601 UTC
  "type":        "assistant",
  "userType":    "external",
  "cwd":         "/abs/path",
  "gitBranch":   "main",
  "version":     "2.1.233",  // drift signal — keep on every derived event
  "entrypoint":  "cli",
  "isSidechain": false
}
```

Optional, presence-varying (85 distinct keysets observed — enumerate, never assume):

- `session_id` — **snake_case duplicate of `sessionId`** on roughly half of records, a migration
  artifact. Read `sessionId ?? session_id`.
- `agentId` — subagent identity (§5). `requestId` — API request id.
- `effort`, `slug`, `promptId`, `origin`, `promptSource`, `permissionMode`
- `attributionAgent` / `attributionSkill` / `attributionMcpServer` / `attributionMcpTool` —
  provenance for what produced this turn. Cheap, high-value attribution.
- `toolUseResult` (§8), `toolDenialKind`, `toolEndsTurn`, `sourceToolAssistantUUID`, `sourceToolUseID`
- `isMeta`, `mcpMeta`, `classifierMetaLines`, `logicalParentUuid`

> **jq caution:** `.isSidechain // empty` silently drops `false`, because `false` is falsy in jq's `//`.
> Use `has("isSidechain")`. This mistake produced a wrong conclusion in an earlier draft of this doc.

---

## 4. ⚠ `message.id` is a usage-deduplication key — **not** a Barbaro turn

`message` is the Anthropic Messages API shape. A single **API response** is written as **one JSONL line
per content block**, each carrying the *full, identical* `message.usage`.

Lines per `message.id`: 1 → 4,799 · 2 → 4,989 · 3 → 4,809 · 4 → 857 · 5 → 166 · … up to 15.

A real 15-line response, every line reporting `output_tokens: 1697`:

```jsonc
{"uuid":"7f6d5fe2…","message":{"id":"msg_011CdWQz…","content":[{"type":"thinking"}],"usage":{"output_tokens":1697,…}}}
{"uuid":"d162cc53…","message":{"id":"msg_011CdWQz…","content":[{"type":"text"}],    "usage":{"output_tokens":1697,…}}}
{"uuid":"f33437aa…","message":{"id":"msg_011CdWQz…","content":[{"type":"tool_use"}],"usage":{"output_tokens":1697,…}}}
…12 more, identical usage…
```

**Two distinct units, at two distinct layers — do not conflate them:**

| unit | key | used for |
|---|---|---|
| API response | `message.id` | **usage deduplication only** |
| Barbaro turn | genuine human prompt → terminal outcome | the `barbaro.turn.v1` boundary and `turn_id` |

One Barbaro turn contains many `message.id`s and every tool loop between them. `message.id` is never a
turn boundary and never contributes to `turn_id`. See `claude-to-barbaro-v1.md` for the turn-key rule.

> **Usage rule: aggregate over DISTINCT `message.id`, one line per id. Never `SUM()` over rows.**
> Summing rows overstates the response above by 15×.

`requestId` gives the same grouping, slightly coarser (a retry reuses `requestId` with a new
`message.id`). Prefer `message.id` for token math, `requestId` for API-call counts.

Other usage subtleties:

- `stop_reason: null` on 9,121 records correlates **exactly** with usage blocks lacking
  `iterations`/`speed` — non-final, streaming-shaped records. Usable for content, unreliable as turn
  boundaries.
- `usage.iterations[]`, where present, is the authoritative per-iteration breakdown and the top-level
  fields are its rollup. Never add both.

Usage keys: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
`cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`,
`server_tool_use.{web_search,web_fetch}_requests`, `service_tier`, `inference_geo`, `speed`,
`iterations[]`, `output_tokens_details`.

### Content blocks

| block | count | notes |
|---|---:|---|
| `assistant:tool_use` | 17,777 | |
| `user:tool_result` | 17,776 | |
| `assistant:thinking` | 10,553 | has `signature`; excluded from Barbaro entirely |
| `assistant:text` | 4,111 | the agent's own account — the digest's `response` source |
| `user:` *(string)* | 1,158 | **`message.content` is sometimes a bare string, not an array** |
| `user:text` | 89 | |
| `user:image` | 9 | base64 — size bomb, never copied |
| `assistant:fallback` | 3 | model refusal fallback |

**Invariant, with a caveat:** `tool_use` count == `tool_result` count — but only for *closed* turns.
The counts above differ by exactly one because the measuring session had a tool call in flight. When
tailing a live file, expect exactly one unmatched trailing `tool_use`; treat more than one as corruption.

Models: `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`, and
`<synthetic>` (locally generated, **not billable** — exclude from any cost figure).

---

## 5. The graph, forks, and subagents

`parentUuid` chains records. File order ≈ append order but **is not authoritative**: 4 of 20 sampled
files had out-of-order timestamps. Traverse the DAG; use timestamps only as a tiebreak.

- **Forks are real.** 44 of 142 sessions contain main-thread forks, 404 fork points total — edits,
  rewinds, retries. A session file holds a *tree*; `last-prompt.leafUuid` names the **active leaf**,
  which is how you select the live branch.
- **Within one API response, lines are not contiguous.** With parallel tool calls the chain threads
  `tool_use → tool_result → tool_use`, so consecutive lines of one `message.id` can have unrelated
  parents. Group by `message.id`; order by DAG.

### Subagents (corrected)

Subagents live in **separate files** (§1), so a session file's main thread is clean and a top-level
turn's line range in that file is genuinely contiguous. Subagent volume is still large — 24,586
records, 35% of the corpus — it simply lives elsewhere.

**Parent joining.** A subagent file's DAG root has `parentUuid: null`, so there is no edge to walk up.
Two joins are required, and they differ by subagent kind:

1. **Direct subagents** (`subagents/agent-<agentId>.jsonl`) — index the parent session's `Agent`/`Task`
   tool results by `toolUseResult.agentId`, then map to that record's `tool_use_id` and the enclosing
   turn. Verified 6/6 on sampled files. `toolUseResult` also supplies `prompt`, `description`,
   `resolvedModel`, `status`, and the subagent role.
2. **Workflow agents** (`subagents/workflows/<wf-id>/agent-<agentId>.jsonl`) — **no per-agent `Agent`
   tool call exists in the parent.** Join via the `<wf-id>` path component to the parent session's
   `Workflow` tool call, and via `journal.jsonl` `started`/`result` records keyed by `agentId`.

197 of 275 subagent files are workflow-nested, so path (2) is the common case, not the exception.
An unresolved parent stays unresolved and is never guessed; record which key was used.

---

## 6. `system` subtypes

`stop_hook_summary` · `turn_duration` · `away_summary` · `local_command` · `bridge_status` ·
`model_refusal_fallback` · `informational` · `compact_boundary`

`turn_duration` carries `durationMs` + `messageCount` — real wall-clock latency, free.
Hook records carry `hookCount`, `hookErrors`, `hookInfos`, `preventedContinuation`, `toolUseID`.

## 7. Compaction severs the DAG

```jsonc
{"subtype":"compact_boundary","parentUuid":null,"logicalParentUuid":"adc037ac…",
 "compactMetadata":{"trigger":"auto","preTokens":1000882,"postTokens":11914,
   "cumulativeDroppedTokens":988968,"durationMs":121944,
   "preservedSegment":{"headUuid":"…","anchorUuid":"…","tailUuid":"…"},
   "preservedMessages":{"uuids":[…],"allUuids":[…]}}}
```

`parentUuid: null` with `logicalParentUuid` set — a `parentUuid`-only walk sees one session as
disconnected components. Follow `parentUuid ?? logicalParentUuid`.

Pre-compaction records **remain in the file** above the boundary. The JSONL is a superset of what the
model could still see.

## 8. `toolUseResult` is polymorphic

Attached to the `user` record holding the `tool_result`. Type varies: object (10,954), string (813),
array (298). Shape is per-tool and unversioned:

- `Bash` → `{stdout, stderr, interrupted, isImage, noOutputExpected}` (+ optional `backgroundTaskId`,
  `gitOperation`, `returnCodeInterpretation`, `dangerouslyDisableSandbox`, `staleReadFileStateHint`,
  `timedOutAfterMs`, `persistedOutputPath`, `persistedOutputSize`, `backgroundCwdHint`)
- `Edit` → `{filePath, oldString, newString, originalFile, structuredPatch, replaceAll, userModified}`
- `Read` → `{file, type}` · `Write` → `{content, filePath, originalFile, structuredPatch, type, userModified}`
- `Agent` → `{agentId, prompt, description, resolvedModel, status, isAsync, outputFile, canReadOutputFile}`
- `TaskUpdate` → `{taskId, statusChange, updatedFields, success}` · `WebFetch` → `{url, code, bytes, durationMs, result}`
- MCP tools → arbitrary server-defined payloads

Tool distribution is long-tailed: `Bash` 10,333 · `Read` 3,130 · `Edit` 2,765 · `Write` 513, then MCP
tools. Type the top ~10 first-party tools; keep the rest opaque with a `raw` escape hatch.

### ⚠ Bash failure is observable; Bash success is not

An earlier revision of this document claimed Bash failures were invisible. **That was wrong**, and the
error is worth recording because the measurement was circular: it filtered on
`toolUseResult.stdout != null`, which keeps only object-shaped results — exactly the population where
`is_error` is always `false`. Failing calls carry a **string** `toolUseResult` and were excluded by
the very filter used to prove they did not exist.

Correct picture over 9,893 paired Bash results:

| | |
|---|---:|
| `is_error: true` | 251 |
| …without a denial | 216 |
| `toolUseResult` shapes | object 5,401 · string 251 · absent 4,241 |
| Error results prefixed `Exit code <N>` | 202 of 358 |

- A **failing** Bash result has `is_error: true`, a string `toolUseResult`, and content beginning
  `Exit code <N>\n…`. Observed codes include 1, 2, 128, 143. This is the only place a numeric shell
  status is recorded, and it must be matched with an anchored pattern — plenty of *successful* output
  mentions exit codes in prose.
- **No `Exit code 0` is ever recorded**, so success cannot be established. `stderr` is effectively
  always empty (stderr is merged into stdout), and `returnCodeInterpretation` is a rare human-readable
  string (`"No matches found"`), not a code.

Reliable failure/denial signals: `is_error`, `toolUseResult.interrupted`, and `toolDenialKind`
(`automode-blocked`, `automode-unavailable`, `permission-rule`, `user-rejected`).

---

## 9. Parser design

1. **Stream, never load.** Line-at-a-time; one bad line is skipped and counted, never fatal.
2. **Two layers, named to avoid collision with the Barbaro contract.** This doc's *raw* and *typed*
   parser layers are internal to the Claude adapter; the shared products are `digest` and `evidence`
   (spec/barbaro-v1.md). Do not call either pair "Tier 1/2".
3. **Preserve `version` on every event**; key shape workarounds to version ranges.
4. **Dedupe usage by `message.id` at ingest**, before any aggregate sees it.
5. **Model the DAG explicitly.** Resolve the active branch via `last-prompt.leafUuid`; stitch
   compaction via `logicalParentUuid`.
6. **Join subagents by both paths** (§5), recording which was used.
7. **Redact when copying, never at the source** (§0). Drop `thinking`, image base64, file bodies, and
   successful stdout.
8. **Tolerate the live tail.** Truncated final line and one unmatched trailing `tool_use` are normal.
9. **Assert invariants** as health checks: closed-turn `tool_use`/`tool_result` parity; every
   `tool_result.tool_use_id` resolves; every subagent file's root carries an `agentId`.

## 10. Open questions

- Does `<encoded-cwd>` collide for paths differing only by `.` vs `/`? (Likely — dedupe on `cwd`.)
- Is `sessionId` ever reused across resume, or does resume always allocate a new file?
- Is `bridge-session.lastSequenceNum` more reliable than `timestamp` for bridged sessions?
- `frame-link` (n=2) is unexplained.
- Can a `PostToolUse` hook capture the exit codes the trace omits (§8)? That would change ingestion
  from pure-trace to hook-augmented — a contract decision, not an adapter one.
