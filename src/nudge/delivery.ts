import { truncateUtf8 } from "../core/content.js";
import { readContextGuidance, readGapGuidance } from "./read-guidance.js";

import { claimHookNudge } from "./unread.js";
import type {
  HookNudgeClaimOptions,
} from "./unread.js";
import type {
  HookNudgeClaimReady,
  HookStopClaimRollback,
  NudgeMarkerKind,
} from "./types.js";

const LATEST_TURN_EXCERPT_BYTES = 320;
const STOP_RESPONSE_EXCERPT_BYTES = 1_024;

export interface HookNudgeDelivery {
  readonly marker: NudgeMarkerKind;
  readonly cursor_revision: number;
  readonly unread_count: number;
  readonly text: string;
  /** Stop-only receipt for compensating a later active-write failure. */
  readonly stop_rollback?: HookStopClaimRollback;
}

/** Claim one delivery channel and render its model-visible one-line nudge. */
export async function claimHookNudgeDelivery(
  options: HookNudgeClaimOptions,
): Promise<HookNudgeDelivery | undefined> {
  const claim = await claimHookNudge(options);
  if (claim.status !== "ready" || !claim.claimed) return undefined;
  return deliveryFromClaim(claim);
}

export function deliveryFromClaim(
  claim: HookNudgeClaimReady,
): HookNudgeDelivery {
  if (!claim.claimed || claim.unread_count <= 0) {
    throw new TypeError("a nudge delivery requires a claimed unread turn");
  }
  const latest = claim.latest?.turn.value;
  const source = latest === undefined
    ? "peer"
    : `${latest.provider}/${latest.agent_id}`;
  const rawExcerpt =
    latest?.response?.text ?? latest?.request.text ?? "new peer activity";
  const excerpt = boundedOneLine(rawExcerpt, LATEST_TURN_EXCERPT_BYTES);
  const noun = claim.unread_count === 1 ? "turn" : "turns";
  const outside = claim.outside_delivered_window === true;
  const guidance = outside ? readGapGuidance(claim.provider, claim.session_id, claim.workstream_id)
    : readContextGuidance(claim.provider, claim.session_id, claim.workstream_id);
  return {
    marker: claim.marker,
    cursor_revision: claim.cursor_revision,
    unread_count: claim.unread_count,
    ...(claim.stop_rollback === undefined
      ? {}
      : { stop_rollback: claim.stop_rollback }),
    text:
      `Barbaro: ${claim.coverage?.state === "incomplete" ? "at least " : ""}${claim.unread_count} ${outside ? `unread peer ${noun} ${claim.unread_count === 1 ? "remains" : "remain"} outside the delivered window` : `new peer ${noun}`}${claim.coverage?.state === "incomplete" ? ` (coverage incomplete: ${claim.coverage.unavailable.total} feeds unavailable)` : ""} — latest ${source}: ` +
      `${JSON.stringify(excerpt)} — ${guidance}`,
  };
}

/**
 * Stop blockers include only a bounded, single-line preview of the response
 * that would otherwise have ended the turn. The instruction still asks the
 * agent to re-send its actual prior response after reading peers, unless that
 * context warrants a change.
 */
export function stopReasonForNudge(
  delivery: HookNudgeDelivery,
  lastAssistantMessage: string | undefined,
): string {
  const previous = boundedOneLine(
    lastAssistantMessage ?? "",
    STOP_RESPONSE_EXCERPT_BYTES,
  );
  return (
    `${delivery.text}. Then resend your previous response verbatim unless ` +
    `peer context changes it. Previous response excerpt: ${JSON.stringify(previous)}`
  );
}

function boundedOneLine(value: string, maximumBytes: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(normalized, "utf8") <= maximumBytes) return normalized;
  const ellipsis = "…";
  return `${truncateUtf8(
    normalized,
    maximumBytes - Buffer.byteLength(ellipsis, "utf8"),
  )}${ellipsis}`;
}
