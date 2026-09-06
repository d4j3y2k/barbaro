import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActiveLeaseStore } from "../../src/active/store.js";
import type {
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";
import {
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../../src/core/safe-store.js";
import { stableJsonLine } from "../../src/core/stable-json.js";
import {
  ReaderEvidenceNotFoundError,
  ReaderRecordTooLargeError,
  readProjectContext,
  readProjectEvidence,
} from "../../src/reader/store.js";

const SESSION_ID = "ses_11111111111111111111111111111111";
const SOURCE_REF = { trace_id: "fixture:reader-store" } as const;

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function turn(sequence: number, endedAt: string): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${sequence.toString(16).padStart(32, "0")}`,
    provider: "codex",
    session_id: SESSION_ID,
    sequence,
    agent_id: "root",
    started_at: "2026-08-16T20:00:00.000Z",
    ended_at: endedAt,
    outcome: "success",
    request: content(`request ${sequence}`),
    response: content(`response ${sequence}`),
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [SOURCE_REF],
  };
}

async function createFeedProject(): Promise<{
  readonly project: string;
  readonly feedPath: string;
}> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-project-"));
  const directory = join(project, ".barbaro", "feed", "codex");
  await mkdir(directory, { recursive: true });
  return { project, feedPath: join(directory, `${SESSION_ID}.jsonl`) };
}

test("context never shows expired or idle leases, only live ones", async () => {
  // The reader is the layer every consumer trusts; if it passed stale leases
  // through, each caller would have to re-implement expiry, and the ones that
  // forgot would coordinate against ghosts.
  const { project } = await createFeedProject();
  try {
    const activeStore = new ActiveLeaseStore(
      join(project, ".barbaro", "active"),
      { clock: () => new Date("2026-08-16T20:00:00.000Z") },
    );
    const base = {
      provider: "codex",
      session_id: SESSION_ID,
      agent_id: "root",
      state: "working",
      claims: [],
      unknown_write_scope: false,
    } as const;
    await activeStore.write(
      { ...base, lease_id: "lease_33333333333333333333333333333333" },
      { ttlMs: 30_000 },
    );
    await activeStore.write(
      {
        ...base,
        lease_id: "lease_44444444444444444444444444444444",
        agent_id: "durable",
      },
      { ttlMs: 3_600_000 },
    );
    await activeStore.writeIdle({
      ...base,
      lease_id: "lease_55555555555555555555555555555555",
      agent_id: "settled",
    });

    // 20:01: the 30-second lease has expired, the idle actor is a tombstone,
    // and only the hour-long lease is a live peer.
    const context = await readProjectContext(project, {
      byteBudget: 12_000,
      now: "2026-08-16T20:01:00.000Z",
    });
    assert.equal(context.value.active.total, 1);
    assert.equal(context.value.active.items[0]?.agent_id, "durable");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("context reads live leases and newest completed turns without rewriting", async () => {
  const { project, feedPath } = await createFeedProject();
  try {
    const records = [
      turn(1, "2026-08-16T20:01:00.000Z"),
      turn(2, "2026-08-16T20:02:00.000Z"),
      turn(3, "2026-08-16T20:03:00.000Z"),
    ];
    await writeFile(
      feedPath,
      `${records.map(stableJsonLine).join("")}{"schema":"barbaro.turn.v1"`,
      "utf8",
    );
    const activeStore = new ActiveLeaseStore(
      join(project, ".barbaro", "active"),
      { clock: () => new Date("2026-08-16T20:03:30.000Z") },
    );
    await activeStore.write(
      {
        lease_id: "lease_22222222222222222222222222222222",
        provider: "codex",
        session_id: SESSION_ID,
        turn_id: records[2]!.turn_id,
        agent_id: "root",
        state: "working",
        intent: content("implement reader"),
        claims: [
          { path: "src/reader/store.ts", mode: "write", confidence: "exact" },
        ],
        unknown_write_scope: false,
      },
      { ttlMs: 60_000 },
    );
    const before = await readFile(feedPath);
    const options = {
      byteBudget: 12_000,
      turnsPerSession: 2,
      now: "2026-08-16T20:03:45.000Z",
    } as const;
    const first = await readProjectContext(project, options);
    const replay = await readProjectContext(project, options);

    assert.deepEqual(replay, first);
    assert.equal(first.value.active.total, 1);
    assert.equal(first.value.active.shown, 1);
    assert.equal(first.value.active.items[0]?.state, "working");
    assert.equal(first.value.turns.total, 2);
    assert.deepEqual(
      first.value.turns.items.map((item) => item.sequence),
      [3, 2],
    );
    assert.equal(first.value.diagnostics.partial_feed_files, 1);
    assert.deepEqual(await readFile(feedPath), before);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a five-of-eight context window reports incomplete history even when all selected turns fit", async (t) => {
  const { project, feedPath } = await createFeedProject();
  t.after(() => rm(project, { recursive: true, force: true }));
  const workstreamId = `ws_${"a".repeat(32)}`;
  const records = Array.from({ length: 8 }, (_, i) => ({
    ...turn(i + 1, `2026-08-16T20:0${i + 1}:00.000Z`),
    workstream_id: workstreamId,
  }));
  await writeFile(feedPath, records.map(stableJsonLine).join(""));
  const context = await readProjectContext(project, {
    byteBudget: 16_384, turnsPerSession: 5, workstreamId,
  });
  assert.deepEqual(context.value.turns.items.map((item) => item.sequence), [8, 7, 6, 5, 4]);
  assert.equal(context.value.turns.shown, 5);
  assert.equal(context.value.turns.total, 5);
  assert.deepEqual(context.value.coverage, {
    history: { state: "limited", reasons: ["history_window"] },
    selection: { policy: "newest_within_scope_per_session", turns_per_session: 5 },
    window_limited_feed_files: 1,
    projection_omitted_turns: 0,
    attention_truncated_turns: 0,
  });
  assert.match(context.value.turn_retrieval_hint ?? "", /same project and workstream/u);
});

test("scope selection finds newest turns in the old workstream after a session moves", async (t) => {
  const { project, feedPath } = await createFeedProject();
  t.after(() => rm(project, { recursive: true, force: true }));
  const workstreamId = `ws_${"a".repeat(32)}`;
  const otherWorkstreamId = `ws_${"b".repeat(32)}`;
  const records = Array.from({ length: 12 }, (_, i) => ({
    ...turn(i + 1, new Date(Date.UTC(2026, 7, 16, 20, i + 1)).toISOString()),
    workstream_id: i < 5 ? workstreamId : otherWorkstreamId,
  }));
  await writeFile(feedPath, records.map(stableJsonLine).join(""));
  const context = await readProjectContext(project, {
    byteBudget: 16_384, turnsPerSession: 5, workstreamId,
  });
  assert.deepEqual(context.value.turns.items.map((item) => item.sequence), [5, 4, 3, 2, 1]);
  assert.deepEqual(context.value.coverage.history, { state: "complete", reasons: [] });
  assert.equal(context.value.coverage.window_limited_feed_files, 0);
  assert.equal(context.value.turn_retrieval_hint, undefined);

  const bounded = await readProjectContext(project, {
    byteBudget: 16_384, turnsPerSession: 5, workstreamId,
    maxScanBytesPerFile: Buffer.byteLength(records.slice(-3).map(stableJsonLine).join("")),
  });
  assert.equal(bounded.value.turns.shown, 0);
  assert.equal(bounded.value.turns.total, 0);
  assert.deepEqual(bounded.value.coverage.history, { state: "limited", reasons: ["scan_limit"] });
  assert.ok(bounded.value.turn_retrieval_hint);
});

test("projection omissions are distinct from a fully scanned context history", async (t) => {
  const { project, feedPath } = await createFeedProject();
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(feedPath, Array.from({ length: 4 }, (_, i) => (
    stableJsonLine(turn(i + 1, `2026-08-16T20:0${i + 1}:00.000Z`))
  )).join(""));
  const context = await readProjectContext(project, { byteBudget: 2000 });
  assert.equal(context.value.coverage.history.state, "complete");
  assert.ok(context.value.coverage.projection_omitted_turns > 0);
  assert.equal(context.value.coverage.projection_omitted_turns, 4 - context.value.turns.shown);
  assert.ok(context.utf8_bytes <= 2000);
  assert.ok(context.value.turn_retrieval_hint);
});

test("evidence is loaded only by an exact evidence_ref and remains canonical", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-evidence-"));
  const directory = join(project, ".barbaro", "evidence", "codex");
  const evidenceId = "ev_33333333333333333333333333333333";
  const evidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: evidenceId,
    kind: "provider_event",
    turn_id: "turn_44444444444444444444444444444444",
    provider: "codex",
    session_id: SESSION_ID,
    agent_id: "root",
    occurred_at: "2026-08-16T20:04:00.000Z",
    source_refs: [SOURCE_REF],
    content: { message: "😀 evidence ".repeat(100) },
  };
  try {
    await mkdir(directory, { recursive: true });
    const evidencePath = join(directory, `${SESSION_ID}.jsonl`);
    await writeFile(evidencePath, stableJsonLine(evidence), "utf8");
    const before = await readFile(evidencePath);
    const projected = await readProjectEvidence(project, {
      provider: "codex",
      sessionId: SESSION_ID,
      evidenceId,
      byteBudget: 1200,
      responseExcerptBytes: 128,
    });
    assert.equal(projected.value.evidence_id, evidenceId);
    assert.ok("truncated" in projected.value.content);
    assert.equal(projected.value.content.truncated, true);
    assert.deepEqual(await readFile(evidencePath), before);

    await assert.rejects(
      readProjectEvidence(project, {
        provider: "codex",
        sessionId: SESSION_ID,
        evidenceId: "ev_55555555555555555555555555555555",
        byteBudget: 1200,
      }),
      (error: unknown) => error instanceof ReaderEvidenceNotFoundError,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("projected evidence enforces workstream scope before projection", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-evidence-scope-"));
  const directory = join(project, ".barbaro", "evidence", "codex");
  const evidenceId = "ev_66666666666666666666666666666666";
  const owningWorkstream = "ws_77777777777777777777777777777777";
  const otherWorkstream = "ws_88888888888888888888888888888888";
  const evidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: evidenceId,
    kind: "subagent_turn",
    turn_id: "turn_99999999999999999999999999999999",
    parent_turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parent_link: { method: "native", native_key: "worker-1" },
    provider: "codex",
    session_id: SESSION_ID,
    workstream_id: owningWorkstream,
    agent_id: "worker-1",
    occurred_at: "2026-08-16T20:04:00.000Z",
    source_refs: [SOURCE_REF],
    content: {
      role: "worker",
      sequence: 1,
      outcome: "success",
      started_at: "2026-08-16T20:03:00.000Z",
      ended_at: "2026-08-16T20:04:00.000Z",
      request: content("inspect"),
      response: content("done"),
      actions: [],
    },
  };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${SESSION_ID}.jsonl`),
      stableJsonLine(evidence),
      "utf8",
    );

    await assert.rejects(
      readProjectEvidence(project, {
        provider: "codex",
        sessionId: SESSION_ID,
        evidenceId,
        workstreamId: otherWorkstream,
        byteBudget: 1,
        actionCursor: "not-an-action-cursor",
      }),
      (error: unknown) => error instanceof ReaderEvidenceNotFoundError,
    );
    const projected = await readProjectEvidence(project, {
      provider: "codex",
      sessionId: SESSION_ID,
      evidenceId,
      workstreamId: owningWorkstream,
      byteBudget: 1200,
    });
    assert.equal(projected.value.workstream_id, owningWorkstream);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("canonical readers reject symlinks, hard links, and oversized files", async (t) => {
  await t.test("final symlink", async () => {
    const { project, feedPath } = await createFeedProject();
    const outside = await mkdtemp(join(tmpdir(), "barbaro-reader-outside-"));
    try {
      const target = join(outside, "turns.jsonl");
      await writeFile(target, stableJsonLine(turn(1, "2026-08-16T20:01:00.000Z")));
      await symlink(target, feedPath, "file");
      await assert.rejects(
        readProjectContext(project, { byteBudget: 4096 }),
        (error: unknown) => error instanceof UnsafeStorePathError,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("multiple hard links", async () => {
    const { project, feedPath } = await createFeedProject();
    const outside = await mkdtemp(join(tmpdir(), "barbaro-reader-hardlink-"));
    try {
      const target = join(outside, "turns.jsonl");
      await writeFile(target, stableJsonLine(turn(1, "2026-08-16T20:01:00.000Z")));
      await link(target, feedPath);
      await assert.rejects(
        readProjectContext(project, { byteBudget: 4096 }),
        (error: unknown) => error instanceof UnsafeStorePathError,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("oversized file", async () => {
    const { project, feedPath } = await createFeedProject();
    try {
      await writeFile(feedPath, "x".repeat(1024));
      const result = await readProjectContext(project, {
          byteBudget: 4096,
          maxFileBytes: 128,
        });
      assert.equal(result.value.coverage.history.state, "limited");
      assert.deepEqual(result.value.coverage.history.reasons, ["unavailable_feed"]);
      assert.equal(result.value.diagnostics.feed_coverage?.unavailable.items[0]?.reason, "file_too_large");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  await t.test("oversized canonical record", async () => {
    const { project, feedPath } = await createFeedProject();
    try {
      const large = turn(1, "2026-08-16T20:01:00.000Z");
      const record = {
        ...large,
        response: content("x".repeat(1024)),
      };
      await writeFile(feedPath, stableJsonLine(record));
      const result = await readProjectContext(project, {
          byteBudget: 4096,
          maxRecordBytes: 256,
        });
      assert.equal(result.value.coverage.history.state, "limited");
      assert.equal(result.value.diagnostics.feed_coverage?.unavailable.items[0]?.reason, "record_too_large");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  await t.test("active snapshot hard link", async () => {
    const project = await mkdtemp(join(tmpdir(), "barbaro-reader-active-link-"));
    const outside = await mkdtemp(join(tmpdir(), "barbaro-reader-active-outside-"));
    try {
      const store = new ActiveLeaseStore(join(project, ".barbaro", "active"), {
        clock: () => new Date("2026-08-16T20:00:00.000Z"),
      });
      const actor = {
        provider: "codex",
        session_id: SESSION_ID,
        agent_id: "root",
      } as const;
      await store.write(
        {
          ...actor,
          lease_id: "lease_66666666666666666666666666666666",
          state: "working",
          claims: [],
          unknown_write_scope: false,
        },
        { ttlMs: 60_000 },
      );
      await link(store.actorPath(actor), join(outside, "lease.json"));
      await assert.rejects(
        readProjectContext(project, {
          byteBudget: 4096,
          now: "2026-08-16T20:00:01.000Z",
        }),
        (error: unknown) => error instanceof UnsafeStorePathError,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("a scoped context keeps only records stamped with the workstream", async () => {
  const { project, feedPath } = await createFeedProject();
  const NOW = "2026-08-16T20:05:00.000Z";
  try {
    const ws = "ws_0123456789abcdef0123456789abcdef";
    const other = "ws_fedcba9876543210fedcba9876543210";
    await writeFile(
      feedPath,
      [
        stableJsonLine({ ...turn(1, "2026-08-16T20:01:00.000Z"), workstream_id: ws }),
        stableJsonLine({ ...turn(2, "2026-08-16T20:02:00.000Z"), workstream_id: other }),
        stableJsonLine(turn(3, "2026-08-16T20:03:00.000Z")),
      ].join(""),
      "utf8",
    );
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    await store.write(
      {
        lease_id: `lease_${"1".repeat(32)}`,
        provider: "codex",
        session_id: SESSION_ID,
        workstream_id: ws,
        agent_id: "root",
        state: "working",
        claims: [],
        unknown_write_scope: false,
      },
      { now: NOW },
    );
    await store.write(
      {
        lease_id: `lease_${"2".repeat(32)}`,
        provider: "codex",
        session_id: SESSION_ID,
        agent_id: "helper",
        state: "working",
        claims: [],
        unknown_write_scope: false,
      },
      { now: NOW },
    );

    const scoped = await readProjectContext(project, {
      byteBudget: 65_536,
      now: NOW,
      workstreamId: ws,
    });
    assert.equal(scoped.value.workstream_id, ws);
    assert.deepEqual(scoped.value.turns.items.map((item) => item.sequence), [1]);
    assert.deepEqual(scoped.value.active.items.map((item) => item.agent_id), ["root"]);

    const wide = await readProjectContext(project, { byteBudget: 65_536, now: NOW });
    assert.equal(wide.value.workstream_id, undefined);
    assert.deepEqual(wide.value.turns.items.map((item) => item.sequence), [3, 2, 1]);
    assert.equal(wide.value.active.items.length, 2);

    await assert.rejects(
      readProjectContext(project, { byteBudget: 65_536, workstreamId: "nope" }),
      TypeError,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
