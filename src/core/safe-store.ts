import { constants } from "node:fs";
import { InputLimitError } from "./input-limit.js";
import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const READ_CHUNK_BYTES = 64 * 1024;

export class UnsafeStorePathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Unsafe Barbaro store path ${path}: ${reason}`);
    this.name = "UnsafeStorePathError";
    this.path = path;
  }
}

export class StoreFileTooLargeError extends InputLimitError {
  readonly path: string;

  constructor(path: string, maximumBytes: number) {
    super(`Barbaro store file ${path} exceeds ${maximumBytes} bytes`, "file", maximumBytes);
    this.name = "StoreFileTooLargeError";
    this.path = path;
  }
}

export interface BarbaroStoreLocation {
  readonly boundary: SafeStoreBoundary;
  readonly relativeComponents: readonly string[];
}

/**
 * A lexical store root backed by component-by-component filesystem checks.
 *
 * `forBarbaroProject()` is the normal production boundary: its trusted anchor
 * is the project root and its guarded root is `<projectRoot>/.barbaro`.
 * `forDirectory()` exists to preserve the ActiveLeaseStore's historical
 * direct-directory API while applying the same checks to that directory.
 *
 * Node does not expose the complete openat2/renameat family. These checks
 * reject pre-existing symlink escapes and re-verify real containment, but a
 * hostile process that can rename directory components concurrently can still
 * create a path-resolution TOCTOU race. `.barbaro` should therefore not be
 * writable by untrusted users.
 */
export class SafeStoreBoundary {
  readonly anchorPath: string;
  readonly rootPath: string;
  readonly #rootComponents: readonly string[];

  private constructor(anchorPath: string, rootComponents: readonly string[]) {
    this.anchorPath = resolve(anchorPath);
    this.#rootComponents = rootComponents.map(validateComponent);
    if (this.#rootComponents.length === 0) {
      throw new TypeError("Safe store boundary requires a guarded root component");
    }
    this.rootPath = join(this.anchorPath, ...this.#rootComponents);
  }

  static forBarbaroProject(projectRoot: string): SafeStoreBoundary {
    if (projectRoot.length === 0) {
      throw new TypeError("projectRoot must not be empty");
    }
    return new SafeStoreBoundary(projectRoot, [".barbaro"]);
  }

  static forDirectory(directory: string): SafeStoreBoundary {
    if (directory.length === 0) {
      throw new TypeError("store directory must not be empty");
    }
    const target = resolve(directory);
    const parent = dirname(target);
    const component = basename(target);
    if (target === parent || component.length === 0) {
      throw new TypeError("filesystem root cannot be used as a store directory");
    }
    return new SafeStoreBoundary(parent, [component]);
  }

  pathFor(relativeComponents: readonly string[]): string {
    return join(
      this.rootPath,
      ...relativeComponents.map(validateComponent),
    );
  }

  componentsForPath(targetPath: string): string[] {
    const target = resolve(targetPath);
    const candidate = relative(this.rootPath, target);
    if (isOutside(candidate)) {
      throw new UnsafeStorePathError(
        target,
        `path is outside guarded root ${this.rootPath}`,
      );
    }
    if (candidate.length === 0) {
      return [];
    }
    return candidate.split(sep).map(validateComponent);
  }

  /** Create missing directories privately and reject every symlink/non-dir. */
  async ensureDirectory(
    relativeComponents: readonly string[] = [],
  ): Promise<string> {
    const path = await this.inspectDirectoryChain(relativeComponents, true);
    if (path === undefined) {
      throw new Error("unreachable: create mode returned a missing directory");
    }
    return path;
  }

  /** Verify an existing directory chain without creating it. */
  async verifyDirectory(
    relativeComponents: readonly string[] = [],
  ): Promise<string | undefined> {
    return this.inspectDirectoryChain(relativeComponents, false);
  }

  async ensureParentForFile(
    relativeComponents: readonly string[],
  ): Promise<string> {
    const components = relativeComponents.map(validateComponent);
    if (components.length === 0) {
      throw new TypeError("file path must include a filename");
    }
    await this.ensureDirectory(components.slice(0, -1));
    return this.pathFor(components);
  }

  /**
   * Read through an O_NOFOLLOW descriptor, accept regular files only, and
   * bound both the pre-read stat and bytes actually consumed.
   */
  async readRegularFile(
    relativeComponents: readonly string[],
    maximumBytes: number,
  ): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new TypeError("maximumBytes must be a non-negative safe integer");
    }
    const components = relativeComponents.map(validateComponent);
    if (components.length === 0) {
      throw new TypeError("file path must include a filename");
    }
    const parent = await this.verifyDirectory(components.slice(0, -1));
    if (parent === undefined) {
      return undefined;
    }
    const path = this.pathFor(components);

    // This gives a deterministic error for an already-present final symlink;
    // O_NOFOLLOW below is the security check that also covers replacement
    // between this inspection and open().
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        throw new UnsafeStorePathError(path, "final file is a symbolic link");
      }
      if (!entry.isFile()) {
        throw new UnsafeStorePathError(path, "final path is not a regular file");
      }
    } catch (error: unknown) {
      if (isErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }

    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (isErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      if (isErrnoCode(error, "ELOOP")) {
        throw new UnsafeStorePathError(path, "final file is a symbolic link");
      }
      throw error;
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new UnsafeStorePathError(path, "opened object is not a regular file");
      }
      if (metadata.size > maximumBytes) {
        throw new StoreFileTooLargeError(path, maximumBytes);
      }
      return await readBounded(handle, path, maximumBytes);
    } finally {
      await handle.close();
    }
  }

  async readUtf8File(
    relativeComponents: readonly string[],
    maximumBytes: number,
  ): Promise<string | undefined> {
    return (await this.readRegularFile(relativeComponents, maximumBytes))?.toString(
      "utf8",
    );
  }

  private async inspectDirectoryChain(
    relativeComponents: readonly string[],
    create: boolean,
  ): Promise<string | undefined> {
    const requested = relativeComponents.map(validateComponent);
    const anchorMetadata = await stat(this.anchorPath);
    if (!anchorMetadata.isDirectory()) {
      throw new UnsafeStorePathError(this.anchorPath, "anchor is not a directory");
    }
    const canonicalAnchor = await realpath(this.anchorPath);
    let current = this.anchorPath;
    let canonicalRoot: string | undefined;
    const chain = [...this.#rootComponents, ...requested];

    for (let index = 0; index < chain.length; index += 1) {
      current = join(current, chain[index]!);
      let entry;
      try {
        entry = await lstat(current);
      } catch (error: unknown) {
        if (!isErrnoCode(error, "ENOENT")) {
          throw error;
        }
        if (!create) {
          return undefined;
        }
        try {
          await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
        } catch (mkdirError: unknown) {
          if (!isErrnoCode(mkdirError, "EEXIST")) {
            throw mkdirError;
          }
        }
        entry = await lstat(current);
      }

      if (entry.isSymbolicLink()) {
        throw new UnsafeStorePathError(current, "directory component is a symbolic link");
      }
      if (!entry.isDirectory()) {
        throw new UnsafeStorePathError(current, "directory component is not a directory");
      }

      let canonicalCurrent: string;
      try {
        canonicalCurrent = await realpath(current);
      } catch (error: unknown) {
        if (!create && isErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
      const requiredBase = canonicalRoot ?? canonicalAnchor;
      assertContained(requiredBase, canonicalCurrent, current);
      if (index === this.#rootComponents.length - 1) {
        canonicalRoot = canonicalCurrent;
      }
    }

    if (canonicalRoot === undefined) {
      throw new Error("unreachable: guarded root was not inspected");
    }
    let canonicalCurrent: string;
    try {
      canonicalCurrent = await realpath(current);
    } catch (error: unknown) {
      if (!create && isErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    assertContained(canonicalRoot, canonicalCurrent, current);
    return current;
  }
}

/** Locate the nearest lexical `.barbaro` ancestor of a target path. */
export function findBarbaroStoreLocation(
  targetPath: string,
): BarbaroStoreLocation | undefined {
  const target = resolve(targetPath);
  let cursor = target;
  while (true) {
    if (basename(cursor) === ".barbaro") {
      const boundary = SafeStoreBoundary.forBarbaroProject(dirname(cursor));
      return {
        boundary,
        relativeComponents: boundary.componentsForPath(target),
      };
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

/**
 * Resolve a file into the project-local `.barbaro` boundary when applicable.
 * The direct-directory fallback keeps standalone store APIs usable in tests
 * and tools that intentionally persist outside a Barbaro project.
 */
export function safeStoreFileLocation(targetPath: string): BarbaroStoreLocation {
  const target = resolve(targetPath);
  const barbaroLocation = findBarbaroStoreLocation(target);
  if (barbaroLocation !== undefined) {
    return barbaroLocation;
  }
  const boundary = SafeStoreBoundary.forDirectory(dirname(target));
  return {
    boundary,
    relativeComponents: [basename(target)],
  };
}

async function readBounded(
  handle: FileHandle,
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maximumBytes - total;
    const length = Math.min(
      READ_CHUNK_BYTES,
      remaining >= READ_CHUNK_BYTES ? READ_CHUNK_BYTES : remaining + 1,
    );
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, total);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maximumBytes) {
      throw new StoreFileTooLargeError(path, maximumBytes);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
}

function validateComponent(component: string): string {
  if (
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    component.includes("/") ||
    component.includes("\\") ||
    component.includes("\0")
  ) {
    throw new TypeError(`Invalid store path component: ${JSON.stringify(component)}`);
  }
  return component;
}

function assertContained(base: string, candidate: string, path: string): void {
  const relation = relative(base, candidate);
  if (isOutside(relation)) {
    throw new UnsafeStorePathError(
      path,
      `real path ${candidate} escapes ${base}`,
    );
  }
}

function isOutside(candidate: string): boolean {
  return (
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
