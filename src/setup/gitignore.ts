import { join, resolve } from "node:path";

import { readTextFile } from "./fs-facts.js";
import { facts, type Diagnostic, type DiagnosticStatus } from "./types.js";

/**
 * `.barbaro/` holds request and response excerpts copied from live sessions.
 * Committing it publishes those excerpts, so the doctor treats a missing
 * ignore entry as a failure rather than a style note. The file is only read.
 */

export const GITIGNORE_DIAGNOSTIC_ID = "gitignore.barbaro-ignored";

export const MAX_GITIGNORE_BYTES = 256 * 1024;

/** Literal forms that ignore the whole `.barbaro/` tree from the repo root. */
const IGNORE_FORMS: readonly string[] = [
  ".barbaro/",
  ".barbaro",
  "/.barbaro/",
  "/.barbaro",
];

export interface GitignoreInspection {
  readonly present: boolean;
  readonly readable: boolean;
  readonly matchedPattern: string | undefined;
  readonly negated: boolean;
  readonly lineCount: number;
}

export interface GitignoreOptions {
  readonly projectRoot: string;
  readonly relativePath?: string;
}

export async function inspectGitignore(
  options: GitignoreOptions,
): Promise<GitignoreInspection> {
  const relativePath = options.relativePath ?? ".gitignore";
  const path = join(resolve(options.projectRoot), ...relativePath.split("/"));
  const read = await readTextFile(path, MAX_GITIGNORE_BYTES);
  if (read.kind === "missing") {
    return {
      present: false,
      readable: false,
      matchedPattern: undefined,
      negated: false,
      lineCount: 0,
    };
  }
  if (read.kind !== "ok") {
    return {
      present: true,
      readable: false,
      matchedPattern: undefined,
      negated: false,
      lineCount: 0,
    };
  }

  const lines = read.text.split("\n");
  let matchedPattern: string | undefined;
  let negated = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negation = line.startsWith("!");
    const pattern = negation ? line.slice(1) : line;
    if (!IGNORE_FORMS.includes(pattern)) continue;
    if (negation) {
      // A later re-inclusion wins in Git, so any negation invalidates the match.
      negated = true;
      continue;
    }
    matchedPattern ??= pattern;
  }

  return {
    present: true,
    readable: true,
    matchedPattern,
    negated,
    lineCount: lines.length,
  };
}

export async function checkGitignore(
  options: GitignoreOptions,
): Promise<Diagnostic> {
  const inspection = await inspectGitignore(options);
  const relativePath = options.relativePath ?? ".gitignore";
  const remediation: string[] = [];
  let status: DiagnosticStatus = "pass";
  let summary: string;

  if (!inspection.present) {
    status = "fail";
    summary = `No ${relativePath}; derived session excerpts are not ignored.`;
    remediation.push(
      `Create ${relativePath} with the single entry \`.barbaro/\` before enabling hooks.`,
    );
  } else if (!inspection.readable) {
    status = "fail";
    summary = `${relativePath} could not be read as text.`;
    remediation.push(`Inspect ${relativePath} by hand and add \`.barbaro/\`.`);
  } else if (inspection.negated) {
    status = "fail";
    summary = `${relativePath} re-includes .barbaro/ with a negation.`;
    remediation.push(
      `Remove the \`!.barbaro\` negation from ${relativePath}; it un-ignores derived excerpts.`,
    );
  } else if (inspection.matchedPattern === undefined) {
    status = "fail";
    summary = `${relativePath} does not ignore .barbaro/.`;
    remediation.push(
      `Add \`.barbaro/\` to ${relativePath}; Barbaro never edits it for you.`,
    );
  } else {
    summary = `${relativePath} ignores .barbaro/ via \`${inspection.matchedPattern}\`.`;
  }

  return {
    id: GITIGNORE_DIAGNOSTIC_ID,
    title: "Coordination state is ignored by Git",
    status,
    summary,
    facts: facts({
      gitignore_path: relativePath,
      gitignore_present: inspection.present,
      gitignore_readable: inspection.readable,
      ignore_line_count: inspection.lineCount,
      matched_pattern: inspection.matchedPattern ?? null,
      negation_present: inspection.negated,
      global_excludes_inspected: false,
    }),
    remediation,
  };
}
