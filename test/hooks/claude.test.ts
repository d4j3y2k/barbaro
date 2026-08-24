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
import { test } from "node:test";

import { ActiveLeaseStore, deriveLeaseId } from "../../src/active/index.js";
import { AWAIT_LEASE_GRACE_MS } from "../../src/core/barbaro-command.js";
import { createSessionId } from "../../src/core/id.js";
import {
  handleClaudeHook,
  handleClaudeHookFailOpen,
  handleClaudeIngestHook,
  renderClaudeHookOutput,
} from "../../src/hooks/claude.js";
import type { BarbaroIngestAttemptJournalV2 } from "../../src/hooks/ingest-attempt.js";
import { listIncidents } from "../../src/hooks/incidents.js";
import {
  admitHookSession,
  SESSION_NOT_JOINED,
} from "../../src/hooks/participation.js";
import {
  NUDGE_CURSOR_SCHEMA,
  NudgeCursorStateStore,
  inspectUnreadPeerTurns,
} from "../../src/nudge/index.js";
import {
  appendPeerTurn,
  currentWorkstreamId,
} from "./nudge-fixture.js";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";

async function project(): Promise<{ root: string; store: ActiveLeaseStore }> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-"));
  await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: SESSION,
    event: "UserPromptSubmit",
    prompt: "/barbaro new lane",
  });
  return { root, store: new ActiveLeaseStore(join(root, ".barbaro", "active")) };
}

function identity(agentId = "main") {
  return {
    lease_id: deriveLeaseId("claude", SESSION, agentId),
    provider: "claude",
    session_id: createSessionId("claude", SESSION),
    agent_id: agentId,
  };
}

function leaseTtlMs(lease: {
  readonly updated_at: string;
  readonly expires_at: string;
}): number {
  return Date.parse(lease.expires_at) - Date.parse(lease.updated_at);
}

function humanPrompt(
  root: string,
  text: string,
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
): string {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    cwd: root,
    sessionId: SESSION,
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    promptSource: "typed",
    origin: { kind: "human" },
    uuid,
    timestamp,
  });
}

function terminalAssistant(
  root: string,
  uuid: string,
  parentUuid: string,
  timestamp: string,
): string {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    cwd: root,
    sessionId: SESSION,
    type: "assistant",
    message: {
      id: "msg-old-turn",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "Finished the old turn." }],
      stop_reason: "end_turn",
    },
    uuid,
    timestamp,
  });
}

async function trailingTurnProject(): Promise<{
  root: string;
  tracePath: string;
}> {
  const { root } = await project();
  const tracePath = join(root, `${SESSION}.jsonl`);
  const oldPromptUuid = "10000000-0000-4000-8000-000000000001";
  const oldAssistantUuid = "10000000-0000-4000-8000-000000000002";
  await writeFile(
    tracePath,
    `${[
      humanPrompt(
        root,
        "Old prompt.",
        oldPromptUuid,
        null,
        "2026-08-20T12:00:00.000Z",
      ),
      terminalAssistant(
        root,
        oldAssistantUuid,
        oldPromptUuid,
        "2026-08-20T12:00:01.000Z",
      ),
    ].join("\n")}\n`,
    "utf8",
  );
  const stopped = await handleClaudeIngestHook({
    hook_event_name: "Stop",
    session_id: SESSION,
    cwd: root,
    transcript_path: tracePath,
  });
  assert.equal(stopped.ingested?.output.turns_appended, 0);
  assert.equal(stopped.ingested?.input.trailing_turns_withheld, 1);
  const journal = await readClaudeIngestJournal(root);
  const attempt = journal.attempts.at(-1);
  assert.ok(attempt);
  assert.equal(attempt.event, "Stop");
  assert.equal(attempt.outcome, "ok");
  assert.equal(attempt.observations.count, 2);
  assert.equal(
    attempt.observations.first?.observed_size,
    attempt.observations.last?.observed_size,
  );
  assert.equal(attempt.checkpoint_before, null);
  assert.ok(attempt.checkpoint_after);
  assert.equal(attempt.turns_appended, 0);
  assert.equal(attempt.runner_input?.trailing_turn_terminal, true);
  assert.equal(attempt.runner_input?.trailing_turn_closable, true);
  assert.deepEqual(attempt.pending_background_ids, []);
  assert.deepEqual(attempt.pending_agent_ids, []);
  assert.equal(attempt.publish_blocker, "trailing_turn_not_closed");
  return { root, tracePath };
}

async function runnerState(root: string): Promise<string> {
  const directory = join(root, ".barbaro", "state", "claude");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 1, "expected one Claude runner checkpoint");
  return readFile(join(directory, files[0]!), "utf8");
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function derivedPaths(root: string): {
  feed: string;
  evidence: string;
} {
  const sessionId = createSessionId("claude", SESSION);
  return {
    feed: join(root, ".barbaro", "feed", "claude", `${sessionId}.jsonl`),
    evidence: join(
      root,
      ".barbaro",
      "evidence",
      "claude",
      `${sessionId}.jsonl`,
    ),
  };
}

test("Claude remains dormant until the user explicitly joins", async () => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-dormant-"));
  const store = new ActiveLeaseStore(join(root, ".barbaro", "active"));
  try {
    const dormant = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Refactor the session writer.",
    });
    assert.equal(dormant.ignored, SESSION_NOT_JOINED);
    assert.equal(await store.readSnapshot(identity()), undefined);

    const joined = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "/barbaro new lane Refactor the session writer.",
    });
    assert.equal(joined.active_revision, 1);
    assert.equal((await store.readSnapshot(identity()))?.state, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unjoined Claude hooks never inspect or claim seeded peer turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-consent-"));
  const nativeSessionId = "dddddddd-4444-4444-8444-444444444444";
  try {
    await admitHookSession({
      projectRoot: root,
      provider: "codex",
      nativeSessionId: "consenting-peer",
      event: "UserPromptSubmit",
      prompt: "$barbaro new lane",
    });
    const workstreamId = await currentWorkstreamId(
      root,
      "codex",
      "consenting-peer",
    );
    await appendPeerTurn({
      projectRoot: root,
      workstreamId,
      sequence: 1,
      provider: "codex",
      response: "private until the receiver consents",
    });

    const inputs = [
      {
        hook_event_name: "UserPromptSubmit",
        session_id: nativeSessionId,
        cwd: root,
        prompt: "ordinary prompt",
      },
      {
        hook_event_name: "PreToolUse",
        session_id: nativeSessionId,
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      },
      {
        hook_event_name: "Stop",
        session_id: nativeSessionId,
        cwd: root,
        stop_hook_active: false,
        last_assistant_message: "done",
      },
    ];
    for (const input of inputs) {
      const result = await handleClaudeHook(input);
      assert.equal(result.ignored, SESSION_NOT_JOINED);
      assert.equal(renderClaudeHookOutput(result), "");
    }
    assert.equal(
      await new NudgeCursorStateStore(root).read(
        "claude",
        createSessionId("claude", nativeSessionId),
      ),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude's UserPromptExpansion event recognizes only /barbaro", async () => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-expansion-"));
  const store = new ActiveLeaseStore(join(root, ".barbaro", "active"));
  try {
    const unrelated = await handleClaudeHook({
      hook_event_name: "UserPromptExpansion",
      session_id: SESSION,
      cwd: root,
      command_name: "review",
      prompt: "/review",
    });
    assert.equal(unrelated.ignored, SESSION_NOT_JOINED);

    const joined = await handleClaudeHook({
      hook_event_name: "UserPromptExpansion",
      session_id: SESSION,
      cwd: root,
      command_name: "barbaro",
      prompt: "/barbaro new lane Refactor the session writer.",
    });
    assert.equal(joined.active_revision, 1);
    assert.equal(
      (await store.readSnapshot(identity()))?.intent?.text,
      "/barbaro new lane Refactor the session writer.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit opens a working lease carrying the intent", async () => {
  const { root, store } = await project();
  const result = await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Refactor the session writer.",
  });
  assert.equal(result.event, "UserPromptSubmit");

  const lease = await store.readSnapshot(identity());
  assert.ok(lease);
  assert.equal(lease.state, "working");
  assert.equal(lease.intent?.text, "Refactor the session writer.");
  assert.deepEqual(lease.claims, []);
});

test("an edit claims its exact path; the claim is advisory, never a lock", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Fix the writer.",
  });
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "writer.ts") },
  });

  const lease = await store.readSnapshot(identity());
  assert.ok(lease);
  assert.deepEqual(lease.claims, [
    { path: "src/writer.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(lease.unknown_write_scope, false);
  assert.equal(lease.current_action?.kind, "file_change");
  // The prompt intent survives across tool calls in the same turn.
  assert.equal(lease.intent?.text, "Fix the writer.");
});

test("a shell command declares unknown write scope instead of inventing paths", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "rm -rf build && npm run build" },
  });

  const lease = await store.readSnapshot(identity());
  assert.ok(lease);
  assert.equal(lease.state, "working");
  assert.equal(lease.unknown_write_scope, true);
  assert.deepEqual(lease.claims, []);
  assert.equal(lease.current_action?.command?.text, "rm -rf build && npm run build");
});

test("an await command waits without claims until its tool batch settles", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Wait for the reviewer.",
  });
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "prior.ts") },
  });
  assert.equal((await store.readSnapshot(identity()))?.claims.length, 1);

  const command = "barbaro await --timeout-ms 120000 --interval-ms 1000";
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
    tool_input: { command },
  });

  const waiting = await store.readSnapshot(identity());
  assert.ok(waiting);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.current_action?.kind, "command");
  assert.equal(waiting.current_action?.tool_name, "Bash");
  assert.equal(waiting.current_action?.command?.text, command);
  assert.deepEqual(waiting.claims, []);
  assert.equal(waiting.unknown_write_scope, false);
  assert.equal(waiting.intent?.text, "Wait for the reviewer.");
  assert.equal(leaseTtlMs(waiting), 120_000 + AWAIT_LEASE_GRACE_MS);

  const postTool = await handleClaudeHook({
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
  });
  assert.equal(postTool.ignored, "claim retained until PostToolBatch");
  assert.deepEqual(await store.readSnapshot(identity()), waiting);

  await handleClaudeHook({
    hook_event_name: "PostToolBatch",
    session_id: SESSION,
    cwd: root,
  });
  const restored = await store.readSnapshot(identity());
  assert.ok(restored);
  assert.equal(restored.state, "working");
  assert.equal(restored.current_action, undefined);
  assert.deepEqual(restored.claims, []);
  assert.equal(restored.unknown_write_scope, false);
  assert.equal(restored.intent?.text, "Wait for the reviewer.");
  assert.equal(leaseTtlMs(restored), 300_000);
});

test("an out-of-workspace edit claims nothing and reports unknown scope", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: "/Users/demo/.claude/memory/MEMORY.md" },
  });

  const lease = await store.readSnapshot(identity());
  assert.ok(lease);
  assert.deepEqual(lease.claims, []);
  assert.equal(lease.unknown_write_scope, true);
});

test("Barbaro's own output never produces a claim", async () => {
  const { root, store } = await project();
  const result = await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Write",
    tool_input: { file_path: join(root, ".barbaro", "feed", "claude", "x.jsonl") },
  });
  assert.equal(result.ignored, "generated barbaro output");
  assert.equal(await store.readSnapshot(identity()), undefined);
});

test("Stop writes an idle tombstone with an increasing revision", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Do the thing.",
  });
  const working = await store.readSnapshot(identity());
  assert.ok(working);

  await handleClaudeHook({
    hook_event_name: "Stop",
    session_id: SESSION,
    cwd: root,
  });
  const idle = await store.readSnapshot(identity());
  assert.ok(idle);
  assert.equal(idle.state, "idle");
  assert.deepEqual(idle.claims, []);
  assert.ok(idle.revision > working.revision, "revisions strictly increase");
});

test("the hook fails open on malformed input", async () => {
  await handleClaudeHookFailOpen({ nonsense: true });
  await handleClaudeHookFailOpen(null);
  await handleClaudeHookFailOpen("not an object");
  // Reaching here without throwing is the assertion: an advisory lease is
  // never worth failing a coding turn over.
  assert.ok(true);
});

test("a missing session_id is rejected by the strict handler", async () => {
  const { root } = await project();
  await assert.rejects(
    () => handleClaudeHook({ hook_event_name: "Stop", cwd: root }),
    /session_id is missing/,
  );
});

test("a subagent gets its own actor file and cannot clear the parent's claims", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "parent.ts") },
  });
  await handleClaudeHook({
    hook_event_name: "SubagentStart",
    session_id: SESSION,
    cwd: root,
    agent_id: "a1111111111111111",
  });
  // The subagent finishing must not touch the parent's lease.
  await handleClaudeHook({
    hook_event_name: "SubagentStop",
    session_id: SESSION,
    cwd: root,
    agent_id: "a1111111111111111",
  });

  const parent = await store.readSnapshot(identity());
  assert.ok(parent);
  assert.equal(parent.state, "working");
  assert.deepEqual(parent.claims, [
    { path: "src/parent.ts", mode: "write", confidence: "exact" },
  ]);

  const child = await store.readSnapshot(identity("a1111111111111111"));
  assert.ok(child, "the subagent has its own actor file");
  assert.equal(child.state, "idle");
  assert.notEqual(child.lease_id, parent.lease_id);
});

test("a launched subagent declares unknown write scope", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "SubagentStart",
    session_id: SESSION,
    cwd: root,
    agent_id: "a2222222222222222",
  });
  const lease = await store.readSnapshot(identity("a2222222222222222"));
  assert.ok(lease);
  // A subagent can write anywhere; claiming otherwise would tell a peer a
  // path is free when nothing established that.
  assert.equal(lease.unknown_write_scope, true);
  assert.deepEqual(lease.claims, []);
});

test("an unrecognized tool declares unknown write scope", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "SomeFutureTool",
    tool_input: { whatever: true },
  });
  const lease = await store.readSnapshot(identity());
  assert.ok(lease);
  assert.equal(lease.unknown_write_scope, true);
  assert.deepEqual(lease.claims, []);
});

test("PostToolBatch clears claims only after every parallel tool settles", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Edit the writer.",
  });
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "writer.ts") },
  });
  const claiming = await store.readSnapshot(identity());
  assert.equal(claiming?.claims.length, 1);

  await handleClaudeHook({
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
  });
  const during = await store.readSnapshot(identity());
  assert.ok(during);
  assert.equal(during.claims.length, 1, "a sibling tool may still be running");

  await handleClaudeHook({
    hook_event_name: "PostToolBatch",
    session_id: SESSION,
    cwd: root,
  });
  const after = await store.readSnapshot(identity());
  assert.ok(after);
  assert.deepEqual(after.claims, [], "a finished write is no longer claimed");
  assert.equal(after.state, "working", "the turn is still in progress");
  assert.equal(after.intent?.text, "Edit the writer.", "intent survives");
});

test("PostToolUseFailure retains the batch claim until PostToolBatch", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Edit the writer.",
  });
  await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "writer.ts") },
  });
  await handleClaudeHook({
    hook_event_name: "PostToolUseFailure",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
  });
  const after = await store.readSnapshot(identity());
  assert.ok(after);
  assert.equal(after.claims.length, 1);
  assert.equal(after.state, "working");
});

test("parallel PreToolUse hooks aggregate claims without revision loss", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Edit both files.",
  });
  await Promise.all([
    handleClaudeHook({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src", "a.ts") },
    }),
    handleClaudeHook({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src", "b.ts") },
    }),
  ]);
  const lease = await store.readSnapshot(identity());
  assert.deepEqual(lease?.claims, [
    { path: "src/a.ts", mode: "write", confidence: "exact" },
    { path: "src/b.ts", mode: "write", confidence: "exact" },
  ]);
});

test("catch-up events settle the lease to idle", async () => {
  for (const event of ["StopFailure", "SessionEnd", "SubagentStop"]) {
    const { root, store } = await project();
    await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Working…",
    });
    await handleClaudeHook({ hook_event_name: event, session_id: SESSION, cwd: root });
    const lease = await store.readSnapshot(identity());
    assert.ok(lease, `${event} must leave a lease`);
    assert.equal(lease.state, "idle", `${event} must settle to idle`);
    assert.deepEqual(lease.claims, []);
  }
});

test("a subagent transcript re-ingests its parent bundle, never itself", async () => {
  const { parentSessionTrace } = await import("../../src/hooks/claude.js");
  assert.equal(
    parentSessionTrace(
      "/p/traces/33333333/subagents/workflows/wf_a/agent-a111.jsonl",
    ),
    "/p/traces/33333333.jsonl",
  );
  assert.equal(
    parentSessionTrace("/p/traces/33333333/subagents/agent-a111.jsonl"),
    "/p/traces/33333333.jsonl",
  );
  // Not shaped like a subagent trace: no guess is made.
  assert.equal(parentSessionTrace("/p/traces/33333333.jsonl"), undefined);
});

test("a delayed PreToolUse does not resurrect a settled lease", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Do the thing.",
  });
  await handleClaudeHook({ hook_event_name: "Stop", session_id: SESSION, cwd: root });
  const tombstone = await store.readSnapshot(identity());
  assert.ok(tombstone);

  // Queued before the Stop, delivered after it.
  const late = await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "late.ts") },
  });
  assert.equal(late.ignored, "stale event after idle");

  const after = await store.readSnapshot(identity());
  assert.ok(after);
  // The state itself must not move, and no claim may be advertised for work
  // that already stopped — a peer would steer around a file nobody is editing.
  assert.equal(after.state, "idle", "an idle actor stays idle");
  assert.deepEqual(after.claims, []);
  assert.equal(after.revision, tombstone.revision, "no write at all");
});

test("a delayed PostToolUse after idle is also ignored", async () => {
  const { root, store } = await project();
  await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Go.",
  });
  await handleClaudeHook({ hook_event_name: "Stop", session_id: SESSION, cwd: root });
  const before = await store.readSnapshot(identity());
  const result = await handleClaudeHook({
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Edit",
  });
  assert.equal(result.ignored, "stale event after idle");
  assert.equal((await store.readSnapshot(identity()))?.revision, before?.revision);
});

test("Claude triple-nudge replay stops after the prompt delivery", async () => {
  const { root, store } = await project();
  try {
    await appendPeerTurn({
      projectRoot: root,
      workstreamId: await currentWorkstreamId(root, "claude", SESSION),
      sequence: 1,
      provider: "codex",
      response: "one revision, one prompt delivery",
    });
    const prompt = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Review the peer turn.",
    });
    assert.match(prompt.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);

    const tool = await handleClaudeHook({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    });
    assert.equal(tool.nudge, undefined);

    const stopped = await handleClaudeHook({
      hook_event_name: "Stop",
      session_id: SESSION,
      cwd: root,
      stop_hook_active: false,
      last_assistant_message: "one response",
    });
    assert.equal(stopped.stop_reason, undefined);
    assert.equal(renderClaudeHookOutput(stopped), "");
    assert.equal((await store.readSnapshot(identity()))?.state, "idle");
    const cursor = await new NudgeCursorStateStore(root).read(
      "claude",
      createSessionId("claude", SESSION),
    );
    assert.equal(cursor?.markers.stop, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude retries Stop after a post-claim lease write failure", async () => {
  const { root, store } = await project();
  try {
    await appendPeerTurn({
      projectRoot: root,
      workstreamId: await currentWorkstreamId(root, "claude", SESSION),
      sequence: 1,
      provider: "codex",
      response: "still unread after a failed continuation write",
    });
    const first = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Announce this once.",
    });
    assert.match(first.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
    const quietSecond = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Leave the peer turn unread.",
    });
    assert.equal(quietSecond.nudge, undefined);

    const originalUpdate = ActiveLeaseStore.prototype.update;
    const stableSessionId = createSessionId("claude", SESSION);
    let matchingUpdates = 0;
    ActiveLeaseStore.prototype.update = async function (
      ...args: Parameters<typeof originalUpdate>
    ) {
      const actor = args[0];
      if (
        actor.provider === "claude" &&
        actor.session_id === stableSessionId &&
        actor.agent_id === "main"
      ) {
        matchingUpdates += 1;
        if (matchingUpdates === 2) {
          return originalUpdate.call(this, args[0], args[1], {
            ...args[2],
            now: Number.NaN,
          });
        }
      }
      return originalUpdate.apply(this, args);
    };

    let failed: Awaited<ReturnType<typeof handleClaudeHookFailOpen>>;
    try {
      failed = await handleClaudeHookFailOpen({
        hook_event_name: "Stop",
        session_id: SESSION,
        cwd: root,
        stop_hook_active: false,
        last_assistant_message: "This continuation cannot be persisted.",
      });
    } finally {
      ActiveLeaseStore.prototype.update = originalUpdate;
    }

    assert.equal(matchingUpdates, 2);
    assert.equal(failed, undefined);
    assert.equal((await store.readSnapshot(identity()))?.state, "idle");
    const afterFailure = await new NudgeCursorStateStore(root).read(
      "claude",
      stableSessionId,
    );
    assert.equal(afterFailure?.markers.stop, undefined);
    assert.deepEqual(
      afterFailure?.schema === NUDGE_CURSOR_SCHEMA
        ? afterFailure.delivery
        : undefined,
      {
        highest_unread_count: 1,
        last_turn: { kind: "claude", generation: 1 },
      },
    );

    const quietThird = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Retry on this later turn.",
    });
    assert.equal(quietThird.nudge, undefined);
    const retried = await handleClaudeHook({
      hook_event_name: "Stop",
      session_id: SESSION,
      cwd: root,
      stop_hook_active: false,
      last_assistant_message: "This continuation persists.",
    });
    assert.match(retried.stop_reason ?? "", /^Barbaro:/u);
    assert.equal((await store.readSnapshot(identity()))?.state, "working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude hook nudges share one ledger, clear on context, and gate Stop", async () => {
  const { root, store } = await project();
  const workstreamId = await currentWorkstreamId(root, "claude", SESSION);
  await appendPeerTurn({
    projectRoot: root,
    workstreamId,
    sequence: 1,
    provider: "codex",
    response: "CHECKPOINT 2 APPROVED\ncontinue",
  });

  const promptDelivery = await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Implement the hook slice.",
  });
  assert.match(promptDelivery.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
  assert.match(promptDelivery.nudge?.text ?? "", /latest codex\/main/u);
  assert.equal(
    renderClaudeHookOutput(promptDelivery),
    `${promptDelivery.nudge?.text}\n`,
  );

  const child = await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    agent_id: "agent-child",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(child.nudge, undefined);

  const pre = await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(pre.nudge, undefined, "same-count tool delivery stays silent");

  const post = await handleClaudeHook({
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
  });
  assert.equal(post.nudge, undefined);
  const batch = await handleClaudeHook({
    hook_event_name: "PostToolBatch",
    session_id: SESSION,
    cwd: root,
  });
  assert.equal(batch.nudge, undefined);

  await appendPeerTurn({
    projectRoot: root,
    workstreamId,
    sequence: 2,
    provider: "codex",
    response: "news during the same turn",
  });
  const higherCountTool = await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.match(higherCountTool.nudge?.text ?? "", /^Barbaro: 2 new peer turns/u);
  assert.deepEqual(JSON.parse(renderClaudeHookOutput(higherCountTool)), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: higherCountTool.nudge?.text,
    },
  });

  const declined = await handleClaudeHook({
    hook_event_name: "Stop",
    session_id: SESSION,
    cwd: root,
    stop_hook_active: false,
    last_assistant_message: `${"prior reply ".repeat(300)}\nlast line`,
  });
  assert.equal(declined.stop_reason, undefined);
  assert.equal(renderClaudeHookOutput(declined), "");
  assert.equal((await store.readSnapshot(identity()))?.state, "idle");
  const cursorAfterDecline = await new NudgeCursorStateStore(root).read(
    "claude",
    createSessionId("claude", SESSION),
  );
  assert.equal(cursorAfterDecline?.markers.stop, undefined);
  assert.equal(
    cursorAfterDecline?.schema === NUDGE_CURSOR_SCHEMA
      ? cursorAfterDecline.claude_turn_generation
      : undefined,
    1,
  );

  const quietNextPrompt = await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Continue without reading.",
  });
  assert.equal(quietNextPrompt.nudge, undefined);
  const blocked = await handleClaudeHook({
    hook_event_name: "Stop",
    session_id: SESSION,
    cwd: root,
    stop_hook_active: false,
    last_assistant_message: `${"prior reply ".repeat(300)}\nlast line`,
  });
  assert.match(blocked.stop_reason ?? "", /run barbaro context/u);
  assert.match(blocked.stop_reason ?? "", /resend your previous response verbatim/u);
  assert.equal((blocked.stop_reason ?? "").includes("\n"), false);
  assert.ok(Buffer.byteLength(blocked.stop_reason ?? "", "utf8") < 2_000);
  assert.deepEqual(JSON.parse(renderClaudeHookOutput(blocked)), {
    decision: "block",
    reason: blocked.stop_reason,
  });
  assert.equal((await store.readSnapshot(identity()))?.state, "working");

  const cleared = await handleClaudeHook({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: root,
    tool_name: "Bash",
    tool_input: {
      command:
        "barbaro context --provider claude --session-id a | jq .value",
    },
  });
  assert.equal(cleared.nudge, undefined);
  const afterClear = await inspectUnreadPeerTurns({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: SESSION,
  });
  assert.equal(afterClear.status, "ready");
  assert.equal(afterClear.status === "ready" ? afterClear.unread_count : -1, 0);
  const cursorAfterClear = await new NudgeCursorStateStore(root).read(
    "claude",
    createSessionId("claude", SESSION),
  );
  assert.equal(cursorAfterClear?.schema, NUDGE_CURSOR_SCHEMA);
  assert.equal(
    cursorAfterClear?.schema === NUDGE_CURSOR_SCHEMA
      ? cursorAfterClear.claude_turn_generation
      : undefined,
    2,
  );
  assert.deepEqual(
    cursorAfterClear?.schema === NUDGE_CURSOR_SCHEMA
      ? cursorAfterClear.delivery
      : undefined,
    { highest_unread_count: 0 },
  );

  await appendPeerTurn({
    projectRoot: root,
    workstreamId,
    sequence: 3,
    provider: "codex",
    response: "news during continuation",
  });
  const continuedStop = await handleClaudeHook({
    hook_event_name: "Stop",
    session_id: SESSION,
    cwd: root,
    stop_hook_active: true,
    last_assistant_message: "same reply",
  });
  assert.equal(continuedStop.stop_reason, undefined);
  assert.equal(renderClaudeHookOutput(continuedStop), "");
  assert.equal((await store.readSnapshot(identity()))?.state, "idle");
  const cursor = await new NudgeCursorStateStore(root).read(
    "claude",
    createSessionId("claude", SESSION),
  );
  assert.equal(cursor?.markers.stop, undefined);

  const nextTurn = await handleClaudeHook({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    cwd: root,
    prompt: "Continue.",
  });
  assert.match(nextTurn.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
  const cursorAfterNextTurn = await new NudgeCursorStateStore(root).read(
    "claude",
    createSessionId("claude", SESSION),
  );
  assert.equal(
    cursorAfterNextTurn?.schema === NUDGE_CURSOR_SCHEMA
      ? cursorAfterNextTurn.claude_turn_generation
      : undefined,
    3,
  );
  assert.equal(
    renderClaudeHookOutput({ ...nextTurn, message: "joined lane" }),
    `joined lane\n${nextTurn.nudge?.text}\n`,
  );
  assert.equal(
    renderClaudeHookOutput({ ...nextTurn, message: "joined lane" }).startsWith("{"),
    false,
    "UserPromptSubmit stdout must remain entirely plain text",
  );
});

test("a newer Claude turn can supersede Stop without consuming its latch", async () => {
  const { root, store } = await project();
  try {
    const initial = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Initialize the cursor.",
    });
    assert.equal(initial.nudge, undefined);
    await appendPeerTurn({
      projectRoot: root,
      workstreamId: await currentWorkstreamId(root, "claude", SESSION),
      sequence: 1,
      provider: "codex",
      response: "unread during the Stop race",
    });
    const cursorStore = new NudgeCursorStateStore(root);
    const cursorPath = cursorStore.cursorPath(
      "claude",
      createSessionId("claude", SESSION),
    );
    const cursorBeforeStop = await readFile(cursorPath);

    const originalUpdate = ActiveLeaseStore.prototype.update;
    let injected = false;
    let newerPrompt: Awaited<ReturnType<typeof handleClaudeHook>> | undefined;
    ActiveLeaseStore.prototype.update = async function (
      ...args: Parameters<typeof originalUpdate>
    ) {
      const result = await originalUpdate.apply(this, args);
      const actor = args[0];
      if (
        !injected &&
        actor.provider === "claude" &&
        actor.session_id === createSessionId("claude", SESSION) &&
        actor.agent_id === "main"
      ) {
        injected = true;
        ActiveLeaseStore.prototype.update = originalUpdate;
        newerPrompt = await handleClaudeHook({
          hook_event_name: "UserPromptExpansion",
          session_id: SESSION,
          cwd: root,
          prompt: "newer expansion wins",
        });
      }
      return result;
    };

    let stopped: Awaited<ReturnType<typeof handleClaudeHook>>;
    try {
      stopped = await handleClaudeHook({
        hook_event_name: "Stop",
        session_id: SESSION,
        cwd: root,
        stop_hook_active: false,
        last_assistant_message: "older answer",
      });
    } finally {
      ActiveLeaseStore.prototype.update = originalUpdate;
    }

    assert.equal(injected, true);
    assert.equal(newerPrompt?.active_revision, 3);
    assert.equal(stopped.stop_reason, undefined);
    assert.equal((await store.readSnapshot(identity()))?.state, "working");
    assert.equal(
      (await store.readSnapshot(identity()))?.intent?.text,
      "newer expansion wins",
    );
    assert.deepEqual(
      await readFile(cursorPath),
      cursorBeforeStop,
      "a superseded Stop must not claim or update cursor state",
    );
    const unread = await inspectUnreadPeerTurns({
      projectRoot: root,
      provider: "claude",
      nativeSessionId: SESSION,
    });
    assert.equal(unread.status, "ready");
    assert.equal(unread.status === "ready" ? unread.unread_count : -1, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude PostToolUse and PostToolBatch use their exact output channels", async () => {
  for (const event of ["PostToolUse", "PostToolBatch"] as const) {
    const { root } = await project();
    try {
      await handleClaudeHook({
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        cwd: root,
        prompt: `Exercise ${event}.`,
      });
      await appendPeerTurn({
        projectRoot: root,
        workstreamId: await currentWorkstreamId(root, "claude", SESSION),
        sequence: 1,
        provider: "codex",
        response: `${event} delivery`,
      });
      const result = await handleClaudeHook({
        hook_event_name: event,
        session_id: SESSION,
        cwd: root,
        ...(event === "PostToolUse" ? { tool_name: "Bash" } : {}),
      });
      assert.match(result.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
      assert.deepEqual(JSON.parse(renderClaudeHookOutput(result)), {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: result.nudge?.text,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a corrupt Claude cursor fails open after Stop has gone idle", async () => {
  const { root, store } = await project();
  const corrupt = "{broken cursor\n";
  try {
    await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "Finish safely.",
    });
    const cursorStore = new NudgeCursorStateStore(root);
    const cursorPath = cursorStore.cursorPath(
      "claude",
      createSessionId("claude", SESSION),
    );
    assert.ok(await cursorStore.read("claude", createSessionId("claude", SESSION)));
    await writeFile(cursorPath, corrupt, "utf8");

    const result = await handleClaudeHookFailOpen({
      hook_event_name: "Stop",
      session_id: SESSION,
      cwd: root,
      stop_hook_active: false,
      last_assistant_message: "done",
    });
    assert.equal(result, undefined);
    assert.equal(renderClaudeHookOutput(result), "");
    assert.equal((await store.readSnapshot(identity()))?.state, "idle");
    assert.equal(await readFile(cursorPath, "utf8"), corrupt);
    assert.ok(
      (await listIncidents(root)).some(
        ({ incident }) =>
          incident.provider === "claude" &&
          incident.kind === "hook_error" &&
          incident.event === "Stop",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the activation template covers every event the runtime handles", async () => {
  const template = JSON.parse(
    await readFile(join(process.cwd(), "examples", "claude-hooks.json"), "utf8"),
  ) as {
    hooks: Record<
      string,
      { hooks: { command: string; async?: boolean; timeout?: number }[] }[]
    >;
  };

  // Lease events: anything the handler acts on must be wired, or the lease
  // silently goes stale in a real install.
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ]) {
    const entries = template.hooks[event];
    assert.ok(entries, `template is missing ${event}`);
    const commands = entries.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(
      commands.some((c) => c.endsWith("claude hook")),
      `${event} must maintain the lease`,
    );
  }

  // Ingestion events must match exactly what the runtime accepts, so the
  // template can neither miss a catch-up path nor fire a no-op.
  const { CATCH_UP_INGEST_EVENTS } = await import("../../src/hooks/claude.js");
  const wired = Object.entries(template.hooks)
    .filter(([, entries]) =>
      entries.some((e) => e.hooks.some((h) => h.command.endsWith("hook-ingest"))),
    )
    .map(([event]) => event)
    .sort();
  assert.deepEqual(wired, [...CATCH_UP_INGEST_EVENTS].sort());

  // Ingestion is a side effect and must not stall Claude while waiting for a
  // record that the triggering hook itself precedes. SessionEnd is the one
  // bounded synchronous sweep because the process is about to exit.
  for (const event of wired) {
    const ingest = template.hooks[event]!
      .flatMap((entry) => entry.hooks)
      .find((handler) => handler.command.endsWith("hook-ingest"));
    assert.ok(ingest, event);
    assert.equal(ingest.async === true, event !== "SessionEnd", event);
    assert.ok((ingest.timeout ?? 0) > 0, `${event} needs a bounded timeout`);
  }
});

test("ingestion only runs for events that can advance publication", async () => {
  const { handleClaudeIngestHook } = await import("../../src/hooks/claude.js");
  const { root } = await project();
  const result = await handleClaudeIngestHook({
    hook_event_name: "PreToolUse",
    cwd: root,
    transcript_path: join(root, "traces", "x.jsonl"),
  });
  assert.equal(result.ignored, "event does not trigger ingestion");
});

test("joining reaps tombstones no writer can touch anymore", async () => {
  // The trigger has to be the join itself: sessions start dormant and consent
  // later, so a post-join SessionStart only ever happens on resume — a reap
  // gated behind it never fires in the common flow. That is exactly how 70+
  // dead actor files accumulated in production before anyone noticed.
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-reap-"));
  const store = new ActiveLeaseStore(join(root, ".barbaro", "active"));
  try {
    const ancient = {
      lease_id: "lease_00000000000000000000000000000001",
      provider: "claude",
      session_id: createSessionId("claude", "bbbbbbbb-2222-4222-8222-222222222222"),
      agent_id: "main",
    };
    const recent = {
      lease_id: "lease_00000000000000000000000000000002",
      provider: "claude",
      session_id: createSessionId("claude", "cccccccc-3333-4333-8333-333333333333"),
      agent_id: "main",
    };
    await store.writeIdle(ancient, { now: Date.now() - 3 * 24 * 3_600_000 });
    await store.writeIdle(recent, { now: Date.now() - 60_000 });

    const joined = await handleClaudeHook({
      hook_event_name: "UserPromptExpansion",
      session_id: SESSION,
      cwd: root,
      command_name: "barbaro",
      prompt: "/barbaro new lane",
    });
    assert.equal(joined.active_revision, 1);

    assert.equal(
      await store.readSnapshot(ancient),
      undefined,
      "a tombstone expired for days is deleted at join",
    );
    assert.equal((await store.readSnapshot(recent))?.state, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ingest before the transcript exists is a quiet not-yet, not an error", async () => {
  // A brand-new session's join fires before Claude Code flushes the
  // transcript's first bytes. That produced hook_error incidents for a state
  // that heals itself one event later.
  const { handleClaudeIngestHook } = await import("../../src/hooks/claude.js");
  const { root } = await project();
  try {
    const result = await handleClaudeIngestHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      transcript_path: join(root, "not-written-yet.jsonl"),
    });
    assert.equal(result.ignored, "transcript not yet on disk");
    await assert.rejects(
      readFile(join(root, ".barbaro", "logs", "incidents", "claude")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop stays conservative and never waits for a successor prompt", async () => {
  const { root, tracePath } = await trailingTurnProject();
  try {
    const result = await handleClaudeIngestHook(
      {
        hook_event_name: "Stop",
        session_id: SESSION,
        cwd: root,
        transcript_path: tracePath,
      },
      {
        now: () => 0,
        sleep: async () => assert.fail("a stable Stop must not poll for a prompt"),
      },
    );
    assert.equal(result.ingested?.output.turns_appended, 0);
    assert.equal(result.ingested?.input.trailing_turns_withheld, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit ingests immediately when its human record is already present", async () => {
  const { root, tracePath } = await trailingTurnProject();
  try {
    await appendFile(
      tracePath,
      `${humanPrompt(
        root,
        "New prompt.",
        "10000000-0000-4000-8000-000000000003",
        "10000000-0000-4000-8000-000000000002",
        "2026-08-20T12:01:00.000Z",
      )}\n`,
      "utf8",
    );

    const result = await handleClaudeIngestHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        cwd: root,
        transcript_path: tracePath,
        prompt: "New prompt.",
      },
      {
        now: () => 0,
        sleep: async () => assert.fail("an already-recorded prompt must not sleep"),
      },
    );

    assert.equal(result.ingested?.output.turns_appended, 1);
    assert.equal(result.ingested?.input.trailing_turn_open, true);
    assert.equal(result.ingested?.input.trailing_turns_withheld, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit retries a transient snapshot after observing the prompt", async () => {
  const { root, tracePath } = await trailingTurnProject();
  let clock = 0;
  let sleeps = 0;
  try {
    await appendFile(
      tracePath,
      `${humanPrompt(
        root,
        "New prompt.",
        "10000000-0000-4000-8000-000000000003",
        "10000000-0000-4000-8000-000000000002",
        "2026-08-20T12:01:00.000Z",
      )}\n{"type":"mode"`,
      "utf8",
    );

    const result = await handleClaudeIngestHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        cwd: root,
        transcript_path: tracePath,
        prompt: "New prompt.",
      },
      {
        userPromptTimeoutMs: 30,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
          sleeps += 1;
          assert.equal(sleeps, 1, "only the transient snapshot should retry");
          await appendFile(tracePath, `,"mode":"plan"}\n`, "utf8");
        },
      },
    );

    assert.equal(sleeps, 1);
    assert.equal(result.ingested?.input.withheld_reason, undefined);
    assert.equal(result.ingested?.output.turns_appended, 1);
    assert.equal(result.ingested?.input.trailing_turn_open, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit ignores sidecar growth and waits for a human prompt", async () => {
  const { root, tracePath } = await trailingTurnProject();
  const beforeState = await runnerState(root);
  let clock = 0;
  let sleeps = 0;
  try {
    const result = await handleClaudeIngestHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        cwd: root,
        transcript_path: tracePath,
        prompt: "New prompt.",
      },
      {
        userPromptTimeoutMs: 30,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
          sleeps += 1;
          if (sleeps === 1) {
            await appendFile(
              tracePath,
              `${JSON.stringify({ type: "mode", mode: "plan" })}\n` +
                `${JSON.stringify({
                  type: "file-history-snapshot",
                  snapshot: { tracked: [] },
                })}\n`,
              "utf8",
            );
          } else if (sleeps === 2) {
            await appendFile(
              tracePath,
              `${humanPrompt(
                root,
                "New prompt.",
                "10000000-0000-4000-8000-000000000003",
                "10000000-0000-4000-8000-000000000002",
                "2026-08-20T12:01:00.000Z",
              )}\n`,
              "utf8",
            );
          }
        },
      },
    );

    assert.equal(sleeps, 2, "sidecars alone must not release the wait");
    assert.equal(result.ingested?.output.turns_appended, 1);
    assert.equal(result.ingested?.input.trailing_turn_open, true);
    assert.equal(result.ingested?.input.trailing_turns_withheld, 0);
    assert.notEqual(await runnerState(root), beforeState, "checkpoint advances");

    const feed = (await readFile(derivedPaths(root).feed, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { request: { text: string } });
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.request.text, "Old prompt.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit timeout is quiet and preserves output and checkpoint", async () => {
  const { root, tracePath } = await trailingTurnProject();
  const paths = derivedPaths(root);
  const before = {
    state: await runnerState(root),
    feed: await optionalFile(paths.feed),
    evidence: await optionalFile(paths.evidence),
    incidents: await listIncidents(root),
  };
  let clock = 0;
  let sleeps = 0;
  try {
    const result = await handleClaudeIngestHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        cwd: root,
        transcript_path: tracePath,
        prompt: "Prompt that has not been recorded.",
      },
      {
        userPromptTimeoutMs: 30,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
          sleeps += 1;
          if (sleeps === 1) {
            await appendFile(
              tracePath,
              `${JSON.stringify({ type: "mode", mode: "acceptEdits" })}\n`,
              "utf8",
            );
          } else if (sleeps === 2) {
            await appendFile(
              tracePath,
              `${JSON.stringify({
                type: "file-history-snapshot",
                snapshot: { tracked: ["src/writer.ts"] },
              })}\n`,
              "utf8",
            );
          }
        },
      },
    );

    assert.equal(sleeps, 3);
    assert.equal(result.ingested, undefined);
    assert.equal(
      result.ignored,
      "next user prompt not yet recorded in transcript",
    );
    assert.equal(await runnerState(root), before.state);
    assert.equal(await optionalFile(paths.feed), before.feed);
    assert.equal(await optionalFile(paths.evidence), before.evidence);
    assert.deepEqual(await listIncidents(root), before.incidents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit returns quietly when its persisted boundary is lost", async () => {
  const { root, tracePath } = await trailingTurnProject();
  const paths = derivedPaths(root);
  const before = {
    state: await runnerState(root),
    feed: await optionalFile(paths.feed),
    evidence: await optionalFile(paths.evidence),
    incidents: await listIncidents(root),
  };
  try {
    await writeFile(
      tracePath,
      `${humanPrompt(
        root,
        "Replacement trace.",
        "20000000-0000-4000-8000-000000000001",
        null,
        "2026-08-20T12:02:00.000Z",
      )}\n`,
      "utf8",
    );

    const result = await handleClaudeIngestHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        cwd: root,
        transcript_path: tracePath,
        prompt: "Replacement trace.",
      },
      {
        now: () => 0,
        sleep: async () => assert.fail("a lost boundary must return quietly"),
      },
    );

    assert.equal(result.ingested, undefined);
    assert.equal(
      result.ignored,
      "prior transcript checkpoint changed while waiting for prompt",
    );
    assert.equal(await runnerState(root), before.state);
    assert.equal(await optionalFile(paths.feed), before.feed);
    assert.equal(await optionalFile(paths.evidence), before.evidence);
    assert.deepEqual(await listIncidents(root), before.incidents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bare /barbaro enrolls nothing; joins and moves stamp the current lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-bare-"));
  const store = new ActiveLeaseStore(join(root, ".barbaro", "active"));
  try {
    const bare = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "/barbaro Refactor the session writer.",
    });
    assert.equal(bare.ignored, "workstream selection pending");
    assert.match(bare.message ?? "", /No open workstreams/u);
    assert.equal(await store.readSnapshot(identity()), undefined);
    assert.ok(!(await readdir(root)).includes(".barbaro"), "bare writes nothing");

    const refused = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "/barbaro join nowhere",
    });
    assert.match(refused.ignored ?? "", /no workstream named "nowhere"/u);
    assert.ok(!(await readdir(root)).includes(".barbaro"), "a refusal writes nothing");

    const joined = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "/barbaro new lane Refactor the session writer.",
    });
    assert.equal(joined.active_revision, 1);
    assert.match(joined.message ?? "", /created and joined workstream "lane"/u);
    const lease = await store.readSnapshot(identity());
    assert.match(lease?.workstream_id ?? "", /^ws_[0-9a-f]{32}$/u);

    const tool = await handleClaudeHook({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src", "writer.ts") },
    });
    assert.equal(tool.active_revision, 2);
    assert.equal(
      (await store.readSnapshot(identity()))?.workstream_id,
      lease?.workstream_id,
    );
    const moved = await handleClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: root,
      prompt: "/barbaro new next Continue there.",
    });
    assert.equal(moved.active_revision, 3);
    assert.match(moved.message ?? "", /moved this session to workstream "next"/u);
    const movedLease = await store.readSnapshot(identity());
    assert.ok(movedLease?.workstream_id);
    assert.notEqual(movedLease.workstream_id, lease?.workstream_id);
    await handleClaudeHook({
      hook_event_name: "Stop",
      session_id: SESSION,
      cwd: root,
    });
    const idle = await store.readSnapshot(identity());
    assert.equal(idle?.state, "idle");
    assert.equal(idle?.workstream_id, movedLease.workstream_id);
    assert.equal((await listIncidents(root)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readClaudeIngestJournal(
  root: string,
): Promise<BarbaroIngestAttemptJournalV2> {
  const path = join(
    root,
    ".barbaro",
    "logs",
    "ingest",
    "claude",
    `${createSessionId("claude", SESSION)}.json`,
  );
  return JSON.parse(await readFile(path, "utf8")) as BarbaroIngestAttemptJournalV2;
}
