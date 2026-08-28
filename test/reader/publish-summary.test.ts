import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  BarbaroIngestAttemptJournalV2,
  BarbaroIngestAttemptV2,
  IngestAttemptOutcome,
} from "../../src/hooks/ingest-attempt.js";
import type { SessionWorkstreamMembership } from "../../src/hooks/participation.js";
import { stableJsonUtf8Bytes } from "../../src/reader/budget.js";
import {
  readSessionPublishSummary,
  type ReaderPublishSummary,
  type ReaderPublishSummaryOptions,
  type ReaderPublishTurnFact,
} from "../../src/reader/publish.js";
import { readerCollection } from "../../src/reader/projection.js";
import type { ReaderCollection } from "../../src/reader/types.js";
import { snapshotTree } from "../setup/fixture.js";

const SESSION = `ses_${"1".repeat(32)}`;
const OTHER_SESSION = `ses_${"2".repeat(32)}`;
const FIRST_WORKSTREAM = `ws_${"a".repeat(32)}`;
const WORKSTREAM = `ws_${"b".repeat(32)}`;
const CURRENT_WORKSTREAM = `ws_${"c".repeat(32)}`;
const FIRST_FROM = "2026-08-25T01:00:00.000Z";
const TARGET_FROM = "2026-08-25T02:00:00.000Z";
const CURRENT_FROM = "2026-08-25T03:00:00.000Z";

function attempt(
  overrides: Partial<BarbaroIngestAttemptV2> = {},
): BarbaroIngestAttemptV2 {
  return {
    attempt_id: "attempt-default",
    event: "Stop",
    trigger: {
      native_turn_id: "native-turn",
      turn_id: `turn_${"4".repeat(32)}`,
      agent_id: "main",
    },
    triggered_at: "2026-08-25T02:30:00.000Z",
    pid: 1,
    started_at: "2026-08-25T02:30:00.001Z",
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
    finished_at: "2026-08-25T02:30:00.010Z",
    outcome: "ok",
    ...overrides,
  };
}

function unfinishedAttempt(
  overrides: Partial<BarbaroIngestAttemptV2> = {},
): BarbaroIngestAttemptV2 {
  const {
    finished_at: _finishedAt,
    outcome: _outcome,
    ...unfinished
  } = attempt(overrides);
  return unfinished;
}

function journal(
  attempts: readonly BarbaroIngestAttemptV2[],
  overrides: Partial<BarbaroIngestAttemptJournalV2> = {},
): BarbaroIngestAttemptJournalV2 {
  return {
    schema: "barbaro.ingest-attempt-journal.v2",
    provider: "codex",
    session_id: SESSION,
    dropped_attempts: 0,
    attempts,
    ...overrides,
  };
}

function memberships(
  items: readonly SessionWorkstreamMembership[] = [
    { workstream_id: FIRST_WORKSTREAM, from: FIRST_FROM },
    { workstream_id: WORKSTREAM, from: TARGET_FROM },
    { workstream_id: CURRENT_WORKSTREAM, from: CURRENT_FROM },
  ],
): ReaderCollection<SessionWorkstreamMembership> {
  return readerCollection(items);
}

function history(
  items: readonly ReaderPublishTurnFact[] = [
    {
      turn_id: `turn_${"4".repeat(32)}`,
      provider: "codex",
      session_id: SESSION,
      workstream_id: WORKSTREAM,
      sequence: 1,
      started_at: "2026-08-25T02:29:00.000Z",
    },
  ],
): ReaderCollection<ReaderPublishTurnFact> {
  return readerCollection(items);
}

function options(
  overrides: Partial<ReaderPublishSummaryOptions> = {},
): ReaderPublishSummaryOptions {
  return {
    byteBudget: 128 * 1024,
    provider: "codex",
    sessionId: SESSION,
    workstreamId: WORKSTREAM,
    membershipHistory: {
      provider: "codex",
      session_id: SESSION,
      memberships: memberships(),
    },
    turnHistory: history(),
    ...overrides,
  };
}

function journalPath(project: string): string {
  return join(
    project,
    ".barbaro",
    "logs",
    "ingest",
    "codex",
    `${SESSION}.json`,
  );
}

async function writeJournal(
  project: string,
  value: unknown,
): Promise<string> {
  const path = journalPath(project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  return path;
}

async function temporaryProject(t: TestContext): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-publish-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

function assertCollection(collection: ReaderCollection<unknown>): void {
  assert.equal(collection.shown, collection.items.length);
  assert.equal(collection.hidden, collection.total - collection.shown);
  assert.ok(collection.shown >= 0);
  assert.ok(collection.hidden >= 0);
  assert.ok(collection.shown <= collection.total);
}

function assertSummaryCollections(summary: ReaderPublishSummary): void {
  assertCollection(summary.attempts);
  assertCollection(summary.pending_agent_ids);
  assertCollection(summary.pending_background_ids);
}

test("an absent journal is deterministic unknown and never creates the store", async (t) => {
  const project = await temporaryProject(t);
  const before = await readdir(project);

  const first = await readSessionPublishSummary(project, options());
  const replay = await readSessionPublishSummary(project, options());

  assert.deepEqual(replay, first);
  assert.deepEqual(await readdir(project), before);
  await assert.rejects(readFile(join(project, ".barbaro")), { code: "ENOENT" });
  assert.equal(first.value.state, "unknown");
  assert.equal(first.value.outcome, "unknown");
  assert.equal(first.value.actionability, "unknown");
  assert.equal(first.value.diagnostics.journal, "missing");
  assert.equal(first.value.diagnostics.missing, 1);
  assert.equal(first.value.read_state, "degraded");
  assert.equal(first.value.coverage.state, "complete");
  assertSummaryCollections(first.value);
  assert.equal(first.value.pending_agent_ids.read_state, "degraded");
  assert.equal(first.value.pending_agent_ids.coverage.state, "limited");
  assert.equal(first.value.pending_background_ids.read_state, "degraded");
  assert.equal(first.value.pending_background_ids.coverage.state, "limited");
  assert.equal(stableJsonUtf8Bytes(first), first.utf8_bytes);
});

test("selection uses historical inclusive membership and deterministic newest order", async (t) => {
  const project = await temporaryProject(t);
  const exactBoundary = attempt({
    attempt_id: "attempt-a",
    triggered_at: TARGET_FROM,
    started_at: "2026-08-25T02:00:00.001Z",
  });
  const selected = attempt({
    attempt_id: "attempt-z",
    triggered_at: "2026-08-25T02:30:00.000Z",
    started_at: "2026-08-25T02:30:00.001Z",
  });
  const sameTimeLowerId = attempt({
    attempt_id: "attempt-y",
    triggered_at: selected.triggered_at,
    started_at: selected.started_at,
  });
  const newerCurrentMembership = attempt({
    attempt_id: "attempt-current",
    triggered_at: "2026-08-25T03:30:00.000Z",
    started_at: "2026-08-25T03:30:00.001Z",
  });
  await writeJournal(project, journal([
    newerCurrentMembership,
    sameTimeLowerId,
    exactBoundary,
    selected,
  ]));

  const projection = await readSessionPublishSummary(project, options());
  const summary = projection.value;

  assert.equal(summary.state, "clear");
  assert.equal(summary.outcome, "ok");
  assert.equal(summary.actionability, "none");
  assert.equal(summary.freshness, "current");
  assert.equal(summary.selected_attempt?.attempt_id, "attempt-z");
  assert.equal(
    summary.selected_attempt?.attributed_workstream_id,
    WORKSTREAM,
  );
  assert.deepEqual(summary.selected_attempt?.trigger, selected.trigger);
  assert.deepEqual(
    Object.fromEntries(
      summary.attempts.items.map((item) => [
        item.attempt_id,
        item.attributed_workstream_id,
      ]),
    ),
    {
      "attempt-current": CURRENT_WORKSTREAM,
      "attempt-z": WORKSTREAM,
      "attempt-y": WORKSTREAM,
      "attempt-a": WORKSTREAM,
    },
  );
  assertSummaryCollections(summary);
  assert.equal(summary.attempts.total, 4);
  assert.equal(summary.attempts.hidden, 0);
  assert.equal(projection.utf8_bytes, stableJsonUtf8Bytes(projection));
});

test("terminal, pending, blocker, and withholding evidence normalize mechanically", async (t) => {
  const cases: readonly {
    readonly label: string;
    readonly value: BarbaroIngestAttemptV2;
    readonly state: "clear" | "pending" | "blocked";
    readonly outcome: IngestAttemptOutcome | "unfinished";
  }[] = [
    { label: "clear", value: attempt(), state: "clear", outcome: "ok" },
    {
      label: "unfinished",
      value: unfinishedAttempt(),
      state: "pending",
      outcome: "unfinished",
    },
    {
      label: "pending background",
      value: attempt({ pending_background_ids: ["bg-1"] }),
      state: "pending",
      outcome: "ok",
    },
    {
      label: "pending agent",
      value: attempt({ pending_agent_ids: ["agent-1"] }),
      state: "pending",
      outcome: "ok",
    },
    {
      label: "blocker wins over unfinished",
      value: unfinishedAttempt({
        publish_blocker: "permission required",
      }),
      state: "blocked",
      outcome: "unfinished",
    },
    {
      label: "withheld",
      value: attempt({ withheld_reason: "not visible" }),
      state: "blocked",
      outcome: "ok",
    },
    ...([
      "error",
      "process_died",
      "outcome_not_recorded",
      "stop_turn_not_visible",
    ] as const).map((outcome) => ({
      label: outcome,
      value: attempt({ outcome }),
      state: "blocked" as const,
      outcome,
    })),
  ];

  for (const candidate of cases) {
    await t.test(candidate.label, async (t) => {
      const project = await temporaryProject(t);
      await writeJournal(project, journal([candidate.value]));
      const summary = (await readSessionPublishSummary(project, options())).value;
      assert.equal(summary.state, candidate.state);
      assert.equal(summary.outcome, candidate.outcome);
      assert.equal(
        summary.actionability,
        candidate.state === "clear"
          ? "none"
          : candidate.state === "pending"
            ? "waiting"
            : "attention",
      );
      assertSummaryCollections(summary);
    });
  }
});

test("freshness is stale only for a proved later turn in the scoped workstream", async (t) => {
  const project = await temporaryProject(t);
  await writeJournal(project, journal([attempt()]));
  const later = {
    turn_id: `turn_${"9".repeat(32)}`,
    provider: "codex",
    session_id: SESSION,
    workstream_id: WORKSTREAM,
    sequence: 2,
    // Sequence is the ordering proof even when the wall clock regresses.
    started_at: "2026-08-25T02:00:00.000Z",
  } as const;

  const stale = (
    await readSessionPublishSummary(
      project,
      options({ turnHistory: history([...history().items, later]) }),
    )
  ).value;
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.state, "unknown");
  assert.equal(stale.outcome, "ok");

  const otherScope = (
    await readSessionPublishSummary(
      project,
      options({
        turnHistory: history([
          ...history().items,
          { ...later, workstream_id: CURRENT_WORKSTREAM },
        ]),
      }),
    )
  ).value;
  assert.equal(otherScope.freshness, "current");
  assert.equal(otherScope.state, "clear");

  const incompleteHistory: ReaderCollection<ReaderPublishTurnFact> = {
    shown: 0,
    total: 1,
    hidden: 1,
    items: [],
    read_state: "ok",
    coverage: { state: "complete" },
  };
  const unknown = (
    await readSessionPublishSummary(
      project,
      options({ turnHistory: incompleteHistory }),
    )
  ).value;
  assert.equal(unknown.freshness, "unknown");
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.coverage.state, "limited");

  const tiedTimestamp = (
    await readSessionPublishSummary(
      project,
      options({
        turnHistory: history([
          {
            ...later,
            started_at: attempt().triggered_at,
          },
        ]),
      }),
    )
  ).value;
  assert.equal(tiedTimestamp.freshness, "unknown");
  assert.equal(tiedTimestamp.state, "unknown");

  const tiedTriggerTurn = (
    await readSessionPublishSummary(
      project,
      options({
        turnHistory: history([
          {
            ...later,
            turn_id: attempt().trigger!.turn_id!,
            started_at: attempt().triggered_at,
          },
        ]),
      }),
    )
  ).value;
  assert.equal(tiedTriggerTurn.freshness, "current");
  assert.equal(tiedTriggerTurn.state, "clear");

  const mismatched = (
    await readSessionPublishSummary(
      project,
      options({
        turnHistory: history([
          {
            ...later,
            provider: "claude",
            session_id: OTHER_SESSION,
            started_at: "2026-08-25T02:00:00.000Z",
          },
        ]),
      }),
    )
  ).value;
  assert.equal(mismatched.freshness, "unknown");
  assert.equal(mismatched.state, "unknown");
  assert.equal(mismatched.coverage.state, "limited");
});

test("legacy, malformed, invalid, and identity-mismatched journals stay unknown and unchanged", async (t) => {
  const cases = [
    {
      label: "legacy",
      value: {
        schema: "barbaro.ingest-attempt.v1",
        provider: "codex",
        session_id: SESSION,
      },
      diagnostic: "invalid",
    },
    {
      label: "shallow invalid",
      value: { ...journal([attempt()]), attempts: [{ attempt_id: "only" }] },
      diagnostic: "invalid",
    },
    {
      label: "identity mismatch",
      value: journal([attempt()], { session_id: OTHER_SESSION }),
      diagnostic: "invalid",
    },
  ] as const;

  for (const candidate of cases) {
    await t.test(candidate.label, async (t) => {
      const project = await temporaryProject(t);
      const path = await writeJournal(project, candidate.value);
      const before = await readFile(path);
      const summary = (await readSessionPublishSummary(project, options())).value;
      assert.equal(summary.state, "unknown");
      assert.equal(summary.diagnostics.journal, candidate.diagnostic);
      assert.equal(await readFile(path, "utf8"), before.toString("utf8"));
      if (candidate.label === "identity mismatch") {
        assert.equal(summary.diagnostics.identity_mismatch, 1);
      }
    });
  }

  await t.test("malformed JSON", async (t) => {
    const project = await temporaryProject(t);
    const path = journalPath(project);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{bad}\n", "utf8");
    const before = await snapshotTree(project);
    const summary = (await readSessionPublishSummary(project, options())).value;
    assert.equal(summary.state, "unknown");
    assert.equal(summary.diagnostics.journal, "corrupt");
    assert.equal(summary.diagnostics.corrupt, 1);
    assert.equal(await snapshotTree(project), before);
  });
});

test("unsafe, hard-linked, and oversized journal sources are refused", async (t) => {
  await t.test("symlink", async (t) => {
    const project = await temporaryProject(t);
    const outside = join(project, "outside.json");
    await writeFile(outside, `${JSON.stringify(journal([attempt()]))}\n`, "utf8");
    const path = journalPath(project);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outside, path);
    const summary = (await readSessionPublishSummary(project, options())).value;
    assert.equal(summary.state, "unknown");
    assert.equal(summary.read_state, "refused");
    assert.equal(summary.coverage.state, "refused");
    assert.equal(summary.diagnostics.reason, "unsafe_path");
  });

  await t.test("hard link", async (t) => {
    const project = await temporaryProject(t);
    const outside = join(project, "outside.json");
    await writeFile(outside, `${JSON.stringify(journal([attempt()]))}\n`, "utf8");
    const path = journalPath(project);
    await mkdir(dirname(path), { recursive: true });
    await link(outside, path);
    const summary = (await readSessionPublishSummary(project, options())).value;
    assert.equal(summary.state, "unknown");
    assert.equal(summary.read_state, "refused");
    assert.equal(summary.diagnostics.reason, "unsafe_path");
  });

  await t.test("oversized", async (t) => {
    const project = await temporaryProject(t);
    await writeJournal(project, journal([attempt()]));
    const summary = (
      await readSessionPublishSummary(project, options({ maxFileBytes: 1 }))
    ).value;
    assert.equal(summary.state, "unknown");
    assert.equal(summary.read_state, "refused");
    assert.equal(summary.diagnostics.reason, "file_too_large");
  });
});

test("bounded old attempt history preserves a proved newest relevant state", async (t) => {
  const project = await temporaryProject(t);
  await writeJournal(project, journal([attempt()], { dropped_attempts: 2 }));
  const dropped = (
    await readSessionPublishSummary(project, options())
  ).value;
  assert.equal(dropped.state, "clear");
  assert.equal(dropped.diagnostics.dropped_attempts, 2);
  assert.equal(dropped.attempts.total, 3);
  assert.equal(dropped.attempts.hidden, 2);
  assert.equal(dropped.coverage.state, "limited");
  assert.equal(dropped.attempts.coverage.state, "limited");
  assert.equal(dropped.selected_attempt?.attempt_id, "attempt-default");
  assert.equal(dropped.outcome, "ok");
  assert.equal(dropped.freshness, "current");

  const olderOtherWorkstream = attempt({
    attempt_id: "attempt-older-other",
    triggered_at: "2026-08-25T01:30:00.000Z",
    started_at: "2026-08-25T01:30:00.001Z",
  });
  await writeJournal(project, journal([olderOtherWorkstream, attempt()]));
  const limited = (
    await readSessionPublishSummary(project, options({ attemptScanLimit: 1 }))
  ).value;
  assert.equal(limited.state, "clear");
  assert.equal(limited.diagnostics.scan_limited, true);
  assert.equal(limited.attempts.shown, 1);
  assert.equal(limited.attempts.hidden, 1);
  assert.equal(limited.attempts.coverage.state, "limited");
  assert.equal(limited.selected_attempt?.attempt_id, "attempt-default");
  assert.equal(limited.outcome, "ok");
  assert.equal(limited.freshness, "current");

  const newerOtherWorkstream = attempt({
    attempt_id: "attempt-newer-other",
    triggered_at: "2026-08-25T03:30:00.000Z",
    started_at: "2026-08-25T03:30:00.001Z",
  });
  await writeJournal(project, journal([attempt(), newerOtherWorkstream]));
  const omitted = (
    await readSessionPublishSummary(project, options({ attemptScanLimit: 1 }))
  ).value;
  assert.equal(omitted.state, "unknown");
  assert.equal(omitted.diagnostics.scan_limited, true);
  assert.equal(omitted.selected_attempt, undefined);
  assert.equal(omitted.outcome, "unknown");
  assert.equal(omitted.freshness, "unknown");
});

test("bounded history cannot prove an unfinished candidate is still pending", async (t) => {
  const project = await temporaryProject(t);
  const unfinished = unfinishedAttempt();

  await writeJournal(project, journal([unfinished]));
  const unbounded = (
    await readSessionPublishSummary(project, options())
  ).value;
  assert.equal(unbounded.state, "pending");
  assert.equal(unbounded.actionability, "waiting");
  assert.equal(unbounded.outcome, "unfinished");
  assert.equal(unbounded.selected_attempt?.attempt_id, "attempt-default");
  assert.equal(unbounded.freshness, "current");

  await writeJournal(
    project,
    journal([unfinished], { dropped_attempts: 1 }),
  );
  const dropped = (
    await readSessionPublishSummary(project, options())
  ).value;
  assert.equal(dropped.state, "unknown");
  assert.equal(dropped.actionability, "unknown");
  assert.equal(dropped.outcome, "unfinished");
  assert.equal(dropped.selected_attempt?.attempt_id, "attempt-default");
  assert.equal(dropped.freshness, "current");
  assert.equal(dropped.coverage.state, "limited");
  assert.equal(dropped.diagnostics.dropped_attempts, 1);

  const olderOtherWorkstream = unfinishedAttempt({
    attempt_id: "attempt-older-other",
    triggered_at: "2026-08-25T01:30:00.000Z",
    started_at: "2026-08-25T01:30:00.001Z",
  });
  await writeJournal(project, journal([olderOtherWorkstream, unfinished]));
  const scanLimited = (
    await readSessionPublishSummary(
      project,
      options({ attemptScanLimit: 1 }),
    )
  ).value;
  assert.equal(scanLimited.state, "unknown");
  assert.equal(scanLimited.actionability, "unknown");
  assert.equal(scanLimited.outcome, "unfinished");
  assert.equal(
    scanLimited.selected_attempt?.attempt_id,
    "attempt-default",
  );
  assert.equal(scanLimited.freshness, "current");
  assert.equal(scanLimited.coverage.state, "limited");
  assert.equal(scanLimited.diagnostics.scan_limited, true);
});

test("bounded selection follows append eviction order, not trigger timestamps", async (t) => {
  const project = await temporaryProject(t);
  const earlierAppendWithLaterTrigger = attempt({
    attempt_id: "attempt-earlier-append",
    triggered_at: "2026-08-25T02:45:00.000Z",
    started_at: "2026-08-25T02:45:00.001Z",
    outcome: "error",
  });
  const laterAppendWithEarlierTrigger = attempt({
    attempt_id: "attempt-later-append",
  });
  await writeJournal(
    project,
    journal([earlierAppendWithLaterTrigger, laterAppendWithEarlierTrigger]),
  );

  const summary = (
    await readSessionPublishSummary(project, options({ attemptScanLimit: 1 }))
  ).value;
  assert.equal(summary.diagnostics.scan_limited, true);
  assert.equal(summary.state, "clear");
  assert.equal(summary.selected_attempt?.attempt_id, "attempt-later-append");
  assert.equal(summary.outcome, "ok");
  assert.equal(summary.freshness, "current");
});

test("byte-hidden diagnostic attempts preserve selected semantic state", async (t) => {
  const project = await temporaryProject(t);
  await writeJournal(project, journal([attempt()]));

  let hidden: ReaderPublishSummary | undefined;
  for (let budget = 1_000; budget <= 8_000; budget += 128) {
    try {
      const candidate = (
        await readSessionPublishSummary(project, options({ byteBudget: budget }))
      ).value;
      if (candidate.attempts.hidden > 0) {
        hidden = candidate;
        break;
      }
    } catch {
      // Keep looking above the deterministic minimum projection size.
    }
  }
  assert.ok(hidden, "expected a budget that fits metadata but hides the attempt");
  assert.equal(hidden.state, "clear");
  assert.equal(hidden.actionability, "none");
  assert.equal(hidden.freshness, "current");
  assert.equal(hidden.selected_attempt?.attempt_id, "attempt-default");
  assert.equal(hidden.attempts.total, 1);
  assert.equal(hidden.attempts.shown, 0);
  assert.equal(hidden.attempts.coverage.state, "complete");
});

test("pending IDs and blocker text are independently bounded without losing counts", async (t) => {
  const project = await temporaryProject(t);
  const blocker = `${"x".repeat(7)}💡tail`;
  await writeJournal(
    project,
    journal([
      attempt({
        pending_agent_ids: ["agent-a", "agent-b", "agent-c"],
        pending_background_ids: ["bg-a", "bg-b", "bg-c"],
        publish_blocker: blocker,
      }),
    ]),
  );
  const projection = await readSessionPublishSummary(
    project,
    options({ pendingIdLimit: 1, reasonBytes: 8 }),
  );
  const summary = projection.value;

  assert.equal(summary.state, "blocked");
  assert.equal(summary.pending_agent_ids.shown, 1);
  assert.equal(summary.pending_agent_ids.total, 3);
  assert.equal(summary.pending_agent_ids.hidden, 2);
  assert.equal(summary.pending_background_ids.shown, 1);
  assert.equal(summary.pending_background_ids.total, 3);
  assert.equal(summary.pending_background_ids.hidden, 2);
  assert.deepEqual(summary.selected_attempt?.publish_blocker, {
    text: "xxxxxxx",
    truncated: true,
    utf8_bytes: { shown: 7, total: Buffer.byteLength(blocker, "utf8") },
  });
  assertSummaryCollections(summary);
  assert.equal(projection.utf8_bytes, stableJsonUtf8Bytes(projection));
});

test("incomplete or malformed membership history never attributes current membership backwards", async (t) => {
  const project = await temporaryProject(t);
  await writeJournal(project, journal([attempt()]));
  const hiddenMembership: ReaderCollection<SessionWorkstreamMembership> = {
    shown: 1,
    total: 2,
    hidden: 1,
    items: [{ workstream_id: CURRENT_WORKSTREAM, from: CURRENT_FROM }],
    read_state: "ok",
    coverage: { state: "complete" },
  };
  const incomplete = (
    await readSessionPublishSummary(
      project,
      options({
        membershipHistory: {
          provider: "codex",
          session_id: SESSION,
          memberships: hiddenMembership,
        },
      }),
    )
  ).value;
  assert.equal(incomplete.state, "unknown");
  assert.equal(incomplete.selected_attempt, undefined);
  assert.equal(incomplete.coverage.state, "limited");

  const malformed = memberships([
    { workstream_id: WORKSTREAM, from: TARGET_FROM },
    { workstream_id: FIRST_WORKSTREAM, from: FIRST_FROM },
  ]);
  const invalid = (
    await readSessionPublishSummary(
      project,
      options({
        membershipHistory: {
          provider: "codex",
          session_id: SESSION,
          memberships: malformed,
        },
      }),
    )
  ).value;
  assert.equal(invalid.state, "unknown");
  assert.equal(invalid.selected_attempt, undefined);
  assert.equal(invalid.read_state, "degraded");

  const refusedMembership: ReaderCollection<SessionWorkstreamMembership> = {
    shown: 0,
    total: 0,
    hidden: 0,
    items: [],
    read_state: "refused",
    coverage: { state: "refused", reason: "unsafe_path" },
  };
  const refused = (
    await readSessionPublishSummary(
      project,
      options({
        membershipHistory: {
          provider: "codex",
          session_id: SESSION,
          memberships: refusedMembership,
        },
      }),
    )
  ).value;
  assert.equal(refused.state, "unknown");
  assert.equal(refused.read_state, "refused");
  assert.equal(refused.coverage.state, "refused");
  assert.equal(refused.attempts.read_state, "refused");
  assert.equal(refused.attempts.coverage.state, "refused");

  const wrongSession = (
    await readSessionPublishSummary(
      project,
      options({
        membershipHistory: {
          provider: "codex",
          session_id: OTHER_SESSION,
          memberships: memberships(),
        },
      }),
    )
  ).value;
  assert.equal(wrongSession.state, "unknown");
  assert.equal(wrongSession.selected_attempt, undefined);
  assert.equal(wrongSession.read_state, "degraded");
  assert.equal(wrongSession.coverage.state, "limited");
});

test("an unsafe dropped-attempt total is structurally invalid", async (t) => {
  const project = await temporaryProject(t);
  await writeJournal(
    project,
    journal([attempt()], { dropped_attempts: Number.MAX_SAFE_INTEGER }),
  );
  const summary = (await readSessionPublishSummary(project, options())).value;
  assert.equal(summary.state, "unknown");
  assert.equal(summary.diagnostics.journal, "invalid");
  assert.equal(summary.diagnostics.invalid, 1);
  assert.equal(summary.attempts.total, 0);
});

test("migrated legacy attempts and duplicate attempt identities never clear", async (t) => {
  await t.test("migrated legacy attempt", async (t) => {
    const project = await temporaryProject(t);
    await writeJournal(
      project,
      journal([
        attempt({ migrated_from_schema: "barbaro.ingest-attempt.v1" }),
      ]),
    );
    const summary = (await readSessionPublishSummary(project, options())).value;
    assert.equal(summary.state, "unknown");
    assert.equal(summary.read_state, "degraded");
    assert.equal(summary.coverage.state, "limited");
    assert.equal(summary.diagnostics.reason, "legacy_attempt");
    assert.equal(summary.pending_agent_ids.read_state, "degraded");
    assert.equal(summary.pending_agent_ids.coverage.state, "limited");
    assert.equal(summary.pending_background_ids.read_state, "degraded");
    assert.equal(summary.pending_background_ids.coverage.state, "limited");
    assert.equal(
      summary.attempts.items[0]?.migrated_from_schema,
      "barbaro.ingest-attempt.v1",
    );
  });

  await t.test("duplicate attempt ID", async (t) => {
    const project = await temporaryProject(t);
    await writeJournal(
      project,
      journal([
        attempt({ attempt_id: "duplicate" }),
        attempt({
          attempt_id: "duplicate",
          publish_blocker: "must not win by file order",
        }),
      ]),
    );
    const summary = (await readSessionPublishSummary(project, options())).value;
    assert.equal(summary.state, "unknown");
    assert.equal(summary.diagnostics.journal, "invalid");
    assert.equal(summary.diagnostics.invalid, 1);
    assert.equal(summary.selected_attempt, undefined);
  });
});

test("no relevant attempt exposes unknown pending fields rather than authoritative zeros", async (t) => {
  const project = await temporaryProject(t);
  await writeJournal(project, journal([]));
  const empty = (await readSessionPublishSummary(project, options())).value;
  assert.equal(empty.state, "unknown");
  assert.equal(empty.selected_attempt, undefined);
  assert.equal(empty.pending_agent_ids.total, 0);
  assert.equal(empty.pending_agent_ids.read_state, "degraded");
  assert.equal(empty.pending_agent_ids.coverage.state, "limited");
  assert.equal(empty.pending_background_ids.read_state, "degraded");
  assert.equal(empty.pending_background_ids.coverage.state, "limited");

  await writeJournal(
    project,
    journal([
      attempt({
        triggered_at: "2026-08-25T03:30:00.000Z",
        started_at: "2026-08-25T03:30:00.001Z",
      }),
    ]),
  );
  const otherScope = (
    await readSessionPublishSummary(project, options())
  ).value;
  assert.equal(otherScope.state, "unknown");
  assert.equal(otherScope.selected_attempt, undefined);
  assert.equal(otherScope.pending_agent_ids.read_state, "degraded");
  assert.equal(otherScope.pending_agent_ids.coverage.state, "limited");
});
