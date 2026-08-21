# Barbaro interchange contract v1

Barbaro is a shared coordination layer for coding agents working in the same
project. Provider adapters read their provider's private session traces and
materialize a small, deterministic project-local view under `.barbaro/`.

This contract defines three records:

- `barbaro.turn.v1`: a completed top-level human interaction turn.
- `barbaro.evidence.v1`: an immutable supporting fact that can be loaded on
  demand.
- `barbaro.active.v1`: an expiring advisory lease describing present work.

The JSON Schemas in this directory and the examples under `examples/v1/` are
normative together. When prose and a schema disagree, treat that as a contract
bug rather than silently choosing one.

## Non-negotiable semantics

### The provider trace remains untouched

Adapters open Claude Code and Codex JSONL traces read-only. They never rewrite,
truncate, redact, rotate, or delete those files. Barbaro records are derived
copies. A provider may already have omitted, compacted, encrypted, or truncated
content before writing its trace; Barbaro cannot restore content that was never
recorded.

Any alteration made while copying text into `.barbaro/` is explicit in a
`content` object:

```json
{
  "text": "one useful excerpt",
  "fidelity": "excerpt",
  "truncated": true,
  "original_utf8_bytes": 48192,
  "redactions": []
}
```

There is no token or word limit on a source trace. Derived-field limits are
specified in UTF-8 bytes, never model tokens. No copied field may be silently
truncated or redacted. Every excerpt or redaction retains a `source_ref`.

V1 permits only deterministic transformation. It does not use an LLM to
summarize trace content.

### A turn is a human interaction, not a model response

One `barbaro.turn.v1` record represents a genuine human prompt through the
terminal outcome of that interaction, including every model response and tool
loop in between. A provider API response ID may help aggregate content or
deduplicate usage, but it is never the Barbaro turn boundary or `turn_id`.

For Claude Code, `message.id` is a usage-deduplication key. A genuine-human
record UUID is the preferred native turn key. For Codex, a native turn ID is
preferred. A physical source-line ordinal is the deterministic fallback; prompt
text, timestamps, parser-run IDs, and filtered-record positions are not valid ID
inputs.

### Digest and evidence are different products

The turn digest is the default peer context. It contains the request, terminal
response, meaningful actions and outcomes, changed paths, failures/blockers,
and a compact structured subagent rollup. It excludes model token accounting,
hidden reasoning, file bodies, images, and successful command stdout.

Evidence is normalized, immutable, and loaded only when the digest is
insufficient. It may contain bounded failure excerpts, tool facts, deduplicated
usage, attachment metadata, and full subagent turns. Evidence is not a second
raw archive; the provider trace remains the raw source of truth.

### Active state is an advisory lease, not a lock

An active record says what an actor appears to be doing now. A path claim does
not confer ownership or prevent another process from writing. UIs and agents
must call it a `claim` or `write_set`, never a hold or lock.

Every active record has an expiry. Consumers ignore expired records and records
whose `state` is `idle`. Writers use an atomic temporary-file replacement, and
revisions strictly increase for a given actor. A Stop hook writes an `idle`
tombstone before eventual cleanup so a delayed earlier hook cannot resurrect
stale activity. Concurrent subagents use separate actor files.

If a shell command's write scope cannot be determined exactly, the writer sets
`unknown_write_scope: true`; it never invents paths.

## Project layout

```text
.barbaro/
  feed/<provider>/<session-id>.jsonl
  evidence/<provider>/<session-id>.jsonl
  active/<provider>/<actor-id>.json
  state/<provider>/<physical-trace-key-hash>.json
```

Each feed/evidence file is append-only UTF-8 JSONL, one complete JSON object per
line. Provider hook processes serialize concurrent appends with a cross-process
filesystem lock; stable record IDs make replay idempotent. A reader tolerates a
partial final line. Active files are atomic snapshots rather than JSONL.
`state/` is private parser/checkpoint machinery and is not peer context.

The physical trace key is local checkpoint identity, normally a hash of the
absolute provider trace path. It is intentionally distinct from the logical
`trace_id` carried by source references and never participates in public record
IDs.

Generated activity under `.barbaro/feed/`, `.barbaro/evidence/`, and
`.barbaro/active/` is excluded from subsequent digests and evidence to prevent
agents observing each other from creating an echo loop.

Provider adapters do not edit a project's `.gitignore`. Before enabling
Barbaro, the project must add `.barbaro/` to its own ignore rules. Publishing
that directory requires an explicit project decision because source references
and copied content may be sensitive.

Store implementations reject pre-existing symbolic-link escapes and final
files with multiple hard links. Because ordinary Node path APIs do not expose a
complete dirfd-relative `openat2`/`renameat` workflow, a process able to rename
components inside `.barbaro/` concurrently can still create a pathname TOCTOU
race. The project root and `.barbaro/` must therefore not be writable by an
untrusted local user.

## Stable identity

V1 IDs are deterministic typed hashes. Let `parts` be the provider-native
identity components defined below. Hash the UTF-8 bytes of:

```text
barbaro-id-v1\0<type>\0<length>:<part>\0<length>:<part>...
```

with SHA-256, keep the first 16 bytes, and encode them as 32 lowercase hex
characters. Prefix the result with `ses_`, `turn_`, `act_`, `ev_`, or `lease_`.
Length is the UTF-8 byte length. A missing component is framed as `-1:` and an
empty component as `0:`, so missing and empty components are distinct.

- Session: provider plus provider-native session ID.
- Turn: provider, native session ID, actor ID, and native turn key.
- Action/evidence: stable turn ID, stable source-record identity, and occurrence
  index within that source record.
- Lease: provider, native session ID, and actor ID.

Reprocessing an unchanged source produces the same IDs and byte-equivalent
records. Absolute trace paths, generated timestamps, and parser run identity do
not participate in IDs.

## Ordering and outcomes

`sequence` is monotonic only among top-level turns in one session. It is not an
identity. Provider adapters derive it from the provider's canonical ordering:
Codex rollout order/ordinal and Claude's active DAG branch with deterministic
topological ordering.

Terminal turn outcomes are:

- `success`: the requested interaction ended normally.
- `partial`: useful work landed, but part of the request remains.
- `blocked`: the agent explicitly requires outside action or information.
- `failed`: the attempted work failed.
- `cancelled`: the user or system cancelled the turn.
- `abandoned`: the trace ended without a terminal event after lease expiry.
- `unknown`: the trace proves terminality but not the outcome.

Unknown values are omitted rather than represented as `null`.

## Actions

Actions remain in source order. V1 action kinds are `file_change`, `command`,
`test`, `tool`, and `other`. Every action has a stable `action_id`, an `outcome`,
and at least one source reference. Repository paths are workspace-relative POSIX
paths with neither a leading slash nor `..` components.

Successful command output is not copied into the digest. A failure may carry a
bounded, explicitly marked excerpt. Tests are a separate action kind only when
the provider identifies them or a deterministic command classifier does; a
classifier must never claim certainty it does not have.

## Subagents

Search-only subagent activity remains in evidence. The parent digest contains a
structured rollup: total count, provider-supplied roles, outcomes, changed paths,
and evidence IDs. A subagent's detail is promoted into the parent digest only
when it mutates the workspace, returns a meaningful conclusion, fails, or
blocks.

Parent links carry their derivation method. Claude Code parentage is joined by
indexing parent Agent/Task tool results by `agentId`; sidechain DAG roots alone
do not contain that edge. An unresolved parent remains unresolved and is never
guessed.

Every actual child interaction is represented by one `subagent_turn` evidence
record. Its top-level `turn_id` is the child's stable turn ID; when resolved,
`parent_turn_id` is the top-level human turn whose digest names the evidence
ID. Thus child identity never depends on when or whether parent resolution
succeeds. An unresolved record omits `parent_turn_id` and is never referenced
by a parent digest. A runner that expects more lineage to arrive withholds the
record instead of appending an immutable orphan that it would later need to
revise.

`subagent_turn.content` carries the child turn directly, never below a `turn`
or `turns` wrapper. Its required provider-neutral fields are `role`, `sequence`,
`outcome`, `started_at`, `ended_at`, `request`, and `actions`; `response` is
optional. Envelope identity, lineage, and source references remain at the
evidence-record level. Provider topology such as a Claude workflow ID or Codex
native thread metadata belongs in the top-level provider `extensions` object.
`occurred_at` equals the child turn's `ended_at`.

The rollup's `total` counts immediate child actors, not child turns. One actor
may therefore contribute several evidence IDs. The parent digest names every
published child-turn evidence ID in both `subagents.evidence_refs` and its
top-level `evidence_refs`.

Canonical child evidence remains complete even when it is large. Default feed
readers do not automatically dereference it. A bounded evidence reader pages a
noncanonical view of an oversized action list and reports the total, returned
count, and continuation cursor; it never splits or truncates the immutable
JSONL record. Merely limiting the number of JSONL records is insufficient
because one child turn can exceed the whole reader byte budget.

## Source references

A source reference identifies the provider trace plus one or more stable native
record IDs or physical line numbers. Line numbers are one-based and refer to
the unmodified JSONL file. A `trace_path` is optional because records may be
synced to another machine. Production adapters omit machine-local absolute
trace paths from canonical records so moving an unchanged trace cannot change
the derived bytes; the private checkpoint retains the physical path needed by
the local runner. Dereferencing a source reference can reveal private raw
content; it is not a security boundary.

One source reference names exactly one physical trace artifact. All of its line
numbers and `native_record_ids` belong to that `trace_id`; IDs from a parent
trace, child trace, and workflow journal are never combined into one reference.
A subagent record cites its child-turn span first. Separate later references
may cite the parent-link witnesses. When one provider session owns several
physical rollout files, their logical trace IDs include a stable artifact or
thread identity so the same line number cannot ambiguously name several files.

## Provider extensions and drift

Provider parsers accept unknown source record types and fields and preserve
enough source identity to inspect them later. The common record schemas are
closed except for the `extensions` object. Provider-specific data lives under a
provider key such as `extensions.claude` or `extensions.codex`; it must not
change the meaning of a common field.
