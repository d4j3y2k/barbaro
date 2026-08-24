import type { DashboardViewModel } from "./model.js";

/** The two record lists that can receive keyboard focus in the dashboard. */
export type TuiPane = "active" | "turns";

/** @deprecated Prefer the integration-facing `TuiPane` name. */
export type NavigationPane = TuiPane;

export interface NavigationRecords {
  readonly active: readonly string[];
  readonly turns: readonly string[];
}

/**
 * Number of record rows visible in each pane. Omitted sizes retain the
 * reducer's current value. A size of zero is valid for a pane hidden by a
 * compact layout.
 */
export type NavigationViewportSizes = Readonly<
  Partial<Record<NavigationPane, number>>
>;

export interface PaneNavigationState {
  /** Stable record identities in their current presentation order. */
  readonly keys: readonly string[];
  /** Null only while the pane is empty. */
  readonly selectedKey: string | null;
  /** Index of selectedKey in keys, or null while the pane is empty. */
  readonly selectedIndex: number | null;
  /** Index of the first record row in the pane's viewport. */
  readonly scrollOffset: number;
  /** Visible record rows; zero means this pane is currently not visible. */
  readonly viewportSize: number;
}

export interface DetailSelection {
  readonly pane: NavigationPane;
  readonly recordKey: string;
}

export interface TuiNavigationState {
  readonly focusedPane: NavigationPane;
  readonly panes: Readonly<Record<NavigationPane, PaneNavigationState>>;
  /** The exact selected record shown in the detail view. */
  readonly detail: DetailSelection | null;
}

export interface CreateTuiNavigationOptions {
  readonly focusedPane?: NavigationPane;
  readonly viewports?: NavigationViewportSizes;
}

export type TuiNavigationAction =
  | { readonly type: "focus-pane"; readonly pane: NavigationPane }
  | { readonly type: "focus-next-pane" }
  | { readonly type: "focus-previous-pane" }
  | { readonly type: "move-selection"; readonly delta: number }
  | { readonly type: "open-detail" }
  | { readonly type: "close-detail" }
  | {
      readonly type: "reconcile";
      readonly records: NavigationRecords;
      readonly viewports?: NavigationViewportSizes;
    }
  | {
      readonly type: "set-viewports";
      readonly viewports: NavigationViewportSizes;
    };

export interface VisibleRecordRange {
  readonly start: number;
  /** Exclusive end index. */
  readonly end: number;
}

const PANE_ORDER: readonly NavigationPane[] = ["active", "turns"];

/**
 * Until layout supplies a row count, treat the complete bounded projection as
 * visible. This avoids manufacturing scroll movement before a renderer knows
 * its geometry.
 */
const UNBOUNDED_VIEWPORT = Number.MAX_SAFE_INTEGER;

const EMPTY_RECORDS: NavigationRecords = {
  active: [],
  turns: [],
};

/** Create navigation state with the first record selected in each nonempty pane. */
export function createTuiNavigationState(
  records: NavigationRecords = EMPTY_RECORDS,
  options: CreateTuiNavigationOptions = {},
): TuiNavigationState {
  const viewports = options.viewports ?? {};
  return {
    focusedPane: options.focusedPane ?? "active",
    panes: {
      active: createPane(records.active, viewportFor(viewports, "active")),
      turns: createPane(records.turns, viewportFor(viewports, "turns")),
    },
    detail: null,
  };
}

/** Integration-facing constructor with separate view-model key lists. */
export function createNavigationState(
  activeKeys: readonly string[] = [],
  turnKeys: readonly string[] = [],
  options: CreateTuiNavigationOptions = {},
): TuiNavigationState {
  return createTuiNavigationState(
    { active: activeKeys, turns: turnKeys },
    options,
  );
}

/**
 * Pure navigation reducer used by the terminal runtime.
 *
 * Detail is modal: pane and row navigation are deterministic no-ops until the
 * detail is closed. This guarantees that `detail.recordKey` always names the
 * selected record that opened the view. Reconciliation may reorder that
 * record, but closes detail if the record disappears.
 */
export function reduceTuiNavigationState(
  state: TuiNavigationState,
  action: TuiNavigationAction,
): TuiNavigationState {
  switch (action.type) {
    case "focus-pane":
      if (state.detail !== null || state.focusedPane === action.pane) {
        return state;
      }
      return { ...state, focusedPane: action.pane };
    case "focus-next-pane":
      return focusAdjacentPane(state, 1);
    case "focus-previous-pane":
      return focusAdjacentPane(state, -1);
    case "move-selection":
      return moveSelection(state, action.delta);
    case "open-detail": {
      if (state.detail !== null) return state;
      const pane = state.panes[state.focusedPane];
      if (pane.selectedKey === null) return state;
      return {
        ...state,
        detail: {
          pane: state.focusedPane,
          recordKey: pane.selectedKey,
        },
      };
    }
    case "close-detail":
      return state.detail === null ? state : { ...state, detail: null };
    case "reconcile":
      return reconcileTuiNavigationState(
        state,
        action.records,
        action.viewports,
      );
    case "set-viewports":
      return setViewportSizes(state, action.viewports);
  }
}

/** Integration-facing reducer name for app and renderer code. */
export function reduceNavigationState(
  state: TuiNavigationState,
  action: TuiNavigationAction,
): TuiNavigationState {
  return reduceTuiNavigationState(state, action);
}

/**
 * Reconcile new projection order while retaining selection by stable key.
 * When a key disappeared, selection uses its former index, clamped to the new
 * list. A detail view is closed rather than silently showing that fallback.
 */
export function reconcileTuiNavigationState(
  state: TuiNavigationState,
  records: NavigationRecords,
  viewports: NavigationViewportSizes = {},
): TuiNavigationState {
  const active = reconcilePane(
    state.panes.active,
    records.active,
    viewportFor(viewports, "active", state.panes.active.viewportSize),
  );
  const turns = reconcilePane(
    state.panes.turns,
    records.turns,
    viewportFor(viewports, "turns", state.panes.turns.viewportSize),
  );
  const detail = reconcileDetail(state.detail, active, turns);

  if (
    active === state.panes.active &&
    turns === state.panes.turns &&
    detail === state.detail
  ) {
    return state;
  }
  return {
    ...state,
    panes: { active, turns },
    detail,
  };
}

/** Extract stable record identities from the Phase 1 presentation model. */
export function navigationRecordsFromModel(
  model: Pick<DashboardViewModel, "active" | "turns">,
): NavigationRecords {
  return {
    active: model.active.items.map((record) => record.key),
    turns: model.turns.items.map((record) => record.key),
  };
}

/** The selected stable identity in a pane, defaulting to the focused pane. */
export function selectedRecordKey(
  state: TuiNavigationState,
  pane: NavigationPane = state.focusedPane,
): string | null {
  return state.panes[pane].selectedKey;
}

/** Integration-facing selected-key accessor. */
export function selectedKeyForPane(
  state: TuiNavigationState,
  pane: TuiPane,
): string | null {
  return selectedRecordKey(state, pane);
}

/** Current half-open slice for a renderer; always bounded by the key list. */
export function visibleRecordRange(
  state: TuiNavigationState,
  pane: NavigationPane,
): VisibleRecordRange {
  const paneState = state.panes[pane];
  if (paneState.viewportSize === 0 || paneState.keys.length === 0) {
    return { start: 0, end: 0 };
  }
  return {
    start: paneState.scrollOffset,
    end: Math.min(
      paneState.keys.length,
      paneState.scrollOffset + paneState.viewportSize,
    ),
  };
}

function createPane(
  keys: readonly string[],
  viewportSize: number,
): PaneNavigationState {
  const copiedKeys = [...keys];
  if (copiedKeys.length === 0) {
    return {
      keys: copiedKeys,
      selectedKey: null,
      selectedIndex: null,
      scrollOffset: 0,
      viewportSize,
    };
  }
  return {
    keys: copiedKeys,
    selectedKey: copiedKeys[0]!,
    selectedIndex: 0,
    scrollOffset: 0,
    viewportSize,
  };
}

function focusAdjacentPane(
  state: TuiNavigationState,
  direction: 1 | -1,
): TuiNavigationState {
  if (state.detail !== null) return state;
  const current = PANE_ORDER.indexOf(state.focusedPane);
  const next = (current + direction + PANE_ORDER.length) % PANE_ORDER.length;
  const focusedPane = PANE_ORDER[next]!;
  return focusedPane === state.focusedPane
    ? state
    : { ...state, focusedPane };
}

function moveSelection(
  state: TuiNavigationState,
  rawDelta: number,
): TuiNavigationState {
  if (state.detail !== null) return state;
  const delta = finiteInteger(rawDelta);
  if (delta === 0) return state;

  const current = state.panes[state.focusedPane];
  if (current.selectedIndex === null) return state;
  const selectedIndex = clamp(
    current.selectedIndex + delta,
    0,
    current.keys.length - 1,
  );
  if (selectedIndex === current.selectedIndex) return state;

  const updated = paneWithSelection(current, selectedIndex);
  return replacePane(state, state.focusedPane, updated);
}

function setViewportSizes(
  state: TuiNavigationState,
  viewports: NavigationViewportSizes,
): TuiNavigationState {
  const active = resizePane(
    state.panes.active,
    viewportFor(viewports, "active", state.panes.active.viewportSize),
  );
  const turns = resizePane(
    state.panes.turns,
    viewportFor(viewports, "turns", state.panes.turns.viewportSize),
  );
  if (active === state.panes.active && turns === state.panes.turns) return state;
  return { ...state, panes: { active, turns } };
}

function reconcilePane(
  previous: PaneNavigationState,
  rawKeys: readonly string[],
  viewportSize: number,
): PaneNavigationState {
  const keys = [...rawKeys];
  if (keys.length === 0) {
    if (
      previous.keys.length === 0 &&
      previous.selectedKey === null &&
      previous.selectedIndex === null &&
      previous.scrollOffset === 0 &&
      previous.viewportSize === viewportSize
    ) {
      return previous;
    }
    return {
      keys,
      selectedKey: null,
      selectedIndex: null,
      scrollOffset: 0,
      viewportSize,
    };
  }

  const matchingIndex =
    previous.selectedKey === null ? -1 : keys.indexOf(previous.selectedKey);
  const selectedIndex =
    matchingIndex >= 0
      ? matchingIndex
      : clamp(previous.selectedIndex ?? 0, 0, keys.length - 1);
  const selectedKey = keys[selectedIndex]!;
  const scrollOffset = selectionVisibleOffset(
    previous.scrollOffset,
    selectedIndex,
    keys.length,
    viewportSize,
  );

  if (
    sameKeys(previous.keys, keys) &&
    previous.selectedKey === selectedKey &&
    previous.selectedIndex === selectedIndex &&
    previous.scrollOffset === scrollOffset &&
    previous.viewportSize === viewportSize
  ) {
    return previous;
  }
  return {
    keys,
    selectedKey,
    selectedIndex,
    scrollOffset,
    viewportSize,
  };
}

function resizePane(
  pane: PaneNavigationState,
  viewportSize: number,
): PaneNavigationState {
  if (pane.viewportSize === viewportSize) return pane;
  const scrollOffset =
    pane.selectedIndex === null
      ? 0
      : selectionVisibleOffset(
          pane.scrollOffset,
          pane.selectedIndex,
          pane.keys.length,
          viewportSize,
        );
  return { ...pane, viewportSize, scrollOffset };
}

function paneWithSelection(
  pane: PaneNavigationState,
  selectedIndex: number,
): PaneNavigationState {
  const scrollOffset = selectionVisibleOffset(
    pane.scrollOffset,
    selectedIndex,
    pane.keys.length,
    pane.viewportSize,
  );
  return {
    ...pane,
    selectedKey: pane.keys[selectedIndex]!,
    selectedIndex,
    scrollOffset,
  };
}

function replacePane(
  state: TuiNavigationState,
  pane: NavigationPane,
  next: PaneNavigationState,
): TuiNavigationState {
  if (state.panes[pane] === next) return state;
  return {
    ...state,
    panes:
      pane === "active"
        ? { active: next, turns: state.panes.turns }
        : { active: state.panes.active, turns: next },
  };
}

function reconcileDetail(
  detail: DetailSelection | null,
  active: PaneNavigationState,
  turns: PaneNavigationState,
): DetailSelection | null {
  if (detail === null) return null;
  const pane = detail.pane === "active" ? active : turns;
  return pane.selectedKey === detail.recordKey ? detail : null;
}

function selectionVisibleOffset(
  previousOffset: number,
  selectedIndex: number,
  itemCount: number,
  viewportSize: number,
): number {
  if (itemCount === 0 || viewportSize === 0) return 0;
  const maximumOffset = Math.max(0, itemCount - viewportSize);
  let offset = clamp(previousOffset, 0, maximumOffset);
  if (selectedIndex < offset) {
    offset = selectedIndex;
  } else if (selectedIndex >= offset + viewportSize) {
    offset = selectedIndex - viewportSize + 1;
  }
  return clamp(offset, 0, maximumOffset);
}

function viewportFor(
  sizes: NavigationViewportSizes,
  pane: NavigationPane,
  fallback = UNBOUNDED_VIEWPORT,
): number {
  const candidate = sizes[pane];
  return candidate === undefined ? fallback : nonnegativeInteger(candidate);
}

function nonnegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function finiteInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}
