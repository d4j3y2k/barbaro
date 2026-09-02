import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type {
  BarbaroAction,
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";
import { stableJsonLine, stableStringify } from "../../src/core/stable-json.js";
import {
  readEvidenceRecordPage,
  readProjectTurnList,
  readTurnRecordPage,
} from "../../src/reader/index.js";

const WS_ALPHA = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WS_BETA = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CODEX_SESSION = "ses_11111111111111111111111111111111";
const CLAUDE_SESSION = "ses_22222222222222222222222222222222";
const SOURCE_REF = { trace_id: "fixture:full-peer-context" } as const;

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function identity(prefix: "turn" | "act" | "ev", seed: number): string {
  return `${prefix}_${seed.toString(16).padStart(32, "0")}`;
}

function actions(count: number): BarbaroAction[] {
  return Array.from({ length: count }, (_, index) => ({
    action_id: identity("act", index + 1),
    kind: "command" as const,
    outcome: "success" as const,
    command: content(`command ${index} 🚀 ${"x".repeat(96)}`),
    exit_code: 0,
    source_refs: [SOURCE_REF],
  }));
}

interface TurnOptions {
  readonly seed: number;
  readonly provider: "codex" | "claude";
  readonly sessionId: string;
  readonly sequence: number;
  readonly workstreamId: string;
  readonly endedAt: string;
  readonly requestText?: string;
  readonly responseText?: string;
  readonly responseAbsent?: boolean;
  readonly actionCount?: number;
  readonly evidenceRefs?: readonly string[];
}

function turn(options: TurnOptions): BarbaroTurnV1 {
  const response =
    options.responseAbsent === true
      ? {}
      : { response: content(options.responseText ?? `response ${options.seed}`) };
  return {
    schema: "barbaro.turn.v1",
    turn_id: identity("turn", options.seed),
    provider: options.provider,
    session_id: options.sessionId,
    workstream_id: options.workstreamId,
    sequence: options.sequence,
    agent_id: "main",
    started_at: "2026-08-31T12:00:00.000Z",
    ended_at: options.endedAt,
    outcome: "success",
    request: content(options.requestText ?? `request ${options.seed}`),
    ...response,
    actions: actions(options.actionCount ?? 0),
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

async function temporaryProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-full-peer-context-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function appendTurn(project: string, record: BarbaroTurnV1): Promise<void> {
  const path = join(
    project,
    ".barbaro",
    "feed",
    record.provider,
    `${record.session_id}.jsonl`,
  );
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, stableJsonLine(record), "utf8");
}

async function writeParticipationMove(project: string): Promise<void> {
  const path = join(
    project,
    ".barbaro",
    "sessions",
    "codex",
    `${CODEX_SESSION}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    stableStringify({
      schema: "barbaro.session-participation.v2",
      provider: "codex",
      session_id: CODEX_SESSION,
      joined_at: "2026-08-31T10:00:00.000Z",
      initiated_by: "user_prompt",
      workstream_id: WS_BETA,
      memberships: [
        { workstream_id: WS_ALPHA, from: "2026-08-31T10:00:00.000Z" },
        { workstream_id: WS_BETA, from: "2026-08-31T11:00:00.000Z" },
      ],
    }),
    "utf8",
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("turn list exhaustively pages a pinned, newest-first workstream history", async () => {
  await temporaryProject(async (project) => {
    await writeParticipationMove(project);
    const alphaTurns = Array.from({ length: 18 }, (_, index) =>
      turn({
        seed: index + 1,
        provider: index % 2 === 0 ? "codex" : "claude",
        sessionId: index % 2 === 0 ? CODEX_SESSION : CLAUDE_SESSION,
        sequence: Math.floor(index / 2) + 1,
        workstreamId: WS_ALPHA,
        endedAt: new Date(
          Date.parse("2026-08-31T12:00:00.000Z") + index * 60_000,
        ).toISOString(),
        responseText: `alpha response ${index} 😀`,
        actionCount: index % 3,
        evidenceRefs:
          index % 4 === 0 ? [identity("ev", index + 1)] : [],
      }),
    );
    const betaTurn = turn({
      seed: 100,
      provider: "codex",
      sessionId: CODEX_SESSION,
      sequence: 10,
      workstreamId: WS_BETA,
      endedAt: "2026-08-31T13:00:00.000Z",
    });
    for (const record of [...alphaTurns, betaTurn]) {
      await appendTurn(project, record);
    }

    const listed: Array<
      Awaited<
        ReturnType<typeof readProjectTurnList>
      >["value"]["turns"]["items"][number]
    > = [];
    let cursor: string | undefined;
    let firstPage = true;
    do {
      const page = await readProjectTurnList(project, {
        byteBudget: 4096,
        workstreamId: WS_ALPHA,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.equal(page.value.schema, "barbaro.reader.turn-list.v1");
      assert.deepEqual(page.value.scope, {
        kind: "workstream",
        workstream_id: WS_ALPHA,
      });
      assert.equal(
        Buffer.byteLength(stableStringify(page), "utf8"),
        page.utf8_bytes,
      );
      assert.ok(page.utf8_bytes <= page.byte_budget);
      assert.equal(page.value.turns.shown, page.value.turns.items.length);
      assert.equal(page.value.turns.total, alphaTurns.length);
      assert.equal(page.value.range.start, listed.length);
      listed.push(...page.value.turns.items);
      assert.equal(page.value.range.end, listed.length);
      assert.equal(
        page.value.complete,
        page.value.turns.next_cursor === undefined,
      );

      if (firstPage) {
        firstPage = false;
        assert.ok(
          page.value.turns.next_cursor !== undefined,
          "fixture must span pages before the append",
        );
        await appendTurn(
          project,
          turn({
            seed: 101,
            provider: "codex",
            sessionId: CODEX_SESSION,
            sequence: 11,
            workstreamId: WS_ALPHA,
            endedAt: "2026-08-31T14:00:00.000Z",
            responseText: "appended after the first page",
          }),
        );
      }
      cursor = page.value.turns.next_cursor;
    } while (cursor !== undefined);

    const expected = [...alphaTurns].reverse();
    assert.deepEqual(
      listed.map((item) => item.turn_id),
      expected.map((item) => item.turn_id),
    );
    assert.equal(new Set(listed.map((item) => item.turn_id)).size, listed.length);
    assert.ok(!listed.some((item) => item.turn_id === betaTurn.turn_id));
    assert.ok(!listed.some((item) => item.turn_id === identity("turn", 101)));

    for (const [index, item] of listed.entries()) {
      const canonical = expected[index]!;
      assert.equal(item.provider, canonical.provider);
      assert.equal(item.session_id, canonical.session_id);
      assert.equal(item.sequence, canonical.sequence);
      assert.equal(item.agent_id, canonical.agent_id);
      assert.equal(item.started_at, canonical.started_at);
      assert.equal(item.ended_at, canonical.ended_at);
      assert.equal(item.outcome, canonical.outcome);
      assert.equal(
        item.request_utf8_bytes,
        Buffer.byteLength(canonical.request.text, "utf8"),
      );
      assert.equal(
        item.response_utf8_bytes,
        Buffer.byteLength(canonical.response!.text, "utf8"),
      );
      assert.equal(item.action_count, canonical.actions.length);
      assert.equal(item.evidence_ref_count, canonical.evidence_refs.length);
    }

    const allWorkstreams = await readProjectTurnList(project, {
      byteBudget: 64 * 1024,
    });
    assert.deepEqual(allWorkstreams.value.scope, { kind: "all" });
    assert.equal(allWorkstreams.value.turns.total, alphaTurns.length + 2);
    assert.equal(allWorkstreams.value.turns.next_cursor, undefined);
    assert.deepEqual(
      allWorkstreams.value.turns.items.slice(0, 2).map((item) => item.turn_id),
      [identity("turn", 101), betaTurn.turn_id],
    );
  });
});

async function collectTurnPages(
  project: string,
  turnId: string,
  field: "record" | "request" | "response" | "actions",
  byteBudget: number,
): Promise<{ readonly text: string; readonly pages: number }> {
  let cursor: string | undefined;
  let text = "";
  let pages = 0;
  let expectedSha: string | undefined;
  let expectedTotal: number | undefined;
  do {
    const page = await readTurnRecordPage(project, {
      turnId,
      field,
      byteBudget,
      workstreamId: WS_ALPHA,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.equal(page.value.schema, "barbaro.reader.turn.v1");
    assert.equal(page.value.turn_id, turnId);
    assert.equal(page.value.field, field);
    assert.equal(page.value.present, true);
    assert.equal(
      Buffer.byteLength(stableStringify(page), "utf8"),
      page.utf8_bytes,
    );
    assert.ok(page.utf8_bytes <= page.byte_budget);
    assert.equal(page.value.range.start, Buffer.byteLength(text, "utf8"));
    assert.ok(
      page.value.range.end > page.value.range.start,
      "each nonempty turn page advances the UTF-8 range",
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
    text += page.value.text;
    pages += 1;
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  assert.equal(Buffer.byteLength(text, "utf8"), expectedTotal);
  assert.equal(sha256(text), expectedSha);
  return { text, pages };
}

test("turn record pages reconstruct large canonical records and address response directly", async () => {
  await temporaryProject(async (project) => {
    const responseText = "😀é漢字".repeat(900);
    const large = turn({
      seed: 200,
      provider: "codex",
      sessionId: CODEX_SESSION,
      sequence: 1,
      workstreamId: WS_ALPHA,
      endedAt: "2026-08-31T15:00:00.000Z",
      requestText: "retrieve every byte",
      responseText,
      actionCount: 331,
    });
    const withoutResponse = turn({
      seed: 201,
      provider: "claude",
      sessionId: CLAUDE_SESSION,
      sequence: 1,
      workstreamId: WS_ALPHA,
      endedAt: "2026-08-31T15:01:00.000Z",
      responseAbsent: true,
    });
    await appendTurn(project, large);
    await appendTurn(project, withoutResponse);

    const record = await collectTurnPages(
      project,
      large.turn_id,
      "record",
      4096,
    );
    assert.equal(record.text, stableStringify(large));
    assert.ok(record.pages > 20, "hundreds of actions require many bounded pages");

    const actionPages = await collectTurnPages(
      project,
      large.turn_id,
      "actions",
      4096,
    );
    assert.equal(actionPages.text, stableStringify(large.actions));
    assert.ok(actionPages.pages > 10);

    const response = await collectTurnPages(
      project,
      large.turn_id,
      "response",
      4096,
    );
    assert.equal(response.text, responseText);
    assert.ok(response.pages > 1);
    assert.ok(response.pages < record.pages);
    assert.ok(
      response.pages <= Buffer.byteLength(responseText, "utf8"),
      "every response page makes forward progress by at least one UTF-8 byte",
    );

    const absentRecord = await collectTurnPages(
      project,
      withoutResponse.turn_id,
      "record",
      4096,
    );
    assert.equal(absentRecord.text, stableStringify(withoutResponse));
    const absentResponse = await readTurnRecordPage(project, {
      turnId: withoutResponse.turn_id,
      field: "response",
      byteBudget: 1300,
      workstreamId: WS_ALPHA,
    });
    assert.equal(absentResponse.value.present, false);
    assert.equal(absentResponse.value.text, "");
    assert.equal(absentResponse.value.total_utf8_bytes, 0);
    assert.deepEqual(absentResponse.value.range, { start: 0, end: 0 });
    assert.equal(absentResponse.value.complete, true);
    assert.equal(absentResponse.value.next_cursor, undefined);
  });
});

test("list and record cursors reject malformed, tampered, and foreign queries", async () => {
  await temporaryProject(async (project) => {
    const records = Array.from({ length: 12 }, (_, index) =>
      turn({
        seed: 400 + index,
        provider: "codex",
        sessionId: CODEX_SESSION,
        sequence: index + 1,
        workstreamId: WS_ALPHA,
        endedAt: new Date(
          Date.parse("2026-08-31T16:00:00.000Z") + index * 60_000,
        ).toISOString(),
        responseText: "cursor fixture 🛡️".repeat(200),
        actionCount: 10,
      }),
    );
    for (const record of records) await appendTurn(project, record);

    const firstList = await readProjectTurnList(project, {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
    });
    const listCursor = firstList.value.turns.next_cursor;
    assert.ok(listCursor !== undefined);
    const tamperedListCursor = `${listCursor.slice(0, -1)}${
      listCursor.endsWith("a") ? "b" : "a"
    }`;
    await assert.rejects(
      readProjectTurnList(project, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        cursor: "not-a-cursor",
      }),
      /cursor/iu,
    );
    await assert.rejects(
      readProjectTurnList(project, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        cursor: tamperedListCursor,
      }),
      /cursor/iu,
    );
    await assert.rejects(
      readProjectTurnList(project, {
        byteBudget: 2200,
        workstreamId: WS_BETA,
        cursor: listCursor,
      }),
      /cursor/iu,
    );

    const firstRecord = await readTurnRecordPage(project, {
      turnId: records[0]!.turn_id,
      field: "response",
      byteBudget: 1300,
      workstreamId: WS_ALPHA,
    });
    const recordCursor = firstRecord.value.next_cursor;
    assert.ok(recordCursor !== undefined);
    const tamperedRecordCursor = `${recordCursor.slice(0, -1)}${
      recordCursor.endsWith("a") ? "b" : "a"
    }`;
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: records[0]!.turn_id,
        field: "response",
        byteBudget: 1300,
        workstreamId: WS_ALPHA,
        cursor: "not-a-cursor",
      }),
      /cursor/iu,
    );
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: records[0]!.turn_id,
        field: "response",
        byteBudget: 1300,
        workstreamId: WS_ALPHA,
        cursor: tamperedRecordCursor,
      }),
      /cursor/iu,
    );
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: records[0]!.turn_id,
        field: "actions",
        byteBudget: 1300,
        workstreamId: WS_ALPHA,
        cursor: recordCursor,
      }),
      /cursor/iu,
    );
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: records[1]!.turn_id,
        field: "response",
        byteBudget: 1300,
        workstreamId: WS_ALPHA,
        cursor: recordCursor,
      }),
      /cursor/iu,
    );

    const foreignProject = await mkdtemp(
      join(tmpdir(), "barbaro-full-peer-context-foreign-"),
    );
    try {
      for (const record of records) await appendTurn(foreignProject, record);
      await assert.rejects(
        readProjectTurnList(foreignProject, {
          byteBudget: 2200,
          workstreamId: WS_ALPHA,
          cursor: listCursor,
        }),
        /cursor/iu,
      );
      await assert.rejects(
        readTurnRecordPage(foreignProject, {
          turnId: records[0]!.turn_id,
          field: "response",
          byteBudget: 1300,
          workstreamId: WS_ALPHA,
          cursor: recordCursor,
        }),
        /cursor/iu,
      );
    } finally {
      await rm(foreignProject, { recursive: true, force: true });
    }
  });
});

async function collectEvidencePages(
  project: string,
  evidence: BarbaroEvidenceV1,
  field: "record" | "content" | "request" | "response" | "actions",
  expectedText: string,
): Promise<number> {
  let cursor: string | undefined;
  let reconstructed = "";
  let pages = 0;
  do {
    const page = await readEvidenceRecordPage(project, {
      provider: evidence.provider,
      sessionId: evidence.session_id,
      evidenceId: evidence.evidence_id,
      field,
      byteBudget: 1400,
      workstreamId: WS_ALPHA,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.equal(page.value.schema, "barbaro.reader.evidence-record.v1");
    assert.equal(page.value.evidence_id, evidence.evidence_id);
    assert.equal(page.value.field, field);
    assert.equal(page.value.present, true);
    assert.equal(
      page.value.range.start,
      Buffer.byteLength(reconstructed, "utf8"),
    );
    assert.ok(
      page.value.range.end > page.value.range.start,
      "each nonempty evidence page advances the UTF-8 range",
    );
    assert.equal(
      page.value.range.end - page.value.range.start,
      Buffer.byteLength(page.value.text, "utf8"),
    );
    reconstructed += page.value.text;
    assert.equal(page.value.sha256, sha256(expectedText));
    assert.equal(
      page.value.total_utf8_bytes,
      Buffer.byteLength(expectedText, "utf8"),
    );
    assert.equal(page.value.complete, page.value.next_cursor === undefined);
    assert.equal(
      Buffer.byteLength(stableStringify(page), "utf8"),
      page.utf8_bytes,
    );
    assert.ok(page.utf8_bytes <= page.byte_budget);
    pages += 1;
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  assert.equal(reconstructed, expectedText);
  return pages;
}

test("evidence record pages reconstruct the exact canonical evidence", async () => {
  await temporaryProject(async (project) => {
    const evidence: BarbaroEvidenceV1 = {
      schema: "barbaro.evidence.v1",
      evidence_id: identity("ev", 300),
      kind: "response",
      turn_id: identity("turn", 200),
      provider: "codex",
      session_id: CODEX_SESSION,
      workstream_id: WS_ALPHA,
      agent_id: "main",
      occurred_at: "2026-08-31T15:00:30.000Z",
      source_refs: [SOURCE_REF],
      content: {
        message: "canonical evidence 🔎é".repeat(800),
        nested: { ok: true, count: 7 },
      },
    };
    const path = join(
      project,
      ".barbaro",
      "evidence",
      evidence.provider,
      `${evidence.session_id}.jsonl`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stableJsonLine(evidence), "utf8");

    const recordPages = await collectEvidencePages(
      project,
      evidence,
      "record",
      stableStringify(evidence),
    );
    const contentPages = await collectEvidencePages(
      project,
      evidence,
      "content",
      stableStringify(evidence.content),
    );
    assert.ok(recordPages > 1);
    assert.ok(contentPages > 1);
  });
});
