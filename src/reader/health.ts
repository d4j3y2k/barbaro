import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  ACTIVE_ACTOR_FILENAME_PATTERN,
  activeActorFilename,
  parseActiveLeaseJson,
} from "../active/index.js";
import { validateJsonlCheckpoint } from "../core/checkpoint.js";
import {
  SafeStoreBoundary,
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import { compareUtf16CodeUnits } from "../core/stable-json.js";
import {
  PARTICIPATING_PROVIDERS,
  SESSION_PARTICIPATION_SCHEMA,
  SESSION_PARTICIPATION_SCHEMA_V2,
} from "../hooks/participation.js";
import {
  MAX_INGEST_ATTEMPT_BYTES,
} from "../hooks/ingest-attempt.js";
import { NudgeCursorStateStore } from "../nudge/store.js";
import { createSessionId, createTurnId } from "../core/id.js";
import {
  CodexTurnNormalizer,
  type CodexNormalizerStateV1,
} from "../providers/codex/normalizer.js";
import { parseWorkstream } from "../workstreams/store.js";
import { parseReaderIngestJournal } from "./ingest-journal.js";
import { isTurnV1 } from "./store.js";
import { projectStoreHealth, readerCollection } from "./projection.js";
import { truncateReaderUtf8 } from "./budget.js";
import type {
  ReaderCoverage,
  ReaderDiagnostics,
  ReaderProjection,
  ReaderProviderDriftDiagnostic,
  ReaderReadState,
  ReaderStoreHealth,
  ReaderStoreHealthOptions,
} from "./types.js";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_ENTRIES = 4096;
const DEFAULT_TURNS_PER_SESSION = 5;
const MAX_WORKSTREAM_BYTES = 16 * 1024;
const MAX_PARTICIPATION_BYTES = 16 * 1024;
const MAX_ACTIVE_LEASE_BYTES = 1024 * 1024;
const MAX_CURSOR_BYTES = 1024 * 1024;
const MAX_PROVIDER_STATE_BYTES = 64 * 1024 * 1024;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const WORKSTREAM_FILE_PATTERN = /^(ws_[0-9a-f]{32})\.json$/u;
const SESSION_JSON_PATTERN = /^(ses_[0-9a-f]{32})\.json$/u;
const SESSION_JSONL_PATTERN = /^(ses_[0-9a-f]{32})\.jsonl$/u;
const CODEX_STATE_FILE_PATTERN = /^[0-9a-f]{32}\.json$/u;

interface HealthLimits {
  readonly turnsPerSession: number;
  readonly maxFileBytes: number;
  readonly maxRecordBytes: number;
  readonly maxScanBytes: number;
  readonly maxSourceEntries: number;
}

interface HealthFile {
  readonly components: readonly string[];
  readonly filename: string;
  readonly provider?: string;
  readonly sessionId?: string;
}

interface HealthFileList {
  readonly files: readonly HealthFile[];
  readonly total: number;
  readonly limited: boolean;
}

interface MutableHealth {
  feedFiles: number;
  malformedFeedRecords: number;
  invalidFeedRecords: number;
  partialFeedFiles: number;
  scanLimitedFeedFiles: number;
  invalidActiveRecords: number;
  invalidWorkstreamRecords: number;
  invalidParticipationRecords: number;
  invalidCursorRecords: number;
  invalidJournalRecords: number;
  invalidProviderStateRecords: number;
  drift: ReaderProviderDriftDiagnostic[];
  limited: boolean;
  limitedReason?: string;
}

/**
 * Read-only E-01 observer.  It never creates or repairs the store and turns
 * unsafe/oversized/unreadable input into an explicit refused health result.
 */
export async function readProjectStoreHealth(
  projectRoot: string,
  options: ReaderStoreHealthOptions,
): Promise<ReaderProjection<ReaderStoreHealth>> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  const limits = healthLimits(options);
  const absoluteRoot = resolve(projectRoot);
  const boundary = SafeStoreBoundary.forBarbaroProject(absoluteRoot);
  const mutable = emptyMutableHealth();

  let storeDirectory: string | undefined;
  try {
    storeDirectory = await boundary.verifyDirectory();
  } catch (error: unknown) {
    return projectStoreHealth(
      buildHealth("present", mutable, "refused", {
        state: "refused",
        reason: refusalReason(error),
      }),
      options,
    );
  }
  if (storeDirectory === undefined) {
    return projectStoreHealth(
      buildHealth("absent", mutable, "ok", { state: "complete" }),
      options,
    );
  }

  try {
    await scanWorkstreams(boundary, mutable, limits);
    await scanParticipation(boundary, mutable, limits);
    await scanActive(boundary, mutable, limits);
    await scanFeeds(boundary, mutable, limits);
    await scanCursors(absoluteRoot, boundary, mutable, limits);
    await scanJournals(boundary, mutable, limits);
    await scanClaudeState(absoluteRoot, boundary, mutable, limits);
    await scanCodexState(absoluteRoot, boundary, mutable, limits);
  } catch (error: unknown) {
    return projectStoreHealth(
      buildHealth("present", mutable, "refused", {
        state: "refused",
        reason: refusalReason(error),
      }),
      options,
    );
  }

  const coverage: ReaderCoverage = mutable.limited
    ? { state: "limited", reason: mutable.limitedReason ?? "source_limit" }
    : { state: "complete" };
  const degraded = mutable.limited || diagnosticCount(mutable) > 0;
  return projectStoreHealth(
    buildHealth(
      "present",
      mutable,
      degraded ? "degraded" : "ok",
      coverage,
    ),
    options,
  );
}

async function scanWorkstreams(
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listFlatFiles(
    boundary,
    ["workstreams"],
    WORKSTREAM_FILE_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "workstream_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_WORKSTREAM_BYTES),
    );
    const match = WORKSTREAM_FILE_PATTERN.exec(file.filename);
    try {
      parseWorkstream(decodeUtf8(bytes), match?.[1]);
    } catch {
      health.invalidWorkstreamRecords += 1;
    }
  }
}

async function scanParticipation(
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listProviderFiles(
    boundary,
    ["sessions"],
    SESSION_JSON_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "participation_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_PARTICIPATION_BYTES),
    );
    try {
      parseParticipationForHealth(
        decodeUtf8(bytes),
        file.provider!,
        file.sessionId!,
      );
    } catch (error: unknown) {
      health.invalidParticipationRecords += 1;
      if (isIdentityMismatch(error)) {
        addIdentityDrift(health, "participation", file);
      }
    }
  }
}

async function scanActive(
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listProviderFiles(
    boundary,
    ["active"],
    ACTIVE_ACTOR_FILENAME_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "active_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_ACTIVE_LEASE_BYTES),
    );
    try {
      const lease = parseActiveLeaseJson(decodeUtf8(bytes));
      if (
        lease.provider !== file.provider ||
        activeActorFilename(lease) !== file.filename
      ) {
        throw new Error("active identity does not match its storage path");
      }
    } catch (error: unknown) {
      health.invalidActiveRecords += 1;
      if (isIdentityMismatch(error)) addIdentityDrift(health, "active", file);
    }
  }
}

async function scanFeeds(
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listProviderFiles(
    boundary,
    ["feed"],
    SESSION_JSONL_PATTERN,
    limits.maxSourceEntries,
  );
  health.feedFiles = listed.total;
  noteLimit(health, listed, "feed_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      limits.maxFileBytes,
    );
    const partial = bytes.byteLength > 0 && bytes.at(-1) !== 0x0a;
    if (partial) health.partialFeedFiles += 1;
    const start = Math.max(0, bytes.byteLength - limits.maxScanBytes);
    if (start > 0) {
      health.scanLimitedFeedFiles += 1;
      markLimited(health, "feed_scan_limit");
    }
    const lines = completeSuffixLines(
      bytes.subarray(start),
      start > 0,
      partial,
    );
    let accepted = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (line.byteLength > limits.maxRecordBytes) {
        throw new StoreFileTooLargeError(
          boundary.pathFor(file.components),
          limits.maxRecordBytes,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(decodeUtf8(line));
      } catch {
        health.malformedFeedRecords += 1;
        continue;
      }
      if (!isTurnV1(value)) {
        health.invalidFeedRecords += 1;
        continue;
      }
      if (
        value.provider !== file.provider ||
        value.session_id !== file.sessionId
      ) {
        health.invalidFeedRecords += 1;
        addIdentityDrift(health, "feed", file);
        continue;
      }
      accepted += 1;
      if (accepted === limits.turnsPerSession) break;
    }
  }
}

async function scanCursors(
  projectRoot: string,
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listProviderFiles(
    boundary,
    ["state", "nudge"],
    SESSION_JSON_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "cursor_entry_limit");
  const store = new NudgeCursorStateStore(projectRoot);
  for (const file of listed.files) {
    await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_CURSOR_BYTES),
    );
    try {
      const cursor = await store.read(file.provider!, file.sessionId!);
      if (cursor === undefined) {
        throw new RangeError("Barbaro health cursor disappeared while being read");
      }
    } catch (error: unknown) {
      health.invalidCursorRecords += 1;
      if (isIdentityMismatch(error)) addIdentityDrift(health, "cursor", file);
    }
  }
}

async function scanJournals(
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listProviderFiles(
    boundary,
    ["logs", "ingest"],
    SESSION_JSON_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "journal_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_INGEST_ATTEMPT_BYTES),
    );
    try {
      const value = JSON.parse(decodeUtf8(bytes)) as unknown;
      parseReaderIngestJournal(value, file.provider!, file.sessionId!);
    } catch (error: unknown) {
      health.invalidJournalRecords += 1;
      if (isIdentityMismatch(error)) addIdentityDrift(health, "journal", file);
    }
  }
}

async function scanCodexState(
  projectRoot: string,
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listFlatFiles(
    boundary,
    ["state", "codex"],
    CODEX_STATE_FILE_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "provider_state_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_PROVIDER_STATE_BYTES),
    );
    try {
      const value = JSON.parse(decodeUtf8(bytes)) as unknown;
      const diagnostics = parseCodexStateForHealth(value, projectRoot);
      appendCodexDrift(health, diagnostics);
    } catch (error: unknown) {
      health.invalidProviderStateRecords += 1;
      if (isIdentityMismatch(error)) {
        health.drift.push({
          source: "codex_state",
          kind: "identity_path_mismatch",
          provider: "codex",
          count: 1,
        });
      }
    }
  }
}

async function scanClaudeState(
  projectRoot: string,
  boundary: SafeStoreBoundary,
  health: MutableHealth,
  limits: HealthLimits,
): Promise<void> {
  const listed = await listFlatFiles(
    boundary,
    ["state", "claude"],
    CODEX_STATE_FILE_PATTERN,
    limits.maxSourceEntries,
  );
  noteLimit(health, listed, "provider_state_entry_limit");
  for (const file of listed.files) {
    const bytes = await readHealthFile(
      boundary,
      file.components,
      Math.min(limits.maxFileBytes, MAX_PROVIDER_STATE_BYTES),
    );
    try {
      const value = JSON.parse(decodeUtf8(bytes)) as unknown;
      parseClaudeStateForHealth(value, projectRoot);
    } catch (error: unknown) {
      health.invalidProviderStateRecords += 1;
      if (isIdentityMismatch(error)) {
        health.drift.push({
          source: "claude_state",
          kind: "identity_path_mismatch",
          provider: "claude",
          count: 1,
        });
      }
    }
  }
}

function buildHealth(
  presence: "absent" | "present",
  mutable: MutableHealth,
  readState: ReaderReadState,
  coverage: ReaderCoverage,
): ReaderStoreHealth {
  const drift = aggregateDrift(mutable.drift);
  const base: ReaderDiagnostics = {
    feed_files: mutable.feedFiles,
    malformed_feed_records: mutable.malformedFeedRecords,
    invalid_feed_records: mutable.invalidFeedRecords,
    partial_feed_files: mutable.partialFeedFiles,
    scan_limited_feed_files: mutable.scanLimitedFeedFiles,
    invalid_active_records: mutable.invalidActiveRecords,
  };
  const providerDrift = readerCollection(drift, readState, coverage);
  const diagnostics = {
    ...base,
    invalid_workstream_records: mutable.invalidWorkstreamRecords,
    invalid_participation_records: mutable.invalidParticipationRecords,
    invalid_cursor_records: mutable.invalidCursorRecords,
    invalid_journal_records: mutable.invalidJournalRecords,
    invalid_provider_state_records: mutable.invalidProviderStateRecords,
    provider_drift: providerDrift,
  };
  const issueCount = Object.entries(diagnostics)
    .filter(([key]) => key !== "feed_files" && key !== "provider_drift")
    .reduce((sum, [, value]) => sum + Number(value), 0) +
    drift.reduce((sum, item) => sum + item.count, 0);
  return {
    presence,
    read_state: readState,
    healthy:
      presence === "present" &&
      readState === "ok" &&
      coverage.state === "complete" &&
      issueCount === 0,
    coverage,
    diagnostics,
  };
}

function emptyMutableHealth(): MutableHealth {
  return {
    feedFiles: 0,
    malformedFeedRecords: 0,
    invalidFeedRecords: 0,
    partialFeedFiles: 0,
    scanLimitedFeedFiles: 0,
    invalidActiveRecords: 0,
    invalidWorkstreamRecords: 0,
    invalidParticipationRecords: 0,
    invalidCursorRecords: 0,
    invalidJournalRecords: 0,
    invalidProviderStateRecords: 0,
    drift: [],
    limited: false,
  };
}

function diagnosticCount(health: MutableHealth): number {
  return (
    health.malformedFeedRecords +
    health.invalidFeedRecords +
    health.partialFeedFiles +
    health.scanLimitedFeedFiles +
    health.invalidActiveRecords +
    health.invalidWorkstreamRecords +
    health.invalidParticipationRecords +
    health.invalidCursorRecords +
    health.invalidJournalRecords +
    health.invalidProviderStateRecords +
    health.drift.reduce((sum, item) => sum + item.count, 0)
  );
}

function healthLimits(options: ReaderStoreHealthOptions): HealthLimits {
  return {
    turnsPerSession: positiveInteger(
      options.turnsPerSession ?? DEFAULT_TURNS_PER_SESSION,
      "turnsPerSession",
    ),
    maxFileBytes: positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    ),
    maxRecordBytes: positiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      "maxRecordBytes",
    ),
    maxScanBytes: positiveInteger(
      options.maxScanBytesPerFile ?? DEFAULT_MAX_SCAN_BYTES,
      "maxScanBytesPerFile",
    ),
    maxSourceEntries: positiveInteger(
      options.maxSourceEntries ?? DEFAULT_MAX_SOURCE_ENTRIES,
      "maxSourceEntries",
    ),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

async function listProviderFiles(
  boundary: SafeStoreBoundary,
  root: readonly string[],
  filenamePattern: RegExp,
  maximumEntries: number,
): Promise<HealthFileList> {
  const directory = await boundary.verifyDirectory(root);
  if (directory === undefined) return { files: [], total: 0, limited: false };
  const providers = await readdir(directory, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: HealthFile[] = [];
  let total = 0;
  for (const providerEntry of providers) {
    if (!PROVIDER_PATTERN.test(providerEntry.name)) continue;
    const providerComponents = [...root, providerEntry.name];
    if (providerEntry.isSymbolicLink() || !providerEntry.isDirectory()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(providerComponents),
        "provider component is not a real directory",
      );
    }
    const providerDirectory = await boundary.verifyDirectory(providerComponents);
    if (providerDirectory === undefined) continue;
    const entries = await readdir(providerDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const match = filenamePattern.exec(entry.name);
      if (match === null) continue;
      const components = [...providerComponents, entry.name];
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(
          boundary.pathFor(components),
          "canonical health path is not a real file",
        );
      }
      total += 1;
      if (files.length < maximumEntries) {
        files.push({
          components,
          filename: entry.name,
          provider: providerEntry.name,
          ...(match[1] === undefined ? {} : { sessionId: match[1] }),
        });
      }
    }
  }
  return { files, total, limited: total > files.length };
}

async function listFlatFiles(
  boundary: SafeStoreBoundary,
  root: readonly string[],
  filenamePattern: RegExp,
  maximumEntries: number,
): Promise<HealthFileList> {
  const directory = await boundary.verifyDirectory(root);
  if (directory === undefined) return { files: [], total: 0, limited: false };
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: HealthFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!filenamePattern.test(entry.name)) continue;
    const components = [...root, entry.name];
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(components),
        "canonical health path is not a real file",
      );
    }
    total += 1;
    if (files.length < maximumEntries) {
      files.push({ components, filename: entry.name });
    }
  }
  return { files, total, limited: total > files.length };
}

async function readHealthFile(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  maximumBytes: number,
): Promise<Buffer> {
  const parent = await boundary.verifyDirectory(components.slice(0, -1));
  if (parent === undefined) {
    throw new RangeError("Barbaro health source parent disappeared");
  }
  const path = boundary.pathFor(components);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new RangeError("Barbaro health source disappeared while being read");
    }
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeStorePathError(path, "final file is a symbolic link");
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UnsafeStorePathError(path, "opened object is not a regular file");
    }
    if (stats.nlink !== 1) {
      throw new UnsafeStorePathError(path, "final file has multiple hard links");
    }
    if (stats.size > maximumBytes) {
      throw new StoreFileTooLargeError(path, maximumBytes);
    }
    const bytes = Buffer.allocUnsafe(stats.size);
    await readExactly(handle, bytes);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) {
      throw new RangeError("Barbaro health source changed while being read");
    }
    offset += result.bytesRead;
  }
}

function parseParticipationForHealth(
  text: string,
  expectedProvider: string,
  expectedSessionId: string,
): void {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) throw new TypeError("participation must be an object");
  if (
    typeof value.provider !== "string" ||
    typeof value.session_id !== "string"
  ) {
    throw new TypeError("participation is structurally invalid");
  }
  if (
    value.provider !== expectedProvider ||
    value.session_id !== expectedSessionId
  ) {
    throw new TypeError("participation identity does not match its storage path");
  }
  if (
    !PARTICIPATING_PROVIDERS.includes(expectedProvider as "claude" | "codex") ||
    !SESSION_ID_PATTERN.test(expectedSessionId) ||
    typeof value.joined_at !== "string" ||
    !Number.isFinite(Date.parse(value.joined_at)) ||
    value.initiated_by !== "user_prompt"
  ) {
    throw new TypeError("participation is structurally invalid");
  }
  if (value.schema === SESSION_PARTICIPATION_SCHEMA) {
    if (value.workstream_id !== undefined || value.memberships !== undefined) {
      throw new TypeError("participation v1 cannot name workstream memberships");
    }
    return;
  }
  if (
    value.schema !== SESSION_PARTICIPATION_SCHEMA_V2 ||
    typeof value.workstream_id !== "string" ||
    !WORKSTREAM_ID_PATTERN.test(value.workstream_id)
  ) {
    throw new TypeError("participation is structurally invalid");
  }
  if (value.memberships === undefined) return;
  if (!Array.isArray(value.memberships) || value.memberships.length === 0) {
    throw new TypeError("participation memberships are invalid");
  }
  let prior = Number.NEGATIVE_INFINITY;
  let latestWorkstream: string | undefined;
  for (const membership of value.memberships) {
    if (
      !isObject(membership) ||
      typeof membership.workstream_id !== "string" ||
      !WORKSTREAM_ID_PATTERN.test(membership.workstream_id) ||
      typeof membership.from !== "string"
    ) {
      throw new TypeError("participation membership is invalid");
    }
    const from = Date.parse(membership.from);
    if (!Number.isFinite(from) || from <= prior) {
      throw new TypeError("participation membership times are invalid");
    }
    prior = from;
    latestWorkstream = membership.workstream_id;
  }
  if (latestWorkstream !== value.workstream_id) {
    throw new TypeError("participation current workstream is invalid");
  }
}

interface CodexDiagnosticsForHealth {
  readonly invalid_envelopes: number;
  readonly unknown_root_types: Readonly<Record<string, number>>;
  readonly unknown_event_types: Readonly<Record<string, number>>;
  readonly unknown_response_types: Readonly<Record<string, number>>;
  readonly repeated_session_meta: number;
  readonly orphan_turn_records: number;
}

function parseClaudeStateForHealth(value: unknown, projectRoot: string): void {
  if (
    !isObject(value) ||
    value.schema !== "barbaro.claude-runner-state.v1" ||
    !isNonEmptyString(value.trace_id) ||
    !isNonEmptyString(value.native_session_id) ||
    value.actor_id !== "main" ||
    !isObject(value.checkpoint)
  ) {
    throw new TypeError("Claude runner state is structurally invalid");
  }
  validateJsonlCheckpoint(value.checkpoint as never);
  if (
    value.trace_id !== `claude:${value.native_session_id}:main` ||
    (value.workspace_root !== undefined &&
      (!isNonEmptyString(value.workspace_root) ||
        !isAbsolute(value.workspace_root) ||
        resolve(value.workspace_root) !== projectRoot))
  ) {
    throw new TypeError("Claude state identity does not match derived identity");
  }
}

function parseCodexStateForHealth(
  value: unknown,
  projectRoot: string,
): CodexDiagnosticsForHealth {
  if (
    !isObject(value) ||
    value.schema !== "barbaro.codex-runner-state.v1" ||
    typeof value.trace_id !== "string" ||
    value.trace_id.length === 0 ||
    !isObject(value.checkpoint) ||
    !isObject(value.normalizer)
  ) {
    throw new TypeError("Codex runner state is structurally invalid");
  }
  validateJsonlCheckpoint(value.checkpoint as never);
  const normalizer = value.normalizer;
  if (
    normalizer.schema !== "barbaro.codex-normalizer-state.v1" ||
    !Number.isSafeInteger(normalizer.next_sequence) ||
    Number(normalizer.next_sequence) < 1 ||
    !Array.isArray(normalizer.turns) ||
    !isObject(normalizer.diagnostics)
  ) {
    throw new TypeError("Codex normalizer state is structurally invalid");
  }
  CodexTurnNormalizer.restore(
    normalizer as unknown as CodexNormalizerStateV1,
  );
  if (normalizer.session !== undefined) {
    if (!isObject(normalizer.session)) {
      throw new TypeError("Codex state session is structurally invalid");
    }
    validateCodexSession(normalizer.session, value.trace_id, projectRoot);
    validateCodexTurns(
      normalizer.turns,
      normalizer.session,
      Number(normalizer.next_sequence),
      normalizer.current_turn_id,
      value.trace_id,
    );
  } else if (
    normalizer.turns.length > 0 ||
    normalizer.current_turn_id !== undefined
  ) {
    throw new TypeError("Codex state turns require a session");
  }
  const diagnostics = normalizer.diagnostics;
  for (const key of [
    "records",
    "invalid_envelopes",
    "repeated_session_meta",
    "orphan_turn_records",
  ]) {
    if (!isSafeNonNegativeInteger(diagnostics[key])) {
      throw new TypeError("Codex diagnostics are structurally invalid");
    }
  }
  const root = positiveCountMap(diagnostics.unknown_root_types);
  const event = positiveCountMap(diagnostics.unknown_event_types);
  const response = positiveCountMap(diagnostics.unknown_response_types);
  return {
    invalid_envelopes: Number(diagnostics.invalid_envelopes),
    unknown_root_types: root,
    unknown_event_types: event,
    unknown_response_types: response,
    repeated_session_meta: Number(diagnostics.repeated_session_meta),
    orphan_turn_records: Number(diagnostics.orphan_turn_records),
  };
}

function validateCodexSession(
  value: unknown,
  traceId: string,
  projectRoot: string,
): void {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.nativeSessionId) ||
    !isNonEmptyString(value.nativeThreadId) ||
    !isNonEmptyString(value.barbaroSessionId) ||
    !isNonEmptyString(value.actorId) ||
    !isNonEmptyString(value.historyMode) ||
    !["legacy", "paginated"].includes(value.historyMode)
  ) {
    throw new TypeError("Codex state session is structurally invalid");
  }
  if (
    value.barbaroSessionId !== createSessionId("codex", value.nativeSessionId) ||
    traceId !== `codex:${value.nativeSessionId}:thread:${value.nativeThreadId}` ||
    (value.workspaceRoot !== undefined &&
      (!isNonEmptyString(value.workspaceRoot) ||
        !isAbsolute(value.workspaceRoot) ||
        resolve(value.workspaceRoot) !== projectRoot))
  ) {
    throw new TypeError("Codex state identity does not match derived identity");
  }
}

function validateCodexTurns(
  turns: readonly unknown[],
  session: Record<string, unknown>,
  nextSequence: number,
  currentTurnId: unknown,
  expectedTraceId: string,
): void {
  const nativeTurnIds = new Set<string>();
  const sequences = new Set<number>();
  let priorSequence = 0;
  for (const turn of turns) {
    if (
      !isObject(turn) ||
      !isNonEmptyString(turn.nativeTurnId) ||
      !isNonEmptyString(turn.barbaroTurnId) ||
      !Number.isSafeInteger(turn.sequence) ||
      Number(turn.sequence) < 1 ||
      Number(turn.sequence) >= nextSequence ||
      Number(turn.sequence) <= priorSequence ||
      turn.agentId !== session.actorId ||
      !isTimestamp(turn.startedAt) ||
      !isCodexStateSource(turn.startSource, expectedTraceId) ||
      !isOptionalString(turn.request) ||
      !isOptionalString(turn.requestNativeId) ||
      !isOptionalString(turn.response) ||
      !isOptionalString(turn.responseNativeId) ||
      !isOptionalString(turn.responsePhase) ||
      !Array.isArray(turn.actions) ||
      !turn.actions.every((action) =>
        isCodexStateAction(action, expectedTraceId),
      ) ||
      !isPatternArray(turn.evidenceIds, EVIDENCE_ID_PATTERN) ||
      !Array.isArray(turn.pendingCalls) ||
      !turn.pendingCalls.every((call) =>
        isCodexPendingCall(call, expectedTraceId),
      ) ||
      !hasUniqueObjectStringKey(turn.pendingCalls, "callId") ||
      !isCodexPendingUsage(turn.latestUsage, expectedTraceId) ||
      !Array.isArray(turn.subagents) ||
      !turn.subagents.every((subagent) =>
        isCodexStateSubagent(subagent, expectedTraceId),
      ) ||
      !hasUniqueObjectStringKey(turn.subagents, "agentId")
    ) {
      throw new TypeError("Codex state turn is structurally invalid");
    }
    const nativeTurnId = turn.nativeTurnId;
    const sequence = Number(turn.sequence);
    if (nativeTurnIds.has(nativeTurnId) || sequences.has(sequence)) {
      throw new TypeError("Codex state turns must be unique");
    }
    nativeTurnIds.add(nativeTurnId);
    sequences.add(sequence);
    priorSequence = sequence;
    if (
      turn.barbaroTurnId !==
      createTurnId(
        "codex",
        String(session.nativeSessionId),
        String(turn.agentId),
        String(turn.nativeTurnId),
      )
    ) {
      throw new TypeError("Codex state turn identity does not match derived identity");
    }
  }
  if (
    currentTurnId !== undefined &&
    (!isNonEmptyString(currentTurnId) || !nativeTurnIds.has(currentTurnId))
  ) {
    throw new TypeError("Codex normalizer current turn is missing from state");
  }
}

function isCodexStateSource(
  value: unknown,
  expectedTraceId: string,
): boolean {
  if (
    !isObject(value) ||
    value.traceId !== expectedTraceId ||
    !Number.isSafeInteger(value.lineNumber) ||
    Number(value.lineNumber) < 1 ||
    !isOptionalString(value.tracePath) ||
    !isOptionalNonNegativeInteger(value.byteStart) ||
    !isOptionalNonNegativeInteger(value.byteEndExclusive)
  ) {
    return false;
  }
  return (
    value.byteStart === undefined ||
    value.byteEndExclusive === undefined ||
    Number(value.byteEndExclusive) >= Number(value.byteStart)
  );
}

function isCodexStateAction(
  value: unknown,
  expectedTraceId: string,
): boolean {
  if (!isObject(value)) return false;
  if (
    !isOptionalSafeInteger(value.exit_code) ||
    !isOptionalNonNegativeInteger(value.passed) ||
    !isOptionalNonNegativeInteger(value.failed) ||
    !isOptionalNonNegativeInteger(value.added_lines) ||
    !isOptionalNonNegativeInteger(value.removed_lines) ||
    !Array.isArray(value.source_refs) ||
    !value.source_refs.every(
      (source) => isObject(source) && source.trace_id === expectedTraceId,
    )
  ) {
    return false;
  }
  return isTurnV1({
    schema: "barbaro.turn.v1",
    turn_id: `turn_${"0".repeat(32)}`,
    provider: "codex",
    session_id: `ses_${"0".repeat(32)}`,
    sequence: 1,
    agent_id: "health-validation",
    started_at: "1970-01-01T00:00:00.000Z",
    ended_at: "1970-01-01T00:00:00.000Z",
    outcome: "unknown",
    request: {
      text: "",
      fidelity: "verbatim",
      truncated: false,
      redactions: [],
    },
    actions: [value],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [{ trace_id: "health-validation" }],
  });
}

function isCodexPendingCall(
  value: unknown,
  expectedTraceId: string,
): boolean {
  return (
    isObject(value) &&
    isNonEmptyString(value.callId) &&
    isOptionalString(value.nativeId) &&
    (value.rootType === "function_call" ||
      value.rootType === "custom_tool_call") &&
    isNonEmptyString(value.name) &&
    isOptionalString(value.namespace) &&
    isOptionalString(value.input) &&
    isOptionalString(value.argumentsJson) &&
    isCodexStateSource(value.source, expectedTraceId) &&
    isOptionalNonNegativeInteger(value.projectedItems)
  );
}

function isCodexPendingUsage(
  value: unknown,
  expectedTraceId: string,
): boolean {
  return (
    value === undefined ||
    (isObject(value) &&
      isObject(value.payload) &&
      isCodexStateSource(value.source, expectedTraceId) &&
      isTimestamp(value.occurredAt))
  );
}

function isCodexStateSubagent(
  value: unknown,
  expectedTraceId: string,
): boolean {
  return (
    isObject(value) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.role) &&
    isTurnOutcome(value.outcome) &&
    isPatternArray(value.evidenceIds, EVIDENCE_ID_PATTERN) &&
    isOptionalString(value.lastActivity) &&
    isOptionalNonNegativeInteger(value.activityCount) &&
    (value.source === undefined ||
      isCodexStateSource(value.source, expectedTraceId)) &&
    (value.occurredAt === undefined || isTimestamp(value.occurredAt))
  );
}

function hasUniqueObjectStringKey(
  values: readonly unknown[],
  key: string,
): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (!isObject(value) || typeof value[key] !== "string") return false;
    const candidate = value[key];
    if (seen.has(candidate)) return false;
    seen.add(candidate);
  }
  return true;
}

function positiveCountMap(value: unknown): Readonly<Record<string, number>> {
  if (!isObject(value)) {
    throw new TypeError("Codex diagnostic map is structurally invalid");
  }
  const entries = Object.entries(value);
  for (const [key, count] of entries) {
    if (key.length === 0 || !Number.isSafeInteger(count) || Number(count) < 1) {
      throw new TypeError("Codex diagnostic map is structurally invalid");
    }
  }
  entries.sort((left, right) => compareUtf16CodeUnits(left[0], right[0]));
  return Object.fromEntries(entries) as Readonly<Record<string, number>>;
}

function appendCodexDrift(
  health: MutableHealth,
  diagnostics: CodexDiagnosticsForHealth,
): void {
  addDriftCount(health, "invalid_envelope", diagnostics.invalid_envelopes);
  addDriftMap(health, "unknown_root_type", diagnostics.unknown_root_types);
  addDriftMap(health, "unknown_event_type", diagnostics.unknown_event_types);
  addDriftMap(health, "unknown_response_type", diagnostics.unknown_response_types);
  addDriftCount(
    health,
    "repeated_session_meta",
    diagnostics.repeated_session_meta,
  );
  addDriftCount(health, "orphan_turn_record", diagnostics.orphan_turn_records);
}

function addDriftCount(
  health: MutableHealth,
  kind: Exclude<ReaderProviderDriftDiagnostic["kind"], "identity_path_mismatch" | "unknown_root_type" | "unknown_event_type" | "unknown_response_type">,
  count: number,
): void {
  if (count === 0) return;
  health.drift.push({
    source: "codex_state",
    kind,
    provider: "codex",
    count,
  });
}

function addDriftMap(
  health: MutableHealth,
  kind: "unknown_root_type" | "unknown_event_type" | "unknown_response_type",
  values: Readonly<Record<string, number>>,
): void {
  for (const [value, count] of Object.entries(values)) {
    health.drift.push({
      source: "codex_state",
      kind,
      provider: "codex",
      value: boundedDiagnosticValue(value),
      count,
    });
  }
}

function boundedDiagnosticValue(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= 128) return value;
  const digest = createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${truncateReaderUtf8(value, 111)}#${digest}`;
}

function addIdentityDrift(
  health: MutableHealth,
  source: "active" | "feed" | "participation" | "cursor" | "journal",
  file: HealthFile,
): void {
  health.drift.push({
    source,
    kind: "identity_path_mismatch",
    count: 1,
    ...(file.provider === undefined ? {} : { provider: file.provider }),
    ...(file.sessionId === undefined ? {} : { session_id: file.sessionId }),
  });
}

function aggregateDrift(
  items: readonly ReaderProviderDriftDiagnostic[],
): ReaderProviderDriftDiagnostic[] {
  const byKey = new Map<string, ReaderProviderDriftDiagnostic>();
  for (const item of items) {
    const key = [
      item.source,
      item.kind,
      item.provider ?? "",
      item.session_id ?? "",
      item.value ?? "",
    ].join("\0");
    const prior = byKey.get(key);
    byKey.set(key, prior === undefined ? item : { ...prior, count: prior.count + item.count });
  }
  return [...byKey.values()].sort((left, right) =>
    compareUtf16CodeUnits(
      [left.source, left.kind, left.provider ?? "", left.session_id ?? "", left.value ?? ""].join("\0"),
      [right.source, right.kind, right.provider ?? "", right.session_id ?? "", right.value ?? ""].join("\0"),
    ),
  );
}

function completeSuffixLines(
  suffix: Buffer,
  startsMidFile: boolean,
  partialTail: boolean,
): Buffer[] {
  let start = 0;
  let end = suffix.byteLength;
  if (startsMidFile) {
    const firstNewline = suffix.indexOf(0x0a);
    if (firstNewline < 0) return [];
    start = firstNewline + 1;
  }
  if (partialTail) {
    const lastNewline = suffix.lastIndexOf(0x0a);
    if (lastNewline < start) return [];
    end = lastNewline + 1;
  }
  const lines: Buffer[] = [];
  let lineStart = start;
  for (let index = start; index < end; index += 1) {
    if (suffix[index] !== 0x0a) continue;
    let lineEnd = index;
    if (lineEnd > lineStart && suffix[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineEnd > lineStart) lines.push(suffix.subarray(lineStart, lineEnd));
    lineStart = index + 1;
  }
  return lines;
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function noteLimit(
  health: MutableHealth,
  list: HealthFileList,
  reason: string,
): void {
  if (list.limited) markLimited(health, reason);
}

function markLimited(health: MutableHealth, reason: string): void {
  health.limited = true;
  health.limitedReason ??= reason;
}

function refusalReason(error: unknown): string {
  if (error instanceof UnsafeStorePathError) return "unsafe_path";
  if (error instanceof StoreFileTooLargeError) return "file_too_large";
  if (isErrnoCode(error, "EACCES") || isErrnoCode(error, "EPERM")) {
    return "permission_refused";
  }
  return "read_refused";
}

function isIdentityMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/(?:identity.*does not match|does not match.*identity)/u.test(error.message) ||
      /turn actor does not match its session/u.test(error.message))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isSafeNonNegativeInteger(value);
}

function isPatternArray(value: unknown, pattern: RegExp): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && pattern.test(item))
  );
}

function isTurnOutcome(value: unknown): boolean {
  return (
    value === "success" ||
    value === "partial" ||
    value === "blocked" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "abandoned" ||
    value === "unknown"
  );
}

function isSafeNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
