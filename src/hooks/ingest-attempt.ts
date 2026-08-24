import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { FileIdentity, JsonlCheckpoint } from "../core/index.js";
import {
  SafeStoreBoundary,
  snapshotFromStats,
  truncateUtf8,
} from "../core/index.js";
import { stableStringify } from "../core/stable-json.js";
import {
  DirectoryLockReleaseError,
  withDirectoryLock,
} from "../output/directory-lock.js";

import { recordIncident } from "./incidents.js";

export const LEGACY_INGEST_ATTEMPT_SCHEMA = "barbaro.ingest-attempt.v1";
export const INGEST_ATTEMPT_SCHEMA = "barbaro.ingest-attempt-journal.v2";
export const MAX_INGEST_ATTEMPTS = 32;
export const MAX_INGEST_OBSERVATION_TRANSITIONS = 8;
export const MAX_INGEST_ATTEMPT_BYTES = 256 * 1024;

const MAX_LOG_RECORD_LOCK_WAIT_MS = 1_000;
const MAX_LOG_OBSERVE_LOCK_WAIT_MS = 100;
const MAX_EVENT_BYTES = 256;
const MAX_ID_BYTES = 512;
const MAX_RUNNER_INPUT_FIELDS = 32;
const MAX_RUNNER_ARRAY_ITEMS = 32;
const MAX_RUNNER_STRING_BYTES = 512;

export type IngestAttemptOutcome =
  | "ok"
  | "error"
  | "process_died"
  | "outcome_not_recorded"
  | "stop_turn_not_visible";

/** The pre-v2 latest-wins object, accepted only for explicit migration. */
export interface BarbaroIngestAttemptV1 {
  readonly schema: typeof LEGACY_INGEST_ATTEMPT_SCHEMA;
  readonly provider: string;
  readonly session_id: string;
  readonly event: string;
  readonly attempt_id: string;
  readonly pid: number;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly outcome?: "ok" | "error";
}

export interface IngestAttemptTriggerV2 {
  readonly native_turn_id?: string;
  readonly turn_id?: string;
  readonly agent_id?: string;
  readonly stop_hook_active?: boolean;
  /** Content identity only; deliberately not labeled as a provider turn ID. */
  readonly last_assistant_message?: {
    readonly sha256: string;
    readonly utf8_bytes: number;
  };
}

export interface IngestCheckpointEndpointV2 {
  readonly file_identity: FileIdentity;
  readonly byte_offset: number;
  readonly next_line_number: number;
  readonly observed_size: number;
}

export interface IngestTranscriptSnapshotV2 {
  readonly observed_at: string;
  readonly observed_size: number;
  readonly file_identity: FileIdentity;
}

export interface IngestObservationTransitionV2
  extends IngestTranscriptSnapshotV2 {
  readonly first_observed_at: string;
  readonly repeat_count: number;
}

export interface IngestObservationSummaryV2 {
  readonly count: number;
  readonly first: IngestTranscriptSnapshotV2 | null;
  readonly last: IngestTranscriptSnapshotV2 | null;
  /** Identity/size changes only; independently bounded from poll count. */
  readonly size_transitions: readonly IngestObservationTransitionV2[];
  readonly dropped_transitions: number;
}

export type IngestRunnerInputValue =
  | string
  | number
  | boolean
  | readonly string[];

export interface BarbaroIngestAttemptV2 {
  readonly attempt_id: string;
  readonly event: string;
  readonly trigger?: IngestAttemptTriggerV2;
  readonly triggered_at: string;
  readonly pid: number;
  readonly started_at: string;
  readonly observations: IngestObservationSummaryV2;
  readonly checkpoint_before: IngestCheckpointEndpointV2 | null;
  readonly checkpoint_after: IngestCheckpointEndpointV2 | null;
  /** Sum across every poll iteration in this attempt. */
  readonly turns_appended: number;
  readonly runner_input?: Readonly<Record<string, IngestRunnerInputValue>>;
  readonly pending_background_ids: readonly string[];
  readonly pending_agent_ids: readonly string[];
  readonly withheld_reason?: string;
  readonly publish_blocker?: string;
  readonly finished_at?: string;
  readonly outcome?: IngestAttemptOutcome;
  readonly migrated_from_schema?: typeof LEGACY_INGEST_ATTEMPT_SCHEMA;
  readonly autopsied_at?: string;
}

export interface BarbaroIngestAttemptJournalV2 {
  readonly schema: typeof INGEST_ATTEMPT_SCHEMA;
  readonly provider: string;
  readonly session_id: string;
  readonly dropped_attempts: number;
  readonly attempts: readonly BarbaroIngestAttemptV2[];
}

export interface IngestAttemptObservation {
  readonly observedSize: number;
  readonly fileIdentity: FileIdentity;
  readonly checkpointBefore?: JsonlCheckpoint;
  readonly checkpointAfter?: JsonlCheckpoint;
  readonly runnerInput: Readonly<
    Record<string, IngestRunnerInputValue | undefined>
  >;
  readonly turnsAppended: number;
  readonly pendingBackgroundIds?: readonly string[];
  readonly pendingAgentIds?: readonly string[];
  readonly withheldReason?: string;
  readonly publishBlocker?: string;
}

export interface IngestAttemptHandle {
  readonly attemptId: string;
  readonly observe: (observation: IngestAttemptObservation) => Promise<void>;
  readonly finish: (outcome: IngestAttemptOutcome) => Promise<void>;
}

export interface BeginIngestAttemptOptions {
  readonly projectRoot: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly event: string;
  readonly tracePath?: string;
  /** Captured at hook entry; logging still begins only after consent. */
  readonly triggeredAt?: string;
  readonly nativeTurnId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly stopHookActive?: boolean;
  readonly lastAssistantMessage?: string;
}

/**
 * Start one fail-open, bounded ingest-attempt record.
 *
 * The path stays an atomically replaced JSON document, but v2 is an
 * append-style journal rather than a latest-wins slot. Updates are keyed by
 * attempt ID, so overlapping hooks retain and finish independently.
 */
export async function beginIngestAttempt(
  options: BeginIngestAttemptOptions,
): Promise<IngestAttemptHandle> {
  const attemptId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();
  const trigger = createTrigger(options);
  const initialSnapshot = await sourceSnapshot(options.tracePath, startedAt);
  const base: BarbaroIngestAttemptV2 = {
    attempt_id: attemptId,
    event: bounded(options.event, MAX_EVENT_BYTES),
    ...(trigger === undefined ? {} : { trigger }),
    triggered_at: options.triggeredAt ?? startedAt,
    pid: process.pid,
    started_at: startedAt,
    observations:
      initialSnapshot === undefined
        ? emptyObservationSummary()
        : addObservation(emptyObservationSummary(), initialSnapshot),
    checkpoint_before: null,
    checkpoint_after: null,
    turns_appended: 0,
    pending_background_ids: [],
    pending_agent_ids: [],
  };
  const journalKey = {
    provider: options.provider,
    session_id: options.sessionId,
  };

  const birthPersisted = await withAttemptJournal(
    options.projectRoot,
    journalKey,
    async (target, current) => {
      const autopsied = await autopsyDeadAttempts(
        options.projectRoot,
        current,
      );
      await replaceJournal(target, appendAttempt(autopsied, base));
    },
    MAX_LOG_RECORD_LOCK_WAIT_MS,
  );

  // Each handle owns one absolute snapshot. Polls update it in call order,
  // while the journal is rewritten only for the first functional read, a
  // material diagnosis change, and finish. Identical polls stay in memory;
  // source/checkpoint/blocker/output transitions flush immediately. Persisting
  // absolute state makes a retry idempotent if an atomic rename committed but
  // lock cleanup made the result ambiguous.
  let currentAttempt = base;
  let functionalObservations = 0;
  let finished = false;
  let persistedSignature = birthPersisted
    ? attemptPersistenceSignature(base)
    : undefined;
  let sequence: Promise<void> = Promise.resolve();

  const persist = async (waitTimeoutMs: number): Promise<boolean> =>
    withAttemptJournal(
      options.projectRoot,
      journalKey,
      async (target, current) => {
        const index = current.attempts.findIndex(
          (attempt) => attempt.attempt_id === attemptId,
        );
        const attempts = [...current.attempts];
        if (index === -1) attempts.push(currentAttempt);
        else attempts[index] = currentAttempt;
        await replaceJournal(target, fitJournal({ ...current, attempts }));
      },
      waitTimeoutMs,
    );

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const queued = sequence.then(operation, operation).catch(() => undefined);
    sequence = queued;
    return queued;
  };

  return {
    attemptId,
    observe: (observation) => {
      // Capture the timestamp beside the pinned read, before journal-lock
      // latency can distort when these transcript bytes were actually seen.
      const observedAt = new Date().toISOString();
      return enqueue(async () => {
        if (finished) return;
        currentAttempt = observeAttempt(
          currentAttempt,
          observation,
          observedAt,
        );
        functionalObservations += 1;
        const signature = attemptPersistenceSignature(currentAttempt);
        if (
          functionalObservations === 1 ||
          signature !== persistedSignature
        ) {
          if (await persist(MAX_LOG_OBSERVE_LOCK_WAIT_MS)) {
            persistedSignature = signature;
          }
        }
      });
    },
    finish: (outcome) =>
      enqueue(async () => {
        if (finished) return;
        finished = true;
        currentAttempt = {
          ...currentAttempt,
          finished_at: new Date().toISOString(),
          outcome,
        };
        // A failed diagnostic remains fail-open, but one bounded retry gives a
        // contended finish a second chance to record the honest outcome.
        if (!(await persist(MAX_LOG_RECORD_LOCK_WAIT_MS))) {
          await persist(MAX_LOG_RECORD_LOCK_WAIT_MS);
        }
      }),
  };
}

function createTrigger(
  options: BeginIngestAttemptOptions,
): IngestAttemptTriggerV2 | undefined {
  const nativeTurnId = optionalBounded(options.nativeTurnId, MAX_ID_BYTES);
  const turnId = optionalBounded(options.turnId, MAX_ID_BYTES);
  const agentId = optionalBounded(options.agentId, MAX_ID_BYTES);
  const stopHookActive = options.stopHookActive;
  const message = options.lastAssistantMessage;
  const lastAssistantMessage =
    message === undefined || message.length === 0
      ? undefined
      : {
          sha256: createHash("sha256").update(message, "utf8").digest("hex"),
          utf8_bytes: Buffer.byteLength(message, "utf8"),
        };
  if (
    nativeTurnId === undefined &&
    turnId === undefined &&
    agentId === undefined &&
    stopHookActive === undefined &&
    lastAssistantMessage === undefined
  ) {
    return undefined;
  }
  return {
    ...(nativeTurnId === undefined ? {} : { native_turn_id: nativeTurnId }),
    ...(turnId === undefined ? {} : { turn_id: turnId }),
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    ...(stopHookActive === undefined
      ? {}
      : { stop_hook_active: stopHookActive }),
    ...(lastAssistantMessage === undefined
      ? {}
      : { last_assistant_message: lastAssistantMessage }),
  };
}

function observeAttempt(
  attempt: BarbaroIngestAttemptV2,
  observation: IngestAttemptObservation,
  observedAt: string,
): BarbaroIngestAttemptV2 {
  const snapshot: IngestTranscriptSnapshotV2 = {
    observed_at: observedAt,
    observed_size: safeNonNegativeInteger(
      observation.observedSize,
      "observedSize",
    ),
    file_identity: copyFileIdentity(observation.fileIdentity),
  };
  const observations = addObservation(attempt.observations, snapshot);
  const checkpointBefore =
    attempt.runner_input === undefined
      ? checkpointEndpoint(observation.checkpointBefore)
      : attempt.checkpoint_before;
  const checkpointAfter = checkpointEndpoint(observation.checkpointAfter);
  const { withheld_reason: _withheld, publish_blocker: _blocker, ...prior } =
    attempt;
  return {
    ...prior,
    observations,
    checkpoint_before: checkpointBefore,
    checkpoint_after: checkpointAfter,
    turns_appended:
      attempt.turns_appended +
      safeNonNegativeInteger(observation.turnsAppended, "turnsAppended"),
    runner_input: boundedRunnerInput(observation.runnerInput),
    pending_background_ids: boundedIds(
      observation.pendingBackgroundIds ?? [],
    ),
    pending_agent_ids: boundedIds(observation.pendingAgentIds ?? []),
    ...(observation.withheldReason === undefined
      ? {}
      : {
          withheld_reason: bounded(
            observation.withheldReason,
            MAX_RUNNER_STRING_BYTES,
          ),
        }),
    ...(observation.publishBlocker === undefined
      ? {}
      : {
          publish_blocker: bounded(
            observation.publishBlocker,
            MAX_RUNNER_STRING_BYTES,
          ),
        }),
  };
}

/** Material state whose loss would change the attempt's diagnosis. */
function attemptPersistenceSignature(attempt: BarbaroIngestAttemptV2): string {
  const last = attempt.observations.last;
  return stableStringify({
    source:
      last === null
        ? null
        : {
            observed_size: last.observed_size,
            file_identity: last.file_identity,
          },
    source_transitions: attempt.observations.size_transitions.map(
      (transition) => ({
        observed_size: transition.observed_size,
        file_identity: transition.file_identity,
      }),
    ),
    dropped_source_transitions: attempt.observations.dropped_transitions,
    checkpoint_before: attempt.checkpoint_before,
    checkpoint_after: attempt.checkpoint_after,
    turns_appended: attempt.turns_appended,
    runner_input: attempt.runner_input ?? null,
    pending_background_ids: attempt.pending_background_ids,
    pending_agent_ids: attempt.pending_agent_ids,
    withheld_reason: attempt.withheld_reason ?? null,
    publish_blocker: attempt.publish_blocker ?? null,
    finished_at: attempt.finished_at ?? null,
    outcome: attempt.outcome ?? null,
  });
}

function emptyObservationSummary(): IngestObservationSummaryV2 {
  return {
    count: 0,
    first: null,
    last: null,
    size_transitions: [],
    dropped_transitions: 0,
  };
}

function addObservation(
  current: IngestObservationSummaryV2,
  snapshot: IngestTranscriptSnapshotV2,
): IngestObservationSummaryV2 {
  const transitions = [...current.size_transitions];
  const previous = transitions.at(-1);
  if (
    previous !== undefined &&
    previous.observed_size === snapshot.observed_size &&
    sameFileIdentity(previous.file_identity, snapshot.file_identity)
  ) {
    transitions[transitions.length - 1] = {
      ...previous,
      observed_at: snapshot.observed_at,
      repeat_count: previous.repeat_count + 1,
    };
  } else {
    transitions.push({
      ...snapshot,
      first_observed_at: snapshot.observed_at,
      repeat_count: 1,
    });
  }
  let droppedTransitions = current.dropped_transitions;
  while (transitions.length > MAX_INGEST_OBSERVATION_TRANSITIONS) {
    transitions.shift();
    droppedTransitions += 1;
  }
  return {
    count: current.count + 1,
    first: current.first ?? snapshot,
    last: snapshot,
    size_transitions: transitions,
    dropped_transitions: droppedTransitions,
  };
}

async function autopsyDeadAttempts(
  projectRoot: string,
  journal: BarbaroIngestAttemptJournalV2,
): Promise<BarbaroIngestAttemptJournalV2> {
  const occurredAt = new Date().toISOString();
  const deaths: BarbaroIngestAttemptV2[] = [];
  const attempts = journal.attempts.map((attempt) => {
    if (
      attempt.finished_at !== undefined ||
      attempt.outcome !== undefined ||
      attempt.pid === process.pid ||
      isPidAlive(attempt.pid)
    ) {
      return attempt;
    }
    const dead = {
      ...attempt,
      finished_at: occurredAt,
      outcome: "outcome_not_recorded" as const,
      autopsied_at: occurredAt,
    };
    deaths.push(dead);
    return dead;
  });
  for (const dead of deaths) {
    await recordIncident({
      projectRoot,
      provider: journal.provider,
      kind: "hook_error",
      event: dead.event,
      dedupKey: journal.session_id,
      detail:
        "ingest attempt owner exited without a recorded outcome; " +
        "see the bounded ingest journal",
    });
  }
  return { ...journal, attempts };
}

function appendAttempt(
  journal: BarbaroIngestAttemptJournalV2,
  attempt: BarbaroIngestAttemptV2,
): BarbaroIngestAttemptJournalV2 {
  return fitJournal({
    ...journal,
    attempts: [...journal.attempts, attempt],
  });
}

function fitJournal(
  journal: BarbaroIngestAttemptJournalV2,
): BarbaroIngestAttemptJournalV2 {
  const attempts = [...journal.attempts];
  let droppedAttempts = journal.dropped_attempts;
  const dropOldest = (): void => {
    const finishedIndex = attempts.findIndex(
      (attempt) => attempt.finished_at !== undefined,
    );
    attempts.splice(finishedIndex === -1 ? 0 : finishedIndex, 1);
    droppedAttempts += 1;
  };
  while (attempts.length > MAX_INGEST_ATTEMPTS) dropOldest();
  let fitted: BarbaroIngestAttemptJournalV2 = {
    ...journal,
    dropped_attempts: droppedAttempts,
    attempts,
  };
  while (
    attempts.length > 1 &&
    journalBytes(fitted) > MAX_INGEST_ATTEMPT_BYTES
  ) {
    dropOldest();
    fitted = {
      ...journal,
      dropped_attempts: droppedAttempts,
      attempts,
    };
  }
  if (journalBytes(fitted) > MAX_INGEST_ATTEMPT_BYTES) {
    const newest = attempts.at(-1);
    if (newest === undefined) return fitted;
    const { runner_input: _runnerInput, ...compact } = newest;
    fitted = {
      ...journal,
      dropped_attempts: droppedAttempts,
      attempts: [
        {
          ...compact,
          observations: {
            ...compact.observations,
            size_transitions: compact.observations.size_transitions.slice(-1),
            dropped_transitions:
              compact.observations.dropped_transitions +
              Math.max(0, compact.observations.size_transitions.length - 1),
          },
        },
      ],
    };
  }
  if (journalBytes(fitted) > MAX_INGEST_ATTEMPT_BYTES) {
    throw new RangeError("bounded ingest-attempt journal record is too large");
  }
  return fitted;
}

function journalBytes(journal: BarbaroIngestAttemptJournalV2): number {
  return Buffer.byteLength(stableStringify(journal), "utf8") + 1;
}

async function withAttemptJournal(
  projectRoot: string,
  record: Pick<BarbaroIngestAttemptJournalV2, "provider" | "session_id">,
  operation: (
    target: string,
    current: BarbaroIngestAttemptJournalV2,
  ) => Promise<void>,
  waitTimeoutMs: number,
): Promise<boolean> {
  let operationCommitted = false;
  try {
    if (projectRoot.length === 0) return false;
    // Never CREATE the store — the same consent fence as incident markers.
    if (!(await storeExists(projectRoot))) return false;
    const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
    const components = [
      "logs",
      "ingest",
      record.provider,
      `${record.session_id}.json`,
    ];
    const target = await boundary.ensureParentForFile(components);
    await withDirectoryLock(
      target,
      async () => {
        const current = await readJournal(boundary, components, record);
        await operation(target, current);
        operationCommitted = true;
      },
      {
        waitTimeoutMs,
        pollIntervalMs: 10,
      },
    );
    return true;
  } catch (error) {
    if (error instanceof DirectoryLockReleaseError && operationCommitted) {
      return true;
    }
    // Diagnostics are fail-open: they never change the observed hook result.
    return false;
  }
}

async function readJournal(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  expected: Pick<BarbaroIngestAttemptJournalV2, "provider" | "session_id">,
): Promise<BarbaroIngestAttemptJournalV2> {
  let json: string | undefined;
  try {
    json = await boundary.readUtf8File(
      components,
      MAX_INGEST_ATTEMPT_BYTES,
    );
  } catch {
    return emptyJournal(expected);
  }
  if (json === undefined) return emptyJournal(expected);
  try {
    const value = JSON.parse(json) as unknown;
    if (isJournalV2(value, expected)) return value;
    if (isLegacyAttempt(value, expected)) {
      return {
        ...emptyJournal(expected),
        attempts: [migrateLegacyAttempt(value)],
      };
    }
  } catch {
    // A corrupt diagnostic is replaced by the next valid bounded journal.
  }
  return emptyJournal(expected);
}

function emptyJournal(
  record: Pick<BarbaroIngestAttemptJournalV2, "provider" | "session_id">,
): BarbaroIngestAttemptJournalV2 {
  return {
    schema: INGEST_ATTEMPT_SCHEMA,
    provider: record.provider,
    session_id: record.session_id,
    dropped_attempts: 0,
    attempts: [],
  };
}

function migrateLegacyAttempt(
  legacy: BarbaroIngestAttemptV1,
): BarbaroIngestAttemptV2 {
  return {
    attempt_id: bounded(legacy.attempt_id, MAX_ID_BYTES),
    event: bounded(legacy.event, MAX_EVENT_BYTES),
    triggered_at: legacy.started_at,
    pid: legacy.pid,
    started_at: legacy.started_at,
    observations: emptyObservationSummary(),
    checkpoint_before: null,
    checkpoint_after: null,
    turns_appended: 0,
    pending_background_ids: [],
    pending_agent_ids: [],
    ...(legacy.finished_at === undefined
      ? {}
      : { finished_at: legacy.finished_at }),
    ...(legacy.outcome === undefined ? {} : { outcome: legacy.outcome }),
    migrated_from_schema: LEGACY_INGEST_ATTEMPT_SCHEMA,
  };
}

function isJournalV2(
  value: unknown,
  expected: Pick<BarbaroIngestAttemptJournalV2, "provider" | "session_id">,
): value is BarbaroIngestAttemptJournalV2 {
  if (!isObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "schema",
      "provider",
      "session_id",
      "dropped_attempts",
      "attempts",
    ]) ||
    value.schema !== INGEST_ATTEMPT_SCHEMA ||
    value.provider !== expected.provider ||
    value.session_id !== expected.session_id ||
    !Number.isSafeInteger(value.dropped_attempts) ||
    (value.dropped_attempts as number) < 0 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > MAX_INGEST_ATTEMPTS
  ) {
    return false;
  }
  return value.attempts.every(isAttemptV2);
}

function isAttemptV2(value: unknown): value is BarbaroIngestAttemptV2 {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "attempt_id",
      "event",
      "trigger",
      "triggered_at",
      "pid",
      "started_at",
      "observations",
      "checkpoint_before",
      "checkpoint_after",
      "turns_appended",
      "runner_input",
      "pending_background_ids",
      "pending_agent_ids",
      "withheld_reason",
      "publish_blocker",
      "finished_at",
      "outcome",
      "migrated_from_schema",
      "autopsied_at",
    ])
  ) {
    return false;
  }
  return (
    isBoundedString(value.attempt_id, MAX_ID_BYTES, false) &&
    isBoundedString(value.event, MAX_EVENT_BYTES, false) &&
    isTriggerV2(value.trigger) &&
    isTimestamp(value.triggered_at) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    isTimestamp(value.started_at) &&
    isObservationSummaryV2(value.observations) &&
    (value.checkpoint_before === null ||
      isCheckpointEndpointV2(value.checkpoint_before)) &&
    (value.checkpoint_after === null ||
      isCheckpointEndpointV2(value.checkpoint_after)) &&
    isNonNegativeSafeInteger(value.turns_appended) &&
    isRunnerInputV2(value.runner_input) &&
    isBoundedIdArray(value.pending_background_ids) &&
    isBoundedIdArray(value.pending_agent_ids) &&
    isOptionalBoundedString(value.withheld_reason, MAX_RUNNER_STRING_BYTES) &&
    isOptionalBoundedString(value.publish_blocker, MAX_RUNNER_STRING_BYTES) &&
    (value.finished_at === undefined || isTimestamp(value.finished_at)) &&
    (value.outcome === undefined || isIngestAttemptOutcome(value.outcome)) &&
    (value.finished_at === undefined) === (value.outcome === undefined) &&
    (value.migrated_from_schema === undefined ||
      value.migrated_from_schema === LEGACY_INGEST_ATTEMPT_SCHEMA) &&
    (value.autopsied_at === undefined || isTimestamp(value.autopsied_at))
  );
}

function isTriggerV2(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "native_turn_id",
      "turn_id",
      "agent_id",
      "stop_hook_active",
      "last_assistant_message",
    ]) ||
    !isOptionalBoundedString(value.native_turn_id, MAX_ID_BYTES) ||
    !isOptionalBoundedString(value.turn_id, MAX_ID_BYTES) ||
    !isOptionalBoundedString(value.agent_id, MAX_ID_BYTES) ||
    (value.stop_hook_active !== undefined &&
      typeof value.stop_hook_active !== "boolean")
  ) {
    return false;
  }
  const message = value.last_assistant_message;
  return (
    message === undefined ||
    (isObject(message) &&
      hasOnlyKeys(message, ["sha256", "utf8_bytes"]) &&
      typeof message.sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(message.sha256) &&
      isNonNegativeSafeInteger(message.utf8_bytes))
  );
}

function isObservationSummaryV2(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "count",
      "first",
      "last",
      "size_transitions",
      "dropped_transitions",
    ]) ||
    !isNonNegativeSafeInteger(value.count) ||
    !isNonNegativeSafeInteger(value.dropped_transitions) ||
    !Array.isArray(value.size_transitions) ||
    value.size_transitions.length > MAX_INGEST_OBSERVATION_TRANSITIONS ||
    !value.size_transitions.every(isObservationTransitionV2)
  ) {
    return false;
  }
  if (value.count === 0) {
    return (
      value.first === null &&
      value.last === null &&
      value.size_transitions.length === 0
    );
  }
  return (
    isTranscriptSnapshotV2(value.first) &&
    isTranscriptSnapshotV2(value.last) &&
    value.size_transitions.length > 0
  );
}

function isTranscriptSnapshotV2(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["observed_at", "observed_size", "file_identity"]) &&
    isTimestamp(value.observed_at) &&
    isNonNegativeSafeInteger(value.observed_size) &&
    isFileIdentityV2(value.file_identity)
  );
}

function isObservationTransitionV2(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "observed_at",
      "observed_size",
      "file_identity",
      "first_observed_at",
      "repeat_count",
    ]) &&
    isTimestamp(value.observed_at) &&
    isNonNegativeSafeInteger(value.observed_size) &&
    isFileIdentityV2(value.file_identity) &&
    isTimestamp(value.first_observed_at) &&
    Number.isSafeInteger(value.repeat_count) &&
    (value.repeat_count as number) > 0
  );
}

function isCheckpointEndpointV2(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "file_identity",
      "byte_offset",
      "next_line_number",
      "observed_size",
    ]) &&
    isFileIdentityV2(value.file_identity) &&
    isNonNegativeSafeInteger(value.byte_offset) &&
    Number.isSafeInteger(value.next_line_number) &&
    (value.next_line_number as number) > 0 &&
    isNonNegativeSafeInteger(value.observed_size) &&
    (value.byte_offset as number) <= (value.observed_size as number)
  );
}

function isFileIdentityV2(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["device", "inode", "birthtime_ns"])
  ) {
    return false;
  }
  return [value.device, value.inode, value.birthtime_ns].every(
    (part) =>
      typeof part === "string" &&
      part.length <= 64 &&
      /^(?:0|[1-9][0-9]*)$/u.test(part),
  );
}

function isRunnerInputV2(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_RUNNER_INPUT_FIELDS) return false;
  return entries.every(([key, item]) => {
    if (!isBoundedString(key, 128, false)) return false;
    if (typeof item === "string") {
      return isBoundedString(item, MAX_RUNNER_STRING_BYTES, true);
    }
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "boolean") return true;
    return isBoundedIdArray(item);
  });
}

function isBoundedIdArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_RUNNER_ARRAY_ITEMS &&
    value.every((item) => isBoundedString(item, MAX_ID_BYTES, true))
  );
}

function isIngestAttemptOutcome(value: unknown): value is IngestAttemptOutcome {
  return (
    value === "ok" ||
    value === "error" ||
    value === "process_died" ||
    value === "outcome_not_recorded" ||
    value === "stop_turn_not_visible"
  );
}

function isTimestamp(value: unknown): boolean {
  return (
    isBoundedString(value, 64, false) &&
    Number.isFinite(Date.parse(value))
  );
}

function isOptionalBoundedString(
  value: unknown,
  maximumBytes: number,
): boolean {
  return value === undefined || isBoundedString(value, maximumBytes, true);
}

function isBoundedString(
  value: unknown,
  maximumBytes: number,
  allowEmpty: boolean,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function isLegacyAttempt(
  value: unknown,
  expected: Pick<BarbaroIngestAttemptJournalV2, "provider" | "session_id">,
): value is BarbaroIngestAttemptV1 {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "schema",
      "provider",
      "session_id",
      "event",
      "attempt_id",
      "pid",
      "started_at",
      "finished_at",
      "outcome",
    ]) &&
    value.schema === LEGACY_INGEST_ATTEMPT_SCHEMA &&
    value.provider === expected.provider &&
    value.session_id === expected.session_id &&
    isBoundedString(value.event, MAX_EVENT_BYTES, false) &&
    isBoundedString(value.attempt_id, MAX_ID_BYTES, false) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    isTimestamp(value.started_at) &&
    (value.finished_at === undefined || isTimestamp(value.finished_at)) &&
    (value.outcome === undefined ||
      value.outcome === "ok" ||
      value.outcome === "error") &&
    (value.finished_at === undefined) === (value.outcome === undefined)
  );
}

async function replaceJournal(
  target: string,
  journal: BarbaroIngestAttemptJournalV2,
): Promise<void> {
  const fitted = fitJournal(journal);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${stableStringify(fitted)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function checkpointEndpoint(
  checkpoint: JsonlCheckpoint | undefined,
): IngestCheckpointEndpointV2 | null {
  if (checkpoint === undefined) return null;
  return {
    file_identity: copyFileIdentity(checkpoint.file_identity),
    byte_offset: checkpoint.byte_offset,
    next_line_number: checkpoint.next_line_number,
    observed_size: checkpoint.observed_size,
  };
}

function boundedRunnerInput(
  input: Readonly<Record<string, IngestRunnerInputValue | undefined>>,
): Readonly<Record<string, IngestRunnerInputValue>> {
  const result: Record<string, IngestRunnerInputValue> = {};
  for (const key of Object.keys(input).sort().slice(0, MAX_RUNNER_INPUT_FIELDS)) {
    const value = input[key];
    if (typeof value === "string") {
      result[bounded(key, 128)] = bounded(value, MAX_RUNNER_STRING_BYTES);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[bounded(key, 128)] = value;
    } else if (typeof value === "boolean") {
      result[bounded(key, 128)] = value;
    } else if (Array.isArray(value)) {
      result[bounded(key, 128)] = boundedIds(value);
    }
  }
  return result;
}

function boundedIds(values: readonly string[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .slice(0, MAX_RUNNER_ARRAY_ITEMS)
    .map((value) => bounded(value, MAX_ID_BYTES));
}

function copyFileIdentity(identity: FileIdentity): FileIdentity {
  return {
    device: identity.device,
    inode: identity.inode,
    birthtime_ns: identity.birthtime_ns,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtime_ns === right.birthtime_ns
  );
}

function bounded(value: string, maximumBytes: number): string {
  return truncateUtf8(value, maximumBytes);
}

function optionalBounded(
  value: string | undefined,
  maximumBytes: number,
): string | undefined {
  return value === undefined || value.length === 0
    ? undefined
    : bounded(value, maximumBytes);
}

function safeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

async function storeExists(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(join(projectRoot, ".barbaro"))).isDirectory();
  } catch {
    return false;
  }
}

async function sourceSnapshot(
  tracePath: string | undefined,
  observedAt: string,
): Promise<IngestTranscriptSnapshotV2 | undefined> {
  if (tracePath === undefined) return undefined;
  try {
    const snapshot = snapshotFromStats(await stat(tracePath, { bigint: true }));
    return {
      observed_at: observedAt,
      observed_size: snapshot.size,
      file_identity: copyFileIdentity(snapshot.identity),
    };
  } catch {
    return undefined;
  }
}
