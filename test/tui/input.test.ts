import assert from "node:assert/strict";
import test from "node:test";

import {
  createTuiInputParser,
  DEFAULT_ESCAPE_TIMEOUT_MS,
  MAX_ESCAPE_TIMEOUT_MS,
  type TuiCommand,
  TuiInputParser,
} from "../../src/tui/input.js";

const ESCAPE = "\u001b";

class FakeTimers {
  now = 0;
  lastDelay: number | undefined;
  clearCount = 0;

  readonly #tasks = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();
  #nextId = 1;

  readonly setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.lastDelay = delayMs;
    this.#tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.clearCount += 1;
    if (typeof handle === "number") this.#tasks.delete(handle);
  };

  get pending(): number {
    return this.#tasks.size;
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort(([leftId, left], [rightId, right]) =>
          left.at === right.at ? leftId - rightId : left.at - right.at,
        )[0];
      if (due === undefined) return;
      const [id, task] = due;
      this.#tasks.delete(id);
      task.callback();
    }
  }
}

function harness(options: { readonly escapeTimeoutMs?: number } = {}): {
  readonly commands: TuiCommand[];
  readonly timers: FakeTimers;
  readonly controller: TuiInputParser;
} {
  const commands: TuiCommand[] = [];
  const timers = new FakeTimers();
  const controller = createTuiInputParser({
    emit: (command) => commands.push(command),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...(options.escapeTimeoutMs === undefined
      ? {}
      : { escapeTimeoutMs: options.escapeTimeoutMs }),
  });
  return { commands, timers, controller };
}

test("exact character and control keys emit their commands", () => {
  const { commands, controller } = harness();

  controller.push("q");
  controller.push(Buffer.from("\u0003"));
  controller.push("r");
  controller.push("j");
  controller.push("k");
  controller.push("\t");
  controller.push("\r");
  controller.push("\n");

  assert.deepEqual(commands, [
    "quit",
    "quit",
    "refresh",
    "move-down",
    "move-up",
    "next-pane",
    "open-detail",
    "open-detail",
  ]);
});

test("Shift-Tab and cursor arrows map to pane and selection commands", () => {
  const { commands, controller } = harness();

  controller.push(`${ESCAPE}[Z`);
  controller.push(`${ESCAPE}[A`);
  controller.push(`${ESCAPE}[B`);
  controller.push(`${ESCAPE}[C`);
  controller.push(`${ESCAPE}[D`);
  controller.push(`${ESCAPE}OA`);
  controller.push(`${ESCAPE}OB`);
  controller.push(`${ESCAPE}OC`);
  controller.push(`${ESCAPE}OD`);

  assert.deepEqual(commands, [
    "previous-pane",
    "move-up",
    "move-down",
    "next-pane",
    "previous-pane",
    "move-up",
    "move-down",
    "next-pane",
    "previous-pane",
  ]);
});

test("pasted or otherwise multi-character text never invokes letter commands", () => {
  const { commands, controller } = harness();

  for (const input of [
    "qrjk",
    "please quit with q",
    "refresh r",
    "Q",
    "R",
    "jj",
    "k\n",
    "\tq",
  ]) {
    controller.push(input);
  }

  assert.deepEqual(commands, []);
});

test("bracketed paste is inert even when markers and payload are split", () => {
  const { commands, controller } = harness();

  controller.push(`${ESCAPE}[20`);
  controller.push("0~q");
  controller.push("r");
  controller.push("jk");
  controller.push(`${ESCAPE}[20`);
  controller.push("1~q");

  assert.deepEqual(commands, []);

  controller.push("r");
  assert.deepEqual(commands, ["refresh"]);
});

test("bare Escape emits close-detail at the bounded timeout", () => {
  const { commands, timers, controller } = harness({ escapeTimeoutMs: 50 });

  controller.push(ESCAPE);
  assert.equal(timers.pending, 1);
  assert.equal(timers.lastDelay, 50);
  timers.advance(49);
  assert.deepEqual(commands, []);
  timers.advance(1);
  assert.deepEqual(commands, ["close-detail"]);
  assert.equal(timers.pending, 0);
});

test("the default bare-Escape decision is no longer than 50ms", () => {
  const { commands, timers, controller } = harness();

  controller.push(ESCAPE);
  assert.equal(timers.lastDelay, DEFAULT_ESCAPE_TIMEOUT_MS);
  assert.ok(DEFAULT_ESCAPE_TIMEOUT_MS <= MAX_ESCAPE_TIMEOUT_MS);
  timers.advance(MAX_ESCAPE_TIMEOUT_MS);
  assert.deepEqual(commands, ["close-detail"]);
});

test("CSI sequences can be split across arbitrary input chunks", () => {
  const { commands, timers, controller } = harness();

  controller.push(ESCAPE);
  timers.advance(10);
  controller.push("[");
  timers.advance(10);
  controller.push("A");

  controller.push(`${ESCAPE}[`);
  controller.push("Z");

  controller.push(ESCAPE);
  controller.push("O");
  controller.push("B");

  assert.deepEqual(commands, ["move-up", "previous-pane", "move-down"]);
  assert.equal(timers.pending, 0);
});

test("Alt and unsupported Escape inputs do not leak suffix keys", () => {
  const { commands, timers, controller } = harness();

  controller.push(ESCAPE);
  controller.push("q");
  timers.advance(MAX_ESCAPE_TIMEOUT_MS);

  controller.push(`${ESCAPE}r`);
  controller.push(`${ESCAPE}[1;5A`);
  controller.push(`${ESCAPE}[Aq`);
  controller.push(`${ESCAPE}[qr`);

  assert.deepEqual(commands, []);

  controller.push("r");
  assert.deepEqual(commands, ["refresh"]);
});

test("unknown and incomplete sequences expire harmlessly", () => {
  const { commands, timers, controller } = harness();

  controller.push(`${ESCAPE}[`);
  assert.equal(timers.pending, 1);
  timers.advance(DEFAULT_ESCAPE_TIMEOUT_MS);
  assert.deepEqual(commands, []);
  assert.equal(timers.pending, 0);

  controller.push(ESCAPE);
  controller.push("[");
  controller.push("9");
  timers.advance(DEFAULT_ESCAPE_TIMEOUT_MS);
  assert.deepEqual(commands, []);

  for (const input of ["", "x", " ", "\u007f", "\u0001", "mouse"]) {
    controller.push(input);
  }
  assert.deepEqual(commands, []);
});

test("split unsupported CSI sequences consume command-valued final bytes", () => {
  const { commands, controller } = harness();

  controller.push(ESCAPE);
  controller.push("[");
  controller.push("1");
  controller.push("q");

  controller.push(`${ESCAPE}[`);
  controller.push("9;");
  controller.push("9");
  controller.push("r");

  assert.deepEqual(commands, []);
  controller.push("r");
  assert.deepEqual(commands, ["refresh"]);
});

test("dispose clears pending timers, is idempotent, and ignores later input", () => {
  const { commands, timers, controller } = harness();

  controller.push(ESCAPE);
  assert.equal(timers.pending, 1);
  controller.dispose();
  controller.dispose();

  assert.equal(timers.pending, 0);
  assert.equal(timers.clearCount, 1);
  timers.advance(MAX_ESCAPE_TIMEOUT_MS);
  controller.push("q");
  controller.push(`${ESCAPE}[A`);
  assert.deepEqual(commands, []);
});

test("timeout configuration is bounded and timer injection is paired", () => {
  const emit = (): void => undefined;
  const noopSet = (): unknown => 1;
  const noopClear = (): void => undefined;

  assert.throws(
    () => new TuiInputParser({ emit, escapeTimeoutMs: -1 }),
    /between 0 and 50/,
  );
  assert.throws(
    () => new TuiInputParser({ emit, escapeTimeoutMs: 51 }),
    /between 0 and 50/,
  );
  assert.throws(
    () => new TuiInputParser({ emit, escapeTimeoutMs: Number.NaN }),
    /between 0 and 50/,
  );
  assert.throws(
    () => new TuiInputParser({ emit, setTimeout: noopSet }),
    /provided together/,
  );
  assert.throws(
    () => new TuiInputParser({ emit, clearTimeout: noopClear }),
    /provided together/,
  );
});
