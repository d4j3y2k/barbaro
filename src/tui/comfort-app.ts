import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  readProjectCatalogue,
  type ReaderCatalogueV1,
  type ReaderCatalogueWorkstream,
} from "../reader/catalogue.js";
import {
  readProjectStoreHealth,
} from "../reader/health.js";
import { readProjectContext } from "../reader/store.js";
import type { ReaderStoreHealth } from "../reader/types.js";

import { measureCells, padCells } from "./cells.js";
import { ComfortInputParser } from "./comfort-input.js";
import {
  COMFORT_BYTE_BUDGET,
  COMFORT_TURNS_PER_SESSION,
} from "./defaults.js";
import {
  fieldText,
  settleCreate,
  validateCreateForm,
  writerArgv,
  type CreateState,
  type WriterOutcome,
} from "./create.js";
import {
  pbcopyHelper,
  punchOut,
  type HelperResult,
  type PunchOutcome,
} from "./punch.js";
import { ComfortScreen } from "./comfort-screen.js";
import {
  chooseCard,
  composeMatte,
  matteOffsets,
  trueSizeNotice,
  type CardGeometry,
} from "./geometry.js";
import {
  dashboardRollAt,
  dashboardTurnFact,
  hubNewsTickerKeys,
  hubProjectionWarning,
  hubSelectableWorkstreamIds,
  reduceDashboard,
  reduceHub,
  relativeAgo,
  clockHHMM,
  excerptText,
  outcomeWord,
  shortSessionId,
  shortWorkstreamId,
  workingDotsAtTick,
  WORKING_DOT_CYCLE_TICKS,
  type DashboardTurnFact,
  type HubFilter,
  type HubNewsTickerSelection,
  type MotionPolicy,
} from "./reduce.js";
import {
  beginLifecycle as beginLifecycleState,
  lifecycleDecisionMarkerVisible,
  lifecycleArgv,
  lifecycleEvidenceBenchLine,
  lifecycleJoinedBenchLine,
  lifecycleTraversalGate,
  lifecycleTraversalProgressAtTick,
  settleLifecycle,
  LIFECYCLE_MOTION_INTERVAL_MS,
  type LifecycleAction,
  type LifecycleConfirmState,
  type LifecycleLookup,
  type LifecycleSettledState,
  type LifecycleState,
  type LifecycleWriterOutcome,
} from "./lifecycle.js";
import {
  renderBootSplash,
  renderBootTextPage,
  renderComfortCard,
  renderSubCard,
} from "./render-card.js";
import {
  startupFrameAtTick,
  startupStrideComplete,
} from "./startup.js";
import {
  accentSelectedHubRow,
  styleDashboardProvenanceRows,
} from "./style.js";
import { HORSE_FRAME_COUNT } from "./horse.js";
import type {
  BootView,
  CardView,
  FrameView,
  RollLineView,
} from "./view.js";

export const COMFORT_REFRESH_INTERVAL_MS = 1_000;
export const COMFORT_MOTION_INTERVAL_MS = LIFECYCLE_MOTION_INTERVAL_MS;

export interface ComfortTermRefusal {
  readonly lines: readonly [string, string, string];
}

/** §9's exact refusals: truthful, on stderr, and free of control bytes. */
export function comfortTermRefusal(
  term: string | undefined,
): ComfortTermRefusal | undefined {
  if (term === "dumb") {
    return {
      lines: [
        "barbaro tui: TERM=dumb cannot support interactive mode.",
        "Use: barbaro tui --once [--width N --height N]",
        "No alternate-screen, cursor, raw-mode, color, or animation bytes were emitted.",
      ],
    };
  }
  if (term === undefined || term.length === 0) {
    return {
      lines: [
        "barbaro tui: TERM is unset; interactive mode requires a capable terminal.",
        "Use: barbaro tui --once [--width N --height N]",
        "No alternate-screen, cursor, raw-mode, color, or animation bytes were emitted.",
      ],
    };
  }
  return undefined;
}

export interface ComfortInput {
  setRawMode?(enabled: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface ComfortOutput {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

type ComfortSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ComfortSignalSource {
  on(signal: ComfortSignal, listener: () => void): unknown;
  off(signal: ComfortSignal, listener: () => void): unknown;
}

export interface ComfortReaders {
  readonly readHealth: typeof readProjectStoreHealth;
  readonly readCatalogue: typeof readProjectCatalogue;
  readonly readContext: typeof readProjectContext;
}

export interface ComfortAppOptions {
  readonly projectRoot: string;
  readonly term: string | undefined;
  readonly stderr: (line: string) => void;
  readonly input: ComfortInput;
  readonly output: ComfortOutput;
  readonly signals?: ComfortSignalSource;
  readonly workstreamId?: string;
  /** Interactive ANSI color; defaults on and never affects motion. */
  readonly color?: boolean;
  readonly motion?: boolean;
  readonly intervalMs?: number;
  readonly motionIntervalMs?: number;
  readonly byteBudget?: number;
  readonly turnsPerSession?: number;
  readonly clock?: () => Date;
  /** Monotonic clock for elapsed UI measurements. */
  readonly monotonicNow?: () => number;
  readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly readers?: Partial<ComfortReaders>;
  /** Create writer seam retained for compatibility with existing callers. */
  readonly createWriter?: (argv: readonly string[]) => {
    readonly settled: Promise<WriterOutcome>;
    cancel(): void;
  };
  /** Lifecycle writer seam; always receives public-CLI argv fields. */
  readonly workstreamWriter?: (argv: readonly string[]) => {
    readonly settled: Promise<WriterOutcome>;
    cancel(): void;
  };
  /** Confirmation-capable clipboard helper; defaults to pbcopy. */
  readonly punchHelper?: (payload: string) => Promise<HelperResult>;
}

interface ComfortModel {
  health?: ReaderStoreHealth;
  catalogue?: ReaderCatalogueV1;
  turns: readonly DashboardTurnFact[];
  refresh?: RefreshMeasurement;
  refreshFailed?: boolean;
  readFailure?: string;
}

interface RefreshMeasurement {
  completedAtMs: number;
  projectedBytes: number;
  shownTurns: number;
  scopeWorkstreamId?: string;
}

type StartupPhase = "store" | "catalogue" | "workstream" | "ready" | "failed";

interface StartupState {
  startedAtMs: number;
  ticksElapsed: number;
  readDurationMs?: number;
  readSettled: boolean;
  minimumMet: boolean;
  phase: StartupPhase;
  projectedBytes: number;
  shownTurns: number;
  storeAbsent: boolean;
}

type LifecycleFilmPhase = "writer" | "reconcile" | "finishing";
type MotionScene = "lifecycle-film" | "lifecycle-decision" | "dashboard";

/** UI-only ceremony state; durable truth continues to live in LifecycleState. */
interface LifecycleFilmState {
  ticksElapsed: number;
  phase: LifecycleFilmPhase;
  /** Frozen confirmation evidence retained beneath the moving frame. */
  readonly bench: readonly string[];
  settlement?: LifecycleSettledState;
}

type ComfortMode =
  | { readonly kind: "home" }
  | { readonly kind: "dashboard"; readonly workstreamId: string };

/**
 * The comfort card's interactive shell. Entry precedence: arguments were
 * parsed by the CLI; TERM is refused before terminal ownership; geometry is
 * read; store presence resolves; then Home or the scoped dashboard renders.
 * Reads are serialized and coalesced; resize reflows without reading; the
 * motion timer exists only while a live scene is on screen.
 */
export async function runComfortTui(
  options: ComfortAppOptions,
): Promise<number> {
  const refusal = comfortTermRefusal(options.term);
  if (refusal !== undefined) {
    for (const line of refusal.lines) options.stderr(line);
    return 2;
  }

  const projectRoot = resolve(options.projectRoot);
  const readers: ComfortReaders = {
    readHealth: options.readers?.readHealth ?? readProjectStoreHealth,
    readCatalogue: options.readers?.readCatalogue ?? readProjectCatalogue,
    readContext: options.readers?.readContext ?? readProjectContext,
  };
  const clock = options.clock ?? (() => new Date());
  const armInterval =
    options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const disarmInterval =
    options.clearInterval ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const byteBudget = options.byteBudget ?? COMFORT_BYTE_BUDGET;
  const turnsPerSession =
    options.turnsPerSession ?? COMFORT_TURNS_PER_SESSION;
  const motionAllowed = options.motion !== false;
  const colorAllowed = options.color !== false;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const motionIntervalMs =
    options.motionIntervalMs ?? LIFECYCLE_MOTION_INTERVAL_MS;

  const screen = new ComfortScreen(options.output);
  const model: ComfortModel = { turns: [] };
  let mode: ComfortMode =
    options.workstreamId === undefined
      ? { kind: "home" }
      : { kind: "dashboard", workstreamId: options.workstreamId };
  let helpOpen = false;
  let homeFilter: HubFilter = "open";
  const homeSelections: Record<
    HubFilter,
    { index: number; workstreamId?: string }
  > = {
    open: { index: 0 },
    completed: { index: 0 },
  };
  let rollSelectionIndex = 0;
  let create: CreateState | undefined;
  let lifecycle: LifecycleState | undefined;
  let lifecycleFilm: LifecycleFilmState | undefined;
  let pendingBackLifecycleFilm: LifecycleFilmState | undefined;
  let lifecycleOrigin:
    | { readonly mode: ComfortMode; readonly filter: HubFilter }
    | undefined;
  let createdCommandIndex = 0;
  let punchResult: PunchOutcome | undefined;
  let punchPending = false;
  let pendingWriter: { cancel(): void } | undefined;
  let pendingLifecycleWriter: { cancel(): void } | undefined;
  let lifecycleDecisionTick = 0;
  let motionTick = 0;
  let workingPulseTick = 0;
  let homeNewsTickerOrder: string[] = [];
  let homeNewsTickerKey: string | undefined;
  let motionPaused = false;
  let startup: StartupState | undefined = {
    startedAtMs: monotonicNow(),
    ticksElapsed: 0,
    readSettled: false,
    minimumMet: !motionAllowed,
    phase: "store",
    projectedBytes: 0,
    shownTurns: 0,
    storeAbsent: false,
  };
  let startupTimer: unknown;
  let motionTimer: unknown;
  let motionScene: MotionScene | undefined;
  let refreshTimer: unknown;
  let readInFlight = false;
  let readQueued = false;
  let readGeneration = 0;
  let lifecycleReadLock = false;
  let closed = false;

  let resolveRun: (code: number) => void;
  const done = new Promise<number>((resolveDone) => {
    resolveRun = resolveDone;
  });

  const parser = new ComfortInputParser({
    events: {
      command: (command) => {
        const pressedFilm =
          command === "back" ? pendingBackLifecycleFilm : undefined;
        pendingBackLifecycleFilm = undefined;
        handleCommand(command, pressedFilm);
      },
      // §12: a paste is one field payload while editing, nothing otherwise.
      paste: (payload) => editorText(payload),
      text: (text) => editorText(text),
    },
    ...(options.setTimeout === undefined
      ? {}
      : { setTimeout: options.setTimeout }),
    ...(options.clearTimeout === undefined
      ? {}
      : { clearTimeout: options.clearTimeout }),
  });
  const onData = (chunk: Buffer | string): void => {
    const text =
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text === "\u001b") pendingBackLifecycleFilm = lifecycleFilm;
    parser.feed(chunk);
  };
  const onResize = (): void => {
    retireHiddenLifecycleFilm();
    syncMotionTimer();
    render();
  };
  const onSignal = (): void => {
    finish(0);
  };

  function finish(code: number): void {
    if (closed) return;
    closed = true;
    pendingWriter?.cancel();
    pendingLifecycleWriter?.cancel();
    stopStartup();
    stopMotion();
    if (refreshTimer !== undefined) disarmInterval(refreshTimer);
    parser.dispose();
    options.input.off("data", onData);
    options.output.off("resize", onResize);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      options.signals?.off(signal, onSignal);
    }
    options.input.setRawMode?.(false);
    options.input.pause?.();
    screen.leave();
    resolveRun(code);
  }

  function currentItem(): ReaderCatalogueWorkstream | undefined {
    if (mode.kind !== "dashboard") return undefined;
    const scoped = mode.workstreamId;
    return model.catalogue?.workstreams.items.find(
      (item) => item.record.workstream_id === scoped,
    );
  }

  function galloping(): boolean {
    if (
      closed ||
      startup !== undefined ||
      helpOpen ||
      lifecycle !== undefined ||
      mode.kind !== "dashboard" ||
      model.health?.presence !== "present"
    ) {
      return false;
    }
    const item = currentItem();
    const card = cardTier();
    return (
      item !== undefined &&
      item.active_state_counts.working > 0 &&
      motionAllowed &&
      !motionPaused &&
      (card?.tier === "comfort" || card?.tier === "sub")
    );
  }

  function cardTier(): CardGeometry | undefined {
    const width = options.output.columns ?? 80;
    const height = options.output.rows ?? 24;
    return chooseCard(width, height);
  }

  function framedLifecycleTier(): boolean {
    const card = cardTier();
    return card?.tier === "comfort" || card?.tier === "sub";
  }

  function lifecycleMotionMode(): "live" | "paused" | "off" {
    if (!motionAllowed) return "off";
    return motionPaused ? "paused" : "live";
  }

  function lifecycleDecisionBlinking(): boolean {
    return (
      !closed &&
      !helpOpen &&
      lifecycle?.kind === "confirm" &&
      lifecycleMotionMode() === "live" &&
      framedLifecycleTier()
    );
  }

  function lifecycleFilmVisible(): boolean {
    return (
      !closed &&
      lifecycleFilm !== undefined &&
      lifecycleMotionMode() === "live" &&
      framedLifecycleTier()
    );
  }

  /** A hidden or paused ceremony must never retain an invisible clock. */
  function retireHiddenLifecycleFilm(): void {
    if (
      lifecycleFilm !== undefined &&
      (lifecycleMotionMode() !== "live" || !framedLifecycleTier())
    ) {
      lifecycleFilm = undefined;
    }
  }

  function wantedMotionScene(): MotionScene | undefined {
    if (lifecycleFilmVisible()) return "lifecycle-film";
    if (lifecycleDecisionBlinking()) return "lifecycle-decision";
    return galloping() ? "dashboard" : undefined;
  }

  /** One timer serves only the currently visible live scene. */
  function syncMotionTimer(): void {
    retireHiddenLifecycleFilm();
    const wanted = wantedMotionScene();
    if (motionTimer !== undefined && wanted !== motionScene) stopMotion();
    if (wanted !== undefined && motionTimer === undefined) {
      motionScene = wanted;
      motionTimer = armInterval(() => {
        if (lifecycleFilm !== undefined) {
          lifecycleFilm.ticksElapsed += 1;
          const progress = lifecycleTraversalProgressAtTick(
            lifecycleFilm.ticksElapsed,
          );
          const decision = lifecycleTraversalGate(
            progress,
            lifecycleFilm.settlement?.kind,
          );
          if (decision === "finish") {
            completeLifecycleFilm();
            return;
          }
          if (decision === "interrupt") {
            lifecycleFilm = undefined;
            syncMotionTimer();
          }
        } else if (lifecycle?.kind === "confirm") {
          lifecycleDecisionTick += 1;
        } else {
          motionTick = (motionTick + 1) % HORSE_FRAME_COUNT;
          workingPulseTick =
            (workingPulseTick + 1) % WORKING_DOT_CYCLE_TICKS;
        }
        render();
      }, motionIntervalMs);
    } else if (wanted === undefined && motionTimer !== undefined) {
      stopMotion();
    }
  }

  function stopMotion(): void {
    if (motionTimer === undefined) {
      motionScene = undefined;
      return;
    }
    disarmInterval(motionTimer);
    motionTimer = undefined;
    motionScene = undefined;
  }

  function startStartup(): void {
    if (!motionAllowed || startup === undefined || startupTimer !== undefined) {
      return;
    }
    startupTimer = armInterval(() => {
      const current = startup;
      if (current === undefined || closed) return;
      current.ticksElapsed += 1;
      current.minimumMet = startupStrideComplete(current.ticksElapsed);
      if (!maybeFinishStartup()) render();
    }, motionIntervalMs);
  }

  function stopStartup(): void {
    if (startupTimer === undefined) return;
    disarmInterval(startupTimer);
    startupTimer = undefined;
  }

  /** Handoff is the conjunction: one stride and the complete first read. */
  function maybeFinishStartup(): boolean {
    if (
      startup === undefined ||
      !startup.readSettled ||
      !startup.minimumMet ||
      closed
    ) {
      return false;
    }
    stopStartup();
    startup = undefined;
    armRefreshTimer();
    syncMotionTimer();
    render();
    return true;
  }

  function armRefreshTimer(): void {
    if (closed || refreshTimer !== undefined) return;
    refreshTimer = armInterval(() => {
      void refresh();
    }, options.intervalMs ?? COMFORT_REFRESH_INTERVAL_MS);
  }

  async function refresh(initial = false): Promise<void> {
    if (lifecycleReadLock) {
      readQueued = true;
      return;
    }
    if (readInFlight) {
      readQueued = true;
      return;
    }
    const refreshGeneration = readGeneration;
    readInFlight = true;
    let projectedBytes = 0;
    let shownTurns = 0;
    let scopeWorkstreamId: string | undefined;
    let storeAbsent = false;
    let nextReadFailure: string | undefined;
    let nextSnapshot:
      | {
          readonly health: ReaderStoreHealth;
          readonly catalogue?: ReaderCatalogueV1;
          readonly turns: readonly DashboardTurnFact[];
        }
      | undefined;
    const refreshMode = mode;
    try {
      const now = clock();
      const health = await readers.readHealth(projectRoot, {
        byteBudget,
        now,
      });
      if (closed) return;
      projectedBytes += health.utf8_bytes;
      storeAbsent = health.value.presence === "absent";
      if (initial && startup !== undefined) {
        startup.projectedBytes = projectedBytes;
        startup.storeAbsent = storeAbsent;
        startup.phase = storeAbsent ? "ready" : "catalogue";
        render();
      }
      if (health.value.presence === "present") {
        const catalogue = await readers.readCatalogue(projectRoot, {
          byteBudget,
          now,
          turnsPerSession,
        });
        if (closed) return;
        projectedBytes += catalogue.utf8_bytes;
        shownTurns = catalogue.value.workstreams.items.reduce(
          (total, item) => total + item.activity.turns.shown,
          0,
        );
        if (initial && startup !== undefined) {
          startup.projectedBytes = projectedBytes;
          startup.shownTurns = shownTurns;
          startup.phase =
            refreshMode.kind === "dashboard" ? "workstream" : "ready";
          render();
        }
        let turns: readonly DashboardTurnFact[] = [];
        if (refreshMode.kind === "dashboard") {
          scopeWorkstreamId = refreshMode.workstreamId;
          const context = await readers.readContext(projectRoot, {
            byteBudget,
            turnsPerSession,
            workstreamId: refreshMode.workstreamId,
          });
          if (closed) return;
          projectedBytes += context.utf8_bytes;
          shownTurns = context.value.turns.shown;
          turns = context.value.turns.items.map(dashboardTurnFact);
          if (initial && startup !== undefined) {
            startup.projectedBytes = projectedBytes;
            startup.shownTurns = shownTurns;
            startup.phase = "ready";
            render();
          }
        }
        nextSnapshot = {
          health: health.value,
          catalogue: catalogue.value,
          turns,
        };
      } else {
        nextSnapshot = { health: health.value, turns: [] };
      }
    } catch (error: unknown) {
      if (closed) return;
      // Commit this only after the generation guard; an invalidated refresh
      // must not leak a stale failure across lifecycle reconciliation.
      nextReadFailure =
        error instanceof Error ? error.message : "the store could not be read";
      if (initial && startup !== undefined) startup.phase = "failed";
    } finally {
      readInFlight = false;
    }
    if (closed) return;
    if (refreshGeneration !== readGeneration) {
      if (readQueued && !lifecycleReadLock) {
        readQueued = false;
        void refresh();
      }
      return;
    }
    const refreshCompletedAtMs = monotonicNow();
    if (nextSnapshot === undefined) {
      if (nextReadFailure !== undefined) model.readFailure = nextReadFailure;
      model.refreshFailed = true;
    } else {
      model.health = nextSnapshot.health;
      if (nextSnapshot.catalogue === undefined) {
        delete model.catalogue;
      } else {
        model.catalogue = nextSnapshot.catalogue;
      }
      model.turns = nextSnapshot.turns;
      if (refreshMode.kind === "home") {
        if (nextSnapshot.catalogue === undefined) {
          homeNewsTickerOrder = [];
          homeNewsTickerKey = undefined;
        } else {
          syncHomeNewsTicker(
            nextSnapshot.catalogue,
            !initial && motionAllowed && homeFilter === "open",
          );
        }
      }
      delete model.readFailure;
      model.refresh = {
        completedAtMs: refreshCompletedAtMs,
        projectedBytes,
        shownTurns,
        ...(scopeWorkstreamId === undefined ? {} : { scopeWorkstreamId }),
      };
      model.refreshFailed = false;
    }
    if (initial && startup !== undefined) {
      startup.projectedBytes = projectedBytes;
      startup.shownTurns = shownTurns;
      startup.storeAbsent = storeAbsent;
      startup.readDurationMs = Math.max(
        0,
        refreshCompletedAtMs - startup.startedAtMs,
      );
      startup.readSettled = true;
      if (startup.phase !== "failed") startup.phase = "ready";
      if (maybeFinishStartup()) return;
    }
    syncMotionTimer();
    render();
    if (readQueued && !closed) {
      readQueued = false;
      void refresh();
    }
  }

  function handleCommand(
    command: string,
    backPressedDuringFilm?: LifecycleFilmState,
  ): void {
    if (
      command === "back" &&
      backPressedDuringFilm !== undefined &&
      lifecycleFilm !== backPressedDuringFilm
    ) {
      // A lone Escape is delivered after a 40 ms grace period. Never let an
      // Escape pressed during one film dismiss the result that replaces it.
      return;
    }
    if (startup !== undefined && command !== "quit") return;
    if (helpOpen) {
      if (command === "quit") finish(0);
      else if (command === "back") {
        helpOpen = false;
        syncMotionTimer();
        render();
      }
      return;
    }
    if (lifecycle !== undefined && handleLifecycleCommand(command)) return;
    if (create !== undefined && handleCreateCommand(command)) {
      render();
      return;
    }
    switch (command) {
      case "quit":
        finish(0);
        return;
      case "refresh":
        void refresh();
        return;
      case "help":
        helpOpen = true;
        break;
      case "back":
        if (mode.kind === "dashboard") {
          mode = { kind: "home" };
        }
        break;
      case "move-down":
        if (mode.kind === "dashboard") rollSelectionIndex += 1;
        else moveHomeSelection(1);
        break;
      case "move-up":
        if (mode.kind === "dashboard") {
          rollSelectionIndex = Math.max(0, rollSelectionIndex - 1);
        } else {
          moveHomeSelection(-1);
        }
        break;
      case "create":
        if (mode.kind === "home") {
          create = { kind: "form", name: "", title: "", focus: "name" };
          parser.setEditorMode(true);
          syncMotionTimer();
        }
        break;
      case "filter":
        if (mode.kind === "home") {
          homeFilter = homeFilter === "open" ? "completed" : "open";
          selectedHomeWorkstream();
          if (model.catalogue !== undefined) {
            syncHomeNewsTicker(model.catalogue, false);
          }
        }
        break;
      case "lifecycle":
        beginSelectedLifecycle();
        break;
      case "open":
        if (mode.kind === "home") {
          const target = selectedHomeWorkstream();
          if (target !== undefined) {
            mode = { kind: "dashboard", workstreamId: target };
            rollSelectionIndex = 0;
            void refresh();
            return;
          }
        }
        break;
      case "toggle-motion":
        // Under --no-motion Space reports nothing and changes no state.
        if (!motionAllowed) return;
        motionPaused = !motionPaused;
        break;
      default:
        return;
    }
    syncMotionTimer();
    render();
  }

  function selectableWorkstreams(): readonly string[] {
    const catalogue = model.catalogue;
    if (catalogue === undefined) return [];
    return hubSelectableWorkstreamIds(catalogue, homeFilter);
  }

  function selectedHomeWorkstream(): string | undefined {
    const selectable = selectableWorkstreams();
    const selection = homeSelections[homeFilter];
    if (selectable.length === 0) {
      selection.index = 0;
      delete selection.workstreamId;
      return undefined;
    }
    if (selection.workstreamId !== undefined) {
      const retainedIndex = selectable.indexOf(selection.workstreamId);
      if (retainedIndex !== -1) {
        selection.index = retainedIndex;
        return selection.workstreamId;
      }
    }
    selection.index = Math.min(selection.index, selectable.length - 1);
    selection.workstreamId = selectable[selection.index]!;
    return selection.workstreamId;
  }

  function moveHomeSelection(delta: -1 | 1): void {
    const selectable = selectableWorkstreams();
    const selection = homeSelections[homeFilter];
    if (selectable.length === 0) {
      selection.index = 0;
      delete selection.workstreamId;
      return;
    }
    selectedHomeWorkstream();
    selection.index = Math.max(
      0,
      Math.min(selectable.length - 1, selection.index + delta),
    );
    selection.workstreamId = selectable[selection.index]!;
  }

  function beginSelectedLifecycle(): void {
    const card = cardTier();
    if (
      card === undefined ||
      (card.tier !== "comfort" && card.tier !== "sub")
    ) {
      return;
    }
    const catalogue = model.catalogue;
    const item =
      mode.kind === "dashboard"
        ? currentItem()
        : catalogue?.workstreams.items.find(
            (candidate) =>
              candidate.record.workstream_id === selectedHomeWorkstream(),
          );
    if (item === undefined || catalogue === undefined) return;
    lifecycleOrigin = { mode, filter: homeFilter };
    lifecycle = beginLifecycleState(item, catalogue.reference_at);
    lifecycleDecisionTick = 0;
    lifecycleFilm = undefined;
    syncMotionTimer();
  }

  /** Returns true whenever the lifecycle overlay owns the command. */
  function handleLifecycleCommand(command: string): boolean {
    const state = lifecycle!;
    if (lifecycleFilm !== undefined) {
      if (command === "quit") {
        finish(0);
      } else if (
        command === "back" &&
        state.kind === "pending" &&
        lifecycleFilm.phase === "writer" &&
        pendingLifecycleWriter !== undefined &&
        !state.cancelRequested
      ) {
        const writer = pendingLifecycleWriter;
        pendingLifecycleWriter = undefined;
        writer.cancel();
        lifecycle = { ...state, cancelRequested: true };
        render();
      }
      // Reconcile and a confirmed finishing pass are intentionally
      // uninterruptible; no key may turn ceremony into a false outcome.
      return true;
    }
    switch (command) {
      case "quit":
        finish(0);
        return true;
      case "back":
        if (state.kind === "confirm") {
          restoreLifecycleOrigin();
        } else if (state.kind === "pending") {
          if (!state.cancelRequested && pendingLifecycleWriter !== undefined) {
            const writer = pendingLifecycleWriter;
            pendingLifecycleWriter = undefined;
            writer.cancel();
            lifecycle = { ...state, cancelRequested: true };
            render();
          }
        } else {
          closeLifecycleResult(lifecycleOrigin?.filter ?? "open");
        }
        return true;
      case "open":
        if (state.kind === "confirm" && cardTier() !== undefined) {
          startLifecycleWriter(state);
        }
        return true;
      case "filter":
        if (state.kind !== "confirm" && state.kind !== "pending") {
          closeLifecycleResult(
            state.kind === "confirmed" ? state.record.status : state.target.status,
          );
        }
        return true;
      case "refresh":
        if (state.kind !== "pending") void refresh();
        return true;
      case "help":
        if (state.kind !== "pending") {
          helpOpen = true;
          syncMotionTimer();
          render();
        }
        return true;
      default:
        return true;
    }
  }

  function restoreLifecycleOrigin(): void {
    const origin = lifecycleOrigin;
    lifecycle = undefined;
    lifecycleFilm = undefined;
    lifecycleOrigin = undefined;
    if (origin !== undefined) {
      mode = origin.mode;
      homeFilter = origin.filter;
    }
    syncMotionTimer();
    render();
  }

  function closeLifecycleResult(destination: "open" | "completed"): void {
    const state = lifecycle;
    const origin = lifecycleOrigin;
    lifecycle = undefined;
    lifecycleFilm = undefined;
    lifecycleOrigin = undefined;
    if (state?.kind === "confirmed") {
      mode = { kind: "home" };
      homeFilter = destination;
      homeSelections[destination].workstreamId = state.record.workstream_id;
      selectedHomeWorkstream();
    } else if (origin !== undefined) {
      mode = origin.mode;
      homeFilter = origin.filter;
    }
    syncMotionTimer();
    render();
  }

  function startLifecycleWriter(
    state: Extract<LifecycleState, { readonly kind: "confirm" }>,
  ): void {
    if (
      lifecycleMotionMode() === "live" &&
      framedLifecycleTier()
    ) {
      lifecycleFilm = {
        ticksElapsed: 0,
        phase: "writer",
        bench: lifecycleConfirmationBench(state),
      };
    } else {
      lifecycleFilm = undefined;
    }
    lifecycle = {
      kind: "pending",
      action: state.action,
      target: state.target,
      cancelRequested: false,
    };
    lifecycleReadLock = true;
    readGeneration += 1;
    // Frame zero is painted before the process seam is invoked. The writer is
    // still started in the same input turn, while the scene receives a full
    // first 100 ms beat even when the returned Promise is already resolved.
    syncMotionTimer();
    render();
    const spawn =
      options.workstreamWriter ??
      options.createWriter ??
      ((argv: readonly string[]) => defaultWriter(argv));
    let writer: ReturnType<typeof spawn>;
    try {
      writer = spawn(lifecycleArgv(state.action, state.target, projectRoot));
    } catch (error: unknown) {
      void finishLifecycleWriter(state.action, state.target, {
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : "writer unavailable",
        cancelled: false,
      });
      return;
    }
    pendingLifecycleWriter = writer;
    void writer.settled.then(
      (outcome) =>
        finishLifecycleWriter(state.action, state.target, {
          code: outcome.code,
          stdout: outcome.stdout,
          stderr: outcome.stderr ?? "",
          cancelled: outcome.cancelled,
        }),
      (error: unknown) =>
        finishLifecycleWriter(state.action, state.target, {
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : "writer unavailable",
          cancelled: false,
        }),
    );
  }

  async function finishLifecycleWriter(
    action: LifecycleAction,
    target: Extract<LifecycleState, { readonly kind: "pending" }>["target"],
    outcome: LifecycleWriterOutcome,
  ): Promise<void> {
    pendingLifecycleWriter = undefined;
    if (closed) return;
    if (lifecycleFilm !== undefined) {
      lifecycleFilm.phase = "reconcile";
      render();
    }
    let lookup: LifecycleLookup = "unknown";
    try {
      lookup = await reconcileLifecycleLookup(target.workstreamId);
    } finally {
      lifecycleReadLock = false;
    }
    if (closed) return;
    const settled = settleLifecycle({ action, target, outcome, lookup });
    lifecycle = settled;
    if (lifecycleFilm !== undefined) {
      lifecycleFilm.settlement = settled;
      if (settled.kind === "confirmed") {
        lifecycleFilm.phase = "finishing";
        const decision = lifecycleTraversalGate(
          lifecycleTraversalProgressAtTick(lifecycleFilm.ticksElapsed),
          settled.kind,
        );
        if (decision === "finish") {
          completeLifecycleFilm();
        } else {
          syncMotionTimer();
          render();
        }
      } else {
        // Failure, cancellation, and unknown settlement interrupt the run.
        lifecycleFilm = undefined;
        syncMotionTimer();
        render();
      }
    } else {
      syncMotionTimer();
      render();
    }
    if (readQueued) {
      readQueued = false;
      void refresh();
    }
  }

  /** Finish a proven pass; warnings deliberately retain the result card. */
  function completeLifecycleFilm(): void {
    const settled = lifecycleFilm?.settlement;
    lifecycleFilm = undefined;
    if (settled?.kind === "confirmed" && settled.warning === undefined) {
      // The approved ceremony returns to the main Open roster for either
      // lifecycle direction; reopen can retain the just-reopened selection.
      closeLifecycleResult("open");
      return;
    }
    syncMotionTimer();
    render();
  }

  async function reconcileLifecycleLookup(
    workstreamId: string,
  ): Promise<LifecycleLookup> {
    try {
      const catalogue = await readers.readCatalogue(projectRoot, {
        byteBudget,
        now: clock(),
        turnsPerSession,
      });
      model.catalogue = catalogue.value;
      const match = catalogue.value.workstreams.items.find(
        (item) => item.record.workstream_id === workstreamId,
      );
      if (match !== undefined) return lifecycleRecord(match);

      if (catalogue.value.workstreams.hidden > 0) {
        const scoped = await readers.readCatalogue(projectRoot, {
          byteBudget,
          now: clock(),
          turnsPerSession,
          workstreamId,
        });
        const scopedMatch = scoped.value.workstreams.items.find(
          (item) => item.record.workstream_id === workstreamId,
        );
        if (scopedMatch !== undefined) return lifecycleRecord(scopedMatch);
        return catalogueCountsAreExact(scoped.value) ? "absent" : "unknown";
      }
      return catalogueCountsAreExact(catalogue.value) ? "absent" : "unknown";
    } catch {
      return "unknown";
    }
  }

  function lifecycleRecord(item: ReaderCatalogueWorkstream) {
    return {
      workstream_id: item.record.workstream_id,
      name: item.record.name,
      ...(item.record.title === undefined ? {} : { title: item.record.title }),
      status: item.record.status,
      revision: item.record.revision,
    };
  }

  function catalogueCountsAreExact(catalogue: ReaderCatalogueV1): boolean {
    return (
      catalogue.workstream_status_counts.read_state === "ok" &&
      catalogue.workstream_status_counts.coverage.state === "complete" &&
      catalogue.workstreams.hidden === 0
    );
  }

  /** Returns true when the command was consumed by the create flow. */
  function handleCreateCommand(command: string): boolean {
    const state = create!;
    switch (command) {
      case "quit":
        finish(0);
        return true;
      case "back":
        if (state.kind === "pending") {
          pendingWriter?.cancel();
          create = { ...state, cancelRequested: true };
          return true;
        }
        closeCreate();
        return true;
      case "submit": {
        if (state.kind !== "form") return true;
        const validation = validateCreateForm(state.name, state.title.trim());
        if (!validation.ok) return true;
        startWriter(state.name, state.title);
        return true;
      }
      case "erase": {
        if (state.kind !== "form") return true;
        const value = state.focus === "name" ? state.name : state.title;
        const shorter = [...value].slice(0, -1).join("");
        create =
          state.focus === "name"
            ? { ...state, name: shorter }
            : { ...state, title: shorter };
        return true;
      }
      case "detail-next":
      case "detail-previous":
        if (state.kind === "form") {
          create = {
            ...state,
            focus: state.focus === "name" ? "title" : "name",
          };
        }
        return true;
      case "move-down":
      case "move-up":
        if (state.kind === "created") {
          createdCommandIndex = createdCommandIndex === 0 ? 1 : 0;
        }
        return true;
      case "copy":
        if (state.kind === "created") void punchSelected();
        return true;
      case "refresh":
        void refresh();
        return true;
      case "help":
        helpOpen = true;
        return true;
      default:
        return true;
    }
  }

  function closeCreate(): void {
    create = undefined;
    punchResult = undefined;
    createdCommandIndex = 0;
    parser.setEditorMode(false);
    syncMotionTimer();
  }

  function editorText(text: string): void {
    if (create?.kind !== "form") return;
    const clean = fieldText(text);
    if (clean.length === 0) return;
    create =
      create.focus === "name"
        ? { ...create, name: `${create.name}${clean}` }
        : { ...create, title: `${create.title}${clean}` };
    render();
  }

  function startWriter(name: string, title: string): void {
    parser.setEditorMode(false);
    create = { kind: "pending", name, title, cancelRequested: false };
    const spawn =
      options.createWriter ??
      ((argv: readonly string[]) => defaultWriter(argv));
    const writer = spawn(writerArgv(name, title, projectRoot));
    pendingWriter = writer;
    void writer.settled.then(async (outcome) => {
      pendingWriter = undefined;
      const lookup = await reconcileLookup(name);
      create = settleCreate({ expectedName: name, outcome, lookup });
      createdCommandIndex = 0;
      punchResult = undefined;
      render();
    });
    render();
  }

  async function reconcileLookup(
    name: string,
  ): Promise<
    | { workstream_id: string; name: string; title?: string; status: "open" | "completed" }
    | "absent"
    | "unknown"
  > {
    try {
      const catalogue = await readers.readCatalogue(projectRoot, {
        byteBudget,
        now: clock(),
        turnsPerSession,
      });
      model.catalogue = catalogue.value;
      const match = catalogue.value.workstreams.items.find(
        (item) => item.record.name === name,
      );
      if (match !== undefined) {
        return {
          workstream_id: match.record.workstream_id,
          name: match.record.name,
          ...(match.record.title === undefined
            ? {}
            : { title: match.record.title }),
          status: match.record.status,
        };
      }
      return catalogue.value.coverage.state === "complete" &&
        catalogue.value.workstreams.hidden === 0
        ? "absent"
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  async function punchSelected(): Promise<void> {
    if (create?.kind !== "created" || punchPending) return;
    const value = joinCommands(create.record.name)[createdCommandIndex]!.text;
    punchPending = true;
    try {
      const outcome = await punchOut(value, {
        oscWrite: (sequence) => options.output.write(sequence),
        runHelper: options.punchHelper ?? pbcopyHelper(),
      });
      // The result binds to the value that was punched, never a later
      // selection.
      punchResult = outcome;
    } finally {
      punchPending = false;
    }
    render();
  }

  function joinCommands(name: string) {
    return [
      {
        heading: "Join from Claude Code",
        label: "Claude Code join command",
        text: `/barbaro join ${name}`,
      },
      {
        heading: "Join from Codex",
        label: "Codex join command",
        text: `$barbaro join ${name}`,
      },
    ] as const;
  }

  function defaultWriter(argv: readonly string[]): {
    readonly settled: Promise<WriterOutcome>;
    cancel(): void;
  } {
    let cancelled = false;
    let resolved = false;
    let child: import("node:child_process").ChildProcess | undefined;
    const settled = new Promise<WriterOutcome>((resolveOutcome) => {
      const settle = (outcome: WriterOutcome): void => {
        if (resolved) return;
        resolved = true;
        resolveOutcome(outcome);
      };
      void import("node:child_process").then(
        ({ execFile }) => {
          if (cancelled) {
            settle({ code: null, stdout: "", stderr: "", cancelled: true });
            return;
          }
          const entry = process.argv[1];
          if (entry === undefined) {
            settle({ code: null, stdout: "", stderr: "", cancelled });
            return;
          }
          child = execFile(
            process.execPath,
            [entry, ...argv],
            { timeout: 30_000 },
            (error, stdout, stderr) => {
              settle({
                code:
                  error === null
                    ? 0
                    : typeof (error as { code?: unknown }).code === "number"
                      ? ((error as { code?: number }).code ?? 1)
                      : null,
                stdout,
                stderr,
                cancelled,
              });
            },
          );
        },
        (error: unknown) => {
          settle({
            code: null,
            stdout: "",
            stderr:
              error instanceof Error ? error.message : "writer unavailable",
            cancelled,
          });
        },
      );
    });
    return {
      settled,
      cancel: () => {
        cancelled = true;
        child?.kill("SIGTERM");
      },
    };
  }

  function motionPolicy(): MotionPolicy {
    if (!motionAllowed) return { kind: "off" };
    const workingDots = workingDotsAtTick(workingPulseTick);
    return motionPaused
      ? { kind: "paused", frameIndex: motionTick, workingDots }
      : { kind: "live", frameIndex: motionTick, workingDots };
  }

  function render(): void {
    if (closed) return;
    const width = options.output.columns ?? 80;
    const height = options.output.rows ?? 24;
    const card = chooseCard(width, height);
    if (card === undefined) {
      screen.draw(
        trueSizeNotice(width, height, narrowKeyLine()).join("\r\n"),
      );
      return;
    }
    if (startup !== undefined) {
      const lines =
        motionAllowed && (card.tier === "comfort" || card.tier === "sub")
          ? renderBootSplash(bootView(card), card)
          : bootWordPage(card);
      screen.draw(composeMatte(lines, card, width, height).join("\r\n"));
      return;
    }
    if (card.tier === "text" || card.tier === "floor") {
      const page =
        lifecycle === undefined ? wordPage(card) : lifecycleWordPage(card);
      screen.draw(composeMatte(page, card, width, height).join("\r\n"));
      return;
    }
    const view = currentView(card);
    const lines =
      card.tier === "comfort" ? renderComfortCard(view) : renderSubCard(view);
    const composed = composeMatte(lines, card, width, height);
    let painted: readonly string[] = composed;
    if (colorAllowed) {
      const matteTop = matteOffsets(width, height, card).top;
      if (view.frame.kind === "hub") {
        painted = accentSelectedHubRow(lines, composed, matteTop);
      } else if (
        view.frame.kind === "idle" ||
        view.frame.kind === "working"
      ) {
        painted = styleDashboardProvenanceRows(
          lines,
          composed,
          matteTop,
          view.frame,
        );
      }
    }
    screen.draw(painted.join("\r\n"));
  }

  function currentView(card: CardGeometry): CardView {
    if (helpOpen) return helpView();
    if (lifecycleFilm !== undefined) return lifecycleTraversalCardView();
    if (lifecycle !== undefined) return lifecycleView();
    if (create !== undefined) return createView();
    if (model.health !== undefined && model.health.presence === "absent") {
      return absentView();
    }
    if (model.catalogue === undefined) {
      return loadingView();
    }
    if (mode.kind === "home") return homeView();
    return dashboardView(card);
  }

  function homeView(): CardView {
    const catalogue = model.catalogue!;
    syncHomeNewsTicker(catalogue, false);
    const selected = selectedHomeWorkstream();
    const reduced = reduceHub(
      catalogue,
      selected,
      homeNewsTickerSelection(),
      homeFilter,
    );
    const item = catalogue.workstreams.items.find(
      (candidate) => candidate.record.workstream_id === selected,
    );
    const toggle = homeFilter === "open" ? "/ completed" : "/ open";
    const lifecycleAction =
      homeFilter === "open" ? "x complete" : "x reopen";
    return {
      location: `Home · ${homeFilter === "open" ? "Open" : "Completed"}`,
      truth: withFailure(reduced.truth),
      frame: {
        ...reduced.frame,
        title: `${reduced.frame.title} · / ${
          homeFilter === "open" ? "completed" : "open"
        }`,
      },
      bench: hubBench(item, catalogue, homeFilter),
      keyLine:
        item === undefined
          ? `${toggle} · n new · r refresh · ? help · q quit`
          : `j/k · Enter · ${toggle} · ${lifecycleAction} · n new · r refresh · ? help · q quit`,
    };
  }

  function syncHomeNewsTicker(
    catalogue: ReaderCatalogueV1,
    advance: boolean,
  ): void {
    const available = [...hubNewsTickerKeys(catalogue)];
    if (available.length === 0) {
      homeNewsTickerOrder = [];
      homeNewsTickerKey = undefined;
      return;
    }
    if (!motionAllowed) {
      homeNewsTickerOrder = available;
      homeNewsTickerKey = available[0];
      return;
    }
    if (homeNewsTickerKey === undefined) {
      homeNewsTickerOrder = available;
      homeNewsTickerKey = available[0];
      return;
    }

    if (!available.includes(homeNewsTickerKey)) {
      const missingIndex = homeNewsTickerOrder.indexOf(homeNewsTickerKey);
      if (missingIndex !== -1) {
        const availableSet = new Set(available);
        const retained = [
          ...homeNewsTickerOrder.slice(missingIndex + 1),
          ...homeNewsTickerOrder.slice(0, missingIndex),
        ].filter((key) => availableSet.has(key));
        for (const key of available) {
          if (!retained.includes(key)) retained.push(key);
        }
        if (retained.length > 0) {
          homeNewsTickerOrder = retained;
          homeNewsTickerKey = retained[0];
          return;
        }
      }
      homeNewsTickerOrder = available;
      homeNewsTickerKey = available[0];
      return;
    }

    const availableSet = new Set(available);
    const nextOrder = homeNewsTickerOrder.filter((key) =>
      availableSet.has(key),
    );
    for (const key of available) {
      if (!nextOrder.includes(key)) nextOrder.push(key);
    }
    homeNewsTickerOrder = nextOrder;
    if (!advance) return;

    const currentIndex = homeNewsTickerOrder.indexOf(homeNewsTickerKey);
    if (currentIndex + 1 < homeNewsTickerOrder.length) {
      homeNewsTickerKey = homeNewsTickerOrder[currentIndex + 1];
      return;
    }
    const previousIndex = available.indexOf(homeNewsTickerKey);
    const nextIndex =
      available.length === 1 ? 0 : (previousIndex + 1) % available.length;
    homeNewsTickerOrder = [
      ...available.slice(nextIndex),
      ...available.slice(0, nextIndex),
    ];
    homeNewsTickerKey = homeNewsTickerOrder[0];
  }

  function homeNewsTickerSelection(): HubNewsTickerSelection | undefined {
    if (homeFilter !== "open") return undefined;
    if (homeNewsTickerKey === undefined) return undefined;
    const position = homeNewsTickerOrder.indexOf(homeNewsTickerKey);
    return position === -1
      ? undefined
      : { key: homeNewsTickerKey, position };
  }

  function boundedRollSelection(item: ReaderCatalogueWorkstream): number {
    const count = item.rolls.items.length;
    if (count === 0) {
      rollSelectionIndex = 0;
      return 0;
    }
    if (rollSelectionIndex >= count) rollSelectionIndex = count - 1;
    return rollSelectionIndex;
  }

  function hubBench(
    item: ReaderCatalogueWorkstream | undefined,
    catalogue: ReaderCatalogueV1,
    filter: HubFilter,
  ): string[] {
    const root = projectRoot;
    const projectLine = `Project · ${basename(root)} · root ${root}`;
    const warning = hubProjectionWarning(catalogue, filter);
    if (item === undefined) {
      return [...(warning === undefined ? [] : [warning]), projectLine];
    }
    const lines: string[] = [
      `${item.record.name} · ${item.record.status} · ${item.rolls.total} sessions`,
    ];
    if (warning !== undefined) lines.push(warning);
    if (item.record.title !== undefined) lines.push(item.record.title);
    const state =
      item.active_state_counts.working > 0 ? "Working now" : "No shown work";
    const latest = item.activity.last_known_activity_at;
    lines.push(
      latest === undefined
        ? state
        : `${state} · latest shown exposure ${relativeAgo(
            latest,
            catalogue.reference_at,
          )}`,
    );
    lines.push(`ID · ${item.record.workstream_id}`);
    lines.push(
      item.record.status === "open"
        ? `/barbaro join ${item.record.name}`
        : "Completed · x reopens after confirmation",
    );
    lines.push(projectLine);
    return lines;
  }

  function dashboardView(card: CardGeometry): CardView {
    const item = currentItem();
    const catalogue = model.catalogue!;
    if (item === undefined) {
      return {
        location: "Barbaro",
        truth: withFailure("No workstream is selected"),
        frame: {
          kind: "intertitle",
          title: "Motion study",
          lines: ["No workstream is selected"],
        },
        bench: [],
        keyLine: "Esc home · q quit",
      };
    }
    const selectedRollIndex = boundedRollSelection(item);
    const turns =
      model.refresh?.scopeWorkstreamId === item.record.workstream_id
        ? model.turns
        : [];
    const reduced = reduceDashboard(
      item,
      turns,
      motionPolicy(),
      selectedRollIndex,
    );
    const measured = withRefreshTelemetry(reduced.frame, card);
    const trimmed = trimFrameForCard(measured, card);
    return {
      location:
        item.record.status === "open"
          ? item.record.name
          : `${item.record.name} · completed`,
      truth: withFailure(reduced.truth),
      frame: trimmed,
      bench: dashboardBench(
        item,
        catalogue,
        trimmed,
        selectedRollIndex,
      ),
      keyLine: dashboardKeyLine(trimmed, card, item.record.status),
    };
  }

  function withRefreshTelemetry(
    frame: FrameView,
    card: CardGeometry,
  ): FrameView {
    if (
      card.tier !== "comfort" ||
      frame.kind !== "working" ||
      frame.horse.kind !== "gallop"
    ) {
      return frame;
    }
    return { ...frame, telemetry: refreshTelemetry() };
  }

  function refreshTelemetry(): string {
    const measurement = model.refresh;
    const matchesScope =
      mode.kind === "dashboard" &&
      measurement?.scopeWorkstreamId === mode.workstreamId;
    if (model.refreshFailed === true) {
      return matchesScope
        ? "Refresh failed · showing previous data"
        : "Refresh failed";
    }
    if (!matchesScope || measurement === undefined) return "Refresh pending";
    const age = (
      Math.max(0, monotonicNow() - measurement.completedAtMs) / 1_000
    ).toFixed(1);
    const projected = formatProjectedBytes(measurement.projectedBytes);
    const preferred = `Refresh age ${age}s · ${measurement.shownTurns} shown turns · ${projected} projected`;
    return measureCells(preferred) <= 62
      ? preferred
      : `Refresh age ${age}s · ${projected} projected`;
  }

  function trimFrameForCard(frame: FrameView, card: CardGeometry): FrameView {
    if (frame.kind !== "working") return frame;
    const capacity =
      card.tier === "sub"
        ? 2
        : card.tier !== "comfort"
          ? undefined
          : frame.horse.kind === "intertitle"
            ? 6
            : 5;
    if (capacity === undefined) return frame;
    // Detail is removed by a selected-visible viewport, never by squeezing.
    return { ...frame, rolls: visibleRolls(frame.rolls, capacity) };
  }

  function visibleRolls(
    rolls: readonly RollLineView[],
    capacity: number,
  ): readonly RollLineView[] {
    const count = Math.min(capacity, rolls.length);
    if (count === rolls.length) return rolls;
    const selected = Math.max(
      0,
      rolls.findIndex((roll) => roll.selected),
    );
    const maximumStart = Math.max(0, rolls.length - count);
    const start = Math.min(Math.max(0, selected - count + 1), maximumStart);
    return rolls.slice(start, start + count);
  }

  function dashboardBench(
    item: ReaderCatalogueWorkstream,
    catalogue: ReaderCatalogueV1,
    frame: FrameView,
    selectedRollIndex: number,
  ): string[] {
    const roll =
      frame.kind === "working" || frame.kind === "idle"
        ? dashboardRollAt(item, selectedRollIndex)
        : item.rolls.items[0];
    if (roll === undefined) return [];
    const identity = shortSessionId(roll.provider, roll.session_id);
    const lease = roll.leases.items[0];
    const lines = [
      `${identity} · ${lease?.state ?? "no shown lease"}`,
    ];
    if (roll.last_turn !== undefined) {
      lines.push(
        `Latest shown exposure · #${roll.last_turn.sequence} · ${outcomeWord(
          roll.last_turn.outcome,
        ).toLowerCase()} · ${clockHHMM(roll.last_turn.ended_at)}`,
      );
    }
    const unread = item.unread?.items.find(
      (summary) =>
        summary.key.provider === roll.provider &&
        summary.key.session_id === roll.session_id,
    );
    if (
      unread !== undefined &&
      (unread.status === "unknown" || unread.unread_count > 0)
    ) {
      lines.push(
        unread.status === "ready"
          ? `News ${unread.unread_count} for ${identity}`
          : "Unread state is unknown",
      );
    }
    const publish = item.publish?.items.find(
      (summary) =>
        summary.provider === roll.provider &&
        summary.session_id === roll.session_id,
    );
    lines.push(publishLine(publish?.state));
    void catalogue;
    return lines;
  }

  function publishLine(state: string | undefined): string {
    switch (state) {
      case "clear":
        return "Publication clear";
      case "pending":
        return "Publication pending";
      case "blocked":
        return "Publish blocked";
      default:
        return "Publish state is unknown";
    }
  }

  function dashboardKeyLine(
    frame: FrameView,
    card: CardGeometry,
    status: "open" | "completed",
  ): string {
    const action = status === "open" ? "x complete" : "x reopen";
    if (frame.kind === "idle") {
      return `${action} · Esc home · r refresh · ? help · q quit`;
    }
    if (frame.kind === "working") {
      if (card.tier === "comfort" && motionAllowed) {
        const motionAction = motionPaused ? "Space resume" : "Space pause";
        return `j/k · ${action} · Esc home · ${motionAction} · r refresh · ? help · q quit`;
      }
      return `j/k · ${action} · Esc home · r refresh · ? help · q quit`;
    }
    return `${action} · Esc home · r refresh · ? help · q quit`;
  }

  function lifecycleView(): CardView {
    const state = lifecycle!;
    const actionWord = state.action === "complete" ? "Complete" : "Reopen";
    const projectLines = [
      lifecycleCountsLine(),
      `ID · ${state.target.workstreamId}`,
      `Project · ${basename(projectRoot)} · root ${projectRoot}`,
    ];
    if (state.kind === "confirm") {
      const evidence = state.evidence;
      const waiting = lifecycleDecisionMarkerVisible(
        lifecycleDecisionTick,
        lifecycleMotionMode(),
      )
        ? "● Waiting on you"
        : "  Waiting on you";
      return {
        location: "Confirm",
        truth: "No change has been made.",
        frame: {
          kind: "intertitle",
          title: `${actionWord} ${state.target.name}?`,
          lines: ["Enter · Yes", "Esc · No", "", waiting],
        },
        bench: lifecycleConfirmationBench(state),
        keyLine: "Enter yes · Esc no · q quit",
      };
    }
    if (state.kind === "pending") {
      const verb = state.action === "complete" ? "Completing" : "Reopening";
      return {
        location: "Lifecycle",
        truth: state.cancelRequested
          ? "Cancellation requested · checking the store."
          : `${verb} ${state.target.name}…`,
        frame: {
          kind: "intertitle",
          title: `${actionWord} workstream`,
          lines: [
            `${verb} ${state.target.name}…`,
            "Running the public workstream command.",
            state.cancelRequested
              ? "Cancellation was requested; durable state is not assumed."
              : "Checking the store before reporting.",
          ],
        },
        bench: projectLines,
        keyLine: state.cancelRequested
          ? "Cancellation requested · q quit"
          : "Esc request cancel · q quit",
      };
    }

    const warning = state.warning;
    if (state.kind === "confirmed") {
      const statusWord = state.record.status === "open" ? "open" : "completed";
      const origin = lifecycleOrigin?.filter ?? "open";
      const destination = state.record.status;
      const navigation =
        origin === destination
          ? `Esc ${capitalizedFilter(origin)}`
          : `Esc ${capitalizedFilter(origin)} · / ${destination}`;
      return {
        location: "Lifecycle",
        truth: `${state.record.name} is ${statusWord}.`,
        frame: {
          kind: "intertitle",
          title: state.action === "complete" ? "Completed" : "Reopened",
          lines: [
            `${state.record.name} is ${statusWord}.`,
            "The status was confirmed by a fresh store read.",
            ...(warning === undefined
              ? []
              : [`Warning · ${excerptText(warning, 54)}`]),
          ],
        },
        bench: [
          ...(warning === undefined ? [] : [`Warning · ${warning}`]),
          `Revision · ${state.record.revision}`,
          ...projectLines,
        ],
        keyLine: `${navigation} · ? help · q quit`,
      };
    }

    const wording =
      state.kind === "failed"
        ? [
            `${state.target.name} is still ${state.target.status}.`,
            state.message,
          ]
        : state.kind === "cancelled"
          ? [
              `${state.target.name} is still ${state.target.status}.`,
              "Cancellation and unchanged state were confirmed.",
            ]
          : [
              `The ${state.action} outcome is unknown.`,
              "The store did not prove the requested status.",
            ];
    return {
      location: "Lifecycle",
      truth: wording[0]!,
      frame: {
        kind: "intertitle",
        title:
          state.kind === "failed"
            ? `${actionWord} failed`
            : state.kind === "cancelled"
              ? "Cancelled"
              : "Outcome unknown",
        lines: wording,
      },
      bench: [
        ...(warning === undefined ? [] : [`Warning · ${warning}`]),
        ...projectLines,
      ],
      keyLine: "Esc back · ? help · q quit",
    };
  }

  function lifecycleCountsLine(): string {
    const counts = model.catalogue?.workstream_status_counts;
    if (counts === undefined) return "Workstream counts · unavailable";
    const qualifier =
      counts.read_state === "ok" && counts.coverage.state === "complete"
        ? ""
        : " known";
    return `${counts.open} open${qualifier} · ${counts.completed} completed${qualifier}`;
  }

  function lifecycleConfirmationBench(
    state: LifecycleConfirmState,
  ): readonly string[] {
    const evidence = state.evidence;
    return [
      `${state.target.name} · ${state.target.status} · ${lifecycleJoinedBenchLine(evidence.joined)}`,
      evidence.title ?? "No title has been set.",
      lifecycleEvidenceBenchLine(evidence),
      `ID · ${state.target.workstreamId}`,
      `Revision · ${state.target.revision}`,
      `Project · ${basename(projectRoot)} · root ${projectRoot}`,
    ];
  }

  function capitalizedFilter(filter: HubFilter): "Open" | "Completed" {
    return filter === "open" ? "Open" : "Completed";
  }

  function createView(): CardView {
    const state = create!;
    const projectLines = [
      `Project \u00b7 ${basename(projectRoot)}`,
      `Root \u00b7 ${projectRoot}`,
    ];
    if (state.kind === "form" || state.kind === "pending") {
      const name = state.name;
      const title = state.title;
      const validation = validateCreateForm(name, title.trim());
      const pending = state.kind === "pending";
      return {
        location: "New workstream",
        truth: pending
          ? "Creating\u2026 Esc cancels."
          : validation.ok
            ? "Name and title are ready."
            : validation.status,
        frame: {
          kind: "form",
          title: "Create",
          fields: [
            {
              label: "Name",
              value: name,
              focused: !pending && state.kind === "form" && state.focus === "name",
            },
            {
              label: "Title",
              value: title,
              focused: !pending && state.kind === "form" && state.focus === "title",
            },
          ],
          hints: [
            "Use 1-64 lowercase letters, numbers, or hyphens.",
            "Start and end with a letter or number.",
          ],
          status: pending ? "Creating\u2026" : validation.status,
          showCursor: !pending,
        },
        bench: [
          ...projectLines,
          `Name \u00b7 ${name.length === 0 ? "none" : name}`,
          `Title \u00b7 ${title.trim().length === 0 ? "none" : title.trim()}`,
          "Sessions joined by creation \u00b7 none",
        ],
        keyLine: pending
          ? "Esc cancel \u00b7 q quit"
          : "Tab/Shift-Tab \u00b7 Ctrl-S create \u00b7 Esc cancel",
      };
    }
    if (state.kind === "created") {
      const commands = joinCommands(state.record.name);
      const manual =
        punchResult !== undefined && punchResult.kind !== "reported_success";
      const truth = state.originKnown
        ? `${state.record.name} was created. Creation itself enrolled no sessions.`
        : `${state.record.name} exists. Its origin is unknown.`;
      const bench = createdBench(state.record, commands, projectLines);
      return {
        location: "New workstream",
        truth,
        frame: {
          kind: "created",
          title: state.originKnown ? "Created" : "Record present",
          name: state.record.name,
          ...(state.record.title === undefined
            ? {}
            : { subtitle: state.record.title }),
          idLine: `${shortWorkstreamId(state.record.workstream_id)} \u00b7 ${state.record.status}`,
          commands: commands.map((command, index) => ({
            heading: command.heading,
            text: command.text,
            selected: index === createdCommandIndex,
            manualHighlight: index === createdCommandIndex && manual,
          })),
        },
        bench,
        keyLine:
          punchResult !== undefined && punchResult.kind === "unavailable"
            ? "j/k \u00b7 c retry \u00b7 r refresh \u00b7 Esc home \u00b7 ? help \u00b7 q quit"
            : "j/k \u00b7 c copy \u00b7 r refresh \u00b7 Esc home \u00b7 ? help \u00b7 q quit",
      };
    }
    const wording =
      state.kind === "failed"
        ? ["Creation failed", state.message]
        : state.kind === "cancelled"
          ? ["Creation was cancelled", "No record was found afterwards"]
          : [
              "The creation outcome is unknown",
              "Retry is unavailable until the outcome is known",
            ];
    return {
      location: "New workstream",
      truth: wording[0]!,
      frame: { kind: "intertitle", title: "Create", lines: wording },
      bench: [
        `Project \u00b7 ${basename(projectRoot)}`,
        `Root \u00b7 ${projectRoot}`,
      ],
      keyLine: "Esc close \u00b7 r refresh \u00b7 q quit",
    };
  }

  function createdBench(
    record: { name: string; workstream_id: string },
    commands: ReturnType<typeof joinCommands>,
    projectLines: readonly string[],
  ): string[] {
    const selected = commands[createdCommandIndex]!;
    if (punchResult === undefined || punchResult.kind === "refused") {
      return [
        `${record.name} \u00b7 open`,
        `Selected \u00b7 ${selected.text}`,
        `ID \u00b7 ${record.workstream_id}`,
        "Creation itself enrolled no sessions",
        ...projectLines,
      ];
    }
    if (punchResult.kind === "reported_success") {
      return [
        `${selected.label} \u00b7 selected`,
        `Punched \u00b7 ${punchResult.value}`,
        "Clipboard updated. The command was not run.",
        `ID \u00b7 ${record.workstream_id}`,
        ...projectLines,
      ];
    }
    if (punchResult.kind === "sent_unconfirmed") {
      return [
        `${selected.label} \u00b7 selected`,
        punchResult.value,
        "Clipboard write was sent but not confirmed.",
        "Copy the selected line manually if needed.",
        ...projectLines,
      ];
    }
    return [
      `${selected.label} \u00b7 selected`,
      punchResult.value,
      "Clipboard unavailable. Copy the selected line manually.",
      "The command was not run.",
      ...projectLines,
    ];
  }

  function helpView(): CardView {
    return {
      location: "Help",
      truth: "Help is read-only. Esc returns to the current selection.",
      frame: {
        kind: "help",
        title: "Words and keys",
        keyRows: [
          { term: "j/k · Enter/Esc", meaning: "Move / open / back" },
          {
            term: "n / on Home",
            meaning: "Create / switch Open or Completed",
          },
          {
            term: "x on selection",
            meaning: "Complete / reopen after confirmation",
          },
          {
            term: "r · ? · Space",
            meaning: "Refresh / help / pause-resume",
          },
        ],
        wordRows: [
          { term: "Working now", meaning: "A shown lease is working" },
          {
            term: "Waiting/Blocked",
            meaning: "A shown lease is waiting or blocked",
          },
          { term: "Needs input", meaning: "Input is needed from the user" },
          {
            term: "Quiet",
            meaning: "Complete proof: no work or attention",
          },
          {
            term: "Last shown",
            meaning: "Recent proof; older history is bounded",
          },
          {
            term: "Activity unknown",
            meaning: "Activity evidence is incomplete",
          },
          { term: "News", meaning: "Unread peer turns waiting for a session" },
          {
            term: "Publish blocked",
            meaning: "A complete publish check found a jam",
          },
          {
            term: "Data incomplete",
            meaning: "Required evidence was unavailable",
          },
        ],
      },
      bench: [
        "Home opens on Open; / switches to Completed.",
        "Completion does not stop joined sessions.",
        "Claims are advisory path evidence, not locks.",
        "Opening help never reads, acknowledges, or writes data.",
      ],
      keyLine: "Esc close · q quit",
    };
  }

  function absentView(): CardView {
    return {
      location: "Setup",
      truth: "No film loaded",
      frame: {
        kind: "intertitle",
        title: "No film loaded",
        lines: [
          "No film loaded",
          "Press n to create this project's first workstream.",
          "That establishes Barbaro here.",
          "Creation enrolls no sessions.",
        ],
      },
      bench: [
        `Project · ${basename(projectRoot)} · root ${projectRoot}`,
        "Nothing was created by looking.",
      ],
      keyLine: "n new workstream · r refresh · q quit",
    };
  }

  function loadingView(): CardView {
    const failure = model.readFailure;
    return {
      location: "Barbaro",
      truth: failure === undefined ? "Reading the store" : "The store could not be read",
      frame: {
        kind: "intertitle",
        title: "Barbaro",
        lines:
          failure === undefined
            ? ["Reading the store"]
            : ["The store could not be read", excerptText(failure, 58)],
      },
      bench: [`Project · ${basename(projectRoot)} · root ${projectRoot}`],
      keyLine: "r refresh · q quit",
    };
  }

  function bootView(card: CardGeometry): BootView {
    const current = startup!;
    return {
      frameIndex: startupFrameAtTick(current.ticksElapsed),
      scale: card.tier === "comfort" ? "hero" : "compact",
      telemetry: startupTelemetry(current, card.width),
    };
  }

  function lifecycleTraversalCardView(): CardView {
    const film = lifecycleFilm!;
    const state = lifecycle!;
    const progress = lifecycleTraversalProgressAtTick(film.ticksElapsed);
    const verb = state.action === "complete" ? "Completing" : "Reopening";
    const cancelRequested =
      state.kind === "pending" && state.cancelRequested;
    const truth = (() => {
      switch (film.phase) {
        case "writer":
          return cancelRequested
            ? "Cancellation requested · awaiting command settlement"
            : `${verb} ${state.target.name}… · running public command`;
        case "reconcile":
          return "Checking durable state";
        case "finishing":
          return "Confirmed · finishing motion pass";
      }
    })();
    const keyLine =
      film.phase === "writer"
        ? cancelRequested
          ? "Cancellation requested · q quit"
          : "Esc request cancel · q quit"
        : "q quit";
    return {
      location: "Lifecycle",
      truth,
      frame: {
        kind: "traversal",
        title: `${verb} ${state.target.name}`,
        frameIndex: progress.frameIndex,
        progress: progress.position,
      },
      bench: film.bench,
      keyLine,
    };
  }

  function startupTelemetry(current: StartupState, width: number): string {
    const elapsed = startupElapsed(current);
    const projected = formatProjectedBytes(current.projectedBytes);
    const preferred = (() => {
      switch (current.phase) {
        case "store":
          return `Reading store · ${elapsed}s elapsed`;
        case "catalogue":
          return `Reading catalogue · ${elapsed}s elapsed · ${projected} projected`;
        case "workstream":
          return `Reading workstream · ${elapsed}s elapsed · ${projected} projected`;
        case "failed":
          return `Refresh failed · ${elapsed}s elapsed · ${projected} projected`;
        case "ready":
          return current.storeAbsent
            ? `Refresh ${elapsed}s · no store · ${projected} projected`
            : `Refresh ${elapsed}s · ${current.shownTurns} shown turns · ${projected} projected`;
      }
    })();
    if (measureCells(preferred) <= width) return preferred;
    return current.phase === "failed"
      ? `Refresh failed · ${elapsed}s elapsed`
      : current.phase === "ready"
        ? `Refresh ${elapsed}s · ${projected} projected`
        : `${
            current.phase === "catalogue"
              ? "Reading catalogue"
              : current.phase === "workstream"
                ? "Reading workstream"
                : "Reading store"
          } · ${elapsed}s elapsed`;
  }

  function startupElapsed(current: StartupState): string {
    const elapsedMs =
      current.readDurationMs ??
      Math.max(0, monotonicNow() - current.startedAtMs);
    return (elapsedMs / 1_000).toFixed(1);
  }

  function formatProjectedBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const kibibytes = bytes / 1_024;
    return `${
      kibibytes >= 100 ? Math.round(kibibytes) : kibibytes.toFixed(1)
    } KiB`;
  }

  function bootWordPage(card: CardGeometry): string[] {
    const current = startup!;
    const phase =
      current.phase === "store"
        ? "Reading the store"
        : current.phase === "catalogue"
          ? "Reading the catalogue"
          : current.phase === "workstream"
            ? "Reading the workstream"
            : current.phase === "failed"
              ? "Refresh failed"
              : "Read complete";
    return renderBootTextPage(
      {
        phase,
        elapsed: `${startupElapsed(current)}s`,
        projected: formatProjectedBytes(current.projectedBytes),
      },
      card,
    );
  }

  function withFailure(truth: string): string {
    if (model.readFailure === undefined) return truth;
    return model.refresh === undefined
      ? "The store could not be read"
      : `${truth} · Refresh failed`;
  }

  function wordPage(card: CardGeometry): string[] {
    const lines: string[] = [];
    const catalogue = model.catalogue;
    const scopeName =
      mode.kind === "dashboard"
        ? currentItem()?.record.name ?? "scoped"
        : `${capitalizedFilter(homeFilter)} workstreams`;
    lines.push("Barbaro");
    lines.push(`Scope ${scopeName}`);
    if (model.health === undefined) {
      lines.push("Reading the store");
    } else if (model.health.presence === "absent") {
      lines.push("No film loaded");
    } else {
      lines.push(`Store ${model.health.read_state}`);
    }
    if (catalogue !== undefined) {
      const scopedWorkstreamId =
        mode.kind === "dashboard" ? mode.workstreamId : undefined;
      const items =
        scopedWorkstreamId !== undefined
          ? catalogue.workstreams.items.filter(
              (item) => item.record.workstream_id === scopedWorkstreamId,
            )
          : catalogue.workstreams.items.filter(
              (item) => item.record.status === homeFilter,
            );
      let working = 0;
      let waiting = 0;
      let blocked = 0;
      for (const item of items) {
        working += item.active_state_counts.working;
        waiting += item.active_state_counts.waiting;
        blocked += item.active_state_counts.blocked;
      }
      if (mode.kind === "dashboard" || homeFilter === "open") {
        lines.push(`Working ${working}`);
        lines.push(`Waiting ${waiting}`);
        lines.push(`Blocked ${blocked}`);
      }
      if (mode.kind === "home") {
        const counts = catalogue.workstream_status_counts;
        const exact =
          counts.read_state === "ok" && counts.coverage.state === "complete";
        const total = homeFilter === "open" ? counts.open : counts.completed;
        lines.push(
          exact
            ? `Shown ${items.length} of ${total} ${homeFilter}`
            : `Shown ${items.length} ${homeFilter} known`,
        );
        lines.push(
          exact
            ? `${counts.open} open · ${counts.completed} completed`
            : `${counts.open} open known · ${counts.completed} completed known`,
        );
      } else {
        lines.push(`Shown ${items.length} scoped`);
      }
    }
    if (model.readFailure !== undefined) {
      lines.push("Read failed");
    }
    if (card.tier === "text") {
      lines.push(`Root ${projectRoot}`);
    }
    const page = lines
      .slice(0, Math.max(0, card.height - 1))
      .map((line) => padCells(line, card.width));
    while (page.length < Math.max(0, card.height - 1)) {
      page.push(" ".repeat(card.width));
    }
    if (card.height > 0) page.push(padCells(narrowKeyLine(card), card.width));
    return page;
  }

  function lifecycleWordPage(card: CardGeometry): string[] {
    const state = lifecycle!;
    const lines = ["Barbaro"];
    if (state.kind === "confirm") {
      lines.push("Confirm");
      lines.push(
        `${state.action === "complete" ? "Complete" : "Reopen"} ${state.target.name}?`,
      );
      lines.push("No change has been made");
      lines.push("Enter · Yes");
      lines.push("Esc · No");
      lines.push("● Waiting on you");
    } else if (state.kind === "pending") {
      lines.push(state.action === "complete" ? "Completing" : "Reopening");
      lines.push(state.target.name);
      lines.push(
        state.cancelRequested ? "Checking after cancel" : "Checking the store",
      );
    } else if (state.kind === "confirmed") {
      lines.push(state.action === "complete" ? "Completed" : "Reopened");
      lines.push(state.record.name);
      lines.push(`Status ${state.record.status}`);
    } else {
      lines.push(state.kind === "unknown" ? "Outcome unknown" : state.kind);
      lines.push(state.target.name);
      lines.push(`Status ${state.target.status}`);
    }
    const page = lines
      .slice(0, Math.max(0, card.height - 1))
      .map((line) => padCells(line, card.width));
    while (page.length < Math.max(0, card.height - 1)) {
      page.push(" ".repeat(card.width));
    }
    if (card.height > 0) page.push(padCells(narrowKeyLine(card), card.width));
    return page;
  }

  function narrowKeyLine(card?: CardGeometry): string {
    if (lifecycle?.kind === "confirm") {
      if (card?.tier === "text") {
        return "Enter yes · Esc no · q quit";
      }
      if (card?.tier === "floor") return "Esc · q quit";
      return "Esc cancel";
    }
    if (lifecycle?.kind === "pending") {
      return lifecycle.cancelRequested ? "q quit" : "Esc check · q quit";
    }
    if (lifecycle !== undefined) return "Esc back · q quit";
    if (
      card?.tier === "text" &&
      mode.kind === "dashboard" &&
      create === undefined
    ) {
      return "Esc home · r refresh · q quit";
    }
    if (card?.tier === "text" && mode.kind === "home" && create === undefined) {
      if (model.health?.presence === "absent") {
        return "n new workstream · r refresh · q quit";
      }
      const toggle = `/ ${homeFilter === "open" ? "completed" : "open"}`;
      return `${toggle} · r refresh · q quit`;
    }
    return create?.kind === "form" ? "Esc cancel" : "q quit";
  }

  // Terminal ownership begins only after every refusal has had its chance.
  options.input.setRawMode?.(true);
  options.input.resume?.();
  options.input.on("data", onData);
  options.output.on("resize", onResize);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    options.signals?.on(signal, onSignal);
  }
  screen.enter();
  startStartup();
  render();
  void refresh(true);

  return done;
}
