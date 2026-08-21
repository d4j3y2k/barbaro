import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  ActiveLeaseStore,
  deriveLeaseId,
  idleLeaseUpdate,
} from "../active/index.js";
import type {
  ActiveContent,
  ActiveCurrentAction,
  ActiveLeaseUpdateResult,
  ActiveLeaseV1,
  ActiveLeaseUpdate,
  ActiveWriteClaim,
} from "../active/types.js";
import { createSessionId, createTurnId } from "../core/id.js";
import { safeStoreFileLocation } from "../core/safe-store.js";
import { stableStringify } from "../core/stable-json.js";
import { withDirectoryLock } from "../output/directory-lock.js";
import {
  isGeneratedBarbaroPath,
  normalizeRepoPath,
} from "../providers/codex/content.js";
import {
  readCodexTraceIdentity,
  runCodexTrace,
  type RunCodexTraceResult,
} from "../runner/codex.js";
import { beginIngestAttempt } from "./ingest-attempt.js";
import { admitHookSession, SESSION_NOT_JOINED } from "./participation.js";
import {
  projectRootFromHookInput,
  recordIncident,
  sessionKeyFromHookInput,
} from "./incidents.js";

const ACTIVE_INTENT_BYTES = 4_096;
const TERMINAL_INGEST_POLL_MS = 50;
const TERMINAL_INGEST_TIMEOUT_MS = 10_000;
const READ_ONLY_CODEX_TOOLS_V0148 = new Set([
  "current_time",
  "get_context_remaining",
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "read_mcp_resource",
  "request_user_input",
  "tool_search",
  "view_image",
]);

export interface CodexHookResult {
  readonly event: string;
  readonly active_revision?: number;
  readonly trace_result?: RunCodexTraceResult;
  readonly ignored?: string;
}

export interface CodexIngestHookOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export class CodexTerminalIngestTimeoutError extends Error {
  constructor(event: string, timeoutMs: number) {
    super(`Codex ${event} transcript did not reach a terminal record within ${timeoutMs} ms`);
    this.name = "CodexTerminalIngestTimeoutError";
  }
}

async function runCodexHook(input: unknown): Promise<CodexHookResult> {
  if (!isObject(input)) throw new TypeError("Codex hook input must be a JSON object");
  const event = stringValue(input.hook_event_name) ?? stringValue(input.event_name);
  const nativeSessionId = stringValue(input.session_id);
  const cwd = stringValue(input.cwd);
  if (!event) throw new TypeError("Codex hook event name is missing");
  if (!nativeSessionId) throw new TypeError("Codex hook session_id is missing");
  if (!cwd) throw new TypeError("Codex hook cwd is missing");

  const projectRoot = resolve(cwd);
  if (event === "UserPromptSubmit") {
    await assertCodexHookTraceIdentity(
      stringValue(input.transcript_path),
      nativeSessionId,
      projectRoot,
    );
  }
  const admission = await admitHookSession({
    projectRoot,
    provider: "codex",
    nativeSessionId,
    event,
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
  });
  if (!admission.joined) {
    // The session itself is never named: it has not consented to publish.
    await recordIncident({
      projectRoot,
      provider: "codex",
      kind: "session_dormant",
      event,
      dedupKey: nativeSessionId,
    });
    return { event, ignored: SESSION_NOT_JOINED };
  }
  const sessionId = createSessionId("codex", nativeSessionId);
  const nativeAgentId = stringValue(input.agent_id);
  if (
    (event === "SubagentStart" || event === "SubagentStop") &&
    nativeAgentId === undefined
  ) {
    throw new TypeError(`Codex ${event} agent_id is missing`);
  }
  const agentId = nativeAgentId ?? stringValue(input.agent_path) ?? "main";
  const nativeTurnId = stringValue(input.turn_id);
  const turnId = nativeTurnId
    ? createTurnId("codex", nativeSessionId, agentId, nativeTurnId)
    : undefined;
  const rootTurnId = nativeTurnId
    ? createTurnId("codex", nativeSessionId, "main", nativeTurnId)
    : undefined;
  const leaseIdentity = {
    lease_id: deriveLeaseId("codex", nativeSessionId, agentId),
    provider: "codex",
    session_id: sessionId,
    agent_id: agentId,
    ...(turnId ? { turn_id: turnId } : {}),
  } as const;
  const store = new ActiveLeaseStore(join(projectRoot, ".barbaro", "active"));

  // Opportunistic hygiene, once per session: long-dead tombstones only
  // accumulate. The join event is the trigger that actually fires — sessions
  // start dormant and consent later, so a post-join SessionStart only happens
  // on resume. Failure here must never fail the event.
  if (admission.initiated || event === "SessionStart") {
    await store.reapExpiredIdle().catch(() => undefined);
  }

  if (event === "SessionStart" || event === "SessionEnd") {
    const lease = await store.writeIdle(leaseIdentity);
    return { event, active_revision: lease.revision };
  }

  if (event === "SubagentStart") {
    const settled = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleTurnIgnore(
        store,
        leaseIdentity,
        previous,
        turnId,
        rootTurnId,
      );
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "SubagentStop") {
    const settled = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleTurnIgnore(
        store,
        leaseIdentity,
        previous,
        turnId,
        rootTurnId,
      );
      if (stale) return stale;
      return { write: idleLeaseUpdate(leaseIdentity) };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "UserPromptSubmit") {
    const prompt = stringValue(input.prompt) ?? "";
    const lease = await store.write({
      ...leaseIdentity,
      state: "working",
      intent: boundedContent(prompt, ACTIVE_INTENT_BYTES),
      claims: [],
      unknown_write_scope: false,
    });
    return { event, active_revision: lease.revision };
  }

  if (event === "PreToolUse") {
    const activity = classifyToolActivity(input, projectRoot);
    const settled = await store.update(leaseIdentity, (previous) => {
      const stale = staleTurnDecision(previous, turnId);
      if (stale) return stale;
      const update: ActiveLeaseUpdate = {
        ...leaseIdentity,
        state: "working",
        ...(previous?.intent ? { intent: previous.intent } : {}),
        ...(activity.currentAction
          ? { current_action: activity.currentAction }
          : {}),
        claims: activity.claims,
        unknown_write_scope: activity.unknownWriteScope,
      };
      return { write: update };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "PermissionRequest") {
    const settled = await store.update(leaseIdentity, (previous) => {
      const stale = staleTurnDecision(previous, turnId);
      if (stale) return stale;
      const sameTurn =
        previous !== undefined && previous.turn_id === leaseIdentity.turn_id;
      const activity =
        sameTurn && previous.current_action !== undefined
          ? {
              currentAction: previous.current_action,
              claims: previous.claims,
              unknownWriteScope: previous.unknown_write_scope,
            }
          : classifyToolActivity(input, projectRoot);
      return {
        write: {
          ...leaseIdentity,
          state: "waiting",
          ...(sameTurn && previous.intent ? { intent: previous.intent } : {}),
          ...(activity.currentAction
            ? { current_action: activity.currentAction }
            : {}),
          claims: activity.claims,
          unknown_write_scope: activity.unknownWriteScope,
        },
      };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "PostToolUse") {
    const settled = await store.update(leaseIdentity, (previous) => {
      const stale = staleTurnDecision(previous, turnId);
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          ...(previous?.intent ? { intent: previous.intent } : {}),
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "PreCompact") {
    const settled = await store.update(leaseIdentity, (previous) => {
      const stale = staleTurnDecision(previous, turnId);
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          ...(previous?.intent ? { intent: previous.intent } : {}),
          current_action: {
            kind: "other",
            tool_name: "compact",
            started_at: new Date().toISOString(),
          },
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "PostCompact") {
    const settled = await store.update(leaseIdentity, (previous) => {
      const stale = staleTurnDecision(previous, turnId);
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          ...(previous?.intent ? { intent: previous.intent } : {}),
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "Stop") {
    const settled = await store.update(leaseIdentity, (previous) => {
      const stale = staleTurnDecision(previous, turnId);
      if (stale) return stale;
      return { write: idleLeaseUpdate(leaseIdentity) };
    });
    return codexUpdateResult(event, settled);
  }

  return { event, ignored: "unsupported hook event" };
}

function codexUpdateResult(
  event: string,
  settled: ActiveLeaseUpdateResult,
): CodexHookResult {
  return settled.lease !== undefined
    ? { event, active_revision: settled.lease.revision }
    : { event, ignored: settled.ignored ?? "update ignored" };
}

/**
 * Refuses an event whose turn does not match the stored lease's turn. Runs
 * inside the store's update lock, so the comparison and the write it guards
 * form one critical section.
 */
function staleTurnDecision(
  previous: ActiveLeaseV1 | undefined,
  eventTurnId: string | undefined,
): { readonly ignore: string } | undefined {
  return turnIdsDiffer(previous?.turn_id, eventTurnId)
    ? { ignore: "stale turn event ignored" }
    : undefined;
}

/**
 * Subagent events additionally compare their parent turn against the root
 * actor: a delayed SubagentStart can target an actor with no file yet, and
 * turn N must not materialize a new child lease after UserPromptSubmit has
 * advanced the root to N+1. The root read is advisory and lock-free; the
 * decisive comparison against this actor's own lease runs under its lock.
 */
async function staleTurnIgnore(
  store: ActiveLeaseStore,
  actor: {
    readonly provider: "codex";
    readonly session_id: string;
    readonly agent_id: string;
  },
  previous: ActiveLeaseV1 | undefined,
  eventTurnId: string | undefined,
  rootEventTurnId?: string,
): Promise<{ readonly ignore: string } | undefined> {
  const own = staleTurnDecision(previous, eventTurnId);
  if (own) return own;
  if (actor.agent_id !== "main" && rootEventTurnId !== undefined) {
    const root = await store.readSnapshot({
      provider: "codex",
      session_id: actor.session_id,
      agent_id: "main",
    });
    if (turnIdsDiffer(root?.turn_id, rootEventTurnId)) {
      return { ignore: "stale turn event ignored" };
    }
  }
  return undefined;
}

function turnIdsDiffer(
  currentTurnId: string | undefined,
  eventTurnId: string | undefined,
): boolean {
  return (
    currentTurnId !== undefined &&
    eventTurnId !== undefined &&
    currentTurnId !== eventTurnId
  );
}

/**
 * Run only from the second, asynchronous Stop/SubagentStop hook. Codex writes
 * the terminal rollout event after synchronous Stop hooks return, so this
 * worker polls the byte checkpoint without blocking that persistence.
 */
export async function handleCodexIngestHook(
  input: unknown,
  options: CodexIngestHookOptions = {},
): Promise<CodexHookResult> {
  if (!isObject(input)) throw new TypeError("Codex hook input must be a JSON object");
  const event = stringValue(input.hook_event_name) ?? stringValue(input.event_name);
  const cwd = stringValue(input.cwd);
  if (!event) throw new TypeError("Codex hook event name is missing");
  if (!cwd) throw new TypeError("Codex hook cwd is missing");
  const tracePath = event === "SubagentStop"
    ? stringValue(input.agent_transcript_path)
    : stringValue(input.transcript_path);
  if (!tracePath) {
    return {
      event,
      ignored:
        event === "SubagentStop"
          ? "agent_transcript_path missing"
          : "transcript_path missing",
    };
  }
  const shouldPoll = event === "Stop" || event === "SubagentStop";
  const requestedTurnId = stringValue(input.turn_id);
  if (
    !shouldPoll &&
    event !== "UserPromptSubmit" &&
    event !== "SessionEnd"
  ) {
    return { event, ignored: "event has no transcript catch-up work" };
  }
  const nativeSessionId = stringValue(input.session_id);
  if (!nativeSessionId) throw new TypeError("Codex hook session_id is missing");
  const projectRoot = resolve(cwd);
  await assertCodexHookTraceIdentity(
    tracePath,
    nativeSessionId,
    projectRoot,
  );
  const admission = await admitHookSession({
    projectRoot,
    provider: "codex",
    nativeSessionId,
    event,
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
  });
  if (!admission.joined) {
    // The session itself is never named: it has not consented to publish.
    await recordIncident({
      projectRoot,
      provider: "codex",
      kind: "session_dormant",
      event,
      dedupKey: nativeSessionId,
    });
    return { event, ignored: SESSION_NOT_JOINED };
  }
  const pollIntervalMs = positiveSafeInteger(
    options.pollIntervalMs ?? TERMINAL_INGEST_POLL_MS,
    "pollIntervalMs",
  );
  const timeoutMs = positiveSafeInteger(
    options.timeoutMs ?? TERMINAL_INGEST_TIMEOUT_MS,
    "timeoutMs",
  );
  // After admission on purpose: the marker names the session, so it may only
  // exist for a session that consented to publish.
  const finishAttempt = await beginIngestAttempt({
    projectRoot,
    provider: "codex",
    sessionId: createSessionId("codex", nativeSessionId),
    event,
  });

  const started = Date.now();
  try {
    while (true) {
      const traceResult = await runCodexTrace({
        tracePath,
        projectRoot,
        expectedNativeSessionId: nativeSessionId,
      });
      if (
        !shouldPoll ||
        terminalIngestReachedTarget(event, requestedTurnId, traceResult)
      ) {
        // Storage tolerates conflicts so one record cannot wedge publishing.
        // That tolerance is only safe if it is loud: an unreported conflict is
        // stale content published as success.
        if (traceResult.output.conflicted > 0) {
          await recordIncident({
            projectRoot,
            provider: "codex",
            kind: "hook_error",
            event,
            detail:
              `${traceResult.output.conflicted} derived record(s) recomputed ` +
              `with different canonical content; stored versions kept: ` +
              traceResult.output.conflicted_ids.join(", "),
          });
        }
        await finishAttempt("ok");
        return { event, trace_result: traceResult };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        throw new CodexTerminalIngestTimeoutError(event, timeoutMs);
      }
      await delay(Math.min(pollIntervalMs, timeoutMs - elapsed));
    }
  } catch (error) {
    await finishAttempt("error");
    throw error;
  }
}

async function assertCodexHookTraceIdentity(
  tracePath: string | undefined,
  nativeSessionId: string,
  projectRoot: string,
): Promise<void> {
  if (tracePath === undefined) return;
  let identity: Awaited<ReturnType<typeof readCodexTraceIdentity>>;
  try {
    identity = await readCodexTraceIdentity(tracePath);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new Error(`Codex trace does not exist: ${tracePath}`);
    }
    throw error;
  }
  if (identity === undefined) {
    throw new Error("Codex hook transcript has no bounded valid session_meta");
  }
  if (identity.nativeSessionId !== nativeSessionId) {
    throw new Error(
      "Codex hook session_id does not match transcript session_meta.session_id",
    );
  }
  if (
    identity.workspaceRoot !== undefined &&
    resolve(identity.workspaceRoot) !== projectRoot
  ) {
    throw new Error(
      "Codex hook cwd does not match transcript session_meta.cwd",
    );
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

/**
 * Codex fires several hooks per action, so concurrent writers are routine.
 * Every lease write above goes through `store.update`, whose decision runs
 * inside the actor lock — the read and the write are one critical section, so
 * a revision conflict cannot arise on this path and nothing here retries.
 */
export async function handleCodexHook(
  input: unknown,
): Promise<CodexHookResult> {
  return runCodexHook(input);
}

export async function handleCodexHookFailOpen(input: unknown): Promise<void> {
  const cwd = isObject(input) ? stringValue(input.cwd) : undefined;
  // Name the event. Logging every activity-hook failure as "unknown" makes the
  // log useless for exactly the debugging it exists for.
  const event = isObject(input)
    ? stringValue(input.hook_event_name) ?? stringValue(input.event_name) ?? "unknown"
    : "unknown";
  try {
    await handleCodexHook(input);
  } catch (error) {
    if (cwd) {
      await appendHookError(resolve(cwd), event, error).catch(() => undefined);
      await recordIncident({
        projectRoot: resolve(cwd),
        provider: "codex",
        kind: "hook_error",
        event,
        ...(sessionKeyFromHookInput(input) === undefined
          ? {}
          : { dedupKey: sessionKeyFromHookInput(input)! }),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function handleCodexIngestHookFailOpen(input: unknown): Promise<void> {
  const cwd = isObject(input) ? stringValue(input.cwd) : undefined;
  const event = isObject(input)
    ? stringValue(input.hook_event_name) ?? stringValue(input.event_name) ?? "unknown"
    : "unknown";
  try {
    await handleCodexIngestHook(input);
  } catch (error) {
    if (cwd) {
      await appendHookError(resolve(cwd), event, error).catch(() => undefined);
      await recordIncident({
        projectRoot: resolve(cwd),
        provider: "codex",
        kind: "hook_error",
        event,
        ...(sessionKeyFromHookInput(input) === undefined
          ? {}
          : { dedupKey: sessionKeyFromHookInput(input)! }),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function terminalIngestReachedTarget(
  event: string,
  requestedTurnId: string | undefined,
  result: RunCodexTraceResult,
): boolean {
  if (event === "Stop" && requestedTurnId) {
    return result.output.terminal_native_turn_ids.includes(requestedTurnId);
  }
  return (
    result.output.turns_appended +
      result.output.turns_skipped +
      result.output.evidence_appended +
      result.output.evidence_skipped >
    0
  );
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function classifyToolActivity(
  input: Record<string, unknown>,
  projectRoot: string,
): {
  readonly currentAction?: ActiveCurrentAction;
  readonly claims: readonly ActiveWriteClaim[];
  readonly unknownWriteScope: boolean;
} {
  const toolName = stringValue(input.tool_name) ?? "unknown";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const startedAt = new Date().toISOString();

  // v0.148 reports the canonical name exactly as `apply_patch`; `Edit` and
  // `Write` are matcher aliases only. Do not grant exact scope semantics to a
  // custom or MCP tool merely because its name contains a mutator substring.
  if (toolName === "apply_patch") {
    const patch = stringValue(toolInput.command) ?? "";
    const patchScope = extractPatchClaims(patch, projectRoot);
    const claims = patchScope.claims;
    return {
      currentAction: {
        kind: "file_change",
        tool_name: toolName,
        ...(claims.length === 1 ? { path: claims[0]!.path } : {}),
        started_at: startedAt,
      },
      claims,
      unknownWriteScope: patchScope.unknownWriteScope,
    };
  }

  // The pinned hook schema canonicalizes shell and unified-exec calls to Bash,
  // whose only stable command field is `command`.
  if (toolName === "Bash") {
    const command = stringValue(toolInput.command);
    return {
      currentAction: {
        kind: "command",
        tool_name: toolName,
        ...(command ? { command: boundedContent(command, ACTIVE_INTENT_BYTES) } : {}),
        started_at: startedAt,
      },
      claims: [],
      unknownWriteScope: true,
    };
  }

  if (READ_ONLY_CODEX_TOOLS_V0148.has(toolName)) {
    return {
      currentAction: {
        kind: "tool",
        tool_name: toolName,
        started_at: startedAt,
      },
      claims: [],
      unknownWriteScope: false,
    };
  }

  // Unknown local, extension, and MCP tools never receive a complete-scope
  // assertion. Validated conventional endpoints are useful advisory claims,
  // but cannot prove that the custom tool has no other side effects.
  const advisoryClaims = extractAdvisoryPathClaims(toolInput, projectRoot);

  return {
    currentAction: {
      kind: advisoryClaims.length > 0 ? "file_change" : "tool",
      tool_name: toolName,
      ...(advisoryClaims.length === 1
        ? { path: advisoryClaims[0]!.path }
        : {}),
      started_at: startedAt,
    },
    claims: advisoryClaims,
    unknownWriteScope: true,
  };
}

function extractPatchClaims(
  patch: string,
  projectRoot: string,
): {
  readonly claims: ActiveWriteClaim[];
  readonly unknownWriteScope: boolean;
} {
  const claims = new Map<string, ActiveWriteClaim>();
  let hasPathHeader = false;
  let hasUnresolvedTarget = false;
  const lines = patch.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fileHeader = /^\*\*\* (Add|Update|Delete) File:\s*(.*)$/.exec(line);
    if (fileHeader) {
      hasPathHeader = true;
      const operation = fileHeader[1]!;
      const sourceIsValid = addValidatedClaim(
        claims,
        fileHeader[2]!,
        projectRoot,
      );
      if (!sourceIsValid) hasUnresolvedTarget = true;

      const nextLine = lines[index + 1];
      if (operation === "Update" && nextLine?.startsWith("*** Move to:")) {
        index += 1;
        const destination = nextLine.slice("*** Move to:".length);
        const destinationIsValid = addValidatedClaim(
          claims,
          destination,
          projectRoot,
        );
        if (!sourceIsValid || !destinationIsValid) {
          hasUnresolvedTarget = true;
        }
      }
      continue;
    }

    // A destination without the immediately preceding Update source cannot
    // describe a complete move, even when the destination itself is safe.
    if (line.startsWith("*** Move to:")) {
      hasPathHeader = true;
      hasUnresolvedTarget = true;
      addValidatedClaim(
        claims,
        line.slice("*** Move to:".length),
        projectRoot,
      );
    }
  }
  return {
    claims: [...claims.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    unknownWriteScope: hasUnresolvedTarget || !hasPathHeader,
  };
}

function addValidatedClaim(
  claims: Map<string, ActiveWriteClaim>,
  rawPath: string,
  projectRoot: string,
): boolean {
  const path = normalizeRepoPath(projectRoot, rawPath.trim());
  if (!path) return false;
  if (!isGeneratedBarbaroPath(path)) {
    claims.set(path, { path, mode: "write", confidence: "exact" });
  }
  return true;
}

function extractAdvisoryPathClaims(
  toolInput: Record<string, unknown>,
  projectRoot: string,
): ActiveWriteClaim[] {
  const claims = new Map<string, ActiveWriteClaim>();
  for (const key of ["path", "destination"] as const) {
    const value = stringValue(toolInput[key]);
    if (!value) continue;
    const path = normalizeRepoPath(projectRoot, value);
    if (!path || isGeneratedBarbaroPath(path)) continue;
    claims.set(path, { path, mode: "write", confidence: "exact" });
  }
  return [...claims.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function boundedContent(text: string, maxBytes: number): ActiveContent {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return {
      text,
      fidelity: "verbatim",
      truncated: false,
      original_utf8_bytes: originalBytes,
      redactions: [],
    };
  }
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return {
    text: result,
    fidelity: "excerpt",
    truncated: true,
    original_utf8_bytes: originalBytes,
    redactions: [],
  };
}

async function appendHookError(
  projectRoot: string,
  event: string,
  error: unknown,
): Promise<void> {
  const filePath = join(projectRoot, ".barbaro", "logs", "hooks.jsonl");
  const record = {
    timestamp: new Date().toISOString(),
    provider: "codex",
    event,
    error: error instanceof Error ? error.message : String(error),
  };
  const bytes = Buffer.from(`${stableStringify(record)}\n`, "utf8");
  await withDirectoryLock(filePath, async () => {
    const location = safeStoreFileLocation(filePath);
    const target = await location.boundary.ensureParentForFile(
      location.relativeComponents,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        target,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`Unsafe Codex hook log path: ${target}`);
      }
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Codex hook log append made no forward progress");
        }
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
