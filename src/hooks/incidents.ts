import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";

import { join } from "node:path";

import { excerptContent } from "../core/content.js";
import { SafeStoreBoundary } from "../core/safe-store.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";
import type { BarbaroContent } from "../contracts/v1.js";

export const INCIDENT_SCHEMA = "barbaro.incident.v1";
export const INCIDENT_DETAIL_MAX_BYTES = 1024;

/**
 * `session_dormant`: a hook fired for a session that never joined, so nothing
 * was published. `hook_error`: a hook threw and the failure was swallowed to
 * avoid failing the coding turn.
 */
export type IncidentKind = "hook_error" | "session_dormant";

export const INCIDENT_KINDS: readonly IncidentKind[] = [
  "hook_error",
  "session_dormant",
];

export interface BarbaroIncidentV1 {
  readonly schema: typeof INCIDENT_SCHEMA;
  readonly provider: string;
  readonly kind: IncidentKind;
  readonly event?: string;
  readonly detail?: BarbaroContent;
  readonly occurred_at: string;
}

/**
 * Hooks fail open, which is correct — an advisory lease is never worth failing
 * a turn — but a swallowed error leaves no trace at all. Two multi-hour
 * outages were invisible for exactly that reason: every hook returned
 * `ignored: "session has not joined Barbaro"`, and later every ingest threw a
 * conflict, and nothing surfaced either one.
 *
 * A marker is deliberately NOT a log. It is written once per distinct
 * condition and never appended to, so a hook firing on every tool call cannot
 * grow the store without bound.
 *
 * A dormant session has not consented, so its identity is never written: the
 * native session id only salts the dedup key, and the record itself says a
 * dormant session exists without naming which. That is the whole actionable
 * signal — the operator knows to join — and it publishes nothing about a
 * session that refused to publish.
 */
export async function recordIncident(options: {
  readonly projectRoot: string;
  readonly provider: string;
  readonly kind: IncidentKind;
  readonly event?: string;
  /** Salts the dedup key only. Never stored. */
  readonly dedupKey?: string;
  readonly detail?: string;
  readonly now?: Date;
}): Promise<void> {
  try {
    if (options.projectRoot.length === 0) return;
    // Never CREATE the store. A project that has not opted in must not sprout
    // a `.barbaro/` directory just because a hook fired there: the directory
    // is required to be gitignored before enabling, and hooks configured at
    // user level fire in projects that never made that choice. A marker is
    // only useful where Barbaro is already in use, which is exactly where the
    // directory already exists.
    if (!(await storeExists(options.projectRoot))) return;
    const boundary = SafeStoreBoundary.forBarbaroProject(options.projectRoot);
    const occurredAt = (options.now ?? new Date()).toISOString();
    const detail =
      options.detail === undefined
        ? undefined
        : excerptContent(options.detail, INCIDENT_DETAIL_MAX_BYTES);

    // Same condition, same file: repeats collapse instead of accumulating.
    const digest = createHash("sha256")
      .update(
        [
          options.kind,
          options.provider,
          options.event ?? "",
          options.dedupKey ?? "",
          detail?.text ?? "",
        ].join("\u0000"),
      )
      .digest("hex")
      .slice(0, 32);

    const incident: BarbaroIncidentV1 = {
      schema: INCIDENT_SCHEMA,
      provider: options.provider,
      kind: options.kind,
      ...(options.event === undefined ? {} : { event: options.event }),
      ...(detail === undefined ? {} : { detail }),
      occurred_at: occurredAt,
    };

    // Alongside the existing `logs/hooks.jsonl` rather than a second, rival
    // notion of "something went wrong".
    const components = [
      "logs",
      "incidents",
      options.provider,
      `${digest}.json`,
    ];
    const target = await boundary.ensureParentForFile(components);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${stableStringify(incident)}\n`, "utf8");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  } catch {
    // A marker that cannot be written must never be the thing that fails a
    // turn. Already-exists is the common case and is not an error worth
    // distinguishing here.
  }
}

const INCIDENT_FILENAME_PATTERN = /^([0-9a-f]{32})\.json$/;
const INCIDENT_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MAX_INCIDENT_BYTES = 16 * 1024;

export interface BarbaroIncidentRecord {
  /** The marker's dedup digest — a stable "already reported" key. */
  readonly incident_id: string;
  readonly incident: BarbaroIncidentV1;
}

/**
 * Every recorded incident marker, in deterministic provider-then-digest
 * order. Markers are write-once, so a caller diffing successive listings by
 * `incident_id` sees each distinct condition exactly once.
 */
export async function listIncidents(
  projectRoot: string,
  onInvalid?: (path: string, error: unknown) => void,
): Promise<BarbaroIncidentRecord[]> {
  if (projectRoot.length === 0) {
    throw new TypeError("projectRoot must not be empty");
  }
  if (!(await storeExists(projectRoot))) return [];
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  const root = await boundary.verifyDirectory(["logs", "incidents"]);
  if (root === undefined) return [];

  const providers = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.isDirectory() &&
        INCIDENT_PROVIDER_PATTERN.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

  const records: BarbaroIncidentRecord[] = [];
  for (const provider of providers) {
    const directory = await boundary.verifyDirectory([
      "logs",
      "incidents",
      provider,
    ]);
    if (directory === undefined) continue;
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareUtf16CodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      const match = INCIDENT_FILENAME_PATTERN.exec(entry.name);
      if (match === null || entry.isSymbolicLink() || !entry.isFile()) {
        continue;
      }
      const components = ["logs", "incidents", provider, entry.name];
      try {
        const text = await boundary.readUtf8File(
          components,
          MAX_INCIDENT_BYTES,
        );
        if (text === undefined) continue;
        records.push({
          incident_id: match[1]!,
          incident: parseIncident(text, provider),
        });
      } catch (error) {
        onInvalid?.(boundary.pathFor(components), error);
      }
    }
  }
  return records;
}

function parseIncident(
  text: string,
  expectedProvider: string,
): BarbaroIncidentV1 {
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Incident marker must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== INCIDENT_SCHEMA ||
    record.provider !== expectedProvider ||
    !INCIDENT_KINDS.includes(record.kind as IncidentKind) ||
    typeof record.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(record.occurred_at)) ||
    (record.event !== undefined && typeof record.event !== "string")
  ) {
    throw new TypeError("Incident marker is structurally invalid");
  }
  return value as BarbaroIncidentV1;
}

async function storeExists(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(join(projectRoot, ".barbaro"))).isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort project root from a raw hook payload, for the failure path. */
export function projectRootFromHookInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const cwd = (input as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/** Best-effort native session id from a raw hook payload, for dedup only. */
export function sessionKeyFromHookInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const id = (input as Record<string, unknown>).session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
