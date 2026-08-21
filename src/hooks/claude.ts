import { stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  ActiveLeaseStore,
  deriveLeaseId,
} from "../active/index.js";
import type {
  ActiveContent,
  ActiveCurrentAction,
  ActiveLeaseUpdateResult,
  ActiveWriteClaim,
} from "../active/types.js";
import {
  excerptContent,
  isGeneratedBarbaroPath,
  normalizeRepoPath,
} from "../core/content.js";
import {
  fileIdentityEquals,
  readJsonlForward,
  resolveJsonlCheckpoint,
  type JsonlCheckpoint,
} from "../core/index.js";
import { createSessionId } from "../core/id.js";
import {
  classifyUserRecord,
  decodeClaudeEnvelope,
  decodeClaudeMessage,
} from "../providers/claude/records.js";
import {
  claudeRunnerStatePath,
  runClaudeTrace,
} from "../runner/claude.js";
import { readClaudeRunnerState } from "../runner/claude-state.js";
import {
  CLAUDE_FILE_CHANGE_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_SUBAGENT_TOOLS,
} from "../providers/claude/content.js";
import { beginIngestAttempt } from "./ingest-attempt.js";
import { admitHookSession, SESSION_NOT_JOINED } from "./participation.js";
import {
  projectRootFromHookInput,
  recordIncident,
  sessionKeyFromHookInput,
} from "./incidents.js";

const ACTIVE_INTENT_BYTES = 4_096;
const ACTIVE_COMMAND_BYTES = 512;
const SUBAGENT_INGEST_POLL_MS = 50;
const SUBAGENT_INGEST_TIMEOUT_MS = 10_000;
const TRAILING_TURN_TIMEOUT_MS = 4_000;
const USER_PROMPT_INGEST_TIMEOUT_MS = 2_000;
const NEXT_USER_PROMPT_NOT_YET_RECORDED =
  "next user prompt not yet recorded in transcript";

/**
 * Events that fire in the middle of Claude's post-turn write flurry, where a
 * snapshot is routinely refused because the file grew mid-read. These events
 * retry transient withholds for a bounded window. They do NOT wait for the
 * trailing turn to close: a turn that closes at EOF is withheld as
 * non-canonical regardless, because it can still absorb records — it
 * publishes once a later ingest sees its successor records, or at SessionEnd.
 *
 * SubagentStop is deliberately absent: it ingests the PARENT, whose turn is
 * still legitimately in flight. SessionEnd is absent because a quit mid-turn
 * never produces a terminal record.
 */
const TRAILING_TURN_WAIT_EVENTS: ReadonlySet<string> = new Set([
  "Stop",
  "StopFailure",
]);

/**
 * Withholdings that a few more milliseconds resolve, because they describe a
 * file still being written. Everything else the runner refuses — a pointerless
 * fork, malformed records, ambiguous tool results — is a stable judgement about
 * settled bytes, and polling it would only stall the hook to reach the same
 * answer.
 */
const TRANSIENT_WITHHOLD_REASONS: ReadonlySet<string> = new Set([
  "partial_final_line",
  "source_grew_during_ingest",
  "source_rewritten_during_ingest",
]);

export interface ClaudeHookResult {
  readonly event: string;
  readonly active_revision?: number;
  readonly ignored?: string;
}

/**
 * Map a Claude Code hook payload onto an advisory activity lease.
 *
 * The trace alone can only ever describe the past — it is written as work
 * completes. Leases are the present-tense half: they say what an actor appears
 * to be doing right now, so a peer can avoid colliding with in-flight work
 * instead of discovering the conflict after the fact.
 *
 * A claim is advisory. It confers no ownership and blocks no writer.
 */
export async function handleClaudeHook(
  input: unknown,
): Promise<ClaudeHookResult> {
  if (!isObject(input)) {
    throw new TypeError("Claude hook input must be a JSON object");
  }
  const event = stringValue(input.hook_event_name);
  const nativeSessionId = stringValue(input.session_id);
  const cwd = stringValue(input.cwd);
  if (!event) throw new TypeError("Claude hook hook_event_name is missing");
  if (!nativeSessionId) throw new TypeError("Claude hook session_id is missing");
  if (!cwd) throw new TypeError("Claude hook cwd is missing");

  const projectRoot = resolve(cwd);
  const admission = await admitHookSession({
    projectRoot,
    provider: "claude",
    nativeSessionId,
    event,
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
    ...(typeof input.command_name === "string"
      ? { commandName: input.command_name }
      : {}),
  });
  if (!admission.joined) {
    // The session itself is never named: it has not consented to publish.
    await recordIncident({
      projectRoot,
      provider: "claude",
      kind: "session_dormant",
      event,
      dedupKey: nativeSessionId,
    });
    return { event, ignored: SESSION_NOT_JOINED };
  }
  // Concurrent subagents each get their own actor file, so one agent's idle
  // tombstone can never clear another agent's in-flight claims.
  const agentId =
    stringValue(input.agent_id) ??
    stringValue(input.subagent_id) ??
    "main";
  const identity = {
    lease_id: deriveLeaseId("claude", nativeSessionId, agentId),
    provider: "claude",
    session_id: createSessionId("claude", nativeSessionId),
    agent_id: agentId,
  } as const;
  const store = new ActiveLeaseStore(join(projectRoot, ".barbaro", "active"));

  // Opportunistic hygiene, once per session: long-dead tombstones only
  // accumulate. The join event is the trigger that actually fires — sessions
  // start dormant and consent later, so a post-join SessionStart only happens
  // on resume. Failure here must never fail the event.
  if (admission.initiated || event === "SessionStart") {
    await store.reapExpiredIdle().catch(() => undefined);
  }

  // Every terminal event settles to idle. The tombstone is what stops a
  // delayed earlier hook from resurrecting stale activity.
  if (
    event === "SessionStart" ||
    event === "SessionEnd" ||
    event === "Stop" ||
    event === "StopFailure" ||
    event === "SubagentStop"
  ) {
    const lease = await store.writeIdle(identity);
    return { event, active_revision: lease.revision };
  }

  if (event === "SubagentStart") {
    // A subagent gets its own actor file, so its lifecycle can never clear
    // the parent's claims or a sibling's.
    const lease = await store.write({
      ...identity,
      state: "working",
      claims: [],
      unknown_write_scope: true,
    });
    return { event, active_revision: lease.revision };
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    // Parallel tools have independent PostToolUse events. Clearing the whole
    // lease here would falsely advertise sibling paths as free, so individual
    // completions are informational; PostToolBatch settles the aggregate.
    const previous = await store.readSnapshot(identity);
    if (!previous) return { event, ignored: "no lease to clean up" };
    if (previous.state === "idle") {
      return { event, ignored: "stale event after idle" };
    }
    return { event, ignored: "claim retained until PostToolBatch" };
  }

  if (event === "PostToolBatch") {
    const settled = await store.update(identity, (previous) => {
      if (!previous) return { ignore: "no lease to clean up" };
      if (previous.state === "idle") {
        return { ignore: "stale event after idle" };
      }
      return {
        write: {
          ...identity,
          state: "working",
          ...(previous.intent ? { intent: previous.intent } : {}),
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    return updateHookResult(event, settled);
  }

  if (event === "UserPromptSubmit" || event === "UserPromptExpansion") {
    const prompt = stringValue(input.prompt) ?? "";
    const intent: ActiveContent = excerptContent(prompt, ACTIVE_INTENT_BYTES);
    const lease = await store.write({
      ...identity,
      state: "working",
      intent,
      // A new prompt supersedes whatever the previous turn was touching.
      claims: [],
      unknown_write_scope: false,
    });
    return { event, active_revision: lease.revision };
  }

  if (event === "PreToolUse") {
    const toolName = stringValue(input.tool_name);
    if (!toolName) return { event, ignored: "missing tool_name" };
    const toolInput = isObject(input.tool_input) ? input.tool_input : {};
    const scope = describeToolScope(toolName, toolInput, projectRoot);
    if (!scope) return { event, ignored: "generated barbaro output" };
    const settled = await store.update(identity, (previous) => {
      // A tool hook that lands after the turn settled is stale. Writing it
      // would resurrect an idle actor and advertise work that already stopped.
      if (previous?.state === "idle") {
        return { ignore: "stale event after idle" };
      }
      return {
        write: {
          ...identity,
          state: "working",
          ...(previous?.intent ? { intent: previous.intent } : {}),
          current_action: scope.action,
          claims: mergeClaims(previous?.claims ?? [], scope.claims),
          unknown_write_scope:
            previous?.unknown_write_scope === true || scope.unknownWriteScope,
        },
      };
    });
    return updateHookResult(event, settled);
  }

  return { event, ignored: "event does not affect activity" };
}

function updateHookResult(
  event: string,
  settled: ActiveLeaseUpdateResult,
): ClaudeHookResult {
  return settled.lease !== undefined
    ? { event, active_revision: settled.lease.revision }
    : { event, ignored: settled.ignored ?? "update ignored" };
}

/**
 * Events that re-ingest the parent bundle.
 *
 * `SubagentStop` fires when a child stops, which is BEFORE the parent records
 * the task notification that attests an `async_launched` child's completion.
 * It is kept because it can publish other, already-attested children — but it
 * is not sufficient on its own, which is why the later events are here too.
 * `UserPromptSubmit` and `SessionEnd` are the catch-up path for a child that
 * finishes after the parent's own Stop.
 */
export const CATCH_UP_INGEST_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "TaskCompleted",
  "UserPromptExpansion",
  "UserPromptSubmit",
  "SessionEnd",
]);

export interface ClaudeIngestHookResult {
  readonly event: string;
  readonly ingested?: Awaited<ReturnType<typeof runClaudeTrace>>;
  readonly ignored?: string;
}

export interface ClaudeIngestHookOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  /**
   * UserPromptSubmit fires before Claude appends the corresponding `user`
   * record. Wait only this long for that semantic boundary before returning a
   * quiet not-yet. The publishing runner is not called on timeout.
   */
  readonly userPromptTimeoutMs?: number;
  /**
   * How long a terminal-turn event waits for its own closing record. Bounded
   * well inside the hook timeout: a late feed is a nuisance, a hook that
   * outlives its budget is a stalled turn.
   */
  readonly trailingTimeoutMs?: number;
  /** Test seams for deterministic polling; production uses the system clock. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class ClaudeSubagentIngestTimeoutError extends Error {
  constructor(agentId: string, timeoutMs: number) {
    super(
      `Claude subagent ${agentId} did not reach a trace-attested completion within ${timeoutMs} ms`,
    );
    this.name = "ClaudeSubagentIngestTimeoutError";
  }
}

/**
 * Stop-hook ingestion: the turn has just ended, so the trace is final and the
 * bundle can be normalized and published.
 *
 * `transcript_path` names the session file. A subagent transcript is ignored
 * here; children are ingested as part of their parent's bundle so a parent
 * rollup is never published before the children it summarizes.
 */
export async function handleClaudeIngestHook(
  input: unknown,
  options: ClaudeIngestHookOptions = {},
): Promise<ClaudeIngestHookResult> {
  if (!isObject(input)) {
    throw new TypeError("Claude hook input must be a JSON object");
  }
  const event = stringValue(input.hook_event_name) ?? "Stop";
  const cwd = stringValue(input.cwd);
  if (!cwd) throw new TypeError("Claude hook cwd is missing");
  if (!CATCH_UP_INGEST_EVENTS.has(event)) {
    return { event, ignored: "event does not trigger ingestion" };
  }
  const nativeSessionId = stringValue(input.session_id);
  if (!nativeSessionId) throw new TypeError("Claude hook session_id is missing");
  const projectRoot = resolve(cwd);
  const admission = await admitHookSession({
    projectRoot,
    provider: "claude",
    nativeSessionId,
    event,
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
    ...(typeof input.command_name === "string"
      ? { commandName: input.command_name }
      : {}),
  });
  if (!admission.joined) {
    // The session itself is never named: it has not consented to publish.
    await recordIncident({
      projectRoot,
      provider: "claude",
      kind: "session_dormant",
      event,
      dedupKey: nativeSessionId,
    });
    return { event, ignored: SESSION_NOT_JOINED };
  }
  const transcriptPath = stringValue(input.transcript_path);
  if (!transcriptPath) return { event, ignored: "no transcript_path" };

  // A subagent transcript is never ingested on its own: children publish as
  // part of their parent's bundle so a rollup is never frozen incomplete.
  // SubagentStop instead re-ingests the PARENT, which is exactly when a
  // previously withheld child becomes publishable.
  const unresolvedTracePath = basename(transcriptPath).startsWith("agent-")
    ? parentSessionTrace(transcriptPath)
    : transcriptPath;
  if (!unresolvedTracePath) {
    return { event, ignored: "no parent session for this subagent transcript" };
  }
  const tracePath = resolve(unresolvedTracePath);

  // A brand-new session's join fires before Claude Code flushes the
  // transcript's first bytes, so a missing file here is a normal transient
  // state, not an error: the next event re-reads and the file will exist.
  try {
    await stat(tracePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { event, ignored: "transcript not yet on disk" };
    }
    throw error;
  }

  const targetAgentId =
    event === "SubagentStop" ? stringValue(input.agent_id) : undefined;
  const timeoutMs = options.timeoutMs ?? SUBAGENT_INGEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SUBAGENT_INGEST_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const deadline = now() + timeoutMs;
  const waitsForTrailingTurn = TRAILING_TURN_WAIT_EVENTS.has(event);
  const trailingDeadline =
    now() + (options.trailingTimeoutMs ?? TRAILING_TURN_TIMEOUT_MS);
  const userPromptDeadline =
    now() + (options.userPromptTimeoutMs ?? USER_PROMPT_INGEST_TIMEOUT_MS);

  // Claude invokes UserPromptSubmit before it appends that prompt to the
  // transcript. Running the publisher immediately consumes the old EOF,
  // withholds its still-trailing turn, and moves the checkpoint there; the
  // previous turn then stays invisible until the *following* Stop. Poll the
  // bytes after the persisted checkpoint read-only, and proceed only once a
  // genuine human prompt appears. Mode and file-history rows may grow the
  // file, but cannot close a turn and therefore cannot satisfy this wait.
  if (event === "UserPromptSubmit") {
    const promptWait = await waitForNextUserPrompt({
      tracePath,
      projectRoot,
      deadline: userPromptDeadline,
      pollIntervalMs,
      now,
      sleep,
    });
    if (promptWait !== "ready") {
      // A quiet not-yet is expected hook timing, not an ingest failure. In
      // particular, do not call runClaudeTrace: even an output-empty stable
      // replay advances its checkpoint and would falsely consume this gap.
      return {
        event,
        ignored:
          promptWait === "timeout"
            ? NEXT_USER_PROMPT_NOT_YET_RECORDED
            : "prior transcript checkpoint changed while waiting for prompt",
      };
    }
  }

  // After admission on purpose: the marker names the session, so it may only
  // exist for a session that consented to publish.
  const finishAttempt = await beginIngestAttempt({
    projectRoot,
    provider: "claude",
    sessionId: createSessionId("claude", nativeSessionId),
    event,
  });

  try {
    while (true) {
      const ingested = await runClaudeTrace({
        tracePath,
        projectRoot,
        // The turn reached its terminal record, so it may close. Whether the
        // branch pointer has been written is a separate question, and only
        // SessionEnd (or an offline parse) can answer it.
        final: true,
        sourceFinal: event === "SessionEnd",
      });
      // SubagentStop itself precedes the task-notification record that proves
      // an async child complete. In an async command hook, polling lets Claude
      // return from SubagentStop and write that record; canonical output still
      // depends only on the trace, never on the hook assertion.
      const subagentSettled =
        targetAgentId === undefined ||
        ingested.subagents.ready_agent_ids.includes(targetAgentId);
      // Two ways this turn can still be unpublished, and both resolve on their
      // own within milliseconds: its closing record is not written yet, or the
      // file grew mid-read and the snapshot was refused. Waiting costs a hook a
      // few polls; not waiting costs every reader a turn of staleness.
      const stillBeingWritten =
        ingested.input.withheld_reason !== undefined &&
        TRANSIENT_WITHHOLD_REASONS.has(ingested.input.withheld_reason);
      // The trailing turn is withheld until it can no longer grow, so waiting
      // for it to close buys nothing — the only thing worth a retry here is a
      // snapshot the runner refused because the file was mid-write, which
      // hook-time write flurries make routine.
      const retriesTransientSnapshot =
        waitsForTrailingTurn || event === "UserPromptSubmit";
      const transientDeadline =
        event === "UserPromptSubmit" ? userPromptDeadline : trailingDeadline;
      const turnSettled =
        !retriesTransientSnapshot ||
        now() >= transientDeadline ||
        !stillBeingWritten;
      if (subagentSettled && turnSettled) {
        // A conflict no longer aborts the run, so without this it would
        // vanish: publishing continued, but a record the producer recomputed
        // differently is a determinism defect that still has to surface.
        if (ingested.output.conflicted > 0) {
          await recordIncident({
            projectRoot,
            provider: "claude",
            kind: "hook_error",
            event,
            detail:
              `${ingested.output.conflicted} derived record(s) recomputed ` +
              `with different canonical content; stored versions kept: ` +
              ingested.output.conflicted_ids.join(", "),
          });
        }
        await finishAttempt("ok");
        return { event, ingested };
      }
      if (
        targetAgentId !== undefined &&
        !subagentSettled &&
        now() >= deadline
      ) {
        // Claude fires SubagentStop for background tasks too — a Monitor or a
        // detached Bash run — and those have no subagent transcript and never
        // will. Waiting for a trace-attested completion that cannot arrive is
        // not a timeout, it is a category error, and reporting it as failure
        // buries real subagent timeouts in noise.
        //
        // The parent trace decides: a genuine child is announced there and so
        // appears as pending. An agent id in neither list was never a subagent
        // of ours.
        if (!ingested.subagents.pending_agent_ids.includes(targetAgentId)) {
          await finishAttempt("ok");
          return { event, ingested };
        }
        throw new ClaudeSubagentIngestTimeoutError(targetAgentId, timeoutMs);
      }
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    await finishAttempt("error");
    throw error;
  }
}

interface UserPromptWaitOptions {
  readonly tracePath: string;
  readonly projectRoot: string;
  readonly deadline: number;
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Wait until the source itself contains the UserPromptSubmit boundary.
 *
 * The prior successful runner checkpoint is the watermark. It is intentionally
 * read rather than updated here: a timeout must leave the exact same source
 * position for the next hook. A session with no checkpoint preserves the old
 * one-shot behavior; an existing checkpoint that loses identity is not safe to
 * substitute and returns a quiet boundary-lost result.
 */
async function waitForNextUserPrompt(
  options: UserPromptWaitOptions,
): Promise<"ready" | "timeout" | "boundary-lost"> {
  const boundary = await priorClaudeCheckpoint(
    options.tracePath,
    options.projectRoot,
  );
  if (boundary.kind === "none") return "ready";
  if (boundary.kind === "lost") return "boundary-lost";
  const checkpoint = boundary.checkpoint;

  const pollIntervalMs = Math.max(1, options.pollIntervalMs);

  while (true) {
    const probe = await promptAfterCheckpoint(options.tracePath, checkpoint);
    if (probe === "found") return "ready";
    if (probe === "boundary-lost") return "boundary-lost";
    if (options.now() >= options.deadline) return "timeout";
    const remaining = Math.max(1, options.deadline - options.now());
    await options.sleep(Math.min(pollIntervalMs, remaining));
  }
}

async function priorClaudeCheckpoint(
  tracePath: string,
  projectRoot: string,
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "lost" }
  | { readonly kind: "usable"; readonly checkpoint: JsonlCheckpoint }
> {
  const statePath = claudeRunnerStatePath(
    tracePath,
    join(projectRoot, ".barbaro"),
  );
  const saved = await readClaudeRunnerState(statePath);
  if (saved === undefined) return { kind: "none" };
  const resolution = await resolveJsonlCheckpoint(tracePath, saved.checkpoint);
  return resolution.status === "resume"
    ? { kind: "usable", checkpoint: saved.checkpoint }
    : { kind: "lost" };
}

async function promptAfterCheckpoint(
  tracePath: string,
  checkpoint: JsonlCheckpoint,
): Promise<"found" | "not-yet" | "boundary-lost"> {
  const resolution = await resolveJsonlCheckpoint(tracePath, checkpoint);
  if (resolution.status !== "resume" || resolution.snapshot === undefined) {
    return "boundary-lost";
  }

  let found = false;
  let summary: Awaited<ReturnType<typeof readJsonlForward>>;
  try {
    summary = await readJsonlForward(
      tracePath,
      (line) => {
        if (found || line.kind === "malformed") return;
        const decoded = decodeClaudeEnvelope(line.value);
        if (!decoded.ok) return;
        const message = decodeClaudeMessage(decoded.envelope.raw);
        if (classifyUserRecord(decoded.envelope, message).kind === "human") {
          found = true;
        }
      },
      {
        startOffset: checkpoint.byte_offset,
        nextLineNumber: checkpoint.next_line_number,
        endOffset: resolution.snapshot.size,
      },
    );
  } catch (error) {
    // Rotation or truncation between resolving and opening is still the same
    // quiet lost-boundary condition. Preserve real reader failures when the
    // checkpoint remains valid so corruption and permission errors surface.
    const afterFailure = await resolveJsonlCheckpoint(tracePath, checkpoint);
    if (afterFailure.status !== "resume") return "boundary-lost";
    throw error;
  }
  if (!fileIdentityEquals(summary.fileIdentity, resolution.snapshot.identity)) {
    return "boundary-lost";
  }
  const afterRead = await resolveJsonlCheckpoint(tracePath, checkpoint);
  if (afterRead.status !== "resume") return "boundary-lost";
  return found ? "found" : "not-yet";
}

/** Hooks must never block a coding turn, so every failure is swallowed. */
export async function handleClaudeHookFailOpen(input: unknown): Promise<void> {
  try {
    await handleClaudeHook(input);
  } catch (error) {
    // Silent to the turn, but not silent to the store: a swallowed error that
    // leaves no trace is indistinguishable from working.
    await noteHookFailure(input, error);
  }
}

export async function handleClaudeIngestHookFailOpen(
  input: unknown,
): Promise<void> {
  try {
    await handleClaudeIngestHook(input);
  } catch (error) {
    // Ingestion is derived data. A failure here must never fail the turn that
    // produced the trace; the next run replays the file in full anyway.
    await noteHookFailure(input, error);
  }
}

async function noteHookFailure(input: unknown, error: unknown): Promise<void> {
  const projectRoot = projectRootFromHookInput(input);
  if (projectRoot === undefined) return;
  await recordIncident({
    projectRoot,
    provider: "claude",
    kind: "hook_error",
    ...(typeof (input as { hook_event_name?: unknown })?.hook_event_name ===
    "string"
      ? { event: (input as { hook_event_name: string }).hook_event_name }
      : {}),
    ...(sessionKeyFromHookInput(input) === undefined
      ? {}
      : { dedupKey: sessionKeyFromHookInput(input)! }),
    detail: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Map a subagent trace path back to its parent session file:
 * `<project>/<session>/subagents/.../agent-<id>.jsonl` becomes
 * `<project>/<session>.jsonl`. Returns undefined when the path is not shaped
 * like a subagent trace, rather than guessing.
 */
export function parentSessionTrace(
  subagentTracePath: string,
): string | undefined {
  const marker = `${sep}subagents${sep}`;
  const index = subagentTracePath.lastIndexOf(marker);
  if (index === -1) return undefined;
  return `${subagentTracePath.slice(0, index)}.jsonl`;
}

interface ToolScope {
  readonly action: ActiveCurrentAction;
  readonly claims: readonly ActiveWriteClaim[];
  readonly unknownWriteScope: boolean;
}

function mergeClaims(
  previous: readonly ActiveWriteClaim[],
  added: readonly ActiveWriteClaim[],
): ActiveWriteClaim[] {
  const byKey = new Map<string, ActiveWriteClaim>();
  for (const claim of [...previous, ...added]) {
    byKey.set(`${claim.path}\0${claim.mode}\0${claim.confidence}`, claim);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, claim]) => claim);
}

function describeToolScope(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectRoot: string,
): ToolScope | undefined {
  if (CLAUDE_FILE_CHANGE_TOOLS.has(toolName)) {
    const raw = stringValue(toolInput.file_path);
    const path = raw ? normalizeRepoPath(projectRoot, raw) : undefined;
    if (path && isGeneratedBarbaroPath(path)) return undefined;
    return {
      action: {
        kind: "file_change",
        tool_name: toolName,
        ...(path === undefined ? {} : { path }),
      },
      // An edit names its target exactly; an out-of-workspace target cannot be
      // expressed as a repo path, so it is reported as unknown scope instead.
      claims: path ? [{ path, mode: "write", confidence: "exact" }] : [],
      unknownWriteScope: path === undefined,
    };
  }

  if (toolName === "Bash") {
    const command = stringValue(toolInput.command) ?? "";
    return {
      action: {
        kind: "command",
        tool_name: toolName,
        command: excerptContent(command, ACTIVE_COMMAND_BYTES),
      },
      // A shell command's write set is not statically knowable. The contract
      // requires saying so rather than inventing paths.
      claims: [],
      unknownWriteScope: true,
    };
  }

  if (CLAUDE_SUBAGENT_TOOLS.has(toolName)) {
    return {
      action: { kind: "tool", tool_name: toolName },
      claims: [],
      unknownWriteScope: true,
    };
  }

  if (CLAUDE_READ_ONLY_TOOLS.has(toolName) || toolName.startsWith("mcp__")) {
    return {
      action: { kind: "tool", tool_name: toolName },
      claims: [],
      unknownWriteScope: !CLAUDE_READ_ONLY_TOOLS.has(toolName),
    };
  }

  // An unrecognized tool may write anywhere. Claiming otherwise would tell a
  // peer a path is free when nothing established that.
  return {
    action: { kind: "tool", tool_name: toolName },
    claims: [],
    unknownWriteScope: true,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
