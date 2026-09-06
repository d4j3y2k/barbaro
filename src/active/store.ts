import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  findBarbaroStoreLocation,
  SafeStoreBoundary,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import { compareUtf16CodeUnits } from "../core/stable-json.js";
import {
  DirectoryLockReleaseError,
  UnsafeDirectoryLockPathError,
  withDirectoryLock,
} from "../output/directory-lock.js";

import {
  ACTIVE_ACTOR_FILENAME_PATTERN,
  activeActorFilename,
} from "./identity.js";
import {
  ACTIVE_LEASE_SCHEMA,
  type ActiveActorKey,
  type ActiveLeaseDecision,
  type ActiveLeaseIdentity,
  type ActiveLeaseListOptions,
  type ActiveLeaseStoreOptions,
  type ActiveLeaseUpdate,
  type ActiveLeaseUpdateOptions,
  type ActiveLeaseUpdateResult,
  type ActiveLeaseV1,
  type ActiveLeaseWriteOptions,
  type ActiveTime,
} from "./types.js";
import {
  isActiveLeaseVisible,
  parseActiveLeaseJson,
  validateActiveActorKey,
  validateActiveLease,
} from "./validation.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
/**
 * How long past expiry an idle tombstone must be before it may be deleted.
 * The tombstone's revision fences out delayed writers, so deletion is safe
 * only outside any possible writer's lifetime: hook processes are killed at
 * 15 seconds, making 24 hours a margin of more than three orders of
 * magnitude rather than a guess.
 */
const REAP_IDLE_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_LEASE_BYTES = 1024 * 1024;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;

/**
 * Per-actor promise queues shared by every store instance in this process.
 * They serialize revision assignment but are deliberately not filesystem
 * locks and make no cross-process ownership claim.
 */
const actorWriteQueues = new Map<string, Promise<void>>();

export class ActiveLeaseRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Active lease revision conflict: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "ActiveLeaseRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function enqueueActorWrite<T>(
  actorPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = actorWriteQueues.get(actorPath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  actorWriteQueues.set(actorPath, tail);

  return result.finally(() => {
    if (actorWriteQueues.get(actorPath) === tail) {
      actorWriteQueues.delete(actorPath);
    }
  });
}

function timeMillis(value: ActiveTime, label: string): number {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} must be a valid date-time`);
  }
  return milliseconds;
}

function positiveTtl(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function expectedRevision(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer");
  }
  return value;
}

function cloneLease(lease: ActiveLeaseV1): ActiveLeaseV1 {
  return JSON.parse(JSON.stringify(lease)) as ActiveLeaseV1;
}

function actorFromLease(lease: ActiveLeaseV1): ActiveActorKey {
  return {
    provider: lease.provider,
    session_id: lease.session_id,
    agent_id: lease.agent_id,
  };
}

function sameActor(left: ActiveActorKey, right: ActiveActorKey): boolean {
  return (
    left.provider === right.provider &&
    left.session_id === right.session_id &&
    left.agent_id === right.agent_id
  );
}

function assertProvider(provider: string): void {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new TypeError(`Invalid provider: ${JSON.stringify(provider)}`);
  }
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(`Invalid session_id: ${JSON.stringify(sessionId)}`);
  }
}

function assertUpdateDoesNotSetGeneratedFields(update: unknown): void {
  if (typeof update !== "object" || update === null || Array.isArray(update)) {
    throw new TypeError("Active lease update must be an object");
  }
  for (const key of ["schema", "revision", "updated_at", "expires_at"]) {
    if (Object.prototype.hasOwnProperty.call(update, key)) {
      throw new TypeError(`Active lease update must not set generated field ${key}`);
    }
  }
}

/**
 * Storage for `.barbaro/active` advisory snapshots.
 *
 * The directory passed to the constructor is the active directory itself,
 * not the project root. For example: `new ActiveLeaseStore(".barbaro/active")`.
 */
export class ActiveLeaseStore {
  readonly directory: string;
  readonly defaultTtlMs: number;
  readonly clock: () => Date;
  readonly #boundary: SafeStoreBoundary;
  readonly #directoryComponents: readonly string[];

  constructor(
    directory: string,
    options: ActiveLeaseStoreOptions = {},
  ) {
    if (directory.length === 0) {
      throw new TypeError("Active lease directory must not be empty");
    }
    this.directory = resolve(directory);
    const barbaroLocation = findBarbaroStoreLocation(this.directory);
    if (barbaroLocation === undefined) {
      this.#boundary = SafeStoreBoundary.forDirectory(this.directory);
      this.#directoryComponents = [];
    } else {
      this.#boundary = barbaroLocation.boundary;
      this.#directoryComponents = barbaroLocation.relativeComponents;
    }
    this.defaultTtlMs = positiveTtl(
      options.defaultTtlMs ?? DEFAULT_TTL_MS,
      "defaultTtlMs",
    );
    this.clock = options.clock ?? (() => new Date());
  }

  actorPath(actor: ActiveActorKey): string {
    validateActiveActorKey(actor);
    return join(
      this.directory,
      actor.provider,
      activeActorFilename(actor),
    );
  }

  /** Returns a validated snapshot, including idle or expired tombstones. */
  async readSnapshot(actor: ActiveActorKey): Promise<ActiveLeaseV1 | undefined> {
    const path = this.actorPath(actor);
    const lease = await this.readPath(path);
    if (lease !== undefined && !sameActor(actor, actorFromLease(lease))) {
      throw new Error(`Active lease at ${path} does not match its actor path`);
    }
    return lease;
  }

  /** Consumer-facing read: idle and expired records are absent. */
  async readActive(
    actor: ActiveActorKey,
    now: ActiveTime = this.clock(),
  ): Promise<ActiveLeaseV1 | undefined> {
    const lease = await this.readSnapshot(actor);
    if (lease === undefined) {
      return undefined;
    }
    return isActiveLeaseVisible(lease, timeMillis(now, "now"))
      ? lease
      : undefined;
  }

  async currentRevision(actor: ActiveActorKey): Promise<number> {
    return (await this.readSnapshot(actor))?.revision ?? 0;
  }

  /**
   * Writes an update with the next revision. Calls targeting the same actor are
   * serialized across all ActiveLeaseStore instances in this process.
   */
  async write(
    update: ActiveLeaseUpdate,
    options: ActiveLeaseWriteOptions = {},
  ): Promise<ActiveLeaseV1> {
    assertUpdateDoesNotSetGeneratedFields(update);
    const ttlMs = positiveTtl(options.ttlMs ?? this.defaultTtlMs, "ttlMs");
    const wantedRevision = expectedRevision(options.expectedRevision);

    // Validate and detach caller-owned objects before waiting in the queue.
    const template = this.buildLease(update, 1, 0, 1);
    validateActiveLease(template);
    const detached = cloneLease(template);
    const actor = actorFromLease(detached);
    const path = this.actorPath(actor);

    return enqueueActorWrite(path, () =>
      withActiveActorLock(path, async () => {
        const current = await this.readPath(path);
        this.assertCurrentIdentity(current, detached);
        const actualRevision = current?.revision ?? 0;
        if (
          wantedRevision !== undefined &&
          wantedRevision !== actualRevision
        ) {
          throw new ActiveLeaseRevisionConflictError(
            wantedRevision,
            actualRevision,
          );
        }
        if (actualRevision >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError("Active lease revision is exhausted");
        }

        const now = timeMillis(options.now ?? this.clock(), "now");
        const expires = now + ttlMs;
        if (!Number.isFinite(expires)) {
          throw new RangeError("Lease expiry is outside the supported date range");
        }
        const lease: ActiveLeaseV1 = {
          ...detached,
          revision: actualRevision + 1,
          updated_at: new Date(now).toISOString(),
          expires_at: new Date(expires).toISOString(),
        };
        validateActiveLease(lease);
        await this.atomicReplace(path, lease);
        return lease;
      }),
    );
  }

  /**
   * Read-modify-write in one critical section. `decide` sees the snapshot the
   * write will actually replace, so a decision made on `previous` — carry the
   * intent forward, refuse a stale turn, skip after an idle tombstone — cannot
   * be invalidated by a concurrent writer between the read and the write.
   *
   * This is the hook-writer path. `expectedRevision` exists for callers whose
   * read happens outside the lock; a decision made in here needs no guard and
   * can never raise a revision conflict.
   */
  async update(
    actor: ActiveActorKey,
    decide: (
      previous: ActiveLeaseV1 | undefined,
    ) => ActiveLeaseDecision | Promise<ActiveLeaseDecision>,
    options: ActiveLeaseUpdateOptions = {},
  ): Promise<ActiveLeaseUpdateResult> {
    const path = this.actorPath(actor);
    const ttlMs = positiveTtl(options.ttlMs ?? this.defaultTtlMs, "ttlMs");
    if (
      options.onWriteFailure !== undefined &&
      typeof options.onWriteFailure !== "function"
    ) {
      throw new TypeError("onWriteFailure must be a function");
    }
    if (
      options.afterCommit !== undefined &&
      typeof options.afterCommit !== "function"
    ) {
      throw new TypeError("afterCommit must be a function");
    }
    if (
      options.onLockReleaseFailure !== undefined &&
      typeof options.onLockReleaseFailure !== "function"
    ) {
      throw new TypeError("onLockReleaseFailure must be a function");
    }

    try {
      return await enqueueActorWrite(path, () =>
        withActiveActorLock(path, async () => {
          const current = await this.readPath(path);
          if (
            current !== undefined &&
            !sameActor(actor, actorFromLease(current))
          ) {
            throw new Error(
              `Active lease at ${path} does not match its actor path`,
            );
          }
          const decision = await decide(
            current === undefined ? undefined : cloneLease(current),
          );
          if ("ignore" in decision) {
            return { ignored: decision.ignore };
          }
          let committed: ActiveLeaseV1;
          try {
            assertUpdateDoesNotSetGeneratedFields(decision.write);
            const template = this.buildLease(decision.write, 1, 0, 1);
            validateActiveLease(template);
            const detached = cloneLease(template);
            if (!sameActor(actor, actorFromLease(detached))) {
              throw new Error(
                "Active lease update must target the locked actor",
              );
            }
            this.assertCurrentIdentity(current, detached);
            const actualRevision = current?.revision ?? 0;
            if (actualRevision >= Number.MAX_SAFE_INTEGER) {
              throw new RangeError("Active lease revision is exhausted");
            }
            const now = timeMillis(options.now ?? this.clock(), "now");
            const expires = now + ttlMs;
            if (!Number.isFinite(expires)) {
              throw new RangeError(
                "Lease expiry is outside the supported date range",
              );
            }
            const lease: ActiveLeaseV1 = {
              ...detached,
              revision: actualRevision + 1,
              updated_at: new Date(now).toISOString(),
              expires_at: new Date(expires).toISOString(),
            };
            validateActiveLease(lease);
            await this.atomicReplace(path, lease);
            committed = lease;
          } catch (error: unknown) {
            if (options.onWriteFailure !== undefined) {
              try {
                await options.onWriteFailure(error);
              } catch (rollbackError: unknown) {
                throw new AggregateError(
                  [error, rollbackError],
                  "Active lease write and failure compensation both failed",
                );
              }
            }
            throw error;
          }
          await options.afterCommit?.(cloneLease(committed));
          return { lease: committed };
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof DirectoryLockReleaseError &&
        error.resourcePath === path &&
        options.onLockReleaseFailure !== undefined
      ) {
        const observer = options.onLockReleaseFailure;
        void Promise.resolve()
          .then(() => observer(error.releaseError))
          .catch(() => undefined);
        return error.result as ActiveLeaseUpdateResult;
      }
      throw error;
    }
  }

  /**
   * Writes a caller-versioned snapshot only when its revision is newer. This
   * is useful for hooks that already carry a source-ordered revision.
   */
  async writeSnapshot(lease: ActiveLeaseV1): Promise<ActiveLeaseV1> {
    validateActiveLease(lease);
    const detached = cloneLease(lease);
    const actor = actorFromLease(detached);
    const path = this.actorPath(actor);

    return enqueueActorWrite(path, () =>
      withActiveActorLock(path, async () => {
        const current = await this.readPath(path);
        this.assertCurrentIdentity(current, detached);
        const actualRevision = current?.revision ?? 0;
        if (detached.revision <= actualRevision) {
          throw new ActiveLeaseRevisionConflictError(
            detached.revision,
            actualRevision,
          );
        }
        await this.atomicReplace(path, detached);
        return detached;
      }),
    );
  }

  /**
   * Publishes the Stop-hook tombstone. Work details and claims are deliberately
   * cleared; consumers ignore it immediately, while its revision remains to
   * reject delayed writes that use expectedRevision or writeSnapshot.
   */
  async writeIdle(
    identity: ActiveLeaseIdentity,
    options: ActiveLeaseWriteOptions = {},
  ): Promise<ActiveLeaseV1> {
    return this.write(idleLeaseUpdate(identity), options);
  }

  /** Returns only unexpired, non-idle leases, in deterministic actor order. */
  async listActive(
    options: ActiveLeaseListOptions = {},
  ): Promise<ActiveLeaseV1[]> {
    const now = timeMillis(options.now ?? this.clock(), "now");
    return this.#list(options, (lease) => isActiveLeaseVisible(lease, now));
  }

  /**
   * Returns every validated snapshot, including idle tombstones and expired
   * leases, in deterministic actor order. Peer-facing consumers want
   * `listActive`; this exists for observers that must see expiry and goodbye
   * transitions rather than have them hidden.
   */
  async listSnapshots(
    options: Omit<ActiveLeaseListOptions, "now"> = {},
  ): Promise<ActiveLeaseV1[]> {
    return this.#list(options, () => true);
  }

  async #list(
    options: Omit<ActiveLeaseListOptions, "now">,
    include: (lease: ActiveLeaseV1) => boolean,
  ): Promise<ActiveLeaseV1[]> {
    if (options.provider !== undefined) {
      assertProvider(options.provider);
    }
    if (options.sessionId !== undefined) {
      assertSessionId(options.sessionId);
    }
    if (options.agentId !== undefined && options.agentId.length === 0) {
      throw new TypeError("agentId must not be empty");
    }

    const providerNames =
      options.provider === undefined
        ? await this.listProviderDirectories()
        : [options.provider];
    const leases: ActiveLeaseV1[] = [];

    for (const provider of providerNames) {
      const providerDirectory = join(this.directory, provider);
      let entries;
      try {
        const verified = await this.#boundary.verifyDirectory([
          ...this.#directoryComponents,
          provider,
        ]);
        if (verified === undefined) {
          continue;
        }
        entries = await readdir(providerDirectory, { withFileTypes: true });
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }

      entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
      for (const entry of entries) {
        if (!entry.isFile() || !ACTIVE_ACTOR_FILENAME_PATTERN.test(entry.name)) {
          continue;
        }
        const path = join(providerDirectory, entry.name);
        try {
          const lease = await this.readPath(path);
          if (lease === undefined) {
            continue;
          }
          const actor = actorFromLease(lease);
          if (
            actor.provider !== provider ||
            activeActorFilename(actor) !== entry.name
          ) {
            throw new Error("lease identity does not match its storage path");
          }
          if (
            (options.sessionId === undefined ||
              lease.session_id === options.sessionId) &&
            (options.agentId === undefined || lease.agent_id === options.agentId) &&
            include(lease)
          ) {
            leases.push(lease);
          }
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) {
            continue;
          }
          options.onInvalid?.(path, error);
        }
      }
    }

    leases.sort((left, right) =>
      compareUtf16CodeUnits(
        [left.provider, left.session_id, left.agent_id].join("\0"),
        [right.provider, right.session_id, right.agent_id].join("\0"),
      ),
    );
    return leases;
  }

  /**
   * Deletes idle tombstones expired for longer than a day, returning how many
   * were removed. Live-state leases are never deleted, no matter how stale:
   * a delayed hook writing over a deleted actor restarts at revision 1 and
   * would advertise dead work as fresh for a full TTL, which is exactly what
   * the tombstone exists to prevent. An idle file outside every possible
   * writer's lifetime protects nothing and only accumulates — one file per
   * background pseudo-agent that will never run again.
   */
  async reapExpiredIdle(now: ActiveTime = this.clock()): Promise<number> {
    const cutoff = timeMillis(now, "now") - REAP_IDLE_AFTER_MS;
    let reaped = 0;
    for (const provider of await this.listProviderDirectories()) {
      const providerDirectory = join(this.directory, provider);
      let entries;
      try {
        const verified = await this.#boundary.verifyDirectory([
          ...this.#directoryComponents,
          provider,
        ]);
        if (verified === undefined) continue;
        entries = await readdir(providerDirectory, { withFileTypes: true });
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !ACTIVE_ACTOR_FILENAME_PATTERN.test(entry.name)) {
          continue;
        }
        const path = join(providerDirectory, entry.name);
        try {
          const candidate = await this.readPath(path);
          if (candidate === undefined || !isReapable(candidate, cutoff)) {
            continue;
          }
          if (activeActorFilename(actorFromLease(candidate)) !== entry.name) {
            continue;
          }
          // Re-read under the actor lock: the decisive check and the unlink
          // are one critical section, so a concurrent revival survives.
          await enqueueActorWrite(path, () =>
            withActiveActorLock(path, async () => {
              const current = await this.readPath(path);
              if (current !== undefined && isReapable(current, cutoff)) {
                await unlink(path);
                reaped += 1;
              }
            }),
          );
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) continue;
          throw error;
        }
      }
    }
    return reaped;
  }

  private buildLease(
    update: ActiveLeaseUpdate,
    revision: number,
    updatedAt: number,
    expiresAt: number,
  ): ActiveLeaseV1 {
    return {
      ...update,
      schema: ACTIVE_LEASE_SCHEMA,
      revision,
      updated_at: new Date(updatedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  private async readPath(path: string): Promise<ActiveLeaseV1 | undefined> {
    const json = await this.#boundary.readUtf8File(
      this.#boundary.componentsForPath(path),
      MAX_ACTIVE_LEASE_BYTES,
    );
    if (json === undefined) return undefined;
    return parseActiveLeaseJson(json);
  }

  private assertCurrentIdentity(
    current: ActiveLeaseV1 | undefined,
    next: ActiveLeaseV1,
  ): void {
    if (current === undefined) {
      return;
    }
    if (!sameActor(actorFromLease(current), actorFromLease(next))) {
      throw new Error("Existing active lease belongs to a different actor");
    }
    if (current.lease_id !== next.lease_id) {
      throw new Error("lease_id changed for an existing actor");
    }
  }

  private async atomicReplace(path: string, lease: ActiveLeaseV1): Promise<void> {
    const pathComponents = this.#boundary.componentsForPath(path);
    await this.#boundary.ensureParentForFile(pathComponents);
    const directory = dirname(path);
    const temporaryPath = join(
      directory,
      `.${activeActorFilename(actorFromLease(lease))}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const verifiedParent = await this.#boundary.verifyDirectory(
        pathComponents.slice(0, -1),
      );
      if (verifiedParent === undefined) {
        throw new UnsafeStorePathError(directory, "lease parent disappeared");
      }
      await rename(temporaryPath, path);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch((unlinkError: unknown) => {
        if (!isErrnoCode(unlinkError, "ENOENT")) {
          throw unlinkError;
        }
      });
      throw error;
    }
  }

  private async listProviderDirectories(): Promise<string[]> {
    let entries;
    try {
      const verified = await this.#boundary.verifyDirectory(
        this.#directoryComponents,
      );
      if (verified === undefined) {
        return [];
      }
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    const providers: string[] = [];
    for (const entry of entries) {
      if (!PROVIDER_PATTERN.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new UnsafeStorePathError(
          join(this.directory, entry.name),
          "provider component is not a real directory",
        );
      }
      providers.push(entry.name);
    }
    return providers.sort();
  }
}

function isReapable(lease: ActiveLeaseV1, cutoffMillis: number): boolean {
  const expires = Date.parse(lease.expires_at);
  return lease.state === "idle" && Number.isFinite(expires) && expires <= cutoffMillis;
}

/** The Stop-hook tombstone body: work details and claims deliberately cleared. */
export function idleLeaseUpdate(
  identity: ActiveLeaseIdentity,
): ActiveLeaseUpdate {
  return {
    lease_id: identity.lease_id,
    provider: identity.provider,
    session_id: identity.session_id,
    agent_id: identity.agent_id,
    state: "idle",
    claims: [],
    unknown_write_scope: false,
    ...(identity.workstream_id === undefined
      ? {}
      : { workstream_id: identity.workstream_id }),
    ...(identity.turn_id === undefined ? {} : { turn_id: identity.turn_id }),
    ...(identity.source_refs === undefined
      ? {}
      : { source_refs: identity.source_refs }),
    ...(identity.extensions === undefined
      ? {}
      : { extensions: identity.extensions }),
  };
}

async function withActiveActorLock<T>(
  actorPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await withDirectoryLock(actorPath, operation);
  } catch (error: unknown) {
    if (error instanceof UnsafeDirectoryLockPathError) {
      throw new UnsafeStorePathError(actorPath, error.message);
    }
    throw error;
  }
}
