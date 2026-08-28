#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableStringify } from "./core/stable-json.js";
import { readProjectContext } from "./reader/index.js";
import { createSessionId } from "./core/id.js";
import {
  AwaitScanFailureLimitError,
  DEFAULT_AWAIT_TIMEOUT_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  MAX_AWAIT_TIMEOUT_MS,
  WATCH_MAX_CONSECUTIVE_ERRORS,
  WatchEngine,
  awaitUnreadPeerTurns,
  formatAwaitUnread,
  formatAwaitTimeout,
  formatWatchEvent,
  watchErrorEvent,
  type AwaitResult,
  type WatchEvent,
} from "./watch/index.js";
import {
  handleCodexHookFailOpen,
  handleCodexIngestHookFailOpen,
  renderCodexHookOutput,
} from "./hooks/codex.js";
import {
  handleClaudeHookFailOpen,
  handleClaudeIngestHookFailOpen,
  renderClaudeHookOutput,
} from "./hooks/claude.js";
import {
  participationMemberships,
  PARTICIPATING_PROVIDERS,
  SessionParticipationStore,
  type ParticipatingProvider,
  type SessionParticipation,
} from "./hooks/participation.js";
import {
  InvalidWorkstreamNameError,
  WorkstreamNameTakenError,
  WorkstreamStore,
} from "./workstreams/index.js";
import { collectWorkstreamPresence } from "./workstreams/store.js";
import { runClaudeTrace } from "./runner/claude.js";
import { runCodexTrace } from "./runner/codex.js";
import {
  COMFORT_REFRESH_INTERVAL_MS,
  comfortTermRefusal,
  runComfortTui,
} from "./tui/comfort-app.js";
import {
  COMFORT_BYTE_BUDGET,
  COMFORT_TURNS_PER_SESSION,
} from "./tui/defaults.js";
import { renderOnceSnapshot } from "./tui/once.js";

class UsageError extends TypeError {}

const HELP_FLAGS = new Set(["--help", "-h"]);
const SIMPLE_HELP_COMMANDS = new Set(["context", "tui", "watch", "await"]);
const PROVIDER_HELP_COMMANDS = new Set([
  "status",
  "ingest",
  "hook",
  "hook-ingest",
]);
const WORKSTREAM_HELP_COMMANDS = new Set(["list", "show", "new"]);

export async function main(
  argv: readonly string[],
  io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  runInteractiveTui: typeof runComfortTui = runComfortTui,
  runAwait: typeof awaitUnreadPeerTurns = awaitUnreadPeerTurns,
): Promise<number> {
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(`${packageVersion()}\n`);
    return 0;
  }

  if (
    argv.length === 0 ||
    ((argv.includes("--help") || argv.includes("-h")) &&
      isRecognizedHelpTarget(argv))
  ) {
    io.stdout(helpText());
    return 0;
  }

  if (
    (argv[0] === "codex" || argv[0] === "claude") &&
    argv[1] === "status"
  ) {
    const provider: ParticipatingProvider = argv[0];
    const flags = parseFlags(
      argv.slice(2),
      new Set(["session-id", "project-root"]),
    );
    const nativeSessionId = requiredFlag(flags, "session-id");
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const participation = await new SessionParticipationStore(projectRoot).read(
      provider,
      nativeSessionId,
    );
    const workstream =
      participation?.workstream_id === undefined
        ? undefined
        : await new WorkstreamStore(projectRoot).get(
            participation.workstream_id,
          );
    io.stdout(
      `${stableStringify({
        provider,
        session_id: createSessionId(provider, nativeSessionId),
        joined: participation !== undefined,
        ...(participation === undefined
          ? {}
          : {
              joined_at: participation.joined_at,
              memberships: participationMemberships(participation),
            }),
        ...(participation?.workstream_id === undefined
          ? {}
          : {
              workstream: {
                workstream_id: participation.workstream_id,
                ...(workstream === undefined
                  ? {}
                  : { name: workstream.name, status: workstream.status }),
              },
            }),
        // A v1 consent record is joined but remains unscoped until a move.
        ...(participation !== undefined &&
        participation.workstream_id === undefined
          ? { unscoped: true }
          : {}),
      })}\n`,
    );
    return 0;
  }

  if (argv[0] === "workstream") {
    return runWorkstreamCommand(argv.slice(1), io);
  }

  // The reader has existed as an API since v1 with no way to reach it, so both
  // agents hand-rolled `.barbaro/active/*.json` scans with their own expiry
  // filtering — and saw dozens of stale actors the supported path already
  // hides. This exposes the projection that was there all along.
  if (argv[0] === "context") {
    const flags = parseFlags(
      argv.slice(1),
      new Set([
        "project-root",
        "byte-budget",
        "turns-per-session",
        "provider",
        "session-id",
        "workstream",
        "all-workstreams",
      ]),
      new Set(["all-workstreams"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const byteBudget = positiveIntegerFlag(flags, "byte-budget", 16_384);
    const turnsPerSession = positiveIntegerFlag(flags, "turns-per-session", 5);
    // Scope: an explicit --workstream, else the calling session's own
    // workstream (--provider/--session-id), else the whole project.
    const workstreamId = await resolveWorkstreamScope(flags, projectRoot);
    const projection = await readProjectContext(projectRoot, {
      byteBudget,
      turnsPerSession,
      ...(workstreamId === undefined ? {} : { workstreamId }),
    });
    io.stdout(`${stableStringify(projection)}\n`);
    return 0;
  }

  if (argv[0] === "tui") {
    const flags = parseFlags(
      argv.slice(1),
      new Set([
        "project-root",
        "interval-ms",
        "byte-budget",
        "turns-per-session",
        "workstream",
        "all-workstreams",
        "no-color",
        "no-motion",
        "once",
        "width",
        "height",
      ]),
      new Set(["all-workstreams", "no-color", "no-motion", "once"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    if (
      !flags.has("once") &&
      (flags.has("width") || flags.has("height"))
    ) {
      throw new UsageError("--width and --height are only valid with --once");
    }
    const intervalMs = positiveIntegerFlag(
      flags,
      "interval-ms",
      COMFORT_REFRESH_INTERVAL_MS,
    );
    const byteBudget = positiveIntegerFlag(
      flags,
      "byte-budget",
      COMFORT_BYTE_BUDGET,
    );
    const turnsPerSession = positiveIntegerFlag(
      flags,
      "turns-per-session",
      COMFORT_TURNS_PER_SESSION,
    );
    // §8: a bare --once is exactly 64×28; a requested size below the 12×6
    // floor gets the true-size notice at its actual geometry.
    const snapshotDimensions = flags.has("once")
      ? {
          width: positiveIntegerFlag(flags, "width", 64),
          height: positiveIntegerFlag(flags, "height", 28),
        }
      : undefined;
    const workstreamId = await resolveWorkstreamScope(flags, projectRoot);
    const workstream =
      workstreamId === undefined
        ? undefined
        : await new WorkstreamStore(projectRoot).get(workstreamId);
    if (workstreamId !== undefined && workstream === undefined) {
      throw new UsageError(
        `no workstream named ${JSON.stringify(
          flags.get("workstream") ?? workstreamId,
        )}`,
      );
    }
    const scope =
      workstream === undefined
        ? undefined
        : {
            name: workstream.name,
            workstreamId: workstream.workstream_id,
          };

    if (snapshotDimensions !== undefined) {
      io.stdout(
        await renderOnceSnapshot({
          projectRoot,
          width: snapshotDimensions.width,
          height: snapshotDimensions.height,
          motionOff: flags.has("no-motion"),
          byteBudget,
          turnsPerSession,
          ...(workstreamId === undefined ? {} : { workstreamId }),
        }),
      );
      return 0;
    }

    // §9 entry precedence: TERM is refused before terminal ownership.
    const refusal = comfortTermRefusal(process.env["TERM"]);
    if (refusal !== undefined) {
      for (const line of refusal.lines) io.stderr(`${line}\n`);
      return 2;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      io.stderr(
        "barbaro tui requires an interactive terminal; use --once for a plain snapshot\n",
      );
      return 1;
    }
    return runInteractiveTui({
      projectRoot,
      term: process.env["TERM"],
      stderr: (line) => io.stderr(`${line}\n`),
      input: process.stdin,
      output: process.stdout,
      signals: process,
      intervalMs,
      byteBudget,
      turnsPerSession,
      // NO_COLOR and --no-color disable styling only; motion has its own flag.
      color:
        !flags.has("no-color") && process.env["NO_COLOR"] === undefined,
      motion: !flags.has("no-motion"),
      ...(workstreamId === undefined ? {} : { workstreamId }),
    });
  }

  // A cursor-bound observer for an enrolled session. Unlike watch, await has
  // no in-memory baseline and cannot suppress content by provenance: every
  // peer turn newer than the hook-owned read cursor is unread.
  if (argv[0] === "await") {
    const flags = parseFlags(
      argv.slice(1),
      new Set([
        "project-root",
        "interval-ms",
        "timeout-ms",
        "self",
        "provider",
        "session-id",
        "workstream",
        "all-workstreams",
        "json",
      ]),
      new Set(["all-workstreams", "json"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const intervalMs = positiveIntegerFlag(
      flags,
      "interval-ms",
      DEFAULT_WATCH_INTERVAL_MS,
    );
    const timeoutMs = positiveIntegerFlag(
      flags,
      "timeout-ms",
      DEFAULT_AWAIT_TIMEOUT_MS,
    );
    if (timeoutMs > MAX_AWAIT_TIMEOUT_MS) {
      throw new UsageError(
        `--timeout-ms must be at most ${MAX_AWAIT_TIMEOUT_MS}`,
      );
    }
    assertAwaitIdentityFlags(flags);

    if (!(await barbaroStoreExists(projectRoot))) {
      io.stderr(`no .barbaro directory under ${resolve(projectRoot)}\n`);
      return 1;
    }
    const cursor = await resolveAwaitCursor(flags, projectRoot, io);
    if (cursor === WATCH_SELF_REFUSED) return 1;
    let result: AwaitResult;
    try {
      result = await runAwait({
        projectRoot,
        ...cursor,
        intervalMs,
        timeoutMs,
      });
    } catch (error: unknown) {
      if (error instanceof AwaitScanFailureLimitError) {
        io.stderr(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
    io.stdout(
      `${flags.has("json")
        ? stableStringify(result)
        : result.kind === "timeout"
          ? formatAwaitTimeout(result)
          : formatAwaitUnread(result)}\n`,
    );
    return 0;
  }

  // The event stream behind `/barbaro-watch` and any live status view. The engine
  // reads through the supported stores, so this surface can never resurrect
  // the hand-rolled `.barbaro/` scans that `barbaro context` exists to end.
  if (argv[0] === "watch") {
    const flags = parseFlags(
      argv.slice(1),
      new Set([
        "project-root",
        "interval-ms",
        "self",
        "provider",
        "session-id",
        "workstream",
        "all-workstreams",
        "json",
        "once",
      ]),
      new Set(["all-workstreams", "json", "once"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const intervalMs = positiveIntegerFlag(
      flags,
      "interval-ms",
      DEFAULT_WATCH_INTERVAL_MS,
    );
    const self = await resolveWatchSelf(flags, projectRoot, io);
    if (self === WATCH_SELF_REFUSED) return 1;

    // Watching a project with no store would silently report nothing forever,
    // and the store is never created just because someone looked for it.
    if (!(await barbaroStoreExists(projectRoot))) {
      io.stderr(`no .barbaro directory under ${resolve(projectRoot)}\n`);
      return 1;
    }

    // A session watching as itself is scoped to its own workstream; an
    // observer passes --workstream, or --all-workstreams for everything.
    const workstreamId = await resolveWorkstreamScope(
      flags,
      projectRoot,
      self.workstreamId,
    );
    const engine = new WatchEngine({
      projectRoot,
      ...(self.sessionId === undefined
        ? {}
        : { selfSessionId: self.sessionId }),
      ...(workstreamId === undefined ? {} : { workstreamId }),
    });
    const emit = (event: WatchEvent): void => {
      io.stdout(
        `${flags.has("json") ? stableStringify(event) : formatWatchEvent(event)}\n`,
      );
    };
    emit(await engine.prime());
    if (flags.has("once")) {
      for (const event of await engine.poll()) emit(event);
      return 0;
    }
    let consecutiveErrors = 0;
    for (;;) {
      await sleep(intervalMs);
      try {
        for (const event of await engine.poll()) emit(event);
        consecutiveErrors = 0;
      } catch (error: unknown) {
        consecutiveErrors += 1;
        emit(watchErrorEvent(error, consecutiveErrors));
        if (consecutiveErrors >= WATCH_MAX_CONSECUTIVE_ERRORS) {
          io.stderr("barbaro watch: too many consecutive scan failures\n");
          return 1;
        }
      }
    }
  }

  if (argv[0] === "claude" && argv[1] === "ingest") {
    const flags = parseFlags(
      argv.slice(2),
      new Set(["trace", "project-root", "reset", "live"]),
      new Set(["reset", "live"]),
    );
    const tracePath = requiredFlag(flags, "trace");
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const result = await runClaudeTrace({
      tracePath,
      projectRoot,
      reset: flags.has("reset"),
      // --live means the session may still be mid-turn, so the trailing turn
      // is withheld rather than published and later revised.
      final: !flags.has("live"),
    });
    io.stdout(`${stableStringify(result)}\n`);
    return 0;
  }

  if (
    argv[0] === "claude" &&
    (argv[1] === "hook" || argv[1] === "hook-ingest")
  ) {
    if (argv.length !== 2) {
      throw new UsageError(`barbaro claude ${argv[1]} takes no arguments`);
    }
    const raw = await readStdin();
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      // Hooks are fail-open. Invalid stdin must not block the coding turn.
      return 0;
    }
    if (argv[1] === "hook-ingest") {
      await handleClaudeIngestHookFailOpen(input);
    } else {
      const result = await handleClaudeHookFailOpen(input);
      const output = renderClaudeHookOutput(result);
      if (output.length > 0) io.stdout(output);
    }
    return 0;
  }

  if (argv[0] === "codex" && argv[1] === "ingest") {
    const flags = parseFlags(
      argv.slice(2),
      new Set(["trace", "project-root", "reset"]),
    );
    const tracePath = requiredFlag(flags, "trace");
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const result = await runCodexTrace({
      tracePath,
      projectRoot,
      reset: flags.has("reset"),
    });
    io.stdout(`${stableStringify(result)}\n`);
    return 0;
  }

  if (
    argv[0] === "codex" &&
    (argv[1] === "hook" || argv[1] === "hook-ingest")
  ) {
    if (argv.length !== 2) {
      throw new UsageError(`barbaro codex ${argv[1]} takes no arguments`);
    }
    const raw = await readStdin();
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      // Hooks are fail-open. Invalid stdin must not block the coding turn.
      return 0;
    }
    if (argv[1] === "hook-ingest") {
      await handleCodexIngestHookFailOpen(input);
    } else {
      const result = await handleCodexHookFailOpen(input);
      const output = renderCodexHookOutput(result);
      if (output.length > 0) io.stdout(output);
    }
    return 0;
  }

  io.stderr(`Unknown command: ${argv.join(" ")}\n\n${helpText()}`);
  return 2;
}

function isRecognizedHelpTarget(argv: readonly string[]): boolean {
  const command = argv[0];
  if (command === undefined || HELP_FLAGS.has(command)) return true;
  if (SIMPLE_HELP_COMMANDS.has(command)) return true;

  const subcommand = argv[1];
  if (command === "workstream") {
    return (
      subcommand !== undefined &&
      (HELP_FLAGS.has(subcommand) || WORKSTREAM_HELP_COMMANDS.has(subcommand))
    );
  }
  if (command === "codex" || command === "claude") {
    return (
      subcommand !== undefined &&
      (HELP_FLAGS.has(subcommand) || PROVIDER_HELP_COMMANDS.has(subcommand))
    );
  }
  return false;
}

function packageVersion(): string {
  const manifestPath = fileURLToPath(
    new URL("../../package.json", import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`package manifest has no version: ${manifestPath}`);
  }
  return manifest.version;
}

/** Distinguishes observation as nobody from refused session impersonation. */
const WATCH_SELF_REFUSED: unique symbol = Symbol("watch-self-refused");

interface ResolvedAwaitCursor {
  readonly provider: ParticipatingProvider;
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly membershipFrom: string;
}

function assertAwaitIdentityFlags(flags: ReadonlyMap<string, string>): void {
  const self = flags.get("self");
  const provider = flags.get("provider");
  const nativeSessionId = flags.get("session-id");
  if (
    self !== undefined &&
    (provider !== undefined || nativeSessionId !== undefined)
  ) {
    throw new UsageError(
      "--self is mutually exclusive with --provider/--session-id",
    );
  }
  if ((provider === undefined) !== (nativeSessionId === undefined)) {
    throw new UsageError("--provider and --session-id must be supplied together");
  }
  if (self === undefined && provider === undefined) {
    throw new UsageError(
      "barbaro await requires --self or --provider/--session-id",
    );
  }
  if (flags.has("all-workstreams")) {
    throw new UsageError(
      "barbaro await cannot use --all-workstreams with a session cursor",
    );
  }
}

async function resolveAwaitCursor(
  flags: ReadonlyMap<string, string>,
  projectRoot: string,
  io: { readonly stderr: (text: string) => void },
): Promise<ResolvedAwaitCursor | typeof WATCH_SELF_REFUSED> {
  const store = new SessionParticipationStore(projectRoot);
  const self = flags.get("self");
  let provider: ParticipatingProvider;
  let participation: SessionParticipation | undefined;

  if (self !== undefined) {
    if (!/^ses_[0-9a-f]{32}$/u.test(self)) {
      throw new UsageError("--self must be a stable ses_<32 hex> session id");
    }
    const matches: {
      readonly provider: ParticipatingProvider;
      readonly participation: SessionParticipation;
    }[] = [];
    for (const candidate of PARTICIPATING_PROVIDERS) {
      const found = await store.readStable(candidate, self);
      if (found !== undefined) {
        matches.push({ provider: candidate, participation: found });
      }
    }
    if (matches.length > 1) {
      throw new Error("stable session identity is enrolled under multiple providers");
    }
    const match = matches[0];
    if (match === undefined) {
      io.stderr(
        "this session has not joined Barbaro — run /barbaro (Claude Code) or $barbaro (Codex) first\n",
      );
      return WATCH_SELF_REFUSED;
    }
    provider = match.provider;
    participation = match.participation;
  } else {
    const rawProvider = flags.get("provider");
    const nativeSessionId = flags.get("session-id");
    if (
      (rawProvider !== "claude" && rawProvider !== "codex") ||
      nativeSessionId === undefined
    ) {
      throw new UsageError(`Unknown provider: ${String(rawProvider)}`);
    }
    provider = rawProvider;
    participation = await store.read(provider, nativeSessionId);
    if (participation === undefined) {
      io.stderr(
        "this session has not joined Barbaro — run /barbaro (Claude Code) or $barbaro (Codex) first\n",
      );
      return WATCH_SELF_REFUSED;
    }
  }

  const membership = participationMemberships(participation).at(-1);
  if (membership === undefined) {
    io.stderr(
      "this session has joined Barbaro but has no workstream cursor — join an open workstream first\n",
    );
    return WATCH_SELF_REFUSED;
  }
  const explicit = flags.get("workstream");
  if (explicit !== undefined) {
    const resolvedWorkstream = await new WorkstreamStore(projectRoot).resolve(
      explicit,
    );
    if (resolvedWorkstream === undefined) {
      throw new UsageError(`no workstream named ${JSON.stringify(explicit)}`);
    }
    if (resolvedWorkstream.workstream_id !== membership.workstream_id) {
      throw new UsageError(
        "barbaro await cannot reinterpret this session's cursor for a different workstream",
      );
    }
  }
  return {
    provider,
    sessionId: participation.session_id,
    workstreamId: membership.workstream_id,
    membershipFrom: membership.from,
  };
}

interface ResolvedWatchSelf {
  readonly sessionId?: string;
  readonly workstreamId?: string;
}

async function resolveWatchSelf(
  flags: ReadonlyMap<string, string>,
  projectRoot: string,
  io: { readonly stderr: (text: string) => void },
): Promise<ResolvedWatchSelf | typeof WATCH_SELF_REFUSED> {
  const self = flags.get("self");
  const provider = flags.get("provider");
  const nativeSessionId = flags.get("session-id");
  if (
    self !== undefined &&
    (provider !== undefined || nativeSessionId !== undefined)
  ) {
    throw new UsageError(
      "--self is mutually exclusive with --provider/--session-id",
    );
  }
  if ((provider === undefined) !== (nativeSessionId === undefined)) {
    throw new UsageError("--provider and --session-id must be supplied together");
  }
  if (self !== undefined) {
    if (!/^ses_[0-9a-f]{32}$/.test(self)) {
      throw new UsageError("--self must be a stable ses_<32 hex> session id");
    }
    const participation = (
      await new SessionParticipationStore(projectRoot).list()
    ).find((candidate) => candidate.session_id === self);
    if (participation === undefined) {
      io.stderr(
        "this session has not joined Barbaro — run /barbaro (Claude Code) or $barbaro (Codex) first\n",
      );
      return WATCH_SELF_REFUSED;
    }
    return {
      sessionId: self,
      ...(participation.workstream_id === undefined
        ? {}
        : { workstreamId: participation.workstream_id }),
    };
  }
  if (provider === undefined || nativeSessionId === undefined) {
    return {};
  }
  if (provider !== "claude" && provider !== "codex") {
    throw new UsageError(`Unknown provider: ${provider}`);
  }
  // Resolving through the participation store doubles as the consent gate: a
  // session that never joined publishes nothing and has no standing to watch
  // as itself.
  const participation = await new SessionParticipationStore(projectRoot).read(
    provider,
    nativeSessionId,
  );
  if (participation === undefined) {
    io.stderr(
      "this session has not joined Barbaro — run /barbaro (Claude Code) or $barbaro (Codex) first\n",
    );
    return WATCH_SELF_REFUSED;
  }
  return {
    sessionId: participation.session_id,
    ...(participation.workstream_id === undefined
      ? {}
      : { workstreamId: participation.workstream_id }),
  };
}

/**
 * Which workstream a reader or watcher is scoped to: an explicit
 * `--workstream <name|ws_id>`, else the calling session's own workstream
 * (from `--self` or `--provider`/`--session-id`), else none.
 * `--all-workstreams` forces the whole project. An unscoped
 * (pre-workstream) session reads project-wide, as before.
 */
async function resolveWorkstreamScope(
  flags: ReadonlyMap<string, string>,
  projectRoot: string,
  stableSelfWorkstreamId?: string,
): Promise<string | undefined> {
  const explicit = flags.get("workstream");
  if (flags.has("all-workstreams")) {
    if (explicit !== undefined) {
      throw new UsageError(
        "--all-workstreams is mutually exclusive with --workstream",
      );
    }
    return undefined;
  }
  if (explicit !== undefined) {
    const workstream = await new WorkstreamStore(projectRoot).resolve(explicit);
    if (workstream === undefined) {
      throw new UsageError(`no workstream named ${JSON.stringify(explicit)}`);
    }
    return workstream.workstream_id;
  }
  if (flags.has("self")) return stableSelfWorkstreamId;
  const provider = flags.get("provider");
  const nativeSessionId = flags.get("session-id");
  if ((provider === undefined) !== (nativeSessionId === undefined)) {
    throw new UsageError("--provider and --session-id must be supplied together");
  }
  if (provider === undefined || nativeSessionId === undefined) return undefined;
  if (provider !== "claude" && provider !== "codex") {
    throw new UsageError(`Unknown provider: ${provider}`);
  }
  const participation = await new SessionParticipationStore(projectRoot).read(
    provider,
    nativeSessionId,
  );
  return participation?.workstream_id;
}

async function barbaroStoreExists(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(join(projectRoot, ".barbaro"))).isDirectory();
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

const DEFAULT_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["reset"]);

function parseFlags(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
  booleans: ReadonlySet<string> = DEFAULT_BOOLEAN_FLAGS,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      throw new UsageError(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new UsageError(`Unknown flag: --${name}`);
    if (flags.has(name)) throw new UsageError(`Duplicate flag: --${name}`);
    if (booleans.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`Missing value for --${name}`);
    }
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function positiveIntegerFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return value;
}

function integerFlagAtLeast(
  flags: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const value = positiveIntegerFlag(flags, name, fallback);
  if (value < minimum) {
    throw new UsageError(`--${name} must be at least ${minimum}`);
  }
  return value;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new UsageError(`Missing required flag --${name}`);
  return value;
}

/**
 * `barbaro workstream …`: the project-level half of enrollment. Creating a
 * workstream publishes nothing about any session, so it is a plain command
 * rather than a hook-gated act; joining one stays with the provider hooks.
 */
async function runWorkstreamCommand(
  argv: readonly string[],
  io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  },
): Promise<number> {
  const verb = argv[0];
  if (verb === "list") {
    const flags = parseFlags(
      argv.slice(1),
      new Set(["project-root", "all"]),
      new Set(["all"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    let invalidRecords = 0;
    const all = await new WorkstreamStore(projectRoot).list(() => {
      invalidRecords += 1;
    });
    // Completion is a statement, not enforcement: a completed workstream
    // whose current members are still live or present stays in the default
    // listing, flagged, so nobody quietly works inside a closed record.
    const presence = all.some((record) => record.status === "completed")
      ? await collectWorkstreamPresence(projectRoot)
      : undefined;
    const flagged = all.map((record) => {
      if (record.status !== "completed" || presence === undefined) {
        return record;
      }
      const report = presence.byWorkstream.get(record.workstream_id);
      const members = report?.members ?? [];
      if (members.length > 0) {
        return {
          ...record,
          completed_presence: members.some(
            (member) => member.presence === "live",
          )
            ? "live"
            : "present",
        };
      }
      if (presence.liveness_unknown) {
        return { ...record, completed_presence: "unknown" };
      }
      return record;
    });
    const workstreams = flags.has("all")
      ? flagged
      : flagged.filter(
          (record) =>
            record.status === "open" ||
            "completed_presence" in record,
        );
    io.stdout(
      `${stableStringify({
        workstreams,
        shown: workstreams.length,
        total: all.length,
        invalid_records: invalidRecords,
      })}\n`,
    );
    return 0;
  }
  if (verb === "complete" || verb === "reopen") {
    const { positional, rest } = takePositional(
      argv.slice(1),
      `workstream ${verb} <name|ws_id>`,
    );
    const flags = parseFlags(rest, new Set(["project-root"]));
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const store = new WorkstreamStore(projectRoot);
    const existing = await store.resolve(positional);
    if (existing === undefined) {
      io.stderr(`no workstream named ${JSON.stringify(positional)}\n`);
      return 1;
    }
    if (verb === "complete") {
      // Warn, never block: the transition is reversible and enforcement-free.
      const presence = await collectWorkstreamPresence(projectRoot);
      const report = presence.byWorkstream.get(existing.workstream_id);
      for (const member of report?.members ?? []) {
        io.stderr(
          `warning: ${member.provider}/${member.session_id} is ${member.presence} in ${JSON.stringify(existing.name)}; completion does not stop it\n`,
        );
      }
      if (presence.liveness_unknown) {
        io.stderr(
          "warning: member liveness is unknown; some session or active records could not be read\n",
        );
      }
      io.stdout(`${stableStringify(await store.complete(positional))}\n`);
      return 0;
    }
    io.stdout(`${stableStringify(await store.reopen(positional))}\n`);
    return 0;
  }
  if (verb === "show") {
    const { positional, rest } = takePositional(
      argv.slice(1),
      "workstream show <name|ws_id>",
    );
    const flags = parseFlags(rest, new Set(["project-root"]));
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const workstream = await new WorkstreamStore(projectRoot).resolve(positional);
    if (workstream === undefined) {
      io.stderr(`no workstream named ${JSON.stringify(positional)}\n`);
      return 1;
    }
    io.stdout(`${stableStringify(workstream)}\n`);
    return 0;
  }
  if (verb === "new") {
    const { positional, rest } = takePositional(
      argv.slice(1),
      "workstream new <name>",
    );
    const flags = parseFlags(rest, new Set(["project-root", "title"]));
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const title = flags.get("title");
    try {
      const workstream = await new WorkstreamStore(projectRoot).create({
        name: positional,
        ...(title === undefined ? {} : { title }),
        createdBy: { kind: "cli" },
      });
      io.stdout(`${stableStringify(workstream)}\n`);
      return 0;
    } catch (error: unknown) {
      if (error instanceof WorkstreamNameTakenError) {
        io.stderr(`${error.message}\n`);
        return 1;
      }
      if (error instanceof InvalidWorkstreamNameError) {
        io.stderr(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }
  io.stderr(`Unknown workstream command: ${argv.join(" ")}\n\n${helpText()}`);
  return 2;
}

function takePositional(
  argv: readonly string[],
  usage: string,
): { readonly positional: string; readonly rest: readonly string[] } {
  const positional = argv[0];
  if (positional === undefined || positional.startsWith("--")) {
    throw new UsageError(`Usage: barbaro ${usage}`);
  }
  return { positional, rest: argv.slice(1) };
}

function helpText(): string {
  return `barbaro\n\n` +
    `  barbaro --version\n\n` +
    `  Session opt-in: \`/barbaro new|join <name>\` in Claude Code,\n` +
    `                  \`$barbaro new|join <name>\` in Codex; a bare\n` +
    `                  invocation lists workstreams and joins nothing\n\n` +
    `  barbaro codex status --session-id <id> [--project-root <path>]\n` +
    `  barbaro codex ingest --trace <rollout.jsonl> [--project-root <path>] [--reset]\n` +
    `  barbaro codex hook          # synchronous active-state hook via stdin\n` +
    `  barbaro codex hook-ingest   # asynchronous terminal-ingest hook via stdin\n` +
    `  barbaro claude ingest --trace <session.jsonl> [--project-root <path>] [--reset]\n` +
    `  barbaro claude status --session-id <id> [--project-root <path>]\n` +
    `  barbaro claude hook         # synchronous active-state hook via stdin\n` +
    `  barbaro claude hook-ingest  # Stop-hook bundle ingestion via stdin
  barbaro workstream list [--project-root <path>] [--all]
  barbaro workstream show <name|ws_id> [--project-root <path>]
  barbaro workstream new  <name> [--title <text>] [--project-root <path>]
                              # a workstream groups the sessions sharing one
                              # objective; sessions join it with the opt-in
  barbaro workstream complete <name|ws_id> [--project-root <path>]
                              # reversible statement, not enforcement; warns
                              # on stderr when current members are still
                              # live or present, and never blocks
  barbaro workstream reopen   <name|ws_id> [--project-root <path>]
                              # \`list\` hides completed workstreams unless
                              # members remain live/present (flagged);
                              # \`list --all\` always shows everything
  barbaro tui     [--project-root <path>] [--interval-ms <n>]
                  [--byte-budget <n>] [--turns-per-session <n>]
                  [--workstream <name|ws_id> | --all-workstreams]
                  [--no-color] [--no-motion]
                  [--once [--width <n>] [--height <n>]]
                              # bounded control panel; --once is read-only;
                              # live keys: q/Ctrl-C quit, r refresh, j/k or
                              # Up/Down move, Enter detail, Esc back,
                              # / Open/Completed, n new, x complete/reopen
                              # interactive writes use only the public
                              # workstream new/complete/reopen commands
                              # defaults to project scope and Home · Open;
                              # snapshots default
                              # to the exact 64x28 card, pad larger requests
                              # with matte, and answer below 12x6 with the
                              # true-size notice
  barbaro context [--project-root <path>] [--byte-budget <n>]
                  [--turns-per-session <n>]
                  [--provider <claude|codex> --session-id <id>]
                  [--workstream <name|ws_id> | --all-workstreams]
                              # live leases + newest turns, byte-bounded;
                              # scoped to the session's workstream when given
  barbaro watch   [--project-root <path>] [--interval-ms <n>] [--json] [--once]
                  [--self <ses_id> | --provider <claude|codex> --session-id <id>]
                  [--workstream <name|ws_id> | --all-workstreams]
                              # stream peer turns, joins, incidents, stale leases
                              # within the session's workstream; --self must
                              # name an enrolled stable session
  barbaro await   [--project-root <path>] [--interval-ms <n>]
                  [--timeout-ms <n>] [--json]
                  [--self <ses_id> | --provider <claude|codex> --session-id <id>]
                  [--workstream <own-name|own-ws_id>]
                              # read-only wait for the session cursor's unread
                              # peer turns; prints N unread and returns at once;
                              # timeout defaults to 600000 ms, exits 0, and
                              # is capped at 3600000 ms; --self must name an
                              # enrolled stable session\n` +
    `      --live on claude ingest withholds a trailing in-progress turn\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const invokedPath = process.argv[1];
if (invokedPath && isExecutedModule(import.meta.url, invokedPath)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}

function isExecutedModule(moduleUrl: string, invokedPath: string): boolean {
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath)
    );
  } catch {
    // Preserve direct invocation behavior if either path disappears between
    // process startup and this check.
    return moduleUrl === pathToFileURL(invokedPath).href;
  }
}
