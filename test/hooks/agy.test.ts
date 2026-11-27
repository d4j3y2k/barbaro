import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ActiveLeaseStore } from "../../src/active/index.js";
import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { createSessionId, createTurnId } from "../../src/core/id.js";
import { handleAgyHook } from "../../src/hooks/agy.js";
import { readDeliveryHealth } from "../../src/reader/delivery-health.js";
import { inspectUnreadPeerTurns } from "../../src/nudge/unread.js";
import { appendPeerTurn, currentWorkstreamId } from "./nudge-fixture.js";

const id = "276fa98e-b017-4fde-a53c-02ae4436ef79";
const session_id = createSessionId("agy", id);
const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
const run = promisify(execFile);

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "barbaro-agy-hooks-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "project"), cwd = join(root, "nested"), brainRoot = join(dir, "brain");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, ".git"));
  const trace = join(brainRoot, id, ".system_generated", "logs", "transcript_full.jsonl");
  await mkdir(dirname(trace), { recursive: true });
  let index = 0, prompt = "", invocation = 0;
  async function row(type: string, properties: Record<string, unknown>, source = "MODEL") {
    const step = index++;
    await appendFile(trace, JSON.stringify({ step_index: step, created_at: "2026-09-05T10:00:00Z",
      type, status: "DONE", source, ...properties }) + "\n");
    return step;
  }
  async function user(text: string) {
    prompt = text;
    invocation = 0;
    return row("USER_INPUT", { content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>PRIVATE METADATA</ADDITIONAL_METADATA>` }, "USER_EXPLICIT");
  }
  const hook = (event: string, extra: Record<string, unknown> = {}) => handleAgyHook(event, {
    hookEventName: event, conversationId: id, cwd, workspacePaths: [cwd], lastUserInput: prompt,
    transcriptPath: trace, invocationNum: invocation, initialNumSteps: index, ...extra,
  }, { brainRoot });
  const invoke = async () => { const response = await hook("PreInvocation"); invocation++; return response; };
  const stop = (extra: Record<string, unknown> = {}) => hook("Stop", {
    fullyIdle: true, continuationActive: false, terminationReason: "NO_TOOL_CALL", ...extra });
  const feed = async () => (await readFile(join(root, ".barbaro", "feed", "agy", session_id + ".jsonl"), "utf8"))
    .trimEnd().split("\n").map((line): BarbaroTurnV1 => JSON.parse(line));
  const active = () => new ActiveLeaseStore(join(root, ".barbaro", "active")).readSnapshot({ provider: "agy", session_id, agent_id: "main" });
  return { root, cwd, brainRoot, trace, user, row, hook, invoke, stop, feed, active };
}

test("native Antigravity hooks publish only consented turns once, preserve full final text, and release claims", async (t) => {
  const f = await fixture(t);
  await f.user("PRIVATE OLD REQUEST");
  assert.deepEqual(await f.invoke(), {});
  await f.row("PLANNER_RESPONSE", { content: "PRIVATE OLD RESPONSE" });
  assert.deepEqual(await f.stop(), {});
  await assert.rejects(readFile(join(f.root, ".barbaro")), { code: "ENOENT" });
  const joinedStep = await f.user("$barbaro new incoming");
  assert.match(JSON.stringify(await f.invoke()), /created and joined/);
  assert.deepEqual(await f.hook("PreInvocation", { invocationNum: 0 }), {});
  const tool = { name: "edit_file", args: { Path: "notes.txt", Replacement: "PRIVATE PAYLOAD" } };
  const call = await f.row("PLANNER_RESPONSE", { tool_calls: [tool], content: "working", thinking: "PRIVATE REASONING" });
  assert.deepEqual(await f.hook("PreToolUse", { toolCall: tool, stepIdx: call + 1 }), { decision: "allow" });
  assert.deepEqual((await f.active())?.claims, [{ mode: "write", confidence: "exact", path: "nested/notes.txt" }]);
  await f.hook("PostToolUse", { toolCall: tool, stepIdx: call + 1, error: "" });
  assert.deepEqual((await f.active())?.claims, []);
  await f.row("GENERIC", { content: "PRIVATE TOOL STDOUT" });
  await f.invoke();
  const answer = "Complete answer ".repeat(120);
  await f.row("PLANNER_RESPONSE", { content: answer });
  await writeFile(f.trace.replace("_full", ""), '{"content":"truncated preview"}\n');
  await f.stop({ fullyIdle: false });
  await assert.rejects(f.feed(), { code: "ENOENT" });
  await Promise.all([f.stop(), f.stop()]);
  const [turn, ...remaining] = await f.feed();
  assert.equal(remaining.length, 0);
  assert.equal(turn?.turn_id, createTurnId("agy", id, "main", String(joinedStep)));
  assert.equal(turn?.response?.text, answer);
  assert.deepEqual(turn?.actions.map((a) => a.kind), ["file_change"]);
  assert.doesNotMatch(JSON.stringify(turn), /PRIVATE/);
  assert.equal((await f.active())?.state, "idle");
  await f.invoke();
  assert.equal((await f.active())?.state, "idle");
});

test("parallel native edit calls release only the completed path", async (t) => {
  const f = await fixture(t);
  await f.user("$barbaro new parallel");
  await f.invoke();
  const [a, b] = ["one.ts", "two.ts"].map((name) => ({ name: "write_file", args: { Path: join(f.root, name) } }));
  const call = await f.row("PLANNER_RESPONSE", { tool_calls: [a, b] });
  await f.hook("PreToolUse", { stepIdx: call + 1, toolCall: a });
  await f.hook("PreToolUse", { stepIdx: call + 2, toolCall: b });
  assert.deepEqual((await f.active())?.claims.map((claim) => claim.path), ["one.ts", "two.ts"]);
  await f.hook("PostToolUse", { stepIdx: call + 1, toolCall: a });
  assert.deepEqual((await f.active())?.claims.map((claim) => claim.path), ["two.ts"]);
  await f.hook("PostToolUse", { stepIdx: call + 2, toolCall: b });
  assert.deepEqual((await f.active())?.claims, []);
});

test("a later prompt recovers a missed Stop under its original membership and errors never reuse an older reply", async (t) => {
  const f = await fixture(t);
  await f.user("$barbaro new alpha");
  await f.invoke();
  await f.row("PLANNER_RESPONSE", { content: "alpha result" });
  await f.user("$barbaro new beta");
  await f.invoke();
  assert.equal((await f.feed())[0]?.response?.text, "alpha result");
  await f.row("PLANNER_RESPONSE", { content: "a progress update", tool_calls: [{ name: "view_file", args: {} }] });
  await f.row("GENERIC", { content: "Error in tool", status: "ERROR" });
  await f.stop({ terminationReason: "ERROR" });
  const [one, two] = await f.feed();
  assert.notEqual(one?.workstream_id, two?.workstream_id);
  assert.equal(two?.outcome, "failed");
  assert.equal(two?.response, undefined);
});

test("rewinding the native trace after the idle lease is reaped cannot expose pre-consent turns", async (t) => {
  const f = await fixture(t);
  await f.user("private in the enrollment second");
  await f.row("PLANNER_RESPONSE", { content: "unshared" });
  const beforeJoin = await readFile(f.trace, "utf8");
  await f.user("$barbaro new fresh");
  await f.invoke();
  await f.row("PLANNER_RESPONSE", { content: "shared" });
  await f.stop();
  const leases = new ActiveLeaseStore(join(f.root, ".barbaro", "active"));
  await rm(leases.actorPath({ provider: "agy", session_id, agent_id: "main" }));
  for (const historical of [beforeJoin, beforeJoin.replaceAll("2026-09-05", "2026-09-04")]) {
    await writeFile(f.trace, historical);
    const stale = { lastUserInput: "private in the enrollment second", invocationNum: 0, initialNumSteps: 1 };
    assert.deepEqual(await f.hook("PreInvocation", stale), {});
    await f.stop(stale);
    assert.equal(await f.active(), undefined);
    assert.deepEqual((await f.feed()).map((turn) => turn.response?.text), ["shared"]);
  }
});

test("foreign workspace or conversation files cannot enroll an Antigravity session", async (t) => {
  const f = await fixture(t);
  await f.user("$barbaro new alpha");
  for (const extra of [{ cwd: f.brainRoot }, { workspacePaths: [] }, { transcriptPath: join(f.brainRoot, "other.jsonl") },
    { conversationId: "../project" }, { lastUserInput: "$barbaro new forged" }]) {
    assert.deepEqual(await f.hook("PreInvocation", extra), {});
  }
  await assert.rejects(readFile(join(f.root, ".barbaro")), { code: "ENOENT" });
  const elsewhere = join(f.root, "foreign.jsonl");
  await writeFile(elsewhere, await readFile(f.trace));
  await rm(f.trace);
  await symlink(elsewhere, f.trace);
  await assert.rejects(f.invoke(), { code: "ELOOP" });
});

test("read receipts require successful, untruncated native model output at the next invocation", async (t) => {
  const f = await fixture(t);
  await f.user("$barbaro new incoming");
  await f.invoke();
  const stream = await currentWorkstreamId(f.root, "agy", id);
  await appendPeerTurn({ projectRoot: f.root, workstreamId: stream, sequence: 1, response: "peer decision" });
  const unread = async () => {
    const scan = await inspectUnreadPeerTurns({ projectRoot: f.root, provider: "agy", nativeSessionId: id });
    return scan.status === "ready" ? scan.unread_count : undefined;
  };
  const args = ["read", "context", "--provider", "agy", "--session-id", id, "--project-root", f.root];
  const tool = { name: "run_command", args: { CommandLine: ["barbaro", ...args].join(" "), Cwd: f.cwd, WaitMsBeforeAsync: 5000 } };
  for (const clipped of [true, false]) {
    const call = await f.row("PLANNER_RESPONSE", { tool_calls: [tool] });
    await f.hook("PreToolUse", { stepIdx: call + 1, toolCall: tool });
    const { stdout } = await run(process.execPath, [cli, ...args], { cwd: f.cwd });
    assert.equal(JSON.parse(stdout).value.delivery.eligible, true);
    await f.hook("PostToolUse", { stepIdx: call + 1, toolCall: tool, error: "" });
    assert.equal(await unread(), 1);
    const output = clipped ? stdout.slice(0, 128) : stdout.trimEnd();
    await f.row("GENERIC", { content: "Created At: 2026-11-27T16:01:12-05:00\nCompleted At: 2026-11-27T16:01:12-05:00\nCommand exited with code 0.\n\nCommand output:\n" + output + "\r\n" });
    await f.invoke();
    assert.equal(await unread(), clipped ? 1 : 0);
    const health = await readDeliveryHealth(f.root, "agy", session_id, new Date());
    assert.equal(health.observation_state, "ok");
    assert.equal(health.latest_observation?.state, clipped ? "refused" : "committed");
    assert.equal(health.latest_observation?.reason, clipped ? "output_not_eligible" : "model_delivery_verified");
    assert.equal(health.last_verified_delivery?.adapter, clipped ? undefined : "agy-1.5.18-foreground-run-command");
    assert.equal(health.latest_observation?.producer_version, undefined);
    assert.doesNotMatch(JSON.stringify(health), /barbaro read context|peer decision/);
  }
});
