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
import { WorkstreamStore } from "../../src/workstreams/index.js";

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
      prompt: "/barbaro new lane",
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
      prompt: "/barbaro new lane",
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

test("a forward move is join news only in the target workstream", async () => {
  await withProject(async (project) => {
    const workstreams = new WorkstreamStore(project);
    const alpha = await workstreams.create({
      name: "alpha",
      createdBy: { kind: "cli" },
    });
    const beta = await workstreams.create({
      name: "beta",
      createdBy: { kind: "cli" },
    });
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "mover",
      event: "UserPromptSubmit",
      prompt: "/barbaro join alpha",
      now: new Date("2026-08-22T12:00:00.000Z"),
    });
    const source = new WatchEngine({
      projectRoot: project,
      workstreamId: alpha.workstream_id,
    });
    const target = new WatchEngine({
      projectRoot: project,
      workstreamId: beta.workstream_id,
    });
    await source.prime();
    await target.prime();

    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "mover",
      event: "UserPromptSubmit",
      prompt: "/barbaro join beta",
      now: new Date("2026-08-22T12:05:00.000Z"),
    });
    assert.deepEqual(await source.poll(), []);
    const events = await target.poll();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.kind, "join");
    assert.ok(event.kind === "join");
    assert.equal(event.session_id, createSessionId("claude", "mover"));
    assert.equal(event.workstream_id, beta.workstream_id);
    assert.equal(event.joined_at, "2026-08-22T12:05:00.000Z");
    assert.deepEqual(await target.poll(), []);
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

test("a scoped watcher hears its own workstream only; unscoped sessions are outside every scope", async () => {
  await withProject(async (project) => {
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "alpha-one",
      event: "UserPromptSubmit",
      prompt: "/barbaro new alpha",
    });
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "beta-one",
      event: "UserPromptSubmit",
      prompt: "/barbaro new beta",
    });
    const { SessionParticipationStore } = await import(
      "../../src/hooks/participation.js"
    );
    const store = new SessionParticipationStore(project);
    const alpha = (await store.read("claude", "alpha-one"))?.workstream_id;
    const beta = (await store.read("claude", "beta-one"))?.workstream_id;
    assert.ok(alpha && beta && alpha !== beta);
    const alphaSession = createSessionId("claude", "alpha-one");
    const betaSession = createSessionId("claude", "beta-one");

    const engine = new WatchEngine({ projectRoot: project, workstreamId: alpha });
    const armed = await engine.prime();
    assert.equal(armed.workstream_id, alpha);
    assert.equal(armed.enrolled_sessions, 1);

    await appendTurn(project, {
      ...turnRecord({ sessionId: alphaSession, sequence: 1, request: "alpha work" }),
      workstream_id: alpha,
    });
    await appendTurn(project, {
      ...turnRecord({ sessionId: betaSession, sequence: 1, request: "beta work" }),
      workstream_id: beta,
    });
    await appendTurn(
      project,
      turnRecord({ sessionId: SES_C, sequence: 1, request: "legacy work" }),
    );
    await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "alpha-two",
      event: "UserPromptSubmit",
      prompt: "$barbaro join alpha",
    });
    await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "beta-two",
      event: "UserPromptSubmit",
      prompt: "$barbaro join beta",
    });

    const events = await engine.poll();
    const labels = events
      .map(
        (event) =>
          `${event.kind}:${"workstream_id" in event ? event.workstream_id ?? "" : ""}`,
      )
      .sort();
    assert.deepEqual(labels, [`join:${alpha}`, `turn:${alpha}`].sort());
    const turn = events.find((event) => event.kind === "turn");
    assert.ok(turn !== undefined && turn.kind === "turn");
    assert.equal(turn.session_id, alphaSession);

    // An unscoped watcher still hears everything, stamped where known.
    const wide = new WatchEngine({ projectRoot: project });
    await wide.prime();
    await appendTurn(project, {
      ...turnRecord({ sessionId: betaSession, sequence: 2, request: "more beta" }),
      workstream_id: beta,
    });
    await appendTurn(
      project,
      turnRecord({ sessionId: SES_C, sequence: 2, request: "more legacy" }),
    );
    const wideLabels = (await wide.poll())
      .map((event) =>
        event.kind === "turn" ? (event.workstream_id ?? "unscoped") : event.kind,
      )
      .sort();
    assert.deepEqual(wideLabels, [beta, "unscoped"].sort());
  });
});

test("scoped conflicts appear/change once, expire, and never echo watcher replies", async () => {
  await withProject(async (project) => {
    let nowMs = START_MS;
    const alpha = `ws_${"a".repeat(32)}`;
    const beta = `ws_${"b".repeat(32)}`;
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    const a = workingUpdate(SES_A, { workstream_id: alpha });
    let b = workingUpdate(SES_B, { workstream_id: beta, claims: [{ path: "src/b.ts", mode: "write", confidence: "exact" }] });
    await store.write(a, { now: nowMs, ttlMs: 600_000 });
    await store.write(b, { now: nowMs, ttlMs: 60_000 });
    const watcherA = new WatchEngine({ projectRoot: project, selfSessionId: SES_A, workstreamId: alpha, clock: () => new Date(nowMs) });
    const watcherB = new WatchEngine({ projectRoot: project, selfSessionId: SES_B, workstreamId: beta, clock: () => new Date(nowMs) });
    await watcherA.prime(); await watcherB.prime();
    assert.deepEqual(await watcherA.poll(), []);
    assert.deepEqual(await watcherB.poll(), []);

    b = { ...b, claims: a.claims };
    await store.write(b, { now: nowMs, ttlMs: 60_000 });
    for (const [watcher, local] of [[watcherA, alpha], [watcherB, beta]] as const) {
      const events = await watcher.poll();
      assert.equal(events.length, 1);
      assert.ok(events[0]?.kind === "conflict");
      assert.equal(events[0].overlap.local.workstream_id, local);
      assert.equal(events[0].overlap.confidence, "exact");
      assert.deepEqual(await watcher.poll(), []);
    }
    // Tool activity and expiry extensions carry no material path change.
    for (let round = 1; round <= 3; round += 1) {
      nowMs += 1_000;
      await store.write({ ...b, current_action: { kind: "tool", tool_name: "Read" } }, { now: nowMs, ttlMs: 60_000 });
      for (const [sessionId, workstream_id] of [[SES_A, alpha], [SES_B, beta]]) {
        await appendTurn(project, { ...turnRecord({ sessionId: sessionId!, sequence: round, request: wakeRequest() }), workstream_id: workstream_id! });
      }
      assert.deepEqual(await watcherA.poll(), []);
      assert.deepEqual(await watcherB.poll(), []);
    }
    // Confidence and unknown scope are material; unknown alone is not overlap.
    b = { ...b, claims: [{ path: "src/a.ts", mode: "write", confidence: "inferred" }], unknown_write_scope: true };
    await store.write(b, { now: nowMs, ttlMs: 60_000 });
    const changed = await watcherA.poll();
    assert.equal(changed.length, 1);
    assert.ok(changed[0]?.kind === "conflict");
    assert.equal(changed[0].overlap.confidence, "inferred");
    nowMs += 60_000;
    assert.deepEqual(await watcherA.poll(), [], "foreign expiry silently removes conflict at the exact deadline");
    await store.write(b, { now: nowMs, ttlMs: 60_000 });
    assert.equal((await watcherA.poll())[0]?.kind, "conflict", "renewal after lapse reappears");
    await store.write({ ...b, claims: [] }, { now: nowMs });
    assert.deepEqual(await watcherA.poll(), []);
    await store.write({ ...b, claims: [{ path: "src/disjoint.ts", mode: "write", confidence: "exact" }] }, { now: nowMs });
    assert.deepEqual(await watcherA.poll(), []);
    await appendTurn(project, { ...turnRecord({ sessionId: SES_B, sequence: 4, request: "foreign human conversation" }), workstream_id: beta });
    assert.deepEqual(await watcherA.poll(), [], "ordinary foreign conversation stays scoped");
  });
});

test("priming absorbs current conflicts and local claim appearance can reveal a foreign overlap", async () => {
  await withProject(async (project) => {
    const now = START_MS;
    const alpha = `ws_${"a".repeat(32)}`;
    const beta = `ws_${"b".repeat(32)}`;
    const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    await store.write(workingUpdate(SES_B, { workstream_id: beta }), { now });
    const engine = new WatchEngine({ projectRoot: project, selfSessionId: SES_A, workstreamId: alpha, clock: () => new Date(now) });
    await engine.prime();
    assert.deepEqual(await engine.poll(), []);
    await store.write(workingUpdate(SES_A, { workstream_id: alpha }), { now });
    assert.equal((await engine.poll())[0]?.kind, "conflict");
    const restarted = new WatchEngine({ projectRoot: project, workstreamId: alpha, clock: () => new Date(now) });
    await restarted.prime();
    assert.deepEqual(await restarted.poll(), []);
  });
});
