import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDiagnosticBytes, readDiagnosticJson } from "../../src/setup/diagnostic-files.js";

async function project(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-doctor-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("doctor input follows an explicit config symlink, preserves bytes, and never evaluates its command", async (t) => {
  const root = await project(t);
  const target = join(root, "settings.json");
  const link = join(root, "linked.json");
  const marker = join(root, "must-not-run");
  const bytes = Buffer.from(JSON.stringify({ hooks: { command: `touch ${marker}` }, secret: "private" }));
  await writeFile(target, bytes); await symlink(target, link);
  const result = await readDiagnosticJson(link, bytes.length);
  assert.equal(result.state, "ok");
  assert.ok(result.state === "ok");
  assert.equal(result.identity.path, link);
  assert.ok(result.identity.real_path.endsWith("/settings.json"));
  assert.equal(result.identity.utf8_bytes, bytes.length);
  assert.match(result.identity.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal((await readDiagnosticBytes(marker, 10)).state, "missing");
  assert.equal((await readDiagnosticBytes(target, bytes.length - 1)).state, "too_large");
});

test("doctor input rejects nonfiles, invalid UTF-8 and invalid JSON without reflecting their contents", async (t) => {
  const root = await project(t);
  const directory = join(root, "directory"); await mkdir(directory);
  assert.equal((await readDiagnosticBytes(directory, 100)).state, "not_file");
  const path = join(root, "invalid.json");
  for (const bytes of [Buffer.from('{"secret":"DO-NOT-ECHO'), Buffer.from([0x22, 0xff, 0x22])]) {
    await writeFile(path, bytes);
    const result = await readDiagnosticJson(path, 100);
    assert.deepEqual(result, { state: "invalid_json", path });
    assert.ok(!JSON.stringify(result).includes("DO-NOT-ECHO"));
  }
  await assert.rejects(readDiagnosticBytes(path, 0), RangeError);
  await assert.rejects(readDiagnosticBytes(path, 17 * 1024 * 1024), RangeError);
});

test("doctor input names permission failure without reading config values", { skip: process.getuid?.() === 0 }, async (t) => {
  const root = await project(t); const path = join(root, "private.json");
  await writeFile(path, '{"secret":"DO-NOT-ECHO"}'); await chmod(path, 0);
  t.after(() => chmod(path, 0o600).catch(() => undefined));
  const result = await readDiagnosticJson(path, 100);
  assert.equal(result.state, "unavailable");
  assert.ok(result.state === "unavailable");
  assert.equal(result.code, "EACCES");
  assert.ok(!JSON.stringify(result).includes("DO-NOT-ECHO"));
});
