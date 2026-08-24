import { resolve } from "node:path";

import {
  validateJsonlCheckpoint,
  type JsonlCheckpoint,
} from "../core/checkpoint.js";
import { writeJsonFileAtomically } from "../core/atomic-json.js";
import { SafeStoreBoundary } from "../core/safe-store.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";
import {
  DirectoryLockReleaseError,
  withDirectoryLock,
} from "../output/directory-lock.js";

import {
  NUDGE_CURSOR_SCHEMA,
  NUDGE_CURSOR_SCHEMA_V1,
  NUDGE_MARKER_KINDS,
  type NudgeCursor,
  type NudgeCursorV1,
  type NudgeCursorV2,
  type NudgeDeliveryTurnV2,
  type NudgeFeedCursorV1,
  type NudgeMarkersV1,
  type NudgeMarkersV2,
} from "./types.js";

const MAX_CURSOR_BYTES = 1024 * 1024;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/u;

export class InvalidNudgeCursorError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid Barbaro nudge cursor at ${path}: ${detail}`, { cause });
    this.name = "InvalidNudgeCursorError";
    this.path = path;
  }
}

export class NudgeCursorTooLargeError extends RangeError {
  readonly maximumBytes = MAX_CURSOR_BYTES;

  constructor() {
    super(`Barbaro nudge cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
    this.name = "NudgeCursorTooLargeError";
  }
}

export interface HookCursorUpdate<T> {
  /** Omit to leave the cursor byte-for-byte untouched. */
  readonly state?: NudgeCursorV2;
  readonly result: T;
}

export interface HookCursorWriteOptions {
  /** Observe cleanup failure after a cursor replacement was committed. */
  readonly onLockReleaseFailure?: (
    error: unknown,
  ) => void | Promise<void>;
}

/**
 * Filesystem boundary for hook-owned cursor state. The public read is pure;
 * the mutating transaction is named for hooks so observer code has no reason
 * to import it.
 */
export class NudgeCursorStateStore {
  readonly projectRoot: string;
  readonly #boundary: SafeStoreBoundary;

  constructor(projectRoot: string) {
    if (projectRoot.length === 0) {
      throw new TypeError("projectRoot must not be empty");
    }
    this.projectRoot = resolve(projectRoot);
    this.#boundary = SafeStoreBoundary.forBarbaroProject(this.projectRoot);
  }

  cursorPath(provider: string, sessionId: string): string {
    return this.#boundary.pathFor(cursorComponents(provider, sessionId));
  }

  /** Read a complete, path-bound cursor without creating any directory. */
  async read(
    provider: string,
    sessionId: string,
  ): Promise<NudgeCursor | undefined> {
    const components = cursorComponents(provider, sessionId);
    const path = this.#boundary.pathFor(components);
    const text = await this.#boundary.readUtf8File(
      components,
      MAX_CURSOR_BYTES,
    );
    if (text === undefined) return undefined;
    try {
      return parseCursor(text, provider, sessionId);
    } catch (error: unknown) {
      throw new InvalidNudgeCursorError(path, error);
    }
  }

  /** Atomic hook-only read/decide/replace transaction for one actor cursor. */
  async withHookWrite<T>(
    provider: string,
    sessionId: string,
    operation: (
      current: NudgeCursor | undefined,
    ) => Promise<HookCursorUpdate<T>>,
    options: HookCursorWriteOptions = {},
  ): Promise<T> {
    if (
      options.onLockReleaseFailure !== undefined &&
      typeof options.onLockReleaseFailure !== "function"
    ) {
      throw new TypeError("onLockReleaseFailure must be a function");
    }
    const components = cursorComponents(provider, sessionId);
    const target = this.#boundary.pathFor(components);
    try {
      return await withDirectoryLock(target, async () => {
        const update = await operation(await this.read(provider, sessionId));
        if (update.state !== undefined) {
          assertCursorIdentity(update.state, provider, sessionId);
          if (
            Buffer.byteLength(`${stableStringify(update.state)}\n`, "utf8") >
            MAX_CURSOR_BYTES
          ) {
            throw new NudgeCursorTooLargeError();
          }
          await writeJsonFileAtomically(
            this.#boundary,
            components,
            update.state,
          );
        }
        return update.result;
      });
    } catch (error: unknown) {
      if (
        error instanceof DirectoryLockReleaseError &&
        error.resourcePath === target &&
        options.onLockReleaseFailure !== undefined
      ) {
        const observer = options.onLockReleaseFailure;
        void Promise.resolve()
          .then(() => observer(error.releaseError))
          .catch(() => undefined);
        return error.result as T;
      }
      throw error;
    }
  }
}

function cursorComponents(
  provider: string,
  sessionId: string,
): readonly string[] {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new TypeError(`Invalid provider: ${JSON.stringify(provider)}`);
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(`Invalid session_id: ${JSON.stringify(sessionId)}`);
  }
  return ["state", "nudge", provider, `${sessionId}.json`];
}

function parseCursor(
  text: string,
  expectedProvider: string,
  expectedSessionId: string,
): NudgeCursor {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) {
    throw new TypeError("unsupported or invalid nudge cursor schema");
  }
  if (value.schema === NUDGE_CURSOR_SCHEMA_V1) {
    return parseCursorV1(value, expectedProvider, expectedSessionId);
  }
  if (value.schema === NUDGE_CURSOR_SCHEMA) {
    return parseCursorV2(value, expectedProvider, expectedSessionId);
  }
  throw new TypeError("unsupported or invalid nudge cursor schema");
}

function parseCursorV1(
  value: Record<string, unknown>,
  expectedProvider: string,
  expectedSessionId: string,
): NudgeCursorV1 {
  const base = parseCursorBase(value, expectedProvider, expectedSessionId, [
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
  const markers = parseMarkersV1(value.markers, base.cursor_revision);
  return {
    schema: NUDGE_CURSOR_SCHEMA_V1,
    ...base,
    markers,
  };
}

function parseCursorV2(
  value: Record<string, unknown>,
  expectedProvider: string,
  expectedSessionId: string,
): NudgeCursorV2 {
  const base = parseCursorBase(value, expectedProvider, expectedSessionId, [
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
  if (expectedProvider !== "codex" && expectedProvider !== "claude") {
    throw new TypeError("nudge cursor v2 provider is unsupported");
  }
  const markers = parseMarkersV2(value.markers, base.cursor_revision);
  const claudeTurnGeneration = value.claude_turn_generation;
  if (expectedProvider === "claude") {
    if (!isPositiveSafeInteger(claudeTurnGeneration)) {
      throw new TypeError("Claude nudge cursor generation is invalid");
    }
  } else if (claudeTurnGeneration !== undefined) {
    throw new TypeError("Codex nudge cursor cannot carry a Claude generation");
  }
  const delivery = parseDelivery(
    value.delivery,
    expectedProvider,
    typeof claudeTurnGeneration === "number"
      ? claudeTurnGeneration
      : undefined,
  );
  return {
    schema: NUDGE_CURSOR_SCHEMA,
    ...base,
    markers,
    delivery,
    ...(expectedProvider === "claude"
      ? { claude_turn_generation: claudeTurnGeneration as number }
      : {}),
  };
}

interface ParsedCursorBase {
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
  readonly cursor_revision: number;
  readonly feed_cursors: readonly NudgeFeedCursorV1[];
  readonly updated_at: string;
}

function parseCursorBase(
  value: Record<string, unknown>,
  expectedProvider: string,
  expectedSessionId: string,
  allowedKeys: readonly string[],
): ParsedCursorBase {
  assertAllowedKeys(value, allowedKeys);
  if (
    value.provider !== expectedProvider ||
    value.session_id !== expectedSessionId
  ) {
    throw new TypeError("nudge cursor identity does not match its storage path");
  }
  if (
    !PROVIDER_PATTERN.test(expectedProvider) ||
    !SESSION_ID_PATTERN.test(expectedSessionId) ||
    typeof value.workstream_id !== "string" ||
    !WORKSTREAM_ID_PATTERN.test(value.workstream_id) ||
    typeof value.membership_from !== "string" ||
    !Number.isFinite(Date.parse(value.membership_from)) ||
    !isPositiveSafeInteger(value.cursor_revision) ||
    typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at))
  ) {
    throw new TypeError("nudge cursor is structurally invalid");
  }
  if (!Array.isArray(value.feed_cursors)) {
    throw new TypeError("nudge cursor feed_cursors must be an array");
  }
  const feedCursors: NudgeFeedCursorV1[] = [];
  let priorKey: string | undefined;
  for (const candidate of value.feed_cursors) {
    if (
      !isObject(candidate) ||
      typeof candidate.provider !== "string" ||
      !PROVIDER_PATTERN.test(candidate.provider) ||
      typeof candidate.session_id !== "string" ||
      !SESSION_ID_PATTERN.test(candidate.session_id) ||
      !isObject(candidate.checkpoint)
    ) {
      throw new TypeError("nudge cursor contains an invalid feed cursor");
    }
    assertAllowedKeys(candidate, ["provider", "session_id", "checkpoint"]);
    assertCheckpointKeys(candidate.checkpoint);
    validateJsonlCheckpoint(candidate.checkpoint as unknown as JsonlCheckpoint);
    const key = feedKey(candidate.provider, candidate.session_id);
    if (priorKey !== undefined && compareUtf16CodeUnits(priorKey, key) >= 0) {
      throw new TypeError("nudge cursor feeds must be unique and sorted");
    }
    priorKey = key;
    feedCursors.push({
      provider: candidate.provider,
      session_id: candidate.session_id,
      checkpoint: candidate.checkpoint as unknown as JsonlCheckpoint,
    });
  }
  return {
    provider: expectedProvider,
    session_id: expectedSessionId,
    workstream_id: value.workstream_id,
    membership_from: value.membership_from,
    cursor_revision: value.cursor_revision,
    feed_cursors: feedCursors,
    updated_at: value.updated_at,
  };
}

function parseMarkersV1(value: unknown, revision: number): NudgeMarkersV1 {
  if (!isObject(value)) {
    throw new TypeError("nudge cursor markers must be an object");
  }
  assertAllowedKeys(value, NUDGE_MARKER_KINDS);
  const markers: {
    user_prompt?: number;
    tool_boundary?: number;
    stop?: number;
  } = {};
  for (const kind of NUDGE_MARKER_KINDS) {
    const marker = value[kind];
    if (marker === undefined) continue;
    if (!isPositiveSafeInteger(marker) || marker !== revision) {
      throw new TypeError(`nudge cursor ${kind} marker is invalid`);
    }
    markers[kind] = marker;
  }
  return markers;
}

function parseMarkersV2(value: unknown, revision: number): NudgeMarkersV2 {
  if (!isObject(value)) {
    throw new TypeError("nudge cursor markers must be an object");
  }
  assertAllowedKeys(value, ["stop"]);
  const marker = value.stop;
  if (marker === undefined) return {};
  if (!isPositiveSafeInteger(marker) || marker !== revision) {
    throw new TypeError("nudge cursor stop marker is invalid");
  }
  return { stop: marker };
}

function parseDelivery(
  value: unknown,
  provider: "codex" | "claude",
  claudeTurnGeneration: number | undefined,
): NudgeCursorV2["delivery"] {
  if (!isObject(value)) {
    throw new TypeError("nudge cursor delivery must be an object");
  }
  assertAllowedKeys(value, ["highest_unread_count", "last_turn"]);
  if (!isNonnegativeSafeInteger(value.highest_unread_count)) {
    throw new TypeError("nudge cursor delivery high-water is invalid");
  }
  const lastTurn = value.last_turn === undefined
    ? undefined
    : parseDeliveryTurn(value.last_turn, provider, claudeTurnGeneration);
  if (lastTurn !== undefined && value.highest_unread_count === 0) {
    throw new TypeError("nudge cursor delivery turn requires an announcement");
  }
  return {
    highest_unread_count: value.highest_unread_count,
    ...(lastTurn === undefined ? {} : { last_turn: lastTurn }),
  };
}

function parseDeliveryTurn(
  value: unknown,
  provider: "codex" | "claude",
  claudeTurnGeneration: number | undefined,
): NudgeDeliveryTurnV2 {
  if (!isObject(value)) {
    throw new TypeError("nudge cursor delivery turn must be an object");
  }
  if (provider === "codex") {
    assertAllowedKeys(value, ["kind", "turn_id"]);
    if (
      value.kind !== "codex" ||
      typeof value.turn_id !== "string" ||
      !TURN_ID_PATTERN.test(value.turn_id)
    ) {
      throw new TypeError("Codex nudge cursor delivery turn is invalid");
    }
    return { kind: "codex", turn_id: value.turn_id };
  }
  assertAllowedKeys(value, ["kind", "generation"]);
  if (
    value.kind !== "claude" ||
    !isPositiveSafeInteger(value.generation) ||
    claudeTurnGeneration === undefined ||
    value.generation > claudeTurnGeneration
  ) {
    throw new TypeError("Claude nudge cursor delivery turn is invalid");
  }
  return { kind: "claude", generation: value.generation };
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
    throw new TypeError("nudge cursor checkpoint is structurally invalid");
  }
  assertAllowedKeys(checkpoint.file_identity, [
    "device",
    "inode",
    "birthtime_ns",
  ]);
  assertAllowedKeys(checkpoint.anchor, ["byte_length", "sha256"]);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      throw new TypeError(`unexpected nudge cursor field: ${key}`);
    }
  }
}

function assertCursorIdentity(
  cursor: NudgeCursorV2,
  provider: string,
  sessionId: string,
): void {
  if (cursor.provider !== provider || cursor.session_id !== sessionId) {
    throw new TypeError("nudge cursor writer changed the path-bound identity");
  }
  // Run the same strict validator before serializing hook-owned state.
  const parsed = parseCursor(JSON.stringify(cursor), provider, sessionId);
  if (parsed.schema !== NUDGE_CURSOR_SCHEMA) {
    throw new TypeError("hook writers may persist only nudge cursor v2");
  }
}

function feedKey(provider: string, sessionId: string): string {
  return `${provider}/${sessionId}`;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
