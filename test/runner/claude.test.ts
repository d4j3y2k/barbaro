import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import type {
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";
import { handleClaudeIngestHook } from "../../src/hooks/claude.js";
import type { BarbaroIngestAttemptJournalV2 } from "../../src/hooks/ingest-attempt.js";
import { admitHookSession } from "../../src/hooks/participation.js";
import {
  claudeRunnerStatePath,
  computeActiveMembership,
  discoverSubagentFiles,
  runClaudeTrace,
} from "../../src/runner/claude.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "claude");
const FIXTURE_WORKSPACE = "/tmp/demo-workspace";

async function joinClaudeSession(
  projectRoot: string,
  nativeSessionId: string,
  name = "lane",
  now?: Date,
) {
  return admitHookSession({
    projectRoot,
    provider: "claude",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: `/barbaro new ${name}`,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Copy a fixture scenario into a temporary project root, rewriting the baked
 * workspace path so the runner's project check and repo-path relativization
 * exercise real logic rather than a special case.
 */
async function stageScenario(
  scenario: string,
  sessionId: string,
): Promise<{ projectRoot: string; tracePath: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "barbaro-claude-"));
  const sourceRoot = join(FIXTURES, scenario, "projects", "-tmp-demo-workspace");
  const traceRoot = join(projectRoot, "traces");
  await mkdir(traceRoot, { recursive: true });

  const copy = async (relativePath: string): Promise<void> => {
    const raw = await readFile(join(sourceRoot, relativePath), "utf8");
    const rewritten = raw.split(FIXTURE_WORKSPACE).join(projectRoot);
    const target = join(traceRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewritten, "utf8");
  };

  const walk = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(sourceRoot, relativeDirectory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const next = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith(".jsonl")) await copy(next);
    }
  };
  await walk("");

  return { projectRoot, tracePath: join(traceRoot, `${sessionId}.jsonl`) };
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function rewriteTraceRows(
  tracePath: string,
  transform: (
    row: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
): Promise<void> {
  const rows = (await readFile(tracePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => transform(JSON.parse(line) as Record<string, unknown>))
    .filter((row): row is Record<string, unknown> => row !== undefined);
  await writeFile(
    tracePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

async function latestClaudeIngestAttempt(
  projectRoot: string,
  sessionId: string,
): Promise<BarbaroIngestAttemptJournalV2["attempts"][number]> {
  const journal = JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".barbaro",
        "logs",
        "ingest",
        "claude",
        `${sessionId}.json`,
      ),
      "utf8",
    ),
  ) as BarbaroIngestAttemptJournalV2;
  const attempt = journal.attempts.at(-1);
  assert.ok(attempt);
  return attempt;
}

const SUBAGENT = "33333333-3333-4333-8333-333333333333";
const FAILED_LOOP = "22222222-2222-4222-8222-222222222222";
const BACKGROUND_CONTINUATION = "99999999-9999-4999-8999-999999999999";
const PRETOOL_ATTACHMENT_FORK = "12121212-1212-4212-8212-121212121212";
const PRETOOL_TOOL_USE = "c1200000-0000-4000-8000-000000000005";
const PRETOOL_TOOL_RESULT = "c1200000-0000-4000-8000-000000000008";
const PRETOOL_HOOK_SUCCESS = "c1200000-0000-4000-8000-000000000006";
const PRETOOL_HOOK_CONTEXT = "c1200000-0000-4000-8000-000000000007";
const PRETOOL_TURN_DURATION = "c1200000-0000-4000-8000-000000000013";
const PRETOOL_VERDICT = "CHECKPOINT 1 APPROVED — replay verdict.";
const STOP_READ_RACE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const QUEUED_BACKGROUND_COMPLETION = "fefefefe-fefe-4efe-8efe-fefefefefefe";
const PRETOOL_CONTEXT_COMMAND =
  'barbaro context --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" ' +
  '--project-root "$PWD" >/dev/null 2>&1 && date -u';

test("subagent files are discovered at both nesting depths", async () => {
  const { tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const found = await discoverSubagentFiles(tracePath);

  assert.equal(found.length, 2);
  const direct = found.find((item) => item.agentId === "a1111111111111111");
  const workflow = found.find((item) => item.agentId === "a2222222222222222");
  assert.ok(direct, "direct subagent file must be discovered");
  assert.equal(direct.workflowId, undefined);
  assert.ok(workflow, "workflow-nested subagent file must be discovered");
  assert.equal(workflow.workflowId, "wf_abc1234-def");
  // journal.jsonl is workflow bookkeeping, not an agent trace.
  assert.ok(!found.some((item) => item.filePath.endsWith("journal.jsonl")));
});

test("both subagent kinds resolve a parent, by different joins", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const result = await runClaudeTrace({ tracePath, projectRoot });

  assert.equal(result.subagents.files, 2);
  assert.equal(result.subagents.published, 2);
  assert.equal(result.subagents.withheld_unresolved, 0);
  assert.equal(result.subagents.withheld_growing, 0);

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const subagentEvidence = evidence.filter((item) => item.kind === "subagent_turn");
  assert.equal(subagentEvidence.length, 2);

  const direct = subagentEvidence.find((item) => item.agent_id === "a1111111111111111");
  assert.ok(direct);
  assert.equal(direct.parent_link?.method, "joined");
  assert.equal(direct.parent_link?.native_key, "a1111111111111111");
  assert.ok(direct.parent_turn_id, "direct join resolves a concrete parent turn");

  const workflow = subagentEvidence.find((item) => item.agent_id === "a2222222222222222");
  assert.ok(workflow);
  assert.equal(workflow.parent_link?.method, "joined");
  // The workflow agent has no Agent tool call in the parent, so the edge is
  // carried by the workflow directory name instead.
  assert.equal(workflow.parent_link?.native_key, "wf_abc1234-def/a2222222222222222");
});

test("a mutating child rolls up into the parent digest before it is published", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const result = await runClaudeTrace({ tracePath, projectRoot });

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const parent = turns[0];
  assert.ok(parent);

  // The child's work reaches the parent rollup, not just the evidence file.
  assert.deepEqual(parent.subagents.changed_paths, ["src/a.ts"]);
  assert.equal(parent.subagents.total, 2);

  // Every child evidence record is named by the digest that summarizes it.
  const childIds = evidence
    .filter((item) => item.kind === "subagent_turn")
    .map((item) => item.evidence_id)
    .sort();
  assert.deepEqual([...parent.subagents.evidence_refs].sort(), childIds);
  for (const ref of childIds) assert.ok(parent.evidence_refs.includes(ref));

  // One evidence record per child turn, carrying the turn directly.
  const workflow = evidence.find((item) => item.agent_id === "a2222222222222222");
  assert.ok(workflow);
  const content = workflow.content as {
    actions: { kind: string; path?: string }[];
  };
  const topology = workflow.extensions?.claude as {
    subagent_kind?: string;
    workflow_id?: string;
  };
  assert.equal(topology.subagent_kind, "workflow_agent");
  assert.equal(topology.workflow_id, "wf_abc1234-def");
  assert.notEqual(workflow.turn_id, workflow.parent_turn_id);
  assert.ok(parent.evidence_refs.includes(workflow.evidence_id));
  assert.ok(!("child_turn_id" in workflow.content));
  assert.ok(!("turns" in workflow.content), "child turns are never nested");
  assert.ok(!("turn" in workflow.content), "child turns are never nested");
  assert.deepEqual(
    content.actions.filter((a) => a.kind === "file_change").map((a) => a.path),
    ["src/a.ts"],
  );
});

test("child evidence identity does not depend on parent resolution", async () => {
  // A child must keep the same evidence_id whether its parent resolved on
  // this run or a later one, so the same work is never published twice.
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const first = await runClaudeTrace({ tracePath, projectRoot });
  const before = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${first.session_id}.jsonl`),
  );
  const directId = before.find((i) => i.agent_id === "a1111111111111111")?.evidence_id;
  assert.ok(directId);

  // Re-run from scratch into a fresh project: identity is derived from the
  // child's own turn and artifact, so it must be unchanged.
  const again = await stageScenario("subagent-join", SUBAGENT);
  const second = await runClaudeTrace({
    tracePath: again.tracePath,
    projectRoot: again.projectRoot,
  });
  const after = await readJsonl<BarbaroEvidenceV1>(
    join(again.projectRoot, ".barbaro", "evidence", "claude", `${second.session_id}.jsonl`),
  );
  assert.equal(
    after.find((i) => i.agent_id === "a1111111111111111")?.evidence_id,
    directId,
  );
});

test("re-running appends nothing new and stays byte-identical", async () => {
  const { projectRoot, tracePath } = await stageScenario("failed-tool-loop", FAILED_LOOP);
  const first = await runClaudeTrace({ tracePath, projectRoot });
  assert.ok(first.output.turns_appended > 0);

  const feedPath = join(
    projectRoot,
    ".barbaro",
    "feed",
    "claude",
    `${first.session_id}.jsonl`,
  );
  const afterFirst = await readFile(feedPath, "utf8");

  const second = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(second.output.turns_appended, 0);
  assert.equal(second.checkpoint_status, "resume");
  assert.equal(await readFile(feedPath, "utf8"), afterFirst);
});

test("a reset run reproduces identical records", async () => {
  const { projectRoot, tracePath } = await stageScenario("failed-tool-loop", FAILED_LOOP);
  const first = await runClaudeTrace({ tracePath, projectRoot });
  const feedPath = join(
    projectRoot,
    ".barbaro",
    "feed",
    "claude",
    `${first.session_id}.jsonl`,
  );
  const before = await readFile(feedPath, "utf8");

  // Deterministic IDs plus canonical content mean a full re-parse must produce
  // byte-equivalent records, so appendUniqueJsonl skips rather than conflicts.
  const reset = await runClaudeTrace({ tracePath, projectRoot, reset: true });
  assert.equal(reset.output.turns_appended, 0);
  assert.equal(reset.output.turns_skipped, 1);
  assert.equal(await readFile(feedPath, "utf8"), before);
});

test("a trace from another project is refused", async () => {
  const { projectRoot, tracePath } = await stageScenario("failed-tool-loop", FAILED_LOOP);
  const otherRoot = await mkdtemp(join(tmpdir(), "barbaro-other-"));
  await assert.rejects(
    () => runClaudeTrace({ tracePath, projectRoot: otherRoot }),
    /does not match requested project/,
  );
  assert.ok(projectRoot.length > 0);
});

test("a subagent file cannot be ingested as a session", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const subagent = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "agent-a1111111111111111.jsonl",
  );
  await assert.rejects(
    () => runClaudeTrace({ tracePath: subagent, projectRoot }),
    /not a subagent file/,
  );
});

test("the digest never contains hidden reasoning or file bodies", async () => {
  const { projectRoot, tracePath } = await stageScenario("failed-tool-loop", FAILED_LOOP);
  const result = await runClaudeTrace({ tracePath, projectRoot });
  const feed = await readFile(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
    "utf8",
  );
  const evidence = await readFile(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
    "utf8",
  );
  for (const blob of [feed, evidence]) {
    assert.ok(!blob.includes("REDACTED-THINKING-CONTENT"));
    assert.ok(!blob.includes("REDACTED-FILE-BODY"));
    assert.ok(!blob.includes("REDACTED-SIGNATURE"));
  }
});

test("turns land in the feed and carry resolvable evidence refs", async () => {
  const { projectRoot, tracePath } = await stageScenario("failed-tool-loop", FAILED_LOOP);
  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const known = new Set(evidence.map((item) => item.evidence_id));
  assert.ok(turns.length > 0);
  for (const turn of turns) {
    for (const ref of turn.evidence_refs) {
      assert.ok(known.has(ref), `dangling evidence ref ${ref}`);
    }
  }
});

const COMPACTION = "44444444-4444-4444-8444-444444444444";

test("incremental polling produces stable sequences and no rewrites", async () => {
  // The failure this guards: checkpointing at a turn boundary while saving a
  // sequence counter that already counted the open turn. A later poll then
  // renumbers that turn, and the append store rejects the changed record.
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const full = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);

  const feedPath = join(projectRoot, ".barbaro", "feed", "claude");
  const seen: string[] = [];

  // Feed the trace one line at a time, ingesting after every append, exactly
  // as a Stop hook polling a growing file would.
  for (let count = 1; count <= full.length; count += 1) {
    await writeFile(tracePath, `${full.slice(0, count).join("\n")}\n`, "utf8");
    // final:false — the file is still growing, so a trailing turn that has
    // reached its terminal record may still absorb more records.
    await runClaudeTrace({ tracePath, projectRoot, final: false });
  }
  // One last run once the trace has stopped growing.
  await runClaudeTrace({ tracePath, projectRoot });

  const files = await readdir(feedPath);
  assert.equal(files.length, 1);
  const turns = await readJsonl<BarbaroTurnV1>(join(feedPath, files[0]!));
  for (const turn of turns) seen.push(`${turn.sequence}:${turn.turn_id}`);

  // One-shot ingest of the same complete trace must agree exactly.
  const oneShot = await stageScenario("compaction-forks", COMPACTION);
  const result = await runClaudeTrace({
    tracePath: oneShot.tracePath,
    projectRoot: oneShot.projectRoot,
  });
  const reference = await readJsonl<BarbaroTurnV1>(
    join(oneShot.projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );

  assert.deepEqual(
    seen,
    reference.map((turn) => `${turn.sequence}:${turn.turn_id}`),
    "incremental polling must converge on the one-shot result",
  );
  assert.deepEqual(turns, reference, "records must be byte-identical, not just aligned");
});

test("a torn final line is tolerated and completed on the next run", async () => {
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const full = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);

  // Truncate mid-record, as a live tail catching a partial write would see.
  const torn = `${full.slice(0, -1).join("\n")}\n${full.at(-1)!.slice(0, 40)}`;
  await writeFile(tracePath, torn, "utf8");
  const partial = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(partial.input.partial_final_line, true);
  assert.equal(partial.input.malformed_lines, 0, "a torn tail is not malformed");

  await writeFile(tracePath, `${full.join("\n")}\n`, "utf8");
  const complete = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(complete.input.partial_final_line, false);
});

test("a workflow agent without journal corroboration stays unresolved", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  // Strip the journal's attestation for this agent. A matching directory name
  // alone proves co-location, not parentage.
  const journal = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
    "journal.jsonl",
  );
  await writeFile(
    journal,
    JSON.stringify({ type: "started", key: "v2:other", agentId: "a9999999999999999" }) + "\n",
    "utf8",
  );

  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(
    result.subagents.published,
    0,
    "the resolved sibling is group-withheld with the unresolved child",
  );
  assert.equal(result.subagents.withheld_unresolved, 1);

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  // Withheld, not published with a guessed or unresolved parent: evidence no
  // digest can reach is worse than evidence that arrives one run later.
  assert.equal(
    evidence.some((item) => item.agent_id === "a2222222222222222"),
    false,
  );
  for (const turn of await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  )) {
    assert.ok(
      !turn.subagents.evidence_refs.some((ref) =>
        evidence.every((item) => item.evidence_id !== ref),
      ),
      "a rollup must never reference evidence that was withheld",
    );
  }
});

test("each physical trace gets its own logical trace id", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const result = await runClaudeTrace({ tracePath, projectRoot });

  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );

  assert.equal(turns[0]?.source_refs[0]?.trace_id, `claude:${SUBAGENT}:main`);
  const direct = evidence.find((i) => i.agent_id === "a1111111111111111");
  const workflow = evidence.find((i) => i.agent_id === "a2222222222222222");
  assert.equal(
    direct?.source_refs[0]?.trace_id,
    `claude:${SUBAGENT}:agent:a1111111111111111`,
  );
  assert.equal(
    workflow?.source_refs[0]?.trace_id,
    `claude:${SUBAGENT}:workflow:wf_abc1234-def:agent:a2222222222222222`,
  );

  // No source reference may carry an absolute machine path.
  for (const record of [...turns, ...evidence]) {
    for (const ref of record.source_refs) {
      assert.equal(ref.trace_path, undefined);
    }
  }
  const raw = JSON.stringify({ turns, evidence });
  assert.ok(!raw.includes(projectRoot), "no absolute paths anywhere in output");
});

test("full, incremental, and reset ingestion are byte-identical", async () => {
  // The three paths that must agree: a single pass over a finished trace,
  // line-by-line polling of a growing one, and a forced re-parse. The fixture
  // contains both a rewind fork and a compaction boundary.
  const feedOf = async (root: string, session: string): Promise<string> =>
    readFile(join(root, ".barbaro", "feed", "claude", `${session}.jsonl`), "utf8");
  const evidenceOf = async (root: string, session: string): Promise<string> =>
    readFile(join(root, ".barbaro", "evidence", "claude", `${session}.jsonl`), "utf8");

  const full = await stageScenario("compaction-forks", COMPACTION);
  const fullResult = await runClaudeTrace({
    tracePath: full.tracePath,
    projectRoot: full.projectRoot,
  });

  const incremental = await stageScenario("compaction-forks", COMPACTION);
  const lines = (await readFile(incremental.tracePath, "utf8"))
    .split("\n")
    .filter(Boolean);
  for (let count = 1; count <= lines.length; count += 1) {
    await writeFile(
      incremental.tracePath,
      `${lines.slice(0, count).join("\n")}\n`,
      "utf8",
    );
    await runClaudeTrace({
      tracePath: incremental.tracePath,
      projectRoot: incremental.projectRoot,
      final: false,
    });
  }
  await runClaudeTrace({
    tracePath: incremental.tracePath,
    projectRoot: incremental.projectRoot,
  });

  const reset = await stageScenario("compaction-forks", COMPACTION);
  await runClaudeTrace({ tracePath: reset.tracePath, projectRoot: reset.projectRoot });
  await runClaudeTrace({
    tracePath: reset.tracePath,
    projectRoot: reset.projectRoot,
    reset: true,
  });

  const session = fullResult.session_id;
  const reference = await feedOf(full.projectRoot, session);
  assert.equal(await feedOf(incremental.projectRoot, session), reference);
  assert.equal(await feedOf(reset.projectRoot, session), reference);

  const referenceEvidence = await evidenceOf(full.projectRoot, session);
  assert.equal(await evidenceOf(incremental.projectRoot, session), referenceEvidence);
  assert.equal(await evidenceOf(reset.projectRoot, session), referenceEvidence);

  // The rewind is represented, not erased.
  const turns = await readJsonl<BarbaroTurnV1>(
    join(full.projectRoot, ".barbaro", "feed", "claude", `${session}.jsonl`),
  );
  assert.deepEqual(turns.map((t) => t.sequence), [1, 2, 3, 4]);
  const displaced = (turns[2]?.extensions?.claude as {
    supersedes_turn_ids?: string[];
  }).supersedes_turn_ids;
  assert.deepEqual(displaced, [turns[1]?.turn_id]);
});

test("a child still running is withheld, and so is the parent that summarizes it", async () => {
  // Completion is attested from OUTSIDE the child's own file: real subagent
  // traces usually stop on a tool_use and never write end_turn. A workflow
  // agent is finished only once its journal records a `result`.
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const journal = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
    "journal.jsonl",
  );
  const complete = await readFile(journal, "utf8");
  const startedOnly = complete
    .split("\n")
    .filter((line) => line.includes('"started"'))
    .join("\n");

  // Both completion signals must be absent. The child's own end_turn would
  // prove it finished on its own, so drop that row too.
  const childPath = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
    "agent-a2222222222222222.jsonl",
  );
  const childComplete = await readFile(childPath, "utf8");
  const childRows = childComplete.split("\n").filter(Boolean);
  await writeFile(childPath, `${childRows.slice(0, -1).join("\n")}\n`, "utf8");
  await writeFile(journal, `${startedOnly}\n`, "utf8");
  const running = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(running.subagents.withheld_growing, 1);
  assert.equal(
    running.subagents.published,
    0,
    "the finished sibling is group-withheld with the running child",
  );
  assert.equal(running.subagents.blocked_parent_turns, 1);

  const midEvidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${running.session_id}.jsonl`),
  );
  assert.equal(
    midEvidence.some((item) => item.agent_id === "a2222222222222222"),
    false,
    "an in-flight child publishes nothing",
  );
  // The parent is held back too: publishing it now would freeze a rollup that
  // omits the child, and the append store could never accept the correction.
  const midTurns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${running.session_id}.jsonl`),
  ).catch(() => [] as BarbaroTurnV1[]);
  assert.equal(midTurns.length, 0);

  // Once the agent finishes and the journal records its result, both publish
  // — and the previously withheld parent appends cleanly, with no conflict.
  await writeFile(childPath, childComplete, "utf8");
  await writeFile(journal, complete, "utf8");
  const done = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(done.subagents.withheld_growing, 0);
  assert.equal(done.subagents.published, 2);
  assert.equal(done.subagents.blocked_parent_turns, 0);

  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${done.session_id}.jsonl`),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.subagents.total, 2);
});

test("a subagent that never wrote end_turn is still complete, with an honest outcome", async () => {
  // 33 of 60 real subagent files end on a tool_use. Terminality is proven by
  // the parent, but the outcome is not, so it must be `unknown` rather than
  // an invented success or a false `abandoned`.
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const childPath = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "agent-a1111111111111111.jsonl",
  );
  const lines = (await readFile(childPath, "utf8")).split("\n").filter(Boolean);
  await writeFile(childPath, `${lines.slice(0, -1).join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(result.subagents.published, 2, "the parent's tool result attests completion");

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const child = evidence.find((item) => item.agent_id === "a1111111111111111");
  assert.ok(child);
  assert.equal((child.content as { outcome: string }).outcome, "unknown");
});

const ASYNC_CHILD = "77777777-7777-4777-8777-777777777777";
const POISONED = "88888888-8888-4888-8888-888888888888";

test("async_launched is linkage only; completion needs the task notification", async () => {
  // 47 of 51 real Agent results are async_launched — written the instant the
  // child starts. Treating that as completion publishes children mid-flight.
  const { projectRoot, tracePath } = await stageScenario("async-child", ASYNC_CHILD);
  const full = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);

  // Everything except the task notification: the child is still running.
  const withoutNotification = full.filter((line) => !line.includes("task-notification"));
  await writeFile(tracePath, `${withoutNotification.join("\n")}\n`, "utf8");
  const running = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(running.subagents.published, 0, "async_launched is not completion");
  assert.equal(running.subagents.withheld_growing, 1);
  assert.equal(running.subagents.blocked_parent_turns, 1);

  // The notification arrives and names the launching tool_use id.
  await writeFile(tracePath, `${full.join("\n")}\n`, "utf8");
  const done = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(done.subagents.published, 1);
  assert.equal(done.subagents.withheld_growing, 0);

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${done.session_id}.jsonl`),
  );
  const child = evidence.find((item) => item.agent_id === "a7777777777777777");
  assert.ok(child, "the child publishes once completion is attested");
  // Its own file ended on a tool_use, so terminality is proven but the
  // outcome is not.
  assert.equal((child.content as { outcome: string }).outcome, "unknown");
});

test("an expected child with no file yet blocks its parent", async () => {
  const { projectRoot, tracePath } = await stageScenario("async-child", ASYNC_CHILD);
  const childPath = join(
    dirname(tracePath),
    ASYNC_CHILD,
    "subagents",
    "agent-a7777777777777777.jsonl",
  );
  const child = await readFile(childPath, "utf8");
  await rm(childPath);

  // The parent launched an agent whose trace has not appeared. Publishing now
  // would freeze a rollup that omits it.
  const missing = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(missing.subagents.missing_expected, 1);
  assert.equal(missing.subagents.blocked_parent_turns, 1);
  const feed = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${missing.session_id}.jsonl`),
  ).catch(() => [] as BarbaroTurnV1[]);
  assert.equal(feed.length, 0);

  await mkdir(dirname(childPath), { recursive: true });
  await writeFile(childPath, child, "utf8");
  const late = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(late.subagents.missing_expected, 0);
  assert.equal(late.subagents.published, 1);
});

test("a torn child tail blocks publication of that child and its parent", async () => {
  const { projectRoot, tracePath } = await stageScenario("async-child", ASYNC_CHILD);
  const childPath = join(
    dirname(tracePath),
    ASYNC_CHILD,
    "subagents",
    "agent-a7777777777777777.jsonl",
  );
  const complete = await readFile(childPath, "utf8");
  const rows = complete.split("\n").filter(Boolean);
  await writeFile(childPath, `${rows.slice(0, -1).join("\n")}\n${rows.at(-1)!.slice(0, 30)}`, "utf8");

  const torn = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(torn.subagents.published, 0, "a torn child is never published");
  assert.equal(torn.subagents.blocked_parent_turns, 1);

  await writeFile(childPath, complete, "utf8");
  const healed = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(healed.subagents.published, 1);
});

test("stdout that merely mentions an exit code is not read as a status", async () => {
  const { projectRoot, tracePath } = await stageScenario("poisoned-paths", POISONED);
  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const command = turns[0]?.actions.find((a) => a.kind === "command");
  assert.ok(command && command.kind === "command");

  // is_error is false, so no exit code may be copied — even though the output
  // begins with the exact words "Exit code 1".
  assert.equal(command.outcome, "unknown");
  assert.ok(!("exit_code" in command), "a successful command has no exit code");
  assert.ok(!("failure_excerpt" in command));
});

test("a traversal path is never emitted as a repo path", async () => {
  const { projectRoot, tracePath } = await stageScenario("poisoned-paths", POISONED);
  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const turn = turns[0];
  assert.ok(turn);

  for (const action of turn.actions) {
    if (action.kind !== "file_change") continue;
    assert.ok(!action.path.includes(".."), `traversal survived: ${action.path}`);
    assert.ok(!action.path.startsWith("/"), `absolute path survived: ${action.path}`);
  }
  // It resolves outside the workspace, so it becomes the constant `other`.
  const external = turn.actions.find(
    (a) => a.kind === "other" && a.summary.text === "file change outside workspace",
  );
  assert.ok(external, "the traversal edit is reported, not silently dropped");
  const raw = JSON.stringify(turns);
  assert.ok(!raw.includes("/etc/hosts"), "the escaped path must not leak");
  assert.ok(!raw.includes(".."));
});

test("source references point at the right artifact and lines", async () => {
  const { projectRoot, tracePath } = await stageScenario("async-child", ASYNC_CHILD);
  const result = await runClaudeTrace({ tracePath, projectRoot });
  const traceLines = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);

  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const turn = turns[0];
  assert.ok(turn);

  // Dereference the turn's own reference and confirm it names the records the
  // digest claims: the human prompt and the terminal response.
  const ref = turn.source_refs[0];
  assert.ok(ref);
  assert.equal(ref.trace_id, `claude:${ASYNC_CHILD}:main`);
  const first = JSON.parse(traceLines[ref.line_start! - 1]!) as { uuid: string };
  const last = JSON.parse(traceLines[ref.line_end! - 1]!) as { uuid: string };
  assert.equal(first.uuid, ref.native_record_ids?.[0]);
  assert.equal(last.uuid, ref.native_record_ids?.[1]);

  // Each action's reference resolves to a record that actually issued it.
  for (const action of turn.actions) {
    const actionRef = action.source_refs[0];
    assert.ok(actionRef);
    assert.equal(actionRef.trace_id, `claude:${ASYNC_CHILD}:main`);
    const row = JSON.parse(traceLines[actionRef.line_start! - 1]!) as {
      uuid: string;
      message?: { content?: { type: string }[] };
    };
    assert.equal(row.uuid, actionRef.native_record_ids?.[0]);
    assert.ok(
      row.message?.content?.some((block) => block.type === "tool_use"),
      "an action must reference the record that issued its tool_use",
    );
  }

  // Child evidence references the CHILD artifact, never the parent's.
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const child = evidence.find((item) => item.kind === "subagent_turn");
  assert.ok(child);
  assert.equal(
    child.source_refs[0]?.trace_id,
    `claude:${ASYNC_CHILD}:agent:a7777777777777777`,
  );
});

test("siblings completing in opposite orders converge on identical output", async () => {
  // Two children of one parent. Whichever finishes first, the published bytes
  // must be the same — otherwise a peer's view depends on scheduling luck.
  const journalPath = (trace: string) =>
    join(dirname(trace), SUBAGENT, "subagents", "workflows", "wf_abc1234-def", "journal.jsonl");
  const workflowChild = (trace: string) =>
    join(dirname(trace), SUBAGENT, "subagents", "workflows", "wf_abc1234-def", "agent-a2222222222222222.jsonl");
  const directChild = (trace: string) =>
    join(dirname(trace), SUBAGENT, "subagents", "agent-a1111111111111111.jsonl");

  const runOrder = async (workflowFirst: boolean): Promise<string> => {
    const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
    const journalComplete = await readFile(journalPath(tracePath), "utf8");
    const workflowComplete = await readFile(workflowChild(tracePath), "utf8");
    const directComplete = await readFile(directChild(tracePath), "utf8");

    // Start with neither child finished.
    await writeFile(
      journalPath(tracePath),
      `${journalComplete.split("\n").filter((l) => l.includes('"started"')).join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      workflowChild(tracePath),
      `${workflowComplete.split("\n").filter(Boolean).slice(0, -1).join("\n")}\n`,
      "utf8",
    );
    await rm(directChild(tracePath));
    await runClaudeTrace({ tracePath, projectRoot });

    const finishWorkflow = async (): Promise<void> => {
      await writeFile(workflowChild(tracePath), workflowComplete, "utf8");
      await writeFile(journalPath(tracePath), journalComplete, "utf8");
      await runClaudeTrace({ tracePath, projectRoot });
    };
    const finishDirect = async (): Promise<void> => {
      await writeFile(directChild(tracePath), directComplete, "utf8");
      await runClaudeTrace({ tracePath, projectRoot });
    };

    if (workflowFirst) {
      await finishWorkflow();
      await finishDirect();
    } else {
      await finishDirect();
      await finishWorkflow();
    }

    const session = (await runClaudeTrace({ tracePath, projectRoot })).session_id;
    const feed = await readFile(
      join(projectRoot, ".barbaro", "feed", "claude", `${session}.jsonl`),
      "utf8",
    );
    const evidence = await readFile(
      join(projectRoot, ".barbaro", "evidence", "claude", `${session}.jsonl`),
      "utf8",
    );
    return `${feed}\n---\n${evidence}`;
  };

  const workflowFirst = await runOrder(true);
  const directFirst = await runOrder(false);
  assert.equal(directFirst, workflowFirst, "completion order changed the output");

  // And both match a single one-shot ingest of the finished bundle.
  const oneShot = await stageScenario("subagent-join", SUBAGENT);
  const result = await runClaudeTrace({
    tracePath: oneShot.tracePath,
    projectRoot: oneShot.projectRoot,
  });
  const feed = await readFile(
    join(oneShot.projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
    "utf8",
  );
  const evidence = await readFile(
    join(oneShot.projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
    "utf8",
  );
  assert.equal(workflowFirst, `${feed}\n---\n${evidence}`);
});

test("every evidence record cites a row that actually supports it", async () => {
  // The oracle, not the golden. A golden records whatever the code produced;
  // this dereferences each citation against the raw trace and checks it says
  // what the evidence claims. A usage record citing the prompt row, or a
  // prior-response record naming a uuid from a different line, fails here.
  for (const [scenario, sessionId] of [
    ["failed-tool-loop", FAILED_LOOP],
    ["compaction-forks", COMPACTION],
    ["async-child", ASYNC_CHILD],
    ["sticky-suppression", STICKY],
    ["active-fork", ACTIVE_FORK],
    ["missing-origin", "11111111-1111-4111-8111-111111111111"],
    ["reverse-tool-results", "66666666-6666-4666-8666-666666666666"],
  ] as const) {
    const { projectRoot, tracePath } = await stageScenario(scenario, sessionId);
    const result = await runClaudeTrace({ tracePath, projectRoot });
    const rows = (await readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const evidence = await readJsonl<BarbaroEvidenceV1>(
      join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
    );
    const turns = await readJsonl<BarbaroTurnV1>(
      join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
    );
    const turnById = new Map(turns.map((turn) => [turn.turn_id, turn]));

    for (const item of evidence) {
      if (item.kind === "subagent_turn") continue; // cites the child artifact
      const ref = item.source_refs[0];
      assert.ok(ref, `${scenario}: evidence with no source_ref`);
      assert.equal(ref.trace_id, `claude:${sessionId}:main`);

      // Every named record id must genuinely live inside the cited span.
      const span = rows.slice(ref.line_start! - 1, ref.line_end!);
      for (const nativeId of ref.native_record_ids ?? []) {
        assert.ok(
          span.some((row) => row.uuid === nativeId),
          `${scenario}: ${item.kind} names ${nativeId}, absent from lines ${ref.line_start}-${ref.line_end}`,
        );
      }

      if (item.kind === "response") {
        // A prior response must cite an assistant row that carries text.
        const cited: {
          type?: string;
          message?: { content?: { type: string; text?: string }[] };
        } = rows[ref.line_start! - 1] ?? {};
        assert.equal(cited.type, "assistant", `${scenario}: response cites a non-assistant row`);
        const texts = (cited.message?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text);
        const claimed = (item.content as { text: { text: string } }).text.text;
        assert.ok(
          texts.some((text) => text !== undefined && claimed.includes(text)),
          `${scenario}: response text is not present at the cited row`,
        );
      }

      if (item.kind === "usage") {
        assert.ok(turnById.has(item.turn_id), `${scenario}: usage for an unpublished turn`);
        // Usage must name exactly the responses it counts. A span alone is
        // not enough: a suppressed foreign response can sit between the first
        // and last contributing rows, so the span would hold more responses
        // than the record claims.
        const named = ref.native_record_ids ?? [];
        assert.equal(
          (item.content as { api_responses: number }).api_responses,
          named.length,
          `${scenario}: usage counts responses it does not name`,
        );
        const namedGroups = new Set<string>();
        for (const nativeId of named) {
          const row = span.find((candidate) => candidate.uuid === nativeId) as
            | { type?: string; message?: { id?: string; usage?: unknown } }
            | undefined;
          assert.ok(row, `${scenario}: usage names a row outside its span`);
          assert.equal(row.type, "assistant", `${scenario}: usage names a non-assistant row`);
          assert.ok(row.message?.usage, `${scenario}: usage names a row carrying no usage`);
          assert.ok(row.message?.id, `${scenario}: usage names a row with no response id`);
          assert.ok(
            !namedGroups.has(row.message.id),
            `${scenario}: usage names the same response twice`,
          );
          namedGroups.add(row.message.id);
        }
      }
    }
  }
});

test("a workflow with no child files yet still blocks its parent", async () => {
  // Journals must be discovered from the workflows directory, not inferred
  // from the child files present. Otherwise removing the only child makes the
  // workflow look like it expected nothing, and the parent publishes an
  // incomplete rollup that can never be corrected.
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const workflowDir = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
  );
  const childPath = join(workflowDir, "agent-a2222222222222222.jsonl");
  const child = await readFile(childPath, "utf8");
  await rm(childPath);

  const missing = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(
    missing.subagents.missing_expected,
    1,
    "the journal still names an agent whose file has not appeared",
  );
  assert.equal(missing.subagents.blocked_parent_turns, 1);
  const feed = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${missing.session_id}.jsonl`),
  ).catch(() => [] as BarbaroTurnV1[]);
  assert.equal(feed.length, 0, "the parent must not publish without it");

  await writeFile(childPath, child, "utf8");
  const complete = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(complete.subagents.missing_expected, 0);
  assert.equal(complete.subagents.published, 2);
});

test("a workflow link with no directory yet blocks its parent", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  await rm(
    join(dirname(tracePath), SUBAGENT, "subagents", "workflows", "wf_abc1234-def"),
    { recursive: true },
  );

  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(result.subagents.missing_expected, 1);
  assert.equal(result.subagents.blocked_parent_turns, 1);
  const feed = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  assert.equal(feed.length, 0);
});

test("a torn workflow journal blocks every child and its parent", async () => {
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const journal = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
    "journal.jsonl",
  );
  const complete = await readFile(journal, "utf8");
  await writeFile(journal, `${complete}{"type":"started"`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(result.subagents.missing_expected, 1);
  assert.equal(result.subagents.blocked_parent_turns, 1);
  assert.ok(result.subagents.pending_agent_ids.includes("a2222222222222222"));
  const feed = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  assert.equal(feed.length, 0);
});

test("async SubagentStop ingestion waits for trace-attested completion", async () => {
  const { projectRoot, tracePath } = await stageScenario("async-child", ASYNC_CHILD);
  await joinClaudeSession(projectRoot, ASYNC_CHILD);
  const full = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
  const completionIndex = full.findIndex((line) => line.includes("task-notification"));
  assert.ok(completionIndex > 0);
  const beforeCompletion = full.slice(0, completionIndex);
  const completion = full.slice(completionIndex);
  await writeFile(tracePath, `${beforeCompletion.join("\n")}\n`, "utf8");

  const ingesting = handleClaudeIngestHook(
    {
      hook_event_name: "SubagentStop",
      session_id: ASYNC_CHILD,
      cwd: projectRoot,
      transcript_path: tracePath,
      agent_id: "a7777777777777777",
    },
    { pollIntervalMs: 10, timeoutMs: 2_000 },
  );
  await delay(40);
  await appendFile(tracePath, `${completion.join("\n")}\n`, "utf8");

  const result = await ingesting;
  assert.ok(result.ingested);
  assert.ok(
    result.ingested.subagents.ready_agent_ids.includes("a7777777777777777"),
  );
  assert.equal(result.ingested.subagents.pending_agent_ids.length, 0);
  // Attested is not canonical: the parent is the trailing turn and can still
  // absorb records, so its rollup waits for a successor or SessionEnd.
  assert.equal(result.ingested.output.turns_appended, 0);
  assert.equal(result.ingested.input.trailing_turns_withheld, 1);

  const settled = await handleClaudeIngestHook({
    hook_event_name: "SessionEnd",
    session_id: ASYNC_CHILD,
    cwd: projectRoot,
    transcript_path: tracePath,
  });
  assert.equal(settled.ingested?.output.turns_appended, 1);
  assert.equal(settled.ingested?.subagents.published, 1);

  // The regression that motivated the canonical-publication rule: a turn
  // published at Stop while its background task was outstanding, then the
  // task notification extended it, and every later ingest recomputed
  // different bytes under the same IDs. The whole sequence must now replay
  // byte-identical with zero conflicts.
  const replay = await handleClaudeIngestHook({
    hook_event_name: "SessionEnd",
    session_id: ASYNC_CHILD,
    cwd: projectRoot,
    transcript_path: tracePath,
  });
  assert.equal(replay.ingested?.output.conflicted, 0);
  assert.equal(replay.ingested?.output.turns_appended, 0);
  assert.equal(replay.ingested?.output.evidence_appended, 0);
});

test("--live is boolean and unsafe --skip-subagents is rejected", async () => {
  const { main } = await import("../../src/cli.js");
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);

  const out: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t) };

  await assert.rejects(
    main(
      ["claude", "ingest", "--trace", tracePath, "--project-root", projectRoot, "--skip-subagents"],
      io,
    ),
    /Unknown flag: --skip-subagents/,
  );
  const liveCode = await main(
    ["claude", "ingest", "--trace", tracePath, "--project-root", projectRoot, "--live", "--reset"],
    io,
  );
  assert.equal(liveCode, 0);
  const live = JSON.parse(out.join("")) as { input: { finalized: boolean } };
  assert.equal(live.input.finalized, false, "--live withheld finalization");
});

test("a notification for an earlier turn's child does not annex the current turn", async () => {
  // Linkage and completion are still recorded, but the machine span belongs to
  // neither turn: crediting it to whatever turn happens to be open would
  // attribute one request's work to another.
  const { projectRoot, tracePath } = await stageScenario("async-child", ASYNC_CHILD);
  const rows = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);

  // Insert a second human turn BEFORE the notification arrives, so the
  // notification now refers to a tool_use issued by the previous turn.
  const notificationIndex = rows.findIndex((line) => line.includes("task-notification"));
  assert.ok(notificationIndex > 0);
  const secondPrompt = JSON.stringify({
    parentUuid: "a7000000-0000-4000-8000-000000000004",
    isSidechain: false,
    userType: "external",
    cwd: "__ROOT__",
    sessionId: ASYNC_CHILD,
    version: "2.1.233",
    gitBranch: "main",
    entrypoint: "cli",
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Unrelated follow-up." }] },
    promptId: "p-7009",
    promptSource: "typed",
    origin: { kind: "human" },
    permissionMode: "default",
    uuid: "a7000000-0000-4000-8000-000000000090",
    timestamp: "2026-08-16T16:01:00.000Z",
  }).split("__ROOT__").join(projectRoot);

  const rewritten = [
    ...rows.slice(0, notificationIndex),
    secondPrompt,
    ...rows.slice(notificationIndex),
  ];
  await writeFile(tracePath, `${rewritten.join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  // The child still resolves and publishes: completion was recorded even
  // though the notification belonged to the earlier turn.
  assert.equal(result.subagents.published, 1);
  assert.equal(result.diagnostics.async_continuations, 0, "not a continuation");
  assert.equal(result.diagnostics.segmentation_barriers, 1, "it acted as a barrier");

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const child = evidence.find((item) => item.kind === "subagent_turn");
  assert.ok(child, "linkage survived even though the span was suppressed");
});

const STICKY = "99999999-9999-4999-8999-999999999999";
const ACTIVE_FORK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("suppression ends with the foreign span, not at the next human prompt", async () => {
  // Regression: a foreign SDK prompt landing mid-turn set a sticky flag that
  // stayed set, so the human turn never saw its own tool result or its
  // response and was lost entirely (turnCount 0).
  const { projectRoot, tracePath } = await stageScenario("sticky-suppression", STICKY);
  const result = await runClaudeTrace({ tracePath, projectRoot });

  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  assert.equal(turns.length, 1, "the human turn must survive the foreign span");
  const turn = turns[0];
  assert.ok(turn);
  assert.equal(turn.request.text, "Refactor the loader.");
  assert.equal(turn.response?.text, "HUMAN RESPONSE");

  // The foreign span is suppressed exactly once and never becomes a response.
  assert.equal(result.diagnostics.suppressed_spans, 1);
  const everything = JSON.stringify(turns);
  assert.ok(!everything.includes("SDK SPAN"), "the foreign answer is not credited");

  // The turn's own tool call, issued before the foreign prompt, still resolves.
  assert.equal(result.diagnostics.unpaired_tool_uses, 0);
  assert.ok(turn.actions.some((a) => a.kind === "tool" && a.tool_name === "Read"));
});

test("a notification on a superseded path cannot claim the terminal response", async () => {
  // Regression: continuation ownership checked only "same turn", so a
  // notification written on a branch the user rewound away from extended the
  // surviving turn. ABANDONED CONTINUATION took the response slot and the
  // response the user actually kept was demoted to prior-response evidence.
  const { projectRoot, tracePath } = await stageScenario("active-fork", ACTIVE_FORK);
  const result = await runClaudeTrace({ tracePath, projectRoot });

  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const turn = turns[0];
  assert.ok(turn);
  assert.equal(
    turn.response?.text,
    "ACTIVE RESPONSE",
    "last-prompt.leafUuid selects which response survived",
  );

  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const priors = evidence
    .filter((item) => item.kind === "response")
    .map((item) => (item.content as { text: { text: string } }).text.text);
  assert.ok(
    !priors.includes("ACTIVE RESPONSE"),
    "the surviving response must not be demoted to evidence",
  );

  // The off-branch span appears nowhere, and was counted as such.
  const everything = JSON.stringify({ turns, evidence });
  assert.ok(!everything.includes("ABANDONED CONTINUATION"));
  assert.equal(result.diagnostics.async_continuations, 0, "not an owned continuation");
  assert.ok(result.diagnostics.off_branch_records >= 1);

  // Completion is still recorded even though the span was discarded, so the
  // child it launched still publishes.
  assert.equal(result.subagents.published, 1);
  assert.equal(result.subagents.withheld_growing, 0, "the notification attested it");
  const child = evidence.find((item) => item.kind === "subagent_turn");
  assert.ok(child, "linkage and completion survive an off-branch notification");
});

test("active ancestry follows logicalParentUuid across a compaction boundary", async () => {
  const { computeActiveAncestry } = await import("../../src/runner/claude.js");
  const { tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const ancestry = await computeActiveAncestry(tracePath);
  assert.ok(ancestry);

  const id = (n: number) => `f6000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // The kept branch, including the boundary whose parentUuid is null.
  for (const n of [1, 2, 5, 6, 7, 8, 9]) {
    assert.ok(ancestry.has(id(n)), `expected ...${n} on the active branch`);
  }
  // The rewound branch is excluded.
  for (const n of [3, 4]) {
    assert.ok(!ancestry.has(id(n)), `...${n} was rewound away from`);
  }
});

test("a trace with no last-prompt treats every record as on-branch", async () => {
  const { computeActiveAncestry } = await import("../../src/runner/claude.js");
  const { tracePath } = await stageScenario("terminal-split", "55555555-5555-4555-8555-555555555555");
  const rows = (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes('"last-prompt"'));
  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");

  // Undefined, not an empty set: guessing a branch would silently drop
  // everything in a trace that simply never wrote the pointer.
  assert.equal(await computeActiveAncestry(tracePath), undefined);
});

test("an off-branch launch keeps its lineage even though its span is dropped", async () => {
  // Suppressing a superseded span must not orphan the child it launched:
  // linkage and completion are recorded, only the machine span is discarded.
  const { projectRoot, tracePath } = await stageScenario("active-fork", ACTIVE_FORK);
  const rows = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);

  // Move the leaf pointer back so the Agent launch itself becomes off-branch.
  const rewritten = rows.map((line) =>
    line.includes('"last-prompt"')
      ? line.replace(
          "b1000000-0000-4000-8000-000000000004",
          "b1000000-0000-4000-8000-000000000001",
        )
      : line,
  );
  await writeFile(tracePath, `${rewritten.join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.ok(result.diagnostics.off_branch_records >= 1, "the launch span was off-branch");
  assert.equal(
    result.subagents.withheld_unresolved,
    0,
    "an off-branch launch must still resolve its child's parent",
  );
  assert.equal(result.subagents.published, 1);
});

const PARALLEL_GROUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("a response group is active as a whole, keeping its parallel siblings", async () => {
  // One response, two rows: Read and Bash issued together. The results thread
  // back through the first row, so the second is not itself on the leaf path.
  // Judging rows individually drops the Bash call — measured at 58 lost
  // tool_use blocks across 46 real responses.
  const { projectRoot, tracePath } = await stageScenario("parallel-group", PARALLEL_GROUP);
  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const turn = turns[0];
  assert.ok(turn);

  const kinds = turn.actions.map((action) =>
    action.kind === "tool" ? action.tool_name : action.kind,
  );
  // Real topology: the Bash RESULT is a sibling of the Read result, so it sits
  // off the single leaf chain. Judging result rows by uuid drops it and leaves
  // the Bash call permanently unpaired — the corpus has 58 such calls, every
  // one of whose result rows is off-path.
  assert.deepEqual(kinds, ["Read", "test"], "both siblings of the response survive");
  assert.equal(
    result.diagnostics.unpaired_tool_uses,
    0,
    "an accepted call's result must close it even from off-path",
  );

  // Each result pairs with its own call, not with whichever arrived first.
  const bash = turn.actions.find((action) => action.kind === "test");
  assert.ok(bash && bash.kind === "test");
  assert.equal(bash.command.text, "npm test");
});

/** Rewrite a staged trace, returning its rows for convenience. */
async function rowsOf(tracePath: string): Promise<string[]> {
  return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
}

test("a pointer inside an unfinished response retains its complete settlement", async (t) => {
  for (const [scenario, sessionId, verdict, count] of [
    ["pointer-last-call", "12121212-1212-4212-8212-121212121212", "CHECKPOINT 1 APPROVED — replay verdict.", 1],
    ["pointer-first-result", PARALLEL_GROUP, "Config looks right and the tests pass.", 2],
  ] as const) {
    for (const variant of ["native", "first-call", "first-result", "last-result", "reversed-results", "terminal-on-first-result"] as const) {
      await t.test(`${scenario}/${variant}`, async () => {
        const { projectRoot, tracePath } = await stageScenario(scenario, sessionId);
        const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
        const results = rows.filter((r) => r.uuid?.startsWith("pointer-result-"));
        if (["first-call", "first-result", "last-result"].includes(variant)) {
          const pointer = rows.splice(rows.findIndex((r) => r.type === "last-prompt"), 1)[0];
          pointer.leafUuid = variant === "first-call" ? "pointer-call-0" : variant === "first-result" ? results[0].uuid : results.at(-1).uuid;
          rows.splice(rows.findIndex((r) => r.uuid === pointer.leafUuid) + 1, 0, pointer);
        }
        if (variant === "reversed-results") {
          const indexes = rows.flatMap((r, i) => results.includes(r) ? [i] : []);
          indexes.forEach((index, i) => { rows[index] = results[results.length - i - 1]; });
        }
        if (variant === "terminal-on-first-result") {
          const child = rows.find((r) => r.parentUuid === results.at(-1).uuid);
          assert.ok(child);
          child.parentUuid = results[0].uuid;
        }
        await writeFile(tracePath, rows.map((r) => JSON.stringify(r) + "\n").join(""));
        await joinClaudeSession(projectRoot, sessionId);
        const stopped = await handleClaudeIngestHook({
          hook_event_name: "Stop", session_id: sessionId, cwd: projectRoot, transcript_path: tracePath,
          stop_hook_active: scenario === "pointer-last-call", last_assistant_message: verdict,
        }, { trailingTimeoutMs: 100, sleep: async () => assert.fail("complete settlement needs no later event") });
        assert.equal(stopped.ingested?.input.withheld_reason, undefined);
        assert.equal(stopped.ingested?.output.turns_appended, count);
        assert.equal(stopped.ingested?.diagnostics.unpaired_tool_uses, 0);
        const feed = join(projectRoot, ".barbaro/feed/claude", `${stopped.ingested!.session_id}.jsonl`);
        const evidence = join(projectRoot, ".barbaro/evidence/claude", `${stopped.ingested!.session_id}.jsonl`);
        const before = [await readFile(feed, "utf8"), await readFile(evidence, "utf8")];
        const turns = await readJsonl<BarbaroTurnV1>(feed);
        assert.equal(turns.length, count);
        const target = turns.at(-1)!;
        if (scenario === "pointer-last-call") {
          // Nonterminal commentary belongs to evidence, not terminal response
          // composition. The two terminal verdicts retain their exact bytes.
          assert.equal(target.response?.text, `CHECKPOINT 1 APPROVED — replay verdict.\n\n${verdict}`);
          assert.deepEqual(target.actions.filter((a) => a.kind === "command" && a.command.text.startsWith("node fixture-read")).map((a) => a.kind === "command" ? a.command.text : ""), ["alpha", "beta", "gamma"].map((n) => `node fixture-read.mjs ${n}.txt`));
        } else {
          assert.equal(target.response?.text, verdict);
          assert.deepEqual(target.actions.map((a) => a.kind === "tool" ? a.tool_name : a.kind), ["Read", "test"]);
        }
        for (const [index, reset] of [false, false, true].entries()) {
          if (index === 1) await appendFile(tracePath, JSON.stringify({
            ...rows.find((r) => r.type === "last-prompt"), leafUuid: rows.at(-1).uuid,
          }) + "\n");
          const replay = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal: false, reset });
          assert.equal(replay.input.withheld_reason, undefined);
          assert.equal(replay.output.turns_appended, 0);
          assert.equal(replay.output.evidence_appended, 0);
          assert.equal(replay.output.conflicted, 0);
          assert.deepEqual([await readFile(feed, "utf8"), await readFile(evidence, "utf8")], before);
        }
      });
    }
  }
});

test("a serialized response publishes at its own Stop through validated result and attachment bridges", async (t) => {
  const session = "34343434-3434-4434-8434-343434343434";
  const verdict = "CHECKPOINT 5 APPROVED — serialized verdict.";
  for (const variant of ["last-call", "last-result", "first-result", "middle-result", "first-call", "middle-call", "direct-edge", "attachment-chain"] as const) {
    await t.test(variant, async () => {
      const { projectRoot, tracePath } = await stageScenario("serialized-response", session);
      const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
      const pointer = rows.splice(rows.findIndex((r) => r.type === "last-prompt"), 1)[0];
      const selected = { "last-call": "serial-call-2", "last-result": "serial-result-2",
        "first-result": "serial-result-0", "middle-result": "serial-result-1",
        "first-call": "serial-call-0", "middle-call": "serial-call-1",
        "direct-edge": "serial-call-2", "attachment-chain": "serial-call-2" }[variant];
      if (variant === "direct-edge") {
        rows.splice(rows.findIndex((r) => r.uuid === "serial-inline"), 1);
        rows.find((r) => r.uuid === "serial-call-2").parentUuid = "serial-result-1";
      }
      if (variant === "attachment-chain") {
        const inline = rows.find((r) => r.uuid === "serial-inline");
        rows.splice(rows.indexOf(inline) + 1, 0, { ...inline, uuid: "serial-inline-extra", parentUuid: inline.uuid });
        rows.find((r) => r.uuid === "serial-call-2").parentUuid = "serial-inline-extra";
      }
      pointer.leafUuid = selected;
      rows.splice(rows.findIndex((r) => r.uuid === selected) + 1, 0, pointer);
      await writeFile(tracePath, rows.map((r) => JSON.stringify(r) + "\n").join(""));
      await joinClaudeSession(projectRoot, session);
      const stopped = await handleClaudeIngestHook({
        hook_event_name: "Stop", session_id: session, cwd: projectRoot, transcript_path: tracePath,
        last_assistant_message: verdict,
      }, { trailingTimeoutMs: 100, sleep: async () => assert.fail("complete serialized settlement needs no later event") });
      assert.equal(stopped.ingested?.input.withheld_reason, undefined);
      assert.equal(stopped.ingested?.output.turns_appended, 1);
      assert.equal(stopped.ingested?.diagnostics.unpaired_tool_uses, 0);
      const feed = join(projectRoot, ".barbaro/feed/claude", `${stopped.ingested!.session_id}.jsonl`);
      const evidence = join(projectRoot, ".barbaro/evidence/claude", `${stopped.ingested!.session_id}.jsonl`);
      const canonical = [await readFile(feed, "utf8"), await readFile(evidence, "utf8")];
      const turns = await readJsonl<BarbaroTurnV1>(feed);
      assert.equal(turns[0]?.response?.text, verdict);
      assert.deepEqual(turns[0]?.actions.filter((a) => a.kind === "command").map((a) => a.command.text),
        ["alpha", "beta", "gamma"].map((name) => `node fixture-read.mjs ${name}.txt`));
      for (const [index, reset] of [false, false, true].entries()) {
        if (index === 1) await appendFile(tracePath, JSON.stringify({ ...pointer, leafUuid: "serial-duration" }) + "\n");
        const replay = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal: false, reset });
        assert.equal(replay.input.withheld_reason, undefined);
        assert.equal(replay.output.turns_appended, 0);
        assert.equal(replay.output.evidence_appended, 0);
        assert.equal(replay.output.conflicted, 0);
        assert.deepEqual([await readFile(feed, "utf8"), await readFile(evidence, "utf8")], canonical);
      }
    });
  }
});

test("serialized response bridges preserve disconnected and competing-evidence refusals", async (t) => {
  const session = "34343434-3434-4434-8434-343434343434";
  for (const variant of ["human-boundary", "foreign-group", "outside-call-bridge", "mixed-bridge", "malformed-bridge", "malformed-last-result",
    "wrong-source", "wrong-request", "duplicate-call", "duplicate-result", "missing-result",
    "disconnected-before", "disconnected-after", "rewind", "cycle", "duplicate-uuid"] as const) {
    await t.test(variant, async () => {
      const { projectRoot, tracePath } = await stageScenario("serialized-response", session);
      const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
      const first = rows.find((r) => r.uuid === "serial-call-0");
      const middle = rows.find((r) => r.uuid === "serial-call-1");
      const result = rows.find((r) => r.uuid === "serial-result-0");
      if (variant === "human-boundary" || variant === "foreign-group") {
        const boundary = variant === "human-boundary"
          ? { ...rows[0], uuid: "serial-boundary", parentUuid: result.uuid }
          : { ...middle, uuid: "serial-boundary", parentUuid: result.uuid,
              message: { ...middle.message, id: "foreign-group", content: [{ type: "text", text: "Another response." }] } };
        rows.splice(rows.indexOf(middle), 0, boundary);
        middle.parentUuid = boundary.uuid;
      }
      if (variant === "outside-call-bridge") {
        rows.splice(1, 0, { ...first, uuid: "disconnected-call", parentUuid: "unknown-root",
          message: { ...first.message, content: [{ ...first.message.content[0], id: "outside-call" }] } });
        result.message.content.push({ type: "tool_result", tool_use_id: "outside-call", content: "foreign result" });
        delete result.sourceToolAssistantUUID;
      }
      if (variant === "mixed-bridge") result.message.content.push({ type: "text", text: "A new human instruction." });
      if (variant === "malformed-bridge") result.message.content.push(null);
      if (variant === "malformed-last-result") rows.find((r) => r.uuid === "serial-result-2").message.content.push(null);
      if (variant === "wrong-source") result.sourceToolAssistantUUID = middle.uuid;
      if (variant === "wrong-request") middle.requestId = "foreign-request";
      if (variant === "duplicate-call") middle.message.content.push(first.message.content[0]);
      if (variant === "duplicate-result") rows.push({ ...result, uuid: "competing-result" });
      if (variant === "missing-result") {
        rows.splice(rows.findIndex((r) => r.uuid === "serial-result-1"), 1);
        rows.find((r) => r.uuid === "serial-inline").parentUuid = middle.uuid;
      }
      if (variant === "disconnected-before" || variant === "disconnected-after") {
        const copy = { ...rows.find((r) => r.uuid === "serial-intro-1"), uuid: "disconnected-text", parentUuid: "unknown-root" };
        rows.splice(variant === "disconnected-before" ? rows.findIndex((r) => r.type === "last-prompt") : rows.length, 0, copy);
      }
      if (variant === "rewind") result.parentUuid = "serial-prompt";
      if (variant === "cycle") rows.find((r) => r.uuid === "serial-inline").parentUuid = "serial-call-2";
      if (variant === "duplicate-uuid") rows.push({ ...result });
      await writeFile(tracePath, rows.map((r) => JSON.stringify(r) + "\n").join(""));
      for (const sourceFinal of [false, true]) {
        const refused = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal });
        assert.ok(refused.input.withheld_reason);
        if (variant === "missing-result") assert.equal(refused.input.withheld_reason, "unsettled_tool_results");
        assert.equal(refused.output.turns_appended, 0);
        assert.equal(refused.output.evidence_appended, 0);
      }
    });
  }
});

test("anchored response settlement refuses missing, competing and disconnected evidence", async (t) => {
  for (const variant of ["missing-result", "duplicate-result", "duplicate-call", "wrong-source", "foreign-result", "wrong-request", "disconnected-call", "human-boundary", "foreign-group-boundary", "rewind", "pre-pointer-rewind", "single-wrong-source", "competing-answer", "cycle", "duplicate-uuid"] as const) {
    await t.test(variant, async () => {
      const { projectRoot, tracePath } = await stageScenario("pointer-first-result", PARALLEL_GROUP);
      const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
      const call = rows.find((r) => r.uuid === "pointer-call-1")!;
      const result = rows.find((r) => r.uuid === "pointer-result-1")!;
      const answer = rows.find((r) => r.parentUuid === result.uuid)!;
      if (variant === "missing-result") { rows.splice(rows.indexOf(result), 1); answer.parentUuid = "pointer-result-0"; }
      if (variant === "duplicate-result") rows.push({ ...result, uuid: "duplicate-result" });
      if (variant === "duplicate-call") call.message.content.push(rows.find((r) => r.uuid === "pointer-call-0").message.content[0]);
      if (variant === "wrong-source") result.sourceToolAssistantUUID = "pointer-call-0";
      if (variant === "foreign-result") result.message.content[0].tool_use_id = "unknown-call";
      if (variant === "wrong-request") call.requestId = "another-request";
      if (variant === "disconnected-call") call.parentUuid = "unknown-root";
      if (variant === "rewind") result.parentUuid = rows[0].uuid;
      if (variant === "pre-pointer-rewind") {
        result.parentUuid = rows[0].uuid;
        rows.splice(rows.indexOf(result), 1);
        rows.splice(rows.findIndex((r) => r.type === "last-prompt"), 0, result);
      }
      if (variant === "single-wrong-source") {
        rows.splice(rows.indexOf(call), 1);
        rows.splice(rows.indexOf(result), 1);
        rows.find((r) => r.uuid === "pointer-result-0").sourceToolAssistantUUID = "wrong-call";
        answer.parentUuid = "pointer-result-0";
      }
      if (variant === "competing-answer") rows.push({ ...answer, uuid: "competing-answer", parentUuid: "pointer-result-0", message: { ...answer.message, id: "competing-group" } });
      if (variant === "cycle") call.parentUuid = result.uuid;
      if (variant === "duplicate-uuid") rows.push(result);
      if (variant === "human-boundary" || variant === "foreign-group-boundary") {
        const bridge = variant === "human-boundary" ? { ...rows[3], uuid: "bridge", parentUuid: "pointer-call-0" } : { ...call, uuid: "bridge", parentUuid: "pointer-call-0", message: { ...call.message, id: "foreign-group", content: [{ type: "text", text: "A different response." }] } };
        call.parentUuid = bridge.uuid;
        rows.splice(rows.indexOf(call), 0, bridge);
      }
      const membership = computeActiveMembership(rows.map((value, index) => ({ value, lineNumber: index + 1 })));
      if (variant === "disconnected-call") assert.equal(membership.ancestry?.has(call.uuid), false);
      await writeFile(tracePath, rows.map((r) => JSON.stringify(r) + "\n").join(""));
      for (const sourceFinal of [false, true]) {
        const result = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal });
        assert.ok(result.input.withheld_reason);
        if (variant === "missing-result") assert.equal(result.input.withheld_reason, "unsettled_tool_results");
        assert.equal(result.output.turns_appended, 0);
        assert.equal(result.output.evidence_appended, 0);
      }
    });
  }
});

test("a stale pointer publishes an attested parallel group at its own Stop and replays identical bytes", async (t) => {
  for (const variant of ["sibling-results", "sibling-calls", "inline-attachment", "mixed-first-result-parent", "mixed-last-result-parent", "mixed-reversed-results", "mixed-attachment-chains", "mixed-pointer-in-attachments"] as const) {
    await t.test(variant, async () => {
      const { projectRoot, tracePath } = await stageScenario("stale-parallel-group", PARALLEL_GROUP);
      const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
      if (variant === "sibling-calls") rows[6].parentUuid = rows[4].uuid;
      if (variant === "inline-attachment") {
        const result = rows[8];
        const attachment = { ...result, type: "attachment", uuid: "d1000000-0000-4000-8000-000000000008", attachment: { type: "hook_additional_context", content: "sanitized hook context" } };
        delete attachment.message;
        result.parentUuid = attachment.uuid;
        rows.splice(8, 0, attachment);
      }
      if (variant.startsWith("mixed-")) {
        // Real 2.1.261 topology: chained calls, each result parented to its own
        // call. The first call's children mix an assistant and a user result.
        rows[7].parentUuid = rows[5].uuid;
        rows[9].parentUuid = rows[variant === "mixed-first-result-parent" ? 7 : 8].uuid;
        if (variant === "mixed-reversed-results") [rows[7], rows[8]] = [rows[8], rows[7]];
        if (variant === "mixed-attachment-chains" || variant === "mixed-pointer-in-attachments") {
          const result = rows[8];
          const chain = Array.from({ length: 3 }, (_, index) => ({
            type: "attachment", uuid: `mixed-inline-${index}`, parentUuid: index === 0 ? result.uuid : `mixed-inline-${index - 1}`,
            attachment: { type: "hook_additional_context", content: "sanitized result attachment" },
          }));
          rows[9].parentUuid = chain[2]!.uuid;
          rows.splice(9, 0, ...chain);
          // An attachment-only sibling must not invent a branch choice.
          rows.splice(8, 0, { type: "attachment", uuid: "mixed-sidecar", parentUuid: rows[7].uuid, attachment: { type: "hook_additional_context", content: "sanitized sidecar" } });
          if (variant === "mixed-pointer-in-attachments") {
            const index = rows.findIndex((row) => row.uuid === "mixed-inline-1");
            rows.splice(index + 1, 0, { ...rows[3], leafUuid: "mixed-inline-1" });
          }
        }
      }
      await writeFile(tracePath, rows.map((row) => JSON.stringify(row) + "\n").join(""));
      await joinClaudeSession(projectRoot, PARALLEL_GROUP);
      const stopped = await handleClaudeIngestHook({
        hook_event_name: "Stop", session_id: PARALLEL_GROUP, cwd: projectRoot, transcript_path: tracePath,
        last_assistant_message: "Config looks right and the tests pass.",
      }, { trailingTimeoutMs: 100, sleep: async () => assert.fail("the closed group needs no extra provider event") });
      assert.equal(stopped.ignored, undefined);
      assert.equal(stopped.ingested?.input.withheld_reason, undefined);
      assert.equal(stopped.ingested?.output.turns_appended, 2);
      assert.equal(stopped.ingested?.diagnostics.unpaired_tool_uses, 0);
      assert.equal(stopped.ingested?.output.conflicted, 0);
      const feed = join(projectRoot, ".barbaro", "feed", "claude", `${stopped.ingested!.session_id}.jsonl`);
      const evidence = join(projectRoot, ".barbaro", "evidence", "claude", `${stopped.ingested!.session_id}.jsonl`);
      const before = [await readFile(feed, "utf8"), await readFile(evidence, "utf8")];
      const turns = await readJsonl<BarbaroTurnV1>(feed);
      assert.deepEqual(turns[1]!.actions.map((action) => action.kind === "tool" ? action.tool_name : action.kind), ["Read", "test"]);
      await appendFile(tracePath, JSON.stringify({ ...rows[3], leafUuid: rows.at(-1).uuid }) + "\n");
      for (const reset of [false, true]) {
        const replay = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal: false, reset });
        assert.equal(replay.input.withheld_reason, undefined);
        assert.equal(replay.output.turns_appended, 0);
        assert.equal(replay.output.evidence_appended, 0);
        assert.equal(replay.output.conflicted, 0);
        assert.deepEqual([await readFile(feed, "utf8"), await readFile(evidence, "utf8")], before);
      }
    });
  }
});

test("mixed call/result continuation retains competing-branch and pairing refusals", async (t) => {
  for (const variant of ["duplicate-result", "duplicate-call", "foreign-result", "wrong-source", "different-call-group", "different-request", "competing-answer", "competing-text-groups", "duplicate-uuid", "human-between-calls", "rewind", "cycle", "missing-result"] as const) {
    await t.test(variant, async () => {
      const { projectRoot, tracePath } = await stageScenario("stale-parallel-group", PARALLEL_GROUP);
      const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
      rows[7].parentUuid = rows[5].uuid;
      rows[9].parentUuid = rows[8].uuid;
      if (variant === "duplicate-result") rows.push({ ...rows[8], uuid: "mixed-duplicate-result" });
      if (variant === "duplicate-call") rows[6].message.content.push(rows[5].message.content[0]);
      if (variant === "foreign-result") rows[7].message.content[0].tool_use_id = "unknown-call";
      if (variant === "wrong-source") rows[7].sourceToolAssistantUUID = rows[6].uuid;
      if (variant === "different-call-group") rows[6].message.id = "competing-call-response";
      if (variant === "different-request") rows[6].requestId = "competing-request";
      if (variant === "competing-answer") rows.push({ ...rows[9], uuid: "mixed-competing-answer", parentUuid: rows[7].uuid, message: { ...rows[9].message, id: "competing-response" } });
      if (variant === "duplicate-uuid") rows.push(rows[7]);
      if (variant === "human-between-calls") {
        const prompt = { ...rows[4], uuid: "mixed-new-human", parentUuid: rows[5].uuid };
        rows[6].parentUuid = prompt.uuid;
        rows.splice(6, 0, prompt);
      }
      if (variant === "rewind") rows[8].parentUuid = rows[0].uuid;
      if (variant === "cycle") rows[6].parentUuid = rows[8].uuid;
      if (variant === "missing-result") {
        rows[9].parentUuid = rows[7].uuid;
        rows.splice(8, 1);
      }
      if (variant === "competing-text-groups") {
        rows[5].message = { ...rows[5].message, content: [{ type: "text", text: "First response part." }], stop_reason: "end_turn" };
        rows[6].message = { ...rows[6].message, content: [{ type: "text", text: "Second response part." }], stop_reason: "end_turn" };
        rows[9].parentUuid = rows[5].uuid;
        rows.splice(7, 2);
      }
      await writeFile(tracePath, rows.map((row) => JSON.stringify(row) + "\n").join(""));
      for (const sourceFinal of [false, true]) {
        const result = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal });
        assert.equal(result.input.withheld_reason, "ambiguous_pointer_continuation");
        assert.equal(result.output.turns_appended, 0);
        assert.equal(result.output.evidence_appended, 0);
      }
    });
  }
});

test("a stale parallel-looking fork still refuses competing groups and ambiguous call/result evidence", async (t) => {
  for (const variant of ["duplicate-result", "duplicate-call", "foreign-result", "wrong-source", "different-call-group", "different-request", "competing-answer", "duplicate-uuid"] as const) {
    await t.test(variant, async () => {
      const { projectRoot, tracePath } = await stageScenario("stale-parallel-group", PARALLEL_GROUP);
      const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
      if (variant === "duplicate-result") rows.push({ ...rows[8], uuid: "d1000000-0000-4000-8000-000000000008" });
      if (variant === "duplicate-call") rows[6].message.content.push(rows[5].message.content[0]);
      if (variant === "foreign-result") rows[8].message.content[0].tool_use_id = "unknown-call";
      if (variant === "wrong-source") rows[8].sourceToolAssistantUUID = rows[5].uuid;
      if (variant === "different-call-group") rows[6].message.id = "another-response";
      if (variant === "different-request") {
        rows[6].parentUuid = rows[4].uuid;
        rows[6].requestId = "another-request";
      }
      if (variant === "competing-answer") rows.push({ ...rows[9], uuid: "d1000000-0000-4000-8000-000000000009", parentUuid: rows[8].uuid, message: { ...rows[9].message, id: "competing-response" } });
      if (variant === "duplicate-uuid") rows.push(rows[8]);
      await writeFile(tracePath, rows.map((row) => JSON.stringify(row) + "\n").join(""));
      for (const sourceFinal of [false, true]) {
        const result = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal });
        assert.equal(result.input.withheld_reason, "ambiguous_pointer_continuation");
        assert.equal(result.output.turns_appended, 0);
        assert.equal(result.output.evidence_appended, 0);
      }
    });
  }
});

const STALE_POINTER_LEAF = "b2000000-0000-4000-8000-000000000003";
const STALE_POINTER_TAIL = "b2000000-0000-4000-8000-000000000011";
const STALE_POINTER_NEXT_PROMPT = "b2000000-0000-4000-8000-000000000012";

/**
 * Put a sanitized completed turn after the last-prompt row, matching Claude's
 * live write order when that in-place pointer trails the timeline.
 */
async function stageStalePointerContinuation(): Promise<{
  projectRoot: string;
  tracePath: string;
  rows: string[];
}> {
  const staged = await stageScenario("failed-tool-loop", FAILED_LOOP);
  const original = await rowsOf(staged.tracePath);
  const records = original.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const pointerIndex = records.findIndex(
    (record) => record.type === "last-prompt",
  );
  const progressIndex = records.findIndex(
    (record) => record.uuid === STALE_POINTER_LEAF,
  );
  assert.ok(pointerIndex > progressIndex && progressIndex >= 0);

  const timeline = original.filter((_, index) => index !== pointerIndex);
  const pointerRecord = records[pointerIndex]!;
  pointerRecord.leafUuid = STALE_POINTER_LEAF;
  const pointer = JSON.stringify(pointerRecord);
  const tailIndex = timeline.findIndex(
    (line) =>
      (JSON.parse(line) as Record<string, unknown>).uuid === STALE_POINTER_TAIL,
  );
  assert.ok(tailIndex > progressIndex);
  const compactBoundary = JSON.parse(timeline[tailIndex]!) as Record<
    string,
    unknown
  >;
  compactBoundary.parentUuid = null;
  compactBoundary.logicalParentUuid =
    "b2000000-0000-4000-8000-000000000010";
  compactBoundary.subtype = "compact_boundary";
  compactBoundary.compactMetadata = {
    trigger: "auto",
    preTokens: 100,
    postTokens: 40,
    cumulativeDroppedTokens: 60,
  };
  timeline[tailIndex] = JSON.stringify(compactBoundary);

  const rows = [
    ...timeline.slice(0, progressIndex + 1),
    pointer,
    ...timeline.slice(progressIndex + 1),
  ];
  await writeFile(staged.tracePath, `${rows.join("\n")}\n`, "utf8");
  return { ...staged, rows };
}

function nextHumanPrompt(uuid: string, parentUuid: string, cwd: string): string {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId: FAILED_LOOP,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "Review the completed fix." }],
    },
    promptId: `prompt-${uuid}`,
    promptSource: "typed",
    origin: { kind: "human" },
    uuid,
    timestamp: "2026-08-16T12:01:00.000Z",
  });
}

test("a stale pointer follows one post-pointer continuation through compaction", async () => {
  const { projectRoot, tracePath, rows } =
    await stageStalePointerContinuation();
  await joinClaudeSession(projectRoot, FAILED_LOOP);

  // Stop sees the completed tail and checkpoints it, but correctly withholds
  // the trace-terminal turn because the source is still live.
  const stopped = await handleClaudeIngestHook({
    hook_event_name: "Stop",
    session_id: FAILED_LOOP,
    cwd: projectRoot,
    transcript_path: tracePath,
  });
  assert.equal(stopped.ingested?.output.turns_appended, 0);
  assert.equal(stopped.ingested?.input.trailing_turns_withheld, 1);

  const prompt = nextHumanPrompt(
    STALE_POINTER_NEXT_PROMPT,
    STALE_POINTER_TAIL,
    projectRoot,
  );
  await writeFile(tracePath, `${[...rows, prompt].join("\n")}\n`, "utf8");

  // The prompt closes the preceding turn. The stale pointer must not truncate
  // that turn at its early progress text, and logicalParentUuid must keep the
  // compact boundary connected to the unique continuation.
  const caughtUpHook = await handleClaudeIngestHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: FAILED_LOOP,
      cwd: projectRoot,
      transcript_path: tracePath,
      prompt: "Review the completed fix.",
    },
    { pollIntervalMs: 1, userPromptTimeoutMs: 100 },
  );
  const caughtUp = caughtUpHook.ingested;
  assert.ok(caughtUp);
  assert.equal(caughtUp.input.withheld_reason, undefined);
  assert.equal(caughtUp.output.turns_appended, 1);
  assert.equal(caughtUp.diagnostics.compact_boundaries, 1);
  const { computeActiveAncestry } = await import("../../src/runner/claude.js");
  const ancestry = await computeActiveAncestry(tracePath);
  assert.ok(ancestry?.has(STALE_POINTER_LEAF));
  assert.ok(ancestry?.has(STALE_POINTER_TAIL));
  assert.ok(ancestry?.has(STALE_POINTER_NEXT_PROMPT));
  const feedPath = join(
    projectRoot,
    ".barbaro",
    "feed",
    "claude",
    `${caughtUp.session_id}.jsonl`,
  );
  const turns = await readJsonl<BarbaroTurnV1>(feedPath);
  assert.equal(
    turns[0]?.response?.text,
    "Fixed the off-by-one in src/sum.ts; the suite reports 13 passed. " +
      "The build clean was denied and the watcher was interrupted.",
  );
  assert.equal(turns[0]?.actions.length, 6);
  assert.equal(turns[0]?.outcome, "partial");
  assert.equal(turns[0]?.ended_at, "2026-08-16T11:02:30.000Z");
  const published = await readFile(feedPath, "utf8");

  // Once Claude advances the pointer to the new prompt, replay must derive
  // the identical completed turn rather than minting an ID conflict.
  const advanced = [...rows, prompt].map((line) =>
    line.includes('"type":"last-prompt"')
      ? line.replace(STALE_POINTER_LEAF, STALE_POINTER_NEXT_PROMPT)
      : line,
  );
  await writeFile(tracePath, `${advanced.join("\n")}\n`, "utf8");
  const settled = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(settled.output.conflicted, 0);
  assert.equal(settled.output.turns_appended, 0);
  assert.equal(await readFile(feedPath, "utf8"), published);
});

test("source-final ingest publishes a complete unique stale-pointer turn", async () => {
  const { projectRoot, tracePath } = await stageStalePointerContinuation();
  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(result.input.withheld_reason, undefined);
  assert.equal(result.output.turns_appended, 1);
  assert.equal(result.diagnostics.compact_boundaries, 1);

  const turns = await readJsonl<BarbaroTurnV1>(
    join(
      projectRoot,
      ".barbaro",
      "feed",
      "claude",
      `${result.session_id}.jsonl`,
    ),
  );
  assert.equal(
    turns[0]?.response?.text,
    "Fixed the off-by-one in src/sum.ts; the suite reports 13 passed. " +
      "The build clean was denied and the watcher was interrupted.",
  );
  assert.equal(turns[0]?.actions.length, 6);
  assert.equal(turns[0]?.outcome, "partial");
  assert.equal(turns[0]?.ended_at, "2026-08-16T11:02:30.000Z");
});

test("an intentional pre-pointer rewind keeps old descendants excluded", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "failed-tool-loop",
    FAILED_LOOP,
  );
  const original = await rowsOf(tracePath);
  const pointerIndex = original.findIndex(
    (line) =>
      (JSON.parse(line) as Record<string, unknown>).type === "last-prompt",
  );
  assert.ok(pointerIndex > 0);
  const pointer = JSON.parse(original[pointerIndex]!) as Record<string, unknown>;
  pointer.leafUuid = STALE_POINTER_LEAF;
  const rewoundRows = [...original];
  rewoundRows[pointerIndex] = JSON.stringify(pointer);
  const prompt = nextHumanPrompt(
    STALE_POINTER_NEXT_PROMPT,
    STALE_POINTER_LEAF,
    projectRoot,
  );
  await writeFile(
    tracePath,
    `${[...rewoundRows, prompt].join("\n")}\n`,
    "utf8",
  );

  const { computeActiveAncestry } = await import("../../src/runner/claude.js");
  const ancestry = await computeActiveAncestry(tracePath);
  assert.ok(ancestry?.has(STALE_POINTER_LEAF));
  assert.ok(ancestry?.has(STALE_POINTER_NEXT_PROMPT));
  assert.ok(!ancestry?.has("b2000000-0000-4000-8000-000000000010"));
  assert.ok(!ancestry?.has(STALE_POINTER_TAIL));

  const first = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(first.input.withheld_reason, undefined);
  assert.equal(first.output.turns_appended, 1);
  const feedPath = join(
    projectRoot,
    ".barbaro",
    "feed",
    "claude",
    `${first.session_id}.jsonl`,
  );
  const turns = await readJsonl<BarbaroTurnV1>(feedPath);
  assert.equal(turns[0]?.response?.text, "Running the suite first to see the failures.");
  assert.ok(
    !JSON.stringify(turns).includes("Fixed the off-by-one"),
    "the response written before the authoritative rewind stays abandoned",
  );
  const published = await readFile(feedPath, "utf8");

  const advanced = [...rewoundRows, prompt];
  const advancedPointer = JSON.parse(advanced[pointerIndex]!) as Record<
    string,
    unknown
  >;
  advancedPointer.leafUuid = STALE_POINTER_NEXT_PROMPT;
  advanced[pointerIndex] = JSON.stringify(advancedPointer);
  await writeFile(tracePath, `${advanced.join("\n")}\n`, "utf8");
  const settled = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(settled.output.conflicted, 0);
  assert.equal(settled.output.turns_appended, 0);
  assert.equal(await readFile(feedPath, "utf8"), published);
});

test("a stale pointer with competing post-pointer continuations publishes nothing", async () => {
  const { projectRoot, tracePath, rows } =
    await stageStalePointerContinuation();
  const checkpointed = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(checkpointed.output.turns_appended, 0);
  const barbaroDirectory = join(projectRoot, ".barbaro");
  const statePath = claudeRunnerStatePath(tracePath, barbaroDirectory);
  const feedPath = join(
    barbaroDirectory,
    "feed",
    "claude",
    `${checkpointed.session_id}.jsonl`,
  );
  const evidencePath = join(
    barbaroDirectory,
    "evidence",
    "claude",
    `${checkpointed.session_id}.jsonl`,
  );
  const stateBefore = await readFile(statePath, "utf8");
  const feedBefore = await readFile(feedPath, "utf8").catch(() => "");
  const evidenceBefore = await readFile(evidencePath, "utf8").catch(() => "");
  const first = nextHumanPrompt(
    STALE_POINTER_NEXT_PROMPT,
    STALE_POINTER_TAIL,
    projectRoot,
  );
  const second = nextHumanPrompt(
    "b2000000-0000-4000-8000-000000000013",
    STALE_POINTER_TAIL,
    projectRoot,
  );
  await writeFile(
    tracePath,
    `${[...rows, first, second].join("\n")}\n`,
    "utf8",
  );

  const live = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(live.input.withheld_reason, "ambiguous_pointer_continuation");
  assert.equal(live.output.turns_appended, 0);
  assert.equal(live.output.evidence_appended, 0);

  // SessionEnd does not magically identify which child survived. A final
  // ingest is just as conservative and cannot publish a truncated prefix.
  const sourceFinal = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(
    sourceFinal.input.withheld_reason,
    "ambiguous_pointer_continuation",
  );
  assert.equal(sourceFinal.output.turns_appended, 0);
  assert.equal(sourceFinal.output.evidence_appended, 0);
  assert.equal(await readFile(statePath, "utf8"), stateBefore);
  assert.equal(await readFile(feedPath, "utf8").catch(() => ""), feedBefore);
  assert.equal(
    await readFile(evidencePath, "utf8").catch(() => ""),
    evidenceBefore,
  );
});

test("a post-pointer rewind from an earlier ancestor is withheld", async () => {
  const { projectRoot, tracePath, rows } =
    await stageStalePointerContinuation();
  const rewound = nextHumanPrompt(
    STALE_POINTER_NEXT_PROMPT,
    "b2000000-0000-4000-8000-000000000002",
    projectRoot,
  );
  await writeFile(tracePath, `${[...rows, rewound].join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(
    result.input.withheld_reason,
    "ambiguous_pointer_continuation",
  );
  assert.equal(result.output.turns_appended, 0);
  assert.equal(result.output.evidence_appended, 0);
});

test("an attachment-only PreToolUse fork publishes at its own Stop", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "pretool-attachment-fork",
    PRETOOL_ATTACHMENT_FORK,
  );
  await joinClaudeSession(projectRoot, PRETOOL_ATTACHMENT_FORK);

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: PRETOOL_ATTACHMENT_FORK,
      cwd: projectRoot,
      transcript_path: tracePath,
    },
    { pollIntervalMs: 1, trailingTimeoutMs: 100 },
  );
  const ingested = stopped.ingested;
  assert.ok(ingested);
  assert.equal(ingested.input.withheld_reason, undefined);
  assert.equal(ingested.output.turns_appended, 1);
  assert.equal(ingested.input.trailing_turn_open, false);
  assert.equal(ingested.input.trailing_turns_withheld, 0);

  const { computeActiveAncestry } = await import("../../src/runner/claude.js");
  const ancestry = await computeActiveAncestry(tracePath);
  assert.ok(ancestry?.has(PRETOOL_TOOL_USE));
  assert.ok(ancestry?.has(PRETOOL_TOOL_RESULT));
  assert.ok(ancestry?.has(PRETOOL_TURN_DURATION));
  assert.ok(!ancestry?.has(PRETOOL_HOOK_SUCCESS));
  assert.ok(!ancestry?.has(PRETOOL_HOOK_CONTEXT));

  const turns = await readJsonl<BarbaroTurnV1>(
    join(
      projectRoot,
      ".barbaro",
      "feed",
      "claude",
      `${ingested.session_id}.jsonl`,
    ),
  );
  assert.equal(turns.length, 1, "the Stop-blocked continuation stays one turn");
  const turn = turns[0]!;
  assert.deepEqual(turn.response?.text.split("\n\n"), [
    PRETOOL_VERDICT,
    PRETOOL_VERDICT,
  ]);
  assert.equal(turn.response?.text.split("\n\n").at(-1), PRETOOL_VERDICT);
  const contextRead = turn.actions.find(
    (action) =>
      action.kind === "command" && action.command.text === PRETOOL_CONTEXT_COMMAND,
  );
  assert.ok(contextRead && contextRead.kind === "command");
});

test("a reentrant Stop waits for its suppressed hook-feedback response", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "pretool-attachment-fork",
    PRETOOL_ATTACHMENT_FORK,
  );
  const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
  // Through the blocking Stop feedback prompt, but before its resent response.
  await writeFile(tracePath, `${rows.slice(0, 14).join("\n")}\n`, "utf8");
  await joinClaudeSession(projectRoot, PRETOOL_ATTACHMENT_FORK);
  let clock = 0;
  let appended = false;

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: PRETOOL_ATTACHMENT_FORK,
      cwd: projectRoot,
      transcript_path: tracePath,
      stop_hook_active: true,
      // Deliberately identical to the prior response at row 11. The feedback
      // prompt at row 12 must clear that stale candidate.
      last_assistant_message: PRETOOL_VERDICT,
    },
    {
      now: () => clock,
      pollIntervalMs: 50,
      timeoutMs: 500,
      trailingTimeoutMs: 500,
      sleep: async (milliseconds) => {
        clock += milliseconds;
        if (!appended) {
          await assert.rejects(
            stat(
              claudeRunnerStatePath(
                tracePath,
                join(projectRoot, ".barbaro"),
              ),
            ),
            { code: "ENOENT" },
          );
          appended = true;
          await appendFile(tracePath, `${rows.slice(14).join("\n")}\n`, "utf8");
        }
      },
    },
  );

  assert.equal(clock, 50, "the identical prior verdict cannot attest reentry");
  assert.equal(stopped.ignored, undefined);
  assert.equal(stopped.ingested?.input.stop_turn_visible, true);
  assert.equal(
    stopped.ingested?.input.latest_terminal_response_message_id,
    "msg_probe_4",
  );
});

test("a blocked Stop followed by mixed parallel reads publishes at its reentrant Stop", async () => {
  const { projectRoot, tracePath } = await stageScenario("pretool-attachment-fork", PRETOOL_ATTACHMENT_FORK);
  const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
  // The fixture already contains the meta feedback user row, attachment and
  // Stop summary between the original verdict and its automatic continuation.
  const call = rows[14];
  const result = rows[15];
  const secondCall = {
    ...call, uuid: "reentry-second-call", parentUuid: call.uuid,
    message: { ...call.message, content: [{ ...call.message.content[0], id: "toolu_context_second" }] },
  };
  const secondResult = {
    ...result, uuid: "reentry-second-result", parentUuid: secondCall.uuid,
    sourceToolAssistantUUID: secondCall.uuid,
    message: { ...result.message, content: [{ ...result.message.content[0], tool_use_id: "toolu_context_second" }] },
  };
  rows[16].parentUuid = secondResult.uuid;
  rows.splice(16, 0, secondResult);
  rows.splice(15, 0, secondCall);
  await writeFile(tracePath, rows.map((row) => JSON.stringify(row) + "\n").join(""));
  await joinClaudeSession(projectRoot, PRETOOL_ATTACHMENT_FORK);
  const stopped = await handleClaudeIngestHook({
    hook_event_name: "Stop", session_id: PRETOOL_ATTACHMENT_FORK, cwd: projectRoot,
    transcript_path: tracePath, stop_hook_active: true, last_assistant_message: PRETOOL_VERDICT,
  }, { trailingTimeoutMs: 100, sleep: async () => assert.fail("closed reentry needs no later provider event") });
  assert.equal(stopped.ignored, undefined);
  assert.equal(stopped.ingested?.input.stop_turn_visible, true);
  assert.equal(stopped.ingested?.input.withheld_reason, undefined);
  assert.equal(stopped.ingested?.output.turns_appended, 1);
  assert.equal(stopped.ingested?.diagnostics.unpaired_tool_uses, 0);
  const feed = join(projectRoot, ".barbaro/feed/claude", `${stopped.ingested!.session_id}.jsonl`);
  const evidence = join(projectRoot, ".barbaro/evidence/claude", `${stopped.ingested!.session_id}.jsonl`);
  const before = [await readFile(feed, "utf8"), await readFile(evidence, "utf8")];
  const turns = await readJsonl<BarbaroTurnV1>(feed);
  assert.equal(turns.length, 1);
  assert.ok(turns[0]!.response?.text.endsWith(PRETOOL_VERDICT));
  assert.equal(turns[0]!.actions.filter((action) => action.kind === "command" && action.command.text === PRETOOL_CONTEXT_COMMAND).length, 2);
  await appendFile(tracePath, JSON.stringify({ ...rows[1], leafUuid: rows.at(-1).uuid }) + "\n");
  const replay = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal: false });
  assert.equal(replay.output.turns_appended, 0);
  assert.equal(replay.output.conflicted, 0);
  assert.deepEqual([await readFile(feed, "utf8"), await readFile(evidence, "utf8")], before);
});

test("an attachment sidecar does not hide a genuine post-pointer message fork", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "pretool-attachment-fork",
    PRETOOL_ATTACHMENT_FORK,
  );
  await joinClaudeSession(projectRoot, PRETOOL_ATTACHMENT_FORK);
  const semanticFork = JSON.stringify({
    parentUuid: PRETOOL_TOOL_USE,
    isSidechain: false,
    promptId: "prompt-rewind",
    type: "user",
    message: { role: "user", content: "Choose a different continuation." },
    uuid: "c1200000-0000-4000-8000-000000000014",
    timestamp: "2026-08-23T17:23:02.000Z",
    origin: { kind: "human" },
    promptSource: "typed",
    userType: "external",
    cwd: projectRoot,
    sessionId: PRETOOL_ATTACHMENT_FORK,
  });
  await writeFile(
    tracePath,
    `${await readFile(tracePath, "utf8")}${semanticFork}\n`,
    "utf8",
  );

  const result = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: false,
  });
  assert.equal(result.input.withheld_reason, "ambiguous_pointer_continuation");
  assert.equal(result.output.turns_appended, 0);
  assert.equal(result.output.evidence_appended, 0);
});

test("a torn last-prompt replacement publishes nothing", async () => {
  // last-prompt is rewritten in place. Catching it mid-write means the branch
  // it names is unknown, and any turn published now may be contradicted once
  // the pointer lands — a contradiction the append store can never accept.
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const rows = await rowsOf(tracePath);
  const pointer = rows.findIndex((line) => line.includes('"last-prompt"'));
  assert.ok(pointer > 0);
  await writeFile(
    tracePath,
    `${rows.slice(0, pointer).join("\n")}\n${rows[pointer]!.slice(0, 30)}`,
    "utf8",
  );

  const torn = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(torn.input.withheld_reason, "partial_final_line");
  assert.equal(torn.output.turns_appended, 0);
  assert.equal(torn.output.evidence_appended, 0);

  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");
  const healed = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(healed.input.withheld_reason, undefined);
  assert.ok(healed.output.turns_appended > 0);
});

test("a malformed last-prompt replacement publishes nothing", async () => {
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const rows = await rowsOf(tracePath);
  const pointer = rows.findIndex((line) => line.includes('"last-prompt"'));
  rows[pointer] = '{"type":"last-prompt","leafUuid":';
  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");

  const broken = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(broken.input.withheld_reason, "malformed_records");
  assert.equal(broken.output.turns_appended, 0);
});

test("a live prefix with a fork but no pointer yet publishes nothing", async () => {
  // The fork is visible; the pointer that resolves it has not been written.
  // Choosing a branch here is a guess that later becomes an ID conflict.
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const rows = await rowsOf(tracePath);
  const withoutPointer = rows.filter((line) => !line.includes('"last-prompt"'));
  await writeFile(tracePath, `${withoutPointer.join("\n")}\n`, "utf8");

  const live = await runClaudeTrace({ tracePath, projectRoot, final: false });
  assert.equal(live.input.withheld_reason, "fork_without_pointer");
  assert.equal(live.output.turns_appended, 0);

  // A finished trace with no pointer is not a guess — nothing more is coming,
  // so every record is treated as on-branch and publication proceeds.
  const settled = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(settled.input.withheld_reason, undefined);
  assert.ok(settled.output.turns_appended > 0);
});

test("a multi-row foreign response is suppressed to its last row", async () => {
  // Lifting suppression on the first end_turn row leaks the rest of the
  // foreign response into the human turn's evidence.
  const { projectRoot, tracePath } = await stageScenario("sticky-suppression", STICKY);
  const rows = await rowsOf(tracePath);
  const sdkRow = rows.findIndex((line) => line.includes("SDK SPAN"));
  assert.ok(sdkRow > 0);
  const secondRow = rows[sdkRow]!
    .replace("SDK SPAN", "SDK SPAN CONTINUED")
    .replace("a9000000-0000-4000-8000-000000000004", "a9000000-0000-4000-8000-000000000040")
    .replace('"parentUuid":"a9000000-0000-4000-8000-000000000003"',
             '"parentUuid":"a9000000-0000-4000-8000-000000000004"');
  rows.splice(sdkRow + 1, 0, secondRow);
  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  const everything = JSON.stringify({ turns, evidence });
  assert.ok(!everything.includes("SDK SPAN"), "no row of the foreign span leaks");
  assert.equal(turns[0]?.response?.text, "HUMAN RESPONSE");
  assert.equal(result.diagnostics.suppressed_spans, 2, "both rows suppressed");
});

test("an abandoned failure never becomes the active turn's outcome", async () => {
  // A tool result on a rewound path must not set the live action to failed,
  // nor contribute an exit code, nor move the turn's timing.
  const { projectRoot, tracePath } = await stageScenario("active-fork", ACTIVE_FORK);
  const rows = await rowsOf(tracePath);
  const abandoned = JSON.stringify({
    parentUuid: "b1000000-0000-4000-8000-000000000005",
    isSidechain: false,
    userType: "external",
    cwd: "__ROOT__",
    sessionId: ACTIVE_FORK,
    version: "2.1.233",
    gitBranch: "main",
    entrypoint: "cli",
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: "toolu_FX",
          type: "tool_result",
          content: "Exit code 1\nabandoned failure",
          is_error: true,
        },
      ],
    },
    promptId: "p-a001",
    uuid: "b1000000-0000-4000-8000-000000000077",
    timestamp: "2026-08-16T19:05:00.000Z",
  }).split("__ROOT__").join(projectRoot);
  rows.splice(rows.length - 1, 0, abandoned);
  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const turn = turns[0];
  assert.ok(turn);
  assert.equal(turn.outcome, "success", "an abandoned failure is not the live outcome");
  for (const action of turn.actions) {
    assert.notEqual(action.outcome, "failed");
    assert.ok(!("exit_code" in action));
  }
  // Lineage recovery must not drag the turn's timing forward either.
  assert.equal(turn.ended_at, "2026-08-16T19:00:09.000Z");
  assert.ok(!JSON.stringify(turns).includes("abandoned failure"));
});

test("an abandoned compaction boundary is not evidence for the live turn", async () => {
  const { projectRoot, tracePath } = await stageScenario("active-fork", ACTIVE_FORK);
  const rows = await rowsOf(tracePath);
  const boundary = JSON.stringify({
    parentUuid: null,
    logicalParentUuid: "b1000000-0000-4000-8000-000000000005",
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: "auto",
      preTokens: 999,
      postTokens: 1,
      cumulativeDroppedTokens: 998,
    },
    uuid: "b1000000-0000-4000-8000-000000000088",
    timestamp: "2026-08-16T19:06:00.000Z",
    userType: "external",
    entrypoint: "cli",
    cwd: "__ROOT__",
    sessionId: ACTIVE_FORK,
    version: "2.1.233",
    gitBranch: "main",
  }).split("__ROOT__").join(projectRoot);
  rows.splice(rows.length - 1, 0, boundary);
  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );
  assert.ok(
    !evidence.some(
      (item) =>
        item.kind === "provider_event" &&
        (item.content as { event?: string }).event === "compact_boundary",
    ),
    "a boundary on a rewound path is not live evidence",
  );
  assert.equal(result.diagnostics.compact_boundaries, 0);
});

test("child evidence is never appended without a reachable parent digest", async () => {
  // A blocked parent withholds its digest; its children must be withheld too,
  // or their parent_turn_id points at a turn no reader can resolve.
  const { projectRoot, tracePath } = await stageScenario("subagent-join", SUBAGENT);
  const journal = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
    "journal.jsonl",
  );
  const workflowChild = join(
    dirname(tracePath),
    SUBAGENT,
    "subagents",
    "workflows",
    "wf_abc1234-def",
    "agent-a2222222222222222.jsonl",
  );
  const childRows = await rowsOf(workflowChild);
  await writeFile(workflowChild, `${childRows.slice(0, -1).join("\n")}\n`, "utf8");
  const journalRows = await rowsOf(journal);
  await writeFile(
    journal,
    `${journalRows.filter((line) => line.includes('"started"')).join("\n")}\n`,
    "utf8",
  );

  const result = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(result.subagents.blocked_parent_turns, 1);

  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  ).catch(() => [] as BarbaroTurnV1[]);
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  ).catch(() => [] as BarbaroEvidenceV1[]);

  const published = new Set(turns.map((turn) => turn.turn_id));
  for (const item of evidence) {
    if (item.parent_turn_id === undefined) continue;
    assert.ok(
      published.has(item.parent_turn_id),
      `dangling parent_turn_id ${item.parent_turn_id}`,
    );
  }
  assert.equal(
    evidence.some((item) => item.kind === "subagent_turn"),
    false,
    "no child evidence while the parent is withheld",
  );
});

test("two consecutive foreign spans are both suppressed", async () => {
  // A second barrier used to inherit the first span's group state, so its
  // opening group looked like a new group arriving after a finished one and
  // was mistaken for resumed human work.
  const { projectRoot, tracePath } = await stageScenario("sticky-suppression", STICKY);
  const rows = await rowsOf(tracePath);
  const sdkPromptIndex = rows.findIndex((line) => /"promptSource":\s*"sdk"/.test(line));
  const sdkReplyIndex = rows.findIndex((line) => line.includes("SDK SPAN"));
  assert.ok(sdkPromptIndex > 0 && sdkReplyIndex > sdkPromptIndex);

  // Second foreign prompt, chained after the first foreign reply.
  const secondPrompt = rows[sdkPromptIndex]!
    .replace("a9000000-0000-4000-8000-000000000003", "a9000000-0000-4000-8000-000000000030")
    .replace(
      "a9000000-0000-4000-8000-000000000002",
      "a9000000-0000-4000-8000-000000000004",
    );
  const secondReply = rows[sdkReplyIndex]!
    .replace("SDK SPAN", "FOREIGN TWO LEAK")
    .replace("msg_9002", "msg_9002b")
    .replace("a9000000-0000-4000-8000-000000000004", "a9000000-0000-4000-8000-000000000041")
    .replace(
      "a9000000-0000-4000-8000-000000000003",
      "a9000000-0000-4000-8000-000000000030",
    );
  assert.ok(secondPrompt.includes("000000000030"), "second foreign prompt built");
  assert.ok(secondReply.includes("FOREIGN TWO LEAK"), "second foreign reply built");
  rows.splice(sdkReplyIndex + 1, 0, secondPrompt, secondReply);
  await writeFile(tracePath, `${rows.join("\n")}\n`, "utf8");

  const result = await runClaudeTrace({ tracePath, projectRoot });
  const turns = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.session_id}.jsonl`),
  );
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${result.session_id}.jsonl`),
  );

  const everything = JSON.stringify({ turns, evidence });
  assert.ok(!everything.includes("FOREIGN TWO LEAK"), "the second span must not leak");
  assert.ok(!everything.includes("SDK SPAN"));
  assert.equal(turns[0]?.response?.text, "HUMAN RESPONSE");
  assert.equal(result.diagnostics.segmentation_barriers, 2, "two barriers, two spans");
});

test("a pointer appended mid-ingest never yields a conflicting publish", async () => {
  // The window between reading and appending is where a replacement pointer
  // lands. Publishing under the stale pointer would collide with the settled
  // rerun forever, so the run must withhold instead.
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const settled = await rowsOf(tracePath);
  const withoutPointer = settled.filter((line) => !line.includes('"last-prompt"'));
  await writeFile(tracePath, `${withoutPointer.join("\n")}\n`, "utf8");

  // Append the real pointer while the run is in flight.
  const inFlight = runClaudeTrace({ tracePath, projectRoot });
  setImmediate(() => {
    void writeFile(tracePath, `${settled.join("\n")}\n`, "utf8");
  });
  const first = await inFlight;

  // Whatever the timing, the settled rerun must succeed — never a conflict.
  const rerun = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(rerun.input.withheld_reason, undefined);

  const reference = await stageScenario("compaction-forks", COMPACTION);
  const clean = await runClaudeTrace({
    tracePath: reference.tracePath,
    projectRoot: reference.projectRoot,
  });
  const actual = await readFile(
    join(projectRoot, ".barbaro", "feed", "claude", `${rerun.session_id}.jsonl`),
    "utf8",
  );
  const expected = await readFile(
    join(reference.projectRoot, ".barbaro", "feed", "claude", `${clean.session_id}.jsonl`),
    "utf8",
  );
  assert.equal(actual, expected, "the settled result must match a clean ingest");
  assert.ok(first.trace_id.length > 0);
});

test("Stop may close a terminal turn but not settle a pointerless fork", async () => {
  // Two different claims. Stop knows the turn ended; only SessionEnd (or an
  // offline parse) knows the branch pointer will not change.
  const { handleClaudeIngestHook } = await import("../../src/hooks/claude.js");
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  await joinClaudeSession(projectRoot, COMPACTION);
  const settled = await rowsOf(tracePath);
  await writeFile(
    tracePath,
    `${settled.filter((line) => !line.includes('"last-prompt"')).join("\n")}\n`,
    "utf8",
  );

  const onStop = await handleClaudeIngestHook({
    hook_event_name: "Stop",
    session_id: COMPACTION,
    cwd: projectRoot,
    transcript_path: tracePath,
  });
  assert.equal(
    onStop.ingested?.input.withheld_reason,
    "fork_without_pointer",
    "Stop must not choose a branch the file has not named",
  );
  assert.equal(onStop.ingested?.output.turns_appended, 0);

  // SessionEnd on the same pointerless file may settle it.
  const onSessionEnd = await handleClaudeIngestHook({
    hook_event_name: "SessionEnd",
    session_id: COMPACTION,
    cwd: projectRoot,
    transcript_path: tracePath,
  });
  assert.equal(onSessionEnd.ingested?.input.withheld_reason, undefined);
  assert.ok((onSessionEnd.ingested?.output.turns_appended ?? 0) > 0);
});

test("Stop reports earlier publications even when its trailing close times out", async () => {
  const { handleClaudeIngestHook } = await import("../../src/hooks/claude.js");
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  await joinClaudeSession(projectRoot, COMPACTION);
  let time = 0;
  let polls = 0;
  const result = await handleClaudeIngestHook({
    hook_event_name: "Stop",
    session_id: COMPACTION,
    cwd: projectRoot,
    transcript_path: tracePath,
  }, {
    now: () => time, trailingTimeoutMs: 30, pollIntervalMs: 10,
    sleep: async (milliseconds) => { time += milliseconds; polls += 1; },
  });
  assert.equal(result.ingested?.input.withheld_reason, undefined);
  assert.ok((result.ingested?.output.turns_appended ?? 0) > 0, "Stop can still publish");
  assert.equal(polls, 3);
  assert.match(result.ignored ?? "", /terminal closing record not visible/u);
  const feed = await readJsonl<BarbaroTurnV1>(join(projectRoot, ".barbaro", "feed", "claude", `${result.ingested!.session_id}.jsonl`));
  assert.equal(result.ingested!.output.turns_appended, feed.length);
  const attempt = await latestClaudeIngestAttempt(projectRoot, result.ingested!.session_id);
  assert.equal(attempt.publish_blocker, "trailing_turn_close_timeout");
});

test("Stop without an authoritative close withholds its trailing turn; SessionEnd can close it", async () => {
  // The turn that just ended can still absorb records — remaining text blocks
  // of its API response, an async continuation, a task notification folding
  // in — so its digest is not canonical at Stop even once its terminal record
  // lands. Publishing it here is what minted the same-ID-different-content
  // conflicts of 2026-08-18. It publishes when a successor record exists, or
  // when SessionEnd asserts the source is final.
  const { handleClaudeIngestHook } = await import("../../src/hooks/claude.js");
  const { projectRoot, tracePath } = await stageScenario("poisoned-paths", POISONED);
  await joinClaudeSession(projectRoot, POISONED);

  // First Stop publishes every turn a successor record already closed …
  const first = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: POISONED,
      cwd: projectRoot,
      transcript_path: tracePath,
    },
    { pollIntervalMs: 10, trailingTimeoutMs: 2_000 },
  );
  assert.equal(first.ingested?.input.trailing_turns_withheld, 1);
  assert.equal(first.ingested?.input.trailing_turn_open, true);

  // … and no amount of re-running Stop publishes the trailing one.
  const onStop = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: POISONED,
      cwd: projectRoot,
      transcript_path: tracePath,
    },
    { pollIntervalMs: 10, trailingTimeoutMs: 2_000 },
  );
  assert.equal(onStop.ingested?.input.trailing_turns_withheld, 1);
  assert.equal(onStop.ingested?.input.trailing_turn_open, true);
  assert.equal(
    onStop.ingested?.output.turns_appended,
    0,
    "a terminal-reached trailing turn is still not canonical at Stop",
  );

  const onSessionEnd = await handleClaudeIngestHook({
    hook_event_name: "SessionEnd",
    session_id: POISONED,
    cwd: projectRoot,
    transcript_path: tracePath,
  });
  assert.equal(onSessionEnd.ingested?.input.trailing_turns_withheld, 0);
  assert.equal(
    onSessionEnd.ingested?.output.turns_appended,
    1,
    "SessionEnd settles the withheld trailing turn",
  );
});

test("a turn that never closes returns promptly instead of waiting", async () => {
  // Under the canonical-publication rule there is nothing worth waiting for:
  // even a closed trailing turn would be withheld, so an unterminated one
  // must not burn the hook's budget polling for a record whose arrival would
  // change nothing.
  const { handleClaudeIngestHook } = await import("../../src/hooks/claude.js");
  const { projectRoot, tracePath } = await stageScenario("poisoned-paths", POISONED);
  await joinClaudeSession(projectRoot, POISONED);
  const settled = await rowsOf(tracePath);
  await writeFile(tracePath, `${settled.slice(0, -2).join("\n")}\n`, "utf8");

  const startedAt = Date.now();
  const result = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: POISONED,
      cwd: projectRoot,
      transcript_path: tracePath,
    },
    { pollIntervalMs: 10, trailingTimeoutMs: 5_000 },
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ingested?.input.trailing_turn_open, true);
  assert.equal(result.ingested?.output.turns_appended, 0);
  assert.ok(
    elapsed < 2_500,
    `no closure wait may be attempted, took ${elapsed} ms`,
  );
});

test("a pointer appended during child normalization is caught before append", async () => {
  // The window that matters is not around the main read — it spans child
  // normalization, which is unbounded work. A large subagent trace leaves
  // hundreds of milliseconds in which a replacement pointer can land, and a
  // check taken before that pass would already be stale by the time anything
  // is written.
  const { projectRoot, tracePath } = await stageScenario("active-fork", ACTIVE_FORK);
  const childPath = join(
    dirname(tracePath),
    ACTIVE_FORK,
    "subagents",
    "agent-aaaa111111111111a.jsonl",
  );

  // Inflate the child with harmless sidecar rows so its pass is slow enough
  // to hold the window open.
  const filler =
    `${JSON.stringify({ type: "mode", mode: "default", sessionId: ACTIVE_FORK })}\n`.repeat(
      100_000,
    );
  await writeFile(childPath, `${await readFile(childPath, "utf8")}${filler}`, "utf8");

  const settled = await rowsOf(tracePath);
  const replacement = settled.map((line) =>
    line.includes('"last-prompt"')
      ? line.replace(
          "b1000000-0000-4000-8000-000000000004",
          "b1000000-0000-4000-8000-000000000006",
        )
      : line,
  );

  const started = Date.now();
  const inFlight = runClaudeTrace({ tracePath, projectRoot });
  // Long after the small parent file has been read, well inside the child pass.
  const timer = setTimeout(() => {
    void writeFile(tracePath, `${replacement.join("\n")}\n`, "utf8");
  }, 20);
  const first = await inFlight;
  clearTimeout(timer);

  assert.ok(
    Date.now() - started > 20,
    "the run must outlast the append for this to exercise the child window",
  );
  // The replacement pointer is the SAME length as the one it replaces, so
  // size and identity are both unchanged — only the modification time moves.
  assert.equal(
    first.input.withheld_reason,
    "source_rewritten_during_ingest",
    "drift during child normalization must be caught before anything is written",
  );
  assert.equal(first.output.turns_appended, 0);
  assert.equal(first.output.evidence_appended, 0, "child output is discarded too");

  // Nothing was published, so the settled rerun is free to pick whichever
  // branch the final pointer names — and must never conflict.
  const rerun = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(rerun.input.withheld_reason, undefined);
  const published = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${rerun.session_id}.jsonl`),
  );
  assert.ok(published.length > 0, "the settled rerun publishes");

  // And a third run over the unchanged file must add nothing new.
  const third = await runClaudeTrace({ tracePath, projectRoot });
  assert.equal(third.output.turns_appended, 0);
  assert.equal(third.output.turns_skipped, published.length);
});

test("a withheld run records no checkpoint progress", async () => {
  // A checkpoint claims a snapshot was consumed. Writing one for a snapshot
  // that was refused would report progress that never happened.
  const { projectRoot, tracePath } = await stageScenario("compaction-forks", COMPACTION);
  const settled = await rowsOf(tracePath);
  await writeFile(
    tracePath,
    `${settled.filter((line) => !line.includes('"last-prompt"')).join("\n")}\n`,
    "utf8",
  );

  const withheld = await runClaudeTrace({ tracePath, projectRoot, final: false });
  assert.equal(withheld.input.withheld_reason, "fork_without_pointer");
  assert.equal(withheld.checkpoint_status, "start");

  // Still "start", not "resume": the refused run left no progress behind.
  const again = await runClaudeTrace({ tracePath, projectRoot, final: false });
  assert.equal(again.checkpoint_status, "start");
});

test("published records carry the session's workstream, identically from hook and manual ingest", async () => {
  const { projectRoot, tracePath } = await stageScenario("failed-tool-loop", FAILED_LOOP);
  await joinClaudeSession(
    projectRoot,
    FAILED_LOOP,
    "lane",
    new Date("2026-08-01T00:00:00.000Z"),
  );
  const { SessionParticipationStore } = await import("../../src/hooks/participation.js");
  const participation = await new SessionParticipationStore(projectRoot).read(
    "claude",
    FAILED_LOOP,
  );
  assert.ok(participation?.workstream_id, "the session joined a workstream");

  const manual = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: true,
  });
  assert.ok(manual.output.turns_appended > 0);
  const feed = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${manual.session_id}.jsonl`),
  );
  assert.ok(feed.length > 0);
  for (const turn of feed) {
    assert.equal(turn.workstream_id, participation.workstream_id, turn.turn_id);
  }
  const evidence = await readJsonl<BarbaroEvidenceV1>(
    join(projectRoot, ".barbaro", "evidence", "claude", `${manual.session_id}.jsonl`),
  );
  for (const record of evidence) {
    assert.equal(record.workstream_id, participation.workstream_id, record.evidence_id);
  }

  // A full re-ingest recomputes byte-identical records: nothing conflicts and
  // nothing is appended twice.
  const again = await runClaudeTrace({
    tracePath,
    projectRoot,
    reset: true,
    final: true,
    sourceFinal: true,
  });
  assert.equal(again.output.conflicted, 0);
  assert.equal(again.output.turns_appended, 0);
  const after = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${manual.session_id}.jsonl`),
  );
  assert.equal(after.length, feed.length);
});

const TURN_DURATION_CLOSE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("Claude stamps each turn and evidence record with its membership at that time", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "turn-duration-close",
    TURN_DURATION_CLOSE,
  );
  const joined = await joinClaudeSession(
    projectRoot,
    TURN_DURATION_CLOSE,
    "alpha",
    new Date("2026-08-16T15:59:00.000Z"),
  );
  const alpha = joined.participation?.workstream_id;
  assert.ok(alpha);

  const first = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: true,
  });
  assert.equal(first.output.turns_appended, 1);

  const moved = await joinClaudeSession(
    projectRoot,
    TURN_DURATION_CLOSE,
    "beta",
    new Date("2026-08-16T16:04:00.000Z"),
  );
  const beta = moved.participation?.workstream_id;
  assert.ok(beta && beta !== alpha);

  const base = {
    isSidechain: false,
    userType: "external",
    cwd: projectRoot,
    version: "2.1.239",
    gitBranch: "main",
    entrypoint: "cli",
    sessionId: TURN_DURATION_CLOSE,
  };
  const secondRows = [
    {
      ...base,
      parentUuid: "ad000000-0000-4000-8000-000000000004",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Next request." }] },
      promptId: "p-d002",
      promptSource: "typed",
      origin: { kind: "human" },
      permissionMode: "default",
      uuid: "ad000000-0000-4000-8000-000000000009",
      timestamp: "2026-08-16T16:05:00.000Z",
    },
    {
      ...base,
      parentUuid: "ad000000-0000-4000-8000-000000000009",
      type: "assistant",
      requestId: "req_d002",
      message: {
        id: "msg_d002",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "CHECKPOINT 1 APPROVED." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 6 },
      },
      uuid: "ad000000-0000-4000-8000-00000000000a",
      timestamp: "2026-08-16T16:05:09.000Z",
    },
    {
      ...base,
      parentUuid: "ad000000-0000-4000-8000-00000000000a",
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 2,
      hookInfos: [],
      hookErrors: [],
      hookAdditionalContext: [],
      preventedContinuation: false,
      stopReason: "",
      hasOutput: false,
      level: "suggestion",
      uuid: "ad000000-0000-4000-8000-00000000000b",
      timestamp: "2026-08-16T16:05:09.500Z",
    },
    {
      ...base,
      parentUuid: "ad000000-0000-4000-8000-00000000000b",
      type: "system",
      subtype: "turn_duration",
      durationMs: 9_600,
      messageCount: 3,
      uuid: "ad000000-0000-4000-8000-00000000000c",
      timestamp: "2026-08-16T16:05:09.600Z",
    },
  ];
  await writeFile(
    tracePath,
    `${await readFile(tracePath, "utf8")}${secondRows
      .map((row) => `${JSON.stringify(row)}\n`)
      .join("")}`,
    "utf8",
  );

  const second = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: true,
  });
  assert.equal(second.output.turns_appended, 1);
  assert.equal(second.output.conflicted, 0);
  const feedPath = join(
    projectRoot,
    ".barbaro",
    "feed",
    "claude",
    `${second.session_id}.jsonl`,
  );
  const evidencePath = join(
    projectRoot,
    ".barbaro",
    "evidence",
    "claude",
    `${second.session_id}.jsonl`,
  );
  const turns = await readJsonl<BarbaroTurnV1>(feedPath);
  assert.deepEqual(
    turns.map((turn) => [turn.request.text, turn.workstream_id]),
    [
      ["Review the plan.", alpha],
      ["Next request.", beta],
    ],
  );
  const evidence = await readJsonl<BarbaroEvidenceV1>(evidencePath);
  assert.ok(evidence.some((record) => record.workstream_id === alpha));
  assert.ok(evidence.some((record) => record.workstream_id === beta));
  for (const record of evidence) {
    assert.equal(
      record.workstream_id,
      record.occurred_at < "2026-08-16T16:04:00.000Z" ? alpha : beta,
      record.evidence_id,
    );
  }

  const feedBytes = await readFile(feedPath, "utf8");
  const evidenceBytes = await readFile(evidencePath, "utf8");
  const reset = await runClaudeTrace({
    tracePath,
    projectRoot,
    reset: true,
    final: true,
    sourceFinal: true,
  });
  assert.equal(reset.output.conflicted, 0);
  assert.equal(reset.output.turns_appended, 0);
  assert.equal(await readFile(feedPath, "utf8"), feedBytes);
  assert.equal(await readFile(evidencePath, "utf8"), evidenceBytes);
});

test("a terminal turn with no background work publishes at its own Stop", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "turn-duration-close",
    TURN_DURATION_CLOSE,
  );
  await joinClaudeSession(projectRoot, TURN_DURATION_CLOSE);
  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: TURN_DURATION_CLOSE,
      cwd: projectRoot,
      transcript_path: tracePath,
    },
    { pollIntervalMs: 10, trailingTimeoutMs: 500 },
  );
  assert.ok(stopped.ingested);
  assert.equal(stopped.ingested.output.turns_appended, 1);
  assert.equal(stopped.ingested.input.trailing_turn_open, false);
  assert.equal(stopped.ingested.input.trailing_turns_withheld, 0);
  const feedPath = join(
    projectRoot,
    ".barbaro",
    "feed",
    "claude",
    `${stopped.ingested.session_id}.jsonl`,
  );
  const feed = await readJsonl<BarbaroTurnV1>(feedPath);
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.response?.text, "PLAN APPROVED — the phases are sound.");

  // A successor prompt appended later recomputes the same bytes: nothing new,
  // nothing conflicting, and the new open turn is withheld as usual.
  const successor = {
    isSidechain: false,
    userType: "external",
    cwd: projectRoot,
    version: "2.1.239",
    gitBranch: "main",
    entrypoint: "cli",
    sessionId: TURN_DURATION_CLOSE,
    parentUuid: "ad000000-0000-4000-8000-000000000004",
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Next request." }] },
    promptId: "p-d002",
    promptSource: "typed",
    origin: { kind: "human" },
    permissionMode: "default",
    uuid: "ad000000-0000-4000-8000-000000000009",
    timestamp: "2026-08-16T16:05:00.000Z",
  };
  await writeFile(
    tracePath,
    `${await readFile(tracePath, "utf8")}${JSON.stringify(successor)}\n`,
    "utf8",
  );
  const again = await runClaudeTrace({ tracePath, projectRoot, final: true });
  assert.equal(again.output.conflicted, 0);
  assert.equal(again.output.turns_appended, 0);
  assert.equal((await readJsonl<BarbaroTurnV1>(feedPath)).length, 1);
});

test("a terminal background continuation is named in the Stop attempt journal", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "background-continuation",
    BACKGROUND_CONTINUATION,
  );
  const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
  await writeFile(tracePath, `${rows.slice(0, 4).join("\n")}\n`, "utf8");
  await joinClaudeSession(projectRoot, BACKGROUND_CONTINUATION);

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: BACKGROUND_CONTINUATION,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message: "Watcher armed.",
    },
    {
      now: () => 0,
      sleep: async () =>
        assert.fail("a non-closable background turn must not poll"),
    },
  );
  assert.ok(stopped.ingested);
  assert.equal(stopped.ingested.input.trailing_turn_terminal, true);
  assert.equal(stopped.ingested.input.trailing_turn_closable, false);
  assert.deepEqual(stopped.ingested.input.pending_background_ids, ["toolu_BG"]);
  assert.equal(stopped.ingested.input.pending_background_count, 1);

  const journal = JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".barbaro",
        "logs",
        "ingest",
        "claude",
        `${stopped.ingested.session_id}.json`,
      ),
      "utf8",
    ),
  ) as BarbaroIngestAttemptJournalV2;
  const attempt = journal.attempts.at(-1);
  assert.ok(attempt);
  assert.deepEqual(attempt.pending_background_ids, ["toolu_BG"]);
  assert.equal(attempt.runner_input?.pending_background_count, 1);
  assert.equal(attempt.publish_blocker, "pending_background");
  assert.equal(attempt.outcome, "ok");
});

test("an in-turn queued-command completion publishes without a background blocker", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "queued-background-completion",
    QUEUED_BACKGROUND_COMPLETION,
  );
  await joinClaudeSession(projectRoot, QUEUED_BACKGROUND_COMPLETION);

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: QUEUED_BACKGROUND_COMPLETION,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message: "CHECKPOINT 1 APPROVED.",
    },
    {
      now: () => 0,
      sleep: async () => assert.fail("the completed turn is already closed"),
    },
  );
  assert.ok(stopped.ingested);
  assert.equal(stopped.ingested.output.turns_appended, 1);
  assert.equal(stopped.ingested.input.trailing_turn_open, false);
  assert.deepEqual(stopped.ingested.input.pending_background_ids, []);
  assert.equal(stopped.ingested.input.pending_background_count, 0);

  const attempt = await latestClaudeIngestAttempt(
    projectRoot,
    stopped.ingested.session_id,
  );
  assert.deepEqual(attempt.pending_background_ids, []);
  assert.equal(attempt.runner_input?.pending_background_count, 0);
  assert.equal(attempt.publish_blocker, undefined);
  assert.equal(attempt.outcome, "ok");
});

test("a failed queued background report also settles its named launch", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "queued-background-completion",
    QUEUED_BACKGROUND_COMPLETION,
  );
  await rewriteTraceRows(tracePath, (row) => {
    if (row.uuid !== "af000000-0000-4000-8000-000000000006") return row;
    const attachment = row.attachment as Record<string, unknown>;
    const prompt = attachment.prompt as string;
    return {
      ...row,
      attachment: {
        ...attachment,
        prompt: prompt.replace(
          "<status>completed</status>",
          "<status>failed</status>",
        ),
      },
    };
  });
  await joinClaudeSession(projectRoot, QUEUED_BACKGROUND_COMPLETION);

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: QUEUED_BACKGROUND_COMPLETION,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message: "CHECKPOINT 1 APPROVED.",
    },
    {
      now: () => 0,
      sleep: async () => assert.fail("a terminal failure is already settled"),
    },
  );
  assert.ok(stopped.ingested);
  assert.equal(stopped.ingested.output.turns_appended, 1);
  assert.deepEqual(stopped.ingested.input.pending_background_ids, []);
  const attempt = await latestClaudeIngestAttempt(
    projectRoot,
    stopped.ingested.session_id,
  );
  assert.equal(attempt.publish_blocker, undefined);
});

test("queue duplicates and non-authoritative attachments cannot settle a background turn", async (t) => {
  for (const branch of ["attachment-only", "rejected-semantic"] as const) {
    await t.test(branch, async () => {
      const { projectRoot, tracePath } = await stageScenario(
        "queued-background-completion",
        QUEUED_BACKGROUND_COMPLETION,
      );
      // Strip only the completion payload from the authoritative on-branch row.
      // The UUID and parent edge remain so branch selection is byte-for-byte the
      // same; the queue-operation duplicates, off-branch completion, and on-path
      // Monitor notification are all still present and must remain inert.
      await rewriteTraceRows(tracePath, (row) =>
        row.uuid === "af000000-0000-4000-8000-000000000006"
          ? {
              ...row,
              attachment: {
                type: "total_tokens_reminder",
                text: "<total_tokens>1000 tokens left</total_tokens>",
              },
            }
          : row,
      );
      if (branch === "rejected-semantic") {
        const rows = (await rowsOf(tracePath)).map((line) => JSON.parse(line));
        // A semantic child does not turn an earlier rejected attachment into a
        // bridge. Only paths connecting accepted response/result rows may do so.
        rows.splice(rows.findIndex((r) => r.type === "last-prompt"), 0, {
          ...rows.find((r) => r.uuid === "af000000-0000-4000-8000-000000000008"),
          uuid: "rejected-semantic-row", parentUuid: "af000000-0000-4000-8000-000000000004",
          requestId: "rejected-request",
          message: { id: "rejected-response", role: "assistant", content: [{ type: "text", text: "Rejected branch." }] },
        });
        await writeFile(tracePath, rows.map((r) => JSON.stringify(r) + "\n").join(""));
      }
      await joinClaudeSession(projectRoot, QUEUED_BACKGROUND_COMPLETION);

      const stopped = await handleClaudeIngestHook(
        {
          hook_event_name: "Stop",
          session_id: QUEUED_BACKGROUND_COMPLETION,
          cwd: projectRoot,
          transcript_path: tracePath,
          last_assistant_message: "CHECKPOINT 1 APPROVED.",
        },
        {
          now: () => 0,
          sleep: async () =>
            assert.fail("a non-closable background turn must not poll"),
        },
      );
      assert.ok(stopped.ingested);
      assert.equal(stopped.ingested.output.turns_appended, 0);
      assert.equal(stopped.ingested.input.trailing_turn_terminal, true);
      assert.equal(stopped.ingested.input.trailing_turn_closable, false);
      assert.deepEqual(stopped.ingested.input.pending_background_ids, [
        "toolu_QUEUE_BG",
      ]);

      const attempt = await latestClaudeIngestAttempt(
        projectRoot,
        stopped.ingested.session_id,
      );
      assert.deepEqual(attempt.pending_background_ids, ["toolu_QUEUE_BG"]);
      assert.equal(attempt.publish_blocker, "pending_background");
      assert.equal(attempt.outcome, "ok");
    });
  }
});

test("a queued-command completion clears only its named background launch", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "queued-background-completion",
    QUEUED_BACKGROUND_COMPLETION,
  );
  await rewriteTraceRows(tracePath, (row) => {
    if (row.uuid === "af000000-0000-4000-8000-000000000002") {
      const message = row.message as Record<string, unknown>;
      const content = message.content as unknown[];
      return {
        ...row,
        message: {
          ...message,
          content: [
            ...content,
            {
              type: "tool_use",
              id: "toolu_QUEUE_OTHER",
              name: "Bash",
              input: { command: "tail -f app.log", run_in_background: true },
            },
          ],
        },
      };
    }
    if (row.uuid === "af000000-0000-4000-8000-000000000003") {
      const message = row.message as Record<string, unknown>;
      const content = message.content as unknown[];
      return {
        ...row,
        message: {
          ...message,
          content: [
            ...content,
            {
              tool_use_id: "toolu_QUEUE_OTHER",
              type: "tool_result",
              content: "Command running in background with ID bg_other",
              is_error: false,
            },
          ],
        },
      };
    }
    return row;
  });
  await joinClaudeSession(projectRoot, QUEUED_BACKGROUND_COMPLETION);

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: QUEUED_BACKGROUND_COMPLETION,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message: "CHECKPOINT 1 APPROVED.",
    },
    {
      now: () => 0,
      sleep: async () =>
        assert.fail("the other live background launch must not poll"),
    },
  );
  assert.ok(stopped.ingested);
  assert.equal(stopped.ingested.output.turns_appended, 0);
  assert.deepEqual(stopped.ingested.input.pending_background_ids, [
    "toolu_QUEUE_OTHER",
  ]);
  const attempt = await latestClaudeIngestAttempt(
    projectRoot,
    stopped.ingested.session_id,
  );
  assert.deepEqual(attempt.pending_background_ids, ["toolu_QUEUE_OTHER"]);
  assert.equal(attempt.publish_blocker, "pending_background");
});

test("a completed background turn before turn_duration keeps the truthful close blocker", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "queued-background-completion",
    QUEUED_BACKGROUND_COMPLETION,
  );
  await rewriteTraceRows(tracePath, (row) =>
    row.type === "system" && row.subtype === "turn_duration" ? undefined : row,
  );
  await joinClaudeSession(projectRoot, QUEUED_BACKGROUND_COMPLETION);
  let time = 0;
  let polls = 0;

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: QUEUED_BACKGROUND_COMPLETION,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message: "CHECKPOINT 1 APPROVED.",
    },
    {
      now: () => time, trailingTimeoutMs: 30, pollIntervalMs: 10,
      sleep: async (milliseconds) => { time += milliseconds; polls += 1; },
    },
  );
  assert.ok(stopped.ingested);
  assert.equal(stopped.ingested.output.turns_appended, 0);
  assert.equal(stopped.ingested.input.trailing_turn_terminal, true);
  assert.equal(stopped.ingested.input.trailing_turn_closable, true);
  assert.deepEqual(stopped.ingested.input.pending_background_ids, []);
  assert.equal(polls, 3);
  assert.equal(stopped.ignored, "terminal closing record not visible before the ingest deadline");

  const attempt = await latestClaudeIngestAttempt(
    projectRoot,
    stopped.ingested.session_id,
  );
  assert.deepEqual(attempt.pending_background_ids, []);
  assert.equal(attempt.publish_blocker, "trailing_turn_close_timeout");
  assert.equal(attempt.outcome, "ok");
});

test("the first Stop waits for its first authoritative closing record and publishes without a later event", async () => {
  const { projectRoot, tracePath } = await stageScenario("turn-duration-close", TURN_DURATION_CLOSE);
  await joinClaudeSession(projectRoot, TURN_DURATION_CLOSE);
  const complete = await rowsOf(tracePath);
  await writeFile(tracePath, `${complete.slice(0, 2).join("\n")}\n`);
  let polls = 0;
  let time = 0;
  const stopped = await handleClaudeIngestHook({
    hook_event_name: "Stop", session_id: TURN_DURATION_CLOSE, cwd: projectRoot, transcript_path: tracePath,
    last_assistant_message: "PLAN APPROVED — the phases are sound.",
  }, {
    now: () => time, trailingTimeoutMs: 100, pollIntervalMs: 10,
    sleep: async (milliseconds) => {
      polls += 1;
      time += milliseconds;
      assert.equal(polls, 1);
      await appendFile(tracePath, `${complete.slice(2).join("\n")}\n`);
    },
  });
  assert.equal(polls, 1);
  assert.equal(stopped.ignored, undefined);
  assert.equal(stopped.ingested?.input.trailing_turn_open, false);
  assert.equal(stopped.ingested?.output.turns_appended, 1);
  assert.equal(stopped.ingested?.output.conflicted, 0);
  const feedPath = join(projectRoot, ".barbaro", "feed", "claude", `${stopped.ingested!.session_id}.jsonl`);
  const canonical = await readFile(feedPath, "utf8");
  const replay = await runClaudeTrace({ projectRoot, tracePath, final: true, sourceFinal: false });
  assert.equal(replay.output.turns_appended, 0);
  assert.equal(replay.output.conflicted, 0);
  assert.equal(await readFile(feedPath, "utf8"), canonical);
});

test("the Stop ingest waits briefly for turn_duration to land", async () => {
  // The synchronous hooks return before Claude writes stop_hook_summary and
  // turn_duration; the asynchronous ingest polls through that gap. This case
  // follows a previously closed turn; the first-turn case is covered above.
  const { projectRoot, tracePath } = await stageScenario(
    "turn-duration-close",
    TURN_DURATION_CLOSE,
  );
  await joinClaudeSession(projectRoot, TURN_DURATION_CLOSE);
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: projectRoot,
    version: "2.1.239",
    gitBranch: "main",
    entrypoint: "cli",
    sessionId: TURN_DURATION_CLOSE,
  };
  const secondPrompt = {
    ...base,
    parentUuid: "ad000000-0000-4000-8000-000000000004",
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "And the checkpoint?" }] },
    promptId: "p-d002",
    promptSource: "typed",
    origin: { kind: "human" },
    permissionMode: "default",
    uuid: "ad000000-0000-4000-8000-000000000009",
    timestamp: "2026-08-16T16:05:00.000Z",
  };
  const secondAnswer = {
    ...base,
    parentUuid: "ad000000-0000-4000-8000-000000000009",
    type: "assistant",
    requestId: "req_d002",
    message: {
      id: "msg_d002",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "CHECKPOINT 1 APPROVED." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 6 },
    },
    uuid: "ad000000-0000-4000-8000-00000000000a",
    timestamp: "2026-08-16T16:05:09.000Z",
  };
  const secondSummary = {
    ...base,
    parentUuid: "ad000000-0000-4000-8000-00000000000a",
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 2,
    hookInfos: [],
    hookErrors: [],
    hookAdditionalContext: [],
    preventedContinuation: false,
    stopReason: "",
    hasOutput: false,
    level: "suggestion",
    uuid: "ad000000-0000-4000-8000-00000000000b",
    timestamp: "2026-08-16T16:05:09.500Z",
  };
  const secondDuration = {
    ...base,
    parentUuid: "ad000000-0000-4000-8000-00000000000b",
    type: "system",
    subtype: "turn_duration",
    durationMs: 9500,
    messageCount: 2,
    isMeta: false,
    uuid: "ad000000-0000-4000-8000-00000000000c",
    timestamp: "2026-08-16T16:05:09.600Z",
  };
  const line = (row: unknown): string => `${JSON.stringify(row)}\n`;
  await appendFile(
    tracePath,
    `${line(secondPrompt)}${line(secondAnswer)}`,
    "utf8",
  );

  const ingesting = handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: TURN_DURATION_CLOSE,
      cwd: projectRoot,
      transcript_path: tracePath,
    },
    { pollIntervalMs: 10, trailingTimeoutMs: 2_000 },
  );
  await delay(60);
  await appendFile(
    tracePath,
    `${line(secondSummary)}${line(secondDuration)}`,
    "utf8",
  );
  const result = await ingesting;
  assert.equal(result.ingested?.output.turns_appended, 2, "the Stop reports both its first-pass publication and the newly closed turn");
  assert.equal(result.ingested?.input.trailing_turn_open, false);
  const feed = await readJsonl<BarbaroTurnV1>(
    join(projectRoot, ".barbaro", "feed", "claude", `${result.ingested!.session_id}.jsonl`),
  );
  assert.deepEqual(
    feed.map((turn) => turn.response?.text),
    ["PLAN APPROVED — the phases are sound.", "CHECKPOINT 1 APPROVED."],
  );
  const attempt = await latestClaudeIngestAttempt(projectRoot, result.ingested!.session_id);
  assert.equal(attempt.turns_appended, result.ingested!.output.turns_appended);
  assert.equal(attempt.publish_blocker, undefined);
});

test("Stop re-reads until its announced turn lands, then publishes it", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "stop-read-race",
    STOP_READ_RACE,
  );
  const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
  await writeFile(tracePath, `${rows.slice(0, 4).join("\n")}\n`, "utf8");
  await joinClaudeSession(projectRoot, STOP_READ_RACE);

  const prior = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: true,
  });
  assert.equal(prior.output.turns_appended, 1);
  await appendFile(tracePath, `${rows[4]}\n`, "utf8");
  const beforeSize = (await stat(tracePath)).size;
  let clock = 0;
  let finalRowsAppended = false;
  const sleeps: number[] = [];
  const announced = "CHECKPOINT 3 APPROVED — replayed after flush.";

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: STOP_READ_RACE,
      cwd: projectRoot,
      transcript_path: tracePath,
      stop_hook_active: true,
      last_assistant_message: `\n${announced}\n`,
    },
    {
      now: () => clock,
      pollIntervalMs: 50,
      timeoutMs: 1_000,
      trailingTimeoutMs: 1_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
        if (clock >= 200 && !finalRowsAppended) {
          finalRowsAppended = true;
          await appendFile(tracePath, `${rows.slice(5).join("\n")}\n`, "utf8");
        }
      },
    },
  );

  assert.deepEqual(sleeps, [50, 50, 50, 50]);
  assert.equal(stopped.ignored, undefined);
  assert.equal(stopped.ingested?.input.stop_turn_visible, true);
  assert.equal(stopped.ingested?.output.turns_appended, 1);
  const afterSize = (await stat(tracePath)).size;
  const feed = await readJsonl<BarbaroTurnV1>(
    join(
      projectRoot,
      ".barbaro",
      "feed",
      "claude",
      `${stopped.ingested!.session_id}.jsonl`,
    ),
  );
  assert.equal(
    feed.at(-1)?.response?.text,
    "CHECKPOINT 3 APPROVED\n — replayed after flush.",
  );

  const journal = JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".barbaro",
        "logs",
        "ingest",
        "claude",
        `${stopped.ingested!.session_id}.json`,
      ),
      "utf8",
    ),
  ) as BarbaroIngestAttemptJournalV2;
  const attempt = journal.attempts.at(-1);
  assert.ok(attempt);
  assert.equal(attempt.outcome, "ok");
  assert.equal(attempt.trigger?.stop_hook_active, true);
  assert.equal(attempt.turns_appended, 1);
  assert.deepEqual(
    attempt.observations.size_transitions.map((item) => item.observed_size),
    [beforeSize, afterSize],
  );
  assert.ok(attempt.observations.size_transitions[0]!.repeat_count > 1);
});

test("Stop does not mistake a whitespace-collapsed prior verdict for its turn", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "stop-read-race",
    STOP_READ_RACE,
  );
  const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
  await writeFile(tracePath, `${rows.slice(0, 2).join("\n")}\n`, "utf8");
  await joinClaudeSession(projectRoot, STOP_READ_RACE);
  let clock = 0;
  let appended = false;
  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: STOP_READ_RACE,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message:
        "CHECKPOINT 3 APPROVED — replayed after flush.",
    },
    {
      now: () => clock,
      pollIntervalMs: 50,
      timeoutMs: 1_000,
      sleep: async (milliseconds) => {
        clock += milliseconds;
        if (!appended) {
          await assert.rejects(
            stat(
              claudeRunnerStatePath(
                tracePath,
                join(projectRoot, ".barbaro"),
              ),
            ),
            { code: "ENOENT" },
          );
          await assert.rejects(
            stat(join(projectRoot, ".barbaro", "feed", "claude")),
            { code: "ENOENT" },
          );
          appended = true;
          await appendFile(tracePath, `${rows.slice(2).join("\n")}\n`, "utf8");
        }
      },
    },
  );

  assert.equal(clock, 50, "the prior double-space response must not attest");
  assert.equal(stopped.ingested?.input.stop_turn_visible, true);
  assert.equal(stopped.ingested?.output.turns_appended, 2);
  const feed = await readJsonl<BarbaroTurnV1>(
    join(
      projectRoot,
      ".barbaro",
      "feed",
      "claude",
      `${stopped.ingested!.session_id}.jsonl`,
    ),
  );
  assert.deepEqual(
    feed.map((turn) => turn.response?.text),
    [
      "CHECKPOINT 3  APPROVED — replayed after flush.",
      "CHECKPOINT 3 APPROVED\n — replayed after flush.",
    ],
  );
});

test("Stop records an honest timeout without publishing or checkpointing", async () => {
  const { projectRoot, tracePath } = await stageScenario(
    "stop-read-race",
    STOP_READ_RACE,
  );
  const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
  await writeFile(tracePath, `${rows.slice(0, 4).join("\n")}\n`, "utf8");
  await joinClaudeSession(projectRoot, STOP_READ_RACE);
  const prior = await runClaudeTrace({
    tracePath,
    projectRoot,
    final: true,
    sourceFinal: true,
  });
  await appendFile(tracePath, `${rows.slice(4, 6).join("\n")}\n`, "utf8");
  let clock = 0;
  const sleeps: number[] = [];

  const stopped = await handleClaudeIngestHook(
    {
      hook_event_name: "Stop",
      session_id: STOP_READ_RACE,
      cwd: projectRoot,
      transcript_path: tracePath,
      last_assistant_message:
        "CHECKPOINT 3 APPROVED — replayed after flush.",
    },
    {
      now: () => clock,
      pollIntervalMs: 50,
      timeoutMs: 100,
      trailingTimeoutMs: 10_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    },
  );

  assert.deepEqual(sleeps, [50, 50], "identity uses the single main deadline");
  assert.match(stopped.ignored ?? "", /Stop turn not visible/u);
  assert.equal(stopped.ingested?.input.stop_turn_visible, false);
  assert.equal(stopped.ingested?.output.turns_appended, 0);
  assert.deepEqual(
    stopped.ingested?.observation.checkpoint_after,
    prior.observation.checkpoint_after,
  );
  const feed = await readJsonl<BarbaroTurnV1>(
    join(
      projectRoot,
      ".barbaro",
      "feed",
      "claude",
      `${prior.session_id}.jsonl`,
    ),
  );
  assert.equal(feed.length, 1);

  const journal = JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".barbaro",
        "logs",
        "ingest",
        "claude",
        `${prior.session_id}.json`,
      ),
      "utf8",
    ),
  ) as BarbaroIngestAttemptJournalV2;
  const attempt = journal.attempts.at(-1);
  assert.ok(attempt);
  assert.equal(attempt.outcome, "stop_turn_not_visible");
  assert.equal(attempt.turns_appended, 0);
  assert.equal(attempt.withheld_reason, "stop_turn_not_visible");
  assert.equal(attempt.publish_blocker, "stop_turn_not_visible");
  assert.equal(attempt.observations.size_transitions.length, 1);
});

test("Stop without a message uses structural visibility without an identity wait", async () => {
  for (const lastAssistantMessage of [undefined, "", " \n "] as const) {
    const { projectRoot, tracePath } = await stageScenario(
      "stop-read-race",
      STOP_READ_RACE,
    );
    const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
    await writeFile(tracePath, `${rows.slice(0, 2).join("\n")}\n`, "utf8");
    await joinClaudeSession(projectRoot, STOP_READ_RACE);

    const stopped = await handleClaudeIngestHook(
      {
        hook_event_name: "Stop",
        session_id: STOP_READ_RACE,
        cwd: projectRoot,
        transcript_path: tracePath,
        ...(lastAssistantMessage === undefined
          ? {}
          : { last_assistant_message: lastAssistantMessage }),
      },
      {
        now: () => 0,
        trailingTimeoutMs: 0,
        sleep: async () => assert.fail("structural visibility must not wait for identity"),
      },
    );
    assert.match(stopped.ignored ?? "", /terminal closing record not visible/u);
    assert.equal(stopped.ingested?.input.stop_turn_identity_required, false);
    assert.equal(stopped.ingested?.input.stop_turn_visible, true);
    assert.equal(stopped.ingested?.output.turns_appended, 0);
    const journal = JSON.parse(
      await readFile(
        join(
          projectRoot,
          ".barbaro",
          "logs",
          "ingest",
          "claude",
          `${stopped.ingested!.session_id}.json`,
        ),
        "utf8",
      ),
    ) as BarbaroIngestAttemptJournalV2;
    assert.equal(journal.attempts.at(-1)?.outcome, "ok");
    assert.equal(
      journal.attempts.at(-1)?.trigger?.last_assistant_message,
      undefined,
    );
  }
});

test("Stop without a message reports a structural miss without polling", async () => {
  for (const lastAssistantMessage of [undefined, "", " \n "] as const) {
    const { projectRoot, tracePath } = await stageScenario(
      "stop-read-race",
      STOP_READ_RACE,
    );
    const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
    await writeFile(tracePath, `${rows.slice(0, 5).join("\n")}\n`, "utf8");
    await joinClaudeSession(projectRoot, STOP_READ_RACE);
    const stopped = await handleClaudeIngestHook(
      {
        hook_event_name: "Stop",
        session_id: STOP_READ_RACE,
        cwd: projectRoot,
        transcript_path: tracePath,
        ...(lastAssistantMessage === undefined
          ? {}
          : { last_assistant_message: lastAssistantMessage }),
      },
      {
        now: () => 0,
        sleep: async () => assert.fail("an unidentified Stop must not poll"),
      },
    );
    assert.match(stopped.ignored ?? "", /Stop turn not visible/u);
    assert.equal(stopped.ingested?.input.stop_turn_visible, false);
    assert.equal(stopped.ingested?.output.turns_appended, 0);
    await assert.rejects(
      stat(
        claudeRunnerStatePath(tracePath, join(projectRoot, ".barbaro")),
      ),
      { code: "ENOENT" },
    );
    const journal = JSON.parse(
      await readFile(
        join(
          projectRoot,
          ".barbaro",
          "logs",
          "ingest",
          "claude",
          `${stopped.ingested!.session_id}.json`,
        ),
        "utf8",
      ),
    ) as BarbaroIngestAttemptJournalV2;
    assert.equal(journal.attempts.at(-1)?.outcome, "stop_turn_not_visible");
  }
});

test("non-Stop events ignore last_assistant_message identity", async () => {
  for (const event of [
    "StopFailure",
    "SubagentStop",
    "SessionEnd",
  ] as const) {
    const { projectRoot, tracePath } = await stageScenario(
      "stop-read-race",
      STOP_READ_RACE,
    );
    const rows = (await readFile(tracePath, "utf8")).trimEnd().split("\n");
    await writeFile(tracePath, `${rows.slice(0, 2).join("\n")}\n`, "utf8");
    await joinClaudeSession(projectRoot, STOP_READ_RACE);
    const result = await handleClaudeIngestHook(
      {
        hook_event_name: event,
        session_id: STOP_READ_RACE,
        cwd: projectRoot,
        transcript_path: tracePath,
        last_assistant_message: "a deliberately different response",
      },
      {
        now: () => 0,
        trailingTimeoutMs: 0,
        sleep: async () => assert.fail("non-Stop identity must not poll"),
      },
    );
    assert.equal(result.ignored, event === "StopFailure" ? "terminal closing record not visible before the ingest deadline" : undefined, event);
    assert.equal(result.ingested?.input.stop_turn_visible, undefined, event);
  }
});
