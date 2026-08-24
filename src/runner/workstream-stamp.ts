import {
  participationMemberships,
  SessionParticipationStore,
  type ParticipatingProvider,
  type SessionWorkstreamMembership,
} from "../hooks/participation.js";
import type {
  BarbaroEvidenceV1,
  BarbaroTurnV1,
} from "../contracts/v1.js";

/**
 * The append-only workstream history used to stamp one session's records.
 *
 * Resolved by the publishing runner from the consent record and never
 * supplied by a caller: a hook-driven ingest and a manual
 * `barbaro <provider> ingest` of the same session must produce identical
 * bytes, or `appendUniqueJsonl` reports a conflict. Each stamp is a pure
 * function of this log and the record's own timestamp.
 */
export async function resolveSessionMemberships(
  projectRoot: string,
  provider: ParticipatingProvider,
  nativeSessionId: string,
): Promise<readonly SessionWorkstreamMembership[]> {
  const participation = await new SessionParticipationStore(projectRoot).read(
    provider,
    nativeSessionId,
  );
  return participation === undefined ? [] : participationMemberships(participation);
}

/** Stamp turns by when they started. */
export function stampTurnsByMembership(
  turns: readonly BarbaroTurnV1[],
  memberships: readonly SessionWorkstreamMembership[],
): BarbaroTurnV1[] {
  return stampByTimestamp(turns, memberships, (turn) => turn.started_at);
}

/** Stamp evidence independently by when that evidence occurred. */
export function stampEvidenceByMembership(
  evidence: readonly BarbaroEvidenceV1[],
  memberships: readonly SessionWorkstreamMembership[],
): BarbaroEvidenceV1[] {
  return stampByTimestamp(evidence, memberships, (record) => record.occurred_at);
}

function stampByTimestamp<T extends object>(
  records: readonly T[],
  memberships: readonly SessionWorkstreamMembership[],
  timestampOf: (record: T) => string,
): T[] {
  return records.map((record) => {
    const timestamp = Date.parse(timestampOf(record));
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("record timestamp must be a valid date");
    }
    let workstreamId: string | undefined;
    for (const membership of memberships) {
      if (Date.parse(membership.from) > timestamp) break;
      workstreamId = membership.workstream_id;
    }
    // Normalizers do not supply a stamp, but stripping one here makes this
    // function authoritative if a caller ever hands it an enriched record.
    const { workstream_id: _prior, ...unstamped } = record as T & {
      readonly workstream_id?: string;
    };
    return {
      ...unstamped,
      ...(workstreamId === undefined ? {} : { workstream_id: workstreamId }),
    } as T;
  });
}
