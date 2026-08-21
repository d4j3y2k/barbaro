import type { JsonValue } from "../core/stable-json.js";

/** Record identity for the structured doctor report. */
export const SETUP_DOCTOR_SCHEMA = "barbaro.setup.doctor.v1";

/**
 * Three statuses only, so a later CLI wrapper can render them without
 * interpreting severity. `warn` means dogfooding still works but a parallel
 * launch is riskier; `fail` means coordination is broken until it is fixed.
 */
export type DiagnosticStatus = "pass" | "warn" | "fail";

const STATUS_SEVERITY: Readonly<Record<DiagnosticStatus, number>> = {
  pass: 0,
  warn: 1,
  fail: 2,
};

export const DIAGNOSTIC_STATUSES: readonly DiagnosticStatus[] = [
  "pass",
  "warn",
  "fail",
];

/** A single named fact. Values stay JSON-stable for `stableStringify`. */
export interface DiagnosticFact {
  readonly key: string;
  readonly value: JsonValue;
}

/**
 * One diagnostic. `facts` is machine-readable and `remediation` is the manual
 * fix; the library never applies remediation itself.
 */
export interface Diagnostic {
  readonly id: string;
  readonly title: string;
  readonly status: DiagnosticStatus;
  readonly summary: string;
  readonly facts: readonly DiagnosticFact[];
  readonly remediation: readonly string[];
}

export interface GuidanceStep {
  readonly id: string;
  readonly text: string;
}

/** Bounds enforced by the supported peer-context projection. */
export interface PeerContextLimits {
  readonly render_budget_bytes: number;
  readonly feed_records_per_session: number;
  readonly compact_lease_fields: readonly string[];
}

export interface SetupGuidance {
  readonly launch: readonly GuidanceStep[];
  readonly peer_context_preflight: readonly GuidanceStep[];
  readonly peer_context_limits: PeerContextLimits;
  /** Supported reader that automates the bounded preflight. */
  readonly peer_context_automated_by: string;
}

export interface SetupDoctorReport {
  readonly schema: typeof SETUP_DOCTOR_SCHEMA;
  readonly generated_at: string;
  readonly project_root: string;
  readonly status: DiagnosticStatus;
  readonly counts: Readonly<Record<DiagnosticStatus, number>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly guidance: SetupGuidance;
}

/** Ages beyond which a materialized view is reported as stale, not broken. */
export interface FreshnessThresholds {
  readonly activeMaxAgeMs?: number;
  readonly feedMaxAgeMs?: number;
  readonly evidenceMaxAgeMs?: number;
  readonly stateMaxAgeMs?: number;
}

export interface SetupDoctorOptions {
  readonly projectRoot?: string;
  readonly now?: Date;
  /** Environment used for PATH lookups only; never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly freshness?: FreshnessThresholds;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

export function statusSeverity(status: DiagnosticStatus): number {
  return STATUS_SEVERITY[status];
}

/** Worst status wins; an empty input is a pass. */
export function worstStatus(
  statuses: Iterable<DiagnosticStatus>,
): DiagnosticStatus {
  let worst: DiagnosticStatus = "pass";
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) {
      worst = status;
    }
  }
  return worst;
}

export function countStatuses(
  diagnostics: readonly Diagnostic[],
): Readonly<Record<DiagnosticStatus, number>> {
  const counts: Record<DiagnosticStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
  };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.status] += 1;
  }
  return counts;
}

/** Facts are emitted key-sorted so two runs of the same state are identical. */
export function facts(
  entries: Readonly<Record<string, JsonValue | undefined>>,
): DiagnosticFact[] {
  const collected: DiagnosticFact[] = [];
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    if (value === undefined) continue;
    collected.push({ key, value });
  }
  return collected;
}
