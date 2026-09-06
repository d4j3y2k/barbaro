import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

import type { BarbaroTurnV1 } from "../contracts/v1.js";
import {
  fileIdentityEquals,
  readCheckpointAnchor,
  snapshotFromStats,
  validateJsonlCheckpoint,
  type JsonlCheckpoint,
} from "../core/checkpoint.js";
import {
  SafeStoreBoundary,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";
import {
  NUDGE_CURSOR_SCHEMA,
  NUDGE_CURSOR_SCHEMA_V1,
  NUDGE_CURSOR_SCHEMA_V2,
  type NudgeCursor,
  type NudgeCursorV1,
  type NudgeCursorV2,
  type NudgeFeedCursorV1,
} from "../nudge/types.js";
import { isReadRecordAcknowledged, parseNudgeReadState } from "../nudge/read-state.js";

import { projectTurn } from "./projection.js";
import { isTurnV1 } from "./store.js";
import type {
  ReaderCoverage,
  ReaderProjection,
  ReaderReadState,
  ReaderTurnSummary,
} from "./types.js";

export const READER_UNREAD_BATCH_SCHEMA =
  "barbaro.reader.unread-batch.v1" as const;

const DEFAULT_MAX_RECIPIENTS = 256;
const DEFAULT_MAX_SOURCE_ENTRIES = 4096;
const DEFAULT_MAX_CURSOR_BYTES = 1024 * 1024;
const DEFAULT_MAX_FEED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const DEFAULT_TURN_BYTE_BUDGET = 4 * 1024;
const MAX_PROVIDER_BYTES = 64;
const MAX_TIMESTAMP_BYTES = 64;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/u;
const SESSION_FEED_PATTERN = /^(ses_[0-9a-f]{32})\.jsonl$/u;

/** The complete identity of one current workstream membership. */
export interface ReaderUnreadRecipientKey {
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
}

export interface ReaderUnreadTurn {
  readonly provider: string;
  readonly session_id: string;
  readonly turn: ReaderProjection<ReaderTurnSummary>;
}

export type ReaderUnreadIssue =
  | "cursor_invalid"
  | "cursor_rebuilt"
  | "cursor_refused"
  | "feed_invalid"
  | "feed_partial"
  | "feed_rebuilt"
  | "feed_refused"
  | "feed_scan_limited"
  | "feed_source_limited";

export interface ReaderUnreadSummaryBase {
  readonly key: ReaderUnreadRecipientKey;
  readonly cursor_state: "persisted" | "virtual" | "unknown";
  /** Present only when a persisted cursor supplied a valid value. */
  readonly cursor_revision?: number;
  /** Present only when a persisted cursor supplied a valid value. */
  readonly cursor_updated_at?: string;
  readonly read_state: ReaderReadState;
  readonly coverage: ReaderCoverage;
}

export interface ReaderUnreadSummaryReady extends ReaderUnreadSummaryBase {
  readonly status: "ready";
  readonly unread_count: number;
  readonly newest?: ReaderUnreadTurn;
}

export interface ReaderUnreadSummaryUnknown extends ReaderUnreadSummaryBase {
  readonly status: "unknown";
  readonly issue: ReaderUnreadIssue;
}

export type ReaderUnreadSummary =
  | ReaderUnreadSummaryReady
  | ReaderUnreadSummaryUnknown;

export interface ReaderUnreadBatchDiagnostics {
  /** Cursor paths opened or found absent. Duplicate physical paths count once. */
  readonly cursor_snapshots: number;
  readonly feed_files: number;
  readonly pinned_feed_files: number;
  /** Each feed contributes at most one shared physical range scan. */
  readonly scanned_feed_files: number;
}

/**
 * A bounded collection. `hidden` refers only to recipient projection; hidden
 * source feeds instead make the shown summaries unknown.
 */
export interface ReaderUnreadBatch {
  readonly schema: typeof READER_UNREAD_BATCH_SCHEMA;
  readonly shown: number;
  readonly total: number;
  readonly hidden: number;
  readonly items: readonly ReaderUnreadSummary[];
  readonly read_state: ReaderReadState;
  readonly coverage: ReaderCoverage;
  readonly diagnostics: ReaderUnreadBatchDiagnostics;
}

export interface ReaderUnreadBatchOptions {
  readonly projectRoot: string;
  readonly recipients: readonly ReaderUnreadRecipientKey[];
  readonly maxRecipients?: number;
  readonly maxSourceEntries?: number;
  readonly maxCursorBytes?: number;
  readonly maxFeedBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxScanBytesPerFeed?: number;
  readonly turnByteBudget?: number;
}

interface UnreadLimits {
  readonly maxRecipients: number;
  readonly maxSourceEntries: number;
  readonly maxCursorBytes: number;
  readonly maxFeedBytes: number;
  readonly maxRecordBytes: number;
  readonly maxScanBytes: number;
  readonly turnByteBudget: number;
}

interface FeedFile {
  readonly provider: string;
  readonly sessionId: string;
  readonly components: readonly string[];
  readonly path: string;
}

interface FeedList {
  readonly files: readonly FeedFile[];
  readonly total: number;
  readonly limited: boolean;
}

type CursorSnapshot =
  | { readonly kind: "virtual" }
  | { readonly kind: "persisted"; readonly cursor: NudgeCursor }
  | { readonly kind: "rebuilt" }
  | { readonly kind: "invalid" }
  | { readonly kind: "refused" };

interface MutableRecipient {
  readonly key: ReaderUnreadRecipientKey;
  readonly initialCursorSnapshot: CursorSnapshot;
  cursorState: "persisted" | "virtual" | "unknown";
  cursorRevision?: number;
  cursorUpdatedAt?: string;
  cursor?: NudgeCursor;
  issue?: ReaderUnreadIssue;
  readState: ReaderReadState;
  coverage: ReaderCoverage;
  unreadCount: number;
  newest?: BarbaroTurnV1;
}

interface FeedNeed {
  readonly recipient: MutableRecipient;
  readonly checkpoint?: JsonlCheckpoint;
  start?: number;
}

interface MutableDiagnostics {
  cursorSnapshots: number;
  feedFiles: number;
  pinnedFeedFiles: number;
  scannedFeedFiles: number;
}

/**
 * Compute E-02 for a bounded set of already-resolved current memberships.
 *
 * This is deliberately reader-owned: it imports cursor data types but no
 * cursor store or hook writer. It opens every shown recipient cursor at most
 * once, pins every canonical feed end at most once, and scans a feed at most
 * once from the earliest valid checkpoint needed by the batch. Missing cursor
 * files are virtual snapshots and are never initialized or repaired.
 */
export async function readUnreadSummaryBatch(
  options: ReaderUnreadBatchOptions,
): Promise<ReaderUnreadBatch> {
  const limits = validateOptions(options);
  const sorted = [...options.recipients].sort(compareRecipientKeys);
  assertUniqueRecipients(sorted);
  const total = sorted.length;
  const shownKeys = sorted.slice(0, limits.maxRecipients);
  const hidden = total - shownKeys.length;
  const boundary = SafeStoreBoundary.forBarbaroProject(resolve(options.projectRoot));
  const diagnostics: MutableDiagnostics = {
    cursorSnapshots: 0,
    feedFiles: 0,
    pinnedFeedFiles: 0,
    scannedFeedFiles: 0,
  };

  const recipients = await readCursorSnapshots(
    boundary,
    shownKeys,
    limits,
    diagnostics,
  );

  let feedList: FeedList;
  try {
    feedList = await listFeedFiles(boundary, limits.maxSourceEntries);
    diagnostics.feedFiles = feedList.total;
  } catch {
    for (const recipient of recipients) {
      noteIssue(recipient, "feed_refused", "refused");
    }
    await revalidateCursorSnapshots(boundary, recipients, limits);
    return finishBatch(
      recipients,
      total,
      hidden,
      diagnostics,
      limits.turnByteBudget,
    );
  }

  if (feedList.limited) {
    for (const recipient of recipients) {
      noteIssue(recipient, "feed_source_limited", "limited");
    }
  } else {
    noteMissingCheckpointFeeds(recipients, feedList.files);
    for (const feed of feedList.files) {
      await scanPinnedFeed(boundary, feed, recipients, limits, diagnostics);
    }
  }

  await revalidateCursorSnapshots(boundary, recipients, limits);
  return finishBatch(recipients, total, hidden, diagnostics, limits.turnByteBudget);
}

async function readCursorSnapshots(
  boundary: SafeStoreBoundary,
  keys: readonly ReaderUnreadRecipientKey[],
  limits: UnreadLimits,
  diagnostics: MutableDiagnostics,
): Promise<MutableRecipient[]> {
  const cache = new Map<string, Promise<CursorSnapshot>>();
  const pending = keys.map(async (key): Promise<MutableRecipient> => {
    const pathKey = `${key.provider}/${key.session_id}`;
    let snapshot = cache.get(pathKey);
    if (snapshot === undefined) {
      diagnostics.cursorSnapshots += 1;
      snapshot = readCursorSnapshot(boundary, key, limits.maxCursorBytes);
      cache.set(pathKey, snapshot);
    }
    const result = await snapshot;
    const recipient: MutableRecipient = {
      key,
      initialCursorSnapshot: result,
      cursorState: result.kind === "virtual"
        ? "virtual"
        : result.kind === "refused"
        ? "unknown"
        : "persisted",
      readState: "ok",
      coverage: { state: "complete" },
      unreadCount: 0,
    };
    if (result.kind === "refused") {
      noteIssue(recipient, "cursor_refused", "refused");
      return recipient;
    }
    if (result.kind === "invalid") {
      noteIssue(recipient, "cursor_invalid", "complete");
      return recipient;
    }
    if (result.kind === "rebuilt") {
      noteIssue(recipient, "cursor_rebuilt", "limited");
      return recipient;
    }
    if (result.kind === "persisted") {
      recipient.cursorRevision = result.cursor.cursor_revision;
      recipient.cursorUpdatedAt = result.cursor.updated_at;
      if (
        result.cursor.workstream_id !== key.workstream_id ||
        result.cursor.membership_from !== key.membership_from
      ) {
        noteIssue(recipient, "cursor_rebuilt", "complete");
        return recipient;
      }
      recipient.cursor = result.cursor;
    }
    return recipient;
  });
  return Promise.all(pending);
}

async function readCursorSnapshot(
  boundary: SafeStoreBoundary,
  key: ReaderUnreadRecipientKey,
  maximumBytes: number,
): Promise<CursorSnapshot> {
  const components = [
    "state",
    "nudge",
    key.provider,
    `${key.session_id}.json`,
  ];
  let parent: string | undefined;
  try {
    parent = await boundary.verifyDirectory(components.slice(0, -1));
  } catch {
    return { kind: "refused" };
  }
  if (parent === undefined) return { kind: "virtual" };

  const path = boundary.pathFor(components);
  let handle: FileHandle;
  try {
    handle = await open(path, safeReadFlags());
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return { kind: "virtual" };
    return { kind: "refused" };
  }
  try {
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile() || beforeStats.nlink !== 1n) {
      return { kind: "refused" };
    }
    const before = snapshotFromStats(beforeStats);
    if (before.size > maximumBytes) return { kind: "refused" };
    const bytes = Buffer.allocUnsafe(before.size);
    await readExactly(handle, bytes, 0);
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, before.size);
    const afterStats = await handle.stat({ bigint: true });
    if (afterStats.nlink !== 1n) return { kind: "refused" };
    const after = snapshotFromStats(afterStats);
    if (
      extraRead.bytesRead !== 0 ||
      !fileIdentityEquals(before.identity, after.identity) ||
      before.size !== after.size ||
      before.mtime_ns !== after.mtime_ns
    ) {
      return { kind: "rebuilt" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { kind: "invalid" };
    }
    try {
      return {
        kind: "persisted",
        cursor: parseCursor(text, key.provider, key.session_id),
      };
    } catch {
      return { kind: "invalid" };
    }
  } catch {
    return { kind: "refused" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function revalidateCursorSnapshots(
  boundary: SafeStoreBoundary,
  recipients: readonly MutableRecipient[],
  limits: UnreadLimits,
): Promise<void> {
  const cache = new Map<string, Promise<CursorSnapshot>>();
  for (const recipient of recipients) {
    const initial = recipient.initialCursorSnapshot;
    if (initial.kind !== "virtual" && initial.kind !== "persisted") continue;
    const pathKey = `${recipient.key.provider}/${recipient.key.session_id}`;
    let current = cache.get(pathKey);
    if (current === undefined) {
      current = readCursorSnapshot(
        boundary,
        recipient.key,
        limits.maxCursorBytes,
      );
      cache.set(pathKey, current);
    }
    const next = await current;
    if (sameCursorSnapshot(initial, next)) continue;
    if (next.kind === "refused") {
      noteIssue(recipient, "cursor_refused", "refused");
    } else {
      noteIssue(recipient, "cursor_rebuilt", "limited");
    }
  }
}

function sameCursorSnapshot(
  left: CursorSnapshot,
  right: CursorSnapshot,
): boolean {
  if (left.kind === "virtual" || right.kind === "virtual") {
    return left.kind === right.kind;
  }
  return (
    left.kind === "persisted" &&
    right.kind === "persisted" &&
    stableStringify(left.cursor) === stableStringify(right.cursor)
  );
}

async function listFeedFiles(
  boundary: SafeStoreBoundary,
  maximumEntries: number,
): Promise<FeedList> {
  const feedRoot = await boundary.verifyDirectory(["feed"]);
  if (feedRoot === undefined) return { files: [], total: 0, limited: false };
  const providers = await readdir(feedRoot, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: FeedFile[] = [];
  let total = 0;
  for (const provider of providers) {
    if (!validProvider(provider.name)) continue;
    const providerComponents = ["feed", provider.name];
    if (provider.isSymbolicLink() || !provider.isDirectory()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(providerComponents),
        "feed provider component is not a real directory",
      );
    }
    const directory = await boundary.verifyDirectory(providerComponents);
    if (directory === undefined) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const match = SESSION_FEED_PATTERN.exec(entry.name);
      if (match === null) continue;
      const components = [...providerComponents, entry.name];
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(
          boundary.pathFor(components),
          "canonical feed path is not a real file",
        );
      }
      total += 1;
      if (files.length < maximumEntries) {
        files.push({
          provider: provider.name,
          sessionId: match[1]!,
          components,
          path: boundary.pathFor(components),
        });
      }
    }
  }
  return { files, total, limited: total > files.length };
}

async function scanPinnedFeed(
  boundary: SafeStoreBoundary,
  feed: FeedFile,
  recipients: readonly MutableRecipient[],
  limits: UnreadLimits,
  diagnostics: MutableDiagnostics,
): Promise<void> {
  const needs: FeedNeed[] = [];
  for (const recipient of recipients) {
    if (
      recipient.key.provider === feed.provider &&
      recipient.key.session_id === feed.sessionId
    ) {
      continue;
    }
    const checkpoint = recipient.cursor === undefined
      ? undefined
      : findFeedCheckpoint(recipient.cursor, feed);
    needs.push({ recipient, ...(checkpoint === undefined ? {} : { checkpoint }) });
  }
  if (needs.length === 0) return;

  let handle: FileHandle;
  try {
    const parent = await boundary.verifyDirectory(feed.components.slice(0, -1));
    if (parent === undefined) throw new Error("feed parent disappeared");
    handle = await open(feed.path, safeReadFlags());
  } catch {
    markNeeds(needs, "feed_refused", "refused");
    return;
  }

  try {
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile() || beforeStats.nlink !== 1n) {
      markNeeds(needs, "feed_refused", "refused");
      return;
    }
    const pinned = snapshotFromStats(beforeStats);
    diagnostics.pinnedFeedFiles += 1;
    if (pinned.size > limits.maxFeedBytes) {
      markNeeds(needs, "feed_refused", "refused");
      return;
    }

    for (const need of needs) {
      if (need.checkpoint === undefined) {
        need.start = 0;
        continue;
      }
      const checkpoint = need.checkpoint;
      if (
        !fileIdentityEquals(pinned.identity, checkpoint.file_identity) ||
        pinned.size < checkpoint.byte_offset ||
        pinned.size < checkpoint.observed_size
      ) {
        noteIssue(need.recipient, "feed_rebuilt", "complete");
        continue;
      }
      try {
        const anchor = await readCheckpointAnchor(handle, checkpoint.byte_offset);
        if (
          anchor.byte_length !== checkpoint.anchor.byte_length ||
          anchor.sha256 !== checkpoint.anchor.sha256 ||
          !(await checkpointStartsAtLineBoundary(handle, checkpoint.byte_offset))
        ) {
          noteIssue(need.recipient, "feed_rebuilt", "complete");
          continue;
        }
      } catch {
        noteIssue(need.recipient, "feed_rebuilt", "complete");
        continue;
      }
      need.start = checkpoint.byte_offset;
    }

    const readableNeeds = needs.filter(
      (need): need is FeedNeed & { readonly start: number } =>
        need.start !== undefined && need.recipient.issue === undefined,
    );
    if (readableNeeds.length === 0) return;
    const earliest = readableNeeds.reduce(
      (minimum, need) => Math.min(minimum, need.start),
      pinned.size,
    );
    const scanBytes = pinned.size - earliest;
    if (scanBytes > limits.maxScanBytes) {
      for (const need of readableNeeds) {
        if (need.start < pinned.size) {
          noteIssue(need.recipient, "feed_scan_limited", "limited");
        }
      }
      return;
    }
    if (scanBytes === 0) return;

    diagnostics.scannedFeedFiles += 1;
    const bytes = Buffer.allocUnsafe(scanBytes);
    await readExactly(handle, bytes, earliest);
    const afterStats = await handle.stat({ bigint: true });
    const after = snapshotFromStats(afterStats);
    if (
      afterStats.nlink !== 1n ||
      !fileIdentityEquals(pinned.identity, after.identity) ||
      after.size < pinned.size
    ) {
      markNeeds(readableNeeds, "feed_rebuilt", "limited");
      return;
    }
    consumeFeedBytes(
      bytes,
      earliest,
      feed,
      readableNeeds,
      limits.maxRecordBytes,
    );
  } catch {
    markNeeds(needs, "feed_refused", "refused");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function consumeFeedBytes(
  bytes: Buffer,
  absoluteStart: number,
  feed: FeedFile,
  needs: readonly (FeedNeed & { readonly start: number })[],
  maximumRecordBytes: number,
): void {
  let relativeStart = 0;
  while (relativeStart < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, relativeStart);
    if (newline === -1) {
      const partialStart = absoluteStart + relativeStart;
      for (const need of needs) {
        if (need.start <= partialStart) {
          noteIssue(need.recipient, "feed_partial", "limited");
        }
      }
      return;
    }

    const byteStart = absoluteStart + relativeStart;
    const rawLine = bytes.subarray(relativeStart, newline);
    const line = rawLine.at(-1) === 0x0d
      ? rawLine.subarray(0, rawLine.byteLength - 1)
      : rawLine;
    const affected = needs.filter((need) => need.start <= byteStart);
    if (affected.length > 0) {
      if (line.byteLength > maximumRecordBytes) {
        markNeeds(affected, "feed_refused", "refused");
      } else {
        consumeFeedLine(line, feed, affected);
      }
    }
    relativeStart = newline + 1;
  }
}

function consumeFeedLine(
  line: Buffer,
  feed: FeedFile,
  needs: readonly FeedNeed[],
): void {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    value = JSON.parse(text) as unknown;
  } catch {
    markNeeds(needs, "feed_invalid", "complete");
    return;
  }
  if (
    !isTurnV1(value) ||
    !validProvider(value.provider) ||
    !validTimestamp(value.started_at) ||
    !validTimestamp(value.ended_at) ||
    value.provider !== feed.provider ||
    value.session_id !== feed.sessionId
  ) {
    markNeeds(needs, "feed_invalid", "complete");
    return;
  }
  for (const need of needs) {
    const recipient = need.recipient;
    if (
      recipient.issue !== undefined ||
      value.workstream_id !== recipient.key.workstream_id ||
      Date.parse(value.ended_at) <= Date.parse(recipient.key.membership_from)
    ) {
      continue;
    }
    if (recipient.cursor?.schema === NUDGE_CURSOR_SCHEMA &&
        isReadRecordAcknowledged(recipient.cursor.reads, value)) continue;
    recipient.unreadCount += 1;
    if (
      recipient.newest === undefined ||
      compareTurnRecency(value, recipient.newest) > 0
    ) {
      recipient.newest = value;
    }
  }
}

function finishBatch(
  recipients: readonly MutableRecipient[],
  total: number,
  hidden: number,
  diagnostics: MutableDiagnostics,
  turnByteBudget = DEFAULT_TURN_BYTE_BUDGET,
): ReaderUnreadBatch {
  const items = recipients.map((recipient) =>
    finishRecipient(recipient, turnByteBudget)
  );
  const refused = items.some((item) => item.read_state === "refused");
  const degraded = items.some((item) => item.read_state === "degraded");
  const limited = hidden > 0 || items.some((item) => item.coverage.state === "limited");
  const coverage: ReaderCoverage = refused
    ? { state: "refused", reason: "unread_source_refused" }
    : limited
    ? { state: "limited", reason: hidden > 0 ? "recipient_limit" : "unread_source_limited" }
    : { state: "complete" };
  return {
    schema: READER_UNREAD_BATCH_SCHEMA,
    shown: items.length,
    total,
    hidden,
    items,
    read_state: refused ? "refused" : degraded || hidden > 0 ? "degraded" : "ok",
    coverage,
    diagnostics: {
      cursor_snapshots: diagnostics.cursorSnapshots,
      feed_files: diagnostics.feedFiles,
      pinned_feed_files: diagnostics.pinnedFeedFiles,
      scanned_feed_files: diagnostics.scannedFeedFiles,
    },
  };
}

function finishRecipient(
  recipient: MutableRecipient,
  turnByteBudget: number,
): ReaderUnreadSummary {
  const base: ReaderUnreadSummaryBase = {
    key: recipient.key,
    cursor_state: recipient.cursorState,
    ...(recipient.cursorRevision === undefined
      ? {}
      : { cursor_revision: recipient.cursorRevision }),
    ...(recipient.cursorUpdatedAt === undefined
      ? {}
      : { cursor_updated_at: recipient.cursorUpdatedAt }),
    read_state: recipient.readState,
    coverage: recipient.coverage,
  };
  if (recipient.issue !== undefined) {
    return { ...base, status: "unknown", issue: recipient.issue };
  }
  return {
    ...base,
    status: "ready",
    unread_count: recipient.unreadCount,
    ...(recipient.newest === undefined
      ? {}
      : {
          newest: {
            provider: recipient.newest.provider,
            session_id: recipient.newest.session_id,
            turn: projectUnreadTurn(recipient.newest, turnByteBudget),
          },
        }),
  };
}

function noteIssue(
  recipient: MutableRecipient,
  issue: ReaderUnreadIssue,
  coverage: "complete" | "limited" | "refused",
): void {
  const currentRank = recipient.issue === undefined
    ? -1
    : coverageRank(recipient.coverage.state);
  const nextRank = coverageRank(coverage);
  if (currentRank >= nextRank) return;
  recipient.issue = issue;
  recipient.readState = coverage === "refused" ? "refused" : "degraded";
  recipient.coverage = coverage === "complete"
    ? { state: "complete" }
    : { state: coverage, reason: issue };
}

function coverageRank(state: ReaderCoverage["state"]): number {
  return state === "refused" ? 2 : state === "limited" ? 1 : 0;
}

function markNeeds(
  needs: readonly FeedNeed[],
  issue: ReaderUnreadIssue,
  coverage: "complete" | "limited" | "refused",
): void {
  for (const need of needs) noteIssue(need.recipient, issue, coverage);
}

function noteMissingCheckpointFeeds(
  recipients: readonly MutableRecipient[],
  feeds: readonly FeedFile[],
): void {
  const present = new Set(
    feeds.map((feed) => `${feed.provider}/${feed.sessionId}`),
  );
  for (const recipient of recipients) {
    if (recipient.cursor === undefined) continue;
    for (const checkpoint of recipient.cursor.feed_cursors) {
      if (
        checkpoint.provider === recipient.key.provider &&
        checkpoint.session_id === recipient.key.session_id
      ) {
        continue;
      }
      if (!present.has(`${checkpoint.provider}/${checkpoint.session_id}`)) {
        noteIssue(recipient, "feed_rebuilt", "complete");
        break;
      }
    }
  }
}

function findFeedCheckpoint(
  cursor: NudgeCursor,
  feed: FeedFile,
): JsonlCheckpoint | undefined {
  return cursor.feed_cursors.find(
    (candidate) =>
      candidate.provider === feed.provider &&
      candidate.session_id === feed.sessionId,
  )?.checkpoint;
}

function parseCursor(
  text: string,
  expectedProvider: string,
  expectedSessionId: string,
): NudgeCursor {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) throw new TypeError("cursor must be an object");
  if (value.schema === NUDGE_CURSOR_SCHEMA_V1) {
    return parseCursorV1(value, expectedProvider, expectedSessionId);
  }
  if (value.schema === NUDGE_CURSOR_SCHEMA_V2) {
    return parseCursorV2(value, expectedProvider, expectedSessionId);
  }
  if (value.schema === NUDGE_CURSOR_SCHEMA) {
    const { reads, ...legacy } = value;
    const base = parseCursorV2(legacy, expectedProvider, expectedSessionId);
    return {
      ...base,
      schema: NUDGE_CURSOR_SCHEMA,
      reads: parseNudgeReadState(reads, base.provider, base.claude_turn_generation),
    };
  }
  throw new TypeError("unsupported cursor schema");
}

function parseCursorV1(
  value: Record<string, unknown>,
  provider: string,
  sessionId: string,
): NudgeCursorV1 {
  const base = parseCursorBase(value, provider, sessionId, [
    "schema",
    "provider",
    "session_id",
    "workstream_id",
    "membership_from",
    "cursor_revision",
    "feed_cursors",
    "markers",
    "updated_at",
  ]);
  if (!isObject(value.markers)) throw new TypeError("invalid cursor markers");
  assertAllowedKeys(value.markers, ["user_prompt", "tool_boundary", "stop"]);
  for (const marker of Object.values(value.markers)) {
    if (marker !== base.cursor_revision) throw new TypeError("invalid cursor marker");
  }
  return { schema: NUDGE_CURSOR_SCHEMA_V1, ...base, markers: value.markers };
}

function parseCursorV2(
  value: Record<string, unknown>,
  provider: string,
  sessionId: string,
): NudgeCursorV2 {
  const base = parseCursorBase(value, provider, sessionId, [
    "schema",
    "provider",
    "session_id",
    "workstream_id",
    "membership_from",
    "cursor_revision",
    "feed_cursors",
    "markers",
    "delivery",
    "claude_turn_generation",
    "updated_at",
  ]);
  if (provider !== "codex" && provider !== "claude") {
    throw new TypeError("unsupported cursor provider");
  }
  if (!isObject(value.markers)) throw new TypeError("invalid cursor markers");
  assertAllowedKeys(value.markers, ["stop"]);
  if (
    value.markers.stop !== undefined &&
    value.markers.stop !== base.cursor_revision
  ) {
    throw new TypeError("invalid cursor stop marker");
  }
  if (!isObject(value.delivery)) throw new TypeError("invalid cursor delivery");
  assertAllowedKeys(value.delivery, ["highest_unread_count", "last_turn"]);
  if (!isNonnegativeSafeInteger(value.delivery.highest_unread_count)) {
    throw new TypeError("invalid cursor delivery high-water");
  }
  validateDeliveryTurn(value.delivery, provider, value.claude_turn_generation);
  if (provider === "claude") {
    if (!isPositiveSafeInteger(value.claude_turn_generation)) {
      throw new TypeError("invalid Claude cursor generation");
    }
  } else if (value.claude_turn_generation !== undefined) {
    throw new TypeError("Codex cursor carries Claude generation");
  }
  return {
    schema: NUDGE_CURSOR_SCHEMA_V2,
    ...base,
    markers: value.markers,
    delivery: value.delivery as unknown as NudgeCursorV2["delivery"],
    ...(provider === "claude"
      ? { claude_turn_generation: value.claude_turn_generation as number }
      : {}),
  };
}

function parseCursorBase(
  value: Record<string, unknown>,
  provider: string,
  sessionId: string,
  allowedKeys: readonly string[],
): Omit<NudgeCursorV1, "schema" | "markers"> {
  assertAllowedKeys(value, allowedKeys);
  if (
    value.provider !== provider ||
    value.session_id !== sessionId ||
    !validProvider(provider) ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    typeof value.workstream_id !== "string" ||
    !WORKSTREAM_ID_PATTERN.test(value.workstream_id) ||
    typeof value.membership_from !== "string" ||
    !validTimestamp(value.membership_from) ||
    !isPositiveSafeInteger(value.cursor_revision) ||
    typeof value.updated_at !== "string" ||
    !validTimestamp(value.updated_at) ||
    !Array.isArray(value.feed_cursors)
  ) {
    throw new TypeError("invalid cursor structure");
  }
  const feeds: NudgeFeedCursorV1[] = [];
  let prior: string | undefined;
  for (const candidate of value.feed_cursors) {
    if (
      !isObject(candidate) ||
      typeof candidate.provider !== "string" ||
      !validProvider(candidate.provider) ||
      typeof candidate.session_id !== "string" ||
      !SESSION_ID_PATTERN.test(candidate.session_id) ||
      !isObject(candidate.checkpoint)
    ) {
      throw new TypeError("invalid feed cursor");
    }
    assertAllowedKeys(candidate, ["provider", "session_id", "checkpoint"]);
    assertCheckpointKeys(candidate.checkpoint);
    validateJsonlCheckpoint(candidate.checkpoint as unknown as JsonlCheckpoint);
    const key = `${candidate.provider}/${candidate.session_id}`;
    if (prior !== undefined && compareUtf16CodeUnits(prior, key) >= 0) {
      throw new TypeError("feed cursors are not unique and sorted");
    }
    prior = key;
    feeds.push({
      provider: candidate.provider,
      session_id: candidate.session_id,
      checkpoint: candidate.checkpoint as unknown as JsonlCheckpoint,
    });
  }
  return {
    provider,
    session_id: sessionId,
    workstream_id: value.workstream_id,
    membership_from: value.membership_from,
    cursor_revision: value.cursor_revision,
    feed_cursors: feeds,
    updated_at: value.updated_at,
  };
}

function validateDeliveryTurn(
  delivery: Record<string, unknown>,
  provider: "codex" | "claude",
  generation: unknown,
): void {
  const value = delivery.last_turn;
  if (value === undefined) return;
  if (delivery.highest_unread_count === 0 || !isObject(value)) {
    throw new TypeError("invalid cursor delivery turn");
  }
  if (provider === "codex") {
    assertAllowedKeys(value, ["kind", "turn_id"]);
    if (
      value.kind !== "codex" ||
      typeof value.turn_id !== "string" ||
      !TURN_ID_PATTERN.test(value.turn_id)
    ) {
      throw new TypeError("invalid Codex delivery turn");
    }
    return;
  }
  assertAllowedKeys(value, ["kind", "generation"]);
  if (
    value.kind !== "claude" ||
    !isPositiveSafeInteger(value.generation) ||
    !isPositiveSafeInteger(generation) ||
    value.generation > generation
  ) {
    throw new TypeError("invalid Claude delivery turn");
  }
}

function assertCheckpointKeys(checkpoint: Record<string, unknown>): void {
  assertAllowedKeys(checkpoint, [
    "schema",
    "file_identity",
    "byte_offset",
    "next_line_number",
    "observed_size",
    "anchor",
  ]);
  if (!isObject(checkpoint.file_identity) || !isObject(checkpoint.anchor)) {
    throw new TypeError("invalid checkpoint structure");
  }
  assertAllowedKeys(checkpoint.file_identity, ["device", "inode", "birthtime_ns"]);
  assertAllowedKeys(checkpoint.anchor, ["byte_length", "sha256"]);
}

function validateOptions(options: ReaderUnreadBatchOptions): UnreadLimits {
  if (options.projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  for (const key of options.recipients) validateRecipientKey(key);
  return {
    maxRecipients: positiveInteger(options.maxRecipients ?? DEFAULT_MAX_RECIPIENTS, "maxRecipients"),
    maxSourceEntries: positiveInteger(options.maxSourceEntries ?? DEFAULT_MAX_SOURCE_ENTRIES, "maxSourceEntries"),
    maxCursorBytes: positiveInteger(options.maxCursorBytes ?? DEFAULT_MAX_CURSOR_BYTES, "maxCursorBytes"),
    maxFeedBytes: positiveInteger(options.maxFeedBytes ?? DEFAULT_MAX_FEED_BYTES, "maxFeedBytes"),
    maxRecordBytes: positiveInteger(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES, "maxRecordBytes"),
    maxScanBytes: positiveInteger(options.maxScanBytesPerFeed ?? DEFAULT_MAX_SCAN_BYTES, "maxScanBytesPerFeed"),
    turnByteBudget: positiveInteger(options.turnByteBudget ?? DEFAULT_TURN_BYTE_BUDGET, "turnByteBudget"),
  };
}

function validateRecipientKey(key: ReaderUnreadRecipientKey): void {
  if (
    !validProvider(key.provider) ||
    !SESSION_ID_PATTERN.test(key.session_id) ||
    !WORKSTREAM_ID_PATTERN.test(key.workstream_id) ||
    !validTimestamp(key.membership_from)
  ) {
    throw new TypeError("invalid unread recipient key");
  }
}

function assertUniqueRecipients(keys: readonly ReaderUnreadRecipientKey[]): void {
  let prior: string | undefined;
  for (const key of keys) {
    const current = recipientKey(key);
    if (current === prior) throw new TypeError("duplicate unread recipient key");
    prior = current;
  }
}

function compareRecipientKeys(
  left: ReaderUnreadRecipientKey,
  right: ReaderUnreadRecipientKey,
): number {
  return compareUtf16CodeUnits(recipientKey(left), recipientKey(right));
}

function recipientKey(key: ReaderUnreadRecipientKey): string {
  return `${key.provider}\u0000${key.session_id}\u0000${key.workstream_id}\u0000${key.membership_from}`;
}

function compareTurnRecency(left: BarbaroTurnV1, right: BarbaroTurnV1): number {
  return Date.parse(left.ended_at) - Date.parse(right.ended_at) ||
    left.sequence - right.sequence ||
    compareUtf16CodeUnits(left.turn_id, right.turn_id);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function safeReadFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new TypeError("this platform cannot refuse symbolic links");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (result.bytesRead === 0) throw new RangeError("source changed during read");
    offset += result.bytesRead;
  }
}

async function checkpointStartsAtLineBoundary(
  handle: FileHandle,
  byteOffset: number,
): Promise<boolean> {
  if (byteOffset === 0) return true;
  const prior = Buffer.allocUnsafe(1);
  const result = await handle.read(prior, 0, 1, byteOffset - 1);
  return result.bytesRead === 1 && prior[0] === 0x0a;
}

function projectUnreadTurn(
  turn: BarbaroTurnV1,
  byteBudget: number,
): ReaderProjection<ReaderTurnSummary> {
  return projectTurn(turn, { byteBudget });
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new TypeError(`unexpected cursor field: ${key}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function validTimestamp(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_TIMESTAMP_BYTES &&
    Number.isFinite(Date.parse(value));
}

function validProvider(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_BYTES &&
    PROVIDER_PATTERN.test(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
