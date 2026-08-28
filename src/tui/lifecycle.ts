import {
  isWorkstreamId,
  isWorkstreamName,
  type WorkstreamStatus,
} from "../workstreams/types.js";
import type { ReaderCatalogueWorkstream } from "../reader/catalogue.js";
import type { ReaderCollection } from "../reader/types.js";

import { HORSE_FRAME_COUNT } from "./horse.js";
import { compactAge, relativeAgo } from "./reduce.js";

export const LIFECYCLE_MOTION_INTERVAL_MS = 100;
export const LIFECYCLE_PASS_TICKS = HORSE_FRAME_COUNT;

const DECISION_MARKER_PHASE_TICKS = 5;

export type LifecycleMotionMode = "live" | "paused" | "off";

export interface LifecycleTraversalProgress {
  /** The shared horse plate to paint for this tick. */
  readonly frameIndex: number;
  /** Horizontal progress from fully off-left to fully off-right. */
  readonly position: number;
  readonly completedPasses: number;
  /** True on a reset tick after at least one complete pass. */
  readonly atPassBoundary: boolean;
}

export type LifecycleTraversalGateDecision =
  | "continue"
  | "finish"
  | "interrupt";

/** A lifecycle transition always targets the stable ID captured at selection. */
export type LifecycleAction = "complete" | "reopen";

export interface LifecycleRecord {
  readonly workstream_id: string;
  readonly name: string;
  readonly title?: string;
  readonly status: WorkstreamStatus;
  readonly revision: number;
}

/**
 * The selection snapshot held through confirmation and settlement. Names are
 * mutable display text; `workstreamId` is the only writer target.
 */
export interface LifecycleTarget {
  readonly workstreamId: string;
  readonly name: string;
  readonly status: WorkstreamStatus;
  readonly revision: number;
}

export interface LifecycleProviderSessions {
  readonly provider: string;
  readonly sessions: number;
}

export interface LifecycleJoinedEvidence {
  readonly providers: readonly LifecycleProviderSessions[];
  readonly shownSessions: number;
  readonly completeness: "complete" | "incomplete";
}

export type LifecycleActivityEvidence =
  | { readonly kind: "latest"; readonly at: string }
  | { readonly kind: "none" }
  | { readonly kind: "latest_known"; readonly at: string }
  | {
      readonly kind: "unknown";
      readonly history: "complete" | "incomplete";
    };

export interface LifecycleUnreadProvider {
  readonly provider: string;
  readonly sessionsWithUnread: number;
  readonly unreadCount: number;
}

export interface LifecycleUnreadEvidence {
  readonly providers: readonly LifecycleUnreadProvider[];
  readonly knownUnreadCount: number;
  readonly completeness: "complete" | "incomplete";
}

/** Decision evidence pinned once, before the confirmation key can write. */
export interface LifecycleConfirmationEvidence {
  readonly referenceAt: string;
  readonly title?: string;
  readonly joined: LifecycleJoinedEvidence;
  readonly activity: LifecycleActivityEvidence;
  readonly unread: LifecycleUnreadEvidence;
}

export interface LifecycleConfirmState {
  readonly kind: "confirm";
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly evidence: LifecycleConfirmationEvidence;
}

export interface LifecyclePendingState {
  readonly kind: "pending";
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly cancelRequested: boolean;
}

export interface LifecycleConfirmedState {
  readonly kind: "confirmed";
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly record: LifecycleRecord;
  /** True only when the public writer response also corroborated the read. */
  readonly writerConfirmed: boolean;
  readonly warning?: string;
}

export interface LifecycleFailureState {
  readonly kind: "failed";
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly message: string;
  readonly warning?: string;
}

export interface LifecycleCancelledState {
  readonly kind: "cancelled";
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly warning?: string;
}

export interface LifecycleUnknownState {
  readonly kind: "unknown";
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly warning?: string;
}

export type LifecycleSettledState =
  | LifecycleConfirmedState
  | LifecycleFailureState
  | LifecycleCancelledState
  | LifecycleUnknownState;

export type LifecycleState =
  | LifecycleConfirmState
  | LifecyclePendingState
  | LifecycleSettledState;

export type LifecycleTraversalSettlementKind =
  LifecycleSettledState["kind"];

export interface LifecycleWriterOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly cancelled: boolean;
}

export type LifecycleLookup = LifecycleRecord | "absent" | "unknown";

export interface LifecycleReconcileInput {
  readonly action: LifecycleAction;
  readonly target: LifecycleTarget;
  readonly outcome: LifecycleWriterOutcome;
  /**
   * The post-writer catalogue lookup by immutable ID: a record, a proven
   * absence from a complete read, or an incomplete/refused read.
   */
  readonly lookup: LifecycleLookup;
}

/**
 * The decision marker blinks in calm half-second phases on the shared 100 ms
 * clock. Static and paused motion always retain the visible marker.
 */
export function lifecycleDecisionMarkerVisible(
  tick: number,
  motion: LifecycleMotionMode,
): boolean {
  assertLifecycleTick(tick);
  if (motion !== "live") return true;
  return (
    tick % (DECISION_MARKER_PHASE_TICKS * 2) <
    DECISION_MARKER_PHASE_TICKS
  );
}

/** Resolve plate, spatial position, and pass boundary from elapsed ticks. */
export function lifecycleTraversalProgressAtTick(
  ticksElapsed: number,
): LifecycleTraversalProgress {
  assertLifecycleTick(ticksElapsed);
  const frameIndex = ticksElapsed % LIFECYCLE_PASS_TICKS;
  return Object.freeze({
    frameIndex,
    position: frameIndex / (LIFECYCLE_PASS_TICKS - 1),
    completedPasses: Math.floor(ticksElapsed / LIFECYCLE_PASS_TICKS),
    atPassBoundary: ticksElapsed > 0 && frameIndex === 0,
  });
}

/**
 * Gate the run-through independently from writer execution. Unresolved work
 * loops full passes, confirmation finishes only at a pass boundary, and every
 * non-success settlement interrupts immediately.
 */
export function lifecycleTraversalGate(
  progress: LifecycleTraversalProgress,
  settlement: LifecycleTraversalSettlementKind | undefined,
): LifecycleTraversalGateDecision {
  if (
    settlement === "failed" ||
    settlement === "cancelled" ||
    settlement === "unknown"
  ) {
    return "interrupt";
  }
  if (
    settlement === "confirmed" &&
    progress.atPassBoundary &&
    progress.completedPasses > 0
  ) {
    return "finish";
  }
  return "continue";
}

/** The action advertised for the selected record's current status. */
export function lifecycleActionFor(
  status: WorkstreamStatus,
): LifecycleAction {
  return status === "open" ? "complete" : "reopen";
}

export function desiredLifecycleStatus(
  action: LifecycleAction,
): WorkstreamStatus {
  return action === "complete" ? "completed" : "open";
}

/** Capture and freeze the identity/status evidence shown at confirmation. */
export function captureLifecycleTarget(
  record: LifecycleRecord,
): LifecycleTarget {
  if (!isWorkstreamId(record.workstream_id)) {
    throw new TypeError("Lifecycle target has an invalid workstream ID");
  }
  if (!isWorkstreamName(record.name)) {
    throw new TypeError("Lifecycle target has an invalid workstream name");
  }
  if (record.status !== "open" && record.status !== "completed") {
    throw new TypeError("Lifecycle target has an invalid status");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new TypeError("Lifecycle target has an invalid revision");
  }
  return Object.freeze({
    workstreamId: record.workstream_id,
    name: record.name,
    status: record.status,
    revision: record.revision,
  });
}

/**
 * Capture current-member, activity, and recipient-relative unread evidence.
 * Every nested value is frozen so refreshes cannot rewrite the decision under
 * the user's cursor. Incomplete evidence remains explicitly incomplete.
 */
export function captureLifecycleConfirmationEvidence(
  item: ReaderCatalogueWorkstream,
  referenceAt: string,
): LifecycleConfirmationEvidence {
  const joined = captureJoinedEvidence(item);
  const activity = captureActivityEvidence(item, referenceAt);
  const unread = captureUnreadEvidence(item, joined);
  return Object.freeze({
    referenceAt,
    ...(item.record.title === undefined ? {} : { title: item.record.title }),
    joined,
    activity,
    unread,
  });
}

export function beginLifecycle(
  item: ReaderCatalogueWorkstream,
  referenceAt: string,
): LifecycleConfirmState {
  const target = captureLifecycleTarget(item.record);
  return Object.freeze({
    kind: "confirm",
    action: lifecycleActionFor(target.status),
    target,
    evidence: captureLifecycleConfirmationEvidence(item, referenceAt),
  });
}

/** Calm confirmation copy for the current-membership evidence. */
export function lifecycleJoinedLine(
  evidence: LifecycleJoinedEvidence,
): string {
  const providers = providerSessionDetails(evidence.providers);
  if (evidence.completeness === "complete") {
    if (evidence.shownSessions === 0) return "No joined sessions";
    const noun = evidence.shownSessions === 1 ? "session" : "sessions";
    return `${evidence.shownSessions} joined ${noun} · ${providers}`;
  }
  if (evidence.shownSessions === 0) {
    return "Joined-session count is unknown";
  }
  return `Joined total unknown · ${providers} shown`;
}

/** Compact joined count for the target ledger under the card. */
export function lifecycleJoinedCountLine(
  evidence: LifecycleJoinedEvidence,
): string {
  if (evidence.completeness === "incomplete") {
    return evidence.shownSessions === 0
      ? "joined count unknown"
      : `${evidence.shownSessions}+ joined`;
  }
  const noun = evidence.shownSessions === 1 ? "session" : "sessions";
  return `${evidence.shownSessions} joined ${noun}`;
}

/** Provider-grouped membership evidence compact enough for the lower bench. */
export function lifecycleJoinedBenchLine(
  evidence: LifecycleJoinedEvidence,
): string {
  const providers = providerSessionDetails(evidence.providers);
  if (evidence.completeness === "complete") {
    return evidence.shownSessions === 0 ? "No joined sessions" : providers;
  }
  return evidence.shownSessions === 0
    ? "Joined count unknown"
    : `${providers} shown · joined total unknown`;
}

/** Calm confirmation copy for pinned activity evidence. */
export function lifecycleActivityLine(
  evidence: LifecycleActivityEvidence,
  referenceAt: string,
): string {
  switch (evidence.kind) {
    case "latest":
      return usablePastTimestamp(evidence.at, referenceAt)
        ? `Latest proven activity · ${relativeAgo(evidence.at, referenceAt)}`
        : "Latest activity is unknown";
    case "none":
      return "No recorded activity";
    case "latest_known":
      return usablePastTimestamp(evidence.at, referenceAt)
        ? `Latest known activity · ${relativeAgo(evidence.at, referenceAt)} · incomplete`
        : "Activity history is incomplete";
    case "unknown":
      return evidence.history === "incomplete"
        ? "Activity history is incomplete"
        : "Latest activity is unknown";
  }
}

/**
 * Unread counts are recipient-relative. Multi-provider copy therefore groups
 * them by joined session and never presents their sum as unique project news.
 */
export function lifecycleUnreadLine(
  evidence: LifecycleUnreadEvidence,
): string {
  if (evidence.completeness === "complete") {
    if (evidence.knownUnreadCount === 0) {
      return "No unread turns for joined sessions";
    }
    if (
      evidence.providers.length === 1 &&
      evidence.providers[0]!.sessionsWithUnread === 1
    ) {
      const provider = providerDisplayName(evidence.providers[0]!.provider);
      const count = evidence.providers[0]!.unreadCount;
      const noun = count === 1 ? "turn" : "turns";
      return `A ${provider} session here has ${count} unread ${noun}.`;
    }
    return `Joined-session unread · ${providerUnreadDetails(evidence.providers)}`;
  }
  if (evidence.knownUnreadCount === 0) return "Unread count is unknown";
  return `Unread total unknown · ${providerUnreadDetails(evidence.providers, true)}`;
}

/** Compact target-ledger evidence; unread totals stay session-qualified. */
export function lifecycleEvidenceBenchLine(
  evidence: LifecycleConfirmationEvidence,
): string {
  const sessions = evidence.unread.providers.reduce(
    (sum, provider) => sum + provider.sessionsWithUnread,
    0,
  );
  const unread =
    evidence.unread.completeness === "complete"
      ? evidence.unread.knownUnreadCount === 0
        ? "no unread"
        : `${evidence.unread.knownUnreadCount} unread${sessions > 1 ? ` across ${sessions} sessions` : ""}`
      : evidence.unread.knownUnreadCount === 0
        ? "unread unknown"
        : `${evidence.unread.knownUnreadCount} known unread${sessions > 1 ? ` across ${sessions} sessions` : ""}`;
  return `${unread} · ${compactActivityEvidence(evidence.activity, evidence.referenceAt)}`;
}

function captureJoinedEvidence(
  item: ReaderCatalogueWorkstream,
): LifecycleJoinedEvidence {
  const counts = new Map<string, number>();
  for (const member of item.members.items) {
    counts.set(member.provider, (counts.get(member.provider) ?? 0) + 1);
  }
  const providers = freezeRows(
    [...counts.entries()]
      .map(([provider, sessions]) => ({ provider, sessions }))
      .sort((left, right) => compareProvider(left.provider, right.provider)),
  );
  return Object.freeze({
    providers,
    shownSessions: item.members.items.length,
    completeness: collectionIsExact(item.members)
      ? "complete"
      : "incomplete",
  });
}

function captureActivityEvidence(
  item: ReaderCatalogueWorkstream,
  referenceAt: string,
): LifecycleActivityEvidence {
  const historyComplete =
    item.activity.full_history.state === "complete" &&
    item.activity.turns.read_state === "ok" &&
    item.activity.turns.coverage.state === "complete";
  const at = item.activity.last_known_activity_at;
  if (at === undefined) {
    if (historyComplete && item.activity.proven_empty) {
      return Object.freeze({ kind: "none" });
    }
    return Object.freeze({
      kind: "unknown",
      history: historyComplete ? "complete" : "incomplete",
    });
  }
  if (!usablePastTimestamp(at, referenceAt)) {
    return Object.freeze({
      kind: "unknown",
      history: historyComplete ? "complete" : "incomplete",
    });
  }
  return historyComplete
    ? Object.freeze({ kind: "latest", at })
    : Object.freeze({ kind: "latest_known", at });
}

function captureUnreadEvidence(
  item: ReaderCatalogueWorkstream,
  joined: LifecycleJoinedEvidence,
): LifecycleUnreadEvidence {
  // With a complete empty member set there are no joined recipients, so the
  // recipient-relative unread set is provably empty even if no unread batch
  // was materialized.
  if (
    joined.completeness === "complete" &&
    joined.shownSessions === 0
  ) {
    return Object.freeze({
      providers: Object.freeze([]),
      knownUnreadCount: 0,
      completeness: "complete",
    });
  }
  const memberKeys = new Set(
    item.members.items.map((member) =>
      unreadKey(
        member.provider,
        member.session_id,
        item.record.workstream_id,
        member.membership_from,
      ),
    ),
  );
  const seen = new Set<string>();
  const grouped = new Map<
    string,
    { sessionsWithUnread: number; unreadCount: number }
  >();
  let knownUnreadCount = 0;
  let allSummariesExact = true;
  let sumsSafe = true;
  const unread = item.unread;
  const keyCounts = new Map<string, number>();

  for (const summary of unread?.items ?? []) {
    const key = unreadKey(
      summary.key.provider,
      summary.key.session_id,
      summary.key.workstream_id,
      summary.key.membership_from,
    );
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    if (!memberKeys.has(key)) allSummariesExact = false;
  }

  for (const summary of unread?.items ?? []) {
    const key = unreadKey(
      summary.key.provider,
      summary.key.session_id,
      summary.key.workstream_id,
      summary.key.membership_from,
    );
    if (!memberKeys.has(key)) continue;
    if (keyCounts.get(key) !== 1) {
      allSummariesExact = false;
      continue;
    }
    seen.add(key);
    if (
      summary.status !== "ready" ||
      summary.read_state !== "ok" ||
      summary.coverage.state !== "complete" ||
      !Number.isSafeInteger(summary.unread_count) ||
      summary.unread_count < 0
    ) {
      allSummariesExact = false;
      continue;
    }
    if (summary.unread_count === 0) continue;

    const previous = grouped.get(summary.key.provider) ?? {
      sessionsWithUnread: 0,
      unreadCount: 0,
    };
    const providerTotal = previous.unreadCount + summary.unread_count;
    const knownTotal = knownUnreadCount + summary.unread_count;
    if (
      !Number.isSafeInteger(providerTotal) ||
      !Number.isSafeInteger(knownTotal)
    ) {
      sumsSafe = false;
      allSummariesExact = false;
      continue;
    }
    grouped.set(summary.key.provider, {
      sessionsWithUnread: previous.sessionsWithUnread + 1,
      unreadCount: providerTotal,
    });
    knownUnreadCount = knownTotal;
  }

  const providers = freezeRows(
    [...grouped.entries()]
      .map(([provider, values]) => ({ provider, ...values }))
      .sort((left, right) => compareProvider(left.provider, right.provider)),
  );
  const complete =
    unread !== undefined &&
    joined.completeness === "complete" &&
    collectionIsExact(unread) &&
    unread.total === item.members.total &&
    seen.size === memberKeys.size &&
    allSummariesExact &&
    sumsSafe;
  return Object.freeze({
    providers,
    knownUnreadCount,
    completeness: complete ? "complete" : "incomplete",
  });
}

function collectionIsExact<T>(value: ReaderCollection<T>): boolean {
  return (
    value.read_state === "ok" &&
    value.coverage.state === "complete" &&
    value.hidden === 0 &&
    value.shown === value.total &&
    value.items.length === value.shown
  );
}

function usablePastTimestamp(value: string, referenceAt: string): boolean {
  const timestamp = Date.parse(value);
  const reference = Date.parse(referenceAt);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(reference) &&
    timestamp <= reference
  );
}

function unreadKey(
  provider: string,
  sessionId: string,
  workstreamId: string,
  membershipFrom: string,
): string {
  return [provider, sessionId, workstreamId, membershipFrom].join("\u0000");
}

function freezeRows<T extends object>(rows: T[]): readonly Readonly<T>[] {
  for (const row of rows) Object.freeze(row);
  return Object.freeze(rows);
}

function providerSessionDetails(
  providers: readonly LifecycleProviderSessions[],
): string {
  return providers
    .map((entry) => `${providerDisplayName(entry.provider)} ${entry.sessions}`)
    .join(" · ");
}

function providerUnreadDetails(
  providers: readonly LifecycleUnreadProvider[],
  known = false,
): string {
  return providers
    .map(
      (entry) =>
        `${providerDisplayName(entry.provider)} ${entry.unreadCount}${known ? " known" : ""}${entry.sessionsWithUnread > 1 ? ` across ${entry.sessionsWithUnread} sessions` : ""}`,
    )
    .join(" · ");
}

function compactActivityEvidence(
  evidence: LifecycleActivityEvidence,
  referenceAt: string,
): string {
  if (evidence.kind === "none") return "no recorded activity";
  if (evidence.kind === "unknown") {
    return evidence.history === "incomplete"
      ? "activity history incomplete"
      : "activity unknown";
  }
  if (!usablePastTimestamp(evidence.at, referenceAt)) {
    return evidence.kind === "latest_known"
      ? "activity history incomplete"
      : "activity unknown";
  }
  const age = compactAge(Date.parse(referenceAt) - Date.parse(evidence.at));
  return evidence.kind === "latest"
    ? `latest activity ${age}`
    : `latest known ${age}`;
}

function compareProvider(left: string, right: string): number {
  const rank = (provider: string): number =>
    provider === "codex" ? 0 : provider === "claude" ? 1 : 2;
  return rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0);
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    default:
      return provider.length === 0
        ? "Unknown provider"
        : `${provider[0]!.toUpperCase()}${provider.slice(1)}`;
  }
}

/**
 * Exact public-CLI argv. The target is the immutable workstream ID, never its
 * renameable human handle, and no argument is interpolated through a shell.
 */
export function lifecycleArgv(
  action: LifecycleAction,
  target: LifecycleTarget,
  projectRoot: string,
): readonly string[] {
  return Object.freeze([
    "workstream",
    action,
    target.workstreamId,
    "--project-root",
    projectRoot,
  ]);
}

/** Collapse writer stderr into safe, single-line UI text without hiding it. */
export function lifecycleWarning(stderr: string): string | undefined {
  const warning = stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return warning.length === 0 ? undefined : warning;
}

/**
 * Parse corroborating writer evidence. This never settles the transition by
 * itself: Cycle 7 requires a post-writer catalogue read before success.
 */
export function parseLifecycleWriterRecord(
  stdout: string,
  action: LifecycleAction,
  target: LifecycleTarget,
): LifecycleRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  const record = lifecycleRecord(
    value,
    target,
    desiredLifecycleStatus(action),
  );
  return record !== undefined && record.revision >= target.revision
    ? record
    : undefined;
}

/**
 * Pure settlement matrix. A reconciled desired status wins even when the
 * process exit was ambiguous; a successful process response cannot replace
 * reconciliation. Same revisions are accepted for idempotent CLI results.
 */
export function settleLifecycle(
  input: LifecycleReconcileInput,
): LifecycleSettledState {
  const warning = lifecycleWarning(input.outcome.stderr ?? "");
  const base = {
    action: input.action,
    target: input.target,
    ...(warning === undefined ? {} : { warning }),
  } as const;
  const desired = desiredLifecycleStatus(input.action);
  const observed =
    typeof input.lookup === "string"
      ? input.lookup
      : lifecycleRecord(input.lookup, input.target);

  // A complete post-writer observation is the success proof. It is stronger
  // than exit status, cancellation races, or malformed stdout.
  if (
    typeof observed !== "string" &&
    observed !== undefined &&
    observed.status === desired &&
    observed.revision >= input.target.revision
  ) {
    const writerRecord =
      input.outcome.code === 0
        ? parseLifecycleWriterRecord(
            input.outcome.stdout,
            input.action,
            input.target,
          )
        : undefined;
    return {
      kind: "confirmed",
      ...base,
      record: observed,
      writerConfirmed:
        writerRecord !== undefined &&
        writerRecord.revision === observed.revision &&
        writerRecord.status === observed.status,
    };
  }

  // Missing, refused, stale, or identity-conflicting reads cannot prove what
  // durable state followed the public command.
  if (
    observed === "unknown" ||
    observed === "absent" ||
    observed === undefined ||
    observed.revision < input.target.revision ||
    observed.status !== input.target.status ||
    observed.revision !== input.target.revision
  ) {
    return { kind: "unknown", ...base };
  }

  // The complete read proves the exact pre-command revision still exists.
  if (input.outcome.cancelled) {
    return { kind: "cancelled", ...base };
  }
  if (input.outcome.code !== null && input.outcome.code !== 0) {
    return {
      kind: "failed",
      ...base,
      message: `The writer exited ${input.outcome.code}`,
    };
  }
  return { kind: "unknown", ...base };
}

function lifecycleRecord(
  value: unknown,
  target: LifecycleTarget,
  expectedStatus?: WorkstreamStatus,
): LifecycleRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record["workstream_id"] !== target.workstreamId ||
    !isWorkstreamName(record["name"]) ||
    (record["status"] !== "open" && record["status"] !== "completed") ||
    (expectedStatus !== undefined && record["status"] !== expectedStatus) ||
    !Number.isSafeInteger(record["revision"]) ||
    Number(record["revision"]) < 1 ||
    (record["title"] !== undefined && typeof record["title"] !== "string")
  ) {
    return undefined;
  }
  return {
    workstream_id: target.workstreamId,
    name: record["name"],
    ...(record["title"] === undefined
      ? {}
      : { title: record["title"] as string }),
    status: record["status"],
    revision: Number(record["revision"]),
  };
}

function assertLifecycleTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new TypeError("tick must be a non-negative integer");
  }
}
