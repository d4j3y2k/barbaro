import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import { compareUtf16CodeUnits } from "../core/stable-json.js";

/**
 * Read-only filesystem facts for the setup doctor.
 *
 * Every function here observes metadata or explicitly named configuration
 * text. Nothing in this module creates, moves, or writes a path, and the
 * directory scanners never open file contents, so they stay safe to point at
 * `.barbaro/` canonical records.
 */

export interface ScanLimits {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

export const DEFAULT_SCAN_LIMITS: Required<ScanLimits> = {
  maxEntries: 5_000,
  maxDepth: 12,
};

export function resolveScanLimits(
  limits: ScanLimits = {},
): Required<ScanLimits> {
  const maxEntries = limits.maxEntries ?? DEFAULT_SCAN_LIMITS.maxEntries;
  const maxDepth = limits.maxDepth ?? DEFAULT_SCAN_LIMITS.maxDepth;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError("maxEntries must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new TypeError("maxDepth must be a positive safe integer");
  }
  return { maxEntries, maxDepth };
}

export type PathKind = "missing" | "file" | "directory" | "symlink" | "other";

export interface PathFacts {
  readonly path: string;
  readonly kind: PathKind;
  readonly sizeBytes: number | undefined;
  readonly mtimeMs: number | undefined;
  readonly executable: boolean | undefined;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissing(error: unknown): boolean {
  return (
    isErrnoCode(error, "ENOENT") ||
    isErrnoCode(error, "ENOTDIR") ||
    isErrnoCode(error, "ELOOP")
  );
}

/** `lstat`, never `stat`: a symlink is reported as a symlink, not followed. */
export async function inspectPath(path: string): Promise<PathFacts> {
  try {
    const stats = await lstat(path);
    const kind: PathKind = stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other";
    return {
      path,
      kind,
      sizeBytes: kind === "file" ? stats.size : undefined,
      mtimeMs: stats.mtimeMs,
      executable: kind === "file" ? (stats.mode & 0o111) !== 0 : undefined,
    };
  } catch (error) {
    if (isMissing(error)) {
      return {
        path,
        kind: "missing",
        sizeBytes: undefined,
        mtimeMs: undefined,
        executable: undefined,
      };
    }
    throw error;
  }
}

export interface ResolvedFileFacts {
  readonly path: string;
  readonly realPath: string | undefined;
  readonly kind: PathKind;
  readonly sizeBytes: number | undefined;
  readonly mtimeMs: number | undefined;
  readonly executable: boolean | undefined;
}

/**
 * Follows symlinks, the way a shell resolves a command a hook config names.
 * Use this only for explicitly configured executables, never for scanning.
 */
export async function inspectResolvedFile(
  path: string,
): Promise<ResolvedFileFacts> {
  try {
    const stats = await stat(path);
    const kind: PathKind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";
    let realPath: string | undefined;
    try {
      realPath = await realpath(path);
    } catch {
      // A resolvable stat with an unresolvable realpath is still usable; the
      // caller only loses the canonical location.
      realPath = undefined;
    }
    return {
      path,
      realPath,
      kind,
      sizeBytes: kind === "file" ? stats.size : undefined,
      mtimeMs: stats.mtimeMs,
      executable: kind === "file" ? (stats.mode & 0o111) !== 0 : undefined,
    };
  } catch (error) {
    if (isMissing(error)) {
      return {
        path,
        realPath: undefined,
        kind: "missing",
        sizeBytes: undefined,
        mtimeMs: undefined,
        executable: undefined,
      };
    }
    throw error;
  }
}

export interface DirectoryScan {
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly otherCount: number;
  readonly totalBytes: number;
  readonly newestMtimeMs: number | undefined;
  readonly topLevelEntries: readonly string[];
  readonly truncated: boolean;
}

/**
 * Recursive metadata census. Returns `undefined` when the root is absent.
 * Symlinks are counted but never traversed, and no file is ever opened.
 */
export async function scanDirectory(
  root: string,
  limits: ScanLimits = {},
): Promise<DirectoryScan | undefined> {
  const { maxEntries, maxDepth } = resolveScanLimits(limits);
  const rootFacts = await inspectPath(root);
  if (rootFacts.kind === "missing") return undefined;
  if (rootFacts.kind !== "directory") {
    return {
      fileCount: 0,
      directoryCount: 0,
      symlinkCount: rootFacts.kind === "symlink" ? 1 : 0,
      otherCount: rootFacts.kind === "symlink" ? 0 : 1,
      totalBytes: 0,
      newestMtimeMs: rootFacts.mtimeMs,
      topLevelEntries: [],
      truncated: false,
    };
  }

  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let otherCount = 0;
  let totalBytes = 0;
  let newestMtimeMs: number | undefined;
  let seen = 0;
  let truncated = false;
  const topLevelEntries: string[] = [];

  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.shift()!;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    entries.sort((left, right) =>
      compareUtf16CodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      if (seen >= maxEntries) {
        truncated = true;
        break;
      }
      seen += 1;
      const path = join(current.path, entry.name);
      if (current.depth === 0) topLevelEntries.push(entry.name);
      if (entry.isSymbolicLink()) {
        symlinkCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        directoryCount += 1;
        if (current.depth + 1 < maxDepth) {
          pending.push({ path, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile()) {
        otherCount += 1;
        continue;
      }
      fileCount += 1;
      const facts = await inspectPath(path);
      if (facts.sizeBytes !== undefined) totalBytes += facts.sizeBytes;
      if (
        facts.mtimeMs !== undefined &&
        (newestMtimeMs === undefined || facts.mtimeMs > newestMtimeMs)
      ) {
        newestMtimeMs = facts.mtimeMs;
      }
    }
    if (truncated && seen >= maxEntries) break;
  }

  return {
    fileCount,
    directoryCount,
    symlinkCount,
    otherCount,
    totalBytes,
    newestMtimeMs,
    topLevelEntries,
    truncated,
  };
}

export interface WalkedFile {
  readonly path: string;
  readonly relativePath: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

export interface FileWalk {
  readonly files: readonly WalkedFile[];
  readonly truncated: boolean;
}

/**
 * Deterministic depth-first file listing, sorted by POSIX-style relative path.
 * Symlinks are skipped so a build check cannot be steered outside the tree.
 */
export async function walkFiles(
  root: string,
  options: {
    readonly limits?: ScanLimits;
    readonly include?: (relativePath: string) => boolean;
  } = {},
): Promise<FileWalk | undefined> {
  const { maxEntries, maxDepth } = resolveScanLimits(options.limits);
  const rootFacts = await inspectPath(root);
  if (rootFacts.kind === "missing") return undefined;
  if (rootFacts.kind !== "directory") return { files: [], truncated: false };

  const files: WalkedFile[] = [];
  let seen = 0;
  let truncated = false;
  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.shift()!;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    entries.sort((left, right) =>
      compareUtf16CodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      if (seen >= maxEntries) {
        truncated = true;
        break;
      }
      seen += 1;
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth + 1 < maxDepth) {
          pending.push({ path, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toPosixRelative(root, path);
      if (options.include !== undefined && !options.include(relativePath)) {
        continue;
      }
      const facts = await inspectPath(path);
      if (facts.mtimeMs === undefined) continue;
      files.push({
        path,
        relativePath,
        mtimeMs: facts.mtimeMs,
        sizeBytes: facts.sizeBytes ?? 0,
      });
    }
    if (truncated && seen >= maxEntries) break;
  }

  files.sort((left, right) =>
    compareUtf16CodeUnits(left.relativePath, right.relativePath),
  );
  return { files, truncated };
}

export type JsonFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "not_a_file"; readonly pathKind: PathKind }
  | { readonly kind: "too_large"; readonly sizeBytes: number }
  | { readonly kind: "invalid_json"; readonly message: string }
  | { readonly kind: "ok"; readonly value: unknown };

export type TextFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "not_a_file"; readonly pathKind: PathKind }
  | { readonly kind: "too_large"; readonly sizeBytes: number }
  | { readonly kind: "ok"; readonly text: string };

/** Size-bounded text read for explicitly named configuration files. */
export async function readTextFile(
  path: string,
  maxBytes: number,
): Promise<TextFileRead> {
  const facts = await inspectPath(path);
  if (facts.kind === "missing") return { kind: "missing" };
  if (facts.kind !== "file") return { kind: "not_a_file", pathKind: facts.kind };
  if ((facts.sizeBytes ?? 0) > maxBytes) {
    return { kind: "too_large", sizeBytes: facts.sizeBytes ?? 0 };
  }
  try {
    return { kind: "ok", text: await readFile(path, "utf8") };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }
}

export async function readJsonFile(
  path: string,
  maxBytes: number,
): Promise<JsonFileRead> {
  const text = await readTextFile(path, maxBytes);
  if (text.kind !== "ok") return text;
  try {
    return { kind: "ok", value: JSON.parse(text.text) };
  } catch (error) {
    return {
      kind: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Locate an executable the way a shell would, without running it. A command
 * containing a path separator is checked directly; otherwise PATH is searched
 * in order and the first executable regular file wins.
 */
export async function resolveExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  if (command.length === 0) return undefined;
  if (command.includes(sep) || command.includes("/")) {
    const path = isAbsolute(command) ? command : resolve(command);
    const resolved = await inspectResolvedFile(path);
    return resolved.kind === "file" && resolved.executable === true
      ? path
      : undefined;
  }
  const search = env["PATH"] ?? "";
  for (const directory of search.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    const resolved = await inspectResolvedFile(candidate);
    if (resolved.kind === "file" && resolved.executable === true) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Canonical location of a path, or the path itself when it cannot be resolved.
 * Containment checks need this because a temporary or symlinked project root
 * compares unequal to the resolved location of a file inside it.
 */
export async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** True when `target` is `root` itself or lies beneath it. */
export function isWithin(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  if (relativePath.length === 0) return true;
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function toPosixRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

/** Whole-second ages keep reports stable across sub-millisecond jitter. */
export function ageSeconds(nowMs: number, mtimeMs: number): number {
  return Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
}
