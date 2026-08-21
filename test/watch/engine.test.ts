import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActiveLeaseStore } from "../../src/active/store.js";
import type {
  ActiveLeaseIdentity,
  ActiveLeaseUpdate,
} from "../../src/active/types.js";
import type { BarbaroContent, BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { createSessionId } from "../../src/core/id.js";
import { recordIncident } from "../../src/hooks/incidents.js";
import { admitHookSession } from "../../src/hooks/participation.js";
import {
  WATCH_WAKE_MARKER,
  WatchEngine,
  isWatchWakeRequest,
} from "../../src/watch/index.js";

const SES_A = `ses_${"a".repeat(32)}`;
const SES_B = `ses_${"b".repeat(32)}`;
const SES_C = `ses_${"c".repeat(32)}`;
const START_MS = Date.parse("2026-08-19T06:00:00.000Z");

function content(text: string): BarbaroContent {
  return { text, fidelity: "verbatim", truncated: false, redactions: [] };
}

function turnRecord(options: {
  readonly sessionId: string;
  readonly sequence: number;
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
    sequence: options.sequence,
    agent_id: "main",
    started_at: "2026-08-19T05:59:00.000Z",
    ended_at: "2026-08-19T05:59:30.000Z",
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

/** The request text a Monitor wake-up leaves on the turn it causes. */
function wakeRequest(): string {
  return (
    `<task-notification>\n<summary>Monitor event: ` +
    `"${WATCH_WAKE_MARKER}"</summary>\n<event>TURN …</event>\n` +
    `</task-notification>`
  );
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

async function appendTurn(
  project: string,
  turn: BarbaroTurnV1,
): Promise<void> {
  const path = feedPath(project, turn);
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(turn)}\n`);
}

function identityOf(sessionId: string, agentId = "main"): ActiveLeaseIdentity {
  const suffix = agentId === "main" ? "0".repeat(16) : "f".repeat(16);
  return {
    lease_id: `lease_${sessionId.slice(4, 20)}${suffix}`,
    provider: "claude",
    session_id: sessionId,
    agent_id: agentId,
  };
}

function workingUpdate(
  sessionId: string,
  overrides: Partial<ActiveLeaseUpdate> = {},
): ActiveLeaseUpdate {
  return {
    ...identityOf(sessionId),
    state: "working",
    claims: [{ path: "src/a.ts", mode: "write", confidence: "exact" }],
    unknown_write_scope: false,
    current_action: { kind: "tool", tool_name: "Bash" },
    ...overrides,
  };
}

async function withProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-watch-test-"));
  try {
    await mkdir(join(project, ".barbaro"));
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test("priming swallows existing history and reports honest counts", async () => {
  await withProject(async (project) => {
    const nowMs = START_MS;
    await appendTurn(
      project,
      turnRecord({ sessionId: SES_A, sequence: 1, request: "old" }),
    );
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "enrolled-one",
      event: "UserPromptSubmit",
      prompt: "/barbaro",
    });
    await recordIncident({
      projectRoot: project,
      provider: "claude",
      kind: "hook_error",
      event: "Stop",
      detail: "pre-existing",
      now: new Date(nowMs),
    });
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    // One live lease, one idle tombstone, one long-expired lease: only the
    // first is a present peer.
    await store.write(workingUpdate(SES_A), { now: nowMs, ttlMs: 60_000 });
    await store.writeIdle(identityOf(SES_B), { now: nowMs, ttlMs: 60_000 });
    await store.write(workingUpdate(SES_C), {
      now: nowMs - 600_000,
      ttlMs: 60_000,
    });

    const engine = new WatchEngine({
      projectRoot: project,
      clock: () => new Date(nowMs),
    });
    const armed = await engine.prime();
    assert.equal(armed.kind, "armed");
    assert.equal(armed.live_sessions, 1);
    assert.equal(armed.enrolled_sessions, 1);
    assert.equal(armed.self_session_id, undefined);
    assert.deepEqual(await engine.poll(), []);
  });
});

test("polling before priming is refused", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({ projectRoot: project });
    await assert.rejects(engine.poll(), /prime/);
  });
});

test("a peer's completed turn is one bounded event, delivered once", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({
      projectRoot: project,
      selfSessionId: SES_B,
    });
    await engine.prime();

    await appendTurn(
      project,
      turnRecord({
        sessionId: SES_A,
        sequence: 1,
        request: "please fix the tests",
        response: "done",
      }),
    );
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.kind === "turn");
    assert.equal(event.provider, "claude");
    assert.equal(event.session_id, SES_A);
    assert.equal(event.turn.value.sequence, 1);
    assert.equal(event.turn.value.request.text, "please fix the tests");
    assert.equal(event.turn.value.response?.text, "done");
    assert.deepEqual(await engine.poll(), []);
  });
});

test("a session's own publications are never events", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({
      projectRoot: project,
      selfSessionId: SES_A,
    });
    await engine.prime();
    await appendTurn(
      project,
      turnRecord({ sessionId: SES_A, sequence: 1, request: "my own turn" }),
    );
    assert.deepEqual(await engine.poll(), []);
  });
});

test("a partial trailing line is withheld until the writer completes it", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({ projectRoot: project });
    await engine.prime();

    const first = turnRecord({ sessionId: SES_A, sequence: 1, request: "one" });
    const second = turnRecord({ sessionId: SES_A, sequence: 2, request: "two" });
    const secondLine = `${JSON.stringify(second)}\n`;
    await appendTurn(project, first);
    await appendFile(feedPath(project, second), secondLine.slice(0, 25));

    const firstBatch = await engine.poll();
    assert.equal(firstBatch.length, 1);
    const firstEvent = firstBatch[0]!;
    assert.ok(firstEvent.kind === "turn");
    assert.equal(firstEvent.turn.value.sequence, 1);

    await appendFile(feedPath(project, second), secondLine.slice(25));
    const secondBatch = await engine.poll();
    assert.equal(secondBatch.length, 1);
    const secondEvent = secondBatch[0]!;
    assert.ok(secondEvent.kind === "turn");
    assert.equal(secondEvent.turn.value.sequence, 2);
  });
});

test("wake-response turns are suppressed", async () => {
  assert.equal(isWatchWakeRequest(wakeRequest()), true);
  assert.equal(isWatchWakeRequest("a prompt about watchers"), false);
  assert.equal(isWatchWakeRequest(`quoting "${WATCH_WAKE_MARKER}" only`), false);

  await withProject(async (project) => {
    const engine = new WatchEngine({ projectRoot: project });
    await engine.prime();
    await appendTurn(
      project,
      turnRecord({ sessionId: SES_A, sequence: 1, request: wakeRequest() }),
    );
    assert.deepEqual(await engine.poll(), []);
  });
});

test("provenance decides: machine-driven turns are the echo, human turns the news", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({ projectRoot: project });
    await engine.prime();

    // Stamped machine-driven: suppressed even with an innocuous request.
    await appendTurn(
      project,
      turnRecord({
        sessionId: SES_A,
        sequence: 1,
        request: "a background task finished",
        turnStartMethod: "task-notification",
      }),
    );
    assert.deepEqual(await engine.poll(), []);

    // Stamped human turn quoting the wake text verbatim: still reported.
    await appendTurn(
      project,
      turnRecord({
        sessionId: SES_A,
        sequence: 2,
        request: `what does this mean? ${wakeRequest()}`,
        turnStartMethod: "origin",
      }),
    );
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.kind === "turn");
    assert.equal(event.turn.value.sequence, 2);
  });
});

test("two armed watchers cannot echo each other awake", async () => {
  await withProject(async (project) => {
    const watcherA = new WatchEngine({
      projectRoot: project,
      selfSessionId: SES_A,
    });
    const watcherB = new WatchEngine({
      projectRoot: project,
      selfSessionId: SES_B,
    });
    await watcherA.prime();
    await watcherB.prime();

    // A human speaks in session A. Watcher B wakes exactly once for it.
    await appendTurn(
      project,
      turnRecord({ sessionId: SES_A, sequence: 1, request: "refactor the store" }),
    );
    assert.deepEqual(await watcherA.poll(), []);
    assert.equal((await watcherB.poll()).length, 1);

    // Each side's wake response publishes as its next turn. If either watcher
    // emitted the other's wake response, the sessions would reply to each
    // other forever; assert the exchange stays silent for several rounds.
    let sequenceA = 1;
    let sequenceB = 0;
    for (let round = 0; round < 3; round += 1) {
      sequenceB += 1;
      await appendTurn(
        project,
        turnRecord({ sessionId: SES_B, sequence: sequenceB, request: wakeRequest() }),
      );
      assert.deepEqual(await watcherA.poll(), []);

      sequenceA += 1;
      await appendTurn(
        project,
        turnRecord({ sessionId: SES_A, sequence: sequenceA, request: wakeRequest() }),
      );
      assert.deepEqual(await watcherB.poll(), []);
    }
  });
});

test("newly enrolled sessions arrive as join events, once", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({ projectRoot: project });
    await engine.prime();

    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "late-joiner",
      event: "UserPromptSubmit",
      prompt: "/barbaro",
    });
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.kind === "join");
    assert.equal(event.provider, "claude");
    assert.equal(event.session_id, createSessionId("claude", "late-joiner"));
    assert.equal(event.initiated_by, "user_prompt");
    assert.deepEqual(await engine.poll(), []);
  });
});

test("incident markers emit once per distinct condition", async () => {
  await withProject(async (project) => {
    let nowMs = START_MS;
    const engine = new WatchEngine({
      projectRoot: project,
      clock: () => new Date(nowMs),
    });
    await engine.prime();

    await recordIncident({
      projectRoot: project,
      provider: "claude",
      kind: "hook_error",
      event: "Stop",
      detail: "boom",
      now: new Date(nowMs),
    });
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.kind === "incident");
    assert.equal(event.provider, "claude");
    assert.equal(event.incident_kind, "hook_error");
    assert.equal(event.event, "Stop");

    // The same condition collapses into the same marker file: no repeat.
    nowMs += 1_000;
    await recordIncident({
      projectRoot: project,
      provider: "claude",
      kind: "hook_error",
      event: "Stop",
      detail: "boom",
      now: new Date(nowMs),
    });
    assert.deepEqual(await engine.poll(), []);
  });
});

test("a lease that lapses still holding work is stale news; a goodbye is not", async () => {
  await withProject(async (project) => {
    let nowMs = START_MS;
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    const engine = new WatchEngine({
      projectRoot: project,
      clock: () => new Date(nowMs),
    });

    await store.write(workingUpdate(SES_A), { now: nowMs, ttlMs: 60_000 });
    await engine.prime();

    // Watched from live to expired: exactly one stale event.
    nowMs += 120_000;
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const stale = events[0]!;
    assert.ok(stale.kind === "stale");
    assert.equal(stale.session_id, SES_A);
    assert.equal(stale.last_state, "working");
    assert.equal(stale.claims, 1);
    assert.equal(stale.lapsed_ms, 60_000);
    assert.deepEqual(stale.current_action, { kind: "tool", tool_name: "Bash" });
    assert.deepEqual(await engine.poll(), []);

    // Renewal makes the same lease reportable again on its next lapse.
    await store.write(workingUpdate(SES_A), { now: nowMs, ttlMs: 60_000 });
    assert.deepEqual(await engine.poll(), []);
    nowMs += 120_000;
    assert.equal((await engine.poll()).length, 1);

    // An idle tombstone expiring is a session saying goodbye, not news.
    await store.writeIdle(identityOf(SES_B), { now: nowMs, ttlMs: 60_000 });
    assert.deepEqual(await engine.poll(), []);
    nowMs += 120_000;
    assert.deepEqual(await engine.poll(), []);

    // A lease first seen already expired predates the watcher: leftover.
    await store.write(workingUpdate(SES_C), {
      now: nowMs - 600_000,
      ttlMs: 60_000,
    });
    assert.deepEqual(await engine.poll(), []);
    assert.deepEqual(await engine.poll(), []);
  });
});

test("a subagent lease lapsing under a live main is routine completion", async () => {
  await withProject(async (project) => {
    let nowMs = START_MS;
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    const engine = new WatchEngine({
      projectRoot: project,
      clock: () => new Date(nowMs),
    });

    // Session A: main holds a long lease, its subagent a short one. Session
    // B: only a subagent lease — its main is already gone.
    await store.write(workingUpdate(SES_A), { now: nowMs, ttlMs: 600_000 });
    await store.write(
      { ...workingUpdate(SES_A), ...identityOf(SES_A, "sub-1") },
      { now: nowMs, ttlMs: 60_000 },
    );
    await store.write(
      { ...workingUpdate(SES_B), ...identityOf(SES_B, "sub-1") },
      { now: nowMs, ttlMs: 60_000 },
    );
    await engine.prime();

    // A's subagent lapses under a live main: it simply finished, and the
    // parent's turn record already carries the outcome. B's lapses with no
    // live main: it went down with its session, and still reports.
    nowMs += 120_000;
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const stale = events[0]!;
    assert.ok(stale.kind === "stale");
    assert.equal(stale.session_id, SES_B);
    assert.equal(stale.agent_id, "sub-1");

    // When A's main later lapses too, only the main reports: the subagent's
    // expiry was already accounted for while the session was alive.
    nowMs += 600_000;
    const mainEvents = await engine.poll();
    assert.equal(mainEvents.length, 1);
    const mainStale = mainEvents[0]!;
    assert.ok(mainStale.kind === "stale");
    assert.equal(mainStale.session_id, SES_A);
    assert.equal(mainStale.agent_id, "main");
  });
});

test("a rebuilt feed file re-baselines instead of replaying or crashing", async () => {
  await withProject(async (project) => {
    const engine = new WatchEngine({ projectRoot: project });
    await engine.prime();

    const first = turnRecord({ sessionId: SES_A, sequence: 1, request: "one" });
    const second = turnRecord({ sessionId: SES_A, sequence: 2, request: "two" });
    await appendTurn(project, first);
    await appendTurn(project, second);
    assert.equal((await engine.poll()).length, 2);

    // The file shrinks beneath the cursor: rebuilt, not appended to.
    await writeFile(feedPath(project, first), `${JSON.stringify(first)}\n`);
    assert.deepEqual(await engine.poll(), []);

    // Appends after the rebuild flow again from the new baseline.
    const third = turnRecord({ sessionId: SES_A, sequence: 3, request: "three" });
    await appendTurn(project, third);
    const events = await engine.poll();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.kind === "turn");
    assert.equal(event.turn.value.sequence, 3);
  });
});
