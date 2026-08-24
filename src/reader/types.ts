import type {
  ContentFidelity,
  BarbaroActionOutcome,
  BarbaroRedaction,
  BarbaroTurnOutcome,
} from "../contracts/v1.js";

export const READER_CONTEXT_SCHEMA = "barbaro.reader.context.v1" as const;
export const READER_EVIDENCE_SCHEMA = "barbaro.reader.evidence.v1" as const;

export interface ReaderProjection<T> {
  readonly byte_budget: number;
  /** Exact UTF-8 byte length of the stable JSON representation of this value. */
  readonly utf8_bytes: number;
  readonly value: T;
}

export interface ReaderBoundedItems<T> {
  readonly shown: number;
  readonly total: number;
  readonly items: readonly T[];
  readonly next_cursor?: string;
}

export interface ReaderContentSummary {
  readonly text: string;
  readonly fidelity: ContentFidelity;
  readonly truncated: {
    /** The canonical Barbaro content was already truncated by its producer. */
    readonly canonical: boolean;
    /** This noncanonical reader projection shortened the canonical text. */
    readonly projection: boolean;
  };
  readonly utf8_bytes: {
    readonly shown: number;
    readonly canonical: number;
    readonly original: number;
  };
  /** Canonical redaction metadata, retained even when the text is excerpted again. */
  readonly redactions: readonly BarbaroRedaction[];
}

export interface ReaderActionSummary {
  readonly action_id: string;
  readonly kind: "file_change" | "command" | "test" | "tool" | "other";
  readonly outcome: BarbaroActionOutcome;
  readonly source_refs: number;
  readonly operation?: "create" | "modify" | "delete" | "move" | "unknown";
  readonly path?: string;
  readonly previous_path?: string;
  readonly added_lines?: number;
  readonly removed_lines?: number;
  readonly command?: ReaderContentSummary;
  readonly exit_code?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly failure_excerpt?: ReaderContentSummary;
  readonly tool_name?: string;
  readonly summary?: ReaderContentSummary;
}

export interface ReaderSubagentSummary {
  readonly total: number;
  readonly by_role: readonly { readonly role: string; readonly count: number }[];
  readonly outcomes: Readonly<Partial<Record<BarbaroTurnOutcome, number>>>;
  readonly changed_paths: ReaderBoundedItems<string>;
  readonly evidence_refs: ReaderBoundedItems<string>;
}

export interface ReaderTurnSummary {
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly sequence: number;
  readonly agent_id: string;
  readonly parent_turn_id?: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly outcome: BarbaroTurnOutcome;
  readonly request: ReaderContentSummary;
  readonly response?: ReaderContentSummary;
  readonly actions: ReaderBoundedItems<ReaderActionSummary>;
  readonly evidence_refs: ReaderBoundedItems<string>;
  readonly subagents: ReaderSubagentSummary;
  readonly source_refs: number;
}

export interface ReaderActiveSummary {
  readonly lease_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly turn_id?: string;
  readonly agent_id: string;
  readonly state: "working" | "waiting" | "blocked";
  readonly intent?: ReaderContentSummary;
  readonly current_action?: {
    readonly kind: "file_change" | "command" | "test" | "tool" | "other";
    readonly tool_name?: string;
    readonly path?: string;
    readonly command?: ReaderContentSummary;
    readonly started_at?: string;
  };
  readonly claims: ReaderBoundedItems<{
    readonly path: string;
    readonly mode: "write";
    readonly confidence: "exact" | "inferred";
  }>;
  readonly unknown_write_scope: boolean;
  readonly revision: number;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly source_refs: number;
}

export interface ReaderDiagnostics {
  readonly feed_files: number;
  readonly malformed_feed_records: number;
  readonly invalid_feed_records: number;
  readonly partial_feed_files: number;
  readonly scan_limited_feed_files: number;
  readonly invalid_active_records: number;
}

export interface ReaderContextV1 {
  readonly schema: typeof READER_CONTEXT_SCHEMA;
  /** Present when the projection was scoped to one workstream. */
  readonly workstream_id?: string;
  readonly active: ReaderBoundedItems<ReaderActiveSummary>;
  readonly turns: ReaderBoundedItems<ReaderTurnSummary>;
  readonly diagnostics: ReaderDiagnostics;
}

export interface ReaderJsonExcerpt {
  readonly text: string;
  readonly truncated: boolean;
  readonly utf8_bytes: {
    readonly shown: number;
    readonly original: number;
  };
}

export interface ReaderSubagentEvidenceSummary {
  readonly role: string;
  readonly sequence: number;
  readonly outcome: BarbaroTurnOutcome;
  readonly started_at: string;
  readonly ended_at: string;
  readonly request: ReaderContentSummary;
  readonly response?: ReaderContentSummary;
  readonly actions: ReaderBoundedItems<ReaderActionSummary>;
}

export interface ReaderEvidenceV1 {
  readonly schema: typeof READER_EVIDENCE_SCHEMA;
  readonly evidence_id: string;
  readonly kind: string;
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly workstream_id?: string;
  readonly agent_id: string;
  readonly parent_turn_id?: string;
  readonly parent_link?: {
    readonly method: "native" | "joined" | "unresolved";
    readonly native_key?: string;
  };
  readonly occurred_at: string;
  readonly source_refs: number;
  readonly content: ReaderSubagentEvidenceSummary | ReaderJsonExcerpt;
}

export interface ReaderProjectionOptions {
  readonly byteBudget: number;
  readonly requestExcerptBytes?: number;
  readonly responseExcerptBytes?: number;
  readonly actionExcerptBytes?: number;
}

export interface ReaderContextOptions extends ReaderProjectionOptions {
  readonly now?: Date | number | string;
  /**
   * Scope to one workstream: only leases and turns stamped with this id are
   * projected. Unset reads the whole project, as before.
   */
  readonly workstreamId?: string;
  readonly turnsPerSession?: number;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxScanBytesPerFile?: number;
}

export interface ReaderEvidenceOptions extends ReaderProjectionOptions {
  readonly provider: string;
  readonly sessionId: string;
  readonly evidenceId: string;
  /** Cursor returned by a prior evidence projection, if any. */
  readonly actionCursor?: string;
  readonly maxFileBytes?: number;
  readonly maxRecordBytes?: number;
}
