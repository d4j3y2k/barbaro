import { compareUtf16CodeUnits } from "../core/stable-json.js";
import type {
  ReaderCatalogueRoll,
  ReaderCatalogueV1,
  ReaderCatalogueWorkstream,
} from "../reader/catalogue.js";
import type {
  ReaderContentSummary,
  ReaderTurnSummary,
} from "../reader/types.js";
import type { ReaderUnreadSummaryReady } from "../reader/unread.js";

import { clipWords } from "./cells.js";
import { HORSE_STANDARD_FRAME_INDEX } from "./horse.js";
import type {
  ExposureRowView,
  FrameView,
  HorseView,
  HubEntryView,
  RollLineView,
} from "./view.js";

/**
 * Reducers: pinned reader projections in, frame view models and worded
 * truths out. Every sentence here obeys the comfort honesty rules — a
 * failed proof becomes its specific plain state, quiet requires
 * `quiet_proven`, unknown never renders as zero, and no screen says "idle".
 */

export interface ReducedHub {
  readonly frame: FrameView;
  readonly truth: string;
}

export type HubFilter = "open" | "completed";

export interface HubNewsTickerSelection {
  readonly key: string;
  readonly position: number;
}

export interface DashboardTurnFact {
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly outcome: string;
  readonly ended_at: string;
  readonly preview: {
    readonly source: "response" | "request" | "unavailable";
    readonly text: string;
    readonly truncated: boolean;
  };
}

export interface ReducedDashboard {
  readonly frame: FrameView;
  readonly truth: string;
}

export type WorkingDotCount = 0 | 1 | 2 | 3;

export const WORKING_DOT_HOLD_TICKS = 5;
export const WORKING_DOT_CYCLE_TICKS = WORKING_DOT_HOLD_TICKS * 4;

/** A calm four-phase ellipsis on the existing 100 ms motion clock. */
export function workingDotsAtTick(tick: number): WorkingDotCount {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new TypeError("tick must be a non-negative integer");
  }
  return Math.floor(
    (tick % WORKING_DOT_CYCLE_TICKS) / WORKING_DOT_HOLD_TICKS,
  ) as WorkingDotCount;
}

export type MotionPolicy =
  | {
      readonly kind: "live";
      readonly frameIndex: number;
      readonly workingDots: WorkingDotCount;
    }
  | { readonly kind: "off" }
  | {
      readonly kind: "paused";
      readonly frameIndex: number;
      readonly workingDots: WorkingDotCount;
    }
  | { readonly kind: "snapshot"; readonly motionOff: boolean };

export function shortSessionId(provider: string, sessionId: string): string {
  return `${provider}/${sessionId.slice(4, 12)}`;
}

export function shortWorkstreamId(workstreamId: string): string {
  return workstreamId.slice(0, 11);
}

/** The exact raw roll occupying one priority-sorted dashboard row. */
export function dashboardRollAt(
  item: ReaderCatalogueWorkstream,
  selectedRollIndex: number,
): ReaderCatalogueRoll | undefined {
  const rolls = orderedDashboardRolls(item);
  return rolls[selectedRollOffset(rolls.length, selectedRollIndex)];
}

/** §4.2's mechanical outcome map; "completed" is never substituted. */
export function outcomeWord(outcome: string): string {
  switch (outcome) {
    case "success":
      return "Succeeded";
    case "partial":
      return "Partial";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "abandoned":
      return "Abandoned";
    default:
      return "Unknown";
  }
}

/** Compact age for ledger ranges: 42m, 1h44m, 1d22h. */
export function compactAge(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d${remainingHours}h`;
}

/** Sentence-form age for bench copy: "2 minutes ago". */
export function relativeAgo(fromIso: string, referenceIso: string): string {
  const millis = Date.parse(referenceIso) - Date.parse(fromIso);
  if (!Number.isFinite(millis) || millis < 60_000) return "moments ago";
  const minutes = Math.floor(millis / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** UTC wall-clock minutes for exposure captions. */
export function clockHHMM(iso: string): string {
  const date = new Date(Date.parse(iso));
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Bounded single-line excerpt; "..." only when something was dropped. */
export function excerptText(text: string, maximumCells: number): string {
  return clipWords(text, maximumCells);
}

/** One response-first preview seam shared by the live and snapshot TUIs. */
export function dashboardTurnFact(turn: ReaderTurnSummary): DashboardTurnFact {
  const response = nonBlankContent(turn.response);
  const request = nonBlankContent(turn.request);
  const preview = response ?? request;
  return {
    turn_id: turn.turn_id,
    provider: turn.provider,
    session_id: turn.session_id,
    sequence: turn.sequence,
    outcome: turn.outcome,
    ended_at: turn.ended_at,
    preview:
      preview === undefined
        ? { source: "unavailable", text: "", truncated: false }
        : {
            source: response === undefined ? "request" : "response",
            text: preview.text,
            truncated:
              preview.truncated.canonical || preview.truncated.projection,
          },
  };
}

function nonBlankContent(
  content: ReaderContentSummary | undefined,
): ReaderContentSummary | undefined {
  return content !== undefined && content.text.trim().length > 0
    ? content
    : undefined;
}

/** Home. Every status-filtered workstream keeps an individually reachable row. */
export function reduceHub(
  catalogue: ReaderCatalogueV1,
  selectedWorkstreamId?: string,
  newsTickerSelection?: HubNewsTickerSelection,
  filter: HubFilter = "open",
): ReducedHub {
  const items = selectableHubWorkstreams(catalogue, filter);
  const entries: HubEntryView[] = items.map((item, index) => ({
    selected: item.record.workstream_id === selectedWorkstreamId,
    position: index + 1,
    name: item.record.name,
    detail:
      filter === "completed"
        ? completedEntryDetail(item, catalogue.reference_at)
        : entryDetail(item, catalogue.reference_at),
  }));
  if (entries.length > 0 && entries.every((entry) => !entry.selected)) {
    entries[0] = { ...entries[0]!, selected: true };
  }

  const truth =
    filter === "completed"
      ? completedHubTruth(catalogue)
      : hubActivityIncomplete(catalogue, items)
        ? "Workstream data is incomplete"
        : hubTruth(items, catalogue.reference_at, newsTickerSelection);
  const position = entries.find((entry) => entry.selected)?.position ?? 0;

  return {
    truth,
    frame: {
      kind: "hub",
      title: filter === "open" ? "Open workstreams" : "Completed workstreams",
      entries,
      bottomTitle: hubBottomTitle(catalogue, filter, items.length, position),
    },
  };
}

/** The exact Home roster shared by rendering, selection, and lifecycle input. */
export function hubSelectableWorkstreamIds(
  catalogue: ReaderCatalogueV1,
  filter: HubFilter,
): readonly string[] {
  return selectableHubWorkstreams(catalogue, filter).map(
    (item) => item.record.workstream_id,
  );
}

function selectableHubWorkstreams(
  catalogue: ReaderCatalogueV1,
  filter: HubFilter,
): ReaderCatalogueWorkstream[] {
  return orderHubWorkstreams(
    catalogue.workstreams.items.filter(
      (item) => item.record.status === filter,
    ),
    catalogue.reference_at,
    filter,
  );
}

/**
 * Open Home follows newest-known activity; Completed follows `updated_at`.
 * Missing, invalid, and future timestamps stay at the end in reader order.
 */
export function orderHubWorkstreams(
  items: readonly ReaderCatalogueWorkstream[],
  referenceAt: string,
  filter: HubFilter = "open",
): ReaderCatalogueWorkstream[] {
  const reference = Date.parse(referenceAt);
  const orderingTime = (
    item: ReaderCatalogueWorkstream,
  ): number | undefined => {
    const value =
      filter === "completed"
        ? item.record.updated_at
        : item.activity.last_known_activity_at;
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) &&
        Number.isFinite(reference) &&
        parsed <= reference
      ? parsed
      : undefined;
  };
  return [...items].sort((left, right) => {
    const leftTime = orderingTime(left);
    const rightTime = orderingTime(right);
    if (leftTime === undefined) return rightTime === undefined ? 0 : 1;
    if (rightTime === undefined) return -1;
    return rightTime - leftTime;
  });
}

/** Names reader-level hiding that a cursor-position border cannot express. */
export function hubProjectionWarning(
  catalogue: ReaderCatalogueV1,
  filter: HubFilter = "open",
): string | undefined {
  const shown = catalogue.workstreams.items.filter(
    (item) => item.record.status === filter,
  ).length;
  const counts = catalogue.workstream_status_counts;
  if (statusCountsExact(catalogue)) {
    const total = counts[filter];
    if (shown >= total) return undefined;
    return `List incomplete · ${shown} of ${total} ${filter} shown`;
  }
  if (
    catalogue.workstreams.hidden === 0 &&
    catalogue.workstreams.read_state === "ok" &&
    catalogue.workstreams.coverage.state === "complete"
  ) {
    return undefined;
  }
  return `List incomplete · ${shown} ${filter} shown · total unknown`;
}

/**
 * The scoped aperture (§4, §6): a working lease gallops, complete safe
 * no-work evidence cuts to the exposure ledger or its honest intertitles, and
 * incomplete evidence is named rather than rendered as emptiness.
 */
export function reduceDashboard(
  item: ReaderCatalogueWorkstream,
  turns: readonly DashboardTurnFact[],
  motion: MotionPolicy,
  selectedRollIndex = 0,
): ReducedDashboard {
  const counts = item.active_state_counts;
  const working = counts.working > 0;
  const rolls = reduceRolls(
    item,
    selectedRollIndex,
    workingRollDetail(motion),
  );

  if (working) {
    return {
      truth: workingTruth(item),
      frame: {
        kind: "working",
        title:
          motion.kind === "snapshot"
            ? `Motion study · snapshot${motion.motionOff ? " · motion off" : ""}`
            : motion.kind === "paused"
              ? "Motion study · paused"
              : "Motion study",
        horse: horseView(motion),
        rolls,
      },
    };
  }

  const activityComplete =
    item.activity.full_history.state === "complete" &&
    item.attention.completeness === "complete";
  if (!activityComplete && item.activity.state !== "shown") {
    return intertitleDashboard(["Activity is unknown"]);
  }
  if (item.activity.state === "proven_empty") {
    return intertitleDashboard([
      "No exposures yet",
      "Join with /barbaro join or $barbaro join",
    ]);
  }
  if (turns.length === 0) {
    if (item.activity.full_history.state === "complete") {
      return intertitleDashboard(["Activity is unknown"]);
    }
    return intertitleDashboard([
      "No exposures shown",
      "Turn history is incomplete",
    ]);
  }

  const ordered = [...turns].sort(compareDashboardTurnsOldestFirst);
  const selectedRoll = dashboardRollAt(item, selectedRollIndex);
  const exposures: ExposureRowView[] = ordered.map((turn, index) => {
    const provenance =
      selectedRoll === undefined
        ? undefined
        : turn.provider === selectedRoll.provider &&
            turn.session_id === selectedRoll.session_id
          ? "selected-session"
          : "other-session";
    return {
      selected: index === ordered.length - 1,
      ...(provenance === undefined ? {} : { provenance }),
      sequence: turn.sequence,
      ...(turn.outcome === "success"
        ? {}
        : { exception: outcomeWord(turn.outcome) }),
      time: clockHHMM(turn.ended_at),
      excerpt:
        turn.preview.source === "unavailable"
          ? "Preview unavailable"
          : turn.preview.text,
      excerptTruncated: turn.preview.truncated,
    };
  });
  const qualifier =
    item.activity.full_history.state === "complete" ? "" : " shown";
  return {
    truth: `No work is shown. ${exposureCountWord(ordered.length)} recent${qualifier} exposures are complete.`,
    frame: {
      kind: "idle",
      title: "The study so far",
      exposures,
      summaryLine: `Oldest to newest · ${counted(item.rolls.total, "session")} · ${counted(item.activity.turns.shown, "turn")} shown`,
      rolls,
    },
  };
}

function compareDashboardTurnsOldestFirst(
  left: DashboardTurnFact,
  right: DashboardTurnFact,
): number {
  return (
    Date.parse(left.ended_at) - Date.parse(right.ended_at) ||
    compareUtf16CodeUnits(right.provider, left.provider) ||
    compareUtf16CodeUnits(right.session_id, left.session_id) ||
    left.sequence - right.sequence ||
    compareUtf16CodeUnits(right.turn_id, left.turn_id)
  );
}

function counted(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function horseView(motion: MotionPolicy): HorseView {
  switch (motion.kind) {
    case "live":
    case "paused":
      return {
        kind: "gallop",
        frameIndex: motion.frameIndex,
      };
    case "off":
      return { kind: "intertitle", text: "Working · motion off" };
    case "snapshot":
      return {
        kind: "gallop",
        frameIndex: HORSE_STANDARD_FRAME_INDEX,
      };
  }
}

function reduceRolls(
  item: ReaderCatalogueWorkstream,
  selectedRollIndex: number,
  workingDetail: string,
): RollLineView[] {
  const views = orderedDashboardRolls(item).map((roll) => {
    const counts = roll.state_counts;
    let detail: string;
    if (counts.working > 0) {
      detail = workingDetail;
    } else if (counts.waiting > 0) {
      detail = waitingDetail(roll);
    } else if (counts.blocked > 0) {
      detail = blockedDetail(roll);
    } else if (roll.last_turn !== undefined) {
      detail = `Last shown #${roll.last_turn.sequence}`;
    } else {
      detail = "No shown lease";
    }
    return {
      selected: false,
      identity: shortSessionId(roll.provider, roll.session_id),
      detail,
    };
  });
  if (views.length > 0) {
    const selected = selectedRollOffset(views.length, selectedRollIndex);
    views[selected] = { ...views[selected]!, selected: true };
  }
  return views;
}

function workingRollDetail(motion: MotionPolicy): string {
  switch (motion.kind) {
    case "live":
    case "paused":
      return `Working${".".repeat(motion.workingDots)}`;
    case "off":
    case "snapshot":
      return "Working";
  }
}

function orderedDashboardRolls(
  item: ReaderCatalogueWorkstream,
): ReaderCatalogueRoll[] {
  return [...item.rolls.items].sort(
    (left, right) =>
      rollPriority(left) - rollPriority(right) ||
      shortSessionId(left.provider, left.session_id).localeCompare(
        shortSessionId(right.provider, right.session_id),
      ),
  );
}

function selectedRollOffset(length: number, requested: number): number {
  const safe =
    Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
  return Math.min(safe, Math.max(0, length - 1));
}

function rollPriority(roll: ReaderCatalogueRoll): number {
  const counts = roll.state_counts;
  if (counts.working > 0) return 0;
  if (counts.waiting > 0) return 1;
  if (counts.blocked > 0) return 2;
  return 3;
}

function waitingDetail(
  roll: ReaderCatalogueWorkstream["rolls"]["items"][number],
): string {
  const dependency = roll.leases.items.find(
    (lease) => lease.state === "waiting" && lease.dependency !== undefined,
  )?.dependency;
  if (dependency === undefined) return "Waiting · target unknown";
  return `Waiting · ${shortWorkstreamId(dependency.target.workstream_id)}`;
}

function blockedDetail(
  roll: ReaderCatalogueWorkstream["rolls"]["items"][number],
): string {
  const dependency = roll.leases.items.find(
    (lease) => lease.state === "blocked" && lease.dependency !== undefined,
  )?.dependency;
  if (dependency === undefined) return "Blocked · target unknown";
  return `Blocked · ${shortWorkstreamId(dependency.target.workstream_id)}`;
}

function entryDetail(
  item: ReaderCatalogueWorkstream,
  referenceAt: string,
): string {
  const counts = item.active_state_counts;
  if (counts.working > 0) return "Working now";
  if (counts.blocked > 0) return "Blocked";
  if (counts.waiting > 0) return "Waiting";
  switch (namedAttentionKind(item)) {
    case "user_input":
      return "Needs input";
    case "publish_blocked":
      return "Publish blocked";
    case "news":
      return newsDetail(item) ?? "News";
    case "unknown_write":
    case "blocked":
      return "Blocked evidence";
    default:
      break;
  }
  if (item.activity.state === "proven_empty") return "No exposures yet";
  if (item.quiet_proven) {
    const age = knownAge(item.activity.last_known_activity_at, referenceAt);
    return age === undefined ? "Quiet" : `Quiet · ${age}`;
  }
  if (recentActivityComplete(item)) {
    const age = knownAge(item.activity.last_known_activity_at, referenceAt);
    if (age !== undefined) return `Last shown · ${age}`;
  }
  if (
    !recentActivityComplete(item) ||
    item.activity.full_history.state !== "complete" ||
    item.attention.completeness !== "complete"
  ) {
    return incompleteDetail();
  }
  return "Activity unknown";
}

function completedEntryDetail(
  item: ReaderCatalogueWorkstream,
  referenceAt: string,
): string {
  const age = knownAge(item.record.updated_at, referenceAt);
  return age === undefined ? "Completed" : `Completed · ${age}`;
}

function incompleteDetail(): string {
  return "Data incomplete";
}

function namedAttentionKind(
  item: ReaderCatalogueWorkstream,
): Exclude<ReaderCatalogueWorkstream["attention"]["highest"], "evidence_incomplete"> | undefined {
  const shown = item.attention.items.items.find(
    (entry) => entry.kind !== "evidence_incomplete",
  );
  if (shown !== undefined && shown.kind !== "evidence_incomplete") {
    return shown.kind;
  }
  return item.attention.highest === "evidence_incomplete"
    ? undefined
    : item.attention.highest;
}

function recentActivityComplete(item: ReaderCatalogueWorkstream): boolean {
  return (
    item.activity.turns.read_state === "ok" &&
    item.activity.turns.coverage.state === "complete" &&
    item.members.read_state === "ok" &&
    item.members.coverage.state === "complete" &&
    item.members.hidden === 0 &&
    item.attention.items.read_state === "ok" &&
    item.attention.items.coverage.state === "complete" &&
    item.attention.items.hidden === 0
  );
}

function knownAge(
  value: string | undefined,
  referenceAt: string,
): string | undefined {
  if (value === undefined) return undefined;
  const reference = Date.parse(referenceAt);
  const lastKnown = Date.parse(value);
  if (
    !Number.isFinite(reference) ||
    !Number.isFinite(lastKnown) ||
    lastKnown > reference
  ) {
    return undefined;
  }
  return compactAge(reference - lastKnown);
}

function newsWord(item: ReaderCatalogueWorkstream): string | undefined {
  if (item.unread === undefined) return undefined;
  for (const summary of item.unread.items) {
    if (summary.status === "ready" && summary.unread_count > 0) {
      return `News ${summary.unread_count} for ${shortSessionId(
        summary.key.provider,
        summary.key.session_id,
      )}`;
    }
  }
  return undefined;
}

interface HubNewsTickerEntry {
  readonly key: string;
  readonly sourceIndex: number;
  readonly workstreamName: string;
  readonly provider: string;
  readonly unreadCount: number;
  readonly activity: string;
  readonly activityPriority: number;
  readonly lastShownAt?: number;
  readonly providerOrdinal: number;
  readonly providerTotal: number;
}

function newsDetail(item: ReaderCatalogueWorkstream): string | undefined {
  const summaries = readyNews(item);
  if (summaries.length === 0) return undefined;
  if (summaries.length === 1) {
    return `News · ${summaries[0]!.unread_count} unread`;
  }
  return `News · ${summaries.length} sessions`;
}

function readyNews(
  item: ReaderCatalogueWorkstream,
): ReaderUnreadSummaryReady[] {
  return (item.unread?.items ?? []).filter(
    (summary): summary is ReaderUnreadSummaryReady =>
      summary.status === "ready" && summary.unread_count > 0,
  );
}

function hubNewsTicker(
  items: readonly ReaderCatalogueWorkstream[],
  referenceAt: string,
  selection?: HubNewsTickerSelection,
): string | undefined {
  const entries = hubNewsTickerEntries(items, referenceAt);
  if (entries.length === 0) return undefined;

  const selectedIndex =
    selection === undefined
      ? -1
      : entries.findIndex((entry) => entry.key === selection.key);
  const entryIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const entry = entries[entryIndex]!;
  const position =
    selectedIndex !== -1 &&
    Number.isSafeInteger(selection?.position) &&
    selection!.position >= 0 &&
    selection!.position < entries.length
      ? selection!.position
      : entryIndex;
  const baseProvider = providerDisplayName(entry.provider);
  const provider =
    entry.providerTotal === 1
      ? baseProvider
      : `${baseProvider} ${entry.providerOrdinal}`;
  return `News ${position + 1}/${entries.length} · ${entry.workstreamName}/${provider} · ${entry.unreadCount} unread · ${entry.activity}`;
}

function hubNewsTickerEntries(
  items: readonly ReaderCatalogueWorkstream[],
  referenceAt: string,
): HubNewsTickerEntry[] {
  const reference = Date.parse(referenceAt);
  const raw: Array<
    Omit<HubNewsTickerEntry, "providerOrdinal" | "providerTotal">
  > = [];
  let sourceIndex = 0;
  for (const item of items) {
    for (const summary of readyNews(item)) {
      const roll = item.rolls.items.find(
        (candidate) =>
          candidate.provider === summary.key.provider &&
          candidate.session_id === summary.key.session_id,
      );
      let activity = "activity unknown";
      let activityPriority = 4;
      let lastShownAt: number | undefined;
      if (roll !== undefined && roll.state_counts.working > 0) {
        activity = "working";
        activityPriority = 0;
      } else if (roll !== undefined && roll.state_counts.waiting > 0) {
        activity = "waiting";
        activityPriority = 1;
      } else if (roll !== undefined && roll.state_counts.blocked > 0) {
        activity = "blocked";
        activityPriority = 2;
      } else if (roll?.last_turn !== undefined) {
        const ended = Date.parse(roll.last_turn.ended_at);
        if (
          Number.isFinite(reference) &&
          Number.isFinite(ended) &&
          ended <= reference
        ) {
          lastShownAt = ended;
          activity = `last shown ${compactAge(reference - ended)}`;
          activityPriority = 3;
        }
      }
      raw.push({
        key: hubNewsRecipientKey(item, summary),
        sourceIndex,
        workstreamName: item.record.name,
        provider: summary.key.provider,
        unreadCount: summary.unread_count,
        activity,
        activityPriority,
        ...(lastShownAt === undefined ? {} : { lastShownAt }),
      });
      sourceIndex += 1;
    }
  }
  if (raw.length === 0) return [];

  const providerTotals = new Map<string, number>();
  for (const entry of raw) {
    const key = `${entry.workstreamName}\u0000${entry.provider}`;
    providerTotals.set(key, (providerTotals.get(key) ?? 0) + 1);
  }
  const providerSeen = new Map<string, number>();
  const entries: HubNewsTickerEntry[] = raw.map((entry) => {
    const key = `${entry.workstreamName}\u0000${entry.provider}`;
    const providerOrdinal = (providerSeen.get(key) ?? 0) + 1;
    providerSeen.set(key, providerOrdinal);
    return {
      ...entry,
      providerOrdinal,
      providerTotal: providerTotals.get(key)!,
    };
  });
  entries.sort(
    (left, right) =>
      left.activityPriority - right.activityPriority ||
      (right.lastShownAt ?? Number.NEGATIVE_INFINITY) -
        (left.lastShownAt ?? Number.NEGATIVE_INFINITY) ||
      left.sourceIndex - right.sourceIndex,
  );
  return entries;
}

function hubNewsRecipientKey(
  item: ReaderCatalogueWorkstream,
  summary: ReaderUnreadSummaryReady,
): string {
  return [
    item.record.workstream_id,
    summary.key.provider,
    summary.key.session_id,
    summary.key.membership_from,
  ].join("\u0000");
}

/** Priority order for a fresh cycle; callers retain it until that cycle ends. */
export function hubNewsTickerKeys(
  catalogue: ReaderCatalogueV1,
): readonly string[] {
  const items = selectableHubWorkstreams(catalogue, "open");
  if (hubActivityIncomplete(catalogue, items)) return [];
  return hubNewsTickerEntries(items, catalogue.reference_at).map(
    (entry) => entry.key,
  );
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

function hubTruth(
  items: readonly ReaderCatalogueWorkstream[],
  referenceAt: string,
  newsTickerSelection?: HubNewsTickerSelection,
): string {
  if (items.length === 0) return "No open workstreams";
  const ticker = hubNewsTicker(items, referenceAt, newsTickerSelection);
  if (ticker !== undefined) return ticker;
  let working = 0;
  let waiting = 0;
  let blocked = 0;
  for (const item of items) {
    working += item.active_state_counts.working;
    waiting += item.active_state_counts.waiting;
    blocked += item.active_state_counts.blocked;
  }
  const segments: string[] = [];
  if (working > 0) segments.push(`${working} working`);
  if (waiting > 0) segments.push(`${waiting} waiting`);
  if (blocked > 0) segments.push(`${blocked} blocked`);
  return segments.length === 0 ? "All workstreams are accounted for" : segments.join(" · ");
}

function completedHubTruth(catalogue: ReaderCatalogueV1): string {
  const counts = catalogue.workstream_status_counts;
  if (statusCountsExact(catalogue)) {
    return `${counts.completed} completed · ${counts.open} open`;
  }
  if (counts.completed === 0 && counts.open === 0) {
    return "Workstream status is incomplete";
  }
  return `${counts.completed} completed known · ${counts.open} open known`;
}

function hubBottomTitle(
  catalogue: ReaderCatalogueV1,
  filter: HubFilter,
  shown: number,
  selectedPosition: number,
): string {
  const counts = catalogue.workstream_status_counts;
  const total = counts[filter];
  const other: HubFilter = filter === "open" ? "completed" : "open";
  const otherTotal = counts[other];
  const shownPosition =
    shown === 0
      ? "0 shown"
      : `${Math.max(1, selectedPosition)} of ${shown} shown`;

  if (!statusCountsExact(catalogue)) {
    return `${shownPosition} · known: ${total} ${filter} · ${otherTotal} ${other}`;
  }
  if (shown < total) {
    return `${shownPosition} · ${total} ${filter} · ${otherTotal} ${other}`;
  }
  const position =
    total === 0 ? `0 ${filter}` : `${Math.max(1, selectedPosition)} of ${total} ${filter}`;
  return `${position} · ${otherTotal} ${other}`;
}

function statusCountsExact(catalogue: ReaderCatalogueV1): boolean {
  const counts = catalogue.workstream_status_counts;
  return counts.read_state === "ok" && counts.coverage.state === "complete";
}

function workingTruth(item: ReaderCatalogueWorkstream): string {
  const counts = item.active_state_counts;
  const segments = [`${counts.working} working`];
  if (counts.waiting > 0) segments.push(`${counts.waiting} waiting`);
  if (counts.blocked > 0) segments.push(`${counts.blocked} blocked`);
  const news = newsWord(item);
  if (news !== undefined) segments.push(news);
  return segments.join(" · ");
}

/**
 * Home truth uses scoped current evidence. Aggregate catalogue coverage and
 * attention also include unrelated feed limits, publish history, and
 * unknown-write diagnostics, so they cannot erase exact working/News facts.
 */
function hubActivityIncomplete(
  catalogue: ReaderCatalogueV1,
  openItems: readonly ReaderCatalogueWorkstream[],
): boolean {
  return (
    !statusCountsExact(catalogue) ||
    openItems.length !== catalogue.workstream_status_counts.open ||
    catalogue.diagnostics.invalid_workstream_records > 0 ||
    catalogue.diagnostics.invalid_participation_records > 0 ||
    catalogue.diagnostics.invalid_active_records > 0 ||
    openItems.some(
      (item) =>
        item.activity.turns.coverage.state !== "complete" ||
        item.members.read_state !== "ok" ||
        item.members.coverage.state !== "complete" ||
        item.members.hidden > 0 ||
        (item.members.total > 0 && item.unread === undefined) ||
        (item.unread !== undefined &&
          (item.unread.read_state !== "ok" ||
            item.unread.coverage.state !== "complete" ||
            item.unread.hidden > 0 ||
            item.unread.items.some((summary) => summary.status === "unknown"))),
    )
  );
}

function intertitleDashboard(
  lines: readonly string[],
): ReducedDashboard {
  return {
    truth: lines[0]!,
    frame: {
      kind: "intertitle",
      title: "Motion study",
      lines,
    },
  };
}

function exposureCountWord(count: number): string {
  if (count === 1) return "One";
  if (count === 2) return "Two";
  if (count === 3) return "Three";
  return `${count}`;
}
