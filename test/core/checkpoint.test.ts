import assert from "node:assert/strict";
import {
  appendFile,
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createJsonlCheckpoint,
  resolveJsonlCheckpoint,
} from "../../src/core/checkpoint.js";
import { readJsonlForward } from "../../src/core/jsonl-reader.js";

const testDirectory = await mkdtemp(join(tmpdir(), "barbaro-checkpoint-"));

after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

test("resumes an appended file from the last complete line", async () => {
  const filePath = join(testDirectory, "resume.jsonl");
  await writeFile(filePath, '{"first":1}\n{"partial":', "utf8");
  const summary = await readJsonlForward(filePath, () => undefined);
  const checkpoint = createJsonlCheckpoint(summary);

  await appendFile(filePath, "true}\n", "utf8");
  const resolution = await resolveJsonlCheckpoint(filePath, checkpoint);

  assert.equal(resolution.status, "resume");
  assert.equal(resolution.startOffset, 12);
  assert.equal(resolution.nextLineNumber, 2);
});

test("detects rename/create rotation using file identity", async () => {
  const filePath = join(testDirectory, "rotated.jsonl");
  const oldPath = join(testDirectory, "rotated.jsonl.1");
  await writeFile(filePath, '{"old":true}\n', "utf8");
  const summary = await readJsonlForward(filePath, () => undefined);
  const checkpoint = createJsonlCheckpoint(summary);

  await rename(filePath, oldPath);
  await writeFile(filePath, '{"new":true}\n', "utf8");
  const resolution = await resolveJsonlCheckpoint(filePath, checkpoint);

  assert.equal(resolution.status, "rotated");
  assert.equal(resolution.startOffset, 0);
  assert.equal(resolution.nextLineNumber, 1);
});

test("detects same-file truncation even when the committed offset still fits", async () => {
  const filePath = join(testDirectory, "truncated.jsonl");
  await writeFile(filePath, '{"ok":1}\nunfinished-data', "utf8");
  const summary = await readJsonlForward(filePath, () => undefined);
  const checkpoint = createJsonlCheckpoint(summary);
  assert.ok(checkpoint.byte_offset < checkpoint.observed_size);

  await truncate(filePath, checkpoint.byte_offset);
  const resolution = await resolveJsonlCheckpoint(filePath, checkpoint);

  assert.equal(resolution.status, "truncated");
  assert.equal(resolution.startOffset, 0);
});

test("detects a same-inode rewrite from the pre-offset anchor", async () => {
  const filePath = join(testDirectory, "rewritten.jsonl");
  await writeFile(filePath, '{"value":"aaaa"}\n', "utf8");
  const summary = await readJsonlForward(filePath, () => undefined);
  const checkpoint = createJsonlCheckpoint(summary);

  await writeFile(filePath, '{"value":"bbbb"}\n', "utf8");
  const resolution = await resolveJsonlCheckpoint(filePath, checkpoint);

  assert.equal(resolution.status, "rewritten");
  assert.equal(resolution.startOffset, 0);
});

test("reports missing paths without throwing", async () => {
  const resolution = await resolveJsonlCheckpoint(
    join(testDirectory, "does-not-exist.jsonl"),
  );
  assert.deepEqual(resolution, {
    status: "missing",
    startOffset: 0,
    nextLineNumber: 1,
  });
});

test("starts from zero when no checkpoint exists", async () => {
  const filePath = join(testDirectory, "new.jsonl");
  await writeFile(filePath, "{}\n", "utf8");
  const resolution = await resolveJsonlCheckpoint(filePath);

  assert.equal(resolution.status, "start");
  assert.equal(resolution.startOffset, 0);
  assert.equal(resolution.nextLineNumber, 1);
  assert.equal(resolution.snapshot?.size, 3);
});

test("safe resolution refuses final symlinks, hard links, and oversized files", async () => {
  const target = join(testDirectory, "safe-target.jsonl");
  await writeFile(target, "{}\n", "utf8");

  const symbolic = join(testDirectory, "safe-symbolic.jsonl");
  await symlink(target, symbolic, "file");
  await assert.rejects(
    resolveJsonlCheckpoint(symbolic, undefined, { noFollow: true }),
  );

  const hard = join(testDirectory, "safe-hard.jsonl");
  await link(target, hard);
  await assert.rejects(
    resolveJsonlCheckpoint(hard, undefined, { requireSingleLink: true }),
    /multiple hard links/u,
  );
  await assert.rejects(
    resolveJsonlCheckpoint(target, undefined, { maxFileBytes: 2 }),
    /exceeds 2 bytes/u,
  );
});
