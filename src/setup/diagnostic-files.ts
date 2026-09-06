import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

/** Only explicitly named diagnostic inputs may follow a configured symlink. */
export interface DiagnosticFileIdentity {
  readonly path: string;
  readonly real_path: string;
  readonly utf8_bytes: number;
  readonly sha256: string;
  readonly modified_at: string;
}

export type DiagnosticFileFailure = {
  readonly state: "missing" | "unavailable" | "not_file" | "too_large" | "changed";
  readonly path: string;
  readonly code?: string;
  readonly maximum_bytes?: number;
};

export type DiagnosticBytes = DiagnosticFileFailure | {
  readonly state: "ok";
  readonly identity: DiagnosticFileIdentity;
  readonly bytes: Buffer;
};

/**
 * Size-bounded, read-only input for doctor. Never run a configured command.
 * Follow only this explicit path; reject devices/FIFOs before reading. A path
 * switch or concurrent rewrite invalidates the result instead of giving a hash
 * authority over a different file. Error strings never include config contents.
 */
export async function readDiagnosticBytes(
  inputPath: string,
  maximumBytes: number,
): Promise<DiagnosticBytes> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1024 * 1024) {
    throw new RangeError("Diagnostic file limit must be from 1 through 16777216 bytes");
  }
  const path = resolve(inputPath);
  let file: FileHandle | undefined;
  try {
    const target = await realpath(path);
    file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile()) return { state: "not_file", path };
    if (before.size > maximumBytes) return { state: "too_large", path, maximum_bytes: maximumBytes };
    const buffer = Buffer.alloc(Math.min(before.size + 1, maximumBytes + 1));
    let used = 0;
    while (used < buffer.length) {
      const result = await file.read(buffer, used, buffer.length - used, used);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    const after = await file.stat();
    const atPath = await stat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || used !== before.size ||
        after.dev !== atPath.dev || after.ino !== atPath.ino || after.size !== atPath.size ||
        after.mtimeMs !== atPath.mtimeMs || after.ctimeMs !== atPath.ctimeMs ||
        await realpath(path) !== target) {
      return { state: "changed", path };
    }
    const bytes = buffer.subarray(0, used);
    return {
      state: "ok", bytes,
      identity: {
        path, real_path: target, utf8_bytes: used,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        modified_at: new Date(after.mtimeMs).toISOString(),
      },
    };
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : undefined;
    return {
      state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable", path,
      ...(code === undefined ? {} : { code }),
    };
  } finally {
    await file?.close();
  }
}

export type DiagnosticJson = DiagnosticFileFailure | {
  readonly state: "invalid_json";
  readonly path: string;
} | {
  readonly state: "ok";
  readonly identity: DiagnosticFileIdentity;
  readonly value: unknown;
};

export async function readDiagnosticJson(path: string, maximumBytes: number): Promise<DiagnosticJson> {
  const result = await readDiagnosticBytes(path, maximumBytes);
  if (result.state !== "ok") return result;
  try {
    // Fatal UTF-8 decoding prevents invalid bytes becoming a valid JSON value.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    return { state: "ok", identity: result.identity, value: JSON.parse(text) };
  } catch {
    return { state: "invalid_json", path: result.identity.path };
  }
}
