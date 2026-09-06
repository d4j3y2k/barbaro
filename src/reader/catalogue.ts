import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ActiveLeaseStore } from "../active/store.js";
import type { ActiveLeaseV1 } from "../active/types.js";
import type { BarbaroTurnV1 } from "../contracts/v1.js";
import {
  SafeStoreBoundary,
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import { compareUtf16CodeUnits } from "../core/stable-json.js";
import {
  PARTICIPATING_PROVIDERS,
  participationMemberships,
  SESSION_PARTICIPATION_SCHEMA,
  SESSION_PARTICIPATION_SCHEMA_V2,
  type SessionParticipation,
  type SessionWorkstreamMembership,
} from "../hooks/participation.js";
import { parseWorkstream } from "../workstreams/store.js";
import type { WorkstreamV1 } from "../workstreams/types.js";

import {
  assertReaderByteBudget,
  readerProjectionFits,
  wrapReaderProjection,
} from "./budget.js";
import {
  projectReaderDependencyLease,
  type ReaderDependencyLeaseSummary,
} from "./dependency.js";
import {
  readSessionPublishSummary,
  type ReaderPublishSummary,
} from "./publish.js";
import { readerCollection } from "./projection.js";
import { isTurnV1 } from "./store.js";
import {
  readUnreadSummaryBatch,
  type ReaderUnreadRecipientKey,
  type ReaderUnreadSummary,
} from "./unread.js";
import type {
  ReaderCollection,
  ReaderCoverage,
  ReaderProjection,
  ReaderReadState,
} from "./types.js";

export const READER_CATALOGUE_SCHEMA = "barbaro.reader.catalogue.v1" as const;

const DEFAULT_TURNS_PER_SESSION = 5;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_ENTRIES = 4096;
const DEFAULT_MAX_MEMBERS = 64;
const DEFAULT_MAX_ROLLS = 64;
const DEFAULT_MAX_LEASES_PER_ROLL = 8;
const DEFAULT_MAX_ATTENTION_ITEMS = 32;
const DEFAULT_MAX_UNREAD_RECIPIENTS = 256;
const DEFAULT_PUBLISH_BYTE_BUDGET = 8 * 1024;
const MAX_WORKSTREAM_BYTES = 16 * 1024;
const MAX_PARTICIPATION_BYTES = 16 * 1024;
const WORKSTREAM_FILE_PATTERN = /^(ws_[0-9a-f]{32})\.json$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;
const SESSION_JSON_PATTERN = /^(ses_[0-9a-f]{32})\.json$/u;
const SESSION_JSONL_PATTERN = /^(ses_[0-9a-f]{32})\.jsonl$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;

export type ReaderCatalogueActivityState =
  | "shown"
  | "proven_empty"
  | "outside_window"
  | "byte_hidden"
  | "scan_limited"
  | "invalid"
  | "refused";

export type ReaderCatalogueAttentionKind =
  | "evidence_incomplete"
  | "user_input"
  | "publish_blocked"
  | "news"
  | "unknown_write"
  | "blocked";

export type ReaderCatalogueAudience =
  | "user"
  | "peer"
  | "system"
  | "external"
  | "unknown";

/** Counts-only envelope for windowed facts that carry no item payloads. */
export interface ReaderWindowCounts {
  readonly shown: number;
  readonly total: number;
  readonly hidden: number;
  readonly read_state: ReaderReadState;
  readonly coverage: ReaderCoverage;
}

export interface ReaderCatalogueRecord {
  readonly workstream_id: string;
  readonly name: string;
  readonly title?: string;
  readonly status: "open" | "completed";
  readonly created_at: string;
  readonly created_by:
    | { readonly kind: "cli" }
    | { readonly provider: string; readonly session_id: string };
  readonly updated_at: string;
  readonly revision: number;
}

/**
 * Status totals derived from every valid workstream record in scope before
 * the byte-budget projection can hide catalogue items. Consumers may present
 * these as exact only when the envelope is both `ok` and `complete`.
 */
export interface ReaderCatalogueWorkstreamStatusCounts {
  readonly open: number;
  readonly completed: number;
  readonly read_state: ReaderReadState;
  readonly coverage: ReaderCoverage;
}

export interface ReaderCatalogueMember {
  readonly provider: string;
  readonly session_id: string;
  readonly membership_from: string;
}

export interface ReaderCatalogueLeaseFact {
  readonly agent_id: string;
  readonly state: "working" | "waiting" | "blocked";
  readonly updated_at: string;
  readonly expires_at: string;
  readonly unknown_write_scope: boolean;
  readonly claim_count: number;
  readonly dependency?: ReaderDependencyLeaseSummary["dependency"];
}

export interface ReaderCatalogueTurnFact {
  readonly provider: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly sequence: number;
  readonly outcome: string;
  readonly ended_at: string;
}

export interface ReaderCatalogueRoll {
  readonly provider: string;
  readonly session_id: string;
  readonly current_enrollment: boolean;
  readonly membership_from?: string;
  readonly in_participation: boolean;
  readonly in_active: boolean;
  readonly in_turns: boolean;
  readonly state_counts: {
    readonly working: number;
    readonly waiting: number;
    readonly blocked: number;
  };
  readonly leases: ReaderCollection<ReaderCatalogueLeaseFact>;
  readonly turns: ReaderWindowCounts;
  readonly last_turn?: ReaderCatalogueTurnFact;
}

export interface ReaderCatalogueActivity {
  readonly state: ReaderCatalogueActivityState;
  readonly proven_empty: boolean;
  readonly full_history: ReaderCoverage;
  readonly window: {
    readonly policy: "newest_per_session";
    readonly turns_per_session: number;
  };
  readonly turns: ReaderWindowCounts;
  /** Newest scoped turn inside the visible window (the projected newest). */
  readonly newest_turn?: ReaderCatalogueTurnFact;
  /** Canonical ended_at of the newest known scoped turn, windowed or not. */
  readonly last_known_activity_at?: string;
}

export interface ReaderCatalogueAttentionItem {
  readonly kind: ReaderCatalogueAttentionKind;
  readonly audience: ReaderCatalogueAudience;
  readonly provider?: string;
  readonly session_id?: string;
}

export interface ReaderCatalogueAttention {
  readonly items: ReaderCollection<ReaderCatalogueAttentionItem>;
  readonly completeness: "complete" | "incomplete";
  readonly highest?: ReaderCatalogueAttentionKind;
}

export interface ReaderCatalogueWorkstream {
  readonly record: ReaderCatalogueRecord;
  readonly members: ReaderCollection<ReaderCatalogueMember>;
  readonly rolls: ReaderCollection<ReaderCatalogueRoll>;
  readonly active_state_counts: {
    readonly working: number;
    readonly waiting: number;
    readonly blocked: number;
  };
  readonly activity: ReaderCatalogueActivity;
  readonly quiet_proven: boolean;
  readonly attention: ReaderCatalogueAttention;
  readonly unread?: ReaderCollection<ReaderUnreadSummary>;
  readonly publish?: ReaderCollection<ReaderPublishSummary>;
}

export interface ReaderCatalogueDiagnostics {
  readonly workstream_files: number;
  readonly invalid_workstream_records: number;
  readonly participation_files: number;
  readonly invalid_participation_records: number;
  readonly invalid_active_records: number;
  readonly feed_files: number;
  readonly malformed_feed_records: number;
  readonly invalid_feed_records: number;
  readonly partial_feed_files: number;
  readonly scan_limited_feed_files: number;
  readonly unscoped_active_leases: number;
  readonly unscoped_turns: number;
}

export interface ReaderCatalogueV1 {
  readonly schema: typeof READER_CATALOGUE_SCHEMA;
  readonly reference_at: string;
  readonly scope?: { readonly workstream_id: string };
  readonly workstream_status_counts: ReaderCatalogueWorkstreamStatusCounts;
  readonly workstreams: ReaderCollection<ReaderCatalogueWorkstream>;
  readonly read_state: ReaderReadState;
  readonly coverage: ReaderCoverage;
  readonly diagnostics: ReaderCatalogueDiagnostics;
}

export interface ReaderCatalogueOptions {
  readonly byteBudget: number;
  /** Sampled once as the catalogue's pinned reference time. */
  readonly now?: Date | number | string;
  /** Restrict the catalogue to one workstream (scoped dashboard mode). */
  readonly workstreamId?: string;
  readonly turnsPerSession?: number;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxScanBytesPerFile?: number;
  readonly maxSourceEntries?: number;
  readonly maxMembersPerWorkstream?: number;
  readonly maxRollsPerWorkstream?: number;
  readonly maxLeasesPerRoll?: number;
  readonly maxAttentionItems?: number;
  readonly maxUnreadRecipients?: number;
  readonly includeUnread?: boolean;
  readonly includePublish?: boolean;
  readonly publishByteBudget?: number;
}

interface CatalogueLimits {
  readonly turnsPerSession: number;
  readonly maxFileBytes: number;
  readonly maxRecordBytes: number;
  readonly maxScanBytes: number;
  readonly maxSourceEntries: number;
  readonly maxMembers: number;
  readonly maxRolls: number;
  readonly maxLeasesPerRoll: number;
  readonly maxAttentionItems: number;
  readonly maxUnreadRecipients: number;
  readonly publishByteBudget: number;
}

interface FeedScan {
  readonly provider: string;
  readonly sessionId: string;
  /** Valid path-matching turns in the scanned suffix, newest first. */
  readonly turns: readonly BarbaroTurnV1[];
  readonly malformed: number;
  readonly invalid: number;
  readonly partial: boolean;
  readonly scanLimited: boolean;
  /** True only when the complete file was scanned without damage. */
  readonly clean: boolean;
  /** Trustworthy newest-N suffix, independent of older feed damage. */
  readonly recent: {
    readonly turns: readonly BarbaroTurnV1[];
    readonly coverage: ReaderCoverage;
  };
}

interface ParticipationFacts {
  readonly files: number;
  readonly invalid: number;
  readonly limited: boolean;
  /** provider session -> full membership history, oldest first. */
  readonly historyBySession: ReadonlyMap<
    string,
    {
      readonly provider: string;
      readonly sessionId: string;
      readonly memberships: readonly SessionWorkstreamMembership[];
    }
  >;
}

/** A targeted health read, independent of catalogue directory/projection caps. */
export async function readSessionRecentTurnFacts(
  projectRoot: string, provider: "codex" | "claude", sessionId: string,
  membership: SessionWorkstreamMembership,
) {
  if (!/^ses_[0-9a-f]{32}$/u.test(sessionId)) throw new TypeError("Invalid session identity");
  const boundary = SafeStoreBoundary.forBarbaroProject(resolve(projectRoot));
  const components = ["feed", provider, `${sessionId}.jsonl`];
  const empty = (state: "missing" | "refused", reason?: string) => ({ state,
    turns: [] as ReturnType<typeof publishTurnFact>[],
    latest: undefined as (ReaderCatalogueTurnFact & { readonly workstream_id: string }) | undefined,
    coverage: reason === undefined ? { state: "complete" as const } : { state: "limited" as const, reason },
    recent_coverage: reason === undefined ? { state: "complete" as const } : { state: "limited" as const, reason },
  });
  try {
    if (await boundary.verifyDirectory(components.slice(0, -1)) === undefined) return empty("missing");
    const scan = await scanFeed(boundary, components, provider, sessionId,
      catalogueLimits({ byteBudget: 16384, turnsPerSession: 3, maxScanBytesPerFile: 1024 * 1024 }));
    await boundary.verifyDirectory(components.slice(0, -1));
    const scoped = scan.turns.filter((turn) => turn.workstream_id === membership.workstream_id &&
      Date.parse(turn.started_at) >= Date.parse(membership.from));
    const latest = scoped.sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at) || b.sequence - a.sequence)[0];
    return { state: "present" as const, turns: scan.recent.turns.map(publishTurnFact),
      latest: latest === undefined ? undefined : { ...turnFact(latest), workstream_id: membership.workstream_id },
      coverage: scan.clean ? { state: "complete" as const } : { state: "limited" as const, reason: feedIssueReason(scan) },
      recent_coverage: scan.recent.coverage,
    };
  } catch (error: unknown) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return empty("missing");
    return empty("refused", "session_feed_refused");
  }
}

interface WorkstreamFacts {
  readonly files: number;
  readonly invalid: number;
  readonly limited: boolean;
  readonly records: readonly WorkstreamV1[];
}

/**
 * One pinned bounded E-06/E-07 catalogue. Everything derives from a single
 * pass over workstream records, current participation, visible active
 * leases, and one bounded scan per feed; the composed E-02 batch and E-04
 * summaries reuse their own read-only readers. Nothing is created, repaired,
 * acknowledged, or advanced.
 */
export async function readProjectCatalogue(
  projectRoot: string,
  options: ReaderCatalogueOptions,
): Promise<ReaderProjection<ReaderCatalogueV1>> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  assertReaderByteBudget(options.byteBudget);
  if (
    options.workstreamId !== undefined &&
    !WORKSTREAM_ID_PATTERN.test(options.workstreamId)
  ) {
    throw new TypeError("workstreamId is invalid");
  }
  const limits = catalogueLimits(options);
  const absoluteRoot = resolve(projectRoot);
  const boundary = SafeStoreBoundary.forBarbaroProject(absoluteRoot);
  const referenceAt = referenceTime(options.now);

  let workstreams: WorkstreamFacts;
  let participation: ParticipationFacts;
  let feeds: readonly FeedScan[];
  let feedListLimited = false;
  let invalidActive = 0;
  let leases: ActiveLeaseV1[];
  try {
    workstreams = await readWorkstreamFacts(boundary, limits);
    participation = await readParticipationFacts(boundary, limits);
    const feedList = await scanAllFeeds(boundary, limits);
    feeds = feedList.scans;
    feedListLimited = feedList.limited;
    leases = await new ActiveLeaseStore(
      join(absoluteRoot, ".barbaro", "active"),
    ).listActive({
      now: referenceAt,
      onInvalid: () => {
        invalidActive += 1;
      },
    });
  } catch (error: unknown) {
    return wrapReaderProjection(
      refusedCatalogue(referenceAt, options.workstreamId, refusalReason(error)),
      options.byteBudget,
    );
  }

  const evidence = {
    workstreamsComplete: !workstreams.limited && workstreams.invalid === 0,
    participationComplete:
      !participation.limited && participation.invalid === 0,
    activeComplete: invalidActive === 0,
    feedsClean:
      !feedListLimited &&
      feeds.every((feed) => feed.clean),
    feedListLimited,
  };

  const scopedRecords = [...workstreams.records]
    .sort((left, right) =>
      compareUtf16CodeUnits(left.workstream_id, right.workstream_id),
    )
    .filter(
      (record) =>
        options.workstreamId === undefined ||
        record.workstream_id === options.workstreamId,
    );

  const workstreamStatusCounts: ReaderCatalogueWorkstreamStatusCounts = {
    open: scopedRecords.filter((record) => record.status === "open").length,
    completed: scopedRecords.filter((record) => record.status === "completed")
      .length,
    read_state: evidence.workstreamsComplete ? "ok" : "degraded",
    coverage: workstreams.limited
      ? { state: "limited", reason: "source_entry_limit" }
      : { state: "complete" },
  };

  const items: ReaderCatalogueWorkstream[] = [];
  for (const record of scopedRecords) {
    items.push(
      assembleWorkstream(record, participation, leases, feeds, evidence, limits),
    );
  }

  const scopedIds = new Set(items.map((item) => item.record.workstream_id));
  const unscopedActive = leases.filter(
    (lease) => lease.workstream_id === undefined,
  ).length;
  let unscopedTurns = 0;
  for (const feed of feeds) {
    for (const turn of feed.turns) {
      if (turn.workstream_id === undefined) unscopedTurns += 1;
    }
  }

  const withUnread =
    options.includeUnread === false
      ? items
      : await attachUnread(absoluteRoot, items, limits);
  const withPublish =
    options.includePublish === false
      ? withUnread
      : await attachPublish(
          absoluteRoot,
          withUnread,
          participation,
          feeds,
          limits,
        );
  const finished = withPublish.map((item) =>
    finishAttention(item, evidence, limits),
  );

  const readState: ReaderReadState =
    evidence.workstreamsComplete &&
    evidence.participationComplete &&
    evidence.activeComplete &&
    evidence.feedsClean
      ? "ok"
      : "degraded";
  const coverage: ReaderCoverage =
    workstreams.limited || participation.limited || feedListLimited
      ? { state: "limited", reason: "source_entry_limit" }
      : { state: "complete" };

  const diagnostics: ReaderCatalogueDiagnostics = {
    workstream_files: workstreams.files,
    invalid_workstream_records: workstreams.invalid,
    participation_files: participation.files,
    invalid_participation_records: participation.invalid,
    invalid_active_records: invalidActive,
    feed_files: feeds.length,
    malformed_feed_records: feeds.reduce((sum, feed) => sum + feed.malformed, 0),
    invalid_feed_records: feeds.reduce((sum, feed) => sum + feed.invalid, 0),
    partial_feed_files: feeds.filter((feed) => feed.partial).length,
    scan_limited_feed_files: feeds.filter((feed) => feed.scanLimited).length,
    unscoped_active_leases: unscopedActive,
    unscoped_turns: unscopedTurns,
  };

  return projectCatalogue(
    {
      schema: READER_CATALOGUE_SCHEMA,
      reference_at: referenceAt,
      ...(options.workstreamId === undefined
        ? {}
        : { scope: { workstream_id: options.workstreamId } }),
      workstream_status_counts: workstreamStatusCounts,
      workstreams: {
        shown: finished.length,
        total: finished.length,
        hidden: 0,
        items: finished,
        read_state: readState,
        coverage,
      },
      read_state: readState,
      coverage,
      diagnostics,
    },
    options.byteBudget,
    scopedIds.size,
  );
}

function assembleWorkstream(
  record: WorkstreamV1,
  participation: ParticipationFacts,
  leases: readonly ActiveLeaseV1[],
  feeds: readonly FeedScan[],
  evidence: {
    readonly workstreamsComplete: boolean;
    readonly participationComplete: boolean;
    readonly activeComplete: boolean;
    readonly feedListLimited: boolean;
  },
  limits: CatalogueLimits,
): ReaderCatalogueWorkstream {
  const workstreamId = record.workstream_id;

  const currentMembers: ReaderCatalogueMember[] = [];
  const historicalSessions = new Set<string>();
  for (const history of participation.historyBySession.values()) {
    const memberships = history.memberships;
    if (memberships.length === 0) continue;
    const current = memberships[memberships.length - 1]!;
    const sessionKey = `${history.provider} ${history.sessionId}`;
    if (current.workstream_id === workstreamId) {
      currentMembers.push({
        provider: history.provider,
        session_id: history.sessionId,
        membership_from: current.from,
      });
    } else if (
      memberships.some((entry) => entry.workstream_id === workstreamId)
    ) {
      historicalSessions.add(sessionKey);
    }
  }
  currentMembers.sort((left, right) =>
    compareUtf16CodeUnits(
      `${left.provider} ${left.session_id}`,
      `${right.provider} ${right.session_id}`,
    ),
  );

  const scopedLeases = leases.filter(
    (lease) => lease.workstream_id === workstreamId,
  );
  const leasesBySession = new Map<string, ActiveLeaseV1[]>();
  for (const lease of scopedLeases) {
    const key = `${lease.provider} ${lease.session_id}`;
    const existing = leasesBySession.get(key);
    if (existing === undefined) leasesBySession.set(key, [lease]);
    else existing.push(lease);
  }

  // The visible window is the session's newest-N turns across every
  // workstream, matching the context projection. A scoped turn older than
  // that window is known history outside the window, never silently absent.
  const turnsBySession = new Map<
    string,
    {
      readonly known: readonly BarbaroTurnV1[];
      readonly windowed: readonly BarbaroTurnV1[];
    }
  >();
  const feedBySession = new Map<string, FeedScan>();
  for (const feed of feeds) {
    const key = `${feed.provider} ${feed.sessionId}`;
    feedBySession.set(key, feed);
    const known = feed.turns.filter(
      (turn) => turn.workstream_id === workstreamId,
    );
    if (known.length > 0) {
      turnsBySession.set(key, {
        known,
        windowed: feed.recent.turns.filter(
          (turn) => turn.workstream_id === workstreamId,
        ),
      });
    }
  }

  const rollKeys = new Set<string>([
    ...currentMembers.map(
      (member) => `${member.provider} ${member.session_id}`,
    ),
    ...historicalSessions,
    ...leasesBySession.keys(),
    ...turnsBySession.keys(),
  ]);
  const sortedRollKeys = [...rollKeys].sort(compareUtf16CodeUnits);
  const rollLimited = sortedRollKeys.length > limits.maxRolls;
  const shownRollKeys = sortedRollKeys.slice(0, limits.maxRolls);

  const memberByKey = new Map(
    currentMembers.map((member) => [
      `${member.provider} ${member.session_id}`,
      member,
    ]),
  );

  const rolls: ReaderCatalogueRoll[] = shownRollKeys.map((key) => {
    const [provider = "", sessionId = ""] = key.split(" ");
    const member = memberByKey.get(key);
    const sessionLeases = leasesBySession.get(key) ?? [];
    const sessionTurns = turnsBySession.get(key) ?? { known: [], windowed: [] };
    const feed = feedBySession.get(key);
    const counts = { working: 0, waiting: 0, blocked: 0 };
    for (const lease of sessionLeases) {
      if (lease.state === "working") counts.working += 1;
      else if (lease.state === "waiting") counts.waiting += 1;
      else if (lease.state === "blocked") counts.blocked += 1;
    }
    const leaseFacts = sessionLeases
      .filter(
        (lease): lease is ActiveLeaseV1 & {
          readonly state: "working" | "waiting" | "blocked";
        } => lease.state !== "idle",
      )
      .sort((left, right) =>
        compareUtf16CodeUnits(left.agent_id, right.agent_id),
      )
      .map((lease) => leaseFact(lease));
    const leaseLimited = leaseFacts.length > limits.maxLeasesPerRoll;
    const shownLeases = leaseFacts.slice(0, limits.maxLeasesPerRoll);

    const turnTotal = sessionTurns.known.length;
    const turnShown = sessionTurns.windowed.length;
    const turnCoverage = scopedFeedCoverage(
      [key],
      feedBySession,
      evidence.feedListLimited,
      "recent",
    );
    const newest = sessionTurns.windowed[0];

    return {
      provider,
      session_id: sessionId,
      current_enrollment: member !== undefined,
      ...(member === undefined ? {} : { membership_from: member.membership_from }),
      in_participation: member !== undefined || historicalSessions.has(key),
      in_active: sessionLeases.length > 0,
      in_turns: turnTotal > 0,
      state_counts: counts,
      leases: {
        shown: shownLeases.length,
        total: leaseFacts.length,
        hidden: leaseFacts.length - shownLeases.length,
        items: shownLeases,
        read_state: leaseLimited ? "degraded" : "ok",
        coverage: leaseLimited
          ? { state: "limited", reason: "lease_limit" }
          : { state: "complete" },
      },
      turns: {
        shown: turnShown,
        total: turnTotal,
        hidden: turnTotal - turnShown,
        read_state: turnCoverage.state === "complete" ? "ok" : "degraded",
        coverage: turnCoverage,
      },
      ...(newest === undefined ? {} : { last_turn: turnFact(newest) }),
    };
  });

  const activeStateCounts = { working: 0, waiting: 0, blocked: 0 };
  for (const lease of scopedLeases) {
    if (lease.state === "working") activeStateCounts.working += 1;
    else if (lease.state === "waiting") activeStateCounts.waiting += 1;
    else if (lease.state === "blocked") activeStateCounts.blocked += 1;
  }

  let turnTotal = 0;
  let turnShown = 0;
  let newestTurn: BarbaroTurnV1 | undefined;
  let lastKnownAt: string | undefined;
  for (const scoped of turnsBySession.values()) {
    turnTotal += scoped.known.length;
    turnShown += scoped.windowed.length;
    const candidate = scoped.windowed[0];
    if (
      candidate !== undefined &&
      (newestTurn === undefined ||
        compareTurnsNewestFirst(candidate, newestTurn) < 0)
    ) {
      newestTurn = candidate;
    }
    const knownNewest = scoped.known[0];
    if (
      knownNewest !== undefined &&
      (lastKnownAt === undefined ||
        Date.parse(knownNewest.ended_at) > Date.parse(lastKnownAt))
    ) {
      lastKnownAt = knownNewest.ended_at;
    }
  }

  const fullHistory = scopedFeedCoverage(
    sortedRollKeys,
    feedBySession,
    evidence.feedListLimited,
    "full",
  );
  const recentCoverage = scopedFeedCoverage(
    sortedRollKeys,
    feedBySession,
    evidence.feedListLimited,
    "recent",
  );

  let activityState: ReaderCatalogueActivityState;
  if (turnShown > 0) activityState = "shown";
  else if (turnTotal > 0) activityState = "outside_window";
  else if (recentCoverage.state !== "complete") {
    activityState = coverageMeansScanLimited(recentCoverage)
      ? "scan_limited"
      : "invalid";
  }
  else if (
    fullHistory.state === "complete" &&
    evidence.workstreamsComplete &&
    evidence.participationComplete &&
    evidence.activeComplete
  ) {
    activityState = "proven_empty";
  } else {
    activityState = coverageMeansScanLimited(fullHistory)
      ? "scan_limited"
      : "invalid";
  }
  const provenEmpty = activityState === "proven_empty";

  const activity: ReaderCatalogueActivity = {
    state: activityState,
    proven_empty: provenEmpty,
    full_history: fullHistory,
    window: {
      policy: "newest_per_session",
      turns_per_session: limits.turnsPerSession,
    },
    turns: {
      shown: turnShown,
      total: turnTotal,
      hidden: turnTotal - turnShown,
      read_state: recentCoverage.state === "complete" ? "ok" : "degraded",
      coverage: recentCoverage,
    },
    ...(newestTurn === undefined ? {} : { newest_turn: turnFact(newestTurn) }),
    ...(lastKnownAt === undefined
      ? {}
      : { last_known_activity_at: lastKnownAt }),
  };

  const memberLimited = currentMembers.length > limits.maxMembers;
  const shownMembers = currentMembers.slice(0, limits.maxMembers);

  return {
    record: {
      workstream_id: record.workstream_id,
      name: record.name,
      ...(record.title === undefined ? {} : { title: record.title }),
      status: record.status,
      created_at: record.created_at,
      created_by:
        "kind" in record.created_by
          ? { kind: "cli" }
          : {
              provider: record.created_by.provider,
              session_id: record.created_by.session_id,
            },
      updated_at: record.updated_at,
      revision: record.revision,
    },
    members: {
      shown: shownMembers.length,
      total: currentMembers.length,
      hidden: currentMembers.length - shownMembers.length,
      items: shownMembers,
      read_state: participation.invalid > 0 || memberLimited ? "degraded" : "ok",
      coverage: memberLimited
        ? { state: "limited", reason: "member_limit" }
        : participation.limited
          ? { state: "limited", reason: "participation_entry_limit" }
          : { state: "complete" },
    },
    rolls: {
      shown: rolls.length,
      total: sortedRollKeys.length,
      hidden: sortedRollKeys.length - rolls.length,
      items: rolls,
      read_state: rollLimited ? "degraded" : "ok",
      coverage: rollLimited
        ? { state: "limited", reason: "roll_limit" }
        : { state: "complete" },
    },
    active_state_counts: activeStateCounts,
    activity,
    quiet_proven: false,
    attention: {
      items: readerCollection([]),
      completeness: "incomplete",
    },
  };
}

async function attachUnread(
  projectRoot: string,
  items: readonly ReaderCatalogueWorkstream[],
  limits: CatalogueLimits,
): Promise<ReaderCatalogueWorkstream[]> {
  const recipients: ReaderUnreadRecipientKey[] = [];
  for (const item of items) {
    for (const member of item.members.items) {
      recipients.push({
        provider: member.provider,
        session_id: member.session_id,
        workstream_id: item.record.workstream_id,
        membership_from: member.membership_from,
      });
    }
  }
  if (recipients.length === 0) {
    return items.map((item) => ({
      ...item,
      unread: readerCollection<ReaderUnreadSummary>([]),
    }));
  }
  const batch = await readUnreadSummaryBatch({
    projectRoot,
    recipients,
    maxRecipients: limits.maxUnreadRecipients,
  });
  const byKey = new Map(
    batch.items.map((summary) => [
      [
        summary.key.provider,
        summary.key.session_id,
        summary.key.workstream_id,
        summary.key.membership_from,
      ].join(" "),
      summary,
    ]),
  );
  return items.map((item) => {
    const summaries: ReaderUnreadSummary[] = [];
    let missing = 0;
    for (const member of item.members.items) {
      const summary = byKey.get(
        [
          member.provider,
          member.session_id,
          item.record.workstream_id,
          member.membership_from,
        ].join(" "),
      );
      if (summary === undefined) missing += 1;
      else summaries.push(summary);
    }
    return {
      ...item,
      unread: {
        shown: summaries.length,
        total: summaries.length + missing,
        hidden: missing,
        items: summaries,
        read_state: missing > 0 ? "degraded" : batch.read_state,
        coverage:
          missing > 0
            ? { state: "limited", reason: "recipient_limit" }
            : batch.coverage,
      },
    };
  });
}

async function attachPublish(
  projectRoot: string,
  items: readonly ReaderCatalogueWorkstream[],
  participation: ParticipationFacts,
  feeds: readonly FeedScan[],
  limits: CatalogueLimits,
): Promise<ReaderCatalogueWorkstream[]> {
  const feedByKey = new Map(
    feeds.map((feed) => [`${feed.provider} ${feed.sessionId}`, feed]),
  );
  const result: ReaderCatalogueWorkstream[] = [];
  for (const item of items) {
    const summaries: ReaderPublishSummary[] = [];
    let missing = 0;
    for (const member of item.members.items) {
      const key = `${member.provider} ${member.session_id}`;
      const history = participation.historyBySession.get(key);
      if (history === undefined) {
        missing += 1;
        continue;
      }
      const feed = feedByKey.get(key);
      const trustworthyTurns =
        feed === undefined
          ? undefined
          : feed.clean
            ? feed.turns
            : feed.recent.coverage.state === "complete"
              ? feed.recent.turns
              : undefined;
      const turnHistory =
        trustworthyTurns === undefined
          ? undefined
          : readerCollection(trustworthyTurns.map(publishTurnFact));
      const summary = await readSessionPublishSummary(projectRoot, {
        byteBudget: limits.publishByteBudget,
        provider: member.provider,
        sessionId: member.session_id,
        workstreamId: item.record.workstream_id,
        membershipHistory: {
          provider: member.provider,
          session_id: member.session_id,
          memberships: readerCollection(history.memberships),
        },
        ...(turnHistory === undefined ? {} : { turnHistory }),
      });
      summaries.push(summary.value);
    }
    result.push({
      ...item,
      publish: {
        shown: summaries.length,
        total: summaries.length + missing,
        hidden: missing,
        items: summaries,
        read_state: missing > 0 ? "degraded" : "ok",
        coverage:
          missing > 0
            ? { state: "limited", reason: "membership_history_unavailable" }
            : { state: "complete" },
      },
    });
  }
  return result;
}

const ATTENTION_PRIORITY: readonly ReaderCatalogueAttentionKind[] = [
  "evidence_incomplete",
  "user_input",
  "publish_blocked",
  "news",
  "unknown_write",
  "blocked",
];

function finishAttention(
  item: ReaderCatalogueWorkstream,
  evidence: {
    readonly participationComplete: boolean;
    readonly activeComplete: boolean;
  },
  limits: CatalogueLimits,
): ReaderCatalogueWorkstream {
  const items: ReaderCatalogueAttentionItem[] = [];
  // Ungathered unread/publish evidence is a proof gap, not a clean slate.
  let incomplete =
    item.activity.turns.coverage.state !== "complete" ||
    item.members.coverage.state !== "complete" ||
    item.rolls.coverage.state !== "complete" ||
    !evidence.participationComplete ||
    !evidence.activeComplete ||
    item.unread === undefined ||
    item.publish === undefined;

  for (const roll of item.rolls.items) {
    for (const lease of roll.leases.items) {
      if (lease.unknown_write_scope) {
        items.push({
          kind: "unknown_write",
          audience: "unknown",
          provider: roll.provider,
          session_id: roll.session_id,
        });
      }
      if (lease.state === "blocked") {
        items.push({
          kind: "blocked",
          audience: lease.dependency?.audience ?? "unknown",
          provider: roll.provider,
          session_id: roll.session_id,
        });
      }
      if (lease.dependency?.kind === "human_input") {
        items.push({
          kind: "user_input",
          audience: "user",
          provider: roll.provider,
          session_id: roll.session_id,
        });
      }
    }
  }

  if (item.unread !== undefined) {
    if (item.unread.coverage.state !== "complete") incomplete = true;
    for (const summary of item.unread.items) {
      if (summary.status === "unknown") incomplete = true;
      else if (summary.unread_count > 0) {
        items.push({
          kind: "news",
          audience: "user",
          provider: summary.key.provider,
          session_id: summary.key.session_id,
        });
      }
    }
  }
  if (item.publish !== undefined) {
    if (item.publish.coverage.state !== "complete") incomplete = true;
    for (const summary of item.publish.items) {
      if (summary.state === "unknown") incomplete = true;
      else if (summary.state === "blocked") {
        items.push({
          kind: "publish_blocked",
          audience: "user",
          provider: summary.provider,
          session_id: summary.session_id,
        });
      }
    }
  }
  if (incomplete) {
    items.push({ kind: "evidence_incomplete", audience: "unknown" });
  }

  items.sort(
    (left, right) =>
      ATTENTION_PRIORITY.indexOf(left.kind) -
        ATTENTION_PRIORITY.indexOf(right.kind) ||
      compareUtf16CodeUnits(
        `${left.provider ?? ""} ${left.session_id ?? ""}`,
        `${right.provider ?? ""} ${right.session_id ?? ""}`,
      ),
  );
  const limited = items.length > limits.maxAttentionItems;
  const shown = items.slice(0, limits.maxAttentionItems);
  const completeness: "complete" | "incomplete" =
    incomplete || limited ? "incomplete" : "complete";
  const attention: ReaderCatalogueAttention = {
    items: {
      shown: shown.length,
      total: items.length,
      hidden: items.length - shown.length,
      items: shown,
      read_state: limited ? "degraded" : "ok",
      coverage: limited
        ? { state: "limited", reason: "attention_limit" }
        : { state: "complete" },
    },
    completeness,
    ...(shown.length === 0 ? {} : { highest: shown[0]!.kind }),
  };

  const quietProven =
    item.activity.full_history.state === "complete" &&
    item.activity.last_known_activity_at !== undefined &&
    evidence.activeComplete &&
    item.active_state_counts.working === 0 &&
    item.active_state_counts.waiting === 0 &&
    item.active_state_counts.blocked === 0 &&
    items.length === 0 &&
    completeness === "complete";

  return { ...item, attention, quiet_proven: quietProven };
}

function projectCatalogue(
  catalogue: ReaderCatalogueV1,
  byteBudget: number,
  matchTotal: number,
): ReaderProjection<ReaderCatalogueV1> {
  const all = catalogue.workstreams.items;
  let shown = all.length;
  const build = (): ReaderCatalogueV1 => ({
    ...catalogue,
    workstreams: {
      ...catalogue.workstreams,
      shown,
      total: matchTotal,
      hidden: matchTotal - shown,
      items: all.slice(0, shown),
    },
  });
  if (readerProjectionFits(build(), byteBudget)) {
    return wrapReaderProjection(build(), byteBudget);
  }
  while (shown > 0) {
    shown -= 1;
    if (readerProjectionFits(build(), byteBudget)) break;
  }
  return wrapReaderProjection(build(), byteBudget);
}

function leaseFact(
  lease: ActiveLeaseV1 & { readonly state: "working" | "waiting" | "blocked" },
): ReaderCatalogueLeaseFact {
  const enriched = projectReaderDependencyLease({
    state: lease.state,
    ...(lease.workstream_id === undefined
      ? {}
      : { workstream_id: lease.workstream_id }),
    ...(lease.current_action === undefined
      ? {}
      : {
          current_action: {
            kind: lease.current_action.kind,
            ...(lease.current_action.command === undefined
              ? {}
              : { command: { text: lease.current_action.command.text } }),
            ...(lease.current_action.started_at === undefined
              ? {}
              : { started_at: lease.current_action.started_at }),
          },
        }),
  });
  return {
    agent_id: lease.agent_id,
    state: lease.state,
    updated_at: lease.updated_at,
    expires_at: lease.expires_at,
    unknown_write_scope: lease.unknown_write_scope,
    claim_count: lease.claims.length,
    ...(enriched.dependency === undefined
      ? {}
      : { dependency: enriched.dependency }),
  };
}

function turnFact(turn: BarbaroTurnV1): ReaderCatalogueTurnFact {
  return {
    provider: turn.provider,
    session_id: turn.session_id,
    turn_id: turn.turn_id,
    sequence: turn.sequence,
    outcome: turn.outcome,
    ended_at: turn.ended_at,
  };
}

function publishTurnFact(turn: BarbaroTurnV1): {
  readonly turn_id: string;
  readonly response_sha256?: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly sequence: number;
  readonly started_at: string;
} {
  const response = turn.response;
  const sha =
    response !== undefined && response.truncated === false
      ? createHash("sha256").update(response.text, "utf8").digest("hex")
      : undefined;
  return {
    turn_id: turn.turn_id,
    ...(sha === undefined ? {} : { response_sha256: sha }),
    provider: turn.provider,
    session_id: turn.session_id,
    ...(turn.workstream_id === undefined
      ? {}
      : { workstream_id: turn.workstream_id }),
    sequence: turn.sequence,
    started_at: turn.started_at,
  };
}

async function readWorkstreamFacts(
  boundary: SafeStoreBoundary,
  limits: CatalogueLimits,
): Promise<WorkstreamFacts> {
  const directory = await boundary.verifyDirectory(["workstreams"]);
  if (directory === undefined) {
    return { files: 0, invalid: 0, limited: false, records: [] };
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const records: WorkstreamV1[] = [];
  let files = 0;
  let invalid = 0;
  let limited = false;
  for (const entry of entries) {
    const match = WORKSTREAM_FILE_PATTERN.exec(entry.name);
    if (match === null) continue;
    const components = ["workstreams", entry.name];
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(components),
        "canonical workstream path is not a real file",
      );
    }
    files += 1;
    if (files > limits.maxSourceEntries) {
      limited = true;
      continue;
    }
    const bytes = await readBoundedFile(
      boundary,
      components,
      Math.min(limits.maxFileBytes, MAX_WORKSTREAM_BYTES),
    );
    try {
      records.push(parseWorkstream(decodeUtf8(bytes), match[1]));
    } catch {
      invalid += 1;
    }
  }
  return { files, invalid, limited, records };
}

async function readParticipationFacts(
  boundary: SafeStoreBoundary,
  limits: CatalogueLimits,
): Promise<ParticipationFacts> {
  const historyBySession = new Map<
    string,
    {
      readonly provider: string;
      readonly sessionId: string;
      readonly memberships: readonly SessionWorkstreamMembership[];
    }
  >();
  const root = await boundary.verifyDirectory(["sessions"]);
  if (root === undefined) {
    return { files: 0, invalid: 0, limited: false, historyBySession };
  }
  const providers = await readdir(root, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  let files = 0;
  let invalid = 0;
  let limited = false;
  for (const providerEntry of providers) {
    if (!PROVIDER_PATTERN.test(providerEntry.name)) continue;
    const providerComponents = ["sessions", providerEntry.name];
    if (providerEntry.isSymbolicLink() || !providerEntry.isDirectory()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(providerComponents),
        "provider component is not a real directory",
      );
    }
    const directory = await boundary.verifyDirectory(providerComponents);
    if (directory === undefined) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const match = SESSION_JSON_PATTERN.exec(entry.name);
      if (match === null) continue;
      const components = [...providerComponents, entry.name];
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(
          boundary.pathFor(components),
          "canonical participation path is not a real file",
        );
      }
      files += 1;
      if (files > limits.maxSourceEntries) {
        limited = true;
        continue;
      }
      const bytes = await readBoundedFile(
        boundary,
        components,
        Math.min(limits.maxFileBytes, MAX_PARTICIPATION_BYTES),
      );
      try {
        const participation = parseParticipation(
          decodeUtf8(bytes),
          providerEntry.name,
          match[1]!,
        );
        historyBySession.set(
          `${providerEntry.name} ${match[1]!}`,
          {
            provider: providerEntry.name,
            sessionId: match[1]!,
            memberships: participationMemberships(participation),
          },
        );
      } catch {
        invalid += 1;
      }
    }
  }
  return { files, invalid, limited, historyBySession };
}

function parseParticipation(
  text: string,
  expectedProvider: string,
  expectedSessionId: string,
): SessionParticipation {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) throw new TypeError("participation must be an object");
  if (
    value.provider !== expectedProvider ||
    value.session_id !== expectedSessionId ||
    !PARTICIPATING_PROVIDERS.includes(
      expectedProvider as (typeof PARTICIPATING_PROVIDERS)[number],
    ) ||
    typeof value.joined_at !== "string" ||
    !Number.isFinite(Date.parse(value.joined_at)) ||
    value.initiated_by !== "user_prompt"
  ) {
    throw new TypeError("participation is structurally invalid");
  }
  if (value.schema === SESSION_PARTICIPATION_SCHEMA) {
    if (value.workstream_id !== undefined || value.memberships !== undefined) {
      throw new TypeError("participation v1 cannot name memberships");
    }
    return value as unknown as SessionParticipation;
  }
  if (
    value.schema !== SESSION_PARTICIPATION_SCHEMA_V2 ||
    typeof value.workstream_id !== "string" ||
    !WORKSTREAM_ID_PATTERN.test(value.workstream_id)
  ) {
    throw new TypeError("participation is structurally invalid");
  }
  if (value.memberships !== undefined) {
    if (!Array.isArray(value.memberships) || value.memberships.length === 0) {
      throw new TypeError("participation memberships are invalid");
    }
    let prior = Number.NEGATIVE_INFINITY;
    let latest: string | undefined;
    for (const membership of value.memberships) {
      if (
        !isObject(membership) ||
        typeof membership.workstream_id !== "string" ||
        !WORKSTREAM_ID_PATTERN.test(membership.workstream_id) ||
        typeof membership.from !== "string"
      ) {
        throw new TypeError("participation membership is invalid");
      }
      const from = Date.parse(membership.from);
      if (!Number.isFinite(from) || from <= prior) {
        throw new TypeError("participation membership times are invalid");
      }
      prior = from;
      latest = membership.workstream_id;
    }
    if (latest !== value.workstream_id) {
      throw new TypeError("participation current workstream is invalid");
    }
  }
  return value as unknown as SessionParticipation;
}

async function scanAllFeeds(
  boundary: SafeStoreBoundary,
  limits: CatalogueLimits,
): Promise<{ readonly scans: readonly FeedScan[]; readonly limited: boolean }> {
  const root = await boundary.verifyDirectory(["feed"]);
  if (root === undefined) return { scans: [], limited: false };
  const providers = await readdir(root, { withFileTypes: true });
  providers.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const scans: FeedScan[] = [];
  let files = 0;
  let limited = false;
  for (const providerEntry of providers) {
    if (!PROVIDER_PATTERN.test(providerEntry.name)) continue;
    const providerComponents = ["feed", providerEntry.name];
    if (providerEntry.isSymbolicLink() || !providerEntry.isDirectory()) {
      throw new UnsafeStorePathError(
        boundary.pathFor(providerComponents),
        "feed provider component is not a real directory",
      );
    }
    const directory = await boundary.verifyDirectory(providerComponents);
    if (directory === undefined) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const match = SESSION_JSONL_PATTERN.exec(entry.name);
      if (match === null) continue;
      const components = [...providerComponents, entry.name];
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new UnsafeStorePathError(
          boundary.pathFor(components),
          "canonical feed path is not a real file",
        );
      }
      files += 1;
      if (files > limits.maxSourceEntries) {
        limited = true;
        continue;
      }
      scans.push(
        await scanFeed(boundary, components, providerEntry.name, match[1]!, limits),
      );
    }
  }
  return { scans, limited };
}

async function scanFeed(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  provider: string,
  sessionId: string,
  limits: CatalogueLimits,
): Promise<FeedScan> {
  const path = boundary.pathFor(components);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UnsafeStorePathError(path, "opened object is not a regular file");
    }
    if (stats.nlink !== 1) {
      throw new UnsafeStorePathError(path, "final file has multiple hard links");
    }
    if (stats.size > limits.maxFileBytes) {
      throw new StoreFileTooLargeError(path, limits.maxFileBytes);
    }
    const length = Math.min(stats.size, limits.maxScanBytes);
    const start = stats.size - length;
    const suffix = Buffer.allocUnsafe(length);
    await readExactly(handle, suffix, start);
    const partial = suffix.byteLength > 0 && suffix.at(-1) !== 0x0a;
    const lines = completeSuffixLines(suffix, start > 0, partial);
    const turns: BarbaroTurnV1[] = [];
    let malformed = 0;
    let invalid = 0;
    let recentMalformed = false;
    let recentInvalid = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (line.byteLength > limits.maxRecordBytes) {
        throw new StoreFileTooLargeError(path, limits.maxRecordBytes);
      }
      let value: unknown;
      try {
        value = JSON.parse(decodeUtf8(line)) as unknown;
      } catch {
        malformed += 1;
        if (turns.length < limits.turnsPerSession) recentMalformed = true;
        continue;
      }
      if (
        !isTurnV1(value) ||
        value.provider !== provider ||
        value.session_id !== sessionId
      ) {
        invalid += 1;
        if (turns.length < limits.turnsPerSession) recentInvalid = true;
        continue;
      }
      turns.push(value);
    }
    const scanLimited = start > 0;
    const recentTurns = turns.slice(0, limits.turnsPerSession);
    const recentCoverage: ReaderCoverage = partial
      ? { state: "limited", reason: "feed_partial" }
      : recentMalformed
        ? { state: "limited", reason: "feed_malformed" }
        : recentInvalid
          ? { state: "limited", reason: "feed_invalid_records" }
          : scanLimited && recentTurns.length < limits.turnsPerSession
            ? { state: "limited", reason: "feed_scan_limit" }
            : { state: "complete" };
    return {
      provider,
      sessionId,
      turns,
      malformed,
      invalid,
      partial,
      scanLimited,
      clean: !scanLimited && !partial && malformed === 0 && invalid === 0,
      recent: { turns: recentTurns, coverage: recentCoverage },
    };
  } finally {
    await handle.close();
  }
}

function scopedFeedCoverage(
  sessionKeys: readonly string[],
  feedBySession: ReadonlyMap<string, FeedScan>,
  feedListLimited: boolean,
  scope: "full" | "recent",
): ReaderCoverage {
  for (const key of sessionKeys) {
    const feed = feedBySession.get(key);
    if (feed === undefined) {
      if (feedListLimited) {
        return { state: "limited", reason: "feed_source_limited" };
      }
      continue;
    }
    if (scope === "recent") {
      if (feed.recent.coverage.state !== "complete") {
        return feed.recent.coverage;
      }
    } else if (!feed.clean) {
      return { state: "limited", reason: feedIssueReason(feed) };
    }
  }
  return { state: "complete" };
}

function coverageMeansScanLimited(coverage: ReaderCoverage): boolean {
  return (
    coverage.reason === "feed_scan_limit" ||
    coverage.reason === "feed_source_limited"
  );
}

function feedIssueReason(feed: FeedScan): string {
  if (feed.scanLimited) return "feed_scan_limit";
  if (feed.partial) return "feed_partial";
  if (feed.malformed > 0) return "feed_malformed";
  return "feed_invalid_records";
}

function completeSuffixLines(
  suffix: Buffer,
  startsMidFile: boolean,
  partialTail: boolean,
): Buffer[] {
  let start = 0;
  let end = suffix.byteLength;
  if (startsMidFile) {
    const firstNewline = suffix.indexOf(0x0a);
    if (firstNewline < 0) return [];
    start = firstNewline + 1;
  }
  if (partialTail) {
    const lastNewline = suffix.lastIndexOf(0x0a);
    if (lastNewline < start) return [];
    end = lastNewline + 1;
  }
  const lines: Buffer[] = [];
  let lineStart = start;
  for (let index = start; index < end; index += 1) {
    if (suffix[index] !== 0x0a) continue;
    let lineEnd = index;
    if (lineEnd > lineStart && suffix[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineEnd > lineStart) lines.push(suffix.subarray(lineStart, lineEnd));
    lineStart = index + 1;
  }
  return lines;
}

async function readBoundedFile(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  maximumBytes: number,
): Promise<Buffer> {
  const path = boundary.pathFor(components);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UnsafeStorePathError(path, "opened object is not a regular file");
    }
    if (stats.nlink !== 1) {
      throw new UnsafeStorePathError(path, "final file has multiple hard links");
    }
    if (stats.size > maximumBytes) {
      throw new StoreFileTooLargeError(path, maximumBytes);
    }
    const bytes = Buffer.allocUnsafe(stats.size);
    await readExactly(handle, bytes, 0);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (result.bytesRead === 0) {
      throw new RangeError("Barbaro catalogue source changed while being read");
    }
    offset += result.bytesRead;
  }
}

function compareTurnsNewestFirst(
  left: BarbaroTurnV1,
  right: BarbaroTurnV1,
): number {
  return (
    Date.parse(right.ended_at) - Date.parse(left.ended_at) ||
    compareUtf16CodeUnits(left.provider, right.provider) ||
    compareUtf16CodeUnits(left.session_id, right.session_id) ||
    right.sequence - left.sequence ||
    compareUtf16CodeUnits(left.turn_id, right.turn_id)
  );
}

function refusedCatalogue(
  referenceAt: string,
  workstreamId: string | undefined,
  reason: string,
): ReaderCatalogueV1 {
  const coverage: ReaderCoverage = { state: "refused", reason };
  return {
    schema: READER_CATALOGUE_SCHEMA,
    reference_at: referenceAt,
    ...(workstreamId === undefined
      ? {}
      : { scope: { workstream_id: workstreamId } }),
    workstream_status_counts: {
      open: 0,
      completed: 0,
      read_state: "refused",
      coverage,
    },
    workstreams: {
      shown: 0,
      total: 0,
      hidden: 0,
      items: [],
      read_state: "refused",
      coverage,
    },
    read_state: "refused",
    coverage,
    diagnostics: {
      workstream_files: 0,
      invalid_workstream_records: 0,
      participation_files: 0,
      invalid_participation_records: 0,
      invalid_active_records: 0,
      feed_files: 0,
      malformed_feed_records: 0,
      invalid_feed_records: 0,
      partial_feed_files: 0,
      scan_limited_feed_files: 0,
      unscoped_active_leases: 0,
      unscoped_turns: 0,
    },
  };
}

function referenceTime(now: Date | number | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  const millis =
    now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(millis)) {
    throw new TypeError("now must be a finite time");
  }
  return new Date(millis).toISOString();
}

function catalogueLimits(options: ReaderCatalogueOptions): CatalogueLimits {
  return {
    turnsPerSession: positiveInteger(
      options.turnsPerSession ?? DEFAULT_TURNS_PER_SESSION,
      "turnsPerSession",
    ),
    maxFileBytes: positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    ),
    maxRecordBytes: positiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      "maxRecordBytes",
    ),
    maxScanBytes: positiveInteger(
      options.maxScanBytesPerFile ?? DEFAULT_MAX_SCAN_BYTES,
      "maxScanBytesPerFile",
    ),
    maxSourceEntries: positiveInteger(
      options.maxSourceEntries ?? DEFAULT_MAX_SOURCE_ENTRIES,
      "maxSourceEntries",
    ),
    maxMembers: positiveInteger(
      options.maxMembersPerWorkstream ?? DEFAULT_MAX_MEMBERS,
      "maxMembersPerWorkstream",
    ),
    maxRolls: positiveInteger(
      options.maxRollsPerWorkstream ?? DEFAULT_MAX_ROLLS,
      "maxRollsPerWorkstream",
    ),
    maxLeasesPerRoll: positiveInteger(
      options.maxLeasesPerRoll ?? DEFAULT_MAX_LEASES_PER_ROLL,
      "maxLeasesPerRoll",
    ),
    maxAttentionItems: positiveInteger(
      options.maxAttentionItems ?? DEFAULT_MAX_ATTENTION_ITEMS,
      "maxAttentionItems",
    ),
    maxUnreadRecipients: positiveInteger(
      options.maxUnreadRecipients ?? DEFAULT_MAX_UNREAD_RECIPIENTS,
      "maxUnreadRecipients",
    ),
    publishByteBudget: positiveInteger(
      options.publishByteBudget ?? DEFAULT_PUBLISH_BYTE_BUDGET,
      "publishByteBudget",
    ),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function refusalReason(error: unknown): string {
  if (error instanceof UnsafeStorePathError) return "unsafe_path";
  if (error instanceof StoreFileTooLargeError) return "file_too_large";
  if (isErrnoCode(error, "EACCES") || isErrnoCode(error, "EPERM")) {
    return "permission_refused";
  }
  return "read_refused";
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
