import { commitHookReadOutput, discardHookRead, stageHookReadOutput } from "../nudge/read-commit.js";
import { reserveHookRead, resolveHookRead, type HookReadOptions } from "../nudge/read-invocation.js";
import { observeHookRead } from "./read-observation.js";

type ClaudeReadActor = Omit<HookReadOptions, "toolName" | "toolUseId" | "toolInput">;

/** Called only after the main Claude actor's natural hook boundary is admitted. */
export async function handleClaudeReadDelivery(
  actor: ClaudeReadActor,
  event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch",
  input: Record<string, unknown>,
): Promise<void> {
  if (event === "PostToolBatch") {
    if (!Array.isArray(input.tool_calls)) return;
    for (const call of input.tool_calls) {
      if (!object(call) || call.tool_name !== "Bash") continue;
      const invocation = options(actor, call);
      if (await resolveHookRead(invocation) === undefined) continue;
      const text = claudeModelText(call.tool_response);
      if (text === undefined) {
        await observeHookRead(invocation, "refused", "unsupported_producer_or_shape");
        continue;
      }
      const result = await commitHookReadOutput(invocation, text);
      await observeHookRead(invocation, result.committed ? "committed" : "refused", result.committed ? "model_delivery_verified" : "commit_not_verified");
    }
    return;
  }
  if (input.tool_name !== "Bash") return;
  const call = options(actor, input);
  if (await resolveHookRead(call) === undefined) return;
  if (event === "PreToolUse") {
    const result = await reserveHookRead(call);
    await observeHookRead(call, result.reserved ? "reserved" : "refused", result.reserved ? "reserved" : "reservation_refused");
  } else if (event === "PostToolUseFailure") {
    await discardHookRead(call);
    await observeHookRead(call, "refused", "command_failed");
  } else {
    const stdout = claudeSuccessfulStdout(input.tool_response);
    if (stdout === undefined || !await stageHookReadOutput(call, stdout)) {
      await discardHookRead(call);
      await observeHookRead(call, "refused", stdout === undefined ? "unsupported_producer_or_shape" : "output_not_eligible");
    } else await observeHookRead(call, "staged", "candidate_staged");
  }
}

/** Claude Code 2.1.261 foreground Bash success shape, pinned by captured fixtures. */
export function claudeSuccessfulStdout(value: unknown): string | undefined {
  if (!object(value) || typeof value.stdout !== "string" || value.stderr !== "" ||
      value.interrupted !== false || value.isImage !== false || value.noOutputExpected !== false ||
      Object.keys(value).some((key) => !["stdout", "stderr", "interrupted", "isImage", "noOutputExpected"].includes(key))) return undefined;
  return value.stdout;
}

/** Serialized model text, or one unambiguous text content block. */
export function claudeModelText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = value[0];
  return object(block) && block.type === "text" && typeof block.text === "string" &&
    Object.keys(block).every((key) => key === "type" || key === "text") ? block.text : undefined;
}

function options(actor: ClaudeReadActor, input: Record<string, unknown>): HookReadOptions {
  return { ...actor, toolName: input.tool_name, toolUseId: input.tool_use_id, toolInput: input.tool_input };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
