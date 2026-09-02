import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReaderCatalogueAttentionItem,
  ReaderCatalogueRoll,
  ReaderCatalogueWorkstream,
} from "../../src/reader/catalogue.js";
import type { ReaderPublishSummary } from "../../src/reader/publish.js";
import type { ReaderUnreadSummary } from "../../src/reader/unread.js";
import {
  comfortTermRefusal,
  runComfortTui,
  type ComfortAppOptions,
} from "../../src/tui/comfort-app.js";
import { COMFORT_SCREEN_SEQUENCES } from "../../src/tui/comfort-screen.js";
import { HORSE_FRAME_COUNT } from "../../src/tui/horse.js";
import {
  SESSION_PROVENANCE_DIM,
  SELECTED_HUB_ROW_COLOR,
  SGR_RESET,
} from "../../src/tui/style.js";
import {
  collection,
  makeCatalogue,
  makeHealth,
  makeItem,
  projection,
  FIXTURE_WS,
} from "./comfort-fixtures.js";
import { readFixture } from "./fixtures.test.js";

function makeRoll(options: {
  readonly provider: string;
  readonly sessionId: string;
  readonly working?: boolean;
  readonly lastSequence?: number;
}): ReaderCatalogueRoll {
  const leases = options.working === true
    ? [
        {
          agent_id: "main",
          state: "working" as const,
          updated_at: "2026-08-25T11:59:00.000Z",
          expires_at: "2026-08-25T12:05:00.000Z",
          unknown_write_scope: false,
          claim_count: 0,
        },
      ]
    : [];
  const lastTurn = options.lastSequence === undefined
    ? undefined
    : {
        provider: options.provider,
        session_id: options.sessionId,
        turn_id: `trn_${options.lastSequence}`,
        sequence: options.lastSequence,
        outcome: "success",
        ended_at: "2026-08-25T11:58:00.000Z",
      };
  return {
    provider: options.provider,
    session_id: options.sessionId,
    current_enrollment: true,
    in_participation: true,
    in_active: leases.length > 0,
    in_turns: lastTurn !== undefined,
    state_counts: {
      working: leases.length,
      waiting: 0,
      blocked: 0,
    },
    leases: collection(leases),
    turns: {
      shown: lastTurn === undefined ? 0 : 1,
      total: lastTurn === undefined ? 0 : 1,
      hidden: 0,
      read_state: "ok",
      coverage: { state: "complete" },
    },
    ...(lastTurn === undefined ? {} : { last_turn: lastTurn }),
  };
}

function makeUnread(options: {
  readonly workstreamId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly count: number;
}): ReaderUnreadSummary {
  return {
    key: {
      provider: options.provider,
      session_id: options.sessionId,
      workstream_id: options.workstreamId,
      membership_from: "2026-08-25T09:00:00.000Z",
    },
    cursor_state: "persisted",
    read_state: "ok",
    coverage: { state: "complete" },
    status: "ready",
    unread_count: options.count,
  };
}

interface Harness {
  readonly options: ComfortAppOptions;
  readonly writes: string[];
  readonly errors: string[];
  feed(text: string): void;
  fireTimeout(): void;
  resize(columns: number, rows: number): void;
  setAbsent(absent: boolean): void;
  setCatalogue(catalogue: ReturnType<typeof makeCatalogue>): void;
  queueCatalogueRead(
    catalogue: ReturnType<typeof makeCatalogue>,
    gate?: Promise<void>,
  ): void;
  queueCatalogueFailure(error: Error, gate?: Promise<void>): void;
  setContextError(error: Error | undefined): void;
  setContextGate(gate: Promise<void> | undefined): void;
  setContextTurns(turns: readonly HarnessContextTurn[]): void;
  setHealthError(error: Error | undefined): void;
  advanceTime(milliseconds: number): void;
  fireTimers(delayMs: number, times?: number): void;
  timerCount(delayMs: number): number;
  timerDelays(): number[];
  readonly counters: { health: number; catalogue: number; context: number };
  readonly readerWindows: {
    readonly catalogue: number[];
    readonly context: number[];
  };
}

interface HarnessContextTurn {
  readonly turnId?: string;
  readonly provider?: string;
  readonly sessionId?: string;
  readonly sequence: number;
  readonly outcome: string;
  readonly endedAt: string;
  readonly request: string;
  readonly response?: string;
  readonly requestTruncated?: boolean;
  readonly responseTruncated?: boolean;
}

function harnessContent(text: string, truncated = false) {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: { canonical: truncated, projection: false },
    utf8_bytes: { shown: bytes, canonical: bytes, original: bytes },
    redactions: [],
  };
}

function makeHarness(
  overrides: Partial<ComfortAppOptions> & {
    readonly catalogue?: ReturnType<typeof makeCatalogue>;
    readonly absent?: boolean;
    readonly healthGate?: Promise<void>;
    readonly healthError?: Error;
    readonly contextGate?: Promise<void>;
    readonly contextError?: Error;
  } = {},
): Harness {
  const writes: string[] = [];
  const errors: string[] = [];
  const dataListeners: Array<(chunk: Buffer | string) => void> = [];
  const resizeListeners: Array<() => void> = [];
  const timers = new Map<
    unknown,
    { readonly delayMs: number; readonly callback: () => void }
  >();
  let nextTimer = 1;
  let timeoutCallback: (() => void) | undefined;
  let nowMs = 0;
  let storeAbsent = overrides.absent ?? false;
  let healthError = overrides.healthError;
  let contextGate = overrides.contextGate;
  let contextError = overrides.contextError;
  let contextTurns: readonly HarnessContextTurn[] = [];
  const counters = { health: 0, catalogue: 0, context: 0 };
  const readerWindows = { catalogue: [] as number[], context: [] as number[] };
  const size = { columns: 80, rows: 30 };
  let catalogue =
    overrides.catalogue ?? makeCatalogue([makeItem({ working: 1 })]);
  const queuedCatalogueReads: Array<{
    readonly catalogue?: ReturnType<typeof makeCatalogue>;
    readonly error?: Error;
    readonly gate?: Promise<void>;
  }> = [];

  const options: ComfortAppOptions = {
    projectRoot: "/tmp/comfort-project",
    term: "xterm-256color",
    stderr: (line) => errors.push(line),
    input: {
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (_event, listener) => dataListeners.push(listener),
      off: () => undefined,
    },
    output: {
      get columns() {
        return size.columns;
      },
      get rows() {
        return size.rows;
      },
      write: (chunk) => writes.push(chunk),
      on: (_event, listener) => resizeListeners.push(listener),
      off: () => undefined,
    },
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
    monotonicNow: () => nowMs,
    setInterval: (callback, delayMs) => {
      const handle = nextTimer;
      nextTimer += 1;
      timers.set(handle, { delayMs, callback });
      return handle;
    },
    clearInterval: (handle) => {
      timers.delete(handle);
    },
    setTimeout: (callback) => {
      timeoutCallback = callback;
      return 0;
    },
    clearTimeout: () => {
      timeoutCallback = undefined;
    },
    readers: {
      readHealth: async () => {
        counters.health += 1;
        await overrides.healthGate;
        if (healthError !== undefined) throw healthError;
        return projection(makeHealth(storeAbsent ? "absent" : "present"));
      },
      readCatalogue: async (_projectRoot, options) => {
        counters.catalogue += 1;
        if (options.turnsPerSession !== undefined) {
          readerWindows.catalogue.push(options.turnsPerSession);
        }
        const queued = queuedCatalogueReads.shift();
        if (queued !== undefined) {
          await queued.gate;
          if (queued.error !== undefined) throw queued.error;
          return projection(queued.catalogue!);
        }
        return projection(catalogue);
      },
      readContext: (async (
        _projectRoot: string,
        options: { readonly turnsPerSession?: number },
      ) => {
        counters.context += 1;
        await contextGate;
        if (contextError !== undefined) throw contextError;
        if (options.turnsPerSession !== undefined) {
          readerWindows.context.push(options.turnsPerSession);
        }
        return projection({
          schema: "barbaro.reader.context.v1",
          active: { items: [], shown: 0, total: 0 },
          turns: {
            items: contextTurns.map((turn) => ({
              turn_id: turn.turnId ?? `turn_harness_${turn.sequence}`,
              provider: turn.provider ?? "codex",
              session_id: turn.sessionId ?? `ses_${"1".repeat(32)}`,
              sequence: turn.sequence,
              agent_id: "main",
              started_at: turn.endedAt,
              outcome: turn.outcome,
              ended_at: turn.endedAt,
              request: harnessContent(
                turn.request,
                turn.requestTruncated ?? false,
              ),
              ...(turn.response === undefined
                ? {}
                : {
                    response: harnessContent(
                      turn.response,
                      turn.responseTruncated ?? false,
                    ),
                  }),
            })),
            shown: contextTurns.length,
            total: contextTurns.length,
          },
          diagnostics: {
            feed_files: 0,
            malformed_feed_records: 0,
            invalid_feed_records: 0,
            partial_feed_files: 0,
            scan_limited_feed_files: 0,
            invalid_active_records: 0,
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    ...overrides,
  };

  return {
    options,
    writes,
    errors,
    counters,
    readerWindows,
    feed: (text) => {
      for (const listener of dataListeners) listener(text);
    },
    fireTimeout: () => {
      const callback = timeoutCallback;
      timeoutCallback = undefined;
      callback?.();
    },
    resize: (columns, rows) => {
      size.columns = columns;
      size.rows = rows;
      for (const listener of resizeListeners) listener();
    },
    setAbsent: (absent) => {
      storeAbsent = absent;
    },
    setCatalogue: (value) => {
      catalogue = value;
    },
    queueCatalogueRead: (value, gate) => {
      queuedCatalogueReads.push({
        catalogue: value,
        ...(gate === undefined ? {} : { gate }),
      });
    },
    queueCatalogueFailure: (error, gate) => {
      queuedCatalogueReads.push({
        error,
        ...(gate === undefined ? {} : { gate }),
      });
    },
    setContextError: (error) => {
      contextError = error;
    },
    setContextGate: (gate) => {
      contextGate = gate;
    },
    setContextTurns: (turns) => {
      contextTurns = turns;
    },
    setHealthError: (error) => {
      healthError = error;
    },
    advanceTime: (milliseconds) => {
      nowMs += milliseconds;
    },
    fireTimers: (delayMs, times = 1) => {
      for (let step = 0; step < times; step += 1) {
        nowMs += delayMs;
        for (const timer of [...timers.values()]) {
          if (timer.delayMs === delayMs) timer.callback();
        }
      }
    },
    timerCount: (delayMs) =>
      [...timers.values()].filter((timer) => timer.delayMs === delayMs).length,
    timerDelays: () => [...timers.values()].map((timer) => timer.delayMs),
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
  }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release?.() };
}

function deferredValue<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let release: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: (value) => release?.(value) };
}

async function completeBoot(harness: Harness): Promise<void> {
  await settle();
  harness.fireTimers(100, HORSE_FRAME_COUNT);
  await settle();
}

function fixtureFrame(draw: string): string {
  const cursorHome = "\u001b[H";
  const eraseBelow = "\u001b[J";
  assert.ok(draw.startsWith(cursorHome));
  assert.ok(draw.endsWith(eraseBelow));
  return `${draw
    .slice(cursorHome.length, -eraseBelow.length)
    .replaceAll("\r\n", "\n")}\n`;
}

function assertIncludesLines(
  frame: string,
  expected: readonly string[],
): void {
  for (const line of expected) {
    assert.ok(frame.includes(line), `missing screen line: ${line}`);
  }
}

test("TERM=dumb is refused with the exact lines and zero terminal bytes", async () => {
  const harness = makeHarness({ term: "dumb" });
  const code = await runComfortTui(harness.options);
  assert.equal(code, 2);
  assert.deepEqual(harness.errors, [
    "barbaro tui: TERM=dumb cannot support interactive mode.",
    "Use: barbaro tui --once [--width N --height N]",
    "No alternate-screen, cursor, raw-mode, color, or animation bytes were emitted.",
  ]);
  assert.deepEqual(harness.writes, []);
  for (const line of harness.errors) {
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/u);
  }
});

test("an unset TERM gets the truthful first line and the same rule", async () => {
  const harness = makeHarness({ term: undefined });
  const code = await runComfortTui(harness.options);
  assert.equal(code, 2);
  assert.equal(
    harness.errors[0],
    "barbaro tui: TERM is unset; interactive mode requires a capable terminal.",
  );
  assert.deepEqual(harness.writes, []);
  assert.equal(comfortTermRefusal("xterm"), undefined);
});

test("q quits with SGR reset strictly before leaving the alternate screen", async () => {
  const harness = makeHarness();
  const run = runComfortTui(harness.options);
  await settle();
  harness.feed("q");
  assert.equal(await run, 0);
  assert.equal(harness.writes[0], COMFORT_SCREEN_SEQUENCES.enter);
  const leave = harness.writes[harness.writes.length - 1]!;
  assert.equal(leave, COMFORT_SCREEN_SEQUENCES.leave);
  const resetIndex = leave.indexOf(COMFORT_SCREEN_SEQUENCES.sgrReset);
  const leaveIndex = leave.indexOf(COMFORT_SCREEN_SEQUENCES.leaveAlternate);
  assert.ok(resetIndex !== -1 && leaveIndex !== -1 && resetIndex < leaveIndex);
});

test("an absent store is the No film loaded screen and reads no catalogue", async () => {
  const harness = makeHarness({ absent: true });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const frame = harness.writes.join("");
  assert.match(frame, /No film loaded/u);
  assert.match(frame, /Press n to create this project's first workstream\./u);
  assert.match(frame, /That establishes Barbaro here\./u);
  assert.match(frame, /Creation enrolls no sessions\./u);
  assert.match(frame, /n new workstream · r refresh · q quit/u);
  assert.equal(harness.counters.catalogue, 0);

  harness.resize(40, 12);
  assert.match(
    harness.writes.at(-1)!,
    /n new workstream · r refresh · q quit/u,
  );

  harness.resize(64, 28);
  harness.feed("n");
  assert.match(harness.writes.at(-1)!, /New workstream/u);
  assert.match(harness.writes.at(-1)!, /Ctrl-S create/u);
  harness.feed("\u0003");
  assert.equal(await run, 0);
});

test("the hub frame shows the ledger and resize reflows without reading", async () => {
  const harness = makeHarness({
    catalogue: makeCatalogue([
      makeItem({ name: "busy", working: 1 }),
      makeItem({
        name: "restful",
        workstreamId: `ws_${"b".repeat(32)}`,
        quietProven: true,
        lastKnownAt: "2026-08-25T10:16:00.000Z",
      }),
    ]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const beforeReads = harness.counters.catalogue;
  const beforeWrites = harness.writes.length;
  harness.resize(70, 29);
  assert.equal(harness.counters.catalogue, beforeReads);
  assert.ok(harness.writes.length > beforeWrites);
  const joined = harness.writes.join("");
  assert.match(joined, /Open workstreams/u);
  assert.match(joined, /busy/u);
  assert.match(joined, /restful/u);
  assert.match(joined, / 1 of 2 open · 0 completed ─┘/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("Home keeps working and News visible when only broad attention is incomplete", async () => {
  const base = makeItem({
    name: "live-news",
    working: 1,
    attentionComplete: false,
    attentionTotal: 2,
    highest: "evidence_incomplete",
    unreadCount: 3,
  });
  const live = {
    ...base,
    rolls: collection([
      makeRoll({
        provider: "codex",
        sessionId: base.unread!.items[0]!.key.session_id,
        working: true,
      }),
    ]),
  };
  const harness = makeHarness({ catalogue: makeCatalogue([live]) });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const frame = harness.writes.at(-1)!;
  const plain = frame.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(
    plain,
    /News 1\/1 · live-news\/Codex · 3 unread · working/u,
  );
  assert.match(plain, /live-news\s+Working now/u);
  assert.doesNotMatch(plain, /Workstream data is incomplete/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("idle Home keeps a proved recent exposure ahead of broad publish gaps", async () => {
  const sessionId = `ses_${"2".repeat(32)}`;
  const base = makeItem({
    name: "idle-recent",
    turnsShown: 1,
    lastKnownAt: "2026-08-25T11:34:00.000Z",
    attentionComplete: false,
    highest: "evidence_incomplete",
  });
  const rollBase = makeRoll({
    provider: "codex",
    sessionId,
    lastSequence: 24,
  });
  const attentionItem: ReaderCatalogueAttentionItem = {
    kind: "evidence_incomplete",
    audience: "unknown",
  };
  const publish: ReaderPublishSummary = {
    provider: "codex",
    session_id: sessionId,
    workstream_id: base.record.workstream_id,
    state: "unknown",
    outcome: "unknown",
    actionability: "unknown",
    freshness: "unknown",
    pending_background_ids: collection([]),
    pending_agent_ids: collection([]),
    attempts: collection([]),
    read_state: "ok",
    coverage: { state: "complete" },
    diagnostics: {
      journal: "present",
      missing: 0,
      invalid: 0,
      corrupt: 0,
      identity_mismatch: 0,
      dropped_attempts: 0,
      scan_limited: false,
      refused: false,
    },
  };
  const item: ReaderCatalogueWorkstream = {
    ...base,
    members: collection([
      {
        provider: "codex",
        session_id: sessionId,
        membership_from: "2026-08-25T09:00:00.000Z",
      },
    ]),
    rolls: collection([
      {
        ...rollBase,
        membership_from: "2026-08-25T09:00:00.000Z",
      },
    ]),
    attention: {
      items: collection([attentionItem]),
      completeness: "incomplete",
      highest: "evidence_incomplete",
    },
    publish: collection([publish]),
  };
  const harness = makeHarness({
    catalogue: makeCatalogue([item]),
  });
  harness.setContextTurns([
    {
      sequence: 24,
      outcome: "success",
      endedAt: "2026-08-25T11:34:00.000Z",
      request: "finish the work",
      response: "Done — exposure response wins",
    },
  ]);
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const plain = harness.writes
    .at(-1)!
    .replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(plain, /idle-recent\s+Last shown · 26m/u);
  assert.match(
    plain,
    /No shown work · latest shown exposure 26 minutes ago/u,
  );
  assert.doesNotMatch(plain, /Data incomplete|Working now/u);

  harness.feed("\r");
  await settle();
  const dashboard = harness.writes
    .at(-1)!
    .replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(dashboard, /No work is shown/u);
  assert.match(
    dashboard,
    /> #24\s+11:34\s+Done — exposure response wins/u,
  );
  const exposureLine = dashboard
    .split("\r\n")
    .find((line) => /> #24/u.test(line));
  assert.ok(exposureLine !== undefined);
  assert.doesNotMatch(exposureLine, /Succeeded|finish the work/u);
  assert.match(dashboard, /codex\/22222222\s+Last shown #24/u);
  assert.match(dashboard, /Publish state is unknown/u);
  assert.doesNotMatch(dashboard, /Working|Space|[█▓▒░▀▄]/u);
  assert.equal(harness.timerCount(100), 0);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("idle ledger spends both card tiers on newest responses and the selected roll", async () => {
  const rolls = [
    makeRoll({
      provider: "codex",
      sessionId: `ses_${"3".repeat(32)}`,
      lastSequence: 8,
    }),
    makeRoll({
      provider: "claude",
      sessionId: `ses_${"4".repeat(32)}`,
      lastSequence: 9,
    }),
    makeRoll({
      provider: "zed",
      sessionId: `ses_${"5".repeat(32)}`,
      lastSequence: 10,
    }),
  ];
  const base = makeItem({ turnsShown: 10, rollsTotal: 3 });
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([{ ...base, rolls: collection(rolls) }]),
  });
  harness.setContextTurns(
    Array.from({ length: 10 }, (_unused, index) => {
      const sequence = 10 - index;
      return {
        sequence,
        outcome: sequence === 6 ? "failed" : "success",
        endedAt: `2026-08-25T01:${`${sequence}`.padStart(2, "0")}:00.000Z`,
        request: `Request ${sequence} should stay behind the response`,
        response: `Response ${sequence} tells the workstream story`,
      };
    }),
  );
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const plain = (): string =>
    harness.writes.at(-1)!.replace(/\u001b\[[0-9;]*m/gu, "");
  const exposureLines = (): string[] =>
    plain()
      .split("\r\n")
      .filter((line) => /│[ >] #\d+/u.test(line));

  assert.equal(exposureLines().length, 10);
  assert.match(plain(), /#1\s+01:01\s+Response 1/u);
  assert.match(plain(), /> #10\s+01:10\s+Response 10/u);
  assert.match(plain(), /#6\s+01:06\s+! Failed · Response 6/u);
  assert.doesNotMatch(exposureLines().join("\n"), /Succeeded|Request \d/u);

  harness.feed("j");
  harness.feed("j");
  harness.resize(56, 22);
  assert.equal(exposureLines().length, 7);
  assert.doesNotMatch(plain(), /#1\s|#2\s|#3\s/u);
  assert.match(plain(), /#4\s+01:04/u);
  assert.match(plain(), /> #10\s+01:10/u);
  const rosterLines = plain()
    .split("\r\n")
    .filter((line) => /│[ >] (?:codex|claude|zed)\//u.test(line));
  assert.equal(rosterLines.length, 2);
  assert.match(rosterLines.join("\n"), /> zed\/55555555/u);
  assert.match(plain(), /zed\/55555555 · no shown lease/u);
  assert.match(plain(), /Latest shown exposure · #10/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("dashboard color links exposure provenance to the selected session", async () => {
  assert.equal(SELECTED_HUB_ROW_COLOR, "\u001b[36m");
  assert.equal(SESSION_PROVENANCE_DIM, "\u001b[2m");
  const claudeSession = `ses_${"4".repeat(32)}`;
  const codexSession = `ses_${"3".repeat(32)}`;
  const rolls = [
    makeRoll({
      provider: "codex",
      sessionId: codexSession,
      lastSequence: 2,
    }),
    makeRoll({
      provider: "claude",
      sessionId: claudeSession,
      lastSequence: 2,
    }),
  ];
  const base = makeItem({ turnsShown: 4, rollsTotal: 2 });
  const catalogue = makeCatalogue([
    { ...base, rolls: collection(rolls) },
  ]);
  const turns: readonly HarnessContextTurn[] = [
    {
      turnId: "turn_claude_first",
      provider: "claude",
      sessionId: claudeSession,
      sequence: 1,
      outcome: "success",
      endedAt: "2026-08-25T01:01:00.000Z",
      request: "Claude request one",
      response: "Claude first exposure",
    },
    {
      turnId: "turn_codex_first",
      provider: "codex",
      sessionId: codexSession,
      sequence: 1,
      outcome: "success",
      endedAt: "2026-08-25T01:02:00.000Z",
      request: "Codex request one",
      response: "Codex first exposure",
    },
    {
      turnId: "turn_claude_second",
      provider: "claude",
      sessionId: claudeSession,
      sequence: 2,
      outcome: "success",
      endedAt: "2026-08-25T01:03:00.000Z",
      request: "Claude request two",
      response: "Claude second exposure",
    },
    {
      turnId: "turn_codex_second",
      provider: "codex",
      sessionId: codexSession,
      sequence: 2,
      outcome: "success",
      endedAt: "2026-08-25T01:04:00.000Z",
      request: "Codex request two",
      response: "Codex newest exposure",
    },
  ];
  const colored = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue,
  });
  const flat = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue,
    color: false,
  });
  colored.setContextTurns(turns);
  flat.setContextTurns(turns);
  const coloredRun = runComfortTui(colored.options);
  const flatRun = runComfortTui(flat.options);
  await completeBoot(colored);
  await completeBoot(flat);

  const allSgr = /\u001b\[[0-9;]*m/gu;
  const anySgr = /\u001b\[[0-9;]*m/u;
  const sessionRows = {
    claude: [
      "Claude first exposure",
      "Claude second exposure",
      "claude/44444444",
    ],
    codex: [
      "Codex first exposure",
      "Codex newest exposure",
      "codex/33333333",
    ],
  } as const;
  const assertFigureGround = (selected: keyof typeof sessionRows): void => {
    const coloredDraw = colored.writes.at(-1)!;
    const flatDraw = flat.writes.at(-1)!;
    assert.equal(coloredDraw.replace(allSgr, ""), flatDraw);
    assert.doesNotMatch(flatDraw, anySgr);
    const lines = coloredDraw.split("\r\n");
    const styledRows = lines.filter(
      (line) =>
        line.includes(SELECTED_HUB_ROW_COLOR) ||
        line.includes(SESSION_PROVENANCE_DIM),
    );
    assert.equal(styledRows.length, 6);
    assert.equal(lines.filter((line) => anySgr.test(line)).length, 6);

    for (const [session, labels] of Object.entries(sessionRows) as Array<
      [keyof typeof sessionRows, readonly string[]]
    >) {
      const opening =
        session === selected
          ? SELECTED_HUB_ROW_COLOR
          : SESSION_PROVENANCE_DIM;
      const other =
        session === selected
          ? SESSION_PROVENANCE_DIM
          : SELECTED_HUB_ROW_COLOR;
      for (const label of labels) {
        const line = lines.find(
          (candidate) => candidate.includes("│") && candidate.includes(label),
        );
        assert.ok(line, label);
        assert.equal(line.split(opening).length - 1, 1, label);
        assert.equal(line.includes(other), false, label);
        assert.equal(line.split(SGR_RESET).length - 1, 1, label);
        const leftWall = line.indexOf("│");
        const openingAt = line.indexOf(opening);
        const labelAt = line.indexOf(label);
        const detailAt = label.includes("/")
          ? line.indexOf("Last shown #2")
          : labelAt;
        const resetAt = line.indexOf(SGR_RESET);
        const rightWall = line.lastIndexOf("│");
        assert.ok(
          openingAt === leftWall + 1 &&
            openingAt < labelAt &&
            labelAt <= detailAt &&
            detailAt < resetAt &&
            resetAt + SGR_RESET.length === rightWall,
          label,
        );
        assert.doesNotMatch(line.slice(resetAt + SGR_RESET.length), anySgr);
      }
    }

    for (const label of [
      "The study so far",
      "Oldest to newest",
      "Latest shown exposure",
      "Publish state is unknown",
    ]) {
      const line = lines.find((candidate) => candidate.includes(label));
      assert.ok(line, label);
      assert.doesNotMatch(line, anySgr, label);
    }
    const newest = lines.find((line) => line.includes("Codex newest exposure"));
    assert.ok(newest);
    assert.match(newest.replace(allSgr, ""), /│> #2/u);
    const claudeRoll = lines.find(
      (line) => line.includes("│") && line.includes("claude/44444444"),
    );
    const codexRoll = lines.find(
      (line) => line.includes("│") && line.includes("codex/33333333"),
    );
    assert.ok(claudeRoll && codexRoll);
    assert.match(
      (selected === "claude" ? claudeRoll : codexRoll).replace(allSgr, ""),
      /│>/u,
    );
    assert.match(
      (selected === "claude" ? codexRoll : claudeRoll).replace(allSgr, ""),
      /│  /u,
    );
  };

  assertFigureGround("claude");
  colored.feed("j");
  flat.feed("j");
  assertFigureGround("codex");
  colored.feed("k");
  flat.feed("k");
  assertFigureGround("claude");
  colored.resize(56, 22);
  flat.resize(56, 22);
  assertFigureGround("claude");

  colored.feed("q");
  flat.feed("q");
  assert.equal(await coloredRun, 0);
  assert.equal(await flatRun, 0);
});

test("Home advertises only working keys and keeps quit whole at every tier", async () => {
  let punchCalls = 0;
  const harness = makeHarness({
    catalogue: makeCatalogue([
      makeItem({ name: "open-keys" }),
      makeItem({
        name: "completed-keys",
        workstreamId: `ws_${"d".repeat(32)}`,
        status: "completed",
      }),
    ]),
    punchHelper: async () => {
      punchCalls += 1;
      return "ok";
    },
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const cleanTerminalLine = (line: string): string =>
    line.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "").trim();
  const footer = (): string =>
    harness.writes
      .at(-1)!
      .split("\r\n")
      .map(cleanTerminalLine)
      .filter((line) => line.includes("q quit"))
      .at(-1)!;
  const comfortFooter =
    "j/k · Enter · / completed · x complete · n new · ? help · q quit";
  assert.equal(footer(), comfortFooter);

  harness.resize(64, 28);
  assert.equal(footer(), comfortFooter);

  harness.resize(56, 22);
  assert.equal(
    footer(),
    "j/k · Enter · / completed · x complete · ? help · q quit",
  );
  assert.doesNotMatch(footer(), /Tab|c copy|·\s*$/u);

  harness.feed("/");
  assert.equal(
    footer(),
    "j/k · Enter · / open · x reopen · ? help · q quit",
  );

  const writesBeforeDeadKeys = harness.writes.length;
  harness.feed("c");
  harness.feed("\t");
  await settle();
  assert.equal(punchCalls, 0);
  assert.equal(harness.writes.length, writesBeforeDeadKeys);

  harness.resize(12, 6);
  assert.equal(
    cleanTerminalLine(harness.writes.at(-1)!.split("\r\n").at(-1)!),
    "q quit",
  );
  harness.feed("q");
  assert.equal(await run, 0);
});

test("narrow steady-state pages render byte-identically with honest escapes", async () => {
  const harness = makeHarness();
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const lastLine = (): string =>
    harness.writes
      .at(-1)!
      .split("\r\n")
      .at(-1)!
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
      .trimEnd();

  harness.resize(40, 12);
  assert.equal(
    fixtureFrame(harness.writes.at(-1)!),
    await readFixture("hub-40x12.txt"),
  );
  harness.feed("/");
  assert.equal(lastLine(), "/ open · r refresh · q quit");
  assert.doesNotMatch(lastLine(), /\? help/u);
  harness.feed("/");
  assert.equal(lastLine(), "/ completed · r refresh · q quit");
  assert.doesNotMatch(lastLine(), /\? help/u);

  harness.feed("n");
  assert.equal(lastLine(), "Esc cancel");

  harness.feed("q");
  harness.resize(56, 22);
  assert.match(harness.writes.at(-1)!, /│  \[ q_/u);

  harness.resize(12, 6);
  assert.equal(
    fixtureFrame(harness.writes.at(-1)!),
    await readFixture("create-form-12x6.txt"),
  );
  harness.resize(11, 4);
  assert.equal(
    fixtureFrame(harness.writes.at(-1)!),
    await readFixture("create-form-11x4.txt"),
  );

  harness.feed("\u001b");
  harness.fireTimeout();
  assert.match(harness.writes.at(-1)!, /q quit/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("hub scrolling keeps selection visible and titles the border by position", async () => {
  const catalogue = makeCatalogue(
    Array.from({ length: 14 }, (_unused, index) => {
      const ordinal = `${index + 1}`.padStart(2, "0");
      return makeItem({
        name: `stream-${ordinal}`,
        workstreamId: `ws_${(index + 1).toString(16).padStart(32, "0")}`,
        working: 1,
      });
    }),
  );
  const harness = makeHarness({ catalogue });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const initial = harness.writes[harness.writes.length - 1]!;
  assert.match(initial, /> stream-01/u);
  assert.match(initial, / 1 of 14 open · 0 completed ─┘/u);
  assert.doesNotMatch(initial, /workstreams shown|[↑↓]/u);

  for (let step = 0; step < 12; step += 1) harness.feed("j");
  const middle = harness.writes[harness.writes.length - 1]!;
  assert.match(middle, /> stream-13/u);
  assert.match(middle, / 13 of 14 open · 0 completed ─┘/u);
  assert.doesNotMatch(middle, /[↑↓]/u);

  harness.feed("j");
  const bottom = harness.writes[harness.writes.length - 1]!;
  assert.match(bottom, /> stream-14/u);
  assert.match(bottom, / 14 of 14 open · 0 completed ─┘/u);
  assert.doesNotMatch(bottom, /[↑↓]/u);

  harness.feed("k");
  const upward = harness.writes[harness.writes.length - 1]!;
  assert.match(upward, /> stream-13/u);
  assert.match(upward, / 13 of 14 open · 0 completed ─┘/u);
  assert.doesNotMatch(upward, /[↑↓]/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("Home color follows the selected row without changing its cells", async () => {
  assert.equal(SELECTED_HUB_ROW_COLOR, "\u001b[36m");
  assert.notEqual(SELECTED_HUB_ROW_COLOR, SGR_RESET);
  const catalogue = makeCatalogue([
    makeItem({
      name: "first",
      workstreamId: `ws_${"1".repeat(32)}`,
      quietProven: true,
      lastKnownAt: "2026-08-24T12:00:00.000Z",
    }),
    makeItem({
      name: "second",
      workstreamId: `ws_${"2".repeat(32)}`,
      quietProven: true,
      lastKnownAt: "2026-08-24T12:00:00.000Z",
    }),
    makeItem({
      name: "third",
      workstreamId: `ws_${"3".repeat(32)}`,
      quietProven: true,
      lastKnownAt: "2026-08-24T12:00:00.000Z",
    }),
  ]);
  const colored = makeHarness({ catalogue });
  const plain = makeHarness({ catalogue, color: false });
  const coloredRun = runComfortTui(colored.options);
  const plainRun = runComfortTui(plain.options);
  await completeBoot(colored);
  await completeBoot(plain);

  const allSgr = /\u001b\[[0-9;]*m/gu;
  const anySgr = /\u001b\[[0-9;]*m/u;
  const assertSelection = (name: string): void => {
    const coloredDraw = colored.writes.at(-1)!;
    const plainDraw = plain.writes.at(-1)!;
    assert.equal(coloredDraw.replace(allSgr, ""), plainDraw);
    assert.doesNotMatch(plainDraw, anySgr);
    const accented = coloredDraw
      .split("\r\n")
      .filter((line) => line.includes(SELECTED_HUB_ROW_COLOR));
    assert.equal(accented.length, 1);
    assert.ok(
      accented[0]!.includes(
        `${SELECTED_HUB_ROW_COLOR}> ${name}${SGR_RESET}`,
      ),
    );
    const resetIndex = accented[0]!.indexOf(SGR_RESET);
    const detailIndex = accented[0]!.indexOf("Quiet · 1d");
    const rightWall = accented[0]!.lastIndexOf("│");
    assert.ok(
      resetIndex !== -1 &&
        detailIndex !== -1 &&
        resetIndex < detailIndex &&
        detailIndex < rightWall,
    );
    assert.doesNotMatch(accented[0]!.slice(resetIndex + SGR_RESET.length), anySgr);
    for (const other of ["first", "second", "third"].filter(
      (candidate) => candidate !== name,
    )) {
      const row = coloredDraw
        .split("\r\n")
        .find((line) => line.includes(`  ${other}`));
      assert.ok(row);
      assert.doesNotMatch(row, anySgr);
    }
  };

  assertSelection("first");
  colored.feed("j");
  plain.feed("j");
  assertSelection("second");
  colored.feed("k");
  plain.feed("k");
  assertSelection("first");

  colored.resize(56, 22);
  plain.resize(56, 22);
  assertSelection("first");

  colored.feed("q");
  plain.feed("q");
  assert.equal(await coloredRun, 0);
  assert.equal(await plainRun, 0);
});

test("the Home ticker rotates on successful refreshes, not horse pause", async () => {
  const liveId = `ws_${"4".repeat(32)}`;
  const staleId = `ws_${"5".repeat(32)}`;
  const liveSession = `ses_${"4".repeat(32)}`;
  const staleSession = `ses_${"5".repeat(32)}`;
  const liveBase = makeItem({
    name: "tui-fixes",
    workstreamId: liveId,
    working: 1,
    attentionTotal: 1,
    highest: "news",
    lastKnownAt: "2026-08-25T11:59:00.000Z",
  });
  const staleBase = makeItem({
    name: "public-alpha",
    workstreamId: staleId,
    attentionTotal: 1,
    highest: "news",
    lastKnownAt: "2026-08-25T10:00:00.000Z",
  });
  const live = {
    ...liveBase,
    rolls: collection([
      makeRoll({
        provider: "codex",
        sessionId: liveSession,
        working: true,
        lastSequence: 12,
      }),
    ]),
    unread: collection([
      makeUnread({
        workstreamId: liveId,
        provider: "codex",
        sessionId: liveSession,
        count: 1,
      }),
    ]),
  };
  const stale = {
    ...staleBase,
    rolls: collection([
      makeRoll({
        provider: "claude",
        sessionId: staleSession,
        lastSequence: 8,
      }),
    ]),
    unread: collection([
      makeUnread({
        workstreamId: staleId,
        provider: "claude",
        sessionId: staleSession,
        count: 6,
      }),
    ]),
  };
  const catalogue = makeCatalogue([stale, live]);
  const harness = makeHarness({ catalogue });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  assert.match(
    harness.writes.at(-1)!,
    /News 1\/2 · tui-fixes\/Codex · 1 unread · working/u,
  );

  const reorderedCatalogue = makeCatalogue([
    {
      ...stale,
      active_state_counts: {
        ...stale.active_state_counts,
        working: 1,
      },
      rolls: collection([
        makeRoll({
          provider: "claude",
          sessionId: staleSession,
          working: true,
          lastSequence: 8,
        }),
      ]),
    },
    {
      ...live,
      active_state_counts: {
        ...live.active_state_counts,
        working: 0,
      },
      rolls: collection([
        makeRoll({
          provider: "codex",
          sessionId: liveSession,
          lastSequence: 12,
        }),
      ]),
    },
  ]);
  harness.setCatalogue(reorderedCatalogue);
  harness.feed(" ");
  harness.fireTimers(1_000);
  await settle();
  assert.match(
    harness.writes.at(-1)!,
    /News 2\/2 · public-alpha\/Claude · 6 unread · working/u,
  );

  harness.setHealthError(new Error("refresh broke"));
  harness.fireTimers(1_000);
  await settle();
  assert.match(harness.writes.at(-1)!, /News 2\/2 · public-alpha/u);
  harness.setHealthError(undefined);
  harness.fireTimers(1_000);
  await settle();
  assert.match(harness.writes.at(-1)!, /News 1\/2 · tui-fixes/u);
  harness.feed("q");
  assert.equal(await run, 0);

  const still = makeHarness({ catalogue, motion: false });
  const stillRun = runComfortTui(still.options);
  await completeBoot(still);
  still.fireTimers(1_000);
  await settle();
  assert.match(still.writes.at(-1)!, /News 1\/2 · tui-fixes/u);
  still.fireTimers(1_000);
  await settle();
  assert.match(still.writes.at(-1)!, /News 1\/2 · tui-fixes/u);
  still.feed("q");
  assert.equal(await stillRun, 0);
});

test("the Home ticker keeps pending recipients when the current one disappears", async () => {
  const newsItem = (name: string, digit: string) =>
    makeItem({
      name,
      workstreamId: `ws_${digit.repeat(32)}`,
      attentionTotal: 1,
      highest: "news",
      unreadCount: 1,
    });
  const alpha = newsItem("alpha-news", "a");
  const bravo = newsItem("bravo-news", "b");
  const charlie = newsItem("charlie-news", "c");
  const harness = makeHarness({
    catalogue: makeCatalogue([alpha, bravo, charlie]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  assert.match(harness.writes.at(-1)!, /News 1\/3 · alpha-news\/Codex/u);

  harness.setCatalogue(makeCatalogue([bravo, charlie]));
  harness.feed("r");
  await settle();
  assert.match(harness.writes.at(-1)!, /News 1\/2 · bravo-news\/Codex/u);

  harness.setCatalogue(makeCatalogue([alpha, charlie]));
  harness.feed("r");
  await settle();
  assert.match(harness.writes.at(-1)!, /News 1\/2 · charlie-news\/Codex/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("hub recency reorders rows without moving the selected workstream", async () => {
  const olderId = `ws_${"8".repeat(32)}`;
  const newerId = `ws_${"9".repeat(32)}`;
  const older = makeItem({
    name: "older",
    workstreamId: olderId,
    working: 1,
    lastKnownAt: "2026-08-25T10:00:00.000Z",
  });
  const newer = makeItem({
    name: "newer",
    workstreamId: newerId,
    working: 1,
    lastKnownAt: "2026-08-25T11:00:00.000Z",
  });
  const harness = makeHarness({ catalogue: makeCatalogue([older, newer]) });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  assert.match(harness.writes.at(-1)!, /> newer/u);
  assert.match(
    harness.writes.at(-1)!,
    / 1 of 2 open · 0 completed ─┘/u,
  );
  harness.feed("j");
  assert.match(harness.writes.at(-1)!, /> older/u);
  assert.match(harness.writes.at(-1)!, /older · open/u);

  const nowNewest = {
    ...older,
    activity: {
      ...older.activity,
      last_known_activity_at: "2026-08-25T11:30:00.000Z",
    },
  };
  harness.setCatalogue(makeCatalogue([nowNewest, newer]));
  harness.feed("r");
  await settle();
  const reordered = harness.writes.at(-1)!;
  assert.match(reordered, /> older/u);
  assert.match(reordered, / 1 of 2 open · 0 completed ─┘/u);
  assert.match(reordered, /older · open/u);

  harness.feed("\r");
  await settle();
  assert.match(harness.writes.at(-1)!, /Barbaro\s+older/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("reader-level hub hiding is confessed in the bench", async () => {
  const complete = makeCatalogue([makeItem({ name: "shown", working: 1 })]);
  const catalogue = {
    ...complete,
    workstream_status_counts: {
      ...complete.workstream_status_counts,
      open: 3,
    },
    workstreams: {
      ...complete.workstreams,
      shown: 1,
      total: 3,
      hidden: 2,
      coverage: { state: "limited" as const, reason: "byte budget" },
    },
  };
  const harness = makeHarness({ catalogue });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const frame = harness.writes[harness.writes.length - 1]!;
  assert.match(frame, /List incomplete · 1 of 3 open shown/u);
  assert.match(frame, / 1 of 1 shown · 3 open · 0 completed ─┘/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("one configured turn window reaches both dashboard readers", async () => {
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    turnsPerSession: 17,
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  assert.deepEqual(harness.readerWindows.catalogue, [17]);
  assert.deepEqual(harness.readerWindows.context, [17]);
  harness.feed("\u001b");
  harness.fireTimeout();
  assert.match(harness.writes.at(-1)!, /Barbaro\s+Home/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("a slow first read extends startup beyond its minimum stride", async () => {
  const gate = deferred();
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    contextGate: gate.promise,
  });
  const run = runComfortTui(harness.options);
  await settle();
  assert.match(harness.writes.at(-1)!, /Reading workstream/u);

  harness.advanceTime(900);
  harness.fireTimers(100, HORSE_FRAME_COUNT + 4);
  assert.match(harness.writes.at(-1)!, /Starting Barbaro/u);
  assert.match(
    harness.writes.at(-1)!,
    /2\.4s elapsed/u,
    "elapsed time follows the clock, not callback count",
  );
  assert.equal(harness.timerCount(100), 1);
  assert.equal(harness.timerCount(1_000), 0);

  gate.resolve();
  await settle();
  const ready = harness.writes.at(-1)!;
  assert.doesNotMatch(ready, /Starting Barbaro/u);
  assert.equal(
    ready.split("\r\n").filter((line) => /[█▓▒░▀▄]/u.test(line)).length,
    8,
  );
  assert.equal(harness.timerCount(100), 1, "compact working takes the clock");
  assert.equal(harness.timerCount(1_000), 1);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("quit restores the terminal without waiting for a slow startup read", async () => {
  const gate = deferred();
  const harness = makeHarness({ healthGate: gate.promise });
  const run = runComfortTui(harness.options);
  await settle();
  assert.match(harness.writes.at(-1)!, /Starting Barbaro/u);

  harness.feed("q");
  assert.equal(await run, 0);
  assert.equal(harness.timerCount(100), 0);
  const writesAfterLeave = harness.writes.length;

  gate.resolve();
  await settle();
  assert.equal(harness.counters.catalogue, 0);
  assert.equal(harness.counters.context, 0);
  assert.equal(harness.writes.length, writesAfterLeave);
  assert.equal(harness.writes.at(-1), COMFORT_SCREEN_SEQUENCES.leave);
});

test("startup swaps hero, compact, and text tiers without restarting its read", async () => {
  const gate = deferred();
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    contextGate: gate.promise,
  });
  const run = runComfortTui(harness.options);
  await settle();
  const densityRows = (): string[] =>
    harness.writes.at(-1)!.split("\r\n").filter((line) => /[█▓▒░▀▄]/u.test(line));
  assert.equal(densityRows().length, 13);

  harness.fireTimers(100, 3);
  harness.resize(56, 22);
  assert.equal(densityRows().length, 8);
  assert.match(harness.writes.at(-1)!, /PLATE 04 OF 11/u);
  harness.resize(40, 12);
  assert.equal(densityRows().length, 0);
  assert.match(harness.writes.at(-1)!, /Reading the workstream/u);
  harness.resize(80, 30);
  assert.equal(densityRows().length, 13);
  assert.match(harness.writes.at(-1)!, /PLATE 04 OF 11/u);
  assert.equal(harness.counters.context, 1);
  assert.equal(harness.timerCount(100), 1);

  harness.fireTimers(100, HORSE_FRAME_COUNT - 3);
  gate.resolve();
  await settle();
  assert.doesNotMatch(harness.writes.at(-1)!, /Starting Barbaro/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("a failed first read hands off to the named error after one stride", async () => {
  const harness = makeHarness({ healthError: new Error("broken reader") });
  const run = runComfortTui(harness.options);
  await settle();
  assert.match(harness.writes.at(-1)!, /Refresh failed/u);
  harness.fireTimers(100, HORSE_FRAME_COUNT);
  await settle();
  assert.match(harness.writes.at(-1)!, /The store could not be read/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /Starting Barbaro/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("startup gets one hero stride, then working stays compact and pausable", async () => {
  const item = makeItem({ working: 1 });
  const working = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([item]),
  });
  const run = runComfortTui(working.options);
  await settle();
  const densityRows = (frame: string): string[] =>
    frame.split("\r\n").filter((line) => /[█▓▒░▀▄]/u.test(line));
  const footer = (frame: string): string =>
    frame
      .split("\r\n")
      .map((line) =>
        line.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "").trim()
      )
      .filter((line) => line.includes("q quit"))
      .at(-1)!;
  const boot = working.writes.at(-1)!;
  assert.match(boot, /b a r b a r o/u);
  assert.doesNotMatch(boot, /B A R B A R O/u);
  assert.match(boot, /THE HORSE IN MOTION/u);
  assert.match(boot, /Refresh 0\.0s · 0 shown turns · 0 B projected/u);
  assert.equal(densityRows(boot).length, 13, "comfort boot uses the hero plate");
  assert.doesNotMatch(boot, /SALLIE GARDNER|RIDER REMOVED/u);
  assert.equal(working.timerCount(100), 1, "only the boot clock is armed");
  assert.equal(working.timerCount(1_000), 0, "refresh waits for handoff");

  working.fireTimers(100, HORSE_FRAME_COUNT - 1);
  assert.match(working.writes.at(-1)!, /Starting Barbaro/u);
  assert.match(
    working.writes.at(-1)!,
    /Refresh 0\.0s/u,
    "the read duration does not absorb the minimum title hold",
  );
  working.fireTimers(100);
  const compactFrame = working.writes.at(-1)!;
  assert.doesNotMatch(compactFrame, /Starting Barbaro|SALLIE GARDNER/u);
  assert.equal(densityRows(compactFrame).length, 8);
  assert.match(compactFrame, /Refresh age 1\.1s · 0 shown turns · 0 B projected/u);
  assert.equal(working.timerCount(100), 1, "boot clock becomes compact motion");
  assert.equal(working.timerCount(1_000), 1, "refresh starts after handoff");
  assert.equal(working.counters.catalogue, 1, "startup ticks never read");

  const framesBefore = working.writes.length;
  working.fireTimers(100);
  assert.ok(working.writes.length > framesBefore, "a compact tick repaints");
  const heldFrame = working.writes.at(-1)!;
  assert.match(heldFrame, /Refresh age 1\.2s/u);
  assert.equal(
    footer(heldFrame),
    "j/k · x complete · Esc home · Space pause · ? help · q quit",
  );

  // Space freezes the exact compact plate and removes the timer entirely.
  working.feed(" ");
  assert.ok(!working.timerDelays().includes(100), "paused mode is timer-free");
  assert.match(working.writes.at(-1)!, /Motion study · paused/u);
  assert.equal(
    footer(working.writes.at(-1)!),
    "j/k · x complete · Esc home · Space resume · ? help · q quit",
  );
  assert.deepEqual(densityRows(working.writes.at(-1)!), densityRows(heldFrame));
  working.feed(" ");
  assert.ok(working.timerDelays().includes(100), "resume re-arms the loop");
  assert.equal(
    footer(working.writes.at(-1)!),
    "j/k · x complete · Esc home · Space pause · ? help · q quit",
  );
  assert.deepEqual(
    densityRows(working.writes.at(-1)!),
    densityRows(heldFrame),
    "resume keeps the held compact plate instead of resetting to F01",
  );

  working.resize(56, 22);
  assert.equal(densityRows(working.writes.at(-1)!).length, 8);
  assert.equal(
    footer(working.writes.at(-1)!),
    "j/k · x complete · Esc home · ? help · q quit",
  );
  assert.ok(working.timerDelays().includes(100), "the sub-card keeps galloping");
  working.resize(40, 12);
  assert.equal(footer(working.writes.at(-1)!), "Esc home · r refresh · q quit");
  assert.ok(
    !working.timerDelays().includes(100),
    "a text card never runs an invisible motion timer",
  );
  working.resize(80, 30);
  assert.ok(working.timerDelays().includes(100), "comfort re-arms motion");
  assert.equal(densityRows(working.writes.at(-1)!).length, 8);
  assert.equal(
    footer(working.writes.at(-1)!),
    "j/k · x complete · Esc home · Space pause · ? help · q quit",
  );
  assert.doesNotMatch(working.writes.at(-1)!, /SALLIE GARDNER|RIDER REMOVED/u);

  const counts = item.active_state_counts as { working: number };
  counts.working = 0;
  working.feed("r");
  await settle();
  assert.ok(!working.timerDelays().includes(100), "refresh stops stale motion");
  counts.working = 1;
  working.feed("r");
  await settle();
  assert.ok(working.timerDelays().includes(100), "refresh starts new motion");
  working.setAbsent(true);
  working.feed("r");
  await settle();
  assert.ok(!working.timerDelays().includes(100), "an absent store stops motion");
  assert.match(working.writes.at(-1)!, /No film loaded/u);
  working.setAbsent(false);
  working.feed("r");
  await settle();
  assert.ok(working.timerDelays().includes(100), "a present store restores motion");
  working.setHealthError(new Error("later refresh failed"));
  working.feed("r");
  await settle();
  assert.match(
    working.writes.at(-1)!,
    /Refresh failed · showing previous data/u,
  );
  working.setHealthError(undefined);
  working.feed("q");
  assert.equal(await run, 0);

  const still = makeHarness({ workstreamId: FIXTURE_WS, motion: false });
  const runStill = runComfortTui(still.options);
  await settle();
  assert.ok(
    !still.timerDelays().includes(100),
    "motion off never schedules an animation timer",
  );
  assert.match(still.writes.join(""), /Working · motion off/u);
  assert.doesNotMatch(still.writes.join(""), /[█▓▒░▀▄]/u);
  still.feed("q");
  assert.equal(await runStill, 0);
});

test("working dots grow on the motion clock and freeze with the horse", async () => {
  const roll = makeRoll({
    provider: "codex",
    sessionId: `ses_${"7".repeat(32)}`,
    working: true,
    lastSequence: 12,
  });
  const base = makeItem({ working: 1, rollsTotal: 1 });
  const item = { ...base, rolls: collection([roll]) };
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([item]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const detail = (): string => {
    const frame = harness.writes.at(-1)!;
    const match = frame.match(
      /> codex\/77777777\s+(Working(?:\.{1,3})?)/u,
    );
    assert.ok(match);
    return match[1]!;
  };
  assert.equal(detail(), "Working");
  const frameLines = harness.writes.at(-1)!.split("\r\n");
  const telemetryRow = frameLines.findIndex((line) => /Refresh age/u.test(line));
  assert.ok(telemetryRow !== -1);
  assert.match(frameLines[telemetryRow + 1]!, /│\s+│/u);
  assert.match(frameLines[telemetryRow + 2]!, /codex\/77777777/u);

  for (const expected of ["Working.", "Working..", "Working...", "Working"]) {
    harness.fireTimers(100, 5);
    assert.equal(detail(), expected);
  }

  harness.fireTimers(100, 5);
  assert.equal(detail(), "Working.");
  harness.feed(" ");
  assert.equal(detail(), "Working.");
  assert.equal(harness.timerCount(100), 0);
  harness.fireTimers(100, 5);
  assert.equal(detail(), "Working.");
  harness.feed(" ");
  assert.equal(detail(), "Working.");
  harness.fireTimers(100, 5);
  assert.equal(detail(), "Working..");
  harness.feed("q");
  assert.equal(await run, 0);

  const still = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([item]),
    motion: false,
  });
  const stillRun = runComfortTui(still.options);
  await settle();
  assert.match(still.writes.at(-1)!, /> codex\/77777777\s+Working/u);
  assert.doesNotMatch(still.writes.at(-1)!, /Working\./u);
  assert.match(
    still.writes.at(-1)!,
    /j\/k · x complete · Esc home · r refresh · \? help · q quit/u,
  );
  assert.doesNotMatch(still.writes.at(-1)!, /Space (?:pause|resume)/u);
  still.feed("q");
  assert.equal(await stillRun, 0);
});

test("closing Help on a working dashboard restarts its motion clock", async () => {
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([makeItem({ working: 1 })]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  assert.equal(harness.timerCount(100), 1);

  harness.feed("?");
  assert.match(harness.writes.at(-1)!, /Words and keys/u);
  assert.match(harness.writes.at(-1)!, /Last shown/u);
  assert.match(harness.writes.at(-1)!, /Data incomplete/u);
  assert.match(harness.writes.at(-1)!, /r · \? · Space/u);
  assert.equal(harness.timerCount(100), 0);

  harness.feed("\u001b");
  harness.fireTimeout();
  assert.doesNotMatch(harness.writes.at(-1)!, /Words and keys/u);
  assert.equal(harness.timerCount(100), 1);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a failed scoped refresh never exposes a partial catalogue snapshot", async () => {
  const originalRoll = makeRoll({
    provider: "codex",
    sessionId: `ses_${"1".repeat(32)}`,
    working: true,
    lastSequence: 17,
  });
  const originalBase = makeItem({
    name: "original",
    working: 1,
    rollsTotal: 1,
  });
  const original = {
    ...originalBase,
    rolls: collection([originalRoll]),
  };
  const replacementRoll = makeRoll({
    provider: "claude",
    sessionId: `ses_${"2".repeat(32)}`,
    lastSequence: 99,
  });
  const replacementBase = makeItem({
    name: "replacement",
    working: 0,
    quietProven: true,
    activityState: "proven_empty",
    rollsTotal: 1,
  });
  const replacement = {
    ...replacementBase,
    rolls: collection([replacementRoll]),
  };
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([original]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const assertOriginalSnapshot = (frame: string): void => {
    assert.match(frame, /original/u);
    assert.match(frame, /1 working/u);
    assert.match(frame, /codex\/11111111/u);
    assert.match(frame, /Latest shown exposure · #17/u);
    assert.doesNotMatch(frame, /replacement|claude\/22222222|#99/u);
  };
  assertOriginalSnapshot(harness.writes.at(-1)!);

  const gate = deferred();
  harness.setCatalogue(makeCatalogue([replacement]));
  harness.setContextGate(gate.promise);
  harness.feed("r");
  await settle();
  assert.equal(harness.counters.context, 2);

  // A motion repaint while context is pending must still use the last complete
  // health/catalogue/context snapshot, not the newly read catalogue alone.
  harness.fireTimers(100);
  assertOriginalSnapshot(harness.writes.at(-1)!);

  harness.setContextError(new Error("context broke"));
  gate.resolve();
  await settle();
  const failed = harness.writes.at(-1)!;
  assertOriginalSnapshot(failed);
  assert.match(failed, /Refresh failed · showing previous data/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a failed dashboard transition never reuses another scope's turns", async () => {
  const secondWorkstream = `ws_${"b".repeat(32)}`;
  const harness = makeHarness({
    catalogue: makeCatalogue([
      makeItem({
        name: "stream-a",
        workstreamId: FIXTURE_WS,
        attentionTotal: 1,
        turnsShown: 1,
      }),
      makeItem({
        name: "stream-b",
        workstreamId: secondWorkstream,
        attentionTotal: 1,
        turnsShown: 1,
      }),
    ]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.setContextTurns([
    {
      sequence: 41,
      outcome: "success",
      endedAt: "2026-08-25T11:57:00.000Z",
      request: "alpha-only exposure",
    },
  ]);
  harness.feed("\r");
  await settle();
  const first = harness.writes.at(-1)!;
  assert.match(first, /stream-a/u);
  assert.match(first, /#41/u);
  assert.match(first, /alpha-only/u);

  harness.feed("\u001b");
  harness.fireTimeout();
  assert.match(harness.writes.at(-1)!, /Open workstreams/u);
  harness.feed("j");
  harness.setContextError(new Error("stream-b context broke"));
  harness.feed("\r");
  await settle();

  const failed = harness.writes.at(-1)!;
  assert.match(failed, /stream-b/u);
  assert.match(failed, /Activity is unknown/u);
  assert.match(failed, /Refresh failed/u);
  assert.doesNotMatch(failed, /#41|alpha-only/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("dashboard selection and evidence follow the same priority-sorted roll", async () => {
  const idle = makeRoll({
    provider: "codex",
    sessionId: `ses_${"3".repeat(8)}${"2".repeat(24)}`,
    lastSequence: 17,
  });
  const workingRoll = makeRoll({
    provider: "codex",
    sessionId: `ses_${"3".repeat(32)}`,
    working: true,
    lastSequence: 23,
  });
  const base = makeItem({ working: 1, rollsTotal: 2 });
  const item = {
    ...base,
    rolls: collection([idle, workingRoll]),
    unread: collection([
      makeUnread({
        workstreamId: FIXTURE_WS,
        provider: workingRoll.provider,
        sessionId: workingRoll.session_id,
        count: 0,
      }),
    ]),
  };
  const harness = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([item]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const framedRoll = (detail: string): string | undefined =>
    harness.writes
      .at(-1)!
      .split("\r\n")
      .find((line) => line.includes("│") && line.includes(detail));
  assert.match(harness.writes.at(-1)!, /> codex\/33333333\s+Working/u);
  assert.match(framedRoll("Working")!, /\u001b\[36m/u);
  assert.match(framedRoll("Last shown #17")!, /\u001b\[2m/u);
  assert.match(harness.writes.at(-1)!, /Latest shown exposure · #23/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /News 0/u);
  harness.feed("j");
  assert.match(
    harness.writes.at(-1)!,
    /> codex\/33333333\s+Last shown #17/u,
  );
  assert.match(framedRoll("Last shown #17")!, /\u001b\[36m/u);
  assert.match(framedRoll("Working")!, /\u001b\[2m/u);
  assert.match(harness.writes.at(-1)!, /Latest shown exposure · #17/u);

  harness.feed("q");
  assert.equal(await run, 0);

  const third = makeRoll({
    provider: "zed",
    sessionId: `ses_${"4".repeat(32)}`,
    lastSequence: 12,
  });
  const noMotionItem = {
    ...item,
    rolls: collection([idle, workingRoll, third]),
  };
  const still = makeHarness({
    workstreamId: FIXTURE_WS,
    catalogue: makeCatalogue([noMotionItem]),
    motion: false,
  });
  const runStill = runComfortTui(still.options);
  await settle();
  still.feed("j");
  still.feed("j");
  still.resize(56, 22);
  assert.match(still.writes.at(-1)!, /> zed\/44444444\s+Last shown #12/u);
  still.feed("q");
  assert.equal(await runStill, 0);
});

test("pasted command keys never act; typed ones do", async () => {
  const harness = makeHarness();
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  harness.feed("\u001b[200~q?n r\u001b[201~");
  await settle();
  assert.equal(harness.errors.length, 0);
  // Still running: feeding a real quit afterwards resolves the app.
  harness.feed("q");
  assert.equal(await run, 0);
});

test("the create flow edits literally, submits by chord, and punches honestly", async () => {
  const writerCalls: string[][] = [];
  const helperPayloads: string[] = [];
  const record = {
    schema: "barbaro.workstream.v1",
    workstream_id: `ws_${"d".repeat(32)}`,
    name: "motion-study",
    title: "Explore the motion-study interface",
    status: "open",
    created_at: "2026-08-25T12:00:00.000Z",
    created_by: { kind: "cli" },
    updated_at: "2026-08-25T12:00:00.000Z",
    revision: 1,
  };
  const harness = makeHarness({
    createWriter: (argv) => {
      writerCalls.push([...argv]);
      return {
        settled: Promise.resolve({
          code: 0,
          stdout: JSON.stringify(record),
          cancelled: false,
        }),
        cancel: () => undefined,
      };
    },
    punchHelper: async (payload) => {
      helperPayloads.push(payload);
      return "ok";
    },
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("n");
  // Command letters are literal text inside the editor.
  for (const key of [..."motion-study"]) harness.feed(key);
  harness.feed("\t");
  harness.feed("\u001b[200~Explore the motion-study interface\r\u001b[201~");
  await settle();
  let joined = harness.writes.join("");
  assert.match(joined, /motion-study_?/u);
  assert.equal(writerCalls.length, 0, "CR in a paste never submits");

  // A pasted Ctrl-S never submits either; only the typed chord does.
  harness.feed("\u001b[200~\u0013\u001b[201~");
  await settle();
  assert.equal(writerCalls.length, 0, "pasted chord bytes are inert");

  harness.feed("\u0013");
  await settle();
  assert.deepEqual(writerCalls, [[
    "workstream",
    "new",
    "motion-study",
    "--title",
    "Explore the motion-study interface",
    "--project-root",
    harness.options.projectRoot,
  ]]);
  joined = harness.writes.join("");
  assert.match(joined, /motion-study was created/u);
  assert.match(joined, /\/barbaro join motion-study/u);
  assert.match(joined, /\$barbaro join motion-study/u);

  harness.feed("?");
  assert.match(harness.writes.at(-1)!, /Words and keys/u);
  harness.feed("\u001b");
  harness.fireTimeout();
  assert.match(harness.writes.at(-1)!, /\/barbaro join motion-study/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /Words and keys/u);

  // Punch: helper exit 0 is the only reported success.
  harness.feed("c");
  await settle();
  assert.deepEqual(helperPayloads, ["/barbaro join motion-study"]);
  joined = harness.writes.join("");
  assert.match(joined, /Punched \u00b7 \/barbaro join motion-study/u);
  assert.match(joined, /The command was not run/u);
  // The payload also went out as OSC 52 with the exact bytes.
  assert.ok(
    joined.includes(
      Buffer.from("/barbaro join motion-study", "utf8").toString("base64"),
    ),
  );
  harness.feed("q");
  assert.equal(await run, 0);
});

test("a missing helper never claims Punched and offers manual copy", async () => {
  const record = {
    schema: "barbaro.workstream.v1",
    workstream_id: `ws_${"d".repeat(32)}`,
    name: "lane",
    status: "open",
    created_at: "2026-08-25T12:00:00.000Z",
    created_by: { kind: "cli" },
    updated_at: "2026-08-25T12:00:00.000Z",
    revision: 1,
  };
  const harness = makeHarness({
    createWriter: () => ({
      settled: Promise.resolve({
        code: 0,
        stdout: JSON.stringify(record),
        cancelled: false,
      }),
      cancel: () => undefined,
    }),
    punchHelper: async () => "missing",
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  harness.feed("n");
  for (const key of [..."lane"]) harness.feed(key);
  harness.feed("\u0013");
  await settle();
  const before = harness.writes.length;
  harness.feed("c");
  await settle();
  const joined = harness.writes.slice(before).join("");
  assert.doesNotMatch(joined, /Punched/u);
  assert.match(joined, /not confirmed|manually/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("Home filters status, retains each selection, and keeps News open-only", async () => {
  const openRecent = makeItem({
    name: "open-recent",
    workstreamId: `ws_${"1".repeat(32)}`,
    working: 1,
    unreadCount: 1,
    lastKnownAt: "2026-08-25T11:59:00.000Z",
  });
  const openQuiet = makeItem({
    name: "open-quiet",
    workstreamId: `ws_${"2".repeat(32)}`,
    quietProven: true,
    activityState: "proven_empty",
  });
  const completedRecent = makeItem({
    name: "completed-recent",
    workstreamId: `ws_${"3".repeat(32)}`,
    status: "completed",
    updatedAt: "2026-08-25T11:58:00.000Z",
    unreadCount: 9,
  });
  const completedOlder = makeItem({
    name: "completed-older",
    workstreamId: `ws_${"4".repeat(32)}`,
    status: "completed",
    updatedAt: "2026-08-25T10:00:00.000Z",
    quietProven: true,
    activityState: "proven_empty",
  });
  const harness = makeHarness({
    catalogue: makeCatalogue([
      completedOlder,
      openQuiet,
      completedRecent,
      openRecent,
    ]),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  let frame = harness.writes.at(-1)!;
  assert.match(frame, /Home · Open/u);
  assert.match(frame, /> open-recent/u);
  assert.match(frame, /News 1\/1 · open-recent\/Codex/u);
  assert.match(frame, /1 of 2 open · 2 completed/u);
  assert.doesNotMatch(frame, /completed-recent|completed-older/u);

  // Quiet rows no longer collapse away: each status-filtered row is reachable.
  harness.feed("j");
  assert.match(harness.writes.at(-1)!, /> open-quiet/u);

  harness.feed("/");
  frame = harness.writes.at(-1)!;
  assert.match(frame, /Home · Completed/u);
  assert.match(frame, /> completed-recent/u);
  assert.match(frame, /2 completed · 2 open/u);
  assert.match(frame, /1 of 2 completed · 2 open/u);
  assert.doesNotMatch(frame, /News \d/u);
  assert.doesNotMatch(frame, /open-recent|open-quiet/u);

  harness.feed("j");
  assert.match(harness.writes.at(-1)!, /> completed-older/u);
  harness.feed("/");
  assert.match(harness.writes.at(-1)!, /> open-quiet/u);
  harness.feed("/");
  assert.match(harness.writes.at(-1)!, /> completed-older/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("an empty status view never advertises an unavailable lifecycle action", async () => {
  const completed = makeItem({
    name: "completed-only",
    workstreamId: `ws_${"e".repeat(32)}`,
    status: "completed",
    updatedAt: "2026-08-25T11:00:00.000Z",
  });
  const harness = makeHarness({ catalogue: makeCatalogue([completed]) });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  let frame = harness.writes.at(-1)!;
  assert.match(frame, /No open workstreams/u);
  assert.doesNotMatch(frame, /x complete|Enter ·/u);
  assert.match(
    frame,
    /\/ completed · n new · r refresh · \? help · q quit/u,
  );
  harness.resize(56, 22);
  frame = harness.writes.at(-1)!;
  assert.doesNotMatch(frame, /x complete|Enter ·/u);
  assert.match(
    frame,
    /\/ completed · n new · r refresh · \? help · q quit/u,
  );
  harness.feed("/");
  frame = harness.writes.at(-1)!;
  assert.match(frame, /> completed-only/u);
  assert.match(
    frame,
    /j\/k · Enter · \/ open · x reopen · \? help · q quit/u,
  );

  harness.setCatalogue(makeCatalogue([]));
  harness.feed("r");
  await settle();
  frame = harness.writes.at(-1)!;
  assert.match(frame, /0 completed · 0 open/u);
  assert.doesNotMatch(frame, /x reopen|Enter ·/u);
  assert.match(frame, /\/ open · n new · r refresh · \? help · q quit/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("the text-tier Home page qualifies degraded status totals", async () => {
  const harness = makeHarness({
    catalogue: makeCatalogue([makeItem({ name: "known-open" })], true),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  harness.resize(40, 12);

  const page = harness.writes.at(-1)!;
  assert.match(page, /Shown 1 open known/u);
  assert.match(page, /1 open known · 0 completed known/u);
  assert.doesNotMatch(page, /1 open · 0 completed/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("x confirms before using immutable-ID argv and reports reconciled warnings", async () => {
  const workstreamId = `ws_${"5".repeat(32)}`;
  const member = {
    provider: "codex",
    session_id: `ses_${"5".repeat(32)}`,
    membership_from: "2026-08-25T09:00:00.000Z",
  };
  const openBase = makeItem({
    name: "renameable-lane",
    workstreamId,
    revision: 7,
    working: 1,
    lastKnownAt: "2026-08-25T11:48:00.000Z",
  });
  const open = {
    ...openBase,
    record: {
      ...openBase.record,
      title: "A lane with frozen decision evidence",
    },
    members: collection([member]),
    unread: collection([
      makeUnread({
        workstreamId,
        provider: member.provider,
        sessionId: member.session_id,
        count: 3,
      }),
    ]),
  };
  const completed = makeItem({
    name: "renameable-lane",
    workstreamId,
    status: "completed",
    revision: 8,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const writerCalls: string[][] = [];
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    motion: false,
    workstreamWriter: (argv) => {
      writerCalls.push([...argv]);
      return {
        settled: Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            workstream_id: workstreamId,
            name: "renameable-lane",
            status: "completed",
            revision: 8,
          }),
          stderr: "\u001b[33mwarning:\u001b[0m active members remain\n",
          cancelled: false,
        }),
        cancel: () => undefined,
      };
    },
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("x");
  assert.equal(writerCalls.length, 0);
  let confirmation = harness.writes.at(-1)!;
  assert.match(confirmation, /Complete renameable-lane\?/u);
  assert.match(confirmation, /Enter · Yes/u);
  assert.match(confirmation, /Esc · No/u);
  assert.match(confirmation, /● Waiting on you/u);
  assert.match(confirmation, /A lane with frozen decision evidence/u);
  assert.match(confirmation, /renameable-lane · open · Codex 1/u);
  assert.match(confirmation, /No change has been made/u);
  assert.match(confirmation, /3 unread · latest activity 12m/u);
  assert.match(confirmation, new RegExp(`ID · ${workstreamId}`, "u"));
  assert.doesNotMatch(confirmation, /Moves from Home|leaves the news/u);
  assert.doesNotMatch(confirmation, /1 open · 0 completed/u);
  const frozenConfirmation = confirmation;
  const catalogueReads = harness.counters.catalogue;

  const refreshedBase = makeItem({
    name: "renameable-lane",
    workstreamId,
    revision: 7,
    lastKnownAt: "2026-08-25T11:59:00.000Z",
  });
  const refreshedMember = {
    provider: "claude",
    session_id: `ses_${"6".repeat(32)}`,
    membership_from: "2026-08-25T11:00:00.000Z",
  };
  harness.setCatalogue(makeCatalogue([{
    ...refreshedBase,
    record: { ...refreshedBase.record, title: "Refreshed title" },
    members: collection([refreshedMember]),
    unread: collection([
      {
        ...makeUnread({
          workstreamId,
          provider: refreshedMember.provider,
          sessionId: refreshedMember.session_id,
          count: 99,
        }),
        key: {
          provider: refreshedMember.provider,
          session_id: refreshedMember.session_id,
          workstream_id: workstreamId,
          membership_from: refreshedMember.membership_from,
        },
      },
    ]),
  }]));
  harness.feed("r");
  await settle();
  assert.equal(harness.counters.catalogue, catalogueReads + 1);
  confirmation = harness.writes.at(-1)!;
  assert.equal(confirmation, frozenConfirmation);
  assert.match(confirmation, /A lane with frozen decision evidence/u);
  assert.match(confirmation, /renameable-lane · open · Codex 1/u);
  assert.match(confirmation, /3 unread · latest activity 12m/u);
  assert.doesNotMatch(confirmation, /Refreshed title|Claude 1|99 unread/u);
  assert.equal(writerCalls.length, 0);

  harness.resize(40, 12);
  assert.match(harness.writes.at(-1)!, /Enter · Yes/u);
  assert.match(harness.writes.at(-1)!, /Enter yes · Esc no · q quit/u);
  harness.resize(12, 6);
  assert.match(harness.writes.at(-1)!, /Enter · Yes/u);
  assert.match(harness.writes.at(-1)!, /Esc · q quit/u);

  // A resize below the truthful 12x6 floor hides the named target, so Enter
  // cannot dispatch until sufficient geometry returns.
  harness.resize(11, 4);
  harness.feed("\r");
  assert.equal(writerCalls.length, 0);
  harness.resize(80, 30);
  assert.match(harness.writes.at(-1)!, /Complete renameable-lane\?/u);

  harness.setCatalogue(makeCatalogue([completed]));
  harness.feed("\r");
  await settle();
  assert.deepEqual(writerCalls, [[
    "workstream",
    "complete",
    workstreamId,
    "--project-root",
    harness.options.projectRoot,
  ]]);
  let frame = harness.writes.at(-1)!;
  assert.match(frame, /Completed/u);
  assert.match(frame, /renameable-lane is completed/u);
  assert.match(frame, /confirmed by a fresh store read/u);
  assert.match(frame, /Warning · warning: active members remain/u);

  harness.feed("/");
  frame = harness.writes.at(-1)!;
  assert.match(frame, /Home · Completed/u);
  assert.match(frame, /> renameable-lane/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("a cancelled writer still reports reconciled durable truth", async () => {
  const workstreamId = `ws_${"6".repeat(32)}`;
  const open = makeItem({
    name: "cancel-race",
    workstreamId,
    revision: 3,
  });
  const completed = makeItem({
    name: "cancel-race",
    workstreamId,
    status: "completed",
    revision: 4,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const outcome = deferredValue<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
  }>();
  let cancelCalls = 0;
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    motion: false,
    workstreamWriter: () => ({
      settled: outcome.promise,
      cancel: () => {
        cancelCalls += 1;
      },
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("x");
  harness.feed("\r");
  assert.match(harness.writes.at(-1)!, /Completing cancel-race/u);
  harness.feed("\u001b");
  harness.fireTimeout();
  assert.equal(cancelCalls, 1);
  assert.match(harness.writes.at(-1)!, /Cancellation requested/u);

  harness.setCatalogue(makeCatalogue([completed]));
  outcome.resolve({
    code: null,
    stdout: "",
    stderr: "writer exited during cancellation",
    cancelled: true,
  });
  await settle();
  const frame = harness.writes.at(-1)!;
  assert.match(frame, /Completed/u);
  assert.match(frame, /cancel-race is completed/u);
  assert.match(frame, /Warning · writer exited during cancellation/u);
  assert.doesNotMatch(frame, /Cancellation and unchanged state were confirmed/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a directly scoped completed workstream can be reopened", async () => {
  const workstreamId = `ws_${"7".repeat(32)}`;
  const completed = makeItem({
    name: "closed-lane",
    workstreamId,
    status: "completed",
    revision: 10,
    updatedAt: "2026-08-25T11:00:00.000Z",
    quietProven: true,
    activityState: "proven_empty",
  });
  const reopened = makeItem({
    name: "closed-lane",
    workstreamId,
    revision: 11,
    updatedAt: "2026-08-25T12:00:00.000Z",
    quietProven: true,
    activityState: "proven_empty",
  });
  const writerCalls: string[][] = [];
  const harness = makeHarness({
    workstreamId,
    catalogue: makeCatalogue([completed]),
    motion: false,
    workstreamWriter: (argv) => {
      writerCalls.push([...argv]);
      return {
        settled: Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            workstream_id: workstreamId,
            name: "closed-lane",
            status: "open",
            revision: 11,
          }),
          stderr: "reopen advisory",
          cancelled: false,
        }),
        cancel: () => undefined,
      };
    },
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  assert.match(harness.writes.at(-1)!, /closed-lane · completed/u);
  assert.match(harness.writes.at(-1)!, /x reopen/u);

  harness.resize(56, 22);
  harness.feed("x");
  const confirmation = harness.writes.at(-1)!;
  assert.match(confirmation, /Reopen closed-lane\?/u);
  assert.match(confirmation, /Enter · Yes/u);
  assert.match(confirmation, /Esc · No/u);
  assert.match(confirmation, /● Waiting on you/u);
  assert.match(confirmation, /No title has been set\./u);
  assert.match(confirmation, /No joined sessions/u);
  assert.match(confirmation, /no unread · no recorded activity/iu);
  assert.doesNotMatch(confirmation, /Moves from Home|news line/u);
  assert.equal(writerCalls.length, 0);
  harness.setCatalogue(makeCatalogue([reopened]));
  harness.feed("\r");
  await settle();
  assert.deepEqual(writerCalls, [[
    "workstream",
    "reopen",
    workstreamId,
    "--project-root",
    harness.options.projectRoot,
  ]]);
  assert.match(harness.writes.at(-1)!, /Reopened/u);
  assert.match(harness.writes.at(-1)!, /Warning · reopen advisory/u);

  harness.feed("\u001b");
  harness.fireTimeout();
  assert.match(harness.writes.at(-1)!, /Home · Open/u);
  assert.match(harness.writes.at(-1)!, /> closed-lane/u);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("the lifecycle decision blinks without reading, writing, or thawing evidence", async () => {
  const workstreamId = `ws_${"a".repeat(32)}`;
  const item = makeItem({
    name: "blink-lane",
    workstreamId,
    lastKnownAt: "2026-08-25T11:48:00.000Z",
  });
  let writerCalls = 0;
  const harness = makeHarness({
    catalogue: makeCatalogue([item]),
    workstreamWriter: () => {
      writerCalls += 1;
      throw new Error("the decision clock must not write");
    },
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  const readsBefore = harness.counters.catalogue;
  harness.feed("x");
  assert.equal(harness.timerCount(100), 1);
  assert.equal(writerCalls, 0);
  assert.match(harness.writes.at(-1)!, /● Waiting on you/u);
  assert.match(harness.writes.at(-1)!, /blink-lane · open/u);

  harness.fireTimers(100, 4);
  assert.match(harness.writes.at(-1)!, /● Waiting on you/u);
  harness.fireTimers(100);
  assert.doesNotMatch(harness.writes.at(-1)!, /● Waiting on you/u);
  assert.match(harness.writes.at(-1)!, /Waiting on you/u);
  assert.equal(harness.counters.catalogue, readsBefore);
  assert.equal(writerCalls, 0);

  harness.setCatalogue(makeCatalogue([
    makeItem({
      name: "refreshed-name",
      workstreamId,
      revision: 2,
      lastKnownAt: "2026-08-25T11:59:00.000Z",
    }),
  ]));
  harness.feed("r");
  await settle();
  assert.equal(harness.counters.catalogue, readsBefore + 1);
  assert.match(harness.writes.at(-1)!, /blink-lane · open/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /refreshed-name/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /● Waiting on you/u);

  harness.feed("\u001b");
  harness.fireTimeout();
  assert.equal(harness.timerCount(100), 0);
  harness.feed("q");
  assert.equal(await run, 0);
});

test("no-motion and a pre-paused dashboard keep the decision marker steady", async () => {
  for (const paused of [false, true]) {
    const harness = makeHarness({
      catalogue: makeCatalogue([makeItem({ name: `steady-${paused}` })]),
      ...(paused ? {} : { motion: false }),
    });
    const run = runComfortTui(harness.options);
    await completeBoot(harness);
    if (paused) harness.feed(" ");
    harness.feed("x");
    assert.match(harness.writes.at(-1)!, /● Waiting on you/u);
    assert.equal(harness.timerCount(100), 0);
    harness.fireTimers(100, 10);
    assert.match(harness.writes.at(-1)!, /● Waiting on you/u);
    harness.feed("q");
    assert.equal(await run, 0);
  }
});

test("fast clean lifecycle success waits one full pass before Home Open", async () => {
  const workstreamId = `ws_${"b".repeat(32)}`;
  const open = makeItem({ name: "fast-lane", workstreamId, revision: 1 });
  const completedBase = makeItem({
    name: "fast-lane",
    workstreamId,
    status: "completed",
    revision: 2,
    updatedAt: "2026-08-25T12:00:00.000Z",
    lastKnownAt: "2026-08-25T11:59:00.000Z",
    unreadCount: 7,
  });
  const completed = {
    ...completedBase,
    record: {
      ...completedBase.record,
      title: "Changed after confirmation",
    },
  };
  const writerCalls: string[][] = [];
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: (argv) => {
      writerCalls.push([...argv]);
      return {
        settled: Promise.resolve({
          code: 0,
          stdout: JSON.stringify(completed.record),
          stderr: "",
          cancelled: false,
        }),
        cancel: () => undefined,
      };
    },
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const catalogueReads = harness.counters.catalogue;
  const frozenEvidence = [
    "fast-lane · open · No joined sessions",
    "No title has been set.",
    "no unread · activity unknown",
    `ID · ${workstreamId}`,
    "Revision · 1",
    "Project · comfort-project · root /tmp/comfort-project",
  ];

  harness.feed("x");
  const confirmation = harness.writes.at(-1)!;
  assertIncludesLines(confirmation, frozenEvidence);
  harness.setCatalogue(makeCatalogue([completed]));
  harness.feed("\r");
  const writerFrame = harness.writes.at(-1)!;
  assert.match(writerFrame, /Barbaro\s+Lifecycle/u);
  assert.match(
    writerFrame,
    /Completing fast-lane… · running public command/u,
  );
  assert.match(writerFrame, /┌─ Completing fast-lane/u);
  assertIncludesLines(writerFrame, frozenEvidence);
  assert.doesNotMatch(writerFrame, /Changed after confirmation|7 unread/u);
  assert.match(writerFrame, /Esc request cancel · q quit/u);
  await settle();
  assert.equal(writerCalls.length, 1);
  assert.equal(harness.counters.catalogue, catalogueReads + 1);
  assert.equal(harness.timerCount(100), 1);
  const finishingFrame = harness.writes.at(-1)!;
  assert.match(finishingFrame, /Confirmed · finishing motion pass/u);
  assert.match(finishingFrame, /┌─ Completing fast-lane/u);
  assertIncludesLines(finishingFrame, frozenEvidence);
  assert.doesNotMatch(
    finishingFrame,
    /Changed after confirmation|7 unread/u,
  );
  assert.doesNotMatch(finishingFrame, /Home · Open/u);
  harness.feed("\u001b");
  harness.fireTimeout();
  harness.feed("/");
  assert.match(harness.writes.at(-1)!, /Confirmed · finishing motion pass/u);

  harness.fireTimers(100, HORSE_FRAME_COUNT - 1);
  assert.doesNotMatch(harness.writes.at(-1)!, /Home · Open/u);
  harness.fireTimers(100);
  assert.match(harness.writes.at(-1)!, /Home · Open/u);
  assert.equal(harness.timerCount(100), 0);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("quit cancels a running lifecycle writer once and skips late reconcile", async () => {
  const open = makeItem({ name: "quit-lane", revision: 2 });
  const outcome = deferredValue<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
  }>();
  let cancelCalls = 0;
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: () => ({
      settled: outcome.promise,
      cancel: () => {
        cancelCalls += 1;
      },
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const catalogueReads = harness.counters.catalogue;

  harness.feed("x");
  harness.feed("\r");
  harness.feed("q");
  assert.equal(await run, 0);
  assert.equal(cancelCalls, 1);
  assert.equal(harness.timerCount(100), 0);

  outcome.resolve({
    code: null,
    stdout: "",
    stderr: "cancelled after exit",
    cancelled: true,
  });
  await settle();
  assert.equal(harness.counters.catalogue, catalogueReads);
  assert.equal(cancelCalls, 1);
});

test("writer-phase Esc cancels live motion into the honest unchanged result", async () => {
  const open = makeItem({ name: "cancel-film", revision: 3 });
  const outcome = deferredValue<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
  }>();
  let cancelCalls = 0;
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: () => ({
      settled: outcome.promise,
      cancel: () => {
        cancelCalls += 1;
      },
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("x");
  harness.feed("\r");
  harness.feed("\u001b");
  harness.fireTimeout();
  assert.equal(cancelCalls, 1);
  assert.match(harness.writes.at(-1)!, /Cancellation requested/u);
  assert.equal(harness.timerCount(100), 1);

  outcome.resolve({
    code: null,
    stdout: "",
    stderr: "",
    cancelled: true,
  });
  await settle();
  const frame = harness.writes.at(-1)!;
  assert.equal(harness.timerCount(100), 0);
  assert.match(frame, /Cancelled/u);
  assert.match(frame, /Cancellation and unchanged state were confirmed/u);
  assert.doesNotMatch(frame, /finishing motion pass|Home · Open/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("slow lifecycle work loops passes and finishes the settlement pass", async () => {
  const workstreamId = `ws_${"c".repeat(32)}`;
  const open = makeItem({ name: "slow-lane", workstreamId, revision: 4 });
  const completedBase = makeItem({
    name: "slow-lane",
    workstreamId,
    status: "completed",
    revision: 5,
    updatedAt: "2026-08-25T12:00:00.000Z",
    lastKnownAt: "2026-08-25T11:59:00.000Z",
    unreadCount: 9,
  });
  const completed = {
    ...completedBase,
    record: {
      ...completedBase.record,
      title: "Late replacement evidence",
    },
  };
  const outcome = deferredValue<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
  }>();
  const reconcile = deferred();
  let cancelCalls = 0;
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: () => ({
      settled: outcome.promise,
      cancel: () => {
        cancelCalls += 1;
      },
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);
  const frozenEvidence = [
    "slow-lane · open · No joined sessions",
    "No title has been set.",
    "no unread · activity unknown",
    `ID · ${workstreamId}`,
    "Revision · 4",
    "Project · comfort-project · root /tmp/comfort-project",
  ];

  harness.feed("x");
  harness.feed("\r");
  harness.fireTimers(100, HORSE_FRAME_COUNT);
  assert.equal(harness.timerCount(100), 1);
  const writerLoopFrame = harness.writes.at(-1)!;
  assert.match(writerLoopFrame, /running public command/u);
  assertIncludesLines(writerLoopFrame, frozenEvidence);
  assert.doesNotMatch(writerLoopFrame, /Late replacement evidence|9 unread/u);

  harness.queueCatalogueRead(makeCatalogue([completed]), reconcile.promise);
  outcome.resolve({
    code: 0,
    stdout: JSON.stringify(completed.record),
    stderr: "",
    cancelled: false,
  });
  await settle();
  const reconcileFrame = harness.writes.at(-1)!;
  assert.match(reconcileFrame, /Checking durable state/u);
  assert.match(reconcileFrame, /┌─ Completing slow-lane/u);
  assertIncludesLines(reconcileFrame, frozenEvidence);
  assert.doesNotMatch(reconcileFrame, /Late replacement evidence|9 unread/u);
  assert.match(reconcileFrame, /q quit/u);
  assert.doesNotMatch(reconcileFrame, /Esc request cancel/u);
  harness.feed("\u001b");
  harness.fireTimeout();
  assert.equal(cancelCalls, 0);
  assert.match(harness.writes.at(-1)!, /Checking durable state/u);

  harness.fireTimers(100, 4);
  reconcile.resolve();
  await settle();
  const finishingFrame = harness.writes.at(-1)!;
  assert.match(finishingFrame, /Confirmed · finishing motion pass/u);
  assertIncludesLines(finishingFrame, frozenEvidence);
  assert.doesNotMatch(finishingFrame, /Late replacement evidence|9 unread/u);
  harness.fireTimers(100, HORSE_FRAME_COUNT - 5);
  assert.doesNotMatch(harness.writes.at(-1)!, /Home · Open/u);
  harness.fireTimers(100);
  assert.match(harness.writes.at(-1)!, /Home · Open/u);
  assert.equal(harness.timerCount(100), 0);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("failure interrupts lifecycle motion without completing the ceremony", async () => {
  const open = makeItem({ name: "failed-lane", revision: 2 });
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: () => ({
      settled: Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "command failed",
        cancelled: false,
      }),
      cancel: () => undefined,
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("x");
  harness.feed("\r");
  await settle();
  assert.equal(harness.timerCount(100), 0);
  assert.match(harness.writes.at(-1)!, /Complete failed/u);
  assert.match(harness.writes.at(-1)!, /failed-lane is still open/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /finishing motion pass/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a confirmed warning finishes the pass but remains visible", async () => {
  const workstreamId = `ws_${"e".repeat(32)}`;
  const open = makeItem({ name: "warning-lane", workstreamId, revision: 6 });
  const completed = makeItem({
    name: "warning-lane",
    workstreamId,
    status: "completed",
    revision: 7,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: () => ({
      settled: Promise.resolve({
        code: 0,
        stdout: JSON.stringify(completed.record),
        stderr: "active members remain",
        cancelled: false,
      }),
      cancel: () => undefined,
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("x");
  harness.setCatalogue(makeCatalogue([completed]));
  harness.feed("\r");
  await settle();
  harness.fireTimers(100, HORSE_FRAME_COUNT - 1);
  harness.feed("\u001b");
  harness.fireTimers(100);
  const frame = harness.writes.at(-1)!;
  assert.match(frame, /Completed/u);
  assert.match(frame, /Warning · active members remain/u);
  assert.doesNotMatch(frame, /Home · Open/u);
  assert.equal(harness.timerCount(100), 0);
  harness.fireTimeout();
  assert.equal(harness.writes.at(-1)!, frame);
  assert.match(harness.writes.at(-1)!, /Warning · active members remain/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a visual-tier downgrade retires lifecycle motion without replay", async () => {
  const workstreamId = `ws_${"f".repeat(32)}`;
  const open = makeItem({ name: "resize-lane", workstreamId, revision: 8 });
  const completed = makeItem({
    name: "resize-lane",
    workstreamId,
    status: "completed",
    revision: 9,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const outcome = deferredValue<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
  }>();
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    workstreamWriter: () => ({
      settled: outcome.promise,
      cancel: () => undefined,
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("x");
  harness.feed("\r");
  harness.fireTimers(100, 3);
  harness.resize(56, 22);
  assert.equal(harness.timerCount(100), 1);
  const subFrame = harness.writes.at(-1)!;
  assert.match(subFrame, /Barbaro\s+Lifecycle/u);
  assert.match(subFrame, /running public command/u);
  assert.match(subFrame, /┌─ Completing resize-lane/u);
  assert.match(subFrame, /│[^\r\n]*B A R B A R O[^\r\n]*│/u);
  assert.match(subFrame, /resize-lane · open · No joined sessions/u);
  assert.match(subFrame, /Esc request cancel · q quit/u);
  harness.resize(40, 12);
  assert.equal(harness.timerCount(100), 0);
  assert.match(harness.writes.at(-1)!, /Completing/u);
  harness.resize(80, 30);
  assert.equal(harness.timerCount(100), 0);
  assert.match(harness.writes.at(-1)!, /Running the public workstream command/u);

  harness.setCatalogue(makeCatalogue([completed]));
  outcome.resolve({
    code: 0,
    stdout: JSON.stringify(completed.record),
    stderr: "",
    cancelled: false,
  });
  await settle();
  assert.match(harness.writes.at(-1)!, /resize-lane is completed/u);
  assert.doesNotMatch(harness.writes.at(-1)!, /Home · Open/u);
  assert.equal(harness.timerCount(100), 0);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("clean reopen runs the same pass and returns selected to Home Open", async () => {
  const workstreamId = `ws_${"0".repeat(32)}`;
  const completed = makeItem({
    name: "reopen-film",
    workstreamId,
    status: "completed",
    revision: 3,
  });
  const reopened = makeItem({
    name: "reopen-film",
    workstreamId,
    status: "open",
    revision: 4,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const harness = makeHarness({
    catalogue: makeCatalogue([completed]),
    workstreamWriter: () => ({
      settled: Promise.resolve({
        code: 0,
        stdout: JSON.stringify(reopened.record),
        stderr: "",
        cancelled: false,
      }),
      cancel: () => undefined,
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.feed("/");
  harness.feed("x");
  harness.setCatalogue(makeCatalogue([reopened]));
  harness.feed("\r");
  await settle();
  harness.fireTimers(100, HORSE_FRAME_COUNT);
  const frame = harness.writes.at(-1)!;
  assert.match(frame, /Home · Open/u);
  assert.match(frame, /> reopen-film/u);
  assert.equal(harness.timerCount(100), 0);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a stale refresh cannot overwrite lifecycle reconciliation", async () => {
  const workstreamId = `ws_${"8".repeat(32)}`;
  const open = makeItem({
    name: "generation-lock",
    workstreamId,
    revision: 1,
    working: 1,
  });
  const completed = makeItem({
    name: "generation-lock",
    workstreamId,
    status: "completed",
    revision: 2,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const staleRead = deferred();
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    motion: false,
    workstreamWriter: () => ({
      settled: Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          workstream_id: workstreamId,
          name: "generation-lock",
          status: "completed",
          revision: 2,
        }),
        cancelled: false,
      }),
      cancel: () => undefined,
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.queueCatalogueRead(makeCatalogue([open]), staleRead.promise);
  harness.feed("r");
  await settle();
  assert.equal(harness.counters.catalogue, 2);

  harness.feed("x");
  harness.queueCatalogueRead(makeCatalogue([completed]));
  harness.feed("\r");
  await settle();
  assert.match(harness.writes.at(-1)!, /generation-lock is completed/u);

  staleRead.resolve();
  await settle();
  assert.match(harness.writes.at(-1)!, /generation-lock is completed/u);
  harness.feed("/");
  const frame = harness.writes.at(-1)!;
  assert.match(frame, /Home · Completed/u);
  assert.match(frame, /> generation-lock/u);
  assert.match(frame, /1 of 1 completed · 0 open/u);

  harness.feed("q");
  assert.equal(await run, 0);
});

test("a stale refresh failure cannot leak across lifecycle reconciliation", async () => {
  const workstreamId = `ws_${"9".repeat(32)}`;
  const open = makeItem({
    name: "generation-failure",
    workstreamId,
    revision: 1,
  });
  const completed = makeItem({
    name: "generation-failure",
    workstreamId,
    status: "completed",
    revision: 2,
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  const staleRead = deferred();
  const harness = makeHarness({
    catalogue: makeCatalogue([open]),
    motion: false,
    workstreamWriter: () => ({
      settled: Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          workstream_id: workstreamId,
          name: "generation-failure",
          status: "completed",
          revision: 2,
        }),
        cancelled: false,
      }),
      cancel: () => undefined,
    }),
  });
  const run = runComfortTui(harness.options);
  await completeBoot(harness);

  harness.queueCatalogueFailure(new Error("obsolete read failed"), staleRead.promise);
  harness.feed("r");
  await settle();
  harness.feed("x");
  harness.queueCatalogueRead(makeCatalogue([completed]));
  harness.feed("\r");
  await settle();
  assert.match(harness.writes.at(-1)!, /generation-failure is completed/u);

  staleRead.resolve();
  await settle();
  harness.feed("/");
  const frame = harness.writes.at(-1)!;
  assert.match(frame, /Home · Completed/u);
  assert.match(frame, /> generation-failure/u);
  assert.doesNotMatch(frame, /Refresh failed|obsolete read failed/u);

  harness.feed("q");
  assert.equal(await run, 0);
});
