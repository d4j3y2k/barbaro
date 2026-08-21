import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type {
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../../src/contracts/v1.js";
import { runClaudeTrace } from "../../../src/runner/claude.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "claude");
const SPEC = join(process.cwd(), "spec");
const FIXTURE_WORKSPACE = "/tmp/demo-workspace";

/**
 * Scenarios with a checked-in exact expectation. The pair of assertions is
 * deliberate: the schema oracle proves a record is *legal* under the frozen
 * contract, and the expectation proves it is the *same* record as last time.
 * Either alone would miss a whole class of regression.
 */
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
] as const;

interface Bundle {
  readonly turns: BarbaroTurnV1[];
  readonly evidence: BarbaroEvidenceV1[];
}

interface AjvLike {
  addSchema(schema: unknown, key: string): void;
  getSchema(key: string): AjvValidator | undefined;
}
interface AjvValidator {
  (data: unknown): boolean;
  errors?: { instancePath?: string; message?: string }[] | null;
}

// ajv ships CommonJS; createRequire avoids the ESM default-interop dance.
const requireCjs = createRequire(import.meta.url);

async function buildValidator(): Promise<
  (record: { schema?: unknown }) => string[]
> {
  const Ajv2020 = requireCjs("ajv/dist/2020.js") as new (
    options: Record<string, unknown>,
  ) => AjvLike;
  const addFormats = requireCjs("ajv-formats") as (ajv: AjvLike) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const file of await readdir(SPEC)) {
    if (!file.endsWith(".schema.json")) continue;
    ajv.addSchema(JSON.parse(await readFile(join(SPEC, file), "utf8")), file);
  }
  const byName: Record<string, string> = {
    "barbaro.turn.v1": "barbaro-turn-v1.schema.json",
    "barbaro.evidence.v1": "barbaro-evidence-v1.schema.json",
    "barbaro.active.v1": "barbaro-active-v1.schema.json",
  };
  return (record) => {
    const name = byName[String(record.schema)];
    if (!name) return [`unknown schema: ${String(record.schema)}`];
    const validate = ajv.getSchema(name);
    if (!validate) return [`schema not loaded: ${name}`];
    if (validate(record)) return [];
    return (validate.errors ?? []).map(
      (error) => `${error.instancePath ?? "/"} ${error.message ?? "invalid"}`,
    );
  };
}

async function ingest(scenario: string, sessionId: string): Promise<Bundle> {
  const projectRoot = await mkdtemp(join(tmpdir(), "barbaro-expected-"));
  const sourceRoot = join(FIXTURES, scenario, "projects", "-tmp-demo-workspace");
  const traceRoot = join(projectRoot, "traces");
  await mkdir(traceRoot, { recursive: true });

  const walk = async (relative: string): Promise<void> => {
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
      await writeFile(
        target,
        raw.split(FIXTURE_WORKSPACE).join(projectRoot),
        "utf8",
      );
    }
  };
  await walk("");

  const result = await runClaudeTrace({
    tracePath: join(traceRoot, `${sessionId}.jsonl`),
    projectRoot,
  });
  const read = async <T>(kind: string): Promise<T[]> => {
    const raw = await readFile(
      join(projectRoot, ".barbaro", kind, "claude", `${result.session_id}.jsonl`),
      "utf8",
    ).catch(() => "");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  };
  const bundle: Bundle = {
    turns: await read<BarbaroTurnV1>("feed"),
    evidence: await read<BarbaroEvidenceV1>("evidence"),
  };

  // Emitted records must never carry a machine path. This is asserted here
  // rather than only in the expectation because the expectation is generated.
  const serialized = JSON.stringify(bundle);
  assert.ok(
    !serialized.includes(projectRoot),
    `${scenario}: absolute project path leaked into output`,
  );
  return bundle;
}

for (const [scenario, sessionId] of SCENARIOS) {
  test(`${scenario}: output matches its checked-in expectation`, async () => {
    const actual = await ingest(scenario, sessionId);
    const expectedPath = join(FIXTURES, `${scenario}.expected.json`);
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as Bundle;

    assert.deepEqual(
      actual.turns,
      expected.turns,
      `${scenario}: turn digests drifted from the expectation`,
    );
    assert.deepEqual(
      actual.evidence,
      expected.evidence,
      `${scenario}: evidence drifted from the expectation`,
    );
  });

  test(`${scenario}: every record validates against the frozen schemas`, async () => {
    const validate = await buildValidator();
    const { turns, evidence } = await ingest(scenario, sessionId);
    assert.ok(turns.length + evidence.length > 0, `${scenario}: produced nothing`);

    for (const record of [...turns, ...evidence]) {
      const errors = validate(record);
      assert.deepEqual(
        errors,
        [],
        `${scenario}: ${String(record.schema)} failed validation`,
      );
    }

    // Referential integrity: a digest must never point at evidence that was
    // not published alongside it.
    const known = new Set(evidence.map((item) => item.evidence_id));
    for (const turn of turns) {
      for (const ref of turn.evidence_refs) {
        assert.ok(known.has(ref), `${scenario}: dangling evidence_ref ${ref}`);
      }
      for (const ref of turn.subagents.evidence_refs) {
        assert.ok(known.has(ref), `${scenario}: dangling subagent ref ${ref}`);
      }
    }
  });
}

test("ingestion is reproducible: two independent runs agree exactly", async () => {
  for (const [scenario, sessionId] of SCENARIOS) {
    const first = await ingest(scenario, sessionId);
    const second = await ingest(scenario, sessionId);
    assert.deepEqual(second, first, `${scenario} is not reproducible`);
  }
});
