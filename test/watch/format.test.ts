import assert from "node:assert/strict";
import test from "node:test";

import type { BarbaroContent, BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { projectTurn } from "../../src/reader/projection.js";
import {
  WATCH_EVENT_SCHEMA,
  formatWatchEvent,
  type WatchTurnEvent,
} from "../../src/watch/index.js";

const SES = `ses_${"a".repeat(32)}`;
const OBSERVED_AT = "2026-08-19T06:00:00.000Z";

function content(
  text: string,
  overrides: Partial<BarbaroContent> = {},
): BarbaroContent {
  return {
    text,
    fidelity: "verbatim",
    truncated: false,
    redactions: [],
    ...overrides,
  };
}

function turnRecord(
  options: {
    readonly request?: BarbaroContent;
    readonly response?: BarbaroContent;
    readonly actions?: BarbaroTurnV1["actions"];
  } = {},
): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${"1".repeat(32)}`,
    provider: "claude",
    session_id: SES,
    sequence: 3,
    agent_id: "main",
    started_at: "2026-08-19T05:59:00.000Z",
    ended_at: "2026-08-19T05:59:30.000Z",
    outcome: "success",
    request: options.request ?? content("hello world"),
    ...(options.response === undefined
      ? {}
      : { response: options.response }),
    actions: options.actions ?? [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [],
  };
}

function turnEvent(turn: BarbaroTurnV1): WatchTurnEvent {
  return {
    schema: WATCH_EVENT_SCHEMA,
    kind: "turn",
    observed_at: OBSERVED_AT,
    provider: turn.provider,
    session_id: turn.session_id,
    turn: projectTurn(turn, { byteBudget: 4_096 }),
  };
}

test("a turn line leads with what happened and what was touched", () => {
  const turn = turnRecord({
    actions: [
      {
        action_id: `act_${"2".repeat(32)}`,
        kind: "tool",
        tool_name: "Bash",
        outcome: "unknown",
        source_refs: [],
      },
      {
        action_id: `act_${"3".repeat(32)}`,
        kind: "tool",
        tool_name: "Bash",
        outcome: "unknown",
        source_refs: [],
      },
      {
        action_id: `act_${"4".repeat(32)}`,
        kind: "file_change",
        operation: "modify",
        path: "src/a.ts",
        outcome: "success",
        source_refs: [],
      },
    ],
    response: content("done"),
  });
  assert.equal(
    formatWatchEvent(turnEvent(turn)),
    [
      `TURN [claude ses_aaaaaaaa] seq=3 success changed=src/a.ts did=Bash×2,file_change`,
      `  req: hello world`,
      `  say: done`,
    ].join("\n"),
  );
});

test("a turn whose text was all machinery reports its byte count", () => {
  const turn = turnRecord({
    request: content("", {
      fidelity: "normalized",
      original_utf8_bytes: 80,
    }),
  });
  assert.equal(
    formatWatchEvent(turnEvent(turn)),
    [
      `TURN [claude ses_aaaaaaaa] seq=3 success`,
      `  req: (80 bytes, no publishable text)`,
      `  say: (no response recorded)`,
    ].join("\n"),
  );
});

test("the armed banner reports presence and enrollment separately", () => {
  assert.equal(
    formatWatchEvent({
      schema: WATCH_EVENT_SCHEMA,
      kind: "armed",
      observed_at: OBSERVED_AT,
      live_sessions: 2,
      enrolled_sessions: 9,
      self_session_id: SES,
    }),
    "WATCH armed self=ses_aaaaaaaa live=2 enrolled=9 — turns, joins, incidents, stale leases",
  );
});

test("a stale line states expiry without claiming the peer died", () => {
  assert.equal(
    formatWatchEvent({
      schema: WATCH_EVENT_SCHEMA,
      kind: "stale",
      observed_at: OBSERVED_AT,
      provider: "claude",
      session_id: SES,
      agent_id: "main",
      last_state: "working",
      updated_at: "2026-08-19T05:55:00.000Z",
      expires_at: "2026-08-19T05:59:26.000Z",
      lapsed_ms: 34_000,
      claims: 2,
      unknown_write_scope: false,
      current_action: { kind: "tool", tool_name: "Bash" },
    }),
    "STALE [claude ses_aaaaaaaa/main] lease expired 34s ago last_state=working " +
      "claims=2 action=tool:Bash — nothing renewed it; its claims are no longer current",
  );
});

test("join, incident, and error lines are compact and self-contained", () => {
  assert.equal(
    formatWatchEvent({
      schema: WATCH_EVENT_SCHEMA,
      kind: "join",
      observed_at: OBSERVED_AT,
      provider: "codex",
      session_id: SES,
      joined_at: "2026-08-19T05:58:00.000Z",
      initiated_by: "user_prompt",
    }),
    "JOIN [codex ses_aaaaaaaa] at=2026-08-19T05:58:00.000Z via=user_prompt",
  );
  assert.equal(
    formatWatchEvent({
      schema: WATCH_EVENT_SCHEMA,
      kind: "incident",
      observed_at: OBSERVED_AT,
      provider: "claude",
      incident_id: "0".repeat(32),
      incident_kind: "hook_error",
      event: "Stop",
      occurred_at: "2026-08-19T05:57:00.000Z",
    }),
    "INCIDENT [claude hook_error] event=Stop at=2026-08-19T05:57:00.000Z",
  );
  assert.equal(
    formatWatchEvent({
      schema: WATCH_EVENT_SCHEMA,
      kind: "incident",
      observed_at: OBSERVED_AT,
      provider: "claude",
      incident_id: "0".repeat(32),
      incident_kind: "session_dormant",
      occurred_at: "2026-08-19T05:57:00.000Z",
    }),
    "INCIDENT [claude session_dormant] at=2026-08-19T05:57:00.000Z",
  );
  assert.equal(
    formatWatchEvent({
      schema: WATCH_EVENT_SCHEMA,
      kind: "error",
      observed_at: OBSERVED_AT,
      message: "boom",
      consecutive: 2,
      limit: 5,
    }),
    "WATCH-ERROR boom (2/5)",
  );
});

test("scoped events carry a short ws= tag; unscoped ones do not", () => {
  const base = {
    schema: WATCH_EVENT_SCHEMA,
    kind: "turn" as const,
    observed_at: OBSERVED_AT,
    provider: "claude",
    session_id: SES,
    turn: projectTurn(turnRecord(), { byteBudget: 4_096 }),
  };
  const scoped: WatchTurnEvent = {
    ...base,
    workstream_id: "ws_7a3f45e168afe2d2c616bc2956aeef66",
  };
  assert.match(formatWatchEvent(scoped), /^TURN \[claude ses_aaaaaaaa ws=7a3f45e1\] /u);
  assert.doesNotMatch(formatWatchEvent(base), /ws=/u);
});
