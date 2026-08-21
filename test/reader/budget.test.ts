import assert from "node:assert/strict";
import test from "node:test";

import {
  ReaderByteBudgetTooSmallError,
  stableJsonUtf8Bytes,
  truncateReaderUtf8,
  wrapReaderProjection,
} from "../../src/reader/budget.js";

test("UTF-8 truncation respects code-point byte boundaries", () => {
  const value = "A😀éZ";
  assert.equal(Buffer.byteLength(value, "utf8"), 8);
  assert.equal(truncateReaderUtf8(value, 0), "");
  assert.equal(truncateReaderUtf8(value, 4), "A");
  assert.equal(truncateReaderUtf8(value, 5), "A😀");
  assert.equal(truncateReaderUtf8(value, 6), "A😀");
  assert.equal(truncateReaderUtf8(value, 7), "A😀é");
  assert.equal(truncateReaderUtf8(value, 8), value);
});

test("projection envelopes report and enforce exact stable JSON bytes", () => {
  const first = wrapReaderProjection({ z: "😀", a: ["é", 1] }, 256);
  const replay = wrapReaderProjection({ z: "😀", a: ["é", 1] }, 256);
  assert.deepEqual(replay, first);
  assert.equal(stableJsonUtf8Bytes(first), first.utf8_bytes);
  assert.ok(first.utf8_bytes <= first.byte_budget);
  assert.throws(
    () => wrapReaderProjection({ text: "content" }, 8),
    (error: unknown) => error instanceof ReaderByteBudgetTooSmallError,
  );
});

test("invalid budgets fail rather than falling back to an implicit cap", () => {
  assert.throws(() => wrapReaderProjection({}, 0), /positive safe integer/u);
  assert.throws(() => truncateReaderUtf8("x", -1), /non-negative/u);
});
