import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSessionId } from "../core/id.js";
import { SafeStoreBoundary } from "../core/safe-store.js";
import { writeJsonFileAtomically } from "../core/atomic-json.js";
import { withDirectoryLock } from "../output/directory-lock.js";
import { readDiagnosticBytes } from "../setup/diagnostic-files.js";
import type { HookReadOptions } from "../nudge/read-invocation.js";

export const READ_OBSERVATION_SCHEMA = "barbaro.read-observation.v1";
export const MAX_READ_OBSERVATIONS = 16;
const MAX_BYTES = 16384;
const STATES = ["reserved", "staged", "committed", "refused"] as const;
export type CodexReadProducer = "0.153.2" | "0.153.3";
export function isCodexReadProducer(value: unknown): value is CodexReadProducer {
  return value === "0.153.2" || value === "0.153.3";
}
export interface NativeTraceLimit {
  readonly kind: "file" | "record";
  /** Observed record bytes are a lower bound when the rest of the line was not read. */
  readonly observed_bytes: number;
  readonly maximum_bytes: number;
}
export interface ReadObservation {
  readonly invocation_sha256: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly state: typeof STATES[number];
  readonly reason: "reserved" | "candidate_staged" | "model_delivery_verified" | "unsupported_producer_or_shape" | "output_not_eligible" | "commit_not_verified" | "command_failed" | "reservation_refused" | "native_trace_limit";
  readonly native_trace_limit?: NativeTraceLimit;
  readonly adapter: `codex-${CodexReadProducer}-literal-exec` | "claude-2.1.261-foreground-batch";
  /** The Claude hook envelope has no version field; shape evidence is not version evidence. */
  readonly producer_version?: CodexReadProducer;
  readonly runtime_cli_sha256?: string;
  readonly runtime_build_sha256?: string;
}
export interface ReadObservationJournal {
  readonly schema: typeof READ_OBSERVATION_SCHEMA;
  readonly provider: "codex" | "claude";
  readonly session_id: string;
  readonly omitted: number;
  readonly observations: readonly ReadObservation[];
}
export type ReadObservationResult =
  | { readonly state: "ok"; readonly journal: ReadObservationJournal }
  | { readonly state: "missing" | "invalid" | "refused" };
const reasons: readonly string[] = ["reserved", "candidate_staged", "model_delivery_verified", "unsupported_producer_or_shape", "output_not_eligible", "commit_not_verified", "command_failed", "reservation_refused", "native_trace_limit"];
const reasonState = (reason: unknown) => reason === "reserved" ? "reserved" : reason === "candidate_staged" ? "staged" : reason === "model_delivery_verified" ? "committed" : "refused";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validNativeTraceLimit(value: unknown): value is NativeTraceLimit {
  return object(value) && Object.keys(value).every((key) => ["kind", "observed_bytes", "maximum_bytes"].includes(key)) &&
    ["file", "record"].includes(String(value.kind)) && Number.isSafeInteger(value.maximum_bytes) &&
    Number(value.maximum_bytes) > 0 && Number.isSafeInteger(value.observed_bytes) && Number(value.observed_bytes) > Number(value.maximum_bytes);
}
function components(provider: string, sessionId: string): string[] {
  if (!["codex", "claude"].includes(provider) || !/^ses_[0-9a-f]{32}$/u.test(sessionId)) throw new TypeError("Invalid read observation identity");
  return ["logs", "delivery", provider, `${sessionId}.json`];
}

/** Supported, bounded, read-only health interface. Never includes commands or delivered text. */
export async function readReadObservations(projectRoot: string, provider: "codex" | "claude", sessionId: string): Promise<ReadObservationResult> {
  const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
  let text: string | undefined;
  try { text = await boundary.readUtf8File(components(provider, sessionId), MAX_BYTES); }
  catch { return { state: "refused" }; }
  if (text === undefined) return { state: "missing" };
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value) || Object.keys(value).some((key) => !["schema", "provider", "session_id", "omitted", "observations"].includes(key)) ||
        value.schema !== READ_OBSERVATION_SCHEMA || value.provider !== provider || value.session_id !== sessionId ||
        !Number.isSafeInteger(value.omitted) || Number(value.omitted) < 0 || !Array.isArray(value.observations) || value.observations.length > MAX_READ_OBSERVATIONS) return { state: "invalid" };
    const seen = new Set<string>();
    for (const row of value.observations) {
      if (!object(row) || Object.keys(row).some((key) => !["invocation_sha256", "created_at", "updated_at", "state", "reason", "adapter", "producer_version", "runtime_cli_sha256", "runtime_build_sha256", "native_trace_limit"].includes(key)) ||
          !sha(row.invocation_sha256) || seen.has(String(row.invocation_sha256)) || !date(row.created_at) || !date(row.updated_at) ||
          String(row.created_at) > String(row.updated_at) || !STATES.includes(row.state as ReadObservation["state"]) || !reasons.includes(String(row.reason)) ||
          row.state !== reasonState(row.reason) || (provider === "codex" && row.state === "committed" && !isCodexReadProducer(row.producer_version)) ||
          ((row.reason === "native_trace_limit") !== (row.native_trace_limit !== undefined)) ||
          (row.native_trace_limit !== undefined && (provider !== "codex" || !validNativeTraceLimit(row.native_trace_limit))) ||
          row.adapter !== (provider === "codex" ? `codex-${row.producer_version ?? "0.153.2"}-literal-exec` : "claude-2.1.261-foreground-batch") ||
          (row.producer_version !== undefined && (provider !== "codex" || !isCodexReadProducer(row.producer_version))) ||
          (row.runtime_cli_sha256 !== undefined && !sha(row.runtime_cli_sha256)) ||
          (row.runtime_build_sha256 !== undefined && !sha(row.runtime_build_sha256))) return { state: "invalid" };
      seen.add(String(row.invocation_sha256));
    }
    return { state: "ok", journal: value as unknown as ReadObservationJournal };
  } catch { return { state: "invalid" }; }
}

/** Hook-owned advisory evidence only. Failure cannot change the delivery decision or cursor. */
export async function observeHookRead(options: HookReadOptions, state: ReadObservation["state"], reason: ReadObservation["reason"], pinnedProducer?: CodexReadProducer, nativeLimit?: NativeTraceLimit): Promise<void> {
  if (typeof options.toolUseId !== "string" || !["codex", "claude"].includes(options.provider)) return;
  if ((reason === "native_trace_limit") !== (nativeLimit !== undefined) ||
      (nativeLimit !== undefined && (options.provider !== "codex" || state !== "refused" || !validNativeTraceLimit(nativeLimit)))) return;
  try {
    const provider = options.provider as "codex" | "claude";
    const sessionId = createSessionId(provider, options.nativeSessionId);
    const boundary = SafeStoreBoundary.forBarbaroProject(options.projectRoot);
    const path = components(provider, sessionId);
    await boundary.ensureParentForFile(path);
    const cli = await readDiagnosticBytes(fileURLToPath(new URL("../cli.js", import.meta.url)), 8 * 1024 * 1024);
    const build = await readDiagnosticBytes(fileURLToPath(new URL("../build-identity.json", import.meta.url)), 256 * 1024);
    await withDirectoryLock(boundary.pathFor(path), async () => {
      const read = await readReadObservations(options.projectRoot, provider, sessionId);
      if (read.state !== "ok" && read.state !== "missing") return;
      const current = read.state === "ok" ? read.journal : undefined;
      const id = hash(JSON.stringify([options.toolUseId, options.turn]));
      const old = current?.observations.find((row) => row.invocation_sha256 === id);
      // Replayed terminal hooks must never rewrite a successful observation as failure.
      if (old?.state === "committed") return;
      const now = (options.now ?? new Date()).toISOString();
      if (old !== undefined && now < old.updated_at) return;
      const producer = provider === "codex" ? pinnedProducer ?? old?.producer_version : undefined;
      if (provider === "codex" && state === "committed" && producer === undefined) return;
      const row: ReadObservation = {
        invocation_sha256: id, created_at: old?.created_at ?? now, updated_at: now, state, reason,
        adapter: provider === "codex" ? `codex-${producer ?? "0.153.2"}-literal-exec` : "claude-2.1.261-foreground-batch",
        ...(producer === undefined ? {} : { producer_version: producer }),
        ...(nativeLimit === undefined ? {} : { native_trace_limit: nativeLimit }),
        ...(cli.state === "ok" ? { runtime_cli_sha256: cli.identity.sha256 } : {}),
        ...(build.state === "ok" ? { runtime_build_sha256: build.identity.sha256 } : {}),
      };
      const rows = [...(current?.observations ?? []).filter((entry) => entry.invocation_sha256 !== id), row]
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.invocation_sha256.localeCompare(b.invocation_sha256));
      const omitted = (current?.omitted ?? 0) + Math.max(0, rows.length - MAX_READ_OBSERVATIONS);
      if (!Number.isSafeInteger(omitted)) return;
      await writeJsonFileAtomically(boundary, path, { schema: READ_OBSERVATION_SCHEMA, provider, session_id: sessionId, omitted, observations: rows.slice(-MAX_READ_OBSERVATIONS) });
    }, { waitTimeoutMs: 100, pollIntervalMs: 10 });
  } catch { /* Diagnostics are best effort and never authorize delivery. */ }
}
