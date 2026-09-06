import assert from "node:assert/strict";
import {
  access,
  appendFile,
  chmod,
  link,
  open,
  rename,
  symlink,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { BarbaroContent, BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { createSessionId } from "../../src/core/id.js";
import {
  SESSION_PARTICIPATION_SCHEMA,
  admitHookSession,
} from "../../src/hooks/participation.js";
import {
  InvalidNudgeCursorError,
  NUDGE_CURSOR_SCHEMA,
  NUDGE_CURSOR_SCHEMA_V1,
  NUDGE_CURSOR_SCHEMA_V2,
  NudgeCursorStateStore,
  claimHookNudge,
  inspectUnreadPeerTurns,
  rollbackHookStopClaim,
  emptyNudgeReadState,
  mergeReadCoverage,
  readRecordHash,
  readContentHash,
  type NudgeReadCoverage,
} from "../../src/nudge/index.js";
import { readUnreadSummaryBatch } from "../../src/reader/unread.js";
import { selectTurnText } from "../../src/reader/record-page.js";
import { WATCH_WAKE_MARKER, isEchoTurn } from "../../src/watch/index.js";
import { seedFullyDeliveredCursor } from "./cursor-fixture.js";
import { snapshotTree } from "../setup/fixture.js";
import { deliveryFromClaim } from "../../src/nudge/delivery.js";

const SELF_NATIVE = "nudge-self";
const PEER_NATIVE = "nudge-peer";
const SELF_SESSION = createSessionId("codex", SELF_NATIVE);
const PEER_SESSION = createSessionId("claude", PEER_NATIVE);
const CLAUDE_SELF_NATIVE = "nudge-claude-self";
const CODEX_PEER_NATIVE = "nudge-codex-peer";
const CLAUDE_SELF_SESSION = createSessionId("claude", CLAUDE_SELF_NATIVE);
const CODEX_PEER_SESSION = createSessionId("codex", CODEX_PEER_NATIVE);
const SELF_TURN = `turn_${"1".repeat(32)}`;
const T_MINUS_10 = new Date("2026-08-23T09:59:50.000Z");
const T_ZERO = new Date("2026-08-23T10:00:00.000Z");

function content(text: string): BarbaroContent {
  return { text, fidelity: "verbatim", truncated: false, redactions: [] };
}

function turnRecord(options: {
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly request: string;
  readonly response?: string;
  readonly provider?: string;
  readonly turnStartMethod?: string;
}): BarbaroTurnV1 {
  const provider = options.provider ?? "claude";
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${options.sessionId.slice(4, 20)}${options.sequence
      .toString(16)
      .padStart(16, "0")}`,
    provider,
    session_id: options.sessionId,
    workstream_id: options.workstreamId,
    sequence: options.sequence,
    agent_id: "main",
    started_at: options.startedAt,
    ended_at: options.endedAt,
    outcome: "success",
    request: content(options.request),
    ...(options.response === undefined
      ? {}
      : { response: content(options.response) }),
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
    ...(options.turnStartMethod === undefined
      ? {}
      : {
          extensions: {
            claude: { turn_start: { method: options.turnStartMethod } },
          },
        }),
  };
}

function feedPath(project: string, turn: BarbaroTurnV1): string {
  return join(
    project,
    ".barbaro",
    "feed",
    turn.provider,
    `${turn.session_id}.jsonl`,
  );
}

async function appendTurn(project: string, turn: BarbaroTurnV1): Promise<void> {
  const path = feedPath(project, turn);
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(turn)}\n`, "utf8");
}

async function replaceFeed(
  project: string,
  provider: string,
  sessionId: string,
  turns: readonly BarbaroTurnV1[],
): Promise<void> {
  const path = join(
    project,
    ".barbaro",
    "feed",
    provider,
    `${sessionId}.jsonl`,
  );
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, turns.map((turn) => `${JSON.stringify(turn)}\n`).join(""));
}

async function joinPeerAndSelf(
  project: string,
  options: {
    readonly name?: string;
    readonly peerNative?: string;
    readonly selfNative?: string;
    readonly peerNow?: Date;
    readonly selfNow?: Date;
  } = {},
): Promise<string> {
  const name = options.name ?? "lane";
  const peer = await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: options.peerNative ?? PEER_NATIVE,
    event: "UserPromptSubmit",
    prompt: `/barbaro new ${name}`,
    now: options.peerNow ?? T_MINUS_10,
  });
  assert.equal(peer.joined, true);
  assert.ok(peer.participation?.workstream_id !== undefined);
  const self = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId: options.selfNative ?? SELF_NATIVE,
    event: "UserPromptSubmit",
    prompt: `$barbaro join ${name}`,
    now: options.selfNow ?? T_ZERO,
  });
  assert.equal(self.joined, true);
  assert.equal(self.participation?.workstream_id, peer.participation.workstream_id);
  return peer.participation.workstream_id;
}

async function joinCodexPeerAndClaudeSelf(project: string): Promise<string> {
  const peer = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId: CODEX_PEER_NATIVE,
    event: "UserPromptSubmit",
    prompt: "$barbaro new claude-lane",
    now: T_MINUS_10,
  });
  assert.equal(peer.joined, true);
  assert.ok(peer.participation?.workstream_id !== undefined);
  const self = await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: CLAUDE_SELF_NATIVE,
    event: "UserPromptSubmit",
    prompt: "/barbaro join claude-lane",
    now: T_ZERO,
  });
  assert.equal(self.joined, true);
  assert.equal(self.participation?.workstream_id, peer.participation.workstream_id);
  return peer.participation.workstream_id;
}

async function temporaryProject(t: TestContext): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-nudge-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

function selfOptions(project: string) {
  return {
    projectRoot: project,
    provider: "codex" as const,
    nativeSessionId: SELF_NATIVE,
    turn: { kind: "codex" as const, turn_id: SELF_TURN },
  };
}

test("an unavailable feed preserves its prior position while healthy unread stays visible", async (t) => {
  for (const fault of ["file-limit", "record-limit", "permission", "missing"] as const) {
    await t.test(fault, { skip: fault === "permission" && process.getuid?.() === 0 }, async (t) => {
      const project = await temporaryProject(t);
      const workstreamId = await joinPeerAndSelf(project);
      const priorTurn = turnRecord({ sessionId: PEER_SESSION, workstreamId, sequence: 1,
        startedAt: "2026-08-23T10:00:01.000Z", endedAt: "2026-08-23T10:00:02.000Z", request: "already delivered" });
      await appendTurn(project, priorTurn);
      await seedFullyDeliveredCursor(selfOptions(project));
      const store = new NudgeCursorStateStore(project);
      const before = (await store.read("codex", SELF_SESSION))!;
      const unread = turnRecord({ sessionId: PEER_SESSION, workstreamId, sequence: 2,
        startedAt: "2026-08-23T10:00:03.000Z", endedAt: "2026-08-23T10:00:04.000Z", request: "unread in failing feed" });
      await appendTurn(project, unread);
      const healthy = { ...unread, session_id: createSessionId("claude", "healthy-peer"), turn_id: `turn_${"e".repeat(32)}` };
      await appendTurn(project, healthy);
      const path = feedPath(project, priorTurn);
      const original = await readFile(path);
      if (fault === "file-limit") {
        const handle = await open(path, "r+");
        try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
      } else if (fault === "record-limit") {
        await appendFile(path, "x".repeat(8 * 1024 * 1024 + 1));
      } else if (fault === "permission") await chmod(path, 0);
      else await rename(path, `${path}.absent`);

      try {
        const snapshot = await inspectUnreadPeerTurns(selfOptions(project));
        assert.equal(snapshot.status, "ready");
        if (snapshot.status !== "ready") return;
        assert.equal(snapshot.unread_count, 1);
        assert.equal(snapshot.coverage?.state, "incomplete");
        assert.equal(snapshot.coverage?.unavailable.total, 1);
        assert.equal(snapshot.coverage?.unavailable.items[0]?.session_id, PEER_SESSION);
        assert.deepEqual(await store.read("codex", SELF_SESSION), before, "observer never repairs the cursor");
        const claim = await claimHookNudge({ ...selfOptions(project), marker: "tool_boundary" });
        assert.equal(claim.status, "ready");
        if (claim.status === "ready") {
          assert.equal(claim.claimed, true);
          assert.match(deliveryFromClaim(claim).text, /at least 1 new peer turn.*coverage incomplete/u);
        }
        const after = (await store.read("codex", SELF_SESSION))!;
        assert.deepEqual(after.feed_cursors.find((feed) => feed.session_id === PEER_SESSION), before.feed_cursors[0]);
      } finally {
        if (fault === "permission") await chmod(path, 0o600);
        else if (fault === "missing") await rename(`${path}.absent`, path);
        else await writeFile(path, original);
      }
      const recovered = await inspectUnreadPeerTurns(selfOptions(project));
      assert.equal(recovered.status, "ready");
      if (recovered.status === "ready") {
        assert.equal(recovered.unread_count, 2);
        assert.equal(recovered.coverage, undefined);
      }
    });
  }
});

test("feed isolation never converts unsafe paths into partial success", async (t) => {
  for (const fault of ["symlink", "hard-link", "directory"] as const) {
    await t.test(fault, async (t) => {
      const project = await temporaryProject(t);
      const workstreamId = await joinPeerAndSelf(project);
      const record = turnRecord({ sessionId: PEER_SESSION, workstreamId, sequence: 1,
        startedAt: "2026-08-23T10:00:01.000Z", endedAt: "2026-08-23T10:00:02.000Z", request: "unsafe source" });
      await appendTurn(project, record);
      await appendTurn(project, { ...record, session_id: createSessionId("claude", "healthy-source"), turn_id: `turn_${"e".repeat(32)}` });
      const path = feedPath(project, record);
      await rename(path, `${path}.original`);
      if (fault === "symlink") await symlink(`${path}.original`, path);
      else if (fault === "hard-link") await link(`${path}.original`, path);
      else await mkdir(path);
      await assert.rejects(inspectUnreadPeerTurns(selfOptions(project)), /real file|symbolic link|hard links/u);
      const store = new NudgeCursorStateStore(project);
      assert.equal(await store.read("codex", SELF_SESSION), undefined);
    });
  }
});

function claudeSelfOptions(
  project: string,
  phase: "begin" | "current" = "current",
) {
  return {
    projectRoot: project,
    provider: "claude" as const,
    nativeSessionId: CLAUDE_SELF_NATIVE,
    turn: { kind: "claude" as const, phase },
  };
}

async function rewriteCursorAsV1(
  statePath: string,
  markerKinds: readonly ("user_prompt" | "tool_boundary" | "stop")[],
): Promise<Buffer> {
  const current = JSON.parse(await readFile(statePath, "utf8")) as Record<
    string,
    unknown
  >;
  const revision = current.cursor_revision as number;
  const legacy = {
    schema: NUDGE_CURSOR_SCHEMA_V1,
    provider: current.provider,
    session_id: current.session_id,
    workstream_id: current.workstream_id,
    membership_from: current.membership_from,
    cursor_revision: revision,
    feed_cursors: current.feed_cursors,
    markers: Object.fromEntries(markerKinds.map((kind) => [kind, revision])),
    updated_at: current.updated_at,
  };
  const bytes = Buffer.from(`${JSON.stringify(legacy)}\n`);
  await writeFile(statePath, bytes);
  return bytes;
}

test("a peer turn published before a new reader starts remains unread", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);

  const initialized = await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  assert.equal(initialized.status, "ready");
  assert.equal(initialized.unread_count, 0);

  const later = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 2,
    startedAt: "2026-08-23T10:00:00.100Z",
    endedAt: "2026-08-23T10:00:01.000Z",
    request: "finish slice one",
    response: "done",
  });
  await appendTurn(project, later);

  // This observer is constructed only after the completed turn exists. A
  // WatchEngine-style prime would swallow it; the persistent cursor cannot.
  const unread = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(unread.status, "ready");
  assert.equal(unread.unread_count, 1);
  assert.equal(unread.latest?.turn.value.turn_id, later.turn_id);
  assert.deepEqual(
    await inspectUnreadPeerTurns({
      projectRoot: project,
      provider: "codex",
      sessionId: SELF_SESSION,
    }),
    unread,
  );

  await seedFullyDeliveredCursor({
    ...selfOptions(project),
    now: new Date("2026-08-23T10:00:02.000Z"),
  });
  const delayedLowerSequence = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 1,
    startedAt: "2026-08-23T10:00:02.100Z",
    endedAt: "2026-08-23T10:00:03.000Z",
    request: "a delayed parent",
  });
  await appendTurn(project, delayedLowerSequence);
  const physical = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(physical.status, "ready");
  assert.equal(physical.unread_count, 1);
  assert.equal(physical.latest?.turn.value.turn_id, delayedLowerSequence.turn_id);
});

test("task-notification verdicts are unread content, not nudge echoes", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "user_prompt",
    now: T_ZERO,
  });
  const verdict = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 1,
    startedAt: "2026-08-23T10:01:00.000Z",
    endedAt: "2026-08-23T10:02:00.000Z",
    request:
      `<task-notification><summary>${WATCH_WAKE_MARKER}</summary>` +
      `<event>TURN</event></task-notification>`,
    response: "CHECKPOINT 3 APPROVED — ship it",
    turnStartMethod: "task-notification",
  });
  assert.equal(isEchoTurn(verdict), true);
  await appendTurn(project, verdict);

  const unread = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(unread.status, "ready");
  assert.equal(unread.unread_count, 1);
  assert.match(unread.latest?.turn.value.response?.text ?? "", /^CHECKPOINT 3 APPROVED/u);
});

test("a fresh membership fences old and late-backfilled history", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  const old = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 1,
    startedAt: "2026-08-23T09:59:58.000Z",
    endedAt: "2026-08-23T09:59:59.000Z",
    request: "before self joined",
  });
  await appendTurn(project, old);

  const statePath = new NudgeCursorStateStore(project).cursorPath(
    "codex",
    SELF_SESSION,
  );
  const before = await snapshotTree(project);
  const first = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(first.status, "ready");
  assert.equal(first.unread_count, 0);
  assert.equal(await snapshotTree(project), before);
  await assert.rejects(access(statePath), { code: "ENOENT" });

  const lateBackfill = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 2,
    startedAt: "2026-08-23T09:59:58.500Z",
    endedAt: "2026-08-23T09:59:59.500Z",
    request: "published late but completed before membership",
  });
  await appendTurn(project, lateBackfill);
  const equalToFence = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 3,
    startedAt: "2026-08-23T09:59:59.000Z",
    endedAt: T_ZERO.toISOString(),
    request: "completed exactly at the membership fence",
  });
  await appendTurn(project, equalToFence);
  const stillOld = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(stillOld.status, "ready");
  assert.equal(stillOld.unread_count, 0);

  const postJoin = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 4,
    startedAt: "2026-08-23T10:00:00.000Z",
    endedAt: "2026-08-23T10:00:00.001Z",
    request: "after self joined",
  });
  await appendTurn(project, postJoin);
  const news = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(news.status, "ready");
  assert.equal(news.unread_count, 1);
  assert.equal(news.latest?.turn.value.turn_id, postJoin.turn_id);
});

test("moving workstreams installs the latest membership fence", async (t) => {
  const project = await temporaryProject(t);
  const alpha = await joinPeerAndSelf(project, { name: "alpha" });
  const betaPeerNative = "beta-peer";
  const betaPeerSession = createSessionId("claude", betaPeerNative);
  const betaAdmission = await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: betaPeerNative,
    event: "UserPromptSubmit",
    prompt: "/barbaro new beta",
    now: new Date("2026-08-23T09:59:51.000Z"),
  });
  assert.ok(betaAdmission.participation?.workstream_id !== undefined);
  const beta = betaAdmission.participation.workstream_id;
  const betaOld = turnRecord({
    sessionId: betaPeerSession,
    workstreamId: beta,
    sequence: 1,
    startedAt: "2026-08-23T10:00:30.000Z",
    endedAt: "2026-08-23T10:00:31.000Z",
    request: "beta history before move",
  });
  await appendTurn(project, betaOld);

  const moved = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId: SELF_NATIVE,
    event: "UserPromptSubmit",
    prompt: "$barbaro join beta",
    now: new Date("2026-08-23T10:01:00.000Z"),
  });
  assert.equal(moved.participation?.workstream_id, beta);
  const afterMoveBaseline = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(afterMoveBaseline.status, "ready");
  assert.equal(afterMoveBaseline.workstream_id, beta);
  assert.equal(afterMoveBaseline.unread_count, 0);

  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId: alpha,
      sequence: 1,
      startedAt: "2026-08-23T10:01:00.100Z",
      endedAt: "2026-08-23T10:01:01.000Z",
      request: "old workstream news",
    }),
  );
  const betaNews = turnRecord({
    sessionId: betaPeerSession,
    workstreamId: beta,
    sequence: 2,
    startedAt: "2026-08-23T10:01:00.100Z",
    endedAt: "2026-08-23T10:01:01.001Z",
    request: "current workstream news",
  });
  await appendTurn(project, betaNews);
  const unread = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(unread.status, "ready");
  assert.equal(unread.unread_count, 1);
  assert.equal(unread.latest?.turn.value.turn_id, betaNews.turn_id);
});

test("observers and parallel waiters leave cursor bytes untouched", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "unread for both waiters",
    }),
  );
  await appendTurn(
    project,
    turnRecord({
      provider: "codex",
      sessionId: SELF_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.100Z",
      endedAt: "2026-08-23T10:00:02.100Z",
      request: "my own publication is never peer news",
    }),
  );
  const statePath = new NudgeCursorStateStore(project).cursorPath(
    "codex",
    SELF_SESSION,
  );
  const bytesBefore = await readFile(statePath);
  const treeBefore = await snapshotTree(project);
  const [first, second] = await Promise.all([
    inspectUnreadPeerTurns(selfOptions(project)),
    inspectUnreadPeerTurns(selfOptions(project)),
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.status, "ready");
  assert.equal(first.unread_count, 1);
  assert.deepEqual(await readFile(statePath), bytesBefore);
  assert.equal(await snapshotTree(project), treeBefore);
});

test("unjoined and selection-pending sessions never create nudge state", async (t) => {
  const project = await temporaryProject(t);
  const options = {
    projectRoot: project,
    provider: "codex" as const,
    nativeSessionId: "not-enrolled",
    turn: { kind: "codex" as const, turn_id: SELF_TURN },
  };
  assert.deepEqual(await inspectUnreadPeerTurns(options), {
    status: "not_joined",
  });
  assert.deepEqual(
    await claimHookNudge({ ...options, marker: "user_prompt" }),
    { status: "not_joined" },
  );
  assert.deepEqual(await seedFullyDeliveredCursor(options), {
    status: "not_joined",
  });
  const described = await admitHookSession({
    ...options,
    event: "UserPromptSubmit",
    prompt: "$barbaro",
  });
  assert.equal(described.pending, "workstream-selection");
  assert.deepEqual(
    await claimHookNudge({ ...options, marker: "stop" }),
    { status: "not_joined" },
  );

  // Legacy v1 consent is real enrollment but has no workstream scope yet.
  // It must remain ineligible until a forward membership is selected.
  const pendingSession = createSessionId("codex", options.nativeSessionId);
  const pendingPath = join(
    project,
    ".barbaro",
    "sessions",
    "codex",
    `${pendingSession}.json`,
  );
  await mkdir(join(pendingPath, ".."), { recursive: true });
  await writeFile(
    pendingPath,
    `${JSON.stringify({
      schema: SESSION_PARTICIPATION_SCHEMA,
      provider: "codex",
      session_id: pendingSession,
      joined_at: T_ZERO.toISOString(),
      initiated_by: "user_prompt",
    })}\n`,
  );
  assert.deepEqual(await inspectUnreadPeerTurns(options), {
    status: "workstream_pending",
  });
  assert.deepEqual(
    await claimHookNudge({ ...options, marker: "stop" }),
    { status: "workstream_pending" },
  );
  assert.deepEqual(await seedFullyDeliveredCursor(options), {
    status: "workstream_pending",
  });
  await assert.rejects(access(join(project, ".barbaro", "state", "nudge")), {
    code: "ENOENT",
  });
});

test("nudge claims share a high-water and Stop latch atomically", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "claim me once",
    }),
  );

  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      claimHookNudge({
        ...selfOptions(project),
        marker: index % 2 === 0 ? "user_prompt" : "tool_boundary",
        now: new Date("2026-08-23T10:00:03.000Z"),
      }),
    ),
  );
  assert.equal(
    claims.filter((claim) => claim.status === "ready" && claim.claimed).length,
    1,
  );
  const prompt = await claimHookNudge({
    ...selfOptions(project),
    marker: "user_prompt",
  });
  const stop = await claimHookNudge({
    ...selfOptions(project),
    marker: "stop",
  });
  assert.equal(prompt.status, "ready");
  assert.equal(prompt.claimed, false, "same count is not news");
  assert.equal(stop.status, "ready");
  assert.equal(stop.claimed, false, "same-turn delivery suppresses Stop");
  const cursorAfterDecline = await new NudgeCursorStateStore(project).read(
    "codex",
    SELF_SESSION,
  );
  assert.equal(cursorAfterDecline?.markers.stop, undefined);

  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 2,
      startedAt: "2026-08-23T10:00:04.000Z",
      endedAt: "2026-08-23T10:00:05.000Z",
      request: "higher count is news",
    }),
  );
  const higher = await Promise.all(
    Array.from({ length: 6 }, () =>
      claimHookNudge({
        ...selfOptions(project),
        marker: "tool_boundary",
      }),
    ),
  );
  assert.equal(
    higher.filter((claim) => claim.status === "ready" && claim.claimed).length,
    1,
  );

  const nextTurn = {
    ...selfOptions(project),
    turn: { kind: "codex" as const, turn_id: `turn_${"2".repeat(32)}` },
  };
  const quietNextPrompt = await claimHookNudge({
    ...nextTurn,
    marker: "user_prompt",
  });
  assert.equal(quietNextPrompt.status, "ready");
  assert.equal(quietNextPrompt.claimed, false);
  const nextStops = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      claimHookNudge({
        ...nextTurn,
        marker: "stop",
        turn: {
          kind: "codex",
          turn_id: `turn_${(index + 2).toString(16).repeat(32)}`,
        },
      }),
    ),
  );
  assert.equal(
    nextStops.filter((claim) => claim.status === "ready" && claim.claimed).length,
    1,
    "the next turn blocks once under concurrency",
  );
  assert.equal(
    nextStops.filter((claim) => claim.status === "already_claimed").length,
    7,
  );

  const advanced = await seedFullyDeliveredCursor(selfOptions(project));
  assert.equal(advanced.status, "ready");
  assert.equal(advanced.unread_count, 2);
  assert.equal((await inspectUnreadPeerTurns(selfOptions(project))).status, "ready");
  const cleared = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(cleared.status, "ready");
  assert.equal(cleared.unread_count, 0);

  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 3,
      startedAt: "2026-08-23T10:00:06.000Z",
      endedAt: "2026-08-23T10:00:07.000Z",
      request: "new cursor revision",
    }),
  );
  const rearmed = await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
  });
  assert.equal(rearmed.status, "ready");
  assert.equal(rearmed.claimed, true);
  const rearmedStop = await claimHookNudge({
    ...selfOptions(project),
    marker: "stop",
    turn: { kind: "codex", turn_id: `turn_${"f".repeat(32)}` },
  });
  assert.equal(rearmedStop.status, "ready");
  assert.equal(rearmedStop.claimed, true, "a context read rearms Stop too");
});

test("a Stop-first delivery establishes the shared announcement high-water", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "Stop sees this first",
    }),
  );
  const stopped = await claimHookNudge({
    ...selfOptions(project),
    marker: "stop",
  });
  assert.equal(stopped.status, "ready");
  assert.equal(stopped.claimed, true);
  const secondTurn = {
    ...selfOptions(project),
    turn: { kind: "codex" as const, turn_id: `turn_${"2".repeat(32)}` },
  };
  const quietPrompt = await claimHookNudge({
    ...secondTurn,
    marker: "user_prompt",
  });
  const quietTool = await claimHookNudge({
    ...secondTurn,
    marker: "tool_boundary",
  });
  assert.equal(quietPrompt.status, "ready");
  assert.equal(quietPrompt.claimed, false);
  assert.equal(quietTool.status, "ready");
  assert.equal(quietTool.claimed, false);

  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 2,
      startedAt: "2026-08-23T10:00:03.000Z",
      endedAt: "2026-08-23T10:00:04.000Z",
      request: "a higher count is still news",
    }),
  );
  const higher = await claimHookNudge({
    ...secondTurn,
    marker: "tool_boundary",
  });
  assert.equal(higher.status, "ready");
  assert.equal(higher.claimed, true);
});

test("Stop rollback restores only the delivery ledger it claimed", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "first announcement",
    }),
  );
  const firstTurn = selfOptions(project);
  const announced = await claimHookNudge({
    ...firstTurn,
    marker: "user_prompt",
  });
  assert.equal(announced.status, "ready");
  assert.equal(announced.claimed, true);
  const store = new NudgeCursorStateStore(project);
  const beforeStop = await store.read("codex", SELF_SESSION);
  assert.equal(beforeStop?.schema, NUDGE_CURSOR_SCHEMA);

  const secondTurn = {
    ...firstTurn,
    turn: { kind: "codex" as const, turn_id: `turn_${"2".repeat(32)}` },
  };
  const stopped = await claimHookNudge({
    ...secondTurn,
    marker: "stop",
  });
  assert.equal(stopped.status, "ready");
  assert.equal(stopped.claimed, true);
  assert.ok(stopped.status === "ready" && stopped.stop_rollback);
  assert.equal(
    await rollbackHookStopClaim({
      projectRoot: project,
      receipt: stopped.stop_rollback,
    }),
    true,
  );
  const restored = await store.read("codex", SELF_SESSION);
  assert.equal(restored?.markers.stop, undefined);
  assert.deepEqual(
    restored?.schema === NUDGE_CURSOR_SCHEMA ? restored.delivery : undefined,
    beforeStop?.schema === NUDGE_CURSOR_SCHEMA
      ? beforeStop.delivery
      : undefined,
  );

  const retriedStop = await claimHookNudge({
    ...secondTurn,
    marker: "stop",
  });
  assert.equal(retriedStop.status, "ready");
  assert.equal(retriedStop.claimed, true);
  assert.ok(retriedStop.status === "ready" && retriedStop.stop_rollback);

  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 2,
      startedAt: "2026-08-23T10:00:03.000Z",
      endedAt: "2026-08-23T10:00:04.000Z",
      request: "new peer news wins over rollback",
    }),
  );
  const thirdTurn = {
    ...firstTurn,
    turn: { kind: "codex" as const, turn_id: `turn_${"3".repeat(32)}` },
  };
  const newerAnnouncement = await claimHookNudge({
    ...thirdTurn,
    marker: "tool_boundary",
  });
  assert.equal(newerAnnouncement.status, "ready");
  assert.equal(newerAnnouncement.claimed, true);
  assert.equal(
    await rollbackHookStopClaim({
      projectRoot: project,
      receipt: retriedStop.stop_rollback,
    }),
    true,
  );
  const preserved = await store.read("codex", SELF_SESSION);
  assert.equal(preserved?.markers.stop, undefined);
  assert.deepEqual(
    preserved?.schema === NUDGE_CURSOR_SCHEMA ? preserved.delivery : undefined,
    {
      highest_unread_count: 2,
      last_turn: thirdTurn.turn,
    },
  );

  const sameTurnStop = await claimHookNudge({
    ...thirdTurn,
    marker: "stop",
  });
  assert.equal(sameTurnStop.status, "ready");
  assert.equal(sameTurnStop.claimed, false);
  const fourthTurnStop = await claimHookNudge({
    ...firstTurn,
    marker: "stop",
    turn: { kind: "codex", turn_id: `turn_${"4".repeat(32)}` },
  });
  assert.equal(fourthTurnStop.status, "ready");
  assert.equal(fourthTurnStop.claimed, true);
});

test("Stop rollback cannot cross a context revision", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "revision-fenced rollback",
    }),
  );
  const stopped = await claimHookNudge({
    ...selfOptions(project),
    marker: "stop",
  });
  assert.equal(stopped.status, "ready");
  assert.equal(stopped.claimed, true);
  assert.ok(stopped.status === "ready" && stopped.stop_rollback);
  const store = new NudgeCursorStateStore(project);
  const path = store.cursorPath("codex", SELF_SESSION);
  const advanced = await seedFullyDeliveredCursor(selfOptions(project));
  assert.equal(advanced.status, "ready");
  const advancedBytes = await readFile(path);

  assert.equal(
    await rollbackHookStopClaim({
      projectRoot: project,
      receipt: stopped.stop_rollback,
    }),
    false,
  );
  assert.deepEqual(await readFile(path), advancedBytes);
});

test("v1 cursors stay observer-only and migrate with conservative turn attribution", async (t) => {
  for (const firstMarker of ["tool_boundary", "user_prompt"] as const) {
    const project = await temporaryProject(t);
    const workstreamId = await joinPeerAndSelf(project);
    await claimHookNudge({
      ...selfOptions(project),
      marker: "tool_boundary",
      now: T_ZERO,
    });
    await appendTurn(
      project,
      turnRecord({
        sessionId: PEER_SESSION,
        workstreamId,
        sequence: 1,
        startedAt: "2026-08-23T10:00:01.000Z",
        endedAt: "2026-08-23T10:00:02.000Z",
        request: `legacy ${firstMarker}`,
      }),
    );
    const store = new NudgeCursorStateStore(project);
    const statePath = store.cursorPath("codex", SELF_SESSION);
    const legacyBytes = await rewriteCursorAsV1(statePath, [firstMarker]);

    const observed = await inspectUnreadPeerTurns(selfOptions(project));
    assert.equal(observed.status, "ready");
    assert.equal(observed.unread_count, 1);
    assert.deepEqual(await readFile(statePath), legacyBytes);

    const first = await claimHookNudge({
      ...selfOptions(project),
      marker: firstMarker,
    });
    assert.equal(first.status, "ready");
    assert.equal(first.claimed, false, "legacy count is already announced");
    const migrated = await store.read("codex", SELF_SESSION);
    assert.equal(migrated?.schema, NUDGE_CURSOR_SCHEMA);
    assert.equal(
      migrated?.schema === NUDGE_CURSOR_SCHEMA
        ? migrated.delivery.highest_unread_count
        : -1,
      1,
    );

    const stop = await claimHookNudge({
      ...selfOptions(project),
      marker: "stop",
    });
    assert.equal(stop.status, "ready");
    assert.equal(
      stop.claimed,
      firstMarker === "user_prompt",
      "a definite prompt starts a new turn; a mid-turn hook does not",
    );
  }
});

test("Claude v1 migration preserves conservative turns and monotonic generations", async (t) => {
  for (const firstMarker of ["tool_boundary", "user_prompt"] as const) {
    const project = await temporaryProject(t);
    const workstreamId = await joinCodexPeerAndClaudeSelf(project);
    await claimHookNudge({
      ...claudeSelfOptions(project),
      marker: "tool_boundary",
      now: T_ZERO,
    });
    await appendTurn(
      project,
      turnRecord({
        sessionId: CODEX_PEER_SESSION,
        workstreamId,
        sequence: 1,
        provider: "codex",
        startedAt: "2026-08-23T10:00:01.000Z",
        endedAt: "2026-08-23T10:00:02.000Z",
        request: `Claude legacy ${firstMarker}`,
      }),
    );
    const store = new NudgeCursorStateStore(project);
    const statePath = store.cursorPath("claude", CLAUDE_SELF_SESSION);
    const legacyBytes = await rewriteCursorAsV1(statePath, [firstMarker]);

    const observed = await inspectUnreadPeerTurns({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: CLAUDE_SELF_NATIVE,
    });
    assert.equal(observed.status, "ready");
    assert.deepEqual(await readFile(statePath), legacyBytes);

    const first = await claimHookNudge({
      ...claudeSelfOptions(
        project,
        firstMarker === "user_prompt" ? "begin" : "current",
      ),
      marker: firstMarker,
    });
    assert.equal(first.status, "ready");
    assert.equal(first.claimed, false, "legacy count is already announced");
    const migrated = await store.read("claude", CLAUDE_SELF_SESSION);
    const expectedGeneration = firstMarker === "user_prompt" ? 2 : 1;
    assert.equal(migrated?.schema, NUDGE_CURSOR_SCHEMA);
    assert.equal(
      migrated?.schema === NUDGE_CURSOR_SCHEMA
        ? migrated.claude_turn_generation
        : undefined,
      expectedGeneration,
    );

    const stop = await claimHookNudge({
      ...claudeSelfOptions(project),
      marker: "stop",
    });
    assert.equal(stop.status, "ready");
    assert.equal(
      stop.claimed,
      firstMarker === "user_prompt",
      "a definite prompt starts a new Claude turn; a mid-turn hook does not",
    );

    const advanced = await seedFullyDeliveredCursor({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: CLAUDE_SELF_NATIVE,
    });
    assert.equal(advanced.status, "ready");
    const afterContext = await store.read("claude", CLAUDE_SELF_SESSION);
    assert.equal(
      afterContext?.schema === NUDGE_CURSOR_SCHEMA
        ? afterContext.claude_turn_generation
        : undefined,
      expectedGeneration,
      "context rearms channels without resetting Claude turn identity",
    );
    assert.deepEqual(afterContext?.markers, {});
  }
});

test("v1 empty and Stop markers migrate without weakening delivery safety", async (t) => {
  for (const legacyMarkers of [[], ["stop"]] as const) {
    const project = await temporaryProject(t);
    const workstreamId = await joinPeerAndSelf(project);
    await claimHookNudge({
      ...selfOptions(project),
      marker: "tool_boundary",
      now: T_ZERO,
    });
    await appendTurn(
      project,
      turnRecord({
        sessionId: PEER_SESSION,
        workstreamId,
        sequence: 1,
        startedAt: "2026-08-23T10:00:01.000Z",
        endedAt: "2026-08-23T10:00:02.000Z",
        request: `legacy markers ${legacyMarkers.join(",")}`,
      }),
    );
    const store = new NudgeCursorStateStore(project);
    await rewriteCursorAsV1(
      store.cursorPath("codex", SELF_SESSION),
      legacyMarkers,
    );

    const result = await claimHookNudge({
      ...selfOptions(project),
      marker: legacyMarkers.length === 0 ? "tool_boundary" : "stop",
    });
    if (legacyMarkers.length === 0) {
      assert.equal(result.status, "ready");
      assert.equal(result.claimed, true);
    } else {
      assert.equal(result.status, "already_claimed");
    }
    const migrated = await store.read("codex", SELF_SESSION);
    assert.equal(migrated?.schema, NUDGE_CURSOR_SCHEMA);
    assert.equal(
      migrated?.markers.stop,
      legacyMarkers.length === 0 ? undefined : migrated?.cursor_revision,
    );
  }
});

test("v2 migration preserves its exact frontier, revision, announcement ledger and Claude generation", async (t) => {
  for (const provider of ["codex", "claude"] as const) {
    const project = await temporaryProject(t);
    const isCodex = provider === "codex";
    const workstreamId = isCodex
      ? await joinPeerAndSelf(project)
      : await joinCodexPeerAndClaudeSelf(project);
    const options = isCodex ? selfOptions(project) : claudeSelfOptions(project);
    const sessionId = isCodex ? SELF_SESSION : CLAUDE_SELF_SESSION;
    const peer = {
      provider: isCodex ? "claude" : "codex",
      sessionId: isCodex ? PEER_SESSION : CODEX_PEER_SESSION,
      workstreamId,
    };
    await appendTurn(project, turnRecord({
      ...peer, sequence: 1, request: "already fenced history",
      startedAt: "2026-08-23T09:59:51.000Z", endedAt: "2026-08-23T09:59:52.000Z",
    }));
    await claimHookNudge({ ...options, marker: "tool_boundary", now: T_ZERO });
    await appendTurn(project, turnRecord({
      ...peer, sequence: 2, request: "unread news",
      startedAt: "2026-08-23T10:00:01.000Z", endedAt: "2026-08-23T10:00:02.000Z",
    }));
    const claimed = await claimHookNudge({ ...options, marker: "stop" });
    assert.equal(claimed.status, "ready");
    assert.equal(claimed.claimed, true);
    const store = new NudgeCursorStateStore(project);
    const current = await store.read(provider, sessionId);
    assert.equal(current?.schema, NUDGE_CURSOR_SCHEMA);
    const { reads: _reads, schema: _schema, ...base } = current;
    const legacy = {
      ...base,
      ...(isCodex ? {} : {
        claude_turn_generation: 7,
        delivery: { ...base.delivery, last_turn: { kind: "claude", generation: 7 } },
      }),
      schema: NUDGE_CURSOR_SCHEMA_V2,
    };
    const path = store.cursorPath(provider, sessionId);
    const legacyBytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, legacyBytes);
    const observed = await inspectUnreadPeerTurns(options);
    assert.equal(observed.status, "ready");
    assert.equal(observed.unread_count, 1);
    assert.equal(await readFile(path, "utf8"), legacyBytes, "observer does not migrate");
    const migratedClaim = await claimHookNudge({ ...options, marker: "tool_boundary" });
    assert.equal(migratedClaim.status, "ready");
    assert.equal(migratedClaim.claimed, false, "migration does not announce old history");
    const migrated = await store.read(provider, sessionId);
    assert.equal(migrated?.schema, NUDGE_CURSOR_SCHEMA);
    assert.deepEqual(migrated, {
      ...legacy, schema: NUDGE_CURSOR_SCHEMA, reads: emptyNudgeReadState(),
      updated_at: migrated.updated_at,
    });
    assert.equal(migrated.feed_cursors.length, 1);
    assert.ok(migrated.feed_cursors[0]!.checkpoint.byte_offset > 0);
    assert.equal((await claimHookNudge({ ...options, marker: "stop" })).status, "already_claimed");
  }
});

test("sparse delivery leaves older gaps unread in both scanners and compacts only after gaps close", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  const turns = Array.from({ length: 8 }, (_, index) => turnRecord({
    sessionId: PEER_SESSION, workstreamId, sequence: index + 1,
    request: `request ${index + 1}`, response: `response ${index + 1}`,
    startedAt: `2026-08-23T10:00:0${index + 1}.000Z`,
    endedAt: `2026-08-23T10:00:0${index + 1}.500Z`,
  }));
  for (const turn of turns) await appendTurn(project, turn);
  const claim = await claimHookNudge({ ...selfOptions(project), marker: "tool_boundary" });
  assert.equal(claim.status, "ready");
  assert.equal(claim.unread_count, 8);
  const store = new NudgeCursorStateStore(project);
  function delivered(turn: BarbaroTurnV1): NudgeReadCoverage {
    const text = selectTurnText(turn, "response").text;
    return {
      provider: turn.provider, session_id: turn.session_id, turn_id: turn.turn_id,
      record_sha256: readRecordHash(turn), field: "response",
      field_sha256: readContentHash(text), total_bytes: Buffer.byteLength(text),
      ranges: [{ start: 0, end: Buffer.byteLength(text) }],
    };
  }
  // These are synthetic, already-attested receipts. Provider attestation is
  // tested separately; this exercise targets the persistent unread semantics.
  async function seedCoverage(entries: readonly NudgeReadCoverage[]): Promise<void> {
    await store.withHookWrite("codex", SELF_SESSION, async (current) => {
      assert.equal(current?.schema, NUDGE_CURSOR_SCHEMA);
      return { state: { ...current, reads: mergeReadCoverage(current.reads, entries) }, result: undefined };
    });
  }
  async function assertBoth(expected: number): Promise<void> {
    const before = await snapshotTree(project);
    const hook = await inspectUnreadPeerTurns(selfOptions(project));
    assert.equal(hook.status, "ready");
    assert.equal(hook.unread_count, expected);
    const batch = await readUnreadSummaryBatch({ projectRoot: project, recipients: [{
      provider: "codex", session_id: SELF_SESSION,
      workstream_id: workstreamId, membership_from: T_ZERO.toISOString(),
    }] });
    assert.equal(batch.items[0]!.status, "ready");
    const summary = batch.items[0]!;
    assert.equal(summary.status === "ready" ? summary.unread_count : -1, expected);
    assert.equal(await snapshotTree(project), before);
  }
  await seedCoverage(turns.slice(3).map(delivered));
  await assertBoth(3);
  const first = delivered(turns[0]!);
  await seedCoverage([{ ...first, ranges: [{ start: 0, end: 2 }, { start: 3, end: first.total_bytes }] }]);
  await assertBoth(3);
  await seedCoverage([{ ...first, ranges: [{ start: 2, end: 3 }] }]);
  await assertBoth(2);
  const changed = { ...turns[7]!, outcome: "failed" as const };
  await replaceFeed(project, "claude", PEER_SESSION, [...turns.slice(0, 7), changed]);
  await assertBoth(3);
  await seedCoverage([delivered(turns[1]!), delivered(turns[2]!), delivered(changed)]);
  await assertBoth(0);
  const beforeCollapse = await store.read("codex", SELF_SESSION);
  const zero = await claimHookNudge({ ...selfOptions(project), marker: "tool_boundary" });
  assert.equal(zero.status, "ready");
  assert.equal(zero.claimed, false);
  const collapsed = await store.read("codex", SELF_SESSION);
  assert.equal(collapsed?.schema, NUDGE_CURSOR_SCHEMA);
  assert.equal(collapsed.reads.coverage.length, 0);
  assert.equal(collapsed.cursor_revision, beforeCollapse?.cursor_revision);
  assert.ok(collapsed.feed_cursors[0]!.checkpoint.byte_offset > 0);
  await assertBoth(0);
  await appendTurn(project, turnRecord({
    sessionId: PEER_SESSION, workstreamId, sequence: 9, request: "post-snapshot arrival",
    startedAt: "2026-08-23T10:00:09.000Z", endedAt: "2026-08-23T10:00:09.500Z",
  }));
  await assertBoth(1);
});

test("a leading context acknowledgement upgrades v1 and fully rearms v2", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "acknowledge legacy state",
    }),
  );
  const store = new NudgeCursorStateStore(project);
  const before = await store.read("codex", SELF_SESSION);
  assert.ok(before);
  await rewriteCursorAsV1(
    store.cursorPath("codex", SELF_SESSION),
    ["user_prompt", "stop"],
  );

  const advanced = await seedFullyDeliveredCursor(selfOptions(project));
  assert.equal(advanced.status, "ready");
  assert.equal(advanced.unread_count, 1);
  const after = await store.read("codex", SELF_SESSION);
  assert.equal(after?.schema, NUDGE_CURSOR_SCHEMA);
  assert.equal(after?.cursor_revision, before.cursor_revision + 1);
  assert.deepEqual(after?.markers, {});
  assert.deepEqual(
    after?.schema === NUDGE_CURSOR_SCHEMA ? after.delivery : undefined,
    { highest_unread_count: 0 },
  );
  const unread = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(unread.status, "ready");
  assert.equal(unread.unread_count, 0);
});

test("corrupt cursor state fails closed and is never repaired by a reader or hook", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "user_prompt",
    now: T_ZERO,
  });
  const statePath = new NudgeCursorStateStore(project).cursorPath(
    "codex",
    SELF_SESSION,
  );
  await writeFile(statePath, "{broken\n", "utf8");
  await appendTurn(
    project,
    turnRecord({
      sessionId: PEER_SESSION,
      workstreamId,
      sequence: 1,
      startedAt: "2026-08-23T10:00:01.000Z",
      endedAt: "2026-08-23T10:00:02.000Z",
      request: "must not be swallowed by repair",
    }),
  );
  const corruptBytes = await readFile(statePath);
  await assert.rejects(
    inspectUnreadPeerTurns(selfOptions(project)),
    (error: unknown) => error instanceof InvalidNudgeCursorError,
  );
  await assert.rejects(
    claimHookNudge({ ...selfOptions(project), marker: "stop" }),
    (error: unknown) => error instanceof InvalidNudgeCursorError,
  );
  assert.deepEqual(await readFile(statePath), corruptBytes);
});

test("runtime turn evidence and every v2 field stay strictly validated", async (t) => {
  const project = await temporaryProject(t);
  await joinPeerAndSelf(project);
  await assert.rejects(
    claimHookNudge({
      ...selfOptions(project),
      marker: "tool_boundry" as never,
    }),
    /Invalid nudge marker/u,
  );
  await assert.rejects(
    claimHookNudge({
      ...selfOptions(project),
      marker: "tool_boundary",
      turn: { kind: "codex", turn_id: "native-not-stable" },
    }),
    /turn id is invalid/u,
  );
  await assert.rejects(
    claimHookNudge({
      ...selfOptions(project),
      marker: "tool_boundary",
      turn: { kind: "claude", phase: "current" } as never,
    }),
    /does not match its provider/u,
  );
  await assert.rejects(
    claimHookNudge({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: CLAUDE_SELF_NATIVE,
      marker: "tool_boundary",
      turn: { kind: "claude", phase: "later" } as never,
    }),
    /turn phase is invalid/u,
  );

  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  const statePath = new NudgeCursorStateStore(project).cursorPath(
    "codex",
    SELF_SESSION,
  );
  const validBytes = await readFile(statePath);
  const invalidMutations: readonly ((state: Record<string, unknown>) => void)[] = [
    (state) => {
      state["markers"] = { user_prompt: state["cursor_revision"] };
    },
    (state) => {
      state["markers"] = { stop: (state["cursor_revision"] as number) + 1 };
    },
    (state) => {
      (state["delivery"] as Record<string, unknown>)["highest_unread_count"] = -1;
    },
    (state) => {
      (state["delivery"] as Record<string, unknown>)["surprise"] = true;
    },
    (state) => {
      state["delivery"] = {
        highest_unread_count: 1,
        last_turn: { kind: "claude", generation: 1 },
      };
    },
    (state) => {
      state["claude_turn_generation"] = 1;
    },
    (state) => {
      state["unknown"] = true;
    },
  ];
  for (const mutate of invalidMutations) {
    const state = JSON.parse(validBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    mutate(state);
    const invalidBytes = Buffer.from(`${JSON.stringify(state)}\n`);
    await writeFile(statePath, invalidBytes);
    await assert.rejects(
      inspectUnreadPeerTurns(selfOptions(project)),
      (error: unknown) => error instanceof InvalidNudgeCursorError,
    );
    assert.deepEqual(await readFile(statePath), invalidBytes);
    await writeFile(statePath, validBytes);
  }

  const validV1Bytes = await rewriteCursorAsV1(statePath, ["user_prompt"]);
  for (const mutate of [
    (state: Record<string, unknown>) => {
      state["unknown"] = true;
    },
    (state: Record<string, unknown>) => {
      state["markers"] = {
        tool_boundry: state["cursor_revision"],
      };
    },
    (state: Record<string, unknown>) => {
      state["markers"] = {
        stop: (state["cursor_revision"] as number) + 1,
      };
    },
  ]) {
    const state = JSON.parse(validV1Bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    mutate(state);
    const invalidBytes = Buffer.from(`${JSON.stringify(state)}\n`);
    await writeFile(statePath, invalidBytes);
    await assert.rejects(
      inspectUnreadPeerTurns(selfOptions(project)),
      (error: unknown) => error instanceof InvalidNudgeCursorError,
    );
    assert.deepEqual(await readFile(statePath), invalidBytes);
      await writeFile(statePath, validV1Bytes);
  }

  const claudeProject = await temporaryProject(t);
  await joinCodexPeerAndClaudeSelf(claudeProject);
  await claimHookNudge({
    ...claudeSelfOptions(claudeProject),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  const claudeStatePath = new NudgeCursorStateStore(claudeProject).cursorPath(
    "claude",
    CLAUDE_SELF_SESSION,
  );
  const validClaudeBytes = await readFile(claudeStatePath);
  const invalidClaudeMutations: readonly ((
    state: Record<string, unknown>,
  ) => void)[] = [
    (state) => {
      delete state["claude_turn_generation"];
    },
    (state) => {
      state["claude_turn_generation"] = 0;
    },
    (state) => {
      state["claude_turn_generation"] = 1.5;
    },
    (state) => {
      state["delivery"] = {
        highest_unread_count: 1,
        last_turn: { kind: "claude", generation: 2 },
      };
    },
    (state) => {
      state["delivery"] = {
        highest_unread_count: 1,
        last_turn: { kind: "claude", generation: 0 },
      };
    },
    (state) => {
      state["delivery"] = {
        highest_unread_count: 1,
        last_turn: { kind: "claude", generation: 1, future: true },
      };
    },
    (state) => {
      state["delivery"] = {
        highest_unread_count: 1,
        last_turn: { kind: "codex", turn_id: `turn_${"a".repeat(32)}` },
      };
    },
  ];
  for (const mutate of invalidClaudeMutations) {
    const state = JSON.parse(validClaudeBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    mutate(state);
    const invalidBytes = Buffer.from(`${JSON.stringify(state)}\n`);
    await writeFile(claudeStatePath, invalidBytes);
    await assert.rejects(
      inspectUnreadPeerTurns({
        projectRoot: claudeProject,
        provider: "claude",
        nativeSessionId: CLAUDE_SELF_NATIVE,
      }),
      (error: unknown) => error instanceof InvalidNudgeCursorError,
    );
    assert.deepEqual(await readFile(claudeStatePath), invalidBytes);
    await writeFile(claudeStatePath, validClaudeBytes);
  }
});

test("a missing feed retains its checkpoint and cannot establish complete quiet", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  const peerTurn = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 1,
    startedAt: "2026-08-23T10:00:01.000Z",
    endedAt: "2026-08-23T10:00:02.000Z",
    request: "will be acknowledged",
  });
  await appendTurn(project, peerTurn);
  await seedFullyDeliveredCursor(selfOptions(project));
  const store = new NudgeCursorStateStore(project);
  assert.equal(
    (await store.read("codex", SELF_SESSION))?.feed_cursors.length,
    1,
  );

  await rm(feedPath(project, peerTurn));
  const settled = await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
  });
  assert.equal(settled.status, "ready");
  assert.equal(settled.unread_count, 0);
  assert.equal(settled.coverage?.state, "incomplete");
  assert.equal(
    (await store.read("codex", SELF_SESSION))?.feed_cursors.length,
    1,
  );
});

test("a partial peer record stays unread until its terminating newline", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  const peerTurn = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 1,
    startedAt: "2026-08-23T10:00:01.000Z",
    endedAt: "2026-08-23T10:00:02.000Z",
    request: "complete me later",
  });
  const line = `${JSON.stringify(peerTurn)}\n`;
  const path = feedPath(project, peerTurn);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, line.slice(0, 41), "utf8");
  const partial = await claimHookNudge({
    ...selfOptions(project),
    marker: "user_prompt",
  });
  assert.equal(partial.status, "ready");
  assert.equal(partial.unread_count, 0);

  await appendFile(path, line.slice(41), "utf8");
  const complete = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(complete.status, "ready");
  assert.equal(complete.unread_count, 1);
  assert.equal(complete.latest?.turn.value.turn_id, peerTurn.turn_id);
});

test("a rebuilt feed replays conservatively and cannot blind later appends", async (t) => {
  const project = await temporaryProject(t);
  const workstreamId = await joinPeerAndSelf(project);
  await claimHookNudge({
    ...selfOptions(project),
    marker: "tool_boundary",
    now: T_ZERO,
  });
  const first = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 1,
    startedAt: "2026-08-23T10:00:01.000Z",
    endedAt: "2026-08-23T10:00:02.000Z",
    request: "first",
  });
  const second = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 2,
    startedAt: "2026-08-23T10:00:03.000Z",
    endedAt: "2026-08-23T10:00:04.000Z",
    request: "second",
  });
  await appendTurn(project, first);
  await appendTurn(project, second);
  await seedFullyDeliveredCursor(selfOptions(project));

  // A canonical rebuild invalidates the physical checkpoint. Replaying an
  // acknowledged turn is safer than WatchEngine's silent re-baseline.
  await replaceFeed(project, "claude", PEER_SESSION, [first]);
  const replay = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(replay.status, "ready");
  assert.equal(replay.unread_count, 1);

  const third = turnRecord({
    sessionId: PEER_SESSION,
    workstreamId,
    sequence: 3,
    startedAt: "2026-08-23T10:00:05.000Z",
    endedAt: "2026-08-23T10:00:06.000Z",
    request: "after rebuild",
  });
  await appendTurn(project, third);
  const after = await inspectUnreadPeerTurns(selfOptions(project));
  assert.equal(after.status, "ready");
  assert.equal(after.unread_count, 2);
  assert.equal(after.latest?.turn.value.turn_id, third.turn_id);
});
