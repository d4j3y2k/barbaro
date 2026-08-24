import type { IncidentKind } from "../hooks/incidents.js";
import type { ReaderProjection, ReaderTurnSummary } from "../reader/types.js";

export const WATCH_EVENT_SCHEMA = "barbaro.watch.event.v1" as const;

/**
 * The Monitor description a session uses when it arms a peer watcher.
 *
 * This string is load-bearing: a monitor wake-up is republished as that
 * session's next turn, request text included, so the description is the one
 * durable trace that a turn was caused by a watcher rather than a person.
 * Every watcher suppresses peer turns carrying it — the only thing standing
 * between two armed watchers and an infinite wake/reply echo. Renaming it
 * desynchronizes deployed watchers from the sessions they watch.
 */
export const WATCH_WAKE_MARKER =
  "barbaro peers: turns, joins, incidents, stale leases";

export const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** Byte budget for the bounded projection carried by each turn event. */
export const DEFAULT_WATCH_TURN_BYTE_BUDGET = 4_096;

/** Consecutive failed polls before a watching process should give up. */
export const WATCH_MAX_CONSECUTIVE_ERRORS = 5;

interface WatchEventBase {
  readonly schema: typeof WATCH_EVENT_SCHEMA;
  readonly observed_at: string;
}

/**
 * Emitted once after the baseline scan. Enrollment is forever; presence is
 * not. Both counts are reported so an armed watcher never implies that every
 * session ever enrolled is still listening.
 */
export interface WatchArmedEvent extends WatchEventBase {
  readonly kind: "armed";
  readonly live_sessions: number;
  readonly enrolled_sessions: number;
  readonly self_session_id?: string;
  /**
   * Present when the watcher is scoped to one workstream: counts above are
   * then that workstream's, and turn/join/stale events from sessions outside
   * it are not delivered.
   */
  readonly workstream_id?: string;
}

/** A peer completed a turn. The payload is a bounded reader projection. */
export interface WatchTurnEvent extends WatchEventBase {
  readonly kind: "turn";
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly turn: ReaderProjection<ReaderTurnSummary>;
}

/** A session enrolled or moved into its current workstream. */
export interface WatchJoinEvent extends WatchEventBase {
  readonly kind: "join";
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly joined_at: string;
  readonly initiated_by: "user_prompt";
}

/** A fresh incident marker appeared. The id is the marker's dedup digest. */
export interface WatchIncidentEvent extends WatchEventBase {
  readonly kind: "incident";
  readonly provider: string;
  readonly incident_id: string;
  readonly incident_kind: IncidentKind;
  readonly event?: string;
  readonly workstream_id?: string;
  readonly occurred_at: string;
}

/**
 * A lease this watcher saw live expired without renewal while still holding
 * work. That means nothing has renewed the claim — not necessarily that the
 * session crashed; a paused laptop or a stalled hook looks identical. The
 * fields deliberately stay within the compact lease list: intent text is
 * never carried on a watch event.
 */
export interface WatchStaleEvent extends WatchEventBase {
  readonly kind: "stale";
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly agent_id: string;
  readonly last_state: "working" | "waiting" | "blocked";
  readonly updated_at: string;
  readonly expires_at: string;
  readonly lapsed_ms: number;
  readonly claims: number;
  readonly unknown_write_scope: boolean;
  readonly current_action?: {
    readonly kind: "file_change" | "command" | "test" | "tool" | "other";
    readonly tool_name?: string;
  };
}

/** A poll failed. The stream survives until the consecutive limit is hit. */
export interface WatchErrorEvent extends WatchEventBase {
  readonly kind: "error";
  readonly message: string;
  readonly consecutive: number;
  readonly limit: number;
}

export type WatchEvent =
  | WatchArmedEvent
  | WatchTurnEvent
  | WatchJoinEvent
  | WatchIncidentEvent
  | WatchStaleEvent
  | WatchErrorEvent;
