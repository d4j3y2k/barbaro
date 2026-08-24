import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_BRANDING_MIN_HEIGHT,
  DASHBOARD_BRANDING_MIN_WIDTH,
  DASHBOARD_BRANDING_PANEL_WIDTH,
  dashboardBrandingRows,
  shouldRenderDashboardBranding,
} from "../../src/tui/branding.js";
import { HORSE_FRAME_COUNT, horseFrame } from "../../src/tui/horse.js";

const VISIBLE = {
  width: DASHBOARD_BRANDING_MIN_WIDTH,
  height: DASHBOARD_BRANDING_MIN_HEIGHT,
  priorityConflict: false,
  diagnosticsVisible: false,
} as const;

test("branding appears only at its documented terminal threshold", () => {
  assert.equal(shouldRenderDashboardBranding(VISIBLE), true);
  assert.equal(
    shouldRenderDashboardBranding({
      ...VISIBLE,
      width: DASHBOARD_BRANDING_MIN_WIDTH - 1,
    }),
    false,
  );
  assert.equal(
    shouldRenderDashboardBranding({
      ...VISIBLE,
      height: DASHBOARD_BRANDING_MIN_HEIGHT - 1,
    }),
    false,
  );
});

test("visible operational priorities suppress branding", () => {
  for (const priority of [
    "priorityConflict",
    "diagnosticsVisible",
  ] as const) {
    assert.equal(
      shouldRenderDashboardBranding({ ...VISIBLE, [priority]: true }),
      false,
      priority,
    );
  }
});

test("branding frame selection wraps deterministically in both directions", () => {
  assert.deepEqual(
    dashboardBrandingRows(HORSE_FRAME_COUNT),
    dashboardBrandingRows(0),
  );
  assert.deepEqual(
    dashboardBrandingRows(-1),
    dashboardBrandingRows(HORSE_FRAME_COUNT - 1),
  );
  assert.throws(() => dashboardBrandingRows(0.5), /integer/);
});

test("branding rows retain fixed compact panel geometry", () => {
  assert.equal(DASHBOARD_BRANDING_PANEL_WIDTH, 40);
  for (let index = 0; index < HORSE_FRAME_COUNT; index += 1) {
    const rows = dashboardBrandingRows(index);
    assert.equal(rows.length, 8);
    assert.ok(rows.every((row) => Array.from(row).length === 36));
  }
});

test("branding rows are exactly the existing compact riderless source frame", () => {
  for (let index = 0; index < HORSE_FRAME_COUNT; index += 1) {
    assert.deepEqual(
      dashboardBrandingRows(index),
      horseFrame(index, "compact", "riderless"),
    );
  }
});
