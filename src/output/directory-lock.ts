import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  safeStoreFileLocation,
  StoreFileTooLargeError,
  UnsafeStorePathError,
  type BarbaroStoreLocation,
  type SafeStoreBoundary,
} from "../core/safe-store.js";
import { stableStringify } from "../core/stable-json.js";

const LOCK_SCHEMA = "barbaro.directory-lock.v1";
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_STALE_AFTER_MS = 60_000;
const MAX_LOCK_OWNER_BYTES = 16 * 1024;

export interface DirectoryLockOptions {
  /** Maximum time to wait for a live holder before failing. */
  readonly waitTimeoutMs?: number;
  /** Delay between acquisition attempts. */
  readonly pollIntervalMs?: number;
  /** Age after which an ownerless or foreign-host lock may be recovered. */
  readonly staleAfterMs?: number;
}

interface DirectoryLockOwner {
  readonly schema: typeof LOCK_SCHEMA;
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly acquired_at: string;
}

interface DirectoryLock {
  readonly boundary: SafeStoreBoundary;
  readonly directory: string;
  readonly directoryComponents: readonly string[];
  readonly ownerPath: string;
  readonly ownerComponents: readonly string[];
  readonly owner: DirectoryLockOwner;
}

interface ResolvedDirectoryLockOptions {
  readonly waitTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly staleAfterMs: number;
}

export class UnsafeDirectoryLockPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDirectoryLockPathError";
  }
}

export class DirectoryLockTimeoutError extends Error {
  readonly resourcePath: string;

  constructor(resourcePath: string) {
    super(`Timed out waiting for filesystem lock: ${resourcePath}`);
    this.name = "DirectoryLockTimeoutError";
    this.resourcePath = resourcePath;
  }
}

/**
 * Serialize an asynchronous transaction across processes that share a
 * filesystem. The lock is the atomic directory `${resourcePath}.lock`.
 * Same-host locks whose owning process is gone are recovered immediately;
 * ownerless and foreign-host locks are recovered after `staleAfterMs`.
 */
export async function withDirectoryLock<T>(
  resourcePath: string,
  operation: () => Promise<T>,
  options: DirectoryLockOptions = {},
): Promise<T> {
  if (resourcePath.length === 0) {
    throw new TypeError("Directory-lock resource path must not be empty");
  }
  const resolvedOptions = resolveOptions(options);
  const location = safeStoreFileLocation(resourcePath);
  let lock: DirectoryLock;
  try {
    await location.boundary.ensureDirectory(
      location.relativeComponents.slice(0, -1),
    );
    lock = await acquireDirectoryLock(
      resourcePath,
      location,
      resolvedOptions,
    );
  } catch (error: unknown) {
    throw normalizeLockPathError(error);
  }
  let operationError: unknown;
  try {
    return await operation();
  } catch (error: unknown) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseDirectoryLock(lock);
    } catch (releaseError: unknown) {
      if (operationError === undefined) {
        throw normalizeLockPathError(releaseError);
      }
    }
  }
}

function resolveOptions(
  options: DirectoryLockOptions,
): ResolvedDirectoryLockOptions {
  return {
    waitTimeoutMs: nonNegativeInteger(
      options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      "waitTimeoutMs",
    ),
    pollIntervalMs: positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    ),
    staleAfterMs: positiveInteger(
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      "staleAfterMs",
    ),
  };
}

async function acquireDirectoryLock(
  resourcePath: string,
  location: BarbaroStoreLocation,
  options: ResolvedDirectoryLockOptions,
): Promise<DirectoryLock> {
  const resourceComponents = [...location.relativeComponents];
  const resourceName = resourceComponents.at(-1);
  if (resourceName === undefined) {
    throw new TypeError("Directory-lock resource path must name a file");
  }
  const directoryComponents = [
    ...resourceComponents.slice(0, -1),
    `${resourceName}.lock`,
  ];
  const ownerComponents = [...directoryComponents, "owner.json"];
  const directory = location.boundary.pathFor(directoryComponents);
  const ownerPath = location.boundary.pathFor(ownerComponents);
  const started = Date.now();

  while (true) {
    await location.boundary.ensureDirectory(
      resourceComponents.slice(0, -1),
    );
    try {
      await mkdir(directory, { mode: 0o700 });
      const verified = await location.boundary.verifyDirectory(
        directoryComponents,
      );
      if (verified === undefined) {
        throw new UnsafeDirectoryLockPathError(
          `Filesystem lock disappeared after creation: ${directory}`,
        );
      }
      const owner: DirectoryLockOwner = {
        schema: LOCK_SCHEMA,
        pid: process.pid,
        hostname: hostname(),
        token: randomBytes(16).toString("hex"),
        acquired_at: new Date().toISOString(),
      };
      try {
        await writeLockOwner(ownerPath, owner);
      } catch (error: unknown) {
        await unlink(ownerPath).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
        throw error;
      }
      return {
        boundary: location.boundary,
        directory,
        directoryComponents,
        ownerPath,
        ownerComponents,
        owner,
      };
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
    }

    if (
      await recoverStaleDirectoryLock(
        location.boundary,
        directory,
        directoryComponents,
        ownerPath,
        ownerComponents,
        options.staleAfterMs,
      )
    ) {
      continue;
    }
    if (Date.now() - started >= options.waitTimeoutMs) {
      throw new DirectoryLockTimeoutError(resourcePath);
    }
    await delay(options.pollIntervalMs);
  }
}

async function recoverStaleDirectoryLock(
  boundary: SafeStoreBoundary,
  directory: string,
  directoryComponents: readonly string[],
  ownerPath: string,
  ownerComponents: readonly string[],
  staleAfterMs: number,
): Promise<boolean> {
  const verified = await boundary.verifyDirectory(directoryComponents);
  if (verified === undefined) return true;
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return true;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new UnsafeDirectoryLockPathError(`Unsafe filesystem lock: ${directory}`);
  }

  const owner = await readLockOwner(boundary, ownerPath, ownerComponents);
  const stale = owner === undefined
    ? Date.now() - stats.mtimeMs >= staleAfterMs
    : owner.hostname === hostname()
      ? !isProcessAlive(owner.pid)
      : Date.now() - stats.mtimeMs >= staleAfterMs;
  if (!stale) return false;

  if (owner !== undefined) {
    const currentOwner = await readLockOwner(
      boundary,
      ownerPath,
      ownerComponents,
    );
    if (currentOwner?.token !== owner.token) return true;
  }
  await unlink(ownerPath).catch((error: unknown) => {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  });
  try {
    await rmdir(directory);
    return true;
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) return true;
    if (isErrnoCode(error, "ENOTEMPTY")) return false;
    throw error;
  }
}

async function readLockOwner(
  boundary: SafeStoreBoundary,
  ownerPath: string,
  ownerComponents: readonly string[],
): Promise<DirectoryLockOwner | undefined> {
  const text = await boundary.readUtf8File(
    ownerComponents,
    MAX_LOCK_OWNER_BYTES,
  );
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isDirectoryLockOwner(value) ? value : undefined;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function releaseDirectoryLock(lock: DirectoryLock): Promise<void> {
  const owner = await readLockOwner(
    lock.boundary,
    lock.ownerPath,
    lock.ownerComponents,
  );
  if (owner?.token !== lock.owner.token) return;
  const verified = await lock.boundary.verifyDirectory(lock.directoryComponents);
  if (verified === undefined) return;
  await unlink(lock.ownerPath);
  await rmdir(lock.directory);
}

async function writeLockOwner(
  ownerPath: string,
  owner: DirectoryLockOwner,
): Promise<void> {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new UnsafeDirectoryLockPathError(
      "This platform cannot safely create filesystem locks",
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    await handle.writeFile(`${stableStringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error: unknown) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeDirectoryLockPathError(
        `Refusing to follow filesystem lock symlink: ${ownerPath}`,
      );
    }
    throw error;
  }
}

function normalizeLockPathError(error: unknown): unknown {
  if (
    error instanceof UnsafeStorePathError ||
    error instanceof StoreFileTooLargeError
  ) {
    return new UnsafeDirectoryLockPathError(error.message);
  }
  return error;
}

function isDirectoryLockOwner(value: unknown): value is DirectoryLockOwner {
  return (
    isObject(value) &&
    value.schema === LOCK_SCHEMA &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.hostname === "string" &&
    value.hostname.length > 0 &&
    typeof value.token === "string" &&
    /^[0-9a-f]{32}$/.test(value.token) &&
    typeof value.acquired_at === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isErrnoCode(error, "ESRCH");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
