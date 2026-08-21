import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { JsonlCheckpoint } from "../core/checkpoint.js";
import {
  safeStoreFileLocation,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import { stableStringify } from "../core/stable-json.js";

const MAX_CLAUDE_RUNNER_STATE_BYTES = 64 * 1024 * 1024;

export const CLAUDE_RUNNER_STATE_SCHEMA = "barbaro.claude-runner-state.v1";

/**
 * Claude ingestion is a deterministic FULL REPLAY of the session file; the
 * checkpoint is only a change detector, never a resume point.
 *
 * Partial resumption was tried and removed. A Claude turn digest depends on
 * state that spans the whole session — the fork index behind
 * `supersedes_turn_ids`, the Agent/Workflow parent-join indexes, and the
 * sequence counter — so a normalizer that starts mid-file silently produces
 * different records for the same turn. Full replay plus ID-keyed append
 * dedup makes repeated polling converge on exactly the one-shot result.
 */
export interface ClaudeRunnerStateV1 {
  readonly schema: typeof CLAUDE_RUNNER_STATE_SCHEMA;
  readonly trace_id: string;
  readonly native_session_id: string;
  readonly actor_id: string;
  /** Position at end of the last full replay. Used only to detect change. */
  readonly checkpoint: JsonlCheckpoint;
  readonly workspace_root?: string;
}

export async function readClaudeRunnerState(
  filePath: string,
): Promise<ClaudeRunnerStateV1 | undefined> {
  const location = safeStoreFileLocation(filePath);
  const text = await location.boundary.readUtf8File(
    location.relativeComponents,
    MAX_CLAUDE_RUNNER_STATE_BYTES,
  );
  if (text === undefined) return undefined;
  const value = JSON.parse(text) as unknown;
  if (!isObject(value) || value.schema !== CLAUDE_RUNNER_STATE_SCHEMA) {
    throw new TypeError("Unsupported or invalid Claude runner state");
  }
  if (
    typeof value.trace_id !== "string" ||
    typeof value.native_session_id !== "string" ||
    typeof value.actor_id !== "string" ||
    !isObject(value.checkpoint)
  ) {
    throw new TypeError("Claude runner state is structurally invalid");
  }
  return value as unknown as ClaudeRunnerStateV1;
}

export async function writeClaudeRunnerState(
  filePath: string,
  state: ClaudeRunnerStateV1,
): Promise<void> {
  const location = safeStoreFileLocation(filePath);
  const target = await location.boundary.ensureParentForFile(
    location.relativeComponents,
  );
  const temporaryComponents = [
    ...location.relativeComponents.slice(0, -1),
    `.${basename(target)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  ];
  const temporary = location.boundary.pathFor(temporaryComponents);
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
    await handle.writeFile(`${stableStringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const parent = await location.boundary.verifyDirectory(
      location.relativeComponents.slice(0, -1),
    );
    if (parent === undefined) {
      throw new UnsafeStorePathError(dirname(target), "state parent disappeared");
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
