import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify, type JsonValue } from "../core/stable-json.js";
import { inspectEffectiveHooks, type EffectiveHookOptions, type DoctorHookRegistration } from "./effective-hooks.js";
import { inspectRuntimeIdentity, type DoctorRuntimeIdentity } from "./runtime.js";
import { inspectEffectiveSkills } from "./effective-skills.js";
import { checkEffectiveIgnore } from "./effective-ignore.js";
import { inspectDoctorHealth } from "./live-health.js";
import { checkBuildFreshness } from "./build.js";
import { inspectPath, resolveExecutable } from "./fs-facts.js";
import { readDiagnosticBytes, readDiagnosticJson } from "./diagnostic-files.js";
import { facts, countStatuses, worstStatus, type Diagnostic, type DiagnosticStatus } from "./types.js";

export const DOCTOR_SCHEMA = "barbaro.doctor.v1";
export interface DoctorOptions extends Omit<EffectiveHookOptions, "projectRoot"> {
  readonly projectRoot?: string;
  readonly now?: Date;
  /** The running CLI identity; embedding tests may provide a synthetic package. */
  readonly cliPath?: string;
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Public doctor is an observer; all repairs and live verification remain explicit actions. */
export async function runDoctor(options: DoctorOptions = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid date");
  const env = options.env ?? process.env;
  const diagnostics: Diagnostic[] = [];
  const add = (id: string, status: DiagnosticStatus, summary: string, detail: Record<string, JsonValue | undefined> = {}, remediation: string[] = []) =>
    diagnostics.push({ id, title: id, status, summary, facts: facts(detail), remediation });
  const hooks = await inspectEffectiveHooks({ projectRoot, env, ...(options.locations === undefined ? {} : { locations: options.locations }) });
  const cliPath = resolve(options.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url)));
  const paths = [...new Set([cliPath, ...hooks.flatMap((report) => report.registrations.filter((hook) => hook.enabled && hook.cli_path !== undefined).map((hook) => hook.cli_path!))])];
  const runtimes: DoctorRuntimeIdentity[] = [];
  for (const path of paths.slice(0, 8)) runtimes.push(await inspectRuntimeIdentity(path));
  const runtimeHashes = runtimes.filter((runtime) => runtime.state === "verified").flatMap((runtime) => runtime.build_identity_sha256 === undefined ? [] : [runtime.build_identity_sha256]);
  const versions = [...new Set(runtimes.flatMap((runtime) => runtime.package_version === undefined ? [] : [runtime.package_version]))];
  const runtimeMismatch = runtimes.some((runtime) => ["mismatch", "unavailable"].includes(runtime.state)) || versions.length > 1;
  const differentBuilds = new Set(runtimeHashes).size > 1;
  add("runtime.identity", runtimeMismatch ? "fail" : paths.length > 8 || differentBuilds || runtimes.some((runtime) => runtime.state !== "verified") ? "warn" : "pass",
    runtimeMismatch ? "Configured CLI/package/build identities disagree or cannot be read." : differentBuilds ? "Configured CLIs have different build hashes; review the mixed runtime before live use." : "CLI/package/build identity inspected separately from source freshness.",
    { running_cli: cliPath, runtimes_shown: runtimes.length, runtimes_found: paths.length, versions: json(versions) },
    runtimeMismatch || differentBuilds || runtimes.some((runtime) => runtime.state !== "verified") ? ["Review the listed CLI paths and hashes. Build or install one reviewed version, and restart providers as required; doctor changes nothing."] : []);
  const health = await inspectDoctorHealth(projectRoot, now, runtimeHashes);
  add("store.health", health.store.healthy && health.store.coverage.state === "complete" && health.store.read_state === "ok" ? "pass" : "warn",
    health.store.presence === "absent" ? "No coordination store is present; no live publication or delivery is established." : health.store.healthy ? "Stored coordination records passed the bounded reader checks." : "Stored coordination records need attention; inspect coverage and diagnostics.",
    { presence: health.store.presence, coverage: json(health.store.coverage), read_state: health.store.read_state },
    health.store.healthy ? [] : ["Use supported health/context/turn readers to inspect affected feeds. Saved missing feeds remain unread obligations; doctor never repairs or retires them."]);
  const providers: { provider: "codex" | "claude"; configured: boolean; details: JsonValue }[] = [];
  for (const report of hooks) {
    const enabled = report.registrations.filter((hook) => hook.enabled);
    const unresolved = enabled.filter((hook) => hook.resolution !== "resolved");
    const badModes = enabled.filter((hook) => hook.async !== (hook.role === "hook-ingest" && hook.event !== "SessionEnd"));
    const configured = !report.disabled && report.missing_roles.length === 0 && unresolved.length === 0 && badModes.length === 0;
    const restricted = enabled.some((hook) => !["", "*"].includes(hook.matcher) && !(hook.event === "UserPromptExpansion" && hook.matcher === "barbaro"));
    const status = !configured ? "fail" : report.coverage !== "complete" || restricted || report.duplicate_roles.length > 0 ? "warn" : "pass";
    add(`${report.provider}.hooks`, status, configured ? "Required hook roles are configured in the inspected effective file layers." : "Required hook roles are missing, disabled, unresolved, or use the wrong async mode.",
      { configured, disabled: report.disabled, missing_roles: json(report.missing_roles), duplicate_roles: json(report.duplicate_roles),
        unresolved_commands: unresolved.length, wrong_async_modes: badModes.length, unrelated_commands: report.unrelated_command_count, coverage: report.coverage },
      status === "pass" ? [] : ["Compare the named configuration sources with the packaged hook template. Resolve duplicate Barbaro roles, enable required hooks, and confirm trust and active sources in the provider's /hooks view."]);
    const interpreterKeys = new Set<string>();
    const interpreters = [];
    for (const hook of enabled) {
      if (hook.cli_path === undefined) continue;
      const key = `${hook.cli_path}:${hook.interpreter_path ?? "shebang"}`;
      if (interpreterKeys.has(key) || interpreterKeys.size >= 8) continue;
      interpreterKeys.add(key);
      interpreters.push(await interpreter(hook, env));
    }
    const interpreterPass = interpreters.length > 0 && interpreters.every((value) => value.state === "verified") && enabled.length > 0;
    add(`${report.provider}.interpreter`, interpreterPass ? "pass" : "warn", interpreterPass ? "Resolved Node interpreters match the current verified Node version." : "One or more configured interpreter versions remain unverified.",
      { interpreters: json(interpreters), inspector_node: process.version, inspector_exec_path: process.execPath },
      interpreterPass ? [] : ["Confirm the provider's actual interpreter and PATH. Doctor reads literal commands and shebangs; it does not run configured commands or unknown interpreters."]);
    const packageRoots = [...new Set(enabled.flatMap((hook) => runtimes.filter((runtime) => runtime.cli_path === hook.cli_path && runtime.package_root !== undefined).map((runtime) => runtime.package_root!)))];
    const skills = await inspectEffectiveSkills(projectRoot, report.provider, packageRoots, env);
    const skillPass = skills.every((skill) => skill.state === "matching");
    add(`${report.provider}.skills`, skillPass ? "pass" : "warn", skillPass ? "Installed skill copies match the configured CLI package." : "Required skill copies are missing, unreadable, or differ from the configured CLI package.",
      { skills: json(skills.map(({ name, state, selected_path }) => ({ name, state, selected_path }))) },
      skillPass ? [] : ["Install the skills shipped by the reviewed CLI version at the documented user or project location; compare any shadowed copies before replacing them."]);
    const live = health.providers.find((value) => value.provider === report.provider)!;
    for (const kind of ["publication", "delivery"] as const) {
      const state = live[`${kind}_state`];
      const attention = live[`${kind}_attention`];
      const attentionSessions = live[kind].filter((row) => row.state === "attention").map((row) => row.session_id);
      const traceProducers = [...new Set(live.delivery.flatMap((row) => row.last_verified_delivery?.producer_version === undefined ? [] : [row.last_verified_delivery.producer_version]))].sort();
      const nativeLimits = kind === "delivery" ? live.delivery.flatMap((row) => row.latest_observation?.native_trace_limit === undefined ? [] : [{
        session_id: row.session_id, observed_at: row.latest_observation.updated_at, ...row.latest_observation.native_trace_limit,
      }]) : [];
      const complete = live.coverage === "complete" && attention === 0;
      add(`${report.provider}.${kind}`, state === "observed_working" && complete ? "pass" : "warn", `${kind === "publication" ? "Publication" : "Model delivery"}: ${state.replaceAll("_", " ")}.${complete ? "" : " Coverage or other selected sessions still need attention."}`,
        { state, coverage: live.coverage, sessions_shown: live.sessions_shown, sessions_found: live.sessions_found, sessions_needing_attention: attention, attention_session_ids: attentionSessions,
          ...(kind === "delivery" && report.provider === "codex" ? { observed_trace_producer_versions: traceProducers, producer_version_source: "last verified delivery session trace; installed command version is separate", native_trace_limits: json(nativeLimits) } : {}) },
        [...nativeLimits.map((limit) => `Session ${limit.session_id}: last native trace ${limit.kind} refusal observed ${limit.kind === "record" ? "at least " : ""}${limit.observed_bytes} bytes against a ${limit.maximum_bytes}-byte bound. Above the bound, reads are observers, unread is preserved and nudges continue.`),
          ...(state === "observed_working" ? complete ? [] : ["Recent working evidence is present. Inspect the selected sessions and coverage limits before concluding the whole provider or store is healthy."] : [kind === "publication" ? "Complete a real first turn and parallel-tool turn, then check its canonical turn and asynchronous ingest evidence without another prompt." : "Deliver one small foreground barbaro read context envelope to the model and check for a committed observation. Codex 0.153.2 and 0.153.3 require the literal exec forwarder; the observation records the session-trace producer separately from the installed command; Claude's 2.1.261 shape requires successful PostToolUse plus matching PostToolBatch. Unknown shapes and versions are unverified; reservations alone prove no delivery."])]);
    }
    providers.push({ provider: report.provider, configured, details: json({ hooks: report, skills, live }) });
  }
  diagnostics.push(await checkEffectiveIgnore(projectRoot, env));
  const manifest = await readDiagnosticJson(join(projectRoot, "package.json"), 1024 * 1024);
  const ownCheckout = manifest.state === "ok" && manifest.value !== null && typeof manifest.value === "object" && "name" in manifest.value && manifest.value.name === "barbaro";
  if (ownCheckout && (await inspectPath(join(projectRoot, "src"))).kind === "directory") {
    diagnostics.push(await checkBuildFreshness({ projectRoot, nowMs: now.getTime(), limits: { maxEntries: 4096, maxDepth: 16 } }));
  } else add("build.dist-freshness", "pass", "Project is not a Barbaro source checkout; development build freshness is not applicable.");
  const report = () => ({ schema: DOCTOR_SCHEMA, generated_at: now.toISOString(), project_root: projectRoot,
    status: worstStatus(diagnostics.map((item) => item.status)), counts: countStatuses(diagnostics),
    diagnostics: diagnostics.sort((a, b) => a.id.localeCompare(b.id)), runtimes, providers, store_health: health.store,
    observation_limits: { freshness_max_age_ms: health.freshness_max_age_ms, ...health.limits, report_max_bytes: 512 * 1024 },
  });
  if (Buffer.byteLength(stableStringify(report())) > 512 * 1024 - 4096) {
    for (const provider of providers) provider.details = { omitted: true, reason: "report_byte_limit" };
    add("report.coverage", "warn", "Provider details exceed the report budget and were omitted; the report cannot establish complete coverage.");
  }
  return report();
}
export type DoctorReport = Awaited<ReturnType<typeof runDoctor>>;

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`barbaro doctor: ${report.status.toUpperCase()}`, `Project: ${report.project_root}`, `Checked: ${report.generated_at}`, ""];
  for (const diagnostic of report.diagnostics) {
    lines.push(`[${diagnostic.status}] ${diagnostic.id}: ${diagnostic.summary}`);
    const attentionSessions = diagnostic.facts.find((fact) => fact.key === "attention_session_ids")?.value;
    if (Array.isArray(attentionSessions) && attentionSessions.length > 0) lines.push(`  Attention sessions: ${attentionSessions.join(", ")}`);
    for (const step of diagnostic.remediation) lines.push(`  ${step}`);
  }
  lines.push("", "Use --json for source paths, build hashes, observations and bounded coverage details.");
  return `${lines.join("\n")}\n`;
}

async function interpreter(hook: DoctorHookRegistration, env: Readonly<Record<string, string | undefined>>) {
  let path = hook.interpreter_path;
  if (path === undefined && hook.cli_path !== undefined) {
    const read = await readDiagnosticBytes(hook.cli_path, 8 * 1024 * 1024);
    const line = read.state === "ok" ? read.bytes.subarray(0, 256).toString("utf8").split("\n")[0] : undefined;
    if (line === "#!/usr/bin/env node") path = await resolveExecutable("node", env);
    else if (line !== undefined && /^#!\/[^\s]+\/node$/u.test(line)) path = line.slice(2);
  }
  let real: string | undefined;
  try { if (path !== undefined) real = await realpath(path); } catch { /* unavailable */ }
  const same = real !== undefined && real === await realpath(process.execPath);
  return { cli_path: hook.cli_path, ...(real === undefined ? {} : { interpreter_path: real }),
    state: same && Number(process.versions.node.split(".")[0]) >= 22 ? "verified" : "unverified",
    ...(same ? { version: process.version } : {}) };
}
