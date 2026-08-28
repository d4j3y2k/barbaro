import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { HORSE_RIDERLESS_COMPACT_FRAMES } from "../../src/tui/horse-frames.js";
import { measureCells } from "../../src/tui/cells.js";
import {
  STRIP_56_CELLS,
  STRIP_56_THUMBS,
  STRIP_64_CELLS,
  STRIP_64_THUMBS,
  STRIP_PHASES,
  STRIP_REDUCER_VERSION,
  STRIP_SOURCE_HASH,
  stripRows56,
  stripRows64,
} from "../../src/tui/strip.js";

test("the strip is four ordered labeled thumbnails, regenerated as a unit", () => {
  assert.deepEqual(STRIP_PHASES, ["F01", "F04", "F07", "F10"]);
  assert.equal(STRIP_64_THUMBS.length, 4);
  assert.equal(STRIP_56_THUMBS.length, 4);
  for (const thumb of STRIP_64_THUMBS) {
    assert.equal(thumb.length, 4);
    for (const row of thumb) assert.equal(measureCells(row), STRIP_64_CELLS);
  }
  for (const thumb of STRIP_56_THUMBS) {
    assert.equal(thumb.length, 3);
    for (const row of thumb) assert.equal(measureCells(row), STRIP_56_CELLS);
  }
  // The sub-card variant is the fixed reduction of the 64-column variant.
  assert.deepEqual(
    STRIP_56_THUMBS,
    STRIP_64_THUMBS.map((thumb) =>
      thumb.slice(1).map((row) => row.slice(1, 12)),
    ),
  );
});

test("the asset hash binds the strip to its source frames and reducer", () => {
  const expected = createHash("sha256")
    .update(JSON.stringify(HORSE_RIDERLESS_COMPACT_FRAMES))
    .update(STRIP_REDUCER_VERSION)
    .digest("hex");
  assert.equal(STRIP_SOURCE_HASH, expected);
  assert.equal(STRIP_REDUCER_VERSION, "comfort-strip.v1");
});

test("strip rows measure their interiors with two-cell gutters and labels", () => {
  const rows64 = stripRows64();
  assert.equal(rows64.length, 5);
  for (const row of rows64) assert.equal(measureCells(row), 62);
  assert.equal(
    rows64[0],
    "       F01            F04            F07            F10       ",
  );
  const rows56 = stripRows56();
  assert.equal(rows56.length, 4);
  for (const row of rows56) assert.equal(measureCells(row), 54);
  assert.match(rows56[0]!, /F01.*F04.*F07.*F10/u);
  // Shading stays inside the art; the label row carries none (§7).
  assert.doesNotMatch(rows64[0]!, /[█▓▒░]/u);
  assert.doesNotMatch(rows56[0]!, /[█▓▒░]/u);
});
