import assert from "node:assert/strict";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type { BarbaroContent, BarbaroTurnV1 } from "../../src/contracts/v1.js";
import {
  createJsonlCheckpoint,
  type JsonlCheckpoint,
} from "../../src/core/checkpoint.js";
import { readJsonlForward } from "../../src/core/jsonl-reader.js";
import {
  NUDGE_CURSOR_SCHEMA_V2,
  NUDGE_CURSOR_SCHEMA_V1,
  NUDGE_CURSOR_SCHEMA,
  type NudgeCursorV2,
} from "../../src/nudge/types.js";
import { InvalidNudgeCursorError, NudgeCursorStateStore } from "../../src/nudge/store.js";
import {
  readUnreadSummaryBatch,
  type ReaderUnreadBatch,
  type ReaderUnreadRecipientKey,
  type ReaderUnreadSummary,
} from "../../src/reader/unread.js";
import { snapshotTree } from "../setup/fixture.js";

const WORKSTREAM = `ws_${"a".repeat(32)}`;
const OTHER_WORKSTREAM = `ws_${"b".repeat(32)}`;
const RECIPIENT_A = `ses_${"1".repeat(32)}`;
const RECIPIENT_B = `ses_${"2".repeat(32)}`;
const RECIPIENT_C = `ses_${"3".repeat(32)}`;
const PEER = `ses_${"d".repeat(32)}`;
const SECOND_PEER = `ses_${"e".repeat(32)}`;
const MEMBERSHIP_FROM = "2026-08-25T01:00:00.000Z";
const UPDATED_AT = "2026-08-25T01:05:00.000Z";

function content(text: string): BarbaroContent {
  return { text, fidelity: "verbatim", truncated: false, redactions: [] };
}

function turn(options: {
  readonly sessionId?: string;
  readonly provider?: string;
  readonly workstreamId?: string;
  readonly sequence: number;
  readonly endedAt: string;
  readonly text?: string;
}): BarbaroTurnV1 {
  const sessionId = options.sessionId ?? PEER;
  const provider = options.provider ?? "claude";
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${options.sequence.toString(16).padStart(32, "0")}`,
    provider,
    session_id: sessionId,
    workstream_id: options.workstreamId ?? WORKSTREAM,
    sequence: options.sequence,
    agent_id: "main",
    started_at: new Date(Date.parse(options.endedAt) - 1_000).toISOString(),
    ended_at: options.endedAt,
    outcome: "success",
    request: content(options.text ?? `request ${options.sequence}`),
    response: content(`response ${options.sequence}`),
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [],
  };
}

function recipient(
  sessionId: string,
  overrides: Partial<ReaderUnreadRecipientKey> = {},
): ReaderUnreadRecipientKey {
  return {
    provider: "codex",
    session_id: sessionId,
    workstream_id: WORKSTREAM,
    membership_from: MEMBERSHIP_FROM,
    ...overrides,
  };
}

function feedPath(project: string, provider = "claude", sessionId = PEER): string {
  return join(project, ".barbaro", "feed", provider, `${sessionId}.jsonl`);
}

function cursorPath(project: string, provider: string, sessionId: string): string {
  return join(project, ".barbaro", "state", "nudge", provider, `${sessionId}.json`);
}

async function appendTurn(project: string, value: BarbaroTurnV1): Promise<void> {
  const path = feedPath(project, value.provider, value.session_id);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function checkpoint(path: string): Promise<JsonlCheckpoint> {
  const summary = await readJsonlForward(path, () => undefined, {
    noFollow: true,
    requireSingleLink: true,
    pinEnd: true,
  });
  return createJsonlCheckpoint(summary);
}

async function writeCursor(
  project: string,
  key: ReaderUnreadRecipientKey,
  feedCursors: readonly {
    readonly provider: string;
    readonly session_id: string;
    readonly checkpoint: JsonlCheckpoint;
  }[],
  overrides: Partial<NudgeCursorV2> = {},
): Promise<string> {
  const path = cursorPath(project, key.provider, key.session_id);
  await mkdir(dirname(path), { recursive: true });
  const value: NudgeCursorV2 = {
    schema: NUDGE_CURSOR_SCHEMA_V2,
    provider: key.provider,
    session_id: key.session_id,
    workstream_id: key.workstream_id,
    membership_from: key.membership_from,
    cursor_revision: 7,
    feed_cursors: [...feedCursors],
    markers: {},
    // This is announcement history, deliberately unrelated to exact unread.
    delivery: { highest_unread_count: 999 },
    updated_at: UPDATED_AT,
    ...overrides,
  };
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  return path;
}

async function temporaryProject(t: TestContext): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-reader-unread-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

function options(
  projectRoot: string,
  recipients: readonly ReaderUnreadRecipientKey[],
  overrides: Partial<Parameters<typeof readUnreadSummaryBatch>[0]> = {},
) {
  return { projectRoot, recipients, ...overrides };
}

function only(batch: ReaderUnreadBatch): ReaderUnreadSummary {
  assert.equal(batch.items.length, 1);
  return batch.items[0]!;
}

function assertUnknown(
  summary: ReaderUnreadSummary,
  issue: Extract<ReaderUnreadSummary, { status: "unknown" }>["issue"],
): void {
  assert.equal(summary.status, "unknown");
  if (summary.status !== "unknown") return;
  assert.equal(summary.issue, issue);
  assert.equal("unread_count" in summary, false);
  assert.equal("newest" in summary, false);
}

test("both cursor decoders refuse malformed v3 delivery state without rewriting it", async (t) => {
  const project = await temporaryProject(t);
  const key = recipient(RECIPIENT_A);
  const path = await writeCursor(project, key, []);
  const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const empty = { pending: [], coverage: [], outside_window: false };
  const good = { ...legacy, schema: NUDGE_CURSOR_SCHEMA, reads: empty };
  const store = new NudgeCursorStateStore(project);
  for (const invalid of [
    { ...good, reads: undefined },
    { ...good, extra: true },
    { ...good, reads: { ...empty, unexpected: true } },
    { ...good, reads: { ...empty, coverage: [{}] } },
    { ...good, reads: { ...empty, pending: [{}] } },
    { ...good, reads: { ...empty, outside_window: 1 } },
    { ...good, delivery: { highest_unread_count: 0, last_turn: { kind: "codex", turn_id: `turn_${"a".repeat(32)}` } } },
  ]) {
    await writeFile(path, `${JSON.stringify(invalid)}\n`);
    const before = await readFile(path);
    await assert.rejects(store.read(key.provider, key.session_id), InvalidNudgeCursorError);
    assertUnknown(only(await readUnreadSummaryBatch(options(project, [key]))), "cursor_invalid");
    assert.deepEqual(await readFile(path), before);
  }
  await writeFile(path, `${JSON.stringify(good)}\n`);
  assert.deepEqual(await store.read(key.provider, key.session_id), good);
  assert.equal(only(await readUnreadSummaryBatch(options(project, [key]))).status, "ready");
});

test("an absent store yields a pure deterministic virtual zero", async (t) => {
  const project = await temporaryProject(t);
  const input = options(project, [recipient(RECIPIENT_A)]);
  const before = await snapshotTree(project);
  const first = await readUnreadSummaryBatch(input);
  const second = await readUnreadSummaryBatch(input);

  assert.deepEqual(second, first);
  assert.equal(await snapshotTree(project), before);
  assert.equal(first.read_state, "ok");
  assert.deepEqual(first.coverage, { state: "complete" });
  assert.deepEqual(first.diagnostics, {
    cursor_snapshots: 1,
    feed_files: 0,
    pinned_feed_files: 0,
    scanned_feed_files: 0,
  });
  const summary = only(first);
  assert.equal(summary.status, "ready");
  assert.equal(summary.cursor_state, "virtual");
  if (summary.status === "ready") assert.equal(summary.unread_count, 0);
  await assert.rejects(readFile(join(project, ".barbaro")), { code: "ENOENT" });
});

test("one pinned feed scan serves different recipient checkpoints", async (t) => {
  const project = await temporaryProject(t);
  const a = recipient(RECIPIENT_A);
  const b = recipient(RECIPIENT_B);
  const first = turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" });
  const second = turn({ sequence: 2, endedAt: "2026-08-25T01:02:00.000Z" });
  const third = turn({ sequence: 3, endedAt: "2026-08-25T01:03:00.000Z" });
  await appendTurn(project, first);
  const afterFirst = await checkpoint(feedPath(project));
  await appendTurn(project, second);
  const afterSecond = await checkpoint(feedPath(project));
  await appendTurn(project, third);
  const pathA = await writeCursor(project, a, [{
    provider: "claude",
    session_id: PEER,
    checkpoint: afterFirst,
  }]);
  await writeCursor(project, b, [{
    provider: "claude",
    session_id: PEER,
    checkpoint: afterSecond,
  }]);
  const cursorBytes = await readFile(pathA);
  const tree = await snapshotTree(project);

  const batch = await readUnreadSummaryBatch(options(project, [b, a]));
  assert.equal(await snapshotTree(project), tree);
  assert.deepEqual(await readFile(pathA), cursorBytes);
  assert.deepEqual(batch.diagnostics, {
    cursor_snapshots: 2,
    feed_files: 1,
    pinned_feed_files: 1,
    scanned_feed_files: 1,
  });
  assert.deepEqual(batch.items.map((item) => item.key.session_id), [
    RECIPIENT_A,
    RECIPIENT_B,
  ]);
  assert.deepEqual(batch.items.map((item) =>
    item.status === "ready" ? item.unread_count : undefined
  ), [2, 1]);
  for (const summary of batch.items) {
    assert.equal(summary.status, "ready");
    assert.equal(summary.cursor_state, "persisted");
    assert.equal(summary.cursor_revision, 7);
    assert.equal(summary.cursor_updated_at, UPDATED_AT);
    if (summary.status === "ready") {
      assert.equal(summary.newest?.turn.value.turn_id, third.turn_id);
      assert.ok(summary.newest!.turn.utf8_bytes <= summary.newest!.turn.byte_budget);
    }
  }
});

test("a missing cursor scans virtually from the membership fence", async (t) => {
  const project = await temporaryProject(t);
  await appendTurn(project, turn({
    sequence: 1,
    endedAt: "2026-08-25T00:59:59.000Z",
    text: "old",
  }));
  await appendTurn(project, turn({
    sequence: 2,
    endedAt: "2026-08-25T01:00:01.000Z",
    text: "new",
  }));
  const before = await snapshotTree(project);
  const batch = await readUnreadSummaryBatch(
    options(project, [recipient(RECIPIENT_A)]),
  );
  const summary = only(batch);
  assert.equal(summary.status, "ready");
  assert.equal(summary.cursor_state, "virtual");
  if (summary.status === "ready") {
    assert.equal(summary.unread_count, 1);
    assert.equal(summary.newest?.turn.value.request.text, "new");
  }
  assert.equal(await snapshotTree(project), before);
});

test("delivery high-water is never reported as unread", async (t) => {
  const project = await temporaryProject(t);
  const key = recipient(RECIPIENT_A);
  await writeCursor(project, key, []);
  const batch = await readUnreadSummaryBatch(options(project, [key]));
  const summary = only(batch);
  assert.equal(summary.status, "ready");
  if (summary.status === "ready") assert.equal(summary.unread_count, 0);
});

test("a valid legacy cursor remains an exact persisted snapshot", async (t) => {
  const project = await temporaryProject(t);
  const key = recipient(RECIPIENT_A);
  await appendTurn(project, turn({
    sequence: 1,
    endedAt: "2026-08-25T01:01:00.000Z",
  }));
  const atEnd = await checkpoint(feedPath(project));
  await appendTurn(project, turn({
    sequence: 2,
    endedAt: "2026-08-25T01:02:00.000Z",
  }));
  const path = cursorPath(project, key.provider, key.session_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schema: NUDGE_CURSOR_SCHEMA_V1,
    provider: key.provider,
    session_id: key.session_id,
    workstream_id: key.workstream_id,
    membership_from: key.membership_from,
    cursor_revision: 4,
    feed_cursors: [{
      provider: "claude",
      session_id: PEER,
      checkpoint: atEnd,
    }],
    markers: { stop: 4 },
    updated_at: UPDATED_AT,
  })}\n`, "utf8");

  const summary = only(await readUnreadSummaryBatch(options(project, [key])));
  assert.equal(summary.status, "ready");
  assert.equal(summary.cursor_state, "persisted");
  assert.equal(summary.cursor_revision, 4);
  if (summary.status === "ready") assert.equal(summary.unread_count, 1);
});

test("invalid and rebuilt cursor regions are unknown, never zero", async (t) => {
  const project = await temporaryProject(t);
  const invalid = recipient(RECIPIENT_A);
  const rebuilt = recipient(RECIPIENT_B);
  const invalidPath = cursorPath(project, invalid.provider, invalid.session_id);
  await mkdir(dirname(invalidPath), { recursive: true });
  await writeFile(invalidPath, "{not-json}\n", "utf8");
  await writeCursor(project, rebuilt, [], { workstream_id: OTHER_WORKSTREAM });

  const batch = await readUnreadSummaryBatch(options(project, [rebuilt, invalid]));
  assertUnknown(batch.items[0]!, "cursor_invalid");
  assert.equal(batch.items[0]!.cursor_state, "persisted");
  assertUnknown(batch.items[1]!, "cursor_rebuilt");
  assert.equal(batch.items[1]!.cursor_revision, 7);
});

test("a rotated feed makes only checkpoint-dependent recipients unknown", async (t) => {
  const project = await temporaryProject(t);
  const persisted = recipient(RECIPIENT_A);
  const virtual = recipient(RECIPIENT_B);
  await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
  const oldCheckpoint = await checkpoint(feedPath(project));
  await writeCursor(project, persisted, [{
    provider: "claude",
    session_id: PEER,
    checkpoint: oldCheckpoint,
  }]);
  await rename(feedPath(project), `${feedPath(project)}.old`);
  await appendTurn(project, turn({ sequence: 2, endedAt: "2026-08-25T01:02:00.000Z" }));

  const batch = await readUnreadSummaryBatch(options(project, [virtual, persisted]));
  assertUnknown(batch.items[0]!, "feed_rebuilt");
  assert.equal(batch.items[1]!.status, "ready");
  if (batch.items[1]!.status === "ready") {
    assert.equal(batch.items[1]!.unread_count, 1);
  }
});

test("a persisted checkpoint whose canonical feed vanished is unknown", async (t) => {
  const project = await temporaryProject(t);
  const key = recipient(RECIPIENT_A);
  await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
  const atEnd = await checkpoint(feedPath(project));
  await writeCursor(project, key, [{
    provider: "claude",
    session_id: PEER,
    checkpoint: atEnd,
  }]);
  await rename(feedPath(project), `${feedPath(project)}.vanished`);

  const batch = await readUnreadSummaryBatch(options(project, [key]));
  assert.equal(batch.diagnostics.feed_files, 0);
  assertUnknown(only(batch), "feed_rebuilt");
});

test("a forged non-boundary checkpoint cannot produce an exact count", async (t) => {
  const project = await temporaryProject(t);
  const key = recipient(RECIPIENT_A);
  await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
  const valid = await checkpoint(feedPath(project));
  assert.ok(valid.byte_offset > 64);
  const forged: JsonlCheckpoint = {
    ...valid,
    byte_offset: valid.byte_offset - 1,
  };
  await writeCursor(project, key, [{
    provider: "claude",
    session_id: PEER,
    checkpoint: forged,
  }]);
  const summary = only(await readUnreadSummaryBatch(options(project, [key])));
  assertUnknown(summary, "feed_rebuilt");
});

test("partial, malformed, and path-mismatched feed data are unknown", async (t) => {
  for (const kind of ["partial", "malformed", "identity"] as const) {
    await t.test(kind, async (t) => {
      const project = await temporaryProject(t);
      const path = feedPath(project);
      await mkdir(dirname(path), { recursive: true });
      if (kind === "partial") {
        await writeFile(path, "{\"schema\":", "utf8");
      } else if (kind === "malformed") {
        await writeFile(path, "{bad}\n", "utf8");
      } else {
        const wrong = turn({
          sequence: 1,
          sessionId: SECOND_PEER,
          endedAt: "2026-08-25T01:01:00.000Z",
        });
        await writeFile(path, `${JSON.stringify(wrong)}\n`, "utf8");
      }
      const batch = await readUnreadSummaryBatch(
        options(project, [recipient(RECIPIENT_A)]),
      );
      assertUnknown(only(batch), kind === "partial" ? "feed_partial" : "feed_invalid");
    });
  }
});

test("oversized, scan-limited, and source-limited feeds are unknown", async (t) => {
  await t.test("oversized", async (t) => {
    const project = await temporaryProject(t);
    await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
    const batch = await readUnreadSummaryBatch(options(
      project,
      [recipient(RECIPIENT_A)],
      { maxFeedBytes: 1 },
    ));
    assertUnknown(only(batch), "feed_refused");
  });
  await t.test("scan limited", async (t) => {
    const project = await temporaryProject(t);
    await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
    const batch = await readUnreadSummaryBatch(options(
      project,
      [recipient(RECIPIENT_A)],
      { maxScanBytesPerFeed: 1 },
    ));
    assertUnknown(only(batch), "feed_scan_limited");
  });
  await t.test("source limited", async (t) => {
    const project = await temporaryProject(t);
    await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
    await appendTurn(project, turn({
      sequence: 2,
      sessionId: SECOND_PEER,
      endedAt: "2026-08-25T01:02:00.000Z",
    }));
    const batch = await readUnreadSummaryBatch(options(
      project,
      [recipient(RECIPIENT_A)],
      { maxSourceEntries: 1 },
    ));
    assertUnknown(only(batch), "feed_source_limited");
    assert.equal(batch.diagnostics.feed_files, 2);
    assert.equal(batch.diagnostics.pinned_feed_files, 0);
  });
});

test("unsafe feed and hard-linked cursor reads are refused", async (t) => {
  await t.test("feed symlink", async (t) => {
    const project = await temporaryProject(t);
    const outside = join(project, "outside.jsonl");
    await writeFile(outside, "\n", "utf8");
    const path = feedPath(project);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outside, path);
    const summary = only(await readUnreadSummaryBatch(
      options(project, [recipient(RECIPIENT_A)]),
    ));
    assertUnknown(summary, "feed_refused");
    assert.equal(summary.read_state, "refused");
  });
  await t.test("cursor hard link", async (t) => {
    const project = await temporaryProject(t);
    const key = recipient(RECIPIENT_A);
    const path = await writeCursor(project, key, []);
    await link(path, join(project, "cursor-copy.json"));
    const summary = only(await readUnreadSummaryBatch(options(project, [key])));
    assertUnknown(summary, "cursor_refused");
    assert.equal(summary.cursor_state, "unknown");
  });
});

test("a corrupt self feed does not poison peer unread", async (t) => {
  const project = await temporaryProject(t);
  const selfPath = feedPath(project, "codex", RECIPIENT_A);
  await mkdir(dirname(selfPath), { recursive: true });
  await writeFile(selfPath, "{bad}\n", "utf8");
  await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
  const summary = only(await readUnreadSummaryBatch(
    options(project, [recipient(RECIPIENT_A)]),
  ));
  assert.equal(summary.status, "ready");
  if (summary.status === "ready") assert.equal(summary.unread_count, 1);
});

test("self exclusion compares the full provider and session identity", async (t) => {
  const project = await temporaryProject(t);
  await appendTurn(project, turn({
    sequence: 1,
    provider: "claude",
    sessionId: RECIPIENT_A,
    endedAt: "2026-08-25T01:01:00.000Z",
  }));
  const summary = only(await readUnreadSummaryBatch(
    options(project, [recipient(RECIPIENT_A)]),
  ));
  assert.equal(summary.status, "ready");
  if (summary.status === "ready") assert.equal(summary.unread_count, 1);
});

test("an explicit tiny newest-turn budget is never silently enlarged", async (t) => {
  const project = await temporaryProject(t);
  await appendTurn(project, turn({ sequence: 1, endedAt: "2026-08-25T01:01:00.000Z" }));
  const before = await snapshotTree(project);
  await assert.rejects(
    readUnreadSummaryBatch(options(
      project,
      [recipient(RECIPIENT_A)],
      { turnByteBudget: 1 },
    )),
    /Reader byte budget 1/u,
  );
  assert.equal(await snapshotTree(project), before);
});

test("recipient projection is sorted and exposes shown total hidden", async (t) => {
  const project = await temporaryProject(t);
  const batch = await readUnreadSummaryBatch(options(
    project,
    [recipient(RECIPIENT_C), recipient(RECIPIENT_A), recipient(RECIPIENT_B)],
    { maxRecipients: 2 },
  ));
  assert.equal(batch.shown, 2);
  assert.equal(batch.total, 3);
  assert.equal(batch.hidden, 1);
  assert.equal(batch.read_state, "degraded");
  assert.deepEqual(batch.coverage, { state: "limited", reason: "recipient_limit" });
  assert.deepEqual(batch.items.map((item) => item.key.session_id), [
    RECIPIENT_A,
    RECIPIENT_B,
  ]);
});

test("duplicate or malformed recipient keys are rejected before reads", async (t) => {
  const project = await temporaryProject(t);
  const key = recipient(RECIPIENT_A);
  await assert.rejects(
    readUnreadSummaryBatch(options(project, [key, key])),
    /duplicate unread recipient/u,
  );
  await assert.rejects(
    readUnreadSummaryBatch(options(project, [{ ...key, session_id: "short" }])),
    /invalid unread recipient/u,
  );
  await assert.rejects(
    readUnreadSummaryBatch(options(project, [{
      ...key,
      provider: `a${"b".repeat(64)}`,
    }])),
    /invalid unread recipient/u,
  );
  await assert.rejects(
    readUnreadSummaryBatch(options(project, [{
      ...key,
      membership_from: `${MEMBERSHIP_FROM}${" ".repeat(65)}`,
    }])),
    /invalid unread recipient/u,
  );
  assert.equal(await snapshotTree(project), "");
});
