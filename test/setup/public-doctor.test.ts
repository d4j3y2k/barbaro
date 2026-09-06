import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { runDoctor, formatDoctorReport } from "../../src/setup/public-doctor.js";
import { checkEffectiveIgnore } from "../../src/setup/effective-ignore.js";
import { writeFiles, snapshotTree } from "./fixture.js";
import { admitHookSession } from "../../src/hooks/participation.js";
import { claimHookNudge } from "../../src/nudge/unread.js";
import { createSessionId } from "../../src/core/id.js";
import { inspectRuntimeIdentity } from "../../src/setup/runtime.js";
import { ActiveLeaseStore } from "../../src/active/store.js";
import { deriveLeaseId } from "../../src/active/identity.js";
const exec = promisify(execFile);
const NOW = new Date("2026-09-05T12:00:00.000Z");

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "barbaro-public-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project"); const home = join(directory, "home"); const pkg = join(directory, "package");
  await mkdir(project); await mkdir(home);
  const env = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude") };
  await exec("/usr/bin/git", ["init", "-q", project], { env });
  await writeFile(join(project, ".gitignore"), ".barbaro/\n");
  await writeFiles(pkg, {
    "package.json": JSON.stringify({ name: "barbaro", version: "0.1.0-alpha.6", type: "module" }),
    "dist/src/cli.js": "#!/usr/bin/env node\nthrow new Error('MUST_NOT_EXECUTE_CONFIGURED_CLI');\n",
    ".agents/skills/barbaro/SKILL.md": "Codex shipped skill\n",
    ".claude/skills/barbaro/SKILL.md": "Claude shipped skill\n",
    ".claude/skills/barbaro-watch/SKILL.md": "Claude shipped watcher\n",
  });
  await exec(process.execPath, [join(process.cwd(), "scripts/write-build-identity.mjs")], { cwd: pkg });
  const cli = join(pkg, "dist/src/cli.js");
  for (const provider of ["codex", "claude"] as const) {
    const config = JSON.parse((await readFile(`examples/${provider}-hooks.json`, "utf8")).replaceAll("BARBARO_BIN", cli));
    await writeFiles(home, { [provider === "codex" ? ".codex/hooks.json" : ".claude/settings.json"]: JSON.stringify(config) });
  }
  for (const relative of [".agents/skills/barbaro/SKILL.md", ".claude/skills/barbaro/SKILL.md", ".claude/skills/barbaro-watch/SKILL.md"]) {
    await writeFiles(home, { [relative]: await readFile(join(pkg, relative), "utf8") });
  }
  const run = () => runDoctor({ projectRoot: project, cliPath: cli, env, now: NOW });
  return { directory, project, home, pkg, cli, env, run };
}

test("public doctor validates user-wide hooks and copies, leaves every file untouched, and does not invent live evidence", async (t) => {
  const f = await fixture(t);
  const before = await snapshotTree(f.directory);
  const report = await f.run();
  assert.equal(await snapshotTree(f.directory), before);
  assert.deepEqual(await f.run(), report, "same filesystem and reference clock produce the same report");
  assert.equal(report.schema, "barbaro.doctor.v1");
  assert.equal(report.status, "warn", JSON.stringify(report.diagnostics.filter((item) => item.status === "fail")));
  assert.ok(report.providers.every((provider) => provider.configured));
  for (const id of ["runtime.identity", "store.ignore", "codex.hooks", "claude.hooks", "codex.skills", "claude.skills", "codex.interpreter", "claude.interpreter"]) {
    assert.equal(report.diagnostics.find((item) => item.id === id)?.status, "pass", id);
  }
  for (const id of ["codex.publication", "claude.publication", "codex.delivery", "claude.delivery"]) {
    assert.equal(report.diagnostics.find((item) => item.id === id)?.facts.find((fact) => fact.key === "state")?.value, "unverified");
  }
  const encoded = JSON.stringify(report);
  assert.ok(!encoded.includes("MUST_NOT_EXECUTE_CONFIGURED_CLI"));
  assert.ok(!encoded.includes("Codex shipped skill"));
  assert.match(formatDoctorReport(report), /barbaro doctor: WARN/u);
  assert.match(formatDoctorReport(report), /Use --json/u);
});

test("public doctor diagnoses merged duplicates, async mistakes, mismatched skills, and changed build modules", async (t) => {
  const f = await fixture(t);
  const original = JSON.parse(await readFile(join(f.home, ".claude/settings.json"), "utf8"));
  await writeFiles(f.project, { ".claude/settings.json": JSON.stringify(original), ".agents/skills/barbaro/SKILL.md": "old skill\n" });
  original.hooks.Stop[0].hooks[0].async = true;
  await writeFiles(f.home, { ".claude/settings.json": JSON.stringify(original) });
  await writeFile(f.cli, "changed after build\n");
  const report = await f.run();
  assert.equal(report.status, "fail");
  const hook = report.diagnostics.find((item) => item.id === "claude.hooks")!;
  assert.equal(hook.status, "fail");
  assert.ok((hook.facts.find((fact) => fact.key === "duplicate_roles")?.value as string[]).includes("Stop:hook"));
  assert.equal(report.diagnostics.find((item) => item.id === "codex.skills")?.status, "warn");
  assert.equal(report.runtimes[0]?.reason, "cli_hash_mismatch");
});

test("effective ignore checks global rules, negations, and tracked stores through read-only Git queries", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, ".gitignore"), "");
  const global = join(f.home, "ignore"); await writeFile(global, ".barbaro/\n");
  await exec("/usr/bin/git", ["config", "--global", "core.excludesFile", global], { env: f.env });
  assert.equal((await checkEffectiveIgnore(f.project, f.env)).status, "pass");
  await writeFile(join(f.project, ".gitignore"), "!.barbaro/\n");
  assert.equal((await checkEffectiveIgnore(f.project, f.env)).status, "warn");
  await writeFile(join(f.project, ".gitignore"), ".barbaro/\n");
  await writeFiles(f.project, { ".barbaro/tracked": "fixture" });
  await exec("/usr/bin/git", ["add", "-f", ".barbaro/tracked"], { cwd: f.project, env: f.env });
  assert.equal((await checkEffectiveIgnore(f.project, f.env)).status, "warn");
});

test("doctor CLI exposes text, JSON, help and distinct usage exit status without writing", async (t) => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  async function run(args: string[]) {
    try { const value = await exec(process.execPath, [cli, "doctor", ...args], { env: f.env, cwd: f.project }); return { ...value, code: 0 }; }
    catch (error) { return error as { code: number; stdout: string; stderr: string }; }
  }
  const before = await snapshotTree(f.directory);
  const structured = await run(["--json"]);
  assert.equal(structured.code, 1);
  assert.equal(structured.stderr, "");
  assert.equal(JSON.parse(structured.stdout).schema, "barbaro.doctor.v1");
  assert.match((await run([])).stdout, /^barbaro doctor: /u);
  assert.equal((await run(["--help"])).code, 0);
  for (const args of [["--unknown"], ["--json", "--json"], ["--project-root"], ["--json", "true"]]) assert.equal((await run(args)).code, 2);
  assert.equal(await snapshotTree(f.directory), before);
});

test("doctor distinguishes recent publication and delivery, stale evidence, changed runtimes, and an ok attempt with a publication blocker", async (t) => {
  const f = await fixture(t);
  const runtime = await inspectRuntimeIdentity(f.cli);
  const joinedAt = new Date(NOW.getTime() - 60000);
  let claudeJournalPath = "";
  for (const provider of ["codex", "claude"] as const) {
    const native = `${provider}-doctor-fixture`;
    const sessionId = createSessionId(provider, native);
    const joined = await admitHookSession({ projectRoot: f.project, provider, nativeSessionId: native, event: "UserPromptSubmit",
      prompt: provider === "codex" ? "$barbaro new fixture" : "/barbaro join fixture", now: joinedAt });
    const stream = joined.participation!.workstream_id!;
    const turnId = `turn_${(provider === "codex" ? "a" : "b").repeat(32)}`;
    await claimHookNudge({ projectRoot: f.project, provider, nativeSessionId: native, marker: "user_prompt", now: joinedAt,
      turn: provider === "codex" ? { kind: "codex", turn_id: turnId } : { kind: "claude", phase: "current" } });
    const content = { text: "CANONICAL_BODY_MUST_NOT_APPEAR_IN_DOCTOR", fidelity: "verbatim", truncated: false, redactions: [] };
    const turn = { schema: "barbaro.turn.v1", turn_id: turnId, provider, session_id: sessionId, workstream_id: stream, sequence: 1,
      agent_id: "main", started_at: new Date(NOW.getTime() - 30000).toISOString(), ended_at: new Date(NOW.getTime() - 20000).toISOString(), outcome: "success",
      request: content, response: content, actions: [], evidence_refs: [], source_refs: [],
      subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] } };
    const journal = { schema: "barbaro.ingest-attempt-journal.v2", provider, session_id: sessionId, dropped_attempts: 0, attempts: [{
      attempt_id: "fixture-attempt", event: "Stop", trigger: { turn_id: turnId }, triggered_at: NOW.toISOString(), started_at: NOW.toISOString(),
      pid: 1, observations: { count: 0, first: null, last: null, size_transitions: [], dropped_transitions: 0 }, checkpoint_before: null, checkpoint_after: null,
      turns_appended: 1, pending_background_ids: [], pending_agent_ids: [], finished_at: NOW.toISOString(), outcome: "ok",
    }] };
    const delivery = { schema: "barbaro.read-observation.v1", provider, session_id: sessionId, omitted: 0, observations: [{
      invocation_sha256: "a".repeat(64), created_at: NOW.toISOString(), updated_at: NOW.toISOString(), state: "committed", reason: "model_delivery_verified",
      adapter: provider === "codex" ? "codex-0.153.3-literal-exec" : "claude-2.1.261-foreground-batch", runtime_cli_sha256: runtime.cli!.sha256, runtime_build_sha256: runtime.build_identity_sha256,
      ...(provider === "codex" ? { producer_version: "0.153.3" } : {}),
    }] };
    await writeFiles(f.project, { [`.barbaro/feed/${provider}/${sessionId}.jsonl`]: `${JSON.stringify(turn)}\n`,
      [`.barbaro/logs/ingest/${provider}/${sessionId}.json`]: JSON.stringify(journal), [`.barbaro/logs/delivery/${provider}/${sessionId}.json`]: JSON.stringify(delivery) });
    if (provider === "claude") claudeJournalPath = join(f.project, `.barbaro/logs/ingest/${provider}/${sessionId}.json`);
  }
  const before = await snapshotTree(f.directory);
  let report = await f.run();
  assert.equal(report.status, "pass", JSON.stringify(report.diagnostics.filter((row) => row.status !== "pass")));
  assert.ok(!JSON.stringify(report).includes("CANONICAL_BODY_MUST_NOT_APPEAR_IN_DOCTOR"));
  assert.equal(await snapshotTree(f.directory), before);
  const state = (id: string) => report.diagnostics.find((row) => row.id === id)?.facts.find((fact) => fact.key === "state")?.value;
  assert.equal(state("claude.publication"), "observed_working");
  assert.equal(state("codex.delivery"), "observed_working");
  const producerFacts = report.diagnostics.find((row) => row.id === "codex.delivery")!.facts;
  assert.deepEqual(producerFacts.find((row) => row.key === "observed_trace_producer_versions")?.value, ["0.153.3"]);
  assert.match(String(producerFacts.find((row) => row.key === "producer_version_source")?.value), /session trace; installed command version is separate/u);
  report = await runDoctor({ projectRoot: f.project, cliPath: f.cli, env: f.env, now: new Date(NOW.getTime() + 16 * 60 * 1000) });
  assert.equal(state("claude.publication"), "stale");
  assert.equal(state("codex.delivery"), "stale");
  const journal = JSON.parse(await readFile(claudeJournalPath, "utf8"));
  journal.attempts[0].publish_blocker = "trailing_turn_close_timeout";
  await writeFile(claudeJournalPath, JSON.stringify(journal));
  report = await f.run();
  assert.equal(state("claude.publication"), "attention", "outcome ok cannot hide a publication blocker");
  assert.match(JSON.stringify(report), /trailing_turn_close_timeout/u);
  const claudeId = createSessionId("claude", "claude-doctor-fixture");
  assert.ok(formatDoctorReport(report).includes(`Attention sessions: ${claudeId}`));
  const later = new Date(NOW.getTime() + 16 * 60 * 1000);
  const laterReport = () => runDoctor({ projectRoot: f.project, cliPath: f.cli, env: f.env, now: later });
  report = await laterReport();
  assert.equal(state("claude.publication"), "stale", "abandoned publication blockers age out of current attention");
  assert.ok(!formatDoctorReport(report).includes(`Attention sessions: ${claudeId}`));
  const active = new ActiveLeaseStore(join(f.project, ".barbaro/active"));
  const stream = (report.providers.find((row) => row.provider === "claude")!.details as any).live.publication[0].workstream_id as string;
  const lease = { provider: "claude" as const, session_id: claudeId, agent_id: "main", lease_id: deriveLeaseId("claude", claudeId, "main"),
    workstream_id: stream, state: "working" as const, claims: [], unknown_write_scope: false };
  await active.write(lease, { now: later });
  report = await laterReport();
  assert.equal(state("claude.publication"), "attention", "a live main lease keeps unresolved publication actionable");
  await active.write({ ...lease, state: "idle" }, { now: later });
  report = await laterReport();
  assert.equal(state("claude.publication"), "stale", "idle leases do not keep abandoned publication actionable");
  await active.write(lease, { now: NOW });
  report = await laterReport();
  assert.equal(state("claude.publication"), "stale", "expired working leases do not keep old blockers current");
  await writeFile(f.cli, "#!/usr/bin/env node\n// different build\n");
  await exec(process.execPath, [join(process.cwd(), "scripts/write-build-identity.mjs")], { cwd: f.pkg });
  report = await f.run();
  assert.equal(state("codex.delivery"), "unverified", "an earlier build's delivery cannot establish the new runtime");
});

test("doctor reports native resource refusal sizes and bounds without changing the store", async (t) => {
  const f = await fixture(t);
  const native = "native-limit-doctor";
  const sessionId = createSessionId("codex", native);
  await admitHookSession({ projectRoot: f.project, provider: "codex", nativeSessionId: native, event: "UserPromptSubmit", prompt: "$barbaro new limit", now: NOW });
  const runtime = await inspectRuntimeIdentity(f.cli);
  for (const kind of ["file", "record"] as const) {
    const maximum = (kind === "file" ? 128 : 8) * 1024 * 1024;
    const limit = { kind, maximum_bytes: maximum, observed_bytes: maximum + 1 };
    await writeFiles(f.project, { [`.barbaro/logs/delivery/codex/${sessionId}.json`]: JSON.stringify({
      schema: "barbaro.read-observation.v1", provider: "codex", session_id: sessionId, omitted: 0, observations: [{
        invocation_sha256: "a".repeat(64), created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        state: "refused", reason: "native_trace_limit", native_trace_limit: limit,
        adapter: "codex-0.153.2-literal-exec", runtime_cli_sha256: runtime.cli!.sha256, runtime_build_sha256: runtime.build_identity_sha256,
      }],
    }) });
    const before = await snapshotTree(f.directory);
    const report = await f.run();
    const diagnosis = report.diagnostics.find((row) => row.id === "codex.delivery")!;
    assert.equal(diagnosis.status, "warn");
    assert.deepEqual(diagnosis.facts.find((fact) => fact.key === "native_trace_limits")?.value,
      [{ session_id: sessionId, observed_at: NOW.toISOString(), ...limit }]);
    const text = formatDoctorReport(report);
    assert.ok(text.includes(`${maximum + 1} bytes`));
    assert.ok(text.includes(`${maximum}-byte bound`));
    assert.ok(text.includes("unread is preserved and nudges continue"));
    if (kind === "record") assert.ok(text.includes(`at least ${maximum + 1} bytes`));
    assert.equal(await snapshotTree(f.directory), before);
  }
});

test("busy-store doctor selects recent members before caps and preserves positive publication alongside limited coverage", async (t) => {
  const f = await fixture(t);
  const stream = `ws_${"9".repeat(32)}`;
  const old = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(NOW.getTime() - 30000).toISOString();
  const freshestLease = new Date(NOW.getTime() - 10000);
  const freshestJoin = new Date(NOW.getTime() - 5000).toISOString();
  const newest = `ses_${"f".repeat(32)}`;
  const leaseMember = `ses_${(78).toString(16).padStart(32, "0")}`;
  const joinedMember = `ses_${(77).toString(16).padStart(32, "0")}`;
  await writeFiles(f.project, { [`.barbaro/workstreams/${stream}.json`]: JSON.stringify({
    schema: "barbaro.workstream.v1", workstream_id: stream, name: "busy-store", status: "open",
    created_at: old, updated_at: old, created_by: { kind: "cli" }, revision: 1,
  }) });
  const active = new ActiveLeaseStore(join(f.project, ".barbaro/active"));
  for (const provider of ["codex", "claude"] as const) {
    for (let index = 0; index < 80; index++) {
      const sessionId = index === 79 ? newest : `ses_${index.toString(16).padStart(32, "0")}`;
      const from = index === 77 ? freshestJoin : old;
      const publishedAt = index === 79 ? recent : old;
      const content = { text: "BUSY_CANONICAL_BODY_CANARY", fidelity: "verbatim", truncated: false, redactions: [] };
      const turnId = `turn_${index.toString(16).padStart(32, "0")}`;
      await writeFiles(f.project, {
        [`.barbaro/sessions/${provider}/${sessionId}.json`]: JSON.stringify({ schema: "barbaro.session-participation.v2",
          provider, session_id: sessionId, joined_at: from, initiated_by: "user_prompt", workstream_id: stream,
          memberships: [{ workstream_id: stream, from }] }),
        [`.barbaro/feed/${provider}/${sessionId}.jsonl`]: `${JSON.stringify({ schema: "barbaro.turn.v1",
          provider, session_id: sessionId, turn_id: turnId, sequence: 1, workstream_id: stream, agent_id: "main",
          started_at: publishedAt, ended_at: publishedAt, outcome: "success", request: content, response: content,
          actions: [], evidence_refs: [], source_refs: [], subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] } })}\n`,
        [`.barbaro/logs/ingest/${provider}/${sessionId}.json`]: JSON.stringify({ schema: "barbaro.ingest-attempt-journal.v2", provider, session_id: sessionId, dropped_attempts: 0,
          attempts: [{ attempt_id: "busy-fixture", event: "Stop", trigger: { turn_id: turnId }, triggered_at: publishedAt, started_at: publishedAt, pid: 1,
            observations: { count: 0, first: null, last: null, size_transitions: [], dropped_transitions: 0 }, checkpoint_before: null, checkpoint_after: null,
            turns_appended: 1, pending_background_ids: [], pending_agent_ids: [], finished_at: publishedAt, outcome: "ok" }] }),
        [`.barbaro/state/${provider}/${index.toString(16).padStart(32, "0")}.json`]: "{}\n",
      });
      await active.write({ provider, session_id: sessionId, agent_id: "main", lease_id: deriveLeaseId(provider, sessionId, "main"),
        workstream_id: stream, state: "idle", claims: [], unknown_write_scope: false }, { now: index === 78 ? freshestLease : old });
    }
  }
  const before = await snapshotTree(f.directory);
  const report = await f.run();
  assert.equal(await snapshotTree(f.directory), before);
  assert.equal(report.store_health.coverage.state, "limited", "more than 64 active/state records limit the independent store census");
  for (const provider of report.providers) {
    const details = provider.details as { live: { publication_state: string; delivery_state: string; coverage: string; sessions_shown: number;
      sessions_found: number; sessions_omitted: number; publication: { session_id: string; state: string }[] } };
    const live = details.live;
    assert.equal(live.sessions_found, 80);
    assert.equal(live.sessions_shown, 8);
    assert.equal(live.sessions_omitted, 72);
    assert.equal(live.coverage, "limited");
    assert.equal(live.publication_state, "observed_working", "incomplete coverage must not erase positive evidence");
    assert.equal(live.delivery_state, "unverified", "canonical publication does not establish model delivery");
    assert.deepEqual(live.publication.slice(0, 3).map((row) => row.session_id), [joinedMember, leaseMember, newest]);
    assert.equal(live.publication.find((row) => row.session_id === newest)?.state, "observed_working", "lexically last member survives both source and display caps");
    assert.equal(live.publication.find((row) => row.session_id === leaseMember)?.state, "stale");
    assert.ok(live.publication.slice(3).every((row) => row.state === "stale"));
    const diagnostic = report.diagnostics.find((row) => row.id === `${provider.provider}.publication`)!;
    assert.equal(diagnostic.status, "warn", "positive proof is not a claim that the whole provider is healthy");
    assert.ok(!diagnostic.remediation.join(" ").includes("Complete a real first turn"));
  }
  assert.ok(!JSON.stringify(report).includes("BUSY_CANONICAL_BODY_CANARY"));
});
