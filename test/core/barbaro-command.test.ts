import assert from "node:assert/strict";
import test from "node:test";

import {
  AWAIT_LEASE_GRACE_MS,
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
  classifyAwaitCommand,
  isDigestExcludedBarbaroCommand,
  isLeadingBarbaroContextCommand,
} from "../../src/core/barbaro-command.js";

test("await classification requires exact leading shell tokens", () => {
  for (const command of [
    "barbaro await",
    "  barbaro   await --json",
    `'barbaro' "await" --timeout-ms 42`,
    "barbaro await&& echo done",
    "barbaro await; echo done",
  ]) {
    assert.ok(classifyAwaitCommand(command), command);
  }

  for (const command of [
    "barbaro awaiter",
    "barbarous await",
    "/usr/bin/barbaro await",
    "node dist/src/cli.js await",
    "echo barbaro await",
    "barbaro && await",
    "barbaro 'await; echo done'",
    `barbaro "await`,
    "barbaro await\\",
    String.raw`barbaro "aw\ait"`,
    String.raw`"bar\baro" await`,
    "\fbarbaro await",
  ]) {
    assert.equal(classifyAwaitCommand(command), undefined, command);
  }
});

test("await lease TTL follows the parsed timeout, cap, and bounded grace", () => {
  assert.deepEqual(
    classifyAwaitCommand("barbaro await --timeout-ms 120000"),
    {
      timeoutMs: 120_000,
      leaseTtlMs: 120_000 + AWAIT_LEASE_GRACE_MS,
    },
  );
  assert.deepEqual(
    classifyAwaitCommand("barbaro await --timeout-ms 9999999"),
    {
      timeoutMs: MAX_AWAIT_TIMEOUT_MS,
      leaseTtlMs: MAX_AWAIT_TIMEOUT_MS + AWAIT_LEASE_GRACE_MS,
    },
  );
});

test("missing, duplicate, and unparseable await timeouts use the default", () => {
  for (const command of [
    "barbaro await",
    "barbaro await --timeout-ms",
    "barbaro await --timeout-ms nope",
    "barbaro await --timeout-ms 0",
    "barbaro await --timeout-ms 1.5",
    "barbaro await --timeout-ms 1 --timeout-ms 2",
    "barbaro await && echo --timeout-ms 1",
    "barbaro await # --timeout-ms 1",
  ]) {
    assert.deepEqual(classifyAwaitCommand(command), {
      timeoutMs: DEFAULT_AWAIT_TIMEOUT_MS,
      leaseTtlMs: DEFAULT_AWAIT_TIMEOUT_MS + AWAIT_LEASE_GRACE_MS,
    });
  }
});

test("digest exclusion accepts only whole simple Barbaro read commands", () => {
  for (const command of [
    "barbaro await",
    "  barbaro await --timeout-ms 42  ",
    `'barbaro' "context" --json`,
    'barbaro context --project-root "$PWD"',
    "barbaro context # generated read",
    "barbaro turn list",
    "barbaro turn list --all-workstreams --cursor opaque",
    `'barbaro' "turn" 'show' turn_0123456789abcdef0123456789abcdef`,
    "barbaro turn show turn_0123456789abcdef0123456789abcdef --field response",
    "barbaro evidence show evidence_0123456789abcdef0123456789abcdef --provider codex --session-id session-1",
    "barbaro evidence show evidence_0123456789abcdef0123456789abcdef # generated read",
  ]) {
    assert.equal(isDigestExcludedBarbaroCommand(command), true, command);
  }

  for (const command of [
    "barbaro awaiter",
    "barbaro contextual",
    "/usr/bin/barbaro await",
    "node dist/src/cli.js await",
    "echo barbaro context",
    "barbaro && await",
    "barbaro await; echo done",
    "barbaro await && echo done",
    "barbaro await &",
    "barbaro context || true",
    "barbaro context | jq .",
    "barbaro await > /tmp/result",
    "barbaro context < /tmp/input",
    "barbaro await\npwd",
    "barbaro context $(pwd)",
    "barbaro context `pwd`",
    "barbaro context --label 'read;only'",
    `barbaro "context`,
    "barbaro await\\",
    "barbaro turn",
    "barbaro turn --help",
    "barbaro turn delete turn_0123456789abcdef0123456789abcdef",
    "barbaro turn ingest /tmp/turn.json",
    "barbaro turning list",
    "barbaro turn-list",
    "barbaro evidence",
    "barbaro evidence --help",
    "barbaro evidence delete evidence_0123456789abcdef0123456789abcdef",
    "barbaro evidential show evidence_0123456789abcdef0123456789abcdef",
    "barbaro turn list | jq .",
    "barbaro turn show turn_0123456789abcdef0123456789abcdef > /tmp/turn.json",
    "barbaro evidence show evidence_0123456789abcdef0123456789abcdef $(pwd)",
    "barbaro evidence show evidence_0123456789abcdef0123456789abcdef\npwd",
    "barbaro turn show `printf turn_0123456789abcdef0123456789abcdef`",
    "barbaro turn show turn_0123456789abcdef0123456789abcdef && echo done",
  ]) {
    assert.equal(isDigestExcludedBarbaroCommand(command), false, command);
  }
});

test("lossless readers do not become context acknowledgments", () => {
  for (const command of [
    "barbaro turn list",
    "barbaro turn show turn_0123456789abcdef0123456789abcdef",
    "barbaro evidence show evidence_0123456789abcdef0123456789abcdef",
  ]) {
    assert.equal(isDigestExcludedBarbaroCommand(command), true, command);
    assert.equal(isLeadingBarbaroContextCommand(command), false, command);
  }
});

test("hook recognition remains broader than strict digest exclusion", () => {
  for (const command of [
    "barbaro await; echo done",
    "barbaro await && echo done",
    "barbaro await\npwd",
    "barbaro await $(pwd)",
  ]) {
    assert.ok(classifyAwaitCommand(command), command);
    assert.equal(isDigestExcludedBarbaroCommand(command), false, command);
  }
});

test("context clearing recognizes a leading simple command including pipes", () => {
  for (const command of [
    "barbaro context",
    "  'barbaro' \"context\" --provider codex",
    "barbaro context | jq .",
    "barbaro context && printf done",
    "barbaro context > /tmp/context.json",
  ]) {
    assert.equal(isLeadingBarbaroContextCommand(command), true, command);
  }

  for (const command of [
    "echo barbaro context",
    "/usr/bin/barbaro context",
    "barbaro contextual",
    "barbaro && context",
    `barbaro "context`,
  ]) {
    assert.equal(isLeadingBarbaroContextCommand(command), false, command);
  }
});
