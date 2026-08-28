import assert from "node:assert/strict";
import test from "node:test";

import { measureCells } from "../../src/tui/cells.js";
import {
  chooseCard,
  COMFORT_ANATOMY,
  COMFORT_CARD,
  composeMatte,
  FLOOR_CARD,
  matteOffsets,
  SUB_ANATOMY,
  SUB_CARD,
  TEXT_CARD,
  trueSizeNotice,
} from "../../src/tui/geometry.js";

test("the anatomy sums are exactly the card heights (gates 2 and 3)", () => {
  const comfort =
    COMFORT_ANATOMY.topStripRows + 1 + COMFORT_ANATOMY.frameRows + 1 +
    COMFORT_ANATOMY.benchRows + 1 + 1;
  assert.equal(comfort, 28);
  const sub =
    SUB_ANATOMY.topStripRows + 1 + SUB_ANATOMY.frameRows + 1 +
    SUB_ANATOMY.benchRows + 1 + 1;
  assert.equal(sub, 22);
  assert.equal(COMFORT_ANATOMY.interiorCells, 62);
  assert.equal(SUB_ANATOMY.interiorCells, 54);
});

test("tier choice takes the first card fitting both dimensions", () => {
  assert.equal(chooseCard(64, 28), COMFORT_CARD);
  assert.equal(chooseCard(200, 60), COMFORT_CARD);
  // The spec's own example: 120×24 takes the centered 56×22 sub-card.
  assert.equal(chooseCard(120, 24), SUB_CARD);
  assert.equal(chooseCard(63, 28), SUB_CARD);
  assert.equal(chooseCard(64, 27), SUB_CARD);
  assert.equal(chooseCard(56, 22), SUB_CARD);
  assert.equal(chooseCard(55, 40), TEXT_CARD);
  assert.equal(chooseCard(40, 12), TEXT_CARD);
  assert.equal(chooseCard(39, 12), FLOOR_CARD);
  assert.equal(chooseCard(12, 6), FLOOR_CARD);
  assert.equal(chooseCard(11, 6), undefined);
  assert.equal(chooseCard(12, 5), undefined);
});

test("a larger terminal centers the same card in deterministic matte", () => {
  const card = Array.from({ length: 28 }, (_, row) =>
    `${row.toString(16)}`.padEnd(64, "."),
  );
  const framed = composeMatte(card, COMFORT_CARD, 100, 40);
  assert.equal(framed.length, 40);
  for (const line of framed) assert.equal(measureCells(line), 100);
  const offsets = matteOffsets(100, 40, COMFORT_CARD);
  assert.equal(offsets.left, 18);
  assert.equal(offsets.top, 6);
  assert.equal(framed[5], " ".repeat(100));
  assert.equal(framed[6], `${" ".repeat(18)}${card[0]}${" ".repeat(18)}`);
  assert.equal(framed[33], `${" ".repeat(18)}${card[27]}${" ".repeat(18)}`);
  assert.equal(framed[34], " ".repeat(100));
  // Byte determinism: the same inputs compose the same frame.
  assert.deepEqual(composeMatte(card, COMFORT_CARD, 100, 40), framed);
});

test("matte composition rejects a card that does not measure exactly", () => {
  const short = Array.from({ length: 27 }, () => " ".repeat(64));
  assert.throws(() => composeMatte(short, COMFORT_CARD, 64, 28), RangeError);
  const narrow = Array.from({ length: 28 }, () => " ".repeat(63));
  assert.throws(() => composeMatte(narrow, COMFORT_CARD, 64, 28), RangeError);
});

test("below the floor the notice uses true geometry and zero emits nothing", () => {
  const notice = trueSizeNotice(11, 4);
  assert.equal(notice.length, 4);
  for (const line of notice) assert.equal(measureCells(line), 11);
  assert.match(notice[0]!, /11x4/u);
  assert.match(notice[1]!, /12x6/u);
  assert.deepEqual(trueSizeNotice(0, 5), []);
  assert.deepEqual(trueSizeNotice(9, 0), []);
});
