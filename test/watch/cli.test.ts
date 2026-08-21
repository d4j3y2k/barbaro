import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import { createSessionId } from "../../src/core/id.js";
import { admitHookSession } from "../../src/hooks/participation.js";

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

test("watch --once resolves a joined session and emits the armed event", async () => {
  await withProject(async (project) => {
    await admitHookSession({
      projectRoot: project,
      provider: "claude",
      nativeSessionId: "watching-session",
      event: "UserPromptSubmit",
      prompt: "/barbaro",
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
