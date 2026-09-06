import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { handleClaudeHook } from "../../src/hooks/claude.js";
import { claudeModelText, claudeSuccessfulStdout } from "../../src/hooks/claude-read.js";
import { claimHookNudge, inspectUnreadPeerTurns } from "../../src/nudge/unread.js";
import { appendPeerTurn, currentWorkstreamId } from "./nudge-fixture.js";
import { createSessionId } from "../../src/core/id.js";
import { readDeliveryHealth } from "../../src/reader/delivery-health.js";
import { NudgeCursorStateStore } from "../../src/nudge/store.js";
import { NUDGE_CURSOR_SCHEMA, type NudgeCursorV3 } from "../../src/nudge/types.js";
import { ActiveLeaseStore, deriveLeaseId } from "../../src/active/index.js";
import { commitHookReadOutput } from "../../src/nudge/read-commit.js";
import { snapshotTree } from "../setup/fixture.js";

const SESSION = "claude-read-hook";
const fixtures = resolve("test/fixtures/hooks/claude-2.1.261");
const captured = async (name: string) => JSON.parse(await readFile(join(fixtures, name), "utf8"));

test("Claude 2.1.261 captured stdout and model batch surfaces have separate authority", async () => {
  const small = await captured("001.PostToolUse.json");
  const batch = await captured("002.PostToolBatch.json");
  assert.equal(claudeSuccessfulStdout(small.tool_response), "BARBARO-SMALL-OK");
  assert.equal(claudeModelText(batch.tool_calls[0].tool_response), small.tool_response.stdout);
  assert.equal(batch.tool_calls[0].tool_use_id, small.tool_use_id);
  assert.deepEqual(batch.tool_calls[0].tool_input, small.tool_input);
  const large = await captured("004.PostToolUse.json");
  assert.equal(Buffer.byteLength(claudeSuccessfulStdout(large.tool_response)!), 12000);
  const spilled = await captured("007.PostToolUse.json");
  assert.equal(claudeSuccessfulStdout(spilled.tool_response), undefined);
  const preview = await captured("008.PostToolBatch.json");
  assert.notEqual(claudeModelText(preview.tool_calls[0].tool_response), spilled.tool_response.stdout);
  const failed = await captured("010.PostToolUseFailure.json");
  assert.equal(claudeSuccessfulStdout(failed.tool_response), undefined);
  const failureBatch = await captured("011.PostToolBatch.json");
  assert.equal(typeof claudeModelText(failureBatch.tool_calls[0].tool_response), "string",
    "batch shape alone cannot prove success");
  const parallel = await captured("016.PostToolBatch.json");
  assert.equal(parallel.tool_calls.length, 2);
  for (const [index, name] of ["013.PostToolUse.json", "015.PostToolUse.json"].entries()) {
    const post = await captured(name);
    assert.equal(parallel.tool_calls[index].tool_use_id, post.tool_use_id);
    assert.equal(claudeModelText(parallel.tool_calls[index].tool_response), claudeSuccessfulStdout(post.tool_response));
  }
  for (const value of [undefined, {}, { stdout: "x" }, ["x"], [{ type: "image", text: "x" }],
    [{ type: "text", text: "a" }, { type: "text", text: "b" }], [{ type: "text", text: "x", extra: true }]]) {
    assert.equal(claudeModelText(value), undefined);
  }
  assert.equal(claudeModelText([{ type: "text", text: "x" }]), "x");
});

async function fixture(t: TestContext, response = "Review delivered.") {
  const root = await mkdtemp(join(tmpdir(), "barbaro-claude-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actor = { session_id: SESSION, cwd: root };
  await handleClaudeHook({ ...actor, hook_event_name: "UserPromptSubmit", prompt: "/barbaro new delivery" });
  const workstreamId = await currentWorkstreamId(root, "claude", SESSION);
  const peer = await appendPeerTurn({ projectRoot: root, workstreamId, provider: "codex", sequence: 1, response });
  let nextId = 0;
  const unread = async () => {
    const value = await inspectUnreadPeerTurns({ projectRoot: root, provider: "claude", nativeSessionId: SESSION });
    assert.equal(value.status, "ready");
    return value.unread_count;
  };
  const read = async (page = false) => {
    const argv = ["read", ...(page ? ["turn", "show", peer.turn_id, "--field", "response"] : ["context"]),
      "--provider", "claude", "--session-id", SESSION, "--project-root", root];
    const call = { ...actor, tool_name: "Bash", tool_use_id: `toolu_read_${++nextId}`,
      tool_input: { command: `barbaro ${argv.map((arg) => `'${arg}'`).join(" ")}`, description: "Read review" } };
    await handleClaudeHook({ ...call, hook_event_name: "PreToolUse" });
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), ...argv]);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).value.delivery.eligible, true);
    const text = stdout.slice(0, -1);
    const post = { ...call, hook_event_name: "PostToolUse", tool_response: {
      stdout: text, stderr: "", interrupted: false, isImage: false, noOutputExpected: false,
    } };
    const batch = { ...actor, hook_event_name: "PostToolBatch", tool_calls: [{ ...call, tool_response: text }] };
    return { call, text, post, batch };
  };
  const cursorStore = new NudgeCursorStateStore(root);
  const cursor = async () => {
    const value = await cursorStore.read("claude", createSessionId("claude", SESSION));
    assert.equal(value?.schema, NUDGE_CURSOR_SCHEMA);
    return value as NudgeCursorV3;
  };
  const activeStore = new ActiveLeaseStore(join(root, ".barbaro", "active"));
  const identity = { provider: "claude", session_id: createSessionId("claude", SESSION),
    agent_id: "main", lease_id: deriveLeaseId("claude", SESSION, "main"), workstream_id: workstreamId };
  return { actor, unread, read, cursor, activeStore, identity, peer };
}

function coverage(state: NudgeCursorV3) {
  return { revision: state.cursor_revision, feeds: state.feed_cursors,
    coverage: state.reads.coverage, outside: state.reads.outside_window };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function partial(t: TestContext) {
  const f = await fixture(t, "Partial read remains unread. ".repeat(600));
  const delivered = await f.read(true);
  await handleClaudeHook(delivered.post);
  await handleClaudeHook(delivered.batch);
  assert.equal(await f.unread(), 1);
  const state = await f.cursor();
  assert.equal(state.reads.coverage.length, 1);
  assert.deepEqual(state.reads.informed_turn, { kind: "claude", generation: state.claude_turn_generation });
  return { ...f, delivered };
}

for (const queued of [false, true]) {
  test(`Claude partial delivery suppresses its first Stop${queued ? " with queued input" : " without queued input"}`, async (t) => {
    const f = await partial(t);
    const before = await f.cursor();
    if (queued) {
      const prompt = await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Queued input" });
      assert.equal(prompt.nudge, undefined);
      const after = await f.cursor();
      assert.equal(after.claude_turn_generation, before.claude_turn_generation! + 1);
      assert.deepEqual(after.reads.informed_turn, { kind: "claude", generation: after.claude_turn_generation });
      assert.deepEqual(coverage(after), coverage(before));
    }
    const stop = await handleClaudeHook({ ...f.actor, hook_event_name: "Stop", last_assistant_message: "Partial result" });
    assert.equal(stop.stop_reason, undefined);
    const stopped = await f.cursor();
    assert.equal(stopped.reads.informed_turn, undefined, "suppression is consumed at the terminal boundary");
    assert.equal(stopped.delivery.last_turn, undefined);
    assert.equal(stopped.markers.stop, undefined);
    assert.deepEqual(coverage(stopped), coverage(before));
    assert.equal(await f.unread(), 1);
    // Queued input need not receive a second prompt hook. Its later Stop gets
    // one opportunity; ordinary input after idle does too.
    if (!queued) await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Next ordinary turn" });
    const later = await handleClaudeHook({ ...f.actor, hook_event_name: "Stop", last_assistant_message: "Later result" });
    assert.match(later.stop_reason ?? "", /^Barbaro:/u);
    const duplicate = await handleClaudeHook({ ...f.actor, hook_event_name: "Stop", last_assistant_message: "Later result" });
    assert.equal(duplicate.stop_reason, undefined, "once-per-revision Stop latch survives marker retirement");
    assert.deepEqual(coverage(await f.cursor()), coverage(before));
  });
}

test("Claude carries informational delivery through queued input exactly once", async (t) => {
  const f = await fixture(t);
  const first = await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Receive news" });
  assert.ok(first.nudge);
  const before = await f.cursor();
  await handleClaudeHook({ ...f.actor, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "barbaro await --provider claude --session-id claude-read-hook" } });
  assert.equal((await f.activeStore.readSnapshot(f.identity))?.state, "waiting");
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Queued while waiting" });
  const queued = await f.cursor();
  assert.deepEqual(queued.delivery.last_turn, { kind: "claude", generation: queued.claude_turn_generation });
  assert.equal((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason, undefined);
  assert.equal((await f.cursor()).delivery.last_turn, undefined);
  assert.deepEqual(coverage(await f.cursor()), coverage(before));
  assert.ok((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason);
  assert.equal(await f.unread(), 1);
});

test("Claude reentrant Stop retires carried suppression without consuming the Stop latch", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Queued on a continuation" });
  assert.equal((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop", stop_hook_active: true })).stop_reason, undefined);
  const after = await f.cursor();
  assert.equal(after.reads.informed_turn, undefined);
  assert.equal(after.delivery.last_turn, undefined);
  assert.equal(after.markers.stop, undefined);
  assert.deepEqual(coverage(after), coverage(before));
  assert.equal((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop", stop_hook_active: true })).stop_reason, undefined);
  assert.equal((await f.cursor()).markers.stop, undefined);
  assert.ok((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason);
});

for (const predecessor of ["idle", "expired", "missing", "other-epoch", "before-epoch", "future", "blocked"] as const) {
  test(`Claude does not carry suppression from an ${predecessor} lease`, async (t) => {
    const f = await partial(t);
    const before = await f.cursor();
    if (predecessor === "missing") await rm(join(f.actor.cwd, ".barbaro", "active"), { recursive: true });
    else if (predecessor === "idle") await f.activeStore.writeIdle(f.identity);
    else await f.activeStore.write({ ...f.identity, state: predecessor === "blocked" ? "blocked" : "working", claims: [], unknown_write_scope: false,
      ...(predecessor === "other-epoch" ? { workstream_id: `ws_${"a".repeat(32)}` } : {}) },
      predecessor === "expired" ? { now: Date.now() - 1000, ttlMs: 1 }
        : predecessor === "future" ? { now: Date.now() + 60000 }
          : predecessor === "before-epoch" ? { now: Date.parse(before.membership_from) - 1, ttlMs: 60000 } : {});
    await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Ordinary fallback" });
    const after = await f.cursor();
    assert.equal(after.claude_turn_generation, before.claude_turn_generation! + 1);
    assert.deepEqual(after.reads.informed_turn, before.reads.informed_turn);
    assert.deepEqual(coverage(after), coverage(before));
    assert.ok((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason);
    assert.equal(await f.unread(), 1);
    assert.deepEqual(coverage(await f.cursor()), coverage(before));
  });
}

test("Claude queued input never revives an old marker or permits duplicate delivery", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  await f.activeStore.writeIdle(f.identity);
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Ordinary turn" });
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Queued on later turn" });
  assert.deepEqual((await f.cursor()).reads.informed_turn, before.reads.informed_turn);
  await handleClaudeHook(f.delivered.post);
  await handleClaudeHook(f.delivered.batch);
  assert.deepEqual(coverage(await f.cursor()), coverage(before));
  assert.deepEqual((await f.cursor()).reads.informed_turn, before.reads.informed_turn);
  assert.ok((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason);
});

test("Claude duplicate page delivery on a later turn cannot renew consumed suppression", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  assert.equal((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason, undefined);
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "A later ordinary turn" });
  const repeated = await f.read(true);
  await handleClaudeHook(repeated.post);
  await handleClaudeHook(repeated.batch);
  const after = await f.cursor();
  assert.deepEqual(coverage(after), coverage(before));
  assert.equal(after.reads.informed_turn, undefined);
  assert.equal(after.delivery.last_turn, undefined);
  assert.ok((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason);
  assert.equal(await f.unread(), 1);
});

test("Claude membership change resets old coverage and never carries a previous epoch's marker", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "/barbaro new replacement" });
  const after = await f.cursor();
  assert.notEqual(after.workstream_id, before.workstream_id);
  assert.notEqual(after.membership_from, before.membership_from);
  assert.equal(after.cursor_revision, before.cursor_revision + 1);
  assert.equal(after.claude_turn_generation, before.claude_turn_generation! + 1);
  assert.deepEqual(after.reads.coverage, []);
  assert.deepEqual(after.reads.pending, []);
  assert.equal(after.reads.informed_turn, undefined);
  assert.equal(after.delivery.last_turn, undefined);
});

test("Claude cursor refuses queued carry when its epoch differs from actor-locked evidence", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  await claimHookNudge({ projectRoot: f.actor.cwd, provider: "claude", nativeSessionId: SESSION,
    marker: "user_prompt", turn: { kind: "claude", phase: "queued", workstream_id: before.workstream_id,
      membership_from: new Date(Date.parse(before.membership_from) - 1).toISOString() } });
  const after = await f.cursor();
  assert.equal(after.claude_turn_generation, before.claude_turn_generation! + 1);
  assert.deepEqual(after.reads.informed_turn, before.reads.informed_turn);
  assert.deepEqual(coverage(after), coverage(before));
  assert.ok((await handleClaudeHook({ ...f.actor, hook_event_name: "Stop" })).stop_reason);
});

test("Claude child prompts cannot advance or carry the main cursor", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  await handleClaudeHook({ ...f.actor, agent_id: "child", hook_event_name: "UserPromptSubmit", prompt: "Child input" });
  await handleClaudeHook({ ...f.actor, agent_id: "child", hook_event_name: "Stop" });
  assert.deepEqual(await f.cursor(), before);
});

test("Claude prompt active-write failure cannot consume news or advance its generation", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  const original = ActiveLeaseStore.prototype.update;
  t.mock.method(ActiveLeaseStore.prototype, "update", function (this: ActiveLeaseStore, ...args: Parameters<typeof original>) {
    return original.call(this, args[0], args[1], { ...args[2], now: Number.NaN });
  });
  await assert.rejects(handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Queued input" }), /now/u);
  assert.deepEqual(await f.cursor(), before);
  assert.equal(await f.unread(), 1);
});

test("Claude prompt failure never rolls back concurrent verified delivery", async (t) => {
  const f = await fixture(t, "Fresh partial response ".repeat(700));
  const read = await f.read(true);
  await handleClaudeHook(read.post);
  const before = await f.cursor();
  const original = ActiveLeaseStore.prototype.update;
  let committed = false;
  t.mock.method(ActiveLeaseStore.prototype, "update", function (this: ActiveLeaseStore, ...args: Parameters<typeof original>) {
    return original.call(this, args[0], args[1], { ...args[2], now: Number.NaN,
      onWriteFailure: async () => {
        const result = await commitHookReadOutput({ projectRoot: f.actor.cwd, provider: "claude", nativeSessionId: SESSION,
          turn: { kind: "claude", phase: "current" }, toolName: "Bash", toolUseId: read.call.tool_use_id,
          toolInput: read.call.tool_input }, read.text);
        committed = result.committed;
      } });
  });
  await assert.rejects(handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Fails while a result arrives" }));
  assert.equal(committed, true);
  const after = await f.cursor();
  assert.equal(after.cursor_revision, before.cursor_revision + 1);
  assert.equal(after.claude_turn_generation, before.claude_turn_generation);
  assert.ok(after.reads.coverage[0]!.ranges[0]!.end > 0);
  assert.equal(after.reads.pending.length, 0);
  assert.equal(await f.unread(), 1);
});

test("Claude queued prompt holds the actor lock through its cursor decision before Stop", async (t) => {
  const f = await partial(t);
  const before = await f.cursor();
  const original = ActiveLeaseStore.prototype.update;
  const entered = signal();
  const release = signal();
  let intercepted = false;
  t.mock.method(ActiveLeaseStore.prototype, "update", function (this: ActiveLeaseStore, ...args: Parameters<typeof original>) {
    const callback = args[2]?.afterCommit;
    if (callback === undefined || intercepted) return original.apply(this, args);
    intercepted = true;
    return original.call(this, args[0], args[1], { ...args[2], afterCommit: async (lease) => {
      entered.resolve();
      await release.promise;
      await callback(lease);
    } });
  });
  const prompt = handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "Racing queued prompt" });
  await entered.promise;
  let stopFinished = false;
  const stop = handleClaudeHook({ ...f.actor, hook_event_name: "Stop" }).then((result) => { stopFinished = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopFinished, false);
  assert.deepEqual(await f.cursor(), before, "cursor decision has not yet executed");
  release.resolve();
  assert.equal((await prompt).nudge, undefined);
  assert.equal((await stop).stop_reason, undefined);
  const after = await f.cursor();
  assert.equal(after.claude_turn_generation, before.claude_turn_generation! + 1);
  assert.equal(after.reads.informed_turn, undefined);
  assert.deepEqual(coverage(after), coverage(before));
});

test("Claude requires a successful foreground result then complete matching model output", async (t) => {
  const f = await fixture(t);
  const first = await f.read();
  await handleClaudeHook(first.batch);
  assert.equal(await f.unread(), 1, "batch without successful PostToolUse is not delivery");
  await handleClaudeHook({ ...first.call, hook_event_name: "PostToolUseFailure", error: first.text, is_interrupt: false });
  await handleClaudeHook(first.batch);
  assert.equal(await f.unread(), 1, "even parseable failure output is not delivery");

  const preview = await f.read();
  await handleClaudeHook({ ...preview.post, tool_response: { ...preview.post.tool_response,
    persistedOutputPath: "/tmp/preview", persistedOutputSize: 40001 } });
  await handleClaudeHook(preview.batch);
  assert.equal(await f.unread(), 1, "persisted-output preview is not an intact terminal result");

  const intact = await f.read();
  await handleClaudeHook(intact.post);
  for (const response of [undefined, intact.text.slice(0, -2), `prefix\n${intact.text}`,
    { output: intact.text }, [{ type: "text", text: intact.text }, { type: "text", text: "suffix" }]]) {
    await handleClaudeHook({ ...intact.batch, tool_calls: [{ ...intact.call, tool_response: response }] });
    assert.equal(await f.unread(), 1);
  }
  await handleClaudeHook({ ...intact.batch, tool_calls: [{ ...intact.call, tool_use_id: "foreign-id", tool_response: intact.text }] });
  await handleClaudeHook({ ...intact.batch, tool_calls: [{ ...intact.call,
    tool_input: { ...intact.call.tool_input, description: "altered" }, tool_response: intact.text }] });
  assert.equal(await f.unread(), 1, "native identity and exact input bind delivery");
  await handleClaudeHook({ ...intact.batch, tool_calls: [{ ...intact.call, tool_response: [{ type: "text", text: intact.text }] }] });
  assert.equal(await f.unread(), 0);
  const health = await readDeliveryHealth(f.actor.cwd, "claude", createSessionId("claude", SESSION), new Date());
  assert.equal(health.last_verified_delivery?.state, "committed");
  assert.equal(health.last_verified_delivery?.producer_version, undefined, "shape-only hooks do not attest a version");
  assert.ok(!JSON.stringify(health).includes(intact.text));
  const cursor = await new NudgeCursorStateStore(f.actor.cwd).read("claude", createSessionId("claude", SESSION));
  const saved = cursor!.feed_cursors[0]!;
  const path = join(f.actor.cwd, ".barbaro/feed", saved.provider, `${saved.session_id}.jsonl`);
  await rename(path, `${path}.saved`);
  const missing = await readDeliveryHealth(f.actor.cwd, "claude", createSessionId("claude", SESSION), new Date());
  assert.ok("saved_feed_failures" in missing);
  assert.equal(missing.saved_feed_failures[0]?.reason, "missing_saved_feed");
});

test("delivery health reports reservations that never commit and unsupported terminal shapes without writing", async (t) => {
  const f = await fixture(t);
  const read = await f.read();
  const before = await snapshotTree(f.actor.cwd);
  const expired = await readDeliveryHealth(f.actor.cwd, "claude", createSessionId("claude", SESSION), new Date(Date.now() + 6 * 60 * 1000));
  assert.equal(expired.never_committed, 1);
  assert.ok("expired_pending" in expired);
  assert.equal(expired.expired_pending, 1);
  assert.equal(await snapshotTree(f.actor.cwd), before);
  await handleClaudeHook({ ...read.post, tool_response: { stdout: read.text, new_version_shape: true } });
  const refused = await readDeliveryHealth(f.actor.cwd, "claude", createSessionId("claude", SESSION), new Date());
  assert.equal(refused.latest_observation?.reason, "unsupported_producer_or_shape");
  assert.equal(refused.last_verified_delivery, undefined);
  assert.equal(await f.unread(), 1);
});

test("Claude stale generations and child actors cannot deliver a main actor's pending read", async (t) => {
  const f = await fixture(t);
  const old = await f.read();
  await handleClaudeHook({ ...old.post, agent_id: "child" });
  await handleClaudeHook(old.batch);
  assert.equal(await f.unread(), 1);
  await handleClaudeHook(old.post);
  await handleClaudeHook({ ...f.actor, hook_event_name: "UserPromptSubmit", prompt: "A new turn" });
  await handleClaudeHook(old.batch);
  assert.equal(await f.unread(), 1, "previous-generation staged output remains unread");
  // A delayed failure also carries no delivery authority in the new generation.
  await handleClaudeHook({ ...old.call, hook_event_name: "PostToolUseFailure", error: "stale failure" });
  assert.equal(await f.unread(), 1);
});
