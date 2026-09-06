import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActiveLeaseStore } from "../../src/active/store.js";
import type { ActiveLeaseUpdate } from "../../src/active/types.js";
import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { readProjectContext } from "../../src/reader/store.js";
import { projectClaimNotice } from "../../src/tui/reduce.js";
import { formatWatchEvent } from "../../src/watch/format.js";

const alpha = `ws_${"a".repeat(32)}`;
const beta = `ws_${"b".repeat(32)}`;
const now = new Date("2026-09-05T21:00:00.000Z");
const content = (text: string) => ({ text, fidelity: "verbatim" as const, truncated: false, redactions: [] });
function actor(id: string, workstream_id: string, paths: string[], unknown = false): ActiveLeaseUpdate {
  return {
    lease_id: `lease_${id.repeat(32)}`, provider: "codex", session_id: `ses_${id.repeat(32)}`, agent_id: "main", workstream_id,
    state: "working", intent: content(`${id} private intent`), current_action: { kind: "command", command: content(`${id} private command`) },
    claims: paths.map((path) => ({ path, mode: "write", confidence: "exact" })), unknown_write_scope: unknown,
  };
}
async function project(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-claims-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function turn(root: string, workstream_id: string, sequence: number): Promise<void> {
  const value: BarbaroTurnV1 = {
    schema: "barbaro.turn.v1", turn_id: `turn_${String(sequence).repeat(32)}`, provider: "codex", session_id: `ses_${"c".repeat(32)}`,
    workstream_id, agent_id: "main", sequence, started_at: now.toISOString(), ended_at: now.toISOString(), outcome: "success",
    request: content(workstream_id === alpha ? "local question" : "foreign conversation"), response: content("answer"), actions: [],
    subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] }, evidence_refs: [], source_refs: [],
  };
  const directory = join(root, ".barbaro/feed/codex");
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, `${value.session_id}.jsonl`), `${JSON.stringify(value)}\n`);
}

test("scoped context exposes foreign planned-write claims before local activity without foreign conversation", async (t) => {
  const root = await project(t);
  const store = new ActiveLeaseStore(join(root, ".barbaro/active"));
  await store.write(actor("b", beta, ["src/a.ts"]), { now });
  await turn(root, alpha, 1); await turn(root, beta, 2);
  const before = await readProjectContext(root, { workstreamId: alpha, now, byteBudget: 16_384 });
  assert.equal(before.value.active.total, 0);
  assert.equal(before.value.turns.total, 1);
  assert.ok(!JSON.stringify(before).includes("foreign conversation"));
  assert.ok(!JSON.stringify(before).includes("b private"));
  assert.equal(before.value.project_claims?.claims.items[0]?.path, "src/a.ts");
  assert.equal(before.value.project_claims?.claims.items[0]?.workstream_id, beta);
  assert.equal(before.value.project_claims?.overlaps.total, 0);

  await store.write(actor("a", alpha, ["src/a.ts"]), { now });
  const after = await readProjectContext(root, { workstreamId: alpha, now, byteBudget: 16_384 });
  assert.equal(after.value.active.total, 1);
  const view = after.value.project_claims!;
  assert.equal(view.claims.total, 2);
  assert.equal(view.overlaps.total, 1);
  assert.equal(view.coverage.state, "complete");
  const overlap = view.overlaps.items[0]!;
  assert.equal(overlap.local.workstream_id, alpha);
  assert.equal(overlap.foreign.workstream_id, beta);
  assert.match(projectClaimNotice(view)!, /1 advisory path overlap/u);
  const line = formatWatchEvent({ schema: "barbaro.watch.event.v1", kind: "conflict", observed_at: now.toISOString(), overlap });
  assert.match(line, /CONFLICT advisory exact/u);
  assert.match(line, /src\/a.ts/u);
  assert.match(line, /ws=bbbbbbbb/u);
  const expired = await readProjectContext(root, { workstreamId: alpha, now: new Date(now.getTime() + 600_000), byteBudget: 16_384 });
  assert.equal(expired.value.project_claims?.claims.total, 0);
  assert.equal(expired.value.project_claims?.overlaps.total, 0);
});

test("claim projection reports omitted paths and unknown actors without asserting a collision", async (t) => {
  const root = await project(t);
  const store = new ActiveLeaseStore(join(root, ".barbaro/active"));
  await store.write(actor("b", beta, Array.from({ length: 60 }, (_, i) => `src/${i}.ts`)), { now });
  await store.write(actor("d", beta, [], true), { now });
  const limited = await readProjectContext(root, { workstreamId: alpha, now, byteBudget: 2400 });
  const view = limited.value.project_claims!;
  assert.ok(Buffer.byteLength(JSON.stringify(limited) + "\n") <= 2400);
  assert.equal(view.claims.total, 61);
  assert.ok(view.claims.shown > 0 && view.claims.shown < 61);
  assert.equal(view.coverage.state, "limited");
  assert.equal(view.coverage.unknown_scope_actors, 1);
  assert.equal(view.overlaps.total, 0);
  assert.match(projectClaimNotice(view)!, /unknown write scope/u);
  const full = await readProjectContext(root, { workstreamId: alpha, now, byteBudget: 65_536 });
  assert.equal(full.value.project_claims?.claims.shown, 61);
  assert.equal(full.value.project_claims?.coverage.state, "complete");
  const unknown = full.value.project_claims?.claims.items.find((item) => item.path === null);
  assert.equal(unknown?.confidence, "unknown");
});

test("invalid active snapshots qualify project claim coverage even when all valid paths fit", async (t) => {
  const root = await project(t);
  const store = new ActiveLeaseStore(join(root, ".barbaro/active"));
  const foreign = actor("b", beta, ["src/a.ts"]);
  await store.write(foreign, { now });
  await writeFile(store.actorPath(foreign), "{}\n");
  const context = await readProjectContext(root, { workstreamId: alpha, now, byteBudget: 16_384 });
  assert.equal(context.value.project_claims?.coverage.state, "limited");
  assert.equal(context.value.project_claims?.coverage.invalid_active_records, 1);
  assert.match(projectClaimNotice(context.value.project_claims)!, /incomplete/u);
});
