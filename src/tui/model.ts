import { compareUtf16CodeUnits } from "../core/stable-json.js";
import type {
  ReaderActionSummary,
  ReaderActiveSummary,
  ReaderBoundedItems,
  ReaderContentSummary,
  ReaderContextV1,
  ReaderDiagnostics,
  ReaderProjection,
  ReaderSubagentSummary,
  ReaderTurnSummary,
} from "../reader/types.js";

/** Counts for records that survive the bounded reader projection. */
export interface VisibilityCounts {
  /** Records actually present in this view model. */
  readonly shown: number;
  /** Records reported by the reader before projection truncation. */
  readonly total: number;
  /** Records omitted by the projection. Their contents remain unknown. */
  readonly hidden: number;
}

export interface VisibleCollection<T> {
  readonly counts: VisibilityCounts;
  readonly items: readonly T[];
}

export type WorkstreamTag =
  | {
      readonly key: "unscoped";
      readonly label: "unscoped";
      readonly scoped: false;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly scoped: true;
      readonly id: string;
    };

export interface VisibleClaimViewModel {
  readonly path: string;
  readonly mode: "write";
  readonly confidence: "exact" | "inferred";
}

export interface ActiveClaimViewModel {
  readonly counts: VisibilityCounts;
  readonly items: readonly VisibleClaimViewModel[];
  readonly exact: readonly VisibleClaimViewModel[];
  readonly inferred: readonly VisibleClaimViewModel[];
}

export interface ActiveActorViewModel {
  /** Stable within a valid reader projection; suitable for selection state. */
  readonly key: string;
  readonly leaseId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly workstream: WorkstreamTag;
  readonly turnId?: string;
  readonly agentId: string;
  readonly state: ReaderActiveSummary["state"];
  /** Raw projected content. Terminal sanitization belongs to the renderer. */
  readonly intent?: ReaderContentSummary;
  /** Raw projected action. Terminal sanitization belongs to the renderer. */
  readonly currentAction?: NonNullable<ReaderActiveSummary["current_action"]>;
  readonly claims: ActiveClaimViewModel;
  readonly unknownWriteScope: boolean;
  /** Visible advisory overlaps involving this actor, sorted by raw path. */
  readonly overlapPaths: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly sourceRefs: number;
}

/**
 * Path facts derivable from one visible turn. Hidden entries are deliberately
 * not added to `visibleDistinct` because they may duplicate visible paths or
 * one another.
 */
export interface VisiblePathSummary {
  readonly items: readonly string[];
  readonly visibleDistinct: number;
  readonly visibleOccurrences: number;
  readonly hiddenChangedPathEntries: number;
  /** Hidden actions may or may not describe additional paths. */
  readonly possiblyHiddenInActions: number;
  readonly complete: boolean;
}

export interface TurnViewModel {
  /** Stable within a valid reader projection; suitable for selection state. */
  readonly key: string;
  readonly turnId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly workstream: WorkstreamTag;
  readonly sequence: number;
  readonly agentId: string;
  readonly parentTurnId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: ReaderTurnSummary["outcome"];
  /** Raw projected content. Terminal sanitization belongs to the renderer. */
  readonly request: ReaderContentSummary;
  /** Raw projected content. Terminal sanitization belongs to the renderer. */
  readonly response?: ReaderContentSummary;
  readonly actions: VisibleCollection<ReaderActionSummary>;
  readonly evidenceRefs: ReaderTurnSummary["evidence_refs"];
  readonly subagents: ReaderSubagentSummary;
  readonly changedPaths: VisiblePathSummary;
  readonly sourceRefs: number;
}

export interface SessionViewModel {
  readonly key: string;
  readonly sessionId: string;
  readonly label: string;
  readonly providers: readonly string[];
  readonly activeActors: readonly ActiveActorViewModel[];
  readonly turns: readonly TurnViewModel[];
}

export interface WorkstreamViewModel {
  readonly tag: WorkstreamTag;
  readonly sessions: readonly SessionViewModel[];
  readonly activeActors: readonly ActiveActorViewModel[];
  readonly turns: readonly TurnViewModel[];
}

export interface VisibleClaimant {
  readonly actorKey: string;
  readonly leaseId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly workstream: WorkstreamTag;
  readonly agentId: string;
  readonly confidence: "exact" | "inferred";
}

/**
 * A duplicate path among visible advisory claims. This is display evidence,
 * never a lock or an assertion that either actor owns the path.
 */
export interface VisibleClaimOverlap {
  readonly path: string;
  readonly advisory: true;
  readonly claimants: readonly VisibleClaimant[];
  readonly exactClaimants: readonly VisibleClaimant[];
  readonly inferredClaimants: readonly VisibleClaimant[];
}

export interface VisiblePathMetrics extends VisiblePathSummary {
  /** Entire hidden turns may contain paths, but their number is unknowable. */
  readonly hiddenTurns: number;
}

/** Analytics derived only from turns present in this bounded projection. */
export interface VisibleMetrics {
  readonly outcomes: ReadonlyMap<string, number>;
  readonly actions: ReadonlyMap<string, number>;
  /** Action bounds aggregated only across the visible turns above. */
  readonly actionVisibility: VisibilityCounts;
  readonly providers: ReadonlyMap<string, number>;
  /** Subagent totals attached to visible turns; hidden turns are excluded. */
  readonly subagents: number;
  readonly paths: VisiblePathMetrics;
}

export type StoreDiagnosticId =
  | "malformed_feed_records"
  | "invalid_feed_records"
  | "partial_feed_files"
  | "scan_limited_feed_files"
  | "invalid_active_records";

export interface StoreDiagnosticIssue {
  readonly id: StoreDiagnosticId;
  readonly label: string;
  readonly count: number;
}

export interface StoreDiagnosticsViewModel {
  /** The complete reader diagnostic record, unchanged. */
  readonly values: ReaderDiagnostics;
  readonly feedFiles: number;
  readonly issues: readonly StoreDiagnosticIssue[];
  readonly issueCount: number;
  readonly healthy: boolean;
}

export interface DashboardViewModel {
  readonly projection: {
    readonly byteBudget: number;
    readonly utf8Bytes: number;
  };
  /** Present only when the reader itself was scoped to one workstream. */
  readonly scope?: WorkstreamTag;
  readonly workstreams: readonly WorkstreamViewModel[];
  readonly active: VisibleCollection<ActiveActorViewModel>;
  readonly turns: VisibleCollection<TurnViewModel>;
  readonly overlaps: readonly VisibleClaimOverlap[];
  readonly metrics: VisibleMetrics;
  readonly diagnostics: StoreDiagnosticsViewModel;
}

interface ActiveActorCore extends Omit<ActiveActorViewModel, "overlapPaths"> {}

interface MutableSessionGroup {
  readonly sessionId: string;
  readonly activeActors: ActiveActorViewModel[];
  readonly turns: TurnViewModel[];
}

interface MutableWorkstreamGroup {
  readonly tag: WorkstreamTag;
  readonly sessions: Map<string, MutableSessionGroup>;
}

const DIAGNOSTICS: readonly {
  readonly id: StoreDiagnosticId;
  readonly label: string;
}[] = [
  { id: "malformed_feed_records", label: "malformed feed" },
  { id: "invalid_feed_records", label: "invalid feed" },
  { id: "partial_feed_files", label: "partial feed" },
  { id: "scan_limited_feed_files", label: "scan limited" },
  { id: "invalid_active_records", label: "invalid active" },
];

/** Build a deterministic, pure presentation model from the bounded reader. */
export function buildDashboardViewModel(
  projection: ReaderProjection<ReaderContextV1>,
): DashboardViewModel {
  const context = projection.value;
  const activeCores = context.active.items
    .map(activeActorCore)
    .sort(compareActors);
  const overlaps = visibleClaimOverlaps(activeCores);
  const overlapPathsByActor = new Map<string, string[]>();
  for (const overlap of overlaps) {
    for (const claimant of overlap.claimants) {
      const paths = overlapPathsByActor.get(claimant.actorKey) ?? [];
      paths.push(overlap.path);
      overlapPathsByActor.set(claimant.actorKey, paths);
    }
  }
  const activeItems: ActiveActorViewModel[] = activeCores.map((actor) => ({
    ...actor,
    overlapPaths: overlapPathsByActor.get(actor.key) ?? [],
  }));
  const turnItems = context.turns.items.map(turnViewModel).sort(compareTurns);
  const workstreams = groupVisibleRecords(activeItems, turnItems);
  const active = {
    counts: visibilityCounts(context.active),
    items: activeItems,
  };
  const turns = {
    counts: visibilityCounts(context.turns),
    items: turnItems,
  };

  return {
    projection: {
      byteBudget: projection.byte_budget,
      utf8Bytes: projection.utf8_bytes,
    },
    ...(context.workstream_id === undefined
      ? {}
      : { scope: workstreamTag(context.workstream_id) }),
    workstreams,
    active,
    turns,
    overlaps,
    metrics: visibleMetrics(turns),
    diagnostics: storeDiagnostics(context.diagnostics),
  };
}

/** Human-facing label for a workstream stamp; no stamp is explicitly unscoped. */
export function shortWorkstreamLabel(workstreamId: string | undefined): string {
  if (workstreamId === undefined) return "unscoped";
  const suffix = workstreamId.startsWith("ws_")
    ? workstreamId.slice(3, 11)
    : workstreamId.slice(0, 8);
  return `ws_${suffix}`;
}

/** Human-facing session tag that keeps the id namespace visible. */
export function shortSessionLabel(sessionId: string): string {
  const suffix = sessionId.startsWith("ses_")
    ? sessionId.slice(4, 12)
    : sessionId.slice(0, 8);
  return `ses_${suffix}`;
}

function workstreamTag(workstreamId: string | undefined): WorkstreamTag {
  return workstreamId === undefined
    ? { key: "unscoped", label: "unscoped", scoped: false }
    : {
        key: workstreamId,
        label: shortWorkstreamLabel(workstreamId),
        scoped: true,
        id: workstreamId,
      };
}

function visibilityCounts<T>(bounded: ReaderBoundedItems<T>): VisibilityCounts {
  // `items.length` is the observable truth if a malformed caller ever makes
  // `shown` disagree with the array. Valid reader projections make them equal.
  const shown = bounded.items.length;
  const total = Math.max(shown, bounded.total);
  return { shown, total, hidden: total - shown };
}

function activeActorCore(actor: ReaderActiveSummary): ActiveActorCore {
  const claims = [...actor.claims.items]
    .map((claim) => ({ ...claim }))
    .sort(compareClaims);
  return {
    key: actorKey(actor),
    leaseId: actor.lease_id,
    provider: actor.provider,
    sessionId: actor.session_id,
    sessionLabel: shortSessionLabel(actor.session_id),
    workstream: workstreamTag(actor.workstream_id),
    ...(actor.turn_id === undefined ? {} : { turnId: actor.turn_id }),
    agentId: actor.agent_id,
    state: actor.state,
    ...(actor.intent === undefined ? {} : { intent: actor.intent }),
    ...(actor.current_action === undefined
      ? {}
      : { currentAction: actor.current_action }),
    claims: {
      counts: visibilityCounts(actor.claims),
      items: claims,
      exact: claims.filter((claim) => claim.confidence === "exact"),
      inferred: claims.filter((claim) => claim.confidence === "inferred"),
    },
    unknownWriteScope: actor.unknown_write_scope,
    revision: actor.revision,
    updatedAt: actor.updated_at,
    expiresAt: actor.expires_at,
    sourceRefs: actor.source_refs,
  };
}

function turnViewModel(turn: ReaderTurnSummary): TurnViewModel {
  const actions = [...turn.actions.items].sort(compareActions);
  const actionCounts = visibilityCounts(turn.actions);
  return {
    key: turn.turn_id,
    turnId: turn.turn_id,
    provider: turn.provider,
    sessionId: turn.session_id,
    sessionLabel: shortSessionLabel(turn.session_id),
    workstream: workstreamTag(turn.workstream_id),
    sequence: turn.sequence,
    agentId: turn.agent_id,
    ...(turn.parent_turn_id === undefined
      ? {}
      : { parentTurnId: turn.parent_turn_id }),
    startedAt: turn.started_at,
    endedAt: turn.ended_at,
    outcome: turn.outcome,
    request: turn.request,
    ...(turn.response === undefined ? {} : { response: turn.response }),
    actions: { counts: actionCounts, items: actions },
    evidenceRefs: turn.evidence_refs,
    subagents: turn.subagents,
    changedPaths: changedPaths(turn, actions, actionCounts),
    sourceRefs: turn.source_refs,
  };
}

function changedPaths(
  turn: ReaderTurnSummary,
  actions: readonly ReaderActionSummary[],
  actionCounts: VisibilityCounts,
): VisiblePathSummary {
  const occurrences = [
    ...actions.flatMap((action) =>
      action.kind === "file_change" && action.path !== undefined
        ? [action.path]
        : [],
    ),
    ...turn.subagents.changed_paths.items,
  ];
  const items = sortedUnique(occurrences);
  const changedPathCounts = visibilityCounts(turn.subagents.changed_paths);
  const hiddenChangedPathEntries = changedPathCounts.hidden;
  const possiblyHiddenInActions = actionCounts.hidden;
  return {
    items,
    visibleDistinct: items.length,
    visibleOccurrences: occurrences.length,
    hiddenChangedPathEntries,
    possiblyHiddenInActions,
    complete: hiddenChangedPathEntries === 0 && possiblyHiddenInActions === 0,
  };
}

function visibleClaimOverlaps(
  actors: readonly ActiveActorCore[],
): VisibleClaimOverlap[] {
  const byPath = new Map<string, Map<string, VisibleClaimant>>();
  for (const actor of actors) {
    for (const claim of actor.claims.items) {
      let claimants = byPath.get(claim.path);
      if (claimants === undefined) {
        claimants = new Map();
        byPath.set(claim.path, claimants);
      }
      const existing = claimants.get(actor.key);
      // A duplicate claim from the same actor is one claimant. Prefer exact
      // confidence when both exact and inferred versions are visible.
      if (existing?.confidence === "exact") continue;
      const claimant: VisibleClaimant = {
        actorKey: actor.key,
        leaseId: actor.leaseId,
        provider: actor.provider,
        sessionId: actor.sessionId,
        sessionLabel: actor.sessionLabel,
        workstream: actor.workstream,
        agentId: actor.agentId,
        confidence: claim.confidence,
      };
      claimants.set(actor.key, claimant);
    }
  }

  return [...byPath.entries()]
    .filter(([, claimants]) => claimants.size > 1)
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([path, byActor]) => {
      const claimants = [...byActor.values()].sort(compareClaimants);
      return {
        path,
        advisory: true,
        claimants,
        exactClaimants: claimants.filter(
          (claimant) => claimant.confidence === "exact",
        ),
        inferredClaimants: claimants.filter(
          (claimant) => claimant.confidence === "inferred",
        ),
      };
    });
}

function groupVisibleRecords(
  actors: readonly ActiveActorViewModel[],
  turns: readonly TurnViewModel[],
): WorkstreamViewModel[] {
  const groups = new Map<string, MutableWorkstreamGroup>();
  const ensureSession = (
    tag: WorkstreamTag,
    sessionId: string,
  ): MutableSessionGroup => {
    let workstream = groups.get(tag.key);
    if (workstream === undefined) {
      workstream = { tag, sessions: new Map() };
      groups.set(tag.key, workstream);
    }
    let session = workstream.sessions.get(sessionId);
    if (session === undefined) {
      session = { sessionId, activeActors: [], turns: [] };
      workstream.sessions.set(sessionId, session);
    }
    return session;
  };

  for (const actor of actors) {
    ensureSession(actor.workstream, actor.sessionId).activeActors.push(actor);
  }
  for (const turn of turns) {
    ensureSession(turn.workstream, turn.sessionId).turns.push(turn);
  }

  return [...groups.values()]
    .sort((left, right) => compareWorkstreams(left.tag, right.tag))
    .map((workstream) => {
      const sessions: SessionViewModel[] = [...workstream.sessions.values()]
        .sort((left, right) =>
          compareUtf16CodeUnits(left.sessionId, right.sessionId),
        )
        .map((session) => ({
          key: `${workstream.tag.key}\0${session.sessionId}`,
          sessionId: session.sessionId,
          label: shortSessionLabel(session.sessionId),
          providers: sortedUnique([
            ...session.activeActors.map((actor) => actor.provider),
            ...session.turns.map((turn) => turn.provider),
          ]),
          activeActors: session.activeActors,
          turns: session.turns,
        }));
      return {
        tag: workstream.tag,
        sessions,
        activeActors: sessions.flatMap((session) => session.activeActors),
        turns: sessions.flatMap((session) => session.turns),
      };
    });
}

function visibleMetrics(
  turns: VisibleCollection<TurnViewModel>,
): VisibleMetrics {
  const outcomes = new Map<string, number>();
  const actions = new Map<string, number>();
  const providers = new Map<string, number>();
  const paths: string[] = [];
  let shownActions = 0;
  let totalActions = 0;
  let subagents = 0;
  let visibleOccurrences = 0;
  let hiddenChangedPathEntries = 0;
  let possiblyHiddenInActions = 0;

  for (const turn of turns.items) {
    increment(outcomes, turn.outcome);
    increment(providers, turn.provider);
    subagents += turn.subagents.total;
    shownActions += turn.actions.counts.shown;
    totalActions += turn.actions.counts.total;
    for (const action of turn.actions.items) increment(actions, action.kind);
    paths.push(...turn.changedPaths.items);
    visibleOccurrences += turn.changedPaths.visibleOccurrences;
    hiddenChangedPathEntries += turn.changedPaths.hiddenChangedPathEntries;
    possiblyHiddenInActions += turn.changedPaths.possiblyHiddenInActions;
  }
  const distinctPaths = sortedUnique(paths);
  const actionVisibility = {
    shown: shownActions,
    total: totalActions,
    hidden: totalActions - shownActions,
  };
  const hiddenTurns = turns.counts.hidden;

  return {
    outcomes: sortedCounts(outcomes),
    actions: sortedCounts(actions),
    actionVisibility,
    providers: sortedCounts(providers),
    subagents,
    paths: {
      items: distinctPaths,
      visibleDistinct: distinctPaths.length,
      visibleOccurrences,
      hiddenChangedPathEntries,
      possiblyHiddenInActions,
      hiddenTurns,
      complete:
        hiddenChangedPathEntries === 0 &&
        possiblyHiddenInActions === 0 &&
        hiddenTurns === 0,
    },
  };
}

function storeDiagnostics(
  diagnostics: ReaderDiagnostics,
): StoreDiagnosticsViewModel {
  const issues = DIAGNOSTICS.flatMap(({ id, label }) => {
    const count = diagnostics[id];
    return count > 0 ? [{ id, label, count }] : [];
  });
  const issueCount = issues.reduce((total, issue) => total + issue.count, 0);
  return {
    values: diagnostics,
    feedFiles: diagnostics.feed_files,
    issues,
    issueCount,
    healthy: issueCount === 0,
  };
}

function actorKey(
  actor: Pick<ReaderActiveSummary, "provider" | "session_id" | "agent_id">,
): string {
  return [actor.provider, actor.session_id, actor.agent_id].join("\0");
}

function compareActors(left: ActiveActorCore, right: ActiveActorCore): number {
  return (
    compareWorkstreams(left.workstream, right.workstream) ||
    compareUtf16CodeUnits(left.sessionId, right.sessionId) ||
    timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt) ||
    compareUtf16CodeUnits(left.provider, right.provider) ||
    compareUtf16CodeUnits(left.agentId, right.agentId) ||
    compareUtf16CodeUnits(left.leaseId, right.leaseId)
  );
}

function compareTurns(left: TurnViewModel, right: TurnViewModel): number {
  return (
    compareWorkstreams(left.workstream, right.workstream) ||
    compareUtf16CodeUnits(left.sessionId, right.sessionId) ||
    timestampMillis(right.endedAt) - timestampMillis(left.endedAt) ||
    compareUtf16CodeUnits(left.provider, right.provider) ||
    right.sequence - left.sequence ||
    compareUtf16CodeUnits(left.turnId, right.turnId)
  );
}

function compareWorkstreams(left: WorkstreamTag, right: WorkstreamTag): number {
  if (!left.scoped && right.scoped) return -1;
  if (left.scoped && !right.scoped) return 1;
  return compareUtf16CodeUnits(left.key, right.key);
}

function compareClaims(
  left: VisibleClaimViewModel,
  right: VisibleClaimViewModel,
): number {
  return (
    compareUtf16CodeUnits(left.path, right.path) ||
    compareUtf16CodeUnits(left.confidence, right.confidence)
  );
}

function compareClaimants(left: VisibleClaimant, right: VisibleClaimant): number {
  return (
    compareWorkstreams(left.workstream, right.workstream) ||
    compareUtf16CodeUnits(left.sessionId, right.sessionId) ||
    compareUtf16CodeUnits(left.provider, right.provider) ||
    compareUtf16CodeUnits(left.agentId, right.agentId) ||
    compareUtf16CodeUnits(left.leaseId, right.leaseId)
  );
}

function compareActions(
  left: ReaderActionSummary,
  right: ReaderActionSummary,
): number {
  return compareUtf16CodeUnits(left.action_id, right.action_id);
}

function timestampMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items)].sort(compareUtf16CodeUnits);
}

function sortedCounts(
  counts: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  return new Map(
    [...counts.entries()].sort(([left], [right]) =>
      compareUtf16CodeUnits(left, right),
    ),
  );
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
