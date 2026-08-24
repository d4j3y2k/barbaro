import { horseFrame } from "./horse.js";

/** Minimum terminal width at which dashboard branding may be shown. */
export const DASHBOARD_BRANDING_MIN_WIDTH = 150;

/** Minimum terminal height at which dashboard branding may be shown. */
export const DASHBOARD_BRANDING_MIN_HEIGHT = 28;

/** Panel width that leaves room for the compact 36-cell art plus padding. */
export const DASHBOARD_BRANDING_PANEL_WIDTH = 40;

export interface DashboardBrandingVisibility {
  readonly width: number;
  readonly height: number;
  readonly priorityConflict: boolean;
  readonly diagnosticsVisible: boolean;
}

/**
 * Branding is strictly secondary to claim conflicts and unhealthy diagnostics.
 */
export function shouldRenderDashboardBranding(
  visibility: DashboardBrandingVisibility,
): boolean {
  return visibility.width >= DASHBOARD_BRANDING_MIN_WIDTH
    && visibility.height >= DASHBOARD_BRANDING_MIN_HEIGHT
    && !visibility.priorityConflict
    && !visibility.diagnosticsVisible;
}

/** Return one bounded compact riderless source frame for the dashboard. */
export function dashboardBrandingRows(frameIndex: number): readonly string[] {
  return horseFrame(frameIndex, "compact", "riderless");
}
