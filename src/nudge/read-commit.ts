import { stableStringify } from "../core/stable-json.js";
import { readTurnRecordPageSnapshot, selectTurnText, ReaderTurnSearchIncompleteError, ReaderTurnNotFoundError } from "../reader/record-page.js";
import { feedAvailabilityFailure } from "../core/feed-availability.js";
import type { ReaderTurnSummary } from "../reader/types.js";
import { READ_DELIVERY_SCHEMA, fullContextAttention, peerInEpoch } from "./read-output.js";
import { readQueryHash, type ReadQuery } from "./read-query.js";
import {
  parseNudgeReadState, readContentHash, readRecordHash, ReadCoverageCapacityError,
  READ_OUTPUT_CEILING_BYTES, type NudgePendingRead, type NudgeReadCoverage,
} from "./read-state.js";
import { resolveHookRead, type HookReadOptions, type HookReadInvocation } from "./read-invocation.js";
import { currentDeliveryTurn, withHookCursor } from "./unread.js";
import { previewReadCoverage, readCoverageFits } from "./read-preview.js";
import { nudgeCursorFits } from "./store.js";
import type { NudgeCursorV3 } from "./types.js";

interface DeliveredEnvelope {
  readonly text: string;
  readonly body: Record<string, unknown>;
  readonly coverage: readonly NudgeReadCoverage[];
}

/** Parse only an entire canonical CLI envelope, allowing its one transport newline. */
export function parseDeliveredEnvelope(text: string, query: ReadQuery, nonce: string): DeliveredEnvelope | undefined {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (Buffer.byteLength(normalized) + 1 > READ_OUTPUT_CEILING_BYTES) return undefined;
  try {
    const output: unknown = JSON.parse(normalized);
    if (!object(output) || !exactKeys(output, ["byte_budget", "utf8_bytes", "value"]) ||
        stableStringify(output) !== normalized || output.byte_budget !== query.byte_budget ||
        output.utf8_bytes !== Buffer.byteLength(normalized) || Number(output.utf8_bytes) + 1 > query.byte_budget ||
        !object(output.value)) return undefined;
    const { delivery, ...body } = output.value;
    if (!object(delivery) || !exactKeys(delivery, [
      "schema", "eligible", "query_sha256", "projection_sha256", "recipient", "nonce", "coverage",
    ]) || delivery.schema !== READ_DELIVERY_SCHEMA || delivery.eligible !== true || delivery.nonce !== nonce ||
        delivery.query_sha256 !== readQueryHash(query) ||
        stableStringify(delivery.recipient) !== stableStringify(query.recipient) ||
        delivery.projection_sha256 !== readContentHash(stableStringify(body))) return undefined;
    const state = parseNudgeReadState({ pending: [], coverage: delivery.coverage, outside_window: false }, query.recipient!.provider, undefined);
    if (state.coverage.length === 0) return undefined;
    return { text: normalized, body, coverage: state.coverage };
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return undefined;
    throw error;
  }
}

/** A terminal hook stages candidate output; the provider must still prove success and model delivery. */
export async function stageHookReadOutput(options: HookReadOptions, stdout: string): Promise<boolean> {
  const invocation = await resolveHookRead(options);
  if (invocation === undefined) return false;
  const now = options.now ?? new Date();
  const result = await withHookCursor<boolean>(options, async (scan) => {
    const state = scan.cursor.state;
    const pending = matchingPending(state, invocation, options, now);
    if (pending === undefined) return { result: false };
    const output = parseDeliveredEnvelope(stdout, invocation.query, pending.nonce);
    if (output === undefined) return { result: false };
    if (pending.output !== undefined) return { result: pending.output === output.text };
    const next = {
        ...state,
        reads: { ...state.reads, pending: state.reads.pending.map((entry) =>
          entry.nonce === pending.nonce ? { ...entry, output: output.text } : entry) },
        updated_at: now.toISOString(),
    };
    return nudgeCursorFits(next) ? { state: next, result: true } : { result: false };
  });
  return result === true;
}

export interface HookReadCommit {
  readonly committed: boolean;
  readonly advanced: boolean;
  readonly unread_count?: number;
  readonly coverage_incomplete?: true;
  readonly reason?: "coverage_capacity" | "feed_unavailable";
}

/**
 * Called only after the provider proves successful completion and supplies its
 * model-facing text. A matching staged terminal result is additionally required.
 */
export async function commitHookReadOutput(options: HookReadOptions, modelText: string): Promise<HookReadCommit> {
  const invocation = await resolveHookRead(options);
  if (invocation === undefined) return { committed: false, advanced: false };
  const now = options.now ?? new Date();
  const result = await withHookCursor<HookReadCommit>(options, async (scan) => {
    const state = scan.cursor.state;
    const pending = matchingPending(state, invocation, options, now);
    if (pending?.output === undefined) return { result: { committed: false, advanced: false } };
    const envelope = parseDeliveredEnvelope(modelText, invocation.query, pending.nonce);
    if (envelope === undefined || envelope.text !== pending.output) {
      return { result: { committed: false, advanced: false } };
    }
    let verified: boolean;
    try { verified = await verifyDeliveredCoverage(invocation.query, envelope); }
    catch (error: unknown) {
      const first = envelope.coverage[0]!;
      if (!(error instanceof ReaderTurnSearchIncompleteError) &&
          !(error instanceof ReaderTurnNotFoundError) &&
          feedAvailabilityFailure({ provider: first.provider, sessionId: first.session_id }, error) === undefined) throw error;
      verified = false;
    }
    if (!verified) return { result: { committed: false, advanced: false } };
    const refused = () => ({
      state: { ...state, reads: { ...state.reads, pending: state.reads.pending.filter((entry) => entry.nonce !== pending.nonce) } },
      result: { committed: false, advanced: false, reason: "coverage_capacity" } as const,
    });
    let preview;
    try { preview = await previewReadCoverage(options, state, envelope.coverage); }
    catch (error: unknown) {
      if (!(error instanceof ReadCoverageCapacityError)) throw error;
      return refused();
    }
    if (preview.selected_feed_unavailable) return {
      result: { committed: false, advanced: false, reason: "feed_unavailable" },
    };
    const reads = { ...preview.state.reads, pending: preview.state.reads.pending.filter((entry) => entry.nonce !== pending.nonce) };
    if (!preview.advanced) {
      return {
        state: { ...preview.state, reads },
        result: { committed: true, advanced: false, unread_count: preview.unread_count,
          ...(preview.coverage_incomplete ? { coverage_incomplete: true as const } : {}) },
      };
    }
    const revision = state.cursor_revision + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError("nudge cursor revision overflow");
    const next: NudgeCursorV3 = {
      ...preview.state,
      reads: {
        ...reads,
        outside_window: (preview.unread_count > 0 || preview.coverage_incomplete) &&
          (invocation.query.kind === "context" || state.reads.outside_window),
        informed_turn: currentDeliveryTurn(state, options.turn),
      },
      cursor_revision: revision, markers: {},
      delivery: { highest_unread_count: 0 }, updated_at: now.toISOString(),
    };
    if (!readCoverageFits(next, state, preview.recovery)) return refused();
    return {
      state: next,
      result: { committed: true, advanced: true, unread_count: preview.unread_count,
        ...(preview.coverage_incomplete ? { coverage_incomplete: true as const } : {}) },
    };
  });
  return "status" in result ? { committed: false, advanced: false } : result;
}

/** Remove only this failed native invocation; failure never changes delivery history. */
export async function discardHookRead(options: HookReadOptions): Promise<void> {
  if (typeof options.toolUseId !== "string") return;
  await withHookCursor(options, async (scan) => {
    const state = scan.cursor.state;
    const turn = currentDeliveryTurn(state, options.turn);
    const pending = state.reads.pending.filter((entry) =>
      entry.tool_use_id !== options.toolUseId || stableStringify(entry.turn) !== stableStringify(turn));
    return pending.length === state.reads.pending.length ? { result: undefined } : {
      state: { ...state, reads: { ...state.reads, pending } }, result: undefined,
    };
  });
}

function matchingPending(
  state: NudgeCursorV3, invocation: HookReadInvocation, options: HookReadOptions, now: Date,
): NudgePendingRead | undefined {
  const recipient = invocation.query.recipient!;
  if (state.provider !== recipient.provider || state.session_id !== recipient.session_id ||
      state.workstream_id !== recipient.workstream_id || state.membership_from !== recipient.membership_from) return undefined;
  const turn = currentDeliveryTurn(state, options.turn);
  return state.reads.pending.find((entry) => entry.tool_use_id === invocation.toolUseId &&
    entry.command === invocation.command && entry.tool_input_sha256 === invocation.toolInputHash &&
    entry.query_sha256 === readQueryHash(invocation.query) && entry.project_root === invocation.query.project_root &&
    Date.parse(entry.created_at) <= now.getTime() && Date.parse(entry.expires_at) > now.getTime() &&
    stableStringify(entry.turn) === stableStringify(turn));
}

async function verifyDeliveredCoverage(query: ReadQuery, output: DeliveredEnvelope): Promise<boolean> {
  const body = output.body;
  if (body.schema !== (query.kind === "context" ? "barbaro.reader.context.v1" : "barbaro.reader.turn.v1")) return false;
  if (query.kind === "turn" && output.coverage.length !== 1) return false;
  for (const entry of output.coverage) {
    const { turn, projection } = await readTurnRecordPageSnapshot(query.project_root, {
      turnId: entry.turn_id, field: query.kind === "turn" ? query.field! : entry.field,
      byteBudget: query.byte_budget, maxFileBytes: query.max_file_bytes, maxRecordBytes: query.max_record_bytes,
      workstreamId: query.workstream_id!,
      ...(query.kind === "turn" && query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    const selected = selectTurnText(turn, entry.field);
    const total = Buffer.byteLength(selected.text);
    if (!peerInEpoch(turn, query) || turn.provider !== entry.provider || turn.session_id !== entry.session_id ||
        readRecordHash(turn) !== entry.record_sha256 || !selected.present ||
        (entry.field !== "record" && entry.field !== (turn.response === undefined ? "request" : "response")) ||
        readContentHash(selected.text) !== entry.field_sha256 || total !== entry.total_bytes || entry.ranges.length !== 1) return false;
    const range = entry.ranges[0]!;
    if (query.kind === "context") {
      if (!object(body.turns) || !Array.isArray(body.turns.items)) return false;
      const summaries = body.turns.items.filter((value: unknown) => object(value) && value.turn_id === turn.turn_id);
      if (summaries.length !== 1 || range.start !== 0 || range.end !== total) return false;
      // The CLI produced this entire canonical body, but all attention metadata
      // and text are still checked against the current pinned canonical record.
      try { if (!fullContextAttention(summaries[0] as ReaderTurnSummary, turn)) return false; }
      catch (error: unknown) { if (error instanceof TypeError) return false; throw error; }
    } else {
      const page = projection.value;
      if (query.turn_id !== turn.turn_id || query.field !== entry.field || body.turn_id !== turn.turn_id ||
          body.provider !== turn.provider || body.session_id !== turn.session_id || body.workstream_id !== turn.workstream_id ||
          body.agent_id !== turn.agent_id || body.outcome !== turn.outcome || body.record_sha256 !== entry.record_sha256 ||
          body.field !== entry.field || body.present !== true || body.encoding !== "utf-8" ||
          body.representation !== selected.representation || body.sha256 !== entry.field_sha256 || body.total_utf8_bytes !== total ||
          !object(body.range) || stableStringify(body.range) !== stableStringify(range) || range.start !== page.range.start || range.end > page.range.end ||
          body.complete !== (range.end === total) || typeof body.text !== "string") return false;
      const bytes = Buffer.from(selected.text).subarray(range.start, range.end);
      if (bytes.toString("utf8") !== body.text || Buffer.byteLength(body.text) !== bytes.length) return false;
      const content = entry.field === "request" ? turn.request : entry.field === "response" ? turn.response : undefined;
      if (content !== undefined) {
        const { text: _text, ...metadata } = content;
        if (!object(body.content_metadata) || stableStringify(body.content_metadata) !== stableStringify(metadata)) return false;
      }
    }
  }
  return true;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
