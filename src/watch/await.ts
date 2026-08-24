import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
} from "../core/barbaro-command.js";
import type { ParticipatingProvider } from "../hooks/participation.js";
import {
  NudgeCursorStateStore,
  inspectUnreadPeerTurns,
  type UnreadPeerTurns,
  type UnreadPeerTurnsReady,
} from "../nudge/index.js";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  WATCH_MAX_CONSECUTIVE_ERRORS,
} from "./types.js";

export const AWAIT_TIMEOUT_SCHEMA = "barbaro.await.v1" as const;
export {
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
} from "../core/barbaro-command.js";

export interface AwaitTimeoutEvent {
  readonly schema: typeof AWAIT_TIMEOUT_SCHEMA;
  readonly kind: "timeout";
  readonly timeout_ms: number;
}

/** Read-only notice that the session's hook-owned cursor has peer news. */
export interface AwaitUnreadEvent {
  readonly schema: typeof AWAIT_TIMEOUT_SCHEMA;
  readonly kind: "unread";
  readonly provider: ParticipatingProvider;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly cursor_revision: number;
  readonly unread_count: number;
}

export type AwaitResult = AwaitUnreadEvent | AwaitTimeoutEvent;

/** A real await failure after the cursor/feed stores could not be scanned repeatedly. */
export class AwaitScanFailureLimitError extends Error {
  override readonly name = "AwaitScanFailureLimitError";

  constructor(options: { readonly cause?: unknown } = {}) {
    super("barbaro await: too many consecutive scan failures", options);
  }
}

/** The joined session disappeared or has not selected a workstream. */
export class AwaitCursorUnavailableError extends Error {
  override readonly name = "AwaitCursorUnavailableError";

  constructor(status: Exclude<UnreadPeerTurns["status"], "ready">) {
    super(
      status === "not_joined"
        ? "barbaro await: session has not joined Barbaro"
        : "barbaro await: session has no workstream cursor",
    );
  }
}

/** Await cannot reinterpret one membership epoch's cursor as another's. */
export class AwaitCursorScopeError extends Error {
  override readonly name = "AwaitCursorScopeError";

  constructor() {
    super("barbaro await: cursor belongs to a different workstream membership");
  }
}

export interface AwaitCursorOptions {
  readonly projectRoot: string;
  readonly provider: ParticipatingProvider;
  /** Stable Barbaro session id, resolved from an enrolled CLI identity. */
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly membershipFrom: string;
}

export interface AwaitOptions extends AwaitCursorOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Test seams for deterministic waiting; production uses the cursor reader. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly inspect?: () => Promise<UnreadPeerTurns>;
}

/**
 * Wait once for peer turns newer than a joined session's persistent read
 * cursor. The first scan happens before any sleep, so a turn published before
 * the command starts is news rather than a swallowed baseline. The cursor and
 * canonical feeds are observed only; two concurrent waiters therefore see
 * the same unread result and neither can consume it.
 */
export async function awaitUnreadPeerTurns(
  options: AwaitOptions,
): Promise<AwaitResult> {
  validateAwaitOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  requirePositiveSafeInteger(timeoutMs, "timeoutMs");
  requirePositiveSafeInteger(intervalMs, "intervalMs");
  if (timeoutMs > MAX_AWAIT_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_AWAIT_TIMEOUT_MS}`);
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const started = now();
  if (!Number.isFinite(started)) {
    throw new TypeError("now must return a finite number");
  }
  const deadline = started + timeoutMs;
  const cursorStore = new NudgeCursorStateStore(options.projectRoot);
  const inspect = options.inspect ?? (() => inspectBoundCursor(options, cursorStore));
  let consecutiveErrors = 0;

  while (true) {
    let scannedReady = false;
    try {
      const unread = await inspect();
      if (unread.status !== "ready") {
        throw new AwaitCursorUnavailableError(unread.status);
      }
      assertExpectedEpoch(unread, options);
      consecutiveErrors = 0;
      scannedReady = true;
      if (unread.unread_count > 0) return unreadEvent(unread, options.provider);
    } catch (error: unknown) {
      if (
        error instanceof AwaitCursorUnavailableError ||
        error instanceof AwaitCursorScopeError
      ) {
        throw error;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= WATCH_MAX_CONSECUTIVE_ERRORS) {
        throw new AwaitScanFailureLimitError({ cause: error });
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      // A timeout is evidence that a ready cursor was scanned and had no
      // unread turns. Never turn repeated corruption/IO failures into exit 0.
      if (!scannedReady) continue;
      return {
        schema: AWAIT_TIMEOUT_SCHEMA,
        kind: "timeout",
        timeout_ms: timeoutMs,
      };
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

async function inspectBoundCursor(
  options: AwaitCursorOptions,
  cursorStore: NudgeCursorStateStore,
): Promise<UnreadPeerTurns> {
  const cursor = await cursorStore.read(options.provider, options.sessionId);
  if (
    cursor !== undefined &&
    (cursor.workstream_id !== options.workstreamId ||
      cursor.membership_from !== options.membershipFrom)
  ) {
    throw new AwaitCursorScopeError();
  }
  return inspectUnreadPeerTurns({
    projectRoot: options.projectRoot,
    provider: options.provider,
    sessionId: options.sessionId,
  });
}

function assertExpectedEpoch(
  unread: UnreadPeerTurnsReady,
  options: AwaitCursorOptions,
): void {
  if (
    unread.provider !== options.provider ||
    unread.session_id !== options.sessionId ||
    unread.workstream_id !== options.workstreamId ||
    unread.membership_from !== options.membershipFrom
  ) {
    throw new AwaitCursorScopeError();
  }
}

function unreadEvent(
  unread: UnreadPeerTurnsReady,
  provider: ParticipatingProvider,
): AwaitUnreadEvent {
  return {
    schema: AWAIT_TIMEOUT_SCHEMA,
    kind: "unread",
    provider,
    session_id: unread.session_id,
    workstream_id: unread.workstream_id,
    cursor_revision: unread.cursor_revision,
    unread_count: unread.unread_count,
  };
}

/** The exact plain-text unread notice emitted by `barbaro await`. */
export function formatAwaitUnread(event: AwaitUnreadEvent): string {
  return `${event.unread_count} unread — run barbaro context`;
}

/** The exact plain-text timeout record emitted by `barbaro await`. */
export function formatAwaitTimeout(event: AwaitTimeoutEvent): string {
  return `AWAIT timeout after ${event.timeout_ms} ms — no peer event`;
}

function validateAwaitOptions(options: AwaitCursorOptions): void {
  if (options.projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  if (options.provider !== "claude" && options.provider !== "codex") {
    throw new TypeError(`Unknown provider: ${String(options.provider)}`);
  }
  if (!/^ses_[0-9a-f]{32}$/u.test(options.sessionId)) {
    throw new TypeError("sessionId must be a stable ses_<32 hex> session id");
  }
  if (!/^ws_[0-9a-f]{32}$/u.test(options.workstreamId)) {
    throw new TypeError("workstreamId must be a stable ws_<32 hex> id");
  }
  if (!Number.isFinite(Date.parse(options.membershipFrom))) {
    throw new TypeError("membershipFrom must be a valid date-time");
  }
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}
