import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type {
  BarbaroSubagentTurnEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";

interface AjvValidator {
  (value: unknown): boolean;
  errors?: readonly unknown[] | null;
}

interface AjvLike {
  addSchema(schema: unknown, key: string): void;
  getSchema(key: string): AjvValidator | undefined;
}

const requireCjs = createRequire(import.meta.url);
const EXAMPLES = join(process.cwd(), "examples", "v1");
const SPEC = join(process.cwd(), "spec");

async function validators(): Promise<Record<string, AjvValidator>> {
  const Ajv2020 = requireCjs("ajv/dist/2020.js") as new (
    options: Record<string, unknown>,
  ) => AjvLike;
  const addFormats = requireCjs("ajv-formats") as (ajv: AjvLike) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const name of await readdir(SPEC)) {
    if (!name.endsWith(".schema.json")) continue;
    ajv.addSchema(
      JSON.parse(await readFile(join(SPEC, name), "utf8")) as unknown,
      name,
    );
  }
  const result: Record<string, AjvValidator> = {};
  for (const [schema, name] of Object.entries({
    "barbaro.turn.v1": "barbaro-turn-v1.schema.json",
    "barbaro.evidence.v1": "barbaro-evidence-v1.schema.json",
    "barbaro.active.v1": "barbaro-active-v1.schema.json",
  })) {
    const validate = ajv.getSchema(name);
    assert.ok(validate, `schema did not load: ${name}`);
    result[schema] = validate;
  }
  return result;
}

test("every normative v1 example validates against its declared schema", async () => {
  const validate = await validators();
  for (const name of await readdir(EXAMPLES)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(
      await readFile(join(EXAMPLES, name), "utf8"),
    ) as { schema?: string };
    const check = record.schema ? validate[record.schema] : undefined;
    assert.ok(check, `${name}: unknown schema ${String(record.schema)}`);
    assert.equal(
      check(record),
      true,
      `${name}: ${JSON.stringify(check.errors ?? [])}`,
    );
  }
});

test("the shared subagent example pins the M7 shape and lineage", async () => {
  const evidence = JSON.parse(
    await readFile(join(EXAMPLES, "evidence-subagent.json"), "utf8"),
  ) as BarbaroSubagentTurnEvidenceV1;
  const parent = JSON.parse(
    await readFile(join(EXAMPLES, "turn-completed.json"), "utf8"),
  ) as BarbaroTurnV1;

  assert.equal(evidence.kind, "subagent_turn");
  assert.notEqual(evidence.turn_id, evidence.parent_turn_id);
  assert.equal(evidence.parent_turn_id, parent.turn_id);
  assert.equal(evidence.occurred_at, evidence.content.ended_at);
  assert.deepEqual(Object.keys(evidence.content).sort(), [
    "actions",
    "ended_at",
    "outcome",
    "request",
    "response",
    "role",
    "sequence",
    "started_at",
  ]);
  for (const forbidden of [
    "turn",
    "turns",
    "child_turn_id",
    "changed_paths",
    "subagent_kind",
    "workflow_id",
  ]) {
    assert.ok(!(forbidden in evidence.content), forbidden);
  }
  assert.equal(evidence.extensions?.claude?.subagent_kind, "direct_agent");

  assert.deepEqual(parent.evidence_refs, [evidence.evidence_id]);
  assert.deepEqual(parent.subagents.evidence_refs, [evidence.evidence_id]);
  assert.equal(parent.subagents.total, 1);

  assert.equal(evidence.source_refs.length, 2);
  assert.match(evidence.source_refs[0]!.trace_id, /:agent:/);
  assert.match(evidence.source_refs[1]!.trace_id, /:main$/);
  assert.deepEqual(evidence.source_refs[0]!.native_record_ids, [
    "sidechain-root-uuid",
    "sidechain-terminal-uuid",
  ]);
  assert.deepEqual(evidence.source_refs[1]!.native_record_ids, [
    "agent-tool-result-uuid",
  ]);
});
