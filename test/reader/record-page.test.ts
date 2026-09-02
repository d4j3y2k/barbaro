import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
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
import {
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../../src/core/safe-store.js";
import { stableJsonLine, stableStringify } from "../../src/core/stable-json.js";
import { ReaderByteBudgetTooSmallError } from "../../src/reader/budget.js";
import {
  ReaderRecordCursorError,
  ReaderRecordTooLargeError,
  readEvidenceRecordPage,
  readTurnRecordPage,
  type ReaderEvidenceRecordField,
  type ReaderTurnRecordField,
} from "../../src/reader/record-page.js";

const SESSION_ID = "ses_11111111111111111111111111111111";
const WORKSTREAM_ID = "ws_22222222222222222222222222222222";
const OTHER_WORKSTREAM_ID = "ws_33333333333333333333333333333333";
const TURN_ID = "turn_44444444444444444444444444444444";
const EVIDENCE_ID = "ev_55555555555555555555555555555555";
const SOURCE_REF = { trace_id: "fixture:record-page" } as const;

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function actions(count: number): BarbaroAction[] {
  return Array.from({ length: count }, (_, index) => ({
    action_id: `act_${(index + 1).toString(16).padStart(32, "0")}`,
    kind: "command" as const,
    outcome: "success" as const,
    command: content(`command ${index} 😀 ${"x".repeat(80)}`),
    exit_code: 0,
    source_refs: [SOURCE_REF],
  }));
}

function turn(
  overrides: Partial<BarbaroTurnV1> = {},
): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: TURN_ID,
    provider: "codex",
    session_id: SESSION_ID,
    workstream_id: WORKSTREAM_ID,
    sequence: 1,
    agent_id: "root",
    started_at: "2026-09-01T12:00:00.000Z",
    ended_at: "2026-09-01T12:01:00.000Z",
    outcome: "success",
    request: content("retrieve everything"),
    response: content("😀é漢字".repeat(700)),
    actions: actions(331),
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [SOURCE_REF],
    ...overrides,
  };
}

async function withProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-record-page-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function writeTurn(project: string, value: BarbaroTurnV1): Promise<string> {
  const path = join(
    project,
    ".barbaro",
    "feed",
    value.provider,
    `${value.session_id}.jsonl`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJsonLine(value), "utf8");
  return path;
}

async function writeEvidence(
  project: string,
  value: BarbaroEvidenceV1,
): Promise<string> {
  const path = join(
    project,
    ".barbaro",
    "evidence",
    value.provider,
    `${value.session_id}.jsonl`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJsonLine(value), "utf8");
  return path;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function collectTurn(
  project: string,
  field: ReaderTurnRecordField,
  byteBudget = 6000,
): Promise<{ readonly text: string; readonly pages: number }> {
  let cursor: string | undefined;
  let reconstructed = "";
  let pages = 0;
  do {
    const page = await readTurnRecordPage(project, {
      turnId: TURN_ID,
      field,
      byteBudget,
      workstreamId: WORKSTREAM_ID,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.equal(page.value.range.start, Buffer.byteLength(reconstructed, "utf8"));
    assert.equal(
      page.value.range.end - page.value.range.start,
      Buffer.byteLength(page.value.text, "utf8"),
    );
    assert.equal(Buffer.byteLength(stableStringify(page), "utf8"), page.utf8_bytes);
    assert.ok(page.utf8_bytes <= page.byte_budget);
    reconstructed += page.value.text;
    pages += 1;
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  return { text: reconstructed, pages };
}

test("turn pages reconstruct stable JSON and directly page Unicode fields", async () => {
  await withProject(async (project) => {
    const canonical = turn();
    const path = await writeTurn(project, canonical);
    const before = await readFile(path);

    const record = await collectTurn(project, "record");
    assert.equal(record.text, stableStringify(canonical));
    assert.ok(record.pages > 1);

    const response = await collectTurn(project, "response");
    assert.equal(response.text, canonical.response?.text);
    assert.ok(response.pages > 1);
    assert.ok(response.pages < record.pages);

    const actionField = await collectTurn(project, "actions");
    assert.equal(actionField.text, stableStringify(canonical.actions));
    assert.ok(actionField.pages > 1);
    assert.deepEqual(await readFile(path), before);
  });
});

test("an absent response is explicit and a tiny budget fails clearly", async () => {
  await withProject(async (project) => {
    const { response: _response, ...withoutResponse } = turn();
    const canonical: BarbaroTurnV1 = withoutResponse;
    await writeTurn(project, canonical);
    const page = await readTurnRecordPage(project, {
      turnId: TURN_ID,
      field: "response",
      byteBudget: 1024,
      workstreamId: WORKSTREAM_ID,
    });
    assert.equal(page.value.present, false);
    assert.equal(page.value.text, "");
    assert.equal(page.value.total_utf8_bytes, 0);
    assert.deepEqual(page.value.range, { start: 0, end: 0 });
    assert.equal(page.value.sha256, digest(""));
    assert.equal(page.value.complete, true);
    assert.equal(page.value.next_cursor, undefined);

    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: TURN_ID,
        field: "record",
        byteBudget: 1,
        workstreamId: WORKSTREAM_ID,
      }),
      (error: unknown) => error instanceof ReaderByteBudgetTooSmallError,
    );
  });
});

test("record cursors reject tampering and foreign fields or scopes", async () => {
  await withProject(async (project) => {
    const feedPath = await writeTurn(project, turn());
    const first = await readTurnRecordPage(project, {
      turnId: TURN_ID,
      field: "response",
      byteBudget: 1400,
      workstreamId: WORKSTREAM_ID,
    });
    const cursor = first.value.next_cursor;
    assert.ok(cursor !== undefined);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;

    for (const options of [
      { field: "response" as const, cursor: "not-a-cursor", workstreamId: WORKSTREAM_ID },
      { field: "response" as const, cursor: tampered, workstreamId: WORKSTREAM_ID },
      { field: "actions" as const, cursor, workstreamId: WORKSTREAM_ID },
      { field: "response" as const, cursor, workstreamId: OTHER_WORKSTREAM_ID },
    ]) {
      await assert.rejects(
        readTurnRecordPage(project, {
          turnId: TURN_ID,
          byteBudget: 1400,
          ...options,
        }),
        (error: unknown) => error instanceof ReaderRecordCursorError,
      );
    }

    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: TURN_ID,
        field: "response",
        byteBudget: 1400,
        workstreamId: WORKSTREAM_ID,
        cursor,
        maxFileBytes: 32 * 1024 * 1024,
      }),
      (error: unknown) => error instanceof ReaderRecordCursorError,
    );

    const foreignProject = await mkdtemp(join(tmpdir(), "barbaro-record-page-foreign-"));
    try {
      await assert.rejects(
        readTurnRecordPage(foreignProject, {
          turnId: TURN_ID,
          field: "response",
          byteBudget: 1400,
          workstreamId: WORKSTREAM_ID,
          cursor,
        }),
        (error: unknown) => error instanceof ReaderRecordCursorError,
      );
    } finally {
      await rm(foreignProject, { recursive: true, force: true });
    }

    await appendFile(
      feedPath,
      stableJsonLine(turn({
        turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sequence: 2,
      })),
      "utf8",
    );
    const continued = await readTurnRecordPage(project, {
      turnId: TURN_ID,
      field: "response",
      byteBudget: 1400,
      workstreamId: WORKSTREAM_ID,
      cursor,
    });
    assert.equal(continued.value.range.start, first.value.range.end);

    await writeFile(
      feedPath,
      stableJsonLine(turn({ response: content("changed response") })),
      "utf8",
    );
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: TURN_ID,
        field: "response",
        byteBudget: 1400,
        workstreamId: WORKSTREAM_ID,
        cursor,
      }),
      (error: unknown) => error instanceof ReaderRecordCursorError,
    );

    await unlink(feedPath);
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: TURN_ID,
        field: "response",
        byteBudget: 1400,
        workstreamId: WORKSTREAM_ID,
        cursor,
      }),
      (error: unknown) => error instanceof ReaderRecordCursorError,
    );
  });
});

async function collectEvidence(
  project: string,
  evidence: BarbaroEvidenceV1,
  field: ReaderEvidenceRecordField,
  expected: string,
): Promise<string> {
  let cursor: string | undefined;
  let reconstructed = "";
  do {
    const page = await readEvidenceRecordPage(project, {
      provider: evidence.provider,
      sessionId: evidence.session_id,
      evidenceId: evidence.evidence_id,
      field,
      byteBudget: 1600,
      workstreamId: WORKSTREAM_ID,
      ...(cursor === undefined ? {} : { cursor }),
    });
    reconstructed += page.value.text;
    assert.equal(page.value.sha256, digest(expected));
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  return reconstructed;
}

test("response and subagent evidence remain exactly retrievable", async () => {
  await withProject(async (project) => {
    const responseEvidence: BarbaroEvidenceV1 = {
      schema: "barbaro.evidence.v1",
      evidence_id: EVIDENCE_ID,
      kind: "response",
      turn_id: TURN_ID,
      provider: "codex",
      session_id: SESSION_ID,
      workstream_id: WORKSTREAM_ID,
      agent_id: "root",
      occurred_at: "2026-09-01T12:00:30.000Z",
      source_refs: [SOURCE_REF],
      content: { text: content("intermediate 😀".repeat(300)) },
    };
    await writeEvidence(project, responseEvidence);
    assert.equal(
      await collectEvidence(
        project,
        responseEvidence,
        "record",
        stableStringify(responseEvidence),
      ),
      stableStringify(responseEvidence),
    );
    assert.equal(
      await collectEvidence(
        project,
        responseEvidence,
        "content",
        stableStringify(responseEvidence.content),
      ),
      stableStringify(responseEvidence.content),
    );
    const responseText = content("intermediate 😀".repeat(300)).text;
    assert.equal(
      await collectEvidence(project, responseEvidence, "response", responseText),
      responseText,
    );

    const subagent: BarbaroEvidenceV1 = {
      schema: "barbaro.evidence.v1",
      evidence_id: "ev_66666666666666666666666666666666",
      kind: "subagent_turn",
      turn_id: "turn_77777777777777777777777777777777",
      parent_turn_id: TURN_ID,
      parent_link: { method: "native", native_key: "child-1" },
      provider: "codex",
      session_id: SESSION_ID,
      workstream_id: WORKSTREAM_ID,
      agent_id: "child-1",
      occurred_at: "2026-09-01T12:00:40.000Z",
      source_refs: [SOURCE_REF],
      content: {
        role: "reviewer",
        sequence: 1,
        outcome: "success",
        started_at: "2026-09-01T12:00:20.000Z",
        ended_at: "2026-09-01T12:00:40.000Z",
        request: content("inspect all actions"),
        response: content("approved ✅".repeat(200)),
        actions: actions(25),
      },
    };
    const evidencePath = join(
      project,
      ".barbaro",
      "evidence",
      "codex",
      `${SESSION_ID}.jsonl`,
    );
    await writeFile(
      evidencePath,
      `${stableJsonLine(responseEvidence)}${stableJsonLine(subagent)}`,
      "utf8",
    );
    assert.equal(
      await collectEvidence(
        project,
        subagent,
        "request",
        subagent.content.request.text,
      ),
      subagent.content.request.text,
    );
    assert.equal(
      await collectEvidence(
        project,
        subagent,
        "response",
        subagent.content.response?.text ?? "",
      ),
      subagent.content.response?.text,
    );
    assert.equal(
      await collectEvidence(
        project,
        subagent,
        "actions",
        stableStringify(subagent.content.actions),
      ),
      stableStringify(subagent.content.actions),
    );
  });
});

test("record pages preserve no-follow, single-link, and size limits", async (t) => {
  await t.test("symbolic link", async () => {
    await withProject(async (project) => {
      const outside = await mkdtemp(join(tmpdir(), "barbaro-record-page-outside-"));
      try {
        const target = join(outside, "turns.jsonl");
        await writeFile(target, stableJsonLine(turn()), "utf8");
        const path = join(project, ".barbaro", "feed", "codex", `${SESSION_ID}.jsonl`);
        await mkdir(dirname(path), { recursive: true });
        await symlink(target, path, "file");
        await assert.rejects(
          readTurnRecordPage(project, { turnId: TURN_ID, byteBudget: 4096 }),
          (error: unknown) => error instanceof UnsafeStorePathError,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  await t.test("hard link and limits", async () => {
    await withProject(async (project) => {
      const path = await writeTurn(project, turn());
      const outside = await mkdtemp(join(tmpdir(), "barbaro-record-page-link-"));
      try {
        await link(path, join(outside, "turns.jsonl"));
        await assert.rejects(
          readTurnRecordPage(project, { turnId: TURN_ID, byteBudget: 4096 }),
          (error: unknown) => error instanceof UnsafeStorePathError,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }

      await assert.rejects(
        readTurnRecordPage(project, {
          turnId: TURN_ID,
          byteBudget: 4096,
          maxFileBytes: 128,
        }),
        (error: unknown) => error instanceof StoreFileTooLargeError,
      );
      await assert.rejects(
        readTurnRecordPage(project, {
          turnId: TURN_ID,
          byteBudget: 4096,
          maxRecordBytes: 128,
        }),
        (error: unknown) => error instanceof ReaderRecordTooLargeError,
      );
    });
  });
});
