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
import {
  AWAIT_LEASE_GRACE_MS,
  DEFAULT_AWAIT_TIMEOUT_MS,
} from "../../src/core/barbaro-command.js";
import { createSessionId, createTurnId } from "../../src/core/id.js";
import {
  handleCodexHook,
  handleCodexHookFailOpen,
  handleCodexIngestHook,
  handleCodexIngestHookFailOpen,
  renderCodexHookOutput,
} from "../../src/hooks/codex.js";
import type {
  BarbaroIngestAttemptJournalV2,
  BarbaroIngestAttemptV2,
} from "../../src/hooks/ingest-attempt.js";
import { listIncidents } from "../../src/hooks/incidents.js";
import {
  admitHookSession,
  SESSION_NOT_JOINED,
  SessionParticipationStore,
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
    prompt: "$barbaro new lane Refactor the session writer.",
  });
  assert.equal(joined.active_revision, 1);
  const firstLease = await activeSnapshot(project, nativeSessionId);
  assert.equal(firstLease?.state, "working");
  assert.ok(firstLease?.workstream_id);

  const moved = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-moved",
    cwd: project,
    prompt: "$barbaro new next Continue there.",
  });
  assert.equal(moved.active_revision, 2);
  const movedLease = await activeSnapshot(project, nativeSessionId);
  assert.ok(movedLease?.workstream_id);
  assert.notEqual(movedLease.workstream_id, firstLease.workstream_id);
  assert.match(moved.message ?? "", /moved this session to workstream "next"/u);
});

test("unjoined Codex hooks never inspect or claim seeded peer turns", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-unjoined-with-peer-data";
  await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: "consenting-peer",
    event: "UserPromptSubmit",
    prompt: "/barbaro new lane",
  });
  const workstreamId = await currentWorkstreamId(
    project,
    "claude",
    "consenting-peer",
  );
  await appendPeerTurn({
    projectRoot: project,
    workstreamId,
    sequence: 1,
    provider: "claude",
    response: "private until the receiver consents",
  });

  const inputs = [
    {
      hook_event_name: "UserPromptSubmit",
      session_id: nativeSessionId,
      turn_id: "turn-unjoined",
      cwd: project,
      prompt: "ordinary prompt",
    },
    {
      hook_event_name: "PreToolUse",
      session_id: nativeSessionId,
      turn_id: "turn-unjoined",
      cwd: project,
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    },
    {
      hook_event_name: "Stop",
      session_id: nativeSessionId,
      turn_id: "turn-unjoined",
      cwd: project,
      stop_hook_active: false,
      last_assistant_message: "done",
    },
  ];
  for (const input of inputs) {
    const result = await handleCodexHook(input);
    assert.equal(result.ignored, SESSION_NOT_JOINED);
    assert.equal(renderCodexHookOutput(result), "");
  }
  assert.equal(
    await new NudgeCursorStateStore(project).read(
      "codex",
      createSessionId("codex", nativeSessionId),
    ),
    undefined,
  );
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
    prompt: "$barbaro new lane Refactor the session writer.",
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
    prompt: `[$barbaro](${skillPath}) join lane\n`,
  });

  assert.equal(joined.active_revision, 1);
  const participation = new SessionParticipationStore(project);
  assert.equal(await participation.hasJoined("codex", nativeSessionId), true);
  assert.equal(await participation.hasJoined("codex", otherSessionId), true);
  assert.equal(
    (await activeSnapshot(project, nativeSessionId))?.intent?.text,
    `[$barbaro](${skillPath}) join lane\n`,
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
    prompt: `[$barbaro](${await realpath(userSkillPath)})&#x20;new lane\n`,
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

test("Codex triple-nudge replay stops after the prompt delivery", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-triple-nudge";
  await joinCodexSession(project, nativeSessionId);
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "one revision, one prompt delivery",
  });
  const common = {
    session_id: nativeSessionId,
    turn_id: "turn-triple-nudge",
    cwd: project,
  };
  const prompt = await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Review the peer turn.",
  });
  assert.match(prompt.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);

  const tool = await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(tool.nudge, undefined);

  const stopped = await handleCodexHook({
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "one response",
  });
  assert.equal(stopped.stop_reason, undefined);
  assert.equal(renderCodexHookOutput(stopped), "");
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  const cursor = await new NudgeCursorStateStore(project).read(
    "codex",
    createSessionId("codex", nativeSessionId),
  );
  assert.equal(cursor?.markers.stop, undefined);
});

test("Codex retries Stop after a post-claim lease write failure", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-stop-write-failure";
  await joinCodexSession(project, nativeSessionId);
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "still unread after a failed continuation write",
  });
  const first = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-stop-write-first",
    cwd: project,
    prompt: "Announce this once.",
  });
  assert.match(first.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
  const quietSecond = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-stop-write-second",
    cwd: project,
    prompt: "Leave the peer turn unread.",
  });
  assert.equal(quietSecond.nudge, undefined);

  const originalUpdate = ActiveLeaseStore.prototype.update;
  const stableSessionId = createSessionId("codex", nativeSessionId);
  let matchingUpdates = 0;
  ActiveLeaseStore.prototype.update = async function (
    ...args: Parameters<typeof originalUpdate>
  ) {
    const actor = args[0];
    if (
      actor.provider === "codex" &&
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

  let failed: Awaited<ReturnType<typeof handleCodexHookFailOpen>>;
  try {
    failed = await handleCodexHookFailOpen({
      hook_event_name: "Stop",
      session_id: nativeSessionId,
      turn_id: "turn-stop-write-second",
      cwd: project,
      stop_hook_active: false,
      last_assistant_message: "This continuation cannot be persisted.",
    });
  } finally {
    ActiveLeaseStore.prototype.update = originalUpdate;
  }

  assert.equal(matchingUpdates, 2);
  assert.equal(failed, undefined);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  const afterFailure = await new NudgeCursorStateStore(project).read(
    "codex",
    stableSessionId,
  );
  assert.equal(afterFailure?.markers.stop, undefined);
  assert.deepEqual(
    afterFailure?.schema === NUDGE_CURSOR_SCHEMA
      ? afterFailure.delivery
      : undefined,
    {
      highest_unread_count: 1,
      last_turn: {
        kind: "codex",
        turn_id: createTurnId(
          "codex",
          nativeSessionId,
          "main",
          "turn-stop-write-first",
        ),
      },
    },
  );

  const quietThird = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-stop-write-third",
    cwd: project,
    prompt: "Retry on this later turn.",
  });
  assert.equal(quietThird.nudge, undefined);
  const retried = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: "turn-stop-write-third",
    cwd: project,
    stop_hook_active: false,
    last_assistant_message: "This continuation persists.",
  });
  assert.match(retried.stop_reason ?? "", /^Barbaro:/u);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "working");
});

test("a committed rollback cleanup failure preserves the original Stop error", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-rollback-release-failure";
  await joinCodexSession(project, nativeSessionId);
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "remain unread after rollback",
  });
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-rollback-release-first",
    cwd: project,
    prompt: "Announce once.",
  });
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-rollback-release-second",
    cwd: project,
    prompt: "Leave it unread.",
  });

  const stableSessionId = createSessionId("codex", nativeSessionId);
  const cursorStore = new NudgeCursorStateStore(project);
  const cursorPath = cursorStore.cursorPath("codex", stableSessionId);
  const originalCursorWrite = NudgeCursorStateStore.prototype.withHookWrite;
  let rollbackReleaseInjected = false;
  NudgeCursorStateStore.prototype.withHookWrite = (async function (
    this: NudgeCursorStateStore,
    ...args: Parameters<typeof originalCursorWrite>
  ) {
    const operation = args[2];
    return originalCursorWrite.call(
      this,
      args[0],
      args[1],
      async (current) => {
        const update = await operation(current);
        if (
          !rollbackReleaseInjected &&
          current?.schema === NUDGE_CURSOR_SCHEMA &&
          current.markers.stop !== undefined &&
          update.state?.markers.stop === undefined
        ) {
          rollbackReleaseInjected = true;
          await writeFile(
            join(`${cursorPath}.lock`, "prevent-release"),
            "held\n",
          );
        }
        return update;
      },
      args[3],
    );
  }) as typeof originalCursorWrite;

  const originalUpdate = ActiveLeaseStore.prototype.update;
  let matchingUpdates = 0;
  ActiveLeaseStore.prototype.update = async function (
    ...args: Parameters<typeof originalUpdate>
  ) {
    const actor = args[0];
    if (
      actor.provider === "codex" &&
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

  let thrown: unknown;
  try {
    await handleCodexHook({
      hook_event_name: "Stop",
      session_id: nativeSessionId,
      turn_id: "turn-rollback-release-second",
      cwd: project,
      stop_hook_active: false,
      last_assistant_message: "The active continuation write fails.",
    });
  } catch (error: unknown) {
    thrown = error;
  } finally {
    ActiveLeaseStore.prototype.update = originalUpdate;
    NudgeCursorStateStore.prototype.withHookWrite = originalCursorWrite;
    await rm(`${cursorPath}.lock`, { recursive: true, force: true });
  }

  assert.equal(matchingUpdates, 2);
  assert.equal(rollbackReleaseInjected, true);
  assert.ok(thrown instanceof TypeError);
  assert.match(thrown.message, /now must be a valid date-time/u);
  assert.equal(thrown instanceof AggregateError, false);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  const cursor = await cursorStore.read("codex", stableSessionId);
  assert.equal(cursor?.markers.stop, undefined);

  let incidents = await listIncidents(project);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      incidents.some(({ incident }) =>
        incident.detail?.text.includes(
          "nudge cursor lock release failed after commit",
        )
      )
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    incidents = await listIncidents(project);
  }
  assert.ok(
    incidents.some(({ incident }) =>
      incident.detail?.text.includes(
        "nudge cursor lock release failed after commit",
      )
    ),
  );
});

test("Codex renders a committed Stop after cursor lock cleanup fails", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-cursor-release-failure";
  const nativeTurnId = "turn-cursor-release-failure";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
    prompt: "Initialize before peer news arrives.",
  });
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "Stop is the first delivery",
  });

  const stableSessionId = createSessionId("codex", nativeSessionId);
  const cursorStore = new NudgeCursorStateStore(project);
  const cursorPath = cursorStore.cursorPath("codex", stableSessionId);
  const originalWithHookWrite = NudgeCursorStateStore.prototype.withHookWrite;
  let injected = false;
  NudgeCursorStateStore.prototype.withHookWrite = (async function (
    this: NudgeCursorStateStore,
    ...args: Parameters<typeof originalWithHookWrite>
  ) {
    const operation = args[2];
    return originalWithHookWrite.call(
      this,
      args[0],
      args[1],
      async (current) => {
        const update = await operation(current);
        if (!injected && update.state?.markers.stop !== undefined) {
          injected = true;
          await writeFile(
            join(`${cursorPath}.lock`, "prevent-release"),
            "held\n",
          );
        }
        return update;
      },
      args[3],
    );
  }) as typeof originalWithHookWrite;

  let stopped: Awaited<ReturnType<typeof handleCodexHook>>;
  try {
    stopped = await handleCodexHook({
      hook_event_name: "Stop",
      session_id: nativeSessionId,
      turn_id: nativeTurnId,
      cwd: project,
      stop_hook_active: false,
      last_assistant_message: "A committed block still renders.",
    });
  } finally {
    NudgeCursorStateStore.prototype.withHookWrite = originalWithHookWrite;
    await rm(`${cursorPath}.lock`, { recursive: true, force: true });
  }

  assert.equal(injected, true);
  assert.match(stopped.stop_reason ?? "", /^Barbaro:/u);
  assert.match(renderCodexHookOutput(stopped), /"decision":"block"/u);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "working");

  let incidents = await listIncidents(project);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      incidents.some(
        ({ incident }) =>
          incident.provider === "codex" &&
          incident.kind === "hook_error" &&
          incident.detail?.text.includes(
            "nudge cursor lock release failed after commit",
          ),
      )
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    incidents = await listIncidents(project);
  }
  assert.ok(
    incidents.some(
      ({ incident }) =>
        incident.provider === "codex" &&
        incident.kind === "hook_error" &&
        incident.detail?.text.includes(
          "nudge cursor lock release failed after commit",
        ),
    ),
  );
});

test("Codex renders a committed Stop after active lock cleanup fails", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-active-release-failure";
  const nativeTurnId = "turn-active-release-failure";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
    prompt: "Initialize before peer news arrives.",
  });
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "Stop is the first delivery",
  });

  const stableSessionId = createSessionId("codex", nativeSessionId);
  const originalUpdate = ActiveLeaseStore.prototype.update;
  let matchingUpdates = 0;
  let injected = false;
  let activeLockPath: string | undefined;
  ActiveLeaseStore.prototype.update = (async function (
    this: ActiveLeaseStore,
    ...args: Parameters<typeof originalUpdate>
  ) {
    const actor = args[0];
    if (
      actor.provider === "codex" &&
      actor.session_id === stableSessionId &&
      actor.agent_id === "main"
    ) {
      matchingUpdates += 1;
      if (matchingUpdates === 2) {
        const decide = args[1];
        activeLockPath = `${this.actorPath(actor)}.lock`;
        return originalUpdate.call(
          this,
          actor,
          async (current) => {
            const decision = await decide(current);
            if ("write" in decision) {
              injected = true;
              await writeFile(
                join(activeLockPath!, "prevent-release"),
                "held\n",
              );
            }
            return decision;
          },
          args[2],
        );
      }
    }
    return originalUpdate.apply(this, args);
  }) as typeof originalUpdate;

  let stopped: Awaited<ReturnType<typeof handleCodexHook>>;
  try {
    stopped = await handleCodexHook({
      hook_event_name: "Stop",
      session_id: nativeSessionId,
      turn_id: nativeTurnId,
      cwd: project,
      stop_hook_active: false,
      last_assistant_message: "A committed block still renders.",
    });
  } finally {
    ActiveLeaseStore.prototype.update = originalUpdate;
    if (activeLockPath !== undefined) {
      await rm(activeLockPath, { recursive: true, force: true });
    }
  }

  assert.equal(injected, true);
  assert.match(stopped.stop_reason ?? "", /^Barbaro:/u);
  assert.match(renderCodexHookOutput(stopped), /"decision":"block"/u);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "working");

  let incidents = await listIncidents(project);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      incidents.some(
        ({ incident }) =>
          incident.provider === "codex" &&
          incident.kind === "hook_error" &&
          incident.detail?.text.includes(
            "active lease lock release failed after commit",
          ),
      )
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    incidents = await listIncidents(project);
  }
  assert.ok(
    incidents.some(
      ({ incident }) =>
        incident.provider === "codex" &&
        incident.kind === "hook_error" &&
        incident.detail?.text.includes(
          "active lease lock release failed after commit",
        ),
    ),
  );
});

test("Codex hook nudges are main-only, cursor-based, and Stop-safe", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-nudge";
  const common = {
    session_id: nativeSessionId,
    turn_id: "turn-nudge",
    cwd: project,
  };
  await joinCodexSession(project, nativeSessionId);
  const workstreamId = await currentWorkstreamId(
    project,
    "codex",
    nativeSessionId,
  );
  await appendPeerTurn({
    projectRoot: project,
    workstreamId,
    sequence: 1,
    response: "CHECKPOINT 2 APPROVED\nship it",
  });

  const promptDelivery = await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the slice.",
  });
  assert.match(promptDelivery.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
  assert.deepEqual(JSON.parse(renderCodexHookOutput(promptDelivery)), {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: promptDelivery.nudge?.text,
    },
  });

  const child = await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    agent_id: "agent-child",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(child.nudge, undefined, "a child cannot consume the main cursor");

  const permission = await handleCodexHook({
    ...common,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(permission.nudge, undefined);
  assert.equal(renderCodexHookOutput(permission), "");

  const sameCountTool = await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(sameCountTool.nudge, undefined);

  await appendPeerTurn({
    projectRoot: project,
    workstreamId,
    sequence: 2,
    response: "news during the same turn",
  });
  const higherCountTool = await handleCodexHook({
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.match(higherCountTool.nudge?.text ?? "", /^Barbaro: 2 new peer turns/u);
  assert.match(higherCountTool.nudge?.text ?? "", /latest claude\/main/u);
  assert.equal((higherCountTool.nudge?.text ?? "").includes("\n"), false);
  assert.deepEqual(JSON.parse(renderCodexHookOutput(higherCountTool)), {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: higherCountTool.nudge?.text,
    },
  });

  const repeatedToolBoundary = await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(repeatedToolBoundary.nudge, undefined);

  const declined = await handleCodexHook({
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: `${"answer ".repeat(500)}\nfinal line`,
  });
  assert.equal(declined.stop_reason, undefined);
  assert.equal(renderCodexHookOutput(declined), "");
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  const cursorAfterDecline = await new NudgeCursorStateStore(project).read(
    "codex",
    createSessionId("codex", nativeSessionId),
  );
  assert.equal(cursorAfterDecline?.markers.stop, undefined);

  const nextCommon = {
    session_id: nativeSessionId,
    turn_id: "turn-nudge-next",
    cwd: project,
  };
  const quietNextPrompt = await handleCodexHook({
    ...nextCommon,
    hook_event_name: "UserPromptSubmit",
    prompt: "Continue without reading.",
  });
  assert.equal(quietNextPrompt.nudge, undefined);
  const blocked = await handleCodexHook({
    ...nextCommon,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: `${"answer ".repeat(500)}\nfinal line`,
  });
  assert.match(blocked.stop_reason ?? "", /run barbaro context/u);
  assert.match(blocked.stop_reason ?? "", /resend your previous response verbatim/u);
  assert.equal((blocked.stop_reason ?? "").includes("\n"), false);
  assert.ok(Buffer.byteLength(blocked.stop_reason ?? "", "utf8") < 2_000);
  assert.deepEqual(JSON.parse(renderCodexHookOutput(blocked)), {
    decision: "block",
    reason: blocked.stop_reason,
  });
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "working");

  const cleared = await handleCodexHook({
    ...nextCommon,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: {
      command:
        "barbaro context --provider codex --session-id session-nudge | jq .value",
    },
  });
  assert.equal(cleared.nudge, undefined);
  const afterClear = await inspectUnreadPeerTurns({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
  });
  assert.equal(afterClear.status, "ready");
  assert.equal(afterClear.status === "ready" ? afterClear.unread_count : -1, 0);

  await appendPeerTurn({
    projectRoot: project,
    workstreamId,
    sequence: 3,
    response: "news during the Stop continuation",
  });
  const continuedStop = await handleCodexHook({
    ...nextCommon,
    hook_event_name: "Stop",
    stop_hook_active: true,
    last_assistant_message: "same answer",
  });
  assert.equal(continuedStop.stop_reason, undefined);
  assert.equal(renderCodexHookOutput(continuedStop), "");
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  const cursor = await new NudgeCursorStateStore(project).read(
    "codex",
    createSessionId("codex", nativeSessionId),
  );
  assert.equal(cursor?.markers.stop, undefined);

  const nextTurn = await handleCodexHook({
    session_id: nativeSessionId,
    turn_id: "turn-nudge-after-context",
    cwd: project,
    hook_event_name: "UserPromptSubmit",
    prompt: "Continue.",
  });
  assert.match(nextTurn.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
  assert.deepEqual(JSON.parse(renderCodexHookOutput(nextTurn)), {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: nextTurn.nudge?.text,
    },
  });
});

test("a newer Codex turn can supersede Stop without consuming its latch", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-stop-race";
  await joinCodexSession(project, nativeSessionId);
  const firstTurn = {
    session_id: nativeSessionId,
    turn_id: "turn-stop-race-old",
    cwd: project,
  };
  const initial = await handleCodexHook({
    ...firstTurn,
    hook_event_name: "UserPromptSubmit",
    prompt: "Initialize the cursor.",
  });
  assert.equal(initial.nudge, undefined);
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "unread during the Stop race",
  });

  const originalUpdate = ActiveLeaseStore.prototype.update;
  const stableSessionId = createSessionId("codex", nativeSessionId);
  let injected = false;
  let newerPrompt: Awaited<ReturnType<typeof handleCodexHook>> | undefined;
  ActiveLeaseStore.prototype.update = async function (
    ...args: Parameters<typeof originalUpdate>
  ) {
    const result = await originalUpdate.apply(this, args);
    const actor = args[0];
    if (
      !injected &&
      actor.provider === "codex" &&
      actor.session_id === stableSessionId &&
      actor.agent_id === "main"
    ) {
      injected = true;
      ActiveLeaseStore.prototype.update = originalUpdate;
      newerPrompt = await handleCodexHook({
        session_id: nativeSessionId,
        turn_id: "turn-stop-race-new",
        cwd: project,
        hook_event_name: "UserPromptSubmit",
        prompt: "newer prompt wins",
      });
    }
    return result;
  };

  let stopped: Awaited<ReturnType<typeof handleCodexHook>>;
  try {
    stopped = await handleCodexHook({
      ...firstTurn,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "older answer",
    });
  } finally {
    ActiveLeaseStore.prototype.update = originalUpdate;
  }

  assert.equal(injected, true);
  assert.match(newerPrompt?.nudge?.text ?? "", /^Barbaro: 1 new peer turn/u);
  assert.equal(stopped.stop_reason, undefined);
  const active = await activeSnapshot(project, nativeSessionId);
  assert.equal(active?.state, "working");
  assert.equal(active?.intent?.text, "newer prompt wins");
  const cursor = await new NudgeCursorStateStore(project).read(
    "codex",
    stableSessionId,
  );
  assert.equal(cursor?.markers.stop, undefined);
  const unread = await inspectUnreadPeerTurns({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
  });
  assert.equal(unread.status, "ready");
  assert.equal(unread.status === "ready" ? unread.unread_count : -1, 1);
});

test("a trace-attested fresh Codex context tool acknowledges unread turns", async (t) => {
  const fixture = await idleStopRolloverFixture(
    t,
    "session-fresh-context-boundary",
  );
  const trace = await writeGoalRolloverTrace(fixture);
  const cursorStore = new NudgeCursorStateStore(fixture.project);
  const stableSessionId = createSessionId("codex", fixture.nativeSessionId);
  const before = await cursorStore.read("codex", stableSessionId);
  assert.ok(before);

  const acknowledged = await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: fixture.nativeSessionId,
    turn_id: fixture.goalTurnId,
    cwd: fixture.project,
    transcript_path: trace,
    tool_name: "Bash",
    tool_input: {
      command: `barbaro context --provider codex --session-id ${fixture.nativeSessionId} --project-root ${fixture.project}`,
    },
  });
  assert.equal(acknowledged.active_revision, 3);
  assert.equal(acknowledged.nudge, undefined);

  const lease = await activeSnapshot(
    fixture.project,
    fixture.nativeSessionId,
  );
  assert.equal(lease?.state, "working");
  assert.equal(
    lease?.turn_id,
    createTurnId(
      "codex",
      fixture.nativeSessionId,
      "main",
      fixture.goalTurnId,
    ),
  );
  assert.equal(lease?.intent, undefined);
  assert.equal(lease?.extensions, undefined);

  const after = await cursorStore.read("codex", stableSessionId);
  assert.ok(after);
  assert.equal(after.cursor_revision, before.cursor_revision + 1);
  assert.notDeepEqual(after.feed_cursors, before.feed_cursors);
  assert.deepEqual(after.markers, {});
  const unread = await inspectUnreadPeerTurns({
    projectRoot: fixture.project,
    provider: "codex",
    nativeSessionId: fixture.nativeSessionId,
  });
  assert.equal(unread.status, "ready");
  assert.equal(unread.status === "ready" ? unread.unread_count : -1, 0);

  const cursorPath = cursorStore.cursorPath("codex", stableSessionId);
  const cursorAfterAcknowledgement = await readFile(cursorPath);
  const delayed = await handleCodexHook({
    hook_event_name: "PostToolUse",
    session_id: fixture.nativeSessionId,
    turn_id: fixture.priorTurnId,
    cwd: fixture.project,
    transcript_path: trace,
    tool_name: "Bash",
  });
  assert.equal(delayed.ignored, "stale turn event ignored");
  assert.deepEqual(
    await activeSnapshot(fixture.project, fixture.nativeSessionId),
    lease,
  );
  assert.deepEqual(await readFile(cursorPath), cursorAfterAcknowledgement);
});

test("trace-attested fresh Codex tool events publish honest lease state", async (t) => {
  const cases = [
    {
      event: "PreToolUse",
      expectedState: "waiting",
      expectedNudge: true,
    },
    {
      event: "PermissionRequest",
      expectedState: "waiting",
      expectedNudge: false,
    },
    {
      event: "PostToolUse",
      expectedState: "working",
      expectedNudge: true,
    },
  ] as const;

  for (const candidate of cases) {
    await t.test(candidate.event, async (subtest) => {
      const fixture = await idleStopRolloverFixture(
        subtest,
        `session-fresh-${candidate.event.toLowerCase()}`,
      );
      const trace = await writeGoalRolloverTrace(fixture);
      const cursorStore = new NudgeCursorStateStore(fixture.project);
      const stableSessionId = createSessionId("codex", fixture.nativeSessionId);
      const before = await cursorStore.read("codex", stableSessionId);
      assert.ok(before);
      const command = "barbaro await --timeout-ms 120000 --interval-ms 1000";

      const result = await handleCodexHook({
        hook_event_name: candidate.event,
        session_id: fixture.nativeSessionId,
        turn_id: fixture.goalTurnId,
        cwd: fixture.project,
        transcript_path: trace,
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(result.active_revision, 3);
      assert.equal(result.nudge !== undefined, candidate.expectedNudge);

      const lease = await activeSnapshot(
        fixture.project,
        fixture.nativeSessionId,
      );
      assert.ok(lease);
      assert.equal(lease.state, candidate.expectedState);
      assert.equal(
        lease.turn_id,
        createTurnId(
          "codex",
          fixture.nativeSessionId,
          "main",
          fixture.goalTurnId,
        ),
      );
      assert.equal(lease.intent, undefined);
      assert.equal(lease.extensions, undefined);
      if (candidate.expectedState === "waiting") {
        assert.equal(lease.current_action?.kind, "command");
        assert.equal(lease.current_action?.command?.text, command);
        assert.deepEqual(lease.claims, []);
        assert.equal(lease.unknown_write_scope, false);
        assert.equal(
          leaseTtlMs(lease),
          120_000 + AWAIT_LEASE_GRACE_MS,
        );
      } else {
        assert.equal(lease.current_action, undefined);
        assert.deepEqual(lease.claims, []);
        assert.equal(lease.unknown_write_scope, false);
      }

      const after = await cursorStore.read("codex", stableSessionId);
      assert.ok(after);
      assert.equal(after.cursor_revision, before.cursor_revision);
      assert.deepEqual(after.feed_cursors, before.feed_cursors);
      assert.equal(after.schema, NUDGE_CURSOR_SCHEMA);
      assert.equal(
        after.schema === NUDGE_CURSOR_SCHEMA
          ? after.delivery.highest_unread_count
          : -1,
        candidate.expectedNudge ? 1 : 0,
      );
      const unread = await inspectUnreadPeerTurns({
        projectRoot: fixture.project,
        provider: "codex",
        nativeSessionId: fixture.nativeSessionId,
      });
      assert.equal(unread.status, "ready");
      assert.equal(unread.status === "ready" ? unread.unread_count : -1, 1);
    });
  }
});

test("delayed fresh-turn tool events cannot roll an idle lease", async (t) => {
  for (const event of [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
  ] as const) {
    await t.test(event, async (eventTest) => {
      for (const delayedCase of [
        "idle-tombstone-turn",
        "non-head-turn",
      ] as const) {
        await eventTest.test(delayedCase, async (subtest) => {
          const fixture = await idleStopRolloverFixture(
            subtest,
            `session-stale-${event.toLowerCase()}-${delayedCase}`,
          );
          const eventTurnId =
            delayedCase === "idle-tombstone-turn"
              ? fixture.priorTurnId
              : fixture.goalTurnId;
          const traceHeadTurnId =
            delayedCase === "idle-tombstone-turn"
              ? fixture.goalTurnId
              : "turn-newer-than-delayed-event";
          const trace = await writeGoalRolloverTrace({
            ...fixture,
            goalTurnId: traceHeadTurnId,
          });

          const stale = await handleCodexHook({
            hook_event_name: event,
            session_id: fixture.nativeSessionId,
            turn_id: eventTurnId,
            cwd: fixture.project,
            transcript_path: trace,
            tool_name: "Bash",
            tool_input: { command: "barbaro context" },
          });
          assert.equal(stale.ignored, "stale turn event ignored");
          assert.equal(stale.active_revision, undefined);
          assert.equal(stale.nudge, undefined);
          assert.deepEqual(
            await activeSnapshot(fixture.project, fixture.nativeSessionId),
            fixture.leaseBefore,
          );
          assert.deepEqual(
            await readFile(fixture.cursorPath),
            fixture.cursorBefore,
          );
        });
      }
    });
  }
});

test("a trace-attested text-only Codex turn can nudge from Stop", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-text-only-stop-nudge";
  const priorTurnId = "turn-before-goal-iteration";
  const goalTurnId = "turn-text-only-goal-iteration";
  const trace = join(project, "rollout-text-only-stop-nudge.jsonl");
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
      rollout("event_msg", { type: "task_started", turn_id: priorTurnId }),
      rollout("event_msg", { type: "user_message", message: "Initial turn" }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: priorTurnId,
        last_agent_message: "Initial answer",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: priorTurnId,
    cwd: project,
    transcript_path: trace,
    prompt: "Initial turn",
  });
  const priorStop = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: priorTurnId,
    cwd: project,
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "Initial answer",
  });
  assert.equal(priorStop.active_revision, 2);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");

  // Codex goal continuations do not fire UserPromptSubmit. The native rollout
  // nevertheless attests the new turn before its first Stop hook arrives.
  await appendFile(
    trace,
    [
      rollout("event_msg", { type: "task_started", turn_id: goalTurnId }),
      rollout("event_msg", {
        type: "user_message",
        message: "<codex_internal_context source=\"goal\">continue</codex_internal_context>",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const workstreamId = await currentWorkstreamId(
    project,
    "codex",
    nativeSessionId,
  );
  await appendPeerTurn({
    projectRoot: project,
    workstreamId,
    sequence: 1,
    response: "CHECKPOINT 2 REVISE: inspect this before stopping",
  });
  const cursorStore = new NudgeCursorStateStore(project);
  const stableSessionId = createSessionId("codex", nativeSessionId);
  const beforeClaim = await cursorStore.read("codex", stableSessionId);
  assert.ok(beforeClaim);

  const blocked = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: goalTurnId,
    cwd: project,
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "WAITING: still gated",
  });
  assert.match(blocked.stop_reason ?? "", /^Barbaro:/u);
  assert.deepEqual(JSON.parse(renderCodexHookOutput(blocked)), {
    decision: "block",
    reason: blocked.stop_reason,
  });

  const expectedTurnId = createTurnId(
    "codex",
    nativeSessionId,
    "main",
    goalTurnId,
  );
  const continued = await activeSnapshot(project, nativeSessionId);
  assert.equal(continued?.revision, 4);
  assert.equal(continued?.state, "working");
  assert.equal(continued?.turn_id, expectedTurnId);
  assert.equal(continued?.intent, undefined);
  assert.deepEqual(continued?.claims, []);
  assert.equal(continued?.unknown_write_scope, false);
  assert.deepEqual(continued?.extensions?.codex, {
    barbaro_stop_continuation: {
      active: true,
      turn_id: expectedTurnId,
    },
  });

  const afterClaim = await cursorStore.read("codex", stableSessionId);
  assert.ok(afterClaim);
  assert.equal(afterClaim.cursor_revision, beforeClaim.cursor_revision);
  assert.deepEqual(afterClaim.feed_cursors, beforeClaim.feed_cursors);
  assert.equal(afterClaim.markers.stop, afterClaim.cursor_revision);
  const unread = await inspectUnreadPeerTurns({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
  });
  assert.equal(unread.status, "ready");
  assert.equal(unread.status === "ready" ? unread.unread_count : -1, 1);

  const cursorPath = cursorStore.cursorPath("codex", stableSessionId);
  const cursorBeforeActiveStop = await readFile(cursorPath);
  const activeStop = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: goalTurnId,
    cwd: project,
    transcript_path: trace,
    stop_hook_active: true,
    last_assistant_message: "WAITING: still gated",
  });
  assert.equal(activeStop.stop_reason, undefined);
  assert.equal(renderCodexHookOutput(activeStop), "");
  assert.deepEqual(await readFile(cursorPath), cursorBeforeActiveStop);
  const idle = await activeSnapshot(project, nativeSessionId);
  assert.equal(idle?.revision, 5);
  assert.equal(idle?.state, "idle");
  assert.equal(idle?.turn_id, expectedTurnId);
  assert.equal(idle?.extensions, undefined);
  assert.equal(
    (await listIncidents(project)).some(
      ({ incident }) => incident.kind === "hook_error",
    ),
    false,
  );
});

test("an idle lease still rejects a Stop older than the rollout head", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-idle-stale-stop";
  const oldTurnId = "turn-old";
  const currentTurnId = "turn-current";
  const trace = join(project, "rollout-idle-stale-stop.jsonl");
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
      rollout("event_msg", { type: "task_started", turn_id: oldTurnId }),
      rollout("event_msg", { type: "task_complete", turn_id: oldTurnId }),
      rollout("event_msg", { type: "task_started", turn_id: currentTurnId }),
      rollout("event_msg", { type: "task_complete", turn_id: currentTurnId }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: currentTurnId,
    cwd: project,
    transcript_path: trace,
    prompt: "Current turn",
  });
  await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: currentTurnId,
    cwd: project,
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "Current answer",
  });
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "unread that an old Stop must not claim",
  });
  const leaseBefore = await activeSnapshot(project, nativeSessionId);
  const cursorStore = new NudgeCursorStateStore(project);
  const stableSessionId = createSessionId("codex", nativeSessionId);
  const cursorPath = cursorStore.cursorPath("codex", stableSessionId);
  const cursorBefore = await readFile(cursorPath);

  const stale = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: oldTurnId,
    cwd: project,
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "Delayed old answer",
  });
  assert.equal(stale.ignored, "stale turn event ignored");
  assert.equal(stale.stop_reason, undefined);
  assert.deepEqual(await activeSnapshot(project, nativeSessionId), leaseBefore);
  assert.deepEqual(await readFile(cursorPath), cursorBefore);
});

test("text-only Stop rollover validates transcript identity before writes", async (t) => {
  for (const mismatch of ["session", "cwd"] as const) {
    await t.test(mismatch, async (subtest) => {
      const fixture = await idleStopRolloverFixture(
        subtest,
        `session-stop-${mismatch}-mismatch`,
      );
      const trace = join(fixture.project, `rollout-${mismatch}-mismatch.jsonl`);
      await writeFile(
        trace,
        [
          rollout("session_meta", {
            session_id:
              mismatch === "session"
                ? "different-session"
                : fixture.nativeSessionId,
            id:
              mismatch === "session"
                ? "different-session"
                : fixture.nativeSessionId,
            cwd:
              mismatch === "cwd"
                ? join(fixture.project, "different-project")
                : fixture.project,
            cli_version: "0.148.0-alpha.9",
            thread_source: "user",
          }),
          rollout("event_msg", {
            type: "task_started",
            turn_id: fixture.priorTurnId,
          }),
          rollout("event_msg", {
            type: "task_started",
            turn_id: fixture.goalTurnId,
          }),
        ].map((record) => `${JSON.stringify(record)}\n`).join(""),
        "utf8",
      );

      await assert.rejects(
        handleCodexHook({
          hook_event_name: "Stop",
          session_id: fixture.nativeSessionId,
          turn_id: fixture.goalTurnId,
          cwd: fixture.project,
          transcript_path: trace,
          stop_hook_active: false,
          last_assistant_message: "text-only answer",
        }),
        mismatch === "session"
          ? /session_id does not match transcript session_meta\.session_id/u
          : /cwd does not match transcript session_meta\.cwd/u,
      );
      assert.deepEqual(
        await activeSnapshot(fixture.project, fixture.nativeSessionId),
        fixture.leaseBefore,
      );
      assert.deepEqual(
        await readFile(fixture.cursorPath),
        fixture.cursorBefore,
      );
    });
  }
});

test("ambiguous rollout tails cannot attest a text-only Stop rollover", async (t) => {
  for (const tail of ["malformed", "partial"] as const) {
    await t.test(tail, async (subtest) => {
      const fixture = await idleStopRolloverFixture(
        subtest,
        `session-stop-${tail}-tail`,
      );
      const trace = join(fixture.project, `rollout-${tail}-tail.jsonl`);
      const complete = [
        rollout("session_meta", {
          session_id: fixture.nativeSessionId,
          id: fixture.nativeSessionId,
          cwd: fixture.project,
          cli_version: "0.148.0-alpha.9",
          thread_source: "user",
        }),
        rollout("event_msg", {
          type: "task_started",
          turn_id: fixture.priorTurnId,
        }),
        rollout("event_msg", {
          type: "task_started",
          turn_id: fixture.goalTurnId,
        }),
      ].map((record) => `${JSON.stringify(record)}\n`).join("");
      await writeFile(
        trace,
        complete + (tail === "malformed" ? "{malformed}\n" : "{"),
        "utf8",
      );

      const stale = await handleCodexHook({
        hook_event_name: "Stop",
        session_id: fixture.nativeSessionId,
        turn_id: fixture.goalTurnId,
        cwd: fixture.project,
        transcript_path: trace,
        stop_hook_active: false,
        last_assistant_message: "text-only answer",
      });
      assert.equal(stale.ignored, "stale turn event ignored");
      assert.equal(stale.stop_reason, undefined);
      assert.deepEqual(
        await activeSnapshot(fixture.project, fixture.nativeSessionId),
        fixture.leaseBefore,
      );
      assert.deepEqual(
        await readFile(fixture.cursorPath),
        fixture.cursorBefore,
      );
      const unread = await inspectUnreadPeerTurns({
        projectRoot: fixture.project,
        provider: "codex",
        nativeSessionId: fixture.nativeSessionId,
      });
      assert.equal(unread.status, "ready");
      assert.equal(unread.status === "ready" ? unread.unread_count : -1, 1);
    });
  }
});

test("a stale Codex Stop cannot consume the current turn's stop marker", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-stale-nudge-stop";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "current-turn",
    cwd: project,
    prompt: "Current work.",
  });
  const workstreamId = await currentWorkstreamId(
    project,
    "codex",
    nativeSessionId,
  );
  await appendPeerTurn({
    projectRoot: project,
    workstreamId,
    sequence: 1,
    response: "unread for the current turn",
  });

  const stale = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: "old-turn",
    cwd: project,
    stop_hook_active: false,
    last_assistant_message: "old",
  });
  assert.equal(stale.ignored, "stale turn event ignored");
  assert.equal(stale.stop_reason, undefined);

  const current = await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: "current-turn",
    cwd: project,
    stop_hook_active: false,
    last_assistant_message: "current",
  });
  assert.match(current.stop_reason ?? "", /^Barbaro:/u);
});

test("a corrupt Codex cursor fails open after Stop has gone idle", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-corrupt-nudge-cursor";
  const common = {
    session_id: nativeSessionId,
    turn_id: "turn-corrupt-nudge-cursor",
    cwd: project,
  };
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Finish safely.",
  });
  const cursorStore = new NudgeCursorStateStore(project);
  const cursorPath = cursorStore.cursorPath(
    "codex",
    createSessionId("codex", nativeSessionId),
  );
  assert.ok(
    await cursorStore.read("codex", createSessionId("codex", nativeSessionId)),
  );
  const corrupt = "{broken cursor\n";
  await writeFile(cursorPath, corrupt, "utf8");

  const result = await handleCodexHookFailOpen({
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "done",
  });
  assert.equal(result, undefined);
  assert.equal(renderCodexHookOutput(result), "");
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  assert.equal(await readFile(cursorPath, "utf8"), corrupt);
  assert.ok(
    (await listIncidents(project)).some(
      ({ incident }) =>
        incident.provider === "codex" &&
        incident.kind === "hook_error" &&
        incident.event === "Stop",
    ),
  );
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
  assert.equal(snapshot?.state, "working");
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

test("await shell hooks stay waiting through permission and restore after completion", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-await-exec";
  const common = {
    session_id: nativeSessionId,
    turn_id: "turn-await-exec",
    cwd: project,
  };
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Wait for the reviewer.",
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: src/prior.ts\n*** End Patch",
    },
  });
  assert.equal(
    (await activeSnapshot(project, nativeSessionId))?.claims.length,
    1,
  );

  const command = "barbaro await --timeout-ms 120000 --interval-ms 1000";
  await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const waiting = await activeSnapshot(project, nativeSessionId);
  assert.ok(waiting);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.current_action?.kind, "command");
  assert.equal(waiting.current_action?.tool_name, "Bash");
  assert.equal(waiting.current_action?.command?.text, command);
  assert.deepEqual(waiting.claims, []);
  assert.equal(waiting.unknown_write_scope, false);
  assert.equal(waiting.intent?.text, "Wait for the reviewer.");
  assert.equal(leaseTtlMs(waiting), 120_000 + AWAIT_LEASE_GRACE_MS);

  await handleCodexHook({
    ...common,
    hook_event_name: "PermissionRequest",
    tool_name: "exec",
    tool_input: { command },
  });
  const permission = await activeSnapshot(project, nativeSessionId);
  assert.ok(permission);
  assert.equal(permission.state, "waiting");
  assert.deepEqual(permission.current_action, waiting.current_action);
  assert.deepEqual(permission.claims, []);
  assert.equal(permission.unknown_write_scope, false);
  assert.equal(leaseTtlMs(permission), 120_000 + AWAIT_LEASE_GRACE_MS);

  await handleCodexHook({
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "exec",
  });
  const restored = await activeSnapshot(project, nativeSessionId);
  assert.ok(restored);
  assert.equal(restored.state, "working");
  assert.equal(restored.current_action, undefined);
  assert.deepEqual(restored.claims, []);
  assert.equal(restored.unknown_write_scope, false);
  assert.equal(restored.intent?.text, "Wait for the reviewer.");
  assert.equal(leaseTtlMs(restored), 300_000);

  await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "exec",
    tool_input: { command },
  });
  const explicitExec = await activeSnapshot(project, nativeSessionId);
  assert.ok(explicitExec);
  assert.equal(explicitExec.state, "waiting");
  assert.equal(explicitExec.current_action?.tool_name, "exec");
  assert.deepEqual(explicitExec.claims, []);
  assert.equal(explicitExec.unknown_write_scope, false);
  assert.equal(
    leaseTtlMs(explicitExec),
    120_000 + AWAIT_LEASE_GRACE_MS,
  );
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

test("SubagentStop settles a child-native turn while the root remains on its parent turn", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-child-native-stop";
  const parentTurnId = "parent-turn";
  const childTurnId = "child-turn";
  const childAgentId = "agent-child-native";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: parentTurnId,
    cwd: project,
    prompt: "Coordinate one child",
  });

  // Current Codex runtimes report the child's own turn id at both lifecycle
  // boundaries, rather than repeating the root's parent turn id.
  await handleCodexHook({
    hook_event_name: "SubagentStart",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    agent_type: "reviewer",
  });

  const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
  const sessionId = createSessionId("codex", nativeSessionId);
  const childActor = {
    provider: "codex",
    session_id: sessionId,
    agent_id: childAgentId,
  } as const;
  assert.equal((await store.readSnapshot(childActor))?.state, "working");

  const childPrompt = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    prompt: "Review the child lifecycle",
  });
  assert.equal(childPrompt.active_revision, 2);
  assert.equal(
    (await store.readSnapshot(childActor))?.intent?.text,
    "Review the child lifecycle",
  );

  const patchInput = {
    command: "*** Begin Patch\n*** Update File: src/child.ts\n*** End Patch",
  };
  await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    tool_name: "apply_patch",
    tool_input: patchInput,
  });
  await handleCodexHook({
    hook_event_name: "PermissionRequest",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    tool_name: "apply_patch",
    tool_input: patchInput,
  });
  const claimedChild = await store.readSnapshot(childActor);
  assert.equal(claimedChild?.state, "waiting");
  assert.deepEqual(claimedChild?.claims, [
    { path: "src/child.ts", mode: "write", confidence: "exact" },
  ]);

  const delayedClaimedPrompt = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    prompt: "Delayed prompt after tool activity",
  });
  assert.equal(delayedClaimedPrompt.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(childActor), claimedChild);

  const duplicateStart = await handleCodexHook({
    hook_event_name: "SubagentStart",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    agent_type: "reviewer",
  });
  assert.equal(duplicateStart.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(childActor), claimedChild);

  const stopped = await handleCodexHook({
    hook_event_name: "SubagentStop",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    stop_hook_active: false,
    last_assistant_message: "Child review complete",
  });
  assert.equal(stopped.active_revision, 5);
  const stoppedChild = await store.readSnapshot(childActor);
  assert.equal(stoppedChild?.state, "idle");

  const delayedPrompt = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    agent_id: childAgentId,
    prompt: "Delayed duplicate child prompt",
  });
  assert.equal(delayedPrompt.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(childActor), stoppedChild);

  const followupTurnId = "child-followup-turn";
  const childTrace = join(project, "rollout-child-followup.jsonl");
  await writeFile(
    childTrace,
    [
      rollout("session_meta", {
        session_id: nativeSessionId,
        id: childAgentId,
        cwd: project,
        cli_version: "0.150.0-alpha.8",
        thread_source: "subagent",
        agent_path: "/root/reviewer",
      }),
      rollout("event_msg", {
        type: "task_started",
        turn_id: followupTurnId,
      }),
    ]
      .map((record) => `${JSON.stringify(record)}\n`)
      .join(""),
    "utf8",
  );

  const followupTool = await handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: nativeSessionId,
    turn_id: followupTurnId,
    cwd: project,
    transcript_path: childTrace,
    agent_id: childAgentId,
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal(followupTool.active_revision, 6);
  const workingFollowup = await store.readSnapshot(childActor);
  assert.equal(workingFollowup?.state, "working");
  assert.equal(
    workingFollowup?.turn_id,
    createTurnId("codex", nativeSessionId, childAgentId, followupTurnId),
  );

  const delayedPriorTool = await handleCodexHook({
    hook_event_name: "PostToolUse",
    session_id: nativeSessionId,
    turn_id: childTurnId,
    cwd: project,
    transcript_path: childTrace,
    agent_id: childAgentId,
    tool_name: "Bash",
  });
  assert.equal(delayedPriorTool.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(childActor), workingFollowup);

  const stoppedFollowup = await handleCodexHook({
    hook_event_name: "SubagentStop",
    session_id: nativeSessionId,
    turn_id: followupTurnId,
    cwd: project,
    agent_id: childAgentId,
    agent_transcript_path: childTrace,
  });
  assert.equal(stoppedFollowup.active_revision, 7);
  const idleFollowup = await store.readSnapshot(childActor);
  assert.equal(idleFollowup?.state, "idle");

  const textOnlyFollowupTurnId = "child-text-only-followup";
  await appendFile(
    childTrace,
    `${JSON.stringify(
      rollout("event_msg", {
        type: "task_started",
        turn_id: textOnlyFollowupTurnId,
      }),
    )}\n`,
    "utf8",
  );
  const stoppedTextOnlyFollowup = await handleCodexHook({
    hook_event_name: "SubagentStop",
    session_id: nativeSessionId,
    turn_id: textOnlyFollowupTurnId,
    cwd: project,
    agent_id: childAgentId,
    agent_transcript_path: childTrace,
  });
  assert.equal(stoppedTextOnlyFollowup.active_revision, 8);
  const idleTextOnlyFollowup = await store.readSnapshot(childActor);
  assert.equal(idleTextOnlyFollowup?.state, "idle");
  assert.equal(
    idleTextOnlyFollowup?.turn_id,
    createTurnId(
      "codex",
      nativeSessionId,
      childAgentId,
      textOnlyFollowupTurnId,
    ),
  );
  assert.equal(
    (await store.readSnapshot({
      provider: "codex",
      session_id: sessionId,
      agent_id: "main",
    }))?.state,
    "working",
  );

  const missingStop = await handleCodexHook({
    hook_event_name: "SubagentStop",
    session_id: nativeSessionId,
    turn_id: "different-child-turn",
    cwd: project,
    agent_id: "agent-never-started",
  });
  assert.equal(missingStop.active_revision, 1);
  const missingActor = {
    provider: "codex",
    session_id: sessionId,
    agent_id: "agent-never-started",
  } as const;
  const earlyTombstone = await store.readSnapshot(missingActor);
  assert.equal(earlyTombstone?.state, "idle");

  const delayedStart = await handleCodexHook({
    hook_event_name: "SubagentStart",
    session_id: nativeSessionId,
    turn_id: "different-child-turn",
    cwd: project,
    agent_id: "agent-never-started",
    agent_type: "reviewer",
  });
  assert.equal(delayedStart.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(missingActor), earlyTombstone);

  const delayedMissingPrompt = await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "different-child-turn",
    cwd: project,
    agent_id: "agent-never-started",
    prompt: "Prompt delivered after the stop tombstone",
  });
  assert.equal(delayedMissingPrompt.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(missingActor), earlyTombstone);
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
  const journal = await readIngestAttemptJournal(
    join(
      project,
      ".barbaro",
      "logs",
      "ingest",
      "codex",
      `${createSessionId("codex", "session-subagent-stop")}.json`,
    ),
  );
  const attempt = journal.attempts.at(-1);
  assert.ok(attempt);
  assert.equal(attempt.trigger?.native_turn_id, "parent-turn");
  assert.equal(
    attempt.trigger?.turn_id,
    createTurnId(
      "codex",
      "session-subagent-stop",
      "agent-stopped",
      "parent-turn",
    ),
  );
  assert.equal(attempt.trigger?.agent_id, "agent-stopped");
  assert.equal(attempt.publish_blocker, undefined);
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

test("same-turn compaction hooks cannot resurrect a Stop tombstone", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-delayed-compaction";
  const common = {
    session_id: nativeSessionId,
    turn_id: "turn-delayed-compaction",
    cwd: project,
  };
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Finish before delayed compaction arrives",
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Finished",
  });
  const terminal = await activeSnapshot(project, nativeSessionId);
  assert.equal(terminal?.state, "idle");

  for (const hook_event_name of ["PreCompact", "PostCompact"] as const) {
    const delayed = await handleCodexHook({
      ...common,
      hook_event_name,
      trigger: "auto",
    });
    assert.equal(delayed.ignored, "stale turn event ignored");
    assert.deepEqual(
      await activeSnapshot(project, nativeSessionId),
      terminal,
    );
  }
});

test("PermissionRequest reconstructs ordinary and await actions without PreToolUse", async (t) => {
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

  const awaitSessionId = "session-permission-await";
  await joinCodexSession(project, awaitSessionId);
  await handleCodexHook({
    hook_event_name: "PermissionRequest",
    session_id: awaitSessionId,
    turn_id: "turn-permission-await",
    cwd: project,
    tool_name: "exec",
    tool_input: { command: "barbaro await --timeout-ms nope" },
  });
  const awaitSnapshot = await activeSnapshot(project, awaitSessionId);
  assert.ok(awaitSnapshot);
  assert.equal(awaitSnapshot.state, "waiting");
  assert.equal(awaitSnapshot.current_action?.kind, "command");
  assert.equal(
    awaitSnapshot.current_action?.command?.text,
    "barbaro await --timeout-ms nope",
  );
  assert.deepEqual(awaitSnapshot.claims, []);
  assert.equal(awaitSnapshot.unknown_write_scope, false);
  assert.equal(
    leaseTtlMs(awaitSnapshot),
    DEFAULT_AWAIT_TIMEOUT_MS + AWAIT_LEASE_GRACE_MS,
  );
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

test("subagent lifecycle is child-turn fenced and root-presence bounded", async (t) => {
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

  await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "child-turn-current",
    agent_id: "agent-late",
    agent_type: "explore",
  });

  const store = new ActiveLeaseStore(join(project, ".barbaro", "active"));
  const actor = {
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    agent_id: "agent-late",
  } as const;
  const currentChild = await store.readSnapshot(actor);
  assert.equal(currentChild?.state, "working");

  const delayedStart = await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "child-turn-prior",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  assert.equal(delayedStart.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(actor), currentChild);

  const delayedStop = await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStop",
    turn_id: "child-turn-prior",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  assert.equal(delayedStop.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(actor), currentChild);

  await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStop",
    turn_id: "child-turn-current",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  const idleChild = await store.readSnapshot(actor);
  assert.equal(idleChild?.state, "idle");

  const duplicateStart = await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "child-turn-current",
    agent_id: "agent-late",
    agent_type: "explore",
  });
  assert.equal(duplicateStart.ignored, "stale turn event ignored");
  assert.deepEqual(await store.readSnapshot(actor), idleChild);

  const finishingActor = {
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    agent_id: "agent-finishing-after-root",
  } as const;
  await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStart",
    turn_id: "child-finishing-after-root",
    agent_id: finishingActor.agent_id,
    agent_type: "explore",
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "Stop",
    turn_id: "turn-current",
  });
  assert.equal((await store.readSnapshot(finishingActor))?.state, "working");
  await handleCodexHook({
    ...common,
    hook_event_name: "SubagentStop",
    turn_id: "child-finishing-after-root",
    agent_id: finishingActor.agent_id,
    agent_type: "explore",
  });
  assert.equal((await store.readSnapshot(finishingActor))?.state, "idle");

  const lateBoundaries = [
    { hook_event_name: "SubagentStart", agent_type: "explore" },
    { hook_event_name: "UserPromptSubmit", prompt: "late child prompt" },
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    },
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    },
    { hook_event_name: "PostToolUse", tool_name: "Bash" },
    { hook_event_name: "PreCompact", trigger: "auto" },
    { hook_event_name: "PostCompact", trigger: "auto" },
  ] as const;
  for (const [index, boundary] of lateBoundaries.entries()) {
    const agentId = `agent-after-root-stop-${index}`;
    const rejected = await handleCodexHook({
      ...common,
      ...boundary,
      turn_id: `child-after-root-stop-${index}`,
      agent_id: agentId,
    });
    assert.equal(rejected.ignored, "stale turn event ignored");
    assert.equal(
      await store.readSnapshot({
        provider: "codex",
        session_id: createSessionId("codex", nativeSessionId),
        agent_id: agentId,
      }),
      undefined,
    );
  }
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

test("a nudge-blocked Stop hands off ingest until the active Stop", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-stop-nudge-ingest";
  const nativeTurnId = "turn-stop-nudge-ingest";
  const trace = join(project, "rollout-stop-nudge-ingest.jsonl");
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
      rollout("event_msg", { type: "task_started", turn_id: nativeTurnId }),
      rollout("event_msg", {
        type: "user_message",
        message: "Wait for peer context",
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const common = {
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
  };
  await handleCodexHook({
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Wait for peer context",
  });
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "peer context that blocks the first Stop",
  });
  const firstStop = {
    ...common,
    hook_event_name: "Stop",
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "first answer",
  };
  const attemptPath = join(
    project,
    ".barbaro",
    "logs",
    "ingest",
    "codex",
    `${createSessionId("codex", nativeSessionId)}.json`,
  );
  const observedAttemptIds = new Set<string>();
  const firstIngest = handleCodexIngestHook(firstStop, {
    pollIntervalMs: 5,
    timeoutMs: 1_000,
  });
  let firstAttemptId: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const current = await readIngestAttemptJournal(attemptPath);
      const started = newestUnseenAttempt(current, observedAttemptIds, false);
      if (started !== undefined) {
        firstAttemptId = started.attempt_id;
        observedAttemptIds.add(started.attempt_id);
        break;
      }
    } catch {
      // The asynchronous hook has not created its attempt marker yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  assert.notEqual(firstAttemptId, undefined);
  const blocked = await handleCodexHook(firstStop);
  assert.match(blocked.stop_reason ?? "", /^Barbaro:/u);
  const expectedTurnId = createTurnId(
    "codex",
    nativeSessionId,
    "main",
    nativeTurnId,
  );
  assert.deepEqual(
    (await activeSnapshot(project, nativeSessionId))?.extensions?.codex,
    {
      barbaro_stop_continuation: {
        active: true,
        turn_id: expectedTurnId,
      },
    },
  );

  // The first Stop ingest began before the sync hook published its handoff.
  // It must observe that handoff and finish without manufacturing a timeout
  // incident while the model is in the requested continuation.
  const deferred = await firstIngest;
  assert.equal(
    deferred.ignored,
    "Stop continuation is intentionally nonterminal",
  );
  const deferredAttempt = findIngestAttempt(
    await readIngestAttemptJournal(attemptPath),
    firstAttemptId!,
  );
  assert.equal(deferredAttempt.outcome, "ok");

  // Same-turn tool, permission, and compact boundaries keep the handoff live,
  // including the waiting lease that may last longer than the ingest timeout.
  await handleCodexHook({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "waiting");
  const waitingDeferred = await handleCodexIngestHook(firstStop, {
    pollIntervalMs: 1,
    timeoutMs: 1,
  });
  assert.equal(
    waitingDeferred.ignored,
    "Stop continuation is intentionally nonterminal",
  );
  const waitingJournal = await readIngestAttemptJournal(attemptPath);
  const waitingAttempt = newestUnseenAttempt(
    waitingJournal,
    observedAttemptIds,
    true,
  );
  assert.ok(waitingAttempt);
  observedAttemptIds.add(waitingAttempt.attempt_id);
  assert.equal(waitingAttempt.outcome, "ok");
  await handleCodexHook({
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "PreCompact",
    trigger: "auto",
  });
  await handleCodexHook({
    ...common,
    hook_event_name: "PostCompact",
    trigger: "auto",
  });
  assert.deepEqual(
    (await activeSnapshot(project, nativeSessionId))?.extensions?.codex,
    {
      barbaro_stop_continuation: {
        active: true,
        turn_id: expectedTurnId,
      },
    },
  );

  // Start the active-Stop ingest worker while the old handoff is still
  // visible. stop_hook_active must prevent a false deferral; the synchronous
  // active Stop then clears the handoff and the durable terminal is ingested.
  const finalStop = { ...firstStop, stop_hook_active: true };
  await assert.rejects(
    handleCodexIngestHook(finalStop, {
      pollIntervalMs: 1,
      timeoutMs: 1,
    }),
    /did not reach a terminal record/u,
  );
  const activeTimeoutAttempt = newestUnseenAttempt(
    await readIngestAttemptJournal(attemptPath),
    observedAttemptIds,
    true,
  );
  assert.ok(activeTimeoutAttempt);
  observedAttemptIds.add(activeTimeoutAttempt.attempt_id);
  assert.equal(activeTimeoutAttempt.outcome, "error");
  const finalIngest = handleCodexIngestHook(finalStop, {
    pollIntervalMs: 5,
    timeoutMs: 1_000,
  });
  let finalAttemptId: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await readIngestAttemptJournal(attemptPath);
    const started = newestUnseenAttempt(current, observedAttemptIds, false);
    if (started !== undefined) {
      finalAttemptId = started.attempt_id;
      observedAttemptIds.add(started.attempt_id);
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  assert.notEqual(finalAttemptId, undefined);
  const activeStop = await handleCodexHook(finalStop);
  assert.equal(activeStop.stop_reason, undefined);
  assert.equal((await activeSnapshot(project, nativeSessionId))?.state, "idle");
  assert.equal(
    (await activeSnapshot(project, nativeSessionId))?.extensions,
    undefined,
  );
  await appendFile(
    trace,
    `${JSON.stringify(
      rollout("event_msg", {
        type: "task_complete",
        turn_id: nativeTurnId,
        last_agent_message: "answer after context",
      }),
    )}\n`,
    "utf8",
  );
  const published = await finalIngest;
  assert.deepEqual(published.trace_result?.output.terminal_native_turn_ids, [
    nativeTurnId,
  ]);
  const completedFinalAttempt = findIngestAttempt(
    await readIngestAttemptJournal(attemptPath),
    finalAttemptId!,
  );
  assert.equal(completedFinalAttempt.event, "Stop");
  assert.equal(completedFinalAttempt.outcome, "ok");
  assert.equal(completedFinalAttempt.trigger?.native_turn_id, nativeTurnId);
  assert.equal(completedFinalAttempt.trigger?.turn_id, expectedTurnId);
  assert.equal(completedFinalAttempt.trigger?.agent_id, "main");
  assert.ok(completedFinalAttempt.trigger?.last_assistant_message?.sha256);
  assert.ok(completedFinalAttempt.observations.count >= 2);
  assert.ok(
    completedFinalAttempt.observations.first!.observed_size <
      completedFinalAttempt.observations.last!.observed_size,
  );
  assert.ok(completedFinalAttempt.checkpoint_before);
  assert.ok(completedFinalAttempt.checkpoint_after);
  assert.equal(completedFinalAttempt.turns_appended, 1);
  assert.equal(completedFinalAttempt.runner_input?.partial_final_line, false);
  assert.equal(completedFinalAttempt.publish_blocker, undefined);
  assert.equal(
    (await listIncidents(project)).some(
      ({ incident }) => incident.kind === "hook_error",
    ),
    false,
  );
});

test("a new Codex turn clears the Stop continuation handoff", async (t) => {
  const project = await temporaryProject(t);
  const nativeSessionId = "session-stop-nudge-cleared";
  const nativeTurnId = "turn-stop-nudge-cleared";
  const trace = join(project, "rollout-stop-nudge-cleared.jsonl");
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
      rollout("event_msg", { type: "task_started", turn_id: nativeTurnId }),
      rollout("event_msg", { type: "user_message", message: "First turn" }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
    prompt: "First turn",
  });
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "unread before Stop",
  });
  const staleStop = {
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: nativeTurnId,
    cwd: project,
    transcript_path: trace,
    stop_hook_active: false,
    last_assistant_message: "first answer",
  };
  assert.match((await handleCodexHook(staleStop)).stop_reason ?? "", /^Barbaro:/u);

  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: "turn-after-continuation",
    cwd: project,
    prompt: "A genuinely new turn",
  });
  assert.equal(
    (await activeSnapshot(project, nativeSessionId))?.extensions,
    undefined,
  );
  await assert.rejects(
    handleCodexIngestHook(staleStop, {
      pollIntervalMs: 1,
      timeoutMs: 1,
    }),
    /did not reach a terminal record/u,
  );
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

async function idleStopRolloverFixture(
  t: TestContext,
  nativeSessionId: string,
) {
  const project = await temporaryProject(t);
  const priorTurnId = "turn-prior";
  const goalTurnId = "turn-goal";
  await joinCodexSession(project, nativeSessionId);
  await handleCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: nativeSessionId,
    turn_id: priorTurnId,
    cwd: project,
    prompt: "Prior prompt",
  });
  await handleCodexHook({
    hook_event_name: "Stop",
    session_id: nativeSessionId,
    turn_id: priorTurnId,
    cwd: project,
    stop_hook_active: false,
    last_assistant_message: "Prior answer",
  });
  await appendPeerTurn({
    projectRoot: project,
    workstreamId: await currentWorkstreamId(
      project,
      "codex",
      nativeSessionId,
    ),
    sequence: 1,
    response: "unread for the text-only goal turn",
  });
  const stableSessionId = createSessionId("codex", nativeSessionId);
  const cursorStore = new NudgeCursorStateStore(project);
  const cursorPath = cursorStore.cursorPath("codex", stableSessionId);
  return {
    project,
    nativeSessionId,
    priorTurnId,
    goalTurnId,
    cursorPath,
    leaseBefore: await activeSnapshot(project, nativeSessionId),
    cursorBefore: await readFile(cursorPath),
  };
}

function leaseTtlMs(lease: {
  readonly updated_at: string;
  readonly expires_at: string;
}): number {
  return Date.parse(lease.expires_at) - Date.parse(lease.updated_at);
}

async function joinCodexSession(
  project: string,
  nativeSessionId: string,
): Promise<void> {
  // The first session in a project creates the shared lane; later ones join
  // it (a `new` of an existing name is refused, a repeat `join` is idempotent).
  for (const prompt of ["$barbaro new lane", "$barbaro join lane"]) {
    await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId,
      event: "UserPromptSubmit",
      prompt,
    });
  }
}

function rollout(type: string, payload: unknown) {
  return { timestamp: "2026-08-16T10:00:00.000Z", type, payload };
}

async function writeGoalRolloverTrace(options: {
  readonly project: string;
  readonly nativeSessionId: string;
  readonly priorTurnId: string;
  readonly goalTurnId: string;
}): Promise<string> {
  const trace = join(
    options.project,
    `rollout-${options.nativeSessionId}-${options.goalTurnId}.jsonl`,
  );
  await writeFile(
    trace,
    [
      rollout("session_meta", {
        session_id: options.nativeSessionId,
        id: options.nativeSessionId,
        cwd: options.project,
        cli_version: "0.148.0-alpha.9",
        thread_source: "user",
      }),
      rollout("event_msg", {
        type: "task_started",
        turn_id: options.priorTurnId,
      }),
      rollout("event_msg", {
        type: "task_complete",
        turn_id: options.priorTurnId,
      }),
      rollout("event_msg", {
        type: "task_started",
        turn_id: options.goalTurnId,
      }),
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  return trace;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function readIngestAttemptJournal(
  path: string,
): Promise<BarbaroIngestAttemptJournalV2> {
  return JSON.parse(await readFile(path, "utf8")) as BarbaroIngestAttemptJournalV2;
}

function newestUnseenAttempt(
  journal: BarbaroIngestAttemptJournalV2,
  seen: ReadonlySet<string>,
  finished: boolean,
): BarbaroIngestAttemptV2 | undefined {
  return [...journal.attempts]
    .reverse()
    .find(
      (attempt) =>
        !seen.has(attempt.attempt_id) &&
        (attempt.finished_at !== undefined) === finished,
    );
}

function findIngestAttempt(
  journal: BarbaroIngestAttemptJournalV2,
  attemptId: string,
): BarbaroIngestAttemptV2 {
  const attempt = journal.attempts.find(
    (candidate) => candidate.attempt_id === attemptId,
  );
  assert.notEqual(attempt, undefined);
  return attempt!;
}
