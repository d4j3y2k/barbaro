# Codex persisted rollout JSONL → Barbaro v1

This document is the implementation contract for the Codex adapter. It describes
the private, persisted rollout format produced by Codex Desktop, then fixes the
deterministic projection rules into `barbaro.turn.v1`, `barbaro.evidence.v1`, and
hook-driven `barbaro.active.v1` records.

The rollout format is not a public compatibility API and it has no independent
`schema_version`. Parse it as a lossless raw envelope first, use `cli_version` as
the producer discriminator, and add typed views second. Unknown data must never
make the stream unreadable.

## 1. Source baseline

The local Codex Desktop traces used to derive this mapping identify themselves
as `cli_version: "0.148.0-alpha.9"`. The exact matching OpenAI source is:

- tag: [`rust-v0.148.0-alpha.9`](https://github.com/openai/codex/tree/rust-v0.148.0-alpha.9)
- commit: [`9392c3fa5bcda342b5b96a1a04d67b2f781617c2`](https://github.com/openai/codex/commit/9392c3fa5bcda342b5b96a1a04d67b2f781617c2)

The authoritative types and persistence rules are:

- [`RolloutItem`, `RolloutLine`, and `ResponseItemEnvelope`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/history/src/lib.rs#L34-L202)
- [the actual `RolloutItemWire` serde representation](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/history/src/rollout_payload.rs#L17-L47)
- [`ResponseItem`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/protocol/src/models.rs#L814-L1048)
- [`EventMsg`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/protocol/src/protocol.rs#L1283-L1510)
- [`SessionMeta` and `SessionMetaLine`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/protocol/src/protocol.rs#L2853-L2984)
- [rollout persistence policy](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/rollout/src/policy.rs#L1-L184)
- [the tolerant upstream loader](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/rollout/src/recorder.rs#L982-L1150)

The source tests round-trip every outer variant and generate an in-memory
Schemars schema, but OpenAI does not check in a standalone versioned schema for
rollout files. See the [round-trip test](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/history/src/tests.rs#L293-L374).

### Drift already visible on current `main`

At current OpenAI `main` commit
[`6c108912eeacabfc82723bf44f8a23f6e2f86585`](https://github.com/openai/codex/commit/6c108912eeacabfc82723bf44f8a23f6e2f86585),
`RolloutItem` has a ninth outer variant, `security_risk_score`. Its payload is:

```json
{
  "scores": { "classifier_name": 0.125 },
  "sampled_at": "2026-08-16T20:08:03Z"
}
```

`scores` is a string-to-f64 map and `sampled_at` is optional. It is a durable
history-only snapshot, not conversation content. See the current
[`RolloutItem`](https://github.com/openai/codex/blob/6c108912eeacabfc82723bf44f8a23f6e2f86585/codex-rs/history/src/lib.rs#L92-L205)
and [`SecurityRiskScore`](https://github.com/openai/codex/blob/6c108912eeacabfc82723bf44f8a23f6e2f86585/codex-rs/protocol/src/security_risk.rs).
The pinned producer must therefore treat this as an unknown-but-preserved outer
record. Current `main` also adds a defaulted `client_authored` boolean to
`CodexHarnessMetadata` and narrows `WorldStateItem.state` to an object. Neither
change is allowed to break raw ingestion.

`ordinal` is **not** a current-`main` addition. It already exists as an optional
field in `0.148.0-alpha.9`. Legacy writers omit it; paginated writers assign it.

## 2. Physical envelope

Each complete physical line is one UTF-8 JSON object:

```jsonc
{
  "timestamp": "2026-08-16T20:00:00.000Z",
  "ordinal": 42,             // optional
  "type": "response_item", // outer RolloutItem tag
  "payload": { ... },
  "metadata": { ... }       // optional; response_item only at the pinned tag
}
```

The exact serde shape is an internally tagged enum:

```rust
#[serde(tag = "type", rename_all = "snake_case")]
enum RolloutItemWire<'a> {
    SessionMeta { payload: Cow<'a, SessionMetaLine> },
    ResponseItem {
        payload: Cow<'a, ResponseItem>,
        metadata: Option<Cow<'a, CodexHarnessMetadata>>,
    },
    InterAgentCommunication { payload: Cow<'a, InterAgentCommunication> },
    InterAgentCommunicationMetadata {
        payload: InterAgentCommunicationMetadataPayload,
    },
    Compacted { payload: Cow<'a, CompactedItem> },
    TurnContext { payload: Cow<'a, TurnContextItem> },
    WorldState { payload: Cow<'a, WorldStateItem> },
    EventMsg { payload: Cow<'a, EventMsg> },
}
```

Do not model this as `{"type": ..., "payload": ...}` with a strict enum at the
stream boundary. The first tier must retain:

```text
physical line number (one-based)
raw bytes
JSON value, when parseable
timestamp?, ordinal?, outer type?, payload?, metadata?
```

Only then should a typed decoder run. A typed-decoder error is a diagnostic and
an opaque record, not a stream error.

### Physical read rules

1. Stream line-by-line. Do not load an entire session into memory.
2. Count physical lines before filtering blanks or bad records. Source refs use
   those original one-based line numbers.
3. Preserve file order. If every relevant record has `ordinal`, order by
   `ordinal` and use physical line as a deterministic tie-break/diagnostic;
   otherwise use physical line. Never order by timestamp.
4. An invalid final non-empty record is a pending partial tail. Ignore it for
   normalization, retain its bytes, and retry it after the file grows. An
   invalid non-final line is a counted parse error and opaque raw record.
5. Full adapter target: accept `.jsonl` and `.jsonl.zst`, as the upstream
   loader does. The current v0.1 runner accepts uncompressed `.jsonl` only and
   rejects `.zst` explicitly.
6. Never modify the provider file.

For `history_mode: "legacy"`, writer tests explicitly omit `ordinal`. For
`history_mode: "paginated"`, the writer begins at zero, or at
`history_base.end_ordinal_exclusive`, and advances monotonically. A resumed
file can contain a historical gap, so monotonicity is useful but contiguity is
not an ingest requirement. The implementation is in
[`ordinal.rs`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/rollout/src/ordinal.rs).

## 3. Outer record types

| Wire `type` | Pinned Rust payload | Adapter use |
|---|---|---|
| `session_meta` | `SessionMetaLine` | Canonical session/version/actor metadata. |
| `response_item` | `ResponseItem` plus optional sibling `metadata` | Canonical model/user messages and raw tool calls/results. |
| `inter_agent_communication` | `InterAgentCommunication` | Native agent communication and possible exact parent linkage. |
| `inter_agent_communication_metadata` | `{trigger_turn: bool}` | Control metadata; no user content by itself. |
| `compacted` | `CompactedItem` | Context-compaction checkpoint, not a human turn boundary. |
| `turn_context` | `TurnContextItem` | Correlation (`turn_id`) and turn configuration. |
| `world_state` | `WorldStateItem` | Model-visible state baseline/patch; not a human prompt. |
| `event_msg` | `EventMsg` | Durable lifecycle events and legacy/paginated projections. |
| `security_risk_score` | `SecurityRiskScore` | Current-main forward record; preserve, do not project into a turn digest. |

The last row is absent from `0.148.0-alpha.9` and present on current `main`.
Any other outer type follows the same unknown-record rule.

### Session metadata and backcompat

The first **valid** `session_meta` in physical/ordinal order is canonical. Later
ones remain in the raw record list but do not replace the session ID, producer
version, cwd, history mode, or actor. Fork/resume history can copy earlier
`session_meta` records into the file; OpenAI's loader uses the first for exactly
this reason.

Normalize the canonical payload as follows:

- native session ID: `session_id`, falling back to `id` when absent. The source
  deserializer performs this same fallback.
- producer version: `cli_version`; there is no schema version.
- history mode: `history_mode`, defaulting to `legacy` when absent.
- role: `agent_role`, accepting historical alias `agent_type`.
- source: accept a simple string such as `"vscode"` and tagged objects such as
  a `subagent.thread_spawn` source. Do not coerce it to a string.
- `base_instructions` may be absent in older traces.

For a root session, the Barbaro `agent_id` is `main`. For a thread-spawned
subagent, use the non-empty canonical `agent_path` (top-level first, then the
native thread-spawn source) and preserve its unmodified value in
`extensions.codex`. If neither exists, use a deterministic native-session-based
fallback. Never infer a parent turn from timestamps or similar prompt text.

## 4. Nested `response_item` types

`ResponseItem` is itself `#[serde(tag = "type", rename_all = "snake_case")]`.
The exact pinned variants are:

```text
additional_tools
message
agent_message
reasoning
local_shell_call
function_call
tool_search_call
function_call_output
custom_tool_call
custom_tool_call_output
tool_search_output
web_search_call
image_generation_call
compaction                 (also accepts old alias compaction_summary)
compaction_trigger
context_compaction
other                      (serde catch-all, not normally persisted)
```

The persistence policy writes every variant above except `additional_tools`,
`compaction_trigger`, and `other`. A future nested type can deserialize to
`Other` in OpenAI's typed model and lose its fields. Barbaro must preserve the
raw payload before attempting that typed conversion.

Important shapes:

- `message`: optional `id`, `role`, `content[]`, optional phase
  `commentary|final_answer`, and optional
  `internal_chat_message_metadata_passthrough.turn_id`. Text content is
  `input_text` or `output_text`; image/audio items must not be copied into the
  digest.
- `function_call`: optional `id`, `name`, optional `namespace`, JSON encoded as
  a **string** in `arguments`, and `call_id`.
- `custom_tool_call`: optional `id`, `name`, optional `namespace`, freeform
  **string** `input`, and `call_id`.
- the matching output variants carry the same `call_id`. `output` is either a
  string or an array of structured content items.
- `reasoning` can contain summary, raw, or encrypted reasoning. Reasoning is not
  copied into Barbaro turn digests.

## 5. Nested `event_msg` types and persistence

`EventMsg` is also an internally tagged snake-case enum. The exact pinned Rust
variant list is:

```text
Error, Warning, GuardianWarning,
RealtimeConversationStarted, RealtimeConversationRealtime,
RealtimeConversationClosed, RealtimeConversationSdp,
ModelReroute, ModelVerification, TurnModerationMetadata, SafetyBuffering,
ContextCompacted, ThreadRolledBack, TurnStarted, ThreadSettingsApplied,
TurnComplete, TokenCount, AgentMessage, UserMessage, AgentReasoning,
AgentReasoningRawContent, AgentReasoningSectionBreak, SessionConfigured,
EnvironmentConnected, EnvironmentDisconnected, ThreadGoalUpdated,
ThreadQueueChanged, McpStartupUpdate, McpStartupComplete, McpToolCallBegin,
McpToolCallEnd, WebSearchBegin, WebSearchEnd, ImageGenerationBegin,
ImageGenerationEnd, ExecCommandBegin, ExecCommandOutputDelta,
TerminalInteraction, ExecCommandEnd, ViewImageToolCall, ExecApprovalRequest,
RequestPermissions, RequestUserInput, DynamicToolCallRequest,
DynamicToolCallResponse, ElicitationRequest, ApplyPatchApprovalRequest,
GuardianAssessment, DeprecationNotice, StreamError, PatchApplyBegin,
PatchApplyUpdated, PatchApplyEnd, TurnDiff,
RealtimeConversationListVoicesResponse, PlanUpdate, TurnAborted,
ShutdownComplete, EnteredReviewMode, ExitedReviewMode, RawResponseItem,
RawResponseCompleted, ItemStarted, ItemCompleted, HookStarted, HookCompleted,
AgentMessageContentDelta, PlanDelta, ReasoningContentDelta,
ReasoningRawContentDelta, CollabAgentSpawnBegin, CollabAgentSpawnEnd,
CollabAgentInteractionBegin, CollabAgentInteractionEnd, CollabWaitingBegin,
CollabWaitingEnd, CollabCloseBegin, CollabCloseEnd, CollabResumeBegin,
CollabResumeEnd, SubAgentActivity
```

Wire names are snake case except for two deliberate v1 spellings:

- `TurnStarted` serializes as `task_started` and accepts `turn_started`.
- `TurnComplete` serializes as `task_complete` and accepts `turn_complete`.

The rollout does **not** persist every runtime event. At the pinned tag:

- always durable: `token_count`, `thread_goal_updated`,
  `thread_rolled_back`, `turn_aborted`, `task_started`, `task_complete`, and
  `thread_settings_applied`;
- durable only in legacy mode: `user_message`, `agent_message`,
  `agent_reasoning`, `agent_reasoning_raw_content`, `entered_review_mode`,
  `exited_review_mode`, `patch_apply_end`, `context_compacted`,
  `mcp_tool_call_end`, `web_search_end`, `image_generation_end`, and
  `sub_agent_activity`;
- `item_completed` is the canonical paginated projection. Legacy persists it
  only for plan items and the sleep extension because those lack an equivalent
  raw response item;
- all other event variants are transient and normally absent from rollout
  JSONL.

In paginated mode, `item_completed.payload.item` is a `TurnItem` tagged by exact
Rust variant names such as `UserMessage`, `AgentMessage`, `Reasoning`,
`CommandExecution`, `DynamicToolCall`, `CollabAgentToolCall`,
`SubAgentActivity`, `WebSearch`, `ImageView`, `Extension`, `ImageGeneration`,
`EnteredReviewMode`, `ExitedReviewMode`, `FileChange`, `McpToolCall`, and
`ContextCompaction`.

The current v0.1 runner fails closed when `history_mode` is not `legacy`.
Paginated `item_completed` normalization and ordinal resume are follow-up work;
the runner does not emit plausible-but-incomplete turns for that mode.

### Sanitized empirical Desktop order

An inspected local `0.148.0-alpha.9` legacy rollout follows this recurring
physical pattern (content and private identifiers were not copied):

```text
session_meta
event_msg task_started(turn_id)
response_item message(role=developer, turn_id) ...
world_state
turn_context(turn_id)
response_item message(role=user, turn_id)
event_msg user_message                         # exact text projection
response_item reasoning / calls / outputs ...
event_msg agent_message
response_item message(role=assistant, phase=commentary|final_answer, turn_id)
event_msg task_complete(turn_id)
```

`event_msg.user_message.message` was byte-identical to the corresponding user
response item, and each observed `event_msg.agent_message.message` was
byte-identical to a nearby assistant response item. Both projection orderings
occur: the event can precede the response item. Function/custom outputs match
their calls by `call_id`; unrelated durable events may appear between them.
This is why adjacency and a naive “one line equals one message” model are both
incorrect.

## 6. Deterministic turn assembly

One Barbaro turn is a genuine human request through one terminal Codex event,
not one response item and not one tool loop.

### Boundary/index algorithm

Process canonical records in ordinal/physical order while keeping open turns
indexed by native turn ID:

1. On `event_msg.task_started`, open or enrich the turn named by
   `payload.turn_id`. Record this line as its native boundary.
2. Correlate a record by, in priority order:
   `payload.turn_id`,
   `payload.internal_chat_message_metadata_passthrough.turn_id`,
   `event_msg.item_completed.turn_id`,
   `turn_context.turn_id`,
   then the sole currently open root turn for legacy projections that carry no
   turn ID. If correlation is ambiguous, keep the record opaque; do not guess.
3. A `task_complete` closes the turn with exactly matching `turn_id`.
   A `turn_aborted` closes its matching ID; when its old optional `turn_id` is
   absent, it may close the sole open root turn only.
4. A new `task_started`, a `session_meta`, a compaction record, a model response,
   or a tool result is not itself a terminal boundary.
5. Full adapter target: if `task_started` is missing, synthesize a boundary from the earliest
   correlated genuine user record. Use native turn metadata when present;
   otherwise the native turn key is `line:<one-based-physical-line>`.
6. Full adapter target: at EOF, do not emit an open turn while its active lease is unexpired. After
   lease expiry, emit `abandoned`; use the last complete correlated record's
   source timestamp for deterministic `ended_at`. A partial JSON tail never
   supplies a boundary or timestamp.
7. Assign `sequence` only to emitted top-level human turns, in canonical start
   order. Subagent turns feed the structured subagent rollup/evidence and do not
   consume the root session's sequence.

### Subagent evidence

A rollout whose canonical `thread_source` is `subagent` produces no feed turn.
Each completed interaction becomes one `subagent_turn` evidence record with the
child's stable turn ID at top-level `turn_id`. Its content directly carries
`role`, child-local `sequence`, `outcome`, `started_at`, `ended_at`, `request`,
optional `response`, and `actions`; it is never nested below `turn` or `turns`.
Codex native turn/thread metadata moves from the child turn into the evidence
record's `extensions.codex` object.

The v0.1 single-file runner cannot yet resolve a detached child's owning human
turn, so it emits `parent_link.method = "unresolved"`, omits
`parent_turn_id`, and does not create a feed reference to that orphan. Parent
rollout `sub_agent_activity` rows are lifecycle facts, not child turns; they
are `provider_event` evidence until bundle-level parent/child joining replaces
them with evidence from the actual child artifact.

The v0.1 legacy runner implements steps 1–4 and 7. Missing-start synthesis and
lease-expiry `abandoned` emission remain follow-ups; until then such records are
diagnosed as orphaned and open turns remain private runner state.

### Request selection

Developer messages, world state, turn context, hook context, and copied history
are not the human request.

For legacy mode:

1. Prefer the `response_item.message` with `role: "user"` that is the closest
   exact UTF-8 match to the turn's `event_msg.user_message.message`. Pair it
   one-to-one and treat the event as a projection duplicate.
2. If no legacy event exists, choose the last correlated ordinary user message
   after the turn context and before the first agent output/tool call.
3. If only `event_msg.user_message` exists, use its `message`.

For paginated mode, prefer `event_msg.item_completed` whose `item.type` is
`UserMessage`; use a matching raw response item as its source twin when one is
present. Preserve multiple genuinely distinct human input fragments in source
order, joining text with `\n`; never deduplicate solely because text repeats.

### Terminal response selection

1. Prefer the last correlated assistant `response_item.message` whose phase is
   `final_answer`.
2. Otherwise use the last correlated assistant message before the terminal.
3. Otherwise use non-empty `task_complete.last_agent_message`.
4. A byte-identical `event_msg.agent_message` is a legacy projection, not a
   second response. Paginated `ItemCompleted.AgentMessage` follows the same
   one-to-one pairing rule.
5. Never substitute reasoning text for the response.

### Duplicate projection rule

Within one native turn, pair the closest unmatched records that have the same
semantic class, exact UTF-8 text, and compatible phase:

```text
response_item message(role=user)       ↔ event_msg user_message
response_item message(role=assistant)  ↔ event_msg agent_message
response_item reasoning                ↔ event_msg agent_reasoning/raw_content
raw response/tool item                 ↔ item_completed (paginated)
```

The raw/response item is canonical for source identity; the event can enrich
typed status fields. The duplicate is retained in raw inspection and listed in
diagnostics, but it does not create another request, response, action, usage
entry, or evidence item. Equality outside a native turn is never a dedupe key.

### Function/custom tool pairing

Index calls and outputs across the **entire turn** by `call_id`; adjacency is
not required and outputs can arrive in reverse order.

- `function_call` pairs only with `function_call_output`.
- `custom_tool_call` pairs only with `custom_tool_call_output`.
- order normalized actions by the call record, not the output record.
- pair the earliest unmatched compatible call/output for a repeated ID and
  retain extra records as diagnostics/evidence.
- an orphan call becomes an action with outcome `unknown`; an orphan output is
  provider-event evidence and never fabricates a call.

Use the call record's stable identity for the action ID:

```text
response_item:id:<payload.id>     when id is non-empty
call_id:<payload.call_id>         otherwise for a call
ordinal:<outer ordinal>           otherwise when present
line:<physical line>              final fallback
```

The action ID parts are `(turn_id, source-record-identity, occurrence-index)`;
the first action represented by that call uses occurrence string `"0"`.
Output records affect source refs and outcome, not action identity.

Tool-specific typing must be deterministic. Desktop custom `exec` input is a
JavaScript orchestration string; recognize only literal calls such as
`tools.exec_command({"cmd":"..."})` with a strict parser, and never evaluate the
input. A recognized literal `cmd` can become `kind: "command"`; a stable typed
output with a numeric `exit_code` can supply outcome/exit code. Unknown tools
remain `kind: "tool"` and use outcome `unknown` unless their stable payload
explicitly proves one. Never infer success from the mere presence of an output
string.

### Outcome table

| Terminal evidence | Barbaro outcome |
|---|---|
| matching `task_complete`, no `error` | `success` |
| matching `task_complete.error` | `failed` |
| `turn_aborted.reason` = `interrupted`, `replaced`, or `review_ended` | `cancelled` |
| `turn_aborted.reason` = `budget_limited`, with a useful response or successful action | `partial` |
| `turn_aborted.reason` = `budget_limited`, with no useful result | `cancelled` |
| no terminal after active lease expiry | `abandoned` |
| a future terminal type proves closure but has no mapped semantics | `unknown` |

Do not derive `blocked` from prose. Emit it only when a version-pinned, typed
provider signal explicitly says outside action/information is required. The
pinned durable terminal types contain no general blocked outcome.

### Times and source refs

- `started_at`: `task_started.started_at` Unix seconds when present, otherwise
  its outer timestamp, otherwise the first correlated record timestamp.
- `ended_at`: terminal `completed_at` Unix seconds when present, otherwise its
  outer timestamp.
- Source line numbers always identify the untouched JSONL. Include the native
  turn ID and response item IDs/call IDs where available.
- Preserve native ID order by first semantic/source occurrence rather than
  lexicographically: a whole-turn ref starts with the native turn ID, followed
  by request/final response item IDs; a call/output ref lists the response item
  ID before its `call_id`. Remove later duplicates without reordering.
- For production files, use
  `trace_id = "codex:<canonical-native-session-id>:thread:<canonical-native-thread-id>"`.
  The thread component is required because root and child rollout files can
  share one session ID while their physical line numbers name different bytes.
  Omit the machine-local absolute `trace_path` from canonical output; retain it
  only in private runner state/checkpoint lookup.
  A fixture/test harness may inject a descriptive trace ID, as this corpus does;
  the supplied trace ID is carried through unchanged and never participates in
  session or turn identity.

Barbaro stable identity uses:

```text
session parts = ("codex", canonical native session ID)
turn parts    = ("codex", canonical native session ID, agent ID, native turn key)
```

The native turn key is `task_started.turn_id` (or another exact correlated
native turn ID) and only falls back to `line:<physical-line>`. Timestamps,
prompt text, parser-run identity, filtered-record position, and absolute trace
paths never enter IDs.

## 7. Active state comes from hooks, not rollout replay

Codex exposes stable command-hook input schemas at this producer tag. The key
sources are the generated schemas for
[`UserPromptSubmit`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json),
[`PreToolUse`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json),
[`PermissionRequest`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/permission-request.command.input.schema.json),
[`PostToolUse`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/post-tool-use.command.input.schema.json),
[`SubagentStart`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/subagent-start.command.input.schema.json),
[`SubagentStop`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/subagent-stop.command.input.schema.json),
and [`Stop`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/hooks/schema/generated/stop.command.input.schema.json).

`UserPromptSubmit` includes `session_id`, `turn_id`, and `prompt`.
`PreToolUse` includes `turn_id`, canonical `tool_name`, `tool_use_id`, and
untyped JSON `tool_input`. `PostToolUse` adds `tool_response`. Subagent hooks
include `agent_id` and `agent_type`. The runtime documents that the serialized
tool name and input are the stable hook contract, and that `PostToolUse` runs
after successful output; see
[`hook_runtime.rs`](https://github.com/openai/codex/blob/rust-v0.148.0-alpha.9/codex-rs/core/src/hook_runtime.rs#L162-L294).

The durable rollout persistence policy excludes `hook_started` and
`hook_completed`. Therefore, replaying JSONL cannot reconstruct an accurate
current action or write set. A rollout tailer can say that a turn appears open,
but it must not fabricate claims.

Installed hooks are only event transport. They do not enroll a session. Before
the first `UserPromptSubmit` led by the explicitly invoked `$barbaro` skill,
both the activity and ingest handlers return without writing `.barbaro/`.
Codex Desktop represents a composer-selected skill in the raw prompt as a
leading `[$barbaro](.../SKILL.md)` attachment. Admission recognizes that
attachment only when its destination resolves to the exact current-project
skill path or the user-wide `$HOME/.agents/skills/barbaro/SKILL.md`; the
separately injected `<skill>` context and generic Markdown links are not
consent. That invocation persists a
provider-and-session-scoped participation marker;
resumes of the same native session remain joined, while every new session is
dormant. Natural-language mentions do not count as consent.

Hook transcript ingestion binds the hook's native `session_id` to the first
canonical `session_meta.session_id` and project `cwd` before admitting or
publishing. A disagreement fails closed before a marker, lease, feed record,
evidence record, or runner checkpoint can be written.

### Hook → `barbaro.active.v1`

After session participation is established, every handled hook atomically
replaces that actor's snapshot and strictly increments its revision.

| Hook | State transition |
|---|---|
| `SessionStart` | For an already-joined resumed session, write/refresh an `idle` baseline; a new dormant session writes nothing. |
| `UserPromptSubmit` | A leading `$barbaro` skill invocation establishes participation. For a joined session: `working`; set deterministic session/turn IDs and verbatim prompt intent; clear prior action/claims. Run a separate transcript catch-up for a prior interrupted worker. |
| `PreToolUse` | `working`; set current action from canonical tool name/input and calculate conservative claims. |
| `PermissionRequest` | `waiting`; retain or reconstruct the pending action and its claims. |
| `PostToolUse` | `working`; clear current action/claims and `unknown_write_scope`; keep turn/intent. |
| `PreCompact` | `working`; current action `other`/`compact`, no claims. |
| `PostCompact` | `working`; clear the compact action. |
| `SubagentStart` | Write a separate `working` actor file keyed by native `agent_id`; do not overwrite the parent. |
| `SubagentStop` | Synchronously write that subagent's `idle` tombstone; a separate async ingest-only handler polls `agent_transcript_path`. |
| `Stop` | Synchronously write the root actor's `idle` tombstone; a separate async ingest-only handler polls `transcript_path` for the exact native turn ID. |
| `SessionEnd` | Write/refresh the root `idle` tombstone, then run one fast synchronous transcript catch-up after Codex's rollout flush. |

Codex invokes synchronous Stop hooks before it constructs and flushes the
durable `task_complete` record. Therefore a single synchronous “idle + ingest”
handler deadlocks visibility: it can only checkpoint an open turn. V0.1 splits
those jobs. The async worker is ingest-only and does not assume ordering with
the synchronous active handler. Cancelled/aborted turns do not receive Stop in
the pinned runtime; their active snapshot expires by TTL and their digest is
caught up by the next `UserPromptSubmit` or `SessionEnd`.

Use the hook receipt time for `updated_at` and a fixed configured TTL for
`expires_at`. Those wall-clock fields are intentionally live-state data; they
do not affect stable session, turn, or lease IDs. A late event with a lower or
equal revision must never replace a newer snapshot.

### Conservative write claims

- `apply_patch` has canonical hook name `apply_patch` and a
  `tool_input.command` containing the raw patch. Parse the patch grammar and
  claim each validated project-relative target path with confidence `exact`.
  Include old and new targets for moves. If any write target cannot be safely
  resolved inside the project, omit that target and set
  `unknown_write_scope: true`.
- `Bash` exposes `tool_input.command`. Set a command current action. Unless a
  small versioned classifier proves the command read-only or identifies every
  write target, set `unknown_write_scope: true`; do not guess paths. A complete
  write set derived by parsing shell syntax is `inferred`, not `exact`.
- For a version-pinned write/edit tool with a validated explicit path field,
  make an `exact` claim. For an allowlisted read-only tool, use no claims and
  `unknown_write_scope: false`.
- Unknown, custom, extension, or MCP tools that may mutate state use no invented
  claims and `unknown_write_scope: true`.
- Never place an absolute/out-of-project/`..` path in a Barbaro `repoPath`.

## 8. Fixture oracle

Sanitized fixtures live under `test/fixtures/codex/`. Each `*.input.jsonl` is a
raw rollout-shaped stream. The paired `*.expected.json` has:

- `turns`: byte-exact `barbaro.turn.v1` records; each object must validate
  independently against `spec/barbaro-turn-v1.schema.json`;
- `oracle`: ingest facts that are outside the common record schema, such as the
  canonical metadata line, duplicate pairs, preserved unknown records, or an
  ignored partial tail.

Fixture IDs use the normative Barbaro typed-hash algorithm. Codex action source
identity follows the rule in §6. All text, IDs, cwd values, command outputs, and
classifier names are synthetic; no private conversation text, path, or secret
is copied from the inspected traces.

The corpus covers:

- normal completion;
- interruption and terminal error;
- non-adjacent/reverse-order function and custom tool output pairing;
- byte-identical legacy response/event projections;
- repeated `session_meta` with first-valid canonicalization;
- unknown outer, response, and event types;
- a syntactically incomplete final record;
- the current-main `security_risk_score` outer type.
