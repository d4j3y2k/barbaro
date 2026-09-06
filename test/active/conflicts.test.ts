import assert from "node:assert/strict";
import test from "node:test";
import { claimOverlapIdentity, projectClaimOverlaps, projectWriteClaims } from "../../src/active/conflicts.js";
import type { ActiveLeaseV1 } from "../../src/active/types.js";

const now = new Date("2026-09-05T21:00:00.000Z");
function lease(actor: string, paths: string[], overrides: Partial<ActiveLeaseV1> = {}): ActiveLeaseV1 {
  return {
    schema: "barbaro.active.v1", lease_id: `lease_${actor.repeat(32)}`,
    provider: "codex", session_id: `ses_${actor.repeat(32)}`, agent_id: "main",
    workstream_id: `ws_${actor.repeat(32)}`, state: "working", revision: 1,
    updated_at: now.toISOString(), expires_at: "2026-09-05T21:05:00.000Z",
    claims: paths.map((path) => ({ path, mode: "write", confidence: "exact" })),
    unknown_write_scope: false, ...overrides,
  };
}

test("shared claims normalize POSIX aliases, distinguish sibling prefixes and retain weaker confidence", () => {
  const claims = projectWriteClaims("/repo", [
    lease("a", ["/repo/src/a.ts", "./src/a.ts", "src/./a.ts"]),
    lease("b", ["src/a.ts", "src/ab.ts", "src/a.ts/more"]),
    lease("c", ["src/a.ts"], { claims: [{ path: "src/a.ts", mode: "write", confidence: "inferred" }] }),
  ], now);
  assert.equal(claims.length, 5);
  const overlaps = projectClaimOverlaps(claims, `ws_${"a".repeat(32)}`);
  assert.equal(overlaps.length, 3);
  assert.deepEqual(overlaps.map((item) => item.confidence).sort(), ["exact", "inferred", "inferred"]);
  assert.ok(overlaps.every((item) => item.local.workstream_id === `ws_${"a".repeat(32)}`));
  assert.ok(overlaps.every((item) => item.foreign.path !== "src/ab.ts"));
  const first = overlaps[0]!;
  assert.equal(claimOverlapIdentity(first), claimOverlapIdentity({ ...first, local: { ...first.local, expires_at: "later" } }));
  assert.notEqual(claimOverlapIdentity(first), claimOverlapIdentity({ ...first, local: { ...first.local, unknown_write_scope: true } }));
});

test("unknown/outside paths, same-workstream claims and expired/idle actors do not invent overlaps", () => {
  const a = lease("a", ["src/a.ts"]);
  const claims = projectWriteClaims("/repo", [a,
    lease("b", [], { unknown_write_scope: true }),
    lease("c", ["/outside/a", "C:\\wrong", "../outside"]),
    lease("d", ["src/a.ts"], { workstream_id: a.workstream_id! }),
    lease("e", ["src/a.ts"], { expires_at: now.toISOString() }),
    lease("f", ["src/a.ts"], { state: "idle" }),
  ], now);
  assert.equal(claims.length, 4);
  assert.equal(claims.filter((claim) => claim.path === null && claim.confidence === "unknown").length, 2);
  assert.deepEqual(projectClaimOverlaps(claims), []);
});
