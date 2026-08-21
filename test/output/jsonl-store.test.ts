import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendUniqueJsonl } from "../../src/output/jsonl-store.js";

test("derived JSONL append is deterministic, deduplicated, and heals a torn tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-output-"));
  const path = join(directory, "feed", "turns.jsonl");
  const first = [{ turn_id: "turn_a", value: 1 }, { turn_id: "turn_b", value: 2 }];
  assert.deepEqual(
    await appendUniqueJsonl(path, first, (record) => record.turn_id),
    { appended: 2, skipped: 0, conflicted: 0, conflictedIds: [] },
  );
  assert.deepEqual(
    await appendUniqueJsonl(path, first, (record) => record.turn_id),
    { appended: 0, skipped: 2, conflicted: 0, conflictedIds: [] },
  );
  await writeFile(path, `${await readFile(path, "utf8")}{"turn_id":"torn"`, "utf8");
  assert.deepEqual(
    await appendUniqueJsonl(
      path,
      [{ turn_id: "turn_c", value: 3 }],
      (record) => record.turn_id,
    ),
    { appended: 1, skipped: 0, conflicted: 0, conflictedIds: [] },
  );
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.turn_id), ["turn_a", "turn_b", "turn_c"]);
});

