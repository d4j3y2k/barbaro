import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ActiveLeaseStore } from "../../src/active/store.js";
import {
  InvalidWorkstreamNameError,
  WorkstreamNameTakenError,
  WorkstreamNotFoundError,
  WorkstreamStore,
  WORKSTREAM_SCHEMA,
} from "../../src/workstreams/index.js";
import { collectWorkstreamPresence } from "../../src/workstreams/store.js";

const WS_ID = /^ws_[0-9a-f]{32}$/u;

test("creating a workstream writes a record and a name claim", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  const created = await store.create({
    name: "tui-design",
    title: "  Control-terminal design  ",
    createdBy: { kind: "cli" },
    now: new Date("2026-08-21T05:00:00.000Z"),
  });
  assert.match(created.workstream_id, WS_ID);
  assert.equal(created.schema, WORKSTREAM_SCHEMA);
  assert.equal(created.name, "tui-design");
  assert.equal(created.title, "Control-terminal design");
  assert.equal(created.status, "open");
  assert.equal(created.revision, 1);
  assert.equal(created.created_at, "2026-08-21T05:00:00.000Z");
  assert.deepEqual(created.created_by, { kind: "cli" });

  const record = JSON.parse(
    await readFile(
      join(root, ".barbaro", "workstreams", `${created.workstream_id}.json`),
      "utf8",
    ),
  ) as unknown;
  assert.deepEqual(record, created);
  const claim = JSON.parse(
    await readFile(
      join(root, ".barbaro", "workstreams", "names", "tui-design"),
      "utf8",
    ),
  ) as { workstream_id: string };
  assert.equal(claim.workstream_id, created.workstream_id);

  assert.deepEqual(await store.get(created.workstream_id), created);
  assert.deepEqual(await store.resolve("tui-design"), created);
  assert.deepEqual(await store.resolve(created.workstream_id), created);
  assert.equal(await store.resolve("release"), undefined);
  assert.equal(await store.resolve("Not A Slug"), undefined);
});

test("a name stays taken while open and after completion", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  const first = await store.create({ name: "lane", createdBy: { kind: "cli" } });
  await assert.rejects(
    store.create({ name: "lane", createdBy: { kind: "cli" } }),
    (error: unknown) =>
      error instanceof WorkstreamNameTakenError &&
      error.existing.workstream_id === first.workstream_id,
  );
  const completed = await store.setStatus("lane", "completed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 2);
  await assert.rejects(
    store.create({ name: "lane", createdBy: { kind: "cli" } }),
    WorkstreamNameTakenError,
  );
  // Idempotent status change, then reopen.
  assert.deepEqual(await store.setStatus("lane", "completed"), completed);
  const reopened = await store.setStatus(first.workstream_id, "open");
  assert.equal(reopened.status, "open");
  assert.equal(reopened.revision, 3);
  await assert.rejects(
    store.setStatus("missing", "completed"),
    WorkstreamNotFoundError,
  );
});

test("workstream names are validated slugs", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  for (const invalid of ["TUI", "-lead", "trail-", "a b", "a".repeat(65), ""]) {
    await assert.rejects(
      store.create({ name: invalid, createdBy: { kind: "cli" } }),
      InvalidWorkstreamNameError,
      JSON.stringify(invalid),
    );
  }
  await assert.rejects(access(join(root, ".barbaro")), { code: "ENOENT" });
  for (const valid of ["a", "a1", "tui-design", "x".repeat(64)]) {
    const created = await store.create({ name: valid, createdBy: { kind: "cli" } });
    assert.equal(created.name, valid);
  }
});

test("listing reads records, sorts by name, and never creates the store", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(access(join(root, ".barbaro")), { code: "ENOENT" });

  await store.create({ name: "zeta", createdBy: { kind: "cli" } });
  await store.create({
    name: "alpha",
    createdBy: {
      provider: "codex",
      session_id: "ses_0123456789abcdef0123456789abcdef",
    },
  });
  const names = (await store.list()).map((workstream) => workstream.name);
  assert.deepEqual(names, ["alpha", "zeta"]);

  // A corrupt record is reported, not fatal.
  await writeFile(
    join(root, ".barbaro", "workstreams", "ws_ffffffffffffffffffffffffffffffff.json"),
    "{ not json",
    "utf8",
  );
  const invalid: string[] = [];
  const listed = await store.list((path) => {
    invalid.push(path);
  });
  assert.equal(listed.length, 2);
  assert.equal(invalid.length, 1);
});

test("a stale name claim is ignored by readers and repaired by the next creator", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  const names = join(root, ".barbaro", "workstreams", "names");
  await mkdir(names, { recursive: true });

  // Claim with no record: a creator that crashed between claim and record.
  await writeFile(
    join(names, "orphan"),
    JSON.stringify({ workstream_id: "ws_00000000000000000000000000000000" }),
    "utf8",
  );
  assert.equal(await store.resolve("orphan"), undefined);
  const repaired = await store.create({ name: "orphan", createdBy: { kind: "cli" } });
  assert.deepEqual(await store.resolve("orphan"), repaired);

  // Claim pointing at a record that carries a different name.
  const real = await store.create({ name: "real", createdBy: { kind: "cli" } });
  await writeFile(
    join(names, "alias"),
    JSON.stringify({ workstream_id: real.workstream_id }),
    "utf8",
  );
  assert.equal(await store.resolve("alias"), undefined);
  const fresh = await store.create({ name: "alias", createdBy: { kind: "cli" } });
  assert.notEqual(fresh.workstream_id, real.workstream_id);
  assert.deepEqual(await store.resolve("alias"), fresh);
  assert.deepEqual(await store.resolve("real"), real);
});

test("concurrent creators of one name produce exactly one workstream", async (t) => {
  const root = await temporaryProject(t);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      new WorkstreamStore(root).create({ name: "race", createdBy: { kind: "cli" } }),
    ),
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 7);
  for (const result of rejected) {
    assert.ok(
      (result as PromiseRejectedResult).reason instanceof WorkstreamNameTakenError,
    );
  }
  const listed = await new WorkstreamStore(root).list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.name, "race");
});

test("complete and reopen are named idempotent lifecycle transitions", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  const created = await store.create({ name: "lane", createdBy: { kind: "cli" } });

  const completed = await store.complete(
    "lane",
    new Date("2026-08-25T15:00:00.000Z"),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 2);
  assert.equal(completed.updated_at, "2026-08-25T15:00:00.000Z");

  // Idempotent: an unchanged status returns the record untouched.
  assert.deepEqual(await store.complete(created.workstream_id), completed);

  const reopened = await store.reopen(created.workstream_id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.revision, 3);
  assert.deepEqual(await store.reopen("lane"), reopened);

  await assert.rejects(
    store.complete("missing"),
    WorkstreamNotFoundError,
  );
  await assert.rejects(store.reopen("ws_" + "0".repeat(32)), WorkstreamNotFoundError);
});

const PRESENCE_WS = `ws_${"a".repeat(32)}`;
const OTHER_WS = `ws_${"b".repeat(32)}`;
const LIVE_SESSION = `ses_${"1".repeat(32)}`;
const IDLE_SESSION = `ses_${"2".repeat(32)}`;
const EXPIRED_SESSION = `ses_${"3".repeat(32)}`;
const MOVED_SESSION = `ses_${"4".repeat(32)}`;

async function writeParticipation(
  root: string,
  provider: string,
  sessionId: string,
  workstreamId: string,
): Promise<void> {
  const path = join(root, ".barbaro", "sessions", provider, `${sessionId}.json`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schema: "barbaro.session-participation.v2",
      provider,
      session_id: sessionId,
      joined_at: "2026-08-25T09:00:00.000Z",
      initiated_by: "user_prompt",
      workstream_id: workstreamId,
    }),
    "utf8",
  );
}

async function writeLease(
  root: string,
  sessionId: string,
  agentId: string,
  state: "working" | "waiting" | "idle",
  options: { readonly now: number; readonly ttlMs: number },
): Promise<void> {
  await new ActiveLeaseStore(join(root, ".barbaro", "active")).write(
    {
      lease_id: `lease_${sessionId.slice(4, 20)}${agentId === "main" ? "0".repeat(16) : "f".repeat(16)}`,
      provider: "codex",
      session_id: sessionId,
      agent_id: agentId,
      workstream_id: PRESENCE_WS,
      state,
      claims: [],
      unknown_write_scope: false,
    },
    options,
  );
}

test("presence reports current members from unexpired main snapshots only", async (t) => {
  const root = await temporaryProject(t);
  const now = Date.parse("2026-08-25T15:00:00.000Z");

  await writeParticipation(root, "codex", LIVE_SESSION, PRESENCE_WS);
  await writeParticipation(root, "codex", IDLE_SESSION, PRESENCE_WS);
  await writeParticipation(root, "codex", EXPIRED_SESSION, PRESENCE_WS);
  // Moved: its current membership is elsewhere, so its live lease may not
  // warn for the workstream it left.
  await writeParticipation(root, "codex", MOVED_SESSION, OTHER_WS);

  await writeLease(root, LIVE_SESSION, "main", "working", {
    now,
    ttlMs: 600_000,
  });
  // A live child lease under the live session never adds a second warning.
  await writeLease(root, LIVE_SESSION, "child-1", "working", {
    now,
    ttlMs: 600_000,
  });
  await writeLease(root, IDLE_SESSION, "main", "idle", {
    now,
    ttlMs: 600_000,
  });
  await writeLease(root, EXPIRED_SESSION, "main", "working", {
    now: now - 10_000,
    ttlMs: 1_000,
  });
  await writeLease(root, MOVED_SESSION, "main", "working", {
    now,
    ttlMs: 600_000,
  });

  const presence = await collectWorkstreamPresence(root, new Date(now));
  assert.equal(presence.liveness_unknown, false);

  const report = presence.byWorkstream.get(PRESENCE_WS);
  assert.ok(report !== undefined);
  assert.equal(report.liveness_unknown, false);
  assert.deepEqual(report.members, [
    { provider: "codex", session_id: LIVE_SESSION, presence: "live" },
    { provider: "codex", session_id: IDLE_SESSION, presence: "present" },
  ]);

  const moved = presence.byWorkstream.get(OTHER_WS);
  assert.deepEqual(moved?.members, [
    { provider: "codex", session_id: MOVED_SESSION, presence: "live" },
  ]);
});

test("unreadable membership or active input turns liveness unknown", async (t) => {
  const root = await temporaryProject(t);
  await writeParticipation(root, "codex", LIVE_SESSION, PRESENCE_WS);
  const broken = join(
    root,
    ".barbaro",
    "sessions",
    "codex",
    `${IDLE_SESSION}.json`,
  );
  await mkdir(join(broken, ".."), { recursive: true });
  await writeFile(broken, "not json", "utf8");

  const presence = await collectWorkstreamPresence(root);
  assert.equal(presence.liveness_unknown, true);
  const report = presence.byWorkstream.get(PRESENCE_WS);
  assert.equal(report?.liveness_unknown, true);
  // The parseable membership is still reported; nothing is invented for the
  // unreadable one.
  assert.deepEqual(report?.members, []);
});

async function temporaryProject(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-workstreams-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
