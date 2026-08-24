import assert from "node:assert/strict";
import test from "node:test";

import {
  HORSE_FRAME_COUNT,
  horseFrame,
  horseFrameIndex,
  renderHorseStudyFrame,
} from "../../src/tui/horse.js";

test("generated horse frames retain fixed geometry and density shading", () => {
  assert.equal(HORSE_FRAME_COUNT, 11);
  for (const [variant, scale, width, height] of [
    ["original", "hero", 56, 15],
    ["original", "compact", 36, 10],
    ["riderless", "hero", 56, 13],
    ["riderless", "compact", 36, 8],
  ] as const) {
    const distinct = new Set<string>();
    for (let index = 0; index < HORSE_FRAME_COUNT; index += 1) {
      const frame = horseFrame(index, scale, variant);
      assert.equal(frame.length, height);
      assert.ok(frame.every((line) => Array.from(line).length === width));
      assert.ok(frame.every((line) => /^[ █▓▒░▀▄]+$/u.test(line)));
      if (variant === "riderless") {
        assert.match(frame.join(""), /[▀▄]/u);
      }
      distinct.add(frame.join("\n"));
    }
    assert.equal(distinct.size, HORSE_FRAME_COUNT);
  }
});

test("frame selection loops deterministically in both directions", () => {
  assert.equal(horseFrameIndex(0), 0);
  assert.equal(horseFrameIndex(99), 0);
  assert.equal(horseFrameIndex(100), 1);
  assert.equal(horseFrameIndex(1_099), 10);
  assert.equal(horseFrameIndex(1_100), 0);
  assert.deepEqual(horseFrame(-1, "compact"), horseFrame(10, "compact"));
  assert.throws(() => horseFrame(0.5, "hero"), /integer/);
  assert.throws(() => horseFrameIndex(-1), /non-negative/);
  assert.throws(() => horseFrameIndex(0, 0), /positive integer/);
});

test("the static study presents the source and plate without ANSI styling", () => {
  const rendered = renderHorseStudyFrame({
    width: 80,
    height: 24,
    frameIndex: 3,
    scale: "hero",
    variant: "original",
    style: false,
    interactive: false,
  });
  assert.match(rendered, /B A R B A R O/);
  assert.match(rendered, /THE HORSE IN MOTION/);
  assert.match(rendered, /PLATE 04 OF 11/);
  assert.match(rendered, /EADWEARD MUYBRIDGE · SALLIE GARDNER/);
  assert.match(rendered, /[█▓▒░]/u);
  assert.doesNotMatch(rendered, /\u001b\[/u);
  assert.equal(rendered.split("\n").length, 24);
});

test("the compact comparison makes the source edit explicit", () => {
  const rendered = renderHorseStudyFrame({
    width: 80,
    height: 24,
    frameIndex: 5,
    scale: "compact",
    variant: "compare",
    style: false,
    interactive: false,
  });
  assert.match(rendered, /ORIGINAL/);
  assert.match(rendered, /RIDERLESS/);
  assert.match(rendered, /RIGHT: RIDER REMOVED FROM SOURCE/);
  assert.equal(rendered.split("\n").length, 24);
  assert.ok(rendered.split("\n").every((line) => Array.from(line).length <= 80));
});

test("wordmark studies carve each spelling into the riderless body", () => {
  for (const [wordmark, text] of [
    ["spaced-lower", "b a r b a r o"],
  ] as const) {
    const rendered = renderHorseStudyFrame({
      width: 80,
      height: 24,
      frameIndex: 5,
      scale: "compact",
      variant: "riderless",
      wordmark,
      style: false,
      interactive: false,
    });
    assert.ok(
      rendered
        .split("\n")
        .some((line) => line.includes("│") && line.includes(text)),
    );
    assert.equal(rendered.split("\n").every((line) => Array.from(line).length <= 80), true);
  }
});

test("the preferred wordmark shifts right without a background fill", () => {
  const rendered = renderHorseStudyFrame({
    width: 80,
    height: 24,
    frameIndex: 0,
    scale: "compact",
    variant: "riderless",
    wordmark: "spaced-lower",
    style: true,
    interactive: true,
  });
  const artLine = rendered
    .split("\n")
    .find((line) => line.includes("│") && line.includes("b a r b a r o"));
  assert.ok(artLine);
  assert.equal(artLine.indexOf("b a r b a r o") - artLine.indexOf("│"), 12);
  assert.doesNotMatch(artLine, /\u001b\[7m/u);
});

test("small terminals get an honest size requirement instead of broken art", () => {
  const rendered = renderHorseStudyFrame({
    width: 30,
    height: 8,
    frameIndex: 0,
    scale: "compact",
    style: false,
  });
  assert.match(rendered, /needs 38×16/);
  assert.match(rendered, /terminal is 30×8/);
  assert.doesNotMatch(rendered, /[█▓▒░]/u);
});
