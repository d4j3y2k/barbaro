import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { BarbaroTurnV1 } from "../contracts/v1.js";
import { stableStringify } from "../core/stable-json.js";
import { selectTurnText } from "../reader/record-page.js";
import type { NudgeDeliveryTurnV2 } from "./types.js";

export const READ_OUTPUT_CEILING_BYTES = 8192;
export const READ_INVOCATION_TTL_MS = 5 * 60_000;
export const MAX_PENDING_READS = 32;
export const MAX_READ_COVERAGE_RECORDS = 1024;
export const MAX_READ_COVERAGE_RANGES = 256;

export class ReadCoverageCapacityError extends RangeError {}

export interface NudgePendingRead {
  readonly nonce: string;
  readonly tool_use_id: string;
  readonly turn: NudgeDeliveryTurnV2;
  readonly project_root: string;
  readonly command: string;
  readonly query_sha256: string;
  readonly tool_input_sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
  /** Terminal hook output awaiting independent model-facing success evidence. */
  readonly output?: string;
}

export interface NudgeReadRange {
  readonly start: number;
  readonly end: number;
}

export interface NudgeReadCoverage {
  readonly provider: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly record_sha256: string;
  readonly field: "record" | "request" | "response";
  readonly field_sha256: string;
  readonly total_bytes: number;
  readonly ranges: readonly NudgeReadRange[];
}

export interface NudgeReadState {
  readonly pending: readonly NudgePendingRead[];
  readonly coverage: readonly NudgeReadCoverage[];
  /** A delivered context reported history outside its selected window. */
  readonly outside_window: boolean;
  /** Successful coverage delivered to this turn suppresses an immediate Stop. */
  readonly informed_turn?: NudgeDeliveryTurnV2;
}

export function emptyNudgeReadState(): NudgeReadState {
  return { pending: [], coverage: [], outside_window: false };
}

export function readContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readRecordHash(turn: BarbaroTurnV1): string {
  return readContentHash(stableStringify(turn));
}

/** Sparse coverage never suppresses a changed record or an unfinished field. */
export function isReadRecordAcknowledged(
  state: NudgeReadState,
  turn: BarbaroTurnV1,
): boolean {
  const candidates = state.coverage.filter((entry) => (
    entry.provider === turn.provider && entry.session_id === turn.session_id &&
    entry.turn_id === turn.turn_id && isReadCoverageComplete(entry) &&
    (entry.field === "record" || entry.field === (turn.response === undefined ? "request" : "response"))
  ));
  if (candidates.length === 0) return false;
  const recordHash = readRecordHash(turn);
  return candidates.some((entry) => {
    if (entry.record_sha256 !== recordHash) return false;
    const selected = selectTurnText(turn, entry.field);
    return selected.present && entry.total_bytes === Buffer.byteLength(selected.text) &&
      entry.field_sha256 === readContentHash(selected.text);
  });
}

export function isReadCoverageComplete(entry: NudgeReadCoverage): boolean {
  return entry.ranges.length === 1 && entry.ranges[0]!.start === 0 &&
    entry.ranges[0]!.end === entry.total_bytes;
}

/** Merge delivered byte intervals; no missing interval can be bridged. */
export function mergeReadRanges(ranges: readonly NudgeReadRange[]): NudgeReadRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: NudgeReadRange[] = [];
  for (const range of sorted) {
    if (!integer(range.start) || !integer(range.end) || range.end < range.start) {
      throw new TypeError("invalid delivered byte range");
    }
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  if (merged.length > MAX_READ_COVERAGE_RANGES) {
    throw new ReadCoverageCapacityError("too many incomplete delivered byte ranges");
  }
  return merged;
}

/**
 * Merge already-attested pages without joining different record versions.
 * Replay returns the original state; saturation refuses the whole update.
 * This function cannot attest a delivery and never writes cursor state.
 */
export function mergeReadCoverage(
  state: NudgeReadState,
  delivered: readonly NudgeReadCoverage[],
): NudgeReadState {
  return mergeCoverage(state, delivered, MAX_READ_COVERAGE_RECORDS);
}

/** Bounded transient merge; callers must collapse prefixes and enforce the stored limit before writing. */
export function mergeReadCoverageForScan(state: NudgeReadState, delivered: readonly NudgeReadCoverage[]): NudgeReadState {
  if (delivered.length > MAX_READ_COVERAGE_RECORDS) throw new ReadCoverageCapacityError("too many delivered records");
  return mergeCoverage(state, delivered, MAX_READ_COVERAGE_RECORDS + delivered.length);
}

function mergeCoverage(state: NudgeReadState, delivered: readonly NudgeReadCoverage[], maximumRecords: number): NudgeReadState {
  const entries = new Map(state.coverage.map((entry) => [coverageKey(entry), entry]));
  let changed = false;
  for (const raw of delivered) {
    const entry = parseCoverage(raw);
    const key = coverageKey(entry);
    const prior = entries.get(key);
    const sameVersion = prior !== undefined &&
      prior.record_sha256 === entry.record_sha256 &&
      prior.field_sha256 === entry.field_sha256 &&
      prior.total_bytes === entry.total_bytes;
    const next = sameVersion
      ? { ...entry, ranges: mergeReadRanges([...prior.ranges, ...entry.ranges]) }
      : entry;
    if (prior !== undefined && stableStringify(prior) === stableStringify(next)) continue;
    entries.set(key, next);
    changed = true;
    if (entries.size > maximumRecords) {
      throw new ReadCoverageCapacityError("too many delivered records with unread gaps");
    }
  }
  return changed ? { ...state, coverage: [...entries.values()] } : state;
}

function coverageKey(entry: NudgeReadCoverage): string {
  return `${entry.provider}/${entry.session_id}/${entry.turn_id}/${entry.field}`;
}

/** Shared strict decoder for the hook writer and read-only cursor projections. */
export function parseNudgeReadState(
  value: unknown,
  provider: string,
  claudeGeneration: number | undefined,
): NudgeReadState {
  if (!object(value)) throw new TypeError("invalid nudge read state");
  keys(value, ["pending", "coverage", "outside_window", "informed_turn"]);
  if (!Array.isArray(value.pending) || value.pending.length > MAX_PENDING_READS ||
      !Array.isArray(value.coverage) || value.coverage.length > MAX_READ_COVERAGE_RECORDS ||
      typeof value.outside_window !== "boolean") {
    throw new TypeError("invalid nudge read state bounds");
  }
  const pending = value.pending.map((item) => parsePending(item, provider, claudeGeneration));
  unique(pending.map((item) => item.nonce));
  unique(pending.map((item) => item.tool_use_id));
  const coverage = value.coverage.map(parseCoverage);
  unique(coverage.map(coverageKey));
  return {
    pending, coverage, outside_window: value.outside_window,
    ...(value.informed_turn === undefined ? {} : {
      informed_turn: parseReadTurn(value.informed_turn, provider, claudeGeneration),
    }),
  };
}

function parsePending(value: unknown, provider: string, generation: number | undefined): NudgePendingRead {
  if (!object(value)) throw new TypeError("invalid pending read");
  keys(value, ["nonce", "tool_use_id", "turn", "project_root", "command", "query_sha256", "tool_input_sha256", "created_at", "expires_at", "output"]);
  if (!matches(value.nonce, /^[0-9a-f]{32}$/u) || !bounded(value.tool_use_id, 512) ||
      !bounded(value.project_root, 4096) || !isAbsolute(value.project_root) ||
      !bounded(value.command, 8192) || !hash(value.query_sha256) || !hash(value.tool_input_sha256) ||
      !timestamp(value.created_at) || !timestamp(value.expires_at) ||
      Date.parse(value.expires_at) <= Date.parse(value.created_at) ||
      Date.parse(value.expires_at) - Date.parse(value.created_at) > READ_INVOCATION_TTL_MS ||
      (value.output !== undefined && !bounded(value.output, READ_OUTPUT_CEILING_BYTES))) {
    throw new TypeError("invalid pending read binding");
  }
  const turn = parseReadTurn(value.turn, provider, generation);
  return {
    nonce: value.nonce, tool_use_id: value.tool_use_id, turn,
    project_root: value.project_root, command: value.command,
    query_sha256: value.query_sha256,
    tool_input_sha256: value.tool_input_sha256,
    created_at: value.created_at, expires_at: value.expires_at,
    ...(value.output === undefined ? {} : { output: value.output as string }),
  };
}

function parseReadTurn(value: unknown, provider: string, generation: number | undefined): NudgeDeliveryTurnV2 {
  if (!object(value)) throw new TypeError("invalid read delivery turn");
  if (provider === "codex") {
    keys(value, ["kind", "turn_id"]);
    if (value.kind !== provider || !matches(value.turn_id, /^turn_[0-9a-f]{32}$/u)) {
      throw new TypeError("pending read belongs to another provider turn");
    }
    return { kind: "codex", turn_id: value.turn_id };
  } else {
    keys(value, ["kind", "generation"]);
    if (provider !== "claude" || value.kind !== provider ||
        !integer(value.generation) || value.generation < 1 ||
        generation === undefined || value.generation > generation) {
      throw new TypeError("pending read has an invalid Claude generation");
    }
    return { kind: "claude", generation: value.generation };
  }
}

function parseCoverage(value: unknown): NudgeReadCoverage {
  if (!object(value)) throw new TypeError("invalid delivered record coverage");
  keys(value, ["provider", "session_id", "turn_id", "record_sha256", "field", "field_sha256", "total_bytes", "ranges"]);
  if (!matches(value.provider, /^[a-z][a-z0-9_-]*$/u) ||
      !matches(value.session_id, /^ses_[0-9a-f]{32}$/u) ||
      !matches(value.turn_id, /^turn_[0-9a-f]{32}$/u) ||
      !hash(value.record_sha256) || !hash(value.field_sha256) ||
      (value.field !== "record" && value.field !== "request" && value.field !== "response") ||
      !integer(value.total_bytes) || !Array.isArray(value.ranges) ||
      value.ranges.length === 0 || value.ranges.length > MAX_READ_COVERAGE_RANGES) {
    throw new TypeError("invalid delivered record coverage binding");
  }
  const ranges: NudgeReadRange[] = [];
  for (const range of value.ranges) {
    if (!object(range)) throw new TypeError("invalid delivered range");
    keys(range, ["start", "end"]);
    if (!integer(range.start) || !integer(range.end) || range.end < range.start ||
        range.end > value.total_bytes ||
        (range.start === range.end && value.total_bytes !== 0) ||
        (ranges.length > 0 && ranges.at(-1)!.end >= range.start)) {
      throw new TypeError("delivered ranges must be disjoint, normalized and in bounds");
    }
    ranges.push({ start: range.start, end: range.end });
  }
  return {
    provider: value.provider, session_id: value.session_id, turn_id: value.turn_id,
    record_sha256: value.record_sha256, field: value.field,
    field_sha256: value.field_sha256, total_bytes: value.total_bytes, ranges,
  };
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new TypeError("duplicate nudge read identity");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError("unknown nudge read field");
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function hash(value: unknown): value is string {
  return matches(value, /^[0-9a-f]{64}$/u);
}
function timestamp(value: unknown): value is string {
  return bounded(value, 64) && Number.isFinite(Date.parse(value));
}
