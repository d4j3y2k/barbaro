import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkWorkspaceIsolation,
  inspectWorkspaceIsolation,
} from "../../src/setup/index.js";

import { makeDirectories, withFixtureRoot, writeFiles } from "./fixture.js";

test("a workspace without Git warns and demands disjoint ownership", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, { "package.json": "{}\n" });

    const diagnostic = await checkWorkspaceIsolation({ projectRoot: root });
    assert.equal(diagnostic.status, "warn");
    assert.match(diagnostic.summary, /worktree isolation are unavailable/);
    assert.match(diagnostic.remediation.join(" "), /disjoint/);
    assert.match(diagnostic.remediation.join(" "), /never edit \.barbaro\//);
    assert.equal(
      diagnostic.facts.find((fact) => fact.key === "isolation_available")?.value,
      false,
    );
    assert.equal(
      diagnostic.facts.find((fact) => fact.key === "lease_semantics")?.value,
      "advisory",
    );
  });
});

test("a repository directory reports available isolation", async () => {
  await withFixtureRoot(async (root) => {
    await makeDirectories(root, [".git"]);
    const inspection = await inspectWorkspaceIsolation({ projectRoot: root });
    assert.equal(inspection.gitKind, "directory");
    assert.equal(inspection.isolationAvailable, true);

    const diagnostic = await checkWorkspaceIsolation({ projectRoot: root });
    assert.equal(diagnostic.status, "pass");
    assert.match(diagnostic.remediation.join(" "), /advisory/);
  });
});

test("a linked worktree file is recognized as isolated", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, { ".git": "gitdir: /elsewhere/.git/worktrees/lane\n" });
    const diagnostic = await checkWorkspaceIsolation({ projectRoot: root });
    assert.equal(diagnostic.status, "pass");
    assert.match(diagnostic.summary, /Linked Git worktree/);
    assert.equal(
      diagnostic.facts.find((fact) => fact.key === "git_kind")?.value,
      "worktree-file",
    );
  });
});

test("disjoint ownership is required regardless of isolation", async () => {
  await withFixtureRoot(async (root) => {
    await makeDirectories(root, [".git"]);
    const withGit = await inspectWorkspaceIsolation({ projectRoot: root });
    assert.equal(withGit.requiresDisjointOwnership, true);
  });
});
