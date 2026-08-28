import { classifyAwaitCommand } from "../core/barbaro-command.js";
import { truncateReaderUtf8, utf8Bytes } from "./budget.js";

export type ReaderDependencyKind =
  | "peer_unread"
  | "permission"
  | "human_input"
  | "tool"
  | "external"
  | "unknown";

export type ReaderAttentionAudience =
  | "user"
  | "peer"
  | "system"
  | "external"
  | "unknown";

export type ReaderLeaseState = "working" | "waiting" | "blocked" | "idle";

/**
 * The narrow structural input needed to enrich a lease. Both canonical active
 * leases and their reader projection satisfy this interface.
 */
export interface ReaderDependencyLeaseInput {
  readonly state: ReaderLeaseState;
  readonly workstream_id?: string;
  readonly current_action?: {
    readonly kind: "file_change" | "command" | "test" | "tool" | "other";
    readonly command?: { readonly text: string };
    readonly started_at?: string;
  };
}

export interface ReaderWorkstreamDependencyTarget {
  readonly type: "workstream";
  /** Always the validated full typed ID, never a display abbreviation. */
  readonly workstream_id: string;
}

export interface ReaderDependencyProvenance {
  readonly source: "reader";
  readonly method: "classified_barbaro_await";
}

export interface ReaderDependencyMetadata {
  readonly kind: ReaderDependencyKind;
  readonly audience: ReaderAttentionAudience;
  readonly target: ReaderWorkstreamDependencyTarget;
  readonly started_at?: string;
  readonly deadline_at?: string;
  readonly provenance: ReaderDependencyProvenance;
}

/**
 * State is unconditional; dependency is optional enrichment. Consumers must
 * therefore keep WAIT/BLOCK visible when a target cannot be proven.
 */
export interface ReaderDependencyLeaseSummary {
  readonly state: ReaderLeaseState;
  readonly dependency?: ReaderDependencyMetadata;
}

export interface ReaderBoundedAudienceSource {
  readonly text: string;
  readonly truncated: boolean;
  readonly utf8_bytes: {
    readonly shown: number;
    readonly original: number;
  };
}

export interface ReaderNormalizedAttentionAudience {
  readonly audience: ReaderAttentionAudience;
  /** Retained only when an unrecognized string supplied the source value. */
  readonly unknown_source?: ReaderBoundedAudienceSource;
}

export interface ReaderSessionIdentity {
  readonly provider: string;
  readonly session_id: string;
}

export type ReaderViewerIdentity = ReaderSessionIdentity;

export const READER_UNKNOWN_AUDIENCE_SOURCE_BYTES = 128;

const MAX_READER_DEPENDENCY_TIMESTAMP_BYTES = 64;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/u;

const AWAIT_PROVENANCE: ReaderDependencyProvenance = {
  source: "reader",
  method: "classified_barbaro_await",
};

/**
 * Preserve every written lease state and derive optional E-03 metadata only
 * from the existing conservative leading-command classifier. A malformed or
 * unscoped record gets no invented target or dependency.
 */
export function projectReaderDependencyLease(
  lease: ReaderDependencyLeaseInput,
): ReaderDependencyLeaseSummary {
  const dependency = deriveReaderDependency(lease);
  return {
    state: lease.state,
    ...(dependency === undefined ? {} : { dependency }),
  };
}

export function deriveReaderDependency(
  lease: ReaderDependencyLeaseInput,
): ReaderDependencyMetadata | undefined {
  if (lease.state !== "waiting" && lease.state !== "blocked") return undefined;
  if (!isFullWorkstreamId(lease.workstream_id)) return undefined;
  const action = lease.current_action;
  if (action?.kind !== "command" || action.command === undefined) {
    return undefined;
  }

  const classified = classifyAwaitCommand(action.command.text);
  if (classified === undefined) return undefined;

  const startedAt = validRfc3339(action.started_at);
  const deadlineAt =
    startedAt === undefined
      ? undefined
      : addMilliseconds(startedAt, classified.timeoutMs);
  return {
    kind: "peer_unread",
    audience: "peer",
    target: {
      type: "workstream",
      workstream_id: lease.workstream_id,
    },
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(deadlineAt === undefined ? {} : { deadline_at: deadlineAt }),
    provenance: AWAIT_PROVENANCE,
  };
}

/**
 * Canonical values pass through exactly. Other string values remain visible
 * as bounded source evidence; missing/non-string source data stays unknown
 * without serializing arbitrary untrusted structures.
 */
export function normalizeReaderAttentionAudience(
  source: unknown,
): ReaderNormalizedAttentionAudience {
  if (isReaderAttentionAudience(source)) return { audience: source };
  if (typeof source !== "string") return { audience: "unknown" };

  const originalBytes = utf8Bytes(source);
  const text = truncateReaderUtf8(
    source,
    READER_UNKNOWN_AUDIENCE_SOURCE_BYTES,
  );
  const shownBytes = utf8Bytes(text);
  return {
    audience: "unknown",
    unknown_source: {
      text,
      truncated: shownBytes < originalBytes,
      utf8_bytes: {
        shown: shownBytes,
        original: originalBytes,
      },
    },
  };
}

/**
 * Accept only a complete, closed, exact provider/full-session identity. An
 * invalid or partial value is absence, never an inferred current viewer.
 */
export function normalizeExplicitViewerIdentity(
  source: unknown,
): ReaderViewerIdentity | undefined {
  if (!isRecord(source)) return undefined;
  if (
    Object.keys(source).length !== 2 ||
    !Object.hasOwn(source, "provider") ||
    !Object.hasOwn(source, "session_id") ||
    typeof source.provider !== "string" ||
    typeof source.session_id !== "string" ||
    !PROVIDER_PATTERN.test(source.provider) ||
    !SESSION_ID_PATTERN.test(source.session_id)
  ) {
    return undefined;
  }
  return {
    provider: source.provider,
    session_id: source.session_id,
  };
}

/** Undefined means that no explicit viewer fact exists. */
export function readerViewerMatches(
  viewer: ReaderViewerIdentity | undefined,
  recipient: ReaderSessionIdentity,
): boolean | undefined {
  if (viewer === undefined) return undefined;
  return (
    viewer.provider === recipient.provider &&
    viewer.session_id === recipient.session_id
  );
}

function isReaderAttentionAudience(
  value: unknown,
): value is ReaderAttentionAudience {
  return (
    value === "user" ||
    value === "peer" ||
    value === "system" ||
    value === "external" ||
    value === "unknown"
  );
}

function isFullWorkstreamId(value: unknown): value is string {
  return typeof value === "string" && WORKSTREAM_ID_PATTERN.test(value);
}

function validRfc3339(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    utf8Bytes(value) > MAX_READER_DEPENDENCY_TIMESTAMP_BYTES
  ) {
    return undefined;
  }
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maximumDay = month >= 1 && month <= 12 ? monthDays[month - 1] : 0;
  if (
    day < 1 ||
    maximumDay === undefined ||
    day > maximumDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? value : undefined;
}

function addMilliseconds(value: string, delta: number): string | undefined {
  const millis = Date.parse(value);
  const result = millis + delta;
  if (!Number.isFinite(result)) return undefined;
  try {
    return new Date(result).toISOString();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
