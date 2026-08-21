import assert from "node:assert/strict";
import {
  appendFile,
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
import { createEvidenceId } from "../../src/core/id.js";
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

test("Codex runner fails closed for unsupported paginated history", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-paginated-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const trace = join(project, "rollout-paginated.jsonl");
  await writeFile(
    trace,
    [
      rollout("session_meta", {
        session_id: "session-paginated",
        id: "session-paginated",
        cwd: project,
        cli_version: "0.148.0-alpha.9",
        history_mode: "paginated",
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
    /supports legacy histories only/,
  );
  await assert.rejects(readFile(join(project, ".barbaro", "feed", "codex")), {
    code: "ENOENT",
  });
});

function rollout(type: string, payload: unknown) {
  return { timestamp: "2026-08-16T10:00:00.000Z", type, payload };
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
