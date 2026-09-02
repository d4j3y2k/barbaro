import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type {
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../../src/contracts/v1.js";
import { StoreFileTooLargeError } from "../../src/core/safe-store.js";
import { stableJsonLine } from "../../src/core/stable-json.js";
import {
  ReaderRecordCursorError,
  ReaderTurnNotFoundError,
  ReaderTurnSearchIncompleteError,
  readEvidenceRecordPage,
  readTurnRecordPage,
} from "../../src/reader/record-page.js";

const SESSION_ID = "ses_11111111111111111111111111111111";
const WORKSTREAM_ID = "ws_22222222222222222222222222222222";
const TURN_ID = "turn_44444444444444444444444444444444";
const EVIDENCE_ID = "ev_55555555555555555555555555555555";
const SOURCE_REF = { trace_id: "fixture:record-page-pinned" } as const;
const RESPONSE = "pinned 😀é漢字 ".repeat(400);

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function turn(overrides: Partial<BarbaroTurnV1> = {}): BarbaroTurnV1 {
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
    response: content(RESPONSE),
    actions: [],
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

function evidence(): BarbaroEvidenceV1 {
  return {
    schema: "barbaro.evidence.v1",
    evidence_id: EVIDENCE_ID,
    kind: "subagent_turn",
    turn_id: TURN_ID,
    parent_turn_id: TURN_ID,
    parent_link: { method: "joined", native_key: "child-1" },
    provider: "codex",
    session_id: SESSION_ID,
    workstream_id: WORKSTREAM_ID,
    agent_id: "child-1",
    occurred_at: "2026-09-01T12:02:00.000Z",
    source_refs: [SOURCE_REF],
    content: {
      role: "worker",
      sequence: 1,
      outcome: "success",
      started_at: "2026-09-01T12:01:00.000Z",
      ended_at: "2026-09-01T12:02:00.000Z",
      request: content("inspect"),
      response: content(RESPONSE),
      actions: [],
    },
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function withProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-record-page-pinned-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function writeLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line, "utf8");
}

/** Grow a canonical file past `maxFileBytes` without touching earlier bytes. */
async function outgrow(path: string, maxFileBytes: number): Promise<void> {
  await appendFile(path, `${JSON.stringify({ junk: "x".repeat(4096) })}\n`, "utf8");
  assert.ok((await stat(path)).size > maxFileBytes);
}

test("turn pages resume from their pinned range after the feed outgrows the file limit", async () => {
  await withProject(async (project) => {
    const path = join(project, ".barbaro", "feed", "codex", `${SESSION_ID}.jsonl`);
    await writeLine(path, stableJsonLine(turn()));
    const maxFileBytes = (await stat(path)).size + 64;
    const options = {
      turnId: TURN_ID,
      field: "response" as const,
      byteBudget: 1400,
      workstreamId: WORKSTREAM_ID,
      maxFileBytes,
    };
    const first = await readTurnRecordPage(project, options);
    assert.ok(first.value.next_cursor !== undefined);
    assert.equal(first.value.sha256, digest(RESPONSE));

    await outgrow(path, maxFileBytes);

    // A fresh lookup honours the exposed limit, can no longer see the feed,
    // and says so rather than claiming the turn is absent.
    await assert.rejects(
      readTurnRecordPage(project, options),
      (error: unknown) =>
        error instanceof ReaderTurnSearchIncompleteError &&
        error.skippedOversizedFeedFiles === 1,
    );

    // The traversal that already pinned its record keeps going.
    let text = first.value.text;
    let cursor: string | undefined = first.value.next_cursor;
    let pages = 1;
    for (;;) {
      const current = cursor;
      if (current === undefined) break;
      const page = await readTurnRecordPage(project, { ...options, cursor: current });
      assert.deepEqual(page.value.diagnostics, first.value.diagnostics);
      assert.equal(page.value.range.start, Buffer.byteLength(text, "utf8"));
      text += page.value.text;
      cursor = page.value.next_cursor;
      pages += 1;
    }
    assert.ok(pages > 2);
    assert.equal(text, RESPONSE);
  });
});

test("evidence pages resume from their pinned range after the file outgrows the limit", async () => {
  await withProject(async (project) => {
    const path = join(project, ".barbaro", "evidence", "codex", `${SESSION_ID}.jsonl`);
    await writeLine(path, stableJsonLine(evidence()));
    const maxFileBytes = (await stat(path)).size + 64;
    const options = {
      provider: "codex",
      sessionId: SESSION_ID,
      evidenceId: EVIDENCE_ID,
      field: "response" as const,
      byteBudget: 1400,
      workstreamId: WORKSTREAM_ID,
      maxFileBytes,
    };
    const first = await readEvidenceRecordPage(project, options);
    assert.ok(first.value.next_cursor !== undefined);

    await outgrow(path, maxFileBytes);
    // Evidence names its one file, so a fresh read reports the limit plainly.
    await assert.rejects(
      readEvidenceRecordPage(project, options),
      (error: unknown) => error instanceof StoreFileTooLargeError,
    );

    let text = first.value.text;
    let cursor: string | undefined = first.value.next_cursor;
    for (;;) {
      const current = cursor;
      if (current === undefined) break;
      const page = await readEvidenceRecordPage(project, { ...options, cursor: current });
      text += page.value.text;
      cursor = page.value.next_cursor;
    }
    assert.equal(text, RESPONSE);
    assert.equal(first.value.sha256, digest(RESPONSE));
  });
});

test("a pinned range that no longer holds the same record fails closed", async () => {
  await withProject(async (project) => {
    const path = join(project, ".barbaro", "feed", "codex", `${SESSION_ID}.jsonl`);
    await writeLine(path, stableJsonLine(turn()));
    const options = {
      turnId: TURN_ID,
      field: "response" as const,
      byteBudget: 1400,
      workstreamId: WORKSTREAM_ID,
    };
    const first = await readTurnRecordPage(project, options);
    const cursor = first.value.next_cursor;
    assert.ok(cursor !== undefined);

    // Same length, different bytes inside the pinned range.
    const altered = stableJsonLine(
      turn({ response: content(RESPONSE.replace("pinned", "PINNED")) }),
    );
    assert.equal(
      Buffer.byteLength(altered, "utf8"),
      Buffer.byteLength(stableJsonLine(turn()), "utf8"),
    );
    await writeFile(path, altered, "utf8");
    await assert.rejects(
      readTurnRecordPage(project, { ...options, cursor }),
      (error: unknown) =>
        error instanceof ReaderRecordCursorError &&
        /changed since the prior page/u.test(error.message),
    );

    // Shorter than the pinned range.
    await writeFile(path, stableJsonLine(turn({ response: content("short") })), "utf8");
    await assert.rejects(
      readTurnRecordPage(project, { ...options, cursor }),
      (error: unknown) =>
        error instanceof ReaderRecordCursorError &&
        /no longer available/u.test(error.message),
    );

    // The record is intact but the range now points at a different record.
    await writeFile(
      path,
      `${stableJsonLine(turn({ turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }))}${stableJsonLine(turn())}`,
      "utf8",
    );
    await assert.rejects(
      readTurnRecordPage(project, { ...options, cursor }),
      (error: unknown) => error instanceof ReaderRecordCursorError,
    );
    // The record moved to a later offset, so its cursor is a few bytes longer
    // and its first page a few bytes shorter; the content is the same field.
    const fresh = await readTurnRecordPage(project, options);
    assert.equal(fresh.value.sha256, first.value.sha256);
    assert.ok(RESPONSE.startsWith(fresh.value.text));
    assert.ok(fresh.value.next_cursor !== undefined);
  });
});

test("an incomplete search names the skipped feeds instead of claiming absence", async () => {
  await withProject(async (project) => {
    const path = join(project, ".barbaro", "feed", "codex", `${SESSION_ID}.jsonl`);
    await writeLine(path, stableJsonLine(turn()));
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: TURN_ID,
        byteBudget: 4096,
        maxFileBytes: 64,
      }),
      (error: unknown) =>
        error instanceof ReaderTurnSearchIncompleteError &&
        !(error instanceof ReaderTurnNotFoundError) &&
        error.turnId === TURN_ID &&
        error.skippedOversizedFeedFiles === 1 &&
        /1 feed file\(s\) exceeded the reader limits/u.test(error.message) &&
        /absence is unproven/u.test(error.message) &&
        /--max-file-bytes or --max-record-bytes/u.test(error.message),
    );
    // A genuinely absent turn with every feed inside the limits stays plain.
    await assert.rejects(
      readTurnRecordPage(project, {
        turnId: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteBudget: 4096,
      }),
      (error: unknown) =>
        error instanceof ReaderTurnNotFoundError &&
        !(error instanceof ReaderTurnSearchIncompleteError),
    );
  });
});

test("a continuation verifies the JSONL framing around its pinned range", async () => {
  await withProject(async (project) => {
    const path = join(project, ".barbaro", "feed", "codex", `${SESSION_ID}.jsonl`);
    const first = stableJsonLine(
      turn({ turn_id: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sequence: 0 }),
    );
    const line = stableJsonLine(turn());
    await writeLine(path, `${first}${line}`);
    const options = {
      turnId: TURN_ID,
      field: "response" as const,
      byteBudget: 1400,
      workstreamId: WORKSTREAM_ID,
    };
    const page = await readTurnRecordPage(project, options);
    const cursor = page.value.next_cursor;
    assert.ok(cursor !== undefined);
    const framing = (error: unknown) =>
      error instanceof ReaderRecordCursorError && /framing/u.test(error.message);

    // CRLF framing is still one whole line.
    await writeFile(path, `${first}${line.replace(/\n$/u, "\r\n")}`, "utf8");
    const crlf = await readTurnRecordPage(project, { ...options, cursor });
    assert.equal(crlf.value.range.start, page.value.range.end);

    // The terminating newline is gone: a fresh reader sees a partial line.
    await writeFile(path, `${first}${line.replace(/\n$/u, "")}`, "utf8");
    await assert.rejects(readTurnRecordPage(project, { ...options, cursor }), framing);

    // The newline became another delimiter: the record is merged.
    await writeFile(path, `${first}${line.replace(/\n$/u, " ")}`, "utf8");
    await assert.rejects(readTurnRecordPage(project, { ...options, cursor }), framing);

    // The bytes are intact but the separator before them is gone.
    await writeFile(path, `${first.replace(/\n$/u, " ")}${line}`, "utf8");
    await assert.rejects(readTurnRecordPage(project, { ...options, cursor }), framing);

    // Restored: the same cursor resumes.
    await writeFile(path, `${first}${line}`, "utf8");
    const resumed = await readTurnRecordPage(project, { ...options, cursor });
    assert.equal(resumed.value.range.start, page.value.range.end);
  });
});
