import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { handleCodexHook } from "../../src/hooks/codex.js";
import { codexDeliveredText, literalForwardedExec, MAX_CODEX_DELIVERY_RECORD_BYTES, MAX_CODEX_DELIVERY_TRACE_BYTES, readCodexDeliveryTrace, type CodexDeliveryTrace } from "../../src/hooks/codex-read.js";
import { inspectUnreadPeerTurns } from "../../src/nudge/unread.js";
import { appendPeerTurn, currentWorkstreamId } from "./nudge-fixture.js";
import { readDeliveryHealth } from "../../src/reader/delivery-health.js";
import { createSessionId, createTurnId } from "../../src/core/id.js";
import { NudgeCursorStateStore } from "../../src/nudge/store.js";
import { InputLimitError } from "../../src/core/input-limit.js";

const fixtures = resolve("test/fixtures/hooks/codex-0.153.2");
const readFixture = async (name: string) => JSON.parse(await readFile(join(fixtures, name), "utf8"));
const SESSION = "codex-read-hook";
const TURN = "codex-read-turn";
const normalize = (text: string) => text.endsWith("\n") ? text.slice(0, -1) : text;

test("Codex 0.153.2 fixtures pin native completion and delayed model output separately", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barbaro-codex-capture-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const post = await readFixture("003.PostToolUse.json");
  assert.equal(typeof post.tool_response, "string");
  assert.equal(Object.hasOwn(post, "exit_code"), false);
  const map = (text: string) => text.replaceAll("$CAPTURE_ROOT/project", root);
  const tracePath = join(root, "trace.jsonl");
  const pending = { tool_use_id: post.tool_use_id, command: post.tool_input.command, output: normalize(post.tool_response) };
  await writeFile(tracePath, map(await readFile(join(fixtures, "003.PostToolUse.trace.jsonl"), "utf8")));
  let trace = await readCodexDeliveryTrace(tracePath, post.session_id, post.turn_id, root);
  assert.ok(trace);
  assert.equal(trace.rows.some((row) => row.kind === "execution" && row.id === post.tool_use_id), true);
  assert.equal(codexDeliveredText(trace, pending), undefined, "the model result is not yet in the PostToolUse snapshot");
  await writeFile(tracePath, map(await readFile(join(fixtures, "final.trace.jsonl"), "utf8")));
  trace = await readCodexDeliveryTrace(tracePath, post.session_id, post.turn_id, root);
  assert.ok(trace);
  assert.equal(codexDeliveredText(trace, pending), post.tool_response);
  for (const patch of [
    { id: "foreign-native" }, { exit_code: "0" }, { exit_code: 3 }, { status: "failed" },
    { source: "unified_exec_poll" }, { stderr: "error" }, { cwd: "file:///foreign" },
    { command: ["/bin/zsh", "-lc", "altered"] },
  ]) {
    const changed: CodexDeliveryTrace = { ...trace, rows: trace.rows.map((row) => row.kind === "execution" && row.id === pending.tool_use_id ? { ...row, ...patch } : row) };
    assert.equal(codexDeliveredText(changed, pending), undefined);
  }
  const duplicate = [...trace.rows];
  const nativeIndex = duplicate.findIndex((row) => row.kind === "execution" && row.id === pending.tool_use_id);
  duplicate.splice(nativeIndex, 0, duplicate[nativeIndex]!);
  assert.equal(codexDeliveredText({ ...trace, rows: duplicate }, pending), undefined, "ambiguous native completions cannot bind an outer call");
  for (const name of ["005.PostToolUse.json", "007.PostToolUse.json", "009.PostToolUse.json"]) {
    const call = await readFixture(name);
    const value = codexDeliveredText(trace, { tool_use_id: call.tool_use_id, command: call.tool_input.command,
      output: normalize(call.tool_response) });
    if (name.startsWith("005")) assert.equal(Buffer.byteLength(value!), 9000, "the core envelope ceiling remains independently necessary");
    else assert.equal(value, undefined, "truncated or failed output is not delivery");
  }
  await appendFile(tracePath, '{"partial":');
  assert.equal(await readCodexDeliveryTrace(tracePath, post.session_id, post.turn_id, root), undefined);
});

test("Codex only admits a whole literal forwarded exec expression", () => {
  const simple = 'text(await tools.exec_command({cmd:"barbaro read context",max_output_tokens:10000}));\n';
  assert.equal(literalForwardedExec(simple)?.cmd, "barbaro read context");
  for (const source of [
    simple + simple, `// ${simple}`, `if (true) ${simple}`, simple.replace("text(", "image("),
    simple.replace('cmd:"barbaro read context"', 'cmd:command'), simple.replace('max_output_tokens:10000', 'max_output_tokens:1+2'),
    simple.replace('max_output_tokens:10000', 'cmd:"altered"'), simple.replace('cmd:', '["cmd"]:'),
    simple.replace('max_output_tokens:10000', '...options'), 'const x = await tools.exec_command({cmd:"x"}); text(x.output);',
  ]) assert.equal(literalForwardedExec(source), undefined, source);
});

async function fixture(t: TestContext, peerCount = 1, producer = "0.153.2") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barbaro-codex-read-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracePath = join(root, "trace.jsonl");
  const row = (type: string, payload: object) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  const metadata = { turn_id: TURN };
  const actor = { session_id: SESSION, turn_id: TURN, cwd: root, transcript_path: tracePath };
  await writeFile(tracePath, row("session_meta", { id: SESSION, session_id: SESSION, cwd: root, cli_version: producer, history_mode: "paginated" }) +
    row("event_msg", { type: "task_started", turn_id: TURN }));
  await handleCodexHook({ ...actor, hook_event_name: "UserPromptSubmit", prompt: "$barbaro new delivery" });
  const workstreamId = await currentWorkstreamId(root, "codex", SESSION);
  for (let sequence = 1; sequence <= peerCount; sequence++) {
    await appendPeerTurn({ projectRoot: root, workstreamId, sequence, response: `Review ${sequence} delivered.` });
  }
  const unread = async () => {
    const result = await inspectUnreadPeerTurns({ projectRoot: root, provider: "codex", nativeSessionId: SESSION });
    assert.equal(result.status, "ready"); return result.unread_count;
  };
  const argv = ["read", "context", "--provider", "codex", "--session-id", SESSION, "--project-root", root];
  let command = `barbaro ${argv.map((arg) => `'${arg}'`).join(" ")}`;
  let toolUseId = "exec-test-native";
  let callId = "call-test-model";
  const call = { ...actor, tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command } };
  let source = `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:10000}));`;
  const open = async (input = source) => appendFile(tracePath, row("response_item", {
    type: "custom_tool_call", name: "exec", call_id: callId, input,
    internal_chat_message_metadata_passthrough: metadata,
  }));
  const run = async () => {
    const result = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), ...argv]);
    assert.equal(result.stderr, ""); return result.stdout;
  };
  const native = async (stdout: string, exitCode = 0) => appendFile(tracePath, row("event_msg", {
    type: "item_completed", thread_id: SESSION, turn_id: TURN, item: {
      type: "CommandExecution", id: toolUseId, command: ["/bin/zsh", "-lc", command],
      cwd: pathToFileURL(root).href, source: "unified_exec_startup", status: exitCode === 0 ? "completed" : "failed",
      stdout, stderr: "", aggregated_output: stdout, exit_code: exitCode,
    },
  }));
  const model = async (stdout: string, exitCode = 0) => appendFile(tracePath, row("response_item", {
    type: "custom_tool_call_output", call_id: callId, internal_chat_message_metadata_passthrough: metadata,
    output: [{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ chunk_id: "fixture", wall_time_seconds: 0.1, exit_code: exitCode, output: stdout }) }],
  }));
  const next = (sequence: number) => {
    toolUseId += "-next"; callId += "-next";
    argv.splice(0, argv.length, "read", "turn", "show", createTurnId("claude", "nudge-peer", "main", `peer-turn-${sequence}`),
      "--field", "response", "--provider", "codex", "--session-id", SESSION, "--project-root", root);
    command = `barbaro ${argv.map((arg) => `'${arg}'`).join(" ")}`;
    source = `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:10000}));`;
    call.tool_use_id = toolUseId; call.tool_input.command = command;
  };
  return { root, actor, call, open, run, native, model, unread, tracePath, next };
}

async function padNativeTrace(path: string, targetBytes = 65 * 1024 * 1024): Promise<void> {
  const row = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "capacity_padding", text } }) + "\n";
  const overhead = Buffer.byteLength(row(""));
  let remaining = targetBytes - (await stat(path)).size;
  while (remaining >= overhead) {
    const bytes = Math.min(1024 * 1024, remaining);
    await appendFile(path, row("x".repeat(bytes - overhead)));
    remaining -= bytes;
  }
  assert.equal(remaining, 0, "fixture padding ends on a complete record");
}

test("a Codex native trace above 64 MiB still requires and commits complete model delivery", async (t) => {
  const f = await fixture(t, 1, "0.153.3");
  await padNativeTrace(f.tracePath);
  assert.ok((await stat(f.tracePath)).size > 64 * 1024 * 1024);
  await f.open();
  await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
  const stdout = await f.run();
  assert.equal(JSON.parse(stdout).value.delivery.eligible, true);
  await f.native(stdout);
  await handleCodexHook({ ...f.call, hook_event_name: "PostToolUse", tool_response: stdout });
  assert.equal(await f.unread(), 1, "native success alone does not acknowledge");
  await f.model(stdout);
  const stopped = await handleCodexHook({ ...f.actor, hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(stopped.stop_reason, undefined);
  assert.equal(await f.unread(), 0);
  const health = await readDeliveryHealth(f.root, "codex", createSessionId("codex", SESSION), new Date());
  assert.equal(health.last_verified_delivery?.producer_version, "0.153.3");
});

test("large Codex native prefixes cannot hide malformed rows or duplicate identity", async (t) => {
  for (const kind of ["malformed", "duplicate-identity"] as const) await t.test(kind, async (t) => {
    const f = await fixture(t);
    const identity = (await readFile(f.tracePath, "utf8")).split("\n")[0]!;
    await appendFile(f.tracePath, kind === "malformed" ? "not-json\n" : identity + "\n");
    await padNativeTrace(f.tracePath);
    await f.open();
    assert.equal(await readCodexDeliveryTrace(f.tracePath, SESSION, TURN, f.root), undefined);
    assert.equal(await f.unread(), 1);
  });
});

test("Codex native limits preserve ordinary activity, staged reads, acknowledged history and sparse gaps", async (t) => {
  for (const stage of ["before-reservation", "already-staged"] as const) {
    for (const kind of ["file", "record"] as const) await t.test(`${stage}-${kind}`, async (t) => {
      const f = await fixture(t, 8, "0.153.3");
      const store = new NudgeCursorStateStore(f.root);
      const cursor = async () => {
        const state = await store.read("codex", createSessionId("codex", SESSION));
        assert.ok(state?.schema === "barbaro.nudge-cursor.v3"); return state;
      };
      // Deliver the newest five first, leaving three older gaps and actual
      // sparse coverage. The next invocation targets one of those older gaps.
      await f.open();
      await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
      let stdout = await f.run(); await f.native(stdout);
      await handleCodexHook({ ...f.call, hook_event_name: "PostToolUse", tool_response: stdout });
      await f.model(stdout);
      await handleCodexHook({ ...f.actor, hook_event_name: "PreToolUse", tool_name: "Bash",
        tool_use_id: "continue-after-model", tool_input: { command: "pwd" } });
      assert.equal(await f.unread(), 3);
      assert.ok((await cursor()).reads.coverage.length > 0);
      f.next(1); await f.open();
      if (stage === "already-staged") {
        await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
        stdout = await f.run(); await f.native(stdout);
        await handleCodexHook({ ...f.call, hook_event_name: "PostToolUse", tool_response: stdout });
        assert.equal((await cursor()).reads.pending.length, 1);
        await f.model(stdout);
      }
      const before = await cursor();
      if (kind === "file") await truncate(f.tracePath, MAX_CODEX_DELIVERY_TRACE_BYTES + 1);
      else await appendFile(f.tracePath, JSON.stringify({ type: "padding", payload: { text: "x".repeat(MAX_CODEX_DELIVERY_RECORD_BYTES) } }) + "\n");
      const result = await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
      assert.equal(typeof result.active_revision, "number", "resource refusal cannot abort ordinary hook activity");
      const after = await cursor();
      assert.equal(after.cursor_revision, before.cursor_revision);
      assert.deepEqual(after.feed_cursors, before.feed_cursors);
      assert.deepEqual(after.reads.coverage, before.reads.coverage);
      assert.deepEqual(after.reads.pending, before.reads.pending);
      assert.equal(await f.unread(), 3);
      const health = await readDeliveryHealth(f.root, "codex", createSessionId("codex", SESSION), new Date());
      assert.equal(health.latest_observation?.reason, "native_trace_limit");
      const limit = health.latest_observation!.native_trace_limit!;
      assert.equal(limit.kind, kind);
      assert.equal(limit.maximum_bytes, kind === "file" ? MAX_CODEX_DELIVERY_TRACE_BYTES : MAX_CODEX_DELIVERY_RECORD_BYTES);
      assert.ok(limit.observed_bytes > limit.maximum_bytes);
      if (kind === "file") assert.equal(limit.observed_bytes, MAX_CODEX_DELIVERY_TRACE_BYTES + 1);
      // The already verified earlier delivery remains in diagnostic history.
      assert.equal(health.last_verified_delivery?.state, "committed");
    });
  }
});

test("Codex accepts exactly the native file bound and reports the first excess byte", async (t) => {
  const f = await fixture(t);
  await f.open(); await padNativeTrace(f.tracePath, MAX_CODEX_DELIVERY_TRACE_BYTES);
  await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
  assert.equal(JSON.parse(await f.run()).value.delivery.eligible, true);
  await appendFile(f.tracePath, "\n");
  await assert.rejects(readCodexDeliveryTrace(f.tracePath, SESSION, TURN, f.root), (error: unknown) =>
    error instanceof InputLimitError && error.kind === "file" &&
    error.maximumBytes === MAX_CODEX_DELIVERY_TRACE_BYTES && error.observedBytes === MAX_CODEX_DELIVERY_TRACE_BYTES + 1);
  assert.equal(await f.unread(), 1);
});

test("Codex retains the exact native record bound and reports observed excess bytes", async (t) => {
  const f = await fixture(t);
  const row = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "capacity_padding", text } });
  const text = "x".repeat(MAX_CODEX_DELIVERY_RECORD_BYTES - Buffer.byteLength(row("")));
  await appendFile(f.tracePath, row(text) + "\n");
  assert.ok(await readCodexDeliveryTrace(f.tracePath, SESSION, TURN, f.root));
  await appendFile(f.tracePath, row(text + "x") + "\n");
  await assert.rejects(readCodexDeliveryTrace(f.tracePath, SESSION, TURN, f.root), (error: unknown) =>
    error instanceof InputLimitError && error.kind === "record" &&
    error.maximumBytes === MAX_CODEX_DELIVERY_RECORD_BYTES && error.observedBytes === MAX_CODEX_DELIVERY_RECORD_BYTES + 1);
  assert.equal(await f.unread(), 1);
});

test("Codex supported producers preserve their exact version through staging and verified model delivery", async (t) => {
  for (const producer of ["0.153.2", "0.153.3"] as const) {
    await t.test(producer, async (t) => {
      const f = await fixture(t, 1, producer);
      const health = () => readDeliveryHealth(f.root, "codex", createSessionId("codex", SESSION), new Date());
      await f.open();
      await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
      assert.equal((await health()).latest_observation?.producer_version, producer);
      const stdout = await f.run();
      assert.equal(JSON.parse(stdout).value.delivery.eligible, true);
      await f.native(stdout);
      await handleCodexHook({ ...f.call, hook_event_name: "PostToolUse", tool_response: stdout });
      assert.equal(await f.unread(), 1);
      assert.equal((await health()).latest_observation?.state, "staged");
      assert.equal((await health()).latest_observation?.producer_version, producer);
      await f.model(stdout);
      const stop = await handleCodexHook({ ...f.actor, hook_event_name: "Stop", stop_hook_active: false });
      assert.equal(stop.stop_reason, undefined);
      assert.equal(await f.unread(), 0);
      assert.equal((await health()).last_verified_delivery?.state, "committed");
      assert.equal((await health()).last_verified_delivery?.producer_version, producer);
      assert.equal((await health()).last_verified_delivery?.adapter, `codex-${producer}-literal-exec`);
    });
  }
});

test("Codex unknown or non-exact producer versions remain unsupported and never reserve or acknowledge", async (t) => {
  for (const producer of ["0.153.4", "0.999.0", "0.153.3 ", "v0.153.3", "0.153.3-beta"]) {
    await t.test(producer, async (t) => {
      const f = await fixture(t, 1, producer);
      await f.open();
      await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
      assert.equal(JSON.parse(await f.run()).value.delivery.eligible, false);
      const health = await readDeliveryHealth(f.root, "codex", createSessionId("codex", SESSION), new Date());
      assert.equal(health.latest_observation?.reason, "unsupported_producer_or_shape");
      assert.equal(health.last_verified_delivery, undefined);
      assert.equal(await f.unread(), 1);
    });
  }
});

test("Codex partial context delivery preserves eight-turn history gaps and suppresses same-turn Stop", async (t) => {
  const f = await fixture(t, 8);
  await f.open();
  await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
  const stdout = await f.run();
  const output = JSON.parse(stdout);
  assert.equal(output.value.delivery.eligible, true);
  const delivered = output.value.delivery.coverage.length;
  assert.equal(delivered, 5);
  await f.native(stdout);
  await handleCodexHook({ ...f.call, hook_event_name: "PostToolUse", tool_response: stdout });
  assert.equal(await f.unread(), 8);
  await f.model(stdout);
  const stop = await handleCodexHook({ ...f.actor, hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(stop.stop_reason, undefined);
  assert.equal(await f.unread(), 3);
});

test("Codex native failure, truncated model text, and unknown wrappers remain unread", async (t) => {
  for (const mode of ["failure", "truncation", "wrapper"] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      await f.open(mode === "wrapper" ? 'text((await tools.exec_command({cmd:"x"})).output)' : undefined);
      await handleCodexHook({ ...f.call, hook_event_name: "PreToolUse" });
      const stdout = await f.run();
      assert.equal(JSON.parse(stdout).value.delivery.eligible, mode !== "wrapper");
      await f.native(stdout, mode === "failure" ? 3 : 0);
      await handleCodexHook({ ...f.call, hook_event_name: "PostToolUse", tool_response: stdout });
      await f.model(mode === "truncation" ? stdout.slice(0, -20) : stdout, mode === "failure" ? 3 : 0);
      await handleCodexHook({ ...f.actor, hook_event_name: "Stop", stop_hook_active: false });
      assert.equal(await f.unread(), 1);
    });
  }
});

test("sanitized desktop 0.153.3 transport fixture pins the exact producer and native/model shape without inventing a receipt", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "barbaro-desktop-capture-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = resolve("test/fixtures/hooks/codex-0.153.3");
  const path = join(root, "trace.jsonl");
  const mapped = async (name: string) => (await readFile(join(directory, name), "utf8")).replaceAll("$CAPTURE_ROOT/project", root);
  const final = await mapped("final.trace.jsonl");
  const rows = final.trimEnd().split("\n").map((line) => JSON.parse(line));
  const session = rows[0].payload.session_id as string;
  const turn = rows[1].payload.internal_chat_message_metadata_passthrough.turn_id as string;
  const native = rows[2].payload.item;
  const command = literalForwardedExec(rows[1].payload.input)!.cmd as string;
  const pending = { tool_use_id: native.id, command, output: normalize(native.stdout) };
  await writeFile(path, await mapped("pre.reconstructed.trace.jsonl"));
  let trace = await readCodexDeliveryTrace(path, session, turn, root);
  assert.ok(trace);
  assert.equal(trace.producerVersion, "0.153.3");
  assert.equal(trace.rows.length, 1, "prefix is reconstructed and proves only open-call shape");
  assert.equal(codexDeliveredText(trace, pending), undefined);
  await writeFile(path, final);
  trace = await readCodexDeliveryTrace(path, session, turn, root);
  assert.ok(trace);
  assert.equal(trace.producerVersion, "0.153.3");
  assert.equal(codexDeliveredText(trace, pending), native.stdout);
  assert.equal(JSON.parse(native.stdout).value.delivery.eligible, false, "synthetic observer text is not a receipt");
  for (const patch of [{ exit_code: 3 }, { source: "unified_exec_poll" }, { stdout: "altered" }, { cwd: "file:///foreign" }]) {
    const changed: CodexDeliveryTrace = { ...trace, rows: trace.rows.map((row) => row.kind === "execution" ? { ...row, ...patch } : row) };
    assert.equal(codexDeliveredText(changed, pending), undefined);
  }
  for (const output of [rows[3].payload.output.slice(1), [{ type: "input_text", text: native.stdout }]]) {
    const changed: CodexDeliveryTrace = { ...trace, rows: trace.rows.map((row) => row.type === "custom_tool_call_output" ? { ...row, output } : row) };
    assert.equal(codexDeliveredText(changed, pending), undefined);
  }
});
