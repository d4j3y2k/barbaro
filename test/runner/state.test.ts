import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UnsafeStorePathError } from "../../src/core/safe-store.js";
import {
  readCodexRunnerState,
  writeCodexRunnerState,
  type CodexRunnerStateV1,
} from "../../src/runner/state.js";

const STATE: CodexRunnerStateV1 = {
  schema: "barbaro.codex-runner-state.v1",
  trace_id: "codex:native-session",
  checkpoint: {
    schema: "barbaro.jsonl-checkpoint.v1",
    file_identity: { device: "1", inode: "2", birthtime_ns: "3" },
    byte_offset: 0,
    next_line_number: 1,
    observed_size: 0,
    anchor: { byte_length: 0, sha256: "0".repeat(64) },
  },
  normalizer: {
    schema: "barbaro.codex-normalizer-state.v1",
    next_sequence: 1,
    turns: [],
    diagnostics: {
      records: 0,
      invalid_envelopes: 0,
      unknown_root_types: {},
      unknown_event_types: {},
      unknown_response_types: {},
      repeated_session_meta: 0,
      orphan_turn_records: 0,
    },
  },
};

test("runner state round-trips through the guarded store", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-state-roundtrip-"));
  try {
    const path = join(project, ".barbaro", "state", "codex", "runner.json");
    await writeCodexRunnerState(path, STATE);
    assert.deepEqual(await readCodexRunnerState(path), STATE);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("symlinked .barbaro/state cannot read or write outside the project", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-state-boundary-project-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-state-boundary-outside-"));
  try {
    const barbaro = join(project, ".barbaro");
    await mkdir(barbaro, { mode: 0o700 });
    await symlink(outside, join(barbaro, "state"), "dir");

    const outsideCodex = join(outside, "codex");
    await mkdir(outsideCodex, { mode: 0o700 });
    const sentinel = join(outsideCodex, "runner.json");
    await writeFile(sentinel, "outside sentinel\n", { mode: 0o600 });
    const path = join(barbaro, "state", "codex", "runner.json");

    await assert.rejects(
      readCodexRunnerState(path),
      (error: unknown) => error instanceof UnsafeStorePathError,
    );
    await assert.rejects(
      writeCodexRunnerState(path, STATE),
      (error: unknown) => error instanceof UnsafeStorePathError,
    );
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel\n");
    assert.deepEqual(await readdir(outsideCodex), ["runner.json"]);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
