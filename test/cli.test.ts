import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { main } from "../src/cli.js";
import { createSessionId } from "../src/core/id.js";
import { admitHookSession } from "../src/hooks/participation.js";

const execFileAsync = promisify(execFile);

test("the built CLI runs when process.argv[1] is an npm-style symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-cli-link-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const builtCli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const linkedCli = join(directory, "barbaro");
  await symlink(builtCli, linkedCli, "file");

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [linkedCli, "--help"],
    { timeout: 10_000 },
  );
  assert.match(stdout, /^barbaro\n/);
  assert.match(stdout, /barbaro codex hook-ingest/);
  assert.equal(stderr, "");
});

test("the executable reports its package version and uses exit 2 for usage errors", async () => {
  const builtCli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly version: string;
  };
  const version = await execFileAsync(
    process.execPath,
    [builtCli, "--version"],
    { timeout: 10_000 },
  );
  assert.equal(version.stdout, `${manifest.version}\n`);
  assert.equal(version.stderr, "");

  const usageErrors: readonly {
    readonly args: readonly string[];
    readonly message: RegExp;
  }[] = [
    { args: ["not-a-command"], message: /Unknown command/u },
    { args: ["not-a-command", "--help"], message: /Unknown command/u },
    { args: ["workstream"], message: /Unknown workstream command/u },
    { args: ["workstream", "bogus"], message: /Unknown workstream command/u },
    { args: ["workstream", "show"], message: /Usage: barbaro workstream show/u },
    { args: ["workstream", "new", "Bad_Name"], message: /invalid workstream name/u },
    { args: ["context", "--project-root"], message: /Missing value/u },
    {
      args: ["context", "--provider", "codex"],
      message: /--provider and --session-id must be supplied together/u,
    },
    { args: ["context", "--unknown"], message: /Unknown flag/u },
  ];

  for (const { args, message } of usageErrors) {
    await assert.rejects(
      execFileAsync(process.execPath, [builtCli, ...args], { timeout: 10_000 }),
      (error: unknown) => {
        const failure = error as Error & {
          readonly code?: number;
          readonly stdout?: string;
          readonly stderr?: string;
        };
        assert.equal(failure.code, 2, args.join(" "));
        assert.equal(failure.stdout, "", args.join(" "));
        assert.match(failure.stderr ?? "", message, args.join(" "));
        return true;
      },
    );
  }
});

test("session status is read-only and reports the derived current-session key", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-status-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const nativeSessionId = "status-session";
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
  };

  assert.equal(
    await main(
      [
        "codex",
        "status",
        "--session-id",
        nativeSessionId,
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  assert.deepEqual(JSON.parse(output.pop()!), {
    provider: "codex",
    session_id: createSessionId("codex", nativeSessionId),
    joined: false,
  });

  await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new lane",
  });
  assert.equal(
    await main(
      [
        "codex",
        "status",
        "--session-id",
        nativeSessionId,
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  const joined = JSON.parse(output.pop()!) as Record<string, unknown>;
  assert.equal(joined.joined, true);
  assert.equal(joined.session_id, createSessionId("codex", nativeSessionId));
  assert.equal(typeof joined.joined_at, "string");
  assert.deepEqual(joined.memberships, [
    {
      workstream_id: (joined.workstream as { workstream_id: string })
        .workstream_id,
      from: joined.joined_at,
    },
  ]);
  assert.deepEqual(errors, []);
});

test("workstream commands create, list, and show; status names the workstream", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-ws-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: (text: string) => {
      errors.push(text);
    },
  };

  assert.equal(await main(["workstream", "list", "--project-root", project], io), 0);
  assert.deepEqual(JSON.parse(output.pop()!), {
    workstreams: [],
    shown: 0,
    total: 0,
    invalid_records: 0,
  });

  assert.equal(
    await main(
      ["workstream", "new", "tui-design", "--title", "Control terminal", "--project-root", project],
      io,
    ),
    0,
  );
  const created = JSON.parse(output.pop()!) as {
    workstream_id: string;
    name: string;
    title: string;
    status: string;
    created_by: unknown;
  };
  assert.match(created.workstream_id, /^ws_[0-9a-f]{32}$/u);
  assert.equal(created.name, "tui-design");
  assert.equal(created.title, "Control terminal");
  assert.equal(created.status, "open");
  assert.deepEqual(created.created_by, { kind: "cli" });

  assert.equal(await main(["workstream", "new", "tui-design", "--project-root", project], io), 1);
  assert.match(errors.pop()!, /already exists/u);
  assert.equal(await main(["workstream", "new", "Bad Name", "--project-root", project], io), 2);
  assert.match(errors.pop()!, /invalid workstream name/u);

  assert.equal(await main(["workstream", "show", "tui-design", "--project-root", project], io), 0);
  assert.equal(
    (JSON.parse(output.pop()!) as { workstream_id: string }).workstream_id,
    created.workstream_id,
  );
  assert.equal(await main(["workstream", "show", "nope", "--project-root", project], io), 1);
  assert.match(errors.pop()!, /no workstream named "nope"/u);

  await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: "member",
    event: "UserPromptSubmit",
    prompt: "/barbaro join tui-design",
  });
  assert.equal(
    await main(["claude", "status", "--session-id", "member", "--project-root", project], io),
    0,
  );
  const status = JSON.parse(output.pop()!) as {
    joined: boolean;
    joined_at: string;
    workstream?: { workstream_id: string; name: string; status: string };
    memberships: { workstream_id: string; from: string }[];
    unscoped?: boolean;
  };
  assert.equal(status.joined, true);
  assert.deepEqual(status.workstream, {
    workstream_id: created.workstream_id,
    name: "tui-design",
    status: "open",
  });
  assert.deepEqual(status.memberships, [
    { workstream_id: created.workstream_id, from: status.joined_at },
  ]);
  assert.equal(status.unscoped, undefined);

  assert.equal(
    await main(["workstream", "new", "next", "--project-root", project], io),
    0,
  );
  const next = JSON.parse(output.pop()!) as { workstream_id: string };
  await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: "member",
    event: "UserPromptSubmit",
    prompt: "/barbaro join next",
  });
  assert.equal(
    await main(["claude", "status", "--session-id", "member", "--project-root", project], io),
    0,
  );
  const movedStatus = JSON.parse(output.pop()!) as {
    workstream: { workstream_id: string; name: string; status: string };
    memberships: { workstream_id: string; from: string }[];
  };
  assert.deepEqual(movedStatus.workstream, {
    workstream_id: next.workstream_id,
    name: "next",
    status: "open",
  });
  assert.deepEqual(
    movedStatus.memberships.map((membership) => membership.workstream_id),
    [created.workstream_id, next.workstream_id],
  );

  assert.equal(await main(["workstream", "list", "--project-root", project], io), 0);
  const listed = JSON.parse(output.pop()!) as {
    shown: number;
    total: number;
    workstreams: { name: string }[];
  };
  assert.equal(listed.shown, 2);
  assert.equal(listed.total, 2);
  assert.deepEqual(
    listed.workstreams.map((workstream) => workstream.name).sort(),
    ["next", "tui-design"],
  );
  assert.deepEqual(errors, []);
});

test("context and watch scope to the session's workstream", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-scope-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: (text: string) => {
      errors.push(text);
    },
  };
  assert.equal(await main(["workstream", "new", "lane", "--project-root", project], io), 0);
  const created = JSON.parse(output.pop()!) as { workstream_id: string };
  await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId: "scoped",
    event: "UserPromptSubmit",
    prompt: "/barbaro join lane",
  });
  const scopeOf = (line: string): string | undefined =>
    (JSON.parse(line) as { value: { workstream_id?: string } }).value.workstream_id;

  assert.equal(
    await main(["context", "--provider", "claude", "--session-id", "scoped", "--project-root", project], io),
    0,
  );
  assert.equal(scopeOf(output.pop()!), created.workstream_id);
  assert.equal(await main(["context", "--workstream", "lane", "--project-root", project], io), 0);
  assert.equal(scopeOf(output.pop()!), created.workstream_id);
  assert.equal(
    await main(
      ["context", "--provider", "claude", "--session-id", "scoped", "--all-workstreams", "--project-root", project],
      io,
    ),
    0,
  );
  assert.equal(scopeOf(output.pop()!), undefined);
  await assert.rejects(
    main(["context", "--workstream", "nope", "--project-root", project], io),
    /no workstream named "nope"/u,
  );

  assert.equal(
    await main(
      ["watch", "--once", "--json", "--provider", "claude", "--session-id", "scoped", "--project-root", project],
      io,
    ),
    0,
  );
  const armed = JSON.parse(output.shift()!) as { kind: string; workstream_id?: string };
  assert.equal(armed.kind, "armed");
  assert.equal(armed.workstream_id, created.workstream_id);
  assert.deepEqual(errors, []);
});

test("workstream lifecycle verbs warn about presence and flag the listing", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-lifecycle-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
  };

  // Create the workstream and enroll one session in it.
  const nativeSessionId = "lifecycle-session";
  const sessionId = createSessionId("codex", nativeSessionId);
  await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new lane",
  });
  assert.equal(
    await main(["workstream", "show", "lane", "--project-root", project], io),
    0,
  );
  const record = JSON.parse(output.pop()!) as {
    workstream_id: string;
    status: string;
  };
  assert.equal(record.status, "open");

  // The member holds an unexpired working main lease: completing must warn
  // on stderr, never block, and still perform the reversible transition.
  const { ActiveLeaseStore } = await import("../src/active/store.js");
  await new ActiveLeaseStore(join(project, ".barbaro", "active")).write(
    {
      lease_id: `lease_${"c".repeat(32)}`,
      provider: "codex",
      session_id: sessionId,
      agent_id: "main",
      workstream_id: record.workstream_id,
      state: "working",
      claims: [],
      unknown_write_scope: false,
    },
    { now: Date.now(), ttlMs: 600_000 },
  );

  assert.equal(
    await main(["workstream", "complete", "lane", "--project-root", project], io),
    0,
  );
  const completed = JSON.parse(output.pop()!) as {
    status: string;
    revision: number;
  };
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 2);
  const warning = errors.join("");
  assert.match(warning, new RegExp(`codex/${sessionId} is live in "lane"`, "u"));
  assert.match(warning, /completion does not stop it/u);
  errors.length = 0;

  // Default listing retains the completed-but-live record, flagged; --all
  // stays complete and carries the same flag.
  assert.equal(
    await main(["workstream", "list", "--project-root", project], io),
    0,
  );
  const listed = JSON.parse(output.pop()!) as {
    workstreams: Array<{ workstream_id: string; completed_presence?: string }>;
    shown: number;
    total: number;
  };
  assert.equal(listed.total, 1);
  assert.equal(listed.shown, 1);
  assert.equal(listed.workstreams[0]!.completed_presence, "live");
  assert.equal(
    await main(["workstream", "list", "--all", "--project-root", project], io),
    0,
  );
  const listedAll = JSON.parse(output.pop()!) as {
    workstreams: Array<{ completed_presence?: string }>;
  };
  assert.equal(listedAll.workstreams[0]!.completed_presence, "live");

  // Reopen restores the open listing without warnings or flags.
  assert.equal(
    await main(["workstream", "reopen", "lane", "--project-root", project], io),
    0,
  );
  const reopened = JSON.parse(output.pop()!) as { status: string; revision: number };
  assert.equal(reopened.status, "open");
  assert.equal(reopened.revision, 3);
  assert.deepEqual(errors, []);
  assert.equal(
    await main(["workstream", "list", "--project-root", project], io),
    0,
  );
  const relisted = JSON.parse(output.pop()!) as {
    workstreams: Array<{ status: string; completed_presence?: string }>;
  };
  assert.equal(relisted.workstreams[0]!.status, "open");
  assert.equal(relisted.workstreams[0]!.completed_presence, undefined);

  // An unknown reference is exit 1 on both verbs.
  assert.equal(
    await main(
      ["workstream", "complete", "missing", "--project-root", project],
      io,
    ),
    1,
  );
  assert.equal(
    await main(["workstream", "reopen", "missing", "--project-root", project], io),
    1,
  );
  assert.match(errors.join(""), /no workstream named "missing"/u);
});
