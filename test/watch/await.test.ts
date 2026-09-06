import assert from "node:assert/strict";
import {
  appendFile,
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
  admitHookSession,
  participationMemberships,
} from "../../src/hooks/participation.js";
import {
  NUDGE_CURSOR_SCHEMA_V1,
  NudgeCursorStateStore,
  claimHookNudge,
  type UnreadPeerTurnsReady,
} from "../../src/nudge/index.js";
import {
  AWAIT_TIMEOUT_SCHEMA,
  AwaitCursorScopeError,
  AwaitCursorUnavailableError,
  AwaitScanFailureLimitError,
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
  WATCH_WAKE_MARKER,
  awaitUnreadPeerTurns,
  formatAwaitTimeout,
  formatAwaitIncomplete,
  formatAwaitUnread,
  isEchoTurn,
  type AwaitCursorOptions,
} from "../../src/watch/index.js";
import { snapshotTree } from "../setup/fixture.js";

const SELF_NATIVE = "await-self";
const SELF_SESSION = createSessionId("codex", SELF_NATIVE);
const PEER_SESSION = createSessionId("claude", "await-peer");
const JOINED_AT = new Date("2026-08-23T10:00:00.000Z");

function content(text: string): BarbaroContent {
  return { text, fidelity: "verbatim", truncated: false, redactions: [] };
}

function turnRecord(options: {
  readonly workstreamId: string;
  readonly sequence: number;
  readonly request: string;
  readonly response?: string;
  readonly echo?: boolean;
}): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${"1".repeat(16)}${options.sequence
      .toString(16)
      .padStart(16, "0")}`,
    provider: "claude",
    session_id: PEER_SESSION,
    workstream_id: options.workstreamId,
    sequence: options.sequence,
    agent_id: "main",
    started_at: "2026-08-23T10:00:01.000Z",
    ended_at: `2026-08-23T10:00:0${options.sequence + 1}.000Z`,
    outcome: "success",
    request: content(options.request),
    response: content(options.response ?? "done"),
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
    ...(options.echo === true
      ? {
          extensions: {
            claude: { turn_start: { method: "task-notification" } },
          },
        }
      : {}),
  };
}

async function appendTurn(
  projectRoot: string,
  turn: BarbaroTurnV1,
): Promise<string> {
  const directory = join(projectRoot, ".barbaro", "feed", turn.provider);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${turn.session_id}.jsonl`);
  await appendFile(path, `${JSON.stringify(turn)}\n`);
  return path;
}

async function temporaryProject(t: TestContext): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-await-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

async function cursorFixture(
  t: TestContext,
): Promise<AwaitCursorOptions & { readonly cursorPath: string }> {
  const projectRoot = await temporaryProject(t);
  const admission = await admitHookSession({
    projectRoot,
    provider: "codex",
    nativeSessionId: SELF_NATIVE,
    event: "UserPromptSubmit",
    prompt: "$barbaro new await-lane",
    now: JOINED_AT,
  });
  assert.ok(admission.participation);
  const membership = participationMemberships(admission.participation).at(-1);
  assert.ok(membership);
  const initialized = await claimHookNudge({
    projectRoot,
    provider: "codex",
    nativeSessionId: SELF_NATIVE,
    marker: "tool_boundary",
    turn: { kind: "codex", turn_id: `turn_${"1".repeat(32)}` },
    now: JOINED_AT,
  });
  assert.equal(initialized.status, "ready");
  assert.equal(initialized.unread_count, 0);
  return {
    projectRoot,
    provider: "codex",
    sessionId: SELF_SESSION,
    workstreamId: membership.workstream_id,
    membershipFrom: membership.from,
    cursorPath: new NudgeCursorStateStore(projectRoot).cursorPath(
      "codex",
      SELF_SESSION,
    ),
  };
}

function ready(
  options: AwaitCursorOptions,
  unreadCount: number,
): UnreadPeerTurnsReady {
  return {
    status: "ready",
    provider: options.provider,
    session_id: options.sessionId,
    workstream_id: options.workstreamId,
    membership_from: options.membershipFrom,
    cursor_revision: 7,
    unread_count: unreadCount,
  };
}

test("a v1 cursor returns pre-existing task-notification unread without repair", async (t) => {
  const options = await cursorFixture(t);
  const echo = turnRecord({
    workstreamId: options.workstreamId,
    sequence: 1,
    request:
      `<task-notification><summary>${WATCH_WAKE_MARKER}</summary></task-notification>`,
    response: "CHECKPOINT 3 APPROVED",
    echo: true,
  });
  assert.equal(isEchoTurn(echo), true, "watch still classifies this as an echo");
  const feedPath = await appendTurn(options.projectRoot, echo);
  const v2 = JSON.parse(await readFile(options.cursorPath, "utf8")) as Record<
    string,
    unknown
  >;
  const cursorBefore = Buffer.from(`${JSON.stringify({
    schema: NUDGE_CURSOR_SCHEMA_V1,
    provider: v2.provider,
    session_id: v2.session_id,
    workstream_id: v2.workstream_id,
    membership_from: v2.membership_from,
    cursor_revision: v2.cursor_revision,
    feed_cursors: v2.feed_cursors,
    markers: {},
    updated_at: v2.updated_at,
  })}\n`);
  await writeFile(options.cursorPath, cursorBefore);
  const feedBefore = await readFile(feedPath);
  const treeBefore = await snapshotTree(options.projectRoot);

  const result = await awaitUnreadPeerTurns({
    ...options,
    timeoutMs: 100,
    intervalMs: 10,
    sleep: async () => assert.fail("pre-existing unread must not sleep"),
  });

  assert.deepEqual(result, {
    schema: AWAIT_TIMEOUT_SCHEMA,
    kind: "unread",
    provider: "codex",
    session_id: SELF_SESSION,
    workstream_id: options.workstreamId,
    cursor_revision: 1,
    unread_count: 1,
  });
  if (result.kind === "unread") {
    assert.match(formatAwaitUnread(result), /^1 unread — run barbaro read context --provider codex /u);
    assert.ok(formatAwaitUnread(result).includes(`--session-id ${SELF_SESSION}`));
    assert.ok(formatAwaitUnread(result).includes(`--workstream ${options.workstreamId}`));
  }
  assert.deepEqual(await readFile(options.cursorPath), cursorBefore);
  assert.deepEqual(await readFile(feedPath), feedBefore);
  assert.equal(await snapshotTree(options.projectRoot), treeBefore);
});

test("concurrent waiters report the same unread count without consuming it", async (t) => {
  const options = await cursorFixture(t);
  const feedPath = await appendTurn(
    options.projectRoot,
    turnRecord({
      workstreamId: options.workstreamId,
      sequence: 1,
      request: "first unread",
    }),
  );
  await appendTurn(
    options.projectRoot,
    turnRecord({
      workstreamId: options.workstreamId,
      sequence: 2,
      request: "second unread",
    }),
  );
  const cursorBefore = await readFile(options.cursorPath);
  const feedBefore = await readFile(feedPath);
  const treeBefore = await snapshotTree(options.projectRoot);
  const run = () =>
    awaitUnreadPeerTurns({
      ...options,
      timeoutMs: 100,
      intervalMs: 10,
      sleep: async () => assert.fail("pre-existing unread must not sleep"),
    });

  const [first, second] = await Promise.all([run(), run()]);
  assert.deepEqual(second, first);
  assert.equal(first.kind, "unread");
  assert.equal(first.kind === "unread" ? first.unread_count : -1, 2);
  assert.deepEqual(await readFile(options.cursorPath), cursorBefore);
  assert.deepEqual(await readFile(feedPath), feedBefore);
  assert.equal(await snapshotTree(options.projectRoot), treeBefore);
});

test("an await reader never initializes a missing physical cursor", async (t) => {
  const projectRoot = await temporaryProject(t);
  const admission = await admitHookSession({
    projectRoot,
    provider: "codex",
    nativeSessionId: "await-no-cursor",
    event: "UserPromptSubmit",
    prompt: "$barbaro new await-virtual",
    now: JOINED_AT,
  });
  assert.ok(admission.participation);
  const membership = participationMemberships(admission.participation).at(-1);
  assert.ok(membership);
  const sessionId = createSessionId("codex", "await-no-cursor");
  const options: AwaitCursorOptions = {
    projectRoot,
    provider: "codex",
    sessionId,
    workstreamId: membership.workstream_id,
    membershipFrom: membership.from,
  };
  const cursorStore = new NudgeCursorStateStore(projectRoot);
  assert.equal(await cursorStore.read("codex", sessionId), undefined);
  const treeBefore = await snapshotTree(projectRoot);
  let clock = 0;
  const result = await awaitUnreadPeerTurns({
    ...options,
    timeoutMs: 1,
    intervalMs: 1,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  assert.equal(result.kind, "timeout");
  assert.equal(await cursorStore.read("codex", sessionId), undefined);
  assert.equal(await snapshotTree(projectRoot), treeBefore);
});

test("a zero-unread scan waits, then returns the first positive count", async (t) => {
  const options = await cursorFixture(t);
  let clock = 0;
  let scans = 0;
  const sleeps: number[] = [];
  const result = await awaitUnreadPeerTurns({
    ...options,
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    inspect: async () => ready(options, scans++ === 0 ? 0 : 3),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  assert.deepEqual(sleeps, [10]);
  assert.equal(scans, 2);
  assert.equal(result.kind, "unread");
  assert.equal(result.kind === "unread" ? result.unread_count : -1, 3);
});

test("timeout remains a successful bounded value after a final ready scan", async (t) => {
  const options = await cursorFixture(t);
  let clock = 0;
  let scans = 0;
  const sleeps: number[] = [];
  const result = await awaitUnreadPeerTurns({
    ...options,
    timeoutMs: 25,
    intervalMs: 10,
    now: () => clock,
    inspect: async () => {
      scans += 1;
      return ready(options, 0);
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  assert.deepEqual(sleeps, [10, 10, 5]);
  assert.equal(scans, 4);
  assert.deepEqual(result, {
    schema: AWAIT_TIMEOUT_SCHEMA,
    kind: "timeout",
    timeout_ms: 25,
  });
  if (result.kind === "timeout") {
    assert.equal(
      formatAwaitTimeout(result),
      "AWAIT timeout after 25 ms — no peer event",
    );
  }
});

test("failures at the deadline cannot masquerade as a successful timeout", async (t) => {
  const options = await cursorFixture(t);
  let clock = 0;
  let scans = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    awaitUnreadPeerTurns({
      ...options,
      timeoutMs: 10,
      intervalMs: 10,
      now: () => clock,
      inspect: async () => {
        scans += 1;
        throw new Error(`corrupt cursor ${scans}`);
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    }),
    AwaitScanFailureLimitError,
  );
  assert.deepEqual(sleeps, [10]);
  assert.equal(scans, 5);
});

test("incomplete feed coverage returns healthy news but cannot report a quiet timeout", async (t) => {
  const options = await cursorFixture(t);
  const coverage = { state: "incomplete" as const, scanned_feed_files: 1,
    unavailable: { items: [{ provider: "claude", session_id: PEER_SESSION, reason: "permission_denied" as const, code: "EACCES" }], shown: 1, total: 1 } };
  for (const count of [0, 2]) {
    let clock = 0;
    const result = await awaitUnreadPeerTurns({ ...options, timeoutMs: 25, intervalMs: 10,
      now: () => clock, sleep: async (ms) => { clock += ms; },
      inspect: async () => ({ ...ready(options, count), coverage }),
    });
    if (count === 0) {
      assert.equal(result.kind, "incomplete");
      assert.equal(clock, 25);
      if (result.kind === "incomplete") {
        assert.deepEqual(result.coverage, coverage);
        assert.match(formatAwaitIncomplete(result), /quiet is unproven.*permission_denied/u);
      }
    } else {
      assert.equal(result.kind, "unread");
      assert.equal(clock, 0);
      if (result.kind === "unread") {
        assert.deepEqual(result.coverage, coverage);
        assert.match(formatAwaitUnread(result), /^at least 2 unread.*coverage incomplete/u);
      }
    }
  }
  let clock = 0;
  const recovered = await awaitUnreadPeerTurns({ ...options, timeoutMs: 10, intervalMs: 10,
    now: () => clock, sleep: async (ms) => { clock += ms; },
    inspect: async () => ({ ...ready(options, 0), ...(clock === 0 ? { coverage } : {}) }),
  });
  assert.equal(recovered.kind, "timeout", "a final fully available scan can establish quiet");
});

test("foreign cursor epochs and unavailable identities fail immediately", async (t) => {
  const options = await cursorFixture(t);
  const moved = await admitHookSession({
    projectRoot: options.projectRoot,
    provider: "codex",
    nativeSessionId: SELF_NATIVE,
    event: "UserPromptSubmit",
    prompt: "$barbaro new await-next",
    now: new Date("2026-08-23T10:01:00.000Z"),
  });
  assert.ok(moved.participation);
  const membership = participationMemberships(moved.participation).at(-1);
  assert.ok(membership);
  await assert.rejects(
    awaitUnreadPeerTurns({
      ...options,
      workstreamId: membership.workstream_id,
      membershipFrom: membership.from,
      timeoutMs: 10,
    }),
    AwaitCursorScopeError,
  );

  await assert.rejects(
    awaitUnreadPeerTurns({
      ...options,
      timeoutMs: 10,
      inspect: async () => ({ status: "not_joined" }),
    }),
    AwaitCursorUnavailableError,
  );
});

test("the default timeout and hard cap remain enforced", async (t) => {
  const options = await cursorFixture(t);
  let clock = 0;
  const result = await awaitUnreadPeerTurns({
    ...options,
    now: () => clock,
    inspect: async () => ready(options, 0),
    sleep: async () => {
      clock = DEFAULT_AWAIT_TIMEOUT_MS;
    },
  });
  assert.equal(result.kind, "timeout");
  assert.equal(
    result.kind === "timeout" ? result.timeout_ms : -1,
    DEFAULT_AWAIT_TIMEOUT_MS,
  );

  await assert.rejects(
    awaitUnreadPeerTurns({
      ...options,
      timeoutMs: MAX_AWAIT_TIMEOUT_MS + 1,
    }),
    /must not exceed 3600000/u,
  );
});
