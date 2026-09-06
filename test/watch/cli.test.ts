import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { createSessionId } from "../../src/core/id.js";
import { admitHookSession } from "../../src/hooks/participation.js";
import { claimHookNudge } from "../../src/nudge/index.js";
import {
  AwaitScanFailureLimitError,
  awaitUnreadPeerTurns,
} from "../../src/watch/index.js";

interface CapturedIo {
  readonly io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
  readonly output: string[];
  readonly errors: string[];
}

function capture(): CapturedIo {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    },
    output,
    errors,
  };
}

async function withProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-watch-cli-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

function turnRecord(options: {
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly sequence: number;
  readonly request: string;
}): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${options.sessionId.slice(4, 20)}${options.sequence
      .toString(16)
      .padStart(16, "0")}`,
    provider: "claude",
    session_id: options.sessionId,
    workstream_id: options.workstreamId,
    sequence: options.sequence,
    agent_id: "main",
    started_at: "2026-08-23T01:00:00.000Z",
    ended_at: "2026-08-23T01:00:01.000Z",
    outcome: "success",
    request: {
      text: options.request,
      fidelity: "verbatim",
      truncated: false,
      redactions: [],
    },
    response: {
      text: "done",
      fidelity: "verbatim",
      truncated: false,
      redactions: [],
    },
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [],
  };
}

async function appendTurn(
  project: string,
  turn: BarbaroTurnV1,
): Promise<void> {
  const directory = join(project, ".barbaro", "feed", turn.provider);
  await mkdir(directory, { recursive: true });
  await appendFile(
    join(directory, `${turn.session_id}.jsonl`),
    `${JSON.stringify(turn)}\n`,
  );
}

const unusedTui = async (): Promise<number> => {
  assert.fail("await must not start the TUI");
};

test("watch --once resolves a joined session and emits the armed event", async () => {
  await withProject(async (project) => {
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "watching-session",
      event: "UserPromptSubmit",
      prompt: "/barbaro new lane",
    });
    const { io, output, errors } = capture();
    assert.equal(
      await main(
        [
          "watch",
          "--project-root",
          project,
          "--provider",
          "claude",
          "--session-id",
          "watching-session",
          "--once",
          "--json",
        ],
        io,
      ),
      0,
    );
    assert.deepEqual(errors, []);
    assert.equal(output.length, 1);
    const armed = JSON.parse(output[0]!) as Record<string, unknown>;
    assert.equal(armed.schema, "barbaro.watch.event.v1");
    assert.equal(armed.kind, "armed");
    assert.equal(
      armed.self_session_id,
      createSessionId("claude", "watching-session"),
    );
    assert.equal(armed.enrolled_sessions, 0);
  });
});

test("watch refuses to impersonate a session that never joined", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, ".barbaro"));
    const { io, output, errors } = capture();
    assert.equal(
      await main(
        [
          "watch",
          "--project-root",
          project,
          "--provider",
          "claude",
          "--session-id",
          "never-joined",
          "--once",
        ],
        io,
      ),
      1,
    );
    assert.deepEqual(output, []);
    assert.match(errors.join(""), /has not joined Barbaro/);
  });
});

test("watch refuses a project with no store rather than watching nothing", async () => {
  await withProject(async (project) => {
    const { io, output, errors } = capture();
    assert.equal(
      await main(["watch", "--project-root", project, "--once"], io),
      1,
    );
    assert.deepEqual(output, []);
    assert.match(errors.join(""), /no \.barbaro directory/);
  });
});

test("watch validates its identity flags before doing anything", async () => {
  await withProject(async (project) => {
    const { io } = capture();
    await assert.rejects(
      main(["watch", "--project-root", project, "--self", "not-a-session"], io),
      TypeError,
    );
    await assert.rejects(
      main(["watch", "--project-root", project, "--provider", "claude"], io),
      /supplied together/,
    );
    await assert.rejects(
      main(
        [
          "watch",
          "--project-root",
          project,
          "--self",
          `ses_${"a".repeat(32)}`,
          "--provider",
          "claude",
          "--session-id",
          "x",
        ],
        io,
      ),
      /mutually exclusive/,
    );
  });
});

test("watch --self requires consent, scopes to its workstream, and accepts explicit overrides", async () => {
  await withProject(async (project) => {
    const own = await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "stable-self",
      event: "UserPromptSubmit",
      prompt: "$barbaro new own-lane",
    });
    const other = await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "other-lane-member",
      event: "UserPromptSubmit",
      prompt: "/barbaro new other-lane",
    });
    assert.ok(own.participation?.workstream_id);
    assert.ok(other.participation?.workstream_id);
    const self = createSessionId("codex", "stable-self");
    const captured = capture();

    assert.equal(
      await main(
        [
          "watch",
          "--project-root",
          project,
          "--self",
          self,
          "--once",
          "--json",
        ],
        captured.io,
      ),
      0,
    );
    assert.equal(
      (JSON.parse(captured.output.pop()!) as { workstream_id?: string })
        .workstream_id,
      own.participation.workstream_id,
    );

    assert.equal(
      await main(
        [
          "watch",
          "--project-root",
          project,
          "--self",
          self,
          "--workstream",
          "other-lane",
          "--once",
          "--json",
        ],
        captured.io,
      ),
      0,
    );
    assert.equal(
      (JSON.parse(captured.output.pop()!) as { workstream_id?: string })
        .workstream_id,
      other.participation.workstream_id,
    );

    assert.equal(
      await main(
        [
          "watch",
          "--project-root",
          project,
          "--self",
          self,
          "--all-workstreams",
          "--once",
          "--json",
        ],
        captured.io,
      ),
      0,
    );
    assert.equal(
      (JSON.parse(captured.output.pop()!) as { workstream_id?: string })
        .workstream_id,
      undefined,
    );

    const unknown = capture();
    assert.equal(
      await main(
        [
          "watch",
          "--project-root",
          project,
          "--self",
          `ses_${"f".repeat(32)}`,
          "--once",
        ],
        unknown.io,
      ),
      1,
    );
    assert.deepEqual(unknown.output, []);
    assert.match(unknown.errors.join(""), /has not joined Barbaro/u);
  });
});

test("await returns pre-existing cursor unread in text and JSON modes", async () => {
  await withProject(async (project) => {
    const joinedAt = new Date("2026-08-23T00:59:00.000Z");
    const own = await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "awaiting-session",
      event: "UserPromptSubmit",
      prompt: "$barbaro new own-lane",
      now: joinedAt,
    });
    const ownPeer = await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "own-peer",
      event: "UserPromptSubmit",
      prompt: "/barbaro join own-lane",
      now: joinedAt,
    });
    const foreign = await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "foreign-peer",
      event: "UserPromptSubmit",
      prompt: "/barbaro new foreign-lane",
      now: joinedAt,
    });
    assert.ok(own.participation?.workstream_id);
    assert.ok(ownPeer.participation?.workstream_id);
    assert.ok(foreign.participation?.workstream_id);
    await claimHookNudge({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "awaiting-session",
      marker: "tool_boundary",
      turn: { kind: "codex", turn_id: `turn_${"1".repeat(32)}` },
      now: joinedAt,
    });
    await appendTurn(
      project,
      turnRecord({
        sessionId: createSessionId("claude", "foreign-peer"),
        workstreamId: foreign.participation.workstream_id,
        sequence: 1,
        request: "foreign",
      }),
    );
    await appendTurn(
      project,
      turnRecord({
        sessionId: createSessionId("claude", "own-peer"),
        workstreamId: ownPeer.participation.workstream_id,
        sequence: 1,
        request: "already unread before await starts",
      }),
    );

    const text = capture();
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "awaiting-session",
          "--timeout-ms",
          "1000",
        ],
        text.io,
      ),
      0,
    );
    assert.deepEqual(text.output, [`1 unread — run barbaro read context --provider codex --session-id ${createSessionId("codex", "awaiting-session")} --workstream ${own.participation.workstream_id} --project-root "$PWD"\n`]);
    assert.deepEqual(text.errors, []);

    const json = capture();
    const stableSelf = createSessionId("codex", "awaiting-session");
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--self",
          stableSelf,
          "--workstream",
          "own-lane",
          "--json",
          "--timeout-ms",
          "1000",
        ],
        json.io,
      ),
      0,
    );
    assert.deepEqual(JSON.parse(json.output[0]!), {
      schema: "barbaro.await.v1",
      kind: "unread",
      provider: "codex",
      session_id: stableSelf,
      workstream_id: own.participation.workstream_id,
      cursor_revision: 1,
      unread_count: 1,
    });
    assert.deepEqual(json.errors, []);
  });
});

test("await requires one session cursor and refuses foreign scopes", async () => {
  await withProject(async (project) => {
    const joinedAt = new Date("2026-08-23T00:59:00.000Z");
    await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "await-scope",
      event: "UserPromptSubmit",
      prompt: "$barbaro new await-own",
      now: joinedAt,
    });
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "await-foreign",
      event: "UserPromptSubmit",
      prompt: "/barbaro new await-foreign",
      now: joinedAt,
    });

    await assert.rejects(
      main(["await", "--project-root", project], capture().io),
      /requires --self or --provider\/--session-id/u,
    );
    await assert.rejects(
      main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "await-scope",
          "--all-workstreams",
        ],
        capture().io,
      ),
      /cannot use --all-workstreams/u,
    );
    await assert.rejects(
      main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "await-scope",
          "--workstream",
          "await-foreign",
        ],
        capture().io,
      ),
      /cannot reinterpret this session's cursor/u,
    );

    const unjoined = capture();
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "not-joined",
          "--timeout-ms",
          "1",
        ],
        unjoined.io,
      ),
      1,
    );
    assert.match(unjoined.errors.join(""), /has not joined Barbaro/u);

    const unknownSelf = capture();
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--self",
          `ses_${"e".repeat(32)}`,
          "--timeout-ms",
          "1",
        ],
        unknownSelf.io,
      ),
      1,
    );
    assert.match(unknownSelf.errors.join(""), /has not joined Barbaro/u);
  });
});

test("await timeout is successful in text and JSON modes", async () => {
  await withProject(async (project) => {
    const joined = await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "await-timeout",
      event: "UserPromptSubmit",
      prompt: "$barbaro new timeout-lane",
      now: new Date("2026-08-23T00:59:00.000Z"),
    });
    assert.ok(joined.participation?.workstream_id);
    await claimHookNudge({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "await-timeout",
      marker: "tool_boundary",
      turn: { kind: "codex", turn_id: `turn_${"2".repeat(32)}` },
    });

    const text = capture();
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "await-timeout",
          "--timeout-ms",
          "1",
          "--interval-ms",
          "1",
        ],
        text.io,
      ),
      0,
    );
    assert.deepEqual(text.output, [
      "AWAIT timeout after 1 ms — no peer event\n",
    ]);

    const json = capture();
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--self",
          createSessionId("codex", "await-timeout"),
          "--timeout-ms",
          "1",
          "--interval-ms",
          "1",
          "--json",
        ],
        json.io,
      ),
      0,
    );
    assert.deepEqual(JSON.parse(json.output[0]!), {
      schema: "barbaro.await.v1",
      kind: "timeout",
      timeout_ms: 1,
    });
  });
});

test("await isolates an oversized foreign feed and returns nonzero for incomplete quiet", async () => {
  await withProject(async (project) => {
    const joined = await admitHookSession({ projectRoot: project, provider: "codex",
      nativeSessionId: "await-incomplete", event: "UserPromptSubmit", prompt: "$barbaro new incomplete-lane",
      now: new Date("2026-08-23T00:59:00.000Z") });
    const workstreamId = joined.participation!.workstream_id!;
    const directory = join(project, ".barbaro", "feed", "claude");
    await mkdir(directory, { recursive: true });
    const foreignId = createSessionId("claude", "foreign-noisy-feed");
    const foreign = turnRecord({ sessionId: foreignId, workstreamId: `ws_${"f".repeat(32)}`, sequence: 1, request: "outside this scope" });
    const path = join(directory, `${foreignId}.jsonl`);
    await writeFile(path, `${JSON.stringify(foreign)}\n`);
    const handle = await open(path, "r+");
    try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const args = ["await", "--project-root", project, "--provider", "codex", "--session-id", "await-incomplete", "--timeout-ms", "1", "--interval-ms", "1"];
    for (const json of [false, true]) {
      const io = capture();
      assert.equal(await main([...args, ...(json ? ["--json"] : [])], io.io), 1);
      if (json) {
        const result = JSON.parse(io.output[0]!);
        assert.equal(result.kind, "incomplete");
        assert.equal(result.coverage.unavailable.items[0].reason, "file_too_large");
      } else assert.match(io.output.join(""), /AWAIT incomplete.*quiet is unproven/u);
    }
    const healthy = turnRecord({ sessionId: createSessionId("claude", "healthy-news"), workstreamId, sequence: 1, request: "scoped verdict" });
    await writeFile(join(directory, `${healthy.session_id}.jsonl`), `${JSON.stringify(healthy)}\n`);
    for (const json of [false, true]) {
      const io = capture();
      assert.equal(await main([...args, ...(json ? ["--json"] : [])], io.io), 0);
      if (json) {
        const result = JSON.parse(io.output[0]!);
        assert.equal(result.kind, "unread");
        assert.equal(result.unread_count, 1);
        assert.equal(result.coverage.state, "incomplete");
      } else assert.match(io.output.join(""), /^at least 1 unread.*coverage incomplete/u);
    }
  });
});

test("await refuses real errors and validates its timeout cap", async () => {
  await withProject(async (project) => {
    const missing = capture();
    assert.equal(
      await main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "missing-store",
          "--timeout-ms",
          "1",
        ],
        missing.io,
      ),
      1,
    );
    assert.match(missing.errors.join(""), /no \.barbaro directory/u);

    await mkdir(join(project, ".barbaro"));
    await assert.rejects(
      main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "x",
          "--timeout-ms",
          "3600001",
        ],
        capture().io,
      ),
      /--timeout-ms must be at most 3600000/u,
    );
    await assert.rejects(
      main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "x",
          "--timeout-ms",
          "0",
        ],
        capture().io,
      ),
      /positive integer/u,
    );
  });
});

test("await reports cursor scan failure as non-zero", async () => {
  await withProject(async (project) => {
    await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "await-failure",
      event: "UserPromptSubmit",
      prompt: "$barbaro new failure-lane",
    });
    const captured = capture();
    const failAwait: typeof awaitUnreadPeerTurns = async () => {
      throw new AwaitScanFailureLimitError();
    };

    const exitCode = await main(
      [
        "await",
        "--project-root",
        project,
        "--provider",
        "codex",
        "--session-id",
        "await-failure",
        "--timeout-ms",
        "100",
      ],
      captured.io,
      unusedTui,
      failAwait,
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(captured.output, []);
    assert.deepEqual(captured.errors, [
      "barbaro await: too many consecutive scan failures\n",
    ]);
  });
});

test("await leaves unrelated primitive failures fatal", async () => {
  await withProject(async (project) => {
    await admitHookSession({
      projectRoot: project,
      provider: "codex",
      nativeSessionId: "await-fatal",
      event: "UserPromptSubmit",
      prompt: "$barbaro new fatal-lane",
    });
    const captured = capture();
    const failAwait: typeof awaitUnreadPeerTurns = async () => {
      throw new Error("cursor failed");
    };
    await assert.rejects(
      main(
        [
          "await",
          "--project-root",
          project,
          "--provider",
          "codex",
          "--session-id",
          "await-fatal",
          "--timeout-ms",
          "100",
        ],
        captured.io,
        unusedTui,
        failAwait,
      ),
      /cursor failed/u,
    );
    assert.deepEqual(captured.output, []);
    assert.deepEqual(captured.errors, []);
  });
});

test("CLI help documents cursor-bound await timing and identity", async () => {
  const captured = capture();
  assert.equal(await main(["--help"], captured.io), 0);
  const help = captured.output.join("");
  assert.match(help, /barbaro await\s+\[--project-root/u);
  assert.match(help, /--timeout-ms <n>/u);
  assert.match(help, /--self <ses_id>/u);
  assert.match(help, /--workstream <own-name\|own-ws_id>/u);
  assert.match(help, /read-only wait for the session cursor's unread/u);
  assert.match(help, /timeout defaults to 600000 ms/u);
  assert.match(help, /capped at 3600000 ms/u);
  assert.deepEqual(captured.errors, []);
});
