/**
 * The comfort card's immutable view model: everything the renderer needs,
 * nothing it may derive. Reducers own wording and proof decisions; the
 * renderer owns cells, stops, and breathing rows. No field here is ever
 * read back from the terminal or the store.
 */

import type { HorseScale } from "./horse.js";

/** One ledger line on Home: a workstream needing eyes. */
export interface HubEntryView {
  readonly selected: boolean;
  /** One-based position in the status-filtered, ordered Home roster. */
  readonly position: number;
  readonly name: string;
  readonly detail: string;
}

export interface HubFrameView {
  readonly kind: "hub";
  readonly title: string;
  readonly entries: readonly HubEntryView[];
  /** Reducer-authored status/viewport truth painted into the lower border. */
  readonly bottomTitle: string;
  /** One soft line for workstreams proven quiet; absent when none are. */
  readonly quietLine?: string;
  /** Mandatory quarantine: activity-unknown workstreams named separately. */
  readonly unknownNames?: readonly string[];
  readonly unknownHeader?: string;
}

export type HorseView =
  | { readonly kind: "gallop"; readonly frameIndex: number }
  | { readonly kind: "intertitle"; readonly text: string };

/** The standalone launch title: identity plus measured first-read telemetry. */
export interface BootView {
  readonly frameIndex: number;
  readonly scale: HorseScale;
  readonly telemetry: string;
}

/** One honest lifecycle pass, translated inside the persistent card frame. */
export interface TraversalFrameView {
  readonly kind: "traversal";
  readonly title: string;
  readonly frameIndex: number;
  /** Normalized travel: 0 off-left, 0.5 centered, 1 off-right. */
  readonly progress: number;
}

export interface BootTextView {
  readonly phase: string;
  readonly elapsed: string;
  readonly projected: string;
}

export interface RollLineView {
  readonly selected: boolean;
  readonly identity: string;
  readonly detail: string;
}

export interface WorkingFrameView {
  readonly kind: "working";
  readonly title: string;
  readonly horse: HorseView;
  /** Latest completed-refresh measurement; comfort gallop only. */
  readonly telemetry?: string;
  readonly rolls: readonly RollLineView[];
}

export interface ExposureRowView {
  readonly selected: boolean;
  /** Exact-session relation to the independently selected roll. */
  readonly provenance?: "selected-session" | "other-session";
  readonly sequence: number;
  /** Success is silent; every other outcome is named here. */
  readonly exception?: string;
  readonly time: string;
  readonly excerpt: string;
  /** The selected reader projection omitted more source text. */
  readonly excerptTruncated: boolean;
}

export interface IdleFrameView {
  readonly kind: "idle";
  readonly title: string;
  readonly exposures: readonly ExposureRowView[];
  readonly summaryLine: string;
  readonly rolls: readonly RollLineView[];
}

export interface HelpRowView {
  readonly term: string;
  readonly meaning: string;
}

export interface HelpFrameView {
  readonly kind: "help";
  readonly title: string;
  readonly keyRows: readonly HelpRowView[];
  readonly wordRows: readonly HelpRowView[];
}

export interface IntertitleFrameView {
  readonly kind: "intertitle";
  readonly title: string;
  readonly lines: readonly string[];
}

export interface CreateFieldView {
  readonly label: "Name" | "Title";
  /** Canonical value only; the editor cursor is renderer state. */
  readonly value: string;
  readonly focused: boolean;
}

export interface CreateFormFrameView {
  readonly kind: "form";
  readonly title: string;
  readonly fields: readonly CreateFieldView[];
  readonly hints: readonly string[];
  readonly status: string;
  /** False while the writer is pending: the cursor leaves the canvas. */
  readonly showCursor: boolean;
}

export interface CreatedCommandView {
  readonly heading: string;
  readonly text: string;
  readonly selected: boolean;
  /** Manual-copy highlight: the honest no-clipboard presentation. */
  readonly manualHighlight: boolean;
}

export interface CreatedFrameView {
  readonly kind: "created";
  readonly title: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly idLine: string;
  readonly commands: readonly CreatedCommandView[];
}

export type FrameView =
  | HubFrameView
  | WorkingFrameView
  | IdleFrameView
  | HelpFrameView
  | IntertitleFrameView
  | TraversalFrameView
  | CreateFormFrameView
  | CreatedFrameView;

export interface CardView {
  /** Right-aligned location on the first top-strip row. */
  readonly location: string;
  /** The strongest current truth, already worded by the reducer. */
  readonly truth: string;
  readonly frame: FrameView;
  /** At most benchRows unboxed caption lines. */
  readonly bench: readonly string[];
  readonly keyLine: string;
}
