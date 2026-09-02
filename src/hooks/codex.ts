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
  ActiveExtensions,
  ActiveLeaseUpdateResult,
  ActiveLeaseV1,
  ActiveLeaseUpdate,
  ActiveWriteClaim,
} from "../active/types.js";
import { createSessionId, createTurnId } from "../core/id.js";
import {
  classifyAwaitCommand,
  isDigestExcludedBarbaroCommand,
  isLeadingBarbaroContextCommand,
  type AwaitCommandClassification,
} from "../core/barbaro-command.js";
import { safeStoreFileLocation } from "../core/safe-store.js";
import { stableStringify } from "../core/stable-json.js";
import {
  advanceHookReadCursor,
  claimHookNudgeDelivery,
  rollbackHookStopClaim,
  stopReasonForNudge,
  type HookNudgeDelivery,
} from "../nudge/index.js";
import { withDirectoryLock } from "../output/directory-lock.js";
import {
  isGeneratedBarbaroPath,
  normalizeRepoPath,
} from "../providers/codex/content.js";
import {
  readCodexTraceIdentity,
  readCodexTurnAttestation,
  readCodexTurnStartedAt,
  runCodexTrace,
  type RunCodexTraceResult,
} from "../runner/codex.js";
import { beginIngestAttempt } from "./ingest-attempt.js";
import {
  admitHookSession,
  parseBarbaroInvocation,
  SESSION_NOT_JOINED,
  WORKSTREAM_SELECTION_PENDING,
} from "./participation.js";
import {
  projectRootFromHookInput,
  recordIncident,
  sessionKeyFromHookInput,
} from "./incidents.js";

const ACTIVE_INTENT_BYTES = 4_096;
const TERMINAL_INGEST_POLL_MS = 50;
const TERMINAL_INGEST_TIMEOUT_MS = 10_000;
const STOP_CONTINUATION_EXTENSION = "barbaro_stop_continuation";
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
  readonly nudge?: HookNudgeDelivery;
  readonly stop_reason?: string;
  /**
   * Outcome of a join-related invocation (roster, confirmation, refusal).
   * Only UserPromptSubmit with a leading Barbaro invocation carries one.
   */
  readonly message?: string;
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
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  const tracePath = stringValue(input.transcript_path);
  const agentTracePath = stringValue(input.agent_transcript_path);
  const nativeTurnId = stringValue(input.turn_id);
  if (event === "UserPromptSubmit") {
    await assertCodexHookTraceIdentity(
      tracePath,
      nativeSessionId,
      projectRoot,
    );
  }
  const admissionNow = await codexMembershipEffectiveAt({
    event,
    projectRoot,
    ...(prompt === undefined ? {} : { prompt }),
    ...(tracePath === undefined ? {} : { tracePath }),
    ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
  });
  const admission = await admitHookSession({
    projectRoot,
    provider: "codex",
    nativeSessionId,
    event,
    ...(prompt === undefined ? {} : { prompt }),
    ...(admissionNow === undefined ? {} : { now: admissionNow }),
  });
  if (!admission.joined) {
    // A bare or refused invocation is the user addressing Barbaro, not a
    // dormant hook firing: surface the outcome, write nothing, and record no
    // incident. Every other event in an unjoined session is the dormant case,
    // and the session itself is never named: it has not consented to publish.
    if (admission.pending === undefined && admission.refused === undefined) {
      await recordIncident({
        projectRoot,
        provider: "codex",
        kind: "session_dormant",
        event,
        dedupKey: nativeSessionId,
      });
      return { event, ignored: SESSION_NOT_JOINED };
    }
    return {
      event,
      ignored:
        admission.pending !== undefined
          ? WORKSTREAM_SELECTION_PENDING
          : (admission.refused ?? SESSION_NOT_JOINED),
      ...(admission.message === undefined ? {} : { message: admission.message }),
    };
  }
  const workstreamId = admission.participation?.workstream_id;
  const note =
    admission.message === undefined ? {} : { message: admission.message };
  const observeCommittedLockRelease = async (
    resource: "active lease" | "nudge cursor",
    error: unknown,
  ): Promise<void> => {
    await recordIncident({
      projectRoot,
      provider: "codex",
      kind: "hook_error",
      event,
      dedupKey: `${nativeSessionId}:${resource}:lock-release`,
      detail:
        `${resource} lock release failed after commit: ` +
        (error instanceof Error ? error.message : String(error)),
    }).catch(() => undefined);
  };
  const sessionId = createSessionId("codex", nativeSessionId);
  const nativeAgentId = stringValue(input.agent_id);
  if (
    (event === "SubagentStart" || event === "SubagentStop") &&
    nativeAgentId === undefined
  ) {
    throw new TypeError(`Codex ${event} agent_id is missing`);
  }
  const agentId = nativeAgentId ?? stringValue(input.agent_path) ?? "main";
  const turnId = nativeTurnId
    ? createTurnId("codex", nativeSessionId, agentId, nativeTurnId)
    : undefined;
  const leaseIdentity = {
    lease_id: deriveLeaseId("codex", nativeSessionId, agentId),
    provider: "codex",
    session_id: sessionId,
    agent_id: agentId,
    ...(workstreamId === undefined ? {} : { workstream_id: workstreamId }),
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
      const stale = await staleSubagentStartIgnore(
        store,
        leaseIdentity,
        previous,
        turnId,
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
      const own = staleTurnDecision(previous, turnId);
      const stale =
        own === undefined
          ? undefined
          : await attestCodexTurnRollover(
              {
                previous,
                eventTurnId: turnId,
                nativeTurnId,
                tracePath: agentTracePath,
                nativeSessionId,
                projectRoot,
                agentId,
              },
              own,
            );
      if (stale) return stale;
      return { write: idleLeaseUpdate(leaseIdentity) };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "UserPromptSubmit") {
    const prompt = stringValue(input.prompt) ?? "";
    const settled = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleUserPromptIgnore(
        store,
        leaseIdentity,
        previous,
        turnId,
      );
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          intent: boundedContent(prompt, ACTIVE_INTENT_BYTES),
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    const result = codexUpdateResult(event, settled);
    const nudge =
      agentId === "main" &&
      result.active_revision !== undefined &&
      turnId !== undefined
      ? await claimHookNudgeDelivery({
          projectRoot,
          provider: "codex",
          nativeSessionId,
          marker: "user_prompt",
          turn: { kind: "codex", turn_id: turnId },
          onLockReleaseFailure: (error) =>
            observeCommittedLockRelease("nudge cursor", error),
        })
      : undefined;
    return {
      ...result,
      ...note,
      ...(nudge === undefined ? {} : { nudge }),
    };
  }

  if (event === "PreToolUse") {
    const activity = classifyToolActivity(input, projectRoot);
    const settled = await store.update(
      leaseIdentity,
      async (previous) => {
        const stale = await staleToolTurnDecision({
          store,
          actor: leaseIdentity,
          previous,
          eventTurnId: turnId,
          nativeTurnId,
          tracePath,
          nativeSessionId,
          projectRoot,
          agentId,
        });
        if (stale) return stale;
        const update: ActiveLeaseUpdate = {
          ...leaseIdentity,
          state: activity.awaitCommand === undefined ? "working" : "waiting",
          ...sameTurnIntentUpdate(previous, turnId),
          ...sameTurnExtensionUpdate(previous, turnId),
          ...(activity.currentAction
            ? { current_action: activity.currentAction }
            : {}),
          claims: activity.claims,
          unknown_write_scope: activity.unknownWriteScope,
        };
        return { write: update };
      },
      activity.awaitCommand === undefined
        ? {}
        : { ttlMs: activity.awaitCommand.leaseTtlMs },
    );
    const result = codexUpdateResult(event, settled);
    if (agentId !== "main" || result.active_revision === undefined) {
      return result;
    }
    if (activity.contextCommand === true) {
      await advanceHookReadCursor({
        projectRoot,
        provider: "codex",
        nativeSessionId,
        onLockReleaseFailure: (error) =>
          observeCommittedLockRelease("nudge cursor", error),
      });
      return result;
    }
    if (turnId === undefined) return result;
    const nudge = await claimHookNudgeDelivery({
      projectRoot,
      provider: "codex",
      nativeSessionId,
      marker: "tool_boundary",
      turn: { kind: "codex", turn_id: turnId },
      onLockReleaseFailure: (error) =>
        observeCommittedLockRelease("nudge cursor", error),
    });
    return { ...result, ...(nudge === undefined ? {} : { nudge }) };
  }

  if (event === "PermissionRequest") {
    const requestedActivity = classifyToolActivity(input, projectRoot);
    const settled = await store.update(
      leaseIdentity,
      async (previous) => {
        const stale = await staleToolTurnDecision({
          store,
          actor: leaseIdentity,
          previous,
          eventTurnId: turnId,
          nativeTurnId,
          tracePath,
          nativeSessionId,
          projectRoot,
          agentId,
        });
        if (stale) return stale;
        const sameTurn =
          turnId !== undefined && previous?.turn_id === turnId;
        const activity =
          sameTurn && previous.current_action !== undefined
            ? {
                currentAction: previous.current_action,
                claims:
                  requestedActivity.awaitCommand === undefined
                    ? previous.claims
                    : requestedActivity.claims,
                unknownWriteScope:
                  requestedActivity.awaitCommand === undefined
                    ? previous.unknown_write_scope
                    : requestedActivity.unknownWriteScope,
              }
            : requestedActivity;
        return {
          write: {
            ...leaseIdentity,
            state: "waiting",
            ...(sameTurn && previous.intent ? { intent: previous.intent } : {}),
            ...sameTurnExtensionUpdate(previous, turnId),
            ...(activity.currentAction
              ? { current_action: activity.currentAction }
              : {}),
            claims: activity.claims,
            unknown_write_scope: activity.unknownWriteScope,
          },
        };
      },
      requestedActivity.awaitCommand === undefined
        ? {}
        : { ttlMs: requestedActivity.awaitCommand.leaseTtlMs },
    );
    return codexUpdateResult(event, settled);
  }

  if (event === "PostToolUse") {
    const settled = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleToolTurnDecision({
        store,
        actor: leaseIdentity,
        previous,
        eventTurnId: turnId,
        nativeTurnId,
        tracePath,
        nativeSessionId,
        projectRoot,
        agentId,
      });
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          ...sameTurnIntentUpdate(previous, turnId),
          ...sameTurnExtensionUpdate(previous, turnId),
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    const result = codexUpdateResult(event, settled);
    const nudge =
      agentId === "main" &&
      result.active_revision !== undefined &&
      turnId !== undefined
        ? await claimHookNudgeDelivery({
            projectRoot,
            provider: "codex",
            nativeSessionId,
            marker: "tool_boundary",
            turn: { kind: "codex", turn_id: turnId },
            onLockReleaseFailure: (error) =>
              observeCommittedLockRelease("nudge cursor", error),
          })
        : undefined;
    return { ...result, ...(nudge === undefined ? {} : { nudge }) };
  }

  if (event === "PreCompact") {
    const settled = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleToolTurnDecision({
        store,
        actor: leaseIdentity,
        previous,
        eventTurnId: turnId,
        nativeTurnId,
        tracePath,
        nativeSessionId,
        projectRoot,
        agentId,
      });
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          ...(previous?.intent ? { intent: previous.intent } : {}),
          ...sameTurnExtensionUpdate(previous, turnId),
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
    const settled = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleToolTurnDecision({
        store,
        actor: leaseIdentity,
        previous,
        eventTurnId: turnId,
        nativeTurnId,
        tracePath,
        nativeSessionId,
        projectRoot,
        agentId,
      });
      if (stale) return stale;
      return {
        write: {
          ...leaseIdentity,
          state: "working",
          ...(previous?.intent ? { intent: previous.intent } : {}),
          ...sameTurnExtensionUpdate(previous, turnId),
          claims: [],
          unknown_write_scope: false,
        },
      };
    });
    return codexUpdateResult(event, settled);
  }

  if (event === "Stop") {
    let priorIntent: ActiveContent | undefined;
    const stopped = await store.update(leaseIdentity, async (previous) => {
      const stale = await staleMainTurnDecision({
        previous,
        eventTurnId: turnId,
        nativeTurnId,
        tracePath,
        nativeSessionId,
        projectRoot,
        agentId,
      });
      if (stale) return stale;
      // A trace-attested goal continuation has no UserPromptSubmit from which
      // to capture its intent. Do not mislabel that turn with the prior user
      // prompt when a Stop nudge reopens it.
      priorIntent =
        previous !== undefined && previous.turn_id === turnId
          ? previous.intent
          : undefined;
      return { write: idleLeaseUpdate(leaseIdentity) };
    });
    const stoppedResult = codexUpdateResult(event, stopped);
    if (
      stopped.lease === undefined ||
      agentId !== "main" ||
      turnId === undefined ||
      input.stop_hook_active === true
    ) {
      return stoppedResult;
    }
    // Hold the actor lock while claiming the cursor. This couples the Stop
    // latch to the continuation that emits it: newer activity either wins
    // before this update (and no marker is claimed) or follows the reopened
    // lease (after this hook has committed to blocking).
    const stoppedRevision = stopped.lease.revision;
    let nudge: Awaited<ReturnType<typeof claimHookNudgeDelivery>>;
    const continued = await store.update(
      leaseIdentity,
      async (current) => {
        if (
          current?.state !== "idle" ||
          current.revision !== stoppedRevision
        ) {
          return { ignore: "newer activity superseded Stop continuation" };
        }
        nudge = await claimHookNudgeDelivery({
          projectRoot,
          provider: "codex",
          nativeSessionId,
          marker: "stop",
          turn: { kind: "codex", turn_id: turnId },
          onLockReleaseFailure: (error) =>
            observeCommittedLockRelease("nudge cursor", error),
        });
        if (nudge === undefined) {
          return { ignore: "no Stop nudge required" };
        }
        return {
          write: {
            ...leaseIdentity,
            state: "working",
            ...(priorIntent ? { intent: priorIntent } : {}),
            extensions: stopContinuationExtensions(turnId),
            claims: [],
            unknown_write_scope: false,
          },
        };
      },
      {
        onWriteFailure: async () => {
          if (nudge?.stop_rollback !== undefined) {
            await rollbackHookStopClaim({
              projectRoot,
              receipt: nudge.stop_rollback,
              onLockReleaseFailure: (error) =>
                observeCommittedLockRelease("nudge cursor", error),
            });
          }
        },
        onLockReleaseFailure: (error) =>
          observeCommittedLockRelease("active lease", error),
      },
    );
    if (nudge !== undefined && continued.lease !== undefined) {
      return {
        ...codexUpdateResult(event, continued),
        stop_reason: stopReasonForNudge(
          nudge,
          stringValue(input.last_assistant_message),
        ),
      };
    }
    return stoppedResult;
  }

  return { event, ignored: "unsupported hook event" };
}

/** Serialize only stdout shapes accepted by the pinned Codex hook schema. */
export function renderCodexHookOutput(
  result: CodexHookResult | undefined,
): string {
  if (result?.stop_reason !== undefined) {
    return `${stableStringify({
      decision: "block",
      reason: result.stop_reason,
    })}\n`;
  }
  if (result?.nudge !== undefined) {
    return `${stableStringify({
      hookSpecificOutput: {
        hookEventName: result.event,
        additionalContext: result.nudge.text,
      },
    })}\n`;
  }
  return "";
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
 * Codex goal continuations and reused child threads do not necessarily fire a
 * fresh prompt or SubagentStart. Their next boundary can therefore arrive
 * while the actor still names its preceding turn. Rollover is accepted only
 * when one validated rollout snapshot names this native turn as its latest
 * task_started record.
 */
interface CodexTurnDecisionOptions {
  readonly previous: ActiveLeaseV1 | undefined;
  readonly eventTurnId: string | undefined;
  readonly nativeTurnId: string | undefined;
  readonly tracePath: string | undefined;
  readonly nativeSessionId: string;
  readonly projectRoot: string;
  readonly agentId: string;
}

interface CodexActiveActor {
  readonly provider: "codex";
  readonly session_id: string;
  readonly agent_id: string;
}

/**
 * Main actors may roll an idle tombstone to a trace-attested goal turn. Child
 * actors may roll any older lease to a trace-attested follow-up turn because
 * Codex reuses child threads without another SubagentStart; a same-turn event
 * after idle remains terminal and is always rejected.
 */
async function staleToolTurnDecision(
  options: CodexTurnDecisionOptions & {
    readonly store: ActiveLeaseStore;
    readonly actor: CodexActiveActor;
  },
): Promise<{ readonly ignore: string } | undefined> {
  const unseenChild = await staleFirstSeenChildIgnore(
    options.store,
    options.actor,
    options.previous,
  );
  if (unseenChild) return unseenChild;
  const stale = staleTurnDecision(options.previous, options.eventTurnId);
  if (options.agentId !== "main") {
    if (stale) return attestCodexTurnRollover(options, stale);
    return options.previous?.state === "idle"
      ? { ignore: "stale turn event ignored" }
      : undefined;
  }
  if (options.previous?.state !== "idle") return stale;
  const fallback = stale ?? { ignore: "stale turn event ignored" };
  if (
    options.eventTurnId === undefined ||
    options.previous.turn_id === options.eventTurnId
  ) {
    return fallback;
  }
  return attestCodexTurnRollover(options, fallback);
}

async function staleMainTurnDecision(
  options: CodexTurnDecisionOptions,
): Promise<{ readonly ignore: string } | undefined> {
  const stale = staleTurnDecision(options.previous, options.eventTurnId);
  if (stale === undefined) return undefined;
  if (options.previous?.state !== "idle") return stale;
  return attestCodexTurnRollover(options, stale);
}

async function attestCodexTurnRollover(
  options: CodexTurnDecisionOptions,
  stale: { readonly ignore: string },
): Promise<{ readonly ignore: string } | undefined> {
  if (options.nativeTurnId === undefined || options.tracePath === undefined) {
    return stale;
  }
  let attestation: Awaited<ReturnType<typeof readCodexTurnAttestation>>;
  try {
    attestation = await readCodexTurnAttestation(options.tracePath);
  } catch (error: unknown) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new Error(`Codex trace does not exist: ${options.tracePath}`);
    }
    throw error;
  }
  assertCodexTraceIdentity(
    attestation.identity,
    options.nativeSessionId,
    options.projectRoot,
  );
  if (
    options.agentId !== "main" &&
    attestation.identity?.nativeThreadId !== options.agentId
  ) {
    throw new Error(
      "Codex hook agent_id does not match transcript session_meta.id",
    );
  }
  if (attestation.malformedLines > 0 || attestation.partialFinalLine) {
    return stale;
  }
  return attestation.latestStartedTurnId === options.nativeTurnId
    ? undefined
    : stale;
}

/**
 * A root prompt authoritatively begins its turn. Child prompts instead belong
 * to the actor created by SubagentStart: a first-seen prompt requires a live
 * root, and an existing child accepts only its initial, same-turn prompt while
 * its lease is still pristine. Delayed prompts must not clear richer activity
 * or resurrect an idle tombstone.
 */
async function staleUserPromptIgnore(
  store: ActiveLeaseStore,
  actor: CodexActiveActor,
  previous: ActiveLeaseV1 | undefined,
  eventTurnId: string | undefined,
): Promise<{ readonly ignore: string } | undefined> {
  if (actor.agent_id === "main") return undefined;
  const own = staleTurnDecision(previous, eventTurnId);
  if (own) return own;
  if (previous === undefined) {
    return staleFirstSeenChildIgnore(store, actor, previous);
  }
  const pristine =
    previous.state === "working" &&
    previous.intent === undefined &&
    previous.current_action === undefined &&
    previous.claims.length === 0 &&
    previous.unknown_write_scope === false &&
    previous.extensions === undefined;
  return pristine ? undefined : { ignore: "stale turn event ignored" };
}

/**
 * Current Codex SubagentStart and SubagentStop payloads identify the child's
 * own turn and expose no parent-turn id. A start is therefore fenced by the
 * child actor itself plus visible root presence: any existing actor rejects a
 * duplicate Start so delayed delivery cannot erase live claims or resurrect
 * an idle tombstone, while a new actor is admitted only while its root session
 * is active. Stop may safely create an idle tombstone when it wins the race
 * with Start, making either event order converge to idle.
 */
async function staleSubagentStartIgnore(
  store: ActiveLeaseStore,
  actor: CodexActiveActor,
  previous: ActiveLeaseV1 | undefined,
  eventTurnId: string | undefined,
): Promise<{ readonly ignore: string } | undefined> {
  const own = staleTurnDecision(previous, eventTurnId);
  if (own) return own;
  if (previous !== undefined) {
    return { ignore: "stale turn event ignored" };
  }
  return staleFirstSeenChildIgnore(store, actor, previous);
}

/** A first-seen child can exist only while its root session is visibly live. */
async function staleFirstSeenChildIgnore(
  store: ActiveLeaseStore,
  actor: CodexActiveActor,
  previous: ActiveLeaseV1 | undefined,
): Promise<{ readonly ignore: string } | undefined> {
  if (actor.agent_id === "main" || previous !== undefined) return undefined;
  const root = await store.readActive({
    provider: "codex",
    session_id: actor.session_id,
    agent_id: "main",
  });
  if (root === undefined) {
    return { ignore: "stale turn event ignored" };
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

function sameTurnIntentUpdate(
  previous: ActiveLeaseV1 | undefined,
  eventTurnId: string | undefined,
): { readonly intent?: ActiveContent } {
  if (
    eventTurnId === undefined ||
    previous?.turn_id !== eventTurnId ||
    previous.intent === undefined
  ) {
    return {};
  }
  return { intent: previous.intent };
}

function sameTurnExtensionUpdate(
  previous: ActiveLeaseV1 | undefined,
  eventTurnId: string | undefined,
): { readonly extensions?: ActiveExtensions } {
  if (
    eventTurnId === undefined ||
    previous?.turn_id !== eventTurnId ||
    previous.extensions === undefined
  ) {
    return {};
  }
  return { extensions: previous.extensions };
}

/**
 * Hand the asynchronous ingest hook a durable, turn-bound explanation for a
 * deliberately nonterminal Stop. This lives on the advisory lease rather
 * than the read cursor: the sync Stop writer owns it, ordinary lease
 * boundaries clear it, and the ingest worker remains a read-only observer.
 */
function stopContinuationExtensions(turnId: string): ActiveExtensions {
  return {
    codex: {
      [STOP_CONTINUATION_EXTENSION]: {
        active: true,
        turn_id: turnId,
      },
    },
  };
}

async function hasMatchingStopContinuation(
  store: ActiveLeaseStore,
  sessionId: string,
  expectedTurnId: string,
): Promise<boolean> {
  const lease = await store.readSnapshot({
    provider: "codex",
    session_id: sessionId,
    agent_id: "main",
  });
  if (
    lease === undefined ||
    (lease.state !== "working" && lease.state !== "waiting") ||
    lease.turn_id !== expectedTurnId
  ) {
    return false;
  }
  const marker = lease.extensions?.codex?.[STOP_CONTINUATION_EXTENSION];
  return (
    isObject(marker) &&
    marker.active === true &&
    marker.turn_id === expectedTurnId
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
  const triggeredAt = new Date().toISOString();
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
  const sessionId = createSessionId("codex", nativeSessionId);
  const ingestAgentId =
    stringValue(input.agent_id) ?? stringValue(input.agent_path) ?? "main";
  const expectedTurnId = requestedTurnId === undefined
    ? undefined
    : createTurnId("codex", nativeSessionId, ingestAgentId, requestedTurnId);
  await assertCodexHookTraceIdentity(
    tracePath,
    nativeSessionId,
    projectRoot,
  );
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  const admissionNow = await codexMembershipEffectiveAt({
    event,
    projectRoot,
    ...(prompt === undefined ? {} : { prompt }),
    tracePath,
    ...(requestedTurnId === undefined ? {} : { nativeTurnId: requestedTurnId }),
  });
  const admission = await admitHookSession({
    projectRoot,
    provider: "codex",
    nativeSessionId,
    event,
    ...(prompt === undefined ? {} : { prompt }),
    ...(admissionNow === undefined ? {} : { now: admissionNow }),
  });
  if (!admission.joined) {
    if (admission.pending !== undefined || admission.refused !== undefined) {
      // The user addressed Barbaro without completing a join: not a dormant
      // hook, so no incident; the activity hook surfaces the outcome.
      return {
        event,
        ignored:
          admission.pending !== undefined
            ? WORKSTREAM_SELECTION_PENDING
            : (admission.refused ?? SESSION_NOT_JOINED),
      };
    }
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
  const workstreamId = admission.participation?.workstream_id;
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
  const attempt = await beginIngestAttempt({
    projectRoot,
    provider: "codex",
    sessionId,
    event,
    tracePath,
    triggeredAt,
    ...(requestedTurnId === undefined
      ? {}
      : { nativeTurnId: requestedTurnId }),
    ...(expectedTurnId === undefined ? {} : { turnId: expectedTurnId }),
    agentId: ingestAgentId,
    ...(stringValue(input.last_assistant_message) === undefined
      ? {}
      : { lastAssistantMessage: stringValue(input.last_assistant_message)! }),
  });
  const activeStore = new ActiveLeaseStore(
    join(projectRoot, ".barbaro", "active"),
  );

  const started = Date.now();
  try {
    while (true) {
      const traceResult = await runCodexTrace({
        tracePath,
        projectRoot,
        expectedNativeSessionId: nativeSessionId,
      });
      // Diagnostic I/O is deliberately excluded from the functional poll
      // decision: a contended fail-open journal must not consume the final
      // chance to observe provider-written terminal bytes.
      const observedElapsed = Date.now() - started;
      const publishBlocker = codexPublishBlocker(
        event,
        requestedTurnId,
        traceResult,
      );
      await attempt.observe({
        observedSize: traceResult.observation.observed_size,
        fileIdentity: traceResult.observation.file_identity,
        ...(traceResult.observation.checkpoint_before === undefined
          ? {}
          : {
              checkpointBefore:
                traceResult.observation.checkpoint_before,
            }),
        checkpointAfter: traceResult.observation.checkpoint_after,
        runnerInput: { ...traceResult.input },
        turnsAppended: traceResult.output.turns_appended,
        ...(publishBlocker === undefined ? {} : { publishBlocker }),
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
            ...(workstreamId === undefined ? {} : { workstreamId }),
            detail:
              `${traceResult.output.conflicted} derived record(s) recomputed ` +
              `with different canonical content; stored versions kept: ` +
              traceResult.output.conflicted_ids.join(", "),
          });
        }
        await attempt.finish("ok");
        return { event, trace_result: traceResult };
      }
      if (
        event === "Stop" &&
        input.stop_hook_active !== true &&
        ingestAgentId === "main" &&
        expectedTurnId !== undefined &&
        await hasMatchingStopContinuation(
          activeStore,
          sessionId,
          expectedTurnId,
        )
      ) {
        // The synchronous hook deliberately reopened this exact turn and
        // returned decision:block. There cannot be a terminal rollout record
        // yet; the active Stop, SessionEnd, or next prompt remains the normal
        // catch-up boundary. Treat this attempt as intentionally complete
        // instead of manufacturing a ten-second hook_error.
        await attempt.finish("ok");
        return { event, ignored: "Stop continuation is intentionally nonterminal" };
      }
      if (observedElapsed >= timeoutMs) {
        throw new CodexTerminalIngestTimeoutError(event, timeoutMs);
      }
      await delay(Math.min(pollIntervalMs, timeoutMs - observedElapsed));
    }
  } catch (error) {
    await attempt.finish("error");
    throw error;
  }
}

function codexPublishBlocker(
  event: string,
  requestedTurnId: string | undefined,
  result: RunCodexTraceResult,
): string | undefined {
  if (result.input.partial_final_line) return "partial_final_line";
  if (
    event === "Stop" &&
    requestedTurnId !== undefined &&
    !result.output.terminal_native_turn_ids.includes(requestedTurnId)
  ) {
    return "trigger_turn_not_terminal";
  }
  return undefined;
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
  assertCodexTraceIdentity(identity, nativeSessionId, projectRoot);
}

function assertCodexTraceIdentity(
  identity: Awaited<ReturnType<typeof readCodexTraceIdentity>>,
  nativeSessionId: string,
  projectRoot: string,
): void {
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

async function codexMembershipEffectiveAt(options: {
  readonly event: string;
  readonly projectRoot: string;
  readonly prompt?: string;
  readonly tracePath?: string;
  readonly nativeTurnId?: string;
}): Promise<Date | undefined> {
  if (
    options.event !== "UserPromptSubmit" ||
    options.prompt === undefined ||
    options.tracePath === undefined ||
    options.nativeTurnId === undefined
  ) {
    return undefined;
  }
  const invocation = parseBarbaroInvocation(options.prompt, options.projectRoot);
  if (invocation === undefined || invocation.kind === "bare") return undefined;
  const startedAt = await readCodexTurnStartedAt(
    options.tracePath,
    options.nativeTurnId,
  );
  return startedAt === undefined ? undefined : new Date(startedAt);
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

export async function handleCodexHookFailOpen(
  input: unknown,
): Promise<CodexHookResult | undefined> {
  const cwd = isObject(input) ? stringValue(input.cwd) : undefined;
  // Name the event. Logging every activity-hook failure as "unknown" makes the
  // log useless for exactly the debugging it exists for.
  const event = isObject(input)
    ? stringValue(input.hook_event_name) ?? stringValue(input.event_name) ?? "unknown"
    : "unknown";
  try {
    return await handleCodexHook(input);
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
    return undefined;
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

interface ToolActivity {
  readonly currentAction?: ActiveCurrentAction;
  readonly claims: readonly ActiveWriteClaim[];
  readonly unknownWriteScope: boolean;
  readonly awaitCommand?: AwaitCommandClassification;
  readonly contextCommand?: boolean;
}

function classifyToolActivity(
  input: Record<string, unknown>,
  projectRoot: string,
): ToolActivity {
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

  // The pinned hook schema canonicalizes shell and unified-exec calls to Bash;
  // `exec` is retained for the accepted RFC's explicit hook spelling.
  if (toolName === "Bash" || toolName === "exec") {
    const command = stringValue(toolInput.command);
    const awaitCommand = command ? classifyAwaitCommand(command) : undefined;
    const digestExcludedCommand = command
      ? isDigestExcludedBarbaroCommand(command)
      : false;
    const contextCommand = command
      ? isLeadingBarbaroContextCommand(command)
      : false;
    return {
      currentAction: {
        kind: "command",
        tool_name: toolName,
        ...(command ? { command: boundedContent(command, ACTIVE_INTENT_BYTES) } : {}),
        started_at: startedAt,
      },
      claims: [],
      unknownWriteScope:
        awaitCommand === undefined && !digestExcludedCommand,
      ...(awaitCommand === undefined ? {} : { awaitCommand }),
      ...(contextCommand ? { contextCommand: true } : {}),
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
