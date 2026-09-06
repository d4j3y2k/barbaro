export const ACTIVE_LEASE_SCHEMA = "barbaro.active.v1" as const;

export type ActiveLeaseState = "working" | "waiting" | "blocked" | "idle";

export type ActiveActionKind =
  | "file_change"
  | "command"
  | "test"
  | "tool"
  | "other";

export type ContentFidelity =
  | "verbatim"
  | "normalized"
  | "excerpt"
  | "redacted";

export interface ContentRedaction {
  readonly kind: string;
  readonly count: number;
}

export interface ActiveContent {
  readonly text: string;
  readonly fidelity: ContentFidelity;
  readonly truncated: boolean;
  readonly original_utf8_bytes?: number;
  readonly redactions: readonly ContentRedaction[];
}

export interface ActiveCurrentAction {
  readonly kind: ActiveActionKind;
  readonly tool_name?: string;
  readonly path?: string;
  readonly command?: ActiveContent;
  readonly started_at?: string;
}

export interface ActiveWriteClaim {
  readonly path: string;
  readonly mode: "write";
  readonly confidence: "exact" | "inferred";
}

export interface ActiveSourceRef {
  readonly trace_id: string;
  readonly trace_path?: string;
  readonly line_start?: number;
  readonly line_end?: number;
  readonly native_record_ids?: readonly string[];
}

export type ActiveExtensions = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

export interface ActiveLeaseV1 {
  readonly schema: typeof ACTIVE_LEASE_SCHEMA;
  readonly lease_id: string;
  readonly provider: string;
  readonly session_id: string;
  /** The workstream the publishing session belongs to; absent when unscoped. */
  readonly workstream_id?: string;
  readonly turn_id?: string;
  readonly agent_id: string;
  readonly state: ActiveLeaseState;
  readonly intent?: ActiveContent;
  readonly current_action?: ActiveCurrentAction;
  readonly claims: readonly ActiveWriteClaim[];
  readonly unknown_write_scope: boolean;
  readonly revision: number;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly source_refs?: readonly ActiveSourceRef[];
  readonly extensions?: ActiveExtensions;
}

export interface ActiveActorKey {
  readonly provider: string;
  readonly session_id: string;
  readonly agent_id: string;
}

export interface ActiveLeaseIdentity extends ActiveActorKey {
  readonly lease_id: string;
  readonly workstream_id?: string;
  readonly turn_id?: string;
  readonly source_refs?: readonly ActiveSourceRef[];
  readonly extensions?: ActiveExtensions;
}

/**
 * A provider-neutral update. The store supplies the schema, revision, and
 * timestamps so concurrent callers cannot accidentally reuse a revision.
 */
export type ActiveLeaseUpdate = Omit<
  ActiveLeaseV1,
  "schema" | "revision" | "updated_at" | "expires_at"
>;

export type ActiveTime = Date | number | string;

/**
 * Outcome of an `update` decision: apply `write` with the next revision, or
 * leave the stored lease untouched and surface `ignore` to the caller.
 */
export type ActiveLeaseDecision =
  | { readonly write: ActiveLeaseUpdate }
  | { readonly ignore: string };

export interface ActiveLeaseUpdateOptions {
  /** Lease lifetime in milliseconds. It must be a positive finite integer. */
  ttlMs?: number;
  /** Injectable wall clock, primarily for deterministic adapters and tests. */
  now?: ActiveTime;
  /**
   * Compensate side effects performed by `decide` when the selected lease
   * cannot be validated or persisted. Runs while the actor lock is still held.
   * It is not called for an ignored decision or when `decide` itself throws.
   */
  onWriteFailure?: (error: unknown) => void | Promise<void>;
  /**
   * Run after persistence, before releasing the actor lock. A failure here
   * propagates but cannot undo the committed lease or invoke compensation.
   * Used when a dependent cursor decision must follow a successful write.
   */
  afterCommit?: (lease: ActiveLeaseV1) => void | Promise<void>;
  /**
   * Observe a lock cleanup failure after the selected lease was committed.
   * Callback failure is ignored because it cannot undo the durable result.
   */
  onLockReleaseFailure?: (error: unknown) => void | Promise<void>;
}

export interface ActiveLeaseUpdateResult {
  readonly lease?: ActiveLeaseV1;
  readonly ignored?: string;
}

export interface ActiveLeaseWriteOptions {
  /** Lease lifetime in milliseconds. It must be a positive finite integer. */
  ttlMs?: number;
  /** Injectable wall clock, primarily for deterministic adapters and tests. */
  now?: ActiveTime;
  /**
   * Compare-and-swap guard. Zero means that no actor snapshot may exist.
   * Supplying this value is how an out-of-order hook prevents a newer idle
   * tombstone from being replaced by stale activity.
   */
  expectedRevision?: number;
}

export interface ActiveLeaseStoreOptions {
  defaultTtlMs?: number;
  clock?: () => Date;
}

export interface ActiveLeaseListOptions {
  now?: ActiveTime;
  provider?: string;
  sessionId?: string;
  agentId?: string;
  onInvalid?: (path: string, error: unknown) => void;
}
