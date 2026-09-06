import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ActiveLeaseStore } from "../active/store.js";
import { isActiveLeaseVisible } from "../active/validation.js";
import { SafeStoreBoundary } from "../core/safe-store.js";
import { SessionParticipationStore, participationMemberships, type SessionWorkstreamMembership } from "../hooks/participation.js";
import { readSessionRecentTurnFacts } from "./catalogue.js";

export const RECENT_MEMBERS_PER_PROVIDER = 8;
export interface ReaderRecentMember {
  readonly provider: "codex" | "claude";
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
  readonly memberships: readonly SessionWorkstreamMembership[];
  readonly last_activity_at: string;
  readonly last_main_lease_at?: string;
  readonly main_lease_live: boolean;
  readonly feed: Awaited<ReturnType<typeof readSessionRecentTurnFacts>>;
}

/**
 * Stream the complete enrollment roster and retain only the newest eight per
 * provider. Every candidate's bounded feed suffix, main lease and membership
 * time participates before the display cap. No active/state directory cap or
 * lexicographic id ordering can hide the newest enrolled sessions.
 *
 * Enumeration work scales with enrollment count; per-file reads and retained
 * memory are bounded. Refusal or concurrent directory changes limit coverage,
 * never erase positive evidence from a successfully read member.
 */
export async function readRecentMembers(projectRoot: string, now: Date) {
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  const participation = new SessionParticipationStore(projectRoot);
  const active = new ActiveLeaseStore(join(projectRoot, ".barbaro/active"));
  const providers = [];
  const reference = now.getTime();
  for (const provider of ["codex", "claude"] as const) {
    const selected: ReaderRecentMember[] = [];
    let candidates = 0; let files = 0; let incomplete = 0;
    let invalidParticipation = 0; let unavailableLeases = 0; let unavailableFeeds = 0;
    let rosterChanged = false; let rosterRefused = false;
    try {
      const directory = await boundary.verifyDirectory(["sessions", provider]);
      if (directory !== undefined) {
        const before = await stat(directory);
        for await (const entry of await opendir(directory)) {
          const match = /^(ses_[0-9a-f]{32})\.json$/u.exec(entry.name);
          if (match === null) continue;
          files += 1;
          if (!entry.isFile() || entry.isSymbolicLink()) { invalidParticipation += 1; continue; }
          const sessionId = match[1]!;
          let record;
          try { record = await participation.readStable(provider, sessionId); }
          catch { invalidParticipation += 1; continue; }
          if (record === undefined) { invalidParticipation += 1; continue; }
          const memberships = participationMemberships(record);
          const membership = memberships.at(-1);
          if (membership === undefined) continue; // Unscoped legacy enrollment has no current workstream.
          candidates += 1;
          const feed = await readSessionRecentTurnFacts(projectRoot, provider, sessionId, membership);
          if (feed.state === "refused") unavailableFeeds += 1;
          if (feed.coverage.state !== "complete") incomplete += 1;
          let lease;
          try { lease = await active.readSnapshot({ provider, session_id: sessionId, agent_id: "main" }); }
          catch { unavailableLeases += 1; }
          const leaseAt = lease?.workstream_id === membership.workstream_id &&
            Date.parse(lease.updated_at) >= Date.parse(membership.from) ? lease.updated_at : undefined;
          const activityTimes = [membership.from, feed.latest?.ended_at, leaseAt]
            .filter((value): value is string => value !== undefined && Date.parse(value) <= reference);
          const lastActivityAt = activityTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? membership.from;
          selected.push({ provider, session_id: sessionId, workstream_id: membership.workstream_id,
            membership_from: membership.from, memberships, last_activity_at: lastActivityAt,
            main_lease_live: leaseAt !== undefined && Date.parse(leaseAt) <= reference && lease !== undefined && isActiveLeaseVisible(lease, now),
            ...(leaseAt === undefined ? {} : { last_main_lease_at: leaseAt }), feed });
          selected.sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at) || a.session_id.localeCompare(b.session_id));
          if (selected.length > RECENT_MEMBERS_PER_PROVIDER) selected.pop();
        }
        const afterPath = await boundary.verifyDirectory(["sessions", provider]);
        const after = afterPath === undefined ? undefined : await stat(afterPath);
        rosterChanged = after === undefined || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
      }
    } catch { rosterRefused = true; }
    const limited = rosterRefused || rosterChanged || invalidParticipation > 0 || unavailableLeases > 0 || unavailableFeeds > 0 || incomplete > 0 || candidates > selected.length;
    providers.push({ provider, items: selected, shown: selected.length, total: candidates, omitted: candidates - selected.length,
      coverage: { state: limited ? "limited" as const : "complete" as const },
      diagnostics: { participation_files: files, invalid_participation: invalidParticipation,
        unavailable_main_leases: unavailableLeases, unavailable_feeds: unavailableFeeds, incomplete_feeds: incomplete,
        roster_changed: rosterChanged, roster_refused: rosterRefused },
    });
  }
  return { selection: "newest canonical publication, main lease or participation before per-provider display cap" as const, providers };
}
