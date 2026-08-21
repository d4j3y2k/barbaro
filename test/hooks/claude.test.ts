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
import { createSessionId } from "../../src/core/id.js";
import {
  handleClaudeHook,
  handleClaudeHookFailOpen,
  handleClaudeIngestHook,
} from "../../src/hooks/claude.js";
import { listIncidents } from "../../src/hooks/incidents.js";
import {
  admitHookSession,
  SESSION_NOT_JOINED,
} from "../../src/hooks/participation.js";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";

async function project(): Promise<{ root: string; store: ActiveLeaseStore }> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-hook-"));
  await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: SESSION,
    event: "UserPromptSubmit",
    prompt: "/barbaro",
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
      prompt: "/barbaro Refactor the session writer.",
    });
    assert.equal(joined.active_revision, 1);
    assert.equal((await store.readSnapshot(identity()))?.state, "working");
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
      prompt: "/barbaro Refactor the session writer.",
    });
    assert.equal(joined.active_revision, 1);
    assert.equal(
      (await store.readSnapshot(identity()))?.intent?.text,
      "/barbaro Refactor the session writer.",
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
  assert.equal(lease.unknown_write_scope, true);
  assert.deepEqual(lease.claims, []);
  assert.equal(lease.current_action?.command?.text, "rm -rf build && npm run build");
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
      prompt: "/barbaro",
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
