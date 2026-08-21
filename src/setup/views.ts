import { join, resolve } from "node:path";

import type { JsonValue } from "../core/stable-json.js";

import {
  ageSeconds,
  inspectPath,
  scanDirectory,
  type ScanLimits,
} from "./fs-facts.js";
import {
  facts,
  worstStatus,
  type Diagnostic,
  type DiagnosticStatus,
  type FreshnessThresholds,
} from "./types.js";

/**
 * Presence and freshness of the materialized coordination views.
 *
 * This module deliberately imports no file-reading primitive: it only counts
 * entries and reads metadata, so canonical feed, evidence, and lease bytes can
 * never reach a report or a terminal through it. Peers read canonical records
 * through their own bounded projection, never through the doctor.
 */

export const VIEWS_DIAGNOSTIC_ID = "views.coordination-state";

export type CoordinationView = "active" | "evidence" | "feed" | "state";

/** `state` holds resume checkpoints and is optional for a fresh checkout. */
const REQUIRED_VIEWS: readonly CoordinationView[] = ["active", "feed"];
const OPTIONAL_VIEWS: readonly CoordinationView[] = ["evidence", "state"];

export const DEFAULT_FRESHNESS: Required<FreshnessThresholds> = {
  // Matches the active-lease TTL: a lease older than this is already expired.
  activeMaxAgeMs: 5 * 60 * 1_000,
  feedMaxAgeMs: 60 * 60 * 1_000,
  evidenceMaxAgeMs: 60 * 60 * 1_000,
  stateMaxAgeMs: 60 * 60 * 1_000,
};

function thresholdFor(
  view: CoordinationView,
  thresholds: Required<FreshnessThresholds>,
): number {
  switch (view) {
    case "active":
      return thresholds.activeMaxAgeMs;
    case "feed":
      return thresholds.feedMaxAgeMs;
    case "evidence":
      return thresholds.evidenceMaxAgeMs;
    case "state":
      return thresholds.stateMaxAgeMs;
  }
}

export interface ViewSummary {
  readonly view: CoordinationView;
  readonly required: boolean;
  readonly present: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly providers: readonly string[];
  readonly newestAgeSeconds: number | undefined;
  readonly fresh: boolean | undefined;
  readonly scanTruncated: boolean;
}

export interface ViewsInspection {
  readonly rootPresent: boolean;
  readonly summaries: readonly ViewSummary[];
}

export interface ViewsOptions {
  readonly projectRoot: string;
  readonly nowMs: number;
  readonly storeRelativePath?: string;
  readonly freshness?: FreshnessThresholds;
  readonly limits?: ScanLimits;
}

export async function inspectCoordinationViews(
  options: ViewsOptions,
): Promise<ViewsInspection> {
  const projectRoot = resolve(options.projectRoot);
  const storeRelativePath = options.storeRelativePath ?? ".barbaro";
  const storePath = join(projectRoot, ...storeRelativePath.split("/"));
  const thresholds: Required<FreshnessThresholds> = {
    ...DEFAULT_FRESHNESS,
    ...options.freshness,
  };

  const rootFacts = await inspectPath(storePath);
  const summaries: ViewSummary[] = [];
  for (const view of [...REQUIRED_VIEWS, ...OPTIONAL_VIEWS].sort()) {
    const scan = await scanDirectory(join(storePath, view), options.limits);
    if (scan === undefined) {
      summaries.push({
        view,
        required: (REQUIRED_VIEWS as readonly string[]).includes(view),
        present: false,
        fileCount: 0,
        totalBytes: 0,
        providers: [],
        newestAgeSeconds: undefined,
        fresh: undefined,
        scanTruncated: false,
      });
      continue;
    }
    const age =
      scan.newestMtimeMs === undefined
        ? undefined
        : ageSeconds(options.nowMs, scan.newestMtimeMs);
    summaries.push({
      view,
      required: (REQUIRED_VIEWS as readonly string[]).includes(view),
      present: true,
      fileCount: scan.fileCount,
      totalBytes: scan.totalBytes,
      providers: scan.topLevelEntries,
      newestAgeSeconds: age,
      fresh:
        age === undefined
          ? undefined
          : age * 1000 <= thresholdFor(view, thresholds),
      scanTruncated: scan.truncated,
    });
  }

  return { rootPresent: rootFacts.kind === "directory", summaries };
}

function summaryStatus(summary: ViewSummary): DiagnosticStatus {
  if (!summary.present) return summary.required ? "fail" : "warn";
  if (summary.fileCount === 0) return "warn";
  return summary.fresh === false ? "warn" : "pass";
}

export async function checkCoordinationViews(
  options: ViewsOptions,
): Promise<Diagnostic> {
  const inspection = await inspectCoordinationViews(options);
  const storeRelativePath = options.storeRelativePath ?? ".barbaro";
  const remediation: string[] = [];

  let status: DiagnosticStatus;
  let summary: string;
  if (!inspection.rootPresent) {
    status = "fail";
    summary = `${storeRelativePath}/ does not exist; no session has published coordination state.`;
    remediation.push(
      "Start one session with hooks enabled, invoke `/barbaro` in Claude Code or `$barbaro` in Codex, then re-run the doctor; Barbaro creates the store itself.",
    );
  } else {
    status = worstStatus(inspection.summaries.map(summaryStatus));
    const stale = inspection.summaries
      .filter((view) => view.present && view.fresh === false)
      .map((view) => view.view);
    const missing = inspection.summaries
      .filter((view) => !view.present)
      .map((view) => view.view);
    const empty = inspection.summaries
      .filter((view) => view.present && view.fileCount === 0)
      .map((view) => view.view);

    if (missing.length > 0 || empty.length > 0 || stale.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
      if (empty.length > 0) parts.push(`empty: ${empty.join(", ")}`);
      if (stale.length > 0) parts.push(`stale: ${stale.join(", ")}`);
      summary = `Coordination views need attention (${parts.join("; ")}).`;
      if (missing.length > 0 || empty.length > 0) {
        remediation.push(
          "Confirm a session explicitly joined and its hooks are publishing: an unpopulated view means either consent or hook execution is missing.",
        );
      }
      if (stale.length > 0) {
        remediation.push(
          "Treat stale views as no peer context at all rather than as current peer state.",
        );
      }
    } else {
      summary = "Active, feed, evidence, and state views are present and fresh.";
    }
  }

  if (inspection.summaries.some((view) => view.scanTruncated)) {
    remediation.push(
      "View scan hit its entry limit; counts are lower bounds for this run.",
    );
  }

  return {
    id: VIEWS_DIAGNOSTIC_ID,
    title: "Coordination views are present and fresh",
    status,
    summary,
    facts: facts({
      store_path: storeRelativePath,
      store_present: inspection.rootPresent,
      canonical_content_read: false,
      views: inspection.summaries.map(
        (view): JsonValue => ({
          view: view.view,
          required: view.required,
          present: view.present,
          file_count: view.fileCount,
          total_bytes: view.totalBytes,
          providers: [...view.providers],
          newest_age_seconds: view.newestAgeSeconds ?? null,
          fresh: view.fresh ?? null,
          scan_truncated: view.scanTruncated,
        }),
      ),
    }),
    remediation,
  };
}
