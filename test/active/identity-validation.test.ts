import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVE_LEASE_SCHEMA,
  ActiveLeaseValidationError,
  activeActorFilename,
  deriveLeaseId,
  isActiveLeaseVisible,
  validateActiveLease,
  type ActiveLeaseV1,
} from "../../src/active/index.js";

const VALID_LEASE: ActiveLeaseV1 = {
  schema: ACTIVE_LEASE_SCHEMA,
  lease_id: "lease_0123456789abcdef0123456789abcdef",
  provider: "codex",
  session_id: "ses_fedcba9876543210fedcba9876543210",
  turn_id: "turn_11111111111111111111111111111111",
  agent_id: "main",
  state: "working",
  claims: [
    {
      path: "src/active/store.ts",
      mode: "write",
      confidence: "exact",
    },
  ],
  unknown_write_scope: false,
  revision: 1,
  updated_at: "2026-08-16T20:00:00.000Z",
  expires_at: "2026-08-16T20:05:00.000Z",
};

test("lease identity follows the Barbaro v1 typed-hash framing", () => {
  assert.equal(
    deriveLeaseId("codex", "s-1", "agent-α"),
    "lease_99f13d8a9b938e5a4351e6807cc688f8",
  );
});

test("actor filenames are deterministic, opaque, and path-safe", () => {
  const actor = {
    provider: "codex",
    session_id: "ses_fedcba9876543210fedcba9876543210",
    agent_id: "../../main / agent-α",
  };
  const filename = activeActorFilename(actor);

  assert.match(filename, /^actor_[0-9a-f]{64}\.json$/);
  assert.equal(filename, activeActorFilename(actor));
  assert.equal(filename.includes("main"), false);
  assert.equal(filename.includes("/"), false);
  assert.notEqual(
    filename,
    activeActorFilename({
      ...actor,
      session_id: "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  );
});

test("dependency-free validation covers essential active invariants", () => {
  assert.doesNotThrow(() => validateActiveLease(VALID_LEASE));

  const missingUnknownScope = { ...VALID_LEASE } as Record<string, unknown>;
  delete missingUnknownScope.unknown_write_scope;
  assert.throws(
    () => validateActiveLease(missingUnknownScope),
    ActiveLeaseValidationError,
  );

  assert.throws(
    () =>
      validateActiveLease({
        ...VALID_LEASE,
        expires_at: VALID_LEASE.updated_at,
      }),
    /later than updated_at/,
  );

  assert.throws(
    () =>
      validateActiveLease({
        ...VALID_LEASE,
        updated_at: "2026-02-31T20:00:00.000Z",
      }),
    /real RFC 3339 date-time/,
  );

  assert.throws(
    () =>
      validateActiveLease({
        ...VALID_LEASE,
        claims: [
          { path: "../outside", mode: "write", confidence: "inferred" },
        ],
      }),
    /workspace-relative POSIX path/,
  );

  assert.throws(
    () => validateActiveLease({ ...VALID_LEASE, lock_owner: "main" }),
    /not allowed/,
  );
});

test("consumer visibility excludes idle and leases at their expiry instant", () => {
  assert.equal(
    isActiveLeaseVisible(VALID_LEASE, Date.parse("2026-08-16T20:04:59.999Z")),
    true,
  );
  assert.equal(
    isActiveLeaseVisible(VALID_LEASE, Date.parse(VALID_LEASE.expires_at)),
    false,
  );
  assert.equal(
    isActiveLeaseVisible({ ...VALID_LEASE, state: "idle" }, Date.parse(VALID_LEASE.updated_at)),
    false,
  );
});

test("a lease may carry its session's workstream, and only a well-formed one", () => {
  validateActiveLease({
    ...VALID_LEASE,
    workstream_id: "ws_0123456789abcdef0123456789abcdef",
  });
  assert.throws(
    () => validateActiveLease({ ...VALID_LEASE, workstream_id: "tui-design" }),
    ActiveLeaseValidationError,
  );
});
