import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { checkGitignore, inspectGitignore } from "../../src/setup/index.js";

import { withFixtureRoot, writeFiles } from "./fixture.js";

test("a plain .barbaro/ entry passes and names the matched pattern", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, {
      ".gitignore": "# derived state\n.barbaro/\nnode_modules/\n",
    });
    const diagnostic = await checkGitignore({ projectRoot: root });
    assert.equal(diagnostic.status, "pass");
    assert.match(diagnostic.summary, /\.barbaro\//);
    assert.deepEqual(diagnostic.remediation, []);
  });
});

test("anchored and unslashed forms are recognized", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, { ".gitignore": "/.barbaro\n" });
    const inspection = await inspectGitignore({ projectRoot: root });
    assert.equal(inspection.matchedPattern, "/.barbaro");
    assert.equal(inspection.negated, false);
  });
});

test("a missing .gitignore fails: session excerpts would be committable", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, { "package.json": "{}\n" });
    await rm(join(root, ".gitignore"), { force: true });
    const diagnostic = await checkGitignore({ projectRoot: root });
    assert.equal(diagnostic.status, "fail");
    assert.match(diagnostic.remediation.join(" "), /\.barbaro\//);
  });
});

test("an unrelated .gitignore fails", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, { ".gitignore": "dist/\nnode_modules/\n" });
    const diagnostic = await checkGitignore({ projectRoot: root });
    assert.equal(diagnostic.status, "fail");
    assert.equal(
      diagnostic.facts.find((fact) => fact.key === "matched_pattern")?.value,
      null,
    );
  });
});

test("a later negation defeats the ignore and fails", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, { ".gitignore": ".barbaro/\n!.barbaro\n" });
    const diagnostic = await checkGitignore({ projectRoot: root });
    assert.equal(diagnostic.status, "fail");
    assert.match(diagnostic.summary, /negation/);
  });
});

test("comments and blank lines are ignored", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, {
      ".gitignore": "\n\n#.barbaro/\n\n   .barbaro/   \n",
    });
    const diagnostic = await checkGitignore({ projectRoot: root });
    assert.equal(diagnostic.status, "pass");
  });
});
