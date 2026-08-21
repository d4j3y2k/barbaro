#!/usr/bin/env node
/**
 * Regenerate the checked-in `.expected.json` files for the Claude fixtures.
 *
 * Run after a deliberate change to the Claude adapter's output, and review the
 * resulting diff as part of the change — the expectations exist so that output
 * drift is visible in review rather than silent.
 *
 *   npm run build && node scripts/regenerate-claude-expected.mjs
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runClaudeTrace } from "../dist/src/runner/claude.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "claude");
const FIXTURE_WORKSPACE = "/tmp/demo-workspace";

const SCENARIOS = [
  ["missing-origin", "11111111-1111-4111-8111-111111111111"],
  ["failed-tool-loop", "22222222-2222-4222-8222-222222222222"],
  ["subagent-join", "33333333-3333-4333-8333-333333333333"],
  ["compaction-forks", "44444444-4444-4444-8444-444444444444"],
  ["terminal-split", "55555555-5555-4555-8555-555555555555"],
  ["reverse-tool-results", "66666666-6666-4666-8666-666666666666"],
  ["async-child", "77777777-7777-4777-8777-777777777777"],
  ["poisoned-paths", "88888888-8888-4888-8888-888888888888"],
  ["sticky-suppression", "99999999-9999-4999-8999-999999999999"],
  ["active-fork", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ["parallel-group", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
];

for (const [scenario, sessionId] of SCENARIOS) {
  const projectRoot = await mkdtemp(join(tmpdir(), "barbaro-regen-"));
  const sourceRoot = join(FIXTURES, scenario, "projects", "-tmp-demo-workspace");
  const traceRoot = join(projectRoot, "traces");
  await mkdir(traceRoot, { recursive: true });

  const walk = async (relative) => {
    for (const entry of await readdir(join(sourceRoot, relative), {
      withFileTypes: true,
    })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const raw = await readFile(join(sourceRoot, next), "utf8");
      const target = join(traceRoot, next);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, raw.split(FIXTURE_WORKSPACE).join(projectRoot), "utf8");
    }
  };
  await walk("");

  const result = await runClaudeTrace({
    tracePath: join(traceRoot, `${sessionId}.jsonl`),
    projectRoot,
  });
  const read = async (kind) => {
    const raw = await readFile(
      join(projectRoot, ".barbaro", kind, "claude", `${result.session_id}.jsonl`),
      "utf8",
    ).catch(() => "");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };

  const bundle = { turns: await read("feed"), evidence: await read("evidence") };
  const serialized = JSON.stringify(bundle);
  if (serialized.includes(projectRoot)) {
    throw new Error(`${scenario}: refusing to write an expectation containing a machine path`);
  }

  await writeFile(
    join(FIXTURES, `${scenario}.expected.json`),
    `${JSON.stringify(bundle, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `${scenario}: ${bundle.turns.length} turns, ${bundle.evidence.length} evidence`,
  );
}
