import type {
  BarbaroAction,
  BarbaroActionOutcome,
  BarbaroContent,
  BarbaroEvidenceV1,
  BarbaroSourceRef,
  BarbaroTurnOutcome,
  BarbaroTurnV1,
} from "../../contracts/v1.js";
import {
  createActionId,
  createEvidenceId,
  createSessionId,
  createTurnId,
} from "../../core/id.js";
import {
  excerptContent,
  isGeneratedBarbaroPath,
  normalizeRepoPath,
  normalizedContent,
  redactedExcerptContent,
  verbatimContent,
} from "../../core/content.js";
import {
  claudeRequestContent,
  claudeResponseContent,
  CLAUDE_FILE_CHANGE_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_SUBAGENT_TOOLS,
  isClaudeTestCommand,
} from "./content.js";
import {
  classifyUserRecord,
  CLAUDE_SIDECAR_TYPES,
  decodeClaudeEnvelope,
  decodeClaudeMessage,
  isObject,
  taskNotificationTaskId,
  taskNotificationToolUseId,
  numberField,
  stringField,
  type ClaudeContentBlock,
  type ClaudeEnvelope,
} from "./records.js";

/**
 * Canonical v1 records are never truncated: request, response and command text
 * are copied in full so the digest is lossless at the contract layer. Readers
 * apply their own byte budget and report how many actions they showed.
 *
 * Only excerpts — which are excerpts by definition — carry a bound.
 */
export const CLAUDE_FAILURE_EXCERPT_MAX_BYTES = 4096;
export const CLAUDE_SUMMARY_MAX_BYTES = 512;

export interface ClaudeSourceLocation {
  /**
   * Logical artifact id, e.g. `claude:<session>:main` or
   * `claude:<session>:workflow:<wf>:agent:<id>`. There is deliberately no
   * absolute path field: `.barbaro/` can be shared or committed, and a
   * machine path is both a leak and useless on another machine.
   */
  readonly traceId: string;
  readonly lineNumber: number;
  readonly byteStart?: number;
  readonly byteEndExclusive?: number;
}

export interface ClaudeNormalizationBatch {
  readonly turns: readonly BarbaroTurnV1[];
  readonly evidence: readonly BarbaroEvidenceV1[];
}

/** A resolved parent edge for one subagent, discovered in the parent session. */
export interface ClaudeAgentLink {
  readonly agentId: string;
  readonly parentTurnId: string;
  readonly role: string;
  readonly toolUseId: string;
  /** `completed` or `async_launched`; 47 of 51 real links are the latter. */
  readonly status?: string;
}

/** A resolved parent edge for one workflow run. */
export interface ClaudeWorkflowLink {
  readonly runId: string;
  readonly parentTurnId: string;
  readonly toolUseId: string;
}

export interface ClaudeNormalizerDiagnostics {
  readonly records: number;
  readonly invalid_records: number;
  readonly unknown_record_types: Readonly<Record<string, number>>;
  readonly human_turns_from_origin: number;
  readonly human_turns_from_structure: number;
  readonly skipped_sdk_prompts: number;
  readonly skipped_task_notifications: number;
  readonly task_notification_turns: number;
  readonly unknown_provenance_prompts: number;
  readonly segmentation_barriers: number;
  readonly late_lineage_recovered: number;
  readonly async_continuations: number;
  readonly suppressed_spans: number;
  readonly off_branch_records: number;
  readonly forks_observed: number;
  readonly compact_boundaries: number;
  readonly unpaired_tool_uses: number;
  readonly external_path_actions: number;
  readonly barbaro_self_actions_dropped: number;
}

export interface ClaudeNormalizerOptions {
  readonly nativeSessionId: string;
  /** "main" for a session file; the native agentId for a subagent file. */
  readonly actorId: string;
  readonly workspaceRoot?: string;
  /** Set when reading <session>/subagents/**, where all records are sidechain. */
  readonly isSubagentTrace?: boolean;
  /**
   * Record uuids on the path from `last-prompt.leafUuid` back to the root.
   *
   * A fork leaves both branches in the file. Without this, a record written
   * on a superseded path is still absorbed by the turn that started it —
   * a stale continuation can then win the terminal-response slot from the
   * response the user actually kept.
   */
  readonly activeAncestry?: ReadonlySet<string>;
  /**
   * `message.id`s with at least one row on the active ancestry.
   *
   * One API response is written as many rows and only some of them lie
   * directly on the leaf path, so filtering row-by-row tears real responses
   * apart — measured on the corpus it drops 58 sibling tool_use blocks from
   * 46 otherwise-active responses. Membership is decided per response group.
   */
  readonly activeMessageIds?: ReadonlySet<string>;
  /**
   * tool_use_ids whose result row lies on the active ancestry.
   *
   * When one exists it wins. Otherwise a result belonging to an accepted
   * parallel call is taken even though its row is off the leaf chain — the
   * call was accepted through its response group, so its result must close.
   */
  readonly onPathResultIds?: ReadonlySet<string>;
}

interface PendingCall {
  readonly toolUseId: string;
  /** Position of this tool_use within the turn, used to restore source order. */
  readonly orderIndex: number;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly recordUuid: string;
  readonly occurrence: number;
  readonly source: ClaudeSourceLocation;
}

interface PendingProviderEvent {
  readonly uuid: string;
  readonly occurredAt: string;
  readonly source: ClaudeSourceLocation;
  readonly content: Readonly<Record<string, unknown>>;
}

interface SubagentEntry {
  readonly agentId: string;
  role: string;
  outcome: BarbaroTurnOutcome;
  changedPaths: string[];
  evidenceIds: string[];
}

interface TurnBuilder {
  readonly nativeTurnKey: string;
  readonly turnId: string;
  readonly startedAt: string;
  readonly startSource: ClaudeSourceLocation;
  readonly startUuid: string;
  readonly request: BarbaroContent;
  readonly startMethod: "origin" | "structural" | "task-notification";
  readonly supersedes: readonly string[];
  lastTimestamp: string;
  lastUuid: string;
  lastLine: number;
  /**
   * Text blocks grouped by API response id, in first-seen order. One response
   * spans many rows, so the terminal response is every text block sharing the
   * last message.id — not merely the last row that happened to carry text.
   */
  readonly responseGroups: Map<
    string,
    { texts: string[]; uuid: string; at: string; line: number }
  >;
  terminal: boolean;
  lastToolName?: string;
  /**
   * Actions are materialized when their tool_result arrives, which with
   * parallel calls is not the order they were issued. Each entry keeps its
   * source position so the emitted list can be restored to source order.
   */
  readonly actions: { readonly orderIndex: number; readonly action: BarbaroAction }[];
  nextCallOrder: number;
  readonly evidenceIds: string[];
  readonly pendingCalls: Map<string, PendingCall>;
  /**
   * tool_use ids launched with `run_in_background: true` whose structured
   * task report has not arrived. While one is outstanding the turn can still
   * grow — the report CONTINUES this turn when it lands — so the turn must
   * not become canonical at end-of-input.
   */
  readonly pendingBackground: Set<string>;
  readonly usageByMessageId: Map<string, Readonly<Record<string, unknown>>>;
  /**
   * First row of each response that carried usage, in first-seen order.
   *
   * A line span alone is not precise enough: a suppressed foreign response
   * can lie between the first and last contributing rows, so the span would
   * contain more responses than the record counts. Naming the contributors
   * makes the citation exactly checkable.
   */
  readonly usageRows: Map<string, { uuid: string; line: number }>;
  readonly providerEvents: PendingProviderEvent[];
  readonly subagents: Map<string, SubagentEntry>;
  readonly models: Set<string>;
}

/**
 * Stateful, line-ordered normalizer for one Claude Code trace file.
 *
 * A turn runs from a genuine human prompt through the terminal outcome of that
 * interaction. `message.id` is used only to deduplicate usage: one API response
 * is written as one JSONL line per content block, each repeating the identical
 * usage object, so summing rows overstates output tokens by up to 15x.
 */
export class ClaudeTurnNormalizer {
  readonly #nativeSessionId: string;
  readonly #barbaroSessionId: string;
  readonly #actorId: string;
  #workspaceRoot: string | undefined;
  #observedCwd: string | undefined;
  readonly #isSubagentTrace: boolean;
  readonly #activeAncestry: ReadonlySet<string> | undefined;
  readonly #activeMessageIds: ReadonlySet<string> | undefined;
  readonly #onPathResultIds: ReadonlySet<string> | undefined;
  /** Whether the open turn began on the active branch. */
  #openOnActiveBranch = false;
  #offBranchRecords = 0;

  #open: TurnBuilder | undefined;
  #nextSequence = 1;
  #childCounts = new Map<string, number>();
  readonly #agentLinks = new Map<string, ClaudeAgentLink>();
  readonly #workflowLinks = new Map<string, ClaudeWorkflowLink>();
  /** parentUuid of a turn-start record -> index into #turnStartOrder. */
  readonly #turnStartsByParent = new Map<string, number[]>();
  /** Every turn id in start order, so a rewind can name all it displaces. */
  readonly #turnStartOrder: string[] = [];
  #pendingEvents: PendingProviderEvent[] = [];

  #records = 0;
  #invalidRecords = 0;
  readonly #unknownRecordTypes = new Map<string, number>();
  #humanFromOrigin = 0;
  #humanFromStructure = 0;
  #skippedSdk = 0;
  #skippedTaskNotifications = 0;
  /** Turns opened by our own background work reporting back. */
  #taskNotificationTurns = 0;
  #unknownProvenance = 0;
  #barriers = 0;
  #lateLineage = 0;
  #continuations = 0;
  #suppressedSpans = 0;
  /**
   * True while a foreign machine prompt's answer is being written into a
   * still-open human turn. Assistant work is dropped for the duration; the
   * turn's own outstanding tool results still resolve.
   */
  #suppressed = false;
  #suppressedMessageId: string | undefined;
  #suppressedGroupEnded = false;
  readonly #completedToolUseIds = new Set<string>();
  /**
   * Every tool_use ever issued, keyed by id, with the turn that issued it.
   *
   * Turn-scoped pending calls are cleared when a turn closes, but a result can
   * legitimately arrive afterwards — a user re-prompts while an async Agent
   * call is still outstanding. The action is lost with its turn, but the
   * lineage must not be: dropping it orphans the child trace.
   */
  readonly #issuedCalls = new Map<
    string,
    { name: string; turnId: string; input: Readonly<Record<string, unknown>> }
  >();
  #forks = 0;
  #compactBoundaries = 0;
  #unpairedToolUses = 0;
  #externalPathActions = 0;
  #selfActionsDropped = 0;

  constructor(options: ClaudeNormalizerOptions) {
    this.#nativeSessionId = options.nativeSessionId;
    this.#actorId = options.actorId;
    this.#workspaceRoot = options.workspaceRoot;
    this.#barbaroSessionId = createSessionId("claude", options.nativeSessionId);
    this.#isSubagentTrace = options.isSubagentTrace === true;
    this.#activeAncestry = options.activeAncestry;
    this.#activeMessageIds = options.activeMessageIds;
    this.#onPathResultIds = options.onPathResultIds;
  }

  get sessionId(): string {
    return this.#barbaroSessionId;
  }

  /** True while a turn is open, i.e. the current position is mid-turn. */
  get hasOpenTurn(): boolean {
    return this.#open !== undefined;
  }

  /** First `cwd` seen in the trace, used to verify the requested project. */
  get observedCwd(): string | undefined {
    return this.#observedCwd;
  }

  /**
   * Whether a launched subagent has actually finished.
   *
   * An `async_launched` Agent result is written the moment the child starts,
   * so its presence proves linkage, never completion. The child is done only
   * when the tool result says `completed`, or a later task notification names
   * the tool_use that launched it.
   */
  isAgentComplete(agentId: string): boolean {
    const link = this.#agentLinks.get(agentId);
    if (!link) return false;
    if (link.status === "completed") return true;
    return this.#completedToolUseIds.has(link.toolUseId);
  }

  /** Parent edges for workflow runs, keyed by native workflow runId. */
  workflowLinks(): ReadonlyMap<string, ClaudeWorkflowLink> {
    return this.#workflowLinks;
  }

  /** Parent edges for subagent files, keyed by native agentId. */
  agentLinks(): ReadonlyMap<string, ClaudeAgentLink> {
    return this.#agentLinks;
  }

  accept(
    value: unknown,
    source: ClaudeSourceLocation,
  ): ClaudeNormalizationBatch {
    this.#records += 1;
    const decoded = decodeClaudeEnvelope(value);
    if (!decoded.ok) {
      this.#invalidRecords += 1;
      return EMPTY_BATCH;
    }
    const envelope = decoded.envelope;

    if (envelope.cwd) {
      this.#observedCwd ??= envelope.cwd;
      this.#workspaceRoot ??= envelope.cwd;
    }
    this.#trackFork(envelope);

    if (CLAUDE_SIDECAR_TYPES.has(envelope.type)) return EMPTY_BATCH;

    switch (envelope.type) {
      case "user":
        return this.#acceptUser(envelope, source);
      case "assistant":
        return this.#acceptAssistant(envelope, source);
      case "system":
        return this.#acceptSystem(envelope, source);
      case "attachment":
        return EMPTY_BATCH;
      default:
        this.#unknownRecordTypes.set(
          envelope.type,
          (this.#unknownRecordTypes.get(envelope.type) ?? 0) + 1,
        );
        return EMPTY_BATCH;
    }
  }

  /**
   * Flush the open turn at end of input.
   *
   * By default only a turn that reached a terminal record is emitted. A turn
   * still in progress is deliberately left open so a live tail never publishes
   * a digest that a later run would have to contradict — its bytes are simply
   * re-read next time. Pass includeIncomplete for a trace known to be final.
   */
  finish(
    options: {
      includeIncomplete?: boolean;
      /**
       * Set when something outside this file proves the work ended — a parent
       * Agent tool result, or a workflow journal `result` record. Subagent
       * traces usually stop on `tool_use` and never write `end_turn`, so
       * without this they would look permanently in-flight.
       */
      externallyTerminated?: boolean;
      /**
       * Set when the caller asserts the source will not change again —
       * SessionEnd or an offline parse. Only then may a turn with an
       * outstanding background launch close: its report can no longer arrive.
       */
      sourceFinal?: boolean;
    } = {},
  ): ClaudeNormalizationBatch {
    const builder = this.#open;
    if (!builder) return EMPTY_BATCH;
    const external = options.externallyTerminated === true;
    if (!builder.terminal && !external && options.includeIncomplete !== true) {
      return EMPTY_BATCH;
    }
    // A terminal record is not the end of a turn that launched background
    // work: the structured task report CONTINUES this turn when it lands, so
    // closing now would emit a digest whose stable ID a later run recomputes
    // with more content. That is the exact sequence that corrupted two
    // sessions on 2026-08-18. The turn stays open until the report arrives, a
    // successor prompt closes it, or the caller proves the source is final.
    if (
      builder.pendingBackground.size > 0 &&
      !external &&
      options.includeIncomplete !== true &&
      options.sourceFinal !== true
    ) {
      return EMPTY_BATCH;
    }
    return this.#closeTurn(builder, external ? "external" : "eof");
  }

  diagnostics(): ClaudeNormalizerDiagnostics {
    return {
      records: this.#records,
      invalid_records: this.#invalidRecords,
      unknown_record_types: Object.fromEntries(
        [...this.#unknownRecordTypes.entries()].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
      human_turns_from_origin: this.#humanFromOrigin,
      human_turns_from_structure: this.#humanFromStructure,
      skipped_sdk_prompts: this.#skippedSdk,
      skipped_task_notifications: this.#skippedTaskNotifications,
      task_notification_turns: this.#taskNotificationTurns,
      unknown_provenance_prompts: this.#unknownProvenance,
      segmentation_barriers: this.#barriers,
      late_lineage_recovered: this.#lateLineage,
      async_continuations: this.#continuations,
      suppressed_spans: this.#suppressedSpans,
      off_branch_records: this.#offBranchRecords,
      forks_observed: this.#forks,
      compact_boundaries: this.#compactBoundaries,
      unpaired_tool_uses: this.#unpairedToolUses,
      external_path_actions: this.#externalPathActions,
      barbaro_self_actions_dropped: this.#selfActionsDropped,
    };
  }

  // --- record handlers -----------------------------------------------------

  #acceptUser(
    envelope: ClaudeEnvelope,
    source: ClaudeSourceLocation,
  ): ClaudeNormalizationBatch {
    const message = decodeClaudeMessage(envelope.raw);
    const provenance = classifyUserRecord(envelope, message, {
      isSubagentTrace: this.#isSubagentTrace,
    });

    if (provenance.kind === "tool-result") {
      return this.#acceptToolResults(envelope, message, source);
    }
    /** Set when a task notification opens a turn of its own below. */
    let opensOwnTurn = false;
    if (
      provenance.kind === "sdk" ||
      provenance.kind === "task-notification" ||
      provenance.kind === "unknown-provenance"
    ) {
      let ownWorkReportingBack = false;
      /**
       * A harness-structured task report on the live branch. Deliberately not
       * "ours": nothing in the record proves which call produced it, and the
       * stamped provenance is what protects attribution.
       */
      let structuredTaskReport = false;
      if (provenance.kind === "sdk") this.#skippedSdk += 1;
      else if (provenance.kind === "task-notification") {
        this.#skippedTaskNotifications += 1;
        structuredTaskReport =
          taskNotificationTaskId(collectText(message?.content ?? [])) !==
            undefined && !this.#isOffBranch(envelope.uuid);
        // A task notification is how an async child reports that it finished.
        // The launching tool_use id is the only link back.
        const completed = taskNotificationToolUseId(
          collectText(message?.content ?? []),
        );
        if (completed) {
          // Completion/linkage is recorded no matter which turn launched it.
          this.#completedToolUseIds.add(completed);
          // The report has landed, so the launch can no longer extend the
          // turn that issued it: the growth hazard is over.
          this.#open?.pendingBackground.delete(completed);
          // But it only CONTINUES the turn that is currently open. A
          // notification for work launched by an earlier or superseded turn
          // must not annex its span into whatever turn is open now.
          const issued = this.#issuedCalls.get(completed);
          // Ownership is not merely "same turn": the notification itself must
          // sit on the active ancestry. One written on a superseded path
          // reports real completion, but its span belongs to a branch the
          // user discarded and must not extend the turn that survived.
          const offBranch = this.#isOffBranch(envelope.uuid);
          if (offBranch) this.#offBranchRecords += 1;
          ownWorkReportingBack =
            issued !== undefined &&
            this.#open !== undefined &&
            issued.turnId === this.#open.turnId &&
            this.#openOnActiveBranch &&
            !offBranch;
        }
      } else this.#unknownProvenance += 1;

      // A notification naming a tool_use THIS session issued is our own async
      // child reporting back, so the work that follows continues the human
      // request that launched it. Barriering there discards the bulk of an
      // async session: one real trace lost 3 of 4 workflows and 19 subagents.
      if (ownWorkReportingBack) {
        this.#continuations += 1;
        return EMPTY_BATCH;
      }

      // A notification with no live turn to continue opens a turn of its own.
      // Suppressing it instead discards the work outright, and that work is
      // real: a watcher wake is answered with commands, edits and conclusions
      // that no human turn will ever carry.
      //
      // The barrier below exists to stop foreign input being ANNEXED into a
      // human turn, misattributing machine-driven work to a human request.
      // Opening a separate turn stamped `turn_start.method:
      // "task-notification"` cannot misattribute anything, so the narrower
      // "names a call we issued" test is not what protects attribution — the
      // stamp is. That test is also unusable here: a notification carries only
      // `<task-id>`, whose sole link to the issuing call is prose inside a
      // tool result, and inferring from that would be a guess.
      //
      // A still-working turn is left to the suppression path, because closing
      // it would orphan its outstanding tool results.
      opensOwnTurn =
        structuredTaskReport &&
        (this.#open === undefined || this.#open.terminal);
      if (!opensOwnTurn) {
        // Otherwise the input is foreign. If the turn already terminated it is
        // closed outright. If it is still working, closing would orphan its
        // outstanding tool results, so the span is suppressed instead: the
        // assistant work answering the foreign prompt is ignored rather than
        // annexed, while the human turn's own pending results still resolve.
        this.#barriers += 1;
        // Every barrier starts a fresh span. Carrying the previous span's group
        // state forward makes the next foreign response look like a new group
        // arriving after a finished one, so it is mistaken for resumed human
        // work and leaks into the turn.
        this.#suppressedMessageId = undefined;
        this.#suppressedGroupEnded = false;
        if (this.#open && this.#open.terminal) {
          this.#suppressed = false;
          return this.#closeTurn(this.#open, "next-prompt");
        }
        this.#suppressed = true;
        return EMPTY_BATCH;
      }
    }
    if (provenance.kind !== "human" && !opensOwnTurn) return EMPTY_BATCH;

    // A new human prompt closes any turn still open.
    const emitted: BarbaroTurnV1[] = [];
    const evidence: BarbaroEvidenceV1[] = [];
    if (this.#open) {
      const closed = this.#closeTurn(this.#open, "next-prompt");
      emitted.push(...closed.turns);
      evidence.push(...closed.evidence);
    }

    // A real prompt always ends any suppressed span.
    this.#suppressed = false;
    this.#suppressedMessageId = undefined;
    this.#suppressedGroupEnded = false;
    if (provenance.kind !== "human") this.#taskNotificationTurns += 1;
    else if (provenance.method === "origin") this.#humanFromOrigin += 1;
    else this.#humanFromStructure += 1;

    const startUuid = envelope.uuid ?? `line:${source.lineNumber}`;
    const startedAt = envelope.timestamp ?? EPOCH;
    const turnId = createTurnId(
      "claude",
      this.#nativeSessionId,
      this.#actorId,
      startUuid,
    );
    // A rewind re-prompts from an earlier record, so two turn starts share one
    // parentUuid. Everything started at or after the earliest displaced
    // sibling belongs to the branch being replaced, not just that sibling, so
    // the whole abandoned run is named. Sequence stays source append order and
    // nothing already emitted is ever rewritten.
    const siblingIndexes = envelope.parentUuid
      ? (this.#turnStartsByParent.get(envelope.parentUuid) ?? [])
      : [];
    const earliest = siblingIndexes[0];
    const supersedes =
      earliest === undefined ? [] : this.#turnStartOrder.slice(earliest);
    if (envelope.parentUuid) {
      this.#turnStartsByParent.set(envelope.parentUuid, [
        ...siblingIndexes,
        this.#turnStartOrder.length,
      ]);
    }
    this.#turnStartOrder.push(turnId);
    const rawText = collectText(message?.content ?? []);
    const request =
      claudeRequestContent(rawText) ??
      normalizedContent("", Buffer.byteLength(rawText, "utf8"));

    this.#open = {
      nativeTurnKey: startUuid,
      turnId,
      supersedes,
      startedAt,
      startSource: source,
      startUuid,
      request,
      startMethod:
        provenance.kind === "human" ? provenance.method : "task-notification",
      lastTimestamp: startedAt,
      lastUuid: startUuid,
      lastLine: source.lineNumber,
      terminal: false,
      actions: [],
      nextCallOrder: 0,
      responseGroups: new Map(),
      evidenceIds: [],
      pendingCalls: new Map(),
      pendingBackground: new Set(),
      usageByMessageId: new Map(),
      usageRows: new Map(),
      providerEvents: this.#pendingEvents,
      subagents: new Map(),
      models: new Set(),
    };
    this.#pendingEvents = [];
    this.#openOnActiveBranch =
      this.#activeAncestry === undefined || this.#activeAncestry.has(startUuid);

    return emitted.length > 0 || evidence.length > 0
      ? { turns: emitted, evidence }
      : EMPTY_BATCH;
  }

  #acceptAssistant(
    envelope: ClaudeEnvelope,
    source: ClaudeSourceLocation,
  ): ClaudeNormalizationBatch {
    const builder = this.#open;
    if (!builder) return EMPTY_BATCH;
    if (this.#suppressed) {
      // Answering a foreign prompt. Ignoring the prompt alone is not enough:
      // without this the assistant actions that follow are annexed by the
      // human turn that happened to still be open.
      const foreignMessage = decodeClaudeMessage(envelope.raw);
      const foreignGroup = foreignMessage?.id;
      if (
        this.#suppressedGroupEnded &&
        foreignGroup !== undefined &&
        foreignGroup !== this.#suppressedMessageId
      ) {
        // The foreign response group finished and a new group has begun: the
        // span is over. Suppression covers the WHOLE group — lifting on its
        // first end_turn row leaks the remaining rows into the human turn.
        this.#suppressed = false;
        this.#suppressedMessageId = undefined;
        this.#suppressedGroupEnded = false;
      } else {
        this.#suppressedSpans += 1;
        if (foreignGroup !== undefined && foreignGroup !== this.#suppressedMessageId) {
          this.#suppressedMessageId = foreignGroup;
          this.#suppressedGroupEnded = false;
        }
        if (foreignMessage?.stopReason === "end_turn") {
          this.#suppressedGroupEnded = true;
        }
        return EMPTY_BATCH;
      }
    }
    if (this.#isOffBranch(envelope.uuid, decodeClaudeMessage(envelope.raw)?.id)) {
      // Written on a path the user rewound away from: the span is suppressed,
      // but the calls it issued are still registered so a result arriving
      // later can resolve its parent. Dropping the lineage too would orphan a
      // child trace whose launch happened to land on a superseded record.
      this.#offBranchRecords += 1;
      const offBranchMessage = decodeClaudeMessage(envelope.raw);
      for (const block of offBranchMessage?.content ?? []) {
        if (block.type !== "tool_use") continue;
        this.#issuedCalls.set(block.id, {
          name: block.name,
          turnId: builder.turnId,
          input: block.input,
        });
      }
      return EMPTY_BATCH;
    }
    const message = decodeClaudeMessage(envelope.raw);
    if (!message) return EMPTY_BATCH;

    this.#touch(builder, envelope, source);
    if (message.model) builder.models.add(message.model);

    // Usage deduplication: one API response spans many lines, each repeating
    // the same usage object. Keying by message.id keeps exactly one copy.
    if (message.id && message.usage) {
      builder.usageByMessageId.set(message.id, message.usage);
      if (!builder.usageRows.has(message.id)) {
        builder.usageRows.set(message.id, {
          uuid: envelope.uuid ?? builder.lastUuid,
          line: source.lineNumber,
        });
      }
    }

    const groupKey = message.id ?? `line:${source.lineNumber}`;
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") {
        const group = builder.responseGroups.get(groupKey);
        if (group) {
          group.texts.push(block.text);
        } else {
          builder.responseGroups.set(groupKey, {
            texts: [block.text],
            uuid: envelope.uuid ?? builder.lastUuid,
            at: envelope.timestamp ?? builder.lastTimestamp,
            line: source.lineNumber,
          });
        }
      } else if (block.type === "tool_use") {
        this.#issuedCalls.set(block.id, {
          name: block.name,
          turnId: builder.turnId,
          input: block.input,
        });
        builder.pendingCalls.set(block.id, {
          toolUseId: block.id,
          orderIndex: builder.nextCallOrder++,
          name: block.name,
          input: block.input,
          recordUuid: envelope.uuid ?? `line:${source.lineNumber}`,
          occurrence: index,
          source,
        });
        if (
          typeof block.input === "object" &&
          block.input !== null &&
          (block.input as Record<string, unknown>).run_in_background === true
        ) {
          builder.pendingBackground.add(block.id);
        }
      }
    }

    // stop_reason repeats on every line of one API response, including the
    // first. Closing here would drop the text blocks that follow, so the turn
    // is only marked terminal; it is emitted at the next prompt or at finish().
    if (message.stopReason === "end_turn") builder.terminal = true;
    return EMPTY_BATCH;
  }

  #acceptToolResults(
    envelope: ClaudeEnvelope,
    message: ReturnType<typeof decodeClaudeMessage>,
    source: ClaudeSourceLocation,
  ): ClaudeNormalizationBatch {
    if (!message) return EMPTY_BATCH;
    const builder = this.#open;
    // A result row is judged by the call it closes, not by its own position.
    // Rejecting on uuid first drops every parallel sibling's result, leaving
    // the call it belongs to permanently unpaired.
    const closesAcceptedCall =
      builder !== undefined &&
      message.content.some(
        (block) =>
          block.type === "tool_result" &&
          builder.pendingCalls.has(block.toolUseId) &&
          !(this.#onPathResultIds?.has(block.toolUseId) ?? false),
      );
    const offBranch =
      this.#isOffBranch(envelope.uuid) && !closesAcceptedCall;
    if (!builder || offBranch) {
      // Either the issuing turn already closed, or this result was written on
      // a superseded path. Lineage is still recovered — but nothing here may
      // touch the active turn's timing, actions or provenance, or an
      // abandoned failure would be reported as the live turn's outcome.
      if (offBranch) this.#offBranchRecords += 1;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        this.#recordLateLineage(block.toolUseId, envelope.raw.toolUseResult);
      }
      return EMPTY_BATCH;
    }
    this.#touch(builder, envelope, source);

    const denialKind = stringField(envelope.raw, "toolDenialKind");
    const toolUseResult = envelope.raw.toolUseResult;

    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      // Prefer the on-ancestry result when one exists: an off-path duplicate
      // for the same call is a rewound attempt, not the outcome that stood.
      if (
        this.#onPathResultIds?.has(block.toolUseId) &&
        this.#isOffBranch(envelope.uuid)
      ) {
        this.#offBranchRecords += 1;
        continue;
      }
      const pending = builder.pendingCalls.get(block.toolUseId);
      if (!pending) {
        // Issued by an earlier turn that has since closed.
        this.#recordLateLineage(block.toolUseId, toolUseResult);
        continue;
      }
      builder.pendingCalls.delete(block.toolUseId);
      this.#materializeCall(builder, pending, {
        isError: block.isError,
        text: block.text,
        denialKind,
        toolUseResult,
        resultSource: source,
      });
    }
    return EMPTY_BATCH;
  }

  #acceptSystem(
    envelope: ClaudeEnvelope,
    source: ClaudeSourceLocation,
  ): ClaudeNormalizationBatch {
    const subtype = stringField(envelope.raw, "subtype");
    if (subtype !== "compact_boundary") return EMPTY_BATCH;
    if (this.#isOffBranch(envelope.uuid)) {
      // A boundary on a rewound path is not evidence for the live turn.
      this.#offBranchRecords += 1;
      return EMPTY_BATCH;
    }

    this.#compactBoundaries += 1;
    const metadata = isObject(envelope.raw.compactMetadata)
      ? envelope.raw.compactMetadata
      : {};
    const event: PendingProviderEvent = {
      uuid: envelope.uuid ?? `line:${source.lineNumber}`,
      occurredAt: envelope.timestamp ?? EPOCH,
      source,
      content: {
        event: "compact_boundary",
        trigger: stringField(metadata, "trigger") ?? "unknown",
        pre_tokens: numberField(metadata, "preTokens") ?? 0,
        post_tokens: numberField(metadata, "postTokens") ?? 0,
        cumulative_dropped_tokens:
          numberField(metadata, "cumulativeDroppedTokens") ?? 0,
      },
    };

    // Compaction is never a turn boundary. Inside a turn it attaches to that
    // turn; between turns it attaches to the turn that follows, because what
    // compaction actually changes is the context the next turn runs against.
    if (this.#open) this.#open.providerEvents.push(event);
    else this.#pendingEvents.push(event);
    return EMPTY_BATCH;
  }

  // --- action materialization ---------------------------------------------

  #materializeCall(
    builder: TurnBuilder,
    pending: PendingCall,
    result: {
      isError: boolean | undefined;
      text: string | undefined;
      denialKind: string | undefined;
      toolUseResult: unknown;
      resultSource: ClaudeSourceLocation;
    },
  ): void {
    const detail = isObject(result.toolUseResult) ? result.toolUseResult : {};
    // One action spans the tool_use line through its tool_result line, so it
    // is one reference rather than two. Halves per-action reference overhead.
    const sourceRefs: BarbaroSourceRef[] = [
      {
        trace_id: pending.source.traceId,
        line_start: pending.source.lineNumber,
        line_end: Math.max(
          pending.source.lineNumber,
          result.resultSource.lineNumber,
        ),
        native_record_ids: [pending.recordUuid],
      },
    ];
    const actionId = createActionId(
      builder.turnId,
      pending.recordUuid,
      pending.occurrence,
    );

    if (CLAUDE_SUBAGENT_TOOLS.has(pending.name)) {
      this.#recordSubagent(builder, pending, detail);
      return;
    }
    if (pending.name === "Workflow") {
      // The parent edge for every agent inside this workflow. Without it a
      // workflow agent can only be matched on a directory name, which proves
      // co-location rather than parentage.
      const runId = stringField(detail, "runId");
      if (runId) {
        this.#workflowLinks.set(runId, {
          runId,
          parentTurnId: builder.turnId,
          toolUseId: pending.toolUseId,
        });
      }
    }
    builder.lastToolName = pending.name;

    const outcome = this.#actionOutcome(pending.name, result, detail);

    if (CLAUDE_FILE_CHANGE_TOOLS.has(pending.name)) {
      this.#pushFileChange(
        builder,
        pending,
        detail,
        outcome,
        actionId,
        sourceRefs,
      );
      return;
    }

    if (pending.name === "Bash") {
      const command = stringField(pending.input, "command") ?? "";
      // An exit code is copied only when the result is explicitly an error
      // AND the exact leading "Exit code N" marker is present. Successful
      // output frequently mentions exit codes in prose; without both gates a
      // number could be lifted out of unrelated text.
      const exit =
        result.isError === true ? parseExitCode(result.text) : undefined;
      const base = {
        action_id: actionId,
        outcome,
        command: verbatimContent(command),
        source_refs: sourceRefs,
        ...(exit === undefined ? {} : { exit_code: exit.code }),
        ...(outcome === "failed" || outcome === "denied" || outcome === "interrupted"
          ? failureExcerpt(exit?.rest ?? result.text)
          : {}),
      };
      builder.actions.push({
        orderIndex: pending.orderIndex,
        action: isClaudeTestCommand(command)
          ? { ...base, kind: "test" as const }
          : { ...base, kind: "command" as const },
      });
      return;
    }

    if (CLAUDE_READ_ONLY_TOOLS.has(pending.name) || pending.name.startsWith("mcp__")) {
      if (this.#targetsGeneratedOutput(pending)) {
        this.#selfActionsDropped += 1;
        return;
      }
      builder.actions.push({
        orderIndex: pending.orderIndex,
        action: {
          kind: "tool",
          action_id: actionId,
          outcome,
          tool_name: pending.name,
          source_refs: sourceRefs,
        },
      });
      return;
    }

    builder.actions.push({
      orderIndex: pending.orderIndex,
      action: {
        kind: "other",
        action_id: actionId,
        outcome,
        summary: excerptContent(pending.name, CLAUDE_SUMMARY_MAX_BYTES),
        source_refs: sourceRefs,
      },
    });
  }

  #pushFileChange(
    builder: TurnBuilder,
    pending: PendingCall,
    detail: Readonly<Record<string, unknown>>,
    outcome: BarbaroActionOutcome,
    actionId: string,
    sourceRefs: readonly BarbaroSourceRef[],
  ): void {
    const rawPath =
      stringField(detail, "filePath") ?? stringField(pending.input, "file_path");
    if (!rawPath) return;

    const repoPath = normalizeRepoPath(this.#workspaceRoot, rawPath);
    if (repoPath && isGeneratedBarbaroPath(repoPath)) {
      this.#selfActionsDropped += 1;
      return;
    }

    if (!repoPath) {
      // The frozen repoPath rule forbids leading "/" and "..", so a change
      // outside the workspace cannot be a file_change. Rather than drop it,
      // record an `other` action naming only the basename. See M1.
      // A constant string: no basename, no absolute path, and
      // original_utf8_bytes measures the emitted text so the discarded path's
      // length cannot be inferred from the record either.
      this.#externalPathActions += 1;
      builder.actions.push({
        orderIndex: pending.orderIndex,
        action: {
          kind: "other",
          action_id: actionId,
          outcome,
          summary: normalizedContent(
            EXTERNAL_FILE_CHANGE_SUMMARY,
            EXTERNAL_FILE_CHANGE_SUMMARY_BYTES,
          ),
          source_refs: [...sourceRefs],
        },
      });
      return;
    }

    const patch = detail.structuredPatch;
    const counts = countPatchLines(patch);
    const original = detail.originalFile;
    const operation =
      typeof original === "string" && original.length > 0 ? "modify" : "create";

    builder.actions.push({
      orderIndex: pending.orderIndex,
      action: {
        kind: "file_change",
        action_id: actionId,
        outcome,
        operation,
        path: repoPath,
        source_refs: [...sourceRefs],
        ...(counts ? { added_lines: counts.added, removed_lines: counts.removed } : {}),
      },
    });
  }

  /**
   * Register the parent edge for a tool result whose issuing turn has already
   * been emitted. Only lineage is recovered; no action is produced, because
   * the turn it belonged to is immutable once published.
   */
  #recordLateLineage(toolUseId: string, toolUseResult: unknown): void {
    const issued = this.#issuedCalls.get(toolUseId);
    if (!issued) return;
    const detail = isObject(toolUseResult) ? toolUseResult : {};

    if (CLAUDE_SUBAGENT_TOOLS.has(issued.name)) {
      const agentId = stringField(detail, "agentId");
      if (!agentId || this.#agentLinks.has(agentId)) return;
      this.#lateLineage += 1;
      this.#agentLinks.set(agentId, {
        agentId,
        parentTurnId: issued.turnId,
        role:
          stringField(issued.input, "subagent_type") ??
          stringField(detail, "description") ??
          "agent",
        toolUseId,
        ...(stringField(detail, "status") === undefined
          ? {}
          : { status: stringField(detail, "status") as string }),
      });
      return;
    }
    if (issued.name === "Workflow") {
      const runId = stringField(detail, "runId");
      if (!runId || this.#workflowLinks.has(runId)) return;
      this.#lateLineage += 1;
      this.#workflowLinks.set(runId, {
        runId,
        parentTurnId: issued.turnId,
        toolUseId,
      });
    }
  }

  #recordSubagent(
    builder: TurnBuilder,
    pending: PendingCall,
    detail: Readonly<Record<string, unknown>>,
  ): void {
    const agentId = stringField(detail, "agentId");
    if (!agentId) return;
    const role =
      stringField(pending.input, "subagent_type") ??
      stringField(detail, "description") ??
      "agent";
    const status = stringField(detail, "status");
    builder.subagents.set(agentId, {
      agentId,
      role,
      outcome: status === "completed" ? "success" : "unknown",
      changedPaths: [],
      evidenceIds: [],
    });
    this.#agentLinks.set(agentId, {
      agentId,
      parentTurnId: builder.turnId,
      role,
      toolUseId: pending.toolUseId,
      ...(status === undefined ? {} : { status }),
    });
  }

  /**
   * Outcome precedence: denied -> interrupted -> is_error -> unknown.
   *
   * Bash failures DO surface: a failing call carries is_error:true and a
   * string toolUseResult (251 of 9,893 paired Bash results corpus-wide, 216
   * of them without a denial). What Claude never records is a numeric exit
   * code, so a Bash call that merely returned output cannot be proven to have
   * succeeded — that case, and only that case, stays `unknown`.
   */
  #actionOutcome(
    toolName: string,
    result: { isError: boolean | undefined; denialKind: string | undefined },
    detail: Readonly<Record<string, unknown>>,
  ): BarbaroActionOutcome {
    if (result.denialKind !== undefined) return "denied";
    if (detail.interrupted === true) return "interrupted";
    if (result.isError === true) return "failed";
    // No numeric exit code exists, so an unflagged Bash result proves only
    // that the command ran, never that it succeeded.
    if (toolName === "Bash") return "unknown";
    // Every other tool reports failure through is_error, so a result that is
    // not flagged is a result that was produced.
    return "success";
  }

  #targetsGeneratedOutput(pending: PendingCall): boolean {
    const candidate =
      stringField(pending.input, "file_path") ??
      stringField(pending.input, "path") ??
      stringField(pending.input, "pattern");
    if (!candidate) return false;
    const repoPath = normalizeRepoPath(this.#workspaceRoot, candidate);
    return repoPath !== undefined && isGeneratedBarbaroPath(repoPath);
  }

  // --- turn closing --------------------------------------------------------

  #closeTurn(
    builder: TurnBuilder,
    reason: "next-prompt" | "eof" | "external",
  ): ClaudeNormalizationBatch {
    this.#open = undefined;
    this.#unpairedToolUses += builder.pendingCalls.size;

    const evidence: BarbaroEvidenceV1[] = [];
    const usage = mergeUsage(builder.usageByMessageId);
    if (usage) {
      const evidenceId = createEvidenceId(builder.turnId, builder.startUuid, 1);
      builder.evidenceIds.push(evidenceId);
      evidence.push({
        schema: "barbaro.evidence.v1",
        evidence_id: evidenceId,
        turn_id: builder.turnId,
        provider: "claude",
        session_id: this.#barbaroSessionId,
        agent_id: this.#actorId,
        kind: "usage",
        occurred_at: builder.lastTimestamp,
        content: {
          ...usage,
          deduplicated_by: "message.id",
          api_responses: builder.usageByMessageId.size,
          ...(builder.supersedes.length > 0
            ? { supersedes_turn_ids: builder.supersedes }
            : {}),
        },
        // The rows that actually carried usage, named individually.
        source_refs: [
          {
            trace_id: builder.startSource.traceId,
            line_start: Math.min(
              ...[...builder.usageRows.values()].map((row) => row.line),
            ),
            line_end: Math.max(
              ...[...builder.usageRows.values()].map((row) => row.line),
            ),
            native_record_ids: [...builder.usageRows.values()].map(
              (row) => row.uuid,
            ),
          },
        ],
      });
    }

    const groups = [...builder.responseGroups.values()];
    const terminalGroup = groups.pop();
    for (const [index, prior] of groups
      .map((group) => ({
        text: group.texts.join("\n"),
        uuid: group.uuid,
        at: group.at,
        line: group.line,
      }))
      .entries()) {
      const evidenceId = createEvidenceId(builder.turnId, prior.uuid, index + 2);
      builder.evidenceIds.push(evidenceId);
      evidence.push({
        schema: "barbaro.evidence.v1",
        evidence_id: evidenceId,
        turn_id: builder.turnId,
        provider: "claude",
        session_id: this.#barbaroSessionId,
        agent_id: this.#actorId,
        kind: "response",
        occurred_at: prior.at,
        content: { text: verbatimContent(prior.text) },
        // The row that actually carried this text, not the turn's first row.
        source_refs: [
          {
            trace_id: builder.startSource.traceId,
            line_start: prior.line,
            line_end: prior.line,
            native_record_ids: [prior.uuid],
          },
        ],
      });
    }

    for (const [index, event] of builder.providerEvents.entries()) {
      const evidenceId = createEvidenceId(
        builder.turnId,
        event.uuid,
        index + 2 + builder.responseGroups.size,
      );
      builder.evidenceIds.push(evidenceId);
      evidence.push({
        schema: "barbaro.evidence.v1",
        evidence_id: evidenceId,
        turn_id: builder.turnId,
        provider: "claude",
        session_id: this.#barbaroSessionId,
        agent_id: this.#actorId,
        kind: "provider_event",
        occurred_at: event.occurredAt,
        content: event.content,
        source_refs: [this.#sourceRef(event.source, event.uuid)],
      });
    }

    const outcome = this.#deriveOutcome(builder, reason);
    const response = terminalGroup
      ? claudeResponseContent(terminalGroup.texts.join("\n"))
      : undefined;

    const subagents = [...builder.subagents.values()];
    const byRole = new Map<string, number>();
    const outcomes: Partial<Record<BarbaroTurnOutcome, number>> = {};
    const changedPaths = new Set<string>();
    for (const entry of subagents) {
      byRole.set(entry.role, (byRole.get(entry.role) ?? 0) + 1);
      outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
      for (const path of entry.changedPaths) changedPaths.add(path);
    }

    const turn: BarbaroTurnV1 = {
      schema: "barbaro.turn.v1",
      turn_id: builder.turnId,
      provider: "claude",
      session_id: this.#barbaroSessionId,
      sequence: this.#nextSequence,
      agent_id: this.#actorId,
      started_at: builder.startedAt,
      ended_at: builder.lastTimestamp,
      outcome,
      request: builder.request,
      ...(response ? { response } : {}),
      // Restored to source order: a stable sort on the issue position, not on
      // the order results happened to come back in.
      actions: [...builder.actions]
        .sort((left, right) => left.orderIndex - right.orderIndex)
        .map((entry) => entry.action),
      subagents: {
        total: subagents.length,
        by_role: [...byRole.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([role, count]) => ({ role, count })),
        outcomes,
        changed_paths: [...changedPaths].sort(),
        evidence_refs: subagents.flatMap((entry) => entry.evidenceIds),
      },
      evidence_refs: builder.evidenceIds,
      source_refs: [
        {
          trace_id: builder.startSource.traceId,
          line_start: builder.startSource.lineNumber,
          line_end: builder.lastLine,
          native_record_ids: [builder.startUuid, builder.lastUuid],
        },
      ],
      extensions: {
        claude: {
          native_turn_key: builder.nativeTurnKey,
          turn_start: { method: builder.startMethod },
          api_responses: builder.usageByMessageId.size,
          ...(builder.supersedes.length > 0
            ? { supersedes_turn_ids: builder.supersedes }
            : {}),
          ...(builder.models.size > 0
            ? { models: [...builder.models].sort() }
            : {}),
        },
      },
    };

    // Consumed only now: an open turn that is never emitted must not burn a
    // sequence number, or a resumed run would renumber it.
    this.#nextSequence += 1;
    return { turns: [turn], evidence };
  }

  #deriveOutcome(
    builder: TurnBuilder,
    reason: "next-prompt" | "eof" | "external",
  ): BarbaroTurnOutcome {
    const hasDenied = builder.actions.some((a) => a.action.outcome === "denied");
    const hasFailed = builder.actions.some((a) => a.action.outcome === "failed");
    const hasInterrupted = builder.actions.some(
      (a) => a.action.outcome === "interrupted",
    );
    if (!builder.terminal) {
      if (hasInterrupted) return "cancelled";
      // "external" means terminality is proven but the outcome is not, which
      // is exactly what `unknown` is for. Only a trace that simply stopped,
      // with nothing attesting completion, is `abandoned`.
      return reason === "eof" ? "abandoned" : "unknown";
    }
    // A question asked as the final act is what actually blocks the turn; an
    // earlier question that the agent then worked past does not.
    if (builder.lastToolName === "AskUserQuestion") return "blocked";
    if (hasDenied || hasFailed || hasInterrupted) return "partial";
    return "success";
  }

  // --- helpers -------------------------------------------------------------

  #touch(
    builder: TurnBuilder,
    envelope: ClaudeEnvelope,
    source: ClaudeSourceLocation,
  ): void {
    if (envelope.timestamp) builder.lastTimestamp = envelope.timestamp;
    if (envelope.uuid) builder.lastUuid = envelope.uuid;
    builder.lastLine = source.lineNumber;
  }

  /**
   * A record is off-branch when the open turn is on the active branch but the
   * record is not on the active ancestry — i.e. it lives on a path the user
   * rewound away from.
   *
   * A turn that itself began off the active branch is left alone: those turns
   * are still emitted in append order, carrying supersession forward, and
   * their own records belong to them.
   */
  #isOffBranch(
    uuid: string | undefined,
    messageId?: string | undefined,
  ): boolean {
    if (!this.#activeAncestry || !this.#openOnActiveBranch) return false;
    // A response group is active as a whole if any of its rows is on the
    // active path. Judging rows individually splits a live response and drops
    // its siblings — parallel tool calls in particular.
    if (messageId !== undefined && this.#activeMessageIds?.has(messageId)) {
      return false;
    }
    if (uuid === undefined) return false;
    return !this.#activeAncestry.has(uuid);
  }

  #trackFork(envelope: ClaudeEnvelope): void {
    const parent = envelope.parentUuid;
    if (!parent) return;
    const count = (this.#childCounts.get(parent) ?? 0) + 1;
    this.#childCounts.set(parent, count);
    if (count === 2) this.#forks += 1;
  }

  #sourceRef(
    source: ClaudeSourceLocation,
    nativeId: string | undefined,
  ): BarbaroSourceRef {
    // trace_path is deliberately omitted here: it is identical for every
    // record in a file and is carried once on the turn's own source_ref.
    // Repeating it per action dominated digest size on real traces.
    return {
      trace_id: source.traceId,
      line_start: source.lineNumber,
      line_end: source.lineNumber,
      ...(nativeId === undefined ? {} : { native_record_ids: [nativeId] }),
    };
  }
}

const EMPTY_BATCH: ClaudeNormalizationBatch = { turns: [], evidence: [] };
const EXTERNAL_FILE_CHANGE_SUMMARY = "file change outside workspace";
const EXTERNAL_FILE_CHANGE_SUMMARY_BYTES = Buffer.byteLength(
  EXTERNAL_FILE_CHANGE_SUMMARY,
  "utf8",
);
const EPOCH = "1970-01-01T00:00:00.000Z";

function collectText(blocks: readonly ClaudeContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

function failureExcerpt(
  text: string | undefined,
): { failure_excerpt: BarbaroContent } | Record<string, never> {
  if (!text) return {};
  return {
    failure_excerpt: redactedExcerptContent(
      text,
      CLAUDE_FAILURE_EXCERPT_MAX_BYTES,
    ),
  };
}

/**
 * Extract a shell exit status from a failing Bash tool result.
 *
 * The pattern is anchored to the first line and requires the exact
 * "Exit code <digits>" shape, so prose that merely mentions an exit code
 * elsewhere in the output can never be mistaken for a status.
 */
export function parseExitCode(
  text: string | undefined,
): { code: number; rest: string } | undefined {
  if (!text) return undefined;
  const match = /^Exit code (\d{1,5})(?:\n([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const code = Number(match[1]);
  if (!Number.isSafeInteger(code)) return undefined;
  return { code, rest: match[2] ?? "" };
}

function countPatchLines(
  patch: unknown,
): { added: number; removed: number } | undefined {
  if (!Array.isArray(patch)) return undefined;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    if (!isObject(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== "string" || line.length === 0) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

/** Sum usage across distinct message.id values — never across raw rows. */
function mergeUsage(
  byMessageId: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Record<string, number> | undefined {
  if (byMessageId.size === 0) return undefined;
  const fields = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const;
  const totals: Record<string, number> = {};
  for (const usage of byMessageId.values()) {
    for (const field of fields) {
      const value = usage[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[field] = (totals[field] ?? 0) + value;
      }
    }
  }
  return Object.keys(totals).length > 0 ? totals : undefined;
}
