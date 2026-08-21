import {
  ACTIVE_LEASE_SCHEMA,
  type ActiveActorKey,
  type ActiveContent,
  type ActiveCurrentAction,
  type ActiveLeaseV1,
  type ActiveSourceRef,
  type ActiveWriteClaim,
} from "./types.js";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/;
const LEASE_ID_PATTERN = /^lease_[0-9a-f]{32}$/;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;
const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/;
const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

const TOP_LEVEL_KEYS = new Set([
  "schema",
  "lease_id",
  "provider",
  "session_id",
  "turn_id",
  "agent_id",
  "state",
  "intent",
  "current_action",
  "claims",
  "unknown_write_scope",
  "revision",
  "updated_at",
  "expires_at",
  "source_refs",
  "extensions",
]);

interface ValidationIssue {
  path: string;
  message: string;
}

export class ActiveLeaseValidationError extends TypeError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Invalid barbaro.active.v1 lease: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "ActiveLeaseValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue(issues, `${path}.${key}`, "is not allowed");
    }
  }
}

function validateString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  pattern?: RegExp,
): value is string {
  if (typeof value !== "string") {
    issue(issues, path, "must be a string");
    return false;
  }
  if (value.length === 0) {
    issue(issues, path, "must not be empty");
    return false;
  }
  if (pattern !== undefined && !pattern.test(value)) {
    issue(issues, path, "has an invalid format");
    return false;
  }
  return true;
}

function validateSafeInteger(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  minimum: number,
): value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAX_SAFE_INTEGER
  ) {
    issue(
      issues,
      path,
      `must be a safe integer between ${minimum} and ${MAX_SAFE_INTEGER}`,
    );
    return false;
  }
  return true;
}

function timestampMillis(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  if (typeof value !== "string") {
    issue(issues, path, "must be an RFC 3339 date-time string");
    return undefined;
  }
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) {
    issue(issues, path, "must be an RFC 3339 date-time string");
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maximumDay = month >= 1 && month <= 12 ? monthDays[month - 1] : 0;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    maximumDay === undefined ||
    day > maximumDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    issue(issues, path, "must be a real RFC 3339 date-time");
    return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    issue(issues, path, "must be a real date-time");
    return undefined;
  }
  return milliseconds;
}

function validateRepoPath(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is string {
  if (!validateString(value, path, issues)) {
    return false;
  }

  const components = value.split("/");
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    components.includes("..")
  ) {
    issue(issues, path, "must be a workspace-relative POSIX path without '..'");
    return false;
  }
  return true;
}

function validateContent(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ActiveContent {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  rejectUnknownKeys(
    value,
    new Set([
      "text",
      "fidelity",
      "truncated",
      "original_utf8_bytes",
      "redactions",
    ]),
    path,
    issues,
  );

  if (typeof value.text !== "string") {
    issue(issues, `${path}.text`, "must be a string");
  }
  if (
    value.fidelity !== "verbatim" &&
    value.fidelity !== "normalized" &&
    value.fidelity !== "excerpt" &&
    value.fidelity !== "redacted"
  ) {
    issue(issues, `${path}.fidelity`, "has an invalid value");
  }
  if (typeof value.truncated !== "boolean") {
    issue(issues, `${path}.truncated`, "must be a boolean");
  }
  if (value.original_utf8_bytes !== undefined) {
    validateSafeInteger(
      value.original_utf8_bytes,
      `${path}.original_utf8_bytes`,
      issues,
      0,
    );
  } else if (value.truncated === true) {
    issue(
      issues,
      `${path}.original_utf8_bytes`,
      "is required when content is truncated",
    );
  }

  if (!Array.isArray(value.redactions)) {
    issue(issues, `${path}.redactions`, "must be an array");
  } else {
    value.redactions.forEach((redaction, index) => {
      const redactionPath = `${path}.redactions[${index}]`;
      if (!isRecord(redaction)) {
        issue(issues, redactionPath, "must be an object");
        return;
      }
      rejectUnknownKeys(
        redaction,
        new Set(["kind", "count"]),
        redactionPath,
        issues,
      );
      validateString(redaction.kind, `${redactionPath}.kind`, issues);
      validateSafeInteger(
        redaction.count,
        `${redactionPath}.count`,
        issues,
        1,
      );
    });
  }
  return true;
}

function validateCurrentAction(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ActiveCurrentAction {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  rejectUnknownKeys(
    value,
    new Set(["kind", "tool_name", "path", "command", "started_at"]),
    path,
    issues,
  );
  if (
    value.kind !== "file_change" &&
    value.kind !== "command" &&
    value.kind !== "test" &&
    value.kind !== "tool" &&
    value.kind !== "other"
  ) {
    issue(issues, `${path}.kind`, "has an invalid value");
  }
  if (value.tool_name !== undefined) {
    validateString(value.tool_name, `${path}.tool_name`, issues);
  }
  if (value.path !== undefined) {
    validateRepoPath(value.path, `${path}.path`, issues);
  }
  if (value.command !== undefined) {
    validateContent(value.command, `${path}.command`, issues);
  }
  if (value.started_at !== undefined) {
    timestampMillis(value.started_at, `${path}.started_at`, issues);
  }
  return true;
}

function validateClaim(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ActiveWriteClaim {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  rejectUnknownKeys(
    value,
    new Set(["path", "mode", "confidence"]),
    path,
    issues,
  );
  validateRepoPath(value.path, `${path}.path`, issues);
  if (value.mode !== "write") {
    issue(issues, `${path}.mode`, "must equal 'write'");
  }
  if (value.confidence !== "exact" && value.confidence !== "inferred") {
    issue(issues, `${path}.confidence`, "has an invalid value");
  }
  return true;
}

function validateSourceRef(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ActiveSourceRef {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  rejectUnknownKeys(
    value,
    new Set([
      "trace_id",
      "trace_path",
      "line_start",
      "line_end",
      "native_record_ids",
    ]),
    path,
    issues,
  );
  validateString(value.trace_id, `${path}.trace_id`, issues);
  if (value.trace_path !== undefined) {
    validateString(value.trace_path, `${path}.trace_path`, issues);
  }
  if (value.line_start !== undefined) {
    validateSafeInteger(value.line_start, `${path}.line_start`, issues, 1);
  }
  if (value.line_end !== undefined) {
    validateSafeInteger(value.line_end, `${path}.line_end`, issues, 1);
    if (value.line_start === undefined) {
      issue(issues, `${path}.line_start`, "is required when line_end is present");
    } else if (
      typeof value.line_start === "number" &&
      typeof value.line_end === "number" &&
      value.line_end < value.line_start
    ) {
      issue(issues, `${path}.line_end`, "must not precede line_start");
    }
  }
  if (value.native_record_ids !== undefined) {
    if (!Array.isArray(value.native_record_ids)) {
      issue(issues, `${path}.native_record_ids`, "must be an array");
    } else {
      value.native_record_ids.forEach((recordId, index) => {
        validateString(
          recordId,
          `${path}.native_record_ids[${index}]`,
          issues,
        );
      });
    }
  }
  return true;
}

function validateJsonValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issue(issues, path, "must be a finite JSON number");
    }
    return;
  }
  if (typeof value !== "object") {
    issue(issues, path, "must contain only JSON values");
    return;
  }
  if (ancestors.has(value)) {
    issue(issues, path, "must not contain a cycle");
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateJsonValue(item, `${path}[${index}]`, issues, ancestors);
    });
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issue(issues, path, "must be a plain JSON object");
    } else {
      for (const [key, item] of Object.entries(value)) {
        validateJsonValue(item, `${path}.${key}`, issues, ancestors);
      }
    }
  }
  ancestors.delete(value);
}

export function validateActiveActorKey(
  value: unknown,
): asserts value is ActiveActorKey {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new ActiveLeaseValidationError([
      { path: "$", message: "must be an actor key object" },
    ]);
  }
  validateString(value.provider, "$.provider", issues, PROVIDER_PATTERN);
  validateString(value.session_id, "$.session_id", issues, SESSION_ID_PATTERN);
  validateString(value.agent_id, "$.agent_id", issues);
  if (issues.length > 0) {
    throw new ActiveLeaseValidationError(issues);
  }
}

export function validateActiveLease(
  value: unknown,
): asserts value is ActiveLeaseV1 {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new ActiveLeaseValidationError([
      { path: "$", message: "must be an object" },
    ]);
  }

  rejectUnknownKeys(value, TOP_LEVEL_KEYS, "$", issues);
  validateJsonValue(value, "$", issues, new Set());
  if (value.schema !== ACTIVE_LEASE_SCHEMA) {
    issue(issues, "$.schema", `must equal '${ACTIVE_LEASE_SCHEMA}'`);
  }
  validateString(value.lease_id, "$.lease_id", issues, LEASE_ID_PATTERN);
  validateString(value.provider, "$.provider", issues, PROVIDER_PATTERN);
  validateString(value.session_id, "$.session_id", issues, SESSION_ID_PATTERN);
  if (value.turn_id !== undefined) {
    validateString(value.turn_id, "$.turn_id", issues, TURN_ID_PATTERN);
  }
  validateString(value.agent_id, "$.agent_id", issues);
  if (
    value.state !== "working" &&
    value.state !== "waiting" &&
    value.state !== "blocked" &&
    value.state !== "idle"
  ) {
    issue(issues, "$.state", "has an invalid value");
  }
  if (value.intent !== undefined) {
    validateContent(value.intent, "$.intent", issues);
  }
  if (value.current_action !== undefined) {
    validateCurrentAction(value.current_action, "$.current_action", issues);
  }
  if (!Array.isArray(value.claims)) {
    issue(issues, "$.claims", "must be an array");
  } else {
    value.claims.forEach((claim, index) => {
      validateClaim(claim, `$.claims[${index}]`, issues);
    });
  }
  if (typeof value.unknown_write_scope !== "boolean") {
    issue(issues, "$.unknown_write_scope", "must be a boolean");
  }
  validateSafeInteger(value.revision, "$.revision", issues, 1);
  const updatedAt = timestampMillis(value.updated_at, "$.updated_at", issues);
  const expiresAt = timestampMillis(value.expires_at, "$.expires_at", issues);
  if (
    updatedAt !== undefined &&
    expiresAt !== undefined &&
    expiresAt <= updatedAt
  ) {
    issue(issues, "$.expires_at", "must be later than updated_at");
  }
  if (value.source_refs !== undefined) {
    if (!Array.isArray(value.source_refs)) {
      issue(issues, "$.source_refs", "must be an array");
    } else {
      value.source_refs.forEach((sourceRef, index) => {
        validateSourceRef(sourceRef, `$.source_refs[${index}]`, issues);
      });
    }
  }
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) {
      issue(issues, "$.extensions", "must be an object");
    } else {
      for (const [provider, extension] of Object.entries(value.extensions)) {
        if (!EXTENSION_KEY_PATTERN.test(provider)) {
          issue(issues, `$.extensions.${provider}`, "has an invalid provider key");
        }
        if (!isRecord(extension)) {
          issue(issues, `$.extensions.${provider}`, "must be an object");
        } else {
          validateJsonValue(
            extension,
            `$.extensions.${provider}`,
            issues,
            new Set(),
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new ActiveLeaseValidationError(issues);
  }
}

export function parseActiveLeaseJson(json: string): ActiveLeaseV1 {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new ActiveLeaseValidationError([
      {
        path: "$",
        message: `must be valid JSON (${error instanceof Error ? error.message : "parse error"})`,
      },
    ]);
  }
  validateActiveLease(value);
  return value;
}

export function isActiveLeaseVisible(
  lease: ActiveLeaseV1,
  now: Date | number = Date.now(),
): boolean {
  const nowMilliseconds = now instanceof Date ? now.getTime() : now;
  return (
    Number.isFinite(nowMilliseconds) &&
    lease.state !== "idle" &&
    Date.parse(lease.expires_at) > nowMilliseconds
  );
}
