import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  BarbaroEvidenceV1,
  BarbaroTurnOutcome,
  BarbaroTurnV1,
} from "../contracts/v1.js";
import {
  createEvidenceId,
  createJsonlCheckpoint,
  fileIdentityEquals,
  readJsonlForward,
  resolveJsonlCheckpoint,
  snapshotFromStats,
  type FileIdentity,
  type JsonlCheckpoint,
} from "../core/index.js";
import { withDirectoryLock } from "../output/directory-lock.js";
import { appendUniqueJsonl } from "../output/jsonl-store.js";
import {
  ClaudeTurnNormalizer,
  type ClaudeAgentLink,
  type ClaudeNormalizerDiagnostics,
  type ClaudeWorkflowLink,
} from "../providers/claude/normalizer.js";
import {
  classifyUserRecord,
  decodeClaudeEnvelope,
  decodeClaudeMessage,
} from "../providers/claude/records.js";
import {
  CLAUDE_RUNNER_STATE_SCHEMA,
  readClaudeRunnerState,
  writeClaudeRunnerState,
  type ClaudeRunnerStateV1,
} from "./claude-state.js";
import {
  resolveSessionMemberships,
  stampEvidenceByMembership,
  stampTurnsByMembership,
} from "./workstream-stamp.js";

const EMPTY_JOURNAL: WorkflowJournal = {
  known: new Set<string>(),
  completed: new Set<string>(),
  complete: false,
};

export interface RunClaudeTraceOptions {
  /** Path to the main session file: <project>/<session-uuid>.jsonl */
  readonly tracePath: string;
  readonly projectRoot: string;
  readonly barbaroDirectory?: string;
  readonly reset?: boolean;
  /**
   * Whether the trace has stopped growing (default true).
   *
   * Only a caller can know this. A completed turn keeps absorbing records
   * after its terminal marker — remaining text blocks of the same API
   * response, a compact boundary — so flushing the trailing turn while the
   * file is still being appended publishes a digest that the next run would
   * have to revise. Pass false when polling a live session mid-turn.
   */
  readonly final?: boolean;
  /**
   * Whether the source file will not change again (defaults to `final`).
   *
   * Distinct from `final`: a Stop hook knows the turn reached its terminal
   * record, but not that the branch pointer has been written. It passes
   * `final: true, sourceFinal: false` so a trace-terminal turn can publish
   * while a pointerless fork is still withheld.
   */
  readonly sourceFinal?: boolean;
  /**
   * Present only for Claude's Stop event. The pinned replay must contain the
   * trailing turn the hook announced before this run may publish or advance
   * its checkpoint. An absent digest requests structural attestation only.
   */
  readonly stopTurnAttestation?: {
    readonly announcedMessageSha256?: string;
  };
}

export interface RunClaudeTraceResult {
  readonly trace_id: string;
  readonly session_id: string;
  readonly checkpoint_status: string;
  readonly observation: {
    /** The exact byte snapshot pinned for this full replay. */
    readonly observed_size: number;
    readonly file_identity: FileIdentity;
    readonly checkpoint_before?: JsonlCheckpoint;
    /** The checkpoint actually durable after this run, not merely computed. */
    readonly checkpoint_after?: JsonlCheckpoint;
  };
  readonly input: {
    readonly complete_lines: number;
    readonly parsed_lines: number;
    readonly malformed_lines: number;
    readonly partial_final_line: boolean;
    readonly finalized: boolean;
    /**
     * True when the trailing turn is not yet canonical: either it never
     * reached its terminal record, or it reached one but the source is not
     * final, so it can still absorb records and is deliberately withheld. It
     * publishes when a later snapshot closes it — at the provider's
     * `turn_duration` record, at a successor prompt — or on a source-final
     * ingest.
     */
    readonly trailing_turn_open: boolean;
    /**
     * Turns finalization closed at EOF that were withheld because the source
     * is not final. They publish on the next ingest that sees their
     * successor records, or at SessionEnd.
     */
    readonly trailing_turns_withheld: number;
    /**
     * True when the trailing turn is terminal with no background launch that
     * could still continue it, i.e. the next `turn_duration` record would
     * close and publish it.
     */
    readonly trailing_turn_closable: boolean;
    /** Terminality is distinct from closability when background work remains. */
    readonly trailing_turn_terminal: boolean;
    /** Latest active-branch `end_turn` response, grouped by message.id. */
    readonly latest_terminal_response_message_id?: string;
    readonly latest_terminal_response_sha256?: string;
    readonly latest_terminal_response_utf8_bytes?: number;
    /** Present only when the caller requested Stop-turn attestation. */
    readonly stop_turn_identity_required?: boolean;
    readonly stop_turn_visible?: boolean;
    readonly pending_background_ids: readonly string[];
    readonly pending_background_count: number;
    /** Whether this trace has shown any `turn_duration` record. */
    readonly turn_duration_seen: boolean;
    /** Set when the snapshot was unusable and nothing was appended. */
    readonly withheld_reason?: string;
  };
  readonly output: {
    readonly turns_appended: number;
    readonly turns_skipped: number;
    readonly evidence_appended: number;
    readonly evidence_skipped: number;
    /**
     * IDs already published with different content. The stored version stands;
     * this counts how many the producer recomputed differently, which is a
     * determinism defect worth surfacing rather than a reason to publish
     * nothing at all.
     */
    readonly conflicted: number;
    /** Which IDs drifted, bounded — a count alone is not actionable. */
    readonly conflicted_ids: readonly string[];
  };
  readonly subagents: {
    readonly files: number;
    readonly published: number;
    readonly withheld_unresolved: number;
    readonly withheld_growing: number;
    readonly child_turns: number;
    readonly missing_expected: number;
    readonly blocked_parent_turns: number;
    /** Children whose traces are complete enough to normalize this run. */
    readonly ready_agent_ids: readonly string[];
    /** Children still missing, growing, unresolved, or awaiting completion. */
    readonly pending_agent_ids: readonly string[];
  };
  readonly diagnostics: ClaudeNormalizerDiagnostics;
}

/**
 * Ingest one Claude session bundle: the main file plus every subagent and
 * workflow-agent file beneath it.
 *
 * The whole bundle is normalized in memory before anything is appended. A
 * parent digest names the evidence its children produced, so publishing the
 * parent before its children are known would emit a rollup that a later run
 * would have to contradict.
 */
export async function runClaudeTrace(
  options: RunClaudeTraceOptions,
): Promise<RunClaudeTraceResult> {
  const tracePath = resolve(options.tracePath);
  const projectRoot = resolve(options.projectRoot);
  const defaultBarbaroDirectory = join(projectRoot, ".barbaro");
  const barbaroDirectory = resolve(
    options.barbaroDirectory ?? defaultBarbaroDirectory,
  );
  if (barbaroDirectory !== defaultBarbaroDirectory) {
    throw new Error("Barbaro v1 output directory must be <projectRoot>/.barbaro");
  }
  assertInsideProject(projectRoot, barbaroDirectory);

  const nativeSessionId = basename(tracePath, ".jsonl");
  if (!nativeSessionId || nativeSessionId.startsWith("agent-")) {
    throw new Error(
      "runClaudeTrace expects a main session file, not a subagent file",
    );
  }
  const traceId = claudeMainTraceId(nativeSessionId);
  const statePath = claudeRunnerStatePath(tracePath, barbaroDirectory);

  return withDirectoryLock(`${statePath}.ingest`, async () => {
    const saved = options.reset
      ? undefined
      : await readClaudeRunnerState(statePath);
    const resolution = await resolveJsonlCheckpoint(tracePath, saved?.checkpoint);
    if (resolution.status === "missing") {
      throw new Error(`Claude trace does not exist: ${tracePath}`);
    }

    // ONE bounded snapshot. Branch selection and normalization must see the
    // same bytes: `last-prompt` is rewritten in place, so reading it in a
    // separate pass can select a branch the normalized rows never belonged
    // to — and once the completed pointer picks the other branch, the already
    // published turns collide as an ID conflict that can never be resolved.
    // The snapshot is pinned to a size observed before reading, so growth
    // during the read cannot change which bytes were normalized.
    const opening = await stampSource(tracePath);
    const rows: { value: unknown; lineNumber: number }[] = [];
    const summary = await readJsonlForward(
      tracePath,
      (event) => {
        if (event.kind === "malformed") return;
        rows.push({ value: event.value, lineNumber: event.lineNumber });
      },
      { startOffset: 0, nextLineNumber: 1, endOffset: Number(opening.size) },
    );

    const membership = computeActiveMembership(rows);
    const stopObservation = inspectClaudeStopTurn(rows, membership);
    // "The trailing turn may close" and "the source will not change again"
    // are different claims. A Stop hook knows the turn ended; it does not know
    // the branch pointer has been written. Only an offline parse or SessionEnd
    // may treat a pointerless fork as settled.
    const sourceFinal = options.sourceFinal ?? options.final !== false;
    let unstable = describeUnstableSnapshot({
      summary,
      resolutionSnapshot: resolution.snapshot,
      membership,
      live: !sourceFinal,
    });

    const normalizer = new ClaudeTurnNormalizer({
      nativeSessionId,
      actorId: "main",
      workspaceRoot: projectRoot,
      ...(membership.ancestry === undefined
        ? {}
        : {
            activeAncestry: membership.ancestry,
            activeMessageIds: membership.activeMessageIds,
            onPathResultIds: membership.onPathResultIds,
          }),
    });

    let turns: BarbaroTurnV1[] = [];
    const evidence: BarbaroEvidenceV1[] = [];
    for (const row of rows) {
      const batch = normalizer.accept(row.value, {
        traceId,
        lineNumber: row.lineNumber,
      });
      turns.push(...batch.turns);
      evidence.push(...batch.evidence);
    }

    const finalized =
      options.final !== false && summary.partialFinalLine === undefined;
    let trailingTurnsWithheld = 0;
    if (finalized) {
      const tail = normalizer.finish(sourceFinal ? { sourceFinal: true } : {});
      if (sourceFinal) {
        turns.push(...tail.turns);
        evidence.push(...tail.evidence);
      } else {
        // A turn that finalization closed at EOF can still absorb records —
        // remaining text blocks of its API response, an async continuation, a
        // task notification folding in — so its digest and aggregate evidence
        // are not yet canonical. Publishing them here is what minted the
        // same-ID-different-content conflicts of 2026-08-18. A turn becomes
        // canonical only when it can no longer grow: once successor records
        // exist in the stream, or once the caller asserts the source is
        // final. Until then the feed runs one turn behind, which is the
        // honest price.
        trailingTurnsWithheld = tail.turns.length;
      }
    }
    // Asked after finish(): a turn that closed cleanly is gone from the
    // normalizer, so what remains open is precisely what finalization refused
    // to publish.
    const trailingTurnOpen =
      normalizer.hasOpenTurn || trailingTurnsWithheld > 0;
    const latestTerminalResponse = stopObservation.response;
    const stopTurnVisible =
      options.stopTurnAttestation === undefined
        ? undefined
        : stopObservation.terminal &&
          (options.stopTurnAttestation.announcedMessageSha256 === undefined ||
            latestTerminalResponse?.sha256 ===
              options.stopTurnAttestation.announcedMessageSha256);
    if (stopTurnVisible === false) {
      unstable ??= "stop_turn_not_visible";
    }

    // Cheap early check so a already-drifted source skips the expensive child
    // pass entirely. It is NOT the authoritative one — see below.
    unstable ??= await describeSourceDrift(tracePath, opening);

    // An unstable snapshot publishes NOTHING — not even the turns that closed
    // cleanly during replay. Appending them commits to a branch choice the
    // completed file may contradict.
    if (unstable) {
      turns = [];
      evidence.length = 0;
    }

    const observedCwd = normalizer.observedCwd;
    if (observedCwd && resolve(observedCwd) !== projectRoot) {
      throw new Error(
        `Trace project ${resolve(observedCwd)} does not match requested project ${projectRoot}`,
      );
    }

    const sessionId = normalizer.sessionId;
    const bundle = await normalizeChildren(
      tracePath,
      nativeSessionId,
      projectRoot,
      sessionId,
      normalizer.agentLinks(),
      normalizer.workflowLinks(),
      (agentId) => normalizer.isAgentComplete(agentId),
    );

    // Enrich each parent digest with the children it actually produced, then
    // publish. Evidence goes first: a crash can then leave orphan evidence,
    // never a digest whose evidence_refs dangle.
    // If any child of a parent is pending, the parent's WHOLE child evidence
    // group is withheld. Publishing the finished siblings early would make the
    // physical order of a progressively-ingested file differ from a one-shot
    // ingest of the same file.
    const publishable = bundle.children.filter(
      (child) => !bundle.blockedParents.has(child.parentTurnId),
    );
    turns = enrichRollups(turns, publishable).filter(
      (turn) => !bundle.blockedParents.has(turn.turn_id),
    );
    // Child evidence is only appended when the digest that names it is being
    // appended too. Otherwise the evidence carries a parent_turn_id pointing
    // at a turn no reader can reach.
    const reachableParents = new Set(turns.map((turn) => turn.turn_id));
    evidence.push(
      ...publishable
        .filter((child) => reachableParents.has(child.parentTurnId))
        .flatMap((child) => [...child.evidence]),
    );

    // THE authoritative drift check: immediately before the first write, with
    // nothing left to do in between. Child normalization is unbounded work —
    // a large subagent trace leaves a wide window in which a replacement
    // pointer can land, and publishing after that would pick a branch the
    // settled file contradicts. Anything already assembled is discarded.
    if (!unstable) {
      unstable = await describeSourceDrift(tracePath, opening);
      if (unstable) {
        turns = [];
        evidence.length = 0;
      }
    }

    // Membership comes from the append-only consent log and each record is
    // stamped from its own timestamp, so later moves cannot change reset
    // re-ingestion of earlier history.
    const memberships = await resolveSessionMemberships(
      projectRoot,
      "claude",
      nativeSessionId,
    );
    const evidenceResult = await appendUniqueJsonl(
      join(barbaroDirectory, "evidence", "claude", `${sessionId}.jsonl`),
      stampEvidenceByMembership(evidence, memberships),
      (item) => item.evidence_id,
    );
    const turnResult = await appendUniqueJsonl(
      join(barbaroDirectory, "feed", "claude", `${sessionId}.jsonl`),
      stampTurnsByMembership(turns, memberships),
      (turn) => turn.turn_id,
    );

    const nextCheckpoint = createJsonlCheckpoint(summary);
    const checkpointAfter = unstable ? saved?.checkpoint : nextCheckpoint;

    // A checkpoint records a snapshot that was actually consumed. Writing one
    // for a snapshot we refused to publish would claim progress never made.
    if (!unstable) {
      const state: ClaudeRunnerStateV1 = {
        schema: CLAUDE_RUNNER_STATE_SCHEMA,
        trace_id: traceId,
        native_session_id: nativeSessionId,
        actor_id: "main",
        checkpoint: nextCheckpoint,
        workspace_root: projectRoot,
      };
      await writeClaudeRunnerState(statePath, state);
    }

    return {
      trace_id: traceId,
      session_id: sessionId,
      checkpoint_status: resolution.status,
      observation: {
        observed_size: Number(opening.size),
        file_identity: opening.identity,
        ...(saved?.checkpoint === undefined
          ? {}
          : { checkpoint_before: saved.checkpoint }),
        ...(checkpointAfter === undefined
          ? {}
          : { checkpoint_after: checkpointAfter }),
      },
      input: {
        complete_lines: summary.completeLines,
        parsed_lines: summary.parsedLines,
        malformed_lines: summary.malformedLines,
        partial_final_line: summary.partialFinalLine !== undefined,
        finalized,
        trailing_turn_open: trailingTurnOpen,
        trailing_turns_withheld: trailingTurnsWithheld,
        // A tail that finalization closed and withheld was terminal with no
        // background launch outstanding — exactly what the next
        // `turn_duration` record would close in-stream.
        trailing_turn_closable:
          trailingTurnsWithheld > 0 || normalizer.openTurnClosable,
        trailing_turn_terminal:
          trailingTurnsWithheld > 0 || normalizer.openTurnTerminal,
        ...(latestTerminalResponse === undefined
          ? {}
          : {
              latest_terminal_response_message_id:
                latestTerminalResponse.message_id,
              latest_terminal_response_sha256: latestTerminalResponse.sha256,
              latest_terminal_response_utf8_bytes:
                latestTerminalResponse.utf8_bytes,
            }),
        ...(stopTurnVisible === undefined
          ? {}
          : {
              stop_turn_identity_required:
                options.stopTurnAttestation?.announcedMessageSha256 !==
                undefined,
              stop_turn_visible: stopTurnVisible,
            }),
        pending_background_ids: normalizer.openTurnPendingBackgroundIds,
        pending_background_count:
          normalizer.openTurnPendingBackgroundIds.length,
        turn_duration_seen: normalizer.turnDurationSeen,
        ...(unstable === undefined ? {} : { withheld_reason: unstable }),
      },
      output: {
        turns_appended: turnResult.appended,
        turns_skipped: turnResult.skipped,
        evidence_appended: evidenceResult.appended,
        evidence_skipped: evidenceResult.skipped,
        conflicted: turnResult.conflicted + evidenceResult.conflicted,
        conflicted_ids: [
          ...turnResult.conflictedIds,
          ...evidenceResult.conflictedIds,
        ],
      },
      subagents: {
        files: bundle.files,
        published: publishable.length,
        withheld_unresolved: bundle.withheldUnresolved,
        withheld_growing: bundle.withheldGrowing,
        child_turns: bundle.children.reduce(
          (total, child) => total + child.evidence.length,
          0,
        ),
        missing_expected: bundle.missingExpected,
        blocked_parent_turns: bundle.blockedParents.size,
        ready_agent_ids: bundle.children
          .map((child) => child.agentId)
          .sort(compareCodeUnits),
        pending_agent_ids: [...bundle.pendingAgentIds].sort(compareCodeUnits),
      },
      diagnostics: normalizer.diagnostics(),
    };
  });
}

interface SourceStamp {
  readonly identity: FileIdentity;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

async function stampSource(tracePath: string): Promise<SourceStamp> {
  const stats = await stat(tracePath, { bigint: true });
  const snapshot = snapshotFromStats(stats);
  return {
    identity: snapshot.identity,
    size: BigInt(snapshot.size),
    mtimeNs: stats.mtimeNs,
  };
}

/**
 * Whether the source moved since the snapshot was taken.
 *
 * Modification time is checked as well as identity and size: `last-prompt` is
 * rewritten in place and a replacement pointer is the same length as the one
 * it replaces, so a size comparison alone sees nothing at all.
 *
 * Called twice — once cheaply after the main read, and once authoritatively
 * with nothing between it and the first append.
 */
async function describeSourceDrift(
  tracePath: string,
  opening: SourceStamp,
): Promise<string | undefined> {
  const current = await stampSource(tracePath);
  if (!fileIdentityEquals(opening.identity, current.identity)) {
    return "identity_changed_during_ingest";
  }
  if (current.size !== opening.size) return "source_grew_during_ingest";
  if (current.mtimeNs !== opening.mtimeNs) return "source_rewritten_during_ingest";
  return undefined;
}

export interface ActiveMembership {
  readonly ancestry?: ReadonlySet<string>;
  readonly activeMessageIds?: ReadonlySet<string>;
  /** True when the snapshot contains a fork. */
  readonly hasFork: boolean;
  /** True when a `last-prompt` pointer was present and usable. */
  readonly hasPointer: boolean;
  /**
   * True when records appended after the pointer do not form one unique
   * continuation. A stale `last-prompt` cannot choose between two descendants
   * that arrived after the leaf it still names.
   */
  readonly ambiguousPointerContinuation: boolean;
  /** tool_use_ids whose result row lies on the active ancestry. */
  readonly onPathResultIds?: ReadonlySet<string>;
  /**
   * tool_use_ids with no on-path result and more than one competing off-path
   * result. Choosing between them would be arrival order, not evidence.
   */
  readonly ambiguousResultIds?: ReadonlySet<string>;
}

interface ClaudeStopTurnObservation {
  readonly terminal: boolean;
  readonly response?: {
    readonly message_id: string;
    readonly sha256: string;
    readonly utf8_bytes: number;
  };
}

/**
 * Inspect the raw trailing response group independently from feed attribution.
 *
 * Stop can fire while Claude is answering a hook-feedback or SDK prompt. Those
 * spans are deliberately suppressed by the turn normalizer, but their bytes
 * still have to attest the Stop invocation. A prompt boundary clears the prior
 * candidate, and only the most recently started assistant message may attest;
 * an earlier terminal group never substitutes for a later nonterminal one.
 */
function inspectClaudeStopTurn(
  rows: readonly { value: unknown; lineNumber: number }[],
  membership: ActiveMembership,
): ClaudeStopTurnObservation {
  let latest:
    | {
        key: string;
        messageId?: string;
        texts: string[];
        terminal: boolean;
      }
    | undefined;

  const active = (uuid: string | undefined, messageId?: string): boolean =>
    membership.ancestry === undefined ||
    (uuid !== undefined && membership.ancestry.has(uuid)) ||
    (messageId !== undefined &&
      membership.activeMessageIds?.has(messageId) === true);

  for (const row of rows) {
    const decoded = decodeClaudeEnvelope(row.value);
    if (!decoded.ok) continue;
    const envelope = decoded.envelope;
    const message = decodeClaudeMessage(envelope.raw);

    if (envelope.type === "user") {
      if (!active(envelope.uuid) || message === undefined) continue;
      const provenance = classifyUserRecord(envelope, message, {
        isSubagentTrace: false,
      });
      if (provenance.kind !== "tool-result") latest = undefined;
      continue;
    }
    if (envelope.type !== "assistant" || message === undefined) continue;
    if (!active(envelope.uuid, message.id)) continue;

    const key = message.id ?? `line:${row.lineNumber}`;
    if (latest?.key !== key) {
      latest = {
        key,
        ...(message.id === undefined ? {} : { messageId: message.id }),
        texts: [],
        terminal: false,
      };
    }
    for (const block of message.content) {
      if (block.type === "text") latest.texts.push(block.text);
    }
    if (message.stopReason === "end_turn") latest.terminal = true;
  }

  if (latest?.terminal !== true) return { terminal: false };
  if (latest.messageId === undefined) return { terminal: true };
  const text = latest.texts.join("").trim();
  if (text.length === 0) return { terminal: true };
  return {
    terminal: true,
    response: {
      message_id: latest.messageId,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      utf8_bytes: Buffer.byteLength(text, "utf8"),
    },
  };
}

/**
 * Whether a UUID-bearing branch carries only Claude attachment sidecars.
 *
 * Attachments can also sit inline between semantic timeline records, so the
 * root type alone is not enough: a branch is transparent only when every
 * descendant is another attachment. Repeated visitation is treated as an
 * ambiguous graph rather than guessing through a cycle or duplicate edge.
 */
function isAttachmentOnlySubtree(
  rootUuid: string,
  childrenByParent: ReadonlyMap<string, ReadonlySet<string>>,
  typeByUuid: ReadonlyMap<string, string | undefined>,
): boolean {
  const pending = [rootUuid];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const uuid = pending.pop()!;
    if (visited.has(uuid)) return false;
    visited.add(uuid);
    if (typeByUuid.get(uuid) !== "attachment") return false;
    pending.push(...(childrenByParent.get(uuid) ?? []));
  }
  return true;
}

/**
 * Decide active-branch membership from one already-read snapshot.
 *
 * Membership is per response group, not per row: one API response spans many
 * rows and only some lie directly on the leaf path, so a row-by-row rule
 * tears live responses apart and drops their sibling tool calls.
 */
export function computeActiveMembership(
  rows: readonly { value: unknown; lineNumber: number }[],
): ActiveMembership {
  const parents = new Map<string, string | undefined>();
  const messageIdByUuid = new Map<string, string>();
  const childCounts = new Map<string, number>();
  const childrenByParent = new Map<string, Set<string>>();
  const lineByUuid = new Map<string, number>();
  const typeByUuid = new Map<string, string | undefined>();
  let leafUuid: string | undefined;
  let pointerLineNumber: number | undefined;

  for (const { value, lineNumber } of rows) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as {
      type?: unknown;
      uuid?: unknown;
      parentUuid?: unknown;
      logicalParentUuid?: unknown;
      leafUuid?: unknown;
      message?: { id?: unknown };
    };
    if (record.type === "last-prompt" && typeof record.leafUuid === "string") {
      leafUuid = record.leafUuid; // rewritten in place; the last one wins
      pointerLineNumber = lineNumber;
      continue;
    }
    if (typeof record.uuid !== "string") continue;
    lineByUuid.set(record.uuid, lineNumber);
    typeByUuid.set(
      record.uuid,
      typeof record.type === "string" ? record.type : undefined,
    );
    const parent =
      typeof record.parentUuid === "string"
        ? record.parentUuid
        : typeof record.logicalParentUuid === "string"
          ? record.logicalParentUuid
          : undefined;
    parents.set(record.uuid, parent);
    if (parent !== undefined) {
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
      const children = childrenByParent.get(parent) ?? new Set<string>();
      children.add(record.uuid);
      childrenByParent.set(parent, children);
    }
    const messageId = record.message?.id;
    if (typeof messageId === "string") messageIdByUuid.set(record.uuid, messageId);
  }

  const hasFork = [...childCounts.values()].some((count) => count > 1);
  if (!leafUuid || !parents.has(leafUuid)) {
    return {
      hasFork,
      hasPointer: false,
      ambiguousPointerContinuation: false,
    };
  }

  const ancestry = new Set<string>();
  let cursor: string | undefined = leafUuid;
  while (cursor !== undefined && !ancestry.has(cursor)) {
    ancestry.add(cursor);
    cursor = parents.get(cursor);
  }

  // `last-prompt` is rewritten in place, after timeline rows are appended.
  // A UserPromptSubmit ingest can therefore see rows appended after the
  // pointer while it still names the preceding response. Following a unique
  // post-pointer child chain is evidence, not a guess: every possible branch
  // includes it. Earlier descendants remain excluded because the later
  // pointer already rejected them. Use the same effective parent edge as the
  // reverse walk so a compact boundary (`parentUuid: null`,
  // `logicalParentUuid: leaf`) remains connected.
  //
  // More than one semantic child, or a cycle, is different. The stale pointer
  // has not selected a live branch, so the caller must withhold rather than
  // letting append order decide which descendant survives. Claude hook output
  // can fork an attachment-only side branch from a tool_use while the real
  // tool_result continues beside it. That subtree is metadata, not a branch
  // choice. An inline attachment that leads to a message/system descendant is
  // still followed as part of the one semantic continuation.
  let ambiguousPointerContinuation = false;
  let continuationCursor: string = leafUuid;
  while (true) {
    const children: string[] = [
      ...(childrenByParent.get(continuationCursor) ?? []),
    ].filter(
      (child) =>
        pointerLineNumber !== undefined &&
        (lineByUuid.get(child) ?? Number.NEGATIVE_INFINITY) > pointerLineNumber &&
        !isAttachmentOnlySubtree(child, childrenByParent, typeByUuid),
    );
    if (children.length === 0) break;
    if (children.length !== 1) {
      ambiguousPointerContinuation = true;
      break;
    }
    const child = children[0]!;
    if (ancestry.has(child)) {
      ambiguousPointerContinuation = true;
      break;
    }
    ancestry.add(child);
    continuationCursor = child;
  }
  // Every post-pointer semantic timeline row must belong to that one chain. A
  // child from an earlier ancestor is a rewind; a disconnected uuid is an
  // unknown semantic tail. Neither can be reconciled from this stale pointer.
  // UUID-less sidecars and off-chain attachment rows are transparent because
  // they cannot choose a branch; an attachment that leads to semantic rows was
  // retained by the walk above, and any disconnected semantic descendant is
  // still caught here.
  if (!ambiguousPointerContinuation) {
    ambiguousPointerContinuation = [...lineByUuid].some(
      ([uuid, lineNumber]) =>
        pointerLineNumber !== undefined &&
        lineNumber > pointerLineNumber &&
        !ancestry.has(uuid) &&
        typeByUuid.get(uuid) !== "attachment",
    );
  }

  const activeMessageIds = new Set<string>();
  for (const uuid of ancestry) {
    const messageId = messageIdByUuid.get(uuid);
    if (messageId !== undefined) activeMessageIds.add(messageId);
  }

  // Where each tool_use_id's result rows sit relative to the active path.
  // A parallel call accepted through its response group usually has its
  // result off the single leaf chain, so results cannot be judged by uuid.
  const onPathResultIds = new Set<string>();
  const offPathCounts = new Map<string, number>();
  for (const { value } of rows) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as { uuid?: unknown; message?: { content?: unknown } };
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    const onPath = typeof record.uuid === "string" && ancestry.has(record.uuid);
    for (const block of content) {
      if (
        block === null ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "tool_result"
      ) {
        continue;
      }
      const id = (block as { tool_use_id?: unknown }).tool_use_id;
      if (typeof id !== "string") continue;
      if (onPath) onPathResultIds.add(id);
      else offPathCounts.set(id, (offPathCounts.get(id) ?? 0) + 1);
    }
  }
  const ambiguousResultIds = new Set<string>();
  for (const [id, count] of offPathCounts) {
    if (count > 1 && !onPathResultIds.has(id)) ambiguousResultIds.add(id);
  }

  return {
    ancestry,
    activeMessageIds,
    hasFork,
    hasPointer: true,
    ambiguousPointerContinuation,
    onPathResultIds,
    ambiguousResultIds,
  };
}

/**
 * Why this snapshot cannot be published, or undefined if it can.
 *
 * Every case here would otherwise publish under a branch choice the completed
 * file may contradict, and a published digest can never be corrected.
 */
export function describeUnstableSnapshot(input: {
  readonly summary: { partialFinalLine?: unknown; malformedLines: number; fileIdentity: FileIdentity; observedSize: number };
  readonly resolutionSnapshot?: { identity: FileIdentity; size: number } | undefined;
  readonly membership: ActiveMembership;
  readonly live: boolean;
}): string | undefined {
  if (input.summary.partialFinalLine !== undefined) return "partial_final_line";
  if (input.summary.malformedLines > 0) return "malformed_records";
  if (
    input.resolutionSnapshot &&
    !fileIdentityEquals(input.summary.fileIdentity, input.resolutionSnapshot.identity)
  ) {
    return "identity_changed";
  }
  if (
    input.resolutionSnapshot &&
    input.summary.observedSize < input.resolutionSnapshot.size
  ) {
    return "truncated";
  }
  // A fork is only resolvable with its pointer. While the file is still
  // growing the pointer may simply not have been written yet.
  if (input.live && input.membership.hasFork && !input.membership.hasPointer) {
    return "fork_without_pointer";
  }
  // A pointer that trails one unique chain is still decisive. Once that
  // continuation forks, however, the pointer names only their common ancestor.
  // Even SessionEnd cannot prove which child Claude kept, so no snapshot may
  // publish under either branch.
  if (input.membership.ambiguousPointerContinuation) {
    return "ambiguous_pointer_continuation";
  }
  // Two off-path results claiming one call: picking one would be arrival
  // order dressed up as evidence.
  if ((input.membership.ambiguousResultIds?.size ?? 0) > 0) {
    return "ambiguous_tool_results";
  }
  return undefined;
}

/**
 * Resolve the set of record uuids on the active branch.
 *
 * A session file holds a tree, not a list: a rewind leaves the abandoned path
 * in place. `last-prompt.leafUuid` names the leaf the user actually kept, and
 * walking parents from it — following `logicalParentUuid` across a compaction
 * boundary, which severs `parentUuid` — yields the path that survived. When
 * timeline rows have been appended after a stale pointer, the same unique
 * forward-continuation rule as the publishing runner is applied.
 *
 * Returns undefined when the trace carries no `last-prompt`, in which case
 * every record is treated as on-branch rather than guessing.
 */
export async function computeActiveAncestry(
  tracePath: string,
): Promise<ReadonlySet<string> | undefined> {
  const rows: { value: unknown; lineNumber: number }[] = [];

  await readJsonlForward(tracePath, (event) => {
    if (event.kind !== "record") return;
    rows.push({ value: event.value, lineNumber: event.lineNumber });
  });

  return computeActiveMembership(rows).ancestry;
}

export interface DiscoveredSubagent {
  readonly filePath: string;
  readonly agentId: string;
  /** Set for agents nested under subagents/workflows/<wf-id>/. */
  readonly workflowId?: string;
}

interface NormalizedChild {
  readonly parentTurnId: string;
  readonly agentId: string;
  readonly role: string;
  readonly outcome: BarbaroTurnOutcome;
  readonly changedPaths: readonly string[];
  readonly evidence: readonly BarbaroEvidenceV1[];
}

interface ChildBundle {
  readonly files: number;
  readonly children: readonly NormalizedChild[];
  readonly withheldUnresolved: number;
  readonly withheldGrowing: number;
  readonly missingExpected: number;
  /**
   * Parent turns with at least one child not yet publishable. A digest names
   * the evidence its children produced, so publishing it now would freeze an
   * incomplete rollup that the append store could never accept a correction
   * to. The parent waits for its children.
   */
  readonly blockedParents: ReadonlySet<string>;
  readonly pendingAgentIds: ReadonlySet<string>;
}

async function normalizeChildren(
  tracePath: string,
  nativeSessionId: string,
  projectRoot: string,
  sessionId: string,
  agentLinks: ReadonlyMap<string, ClaudeAgentLink>,
  workflowLinks: ReadonlyMap<string, ClaudeWorkflowLink>,
  isAgentComplete: (agentId: string) => boolean,
): Promise<ChildBundle> {
  const discovered = await discoverSubagentFiles(tracePath);
  const children: NormalizedChild[] = [];
  // Journals are read from the workflows directory directly. Deriving them
  // from the child files present would make a workflow whose only child has
  // not appeared yet look like a workflow with nothing expected.
  const journalCache = await discoverWorkflowJournals(tracePath);
  const blockedParents = new Set<string>();
  const pendingAgentIds = new Set<string>();
  let withheldUnresolved = 0;
  let withheldGrowing = 0;
  let missingExpected = 0;

  // Every agent the parent launched is expected to have a trace. If one has
  // not appeared yet the parent's picture is incomplete, so the parent waits
  // rather than publishing a rollup that omits it.
  const present = new Set(discovered.map((item) => item.agentId));
  for (const [agentId, link] of agentLinks) {
    if (!present.has(agentId)) {
      missingExpected += 1;
      blockedParents.add(link.parentTurnId);
      pendingAgentIds.add(agentId);
    }
  }

  for (const found of discovered) {
    const journal = found.workflowId
      ? (journalCache.get(found.workflowId) ?? EMPTY_JOURNAL)
      : EMPTY_JOURNAL;

    // A workflow journal is both the parentage proof and the completion
    // ledger. A missing, malformed, or torn journal cannot safely support any
    // child publication, even if its complete prefix happened to name this
    // agent.
    if (found.workflowId && !journal.complete) {
      withheldUnresolved += 1;
      const candidate = workflowLinks.get(found.workflowId)?.parentTurnId;
      if (candidate) blockedParents.add(candidate);
      pendingAgentIds.add(found.agentId);
      continue;
    }

    const parent = resolveParent(found, agentLinks, workflowLinks, journal.known);
    if (!parent) {
      // An unresolved parent may simply not have been written yet. Withhold
      // the child rather than publish evidence no digest can reach. When the
      // intended parent is still identifiable — a workflow whose run is known
      // but whose journal has not yet attested this agent — hold that digest
      // back too, so its rollup is not frozen while incomplete.
      withheldUnresolved += 1;
      const candidate = found.workflowId
        ? workflowLinks.get(found.workflowId)?.parentTurnId
        : agentLinks.get(found.agentId)?.parentTurnId;
      if (candidate) blockedParents.add(candidate);
      pendingAgentIds.add(found.agentId);
      continue;
    }

    // Completion is attested from outside the child's own file: a direct
    // subagent's Agent tool result only exists once it returned, and a
    // workflow agent's `result` record likewise.
    const completed = found.workflowId
      ? journal.completed.has(found.agentId)
      : isAgentComplete(found.agentId);
    const child = await normalizeChildFile(
      found,
      nativeSessionId,
      projectRoot,
      sessionId,
      parent,
      completed,
    );
    if (!child) {
      withheldGrowing += 1;
      blockedParents.add(parent.parentTurnId);
      pendingAgentIds.add(found.agentId);
      continue;
    }
    children.push(child);
  }

  // Every Workflow result implies a journal artifact. Discovering only the
  // directories that already exist would let a temporarily absent workflow
  // publish an immutable parent rollup containing no children.
  for (const [workflowId, link] of workflowLinks) {
    const journal = journalCache.get(workflowId);
    if (!journal?.complete) {
      missingExpected += 1;
      blockedParents.add(link.parentTurnId);
      continue;
    }
    for (const agentId of journal.known) {
      if (present.has(agentId)) continue;
      missingExpected += 1;
      blockedParents.add(link.parentTurnId);
      pendingAgentIds.add(agentId);
    }
  }

  return {
    files: discovered.length,
    children,
    withheldUnresolved,
    withheldGrowing,
    missingExpected,
    blockedParents,
    pendingAgentIds,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface ResolvedParent {
  readonly parentTurnId: string;
  readonly nativeKey: string;
  readonly role: string;
}

/**
 * Direct subagents join by agentId through the parent's Agent/Task tool
 * result.
 *
 * Workflow agents have no such call in the parent, so the join runs
 * workflow directory name -> parent Workflow result runId -> tool_use_id ->
 * parent turn, corroborated by that workflow's journal.jsonl. A matching
 * directory name alone proves co-location, not parentage, so it is not
 * sufficient. An unresolved parent is never guessed.
 */
function resolveParent(
  found: DiscoveredSubagent,
  agentLinks: ReadonlyMap<string, ClaudeAgentLink>,
  workflowLinks: ReadonlyMap<string, ClaudeWorkflowLink>,
  journalAgents: ReadonlySet<string>,
): ResolvedParent | undefined {
  const direct = agentLinks.get(found.agentId);
  if (direct) {
    return {
      parentTurnId: direct.parentTurnId,
      nativeKey: found.agentId,
      role: direct.role,
    };
  }
  if (!found.workflowId) return undefined;
  const workflow = workflowLinks.get(found.workflowId);
  if (!workflow || !journalAgents.has(found.agentId)) return undefined;
  return {
    parentTurnId: workflow.parentTurnId,
    nativeKey: `${found.workflowId}/${found.agentId}`,
    role: "workflow-agent",
  };
}

/**
 * Normalize one child trace into one evidence record per child turn.
 *
 * Returns undefined when the child is still growing — an open turn that never
 * reached a terminal record means more of its work is still to come, and
 * publishing now would produce a record the next run must revise.
 */
async function normalizeChildFile(
  found: DiscoveredSubagent,
  nativeSessionId: string,
  projectRoot: string,
  sessionId: string,
  parent: ResolvedParent,
  externallyTerminated: boolean,
): Promise<NormalizedChild | undefined> {
  const traceId = claudeAgentTraceId(nativeSessionId, found);
  const normalizer = new ClaudeTurnNormalizer({
    nativeSessionId,
    actorId: found.agentId,
    workspaceRoot: projectRoot,
    isSubagentTrace: true,
  });
  const childTurns: BarbaroTurnV1[] = [];
  // The reader summary is retained, not discarded: a torn tail, a malformed
  // row, or a file that changed identity mid-read all mean this child is not
  // safe to publish yet.
  const summary = await readJsonlForward(found.filePath, (event) => {
    if (event.kind !== "record") return;
    childTurns.push(
      ...normalizer.accept(event.value, {
        traceId,
        lineNumber: event.lineNumber,
      }).turns,
    );
  });
  if (summary.partialFinalLine !== undefined) return undefined;
  if (summary.malformedLines > 0) return undefined;
  const afterRead = await resolveJsonlCheckpoint(
    found.filePath,
    createJsonlCheckpoint(summary),
  ).catch(() => undefined);
  if (
    afterRead?.status !== "resume" ||
    afterRead.snapshot?.size !== summary.observedSize
  ) {
    return undefined;
  }

  childTurns.push(...normalizer.finish({ externallyTerminated }).turns);
  if (normalizer.hasOpenTurn) return undefined;
  if (childTurns.length === 0) return undefined;

  const changedPaths = new Set<string>();
  const evidence: BarbaroEvidenceV1[] = [];
  for (const turn of childTurns) {
    for (const action of turn.actions) {
      if (action.kind === "file_change") changedPaths.add(action.path);
    }
    evidence.push({
      schema: "barbaro.evidence.v1",
      // Identity comes from the child's own turn and artifact, never from the
      // parent: a child must not change ID when its parent resolves.
      evidence_id: createEvidenceId(turn.turn_id, traceId, 0),
      // A subagent evidence record describes the child turn itself. The
      // owning human turn is the explicit parent link, not an overloaded
      // turn_id whose value changes when resolution arrives.
      turn_id: turn.turn_id,
      provider: "claude",
      session_id: sessionId,
      agent_id: found.agentId,
      parent_turn_id: parent.parentTurnId,
      parent_link: { method: "joined", native_key: parent.nativeKey },
      kind: "subagent_turn",
      occurred_at: turn.ended_at,
      content: {
        role: parent.role,
        sequence: turn.sequence,
        outcome: turn.outcome,
        started_at: turn.started_at,
        ended_at: turn.ended_at,
        request: turn.request,
        ...(turn.response === undefined ? {} : { response: turn.response }),
        actions: turn.actions,
      },
      source_refs: turn.source_refs,
      extensions: {
        claude: {
          subagent_kind: found.workflowId
            ? "workflow_agent"
            : "direct_agent",
          ...(found.workflowId === undefined
            ? {}
            : { workflow_id: found.workflowId }),
        },
      },
    });
  }

  const last = childTurns[childTurns.length - 1];
  return {
    parentTurnId: parent.parentTurnId,
    agentId: found.agentId,
    role: parent.role,
    outcome: last?.outcome ?? "unknown",
    changedPaths: [...changedPaths].sort(),
    evidence,
  };
}

/** Fold resolved children into the parent digests that spawned them. */
function enrichRollups(
  turns: readonly BarbaroTurnV1[],
  children: readonly NormalizedChild[],
): BarbaroTurnV1[] {
  if (children.length === 0) return [...turns];
  const byParent = new Map<string, NormalizedChild[]>();
  for (const child of children) {
    const bucket = byParent.get(child.parentTurnId);
    if (bucket) bucket.push(child);
    else byParent.set(child.parentTurnId, [child]);
  }

  return turns.map((turn) => {
    const mine = byParent.get(turn.turn_id);
    if (!mine || mine.length === 0) return turn;

    const byRole = new Map<string, number>();
    const outcomes: Partial<Record<BarbaroTurnOutcome, number>> = {};
    const changedPaths = new Set<string>(turn.subagents.changed_paths);
    const evidenceRefs: string[] = [];
    for (const child of mine) {
      byRole.set(child.role, (byRole.get(child.role) ?? 0) + 1);
      outcomes[child.outcome] = (outcomes[child.outcome] ?? 0) + 1;
      for (const path of child.changedPaths) changedPaths.add(path);
      for (const item of child.evidence) evidenceRefs.push(item.evidence_id);
    }

    return {
      ...turn,
      subagents: {
        total: mine.length,
        by_role: [...byRole.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([role, count]) => ({ role, count })),
        outcomes,
        changed_paths: [...changedPaths].sort(),
        evidence_refs: evidenceRefs,
      },
      // The digest must name every child evidence record it summarizes.
      evidence_refs: [...turn.evidence_refs, ...evidenceRefs],
    };
  });
}

/**
 * Subagent traces are separate files, never interleaved into the session file:
 *   <session>/subagents/agent-<agentId>.jsonl
 *   <session>/subagents/workflows/<wf-id>/agent-<agentId>.jsonl
 */
export async function discoverSubagentFiles(
  tracePath: string,
): Promise<DiscoveredSubagent[]> {
  const sessionDirectory = tracePath.replace(/\.jsonl$/, "");
  const root = join(sessionDirectory, "subagents");
  const found: DiscoveredSubagent[] = [];
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return found;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && isAgentFile(entry.name)) {
      found.push({
        filePath: join(root, entry.name),
        agentId: agentIdFromFilename(entry.name),
      });
    }
  }

  const workflowRoot = join(root, "workflows");
  const workflowStat = await stat(workflowRoot).catch(() => undefined);
  if (workflowStat?.isDirectory()) {
    for (const workflow of await readdir(workflowRoot, { withFileTypes: true })) {
      if (!workflow.isDirectory()) continue;
      const workflowDirectory = join(workflowRoot, workflow.name);
      for (const entry of await readdir(workflowDirectory, {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !isAgentFile(entry.name)) continue;
        found.push({
          filePath: join(workflowDirectory, entry.name),
          agentId: agentIdFromFilename(entry.name),
          workflowId: workflow.name,
        });
      }
    }
  }

  return found.sort((left, right) =>
    left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0,
  );
}

/**
 * Read every workflow journal under a session, keyed by workflow id.
 *
 * Discovery walks `subagents/workflows/` itself so a workflow is still known
 * when none of its agent files have been written yet. Deriving journals from
 * the child files present would make a workflow whose only child has not
 * appeared look like a workflow with nothing expected.
 */
export async function discoverWorkflowJournals(
  tracePath: string,
): Promise<Map<string, WorkflowJournal>> {
  const journals = new Map<string, WorkflowJournal>();
  const root = join(tracePath.replace(/\.jsonl$/, ""), "subagents", "workflows");
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return journals;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    journals.set(entry.name, await readWorkflowJournal(join(root, entry.name)));
  }
  return journals;
}

export interface WorkflowJournal {
  /** Agents the journal mentions at all — corroborates parentage. */
  readonly known: ReadonlySet<string>;
  /** Agents with a `result` record — proves the agent finished. */
  readonly completed: ReadonlySet<string>;
  /** False for missing, malformed, or torn journals. */
  readonly complete: boolean;
}

/**
 * A workflow journal is the only place a workflow agent's completion is
 * recorded. The agent's own file usually stops after its last tool_use and
 * never writes an `end_turn`.
 */
export async function readWorkflowJournal(
  workflowDirectory: string,
): Promise<WorkflowJournal> {
  const known = new Set<string>();
  const completed = new Set<string>();
  const journal = join(workflowDirectory, "journal.jsonl");
  const summary = await readJsonlForward(journal, (event) => {
    if (event.kind !== "record") return;
    const value = event.value as { type?: unknown; agentId?: unknown };
    if (typeof value.agentId !== "string") return;
    if (value.type === "started" || value.type === "result") {
      known.add(value.agentId);
    }
    if (value.type === "result") completed.add(value.agentId);
  }).catch(() => undefined);
  const afterRead = summary
    ? await resolveJsonlCheckpoint(
        journal,
        createJsonlCheckpoint(summary),
      ).catch(() => undefined)
    : undefined;
  return {
    known,
    completed,
    complete:
      summary !== undefined &&
      summary.malformedLines === 0 &&
      summary.partialFinalLine === undefined &&
      afterRead?.status === "resume" &&
      afterRead.snapshot?.size === summary.observedSize,
  };
}

/**
 * A Claude session is several physical files, so a trace id names the
 * artifact, not just the session. Otherwise a source reference cannot say
 * which file its line numbers belong to.
 */
export function claudeMainTraceId(nativeSessionId: string): string {
  return `claude:${nativeSessionId}:main`;
}

/**
 * The one canonical location for a main trace's replay checkpoint.
 *
 * Hook-side read-only probes use the same watermark as the publishing runner;
 * keeping the path derivation here prevents a harmless refactor from making
 * those two consumers silently watch different state files.
 */
export function claudeRunnerStatePath(
  tracePath: string,
  barbaroDirectory: string,
): string {
  return join(
    resolve(barbaroDirectory),
    "state",
    "claude",
    `${hashKey(`path:${resolve(tracePath)}`)}.json`,
  );
}

export function claudeAgentTraceId(
  nativeSessionId: string,
  found: DiscoveredSubagent,
): string {
  return found.workflowId
    ? `claude:${nativeSessionId}:workflow:${found.workflowId}:agent:${found.agentId}`
    : `claude:${nativeSessionId}:agent:${found.agentId}`;
}

export function claudeWorkflowJournalTraceId(
  nativeSessionId: string,
  workflowId: string,
): string {
  return `claude:${nativeSessionId}:workflow:${workflowId}:journal`;
}

function isAgentFile(name: string): boolean {
  return name.startsWith("agent-") && name.endsWith(".jsonl");
}

function agentIdFromFilename(name: string): string {
  return name.slice("agent-".length, -".jsonl".length);
}

function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function assertInsideProject(projectRoot: string, target: string): void {
  const candidate = relative(projectRoot, target);
  if (
    candidate === ".." ||
    candidate.startsWith("../") ||
    candidate.startsWith("..\\") ||
    isAbsolute(candidate)
  ) {
    throw new Error("Barbaro output directory must be inside the project root");
  }
}
