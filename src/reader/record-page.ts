import { createHash } from "node:crypto";
import { feedAvailabilityFailure } from "../core/feed-availability.js";
import { constants } from "node:fs";
import {
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

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
import { stableStringify } from "../core/stable-json.js";

import {
  assertReaderByteBudget,
  assertReaderPositiveInteger,
  ReaderByteBudgetTooSmallError,
  wrapReaderProjection,
} from "./budget.js";
import {
  isTurnV1,
  listFeedFiles,
  ReaderRecordTooLargeError,
} from "./store.js";
import type { ReaderProjection } from "./types.js";

export { ReaderRecordTooLargeError } from "./store.js";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CURSOR_BYTES = 4096;
export const READER_RECORD_CURSOR_SCHEMA =
  "barbaro.reader.record-cursor.v1" as const;
export const READER_RECORD_CURSOR_VERSION = 1 as const;
export const READER_TURN_RECORD_SCHEMA = "barbaro.reader.turn.v1" as const;
export const READER_EVIDENCE_RECORD_SCHEMA =
  "barbaro.reader.evidence-record.v1" as const;
const CURSOR_SCHEMA = READER_RECORD_CURSOR_SCHEMA;
const CURSOR_VERSION = READER_RECORD_CURSOR_VERSION;
const TURN_PAGE_SCHEMA = READER_TURN_RECORD_SCHEMA;
const EVIDENCE_PAGE_SCHEMA = READER_EVIDENCE_RECORD_SCHEMA;
const JSON_STRING_CURSOR_SUFFIX = "\0json-string-v1";

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/u;
const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{32}$/u;
const ACTION_ID_PATTERN = /^act_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CURSOR_LOCATION_PATTERN =
  /^[a-z][a-z0-9_-]*\u0000ses_[0-9a-f]{32}$/u;

export type ReaderTurnRecordField =
  | "record"
  | "request"
  | "response"
  | "actions";

export type ReaderEvidenceRecordField =
  | "record"
  | "content"
  | "request"
  | "response"
  | "actions";

export interface ReaderRecordRange {
  /** Inclusive UTF-8 byte offset in the selected field. */
  readonly start: number;
  /** Exclusive UTF-8 byte offset in the selected field. */
  readonly end: number;
}

interface ReaderRecordPageBase<Field extends string> {
  readonly field: Field;
  /** Distinguishes an absent optional field from a present empty string. */
  readonly present: boolean;
  readonly encoding: "utf-8";
  /** JSON string token used when plain UTF-8 cannot preserve lone surrogates. */
  readonly representation?: "json-string";
  /** A Unicode-safe fragment of the selected representation. */
  readonly text: string;
  /** Byte count of the selected representation, not merely this page. */
  readonly total_utf8_bytes: number;
  readonly range: ReaderRecordRange;
  /** SHA-256 of the complete selected field, not merely this page. */
  readonly sha256: string;
  readonly complete: boolean;
  readonly next_cursor?: string;
}

export interface ReaderTurnRecordPageV1
  extends ReaderRecordPageBase<ReaderTurnRecordField> {
  readonly schema: typeof TURN_PAGE_SCHEMA;
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  /** Feed files skipped because the exposed file or record limit was exceeded. */
  readonly diagnostics: {
    readonly skipped_oversized_feed_files: number;
    readonly unavailable_feed_files?: number;
  };
}

export interface ReaderEvidenceRecordPageV1
  extends ReaderRecordPageBase<ReaderEvidenceRecordField> {
  readonly schema: typeof EVIDENCE_PAGE_SCHEMA;
  readonly evidence_id: string;
  readonly evidence_kind: string;
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
}

interface ReaderRecordPageOptions {
  readonly byteBudget: number;
  readonly cursor?: string;
  /** Unset means all workstreams, including legacy unscoped records. */
  readonly workstreamId?: string;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
}

export interface ReaderTurnRecordPageOptions extends ReaderRecordPageOptions {
  readonly turnId: string;
  readonly field?: ReaderTurnRecordField;
}

export interface ReaderEvidenceRecordPageOptions
  extends ReaderRecordPageOptions {
  readonly provider: string;
  readonly sessionId: string;
  readonly evidenceId: string;
  readonly field?: ReaderEvidenceRecordField;
}

export class ReaderTurnNotFoundError extends Error {
  readonly turnId: string;

  constructor(turnId: string) {
    super(`Barbaro turn record not found: ${turnId}`);
    this.name = "ReaderTurnNotFoundError";
    this.turnId = turnId;
  }
}

/**
 * No candidate was found, but at least one feed was skipped for exceeding
 * the exposed limits, so absence is unproven. Deliberately not a
 * ReaderTurnNotFoundError: a caller treating it as authoritative absence
 * would be wrong. The message names the flags that widen the search.
 */
export class ReaderTurnSearchIncompleteError extends Error {
  readonly turnId: string;
  readonly skippedOversizedFeedFiles: number;
  readonly unavailableFeedFiles: number;

  constructor(turnId: string, skippedOversizedFeedFiles: number, unavailableFeedFiles = 0) {
    super(
      unavailableFeedFiles > 0
        ? `Barbaro turn search incomplete for ${turnId}: ${unavailableFeedFiles} feed file(s) unavailable and ${skippedOversizedFeedFiles} over input limits; absence is unproven; restore feed access and retry`
        : `Barbaro turn search incomplete for ${turnId}: ${skippedOversizedFeedFiles} ` +
        "feed file(s) exceeded the reader limits and were skipped, so absence " +
        "is unproven; raise --max-file-bytes or --max-record-bytes to include them",
    );
    this.name = "ReaderTurnSearchIncompleteError";
    this.turnId = turnId;
    this.skippedOversizedFeedFiles = skippedOversizedFeedFiles;
    this.unavailableFeedFiles = unavailableFeedFiles;
  }
}

export class ReaderEvidenceRecordNotFoundError extends Error {
  readonly evidenceId: string;

  constructor(evidenceId: string) {
    super(`Barbaro evidence record not found: ${evidenceId}`);
    this.name = "ReaderEvidenceRecordNotFoundError";
    this.evidenceId = evidenceId;
  }
}

/** A malformed, tampered, stale, or foreign record-page cursor. */
export class ReaderRecordCursorError extends TypeError {
  constructor(reason: string) {
    super(`Invalid Barbaro record cursor: ${reason}`);
    this.name = "ReaderRecordCursorError";
  }
}

interface RecordFileLimits {
  readonly maxFileBytes: number;
  readonly maxRecordBytes: number;
}

interface SelectedText {
  readonly present: boolean;
  readonly text: string;
  readonly representation?: "json-string";
}

/** Where one canonical record line lives: a pinned byte range in its file. */
interface RecordLocation {
  readonly provider: string;
  readonly sessionId: string;
  /** Inclusive byte offset of the record line in the canonical file. */
  readonly start: number;
  /** Exclusive byte offset of the record line, excluding its newline. */
  readonly end: number;
}

type FoundTurn =
  | {
      readonly turn: undefined;
      readonly skippedOversizedFeedFiles: number;
      readonly unavailableFeedFiles?: number;
    }
  | {
      readonly turn: BarbaroTurnV1;
      readonly location: RecordLocation;
      readonly skippedOversizedFeedFiles: number;
      readonly unavailableFeedFiles?: number;
    };

type FoundEvidence =
  | { readonly evidence: undefined }
  | {
      readonly evidence: BarbaroEvidenceV1;
      readonly location: RecordLocation;
    };

interface CursorBody {
  /** Compact keys keep the opaque cursor from consuming the page payload. */
  readonly v: typeof CURSOR_VERSION;
  readonly p: string;
  readonly s: string;
  readonly k: "turn" | "evidence";
  readonly i: string;
  readonly f: string;
  readonly q: string;
  readonly h: string;
  readonly o: number;
  /** Pinned location: provider and session id separated by NUL. */
  readonly l: string;
  /** Pinned byte range of the record line, so growth elsewhere is harmless. */
  readonly a: number;
  readonly z: number;
  /** Diagnostics pinned with the traversal and repeated on every page. */
  readonly x: number;
  /** Optional availability count; old cursor shapes remain valid. */
  readonly u?: number;
}

interface EncodedCursor {
  readonly b: CursorBody;
  readonly c: string;
}

interface CursorQueryBinding {
  readonly project: string;
  readonly scope: string;
  readonly recordKind: "turn" | "evidence";
  readonly identity: string;
  readonly field: string;
  readonly query: string;
}

interface CursorBinding extends CursorQueryBinding {
  readonly recordSha256: string;
  readonly location: RecordLocation;
  readonly skippedOversizedFeedFiles: number;
  readonly unavailableFeedFiles?: number;
}

interface PageSlice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly complete: boolean;
  readonly nextCursor?: string;
}

/**
 * Return a lossless page of one canonical turn or directly address its large
 * textual/action fields. This reader never opens the store writable and does
 * not interact with nudge acknowledgment state.
 */
export async function readTurnRecordPage(
  projectRoot: string,
  options: ReaderTurnRecordPageOptions,
): Promise<ReaderProjection<ReaderTurnRecordPageV1>> {
  return (await readTurnRecordPageSnapshot(projectRoot, options)).projection;
}

/** Preserve the exact canonical record used to render a lossless page. */
export async function readTurnRecordPageSnapshot(
  projectRoot: string,
  options: ReaderTurnRecordPageOptions,
): Promise<{
  readonly projection: ReaderProjection<ReaderTurnRecordPageV1>;
  readonly turn: BarbaroTurnV1;
}> {
  validateProjectRoot(projectRoot);
  assertPattern(options.turnId, TURN_ID_PATTERN, "turnId");
  const field = options.field ?? "record";
  assertTurnField(field);
  validateCommonOptions(options);
  const absoluteRoot = resolve(projectRoot);
  const limits = recordFileLimits(options);
  const queryBinding: CursorQueryBinding = {
    project: await projectFingerprint(absoluteRoot),
    scope: scopeKey(options.workstreamId),
    recordKind: "turn",
    identity: options.turnId,
    field,
    query: limitsFingerprint(limits),
  };
  // A continuation reads only the byte range its cursor pinned, so the feed
  // growing past the exposed file limit between pages cannot strand it.
  let found: FoundTurn;
  if (options.cursor !== undefined) {
    const body = parseCursor(options.cursor);
    assertCursorQueryBeforeSelection(body, queryBinding);
    found = await pinnedTurn(absoluteRoot, body, options.turnId, limits);
  } else {
    found = await findTurn(absoluteRoot, options.turnId, limits);
  }
  if (found.turn === undefined) {
    if (options.cursor !== undefined) {
      throw new ReaderRecordCursorError("target record is no longer available");
    }
    if (found.skippedOversizedFeedFiles > 0 || (found.unavailableFeedFiles ?? 0) > 0) {
      throw new ReaderTurnSearchIncompleteError(
        options.turnId,
        found.skippedOversizedFeedFiles,
        found.unavailableFeedFiles,
      );
    }
    throw new ReaderTurnNotFoundError(options.turnId);
  }
  const turn = found.turn;
  if (
    options.workstreamId !== undefined &&
    turn.workstream_id !== options.workstreamId
  ) {
    if (options.cursor !== undefined) {
      throw new ReaderRecordCursorError("cursor does not match this scope");
    }
    throw new ReaderTurnNotFoundError(options.turnId);
  }

  const selected = selectTurnText(turn, field);
  const recordSha256 = sha256(stableStringify(turn));
  const binding: CursorBinding = {
    ...queryBinding,
    field: cursorFieldBinding(field, selected),
    recordSha256,
    location: found.location,
    skippedOversizedFeedFiles: found.skippedOversizedFeedFiles,
    ...(found.unavailableFeedFiles === undefined ? {} : { unavailableFeedFiles: found.unavailableFeedFiles }),
  };
  const projection = pageSelectedText<ReaderTurnRecordPageV1>(
    selected,
    binding,
    options.byteBudget,
    options.cursor,
    (page) => ({
      schema: TURN_PAGE_SCHEMA,
      turn_id: turn.turn_id,
      provider: turn.provider,
      session_id: turn.session_id,
      ...(turn.workstream_id === undefined
        ? {}
        : { workstream_id: turn.workstream_id }),
      diagnostics: {
        skipped_oversized_feed_files: found.skippedOversizedFeedFiles,
        ...(found.unavailableFeedFiles === undefined ? {} : { unavailable_feed_files: found.unavailableFeedFiles }),
      },
      field,
      present: selected.present,
      encoding: "utf-8",
      ...(selected.representation === undefined
        ? {}
        : { representation: selected.representation }),
      text: page.text,
      total_utf8_bytes: Buffer.byteLength(selected.text, "utf8"),
      range: { start: page.start, end: page.end },
      sha256: sha256(selected.text),
      complete: page.complete,
      ...(page.nextCursor === undefined
        ? {}
        : { next_cursor: page.nextCursor }),
    }),
  );
  return { projection, turn };
}

/**
 * Return an exact canonical evidence page. `content` is stable JSON; the
 * request/response/actions fields directly address subagent evidence, and
 * response/prompt evidence exposes its nested BarbaroContent text as well.
 */
export async function readEvidenceRecordPage(
  projectRoot: string,
  options: ReaderEvidenceRecordPageOptions,
): Promise<ReaderProjection<ReaderEvidenceRecordPageV1>> {
  validateProjectRoot(projectRoot);
  assertPattern(options.provider, PROVIDER_PATTERN, "provider");
  assertPattern(options.sessionId, SESSION_ID_PATTERN, "sessionId");
  assertPattern(options.evidenceId, EVIDENCE_ID_PATTERN, "evidenceId");
  const field = options.field ?? "record";
  assertEvidenceField(field);
  validateCommonOptions(options);
  const absoluteRoot = resolve(projectRoot);
  const limits = recordFileLimits(options);
  const queryBinding: CursorQueryBinding = {
    project: await projectFingerprint(absoluteRoot),
    scope: scopeKey(options.workstreamId),
    recordKind: "evidence",
    identity: [options.provider, options.sessionId, options.evidenceId].join("\0"),
    field,
    query: limitsFingerprint(limits),
  };
  let found: FoundEvidence;
  if (options.cursor !== undefined) {
    const body = parseCursor(options.cursor);
    assertCursorQueryBeforeSelection(body, queryBinding);
    found = await pinnedEvidence(absoluteRoot, body, options, limits);
  } else {
    found = await findEvidence(
      absoluteRoot,
      options.provider,
      options.sessionId,
      options.evidenceId,
      limits,
    );
  }
  if (found.evidence === undefined) {
    if (options.cursor !== undefined) {
      throw new ReaderRecordCursorError("target record is no longer available");
    }
    throw new ReaderEvidenceRecordNotFoundError(options.evidenceId);
  }
  const evidence = found.evidence;
  if (
    options.workstreamId !== undefined &&
    evidence.workstream_id !== options.workstreamId
  ) {
    if (options.cursor !== undefined) {
      throw new ReaderRecordCursorError("cursor does not match this scope");
    }
    throw new ReaderEvidenceRecordNotFoundError(options.evidenceId);
  }

  const selected = selectEvidenceText(evidence, field);
  const recordSha256 = sha256(stableStringify(evidence));
  const binding: CursorBinding = {
    ...queryBinding,
    field: cursorFieldBinding(field, selected),
    recordSha256,
    location: found.location,
    skippedOversizedFeedFiles: 0,
  };
  return pageSelectedText(
    selected,
    binding,
    options.byteBudget,
    options.cursor,
    (page) => ({
      schema: EVIDENCE_PAGE_SCHEMA,
      evidence_id: evidence.evidence_id,
      evidence_kind: evidence.kind,
      turn_id: evidence.turn_id,
      provider: evidence.provider,
      session_id: evidence.session_id,
      ...(evidence.workstream_id === undefined
        ? {}
        : { workstream_id: evidence.workstream_id }),
      field,
      present: selected.present,
      encoding: "utf-8",
      ...(selected.representation === undefined
        ? {}
        : { representation: selected.representation }),
      text: page.text,
      total_utf8_bytes: Buffer.byteLength(selected.text, "utf8"),
      range: { start: page.start, end: page.end },
      sha256: sha256(selected.text),
      complete: page.complete,
      ...(page.nextCursor === undefined
        ? {}
        : { next_cursor: page.nextCursor }),
    }),
  );
}

async function findTurn(
  projectRoot: string,
  turnId: string,
  limits: RecordFileLimits,
): Promise<FoundTurn> {
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  const files = await listFeedFiles(projectRoot);
  let found: BarbaroTurnV1 | undefined;
  let foundCanonical: string | undefined;
  let foundLocation: RecordLocation | undefined;
  let skippedOversizedFeedFiles = 0;
  let unavailableFeedFiles = 0;
  for (const file of files) {
    let bytes: Buffer | undefined;
    try {
      bytes = await readPinnedRegularFile(
        boundary,
        boundary.componentsForPath(file.path),
        limits.maxFileBytes,
      );
    } catch (error: unknown) {
      const failure = feedAvailabilityFailure(file, error);
      if (failure === undefined) throw error;
      if (failure.reason === "file_too_large" || failure.reason === "record_too_large") skippedOversizedFeedFiles += 1;
      else unavailableFeedFiles += 1;
      continue;
    }
    if (bytes === undefined) { unavailableFeedFiles += 1; continue; }

    // A feed is either wholly inside the exposed limits or wholly skipped.
    // Do not publish a candidate seen before a later oversized record.
    let feedTurn: BarbaroTurnV1 | undefined;
    let feedCanonical: string | undefined;
    let feedLocation: RecordLocation | undefined;
    try {
      for (const line of completeJsonlLines(
        bytes,
        file.path,
        limits.maxRecordBytes,
      )) {
        const value = parseJson(line);
        if (!isTurnV1(value) || value.turn_id !== turnId) continue;
        if (
          value.provider !== file.provider ||
          value.session_id !== file.sessionId
        ) {
          throw new Error("Turn identity does not match its storage path");
        }
        const canonical = stableStringify(value);
        if (feedCanonical !== undefined && canonical !== feedCanonical) {
          throw new Error(`Conflicting canonical turn ID: ${turnId}`);
        }
        feedTurn = value;
        feedCanonical = canonical;
        feedLocation = lineLocation(file.provider, file.sessionId, bytes, line);
      }
    } catch (error: unknown) {
      if (!(error instanceof ReaderRecordTooLargeError)) throw error;
      skippedOversizedFeedFiles += 1;
      continue;
    }
    if (
      feedTurn === undefined ||
      feedCanonical === undefined ||
      feedLocation === undefined
    ) {
      continue;
    }
    if (foundCanonical !== undefined && feedCanonical !== foundCanonical) {
      throw new Error(`Conflicting canonical turn ID: ${turnId}`);
    }
    found = feedTurn;
    foundCanonical = feedCanonical;
    foundLocation = feedLocation;
  }
  if (found === undefined || foundLocation === undefined) {
    return { turn: undefined, skippedOversizedFeedFiles, ...(unavailableFeedFiles > 0 ? { unavailableFeedFiles } : {}) };
  }
  return { turn: found, location: foundLocation, skippedOversizedFeedFiles, ...(unavailableFeedFiles > 0 ? { unavailableFeedFiles } : {}) };
}

/** Resume a turn page from the byte range its cursor pinned. */
async function pinnedTurn(
  projectRoot: string,
  body: CursorBody,
  turnId: string,
  limits: RecordFileLimits,
): Promise<FoundTurn> {
  const location = cursorLocation(body);
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  const bytes = await readPinnedRecordRange(
    boundary,
    ["feed", location.provider, `${location.sessionId}.jsonl`],
    location,
    limits,
  );
  const value = parseJson(bytes);
  if (
    !isTurnV1(value) ||
    value.turn_id !== turnId ||
    value.provider !== location.provider ||
    value.session_id !== location.sessionId
  ) {
    throw new ReaderRecordCursorError("target record is no longer available");
  }
  if (sha256(stableStringify(value)) !== body.h) {
    throw new ReaderRecordCursorError("cursor target changed since the prior page");
  }
  return { turn: value, location, skippedOversizedFeedFiles: body.x, ...(body.u === undefined ? {} : { unavailableFeedFiles: body.u }) };
}

/** Resume an evidence page from the byte range its cursor pinned. */
async function pinnedEvidence(
  projectRoot: string,
  body: CursorBody,
  options: ReaderEvidenceRecordPageOptions,
  limits: RecordFileLimits,
): Promise<FoundEvidence> {
  const location = cursorLocation(body);
  if (
    location.provider !== options.provider ||
    location.sessionId !== options.sessionId
  ) {
    throw new ReaderRecordCursorError("cursor does not match this query");
  }
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  const bytes = await readPinnedRecordRange(
    boundary,
    ["evidence", location.provider, `${location.sessionId}.jsonl`],
    location,
    limits,
  );
  const value = parseJson(bytes);
  if (
    !isEvidenceV1(value) ||
    value.evidence_id !== options.evidenceId ||
    value.provider !== location.provider ||
    value.session_id !== location.sessionId
  ) {
    throw new ReaderRecordCursorError("target record is no longer available");
  }
  if (sha256(stableStringify(value)) !== body.h) {
    throw new ReaderRecordCursorError("cursor target changed since the prior page");
  }
  return { evidence: value, location };
}

function cursorLocation(body: CursorBody): RecordLocation {
  const [provider, sessionId] = body.l.split("\0");
  if (provider === undefined || sessionId === undefined) {
    throw new ReaderRecordCursorError("invalid payload");
  }
  return { provider, sessionId, start: body.a, end: body.z };
}

function lineLocation(
  provider: string,
  sessionId: string,
  file: Buffer,
  line: Buffer,
): RecordLocation {
  const start = line.byteOffset - file.byteOffset;
  return { provider, sessionId, start, end: start + line.byteLength };
}

/**
 * Read exactly the pinned byte range of one canonical record. The live file
 * size is deliberately not held to the exposed file limit: only the pinned
 * range must still exist, so appends beyond it are harmless.
 */
async function readPinnedRecordRange(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  location: RecordLocation,
  limits: RecordFileLimits,
): Promise<Buffer> {
  if (
    location.end > limits.maxFileBytes ||
    location.end - location.start > limits.maxRecordBytes
  ) {
    throw new ReaderRecordCursorError("pinned record is outside the reader limits");
  }
  const parent = await boundary.verifyDirectory(components.slice(0, -1));
  if (parent === undefined) {
    throw new ReaderRecordCursorError("target record is no longer available");
  }
  const path = boundary.pathFor(components);
  let handle: FileHandle;
  try {
    handle = await open(path, safeReadFlags());
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new ReaderRecordCursorError("target record is no longer available");
    }
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeStorePathError(path, "final file is a symbolic link");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    assertPinnedDescriptor(path, before, location);
    const bytes = await readAt(
      handle,
      location.start,
      location.end - location.start,
    );
    if (bytes.byteLength !== location.end - location.start) {
      throw new ReaderRecordCursorError("target record is no longer available");
    }
    // The range must still be one whole JSONL line: preceded by a newline or
    // the file start, and terminated by LF or CRLF. Without that framing a
    // fresh reader would treat the record as partial or merged, so the
    // continuation must not accept it either.
    if (location.start > 0) {
      const preceding = await readAt(handle, location.start - 1, 1);
      if (preceding[0] !== 0x0a) {
        throw new ReaderRecordCursorError("pinned record framing changed");
      }
    }
    const following = await readAt(handle, location.end, 2);
    const terminated =
      following[0] === 0x0a ||
      (following[0] === 0x0d && following[1] === 0x0a);
    if (!terminated) {
      throw new ReaderRecordCursorError("pinned record framing changed");
    }
    // Re-check the descriptor after reading, as the full-file readers do, so
    // a concurrent truncation or hard link cannot slip inside the read.
    const after = await handle.stat();
    assertPinnedDescriptor(path, after, location);
    assertSameOpenedIdentity(path, before, after);
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertPinnedDescriptor(
  path: string,
  stats: Awaited<ReturnType<FileHandle["stat"]>>,
  location: RecordLocation,
): void {
  if (!stats.isFile()) {
    throw new UnsafeStorePathError(path, "opened object is not a regular file");
  }
  if (stats.nlink !== 1) {
    throw new UnsafeStorePathError(path, "final file has multiple hard links");
  }
  if (stats.size < location.end) {
    throw new ReaderRecordCursorError("target record is no longer available");
  }
}

/** Read up to `length` bytes at `position`; shorter only at end of file. */
async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function findEvidence(
  projectRoot: string,
  provider: string,
  sessionId: string,
  evidenceId: string,
  limits: RecordFileLimits,
): Promise<FoundEvidence> {
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  const components = ["evidence", provider, `${sessionId}.jsonl`];
  const path = boundary.pathFor(components);
  const bytes = await readPinnedRegularFile(
    boundary,
    components,
    limits.maxFileBytes,
  );
  if (bytes === undefined) return { evidence: undefined };
  let found: BarbaroEvidenceV1 | undefined;
  let foundCanonical: string | undefined;
  let foundLocation: RecordLocation | undefined;
  for (const line of completeJsonlLines(bytes, path, limits.maxRecordBytes)) {
    const value = parseJson(line);
    if (!isEvidenceV1(value) || value.evidence_id !== evidenceId) continue;
    if (value.provider !== provider || value.session_id !== sessionId) {
      throw new Error("Evidence identity does not match its storage path");
    }
    const canonical = stableStringify(value);
    if (foundCanonical !== undefined && canonical !== foundCanonical) {
      throw new Error(`Conflicting canonical evidence ID: ${evidenceId}`);
    }
    found = value;
    foundCanonical = canonical;
    foundLocation = lineLocation(provider, sessionId, bytes, line);
  }
  if (found === undefined || foundLocation === undefined) {
    return { evidence: undefined };
  }
  return { evidence: found, location: foundLocation };
}

/** The exact field representation shared by page readers and delivery checks. */
export function selectTurnText(
  turn: BarbaroTurnV1,
  field: ReaderTurnRecordField,
): SelectedText {
  switch (field) {
    case "record":
      return { present: true, text: stableStringify(turn) };
    case "request":
      return selectDirectText(turn.request.text);
    case "response":
      return turn.response === undefined
        ? { present: false, text: "" }
        : selectDirectText(turn.response.text);
    case "actions":
      return { present: true, text: stableStringify(turn.actions) };
  }
}

function selectEvidenceText(
  evidence: BarbaroEvidenceV1,
  field: ReaderEvidenceRecordField,
): SelectedText {
  switch (field) {
    case "record":
      return { present: true, text: stableStringify(evidence) };
    case "content":
      return { present: true, text: stableStringify(evidence.content) };
    case "request": {
      if (evidence.kind === "subagent_turn") {
        return selectDirectText(evidence.content.request.text);
      }
      const text = nestedContentText(evidence, "prompt");
      return text === undefined
        ? { present: false, text: "" }
        : selectDirectText(text);
    }
    case "response": {
      if (evidence.kind === "subagent_turn") {
        return evidence.content.response === undefined
          ? { present: false, text: "" }
          : selectDirectText(evidence.content.response.text);
      }
      const text = nestedContentText(evidence, "response");
      return text === undefined
        ? { present: false, text: "" }
        : selectDirectText(text);
    }
    case "actions":
      return evidence.kind === "subagent_turn"
        ? { present: true, text: stableStringify(evidence.content.actions) }
        : { present: false, text: "" };
  }
}

function selectDirectText(text: string): SelectedText {
  if (!hasLoneSurrogate(text)) return { present: true, text };
  return {
    present: true,
    text: stableStringify(text),
    representation: "json-string",
  };
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function cursorFieldBinding(field: string, selected: SelectedText): string {
  return selected.representation === "json-string"
    ? `${field}${JSON_STRING_CURSOR_SUFFIX}`
    : field;
}

function nestedContentText(
  evidence: BarbaroEvidenceV1,
  requiredKind: "prompt" | "response",
): string | undefined {
  if (evidence.kind !== requiredKind || !isObject(evidence.content)) {
    return undefined;
  }
  const nested = evidence.content.text;
  if (!isObject(nested) || typeof nested.text !== "string") return undefined;
  return nested.text;
}

function pageSelectedText<T>(
  selected: SelectedText,
  binding: CursorBinding,
  byteBudget: number,
  cursor: string | undefined,
  valueFor: (page: PageSlice) => T,
): ReaderProjection<T> {
  assertReaderByteBudget(byteBudget);
  const bytes = Buffer.from(selected.text, "utf8");
  const start =
    cursor === undefined ? 0 : decodeCursor(cursor, binding, bytes);

  if (bytes.byteLength === 0) {
    if (cursor !== undefined) {
      throw new ReaderRecordCursorError("cursor cannot address an empty field");
    }
    return wrapReaderProjection(
      valueFor({ start: 0, end: 0, text: "", complete: true }),
      byteBudget,
    );
  }

  const pageAt = (end: number): ReaderProjection<T> => {
    const complete = end === bytes.byteLength;
    const nextCursor = complete
      ? undefined
      : encodeCursor({ ...binding, offset: end });
    const page: PageSlice = {
      start,
      end,
      text: decodeUtf8(bytes.subarray(start, end)),
      complete,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    return wrapReaderProjection(valueFor(page), byteBudget);
  };

  // Omitting next_cursor can make the complete page smaller than a partial
  // page, so test it separately before the monotonic partial-page search.
  try {
    return pageAt(bytes.byteLength);
  } catch (error: unknown) {
    if (!(error instanceof ReaderByteBudgetTooSmallError)) throw error;
  }

  const minimumEnd = nextCodePointEnd(bytes, start);
  let low = minimumEnd;
  let high = bytes.byteLength - 1;
  let best: ReaderProjection<T> | undefined;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const end = previousCodePointBoundary(bytes, middle, minimumEnd);
    try {
      best = pageAt(end);
      low = middle + 1;
    } catch (error: unknown) {
      if (!(error instanceof ReaderByteBudgetTooSmallError)) throw error;
      high = middle - 1;
    }
  }
  if (best !== undefined) return best;

  // Produce the standard error with the exact minimum envelope size. A valid
  // page either advances by at least one complete code point or fails clearly.
  return pageAt(minimumEnd);
}

function encodeCursor(binding: CursorBinding & { readonly offset: number }): string {
  const body: CursorBody = {
    v: CURSOR_VERSION,
    p: binding.project,
    s: binding.scope,
    k: binding.recordKind,
    i: binding.identity,
    f: binding.field,
    q: binding.query,
    h: binding.recordSha256,
    o: binding.offset,
    l: `${binding.location.provider}\0${binding.location.sessionId}`,
    a: binding.location.start,
    z: binding.location.end,
    x: binding.skippedOversizedFeedFiles,
    ...(binding.unavailableFeedFiles === undefined ? {} : { u: binding.unavailableFeedFiles }),
  };
  const encoded: EncodedCursor = {
    b: body,
    c: cursorChecksum(body),
  };
  return Buffer.from(stableStringify(encoded), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  expected: CursorBinding,
  fieldBytes: Buffer,
): number {
  const body = parseCursor(cursor);
  assertCursorQuery(body, expected);
  if (body.h !== expected.recordSha256) {
    throw new ReaderRecordCursorError("cursor target changed since the prior page");
  }
  if (body.o <= 0 || body.o >= fieldBytes.byteLength) {
    throw new ReaderRecordCursorError("offset is outside the selected field");
  }
  if (!isCodePointBoundary(fieldBytes, body.o)) {
    throw new ReaderRecordCursorError("offset is not a UTF-8 boundary");
  }
  return body.o;
}

function parseCursor(cursor: string): CursorBody {
  if (
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new ReaderRecordCursorError("malformed encoding");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(cursor, "base64url");
  } catch {
    throw new ReaderRecordCursorError("malformed encoding");
  }
  if (decoded.toString("base64url") !== cursor) {
    throw new ReaderRecordCursorError("non-canonical encoding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(decoded));
  } catch {
    throw new ReaderRecordCursorError("malformed payload");
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, ["b", "c"])) {
    throw new ReaderRecordCursorError("unexpected envelope");
  }
  if (!isCursorBody(parsed.b) || typeof parsed.c !== "string") {
    throw new ReaderRecordCursorError("invalid payload");
  }
  const body = parsed.b;
  if (
    !SHA256_PATTERN.test(parsed.c) ||
    parsed.c !== cursorChecksum(body)
  ) {
    throw new ReaderRecordCursorError("checksum mismatch");
  }
  return body;
}

function assertCursorQuery(
  body: CursorBody,
  expected: CursorQueryBinding,
): void {
  if (
    body.p !== expected.project ||
    body.s !== expected.scope ||
    body.k !== expected.recordKind ||
    body.i !== expected.identity ||
    body.f !== expected.field ||
    body.q !== expected.query
  ) {
    throw new ReaderRecordCursorError("cursor does not match this query");
  }
}

/**
 * Validate every query component available before the target field is loaded.
 * The exceptional JSON-string binding is accepted provisionally; the exact
 * representation is checked by decodeCursor after selection. Plain UTF-8
 * fields keep their original binding, so their existing cursors remain valid.
 */
function assertCursorQueryBeforeSelection(
  body: CursorBody,
  expected: CursorQueryBinding,
): void {
  if (
    body.p !== expected.project ||
    body.s !== expected.scope ||
    body.k !== expected.recordKind ||
    body.i !== expected.identity ||
    ![expected.field, `${expected.field}${JSON_STRING_CURSOR_SUFFIX}`].includes(
      body.f,
    ) ||
    body.q !== expected.query
  ) {
    throw new ReaderRecordCursorError("cursor does not match this query");
  }
}

function cursorChecksum(body: CursorBody): string {
  return sha256(`${CURSOR_SCHEMA}\0${stableStringify(body)}`);
}

function isCursorBody(value: unknown): value is CursorBody {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, [
      "a",
      "f",
      "h",
      "i",
      "k",
      "l",
      "o",
      "p",
      "q",
      "s",
      "v",
      "x",
      "z",
      ...(value.u === undefined ? [] : ["u"]),
    ]) &&
    value.v === CURSOR_VERSION &&
    typeof value.l === "string" &&
    CURSOR_LOCATION_PATTERN.test(value.l) &&
    isSafeNonNegativeInteger(value.a) &&
    isSafePositiveInteger(value.z) &&
    Number(value.z) > Number(value.a) &&
    isSafeNonNegativeInteger(value.x) &&
    (value.u === undefined || isSafeNonNegativeInteger(value.u)) &&
    typeof value.p === "string" &&
    SHA256_PATTERN.test(value.p) &&
    typeof value.s === "string" &&
    (value.k === "turn" || value.k === "evidence") &&
    typeof value.i === "string" &&
    value.i.length > 0 &&
    typeof value.f === "string" &&
    value.f.length > 0 &&
    typeof value.q === "string" &&
    SHA256_PATTERN.test(value.q) &&
    typeof value.h === "string" &&
    SHA256_PATTERN.test(value.h) &&
    Number.isSafeInteger(value.o) &&
    Number(value.o) > 0
  );
}

function nextCodePointEnd(bytes: Buffer, start: number): number {
  if (start < 0 || start >= bytes.byteLength || !isCodePointBoundary(bytes, start)) {
    throw new ReaderRecordCursorError("offset is not a UTF-8 boundary");
  }
  let end = start + 1;
  while (end < bytes.byteLength && isContinuationByte(bytes[end]!)) end += 1;
  return end;
}

function previousCodePointBoundary(
  bytes: Buffer,
  candidate: number,
  minimum: number,
): number {
  let end = Math.max(candidate, minimum);
  while (end > minimum && !isCodePointBoundary(bytes, end)) end -= 1;
  return end;
}

function isCodePointBoundary(bytes: Buffer, offset: number): boolean {
  return (
    offset === 0 ||
    offset === bytes.byteLength ||
    !isContinuationByte(bytes[offset]!)
  );
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

async function readPinnedRegularFile(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  maximumBytes: number,
): Promise<Buffer | undefined> {
  const parent = await boundary.verifyDirectory(components.slice(0, -1));
  if (parent === undefined) return undefined;
  const path = boundary.pathFor(components);
  let handle: FileHandle;
  try {
    handle = await open(path, safeReadFlags());
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeStorePathError(path, "final file is a symbolic link");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    assertSafeOpenedFile(path, before, maximumBytes);
    const bytes = Buffer.allocUnsafe(before.size);
    await readExactly(handle, bytes);
    const middle = await handle.stat();
    assertSafeOpenedFile(path, middle, maximumBytes);
    assertSameOpenedIdentity(path, before, middle);
    if (middle.size < before.size) {
      throw new RangeError("Barbaro canonical file changed while being read");
    }
    const verificationSha256 = await digestFilePrefix(handle, before.size);
    const after = await handle.stat();
    assertSafeOpenedFile(path, after, maximumBytes);
    assertSameOpenedIdentity(path, before, after);
    if (
      after.size < before.size ||
      verificationSha256 !== sha256(bytes)
    ) {
      throw new RangeError("Barbaro canonical file changed while being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertSameOpenedIdentity(
  path: string,
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new UnsafeStorePathError(path, "opened file identity changed while reading");
  }
}

function assertSafeOpenedFile(
  path: string,
  stats: Awaited<ReturnType<FileHandle["stat"]>>,
  maximumBytes: number,
): void {
  if (!stats.isFile()) {
    throw new UnsafeStorePathError(path, "opened object is not a regular file");
  }
  if (stats.nlink !== 1) {
    throw new UnsafeStorePathError(path, "final file has multiple hard links");
  }
  if (stats.size > maximumBytes) {
    throw new StoreFileTooLargeError(path, maximumBytes);
  }
}

async function readExactly(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (read.bytesRead === 0) {
      throw new RangeError("Barbaro canonical file changed while being read");
    }
    offset += read.bytesRead;
  }
}

async function digestFilePrefix(
  handle: FileHandle,
  length: number,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(length, 1)));
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(buffer.byteLength, length - offset);
    const read = await handle.read(buffer, 0, requested, offset);
    if (read.bytesRead === 0) {
      throw new RangeError("Barbaro canonical file changed while being read");
    }
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return hash.digest("hex");
}

function* completeJsonlLines(
  bytes: Buffer,
  path: string,
  maximumRecordBytes: number,
): Generator<Buffer> {
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    const length = end - start;
    if (length > maximumRecordBytes) {
      throw new ReaderRecordTooLargeError(path, maximumRecordBytes);
    }
    if (length > 0) yield bytes.subarray(start, end);
    start = index + 1;
  }
  const partialBytes = bytes.byteLength - start;
  if (partialBytes > maximumRecordBytes) {
    throw new ReaderRecordTooLargeError(path, maximumRecordBytes);
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
    !isPattern(value.session_id, SESSION_ID_PATTERN) ||
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
  return (
    isParentLink(value.parent_link) &&
    isSubagentEvidenceContent(value.content)
  );
}

function isSubagentEvidenceContent(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.role) &&
    isSafePositiveInteger(value.sequence) &&
    isTurnOutcome(value.outcome) &&
    isDateTime(value.started_at) &&
    isDateTime(value.ended_at) &&
    isContent(value.request) &&
    (value.response === undefined || isContent(value.response)) &&
    Array.isArray(value.actions) &&
    value.actions.every(isAction)
  );
}

function isContent(value: unknown): value is BarbaroContent {
  return (
    isObject(value) &&
    typeof value.text === "string" &&
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
        isSafePositiveInteger(redaction.count),
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
      return (
        isContent(value.command) &&
        (value.failure_excerpt === undefined || isContent(value.failure_excerpt))
      );
    case "test":
      return (
        isContent(value.command) &&
        (value.failure_excerpt === undefined || isContent(value.failure_excerpt))
      );
    case "tool":
      return (
        isNonEmptyString(value.tool_name) &&
        (value.summary === undefined || isContent(value.summary))
      );
    case "other":
      return isContent(value.summary);
    default:
      return false;
  }
}

function isSourceRef(value: unknown): value is BarbaroSourceRef {
  return isObject(value) && isNonEmptyString(value.trace_id);
}

function isParentLink(value: unknown): boolean {
  return (
    isObject(value) &&
    ["native", "joined", "unresolved"].includes(String(value.method)) &&
    (value.native_key === undefined || typeof value.native_key === "string")
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

function isRepoPath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some(
    (component) =>
      component.length === 0 || component === "." || component === "..",
  );
}

function isPattern(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateProjectRoot(projectRoot: string): void {
  if (projectRoot.length === 0) throw new TypeError("projectRoot must not be empty");
}

function validateCommonOptions(options: ReaderRecordPageOptions): void {
  assertReaderByteBudget(options.byteBudget);
  if (options.workstreamId !== undefined) {
    assertPattern(options.workstreamId, WORKSTREAM_ID_PATTERN, "workstreamId");
  }
  if (options.cursor !== undefined && typeof options.cursor !== "string") {
    throw new TypeError("cursor must be a string");
  }
}

function recordFileLimits(options: ReaderRecordPageOptions): RecordFileLimits {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  assertReaderPositiveInteger(maxFileBytes, "maxFileBytes");
  assertReaderPositiveInteger(maxRecordBytes, "maxRecordBytes");
  return { maxFileBytes, maxRecordBytes };
}

function assertTurnField(field: string): asserts field is ReaderTurnRecordField {
  if (!["record", "request", "response", "actions"].includes(field)) {
    throw new TypeError(`Invalid turn record field: ${JSON.stringify(field)}`);
  }
}

function assertEvidenceField(
  field: string,
): asserts field is ReaderEvidenceRecordField {
  if (!["record", "content", "request", "response", "actions"].includes(field)) {
    throw new TypeError(`Invalid evidence record field: ${JSON.stringify(field)}`);
  }
}

function assertPattern(value: string, pattern: RegExp, name: string): void {
  if (!pattern.test(value)) {
    throw new TypeError(`Invalid ${name}: ${JSON.stringify(value)}`);
  }
}

function scopeKey(workstreamId: string | undefined): string {
  return workstreamId ?? "*";
}

async function projectFingerprint(projectRoot: string): Promise<string> {
  const canonicalPath = await realpath(projectRoot);
  const metadata = await stat(canonicalPath, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new TypeError("projectRoot must identify a directory");
  }
  return sha256(stableStringify({
    path: canonicalPath,
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
    birthtime_ns: metadata.birthtimeNs.toString(10),
  }));
}

function limitsFingerprint(limits: RecordFileLimits): string {
  return sha256(stableStringify({
    max_file_bytes: limits.maxFileBytes,
    max_record_bytes: limits.maxRecordBytes,
  }));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function safeReadFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new TypeError("This platform cannot refuse canonical-file symlinks");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}
