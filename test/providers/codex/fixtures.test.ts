import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type {
  BarbaroAction,
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../../src/contracts/v1.js";
import {
  createActionId,
  createSessionId,
  createTurnId,
} from "../../../src/core/id.js";
import {
  readJsonlForward,
  type JsonlReadSummary,
} from "../../../src/core/jsonl-reader.js";
import { CodexTurnNormalizer } from "../../../src/providers/codex/index.js";

const FIXTURE_DIRECTORY = join(process.cwd(), "test", "fixtures", "codex");
const FIXTURE_NAMES = [
  "success-turn",
  "aborted-turn",
  "failed-turn",
  "tool-pairing",
  "duplicate-projections",
  "repeated-session-meta",
  "unknown-types",
  "partial-final-line",
  "security-risk-score-head",
] as const;

interface FixtureOracle {
  readonly canonical_session_meta_line: number;
  readonly canonical_native_session_id: string;
  readonly partial_final_line?: number;
  readonly noncanonical_session_meta_lines?: readonly number[];
  readonly preserved_records?: readonly {
    readonly line: number;
    readonly outer_type?: string;
    readonly nested_type?: string;
  }[];
}

interface CodexFixtureExpected {
  readonly turns: readonly BarbaroTurnV1[];
  readonly oracle: FixtureOracle;
}

interface FixtureRun {
  readonly expected: CodexFixtureExpected;
  readonly turns: readonly BarbaroTurnV1[];
  readonly evidence: readonly BarbaroEvidenceV1[];
  readonly summary: JsonlReadSummary;
  readonly diagnostics: ReturnType<CodexTurnNormalizer["diagnostics"]>;
}

/**
 * Fixture source assumptions are deliberately explicit:
 *
 * - traceId is injected from expected.turns[0].source_refs[0].trace_id;
 * - tracePath is omitted, because fixture expected records intentionally omit it;
 * - the local fixture path is only a byte source and never enters stable IDs;
 * - physical line/byte coordinates come from the shared streaming JSONL reader;
 * - an unterminated tail is not sent to the normalizer.
 */
async function runFixture(name: string): Promise<FixtureRun> {
  const expected = JSON.parse(
    await readFile(join(FIXTURE_DIRECTORY, `${name}.expected.json`), "utf8"),
  ) as CodexFixtureExpected;
  const traceId = expected.turns[0]?.source_refs[0]?.trace_id;
  assert.ok(traceId, `${name}: expected turn must supply a trace_id`);

  const normalizer = new CodexTurnNormalizer();
  const turns: BarbaroTurnV1[] = [];
  const evidence: BarbaroEvidenceV1[] = [];
  const summary = await readJsonlForward(
    join(FIXTURE_DIRECTORY, `${name}.input.jsonl`),
    (line) => {
      if (line.kind !== "record") return;
      const batch = normalizer.accept(line.value, {
        traceId,
        lineNumber: line.lineNumber,
        byteStart: line.byteStart,
        byteEndExclusive: line.byteEndExclusive,
      });
      turns.push(...batch.turns);
      evidence.push(...batch.evidence);
    },
  );

  return {
    expected,
    turns,
    evidence,
    summary,
    diagnostics: normalizer.diagnostics(),
  };
}

function coreTurnProjection(turn: BarbaroTurnV1): unknown {
  return {
    schema: turn.schema,
    turn_id: turn.turn_id,
    provider: turn.provider,
    session_id: turn.session_id,
    sequence: turn.sequence,
    agent_id: turn.agent_id,
    started_at: turn.started_at,
    ended_at: turn.ended_at,
    outcome: turn.outcome,
    request: turn.request,
    ...(turn.response === undefined ? {} : { response: turn.response }),
    subagents: turn.subagents,
    source_refs: turn.source_refs.map((source) => ({
      trace_id: source.trace_id,
      ...(source.trace_path === undefined ? {} : { trace_path: source.trace_path }),
      line_start: source.line_start,
      line_end: source.line_end,
    })),
  };
}

function actionLinePair(action: BarbaroAction): readonly number[] {
  return action.source_refs
    .map((source) => source.line_start)
    .filter((line): line is number => line !== undefined)
    .sort((left, right) => left - right);
}

test("Codex fixtures are readable and preserve core terminal-turn semantics", async (context) => {
  for (const name of FIXTURE_NAMES) {
    await context.test(name, async () => {
      const run = await runFixture(name);
      assert.equal(run.summary.malformedLines, 0);
      assert.equal(run.turns.length, run.expected.turns.length);
      assert.deepEqual(
        run.turns.map(coreTurnProjection),
        run.expected.turns.map(coreTurnProjection),
      );

      const expectedPartial = run.expected.oracle.partial_final_line;
      assert.equal(run.summary.partialFinalLine?.lineNumber, expectedPartial);
      assert.equal(
        run.expected.oracle.canonical_session_meta_line,
        1,
        "the fixture corpus keeps canonical session metadata on physical line one",
      );

      for (const turn of run.expected.turns) {
        const nativeTurnId = turn.extensions?.codex?.native_turn_id;
        assert.equal(typeof nativeTurnId, "string");
        assert.equal(
          turn.session_id,
          createSessionId("codex", run.expected.oracle.canonical_native_session_id),
        );
        assert.equal(
          turn.turn_id,
          createTurnId(
            "codex",
            run.expected.oracle.canonical_native_session_id,
            turn.agent_id,
            nativeTurnId as string,
          ),
        );
      }
    });
  }
});

test("tool-pairing fixture joins by call_id across non-adjacent reverse-order outputs", async () => {
  const run = await runFixture("tool-pairing");
  assert.equal(run.turns.length, 1);
  const actions = run.turns[0]?.actions ?? [];
  assert.equal(actions.length, 2);

  const functionAction = actions.find(
    (action) => action.kind === "tool" && action.tool_name === "read_catalog",
  );
  assert.ok(functionAction);
  assert.deepEqual(actionLinePair(functionAction), [4, 7]);

  const customAction = actions.find(
    (action) => action.kind === "command" && action.command.text === "printf ok",
  );
  assert.ok(customAction);
  assert.deepEqual(actionLinePair(customAction), [5, 6]);

  const expected = run.expected.turns[0];
  assert.ok(expected);
  assert.equal(
    expected.actions[0]?.action_id,
    createActionId(
      expected.turn_id,
      "response_item:id:fc_fixture_001",
      0,
    ),
  );
  assert.equal(
    expected.actions[1]?.action_id,
    createActionId(
      expected.turn_id,
      "response_item:id:ctc_fixture_001",
      0,
    ),
  );
});

test("drift fixtures exercise the intended diagnostics without losing the turn", async () => {
  const repeated = await runFixture("repeated-session-meta");
  assert.equal(repeated.diagnostics.repeated_session_meta, 1);

  const unknown = await runFixture("unknown-types");
  assert.deepEqual(unknown.diagnostics.unknown_root_types, {
    future_outer_record: 1,
  });
  assert.deepEqual(unknown.diagnostics.unknown_event_types, {
    future_event_msg: 1,
  });
  assert.deepEqual(unknown.diagnostics.unknown_response_types, {
    future_response_item: 1,
  });

  const head = await runFixture("security-risk-score-head");
  assert.deepEqual(head.diagnostics.unknown_root_types, {});
});

test("partial fixture leaves the unterminated bytes outside the checkpoint", async () => {
  const run = await runFixture("partial-final-line");
  assert.equal(run.summary.completeLines, 5);
  assert.equal(run.summary.parsedLines, 5);
  assert.equal(run.summary.malformedLines, 0);
  assert.deepEqual(run.summary.partialFinalLine, {
    byteStart: run.summary.checkpointOffset,
    byteLength: run.summary.observedSize - run.summary.checkpointOffset,
    lineNumber: 6,
  });
});

test(
  "strict Codex raw-to-normalized fixtures",
  async (context) => {
    for (const name of FIXTURE_NAMES) {
      await context.test(name, async () => {
        const run = await runFixture(name);
        assert.deepEqual(run.turns, run.expected.turns);
        assert.deepEqual(run.evidence, []);
      });
    }
  },
);
