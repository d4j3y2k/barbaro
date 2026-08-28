import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import {
  SafeStoreBoundary,
  StoreFileTooLargeError,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import { compareUtf16CodeUnits } from "../core/stable-json.js";
import {
  MAX_INGEST_ATTEMPTS,
  MAX_INGEST_ATTEMPT_BYTES,
  type BarbaroIngestAttemptJournalV2,
  type BarbaroIngestAttemptV2,
  type IngestAttemptOutcome,
} from "../hooks/ingest-attempt.js";
import type { SessionWorkstreamMembership } from "../hooks/participation.js";

import {
  assertReaderByteBudget,
  assertReaderNonNegativeInteger,
  maximizeReaderBudget,
  readerProjectionFits,
  truncateReaderUtf8,
  utf8Bytes,
  wrapReaderProjection,
} from "./budget.js";
import { parseReaderIngestJournal } from "./ingest-journal.js";
import type {
  ReaderCollection,
  ReaderCoverage,
  ReaderProjection,
  ReaderReadState,
} from "./types.js";

const DEFAULT_PENDING_ID_LIMIT = 32;
const DEFAULT_REASON_BYTES = 512;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;

export type ReaderPublishState = "clear" | "pending" | "blocked" | "unknown";
export type ReaderPublishFreshness = "current" | "stale" | "unknown";
export type ReaderPublishActionability =
  | "none"
  | "waiting"
  | "attention"
  | "unknown";
export type ReaderPublishOutcome = IngestAttemptOutcome | "unfinished" | "unknown";

export interface ReaderPublishTurnFact {
  readonly turn_id: string;
  readonly native_turn_id?: string;
  readonly response_sha256?: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly sequence: number;
  readonly started_at: string;
}

export interface ReaderPublishMembershipHistory {
  readonly provider: string;
  readonly session_id: string;
  readonly memberships: ReaderCollection<SessionWorkstreamMembership>;
}

export interface ReaderPublishText {
  readonly text: string;
  readonly truncated: boolean;
  readonly utf8_bytes: {
    readonly shown: number;
    readonly total: number;
  };
}

export interface ReaderPublishAttemptItem {
  readonly attempt_id: string;
  readonly triggered_at: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly outcome: ReaderPublishOutcome;
  readonly attributed_workstream_id?: string;
  readonly migrated_from_schema?: "barbaro.ingest-attempt.v1";
}

export interface ReaderSelectedPublishAttempt extends ReaderPublishAttemptItem {
  readonly trigger?: {
    readonly native_turn_id?: string;
    readonly turn_id?: string;
    readonly agent_id?: string;
  };
  readonly publish_blocker?: ReaderPublishText;
  readonly withheld_reason?: ReaderPublishText;
}

export interface ReaderPublishDiagnostics {
  readonly journal:
    | "present"
    | "missing"
    | "invalid"
    | "corrupt"
    | "refused";
  readonly missing: number;
  readonly invalid: number;
  readonly corrupt: number;
  readonly identity_mismatch: number;
  readonly dropped_attempts: number;
  readonly scan_limited: boolean;
  readonly refused: boolean;
  readonly reason?: string;
}

export interface ReaderPublishSummary {
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id: string;
  readonly state: ReaderPublishState;
  readonly outcome: ReaderPublishOutcome;
  readonly actionability: ReaderPublishActionability;
  readonly freshness: ReaderPublishFreshness;
  readonly selected_attempt?: ReaderSelectedPublishAttempt;
  readonly pending_background_ids: ReaderCollection<string>;
  readonly pending_agent_ids: ReaderCollection<string>;
  readonly attempts: ReaderCollection<ReaderPublishAttemptItem>;
  readonly read_state: ReaderReadState;
  readonly coverage: ReaderCoverage;
  readonly diagnostics: ReaderPublishDiagnostics;
}

export interface ReaderPublishSummaryOptions {
  readonly byteBudget: number;
  readonly provider: string;
  readonly sessionId: string;
  readonly workstreamId: string;
  /** Complete historical membership is required for attempt attribution. */
  readonly membershipHistory: ReaderPublishMembershipHistory;
  /** A trustworthy complete recent per-session window can prove freshness. */
  readonly turnHistory?: ReaderCollection<ReaderPublishTurnFact>;
  readonly maxFileBytes?: number;
  /**
   * Newest-attempt semantic window cap. Omitted older diagnostics limit
   * coverage without necessarily hiding the current scoped state.
   */
  readonly attemptScanLimit?: number;
  readonly pendingIdLimit?: number;
  readonly reasonBytes?: number;
}

interface PublishSource {
  readonly provider: string;
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly state: ReaderPublishState;
  readonly outcome: ReaderPublishOutcome;
  readonly freshness: ReaderPublishFreshness;
  readonly selected?: BarbaroIngestAttemptV2;
  readonly selectedWorkstreamId?: string;
  readonly attempts: readonly ReaderPublishAttemptItem[];
  readonly attemptsTotal: number;
  readonly pendingBackgroundIds: readonly string[];
  readonly pendingAgentIds: readonly string[];
  readonly readState: ReaderReadState;
  readonly coverage: ReaderCoverage;
  readonly attemptsReadState: ReaderReadState;
  readonly attemptsCoverage: ReaderCoverage;
  readonly diagnostics: ReaderPublishDiagnostics;
}

interface PublishLimits {
  readonly byteBudget: number;
  readonly maximumFileBytes: number;
  readonly attemptScanLimit: number;
  readonly pendingIdLimit: number;
  readonly reasonBytes: number;
}

/**
 * Read and normalize one v2 ingest journal without invoking its fail-open
 * writer. Every source or projection gap is retained as publish unknown.
 */
export async function readSessionPublishSummary(
  projectRoot: string,
  options: ReaderPublishSummaryOptions,
): Promise<ReaderProjection<ReaderPublishSummary>> {
  validatePublishIdentity(projectRoot, options);
  const limits = publishLimits(options);
  const source = await readPublishSource(resolve(projectRoot), options, limits);
  return projectPublishSource(source, limits);
}

async function readPublishSource(
  projectRoot: string,
  options: ReaderPublishSummaryOptions,
  limits: PublishLimits,
): Promise<PublishSource> {
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  let bytes: Buffer | undefined;
  try {
    bytes = await readPublishFile(
      boundary,
      ["logs", "ingest", options.provider, `${options.sessionId}.json`],
      limits.maximumFileBytes,
    );
  } catch (error: unknown) {
    return unavailableSource(options, "refused", refusalReason(error));
  }
  if (bytes === undefined) {
    return unavailableSource(options, "missing", "journal_missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    return unavailableSource(options, "corrupt", "journal_corrupt");
  }

  let journal: BarbaroIngestAttemptJournalV2;
  try {
    journal = parseReaderIngestJournal(
      parsed,
      options.provider,
      options.sessionId,
    );
  } catch (error: unknown) {
    return unavailableSource(
      options,
      "invalid",
      "journal_invalid",
      isIdentityMismatch(error),
    );
  }

  return normalizeJournal(journal, options, limits);
}

function normalizeJournal(
  journal: BarbaroIngestAttemptJournalV2,
  options: ReaderPublishSummaryOptions,
  limits: PublishLimits,
): PublishSource {
  const membership = inspectMembershipHistory(
    options.membershipHistory,
    options.provider,
    options.sessionId,
  );
  const attributed = journal.attempts.map((attempt) => ({
    attempt,
    workstreamId: membership.trustworthy
      ? effectiveMembership(
          options.membershipHistory.memberships.items,
          attempt.triggered_at,
        )
          ?.workstream_id
      : undefined,
  }));
  const scanLimited = attributed.length > limits.attemptScanLimit;
  const boundedHistory = journal.dropped_attempts > 0 || scanLimited;
  // The writer appends births and evicts the first finished entry in journal
  // order. When history is bounded, only the retained append-order suffix can
  // prove that omitted terminal attempts precede its selected candidate;
  // trigger timestamps can arrive out of order under concurrent hooks.
  const retainedWindow = attributed
    .slice(Math.max(0, attributed.length - limits.attemptScanLimit))
    .reverse();
  const sorted = [...retainedWindow].sort((left, right) =>
    compareAttemptsNewestFirst(left.attempt, right.attempt),
  );
  const relevantCandidate = membership.trustworthy
    ? (boundedHistory ? retainedWindow : sorted).find(
        (entry) => entry.workstreamId === options.workstreamId,
      )
    : undefined;
  const relevant = relevantCandidate;
  const freshness =
    relevant === undefined
      ? "unknown"
      : publishFreshness(relevant.attempt, options, options.turnHistory);
  const normalized =
    relevant === undefined ? "unknown" : normalizeAttempt(relevant.attempt);
  const outcome = attemptOutcome(relevant?.attempt);

  let readState: ReaderReadState = "ok";
  let coverage: ReaderCoverage = { state: "complete" };
  let reason: string | undefined;
  if (!membership.trustworthy) {
    readState = worstReadState(readState, membership.readState);
    coverage = worstCoverage(coverage, membership.coverage);
    reason = membership.reason;
  }
  if (journal.dropped_attempts > 0) {
    readState = worstReadState(readState, "degraded");
    coverage = worstCoverage(coverage, {
      state: "limited",
      reason: "journal_dropped_attempts",
    });
    reason ??= "journal_dropped_attempts";
  }
  if (scanLimited) {
    readState = worstReadState(readState, "degraded");
    coverage = worstCoverage(coverage, {
      state: "limited",
      reason: "journal_scan_limit",
    });
    reason ??= "journal_scan_limit";
  }
  if (relevant?.attempt.migrated_from_schema !== undefined) {
    readState = worstReadState(readState, "degraded");
    coverage = worstCoverage(coverage, {
      state: "limited",
      reason: "legacy_attempt",
    });
    reason ??= "legacy_attempt";
  }
  if (relevant !== undefined) {
    const history = inspectTurnHistory(
      options.turnHistory,
      options.provider,
      options.sessionId,
    );
    if (!history.trustworthy) {
      readState = worstReadState(readState, history.readState);
      coverage = worstCoverage(coverage, history.coverage);
      reason ??= history.reason;
    }
  }

  const proofGap =
    !membership.trustworthy ||
    relevant === undefined ||
    // The writer preserves unfinished attempts while evicting older finished
    // entries. In bounded history, an unfinished candidate can therefore sit
    // ahead of a newer completed result that is no longer visible.
    (boundedHistory && relevant?.attempt.finished_at === undefined) ||
    relevant?.attempt.migrated_from_schema !== undefined ||
    freshness !== "current";
  const state: ReaderPublishState = proofGap ? "unknown" : normalized;
  const attemptsReadState = membership.trustworthy
    ? journal.dropped_attempts === 0 && !scanLimited
      ? "ok"
      : "degraded"
    : membership.readState;
  let attemptsCoverage = membership.coverage;
  if (journal.dropped_attempts > 0) {
    attemptsCoverage = worstCoverage(attemptsCoverage, {
      state: "limited",
      reason: "journal_dropped_attempts",
    });
  }
  if (scanLimited) {
    attemptsCoverage = worstCoverage(attemptsCoverage, {
      state: "limited",
      reason: "journal_scan_limit",
    });
  }

  return {
    provider: options.provider,
    sessionId: options.sessionId,
    workstreamId: options.workstreamId,
    state,
    outcome,
    freshness,
    ...(relevant === undefined ? {} : { selected: relevant.attempt }),
    ...(relevant?.workstreamId === undefined
      ? {}
      : { selectedWorkstreamId: relevant.workstreamId }),
    attempts: sorted.map(({ attempt, workstreamId }) =>
      attemptItem(attempt, workstreamId),
    ),
    attemptsTotal: journal.attempts.length + journal.dropped_attempts,
    pendingBackgroundIds: relevant?.attempt.pending_background_ids ?? [],
    pendingAgentIds: relevant?.attempt.pending_agent_ids ?? [],
    readState,
    coverage:
      coverage.state === "complete" && reason !== undefined
        ? { state: "complete", reason }
        : coverage,
    attemptsReadState,
    attemptsCoverage,
    diagnostics: {
      journal: "present",
      missing: 0,
      invalid: 0,
      corrupt: 0,
      identity_mismatch: 0,
      dropped_attempts: journal.dropped_attempts,
      scan_limited: scanLimited,
      refused: false,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function projectPublishSource(
  source: PublishSource,
  limits: PublishLimits,
): ReaderProjection<ReaderPublishSummary> {
  let attemptsShown = 0;
  let backgroundShown = 0;
  let agentShown = 0;
  let blockerBytes = 0;
  let withheldBytes = 0;

  const build = (): ReaderPublishSummary => {
    const attemptsHidden = source.attemptsTotal - attemptsShown;
    // The selected attempt is projected independently below. Hiding older
    // diagnostic rows must not erase a state already proved by the newest
    // relevant source window.
    const state = source.state;
    const selected = selectedAttempt(
      source,
      blockerBytes,
      withheldBytes,
    );
    const selectedFields = selectedFieldEvidence(source);
    return {
      provider: source.provider,
      session_id: source.sessionId,
      workstream_id: source.workstreamId,
      state,
      outcome: source.outcome,
      actionability: actionability(state),
      freshness: source.freshness,
      ...(selected === undefined ? {} : { selected_attempt: selected }),
      pending_background_ids: collectionProjection(
        source.pendingBackgroundIds,
        backgroundShown,
        selectedFields.readState,
        selectedFields.coverage,
      ),
      pending_agent_ids: collectionProjection(
        source.pendingAgentIds,
        agentShown,
        selectedFields.readState,
        selectedFields.coverage,
      ),
      attempts: {
        shown: attemptsShown,
        total: source.attemptsTotal,
        hidden: attemptsHidden,
        items: source.attempts.slice(0, attemptsShown),
        read_state: source.attemptsReadState,
        coverage: source.attemptsCoverage,
      },
      read_state: source.readState,
      coverage: source.coverage,
      diagnostics: source.diagnostics,
    };
  };

  wrapReaderProjection(build(), limits.byteBudget);
  attemptsShown = appendWhileFits(
    source.attempts.length,
    attemptsShown,
    (candidate) => {
      attemptsShown = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  if (source.selected?.publish_blocker !== undefined) {
    blockerBytes = maximizeReaderBudget(limits.reasonBytes, (candidate) => {
      blockerBytes = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    });
    if (blockerBytes < 0) blockerBytes = 0;
  }
  if (source.selected?.withheld_reason !== undefined) {
    withheldBytes = maximizeReaderBudget(limits.reasonBytes, (candidate) => {
      withheldBytes = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    });
    if (withheldBytes < 0) withheldBytes = 0;
  }
  agentShown = appendWhileFits(
    Math.min(source.pendingAgentIds.length, limits.pendingIdLimit),
    agentShown,
    (candidate) => {
      agentShown = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  backgroundShown = appendWhileFits(
    Math.min(source.pendingBackgroundIds.length, limits.pendingIdLimit),
    backgroundShown,
    (candidate) => {
      backgroundShown = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  return wrapReaderProjection(build(), limits.byteBudget);
}

function selectedAttempt(
  source: PublishSource,
  blockerBytes: number,
  withheldBytes: number,
): ReaderSelectedPublishAttempt | undefined {
  const attempt = source.selected;
  if (attempt === undefined) return undefined;
  const trigger = attempt.trigger;
  return {
    ...attemptItem(attempt, source.selectedWorkstreamId),
    ...(trigger === undefined
      ? {}
      : {
          trigger: {
            ...(trigger.native_turn_id === undefined
              ? {}
              : { native_turn_id: trigger.native_turn_id }),
            ...(trigger.turn_id === undefined
              ? {}
              : { turn_id: trigger.turn_id }),
            ...(trigger.agent_id === undefined
              ? {}
              : { agent_id: trigger.agent_id }),
          },
        }),
    ...(attempt.publish_blocker === undefined
      ? {}
      : {
          publish_blocker: publishText(attempt.publish_blocker, blockerBytes),
        }),
    ...(attempt.withheld_reason === undefined
      ? {}
      : {
          withheld_reason: publishText(attempt.withheld_reason, withheldBytes),
        }),
  };
}

function publishText(value: string, maximumBytes: number): ReaderPublishText {
  const text = truncateReaderUtf8(value, maximumBytes);
  const shown = utf8Bytes(text);
  const total = utf8Bytes(value);
  return {
    text,
    truncated: shown < total,
    utf8_bytes: { shown, total },
  };
}

function collectionProjection<T>(
  items: readonly T[],
  shown: number,
  readState: ReaderReadState,
  coverage: ReaderCoverage,
): ReaderCollection<T> {
  return {
    shown,
    total: items.length,
    hidden: items.length - shown,
    items: items.slice(0, shown),
    read_state: readState,
    coverage,
  };
}

function selectedFieldEvidence(source: PublishSource): {
  readonly readState: ReaderReadState;
  readonly coverage: ReaderCoverage;
} {
  if (
    source.selected !== undefined &&
    source.selected.migrated_from_schema === undefined
  ) {
    return { readState: "ok", coverage: { state: "complete" } };
  }
  if (source.readState === "refused" || source.coverage.state === "refused") {
    return {
      readState: "refused",
      coverage: {
        state: "refused",
        reason: source.coverage.reason ?? "publish_attempt_refused",
      },
    };
  }
  return {
    readState: "degraded",
    coverage: {
      state: "limited",
      reason:
        source.selected?.migrated_from_schema === undefined
          ? "publish_attempt_unavailable"
          : "legacy_attempt",
    },
  };
}

function appendWhileFits(
  maximum: number,
  initial: number,
  fits: (candidate: number) => boolean,
): number {
  let shown = initial;
  while (shown < maximum) {
    shown += 1;
    if (!fits(shown)) {
      shown -= 1;
      break;
    }
  }
  return shown;
}

function attemptItem(
  attempt: BarbaroIngestAttemptV2,
  workstreamId?: string,
): ReaderPublishAttemptItem {
  return {
    attempt_id: attempt.attempt_id,
    triggered_at: attempt.triggered_at,
    started_at: attempt.started_at,
    ...(attempt.finished_at === undefined
      ? {}
      : { finished_at: attempt.finished_at }),
    outcome: attemptOutcome(attempt),
    ...(workstreamId === undefined
      ? {}
      : { attributed_workstream_id: workstreamId }),
    ...(attempt.migrated_from_schema === undefined
      ? {}
      : { migrated_from_schema: attempt.migrated_from_schema }),
  };
}

function normalizeAttempt(attempt: BarbaroIngestAttemptV2): ReaderPublishState {
  if (
    attempt.publish_blocker !== undefined ||
    attempt.withheld_reason !== undefined ||
    (attempt.outcome !== undefined && attempt.outcome !== "ok")
  ) {
    return "blocked";
  }
  if (
    attempt.outcome === undefined ||
    attempt.pending_background_ids.length > 0 ||
    attempt.pending_agent_ids.length > 0
  ) {
    return "pending";
  }
  return "clear";
}

function attemptOutcome(
  attempt: BarbaroIngestAttemptV2 | undefined,
): ReaderPublishOutcome {
  if (attempt === undefined) return "unknown";
  return attempt.outcome ?? "unfinished";
}

function actionability(state: ReaderPublishState): ReaderPublishActionability {
  switch (state) {
    case "clear":
      return "none";
    case "pending":
      return "waiting";
    case "blocked":
      return "attention";
    case "unknown":
      return "unknown";
  }
}

function publishFreshness(
  attempt: BarbaroIngestAttemptV2,
  options: ReaderPublishSummaryOptions,
  history: ReaderCollection<ReaderPublishTurnFact> | undefined,
): ReaderPublishFreshness {
  if (
    !inspectTurnHistory(history, options.provider, options.sessionId).trustworthy ||
    history === undefined
  ) {
    return "unknown";
  }
  const triggerTurn = triggerTurnFact(attempt, history.items);
  if (triggerTurn === undefined) return "unknown";
  return history.items.some(
    (turn) =>
      turn.provider === options.provider &&
      turn.session_id === options.sessionId &&
      turn.workstream_id === options.workstreamId &&
      turn.sequence > triggerTurn.sequence,
  )
    ? "stale"
    : "current";
}

function triggerTurnFact(
  attempt: BarbaroIngestAttemptV2,
  history: readonly ReaderPublishTurnFact[],
): ReaderPublishTurnFact | undefined {
  const trigger = attempt.trigger;
  if (trigger === undefined) return undefined;
  if (trigger.turn_id !== undefined) {
    const match = history.find((turn) => turn.turn_id === trigger.turn_id);
    if (match !== undefined) return match;
  }
  if (trigger.native_turn_id !== undefined) {
    const matches = history.filter(
      (turn) => turn.native_turn_id === trigger.native_turn_id,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  if (trigger.last_assistant_message !== undefined) {
    const matches = history.filter(
      (turn) =>
        turn.response_sha256 === trigger.last_assistant_message?.sha256,
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function effectiveMembership(
  memberships: readonly SessionWorkstreamMembership[],
  triggeredAt: string,
): SessionWorkstreamMembership | undefined {
  const trigger = Date.parse(triggeredAt);
  let effective: SessionWorkstreamMembership | undefined;
  for (const membership of memberships) {
    if (Date.parse(membership.from) <= trigger) effective = membership;
    else break;
  }
  return effective;
}

function compareAttemptsNewestFirst(
  left: BarbaroIngestAttemptV2,
  right: BarbaroIngestAttemptV2,
): number {
  return (
    Date.parse(right.triggered_at) - Date.parse(left.triggered_at) ||
    Date.parse(right.started_at) - Date.parse(left.started_at) ||
    compareUtf16CodeUnits(right.attempt_id, left.attempt_id)
  );
}

interface SourceInspection {
  readonly trustworthy: boolean;
  readonly readState: ReaderReadState;
  readonly coverage: ReaderCoverage;
  readonly reason?: string;
}

function inspectMembershipHistory(
  history: ReaderPublishMembershipHistory,
  expectedProvider: string,
  expectedSessionId: string,
): SourceInspection {
  if (
    history.provider !== expectedProvider ||
    history.session_id !== expectedSessionId ||
    !validCollectionEnvelope(history.memberships)
  ) {
    return {
      trustworthy: false,
      readState: "degraded",
      coverage: { state: "limited", reason: "membership_history_invalid" },
      reason: "membership_history_invalid",
    };
  }
  let prior = Number.NEGATIVE_INFINITY;
  for (const membership of history.memberships.items) {
    const from = Date.parse(membership.from);
    if (
      !WORKSTREAM_ID_PATTERN.test(membership.workstream_id) ||
      !Number.isFinite(from) ||
      from <= prior
    ) {
      return {
        trustworthy: false,
        readState: "degraded",
        coverage: { state: "limited", reason: "membership_history_invalid" },
        reason: "membership_history_invalid",
      };
    }
    prior = from;
  }
  const trustworthy =
    history.memberships.read_state === "ok" &&
    history.memberships.coverage.state === "complete" &&
    history.memberships.hidden === 0;
  return {
    trustworthy,
    readState: trustworthy ? "ok" : history.memberships.read_state,
    coverage: trustworthy
      ? { state: "complete" }
      : history.memberships.coverage.state === "complete"
        ? { state: "limited", reason: "membership_history_hidden" }
        : history.memberships.coverage,
    ...(!trustworthy ? { reason: "membership_history_incomplete" } : {}),
  };
}

function inspectTurnHistory(
  history: ReaderCollection<ReaderPublishTurnFact> | undefined,
  expectedProvider?: string,
  expectedSessionId?: string,
): SourceInspection {
  if (history === undefined) {
    return {
      trustworthy: false,
      readState: "degraded",
      coverage: { state: "limited", reason: "turn_history_unavailable" },
      reason: "turn_history_unavailable",
    };
  }
  if (!validCollectionEnvelope(history)) {
    return {
      trustworthy: false,
      readState: "degraded",
      coverage: { state: "limited", reason: "turn_history_invalid" },
      reason: "turn_history_invalid",
    };
  }
  const turnIds = new Set<string>();
  const sequences = new Set<number>();
  for (const turn of history.items) {
    if (
      typeof turn.turn_id !== "string" ||
      turn.turn_id.length === 0 ||
      !Number.isSafeInteger(turn.sequence) ||
      turn.sequence < 1 ||
      !PROVIDER_PATTERN.test(turn.provider) ||
      !SESSION_ID_PATTERN.test(turn.session_id) ||
      (expectedProvider !== undefined && turn.provider !== expectedProvider) ||
      (expectedSessionId !== undefined && turn.session_id !== expectedSessionId) ||
      !Number.isFinite(Date.parse(turn.started_at)) ||
      (turn.workstream_id !== undefined &&
        !WORKSTREAM_ID_PATTERN.test(turn.workstream_id)) ||
      (turn.native_turn_id !== undefined &&
        (turn.native_turn_id.length === 0 ||
          utf8Bytes(turn.native_turn_id) > 512)) ||
      (turn.response_sha256 !== undefined &&
        !/^[0-9a-f]{64}$/u.test(turn.response_sha256)) ||
      turnIds.has(turn.turn_id) ||
      sequences.has(turn.sequence)
    ) {
      return {
        trustworthy: false,
        readState: "degraded",
        coverage: { state: "limited", reason: "turn_history_invalid" },
        reason: "turn_history_invalid",
      };
    }
    turnIds.add(turn.turn_id);
    sequences.add(turn.sequence);
  }
  const trustworthy =
    history.read_state === "ok" &&
    history.coverage.state === "complete" &&
    history.hidden === 0;
  return {
    trustworthy,
    readState: trustworthy ? "ok" : history.read_state,
    coverage: trustworthy
      ? { state: "complete" }
      : history.coverage.state === "complete"
        ? { state: "limited", reason: "turn_history_hidden" }
        : history.coverage,
    ...(!trustworthy ? { reason: "turn_history_incomplete" } : {}),
  };
}

function validCollectionEnvelope<T>(collection: ReaderCollection<T>): boolean {
  return (
    Number.isSafeInteger(collection.shown) &&
    Number.isSafeInteger(collection.total) &&
    Number.isSafeInteger(collection.hidden) &&
    collection.shown >= 0 &&
    collection.total >= collection.shown &&
    collection.shown === collection.items.length &&
    collection.hidden === collection.total - collection.shown &&
    ["ok", "degraded", "refused"].includes(collection.read_state) &&
    ["complete", "limited", "refused"].includes(collection.coverage.state)
  );
}

function unavailableSource(
  options: ReaderPublishSummaryOptions,
  journal: "missing" | "invalid" | "corrupt" | "refused",
  reason: string,
  identityMismatch = false,
): PublishSource {
  const refused = journal === "refused";
  const readState: ReaderReadState = refused ? "refused" : "degraded";
  const coverage: ReaderCoverage = refused
    ? { state: "refused", reason }
    : { state: "complete", reason };
  return {
    provider: options.provider,
    sessionId: options.sessionId,
    workstreamId: options.workstreamId,
    state: "unknown",
    outcome: "unknown",
    freshness: "unknown",
    attempts: [],
    attemptsTotal: 0,
    pendingBackgroundIds: [],
    pendingAgentIds: [],
    readState,
    coverage,
    attemptsReadState: readState,
    attemptsCoverage: coverage,
    diagnostics: {
      journal,
      missing: journal === "missing" ? 1 : 0,
      invalid: journal === "invalid" ? 1 : 0,
      corrupt: journal === "corrupt" ? 1 : 0,
      identity_mismatch: identityMismatch ? 1 : 0,
      dropped_attempts: 0,
      scan_limited: false,
      refused,
      reason,
    },
  };
}

function publishLimits(options: ReaderPublishSummaryOptions): PublishLimits {
  assertReaderByteBudget(options.byteBudget);
  const maximumFileBytes = Math.min(
    options.maxFileBytes ?? MAX_INGEST_ATTEMPT_BYTES,
    MAX_INGEST_ATTEMPT_BYTES,
  );
  const attemptScanLimit = options.attemptScanLimit ?? MAX_INGEST_ATTEMPTS;
  const pendingIdLimit = options.pendingIdLimit ?? DEFAULT_PENDING_ID_LIMIT;
  const reasonBytes = options.reasonBytes ?? DEFAULT_REASON_BYTES;
  assertReaderNonNegativeInteger(maximumFileBytes, "maxFileBytes");
  assertReaderNonNegativeInteger(attemptScanLimit, "attemptScanLimit");
  assertReaderNonNegativeInteger(pendingIdLimit, "pendingIdLimit");
  assertReaderNonNegativeInteger(reasonBytes, "reasonBytes");
  return {
    byteBudget: options.byteBudget,
    maximumFileBytes,
    attemptScanLimit,
    pendingIdLimit,
    reasonBytes,
  };
}

function validatePublishIdentity(
  projectRoot: string,
  options: ReaderPublishSummaryOptions,
): void {
  if (projectRoot.length === 0) throw new TypeError("projectRoot must not be empty");
  if (!PROVIDER_PATTERN.test(options.provider)) {
    throw new TypeError("provider is invalid");
  }
  if (!SESSION_ID_PATTERN.test(options.sessionId)) {
    throw new TypeError("sessionId is invalid");
  }
  if (!WORKSTREAM_ID_PATTERN.test(options.workstreamId)) {
    throw new TypeError("workstreamId is invalid");
  }
}

async function readPublishFile(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  maximumBytes: number,
): Promise<Buffer | undefined> {
  const parent = await boundary.verifyDirectory(components.slice(0, -1));
  if (parent === undefined) return undefined;
  const path = boundary.pathFor(components);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeStorePathError(path, "final file is a symbolic link");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new UnsafeStorePathError(path, "opened object is not a regular file");
    }
    if (before.nlink !== 1) {
      throw new UnsafeStorePathError(path, "final file has multiple hard links");
    }
    if (before.size > maximumBytes) {
      throw new StoreFileTooLargeError(path, maximumBytes);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    await readExactly(handle, bytes);
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, before.size)).bytesRead !== 0) {
      throw new RangeError("Barbaro publish source changed while being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) {
      throw new RangeError("Barbaro publish source changed while being read");
    }
    offset += result.bytesRead;
  }
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function refusalReason(error: unknown): string {
  if (error instanceof UnsafeStorePathError) return "unsafe_path";
  if (error instanceof StoreFileTooLargeError) return "file_too_large";
  if (isErrnoCode(error, "EACCES") || isErrnoCode(error, "EPERM")) {
    return "permission_refused";
  }
  return "read_refused";
}

function isIdentityMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    /identity.*does not match|does not match.*identity/iu.test(error.message)
  );
}

function worstReadState(
  left: ReaderReadState,
  right: ReaderReadState,
): ReaderReadState {
  const rank: Readonly<Record<ReaderReadState, number>> = {
    ok: 0,
    degraded: 1,
    refused: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function worstCoverage(
  left: ReaderCoverage,
  right: ReaderCoverage,
): ReaderCoverage {
  const rank = { complete: 0, limited: 1, refused: 2 } as const;
  return rank[left.state] >= rank[right.state] ? left : right;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
