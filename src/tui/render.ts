import { basename, resolve } from "node:path";

import type { ReaderContextV1, ReaderProjection } from "../reader/types.js";
import {
  DASHBOARD_BRANDING_PANEL_WIDTH,
  dashboardBrandingRows,
  shouldRenderDashboardBranding,
} from "./branding.js";
import {
  buildDashboardViewModel,
  shortWorkstreamLabel,
  type ActiveActorViewModel,
  type DashboardViewModel,
  type TurnViewModel,
  type VisibilityCounts,
  type VisibleClaimOverlap,
} from "./model.js";
import {
  clipTerminalText,
  padTerminalText,
  sanitizeTerminalText,
  terminalCellWidth,
} from "./terminal-text.js";
import type {
  NavigationViewportSizes,
  TuiNavigationState,
  TuiPane,
} from "./state.js";

export const DASHBOARD_MIN_WIDTH = 12;
export const DASHBOARD_MIN_HEIGHT = 6;
const WIDE_LAYOUT_WIDTH = 96;

const SGR = {
  boldCyan: "1;36",
  cyan: "36",
  green: "32",
  red: "31",
  yellow: "33",
} as const;

export interface DashboardRenderOptions {
  readonly width?: number;
  readonly height?: number;
  readonly now?: Date;
  readonly projectRoot?: string;
  readonly color?: boolean;
  readonly interactive?: boolean;
  readonly refreshIntervalMs?: number;
  readonly navigation?: TuiNavigationState;
  readonly scope?: DashboardScopeDisplay;
  readonly horseFrameIndex?: number;
}

export interface DashboardScopeDisplay {
  readonly name: string;
  readonly workstreamId: string;
}

interface RenderContext {
  readonly color: boolean;
  readonly now: Date;
  readonly interactive: boolean;
  readonly horseFrameIndex: number;
  readonly navigation?: TuiNavigationState;
  readonly scope?: DashboardScopeDisplay;
}

interface RecordViewport {
  readonly rows: readonly string[];
  readonly onscreen: number;
}

/** Render one bounded, deterministic dashboard frame. */
export function renderDashboard(
  projection: ReaderProjection<ReaderContextV1>,
  options: DashboardRenderOptions = {},
): string {
  const width = integerDimension(options.width, 100, DASHBOARD_MIN_WIDTH);
  const height = integerDimension(options.height, 30, DASHBOARD_MIN_HEIGHT);
  const model = buildDashboardViewModel(projection);
  const context: RenderContext = {
    color: options.color !== false,
    now:
      options.now ??
      (options.interactive === false
        ? snapshotReferenceTime(model)
        : new Date()),
    interactive: options.interactive !== false,
    horseFrameIndex: options.horseFrameIndex ?? 0,
    ...(options.navigation === undefined
      ? {}
      : { navigation: options.navigation }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  };
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const header = renderHeader(model, projectRoot, width, context);
  const footer = fit(footerText(options, context), width);
  const available = Math.max(0, height - header.length - 1);

  let body: string[];
  if (context.navigation?.detail !== null && context.navigation?.detail !== undefined) {
    body = renderDetailBody(model, available, width, context);
  } else if (width >= WIDE_LAYOUT_WIDTH && available >= 14) {
    body = renderWideBody(model, available, width, context);
  } else if (available >= 12) {
    body = renderStackedBody(model, available, width, context);
  } else {
    body = renderCompactBody(model, available, width, context);
  }
  body = boundedBody(body, available, width);

  return finalizeFrame([...header, ...body, footer], width, height);
}

/** Render a recoverable refresh failure without tearing down the TUI. */
export function renderDashboardError(
  error: unknown,
  options: DashboardRenderOptions = {},
): string {
  const width = integerDimension(options.width, 100, DASHBOARD_MIN_WIDTH);
  const height = integerDimension(options.height, 30, DASHBOARD_MIN_HEIGHT);
  const context: RenderContext = {
    color: options.color !== false,
    now: options.now ?? (options.interactive === false ? new Date(0) : new Date()),
    interactive: options.interactive !== false,
    horseFrameIndex: options.horseFrameIndex ?? 0,
    ...(options.navigation === undefined
      ? {}
      : { navigation: options.navigation }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  };
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const scope = resolvedScopeLabel(context.scope) ?? "whole project";
  const header = panel(
    "BARBARO CONTROL",
    [
      `${safe(basename(projectRoot) || projectRoot)}  ${safe(projectRoot)}  ${
        context.interactive ? `attempted ${clockTime(context.now)}` : "snapshot"
      }`,
      `${paint("!", SGR.red, context.color)} Scope ${safe(scope)} · refresh failed; the dashboard will retry`,
    ],
    width,
    context,
  );
  const footer = fit(
    options.interactive === false
      ? "snapshot failed"
      : `q/Ctrl-C quit  ·  r retry  ·  auto ${formatInterval(
          options.refreshIntervalMs ?? 1_000,
        )}`,
    width,
  );
  const available = Math.max(0, height - header.length - 1);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = oneLine(rawMessage) || "Unknown refresh error";
  const bodyRows =
    available >= 3
      ? fixedHeightPanel(
          "ERROR",
          [
            `${paint("!", SGR.red, context.color)} Refresh failed; retained data is unavailable for this frame.`,
            message,
            "The next scheduled or manual refresh can recover in place.",
          ],
          width,
          available,
          context,
        )
      : [`! refresh failed · ${message}`].slice(0, available);
  const body = boundedBody(bodyRows, available, width);
  return finalizeFrame([...header, ...body, footer], width, height);
}

/** Conservative per-pane record capacities used by navigation scrolling. */
export function dashboardNavigationViewports(
  widthValue: number | undefined,
  heightValue: number | undefined,
): NavigationViewportSizes {
  const width = integerDimension(widthValue, 100, DASHBOARD_MIN_WIDTH);
  const height = integerDimension(heightValue, 30, DASHBOARD_MIN_HEIGHT);
  const available = Math.max(0, height - 5);
  if (width >= WIDE_LAYOUT_WIDTH && available >= 14) {
    const topHeight = Math.min(14, Math.max(9, Math.ceil(available * 0.52)));
    return {
      active: recordCapacity(topHeight - 2),
      turns: recordCapacity(available - topHeight - 2),
    };
  }
  if (available >= 12) {
    const panels = stackedPanelHeights(available);
    return {
      active: recordCapacity(panels.active - 2),
      turns: recordCapacity(panels.turns - 2),
    };
  }
  return {
    active: available >= 2 ? 1 : 0,
    turns: available >= 4 ? 1 : 0,
  };
}

function renderHeader(
  model: DashboardViewModel,
  projectRoot: string,
  width: number,
  context: RenderContext,
): string[] {
  const projectedSessions = model.workstreams.reduce(
    (total, workstream) => total + workstream.sessions.length,
    0,
  );
  const hiddenSessionsUnknown =
    model.active.counts.hidden > 0 || model.turns.counts.hidden > 0;
  const sessions = hiddenSessionsUnknown
    ? `${projectedSessions} projected · hidden session count unknown`
    : `${projectedSessions} projected`;
  const scope = scopeLabel(model, context.scope);
  const health = model.diagnostics.healthy
    ? paint("healthy", SGR.green, context.color)
    : paint(
        `${model.diagnostics.issueCount} issue${plural(
          model.diagnostics.issueCount,
        )}`,
        SGR.red,
        context.color,
      );
  return panel(
    "BARBARO CONTROL",
    [
      `${safe(basename(projectRoot) || projectRoot)}  ${safe(projectRoot)}  ${
        context.interactive ? `refreshed ${clockTime(context.now)}` : "snapshot"
      }`,
      `${paint("●", SGR.green, context.color)} Scope ${safe(scope)}  ·  Sessions ${sessions}  ·  Active projected ${projectionCounts(
        model.active.counts,
      )}  ·  Turns projected ${projectionCounts(
        model.turns.counts,
      )}  ·  Store ${health}`,
    ],
    width,
    context,
  );
}

function renderWideBody(
  model: DashboardViewModel,
  available: number,
  width: number,
  context: RenderContext,
): string[] {
  const gap = 1;
  const topHeight = Math.min(14, Math.max(9, Math.ceil(available * 0.52)));
  const showBranding = shouldRenderDashboardBranding({
    width,
    height: available + 5,
    priorityConflict: model.overlaps.length > 0,
    diagnosticsVisible: !model.diagnostics.healthy,
  });
  const dashboardWidth = showBranding
    ? width - gap - DASHBOARD_BRANDING_PANEL_WIDTH
    : width;
  const leftWidth = Math.floor((dashboardWidth - gap) * 0.58);
  const rightWidth = dashboardWidth - gap - leftWidth;
  const turnsHeight = available - topHeight;
  const active = activeViewport(model.active.items, topHeight - 2, context);
  const turns = turnViewport(model.turns.items, turnsHeight - 2, context);
  const primary = mergeColumns(
    fixedHeightPanel(
      paneRecordTitle("ACTIVE", "active", active.onscreen, model.active.counts, context),
      active.rows,
      leftWidth,
      topHeight,
      context,
    ),
    fixedHeightPanel(
      "STATUS + VISIBLE METRICS",
      statusAndMetricRows(model, context),
      rightWidth,
      topHeight,
      context,
    ),
    gap,
  );
  const upper = showBranding
    ? mergeColumns(
        primary,
        fixedHeightPanel(
          context.interactive ? "BARBARO · LIVE" : "BARBARO · STATIC",
          dashboardBrandingRows(context.horseFrameIndex),
          DASHBOARD_BRANDING_PANEL_WIDTH,
          topHeight,
          context,
        ),
        gap,
      )
    : primary;
  return [
    ...upper,
    ...fixedHeightPanel(
      paneRecordTitle(
        "TURNS · grouped",
        "turns",
        turns.onscreen,
        model.turns.counts,
        context,
      ),
      turns.rows,
      width,
      turnsHeight,
      context,
    ),
  ];
}

function renderStackedBody(
  model: DashboardViewModel,
  available: number,
  width: number,
  context: RenderContext,
): string[] {
  const panels = stackedPanelHeights(available);
  const statusHeight = panels.status;
  const activeHeight = panels.active;
  const turnsHeight = panels.turns;
  const active = activeViewport(model.active.items, activeHeight - 2, context);
  const turns = turnViewport(model.turns.items, turnsHeight - 2, context);
  return [
    ...fixedHeightPanel(
      "STATUS + VISIBLE METRICS",
      statusAndMetricRows(model, context),
      width,
      statusHeight,
      context,
    ),
    ...fixedHeightPanel(
      paneRecordTitle("ACTIVE", "active", active.onscreen, model.active.counts, context),
      active.rows,
      width,
      activeHeight,
      context,
    ),
    ...fixedHeightPanel(
      paneRecordTitle(
        "TURNS · grouped",
        "turns",
        turns.onscreen,
        model.turns.counts,
        context,
      ),
      turns.rows,
      width,
      turnsHeight,
      context,
    ),
  ].slice(0, available);
}

function renderCompactBody(
  model: DashboardViewModel,
  available: number,
  width: number,
  context: RenderContext,
): string[] {
  if (available === 0) return [];
  const rows = compactAlertRows(model, context).slice(0, available);
  let remaining = available - rows.length;
  if (remaining === 0) return rows.map((row) => fit(row, width));

  const reserveTurns = remaining >= 3 ? 2 : 0;
  const activeCapacity = Math.max(0, remaining - 1 - reserveTurns);
  const activeStart = paneScrollOffset("active", model.active.items.length, context);
  const compactActors = model.active.items.slice(activeStart);
  const activeOnscreen = Math.min(compactActors.length, activeCapacity);
  rows.push(
    compactPaneRecordTitle(
      "ACTIVE",
      "active",
      activeOnscreen,
      model.active.counts,
      context,
    ),
  );
  if (model.active.items.length === 0 && activeCapacity > 0) {
    rows.push("No live actors");
  } else {
    rows.push(...compactActiveRows(compactActors, context).slice(0, activeOnscreen));
  }

  remaining = available - rows.length;
  if (remaining > 0) {
    const turnCapacity = Math.max(0, remaining - 1);
    const turnsStart = paneScrollOffset("turns", model.turns.items.length, context);
    const compactTurns = model.turns.items.slice(turnsStart);
    const turnOnscreen = Math.min(compactTurns.length, turnCapacity);
    rows.push(
      compactPaneRecordTitle(
        "TURNS",
        "turns",
        turnOnscreen,
        model.turns.counts,
        context,
      ),
    );
    if (model.turns.items.length === 0 && turnCapacity > 0) {
      rows.push("No completed turns yet");
    } else {
      rows.push(...compactTurnRows(compactTurns, context).slice(0, turnOnscreen));
    }
  }

  remaining = available - rows.length;
  if (remaining > 0) {
    rows.push(
      model.diagnostics.healthy
        ? "STORE healthy"
        : `STORE ${model.diagnostics.issueCount} issues`,
    );
  }
  return rows.slice(0, available).map((row) => fit(row, width));
}

function renderDetailBody(
  model: DashboardViewModel,
  available: number,
  width: number,
  context: RenderContext,
): string[] {
  const detail = context.navigation?.detail;
  if (detail === undefined || detail === null) return [];
  if (detail.pane === "active") {
    const actor = model.active.items.find((item) => item.key === detail.recordKey);
    if (actor === undefined) {
      return fixedHeightPanel(
        "DETAIL UNAVAILABLE",
        [
          "The selected active record disappeared during refresh.",
          "Press Escape to return to the reconciled dashboard.",
        ],
        width,
        available,
        context,
      );
    }
    return fixedHeightPanel(
      "DETAIL · ACTIVE ACTOR",
      [
        `${tag(actor.workstream.label, context)} ${identity(
          actor.provider,
          actor.sessionId,
          actor.agentId,
        )}`,
        `State     ${safe(actor.state)} · updated ${relativeTime(
          actor.updatedAt,
          context.now,
        )}`,
        `Action    ${activeAction(actor)}`,
        `Intent    ${
          actor.intent === undefined
            ? "not published"
            : oneLine(actor.intent.text) || "empty"
        }`,
        `Claims    ${claimSummary(actor)}`,
        `Overlaps  ${
          actor.overlapPaths.length === 0
            ? "none visible"
            : actor.overlapPaths.map(oneLine).join(" · ")
        }`,
        "Advisory coordination only · this terminal never locks or writes files.",
      ],
      width,
      available,
      context,
    );
  }

  const turn = model.turns.items.find((item) => item.key === detail.recordKey);
  if (turn === undefined) {
    return fixedHeightPanel(
      "DETAIL UNAVAILABLE",
      [
        "The selected turn disappeared during refresh.",
        "Press Escape to return to the reconciled dashboard.",
      ],
      width,
      available,
      context,
    );
  }
  const actionKinds = new Map<string, number>();
  for (const action of turn.actions.items) {
    actionKinds.set(action.kind, (actionKinds.get(action.kind) ?? 0) + 1);
  }
  return fixedHeightPanel(
    "DETAIL · COMPLETED TURN",
    [
      `${tag(turn.workstream.label, context)} ${identity(
        turn.provider,
        turn.sessionId,
        turn.agentId,
      )} #${turn.sequence}`,
      `Outcome   ${paint(
        safe(turn.outcome),
        outcomeStyle(turn.outcome),
        context.color,
      )} · ended ${relativeTime(turn.endedAt, context.now)}`,
      `Request   ${oneLine(turn.request.text) || "not published"}`,
      `Response  ${
        turn.response === undefined
          ? "not published"
          : oneLine(turn.response.text) || "empty"
      }`,
      `Actions   ${countsText(turn.actions.counts)} · ${mapSummary(actionKinds)}`,
      `Paths     ${turnPathSummary(turn)}`,
      `Subagents ${turn.subagents.total}`,
      "Read-only bounded projection · hidden records remain unknown.",
    ],
    width,
    available,
    context,
  );
}

function activeViewport(
  actors: readonly ActiveActorViewModel[],
  capacity: number,
  context: RenderContext,
): RecordViewport {
  if (actors.length === 0) {
    return {
      rows: [
        "○ No live actors. Advisory presence appears here while sessions are joined.",
        "  Join with /barbaro in Claude Code or $barbaro in Codex.",
      ].slice(0, Math.max(0, capacity)),
      onscreen: 0,
    };
  }
  const start = paneScrollOffset("active", actors.length, context);
  const shownActors = actors.slice(start);
  return recordViewport(
    shownActors.map((actor) => [
      `${selectionMarker(actor.key, "active", context)}${paint("●", SGR.green, context.color)} ${tag(actor.workstream.label, context)} ${identity(
        actor.provider,
        actor.sessionId,
        actor.agentId,
      )} · ${safe(actor.state)} · ${relativeTime(actor.updatedAt, context.now)}`,
      `  action  ${activeAction(actor)}`,
      `  intent  ${actor.intent === undefined ? "not published" : oneLine(actor.intent.text) || "empty"}`,
      `  claims  ${claimSummary(actor)}`,
    ]),
    capacity,
    "actor",
    start,
  );
}

function compactActiveRows(
  actors: readonly ActiveActorViewModel[],
  context: RenderContext,
): string[] {
  if (actors.length === 0) return ["No live actors"];
  return actors.map(
    (actor) =>
      `${selectionMarker(actor.key, "active", context)}${paint("●", SGR.green, context.color)} ${tag(
        actor.workstream.label,
        context,
      )} ${identity(actor.provider, actor.sessionId, actor.agentId)} · ${activeAction(
        actor,
      )}`,
  );
}

function activeAction(actor: ActiveActorViewModel): string {
  const action = actor.currentAction;
  if (action === undefined) return "no current action";
  const tool = action.tool_name === undefined ? "" : `:${safe(action.tool_name)}`;
  const path = action.path === undefined ? "" : ` ${oneLine(action.path)}`;
  const command =
    action.command === undefined ? "" : ` ${oneLine(action.command.text)}`;
  return `${safe(action.kind)}${tool}${path}${command}`.trim();
}

function claimSummary(actor: ActiveActorViewModel): string {
  const parts: string[] = [];
  const { counts } = actor.claims;
  if (counts.shown === 0) {
    parts.push("none visible");
  } else {
    parts.push(countsText(counts));
    const exact = actor.claims.exact[0];
    const inferred = actor.claims.inferred[0];
    if (exact !== undefined) parts.push(`exact ${oneLine(exact.path)}`);
    if (inferred !== undefined) parts.push(`inferred ${oneLine(inferred.path)}`);
    if (actor.claims.items.length > Number(exact !== undefined) + Number(inferred !== undefined)) {
      parts.push("more visible");
    }
  }
  if (actor.unknownWriteScope) parts.push("unknown write scope");
  if (actor.overlapPaths.length > 0) {
    parts.push(`${actor.overlapPaths.length} visible overlap${plural(actor.overlapPaths.length)}`);
  }
  return parts.join(" · ");
}

function turnViewport(
  turns: readonly TurnViewModel[],
  capacity: number,
  context: RenderContext,
): RecordViewport {
  if (turns.length === 0) {
    return {
      rows: [
        "No completed turns yet. Joined sessions appear here after publishing.",
      ].slice(0, Math.max(0, capacity)),
      onscreen: 0,
    };
  }
  const start = paneScrollOffset("turns", turns.length, context);
  const shownTurns = turns.slice(start);
  return recordViewport(shownTurns.map((turn) => {
    const outcome = paint(
      safe(turn.outcome),
      outcomeStyle(turn.outcome),
      context.color,
    );
    const rows = [
      `${selectionMarker(turn.key, "turns", context)}${tag(turn.workstream.label, context)} ${identity(
        turn.provider,
        turn.sessionId,
        turn.agentId,
      )} #${turn.sequence} · ${outcome} · ${relativeTime(
        turn.endedAt,
        context.now,
      )} · actions ${countsText(turn.actions.counts)}`,
      `  request   ${oneLine(turn.request.text) || "not published"}`,
    ];
    if (turn.response !== undefined) {
      rows.push(`  response  ${oneLine(turn.response.text) || "empty"}`);
    }
    rows.push(`  paths     ${turnPathSummary(turn)}`);
    return rows;
  }), capacity, "turn", start);
}

function compactTurnRows(
  turns: readonly TurnViewModel[],
  context: RenderContext,
): string[] {
  if (turns.length === 0) return ["No completed turns yet"];
  return turns.map(
    (turn) =>
      `${selectionMarker(turn.key, "turns", context)}${tag(turn.workstream.label, context)} ${identity(
        turn.provider,
        turn.sessionId,
        turn.agentId,
      )} · ${paint(safe(turn.outcome), outcomeStyle(turn.outcome), context.color)}`,
  );
}

function turnPathSummary(turn: TurnViewModel): string {
  const summary = turn.changedPaths;
  const visible = `${summary.visibleDistinct} visible distinct`;
  const first = summary.items[0];
  const path = first === undefined ? "" : ` · ${oneLine(first)}`;
  return `${visible}${path}${
    summary.complete ? "" : " · hidden path count unknown"
  }`;
}

function statusAndMetricRows(
  model: DashboardViewModel,
  context: RenderContext,
): string[] {
  const alerts = alertRows(model, context);
  const rows =
    alerts.length === 0
      ? [`${paint("✓", SGR.green, context.color)} No visible claim overlaps or unknown write scopes`]
      : alerts;
  rows.push(
    model.diagnostics.healthy
      ? `Store     ${paint("healthy", SGR.green, context.color)} · ${model.diagnostics.feedFiles} feed file${plural(model.diagnostics.feedFiles)}`
      : `Store     ${paint(
          `${model.diagnostics.issueCount} visible issue${plural(
            model.diagnostics.issueCount,
          )}`,
          SGR.red,
          context.color,
        )}`,
    `Outcomes  ${mapSummary(model.metrics.outcomes)}`,
    `Actions   ${mapSummary(model.metrics.actions)} · ${countsText(
      model.metrics.actionVisibility,
    )}`,
    `Providers ${mapSummary(model.metrics.providers)}`,
    `Paths     ${model.metrics.paths.visibleDistinct} visible distinct`,
  );
  if (!model.metrics.paths.complete) rows.push("          hidden path count unknown");
  rows.push(
    `Subagents ${model.metrics.subagents} across visible turns`,
    `Projection ${formatBytes(model.projection.utf8Bytes)}/${formatBytes(
      model.projection.byteBudget,
    )}`,
  );
  return rows;
}

function alertRows(
  model: DashboardViewModel,
  context: RenderContext,
): string[] {
  const rows: string[] = [];
  for (const overlap of model.overlaps) rows.push(...overlapRows(overlap, context));
  for (const actor of model.active.items) {
    if (!actor.unknownWriteScope) continue;
    rows.push(
      `${paint("!", SGR.yellow, context.color)} UNKNOWN WRITE SCOPE · advisory`,
      `  ${tag(actor.workstream.label, context)} ${identity(
        actor.provider,
        actor.sessionId,
        actor.agentId,
      )}`,
    );
  }
  for (const issue of model.diagnostics.issues) {
    rows.push(
      `${paint("!", SGR.red, context.color)} STORE DIAGNOSTIC · ${issue.count} ${safe(
        issue.label,
      )}`,
    );
  }
  return rows;
}

function compactAlertRows(
  model: DashboardViewModel,
  context: RenderContext,
): string[] {
  const rows: string[] = [];
  if (model.overlaps.length > 0) {
    rows.push(
      `${paint("!", SGR.yellow, context.color)} OVERLAP ${oneLine(
        model.overlaps[0]!.path,
      )} · advisory`,
    );
  }
  const unknown = model.active.items.filter((actor) => actor.unknownWriteScope).length;
  if (unknown > 0) rows.push(`! UNKNOWN WRITE SCOPE ${unknown}`);
  if (!model.diagnostics.healthy) {
    rows.push(`! STORE ${model.diagnostics.issueCount} visible issues`);
  }
  return rows;
}

function overlapRows(
  overlap: VisibleClaimOverlap,
  context: RenderContext,
): string[] {
  const claimants = overlap.claimants
    .map(
      (claimant) =>
        `${claimant.workstream.label} ${identity(
          claimant.provider,
          claimant.sessionId,
          claimant.agentId,
        )}`,
    )
    .map(oneLine)
    .join(" ↔ ");
  return [
    `${paint("!", SGR.yellow, context.color)} VISIBLE CLAIM OVERLAP · ${overlap.claimants.length} actors · advisory only`,
    `  ${oneLine(overlap.path)}`,
    `  ${claimants}`,
  ];
}

function mapSummary(counts: ReadonlyMap<string, number>): string {
  if (counts.size === 0) return "none visible";
  return [...counts.entries()]
    .map(([label, count]) => `${oneLine(label)} ${count}`)
    .join(" · ");
}

function identity(provider: string, sessionId: string, agentId: string): string {
  return `${oneLine(provider)} ${shortSession(sessionId)}/${oneLine(agentId)}`;
}

function shortSession(sessionId: string): string {
  const safeId = oneLine(sessionId);
  return safeId.startsWith("ses_") ? safeId.slice(4, 12) : safeId.slice(0, 8);
}

function tag(label: string, context: RenderContext): string {
  return paint(`[${oneLine(label)}]`, SGR.cyan, context.color);
}

function countsText(counts: VisibilityCounts): string {
  return `${counts.shown}/${counts.total}${
    counts.hidden === 0 ? "" : ` · ${counts.hidden} hidden`
  }`;
}

function projectionCounts(counts: VisibilityCounts): string {
  return countsText(counts);
}

function recordTitle(
  label: string,
  onscreen: number,
  counts: VisibilityCounts,
): string {
  return `${label} · ${onscreen} onscreen · projected ${projectionCounts(counts)}`;
}

function compactRecordTitle(
  label: string,
  onscreen: number,
  counts: VisibilityCounts,
): string {
  return `${label} ${onscreen} on · projected ${projectionCounts(counts)}`;
}

function paneRecordTitle(
  label: string,
  pane: TuiPane,
  onscreen: number,
  counts: VisibilityCounts,
  context: RenderContext,
): string {
  const focus =
    context.navigation?.focusedPane === pane
      ? `${paint("▶", SGR.yellow, context.color)} `
      : context.navigation === undefined
        ? ""
        : "  ";
  return `${focus}${recordTitle(label, onscreen, counts)}`;
}

function compactPaneRecordTitle(
  label: string,
  pane: TuiPane,
  onscreen: number,
  counts: VisibilityCounts,
  context: RenderContext,
): string {
  const focus = context.navigation?.focusedPane === pane ? "▶ " : "";
  return `${focus}${compactRecordTitle(label, onscreen, counts)}`;
}

function recordViewport(
  blocks: readonly (readonly string[])[],
  capacity: number,
  noun: string,
  offscreenBefore = 0,
): RecordViewport {
  const limit = Math.max(0, capacity);
  if (limit === 0 || blocks.length === 0) return { rows: [], onscreen: 0 };
  const fullLineCount = blocks.reduce((total, block) => total + block.length, 0);
  if (fullLineCount <= limit && offscreenBefore === 0) {
    return { rows: blocks.flatMap((block) => block), onscreen: blocks.length };
  }

  if (limit === 1) {
    return {
      rows: [`${blocks[0]![0] ?? ""} · viewport bounded`],
      onscreen: 1,
    };
  }

  const contentCapacity = limit - 1;
  const onscreen = Math.min(blocks.length, contentCapacity);
  const selected = blocks.slice(0, onscreen);
  const lineCounts = selected.map(() => 1);
  let detailsCapacity = contentCapacity - onscreen;
  for (let index = 0; index < selected.length && detailsCapacity > 0; index += 1) {
    const extra = Math.min(
      Math.max(0, selected[index]!.length - 1),
      detailsCapacity,
    );
    lineCounts[index] = 1 + extra;
    detailsCapacity -= extra;
  }
  const rows = selected.flatMap((block, index) =>
    block.slice(0, lineCounts[index]),
  );
  const offscreen = offscreenBefore + blocks.length - onscreen;
  const omittedDetails = selected.reduce(
    (total, block, index) => total + Math.max(0, block.length - lineCounts[index]!),
    0,
  );
  const omissions = [
    ...(offscreen === 0
      ? []
      : [`${offscreen} ${noun}${plural(offscreen)} offscreen`]),
    ...(omittedDetails === 0
      ? []
      : [`${omittedDetails} detail line${plural(omittedDetails)} omitted`]),
  ];
  rows.push(`… viewport · ${omissions.join(" · ")}`);
  return { rows, onscreen };
}

function selectionMarker(
  key: string,
  pane: TuiPane,
  context: RenderContext,
): string {
  if (context.navigation === undefined) return "";
  return context.navigation.panes[pane].selectedKey === key
    ? `${paint("›", SGR.yellow, context.color)} `
    : "  ";
}

function paneScrollOffset(
  pane: TuiPane,
  itemCount: number,
  context: RenderContext,
): number {
  const requested = context.navigation?.panes[pane].scrollOffset ?? 0;
  return Math.min(Math.max(0, requested), Math.max(0, itemCount - 1));
}

function scopeLabel(
  model: DashboardViewModel,
  display: DashboardScopeDisplay | undefined,
): string {
  if (
    display !== undefined &&
    model.scope?.scoped === true &&
    model.scope.id === display.workstreamId
  ) {
    return resolvedScopeLabel(display)!;
  }
  return model.scope?.label ?? "whole project";
}

function resolvedScopeLabel(
  display: DashboardScopeDisplay | undefined,
): string | undefined {
  if (display === undefined) return undefined;
  return `${display.name} (${shortWorkstreamLabel(display.workstreamId)})`;
}

function snapshotReferenceTime(model: DashboardViewModel): Date {
  let latest = 0;
  for (const actor of model.active.items) {
    const timestamp = Date.parse(actor.updatedAt);
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  for (const turn of model.turns.items) {
    const timestamp = Date.parse(turn.endedAt);
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return new Date(latest);
}

function panel(
  title: string,
  rows: readonly string[],
  width: number,
  context: RenderContext,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const titlePrefix = clipTerminalText(
    `─ ${paint(safe(title), SGR.boldCyan, context.color)} `,
    innerWidth,
    { ellipsis: "" },
  );
  const top = `┌${titlePrefix}${"─".repeat(
    Math.max(0, innerWidth - terminalCellWidth(titlePrefix)),
  )}┐`;
  return [
    top,
    ...rows.map((row) => `│${fit(` ${row}`, innerWidth)}│`),
    `└${"─".repeat(innerWidth)}┘`,
  ];
}

function fixedHeightPanel(
  title: string,
  rows: readonly string[],
  width: number,
  height: number,
  context: RenderContext,
): string[] {
  if (height <= 0) return [];
  if (height < 3) return rows.slice(0, height).map((row) => fit(row, width));
  const visible = rows.slice(0, height - 2);
  while (visible.length < height - 2) visible.push("");
  return panel(title, visible, width, context);
}

function mergeColumns(
  left: readonly string[],
  right: readonly string[],
  gap: number,
): string[] {
  const height = Math.max(left.length, right.length);
  const leftWidth = left.length === 0 ? 0 : terminalCellWidth(left[0]!);
  const rightWidth = right.length === 0 ? 0 : terminalCellWidth(right[0]!);
  return Array.from({ length: height }, (_, index) => {
    const leftLine = left[index] ?? "";
    const rightLine = right[index] ?? "";
    return `${padTerminalText(leftLine, leftWidth)}${" ".repeat(gap)}${padTerminalText(
      rightLine,
      rightWidth,
    )}`;
  });
}

function finalizeFrame(
  lines: readonly string[],
  width: number,
  height: number,
): string {
  const shown = lines.slice(0, height).map((line) => fit(line, width));
  while (shown.length < height) shown.push(" ".repeat(width));
  return shown.join("\n");
}

function boundedBody(
  rows: readonly string[],
  height: number,
  width: number,
): string[] {
  const shown = rows.slice(0, height).map((row) => fit(row, width));
  while (shown.length < height) shown.push(" ".repeat(width));
  return shown;
}

function fit(text: string, width: number): string {
  return padTerminalText(clipTerminalText(text, width), width);
}

function safe(value: string): string {
  return sanitizeTerminalText(value);
}

function oneLine(value: string): string {
  return safe(value).replace(/\s+/gu, " ").trim();
}

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function outcomeStyle(outcome: string): string {
  if (outcome === "success") return SGR.green;
  if (outcome === "failed") return SGR.red;
  return SGR.yellow;
}

function footerText(
  options: DashboardRenderOptions,
  context: RenderContext,
): string {
  if (options.interactive === false) {
    return "snapshot · run `barbaro tui` for live refresh";
  }
  const interval = formatInterval(options.refreshIntervalMs ?? 1_000);
  if (context.navigation?.detail !== null && context.navigation?.detail !== undefined) {
    return `Esc back · r refresh · q/Ctrl-C quit · auto ${interval}`;
  }
  return `q/Ctrl-C quit · r refresh · Tab/Shift-Tab or ←/→ pane · ↑/↓ or j/k move · Enter detail · auto ${interval}`;
}

function stackedPanelHeights(available: number): {
  readonly status: number;
  readonly active: number;
  readonly turns: number;
} {
  let status = Math.max(4, Math.floor(available * 0.4));
  let active = Math.max(4, Math.floor(available * 0.32));
  let turns = available - status - active;
  while (turns < 3 && status > 4) {
    status -= 1;
    turns += 1;
  }
  while (turns < 3 && active > 4) {
    active -= 1;
    turns += 1;
  }
  return { status, active, turns };
}

function recordCapacity(rowCapacity: number): number {
  if (rowCapacity <= 0) return 0;
  return rowCapacity === 1 ? 1 : rowCapacity - 1;
}

function relativeTime(value: string, now: Date): string {
  const then = Date.parse(value);
  const current = now.getTime();
  if (!Number.isFinite(then) || !Number.isFinite(current)) return "time unknown";
  const seconds = Math.max(0, Math.floor((current - then) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clockTime(now: Date): string {
  if (!Number.isFinite(now.getTime())) return "--:--:--";
  return now.toISOString().slice(11, 19);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1_024) return `${Math.max(0, Math.floor(bytes))} B`;
  return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KiB`;
}

function formatInterval(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

function integerDimension(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
