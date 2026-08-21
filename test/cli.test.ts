import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { main } from "../src/cli.js";
import { createSessionId } from "../src/core/id.js";
import { admitHookSession } from "../src/hooks/participation.js";

const execFileAsync = promisify(execFile);

test("the built CLI runs when process.argv[1] is an npm-style symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-cli-link-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const builtCli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const linkedCli = join(directory, "barbaro");
  await symlink(builtCli, linkedCli, "file");

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [linkedCli, "--help"],
    { timeout: 10_000 },
  );
  assert.match(stdout, /^barbaro\n/);
  assert.match(stdout, /barbaro codex hook-ingest/);
  assert.equal(stderr, "");
});

test("session status is read-only and reports the derived current-session key", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-status-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const nativeSessionId = "status-session";
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
  };

  assert.equal(
    await main(
      [
        "codex",
        "status",
        "--session-id",
        nativeSessionId,
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  assert.deepEqual(JSON.parse(output.pop()!), {
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    joined: false,
  });

  await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro",
  });
  assert.equal(
    await main(
      [
        "codex",
        "status",
        "--session-id",
        nativeSessionId,
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  const joined = JSON.parse(output.pop()!) as Record<string, unknown>;
  assert.equal(joined.joined, true);
  assert.equal(joined.session_id, createSessionId("codex", nativeSessionId));
  assert.equal(typeof joined.joined_at, "string");
  assert.deepEqual(errors, []);
});
