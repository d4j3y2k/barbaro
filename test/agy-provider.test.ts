import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSessionId } from "../src/core/id.js";
import { admitHookSession } from "../src/hooks/participation.js";
import { readCommandArguments, resolveReadQuery } from "../src/nudge/read-query.js";
import { NudgeCursorStateStore } from "../src/nudge/store.js";
import { NUDGE_CURSOR_SCHEMA } from "../src/nudge/types.js";
import { claimHookNudge, inspectUnreadPeerTurns } from "../src/nudge/unread.js";
import { appendPeerTurn } from "./hooks/nudge-fixture.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("Antigravity reads the joined workstream as an independent peer alongside Claude and Codex", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-agy-provider-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const nativeId = "shared-native-id";
  const joined = new Date("2099-08-23T09:00:00.000Z");
  const agyId = createSessionId("agy", nativeId);
  const env = { ...process.env, ANTIGRAVITY_CONVERSATION_ID: nativeId };
  async function command(...args: string[]) {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args, "--project-root", project], { env });
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  }

  for (const provider of ["claude", "agy", "codex"] as const) {
    const admission = await admitHookSession({
      projectRoot: project, provider, nativeSessionId: nativeId, now: joined, event: "UserPromptSubmit",
      prompt: provider === "claude" ? "/barbaro new coordination" : "$barbaro join coordination",
    });
    assert.equal(admission.joined, true);
    assert.equal(admission.participation?.session_id, createSessionId(provider, nativeId));
    assert.ok(admission.participation?.workstream_id);
    await appendPeerTurn({
      projectRoot: project, provider, nativeSessionId: nativeId, workstreamId: admission.participation.workstream_id,
      sequence: 1, response: `update from ${provider}`,
    });
  }
  const foreign = await admitHookSession({
    projectRoot: project, provider: "agy", nativeSessionId: "second-agy", now: joined, event: "UserPromptSubmit",
    prompt: "$barbaro new elsewhere",
  });
  assert.ok(foreign.participation?.workstream_id);
  await appendPeerTurn({
    projectRoot: project, provider: "agy", nativeSessionId: "second-agy", workstreamId: foreign.participation.workstream_id,
    sequence: 1, response: "private to elsewhere",
  });

  const status = await command("agy", "status");
  assert.equal(status.joined, true);
  assert.equal(status.session_id, agyId);
  assert.equal(status.workstream.name, "coordination");
  assert.equal((await command("agy", "status", "--session-id", "second-agy")).workstream.name, "elsewhere");
  const explicit = await resolveReadQuery(["context", "--provider", "agy", "--session-id", agyId], project);
  const inferred = await resolveReadQuery(["context", "--provider", "agy"], project, nativeId);
  assert.deepEqual(inferred, explicit);
  assert.equal((await resolveReadQuery(["context"], project, nativeId)).recipient, undefined);
  assert.deepEqual(readCommandArguments('barbaro read context --provider agy --session-id "$ANTIGRAVITY_CONVERSATION_ID"', env),
    ["context", "--provider", "agy", "--session-id", nativeId]);
  const context = JSON.stringify(await command("read", "context", "--provider", "agy"));
  assert.match(context, /update from claude/u);
  assert.match(context, /update from codex/u);
  assert.doesNotMatch(context, /private to elsewhere/u);
  const reverse = JSON.stringify(await command("read", "context", "--provider", "claude", "--session-id", nativeId));
  assert.match(reverse, /update from agy/u);

  const watch = await command("watch", "--provider", "agy", "--once", "--json");
  assert.equal(watch.self_session_id, agyId);
  assert.equal(watch.workstream_id, status.workstream.workstream_id);
  for (const identity of [["--self", agyId], ["--provider", "agy"]]) {
    const result = await command("await", ...identity, "--json");
    assert.equal(result.kind, "unread");
    assert.equal(result.unread_count, 2);
  }

  const claimant = {
    projectRoot: project, provider: "agy" as const, nativeSessionId: nativeId,
    turn: { kind: "agy" as const, turn_id: `turn_${"a".repeat(32)}` }, marker: "user_prompt" as const,
  };
  const claim = await claimHookNudge(claimant);
  assert.equal(claim.status, "ready");
  assert.equal(claim.claimed, true);
  assert.equal(claim.unread_count, 2);
  const cursor = await new NudgeCursorStateStore(project).read("agy", agyId);
  assert.equal(cursor?.schema, NUDGE_CURSOR_SCHEMA);
  assert.deepEqual(cursor.delivery.last_turn, claimant.turn);
  const repeated = await claimHookNudge(claimant);
  assert.equal(repeated.status, "ready");
  assert.equal(repeated.claimed, false);
  const unread = await inspectUnreadPeerTurns(claimant);
  assert.equal(unread.status, "ready");
  assert.equal(unread.unread_count, 2);
});

test("Antigravity status finds the nearest coordination root unless a root is supplied", async (t) => {
  const outer = await mkdtemp(join(tmpdir(), "barbaro-agy-status-"));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const inner = join(outer, "nested");
  const cwd = join(inner, "src");
  await mkdir(cwd, { recursive: true });
  const nativeSessionId = "nested-session";
  for (const [projectRoot, name] of [[outer, "outer"], [inner, "inner"]] as const) {
    await admitHookSession({
      projectRoot, provider: "agy", nativeSessionId, event: "UserPromptSubmit",
      prompt: `$barbaro new ${name}`,
    });
  }
  async function status(...flags: string[]) {
    const { stdout } = await exec(process.execPath, [cli, "agy", "status", "--session-id", nativeSessionId, ...flags], { cwd });
    return JSON.parse(stdout);
  }
  assert.equal((await status()).workstream.name, "inner");
  assert.equal((await status("--project-root", outer)).workstream.name, "outer");
  assert.equal((await status("--project-root", cwd)).joined, false);
  // A nested Git checkout is a new boundary even before enrollment.
  await mkdir(join(cwd, ".git"));
  assert.equal((await status()).joined, false);
});
