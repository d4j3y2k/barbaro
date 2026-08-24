import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared fixture helpers for the setup-doctor tests. Every fixture lives in a
 * throwaway temporary directory so no test can observe or disturb the
 * repository it is dogfooding.
 */

export async function withFixtureRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "barbaro-setup-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes POSIX-relative files, creating parents as needed. */
export async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const relativePath of Object.keys(files).sort()) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files[relativePath] ?? "", "utf8");
  }
}

export async function makeDirectories(
  root: string,
  directories: readonly string[],
): Promise<void> {
  for (const relativePath of directories) {
    await mkdir(join(root, ...relativePath.split("/")), { recursive: true });
  }
}

export async function setMtime(
  root: string,
  relativePath: string,
  when: Date,
): Promise<void> {
  const path = join(root, ...relativePath.split("/"));
  await utimes(path, when, when);
}

export async function makeExecutable(
  root: string,
  relativePath: string,
): Promise<void> {
  await chmod(join(root, ...relativePath.split("/")), 0o755);
}

/**
 * Sorted `path|size|mtimeMs` census used to prove the doctor never writes.
 * Directory entry names are included so a created or removed path is caught.
 */
export async function snapshotTree(root: string): Promise<string> {
  const lines: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = path.slice(root.length);
      if (entry.isDirectory()) {
        lines.push(`dir ${relativePath}`);
        pending.push(path);
        continue;
      }
      const stats = await stat(path).catch(() => undefined);
      lines.push(
        `file ${relativePath} ${stats?.size ?? "?"} ${stats?.mtimeMs ?? "?"}`,
      );
    }
  }
  return lines.sort().join("\n");
}

const NOW = new Date("2026-08-16T20:00:00.000Z");

export const FIXTURE_NOW = NOW;

/**
 * A project that passes every check: built CLI newer than its source, both
 * hook configs wired to that CLI, `.barbaro/` ignored, and fresh views.
 */
export async function writeHealthyProject(
  root: string,
  options: { readonly nodePath: string },
): Promise<void> {
  const cli = `${root}/dist/src/cli.js`;
  const hookCommand = (subcommand: string): string =>
    `${options.nodePath} ${cli} ${subcommand}`;
  const commonEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ];
  const buildHooks = (provider: string): unknown => {
    const events =
      provider === "claude"
        ? [...commonEvents, "PostToolBatch", "UserPromptExpansion"]
        : [...commonEvents, "PermissionRequest"];
    return {
      hooks: Object.fromEntries(
        events.map((event) => [
        event,
        [
          {
            hooks: [
              { type: "command", command: hookCommand(`${provider} hook`) },
              {
                type: "command",
                command: hookCommand(`${provider} hook-ingest`),
              },
            ],
          },
        ],
        ]),
      ),
    };
  };

  await writeFiles(root, {
    ".gitignore": ".barbaro/\ndist/\nnode_modules/\n",
    "package.json": '{"name":"demo"}\n',
    "tsconfig.json": "{}\n",
    "src/cli.ts": "export const cli = true;\n",
    "src/setup/doctor.ts": "export const doctor = true;\n",
    "dist/src/cli.js": "export const cli = true;\n",
    "dist/src/setup/doctor.js": "export const doctor = true;\n",
    ".codex/hooks.json": `${JSON.stringify(buildHooks("codex"), null, 2)}\n`,
    ".claude/settings.local.json": `${JSON.stringify(buildHooks("claude"), null, 2)}\n`,
    ".barbaro/active/claude/actor_a.json": "{}\n",
    ".barbaro/feed/codex/ses_a.jsonl": "{}\n",
    ".barbaro/evidence/codex/ev_a.json": "{}\n",
    ".barbaro/state/codex/checkpoint.json": "{}\n",
  });

  const sourceTime = new Date(NOW.getTime() - 60_000);
  const buildTime = new Date(NOW.getTime() - 30_000);
  for (const source of ["src/cli.ts", "src/setup/doctor.ts", "tsconfig.json", "package.json"]) {
    await setMtime(root, source, sourceTime);
  }
  for (const output of ["dist/src/cli.js", "dist/src/setup/doctor.js"]) {
    await setMtime(root, output, buildTime);
  }
  for (const view of [
    ".barbaro/active/claude/actor_a.json",
    ".barbaro/feed/codex/ses_a.jsonl",
    ".barbaro/evidence/codex/ev_a.json",
    ".barbaro/state/codex/checkpoint.json",
  ]) {
    await setMtime(root, view, buildTime);
  }
}

/** Creates a fake interpreter on a fixture-local PATH. It is never executed. */
export async function writeFakeNode(root: string): Promise<{
  readonly nodePath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}> {
  await writeFiles(root, { "bin/node": "#!/bin/sh\nexit 0\n" });
  await makeExecutable(root, "bin/node");
  return {
    nodePath: join(root, "bin", "node"),
    env: { PATH: join(root, "bin") },
  };
}
