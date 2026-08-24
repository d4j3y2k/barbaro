import assert from "node:assert/strict";
import test from "node:test";

import {
  clipTerminalText,
  padTerminalText,
  sanitizeTerminalText,
  terminalCellWidth,
} from "../../src/tui/terminal-text.js";

const ESC = "\u001b";

test("sanitization makes terminal control payloads and layout controls inert", () => {
  const hostile = [
    `alpha${ESC}[31mred${ESC}[0m`,
    `beta${ESC}]0;stolen title\u0007gamma`,
    `delta${ESC}]8;;https://example.invalid${ESC}\\link${ESC}]8;;${ESC}\\epsilon`,
    `zeta\u009b2Jeta`,
    `theta${ESC}Pprivate payload${ESC}\\iota`,
    "kappa\u0000\u0003\u007f\u0085lambda",
  ].join("\r\n\t");

  const sanitized = sanitizeTerminalText(hostile);
  assert.equal(
    sanitized,
    "alpha red beta gamma delta link epsilon zeta eta theta iota kappa lambda",
  );
  assert.doesNotMatch(sanitized, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.doesNotMatch(sanitized, /\u001b\[|\u001b\]|\u009b/u);
  assert.equal(sanitized.split("\n").length, 1);
});

test("control runs collapse to one predictable separator", () => {
  assert.equal(sanitizeTerminalText("one\r\n\ttwo"), "one two");
  assert.equal(sanitizeTerminalText("one \n two"), "one  two");
  assert.equal(sanitizeTerminalText("\u0000lead"), " lead");
  assert.equal(sanitizeTerminalText("trail\u0000"), "trail ");
  assert.equal(sanitizeTerminalText("a\u2028b\u2029c"), "a b c");
  assert.equal(sanitizeTerminalText("left\u202eright"), "left right");
  assert.equal(sanitizeTerminalText(`${ESC}[31`), " ");
});

test("terminal cell width covers ASCII, combining marks, CJK, and full-width text", () => {
  assert.equal(terminalCellWidth("barbaro"), 7);
  assert.equal(terminalCellWidth("e\u0301"), 1);
  assert.equal(terminalCellWidth("\u0301"), 0);
  assert.equal(terminalCellWidth("你好"), 4);
  assert.equal(terminalCellWidth("ＡＢ"), 4);
  assert.equal(terminalCellWidth("한글"), 4);
});

test("emoji clusters occupy two cells without counting their joiners", () => {
  assert.equal(terminalCellWidth("😀"), 2);
  assert.equal(terminalCellWidth("❤️"), 2);
  assert.equal(terminalCellWidth("👩🏽"), 2);
  assert.equal(terminalCellWidth("👨‍👩‍👧‍👦"), 2);
  assert.equal(terminalCellWidth("🇺🇸"), 2);
  assert.equal(terminalCellWidth("1️⃣"), 2);
});

test("trusted SGR styling occupies no cells", () => {
  const styled = `${ESC}[1;36m你e\u0301😀${ESC}[0m`;
  assert.equal(terminalCellWidth(styled), 5);
  assert.equal(terminalCellWidth(`${ESC}[38;2;10;20;30mred${ESC}[39m`), 3);
});

test("clipping uses cell widths and keeps grapheme clusters intact", () => {
  assert.equal(clipTerminalText("abcdef", 4), "abc…");
  assert.equal(clipTerminalText("你好世界", 5), "你好…");
  assert.equal(clipTerminalText("e\u0301xyz", 3), "e\u0301x…");
  assert.equal(clipTerminalText("👨‍👩‍👧‍👦ab", 3), "👨‍👩‍👧‍👦…");
  assert.equal(clipTerminalText("abc", 0), "");
  assert.equal(clipTerminalText("abc", -4), "");
  assert.equal(terminalCellWidth(clipTerminalText("你好世界", 4)), 3);
});

test("clipping preserves complete SGR and resets a style cut before its reset", () => {
  const styled = `${ESC}[31mabcdef${ESC}[0m`;
  const clipped = clipTerminalText(styled, 4);
  assert.equal(clipped, `${ESC}[31mabc…${ESC}[0m`);
  assert.equal(terminalCellWidth(clipped), 4);
  assert.doesNotMatch(clipped, /\u001b(?:$|\[[0-9;:]*$)/u);

  const alreadyReset = `${ESC}[31mab${ESC}[0mcdef`;
  assert.equal(clipTerminalText(alreadyReset, 4), `${ESC}[31mab${ESC}[0mc…`);
  assert.equal(
    clipTerminalText(`${ESC}[31mabc`, 8),
    `${ESC}[31mabc${ESC}[0m`,
  );
});

test("unknown or incomplete escapes are sanitized before clipping", () => {
  assert.equal(clipTerminalText(`a${ESC}[?25lb`, 8), "a b");
  assert.equal(clipTerminalText(`a${ESC}[31`, 8), "a ");
  assert.doesNotMatch(clipTerminalText(`a${ESC}[?25lb`, 2), /\u001b/u);
});

test("right padding adds exact terminal cells and closes active styling", () => {
  assert.equal(padTerminalText("你", 4), "你  ");
  assert.equal(padTerminalText("e\u0301", 3), "e\u0301  ");
  assert.equal(padTerminalText("long", 2), "long");

  const balanced = `${ESC}[32m好${ESC}[0m`;
  assert.equal(padTerminalText(balanced, 4), `${balanced}  `);
  const unbalanced = `${ESC}[32m好`;
  assert.equal(padTerminalText(unbalanced, 4), `${unbalanced}${ESC}[0m  `);
  assert.equal(terminalCellWidth(padTerminalText(unbalanced, 4)), 4);
});

test("custom ellipses are sanitized and remain within the cell budget", () => {
  const clipped = clipTerminalText("abcdef", 5, {
    ellipsis: `${ESC}[31m..\n`,
  });
  assert.equal(clipped, "abc..");
  assert.equal(terminalCellWidth(clipped), 5);
  assert.throws(() => clipTerminalText("abc", Number.NaN), /finite/);
});
