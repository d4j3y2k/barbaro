import { join, resolve } from "node:path";

import { compareUtf16CodeUnits } from "../core/stable-json.js";

import {
  ageSeconds,
  inspectPath,
  walkFiles,
  type ScanLimits,
} from "./fs-facts.js";
import { facts, type Diagnostic, type DiagnosticStatus } from "./types.js";

/**
 * Hooks execute the compiled CLI, not the TypeScript sources, so a stale
 * `dist/` silently publishes yesterday's coordination behavior. This check
 * compares source mtimes against their expected emitted outputs.
 */

export const BUILD_DIAGNOSTIC_ID = "build.dist-freshness";

/** How many individual paths a fact may name before it is summarized. */
export const MAX_REPORTED_PATHS = 10;

export interface BuildFreshnessOptions {
  readonly projectRoot: string;
  readonly nowMs: number;
  readonly sourceDirectory?: string;
  readonly outputDirectory?: string;
  readonly cliRelativePath?: string;
  /** Inputs that invalidate the whole build when they change. */
  readonly buildInputs?: readonly string[];
  readonly limits?: ScanLimits;
}

export interface BuildFreshness {
  readonly distPresent: boolean;
  readonly cliPresent: boolean;
  readonly cliPath: string;
  readonly cliMtimeMs: number | undefined;
  readonly sourceFileCount: number;
  readonly missingOutputs: readonly string[];
  readonly staleOutputs: readonly string[];
  readonly newerBuildInputs: readonly string[];
  readonly newestSourceMtimeMs: number | undefined;
  readonly scanTruncated: boolean;
}

function bounded(paths: readonly string[]): readonly string[] {
  return paths.slice(0, MAX_REPORTED_PATHS);
}

/** Collects the raw comparison without deciding severity. */
export async function inspectBuildFreshness(
  options: BuildFreshnessOptions,
): Promise<BuildFreshness> {
  const projectRoot = resolve(options.projectRoot);
  const sourceDirectory = options.sourceDirectory ?? "src";
  const outputDirectory = options.outputDirectory ?? "dist";
  const cliRelativePath = options.cliRelativePath ?? "dist/src/cli.js";
  const buildInputs = options.buildInputs ?? ["tsconfig.json", "package.json"];

  const distFacts = await inspectPath(join(projectRoot, outputDirectory));
  const cliPath = join(projectRoot, ...cliRelativePath.split("/"));
  const cliFacts = await inspectPath(cliPath);

  const walkOptions: Parameters<typeof walkFiles>[1] = {
    include: (relativePath) =>
      relativePath.endsWith(".ts") && !relativePath.endsWith(".d.ts"),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  const sources = await walkFiles(
    join(projectRoot, sourceDirectory),
    walkOptions,
  );

  const missingOutputs: string[] = [];
  const staleOutputs: string[] = [];
  let newestSourceMtimeMs: number | undefined;

  for (const source of sources?.files ?? []) {
    if (
      newestSourceMtimeMs === undefined ||
      source.mtimeMs > newestSourceMtimeMs
    ) {
      newestSourceMtimeMs = source.mtimeMs;
    }
    const outputRelative = `${outputDirectory}/${sourceDirectory}/${source.relativePath.slice(0, -3)}.js`;
    const outputFacts = await inspectPath(
      join(projectRoot, ...outputRelative.split("/")),
    );
    if (outputFacts.kind !== "file") {
      missingOutputs.push(`${sourceDirectory}/${source.relativePath}`);
      continue;
    }
    if ((outputFacts.mtimeMs ?? 0) < source.mtimeMs) {
      staleOutputs.push(`${sourceDirectory}/${source.relativePath}`);
    }
  }

  const newerBuildInputs: string[] = [];
  for (const input of buildInputs) {
    const inputFacts = await inspectPath(join(projectRoot, ...input.split("/")));
    if (inputFacts.kind !== "file" || inputFacts.mtimeMs === undefined) continue;
    if (
      cliFacts.mtimeMs !== undefined &&
      inputFacts.mtimeMs > cliFacts.mtimeMs
    ) {
      newerBuildInputs.push(input);
    }
  }

  missingOutputs.sort(compareUtf16CodeUnits);
  staleOutputs.sort(compareUtf16CodeUnits);
  newerBuildInputs.sort(compareUtf16CodeUnits);

  return {
    distPresent: distFacts.kind === "directory",
    cliPresent: cliFacts.kind === "file",
    cliPath,
    cliMtimeMs: cliFacts.mtimeMs,
    sourceFileCount: sources?.files.length ?? 0,
    missingOutputs,
    staleOutputs,
    newerBuildInputs,
    newestSourceMtimeMs,
    scanTruncated: sources?.truncated ?? false,
  };
}

export async function checkBuildFreshness(
  options: BuildFreshnessOptions,
): Promise<Diagnostic> {
  const freshness = await inspectBuildFreshness(options);
  const remediation: string[] = [];

  let status: DiagnosticStatus = "pass";
  let summary: string;
  if (!freshness.distPresent || !freshness.cliPresent) {
    status = "fail";
    summary = freshness.distPresent
      ? "Compiled CLI is missing; hooks have nothing to execute."
      : "No compiled output; hooks have nothing to execute.";
    remediation.push("Run `npm run build` before launching any actor.");
  } else if (freshness.missingOutputs.length > 0) {
    status = "fail";
    summary = `${freshness.missingOutputs.length} source file(s) have no compiled output.`;
    remediation.push("Run `npm run build` to emit the missing outputs.");
  } else if (
    freshness.staleOutputs.length > 0 ||
    freshness.newerBuildInputs.length > 0
  ) {
    status = "warn";
    summary =
      freshness.staleOutputs.length > 0
        ? `${freshness.staleOutputs.length} compiled file(s) are older than their source.`
        : "Build configuration changed after the last compile.";
    remediation.push(
      "Run `npm run build`; hooks execute dist/, so unbuilt edits never reach a peer.",
    );
  } else if (freshness.sourceFileCount === 0) {
    status = "warn";
    summary = "No TypeScript sources were found to compare against dist/.";
    remediation.push(
      "Confirm --project-root points at the Barbaro checkout you are dogfooding.",
    );
  } else {
    summary = `Compiled output is current for ${freshness.sourceFileCount} source file(s).`;
  }

  if (freshness.scanTruncated) {
    remediation.push(
      "Source scan hit its entry limit; raise maxEntries for a complete comparison.",
    );
  }

  return {
    id: BUILD_DIAGNOSTIC_ID,
    title: "Compiled CLI freshness",
    status,
    summary,
    facts: facts({
      cli_path: freshness.cliPath,
      cli_present: freshness.cliPresent,
      dist_present: freshness.distPresent,
      cli_age_seconds:
        freshness.cliMtimeMs === undefined
          ? undefined
          : ageSeconds(options.nowMs, freshness.cliMtimeMs),
      source_file_count: freshness.sourceFileCount,
      missing_output_count: freshness.missingOutputs.length,
      missing_outputs: bounded(freshness.missingOutputs) as string[],
      stale_output_count: freshness.staleOutputs.length,
      stale_outputs: bounded(freshness.staleOutputs) as string[],
      build_inputs_newer_than_cli: freshness.newerBuildInputs as string[],
      scan_truncated: freshness.scanTruncated,
    }),
    remediation,
  };
}
