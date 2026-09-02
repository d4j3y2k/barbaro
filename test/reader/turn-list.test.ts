import assert from "node:assert/strict";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import {
  UnsafeStorePathError,
} from "../../src/core/safe-store.js";
import { stableJsonLine, stableStringify } from "../../src/core/stable-json.js";
import {
  readProjectTurnList,
  ReaderTurnListSnapshotError,
} from "../../src/reader/turn-list.js";
import { snapshotTree } from "../setup/fixture.js";

const WS_ALPHA = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WS_BETA = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CODEX_SESSION = "ses_11111111111111111111111111111111";
const CLAUDE_SESSION = "ses_22222222222222222222222222222222";
const SOURCE_REF = { trace_id: "fixture:turn-list" } as const;

function content(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function turn(
  seed: number,
  options: {
    readonly provider?: "codex" | "claude";
    readonly sessionId?: string;
    readonly workstreamId?: string;
    readonly endedAt?: string;
    readonly response?: string | null;
    readonly actions?: number;
    readonly evidenceRefs?: number;
  } = {},
): BarbaroTurnV1 {
  const provider = options.provider ?? "codex";
  const sessionId = options.sessionId ?? CODEX_SESSION;
  const response = options.response === null
    ? {}
    : { response: content(options.response ?? `response ${seed} 😀`) };
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${seed.toString(16).padStart(32, "0")}`,
    provider,
    session_id: sessionId,
    ...(options.workstreamId === undefined
      ? {}
      : { workstream_id: options.workstreamId }),
    sequence: seed,
    agent_id: "main",
    started_at: "2026-08-31T12:00:00.000Z",
    ended_at:
      options.endedAt ??
      new Date(Date.parse("2026-08-31T12:00:00.000Z") + seed * 60_000)
        .toISOString(),
    outcome: "success",
    request: content(`request ${seed} é`),
    ...response,
    actions: Array.from({ length: options.actions ?? 0 }, (_, index) => ({
      action_id: `act_${(seed * 100 + index).toString(16).padStart(32, "0")}`,
      kind: "file_change" as const,
      outcome: "success" as const,
      operation: "modify" as const,
      path: `src/file-${seed}-${index}.ts`,
      source_refs: [SOURCE_REF],
    })),
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: Array.from(
      { length: options.evidenceRefs ?? 0 },
      (_, index) => `ev_${(seed * 100 + index).toString(16).padStart(32, "0")}`,
    ),
    source_refs: [SOURCE_REF],
  };
}

async function temporaryProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-turn-list-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

function feedPath(project: string, record: BarbaroTurnV1): string {
  return join(
    project,
    ".barbaro",
    "feed",
    record.provider,
    `${record.session_id}.jsonl`,
  );
}

async function appendTurn(project: string, record: BarbaroTurnV1): Promise<void> {
  const path = feedPath(project, record);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, stableJsonLine(record), "utf8");
}

async function addEmptyFeeds(project: string, count: number): Promise<void> {
  const directory = join(project, ".barbaro", "feed", "codex");
  await mkdir(directory, { recursive: true });
  for (let seed = 2; seed < count + 2; seed += 1) {
    const sessionId = `ses_${seed.toString(16).padStart(32, "0")}`;
    await writeFile(join(directory, `${sessionId}.jsonl`), "", "utf8");
  }
}

test("turn list pages the exact pinned scoped history without writes", async () => {
  await temporaryProject(async (project) => {
    const alpha = Array.from({ length: 14 }, (_, index) =>
      turn(index + 1, {
        provider: index % 2 === 0 ? "codex" : "claude",
        sessionId: index % 2 === 0 ? CODEX_SESSION : CLAUDE_SESSION,
        workstreamId: WS_ALPHA,
        actions: index % 3,
        evidenceRefs: index % 2,
        ...(index === 0 ? { response: null } : {}),
      }),
    );
    const beta = turn(100, {
      workstreamId: WS_BETA,
      endedAt: "2026-08-31T14:00:00.000Z",
    });
    for (const record of [...alpha, beta]) await appendTurn(project, record);

    const before = await snapshotTree(project);
    const first = await readProjectTurnList(project, {
      byteBudget: 4096,
      workstreamId: WS_ALPHA,
    });
    const replay = await readProjectTurnList(project, {
      byteBudget: 4096,
      workstreamId: WS_ALPHA,
    });
    assert.deepEqual(replay, first);
    assert.equal(await snapshotTree(project), before);
    assert.deepEqual(first.value.scope, {
      kind: "workstream",
      workstream_id: WS_ALPHA,
    });
    assert.equal(first.value.range.start, 0);
    assert.equal(first.value.range.end, first.value.turns.shown);
    assert.deepEqual(first.value.diagnostics, {
      malformed_feed_records: 0,
      invalid_feed_records: 0,
      skipped_oversized_feed_files: 0,
    });
    assert.equal(
      Buffer.byteLength(stableStringify(first), "utf8"),
      first.utf8_bytes,
    );

    const listed = [...first.value.turns.items];
    let cursor: string | undefined = first.value.turns.next_cursor;
    assert.ok(cursor !== undefined, "fixture must require pagination");
    await appendTurn(
      project,
      turn(101, {
        workstreamId: WS_ALPHA,
        endedAt: "2026-08-31T15:00:00.000Z",
      }),
    );
    while (cursor !== undefined) {
      const page = await readProjectTurnList(project, {
        byteBudget: 4096,
        workstreamId: WS_ALPHA,
        cursor,
      });
      assert.equal(page.value.range.start, listed.length);
      listed.push(...page.value.turns.items);
      assert.equal(page.value.range.end, listed.length);
      assert.equal(page.value.complete, page.value.turns.next_cursor === undefined);
      cursor = page.value.turns.next_cursor;
    }

    assert.deepEqual(
      listed.map((entry) => entry.turn_id),
      [...alpha].reverse().map((record) => record.turn_id),
    );
    assert.equal(new Set(listed.map((entry) => entry.turn_id)).size, alpha.length);
    assert.ok(!listed.some((entry) => entry.turn_id === beta.turn_id));
    assert.ok(!listed.some((entry) => entry.turn_id === turn(101).turn_id));
    assert.equal(listed.at(-1)?.response_utf8_bytes, undefined);
    assert.equal(listed[1]?.action_count, alpha.at(-2)?.actions.length);
    assert.equal(
      listed[1]?.evidence_ref_count,
      alpha.at(-2)?.evidence_refs.length,
    );
  });
});

test("turn-list diagnostics are complete and pinned across pages", async () => {
  await temporaryProject(async (project) => {
    const included = Array.from({ length: 8 }, (_, index) =>
      turn(index + 1, { workstreamId: WS_ALPHA }),
    );
    for (const record of included) await appendTurn(project, record);

    const includedPath = feedPath(project, included[0]!);
    await appendFile(includedPath, "not-json\n", "utf8");
    await appendFile(
      includedPath,
      `${stableStringify({ schema: "not-a-turn" })}\n`,
      "utf8",
    );
    const maxFileBytes = (await stat(includedPath)).size;
    const maxRecordBytes = Math.max(
      ...included.map((record) =>
        Buffer.byteLength(stableStringify(record), "utf8")
      ),
    );

    await appendTurn(
      project,
      turn(100, {
        provider: "claude",
        sessionId: CLAUDE_SESSION,
        workstreamId: WS_ALPHA,
        response: "x".repeat(maxFileBytes),
      }),
    );
    await appendTurn(
      project,
      turn(101, {
        provider: "codex",
        sessionId: "ses_33333333333333333333333333333333",
        workstreamId: WS_ALPHA,
        response: "r".repeat(maxRecordBytes),
      }),
    );

    const options = {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
      maxFileBytes,
      maxRecordBytes,
    } as const;
    const first = await readProjectTurnList(project, options);
    const replay = await readProjectTurnList(project, options);
    assert.deepEqual(replay, first);
    assert.deepEqual(first.value.diagnostics, {
      malformed_feed_records: 1,
      invalid_feed_records: 1,
      skipped_oversized_feed_files: 2,
    });
    assert.ok(first.value.turns.next_cursor !== undefined);

    const listed = [...first.value.turns.items];
    let cursor: string | undefined = first.value.turns.next_cursor;
    while (cursor !== undefined) {
      const page = await readProjectTurnList(project, { ...options, cursor });
      assert.deepEqual(page.value.diagnostics, first.value.diagnostics);
      listed.push(...page.value.turns.items);
      cursor = page.value.turns.next_cursor;
    }
    assert.deepEqual(
      listed.map((entry) => entry.turn_id),
      [...included].reverse().map((record) => record.turn_id),
    );
  });
});

test("pinned continuation ignores later bytes beyond maxFileBytes", async () => {
  await temporaryProject(async (project) => {
    const pinned = Array.from({ length: 8 }, (_, index) =>
      turn(index + 1, { workstreamId: WS_ALPHA }),
    );
    for (const record of pinned) await appendTurn(project, record);
    const path = feedPath(project, pinned[0]!);
    const maxFileBytes = (await stat(path)).size;
    const options = {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
      maxFileBytes,
    } as const;

    const first = await readProjectTurnList(project, options);
    assert.ok(first.value.turns.next_cursor !== undefined);
    await appendTurn(project, turn(100, { workstreamId: WS_ALPHA }));
    assert.ok((await stat(path)).size > maxFileBytes);

    const listed = [...first.value.turns.items];
    let cursor: string | undefined = first.value.turns.next_cursor;
    while (cursor !== undefined) {
      const page = await readProjectTurnList(project, { ...options, cursor });
      assert.deepEqual(page.value.diagnostics, {
        malformed_feed_records: 0,
        invalid_feed_records: 0,
        skipped_oversized_feed_files: 0,
      });
      listed.push(...page.value.turns.items);
      cursor = page.value.turns.next_cursor;
    }
    assert.deepEqual(
      listed.map((entry) => entry.turn_id),
      [...pinned].reverse().map((record) => record.turn_id),
    );
    assert.ok(!listed.some((entry) => entry.turn_id === turn(100).turn_id));
  });
});

test("turn-list cursors reject corruption and foreign bindings", async () => {
  const firstProject = await mkdtemp(join(tmpdir(), "barbaro-turn-list-first-"));
  const secondProject = await mkdtemp(join(tmpdir(), "barbaro-turn-list-second-"));
  try {
    for (let seed = 1; seed <= 8; seed += 1) {
      const record = turn(seed, { workstreamId: WS_ALPHA });
      await appendTurn(firstProject, record);
      await appendTurn(secondProject, record);
    }
    const first = await readProjectTurnList(firstProject, {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
    });
    const cursor = first.value.turns.next_cursor;
    assert.ok(cursor !== undefined);

    await assert.rejects(
      readProjectTurnList(firstProject, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        cursor: "not-a-cursor",
      }),
      (error: unknown) => error instanceof TypeError,
    );
    const position = Math.floor(cursor.length / 2);
    const replacement = cursor[position] === "A" ? "B" : "A";
    const corrupted = `${cursor.slice(0, position)}${replacement}${cursor.slice(position + 1)}`;
    await assert.rejects(
      readProjectTurnList(firstProject, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        cursor: corrupted,
      }),
      (error: unknown) => error instanceof TypeError,
    );
    await assert.rejects(
      readProjectTurnList(secondProject, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        cursor,
      }),
      (error: unknown) => error instanceof RangeError,
    );
    await assert.rejects(
      readProjectTurnList(firstProject, {
        byteBudget: 2200,
        workstreamId: WS_BETA,
        cursor,
      }),
      (error: unknown) => error instanceof RangeError,
    );
    await assert.rejects(
      readProjectTurnList(firstProject, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        maxRecordBytes: 1024,
        cursor,
      }),
      (error: unknown) => error instanceof RangeError,
    );
  } finally {
    await rm(firstProject, { recursive: true, force: true });
    await rm(secondProject, { recursive: true, force: true });
  }
});

test("a constrained successful list page always advances", async () => {
  await temporaryProject(async (project) => {
    for (let seed = 1; seed <= 6; seed += 1) {
      await appendTurn(project, turn(seed, { workstreamId: WS_ALPHA }));
    }
    await addEmptyFeeds(project, 34);
    const first = await readProjectTurnList(project, {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
    });
    assert.ok(first.value.turns.shown >= 1);
    assert.ok(first.value.range.end > first.value.range.start);
    assert.ok(first.value.turns.next_cursor !== undefined);

    const second = await readProjectTurnList(project, {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
      cursor: first.value.turns.next_cursor,
    });
    assert.ok(second.value.turns.shown >= 1);
    assert.equal(second.value.range.start, first.value.range.end);
    assert.ok(second.value.range.end > second.value.range.start);
  });
});

test("a fitting complete page is not rejected by unnecessary cursor state", async () => {
  await temporaryProject(async (project) => {
    await appendTurn(project, turn(1, { workstreamId: WS_ALPHA }));
    await appendTurn(project, turn(2, { workstreamId: WS_ALPHA }));
    // The first-item partial form would have to describe every feed, while
    // the two-item complete form needs no cursor at all.
    await addEmptyFeeds(project, 128);

    const page = await readProjectTurnList(project, {
      byteBudget: 1200,
      workstreamId: WS_ALPHA,
    });
    assert.equal(page.value.turns.shown, 2);
    assert.equal(page.value.complete, true);
    assert.equal(page.value.turns.next_cursor, undefined);
    assert.ok(page.utf8_bytes <= page.byte_budget);
  });
});

test("a rewritten pinned prefix fails closed instead of restarting", async () => {
  await temporaryProject(async (project) => {
    for (let seed = 1; seed <= 8; seed += 1) {
      await appendTurn(project, turn(seed, { workstreamId: WS_ALPHA }));
    }
    const first = await readProjectTurnList(project, {
      byteBudget: 2200,
      workstreamId: WS_ALPHA,
    });
    const cursor = first.value.turns.next_cursor;
    assert.ok(cursor !== undefined);
    const path = feedPath(project, turn(1));
    const bytes = await readFile(path);
    bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61;
    await writeFile(path, bytes);

    await assert.rejects(
      readProjectTurnList(project, {
        byteBudget: 2200,
        workstreamId: WS_ALPHA,
        cursor,
      }),
      (error: unknown) => error instanceof ReaderTurnListSnapshotError,
    );
  });
});

test("turn list retains canonical feed path and size protections", async (t) => {
  await t.test("symbolic link", async () => {
    const project = await mkdtemp(join(tmpdir(), "barbaro-turn-list-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "barbaro-turn-list-outside-"));
    try {
      const record = turn(1, { workstreamId: WS_ALPHA });
      const path = feedPath(project, record);
      const target = join(outside, "feed.jsonl");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(target, stableJsonLine(record));
      await symlink(target, path, "file");
      await assert.rejects(
        readProjectTurnList(project, { byteBudget: 4096 }),
        (error: unknown) => error instanceof UnsafeStorePathError,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("hard link", async () => {
    const project = await mkdtemp(join(tmpdir(), "barbaro-turn-list-hardlink-"));
    const outside = await mkdtemp(join(tmpdir(), "barbaro-turn-list-outside-"));
    try {
      const record = turn(1, { workstreamId: WS_ALPHA });
      const path = feedPath(project, record);
      const target = join(outside, "feed.jsonl");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(target, stableJsonLine(record));
      await link(target, path);
      await assert.rejects(
        readProjectTurnList(project, { byteBudget: 4096 }),
        (error: unknown) => error instanceof UnsafeStorePathError,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("file and record limits", async () => {
    await temporaryProject(async (project) => {
      const record = turn(1, {
        workstreamId: WS_ALPHA,
        response: "x".repeat(2048),
      });
      await appendTurn(project, record);
      const skipped = await readProjectTurnList(project, {
        byteBudget: 4096,
        maxFileBytes: 512,
      });
      assert.equal(skipped.value.turns.total, 0);
      assert.equal(skipped.value.diagnostics.skipped_oversized_feed_files, 1);
      const recordSkipped = await readProjectTurnList(project, {
        byteBudget: 4096,
        maxRecordBytes: 512,
      });
      assert.equal(recordSkipped.value.turns.total, 0);
      assert.equal(
        recordSkipped.value.diagnostics.skipped_oversized_feed_files,
        1,
      );
    });
  });
});
