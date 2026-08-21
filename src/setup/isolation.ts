import { join, resolve } from "node:path";

import { inspectPath } from "./fs-facts.js";
import { facts, type Diagnostic, type DiagnosticStatus } from "./types.js";

/**
 * Whether the workspace offers any isolation between parallel actors.
 *
 * Without a Git repository there are no branches and no worktrees, so two
 * agents editing the same checkout share one mutable filesystem. The only
 * remaining safeguard is disjoint path ownership declared up front and
 * rechecked against live leases immediately before each edit.
 */

export const ISOLATION_DIAGNOSTIC_ID = "workspace.isolation";

export type GitKind = "none" | "directory" | "worktree-file" | "other";

export interface IsolationInspection {
  readonly gitKind: GitKind;
  readonly isolationAvailable: boolean;
  readonly requiresDisjointOwnership: boolean;
}

export interface IsolationOptions {
  readonly projectRoot: string;
}

export async function inspectWorkspaceIsolation(
  options: IsolationOptions,
): Promise<IsolationInspection> {
  const gitPath = join(resolve(options.projectRoot), ".git");
  const gitFacts = await inspectPath(gitPath);
  const gitKind: GitKind =
    gitFacts.kind === "missing"
      ? "none"
      : gitFacts.kind === "directory"
        ? "directory"
        : // A `.git` file points at a linked worktree or submodule.
          gitFacts.kind === "file"
          ? "worktree-file"
          : "other";
  const isolationAvailable =
    gitKind === "directory" || gitKind === "worktree-file";
  return {
    gitKind,
    isolationAvailable,
    requiresDisjointOwnership: true,
  };
}

export async function checkWorkspaceIsolation(
  options: IsolationOptions,
): Promise<Diagnostic> {
  const inspection = await inspectWorkspaceIsolation(options);
  const remediation: string[] = [];
  let status: DiagnosticStatus;
  let summary: string;

  if (!inspection.isolationAvailable) {
    status = "warn";
    summary =
      "No Git repository: branch and worktree isolation are unavailable, so parallel actors share one mutable checkout.";
    remediation.push(
      "Give every concurrent actor a disjoint, explicitly stated file scope before it edits anything.",
    );
    remediation.push(
      "Re-list non-expired leases in .barbaro/active/ immediately before each edit; a lease is advisory, not a lock.",
    );
    remediation.push(
      "Keep generated coordination state read-only: never edit .barbaro/.",
    );
  } else {
    status = "pass";
    summary =
      inspection.gitKind === "worktree-file"
        ? "Linked Git worktree: this actor already edits an isolated checkout."
        : "Git repository present: separate worktrees can isolate parallel actors.";
    remediation.push(
      "Still declare disjoint ownership when actors share one worktree; leases are advisory, not locks.",
    );
  }

  return {
    id: ISOLATION_DIAGNOSTIC_ID,
    title: "Workspace isolation for parallel actors",
    status,
    summary,
    facts: facts({
      git_kind: inspection.gitKind,
      isolation_available: inspection.isolationAvailable,
      requires_disjoint_ownership: inspection.requiresDisjointOwnership,
      lease_semantics: "advisory",
    }),
    remediation,
  };
}
