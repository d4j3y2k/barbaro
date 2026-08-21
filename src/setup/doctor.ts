import { resolve } from "node:path";

import { compareUtf16CodeUnits } from "../core/stable-json.js";

import { checkBuildFreshness } from "./build.js";
import type { ScanLimits } from "./fs-facts.js";
import { buildSetupGuidance } from "./guidance.js";
import { checkGitignore } from "./gitignore.js";
import {
  checkHookConfig,
  DEFAULT_HOOK_TARGETS,
  type HookProvider,
  type HookProviderTarget,
} from "./hooks.js";
import { checkWorkspaceIsolation } from "./isolation.js";
import {
  countStatuses,
  worstStatus,
  SETUP_DOCTOR_SCHEMA,
  type Diagnostic,
  type SetupDoctorOptions,
  type SetupDoctorReport,
} from "./types.js";
import { checkCoordinationViews } from "./views.js";

/**
 * The project-local dogfood doctor.
 *
 * Every check is read-only and deterministic: given the same filesystem, the
 * same clock, and the same environment, two runs produce byte-identical
 * `stableStringify` output. Nothing is installed, edited, or repaired, and no
 * user or global settings file is read or written.
 */

export interface RunSetupDoctorOptions extends SetupDoctorOptions {
  readonly hookTargets?: readonly HookProviderTarget[];
}

export async function runSetupDoctor(
  options: RunSetupDoctorOptions = {},
): Promise<SetupDoctorReport> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("now must be a valid date");
  }
  const env = options.env ?? process.env;
  const hookTargets = options.hookTargets ?? DEFAULT_HOOK_TARGETS;
  const limits: ScanLimits = {
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  };

  const diagnostics: Diagnostic[] = [
    await checkBuildFreshness({ projectRoot, nowMs, limits }),
    await checkGitignore({ projectRoot }),
  ];
  for (const target of hookTargets) {
    diagnostics.push(await checkHookConfig({ projectRoot, target, env, nowMs }));
  }
  diagnostics.push(
    await checkCoordinationViews({
      projectRoot,
      nowMs,
      limits,
      ...(options.freshness === undefined
        ? {}
        : { freshness: options.freshness }),
    }),
    await checkWorkspaceIsolation({ projectRoot }),
  );

  diagnostics.sort((left, right) => compareUtf16CodeUnits(left.id, right.id));

  const providers: HookProvider[] = hookTargets.map(
    (target) => target.provider,
  );

  return {
    schema: SETUP_DOCTOR_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    project_root: projectRoot,
    status: worstStatus(diagnostics.map((diagnostic) => diagnostic.status)),
    counts: countStatuses(diagnostics),
    diagnostics,
    guidance: buildSetupGuidance(diagnostics, providers),
  };
}

/**
 * Compact human-readable rendering for a later CLI wrapper. The structured
 * report stays the source of truth; this is only a projection of it.
 */
export function formatSetupDoctorReport(report: SetupDoctorReport): string {
  const lines: string[] = [
    `barbaro setup doctor: ${report.status.toUpperCase()}`,
    `  project: ${report.project_root}`,
    `  checked: ${report.generated_at}`,
    "",
  ];
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `  [${diagnostic.status.padEnd(4)}] ${diagnostic.id}: ${diagnostic.summary}`,
    );
    for (const step of diagnostic.remediation) {
      lines.push(`           - ${step}`);
    }
  }
  if (report.guidance.launch.length > 0) {
    lines.push("", "  launch:");
    for (const step of report.guidance.launch) {
      lines.push(`    - ${step.text}`);
    }
  }
  lines.push("", "  peer-context preflight:");
  for (const step of report.guidance.peer_context_preflight) {
    lines.push(`    - ${step.text}`);
  }
  return `${lines.join("\n")}\n`;
}
