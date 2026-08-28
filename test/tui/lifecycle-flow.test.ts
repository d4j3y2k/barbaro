import assert from "node:assert/strict";
import test from "node:test";

import {
  beginLifecycle,
  captureLifecycleConfirmationEvidence,
  captureLifecycleTarget,
  desiredLifecycleStatus,
  lifecycleActivityLine,
  lifecycleActionFor,
  lifecycleArgv,
  lifecycleDecisionMarkerVisible,
  lifecycleEvidenceBenchLine,
  lifecycleJoinedBenchLine,
  lifecycleJoinedLine,
  lifecycleTraversalGate,
  lifecycleTraversalProgressAtTick,
  lifecycleUnreadLine,
  lifecycleWarning,
  LIFECYCLE_MOTION_INTERVAL_MS,
  LIFECYCLE_PASS_TICKS,
  parseLifecycleWriterRecord,
  settleLifecycle,
  type LifecycleRecord,
  type LifecycleTarget,
  type LifecycleWriterOutcome,
} from "../../src/tui/lifecycle.js";
import type { ReaderCatalogueWorkstream } from "../../src/reader/catalogue.js";

import {
  collection,
  FIXTURE_REFERENCE,
  makeItem,
} from "./comfort-fixtures.js";

const ID = `ws_${"d".repeat(32)}`;
const OPEN: LifecycleRecord = {
  workstream_id: ID,
  name: "motion-study",
  title: "Explore the motion-study interface",
  status: "open",
  revision: 7,
};

const TARGET: LifecycleTarget = captureLifecycleTarget(OPEN);
const MEMBER = {
  provider: "codex",
  session_id: `ses_${"1".repeat(32)}`,
  membership_from: "2026-08-25T09:00:00.000Z",
};

function evidenceItem(): ReaderCatalogueWorkstream {
  const base = makeItem({
    name: OPEN.name,
    workstreamId: ID,
    revision: OPEN.revision,
    lastKnownAt: "2026-08-25T11:48:00.000Z",
  });
  return {
    ...base,
    record: { ...base.record, title: OPEN.title! },
    members: collection([MEMBER]),
    unread: collection([
      {
        key: {
          provider: MEMBER.provider,
          session_id: MEMBER.session_id,
          workstream_id: ID,
          membership_from: MEMBER.membership_from,
        },
        cursor_state: "persisted" as const,
        read_state: "ok" as const,
        coverage: { state: "complete" as const },
        status: "ready" as const,
        unread_count: 3,
      },
    ]),
  };
}

function outcome(
  overrides: Partial<LifecycleWriterOutcome> = {},
): LifecycleWriterOutcome {
  return {
    code: 0,
    stdout: JSON.stringify({ ...OPEN, status: "completed", revision: 8 }),
    stderr: "",
    cancelled: false,
    ...overrides,
  };
}

test("the decision marker blinks in 500 ms phases only during live motion", () => {
  assert.equal(LIFECYCLE_MOTION_INTERVAL_MS, 100);
  assert.deepEqual(
    Array.from({ length: 20 }, (_unused, tick) =>
      lifecycleDecisionMarkerVisible(tick, "live"),
    ),
    [
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ],
  );
  for (const motion of ["paused", "off"] as const) {
    for (const tick of [0, 5, 9, 10, 105]) {
      assert.equal(lifecycleDecisionMarkerVisible(tick, motion), true);
    }
  }
});

test("traversal progress covers all eleven plates from edge to edge", () => {
  assert.equal(LIFECYCLE_PASS_TICKS, 11);
  const firstPass = Array.from(
    { length: LIFECYCLE_PASS_TICKS },
    (_unused, tick) => lifecycleTraversalProgressAtTick(tick),
  );
  assert.deepEqual(
    firstPass.map((progress) => progress.frameIndex),
    Array.from({ length: LIFECYCLE_PASS_TICKS }, (_unused, frame) => frame),
  );
  assert.equal(firstPass[0]!.position, 0);
  assert.equal(firstPass.at(-1)!.position, 1);
  assert.equal(firstPass.every((progress) => !progress.atPassBoundary), true);

  const reset = lifecycleTraversalProgressAtTick(LIFECYCLE_PASS_TICKS);
  assert.deepEqual(reset, {
    frameIndex: 0,
    position: 0,
    completedPasses: 1,
    atPassBoundary: true,
  });
  assert.equal(Object.isFrozen(reset), true);
  assert.deepEqual(
    lifecycleTraversalProgressAtTick(LIFECYCLE_PASS_TICKS * 2),
    {
      frameIndex: 0,
      position: 0,
      completedPasses: 2,
      atPassBoundary: true,
    },
  );
});

test("the traversal gate waits, loops, finishes, and interrupts honestly", () => {
  const gate = (
    tick: number,
    settlement?: "confirmed" | "failed" | "cancelled" | "unknown",
  ) =>
    lifecycleTraversalGate(
      lifecycleTraversalProgressAtTick(tick),
      settlement,
    );

  // A fast confirmation cannot cut short the first pass.
  assert.equal(gate(0, "confirmed"), "continue");
  assert.equal(gate(LIFECYCLE_PASS_TICKS - 1, "confirmed"), "continue");
  assert.equal(gate(LIFECYCLE_PASS_TICKS, "confirmed"), "finish");
  assert.equal(
    lifecycleTraversalGate(
      {
        frameIndex: 0,
        position: 0,
        completedPasses: 0,
        atPassBoundary: true,
      },
      "confirmed",
    ),
    "continue",
  );

  // Unresolved work crosses boundaries and loops complete passes.
  assert.equal(gate(LIFECYCLE_PASS_TICKS), "continue");
  assert.equal(gate(LIFECYCLE_PASS_TICKS * 2), "continue");

  // Confirmation during a later pass waits for that pass to finish.
  assert.equal(gate(LIFECYCLE_PASS_TICKS + 4, "confirmed"), "continue");
  assert.equal(gate(LIFECYCLE_PASS_TICKS * 2, "confirmed"), "finish");

  // Every non-success settlement interrupts without waiting for a boundary.
  for (const settlement of ["failed", "cancelled", "unknown"] as const) {
    assert.equal(gate(4, settlement), "interrupt");
  }
});

test("lifecycle animation clocks reject invalid ticks", () => {
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => lifecycleDecisionMarkerVisible(invalid, "live"),
      /non-negative integer/u,
    );
    assert.throws(
      () => lifecycleTraversalProgressAtTick(invalid),
      /non-negative integer/u,
    );
  }
});

test("the dynamic action and confirmation snapshot follow record status", () => {
  assert.equal(lifecycleActionFor("open"), "complete");
  assert.equal(lifecycleActionFor("completed"), "reopen");
  assert.equal(desiredLifecycleStatus("complete"), "completed");
  assert.equal(desiredLifecycleStatus("reopen"), "open");

  const started = beginLifecycle(evidenceItem(), FIXTURE_REFERENCE);
  assert.equal(started.kind, "confirm");
  assert.equal(started.action, "complete");
  assert.deepEqual(started.target, TARGET);
  assert.equal(started.evidence.title, OPEN.title);
  assert.equal(
    lifecycleJoinedLine(started.evidence.joined),
    "1 joined session · Codex 1",
  );
  assert.equal(lifecycleJoinedBenchLine(started.evidence.joined), "Codex 1");
  assert.equal(
    lifecycleActivityLine(
      started.evidence.activity,
      started.evidence.referenceAt,
    ),
    "Latest proven activity · 12 minutes ago",
  );
  assert.equal(
    lifecycleUnreadLine(started.evidence.unread),
    "A Codex session here has 3 unread turns.",
  );
  assert.equal(
    lifecycleEvidenceBenchLine(started.evidence),
    "3 unread · latest activity 12m",
  );
  assert.equal(Object.isFrozen(started), true);
  assert.equal(Object.isFrozen(started.target), true);
  assert.equal(Object.isFrozen(started.evidence), true);
  assert.equal(Object.isFrozen(started.evidence.joined), true);
  assert.equal(Object.isFrozen(started.evidence.joined.providers), true);
  assert.equal(Object.isFrozen(started.evidence.joined.providers[0]!), true);
  assert.equal(Object.isFrozen(started.evidence.activity), true);
  assert.equal(Object.isFrozen(started.evidence.unread), true);
  assert.equal(Object.isFrozen(started.evidence.unread.providers), true);
  assert.equal(Object.isFrozen(started.evidence.unread.providers[0]!), true);
});

test("incomplete confirmation evidence stays qualified and never becomes zero", () => {
  const exact = evidenceItem();
  const { title: _title, ...recordWithoutTitle } = exact.record;
  const item: ReaderCatalogueWorkstream = {
    ...exact,
    record: recordWithoutTitle,
    members: {
      ...collection([MEMBER]),
      total: 2,
      hidden: 1,
      read_state: "degraded",
      coverage: { state: "limited", reason: "test" },
    },
    activity: {
      ...exact.activity,
      full_history: { state: "limited", reason: "test" },
      turns: {
        ...exact.activity.turns,
        read_state: "degraded",
        coverage: { state: "limited", reason: "test" },
      },
    },
    unread: {
      ...exact.unread!,
      total: 2,
      hidden: 1,
      read_state: "degraded",
      coverage: { state: "limited", reason: "test" },
    },
  };
  const evidence = captureLifecycleConfirmationEvidence(
    item,
    FIXTURE_REFERENCE,
  );
  const lines = [
    lifecycleJoinedLine(evidence.joined),
    lifecycleActivityLine(evidence.activity, evidence.referenceAt),
    lifecycleUnreadLine(evidence.unread),
  ];
  assert.equal(evidence.title, undefined);
  assert.deepEqual(lines, [
    "Joined total unknown · Codex 1 shown",
    "Latest known activity · 12 minutes ago · incomplete",
    "Unread total unknown · Codex 3 known",
  ]);
  assert.equal(
    lifecycleJoinedBenchLine(evidence.joined),
    "Codex 1 shown · joined total unknown",
  );
  assert.doesNotMatch(lines.join("\n"), /No joined|No unread/u);

  const future = captureLifecycleConfirmationEvidence(
    {
      ...item,
      activity: {
        ...item.activity,
        last_known_activity_at: "2026-08-25T12:01:00.000Z",
      },
    },
    FIXTURE_REFERENCE,
  );
  assert.deepEqual(future.activity, {
    kind: "unknown",
    history: "incomplete",
  });
  assert.equal(
    lifecycleActivityLine(future.activity, future.referenceAt),
    "Activity history is incomplete",
  );
  assert.equal(
    lifecycleActivityLine(
      { kind: "latest", at: "2026-08-25T12:01:00.000Z" },
      FIXTURE_REFERENCE,
    ),
    "Latest activity is unknown",
  );
});

test("unread evidence stays recipient-relative and rejects unproven summaries", () => {
  const exact = evidenceItem();
  const empty = captureLifecycleConfirmationEvidence(
    makeItem({ activityState: "proven_empty" }),
    FIXTURE_REFERENCE,
  );
  assert.equal(
    lifecycleUnreadLine(empty.unread),
    "No unread turns for joined sessions",
  );
  assert.equal(empty.unread.completeness, "complete");

  const secondMember = {
    provider: "codex",
    session_id: `ses_${"2".repeat(32)}`,
    membership_from: "2026-08-25T10:00:00.000Z",
  };
  const summary = exact.unread!.items[0]!;
  const secondSummary = {
    ...summary,
    key: {
      ...summary.key,
      session_id: secondMember.session_id,
      membership_from: secondMember.membership_from,
    },
  };
  const multi = captureLifecycleConfirmationEvidence(
    {
      ...exact,
      members: collection([MEMBER, secondMember]),
      unread: collection([summary, secondSummary]),
    },
    FIXTURE_REFERENCE,
  );
  assert.equal(
    lifecycleUnreadLine(multi.unread),
    "Joined-session unread · Codex 6 across 2 sessions",
  );
  assert.equal(
    lifecycleEvidenceBenchLine(multi),
    "6 unread across 2 sessions · latest activity 12m",
  );

  const duplicate = captureLifecycleConfirmationEvidence(
    { ...exact, unread: collection([summary, summary]) },
    FIXTURE_REFERENCE,
  );
  assert.equal(lifecycleUnreadLine(duplicate.unread), "Unread count is unknown");

  const degraded = captureLifecycleConfirmationEvidence(
    {
      ...exact,
      unread: collection([
        {
          ...summary,
          read_state: "degraded",
          coverage: { state: "limited", reason: "test" },
        },
      ]),
    },
    FIXTURE_REFERENCE,
  );
  assert.equal(lifecycleUnreadLine(degraded.unread), "Unread count is unknown");

  const stale = captureLifecycleConfirmationEvidence(
    {
      ...exact,
      unread: collection([
        {
          ...summary,
          key: { ...summary.key, membership_from: "2026-08-25T08:00:00.000Z" },
        },
      ]),
    },
    FIXTURE_REFERENCE,
  );
  assert.equal(lifecycleUnreadLine(stale.unread), "Unread count is unknown");
});

test("the public lifecycle argv is immutable, fielded, and ID-targeted", () => {
  const argv = lifecycleArgv("complete", TARGET, "/project root");
  assert.deepEqual(argv, [
    "workstream",
    "complete",
    ID,
    "--project-root",
    "/project root",
  ]);
  assert.equal(Object.isFrozen(argv), true);
  assert.equal(argv.includes("motion-study"), false);

  assert.deepEqual(lifecycleArgv("reopen", TARGET, "/root"), [
    "workstream",
    "reopen",
    ID,
    "--project-root",
    "/root",
  ]);
});

test("writer evidence is bound to immutable identity, desired status, and revision", () => {
  assert.deepEqual(
    parseLifecycleWriterRecord(
      JSON.stringify({ ...OPEN, status: "completed", revision: 8 }),
      "complete",
      TARGET,
    ),
    { ...OPEN, status: "completed", revision: 8 },
  );
  assert.equal(
    parseLifecycleWriterRecord(
      JSON.stringify({ ...OPEN, workstream_id: `ws_${"e".repeat(32)}` }),
      "complete",
      TARGET,
    ),
    undefined,
  );
  assert.equal(
    parseLifecycleWriterRecord(
      JSON.stringify({ ...OPEN, status: "open", revision: 8 }),
      "complete",
      TARGET,
    ),
    undefined,
  );
  assert.equal(
    parseLifecycleWriterRecord(
      JSON.stringify({ ...OPEN, status: "completed", revision: 6 }),
      "complete",
      TARGET,
    ),
    undefined,
  );
  assert.equal(
    parseLifecycleWriterRecord("not json", "complete", TARGET),
    undefined,
  );
});

test("reconciled desired status wins every writer race and preserves warnings", () => {
  const completed: LifecycleRecord = {
    ...OPEN,
    name: "renamed-while-pending",
    status: "completed",
    revision: 8,
  };
  const settled = settleLifecycle({
    action: "complete",
    target: TARGET,
    outcome: outcome({
      code: null,
      stdout: "",
      stderr: "member live\ncompletion does not stop it\u001b[0m",
      cancelled: true,
    }),
    lookup: completed,
  });
  assert.deepEqual(settled, {
    kind: "confirmed",
    action: "complete",
    target: TARGET,
    record: completed,
    writerConfirmed: false,
    warning: "member live completion does not stop it",
  });

  assert.equal(
    lifecycleWarning("\n member live\r\n completion does not stop it \n"),
    "member live completion does not stop it",
  );
  assert.equal(lifecycleWarning("\r\n"), undefined);
});

test("writer corroboration is reported only when it matches the reconciled revision", () => {
  const completed: LifecycleRecord = {
    ...OPEN,
    status: "completed",
    revision: 8,
  };
  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome(),
      lookup: completed,
    }).kind,
    "confirmed",
  );
  const exact = settleLifecycle({
    action: "complete",
    target: TARGET,
    outcome: outcome(),
    lookup: completed,
  });
  assert.equal(exact.kind === "confirmed" && exact.writerConfirmed, true);

  const raced = settleLifecycle({
    action: "complete",
    target: TARGET,
    outcome: outcome(),
    lookup: { ...completed, revision: 9 },
  });
  assert.equal(raced.kind === "confirmed" && raced.writerConfirmed, false);
});

test("an idempotent desired revision is success, but stdout alone never is", () => {
  const alreadyCompleted: LifecycleRecord = {
    ...OPEN,
    status: "completed",
    revision: 7,
  };
  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome({
        stdout: JSON.stringify(alreadyCompleted),
      }),
      lookup: alreadyCompleted,
    }).kind,
    "confirmed",
  );

  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome(),
      lookup: "unknown",
    }).kind,
    "unknown",
  );
  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome(),
      lookup: "absent",
    }).kind,
    "unknown",
  );
});

test("unchanged proof distinguishes failure and cancellation; races stay unknown", () => {
  assert.deepEqual(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome({ code: 9, stdout: "", stderr: "writer refused" }),
      lookup: OPEN,
    }),
    {
      kind: "failed",
      action: "complete",
      target: TARGET,
      message: "The writer exited 9",
      warning: "writer refused",
    },
  );
  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome({ code: null, stdout: "", cancelled: true }),
      lookup: OPEN,
    }).kind,
    "cancelled",
  );
  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome({ code: 1, stdout: "" }),
      lookup: { ...OPEN, revision: 9 },
    }).kind,
    "unknown",
  );
  assert.equal(
    settleLifecycle({
      action: "complete",
      target: TARGET,
      outcome: outcome({ code: 0, stdout: "not json" }),
      lookup: OPEN,
    }).kind,
    "unknown",
  );
});

test("reopen uses the same status-and-revision settlement matrix", () => {
  const completed: LifecycleRecord = {
    ...OPEN,
    status: "completed",
    revision: 8,
  };
  const target = captureLifecycleTarget(completed);
  const reopened: LifecycleRecord = {
    ...completed,
    status: "open",
    revision: 9,
  };
  assert.deepEqual(
    settleLifecycle({
      action: "reopen",
      target,
      outcome: {
        code: 0,
        stdout: JSON.stringify(reopened),
        stderr: "",
        cancelled: false,
      },
      lookup: reopened,
    }),
    {
      kind: "confirmed",
      action: "reopen",
      target,
      record: reopened,
      writerConfirmed: true,
    },
  );
});

test("invalid target evidence is rejected before any writer can be built", () => {
  assert.throws(
    () => captureLifecycleTarget({ ...OPEN, workstream_id: "motion-study" }),
    /invalid workstream ID/u,
  );
  assert.throws(
    () => captureLifecycleTarget({ ...OPEN, revision: 0 }),
    /invalid revision/u,
  );
});
