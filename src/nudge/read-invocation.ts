import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";

import { stableStringify } from "../core/stable-json.js";
import { currentDeliveryTurn, withHookCursor, type HookNudgeClaimOptions } from "./unread.js";
import {
  MAX_PENDING_READS, READ_INVOCATION_TTL_MS, readContentHash,
  type NudgePendingRead,
} from "./read-state.js";
import { readCommandArguments, readQueryHash, ReadUsageError, resolveReadQuery, type ReadQuery } from "./read-query.js";
import { nudgeCursorFits } from "./store.js";

export interface HookReadOptions extends Omit<HookNudgeClaimOptions, "marker"> {
  readonly toolName: unknown;
  readonly toolUseId: unknown;
  readonly toolInput: unknown;
}

export interface HookReadInvocation {
  readonly query: ReadQuery;
  readonly command: string;
  readonly toolUseId: string;
  readonly toolInputHash: string;
}

/** Resolve a single admitted foreground call; its query is checked again under the cursor lock. */
export async function resolveHookRead(options: HookReadOptions): Promise<HookReadInvocation | undefined> {
  if (options.toolName !== "Bash" && !(options.provider === "codex" && options.toolName === "exec")) return undefined;
  if (typeof options.toolUseId !== "string" || options.toolUseId.length === 0 || Buffer.byteLength(options.toolUseId) > 512) return undefined;
  const input = options.toolInput;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  // The pinned Codex Bash hook exposes exactly this canonical input. Unknown
  // shapes cannot be reconstructed faithfully for delayed trace reconciliation.
  if (options.provider === "codex" && Object.keys(input).some((key) => key !== "command")) return undefined;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || (input as Record<string, unknown>).run_in_background === true) return undefined;
  const encodedInput = stableStringify(input);
  if (Buffer.byteLength(encodedInput) > 8192) return undefined;
  const args = readCommandArguments(command, {
    PWD: options.projectRoot,
    [options.provider === "codex" ? "CODEX_SESSION_ID" : "CLAUDE_CODE_SESSION_ID"]: options.nativeSessionId,
  });
  if (args === undefined) return undefined;
  let query: ReadQuery;
  try { query = await resolveReadQuery(args, options.projectRoot); }
  catch (error: unknown) {
    if (error instanceof ReadUsageError) return undefined;
    throw error;
  }
  if (query.project_root !== await realpath(options.projectRoot) || query.all_workstreams ||
      query.recipient?.provider !== options.provider || query.workstream_id !== query.recipient.workstream_id) return undefined;
  return { query, command, toolUseId: options.toolUseId, toolInputHash: readContentHash(encodedInput) };
}

/** Reserve one hook-owned nonce before execution. No unread coverage is advanced. */
export interface HookReadReservation {
  readonly reserved: boolean;
  readonly reason?: "unrecognized" | "scope_changed" | "pending_capacity" | "replayed_tool_id";
}

export async function reserveHookRead(options: HookReadOptions): Promise<HookReadReservation> {
  const invocation = await resolveHookRead(options);
  if (invocation === undefined) return { reserved: false, reason: "unrecognized" };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("invalid read invocation time");
  const result = await withHookCursor<HookReadReservation>(options, async (scan) => {
    const recipient = invocation.query.recipient!;
    if (recipient.session_id !== scan.public.session_id || recipient.workstream_id !== scan.public.workstream_id ||
        recipient.membership_from !== scan.public.membership_from) {
      return { result: { reserved: false, reason: "scope_changed" } as const };
    }
    const state = scan.cursor.state;
    const turn = currentDeliveryTurn(state, options.turn);
    const pending = state.reads.pending.filter((entry) => Date.parse(entry.expires_at) > now.getTime());
    if (pending.some((entry) => entry.tool_use_id === invocation.toolUseId)) {
      return { result: { reserved: false, reason: "replayed_tool_id" } as const };
    }
    if (pending.length >= MAX_PENDING_READS) return { result: { reserved: false, reason: "pending_capacity" } as const };
    const entry: NudgePendingRead = {
      nonce: randomBytes(16).toString("hex"), tool_use_id: invocation.toolUseId, turn,
      project_root: invocation.query.project_root, command: invocation.command,
      query_sha256: readQueryHash(invocation.query), tool_input_sha256: invocation.toolInputHash,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + READ_INVOCATION_TTL_MS).toISOString(),
    };
    const next = { ...state, reads: { ...state.reads, pending: [...pending, entry] }, updated_at: now.toISOString() };
    if (!nudgeCursorFits(next)) return { result: { reserved: false, reason: "pending_capacity" } as const };
    return {
      state: next,
      result: { reserved: true } as const,
    };
  });
  return "status" in result ? { reserved: false, reason: "scope_changed" } : result;
}
