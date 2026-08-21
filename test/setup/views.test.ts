import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { stableStringify } from "../../src/core/stable-json.js";
import {
  checkCoordinationViews,
  inspectCoordinationViews,
} from "../../src/setup/index.js";

import {
  FIXTURE_NOW,
  makeDirectories,
  setMtime,
  withFixtureRoot,
  writeFakeNode,
  writeFiles,
  writeHealthyProject,
} from "./fixture.js";

const NOW_MS = FIXTURE_NOW.getTime();

function viewsFact(diagnostic: {
  facts: readonly { key: string; value: unknown }[];
}): Array<Record<string, unknown>> {
  return diagnostic.facts.find((fact) => fact.key === "views")
    ?.value as Array<Record<string, unknown>>;
}

test("present, populated, recent views pass", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    const diagnostic = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "pass");
    const views = viewsFact(diagnostic);
    assert.deepEqual(
      views.map((view) => view["view"]),
      ["active", "evidence", "feed", "state"],
    );
    assert.equal(views[0]?.["providers"] instanceof Array, true);
    assert.deepEqual(views[0]?.["providers"], ["claude"]);
  });
});

test("a missing store fails: no session has published anything", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await rm(join(root, ".barbaro"), { recursive: true, force: true });

    const diagnostic = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    assert.equal(
      diagnostic.facts.find((fact) => fact.key === "store_present")?.value,
      false,
    );
  });
});

test("a stale active view warns and is reported as stale, not current", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await setMtime(
      root,
      ".barbaro/active/claude/actor_a.json",
      new Date(NOW_MS - 20 * 60 * 1000),
    );

    const diagnostic = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "warn");
    assert.match(diagnostic.summary, /stale: active/);
    const active = viewsFact(diagnostic).find(
      (view) => view["view"] === "active",
    );
    assert.equal(active?.["fresh"], false);
    assert.equal(active?.["newest_age_seconds"], 1200);
    assert.match(diagnostic.remediation.join(" "), /no peer context at all/);
  });
});

test("an empty required view warns", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await rm(join(root, ".barbaro", "feed"), { recursive: true, force: true });
    await makeDirectories(root, [".barbaro/feed"]);

    const diagnostic = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "warn");
    assert.match(diagnostic.summary, /empty: feed/);
  });
});

test("a missing optional view warns while a missing required view fails", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await rm(join(root, ".barbaro", "evidence"), {
      recursive: true,
      force: true,
    });
    const warned = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(warned.status, "warn");

    await rm(join(root, ".barbaro", "active"), { recursive: true, force: true });
    const failed = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    assert.equal(failed.status, "fail");
  });
});

test("canonical record bytes never reach the report", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    const canary = "CANARY-6f2a1c-do-not-render";
    await writeFiles(root, {
      ".barbaro/feed/codex/ses_leak.jsonl": `{"request":{"text":"${canary}"}}\n`,
      ".barbaro/evidence/codex/ev_leak.json": `{"excerpt":"${canary}"}\n`,
      ".barbaro/active/claude/actor_leak.json": `{"intent":{"text":"${canary}"}}\n`,
    });

    const diagnostic = await checkCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    const rendered = stableStringify(diagnostic);
    assert.equal(
      rendered.includes(canary),
      false,
      "the view check must never open canonical records",
    );
    assert.equal(
      diagnostic.facts.find((fact) => fact.key === "canonical_content_read")
        ?.value,
      false,
    );
    // Session file names stay closed too; only provider directories surface.
    assert.equal(rendered.includes("ses_leak"), false);
  });
});

test("counts and byte totals are metadata-only and bounded by the scan limit", async () => {
  await withFixtureRoot(async (root) => {
    await writeFiles(root, {
      ".barbaro/active/claude/a.json": "0123456789",
      ".barbaro/active/claude/b.json": "0123456789",
      ".barbaro/feed/codex/a.jsonl": "01234",
    });

    const inspection = await inspectCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
    });
    const active = inspection.summaries.find((view) => view.view === "active");
    assert.equal(active?.fileCount, 2);
    assert.equal(active?.totalBytes, 20);
    assert.equal(active?.scanTruncated, false);

    const truncated = await inspectCoordinationViews({
      projectRoot: root,
      nowMs: NOW_MS,
      limits: { maxEntries: 1 },
    });
    assert.equal(
      truncated.summaries.find((view) => view.view === "active")?.scanTruncated,
      true,
    );
  });
});
