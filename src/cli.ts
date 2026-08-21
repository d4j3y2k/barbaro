#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableStringify } from "./core/stable-json.js";
import { readProjectContext } from "./reader/index.js";
import { createSessionId } from "./core/id.js";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  WATCH_MAX_CONSECUTIVE_ERRORS,
  WatchEngine,
  formatWatchEvent,
  watchErrorEvent,
  type WatchEvent,
} from "./watch/index.js";
import {
  handleCodexHookFailOpen,
  handleCodexIngestHookFailOpen,
} from "./hooks/codex.js";
import {
  handleClaudeHookFailOpen,
  handleClaudeIngestHookFailOpen,
} from "./hooks/claude.js";
import {
  SessionParticipationStore,
  type ParticipatingProvider,
} from "./hooks/participation.js";
import { runClaudeTrace } from "./runner/claude.js";
import { runCodexTrace } from "./runner/codex.js";

export async function main(
  argv: readonly string[],
  io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
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
    io.stdout(
      `${stableStringify({
        provider,
        session_id: createSessionId(provider, nativeSessionId),
        joined: participation !== undefined,
        ...(participation === undefined
          ? {}
          : { joined_at: participation.joined_at }),
      })}\n`,
    );
    return 0;
  }

  // The reader has existed as an API since v1 with no way to reach it, so both
  // agents hand-rolled `.barbaro/active/*.json` scans with their own expiry
  // filtering — and saw dozens of stale actors the supported path already
  // hides. This exposes the projection that was there all along.
  if (argv[0] === "context") {
    const flags = parseFlags(
      argv.slice(1),
      new Set(["project-root", "byte-budget", "turns-per-session"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const byteBudget = positiveIntegerFlag(flags, "byte-budget", 16_384);
    const turnsPerSession = positiveIntegerFlag(flags, "turns-per-session", 5);
    const projection = await readProjectContext(projectRoot, {
      byteBudget,
      turnsPerSession,
    });
    io.stdout(`${stableStringify(projection)}\n`);
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
        "json",
        "once",
      ]),
      new Set(["json", "once"]),
    );
    const projectRoot = flags.get("project-root") ?? process.cwd();
    const intervalMs = positiveIntegerFlag(
      flags,
      "interval-ms",
      DEFAULT_WATCH_INTERVAL_MS,
    );
    const selfSessionId = await resolveWatchSelf(flags, projectRoot, io);
    if (selfSessionId === WATCH_SELF_REFUSED) return 1;

    // Watching a project with no store would silently report nothing forever,
    // and the store is never created just because someone looked for it.
    if (!(await barbaroStoreExists(projectRoot))) {
      io.stderr(`no .barbaro directory under ${resolve(projectRoot)}\n`);
      return 1;
    }

    const engine = new WatchEngine({
      projectRoot,
      ...(selfSessionId === undefined ? {} : { selfSessionId }),
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
      throw new TypeError(`barbaro claude ${argv[1]} takes no arguments`);
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
      await handleClaudeHookFailOpen(input);
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
      throw new TypeError(`barbaro codex ${argv[1]} takes no arguments`);
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
      await handleCodexHookFailOpen(input);
    }
    return 0;
  }

  io.stderr(`Unknown command: ${argv.join(" ")}\n\n${helpText()}`);
  return 2;
}

/** Distinguishes "watch as nobody" from "refused to watch as this session". */
const WATCH_SELF_REFUSED: unique symbol = Symbol("watch-self-refused");

async function resolveWatchSelf(
  flags: ReadonlyMap<string, string>,
  projectRoot: string,
  io: { readonly stderr: (text: string) => void },
): Promise<string | undefined | typeof WATCH_SELF_REFUSED> {
  const self = flags.get("self");
  const provider = flags.get("provider");
  const nativeSessionId = flags.get("session-id");
  if (
    self !== undefined &&
    (provider !== undefined || nativeSessionId !== undefined)
  ) {
    throw new TypeError(
      "--self is mutually exclusive with --provider/--session-id",
    );
  }
  if ((provider === undefined) !== (nativeSessionId === undefined)) {
    throw new TypeError("--provider and --session-id must be supplied together");
  }
  if (self !== undefined) {
    if (!/^ses_[0-9a-f]{32}$/.test(self)) {
      throw new TypeError("--self must be a stable ses_<32 hex> session id");
    }
    return self;
  }
  if (provider === undefined || nativeSessionId === undefined) {
    return undefined;
  }
  if (provider !== "claude" && provider !== "codex") {
    throw new TypeError(`Unknown provider: ${provider}`);
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
  return participation.session_id;
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
      throw new TypeError(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new TypeError(`Unknown flag: --${name}`);
    if (flags.has(name)) throw new TypeError(`Duplicate flag: --${name}`);
    if (booleans.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for --${name}`);
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
    throw new TypeError(`--${name} must be a positive integer`);
  }
  return value;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new TypeError(`Missing required flag --${name}`);
  return value;
}

function helpText(): string {
  return `barbaro\n\n` +
    `  Session opt-in: use \`/barbaro\` in Claude Code or \`$barbaro\` in Codex\n\n` +
    `  barbaro codex status --session-id <id> [--project-root <path>]\n` +
    `  barbaro codex ingest --trace <rollout.jsonl> [--project-root <path>] [--reset]\n` +
    `  barbaro codex hook          # synchronous active-state hook via stdin\n` +
    `  barbaro codex hook-ingest   # asynchronous terminal-ingest hook via stdin\n` +
    `  barbaro claude ingest --trace <session.jsonl> [--project-root <path>] [--reset]\n` +
    `  barbaro claude status --session-id <id> [--project-root <path>]\n` +
    `  barbaro claude hook         # synchronous active-state hook via stdin\n` +
    `  barbaro claude hook-ingest  # Stop-hook bundle ingestion via stdin
  barbaro context [--project-root <path>] [--byte-budget <n>]
                  [--turns-per-session <n>]
                              # live leases + newest turns, byte-bounded
  barbaro watch   [--project-root <path>] [--interval-ms <n>] [--json] [--once]
                  [--self <ses_id> | --provider <claude|codex> --session-id <id>]
                              # stream peer turns, joins, incidents, stale leases\n` +
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
      process.exitCode = 1;
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
