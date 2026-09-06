import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectRuntimeIdentity } from "../../src/setup/runtime.js";
const exec = promisify(execFile);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "barbaro-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/src/core"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "barbaro", version: "0.1.0-alpha.6" }));
  const cli = join(root, "dist/src/cli.js");
  await writeFile(cli, "throw new Error('doctor must never run configured CLI');\n");
  await writeFile(join(root, "dist/src/core/one.js"), "export const one = 1;\n");
  const build = () => exec(process.execPath, [join(process.cwd(), "scripts/write-build-identity.mjs")], { cwd: root });
  return { root, cli, build };
}

test("runtime identity verifies every emitted module, diagnoses partial replacement and never executes CLI", async (t) => {
  const f = await fixture(t);
  assert.equal((await inspectRuntimeIdentity(f.cli)).state, "unverified");
  await f.build();
  const result = await inspectRuntimeIdentity(f.cli);
  assert.equal(result.state, "verified");
  assert.equal(result.package_version, "0.1.0-alpha.6");
  assert.equal(result.build_version, result.package_version);
  assert.equal(result.build_files, 2);
  await writeFile(join(f.root, "dist/src/core/one.js"), "export const one = 2;\n");
  assert.equal((await inspectRuntimeIdentity(f.cli)).reason, "build_file_hash_mismatch");
  await f.build();
  await writeFile(join(f.root, "dist/src/core/extra.js"), "export {};\n");
  assert.equal((await inspectRuntimeIdentity(f.cli)).reason, "build_file_set_mismatch");
});

test("runtime identity separates manifest version from build version and checks CLI hash", async (t) => {
  const f = await fixture(t); await f.build();
  const manifestPath = join(f.root, "package.json");
  const original = await readFile(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ name: "barbaro", version: "0.1.0-alpha.7" }));
  assert.equal((await inspectRuntimeIdentity(f.cli)).reason, "package_build_version_mismatch");
  await writeFile(manifestPath, original);
  await writeFile(f.cli, "changed CLI\n");
  assert.equal((await inspectRuntimeIdentity(f.cli)).reason, "cli_hash_mismatch");
});

test("runtime identity bounds untrusted version fields instead of copying them into reports", async (t) => {
  const f = await fixture(t); await f.build();
  const oversized = `0.1.0-${"x".repeat(300000)}`;
  await writeFile(join(f.root, "package.json"), JSON.stringify({ name: "barbaro", version: oversized }));
  const report = await inspectRuntimeIdentity(f.cli);
  assert.equal(report.state, "unverified");
  assert.equal(report.package_version, undefined);
  assert.ok(JSON.stringify(report).length < 4096);
});
