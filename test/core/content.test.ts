import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { normalizeRepoPath } from "../../src/core/content.js";

test("repo-path normalization matches the frozen POSIX wire contract", () => {
  const root = "/tmp/barbaro-workspace";
  assert.equal(normalizeRepoPath(root, join(root, "src", "index.ts")), "src/index.ts");
  assert.equal(normalizeRepoPath(root, "src/index.ts"), "src/index.ts");

  for (const unsafe of [
    "/etc/passwd",
    "../outside",
    "src/../../outside",
    "C:/Windows/system.ini",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\file",
    "src\\..\\outside",
    "src\\file.ts",
    "src\0outside",
  ]) {
    assert.equal(normalizeRepoPath(root, unsafe), undefined, unsafe);
  }
});
