import { isAbsolute, join, resolve } from "node:path";

import { compareUtf16CodeUnits } from "../core/stable-json.js";

import {
  inspectResolvedFile,
  isWithin,
  readJsonFile,
  realPathOrSelf,
  resolveExecutable,
  toPosixRelative,
} from "./fs-facts.js";
import { facts, type Diagnostic, type DiagnosticStatus } from "./types.js";

/**
 * Project-local hook configuration inspection.
 *
 * Only project-local config files are read; user and global settings are never
 * read and never written. Paths outside the project are touched in exactly one
 * read-only way: the interpreter and CLI a project hook names are stat-ed, and
 * a bare command is resolved through PATH the way the hook runner will. No
 * configuration is repaired automatically, because enabling hooks stays an
 * explicit, per-project human decision.
 */

export type HookProvider = "codex" | "claude";

export const MAX_HOOK_CONFIG_BYTES = 1024 * 1024;

export interface HookProviderTarget {
  readonly provider: HookProvider;
  /** Project-relative candidates, any of which may carry the hooks. */
  readonly configPaths: readonly string[];
  readonly requiredEvents: readonly string[];
  readonly requiredSubcommands: readonly string[];
}

export const DEFAULT_HOOK_TARGETS: readonly HookProviderTarget[] = [
  {
    provider: "claude",
    configPaths: [".claude/settings.json", ".claude/settings.local.json"],
    requiredEvents: [
      "SessionEnd",
      "SessionStart",
      "PostToolBatch",
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "UserPromptExpansion",
      "UserPromptSubmit",
    ],
    requiredSubcommands: ["claude hook", "claude hook-ingest"],
  },
  {
    provider: "codex",
    configPaths: [".codex/hooks.json"],
    requiredEvents: [
      "PermissionRequest",
      "SessionEnd",
      "SessionStart",
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ],
    requiredSubcommands: ["codex hook", "codex hook-ingest"],
  },
];

export interface HookCommandAnalysis {
  readonly event: string;
  readonly command: string;
  readonly subcommand: string | undefined;
  readonly cliToken: string | undefined;
  readonly interpreterToken: string | undefined;
}

export interface HookConfigInspection {
  readonly provider: HookProvider;
  readonly configFilesPresent: readonly string[];
  readonly configFilesUnreadable: readonly string[];
  readonly commandCount: number;
  readonly barbaroCommandCount: number;
  readonly eventsCovered: readonly string[];
  readonly eventsMissing: readonly string[];
  readonly subcommandsCovered: readonly string[];
  readonly subcommandsMissing: readonly string[];
  readonly cliTargets: readonly string[];
  readonly cliTargetsUnresolved: readonly string[];
  readonly cliTargetsOutsideProject: readonly string[];
  readonly interpretersUnresolved: readonly string[];
}

/**
 * Split a hook command into shell-like tokens. Single and double quotes group
 * a token; nothing is expanded, substituted, or executed.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const SUBCOMMANDS: readonly string[] = ["hook", "hook-ingest"];

function isBarbaroCliToken(token: string): boolean {
  if (token === "barbaro") return true;
  return (
    token.includes("/") ||
    token.includes("\\") ||
    token.startsWith(".") ||
    token.endsWith(".js")
  );
}

/**
 * Identify the Barbaro invocation inside one hook command: which subcommand it
 * runs, which CLI entry point it names, and which interpreter runs it.
 */
export function analyzeHookCommand(
  event: string,
  command: string,
  provider: HookProvider,
): HookCommandAnalysis {
  const tokens = tokenizeCommand(command);
  let subcommand: string | undefined;
  let cliToken: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const next = tokens[index + 1];
    if (tokens[index] !== provider || next === undefined) continue;
    if (!SUBCOMMANDS.includes(next)) continue;
    const candidate = index > 0 ? tokens[index - 1] : undefined;
    if (candidate === undefined || !isBarbaroCliToken(candidate)) continue;
    subcommand = `${provider} ${next}`;
    cliToken = candidate;
    break;
  }
  const first = tokens[0];
  const interpreterToken =
    first === undefined || first === cliToken ? undefined : first;
  return { event, command, subcommand, cliToken, interpreterToken };
}

interface RawHookCommand {
  readonly event: string;
  readonly command: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Walk the shared Codex/Claude hook shape without assuming it is well formed:
 * `hooks[event]` may hold matcher groups with a nested `hooks` array, or hook
 * entries directly. Anything else is ignored rather than guessed at.
 */
export function collectHookCommands(config: unknown): RawHookCommand[] {
  const root = asRecord(config);
  const hooks = root === undefined ? undefined : asRecord(root["hooks"]);
  if (hooks === undefined) return [];
  const collected: RawHookCommand[] = [];
  for (const event of Object.keys(hooks).sort(compareUtf16CodeUnits)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const groupRecord = asRecord(group);
      if (groupRecord === undefined) continue;
      const entries = Array.isArray(groupRecord["hooks"])
        ? (groupRecord["hooks"] as unknown[])
        : [groupRecord];
      for (const entry of entries) {
        const entryRecord = asRecord(entry);
        if (entryRecord === undefined) continue;
        const command = entryRecord["command"];
        if (typeof command !== "string" || command.length === 0) continue;
        collected.push({ event, command });
      }
    }
  }
  return collected;
}

export interface HookInspectionOptions {
  readonly projectRoot: string;
  readonly target: HookProviderTarget;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function inspectHookConfig(
  options: HookInspectionOptions,
): Promise<HookConfigInspection> {
  const projectRoot = resolve(options.projectRoot);
  // Compare containment against the canonical root too: a symlinked checkout
  // resolves its files elsewhere and would otherwise look external.
  const projectRealPath = await realPathOrSelf(projectRoot);
  const { target } = options;
  const env = options.env ?? process.env;

  const configFilesPresent: string[] = [];
  const configFilesUnreadable: string[] = [];
  const rawCommands: RawHookCommand[] = [];

  for (const relativePath of target.configPaths) {
    const path = join(projectRoot, ...relativePath.split("/"));
    const read = await readJsonFile(path, MAX_HOOK_CONFIG_BYTES);
    if (read.kind === "missing") continue;
    if (read.kind !== "ok") {
      configFilesUnreadable.push(`${relativePath} (${read.kind})`);
      continue;
    }
    configFilesPresent.push(relativePath);
    rawCommands.push(...collectHookCommands(read.value));
  }

  const eventsCovered = new Set<string>();
  const subcommandsCovered = new Set<string>();
  const cliTargets = new Set<string>();
  const cliTargetsUnresolved = new Set<string>();
  const cliTargetsOutsideProject = new Set<string>();
  const interpretersUnresolved = new Set<string>();
  let barbaroCommandCount = 0;

  for (const raw of rawCommands) {
    const analysis = analyzeHookCommand(raw.event, raw.command, target.provider);
    if (analysis.subcommand === undefined) continue;
    barbaroCommandCount += 1;
    eventsCovered.add(raw.event);
    subcommandsCovered.add(analysis.subcommand);

    if (analysis.interpreterToken !== undefined) {
      const interpreter = await resolveExecutable(
        analysis.interpreterToken,
        env,
      );
      if (interpreter === undefined) {
        interpretersUnresolved.add(analysis.interpreterToken);
      }
    }

    const cliToken = analysis.cliToken;
    if (cliToken === undefined) {
      cliTargetsUnresolved.add("(no CLI path in command)");
      continue;
    }
    cliTargets.add(cliToken);
    const resolvedTarget = await resolveCliToken(cliToken, projectRoot, env);
    if (resolvedTarget === undefined) {
      cliTargetsUnresolved.add(cliToken);
      continue;
    }
    if (
      analysis.interpreterToken === undefined &&
      resolvedTarget.executable !== true
    ) {
      cliTargetsUnresolved.add(`${cliToken} (not executable)`);
    }
    if (
      !isWithin(projectRoot, resolvedTarget.realPath) &&
      !isWithin(projectRealPath, resolvedTarget.realPath)
    ) {
      cliTargetsOutsideProject.add(resolvedTarget.realPath);
    }
  }

  const sorted = (values: Iterable<string>): string[] =>
    [...values].sort(compareUtf16CodeUnits);

  return {
    provider: target.provider,
    configFilesPresent: sorted(configFilesPresent),
    configFilesUnreadable: sorted(configFilesUnreadable),
    commandCount: rawCommands.length,
    barbaroCommandCount,
    eventsCovered: sorted(eventsCovered),
    eventsMissing: target.requiredEvents
      .filter((event) => !eventsCovered.has(event))
      .sort(compareUtf16CodeUnits),
    subcommandsCovered: sorted(subcommandsCovered),
    subcommandsMissing: target.requiredSubcommands
      .filter((subcommand) => !subcommandsCovered.has(subcommand))
      .sort(compareUtf16CodeUnits),
    cliTargets: sorted(cliTargets),
    cliTargetsUnresolved: sorted(cliTargetsUnresolved),
    cliTargetsOutsideProject: sorted(cliTargetsOutsideProject),
    interpretersUnresolved: sorted(interpretersUnresolved),
  };
}

async function resolveCliToken(
  cliToken: string,
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ realPath: string; executable: boolean | undefined } | undefined> {
  if (cliToken.includes("/")) {
    const path = isAbsolute(cliToken) ? cliToken : join(projectRoot, cliToken);
    const resolved = await inspectResolvedFile(path);
    if (resolved.kind !== "file") return undefined;
    return {
      realPath: resolved.realPath ?? path,
      executable: resolved.executable,
    };
  }
  // A bare name such as `barbaro` is a linked bin; resolve it through PATH the
  // way the hook runner will, following the npm symlink to its real target.
  const onPath = await resolveExecutable(cliToken, env);
  if (onPath === undefined) return undefined;
  const resolved = await inspectResolvedFile(onPath);
  return {
    realPath: resolved.realPath ?? onPath,
    executable: resolved.executable,
  };
}

export function hookDiagnosticId(provider: HookProvider): string {
  return `hooks.${provider}`;
}

export async function checkHookConfig(
  options: HookInspectionOptions & { readonly nowMs: number },
): Promise<Diagnostic> {
  const inspection = await inspectHookConfig(options);
  const projectRoot = resolve(options.projectRoot);
  const provider = options.target.provider;
  const remediation: string[] = [];
  let status: DiagnosticStatus = "pass";
  let summary: string;

  if (
    inspection.configFilesPresent.length === 0 &&
    inspection.configFilesUnreadable.length === 0
  ) {
    status = "fail";
    summary = `No project-local ${provider} hook config; Barbaro publishes nothing for this provider.`;
    remediation.push(
      `Merge the ${provider} entries from examples/ into ${options.target.configPaths.join(" or ")} by hand.`,
    );
  } else if (inspection.configFilesUnreadable.length > 0) {
    status = "fail";
    summary = `A ${provider} hook config could not be parsed.`;
    remediation.push(
      `Repair ${inspection.configFilesUnreadable.join(", ")} manually; the doctor never rewrites hook configs.`,
    );
  } else if (inspection.barbaroCommandCount === 0) {
    status = "fail";
    summary = `${provider} hook config has no \`barbaro ${provider} hook\` command.`;
    remediation.push(
      `Add the ${provider} hook and hook-ingest commands to ${inspection.configFilesPresent.join(", ")}.`,
    );
  } else if (
    inspection.cliTargetsUnresolved.length > 0 ||
    inspection.interpretersUnresolved.length > 0
  ) {
    status = "fail";
    summary = `${provider} hooks point at a CLI or interpreter that is not runnable.`;
    if (inspection.cliTargetsUnresolved.length > 0) {
      remediation.push(
        `Install the packaged CLI so \`barbaro\` is on PATH, or run \`npm run build\` when a hook intentionally names this checkout, so ${inspection.cliTargetsUnresolved.join(", ")} resolves.`,
      );
    }
    if (inspection.interpretersUnresolved.length > 0) {
      remediation.push(
        `Point the hook interpreter at an existing binary; ${inspection.interpretersUnresolved.join(", ")} is not on PATH.`,
      );
    }
  } else if (
    inspection.subcommandsMissing.length > 0 ||
    inspection.eventsMissing.length > 0
  ) {
    status = "warn";
    summary = `${provider} hooks are runnable but incomplete.`;
    if (inspection.subcommandsMissing.length > 0) {
      remediation.push(
        `Add the missing ${inspection.subcommandsMissing.join(", ")} handler(s); active state and terminal ingest are separate commands.`,
      );
    }
    if (inspection.eventsMissing.length > 0) {
      remediation.push(
        `Cover the missing event(s): ${inspection.eventsMissing.join(", ")}.`,
      );
    }
  } else if (inspection.cliTargetsOutsideProject.length > 0) {
    status = "warn";
    summary = `${provider} hooks run a Barbaro CLI from outside this checkout.`;
    remediation.push(
      `Confirm ${inspection.cliTargetsOutsideProject.join(", ")} is the build you intend to dogfood.`,
    );
  } else {
    summary = `${provider} hooks run a project-local CLI across ${inspection.eventsCovered.length} event(s).`;
  }

  return {
    id: hookDiagnosticId(provider),
    title: `${provider} hook configuration`,
    status,
    summary,
    facts: facts({
      provider,
      scope: "project-local",
      config_paths_checked: [...options.target.configPaths],
      config_files_present: [...inspection.configFilesPresent],
      config_files_unreadable: [...inspection.configFilesUnreadable],
      command_count: inspection.commandCount,
      barbaro_command_count: inspection.barbaroCommandCount,
      events_covered: [...inspection.eventsCovered],
      events_missing: [...inspection.eventsMissing],
      subcommands_covered: [...inspection.subcommandsCovered],
      subcommands_missing: [...inspection.subcommandsMissing],
      cli_targets: [...inspection.cliTargets],
      cli_targets_unresolved: [...inspection.cliTargetsUnresolved],
      cli_targets_outside_project: inspection.cliTargetsOutsideProject.map(
        (path) => toPosixRelative(projectRoot, path),
      ),
      interpreters_unresolved: [...inspection.interpretersUnresolved],
    }),
    remediation,
  };
}
