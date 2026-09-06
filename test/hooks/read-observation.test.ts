import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeHookRead, readReadObservations } from "../../src/hooks/read-observation.js";
import { createSessionId } from "../../src/core/id.js";
import { snapshotTree } from "../setup/fixture.js";

test("read observation history stays bounded, preserves verified results on replay, and excludes native text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-read-observations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { projectRoot: root, provider: "codex" as const, nativeSessionId: "fixture", toolName: "Bash",
    toolInput: { command: "SECRET_COMMAND_BODY" }, turn: { kind: "codex" as const, turn_id: "turn" } };
  for (let i = 0; i < 20; i++) {
    await observeHookRead({ ...base, toolUseId: String(i), now: new Date(100000 + i * 1000) }, "reserved", "reserved", "0.153.2");
  }
  const call = { ...base, toolUseId: "19", now: new Date(120000) };
  await observeHookRead(call, "committed", "model_delivery_verified", "0.153.2");
  await observeHookRead(call, "refused", "command_failed");
  const before = await snapshotTree(root);
  const read = await readReadObservations(root, "codex", createSessionId("codex", "fixture"));
  assert.equal(read.state, "ok");
  assert.ok(read.state === "ok");
  assert.equal(read.journal.omitted, 4);
  assert.equal(read.journal.observations.length, 16);
  assert.equal(read.journal.observations.at(-1)?.state, "committed");
  assert.ok(!JSON.stringify(read).includes("SECRET_COMMAND_BODY"));
  assert.equal(await snapshotTree(root), before);
});

test("read observation reader refuses unsafe paths and invalid producer/state evidence without repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-read-observation-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = createSessionId("codex", "fixture");
  const call = { projectRoot: root, provider: "codex" as const, nativeSessionId: "fixture", toolName: "Bash", toolInput: {}, toolUseId: "fixture", now: new Date(100000), turn: { kind: "codex" as const, turn_id: "turn" } };
  await observeHookRead(call, "committed", "model_delivery_verified", "0.153.2");
  const path = join(root, ".barbaro/logs/delivery/codex", `${sessionId}.json`);
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const patch of [{ producer_version: "0.999.0" }, { producer_version: undefined }, { reason: "command_failed" }, { output: "CANARY" }]) {
    const value = { ...original, observations: [{ ...original.observations[0], ...patch }] };
    await writeFile(path, JSON.stringify(value));
    const before = await snapshotTree(root);
    assert.equal((await readReadObservations(root, "codex", sessionId)).state, "invalid");
    assert.equal(await snapshotTree(root), before);
  }
  const outside = join(root, "outside"); await writeFile(outside, JSON.stringify(original));
  await rm(path); await symlink(outside, path);
  assert.equal((await readReadObservations(root, "codex", sessionId)).state, "refused");
});

test("observation journals preserve 0.153.2 history and carry the exact 0.153.3 version through staging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-read-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = createSessionId("codex", "fixture");
  const base = { projectRoot: root, provider: "codex" as const, nativeSessionId: "fixture", toolName: "Bash", toolInput: {}, turn: { kind: "codex" as const, turn_id: "turn" } };
  await observeHookRead({ ...base, toolUseId: "old" }, "committed", "model_delivery_verified", "0.153.2");
  const call = { ...base, toolUseId: "desktop" };
  await observeHookRead(call, "reserved", "reserved", "0.153.3");
  await observeHookRead(call, "staged", "candidate_staged");
  let read = await readReadObservations(root, "codex", sessionId);
  assert.ok(read.state === "ok");
  assert.equal(read.journal.observations.find((row) => row.state === "staged")?.producer_version, "0.153.3");
  await observeHookRead(call, "committed", "model_delivery_verified", "0.153.3");
  read = await readReadObservations(root, "codex", sessionId);
  assert.ok(read.state === "ok");
  assert.deepEqual(new Set(read.journal.observations.map((row) => row.producer_version)), new Set(["0.153.2", "0.153.3"]));
  const desktop = read.journal.observations.find((row) => row.producer_version === "0.153.3")!;
  assert.equal(desktop.adapter, "codex-0.153.3-literal-exec");
  const path = join(root, ".barbaro/logs/delivery/codex", `${sessionId}.json`);
  for (const patch of [{ producer_version: "0.153.2" }, { producer_version: undefined }, { adapter: "codex-0.153.2-literal-exec" }]) {
    await writeFile(path, JSON.stringify({ ...read.journal, observations: [{ ...desktop, ...patch }] }));
    const before = await snapshotTree(root);
    assert.equal((await readReadObservations(root, "codex", sessionId)).state, "invalid", "producer/adapter mismatch must refuse");
    assert.equal(await snapshotTree(root), before);
  }
});

test("native resource observations validate measured bounds without accepting extra data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "barbaro-native-limit-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = createSessionId("codex", "fixture");
  const call = { projectRoot: root, provider: "codex" as const, nativeSessionId: "fixture", toolName: "Bash", toolInput: {}, toolUseId: "limit", turn: { kind: "codex" as const, turn_id: "turn" } };
  const limit = { kind: "file" as const, observed_bytes: 134217729, maximum_bytes: 134217728 };
  await observeHookRead(call, "refused", "native_trace_limit", undefined, limit);
  const valid = await readReadObservations(root, "codex", sessionId);
  assert.ok(valid.state === "ok");
  assert.deepEqual(valid.journal.observations[0]?.native_trace_limit, limit);
  assert.equal(valid.journal.schema, "barbaro.read-observation.v1");
  const path = join(root, ".barbaro/logs/delivery/codex", `${sessionId}.json`);
  for (const patch of [
    { native_trace_limit: undefined }, { reason: "unsupported_producer_or_shape" },
    { native_trace_limit: { ...limit, observed_bytes: limit.maximum_bytes } },
    { native_trace_limit: { ...limit, maximum_bytes: "134217728" } },
    { native_trace_limit: { ...limit, kind: "unknown" } },
    { native_trace_limit: { ...limit, path: "NATIVE_PATH_MUST_NOT_APPEAR" } },
  ]) {
    await writeFile(path, JSON.stringify({ ...valid.journal, observations: [{ ...valid.journal.observations[0], ...patch }] }));
    const before = await snapshotTree(root);
    assert.equal((await readReadObservations(root, "codex", sessionId)).state, "invalid");
    assert.equal(await snapshotTree(root), before);
  }
});
