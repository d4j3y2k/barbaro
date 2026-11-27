import type { ActiveCurrentAction, ActiveWriteClaim } from "../../active/index.js";
import { object } from "./transcript.js";

export interface AgyActiveTool {
  readonly step: number;
  readonly name: string;
  readonly path?: string;
  readonly unknown: boolean;
  readonly waiting: boolean;
  readonly reserved: boolean;
}

export function activeTools(value: unknown): AgyActiveTool[] {
  if (!Array.isArray(value)) return [];
  const tools: AgyActiveTool[] = [];
  for (const entry of value) {
    if (!object(entry) || typeof entry.step !== "number" || !Number.isSafeInteger(entry.step) ||
        typeof entry.name !== "string" || typeof entry.unknown !== "boolean" ||
        typeof entry.waiting !== "boolean" || typeof entry.reserved !== "boolean" ||
        !(entry.path === undefined || typeof entry.path === "string")) continue;
    tools.push({ step: entry.step, name: entry.name, unknown: entry.unknown,
      waiting: entry.waiting, reserved: entry.reserved, ...(typeof entry.path === "string" ? { path: entry.path } : {}) });
  }
  return tools;
}

/** Multiple tools from one model invocation can run concurrently. Keep each
 * claim alive until Antigravity reports the corresponding native tool step. */
export function toolActivity(tools: AgyActiveTool[], command?: ActiveCurrentAction["command"]) {
  const latest = tools.at(-1);
  const claims: ActiveWriteClaim[] = [];
  for (const path of new Set(tools.map((tool) => tool.path).filter((p): p is string => p !== undefined)))
    claims.push({ path, mode: "write", confidence: "exact" });
  const action: ActiveCurrentAction | undefined = latest === undefined ? undefined :
    latest.path ? { kind: "file_change", tool_name: latest.name, path: latest.path } :
    latest.name === "run_command" ? { kind: "command", tool_name: latest.name, ...(command ? { command } : {}) } :
    { kind: "tool", tool_name: latest.name };
  return { state: tools.some((tool) => tool.waiting) ? "waiting" as const : "working" as const,
    claims, unknown_write_scope: tools.some((tool) => tool.unknown), ...(action ? { current_action: action } : {}) };
}
