import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorConfigLocations, inspectEffectiveHooks, type DoctorConfigLocation } from "../../src/setup/effective-hooks.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "barbaro-effective-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "barbaro"); await writeFile(cli, "#!/bin/sh\nexit 99\n"); await chmod(cli, 0o755);
  const locations: DoctorConfigLocation[] = [];
  const add = async (provider: "codex" | "claude", scope: "user" | "project" | "local" | "system", value: unknown, format: "json" | "toml" = "json") => {
    const path = join(root, `${provider}-${scope}-${locations.length}.${format}`);
    await writeFile(path, format === "toml" ? String(value) : JSON.stringify(value));
    locations.push({ provider, scope, path, format }); return path;
  };
  const template = async (provider: "codex" | "claude") => JSON.parse((await readFile(`examples/${provider}-hooks.json`, "utf8")).replaceAll("BARBARO_BIN", cli));
  return { root, cli, locations, add, template };
}

test("effective hooks accept a user-wide installation without project settings and distinguish unrelated stacks", async (t) => {
  const f = await fixture(t);
  for (const provider of ["codex", "claude"] as const) {
    const config = await f.template(provider);
    config.hooks.PreToolUse.push({ hooks: [{ type: "command", command: "coxtail pretool" }, { type: "command", command: "croquet pretool" }] });
    await f.add(provider, "user", config);
  }
  const reports = await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations });
  for (const report of reports) {
    assert.deepEqual(report.missing_roles, []);
    assert.deepEqual(report.duplicate_roles, []);
    assert.equal(report.unrelated_command_count, 2);
    assert.equal(report.coverage, "complete");
    assert.ok(report.registrations.every((item) => item.enabled && item.resolution === "resolved"));
    assert.ok(!JSON.stringify(report).includes("exit 99"));
    assert.ok(!JSON.stringify(report).includes("coxtail pretool"));
  }
});

test("user and project hook arrays merge; local and managed disable flags follow precedence", async (t) => {
  const f = await fixture(t);
  await f.add("claude", "user", { ...await f.template("claude"), disableAllHooks: true });
  await f.add("claude", "project", await f.template("claude"));
  await f.add("claude", "local", { disableAllHooks: false });
  let report = (await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations }))[1]!;
  assert.equal(report.disabled, false);
  assert.ok(report.duplicate_roles.includes("Stop:hook-ingest"));
  const system = await f.add("claude", "system", { disableAllHooks: true });
  report = (await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations }))[1]!;
  assert.equal(report.disabled, true);
  assert.equal(report.disabled_source, system);
  assert.ok(report.registrations.every((item) => !item.enabled));
  assert.ok(report.missing_roles.includes("PostToolBatch:hook"));
});

test("Codex JSON and inline TOML hooks merge, with feature and individual disable state preserved", async (t) => {
  const f = await fixture(t);
  const source = await f.add("codex", "user", await f.template("codex"));
  const toml = await f.add("codex", "user", `
[features]
hooks = true
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "'${f.cli}' codex hook"
[hooks.state."${source}:post_tool_use:0:0"]
enabled = false
`, "toml");
  let report = (await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations }))[0]!;
  assert.ok(report.duplicate_roles.includes("PreToolUse:hook"));
  assert.ok(report.missing_roles.includes("PostToolUse:hook"));
  assert.equal(report.coverage, "complete");
  await writeFile(toml, "[features]\nhooks = false\n");
  report = (await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations }))[0]!;
  assert.equal(report.disabled, true);
  assert.equal(report.disabled_source, toml);
});

test("managed-only Claude hooks and unsupported command wrappers cannot look runnable", async (t) => {
  const f = await fixture(t);
  await f.add("claude", "user", await f.template("claude"));
  await f.add("claude", "system", { allowManagedHooksOnly: true, hooks: { Stop: [{ hooks: [{ type: "command", command: `echo '${f.cli}' claude hook` }] }] } });
  const report = (await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations }))[1]!;
  assert.ok(report.registrations.filter((item) => item.scope === "user").every((item) => !item.enabled));
  assert.equal(report.registrations.find((item) => item.scope === "system")?.resolution, "unsupported_command");
});

test("configuration roots honor env overrides and malformed files remain uncertain without leaking config text", async (t) => {
  const f = await fixture(t);
  const locations = doctorConfigLocations(f.root, { HOME: "/home/test", CODEX_HOME: "/custom/codex", CLAUDE_CONFIG_DIR: "/custom/claude" });
  assert.ok(locations.some((source) => source.path === "/custom/codex/config.toml"));
  assert.ok(locations.some((source) => source.path === "/custom/claude/settings.json"));
  const path = await f.add("codex", "user", 'secret = "DO-NOT-ECHO', "toml");
  const reports = await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations });
  assert.equal(reports[0]?.coverage, "limited");
  assert.equal(reports[0]?.sources[0]?.state, "invalid_syntax");
  assert.equal(reports[0]?.sources[0]?.path, path);
  assert.ok(!JSON.stringify(reports).includes("DO-NOT-ECHO"));
  await mkdir(join(f.root, "unused"));
});

test("ill-typed enable, async and matcher settings cannot establish complete effective coverage", async (t) => {
  const f = await fixture(t);
  const config = await f.template("claude");
  config.disableAllHooks = "false";
  config.hooks.PostToolUse[0].matcher = 42;
  config.hooks.Stop[0].hooks[0].async = "true";
  await f.add("claude", "user", config);
  const report = (await inspectEffectiveHooks({ projectRoot: f.root, locations: f.locations }))[1]!;
  assert.equal(report.coverage, "limited");
});
