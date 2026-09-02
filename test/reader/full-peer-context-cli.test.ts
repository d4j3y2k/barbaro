import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  BarbaroAction,
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";
import { stableJsonLine, stableStringify } from "../../src/core/stable-json.js";

const execFileAsync = promisify(execFile);
const BUILT_CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
const CODEX_SESSION = "ses_11111111111111111111111111111111";
const CLAUDE_SESSION = "ses_22222222222222222222222222222222";
const SOURCE_REF = { trace_id: "fixture:full-peer-context-cli" } as const;

interface Projection<Value> {
  readonly byte_budget: number;
  readonly utf8_bytes: number;
  readonly value: Value;
}

interface TurnListValue {
  readonly schema: "barbaro.reader.turn-list.v1";
  readonly complete: boolean;
  readonly range: { readonly start: number; readonly end: number };
  readonly diagnostics: {
    readonly malformed_feed_records: number;
    readonly invalid_feed_records: number;
    readonly skipped_oversized_feed_files: number;
  };
  readonly turns: {
    readonly shown: number;
    readonly total: number;
    readonly items: readonly { readonly turn_id: string }[];
    readonly next_cursor?: string;
  };
}

interface ExactPageValue {
  readonly schema: string;
  readonly field: string;
  readonly present: boolean;
  readonly text: string;
  readonly total_utf8_bytes: number;
  readonly range: { readonly start: number; readonly end: number };
  readonly sha256: string;
  readonly complete: boolean;
  readonly next_cursor?: string;
  readonly representation?: "json-string";
  readonly diagnostics?: { readonly skipped_oversized_feed_files: number };
}

interface CliFailure extends Error {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface Fixture {
  readonly project: string;
  readonly lane: string;
  readonly otherLane: string;
  readonly turns: readonly BarbaroTurnV1[];
  readonly target: BarbaroTurnV1;
  readonly subagentEvidence: BarbaroEvidenceV1;
  readonly responseEvidence: BarbaroEvidenceV1;
  readonly feedPaths: readonly string[];
  readonly evidencePath: string;
  readonly nudgeCursorPath: string;
  readonly absentNudgeCursorPath: string;
}

function identity(prefix: "turn" | "act" | "ev", seed: number): string {
  return `${prefix}_${seed.toString(16).padStart(32, "0")}`;
}

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function actions(count: number, seed = 0): BarbaroAction[] {
  return Array.from({ length: count }, (_, index) => ({
    action_id: identity("act", seed + index + 1),
    kind: "command" as const,
    outcome: "success" as const,
    command: content(`command ${index} 🚀 ${"x".repeat(180)}`),
    exit_code: 0,
    source_refs: [SOURCE_REF],
  }));
}

function turn(options: {
  readonly seed: number;
  readonly provider: "codex" | "claude";
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly sequence: number;
  readonly endedAt: string;
  readonly responseText?: string;
  readonly actionCount?: number;
  readonly evidenceRefs?: readonly string[];
}): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: identity("turn", options.seed),
    provider: options.provider,
    session_id: options.sessionId,
    workstream_id: options.workstreamId,
    sequence: options.sequence,
    agent_id: "main",
    started_at: "2026-09-01T12:00:00.000Z",
    ended_at: options.endedAt,
    outcome: "success",
    request: content(`request ${options.seed} 漢😀`),
    response: content(options.responseText ?? `response ${options.seed}`),
    actions: actions(options.actionCount ?? 0, options.seed * 1000),
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: options.evidenceRefs ?? [],
    source_refs: [SOURCE_REF],
  };
}

async function invoke(
  project: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFileAsync(
    process.execPath,
    [BUILT_CLI, ...args, "--project-root", project],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
}

async function invokeJson<Value>(
  project: string,
  args: readonly string[],
): Promise<Projection<Value>> {
  const { stdout, stderr } = await invoke(project, args);
  assert.equal(stderr, "", args.join(" "));
  assert.ok(stdout.endsWith("\n"), args.join(" "));
  const line = stdout.slice(0, -1);
  const parsed = JSON.parse(line) as Projection<Value>;
  assert.equal(stableStringify(parsed), line, args.join(" "));
  assert.equal(Buffer.byteLength(line, "utf8"), parsed.utf8_bytes);
  assert.ok(parsed.utf8_bytes <= parsed.byte_budget);
  return parsed;
}

async function invokeFailure(
  project: string,
  args: readonly string[],
): Promise<CliFailure> {
  try {
    await invoke(project, args);
  } catch (error: unknown) {
    return error as CliFailure;
  }
  assert.fail(`expected CLI failure: ${args.join(" ")}`);
}

async function createWorkstream(project: string, name: string): Promise<string> {
  const { stdout, stderr } = await invoke(project, ["workstream", "new", name]);
  assert.equal(stderr, "");
  return (JSON.parse(stdout) as { readonly workstream_id: string }).workstream_id;
}

async function appendTurn(project: string, record: BarbaroTurnV1): Promise<string> {
  const path = join(
    project,
    ".barbaro",
    "feed",
    record.provider,
    `${record.session_id}.jsonl`,
  );
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, stableJsonLine(record), "utf8");
  return path;
}

async function createFixture(project: string): Promise<Fixture> {
  const lane = await createWorkstream(project, "lane");
  const otherLane = await createWorkstream(project, "other-lane");
  const participationPath = join(
    project,
    ".barbaro",
    "sessions",
    "codex",
    `${CODEX_SESSION}.json`,
  );
  await mkdir(dirname(participationPath), { recursive: true });
  await writeFile(
    participationPath,
    stableStringify({
      schema: "barbaro.session-participation.v2",
      provider: "codex",
      session_id: CODEX_SESSION,
      joined_at: "2026-09-01T10:00:00.000Z",
      initiated_by: "user_prompt",
      workstream_id: otherLane,
      memberships: [
        { workstream_id: lane, from: "2026-09-01T10:00:00.000Z" },
        { workstream_id: otherLane, from: "2026-09-01T11:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  const subagentEvidenceId = identity("ev", 700);
  const responseEvidenceId = identity("ev", 701);
  const turns = Array.from({ length: 18 }, (_, index) =>
    turn({
      seed: index + 1,
      provider: index % 2 === 0 ? "codex" : "claude",
      sessionId: index % 2 === 0 ? CODEX_SESSION : CLAUDE_SESSION,
      workstreamId: lane,
      sequence: Math.floor(index / 2) + 1,
      endedAt: new Date(
        Date.parse("2026-09-01T12:00:00.000Z") + index * 60_000,
      ).toISOString(),
      ...(index === 5
        ? {
            responseText: "😀é漢字".repeat(1_600),
            actionCount: 90,
            evidenceRefs: [subagentEvidenceId, responseEvidenceId],
          }
        : {}),
    }),
  );
  const feedPaths = new Set<string>();
  for (const record of turns) {
    feedPaths.add(await appendTurn(project, record));
  }
  const target = turns[5]!;

  const subagentEvidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: subagentEvidenceId,
    kind: "subagent_turn",
    turn_id: identity("turn", 702),
    parent_turn_id: target.turn_id,
    parent_link: { method: "joined", native_key: "worker-1" },
    provider: "codex",
    session_id: CODEX_SESSION,
    workstream_id: lane,
    agent_id: "worker-1",
    occurred_at: "2026-09-01T12:06:30.000Z",
    source_refs: [SOURCE_REF],
    content: {
      role: "implementation",
      sequence: 1,
      outcome: "success",
      started_at: "2026-09-01T12:05:00.000Z",
      ended_at: "2026-09-01T12:06:00.000Z",
      request: content("inspect every relevant file"),
      response: content("完了😀".repeat(1_000)),
      actions: actions(24, 30_000),
    },
  };
  const responseEvidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: responseEvidenceId,
    kind: "response",
    turn_id: target.turn_id,
    provider: "codex",
    session_id: CODEX_SESSION,
    workstream_id: lane,
    agent_id: "main",
    occurred_at: "2026-09-01T12:06:40.000Z",
    source_refs: [SOURCE_REF],
    content: {
      message: "canonical response evidence 🔎é".repeat(500),
      nested: { exact: true, count: 17 },
    },
  };
  const evidencePath = join(
    project,
    ".barbaro",
    "evidence",
    "codex",
    `${CODEX_SESSION}.jsonl`,
  );
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    stableJsonLine(subagentEvidence) + stableJsonLine(responseEvidence),
    "utf8",
  );

  const nudgeCursorPath = join(
    project,
    ".barbaro",
    "state",
    "nudge",
    "codex",
    `${CODEX_SESSION}.json`,
  );
  await mkdir(dirname(nudgeCursorPath), { recursive: true });
  await writeFile(
    nudgeCursorPath,
    stableJsonLine({
      schema: "barbaro.nudge-cursor.v2",
      provider: "codex",
      session_id: CODEX_SESSION,
      workstream_id: lane,
      membership_from: "2026-09-01T11:00:00.000Z",
      cursor_revision: 7,
      feed_cursors: [],
      markers: { stop: 7 },
      delivery: {
        highest_unread_count: 11,
        last_turn: { kind: "codex", turn_id: target.turn_id },
      },
      updated_at: "2026-09-01T11:59:00.000Z",
    }),
    "utf8",
  );
  const absentNudgeCursorPath = join(
    project,
    ".barbaro",
    "state",
    "nudge",
    "claude",
    `${CLAUDE_SESSION}.json`,
  );

  return {
    project,
    lane,
    otherLane,
    turns,
    target,
    subagentEvidence,
    responseEvidence,
    feedPaths: [...feedPaths],
    evidencePath,
    nudgeCursorPath,
    absentNudgeCursorPath,
  };
}

async function readFiles(paths: readonly string[]): Promise<readonly Buffer[]> {
  return Promise.all(paths.map((path) => readFile(path)));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function collectExact(
  fixture: Fixture,
  command: "turn" | "evidence",
  identityValue: string,
  field: string | undefined,
  byteBudget: number,
  explicitWorkstream = true,
): Promise<{ readonly text: string; readonly pages: number; readonly firstCursor?: string }> {
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  let reconstructed = "";
  let pages = 0;
  let expectedSha: string | undefined;
  let expectedTotal: number | undefined;
  do {
    const args =
      command === "turn"
        ? ["turn", "show", identityValue]
        : [
            "evidence",
            "show",
            identityValue,
            "--provider",
            "codex",
            "--session-id",
            CODEX_SESSION,
          ];
    if (field !== undefined) args.push("--field", field);
    if (explicitWorkstream) args.push("--workstream", "lane");
    args.push("--byte-budget", String(byteBudget));
    if (cursor !== undefined) args.push("--cursor", cursor);
    const page = await invokeJson<ExactPageValue>(fixture.project, args);
    assert.equal(page.value.field, field ?? "record");
    assert.equal(page.value.present, true);
    assert.equal(
      page.value.range.start,
      Buffer.byteLength(reconstructed, "utf8"),
    );
    assert.equal(
      page.value.range.end - page.value.range.start,
      Buffer.byteLength(page.value.text, "utf8"),
    );
    expectedSha ??= page.value.sha256;
    expectedTotal ??= page.value.total_utf8_bytes;
    assert.equal(page.value.sha256, expectedSha);
    assert.equal(page.value.total_utf8_bytes, expectedTotal);
    assert.equal(page.value.complete, page.value.next_cursor === undefined);
    reconstructed += page.value.text;
    pages += 1;
    assert.ok(pages < 200, "exact paging must terminate");
    cursor = page.value.next_cursor;
    firstCursor ??= cursor;
  } while (cursor !== undefined);
  assert.equal(Buffer.byteLength(reconstructed, "utf8"), expectedTotal);
  assert.equal(sha256(reconstructed), expectedSha);
  return {
    text: reconstructed,
    pages,
    ...(firstCursor === undefined ? {} : { firstCursor }),
  };
}

test("built CLI exhaustively lists pinned turns and reconstructs exact turn fields without acknowledging them", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-full-peer-cli-turn-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const fixture = await createFixture(project);
  const initialFeeds = await readFiles(fixture.feedPaths);
  const initialEvidence = await readFile(fixture.evidencePath);
  const initialNudgeCursor = await readFile(fixture.nudgeCursorPath);
  await assert.rejects(access(fixture.absentNudgeCursorPath), { code: "ENOENT" });

  const listed: string[] = [];
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  let firstPage = true;
  do {
    const page = await invokeJson<TurnListValue>(project, [
      "turn",
      "list",
      "--workstream",
      "lane",
      "--byte-budget",
      "6000",
      ...(cursor === undefined ? [] : ["--cursor", cursor]),
    ]);
    assert.equal(page.value.schema, "barbaro.reader.turn-list.v1");
    assert.equal(page.value.range.start, listed.length);
    assert.equal(page.value.turns.shown, page.value.turns.items.length);
    assert.equal(page.value.turns.total, fixture.turns.length);
    listed.push(...page.value.turns.items.map((item) => item.turn_id));
    assert.equal(page.value.range.end, listed.length);
    assert.equal(page.value.complete, page.value.turns.next_cursor === undefined);
    cursor = page.value.turns.next_cursor;
    firstCursor ??= cursor;

    if (firstPage) {
      firstPage = false;
      assert.ok(cursor !== undefined, "fixture must span list pages");
      assert.deepEqual(await readFiles(fixture.feedPaths), initialFeeds);
      assert.deepEqual(await readFile(fixture.evidencePath), initialEvidence);
      assert.deepEqual(await readFile(fixture.nudgeCursorPath), initialNudgeCursor);
      await appendTurn(
        project,
        turn({
          seed: 999,
          provider: "codex",
          sessionId: CODEX_SESSION,
          workstreamId: fixture.lane,
          sequence: 100,
          endedAt: "2026-09-01T20:00:00.000Z",
          responseText: "appended after the list snapshot",
        }),
      );
    }
  } while (cursor !== undefined);

  assert.deepEqual(
    listed,
    [...fixture.turns].reverse().map((record) => record.turn_id),
  );
  assert.equal(new Set(listed).size, fixture.turns.length);
  assert.ok(!listed.includes(identity("turn", 999)));

  const feedsAfterFixtureAppend = await readFiles(fixture.feedPaths);
  const record = await collectExact(
    fixture,
    "turn",
    fixture.target.turn_id,
    undefined,
    6000,
  );
  assert.equal(record.text, stableStringify(fixture.target));
  assert.ok(record.pages > 1);
  const response = await collectExact(
    fixture,
    "turn",
    fixture.target.turn_id,
    "response",
    6000,
  );
  assert.equal(response.text, fixture.target.response?.text);
  assert.ok(response.pages > 1);
  assert.ok(response.pages < record.pages);

  assert.deepEqual(await readFiles(fixture.feedPaths), feedsAfterFixtureAppend);
  assert.deepEqual(await readFile(fixture.evidencePath), initialEvidence);
  assert.deepEqual(await readFile(fixture.nudgeCursorPath), initialNudgeCursor);
  await assert.rejects(access(fixture.absentNudgeCursorPath), { code: "ENOENT" });

  assert.ok(firstCursor !== undefined);
  const malformed = await invokeFailure(project, [
    "turn",
    "list",
    "--workstream",
    "lane",
    "--cursor",
    "not-a-cursor",
  ]);
  assert.equal(malformed.code, 2);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr ?? "", /cursor/iu);
  const foreignScope = await invokeFailure(project, [
    "turn",
    "list",
    "--workstream",
    "other-lane",
    "--byte-budget",
    "6000",
    "--cursor",
    firstCursor,
  ]);
  assert.equal(foreignScope.code, 2);
  assert.equal(foreignScope.stdout, "");
  assert.match(foreignScope.stderr ?? "", /cursor/iu);

  const foreignField = await invokeFailure(project, [
    "turn",
    "show",
    fixture.target.turn_id,
    "--field",
    "request",
    "--workstream",
    "lane",
    "--byte-budget",
    "6000",
    "--cursor",
    response.firstCursor!,
  ]);
  assert.equal(foreignField.code, 2);
  assert.equal(foreignField.stdout, "");
  assert.match(foreignField.stderr ?? "", /cursor/iu);

  const missing = await invokeFailure(project, [
    "turn",
    "show",
    identity("turn", 999_999),
    "--workstream",
    "lane",
  ]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr ?? "", /not found/iu);

  const tooSmall = await invokeFailure(project, [
    "turn",
    "show",
    fixture.target.turn_id,
    "--workstream",
    "lane",
    "--byte-budget",
    "1",
  ]);
  assert.equal(tooSmall.code, 2);
  assert.equal(tooSmall.stdout, "");
  assert.match(tooSmall.stderr ?? "", /byte budget/iu);

  assert.deepEqual(await readFiles(fixture.feedPaths), feedsAfterFixtureAppend);
  assert.deepEqual(await readFile(fixture.evidencePath), initialEvidence);
  assert.deepEqual(await readFile(fixture.nudgeCursorPath), initialNudgeCursor);
  await assert.rejects(access(fixture.absentNudgeCursorPath), { code: "ENOENT" });

  const rewrittenPath = fixture.feedPaths[0]!;
  const rewritten = Buffer.from(await readFile(rewrittenPath));
  rewritten[0] = rewritten[0] === 0x7b ? 0x5b : 0x7b;
  await writeFile(rewrittenPath, rewritten);
  const stale = await invokeFailure(project, [
    "turn",
    "list",
    "--workstream",
    "lane",
    "--byte-budget",
    "6000",
    "--cursor",
    firstCursor,
  ]);
  assert.equal(stale.code, 2);
  assert.equal(stale.stdout, "");
  assert.match(stale.stderr ?? "", /pinned feed|changed|snapshot/iu);
});

test("built CLI keeps projected evidence action paging and makes both evidence kinds exactly retrievable", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-full-peer-cli-evidence-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const fixture = await createFixture(project);
  const initialFeeds = await readFiles(fixture.feedPaths);
  const initialEvidence = await readFile(fixture.evidencePath);
  const initialNudgeCursor = await readFile(fixture.nudgeCursorPath);

  const projected = await invokeJson<{
    readonly schema: string;
    readonly kind: string;
    readonly content: {
      readonly actions: {
        readonly shown: number;
        readonly total: number;
        readonly items: readonly { readonly action_id: string }[];
        readonly next_cursor?: string;
      };
    };
  }>(project, [
    "evidence",
    "show",
    fixture.subagentEvidence.evidence_id,
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--byte-budget",
    "2500",
  ]);
  assert.equal(projected.value.schema, "barbaro.reader.evidence.v1");
  assert.equal(projected.value.kind, "subagent_turn");
  assert.ok(projected.value.content.actions.shown > 0);
  assert.ok(
    projected.value.content.actions.shown <
      projected.value.content.actions.total,
  );
  const actionCursor = projected.value.content.actions.next_cursor;
  assert.match(actionCursor ?? "", /^a:[1-9][0-9]*$/u);

  const continued = await invokeJson<{
    readonly content: {
      readonly actions: {
        readonly shown: number;
        readonly items: readonly { readonly action_id: string }[];
      };
    };
  }>(project, [
    "evidence",
    "show",
    fixture.subagentEvidence.evidence_id,
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--byte-budget",
    "2500",
    "--action-cursor",
    actionCursor!,
  ]);
  assert.ok(continued.value.content.actions.shown > 0);
  assert.notEqual(
    continued.value.content.actions.items[0]?.action_id,
    projected.value.content.actions.items[0]?.action_id,
  );

  for (const actionCursor of ["wrong", "a:9999"]) {
    const invalidActionCursor = await invokeFailure(project, [
      "evidence",
      "show",
      fixture.subagentEvidence.evidence_id,
      "--provider",
      "codex",
      "--session-id",
      CODEX_SESSION,
      "--action-cursor",
      actionCursor,
    ]);
    assert.equal(invalidActionCursor.code, 2);
    assert.equal(invalidActionCursor.stdout, "");
    assert.match(invalidActionCursor.stderr ?? "", /actionCursor/iu);
  }

  const subagentRecord = await collectExact(
    fixture,
    "evidence",
    fixture.subagentEvidence.evidence_id,
    "record",
    1800,
  );
  assert.equal(subagentRecord.text, stableStringify(fixture.subagentEvidence));
  assert.ok(subagentRecord.pages > 1);
  const subagentResponse = await collectExact(
    fixture,
    "evidence",
    fixture.subagentEvidence.evidence_id,
    "response",
    1800,
  );
  assert.equal(
    subagentResponse.text,
    fixture.subagentEvidence.kind === "subagent_turn"
      ? fixture.subagentEvidence.content.response?.text
      : undefined,
  );
  assert.ok(subagentResponse.pages > 1);

  const generalProjection = await invokeJson<{
    readonly schema: string;
    readonly kind: string;
    readonly content: {
      readonly text: string;
      readonly truncated: boolean;
      readonly utf8_bytes: { readonly shown: number; readonly original: number };
    };
  }>(project, [
    "evidence",
    "show",
    fixture.responseEvidence.evidence_id,
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--workstream",
    "lane",
    "--byte-budget",
    "2000",
  ]);
  assert.equal(generalProjection.value.schema, "barbaro.reader.evidence.v1");
  assert.equal(generalProjection.value.kind, "response");
  assert.equal(generalProjection.value.content.truncated, true);
  assert.ok(
    generalProjection.value.content.utf8_bytes.shown <
      generalProjection.value.content.utf8_bytes.original,
  );

  // Producer identity only locates the canonical evidence file. This session
  // now belongs to other-lane, but its historical lane evidence remains
  // reachable unless the caller explicitly requests the current scope.
  const explicitlyFiltered = await invokeFailure(project, [
    "evidence",
    "show",
    fixture.responseEvidence.evidence_id,
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--workstream",
    "other-lane",
  ]);
  assert.equal(explicitlyFiltered.code, 1);
  assert.equal(explicitlyFiltered.stdout, "");
  assert.match(explicitlyFiltered.stderr ?? "", /not found/iu);

  const generalContent = await collectExact(
    fixture,
    "evidence",
    fixture.responseEvidence.evidence_id,
    "content",
    1800,
    false,
  );
  assert.equal(
    generalContent.text,
    stableStringify(fixture.responseEvidence.content),
  );
  assert.ok(generalContent.pages > 1);
  const generalRecord = await collectExact(
    fixture,
    "evidence",
    fixture.responseEvidence.evidence_id,
    "record",
    1800,
    false,
  );
  assert.equal(generalRecord.text, stableStringify(fixture.responseEvidence));
  assert.ok(generalRecord.pages > 1);

  const malformed = await invokeFailure(project, [
    "evidence",
    "show",
    fixture.responseEvidence.evidence_id,
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--workstream",
    "lane",
    "--field",
    "content",
    "--cursor",
    "not-a-cursor",
  ]);
  assert.equal(malformed.code, 2);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr ?? "", /cursor/iu);

  const missing = await invokeFailure(project, [
    "evidence",
    "show",
    identity("ev", 999_999),
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--workstream",
    "lane",
  ]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr ?? "", /not found/iu);

  assert.deepEqual(await readFiles(fixture.feedPaths), initialFeeds);
  assert.deepEqual(await readFile(fixture.evidencePath), initialEvidence);
  assert.deepEqual(await readFile(fixture.nudgeCursorPath), initialNudgeCursor);
  await assert.rejects(access(fixture.absentNudgeCursorPath), { code: "ENOENT" });
});

test("built CLI exposes bounded reader limits without letting unrelated feeds block turn retrieval", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-full-peer-cli-limits-"));
  t.after(() => rm(project, { recursive: true, force: true }));

  const target = turn({
    seed: 800,
    provider: "codex",
    sessionId: CODEX_SESSION,
    workstreamId: `ws_${"8".repeat(32)}`,
    sequence: 1,
    endedAt: "2026-09-01T14:00:00.000Z",
    responseText: "target \ud800 😀 ".repeat(500),
  });
  await appendTurn(project, target);
  const targetRecordBytes = Buffer.byteLength(stableStringify(target), "utf8");
  const targetFileBytes = Buffer.byteLength(stableJsonLine(target), "utf8");
  await appendTurn(
    project,
    turn({
      seed: 801,
      provider: "claude",
      sessionId: CLAUDE_SESSION,
      workstreamId: target.workstream_id!,
      sequence: 1,
      endedAt: "2026-09-01T14:01:00.000Z",
      responseText: "unrelated oversized ".repeat(targetFileBytes),
    }),
  );

  const limitArgs = [
    "--max-file-bytes",
    String(targetFileBytes),
    "--max-record-bytes",
    String(targetRecordBytes),
  ];
  const listed = await invokeJson<TurnListValue>(project, [
    "turn",
    "list",
    "--all-workstreams",
    "--byte-budget",
    "5000",
    ...limitArgs,
  ]);
  assert.deepEqual(listed.value.diagnostics, {
    malformed_feed_records: 0,
    invalid_feed_records: 0,
    skipped_oversized_feed_files: 1,
  });
  assert.deepEqual(
    listed.value.turns.items.map((item) => item.turn_id),
    [target.turn_id],
  );

  const first = await invokeJson<ExactPageValue>(project, [
    "turn",
    "show",
    target.turn_id,
    "--field",
    "response",
    "--all-workstreams",
    "--byte-budget",
    "1500",
    ...limitArgs,
  ]);
  assert.deepEqual(first.value.diagnostics, {
    skipped_oversized_feed_files: 1,
  });
  assert.equal(first.value.representation, "json-string");
  assert.ok(first.value.next_cursor !== undefined);
  assert.ok(stableStringify(target.response!.text).startsWith(first.value.text));

  const changedLimits = await invokeFailure(project, [
    "turn",
    "show",
    target.turn_id,
    "--field",
    "response",
    "--all-workstreams",
    "--byte-budget",
    "1500",
    "--max-file-bytes",
    String(targetFileBytes + 1),
    "--max-record-bytes",
    String(targetRecordBytes),
    "--cursor",
    first.value.next_cursor!,
  ]);
  assert.equal(changedLimits.code, 2);
  assert.match(changedLimits.stderr ?? "", /cursor/iu);

  const evidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: identity("ev", 802),
    kind: "response",
    turn_id: target.turn_id,
    provider: "codex",
    session_id: CODEX_SESSION,
    workstream_id: target.workstream_id!,
    agent_id: "main",
    occurred_at: "2026-09-01T14:02:00.000Z",
    source_refs: [SOURCE_REF],
    content: { message: "bounded evidence 😀".repeat(100) },
  };
  const evidenceLine = stableJsonLine(evidence);
  const evidencePath = join(
    project,
    ".barbaro",
    "evidence",
    "codex",
    `${CODEX_SESSION}.jsonl`,
  );
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, evidenceLine, "utf8");
  const evidencePage = await invokeJson<ExactPageValue>(project, [
    "evidence",
    "show",
    evidence.evidence_id,
    "--provider",
    "codex",
    "--session-id",
    CODEX_SESSION,
    "--field",
    "record",
    "--byte-budget",
    "5000",
    "--max-file-bytes",
    String(Buffer.byteLength(evidenceLine, "utf8")),
    "--max-record-bytes",
    String(Buffer.byteLength(stableStringify(evidence), "utf8")),
  ]);
  assert.equal(evidencePage.value.text, stableStringify(evidence));

  const invalidLimit = await invokeFailure(project, [
    "turn",
    "list",
    "--all-workstreams",
    "--max-file-bytes",
    "0",
  ]);
  assert.equal(invalidLimit.code, 2);
  assert.match(invalidLimit.stderr ?? "", /positive integer/iu);
});
