import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPACT_LEASE_FIELDS,
  PEER_CONTEXT_AUTOMATION_MILESTONE,
  PEER_CONTEXT_FEED_RECORDS_PER_SESSION,
  PEER_CONTEXT_RENDER_BUDGET_BYTES,
  buildSetupGuidance,
  launchGuidance,
  peerContextPreflight,
  type Diagnostic,
  type DiagnosticStatus,
} from "../../src/setup/index.js";

function diagnostic(
  id: string,
  status: DiagnosticStatus,
  extraFacts: readonly { key: string; value: boolean }[] = [],
): Diagnostic {
  return {
    id,
    title: id,
    status,
    summary: id,
    facts: [...extraFacts],
    remediation: [],
  };
}

const HEALTHY: readonly Diagnostic[] = [
  diagnostic("build.dist-freshness", "pass"),
  diagnostic("gitignore.barbaro-ignored", "pass"),
  diagnostic("hooks.claude", "pass"),
  diagnostic("hooks.codex", "pass"),
  diagnostic("views.coordination-state", "pass"),
  diagnostic("workspace.isolation", "pass", [
    { key: "isolation_available", value: true },
  ]),
];

test("a healthy project still receives the standing launch invariants", () => {
  const steps = launchGuidance(HEALTHY);
  assert.deepEqual(
    steps.map((step) => step.id),
    [
      "launch.join-session",
      "launch.one-lane-per-actor",
      "launch.recheck-leases",
      "launch.read-only-store",
      "launch.manual-config-only",
    ],
  );
});

test("each failing check adds its own ordered launch step", () => {
  const steps = launchGuidance([
    diagnostic("build.dist-freshness", "warn"),
    diagnostic("gitignore.barbaro-ignored", "fail"),
    diagnostic("hooks.claude", "fail"),
    diagnostic("hooks.codex", "pass"),
    diagnostic("views.coordination-state", "warn"),
    diagnostic("workspace.isolation", "warn", [
      { key: "isolation_available", value: false },
    ]),
  ]);
  assert.deepEqual(steps.slice(0, 5).map((step) => step.id), [
    "launch.build-first",
    "launch.fix-hooks-claude",
    "launch.ignore-store",
    "launch.verify-publishing",
    "launch.disjoint-ownership",
  ]);
});

test("guidance never proposes an automatic repair", () => {
  const text = launchGuidance(HEALTHY)
    .concat(peerContextPreflight())
    .map((step) => step.text)
    .join(" ");
  assert.match(text, /never mutates project, user, or global settings/);
  assert.equal(/\bauto-install|automatically install/i.test(text), false);
});

test("the bounded context preflight states every limit it enforces", () => {
  const steps = peerContextPreflight();
  const ids = steps.map((step) => step.id);
  assert.deepEqual(new Set(ids).size, ids.length);
  const text = steps.map((step) => step.text).join(" ");
  assert.match(text, new RegExp(String(PEER_CONTEXT_RENDER_BUDGET_BYTES)));
  assert.match(
    text,
    new RegExp(`newest ${PEER_CONTEXT_FEED_RECORDS_PER_SESSION} feed records`),
  );
  assert.match(text, /evidence_ref/);
  assert.match(text, /bounded attention view/);
  assert.match(text, /older turns even when shown equals total/);
  assert.match(text, /whenever completeness or absence matters/);
  assert.match(text, /shown is below total/);
  assert.match(text, /truncated\.projection/);
  assert.match(text, /barbaro turn list/);
  assert.match(text, /barbaro turn show <turn_id> --field response/);
  assert.match(text, /barbaro turn show <turn_id> --field record/);
  assert.match(text, /barbaro evidence show/);
  assert.match(text, /Never read or print `\.barbaro\/\*\*\/\*\.jsonl` directly/);
  assert.match(text, /initial `barbaro context` attention view/);
  assert.match(text, /exhaustive turn and evidence retrieval remains available/);
  assert.match(text, /every canonical turn byte/);
  assert.match(text, /exposed file and record limits/);
  assert.match(text, /provider-native fields or records omitted during adapter mapping/);
  assert.match(text, /barbaro context/);
  assert.match(text, new RegExp(PEER_CONTEXT_AUTOMATION_MILESTONE));
});

test("published limits match the documented preflight contract", () => {
  const guidance = buildSetupGuidance(HEALTHY);
  assert.equal(guidance.peer_context_limits.render_budget_bytes, 32 * 1024);
  assert.equal(guidance.peer_context_limits.feed_records_per_session, 5);
  assert.deepEqual(
    guidance.peer_context_limits.compact_lease_fields,
    COMPACT_LEASE_FIELDS,
  );
  assert.equal(guidance.peer_context_automated_by, "barbaro context");
  assert.equal(
    COMPACT_LEASE_FIELDS.includes("expires_at") &&
      COMPACT_LEASE_FIELDS.includes("claims"),
    true,
  );
});

test("hook guidance follows the providers that were actually checked", () => {
  const steps = launchGuidance(
    [diagnostic("hooks.codex", "fail"), diagnostic("hooks.claude", "fail")],
    ["codex"],
  );
  assert.deepEqual(
    steps.filter((step) => step.id.startsWith("launch.fix-hooks-")).map(
      (step) => step.id,
    ),
    ["launch.fix-hooks-codex"],
  );
});
