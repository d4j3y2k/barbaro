import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { createSessionId } from "../../src/core/id.js";
import {
  admitHookSession,
  isBarbaroExpansion,
  isBarbaroJoinPrompt,
  parseBarbaroInvocation,
  BARBARO_CODEX_SKILL,
  BARBARO_JOIN_COMMAND,
  SESSION_PARTICIPATION_SCHEMA,
  SESSION_PARTICIPATION_SCHEMA_V2,
  SessionParticipationStore,
  participationMemberships,
} from "../../src/hooks/participation.js";
import { WorkstreamStore } from "../../src/workstreams/index.js";

test("the two-phase grammar reads only new/join after the leading token", () => {
  assert.deepEqual(parseBarbaroInvocation("/barbaro"), { kind: "bare" });
  assert.deepEqual(parseBarbaroInvocation("$barbaro"), { kind: "bare" });
  assert.deepEqual(parseBarbaroInvocation("/barbaro Refactor the writer."), {
    kind: "bare",
  });
  assert.deepEqual(parseBarbaroInvocation("/barbaro new"), { kind: "bare" });
  assert.deepEqual(parseBarbaroInvocation("/barbaro join"), { kind: "bare" });
  assert.deepEqual(parseBarbaroInvocation("/barbaro new tui-design"), {
    kind: "new",
    name: "tui-design",
  });
  assert.deepEqual(
    parseBarbaroInvocation("/barbaro JOIN TUI-Design Refactor the writer."),
    { kind: "join", name: "tui-design" },
  );
  assert.deepEqual(parseBarbaroInvocation("$barbaro new lane\nmore text"), {
    kind: "new",
    name: "lane",
  });
  // An invalid slug is still reported as the verb so the hook can refuse it
  // with a reason instead of silently treating the line as bare.
  assert.deepEqual(parseBarbaroInvocation("/barbaro new Not_A_Slug"), {
    kind: "new",
    name: "not_a_slug",
  });
  assert.equal(parseBarbaroInvocation("Discuss `/barbaro new x`."), undefined);
  assert.equal(parseBarbaroInvocation("/barbarox new x"), undefined);
});

test("only an explicit leading command or skill token is a Barbaro invocation", () => {
  assert.equal(isBarbaroJoinPrompt(BARBARO_JOIN_COMMAND), true);
  assert.equal(isBarbaroJoinPrompt(BARBARO_CODEX_SKILL), true);
  assert.equal(isBarbaroJoinPrompt("  /BARBARO  "), true);
  assert.equal(isBarbaroJoinPrompt("/barbaro Refactor the writer."), true);
  assert.equal(isBarbaroJoinPrompt("$barbaro\nRefactor the writer."), true);
  assert.equal(isBarbaroJoinPrompt("Can you join Barbaro?"), false);
  assert.equal(isBarbaroJoinPrompt("Discuss `/barbaro`."), false);
  assert.equal(isBarbaroJoinPrompt("Refactor first.\n/barbaro"), false);
  assert.equal(isBarbaroJoinPrompt("barbaro join"), false);
  assert.equal(isBarbaroJoinPrompt("/maximus"), false);
  assert.equal(isBarbaroJoinPrompt("$maximus"), false);
  assert.equal(isBarbaroExpansion("barbaro"), true);
  assert.equal(isBarbaroExpansion(" BARBARO "), true);
  assert.equal(isBarbaroExpansion("maximus"), false);
  assert.equal(isBarbaroExpansion("other"), false);
});

test("Codex's rendered skill attachment accepts only recognized skill locations", async (t) => {
  const root = await temporaryProject(t);
  const userHome = await temporaryProject(t);
  const userSkillSource = await temporaryProject(t);
  const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previousHome = process.env[homeVariable];
  process.env[homeVariable] = userHome;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env[homeVariable];
    } else {
      process.env[homeVariable] = previousHome;
    }
  });

  const skillPath = join(
    root,
    ".agents",
    "skills",
    "barbaro",
    "SKILL.md",
  );
  await writeSkill(skillPath);
  const attached = `[$barbaro](${skillPath})`;
  const legacySkillPath = join(
    root,
    ".agents",
    "skills",
    "maximus",
    "SKILL.md",
  );
  await writeSkill(legacySkillPath);

  assert.equal(isBarbaroJoinPrompt(attached), false);
  assert.equal(isBarbaroJoinPrompt(attached, root), true);
  assert.equal(
    isBarbaroJoinPrompt(`[$maximus](${legacySkillPath})`, root),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(`${attached} Refactor the writer.`, root),
    true,
  );
  assert.equal(
    isBarbaroJoinPrompt(`${attached}&#x20;\nRefactor the writer.`, root),
    true,
  );
  assert.equal(
    isBarbaroJoinPrompt(`${attached}&#X20;Refactor the writer.`, root),
    true,
  );
  assert.equal(isBarbaroJoinPrompt(`${attached}&#x21;`, root), false);
  assert.equal(isBarbaroJoinPrompt(`${attached}&nbsp;`, root), false);
  assert.equal(
    isBarbaroJoinPrompt(`[$BARBARO](<${skillPath}>)`, root),
    true,
  );
  const spacedRoot = join(root, "Project With Spaces");
  const spacedSkillPath = join(
    spacedRoot,
    ".agents",
    "skills",
    "barbaro",
    "SKILL.md",
  );
  await writeSkill(spacedSkillPath);
  assert.equal(
    isBarbaroJoinPrompt(
      `[$barbaro](<${spacedSkillPath}>)`,
      spacedRoot,
    ),
    true,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      `[$barbaro](${encodeURI(spacedSkillPath)})`,
      spacedRoot,
    ),
    true,
  );
  assert.equal(
    isBarbaroJoinPrompt(`Discuss this first: ${attached}`, root),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      `[$barbaro](${join(root, ".agents", "skills", "other", "SKILL.md")})`,
      root,
    ),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      "[$barbaro](https://example.com/SKILL.md)",
      root,
    ),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      "<skill><name>barbaro</name></skill>",
      root,
    ),
    false,
  );

  const userSkillPath = join(
    userHome,
    ".agents",
    "skills",
    "barbaro",
    "SKILL.md",
  );
  await writeSkill(join(userSkillSource, "SKILL.md"));
  await mkdir(dirname(dirname(userSkillPath)), { recursive: true });
  await symlink(userSkillSource, dirname(userSkillPath), "dir");
  assert.equal(homedir(), userHome);
  const userAttached = `[$barbaro](${userSkillPath})`;
  assert.equal(isBarbaroJoinPrompt(userAttached), false);
  assert.equal(isBarbaroJoinPrompt(userAttached, root), true);
  assert.equal(
    isBarbaroJoinPrompt(`[$barbaro](${await realpath(userSkillPath)})`, root),
    true,
  );
  const arbitraryAlias = join(root, "docs", "innocent.md");
  await mkdir(dirname(arbitraryAlias), { recursive: true });
  await symlink(await realpath(userSkillPath), arbitraryAlias, "file");
  assert.equal(
    isBarbaroJoinPrompt(`[$barbaro](${arbitraryAlias})`, root),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      `[$barbaro](${join(userHome, ".agents", "skills", "other", "SKILL.md")})`,
      root,
    ),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      `[$barbaro](${join(root, "elsewhere", ".agents", "skills", "barbaro", "SKILL.md")})`,
      root,
    ),
    false,
  );
  assert.equal(
    isBarbaroJoinPrompt(
      `[$barbaro](${join(userHome, ".agents", "skills", "barbaro", "README.md")})`,
      root,
    ),
    false,
  );

  await mkdir(join(root, ".git"));
  const nestedRoot = join(root, "packages", "service");
  await mkdir(nestedRoot, { recursive: true });
  assert.equal(isBarbaroJoinPrompt(attached, nestedRoot), true);

  const admission = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "composer-session",
    event: "UserPromptSubmit",
    prompt: `${userAttached}&#x20;new lane\n`,
  });
  assert.equal(admission.joined, true);
  assert.equal(admission.initiated, true);
  assert.equal(
    await new SessionParticipationStore(root).hasJoined(
      "codex",
      "composer-session",
    ),
    true,
  );
});

test("the participation store exposes no unverified raw join mutator", async (t) => {
  const store = new SessionParticipationStore(await temporaryProject(t));
  assert.equal(Reflect.get(store, "join"), undefined);
});

test("checking a dormant session creates no Barbaro data", async (t) => {
  const root = await temporaryProject(t);
  const store = new SessionParticipationStore(root);
  assert.equal(await store.hasJoined("codex", "native-session"), false);
  await assert.rejects(access(join(root, ".barbaro")), { code: "ENOENT" });
});

test("stable participation reads use the exact provider/session path", async (t) => {
  const root = await temporaryProject(t);
  const nativeSessionId = "stable-read-session";
  const admission = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new stable-read",
  });
  assert.ok(admission.participation);
  const store = new SessionParticipationStore(root);
  const stableSessionId = createSessionId("codex", nativeSessionId);

  assert.deepEqual(
    await store.readStable("codex", stableSessionId),
    admission.participation,
  );
  assert.equal(await store.readStable("claude", stableSessionId), undefined);
  await assert.rejects(
    store.readStable("codex", nativeSessionId),
    /Invalid session_id/u,
  );
});

test("a join invocation persists scoped, idempotent session consent", async (t) => {
  const root = await temporaryProject(t);
  const nativeSessionId = "native-session";
  const first = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro new lane Refactor the writer.",
  });
  assert.equal(first.joined, true);
  assert.equal(first.initiated, true);

  const markerPath = join(
    root,
    ".barbaro",
    "sessions",
    "codex",
    `${createSessionId("codex", nativeSessionId)}.json`,
  );
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
    schema: string;
    provider: string;
    session_id: string;
    initiated_by: string;
    joined_at: string;
    workstream_id: string;
    memberships: readonly { workstream_id: string; from: string }[];
  };
  assert.deepEqual(marker, first.participation);
  assert.equal(marker.schema, SESSION_PARTICIPATION_SCHEMA_V2);
  assert.match(marker.workstream_id, /^ws_[0-9a-f]{32}$/u);
  assert.equal(
    (await new WorkstreamStore(root).resolve("lane"))?.workstream_id,
    marker.workstream_id,
  );
  assert.equal(marker.provider, "codex");
  assert.equal(marker.session_id, createSessionId("codex", nativeSessionId));
  assert.equal(marker.initiated_by, "user_prompt");
  assert.ok(Number.isFinite(Date.parse(marker.joined_at)));
  assert.deepEqual(marker.memberships, [
    { workstream_id: marker.workstream_id, from: marker.joined_at },
  ]);

  const resumed = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId,
    event: "SessionStart",
  });
  assert.equal(resumed.joined, true);
  assert.equal(resumed.initiated, false);
  assert.deepEqual(resumed.participation, first.participation);

  const otherProvider = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId,
    event: "PreToolUse",
  });
  assert.deepEqual(otherProvider, { joined: false, initiated: false });

  const otherSession = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "another-session",
    event: "PreToolUse",
  });
  assert.deepEqual(otherSession, { joined: false, initiated: false });
});

test("Claude's slash-command expansion also initiates participation", async (t) => {
  const root = await temporaryProject(t);
  const admission = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "native-session",
    event: "UserPromptExpansion",
    commandName: "barbaro",
    prompt: "/barbaro new lane",
  });
  assert.equal(admission.joined, true);
  assert.equal(admission.initiated, true);
});

test("a bare invocation reports the roster and enrolls nothing", async (t) => {
  const root = await temporaryProject(t);
  const bare = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "undecided",
    event: "UserPromptSubmit",
    prompt: "/barbaro Refactor the writer.",
  });
  assert.deepEqual(
    { joined: bare.joined, initiated: bare.initiated, pending: bare.pending },
    { joined: false, initiated: false, pending: "workstream-selection" },
  );
  assert.match(bare.message ?? "", /No open workstreams/u);
  assert.match(bare.message ?? "", /\/barbaro join <name>/u);
  await assert.rejects(access(join(root, ".barbaro")), { code: "ENOENT" });

  // The expansion event without the raw line is bare too.
  const expansion = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "undecided",
    event: "UserPromptExpansion",
    commandName: "barbaro",
  });
  assert.equal(expansion.pending, "workstream-selection");

  await new WorkstreamStore(root).create({
    name: "tui-design",
    createdBy: { kind: "cli" },
  });
  const roster = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "undecided",
    event: "UserPromptSubmit",
    prompt: "$barbaro",
  });
  assert.match(roster.message ?? "", /Open workstreams: tui-design\./u);
  assert.match(roster.message ?? "", /\$barbaro join <name>/u);
});

test("join needs an open workstream; new needs a free name", async (t) => {
  const root = await temporaryProject(t);
  const unknown = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "joiner",
    event: "UserPromptSubmit",
    prompt: "/barbaro join tui-design",
  });
  assert.equal(unknown.joined, false);
  assert.match(unknown.refused ?? "", /no workstream named "tui-design"/u);
  await assert.rejects(access(join(root, ".barbaro", "sessions")), {
    code: "ENOENT",
  });

  const created = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "creator",
    event: "UserPromptSubmit",
    prompt: "/barbaro new tui-design Start the design.",
  });
  assert.equal(created.joined, true);
  assert.equal(created.initiated, true);
  assert.match(created.message ?? "", /created and joined workstream "tui-design"/u);
  const workstream = await new WorkstreamStore(root).resolve("tui-design");
  assert.ok(workstream);
  assert.deepEqual(workstream.created_by, {
    provider: "claude",
    session_id: createSessionId("claude", "creator"),
  });

  const joined = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "joiner",
    event: "UserPromptSubmit",
    prompt: "$barbaro join tui-design",
  });
  assert.equal(joined.joined, true);
  assert.equal(joined.participation?.workstream_id, workstream.workstream_id);

  const taken = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "latecomer",
    event: "UserPromptSubmit",
    prompt: "$barbaro new tui-design",
  });
  assert.equal(taken.joined, false);
  assert.match(taken.refused ?? "", /already exists \(open\); join it/u);

  const invalid = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "latecomer",
    event: "UserPromptSubmit",
    prompt: "$barbaro new Not_A_Slug",
  });
  assert.equal(invalid.joined, false);
  assert.match(invalid.refused ?? "", /invalid workstream name/u);

  await new WorkstreamStore(root).setStatus("tui-design", "completed");
  const completed = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "latecomer",
    event: "UserPromptSubmit",
    prompt: "$barbaro join tui-design",
  });
  assert.equal(completed.joined, false);
  assert.match(completed.refused ?? "", /is completed/u);
});

test("a session moves forward while same-target joins remain idempotent", async (t) => {
  const root = await temporaryProject(t);
  const first = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "steady",
    event: "UserPromptSubmit",
    prompt: "/barbaro new alpha",
    now: new Date("2026-08-22T10:00:00.000Z"),
  });
  assert.equal(first.initiated, true);
  const again = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "steady",
    event: "UserPromptSubmit",
    prompt: "/barbaro join alpha",
    now: new Date("2026-08-22T10:01:00.000Z"),
  });
  assert.deepEqual(
    { joined: again.joined, initiated: again.initiated, refused: again.refused },
    { joined: true, initiated: false, refused: undefined },
  );
  assert.deepEqual(again.participation, first.participation);

  const beta = await new WorkstreamStore(root).create({
    name: "beta",
    createdBy: { kind: "cli" },
  });
  const moved = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "steady",
    event: "UserPromptSubmit",
    prompt: "/barbaro join beta",
    now: new Date("2026-08-22T10:02:00.000Z"),
  });
  assert.equal(moved.joined, true);
  assert.equal(moved.initiated, true);
  assert.equal(moved.participation?.workstream_id, beta.workstream_id);
  assert.deepEqual(
    moved.participation === undefined
      ? []
      : participationMemberships(moved.participation),
    [
      {
        workstream_id: first.participation?.workstream_id,
        from: "2026-08-22T10:00:00.000Z",
      },
      {
        workstream_id: beta.workstream_id,
        from: "2026-08-22T10:02:00.000Z",
      },
    ],
  );
  assert.equal(moved.participation?.joined_at, first.participation?.joined_at);
  assert.equal(
    moved.message,
    `Barbaro: moved this session to workstream "beta" (${beta.workstream_id}) ` +
      `from "alpha"; earlier turns stay where they were.`,
  );

  const movedToNew = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "steady",
    event: "UserPromptSubmit",
    prompt: "/barbaro new gamma",
    now: new Date("2026-08-22T10:03:00.000Z"),
  });
  const gamma = await new WorkstreamStore(root).resolve("gamma");
  assert.ok(gamma);
  assert.equal(movedToNew.participation?.workstream_id, gamma.workstream_id);
  assert.equal(
    participationMemberships(movedToNew.participation!).length,
    3,
  );
  const bare = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "steady",
    event: "UserPromptSubmit",
    prompt: "/barbaro",
  });
  assert.equal(bare.joined, true);
  assert.match(bare.message ?? "", /belongs to workstream "gamma"/u);
});

test("move refusals leave the append-only consent record untouched", async (t) => {
  const root = await temporaryProject(t);
  await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "steady",
    event: "UserPromptSubmit",
    prompt: "$barbaro new alpha",
    now: new Date("2026-08-22T10:00:00.000Z"),
  });
  const store = new WorkstreamStore(root);
  await store.create({ name: "done", createdBy: { kind: "cli" } });
  await store.setStatus("done", "completed");
  const markerPath = join(
    root,
    ".barbaro",
    "sessions",
    "codex",
    `${createSessionId("codex", "steady")}.json`,
  );
  const before = await readFile(markerPath, "utf8");

  for (const [prompt, reason] of [
    ["$barbaro join missing", /no workstream named "missing"/u],
    ["$barbaro join done", /is completed/u],
    ["$barbaro join Not_A_Slug", /invalid workstream name/u],
  ] as const) {
    const refused = await admitHookSession({
      projectRoot: root,
      provider: "codex",
      nativeSessionId: "steady",
      event: "UserPromptSubmit",
      prompt,
      now: new Date("2026-08-22T11:00:00.000Z"),
    });
    assert.equal(refused.joined, true);
    assert.match(refused.refused ?? "", reason);
    assert.equal(await readFile(markerPath, "utf8"), before);
  }
});

test("concurrent joins and moves of one session serialize to one log", async (t) => {
  const root = await temporaryProject(t);
  const store = new WorkstreamStore(root);
  await store.create({ name: "one", createdBy: { kind: "cli" } });
  await store.create({ name: "two", createdBy: { kind: "cli" } });

  const same = await Promise.all(
    Array.from({ length: 6 }, () =>
      admitHookSession({
        projectRoot: root,
        provider: "codex",
        nativeSessionId: "racer-same",
        event: "UserPromptSubmit",
        prompt: "$barbaro join one",
      }),
    ),
  );
  assert.ok(same.every((admission) => admission.joined));
  assert.equal(same.filter((admission) => admission.initiated).length, 1);
  assert.equal(
    new Set(same.map((admission) => admission.participation?.workstream_id)).size,
    1,
  );

  await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "racer-moves",
    event: "UserPromptSubmit",
    prompt: "$barbaro join one",
    now: new Date("2026-08-22T12:00:00.000Z"),
  });
  const moves = await Promise.all(
    Array.from({ length: 6 }, () =>
      admitHookSession({
        projectRoot: root,
        provider: "codex",
        nativeSessionId: "racer-moves",
        event: "UserPromptSubmit",
        prompt: "$barbaro join two",
        now: new Date("2026-08-22T12:01:00.000Z"),
      }),
    ),
  );
  const recorded = await new SessionParticipationStore(root).read(
    "codex",
    "racer-moves",
  );
  assert.ok(recorded?.workstream_id);
  assert.ok(moves.every((admission) => admission.joined));
  assert.equal(moves.filter((admission) => admission.initiated).length, 1);
  assert.deepEqual(
    participationMemberships(recorded).map((membership) => membership.from),
    ["2026-08-22T12:00:00.000Z", "2026-08-22T12:01:00.000Z"],
  );
  assert.equal(
    participationMemberships(recorded).at(-1)?.workstream_id,
    recorded.workstream_id,
  );

  const three = await store.create({ name: "three", createdBy: { kind: "cli" } });
  const four = await store.create({ name: "four", createdBy: { kind: "cli" } });
  const distinctMoves = await Promise.all(
    ["three", "four"].map((name) =>
      admitHookSession({
        projectRoot: root,
        provider: "codex",
        nativeSessionId: "racer-moves",
        event: "UserPromptSubmit",
        prompt: `$barbaro join ${name}`,
        now: new Date("2026-08-22T12:02:00.000Z"),
      }),
    ),
  );
  assert.ok(distinctMoves.every((admission) => admission.initiated));
  const serialized = await new SessionParticipationStore(root).read(
    "codex",
    "racer-moves",
  );
  assert.ok(serialized);
  const serializedMemberships = participationMemberships(serialized);
  assert.equal(serializedMemberships.length, 4);
  assert.deepEqual(
    new Set(serializedMemberships.slice(-2).map((entry) => entry.workstream_id)),
    new Set([three.workstream_id, four.workstream_id]),
  );
  for (let index = 1; index < serializedMemberships.length; index += 1) {
    assert.ok(
      Date.parse(serializedMemberships[index - 1]!.from) <
        Date.parse(serializedMemberships[index]!.from),
    );
  }
});

test("an older v2 record without memberships synthesizes and extends its first join", async (t) => {
  const root = await temporaryProject(t);
  const workstreams = new WorkstreamStore(root);
  const alpha = await workstreams.create({
    name: "alpha",
    createdBy: { kind: "cli" },
  });
  const beta = await workstreams.create({
    name: "beta",
    createdBy: { kind: "cli" },
  });
  const sessionId = createSessionId("claude", "old-v2");
  const directory = join(root, ".barbaro", "sessions", "claude");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${sessionId}.json`),
    `${JSON.stringify({
      schema: SESSION_PARTICIPATION_SCHEMA_V2,
      provider: "claude",
      session_id: sessionId,
      joined_at: "2026-08-20T00:00:00.000Z",
      initiated_by: "user_prompt",
      workstream_id: alpha.workstream_id,
    })}\n`,
    "utf8",
  );
  const store = new SessionParticipationStore(root);
  const old = await store.read("claude", "old-v2");
  assert.ok(old);
  assert.equal(old.memberships, undefined);
  assert.deepEqual(participationMemberships(old), [
    {
      workstream_id: alpha.workstream_id,
      from: "2026-08-20T00:00:00.000Z",
    },
  ]);

  const moved = await admitHookSession({
    projectRoot: root,
    provider: "claude",
    nativeSessionId: "old-v2",
    event: "UserPromptSubmit",
    prompt: "/barbaro join beta",
    now: new Date("2026-08-22T00:00:00.000Z"),
  });
  assert.deepEqual(
    moved.participation === undefined
      ? []
      : participationMemberships(moved.participation),
    [
      {
        workstream_id: alpha.workstream_id,
        from: "2026-08-20T00:00:00.000Z",
      },
      {
        workstream_id: beta.workstream_id,
        from: "2026-08-22T00:00:00.000Z",
      },
    ],
  );
});

test("a pre-workstream consent record moves forward without adopting old history", async (t) => {
  const root = await temporaryProject(t);
  const sessionId = createSessionId("codex", "legacy");
  const directory = join(root, ".barbaro", "sessions", "codex");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${sessionId}.json`),
    `${JSON.stringify({
      schema: SESSION_PARTICIPATION_SCHEMA,
      provider: "codex",
      session_id: sessionId,
      joined_at: "2026-08-20T00:00:00.000Z",
      initiated_by: "user_prompt",
    })}\n`,
    "utf8",
  );
  const store = new SessionParticipationStore(root);
  const legacy = await store.read("codex", "legacy");
  assert.equal(legacy?.schema, SESSION_PARTICIPATION_SCHEMA);
  assert.equal(legacy?.workstream_id, undefined);
  assert.deepEqual(legacy === undefined ? [] : participationMemberships(legacy), []);
  assert.equal(await store.hasJoined("codex", "legacy"), true);

  const moved = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId: "legacy",
    event: "UserPromptSubmit",
    prompt: "$barbaro new lane",
    now: new Date("2026-08-22T12:00:00.000Z"),
  });
  const lane = await new WorkstreamStore(root).resolve("lane");
  assert.ok(lane);
  assert.equal(moved.joined, true);
  assert.equal(moved.initiated, true);
  assert.equal(moved.refused, undefined);
  assert.equal(moved.participation?.schema, SESSION_PARTICIPATION_SCHEMA_V2);
  assert.equal(moved.participation?.joined_at, legacy?.joined_at);
  assert.deepEqual(
    moved.participation === undefined
      ? []
      : participationMemberships(moved.participation),
    [
      {
        workstream_id: lane.workstream_id,
        from: "2026-08-22T12:00:00.000Z",
      },
    ],
  );
  assert.match(moved.message ?? "", /from unscoped history/u);
  assert.deepEqual(await store.read("codex", "legacy"), moved.participation);
});

async function temporaryProject(
  t: TestContext,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-participation-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeSkill(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    "---\nname: barbaro\ndescription: Test Barbaro skill.\n---\n",
    "utf8",
  );
}

test("the composer attachment may carry its verbs on the next line, and a repeated token is tolerated", async (t) => {
  // Codex Desktop serializes a composer-selected skill as the attachment
  // followed by a newline, so what the user typed arrives on line 2. A pasted
  // prompt that itself begins with the command token is the same command.
  const root = await temporaryProject(t);
  const skillPath = join(root, ".agents", "skills", "barbaro", "SKILL.md");
  await writeSkill(skillPath);
  const attached = `[$barbaro](${skillPath})`;
  assert.deepEqual(
    parseBarbaroInvocation(`${attached}&#x20;\nnew coordination Implement it.`, root),
    { kind: "new", name: "coordination" },
  );
  assert.deepEqual(
    parseBarbaroInvocation(`${attached} \n/barbaro new coordination Implement it.`, root),
    { kind: "new", name: "coordination" },
  );
  assert.deepEqual(
    parseBarbaroInvocation(`${attached}&#x20;join tui-design`, root),
    { kind: "join", name: "tui-design" },
  );
  assert.deepEqual(
    parseBarbaroInvocation(`${attached}&#x20;\n\nFix the writer.`, root),
    { kind: "bare" },
  );
  assert.deepEqual(parseBarbaroInvocation("$barbaro\njoin lane\nmore"), {
    kind: "join",
    name: "lane",
  });
  assert.deepEqual(parseBarbaroInvocation("$barbaro $barbaro new lane"), {
    kind: "new",
    name: "lane",
  });
  assert.deepEqual(parseBarbaroInvocation("/barbaro\n\nRefactor the writer."), {
    kind: "bare",
  });
  // Not an invocation at all is still not one.
  assert.equal(parseBarbaroInvocation("Discuss this first.\n$barbaro new x"), undefined);
});
