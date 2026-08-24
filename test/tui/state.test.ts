import assert from "node:assert/strict";
import test from "node:test";

import {
  createNavigationState,
  createTuiNavigationState,
  navigationRecordsFromModel,
  reconcileTuiNavigationState,
  reduceNavigationState,
  selectedKeyForPane,
  selectedRecordKey,
  visibleRecordRange,
  type TuiNavigationState,
} from "../../src/tui/state.js";
import type { DashboardViewModel } from "../../src/tui/model.js";

const ACTIVE = ["actor-a", "actor-b", "actor-c", "actor-d", "actor-e"];
const TURNS = ["turn-1", "turn-2", "turn-3"];

function dispatch(
  state: TuiNavigationState,
  ...actions: Parameters<typeof reduceNavigationState>[1][]
): TuiNavigationState {
  return actions.reduce(reduceNavigationState, state);
}

test("constructor selects the first stable key independently in each pane", () => {
  const active = ["actor-a", "actor-b"];
  const turns = ["turn-1", "turn-2"];
  const state = createNavigationState(active, turns, {
    focusedPane: "turns",
    viewports: { active: 4, turns: 2 },
  });

  assert.equal(state.focusedPane, "turns");
  assert.deepEqual(state.panes.active, {
    keys: active,
    selectedKey: "actor-a",
    selectedIndex: 0,
    scrollOffset: 0,
    viewportSize: 4,
  });
  assert.deepEqual(state.panes.turns, {
    keys: turns,
    selectedKey: "turn-1",
    selectedIndex: 0,
    scrollOffset: 0,
    viewportSize: 2,
  });

  active[0] = "mutated";
  turns[0] = "mutated";
  assert.equal(state.panes.active.keys[0], "actor-a");
  assert.equal(state.panes.turns.keys[0], "turn-1");
});

test("next, previous, and direct focus preserve each pane's selection", () => {
  let state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 2, turns: 2 },
  });
  state = dispatch(
    state,
    { type: "move-selection", delta: 2 },
    { type: "focus-next-pane" },
    { type: "move-selection", delta: 1 },
  );

  assert.equal(state.focusedPane, "turns");
  assert.equal(selectedKeyForPane(state, "active"), "actor-c");
  assert.equal(selectedKeyForPane(state, "turns"), "turn-2");

  state = reduceNavigationState(state, { type: "focus-previous-pane" });
  assert.equal(state.focusedPane, "active");
  assert.equal(selectedRecordKey(state), "actor-c");

  state = reduceNavigationState(state, {
    type: "focus-pane",
    pane: "turns",
  });
  assert.equal(state.focusedPane, "turns");
  assert.equal(selectedRecordKey(state), "turn-2");

  // With exactly two panes, both directions wrap back to active.
  assert.equal(
    reduceNavigationState(state, { type: "focus-next-pane" }).focusedPane,
    "active",
  );
});

test("movement clamps at list boundaries and scrolls only enough to stay visible", () => {
  let state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 3 },
  });

  state = reduceNavigationState(state, { type: "move-selection", delta: 2 });
  assert.deepEqual(
    {
      key: state.panes.active.selectedKey,
      index: state.panes.active.selectedIndex,
      offset: state.panes.active.scrollOffset,
    },
    { key: "actor-c", index: 2, offset: 0 },
  );

  state = reduceNavigationState(state, { type: "move-selection", delta: 1 });
  assert.deepEqual(
    {
      key: state.panes.active.selectedKey,
      index: state.panes.active.selectedIndex,
      offset: state.panes.active.scrollOffset,
    },
    { key: "actor-d", index: 3, offset: 1 },
  );

  state = reduceNavigationState(state, { type: "move-selection", delta: 99 });
  assert.deepEqual(
    {
      key: state.panes.active.selectedKey,
      index: state.panes.active.selectedIndex,
      offset: state.panes.active.scrollOffset,
    },
    { key: "actor-e", index: 4, offset: 2 },
  );
  assert.deepEqual(visibleRecordRange(state, "active"), { start: 2, end: 5 });

  state = reduceNavigationState(state, { type: "move-selection", delta: -99 });
  assert.deepEqual(
    {
      key: state.panes.active.selectedKey,
      index: state.panes.active.selectedIndex,
      offset: state.panes.active.scrollOffset,
    },
    { key: "actor-a", index: 0, offset: 0 },
  );
});

test("viewport changes reveal the selection without changing its identity", () => {
  let state = createNavigationState(ACTIVE, TURNS);
  state = reduceNavigationState(state, { type: "move-selection", delta: 99 });
  assert.equal(state.panes.active.scrollOffset, 0);

  state = reduceNavigationState(state, {
    type: "set-viewports",
    viewports: { active: 2 },
  });
  assert.equal(state.panes.active.selectedKey, "actor-e");
  assert.equal(state.panes.active.scrollOffset, 3);
  assert.deepEqual(visibleRecordRange(state, "active"), { start: 3, end: 5 });

  state = reduceNavigationState(state, {
    type: "set-viewports",
    viewports: { active: 1 },
  });
  assert.equal(state.panes.active.scrollOffset, 4);

  state = reduceNavigationState(state, {
    type: "set-viewports",
    viewports: { active: 0 },
  });
  assert.equal(state.panes.active.selectedKey, "actor-e");
  assert.equal(state.panes.active.scrollOffset, 0);
  assert.deepEqual(visibleRecordRange(state, "active"), { start: 0, end: 0 });

  state = reduceNavigationState(state, {
    type: "set-viewports",
    viewports: { active: 2 },
  });
  assert.equal(state.panes.active.scrollOffset, 3);
});

test("empty panes are safe and select the first record when data arrives", () => {
  const empty = createNavigationState();
  assert.deepEqual(empty.panes.active, {
    keys: [],
    selectedKey: null,
    selectedIndex: null,
    scrollOffset: 0,
    viewportSize: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(
    reduceNavigationState(empty, { type: "move-selection", delta: 1 }),
    empty,
  );
  assert.equal(
    reduceNavigationState(empty, { type: "open-detail" }),
    empty,
  );
  assert.deepEqual(visibleRecordRange(empty, "active"), { start: 0, end: 0 });

  const focusedTurns = reduceNavigationState(empty, {
    type: "focus-next-pane",
  });
  assert.equal(focusedTurns.focusedPane, "turns");
  assert.equal(
    reduceNavigationState(focusedTurns, {
      type: "move-selection",
      delta: -1,
    }),
    focusedTurns,
  );

  const populated = reduceNavigationState(focusedTurns, {
    type: "reconcile",
    records: { active: ["actor-a"], turns: ["turn-1"] },
  });
  assert.equal(populated.panes.active.selectedKey, "actor-a");
  assert.equal(populated.panes.turns.selectedKey, "turn-1");
});

test("detail is keyed to the selected record and makes list navigation modal", () => {
  let state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 2 },
  });
  state = dispatch(
    state,
    { type: "move-selection", delta: 1 },
    { type: "open-detail" },
  );
  assert.deepEqual(state.detail, { pane: "active", recordKey: "actor-b" });

  assert.equal(
    reduceNavigationState(state, { type: "open-detail" }),
    state,
  );
  assert.equal(
    reduceNavigationState(state, { type: "move-selection", delta: 1 }),
    state,
  );
  assert.equal(
    reduceNavigationState(state, { type: "focus-next-pane" }),
    state,
  );
  assert.equal(
    reduceNavigationState(state, { type: "focus-pane", pane: "turns" }),
    state,
  );

  state = reduceNavigationState(state, { type: "close-detail" });
  assert.equal(state.detail, null);
  assert.equal(
    reduceNavigationState(state, { type: "close-detail" }),
    state,
  );
  state = reduceNavigationState(state, { type: "move-selection", delta: 1 });
  assert.equal(state.panes.active.selectedKey, "actor-c");
});

test("refresh reorder preserves selections and an open detail by stable key", () => {
  let state = createNavigationState(
    ["actor-a", "actor-b", "actor-c", "actor-d"],
    TURNS,
    { viewports: { active: 2, turns: 2 } },
  );
  state = dispatch(
    state,
    { type: "move-selection", delta: 1 },
    { type: "open-detail" },
  );
  const detail = state.detail;

  state = reduceNavigationState(state, {
    type: "reconcile",
    records: {
      active: ["actor-d", "actor-c", "actor-b", "actor-a"],
      turns: ["turn-3", "turn-1", "turn-2"],
    },
  });

  assert.equal(state.panes.active.selectedKey, "actor-b");
  assert.equal(state.panes.active.selectedIndex, 2);
  assert.equal(state.panes.active.scrollOffset, 1);
  assert.equal(state.panes.turns.selectedKey, "turn-1");
  assert.equal(state.panes.turns.selectedIndex, 1);
  assert.equal(state.detail, detail);
});

test("a disappeared selection clamps to its nearest valid former index", () => {
  let state = createNavigationState(
    ["actor-a", "actor-b", "actor-c", "actor-d"],
    TURNS,
    { viewports: { active: 2 } },
  );
  state = reduceNavigationState(state, { type: "move-selection", delta: 2 });
  assert.equal(state.panes.active.selectedKey, "actor-c");

  state = reduceNavigationState(state, {
    type: "reconcile",
    records: {
      active: ["actor-a", "actor-b", "actor-d"],
      turns: TURNS,
    },
  });
  assert.equal(state.panes.active.selectedKey, "actor-d");
  assert.equal(state.panes.active.selectedIndex, 2);
  assert.equal(state.panes.active.scrollOffset, 1);

  state = reduceNavigationState(state, {
    type: "reconcile",
    records: { active: ["actor-z"], turns: TURNS },
  });
  assert.equal(state.panes.active.selectedKey, "actor-z");
  assert.equal(state.panes.active.selectedIndex, 0);
  assert.equal(state.panes.active.scrollOffset, 0);
});

test("detail closes instead of silently following a fallback record", () => {
  let state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 2 },
  });
  state = dispatch(
    state,
    { type: "move-selection", delta: 2 },
    { type: "open-detail" },
  );
  assert.equal(state.detail?.recordKey, "actor-c");

  state = reduceNavigationState(state, {
    type: "reconcile",
    records: {
      active: ["actor-a", "actor-b", "actor-d", "actor-e"],
      turns: TURNS,
    },
  });
  assert.equal(state.detail, null);
  assert.equal(state.panes.active.selectedKey, "actor-d");
});

test("reconciliation updates both panes and accepts new viewport geometry", () => {
  let state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 3, turns: 3 },
  });
  state = dispatch(
    state,
    { type: "move-selection", delta: 4 },
    { type: "focus-next-pane" },
    { type: "move-selection", delta: 2 },
  );

  state = reconcileTuiNavigationState(
    state,
    {
      active: ["actor-e", "actor-d", "actor-c", "actor-b", "actor-a"],
      turns: ["turn-3", "turn-2", "turn-1"],
    },
    { active: 1, turns: 1 },
  );

  assert.equal(state.panes.active.selectedKey, "actor-e");
  assert.equal(state.panes.active.selectedIndex, 0);
  assert.equal(state.panes.active.scrollOffset, 0);
  assert.equal(state.panes.active.viewportSize, 1);
  assert.equal(state.panes.turns.selectedKey, "turn-3");
  assert.equal(state.panes.turns.selectedIndex, 0);
  assert.equal(state.panes.turns.scrollOffset, 0);
  assert.equal(state.panes.turns.viewportSize, 1);
});

test("boundary and unsupported numeric movements are referential no-ops", () => {
  const state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 2, turns: 2 },
  });

  for (const delta of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      reduceNavigationState(state, { type: "move-selection", delta }),
      state,
    );
  }
  assert.equal(
    reduceNavigationState(state, { type: "focus-pane", pane: "active" }),
    state,
  );
  assert.equal(
    reduceNavigationState(state, { type: "close-detail" }),
    state,
  );
  assert.equal(
    reduceNavigationState(state, {
      type: "set-viewports",
      viewports: { active: 2, turns: 2 },
    }),
    state,
  );
  assert.equal(
    reduceNavigationState(state, {
      type: "reconcile",
      records: { active: [...ACTIVE], turns: [...TURNS] },
      viewports: { active: 2, turns: 2 },
    }),
    state,
  );

  const last = reduceNavigationState(state, {
    type: "move-selection",
    delta: 99,
  });
  assert.equal(
    reduceNavigationState(last, { type: "move-selection", delta: 1 }),
    last,
  );
});

test("fractional viewports and movement normalize deterministically", () => {
  let state = createNavigationState(ACTIVE, TURNS, {
    viewports: { active: 2.9 },
  });
  assert.equal(state.panes.active.viewportSize, 2);

  state = reduceNavigationState(state, { type: "move-selection", delta: 2.9 });
  assert.equal(state.panes.active.selectedIndex, 2);
  assert.equal(state.panes.active.scrollOffset, 1);

  state = reduceNavigationState(state, {
    type: "set-viewports",
    viewports: { active: -3, turns: Number.NaN },
  });
  assert.equal(state.panes.active.viewportSize, 0);
  assert.equal(state.panes.turns.viewportSize, 0);
  assert.equal(state.panes.active.scrollOffset, 0);
});

test("legacy records constructor and model key extraction remain explicit", () => {
  const state = createTuiNavigationState({
    active: ["actor-a"],
    turns: ["turn-1"],
  });
  assert.equal(selectedRecordKey(state, "active"), "actor-a");

  const model = {
    active: { items: [{ key: "actor-z" }] },
    turns: { items: [{ key: "turn-z" }, { key: "turn-y" }] },
  } as unknown as Pick<DashboardViewModel, "active" | "turns">;
  assert.deepEqual(navigationRecordsFromModel(model), {
    active: ["actor-z"],
    turns: ["turn-z", "turn-y"],
  });
});
