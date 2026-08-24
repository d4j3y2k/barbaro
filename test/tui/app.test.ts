import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReaderActiveSummary,
  ReaderContextV1,
  ReaderProjection,
} from "../../src/reader/types.js";
import {
  DEFAULT_TUI_INTERVAL_MS,
  runTui,
  type TuiInput,
  type TuiOutput,
  type TuiRuntimeDependencies,
  type TuiSignalSource,
} from "../../src/tui/app.js";
import {
  HORSE_FRAME_COUNT,
  HORSE_FRAME_INTERVAL_MS,
} from "../../src/tui/horse.js";
import type { DashboardRenderOptions } from "../../src/tui/render.js";

const NOW = new Date("2026-08-20T20:05:00.000Z");
const WORKSTREAM_ID = "ws_11111111111111111111111111111111";
const ENTER_SEQUENCE =
  "\u001b[?1049h\u001b[?25l\u001b[?2004h\u001b[H\u001b[2J";
const LEAVE_SEQUENCE = "\u001b[?2004l\u001b[?25h\u001b[?1049l";

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

class FakeInput implements TuiInput {
  public isTTY = true;
  public isRaw = false;
  public readableFlowing: boolean | null = null;
  public paused = false;
  public readonly rawCalls: boolean[] = [];
  public resumes = 0;
  public pauses = 0;
  public offCalls = 0;
  private readonly dataListeners = new Set<(chunk: Buffer | string) => void>();

  public setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawCalls.push(enabled);
  }

  public resume(): void {
    this.resumes += 1;
    this.readableFlowing = true;
    this.paused = false;
  }

  public pause(): void {
    this.pauses += 1;
    this.readableFlowing = false;
    this.paused = true;
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public on(
    _event: "data",
    listener: (chunk: Buffer | string) => void,
  ): void {
    this.dataListeners.add(listener);
  }

  public off(
    _event: "data",
    listener: (chunk: Buffer | string) => void,
  ): void {
    this.offCalls += 1;
    this.dataListeners.delete(listener);
  }

  public emitData(chunk: Buffer | string): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  public listenerCount(): number {
    return this.dataListeners.size;
  }
}

class FakeOutput implements TuiOutput {
  public isTTY = true;
  public columns = 80;
  public rows = 24;
  public readonly writes: string[] = [];
  public offCalls = 0;
  public failResizeListener = false;
  private readonly resizeListeners = new Set<() => void>();

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  public on(_event: "resize", listener: () => void): void {
    this.resizeListeners.add(listener);
    if (this.failResizeListener) throw new Error("resize listener failed");
  }

  public off(_event: "resize", listener: () => void): void {
    this.offCalls += 1;
    this.resizeListeners.delete(listener);
  }

  public emitResize(): void {
    for (const listener of [...this.resizeListeners]) listener();
  }

  public listenerCount(): number {
    return this.resizeListeners.size;
  }
}

class FakeSignals implements TuiSignalSource {
  public offCalls = 0;
  private readonly listeners = new Map<Signal, Set<() => void>>();

  public on(signal: Signal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  public off(signal: Signal, listener: () => void): void {
    this.offCalls += 1;
    this.listeners.get(signal)?.delete(listener);
  }

  public emit(signal: Signal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }

  public listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

class ManualScheduler {
  public clearIntervalCalls = 0;
  public clearTimeoutCalls = 0;
  public failClearInterval = false;
  public failSetIntervalAtDelay: number | undefined;
  private nextHandle = 1;
  private readonly intervals = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  private readonly timeouts = new Map<number, () => void>();

  public readonly setInterval = (
    callback: () => void,
    delayMs: number,
  ): number => {
    if (delayMs === this.failSetIntervalAtDelay) {
      throw new Error(`set interval failed at ${delayMs}ms`);
    }
    const handle = this.nextHandle++;
    this.intervals.set(handle, { callback, delayMs });
    return handle;
  };

  public readonly clearInterval = (handle: unknown): void => {
    this.clearIntervalCalls += 1;
    this.intervals.delete(handle as number);
    if (this.failClearInterval) throw new Error("clear interval failed");
  };

  public readonly setTimeout = (callback: () => void): number => {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, callback);
    return handle;
  };

  public readonly clearTimeout = (handle: unknown): void => {
    this.clearTimeoutCalls += 1;
    this.timeouts.delete(handle as number);
  };

  public fireIntervals(delayMs: number): void {
    for (const interval of [...this.intervals.values()]) {
      if (interval.delayMs === delayMs) interval.callback();
    }
  }

  public fireTimeouts(): void {
    const callbacks = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }

  public intervalCount(delayMs?: number): number {
    if (delayMs === undefined) return this.intervals.size;
    return [...this.intervals.values()].filter(
      (interval) => interval.delayMs === delayMs,
    ).length;
  }
}

function projection(): ReaderProjection<ReaderContextV1> {
  return {
    byte_budget: 65_536,
    utf8_bytes: 128,
    value: {
      schema: "barbaro.reader.context.v1",
      active: { shown: 0, total: 0, items: [] },
      turns: { shown: 0, total: 0, items: [] },
      diagnostics: {
        feed_files: 0,
        malformed_feed_records: 0,
        invalid_feed_records: 0,
        partial_feed_files: 0,
        scan_limited_feed_files: 0,
        invalid_active_records: 0,
      },
    },
  };
}

function projectionWithActor(
  unknownWriteScope = false,
): ReaderProjection<ReaderContextV1> {
  const active: ReaderActiveSummary = {
    lease_id: "lease_11111111111111111111111111111111",
    provider: "codex",
    session_id: "ses_11111111111111111111111111111111",
    workstream_id: "ws_11111111111111111111111111111111",
    agent_id: "main",
    state: "working",
    claims: { shown: 0, total: 0, items: [] },
    unknown_write_scope: unknownWriteScope,
    revision: 1,
    updated_at: "2026-08-20T20:04:59.000Z",
    expires_at: "2026-08-20T20:05:30.000Z",
    source_refs: 1,
  };
  const value = projection();
  return {
    ...value,
    value: {
      ...value.value,
      active: { shown: 1, total: 1, items: [active] },
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(
  dependencies: Partial<TuiRuntimeDependencies> = {},
): {
  readonly input: FakeInput;
  readonly output: FakeOutput;
  readonly signals: FakeSignals;
  readonly scheduler: ManualScheduler;
  readonly dependencies: Partial<TuiRuntimeDependencies>;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  const signals = new FakeSignals();
  const scheduler = new ManualScheduler();
  return {
    input,
    output,
    signals,
    scheduler,
    dependencies: {
      signals,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      ...dependencies,
    },
  };
}

test("interactive TTY owns and restores terminal resources exactly once", async () => {
  const h = harness({ loadProjectContext: async () => projection() });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    clock: () => NOW,
    dependencies: h.dependencies,
  });
  await flush();

  assert.equal(h.output.writes[0], ENTER_SEQUENCE);
  assert.match(h.output.writes[1]!, /^\u001b\[H/u);
  assert.match(h.output.writes[1]!, /\u001b\[J$/u);
  assert.equal(h.output.writes.join("").match(/\u001b\[2J/gu)?.length, 1);
  assert.deepEqual(h.input.rawCalls, [true]);
  assert.equal(h.scheduler.intervalCount(DEFAULT_TUI_INTERVAL_MS), 1);
  assert.equal(h.scheduler.intervalCount(HORSE_FRAME_INTERVAL_MS), 1);
  assert.equal(h.scheduler.intervalCount(), 2);
  assert.equal(h.signals.listenerCount(), 3);

  h.input.emitData("q");
  h.input.emitData("\u0003");
  await running;

  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
  assert.deepEqual(h.input.rawCalls, [true, false]);
  assert.equal(h.input.resumes, 1);
  assert.equal(h.input.pauses, 1);
  assert.equal(h.input.offCalls, 1);
  assert.equal(h.output.offCalls, 1);
  assert.equal(h.signals.offCalls, 3);
  assert.equal(h.scheduler.clearIntervalCalls, 2);
  assert.equal(h.scheduler.intervalCount(), 0);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.output.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
});

test("non-TTY refusal leaves terminal state untouched", async () => {
  const h = harness();
  h.input.isTTY = false;

  await assert.rejects(
    runTui({
      projectRoot: "/work/barbaro",
      input: h.input,
      output: h.output,
      dependencies: h.dependencies,
    }),
    /requires an interactive terminal/,
  );
  assert.deepEqual(h.output.writes, []);
  assert.deepEqual(h.input.rawCalls, []);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
});

test("partial timer dependency injection fails before terminal mutation", async () => {
  for (const dependencies of [
    { setInterval: (): number => 1 },
    { clearInterval: (): void => undefined },
    { setTimeout: (): number => 1 },
    { clearTimeout: (): void => undefined },
  ] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    await assert.rejects(
      runTui({
        projectRoot: "/work/barbaro",
        input,
        output,
        dependencies,
      }),
      /must be provided together/,
    );
    assert.deepEqual(output.writes, []);
    assert.deepEqual(input.rawCalls, []);
  }
});

test("invalid clocks and intervals fail before terminal mutation", async () => {
  for (const options of [
    { intervalMs: 0 },
    { animationIntervalMs: 0 },
    { animationClock: (): number => Number.NaN },
    { clock: (): Date => new Date(Number.NaN) },
  ] as const) {
    const h = harness();
    await assert.rejects(
      runTui({
        projectRoot: "/work/barbaro",
        ...options,
        input: h.input,
        output: h.output,
        dependencies: h.dependencies,
      }),
      /positive integer|finite number|valid Date/u,
    );
    assert.deepEqual(h.output.writes, []);
    assert.deepEqual(h.input.rawCalls, []);
    assert.equal(h.scheduler.intervalCount(), 0);
  }
});

test("cleanup stops neutral/paused input but preserves a prior flowing state", async () => {
  const flowing = harness({ loadProjectContext: async () => projection() });
  flowing.input.readableFlowing = true;
  flowing.input.paused = false;
  const flowingRun = runTui({
    projectRoot: "/work/barbaro",
    input: flowing.input,
    output: flowing.output,
    dependencies: flowing.dependencies,
  });
  await flush();
  flowing.input.emitData("q");
  await flowingRun;
  assert.equal(flowing.input.pauses, 0);
  assert.equal(flowing.input.paused, false);

  const rawPaused = harness({ loadProjectContext: async () => projection() });
  rawPaused.input.isRaw = true;
  rawPaused.input.readableFlowing = false;
  rawPaused.input.paused = true;
  const rawPausedRun = runTui({
    projectRoot: "/work/barbaro",
    input: rawPaused.input,
    output: rawPaused.output,
    dependencies: rawPaused.dependencies,
  });
  await flush();
  rawPaused.input.emitData("q");
  await rawPausedRun;
  assert.deepEqual(rawPaused.input.rawCalls, [true, true]);
  assert.equal(rawPaused.input.pauses, 1);
  assert.equal(rawPaused.input.paused, true);
});

test("quit completes while the initial load is still pending", async () => {
  const pending = deferred<ReaderProjection<ReaderContextV1>>();
  const h = harness({ loadProjectContext: async () => pending.promise });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });

  h.input.emitData("q");
  await running;
  assert.deepEqual(h.output.writes, [ENTER_SEQUENCE, LEAVE_SEQUENCE]);

  pending.resolve(projection());
  await flush();
  assert.deepEqual(h.output.writes, [ENTER_SEQUENCE, LEAVE_SEQUENCE]);
});

test("refresh requests serialize and coalesce to one queued read", async () => {
  const first = deferred<ReaderProjection<ReaderContextV1>>();
  const second = deferred<ReaderProjection<ReaderContextV1>>();
  const loads = [first, second];
  let loadCalls = 0;
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const h = harness({
    loadProjectContext: async () => {
      const current = loads[loadCalls++];
      assert.ok(current, "unexpected extra load");
      activeLoads += 1;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      try {
        return await current.promise;
      } finally {
        activeLoads -= 1;
      }
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });

  h.input.emitData("r");
  h.input.emitData("r");
  h.scheduler.fireIntervals(DEFAULT_TUI_INTERVAL_MS);
  assert.equal(loadCalls, 1);
  first.resolve(projection());
  await flush();
  assert.equal(loadCalls, 2);
  assert.equal(maximumActiveLoads, 1);

  second.resolve(projection());
  await flush();
  assert.equal(loadCalls, 2);
  h.input.emitData("q");
  await running;
});

test("unknown write scope does not stop independent animation cadence", async () => {
  const refreshIntervalMs = 750;
  const animationIntervalMs = 40;
  let animationNow = 0;
  let loadCalls = 0;
  const frameIndexes: number[] = [];
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      return projectionWithActor(true);
    },
    renderDashboard: (_value, options = {}) => {
      frameIndexes.push(options.horseFrameIndex ?? -1);
      return `FRAME ${frameIndexes.length}`;
    },
  });
  h.output.columns = 150;
  h.output.rows = 28;
  const running = runTui({
    projectRoot: "/work/barbaro",
    intervalMs: refreshIntervalMs,
    animationIntervalMs,
    animationClock: () => animationNow,
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();

  assert.equal(h.scheduler.intervalCount(refreshIntervalMs), 1);
  assert.equal(h.scheduler.intervalCount(animationIntervalMs), 1);
  assert.equal(loadCalls, 1);
  assert.deepEqual(frameIndexes, [0]);

  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.equal(loadCalls, 1);
  assert.deepEqual(frameIndexes, [0, 1]);

  h.scheduler.fireIntervals(refreshIntervalMs);
  assert.equal(loadCalls, 2);
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.deepEqual(frameIndexes, [0, 1, 2]);
  await flush();
  assert.equal(loadCalls, 2);
  assert.deepEqual(frameIndexes, [0, 1, 2, 2]);

  h.input.emitData("q");
  await running;
});

test("animation stays independent of slow reads and is inert before data", async () => {
  const refreshIntervalMs = 800;
  const animationIntervalMs = 25;
  let animationNow = 0;
  const first = deferred<ReaderProjection<ReaderContextV1>>();
  const second = deferred<ReaderProjection<ReaderContextV1>>();
  const loads = [first, second];
  let loadCalls = 0;
  const frameIndexes: number[] = [];
  const h = harness({
    loadProjectContext: async () => {
      const current = loads[loadCalls++];
      assert.ok(current, "unexpected extra load");
      return current.promise;
    },
    renderDashboard: (_value, options = {}) => {
      frameIndexes.push(options.horseFrameIndex ?? -1);
      return `FRAME ${frameIndexes.length}`;
    },
  });
  h.output.columns = 150;
  h.output.rows = 28;
  const running = runTui({
    projectRoot: "/work/barbaro",
    intervalMs: refreshIntervalMs,
    animationIntervalMs,
    animationClock: () => animationNow,
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });

  assert.equal(loadCalls, 1);
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.deepEqual(frameIndexes, []);
  assert.deepEqual(h.output.writes, [ENTER_SEQUENCE]);

  first.resolve(projection());
  await flush();
  assert.deepEqual(frameIndexes, [2]);

  h.scheduler.fireIntervals(refreshIntervalMs);
  assert.equal(loadCalls, 2);
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.deepEqual(frameIndexes, [2, 3]);

  second.resolve(projection());
  await flush();
  assert.deepEqual(frameIndexes, [2, 3, 3]);
  h.input.emitData("q");
  await running;
});

test("one delayed animation tick catches up and normalizes by elapsed time", async () => {
  const animationIntervalMs = 20;
  let animationNow = 5_000;
  let loadCalls = 0;
  const frameIndexes: number[] = [];
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      return projection();
    },
    renderDashboard: (_value, options = {}) => {
      frameIndexes.push(options.horseFrameIndex ?? -1);
      return `FRAME ${frameIndexes.length}`;
    },
  });
  h.output.columns = 150;
  h.output.rows = 28;
  const running = runTui({
    projectRoot: "/work/barbaro",
    animationIntervalMs,
    animationClock: () => animationNow,
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  assert.deepEqual(frameIndexes, [0]);

  animationNow += animationIntervalMs * (HORSE_FRAME_COUNT + 3);
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.equal(loadCalls, 1);
  assert.deepEqual(frameIndexes, [0, 3]);

  h.input.emitData("q");
  await running;
});

test("animation ticks do not redraw hidden, detail, or error frames", async () => {
  const animationIntervalMs = 30;
  let animationNow = 0;
  let loadCalls = 0;
  const frameIndexes: number[] = [];
  const errorIndexes: number[] = [];
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      if (loadCalls === 2) throw new Error("reader unavailable");
      return projectionWithActor();
    },
    renderDashboard: (_value, options = {}) => {
      frameIndexes.push(options.horseFrameIndex ?? -1);
      return `FRAME ${frameIndexes.length}`;
    },
    renderDashboardError: (_error, options = {}) => {
      errorIndexes.push(options.horseFrameIndex ?? -1);
      return `ERROR ${errorIndexes.length}`;
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    animationIntervalMs,
    animationClock: () => animationNow,
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  assert.deepEqual(frameIndexes, [0]);

  const smallWrites = h.output.writes.length;
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.deepEqual(frameIndexes, [0]);
  assert.equal(h.output.writes.length, smallWrites);

  h.output.columns = 150;
  h.output.rows = 28;
  h.output.emitResize();
  assert.deepEqual(frameIndexes, [0, 1]);
  h.input.emitData("\r");
  const detailWrites = h.output.writes.length;
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.equal(h.output.writes.length, detailWrites);

  h.input.emitData("\u001b");
  h.scheduler.fireTimeouts();
  h.input.emitData("r");
  await flush();
  assert.deepEqual(errorIndexes, [2]);
  const errorWrites = h.output.writes.length;
  animationNow += animationIntervalMs;
  h.scheduler.fireIntervals(animationIntervalMs);
  assert.deepEqual(errorIndexes, [2]);
  assert.equal(h.output.writes.length, errorWrites);

  h.input.emitData("q");
  await running;
});

test("redraws keep the captured data time while the next refresh is pending", async () => {
  const firstRefresh = new Date("2026-08-20T20:05:00.000Z");
  const secondRefresh = new Date("2026-08-20T20:06:00.000Z");
  const refreshTimes = [firstRefresh, secondRefresh];
  const secondRead = deferred<ReaderProjection<ReaderContextV1>>();
  const readTimes: Date[] = [];
  const renderTimes: Date[] = [];
  let clockCalls = 0;
  let animationNow = 0;
  const h = harness({
    loadProjectContext: async (_projectRoot, options) => {
      assert.ok(options.now instanceof Date);
      readTimes.push(options.now);
      return readTimes.length === 1 ? projection() : secondRead.promise;
    },
    renderDashboard: (_value, options = {}) => {
      renderTimes.push(options.now!);
      return `FRAME ${renderTimes.length}`;
    },
  });
  h.output.columns = 150;
  h.output.rows = 28;
  const running = runTui({
    projectRoot: "/work/barbaro",
    animationClock: () => animationNow,
    clock: () => refreshTimes[clockCalls++]!,
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();

  animationNow += HORSE_FRAME_INTERVAL_MS;
  h.scheduler.fireIntervals(HORSE_FRAME_INTERVAL_MS);
  h.output.emitResize();
  h.input.emitData("\t");
  assert.equal(clockCalls, 1);
  assert.deepEqual(readTimes, [firstRefresh]);
  assert.ok(renderTimes.every((time) => time === firstRefresh));

  h.scheduler.fireIntervals(DEFAULT_TUI_INTERVAL_MS);
  assert.equal(clockCalls, 2);
  assert.deepEqual(readTimes, [firstRefresh, secondRefresh]);
  animationNow += HORSE_FRAME_INTERVAL_MS;
  h.scheduler.fireIntervals(HORSE_FRAME_INTERVAL_MS);
  assert.equal(renderTimes.at(-1), firstRefresh);

  secondRead.resolve(projection());
  await flush();
  assert.equal(renderTimes.at(-1), secondRefresh);

  h.input.emitData("q");
  await running;
});

test("motion and color opt-outs keep the horse on a static frame", async () => {
  const refreshIntervalMs = 650;
  const animationIntervalMs = 35;
  const cases = [
    { label: "motion disabled", options: { motion: false } },
    { label: "color disabled", options: { color: false } },
  ] as const;

  for (const scenario of cases) {
    const frameIndexes: number[] = [];
    let loadCalls = 0;
    const h = harness({
      loadProjectContext: async () => {
        loadCalls += 1;
        return projection();
      },
      renderDashboard: (_value, options = {}) => {
        frameIndexes.push(options.horseFrameIndex ?? -1);
        return `FRAME ${frameIndexes.length}`;
      },
    });
    const running = runTui({
      projectRoot: "/work/barbaro",
      intervalMs: refreshIntervalMs,
      animationIntervalMs,
      ...scenario.options,
      input: h.input,
      output: h.output,
      dependencies: h.dependencies,
    });
    await flush();

    assert.equal(
      h.scheduler.intervalCount(animationIntervalMs),
      0,
      scenario.label,
    );
    assert.equal(h.scheduler.intervalCount(refreshIntervalMs), 1);
    h.scheduler.fireIntervals(animationIntervalMs);
    h.output.emitResize();
    h.scheduler.fireIntervals(refreshIntervalMs);
    await flush();
    assert.equal(loadCalls, 2);
    assert.ok(
      frameIndexes.length >= 3 && frameIndexes.every((index) => index === 0),
      scenario.label,
    );

    h.input.emitData("q");
    await running;
    assert.equal(h.scheduler.clearIntervalCalls, 1, scenario.label);
  }
});

test("one workstream scope source reaches every read and rendered frame", async () => {
  const refreshIntervalMs = 925;
  const scope = { name: "Checkout migration", workstreamId: WORKSTREAM_ID };
  const loadOptions: Array<
    Parameters<TuiRuntimeDependencies["loadProjectContext"]>[1]
  > = [];
  const renderOptions: DashboardRenderOptions[] = [];
  const h = harness({
    loadProjectContext: async (_projectRoot, options) => {
      loadOptions.push(options);
      return projection();
    },
    renderDashboard: (_value, options = {}) => {
      renderOptions.push(options);
      return `FRAME ${renderOptions.length}`;
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    scope,
    motion: false,
    intervalMs: refreshIntervalMs,
    input: h.input,
    output: h.output,
    clock: () => NOW,
    dependencies: h.dependencies,
  });
  await flush();
  h.scheduler.fireIntervals(refreshIntervalMs);
  await flush();

  assert.equal(loadOptions.length, 2);
  assert.ok(
    loadOptions.every((options) => options.workstreamId === WORKSTREAM_ID),
  );
  assert.ok(loadOptions.every((options) => options.now === NOW));
  assert.ok(renderOptions.length >= 2);
  assert.ok(renderOptions.every((options) => options.scope === scope));
  assert.ok(renderOptions.every((options) => options.horseFrameIndex === 0));

  h.input.emitData("q");
  await running;
});

test("resize and navigation redraw without reading; interval refreshes data", async () => {
  let loadCalls = 0;
  const renderOptions: DashboardRenderOptions[] = [];
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      return projection();
    },
    renderDashboard: (_value, options = {}) => {
      renderOptions.push(options);
      return `FRAME ${renderOptions.length}`;
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  assert.equal(loadCalls, 1);
  assert.equal(renderOptions.length, 1);

  h.output.columns = 110;
  h.output.rows = 30;
  h.output.emitResize();
  h.input.emitData("\t");
  h.input.emitData("j");
  assert.equal(loadCalls, 1);
  assert.equal(renderOptions.length, 4);
  assert.equal(renderOptions.at(-1)?.navigation?.focusedPane, "turns");
  assert.ok(
    (renderOptions[1]?.navigation?.panes.active.viewportSize ?? 0) > 1,
  );

  h.scheduler.fireIntervals(DEFAULT_TUI_INTERVAL_MS);
  await flush();
  assert.equal(loadCalls, 2);
  h.input.emitData("q");
  await running;
});

test("a visible refresh error recovers after a later successful read", async () => {
  let loadCalls = 0;
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      if (loadCalls === 1) throw new Error("reader unavailable");
      return projection();
    },
    renderDashboard: () => "RECOVERED",
    renderDashboardError: (error) =>
      `ERROR ${error instanceof Error ? error.message : String(error)}`,
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  assert.ok(h.output.writes.some((write) => write.includes("reader unavailable")));

  h.input.emitData("r");
  await flush();
  assert.ok(h.output.writes.some((write) => write.includes("RECOVERED")));
  h.input.emitData("q");
  await running;
});

test("enabled bracketed paste keeps fragmented q and r payloads inert", async () => {
  let loadCalls = 0;
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      return projection();
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  assert.match(h.output.writes[0]!, /\u001b\[\?2004h/u);

  h.input.emitData("\u001b[20");
  h.input.emitData("0~q");
  h.input.emitData("r");
  h.input.emitData("\u001b[20");
  h.input.emitData("1~");
  await flush();
  assert.equal(loadCalls, 1);
  assert.notEqual(h.output.writes.at(-1), LEAVE_SEQUENCE);

  h.input.emitData("q");
  await running;
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("termination signals quit and ignore a late loader completion", async () => {
  const pending = deferred<ReaderProjection<ReaderContextV1>>();
  const h = harness({ loadProjectContext: async () => pending.promise });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });

  h.signals.emit("SIGTERM");
  await running;
  assert.equal(h.signals.listenerCount(), 0);
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
  pending.resolve(projection());
  await flush();
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("render failures reject after restoring every terminal resource", async () => {
  const h = harness({
    loadProjectContext: async () => projection(),
    renderDashboard: () => {
      throw new Error("render failed");
    },
  });
  await assert.rejects(
    runTui({
      projectRoot: "/work/barbaro",
      input: h.input,
      output: h.output,
      dependencies: h.dependencies,
    }),
    /render failed/,
  );

  assert.deepEqual(h.input.rawCalls, [true, false]);
  assert.equal(h.scheduler.clearIntervalCalls, 2);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.output.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("partial listener setup failure still performs complete cleanup", async () => {
  const h = harness({ loadProjectContext: async () => projection() });
  h.output.failResizeListener = true;

  await assert.rejects(
    runTui({
      projectRoot: "/work/barbaro",
      input: h.input,
      output: h.output,
      dependencies: h.dependencies,
    }),
    /resize listener failed/,
  );
  assert.deepEqual(h.input.rawCalls, [true, false]);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.output.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("animation timer setup failure clears the already-started refresh timer", async () => {
  const refreshIntervalMs = 700;
  const animationIntervalMs = 45;
  let loadCalls = 0;
  const h = harness({
    loadProjectContext: async () => {
      loadCalls += 1;
      return projection();
    },
  });
  h.scheduler.failSetIntervalAtDelay = animationIntervalMs;

  await assert.rejects(
    runTui({
      projectRoot: "/work/barbaro",
      intervalMs: refreshIntervalMs,
      animationIntervalMs,
      input: h.input,
      output: h.output,
      dependencies: h.dependencies,
    }),
    /set interval failed at 45ms/,
  );

  assert.equal(loadCalls, 0);
  assert.equal(h.scheduler.clearIntervalCalls, 1);
  assert.equal(h.scheduler.intervalCount(), 0);
  assert.deepEqual(h.input.rawCalls, [true, false]);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.output.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("one cleanup failure does not skip the remaining restoration steps", async () => {
  const h = harness({ loadProjectContext: async () => projection() });
  h.scheduler.failClearInterval = true;
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  h.input.emitData("q");

  await assert.rejects(running, /clear interval failed/);
  assert.deepEqual(h.input.rawCalls, [true, false]);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.output.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("an Escape-timer redraw failure rejects and restores the terminal", async () => {
  let renders = 0;
  const h = harness({
    loadProjectContext: async () => projection(),
    renderDashboard: () => {
      renders += 1;
      if (renders === 2) throw new Error("deferred render failed");
      return "FRAME";
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  h.input.emitData("\u001b");
  h.scheduler.fireTimeouts();

  await assert.rejects(running, /deferred render failed/);
  assert.deepEqual(h.input.rawCalls, [true, false]);
  assert.equal(h.input.listenerCount(), 0);
  assert.equal(h.output.listenerCount(), 0);
  assert.equal(h.signals.listenerCount(), 0);
  assert.equal(h.output.writes.at(-1), LEAVE_SEQUENCE);
});

test("bare Escape uses the injected bounded timer and closes detail", async () => {
  const details: DashboardRenderOptions["navigation"][] = [];
  const h = harness({
    loadProjectContext: async () => projectionWithActor(),
    renderDashboard: (_value, options = {}) => {
      details.push(options.navigation);
      return `FRAME ${details.length}`;
    },
  });
  const running = runTui({
    projectRoot: "/work/barbaro",
    input: h.input,
    output: h.output,
    dependencies: h.dependencies,
  });
  await flush();
  h.input.emitData("\r");
  assert.notEqual(details.at(-1)?.detail, null);

  h.input.emitData("\u001b");
  assert.notEqual(details.at(-1)?.detail, null);
  h.scheduler.fireTimeouts();
  assert.equal(details.at(-1)?.detail, null);
  h.input.emitData("q");
  await running;
});
