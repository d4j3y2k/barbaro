import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import type {
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../../src/contracts/v1.js";
import { readJsonlForward } from "../../../src/core/jsonl-reader.js";
import { ClaudeTurnNormalizer } from "../../../src/providers/claude/index.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "claude");
const WORKSPACE = "/tmp/demo-workspace";

interface Run {
  readonly turns: BarbaroTurnV1[];
  readonly evidence: BarbaroEvidenceV1[];
  readonly diagnostics: ReturnType<ClaudeTurnNormalizer["diagnostics"]>;
}

async function runFixture(
  scenario: string,
  sessionId: string,
  options: { actorId?: string; finish?: boolean; relativePath?: string } = {},
): Promise<Run> {
  const tracePath =
    options.relativePath ??
    join(FIXTURES, scenario, "projects", "-tmp-demo-workspace", `${sessionId}.jsonl`);
  const normalizer = new ClaudeTurnNormalizer({
    nativeSessionId: sessionId,
    actorId: options.actorId ?? "main",
    workspaceRoot: WORKSPACE,
  });
  const turns: BarbaroTurnV1[] = [];
  const evidence: BarbaroEvidenceV1[] = [];
  await readJsonlForward(tracePath, (event) => {
    if (event.kind === "malformed") return;
    const batch = normalizer.accept(event.value, {
      traceId: `claude:${sessionId}`,
      lineNumber: event.lineNumber,
      byteStart: event.byteStart,
      byteEndExclusive: event.byteEndExclusive,
    });
    turns.push(...batch.turns);
    evidence.push(...batch.evidence);
  });
  if (options.finish !== false) {
    const tail = normalizer.finish();
    turns.push(...tail.turns);
    evidence.push(...tail.evidence);
  }
  return { turns, evidence, diagnostics: normalizer.diagnostics() };
}

function runCanonicalBashCommands(commands: readonly string[]): Run {
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const normalizer = new ClaudeTurnNormalizer({
    nativeSessionId: sessionId,
    actorId: "main",
    workspaceRoot: WORKSPACE,
  });
  const turns: BarbaroTurnV1[] = [];
  const evidence: BarbaroEvidenceV1[] = [];
  let sequence = 0;
  let parentUuid: string | null = null;

  const accept = (record: Readonly<Record<string, unknown>>): void => {
    sequence += 1;
    const uuid = `d0000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
    const batch = normalizer.accept(
      {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: WORKSPACE,
        sessionId,
        version: "2.1.233",
        gitBranch: "main",
        entrypoint: "cli",
        timestamp: `2026-08-16T12:00:${sequence.toString().padStart(2, "0")}.000Z`,
        ...record,
        uuid,
      },
      {
        traceId: `claude:${sessionId}`,
        lineNumber: sequence,
      },
    );
    turns.push(...batch.turns);
    evidence.push(...batch.evidence);
    parentUuid = uuid;
  };

  accept({
    type: "user",
    promptId: "p-digest-exclusion",
    promptSource: "typed",
    origin: { kind: "human" },
    permissionMode: "default",
    message: {
      role: "user",
      content: [{ type: "text", text: "Wait for a peer, then continue." }],
    },
  });

  commands.forEach((command, index) => {
    const toolUseId = `toolu_digest_${index}`;
    accept({
      type: "assistant",
      requestId: `req_digest_${index}`,
      effort: "medium",
      message: {
        id: `msg_digest_${index}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Bash",
            input: { command },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
      },
    });
    accept({
      type: "user",
      promptId: "p-digest-exclusion",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: toolUseId,
            type: "tool_result",
            content: "",
            is_error: false,
          },
        ],
      },
      toolUseResult: {
        stdout: "",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    });
  });

  accept({
    type: "assistant",
    requestId: "req_digest_done",
    effort: "medium",
    message: {
      id: "msg_digest_done",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      stop_sequence: null,
    },
  });

  const tail = normalizer.finish();
  turns.push(...tail.turns);
  evidence.push(...tail.evidence);
  return { turns, evidence, diagnostics: normalizer.diagnostics() };
}


/** Replay only the first `lines` records, as an ingest firing at Stop sees. */
async function runPrefix(sessionId: string, lines: number): Promise<Run> {
  const tracePath = join(
    FIXTURES,
    "background-continuation",
    "projects",
    "-tmp-demo-workspace",
    `${sessionId}.jsonl`,
  );
  const normalizer = new ClaudeTurnNormalizer({
    nativeSessionId: sessionId,
    actorId: "main",
    workspaceRoot: WORKSPACE,
  });
  const turns: BarbaroTurnV1[] = [];
  const evidence: BarbaroEvidenceV1[] = [];
  await readJsonlForward(tracePath, (event) => {
    if (event.kind === "malformed") return;
    if (event.lineNumber > lines) return;
    const batch = normalizer.accept(event.value, {
      traceId: `claude:${sessionId}`,
      lineNumber: event.lineNumber,
      byteStart: event.byteStart,
      byteEndExclusive: event.byteEndExclusive,
    });
    turns.push(...batch.turns);
    evidence.push(...batch.evidence);
  });
  const tail = normalizer.finish();
  turns.push(...tail.turns);
  evidence.push(...tail.evidence);
  return { turns, evidence, diagnostics: normalizer.diagnostics() };
}

const MISSING_ORIGIN = "11111111-1111-4111-8111-111111111111";
const FAILED_LOOP = "22222222-2222-4222-8222-222222222222";
const SUBAGENT = "33333333-3333-4333-8333-333333333333";
const COMPACTION = "44444444-4444-4444-8444-444444444444";
const WAKE_TURN = "88888888-8888-4888-8888-888888888888";
const BACKGROUND_CONTINUATION = "99999999-9999-4999-8999-999999999999";

test("the structural fallback recovers human prompts that carry no origin", async () => {
  const run = await runFixture("missing-origin", MISSING_ORIGIN);

  // Two human turns: one via origin.kind, one via the structural fallback.
  // Without the fallback this session would yield only one.
  assert.equal(run.turns.length, 2);
  assert.equal(run.diagnostics.human_turns_from_origin, 1);
  assert.equal(run.diagnostics.human_turns_from_structure, 1);

  const [first, second] = run.turns;
  assert.ok(first && second);
  assert.equal(first.request.text, "Add a health check endpoint.");
  assert.equal(
    (first.extensions?.claude as { turn_start: { method: string } }).turn_start
      .method,
    "origin",
  );
  // A bare-string message.content still parses.
  assert.equal(second.request.text, "Now document it in the README.");
  assert.equal(
    (second.extensions?.claude as { turn_start: { method: string } }).turn_start
      .method,
    "structural",
  );
});

test("sdk prompts and unstructured task notifications never start a turn", async () => {
  const run = await runFixture("missing-origin", MISSING_ORIGIN);
  assert.equal(run.diagnostics.skipped_sdk_prompts, 1);
  assert.equal(run.diagnostics.skipped_task_notifications, 1);
  for (const turn of run.turns) {
    assert.notEqual(turn.request.text, "Reply with exactly: ok");
    assert.notEqual(turn.request.text, "Background task bg_17 finished.");
  }
});

test("a watcher wake opens a turn of its own", async () => {
  const run = await runFixture("wake-turn", WAKE_TURN);

  // The fixture carries the real shape: a <task-id> and nothing naming the
  // issuing call, arriving after the turn that armed the watcher closed.
  // Before this, that span was suppressed and every wake went unpublished.
  assert.equal(run.turns.length, 2);
  assert.equal(run.diagnostics.task_notification_turns, 1);
  assert.equal(run.diagnostics.human_turns_from_origin, 1);

  const wake = run.turns[1];
  assert.ok(wake);
  assert.equal(
    (wake.extensions?.claude as { turn_start: { method: string } }).turn_start
      .method,
    "task-notification",
  );
  // Provenance is recorded, never claimed as a human request.
  assert.match(wake.request.text, /task-notification/u);
  assert.equal(wake.response?.text, "Peer published a new turn; relaying it.");
  assert.deepEqual(
    run.turns.map((turn) => turn.sequence),
    [1, 2],
  );
});

test("a turn is not published while background work can still extend it", async () => {
  // The exact sequence that corrupted two sessions: Stop reaches a terminal
  // record while a run_in_background command is still outstanding, the turn is
  // published, then the background task reports back naming the call this
  // session issued and CONTINUES that same turn. The turn grows after it was
  // declared canonical, so the stable ID now has two different contents.
  //
  // Publishing must wait until every known continuation source has closed.
  const atStop = await runPrefix(BACKGROUND_CONTINUATION, 4);
  const complete = await runFixture("background-continuation", BACKGROUND_CONTINUATION);

  const published = atStop.turns[0];
  const final = complete.turns[0];
  assert.ok(final, "the completed run must publish the turn");

  if (published !== undefined) {
    assert.equal(
      JSON.stringify(published),
      JSON.stringify(final),
      "a turn published at Stop must equal the same turn once background work lands",
    );
  }
});

test("prose about a background task is not a structured wake", async () => {
  // The discriminator is the `<task-id>` element, not the words. Free text
  // mentioning a background task stays foreign and still barriers.
  const run = await runFixture("missing-origin", MISSING_ORIGIN);
  assert.equal(run.diagnostics.task_notification_turns, 0);
  assert.equal(run.diagnostics.skipped_task_notifications, 1);
});

test("sequence is monotonic from 1 across a session", async () => {
  const run = await runFixture("missing-origin", MISSING_ORIGIN);
  assert.deepEqual(
    run.turns.map((turn) => turn.sequence),
    [1, 2],
  );
});

test("usage is deduplicated by message.id, not summed across rows", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const usage = run.evidence.find((item) => item.kind === "usage");
  assert.ok(usage, "expected a usage evidence record");

  const content = usage.content as {
    output_tokens: number;
    api_responses: number;
    deduplicated_by: string;
  };
  assert.equal(content.deduplicated_by, "message.id");
  // msg_1001 spans three lines each reporting output_tokens 512. Summing rows
  // would contribute 1536 from that response alone.
  assert.equal(content.api_responses, 7);
  assert.equal(content.output_tokens, 512 + 88 + 40 + 32 + 28 + 30 + 64);
});

test("a failing shell command is `failed` and carries its real exit code", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const turn = run.turns[0];
  assert.ok(turn);

  const tests = turn.actions.filter((action) => action.kind === "test");
  assert.equal(tests.length, 2, "both npm test calls classify as test actions");
  const [failing, passing] = tests;
  assert.ok(failing && failing.kind === "test");
  assert.ok(passing && passing.kind === "test");

  // Bash failures DO surface: is_error true, a string toolUseResult, and an
  // "Exit code N" prefix. Reporting these as `unknown` discarded a real signal.
  assert.equal(failing.outcome, "failed");
  assert.equal(failing.exit_code, 1);
  assert.ok(failing.failure_excerpt);
  assert.ok(failing.failure_excerpt.text.includes("expected 4, received 5"));
  // The status line is consumed, not duplicated into the excerpt.
  assert.ok(!failing.failure_excerpt.text.startsWith("Exit code"));

  // A command that merely returned output still cannot be proven to have
  // succeeded: no "Exit code 0" is ever recorded.
  assert.equal(passing.outcome, "unknown");
  assert.ok(!("exit_code" in passing));
});

test("digest excludes only whole simple barbaro await and context Bash commands", () => {
  const excluded = [
    "barbaro await --provider claude --timeout-ms 120000",
    '  barbaro context --provider claude --project-root "$PWD"  ',
  ];
  const preserved = [
    "barbaro await; echo done",
    "barbaro context && echo done",
    "barbaro await || true",
    "barbaro context | jq .",
    "barbaro await > /tmp/result",
    "barbaro context\npwd",
    "barbaro await $(whoami)",
    "node dist/src/cli.js await --timeout-ms 120000",
  ];
  const run = runCanonicalBashCommands([...excluded, ...preserved]);
  const turn = run.turns[0];
  assert.ok(turn);

  assert.equal(run.diagnostics.barbaro_self_actions_dropped, excluded.length);
  assert.deepEqual(
    turn.actions.map((action) =>
      action.kind === "command" || action.kind === "test"
        ? action.command.text
        : undefined,
    ),
    preserved,
  );
});

test("exit-code parsing is anchored and cannot be fooled by prose", async () => {
  const { parseExitCode } = await import(
    "../../../src/providers/claude/normalizer.js"
  );
  assert.deepEqual(parseExitCode("Exit code 1\nboom"), { code: 1, rest: "boom" });
  assert.deepEqual(parseExitCode("Exit code 143"), { code: 143, rest: "" });
  assert.equal(parseExitCode("the build failed with Exit code 1"), undefined);
  assert.equal(parseExitCode("<tool_use_error>File has not been read yet.</tool_use_error>"), undefined);
  assert.equal(parseExitCode(undefined), undefined);
});

test("denial and interruption are the failure signals that do survive", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const turn = run.turns[0];
  assert.ok(turn);

  const outcomes = turn.actions.map((action) => action.outcome);
  assert.ok(outcomes.includes("denied"), "toolDenialKind maps to denied");
  assert.ok(
    outcomes.includes("interrupted"),
    "toolUseResult.interrupted maps to interrupted",
  );
  // A denied action downgrades a terminal turn from success to partial.
  assert.equal(turn.outcome, "partial");
});

test("file changes carry patch line counts and a workspace-relative path", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const turn = run.turns[0];
  assert.ok(turn);

  const changes = turn.actions.filter((action) => action.kind === "file_change");
  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.ok(change && change.kind === "file_change");
  assert.equal(change.path, "src/sum.ts");
  assert.equal(change.operation, "modify");
  assert.equal(change.added_lines, 1);
  assert.equal(change.removed_lines, 1);
});

test("an out-of-workspace edit is preserved as `other`, not silently dropped", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const turn = run.turns[0];
  assert.ok(turn);

  assert.equal(run.diagnostics.external_path_actions, 1);
  const external = turn.actions.find(
    (action) => action.kind === "other" && action.summary.text.includes("outside workspace"),
  );
  assert.ok(external, "expected an `other` action for the ~/.claude edit");
  assert.ok(external.kind === "other");
  // Constant string: no absolute path, no basename, and original_utf8_bytes
  // measures the emitted text so the discarded path length cannot be inferred.
  assert.equal(external.summary.text, "file change outside workspace");
  assert.ok(!external.summary.text.includes("/Users/"));
  assert.ok(!external.summary.text.includes("MEMORY"));
  assert.equal(
    external.summary.original_utf8_bytes,
    Buffer.byteLength("file change outside workspace", "utf8"),
  );
});

test("thinking blocks and file bodies never reach any output", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const serialized = JSON.stringify({
    turns: run.turns,
    evidence: run.evidence,
  });
  assert.ok(!serialized.includes("REDACTED-THINKING-CONTENT"));
  assert.ok(!serialized.includes("REDACTED-SIGNATURE"));
  assert.ok(!serialized.includes("REDACTED-FILE-BODY"));
});

test("the terminal assistant text becomes the response; earlier text is evidence", async () => {
  const run = await runFixture("failed-tool-loop", FAILED_LOOP);
  const turn = run.turns[0];
  assert.ok(turn);
  assert.ok(turn.response?.text.startsWith("Fixed the off-by-one"));

  const priorResponses = run.evidence.filter((item) => item.kind === "response");
  assert.equal(priorResponses.length, 1);
  assert.deepEqual(
    (priorResponses[0]?.content as { text: { text: string } }).text.text,
    "Running the suite first to see the failures.",
  );
});

test("compaction is evidence, not a turn boundary", async () => {
  const run = await runFixture("compaction-forks", COMPACTION);
  assert.equal(run.diagnostics.compact_boundaries, 1);

  const boundary = run.evidence.find(
    (item) =>
      item.kind === "provider_event" &&
      (item.content as { event?: string }).event === "compact_boundary",
  );
  assert.ok(boundary, "expected a compact_boundary provider_event");
  const content = boundary.content as { cumulative_dropped_tokens: number };
  assert.equal(content.cumulative_dropped_tokens, 174440);

  // Four human prompts, so four turns; the boundary splits none of them.
  assert.equal(run.turns.length, 4);
});

test("forks are observed and counted", async () => {
  const run = await runFixture("compaction-forks", COMPACTION);
  // …0002 has two children: the abandoned branch and the rewound one.
  assert.equal(run.diagnostics.forks_observed, 1);
});

test("subagent tool results register a parent link keyed by agentId", async () => {
  const sessionPath = join(
    FIXTURES,
    "subagent-join",
    "projects",
    "-tmp-demo-workspace",
    `${SUBAGENT}.jsonl`,
  );
  const normalizer = new ClaudeTurnNormalizer({
    nativeSessionId: SUBAGENT,
    actorId: "main",
    workspaceRoot: WORKSPACE,
  });
  await readJsonlForward(sessionPath, (event) => {
    if (event.kind === "malformed") return;
    normalizer.accept(event.value, {
      traceId: `claude:${SUBAGENT}`,
      lineNumber: event.lineNumber,
    });
  });

  const links = normalizer.agentLinks();
  // The direct subagent resolves through the Agent tool result…
  const direct = links.get("a1111111111111111");
  assert.ok(direct, "direct subagent must resolve via toolUseResult.agentId");
  assert.equal(direct.role, "Explore");
  assert.equal(direct.toolUseId, "toolu_S1");

  // …while the workflow agent has no Agent call in the parent at all.
  assert.equal(
    links.get("a2222222222222222"),
    undefined,
    "workflow agents are not discoverable from the parent's Agent tool results",
  );
});

test("subagent rollup appears on the parent turn", async () => {
  const run = await runFixture("subagent-join", SUBAGENT);
  const turn = run.turns[0];
  assert.ok(turn);
  assert.equal(turn.subagents.total, 1);
  assert.deepEqual(turn.subagents.by_role, [{ role: "Explore", count: 1 }]);
  // The Agent tool call is a subagent, not an action.
  assert.ok(!turn.actions.some((action) => action.kind === "tool" && action.tool_name === "Agent"));
});

test("re-running the normalizer is byte-identical (deterministic IDs)", async () => {
  const first = await runFixture("failed-tool-loop", FAILED_LOOP);
  const second = await runFixture("failed-tool-loop", FAILED_LOOP);
  assert.deepEqual(second.turns, first.turns);
  assert.deepEqual(second.evidence, first.evidence);
});

test("every emitted record satisfies the frozen structural invariants", async () => {
  for (const [scenario, sessionId] of [
    ["missing-origin", MISSING_ORIGIN],
    ["failed-tool-loop", FAILED_LOOP],
    ["subagent-join", SUBAGENT],
    ["compaction-forks", COMPACTION],
  ] as const) {
    const run = await runFixture(scenario, sessionId);
    for (const turn of run.turns) {
      assert.equal(turn.schema, "barbaro.turn.v1");
      assert.match(turn.turn_id, /^turn_[0-9a-f]{32}$/);
      assert.match(turn.session_id, /^ses_[0-9a-f]{32}$/);
      assert.equal(turn.provider, "claude");
      assert.ok(turn.sequence >= 1);
      assert.ok(turn.source_refs.length >= 1);
      for (const action of turn.actions) {
        assert.match(action.action_id, /^act_[0-9a-f]{32}$/);
        assert.ok(action.source_refs.length >= 1);
        if (action.kind === "file_change") {
          assert.ok(!action.path.startsWith("/"), `${scenario}: absolute path`);
          assert.ok(!action.path.includes(".."), `${scenario}: parent escape`);
        }
      }
      for (const ref of turn.evidence_refs) {
        assert.match(ref, /^ev_[0-9a-f]{32}$/);
      }
    }
    for (const item of run.evidence) {
      assert.equal(item.schema, "barbaro.evidence.v1");
      assert.match(item.evidence_id, /^ev_[0-9a-f]{32}$/);
      assert.match(item.turn_id, /^turn_[0-9a-f]{32}$/);
    }
  }
});

const TERMINAL_SPLIT = "55555555-5555-4555-8555-555555555555";

test("end_turn on the first line of a response does not truncate the turn", async () => {
  // Regression: stop_reason repeats on every line of one API response. The
  // thinking block carries end_turn, and the text block follows it. Closing
  // on the first occurrence silently discarded the response — real traces hit
  // this on the majority of turns.
  const run = await runFixture("terminal-split", TERMINAL_SPLIT);
  assert.equal(run.turns.length, 1);
  const turn = run.turns[0];
  assert.ok(turn);
  assert.equal(
    turn.response?.text,
    "The writer now partitions output per session, so no lock is needed.",
  );
  assert.equal(turn.outcome, "success");

  // The two lines share one message.id, so usage counts once.
  const usage = run.evidence.find((item) => item.kind === "usage");
  assert.ok(usage);
  const content = usage.content as { output_tokens: number; api_responses: number };
  assert.equal(content.api_responses, 1);
  assert.equal(content.output_tokens, 220);
});

test("an unterminated turn is withheld rather than published as abandoned", async () => {
  // finish() without includeIncomplete leaves an in-progress turn open so a
  // live tail never publishes a digest a later run would contradict.
  const run = await runFixture("terminal-split", TERMINAL_SPLIT, {
    finish: false,
  });
  assert.equal(run.turns.length, 0);
});

const REVERSE_RESULTS = "66666666-6666-4666-8666-666666666666";
const ASYNC_CHILD = "77777777-7777-4777-8777-777777777777";

test("tool results pair by id even when they return out of order", async () => {
  // Parallel tool calls complete in whatever order they finish. Pairing must
  // key on tool_use_id, never on adjacency or arrival order.
  const run = await runFixture("reverse-tool-results", REVERSE_RESULTS);
  const turn = run.turns[0];
  assert.ok(turn);

  const changes = turn.actions.filter((a) => a.kind === "file_change");
  assert.equal(changes.length, 2);
  assert.equal(run.diagnostics.unpaired_tool_uses, 0);

  // Actions stay in source (tool_use) order, not result-arrival order.
  const [first, second] = changes;
  assert.ok(first?.kind === "file_change" && second?.kind === "file_change");
  assert.equal(first.path, "src/one.ts");
  assert.equal(second.path, "src/two.ts");

  // Each action carries ITS OWN result, not the one that arrived next.
  assert.equal(first.added_lines, 2, "one.ts patch adds two lines");
  assert.equal(first.removed_lines, 1);
  assert.equal(second.added_lines, 1, "two.ts patch adds one line");
  assert.equal(second.removed_lines, 1);
});

test("a replacement branch carries supersedes_turn_ids forward", async () => {
  // Sequence stays source append order and nothing already emitted is
  // rewritten; the rewound branch records the edge instead.
  const run = await runFixture("compaction-forks", COMPACTION);
  assert.deepEqual(run.turns.map((t) => t.sequence), [1, 2, 3, 4]);

  const abandoned = run.turns[1];
  const replacement = run.turns[2];
  assert.ok(abandoned && replacement);
  assert.equal(abandoned.request.text, "Also rename it in the docs.");
  assert.equal(replacement.request.text, "Actually call it openConfig instead.");

  const supersedes = (replacement.extensions?.claude as {
    supersedes_turn_ids?: string[];
  }).supersedes_turn_ids;
  assert.deepEqual(supersedes, [abandoned.turn_id]);

  // Turns that did not replace anything carry no supersession metadata.
  for (const turn of [run.turns[0], run.turns[3]]) {
    assert.ok(turn);
    assert.equal(
      (turn.extensions?.claude as { supersedes_turn_ids?: string[] })
        .supersedes_turn_ids,
      undefined,
    );
  }
});

test("an open turn never consumes a sequence number", async () => {
  // Resume checkpoints at turn boundaries. If opening a turn burned a
  // sequence value, a resumed run would renumber that same turn.
  const run = await runFixture("terminal-split", TERMINAL_SPLIT, {
    finish: false,
  });
  assert.equal(run.turns.length, 0);

  const complete = await runFixture("terminal-split", TERMINAL_SPLIT);
  assert.equal(complete.turns[0]?.sequence, 1);
});

test("machine-driven input is a barrier: its span is suppressed, not annexed", async () => {
  // Regression with teeth. Before this, the sdk and task-notification spans
  // that follow the last human turn were absorbed into it: the turn's
  // ended_at ran to 10:03:05 (the reply to the task notification) instead of
  // 10:01:07 (its own response). A golden alone had blessed that lineage.
  const run = await runFixture("missing-origin", MISSING_ORIGIN);
  assert.equal(run.turns.length, 2);

  const second = run.turns[1];
  assert.ok(second);
  assert.equal(second.request.text, "Now document it in the README.");
  assert.equal(second.ended_at, "2026-08-16T10:01:07.000Z");
  assert.equal(second.response?.text, "Documented the endpoint in README.md.");

  // The assistant replies to the sdk and task-notification prompts appear in
  // no turn at all.
  const responses = run.turns.map((turn) => turn.response?.text);
  assert.ok(!responses.includes("ok"), "the sdk reply is not any turn's response");
  const everything = JSON.stringify({ turns: run.turns, evidence: run.evidence });
  assert.ok(!everything.includes("Noted the background task result"));
  assert.ok(!everything.includes("Reply with exactly"));
  assert.ok(!everything.includes("Background task bg_17"));

  // Both foreign prompts act as barriers: the sdk prompt closes turn 2, and
  // the task notification that follows names no tool_use of ours.
  assert.equal(run.diagnostics.segmentation_barriers, 2);
  assert.equal(run.diagnostics.async_continuations, 0);
  assert.equal(run.diagnostics.skipped_sdk_prompts, 1);
  assert.equal(run.diagnostics.skipped_task_notifications, 1);
});

test("a notification for our own async child continues the turn that launched it", async () => {
  // The opposite of the barrier case, and the one that matters at scale: in
  // async sessions most work happens in spans that follow a child reporting
  // back. One real trace has a single human prompt and four workflows; a
  // blanket barrier discarded three of them and 19 subagents.
  const run = await runFixture("async-child", ASYNC_CHILD);
  assert.equal(run.diagnostics.async_continuations, 1);
  assert.equal(run.diagnostics.segmentation_barriers, 0);

  // The launching turn is intact, with its Agent call recorded.
  assert.equal(run.turns.length, 1);
  const turn = run.turns[0];
  assert.ok(turn);
  assert.equal(turn.request.text, "Audit the config loader.");
  assert.equal(turn.subagents.total, 1);
});

test("an unrecognized promptSource is a barrier, never assumed human", async () => {
  const { classifyUserRecord, decodeClaudeEnvelope, decodeClaudeMessage } =
    await import("../../../src/providers/claude/records.js");
  const build = (extra: Record<string, unknown>) => {
    const raw = {
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      ...extra,
    };
    const decoded = decodeClaudeEnvelope(raw);
    assert.ok(decoded.ok);
    return classifyUserRecord(decoded.envelope, decodeClaudeMessage(raw));
  };

  assert.equal(build({ promptSource: "typed" }).kind, "human");
  assert.equal(build({ promptSource: "queued" }).kind, "human");
  // No provenance at all still falls back to human — that path recovers 17%
  // of real turns and must not be broken by the stricter rule.
  assert.equal(build({}).kind, "human");
  // But a source we do not recognize is not evidence of a person.
  assert.equal(build({ promptSource: "automation_v9" }).kind, "unknown-provenance");
  assert.equal(build({ promptSource: "sdk" }).kind, "sdk");
});

const TURN_DURATION_CLOSE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BACKGROUND_DURATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const QUEUED_BACKGROUND_COMPLETION = "fefefefe-fefe-4efe-8efe-fefefefefefe";

/**
 * Like runFixture, but keeps what the stream emitted apart from what
 * finish() flushed, optionally stopping after `lines` rows.
 */
async function runStream(
  scenario: string,
  sessionId: string,
  lines = Number.POSITIVE_INFINITY,
): Promise<{
  streamed: BarbaroTurnV1[];
  tail: BarbaroTurnV1[];
  evidence: BarbaroEvidenceV1[];
}> {
  const tracePath = join(
    FIXTURES,
    scenario,
    "projects",
    "-tmp-demo-workspace",
    `${sessionId}.jsonl`,
  );
  const normalizer = new ClaudeTurnNormalizer({
    nativeSessionId: sessionId,
    actorId: "main",
    workspaceRoot: WORKSPACE,
  });
  const streamed: BarbaroTurnV1[] = [];
  const evidence: BarbaroEvidenceV1[] = [];
  await readJsonlForward(tracePath, (event) => {
    if (event.kind === "malformed") return;
    if (event.lineNumber > lines) return;
    const batch = normalizer.accept(event.value, {
      traceId: `claude:${sessionId}`,
      lineNumber: event.lineNumber,
      byteStart: event.byteStart,
      byteEndExclusive: event.byteEndExclusive,
    });
    streamed.push(...batch.turns);
    evidence.push(...batch.evidence);
  });
  const flushed = normalizer.finish();
  evidence.push(...flushed.evidence);
  return { streamed, tail: [...flushed.turns], evidence };
}

test("a terminal turn closes at its turn_duration record, in the stream", async () => {
  // Claude writes `turn_duration` after the stop hooks, after every row of the
  // final response. With no background launch outstanding the turn cannot
  // grow past it, so it closes there — not at the next prompt, and not only
  // when finish() is told the source is final.
  const run = await runStream("turn-duration-close", TURN_DURATION_CLOSE);
  assert.equal(run.streamed.length, 1, "closed while streaming");
  assert.equal(run.tail.length, 0, "nothing left for finish() to flush");
  const turn = run.streamed[0]!;
  assert.equal(turn.sequence, 1);
  assert.equal(turn.outcome, "success");
  assert.equal(turn.response?.text, "PLAN APPROVED — the phases are sound.");
  assert.equal(turn.ended_at, "2026-08-16T16:00:10.000Z");
});

test("turn_duration does not close a turn whose background launch can still report back", async () => {
  // The first end-turn is followed by turn_duration while `tail -f` is still
  // outstanding: the turn must stay open, because the report continues it.
  const beforeReport = await runStream("background-duration", BACKGROUND_DURATION, 6);
  assert.equal(beforeReport.streamed.length, 0);
  assert.equal(beforeReport.tail.length, 0, "finish() still refuses: the launch is live");

  // Once the report lands and the continuation reaches its own turn_duration,
  // the turn closes in the stream — and its digest keeps BOTH responses the
  // human read, not only the last one.
  const complete = await runStream("background-duration", BACKGROUND_DURATION);
  assert.equal(complete.streamed.length, 1);
  assert.equal(complete.tail.length, 0);
  const turn = complete.streamed[0]!;
  assert.equal(
    turn.response?.text,
    "Watcher armed.\n\nHandled the watcher output.",
  );
  assert.equal(turn.ended_at, "2026-08-16T16:02:10.000Z");
  assert.equal(turn.actions.length, 2);
  // The earlier response is still evidence too, as before.
  assert.equal(
    complete.evidence.filter((item) => item.kind === "response").length,
    1,
  );
});

test("an on-branch queued-command completion closes its background turn in-stream", async () => {
  // Sanitized from the first 331 rows of reviewer transcript 6d347ab3-…:
  // queue-operation duplicates, an off-branch completion attachment, and a
  // Monitor attachment all precede the one authoritative on-branch record.
  const run = await runStream(
    "queued-background-completion",
    QUEUED_BACKGROUND_COMPLETION,
  );
  assert.equal(run.streamed.length, 1, "turn_duration publishes this turn");
  assert.equal(run.tail.length, 0, "no pending background launch remains");
  const turn = run.streamed[0]!;
  assert.equal(turn.request.text, "Review the checkpoint.");
  assert.equal(turn.response?.text, "CHECKPOINT 1 APPROVED.");
  assert.equal(turn.actions.length, 1);
  assert.equal(turn.ended_at, "2026-08-23T22:41:22.792Z");
});
