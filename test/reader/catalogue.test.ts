import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ActiveLeaseStore } from "../../src/active/store.js";
import type { ActiveLeaseUpdate } from "../../src/active/types.js";
import { stableJsonUtf8Bytes } from "../../src/reader/budget.js";
import { readProjectCatalogue } from "../../src/reader/index.js";
import type {
  ReaderCatalogueV1,
  ReaderCatalogueWorkstream,
} from "../../src/reader/catalogue.js";
import { snapshotTree } from "../setup/fixture.js";

const WS_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SES_A = "ses_11111111111111111111111111111111";
const SES_B = "ses_22222222222222222222222222222222";
const SES_C = "ses_33333333333333333333333333333333";
const REFERENCE = "2026-08-25T12:00:00.000Z";
const MEMBER_FROM = "2026-08-25T09:00:00.000Z";

const OPTIONS = {
  byteBudget: 256 * 1024,
  now: REFERENCE,
} as const;

async function temporaryProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-catalogue-"));
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

function workstreamRecord(
  id: string,
  name: string,
  status: "open" | "completed" = "open",
): object {
  return {
    schema: "barbaro.workstream.v1",
    workstream_id: id,
    name,
    status,
    created_at: "2026-08-25T08:00:00.000Z",
    created_by: { kind: "cli" },
    updated_at: "2026-08-25T08:00:00.000Z",
    revision: 1,
  };
}

function participation(
  provider: string,
  sessionId: string,
  memberships: readonly { workstream_id: string; from: string }[],
): object {
  const current = memberships[memberships.length - 1]!;
  return {
    schema: "barbaro.session-participation.v2",
    provider,
    session_id: sessionId,
    joined_at: memberships[0]!.from,
    initiated_by: "user_prompt",
    workstream_id: current.workstream_id,
    memberships,
  };
}

function turn(
  provider: string,
  sessionId: string,
  sequence: number,
  workstreamId: string | undefined,
  endedAt: string,
  responseText = "done",
): { turn: object; turnId: string; responseSha: string } {
  const turnId = `turn_${sequence.toString(16).padStart(2, "0").repeat(16)}`;
  return {
    turnId,
    responseSha: createHash("sha256").update(responseText, "utf8").digest("hex"),
    turn: {
      schema: "barbaro.turn.v1",
      turn_id: turnId,
      provider,
      session_id: sessionId,
      ...(workstreamId === undefined ? {} : { workstream_id: workstreamId }),
      sequence,
      agent_id: "main",
      started_at: "2026-08-25T09:30:00.000Z",
      ended_at: endedAt,
      outcome: "success",
      request: {
        text: "fixture",
        fidelity: "verbatim",
        truncated: false,
        original_utf8_bytes: 7,
        redactions: [],
      },
      response: {
        text: responseText,
        fidelity: "verbatim",
        truncated: false,
        original_utf8_bytes: responseText.length,
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
      source_refs: [{ trace_id: "fixture:reader-catalogue" }],
    },
  };
}

async function appendTurn(
  project: string,
  provider: string,
  sessionId: string,
  record: object,
): Promise<void> {
  const path = join(project, ".barbaro", "feed", provider, `${sessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

function clearJournal(
  provider: string,
  sessionId: string,
  triggerTurnId: string,
): object {
  return {
    schema: "barbaro.ingest-attempt-journal.v2",
    provider,
    session_id: sessionId,
    dropped_attempts: 0,
    attempts: [
      {
        attempt_id: "attempt-1",
        event: "Stop",
        trigger: { turn_id: triggerTurnId },
        triggered_at: "2026-08-25T10:00:00.000Z",
        pid: 1,
        started_at: "2026-08-25T10:00:00.000Z",
        observations: {
          count: 0,
          first: null,
          last: null,
          size_transitions: [],
          dropped_transitions: 0,
        },
        checkpoint_before: null,
        checkpoint_after: null,
        turns_appended: 1,
        pending_background_ids: [],
        pending_agent_ids: [],
        finished_at: "2026-08-25T10:00:01.000Z",
        outcome: "ok",
      },
    ],
  };
}

function itemFor(
  catalogue: ReaderCatalogueV1,
  workstreamId: string,
): ReaderCatalogueWorkstream {
  const item = catalogue.workstreams.items.find(
    (candidate) => candidate.record.workstream_id === workstreamId,
  );
  assert.ok(item !== undefined, `catalogue item for ${workstreamId}`);
  return item;
}

interface CollectionLike {
  readonly items?: readonly unknown[];
  readonly shown: number;
  readonly total: number;
  readonly hidden: number;
}

function assertEnvelope(collection: CollectionLike): void {
  if (collection.items !== undefined) {
    assert.equal(collection.shown, collection.items.length);
  }
  assert.equal(collection.hidden, collection.total - collection.shown);
  assert.ok(collection.shown >= 0);
  assert.ok(collection.hidden >= 0);
}

function assertItemEnvelopes(item: ReaderCatalogueWorkstream): void {
  assertEnvelope(item.members);
  assertEnvelope(item.rolls);
  assertEnvelope(item.activity.turns);
  assertEnvelope(item.attention.items);
  for (const roll of item.rolls.items) {
    assertEnvelope(roll.leases);
    assertEnvelope(roll.turns);
  }
  if (item.unread !== undefined) assertEnvelope(item.unread);
  if (item.publish !== undefined) assertEnvelope(item.publish);
}

test("the pinned roster is deterministic, pure, and byte-honest", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/sessions/claude/${SES_A}.json`,
      JSON.stringify(
        participation("claude", SES_A, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    const made = turn("claude", SES_A, 1, WS_A, "2026-08-25T09:59:00.000Z");
    await appendTurn(project, "claude", SES_A, made.turn);

    const before = await snapshotTree(project);
    const first = await readProjectCatalogue(project, OPTIONS);
    const replay = await readProjectCatalogue(project, OPTIONS);

    assert.deepEqual(replay, first);
    assert.equal(await snapshotTree(project), before);
    assert.equal(stableJsonUtf8Bytes(first), first.utf8_bytes);
    assert.ok(first.utf8_bytes <= first.byte_budget);
    assert.equal(first.value.reference_at, REFERENCE);
    assert.equal(first.value.schema, "barbaro.reader.catalogue.v1");
    assert.deepEqual(first.value.workstream_status_counts, {
      open: 1,
      completed: 0,
      read_state: "ok",
      coverage: { state: "complete" },
    });

    const item = itemFor(first.value, WS_A);
    assertItemEnvelopes(item);
    assert.equal(item.record.name, "alpha");
    assert.equal(item.record.status, "open");
    assert.deepEqual(item.members.items, [
      { provider: "claude", session_id: SES_A, membership_from: MEMBER_FROM },
    ]);
    assert.equal(item.activity.state, "shown");
    assert.equal(item.activity.newest_turn?.turn_id, made.turnId);
    assert.equal(
      item.activity.last_known_activity_at,
      "2026-08-25T09:59:00.000Z",
    );
  });
});

test("rolls unite participation, active, and turn evidence with epochs", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_B}.json`,
      JSON.stringify(workstreamRecord(WS_B, "beta")),
    );
    // A: current member with a lease and no turns.
    await writeRelative(
      project,
      `.barbaro/sessions/claude/${SES_A}.json`,
      JSON.stringify(
        participation("claude", SES_A, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    // B: moved from alpha to beta; its alpha turns must remain rolls.
    await writeRelative(
      project,
      `.barbaro/sessions/codex/${SES_B}.json`,
      JSON.stringify(
        participation("codex", SES_B, [
          { workstream_id: WS_A, from: "2026-08-25T08:30:00.000Z" },
          { workstream_id: WS_B, from: "2026-08-25T10:30:00.000Z" },
        ]),
      ),
    );
    await appendTurn(
      project,
      "codex",
      SES_B,
      turn("codex", SES_B, 1, WS_A, "2026-08-25T09:45:00.000Z").turn,
    );
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    const update: ActiveLeaseUpdate = {
      lease_id: `lease_${"0".repeat(32)}`,
      provider: "claude",
      session_id: SES_A,
      agent_id: "main",
      workstream_id: WS_A,
      state: "waiting",
      claims: [],
      unknown_write_scope: false,
      current_action: {
        kind: "command",
        command: {
          text: "barbaro await --timeout-ms 540000",
          fidelity: "verbatim",
          truncated: false,
          redactions: [],
        },
        started_at: "2026-08-25T11:59:00.000Z",
      },
    };
    await store.write(update, {
      now: Date.parse(REFERENCE) - 1000,
      ttlMs: 600_000,
    });

    const catalogue = await readProjectCatalogue(project, OPTIONS);
    const alpha = itemFor(catalogue.value, WS_A);
    assertItemEnvelopes(alpha);

    assert.equal(alpha.rolls.total, 2);
    const rollA = alpha.rolls.items.find((roll) => roll.session_id === SES_A)!;
    const rollB = alpha.rolls.items.find((roll) => roll.session_id === SES_B)!;
    assert.equal(rollA.current_enrollment, true);
    assert.equal(rollA.membership_from, MEMBER_FROM);
    assert.equal(rollA.in_active, true);
    assert.equal(rollA.in_turns, false);
    assert.equal(rollA.state_counts.waiting, 1);
    assert.equal(rollB.current_enrollment, false);
    assert.equal(rollB.membership_from, undefined);
    assert.equal(rollB.in_participation, true);
    assert.equal(rollB.in_turns, true);
    assert.equal(rollB.last_turn?.sequence, 1);

    // E-03 enrichment on the classified await, full typed target.
    const lease = rollA.leases.items[0]!;
    assert.equal(lease.state, "waiting");
    assert.equal(lease.dependency?.kind, "peer_unread");
    assert.equal(lease.dependency?.audience, "peer");
    assert.deepEqual(lease.dependency?.target, {
      type: "workstream",
      workstream_id: WS_A,
    });

    // Membership currency: B is a current member of beta only.
    const beta = itemFor(catalogue.value, WS_B);
    assert.deepEqual(
      beta.members.items.map((member) => member.session_id),
      [SES_B],
    );
    assert.equal(alpha.members.items.length, 1);
    assert.equal(alpha.active_state_counts.waiting, 1);
  });
});

test("activity distinguishes proven empty, scan limits, and damage", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/sessions/codex/${SES_B}.json`,
      JSON.stringify(
        participation("codex", SES_B, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );

    // A store whose only evidence is complete and clean proves empty.
    const empty = await readProjectCatalogue(project, OPTIONS);
    const emptyItem = itemFor(empty.value, WS_A);
    assert.equal(emptyItem.activity.state, "proven_empty");
    assert.equal(emptyItem.activity.proven_empty, true);
    assert.deepEqual(emptyItem.activity.full_history, { state: "complete" });
    assert.equal(emptyItem.activity.last_known_activity_at, undefined);

    // A malformed feed line breaks the empty proof for the same store.
    await writeRelative(
      project,
      `.barbaro/feed/codex/${SES_B}.jsonl`,
      "not json\n",
    );
    const damaged = await readProjectCatalogue(project, OPTIONS);
    const damagedItem = itemFor(damaged.value, WS_A);
    assert.equal(damagedItem.activity.state, "invalid");
    assert.equal(damagedItem.activity.proven_empty, false);
    assert.equal(damagedItem.activity.full_history.state, "limited");
    assert.equal(damaged.value.diagnostics.malformed_feed_records, 1);

    // A scan-limited feed is bounded visibility, not damage or emptiness.
    const wide = turn(
      "codex",
      SES_B,
      1,
      undefined,
      "2026-08-25T09:40:00.000Z",
      "x".repeat(4096),
    );
    await writeRelative(
      project,
      `.barbaro/feed/codex/${SES_B}.jsonl`,
      `${JSON.stringify(wide.turn)}\n${JSON.stringify(wide.turn)}\n`,
    );
    const limited = await readProjectCatalogue(project, {
      ...OPTIONS,
      maxScanBytesPerFile: 1024,
    });
    const limitedItem = itemFor(limited.value, WS_A);
    assert.equal(limitedItem.activity.state, "scan_limited");
    assert.equal(limitedItem.activity.proven_empty, false);
  });
});

test("unrelated feed damage stays global without poisoning a clean workstream", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    const first = turn("claude", SES_A, 1, WS_A, "2026-08-25T09:40:00.000Z");
    const second = turn("claude", SES_A, 2, WS_A, "2026-08-25T09:50:00.000Z");
    await appendTurn(project, "claude", SES_A, first.turn);
    await appendTurn(project, "claude", SES_A, second.turn);
    await writeRelative(
      project,
      `.barbaro/feed/codex/${SES_B}.jsonl`,
      "not json\n",
    );

    const catalogue = await readProjectCatalogue(project, {
      ...OPTIONS,
      turnsPerSession: 2,
    });
    const item = itemFor(catalogue.value, WS_A);

    assert.equal(catalogue.value.read_state, "degraded");
    assert.equal(catalogue.value.diagnostics.malformed_feed_records, 1);
    assert.deepEqual(item.activity.full_history, { state: "complete" });
    assert.deepEqual(item.activity.turns.coverage, { state: "complete" });
    assert.equal(item.activity.turns.read_state, "ok");
    assert.equal(item.attention.completeness, "complete");
    assert.equal(item.attention.items.total, 0);
    assert.equal(item.quiet_proven, true);

    await writeRelative(
      project,
      `.barbaro/feed/claude/${SES_A}.jsonl`,
      `not json\n${JSON.stringify(first.turn)}\n${JSON.stringify(second.turn)}\n`,
    );
    const deepDamage = itemFor(
      (
        await readProjectCatalogue(project, {
          ...OPTIONS,
          turnsPerSession: 2,
        })
      ).value,
      WS_A,
    );
    assert.deepEqual(deepDamage.activity.turns.coverage, {
      state: "complete",
    });
    assert.deepEqual(deepDamage.activity.full_history, {
      state: "limited",
      reason: "feed_malformed",
    });
    assert.equal(deepDamage.attention.completeness, "complete");
    assert.equal(deepDamage.attention.items.total, 0);
    assert.equal(deepDamage.quiet_proven, false);
  });
});

test("a complete newest-N tail proves recent activity across a scan-limited feed", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    const old = turn(
      "claude",
      SES_A,
      1,
      WS_A,
      "2026-08-25T09:30:00.000Z",
      "x".repeat(8192),
    );
    const firstRecent = turn(
      "claude",
      SES_A,
      2,
      WS_A,
      "2026-08-25T09:40:00.000Z",
    );
    const newest = turn(
      "claude",
      SES_A,
      3,
      WS_A,
      "2026-08-25T09:50:00.000Z",
    );
    await appendTurn(project, "claude", SES_A, old.turn);
    await appendTurn(project, "claude", SES_A, firstRecent.turn);
    await appendTurn(project, "claude", SES_A, newest.turn);
    const recentBytes = Buffer.byteLength(
      `${JSON.stringify(firstRecent.turn)}\n${JSON.stringify(newest.turn)}\n`,
      "utf8",
    );

    const catalogue = await readProjectCatalogue(project, {
      ...OPTIONS,
      turnsPerSession: 2,
      maxScanBytesPerFile: recentBytes + 1,
    });
    const item = itemFor(catalogue.value, WS_A);
    const roll = item.rolls.items[0]!;

    assert.equal(catalogue.value.diagnostics.scan_limited_feed_files, 1);
    assert.deepEqual(item.activity.turns.coverage, { state: "complete" });
    assert.deepEqual(roll.turns.coverage, { state: "complete" });
    assert.deepEqual(item.activity.full_history, {
      state: "limited",
      reason: "feed_scan_limit",
    });
    assert.equal(item.activity.turns.shown, 2);
    assert.equal(item.activity.newest_turn?.turn_id, newest.turnId);
    assert.equal(item.attention.completeness, "complete");
    assert.equal(item.attention.items.total, 0);
    assert.equal(item.quiet_proven, false);

    await writeRelative(
      project,
      `.barbaro/sessions/claude/${SES_A}.json`,
      JSON.stringify(
        participation("claude", SES_A, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    await writeRelative(
      project,
      `.barbaro/logs/ingest/claude/${SES_A}.json`,
      JSON.stringify(clearJournal("claude", SES_A, newest.turnId)),
    );
    const withPublish = itemFor(
      (
        await readProjectCatalogue(project, {
          ...OPTIONS,
          turnsPerSession: 2,
          maxScanBytesPerFile: recentBytes + 1,
        })
      ).value,
      WS_A,
    );
    assert.equal(withPublish.publish?.items[0]?.state, "clear");
    assert.equal(withPublish.publish?.items[0]?.freshness, "current");
  });
});

test("recent publish proof survives dropped old attempts but not a later scoped turn", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/sessions/claude/${SES_A}.json`,
      JSON.stringify(
        participation("claude", SES_A, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    const current = turn(
      "claude",
      SES_A,
      1,
      WS_A,
      "2026-08-25T09:50:00.000Z",
    );
    await appendTurn(project, "claude", SES_A, current.turn);
    const journal = clearJournal("claude", SES_A, current.turnId) as {
      dropped_attempts: number;
    };
    journal.dropped_attempts = 2;
    await writeRelative(
      project,
      `.barbaro/logs/ingest/claude/${SES_A}.json`,
      JSON.stringify(journal),
    );

    const clear = itemFor((await readProjectCatalogue(project, OPTIONS)).value, WS_A);
    assert.equal(clear.publish?.items[0]?.state, "clear");
    assert.equal(clear.publish?.items[0]?.freshness, "current");
    assert.equal(clear.attention.completeness, "complete");
    assert.equal(clear.quiet_proven, true);

    const later = turn(
      "claude",
      SES_A,
      2,
      WS_A,
      "2026-08-25T10:30:00.000Z",
    );
    await appendTurn(project, "claude", SES_A, later.turn);
    const stale = itemFor((await readProjectCatalogue(project, OPTIONS)).value, WS_A);
    assert.equal(stale.publish?.items[0]?.state, "unknown");
    assert.equal(stale.publish?.items[0]?.freshness, "stale");
    assert.equal(stale.attention.completeness, "incomplete");
    assert.equal(stale.attention.highest, "evidence_incomplete");
    assert.equal(stale.quiet_proven, false);
  });
});

test("damage or insufficient proof inside the recent window stays incomplete", async (t) => {
  const cases = [
    {
      name: "malformed",
      suffix: "not json\n",
      expectedReason: "feed_malformed",
      maxScanBytesPerFile: undefined,
    },
    {
      name: "partial",
      suffix: "{",
      expectedReason: "feed_partial",
      maxScanBytesPerFile: undefined,
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await temporaryProject(async (project) => {
        await writeRelative(
          project,
          `.barbaro/workstreams/${WS_A}.json`,
          JSON.stringify(workstreamRecord(WS_A, "alpha")),
        );
        const made = turn(
          "claude",
          SES_A,
          1,
          WS_A,
          "2026-08-25T09:50:00.000Z",
        );
        await writeRelative(
          project,
          `.barbaro/feed/claude/${SES_A}.jsonl`,
          `${JSON.stringify(made.turn)}\n${fixture.suffix}`,
        );

        const catalogue = await readProjectCatalogue(project, {
          ...OPTIONS,
          turnsPerSession: 2,
          ...(fixture.maxScanBytesPerFile === undefined
            ? {}
            : { maxScanBytesPerFile: fixture.maxScanBytesPerFile }),
        });
        const item = itemFor(catalogue.value, WS_A);

        assert.deepEqual(item.activity.turns.coverage, {
          state: "limited",
          reason: fixture.expectedReason,
        });
        assert.deepEqual(item.rolls.items[0]?.turns.coverage, {
          state: "limited",
          reason: fixture.expectedReason,
        });
        assert.equal(item.activity.turns.read_state, "degraded");
        assert.equal(item.attention.completeness, "incomplete");
        assert.equal(item.attention.highest, "evidence_incomplete");
      });
    });
  }

  await t.test("scan limited before newest-N", async () => {
    await temporaryProject(async (project) => {
      await writeRelative(
        project,
        `.barbaro/workstreams/${WS_A}.json`,
        JSON.stringify(workstreamRecord(WS_A, "alpha")),
      );
      const old = turn(
        "claude",
        SES_A,
        1,
        WS_A,
        "2026-08-25T09:40:00.000Z",
        "x".repeat(8192),
      );
      const recent = turn(
        "claude",
        SES_A,
        2,
        WS_A,
        "2026-08-25T09:50:00.000Z",
      );
      await appendTurn(project, "claude", SES_A, old.turn);
      await appendTurn(project, "claude", SES_A, recent.turn);
      const recentBytes = Buffer.byteLength(
        `${JSON.stringify(recent.turn)}\n`,
        "utf8",
      );

      const catalogue = await readProjectCatalogue(project, {
        ...OPTIONS,
        turnsPerSession: 2,
        maxScanBytesPerFile: recentBytes + 1,
      });
      const item = itemFor(catalogue.value, WS_A);

      assert.deepEqual(item.activity.turns.coverage, {
        state: "limited",
        reason: "feed_scan_limit",
      });
      assert.deepEqual(item.rolls.items[0]?.turns.coverage, {
        state: "limited",
        reason: "feed_scan_limit",
      });
      assert.equal(item.attention.completeness, "incomplete");
      assert.equal(item.attention.highest, "evidence_incomplete");
    });
  });
});

test("a scoped turn outside the session window is outside_window, not absent", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_B}.json`,
      JSON.stringify(workstreamRecord(WS_B, "beta")),
    );
    const older = turn("codex", SES_B, 1, WS_B, "2026-08-25T09:10:00.000Z");
    const newer = turn("codex", SES_B, 2, WS_A, "2026-08-25T09:20:00.000Z");
    await appendTurn(project, "codex", SES_B, older.turn);
    await appendTurn(project, "codex", SES_B, newer.turn);

    const catalogue = await readProjectCatalogue(project, {
      ...OPTIONS,
      turnsPerSession: 1,
    });
    const alpha = itemFor(catalogue.value, WS_A);
    const beta = itemFor(catalogue.value, WS_B);

    assert.equal(alpha.activity.state, "shown");
    assert.equal(alpha.activity.newest_turn?.turn_id, newer.turnId);

    assert.equal(beta.activity.state, "outside_window");
    assert.equal(beta.activity.proven_empty, false);
    assert.equal(beta.activity.turns.total, 1);
    assert.equal(beta.activity.turns.shown, 0);
    assert.equal(beta.activity.newest_turn, undefined);
    assert.equal(
      beta.activity.last_known_activity_at,
      "2026-08-25T09:10:00.000Z",
    );
  });
});

test("quiet is proven only with complete evidence and zero attention", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/sessions/claude/${SES_A}.json`,
      JSON.stringify(
        participation("claude", SES_A, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    const made = turn("claude", SES_A, 1, WS_A, "2026-08-25T09:59:00.000Z");
    await appendTurn(project, "claude", SES_A, made.turn);
    await writeRelative(
      project,
      `.barbaro/logs/ingest/claude/${SES_A}.json`,
      JSON.stringify(clearJournal("claude", SES_A, made.turnId)),
    );

    const quiet = await readProjectCatalogue(project, OPTIONS);
    const quietItem = itemFor(quiet.value, WS_A);
    assert.equal(quietItem.attention.completeness, "complete");
    assert.equal(quietItem.attention.items.total, 0);
    assert.equal(quietItem.publish?.items[0]?.state, "clear");
    assert.equal(quietItem.quiet_proven, true);

    // The same store with unread/publish evidence not gathered cannot say
    // quiet: absent evidence is a proof gap, not a clean slate.
    const partial = await readProjectCatalogue(project, {
      ...OPTIONS,
      includePublish: false,
    });
    const partialItem = itemFor(partial.value, WS_A);
    assert.equal(partialItem.attention.completeness, "incomplete");
    assert.equal(partialItem.quiet_proven, false);

    // A live waiting lease removes quiet even with complete evidence.
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    await store.write(
      {
        lease_id: `lease_${"1".repeat(32)}`,
        provider: "claude",
        session_id: SES_A,
        agent_id: "main",
        workstream_id: WS_A,
        state: "waiting",
        claims: [],
        unknown_write_scope: false,
      },
      { now: Date.parse(REFERENCE) - 1000, ttlMs: 600_000 },
    );
    const busy = await readProjectCatalogue(project, OPTIONS);
    assert.equal(itemFor(busy.value, WS_A).quiet_proven, false);
  });
});

test("news and publish jams become named prioritized attention", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/sessions/claude/${SES_A}.json`,
      JSON.stringify(
        participation("claude", SES_A, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    await writeRelative(
      project,
      `.barbaro/sessions/codex/${SES_B}.json`,
      JSON.stringify(
        participation("codex", SES_B, [
          { workstream_id: WS_A, from: MEMBER_FROM },
        ]),
      ),
    );
    // A peer turn after A's membership means unread news for A.
    const peerTurn = turn("codex", SES_B, 1, WS_A, "2026-08-25T10:15:00.000Z");
    await appendTurn(project, "codex", SES_B, peerTurn.turn);
    // B's journal reports a blocked publish for its newest scoped turn.
    const blocked = clearJournal("codex", SES_B, peerTurn.turnId) as {
      attempts: Array<Record<string, unknown>>;
    };
    blocked.attempts[0]!.publish_blocker = "verdict turn withheld";
    await writeRelative(
      project,
      `.barbaro/logs/ingest/codex/${SES_B}.json`,
      JSON.stringify(blocked),
    );

    const catalogue = await readProjectCatalogue(project, OPTIONS);
    const item = itemFor(catalogue.value, WS_A);
    assertItemEnvelopes(item);

    const kinds = item.attention.items.items.map((entry) => entry.kind);
    assert.ok(kinds.includes("news"));
    assert.ok(kinds.includes("publish_blocked"));
    // Missing journal evidence for A keeps the aggregate incomplete, and
    // that proof gap outranks even the publish jam in the priority order.
    assert.equal(item.attention.completeness, "incomplete");
    assert.equal(item.attention.highest, "evidence_incomplete");
    assert.ok(
      kinds.indexOf("publish_blocked") < kinds.indexOf("news"),
      "publish_blocked sorts before news",
    );
    const news = item.attention.items.items.find(
      (entry) => entry.kind === "news",
    )!;
    assert.equal(news.session_id, SES_A);
    const jam = item.attention.items.items.find(
      (entry) => entry.kind === "publish_blocked",
    )!;
    assert.equal(jam.session_id, SES_B);
    assert.equal(item.quiet_proven, false);

    const unreadForA = item.unread?.items.find(
      (summary) => summary.key.session_id === SES_A,
    );
    assert.equal(unreadForA?.status, "ready");
    assert.equal(
      unreadForA?.status === "ready" ? unreadForA.unread_count : -1,
      1,
    );
  });
});

test("a scoped catalogue names its scope and returns only that item", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_B}.json`,
      JSON.stringify(workstreamRecord(WS_B, "beta")),
    );

    const scoped = await readProjectCatalogue(project, {
      ...OPTIONS,
      workstreamId: WS_B,
    });
    assert.deepEqual(scoped.value.scope, { workstream_id: WS_B });
    assert.equal(scoped.value.workstreams.total, 1);
    assert.equal(
      scoped.value.workstreams.items[0]!.record.workstream_id,
      WS_B,
    );
  });
});

test("an unsafe feed path refuses the catalogue rather than feigning health", async () => {
  await temporaryProject(async (project) => {
    await writeRelative(
      project,
      `.barbaro/workstreams/${WS_A}.json`,
      JSON.stringify(workstreamRecord(WS_A, "alpha")),
    );
    await mkdir(join(project, ".barbaro", "feed"), { recursive: true });
    await mkdir(join(project, "outside"));
    await symlink(
      join(project, "outside"),
      join(project, ".barbaro", "feed", "claude"),
    );

    const catalogue = await readProjectCatalogue(project, OPTIONS);
    assert.equal(catalogue.value.read_state, "refused");
    assert.equal(catalogue.value.coverage.state, "refused");
    assert.equal(catalogue.value.workstreams.total, 0);
    assert.equal(catalogue.value.workstreams.items.length, 0);
  });
});

test("a small byte budget hides items in the envelope, never silently", async () => {
  await temporaryProject(async (project) => {
    for (let index = 0; index < 8; index += 1) {
      const id = `ws_${index.toString(16).repeat(32)}`;
      await writeRelative(
        project,
        `.barbaro/workstreams/${id}.json`,
        JSON.stringify(
          workstreamRecord(
            id,
            `stream-${index}`,
            index % 2 === 0 ? "open" : "completed",
          ),
        ),
      );
    }
    const catalogue = await readProjectCatalogue(project, {
      ...OPTIONS,
      byteBudget: 4 * 1024,
    });
    const collection = catalogue.value.workstreams;
    assert.ok(catalogue.utf8_bytes <= 4 * 1024);
    assert.equal(collection.total, 8);
    assert.ok(collection.shown < 8);
    assert.equal(collection.hidden, 8 - collection.shown);
    assert.equal(collection.items.length, collection.shown);
    assert.deepEqual(catalogue.value.workstream_status_counts, {
      open: 4,
      completed: 4,
      read_state: "ok",
      coverage: { state: "complete" },
    });
  });
});

test("status counts expose incomplete source coverage instead of feigning exactness", async () => {
  await temporaryProject(async (project) => {
    const records = [
      [WS_A, "alpha", "open"],
      [WS_B, "beta", "completed"],
      [`ws_${"c".repeat(32)}`, "gamma", "completed"],
    ] as const;
    for (const [id, name, status] of records) {
      await writeRelative(
        project,
        `.barbaro/workstreams/${id}.json`,
        JSON.stringify(workstreamRecord(id, name, status)),
      );
    }

    const catalogue = await readProjectCatalogue(project, {
      ...OPTIONS,
      maxSourceEntries: 2,
    });

    assert.equal(catalogue.value.diagnostics.workstream_files, 3);
    assert.equal(catalogue.value.workstreams.total, 2);
    assert.deepEqual(catalogue.value.workstream_status_counts, {
      open: 1,
      completed: 1,
      read_state: "degraded",
      coverage: { state: "limited", reason: "source_entry_limit" },
    });

    await writeRelative(
      project,
      `.barbaro/workstreams/${records[2][0]}.json`,
      "not json",
    );
    const invalid = await readProjectCatalogue(project, OPTIONS);
    assert.equal(invalid.value.diagnostics.invalid_workstream_records, 1);
    assert.deepEqual(invalid.value.workstream_status_counts, {
      open: 1,
      completed: 1,
      read_state: "degraded",
      coverage: { state: "complete" },
    });
  });
});
