import { constants } from "node:fs";
import {
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { ActiveLeaseStore } from "../active/store.js";
import { ACTIVE_ACTOR_FILENAME_PATTERN } from "../active/identity.js";
import type {
  BarbaroAction,
  BarbaroContent,
  BarbaroEvidenceV1,
  BarbaroSourceRef,
  BarbaroTurnV1,
} from "../contracts/v1.js";
import {
  SafeStoreBoundary,
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";

import {
  assertReaderPositiveInteger,
} from "./budget.js";
import { projectContext, projectEvidence } from "./projection.js";
import type {
  ReaderContextOptions,
  ReaderContextV1,
  ReaderDiagnostics,
  ReaderEvidenceOptions,
  ReaderEvidenceV1,
  ReaderProjection,
} from "./types.js";

const DEFAULT_TURNS_PER_SESSION = 5;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_LEASE_BYTES = 1024 * 1024;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_FILENAME_PATTERN = /^(ses_[0-9a-f]{32})\.jsonl$/u;
const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{32}$/u;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/u;
const ACTION_ID_PATTERN = /^act_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;

interface JsonlFile {
  readonly provider: string;
  readonly sessionId: string;
  readonly components: readonly string[];
}

interface FeedReadResult {
  readonly turns: readonly BarbaroTurnV1[];
  readonly malformed: number;
  readonly invalid: number;
  readonly partial: boolean;
  readonly scanLimited: boolean;
}

interface ReaderFileLimits {
  readonly maxFileBytes: number;
  readonly maxRecordBytes: number;
  readonly maxScanBytes: number;
}

export class ReaderRecordTooLargeError extends RangeError {
  readonly path: string;
  readonly maximumBytes: number;

  constructor(path: string, maximumBytes: number) {
    super(`Barbaro JSONL record in ${path} exceeds ${maximumBytes} bytes`);
    this.name = "ReaderRecordTooLargeError";
    this.path = path;
    this.maximumBytes = maximumBytes;
  }
}

export class ReaderEvidenceNotFoundError extends Error {
  readonly evidenceId: string;

  constructor(evidenceId: string) {
    super(`Barbaro evidence record not found: ${evidenceId}`);
    this.name = "ReaderEvidenceNotFoundError";
    this.evidenceId = evidenceId;
  }
}

/**
 * Read live non-idle leases first, then the newest completed turns across all
 * provider/session feeds. Canonical files are never opened writable.
 */
export async function readProjectContext(
  projectRoot: string,
  options: ReaderContextOptions,
): Promise<ReaderProjection<ReaderContextV1>> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  const turnsPerSession =
    options.turnsPerSession ?? DEFAULT_TURNS_PER_SESSION;
  assertReaderPositiveInteger(turnsPerSession, "turnsPerSession");
  const limits = fileLimits(options);
  const absoluteRoot = resolve(projectRoot);
  const boundary = SafeStoreBoundary.forBarbaroProject(absoluteRoot);
  await assertActiveFilesSafe(boundary);
  const activeDirectory = join(absoluteRoot, ".barbaro", "active");
  const scope = options.workstreamId;
  if (scope !== undefined && !WORKSTREAM_ID_PATTERN.test(scope)) {
    throw new TypeError(`Invalid workstreamId: ${JSON.stringify(scope)}`);
  }
  let invalidActiveRecords = 0;
  const allActive = await new ActiveLeaseStore(activeDirectory).listActive({
    ...(options.now === undefined ? {} : { now: options.now }),
    onInvalid: () => {
      invalidActiveRecords += 1;
    },
  });
  // A scoped read keeps only records stamped with the workstream. Records
  // without a stamp (pre-workstream sessions) are outside every scope.
  const active =
    scope === undefined
      ? allActive
      : allActive.filter((lease) => lease.workstream_id === scope);
  active.sort(compareActiveNewestFirst);

  const feedFiles = await listCanonicalJsonlFiles(boundary, "feed");
  const turns: BarbaroTurnV1[] = [];
  let malformedFeedRecords = 0;
  let invalidFeedRecords = 0;
  let partialFeedFiles = 0;
  let scanLimitedFeedFiles = 0;

  for (const file of feedFiles) {
    const result = await readNewestFeedTurns(
      boundary,
      file,
      turnsPerSession,
      limits,
    );
    turns.push(
      ...(scope === undefined
        ? result.turns
        : result.turns.filter((turn) => turn.workstream_id === scope)),
    );
    malformedFeedRecords += result.malformed;
    invalidFeedRecords += result.invalid;
    if (result.partial) partialFeedFiles += 1;
    if (result.scanLimited) scanLimitedFeedFiles += 1;
  }
  turns.sort(compareTurnsNewestFirst);

  const diagnostics: ReaderDiagnostics = {
    feed_files: feedFiles.length,
    malformed_feed_records: malformedFeedRecords,
    invalid_feed_records: invalidFeedRecords,
    partial_feed_files: partialFeedFiles,
    scan_limited_feed_files: scanLimitedFeedFiles,
    invalid_active_records: invalidActiveRecords,
  };
  return projectContext(active, turns, diagnostics, options);
}

/** Load one explicitly named evidence record and return only a bounded view. */
export async function readProjectEvidence(
  projectRoot: string,
  options: ReaderEvidenceOptions,
): Promise<ReaderProjection<ReaderEvidenceV1>> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  assertProvider(options.provider);
  assertSessionId(options.sessionId);
  if (!EVIDENCE_ID_PATTERN.test(options.evidenceId)) {
    throw new TypeError(`Invalid evidenceId: ${JSON.stringify(options.evidenceId)}`);
  }
  if (
    options.workstreamId !== undefined &&
    !WORKSTREAM_ID_PATTERN.test(options.workstreamId)
  ) {
    throw new TypeError(
      `Invalid workstreamId: ${JSON.stringify(options.workstreamId)}`,
    );
  }
  const limits = fileLimits(options);
  const boundary = SafeStoreBoundary.forBarbaroProject(resolve(projectRoot));
  const components = [
    "evidence",
    options.provider,
    `${options.sessionId}.jsonl`,
  ];
  const filePath = boundary.pathFor(components);
  const bytes = await readSafeRegularFile(boundary, components, limits.maxFileBytes);
  if (bytes === undefined) {
    throw new ReaderEvidenceNotFoundError(options.evidenceId);
  }

  let found: BarbaroEvidenceV1 | undefined;
  let foundCanonical: string | undefined;
  for (const line of completeJsonlLines(bytes)) {
    if (line.byteLength > limits.maxRecordBytes) {
      throw new ReaderRecordTooLargeError(filePath, limits.maxRecordBytes);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      continue;
    }
    if (!isEvidenceV1(value) || value.evidence_id !== options.evidenceId) {
      continue;
    }
    if (
      value.provider !== options.provider ||
      value.session_id !== options.sessionId
    ) {
      throw new Error("Evidence identity does not match its storage path");
    }
    const canonical = stableStringify(value);
    if (foundCanonical !== undefined && foundCanonical !== canonical) {
      throw new Error(`Conflicting canonical evidence ID: ${options.evidenceId}`);
    }
    found = value;
    foundCanonical = canonical;
  }
  if (found === undefined) {
    throw new ReaderEvidenceNotFoundError(options.evidenceId);
  }
  // Enforce scope before projection parses an action cursor or applies the
  // caller's byte budget. Out-of-scope records behave exactly like missing
  // records and cannot leak projection-specific validation details.
  if (
    options.workstreamId !== undefined &&
    found.workstream_id !== options.workstreamId
  ) {
    throw new ReaderEvidenceNotFoundError(options.evidenceId);
  }
  return projectEvidence(found, options);
}

export const readBarbaroContext = readProjectContext;
export const readBarbaroEvidence = readProjectEvidence;

export interface BarbaroFeedFile {
  readonly provider: string;
  readonly sessionId: string;
  readonly path: string;
}

/**
 * Boundary-verified feed files, for incremental consumers such as `watch`
 * that keep their own byte cursors instead of re-reading newest-N turns.
 */
export async function listFeedFiles(
  projectRoot: string,
): Promise<BarbaroFeedFile[]> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  const boundary = SafeStoreBoundary.forBarbaroProject(resolve(projectRoot));
  const files = await listCanonicalJsonlFiles(boundary, "feed");
  return files.map((file) => ({
    provider: file.provider,
    sessionId: file.sessionId,
    path: boundary.pathFor(file.components),
  }));
}

async function assertActiveFilesSafe(
  boundary: SafeStoreBoundary,
): Promise<void> {
  const root = await boundary.verifyDirectory(["active"]);
  if (root === undefined) return;
  const providers = await readdir(root, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  for (const providerEntry of providers) {
    if (!PROVIDER_PATTERN.test(providerEntry.name)) continue;
    const providerComponents = ["active", providerEntry.name];
    const providerPath = boundary.pathFor(providerComponents);
    if (providerEntry.isSymbolicLink() || !providerEntry.isDirectory()) {
      throw new UnsafeStorePathError(
        providerPath,
        "provider component is not a real directory",
      );
    }
    const verified = await boundary.verifyDirectory(providerComponents);
    if (verified === undefined) continue;
    const entries = await readdir(verified, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (!ACTIVE_ACTOR_FILENAME_PATTERN.test(entry.name)) continue;
      const components = [...providerComponents, entry.name];
      const path = boundary.pathFor(components);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(path, "active path is not a real file");
      }
      const opened = await openSafeRegularFile(
        boundary,
        components,
        MAX_ACTIVE_LEASE_BYTES,
      );
      await opened?.handle.close();
    }
  }
}

async function listCanonicalJsonlFiles(
  boundary: SafeStoreBoundary,
  kind: "feed" | "evidence",
): Promise<JsonlFile[]> {
  const root = await boundary.verifyDirectory([kind]);
  if (root === undefined) return [];
  const providers = await readdir(root, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: JsonlFile[] = [];

  for (const providerEntry of providers) {
    if (!PROVIDER_PATTERN.test(providerEntry.name)) continue;
    const providerComponents = [kind, providerEntry.name];
    const providerPath = boundary.pathFor(providerComponents);
    if (providerEntry.isSymbolicLink() || !providerEntry.isDirectory()) {
      throw new UnsafeStorePathError(
        providerPath,
        "provider component is not a real directory",
      );
    }
    const verifiedProvider = await boundary.verifyDirectory(providerComponents);
    if (verifiedProvider === undefined) continue;
    const entries = await readdir(verifiedProvider, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const match = SESSION_FILENAME_PATTERN.exec(entry.name);
      if (match === null) continue;
      const path = boundary.pathFor([...providerComponents, entry.name]);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(
          path,
          "canonical JSONL path is not a real file",
        );
      }
      files.push({
        provider: providerEntry.name,
        sessionId: match[1]!,
        components: [...providerComponents, entry.name],
      });
    }
  }
  return files;
}

async function readNewestFeedTurns(
  boundary: SafeStoreBoundary,
  file: JsonlFile,
  maximumRecords: number,
  limits: ReaderFileLimits,
): Promise<FeedReadResult> {
  const filePath = boundary.pathFor(file.components);
  const opened = await openSafeRegularFile(
    boundary,
    file.components,
    limits.maxFileBytes,
  );
  if (opened === undefined) {
    return {
      turns: [],
      malformed: 0,
      invalid: 0,
      partial: false,
      scanLimited: false,
    };
  }
  const { handle, size } = opened;
  try {
    const length = Math.min(size, limits.maxScanBytes);
    const start = size - length;
    const suffix = Buffer.allocUnsafe(length);
    await readExactly(handle, suffix, start);
    const partial = suffix.byteLength > 0 && suffix.at(-1) !== 0x0a;
    const firstNewline = suffix.indexOf(0x0a);
    if (start > 0 && firstNewline > limits.maxRecordBytes) {
      throw new ReaderRecordTooLargeError(filePath, limits.maxRecordBytes);
    }
    if (partial) {
      const finalNewline = suffix.lastIndexOf(0x0a);
      const partialBytes = suffix.byteLength - finalNewline - 1;
      if (partialBytes > limits.maxRecordBytes) {
        throw new ReaderRecordTooLargeError(filePath, limits.maxRecordBytes);
      }
    }
    const lines = completeSuffixJsonlLines(suffix, start > 0, partial);
    const turns: BarbaroTurnV1[] = [];
    let malformed = 0;
    let invalid = 0;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (line.byteLength > limits.maxRecordBytes) {
        throw new ReaderRecordTooLargeError(filePath, limits.maxRecordBytes);
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        malformed += 1;
        continue;
      }
      if (!isTurnV1(value)) {
        invalid += 1;
        continue;
      }
      if (value.provider !== file.provider || value.session_id !== file.sessionId) {
        invalid += 1;
        continue;
      }
      turns.push(value);
      if (turns.length === maximumRecords) break;
    }
    return {
      turns,
      malformed,
      invalid,
      partial,
      scanLimited: start > 0,
    };
  } finally {
    await handle.close();
  }
}

async function readSafeRegularFile(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  maximumBytes: number,
): Promise<Buffer | undefined> {
  const opened = await openSafeRegularFile(boundary, components, maximumBytes);
  if (opened === undefined) return undefined;
  try {
    const buffer = Buffer.allocUnsafe(opened.size);
    await readExactly(opened.handle, buffer, 0);
    return buffer;
  } finally {
    await opened.handle.close();
  }
}

async function openSafeRegularFile(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  maximumBytes: number,
): Promise<{ readonly handle: FileHandle; readonly size: number } | undefined> {
  const parent = await boundary.verifyDirectory(components.slice(0, -1));
  if (parent === undefined) return undefined;
  const path = boundary.pathFor(components);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
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
    return { handle, size: stats.size };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

function completeSuffixJsonlLines(
  suffix: Buffer,
  startsMidFile: boolean,
  hasPartialTail: boolean,
): Buffer[] {
  let start = 0;
  let end = suffix.byteLength;
  if (startsMidFile) {
    const firstNewline = suffix.indexOf(0x0a);
    if (firstNewline < 0) return [];
    start = firstNewline + 1;
  }
  if (hasPartialTail) {
    const finalNewline = suffix.lastIndexOf(0x0a);
    if (finalNewline < start) return [];
    end = finalNewline + 1;
  }
  return splitCompleteLines(suffix.subarray(start, end));
}

function completeJsonlLines(file: Buffer): Buffer[] {
  const finalNewline = file.lastIndexOf(0x0a);
  if (finalNewline < 0) return [];
  return splitCompleteLines(file.subarray(0, finalNewline + 1));
}

function splitCompleteLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    if (end > start) lines.push(bytes.subarray(start, end));
    start = index + 1;
  }
  return lines;
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let read = 0;
  while (read < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      read,
      buffer.byteLength - read,
      position + read,
    );
    if (result.bytesRead === 0) {
      throw new RangeError("Barbaro canonical file changed while being read");
    }
    read += result.bytesRead;
  }
}

function fileLimits(options: {
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxScanBytesPerFile?: number;
}): ReaderFileLimits {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxScanBytes = options.maxScanBytesPerFile ?? DEFAULT_MAX_SCAN_BYTES;
  assertReaderPositiveInteger(maxFileBytes, "maxFileBytes");
  assertReaderPositiveInteger(maxRecordBytes, "maxRecordBytes");
  assertReaderPositiveInteger(maxScanBytes, "maxScanBytesPerFile");
  return { maxFileBytes, maxRecordBytes, maxScanBytes };
}

function compareActiveNewestFirst(
  left: { readonly updated_at: string; readonly provider: string; readonly session_id: string; readonly agent_id: string },
  right: { readonly updated_at: string; readonly provider: string; readonly session_id: string; readonly agent_id: string },
): number {
  return (
    timestampMillis(right.updated_at) - timestampMillis(left.updated_at) ||
    compareUtf16CodeUnits(
      [left.provider, left.session_id, left.agent_id].join("\0"),
      [right.provider, right.session_id, right.agent_id].join("\0"),
    )
  );
}

function compareTurnsNewestFirst(left: BarbaroTurnV1, right: BarbaroTurnV1): number {
  return (
    timestampMillis(right.ended_at) - timestampMillis(left.ended_at) ||
    compareUtf16CodeUnits(left.provider, right.provider) ||
    compareUtf16CodeUnits(left.session_id, right.session_id) ||
    right.sequence - left.sequence ||
    compareUtf16CodeUnits(left.turn_id, right.turn_id)
  );
}

function timestampMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertProvider(provider: string): void {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new TypeError(`Invalid provider: ${JSON.stringify(provider)}`);
  }
}

function assertSessionId(sessionId: string): void {
  if (!/^ses_[0-9a-f]{32}$/u.test(sessionId)) {
    throw new TypeError(`Invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
}

export function isTurnV1(value: unknown): value is BarbaroTurnV1 {
  if (!isObject(value)) return false;
  return (
    value.schema === "barbaro.turn.v1" &&
    isPattern(value.turn_id, TURN_ID_PATTERN) &&
    isPattern(value.provider, PROVIDER_PATTERN) &&
    isPattern(value.session_id, /^ses_[0-9a-f]{32}$/u) &&
    (value.workstream_id === undefined ||
      isPattern(value.workstream_id, WORKSTREAM_ID_PATTERN)) &&
    isSafePositiveInteger(value.sequence) &&
    isNonEmptyString(value.agent_id) &&
    (value.parent_turn_id === undefined ||
      isPattern(value.parent_turn_id, TURN_ID_PATTERN)) &&
    isDateTime(value.started_at) &&
    isDateTime(value.ended_at) &&
    isTurnOutcome(value.outcome) &&
    isContent(value.request) &&
    (value.response === undefined || isContent(value.response)) &&
    Array.isArray(value.actions) &&
    value.actions.every(isAction) &&
    isSubagentRollup(value.subagents) &&
    isPatternArray(value.evidence_refs, EVIDENCE_ID_PATTERN) &&
    Array.isArray(value.source_refs) &&
    value.source_refs.every(isSourceRef)
  );
}

function isEvidenceV1(value: unknown): value is BarbaroEvidenceV1 {
  if (!isObject(value)) return false;
  if (
    value.schema !== "barbaro.evidence.v1" ||
    !isPattern(value.evidence_id, EVIDENCE_ID_PATTERN) ||
    ![
      "prompt",
      "response",
      "command",
      "tool_call",
      "tool_result",
      "failure_excerpt",
      "usage",
      "attachment_metadata",
      "subagent_turn",
      "provider_event",
    ].includes(String(value.kind)) ||
    !isPattern(value.turn_id, TURN_ID_PATTERN) ||
    !isPattern(value.provider, PROVIDER_PATTERN) ||
    !isPattern(value.session_id, /^ses_[0-9a-f]{32}$/u) ||
    (value.workstream_id !== undefined &&
      !isPattern(value.workstream_id, WORKSTREAM_ID_PATTERN)) ||
    !isNonEmptyString(value.agent_id) ||
    (value.parent_turn_id !== undefined &&
      !isPattern(value.parent_turn_id, TURN_ID_PATTERN)) ||
    !isDateTime(value.occurred_at) ||
    !Array.isArray(value.source_refs) ||
    !value.source_refs.every(isSourceRef) ||
    !isObject(value.content)
  ) {
    return false;
  }
  if (value.kind !== "subagent_turn") return true;
  const content = value.content;
  return (
    isParentLink(value.parent_link) &&
    isNonEmptyString(content.role) &&
    isSafePositiveInteger(content.sequence) &&
    isTurnOutcome(content.outcome) &&
    isDateTime(content.started_at) &&
    isDateTime(content.ended_at) &&
    isContent(content.request) &&
    (content.response === undefined || isContent(content.response)) &&
    Array.isArray(content.actions) &&
    content.actions.every(isAction)
  );
}

function isContent(value: unknown): value is BarbaroContent {
  return (
    isObject(value) &&
    isString(value.text) &&
    ["verbatim", "normalized", "excerpt", "redacted"].includes(
      String(value.fidelity),
    ) &&
    typeof value.truncated === "boolean" &&
    (value.original_utf8_bytes === undefined ||
      isSafeNonNegativeInteger(value.original_utf8_bytes)) &&
    (!value.truncated || isSafeNonNegativeInteger(value.original_utf8_bytes)) &&
    Array.isArray(value.redactions) &&
    value.redactions.every(
      (redaction) =>
        isObject(redaction) &&
        isNonEmptyString(redaction.kind) &&
        Number.isSafeInteger(redaction.count) &&
        Number(redaction.count) > 0,
    )
  );
}

function isAction(value: unknown): value is BarbaroAction {
  if (
    !isObject(value) ||
    !isPattern(value.action_id, ACTION_ID_PATTERN) ||
    !["success", "failed", "denied", "interrupted", "unknown"].includes(
      String(value.outcome),
    ) ||
    !Array.isArray(value.source_refs) ||
    !value.source_refs.every(isSourceRef)
  ) {
    return false;
  }
  switch (value.kind) {
    case "file_change":
      return (
        ["create", "modify", "delete", "move", "unknown"].includes(
          String(value.operation),
        ) &&
        isRepoPath(value.path) &&
        (value.previous_path === undefined || isRepoPath(value.previous_path))
      );
    case "command":
      return isContent(value.command) &&
        (value.failure_excerpt === undefined || isContent(value.failure_excerpt));
    case "test":
      return isContent(value.command) &&
        (value.failure_excerpt === undefined || isContent(value.failure_excerpt));
    case "tool":
      return isNonEmptyString(value.tool_name) &&
        (value.summary === undefined || isContent(value.summary));
    case "other":
      return isContent(value.summary);
    default:
      return false;
  }
}

function isSubagentRollup(value: unknown): boolean {
  return (
    isObject(value) &&
    isSafeNonNegativeInteger(value.total) &&
    Array.isArray(value.by_role) &&
    value.by_role.every(
      (entry) =>
        isObject(entry) &&
        isNonEmptyString(entry.role) &&
        isSafePositiveInteger(entry.count),
    ) &&
    isObject(value.outcomes) &&
    Array.isArray(value.changed_paths) &&
    value.changed_paths.every(isRepoPath) &&
    isPatternArray(value.evidence_refs, EVIDENCE_ID_PATTERN)
  );
}

function isSourceRef(value: unknown): value is BarbaroSourceRef {
  return isObject(value) && isNonEmptyString(value.trace_id);
}

function isParentLink(value: unknown): boolean {
  return (
    isObject(value) &&
    ["native", "joined", "unresolved"].includes(String(value.method)) &&
    (value.native_key === undefined || isString(value.native_key))
  );
}

function isTurnOutcome(value: unknown): boolean {
  return [
    "success",
    "partial",
    "blocked",
    "failed",
    "cancelled",
    "abandoned",
    "unknown",
  ].includes(String(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPatternArray(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.every((item) => isPattern(item, pattern));
}

function isPattern(value: unknown, pattern: RegExp): value is string {
  return isString(value) && pattern.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isDateTime(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isRepoPath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some((component) =>
    component.length === 0 || component === "." || component === "..",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
