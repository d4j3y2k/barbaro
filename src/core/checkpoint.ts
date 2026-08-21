import { createHash } from "node:crypto";
import type { BigIntStats, PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

export const JSONL_CHECKPOINT_SCHEMA = "barbaro.jsonl-checkpoint.v1";
export const CHECKPOINT_ANCHOR_BYTES = 64;

export interface FileIdentity {
  /** Decimal device ID from stat(2). */
  readonly device: string;
  /** Decimal inode/file ID from stat(2). */
  readonly inode: string;
  /** Decimal birth time in nanoseconds, used to guard against inode reuse. */
  readonly birthtime_ns: string;
}

export interface FileSnapshot {
  readonly identity: FileIdentity;
  readonly size: number;
  readonly mtime_ns: string;
}

export interface CheckpointAnchor {
  readonly byte_length: number;
  readonly sha256: string;
}

/** JSON-ready state persisted by a forward JSONL consumer. */
export interface JsonlCheckpoint {
  readonly schema: typeof JSONL_CHECKPOINT_SCHEMA;
  readonly file_identity: FileIdentity;
  /** First byte that has not been committed. */
  readonly byte_offset: number;
  /** One-based physical line number at byte_offset. */
  readonly next_line_number: number;
  /** File size observed after the read, including an uncommitted partial line. */
  readonly observed_size: number;
  /** Hash of up to 64 bytes immediately before byte_offset. */
  readonly anchor: CheckpointAnchor;
}

export interface JsonlCheckpointPosition {
  readonly fileIdentity: FileIdentity;
  readonly checkpointOffset: number;
  readonly nextLineNumber: number;
  readonly observedSize: number;
  readonly checkpointAnchor: CheckpointAnchor;
}

export type CheckpointResolutionStatus =
  | "start"
  | "resume"
  | "rotated"
  | "truncated"
  | "rewritten"
  | "missing";

export interface CheckpointResolution {
  readonly status: CheckpointResolutionStatus;
  readonly startOffset: number;
  readonly nextLineNumber: number;
  readonly snapshot?: FileSnapshot;
}

/** Convert a completed reader position into persistable checkpoint data. */
export function createJsonlCheckpoint(
  position: JsonlCheckpointPosition,
): JsonlCheckpoint {
  assertSafeNonNegativeInteger(
    position.checkpointOffset,
    "checkpointOffset",
  );
  assertSafePositiveInteger(position.nextLineNumber, "nextLineNumber");
  assertSafeNonNegativeInteger(position.observedSize, "observedSize");
  if (position.checkpointOffset > position.observedSize) {
    throw new RangeError("checkpointOffset cannot exceed observedSize");
  }
  validateFileIdentity(position.fileIdentity);
  validateAnchor(position.checkpointAnchor, position.checkpointOffset);

  return {
    schema: JSONL_CHECKPOINT_SCHEMA,
    file_identity: {
      device: position.fileIdentity.device,
      inode: position.fileIdentity.inode,
      birthtime_ns: position.fileIdentity.birthtime_ns,
    },
    byte_offset: position.checkpointOffset,
    next_line_number: position.nextLineNumber,
    observed_size: position.observedSize,
    anchor: {
      byte_length: position.checkpointAnchor.byte_length,
      sha256: position.checkpointAnchor.sha256,
    },
  };
}

/**
 * Resolve a saved checkpoint against the file currently at a trace path.
 * Identity changes identify rename/create rotation, shrinking identifies
 * truncation, and the bounded anchor catches same-inode rewrites.
 */
export async function resolveJsonlCheckpoint(
  filePath: PathLike,
  checkpoint?: JsonlCheckpoint,
): Promise<CheckpointResolution> {
  if (checkpoint !== undefined) {
    validateJsonlCheckpoint(checkpoint);
  }

  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        status: "missing",
        startOffset: 0,
        nextLineNumber: 1,
      };
    }
    throw error;
  }

  try {
    const snapshot = snapshotFromStats(await handle.stat({ bigint: true }));
    if (checkpoint === undefined) {
      return {
        status: "start",
        startOffset: 0,
        nextLineNumber: 1,
        snapshot,
      };
    }

    if (!fileIdentityEquals(snapshot.identity, checkpoint.file_identity)) {
      return resetResolution("rotated", snapshot);
    }

    if (
      snapshot.size < checkpoint.byte_offset ||
      snapshot.size < checkpoint.observed_size
    ) {
      return resetResolution("truncated", snapshot);
    }

    const currentAnchor = await readCheckpointAnchor(
      handle,
      checkpoint.byte_offset,
    );
    if (
      currentAnchor.byte_length !== checkpoint.anchor.byte_length ||
      currentAnchor.sha256 !== checkpoint.anchor.sha256
    ) {
      return resetResolution("rewritten", snapshot);
    }

    return {
      status: "resume",
      startOffset: checkpoint.byte_offset,
      nextLineNumber: checkpoint.next_line_number,
      snapshot,
    };
  } finally {
    await handle.close();
  }
}

export function fileIdentityEquals(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtime_ns === right.birthtime_ns
  );
}

export function snapshotFromStats(stats: BigIntStats): FileSnapshot {
  if (!stats.isFile()) {
    throw new TypeError("JSONL trace path is not a regular file");
  }
  if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("JSONL trace is too large for a safe byte offset");
  }

  return {
    identity: {
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10),
      birthtime_ns: stats.birthtimeNs.toString(10),
    },
    size: Number(stats.size),
    mtime_ns: stats.mtimeNs.toString(10),
  };
}

export async function readCheckpointAnchor(
  handle: FileHandle,
  byteOffset: number,
): Promise<CheckpointAnchor> {
  assertSafeNonNegativeInteger(byteOffset, "byteOffset");
  const byteLength = Math.min(CHECKPOINT_ANCHOR_BYTES, byteOffset);
  const bytes = Buffer.allocUnsafe(byteLength);
  if (byteLength > 0) {
    const result = await handle.read(
      bytes,
      0,
      byteLength,
      byteOffset - byteLength,
    );
    if (result.bytesRead !== byteLength) {
      throw new RangeError("File became shorter while reading checkpoint anchor");
    }
  }

  return {
    byte_length: byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function validateJsonlCheckpoint(
  checkpoint: JsonlCheckpoint,
): void {
  if (checkpoint.schema !== JSONL_CHECKPOINT_SCHEMA) {
    throw new TypeError(`Unsupported checkpoint schema: ${checkpoint.schema}`);
  }
  validateFileIdentity(checkpoint.file_identity);
  assertSafeNonNegativeInteger(checkpoint.byte_offset, "byte_offset");
  assertSafePositiveInteger(
    checkpoint.next_line_number,
    "next_line_number",
  );
  assertSafeNonNegativeInteger(checkpoint.observed_size, "observed_size");
  if (checkpoint.byte_offset > checkpoint.observed_size) {
    throw new RangeError("byte_offset cannot exceed observed_size");
  }
  validateAnchor(checkpoint.anchor, checkpoint.byte_offset);
}

function validateFileIdentity(identity: FileIdentity): void {
  for (const name of ["device", "inode", "birthtime_ns"] as const) {
    const value = identity[name];
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new TypeError(`${name} must be a decimal non-negative integer`);
    }
  }
}

function validateAnchor(anchor: CheckpointAnchor, byteOffset: number): void {
  assertSafeNonNegativeInteger(anchor.byte_length, "anchor.byte_length");
  if (
    anchor.byte_length !== Math.min(CHECKPOINT_ANCHOR_BYTES, byteOffset)
  ) {
    throw new RangeError("anchor.byte_length does not match byte_offset");
  }
  if (!/^[0-9a-f]{64}$/.test(anchor.sha256)) {
    throw new TypeError("anchor.sha256 must be a lowercase SHA-256 hex digest");
  }
}

function resetResolution(
  status: "rotated" | "truncated" | "rewritten",
  snapshot: FileSnapshot,
): CheckpointResolution {
  return { status, startOffset: 0, nextLineNumber: 1, snapshot };
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertSafePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
