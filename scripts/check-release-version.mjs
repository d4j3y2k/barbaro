#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [manifest, lockfile] = await Promise.all(
  ["package.json", "package-lock.json"].map(async (name) =>
    JSON.parse(await readFile(join(projectRoot, name), "utf8")),
  ),
);

assert.equal(
  typeof manifest.version,
  "string",
  "package.json version must be a string",
);
assert.notEqual(manifest.version.length, 0, "package.json version must not be empty");
assert.equal(
  lockfile.version,
  manifest.version,
  "package-lock.json version must match package.json",
);
assert.equal(
  lockfile.packages?.[""]?.version,
  manifest.version,
  "package-lock.json root package version must match package.json",
);

const githubTag =
  process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : process.env.GITHUB_REF?.startsWith("refs/tags/")
      ? process.env.GITHUB_REF.slice("refs/tags/".length)
      : undefined;

if (githubTag !== undefined) {
  assert.equal(
    githubTag,
    `v${manifest.version}`,
    "Git tag must be v followed by the package version",
  );
}

process.stdout.write(
  `release metadata ok: ${manifest.name}@${manifest.version}${githubTag === undefined ? "" : ` (${githubTag})`}\n`,
);
