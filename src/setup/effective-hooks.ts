import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { readDiagnosticBytes } from "./diagnostic-files.js";
import { analyzeHookCommand, tokenizeCommand, type HookProvider } from "./hooks.js";
import { inspectResolvedFile, resolveExecutable } from "./fs-facts.js";

export const MAX_DOCTOR_CONFIG_BYTES = 1024 * 1024;
export const MAX_DOCTOR_HOOKS = 512;
export type DoctorConfigScope = "system" | "user" | "project" | "local";
export interface DoctorConfigLocation {
  readonly provider: HookProvider;
  readonly scope: DoctorConfigScope;
  readonly path: string;
  readonly format: "json" | "toml";
}
export interface DoctorConfigSource extends DoctorConfigLocation {
  readonly state: string;
  readonly sha256?: string;
  readonly hook_count: number;
}
export interface DoctorHookRegistration {
  readonly provider: HookProvider;
  readonly source: string;
  readonly scope: DoctorConfigScope;
  readonly event: string;
  readonly matcher: string;
  readonly role: "hook" | "hook-ingest";
  readonly command_sha256: string;
  readonly enabled: boolean;
  readonly async: boolean;
  readonly cli_path?: string;
  readonly interpreter_path?: string;
  readonly resolution: "resolved" | "unresolved" | "unsupported_command";
}
export interface EffectiveHookInspection {
  readonly provider: HookProvider;
  readonly sources: readonly DoctorConfigSource[];
  readonly registrations: readonly DoctorHookRegistration[];
  readonly unrelated_command_count: number;
  readonly disabled: boolean;
  readonly disabled_source?: string;
  readonly missing_roles: readonly string[];
  readonly duplicate_roles: readonly string[];
  readonly coverage: "complete" | "limited";
  readonly limitations: readonly string[];
}
interface LoadedSource {
  readonly source: DoctorConfigSource;
  readonly value?: Record<string, unknown>;
}
export interface EffectiveHookOptions {
  readonly projectRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit fixtures or embedding hosts can provide their known active layers. */
  readonly locations?: readonly DoctorConfigLocation[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function doctorConfigLocations(projectRoot: string, env: Readonly<Record<string, string | undefined>>): DoctorConfigLocation[] {
  const home = env["HOME"] ?? homedir();
  const codex = resolve(env["CODEX_HOME"] ?? join(home, ".codex"));
  const claude = resolve(env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"));
  const locations: DoctorConfigLocation[] = [];
  for (const [scope, directory] of [["system", "/etc/codex"], ["user", codex], ["project", join(projectRoot, ".codex")]] as const) {
    for (const [file, format] of [["hooks.json", "json"], ["config.toml", "toml"]] as const) {
      locations.push({ provider: "codex", scope, path: join(directory, file), format });
    }
  }
  locations.push({ provider: "codex", scope: "system", path: "/etc/codex/requirements.toml", format: "toml" });
  locations.push(
    { provider: "claude", scope: "user", path: join(claude, "settings.json"), format: "json" },
    { provider: "claude", scope: "project", path: join(projectRoot, ".claude/settings.json"), format: "json" },
    { provider: "claude", scope: "local", path: join(projectRoot, ".claude/settings.local.json"), format: "json" },
    { provider: "claude", scope: "system", path: process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json", format: "json" },
  );
  return locations;
}

async function loadSource(location: DoctorConfigLocation): Promise<LoadedSource> {
  const read = await readDiagnosticBytes(location.path, MAX_DOCTOR_CONFIG_BYTES);
  const base = { ...location, hook_count: 0 };
  if (read.state !== "ok") return { source: { ...base, state: read.state } };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const value = object(location.format === "toml" ? parseToml(text) : JSON.parse(text));
    if (value === undefined) return { source: { ...base, state: "invalid_shape" } };
    return { source: { ...base, state: "ok", sha256: read.identity.sha256 }, value };
  } catch {
    return { source: { ...base, state: "invalid_syntax" } };
  }
}

const REQUIRED_SYNC: Readonly<Record<HookProvider, readonly string[]>> = {
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"],
  claude: ["SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "SessionEnd"],
};
const REQUIRED_INGEST: Readonly<Record<HookProvider, readonly string[]>> = {
  codex: ["UserPromptSubmit", "Stop", "SessionEnd"],
  claude: ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"],
};

/** Resolve only literal foreground bin or Node invocations; never evaluate shell. */
async function resolveHookCommand(command: string, provider: HookProvider, projectRoot: string, env: Readonly<Record<string, string | undefined>>): Promise<Pick<DoctorHookRegistration, "resolution" | "cli_path" | "interpreter_path">> {
  if (/[`$\\\n\r;&|<>()]/u.test(command)) return { resolution: "unsupported_command" };
  const tokens = tokenizeCommand(command);
  const args = tokens.slice(-2);
  if (args[0] !== provider || !["hook", "hook-ingest"].includes(args[1] ?? "")) return { resolution: "unsupported_command" };
  const prefix = tokens.slice(0, -2);
  if (prefix.length < 1 || prefix.length > 2) return { resolution: "unsupported_command" };
  const cli = prefix.at(-1)!;
  let interpreter: string | undefined;
  if (prefix.length === 2) {
    if (!/^node(?:\.exe)?$/u.test(basename(prefix[0]!))) return { resolution: "unsupported_command" };
    interpreter = await resolveExecutable(prefix[0]!.includes("/") ? resolve(projectRoot, prefix[0]!) : prefix[0]!, env);
    if (interpreter === undefined) return { resolution: "unresolved" };
    const info = await inspectResolvedFile(interpreter);
    interpreter = info.realPath ?? interpreter;
  }
  const target = cli.includes("/") ? resolve(projectRoot, cli) : await resolveExecutable(cli, env);
  if (target === undefined) return { resolution: "unresolved" };
  const info = await inspectResolvedFile(target);
  if (info.kind !== "file" || (interpreter === undefined && info.executable !== true)) return { resolution: "unresolved" };
  return {
    resolution: "resolved", cli_path: info.realPath ?? target,
    ...(interpreter === undefined ? {} : { interpreter_path: interpreter }),
  };
}

function setting(layers: readonly LoadedSource[], name: string): { value: unknown; path: string } | undefined {
  const priority: Record<DoctorConfigScope, number> = { user: 0, project: 1, local: 2, system: 3 };
  let selected: { value: unknown; path: string; priority: number } | undefined;
  for (const layer of layers) {
    const value = name.split(".").reduce<unknown>((node, part) => object(node)?.[part], layer.value);
    if (value === undefined) continue;
    if (selected === undefined || priority[layer.source.scope] >= selected.priority) {
      selected = { value, path: layer.source.path, priority: priority[layer.source.scope] };
    }
  }
  return selected;
}

export async function inspectEffectiveHooks(options: EffectiveHookOptions): Promise<EffectiveHookInspection[]> {
  const root = resolve(options.projectRoot);
  const env = options.env ?? process.env;
  const locations = options.locations ?? doctorConfigLocations(root, env);
  if (locations.length > 32) throw new RangeError("Doctor accepts at most 32 config sources");
  const loaded: LoadedSource[] = [];
  for (const location of locations) loaded.push(await loadSource(location));
  const reports: EffectiveHookInspection[] = [];
  for (const provider of ["codex", "claude"] as const) {
    const layers = loaded.filter((layer) => layer.source.provider === provider);
    const registrations: DoctorHookRegistration[] = [];
    let unrelated = 0;
    let limited = layers.some((layer) => !["ok", "missing"].includes(layer.source.state));
    for (const name of provider === "claude" ? ["disableAllHooks", "allowManagedHooksOnly"] : ["features.hooks", "features.codex_hooks"]) {
      const configured = setting(layers, name);
      if (configured !== undefined && typeof configured.value !== "boolean") limited = true;
    }
    const disabledSetting = setting(layers, provider === "claude" ? "disableAllHooks" : "features.hooks") ??
      (provider === "codex" ? setting(layers, "features.codex_hooks") : undefined);
    const disabled = disabledSetting !== undefined && disabledSetting.value === (provider === "claude");
    const managedOnly = provider === "claude" && setting(layers.filter((layer) => layer.source.scope === "system"), "allowManagedHooksOnly")?.value === true;
    const sources: DoctorConfigSource[] = [];
    let seen = 0;
    for (const layer of layers) {
      let count = 0;
      const hooks = object(layer.value?.["hooks"]);
      if (layer.value?.["hooks"] !== undefined && hooks === undefined) limited = true;
      for (const [event, rawGroups] of Object.entries(hooks ?? {})) {
        if (event === "state") continue; // Codex's per-hook trust/disable records.
        if (!Array.isArray(rawGroups)) { limited = true; continue; }
        for (const [groupIndex, rawGroup] of rawGroups.entries()) {
          const group = object(rawGroup);
          if (group === undefined) { limited = true; continue; }
          const entries = Array.isArray(group["hooks"]) ? group["hooks"] : [group];
          for (const [entryIndex, rawEntry] of entries.entries()) {
            seen += 1;
            if (seen > MAX_DOCTOR_HOOKS) { limited = true; continue; }
            const entry = object(rawEntry);
            if (entry === undefined) { limited = true; continue; }
            if (["async", "enabled", "disabled"].some((key) => entry[key] !== undefined && typeof entry[key] !== "boolean") ||
                (group["matcher"] !== undefined && typeof group["matcher"] !== "string")) limited = true;
            const command = entry["command"];
            if (typeof command !== "string") {
              if (entry["type"] === "command") limited = true;
              continue;
            }
            const analysis = analyzeHookCommand(event, command, provider);
            if (analysis.subcommand === undefined) { unrelated += 1; continue; }
            count += 1;
            const role = analysis.subcommand.endsWith("hook-ingest") ? "hook-ingest" : "hook";
            const matcher = typeof group["matcher"] === "string" ? group["matcher"] : "";
            const nativeEvent = event.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
            const stateKey = `${layer.source.path}:${nativeEvent}:${groupIndex}:${entryIndex}`;
            const stateLayers = layers.filter((candidate) => candidate.source.scope === "user" || candidate.source.scope === "system");
            const disabledByState = provider === "codex" && stateLayers.some((candidate) => {
              const state = object(object(candidate.value?.["hooks"])?.["state"]);
              const current = object(state?.[stateKey]);
              return current?.["enabled"] === false || current?.["disabled"] === true;
            });
            const enabled = !disabled && !disabledByState && (!managedOnly || layer.source.scope === "system") && entry["enabled"] !== false && entry["disabled"] !== true;
            registrations.push({
              provider, source: layer.source.path, scope: layer.source.scope, event, role, matcher,
              command_sha256: createHash("sha256").update(command).digest("hex"), enabled,
              async: entry["async"] === true,
              ...await resolveHookCommand(command, provider, root, env),
            });
          }
        }
      }
      sources.push({ ...layer.source, hook_count: count });
    }
    const active = registrations.filter((hook) => hook.enabled);
    const required = [...REQUIRED_SYNC[provider].map((event) => `${event}:hook`), ...REQUIRED_INGEST[provider].map((event) => `${event}:hook-ingest`)];
    const covered = new Set(active.map((hook) => `${hook.event}:${hook.role}`));
    const duplicates = new Set<string>();
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i]!; const b = active[j]!;
        if (a.event === b.event && a.role === b.role && (a.matcher === b.matcher || ["", "*"].includes(a.matcher) || ["", "*"].includes(b.matcher))) duplicates.add(`${a.event}:${a.role}`);
      }
    }
    reports.push({
      provider, sources, registrations, unrelated_command_count: unrelated, disabled,
      ...(disabled && disabledSetting !== undefined ? { disabled_source: disabledSetting.path } : {}),
      missing_roles: required.filter((role) => !covered.has(role)), duplicate_roles: [...duplicates].sort(),
      coverage: limited ? "limited" : "complete",
      limitations: [
        "Files describe configured hooks; live execution depends on provider trust, launch overrides, environment and any plugin or managed sources not represented here.",
        ...(provider === "codex" ? ["Exact hook trust hashes and interactive disable state require the provider /hooks view; file presence alone is not execution proof."] : []),
        ...(active.some((hook) => !["", "*"].includes(hook.matcher) && !(hook.event === "UserPromptExpansion" && hook.matcher === "barbaro")) ? ["Restricted or regular-expression matchers may omit relevant events; matcher coverage is unverified."] : []),
      ],
    });
  }
  return reports;
}
