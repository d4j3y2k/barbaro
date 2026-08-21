import assert from "node:assert/strict";
import test from "node:test";

import { redactedExcerptContent } from "../../../src/providers/codex/content.js";

test("failure excerpts redact high-confidence credentials without touching source text", () => {
  const source = [
    "request failed",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
  ].join("\n");
  const copy = redactedExcerptContent(source, 4_096);

  assert.equal(copy.fidelity, "redacted");
  assert.equal(copy.truncated, false);
  assert.equal(copy.original_utf8_bytes, Buffer.byteLength(source, "utf8"));
  assert.ok(!copy.text.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.deepEqual(copy.redactions, [
    { kind: "bearer_token", count: 1 },
    { kind: "credential_assignment", count: 1 },
  ]);
  assert.ok(source.includes("abcdefghijklmnopqrstuvwxyz"), "the caller's source remains unchanged");
});

test("failure excerpt byte limits are UTF-8 safe and explicit", () => {
  const copy = redactedExcerptContent("ééé", 5);
  assert.equal(copy.text, "éé");
  assert.equal(copy.fidelity, "excerpt");
  assert.equal(copy.truncated, true);
  assert.equal(copy.original_utf8_bytes, 6);
  assert.deepEqual(copy.redactions, []);
});
