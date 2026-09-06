import type { HookNudgeClaimOptions, UnreadPeerTurnOptions } from "../../src/nudge/unread.js";
import { withHookCursor } from "../../src/nudge/unread.js";
import type { UnreadPeerTurnsReady, UnreadPeerTurnsUnavailable } from "../../src/nudge/types.js";

/**
 * Seed a fully delivered frontier for ledger-only unit tests. This is synthetic
 * test setup, not an acknowledgement API. Provider/CLI delivery authority is
 * exercised separately by read-delivery.test.ts and the provider adapter tests.
 */
export async function seedFullyDeliveredCursor(
  options: UnreadPeerTurnOptions & Pick<HookNudgeClaimOptions, "now" | "onLockReleaseFailure">,
): Promise<(UnreadPeerTurnsReady & { readonly advanced: true; readonly next_cursor_revision: number }) | UnreadPeerTurnsUnavailable> {
  return withHookCursor(options, async (scan) => {
    const revision = scan.cursor.state.cursor_revision + 1;
    const state = { ...scan.cursor.state, cursor_revision: revision,
      feed_cursors: scan.candidateFeedCursors, markers: {}, delivery: { highest_unread_count: 0 },
      updated_at: (options.now ?? new Date()).toISOString() };
    return { state, result: { ...scan.public, advanced: true as const, next_cursor_revision: revision } };
  });
}
