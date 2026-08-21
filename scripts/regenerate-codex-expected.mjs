#!/usr/bin/env node
/**
 * Regenerate the checked-in `.expected.json` files for the Codex fixtures.
 *
 * The fixture oracle and synthetic trace IDs are hand-authored test inputs.
 * This script preserves them while replacing only normalized turn output.
 *
 *   npm run build && node scripts/regenerate-codex-expected.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readJsonlForward } from "../dist/src/core/jsonl-reader.js";
import { CodexTurnNormalizer } from "../dist/src/providers/codex/index.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "codex");
const SCENARIOS = [
  "success-turn",
  "aborted-turn",
  "failed-turn",
  "tool-pairing",
  "duplicate-projections",
  "repeated-session-meta",
  "unknown-types",
  "partial-final-line",
  "security-risk-score-head",
];

for (const scenario of SCENARIOS) {
  const expectedPath = join(FIXTURES, `${scenario}.expected.json`);
  const previous = JSON.parse(await readFile(expectedPath, "utf8"));
  const traceId = previous.turns?.[0]?.source_refs?.[0]?.trace_id;
  if (typeof traceId !== "string" || traceId.length === 0) {
    throw new Error(`${scenario}: expected turn must supply a trace_id`);
  }

  const normalizer = new CodexTurnNormalizer();
  const turns = [];
  await readJsonlForward(
    join(FIXTURES, `${scenario}.input.jsonl`),
    (line) => {
      if (line.kind !== "record") return;
      turns.push(
        ...normalizer.accept(line.value, {
          traceId,
          lineNumber: line.lineNumber,
          byteStart: line.byteStart,
          byteEndExclusive: line.byteEndExclusive,
        }).turns,
      );
    },
  );

  await writeFile(
    expectedPath,
    `${JSON.stringify({ turns, oracle: previous.oracle }, null, 2)}\n`,
    "utf8",
  );
  console.log(`${scenario}: ${turns.length} turns`);
}
