import assert from "node:assert/strict";
import test from "node:test";

import {
  ComfortInputParser,
  type ComfortCommand,
} from "../../src/tui/comfort-input.js";

const ESC = "\u001b";

function makeParser() {
  const commands: ComfortCommand[] = [];
  const pastes: string[] = [];
  let pending: (() => void) | undefined;
  const parser = new ComfortInputParser({
    events: {
      command: (command) => commands.push(command),
      paste: (payload) => pastes.push(payload),
    },
    setTimeout: (callback) => {
      pending = callback;
      return 1;
    },
    clearTimeout: () => {
      pending = undefined;
    },
  });
  return {
    parser,
    commands,
    pastes,
    fireTimeout: () => {
      const callback = pending;
      pending = undefined;
      callback?.();
    },
  };
}

test("plain keys map to comfort commands only as complete chunks", () => {
  const { parser, commands } = makeParser();
  for (const key of [
    "j",
    "k",
    "h",
    "l",
    "r",
    "?",
    "c",
    "n",
    "x",
    "/",
    "s",
    " ",
  ]) {
    parser.feed(key);
  }
  parser.feed("\r");
  parser.feed("q");
  assert.deepEqual(commands, [
    "move-down",
    "move-up",
    "exposure-left",
    "exposure-right",
    "refresh",
    "help",
    "copy",
    "create",
    "lifecycle",
    "filter",
    "sort",
    "toggle-motion",
    "open",
    "quit",
  ]);
  // Multi-byte text chunks are typed or pasted content, never commands.
  const { commands: none, parser: second } = makeParser();
  second.feed("qrjk");
  second.feed("xx");
  assert.deepEqual(none, []);
});

test("arrows and shift-tab decode; a lone Escape resolves back on timeout", () => {
  const { parser, commands, fireTimeout } = makeParser();
  parser.feed(`${ESC}[A`);
  parser.feed(`${ESC}[B`);
  parser.feed(`${ESC}[Z`);
  parser.feed(ESC);
  fireTimeout();
  assert.deepEqual(commands, [
    "move-up",
    "move-down",
    "detail-previous",
    "back",
  ]);
});

test("a bracketed paste arrives whole and its bytes never become commands", () => {
  const { parser, commands, pastes } = makeParser();
  parser.feed(`${ESC}[200~q\rn?`);
  parser.feed(` more${ESC}[201~`);
  assert.deepEqual(commands, []);
  assert.deepEqual(pastes, ["q\rn? more"]);
});
