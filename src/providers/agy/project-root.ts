import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Start at the native workspace and use the closest existing coordination store or Git worktree. */
export async function agyProjectRoot(workspace: string): Promise<string> {
  let candidate = workspace;
  for (;;) {
    const store = await lstat(join(candidate, ".barbaro")).catch(missingFile);
    if (store || await lstat(join(candidate, ".git")).catch(missingFile)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return workspace;
    candidate = parent;
  }
}

function missingFile(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
}
