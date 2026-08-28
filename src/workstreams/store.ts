import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ActiveLeaseStore } from "../active/store.js";
import { writeJsonFileAtomically } from "../core/atomic-json.js";
import { SafeStoreBoundary } from "../core/safe-store.js";
import { compareUtf16CodeUnits } from "../core/stable-json.js";
import { withDirectoryLock } from "../output/directory-lock.js";

import {
  WORKSTREAM_ID_PATTERN,
  WORKSTREAM_NAME_PATTERN,
  WORKSTREAM_SCHEMA,
  WORKSTREAM_STATUSES,
  isWorkstreamId,
  isWorkstreamName,
  type WorkstreamCreator,
  type WorkstreamStatus,
  type WorkstreamV1,
} from "./types.js";

const MAX_RECORD_BYTES = 16 * 1024;
const MAX_CLAIM_BYTES = 1024;
const RECORD_FILENAME_PATTERN = /^(ws_[0-9a-f]{32})\.json$/u;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/u;

export class WorkstreamNameTakenError extends Error {
  readonly existing: WorkstreamV1;

  constructor(existing: WorkstreamV1) {
    super(
      `workstream "${existing.name}" already exists (${existing.status}); ` +
        `join it, reopen it, or choose another name`,
    );
    this.name = "WorkstreamNameTakenError";
    this.existing = existing;
  }
}

export class WorkstreamNotFoundError extends Error {
  readonly reference: string;

  constructor(reference: string) {
    super(`no workstream named ${JSON.stringify(reference)}`);
    this.name = "WorkstreamNotFoundError";
    this.reference = reference;
  }
}

export class InvalidWorkstreamNameError extends TypeError {
  readonly requested: string;

  constructor(requested: string) {
    super(
      `invalid workstream name ${JSON.stringify(requested)}: use 1-64 ` +
        `lowercase letters, digits, or hyphens, starting and ending with a ` +
        `letter or digit`,
    );
    this.name = "InvalidWorkstreamNameError";
    this.requested = requested;
  }
}

export interface CreateWorkstreamOptions {
  readonly name: string;
  readonly title?: string;
  readonly createdBy: WorkstreamCreator;
  readonly now?: Date;
}

/**
 * Storage for `.barbaro/workstreams/`.
 *
 * Layout:
 *
 * ```text
 * workstreams/<ws_id>.json     barbaro.workstream.v1, atomic temp+rename
 * workstreams/names/<name>     {"workstream_id"} — a uniqueness index only
 * ```
 *
 * The record is authoritative for the name; the claim under `names/` is an
 * index that makes "does this name exist" a single read and makes two
 * concurrent creators of one name serialize on one file. Every writer holds
 * the directory lock for the whole create or status change, so the only way
 * to observe a half-finished operation is a crash mid-sequence. A name
 * resolves only when its claim points at a record whose `name` matches; any
 * other claim is stale, ignored by readers, and overwritten by the next
 * writer under the lock. No age heuristic is needed because the record, not
 * the claim, decides.
 *
 * Lock order, for callers that hold more than one Barbaro lock: the session
 * participation lock is taken BEFORE this store's lock (see
 * `SessionParticipationStore`), never after. Nothing in this store takes a
 * participation lock.
 *
 * Reads never create the store. Writes may create `.barbaro/`: creating a
 * workstream is an explicit user act, like a join.
 */
export class WorkstreamStore {
  readonly projectRoot: string;
  readonly #boundary: SafeStoreBoundary;

  constructor(projectRoot: string) {
    if (projectRoot.length === 0) {
      throw new TypeError("projectRoot must not be empty");
    }
    this.projectRoot = resolve(projectRoot);
    this.#boundary = SafeStoreBoundary.forBarbaroProject(this.projectRoot);
  }

  /** Create a workstream. Throws `WorkstreamNameTakenError` if the name resolves. */
  async create(options: CreateWorkstreamOptions): Promise<WorkstreamV1> {
    const name = options.name;
    if (!isWorkstreamName(name)) {
      throw new InvalidWorkstreamNameError(name);
    }
    validateCreator(options.createdBy);
    const title = normalizeTitle(options.title);
    const now = (options.now ?? new Date()).getTime();
    if (!Number.isFinite(now)) throw new TypeError("now must be a valid date");

    return this.#locked(async () => {
      const existing = await this.#resolveName(name);
      if (existing !== undefined) throw new WorkstreamNameTakenError(existing);
      const workstreamId = `ws_${randomBytes(16).toString("hex")}`;
      const timestamp = new Date(now).toISOString();
      const record: WorkstreamV1 = {
        schema: WORKSTREAM_SCHEMA,
        workstream_id: workstreamId,
        name,
        ...(title === undefined ? {} : { title }),
        status: "open",
        created_at: timestamp,
        created_by: options.createdBy,
        updated_at: timestamp,
        revision: 1,
      };
      // Claim first, then record. A crash in between leaves a claim pointing
      // at nothing, which the resolver treats as stale and the next creator
      // overwrites; the reverse order could leave two records with one name.
      await writeJsonFileAtomically(this.#boundary, claimComponents(name), {
        workstream_id: workstreamId,
      });
      await writeJsonFileAtomically(
        this.#boundary,
        recordComponents(workstreamId),
        record,
      );
      return record;
    });
  }

  /** Read one record by ID. */
  async get(workstreamId: string): Promise<WorkstreamV1 | undefined> {
    if (!isWorkstreamId(workstreamId)) {
      throw new TypeError(`Invalid workstream_id: ${JSON.stringify(workstreamId)}`);
    }
    const text = await this.#boundary.readUtf8File(
      recordComponents(workstreamId),
      MAX_RECORD_BYTES,
    );
    if (text === undefined) return undefined;
    return parseWorkstream(text, workstreamId);
  }

  /**
   * Resolve a human reference: a full `ws_` ID or a name. A name resolves
   * only through a claim whose record still carries that name.
   */
  async resolve(reference: string): Promise<WorkstreamV1 | undefined> {
    if (WORKSTREAM_ID_PATTERN.test(reference)) return this.get(reference);
    if (!WORKSTREAM_NAME_PATTERN.test(reference)) return undefined;
    return this.#resolveName(reference);
  }

  /** Every valid record, sorted by name then ID. Reads never create the store. */
  async list(
    onInvalid?: (path: string, error: unknown) => void,
  ): Promise<WorkstreamV1[]> {
    const directory = await this.#boundary.verifyDirectory(["workstreams"]);
    if (directory === undefined) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    const records: WorkstreamV1[] = [];
    for (const entry of entries) {
      const match = RECORD_FILENAME_PATTERN.exec(entry.name);
      if (match === null || entry.isSymbolicLink() || !entry.isFile()) continue;
      const components = recordComponents(match[1]!);
      try {
        const text = await this.#boundary.readUtf8File(
          components,
          MAX_RECORD_BYTES,
        );
        if (text === undefined) continue;
        records.push(parseWorkstream(text, match[1]!));
      } catch (error) {
        onInvalid?.(this.#boundary.pathFor(components), error);
      }
    }
    records.sort(
      (left, right) =>
        compareUtf16CodeUnits(left.name, right.name) ||
        compareUtf16CodeUnits(left.workstream_id, right.workstream_id),
    );
    return records;
  }

  /** Change status under the lock. Idempotent for an unchanged status. */
  async setStatus(
    reference: string,
    status: WorkstreamStatus,
    now: Date = new Date(),
  ): Promise<WorkstreamV1> {
    if (!WORKSTREAM_STATUSES.includes(status)) {
      throw new TypeError(`Invalid workstream status: ${JSON.stringify(status)}`);
    }
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");
    return this.#locked(async () => {
      const current = await this.resolve(reference);
      if (current === undefined) throw new WorkstreamNotFoundError(reference);
      if (current.status === status) return current;
      const next: WorkstreamV1 = {
        ...current,
        status,
        updated_at: new Date(nowMs).toISOString(),
        revision: current.revision + 1,
      };
      await writeJsonFileAtomically(
        this.#boundary,
        recordComponents(next.workstream_id),
        next,
      );
      return next;
    });
  }

  /**
   * Mark a workstream completed. Completion is a statement, not enforcement:
   * members keep publishing, and the caller is responsible for surfacing the
   * liveness warnings from `collectWorkstreamPresence` before invoking this.
   */
  async complete(reference: string, now: Date = new Date()): Promise<WorkstreamV1> {
    return this.setStatus(reference, "completed", now);
  }

  /** Reopen a completed workstream. Idempotent for an already-open one. */
  async reopen(reference: string, now: Date = new Date()): Promise<WorkstreamV1> {
    return this.setStatus(reference, "open", now);
  }

  async #resolveName(name: string): Promise<WorkstreamV1 | undefined> {
    const claimText = await this.#boundary.readUtf8File(
      claimComponents(name),
      MAX_CLAIM_BYTES,
    );
    if (claimText === undefined) return undefined;
    let workstreamId: string | undefined;
    try {
      const claim = JSON.parse(claimText) as unknown;
      if (isObject(claim) && isWorkstreamId(claim.workstream_id)) {
        workstreamId = claim.workstream_id;
      }
    } catch {
      workstreamId = undefined;
    }
    if (workstreamId === undefined) return undefined;
    let record: WorkstreamV1 | undefined;
    try {
      record = await this.get(workstreamId);
    } catch {
      return undefined;
    }
    // A claim is only evidence. It binds a name to a record exactly as long
    // as that record still says so.
    return record !== undefined && record.name === name ? record : undefined;
  }

  #locked<T>(operation: () => Promise<T>): Promise<T> {
    return withDirectoryLock(this.#boundary.pathFor(["workstreams"]), operation);
  }
}

/** How a current member of a workstream is present in the active store. */
export type WorkstreamMemberPresence = "live" | "present";

export interface WorkstreamPresenceMember {
  readonly provider: string;
  readonly session_id: string;
  readonly presence: WorkstreamMemberPresence;
}

export interface WorkstreamPresenceReport {
  readonly members: readonly WorkstreamPresenceMember[];
  /** Invalid participation or active input; treat liveness as unknown. */
  readonly liveness_unknown: boolean;
}

export interface WorkstreamPresence {
  readonly byWorkstream: ReadonlyMap<string, WorkstreamPresenceReport>;
  /** True when any participation or active record could not be trusted. */
  readonly liveness_unknown: boolean;
}

const MAX_PRESENCE_PARTICIPATION_BYTES = 16 * 1024;

/**
 * One read-only pass over participation and unexpired `main` snapshots,
 * grouped by each session's CURRENT workstream. Expired snapshots, child
 * agents, and moved/former members contribute nothing; an unreadable record
 * flips `liveness_unknown` conservatively instead of feigning absence.
 */
export async function collectWorkstreamPresence(
  projectRoot: string,
  now: Date = new Date(),
): Promise<WorkstreamPresence> {
  const absoluteRoot = resolve(projectRoot);
  const boundary = SafeStoreBoundary.forBarbaroProject(absoluteRoot);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid date");

  let unknown = false;
  const currentByMember = new Map<string, string>();
  const sessionsRoot = await boundary.verifyDirectory(["sessions"]);
  if (sessionsRoot !== undefined) {
    const providers = await readdir(sessionsRoot, { withFileTypes: true });
    providers.sort((left, right) =>
      compareUtf16CodeUnits(left.name, right.name),
    );
    for (const providerEntry of providers) {
      if (!PROVIDER_PATTERN.test(providerEntry.name)) continue;
      if (providerEntry.isSymbolicLink() || !providerEntry.isDirectory()) {
        unknown = true;
        continue;
      }
      const directory = await boundary.verifyDirectory([
        "sessions",
        providerEntry.name,
      ]);
      if (directory === undefined) continue;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) =>
        compareUtf16CodeUnits(left.name, right.name),
      );
      for (const entry of entries) {
        const match = /^(ses_[0-9a-f]{32})\.json$/u.exec(entry.name);
        if (match === null) continue;
        try {
          const text = await boundary.readUtf8File(
            ["sessions", providerEntry.name, entry.name],
            MAX_PRESENCE_PARTICIPATION_BYTES,
          );
          if (text === undefined) continue;
          const current = currentWorkstreamOf(JSON.parse(text));
          if (current !== undefined) {
            currentByMember.set(`${providerEntry.name} ${match[1]!}`, current);
          }
        } catch {
          unknown = true;
        }
      }
    }
  }

  const reports = new Map<
    string,
    { members: WorkstreamPresenceMember[]; liveness_unknown: boolean }
  >();
  const reportFor = (workstreamId: string) => {
    let report = reports.get(workstreamId);
    if (report === undefined) {
      report = { members: [], liveness_unknown: unknown };
      reports.set(workstreamId, report);
    }
    return report;
  };

  let snapshots: Awaited<
    ReturnType<ActiveLeaseStore["listSnapshots"]>
  >;
  try {
    snapshots = await new ActiveLeaseStore(
      join(absoluteRoot, ".barbaro", "active"),
    ).listSnapshots({
      onInvalid: () => {
        unknown = true;
      },
    });
  } catch {
    snapshots = [];
    unknown = true;
  }
  for (const snapshot of snapshots) {
    if (snapshot.agent_id !== "main") continue;
    if (Date.parse(snapshot.expires_at) <= nowMs) continue;
    const workstreamId = currentByMember.get(
      `${snapshot.provider} ${snapshot.session_id}`,
    );
    if (workstreamId === undefined) continue;
    reportFor(workstreamId).members.push({
      provider: snapshot.provider,
      session_id: snapshot.session_id,
      presence: snapshot.state === "idle" ? "present" : "live",
    });
  }

  // Every enrolled workstream gets a report so callers can distinguish a
  // proven-absent membership from one that was never inspected.
  for (const workstreamId of currentByMember.values()) {
    reportFor(workstreamId);
  }
  for (const report of reports.values()) {
    report.liveness_unknown = unknown;
    report.members.sort((left, right) =>
      compareUtf16CodeUnits(
        `${left.provider} ${left.session_id}`,
        `${right.provider} ${right.session_id}`,
      ),
    );
  }
  return { byWorkstream: reports, liveness_unknown: unknown };
}

function currentWorkstreamOf(value: unknown): string | undefined {
  if (!isObject(value)) throw new TypeError("participation must be an object");
  if (value.schema === "barbaro.session-participation.v1") return undefined;
  if (value.schema !== "barbaro.session-participation.v2") {
    throw new TypeError("unsupported participation schema");
  }
  if (
    typeof value.workstream_id !== "string" ||
    !WORKSTREAM_ID_PATTERN.test(value.workstream_id)
  ) {
    throw new TypeError("participation is structurally invalid");
  }
  return value.workstream_id;
}

function recordComponents(workstreamId: string): readonly string[] {
  return ["workstreams", `${workstreamId}.json`];
}

function claimComponents(name: string): readonly string[] {
  return ["workstreams", "names", name];
}

function normalizeTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const trimmed = title.trim();
  if (trimmed.length === 0) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > 512) {
    throw new TypeError("workstream title must be at most 512 UTF-8 bytes");
  }
  return trimmed;
}

function validateCreator(creator: WorkstreamCreator): void {
  if ("kind" in creator) {
    if (creator.kind !== "cli") {
      throw new TypeError("workstream creator kind must be 'cli'");
    }
    return;
  }
  if (!PROVIDER_PATTERN.test(creator.provider)) {
    throw new TypeError(`Invalid creator provider: ${JSON.stringify(creator.provider)}`);
  }
  if (!SESSION_ID_PATTERN.test(creator.session_id)) {
    throw new TypeError(`Invalid creator session_id: ${JSON.stringify(creator.session_id)}`);
  }
}

export function parseWorkstream(
  text: string,
  expectedId?: string,
): WorkstreamV1 {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) {
    throw new TypeError("Workstream record must be a JSON object");
  }
  if (value.schema !== WORKSTREAM_SCHEMA) {
    throw new TypeError("Unsupported workstream schema");
  }
  if (
    !isWorkstreamId(value.workstream_id) ||
    (expectedId !== undefined && value.workstream_id !== expectedId) ||
    !isWorkstreamName(value.name) ||
    (value.title !== undefined && typeof value.title !== "string") ||
    !WORKSTREAM_STATUSES.includes(value.status as WorkstreamStatus) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !isCreator(value.created_by)
  ) {
    throw new TypeError("Workstream record is structurally invalid");
  }
  return value as unknown as WorkstreamV1;
}

function isCreator(value: unknown): value is WorkstreamCreator {
  if (!isObject(value)) return false;
  if (value.kind === "cli") return Object.keys(value).length === 1;
  return (
    typeof value.provider === "string" &&
    PROVIDER_PATTERN.test(value.provider) &&
    typeof value.session_id === "string" &&
    SESSION_ID_PATTERN.test(value.session_id)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
