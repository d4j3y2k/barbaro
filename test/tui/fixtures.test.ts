import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { measureCells } from "../../src/tui/cells.js";
import { stripRows64 } from "../../src/tui/strip.js";

/**
 * Gate 1: the index, this validator, and the fixture directory name the
 * same twenty-six files; every indexed file has exact filename dimensions and a
 * final newline. These bytes are the normative comfort keyframes.
 */
export const FIXTURE_INDEX = [
  "boot-40x12.txt",
  "boot-56x22.txt",
  "boot-64x28.txt",
  "create-form-11x4.txt",
  "create-form-12x6.txt",
  "create-form-64x28.txt",
  "create-success-64x28.txt",
  "create-success-no-clipboard-64x28.txt",
  "create-success-punched-64x28.txt",
  "dashboard-idle-56x22.txt",
  "dashboard-idle-64x28.txt",
  "dashboard-once-strip-64x28.txt",
  "dashboard-working-56x22.txt",
  "dashboard-working-64x28.txt",
  "help-64x28.txt",
  "hub-40x12.txt",
  "hub-56x22.txt",
  "hub-64x28.txt",
  "hub-completed-56x22.txt",
  "hub-completed-64x28.txt",
  "lifecycle-confirm-56x22.txt",
  "lifecycle-confirm-64x28.txt",
  "lifecycle-confirmed-56x22.txt",
  "lifecycle-confirmed-64x28.txt",
  "lifecycle-pending-56x22.txt",
  "lifecycle-pending-64x28.txt",
] as const;

// The suite runs from the repository root; fixtures are source test data.
const FIXTURES_DIRECTORY = join(process.cwd(), "test", "tui", "fixtures");

export async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIRECTORY, name), "utf8");
}

export function fixtureLines(content: string): string[] {
  return content.slice(0, -1).split("\n");
}

test("the fixture directory holds exactly the twenty-six indexed keyframes", async () => {
  const entries = await readdir(FIXTURES_DIRECTORY);
  assert.deepEqual([...entries].sort(), [...FIXTURE_INDEX].sort());
});

test("every keyframe has exact filename dimensions and a final newline", async () => {
  for (const name of FIXTURE_INDEX) {
    const match = /-(\d+)x(\d+)\.txt$/u.exec(name);
    assert.ok(match !== null, `${name} names its dimensions`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    const content = await readFixture(name);
    assert.ok(content.endsWith("\n"), `${name} ends with a newline`);
    const lines = fixtureLines(content);
    assert.equal(lines.length, height, `${name} has ${height} rows`);
    for (const [index, line] of lines.entries()) {
      assert.equal(
        measureCells(line),
        width,
        `${name} row ${index + 1} measures ${width} cells`,
      );
    }
  }
});

test("fixture footers never advertise bare refresh, help, or motion keys", async () => {
  for (const name of FIXTURE_INDEX) {
    const footer = fixtureLines(await readFixture(name)).at(-1)!.trimEnd();
    assert.doesNotMatch(
      footer,
      /(?:^| · )(?:r|\?|Space)(?= · |$)/u,
      `${name} labels every advertised secondary key`,
    );
  }
});

test("the checked-in strip asset is byte-identical to its keyframe", async () => {
  const lines = fixtureLines(
    await readFixture("dashboard-once-strip-64x28.txt"),
  );
  // Card rows 6-10 are the label row and four art rows inside the walls.
  const interior = lines.slice(5, 10).map((line) => line.slice(1, 63));
  assert.deepEqual(stripRows64(), interior);
});
