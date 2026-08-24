export const WORKSTREAM_SCHEMA = "barbaro.workstream.v1" as const;

/**
 * A workstream ID is random, not derived. Every other Barbaro ID is a typed
 * hash of provider-native identity; a workstream is authored by a person and
 * has no native identity to hash. Random IDs also let two checkouts that each
 * create `tui-design` be merged later without colliding.
 */
export const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/u;

/** The human handle: a lowercase slug, unique per project store, renameable. */
export const WORKSTREAM_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export type WorkstreamStatus = "open" | "completed";

export const WORKSTREAM_STATUSES: readonly WorkstreamStatus[] = [
  "open",
  "completed",
];

export type WorkstreamCreator =
  | { readonly provider: string; readonly session_id: string }
  | { readonly kind: "cli" };

export interface WorkstreamV1 {
  readonly schema: typeof WORKSTREAM_SCHEMA;
  readonly workstream_id: string;
  readonly name: string;
  readonly title?: string;
  readonly status: WorkstreamStatus;
  readonly created_at: string;
  readonly created_by: WorkstreamCreator;
  readonly updated_at: string;
  readonly revision: number;
}

export function isWorkstreamId(value: unknown): value is string {
  return typeof value === "string" && WORKSTREAM_ID_PATTERN.test(value);
}

export function isWorkstreamName(value: unknown): value is string {
  return typeof value === "string" && WORKSTREAM_NAME_PATTERN.test(value);
}
