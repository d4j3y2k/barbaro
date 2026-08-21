import { stableStringify } from "../core/stable-json.js";

import type { ReaderProjection } from "./types.js";

export class ReaderByteBudgetTooSmallError extends RangeError {
  readonly byteBudget: number;
  readonly requiredBytes: number;

  constructor(byteBudget: number, requiredBytes: number) {
    super(
      `Reader byte budget ${byteBudget} cannot hold the minimum ${requiredBytes}-byte projection`,
    );
    this.name = "ReaderByteBudgetTooSmallError";
    this.byteBudget = byteBudget;
    this.requiredBytes = requiredBytes;
  }
}

export function assertReaderByteBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("byteBudget must be a positive safe integer");
  }
}

export function assertReaderNonNegativeInteger(
  value: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function assertReaderPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate only at Unicode-code-point boundaries, never in a UTF-8 sequence. */
export function truncateReaderUtf8(value: string, maximumBytes: number): string {
  assertReaderNonNegativeInteger(maximumBytes, "maximumBytes");
  if (utf8Bytes(value) <= maximumBytes) return value;

  let used = 0;
  let result = "";
  for (const character of value) {
    const width = utf8Bytes(character);
    if (used + width > maximumBytes) break;
    result += character;
    used += width;
  }
  return result;
}

export function stableJsonUtf8Bytes(value: unknown): number {
  return utf8Bytes(stableStringify(value));
}

/**
 * Add exact size metadata and enforce the caller's total serialized byte cap.
 * The small fixed-point loop accounts for the digits in `utf8_bytes` itself.
 */
export function wrapReaderProjection<T>(
  value: T,
  byteBudget: number,
): ReaderProjection<T> {
  assertReaderByteBudget(byteBudget);
  let reportedBytes = 0;
  let projection: ReaderProjection<T> = {
    byte_budget: byteBudget,
    utf8_bytes: reportedBytes,
    value,
  };

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const actualBytes = stableJsonUtf8Bytes(projection);
    if (actualBytes === reportedBytes) {
      if (actualBytes > byteBudget) {
        throw new ReaderByteBudgetTooSmallError(byteBudget, actualBytes);
      }
      return projection;
    }
    reportedBytes = actualBytes;
    projection = {
      byte_budget: byteBudget,
      utf8_bytes: reportedBytes,
      value,
    };
  }
  throw new Error("Reader projection byte-size metadata did not converge");
}

export function readerProjectionFits(value: unknown, byteBudget: number): boolean {
  try {
    wrapReaderProjection(value, byteBudget);
    return true;
  } catch (error: unknown) {
    if (error instanceof ReaderByteBudgetTooSmallError) return false;
    throw error;
  }
}

/** Return the greatest integer in [0, maximum] accepted by a monotonic test. */
export function maximizeReaderBudget(
  maximum: number,
  accepts: (candidate: number) => boolean,
): number {
  assertReaderNonNegativeInteger(maximum, "maximum");
  let low = 0;
  let high = maximum;
  let best = accepts(0) ? 0 : -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (accepts(middle)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
