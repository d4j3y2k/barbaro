import {
  INGEST_ATTEMPT_SCHEMA,
  MAX_INGEST_ATTEMPTS,
  MAX_INGEST_OBSERVATION_TRANSITIONS,
  type BarbaroIngestAttemptJournalV2,
} from "../hooks/ingest-attempt.js";

const MAX_EVENT_BYTES = 256;
const MAX_ID_BYTES = 512;
const MAX_RUNNER_INPUT_FIELDS = 32;
const MAX_RUNNER_ARRAY_ITEMS = 32;
const MAX_RUNNER_STRING_BYTES = 512;

/**
 * Strict, reader-owned validation for a v2 ingest journal.
 *
 * The hook writer's parser is deliberately private and fail-open because a
 * later write may replace corrupt diagnostics. Readers need the opposite
 * policy: validate without repair, and preserve every proof gap as unknown.
 */
export function parseReaderIngestJournal(
  value: unknown,
  expectedProvider: string,
  expectedSessionId: string,
): BarbaroIngestAttemptJournalV2 {
  if (!isObject(value)) throw new TypeError("journal must be an object");
  if (
    typeof value.provider !== "string" ||
    typeof value.session_id !== "string"
  ) {
    throw new TypeError("journal is structurally invalid");
  }
  if (
    value.provider !== expectedProvider ||
    value.session_id !== expectedSessionId
  ) {
    throw new TypeError("journal identity does not match its storage path");
  }
  if (
    !hasOnlyKeys(value, [
      "schema",
      "provider",
      "session_id",
      "dropped_attempts",
      "attempts",
    ]) ||
    value.schema !== INGEST_ATTEMPT_SCHEMA ||
    !isNonNegativeSafeInteger(value.dropped_attempts) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > MAX_INGEST_ATTEMPTS ||
    !Number.isSafeInteger(Number(value.dropped_attempts) + value.attempts.length) ||
    !value.attempts.every(isAttemptV2) ||
    !uniqueAttemptIds(value.attempts)
  ) {
    throw new TypeError("journal is structurally invalid");
  }
  return value as unknown as BarbaroIngestAttemptJournalV2;
}

function uniqueAttemptIds(attempts: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (!isObject(attempt) || typeof attempt.attempt_id !== "string") {
      return false;
    }
    if (seen.has(attempt.attempt_id)) return false;
    seen.add(attempt.attempt_id);
  }
  return true;
}

function isAttemptV2(value: unknown): boolean {
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
    isTrigger(value.trigger) &&
    isTimestamp(value.triggered_at) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    isTimestamp(value.started_at) &&
    isObservationSummary(value.observations) &&
    (value.checkpoint_before === null ||
      isCheckpointEndpoint(value.checkpoint_before)) &&
    (value.checkpoint_after === null ||
      isCheckpointEndpoint(value.checkpoint_after)) &&
    isNonNegativeSafeInteger(value.turns_appended) &&
    isRunnerInput(value.runner_input) &&
    isBoundedIdArray(value.pending_background_ids) &&
    isBoundedIdArray(value.pending_agent_ids) &&
    isOptionalBoundedString(value.withheld_reason, MAX_RUNNER_STRING_BYTES) &&
    isOptionalBoundedString(value.publish_blocker, MAX_RUNNER_STRING_BYTES) &&
    (value.finished_at === undefined || isTimestamp(value.finished_at)) &&
    (value.outcome === undefined || isAttemptOutcome(value.outcome)) &&
    (value.finished_at === undefined) === (value.outcome === undefined) &&
    (value.migrated_from_schema === undefined ||
      value.migrated_from_schema === "barbaro.ingest-attempt.v1") &&
    (value.autopsied_at === undefined || isTimestamp(value.autopsied_at))
  );
}

function isTrigger(value: unknown): boolean {
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

function isObservationSummary(value: unknown): boolean {
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
    !value.size_transitions.every(isObservationTransition)
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
    isTranscriptSnapshot(value.first) &&
    isTranscriptSnapshot(value.last) &&
    value.size_transitions.length > 0
  );
}

function isTranscriptSnapshot(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["observed_at", "observed_size", "file_identity"]) &&
    isTimestamp(value.observed_at) &&
    isNonNegativeSafeInteger(value.observed_size) &&
    isFileIdentity(value.file_identity)
  );
}

function isObservationTransition(value: unknown): boolean {
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
    isFileIdentity(value.file_identity) &&
    isTimestamp(value.first_observed_at) &&
    Number.isSafeInteger(value.repeat_count) &&
    Number(value.repeat_count) > 0
  );
}

function isCheckpointEndpoint(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "file_identity",
      "byte_offset",
      "next_line_number",
      "observed_size",
    ]) &&
    isFileIdentity(value.file_identity) &&
    isNonNegativeSafeInteger(value.byte_offset) &&
    Number.isSafeInteger(value.next_line_number) &&
    Number(value.next_line_number) > 0 &&
    isNonNegativeSafeInteger(value.observed_size) &&
    Number(value.byte_offset) <= Number(value.observed_size)
  );
}

function isFileIdentity(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["device", "inode", "birthtime_ns"]) &&
    [value.device, value.inode, value.birthtime_ns].every(
      (part) =>
        typeof part === "string" &&
        part.length <= 64 &&
        /^(?:0|[1-9][0-9]*)$/u.test(part),
    )
  );
}

function isRunnerInput(value: unknown): boolean {
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

function isAttemptOutcome(value: unknown): boolean {
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
    isBoundedString(value, 64, false) && Number.isFinite(Date.parse(value))
  );
}

function isOptionalBoundedString(value: unknown, maximumBytes: number): boolean {
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
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
