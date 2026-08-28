import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSessionId, createTurnId } from "../../src/core/id.js";
import { stableJsonUtf8Bytes } from "../../src/reader/budget.js";
import {
  readProjectContext,
  readProjectStoreHealth,
} from "../../src/reader/index.js";
import type {
  ReaderProviderDriftDiagnostic,
  ReaderStoreDiagnostics,
} from "../../src/reader/types.js";
import { snapshotTree } from "../setup/fixture.js";

const SESSION_ID = "ses_11111111111111111111111111111111";
const SECOND_SESSION_ID = "ses_22222222222222222222222222222222";
const WORKSTREAM_ID = "ws_22222222222222222222222222222222";
const ACTOR_FILE = `actor_${"3".repeat(64)}.json`;
const PROVIDER_STATE_FILE = `${"4".repeat(32)}.json`;

const OPTIONS = {
  byteBudget: 64 * 1024,
  now: "2026-08-25T04:00:00.000Z",
  maxSourceEntries: 256,
} as const;

interface CollectionLike {
  readonly items: readonly unknown[];
  readonly shown: number;
  readonly total: number;
  readonly hidden: number;
  readonly read_state: "ok" | "degraded" | "refused";
  readonly coverage: {
    readonly state: "complete" | "limited" | "refused";
    readonly reason?: string;
  };
}

function assertCollection(collection: CollectionLike): void {
  assert.equal(collection.shown, collection.items.length);
  assert.equal(collection.hidden, collection.total - collection.shown);
  assert.ok(collection.shown >= 0);
  assert.ok(collection.hidden >= 0);
  assert.ok(collection.shown <= collection.total);
  assert.ok(["ok", "degraded", "refused"].includes(collection.read_state));
  assert.ok(["complete", "limited", "refused"].includes(collection.coverage.state));
}

async function temporaryProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-health-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function writeRelative(
  project: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const path = join(project, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function assertZeroHealthDiagnostics(
  diagnostics: ReaderStoreDiagnostics,
): void {
  assert.equal(diagnostics.feed_files, 0);
  assert.equal(diagnostics.malformed_feed_records, 0);
  assert.equal(diagnostics.invalid_feed_records, 0);
  assert.equal(diagnostics.partial_feed_files, 0);
  assert.equal(diagnostics.scan_limited_feed_files, 0);
  assert.equal(diagnostics.invalid_active_records, 0);
  assert.equal(diagnostics.invalid_workstream_records, 0);
  assert.equal(diagnostics.invalid_participation_records, 0);
  assert.equal(diagnostics.invalid_cursor_records, 0);
  assert.equal(diagnostics.invalid_journal_records, 0);
  assert.equal(diagnostics.invalid_provider_state_records, 0);
  assertCollection(diagnostics.provider_drift);
  assert.equal(diagnostics.provider_drift.total, 0);
}

function validTurn(provider: string, sessionId: string): object {
  return {
    schema: "barbaro.turn.v1",
    turn_id: "turn_55555555555555555555555555555555",
    provider,
    session_id: sessionId,
    sequence: 1,
    agent_id: "root",
    started_at: "2026-08-25T03:58:00.000Z",
    ended_at: "2026-08-25T03:59:00.000Z",
    outcome: "success",
    request: {
      text: "fixture",
      fidelity: "verbatim",
      truncated: false,
      original_utf8_bytes: 7,
      redactions: [],
    },
    response: {
      text: "done",
      fidelity: "verbatim",
      truncated: false,
      original_utf8_bytes: 4,
      redactions: [],
    },
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [{ trace_id: "fixture:reader-health" }],
  };
}

function validJournal(provider: string, sessionId: string): object {
  return {
    schema: "barbaro.ingest-attempt-journal.v2",
    provider,
    session_id: sessionId,
    dropped_attempts: 0,
    attempts: [
      {
        attempt_id: "attempt-1",
        event: "Stop",
        triggered_at: "2026-08-25T03:58:00.000Z",
        pid: 1,
        started_at: "2026-08-25T03:58:00.000Z",
        observations: {
          count: 0,
          first: null,
          last: null,
          size_transitions: [],
          dropped_transitions: 0,
        },
        checkpoint_before: null,
        checkpoint_after: null,
        turns_appended: 0,
        pending_background_ids: [],
        pending_agent_ids: [],
        finished_at: "2026-08-25T03:59:00.000Z",
        outcome: "ok",
      },
    ],
  };
}

function validCheckpoint(): object {
  return {
    schema: "barbaro.jsonl-checkpoint.v1",
    file_identity: { device: "1", inode: "2", birthtime_ns: "3" },
    byte_offset: 0,
    next_line_number: 1,
    observed_size: 0,
    anchor: { byte_length: 0, sha256: "0".repeat(64) },
  };
}

test("store health reports absence without creating or changing the project", async () => {
  await temporaryProject(async (project) => {
    const before = await readdir(project);
    const first = await readProjectStoreHealth(project, OPTIONS);
    const replay = await readProjectStoreHealth(project, OPTIONS);

    assert.deepEqual(replay, first);
    assert.equal(stableJsonUtf8Bytes(first), first.utf8_bytes);
    assert.ok(first.utf8_bytes <= first.byte_budget);
    assert.deepEqual(await readdir(project), before);
    await assert.rejects(readFile(join(project, ".barbaro")), {
      code: "ENOENT",
    });

    assert.equal(first.value.presence, "absent");
    assert.equal(first.value.read_state, "ok");
    assert.equal(first.value.healthy, false);
    assert.deepEqual(first.value.coverage, { state: "complete" });
    assertZeroHealthDiagnostics(first.value.diagnostics);
  });
});

test("an existing empty store is present, completely scanned, and healthy", async () => {
  await temporaryProject(async (project) => {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const before = await readdir(join(project, ".barbaro"));

    const health = await readProjectStoreHealth(project, OPTIONS);

    assert.deepEqual(await readdir(join(project, ".barbaro")), before);
    assert.equal(health.value.presence, "present");
    assert.equal(health.value.read_state, "ok");
    assert.equal(health.value.healthy, true);
    assert.deepEqual(health.value.coverage, { state: "complete" });
    assertZeroHealthDiagnostics(health.value.diagnostics);
  });
});

test("invalid canonical records are diagnosed by source and prevent healthy", async () => {
  await temporaryProject(async (project) => {
    const invalid = '{"schema":"barbaro.invalid.v1"}\n';
    await Promise.all([
      writeRelative(
        project,
        `.barbaro/workstreams/${WORKSTREAM_ID}.json`,
        invalid,
      ),
      writeRelative(
        project,
        `.barbaro/sessions/codex/${SESSION_ID}.json`,
        invalid,
      ),
      writeRelative(
        project,
        `.barbaro/state/nudge/codex/${SESSION_ID}.json`,
        invalid,
      ),
      writeRelative(
        project,
        `.barbaro/logs/ingest/codex/${SESSION_ID}.json`,
        invalid,
      ),
      writeRelative(
        project,
        `.barbaro/state/codex/${PROVIDER_STATE_FILE}`,
        invalid,
      ),
      writeRelative(
        project,
        `.barbaro/feed/codex/${SESSION_ID}.jsonl`,
        invalid,
      ),
      writeRelative(
        project,
        `.barbaro/active/codex/${ACTOR_FILE}`,
        invalid,
      ),
    ]);

    const health = await readProjectStoreHealth(project, OPTIONS);
    const diagnostics = health.value.diagnostics;

    assert.equal(health.value.presence, "present");
    assert.equal(health.value.read_state, "degraded");
    assert.equal(health.value.healthy, false);
    assert.deepEqual(health.value.coverage, { state: "complete" });
    assert.equal(diagnostics.feed_files, 1);
    assert.equal(diagnostics.invalid_feed_records, 1);
    assert.equal(diagnostics.invalid_active_records, 1);
    assert.equal(diagnostics.invalid_workstream_records, 1);
    assert.equal(diagnostics.invalid_participation_records, 1);
    assert.equal(diagnostics.invalid_cursor_records, 1);
    assert.equal(diagnostics.invalid_journal_records, 1);
    assert.equal(diagnostics.invalid_provider_state_records, 1);
    assertCollection(diagnostics.provider_drift);
    assert.equal(diagnostics.provider_drift.read_state, "degraded");
    assert.equal(diagnostics.provider_drift.total, 0);
  });
});

test("journal health accepts complete v2 only and diagnoses shallow impostors", async () => {
  await temporaryProject(async (project) => {
    const valid = validJournal("codex", SESSION_ID);
    const incomplete = validJournal("codex", SECOND_SESSION_ID) as {
      attempts: Array<Record<string, unknown>>;
    };
    delete incomplete.attempts[0]!.observations;
    await Promise.all([
      writeRelative(
        project,
        `.barbaro/logs/ingest/codex/${SESSION_ID}.json`,
        `${JSON.stringify(valid)}\n`,
      ),
      writeRelative(
        project,
        `.barbaro/logs/ingest/codex/${SECOND_SESSION_ID}.json`,
        `${JSON.stringify(incomplete)}\n`,
      ),
    ]);

    const health = await readProjectStoreHealth(project, OPTIONS);

    assert.equal(health.value.presence, "present");
    assert.equal(health.value.read_state, "degraded");
    assert.equal(health.value.coverage.state, "complete");
    assert.equal(health.value.diagnostics.invalid_journal_records, 1);
    assert.equal(health.value.diagnostics.provider_drift.total, 0);
  });
});

test("health preserves the existing newest-N reader diagnostics", async () => {
  await temporaryProject(async (project) => {
    const lines = [
      "{not-json}",
      ...Array.from({ length: 6 }, () =>
        JSON.stringify(validTurn("codex", SESSION_ID)),
      ),
    ];
    await writeRelative(
      project,
      `.barbaro/feed/codex/${SESSION_ID}.jsonl`,
      `${lines.join("\n")}\n`,
    );

    const context = await readProjectContext(project, {
      byteBudget: OPTIONS.byteBudget,
      now: OPTIONS.now,
      turnsPerSession: 5,
    });
    const health = await readProjectStoreHealth(project, {
      ...OPTIONS,
      turnsPerSession: 5,
    });
    const base = health.value.diagnostics;

    assert.deepEqual(
      {
        feed_files: base.feed_files,
        malformed_feed_records: base.malformed_feed_records,
        invalid_feed_records: base.invalid_feed_records,
        partial_feed_files: base.partial_feed_files,
        scan_limited_feed_files: base.scan_limited_feed_files,
        invalid_active_records: base.invalid_active_records,
      },
      context.value.diagnostics,
    );
    assert.equal(base.malformed_feed_records, 0);

    const wider = await readProjectStoreHealth(project, {
      ...OPTIONS,
      turnsPerSession: 10,
    });
    assert.equal(wider.value.diagnostics.malformed_feed_records, 1);
  });
});

test("source-entry and file-size limits never collapse incomplete health to healthy", async () => {
  await temporaryProject(async (project) => {
    const invalid = '{"schema":"barbaro.invalid.v1"}\n';
    await writeRelative(
      project,
      `.barbaro/workstreams/${WORKSTREAM_ID}.json`,
      invalid,
    );
    await writeRelative(
      project,
      `.barbaro/workstreams/ws_${"9".repeat(32)}.json`,
      invalid,
    );

    const entryLimited = await readProjectStoreHealth(project, {
      ...OPTIONS,
      maxSourceEntries: 1,
    });

    assert.equal(entryLimited.value.presence, "present");
    assert.notEqual(entryLimited.value.read_state, "ok");
    assert.equal(entryLimited.value.healthy, false);
    assert.equal(entryLimited.value.coverage.state, "limited");
    assert.equal(
      entryLimited.value.diagnostics.invalid_workstream_records,
      1,
    );
  });

  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/feed/codex/${SESSION_ID}.jsonl`,
      "x".repeat(65),
    );

    const oversized = await readProjectStoreHealth(project, {
      ...OPTIONS,
      maxFileBytes: 64,
    });

    assert.equal(oversized.value.presence, "present");
    assert.notEqual(oversized.value.read_state, "ok");
    assert.equal(oversized.value.healthy, false);
    assert.notEqual(oversized.value.coverage.state, "complete");
  });

  await temporaryProject(async (project) => {
    const path = join(
      project,
      ".barbaro",
      "state",
      "codex",
      PROVIDER_STATE_FILE,
    );
    await writeRelative(
      project,
      `.barbaro/state/codex/${PROVIDER_STATE_FILE}`,
      "",
    );
    await truncate(path, 64 * 1024 * 1024 + 1);

    const oversized = await readProjectStoreHealth(project, {
      ...OPTIONS,
      maxFileBytes: 128 * 1024 * 1024,
    });

    assert.equal(oversized.value.presence, "present");
    assert.equal(oversized.value.read_state, "refused");
    assert.equal(oversized.value.healthy, false);
    assert.equal(oversized.value.coverage.state, "refused");
  });
});

test("a symlinked store root is present but refused and never followed", async () => {
  const outside = await mkdtemp(join(tmpdir(), "barbaro-reader-health-outside-"));
  try {
    await writeFile(join(outside, "sentinel"), "outside\n", "utf8");
    await temporaryProject(async (project) => {
      await symlink(outside, join(project, ".barbaro"), "dir");

      const health = await readProjectStoreHealth(project, OPTIONS);

      assert.equal(health.value.presence, "present");
      assert.equal(health.value.read_state, "refused");
      assert.equal(health.value.healthy, false);
      assert.equal(health.value.coverage.state, "refused");
      assert.match(health.value.coverage.reason ?? "", /unsafe|symbolic|symlink/iu);
      assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside\n");
      assert.deepEqual(await readdir(outside), ["sentinel"]);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a hard-linked canonical source is refused rather than read as healthy", async () => {
  const outside = await mkdtemp(join(tmpdir(), "barbaro-reader-health-hardlink-"));
  try {
    const sentinel = join(outside, "sentinel.jsonl");
    await writeFile(sentinel, '{"schema":"barbaro.invalid.v1"}\n', "utf8");
    await temporaryProject(async (project) => {
      const feedPath = join(
        project,
        ".barbaro",
        "feed",
        "codex",
        `${SESSION_ID}.jsonl`,
      );
      await mkdir(dirname(feedPath), { recursive: true });
      await link(sentinel, feedPath);
      const before = await readFile(sentinel);

      const health = await readProjectStoreHealth(project, OPTIONS);

      assert.equal(health.value.presence, "present");
      assert.notEqual(health.value.read_state, "ok");
      assert.equal(health.value.healthy, false);
      assert.notEqual(health.value.coverage.state, "complete");
      assert.deepEqual(await readFile(sentinel), before);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a structurally valid feed identity mismatch is provider drift", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/feed/codex/${SESSION_ID}.jsonl`,
      `${JSON.stringify(validTurn("claude", SESSION_ID))}\n`,
    );

    const health = await readProjectStoreHealth(project, OPTIONS);
    const drift = health.value.diagnostics.provider_drift;

    assert.equal(health.value.presence, "present");
    assert.equal(health.value.read_state, "degraded");
    assert.equal(health.value.healthy, false);
    assertCollection(drift);
    assert.equal(drift.total, 1);
    assert.deepEqual(
      drift.items.map(
        ({
          source,
          kind,
          count,
          provider,
          session_id,
        }: ReaderProviderDriftDiagnostic) => ({
          source,
          kind,
          count,
          provider,
          session_id,
        }),
      ),
      [
        {
          source: "feed",
          kind: "identity_path_mismatch",
          count: 1,
          provider: "codex",
          session_id: SESSION_ID,
        },
      ],
    );
  });
});

test("Claude runner state is included in provider-state health", async () => {
  await temporaryProject(async (project) => {
    const state = {
      schema: "barbaro.claude-runner-state.v1",
      trace_id: "claude:native-session:main",
      native_session_id: "native-session",
      actor_id: "main",
      checkpoint: validCheckpoint(),
      workspace_root: project,
    };
    const path = `.barbaro/state/claude/${PROVIDER_STATE_FILE}`;
    await writeRelative(project, path, `${JSON.stringify(state)}\n`);

    const valid = await readProjectStoreHealth(project, OPTIONS);

    assert.equal(valid.value.read_state, "ok");
    assert.equal(valid.value.healthy, true);
    assert.equal(valid.value.diagnostics.invalid_provider_state_records, 0);

    await writeRelative(
      project,
      path,
      `${JSON.stringify({ ...state, trace_id: "claude:other:main" })}\n`,
    );
    const mismatched = await readProjectStoreHealth(project, OPTIONS);

    assert.equal(mismatched.value.read_state, "degraded");
    assert.equal(mismatched.value.healthy, false);
    assert.equal(mismatched.value.diagnostics.invalid_provider_state_records, 1);
    assert.deepEqual(mismatched.value.diagnostics.provider_drift.items, [
      {
        source: "claude_state",
        kind: "identity_path_mismatch",
        provider: "claude",
        count: 1,
      },
    ]);
  });
});

test("Codex state rejects under-specified serialized turns", async () => {
  await temporaryProject(async (project) => {
    const nativeSessionId = "native-session";
    const nativeThreadId = "native-thread";
    const nativeTurnId = "native-turn";
    const actorId = "main";
    const state = {
      schema: "barbaro.codex-runner-state.v1",
      trace_id: `codex:${nativeSessionId}:thread:${nativeThreadId}`,
      checkpoint: validCheckpoint(),
      normalizer: {
        schema: "barbaro.codex-normalizer-state.v1",
        session: {
          nativeSessionId,
          nativeThreadId,
          barbaroSessionId: createSessionId("codex", nativeSessionId),
          actorId,
          workspaceRoot: project,
          historyMode: "paginated",
        },
        current_turn_id: nativeTurnId,
        next_sequence: 2,
        turns: [
          {
            nativeTurnId,
            barbaroTurnId: createTurnId(
              "codex",
              nativeSessionId,
              actorId,
              nativeTurnId,
            ),
            sequence: 1,
            agentId: actorId,
            evidenceIds: [],
            pendingCalls: [],
            subagents: [],
          },
        ],
        diagnostics: {
          records: 1,
          invalid_envelopes: 0,
          unknown_root_types: {},
          unknown_event_types: {},
          unknown_response_types: {},
          repeated_session_meta: 0,
          orphan_turn_records: 0,
        },
      },
    };
    await writeRelative(
      project,
      `.barbaro/state/codex/${PROVIDER_STATE_FILE}`,
      `${JSON.stringify(state)}\n`,
    );

    const health = await readProjectStoreHealth(project, OPTIONS);

    assert.equal(health.value.read_state, "degraded");
    assert.equal(health.value.healthy, false);
    assert.equal(health.value.diagnostics.invalid_provider_state_records, 1);
    assert.equal(health.value.diagnostics.provider_drift.read_state, "degraded");

    const turn = state.normalizer.turns[0] as Record<string, unknown>;
    turn.startedAt = "2026-08-25T03:58:00.000Z";
    turn.startSource = {
      traceId: state.trace_id,
      lineNumber: 1,
      byteStart: 0,
      byteEndExclusive: 1,
    };
    turn.actions = [];
    await writeRelative(
      project,
      `.barbaro/state/codex/${PROVIDER_STATE_FILE}`,
      `${JSON.stringify(state)}\n`,
    );
    const complete = await readProjectStoreHealth(project, OPTIONS);
    assert.equal(complete.value.read_state, "ok");
    assert.equal(complete.value.healthy, true);

    turn.startSource = {
      traceId: "codex:other:thread:other",
      lineNumber: 1,
      byteStart: 0,
      byteEndExclusive: 1,
    };
    await writeRelative(
      project,
      `.barbaro/state/codex/${PROVIDER_STATE_FILE}`,
      `${JSON.stringify(state)}\n`,
    );
    const wrongProvenance = await readProjectStoreHealth(project, OPTIONS);
    assert.equal(wrongProvenance.value.read_state, "degraded");
    assert.equal(
      wrongProvenance.value.diagnostics.invalid_provider_state_records,
      1,
    );
  });
});

test("persisted provider drift is deterministic, bounded, and prevents healthy", async () => {
  await temporaryProject(async (project) => {
    const unknownRootTypes = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `future-root-${index.toString().padStart(2, "0")}`,
        index + 1,
      ]),
    );
    const state = {
      schema: "barbaro.codex-runner-state.v1",
      trace_id: "codex:native-session",
      checkpoint: validCheckpoint(),
      normalizer: {
        schema: "barbaro.codex-normalizer-state.v1",
        next_sequence: 1,
        turns: [],
        diagnostics: {
          records: 50,
          invalid_envelopes: 2,
          unknown_root_types: unknownRootTypes,
          unknown_event_types: { "future-event": 3 },
          unknown_response_types: { "future-response": 4 },
          repeated_session_meta: 5,
          orphan_turn_records: 6,
        },
      },
    };
    await writeRelative(
      project,
      `.barbaro/state/codex/${PROVIDER_STATE_FILE}`,
      `${JSON.stringify(state)}\n`,
    );

    const before = await snapshotTree(project);
    const full = await readProjectStoreHealth(project, OPTIONS);
    const replay = await readProjectStoreHealth(project, OPTIONS);
    const drift = full.value.diagnostics.provider_drift;

    assert.deepEqual(replay, full);
    assert.equal(full.value.presence, "present");
    assert.equal(full.value.read_state, "degraded");
    assert.equal(full.value.healthy, false);
    assert.equal(full.value.coverage.state, "complete");
    assert.equal(full.value.diagnostics.invalid_provider_state_records, 0);
    assertCollection(drift);
    assert.equal(drift.read_state, "degraded");
    assert.equal(drift.coverage.state, "complete");
    assert.equal(drift.total, 45);
    assert.equal(drift.hidden, 0);
    assert.deepEqual(
      [
        ...new Set(
          drift.items.map((item: ReaderProviderDriftDiagnostic) => item.kind),
        ),
      ].sort(),
      [
        "invalid_envelope",
        "orphan_turn_record",
        "repeated_session_meta",
        "unknown_event_type",
        "unknown_response_type",
        "unknown_root_type",
      ],
    );
    assert.equal(
      drift.items.find(
        (item: ReaderProviderDriftDiagnostic) => item.kind === "invalid_envelope",
      )?.count,
      2,
    );
    assert.equal(
      drift.items.find(
        (item: ReaderProviderDriftDiagnostic) =>
          item.kind === "repeated_session_meta",
      )?.count,
      5,
    );
    assert.equal(
      drift.items.find(
        (item: ReaderProviderDriftDiagnostic) =>
          item.kind === "orphan_turn_record",
      )?.count,
      6,
    );

    const bounded = await readProjectStoreHealth(project, {
      ...OPTIONS,
      byteBudget: 3_000,
    });
    const boundedReplay = await readProjectStoreHealth(project, {
      ...OPTIONS,
      byteBudget: 3_000,
    });
    const boundedDrift = bounded.value.diagnostics.provider_drift;
    assert.deepEqual(boundedReplay, bounded);
    assert.equal(stableJsonUtf8Bytes(bounded), bounded.utf8_bytes);
    assert.ok(bounded.utf8_bytes <= bounded.byte_budget);
    assert.equal(bounded.value.healthy, false);
    assertCollection(boundedDrift);
    assert.equal(boundedDrift.total, drift.total);
    assert.ok(boundedDrift.shown > 0);
    assert.ok(boundedDrift.shown < boundedDrift.total);
    assert.equal(boundedDrift.read_state, "degraded");
    assert.equal(boundedDrift.coverage.state, "complete");
    assert.equal(await snapshotTree(project), before);
  });
});
