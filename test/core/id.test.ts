import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createActionId,
  createLeaseId,
  createSessionId,
  createTurnId,
  createTypedId,
  encodeTypedIdInput,
} from "../../src/core/id.js";

test("typed IDs match fixed Barbaro v1 framing vectors", () => {
  assert.equal(
    createSessionId("codex", "native-session-123"),
    "ses_50f3a84a77f18733c73f279245d28480",
  );
  assert.equal(
    createTurnId("claude", "s-1", "main", "prompt-uuid"),
    "turn_88df1764bf51faf749377657e389042b",
  );
  assert.equal(
    createLeaseId("codex", "s-1", "agent-α"),
    "lease_99f13d8a9b938e5a4351e6807cc688f8",
  );
});

test("framing uses UTF-8 byte lengths", () => {
  assert.equal(
    encodeTypedIdInput("lease", ["agent-α"]).toString("utf8"),
    "barbaro-id-v1\u0000lease\u00008:agent-α",
  );
});

test("missing and empty ID components cannot collide", () => {
  assert.equal(
    createTypedId("session", ["x", ""]),
    "ses_171ca692b69e032acc43cece0b2ef940",
  );
  assert.equal(
    createTypedId("session", ["x", null]),
    "ses_31e7fe106e93bbbdc8e537c18ff803ce",
  );
  assert.notEqual(
    createTypedId("session", ["x", ""]),
    createTypedId("session", ["x", undefined]),
  );
});

test("action occurrence indexes are validated and deterministic", () => {
  assert.equal(
    createActionId("turn_abc", "native-record", 0),
    createActionId("turn_abc", "native-record", 0),
  );
  assert.notEqual(
    createActionId("turn_abc", "native-record", 0),
    createActionId("turn_abc", "native-record", 1),
  );
  assert.throws(
    () => createActionId("turn_abc", "native-record", -1),
    /non-negative safe integer/,
  );
  assert.throws(
    () => createActionId("turn_abc", "native-record", 0.5),
    /non-negative safe integer/,
  );
});

test("unknown ID types fail closed for JavaScript callers", () => {
  assert.throws(
    () => createTypedId("unknown" as "turn", ["x"]),
    /Unsupported Barbaro ID type/,
  );
});
