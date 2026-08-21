import { createHash } from "node:crypto";

export const BARBARO_ID_DOMAIN = "barbaro-id-v1";

export const BARBARO_ID_PREFIX = {
  session: "ses",
  turn: "turn",
  action: "act",
  evidence: "ev",
  lease: "lease",
} as const;

export type BarbaroIdType = keyof typeof BARBARO_ID_PREFIX;
export type BarbaroIdPart = string | null | undefined;
export type BarbaroTypedId<T extends BarbaroIdType = BarbaroIdType> =
  `${(typeof BARBARO_ID_PREFIX)[T]}_${string}`;

/**
 * Build the exact byte sequence described by the Barbaro v1 stable-ID
 * contract. A missing part is framed with a length of -1, while an empty part
 * is framed as 0:. Negative lengths can never collide with a UTF-8 byte
 * length.
 */
export function encodeTypedIdInput(
  type: BarbaroIdType,
  parts: readonly BarbaroIdPart[],
): Buffer {
  if (!Object.hasOwn(BARBARO_ID_PREFIX, type)) {
    throw new TypeError(`Unsupported Barbaro ID type: ${String(type)}`);
  }

  const framedParts = parts.map((part) => {
    if (part === null || part === undefined) {
      return Buffer.from("-1:", "ascii");
    }

    const bytes = Buffer.from(part, "utf8");
    return Buffer.concat([
      Buffer.from(`${bytes.byteLength}:`, "ascii"),
      bytes,
    ]);
  });

  const components: Buffer[] = [
    Buffer.from(BARBARO_ID_DOMAIN, "ascii"),
    Buffer.from([0]),
    Buffer.from(type, "ascii"),
  ];

  for (const framedPart of framedParts) {
    components.push(Buffer.from([0]), framedPart);
  }

  return Buffer.concat(components);
}

/** Create a deterministic Barbaro ID from provider-native identity parts. */
export function createTypedId<T extends BarbaroIdType>(
  type: T,
  parts: readonly BarbaroIdPart[],
): BarbaroTypedId<T> {
  const digest = createHash("sha256")
    .update(encodeTypedIdInput(type, parts))
    .digest()
    .subarray(0, 16)
    .toString("hex");

  return `${BARBARO_ID_PREFIX[type]}_${digest}` as BarbaroTypedId<T>;
}

export function createSessionId(
  provider: string,
  nativeSessionId: string,
): BarbaroTypedId<"session"> {
  return createTypedId("session", [provider, nativeSessionId]);
}

export function createTurnId(
  provider: string,
  nativeSessionId: string,
  actorId: string,
  nativeTurnKey: string,
): BarbaroTypedId<"turn"> {
  return createTypedId("turn", [
    provider,
    nativeSessionId,
    actorId,
    nativeTurnKey,
  ]);
}

export function createActionId(
  stableTurnId: string,
  stableSourceRecordIdentity: string,
  occurrenceIndex: number,
): BarbaroTypedId<"action"> {
  assertOccurrenceIndex(occurrenceIndex);
  return createTypedId("action", [
    stableTurnId,
    stableSourceRecordIdentity,
    String(occurrenceIndex),
  ]);
}

export function createEvidenceId(
  stableTurnId: string,
  stableSourceRecordIdentity: string,
  occurrenceIndex: number,
): BarbaroTypedId<"evidence"> {
  assertOccurrenceIndex(occurrenceIndex);
  return createTypedId("evidence", [
    stableTurnId,
    stableSourceRecordIdentity,
    String(occurrenceIndex),
  ]);
}

export function createLeaseId(
  provider: string,
  nativeSessionId: string,
  actorId: string,
): BarbaroTypedId<"lease"> {
  return createTypedId("lease", [provider, nativeSessionId, actorId]);
}

function assertOccurrenceIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("occurrenceIndex must be a non-negative safe integer");
  }
}
