import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  InvalidWorkstreamNameError,
  WorkstreamNameTakenError,
  WorkstreamNotFoundError,
  WorkstreamStore,
  WORKSTREAM_SCHEMA,
} from "../../src/workstreams/index.js";

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

async function temporaryProject(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-workstreams-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
