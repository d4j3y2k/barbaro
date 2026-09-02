import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("repoPath schema permits only workspace-relative POSIX paths", async () => {
  const schema = JSON.parse(
    await readFile("spec/barbaro-common-v1.schema.json", "utf8"),
  ) as { $defs: { repoPath: { pattern: string } } };
  const repoPath = new RegExp(schema.$defs.repoPath.pattern, "u");

  for (const valid of ["src/index.ts", "README.md", "a/.hidden/file"]) {
    assert.equal(repoPath.test(valid), true, valid);
  }
  for (const invalid of [
    "/etc/passwd",
    "../outside",
    "src/../../outside",
    "C:/Windows/system.ini",
    "src\\..\\outside",
    "src\0outside",
  ]) {
    assert.equal(repoPath.test(invalid), false, invalid);
  }
});

test("Codex hook example splits synchronous activity from terminal ingest", async () => {
  const config = JSON.parse(
    await readFile("examples/codex-hooks.json", "utf8"),
  ) as {
    hooks: Record<
      string,
      readonly { hooks: readonly { command: string; async: boolean; timeout: number }[] }[]
    >;
  };
  assert.equal(Object.keys(config.hooks).length, 11);
  for (const [event, groups] of Object.entries(config.hooks)) {
    const handlers = groups.flatMap((group) => group.hooks);
    assert.ok(
      handlers.some(
        (handler) =>
          handler.command === "BARBARO_BIN codex hook" && !handler.async,
      ),
      event,
    );
  }
  for (const event of ["Stop", "SubagentStop"]) {
    assert.ok(
      config.hooks[event]?.[0]?.hooks.some(
        (handler) =>
          handler.command === "BARBARO_BIN codex hook-ingest" && handler.async,
      ),
      event,
    );
  }
  assert.ok(
    config.hooks.UserPromptSubmit?.[0]?.hooks.some(
      (handler) =>
        handler.command === "BARBARO_BIN codex hook-ingest" && handler.async,
    ),
  );
  assert.ok(
    config.hooks.SessionEnd?.[0]?.hooks.some(
      (handler) =>
        handler.command === "BARBARO_BIN codex hook-ingest" &&
        !handler.async &&
        handler.timeout <= 3,
    ),
  );
  for (const handler of config.hooks.SessionEnd?.flatMap(
    (group) => group.hooks,
  ) ?? []) {
    assert.ok(handler.timeout <= 3, handler.command);
  }
});
