import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { SafeStoreBoundary, UnsafeStorePathError } from "./safe-store.js";
import { stableStringify } from "./stable-json.js";

/**
 * Replace one small JSON file inside a store boundary atomically: write a
 * private exclusive temporary sibling, fsync it, re-verify the parent is
 * still a real directory inside the boundary, then rename over the target.
 * A reader therefore sees either the previous complete file or the new one,
 * never a partial write.
 *
 * Exclusivity between writers is not this helper's job; callers that need it
 * hold a directory lock around the read-decide-write sequence.
 */
export async function writeJsonFileAtomically(
  boundary: SafeStoreBoundary,
  components: readonly string[],
  value: unknown,
): Promise<void> {
  const target = await boundary.ensureParentForFile(components);
  const temporaryComponents = [
    ...components.slice(0, -1),
    `.${components.at(-1)!}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  ];
  const temporary = boundary.pathFor(temporaryComponents);
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
    await handle.writeFile(`${stableStringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const parent = await boundary.verifyDirectory(components.slice(0, -1));
    if (parent === undefined) {
      throw new UnsafeStorePathError(
        dirname(target),
        "store parent disappeared before rename",
      );
    }
    await rename(temporary, target);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
