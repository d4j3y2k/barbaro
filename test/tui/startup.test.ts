import assert from "node:assert/strict";
import test from "node:test";

import { HORSE_FRAME_COUNT } from "../../src/tui/horse.js";
import {
  STARTUP_STRIDE_TICKS,
  startupFrameAtTick,
  startupStrideComplete,
} from "../../src/tui/startup.js";

test("startup paints one exact riderless stride before handoff", () => {
  assert.equal(STARTUP_STRIDE_TICKS, HORSE_FRAME_COUNT);
  assert.deepEqual(
    Array.from({ length: STARTUP_STRIDE_TICKS }, (_unused, tick) =>
      startupFrameAtTick(tick),
    ),
    Array.from({ length: HORSE_FRAME_COUNT }, (_unused, frame) => frame),
  );
  assert.equal(startupStrideComplete(STARTUP_STRIDE_TICKS - 1), false);
  assert.equal(startupStrideComplete(STARTUP_STRIDE_TICKS), true);
  assert.equal(startupFrameAtTick(STARTUP_STRIDE_TICKS), 0);
});

test("startup clock rejects invalid values", () => {
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => startupFrameAtTick(invalid), /non-negative integer/u);
    assert.throws(
      () => startupStrideComplete(invalid),
      /non-negative integer/u,
    );
  }
});
