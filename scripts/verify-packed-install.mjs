#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "barbaro-packed-install-"));
const packDestination = join(sandbox, "pack");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const commandTimeoutMs = 120_000;
const packageManifest = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);

await mkdir(packDestination, { recursive: true });
const packEnvironment = await makeCleanEnvironment("pack");

const trackedSourceFiles = new Set(
  run("git", ["ls-files", "-z", "--", "src"], projectRoot, packEnvironment)
    .stdout.split("\0")
    .filter((path) => path.endsWith(".ts")),
);
const trackedDocs = run(
  "git",
  ["ls-files", "-z", "--", "docs"],
  projectRoot,
  packEnvironment,
).stdout
  .split("\0")
  .filter(Boolean);

try {
  const pack = run(
    npmCommand,
    ["pack", "--json", "--pack-destination", packDestination],
    projectRoot,
    packEnvironment,
  );
  const manifest = parsePackOutput(pack.stdout);
  assert.equal(manifest.length, 1, "npm pack must produce one tarball");
  const packed = manifest[0];
  assert.equal(packed.name, packageManifest.name);
  assert.equal(packed.version, packageManifest.version);
  assert.equal(
    packed.filename,
    `${packageManifest.name}-${packageManifest.version}.tgz`,
  );

  const packedFiles = new Set(packed.files.map((entry) => entry.path));
  for (const required of [
    "package.json",
    "README.md",
    "INSTALL.md",
    "ALPHA.md",
    "SECURITY.md",
    "LICENSE",
    "dist/src/cli.js",
    "dist/src/core/index.js",
    "dist/src/core/index.d.ts",
    ".agents/skills/barbaro/SKILL.md",
    ".claude/skills/barbaro/SKILL.md",
    ".claude/skills/barbaro-watch/SKILL.md",
    "examples/claude-hooks.json",
    "examples/codex-hooks.json",
    "spec/barbaro-v1.md",
    ...trackedDocs,
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
  assert.equal(
    [...packedFiles].some((path) => path.endsWith(".map")),
    false,
    "tarball must not contain source maps",
  );

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
    for (const suffix of [".d.ts", ".js"]) {
      assert.ok(
        packedFiles.has(`${stem}${suffix}`),
        `tarball is missing compiled output for ${sourcePath}: ${stem}${suffix}`,
      );
    }
  }

  const archives = (await readdir(packDestination)).filter((path) =>
    path.endsWith(".tgz"),
  );
  assert.deepEqual(archives, [packed.filename]);
  const archive = join(packDestination, archives[0]);

  for (const install of [
    { label: "normal", ignoreScripts: false },
    { label: "ignore-scripts", ignoreScripts: true },
  ]) {
    await verifyCleanInstall({
      ...install,
      archive,
    });
  }

  process.stdout.write(
    `packed install ok: ${packed.filename} (${packedFiles.size} files; normal + --ignore-scripts)\n`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

async function verifyCleanInstall(options) {
  const environment = await makeCleanEnvironment(options.label);
  const prefix = environment.npm_config_prefix;
  const installArgs = ["install", "--global", "--no-audit", "--no-fund"];
  if (options.ignoreScripts) installArgs.push("--ignore-scripts");
  installArgs.push(options.archive);

  const installed = run(
    npmCommand,
    installArgs,
    environment.HOME,
    environment,
  );
  assertNoInstallScriptWarnings(installed, options.label);

  const bin = process.platform === "win32"
    ? join(prefix, "barbaro.cmd")
    : join(prefix, "bin", "barbaro");
  const installedPackage = process.platform === "win32"
    ? join(prefix, "node_modules", "barbaro")
    : join(prefix, "lib", "node_modules", "barbaro");
  const installedManifest = JSON.parse(
    await readFile(join(installedPackage, "package.json"), "utf8"),
  );

  assert.equal(installedManifest.name, packageManifest.name);
  assert.equal(installedManifest.version, packageManifest.version);
  assert.deepEqual(installedManifest.bin, { barbaro: "dist/src/cli.js" });
  assert.equal(installedManifest.publishConfig?.access, "public");
  assert.equal(installedManifest.publishConfig?.tag, undefined);
  assert.equal(
    installedManifest.scripts?.["study:horse"],
    "node dist/src/tui/horse-preview.js",
  );
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(
      installedManifest.scripts?.[lifecycle],
      undefined,
      `installed manifest must not define ${lifecycle}`,
    );
  }

  if (process.platform !== "win32") {
    const [resolvedBin, resolvedPackage, resolvedProject] = await Promise.all([
      realpath(bin),
      realpath(installedPackage),
      realpath(projectRoot),
    ]);
    assert.ok(
      resolvedBin.startsWith(`${resolvedPackage}/`),
      "installed binary must resolve inside the packed package",
    );
    assert.equal(
      resolvedBin.startsWith(`${resolvedProject}/`),
      false,
      "installed binary must not resolve into the development checkout",
    );
  }

  const commandEnvironment = {
    ...environment,
    PATH: [dirname(bin), ...cleanRuntimePath()].join(delimiter),
  };
  const help = run(bin, ["--help"], environment.HOME, commandEnvironment);
  assert.match(help.stdout, /^barbaro\b/u);
  assert.equal(help.stderr, "");

  const version = run(bin, ["--version"], environment.HOME, commandEnvironment);
  assert.equal(version.stdout, `${packageManifest.version}\n`);
  assert.equal(version.stderr, "");

  const horse = run(
    npmCommand,
    [
      "run",
      "study:horse",
      "--",
      "--once",
      "--frame",
      "3",
      "--scale",
      "compact",
      "--variant",
      "compare",
    ],
    installedPackage,
    commandEnvironment,
  );
  assert.match(horse.stdout, /ORIGINAL/u);
  assert.match(horse.stdout, /RIDERLESS/u);
  assert.doesNotMatch(horse.stderr, /TS\d{4}|tsconfig\.json/u);

  await verifyPackagedDocumentation(installedPackage);
  await verifyNoSourceMapReferences(installedPackage);
}

async function verifyPackagedDocumentation(installedPackage) {
  const readme = await readFile(join(installedPackage, "README.md"), "utf8");
  const install = await readFile(join(installedPackage, "INSTALL.md"), "utf8");
  assert.match(readme, /\(INSTALL\.md\)/u);
  for (const policy of ["ALPHA.md", "SECURITY.md"]) {
    const link = new RegExp(`\\(${policy.replace(".", "\\.")}\\)`, "u");
    assert.match(readme, link, `README must link ${policy}`);
    assert.match(install, link, `INSTALL must link ${policy}`);
  }

  for (const markdownPath of [
    "README.md",
    "INSTALL.md",
    "ALPHA.md",
    "SECURITY.md",
    ...trackedDocs,
  ]) {
    const absolutePath = join(installedPackage, markdownPath);
    const markdown = await readFile(absolutePath, "utf8");
    const prose = markdown
      .replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gmu, "")
      .replace(/`[^`\n]*`/gu, "");
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      let target = match[1].trim().split(/\s+/u, 1)[0];
      if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1);
      }
      if (
        target.startsWith("#")
        || target.startsWith("/")
        || /^[a-z][a-z0-9+.-]*:/iu.test(target)
      ) {
        continue;
      }
      target = target.split(/[?#]/u, 1)[0];
      if (target.length === 0) continue;
      const resolvedTarget = resolve(
        dirname(absolutePath),
        decodeURIComponent(target),
      );
      const packagedRelative = relative(installedPackage, resolvedTarget);
      assert.equal(
        packagedRelative === ".." || packagedRelative.startsWith(`..${sep}`),
        false,
        `${markdownPath} link escapes the installed package: ${target}`,
      );
      await assert.doesNotReject(
        access(resolvedTarget),
        `${markdownPath} has a dangling packaged link: ${target}`,
      );
    }
  }
}

function cleanRuntimePath() {
  const checkoutBin = join(projectRoot, "node_modules", ".bin");
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && resolve(entry) !== checkoutBin);
}

async function verifyNoSourceMapReferences(installedPackage) {
  const javascriptFiles = await filesBelow(
    join(installedPackage, "dist", "src"),
  );
  assert.ok(javascriptFiles.some((path) => path.endsWith(".js")));
  assert.equal(javascriptFiles.some((path) => path.endsWith(".map")), false);
  const compiledJavascript = javascriptFiles.filter((candidate) =>
    candidate.endsWith(".js"),
  );
  for (const path of compiledJavascript) {
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /\/\/[#@]\s*sourceMappingURL=/u,
      `${relative(installedPackage, path)} has a dangling source-map reference`,
    );
  }
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function makeCleanEnvironment(label) {
  const home = join(sandbox, `home-${label}`);
  const cache = join(sandbox, `cache-${label}`);
  const prefix = join(sandbox, `prefix-${label}`);
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(cache, { recursive: true }),
    mkdir(prefix, { recursive: true }),
  ]);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase().startsWith("npm_config_")) delete environment[key];
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_prefix: prefix,
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_update_notifier: "false",
  });
  return environment;
}

function assertNoInstallScriptWarnings(result, label) {
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /allow[- ]scripts?|ignored build scripts?|build scripts? (?:were )?(?:automatically )?blocked|lifecycle script|\bprepare(?: script)?\b/iu,
    `${label} install emitted a lifecycle-script warning`,
  );
}

function run(command, args, cwd, environment) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
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
  for (const suffix of [".d.ts", ".js"]) {
    if (packedPath.endsWith(suffix)) {
      return `${packedPath.slice("dist/".length, -suffix.length)}.ts`;
    }
  }
  return undefined;
}
