import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReaderCatalogueAttentionItem,
  ReaderCatalogueRoll,
  ReaderCatalogueV1,
  ReaderCatalogueWorkstream,
} from "../../src/reader/catalogue.js";
import type {
  ReaderContentSummary,
  ReaderTurnSummary,
} from "../../src/reader/types.js";
import type { ReaderUnreadSummary } from "../../src/reader/unread.js";
import { HORSE_STANDARD_FRAME_INDEX } from "../../src/tui/horse.js";
import {
  clockHHMM,
  compactAge,
  dashboardTurnFact,
  excerptText,
  hubNewsTickerKeys,
  hubProjectionWarning,
  hubSelectableWorkstreamIds,
  outcomeWord,
  reduceDashboard,
  reduceHub,
  relativeAgo,
  shortSessionId,
  shortWorkstreamId,
  workingDotsAtTick,
} from "../../src/tui/reduce.js";

const WS_A = `ws_${"a".repeat(32)}`;
const SES = `ses_${"1".repeat(32)}`;
const REFERENCE = "2026-08-25T12:00:00.000Z";

function readerContent(
  text: string,
  truncated: Partial<ReaderContentSummary["truncated"]> = {},
): ReaderContentSummary {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    fidelity: "verbatim",
    truncated: {
      canonical: truncated.canonical ?? false,
      projection: truncated.projection ?? false,
    },
    utf8_bytes: { shown: bytes, canonical: bytes, original: bytes },
    redactions: [],
  };
}

function makeDashboardTurn(options: {
  readonly sequence: number;
  readonly outcome?: ReaderTurnSummary["outcome"];
  readonly endedAt: string;
  readonly request?: string;
  readonly response?: string;
  readonly requestTruncated?: Partial<ReaderContentSummary["truncated"]>;
  readonly responseTruncated?: Partial<ReaderContentSummary["truncated"]>;
  readonly provider?: string;
  readonly sessionId?: string;
}): ReturnType<typeof dashboardTurnFact> {
  const provider = options.provider ?? "codex";
  const sessionId = options.sessionId ?? SES;
  const turn: ReaderTurnSummary = {
    turn_id: `turn_${provider}_${options.sequence}`,
    provider,
    session_id: sessionId,
    workstream_id: WS_A,
    sequence: options.sequence,
    agent_id: "main",
    started_at: options.endedAt,
    ended_at: options.endedAt,
    outcome: options.outcome ?? "success",
    request: readerContent(
      options.request ?? "",
      options.requestTruncated,
    ),
    ...(options.response === undefined
      ? {}
      : {
          response: readerContent(
            options.response,
            options.responseTruncated,
          ),
        }),
    actions: { shown: 0, total: 0, items: [] },
    evidence_refs: { shown: 0, total: 0, items: [] },
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: { shown: 0, total: 0, items: [] },
      evidence_refs: { shown: 0, total: 0, items: [] },
    },
    source_refs: 0,
  };
  return dashboardTurnFact(turn);
}

function collection<T>(items: readonly T[]) {
  return {
    shown: items.length,
    total: items.length,
    hidden: 0,
    items,
    read_state: "ok" as const,
    coverage: { state: "complete" as const },
  };
}

function makeItem(
  overrides: Partial<{
    name: string;
    workstreamId: string;
    status: "open" | "completed";
    updatedAt: string;
    working: number;
    waiting: number;
    blocked: number;
    quietProven: boolean;
    activityState: ReaderCatalogueWorkstream["activity"]["state"];
    fullHistory: "complete" | "limited";
    turnCoverage: "complete" | "limited";
    lastKnownAt: string | undefined;
    attentionComplete: boolean;
    attentionTotal: number;
    highest: ReaderCatalogueWorkstream["attention"]["highest"];
    unreadCount: number | undefined;
    unreadItems: readonly ReaderUnreadSummary[];
    turnsShown: number;
    rollsTotal: number;
    rollItems: ReaderCatalogueWorkstream["rolls"]["items"];
  }>,
): ReaderCatalogueWorkstream {
  const name = overrides.name ?? "alpha";
  const workstreamId = overrides.workstreamId ?? WS_A;
  const attentionItems = collection<never>([]);
  return {
    record: {
      workstream_id: workstreamId,
      name,
      status: overrides.status ?? "open",
      created_at: "2026-08-25T08:00:00.000Z",
      created_by: { kind: "cli" },
      updated_at: overrides.updatedAt ?? "2026-08-25T08:00:00.000Z",
      revision: 1,
    },
    members: collection([]),
    rolls: {
      ...collection(overrides.rollItems ?? []),
      total: overrides.rollsTotal ?? overrides.rollItems?.length ?? 0,
      hidden: 0,
    },
    active_state_counts: {
      working: overrides.working ?? 0,
      waiting: overrides.waiting ?? 0,
      blocked: overrides.blocked ?? 0,
    },
    activity: {
      state: overrides.activityState ?? "shown",
      proven_empty: overrides.activityState === "proven_empty",
      full_history: { state: overrides.fullHistory ?? "complete" },
      window: { policy: "newest_per_session", turns_per_session: 5 },
      turns: {
        shown: overrides.turnsShown ?? 0,
        total: overrides.turnsShown ?? 0,
        hidden: 0,
        read_state: overrides.turnCoverage === "limited" ? "degraded" : "ok",
        coverage:
          overrides.turnCoverage === "limited"
            ? { state: "limited", reason: "test" }
            : { state: "complete" },
      },
      ...(overrides.lastKnownAt === undefined
        ? {}
        : { last_known_activity_at: overrides.lastKnownAt }),
    },
    quiet_proven: overrides.quietProven ?? false,
    attention: {
      items: {
        ...attentionItems,
        total: overrides.attentionTotal ?? 0,
      },
      completeness:
        (overrides.attentionComplete ?? true) ? "complete" : "incomplete",
      ...(overrides.highest === undefined ? {} : { highest: overrides.highest }),
    },
    ...(overrides.unreadCount === undefined && overrides.unreadItems === undefined
      ? {}
      : {
          unread: collection(
            overrides.unreadItems ?? [
              {
                key: {
                  provider: "codex",
                  session_id: SES,
                  workstream_id: workstreamId,
                  membership_from: "2026-08-25T09:00:00.000Z",
                },
                cursor_state: "persisted" as const,
                read_state: "ok" as const,
                coverage: { state: "complete" as const },
                status: "ready" as const,
                unread_count: overrides.unreadCount!,
              },
            ],
          ),
        }),
  };
}

function unread(
  workstreamId: string,
  provider: string,
  sessionDigit: string,
  unreadCount: number,
): ReaderUnreadSummary {
  return {
    key: {
      provider,
      session_id: `ses_${sessionDigit.repeat(32)}`,
      workstream_id: workstreamId,
      membership_from: "2026-08-25T09:00:00.000Z",
    },
    cursor_state: "persisted",
    read_state: "ok",
    coverage: { state: "complete" },
    status: "ready",
    unread_count: unreadCount,
  };
}

function catalogueRoll(options: {
  readonly provider: string;
  readonly sessionDigit: string;
  readonly state?: "working" | "waiting" | "blocked";
  readonly lastTurnAt?: string;
}): ReaderCatalogueRoll {
  const sessionId = `ses_${options.sessionDigit.repeat(32)}`;
  const state = options.state;
  const leases =
    state === undefined
      ? []
      : [
          {
            agent_id: "main",
            state,
            updated_at: "2026-08-25T11:59:00.000Z",
            expires_at: "2026-08-25T12:05:00.000Z",
            unknown_write_scope: false,
            claim_count: 0,
          },
        ];
  const lastTurn =
    options.lastTurnAt === undefined
      ? undefined
      : {
          provider: options.provider,
          session_id: sessionId,
          turn_id: `turn_${options.sessionDigit.repeat(32)}`,
          sequence: Number(options.sessionDigit),
          outcome: "success",
          ended_at: options.lastTurnAt,
        };
  return {
    provider: options.provider,
    session_id: sessionId,
    current_enrollment: true,
    in_participation: true,
    in_active: leases.length > 0,
    in_turns: lastTurn !== undefined,
    state_counts: {
      working: state === "working" ? 1 : 0,
      waiting: state === "waiting" ? 1 : 0,
      blocked: state === "blocked" ? 1 : 0,
    },
    leases: collection(leases),
    turns: {
      shown: lastTurn === undefined ? 0 : 1,
      total: lastTurn === undefined ? 0 : 1,
      hidden: 0,
      read_state: "ok",
      coverage: { state: "complete" },
    },
    ...(lastTurn === undefined ? {} : { last_turn: lastTurn }),
  };
}

function makeCatalogue(
  items: readonly ReaderCatalogueWorkstream[],
  incomplete = false,
): ReaderCatalogueV1 {
  const open = items.filter((item) => item.record.status === "open").length;
  const completed = items.length - open;
  return {
    schema: "barbaro.reader.catalogue.v1",
    reference_at: REFERENCE,
    workstream_status_counts: {
      open,
      completed,
      read_state: incomplete ? "degraded" : "ok",
      coverage: incomplete
        ? { state: "limited", reason: "test" }
        : { state: "complete" },
    },
    workstreams: {
      ...collection(items),
      ...(incomplete
        ? { coverage: { state: "limited" as const, reason: "test" } }
        : {}),
    },
    read_state: "ok",
    coverage: incomplete
      ? { state: "limited", reason: "test" }
      : { state: "complete" },
    diagnostics: {
      workstream_files: items.length,
      invalid_workstream_records: 0,
      participation_files: 0,
      invalid_participation_records: 0,
      invalid_active_records: 0,
      feed_files: 0,
      malformed_feed_records: 0,
      invalid_feed_records: 0,
      partial_feed_files: 0,
      scan_limited_feed_files: 0,
      unscoped_active_leases: 0,
      unscoped_turns: 0,
    },
  };
}

test("wording helpers are mechanical and bounded", () => {
  assert.equal(outcomeWord("success"), "Succeeded");
  assert.equal(outcomeWord("partial"), "Partial");
  assert.equal(outcomeWord("cancelled"), "Cancelled");
  assert.equal(outcomeWord("abandoned"), "Abandoned");
  assert.equal(outcomeWord("anything-else"), "Unknown");
  for (const value of ["success", "failed", "blocked", "unknown"]) {
    assert.notEqual(outcomeWord(value), "Completed");
  }
  assert.equal(compactAge(42 * 60_000), "42m");
  assert.equal(compactAge(104 * 60_000), "1h44m");
  assert.equal(compactAge(46 * 3_600_000), "1d22h");
  assert.equal(compactAge(48 * 3_600_000), "2d");
  assert.equal(
    relativeAgo("2026-08-25T11:58:00.000Z", REFERENCE),
    "2 minutes ago",
  );
  assert.equal(relativeAgo(REFERENCE, REFERENCE), "moments ago");
  assert.equal(clockHHMM("2026-08-25T02:07:12.000Z"), "02:07");
  assert.equal(shortSessionId("codex", SES), "codex/11111111");
  assert.equal(shortWorkstreamId(WS_A), "ws_aaaaaaaa");
  assert.equal(excerptText("short", 15), "short");
  assert.equal(excerptText("codex posted as well as others", 15), "codex posted...");
  assert.equal(excerptText("a\n b\t c", 15), "a b c");
});

test("working dots grow calmly and wrap on their own clock", () => {
  assert.deepEqual(
    [0, 4, 5, 9, 10, 14, 15, 19, 20].map(workingDotsAtTick),
    [0, 0, 1, 1, 2, 2, 3, 3, 0],
  );
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => workingDotsAtTick(invalid), /non-negative integer/u);
  }
});

test("the hub orders workstreams by newest known activity", () => {
  const selectedId = `ws_${"6".repeat(32)}`;
  const items = [
    makeItem({ name: "missing-first", workstreamId: `ws_${"7".repeat(32)}`, working: 1 }),
    makeItem({
      name: "tie-first",
      workstreamId: selectedId,
      working: 1,
      lastKnownAt: "2026-08-25T10:00:00.000Z",
    }),
    makeItem({
      name: "oldest",
      workstreamId: `ws_${"3".repeat(32)}`,
      working: 1,
      lastKnownAt: "2026-08-25T09:00:00.000Z",
    }),
    makeItem({
      name: "newest",
      workstreamId: `ws_${"4".repeat(32)}`,
      working: 1,
      lastKnownAt: "2026-08-25T11:00:00.000Z",
    }),
    makeItem({
      name: "invalid-second",
      workstreamId: `ws_${"1".repeat(32)}`,
      working: 1,
      lastKnownAt: "not-a-date",
    }),
    makeItem({
      name: "tie-second",
      workstreamId: `ws_${"2".repeat(32)}`,
      working: 1,
      lastKnownAt: "2026-08-25T10:00:00.000Z",
    }),
    makeItem({
      name: "future-third",
      workstreamId: `ws_${"5".repeat(32)}`,
      working: 1,
      lastKnownAt: "2026-08-25T13:00:00.000Z",
    }),
  ];
  const inputOrder = items.map((item) => item.record.name);
  const reduced = reduceHub(makeCatalogue(items), selectedId);
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.deepEqual(
    reduced.frame.entries.map((entry) => entry.name),
    [
      "newest",
      "tie-first",
      "tie-second",
      "oldest",
      "missing-first",
      "invalid-second",
      "future-third",
    ],
  );
  assert.deepEqual(
    reduced.frame.entries.map((entry) => entry.position),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(reduced.frame.entries[1]!.selected, true);
  assert.deepEqual(items.map((item) => item.record.name), inputOrder);
});

test("Home filters by status and orders completed workstreams by updated_at", () => {
  const openId = `ws_${"8".repeat(32)}`;
  const newerCompletedId = `ws_${"9".repeat(32)}`;
  const olderCompletedId = `ws_${"0".repeat(32)}`;
  const catalogue = makeCatalogue([
    makeItem({
      name: "older-complete",
      workstreamId: olderCompletedId,
      status: "completed",
      updatedAt: "2026-08-25T09:00:00.000Z",
      unreadCount: 7,
      attentionTotal: 1,
      highest: "news",
    }),
    makeItem({
      name: "still-open",
      workstreamId: openId,
      working: 1,
      unreadCount: 3,
      attentionTotal: 1,
      highest: "news",
    }),
    makeItem({
      name: "newer-complete",
      workstreamId: newerCompletedId,
      status: "completed",
      updatedAt: "2026-08-25T11:30:00.000Z",
    }),
  ]);

  const open = reduceHub(catalogue);
  assert.equal(open.frame.kind, "hub");
  if (open.frame.kind !== "hub") return;
  assert.deepEqual(open.frame.entries.map((entry) => entry.name), [
    "still-open",
  ]);
  assert.equal(open.frame.title, "Open workstreams");
  assert.equal(open.frame.bottomTitle, "1 of 1 open · 2 completed");
  assert.match(open.truth, /still-open\/Codex · 3 unread/u);

  const completed = reduceHub(
    catalogue,
    olderCompletedId,
    undefined,
    "completed",
  );
  assert.equal(completed.frame.kind, "hub");
  if (completed.frame.kind !== "hub") return;
  assert.deepEqual(
    completed.frame.entries.map((entry) => [
      entry.name,
      entry.detail,
      entry.selected,
    ]),
    [
      ["newer-complete", "Completed · 30m", false],
      ["older-complete", "Completed · 3h0m", true],
    ],
  );
  assert.equal(completed.frame.title, "Completed workstreams");
  assert.equal(completed.frame.bottomTitle, "2 of 2 completed · 1 open");
  assert.equal(completed.truth, "2 completed · 1 open");
  assert.doesNotMatch(completed.truth, /News/u);

  assert.deepEqual(hubSelectableWorkstreamIds(catalogue, "open"), [openId]);
  assert.deepEqual(hubSelectableWorkstreamIds(catalogue, "completed"), [
    newerCompletedId,
    olderCompletedId,
  ]);
  assert.equal(hubNewsTickerKeys(catalogue).length, 1);

  const noOpen = reduceHub(makeCatalogue([catalogue.workstreams.items[0]!]));
  assert.equal(noOpen.truth, "No open workstreams");
  assert.equal(noOpen.frame.kind, "hub");
  if (noOpen.frame.kind === "hub") {
    assert.equal(noOpen.frame.bottomTitle, "0 open · 1 completed");
  }
});

test("Home border wording distinguishes hidden and merely known records", () => {
  const catalogue = makeCatalogue([makeItem({ name: "shown", working: 1 })]);
  const projected: ReaderCatalogueV1 = {
    ...catalogue,
    workstream_status_counts: {
      ...catalogue.workstream_status_counts,
      open: 2,
      completed: 10,
    },
    workstreams: {
      ...catalogue.workstreams,
      total: 12,
      hidden: 11,
      coverage: { state: "limited", reason: "byte budget" },
    },
  };
  const exact = reduceHub(projected);
  assert.equal(exact.frame.kind, "hub");
  if (exact.frame.kind !== "hub") return;
  assert.equal(
    exact.frame.bottomTitle,
    "1 of 1 shown · 2 open · 10 completed",
  );
  assert.equal(exact.truth, "Workstream data is incomplete");

  const incomplete: ReaderCatalogueV1 = {
    ...projected,
    workstream_status_counts: {
      ...projected.workstream_status_counts,
      read_state: "degraded",
      coverage: { state: "limited", reason: "source entry limit" },
    },
  };
  const known = reduceHub(incomplete);
  assert.equal(known.frame.kind, "hub");
  if (known.frame.kind !== "hub") return;
  assert.equal(
    known.frame.bottomTitle,
    "1 of 1 shown · known: 2 open · 10 completed",
  );
});

test("every open workstream remains individually selectable", () => {
  const catalogue = makeCatalogue([
    makeItem({
      name: "busy",
      working: 1,
      attentionTotal: 1,
      highest: "evidence_incomplete",
      lastKnownAt: REFERENCE,
    }),
    makeItem({
      name: "restful",
      quietProven: true,
      lastKnownAt: "2026-08-25T10:16:00.000Z",
    }),
    makeItem({
      name: "bounded",
      fullHistory: "limited",
      lastKnownAt: "2026-08-25T10:00:00.000Z",
    }),
    makeItem({
      name: "sleepy",
      quietProven: true,
      lastKnownAt: "2026-08-23T14:00:00.000Z",
    }),
    makeItem({ name: "mystery", activityState: "scan_limited", fullHistory: "limited", attentionComplete: false }),
    makeItem({ name: "damaged", activityState: "invalid", attentionComplete: false }),
  ]);
  const reduced = reduceHub(catalogue);
  const frame = reduced.frame;
  assert.equal(frame.kind, "hub");
  if (frame.kind !== "hub") return;
  assert.deepEqual(
    frame.entries.map((entry) => entry.name),
    ["busy", "restful", "bounded", "sleepy", "mystery", "damaged"],
  );
  assert.equal(frame.entries[0]!.detail, "Working now");
  assert.equal(frame.entries[1]!.detail, "Quiet · 1h44m");
  assert.equal(frame.entries[2]!.detail, "Last shown · 2h0m");
  assert.equal(frame.entries[3]!.detail, "Quiet · 1d22h");
  assert.equal(frame.entries[4]!.detail, "Data incomplete");
  assert.equal(frame.entries[5]!.detail, "Data incomplete");
  assert.equal(frame.entries[0]!.selected, true);
  assert.equal(frame.entries[0]!.position, 1);
  assert.equal(frame.title, "Open workstreams");
  assert.equal(frame.bottomTitle, "1 of 6 open · 0 completed");
  assert.equal(reduced.truth, "1 working");
});

test("reader-level hiding gets a count confession outside the border", () => {
  const catalogue = makeCatalogue([makeItem({ name: "shown", working: 1 })]);
  const limited: ReaderCatalogueV1 = {
    ...catalogue,
    workstream_status_counts: {
      ...catalogue.workstream_status_counts,
      open: 3,
    },
    workstreams: {
      ...catalogue.workstreams,
      shown: 1,
      total: 3,
      hidden: 2,
      coverage: { state: "limited", reason: "byte budget" },
    },
  };
  assert.equal(
    hubProjectionWarning(limited),
    "List incomplete · 1 of 3 open shown",
  );
  assert.equal(hubProjectionWarning(catalogue), undefined);
});

test("hub entry positions cover the status-filtered selectable list", () => {
  const busyId = `ws_${"b".repeat(32)}`;
  const catalogue = makeCatalogue([
    makeItem({ name: "quiet", quietProven: true }),
    makeItem({ name: "busy", workstreamId: busyId, working: 1 }),
  ]);
  const reduced = reduceHub(catalogue, busyId);
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.deepEqual(
    reduced.frame.entries.map((entry) => entry.name),
    ["quiet", "busy"],
  );
  assert.equal(reduced.frame.entries[1]!.position, 2);
  assert.equal(reduced.frame.bottomTitle, "2 of 2 open · 0 completed");
});

test("an incomplete catalogue names itself instead of a clean summary", () => {
  const catalogue = makeCatalogue([makeItem({ working: 1 })], true);
  assert.equal(reduceHub(catalogue).truth, "Workstream data is incomplete");
});

test("non-activity proof gaps do not mask trustworthy live Home truth", () => {
  const catalogue = makeCatalogue([
    makeItem({
      name: "live-with-bounded-publish",
      working: 1,
      attentionComplete: false,
      attentionTotal: 2,
      highest: "evidence_incomplete",
    }),
  ]);

  const reduced = reduceHub(catalogue);
  assert.equal(reduced.truth, "1 working");
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.equal(reduced.frame.entries[0]?.detail, "Working now");
});

test("a genuine recent-window gap still warns while a lease is live", () => {
  const catalogue = makeCatalogue([
    makeItem({
      name: "live-with-recent-gap",
      working: 1,
      turnCoverage: "limited",
      attentionComplete: false,
      attentionTotal: 1,
      highest: "evidence_incomplete",
    }),
  ]);

  assert.equal(reduceHub(catalogue).truth, "Workstream data is incomplete");
});

test("bounded deep history does not poison the Home truth", () => {
  const item = makeItem({
    name: "mature",
    activityState: "outside_window",
    fullHistory: "limited",
    lastKnownAt: "2026-08-25T10:00:00.000Z",
  });
  const healthyRecent = makeCatalogue([item]);
  const globallyBounded: ReaderCatalogueV1 = {
    ...healthyRecent,
    workstreams: {
      ...healthyRecent.workstreams,
      read_state: "degraded",
    },
    read_state: "degraded",
    coverage: { state: "limited", reason: "source_entry_limit" },
    diagnostics: {
      ...healthyRecent.diagnostics,
      scan_limited_feed_files: 1,
    },
  };

  const reduced = reduceHub(globallyBounded);
  assert.equal(reduced.truth, "All workstreams are accounted for");
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.equal(reduced.frame.entries[0]?.detail, "Last shown · 2h0m");
});

test("proved recent activity survives broad gaps while genuine gaps omit age", () => {
  const catalogue = makeCatalogue([
    makeItem({
      name: "publish-gap",
      attentionComplete: false,
      attentionTotal: 1,
      highest: "evidence_incomplete",
      lastKnownAt: "2026-08-23T14:00:00.000Z",
    }),
    makeItem({
      name: "recent-gap",
      turnCoverage: "limited",
      attentionComplete: false,
      attentionTotal: 1,
      highest: "evidence_incomplete",
      lastKnownAt: "2026-08-23T14:00:00.000Z",
    }),
    makeItem({
      name: "unknown-age",
      attentionComplete: false,
      attentionTotal: 1,
      highest: "evidence_incomplete",
    }),
    makeItem({
      name: "future-age",
      attentionComplete: false,
      attentionTotal: 1,
      highest: "evidence_incomplete",
      lastKnownAt: "2026-08-25T13:00:00.000Z",
    }),
  ]);
  const reduced = reduceHub(catalogue);
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.deepEqual(
    reduced.frame.entries.map((entry) => [entry.name, entry.detail]),
    [
      ["publish-gap", "Last shown · 1d22h"],
      ["recent-gap", "Data incomplete"],
      ["unknown-age", "Data incomplete"],
      ["future-age", "Data incomplete"],
    ],
  );
});

test("a broad evidence gap does not hide a named attention state", () => {
  const base = makeItem({
    attentionComplete: false,
    highest: "evidence_incomplete",
    lastKnownAt: "2026-08-25T10:00:00.000Z",
  });
  const items: readonly ReaderCatalogueAttentionItem[] = [
    { kind: "evidence_incomplete", audience: "unknown" },
    { kind: "publish_blocked", audience: "user" },
  ];
  const item: ReaderCatalogueWorkstream = {
    ...base,
    attention: {
      items: collection(items),
      completeness: "incomplete",
      highest: "evidence_incomplete",
    },
  };

  const reduced = reduceHub(makeCatalogue([item]));
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.equal(reduced.frame.entries[0]?.detail, "Publish blocked");

  const hiddenAttention: ReaderCatalogueWorkstream = {
    ...base,
    attention: {
      items: {
        shown: 1,
        total: 2,
        hidden: 1,
        items: [items[0]!],
        read_state: "degraded",
        coverage: { state: "limited", reason: "attention_limit" },
      },
      completeness: "incomplete",
      highest: "evidence_incomplete",
    },
  };
  const hidden = reduceHub(makeCatalogue([hiddenAttention]));
  assert.equal(hidden.frame.kind, "hub");
  if (hidden.frame.kind !== "hub") return;
  assert.equal(hidden.frame.entries[0]?.detail, "Data incomplete");
});

test("bounded old history is last shown only with complete recent evidence", () => {
  const catalogue = makeCatalogue([
    makeItem({
      name: "recent-proven",
      activityState: "outside_window",
      fullHistory: "limited",
      lastKnownAt: "2026-08-25T10:00:00.000Z",
    }),
    makeItem({
      name: "recent-gap",
      fullHistory: "limited",
      turnCoverage: "limited",
      attentionComplete: false,
      attentionTotal: 1,
      highest: "evidence_incomplete",
      lastKnownAt: "2026-08-25T09:00:00.000Z",
    }),
    makeItem({
      name: "missing-age",
      fullHistory: "limited",
    }),
  ]);
  const reduced = reduceHub(catalogue);
  assert.equal(reduced.frame.kind, "hub");
  if (reduced.frame.kind !== "hub") return;
  assert.deepEqual(
    reduced.frame.entries.map((entry) => [entry.name, entry.detail]),
    [
      ["recent-proven", "Last shown · 2h0m"],
      ["recent-gap", "Data incomplete"],
      ["missing-age", "Data incomplete"],
    ],
  );
});

test("the Home ticker names its recipient without exposing a session id", () => {
  const withNews = makeCatalogue([
    makeItem({ unreadCount: 13, attentionTotal: 1, highest: "news" }),
  ]);
  assert.equal(
    reduceHub(withNews).truth,
    "News 1/1 · alpha/Codex · 13 unread · activity unknown",
  );
  const frame = reduceHub(withNews).frame;
  assert.equal(frame.kind, "hub");
  if (frame.kind === "hub") {
    assert.equal(frame.entries[0]?.detail, "News · 13 unread");
  }
  assert.doesNotMatch(reduceHub(withNews).truth, /ses_|11111111/u);
  const zeroNews = makeCatalogue([
    makeItem({ working: 1, unreadCount: 0 }),
  ]);
  assert.equal(reduceHub(zeroNews).truth, "1 working");
});

test("the Home ticker covers every unread session and prioritizes live facts", () => {
  const liveId = `ws_${"b".repeat(32)}`;
  const archiveId = `ws_${"c".repeat(32)}`;
  const live = makeItem({
    name: "tui-fixes",
    workstreamId: liveId,
    attentionTotal: 3,
    highest: "news",
    lastKnownAt: "2026-08-25T11:59:00.000Z",
    rollItems: [
      catalogueRoll({ provider: "codex", sessionDigit: "1", state: "working" }),
      catalogueRoll({ provider: "codex", sessionDigit: "2", state: "waiting" }),
      catalogueRoll({
        provider: "claude",
        sessionDigit: "3",
        lastTurnAt: "2026-08-25T10:00:00.000Z",
      }),
    ],
    unreadItems: [
      unread(liveId, "codex", "1", 1),
      unread(liveId, "codex", "2", 2),
      unread(liveId, "claude", "3", 4),
      unread(liveId, "claude", "4", 0),
    ],
  });
  const archive = makeItem({
    name: "public-alpha",
    workstreamId: archiveId,
    attentionTotal: 1,
    highest: "news",
    lastKnownAt: "2026-08-23T12:00:00.000Z",
    rollItems: [catalogueRoll({ provider: "codex", sessionDigit: "6" })],
    unreadItems: [unread(archiveId, "codex", "6", 6)],
  });
  const catalogue = makeCatalogue([archive, live]);
  const tickerKeys = hubNewsTickerKeys(catalogue);
  assert.deepEqual(
    [...tickerKeys, tickerKeys[0]!].map((key, index) =>
      reduceHub(catalogue, undefined, {
        key,
        position: index % tickerKeys.length,
      }).truth
    ),
    [
      "News 1/4 · tui-fixes/Codex 1 · 1 unread · working",
      "News 2/4 · tui-fixes/Codex 2 · 2 unread · waiting",
      "News 3/4 · tui-fixes/Claude · 4 unread · last shown 2h0m",
      "News 4/4 · public-alpha/Codex · 6 unread · activity unknown",
      "News 1/4 · tui-fixes/Codex 1 · 1 unread · working",
    ],
  );
  assert.equal(
    reduceHub(catalogue, undefined, {
      key: "missing",
      position: Number.NaN,
    }).truth,
    "News 1/4 · tui-fixes/Codex 1 · 1 unread · working",
  );
});

test("the Home ticker refuses exact counts when recipient evidence is incomplete", () => {
  const workstreamId = `ws_${"d".repeat(32)}`;
  const ready = unread(workstreamId, "codex", "7", 3);
  const unknown = {
    ...unread(workstreamId, "claude", "8", 9),
    status: "unknown" as const,
    issue: "cursor_invalid" as const,
  };
  const complete = makeItem({
    name: "partial-news",
    workstreamId,
    working: 1,
    attentionTotal: 1,
    highest: "news",
    unreadItems: [ready],
  });
  const unknownUnread = {
    ...complete,
    unread: collection([ready, unknown]),
  };
  const hiddenMember = {
    ...complete,
    members: {
      ...complete.members,
      total: 1,
      hidden: 1,
      coverage: { state: "limited" as const, reason: "test" },
    },
    unread: collection([ready]),
  };
  const hiddenUnread = {
    ...complete,
    unread: {
      ...collection([ready]),
      total: 2,
      hidden: 1,
      coverage: { state: "limited" as const, reason: "test" },
    },
  };
  const degradedMembers = {
    ...complete,
    members: { ...complete.members, read_state: "degraded" as const },
  };
  const degradedUnread = {
    ...complete,
    unread: {
      ...complete.unread!,
      read_state: "degraded" as const,
    },
  };

  for (const item of [
    unknownUnread,
    hiddenMember,
    hiddenUnread,
    degradedMembers,
    degradedUnread,
  ]) {
    const catalogue = makeCatalogue([item]);
    assert.equal(reduceHub(catalogue).truth, "Workstream data is incomplete");
    assert.deepEqual(hubNewsTickerKeys(catalogue), []);
  }

  const attentionIncomplete = {
    ...complete,
    attention: {
      ...complete.attention,
      completeness: "incomplete" as const,
      highest: "evidence_incomplete" as const,
    },
  };
  const attentionCatalogue = makeCatalogue([attentionIncomplete]);
  assert.match(reduceHub(attentionCatalogue).truth, /^News 1\/1/u);
  assert.equal(hubNewsTickerKeys(attentionCatalogue).length, 1);

  const completeCatalogue = makeCatalogue([complete]);
  const invalidActiveCatalogue = {
    ...completeCatalogue,
    read_state: "degraded" as const,
    diagnostics: {
      ...completeCatalogue.diagnostics,
      invalid_active_records: 1,
    },
  };
  assert.equal(
    reduceHub(invalidActiveCatalogue).truth,
    "Workstream data is incomplete",
  );
  assert.deepEqual(hubNewsTickerKeys(invalidActiveCatalogue), []);
});

test("a working lease gallops; motion policy chooses the treatment", () => {
  const roll = (provider: string, sessionDigit: string) => ({
    provider,
    session_id: `ses_${sessionDigit.repeat(32)}`,
    current_enrollment: true,
    in_participation: true,
    in_active: true,
    in_turns: false,
    state_counts: { working: 1, waiting: 0, blocked: 0 },
    leases: collection([
      {
        agent_id: "main",
        state: "working" as const,
        updated_at: "2026-08-25T11:59:00.000Z",
        expires_at: "2026-08-25T12:05:00.000Z",
        unknown_write_scope: false,
        claim_count: 0,
      },
    ]),
    turns: {
      shown: 0,
      total: 0,
      hidden: 0,
      read_state: "ok" as const,
      coverage: { state: "complete" as const },
    },
  });
  const item = makeItem({
    working: 2,
    waiting: 1,
    rollItems: [roll("codex", "7"), roll("claude", "8")],
  });
  const live = reduceDashboard(item, [], {
    kind: "live",
    frameIndex: 6,
    workingDots: 2,
  });
  assert.equal(live.frame.kind, "working");
  if (live.frame.kind === "working") {
    assert.deepEqual(live.frame.horse, {
      kind: "gallop",
      frameIndex: 6,
    });
    assert.deepEqual(live.frame.rolls.map((row) => row.detail), [
      "Working..",
      "Working..",
    ]);
    assert.equal(live.frame.rolls.filter((row) => row.selected).length, 1);
    assert.equal(live.frame.rolls.filter((row) => !row.selected).length, 1);
  }
  assert.equal(live.truth, "2 working · 1 waiting");
  const off = reduceDashboard(item, [], { kind: "off" });
  if (off.frame.kind === "working") {
    assert.deepEqual(off.frame.horse, {
      kind: "intertitle",
      text: "Working · motion off",
    });
    assert.deepEqual(off.frame.rolls.map((row) => row.detail), [
      "Working",
      "Working",
    ]);
  }
  const paused = reduceDashboard(item, [], {
    kind: "paused",
    frameIndex: 4,
    workingDots: 3,
  });
  if (paused.frame.kind === "working") {
    assert.equal(paused.frame.title, "Motion study · paused");
    assert.deepEqual(paused.frame.horse, {
      kind: "gallop",
      frameIndex: 4,
    });
    assert.deepEqual(paused.frame.rolls.map((row) => row.detail), [
      "Working...",
      "Working...",
    ]);
  }
  const snapshot = reduceDashboard(item, [], {
    kind: "snapshot",
    motionOff: true,
  });
  if (snapshot.frame.kind === "working") {
    assert.equal(
      snapshot.frame.title,
      "Motion study · snapshot · motion off",
    );
    assert.deepEqual(snapshot.frame.horse, {
      kind: "gallop",
      frameIndex: HORSE_STANDARD_FRAME_INDEX,
    });
    assert.deepEqual(snapshot.frame.rolls.map((row) => row.detail), [
      "Working",
      "Working",
    ]);
  }
});

test("dashboard previews prefer responses and fall back without inventing text", () => {
  const response = makeDashboardTurn({
    sequence: 1,
    endedAt: "2026-08-25T01:00:00.000Z",
    request: "what was asked",
    response: "CHECKPOINT 12: the ledger tells the story",
    responseTruncated: { projection: true },
  });
  assert.deepEqual(response.preview, {
    source: "response",
    text: "CHECKPOINT 12: the ledger tells the story",
    truncated: true,
  });

  const missingResponse = makeDashboardTurn({
    sequence: 2,
    endedAt: "2026-08-25T01:01:00.000Z",
    request: "keep request as fallback",
  });
  assert.deepEqual(missingResponse.preview, {
    source: "request",
    text: "keep request as fallback",
    truncated: false,
  });

  const projectedEmptyResponse = makeDashboardTurn({
    sequence: 3,
    endedAt: "2026-08-25T01:02:00.000Z",
    request: "projected request survives",
    response: "   ",
  });
  assert.equal(projectedEmptyResponse.preview.source, "request");
  assert.equal(projectedEmptyResponse.preview.text, "projected request survives");

  const unavailable = makeDashboardTurn({
    sequence: 4,
    endedAt: "2026-08-25T01:03:00.000Z",
    request: "",
    response: "\n\t",
  });
  assert.deepEqual(unavailable.preview, {
    source: "unavailable",
    text: "",
    truncated: false,
  });
  const reduced = reduceDashboard(
    makeItem({ turnsShown: 1, rollsTotal: 1 }),
    [unavailable],
    { kind: "off" },
  );
  assert.equal(reduced.frame.kind, "idle");
  if (reduced.frame.kind === "idle") {
    assert.equal(reduced.frame.exposures[0]?.excerpt, "Preview unavailable");
  }
});

test("dashboard equal-time ties reverse the reader's newest-first identity order", () => {
  const endedAt = "2026-08-25T02:06:00.000Z";
  const print = reduceDashboard(
    makeItem({ turnsShown: 3, rollsTotal: 2 }),
    [
      makeDashboardTurn({
        sequence: 7,
        endedAt,
        response: "Older peer by sequence",
        provider: "claude",
        sessionId: `ses_${"1".repeat(32)}`,
      }),
      makeDashboardTurn({
        sequence: 9,
        endedAt,
        response: "Older peer by provider",
        provider: "codex",
        sessionId: `ses_${"2".repeat(32)}`,
      }),
      makeDashboardTurn({
        sequence: 8,
        endedAt,
        response: "Reader-canonical newest peer",
        provider: "claude",
        sessionId: `ses_${"1".repeat(32)}`,
      }),
    ],
    { kind: "off" },
  );

  assert.equal(print.frame.kind, "idle");
  if (print.frame.kind === "idle") {
    assert.deepEqual(
      print.frame.exposures.map((row) => row.excerpt),
      [
        "Older peer by provider",
        "Older peer by sequence",
        "Reader-canonical newest peer",
      ],
    );
    assert.equal(print.frame.exposures.at(-1)?.selected, true);
  }
});

test("dashboard provenance follows exact session identity, not visible labels", () => {
  const sharedPrefix = "a".repeat(8);
  const firstSession = `ses_${sharedPrefix}${"1".repeat(24)}`;
  const secondSession = `ses_${sharedPrefix}${"2".repeat(24)}`;
  const firstRoll = {
    ...catalogueRoll({ provider: "codex", sessionDigit: "1" }),
    session_id: firstSession,
  };
  const secondRoll = {
    ...catalogueRoll({ provider: "codex", sessionDigit: "2" }),
    session_id: secondSession,
  };
  const item = makeItem({
    turnsShown: 4,
    rollItems: [firstRoll, secondRoll],
  });
  const turns = [
    makeDashboardTurn({
      sequence: 1,
      endedAt: "2026-08-25T01:01:00.000Z",
      response: "First session one",
      provider: "codex",
      sessionId: firstSession,
    }),
    makeDashboardTurn({
      sequence: 1,
      endedAt: "2026-08-25T01:02:00.000Z",
      response: "Second session one",
      provider: "codex",
      sessionId: secondSession,
    }),
    makeDashboardTurn({
      sequence: 2,
      endedAt: "2026-08-25T01:03:00.000Z",
      response: "First session two",
      provider: "codex",
      sessionId: firstSession,
    }),
    makeDashboardTurn({
      sequence: 2,
      endedAt: "2026-08-25T01:04:00.000Z",
      response: "Second session two",
      provider: "codex",
      sessionId: secondSession,
    }),
  ];

  const first = reduceDashboard(item, turns, { kind: "off" }, 0);
  const second = reduceDashboard(item, turns, { kind: "off" }, 1);
  assert.equal(first.frame.kind, "idle");
  assert.equal(second.frame.kind, "idle");
  if (first.frame.kind === "idle" && second.frame.kind === "idle") {
    assert.deepEqual(
      first.frame.exposures.map((row) => row.provenance),
      [
        "selected-session",
        "other-session",
        "selected-session",
        "other-session",
      ],
    );
    assert.deepEqual(
      second.frame.exposures.map((row) => row.provenance),
      [
        "other-session",
        "selected-session",
        "other-session",
        "selected-session",
      ],
    );
    assert.equal(first.frame.exposures.at(-1)?.selected, true);
    assert.equal(second.frame.exposures.at(-1)?.selected, true);
  }

  const unlinked = reduceDashboard(
    makeItem({ turnsShown: 1 }),
    [turns[0]!],
    { kind: "off" },
  );
  assert.equal(unlinked.frame.kind, "idle");
  if (unlinked.frame.kind === "idle") {
    assert.equal(unlinked.frame.exposures[0]?.provenance, undefined);
  }
});

test("no-work apertures follow the evidence, never the word idle", () => {
  const unsafe = reduceDashboard(
    makeItem({ activityState: "invalid", attentionComplete: false }),
    [],
    { kind: "live", frameIndex: 0, workingDots: 0 },
  );
  assert.equal(unsafe.truth, "Activity is unknown");

  const empty = reduceDashboard(
    makeItem({ activityState: "proven_empty" }),
    [],
    { kind: "live", frameIndex: 0, workingDots: 0 },
  );
  assert.equal(empty.truth, "No exposures yet");

  const incompleteZero = reduceDashboard(
    makeItem({ activityState: "outside_window", fullHistory: "limited", attentionComplete: false }),
    [],
    { kind: "live", frameIndex: 0, workingDots: 0 },
  );
  assert.equal(incompleteZero.truth, "Activity is unknown");

  const print = reduceDashboard(
    makeItem({ turnsShown: 15, rollsTotal: 3 }),
    [
      makeDashboardTurn({
        sequence: 2,
        endedAt: "2026-08-25T02:06:00.000Z",
        request: "latest request",
        response: "Done — the ledger now tells the story",
      }),
      makeDashboardTurn({
        sequence: 74,
        outcome: "abandoned",
        endedAt: "2026-08-25T01:50:00.000Z",
        request: "abandoned request fallback",
      }),
      makeDashboardTurn({
        sequence: 75,
        outcome: "unknown",
        endedAt: "2026-08-25T01:55:00.000Z",
        request: "unknown request fallback",
      }),
      makeDashboardTurn({
        sequence: 73,
        outcome: "cancelled",
        endedAt: "2026-08-25T01:40:00.000Z",
        request: "cancelled request",
        response: "Cancellation was confirmed",
      }),
      makeDashboardTurn({
        sequence: 72,
        outcome: "blocked",
        endedAt: "2026-08-25T01:30:00.000Z",
        request: "blocked request",
        response: "Waiting for a user decision",
      }),
      makeDashboardTurn({
        sequence: 71,
        outcome: "partial",
        endedAt: "2026-08-25T01:20:00.000Z",
        request: "partial request",
        response: "Most of the reshape landed",
      }),
      makeDashboardTurn({
        sequence: 99,
        outcome: "failed",
        endedAt: "2026-08-25T01:00:00.000Z",
        request: "older request",
        response: "The first pass failed",
        responseTruncated: { canonical: true },
        provider: "claude",
        sessionId: `ses_${"2".repeat(32)}`,
      }),
    ],
    { kind: "live", frameIndex: 0, workingDots: 0 },
  );
  assert.equal(
    print.truth,
    "No work is shown. 7 recent exposures are complete.",
  );
  assert.equal(print.frame.kind, "idle");
  if (print.frame.kind === "idle") {
    assert.deepEqual(
      print.frame.exposures.map((row) => [row.sequence, row.exception]),
      [
        [99, "Failed"],
        [71, "Partial"],
        [72, "Blocked"],
        [73, "Cancelled"],
        [74, "Abandoned"],
        [75, "Unknown"],
        [2, undefined],
      ],
    );
    assert.equal(print.frame.exposures[6]!.selected, true);
    assert.equal(print.frame.exposures[0]!.time, "01:00");
    assert.equal(print.frame.exposures[0]!.excerpt, "The first pass failed");
    assert.equal(print.frame.exposures[0]!.excerptTruncated, true);
    assert.equal(
      print.frame.exposures[6]!.excerpt,
      "Done — the ledger now tells the story",
    );
    assert.equal(
      print.frame.summaryLine,
      "Oldest to newest · 3 sessions · 15 turns shown",
    );
  }
  // The banned word never reaches user-visible copy (the internal frame
  // discriminant is not a canvas string).
  for (const reduced of [unsafe, empty, incompleteZero, print]) {
    const visible: string[] = [reduced.truth];
    const frame = reduced.frame;
    if (frame.kind === "intertitle") visible.push(...frame.lines);
    if (frame.kind === "idle") {
      visible.push(frame.title, frame.summaryLine);
      for (const row of frame.exposures) {
        visible.push(row.exception ?? "", row.excerpt);
      }
      for (const roll of frame.rolls) visible.push(roll.detail);
    }
    for (const text of visible) {
      assert.doesNotMatch(text, /\bidle\b/iu, text);
    }
  }
});
