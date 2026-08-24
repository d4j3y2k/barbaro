import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReaderActionSummary,
  ReaderActiveSummary,
  ReaderContentSummary,
  ReaderContextV1,
  ReaderProjection,
  ReaderTurnSummary,
} from "../../src/reader/types.js";
import {
  buildDashboardViewModel,
  shortSessionLabel,
  shortWorkstreamLabel,
} from "../../src/tui/model.js";

const WS_A = `ws_${"a".repeat(32)}`;
const WS_B = `ws_${"b".repeat(32)}`;
const SESSION_A = `ses_${"1".repeat(32)}`;
const SESSION_B = `ses_${"2".repeat(32)}`;
const SESSION_C = `ses_${"3".repeat(32)}`;

function content(text: string): ReaderContentSummary {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    fidelity: "verbatim",
    truncated: { canonical: false, projection: false },
    utf8_bytes: { shown: bytes, canonical: bytes, original: bytes },
    redactions: [],
  };
}

function active(
  suffix: string,
  overrides: Partial<ReaderActiveSummary> = {},
): ReaderActiveSummary {
  return {
    lease_id: `lease_${suffix.repeat(32)}`,
    provider: "codex",
    session_id: SESSION_A,
    agent_id: "root",
    state: "working",
    claims: { shown: 0, total: 0, items: [] },
    unknown_write_scope: false,
    revision: 1,
    updated_at: "2026-08-21T10:00:00.000Z",
    expires_at: "2026-08-21T10:01:00.000Z",
    source_refs: 1,
    ...overrides,
  };
}

function action(
  suffix: string,
  overrides: Partial<ReaderActionSummary> = {},
): ReaderActionSummary {
  return {
    action_id: `act_${suffix.repeat(32)}`,
    kind: "tool",
    outcome: "success",
    source_refs: 1,
    ...overrides,
  };
}

function turn(
  suffix: string,
  overrides: Partial<ReaderTurnSummary> = {},
): ReaderTurnSummary {
  return {
    turn_id: `turn_${suffix.repeat(32)}`,
    provider: "codex",
    session_id: SESSION_A,
    sequence: 1,
    agent_id: "root",
    started_at: "2026-08-21T09:59:00.000Z",
    ended_at: "2026-08-21T10:00:00.000Z",
    outcome: "success",
    request: content(`request ${suffix}`),
    actions: { shown: 0, total: 0, items: [] },
    evidence_refs: { shown: 0, total: 0, items: [] },
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: { shown: 0, total: 0, items: [] },
      evidence_refs: { shown: 0, total: 0, items: [] },
    },
    source_refs: 1,
    ...overrides,
  };
}

function projection(
  activeItems: readonly ReaderActiveSummary[],
  turnItems: readonly ReaderTurnSummary[],
  options: {
    readonly activeTotal?: number;
    readonly turnTotal?: number;
    readonly scope?: string;
  } = {},
): ReaderProjection<ReaderContextV1> {
  return {
    byte_budget: 65_536,
    utf8_bytes: 4_096,
    value: {
      schema: "barbaro.reader.context.v1",
      ...(options.scope === undefined ? {} : { workstream_id: options.scope }),
      active: {
        shown: activeItems.length,
        total: options.activeTotal ?? activeItems.length,
        items: activeItems,
      },
      turns: {
        shown: turnItems.length,
        total: options.turnTotal ?? turnItems.length,
        items: turnItems,
      },
      diagnostics: {
        feed_files: 4,
        malformed_feed_records: 1,
        invalid_feed_records: 0,
        partial_feed_files: 0,
        scan_limited_feed_files: 2,
        invalid_active_records: 0,
      },
    },
  };
}

function richFixture(): ReaderProjection<ReaderContextV1> {
  const unscoped = active("1", {
    provider: "claude",
    session_id: SESSION_A,
    agent_id: "worker",
    intent: content("raw intent\nkept verbatim"),
    claims: {
      shown: 1,
      total: 1,
      items: [
        { path: "src/shared.ts", mode: "write", confidence: "inferred" },
      ],
    },
    unknown_write_scope: true,
  });
  const scopedA = active("2", {
    workstream_id: WS_A,
    session_id: SESSION_C,
    agent_id: "root",
    claims: {
      shown: 1,
      total: 1,
      items: [{ path: "src/a.ts", mode: "write", confidence: "exact" }],
    },
  });
  const scopedBRoot = active("3", {
    workstream_id: WS_B,
    session_id: SESSION_B,
    agent_id: "root",
    current_action: {
      kind: "file_change",
      path: "src/shared.ts",
    },
    claims: {
      shown: 3,
      total: 4,
      items: [
        { path: "src/shared.ts", mode: "write", confidence: "inferred" },
        { path: "src/root.ts", mode: "write", confidence: "exact" },
        { path: "src/shared.ts", mode: "write", confidence: "exact" },
      ],
    },
  });
  const scopedBChild = active("4", {
    workstream_id: WS_B,
    session_id: SESSION_B,
    agent_id: "child",
    updated_at: "2026-08-21T10:00:01.000Z",
    claims: {
      shown: 1,
      total: 1,
      items: [
        { path: "src/shared.ts", mode: "write", confidence: "inferred" },
      ],
    },
  });

  const unscopedTurn = turn("1", {
    provider: "claude",
    session_id: SESSION_A,
    ended_at: "2026-08-21T10:03:00.000Z",
    outcome: "failed",
    actions: {
      shown: 2,
      total: 2,
      items: [
        action("2", { kind: "command" }),
        action("1", { kind: "file_change", path: "src/shared.ts" }),
      ],
    },
  });
  const scopedATurn = turn("2", {
    workstream_id: WS_A,
    session_id: SESSION_C,
    ended_at: "2026-08-21T10:02:00.000Z",
    outcome: "blocked",
    actions: {
      shown: 1,
      total: 1,
      items: [action("3", { kind: "file_change", path: "src/a.ts" })],
    },
    subagents: {
      total: 1,
      by_role: [{ role: "reviewer", count: 1 }],
      outcomes: { blocked: 1 },
      changed_paths: { shown: 0, total: 0, items: [] },
      evidence_refs: { shown: 0, total: 0, items: [] },
    },
  });
  const scopedBTurn = turn("3", {
    workstream_id: WS_B,
    session_id: SESSION_B,
    ended_at: "2026-08-21T10:04:00.000Z",
    outcome: "success",
    actions: {
      shown: 1,
      total: 3,
      items: [action("4", { kind: "test" })],
    },
    subagents: {
      total: 2,
      by_role: [{ role: "implementer", count: 2 }],
      outcomes: { success: 2 },
      changed_paths: {
        shown: 2,
        total: 3,
        items: ["src/shared.ts", "src/b.ts"],
      },
      evidence_refs: { shown: 0, total: 0, items: [] },
    },
  });

  // Deliberately not grouped or chronological. The view model owns ordering.
  return projection(
    [scopedBRoot, scopedA, unscoped, scopedBChild],
    [scopedBTurn, unscopedTurn, scopedATurn],
    { activeTotal: 6, turnTotal: 5 },
  );
}

test("groups and tags visible actors and turns by workstream then session", () => {
  const model = buildDashboardViewModel(richFixture());

  assert.deepEqual(
    model.workstreams.map((workstream) => workstream.tag.label),
    ["unscoped", "ws_aaaaaaaa", "ws_bbbbbbbb"],
  );
  assert.deepEqual(
    model.workstreams.map((workstream) =>
      workstream.sessions.map((session) => session.label),
    ),
    [["ses_11111111"], ["ses_33333333"], ["ses_22222222"]],
  );
  assert.deepEqual(
    model.active.items.map((actor) => [
      actor.workstream.label,
      actor.sessionLabel,
      actor.agentId,
    ]),
    [
      ["unscoped", "ses_11111111", "worker"],
      ["ws_aaaaaaaa", "ses_33333333", "root"],
      ["ws_bbbbbbbb", "ses_22222222", "child"],
      ["ws_bbbbbbbb", "ses_22222222", "root"],
    ],
  );
  assert.deepEqual(
    model.turns.items.map((item) => item.workstream.label),
    ["unscoped", "ws_aaaaaaaa", "ws_bbbbbbbb"],
  );

  const unscopedActor = model.active.items[0]!;
  assert.equal(unscopedActor.intent?.text, "raw intent\nkept verbatim");
  assert.equal(unscopedActor.unknownWriteScope, true);
  assert.deepEqual(unscopedActor.claims.inferred.map((claim) => claim.path), [
    "src/shared.ts",
  ]);

  const root = model.active.items.find((actor) => actor.leaseId.endsWith("3".repeat(32)))!;
  assert.equal(root.currentAction?.path, "src/shared.ts");
  assert.deepEqual(root.claims.counts, { shown: 3, total: 4, hidden: 1 });
  assert.deepEqual(root.claims.exact.map((claim) => claim.path), [
    "src/root.ts",
    "src/shared.ts",
  ]);
  assert.deepEqual(root.claims.inferred.map((claim) => claim.path), [
    "src/shared.ts",
  ]);
});

test("reports visible advisory claim overlaps without inventing locks", () => {
  const model = buildDashboardViewModel(richFixture());

  assert.equal(model.overlaps.length, 1);
  const overlap = model.overlaps[0]!;
  assert.equal(overlap.path, "src/shared.ts");
  assert.equal(overlap.advisory, true);
  // The root actor has both inferred and exact rows, but remains one claimant.
  assert.equal(overlap.claimants.length, 3);
  assert.equal(overlap.exactClaimants.length, 1);
  assert.equal(overlap.inferredClaimants.length, 2);
  assert.deepEqual(
    overlap.claimants.map((claimant) => [
      claimant.workstream.label,
      claimant.agentId,
      claimant.confidence,
    ]),
    [
      ["unscoped", "worker", "inferred"],
      ["ws_bbbbbbbb", "child", "inferred"],
      ["ws_bbbbbbbb", "root", "exact"],
    ],
  );
  assert.ok(
    model.active.items.every(
      (actor) => !actor.overlapPaths.includes("src/a.ts"),
    ),
  );
  assert.deepEqual(
    model.active.items
      .filter((actor) => actor.overlapPaths.length > 0)
      .map((actor) => actor.overlapPaths),
    [["src/shared.ts"], ["src/shared.ts"], ["src/shared.ts"]],
  );
});

test("keeps hidden counts separate from visible-only analytics and paths", () => {
  const model = buildDashboardViewModel(richFixture());

  assert.deepEqual(model.active.counts, { shown: 4, total: 6, hidden: 2 });
  assert.deepEqual(model.turns.counts, { shown: 3, total: 5, hidden: 2 });
  assert.deepEqual([...model.metrics.outcomes], [
    ["blocked", 1],
    ["failed", 1],
    ["success", 1],
  ]);
  assert.deepEqual([...model.metrics.actions], [
    ["command", 1],
    ["file_change", 2],
    ["test", 1],
  ]);
  assert.deepEqual(model.metrics.actionVisibility, {
    shown: 4,
    total: 6,
    hidden: 2,
  });
  assert.deepEqual([...model.metrics.providers], [
    ["claude", 1],
    ["codex", 2],
  ]);
  assert.equal(model.metrics.subagents, 3);
  assert.deepEqual(model.metrics.paths, {
    items: ["src/a.ts", "src/b.ts", "src/shared.ts"],
    visibleDistinct: 3,
    visibleOccurrences: 4,
    hiddenChangedPathEntries: 1,
    possiblyHiddenInActions: 2,
    hiddenTurns: 2,
    complete: false,
  });

  assert.equal(model.diagnostics.feedFiles, 4);
  assert.equal(model.diagnostics.issueCount, 3);
  assert.equal(model.diagnostics.healthy, false);
  assert.deepEqual(model.diagnostics.issues, [
    { id: "malformed_feed_records", label: "malformed feed", count: 1 },
    { id: "scan_limited_feed_files", label: "scan limited", count: 2 },
  ]);
});

test("orders groups, records, claims, overlaps, metrics, and paths deterministically", () => {
  const original = richFixture();
  const reversed: ReaderProjection<ReaderContextV1> = {
    ...original,
    value: {
      ...original.value,
      active: {
        ...original.value.active,
        items: [...original.value.active.items]
          .reverse()
          .map((actor) => ({
            ...actor,
            claims: { ...actor.claims, items: [...actor.claims.items].reverse() },
          })),
      },
      turns: {
        ...original.value.turns,
        items: [...original.value.turns.items]
          .reverse()
          .map((item) => ({
            ...item,
            actions: { ...item.actions, items: [...item.actions.items].reverse() },
            subagents: {
              ...item.subagents,
              changed_paths: {
                ...item.subagents.changed_paths,
                items: [...item.subagents.changed_paths.items].reverse(),
              },
            },
          })),
      },
    },
  };

  const left = buildDashboardViewModel(original);
  const right = buildDashboardViewModel(reversed);
  assert.deepEqual(
    left.active.items.map((actor) => [
      actor.key,
      actor.claims.items.map((claim) => [claim.path, claim.confidence]),
    ]),
    right.active.items.map((actor) => [
      actor.key,
      actor.claims.items.map((claim) => [claim.path, claim.confidence]),
    ]),
  );
  assert.deepEqual(
    left.turns.items.map((item) => [
      item.key,
      item.actions.items.map((itemAction) => itemAction.action_id),
      item.changedPaths.items,
    ]),
    right.turns.items.map((item) => [
      item.key,
      item.actions.items.map((itemAction) => itemAction.action_id),
      item.changedPaths.items,
    ]),
  );
  assert.deepEqual(left.overlaps, right.overlaps);
  assert.deepEqual(left.metrics, right.metrics);
});

test("labels scoped empty projections and leaves healthy empty metrics explicit", () => {
  const base = projection([], [], { scope: WS_A });
  const model = buildDashboardViewModel({
    ...base,
    value: {
      ...base.value,
      diagnostics: {
        ...base.value.diagnostics,
        malformed_feed_records: 0,
        scan_limited_feed_files: 0,
      },
    },
  });

  assert.equal(model.scope?.label, "ws_aaaaaaaa");
  assert.deepEqual(model.workstreams, []);
  assert.deepEqual(model.active.counts, { shown: 0, total: 0, hidden: 0 });
  assert.deepEqual(model.turns.counts, { shown: 0, total: 0, hidden: 0 });
  assert.equal(model.metrics.paths.visibleDistinct, 0);
  assert.equal(model.metrics.paths.complete, true);
  assert.equal(model.diagnostics.healthy, true);
  assert.equal(shortWorkstreamLabel(undefined), "unscoped");
  assert.equal(shortWorkstreamLabel(WS_B), "ws_bbbbbbbb");
  assert.equal(shortSessionLabel(SESSION_C), "ses_33333333");
});
