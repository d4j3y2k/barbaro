export type ContentFidelity = "verbatim" | "normalized" | "excerpt" | "redacted";

export interface BarbaroRedaction {
  readonly kind: string;
  readonly count: number;
}

export interface BarbaroContent {
  readonly text: string;
  readonly fidelity: ContentFidelity;
  readonly truncated: boolean;
  readonly original_utf8_bytes?: number;
  readonly redactions: readonly BarbaroRedaction[];
}

export interface BarbaroSourceRef {
  readonly trace_id: string;
  readonly trace_path?: string;
  readonly line_start?: number;
  readonly line_end?: number;
  readonly native_record_ids?: readonly string[];
}

export type BarbaroTurnOutcome =
  | "success"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "abandoned"
  | "unknown";

export type BarbaroActionOutcome =
  | "success"
  | "failed"
  | "denied"
  | "interrupted"
  | "unknown";

interface BarbaroActionBase {
  readonly action_id: string;
  readonly outcome: BarbaroActionOutcome;
  readonly source_refs: readonly BarbaroSourceRef[];
}

export interface BarbaroFileChangeAction extends BarbaroActionBase {
  readonly kind: "file_change";
  readonly operation: "create" | "modify" | "delete" | "move" | "unknown";
  readonly path: string;
  readonly previous_path?: string;
  readonly added_lines?: number;
  readonly removed_lines?: number;
}

export interface BarbaroCommandAction extends BarbaroActionBase {
  readonly kind: "command";
  readonly command: BarbaroContent;
  readonly exit_code?: number;
  readonly failure_excerpt?: BarbaroContent;
}

export interface BarbaroTestAction extends BarbaroActionBase {
  readonly kind: "test";
  readonly command: BarbaroContent;
  readonly exit_code?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly failure_excerpt?: BarbaroContent;
}

export interface BarbaroToolAction extends BarbaroActionBase {
  readonly kind: "tool";
  readonly tool_name: string;
  readonly summary?: BarbaroContent;
}

export interface BarbaroOtherAction extends BarbaroActionBase {
  readonly kind: "other";
  readonly summary: BarbaroContent;
}

export type BarbaroAction =
  | BarbaroFileChangeAction
  | BarbaroCommandAction
  | BarbaroTestAction
  | BarbaroToolAction
  | BarbaroOtherAction;

export interface BarbaroSubagentRollup {
  readonly total: number;
  readonly by_role: readonly { readonly role: string; readonly count: number }[];
  readonly outcomes: Readonly<Partial<Record<BarbaroTurnOutcome, number>>>;
  readonly changed_paths: readonly string[];
  readonly evidence_refs: readonly string[];
}

export interface BarbaroTurnV1 {
  readonly schema: "barbaro.turn.v1";
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly agent_id: string;
  readonly parent_turn_id?: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly outcome: BarbaroTurnOutcome;
  readonly request: BarbaroContent;
  readonly response?: BarbaroContent;
  readonly actions: readonly BarbaroAction[];
  readonly subagents: BarbaroSubagentRollup;
  readonly evidence_refs: readonly string[];
  readonly source_refs: readonly BarbaroSourceRef[];
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type BarbaroEvidenceKind =
  | "prompt"
  | "response"
  | "command"
  | "tool_call"
  | "tool_result"
  | "failure_excerpt"
  | "usage"
  | "attachment_metadata"
  | "subagent_turn"
  | "provider_event";

export interface BarbaroParentLinkV1 {
  readonly method: "native" | "joined" | "unresolved";
  readonly native_key?: string;
}

/**
 * The provider-neutral substance of one child interaction turn.
 *
 * Envelope identity and lineage stay on `BarbaroSubagentTurnEvidenceV1`:
 * `turn_id` identifies this child turn, `parent_turn_id` identifies the root
 * human turn, and `agent_id` identifies the child actor. Provider topology
 * such as Claude workflow IDs belongs in the evidence `extensions` object.
 */
export interface BarbaroSubagentTurnContentV1 {
  readonly role: string;
  readonly sequence: number;
  readonly outcome: BarbaroTurnOutcome;
  readonly started_at: string;
  readonly ended_at: string;
  readonly request: BarbaroContent;
  readonly response?: BarbaroContent;
  readonly actions: readonly BarbaroAction[];
}

interface BarbaroEvidenceBaseV1 {
  readonly schema: "barbaro.evidence.v1";
  readonly evidence_id: string;
  readonly turn_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly parent_turn_id?: string;
  readonly parent_link?: BarbaroParentLinkV1;
  readonly occurred_at: string;
  readonly source_refs: readonly BarbaroSourceRef[];
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface BarbaroSubagentTurnEvidenceV1 extends BarbaroEvidenceBaseV1 {
  readonly kind: "subagent_turn";
  readonly parent_link: BarbaroParentLinkV1;
  readonly content: BarbaroSubagentTurnContentV1;
}

export interface BarbaroGeneralEvidenceV1 extends BarbaroEvidenceBaseV1 {
  readonly kind: Exclude<BarbaroEvidenceKind, "subagent_turn">;
  readonly content: Readonly<Record<string, unknown>>;
}

/**
 * Evidence stays open-ended by kind in the JSON Schema, but the shared
 * TypeScript contract deliberately fixes the cross-provider M7 child shape.
 */
export type BarbaroEvidenceV1 =
  | BarbaroSubagentTurnEvidenceV1
  | BarbaroGeneralEvidenceV1;

export interface BarbaroActiveLeaseV1 {
  readonly schema: "barbaro.active.v1";
  readonly lease_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly turn_id?: string;
  readonly agent_id: string;
  readonly state: "working" | "waiting" | "blocked" | "idle";
  readonly intent?: BarbaroContent;
  readonly current_action?: {
    readonly kind: "file_change" | "command" | "test" | "tool" | "other";
    readonly tool_name?: string;
    readonly path?: string;
    readonly command?: BarbaroContent;
    readonly started_at?: string;
  };
  readonly claims: readonly {
    readonly path: string;
    readonly mode: "write";
    readonly confidence: "exact" | "inferred";
  }[];
  readonly unknown_write_scope: boolean;
  readonly revision: number;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly source_refs?: readonly BarbaroSourceRef[];
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
