import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleClaudeHookFailOpen } from "../../src/hooks/claude.js";
import {
  INCIDENT_SCHEMA,
  recordIncident,
  type BarbaroIncidentV1,
} from "../../src/hooks/incidents.js";

/** A project already using Barbaro: the store exists. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-incidents-"));
  await mkdir(join(root, ".barbaro"), { recursive: true });
  return root;
}

async function incidents(
  root: string,
  provider: string,
): Promise<BarbaroIncidentV1[]> {
  const dir = join(root, ".barbaro", "logs", "incidents", provider);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BarbaroIncidentV1[] = [];
  for (const name of names.sort()) {
    out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
  }
  return out;
}

test("a dormant session is reported without ever naming the session", async () => {
  const root = await project();
  await recordIncident({
    projectRoot: root,
    provider: "claude",
    kind: "session_dormant",
    event: "PreToolUse",
    dedupKey: "session-abc",
  });

  const found = await incidents(root, "claude");
  assert.equal(found.length, 1);
  const [incident] = found;
  assert.ok(incident);
  assert.equal(incident.schema, INCIDENT_SCHEMA);
  assert.equal(incident.kind, "session_dormant");
  assert.equal(incident.event, "PreToolUse");

  // The whole point: a session that refused to publish is not published. The
  // id salts the dedup key and must appear nowhere in the record.
  assert.doesNotMatch(JSON.stringify(incident), /session-abc/u);
  assert.equal("session_id" in incident, false);
});

test("repeats collapse: a hook firing per tool call cannot grow the store", async () => {
  const root = await project();
  for (let i = 0; i < 25; i += 1) {
    await recordIncident({
      projectRoot: root,
      provider: "claude",
      kind: "session_dormant",
      event: "PreToolUse",
      dedupKey: "session-abc",
    });
  }
  assert.equal((await incidents(root, "claude")).length, 1);

  // A genuinely different condition is still its own marker.
  await recordIncident({
    projectRoot: root,
    provider: "claude",
    kind: "session_dormant",
    event: "PreToolUse",
    dedupKey: "session-xyz",
  });
  assert.equal((await incidents(root, "claude")).length, 2);
});

test("a swallowed hook failure leaves a marker behind", async () => {
  const root = await project();
  // Missing session_id makes the handler throw; fail-open swallows it.
  await handleClaudeHookFailOpen({
    hook_event_name: "PreToolUse",
    cwd: root,
  });

  const found = await incidents(root, "claude");
  assert.equal(found.length, 1);
  const [incident] = found;
  assert.ok(incident);
  assert.equal(incident.kind, "hook_error");
  assert.equal(incident.event, "PreToolUse");
  assert.match(incident.detail?.text ?? "", /session_id/u);
});

test("a project that never opted in gets no .barbaro directory", async () => {
  // Hooks can be configured at user level and will fire in projects that never
  // chose Barbaro. The store must never appear unbidden: it is required to be
  // gitignored before enabling, so creating it here could get it committed.
  const root = await mkdtemp(join(tmpdir(), "barbaro-untouched-"));
  await recordIncident({
    projectRoot: root,
    provider: "claude",
    kind: "session_dormant",
    event: "PreToolUse",
    dedupKey: "session-abc",
  });
  await assert.rejects(access(join(root, ".barbaro")), { code: "ENOENT" });
});

test("recording never throws, whatever the caller passes", async () => {
  // A marker must never be the reason a coding turn fails.
  await recordIncident({
    projectRoot: "",
    provider: "claude",
    kind: "hook_error",
  });
  await recordIncident({
    projectRoot: "/nonexistent/path/that/cannot/be/created/\0bad",
    provider: "claude",
    kind: "hook_error",
    detail: "boom",
  });
});
