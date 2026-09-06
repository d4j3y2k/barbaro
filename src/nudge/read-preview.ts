import type { NudgeCursorV3 } from "./types.js";
import { collapseReadCursor, rescanHookReadCursor, type UnreadPeerTurnOptions, type StableUnreadPeerTurnOptions } from "./unread.js";
import { MAX_READ_COVERAGE_RECORDS, mergeReadCoverageForScan, readRecordHash, type NudgeReadCoverage } from "./read-state.js";
import { MAX_NUDGE_CURSOR_BYTES, nudgeCursorBytes, nudgeCursorFits } from "./store.js";

// Leave room for one maximum-size native reservation and staged envelope. An
// oldest-gap read can additionally use a bounded reserve for partial pages.
export const READ_CURSOR_HEADROOM_BYTES = 64 * 1024;
export const READ_RECOVERY_ALLOWANCE_BYTES = 24 * 1024;

export interface ReadCoveragePreview {
  readonly state: NudgeCursorV3;
  readonly advanced: boolean;
  readonly unread_count: number;
  readonly coverage_incomplete: boolean;
  readonly selected_feed_unavailable: boolean;
  readonly recovery: boolean;
  readonly recovery_turn_id?: string;
}

/** Pure preview shared by CLI capacity reporting and hook-locked commit. */
export async function previewReadCoverage(
  options: UnreadPeerTurnOptions | StableUnreadPeerTurnOptions,
  current: NudgeCursorV3,
  delivered: readonly NudgeReadCoverage[],
): Promise<ReadCoveragePreview> {
  const before = await rescanHookReadCursor(options, current, new Set(delivered.map(coverageRecordKey)));
  const base = collapseReadCursor(current, before);
  const added = delivered.filter((entry) => before.unreadRecordKeys.has(coverageRecordKey(entry)));
  const merged = mergeReadCoverageForScan(base.reads, added);
  const advanced = merged !== base.reads;
  const next = { ...base, reads: merged };
  const after = advanced ? await rescanHookReadCursor(options, next) : before;
  const first = before.firstUnread;
  const recoveryKey = first === undefined ? undefined : `${first.provider}/${first.session_id}/${first.turn_id}/${readRecordHash(first)}`;
  return {
    state: collapseReadCursor(next, after), advanced, unread_count: after.public.unread_count,
    coverage_incomplete: before.public.coverage?.state === "incomplete" || after.public.coverage?.state === "incomplete",
    selected_feed_unavailable: delivered.some((entry) =>
      before.unavailableFeedKeys.has(`${entry.provider}/${entry.session_id}`) ||
      after.unavailableFeedKeys.has(`${entry.provider}/${entry.session_id}`)),
    recovery: added.length > 0 && added.every((entry) => coverageRecordKey(entry) === recoveryKey),
    ...(first === undefined ? {} : { recovery_turn_id: first.turn_id }),
  };
}

/** No unread gaps are evicted to fit; oldest-gap reads have reserved working room. */
export function readCoverageFits(next: NudgeCursorV3, previous: NudgeCursorV3, recovery: boolean): boolean {
  if (next.reads.coverage.length > MAX_READ_COVERAGE_RECORDS || !nudgeCursorFits(next)) return false;
  // Reserve two field entries for an oldest-gap record and its attention text.
  // Existing fuller cursors can still shrink without losing any stored ranges.
  const recordBudget = MAX_READ_COVERAGE_RECORDS - (recovery ? 0 : 2);
  if (next.reads.coverage.length > recordBudget && next.reads.coverage.length > previous.reads.coverage.length) return false;
  const durableBytes = (state: NudgeCursorV3) => nudgeCursorBytes({ ...state, reads: { ...state.reads, pending: [] } });
  const nextBytes = durableBytes(next);
  const budget = MAX_NUDGE_CURSOR_BYTES - READ_CURSOR_HEADROOM_BYTES + (recovery ? READ_RECOVERY_ALLOWANCE_BYTES : 0);
  return nextBytes <= budget || nextBytes <= durableBytes(previous);
}

function coverageRecordKey(entry: NudgeReadCoverage): string {
  return `${entry.provider}/${entry.session_id}/${entry.turn_id}/${entry.record_sha256}`;
}
