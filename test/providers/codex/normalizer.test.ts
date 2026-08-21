import assert from "node:assert/strict";
import test from "node:test";

import { createSessionId, createTurnId } from "../../../src/core/id.js";
import {
  CodexTurnNormalizer,
  decodeCodexEnvelope,
  extractExecCommands,
  isCodexInjectedText,
} from "../../../src/providers/codex/index.js";

const TRACE_ID = "codex:thread-native";
const TRACE_PATH = "/traces/rollout-thread-native.jsonl";
const SESSION_NATIVE = "session-native";
const TURN_NATIVE = "turn-native";

function source(lineNumber: number) {
  return { traceId: TRACE_ID, tracePath: TRACE_PATH, lineNumber };
}

function line(timestamp: string, type: string, payload: unknown) {
  return { timestamp, type, payload };
}

function bootstrap(normalizer: CodexTurnNormalizer): void {
  normalizer.accept(
    line("2026-08-16T10:00:00.000Z", "session_meta", {
      session_id: SESSION_NATIVE,
      id: SESSION_NATIVE,
      cwd: "/repo",
      cli_version: "0.148.0-alpha.9",
      thread_source: "user",
    }),
    source(1),
  );
  normalizer.accept(
    line("2026-08-16T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: TURN_NATIVE,
    }),
    source(2),
  );
}

test("normalizes one complete Codex turn from canonical durable records", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);

  normalizer.accept(
    line("2026-08-16T10:00:01.100Z", "response_item", {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "<environment_context>noise</environment_context>" },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_NATIVE },
    }),
    source(3),
  );
  normalizer.accept(
    line("2026-08-16T10:00:01.200Z", "event_msg", {
      type: "user_message",
      message: "Fix the writer race.",
    }),
    source(4),
  );
  normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "response_item", {
      type: "custom_tool_call",
      call_id: "call-test",
      name: "exec",
      input:
        'const r = await tools.exec_command({"cmd":"npm test","workdir":"/repo"}); text(r.output);',
      internal_chat_message_metadata_passthrough: { turn_id: TURN_NATIVE },
    }),
    source(5),
  );
  normalizer.accept(
    line("2026-08-16T10:00:03.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "call-test",
      output: [{ type: "input_text", text: "all tests passed" }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_NATIVE },
    }),
    source(6),
  );
  normalizer.accept(
    line("2026-08-16T10:00:04.000Z", "event_msg", {
      type: "patch_apply_end",
      turn_id: TURN_NATIVE,
      call_id: "patch-1",
      success: true,
      changes: {
        "/repo/src/writer.ts": { type: "add", content: "one\ntwo\n" },
        "/repo/.barbaro/feed/codex/generated.jsonl": { type: "add", content: "echo\n" },
        "/outside/secret.txt": { type: "add", content: "no\n" },
      },
    }),
    source(7),
  );

  const firstAgent = normalizer.accept(
    line("2026-08-16T10:00:05.000Z", "event_msg", {
      type: "sub_agent_activity",
      event_id: "agent-event-1",
      agent_thread_id: "child-thread",
      agent_path: "/root/explorer",
      kind: "started",
    }),
    source(8),
  );
  assert.equal(firstAgent.evidence.length, 0);

  normalizer.accept(
    line("2026-08-16T10:00:05.100Z", "event_msg", {
      type: "sub_agent_activity",
      event_id: "agent-event-2",
      agent_thread_id: "child-thread",
      agent_path: "/root/explorer",
      kind: "interacted",
    }),
    source(9),
  );
  const commentary = normalizer.accept(
    line("2026-08-16T10:00:06.000Z", "event_msg", {
      type: "agent_message",
      phase: "commentary",
      message: "I am checking the writer now.",
    }),
    source(10),
  );
  assert.equal(commentary.evidence.length, 0);

  const terminal = normalizer.accept(
    line("2026-08-16T10:00:07.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Fixed the writer and tests pass.",
      error: null,
    }),
    source(11),
  );

  assert.equal(terminal.turns.length, 1);
  assert.equal(terminal.evidence.length, 1);
  const activity = terminal.evidence[0];
  assert.ok(activity && activity.kind === "provider_event");
  assert.equal(activity.content.event, "subagent_activity_rollup");
  assert.equal(activity.content.activity_count, 2);
  const turn = terminal.turns[0]!;
  assert.equal(turn.session_id, createSessionId("codex", SESSION_NATIVE));
  assert.equal(
    turn.turn_id,
    createTurnId("codex", SESSION_NATIVE, "main", TURN_NATIVE),
  );
  assert.equal(turn.request.text, "Fix the writer race.");
  assert.equal(turn.response?.text, "Fixed the writer and tests pass.");
  assert.equal(turn.outcome, "success");
  assert.equal(turn.actions.length, 2);
  assert.equal(turn.actions[0]?.kind, "test");
  assert.equal(turn.actions[1]?.kind, "file_change");
  if (turn.actions[1]?.kind === "file_change") {
    assert.equal(turn.actions[1].path, "src/writer.ts");
    assert.equal(turn.actions[1].added_lines, 2);
  }
  assert.equal(turn.subagents.total, 1);
  assert.deepEqual(turn.subagents.by_role, [{ role: "explorer", count: 1 }]);
  assert.deepEqual(turn.subagents.outcomes, { unknown: 1 });
  assert.equal(turn.source_refs[0]?.line_start, 2);
  assert.equal(turn.source_refs[0]?.line_end, 11);
});

test("canonical subagent roles and diagnostics use UTF-16 code-unit order", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  for (const [index, role] of ["\u00E9", "z", "\u{1F600}", "\u{10000}"].entries()) {
    normalizer.accept(
      line(`2026-08-16T10:00:0${index + 2}.000Z`, "event_msg", {
        type: "sub_agent_activity",
        event_id: `agent-event-${index}`,
        agent_thread_id: `child-${index}`,
        agent_path: `/root/${role}`,
        kind: "started",
      }),
      source(index + 3),
    );
  }
  for (const [index, type] of ["\u00E9-event", "z-event", "\u{1F600}-event"].entries()) {
    normalizer.accept(
      line(`2026-08-16T10:00:1${index}.000Z`, "event_msg", { type }),
      source(index + 7),
    );
  }
  const terminal = normalizer.accept(
    line("2026-08-16T10:00:20.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Done.",
    }),
    source(10),
  );

  assert.deepEqual(
    terminal.turns[0]?.subagents.by_role.map(({ role }) => role),
    ["z", "\u00E9", "\u{10000}", "\u{1F600}"],
  );
  assert.deepEqual(Object.keys(normalizer.diagnostics().unknown_event_types), [
    "z-event",
    "\u00E9-event",
    "\u{1F600}-event",
  ]);
});

test("first session_meta stays canonical and drift is counted", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  normalizer.accept(
    line("2026-08-16T10:00:01.050Z", "session_meta", {
      session_id: "different-session",
      id: "fork-window-id",
      cwd: "/wrong",
      cli_version: "future",
    }),
    source(3),
  );
  const result = normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Done.",
    }),
    source(4),
  );
  assert.equal(result.turns[0]?.session_id, createSessionId("codex", SESSION_NATIVE));
  assert.equal(normalizer.diagnostics().repeated_session_meta, 1);
});

test("session-scoped durable events are not diagnosed as orphan turns", () => {
  const normalizer = new CodexTurnNormalizer();
  normalizer.accept(
    line("2026-08-16T10:00:00.000Z", "session_meta", {
      session_id: SESSION_NATIVE,
      id: SESSION_NATIVE,
      cwd: "/repo",
      cli_version: "0.148.0-alpha.9",
    }),
    source(1),
  );
  for (const [index, type] of [
    "thread_settings_applied",
    "thread_goal_updated",
    "thread_rolled_back",
  ].entries()) {
    normalizer.accept(
      line(`2026-08-16T10:00:0${index + 1}.000Z`, "event_msg", { type }),
      source(index + 2),
    );
  }
  assert.equal(normalizer.diagnostics().orphan_turn_records, 0);
});

test("unknown root and nested types stay raw-only while diagnostics survive", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  const unknownRoot = normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "future_outer", { answer: 42 }),
    source(3),
  );
  const unknownEvent = normalizer.accept(
    line("2026-08-16T10:00:03.000Z", "event_msg", {
      type: "future_event",
      turn_id: TURN_NATIVE,
      arbitrary: true,
    }),
    source(4),
  );
  const unknownResponse = normalizer.accept(
    line("2026-08-16T10:00:04.000Z", "response_item", {
      type: "future_response",
      internal_chat_message_metadata_passthrough: { turn_id: TURN_NATIVE },
    }),
    source(5),
  );

  assert.equal(unknownRoot.evidence.length, 0);
  assert.equal(unknownEvent.evidence.length, 0);
  assert.equal(unknownResponse.evidence.length, 0);
  assert.deepEqual(normalizer.diagnostics().unknown_root_types, { future_outer: 1 });
  assert.deepEqual(normalizer.diagnostics().unknown_event_types, { future_event: 1 });
  assert.deepEqual(normalizer.diagnostics().unknown_response_types, { future_response: 1 });
});

test("turn_aborted is terminal without inventing a response", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  const result = normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "event_msg", {
      type: "turn_aborted",
      turn_id: TURN_NATIVE,
      reason: "user interrupted",
    }),
    source(3),
  );
  assert.equal(result.turns[0]?.outcome, "cancelled");
  assert.equal(result.turns[0]?.response, undefined);
});

test("accepts the legacy turn_started and turn_complete wire aliases", () => {
  const normalizer = new CodexTurnNormalizer();
  normalizer.accept(
    line("2026-08-16T10:00:00.000Z", "session_meta", {
      session_id: SESSION_NATIVE,
      id: SESSION_NATIVE,
      cwd: "/repo",
      cli_version: "0.148.0-alpha.9",
    }),
    source(1),
  );
  normalizer.accept(
    line("2026-08-16T10:00:01.000Z", "event_msg", {
      type: "turn_started",
      turn_id: TURN_NATIVE,
    }),
    source(2),
  );
  normalizer.accept(
    line("2026-08-16T10:00:01.100Z", "event_msg", {
      type: "user_message",
      message: "Alias request",
    }),
    source(3),
  );
  const result = normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "event_msg", {
      type: "turn_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Alias response",
    }),
    source(4),
  );
  assert.equal(result.turns[0]?.outcome, "success");
  assert.equal(result.turns[0]?.response?.text, "Alias response");
  assert.equal(result.turns[0]?.extensions?.codex?.terminal_event, "turn_complete");
});

test("collapses cumulative token_count updates to one terminal usage record", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  for (const [index, total] of [100, 200].entries()) {
    const batch = normalizer.accept(
      line(`2026-08-16T10:00:0${index + 2}.000Z`, "event_msg", {
        type: "token_count",
        info: { total_token_usage: { total_tokens: total } },
      }),
      source(index + 3),
    );
    assert.equal(batch.evidence.length, 0);
  }
  const terminal = normalizer.accept(
    line("2026-08-16T10:00:04.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Done.",
    }),
    source(5),
  );
  assert.equal(terminal.evidence.length, 1);
  assert.equal(terminal.evidence[0]?.kind, "usage");
  assert.deepEqual(terminal.evidence[0]?.content.info, {
    total_token_usage: { total_tokens: 200 },
  });
  assert.equal(terminal.turns[0]?.evidence_refs.length, 1);
});

test("derives line deltas from durable patch_apply_end unified diffs", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "event_msg", {
      type: "patch_apply_end",
      turn_id: TURN_NATIVE,
      call_id: "patch-diff",
      success: true,
      changes: {
        "/repo/src/example.ts": {
          type: "update",
          unified_diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n keep\n",
        },
      },
    }),
    source(3),
  );
  const terminal = normalizer.accept(
    line("2026-08-16T10:00:03.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Patched.",
    }),
    source(4),
  );
  const action = terminal.turns[0]?.actions[0];
  assert.equal(action?.kind, "file_change");
  if (action?.kind === "file_change") {
    assert.equal(action.path, "src/example.ts");
    assert.equal(action.added_lines, 2);
    assert.equal(action.removed_lines, 1);
  }
});

test("uses pinned MCP and image terminal shapes for action outcomes", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "event_msg", {
      type: "mcp_tool_call_end",
      call_id: "mcp-err",
      invocation: { server: "calendar", tool: "lookup", arguments: {} },
      duration: { secs: 0, nanos: 10 },
      result: { Err: "Bearer sk-secret-token was rejected" },
    }),
    source(3),
  );
  normalizer.accept(
    line("2026-08-16T10:00:02.100Z", "event_msg", {
      type: "mcp_tool_call_end",
      call_id: "mcp-is-error",
      invocation: { server: "database", tool: "query", arguments: {} },
      duration: { secs: 0, nanos: 10 },
      result: {
        Ok: {
          content: [{ type: "text", text: "query failed" }],
          is_error: true,
        },
      },
    }),
    source(4),
  );
  normalizer.accept(
    line("2026-08-16T10:00:02.200Z", "event_msg", {
      type: "image_generation_end",
      call_id: "image-failed",
      status: "failed",
      result: "",
      failure: { type: "usageLimitExceeded", limitId: "image_gen" },
    }),
    source(5),
  );
  normalizer.accept(
    line("2026-08-16T10:00:02.300Z", "event_msg", {
      type: "web_search_end",
      call_id: "search-complete",
      query: "Barbaro",
      action: { type: "search" },
    }),
    source(6),
  );
  const terminal = normalizer.accept(
    line("2026-08-16T10:00:03.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Checked the tools.",
    }),
    source(7),
  );

  const actions = terminal.turns[0]?.actions ?? [];
  assert.deepEqual(
    actions.map((action) => [
      action.kind === "tool" ? action.tool_name : action.kind,
      action.outcome,
    ]),
    [
      ["calendar.lookup", "failed"],
      ["database.query", "failed"],
      ["image_generation", "failed"],
      ["web_search", "success"],
    ],
  );
  const first = actions[0];
  assert.equal(first?.kind, "tool");
  if (first?.kind === "tool") {
    assert.doesNotMatch(first.summary?.text ?? "", /sk-secret-token/);
    assert.equal(first.summary?.redactions.length, 1);
  }
});

test("does not echo read-only observation of generated Barbaro context", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  normalizer.accept(
    line("2026-08-16T10:00:02.000Z", "response_item", {
      type: "custom_tool_call",
      id: "observe-call",
      call_id: "observe",
      name: "exec",
      input: 'await tools.exec_command({"cmd":"rg --files .barbaro/feed"});',
    }),
    source(3),
  );
  normalizer.accept(
    line("2026-08-16T10:00:02.100Z", "response_item", {
      type: "custom_tool_call_output",
      id: "observe-output",
      call_id: "observe",
      output: "feed.jsonl",
    }),
    source(4),
  );
  const terminal = normalizer.accept(
    line("2026-08-16T10:00:03.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Caught up.",
    }),
    source(5),
  );
  assert.deepEqual(terminal.turns[0]?.actions, []);
});

test("normalizer snapshots resume an in-flight turn without replaying prior lines", () => {
  const first = new CodexTurnNormalizer();
  bootstrap(first);
  first.accept(
    line("2026-08-16T10:00:01.200Z", "event_msg", {
      type: "user_message",
      message: "Resume me.",
    }),
    source(3),
  );
  const resumed = CodexTurnNormalizer.restore(first.snapshot());
  const result = resumed.accept(
    line("2026-08-16T10:00:02.000Z", "event_msg", {
      type: "task_complete",
      turn_id: TURN_NATIVE,
      last_agent_message: "Resumed.",
    }),
    source(4),
  );
  assert.equal(result.turns[0]?.sequence, 1);
  assert.equal(result.turns[0]?.request.text, "Resume me.");
  assert.equal(result.turns[0]?.response?.text, "Resumed.");
  assert.equal(resumed.snapshot().turns.length, 0);
});

test("normalizer restore rejects tampered derived identities", () => {
  const normalizer = new CodexTurnNormalizer();
  bootstrap(normalizer);
  const state = structuredClone(normalizer.snapshot()) as unknown as {
    session: { barbaroSessionId: string };
  };
  state.session.barbaroSessionId = "ses_00000000000000000000000000000000";
  assert.throws(
    () => CodexTurnNormalizer.restore(state as never),
    /does not match its native identity/,
  );
});

test("outer envelope remains permissive while diagnosing structural corruption", () => {
  const future = decodeCodexEnvelope({
    timestamp: "2026-08-16T10:00:00.000Z",
    ordinal: 8,
    type: "future",
    payload: null,
    metadata: { client_authored: true },
    later: "preserved",
  });
  assert.equal(future.ok, true);
  if (future.ok) assert.deepEqual(future.envelope.extra, { later: "preserved" });
  assert.equal(decodeCodexEnvelope({ type: "event_msg", payload: {} }).ok, false);
  assert.equal(
    decodeCodexEnvelope({ timestamp: "not-a-time", type: "event_msg", payload: {} }).ok,
    false,
  );
});

test("custom exec extraction never evaluates JavaScript and accepts strict JSON only", () => {
  const sourceText = [
    'await tools.exec_command({"cmd":"npm test","workdir":"/repo"});',
    'await tools.exec_command({"cmd":"printf \\\"{ok}\\\""});',
    "await tools.exec_command(args);",
  ].join("\n");
  assert.deepEqual(extractExecCommands(sourceText), [
    { command: "npm test", occurrence: 0 },
    { command: 'printf "{ok}"', occurrence: 1 },
  ]);
});

test("only structurally recognized Codex injection blocks are removed", () => {
  assert.equal(
    isCodexInjectedText("<recommended_plugins>generated</recommended_plugins>"),
    true,
  );
  assert.equal(
    isCodexInjectedText("please fix the <environment_context> parser"),
    false,
  );
});
