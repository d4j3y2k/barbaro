import type { BarbaroTurnV1 } from "../contracts/v1.js";
import { stableStringify } from "../core/stable-json.js";
import { ReaderByteBudgetTooSmallError, wrapReaderProjection } from "../reader/budget.js";
import { readProjectContextSnapshot } from "../reader/store.js";
import { readTurnRecordPageSnapshot, selectTurnText } from "../reader/record-page.js";
import type { ReaderProjection, ReaderTurnSummary } from "../reader/types.js";
import { MAX_NUDGE_CURSOR_BYTES, NudgeCursorStateStore, nudgeCursorBytes, nudgeCursorFits } from "./store.js";
import { NUDGE_CURSOR_SCHEMA, type NudgeCursorV3 } from "./types.js";
import {
  READ_OUTPUT_CEILING_BYTES, readContentHash, readRecordHash,
  MAX_PENDING_READS, ReadCoverageCapacityError,
  type NudgePendingRead, type NudgeReadCoverage,
} from "./read-state.js";
import { readQueryHash, type ReadQuery, type ReadRecipient } from "./read-query.js";
import { previewReadCoverage, readCoverageFits } from "./read-preview.js";
import { readScopeFlags } from "./read-guidance.js";
import { inspectUnreadPeerTurns, rescanHookReadCursor } from "./unread.js";

export const READ_DELIVERY_SCHEMA = "barbaro.read-delivery.v1" as const;

export type ReadObserverReason =
  | "recipient_required" | "foreign_scope" | "no_invocation" | "ambiguous_invocation"
  | "output_ceiling" | "no_attention_coverage" | "pending_capacity" | "coverage_capacity" | "feed_unavailable";

export interface ReadDeliveryDescriptor {
  readonly schema: typeof READ_DELIVERY_SCHEMA;
  readonly eligible: boolean;
  readonly reason?: ReadObserverReason;
  readonly query_sha256: string;
  readonly projection_sha256: string;
  readonly recipient?: ReadRecipient;
  readonly nonce?: string;
  readonly coverage: readonly NudgeReadCoverage[];
  /** Observer-only recovery instructions; never part of an eligible receipt. */
  readonly recovery_hint?: string;
  readonly recovery_turn_id?: string;
}

export type ReadOutput = ReaderProjection<Record<string, unknown> & {
  readonly delivery: ReadDeliveryDescriptor;
}>;

/** Generate a bounded read result. Cursor state is opened read-only, never reserved or committed here. */
export async function createReadOutput(query: ReadQuery, now = new Date()): Promise<ReadOutput> {
  const authority = await findReadAuthority(query, now);
  // Context's existing-file window cannot see a feed that disappeared after a
  // prior cursor checkpoint. Expose the recipient's independent scan as well.
  const unread = query.kind === "context" && query.recipient !== undefined &&
    !query.all_workstreams && query.workstream_id === query.recipient.workstream_id
    ? await inspectUnreadPeerTurns({ projectRoot: query.project_root,
        provider: query.recipient.provider, sessionId: query.recipient.session_id })
    : undefined;
  // Re-render to reserve descriptor overhead inside the requested byte budget.
  // Each attempt binds its descriptor to that same canonical reader snapshot.
  let bodyBudget = query.byte_budget;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const body = await readBody(query, bodyBudget);
    const { coverage } = body;
    const value = { ...body.value,
      ...(unread?.status === "ready" && unread.coverage?.state === "incomplete"
        ? { unread: { count: unread.unread_count, count_is_lower_bound: true, coverage: unread.coverage } }
        : {}),
    };
    const reason = authority.reason ?? (coverage.length === 0 ? "no_attention_coverage" : undefined);
    let descriptor: ReadDeliveryDescriptor = {
      schema: READ_DELIVERY_SCHEMA,
      eligible: reason === undefined,
      ...(reason === undefined ? { nonce: authority.pending!.nonce } : { reason }),
      query_sha256: readQueryHash(query),
      projection_sha256: readContentHash(stableStringify(value)),
      ...(query.recipient === undefined ? {} : { recipient: query.recipient }),
      coverage: reason === undefined ? coverage : [],
    };
    const withDescriptor = () => ({ ...value, delivery: descriptor });
    // Measure before enforcing the user budget so an oversized read explicitly
    // loses authority, even if its descriptor would otherwise fit.
    let result = measureOutput(withDescriptor(), query.byte_budget);
    if (query.byte_budget > READ_OUTPUT_CEILING_BYTES &&
        result.utf8_bytes + 1 > READ_OUTPUT_CEILING_BYTES) {
      const { nonce: _nonce, ...observer } = descriptor;
      descriptor = { ...observer, eligible: false, reason: "output_ceiling", coverage: [] };
    }
    try {
      result = wrapReaderProjection(withDescriptor(), query.byte_budget);
      if (result.utf8_bytes + 1 <= query.byte_budget) {
        if (descriptor.eligible) {
          const capacity = await checkReadCapacity(query, authority.cursor!, authority.pending!, result, coverage, now);
          if (capacity !== undefined) {
            const { nonce: _nonce, ...observer } = descriptor;
            descriptor = { ...observer, ...capacity, eligible: false, coverage: [] };
            result = wrapReaderProjection(withDescriptor(), query.byte_budget);
          }
        }
        if (result.utf8_bytes + 1 <= query.byte_budget) return result;
      }
      bodyBudget -= 1;
    } catch (error: unknown) {
      if (!(error instanceof ReaderByteBudgetTooSmallError)) throw error;
      bodyBudget -= error.requiredBytes - query.byte_budget + 1;
    }
    if (bodyBudget <= 0) break;
  }
  throw new ReaderByteBudgetTooSmallError(query.byte_budget, query.byte_budget + 1);
}

/** Measure with the actual declared budget, including its digit count. */
function measureOutput(value: ReadOutput["value"], byteBudget: number): ReadOutput {
  let result: ReadOutput = { byte_budget: byteBudget, utf8_bytes: 0, value };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = Buffer.byteLength(stableStringify(result));
    if (bytes === result.utf8_bytes) return result;
    result = { ...result, utf8_bytes: bytes };
  }
  throw new Error("Read output byte-size metadata did not converge");
}

/** An ambiguous pair of identical CLI reads cannot borrow one another's nonce. */
export async function findReadAuthority(query: ReadQuery, now: Date): Promise<{
  readonly reason?: ReadObserverReason;
  readonly pending?: NudgePendingRead;
  readonly cursor?: NudgeCursorV3;
}> {
  const recipient = query.recipient;
  if (recipient === undefined) return { reason: "recipient_required" };
  if (query.all_workstreams || query.workstream_id !== recipient.workstream_id) return { reason: "foreign_scope" };
  const current = await new NudgeCursorStateStore(query.project_root).read(recipient.provider, recipient.session_id);
  if (current?.schema !== NUDGE_CURSOR_SCHEMA ||
      current.workstream_id !== recipient.workstream_id || current.membership_from !== recipient.membership_from) {
    return { reason: "no_invocation" };
  }
  const hash = readQueryHash(query);
  const matches = current.reads.pending.filter((pending) =>
    pending.project_root === query.project_root && pending.query_sha256 === hash &&
    Date.parse(pending.created_at) <= now.getTime() && Date.parse(pending.expires_at) > now.getTime() &&
    (pending.turn.kind !== "claude" || pending.turn.generation === current.claude_turn_generation));
  return matches.length === 1 ? { pending: matches[0]!, cursor: current }
    : { reason: matches.length > 1 ? "ambiguous_invocation"
      : current.reads.pending.filter((entry) => Date.parse(entry.expires_at) > now.getTime()).length >= MAX_PENDING_READS ||
        nudgeCursorBytes(current) > MAX_NUDGE_CURSOR_BYTES - 32 * 1024
        ? "pending_capacity" : "no_invocation" };
}

async function checkReadCapacity(
  query: ReadQuery, current: NudgeCursorV3, pending: NudgePendingRead,
  output: ReadOutput, coverage: readonly NudgeReadCoverage[], now: Date,
): Promise<Pick<ReadDeliveryDescriptor, "reason" | "recovery_hint" | "recovery_turn_id"> | undefined> {
  const recipient = query.recipient!;
  const staged = { ...current, updated_at: now.toISOString(), reads: { ...current.reads,
    pending: current.reads.pending.map((entry) => entry.nonce === pending.nonce ? { ...entry, output: stableStringify(output) } : entry),
  } };
  if (!nudgeCursorFits(staged)) return {
    reason: "pending_capacity", recovery_hint: "Finish outstanding read invocations, then retry one foreground read; pending reservations expire after five minutes.",
  };
  const options = { projectRoot: query.project_root, provider: recipient.provider, sessionId: recipient.session_id };
  let recoveryTurnId: string | undefined;
  try {
    const preview = await previewReadCoverage(options, current, coverage);
    if (preview.selected_feed_unavailable) return {
      reason: "feed_unavailable",
      recovery_hint: "This output is observer-only: delivery scans are bounded to 64 MiB per feed and 8 MiB per record. Restore feed availability before acknowledgement; larger observer reader limits do not widen delivery authority.",
    };
    recoveryTurnId = preview.recovery_turn_id;
    const next = { ...preview.state, updated_at: now.toISOString(),
      cursor_revision: current.cursor_revision + (preview.advanced ? 1 : 0),
      reads: { ...preview.state.reads,
        pending: preview.state.reads.pending.filter((entry) => entry.nonce !== pending.nonce),
        ...(preview.advanced ? { informed_turn: pending.turn } : {}),
      },
    };
    if (readCoverageFits(next, current, preview.recovery)) return undefined;
  } catch (error: unknown) {
    if (!(error instanceof ReadCoverageCapacityError)) throw error;
    recoveryTurnId = (await rescanHookReadCursor(options, current)).firstUnread?.turn_id;
  }
  const scope = readScopeFlags(recipient.provider, recipient.session_id, recipient.workstream_id);
  return {
    reason: "coverage_capacity",
    ...(recoveryTurnId === undefined ? {} : { recovery_turn_id: recoveryTurnId }),
    recovery_hint: `Read the oldest unread gap with barbaro read turn show ${recoveryTurnId ?? "<turn_id>"} --field record ${scope}; start at the first page and follow every next_cursor in order to free coverage capacity.`,
  };
}

async function readBody(query: ReadQuery, byteBudget: number): Promise<{
  readonly value: Record<string, unknown>;
  readonly coverage: readonly NudgeReadCoverage[];
}> {
  const limits = { maxFileBytes: query.max_file_bytes, maxRecordBytes: query.max_record_bytes };
  const scope = query.workstream_id === undefined ? {} : { workstreamId: query.workstream_id };
  if (query.kind === "context") {
    const { projection, turns } = await readProjectContextSnapshot(query.project_root, {
      ...limits, ...scope, byteBudget, turnsPerSession: query.turns_per_session!, preferTurns: true,
      ...(query.recipient === undefined || query.all_workstreams || query.workstream_id !== query.recipient.workstream_id ? {} : {
        attentionRecipient: { provider: query.recipient.provider, sessionId: query.recipient.session_id, membershipFrom: query.recipient.membership_from },
      }),
    });
    const coverage = projection.value.turns.items.flatMap((summary) => {
      const candidates = turns.filter((turn) => turn.provider === summary.provider &&
        turn.session_id === summary.session_id && turn.turn_id === summary.turn_id);
      if (candidates.length !== 1) return [];
      const turn = candidates[0]!;
      if (!fullContextAttention(summary, turn) || !peerInEpoch(turn, query)) return [];
      const field = turn.response === undefined ? "request" : "response";
      const text = selectTurnText(turn, field).text;
      return [coverageFor(turn, field, text, { start: 0, end: Buffer.byteLength(text) })];
    });
    return { value: { ...projection.value }, coverage };
  }
  const { projection, turn } = await readTurnRecordPageSnapshot(query.project_root, {
    ...limits, ...scope, byteBudget, turnId: query.turn_id!, field: query.field!,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  const page = projection.value;
  const field = page.field;
  const content = field === "request" ? turn.request : field === "response" ? turn.response : undefined;
  const metadata = content === undefined ? undefined : (({ text: _text, ...rest }) => rest)(content);
  const value = {
    ...page, record_sha256: readRecordHash(turn), agent_id: turn.agent_id, outcome: turn.outcome,
    ...(metadata === undefined ? {} : { content_metadata: metadata }),
  };
  const attentionField = turn.response === undefined ? "request" : "response";
  return {
    value,
    coverage: page.present && peerInEpoch(turn, query) && (field === "record" || field === attentionField)
      ? [coverageFor(turn, field, selectTurnText(turn, field).text, page.range)] : [],
  };
}

export function fullContextAttention(summary: ReaderTurnSummary, turn: BarbaroTurnV1): boolean {
  const canonical = turn.response ?? turn.request;
  const shown = turn.response === undefined ? summary.request : summary.response;
  return summary.provider === turn.provider && summary.session_id === turn.session_id &&
    summary.turn_id === turn.turn_id && summary.workstream_id === turn.workstream_id &&
    summary.agent_id === turn.agent_id && summary.outcome === turn.outcome &&
    shown !== undefined && !shown.truncated.projection && shown.text === canonical.text &&
    shown.truncated.canonical === canonical.truncated && shown.fidelity === canonical.fidelity &&
    stableStringify(shown.redactions) === stableStringify(canonical.redactions) &&
    shown.utf8_bytes.shown === Buffer.byteLength(canonical.text) &&
    shown.utf8_bytes.canonical === Buffer.byteLength(canonical.text) &&
    shown.utf8_bytes.original === (canonical.original_utf8_bytes ?? Buffer.byteLength(canonical.text));
}

export function peerInEpoch(turn: BarbaroTurnV1, query: ReadQuery): boolean {
  const recipient = query.recipient;
  return recipient !== undefined &&
    !(turn.provider === recipient.provider && turn.session_id === recipient.session_id) &&
    turn.workstream_id === recipient.workstream_id &&
    Date.parse(turn.ended_at) > Date.parse(recipient.membership_from);
}

function coverageFor(
  turn: BarbaroTurnV1, field: NudgeReadCoverage["field"], text: string,
  range: { readonly start: number; readonly end: number },
): NudgeReadCoverage {
  return {
    provider: turn.provider, session_id: turn.session_id, turn_id: turn.turn_id,
    record_sha256: readRecordHash(turn), field, field_sha256: readContentHash(text),
    total_bytes: Buffer.byteLength(text), ranges: [range],
  };
}
