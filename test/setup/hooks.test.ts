import assert from "node:assert/strict";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_HOOK_TARGETS,
  analyzeHookCommand,
  checkHookConfig,
  collectHookCommands,
  inspectHookConfig,
  tokenizeCommand,
  type HookProvider,
  type HookProviderTarget,
} from "../../src/setup/index.js";

import {
  FIXTURE_NOW,
  makeExecutable,
  withFixtureRoot,
  writeFakeNode,
  writeFiles,
  writeHealthyProject,
} from "./fixture.js";

const NOW_MS = FIXTURE_NOW.getTime();

function targetFor(provider: HookProvider): HookProviderTarget {
  const target = DEFAULT_HOOK_TARGETS.find(
    (candidate) => candidate.provider === provider,
  );
  assert.ok(target, `missing default target for ${provider}`);
  return target;
}

test("quoted command tokens survive tokenization", () => {
  assert.deepEqual(
    tokenizeCommand(`"/opt/my node/node" '/a b/cli.js' claude hook`),
    ["/opt/my node/node", "/a b/cli.js", "claude", "hook"],
  );
});

test("a hook command yields its subcommand, CLI, and interpreter", () => {
  const analysis = analyzeHookCommand(
    "Stop",
    "/usr/bin/node /repo/dist/src/cli.js claude hook-ingest",
    "claude",
  );
  assert.equal(analysis.subcommand, "claude hook-ingest");
  assert.equal(analysis.cliToken, "/repo/dist/src/cli.js");
  assert.equal(analysis.interpreterToken, "/usr/bin/node");
});

test("a shebang invocation has no separate interpreter", () => {
  const analysis = analyzeHookCommand(
    "Stop",
    "/repo/dist/src/cli.js codex hook",
    "codex",
  );
  assert.equal(analysis.interpreterToken, undefined);
  assert.equal(analysis.cliToken, "/repo/dist/src/cli.js");
});

test("a foreign provider command is not counted as Barbaro", () => {
  const analysis = analyzeHookCommand("Stop", "node cli.js codex hook", "claude");
  assert.equal(analysis.subcommand, undefined);
});

test("a legacy bare CLI name is not counted as Barbaro", () => {
  const analysis = analyzeHookCommand("Stop", "maximus codex hook", "codex");
  assert.equal(analysis.subcommand, undefined);
  assert.equal(analysis.cliToken, undefined);
});

test("both nested and flat hook shapes are collected in event order", () => {
  const commands = collectHookCommands({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "a" }] }],
      SessionStart: [{ type: "command", command: "b" }],
      Broken: "not-an-array",
    },
  });
  assert.deepEqual(commands, [
    { event: "SessionStart", command: "b" },
    { event: "Stop", command: "a" },
  ]);
});

test("a fully wired provider passes with project-local scope", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });

    for (const provider of ["claude", "codex"] as const) {
      const diagnostic = await checkHookConfig({
        projectRoot: root,
        target: targetFor(provider),
        env,
        nowMs: NOW_MS,
      });
      assert.equal(diagnostic.status, "pass", provider);
      assert.equal(
        diagnostic.facts.find((fact) => fact.key === "scope")?.value,
        "project-local",
      );
      assert.deepEqual(
        diagnostic.facts.find((fact) => fact.key === "events_missing")?.value,
        [],
      );
    }
  });
});

test("a missing project-local config fails", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await rm(join(root, ".codex"), { recursive: true, force: true });

    const diagnostic = await checkHookConfig({
      projectRoot: root,
      target: targetFor("codex"),
      env,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    assert.match(diagnostic.remediation.join(" "), /by hand/);
  });
});

test("unparsable config fails without quoting file content", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await writeFiles(root, { ".codex/hooks.json": "{ not json SECRETTOKEN" });

    const diagnostic = await checkHookConfig({
      projectRoot: root,
      target: targetFor("codex"),
      env,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    assert.equal(
      JSON.stringify(diagnostic).includes("SECRETTOKEN"),
      false,
      "hook config content must not be echoed into a diagnostic",
    );
  });
});

test("a hook pointing at an absent CLI fails and names the target", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await rm(join(root, "dist", "src", "cli.js"), { force: true });

    const diagnostic = await checkHookConfig({
      projectRoot: root,
      target: targetFor("claude"),
      env,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    const unresolved = diagnostic.facts.find(
      (fact) => fact.key === "cli_targets_unresolved",
    )?.value;
    assert.deepEqual(unresolved, [join(root, "dist/src/cli.js")]);
  });
});

test("a bare interpreter that is not on PATH fails", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await writeFiles(root, {
      ".codex/hooks.json": JSON.stringify({
        hooks: Object.fromEntries(
          targetFor("codex").requiredEvents.map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: "command",
                    command: `node ${root}/dist/src/cli.js codex hook`,
                  },
                  {
                    type: "command",
                    command: `node ${root}/dist/src/cli.js codex hook-ingest`,
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    });

    const diagnostic = await checkHookConfig({
      projectRoot: root,
      target: targetFor("codex"),
      env: { PATH: join(root, "empty-bin") },
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "fail");
    assert.match(diagnostic.remediation.join(" "), /not on PATH/);
    assert.deepEqual(
      diagnostic.facts.find((fact) => fact.key === "interpreters_unresolved")
        ?.value,
      ["node"],
    );
  });
});

test("a linked bare `barbaro` command resolves through PATH", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await makeExecutable(root, "dist/src/cli.js");
    await symlink(
      join(root, "dist", "src", "cli.js"),
      join(root, "bin", "barbaro"),
      "file",
    );
    await writeFiles(root, {
      ".codex/hooks.json": JSON.stringify({
        hooks: Object.fromEntries(
          targetFor("codex").requiredEvents.map((event) => [
            event,
            [
              {
                hooks: [
                  { type: "command", command: "barbaro codex hook" },
                  { type: "command", command: "barbaro codex hook-ingest" },
                ],
              },
            ],
          ]),
        ),
      }),
    });

    const inspection = await inspectHookConfig({
      projectRoot: root,
      target: targetFor("codex"),
      env,
    });
    assert.deepEqual(inspection.cliTargets, ["barbaro"]);
    assert.deepEqual(inspection.cliTargetsUnresolved, []);
    assert.deepEqual(inspection.cliTargetsOutsideProject, []);
  });
});

test("missing events and subcommands warn while the CLI still runs", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await writeFiles(root, {
      ".codex/hooks.json": JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${nodePath} ${root}/dist/src/cli.js codex hook`,
                },
              ],
            },
          ],
        },
      }),
    });

    const diagnostic = await checkHookConfig({
      projectRoot: root,
      target: targetFor("codex"),
      env,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "warn");
    assert.deepEqual(
      diagnostic.facts.find((fact) => fact.key === "subcommands_missing")?.value,
      ["codex hook-ingest"],
    );
    assert.deepEqual(
      diagnostic.facts.find((fact) => fact.key === "events_missing")?.value,
      [
        "PermissionRequest",
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "Stop",
        "UserPromptSubmit",
      ],
    );
  });
});

test("a CLI outside the project warns rather than passing silently", async () => {
  await withFixtureRoot(async (root) => {
    const { nodePath, env } = await writeFakeNode(root);
    await writeHealthyProject(root, { nodePath });
    await writeFiles(root, { "outside/cli.js": "export {};\n" });
    const projectRoot = join(root, "project");
    await writeFiles(projectRoot, {
      ".gitignore": ".barbaro/\n",
      ".codex/hooks.json": JSON.stringify({
        hooks: Object.fromEntries(
          targetFor("codex").requiredEvents.map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: "command",
                    command: `${nodePath} ${root}/outside/cli.js codex hook`,
                  },
                  {
                    type: "command",
                    command: `${nodePath} ${root}/outside/cli.js codex hook-ingest`,
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    });

    const diagnostic = await checkHookConfig({
      projectRoot,
      target: targetFor("codex"),
      env,
      nowMs: NOW_MS,
    });
    assert.equal(diagnostic.status, "warn");
    assert.match(diagnostic.summary, /outside this checkout/);
  });
});
