import assert from "node:assert/strict";
import test from "node:test";

import type {
  BarbaroAction,
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";
import { stableStringify } from "../../src/core/stable-json.js";
import {
  projectContext,
  projectEvidence,
  projectReaderContent,
  projectTurn,
} from "../../src/reader/projection.js";
import { READER_CONTEXT_TURN_RETRIEVAL_HINT } from "../../src/reader/types.js";

const SOURCE_REF = { trace_id: "fixture:reader" } as const;

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function actions(count: number): BarbaroAction[] {
  return Array.from({ length: count }, (_, index) => ({
    action_id: `act_${String(index).padStart(32, "0")}`,
    kind: "file_change" as const,
    outcome: "success" as const,
    operation: "modify" as const,
    path: `src/reader/file-${String(index).padStart(3, "0")}.ts`,
    source_refs: [SOURCE_REF],
  }));
}

function turn(): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: "turn_11111111111111111111111111111111",
    provider: "codex",
    session_id: "ses_22222222222222222222222222222222",
    sequence: 7,
    agent_id: "root",
    started_at: "2026-08-16T20:00:00.000Z",
    ended_at: "2026-08-16T20:01:00.000Z",
    outcome: "success",
    request: {
      text: "A😀éZ ".repeat(100),
      fidelity: "redacted",
      truncated: true,
      original_utf8_bytes: 4096,
      redactions: [
        { kind: "token", count: 2 },
        { kind: "api_key", count: 1 },
      ],
    },
    response: content("bounded response ".repeat(100)),
    actions: actions(20),
    subagents: {
      total: 2,
      by_role: [{ role: "search", count: 2 }],
      outcomes: { success: 2 },
      changed_paths: ["src/a.ts", "src/b.ts"],
      evidence_refs: ["ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    },
    evidence_refs: Array.from(
      { length: 10 },
      (_, index) => `ev_${index.toString(16).padStart(32, "0")}`,
    ),
    source_refs: [SOURCE_REF],
  };
}

test("content projection distinguishes canonical and reader truncation", () => {
  const projected = projectReaderContent(turn().request, 7);
  assert.equal(projected.text, "A😀é");
  assert.deepEqual(projected.truncated, {
    canonical: true,
    projection: true,
  });
  assert.deepEqual(projected.utf8_bytes, {
    shown: 7,
    canonical: Buffer.byteLength(turn().request.text, "utf8"),
    original: 4096,
  });
  assert.deepEqual(projected.redactions, [
    { kind: "api_key", count: 1 },
    { kind: "token", count: 2 },
  ]);
});

test("turn projection is deterministic, byte-bounded, and reports N-of-M", () => {
  const options = {
    byteBudget: 2600,
    requestExcerptBytes: 128,
    responseExcerptBytes: 128,
    actionExcerptBytes: 0,
  } as const;
  const first = projectTurn(turn(), options);
  const replay = projectTurn(turn(), options);

  assert.deepEqual(replay, first);
  assert.equal(Buffer.byteLength(stableStringify(first), "utf8"), first.utf8_bytes);
  assert.ok(first.utf8_bytes <= options.byteBudget);
  assert.equal(first.value.actions.total, 20);
  assert.ok(first.value.actions.shown < first.value.actions.total);
  assert.equal(first.value.actions.items.length, first.value.actions.shown);
  assert.equal(first.value.evidence_refs.total, 10);
  assert.ok(
    first.value.evidence_refs.shown < first.value.evidence_refs.total,
  );
  assert.equal(first.value.request.truncated.canonical, true);
  assert.equal(first.value.request.truncated.projection, true);
  assert.deepEqual(first.value.request.redactions, [
    { kind: "api_key", count: 1 },
    { kind: "token", count: 2 },
  ]);
});

test("bounded context points to lossless turn retrieval only when turns are hidden", () => {
  const diagnostics = {
    feed_files: 1,
    malformed_feed_records: 0,
    invalid_feed_records: 0,
    partial_feed_files: 0,
    scan_limited_feed_files: 0,
    invalid_active_records: 0,
  } as const;
  const hidden = projectContext(
    [],
    Array.from({ length: 12 }, (_, index) => ({
      ...turn(),
      turn_id: `turn_${(index + 1).toString(16).padStart(32, "0")}`,
      sequence: index + 1,
    })),
    diagnostics,
    { byteBudget: 2600 },
  );

  assert.ok(hidden.value.turns.shown < hidden.value.turns.total);
  assert.equal(
    hidden.value.turn_retrieval_hint,
    READER_CONTEXT_TURN_RETRIEVAL_HINT,
  );
  assert.equal(
    hidden.value.turn_retrieval_hint,
    "Run `barbaro turn list`, then `barbaro turn show <turn_id>`.",
  );

  const complete = projectContext([], [turn()], diagnostics, {
    byteBudget: 12_000,
  });
  assert.equal(complete.value.turns.shown, complete.value.turns.total);
  assert.equal("turn_retrieval_hint" in complete.value, false);

  const boundaryTurn: BarbaroTurnV1 = {
    ...turn(),
    request: content(""),
    response: content(""),
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
  };
  const exactComplete = projectContext([], [boundaryTurn], diagnostics, {
    byteBudget: 12_000,
  });
  const boundary = projectContext([], [boundaryTurn], diagnostics, {
    byteBudget: exactComplete.utf8_bytes,
  });
  assert.equal(boundary.value.turns.shown, boundary.value.turns.total);
  assert.equal("turn_retrieval_hint" in boundary.value, false);
});

test("subagent evidence actions page without changing the canonical record", () => {
  const evidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: "ev_33333333333333333333333333333333",
    kind: "subagent_turn",
    turn_id: "turn_44444444444444444444444444444444",
    parent_turn_id: "turn_11111111111111111111111111111111",
    parent_link: { method: "joined", native_key: "child-1" },
    provider: "claude",
    session_id: "ses_55555555555555555555555555555555",
    agent_id: "child-1",
    occurred_at: "2026-08-16T20:02:00.000Z",
    source_refs: [SOURCE_REF],
    content: {
      role: "worker",
      sequence: 1,
      outcome: "success",
      started_at: "2026-08-16T20:01:00.000Z",
      ended_at: "2026-08-16T20:02:00.000Z",
      request: content("inspect files"),
      response: content("done"),
      actions: actions(12),
    },
  };
  const before = stableStringify(evidence);
  const first = projectEvidence(evidence, {
    byteBudget: 1800,
    requestExcerptBytes: 32,
    responseExcerptBytes: 32,
    actionExcerptBytes: 0,
  });
  assert.equal(first.value.kind, "subagent_turn");
  const firstContent = first.value.content;
  assert.ok("actions" in firstContent);
  assert.equal(firstContent.actions.total, 12);
  assert.ok(firstContent.actions.shown > 0);
  assert.ok(firstContent.actions.shown < firstContent.actions.total);
  const nextCursor = firstContent.actions.next_cursor;
  assert.ok(nextCursor !== undefined);
  assert.match(nextCursor, /^a:[1-9][0-9]*$/u);

  const second = projectEvidence(evidence, {
    byteBudget: 1800,
    requestExcerptBytes: 32,
    responseExcerptBytes: 32,
    actionExcerptBytes: 0,
    actionCursor: nextCursor,
  });
  const secondContent = second.value.content;
  assert.ok("actions" in secondContent);
  assert.notEqual(
    secondContent.actions.items[0]?.action_id,
    firstContent.actions.items[0]?.action_id,
  );
  assert.equal(stableStringify(evidence), before);
});
