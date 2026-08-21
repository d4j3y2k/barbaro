import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

import {
  safeStoreFileLocation,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import { stableStringify } from "../core/stable-json.js";
import {
  DirectoryLockTimeoutError,
  withDirectoryLock,
} from "./directory-lock.js";

export {
  DirectoryLockTimeoutError as DerivedOutputLockTimeoutError,
  UnsafeDirectoryLockPathError,
} from "./directory-lock.js";

/** Enough to act on without turning an incident into a data dump. */
const CONFLICT_ID_REPORT_LIMIT = 8;

export interface AppendUniqueResult {
  readonly appended: number;
  readonly skipped: number;
  /**
   * Records whose ID is already published with different canonical content.
   *
   * The stored version always wins — derived output stays append-only and is
   * never rewritten — but one such record must not discard the rest of the
   * batch. Aborting the whole run is what turned a single mutable record into
   * a multi-hour publishing outage: every later turn was held hostage by one
   * poisoned ID, and the hook swallowed the error so nothing surfaced.
   *
   * A non-zero count is a real defect in the producer and callers are expected
   * to report it, not ignore it.
   */
  readonly conflicted: number;
  /**
   * IDs of the conflicting records, bounded. A count alone says a determinism
   * defect exists but not where, which is the whole question when fixing it.
   */
  readonly conflictedIds: readonly string[];
}

export class UnsafeDerivedOutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDerivedOutputPathError";
  }
}

/**
 * Append deterministic records while suppressing IDs already present in the
 * derived file. One filesystem lock serializes writers across processes, and
 * one no-follow file descriptor is retained across heal/read/append so a
 * final-path symlink cannot redirect or truncate an external file.
 */
export async function appendUniqueJsonl<T>(
  filePath: string,
  records: readonly T[],
  idOf: (record: T) => string,
): Promise<AppendUniqueResult> {
  if (records.length === 0)
    return { appended: 0, skipped: 0, conflicted: 0, conflictedIds: [] };
  return withDirectoryLock(filePath, async () => {
    const handle = await openDerivedOutput(filePath);
    try {
      await healPartialDerivedTail(handle);
      const existing = await readExistingRecords(handle, idOf);
      const known = existing.records;
      const seenThisBatch = new Map<string, string>();
      const lines: string[] = [];
      let skipped = 0;
      let conflicted = existing.conflicts;
      const conflictedIds: string[] = [...existing.conflictIds];

      for (const record of records) {
        const id = idOf(record);
        if (!id) throw new TypeError("Derived JSONL record ID must not be empty");
        const canonical = stableStringify(record);
        const persisted = known.get(id);
        if (persisted !== undefined) {
          if (persisted !== canonical) {
            conflicted += 1;
            if (conflictedIds.length < CONFLICT_ID_REPORT_LIMIT) {
              conflictedIds.push(id);
            }
          }
          skipped += 1;
          continue;
        }
        const batched = seenThisBatch.get(id);
        if (batched !== undefined) {
          if (batched !== canonical) {
            conflicted += 1;
            if (conflictedIds.length < CONFLICT_ID_REPORT_LIMIT) {
              conflictedIds.push(id);
            }
          }
          skipped += 1;
          continue;
        }
        seenThisBatch.set(id, canonical);
        lines.push(`${canonical}\n`);
      }

      if (lines.length > 0) {
        await appendToHandle(handle, Buffer.from(lines.join(""), "utf8"));
      }
      return { appended: lines.length, skipped, conflicted, conflictedIds };
    } finally {
      await handle.close();
    }
  }).catch((error: unknown) => {
    if (error instanceof DirectoryLockTimeoutError) {
      error.name = "DerivedOutputLockTimeoutError";
    }
    throw error;
  });
}

async function openDerivedOutput(filePath: string): Promise<FileHandle> {
  const location = safeStoreFileLocation(filePath);
  const verifiedParent = await location.boundary.verifyDirectory(
    location.relativeComponents.slice(0, -1),
  ).catch((error: unknown) => {
    if (error instanceof UnsafeStorePathError) {
      throw new UnsafeDerivedOutputPathError(error.message);
    }
    throw error;
  });
  if (verifiedParent === undefined) {
    throw new UnsafeDerivedOutputPathError(
      `Derived-output parent does not exist: ${filePath}`,
    );
  }
  const target = location.boundary.pathFor(location.relativeComponents);
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new UnsafeDerivedOutputPathError(
      "This platform cannot safely reject derived-output symlinks",
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(
      target,
      constants.O_RDWR | constants.O_CREAT | noFollow,
      0o600,
    );
  } catch (error: unknown) {
    if (isErrnoCode(error, "ELOOP")) {
      throw new UnsafeDerivedOutputPathError(
        `Refusing to follow derived-output symlink: ${filePath}`,
      );
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UnsafeDerivedOutputPathError(
        `Derived output is not a regular file: ${filePath}`,
      );
    }
    if (stats.nlink !== 1) {
      throw new UnsafeDerivedOutputPathError(
        `Derived output has multiple hard links: ${filePath}`,
      );
    }
    return handle;
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readExistingRecords<T>(
  handle: FileHandle,
  idOf: (record: T) => string,
): Promise<{
  records: Map<string, string>;
  conflicts: number;
  conflictIds: string[];
}> {
  const text = await handle.readFile("utf8");
  const records = new Map<string, string>();
  const conflictIds: string[] = [];
  let conflicts = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(value)) continue;
    let id: string;
    try {
      id = idOf(value as T);
    } catch {
      // A structurally unrelated/corrupt line cannot identify a known record.
      continue;
    }
    if (!id) continue;
    const canonical = stableStringify(value);
    const previous = records.get(id);
    if (previous !== undefined) {
      // Already-published bytes are never rewritten, so the first version
      // stands. A duplicate ID on disk is corruption worth reporting, not a
      // reason to refuse every subsequent read of the file.
      if (previous !== canonical) {
        conflicts += 1;
        if (conflictIds.length < CONFLICT_ID_REPORT_LIMIT) conflictIds.push(id);
      }
    } else {
      records.set(id, canonical);
    }
  }
  return { records, conflicts, conflictIds };
}

/** Generated output is recoverable; discard only a torn final derived line. */
async function healPartialDerivedTail(handle: FileHandle): Promise<void> {
  const stats = await handle.stat();
  if (stats.size === 0) return;
  const lastByte = Buffer.allocUnsafe(1);
  await readExactly(handle, lastByte, stats.size - 1);
  if (lastByte[0] === 0x0a) return;

  const chunkSize = 64 * 1024;
  let position = stats.size;
  let truncateAt = 0;
  while (position > 0) {
    const length = Math.min(chunkSize, position);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    await readExactly(handle, chunk, position);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) {
      truncateAt = position + newline + 1;
      break;
    }
  }
  await handle.truncate(truncateAt);
  await handle.sync();
}

async function appendToHandle(handle: FileHandle, bytes: Buffer): Promise<void> {
  const stats = await handle.stat();
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      stats.size + written,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Derived JSONL append made no forward progress");
    }
    written += result.bytesWritten;
  }
  await handle.sync();
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let read = 0;
  while (read < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      read,
      buffer.byteLength - read,
      position + read,
    );
    if (result.bytesRead === 0) {
      throw new Error("Derived JSONL file changed while it was being read");
    }
    read += result.bytesRead;
  }
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
