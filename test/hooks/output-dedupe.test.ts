import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  link,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  appendUniqueJsonl,
  UnsafeDirectoryLockPathError,
  UnsafeDerivedOutputPathError,
} from "../../src/output/jsonl-store.js";
import {
  DirectoryLockReleaseError,
  withDirectoryLock,
} from "../../src/output/directory-lock.js";

const execFileAsync = promisify(execFile);

test("lock cleanup failures preserve an already-committed result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-lock-release-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const resource = join(directory, "committed.json");
  const error = await withDirectoryLock(resource, async () => {
    await writeFile(resource, "committed\n", "utf8");
    await writeFile(join(`${resource}.lock`, "prevent-release"), "held\n");
    return { committed: true } as const;
  }).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof DirectoryLockReleaseError);
  assert.deepEqual(error.result, { committed: true });
  assert.equal(await readFile(resource, "utf8"), "committed\n");
});

test("evidence dedupe uses the caller's evidence ID, not its parent turn ID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-evidence-dedupe-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "evidence.jsonl");
  const records = [
    {
      evidence_id: "ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      turn_id: "turn_11111111111111111111111111111111",
      kind: "response",
    },
    {
      evidence_id: "ev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      turn_id: "turn_11111111111111111111111111111111",
      kind: "usage",
    },
  ];

  assert.deepEqual(
    await appendUniqueJsonl(path, records, (record) => record.evidence_id),
    { appended: 2, skipped: 0, conflicted: 0, conflictedIds: [] },
  );
  assert.deepEqual(
    await appendUniqueJsonl(path, records, (record) => record.evidence_id),
    { appended: 0, skipped: 2, conflicted: 0, conflictedIds: [] },
  );

  const persisted = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { evidence_id: string });
  assert.deepEqual(
    persisted.map((record) => record.evidence_id),
    records.map((record) => record.evidence_id),
  );
});

test("a stable ID cannot silently change its canonical record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-output-conflict-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "feed.jsonl");
  const turnId = "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await appendUniqueJsonl(
    path,
    [{ turn_id: turnId, summary: "original" }],
    (record) => record.turn_id,
  );

  // The invariant is about the BYTES, not about throwing: a published record
  // is never rewritten. It must also not be silent — the drift is counted and
  // reported. Aborting the batch was the amplifier that turned one mutable
  // record into a multi-hour publishing outage, so a conflict now costs only
  // the conflicting record.
  const result = await appendUniqueJsonl(
    path,
    [
      { summary: "changed", turn_id: turnId },
      { summary: "healthy", turn_id: "turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ],
    (record) => record.turn_id,
  );
  assert.equal(result.conflicted, 1);
  // Naming the record is what makes the defect fixable.
  assert.deepEqual(result.conflictedIds, [turnId]);
  assert.equal(result.skipped, 1);
  // The unrelated record in the same batch is not held hostage.
  assert.equal(result.appended, 1);

  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) =>
    JSON.parse(line),
  );
  assert.deepEqual(lines[0], { summary: "original", turn_id: turnId });
  assert.equal(lines.length, 2);
});

test("a final-path symlink cannot redirect healing or append outside Barbaro", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-output-symlink-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const outputDirectory = join(directory, "feed");
  const outputPath = join(outputDirectory, "session.jsonl");
  const sentinel = join(directory, "external-sentinel.txt");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(sentinel, "external sentinel without newline", "utf8");
  await symlink(sentinel, outputPath);

  await assert.rejects(
    appendUniqueJsonl(
      outputPath,
      [{ turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      (record) => record.turn_id,
    ),
    UnsafeDerivedOutputPathError,
  );
  assert.equal(
    await readFile(sentinel, "utf8"),
    "external sentinel without newline",
  );
});

test("a final-path hard link cannot alias and modify an external sentinel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-output-hardlink-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const outputDirectory = join(directory, "feed");
  const outputPath = join(outputDirectory, "session.jsonl");
  const sentinel = join(directory, "external-sentinel.txt");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(sentinel, "external sentinel without newline", "utf8");
  try {
    await link(sentinel, outputPath);
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      ["EPERM", "ENOTSUP", "EXDEV"].includes(
        String((error as { code?: unknown }).code),
      )
    ) {
      t.skip("hard links are not supported by this filesystem");
      return;
    }
    throw error;
  }

  await assert.rejects(
    appendUniqueJsonl(
      outputPath,
      [{ turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      (record) => record.turn_id,
    ),
    UnsafeDerivedOutputPathError,
  );
  assert.equal(
    await readFile(sentinel, "utf8"),
    "external sentinel without newline",
  );
});

test("symlinked .barbaro feed and evidence parents cannot create external locks or output", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-output-parent-project-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-output-parent-outside-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const barbaro = join(project, ".barbaro");
  await mkdir(barbaro, { mode: 0o700 });

  for (const subtree of ["feed", "evidence"] as const) {
    const externalParent = join(outside, subtree, "codex");
    await mkdir(externalParent, { recursive: true, mode: 0o700 });
    const sentinel = join(externalParent, "session.jsonl");
    await writeFile(sentinel, `${subtree} sentinel\n`, { mode: 0o600 });
    await symlink(join(outside, subtree), join(barbaro, subtree), "dir");

    await assert.rejects(
      appendUniqueJsonl(
        join(barbaro, subtree, "codex", "session.jsonl"),
        [{ turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        (record) => record.turn_id,
      ),
      UnsafeDirectoryLockPathError,
    );
    assert.equal(await readFile(sentinel, "utf8"), `${subtree} sentinel\n`);
    assert.deepEqual(await readdir(externalParent), ["session.jsonl"]);
  }
});

test("symlinked .barbaro/state cannot create an external runner lock", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-lock-parent-project-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-lock-parent-outside-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const barbaro = join(project, ".barbaro");
  await mkdir(barbaro, { mode: 0o700 });
  await symlink(outside, join(barbaro, "state"), "dir");
  const externalCodex = join(outside, "codex");
  await mkdir(externalCodex, { mode: 0o700 });
  const sentinel = join(externalCodex, "runner.json");
  await writeFile(sentinel, "state sentinel\n", { mode: 0o600 });
  let invoked = false;

  await assert.rejects(
    withDirectoryLock(
      join(barbaro, "state", "codex", "runner.json.ingest"),
      async () => {
        invoked = true;
      },
    ),
    UnsafeDirectoryLockPathError,
  );
  assert.equal(invoked, false);
  assert.equal(await readFile(sentinel, "utf8"), "state sentinel\n");
  assert.deepEqual(await readdir(externalCodex), ["runner.json"]);
});

test("simultaneous processes append one physical row per stable ID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-output-processes-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const outputPath = join(directory, "feed", "session.jsonl");
  const moduleUrl = new URL(
    "../../src/output/jsonl-store.js",
    import.meta.url,
  ).href;
  const script = [
    `import { appendUniqueJsonl } from ${JSON.stringify(moduleUrl)};`,
    "const outputPath = process.argv[1];",
    "const records = [1, 2, 3].map((value) => ({ turn_id: `turn_${String(value).repeat(32)}`, value }));",
    "await appendUniqueJsonl(outputPath, records, (record) => record.turn_id);",
  ].join("\n");

  await Promise.all(
    Array.from({ length: 8 }, () =>
      execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", script, outputPath],
        { timeout: 10_000 },
      ),
    ),
  );

  const rows = (await readFile(outputPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { turn_id: string });
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.turn_id)).size, 3);
});

test("a lock left by a dead local process is recovered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-output-stale-lock-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const outputPath = join(directory, "feed", "session.jsonl");
  const lockDirectory = `${outputPath}.lock`;
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      schema: "barbaro.directory-lock.v1",
      pid: 2_000_000_000,
      hostname: hostname(),
      token: "a".repeat(32),
      acquired_at: "2026-08-16T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  assert.deepEqual(
    await appendUniqueJsonl(
      outputPath,
      [{ turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      (record) => record.turn_id,
    ),
    { appended: 1, skipped: 0, conflicted: 0, conflictedIds: [] },
  );
  assert.equal(
    JSON.parse((await readFile(outputPath, "utf8")).trim()).turn_id,
    "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});
