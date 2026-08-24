import { performance } from "node:perf_hooks";

import { readProjectContext } from "../reader/store.js";
import type { ReaderContextV1, ReaderProjection } from "../reader/types.js";

import { shouldRenderDashboardBranding } from "./branding.js";
import { createTuiInputParser, type TuiCommand } from "./input.js";
import {
  HORSE_FRAME_INTERVAL_MS,
  horseFrameIndex as frameIndexAtElapsedTime,
} from "./horse.js";
import { buildDashboardViewModel } from "./model.js";
import {
  dashboardNavigationViewports,
  renderDashboard,
  renderDashboardError,
  type DashboardRenderOptions,
} from "./render.js";
import { TerminalScreen } from "./screen.js";
import {
  createNavigationState,
  navigationRecordsFromModel,
  reduceNavigationState,
  type TuiNavigationState,
} from "./state.js";

export const DEFAULT_TUI_INTERVAL_MS = 1_000;
export const DEFAULT_TUI_BYTE_BUDGET = 64 * 1_024;
export const DEFAULT_TUI_TURNS_PER_SESSION = 20;

type TuiSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface TuiInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  isPaused?(): boolean;
  setRawMode(enabled: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface TuiOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface TuiSignalSource {
  on(signal: TuiSignal, listener: () => void): unknown;
  off(signal: TuiSignal, listener: () => void): unknown;
}

export interface TuiRuntimeDependencies {
  readonly loadProjectContext: typeof readProjectContext;
  readonly renderDashboard: typeof renderDashboard;
  readonly renderDashboardError: typeof renderDashboardError;
  readonly signals: TuiSignalSource;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface TuiOptions {
  readonly projectRoot: string;
  readonly scope?: {
    readonly name: string;
    readonly workstreamId: string;
  };
  readonly intervalMs?: number;
  readonly animationIntervalMs?: number;
  readonly byteBudget?: number;
  readonly turnsPerSession?: number;
  readonly color?: boolean;
  readonly motion?: boolean;
  readonly input?: TuiInput;
  readonly output?: TuiOutput;
  readonly clock?: () => Date;
  readonly animationClock?: () => number;
  readonly dependencies?: Partial<TuiRuntimeDependencies>;
}

function defaultSetInterval(callback: () => void, delayMs: number): unknown {
  return setInterval(callback, delayMs);
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultClearTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultAnimationClock(): number {
  return performance.now();
}

function positiveInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function animationTime(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("animationClock must return a finite number");
  }
  return value;
}

function refreshTime(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return value;
}

function runtimeDependencies(
  overrides: Partial<TuiRuntimeDependencies> | undefined,
): TuiRuntimeDependencies {
  if (
    (overrides?.setInterval === undefined) !==
    (overrides?.clearInterval === undefined)
  ) {
    throw new TypeError(
      "setInterval and clearInterval must be provided together",
    );
  }
  if (
    (overrides?.setTimeout === undefined) !==
    (overrides?.clearTimeout === undefined)
  ) {
    throw new TypeError("setTimeout and clearTimeout must be provided together");
  }
  return {
    loadProjectContext: overrides?.loadProjectContext ?? readProjectContext,
    renderDashboard: overrides?.renderDashboard ?? renderDashboard,
    renderDashboardError:
      overrides?.renderDashboardError ?? renderDashboardError,
    signals: overrides?.signals ?? (process as TuiSignalSource),
    setInterval: overrides?.setInterval ?? defaultSetInterval,
    clearInterval: overrides?.clearInterval ?? defaultClearInterval,
    setTimeout: overrides?.setTimeout ?? defaultSetTimeout,
    clearTimeout: overrides?.clearTimeout ?? defaultClearTimeout,
  };
}

/** Run the alternate-screen control panel until q, Ctrl-C, or a signal closes it. */
export async function runTui(options: TuiOptions): Promise<void> {
  const input = options.input ?? (process.stdin as TuiInput);
  const output = options.output ?? (process.stdout as TuiOutput);
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "barbaro tui requires an interactive terminal; use --once for a plain snapshot",
    );
  }

  const dependencies = runtimeDependencies(options.dependencies);
  const intervalMs = positiveInterval(
    options.intervalMs ?? DEFAULT_TUI_INTERVAL_MS,
    "intervalMs",
  );
  const animationIntervalMs = positiveInterval(
    options.animationIntervalMs ?? HORSE_FRAME_INTERVAL_MS,
    "animationIntervalMs",
  );
  const byteBudget = options.byteBudget ?? DEFAULT_TUI_BYTE_BUDGET;
  const turnsPerSession =
    options.turnsPerSession ?? DEFAULT_TUI_TURNS_PER_SESSION;
  const clock = options.clock ?? (() => new Date());
  const animationClock = options.animationClock ?? defaultAnimationClock;
  const animationStartedAt = animationTime(animationClock());
  let initialRefreshTime: Date | undefined = refreshTime(clock());
  const screen = new TerminalScreen(output);
  const wasRaw = input.isRaw ?? false;
  const shouldPauseInput =
    input.readableFlowing === undefined
      ? (input.isPaused?.() ?? !wasRaw)
      : input.readableFlowing !== true;

  let latest: ReaderProjection<ReaderContextV1> | undefined;
  let latestModel: ReturnType<typeof buildDashboardViewModel> | undefined;
  let latestFailure: { readonly error: unknown } | undefined;
  let latestRefreshTime: Date | undefined;
  let navigation: TuiNavigationState = createNavigationState([], [], {
    viewports: dashboardNavigationViewports(output.columns, output.rows),
  });
  let refreshing = false;
  let refreshQueued = false;
  let closed = false;
  let settled = false;
  let currentHorseFrameIndex = 0;
  let refreshIntervalHandle: unknown;
  let refreshIntervalStarted = false;
  let animationIntervalHandle: unknown;
  let animationIntervalStarted = false;
  let rawModeAttempted = false;
  let inputResumed = false;
  let dataListenerInstalled = false;
  let resizeListenerInstalled = false;
  const installedSignals = new Set<TuiSignal>();

  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const renderOptions = (): DashboardRenderOptions => {
    if (latestRefreshTime === undefined) {
      throw new Error("cannot render before the first refresh attempt");
    }
    return {
      width: output.columns ?? 100,
      height: output.rows ?? 30,
      now: latestRefreshTime,
      projectRoot: options.projectRoot,
      ...(options.color === undefined ? {} : { color: options.color }),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      interactive: true,
      refreshIntervalMs: intervalMs,
      horseFrameIndex: currentHorseFrameIndex,
      navigation,
    };
  };

  const draw = (): void => {
    if (latest === undefined && latestFailure === undefined) return;
    const frame =
      latestFailure === undefined && latest !== undefined
        ? dependencies.renderDashboard(latest, renderOptions())
        : dependencies.renderDashboardError(
            latestFailure?.error,
            renderOptions(),
          );
    screen.draw(frame);
  };

  const dashboardBrandingVisible = (): boolean => {
    if (
      latest === undefined ||
      latestModel === undefined ||
      latestFailure !== undefined ||
      navigation.detail !== null
    ) {
      return false;
    }
    return shouldRenderDashboardBranding({
      width: output.columns ?? 100,
      height: output.rows ?? 30,
      priorityConflict: latestModel.overlaps.length > 0,
      diagnosticsVisible: !latestModel.diagnostics.healthy,
    });
  };

  const close = (): void => {
    if (settled) return;
    settled = true;
    closed = true;
    resolveFinished();
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    closed = true;
    rejectFinished(error);
  };

  const drainRefreshes = async (): Promise<void> => {
    try {
      do {
        refreshQueued = false;
        const nextRefreshTime = initialRefreshTime ?? refreshTime(clock());
        initialRefreshTime = undefined;
        let next: ReaderProjection<ReaderContextV1>;
        try {
          next = await dependencies.loadProjectContext(options.projectRoot, {
            byteBudget,
            turnsPerSession,
            now: nextRefreshTime,
            ...(options.scope === undefined
              ? {}
              : { workstreamId: options.scope.workstreamId }),
          });
        } catch (error: unknown) {
          if (!closed) {
            latestRefreshTime = nextRefreshTime;
            latestFailure = { error };
            draw();
          }
          continue;
        }

        if (closed) continue;
        const model = buildDashboardViewModel(next);
        navigation = reduceNavigationState(navigation, {
          type: "reconcile",
          records: navigationRecordsFromModel(model),
          viewports: dashboardNavigationViewports(output.columns, output.rows),
        });
        latest = next;
        latestModel = model;
        latestRefreshTime = nextRefreshTime;
        latestFailure = undefined;
        draw();
      } while (refreshQueued && !closed);
    } finally {
      refreshing = false;
    }
  };

  const requestRefresh = (): void => {
    if (closed) return;
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    void drainRefreshes().catch(fail);
  };

  const applyCommand = (command: TuiCommand): void => {
    if (closed) return;
    switch (command) {
      case "quit":
        close();
        return;
      case "refresh":
        requestRefresh();
        return;
      case "next-pane":
        navigation = reduceNavigationState(navigation, {
          type: "focus-next-pane",
        });
        draw();
        return;
      case "previous-pane":
        navigation = reduceNavigationState(navigation, {
          type: "focus-previous-pane",
        });
        draw();
        return;
      case "move-up":
        navigation = reduceNavigationState(navigation, {
          type: "move-selection",
          delta: -1,
        });
        draw();
        return;
      case "move-down":
        navigation = reduceNavigationState(navigation, {
          type: "move-selection",
          delta: 1,
        });
        draw();
        return;
      case "open-detail":
        navigation = reduceNavigationState(navigation, {
          type: "open-detail",
        });
        draw();
        return;
      case "close-detail":
        navigation = reduceNavigationState(navigation, {
          type: "close-detail",
        });
        draw();
    }
  };

  const emitCommand = (command: TuiCommand): void => {
    try {
      applyCommand(command);
    } catch (error: unknown) {
      fail(error);
    }
  };
  const parser = createTuiInputParser({
    emit: emitCommand,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
  });
  const onData = (chunk: Buffer | string): void => {
    try {
      parser.push(chunk);
    } catch (error: unknown) {
      fail(error);
    }
  };
  const onResize = (): void => {
    if (closed) return;
    try {
      navigation = reduceNavigationState(navigation, {
        type: "set-viewports",
        viewports: dashboardNavigationViewports(output.columns, output.rows),
      });
      draw();
    } catch (error: unknown) {
      fail(error);
    }
  };
  const onSignal = (): void => close();
  const onRefreshInterval = (): void => {
    try {
      requestRefresh();
    } catch (error: unknown) {
      fail(error);
    }
  };
  const onAnimationInterval = (): void => {
    if (closed) return;
    try {
      const elapsedMs = animationTime(animationClock()) - animationStartedAt;
      currentHorseFrameIndex = frameIndexAtElapsedTime(
        elapsedMs,
        animationIntervalMs,
      );
      if (dashboardBrandingVisible()) draw();
    } catch (error: unknown) {
      fail(error);
    }
  };

  const cleanup = (): { readonly error: unknown } | undefined => {
    const failures: { readonly error: unknown }[] = [];
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error: unknown) {
        failures.push({ error });
      }
    };

    attempt(() => parser.dispose());
    if (animationIntervalStarted) {
      animationIntervalStarted = false;
      attempt(() => dependencies.clearInterval(animationIntervalHandle));
    }
    if (refreshIntervalStarted) {
      refreshIntervalStarted = false;
      attempt(() => dependencies.clearInterval(refreshIntervalHandle));
    }
    if (dataListenerInstalled) {
      dataListenerInstalled = false;
      attempt(() => input.off("data", onData));
    }
    if (resizeListenerInstalled) {
      resizeListenerInstalled = false;
      attempt(() => output.off("resize", onResize));
    }
    for (const signal of installedSignals) {
      attempt(() => dependencies.signals.off(signal, onSignal));
    }
    installedSignals.clear();
    if (rawModeAttempted) {
      rawModeAttempted = false;
      attempt(() => input.setRawMode(wasRaw));
    }
    if (inputResumed) {
      inputResumed = false;
      if (shouldPauseInput) attempt(() => input.pause());
    }
    attempt(() => screen.leave());
    return failures[0];
  };

  let runFailure: { readonly error: unknown } | undefined;
  try {
    screen.enter();
    rawModeAttempted = true;
    input.setRawMode(true);
    inputResumed = true;
    input.resume();

    dataListenerInstalled = true;
    input.on("data", onData);
    resizeListenerInstalled = true;
    output.on("resize", onResize);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      installedSignals.add(signal);
      dependencies.signals.on(signal, onSignal);
    }
    refreshIntervalHandle = dependencies.setInterval(
      onRefreshInterval,
      intervalMs,
    );
    refreshIntervalStarted = true;
    if (options.motion !== false && options.color !== false) {
      animationIntervalHandle = dependencies.setInterval(
        onAnimationInterval,
        animationIntervalMs,
      );
      animationIntervalStarted = true;
    }
    requestRefresh();
    await finished;
  } catch (error: unknown) {
    runFailure = { error };
  }

  closed = true;
  const cleanupFailure = cleanup();
  if (runFailure !== undefined) throw runFailure.error;
  if (cleanupFailure !== undefined) throw cleanupFailure.error;
}
