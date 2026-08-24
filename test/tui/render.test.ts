import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import type {
  ReaderActiveSummary,
  ReaderContextV1,
  ReaderProjection,
  ReaderTurnSummary,
} from "../../src/reader/types.js";
import {
  dashboardNavigationViewports,
  renderDashboard,
  renderDashboardError,
} from "../../src/tui/render.js";
import { buildDashboardViewModel } from "../../src/tui/model.js";
import {
  createNavigationState,
  navigationRecordsFromModel,
  reduceNavigationState,
} from "../../src/tui/state.js";
import {
  DASHBOARD_BRANDING_MIN_HEIGHT,
  DASHBOARD_BRANDING_MIN_WIDTH,
  dashboardBrandingRows,
} from "../../src/tui/branding.js";
import { terminalCellWidth } from "../../src/tui/terminal-text.js";

const NOW = new Date("2026-08-20T20:05:00.000Z");
const SESSION_ID = "ses_11111111111111111111111111111111";
const SECOND_SESSION_ID = "ses_22222222222222222222222222222222";
const WORKSTREAM_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function content(text: string) {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: { canonical: false, projection: false },
    utf8_bytes: { shown: bytes, canonical: bytes, original: bytes },
    redactions: [],
  };
}

function fixture(): ReaderProjection<ReaderContextV1> {
  return {
    byte_budget: 65_536,
    utf8_bytes: 2_345,
    value: {
      schema: "barbaro.reader.context.v1",
      workstream_id: WORKSTREAM_ID,
      active: {
        shown: 1,
        total: 1,
        items: [actor()],
      },
      turns: {
        shown: 1,
        total: 1,
        items: [
          {
            turn_id: "turn_22222222222222222222222222222222",
            provider: "codex",
            session_id: SESSION_ID,
            workstream_id: WORKSTREAM_ID,
            sequence: 7,
            agent_id: "root",
            started_at: "2026-08-20T20:03:00.000Z",
            ended_at: "2026-08-20T20:04:00.000Z",
            outcome: "success",
            request: content("Add a project control terminal"),
            response: content("Implemented the first pass"),
            actions: {
              shown: 2,
              total: 2,
              items: [
                {
                  action_id: "act_11111111111111111111111111111111",
                  kind: "file_change",
                  outcome: "success",
                  source_refs: 1,
                  operation: "create",
                  path: "src/tui/render.ts",
                },
                {
                  action_id: "act_22222222222222222222222222222222",
                  kind: "test",
                  outcome: "success",
                  source_refs: 1,
                  command: content("npm test"),
                  passed: 10,
                  failed: 0,
                },
              ],
            },
            evidence_refs: { shown: 0, total: 0, items: [] },
            subagents: {
              total: 0,
              by_role: [],
              outcomes: {},
              changed_paths: { shown: 0, total: 0, items: [] },
              evidence_refs: { shown: 0, total: 0, items: [] },
            },
            source_refs: 1,
          },
        ],
      },
      diagnostics: {
        feed_files: 2,
        malformed_feed_records: 0,
        invalid_feed_records: 0,
        partial_feed_files: 0,
        scan_limited_feed_files: 0,
        invalid_active_records: 0,
      },
    },
  };
}

function actor(
  overrides: Partial<ReaderActiveSummary> = {},
): ReaderActiveSummary {
  return {
    lease_id: "lease_11111111111111111111111111111111",
    provider: "claude",
    session_id: SESSION_ID,
    workstream_id: WORKSTREAM_ID,
    turn_id: "turn_11111111111111111111111111111111",
    agent_id: "root",
    state: "working",
    intent: content("Implement the dashboard"),
    current_action: {
      kind: "file_change",
      path: "src/tui/render.ts",
    },
    claims: {
      shown: 1,
      total: 1,
      items: [
        {
          path: "src/tui/render.ts",
          mode: "write",
          confidence: "exact",
        },
      ],
    },
    unknown_write_scope: false,
    revision: 3,
    updated_at: "2026-08-20T20:04:55.000Z",
    expires_at: "2026-08-20T20:05:25.000Z",
    source_refs: 1,
    ...overrides,
  };
}

test("wide dashboard centers workstreams, sessions, active work, and bounded metrics", () => {
  const rendered = renderDashboard(fixture(), {
    width: 110,
    height: 28,
    now: NOW,
    projectRoot: "/work/barbaro",
    color: false,
    interactive: false,
  });

  assert.match(rendered, /BARBARO CONTROL/);
  assert.match(rendered, /Sessions 1 projected/);
  assert.match(rendered, /ws_aaaaaaaa/);
  assert.match(rendered, /ACTIVE · 1 onscreen · projected 1\/1/);
  assert.match(rendered, /claude 11111111\/root/);
  assert.match(rendered, /file_change src\/t/);
  assert.match(rendered, /VISIBLE METRICS/);
  assert.match(rendered, /Outcomes\s+success 1/);
  assert.match(rendered, /TURNS · grouped · 1 onscreen · projected 1\/1/);
  assert.match(rendered, /Add a project control terminal/);
  assert.match(rendered, /Store\s+healthy/);
  assert.doesNotMatch(rendered, /\u001b\[/u);
  assertFrame(rendered, 110, 28);
});

test("resolved workstream metadata labels a scoped projection by name and short ID", () => {
  const rendered = renderDashboard(fixture(), {
    width: 160,
    height: 30,
    now: NOW,
    projectRoot: "/work/barbaro",
    color: false,
    scope: {
      name: "tui-design",
      workstreamId: WORKSTREAM_ID,
    },
  });

  assert.match(rendered, /Scope tui-design \(ws_aaaaaaaa\)/u);
  assertFrame(rendered, 160, 30);
});

test("snapshot rendering derives its clock only from the bounded projection", () => {
  const options = {
    width: 110,
    height: 28,
    projectRoot: "/work/barbaro",
    color: false,
    interactive: false,
  } as const;
  const first = renderDashboard(fixture(), options);
  const second = renderDashboard(fixture(), options);

  assert.equal(second, first);
  assert.match(first, /snapshot/u);
  assert.doesNotMatch(first, /refreshed/u);
  assert.match(first, /working · just now/u);
  assert.match(first, /55s ago/u);
  assertFrame(first, 110, 28);
});

test("wide healthy dashboards show only the selected riderless branding frame", () => {
  const rendered = renderDashboard(fixture(), {
    width: DASHBOARD_BRANDING_MIN_WIDTH,
    height: DASHBOARD_BRANDING_MIN_HEIGHT,
    now: NOW,
    color: false,
    horseFrameIndex: 3,
  });
  const riderlessRows = dashboardBrandingRows(3).filter((row) => row.trim());

  assert.match(rendered, /BARBARO · LIVE/u);
  assert.ok(riderlessRows.every((row) => rendered.includes(row)));
  assert.match(rendered, /ACTIVE/u);
  assert.match(rendered, /VISIBLE METRICS/u);
  assert.match(rendered, /TURNS · grouped/u);
  assertFrame(
    rendered,
    DASHBOARD_BRANDING_MIN_WIDTH,
    DASHBOARD_BRANDING_MIN_HEIGHT,
  );

  const belowThreshold = renderDashboard(fixture(), {
    width: DASHBOARD_BRANDING_MIN_WIDTH - 1,
    height: DASHBOARD_BRANDING_MIN_HEIGHT,
    now: NOW,
    color: false,
    horseFrameIndex: 3,
  });
  assert.doesNotMatch(belowThreshold, /BARBARO · LIVE/u);

  const nextFrame = renderDashboard(fixture(), {
    width: DASHBOARD_BRANDING_MIN_WIDTH,
    height: DASHBOARD_BRANDING_MIN_HEIGHT,
    now: NOW,
    color: false,
    horseFrameIndex: 4,
  });
  assert.notEqual(nextFrame, rendered);
});

test("unknown write scope remains visible without suppressing branding", () => {
  const projection = fixture();
  const warned: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      active: {
        shown: 1,
        total: 1,
        items: [actor({ unknown_write_scope: true })],
      },
    },
  };
  const rendered = renderDashboard(warned, {
    width: DASHBOARD_BRANDING_MIN_WIDTH,
    height: DASHBOARD_BRANDING_MIN_HEIGHT,
    now: NOW,
    color: false,
  });

  assert.match(rendered, /UNKNOWN WRITE SCOPE/u);
  assert.match(rendered, /BARBARO · LIVE/u);
  assertFrame(
    rendered,
    DASHBOARD_BRANDING_MIN_WIDTH,
    DASHBOARD_BRANDING_MIN_HEIGHT,
  );
});

test("stacked and compact dashboards stay inside their terminal", () => {
  for (const [width, height, expected] of [
    [80, 24, /VISIBLE METRICS/],
    [42, 12, /ACTIVE 1 on · projected 1\/1/],
    [12, 6, /ACT/],
  ] as const) {
    const rendered = renderDashboard(fixture(), {
      width,
      height,
      now: NOW,
      color: false,
    });
    assertFrame(rendered, width, height);
    assert.match(rendered, expected);
    assert.match(rendered.split("\n").at(-1)!, /q\/Ctrl-C/u);
  }
});

test("visible cross-session claim overlaps are advisory and prominent", () => {
  const projection = fixture();
  const secondWithScope = actor({
    lease_id: "lease_22222222222222222222222222222222",
    provider: "codex",
    session_id: SECOND_SESSION_ID,
    agent_id: "main",
    intent: content("Review the same renderer"),
    unknown_write_scope: true,
    revision: 1,
  });
  const { workstream_id: _secondWorkstream, ...second } = secondWithScope;
  const { workstream_id: _projectionWorkstream, ...unscopedContext } =
    projection.value;
  const changed: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...unscopedContext,
      active: { shown: 2, total: 3, items: [projection.value.active.items[0]!, second] },
    },
  };

  const rendered = renderDashboard(changed, {
    width: 120,
    height: 30,
    now: NOW,
    color: false,
  });
  assert.match(rendered, /VISIBLE CLAIM OVERLAP/);
  assert.match(rendered, /src\/tui\/render\.ts/);
  assert.match(rendered, /advisory/i);
  assert.match(rendered, /ws_aaaaaaaa/);
  assert.match(rendered, /unscoped/);
  assert.match(rendered, /UNKNOWN WRITE SCOPE/);
  assert.match(rendered, /1 hidden/);
});

test("store diagnostics stay visible as concrete, counted issues", () => {
  const projection = fixture();
  const changed: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      diagnostics: {
        ...projection.value.diagnostics,
        malformed_feed_records: 2,
        scan_limited_feed_files: 1,
      },
    },
  };

  const rendered = renderDashboard(changed, {
    width: 120,
    height: 30,
    now: NOW,
    color: false,
  });
  assert.match(rendered, /STORE DIAGNOSTIC · 2 malformed feed/);
  assert.match(rendered, /STORE DIAGNOSTIC · 1 scan limited/);
  assert.match(rendered, /Store\s+3 visible issues/);
  assertFrame(rendered, 120, 30);
});

test("projection limits stay explicit without inventing hidden distinct paths", () => {
  const projection = fixture();
  const turn = projection.value.turns.items[0]!;
  const changed: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      active: {
        shown: 1,
        total: 4,
        items: [
          actor({
            claims: {
              shown: 1,
              total: 3,
              items: actor().claims.items,
            },
          }),
        ],
      },
      turns: {
        shown: 1,
        total: 6,
        items: [
          {
            ...turn,
            actions: { ...turn.actions, total: 5 },
            subagents: {
              ...turn.subagents,
              changed_paths: {
                shown: 1,
                total: 4,
                items: ["src/tui/model.ts"],
              },
            },
          },
        ],
      },
    },
  };

  const rendered = renderDashboard(changed, {
    width: 120,
    height: 32,
    now: NOW,
    color: false,
  });
  assert.match(rendered, /ACTIVE · 1 onscreen · projected 1\/4 · 3 hidden/);
  assert.match(
    rendered,
    /TURNS · grouped · 1 onscreen · projected 1\/6 · 5 hidden/,
  );
  assert.match(rendered, /hidden session count unknown/);
  assert.match(rendered, /Paths\s+2 visible distinct/);
  assert.match(rendered, /hidden path count unknown/i);
  assert.doesNotMatch(rendered, /[3-9] distinct in visible window/);
});

test("viewport omissions count records without cutting their blocks silently", () => {
  const projection = fixture();
  const baseTurn = projection.value.turns.items[0]!;
  const actors = Array.from({ length: 6 }, (_, index) =>
    actor({
      lease_id: `lease_${String(index + 3).repeat(32)}`,
      session_id: `ses_${String(index + 3).repeat(32)}`,
      agent_id: `worker-${index + 1}`,
    }),
  );
  const turns: ReaderTurnSummary[] = Array.from({ length: 5 }, (_, index) => ({
    ...baseTurn,
    turn_id: `turn_${String(index + 3).repeat(32)}`,
    session_id: `ses_${String(index + 3).repeat(32)}`,
    sequence: index + 1,
    request: content(`request ${index + 1}`),
  }));
  const crowded: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      active: { shown: actors.length, total: actors.length, items: actors },
      turns: { shown: turns.length, total: turns.length, items: turns },
    },
  };

  const rendered = renderDashboard(crowded, {
    width: 100,
    height: 18,
    now: NOW,
    color: false,
  });
  assert.match(rendered, /ACTIVE · 1 onscreen · projected 6\/6/);
  assert.match(rendered, /5 actors offscreen/);
  assert.match(rendered, /TURNS · grouped · 1 onscreen · projected 5\/5/);
  assert.match(rendered, /4 turns offscreen/);
  assertFrame(rendered, 100, 18);
});

test("untrusted projection text cannot inject controls or semantic colors", () => {
  const projection = fixture();
  const turn = projection.value.turns.items[0]!;
  const hostile = "working failed success healthy\u001b[2J\u001b]2;owned\u0007\r\nnext\tfield";
  const hostileActorWithAction = actor({
    intent: content(hostile),
    claims: {
      shown: 1,
      total: 1,
      items: [{ path: `safe${hostile}.ts`, mode: "write", confidence: "exact" }],
    },
  });
  const { current_action: _hostileAction, ...hostileActor } =
    hostileActorWithAction;
  const changed: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      active: {
        shown: 1,
        total: 1,
        items: [hostileActor],
      },
      turns: {
        shown: 1,
        total: 1,
        items: [{ ...turn, request: content(hostile) }],
      },
    },
  };

  const rendered = renderDashboard(changed, {
    width: 110,
    height: 28,
    now: NOW,
    color: true,
  });
  assert.doesNotMatch(rendered, /\u001b\[2J|\u001b\]|\u0007|\r|\t/u);
  assert.doesNotMatch(rendered, /\u001b\[31mfailed/u);
  assert.match(rendered, /intent  working failed success healthy next field/);
  assert.match(rendered, /request   working failed success healthy next field/);
  const withoutGeneratedSgr = stripSgr(rendered).replaceAll("\n", "");
  assert.doesNotMatch(withoutGeneratedSgr, /[\u0000-\u001f\u007f-\u009f]/u);
  assertFrame(rendered, 110, 28);
});

test("color is semantic-only and does not change text or cell geometry", () => {
  const projection = fixture();
  const unicodeActorWithAction = actor({
    intent: content("Combine e\u0301 with 表 and 👩‍💻"),
  });
  const { current_action: _unicodeAction, ...unicodeActor } =
    unicodeActorWithAction;
  const unicodeProjection: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      active: {
        shown: 1,
        total: 1,
        items: [unicodeActor],
      },
    },
  };
  const options = {
    width: 80,
    height: 24,
    now: NOW,
    projectRoot: "/work/项目🙂",
  } as const;
  const plain = renderDashboard(unicodeProjection, { ...options, color: false });
  const colored = renderDashboard(unicodeProjection, { ...options, color: true });
  assert.equal(stripSgr(colored), plain);
  assertFrame(plain, 80, 24);
  assertFrame(colored, 80, 24);
});

test("refresh errors are sanitized, responsive, and recoverable-looking", () => {
  const rendered = renderDashboardError(
    new Error("bad\u001b[2J\u001b]8;;https://evil.invalid\u0007link\u001b]8;;\u0007\nnext"),
    {
      width: 42,
      height: 12,
      now: NOW,
      projectRoot: "/work/barbaro",
      color: true,
    },
  );
  assert.match(stripSgr(rendered), /refresh failed/);
  assert.match(stripSgr(rendered), /attempted/u);
  assert.doesNotMatch(stripSgr(rendered), /refreshed/u);
  assert.match(stripSgr(rendered).split("\n").at(-1)!, /q\/Ctrl-C/u);
  assert.doesNotMatch(rendered, /\u001b\[2J|\u001b\]|\u0007/u);
  assertFrame(rendered, 42, 12);
});

test("leading combining marks cannot attach to panel borders", () => {
  const rendered = renderDashboardError(new Error("\u0301bad"), {
    width: 42,
    height: 12,
    now: NOW,
    projectRoot: "/work/\u0301project",
    color: false,
  });
  assert.match(rendered, /│ \u0301project/);
  assert.match(rendered, /│ \u0301bad/);
  assertFrame(rendered, 42, 12);
});

test("navigation focus, selection, and scrolled records are visible", () => {
  const projection = fixture();
  const actors = [
    actor({ agent_id: "first" }),
    actor({
      lease_id: "lease_22222222222222222222222222222222",
      session_id: SECOND_SESSION_ID,
      agent_id: "second",
      claims: { shown: 0, total: 0, items: [] },
    }),
  ];
  const crowded: ReaderProjection<ReaderContextV1> = {
    ...projection,
    value: {
      ...projection.value,
      active: { shown: 2, total: 2, items: actors },
    },
  };
  const records = navigationRecordsFromModel(
    buildDashboardViewModel(crowded),
  );
  let navigation = createNavigationState(records.active, records.turns, {
    viewports: { active: 1, turns: 1 },
  });
  navigation = reduceNavigationState(navigation, {
    type: "move-selection",
    delta: 1,
  });

  const rendered = renderDashboard(crowded, {
    width: 100,
    height: 18,
    now: NOW,
    color: false,
    navigation,
  });
  assert.match(rendered, /▶ ACTIVE/);
  assert.match(rendered, /› ● \[ws_aaaaaaaa\] claude 22222222\/second/);
  assert.match(rendered, /1 actor offscreen/);
  assert.doesNotMatch(rendered, /claude 11111111\/first/);
  assertFrame(rendered, 100, 18);
});

test("detail view follows the selected stable record and exposes safe facts", () => {
  const projection = fixture();
  const records = navigationRecordsFromModel(
    buildDashboardViewModel(projection),
  );
  let navigation = createNavigationState(records.active, records.turns, {
    viewports: { active: 2, turns: 2 },
  });
  navigation = reduceNavigationState(navigation, { type: "open-detail" });

  const rendered = renderDashboard(projection, {
    width: 80,
    height: 24,
    now: NOW,
    color: false,
    navigation,
  });
  assert.match(rendered, /DETAIL · ACTIVE ACTOR/);
  assert.match(rendered, /Intent\s+Implement the dashboard/);
  assert.match(rendered, /Claims\s+1\/1 · exact src\/tui\/render\.ts/);
  assert.match(rendered, /Advisory coordination only/);
  assert.match(rendered.split("\n").at(-1)!, /Esc back/);
  assertFrame(rendered, 80, 24);
});

test("navigation viewport geometry follows wide, stacked, and compact layouts", () => {
  const wide = dashboardNavigationViewports(110, 30);
  const stacked = dashboardNavigationViewports(80, 24);
  const compact = dashboardNavigationViewports(42, 12);
  const tiny = dashboardNavigationViewports(12, 6);

  assert.ok((wide.active ?? 0) > 1);
  assert.ok((wide.turns ?? 0) > 1);
  assert.ok((stacked.active ?? 0) >= 1);
  assert.ok((stacked.turns ?? 0) >= 1);
  assert.deepEqual(compact, { active: 1, turns: 1 });
  assert.deepEqual(tiny, { active: 0, turns: 0 });
});

test("tui --once is a noninteractive snapshot for empty projects", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-tui-cli-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const output: string[] = [];
  const errors: string[] = [];
  const code = await main(
    ["tui", "--once", "--project-root", project],
    {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output.join(""), /No live actors/);
  assert.match(output.join(""), /No completed turns yet/);
  assert.match(output.join(""), /snapshot/);
  assert.doesNotMatch(output.join(""), /\u001b\[/u);
  assertFrame(output.join("").replace(/\n$/u, ""), 100, 30);
});

function assertFrame(rendered: string, width: number, height: number): void {
  const lines = rendered.split("\n");
  assert.equal(lines.length, height);
  assert.ok(
    lines.every((line) => terminalCellWidth(line) === width),
    `expected every row to occupy ${width} cells; received ${JSON.stringify(
      lines.map((line) => terminalCellWidth(line)),
    )}`,
  );
}

function stripSgr(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/gu, "");
}
