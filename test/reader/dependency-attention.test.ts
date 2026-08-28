import assert from "node:assert/strict";
import test from "node:test";

import {
  READER_UNKNOWN_AUDIENCE_SOURCE_BYTES,
  normalizeExplicitViewerIdentity,
  normalizeReaderAttentionAudience,
  projectReaderDependencyLease,
  readerViewerMatches,
  type ReaderDependencyLeaseInput,
} from "../../src/reader/dependency.js";

const WORKSTREAM_ID = "ws_0123456789abcdef0123456789abcdef";
const SESSION_ID = "ses_0123456789abcdef0123456789abcdef";

function lease(
  overrides: Partial<ReaderDependencyLeaseInput> = {},
): ReaderDependencyLeaseInput {
  return {
    state: "waiting",
    workstream_id: WORKSTREAM_ID,
    current_action: {
      kind: "command",
      command: { text: "barbaro await --timeout-ms 120000" },
      started_at: "2026-08-25T06:00:00.000Z",
    },
    ...overrides,
  };
}

test("wait and block state survive whether dependency enrichment is present", () => {
  const cases: readonly {
    readonly input: ReaderDependencyLeaseInput;
    readonly state: ReaderDependencyLeaseInput["state"];
    readonly enriched: boolean;
  }[] = [
    { input: lease(), state: "waiting", enriched: true },
    { input: lease({ state: "blocked" }), state: "blocked", enriched: true },
    {
      input: lease({
        state: "waiting",
        current_action: { kind: "command", command: { text: "npm test" } },
      }),
      state: "waiting",
      enriched: false,
    },
    {
      input: { state: "blocked", workstream_id: WORKSTREAM_ID },
      state: "blocked",
      enriched: false,
    },
    { input: lease({ state: "working" }), state: "working", enriched: false },
    { input: lease({ state: "idle" }), state: "idle", enriched: false },
  ];

  for (const candidate of cases) {
    const actual = projectReaderDependencyLease(candidate.input);
    assert.equal(actual.state, candidate.state);
    assert.equal(actual.dependency !== undefined, candidate.enriched);
  }
});

test("classified leading await gets full workstream target and timing", () => {
  const expectedBase = {
    kind: "peer_unread",
    audience: "peer",
    target: { type: "workstream", workstream_id: WORKSTREAM_ID },
    started_at: "2026-08-25T06:00:00.000Z",
    provenance: {
      source: "reader",
      method: "classified_barbaro_await",
    },
  } as const;
  const cases = [
    {
      command: "barbaro await --timeout-ms 120000",
      deadline: "2026-08-25T06:02:00.000Z",
    },
    {
      command: `'barbaro' "await" --timeout-ms 42`,
      deadline: "2026-08-25T06:00:00.042Z",
    },
    {
      command: "barbaro await --timeout-ms 42; echo done",
      deadline: "2026-08-25T06:00:00.042Z",
    },
  ] as const;

  for (const candidate of cases) {
    const actual = projectReaderDependencyLease(
      lease({
        current_action: {
          kind: "command",
          command: { text: candidate.command },
          started_at: expectedBase.started_at,
        },
      }),
    );
    assert.deepEqual(actual, {
      state: "waiting",
      dependency: {
        ...expectedBase,
        deadline_at: candidate.deadline,
      },
    });
  }
});

test("non-leading, invalid, and unscoped awaits do not invent dependencies", () => {
  const inputs: readonly ReaderDependencyLeaseInput[] = [
    lease({
      current_action: {
        kind: "command",
        command: { text: "echo barbaro await" },
      },
    }),
    lease({
      current_action: {
        kind: "command",
        command: { text: "/usr/bin/barbaro await" },
      },
    }),
    lease({
      current_action: {
        kind: "command",
        command: { text: `barbaro "await` },
      },
    }),
    {
      state: "waiting",
      current_action: {
        kind: "command",
        command: { text: "barbaro await" },
      },
    },
    lease({ workstream_id: "ws_short" }),
    lease({
      current_action: {
        kind: "tool",
        command: { text: "barbaro await" },
      },
    }),
  ];
  for (const input of inputs) {
    assert.deepEqual(projectReaderDependencyLease(input), { state: "waiting" });
  }
});

test("missing or invalid action start omits both start and deadline", () => {
  for (const started_at of [
    undefined,
    "not-a-time",
    "2026-02-30T06:00:00Z",
    `2026-08-25T06:00:00.${"0".repeat(80)}Z`,
  ]) {
    const result = projectReaderDependencyLease(
      lease({
        current_action: {
          kind: "command",
          command: { text: "barbaro await --timeout-ms 120000" },
          ...(started_at === undefined ? {} : { started_at }),
        },
      }),
    );
    assert.ok(result.dependency);
    assert.equal(result.dependency.started_at, undefined);
    assert.equal(result.dependency.deadline_at, undefined);
  }
});

test("attention audience normalization is exact and deterministic", () => {
  for (const audience of [
    "user",
    "peer",
    "system",
    "external",
    "unknown",
  ] as const) {
    assert.deepEqual(normalizeReaderAttentionAudience(audience), { audience });
  }

  for (const source of [undefined, null, 1, { audience: "user" }]) {
    assert.deepEqual(normalizeReaderAttentionAudience(source), {
      audience: "unknown",
    });
  }

  const unrecognized = normalizeReaderAttentionAudience("USER");
  assert.deepEqual(unrecognized, {
    audience: "unknown",
    unknown_source: {
      text: "USER",
      truncated: false,
      utf8_bytes: { shown: 4, original: 4 },
    },
  });
  assert.deepEqual(
    normalizeReaderAttentionAudience("USER"),
    unrecognized,
  );
});

test("unknown audience source is UTF-8 safe and byte bounded", () => {
  const source = `${"x".repeat(127)}💡tail`;
  const normalized = normalizeReaderAttentionAudience(source);
  assert.equal(normalized.audience, "unknown");
  assert.ok(normalized.unknown_source);
  assert.equal(normalized.unknown_source.text, "x".repeat(127));
  assert.equal(normalized.unknown_source.truncated, true);
  assert.equal(normalized.unknown_source.utf8_bytes.shown, 127);
  assert.equal(
    normalized.unknown_source.utf8_bytes.original,
    Buffer.byteLength(source, "utf8"),
  );
  assert.ok(
    normalized.unknown_source.utf8_bytes.shown <=
      READER_UNKNOWN_AUDIENCE_SOURCE_BYTES,
  );
});

test("viewer identity requires exact provider and full session identity", () => {
  const valid = { provider: "codex", session_id: SESSION_ID };
  assert.deepEqual(normalizeExplicitViewerIdentity(valid), valid);

  for (const invalid of [
    undefined,
    null,
    {},
    { provider: "codex" },
    { session_id: SESSION_ID },
    { provider: "Codex", session_id: SESSION_ID },
    { provider: "codex", session_id: "01234567" },
    { provider: "codex", session_id: SESSION_ID.toUpperCase() },
    { provider: "codex", session_id: SESSION_ID, label: "me" },
    { provider: "p".repeat(65), session_id: SESSION_ID },
  ]) {
    assert.equal(normalizeExplicitViewerIdentity(invalid), undefined);
  }
});

test("viewer matching is explicit and compares the full identity", () => {
  const viewer = normalizeExplicitViewerIdentity({
    provider: "codex",
    session_id: SESSION_ID,
  });
  assert.ok(viewer);
  assert.equal(readerViewerMatches(viewer, viewer), true);
  assert.equal(
    readerViewerMatches(viewer, {
      provider: "claude",
      session_id: SESSION_ID,
    }),
    false,
  );
  assert.equal(
    readerViewerMatches(viewer, {
      provider: "codex",
      session_id: "ses_0123456789abcdef0123456789abcdee",
    }),
    false,
  );
  assert.equal(readerViewerMatches(undefined, viewer), undefined);
  assert.equal(JSON.stringify({ viewer }).includes("you"), false);
  assert.equal(JSON.stringify({ viewer }).includes("me"), false);
});
