export interface CodexRolloutEnvelope {
  readonly timestamp: string;
  readonly ordinal?: number;
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: unknown;
  readonly extra: Readonly<Record<string, unknown>>;
}

export type CodexEnvelopeResult =
  | { readonly ok: true; readonly envelope: CodexRolloutEnvelope }
  | { readonly ok: false; readonly reason: string };

/**
 * Decode only the stable outer rollout envelope. Unknown root types, payload
 * types, and fields remain valid; provider-specific decoding happens later.
 */
export function decodeCodexEnvelope(value: unknown): CodexEnvelopeResult {
  if (!isObject(value)) {
    return { ok: false, reason: "rollout line is not an object" };
  }

  if (
    typeof value.timestamp !== "string" ||
    !isRfc3339DateTime(value.timestamp)
  ) {
    return { ok: false, reason: "rollout timestamp is missing or invalid" };
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    return { ok: false, reason: "rollout type is missing or invalid" };
  }
  if (!("payload" in value)) {
    return { ok: false, reason: "rollout payload is missing" };
  }
  if (
    value.ordinal !== undefined &&
    (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0)
  ) {
    return { ok: false, reason: "rollout ordinal is invalid" };
  }

  const extra: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key !== "timestamp" &&
      key !== "ordinal" &&
      key !== "type" &&
      key !== "payload" &&
      key !== "metadata"
    ) {
      extra[key] = entry;
    }
  }

  const base = {
    timestamp: value.timestamp,
    type: value.type,
    payload: value.payload,
    extra,
  };
  return {
    ok: true,
    envelope: {
      ...base,
      ...(typeof value.ordinal === "number" ? { ordinal: value.ordinal } : {}),
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    },
  };
}

function isRfc3339DateTime(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}
