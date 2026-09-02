import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { main } from "../src/cli.js";
import type {
  BarbaroAction,
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../src/contracts/v1.js";
import { createSessionId } from "../src/core/id.js";
import { stableJsonLine, stableStringify } from "../src/core/stable-json.js";
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
  assert.match(stdout, /barbaro turn list/);
  assert.match(stdout, /one item plus its pinned feed-count cursor/u);
  assert.match(stdout, /barbaro turn show <turn_id>/);
  assert.match(stdout, /barbaro evidence show <evidence_id>/);
  assert.match(stdout, /bounded attention views/u);
  assert.match(stdout, /older turns even when/u);
  assert.match(stdout, /completeness or\s+absence matters/u);
  assert.match(stdout, /shown < total/u);
  assert.match(stdout, /truncated\.projection/u);
  assert.match(stdout, /turn show <turn_id> --field response/u);
  assert.match(
    stdout,
    /every canonical\s+turn byte and referenced canonical evidence reachable/u,
  );
  assert.match(stdout, /provider-raw omissions are outside that guarantee/u);
  assert.match(stdout, /Never\s+read \.barbaro\/\*\.jsonl directly/u);
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

const CLI_SOURCE_REF = { trace_id: "fixture:cli-lossless-reader" } as const;

function cliContent(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function cliActions(count: number): BarbaroAction[] {
  return Array.from({ length: count }, (_, index) => ({
    action_id: `act_${(index + 1).toString(16).padStart(32, "0")}`,
    kind: "command" as const,
    outcome: "success" as const,
    command: cliContent(`command ${index} ${"x".repeat(90)}`),
    exit_code: 0,
    source_refs: [CLI_SOURCE_REF],
  }));
}

function cliTurn(
  seed: number,
  sessionId: string,
  workstreamId: string,
  response = `response ${seed}`,
): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${seed.toString(16).padStart(32, "0")}`,
    provider: "codex",
    session_id: sessionId,
    workstream_id: workstreamId,
    sequence: seed,
    agent_id: "main",
    started_at: new Date(Date.parse("2026-09-01T12:00:00.000Z") + seed * 60_000)
      .toISOString(),
    ended_at: new Date(Date.parse("2026-09-01T12:00:30.000Z") + seed * 60_000)
      .toISOString(),
    outcome: "success",
    request: cliContent(`request ${seed}`),
    response: cliContent(response),
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [CLI_SOURCE_REF],
  };
}

async function appendCliRecord(
  project: string,
  area: "feed" | "evidence",
  provider: string,
  sessionId: string,
  record: BarbaroTurnV1 | BarbaroEvidenceV1,
): Promise<void> {
  const path = join(project, ".barbaro", area, provider, `${sessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, stableJsonLine(record), "utf8");
}

test("turn list and show expose exhaustive scoped lossless CLI paging", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-turn-reader-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const nativeSessionId = "cli-turn-reader";
  const sessionId = createSessionId("codex", nativeSessionId);
  await admitHookSession({
    projectRoot: project,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new reader-lane",
  });

  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
  };
  assert.equal(
    await main(["workstream", "show", "reader-lane", "--project-root", project], io),
    0,
  );
  const workstreamId = (JSON.parse(output.pop()!) as { workstream_id: string })
    .workstream_id;
  const largeResponse = "😀é漢字".repeat(4_000);
  const canonical = cliTurn(1, sessionId, workstreamId, largeResponse);
  await appendCliRecord(project, "feed", "codex", sessionId, canonical);
  for (let seed = 2; seed <= 12; seed += 1) {
    await appendCliRecord(
      project,
      "feed",
      "codex",
      sessionId,
      cliTurn(seed, sessionId, workstreamId),
    );
  }

  let listCursor: string | undefined;
  const listedIds: string[] = [];
  do {
    const args = [
      "turn",
      "list",
      "--project-root",
      project,
      "--byte-budget",
      "2500",
      "--provider",
      "codex",
      "--session-id",
      nativeSessionId,
      ...(listCursor === undefined ? [] : ["--cursor", listCursor]),
    ];
    assert.equal(await main(args, io), 0);
    const page = JSON.parse(output.pop()!) as {
      byte_budget: number;
      value: {
        schema: string;
        scope: { kind: string; workstream_id: string };
        turns: {
          total: number;
          items: Array<{ turn_id: string }>;
          next_cursor?: string;
        };
      };
    };
    assert.equal(page.byte_budget, 2500);
    assert.equal(page.value.schema, "barbaro.reader.turn-list.v1");
    assert.deepEqual(page.value.scope, {
      kind: "workstream",
      workstream_id: workstreamId,
    });
    assert.equal(page.value.turns.total, 12);
    listedIds.push(...page.value.turns.items.map((item) => item.turn_id));
    listCursor = page.value.turns.next_cursor;
  } while (listCursor !== undefined);
  assert.equal(new Set(listedIds).size, 12);
  assert.deepEqual(listedIds, [...listedIds].sort().reverse());
  await assert.rejects(
    main(
      [
        "turn",
        "list",
        "--provider",
        "codex",
        "--session-id",
        "typo-session",
        "--project-root",
        project,
      ],
      io,
    ),
    /no enrolled codex session/u,
  );
  assert.equal(
    await main(
      [
        "turn",
        "list",
        "--provider",
        "codex",
        "--session-id",
        "typo-session",
        "--all-workstreams",
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  output.pop();

  assert.equal(
    await main(
      [
        "turn",
        "show",
        canonical.turn_id,
        "--field",
        "response",
        "--provider",
        "codex",
        "--session-id",
        nativeSessionId,
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  const defaultPage = JSON.parse(output.pop()!) as {
    byte_budget: number;
    value: { complete: boolean; text: string };
  };
  assert.equal(defaultPage.byte_budget, 131_072);
  assert.equal(defaultPage.value.complete, true);
  assert.equal(defaultPage.value.text, largeResponse);

  let cursor: string | undefined;
  let reconstructed = "";
  do {
    assert.equal(
      await main(
        [
          "turn",
          "show",
          canonical.turn_id,
          "--field",
          "record",
          "--byte-budget",
          "1800",
          "--workstream",
          "reader-lane",
          "--project-root",
          project,
          ...(cursor === undefined ? [] : ["--cursor", cursor]),
        ],
        io,
      ),
      0,
    );
    const page = JSON.parse(output.pop()!) as {
      value: { text: string; next_cursor?: string };
    };
    reconstructed += page.value.text;
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  assert.equal(reconstructed, stableStringify(canonical));

  assert.equal(
    await main(
      [
        "turn",
        "show",
        `turn_${"f".repeat(32)}`,
        "--project-root",
        project,
      ],
      io,
    ),
    1,
  );
  assert.match(errors.pop()!, /turn record not found/u);

  assert.equal(
    await main(
      [
        "turn",
        "show",
        `turn_${"f".repeat(32)}`,
        "--workstream",
        "reader-lane",
        "--project-root",
        project,
      ],
      io,
    ),
    1,
  );
  assert.match(
    errors.pop()!,
    /selected workstream; retry with --all-workstreams/u,
  );
  await assert.rejects(
    main(
      [
        "turn",
        "show",
        canonical.turn_id,
        "--cursor",
        "malformed",
        "--project-root",
        project,
      ],
      io,
    ),
    /Invalid Barbaro record cursor/u,
  );
});

test("evidence show retains projected action cursors and adds exact fields", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-cli-evidence-reader-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const nativeSessionId = "cli-evidence-reader";
  const sessionId = createSessionId("claude", nativeSessionId);
  await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "/barbaro new evidence-lane",
  });
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
  };
  assert.equal(
    await main(["workstream", "show", "evidence-lane", "--project-root", project], io),
    0,
  );
  const workstreamId = (JSON.parse(output.pop()!) as { workstream_id: string })
    .workstream_id;
  const evidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: `ev_${"a".repeat(32)}`,
    kind: "subagent_turn",
    turn_id: `turn_${"b".repeat(32)}`,
    parent_turn_id: `turn_${"c".repeat(32)}`,
    parent_link: { method: "native", native_key: "worker-1" },
    provider: "claude",
    session_id: sessionId,
    workstream_id: workstreamId,
    agent_id: "worker-1",
    occurred_at: "2026-09-01T13:01:00.000Z",
    source_refs: [CLI_SOURCE_REF],
    content: {
      role: "worker",
      sequence: 1,
      outcome: "success",
      started_at: "2026-09-01T13:00:00.000Z",
      ended_at: "2026-09-01T13:01:00.000Z",
      request: cliContent("inspect everything"),
      response: cliContent("complete 😀".repeat(300)),
      actions: cliActions(20),
    },
  };
  await appendCliRecord(project, "evidence", "claude", sessionId, evidence);

  // The identity flags locate this historical file. Moving its producer must
  // not silently scope the default read to the producer's current workstream.
  assert.equal(
    await main(
      ["workstream", "new", "evidence-next", "--project-root", project],
      io,
    ),
    0,
  );
  output.pop();
  await admitHookSession({
    projectRoot: project,
    provider: "claude",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "/barbaro join evidence-next",
  });

  const identityArgs = [
    evidence.evidence_id,
    "--provider",
    "claude",
    "--session-id",
    sessionId,
    "--project-root",
    project,
  ];
  assert.equal(
    await main(
      ["evidence", "show", ...identityArgs, "--byte-budget", "1800"],
      io,
    ),
    0,
  );
  const projected = JSON.parse(output.pop()!) as {
    value: {
      schema: string;
      content: { actions: { shown: number; total: number; next_cursor?: string } };
    };
  };
  assert.equal(projected.value.schema, "barbaro.reader.evidence.v1");
  assert.ok(projected.value.content.actions.shown > 0);
  assert.equal(projected.value.content.actions.total, 20);
  assert.match(projected.value.content.actions.next_cursor ?? "", /^a:[1-9][0-9]*$/u);
  assert.equal(
    await main(
      [
        "evidence",
        "show",
        ...identityArgs,
        "--byte-budget",
        "1800",
        "--action-cursor",
        projected.value.content.actions.next_cursor!,
      ],
      io,
    ),
    0,
  );
  assert.equal(
    await main(
      [
        "evidence",
        "show",
        ...identityArgs,
        "--workstream",
        "evidence-next",
      ],
      io,
    ),
    1,
  );
  assert.match(errors.pop()!, /evidence record not found/u);

  let cursor: string | undefined;
  let reconstructed = "";
  do {
    assert.equal(
      await main(
        [
          "evidence",
          "show",
          ...identityArgs,
          "--field",
          "content",
          "--workstream",
          "evidence-lane",
          "--byte-budget",
          "1800",
          ...(cursor === undefined ? [] : ["--cursor", cursor]),
        ],
        io,
      ),
      0,
    );
    const page = JSON.parse(output.pop()!) as {
      value: { schema: string; text: string; next_cursor?: string };
    };
    assert.equal(page.value.schema, "barbaro.reader.evidence-record.v1");
    reconstructed += page.value.text;
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  assert.equal(reconstructed, stableStringify(evidence.content));

  const responseEvidence: BarbaroEvidenceV1 = {
    schema: "barbaro.evidence.v1",
    evidence_id: `ev_${"d".repeat(32)}`,
    kind: "response",
    turn_id: `turn_${"e".repeat(32)}`,
    provider: "claude",
    session_id: sessionId,
    workstream_id: workstreamId,
    agent_id: "main",
    occurred_at: "2026-09-01T13:02:00.000Z",
    source_refs: [CLI_SOURCE_REF],
    content: { text: cliContent("intermediate response 😀") },
  };
  await appendCliRecord(
    project,
    "evidence",
    "claude",
    sessionId,
    responseEvidence,
  );
  assert.equal(
    await main(
      [
        "evidence",
        "show",
        responseEvidence.evidence_id,
        "--provider",
        "claude",
        "--session-id",
        sessionId,
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  assert.equal(
    (JSON.parse(output.pop()!) as { value: { kind: string } }).value.kind,
    "response",
  );
  assert.equal(
    await main(
      [
        "evidence",
        "show",
        responseEvidence.evidence_id,
        "--provider",
        "claude",
        "--session-id",
        sessionId,
        "--field",
        "response",
        "--workstream",
        "evidence-lane",
        "--project-root",
        project,
      ],
      io,
    ),
    0,
  );
  assert.equal(
    (JSON.parse(output.pop()!) as { value: { text: string } }).value.text,
    "intermediate response 😀",
  );

  await assert.rejects(
    main(
      [
        "evidence",
        "show",
        ...identityArgs,
        "--field",
        "record",
        "--action-cursor",
        "a:1",
      ],
      io,
    ),
    /--action-cursor cannot be used with --field/u,
  );
  await assert.rejects(
    main(
      ["evidence", "show", ...identityArgs, "--cursor", "malformed"],
      io,
    ),
    /--cursor requires --field/u,
  );
  await assert.rejects(
    main(
      [
        "evidence",
        "show",
        ...identityArgs,
        "--action-cursor",
        "wrong",
      ],
      io,
    ),
    /actionCursor must have the form/u,
  );
  assert.deepEqual(errors, []);
});
