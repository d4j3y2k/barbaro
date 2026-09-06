import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SafeStoreBoundary } from "../core/safe-store.js";
import { NudgeCursorStateStore } from "../nudge/store.js";
import { NUDGE_CURSOR_SCHEMA } from "../nudge/types.js";
import { READ_INVOCATION_TTL_MS } from "../nudge/read-state.js";
import { readReadObservations } from "../hooks/read-observation.js";

/** Counts and native evidence metadata only; never returns pending commands or output. */
export async function readDeliveryHealth(projectRoot: string, provider: "codex" | "claude", sessionId: string, now: Date) {
  const observation = await readReadObservations(projectRoot, provider, sessionId);
  const observations = observation.state === "ok" ? observation.journal.observations : [];
  const latest = observations.at(-1);
  const lastCommit = observations.filter((row) => row.state === "committed").at(-1);
  const unfinished = observations.filter((row) => ["reserved", "staged"].includes(row.state) && now.getTime() - Date.parse(row.created_at) > READ_INVOCATION_TTL_MS).length;
  const base = {
    provider, session_id: sessionId, observation_state: observation.state,
    observations_shown: observations.length, observations_omitted: observation.state === "ok" ? observation.journal.omitted : 0,
    never_committed: unfinished,
    ...(latest === undefined ? {} : { latest_observation: latest }),
    ...(lastCommit === undefined ? {} : { last_verified_delivery: lastCommit }),
  };
  let cursor;
  try { cursor = await new NudgeCursorStateStore(projectRoot).read(provider, sessionId); }
  catch { return { ...base, cursor_state: "refused" as const, coverage: "limited" as const }; }
  if (cursor === undefined) return { ...base, cursor_state: "missing" as const, coverage: "complete" as const };
  const failures: { provider: string; session_id: string; reason: string }[] = [];
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  // Saved positions are durable obligations, even when the feed disappeared.
  // A metadata/readability check cannot prove unseen feed contents healthy.
  for (const feed of cursor.feed_cursors.slice(0, 64)) {
    const directory = ["feed", feed.provider];
    let handle;
    try {
      const parent = await boundary.verifyDirectory(directory);
      if (parent === undefined) { failures.push({ provider: feed.provider, session_id: feed.session_id, reason: "missing_saved_feed" }); continue; }
      handle = await open(boundary.pathFor([...directory, `${feed.session_id}.jsonl`]), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) failures.push({ provider: feed.provider, session_id: feed.session_id, reason: "unsafe_saved_feed" });
      else if (stat.size > 64 * 1024 * 1024) failures.push({ provider: feed.provider, session_id: feed.session_id, reason: "saved_feed_exceeds_acknowledgment_limit" });
      await boundary.verifyDirectory(directory);
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      failures.push({ provider: feed.provider, session_id: feed.session_id, reason: ["ENOENT", "ENOTDIR"].includes(code) ? "missing_saved_feed" : "unreadable_or_unsafe_saved_feed" });
    } finally { await handle?.close(); }
  }
  const pending = cursor.schema === NUDGE_CURSOR_SCHEMA ? cursor.reads.pending : [];
  return {
    ...base, cursor_state: "present" as const, cursor_schema: cursor.schema, cursor_updated_at: cursor.updated_at,
    pending: pending.length, expired_pending: pending.filter((row) => Date.parse(row.expires_at) <= now.getTime()).length,
    staged_pending: pending.filter((row) => row.output !== undefined).length,
    saved_feeds_shown: Math.min(64, cursor.feed_cursors.length), saved_feeds_total: cursor.feed_cursors.length,
    saved_feed_failures: failures,
    coverage: cursor.feed_cursors.length > 64 ? "limited" as const : "complete" as const,
    ...(cursor.schema === NUDGE_CURSOR_SCHEMA ? { outside_window: cursor.reads.outside_window, sparse_coverage: cursor.reads.coverage.length } : {}),
  };
}
export type ReaderDeliveryHealth = Awaited<ReturnType<typeof readDeliveryHealth>>;
