import {
  createJsonlCheckpoint,
  fileIdentityEquals,
  resolveJsonlCheckpoint,
  type JsonlCheckpoint,
} from "../core/checkpoint.js";
import { iterateJsonlForward } from "../core/jsonl-reader.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";
import {
  participationMemberships,
  SessionParticipationStore,
  type ParticipatingProvider,
} from "../hooks/participation.js";
import { projectTurn } from "../reader/projection.js";
import {
  isTurnV1,
  listFeedFiles,
  type BarbaroFeedFile,
} from "../reader/store.js";
import type { BarbaroTurnV1 } from "../contracts/v1.js";

import { NudgeCursorStateStore } from "./store.js";
import {
  NUDGE_CURSOR_SCHEMA,
  NUDGE_MARKER_KINDS,
  type HookCursorAdvance,
  type HookNudgeClaim,
  type HookStopClaimRollback,
  type HookNudgeTurn,
  type NudgeCursor,
  type NudgeCursorV1,
  type NudgeCursorV2,
  type NudgeDeliveryTurnV2,
  type NudgeFeedCursorV1,
  type NudgeMarkerKind,
  type NudgeMarkersV1,
  type UnreadPeerTurn,
  type UnreadPeerTurns,
  type UnreadPeerTurnsReady,
  type UnreadPeerTurnsUnavailable,
} from "./types.js";

const DEFAULT_TURN_BYTE_BUDGET = 4 * 1024;
const FALLBACK_TURN_BYTE_BUDGET = 64 * 1024;
const MAX_MEMBERSHIP_RETRIES = 3;
const MAX_FEED_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface UnreadPeerTurnOptions {
  readonly projectRoot: string;
  readonly provider: ParticipatingProvider;
  readonly nativeSessionId: string;
  readonly turnByteBudget?: number;
}

/** Stable-identity observer form used when a CLI already resolved consent. */
export interface StableUnreadPeerTurnOptions {
  readonly projectRoot: string;
  readonly provider: ParticipatingProvider;
  readonly sessionId: string;
  readonly turnByteBudget?: number;
}

type AnyUnreadPeerTurnOptions =
  | UnreadPeerTurnOptions
  | StableUnreadPeerTurnOptions;

export interface HookNudgeClaimOptions extends UnreadPeerTurnOptions {
  readonly marker: NudgeMarkerKind;
  readonly turn: HookNudgeTurn;
  readonly now?: Date;
  /** Best-effort observability for a committed cursor lock cleanup failure. */
  readonly onLockReleaseFailure?: (
    error: unknown,
  ) => void | Promise<void>;
}

export interface HookCursorAdvanceOptions extends UnreadPeerTurnOptions {
  readonly now?: Date;
  /** Best-effort observability for a committed cursor lock cleanup failure. */
  readonly onLockReleaseFailure?: (
    error: unknown,
  ) => void | Promise<void>;
}

interface MembershipEpoch {
  readonly status: "ready";
  readonly provider: ParticipatingProvider;
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly from: string;
}

type MembershipEpochResult = MembershipEpoch | UnreadPeerTurnsUnavailable;

type HookCursorTransactionResult<T> =
  | { readonly kind: "retry" }
  | { readonly kind: "done"; readonly value: T | UnreadPeerTurnsUnavailable };

interface VirtualCursor {
  readonly state: NudgeCursorV2;
  readonly reset: boolean;
  readonly existed: boolean;
  /** Valid v1 state being conservatively upgraded by a hook transaction. */
  readonly legacyMarkers?: NudgeMarkersV1;
}

interface ScopedScan {
  readonly public: UnreadPeerTurnsReady;
  readonly cursor: VirtualCursor;
  readonly candidateFeedCursors: readonly NudgeFeedCursorV1[];
}

/**
 * Inspect peer turns newer than this session's hook-owned cursor. This is a
 * strict observer: it never creates, initializes, repairs, claims, or clears
 * cursor state.
 */
export function inspectUnreadPeerTurns(
  options: UnreadPeerTurnOptions,
): Promise<UnreadPeerTurns>;
export function inspectUnreadPeerTurns(
  options: StableUnreadPeerTurnOptions,
): Promise<UnreadPeerTurns>;
export async function inspectUnreadPeerTurns(
  options: AnyUnreadPeerTurnOptions,
): Promise<UnreadPeerTurns> {
  validateOptions(options);
  const participationStore = new SessionParticipationStore(options.projectRoot);
  const cursorStore = new NudgeCursorStateStore(options.projectRoot);
  for (let attempt = 0; attempt < MAX_MEMBERSHIP_RETRIES; attempt += 1) {
    const before = await currentEpoch(participationStore, options);
    if (before.status !== "ready") return before;
    const current = await cursorStore.read(before.provider, before.sessionId);
    const scan = await scanUnread(options, before, current);
    const afterCursor = await cursorStore.read(
      before.provider,
      before.sessionId,
    );
    const after = await currentEpoch(participationStore, options);
    if (
      sameEpoch(before, after) &&
      sameLogicalCursor(current, afterCursor)
    ) {
      return scan.public;
    }
  }
  throw new Error("Barbaro membership changed repeatedly during unread scan");
}

/** Atomically decide one provider delivery without consuming unread turns. */
export async function claimHookNudge(
  options: HookNudgeClaimOptions,
): Promise<HookNudgeClaim> {
  validateOptions(options);
  validateHookTurn(options.provider, options.turn);
  if (!NUDGE_MARKER_KINDS.includes(options.marker)) {
    throw new TypeError(`Invalid nudge marker: ${JSON.stringify(options.marker)}`);
  }
  const timestamp = checkedTimestamp(options.now ?? new Date());
  return withHookCursor<HookNudgeClaim>(options, async (scan) => {
    const revision = scan.cursor.state.cursor_revision;
    let next = establishClaimTurn(scan.cursor, options.turn);
    const currentTurn = currentDeliveryTurn(next, options.turn);

    // V1 did not record counts or turns. A valid legacy marker proves some
    // delivery happened, so seed the current scan count as the conservative
    // high-water. A definite new prompt belongs to the next turn; a first
    // mid-turn event attributes the legacy delivery to its current turn.
    if (scan.cursor.legacyMarkers !== undefined) {
      const legacyDelivered = Object.keys(scan.cursor.legacyMarkers).length > 0;
      next = {
        ...next,
        delivery: {
          highest_unread_count: legacyDelivered
            ? scan.public.unread_count
            : 0,
          ...(legacyDelivered &&
              scan.public.unread_count > 0 &&
              options.marker !== "user_prompt"
            ? { last_turn: currentTurn }
            : {}),
        },
      };
    }
    const deliveryBeforeClaim = next.delivery;

    if (
      options.marker === "stop" &&
      next.markers.stop === revision
    ) {
      const shouldWrite =
        scan.cursor.reset ||
        !scan.cursor.existed ||
        !sameCursorPayload(scan.cursor.state, next);
      return {
        ...(shouldWrite ? { state: withUpdatedAt(next, timestamp) } : {}),
        result: {
          status: "already_claimed",
          provider: scan.public.provider,
          session_id: scan.public.session_id,
          workstream_id: scan.public.workstream_id,
          membership_from: scan.public.membership_from,
          cursor_revision: revision,
          marker: options.marker,
        },
      };
    }

    const isInformational = options.marker !== "stop";
    const sameTurnDelivery = deliveryTurnsEqual(
      next.delivery.last_turn,
      currentTurn,
    );
    const claimed = scan.public.unread_count > 0 &&
      (isInformational
        ? scan.public.unread_count > next.delivery.highest_unread_count
        : !sameTurnDelivery);

    if (scan.public.unread_count === 0) {
      // Moving over history, foreign turns, or malformed complete lines does
      // not consume peer news. Persisting those endpoints avoids rescanning
      // an old project on every hook while keeping a post-snapshot append new.
      next = {
        ...next,
        feed_cursors: scan.candidateFeedCursors,
      };
    } else if (claimed) {
      next = {
        ...next,
        markers: options.marker === "stop"
          ? { stop: revision }
          : next.markers,
        delivery: {
          highest_unread_count: Math.max(
            next.delivery.highest_unread_count,
            scan.public.unread_count,
          ),
          last_turn: currentTurn,
        },
      };
    }

    const shouldWrite =
      scan.cursor.reset ||
      !scan.cursor.existed ||
      !sameCursorPayload(scan.cursor.state, next);
    return {
      ...(shouldWrite ? { state: withUpdatedAt(next, timestamp) } : {}),
      result: {
        ...scan.public,
        marker: options.marker,
        claimed,
        ...(options.marker === "stop" && claimed
          ? {
              stop_rollback: {
                provider: options.provider,
                session_id: scan.public.session_id,
                workstream_id: scan.public.workstream_id,
                membership_from: scan.public.membership_from,
                cursor_revision: revision,
                before: deliveryBeforeClaim,
                claimed: next.delivery,
              },
            }
          : {}),
      },
    };
  });
}

export interface HookStopClaimRollbackOptions {
  readonly projectRoot: string;
  readonly receipt: HookStopClaimRollback;
  readonly now?: Date;
  /** Best-effort observability for committed rollback lock cleanup failure. */
  readonly onLockReleaseFailure?: (
    error: unknown,
  ) => void | Promise<void>;
}

/**
 * Undo a Stop latch whose active continuation failed before it was persisted.
 * The receipt was captured inside the original cursor transaction. A newer
 * revision wins; a concurrent informational announcement keeps its ledger.
 */
export async function rollbackHookStopClaim(
  options: HookStopClaimRollbackOptions,
): Promise<boolean> {
  if (options.projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  const receipt = options.receipt;
  if (
    (receipt.provider !== "codex" && receipt.provider !== "claude") ||
    !/^ses_[0-9a-f]{32}$/u.test(receipt.session_id) ||
    !/^ws_[0-9a-f]{32}$/u.test(receipt.workstream_id) ||
    !Number.isFinite(Date.parse(receipt.membership_from)) ||
    !Number.isSafeInteger(receipt.cursor_revision) ||
    receipt.cursor_revision <= 0
  ) {
    throw new TypeError("Stop rollback receipt is invalid");
  }
  const timestamp = checkedTimestamp(options.now ?? new Date());
  const store = new NudgeCursorStateStore(options.projectRoot);
  return store.withHookWrite(
    receipt.provider,
    receipt.session_id,
    async (current) => {
      if (
        current === undefined ||
        current.schema !== NUDGE_CURSOR_SCHEMA ||
        current.workstream_id !== receipt.workstream_id ||
        current.membership_from !== receipt.membership_from ||
        current.cursor_revision !== receipt.cursor_revision ||
        current.markers.stop !== receipt.cursor_revision
      ) {
        return { result: false };
      }
      const delivery = stableStringify(current.delivery) ===
          stableStringify(receipt.claimed)
        ? receipt.before
        : current.delivery;
      return {
        state: {
          ...current,
          markers: {},
          delivery,
          updated_at: timestamp,
        },
        result: true,
      };
    },
    {
      ...(options.onLockReleaseFailure === undefined
        ? {}
        : { onLockReleaseFailure: options.onLockReleaseFailure }),
    },
  );
}

/**
 * Advance through the pinned scan and re-arm every delivery marker. Called
 * only by a hook that recognized a leading `barbaro context` invocation.
 */
export async function advanceHookReadCursor(
  options: HookCursorAdvanceOptions,
): Promise<HookCursorAdvance> {
  validateOptions(options);
  const timestamp = checkedTimestamp(options.now ?? new Date());
  return withHookCursor(options, async (scan) => {
    const nextRevision = scan.cursor.state.cursor_revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new RangeError("nudge cursor revision overflow");
    }
    const next: NudgeCursorV2 = {
      ...scan.cursor.state,
      cursor_revision: nextRevision,
      feed_cursors: scan.candidateFeedCursors,
      markers: {},
      delivery: { highest_unread_count: 0 },
      updated_at: timestamp,
    };
    return {
      state: next,
      result: {
        ...scan.public,
        advanced: true,
        next_cursor_revision: nextRevision,
      },
    };
  });
}

async function withHookCursor<T>(
  options: UnreadPeerTurnOptions & {
    readonly onLockReleaseFailure?: (
      error: unknown,
    ) => void | Promise<void>;
  },
  operation: (
    scan: ScopedScan,
  ) => Promise<{ readonly state?: NudgeCursorV2; readonly result: T }>,
): Promise<T | UnreadPeerTurnsUnavailable> {
  const participationStore = new SessionParticipationStore(options.projectRoot);
  const cursorStore = new NudgeCursorStateStore(options.projectRoot);
  const initial = await currentEpoch(participationStore, options);
  if (initial.status !== "ready") return initial;

  for (let attempt = 0; attempt < MAX_MEMBERSHIP_RETRIES; attempt += 1) {
    const result = await cursorStore.withHookWrite<HookCursorTransactionResult<T>>(
      initial.provider,
      initial.sessionId,
      async (current) => {
        const before = await currentEpoch(participationStore, options);
        if (before.status !== "ready") {
          return { result: { kind: "done", value: before } as const };
        }
        const scan = await scanUnread(options, before, current);
        const after = await currentEpoch(participationStore, options);
        if (!sameEpoch(before, after)) {
          return { result: { kind: "retry" } as const };
        }
        const update = await operation(scan);
        return {
          ...(update.state === undefined ? {} : { state: update.state }),
          result: { kind: "done", value: update.result } as const,
        };
      },
      {
        ...(options.onLockReleaseFailure === undefined
          ? {}
          : { onLockReleaseFailure: options.onLockReleaseFailure }),
      },
    );
    if (result.kind === "done") return result.value;
  }
  throw new Error("Barbaro membership changed repeatedly during cursor update");
}

async function scanUnread(
  options: AnyUnreadPeerTurnOptions,
  epoch: MembershipEpoch,
  current: NudgeCursor | undefined,
): Promise<ScopedScan> {
  const cursor = virtualCursor(epoch, current);
  const saved = new Map(
    cursor.state.feed_cursors.map((feed) => [feedKey(feed), feed] as const),
  );
  // Only live canonical feeds belong in the next acknowledged cursor. A feed
  // that vanished can replay conservatively if it later returns; retaining
  // dead entries forever would let session churn grow state without bound.
  const candidate = new Map<string, NudgeFeedCursorV1>();
  let unreadCount = 0;
  let latest: BarbaroTurnV1 | undefined;

  for (const file of await listFeedFiles(options.projectRoot)) {
    if (file.sessionId === epoch.sessionId) continue;
    const prior = saved.get(feedKey(file));
    let scanned: Awaited<ReturnType<typeof scanFeed>>;
    try {
      scanned = await scanFeed(file, prior?.checkpoint, epoch);
    } catch (error: unknown) {
      if (isErrnoCode(error, "ENOENT")) continue;
      throw error;
    }
    candidate.set(feedKey(file), {
      provider: file.provider,
      session_id: file.sessionId,
      checkpoint: scanned.checkpoint,
    });
    unreadCount += scanned.unreadCount;
    if (
      scanned.latest !== undefined &&
      (latest === undefined || compareTurnRecency(scanned.latest, latest) > 0)
    ) {
      latest = scanned.latest;
    }
  }

  const candidateFeedCursors = [...candidate.values()].sort(compareFeedCursors);
  return {
    public: {
      status: "ready",
      provider: epoch.provider,
      session_id: epoch.sessionId,
      workstream_id: epoch.workstreamId,
      membership_from: epoch.from,
      cursor_revision: cursor.state.cursor_revision,
      unread_count: unreadCount,
      ...(latest === undefined
        ? {}
        : { latest: projectUnreadTurn(latest, options.turnByteBudget) }),
    },
    cursor,
    candidateFeedCursors,
  };
}

async function scanFeed(
  file: BarbaroFeedFile,
  checkpoint: JsonlCheckpoint | undefined,
  epoch: MembershipEpoch,
): Promise<{
  readonly checkpoint: JsonlCheckpoint;
  readonly unreadCount: number;
  readonly latest?: BarbaroTurnV1;
}> {
  const safeReadOptions = {
    noFollow: true,
    requireSingleLink: true,
    maxFileBytes: MAX_FEED_BYTES,
  } as const;
  const resolution = await resolveJsonlCheckpoint(
    file.path,
    checkpoint,
    safeReadOptions,
  );
  if (resolution.status === "missing" || resolution.snapshot === undefined) {
    const error = new Error(`Barbaro feed disappeared: ${file.path}`);
    Object.assign(error, { code: "ENOENT" });
    throw error;
  }
  const iterator = iterateJsonlForward<unknown>(file.path, {
    startOffset: resolution.startOffset,
    nextLineNumber: resolution.nextLineNumber,
    endOffset: resolution.snapshot.size,
    ...safeReadOptions,
    maxLineBytes: MAX_RECORD_BYTES,
  });
  let unreadCount = 0;
  let latest: BarbaroTurnV1 | undefined;
  while (true) {
    const result = await iterator.next();
    if (result.done) {
      if (!fileIdentityEquals(result.value.fileIdentity, resolution.snapshot.identity)) {
        throw new Error(`Barbaro feed identity changed during scan: ${file.path}`);
      }
      return {
        checkpoint: createJsonlCheckpoint(result.value),
        unreadCount,
        ...(latest === undefined ? {} : { latest }),
      };
    }
    const line = result.value;
    if (line.kind !== "record" || !isTurnV1(line.value)) continue;
    const turn = line.value;
    if (turn.provider !== file.provider || turn.session_id !== file.sessionId) {
      continue;
    }
    // Membership time is an initialization/move fence. It is deliberately
    // retained on every scan so a late-backfilled pre-membership record does
    // not become news merely because its bytes were appended later.
    if (
      turn.workstream_id !== epoch.workstreamId ||
      Date.parse(turn.ended_at) <= Date.parse(epoch.from)
    ) {
      continue;
    }
    unreadCount += 1;
    if (latest === undefined || compareTurnRecency(turn, latest) > 0) {
      latest = turn;
    }
  }
}

function virtualCursor(
  epoch: MembershipEpoch,
  current: NudgeCursor | undefined,
): VirtualCursor {
  const same =
    current !== undefined &&
    current.workstream_id === epoch.workstreamId &&
    current.membership_from === epoch.from;
  if (same && current.schema === NUDGE_CURSOR_SCHEMA) {
    return { state: current, reset: false, existed: true };
  }
  if (
    same &&
    current !== undefined &&
    current.schema !== NUDGE_CURSOR_SCHEMA
  ) {
    return {
      state: migratedCursor(epoch, current),
      reset: true,
      existed: true,
      legacyMarkers: current.markers,
    };
  }
  const revision = (current?.cursor_revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new RangeError("nudge cursor revision overflow");
  }
  return {
    state: {
      schema: NUDGE_CURSOR_SCHEMA,
      provider: epoch.provider,
      session_id: epoch.sessionId,
      workstream_id: epoch.workstreamId,
      membership_from: epoch.from,
      cursor_revision: revision,
      feed_cursors: [],
      markers: {},
      delivery: { highest_unread_count: 0 },
      ...(epoch.provider === "claude"
        ? {
            claude_turn_generation:
              current?.schema === NUDGE_CURSOR_SCHEMA
                ? current.claude_turn_generation
                : 1,
          }
        : {}),
      // A virtual cursor is not written by observers. Hook writers replace
      // this timestamp before any persisted initialization.
      updated_at: epoch.from,
    },
    reset: current !== undefined,
    existed: current !== undefined,
  };
}

function migratedCursor(
  epoch: MembershipEpoch,
  current: NudgeCursorV1,
): NudgeCursorV2 {
  return {
    schema: NUDGE_CURSOR_SCHEMA,
    provider: current.provider,
    session_id: current.session_id,
    workstream_id: current.workstream_id,
    membership_from: current.membership_from,
    cursor_revision: current.cursor_revision,
    feed_cursors: current.feed_cursors,
    markers: current.markers.stop === current.cursor_revision
      ? { stop: current.cursor_revision }
      : {},
    delivery: { highest_unread_count: 0 },
    ...(epoch.provider === "claude" ? { claude_turn_generation: 1 } : {}),
    updated_at: current.updated_at,
  };
}

async function currentEpoch(
  store: SessionParticipationStore,
  options: AnyUnreadPeerTurnOptions,
): Promise<MembershipEpochResult> {
  const participation = "nativeSessionId" in options
    ? await store.read(options.provider, options.nativeSessionId)
    : await store.readStable(options.provider, options.sessionId);
  if (participation === undefined) return { status: "not_joined" };
  const membership = participationMemberships(participation).at(-1);
  if (membership === undefined) return { status: "workstream_pending" };
  return {
    status: "ready",
    provider: options.provider,
    sessionId: participation.session_id,
    workstreamId: membership.workstream_id,
    from: membership.from,
  };
}

function sameEpoch(
  expected: MembershipEpoch,
  actual: MembershipEpochResult,
): boolean {
  return (
    actual.status === "ready" &&
    actual.provider === expected.provider &&
    actual.sessionId === expected.sessionId &&
    actual.workstreamId === expected.workstreamId &&
    actual.from === expected.from
  );
}

function sameCursorPayload(left: NudgeCursorV2, right: NudgeCursorV2): boolean {
  return stableStringify({
    ...left,
    updated_at: undefined,
  }) === stableStringify({
    ...right,
    updated_at: undefined,
  });
}

/** Ignore marker/timestamp churn; retry only when what counts as read moved. */
function sameLogicalCursor(
  left: NudgeCursor | undefined,
  right: NudgeCursor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableStringify({
    provider: left.provider,
    session_id: left.session_id,
    workstream_id: left.workstream_id,
    membership_from: left.membership_from,
    cursor_revision: left.cursor_revision,
    feed_cursors: left.feed_cursors,
  }) === stableStringify({
    provider: right.provider,
    session_id: right.session_id,
    workstream_id: right.workstream_id,
    membership_from: right.membership_from,
    cursor_revision: right.cursor_revision,
    feed_cursors: right.feed_cursors,
  });
}

function establishClaimTurn(
  cursor: VirtualCursor,
  turn: HookNudgeTurn,
): NudgeCursorV2 {
  const state = cursor.state;
  if (turn.kind === "codex") return state;
  const generation = state.claude_turn_generation;
  if (generation === undefined) {
    throw new TypeError("Claude nudge cursor generation is missing");
  }
  if (turn.phase !== "begin" || !cursor.existed) return state;
  const nextGeneration = generation + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    throw new RangeError("Claude nudge cursor generation overflow");
  }
  return { ...state, claude_turn_generation: nextGeneration };
}

function currentDeliveryTurn(
  state: NudgeCursorV2,
  turn: HookNudgeTurn,
): NudgeDeliveryTurnV2 {
  if (turn.kind === "codex") {
    return { kind: "codex", turn_id: turn.turn_id };
  }
  const generation = state.claude_turn_generation;
  if (generation === undefined) {
    throw new TypeError("Claude nudge cursor generation is missing");
  }
  return { kind: "claude", generation };
}

function deliveryTurnsEqual(
  left: NudgeDeliveryTurnV2 | undefined,
  right: NudgeDeliveryTurnV2,
): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  if (left.kind === "codex" && right.kind === "codex") {
    return left.turn_id === right.turn_id;
  }
  return left.kind === "claude" &&
    right.kind === "claude" &&
    left.generation === right.generation;
}

function withUpdatedAt(state: NudgeCursorV2, updatedAt: string): NudgeCursorV2 {
  return { ...state, updated_at: updatedAt };
}

function projectUnreadTurn(
  turn: BarbaroTurnV1,
  requestedBudget: number | undefined,
): UnreadPeerTurn {
  const budget = requestedBudget ?? DEFAULT_TURN_BYTE_BUDGET;
  let projection;
  try {
    projection = projectTurn(turn, { byteBudget: budget });
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) throw error;
    projection = projectTurn(turn, { byteBudget: FALLBACK_TURN_BYTE_BUDGET });
  }
  return {
    provider: turn.provider,
    session_id: turn.session_id,
    turn: projection,
  };
}

function compareTurnRecency(left: BarbaroTurnV1, right: BarbaroTurnV1): number {
  return (
    Date.parse(left.ended_at) - Date.parse(right.ended_at) ||
    left.sequence - right.sequence ||
    compareUtf16CodeUnits(left.turn_id, right.turn_id)
  );
}

function compareFeedCursors(
  left: NudgeFeedCursorV1,
  right: NudgeFeedCursorV1,
): number {
  return compareUtf16CodeUnits(feedKey(left), feedKey(right));
}

function feedKey(feed: {
  readonly provider: string;
  readonly sessionId?: string;
  readonly session_id?: string;
}): string {
  return `${feed.provider}/${feed.sessionId ?? feed.session_id ?? ""}`;
}

function validateOptions(options: AnyUnreadPeerTurnOptions): void {
  if (options.projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  if ("nativeSessionId" in options && "sessionId" in options) {
    throw new TypeError(
      "nativeSessionId and sessionId are mutually exclusive unread identities",
    );
  }
  if ("nativeSessionId" in options) {
    if (options.nativeSessionId.length === 0) {
      throw new TypeError("nativeSessionId must not be empty");
    }
  } else if (!/^ses_[0-9a-f]{32}$/u.test(options.sessionId)) {
    throw new TypeError("sessionId must be a stable ses_<32 hex> session id");
  }
  if (
    options.turnByteBudget !== undefined &&
    (!Number.isSafeInteger(options.turnByteBudget) || options.turnByteBudget <= 0)
  ) {
    throw new TypeError("turnByteBudget must be a positive safe integer");
  }
}

function validateHookTurn(
  provider: ParticipatingProvider,
  turn: HookNudgeTurn,
): void {
  if (provider !== turn.kind) {
    throw new TypeError("nudge turn identity does not match its provider");
  }
  if (
    turn.kind === "codex" &&
    !/^turn_[0-9a-f]{32}$/u.test(turn.turn_id)
  ) {
    throw new TypeError("Codex nudge turn id is invalid");
  }
  if (
    turn.kind === "claude" &&
    turn.phase !== "begin" &&
    turn.phase !== "current"
  ) {
    throw new TypeError("Claude nudge turn phase is invalid");
  }
}

function checkedTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be valid");
  return now.toISOString();
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
