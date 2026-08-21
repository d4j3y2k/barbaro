import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  type JsonlLine,
  readJsonlForward,
} from "../../src/core/jsonl-reader.js";

const testDirectory = await mkdtemp(join(tmpdir(), "barbaro-jsonl-reader-"));

after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

test("streams complete lines, reports malformed input, and retains a partial EOF line", async () => {
  const filePath = join(testDirectory, "mixed.jsonl");
  await writeFile(filePath, '{"a":1}\nnot-json\n{"b":2', "utf8");

  const events: JsonlLine<unknown>[] = [];
  const summary = await readJsonlForward(
    filePath,
    (event) => {
      events.push(event);
    },
    { highWaterMark: 3 },
  );

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "record",
    value: { a: 1 },
    raw: '{"a":1}',
    lineNumber: 1,
    byteStart: 0,
    byteEndExclusive: 8,
    nextOffset: 8,
  });
  assert.equal(events[1]?.kind, "malformed");
  assert.equal(events[1]?.raw, "not-json");
  assert.equal(events[1]?.lineNumber, 2);
  assert.equal(events[1]?.byteStart, 8);
  assert.equal(events[1]?.byteEndExclusive, 17);

  assert.equal(summary.startOffset, 0);
  assert.equal(summary.checkpointOffset, 17);
  assert.equal(summary.nextLineNumber, 3);
  assert.equal(summary.completeLines, 2);
  assert.equal(summary.parsedLines, 1);
  assert.equal(summary.malformedLines, 1);
  assert.equal(summary.observedSize, 23);
  assert.deepEqual(summary.partialFinalLine, {
    byteStart: 17,
    byteLength: 6,
    lineNumber: 3,
  });

  await appendFile(filePath, "}\n", "utf8");
  const resumed: JsonlLine<unknown>[] = [];
  const resumedSummary = await readJsonlForward(
    filePath,
    (event) => {
      resumed.push(event);
    },
    {
      startOffset: summary.checkpointOffset,
      nextLineNumber: summary.nextLineNumber,
      highWaterMark: 2,
    },
  );

  assert.deepEqual(resumed, [
    {
      kind: "record",
      value: { b: 2 },
      raw: '{"b":2}',
      lineNumber: 3,
      byteStart: 17,
      byteEndExclusive: 25,
      nextOffset: 25,
    },
  ]);
  assert.equal(resumedSummary.checkpointOffset, 25);
  assert.equal(resumedSummary.partialFinalLine, undefined);
});

test("accepts CRLF while retaining byte-accurate offsets", async () => {
  const filePath = join(testDirectory, "crlf.jsonl");
  await writeFile(filePath, '{"α":1}\r\n{"b":2}\r\n', "utf8");

  const events: JsonlLine<unknown>[] = [];
  const summary = await readJsonlForward(filePath, (event) => {
    events.push(event);
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.raw, '{"α":1}');
  assert.equal(events[0]?.byteStart, 0);
  assert.equal(events[0]?.byteEndExclusive, 10);
  assert.equal(events[1]?.byteStart, 10);
  assert.equal(events[1]?.byteEndExclusive, 19);
  assert.equal(summary.checkpointOffset, 19);
});

test("invalid UTF-8 is a malformed line rather than a fatal reader error", async () => {
  const filePath = join(testDirectory, "invalid-utf8.jsonl");
  await writeFile(
    filePath,
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
  );

  const events: JsonlLine<unknown>[] = [];
  const summary = await readJsonlForward(filePath, (event) => {
    events.push(event);
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "malformed");
  assert.equal(summary.malformedLines, 1);
  assert.equal(summary.checkpointOffset, 10);
});

test("callback backpressure is respected", async () => {
  const filePath = join(testDirectory, "backpressure.jsonl");
  await writeFile(filePath, "1\n2\n3\n", "utf8");
  const order: string[] = [];

  await readJsonlForward<number>(
    filePath,
    async (event) => {
      assert.equal(event.kind, "record");
      order.push(`start-${event.raw}`);
      await Promise.resolve();
      order.push(`end-${event.raw}`);
    },
    { highWaterMark: 1 },
  );

  assert.deepEqual(order, [
    "start-1",
    "end-1",
    "start-2",
    "end-2",
    "start-3",
    "end-3",
  ]);
});

test("rejects a start offset beyond EOF", async () => {
  const filePath = join(testDirectory, "short.jsonl");
  await writeFile(filePath, "{}\n", "utf8");
  await assert.rejects(
    readJsonlForward(filePath, () => undefined, { startOffset: 99 }),
    /beyond the current end/,
  );
});
