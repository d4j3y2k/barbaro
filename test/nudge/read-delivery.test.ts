import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { createSessionId } from "../../src/core/id.js";
import { stableStringify } from "../../src/core/stable-json.js";
import { admitHookSession } from "../../src/hooks/participation.js";
import { commitHookReadOutput, discardHookRead, stageHookReadOutput } from "../../src/nudge/read-commit.js";
import { reserveHookRead, type HookReadOptions } from "../../src/nudge/read-invocation.js";
import { deliveryFromClaim, stopReasonForNudge } from "../../src/nudge/delivery.js";
import { readCommandArguments, resolveReadQuery } from "../../src/nudge/read-query.js";
import { MAX_NUDGE_CURSOR_BYTES, NudgeCursorStateStore, nudgeCursorBytes } from "../../src/nudge/store.js";
import { NUDGE_CURSOR_SCHEMA, type NudgeCursorV3 } from "../../src/nudge/types.js";
import { MAX_READ_COVERAGE_RECORDS, readContentHash, readRecordHash, type NudgeReadCoverage } from "../../src/nudge/read-state.js";
import { READ_CURSOR_HEADROOM_BYTES } from "../../src/nudge/read-preview.js";
import { claimHookNudge, inspectUnreadPeerTurns } from "../../src/nudge/unread.js";
import { snapshotTree } from "../setup/fixture.js";

const SELF = "delivery-reader";
const PEER = "delivery-peer";
const SELF_ID = createSessionId("codex", SELF);
const PEER_ID = createSessionId("claude", PEER);
const TURN_ID = `turn_${"c".repeat(32)}`;
const JOIN = "2026-09-05T10:00:00.000Z";
const runFile = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

function fullCoverage(turn: BarbaroTurnV1): NudgeReadCoverage {
  const text = turn.response!.text;
  return {
    provider: turn.provider, session_id: turn.session_id, turn_id: turn.turn_id,
    record_sha256: readRecordHash(turn), field: "response", field_sha256: readContentHash(text),
    total_bytes: Buffer.byteLength(text), ranges: [{ start: 0, end: Buffer.byteLength(text) }],
  };
}

// Valid, deliberately fragmented fixture coverage fills a cursor to within one
// interval's serialized size of the requested byte limit. The first and last
// feed records remain wholly unread for recovery and refusal probes.
function fillCursor(state: NudgeCursorV3, turns: readonly BarbaroTurnV1[], limit: number): NudgeCursorV3 {
  let next = { ...state, reads: { ...state.reads, coverage: [] as NudgeReadCoverage[] } };
  for (const turn of turns.slice(1, -1)) {
    const full = { ...fullCoverage(turn), ranges: Array.from({ length: 256 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 })) };
    const fullCandidate = { ...next, reads: { ...next.reads, coverage: [...next.reads.coverage, full] } };
    if (nudgeCursorBytes(fullCandidate) <= limit) {
      next = fullCandidate;
      continue;
    }
    const entry = { ...fullCoverage(turn), ranges: [] as { start: number; end: number }[] };
    for (let index = 0; index < 256; index += 1) {
      const enlarged = { ...entry, ranges: [...entry.ranges, { start: index * 2, end: index * 2 + 1 }] };
      const coverage = index === 0 ? [...next.reads.coverage, enlarged] : [...next.reads.coverage.slice(0, -1), enlarged];
      const candidate = { ...next, reads: { ...next.reads, coverage } };
      if (nudgeCursorBytes(candidate) > limit) return next;
      next = candidate;
      entry.ranges = enlarged.ranges;
    }
  }
  throw new Error("fixture needs more records to reach byte capacity");
}

async function fixture(t: TestContext, responses: readonly string[]) {
  const project = await mkdtemp(join(tmpdir(), "barbaro-read-delivery-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const joined = await admitHookSession({
    projectRoot: project, provider: "claude", nativeSessionId: PEER,
    event: "UserPromptSubmit", prompt: "/barbaro new delivery", now: new Date(JOIN),
  });
  const stream = joined.participation!.workstream_id!;
  await admitHookSession({
    projectRoot: project, provider: "codex", nativeSessionId: SELF,
    event: "UserPromptSubmit", prompt: "$barbaro join delivery", now: new Date(JOIN),
  });
  const path = join(project, ".barbaro", "feed", "claude", `${PEER_ID}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  const turns: BarbaroTurnV1[] = responses.map((text, index) => ({
    schema: "barbaro.turn.v1", provider: "claude", session_id: PEER_ID,
    turn_id: `turn_${(index + 1).toString(16).padStart(32, "0")}`,
    workstream_id: stream, sequence: index + 1, agent_id: "main",
    started_at: new Date(Date.parse(JOIN) + index * 1000 + 1).toISOString(),
    ended_at: new Date(Date.parse(JOIN) + index * 1000 + 999).toISOString(), outcome: "success",
    request: { text: "review", fidelity: "verbatim", truncated: false, redactions: [] },
    response: { text, fidelity: "verbatim", truncated: false, redactions: [] },
    actions: [], evidence_refs: [], source_refs: [],
    subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] },
  }));
  await appendFile(path, turns.map((turn) => `${stableStringify(turn)}\n`).join(""));
  const base = { projectRoot: project, provider: "codex" as const, nativeSessionId: SELF, turn: { kind: "codex" as const, turn_id: TURN_ID } };
  const store = new NudgeCursorStateStore(project);
  let counter = 0;
  function call(args: readonly string[] = ["context"]): { options: HookReadOptions; argv: string[] } {
    const argv = ["read", ...args, "--provider", "codex", "--session-id", SELF, "--project-root", project];
    return {
      options: { ...base, toolName: "Bash", toolUseId: `call_${++counter}`, toolInput: { command: `barbaro ${argv.map((arg) => `'${arg}'`).join(" ")}` } },
      argv,
    };
  }
  async function output(argv: readonly string[]) {
    const before = await snapshotTree(project);
    const { stdout, stderr } = await runFile(process.execPath, [cliPath, ...argv], { timeout: 10000 });
    assert.equal(stderr, "");
    assert.equal(await snapshotTree(project), before, "CLI is a pure reader");
    const parsed = JSON.parse(stdout) as { byte_budget: number; utf8_bytes: number; value: Record<string, any> };
    assert.equal(parsed.utf8_bytes, Buffer.byteLength(stdout) - 1);
    assert.ok(Buffer.byteLength(stdout) <= parsed.byte_budget);
    return { stdout, parsed };
  }
  async function unread(expected: number) {
    const result = await inspectUnreadPeerTurns(base);
    assert.equal(result.status, "ready");
    assert.equal(result.unread_count, expected);
  }
  async function cursor() {
    const state = await store.read("codex", SELF_ID);
    assert.equal(state?.schema, NUDGE_CURSOR_SCHEMA);
    return state;
  }
  return { project, path, turns, base, store, call, output, unread, cursor };
}

test("real CLI delivery: failure keeps eight unread, newest five leave three, exact reads drain and replays do not rearm", async (t) => {
  const f = await fixture(t, Array.from({ length: 8 }, (_, index) => `verdict ${index + 1}`));
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const initial = await f.cursor();
  const failed = f.call();
  assert.equal((await reserveHookRead(failed.options)).reserved, true);
  const generated = await f.output(failed.argv);
  assert.equal(generated.parsed.value.delivery.eligible, true);
  assert.equal(generated.parsed.value.delivery.coverage.length, 5);
  await f.unread(8);
  assert.equal((await f.cursor()).cursor_revision, initial.cursor_revision);
  assert.equal((await commitHookReadOutput(failed.options, generated.stdout)).committed, false, "no successful terminal evidence");
  await discardHookRead(failed.options);
  await f.unread(8);

  const good = f.call();
  await reserveHookRead(good.options);
  const delivered = await f.output(good.argv);
  assert.equal(await stageHookReadOutput(good.options, delivered.stdout), true);
  await f.unread(8);
  assert.equal((await commitHookReadOutput(good.options, delivered.stdout.slice(0, -20))).committed, false);
  const committed = await commitHookReadOutput(good.options, delivered.stdout.trimEnd());
  assert.deepEqual(committed, { committed: true, advanced: true, unread_count: 3 });
  await f.unread(3);
  const sameStop = await claimHookNudge({ ...f.base, marker: "stop" });
  assert.equal(sameStop.status, "ready");
  assert.equal(sameStop.claimed, false);
  const informational = await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  assert.equal(informational.status, "ready");
  assert.equal(informational.claimed, true);
  assert.equal(informational.outside_delivered_window, true);
  const gapDelivery = deliveryFromClaim(informational);
  assert.match(gapDelivery.text, /3 unread peer turns remain outside the delivered window/u);
  assert.match(gapDelivery.text, /barbaro turn list --provider codex/u);
  assert.match(gapDelivery.text, /barbaro read turn show <turn_id> --field response/u);
  assert.match(gapDelivery.text, /--field request when no response exists/u);
  assert.ok(gapDelivery.text.includes(`--session-id ${SELF_ID}`));
  assert.ok(gapDelivery.text.includes(`--workstream ${informational.workstream_id}`));
  assert.ok(gapDelivery.text.includes('--project-root "$PWD"'));
  assert.match(gapDelivery.text, /follow every next_cursor/u);
  assert.ok(Buffer.byteLength(stopReasonForNudge(gapDelivery, "reply ".repeat(500))) < 2000);
  const informed = await f.cursor();
  const again = f.call();
  await reserveHookRead(again.options);
  const replayed = await f.output(again.argv);
  await stageHookReadOutput(again.options, replayed.stdout);
  assert.equal((await commitHookReadOutput(again.options, replayed.stdout)).advanced, false);
  const afterReplay = await f.cursor();
  for (const field of ["cursor_revision", "delivery", "markers"] as const) assert.deepEqual(afterReplay[field], informed[field]);
  assert.deepEqual(afterReplay.reads.informed_turn, informed.reads.informed_turn);
  const beforeOldReplay = await readFile(f.store.cursorPath("codex", SELF_ID));
  assert.equal((await commitHookReadOutput(good.options, delivered.stdout)).committed, false);
  assert.deepEqual(await readFile(f.store.cursorPath("codex", SELF_ID)), beforeOldReplay);
  const laterStop = await claimHookNudge({ ...f.base, turn: { kind: "codex", turn_id: `turn_${"d".repeat(32)}` }, marker: "stop" });
  assert.equal(laterStop.status, "ready");
  assert.equal(laterStop.claimed, true);

  for (const [index, turn] of f.turns.slice(0, 3).entries()) {
    const exact = f.call(["turn", "show", turn.turn_id, "--field", "response"]);
    await reserveHookRead(exact.options);
    const page = await f.output(exact.argv);
    assert.equal(page.parsed.value.content_metadata.fidelity, "verbatim");
    assert.equal(page.parsed.value.outcome, "success");
    await stageHookReadOutput(exact.options, page.stdout);
    assert.deepEqual(await commitHookReadOutput(exact.options, page.stdout), { committed: true, advanced: true, unread_count: 2 - index });
  }
  const drained = await f.cursor();
  assert.equal(drained.reads.coverage.length, 0);
  assert.ok(drained.feed_cursors[0]!.checkpoint.byte_offset > 0);
  const old = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response"]);
  await reserveHookRead(old.options);
  const oldPage = await f.output(old.argv);
  await stageHookReadOutput(old.options, oldPage.stdout);
  assert.equal((await commitHookReadOutput(old.options, oldPage.stdout)).advanced, false, "frontier-covered reads are also no-ops");
  assert.equal((await f.cursor()).cursor_revision, drained.cursor_revision);
});

test("real CLI delivery can consume healthy coverage beside an unavailable feed without consuming its gap", async (t) => {
  for (const fault of ["file-limit", "permission", "missing"] as const) {
    await t.test(fault, { skip: fault === "permission" && process.getuid?.() === 0 }, async (t) => {
      const f = await fixture(t, ["healthy verdict"]);
      const badSession = createSessionId("claude", "unavailable-peer");
      let badTurn = { ...f.turns[0]!, session_id: badSession, turn_id: `turn_${"d".repeat(32)}` };
      const badPath = join(f.project, ".barbaro", "feed", "claude", `${badSession}.jsonl`);
      const badBytes = `${stableStringify(badTurn)}\n`;
      await writeFile(badPath, badBytes);
      if (fault === "missing") {
        const prior = f.call(["turn", "show", badTurn.turn_id, "--field", "response"]);
        await reserveHookRead(prior.options);
        const priorOutput = await f.output(prior.argv);
        await stageHookReadOutput(prior.options, priorOutput.stdout);
        assert.equal((await commitHookReadOutput(prior.options, priorOutput.stdout)).advanced, true);
        badTurn = { ...badTurn, sequence: 2, turn_id: `turn_${"b".repeat(32)}` };
        await appendFile(badPath, `${stableStringify(badTurn)}\n`);
      }
      if (fault === "permission") await chmod(badPath, 0);
      else if (fault === "missing") await rename(badPath, `${badPath}.absent`);
      else {
        const handle = await open(badPath, "r+");
        try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
      }
      try {
        const read = f.call();
        assert.equal((await reserveHookRead(read.options)).reserved, true);
        const before = await f.cursor();
        const { stdout, stderr } = await runFile(process.execPath, [cliPath, ...read.argv]);
        assert.equal(stderr, "");
        assert.deepEqual(await f.cursor(), before, "CLI remains read-only");
        const value = JSON.parse(stdout).value;
        assert.equal(value.delivery.eligible, true);
        assert.equal(value.unread.count_is_lower_bound, true);
        assert.equal(value.unread.coverage.unavailable.total, 1);
        assert.ok(value.delivery.coverage.every((entry: NudgeReadCoverage) => entry.session_id !== badSession));
        assert.equal(await stageHookReadOutput(read.options, stdout), true);
        assert.deepEqual(await commitHookReadOutput(read.options, stdout), {
          committed: true, advanced: true, unread_count: 0, coverage_incomplete: true,
        });
        const state = await f.cursor();
        assert.deepEqual(state?.feed_cursors.find((feed) => feed.session_id === badSession),
          before?.feed_cursors.find((feed) => feed.session_id === badSession));
        assert.equal(state?.reads.outside_window, true);
      } finally {
        if (fault === "permission") await chmod(badPath, 0o600);
        else if (fault === "missing") await rename(`${badPath}.absent`, badPath);
        else await writeFile(badPath, badBytes);
      }
      await f.unread(1);
      const exact = f.call(["turn", "show", badTurn.turn_id, "--field", "response"]);
      assert.equal((await reserveHookRead(exact.options)).reserved, true);
      const output = await f.output(exact.argv);
      assert.equal(await stageHookReadOutput(exact.options, output.stdout), true);
      assert.equal((await commitHookReadOutput(exact.options, output.stdout)).advanced, true);
      await f.unread(0);
    });
  }
});

test("a covered feed becoming unavailable before commit consumes nothing", { skip: process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t, ["delivered before permission loss"]);
  const read = f.call();
  await reserveHookRead(read.options);
  const output = await f.output(read.argv);
  await stageHookReadOutput(read.options, output.stdout);
  const before = await f.cursor();
  await chmod(f.path, 0);
  try {
    assert.deepEqual(await commitHookReadOutput(read.options, output.stdout), { committed: false, advanced: false });
    assert.deepEqual(await f.cursor(), before);
  } finally { await chmod(f.path, 0o600); }
  await f.unread(1);
});

test("raising observer reader limits cannot create authority for a feed the delivery scanner cannot read", async (t) => {
  const f = await fixture(t, ["visible to the larger exact reader"]);
  const handle = await open(f.path, "r+");
  try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const read = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response",
    "--max-file-bytes", "134217728", "--max-record-bytes", "134217728"]);
  assert.equal((await reserveHookRead(read.options)).reserved, true);
  const before = await f.cursor();
  const { stdout } = await runFile(process.execPath, [cliPath, ...read.argv]);
  const value = JSON.parse(stdout).value;
  assert.equal(value.text, f.turns[0]!.response!.text);
  assert.equal(value.delivery.eligible, false);
  assert.equal(value.delivery.reason, "feed_unavailable");
  assert.equal(await stageHookReadOutput(read.options, stdout), false);
  assert.deepEqual(await f.cursor(), before);
});

test("verified prefixes collapse before later gaps, preserve sparse coverage, and resume from native CRLF anchors", async (t) => {
  const f = await fixture(t, ["first", "second", "third", "fourth"]);
  await writeFile(f.path, (await readFile(f.path, "utf8")).replaceAll("\n", "\r\n"));
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const deliver = async (index: number) => {
    const read = f.call(["turn", "show", f.turns[index]!.turn_id, "--field", "response"]);
    await reserveHookRead(read.options);
    const output = await f.output(read.argv);
    assert.equal(output.parsed.value.delivery.eligible, true);
    await stageHookReadOutput(read.options, output.stdout);
    return commitHookReadOutput(read.options, output.stdout);
  };
  await deliver(2);
  await f.unread(3);
  assert.equal((await f.cursor()).reads.coverage.length, 1);
  assert.equal((await f.cursor()).feed_cursors.length, 0);
  await deliver(0);
  await f.unread(2);
  let state = await f.cursor();
  assert.equal(state.reads.coverage.length, 1, "third response remains sparse beyond the second-turn gap");
  const firstOffset = state.feed_cursors[0]!.checkpoint.byte_offset;
  assert.ok(firstOffset > 0);
  assert.equal(state.feed_cursors[0]!.checkpoint.next_line_number, 2);
  await deliver(1);
  await f.unread(1);
  state = await f.cursor();
  assert.equal(state.reads.coverage.length, 0, "closing the gap collapses all three delivered turns while the fourth stays unread");
  assert.ok(state.feed_cursors[0]!.checkpoint.byte_offset > firstOffset);
  assert.equal(state.feed_cursors[0]!.checkpoint.next_line_number, 4);
  const revision = state.cursor_revision;
  assert.equal((await deliver(0)).advanced, false);
  assert.equal((await f.cursor()).cursor_revision, revision);
  const appended = { ...f.turns[3]!, turn_id: `turn_${"9".repeat(32)}`, sequence: 5, response: { ...f.turns[3]!.response!, text: "later" } };
  await appendFile(f.path, `${stableStringify(appended)}\r\n`);
  await f.unread(2);
});

test("coverage saturation refuses newest reads but reserves ordered oldest-gap pages and collapses their prefix", async (t) => {
  const f = await fixture(t, Array.from({ length: MAX_READ_COVERAGE_RECORDS + 1 }, (_, index) => index === 0 ? "oldest ".repeat(4000) : `verdict ${index}`));
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const initial = await f.cursor();
  await f.store.withHookWrite("codex", SELF_ID, async () => ({
    state: { ...initial, reads: { ...initial.reads, coverage: f.turns.slice(1, 1023).map(fullCoverage) } }, result: undefined,
  }));
  await f.unread(3);
  const newer = f.call(["turn", "show", f.turns.at(-1)!.turn_id, "--field", "response"]);
  await reserveHookRead(newer.options);
  const refused = await f.output(newer.argv);
  assert.equal(refused.parsed.value.delivery.reason, "coverage_capacity");
  assert.equal(refused.parsed.value.delivery.recovery_turn_id, f.turns[0]!.turn_id);
  assert.match(refused.parsed.value.delivery.recovery_hint, /--field record .*follow every next_cursor/u);
  assert.equal(await stageHookReadOutput(newer.options, refused.stdout), false);
  await discardHookRead(newer.options);
  assert.equal((await f.cursor()).cursor_revision, initial.cursor_revision);
  await f.unread(3);

  let next: string | undefined;
  let pages = 0;
  do {
    const read = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "record", ...(next === undefined ? [] : ["--cursor", next])]);
    assert.equal((await reserveHookRead(read.options)).reserved, true);
    const page = await f.output(read.argv);
    assert.equal(page.parsed.value.delivery.eligible, true);
    assert.equal(await stageHookReadOutput(read.options, page.stdout), true);
    assert.equal((await commitHookReadOutput(read.options, page.stdout)).advanced, true);
    next = page.parsed.value.next_cursor;
    pages += 1;
    if (next !== undefined) {
      await f.unread(3);
      assert.equal((await f.cursor()).reads.coverage.length, 1023);
    }
  } while (next !== undefined);
  assert.ok(pages > 2);
  await f.unread(2);
  const collapsed = await f.cursor();
  assert.equal(collapsed.reads.coverage.length, 0);
  assert.equal(collapsed.feed_cursors[0]!.checkpoint.next_line_number, 1024);
});

test("a full 1024-entry cursor can close a gap using a transient extra entry without persisting overflow", async (t) => {
  const f = await fixture(t, Array.from({ length: MAX_READ_COVERAGE_RECORDS + 2 }, (_, index) => `verdict ${index}`));
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const initial = await f.cursor();
  await f.store.withHookWrite("codex", SELF_ID, async () => ({
    state: { ...initial, reads: { ...initial.reads, coverage: f.turns.slice(1, 1025).map(fullCoverage) } }, result: undefined,
  }));
  const read = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response"]);
  await reserveHookRead(read.options);
  const page = await f.output(read.argv);
  assert.equal(page.parsed.value.delivery.eligible, true);
  await stageHookReadOutput(read.options, page.stdout);
  assert.equal((await commitHookReadOutput(read.options, page.stdout)).unread_count, 1);
  assert.equal((await f.cursor()).reads.coverage.length, 0);
});

test("serialized coverage capacity is reported before delivery and rechecked against a concurrent fill", async (t) => {
  const f = await fixture(t, Array.from({ length: 220 }, () => "a".repeat(4096)));
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const initial = await f.cursor();
  const newest = f.call(["turn", "show", f.turns.at(-1)!.turn_id, "--field", "response"]);
  await reserveHookRead(newest.options);
  const generated = await f.output(newest.argv);
  assert.equal(generated.parsed.value.delivery.eligible, true);
  await stageHookReadOutput(newest.options, generated.stdout);
  const staged = await f.cursor();
  const filled = fillCursor(staged, f.turns, MAX_NUDGE_CURSOR_BYTES - READ_CURSOR_HEADROOM_BYTES + nudgeCursorBytes(staged) - nudgeCursorBytes(initial) - 30);
  await f.store.withHookWrite("codex", SELF_ID, async () => ({ state: filled, result: undefined }));
  assert.deepEqual(await commitHookReadOutput(newest.options, generated.stdout), { committed: false, advanced: false, reason: "coverage_capacity" });
  const after = await f.cursor();
  for (const field of ["cursor_revision", "delivery", "markers", "feed_cursors"] as const) assert.deepEqual(after[field], initial[field]);
  assert.deepEqual(after.reads.coverage, filled.reads.coverage);
  await f.unread(220);
  const again = f.call(["turn", "show", f.turns.at(-1)!.turn_id, "--field", "response"]);
  await reserveHookRead(again.options);
  const refused = await f.output(again.argv);
  assert.equal(refused.parsed.value.delivery.reason, "coverage_capacity");
  assert.equal(refused.parsed.value.delivery.recovery_turn_id, f.turns[0]!.turn_id);
  await discardHookRead(again.options);
  const recovery = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "record"]);
  await reserveHookRead(recovery.options);
  const page = await f.output(recovery.argv);
  assert.equal(page.parsed.value.delivery.eligible, true);
  await stageHookReadOutput(recovery.options, page.stdout);
  assert.equal((await commitHookReadOutput(recovery.options, page.stdout)).advanced, true);
  assert.ok(nudgeCursorBytes(await f.cursor()) < MAX_NUDGE_CURSOR_BYTES);
});

test("hard byte capacity refuses reservation and staging without changing delivery history", async (t) => {
  const f = await fixture(t, Array.from({ length: 220 }, () => "b".repeat(4096)));
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const read = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response"]);
  await reserveHookRead(read.options);
  const output = await f.output(read.argv);
  const filled = fillCursor(await f.cursor(), f.turns, MAX_NUDGE_CURSOR_BYTES - 30);
  await f.store.withHookWrite("codex", SELF_ID, async () => ({ state: filled, result: undefined }));
  const before = await readFile(f.store.cursorPath("codex", SELF_ID));
  assert.equal(await stageHookReadOutput(read.options, output.stdout), false);
  assert.deepEqual(await reserveHookRead(f.call().options), { reserved: false, reason: "pending_capacity" });
  assert.deepEqual(await readFile(f.store.cursorPath("codex", SELF_ID)), before);
  const refused = await f.output(read.argv);
  assert.equal(refused.parsed.value.delivery.reason, "pending_capacity");
  assert.match(refused.parsed.value.delivery.recovery_hint, /Finish outstanding read invocations/u);
  await f.unread(220);
});

test("fragmented page capacity refuses an isolated range and accepts an ordered gap-filling page", async (t) => {
  const f = await fixture(t, ["x".repeat(30000), "still unread"]);
  await claimHookNudge({ ...f.base, marker: "tool_boundary" });
  const initial = await f.cursor();
  await f.store.withHookWrite("codex", SELF_ID, async () => ({ state: {
    ...initial, reads: { ...initial.reads, coverage: [{ ...fullCoverage(f.turns[0]!),
      ranges: Array.from({ length: 256 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 })),
    }] },
  }, result: undefined }));
  const first = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response"]);
  await reserveHookRead(first.options);
  const firstPage = await f.output(first.argv);
  assert.equal(firstPage.parsed.value.delivery.eligible, true);
  const isolated = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response", "--cursor", firstPage.parsed.value.next_cursor]);
  await reserveHookRead(isolated.options);
  const refused = await f.output(isolated.argv);
  assert.equal(refused.parsed.value.delivery.reason, "coverage_capacity");
  assert.equal(refused.parsed.value.delivery.recovery_turn_id, f.turns[0]!.turn_id);
  assert.equal(await stageHookReadOutput(isolated.options, refused.stdout), false);
  assert.equal((await f.cursor()).cursor_revision, initial.cursor_revision);
  await discardHookRead(isolated.options);
  await stageHookReadOutput(first.options, firstPage.stdout);
  assert.equal((await commitHookReadOutput(first.options, firstPage.stdout)).advanced, true);
  assert.equal((await f.cursor()).reads.coverage[0]!.ranges.length, 1);
  await f.unread(2);
});

test("expired reservations are observers and arrivals after rendering stay unread at commit", async (t) => {
  const f = await fixture(t, ["rendered response"]);
  const expired = f.call();
  await reserveHookRead({ ...expired.options, now: new Date(Date.now() - 300001) });
  assert.equal((await f.output(expired.argv)).parsed.value.delivery.reason, "no_invocation");
  const read = f.call();
  await reserveHookRead(read.options);
  assert.equal((await f.cursor()).reads.pending.length, 1, "the next hook drops expired reservations");
  const output = await f.output(read.argv);
  assert.equal(await stageHookReadOutput(expired.options, output.stdout), false);
  const appended = { ...f.turns[0]!, turn_id: `turn_${"9".repeat(32)}`, sequence: 2, response: { ...f.turns[0]!.response!, text: "arrived after render" } };
  await appendFile(f.path, `${stableStringify(appended)}\n`);
  await stageHookReadOutput(read.options, output.stdout);
  assert.deepEqual(await commitHookReadOutput(read.options, output.stdout), { committed: true, advanced: true, unread_count: 1 });
  await f.unread(1);
});

test("exact pages fit the complete 8 KiB envelope and acknowledge only when all intervals arrive", async (t) => {
  const f = await fixture(t, ["日本語 and emoji 🐎 ".repeat(1200)]);
  const pages: { options: HookReadOptions; stdout: string }[] = [];
  let next: string | undefined;
  do {
    const read = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response", ...(next === undefined ? [] : ["--cursor", next])]);
    await reserveHookRead(read.options);
    const page = await f.output(read.argv);
    assert.equal(page.parsed.value.delivery.eligible, true);
    pages.push({ options: read.options, stdout: page.stdout });
    next = page.parsed.value.next_cursor;
  } while (next !== undefined);
  assert.ok(pages.length > 3);
  const missing = pages.splice(1, 1)[0]!;
  for (const page of pages.reverse()) {
    assert.equal(await stageHookReadOutput(page.options, page.stdout), true);
    assert.equal((await commitHookReadOutput(page.options, page.stdout)).advanced, true);
    await f.unread(1);
  }
  await stageHookReadOutput(missing.options, missing.stdout);
  assert.equal((await commitHookReadOutput(missing.options, missing.stdout)).unread_count, 0);
});

test("observer, ambiguous, oversized and altered tool-input reads consume nothing", async (t) => {
  const f = await fixture(t, ["x".repeat(20000)]);
  const plain = f.call();
  assert.equal((await f.output(plain.argv)).parsed.value.delivery.reason, "no_invocation");
  const a = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response"]);
  const b = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response"]);
  await reserveHookRead(a.options);
  await reserveHookRead(b.options);
  assert.equal((await f.output(a.argv)).parsed.value.delivery.reason, "ambiguous_invocation");
  await discardHookRead(b.options);
  const small = await f.output(a.argv);
  assert.equal(small.parsed.value.delivery.eligible, true);
  assert.equal(await stageHookReadOutput({ ...a.options, toolInput: { ...a.options.toolInput as object, description: "changed" } }, small.stdout), false);
  const large = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "response", "--byte-budget", "30000"]);
  await reserveHookRead(large.options);
  const output = await f.output(large.argv);
  assert.ok(Buffer.byteLength(output.stdout) > 8192);
  assert.equal(output.parsed.value.delivery.reason, "output_ceiling");
  assert.equal(output.parsed.value.delivery.eligible, false);
  assert.equal(await stageHookReadOutput(large.options, output.stdout), false);
  assert.equal(await stageHookReadOutput(a.options, `preview: ${small.stdout}`), false);
  assert.equal(await stageHookReadOutput({ ...a.options, now: new Date(Date.now() + 6 * 60_000) }, small.stdout), false);
  await f.unread(1);
});

test("the command boundary rejects composition and unknown expansion without evaluating shell code", async (t) => {
  const f = await fixture(t, ["verdict"]);
  const variables = { PWD: f.project, CODEX_SESSION_ID: SELF };
  const command = 'barbaro read context --provider codex --session-id "$CODEX_SESSION_ID" --project-root "${PWD}"';
  const args = readCommandArguments(command, variables);
  assert.ok(args !== undefined);
  const query = await resolveReadQuery(args, f.project);
  assert.equal(query.recipient?.session_id, SELF_ID);
  for (const unsafe of [
    `${command} | cat`, `${command} > out`, `${command}; true`, `${command} &`,
    `env ${command}`, `node -e '${command}'`, `${command}\ntrue`,
    command.replace('$CODEX_SESSION_ID', '$(printf injected)'),
    command.replace('$CODEX_SESSION_ID', '$CODEX_THREAD_ID'),
    command.replace('"${PWD}"', '"$HOME"'),
  ]) assert.equal(readCommandArguments(unsafe, variables), undefined, unsafe);
  for (const args of [["turn", "list"], ["context", "--byte-budget", "0"], ["context", "--byte-budget", "1", "--byte-budget", "2"]]) {
    await assert.rejects(resolveReadQuery(args, f.project));
  }
});

test("changed data, provider turns and membership epochs refuse stale receipts; concurrent commits advance once", async (t) => {
  const f = await fixture(t, ["reviewed bytes"]);
  const read = f.call();
  await reserveHookRead(read.options);
  const output = await f.output(read.argv);
  assert.equal(await stageHookReadOutput({ ...read.options, turn: { kind: "codex", turn_id: `turn_${"e".repeat(32)}` } }, output.stdout), false);
  assert.equal(await stageHookReadOutput(read.options, output.stdout.replace("reviewed bytes", "tampered bytes")), false);
  await stageHookReadOutput(read.options, output.stdout);
  const changed = { ...f.turns[0]!, response: { ...f.turns[0]!.response!, text: "changed bytes" } };
  await writeFile(f.path, `${stableStringify(changed)}\n`);
  assert.equal((await commitHookReadOutput(read.options, output.stdout)).committed, false);
  await f.unread(1);
  await writeFile(f.path, `${stableStringify(f.turns[0])}\n`);
  const commits = await Promise.all([
    commitHookReadOutput(read.options, output.stdout), commitHookReadOutput(read.options, output.stdout),
  ]);
  assert.equal(commits.filter((result) => result.advanced).length, 1);
  await f.unread(0);

  const pending = f.call();
  await reserveHookRead(pending.options);
  const priorEpoch = await f.output(pending.argv);
  await stageHookReadOutput(pending.options, priorEpoch.stdout);
  await admitHookSession({
    projectRoot: f.project, provider: "codex", nativeSessionId: SELF,
    event: "UserPromptSubmit", prompt: "$barbaro new moved", now: new Date(),
  });
  assert.equal((await commitHookReadOutput(pending.options, priorEpoch.stdout)).committed, false);
});

test("pending invocation capacity and response-less attention are explicit", async (t) => {
  const f = await fixture(t, ["response present"]);
  const wrongField = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "request"]);
  await reserveHookRead(wrongField.options);
  assert.equal((await f.output(wrongField.argv)).parsed.value.delivery.reason, "no_attention_coverage");
  await discardHookRead(wrongField.options);
  const { response: _response, ...withoutResponse } = f.turns[0]!;
  await writeFile(f.path, `${stableStringify(withoutResponse)}\n`);
  const request = f.call(["turn", "show", f.turns[0]!.turn_id, "--field", "request"]);
  await reserveHookRead(request.options);
  const page = await f.output(request.argv);
  assert.equal(page.parsed.value.delivery.eligible, true);
  await stageHookReadOutput(request.options, page.stdout);
  assert.equal((await commitHookReadOutput(request.options, page.stdout)).unread_count, 0);
  for (let index = 0; index < 32; index += 1) {
    assert.equal((await reserveHookRead(f.call().options)).reserved, true);
  }
  assert.deepEqual(await reserveHookRead(f.call().options), { reserved: false, reason: "pending_capacity" });
  assert.equal((await f.output(f.call(["context", "--byte-budget", "9000"]).argv)).parsed.value.delivery.reason, "pending_capacity");
});

test("delivery context allocates a short peer response before a newer long own-session verdict", async (t) => {
  for (const provider of ["codex", "claude"] as const) {
    await t.test(provider, async (t) => {
      const f = await fixture(t, ["Short peer response that must remain fully deliverable."]);
      const selfId = provider === "codex" ? SELF_ID : PEER_ID;
      const peerId = provider === "codex" ? PEER_ID : SELF_ID;
      const peerProvider = provider === "codex" ? "claude" : "codex";
      const incoming = { ...f.turns[0]!, provider: peerProvider, session_id: peerId } as BarbaroTurnV1;
      const own = { ...incoming, provider, session_id: selfId, turn_id: `turn_${"d".repeat(32)}`,
        started_at: "2026-09-05T10:00:10.000Z", ended_at: "2026-09-05T10:00:11.000Z",
        request: { ...incoming.request, text: "OWN_REQUEST_CANARY".repeat(1000) },
        response: { ...incoming.response!, text: "OWN_VERDICT_CANARY".repeat(1000) } };
      for (const turn of [incoming, own]) {
        const directory = join(f.project, ".barbaro/feed", turn.provider);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${turn.session_id}.jsonl`), `${JSON.stringify(turn)}\n`);
      }
      const nativeSessionId = provider === "codex" ? SELF : PEER;
      const options = { projectRoot: f.project, provider, nativeSessionId,
        turn: provider === "codex" ? { kind: "codex" as const, turn_id: TURN_ID } : { kind: "claude" as const, phase: "current" as const },
        toolName: "Bash", toolUseId: "peer-priority" };
      await claimHookNudge({ ...options, marker: "user_prompt" });
      const argv = ["read", "context", "--provider", provider, "--session-id", nativeSessionId, "--project-root", f.project];
      const call = { ...options, toolInput: { command: `barbaro ${argv.map((arg) => `'${arg}'`).join(" ")}` } };
      assert.equal((await reserveHookRead(call)).reserved, true);
      const { stdout } = await runFile(process.execPath, [cliPath, ...argv]);
      const output = JSON.parse(stdout);
      assert.ok(Buffer.byteLength(stdout) <= 8192);
      assert.equal(output.value.turns.items[0].turn_id, incoming.turn_id);
      assert.equal(output.value.turns.items[0].response.text, incoming.response!.text);
      assert.equal(output.value.delivery.eligible, true);
      assert.deepEqual(output.value.delivery.coverage.map((row: NudgeReadCoverage) => row.turn_id), [incoming.turn_id]);
      assert.equal(output.value.turns.total, 2, "own history remains counted even when deprioritized");
      const before = await inspectUnreadPeerTurns(options);
      assert.equal(before.status, "ready");
      assert.equal(before.status === "ready" ? before.unread_count : -1, 1);
      assert.equal(await stageHookReadOutput(call, stdout), true);
      assert.equal((await commitHookReadOutput(call, stdout)).committed, true);
      const after = await inspectUnreadPeerTurns(options);
      assert.equal(after.status, "ready");
      assert.equal(after.status === "ready" ? after.unread_count : -1, 0);
      const observer = JSON.parse((await runFile(process.execPath, [cliPath, ...argv.slice(1)])).stdout);
      assert.equal(observer.value.turns.items[0].turn_id, own.turn_id, "legacy observer keeps chronological ordering");
    });
  }
});
