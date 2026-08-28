import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  checkBuildFreshness,
  inspectBuildFreshness,
} from "../../src/setup/index.js";

import {
  FIXTURE_NOW,
  setMtime,
  withFixtureRoot,
  writeFakeNode,
  writeFiles,
  writeHealthyProject,
} from "./fixture.js";

const NOW_MS = FIXTURE_NOW.getTime();
const execFileAsync = promisify(execFile);

function factValue(
  diagnostic: { facts: readonly { key: string; value: unknown }[] },
  key: string,
): unknown {
  return diagnostic.facts.find((fact) => fact.key === key)?.value;
}

test("a current build passes and reports the compared source count", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const diagnostic = await checkBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "pass");
    assert.equal(factValue(diagnostic, "source_file_count"), 2);
    assert.equal(factValue(diagnostic, "stale_output_count"), 0);
    assert.deepEqual(factValue(diagnostic, "missing_outputs"), []);
    assert.deepEqual(diagnostic.remediation, []);
  });
});

test("repository builds clean stale dist artifacts before compiling", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const clean = manifest.scripts?.["clean:dist"];
  assert.ok(clean);
  assert.match(manifest.scripts?.["build"] ?? "", /^npm run clean:dist && tsc /u);
  assert.match(
    manifest.scripts?.["build:package"] ?? "",
    /^npm run clean:dist && tsc /u,
  );

  await withFixtureRoot(async (root) => {
    await writeFiles(root, {
      "package.json": `${JSON.stringify({ scripts: { "clean:dist": clean } })}\n`,
      "dist/stale.js": "stale\n",
      "keep.txt": "keep\n",
    });
    await execFileAsync("npm", ["run", "--silent", "clean:dist"], {
      cwd: root,
    });
    await assert.rejects(access(join(root, "dist")));
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep\n");
  });
});

test("a missing dist fails because hooks have nothing to execute", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await rm(join(root, "dist"), { recursive: true, force: true });

    const diagnostic = await checkBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    assert.equal(factValue(diagnostic, "dist_present"), false);
    assert.equal(factValue(diagnostic, "cli_present"), false);
    assert.match(diagnostic.remediation.join(" "), /npm run build/);
  });
});

test("a source file with no compiled output fails", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await writeFiles(root, { "src/setup/views.ts": "export const v = 1;\n" });

    const diagnostic = await checkBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    assert.deepEqual(factValue(diagnostic, "missing_outputs"), [
      "src/setup/views.ts",
    ]);
  });
});

test("an output older than its source warns rather than fails", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await setMtime(root, "src/setup/doctor.ts", new Date(NOW_MS));

    const diagnostic = await checkBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "warn");
    assert.deepEqual(factValue(diagnostic, "stale_outputs"), [
      "src/setup/doctor.ts",
    ]);
    assert.match(diagnostic.remediation.join(" "), /hooks execute dist/);
  });
});

test("build configuration newer than the compiled CLI warns", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await setMtime(root, "tsconfig.json", new Date(NOW_MS));

    const diagnostic = await checkBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "warn");
    assert.deepEqual(factValue(diagnostic, "build_inputs_newer_than_cli"), [
      "tsconfig.json",
    ]);
  });
});

test("declaration files are not compared and the CLI age is reported", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await writeFiles(root, { "src/legacy.d.ts": "export {};\n" });

    const freshness = await inspectBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(freshness.sourceFileCount, 2);
    assert.deepEqual(freshness.missingOutputs, []);

    const diagnostic = await checkBuildFreshness({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(factValue(diagnostic, "cli_age_seconds"), 30);
  });
});
