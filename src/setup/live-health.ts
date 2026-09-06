import { readRecentMembers } from "../reader/recent-members.js";
import { readSessionPublishSummary } from "../reader/publish.js";
import { readerCollection } from "../reader/projection.js";
import { readProjectStoreHealth } from "../reader/health.js";
import { readDeliveryHealth, type ReaderDeliveryHealth } from "../reader/delivery-health.js";
import { NUDGE_CURSOR_SCHEMA } from "../nudge/types.js";

export const DOCTOR_LIVE_MAX_AGE_MS = 15 * 60 * 1000;
export type DoctorObservedState = "observed_working" | "stale" | "unverified" | "attention";

export async function inspectDoctorHealth(projectRoot: string, now: Date, runtimeHashes: readonly string[]) {
  const limits = { maxSourceEntries: 64, maxScanBytesPerFile: 1024 * 1024 };
  const store = (await readProjectStoreHealth(projectRoot, { ...limits, byteBudget: 16384 })).value;
  const recent = await readRecentMembers(projectRoot, now);
  const providers = [];
  for (const selection of recent.providers) {
    const provider = selection.provider;
    const shown = selection.items;
    const publication = [];
    for (const member of shown) {
      const publish = (await readSessionPublishSummary(projectRoot, {
        byteBudget: 4096, provider, sessionId: member.session_id, workstreamId: member.workstream_id,
        membershipHistory: { provider, session_id: member.session_id, memberships: readerCollection(member.memberships) },
        turnHistory: readerCollection(member.feed.turns, member.feed.recent_coverage.state === "complete" ? "ok" : "degraded", member.feed.recent_coverage),
      })).value;
      const last = member.feed.latest;
      const current = last !== undefined && Date.parse(last.ended_at) <= now.getTime() && now.getTime() - Date.parse(last.ended_at) <= DOCTOR_LIVE_MAX_AGE_MS;
      const attemptAt = publish.selected_attempt?.finished_at ?? publish.selected_attempt?.triggered_at;
      const attemptAge = attemptAt === undefined ? Infinity : now.getTime() - Date.parse(attemptAt);
      const attentionCurrent = member.main_lease_live || attemptAge >= 0 && attemptAge <= DOCTOR_LIVE_MAX_AGE_MS;
      const needsAttention = publish.state === "blocked" || publish.state === "pending" ||
        publish.selected_attempt?.publish_blocker !== undefined || publish.selected_attempt?.withheld_reason !== undefined;
      const state: DoctorObservedState = needsAttention && attentionCurrent ? "attention" :
        last === undefined ? "unverified" : current ? "observed_working" : "stale";
      publication.push({ session_id: member.session_id, workstream_id: member.workstream_id, state,
        last_activity_at: member.last_activity_at, membership_from: member.membership_from, main_lease_live: member.main_lease_live,
        feed_coverage: member.feed.coverage,
        ...(member.last_main_lease_at === undefined ? {} : { last_main_lease_at: member.last_main_lease_at }),
        ...(last === undefined ? {} : { last_published_turn: last }),
        ...{
          journal_state: publish.state, journal_freshness: publish.freshness, journal_outcome: publish.outcome,
          journal_coverage: publish.coverage, journal_read_state: publish.read_state,
          ...(publish.selected_attempt === undefined ? {} : { last_attempt: {
            attempt_id: publish.selected_attempt.attempt_id, triggered_at: publish.selected_attempt.triggered_at,
            outcome: publish.selected_attempt.outcome,
            ...(publish.selected_attempt.finished_at === undefined ? {} : { finished_at: publish.selected_attempt.finished_at }),
            ...(publish.selected_attempt.publish_blocker === undefined ? {} : { publish_blocker: publish.selected_attempt.publish_blocker }),
            ...(publish.selected_attempt.withheld_reason === undefined ? {} : { withheld_reason: publish.selected_attempt.withheld_reason }),
          } }),
        } });
    }
    const delivery: (ReaderDeliveryHealth & { state: DoctorObservedState })[] = [];
    for (const member of shown) {
      const read = await readDeliveryHealth(projectRoot, provider, member.session_id, now);
      const last = read.last_verified_delivery;
      const latest = read.latest_observation;
      const pending = "expired_pending" in read ? read.expired_pending : 0;
      const refused = latest?.state === "refused";
      const failures = "saved_feed_failures" in read ? read.saved_feed_failures.length : 0;
      const age = last === undefined ? Infinity : now.getTime() - Date.parse(last.updated_at);
      const currentRuntime = last?.runtime_build_sha256 !== undefined && runtimeHashes.includes(last.runtime_build_sha256);
      const state: DoctorObservedState = read.never_committed > 0 || pending > 0 || failures > 0 || refused || read.cursor_state === "refused" || ["invalid", "refused"].includes(read.observation_state) ? "attention" :
        latest !== undefined && latest.state !== "committed" ? "unverified" : last === undefined || !currentRuntime || read.cursor_state !== "present" || read.cursor_schema !== NUDGE_CURSOR_SCHEMA ? "unverified" :
          age >= 0 && age <= DOCTOR_LIVE_MAX_AGE_MS ? "observed_working" : "stale";
      delivery.push({ ...read, state });
    }
    const limited = selection.coverage.state !== "complete" ||
      publication.some((row) => row.journal_coverage?.state !== "complete") ||
      delivery.some((read) => read.coverage !== "complete");
    providers.push({ provider, sessions_shown: shown.length, sessions_found: selection.total, sessions_omitted: selection.omitted,
      coverage: limited ? "limited" : "complete", selection: recent.selection, selection_diagnostics: selection.diagnostics,
      publication_state: aggregate(publication.map((row) => row.state), limited), delivery_state: aggregate(delivery.map((row) => row.state), limited),
      publication_attention: publication.filter((row) => row.state === "attention").length,
      delivery_attention: delivery.filter((row) => row.state === "attention").length,
      publication, delivery,
      observation_limit: "Recent canonical publication is evidence of publication, not proof that every configured hook executes. Delivery records prove the observed adapter shape; Claude hook payloads do not attest producer version.",
    });
  }
  return { store, providers,
    freshness_max_age_ms: DOCTOR_LIVE_MAX_AGE_MS,
    limits: { health_max_source_entries: 64, live_membership_enumeration: "complete streaming roster", max_scan_bytes_per_file: 1024 * 1024, max_sessions_per_provider: 8, max_saved_feeds_per_session: 64 } };
}

function aggregate(states: readonly DoctorObservedState[], limited: boolean): DoctorObservedState {
  if (states.includes("observed_working")) return "observed_working";
  if (states.includes("attention")) return "attention";
  if (limited || states.length === 0 || states.includes("unverified")) return "unverified";
  if (states.includes("stale")) return "stale";
  return "observed_working";
}
