import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JSONL_CHECKPOINT_SCHEMA } from "../../src/core/checkpoint.js";
import {
  DirectoryLockReleaseError,
  withDirectoryLock,
} from "../../src/output/directory-lock.js";
import {
  NUDGE_CURSOR_SCHEMA,
  NudgeCursorStateStore,
  NudgeCursorTooLargeError,
  type NudgeCursorV2,
} from "../../src/nudge/index.js";

const SELF_SESSION = `ses_${"f".repeat(32)}`;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("a committed cursor result survives lock cleanup failure", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-nudge-store-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new NudgeCursorStateStore(project);
  const cursor: NudgeCursorV2 = {
    schema: NUDGE_CURSOR_SCHEMA,
    provider: "codex",
    session_id: SELF_SESSION,
    workstream_id: `ws_${"a".repeat(32)}`,
    membership_from: "2026-08-23T10:00:00.000Z",
    cursor_revision: 1,
    feed_cursors: [],
    markers: { stop: 1 },
    delivery: {
      highest_unread_count: 1,
      last_turn: { kind: "codex", turn_id: `turn_${"1".repeat(32)}` },
    },
    updated_at: "2026-08-23T10:00:01.000Z",
  };
  let observed: unknown;
  const result = await store.withHookWrite(
    "codex",
    SELF_SESSION,
    async () => {
      await writeFile(
        join(`${store.cursorPath("codex", SELF_SESSION)}.lock`, "prevent-release"),
        "held\n",
      );
      return { state: cursor, result: { receipt: "committed" } as const };
    },
    {
      onLockReleaseFailure: (error) => {
        observed = error;
        throw new Error("observer failure must not replace a commit");
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(observed instanceof Error);
  assert.deepEqual(result, { receipt: "committed" });
  assert.deepEqual(await store.read("codex", SELF_SESSION), cursor);
});

test("a committed cursor does not wait for its release observer", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-nudge-store-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new NudgeCursorStateStore(project);
  const cursor: NudgeCursorV2 = {
    schema: NUDGE_CURSOR_SCHEMA,
    provider: "codex",
    session_id: SELF_SESSION,
    workstream_id: `ws_${"a".repeat(32)}`,
    membership_from: "2026-08-23T10:00:00.000Z",
    cursor_revision: 1,
    feed_cursors: [],
    markers: {},
    delivery: { highest_unread_count: 0 },
    updated_at: "2026-08-23T10:00:01.000Z",
  };
  let observerStarted = false;
  const result = await Promise.race([
    store.withHookWrite(
      "codex",
      SELF_SESSION,
      async () => {
        await writeFile(
          join(`${store.cursorPath("codex", SELF_SESSION)}.lock`, "prevent-release"),
          "held\n",
        );
        return { state: cursor, result: "committed" as const };
      },
      {
        onLockReleaseFailure: () => {
          observerStarted = true;
          return new Promise<void>(() => undefined);
        },
      },
    ),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("committed cursor waited for its observer")),
        250,
      );
    }),
  ]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observerStarted, true);
  assert.equal(result, "committed");
});

test("a nested release error cannot impersonate the cursor lock", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-nudge-store-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new NudgeCursorStateStore(project);
  const nestedPath = join(project, ".barbaro", "state", "nested.json");
  let observerCalled = false;

  await assert.rejects(
    store.withHookWrite(
      "codex",
      SELF_SESSION,
      async () => {
        await withDirectoryLock(nestedPath, async () => {
          await writeFile(nestedPath, "nested commit\n", "utf8");
          await writeFile(
            join(`${nestedPath}.lock`, "prevent-release"),
            "held\n",
          );
          return "nested result";
        });
        return { result: "unreachable" };
      },
      {
        onLockReleaseFailure: () => {
          observerCalled = true;
        },
      },
    ),
    (error: unknown) =>
      error instanceof DirectoryLockReleaseError &&
      error.resourcePath === nestedPath,
  );
  assert.equal(observerCalled, false);
  assert.equal(await store.read("codex", SELF_SESSION), undefined);
});

test("a hook writer cannot persist a cursor larger than its own read bound", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-nudge-store-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new NudgeCursorStateStore(project);
  const feedCursors: NudgeCursorV2["feed_cursors"] = Array.from(
    { length: 4_000 },
    (_, index) => ({
    provider: "claude",
    session_id: `ses_${index.toString(16).padStart(32, "0")}`,
    checkpoint: {
      schema: JSONL_CHECKPOINT_SCHEMA,
      file_identity: {
        device: "1",
        inode: String(index + 1),
        birthtime_ns: "1",
      },
      byte_offset: 0,
      next_line_number: 1,
      observed_size: 0,
      anchor: { byte_length: 0, sha256: EMPTY_SHA256 },
    },
    }),
  );
  const oversized: NudgeCursorV2 = {
    schema: NUDGE_CURSOR_SCHEMA,
    provider: "codex",
    session_id: SELF_SESSION,
    workstream_id: `ws_${"a".repeat(32)}`,
    membership_from: "2026-08-23T10:00:00.000Z",
    cursor_revision: 1,
    feed_cursors: feedCursors,
    markers: {},
    delivery: { highest_unread_count: 0 },
    updated_at: "2026-08-23T10:00:00.000Z",
  };

  await assert.rejects(
    store.withHookWrite("codex", SELF_SESSION, async () => ({
      state: oversized,
      result: undefined,
    })),
    (error: unknown) => error instanceof NudgeCursorTooLargeError,
  );
  assert.equal(await store.read("codex", SELF_SESSION), undefined);
});
