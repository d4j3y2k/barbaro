import type {
  ReaderCatalogueV1,
  ReaderCatalogueWorkstream,
} from "../../src/reader/catalogue.js";
import type { ReaderProjection } from "../../src/reader/types.js";

export const FIXTURE_WS = `ws_${"a".repeat(32)}`;
export const FIXTURE_SES = `ses_${"1".repeat(32)}`;
export const FIXTURE_REFERENCE = "2026-08-25T12:00:00.000Z";

export function collection<T>(items: readonly T[]) {
  return {
    shown: items.length,
    total: items.length,
    hidden: 0,
    items,
    read_state: "ok" as const,
    coverage: { state: "complete" as const },
  };
}

export function projection<T>(value: T): ReaderProjection<T> {
  return { byte_budget: 1024 * 1024, utf8_bytes: 0, value };
}

export interface ItemOverrides {
  name?: string;
  workstreamId?: string;
  status?: "open" | "completed";
  updatedAt?: string;
  revision?: number;
  working?: number;
  waiting?: number;
  blocked?: number;
  quietProven?: boolean;
  activityState?: ReaderCatalogueWorkstream["activity"]["state"];
  fullHistory?: "complete" | "limited";
  lastKnownAt?: string;
  attentionComplete?: boolean;
  attentionTotal?: number;
  highest?: ReaderCatalogueWorkstream["attention"]["highest"];
  unreadCount?: number;
  turnsShown?: number;
  rollsTotal?: number;
}

export function makeItem(overrides: ItemOverrides): ReaderCatalogueWorkstream {
  const name = overrides.name ?? "alpha";
  const workstreamId = overrides.workstreamId ?? FIXTURE_WS;
  return {
    record: {
      workstream_id: workstreamId,
      name,
      status: overrides.status ?? "open",
      created_at: "2026-08-25T08:00:00.000Z",
      created_by: { kind: "cli" },
      updated_at: overrides.updatedAt ?? "2026-08-25T08:00:00.000Z",
      revision: overrides.revision ?? 1,
    },
    members: collection([]),
    rolls: {
      ...collection([]),
      total: overrides.rollsTotal ?? 0,
    },
    active_state_counts: {
      working: overrides.working ?? 0,
      waiting: overrides.waiting ?? 0,
      blocked: overrides.blocked ?? 0,
    },
    activity: {
      state: overrides.activityState ?? "shown",
      proven_empty: overrides.activityState === "proven_empty",
      full_history: { state: overrides.fullHistory ?? "complete" },
      window: { policy: "newest_per_session", turns_per_session: 5 },
      turns: {
        shown: overrides.turnsShown ?? 0,
        total: overrides.turnsShown ?? 0,
        hidden: 0,
        read_state: "ok",
        coverage: { state: "complete" },
      },
      ...(overrides.lastKnownAt === undefined
        ? {}
        : { last_known_activity_at: overrides.lastKnownAt }),
    },
    quiet_proven: overrides.quietProven ?? false,
    attention: {
      items: {
        ...collection<never>([]),
        total: overrides.attentionTotal ?? 0,
      },
      completeness:
        (overrides.attentionComplete ?? true) ? "complete" : "incomplete",
      ...(overrides.highest === undefined ? {} : { highest: overrides.highest }),
    },
    ...(overrides.unreadCount === undefined
      ? {}
      : {
          unread: collection([
            {
              key: {
                provider: "codex",
                session_id: FIXTURE_SES,
                workstream_id: workstreamId,
                membership_from: "2026-08-25T09:00:00.000Z",
              },
              cursor_state: "persisted" as const,
              read_state: "ok" as const,
              coverage: { state: "complete" as const },
              status: "ready" as const,
              unread_count: overrides.unreadCount,
            },
          ]),
        }),
  };
}

export function makeCatalogue(
  items: readonly ReaderCatalogueWorkstream[],
  incomplete = false,
): ReaderCatalogueV1 {
  const open = items.filter((item) => item.record.status === "open").length;
  const completed = items.length - open;
  return {
    schema: "barbaro.reader.catalogue.v1",
    reference_at: FIXTURE_REFERENCE,
    workstream_status_counts: {
      open,
      completed,
      read_state: incomplete ? "degraded" : "ok",
      coverage: incomplete
        ? { state: "limited", reason: "test" }
        : { state: "complete" },
    },
    workstreams: {
      ...collection(items),
      ...(incomplete
        ? { coverage: { state: "limited" as const, reason: "test" } }
        : {}),
    },
    read_state: "ok",
    coverage: incomplete
      ? { state: "limited", reason: "test" }
      : { state: "complete" },
    diagnostics: {
      workstream_files: items.length,
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

export function makeHealth(
  presence: "absent" | "present" = "present",
): import("../../src/reader/types.js").ReaderStoreHealth {
  return {
    presence,
    read_state: "ok",
    healthy: presence === "present",
    coverage: { state: "complete" },
    diagnostics: {
      feed_files: 0,
      malformed_feed_records: 0,
      invalid_feed_records: 0,
      partial_feed_files: 0,
      scan_limited_feed_files: 0,
      invalid_active_records: 0,
      invalid_workstream_records: 0,
      invalid_participation_records: 0,
      invalid_cursor_records: 0,
      invalid_journal_records: 0,
      invalid_provider_state_records: 0,
      provider_drift: collection([]),
    },
  };
}
