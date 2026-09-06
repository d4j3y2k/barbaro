import assert from "node:assert/strict";
import test from "node:test";

import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import {
  emptyNudgeReadState,
  isReadRecordAcknowledged,
  MAX_PENDING_READS,
  MAX_READ_COVERAGE_RECORDS,
  mergeReadCoverage,
  mergeReadRanges,
  parseNudgeReadState,
  readContentHash,
  readRecordHash,
  type NudgePendingRead,
  type NudgeReadCoverage,
} from "../../src/nudge/read-state.js";
import { selectTurnText } from "../../src/reader/record-page.js";

const TURN: BarbaroTurnV1 = {
  schema: "barbaro.turn.v1",
  provider: "claude",
  session_id: `ses_${"1".repeat(32)}`,
  turn_id: `turn_${"2".repeat(32)}`,
  workstream_id: `ws_${"3".repeat(32)}`,
  agent_id: "main",
  sequence: 1,
  started_at: "2026-09-05T18:00:00.000Z",
  ended_at: "2026-09-05T18:00:01.000Z",
  outcome: "success",
  request: { text: "request", fidelity: "verbatim", redactions: [], truncated: false },
  response: { text: "abcdefghij", fidelity: "verbatim", redactions: [], truncated: false },
  actions: [],
  subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] },
  evidence_refs: [],
  source_refs: [],
};

function coverage(
  turn = TURN,
  field: NudgeReadCoverage["field"] = "response",
): NudgeReadCoverage {
  const selected = selectTurnText(turn, field);
  const length = Buffer.byteLength(selected.text);
  return {
    provider: turn.provider,
    session_id: turn.session_id,
    turn_id: turn.turn_id,
    record_sha256: readRecordHash(turn),
    field,
    field_sha256: readContentHash(selected.text),
    total_bytes: length,
    ranges: [{ start: 0, end: length }],
  };
}

function pending(): NudgePendingRead {
  return {
    nonce: "a".repeat(32),
    tool_use_id: "call_native_1",
    turn: { kind: "codex", turn_id: `turn_${"b".repeat(32)}` },
    project_root: "/tmp/synthetic-barbaro-read",
    command: "barbaro read context",
    query_sha256: "c".repeat(64),
    tool_input_sha256: "d".repeat(64),
    created_at: "2026-09-05T18:00:00.000Z",
    expires_at: "2026-09-05T18:05:00.000Z",
  };
}

test("out-of-order pages preserve missing bytes and replay is an exact no-op", () => {
  const full = coverage();
  const first = mergeReadCoverage(emptyNudgeReadState(), [
    { ...full, ranges: [{ start: 7, end: 10 }] },
    { ...full, ranges: [{ start: 0, end: 3 }] },
  ]);
  assert.equal(isReadRecordAcknowledged(first, TURN), false);
  assert.deepEqual(first.coverage[0]!.ranges, [{ start: 0, end: 3 }, { start: 7, end: 10 }]);
  assert.equal(mergeReadCoverage(first, [{ ...full, ranges: [{ start: 1, end: 2 }] }]), first);
  const complete = mergeReadCoverage(first, [{ ...full, ranges: [{ start: 3, end: 7 }] }]);
  assert.equal(isReadRecordAcknowledged(complete, TURN), true);
  assert.equal(mergeReadCoverage(complete, [full]), complete);
});

test("canonical mutation, wrong fields and false field hashes cannot consume a turn", () => {
  const full = coverage();
  const state = mergeReadCoverage(emptyNudgeReadState(), [full]);
  assert.equal(isReadRecordAcknowledged(state, { ...TURN, outcome: "failed" }), false);
  assert.equal(isReadRecordAcknowledged(state, { ...TURN, session_id: `ses_${"4".repeat(32)}` }), false);
  assert.equal(isReadRecordAcknowledged(
    mergeReadCoverage(emptyNudgeReadState(), [coverage(TURN, "request")]), TURN,
  ), false);
  assert.equal(isReadRecordAcknowledged(
    mergeReadCoverage(emptyNudgeReadState(), [{ ...full, field_sha256: "0".repeat(64) }]), TURN,
  ), false);
  const changed = { ...TURN, outcome: "failed" as const };
  const mixed = mergeReadCoverage(
    mergeReadCoverage(emptyNudgeReadState(), [{ ...full, ranges: [{ start: 0, end: 5 }] }]),
    [{ ...coverage(changed), ranges: [{ start: 5, end: 10 }] }],
  );
  assert.equal(isReadRecordAcknowledged(mixed, TURN), false);
  assert.equal(isReadRecordAcknowledged(mixed, changed), false);
  assert.equal(isReadRecordAcknowledged(
    mergeReadCoverage(emptyNudgeReadState(), [coverage(TURN, "record")]), TURN,
  ), true);
});

test("empty, producer-shortened and lone-surrogate attention fields retain their exact representation", () => {
  const { response: _response, ...noResponse } = TURN;
  const empty = { ...TURN, response: { ...TURN.response!, text: "" } };
  const shortened = {
    ...TURN,
    response: { ...TURN.response!, truncated: true, original_utf8_bytes: 1000 },
  };
  const loneSurrogate = { ...TURN, response: { ...TURN.response!, text: "a\ud800z" } };
  const turns: readonly BarbaroTurnV1[] = [noResponse, empty, shortened, loneSurrogate];
  for (const turn of turns) {
    const entry = coverage(turn, turn.response === undefined ? "request" : "response");
    assert.equal(isReadRecordAcknowledged(
      mergeReadCoverage(emptyNudgeReadState(), [entry]), turn,
    ), true);
  }
  assert.equal(selectTurnText(loneSurrogate, "response").representation, "json-string");
});

test("read-state decoding strictly binds native pending calls, expiry and schema keys", () => {
  const good = { ...emptyNudgeReadState(), pending: [pending()] };
  assert.deepEqual(parseNudgeReadState(good, "codex", undefined), good);
  const invalid = [
    { ...good, unknown: true },
    { ...good, outside_window: undefined },
    { ...good, pending: [{ ...pending(), output: "x".repeat(8193) }] },
    { ...good, pending: [{ ...pending(), project_root: "relative" }] },
    { ...good, pending: [{ ...pending(), expires_at: "2026-09-05T18:05:00.001Z" }] },
    { ...good, pending: [{ ...pending(), expires_at: pending().created_at }] },
    { ...good, pending: [{ ...pending(), query_sha256: "unknown" }] },
    { ...good, pending: [{ ...pending(), unexpected: true }] },
    { ...good, pending: [pending(), { ...pending(), nonce: "d".repeat(32) }] },
    { ...good, pending: Array.from({ length: MAX_PENDING_READS + 1 }, pending) },
  ];
  for (const value of invalid) assert.throws(() => parseNudgeReadState(value, "codex", undefined));
  assert.throws(() => parseNudgeReadState(good, "claude", 1));
  const claude = {
    ...good, pending: [{ ...pending(), turn: { kind: "claude", generation: 3 } }],
  };
  assert.deepEqual(parseNudgeReadState(claude, "claude", 3), claude);
  assert.throws(() => parseNudgeReadState(claude, "claude", 2));
  assert.throws(() => parseNudgeReadState(claude, "codex", undefined));
});

test("coverage and fragmentation saturation refuse new acknowledgments without deleting prior state", () => {
  const entries = Array.from({ length: MAX_READ_COVERAGE_RECORDS }, (_, index) => ({
    ...coverage(), turn_id: `turn_${index.toString(16).padStart(32, "0")}`,
  }));
  const saturated = mergeReadCoverage(emptyNudgeReadState(), entries);
  assert.equal(mergeReadCoverage(saturated, [entries[0]!]), saturated);
  assert.throws(() => mergeReadCoverage(saturated, [coverage()]), /too many delivered/);
  assert.equal(saturated.coverage.length, MAX_READ_COVERAGE_RECORDS);
  assert.throws(() => mergeReadRanges(
    Array.from({ length: 257 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 })),
  ), /too many incomplete/);
  for (const ranges of [
    [], [{ start: 0, end: 11 }], [{ start: 0, end: 0 }],
    [{ start: 0, end: 5 }, { start: 5, end: 10 }],
    [{ start: 7, end: 10 }, { start: 0, end: 3 }],
  ]) {
    assert.throws(() => parseNudgeReadState({
      ...emptyNudgeReadState(), coverage: [{ ...coverage(), ranges }],
    }, "codex", undefined));
  }
});
