import type { JsonlCheckpoint } from "../core/checkpoint.js";
import type { FeedReadCoverage } from "../core/feed-availability.js";
import type { NudgeReadState } from "./read-state.js";
import type {
  ReaderProjection,
  ReaderTurnSummary,
} from "../reader/types.js";

export const NUDGE_CURSOR_SCHEMA_V1 = "barbaro.nudge-cursor.v1" as const;
export const NUDGE_CURSOR_SCHEMA_V2 = "barbaro.nudge-cursor.v2" as const;
export const NUDGE_CURSOR_SCHEMA = "barbaro.nudge-cursor.v3" as const;

/** Model-visible delivery channels sharing one revision-wide announcement ledger. */
export const NUDGE_MARKER_KINDS = [
  "user_prompt",
  "tool_boundary",
  "stop",
] as const;
export type NudgeMarkerKind = (typeof NUDGE_MARKER_KINDS)[number];

export interface NudgeFeedCursorV1 {
  readonly provider: string;
  readonly session_id: string;
  /** First byte beyond the acknowledged contiguous prefix of this feed. */
  readonly checkpoint: JsonlCheckpoint;
}

export interface NudgeMarkersV1 {
  readonly user_prompt?: number;
  readonly tool_boundary?: number;
  readonly stop?: number;
}

/**
 * Hook-owned, per-session read cursor. Readers may inspect this record but
 * only synchronous provider hooks may replace it.
 */
export interface NudgeCursorV1 {
  readonly schema: typeof NUDGE_CURSOR_SCHEMA_V1;
  readonly provider: string;
  /** Stable Barbaro session id, never the provider-native id. */
  readonly session_id: string;
  readonly workstream_id: string;
  /** `from` on the current, last participation membership. */
  readonly membership_from: string;
  /** Advances only when the logical read cursor is cleared or re-fenced. */
  readonly cursor_revision: number;
  readonly feed_cursors: readonly NudgeFeedCursorV1[];
  /** Each value, when present, equals the revision claimed for that channel. */
  readonly markers: NudgeMarkersV1;
  readonly updated_at: string;
}

/** V2 keeps only the once-per-revision Stop latch in `markers`. */
export interface NudgeMarkersV2 {
  readonly stop?: number;
}

/** Exact hook turn that most recently received a model-visible delivery. */
export type NudgeDeliveryTurnV2 =
  | {
      readonly kind: "codex";
      readonly turn_id: string;
    }
  | {
      readonly kind: "claude";
      readonly generation: number;
    };

export interface NudgeDeliveryV2 {
  /** Highest unread count announced by any channel at this cursor revision. */
  readonly highest_unread_count: number;
  readonly last_turn?: NudgeDeliveryTurnV2;
}

/** In-lock receipt used only to undo a Stop claim whose lease write failed. */
export interface HookStopClaimRollback {
  readonly provider: "codex" | "claude";
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
  readonly cursor_revision: number;
  readonly before: NudgeDeliveryV2;
  readonly claimed: NudgeDeliveryV2;
}

/**
 * Hook-owned v2 cursor. The announcement high-water is the sole source of
 * truth for informational delivery; `markers.stop` is only the Stop latch.
 */
export interface NudgeCursorV2 {
  readonly schema: typeof NUDGE_CURSOR_SCHEMA_V2;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
  readonly cursor_revision: number;
  readonly feed_cursors: readonly NudgeFeedCursorV1[];
  readonly markers: NudgeMarkersV2;
  readonly delivery: NudgeDeliveryV2;
  /**
   * Positive, cursor-owned logical turn generation for Claude, which exposes
   * no provider turn id. Present only for Claude and monotonic across reads.
   */
  readonly claude_turn_generation?: number;
  readonly updated_at: string;
}

export interface NudgeCursorV3 extends Omit<NudgeCursorV2, "schema"> {
  readonly schema: typeof NUDGE_CURSOR_SCHEMA;
  readonly reads: NudgeReadState;
}

export type NudgeCursor = NudgeCursorV1 | NudgeCursorV2 | NudgeCursorV3;

/** Provider turn evidence supplied by the admitted main-agent hook. */
export type HookNudgeTurn =
  | {
      readonly kind: "codex";
      readonly turn_id: string;
    }
  | {
      readonly kind: "claude";
      readonly phase: "begin" | "current";
    }
  | {
      readonly kind: "claude";
      /** Actor-locked evidence; valid only in this exact membership epoch. */
      readonly phase: "queued";
      readonly workstream_id: string;
      readonly membership_from: string;
    };

export interface UnreadPeerTurn {
  readonly provider: string;
  readonly session_id: string;
  readonly turn: ReaderProjection<ReaderTurnSummary>;
}

export interface UnreadPeerTurnsReady {
  readonly status: "ready";
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
  readonly cursor_revision: number;
  readonly unread_count: number;
  /** Present when the count is only a lower bound because feeds are unavailable. */
  readonly coverage?: FeedReadCoverage;
  /** Remaining gaps after a delivered context/page window; absent when false. */
  readonly outside_delivered_window?: true;
  readonly latest?: UnreadPeerTurn;
}

export interface UnreadPeerTurnsUnavailable {
  readonly status: "not_joined" | "workstream_pending";
}

/** A read-only projection used by nudges and the cursor-based await command. */
export type UnreadPeerTurns =
  | UnreadPeerTurnsReady
  | UnreadPeerTurnsUnavailable;

export interface HookNudgeClaimReady extends UnreadPeerTurnsReady {
  readonly marker: NudgeMarkerKind;
  readonly claimed: boolean;
  /** Present only for a successfully claimed Stop delivery. */
  readonly stop_rollback?: HookStopClaimRollback;
}

/** Fast-path result: the once-per-revision Stop latch is already claimed. */
export interface HookNudgeAlreadyClaimed {
  readonly status: "already_claimed";
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
  readonly cursor_revision: number;
  readonly marker: NudgeMarkerKind;
}

export type HookNudgeClaim =
  | HookNudgeClaimReady
  | HookNudgeAlreadyClaimed
  | UnreadPeerTurnsUnavailable;
