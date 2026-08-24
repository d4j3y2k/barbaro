import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BarbaroSubagentTurnEvidenceV1 } from "../../src/contracts/v1.js";
import { createEvidenceId, createSessionId } from "../../src/core/id.js";
import { handleCodexHook } from "../../src/hooks/codex.js";
import {
  admitHookSession,
  SESSION_PARTICIPATION_SCHEMA,
  SessionParticipationStore,
} from "../../src/hooks/participation.js";
import { runCodexTrace } from "../../src/runner/codex.js";

test("Codex runner resumes by byte checkpoint and emits each turn once", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-project-"));
  const trace = join(project, "rollout-session-native.jsonl");
  const records = [
    rollout("session_meta", {
      session_id: "session-native",
      id: "session-native",
      cwd: project,
      cli_version: "0.148.0-alpha.9",
      thread_source: "user",
    }),
    rollout("event_msg", { type: "task_started", turn_id: "turn-1" }),
    rollout("event_msg", { type: "user_message", message: "First prompt" }),
    rollout("event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "First answer",
    }),
  ];
  await writeFile(trace, records.map((record) => `${JSON.stringify(record)}\n`).join(""));

  const first = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(first.checkpoint_status, "start");
  assert.equal(
    first.trace_id,
    "codex:session-native:thread:session-native",
  );
  assert.equal(first.output.turns_appended, 1);

  const quiet = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(quiet.checkpoint_status, "resume");
  assert.equal(quiet.input.complete_lines, 0);
  assert.equal(quiet.output.turns_appended, 0);

  const secondRecords = [
    rollout("event_msg", { type: "task_started", turn_id: "turn-2" }),
    rollout("event_msg", { type: "user_message", message: "Second prompt" }),
    rollout("event_msg", {
      type: "task_complete",
      turn_id: "turn-2",
      last_agent_message: "Second answer",
    }),
  ];
  await appendFile(trace, secondRecords.map((record) => `${JSON.stringify(record)}\n`).join(""));
  const second = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(second.input.complete_lines, 3);
  assert.equal(second.output.turns_appended, 1);

  const feedDirectory = join(project, ".barbaro", "feed", "codex");
  const stateText = await readFile(
    join(project, ".barbaro", "state", "codex", `${hashForTest(`path:${trace}`)}.json`),
    "utf8",
  );
  const state = JSON.parse(stateText) as { normalizer: { session: { barbaroSessionId: string } } };
  const feed = await readFile(
    join(feedDirectory, `${state.normalizer.session.barbaroSessionId}.jsonl`),
    "utf8",
  );
  const turns = feed.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(turns.map((turn) => turn.request.text), ["First prompt", "Second prompt"]);
  assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2]);
  assert.ok(
    turns.every((turn) =>
      turn.source_refs.every((sourceRef: Record<string, unknown>) =>
        sourceRef.trace_path === undefined,
      ),
    ),
  );
});

test("Codex stamps turns with forward memberships and resets byte-identically", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-codex-moves-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const nativeSessionId = "moving-session";
  const trace = join(project, "rollout-moving.jsonl");
  await writeFile(
    trace,
    [
      rollout(
        "session_meta",
        {
          session_id: nativeSessionId,
          id: nativeSessionId,
          cwd: project,
          thread_source: "user",
        },
        "2026-08-16T09:59:00.000Z",
      ),
      rollout("event_msg", { type: "task_started", turn_id: "turn-1" }, "2026-08-16T10:00:00.000Z"),
      rollout("event_msg", { type: "user_message", message: "First prompt" }, "2026-08-16T10:00:01.000Z"),
      rollout(
        "event_msg",
        { type: "task_complete", turn_id: "turn-1", last_agent_message: "First answer" },
        "2026-08-16T10:00:10.000Z",
      ),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  const joined = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new alpha",
    now: new Date("2026-08-16T09:59:30.000Z"),
  });
  const alpha = joined.participation?.workstream_id;
  assert.ok(alpha);
  assert.equal(
    (await runCodexTrace({ tracePath: trace, projectRoot: project })).output
      .turns_appended,
    1,
  );

  const moved = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new beta",
    now: new Date("2026-08-16T10:30:00.000Z"),
  });
  const beta = moved.participation?.workstream_id;
  assert.ok(beta && beta !== alpha);
  await appendFile(
    trace,
    [
      rollout("event_msg", { type: "task_started", turn_id: "turn-2" }, "2026-08-16T11:00:00.000Z"),
      rollout("event_msg", { type: "user_message", message: "Second prompt" }, "2026-08-16T11:00:01.000Z"),
      rollout(
        "event_msg",
        { type: "task_complete", turn_id: "turn-2", last_agent_message: "Second answer" },
        "2026-08-16T11:00:10.000Z",
      ),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  const second = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(second.output.turns_appended, 1);
  assert.equal(second.output.conflicted, 0);

  const feedPath = join(
    project,
    ".barbaro",
    "feed",
    "codex",
    `${createSessionId("codex", nativeSessionId)}.jsonl`,
  );
  const turns = await readJsonl<{
    request: { text: string };
    workstream_id?: string;
  }>(feedPath);
  assert.deepEqual(
    turns.map((turn) => [turn.request.text, turn.workstream_id]),
    [
      ["First prompt", alpha],
      ["Second prompt", beta],
    ],
  );
  const before = await readFile(feedPath, "utf8");
  const reset = await runCodexTrace({
    tracePath: trace,
    projectRoot: project,
    reset: true,
  });
  assert.equal(reset.output.conflicted, 0);
  assert.equal(reset.output.turns_appended, 0);
  assert.equal(await readFile(feedPath, "utf8"), before);
});

test("Codex stamps the move prompt in its target when task_started precedes the hook", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-codex-move-prompt-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const nativeSessionId = "move-prompt-session";
  const trace = join(project, "rollout-move-prompt.jsonl");
  const joined = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new alpha",
    now: new Date("2026-08-16T09:00:00.000Z"),
  });
  const alpha = joined.participation?.workstream_id;
  assert.ok(alpha);

  const nativeStartedAt = "2026-08-16T10:00:00.000Z";
  await writeFile(
    trace,
    [
      rollout(
        "session_meta",
        {
          session_id: nativeSessionId,
          id: nativeSessionId,
          cwd: project,
          thread_source: "user",
        },
        "2026-08-16T09:59:59.900Z",
      ),
      // Codex writes this before UserPromptSubmit and supplies only whole
      // seconds in payload.started_at. The hook must use the same value the
      // normalizer will later publish, not its later wall-clock write time.
      rollout(
        "event_msg",
        {
          type: "task_started",
          turn_id: "turn-move",
          started_at: Date.parse(nativeStartedAt) / 1_000,
        },
        "2026-08-16T10:00:00.177Z",
      ),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );

  const moved = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-move",
    cwd: project,
    transcript_path: trace,
    prompt: "$barbaro new beta Continue in beta.",
  });
  const beta = (await new SessionParticipationStore(project).read(
    "codex",
    nativeSessionId,
  ))?.workstream_id;
  assert.ok(beta && beta !== alpha);
  assert.match(moved.message ?? "", /moved this session to workstream "beta"/u);
  const participation = await new SessionParticipationStore(project).read(
    "codex",
    nativeSessionId,
  );
  assert.deepEqual(participation?.memberships?.at(-1), {
    workstream_id: beta,
    from: nativeStartedAt,
  });

  await appendFile(
    trace,
    [
      rollout(
        "event_msg",
        { type: "user_message", message: "$barbaro new beta Continue in beta." },
        "2026-08-16T10:00:00.500Z",
      ),
      rollout(
        "event_msg",
        {
          type: "task_complete",
          turn_id: "turn-move",
          last_agent_message: "Moved.",
        },
        "2026-08-16T10:00:10.000Z",
      ),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  const first = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(first.output.conflicted, 0);
  assert.equal(first.output.turns_appended, 1);
  const feedPath = join(
    project,
    ".barbaro",
    "feed",
    "codex",
    `${createSessionId("codex", nativeSessionId)}.jsonl`,
  );
  const before = await readFile(feedPath, "utf8");
  assert.equal(JSON.parse(before).workstream_id, beta);

  const reset = await runCodexTrace({
    tracePath: trace,
    projectRoot: project,
    reset: true,
  });
  assert.equal(reset.output.conflicted, 0);
  assert.equal(await readFile(feedPath, "utf8"), before);
});

test("Codex leaves legacy turns unscoped before the first forward membership", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-codex-legacy-move-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const nativeSessionId = "legacy-moving-session";
  const sessionId = createSessionId("codex", nativeSessionId);
  const participationDirectory = join(project, ".barbaro", "sessions", "codex");
  await mkdir(participationDirectory, { recursive: true });
  await writeFile(
    join(participationDirectory, `${sessionId}.json`),
    `${JSON.stringify({
      schema: SESSION_PARTICIPATION_SCHEMA,
      provider: "codex",
      session_id: sessionId,
      joined_at: "2026-08-15T00:00:00.000Z",
      initiated_by: "user_prompt",
    })}\n`,
    "utf8",
  );
  const trace = join(project, "rollout-legacy-moving.jsonl");
  await writeFile(
    trace,
    [
      rollout(
        "session_meta",
        {
          session_id: nativeSessionId,
          id: nativeSessionId,
          cwd: project,
          thread_source: "user",
        },
        "2026-08-16T09:59:00.000Z",
      ),
      rollout("event_msg", { type: "task_started", turn_id: "turn-1" }, "2026-08-16T10:00:00.000Z"),
      rollout("event_msg", { type: "user_message", message: "Legacy prompt" }, "2026-08-16T10:00:01.000Z"),
      rollout(
        "event_msg",
        { type: "task_complete", turn_id: "turn-1", last_agent_message: "Legacy answer" },
        "2026-08-16T10:00:10.000Z",
      ),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  await runCodexTrace({ tracePath: trace, projectRoot: project });

  const moved = await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new scoped",
    now: new Date("2026-08-16T10:30:00.000Z"),
  });
  const scoped = moved.participation?.workstream_id;
  assert.ok(scoped);
  await appendFile(
    trace,
    [
      rollout("event_msg", { type: "task_started", turn_id: "turn-2" }, "2026-08-16T11:00:00.000Z"),
      rollout("event_msg", { type: "user_message", message: "Scoped prompt" }, "2026-08-16T11:00:01.000Z"),
      rollout(
        "event_msg",
        { type: "task_complete", turn_id: "turn-2", last_agent_message: "Scoped answer" },
        "2026-08-16T11:00:10.000Z",
      ),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  await runCodexTrace({ tracePath: trace, projectRoot: project });
  const feedPath = join(project, ".barbaro", "feed", "codex", `${sessionId}.jsonl`);
  const turns = await readJsonl<{
    request: { text: string };
    workstream_id?: string;
  }>(feedPath);
  assert.deepEqual(
    turns.map((turn) => [turn.request.text, turn.workstream_id]),
    [
      ["Legacy prompt", undefined],
      ["Scoped prompt", scoped],
    ],
  );
  const before = await readFile(feedPath, "utf8");
  const reset = await runCodexTrace({ tracePath: trace, projectRoot: project, reset: true });
  assert.equal(reset.output.conflicted, 0);
  assert.equal(await readFile(feedPath, "utf8"), before);
});

test("Codex subagent traces become joinable evidence instead of feed turns", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-subagent-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const trace = join(project, "rollout-subagent.jsonl");
  const records = [
    rollout("session_meta", {
      session_id: "session-native",
      id: "agent-thread-native",
      cwd: project,
      cli_version: "0.148.0-alpha.9",
      thread_source: "subagent",
      agent_path: "/root/explorer",
    }),
    rollout("event_msg", { type: "task_started", turn_id: "child-turn-1" }),
    rollout("event_msg", { type: "user_message", message: "Inspect the parser" }),
    rollout("event_msg", {
      type: "task_complete",
      turn_id: "child-turn-1",
      last_agent_message: "Located the parser entry point",
    }),
  ];
  await writeFile(trace, records.map((record) => `${JSON.stringify(record)}\n`).join(""));

  const result = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(result.output.turns_appended, 0);
  assert.equal(result.output.evidence_appended, 1);

  await assert.rejects(readFile(join(project, ".barbaro", "feed", "codex")), {
    code: "ENOENT",
  });
  const evidenceDirectory = join(project, ".barbaro", "evidence", "codex");
  const [evidenceName] = await readdir(evidenceDirectory);
  const evidence = JSON.parse(
    (await readFile(join(evidenceDirectory, evidenceName!), "utf8")).trim(),
  ) as BarbaroSubagentTurnEvidenceV1;
  assert.equal(evidence.kind, "subagent_turn");
  assert.deepEqual(evidence.parent_link, {
    method: "unresolved",
    native_key: "agent-thread-native",
  });
  assert.match(evidence.turn_id, /^turn_[0-9a-f]{32}$/);
  assert.equal(
    evidence.evidence_id,
    createEvidenceId(evidence.turn_id, "native:child-turn-1", 0),
  );
  assert.equal(
    evidence.extensions?.codex?.native_turn_id,
    "child-turn-1",
  );
  assert.deepEqual(Object.keys(evidence.content).sort(), [
    "actions",
    "ended_at",
    "outcome",
    "request",
    "response",
    "role",
    "sequence",
    "started_at",
  ]);
  assert.equal(evidence.content.role, "explorer");
  assert.equal(evidence.content.sequence, 1);
  assert.equal(evidence.content.request.text, "Inspect the parser");
  assert.equal(
    evidence.content.response?.text,
    "Located the parser entry point",
  );
  assert.deepEqual(evidence.content.actions, []);
  assert.equal(
    evidence.extensions?.codex?.native_thread_id,
    "agent-thread-native",
  );
  assert.equal(
    evidence.source_refs[0]?.trace_id,
    "codex:session-native:thread:agent-thread-native",
  );
  assert.ok(!("turn" in evidence.content));
  assert.ok(!("turns" in evidence.content));
  assert.ok(!("child_turn_id" in evidence.content));
});

test("Codex trace IDs distinguish root and child rollout artifacts", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-artifacts-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const rootTrace = join(project, "rollout-root.jsonl");
  const childTrace = join(project, "rollout-child.jsonl");
  await writeFile(
    rootTrace,
    [
      rollout("session_meta", {
        session_id: "shared-session",
        id: "root-thread",
        cwd: project,
        thread_source: "user",
      }),
      rollout("event_msg", { type: "task_started", turn_id: "root-turn" }),
      rollout("event_msg", { type: "user_message", message: "Root prompt" }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: "root-turn",
        last_agent_message: "Root answer",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  await writeFile(
    childTrace,
    [
      rollout("session_meta", {
        session_id: "shared-session",
        id: "child-thread",
        cwd: project,
        thread_source: "subagent",
        agent_path: "/root/explore",
      }),
      rollout("event_msg", { type: "task_started", turn_id: "child-turn" }),
      rollout("event_msg", { type: "user_message", message: "Child prompt" }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: "child-turn",
        last_agent_message: "Child answer",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );

  const root = await runCodexTrace({ tracePath: rootTrace, projectRoot: project });
  const child = await runCodexTrace({ tracePath: childTrace, projectRoot: project });
  assert.equal(root.trace_id, "codex:shared-session:thread:root-thread");
  assert.equal(child.trace_id, "codex:shared-session:thread:child-thread");
  assert.notEqual(root.trace_id, child.trace_id);
});

test("Codex runner fails closed for an unknown history mode", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-unknown-history-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const trace = join(project, "rollout-unknown.jsonl");
  await writeFile(
    trace,
    [
      rollout("session_meta", {
        session_id: "session-unknown-history",
        id: "session-unknown-history",
        cwd: project,
        cli_version: "0.150.0-alpha.1",
        history_mode: "sharded",
      }),
      rollout("event_msg", { type: "task_started", turn_id: "turn-1" }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "Would otherwise look complete",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );

  await assert.rejects(
    runCodexTrace({ tracePath: trace, projectRoot: project }),
    /supports legacy and paginated histories only/,
  );
  await assert.rejects(readFile(join(project, ".barbaro", "feed", "codex")), {
    code: "ENOENT",
  });
});

test("Codex runner publishes a paginated rollout with item-projected actions", async (t) => {
  // Codex Desktop 0.149+ writes history_mode: paginated. Its unified exec
  // inputs are scripts, so commands and file changes come from the
  // item_completed projections; the exec call's own output must not become a
  // second, generic tool action.
  const project = await mkdtemp(join(tmpdir(), "barbaro-paginated-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const fixture = await readFile(
    join(process.cwd(), "test", "fixtures", "codex", "paginated-turn.input.jsonl"),
    "utf8",
  );
  const trace = join(project, "rollout-paginated.jsonl");
  await writeFile(trace, fixture.split("/workspace/demo").join(project), "utf8");

  const result = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(result.output.turns_appended, 1);
  assert.equal(result.output.conflicted, 0);
  assert.deepEqual(result.diagnostics.unknown_event_types, {});

  const feedDirectory = join(project, ".barbaro", "feed", "codex");
  const [feedFile] = (await readdir(feedDirectory)).filter((name) =>
    name.endsWith(".jsonl"),
  );
  assert.ok(feedFile);
  const turn = JSON.parse(
    (await readFile(join(feedDirectory, feedFile), "utf8")).trim(),
  ) as {
    request: { text: string };
    response?: { text: string };
    actions: readonly {
      kind: string;
      outcome: string;
      command?: { text: string };
      path?: string;
      operation?: string;
      exit_code?: number;
      failure_excerpt?: { text: string };
    }[];
  };
  assert.equal(turn.request.text, "Add the status endpoint and run the tests.");
  assert.equal(
    turn.response?.text,
    "Added the status endpoint; tests pass, the probe failed.",
  );
  assert.deepEqual(
    turn.actions.map((action) => [
      action.kind,
      action.outcome,
      action.command?.text ?? `${action.operation} ${action.path}`,
    ]),
    [
      ["test", "success", "npm test"],
      ["file_change", "success", "create src/status.ts"],
      ["file_change", "success", "modify README.md"],
      ["command", "failed", "node scripts/probe.js"],
    ],
  );
  assert.equal(turn.actions[3]?.exit_code, 1);
  assert.equal(turn.actions[3]?.failure_excerpt?.text, "probe: boom\n");
  // A second pass recomputes identical bytes.
  const again = await runCodexTrace({ tracePath: trace, projectRoot: project });
  assert.equal(again.output.conflicted, 0);
  assert.equal(again.output.turns_appended, 0);
});

async function readJsonl<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

function rollout(
  type: string,
  payload: unknown,
  timestamp = "2026-08-16T10:00:00.000Z",
) {
  return { timestamp, type, payload };
}

function hashForTest(value: string): string {
  // Keep this test independent of private runner exports while pinning its state path.
  return requireHash(value).slice(0, 32);
}

function requireHash(value: string): string {
  // Dynamic import is unnecessary here; node:crypto is stable and synchronous.
  // eslint is not part of this package, so the local import-style helper stays tiny.
  return createHashForTest(value);
}

import { createHash } from "node:crypto";
function createHashForTest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
