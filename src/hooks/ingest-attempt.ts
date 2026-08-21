import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { SafeStoreBoundary } from "../core/safe-store.js";
import { stableStringify } from "../core/stable-json.js";
import { withDirectoryLock } from "../output/directory-lock.js";

import { recordIncident } from "./incidents.js";

export const INGEST_ATTEMPT_SCHEMA = "barbaro.ingest-attempt.v1";
const MAX_ATTEMPT_BYTES = 16 * 1024;

/**
 * Write-ahead marker for one ingest attempt.
 *
 * A hook process cannot log its own death: a timeout kill leaves no catch
 * block to run, so the failure modes that matter most are exactly the ones
 * the incident store never sees. It can, however, log its birth. `begin`
 * records the attempt before the work starts, and the returned `finish`
 * replaces the marker with the outcome. A marker whose `finished_at` never
 * arrived is the corpse a later reader can detect.
 *
 * One file per session, overwritten per attempt — bounded like the incident
 * store. Written only after admission, so it only ever names a session that
 * consented to publish. Attempts overlap in practice (a Stop poll and the
 * next prompt's ingest), so ownership is compared under the marker's lock:
 * `finish` writes only while its own attempt is still the one on file, and
 * `begin` performs the autopsy — an unfinished marker whose process is gone
 * becomes an incident before the file is reused.
 */
export interface BarbaroIngestAttemptV1 {
  readonly schema: typeof INGEST_ATTEMPT_SCHEMA;
  readonly provider: string;
  readonly session_id: string;
  readonly event: string;
  readonly attempt_id: string;
  readonly pid: number;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly outcome?: "ok" | "error";
}

export type FinishIngestAttempt = (outcome: "ok" | "error") => Promise<void>;

export async function beginIngestAttempt(options: {
  readonly projectRoot: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly event: string;
}): Promise<FinishIngestAttempt> {
  const base = {
    schema: INGEST_ATTEMPT_SCHEMA,
    provider: options.provider,
    session_id: options.sessionId,
    event: options.event,
    attempt_id: randomBytes(8).toString("hex"),
    pid: process.pid,
    started_at: new Date().toISOString(),
  } as const;
  await withAttemptMarker(options.projectRoot, base, async (target, current) => {
    if (
      current !== undefined &&
      current.finished_at === undefined &&
      current.pid !== process.pid &&
      !isPidAlive(current.pid)
    ) {
      // The previous attempt's process is gone and it never wrote an outcome:
      // that is the death this journal exists to expose. Record it before the
      // marker is reused, or the reuse itself destroys the evidence.
      await recordIncident({
        projectRoot: options.projectRoot,
        provider: current.provider,
        kind: "hook_error",
        event: current.event,
        dedupKey: current.session_id,
        detail: `ingest attempt died without an outcome (started_at ${current.started_at}, pid ${current.pid})`,
      });
    }
    await replaceAttempt(target, base);
  });
  return (outcome) =>
    withAttemptMarker(options.projectRoot, base, async (target, current) => {
      // Only the attempt that owns the marker may conclude it. A newer
      // attempt has already taken the file over; clobbering it would hide
      // exactly the unfinished run the journal is meant to expose.
      if (current === undefined || current.attempt_id !== base.attempt_id) {
        return;
      }
      await replaceAttempt(target, {
        ...base,
        finished_at: new Date().toISOString(),
        outcome,
      });
    });
}

async function withAttemptMarker(
  projectRoot: string,
  record: Pick<BarbaroIngestAttemptV1, "provider" | "session_id">,
  operation: (
    target: string,
    current: BarbaroIngestAttemptV1 | undefined,
  ) => Promise<void>,
): Promise<void> {
  try {
    if (projectRoot.length === 0) return;
    // Never CREATE the store — same rule as the incident markers.
    if (!(await storeExists(projectRoot))) return;
    const boundary = SafeStoreBoundary.forBarbaroProject(projectRoot);
    const components = [
      "logs",
      "ingest",
      record.provider,
      `${record.session_id}.json`,
    ];
    const target = await boundary.ensureParentForFile(components);
    await withDirectoryLock(target, async () => {
      await operation(target, await readAttempt(boundary, components));
    });
  } catch {
    // The journal must never be the thing that fails the ingest it observes.
  }
}

async function readAttempt(
  boundary: SafeStoreBoundary,
  components: readonly string[],
): Promise<BarbaroIngestAttemptV1 | undefined> {
  // Bounded, regular-file-only read: a symlink planted at the marker path
  // must not let the journal read (or later overwrite) anything outside it.
  let json: string | undefined;
  try {
    json = await boundary.readUtf8File(components, MAX_ATTEMPT_BYTES);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  try {
    const value = JSON.parse(json) as BarbaroIngestAttemptV1;
    return value !== null &&
      typeof value === "object" &&
      value.schema === INGEST_ATTEMPT_SCHEMA &&
      typeof value.attempt_id === "string" &&
      typeof value.pid === "number" &&
      typeof value.started_at === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function replaceAttempt(
  target: string,
  record: BarbaroIngestAttemptV1,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now().toString(16)}.tmp`;
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
    await handle.writeFile(`${stableStringify(record)}\n`, "utf8");
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

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; the hooks
    // all run as this user, so treat it as alive out of caution.
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
