import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createSessionId } from "../core/id.js";
import { InputLimitError } from "../core/input-limit.js";
import { readJsonlForward } from "../core/jsonl-reader.js";
import { commitHookReadOutput, discardHookRead, stageHookReadOutput } from "../nudge/read-commit.js";
import { reserveHookRead, resolveHookRead, type HookReadOptions } from "../nudge/read-invocation.js";
import type { NudgePendingRead } from "../nudge/read-state.js";
import { NudgeCursorStateStore } from "../nudge/store.js";
import { NUDGE_CURSOR_SCHEMA } from "../nudge/types.js";
import { isCodexReadProducer, observeHookRead, type CodexReadProducer, type NativeTraceLimit } from "./read-observation.js";

export const MAX_CODEX_DELIVERY_TRACE_BYTES = 128 * 1024 * 1024;
export const MAX_CODEX_DELIVERY_RECORD_BYTES = 8 * 1024 * 1024;

type CodexReadActor = Omit<HookReadOptions, "toolName" | "toolUseId" | "toolInput"> & {
  readonly tracePath?: string;
  readonly nativeTurnId: string;
};

/** Called only at an admitted main actor boundary, before its nudge or Stop decision. */
export async function handleCodexReadDelivery(
  actor: CodexReadActor,
  event: string,
  input: Record<string, unknown>,
): Promise<void> {
  const call = { ...actor, toolName: input.tool_name, toolUseId: input.tool_use_id, toolInput: input.tool_input };
  if (event === "PostToolUse") {
    // The pinned hook has terminal output but no exit status. This is only a
    // candidate; the trace must independently prove success before any commit.
    if (typeof input.tool_response !== "string" || !await stageHookReadOutput(call, input.tool_response)) {
      await discardHookRead(call);
      if (await resolveHookRead(call) !== undefined) await observeHookRead(call, "refused", "output_not_eligible");
    } else {
      await observeHookRead(call, "staged", "candidate_staged");
    }
  }
  await reconcileCodexReads(actor);
  if (event === "PreToolUse" && actor.tracePath !== undefined && object(input.tool_input) && await resolveHookRead(call) !== undefined) {
    const { trace, limit } = await readAtDeliveryBoundary(actor);
    // An arbitrary wrapper can alter or drop the result. Reserve only when the
    // provider trace already pins one open, literal forwarding invocation.
    const open = trace?.rows.filter((row) => row.type === "custom_tool_call" &&
      !trace.rows.some((result) => result.type === "custom_tool_call_output" && result.call_id === row.call_id));
    if (trace !== undefined && open?.length === 1 && open[0]!.name === "exec" && typeof open[0]!.input === "string" &&
        literalForwardedExec(open[0]!.input)?.cmd === input.tool_input.command) {
      const result = await reserveHookRead(call);
      await observeHookRead(call, result.reserved ? "reserved" : "refused", result.reserved ? "reserved" : "reservation_refused", trace.producerVersion);
    } else await observeHookRead(call, "refused", limit === undefined ? "unsupported_producer_or_shape" : "native_trace_limit", undefined, limit);
  } else if (event === "PreToolUse" && actor.tracePath === undefined && await resolveHookRead(call) !== undefined) {
    await observeHookRead(call, "refused", "unsupported_producer_or_shape");
  }
}

async function reconcileCodexReads(actor: CodexReadActor): Promise<void> {
  if (actor.tracePath === undefined || actor.turn?.kind !== "codex") return;
  const turnId = actor.turn.turn_id;
  const state = await new NudgeCursorStateStore(actor.projectRoot).read("codex", createSessionId("codex", actor.nativeSessionId));
  if (state?.schema !== NUDGE_CURSOR_SCHEMA) return;
  const now = actor.now ?? new Date();
  const pending = state.reads.pending.filter((entry) => entry.output !== undefined &&
    entry.turn.kind === "codex" && entry.turn.turn_id === turnId &&
    Date.parse(entry.created_at) <= now.getTime() && Date.parse(entry.expires_at) > now.getTime());
  if (pending.length === 0) return;
  const { trace, limit } = await readAtDeliveryBoundary(actor);
  for (const entry of pending) {
    const call = { ...actor, toolName: "Bash", toolUseId: entry.tool_use_id, toolInput: { command: entry.command } };
    if (trace === undefined) {
      await observeHookRead(call, "refused", limit === undefined ? "unsupported_producer_or_shape" : "native_trace_limit", undefined, limit);
      continue;
    }
    const modelText = codexDeliveredText(trace, entry);
    if (modelText === undefined) continue;
    const result = await commitHookReadOutput(call, modelText);
    await observeHookRead(call, result.committed ? "committed" : "refused", result.committed ? "model_delivery_verified" : "commit_not_verified", trace.producerVersion);
  }
}

/** Resource refusal leaves ordinary hook activity running and carries no delivery authority. */
async function readAtDeliveryBoundary(actor: CodexReadActor): Promise<{ trace?: CodexDeliveryTrace; limit?: NativeTraceLimit }> {
  try {
    const trace = await readCodexDeliveryTrace(actor.tracePath!, actor.nativeSessionId, actor.nativeTurnId, actor.projectRoot);
    return trace === undefined ? {} : { trace };
  } catch (error: unknown) {
    // The pinned reader supplies the observed size. A later path stat could
    // describe another file or size and must not substitute for that evidence.
    if (!(error instanceof InputLimitError) || error.observedBytes === undefined) throw error;
    return { limit: { kind: error.kind, observed_bytes: error.observedBytes, maximum_bytes: error.maximumBytes } };
  }
}

export interface CodexDeliveryTrace {
  readonly projectRoot: string;
  readonly producerVersion: CodexReadProducer;
  readonly rows: readonly Record<string, unknown>[];
}

/** One bounded, pinned trace read; malformed/partial/foreign evidence cannot acknowledge. */
export async function readCodexDeliveryTrace(
  path: string, nativeSessionId: string, nativeTurnId: string, projectRoot: string,
): Promise<CodexDeliveryTrace | undefined> {
  const rows: Record<string, unknown>[] = [];
  let identity: Record<string, unknown> | undefined;
  let invalidIdentity = false;
  const summary = await readJsonlForward(path, (line) => {
    if (line.kind !== "record" || !object(line.value) || !object(line.value.payload)) return;
    const row = line.value;
    const payload = row.payload as Record<string, unknown>;
    if (row.type === "session_meta") {
      if (identity !== undefined) invalidIdentity = true;
      identity = payload;
    } else if (row.type === "event_msg" && payload.type === "item_completed" &&
        payload.turn_id === nativeTurnId && payload.thread_id === identity?.id && object(payload.item) &&
        payload.item.type === "CommandExecution") {
      rows.push({ kind: "execution", ...payload.item });
    } else if (row.type === "response_item" &&
        ["custom_tool_call", "custom_tool_call_output"].includes(String(payload.type)) &&
        object(payload.internal_chat_message_metadata_passthrough) &&
        payload.internal_chat_message_metadata_passthrough.turn_id === nativeTurnId) {
      rows.push(payload);
    }
  }, { pinEnd: true, noFollow: true, maxFileBytes: MAX_CODEX_DELIVERY_TRACE_BYTES, maxLineBytes: MAX_CODEX_DELIVERY_RECORD_BYTES });
  if (summary.malformedLines > 0 || summary.partialFinalLine !== undefined || invalidIdentity ||
      identity?.session_id !== nativeSessionId || !isCodexReadProducer(identity.cli_version) ||
      identity.history_mode !== "paginated" || typeof identity.cwd !== "string") return undefined;
  const root = await realpath(projectRoot);
  if (await realpath(identity.cwd) !== root) return undefined;
  return { projectRoot: root, producerVersion: identity.cli_version, rows };
}

/** The captured code-mode host forwards precisely one literal exec result. */
export function codexDeliveredText(
  trace: CodexDeliveryTrace, pending: Pick<NudgePendingRead, "tool_use_id" | "command" | "output">,
): string | undefined {
  const matches: string[] = [];
  for (const [start, call] of trace.rows.entries()) {
    if (call.type !== "custom_tool_call" || call.name !== "exec" || typeof call.call_id !== "string" ||
        typeof call.input !== "string" || literalForwardedExec(call.input)?.cmd !== pending.command) continue;
    const outputs = trace.rows.map((row, index) => ({ row, index })).filter(({ row, index }) =>
      index > start && row.type === "custom_tool_call_output" && row.call_id === call.call_id);
    if (outputs.length !== 1 || trace.rows.filter((row) => row.type === "custom_tool_call" && row.call_id === call.call_id).length !== 1) continue;
    const result = outputs[0]!;
    const executions = trace.rows.slice(start + 1, result.index).filter((row) => row.kind === "execution");
    if (executions.length !== 1) continue;
    const execution = executions[0]!;
    if (execution.id !== pending.tool_use_id || execution.exit_code !== 0 || execution.status !== "completed" ||
        execution.source !== "unified_exec_startup" || execution.stderr !== "" ||
        typeof execution.stdout !== "string" || execution.stdout !== execution.aggregated_output ||
        normalized(execution.stdout) !== pending.output || !Array.isArray(execution.command) || execution.command.length !== 3 ||
        !["/bin/zsh", "/bin/bash", "/bin/sh"].includes(String(execution.command[0])) ||
        !["-lc", "-c"].includes(String(execution.command[1])) || execution.command[2] !== pending.command ||
        !sameFileUrl(execution.cwd, trace.projectRoot)) continue;
    const text = forwardedModelOutput(result.row.output);
    if (text !== undefined && normalized(text) === pending.output) matches.push(text);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** A tiny literal grammar, never JavaScript evaluation or a substring match. */
export function literalForwardedExec(source: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(source) > 16384) return undefined;
  const match = /^\s*text\(\s*await\s+tools\.exec_command\(\s*\{([\s\S]*)\}\s*\)\s*\)\s*;?\s*$/u.exec(source);
  if (match === null) return undefined;
  const body = match[1]!;
  const pair = /\s*(cmd|workdir|shell|login|tty|max_output_tokens|yield_time_ms|sandbox_permissions)\s*:\s*("(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|true|false|(?:0|[1-9][0-9]*))\s*(,|$)/uy;
  const value: Record<string, unknown> = {};
  while (pair.lastIndex < body.length) {
    const part = pair.exec(body);
    if (part === null || Object.hasOwn(value, part[1]!)) return undefined;
    value[part[1]!] = JSON.parse(part[2]!);
    if (part[3] === "") break;
  }
  if (typeof value.cmd !== "string" ||
      Object.entries(value).some(([key, item]) =>
        ["cmd", "workdir", "shell", "sandbox_permissions"].includes(key) ? typeof item !== "string" :
        ["login", "tty"].includes(key) ? typeof item !== "boolean" : !Number.isSafeInteger(item))) return undefined;
  return value;
}

function forwardedModelOutput(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 2 ||
      value.some((block) => !object(block) || block.type !== "input_text" || typeof block.text !== "string" ||
        Object.keys(block).some((key) => key !== "type" && key !== "text"))) return undefined;
  if (!/^Script completed\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/u.test(value[0].text)) return undefined;
  try {
    const result: unknown = JSON.parse(value[1].text);
    if (!object(result) || JSON.stringify(result) !== value[1].text ||
        Object.keys(result).some((key) => !["chunk_id", "wall_time_seconds", "exit_code", "original_token_count", "output"].includes(key)) ||
        result.exit_code !== 0 || typeof result.output !== "string" || typeof result.chunk_id !== "string" ||
        typeof result.wall_time_seconds !== "number" || !Number.isFinite(result.wall_time_seconds) || result.wall_time_seconds < 0) return undefined;
    return result.output;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function sameFileUrl(value: unknown, root: string): boolean {
  if (typeof value !== "string" || !value.startsWith("file:///")) return false;
  try { return fileURLToPath(value) === root || fileURLToPath(value) === root.replace(/^\/private\/tmp\//u, "/tmp/"); }
  catch { return false; }
}
function normalized(value: string): string { return value.endsWith("\n") ? value.slice(0, -1) : value; }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
