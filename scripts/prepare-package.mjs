#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedInputs = [
  ".agents",
  ".claude",
  "ALPHA.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs",
  "examples",
  "spec",
  "src",
  "INSTALL.md",
  "LICENSE",
  "README.md",
  "package-lock.json",
  "package.json",
  "scripts/check-release-version.mjs",
  "scripts/generate-readme-assets.mjs",
  "scripts/prepare-package.mjs",
  "scripts/write-build-identity.mjs",
  "test/tui/fixtures/dashboard-once-still-64x28.txt",
  "tsconfig.package.json",
  "tsconfig.json",
];

const status = spawnSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all", "--", ...packagedInputs],
  {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  },
);

if (status.error !== undefined) throw status.error;
if (status.status !== 0) {
  throw new Error(
    `cannot verify package inputs with git (exit ${String(status.status)}): ${status.stderr.trim()}`,
  );
}
if (status.stdout.trim().length > 0) {
  process.stderr.write(
    "refusing to package dirty inputs; commit or restore these paths first:\n" +
      `${status.stdout.trimEnd()}\n`,
  );
  process.exitCode = 1;
} else {
  const dist = join(projectRoot, "dist");
  if (dirname(dist) !== projectRoot || basename(dist) !== "dist") {
    throw new Error(`refusing to clean unexpected output path: ${dist}`);
  }
  await rm(dist, { recursive: true, force: true });
}
