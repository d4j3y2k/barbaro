import { InputLimitError } from "./input-limit.js";

export type FeedAvailabilityReason =
  | "file_too_large" | "record_too_large" | "missing"
  | "permission_denied" | "io_unavailable";

export interface FeedAvailabilityFailure {
  readonly provider: string;
  readonly session_id: string;
  readonly reason: FeedAvailabilityReason;
  readonly code?: string;
  readonly maximum_bytes?: number;
}

export interface FeedReadCoverage {
  readonly state: "complete" | "incomplete";
  /** Feeds read successfully; unavailable feeds contribute no unread count. */
  readonly scanned_feed_files: number;
  readonly unavailable: {
    readonly items: readonly FeedAvailabilityFailure[];
    readonly shown: number;
    readonly total: number;
  };
}

const AVAILABILITY_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EMFILE", "ENFILE", "EIO", "ESTALE",
  "EBUSY", "ETIMEDOUT",
]);
export const MAX_FEED_AVAILABILITY_DETAILS = 8;

/** Never classify arbitrary RangeErrors, unsafe paths or corrupt state as availability. */
export function feedAvailabilityFailure(
  file: { readonly provider: string; readonly sessionId: string },
  error: unknown,
): FeedAvailabilityFailure | undefined {
  const identity = { provider: file.provider, session_id: file.sessionId };
  if (error instanceof InputLimitError) return {
    ...identity,
    reason: error.kind === "file" ? "file_too_large" : "record_too_large",
    maximum_bytes: error.maximumBytes,
  };
  if (!(error instanceof Error) || !("code" in error) ||
      typeof error.code !== "string" || !AVAILABILITY_CODES.has(error.code)) return undefined;
  return {
    ...identity,
    reason: error.code === "ENOENT" ? "missing"
      : error.code === "EACCES" || error.code === "EPERM" ? "permission_denied" : "io_unavailable",
    code: error.code,
  };
}

/** Fixed diagnostic memory; counts retain failures omitted from the sample. */
export class FeedCoverageTracker {
  #scanned = 0;
  #unavailable = 0;
  readonly #items: FeedAvailabilityFailure[] = [];

  scanned(): void { this.#scanned += 1; }

  unavailable(file: { readonly provider: string; readonly sessionId: string }, error: unknown): boolean {
    const failure = feedAvailabilityFailure(file, error);
    if (failure === undefined) return false;
    this.#unavailable += 1;
    if (this.#items.length < MAX_FEED_AVAILABILITY_DETAILS) this.#items.push(failure);
    return true;
  }

  value(): FeedReadCoverage {
    return {
      state: this.#unavailable === 0 ? "complete" : "incomplete",
      scanned_feed_files: this.#scanned,
      unavailable: { items: [...this.#items], shown: this.#items.length, total: this.#unavailable },
    };
  }
}

export function missingFeedError(): Error & { code: "ENOENT" } {
  return Object.assign(new Error("Canonical feed is no longer available"), { code: "ENOENT" as const });
}
