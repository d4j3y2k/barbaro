import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  ActiveLeaseRevisionConflictError,
  ActiveLeaseStore,
  activeActorFilename,
  type ActiveLeaseIdentity,
  type ActiveLeaseUpdate,
} from "../../src/active/index.js";
import { UnsafeStorePathError } from "../../src/core/safe-store.js";
import {
  DirectoryLockReleaseError,
  withDirectoryLock,
} from "../../src/output/directory-lock.js";

const execFileAsync = promisify(execFile);

const IDENTITY: ActiveLeaseIdentity = {
  lease_id: "lease_0123456789abcdef0123456789abcdef",
  provider: "codex",
  session_id: "ses_fedcba9876543210fedcba9876543210",
  turn_id: "turn_11111111111111111111111111111111",
  agent_id: "main/../../unsafe-looking-but-hashed",
};

function workingUpdate(
  overrides: Partial<ActiveLeaseUpdate> = {},
): ActiveLeaseUpdate {
  return {
    ...IDENTITY,
    state: "working",
    current_action: {
      kind: "command",
      tool_name: "shell",
    },
    claims: [],
    unknown_write_scope: true,
    ...overrides,
  };
}

async function withActiveDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-active-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("atomic actor snapshots preserve unknown write scope", async () => {
  await withActiveDirectory(async (directory) => {
    const now = new Date("2026-08-16T20:00:00.000Z");
    const store = new ActiveLeaseStore(directory, {
      defaultTtlMs: 60_000,
      clock: () => now,
    });

    const lease = await store.write(workingUpdate());
    assert.equal(lease.revision, 1);
    assert.equal(lease.unknown_write_scope, true);
    assert.deepEqual(lease.claims, []);
    assert.equal(lease.expires_at, "2026-08-16T20:01:00.000Z");

    const providerEntries = await readdir(join(directory, "codex"));
    assert.deepEqual(providerEntries, [activeActorFilename(IDENTITY)]);
    assert.deepEqual(await store.readSnapshot(IDENTITY), lease);
  });
});

test("revisions strictly increase under concurrency across store instances", async () => {
  await withActiveDirectory(async (directory) => {
    const stores = [
      new ActiveLeaseStore(directory),
      new ActiveLeaseStore(directory),
    ];
    const writes = Array.from({ length: 32 }, (_, index) =>
      stores[index % stores.length]!.write(
        workingUpdate({ state: index % 2 === 0 ? "working" : "waiting" }),
      ),
    );
    const leases = await Promise.all(writes);
    const revisions = leases.map((lease) => lease.revision).sort((a, b) => a - b);

    assert.deepEqual(
      revisions,
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    assert.equal((await stores[0]!.readSnapshot(IDENTITY))?.revision, 32);

    const providerEntries = await readdir(join(directory, "codex"));
    assert.deepEqual(providerEntries, [activeActorFilename(IDENTITY)]);
  });
});

test("revisions and stale guards serialize across independent processes", async () => {
  await withActiveDirectory(async (directory) => {
    const moduleUrl = new URL(
      "../../src/active/index.js",
      import.meta.url,
    ).href;
    const script = [
      `import { ActiveLeaseRevisionConflictError, ActiveLeaseStore } from ${JSON.stringify(moduleUrl)};`,
      "const directory = process.argv[1];",
      "const expected = process.argv[2] === '-' ? undefined : Number(process.argv[2]);",
      "const store = new ActiveLeaseStore(directory);",
      `const update = ${JSON.stringify(workingUpdate())};`,
      "try {",
      "  const lease = await store.write(update, expected === undefined ? {} : { expectedRevision: expected });",
      "  process.stdout.write(JSON.stringify({ ok: true, revision: lease.revision }));",
      "} catch (error) {",
      "  if (!(error instanceof ActiveLeaseRevisionConflictError)) throw error;",
      "  process.stdout.write(JSON.stringify({ ok: false, actualRevision: error.actualRevision }));",
      "}",
    ].join("\n");

    const runChild = async (wantedRevision?: number): Promise<{
      ok: boolean;
      revision?: number;
      actualRevision?: number;
    }> => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          script,
          directory,
          wantedRevision === undefined ? "-" : String(wantedRevision),
        ],
        { timeout: 15_000 },
      );
      return JSON.parse(stdout) as {
        ok: boolean;
        revision?: number;
        actualRevision?: number;
      };
    };

    const unguarded = await Promise.all(
      Array.from({ length: 12 }, () => runChild()),
    );
    assert.deepEqual(
      unguarded.map((result) => result.revision).sort((a, b) => a! - b!),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.ok(unguarded.every((result) => result.ok));

    const guarded = await Promise.all(
      Array.from({ length: 8 }, () => runChild(12)),
    );
    const winners = guarded.filter((result) => result.ok);
    const stale = guarded.filter((result) => !result.ok);
    assert.deepEqual(winners.map((result) => result.revision), [13]);
    assert.equal(stale.length, 7);
    assert.ok(stale.every((result) => result.actualRevision === 13));

    const store = new ActiveLeaseStore(directory);
    assert.equal((await store.readSnapshot(IDENTITY))?.revision, 13);
    assert.deepEqual(await readdir(join(directory, "codex")), [
      activeActorFilename(IDENTITY),
    ]);
  });
});

test("idle tombstones filter immediately and reject stale guarded updates", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    const working = await store.write(workingUpdate(), {
      now: "2026-08-16T20:00:00.000Z",
    });
    const idle = await store.writeIdle(IDENTITY, {
      expectedRevision: working.revision,
      now: "2026-08-16T20:00:01.000Z",
    });

    assert.equal(idle.state, "idle");
    assert.equal(idle.revision, working.revision + 1);
    assert.deepEqual(idle.claims, []);
    assert.equal(idle.unknown_write_scope, false);
    assert.equal(
      await store.readActive(IDENTITY, "2026-08-16T20:00:02.000Z"),
      undefined,
    );
    assert.deepEqual(
      await store.listActive({ now: "2026-08-16T20:00:02.000Z" }),
      [],
    );

    await assert.rejects(
      store.write(workingUpdate(), {
        expectedRevision: working.revision,
        now: "2026-08-16T20:00:03.000Z",
      }),
      (error: unknown) =>
        error instanceof ActiveLeaseRevisionConflictError &&
        error.actualRevision === idle.revision,
    );
    assert.equal((await store.readSnapshot(IDENTITY))?.state, "idle");
  });
});

test("consumers filter expiry, provider, session, and actor", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 1_000 });
    await store.write(workingUpdate(), {
      now: "2026-08-16T20:00:00.000Z",
    });
    await store.write(
      workingUpdate({
        lease_id: "lease_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        provider: "claude",
        session_id: "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        agent_id: "sidecar",
        unknown_write_scope: false,
        claims: [
          { path: "src/active/store.ts", mode: "write", confidence: "exact" },
        ],
      }),
      { now: "2026-08-16T20:00:00.000Z" },
    );

    assert.equal(
      (await store.listActive({
        provider: "codex",
        now: "2026-08-16T20:00:00.999Z",
      })).length,
      1,
    );
    assert.equal(
      (await store.listActive({
        agentId: "sidecar",
        now: "2026-08-16T20:00:00.999Z",
      }))[0]?.provider,
      "claude",
    );
    assert.deepEqual(
      await store.listActive({ now: "2026-08-16T20:00:01.000Z" }),
      [],
    );
  });
});

test("active consumers order non-ASCII actor IDs by UTF-16 code units", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    const actors = ["\u00E9", "z", "\u{1F600}", "\u{10000}"];
    for (const [index, agent_id] of actors.entries()) {
      await store.write(
        workingUpdate({
          lease_id: `lease_${String(index + 1).repeat(32)}`,
          agent_id,
        }),
        { now: "2026-08-16T20:00:00.000Z" },
      );
    }

    assert.deepEqual(
      (await store.listActive({ now: "2026-08-16T20:00:01.000Z" })).map(
        ({ agent_id }) => agent_id,
      ),
      ["z", "\u00E9", "\u{10000}", "\u{1F600}"],
    );
  });
});

test("symlinked .barbaro/active cannot read or write outside the project", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-active-boundary-project-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-active-boundary-outside-"));
  try {
    const barbaro = join(project, ".barbaro");
    await mkdir(barbaro, { mode: 0o700 });
    await symlink(outside, join(barbaro, "active"), "dir");

    const providerDirectory = join(outside, "codex");
    await mkdir(providerDirectory, { mode: 0o700 });
    const sentinel = join(providerDirectory, activeActorFilename(IDENTITY));
    await writeFile(sentinel, "outside sentinel\n", { mode: 0o600 });
    const store = new ActiveLeaseStore(join(barbaro, "active"));

    await assert.rejects(
      store.readSnapshot(IDENTITY),
      (error: unknown) => error instanceof UnsafeStorePathError,
    );
    await assert.rejects(
      store.write(workingUpdate()),
      (error: unknown) => error instanceof UnsafeStorePathError,
    );
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel\n");
    assert.deepEqual(await readdir(providerDirectory), [activeActorFilename(IDENTITY)]);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reap deletes only idle tombstones expired beyond every writer's lifetime", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    // Idle and expired for more than a day: reapable.
    await store.writeIdle(IDENTITY, { now: "2026-08-16T20:00:00.000Z" });
    // Idle but expired for less than a day: kept.
    await store.writeIdle(
      { ...IDENTITY, lease_id: "lease_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agent_id: "recent" },
      { now: "2026-08-17T21:00:00.000Z" },
    );
    // Long-expired but still claiming work: never deleted, no matter how
    // stale — a delayed writer over a deleted actor restarts at revision 1.
    await store.write(
      workingUpdate({
        lease_id: "lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        agent_id: "wedged",
      }),
      { now: "2026-08-16T20:00:00.000Z" },
    );

    const reaped = await store.reapExpiredIdle("2026-08-17T22:00:00.000Z");
    assert.equal(reaped, 1);

    assert.equal(await store.readSnapshot(IDENTITY), undefined);
    assert.equal(
      (await store.readSnapshot({ ...IDENTITY, agent_id: "recent" }))?.state,
      "idle",
    );
    assert.equal(
      (await store.readSnapshot({ ...IDENTITY, agent_id: "wedged" }))?.state,
      "working",
    );

    // Idempotent: a second sweep finds nothing.
    assert.equal(await store.reapExpiredIdle("2026-08-17T22:00:00.000Z"), 0);
  });
});

test("update decides on the in-lock snapshot and never conflicts", async () => {
  await withActiveDirectory(async (directory) => {
    const stores = [
      new ActiveLeaseStore(directory),
      new ActiveLeaseStore(directory),
    ];
    const settled = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        stores[index % stores.length]!.update(IDENTITY, (previous) => ({
          write: workingUpdate({
            state: (previous?.revision ?? 0) % 2 === 0 ? "working" : "waiting",
          }),
        })),
      ),
    );

    const revisions = settled
      .map((result) => result.lease?.revision)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(
      revisions,
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    assert.equal((await stores[0]!.readSnapshot(IDENTITY))?.revision, 32);
  });
});

test("update carries the decision's view of previous forward atomically", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    const intent = {
      text: "keep me",
      fidelity: "verbatim",
      truncated: false,
      redactions: [],
    } as const;
    await store.write(workingUpdate({ intent }), {
      now: "2026-08-16T20:00:00.000Z",
    });

    const settled = await store.update(
      IDENTITY,
      (previous) => ({
        write: workingUpdate({
          state: "waiting",
          ...(previous?.intent ? { intent: previous.intent } : {}),
        }),
      }),
      { now: "2026-08-16T20:00:01.000Z" },
    );

    assert.equal(settled.lease?.revision, 2);
    assert.equal(settled.lease?.state, "waiting");
    assert.deepEqual(settled.lease?.intent, intent);
  });
});

test("update returns a committed lease when only lock cleanup fails", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    let observed: unknown;
    const settled = await store.update(
      IDENTITY,
      async () => {
        await writeFile(
          join(`${store.actorPath(IDENTITY)}.lock`, "prevent-release"),
          "held\n",
        );
        return { write: workingUpdate() };
      },
      {
        now: "2026-08-16T20:00:00.000Z",
        onLockReleaseFailure: (error) => {
          observed = error;
          throw new Error("observer failure must not replace a commit");
        },
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(observed instanceof Error);
    assert.equal(settled.lease?.revision, 1);
    assert.deepEqual(await store.readSnapshot(IDENTITY), settled.lease);
  });
});

test("a committed lease does not wait for its release observer", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    let observerStarted = false;
    const settled = await Promise.race([
      store.update(
        IDENTITY,
        async () => {
          await writeFile(
            join(`${store.actorPath(IDENTITY)}.lock`, "prevent-release"),
            "held\n",
          );
          return { write: workingUpdate() };
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
          () => reject(new Error("committed update waited for its observer")),
          250,
        );
      }),
    ]);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observerStarted, true);
    assert.equal(settled.lease?.revision, 1);
  });
});

test("a nested release error cannot impersonate the active actor lock", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    const nestedPath = join(directory, "nested.json");
    let observerCalled = false;
    await assert.rejects(
      store.update(
        IDENTITY,
        async () => {
          await withDirectoryLock(nestedPath, async () => {
            await writeFile(nestedPath, "nested commit\n", "utf8");
            await writeFile(
              join(`${nestedPath}.lock`, "prevent-release"),
              "held\n",
            );
            return "nested result";
          });
          return { write: workingUpdate() };
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
    assert.equal(await store.readSnapshot(IDENTITY), undefined);
  });
});

test("update ignore leaves the stored lease untouched", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    const idle = await store.writeIdle(IDENTITY, {
      now: "2026-08-16T20:00:00.000Z",
    });

    const settled = await store.update(IDENTITY, (previous) =>
      previous?.state === "idle"
        ? { ignore: "stale event after idle" }
        : { write: workingUpdate() },
    );

    assert.equal(settled.lease, undefined);
    assert.equal(settled.ignored, "stale event after idle");
    assert.deepEqual(await store.readSnapshot(IDENTITY), idle);
  });
});

test("update refuses a write that targets a different actor", async () => {
  await withActiveDirectory(async (directory) => {
    const store = new ActiveLeaseStore(directory, { defaultTtlMs: 60_000 });
    await assert.rejects(
      store.update(IDENTITY, () => ({
        write: workingUpdate({
          session_id: "ses_00000000000000000000000000000000",
        }),
      })),
      /must target the locked actor/u,
    );
    assert.equal(await store.readSnapshot(IDENTITY), undefined);
  });
});
