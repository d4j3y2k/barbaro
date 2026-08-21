import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareUtf16CodeUnits,
  stableJsonLine,
  stableStringify,
} from "../../src/core/stable-json.js";

test("UTF-16 code-unit ordering is explicit and locale-independent", () => {
  const values = ["\uE000", "\u{1F600}", "\u00E9", "Z", "\u{10000}", "z", "\u00E4"];
  assert.deepEqual(values.sort(compareUtf16CodeUnits), [
    "Z",
    "z",
    "\u00E4",
    "\u00E9",
    "\u{10000}",
    "\u{1F600}",
    "\uE000",
  ]);
});

test("stableStringify recursively sorts object keys", () => {
  const first = {
    z: 3,
    a: { yellow: true, blue: false },
    list: [{ d: 4, c: 3 }, 2, 1],
  };
  const second = {
    list: [{ c: 3, d: 4 }, 2, 1],
    a: { blue: false, yellow: true },
    z: 3,
  };

  const expected =
    '{"a":{"blue":false,"yellow":true},"list":[{"c":3,"d":4},2,1],"z":3}';
  assert.equal(stableStringify(first), expected);
  assert.equal(stableStringify(second), expected);
  assert.equal(stableJsonLine(first), `${expected}\n`);
});

test("stableStringify follows JSON omission and array-null semantics", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse.push(undefined, () => undefined, Symbol("ignored"));

  assert.equal(
    stableStringify({ keep: true, omitted: undefined, sparse }),
    '{"keep":true,"sparse":[null,null,null,null,null]}',
  );
});

test("stableStringify preserves valid JSON escaping and normalizes negative zero", () => {
  assert.equal(
    stableStringify({ value: -0, text: "line\nquote\"" }),
    '{"text":"line\\nquote\\\"","value":0}',
  );
});

test("stableStringify rejects lossy or unstable values", () => {
  assert.throws(() => stableStringify(Number.NaN), /Non-finite number/);
  assert.throws(() => stableStringify(Infinity), /Non-finite number/);
  assert.throws(() => stableStringify(1n), /BigInt/);
  assert.throws(() => stableStringify(new Date()), /Non-plain object/);
  assert.throws(() => stableStringify(undefined), /top-level/);

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => stableStringify(cycle), /Circular JSON value/);
});

test("stableStringify permits repeated non-cyclic references", () => {
  const shared = { b: 2, a: 1 };
  assert.equal(
    stableStringify({ right: shared, left: shared }),
    '{"left":{"a":1,"b":2},"right":{"a":1,"b":2}}',
  );
});
