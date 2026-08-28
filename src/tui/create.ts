import { utf8Bytes } from "../reader/budget.js";

export const WORKSTREAM_NAME_GRAMMAR =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const MAX_TITLE_BYTES = 512;

/**
 * §5's create flow: local validation, one asynchronous public writer, and a
 * reconciliation state machine that never claims more than it proved. The
 * The TUI writes nothing itself; creation runs the public
 * `barbaro workstream new` command and reconciles its durable result.
 */

export interface CreateFormState {
  readonly kind: "form";
  readonly name: string;
  readonly title: string;
  readonly focus: "name" | "title";
}

export interface CreatePendingState {
  readonly kind: "pending";
  readonly name: string;
  readonly title: string;
  readonly cancelRequested: boolean;
}

export interface CreatedRecord {
  readonly workstream_id: string;
  readonly name: string;
  readonly title?: string;
  readonly status: "open" | "completed";
}

export interface CreateSuccessState {
  readonly kind: "created";
  readonly record: CreatedRecord;
  /** "Record present; origin unknown" keeps its qualifier. */
  readonly originKnown: boolean;
}

export interface CreateFailureState {
  readonly kind: "failed";
  readonly message: string;
}

export interface CreateCancelledState {
  readonly kind: "cancelled";
}

export interface CreateUnknownState {
  readonly kind: "unknown";
}

export type CreateState =
  | CreateFormState
  | CreatePendingState
  | CreateSuccessState
  | CreateFailureState
  | CreateCancelledState
  | CreateUnknownState;

export interface CreateValidation {
  readonly ok: boolean;
  readonly status: string;
}

/** Local validation; an invalid form never invokes the writer. */
export function validateCreateForm(
  name: string,
  title: string,
): CreateValidation {
  if (name.length === 0) {
    return { ok: false, status: "Name is required" };
  }
  if (!WORKSTREAM_NAME_GRAMMAR.test(name)) {
    return { ok: false, status: "Name is not a valid slug yet" };
  }
  const trimmed = title.trim();
  if (utf8Bytes(trimmed) > MAX_TITLE_BYTES) {
    return { ok: false, status: "Title is longer than 512 bytes" };
  }
  if (trimmed.startsWith("--")) {
    return {
      ok: false,
      status: "A title starting with -- cannot be passed safely",
    };
  }
  return { ok: true, status: "Ready to create" };
}

/** The exact writer argv; arguments are fields, never a shell string. */
export function writerArgv(
  name: string,
  title: string,
  projectRoot: string,
): string[] {
  const trimmed = title.trim();
  return [
    "workstream",
    "new",
    name,
    ...(trimmed.length === 0 ? [] : ["--title", trimmed]),
    "--project-root",
    projectRoot,
  ];
}

export interface WriterOutcome {
  readonly code: number | null;
  readonly stdout: string;
  /** Bounded diagnostic text from the public CLI; never parsed as a contract. */
  readonly stderr?: string;
  readonly cancelled: boolean;
}

export interface CreateReconcileInput {
  readonly expectedName: string;
  readonly outcome: WriterOutcome;
  /**
   * The reconciliation read: the record with the expected name if the
   * bounded catalogue holds one, "absent" for a complete proven absence,
   * and "unknown" for an incomplete or refused read.
   */
  readonly lookup: CreatedRecord | "absent" | "unknown";
}

/**
 * The §5 state machine, after the writer settles:
 * exit 0 with one valid returned record is Success; everything else
 * reconciles against the catalogue and keeps every proof gap unknown.
 */
export function settleCreate(input: CreateReconcileInput): CreateState {
  const record =
    input.outcome.code === 0
      ? parseWriterRecord(input.outcome.stdout, input.expectedName)
      : undefined;
  if (record !== undefined) {
    return { kind: "created", record, originKnown: true };
  }
  if (input.lookup === "unknown") return { kind: "unknown" };
  if (input.lookup !== "absent") {
    return { kind: "created", record: input.lookup, originKnown: false };
  }
  if (input.outcome.cancelled) return { kind: "cancelled" };
  if (input.outcome.code !== null && input.outcome.code !== 0) {
    return { kind: "failed", message: `The writer exited ${input.outcome.code}` };
  }
  return { kind: "unknown" };
}

function parseWriterRecord(
  stdout: string,
  expectedName: string,
): CreatedRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["workstream_id"] !== "string" ||
    !/^ws_[0-9a-f]{32}$/u.test(record["workstream_id"]) ||
    record["name"] !== expectedName ||
    (record["status"] !== "open" && record["status"] !== "completed") ||
    (record["title"] !== undefined && typeof record["title"] !== "string")
  ) {
    return undefined;
  }
  return {
    workstream_id: record["workstream_id"],
    name: expectedName,
    ...(record["title"] === undefined ? {} : { title: record["title"] as string }),
    status: record["status"],
  };
}

/** Sanitize typed or pasted editor input into single-line field text. */
export function fieldText(input: string): string {
  let out = "";
  for (const character of input) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += character;
  }
  return out;
}
