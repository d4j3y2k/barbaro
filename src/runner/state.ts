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
import type { CodexNormalizerStateV1 } from "../providers/codex/normalizer.js";

const MAX_CODEX_RUNNER_STATE_BYTES = 64 * 1024 * 1024;

export interface CodexRunnerStateV1 {
  readonly schema: "barbaro.codex-runner-state.v1";
  readonly trace_id: string;
  readonly checkpoint: JsonlCheckpoint;
  readonly normalizer: CodexNormalizerStateV1;
}

export async function readCodexRunnerState(
  filePath: string,
): Promise<CodexRunnerStateV1 | undefined> {
  const location = safeStoreFileLocation(filePath);
  const text = await location.boundary.readUtf8File(
    location.relativeComponents,
    MAX_CODEX_RUNNER_STATE_BYTES,
  );
  if (text === undefined) return undefined;
  const value = JSON.parse(text) as unknown;
  if (!isObject(value) || value.schema !== "barbaro.codex-runner-state.v1") {
    throw new TypeError("Unsupported or invalid Codex runner state");
  }
  if (typeof value.trace_id !== "string" || !isObject(value.checkpoint) || !isObject(value.normalizer)) {
    throw new TypeError("Codex runner state is structurally invalid");
  }
  return value as unknown as CodexRunnerStateV1;
}

export async function writeCodexRunnerState(
  filePath: string,
  state: CodexRunnerStateV1,
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
