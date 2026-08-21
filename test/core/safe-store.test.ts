import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SafeStoreBoundary,
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../../src/core/safe-store.js";

test("project boundary rejects a symlinked .barbaro root", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-safe-root-project-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-safe-root-outside-"));
  try {
    await symlink(outside, join(project, ".barbaro"), "dir");
    const boundary = SafeStoreBoundary.forBarbaroProject(project);
    await assert.rejects(
      boundary.ensureDirectory(["active", "codex"]),
      (error: unknown) => error instanceof UnsafeStorePathError,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("bounded regular-file reads reject final symlinks and oversized data", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-safe-read-project-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-safe-read-outside-"));
  try {
    const boundary = SafeStoreBoundary.forBarbaroProject(project);
    const directory = await boundary.ensureDirectory(["state"]);
    assert.equal((await stat(join(project, ".barbaro"))).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    const secret = join(outside, "secret.json");
    await writeFile(secret, "secret", { mode: 0o600 });
    await symlink(secret, join(directory, "linked.json"), "file");
    await assert.rejects(
      boundary.readUtf8File(["state", "linked.json"], 1024),
      (error: unknown) => error instanceof UnsafeStorePathError,
    );

    await writeFile(join(directory, "large.json"), "12345", { mode: 0o600 });
    await assert.rejects(
      boundary.readUtf8File(["state", "large.json"], 4),
      (error: unknown) => error instanceof StoreFileTooLargeError,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
