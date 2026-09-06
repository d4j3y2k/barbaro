import { createHash, timingSafeEqual } from "node:crypto";
import { feedAvailabilityFailure, missingFeedError } from "../core/feed-availability.js";
import { constants } from "node:fs";
import {
  open,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import type { BarbaroTurnOutcome, BarbaroTurnV1 } from "../contracts/v1.js";
import {
  fileIdentityEquals,
  snapshotFromStats,
  type FileIdentity,
} from "../core/checkpoint.js";
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
  assertReaderByteBudget,
  assertReaderPositiveInteger,
  readerProjectionFits,
  wrapReaderProjection,
} from "./budget.js";
import { isTurnV1, ReaderRecordTooLargeError } from "./store.js";
import type { ReaderProjection } from "./types.js";

export const READER_TURN_LIST_SCHEMA =
  "barbaro.reader.turn-list.v1" as const;
export const READER_TURN_LIST_CURSOR_VERSION = 1 as const;

export const DEFAULT_TURN_LIST_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TURN_LIST_MAX_RECORD_BYTES = 8 * 1024 * 1024;

const CURSOR_PREFIX = "btl1";
const CURSOR_HASH_DOMAIN = "barbaro.reader.turn-list.cursor.v1\0";
const MAX_ENCODED_CURSOR_BYTES = 4 * 1024 * 1024;
const MAX_INFLATED_CURSOR_BYTES = 16 * 1024 * 1024;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const SESSION_FILE_PATTERN = /^(ses_[0-9a-f]{32})\.jsonl$/u;

export interface ReaderTurnListEntry {
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly agent_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly outcome: BarbaroTurnOutcome;
  /** UTF-8 bytes in the canonical request text available in this turn. */
  readonly request_utf8_bytes: number;
  /** Absent when the canonical turn has no response. */
  readonly response_utf8_bytes?: number;
  readonly action_count: number;
  readonly evidence_ref_count: number;
}

export interface ReaderTurnListV1 {
  readonly schema: typeof READER_TURN_LIST_SCHEMA;
  readonly scope:
    | { readonly kind: "all" }
    | { readonly kind: "workstream"; readonly workstream_id: string };
  /** True exactly when this page has no continuation cursor. */
  readonly complete: boolean;
  /** Zero-based, half-open ordinals in the pinned newest-first result set. */
  readonly range: {
    readonly start: number;
    readonly end: number;
  };
  /** Counts are pinned with the traversal and repeat on every page. */
  readonly diagnostics: {
    readonly malformed_feed_records: number;
    readonly invalid_feed_records: number;
    readonly skipped_oversized_feed_files: number;
    readonly unavailable_feed_files?: number;
  };
  readonly turns: {
    readonly shown: number;
    readonly total: number;
    readonly items: readonly ReaderTurnListEntry[];
    readonly next_cursor?: string;
  };
}

export interface ReaderTurnListOptions {
  readonly byteBudget: number;
  /** Unset means all workstreams, including historical unscoped turns. */
  readonly workstreamId?: string;
  readonly cursor?: string;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
}

interface TurnListLimits {
  readonly maxFileBytes: number;
  readonly maxRecordBytes: number;
}

interface FeedFile {
  readonly provider: string;
  readonly sessionId: string;
  readonly components: readonly string[];
}

interface FeedSnapshot extends FeedFile {
  /** Captured reads carry these; cursors bind them in snapshotBinding. */
  readonly identity?: FileIdentity;
  readonly endOffset: number;
  readonly sha256?: string;
}

interface TurnOrderingKey {
  readonly endedAt: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly turnId: string;
}

interface TurnListCursorState {
  readonly projectBinding: string;
  readonly scope: string;
  readonly queryBinding: string;
  readonly feeds: readonly FeedSnapshot[];
  readonly snapshotBinding: string;
  readonly after: TurnOrderingKey;
  readonly total: number;
  readonly skippedOversizedFeedFiles: number;
  readonly unavailableFeedFiles?: number;
}

interface CapturedFeedSnapshots {
  readonly snapshots: readonly FeedSnapshot[];
  readonly skippedOversizedFeedFiles: number;
  readonly unavailableFeedFiles: number;
}

interface ParsedFeedTurns {
  readonly turns: readonly BarbaroTurnV1[];
  readonly malformed: number;
  readonly invalid: number;
}

interface PinnedTurns extends ParsedFeedTurns {}

/** A valid cursor can no longer be resolved against its pinned snapshot. */
export class ReaderTurnListSnapshotError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ReaderTurnListSnapshotError";
  }
}

/** Conflicting canonical records reused a turn_id, so addressing is ambiguous. */
export class ReaderTurnListConflictError extends RangeError {
  readonly turnId: string;

  constructor(turnId: string) {
    super(`Conflicting canonical Barbaro turn ID: ${turnId}`);
    this.name = "ReaderTurnListConflictError";
    this.turnId = turnId;
  }
}

/**
 * Enumerate the complete pinned feed history in deterministic newest-first
 * order. Continuations re-open only the files captured by the first page and
 * read only to their captured byte endpoints, so later appends cannot enter a
 * traversal halfway through it.
 */
export async function readProjectTurnList(
  projectRoot: string,
  options: ReaderTurnListOptions,
): Promise<ReaderProjection<ReaderTurnListV1>> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  assertReaderByteBudget(options.byteBudget);
  const workstreamId = options.workstreamId;
  if (
    workstreamId !== undefined &&
    !WORKSTREAM_ID_PATTERN.test(workstreamId)
  ) {
    throw new TypeError(`Invalid workstreamId: ${JSON.stringify(workstreamId)}`);
  }
  const limits = turnListLimits(options);
  const absoluteRoot = resolve(projectRoot);
  const boundary = SafeStoreBoundary.forBarbaroProject(absoluteRoot);
  const projectBinding = await bindProject(absoluteRoot);
  const scope = workstreamId ?? "";
  const queryBinding = bindQuery(scope, limits);

  let snapshots: readonly FeedSnapshot[];
  let snapshotBinding: string;
  let skippedOversizedFeedFiles: number;
  let unavailableFeedFiles: number;
  let cursorState: TurnListCursorState | undefined;
  if (options.cursor === undefined) {
    const captured = await captureFeedSnapshots(boundary, limits);
    snapshots = captured.snapshots;
    skippedOversizedFeedFiles = captured.skippedOversizedFeedFiles;
    unavailableFeedFiles = captured.unavailableFeedFiles;
    snapshotBinding = bindFeedSnapshots(snapshots);
  } else {
    cursorState = decodeTurnListCursor(options.cursor);
    assertCursorBinding(cursorState, projectBinding, scope, queryBinding);
    snapshots = cursorState.feeds;
    snapshotBinding = cursorState.snapshotBinding;
    skippedOversizedFeedFiles = cursorState.skippedOversizedFeedFiles;
    unavailableFeedFiles = cursorState.unavailableFeedFiles ?? 0;
  }

  const pinned = await readPinnedTurns(
    boundary,
    snapshots,
    limits,
    snapshotBinding,
  );
  const scoped = pinned.turns.filter(
    (turn) => workstreamId === undefined || turn.workstream_id === workstreamId,
  );
  scoped.sort(compareTurnsNewestFirst);

  let start = 0;
  if (cursorState !== undefined) {
    if (cursorState.total !== scoped.length) {
      throw new ReaderTurnListSnapshotError(
        "Turn-list cursor snapshot no longer has the same result count",
      );
    }
    const previous = scoped.findIndex((turn) =>
      orderingKeysEqual(orderingKey(turn), cursorState!.after),
    );
    if (previous < 0) {
      throw new ReaderTurnListSnapshotError(
        "Turn-list cursor position is absent from its pinned snapshot",
      );
    }
    start = previous + 1;
  }

  return projectTurnListPage(
    scoped,
    start,
    snapshots,
    snapshotBinding,
    projectBinding,
    scope,
    queryBinding,
    options.byteBudget,
    workstreamId,
    {
      malformed_feed_records: pinned.malformed,
      invalid_feed_records: pinned.invalid,
      skipped_oversized_feed_files: skippedOversizedFeedFiles,
      ...(unavailableFeedFiles > 0 ? { unavailable_feed_files: unavailableFeedFiles } : {}),
    },
  );
}

export const readBarbaroTurnList = readProjectTurnList;

function projectTurnListPage(
  turns: readonly BarbaroTurnV1[],
  start: number,
  snapshots: readonly FeedSnapshot[],
  snapshotBinding: string,
  projectBinding: string,
  scope: string,
  queryBinding: string,
  byteBudget: number,
  workstreamId: string | undefined,
  diagnostics: ReaderTurnListV1["diagnostics"],
): ReaderProjection<ReaderTurnListV1> {
  if (start > turns.length) {
    throw new ReaderTurnListSnapshotError(
      "Turn-list cursor position is past its pinned result set",
    );
  }

  const build = (shown: number): ReaderTurnListV1 => {
    const end = start + shown;
    const complete = end === turns.length;
    const nextCursor = complete
      ? undefined
      : encodeTurnListCursor({
          projectBinding,
          scope,
          queryBinding,
          feeds: snapshots,
          snapshotBinding,
          after: orderingKey(turns[end - 1]!),
          total: turns.length,
          skippedOversizedFeedFiles:
            diagnostics.skipped_oversized_feed_files,
          ...(diagnostics.unavailable_feed_files === undefined ? {} : { unavailableFeedFiles: diagnostics.unavailable_feed_files }),
        });
    return {
      schema: READER_TURN_LIST_SCHEMA,
      scope: workstreamId === undefined
        ? { kind: "all" }
        : { kind: "workstream", workstream_id: workstreamId },
      complete,
      range: { start, end },
      diagnostics,
      turns: {
        shown,
        total: turns.length,
        items: turns.slice(start, end).map(projectTurnListEntry),
        ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
      },
    };
  };

  const remaining = turns.length - start;
  if (remaining === 0) {
    return wrapReaderProjection(build(0), byteBudget);
  }

  // Cursor state can be larger than the entire final page when a project has
  // many feed files but only a few turns in scope. Prefer that cursor-free
  // complete page before testing any partial candidate.
  if (readerProjectionFits(build(remaining), byteBudget)) {
    return wrapReaderProjection(build(remaining), byteBudget);
  }

  // A continuation that carries no item cannot move. Requiring the one-item
  // form to fit makes even heavily constrained successful pages advance.
  let shown = 1;
  let projected = wrapReaderProjection(build(shown), byteBudget);
  while (
    shown < remaining &&
    readerProjectionFits(build(shown + 1), byteBudget)
  ) {
    shown += 1;
    projected = wrapReaderProjection(build(shown), byteBudget);
  }
  return projected;
}

function projectTurnListEntry(turn: BarbaroTurnV1): ReaderTurnListEntry {
  return {
    turn_id: turn.turn_id,
    provider: turn.provider,
    session_id: turn.session_id,
    sequence: turn.sequence,
    agent_id: turn.agent_id,
    started_at: turn.started_at,
    ended_at: turn.ended_at,
    outcome: turn.outcome,
    request_utf8_bytes: Buffer.byteLength(turn.request.text, "utf8"),
    ...(turn.response === undefined
      ? {}
      : {
          response_utf8_bytes: Buffer.byteLength(turn.response.text, "utf8"),
        }),
    action_count: turn.actions.length,
    evidence_ref_count: turn.evidence_refs.length,
  };
}

async function captureFeedSnapshots(
  boundary: SafeStoreBoundary,
  limits: TurnListLimits,
): Promise<CapturedFeedSnapshots> {
  const files = await listFeedFiles(boundary);
  const snapshots: FeedSnapshot[] = [];
  let skippedOversizedFeedFiles = 0;
  let unavailableFeedFiles = 0;
  for (const file of files) {
    try {
      const captured = await readFeedAtEndpoint(boundary, file, limits);
      // Reject a record-oversized feed before pinning it into a traversal so
      // it behaves like a file-oversized feed on every continuation page.
      parseFeedTurns(captured.bytes, captured.path, captured.snapshot, limits);
      snapshots.push(captured.snapshot);
    } catch (error: unknown) {
      const failure = feedAvailabilityFailure(file, error);
      if (failure === undefined) throw error;
      if (failure.reason === "file_too_large" || failure.reason === "record_too_large") skippedOversizedFeedFiles += 1;
      else unavailableFeedFiles += 1;
    }
  }
  return { snapshots, skippedOversizedFeedFiles, unavailableFeedFiles };
}

async function readPinnedTurns(
  boundary: SafeStoreBoundary,
  snapshots: readonly FeedSnapshot[],
  limits: TurnListLimits,
  expectedSnapshotBinding: string,
): Promise<PinnedTurns> {
  const turnsById = new Map<
    string,
    { readonly turn: BarbaroTurnV1; readonly canonical: string }
  >();
  const observedSnapshots: FeedSnapshot[] = [];
  let malformed = 0;
  let invalid = 0;
  for (const snapshot of snapshots) {
    const read = await readFeedAtEndpoint(
      boundary,
      snapshot,
      limits,
      snapshot,
    );
    observedSnapshots.push(read.snapshot);
    const parsed = parseFeedTurns(read.bytes, read.path, snapshot, limits);
    malformed += parsed.malformed;
    invalid += parsed.invalid;
    for (const turn of parsed.turns) {
      const canonical = stableStringify(turn);
      const previous = turnsById.get(turn.turn_id);
      if (previous === undefined) {
        turnsById.set(turn.turn_id, { turn, canonical });
      } else if (previous.canonical !== canonical) {
        throw new ReaderTurnListConflictError(turn.turn_id);
      }
    }
  }
  if (bindFeedSnapshots(observedSnapshots) !== expectedSnapshotBinding) {
    throw new ReaderTurnListSnapshotError(
      "Pinned feed identities or contents changed",
    );
  }
  return {
    turns: [...turnsById.values()].map((entry) => entry.turn),
    malformed,
    invalid,
  };
}

async function listFeedFiles(
  boundary: SafeStoreBoundary,
): Promise<FeedFile[]> {
  const root = await boundary.verifyDirectory(["feed"]);
  if (root === undefined) return [];
  const providers = await readdir(root, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: FeedFile[] = [];

  for (const provider of providers) {
    if (!PROVIDER_PATTERN.test(provider.name)) continue;
    const providerComponents = ["feed", provider.name];
    if (provider.isSymbolicLink() || !provider.isDirectory()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(providerComponents),
        "feed provider component is not a real directory",
      );
    }
    const directory = await boundary.verifyDirectory(providerComponents);
    if (directory === undefined) {
      throw new ReaderTurnListSnapshotError(
        `Feed provider disappeared while listing: ${provider.name}`,
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const match = SESSION_FILE_PATTERN.exec(entry.name);
      if (match === null) continue;
      const components = [...providerComponents, entry.name];
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(
          boundary.pathFor(components),
          "canonical feed path is not a real file",
        );
      }
      files.push({
        provider: provider.name,
        sessionId: match[1]!,
        components,
      });
    }
  }
  return files;
}

async function readFeedAtEndpoint(
  boundary: SafeStoreBoundary,
  feed: FeedFile,
  limits: TurnListLimits,
  expected?: FeedSnapshot,
): Promise<{
  readonly path: string;
  readonly bytes: Buffer;
  readonly snapshot: FeedSnapshot;
}> {
  const parent = await boundary.verifyDirectory(feed.components.slice(0, -1));
  if (parent === undefined) {
    if (expected === undefined) throw missingFeedError();
    throw new ReaderTurnListSnapshotError(
      `Pinned feed parent is missing: ${feed.provider}/${feed.sessionId}`,
    );
  }
  const path = boundary.pathFor(feed.components);
  let handle: FileHandle;
  try {
    handle = await open(path, safeReadFlags());
  } catch (error: unknown) {
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeStorePathError(path, "final file is a symbolic link");
    }
    if (isErrnoCode(error, "ENOENT")) {
      if (expected === undefined) throw error;
      throw new ReaderTurnListSnapshotError(`Pinned feed is missing: ${path}`);
    }
    throw error;
  }

  try {
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile()) {
      throw new UnsafeStorePathError(path, "opened object is not a regular file");
    }
    if (beforeStats.nlink !== 1n) {
      throw new UnsafeStorePathError(path, "final file has multiple hard links");
    }
    const before = snapshotFromStats(beforeStats);
    const endOffset = expected?.endOffset ?? before.size;
    if (endOffset > limits.maxFileBytes) {
      throw new StoreFileTooLargeError(path, limits.maxFileBytes);
    }
    if (
      expected?.identity !== undefined &&
      !fileIdentityEquals(before.identity, expected.identity)
    ) {
      throw new ReaderTurnListSnapshotError(`Pinned feed was rotated: ${path}`);
    }
    if (before.size < endOffset) {
      throw new ReaderTurnListSnapshotError(`Pinned feed was truncated: ${path}`);
    }
    const bytes = Buffer.allocUnsafe(endOffset);
    await readExactly(handle, bytes, 0);
    const afterStats = await handle.stat({ bigint: true });
    if (!afterStats.isFile() || afterStats.nlink !== 1n) {
      throw new UnsafeStorePathError(path, "opened feed lost its regular single-link identity");
    }
    const after = snapshotFromStats(afterStats);
    if (
      !fileIdentityEquals(before.identity, after.identity) ||
      after.size < endOffset
    ) {
      throw new ReaderTurnListSnapshotError(
        `Pinned feed changed while being read: ${path}`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected?.sha256 !== undefined && sha256 !== expected.sha256) {
      throw new ReaderTurnListSnapshotError(`Pinned feed was rewritten: ${path}`);
    }
    return {
      path,
      bytes,
      snapshot: {
        provider: feed.provider,
        sessionId: feed.sessionId,
        components: feed.components,
        identity: before.identity,
        endOffset,
        sha256,
      },
    };
  } finally {
    await handle.close();
  }
}

function parseFeedTurns(
  bytes: Buffer,
  path: string,
  feed: FeedFile,
  limits: TurnListLimits,
): ParsedFeedTurns {
  const turns: BarbaroTurnV1[] = [];
  let malformed = 0;
  let invalid = 0;
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    const line = bytes.subarray(start, end);
    if (line.byteLength > limits.maxRecordBytes) {
      throw new ReaderRecordTooLargeError(path, limits.maxRecordBytes);
    }
    if (line.byteLength > 0) {
      const parsed = parseTurnLine(line, feed);
      if (parsed.kind === "turn") turns.push(parsed.turn);
      if (parsed.kind === "malformed") malformed += 1;
      if (parsed.kind === "invalid") invalid += 1;
    }
    start = index + 1;
  }
  const partialBytes = bytes.byteLength - start;
  if (partialBytes > limits.maxRecordBytes) {
    throw new ReaderRecordTooLargeError(path, limits.maxRecordBytes);
  }
  return { turns, malformed, invalid };
}

type ParsedTurnLine =
  | { readonly kind: "turn"; readonly turn: BarbaroTurnV1 }
  | { readonly kind: "malformed" }
  | { readonly kind: "invalid" };

function parseTurnLine(
  line: Buffer,
  feed: FeedFile,
): ParsedTurnLine {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    value = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (
    !isTurnV1(value) ||
    value.provider !== feed.provider ||
    value.session_id !== feed.sessionId
  ) {
    return { kind: "invalid" };
  }
  return { kind: "turn", turn: value };
}

function compareTurnsNewestFirst(
  left: BarbaroTurnV1,
  right: BarbaroTurnV1,
): number {
  return (
    timestampMillis(right.ended_at) - timestampMillis(left.ended_at) ||
    compareUtf16CodeUnits(left.provider, right.provider) ||
    compareUtf16CodeUnits(left.session_id, right.session_id) ||
    right.sequence - left.sequence ||
    compareUtf16CodeUnits(left.turn_id, right.turn_id)
  );
}

function orderingKey(turn: BarbaroTurnV1): TurnOrderingKey {
  return {
    endedAt: turn.ended_at,
    provider: turn.provider,
    sessionId: turn.session_id,
    sequence: turn.sequence,
    turnId: turn.turn_id,
  };
}

function orderingKeysEqual(
  left: TurnOrderingKey,
  right: TurnOrderingKey,
): boolean {
  return (
    left.endedAt === right.endedAt &&
    left.provider === right.provider &&
    left.sessionId === right.sessionId &&
    left.sequence === right.sequence &&
    left.turnId === right.turnId
  );
}

function timestampMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function turnListLimits(options: ReaderTurnListOptions): TurnListLimits {
  const maxFileBytes =
    options.maxFileBytes ?? DEFAULT_TURN_LIST_MAX_FILE_BYTES;
  const maxRecordBytes =
    options.maxRecordBytes ?? DEFAULT_TURN_LIST_MAX_RECORD_BYTES;
  assertReaderPositiveInteger(maxFileBytes, "maxFileBytes");
  assertReaderPositiveInteger(maxRecordBytes, "maxRecordBytes");
  return { maxFileBytes, maxRecordBytes };
}

async function bindProject(projectRoot: string): Promise<string> {
  const canonical = await realpath(projectRoot);
  const metadata = await stat(canonical, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new TypeError("projectRoot must be a directory");
  }
  return digestBase64Url(
    Buffer.from(
      stableStringify([
        canonical,
        metadata.dev.toString(10),
        metadata.ino.toString(10),
        metadata.birthtimeNs.toString(10),
      ]),
      "utf8",
    ),
  );
}

function bindQuery(scope: string, limits: TurnListLimits): string {
  return digestBase64Url(
    Buffer.from(
      stableStringify({
        schema: READER_TURN_LIST_SCHEMA,
        scope,
        order: [
          "ended_at:desc",
          "provider:asc",
          "session_id:asc",
          "sequence:desc",
          "turn_id:asc",
        ],
        max_file_bytes: limits.maxFileBytes,
        max_record_bytes: limits.maxRecordBytes,
      }),
      "utf8",
    ),
  );
}

function bindFeedSnapshots(snapshots: readonly FeedSnapshot[]): string {
  return digestBase64Url(
    Buffer.from(
      stableStringify(
        snapshots.map((feed) => {
          if (feed.identity === undefined || feed.sha256 === undefined) {
            throw new TypeError("Cannot bind an incomplete feed snapshot");
          }
          return [
            feed.provider,
            feed.sessionId,
            feed.identity.device,
            feed.identity.inode,
            feed.identity.birthtime_ns,
            feed.endOffset,
            feed.sha256,
          ];
        }),
      ),
      "utf8",
    ),
  );
}

function assertCursorBinding(
  cursor: TurnListCursorState,
  projectBinding: string,
  scope: string,
  queryBinding: string,
): void {
  if (cursor.projectBinding !== projectBinding) {
    throw new RangeError("Turn-list cursor belongs to a different project");
  }
  if (cursor.scope !== scope) {
    throw new RangeError("Turn-list cursor belongs to a different scope");
  }
  if (cursor.queryBinding !== queryBinding) {
    throw new RangeError("Turn-list cursor belongs to a different query");
  }
}

/**
 * Cursor payloads are compact arrays because the complete feed snapshot must
 * fit inside every projected page. The format remains private to this module.
 */
function encodeTurnListCursor(state: TurnListCursorState): string {
  const payload = [
    READER_TURN_LIST_CURSOR_VERSION,
    state.projectBinding,
    state.scope,
    state.queryBinding,
    state.feeds.map((feed) => [
      feed.provider,
      feed.sessionId,
      feed.endOffset,
    ]),
    state.snapshotBinding,
    [
      state.after.endedAt,
      state.after.provider,
      state.after.sessionId,
      state.after.sequence,
      state.after.turnId,
    ],
    state.total,
    state.skippedOversizedFeedFiles,
    ...(state.unavailableFeedFiles === undefined ? [] : [state.unavailableFeedFiles]),
  ];
  const compressed = deflateRawSync(
    Buffer.from(stableStringify(payload), "utf8"),
    { level: 9 },
  );
  const digest = cursorDigest(compressed);
  return `${CURSOR_PREFIX}.${compressed.toString("base64url")}.${digest.toString("base64url")}`;
}

function decodeTurnListCursor(cursor: string): TurnListCursorState {
  if (
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_ENCODED_CURSOR_BYTES
  ) {
    throw new TypeError("Malformed turn-list cursor");
  }
  const pieces = cursor.split(".");
  if (
    pieces.length !== 3 ||
    pieces[0] !== CURSOR_PREFIX ||
    !isBase64Url(pieces[1]!) ||
    !isBase64Url(pieces[2]!)
  ) {
    throw new TypeError("Malformed turn-list cursor");
  }
  const compressed = decodeCanonicalBase64Url(pieces[1]!);
  const suppliedDigest = decodeCanonicalBase64Url(pieces[2]!);
  const expectedDigest = cursorDigest(compressed);
  if (
    suppliedDigest.byteLength !== expectedDigest.byteLength ||
    !timingSafeEqual(suppliedDigest, expectedDigest)
  ) {
    throw new TypeError("Turn-list cursor integrity check failed");
  }

  let value: unknown;
  try {
    const inflated = inflateRawSync(compressed, {
      maxOutputLength: MAX_INFLATED_CURSOR_BYTES,
    });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new TypeError("Malformed turn-list cursor payload", { cause: error });
  }
  return parseCursorPayload(value);
}

function parseCursorPayload(value: unknown): TurnListCursorState {
  if (
    !Array.isArray(value) ||
    (value.length !== 8 && value.length !== 9 && value.length !== 10)
  ) {
    throw new TypeError("Malformed turn-list cursor payload");
  }
  const [
    version,
    projectBinding,
    scope,
    queryBinding,
    rawFeeds,
    snapshotBinding,
    rawAfter,
    total,
    rawSkippedOversizedFeedFiles,
    unavailableFeedFiles,
  ] = value;
  if (version !== READER_TURN_LIST_CURSOR_VERSION) {
    throw new TypeError("Unsupported turn-list cursor version");
  }
  if (!isDigestBinding(projectBinding) || !isDigestBinding(queryBinding)) {
    throw new TypeError("Malformed turn-list cursor binding");
  }
  if (
    typeof scope !== "string" ||
    (scope.length > 0 && !WORKSTREAM_ID_PATTERN.test(scope))
  ) {
    throw new TypeError("Malformed turn-list cursor scope");
  }
  if (!Array.isArray(rawFeeds)) {
    throw new TypeError("Malformed turn-list cursor feeds");
  }
  if (!isDigestBinding(snapshotBinding)) {
    throw new TypeError("Malformed turn-list cursor snapshot binding");
  }
  const feeds = rawFeeds.map(parseCursorFeed);
  for (let index = 1; index < feeds.length; index += 1) {
    if (compareFeedFiles(feeds[index - 1]!, feeds[index]!) >= 0) {
      throw new TypeError("Turn-list cursor feeds are not unique and sorted");
    }
  }
  const after = parseCursorOrderingKey(rawAfter);
  if (!isSafeNonNegativeInteger(total)) {
    throw new TypeError("Malformed turn-list cursor total");
  }
  const skippedOversizedFeedFiles =
    rawSkippedOversizedFeedFiles === undefined
      ? 0
      : rawSkippedOversizedFeedFiles;
  if (!isSafeNonNegativeInteger(skippedOversizedFeedFiles)) {
    throw new TypeError("Malformed turn-list cursor diagnostics");
  }
  if (unavailableFeedFiles !== undefined && !isSafeNonNegativeInteger(unavailableFeedFiles)) {
    throw new TypeError("Malformed turn-list cursor availability diagnostics");
  }
  return {
    projectBinding,
    scope,
    queryBinding,
    feeds,
    snapshotBinding,
    after,
    total,
    skippedOversizedFeedFiles,
    ...(unavailableFeedFiles === undefined ? {} : { unavailableFeedFiles }),
  };
}

function parseCursorFeed(value: unknown): FeedSnapshot {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("Malformed turn-list cursor feed");
  }
  const [provider, sessionId, endOffset] = value;
  if (typeof provider !== "string" || !PROVIDER_PATTERN.test(provider)) {
    throw new TypeError("Malformed turn-list cursor provider");
  }
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError("Malformed turn-list cursor session");
  }
  if (!isSafeNonNegativeInteger(endOffset)) {
    throw new TypeError("Malformed turn-list cursor feed endpoint");
  }
  return {
    provider,
    sessionId,
    components: ["feed", provider, `${sessionId}.jsonl`],
    endOffset,
  };
}

function parseCursorOrderingKey(value: unknown): TurnOrderingKey {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new TypeError("Malformed turn-list cursor ordering key");
  }
  const [endedAt, provider, sessionId, sequence, turnId] = value;
  if (
    typeof endedAt !== "string" ||
    !Number.isFinite(Date.parse(endedAt)) ||
    typeof provider !== "string" ||
    !PROVIDER_PATTERN.test(provider) ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    !isSafePositiveInteger(sequence) ||
    typeof turnId !== "string" ||
    !TURN_ID_PATTERN.test(turnId)
  ) {
    throw new TypeError("Malformed turn-list cursor ordering key");
  }
  return { endedAt, provider, sessionId, sequence, turnId };
}

function compareFeedFiles(left: FeedFile, right: FeedFile): number {
  return (
    compareUtf16CodeUnits(left.provider, right.provider) ||
    compareUtf16CodeUnits(left.sessionId, right.sessionId)
  );
}

function cursorDigest(compressed: Buffer): Buffer {
  return createHash("sha256")
    .update(CURSOR_HASH_DOMAIN, "utf8")
    .update(compressed)
    .digest();
}

function digestBase64Url(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function isDigestBinding(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError("Malformed turn-list cursor encoding");
  }
  return decoded;
}

function safeReadFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new TypeError("This platform cannot refuse feed symlinks");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
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
      throw new ReaderTurnListSnapshotError(
        "Pinned feed became shorter while being read",
      );
    }
    read += result.bytesRead;
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
