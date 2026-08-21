import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { stableStringify } from "../../src/core/stable-json.js";
import {
  SETUP_DOCTOR_SCHEMA,
  formatSetupDoctorReport,
  runSetupDoctor,
} from "../../src/setup/index.js";

import {
  FIXTURE_NOW,
  makeDirectories,
  setMtime,
  snapshotTree,
  withFixtureRoot,
  writeFakeNode,
  writeFiles,
  writeHealthyProject,
} from "./fixture.js";

test("a fully wired project passes every check except isolation", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const report = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    assert.equal(report.schema, SETUP_DOCTOR_SCHEMA);
    assert.equal(report.generated_at, FIXTURE_NOW.toISOString());
    assert.deepEqual(
      report.diagnostics.map((diagnostic) => diagnostic.id),
      [
        "build.dist-freshness",
        "gitignore.barbaro-ignored",
        "hooks.claude",
        "hooks.codex",
        "views.coordination-state",
        "workspace.isolation",
      ],
    );
    // The fixture has no .git, which is exactly the dogfood situation: the
    // only remaining safeguard is disjoint ownership.
    assert.equal(report.status, "warn");
    assert.deepEqual(report.counts, { pass: 5, warn: 1, fail: 0 });
    assert.equal(
      report.diagnostics.find(
        (diagnostic) => diagnostic.id === "workspace.isolation",
      )?.status,
      "warn",
    );
    assert.ok(
      report.guidance.launch.some(
        (step) => step.id === "launch.disjoint-ownership",
      ),
    );
  });
});

test("adding a repository clears the isolation warning", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await makeDirectories(root, [".git"]);

    const report = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    assert.equal(report.status, "pass");
    assert.deepEqual(report.counts, { pass: 6, warn: 0, fail: 0 });
  });
});

test("the overall status is the worst diagnostic", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await makeDirectories(root, [".git"]);
    await rm(join(root, ".gitignore"), { force: true });
    await setMtime(root, "src/cli.ts", new Date(FIXTURE_NOW.getTime()));

    const report = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    assert.equal(report.status, "fail");
    assert.equal(report.counts.fail, 1);
    assert.equal(report.counts.warn, 1);
    assert.deepEqual(
      report.guidance.launch.slice(0, 2).map((step) => step.id),
      ["launch.build-first", "launch.ignore-store"],
    );
  });
});

test("two runs over unchanged state serialize identically", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const first = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    const second = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    assert.equal(stableStringify(first), stableStringify(second));
  });
});

test("the doctor writes nothing: the tree is byte-identical afterwards", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const before = await snapshotTree(root);
    await runSetupDoctor({ projectRoot: root, now: FIXTURE_NOW, env });
    const after = await snapshotTree(root);
    assert.equal(after, before);
  });
});

test("a broken project reports every failure at once", async () => {
  await withFixtureRoot(async (root) => {
    const { env } = await writeFakeNode(root);
    await writeFiles(root, { "package.json": "{}\n" });

    const report = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    assert.equal(report.status, "fail");
    assert.deepEqual(
      report.diagnostics
        .filter((diagnostic) => diagnostic.status === "fail")
        .map((diagnostic) => diagnostic.id),
      [
        "build.dist-freshness",
        "gitignore.barbaro-ignored",
        "hooks.claude",
        "hooks.codex",
        "views.coordination-state",
      ],
    );
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.status === "pass") continue;
      assert.ok(
        diagnostic.remediation.length > 0,
        `${diagnostic.id} must say what to do`,
      );
    }
  });
});

test("the text projection stays a projection of the structured report", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const report = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
    });
    const text = formatSetupDoctorReport(report);
    assert.match(text, /^barbaro setup doctor: WARN\n/);
    for (const diagnostic of report.diagnostics) {
      assert.ok(text.includes(diagnostic.id), diagnostic.id);
    }
    assert.match(text, /peer-context preflight:/);
  });
});

test("scan limits are honored end to end", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const report = await runSetupDoctor({
      projectRoot: root,
      now: FIXTURE_NOW,
      env,
      maxEntries: 1,
    });
    const views = report.diagnostics.find(
      (diagnostic) => diagnostic.id === "views.coordination-state",
    );
    assert.match(views?.remediation.join(" ") ?? "", /entry limit/);
  });
});
