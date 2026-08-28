import assert from "node:assert/strict";
import test from "node:test";

import {
  CELL_REPLACEMENT,
  centerCells,
  charCells,
  clipCells,
  clipWords,
  frameBottom,
  frameLine,
  frameTop,
  measureCells,
  padCells,
  sanitizeCells,
} from "../../src/tui/cells.js";

test("the width table keeps plate glyphs narrow and emoji wide", () => {
  for (const glyph of "█▓▒░│┌┐└┘─·> ABCabc019") {
    assert.equal(charCells(glyph.codePointAt(0)!), 1, glyph);
  }
  assert.equal(charCells("🐎".codePointAt(0)!), 2);
  assert.equal(charCells("한".codePointAt(0)!), 2);
  assert.equal(charCells(0x0301), 0);
  assert.equal(measureCells("é"), 1);
  assert.equal(measureCells("🐎🐎"), 4);
});

test("sanitization replaces controls and format characters, never deletes", () => {
  const hostile = "a\u001b[31mb\u200dc\u202ed\u0000e\r\n";
  const sanitized = sanitizeCells(hostile);
  for (const forbidden of ["\u001b", "\u200d", "\u202e", "\u0000", "\r", "\n"]) {
    assert.equal(sanitized.includes(forbidden), false, JSON.stringify(forbidden));
  }
  assert.equal([...sanitized].length, [...hostile].length);
  assert.equal(
    sanitized,
    `a${CELL_REPLACEMENT}[31mb${CELL_REPLACEMENT}c${CELL_REPLACEMENT}d${CELL_REPLACEMENT}e${CELL_REPLACEMENT}${CELL_REPLACEMENT}`,
  );
  assert.equal(sanitizeCells("plain text"), "plain text");
});

test("clipping respects cell boundaries and never splits a wide character", () => {
  assert.equal(clipCells("abcdef", 3), "abc");
  assert.equal(clipCells("ab🐎cd", 3), "ab");
  assert.equal(clipCells("ab🐎cd", 4), "ab🐎");
  assert.equal(clipCells("anything", 0), "");
});

test("prose clipping is cell-aware and marks word-boundary cuts", () => {
  assert.equal(clipWords("short", 15), "short");
  assert.equal(
    clipWords("codex posted as well as others", 15),
    "codex posted...",
  );
  assert.equal(clipWords("spectacularlylongword", 10), "spectac...");
  assert.equal(clipWords("wide 馬馬馬 words after", 12), "wide...");
  assert.equal(clipWords("a\n b\t c", 15), "a b c");
  const hostile = clipWords("safe\u202etext 馬馬馬 and more", 18);
  assert.ok(measureCells(hostile) <= 18);
  assert.doesNotMatch(hostile, /\u202e/u);
  assert.match(hostile, /\.\.\.$/u);
});

test("padding produces exactly the requested cells for hostile content", () => {
  const samples = [
    "short",
    "🐎🐎🐎🐎",
    "éé",
    "\u001b[31mred",
    "x".repeat(200),
  ];
  for (const text of samples) {
    const padded = padCells(text, 20);
    assert.equal(measureCells(padded), 20, JSON.stringify(text));
  }
  assert.equal(centerCells("ab", 6), "  ab  ");
  assert.equal(centerCells("abc", 6), " abc  ");
});

test("frame walls sit at fixed columns regardless of interior content", () => {
  const interiors = ["", "plain", "🐎 wide", "\u001b control", "x".repeat(99)];
  for (const interior of interiors) {
    const line = frameLine(interior, 62);
    assert.equal(measureCells(line), 64);
    assert.equal(line.startsWith("│"), true);
    assert.equal(line.endsWith("│"), true);
  }
  const top = frameTop("Workstreams", 64);
  assert.equal(measureCells(top), 64);
  assert.equal(top.startsWith("┌─ Workstreams "), true);
  assert.equal(top.endsWith("┐"), true);
  assert.equal(measureCells(frameTop("", 64)), 64);
  assert.equal(frameBottom(64), `└${"─".repeat(62)}┘`);
  const bottom = frameBottom(64, "10 of 12");
  assert.equal(measureCells(bottom), 64);
  assert.equal(bottom.startsWith("└"), true);
  assert.equal(bottom.endsWith(" 10 of 12 ─┘"), true);
});
