#!/usr/bin/env node

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "barbaro-packed-install-"));
const cleanHome = join(sandbox, "home");
const cache = join(sandbox, "npm-cache");
const packDestination = join(sandbox, "pack");
const prefix = join(sandbox, "prefix");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const commandTimeoutMs = 120_000;

await Promise.all([
  mkdir(cleanHome, { recursive: true }),
  mkdir(cache, { recursive: true }),
  mkdir(packDestination, { recursive: true }),
  mkdir(prefix, { recursive: true }),
]);

const cleanEnvironment = {
  ...process.env,
  HOME: cleanHome,
  USERPROFILE: cleanHome,
  npm_config_cache: cache,
  npm_config_prefix: prefix,
  npm_config_userconfig: join(cleanHome, ".npmrc"),
};

const trackedSourceFiles = new Set(
  run("git", ["ls-files", "-z", "--", "src"], projectRoot)
    .stdout.split("\0")
    .filter((path) => path.endsWith(".ts")),
);

try {
  const pack = run(
    npmCommand,
    ["pack", "--json", "--pack-destination", packDestination],
    projectRoot,
  );
  const manifest = parsePackOutput(pack.stdout);
  assert.equal(manifest.length, 1, "npm pack must produce one tarball");

  const packedFiles = new Set(manifest[0].files.map((entry) => entry.path));
  for (const required of [
    "package.json",
    "LICENSE",
    "dist/src/cli.js",
    "dist/src/core/index.js",
    "dist/src/core/index.d.ts",
    ".agents/skills/barbaro/SKILL.md",
    ".claude/skills/barbaro/SKILL.md",
    ".claude/skills/barbaro-watch/SKILL.md",
    "examples/claude-hooks.json",
    "examples/codex-hooks.json",
    "INSTALL.md",
    "spec/barbaro-v1.md",
  ]) {
    assert.ok(packedFiles.has(required), `tarball is missing ${required}`);
  }
  for (const excludedPrefix of [
    ".github/",
    "dist/test/",
    "scripts/",
    "src/",
    "test/",
  ]) {
    assert.equal(
      [...packedFiles].some((path) => path.startsWith(excludedPrefix)),
      false,
      `tarball must not contain ${excludedPrefix}`,
    );
  }
  for (const packedPath of packedFiles) {
    if (!packedPath.startsWith("dist/src/")) continue;
    const sourcePath = sourcePathForCompiled(packedPath);
    assert.notEqual(
      sourcePath,
      undefined,
      `tarball contains an unexpected compiled artifact: ${packedPath}`,
    );
    assert.ok(
      trackedSourceFiles.has(sourcePath),
      `tarball contains output for an untracked source: ${packedPath}`,
    );
  }
  for (const sourcePath of trackedSourceFiles) {
    const stem = `dist/${sourcePath.slice(0, -3)}`;
    for (const suffix of [".d.ts", ".js", ".js.map"]) {
      assert.ok(
        packedFiles.has(`${stem}${suffix}`),
        `tarball is missing compiled output for ${sourcePath}: ${stem}${suffix}`,
      );
    }
  }

  const archives = (await readdir(packDestination)).filter((path) =>
    path.endsWith(".tgz"),
  );
  assert.deepEqual(archives, [manifest[0].filename]);
  const archive = join(packDestination, archives[0]);

  run(
    npmCommand,
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    cleanHome,
  );

  const bin =
    process.platform === "win32"
      ? join(prefix, "barbaro.cmd")
      : join(prefix, "bin", "barbaro");
  const installedPackage = join(prefix, "lib", "node_modules", "barbaro");
  if (process.platform !== "win32") {
    const [resolvedBin, resolvedPackage] = await Promise.all([
      realpath(bin),
      realpath(installedPackage),
    ]);
    assert.ok(
      resolvedBin.startsWith(`${resolvedPackage}/`),
      "installed binary must resolve inside the packed package",
    );
    assert.equal(
      resolvedBin.startsWith(`${await realpath(projectRoot)}/`),
      false,
      "installed binary must not resolve into the development checkout",
    );
  }

  const smoke = run(bin, ["--help"], cleanHome, {
    PATH: `${dirname(bin)}${delimiter}${process.env.PATH ?? ""}`,
  });
  assert.match(smoke.stdout, /^barbaro\b/u);
  process.stdout.write(
    `packed install ok: ${manifest[0].filename} (${packedFiles.size} files)\n`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

function run(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnvironment, ...environment },
    maxBuffer: 10 * 1024 * 1024,
    timeout: commandTimeoutMs,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function parsePackOutput(stdout) {
  const arrayStart = Math.max(stdout.lastIndexOf("\n["), stdout.indexOf("["));
  assert.notEqual(arrayStart, -1, "npm pack did not emit JSON");
  const json = stdout.slice(stdout[arrayStart] === "\n" ? arrayStart + 1 : arrayStart);
  return JSON.parse(json);
}

function sourcePathForCompiled(packedPath) {
  for (const suffix of [".d.ts", ".js.map", ".js"]) {
    if (packedPath.endsWith(suffix)) {
      return `${packedPath.slice("dist/".length, -suffix.length)}.ts`;
    }
  }
  return undefined;
}
