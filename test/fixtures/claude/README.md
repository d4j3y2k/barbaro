# Claude Code fixtures

Sanitized, structurally faithful Claude Code JSONL traces for the Claude provider adapter.

**Sanitized** means: synthetic content, no real paths, prompts, credentials, or file bodies. Every
field name, envelope shape, nesting, and directory layout matches production traces as measured in
[`../../../docs/claude-code-jsonl-schema.md`](../../../docs/claude-code-jsonl-schema.md). Content that is
never copied into Barbaro is present but stubbed (`REDACTED-THINKING-CONTENT`, `REDACTED-FILE-BODY`,
`REDACTED-SIGNATURE`) so the adapter still exercises its exclusion paths.

Each fixture root mirrors `~/.claude/projects/`, so a fixture is used by pointing the adapter's trace
root at `test/fixtures/claude/<name>/projects`. Workspace root is `/tmp/demo-workspace` throughout;
`test/runner/claude.test.ts` stages a copy into a temp project and rewrites that path, so the
runner's project check and repo-path relativization run against real values rather than a special case.

Directory trees are load-bearing here, not decoration: the subagent parent join is resolved partly
from path structure, so these fixtures cannot be flattened into the single-file
`<name>.input.jsonl` shape the Codex fixtures use.

---

## `missing-origin/`

Session `11111111-…`, four turn-initiating records, one per provenance class.

| Record | Signal | Expected |
|---|---|---|
| `…0001` | `origin.kind == "human"`, `promptSource: "typed"` | starts a turn |
| `…0003` | **neither field**, `version: 2.1.220`, `content` is a **bare string** | starts a turn via the structural fallback |
| `…0005` | `promptSource: "sdk"` | does not start a turn (§7-M3) |
| `…0007` | `origin.kind == "task-notification"` | does not start a turn (§7-M3) |

**Asserts:** the structural fallback fires for `…0003` and sets
`extensions.claude.turn_start.method = "structural"`; a bare-string `message.content` parses;
`2.1.220` emits human prompts both with and without `origin`, so version alone cannot gate the rule.
Without the fallback this session yields 1 turn instead of 2.

## `failed-tool-loop/`

Session `22222222-…`, one turn, six tool calls, covering every failure mode Claude can express.

**Asserts:**

- **Usage dedup.** `msg_1001` spans three lines (`thinking`, `text`, `tool_use`) each carrying
  `output_tokens: 512`. Correct total for that response is **512**; summing rows gives 1536.
- **No exit code.** `toolu_A` is a genuinely failing `npm test` — the failure appears only in `stdout`
  prose. `is_error` is `false`, `stderr` is `""`, and no exit-code field exists. Its action `outcome`
  must be `unknown`, never `failed` and never `success`.
- **Denial.** `toolu_D` carries `toolDenialKind: "permission-rule"` and a **string** `toolUseResult`
  → `outcome: "denied"`.
- **Interruption.** `toolu_E` has `interrupted: true` → `outcome: "interrupted"`.
- **Out-of-workspace edit.** `toolu_F` targets `/Users/demo/.claude/…/memory/MEMORY.md`, which cannot
  be expressed as a `repoPath` (§7-M1). This fixture is the regression case for whatever M1 resolves to.
- **Turn outcome.** Terminal `end_turn` with a denied action present → `partial`, not `success`.
- `thinking` and `originalFile` are present in the source and must appear in no Barbaro output.

## `subagent-join/`

Session `33333333-…` with both subagent kinds, exercising the two different parent joins.

```
33333333-….jsonl                                        parent session
33333333-…/subagents/agent-a1111111111111111.jsonl      direct subagent (Explore, search-only)
33333333-…/subagents/workflows/wf_abc1234-def/
    agent-a2222222222222222.jsonl                       workflow agent (mutates src/a.ts)
    journal.jsonl                                       started/result records
```

**Asserts:**

- **Direct join.** `agentId: "a1111111111111111"` appears in the parent's `toolUseResult` for
  `toolu_S1` → `parent_link: {method: "joined", native_key: "a1111111111111111"}`, role `Explore`
  from `subagent_type`.
- **Workflow join.** `a2222222222222222` has **no `Agent` tool call in the parent**. It joins via the
  `wf_abc1234-def` path component to the parent's `Workflow` call (`toolu_W1`), corroborated by
  `journal.jsonl` → `native_key: "wf_abc1234-def/a2222222222222222"`. An adapter that only implements
  the direct join leaves this agent unresolved.
- **Promotion.** The `Explore` agent is search-only → stays in evidence, contributes to the rollup
  count only. The workflow agent mutates `src/a.ts` → its changed path is promoted into the parent
  digest's `subagents.changed_paths`.
- Both subagent roots have `parentUuid: null` — the edge exists nowhere in the subagent file.
- `started`/`result` records appear **only** in `journal.jsonl`, never in a session or agent file.

## `compaction-forks/`

Session `44444444-…` containing both a rewind fork and a compaction boundary.

```
…0001 ─ …0002 ─┬─ …0003 ─ …0004        abandoned branch
               └─ …0005 ─ …0006        active branch
                            │
                       (compact_boundary …0007, parentUuid: null,
                        logicalParentUuid: …0006)
                            │
                          …0008 ─ …0009  ← last-prompt.leafUuid
```

**Asserts:**

- **Fork.** `…0002` has two children (`…0003` and `…0005`). Walking parents back from
  `last-prompt.leafUuid` (`…0009`) selects the active branch and excludes `…0003`/`…0004`.
- **Compaction severs the DAG.** `…0007` has `parentUuid: null`; only `logicalParentUuid` connects it
  to `…0006`. A `parentUuid`-only traversal splits this session into two disconnected components and
  loses turns 1–3. Traverse `parentUuid ?? logicalParentUuid`.
- **A compact boundary is not a turn boundary.** It emits evidence (`kind: "provider_event"`) carrying
  `compactMetadata`, and does not create, split, or terminate a turn.
- **Pre-compaction records survive in the file** above the boundary, even though the model could no
  longer see them.
- **Sequencing under rewind** is the open contract question (§7-M5): the abandoned branch's turn was
  emitted before the rewind, so `sequence` either collides or gaps.

## `terminal-split/`

Session `55555555-…`, one turn whose single API response spans two lines.

`stop_reason: "end_turn"` appears on **both** lines — first on the `thinking` block, then on the
`text` block that carries the actual answer.

**Asserts:** the turn is not closed on the first line that reports `end_turn`. Closing there discards
the response entirely. This is a regression fixture: the bug shipped past all four synthetic fixtures
above and was only caught by running against real traces, where it silently emptied the `response`
field on the majority of turns. Also asserts the two lines contribute usage exactly once.

## `pretool-attachment-fork/`

Session `12121212-…` is a sanitized replay of the 2026-08-23 wake-nudge probe. Its stale
`last-prompt` names the preceding turn's `turn_duration`; the next Monitor wake calls Bash and Claude
Code records two children beneath that `tool_use`:

```
tool_use …0005 ─┬─ attachment hook_success …0006
                │    └─ attachment hook_additional_context …0007
                └─ user tool_result …0008 ─ … ─ system turn_duration …0013
```

The semantic continuation includes an inline token-reminder attachment, the first terminal verdict,
an `isMeta` Stop-hook feedback row, `hook_blocking_error`, the required context read, the verbatim
re-send, and the final `turn_duration`.

**Asserts:** the attachment-only PreToolUse side branch is transparent to a stale pointer, the wake
publishes as one turn at its own Stop with both terminal responses and the context action, and
`computeActiveAncestry` agrees with the publishing runner. A synthetic second message child beneath
the same tool call remains a genuine ambiguous continuation and publishes nothing.

## `queued-background-completion/`

Session `fefefefe-…` is a sanitized replay of the relevant records in the first
331 lines of reviewer transcript `6d347ab3-e500-4933-b88a-eaae5bfdb2ff`.
A Bash launched with `run_in_background: true` first returns its ordinary
"still running" tool result. Its in-turn completion then appears as duplicate,
UUID-less `queue-operation` enqueue/remove rows plus a DAG-bearing
`attachment.type: "queued_command"` with `commandMode: "task-notification"`.

The fixture also carries an off-branch copy of that completion and an on-branch
Monitor notification with no `<tool-use-id>`, followed by the real split
terminal response, Stop summary, and `turn_duration` records. Only the
on-branch completed queued-command attachment may settle the named launch.
Removing its completion payload leaves the terminal turn open with the same
pending background ID; queue bookkeeping, off-branch attachments, and Monitor
notifications must not make a still-running task look complete.

---

## Validating

These are provider-side inputs, so they validate against the Claude format, not the Barbaro schemas.
Structural check:

```sh
find test/fixtures/claude -name '*.jsonl' -exec sh -c \
  'while IFS= read -r l; do printf "%s" "$l" | jq -e . >/dev/null || echo "BAD $1"; done < "$1"' _ {} \;
```

Behavioural assertions live in `test/providers/claude/normalizer.test.ts` and
`test/runner/claude.test.ts` rather than in checked-in expected-output files, because the assertions
that matter here are properties (usage counted once, no absolute paths, no hidden reasoning) rather
than exact byte snapshots. Determinism itself is asserted directly: re-running the normalizer must
produce deepEqual records, and a `--reset` ingest must append nothing.
