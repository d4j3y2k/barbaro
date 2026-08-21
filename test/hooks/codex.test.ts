import assert from "node:assert/strict";
import {
  access,
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ActiveLeaseStore } from "../../src/active/store.js";
import { createSessionId, createTurnId } from "../../src/core/id.js";
import {
  handleCodexHook,
  handleCodexHookFailOpen,
  handleCodexIngestHook,
  handleCodexIngestHookFailOpen,
} from "../../src/hooks/codex.js";
import {
  admitHookSession,
  SESSION_NOT_JOINED,
  SessionParticipationStore,
} from "../../src/hooks/participation.js";

test("Codex remains dormant until the user explicitly joins", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-dormant";
  const dormant = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-dormant",
    cwd: project,
    prompt: "Refactor the session writer.",
  });
  assert.equal(dormant.ignored, SESSION_NOT_JOINED);
  assert.equal(await activeSnapshot(project, nativeSessionId), undefined);

  const joined = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-joined",
    cwd: project,
    prompt: "$barbaro Refactor the session writer.",
  });
  assert.equal(joined.active_revision, 1);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "working");
});

test("concurrent Codex hooks do not silently drop lease updates", async (t) => {
  // Codex fires several hooks per action, so two writers routinely read the
  // same revision. Without a retry the loser's ActiveLeaseRevisionConflictError
  // escaped into fail-open and its update vanished, leaving current_action
  // stale exactly when the session was busiest.
  const project = await temporaryProject(t);
  const nativeSessionId = "session-race";
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-race",
    cwd: project,
    prompt: "$barbaro Refactor the session writer.",
  });

  const racers = 8;
  const results = await Promise.allSettled(
    Array.from({ length: racers }, (_unused, index) =>
      handleCodexHook({
        hook_event_name: "PreToolUse",
        session_id: nativeSessionId,
        turn_id: "turn-race",
        cwd: project,
        tool_name: "Bash",
        tool_input: { command: `echo ${index}` },
      }),
    ),
  );

  const rejected = results.filter((result) => result.status === "rejected");
  assert.deepEqual(
    rejected.map((result) =>
      result.status === "rejected" ? String(result.reason) : "",
    ),
    [],
  );

  // Every writer landed: the revision advanced once per racer, not once total.
  const snapshot = await activeSnapshot(project, nativeSessionId);
  assert.ok(snapshot);
  assert.equal(snapshot.revision >= racers, true);
});

test("Codex admits the exact composer-rendered Barbaro skill attachment", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-composer-attachment";
  const otherSessionId = "session-selected-elsewhere";
  await joinCodexSession(project, otherSessionId);
  const skillPath = join(
    project,
    ".agents",
    "skills",
    "barbaro",
    "SKILL.md",
  );
  await mkdir(join(project, ".agents", "skills", "barbaro"), {
    recursive: true,
  });
  await writeFile(
    skillPath,
    "---\nname: barbaro\ndescription: Test Barbaro skill.\n---\n",
    "utf8",
  );

  const joined = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-composer-attachment",
    cwd: project,
    prompt: `[$barbaro](${skillPath}) \n`,
  });

  assert.equal(joined.active_revision, 1);
  const participation = new SessionParticipationStore(project);
  assert.equal(await participation.hasJoined("codex", nativeSessionId), true);
  assert.equal(await participation.hasJoined("codex", otherSessionId), true);
  assert.equal(
    (await activeSnapshot(project, nativeSessionId))?.intent?.text,
    `[$barbaro](${skillPath}) \n`,
  );
  assert.equal(await activeSnapshot(project, otherSessionId), undefined);
});

test("Codex admits the installed user-wide Barbaro skill attachment", async (t) => {
  const project = await temporaryProject(t);
  const userHome = await temporaryProject(t);
  const skillSource = await temporaryProject(t);
  const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previousHome = process.env[homeVariable];
  process.env[homeVariable] = userHome;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env[homeVariable];
    } else {
      process.env[homeVariable] = previousHome;
    }
  });

  await writeFile(
    join(skillSource, "SKILL.md"),
    "---\nname: barbaro\ndescription: Test Barbaro skill.\n---\n",
    "utf8",
  );
  await mkdir(join(userHome, ".agents", "skills"), { recursive: true });
  const userSkillDirectory = join(
    userHome,
    ".agents",
    "skills",
    "barbaro",
  );
  await symlink(skillSource, userSkillDirectory, "dir");
  const userSkillPath = join(userSkillDirectory, "SKILL.md");

  const joined = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-user-skill",
    turn_id: "turn-user-skill",
    cwd: project,
    prompt: `[$barbaro](${await realpath(userSkillPath)})&#x20;\n`,
  });

  assert.equal(joined.active_revision, 1);
  assert.equal(
    await new SessionParticipationStore(project).hasJoined(
      "codex",
      "session-user-skill",
    ),
    true,
  );
});

test("Codex refuses a join when hook and transcript session identities differ", async (t) => {
  const project = await temporaryProject(t);
  const traceSessionId = "session-from-transcript";
  const assertedSessionId = "session-from-hook";
  const trace = join(project, "rollout-session-mismatch.jsonl");
  await writeFile(
    trace,
    `${JSON.stringify(
      rollout("session_meta", {
        session_id: traceSessionId,
        id: traceSessionId,
        cwd: project,
        cli_version: "0.148.0-alpha.9",
        thread_source: "user",
      }),
    )}\n`,
    "utf8",
  );
  const skillPath = join(
    project,
    ".agents",
    "skills",
    "barbaro",
    "SKILL.md",
  );

  await assert.rejects(
    handleCodexHook({
      hook_event_name: "UserPromptSubmit",
      session_id: assertedSessionId,
      turn_id: "turn-mismatch",
      cwd: project,
      transcript_path: trace,
      prompt: `[$barbaro](${skillPath})`,
    }),
    /session_id does not match transcript session_meta\.session_id/,
  );

  const participation = new SessionParticipationStore(project);
  assert.equal(await participation.hasJoined("codex", assertedSessionId), false);
  assert.equal(await participation.hasJoined("codex", traceSessionId), false);
  await assert.rejects(access(join(project, ".barbaro")), { code: "ENOENT" });
});

test("Codex ingest cannot publish one trace under another joined session", async (t) => {
  const project = await temporaryProject(t);
  const joinedSessionId = "joined-hook-session";
  const traceSessionId = "different-trace-session";
  await joinCodexSession(project, joinedSessionId);
  const trace = join(project, "rollout-ingest-mismatch.jsonl");
  await writeFile(
    trace,
    [
      rollout("session_meta", {
        session_id: traceSessionId,
        id: traceSessionId,
        cwd: project,
        cli_version: "0.148.0-alpha.9",
        thread_source: "user",
      }),
      rollout("event_msg", { type: "task_started", turn_id: "turn-1" }),
      rollout("event_msg", { type: "user_message", message: "Private prompt" }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "Private answer",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );

  await assert.rejects(
    handleCodexIngestHook({
      hook_event_name: "SessionEnd",
      session_id: joinedSessionId,
      cwd: project,
      transcript_path: trace,
    }),
    /session_id does not match transcript session_meta\.session_id/,
  );
  await assert.rejects(access(join(project, ".barbaro", "feed")), {
    code: "ENOENT",
  });
  await assert.rejects(access(join(project, ".barbaro", "state")), {
    code: "ENOENT",
  });
});

test("Codex hooks maintain one revisioned lease through a tool lifecycle", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "native-session";
  await joinCodexSession(project, nativeSessionId);
  const nativeTurnId = "native-turn";
  const prompt = "α".repeat(3_000);
  const common = {
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
  };

  const submitted = await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
  assert.equal(submitted.active_revision, 1);

  const actor = {
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    agent_id: "main",
  } as const;
  const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
  const initial = await store.readSnapshot(actor);
  assert.equal(initial?.state, "working");
  assert.equal(
    initial?.turn_id,
    createTurnId("codex", nativeSessionId, "main", nativeTurnId),
  );
  assert.equal(initial?.intent?.fidelity, "excerpt");
  assert.equal(initial?.intent?.truncated, true);
  assert.equal(initial?.intent?.original_utf8_bytes, 6_000);
  assert.ok(Buffer.byteLength(initial?.intent?.text ?? "", "utf8") <= 4_096);

  const preTool = await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_use_id: "tool-1",
    tool_input: {
      // This is the released Codex hook field for apply_patch input.
      command: [
        "*** Begin Patch",
        "*** Update File: src/old.ts",
        "*** Move to: src/new.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: .barbaro/active/echo.json",
        "+{}",
        "*** End Patch",
      ].join("\n"),
    },
  });
  assert.equal(preTool.active_revision, 2);

  const editing = await store.readSnapshot(actor);
  assert.equal(editing?.current_action?.kind, "file_change");
  assert.deepEqual(editing?.claims, [
    { path: "src/new.ts", mode: "write", confidence: "exact" },
    { path: "src/old.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(editing?.unknown_write_scope, false);
  assert.equal(editing?.intent?.original_utf8_bytes, 6_000);

  const postTool = await handleCodexHook({
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_use_id: "tool-1",
  });
  assert.equal(postTool.active_revision, 3);
  const afterTool = await store.readSnapshot(actor);
  assert.equal(afterTool?.current_action, undefined);
  assert.deepEqual(afterTool?.claims, []);
  assert.equal(afterTool?.intent?.original_utf8_bytes, 6_000);

  const stopped = await handleCodexHook({
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Done",
  });
  assert.equal(stopped.active_revision, 4);
  assert.equal(stopped.trace_result, undefined);
  const idle = await store.readSnapshot(actor);
  assert.equal(idle?.state, "idle");
  assert.equal(idle?.intent, undefined);
  assert.equal(idle?.current_action, undefined);
  assert.deepEqual(idle?.claims, []);
});

test("generated-only patches do not create claims or unknown project scope", async (t) => {
  const project = await temporaryProject(t);
  const common = {
    session_id: "session-generated",
    turn_id: "turn-generated",
    cwd: project,
  };
  await joinCodexSession(project, common.session_id);
  await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: .barbaro/active/codex/actor.json",
        "@@",
        "-{}",
        "+{\"state\":\"idle\"}",
        "*** End Patch",
      ].join("\n"),
    },
  });

  const snapshot = await activeSnapshot(project, common.session_id);
  assert.deepEqual(snapshot?.claims, []);
  assert.equal(snapshot?.unknown_write_scope, false);
});

test("Bash hooks carry bounded command context and declare unknown write scope", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-bash";
  await joinCodexSession(project, nativeSessionId);
  const command = `printf value ${"x".repeat(5_000)}`;
  await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: nativeSessionId,
    turn_id: "turn-bash",
    cwd: project,
    tool_name: "Bash",
    tool_use_id: "bash-1",
    tool_input: { command },
  });

  const snapshot = await activeSnapshot(project, nativeSessionId);
  assert.equal(snapshot?.current_action?.kind, "command");
  assert.equal(snapshot?.current_action?.tool_name, "Bash");
  assert.equal(snapshot?.current_action?.command?.truncated, true);
  assert.equal(
    snapshot?.current_action?.command?.original_utf8_bytes,
    Buffer.byteLength(command, "utf8"),
  );
  assert.equal(snapshot?.unknown_write_scope, true);
  assert.deepEqual(snapshot?.claims, []);
});

test("unknown mutators are conservative while version-pinned reads are known", async (t) => {
  const project = await temporaryProject(t);
  const common = {
    hook_event_name: "PreToolUse",
    session_id: "session-tool-scope",
    turn_id: "turn-tool-scope",
    cwd: project,
  };
  await joinCodexSession(project, common.session_id);

  await handleCodexHook({
    ...common,
    tool_name: "mcp__database__update_row",
    tool_input: { table: "jobs", id: 7 },
  });
  assert.equal(
    (await activeSnapshot(project, "session-tool-scope"))?.unknown_write_scope,
    true,
  );

  await handleCodexHook({
    ...common,
    tool_name: "view_image",
    tool_input: { path: "/tmp/image.png" },
  });
  assert.equal(
    (await activeSnapshot(project, "session-tool-scope"))?.unknown_write_scope,
    false,
  );

  await handleCodexHook({
    ...common,
    tool_name: "Write",
    tool_input: { path: "src/custom-write.ts" },
  });
  const customWrite = await activeSnapshot(project, "session-tool-scope");
  assert.deepEqual(customWrite?.claims, [
    { path: "src/custom-write.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(customWrite?.unknown_write_scope, true);

  await handleCodexHook({
    ...common,
    tool_name: "mcp__custom__apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Add File: src/not-exact.ts\n*** End Patch",
    },
  });
  const customPatch = await activeSnapshot(project, "session-tool-scope");
  assert.deepEqual(customPatch?.claims, []);
  assert.equal(customPatch?.unknown_write_scope, true);
});

test("unknown move tools expose advisory endpoints without claiming complete scope", async (t) => {
  const project = await temporaryProject(t);
  const common = {
    hook_event_name: "PreToolUse",
    session_id: "session-custom-move",
    turn_id: "turn-custom-move",
    cwd: project,
    tool_name: "move_file",
  };
  await joinCodexSession(project, common.session_id);

  await handleCodexHook({
    ...common,
    tool_input: {
      path: "src/old.ts",
      destination: "src/new.ts",
    },
  });
  const completeEndpoints = await activeSnapshot(
    project,
    "session-custom-move",
  );
  assert.deepEqual(completeEndpoints?.claims, [
    { path: "src/new.ts", mode: "write", confidence: "exact" },
    { path: "src/old.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(completeEndpoints?.unknown_write_scope, true);

  await handleCodexHook({
    ...common,
    tool_input: {
      path: "src/inside.ts",
      destination: "../outside.ts",
    },
  });
  const malformedEndpoint = await activeSnapshot(
    project,
    "session-custom-move",
  );
  assert.deepEqual(malformedEndpoint?.claims, [
    { path: "src/inside.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(malformedEndpoint?.unknown_write_scope, true);
});

test("apply_patch with missing source declares unknown write scope", async (t) => {
  const project = await temporaryProject(t);
  await joinCodexSession(project, "session-empty-patch");
  await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: "session-empty-patch",
    turn_id: "turn-empty-patch",
    cwd: project,
    tool_name: "apply_patch",
    tool_input: {},
  });
  const snapshot = await activeSnapshot(project, "session-empty-patch");
  assert.deepEqual(snapshot?.claims, []);
  assert.equal(snapshot?.unknown_write_scope, true);

  await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: "session-empty-patch",
    turn_id: "turn-empty-patch",
    cwd: project,
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Move to: src/orphan.ts\n*** End Patch",
    },
  });
  const orphanMove = await activeSnapshot(project, "session-empty-patch");
  assert.deepEqual(orphanMove?.claims, [
    { path: "src/orphan.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(orphanMove?.unknown_write_scope, true);
});

test("unresolved patch targets are omitted and make write scope unknown", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-outside-patch";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: nativeSessionId,
    turn_id: "turn-outside-patch",
    cwd: project,
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: src/inside.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: ../outside.ts",
        "+outside",
        "*** End Patch",
      ].join("\n"),
    },
  });

  const snapshot = await activeSnapshot(project, nativeSessionId);
  assert.deepEqual(snapshot?.claims, [
    { path: "src/inside.ts", mode: "write", confidence: "exact" },
  ]);
  assert.equal(snapshot?.unknown_write_scope, true);
});

test("concurrent subagents use distinct actors and stop independently", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-subagents";
  await joinCodexSession(project, nativeSessionId);
  const nativeTurnId = "turn-subagents";
  const common = {
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
  };
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Coordinate two searches",
  });
  await Promise.all([
    handleCodexHook({
      ...common,
      hook_event_name: "SubagentStart",
      agent_id: "agent-a",
      agent_type: "explore",
    }),
    handleCodexHook({
      ...common,
      hook_event_name: "SubagentStart",
      agent_id: "agent-b",
      agent_type: "explore",
    }),
  ]);

  const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
  const sessionId = createSessionId("codex", nativeSessionId);
  const beforeStop = await store.listActive({ sessionId });
  assert.deepEqual(
    beforeStop.map((lease) => lease.agent_id).sort(),
    ["agent-a", "agent-b", "main"],
  );
  for (const lease of beforeStop) {
    assert.equal(lease.revision, 1);
  }

  const stopped = await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStop",
    agent_id: "agent-a",
    agent_type: "explore",
    stop_hook_active: false,
    last_assistant_message: "Found the call sites",
  });
  assert.equal(stopped.active_revision, 2);

  const afterStop = await store.listActive({ sessionId });
  assert.deepEqual(
    afterStop.map((lease) => lease.agent_id).sort(),
    ["agent-b", "main"],
  );
  assert.equal(
    (await store.readSnapshot({
      provider: "codex",
      session_id: sessionId,
      agent_id: "agent-a",
    }))?.state,
    "idle",
  );
  assert.equal(
    (await store.readSnapshot({
      provider: "codex",
      session_id: sessionId,
      agent_id: "agent-b",
    }))?.state,
    "working",
  );
  assert.equal(
    (await store.readSnapshot({
      provider: "codex",
      session_id: sessionId,
      agent_id: "main",
    }))?.state,
    "working",
  );
});

test("SubagentStop clears activity before ingesting its transcript as evidence", async (t) => {
  const project = await temporaryProject(t);
  await joinCodexSession(project, "session-subagent-stop");
  const trace = join(project, "rollout-subagent-stop.jsonl");
  const records = [
    rollout("session_meta", {
      session_id: "session-subagent-stop",
      id: "agent-stopped",
      cwd: project,
      cli_version: "0.148.0-alpha.9",
      thread_source: "subagent",
      agent_path: "/root/explore",
    }),
    rollout("event_msg", { type: "task_started", turn_id: "child-turn" }),
    rollout("event_msg", { type: "user_message", message: "Find the call sites" }),
    rollout("event_msg", {
      type: "task_complete",
      turn_id: "child-turn",
      last_agent_message: "Found the call sites",
    }),
  ];
  await writeFile(
    trace,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const common = {
    session_id: "session-subagent-stop",
    turn_id: "parent-turn",
    cwd: project,
    agent_id: "agent-stopped",
    agent_type: "explore",
  };
  await handleCodexHook({ ...common, hook_event_name: "SubagentStart" });
  const stopInput = {
    ...common,
    hook_event_name: "SubagentStop",
    agent_transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "Found the call sites",
  };
  const activeResult = await handleCodexHook(stopInput);
  const ingestResult = await handleCodexIngestHook(stopInput);

  assert.equal(activeResult.trace_result, undefined);
  assert.equal(ingestResult.trace_result?.output.turns_appended, 0);
  assert.equal(ingestResult.trace_result?.output.evidence_appended, 1);
  const snapshot = await new ActiveLeaseStore(
    join(project, ".barbaro", "active"),
  ).readSnapshot({
    provider: "codex",
    session_id: createSessionId("codex", "session-subagent-stop"),
    agent_id: "agent-stopped",
  });
  assert.equal(snapshot?.state, "idle");
});

test("session, permission, and compaction hooks follow the frozen lifecycle", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-lifecycle";
  await joinCodexSession(project, nativeSessionId);
  const nativeTurnId = "turn-lifecycle";
  const sessionEvent = {
    session_id: nativeSessionId,
    cwd: project,
  };
  const turnEvent = { ...sessionEvent, turn_id: nativeTurnId };

  assert.equal(
    (await handleCodexHook({
      ...sessionEvent,
      hook_event_name: "SessionStart",
      source: "startup",
    })).active_revision,
    1,
  );
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");

  await handleCodexHook({
    ...turnEvent,
    hook_event_name: "UserPromptSubmit",
    prompt: "Update the lifecycle",
  });
  await handleCodexHook({
    ...turnEvent,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_use_id: "patch-lifecycle",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: src/lifecycle.ts\n*** End Patch",
    },
  });
  const beforePermission = await activeSnapshot(project, nativeSessionId);

  assert.equal(
    (await handleCodexHook({
      ...turnEvent,
      hook_event_name: "PermissionRequest",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: src/lifecycle.ts\n*** End Patch",
      },
    })).active_revision,
    4,
  );
  const waiting = await activeSnapshot(project, nativeSessionId);
  assert.equal(waiting?.state, "waiting");
  assert.deepEqual(waiting?.current_action, beforePermission?.current_action);
  assert.deepEqual(waiting?.claims, beforePermission?.claims);
  assert.equal(waiting?.intent?.text, "Update the lifecycle");

  assert.equal(
    (await handleCodexHook({
      ...turnEvent,
      hook_event_name: "PreCompact",
      trigger: "auto",
    })).active_revision,
    5,
  );
  const compacting = await activeSnapshot(project, nativeSessionId);
  assert.equal(compacting?.state, "working");
  assert.equal(compacting?.current_action?.kind, "other");
  assert.equal(compacting?.current_action?.tool_name, "compact");
  assert.deepEqual(compacting?.claims, []);

  assert.equal(
    (await handleCodexHook({
      ...turnEvent,
      hook_event_name: "PostCompact",
      trigger: "auto",
    })).active_revision,
    6,
  );
  const compacted = await activeSnapshot(project, nativeSessionId);
  assert.equal(compacted?.current_action, undefined);
  assert.equal(compacted?.intent?.text, "Update the lifecycle");

  assert.equal(
    (await handleCodexHook({
      ...sessionEvent,
      hook_event_name: "SessionEnd",
      reason: "other",
    })).active_revision,
    7,
  );
  const ended = await activeSnapshot(project, nativeSessionId);
  assert.equal(ended?.state, "idle");
  assert.equal(ended?.turn_id, undefined);
  assert.equal(ended?.intent, undefined);
});

test("PermissionRequest reconstructs an action when PreToolUse was not observed", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-permission-reconstruct";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "PermissionRequest",
    session_id: nativeSessionId,
    turn_id: "turn-permission-reconstruct",
    cwd: project,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });

  const snapshot = await activeSnapshot(project, nativeSessionId);
  assert.equal(snapshot?.state, "waiting");
  assert.equal(snapshot?.current_action?.kind, "command");
  assert.equal(snapshot?.current_action?.command?.text, "npm test");
  assert.equal(snapshot?.unknown_write_scope, true);
});

test("delayed turn events cannot overwrite the authoritative newer prompt", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-delayed-active-event";
  await joinCodexSession(project, nativeSessionId);
  const common = {
    session_id: nativeSessionId,
    cwd: project,
  };
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    turn_id: "turn-n",
    prompt: "old intent",
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    turn_id: "turn-n-plus-one",
    prompt: "new intent",
  });
  const authoritative = await activeSnapshot(project, nativeSessionId);
  assert.equal(authoritative?.revision, 2);
  assert.equal(authoritative?.intent?.text, "new intent");

  const delayedEvents = [
    {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/stale.ts\n*** End Patch",
      },
    },
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "touch stale.txt" },
    },
    { hook_event_name: "PostToolUse", tool_name: "apply_patch" },
    { hook_event_name: "PreCompact", trigger: "auto" },
    { hook_event_name: "PostCompact", trigger: "auto" },
    { hook_event_name: "Stop" },
  ];
  for (const delayed of delayedEvents) {
    const result = await handleCodexHook({
      ...common,
      ...delayed,
      turn_id: "turn-n",
    });
    assert.equal(result.ignored, "stale turn event ignored");
    assert.equal(result.active_revision, undefined);
    assert.deepEqual(
      await activeSnapshot(project, nativeSessionId),
      authoritative,
    );
  }
});

test("delayed subagent events are bounded by the root's authoritative turn", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-delayed-subagent";
  await joinCodexSession(project, nativeSessionId);
  const common = {
    session_id: nativeSessionId,
    cwd: project,
  };
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    turn_id: "turn-current",
    prompt: "current work",
  });

  const delayedStart = await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "turn-prior",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  assert.equal(delayedStart.ignored, "stale turn event ignored");

  const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
  const actor = {
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    agent_id: "agent-late",
  } as const;
  assert.equal(await store.readSnapshot(actor), undefined);

  await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "turn-current",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  const currentChild = await store.readSnapshot(actor);
  assert.equal(currentChild?.state, "working");

  const delayedStop = await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStop",
    turn_id: "turn-prior",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  assert.equal(delayedStop.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(actor), currentChild);
});

test("Stop publishes an idle tombstone and ingests the transcript", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "hook-trace-session";
  await joinCodexSession(project, nativeSessionId);
  const trace = join(project, "rollout-hook-trace-session.jsonl");
  const records = [
    rollout("session_meta", {
      session_id: nativeSessionId,
      id: nativeSessionId,
      cwd: project,
      cli_version: "0.148.0-alpha.9",
      thread_source: "user",
    }),
    rollout("event_msg", { type: "task_started", turn_id: "turn-1" }),
    rollout("event_msg", { type: "user_message", message: "Hook prompt" }),
    rollout("event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "Hook answer",
    }),
  ];
  await writeFile(
    trace,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );

  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-1",
    cwd: project,
    prompt: "Hook prompt",
  });
  const stopInput = {
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: "turn-1",
    cwd: project,
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "Hook answer",
  };
  const activeResult = await handleCodexHook(stopInput);
  const ingestResult = await handleCodexIngestHook(stopInput);

  assert.equal(activeResult.trace_result, undefined);
  assert.equal(ingestResult.trace_result?.output.turns_appended, 1);
  const feedNames = await readdir(join(project, ".barbaro", "feed", "codex"));
  assert.equal(feedNames.length, 1);
  const feed = await readFile(
    join(project, ".barbaro", "feed", "codex", feedNames[0]!),
    "utf8",
  );
  assert.equal(JSON.parse(feed.trim()).request.text, "Hook prompt");
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
});

test("asynchronous Stop ingestion waits for Codex to persist task_complete", async (t) => {
  const project = await temporaryProject(t);
  const trace = join(project, "rollout-delayed-terminal.jsonl");
  const nativeSessionId = "session-delayed-terminal";
  await joinCodexSession(project, nativeSessionId);
  await writeFile(
    trace,
    [
      rollout("session_meta", {
        session_id: nativeSessionId,
        id: nativeSessionId,
        cwd: project,
        cli_version: "0.148.0-alpha.9",
        thread_source: "user",
      }),
      rollout("event_msg", { type: "task_started", turn_id: "turn-prior" }),
      rollout("event_msg", { type: "user_message", message: "Prior turn" }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: "turn-prior",
        last_agent_message: "Prior terminal",
      }),
      rollout("event_msg", { type: "task_started", turn_id: "turn-delayed" }),
      rollout("event_msg", { type: "user_message", message: "Wait for terminal" }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const input = {
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: "turn-delayed",
    cwd: project,
    transcript_path: trace,
  };

  const ingesting = handleCodexIngestHook(input, {
    pollIntervalMs: 10,
    timeoutMs: 1_000,
  });
  const feedDirectory = join(project, ".barbaro", "feed", "codex");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readdir(feedDirectory)).length > 0) break;
    } catch (error: unknown) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.ok((await readdir(feedDirectory)).length > 0);
  await appendFile(
    trace,
    `${JSON.stringify(
      rollout("event_msg", {
        type: "task_complete",
        turn_id: "turn-delayed",
        last_agent_message: "Terminal is now durable",
      }),
    )}\n`,
    "utf8",
  );
  const result = await ingesting;
  assert.equal(result.trace_result?.output.turns_appended, 1);
  assert.deepEqual(result.trace_result?.output.terminal_native_turn_ids, [
    "turn-delayed",
  ]);
});

test("Stop remains idle when transcript ingestion fails", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-stop-failure";
  await joinCodexSession(project, nativeSessionId);
  const common = {
    session_id: nativeSessionId,
    turn_id: "turn-stop-failure",
    cwd: project,
  };
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "This trace will be missing",
  });

  const stopped = await handleCodexHook({
    ...common,
    hook_event_name: "Stop",
    transcript_path: join(project, "missing.jsonl"),
    stop_hook_active: false,
    last_assistant_message: "Done",
  });
  assert.equal(stopped.active_revision, 2);
  assert.equal(stopped.trace_result, undefined);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");

  await handleCodexIngestHookFailOpen({
    ...common,
    hook_event_name: "Stop",
    transcript_path: join(project, "missing.jsonl"),
  });

  const log = await readFile(
    join(project, ".barbaro", "logs", "hooks.jsonl"),
    "utf8",
  );
  const record = JSON.parse(log.trim()) as { event: string; error: string };
  assert.equal(record.event, "Stop");
  assert.match(record.error, /does not exist/);
});

test("hook failures remain fail-open and are recorded locally", async (t) => {
  const project = await temporaryProject(t);
  await assert.doesNotReject(
    handleCodexHookFailOpen({
      hook_event_name: "PreToolUse",
      session_id: "session-fail-open",
      cwd: project,
      tool_name: "Write",
      tool_input: { path: "../outside.txt" },
      // Empty optional fields are treated as absent rather than fatal.
      agent_id: "",
    }),
  );

  // A structurally invalid event also cannot block Codex.
  await assert.doesNotReject(
    handleCodexHookFailOpen({ cwd: project, hook_event_name: "Stop" }),
  );
  const log = await readFile(
    join(project, ".barbaro", "logs", "hooks.jsonl"),
    "utf8",
  );
  const records = log.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  // The payload names its event, so the log must too: recording every activity
  // failure as "unknown" defeats the debugging the log exists for.
  assert.equal(records[0].event, "Stop");
  assert.match(records[0].error, /session_id is missing/);
});

test("fail-open hook logging refuses parent and final symlink escapes", async (t) => {
  const project = await temporaryProject(t);
  const external = await mkdtemp(join(tmpdir(), "barbaro-hook-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const sentinel = join(external, "sentinel.txt");
  await writeFile(sentinel, "unchanged", "utf8");

  await mkdir(join(project, ".barbaro"), { mode: 0o700 });
  await symlink(external, join(project, ".barbaro", "logs"));
  await assert.doesNotReject(
    handleCodexHookFailOpen({
      cwd: project,
      hook_event_name: "Stop",
    }),
  );
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  assert.deepEqual((await readdir(external)).sort(), ["sentinel.txt"]);

  await rm(join(project, ".barbaro", "logs"));
  await mkdir(join(project, ".barbaro", "logs"), { mode: 0o700 });
  await symlink(sentinel, join(project, ".barbaro", "logs", "hooks.jsonl"));
  await assert.doesNotReject(
    handleCodexHookFailOpen({
      cwd: project,
      hook_event_name: "Stop",
    }),
  );
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
});

async function temporaryProject(
  t: TestContext,
): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-hook-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  return project;
}

async function activeSnapshot(project: string, nativeSessionId: string) {
  const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
  return store.readSnapshot({
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    agent_id: "main",
  });
}

async function joinCodexSession(
  project: string,
  nativeSessionId: string,
): Promise<void> {
  await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro",
  });
}

function rollout(type: string, payload: unknown) {
  return { timestamp: "2026-08-16T10:00:00.000Z", type, payload };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
