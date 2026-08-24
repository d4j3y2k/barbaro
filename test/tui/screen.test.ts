import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalScreen,
  type TerminalScreenWriter,
} from "../../src/tui/screen.js";

const ESC = "\u001b";
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?2004h${ESC}[H${ESC}[2J`;
const LEAVE = `${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`;

class RecordingWriter implements TerminalScreenWriter {
  public readonly chunks: string[] = [];

  public write(chunk: string): void {
    this.chunks.push(chunk);
  }
}

test("screen setup, redraw, and cleanup use exact terminal sequences", () => {
  const writer = new RecordingWriter();
  const screen = new TerminalScreen(writer);

  screen.enter();
  screen.draw("first     \nframe     ");
  screen.draw("short     ");
  screen.leave();

  assert.deepEqual(writer.chunks, [
    ENTER,
    `${ESC}[Hfirst     \nframe     ${ESC}[J`,
    `${ESC}[Hshort     ${ESC}[J`,
    LEAVE,
  ]);
  assert.equal(writer.chunks.join("").split(`${ESC}[2J`).length - 1, 1);
  assert.equal(writer.chunks.join("").split(`${ESC}[?2004h`).length - 1, 1);
  assert.equal(writer.chunks.join("").split(`${ESC}[?2004l`).length - 1, 1);
});

test("shorter redraws overwrite their final row and erase stale rows below", () => {
  const writer = new RecordingWriter();
  const screen = new TerminalScreen(writer);

  screen.enter();
  screen.draw("alpha     \nbravo     \ncharlie   ");
  screen.draw("done      ");

  const redraw = writer.chunks.at(-1);
  assert.equal(redraw, `${ESC}[Hdone      ${ESC}[J`);
  assert.doesNotMatch(redraw ?? "", /\u001b\[2J/u);
  assert.match(redraw ?? "", / {6}\u001b\[J$/u);
});

test("enter and leave are idempotent and cleanup is emitted exactly once", () => {
  const writer = new RecordingWriter();
  const screen = new TerminalScreen(writer);

  screen.leave();
  screen.enter();
  screen.enter();
  screen.draw("frame");
  screen.leave();
  screen.leave();
  screen.enter();

  assert.deepEqual(writer.chunks, [
    ENTER,
    `${ESC}[Hframe${ESC}[J`,
    LEAVE,
  ]);
});

test("draw rejects calls before entry and after cleanup without writing", () => {
  const writer = new RecordingWriter();
  const screen = new TerminalScreen(writer);

  assert.throws(
    () => screen.draw("early"),
    /cannot draw before entering/u,
  );
  assert.deepEqual(writer.chunks, []);

  screen.enter();
  screen.leave();
  assert.throws(
    () => screen.draw("late"),
    /cannot draw after leaving/u,
  );
  assert.deepEqual(writer.chunks, [ENTER, LEAVE]);
});

test("a setup write failure cannot duplicate setup and still permits cleanup", () => {
  let writeCount = 0;
  const writer: TerminalScreenWriter = {
    write(chunk: string): void {
      writeCount += 1;
      if (writeCount === 1) throw new Error(`setup failed: ${chunk.length}`);
    },
  };
  const screen = new TerminalScreen(writer);

  assert.throws(() => screen.enter(), /setup failed/u);
  screen.enter();
  screen.leave();
  assert.equal(writeCount, 2);
});

test("a draw failure propagates while preserving one-shot cleanup", () => {
  const writer = new RecordingWriter();
  const throwingWriter: TerminalScreenWriter = {
    write(chunk: string): void {
      writer.write(chunk);
      if (chunk.includes("broken")) throw new Error("draw failed");
    },
  };
  const screen = new TerminalScreen(throwingWriter);

  screen.enter();
  assert.throws(() => screen.draw("broken"), /draw failed/u);
  screen.leave();
  screen.leave();

  assert.deepEqual(writer.chunks, [
    ENTER,
    `${ESC}[Hbroken${ESC}[J`,
    LEAVE,
  ]);
});

test("a cleanup write failure is propagated but never retried implicitly", () => {
  let writes = 0;
  const writer: TerminalScreenWriter = {
    write(): void {
      writes += 1;
      if (writes === 2) throw new Error("cleanup failed");
    },
  };
  const screen = new TerminalScreen(writer);

  screen.enter();
  assert.throws(() => screen.leave(), /cleanup failed/u);
  screen.leave();
  assert.equal(writes, 2);
  assert.throws(() => screen.draw("late"), /after leaving/u);
});
