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
  BARBARO_CODEX_SKILL,
  BARBARO_JOIN_COMMAND,
  SESSION_PARTICIPATION_SCHEMA,
  SessionParticipationStore,
} from "../../src/hooks/participation.js";

test("only an explicit leading command or skill token initiates participation", () => {
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
    prompt: `${userAttached} \n`,
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

test("a join invocation persists scoped, idempotent session consent", async (t) => {
  const root = await temporaryProject(t);
  const nativeSessionId = "native-session";
  const first = await admitHookSession({
    projectRoot: root,
    provider: "codex",
    nativeSessionId,
    event: "UserPromptSubmit",
    prompt: "$barbaro Refactor the writer.",
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
  };
  assert.deepEqual(marker, first.participation);
  assert.equal(marker.schema, SESSION_PARTICIPATION_SCHEMA);
  assert.equal(marker.provider, "codex");
  assert.equal(marker.session_id, createSessionId("codex", nativeSessionId));
  assert.equal(marker.initiated_by, "user_prompt");
  assert.ok(Number.isFinite(Date.parse(marker.joined_at)));

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
    prompt: "/barbaro",
  });
  assert.equal(admission.joined, true);
  assert.equal(admission.initiated, true);
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
