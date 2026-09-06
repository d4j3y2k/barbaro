import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { stableStringify } from "../core/stable-json.js";
import { participationMemberships, SessionParticipationStore } from "../hooks/participation.js";
import { WorkstreamStore } from "../workstreams/store.js";
import { READ_OUTPUT_CEILING_BYTES, readContentHash } from "./read-state.js";

export class ReadUsageError extends TypeError {}

export interface ReadRecipient {
  readonly provider: "codex" | "claude";
  readonly session_id: string;
  readonly workstream_id: string;
  readonly membership_from: string;
}

export interface ReadQuery {
  readonly kind: "context" | "turn";
  readonly project_root: string;
  readonly project_sha256: string;
  readonly byte_budget: number;
  readonly max_file_bytes: number;
  readonly max_record_bytes: number;
  readonly workstream_id?: string;
  readonly recipient?: ReadRecipient;
  readonly turns_per_session?: number;
  readonly turn_id?: string;
  readonly field?: "record" | "request" | "response" | "actions";
  readonly cursor?: string;
  /** Explicit all-workstream reads never carry acknowledgment authority. */
  readonly all_workstreams: boolean;
}

export function readQueryHash(query: ReadQuery): string {
  return readContentHash(stableStringify(query));
}

/** Parse only argv values. This function never expands or evaluates shell text. */
export async function resolveReadQuery(
  argv: readonly string[],
  cwd: string,
): Promise<ReadQuery> {
  const kind = argv[0] === "context" ? "context"
    : argv[0] === "turn" && argv[1] === "show" ? "turn" : undefined;
  if (kind === undefined) throw new ReadUsageError("Usage: barbaro read context | turn show <turn_id>");
  const turnId = kind === "turn" ? argv[2] : undefined;
  if (kind === "turn" && (turnId === undefined || !/^turn_[0-9a-f]{32}$/u.test(turnId))) {
    throw new ReadUsageError("read turn show requires a canonical turn_id");
  }
  const allowed = new Set([
    "project-root", "provider", "session-id", "workstream", "all-workstreams",
    "byte-budget", "max-file-bytes", "max-record-bytes",
    ...(kind === "context" ? ["turns-per-session"] : ["field", "cursor"]),
  ]);
  const flags = new Map<string, string>();
  for (let index = kind === "context" ? 1 : 3; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const name = arg.slice(2);
    if (!arg.startsWith("--") || !allowed.has(name)) throw new ReadUsageError(`Unknown read argument: ${arg}`);
    if (flags.has(name)) throw new ReadUsageError(`Duplicate flag: --${name}`);
    if (name === "all-workstreams") flags.set(name, "true");
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new ReadUsageError(`Missing value for --${name}`);
      flags.set(name, value);
    }
  }
  const provider = flags.get("provider");
  const sessionId = flags.get("session-id");
  if ((provider === undefined) !== (sessionId === undefined)) {
    throw new ReadUsageError("--provider and --session-id must be supplied together");
  }
  if (provider !== undefined && provider !== "codex" && provider !== "claude") {
    throw new ReadUsageError(`Unknown provider: ${provider}`);
  }
  const all = flags.has("all-workstreams");
  const explicit = flags.get("workstream");
  if (all && explicit !== undefined) throw new ReadUsageError("--all-workstreams is mutually exclusive with --workstream");
  const projectRoot = await realpath(resolve(cwd, flags.get("project-root") ?? "."));
  const metadata = await stat(projectRoot, { bigint: true });
  if (!metadata.isDirectory()) throw new ReadUsageError("project-root must identify a directory");
  const projectHash = readContentHash(stableStringify({
    path: projectRoot, device: metadata.dev.toString(), inode: metadata.ino.toString(),
    birthtime_ns: metadata.birthtimeNs.toString(),
  }));
  let recipient: ReadRecipient | undefined;
  if (provider !== undefined && sessionId !== undefined) {
    const store = new SessionParticipationStore(projectRoot);
    const participation = /^ses_[0-9a-f]{32}$/u.test(sessionId)
      ? await store.readStable(provider, sessionId) : await store.read(provider, sessionId);
    const membership = participation === undefined ? undefined : participationMemberships(participation).at(-1);
    if (participation !== undefined && membership !== undefined) {
      recipient = {
        provider, session_id: participation.session_id,
        workstream_id: membership.workstream_id, membership_from: membership.from,
      };
    } else if (!all && explicit === undefined) {
      throw new ReadUsageError("No enrolled workstream for this recipient; use --all-workstreams for observer reading");
    }
  }
  let workstreamId = all ? undefined : recipient?.workstream_id;
  if (explicit !== undefined) {
    const stream = await new WorkstreamStore(projectRoot).resolve(explicit);
    if (stream === undefined) throw new ReadUsageError(`No workstream named ${JSON.stringify(explicit)}`);
    workstreamId = stream.workstream_id;
  }
  const field = flags.get("field") ?? "record";
  if (!["record", "request", "response", "actions"].includes(field)) throw new ReadUsageError(`Unknown turn field: ${field}`);
  return {
    kind, project_root: projectRoot, project_sha256: projectHash,
    byte_budget: positive(flags, "byte-budget", READ_OUTPUT_CEILING_BYTES),
    max_file_bytes: positive(flags, "max-file-bytes", 64 * 1024 * 1024),
    max_record_bytes: positive(flags, "max-record-bytes", 8 * 1024 * 1024),
    all_workstreams: all,
    ...(recipient === undefined ? {} : { recipient }),
    ...(workstreamId === undefined ? {} : { workstream_id: workstreamId }),
    ...(kind === "context"
      ? { turns_per_session: positive(flags, "turns-per-session", 5) }
      : {
          turn_id: turnId!, field: field as ReadQuery["field"] & string,
          ...(flags.has("cursor") ? { cursor: flags.get("cursor")! } : {}),
        }),
  };
}

/**
 * Admit one foreground shell invocation. Only identity/PWD variables supplied
 * by the admitted hook may expand; shell evaluation is never attempted.
 */
export function readCommandArguments(
  command: string,
  variables: Readonly<Record<string, string>>,
): readonly string[] | undefined {
  if (Buffer.byteLength(command) > 8192 || /[\r\n;|&<>`#\u0000]/u.test(command)) return undefined;
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const c = command[index]!;
    if (c === quote) { quote = undefined; continue; }
    if (quote === undefined && (c === "'" || c === '"')) { quote = c; started = true; continue; }
    if (quote !== "'" && c === "$") {
      const match = /^\$(?:\{(PWD|CODEX_SESSION_ID|CLAUDE_CODE_SESSION_ID)\}|(PWD|CODEX_SESSION_ID|CLAUDE_CODE_SESSION_ID)(?![a-zA-Z0-9_]))/u.exec(command.slice(index));
      const name = match?.[1] ?? match?.[2];
      const value = name === undefined ? undefined : variables[name];
      if (match === null || value === undefined) return undefined;
      // Unquoted expansion may split or glob. Refuse instead of approximating it.
      if (quote === undefined && /[\s*?\[\]]/u.test(value)) return undefined;
      token += value; started = true; index += match[0].length - 1; continue;
    }
    if (quote !== "'" && c === "\\") {
      const next = command[++index];
      if (next === undefined) return undefined;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) token += "\\";
      token += next; started = true; continue;
    }
    if (quote === undefined && /[()*?\[\]{}~!]/u.test(c)) return undefined;
    if (quote === undefined && /[ \t]/u.test(c)) {
      if (started) tokens.push(token);
      token = ""; started = false; continue;
    }
    token += c; started = true;
  }
  if (quote !== undefined) return undefined;
  if (started) tokens.push(token);
  if (tokens[0] !== "barbaro" || tokens[1] !== "read") return undefined;
  return tokens.slice(2);
}

function positive(flags: ReadonlyMap<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new ReadUsageError(`--${name} must be a positive integer`);
  }
  return Number(raw);
}
