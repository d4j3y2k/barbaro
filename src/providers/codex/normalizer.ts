import {
  createActionId,
  createEvidenceId,
  createSessionId,
  createTurnId,
} from "../../core/id.js";
import { isDigestExcludedBarbaroCommand } from "../../core/barbaro-command.js";
import { compareUtf16CodeUnits } from "../../core/stable-json.js";
import type {
  BarbaroAction,
  BarbaroActionOutcome,
  BarbaroEvidenceV1,
  BarbaroSourceRef,
  BarbaroSubagentRollup,
  BarbaroTurnOutcome,
  BarbaroTurnV1,
} from "../../contracts/v1.js";
import {
  extractCodexMessageText,
  isGeneratedBarbaroPath,
  normalizeRepoPath,
  redactedExcerptContent,
  verbatimContent,
} from "./content.js";
import {
  decodeCodexEnvelope,
  isObject,
  stringField,
  type CodexRolloutEnvelope,
} from "./envelope.js";
import {
  extractDirectCommand,
  extractExecCommands,
  isTestCommand,
} from "./tool-input.js";

const KNOWN_ROOT_TYPES = new Set([
  "session_meta",
  "response_item",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "compacted",
  "turn_context",
  "world_state",
  "event_msg",
  "security_risk_score",
]);

const KNOWN_EVENT_TYPES = new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "image_generation_end",
  "item_completed",
  "mcp_tool_call_end",
  "patch_apply_end",
  "sub_agent_activity",
  "task_complete",
  "task_started",
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied",
  "token_count",
  "turn_aborted",
  "turn_complete",
  "turn_started",
  "user_message",
  "web_search_end",
]);

const KNOWN_RESPONSE_TYPES = new Set([
  "agent_message",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "message",
  "reasoning",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
]);

const SESSION_SCOPED_EVENT_TYPES = new Set([
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied",
]);

export interface CodexSourceLocation {
  readonly traceId: string;
  readonly tracePath?: string;
  readonly lineNumber: number;
  readonly byteStart?: number;
  readonly byteEndExclusive?: number;
}

export interface CodexNormalizationBatch {
  readonly turns: readonly BarbaroTurnV1[];
  readonly evidence: readonly BarbaroEvidenceV1[];
}

export interface CodexNormalizerDiagnostics {
  readonly records: number;
  readonly invalid_envelopes: number;
  readonly unknown_root_types: Readonly<Record<string, number>>;
  readonly unknown_event_types: Readonly<Record<string, number>>;
  readonly unknown_response_types: Readonly<Record<string, number>>;
  readonly repeated_session_meta: number;
  readonly orphan_turn_records: number;
}

export interface CodexNormalizerStateV1 {
  readonly schema: "barbaro.codex-normalizer-state.v1";
  readonly session?: CanonicalSession;
  readonly current_turn_id?: string;
  readonly next_sequence: number;
  readonly turns: readonly SerializedTurnBuilder[];
  readonly diagnostics: CodexNormalizerDiagnostics;
}

interface MutableDiagnostics {
  records: number;
  invalidEnvelopes: number;
  unknownRootTypes: Map<string, number>;
  unknownEventTypes: Map<string, number>;
  unknownResponseTypes: Map<string, number>;
  repeatedSessionMeta: number;
  orphanTurnRecords: number;
}

export interface CanonicalSession {
  nativeSessionId: string;
  nativeThreadId: string;
  barbaroSessionId: string;
  actorId: string;
  workspaceRoot?: string;
  producerVersion?: string;
  historyMode: string;
  threadSource?: string;
}

interface SerializedTurnBuilder {
  readonly nativeTurnId: string;
  readonly barbaroTurnId: string;
  readonly sequence: number;
  readonly agentId: string;
  readonly startedAt: string;
  readonly startSource: CodexSourceLocation;
  readonly request?: string;
  readonly requestNativeId?: string;
  readonly response?: string;
  readonly responseNativeId?: string;
  readonly responsePhase?: string;
  readonly actions: readonly BarbaroAction[];
  readonly evidenceIds: readonly string[];
  readonly pendingCalls: readonly PendingCall[];
  readonly latestUsage?: PendingUsage;
  readonly subagents: readonly {
    readonly agentId: string;
    readonly role: string;
    readonly outcome: BarbaroTurnOutcome;
    readonly evidenceIds: readonly string[];
    readonly lastActivity?: string;
    readonly activityCount?: number;
    readonly source?: CodexSourceLocation;
    readonly occurredAt?: string;
  }[];
}

interface PendingUsage {
  readonly payload: Record<string, unknown>;
  readonly source: CodexSourceLocation;
  readonly occurredAt: string;
}

interface PendingCall {
  readonly callId: string;
  readonly nativeId?: string;
  readonly rootType: "function_call" | "custom_tool_call";
  readonly name: string;
  readonly namespace?: string;
  readonly input?: string;
  readonly argumentsJson?: string;
  readonly source: CodexSourceLocation;
  /**
   * Paginated rollouts project an exec call's work as `item_completed`
   * records that land while the call is still open. Counting them here lets
   * the call's own output stand down instead of becoming a second action.
   * Serialized with the call; absent means none.
   */
  projectedItems?: number;
}

interface MutableSubagent {
  readonly agentId: string;
  role: string;
  outcome: BarbaroTurnOutcome;
  readonly evidenceIds: string[];
  lastActivity?: string;
  activityCount: number;
  source?: CodexSourceLocation;
  occurredAt?: string;
}

interface TurnBuilder {
  readonly nativeTurnId: string;
  readonly barbaroTurnId: string;
  readonly sequence: number;
  readonly agentId: string;
  readonly startedAt: string;
  readonly startSource: CodexSourceLocation;
  request?: string;
  requestNativeId?: string;
  response?: string;
  responseNativeId?: string;
  responsePhase?: string;
  readonly actions: BarbaroAction[];
  readonly evidenceIds: string[];
  readonly pendingCalls: Map<string, PendingCall>;
  latestUsage?: PendingUsage;
  readonly subagents: Map<string, MutableSubagent>;
  emitted: boolean;
}

interface TurnTerminalMetadata {
  readonly terminalEvent: "task_complete" | "turn_complete" | "turn_aborted";
  readonly terminalError?: true;
  readonly abortReason?: string;
}

/** Stateful, line-ordered normalizer for one Codex rollout file. */
export class CodexTurnNormalizer {
  readonly #turns = new Map<string, TurnBuilder>();
  readonly #diagnostics: MutableDiagnostics = {
    records: 0,
    invalidEnvelopes: 0,
    unknownRootTypes: new Map(),
    unknownEventTypes: new Map(),
    unknownResponseTypes: new Map(),
    repeatedSessionMeta: 0,
    orphanTurnRecords: 0,
  };
  #session: CanonicalSession | undefined;
  #currentTurnId: string | undefined;
  #nextSequence = 1;

  static restore(state: CodexNormalizerStateV1): CodexTurnNormalizer {
    if (state.schema !== "barbaro.codex-normalizer-state.v1") {
      throw new TypeError(`Unsupported Codex normalizer state: ${state.schema}`);
    }
    if (!Number.isSafeInteger(state.next_sequence) || state.next_sequence < 1) {
      throw new TypeError("Codex normalizer next_sequence is invalid");
    }
    const normalizer = new CodexTurnNormalizer();
    if (state.session) {
      if (!state.session.nativeSessionId || !state.session.actorId) {
        throw new TypeError("Codex normalizer session identity is invalid");
      }
      const derivedSessionId = createSessionId("codex", state.session.nativeSessionId);
      if (state.session.barbaroSessionId !== derivedSessionId) {
        throw new TypeError("Codex normalizer session ID does not match its native identity");
      }
      normalizer.#session = {
        ...structuredClone(state.session),
        nativeThreadId: state.session.nativeThreadId ?? state.session.nativeSessionId,
        historyMode: state.session.historyMode ?? "legacy",
      };
    }
    normalizer.#currentTurnId = state.current_turn_id;
    normalizer.#nextSequence = state.next_sequence;
    restoreDiagnostics(normalizer.#diagnostics, state.diagnostics);
    for (const serialized of state.turns) {
      if (serialized.sequence < 1 || !Number.isSafeInteger(serialized.sequence)) {
        throw new TypeError("Codex normalizer turn sequence is invalid");
      }
      if (!normalizer.#session) {
        throw new TypeError("Codex normalizer state has turns without a session");
      }
      if (serialized.agentId !== normalizer.#session.actorId) {
        throw new TypeError("Codex normalizer turn actor does not match its session");
      }
      const derivedTurnId = createTurnId(
        "codex",
        normalizer.#session.nativeSessionId,
        serialized.agentId,
        serialized.nativeTurnId,
      );
      if (serialized.barbaroTurnId !== derivedTurnId) {
        throw new TypeError("Codex normalizer turn ID does not match its native identity");
      }
      const builder: TurnBuilder = {
        nativeTurnId: serialized.nativeTurnId,
        barbaroTurnId: serialized.barbaroTurnId,
        sequence: serialized.sequence,
        agentId: serialized.agentId,
        startedAt: serialized.startedAt,
        startSource: structuredClone(serialized.startSource),
        ...(serialized.request === undefined ? {} : { request: serialized.request }),
        ...(serialized.requestNativeId === undefined
          ? {}
          : { requestNativeId: serialized.requestNativeId }),
        ...(serialized.response === undefined ? {} : { response: serialized.response }),
        ...(serialized.responseNativeId === undefined
          ? {}
          : { responseNativeId: serialized.responseNativeId }),
        ...(serialized.responsePhase === undefined
          ? {}
          : { responsePhase: serialized.responsePhase }),
        actions: structuredClone(serialized.actions) as BarbaroAction[],
        evidenceIds: [...serialized.evidenceIds],
        pendingCalls: new Map(
          serialized.pendingCalls.map((call) => [call.callId, structuredClone(call)]),
        ),
        ...(serialized.latestUsage === undefined
          ? {}
          : { latestUsage: structuredClone(serialized.latestUsage) }),
        subagents: new Map(
          serialized.subagents.map((subagent) => [
            subagent.agentId,
            {
              agentId: subagent.agentId,
              role: subagent.role,
              outcome: subagent.outcome,
              evidenceIds: [...subagent.evidenceIds],
              ...(subagent.lastActivity === undefined
                ? {}
                : { lastActivity: subagent.lastActivity }),
              activityCount: subagent.activityCount ?? 0,
              ...(subagent.source === undefined
                ? {}
                : { source: structuredClone(subagent.source) }),
              ...(subagent.occurredAt === undefined
                ? {}
                : { occurredAt: subagent.occurredAt }),
            },
          ]),
        ),
        emitted: false,
      };
      normalizer.#turns.set(builder.nativeTurnId, builder);
    }
    if (
      normalizer.#currentTurnId !== undefined &&
      !normalizer.#turns.has(normalizer.#currentTurnId)
    ) {
      throw new TypeError("Codex normalizer current turn is missing from state");
    }
    return normalizer;
  }

  accept(value: unknown, source: CodexSourceLocation): CodexNormalizationBatch {
    assertSource(source);
    this.#diagnostics.records += 1;
    const decoded = decodeCodexEnvelope(value);
    if (!decoded.ok) {
      this.#diagnostics.invalidEnvelopes += 1;
      return emptyBatch();
    }
    const envelope = decoded.envelope;
    if (!KNOWN_ROOT_TYPES.has(envelope.type)) {
      increment(this.#diagnostics.unknownRootTypes, envelope.type);
    }

    if (envelope.type === "session_meta") {
      this.#acceptSessionMeta(envelope.payload);
      return emptyBatch();
    }
    if (envelope.type === "event_msg") {
      return this.#acceptEvent(envelope, source);
    }
    if (envelope.type === "response_item") {
      return this.#acceptResponseItem(envelope, source);
    }

    // Unknown records remain available through the lossless raw reader and
    // diagnostics. They are not promoted into the common evidence contract,
    // because doing so would invent semantics for a future provider record.
    return emptyBatch();
  }

  diagnostics(): CodexNormalizerDiagnostics {
    return {
      records: this.#diagnostics.records,
      invalid_envelopes: this.#diagnostics.invalidEnvelopes,
      unknown_root_types: mapToSortedRecord(this.#diagnostics.unknownRootTypes),
      unknown_event_types: mapToSortedRecord(this.#diagnostics.unknownEventTypes),
      unknown_response_types: mapToSortedRecord(this.#diagnostics.unknownResponseTypes),
      repeated_session_meta: this.#diagnostics.repeatedSessionMeta,
      orphan_turn_records: this.#diagnostics.orphanTurnRecords,
    };
  }

  snapshot(): CodexNormalizerStateV1 {
    const turns: SerializedTurnBuilder[] = [];
    for (const builder of this.#turns.values()) {
      if (builder.emitted) continue;
      turns.push({
        nativeTurnId: builder.nativeTurnId,
        barbaroTurnId: builder.barbaroTurnId,
        sequence: builder.sequence,
        agentId: builder.agentId,
        startedAt: builder.startedAt,
        startSource: structuredClone(builder.startSource),
        ...(builder.request === undefined ? {} : { request: builder.request }),
        ...(builder.requestNativeId === undefined
          ? {}
          : { requestNativeId: builder.requestNativeId }),
        ...(builder.response === undefined ? {} : { response: builder.response }),
        ...(builder.responseNativeId === undefined
          ? {}
          : { responseNativeId: builder.responseNativeId }),
        ...(builder.responsePhase === undefined
          ? {}
          : { responsePhase: builder.responsePhase }),
        actions: structuredClone(builder.actions),
        evidenceIds: [...builder.evidenceIds],
        pendingCalls: [...builder.pendingCalls.values()].map((call) => structuredClone(call)),
        ...(builder.latestUsage === undefined
          ? {}
          : { latestUsage: structuredClone(builder.latestUsage) }),
        subagents: [...builder.subagents.values()].map((subagent) => ({
          agentId: subagent.agentId,
          role: subagent.role,
          outcome: subagent.outcome,
          evidenceIds: [...subagent.evidenceIds],
          ...(subagent.lastActivity === undefined
            ? {}
            : { lastActivity: subagent.lastActivity }),
          activityCount: subagent.activityCount,
          ...(subagent.source === undefined
            ? {}
            : { source: structuredClone(subagent.source) }),
          ...(subagent.occurredAt === undefined
            ? {}
            : { occurredAt: subagent.occurredAt }),
        })),
      });
    }
    turns.sort((left, right) => left.sequence - right.sequence);
    return {
      schema: "barbaro.codex-normalizer-state.v1",
      ...(this.#session ? { session: structuredClone(this.#session) } : {}),
      ...(this.#currentTurnId ? { current_turn_id: this.#currentTurnId } : {}),
      next_sequence: this.#nextSequence,
      turns,
      diagnostics: this.diagnostics(),
    };
  }

  #acceptSessionMeta(payload: unknown): void {
    if (!isObject(payload)) return;
    if (this.#session) {
      this.#diagnostics.repeatedSessionMeta += 1;
      return;
    }

    const nativeSessionId = stringField(payload, "session_id") ?? stringField(payload, "id");
    if (!nativeSessionId) return;
    const nativeThreadId = stringField(payload, "id") ?? nativeSessionId;
    const threadSource = stringField(payload, "thread_source");
    const agentPath = stringField(payload, "agent_path");
    const actorId = threadSource === "subagent"
      ? agentPath ?? nativeThreadId
      : "main";
    const workspaceRoot = stringField(payload, "cwd");
    const producerVersion = stringField(payload, "cli_version");
    const historyMode = stringField(payload, "history_mode") ?? "legacy";

    this.#session = {
      nativeSessionId,
      nativeThreadId,
      barbaroSessionId: createSessionId("codex", nativeSessionId),
      actorId,
      historyMode,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(producerVersion ? { producerVersion } : {}),
      ...(threadSource ? { threadSource } : {}),
    };
  }

  #acceptEvent(
    envelope: CodexRolloutEnvelope,
    source: CodexSourceLocation,
  ): CodexNormalizationBatch {
    if (!isObject(envelope.payload)) return emptyBatch();
    const payload = envelope.payload;
    const eventType = stringField(payload, "type");
    if (!eventType) return emptyBatch();
    if (!KNOWN_EVENT_TYPES.has(eventType)) {
      increment(this.#diagnostics.unknownEventTypes, eventType);
    }

    if (eventType === "task_started" || eventType === "turn_started") {
      const nativeTurnId = stringField(payload, "turn_id");
      if (!nativeTurnId || !this.#session) {
        this.#diagnostics.orphanTurnRecords += 1;
        return emptyBatch();
      }
      this.#startTurn(
        nativeTurnId,
        timestampFromUnixSeconds(payload.started_at) ?? envelope.timestamp,
        source,
      );
      return emptyBatch();
    }

    if (SESSION_SCOPED_EVENT_TYPES.has(eventType)) return emptyBatch();

    const builder = this.#builderForPayload(payload);
    if (!builder) {
      this.#diagnostics.orphanTurnRecords += 1;
      return emptyBatch();
    }

    switch (eventType) {
      case "user_message": {
        const message = stringField(payload, "message");
        if (message && builder.request === undefined) builder.request = message;
        return emptyBatch();
      }
      case "agent_message": {
        const message = stringField(payload, "message");
        const phase = stringField(payload, "phase");
        if (!message) return emptyBatch();
        this.#considerResponse(builder, message, phase);
        return emptyBatch();
      }
      case "item_completed": {
        // The canonical paginated projection of one completed turn item.
        // Commands and file changes are taken from it because a paginated
        // rollout writes no `patch_apply_end` and its unified exec inputs are
        // scripts the legacy command parser cannot read. UserMessage,
        // AgentMessage, Reasoning, SubAgentActivity and the rest project
        // response items already normalized, or carry no action.
        const item = isObject(payload.item) ? payload.item : undefined;
        const itemType = item ? stringField(item, "type") : undefined;
        if (item && itemType === "CommandExecution") {
          this.#acceptCommandExecutionItem(builder, payload, item, source);
        } else if (item && itemType === "FileChange") {
          this.#acceptFileChangeItem(builder, payload, item, source);
        }
        return emptyBatch();
      }
      case "patch_apply_end":
        this.#acceptPatchApply(builder, payload, source);
        return emptyBatch();
      case "web_search_end":
        this.#acceptNamedTool(builder, "web_search", payload, source, {
          summaryField: "query",
          outcome: "success",
        });
        return emptyBatch();
      case "mcp_tool_call_end":
        this.#acceptMcpTool(builder, payload, source);
        return emptyBatch();
      case "image_generation_end":
        this.#acceptNamedTool(builder, "image_generation", payload, source, {
          outcome: imageGenerationOutcome(payload),
        });
        return emptyBatch();
      case "sub_agent_activity": {
        this.#acceptSubagentActivity(
          builder,
          payload,
          source,
          envelope.timestamp,
        );
        return emptyBatch();
      }
      case "token_count": {
        builder.latestUsage = {
          payload: structuredClone(payload),
          source: structuredClone(source),
          occurredAt: envelope.timestamp,
        };
        return emptyBatch();
      }
      case "task_complete":
      case "turn_complete": {
        if (builder.emitted) return emptyBatch();
        const lastMessage = stringField(payload, "last_agent_message");
        if (lastMessage && builder.responsePhase !== "final_answer") {
          builder.response = lastMessage;
          builder.responsePhase = "final_answer";
          delete builder.responseNativeId;
        }
        const failed = payload.error !== undefined && payload.error !== null;
        const deferredEvidence = this.#flushDeferredEvidence(builder);
        const turn = this.#finishTurn(
          builder,
          timestampFromUnixSeconds(payload.completed_at) ?? envelope.timestamp,
          source,
          failed ? "failed" : "success",
          {
            terminalEvent: eventType,
            ...(failed ? { terminalError: true } : {}),
          },
        );
        return { turns: [turn], evidence: deferredEvidence };
      }
      case "turn_aborted": {
        if (builder.emitted) return emptyBatch();
        const reason = stringField(payload, "reason") ?? stringField(payload, "message") ?? "";
        const outcome = abortedOutcome(reason, builder);
        const deferredEvidence = this.#flushDeferredEvidence(builder);
        const turn = this.#finishTurn(
          builder,
          timestampFromUnixSeconds(payload.completed_at) ?? envelope.timestamp,
          source,
          outcome,
          {
            terminalEvent: "turn_aborted",
            ...(reason ? { abortReason: reason } : {}),
          },
        );
        return { turns: [turn], evidence: deferredEvidence };
      }
      default:
        return emptyBatch();
    }
  }

  #acceptResponseItem(
    envelope: CodexRolloutEnvelope,
    source: CodexSourceLocation,
  ): CodexNormalizationBatch {
    if (!isObject(envelope.payload)) return emptyBatch();
    const payload = envelope.payload;
    const responseType = stringField(payload, "type");
    if (!responseType) return emptyBatch();
    if (!KNOWN_RESPONSE_TYPES.has(responseType)) {
      increment(this.#diagnostics.unknownResponseTypes, responseType);
    }
    const builder = this.#builderForPayload(payload);
    if (!builder) {
      this.#diagnostics.orphanTurnRecords += 1;
      return emptyBatch();
    }

    if (responseType === "message") {
      const role = stringField(payload, "role");
      const text = extractCodexMessageText(payload.content);
      const nativeId = stringField(payload, "id");
      if (role === "user" && text && builder.request === undefined) {
        builder.request = text;
        if (nativeId) builder.requestNativeId = nativeId;
      }
      if (role === "assistant" && text) {
        this.#considerResponse(builder, text, stringField(payload, "phase"), nativeId);
      }
      return emptyBatch();
    }

    if (responseType === "function_call" || responseType === "custom_tool_call") {
      this.#rememberCall(builder, payload, responseType, source);
      return emptyBatch();
    }
    if (responseType === "function_call_output" || responseType === "custom_tool_call_output") {
      this.#completeCall(builder, payload, responseType, source);
      return emptyBatch();
    }

    return emptyBatch();
  }

  #startTurn(nativeTurnId: string, startedAt: string, source: CodexSourceLocation): TurnBuilder {
    const existing = this.#turns.get(nativeTurnId);
    if (existing) {
      this.#currentTurnId = nativeTurnId;
      return existing;
    }
    const session = this.#session;
    if (!session) throw new Error("Cannot start a turn without canonical session metadata");
    const builder: TurnBuilder = {
      nativeTurnId,
      barbaroTurnId: createTurnId(
        "codex",
        session.nativeSessionId,
        session.actorId,
        nativeTurnId,
      ),
      sequence: this.#nextSequence,
      agentId: session.actorId,
      startedAt,
      startSource: source,
      actions: [],
      evidenceIds: [],
      pendingCalls: new Map(),
      subagents: new Map(),
      emitted: false,
    };
    this.#nextSequence += 1;
    this.#turns.set(nativeTurnId, builder);
    this.#currentTurnId = nativeTurnId;
    return builder;
  }

  #builderForPayload(payload: Record<string, unknown>): TurnBuilder | undefined {
    const direct = stringField(payload, "turn_id");
    if (direct) return this.#turns.get(direct);
    const passthrough = payload.internal_chat_message_metadata_passthrough;
    if (isObject(passthrough)) {
      const nested = stringField(passthrough, "turn_id");
      if (nested) return this.#turns.get(nested);
    }
    return this.#currentBuilder();
  }

  #currentBuilder(): TurnBuilder | undefined {
    return this.#currentTurnId ? this.#turns.get(this.#currentTurnId) : undefined;
  }

  #considerResponse(
    builder: TurnBuilder,
    message: string,
    phase: string | undefined,
    nativeId?: string,
  ): void {
    const incomingFinal = phase === "final_answer";
    const existingFinal = builder.responsePhase === "final_answer";

    // A legacy event projection can arrive after the canonical response item.
    // Never let an ID-less projection replace a canonical final response.
    if (existingFinal && !nativeId) return;
    if (!incomingFinal && existingFinal) return;

    builder.response = message;
    if (phase === undefined) {
      delete builder.responsePhase;
    } else {
      builder.responsePhase = phase;
    }
    if (nativeId) builder.responseNativeId = nativeId;
  }

  #rememberCall(
    builder: TurnBuilder,
    payload: Record<string, unknown>,
    responseType: "function_call" | "custom_tool_call",
    source: CodexSourceLocation,
  ): void {
    const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
    const name = stringField(payload, "name");
    if (!callId || !name) return;
    const namespace = stringField(payload, "namespace");
    const nativeId = stringField(payload, "id");
    const input = stringField(payload, "input");
    const argumentsJson = stringField(payload, "arguments");
    builder.pendingCalls.set(callId, {
      callId,
      ...(nativeId ? { nativeId } : {}),
      rootType: responseType,
      name,
      ...(namespace ? { namespace } : {}),
      ...(input ? { input } : {}),
      ...(argumentsJson ? { argumentsJson } : {}),
      source,
    });
  }

  #completeCall(
    builder: TurnBuilder,
    payload: Record<string, unknown>,
    responseType: "function_call_output" | "custom_tool_call_output",
    outputSource: CodexSourceLocation,
  ): void {
    const callId = stringField(payload, "call_id");
    if (!callId) return;
    const pending = builder.pendingCalls.get(callId);
    if (!pending) return;
    const compatible =
      (pending.rootType === "function_call" && responseType === "function_call_output") ||
      (pending.rootType === "custom_tool_call" && responseType === "custom_tool_call_output");
    if (!compatible) return;
    builder.pendingCalls.delete(callId);

    this.#materializeCall(builder, pending, payload, outputSource);
  }

  #materializeCall(
    builder: TurnBuilder,
    pending: PendingCall,
    outputPayload?: Record<string, unknown>,
    outputSource?: CodexSourceLocation,
  ): void {
    const directInputCommand = pending.input
      ? extractDirectCommand(pending.input)
      : undefined;

    const commands = directInputCommand
      ? [{ command: directInputCommand, occurrence: 0 }]
      : pending.input
        ? extractExecCommands(pending.input)
      : pending.argumentsJson && /exec_command|shell|bash/i.test(pending.name)
        ? [{ command: extractDirectCommand(pending.argumentsJson), occurrence: 0 }]
            .filter((entry): entry is { command: string; occurrence: number } => Boolean(entry.command))
        : [];
    const output = inspectToolOutput(outputPayload?.output);
    for (const command of commands) {
      if (
        isGeneratedBarbaroReadCommand(command.command) ||
        isDigestExcludedBarbaroCommand(command.command)
      ) {
        continue;
      }
      const sourceRefs = [
        sourceRef(pending.source, compactIds(pending.nativeId, pending.callId)),
        ...(outputSource
          ? [
              sourceRef(
                outputSource,
                compactIds(stringField(outputPayload ?? {}, "id"), pending.callId),
              ),
            ]
          : []),
      ];
      const outcome = output.exitCode === undefined
        ? "unknown" as const
        : output.exitCode === 0
          ? "success" as const
          : "failed" as const;
      const common = {
        action_id: createActionId(
          builder.barbaroTurnId,
          callSourceIdentity(pending),
          command.occurrence,
        ),
        outcome,
        command: verbatimContent(command.command),
        ...(output.exitCode === undefined ? {} : { exit_code: output.exitCode }),
        ...(outcome === "failed" && output.text
          ? { failure_excerpt: redactedExcerptContent(output.text, 4096) }
          : {}),
        source_refs: sourceRefs,
      };
      builder.actions.push(
        isTestCommand(command.command)
          ? { ...common, kind: "test" }
          : { ...common, kind: "command" },
      );
    }

    if (commands.length > 0) return;
    // A paginated rollout already projected this call's work as
    // item_completed records, turned into actions as they landed; the call's
    // own output is not a second action.
    if ((pending.projectedItems ?? 0) > 0) return;
    if (pending.namespace === "collaboration") return;
    if (isGeneratedBarbaroReadTool(pending)) return;
    if (
      pending.rootType === "custom_tool_call" &&
      pending.name === "exec" &&
      pending.input &&
      /tools\.(?:apply_patch|web__run)\s*\(/.test(pending.input)
    ) {
      return;
    }
    builder.actions.push({
      action_id: createActionId(
        builder.barbaroTurnId,
        callSourceIdentity(pending),
        0,
      ),
      kind: "tool",
      outcome: explicitToolOutcome(outputPayload),
      tool_name: pending.namespace
        ? `${pending.namespace}.${pending.name}`
        : pending.name,
      source_refs: [
        sourceRef(pending.source, compactIds(pending.nativeId, pending.callId)),
        ...(outputSource
          ? [
              sourceRef(
                outputSource,
                compactIds(stringField(outputPayload ?? {}, "id"), pending.callId),
              ),
            ]
          : []),
      ],
    });
  }

  /**
   * Paginated rollouts (`history_mode: "paginated"`, Codex Desktop 0.149+)
   * write the canonical projection of each completed turn item as
   * `event_msg.item_completed`. A `CommandExecution` item carries the command
   * as an argv array with its exit code and status, which is everything the
   * command action needs and more than the unified exec input (a script) can
   * give. Only what the record states is used: a completed item is judged by
   * its exit code, an item the provider marks failed is failed, anything else
   * stays unknown rather than guessed.
   */
  #acceptCommandExecutionItem(
    builder: TurnBuilder,
    eventPayload: Record<string, unknown>,
    item: Record<string, unknown>,
    source: CodexSourceLocation,
  ): void {
    this.#markExecProjected(builder);
    const commandText = renderCommandArray(item.command);
    if (
      !commandText ||
      isGeneratedBarbaroReadCommand(commandText) ||
      isDigestExcludedBarbaroCommand(commandText)
    ) {
      return;
    }
    const itemId = stringField(item, "id");
    const status = stringField(item, "status");
    const exitCode =
      typeof item.exit_code === "number" && Number.isSafeInteger(item.exit_code)
        ? item.exit_code
        : undefined;
    const outcome: BarbaroActionOutcome =
      status === "completed"
        ? exitCode === undefined
          ? "unknown"
          : exitCode === 0
            ? "success"
            : "failed"
        : status === "failed"
          ? "failed"
          : "unknown";
    // aggregated_output is the interleaved stream the user saw; it already
    // contains stderr, so it is used whole rather than stitched from parts.
    const failureText =
      stringField(item, "aggregated_output") ??
      [stringField(item, "stderr"), stringField(item, "stdout")]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n");
    const common = {
      action_id: createActionId(
        builder.barbaroTurnId,
        sourceIdentity(source, itemId),
        0,
      ),
      outcome,
      command: verbatimContent(commandText),
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      ...(outcome === "failed" && failureText
        ? { failure_excerpt: redactedExcerptContent(failureText, 4096) }
        : {}),
      source_refs: [
        sourceRef(source, compactIds(itemId, stringField(eventPayload, "turn_id"))),
      ],
    };
    builder.actions.push(
      isTestCommand(commandText)
        ? { ...common, kind: "test" }
        : { ...common, kind: "command" },
    );
  }

  /**
   * A `FileChange` item carries the same `changes` map a legacy
   * `patch_apply_end` event did — path → add/update/delete with content or a
   * unified diff — so it flows through the same file-change materialization.
   */
  #acceptFileChangeItem(
    builder: TurnBuilder,
    eventPayload: Record<string, unknown>,
    item: Record<string, unknown>,
    source: CodexSourceLocation,
  ): void {
    this.#markExecProjected(builder);
    const itemId = stringField(item, "id");
    const turnId = stringField(eventPayload, "turn_id");
    this.#acceptPatchApply(
      builder,
      {
        success: stringField(item, "status") === "completed",
        changes: item.changes,
        ...(itemId ? { call_id: itemId } : {}),
        ...(turnId ? { turn_id: turnId } : {}),
        ...(item.stderr === undefined ? {} : { stderr: item.stderr }),
        ...(item.stdout === undefined ? {} : { stdout: item.stdout }),
      },
      source,
    );
  }

  /**
   * Attribute a projected item to the exec call that is open when it lands —
   * the most recently issued, still-unanswered `exec` custom tool call. Exec
   * calls run to completion before their output is written, so the open one
   * is the one doing the work.
   */
  #markExecProjected(builder: TurnBuilder): void {
    let latest: PendingCall | undefined;
    for (const call of builder.pendingCalls.values()) {
      if (call.rootType === "custom_tool_call" && call.name === "exec") {
        latest = call;
      }
    }
    if (latest) latest.projectedItems = (latest.projectedItems ?? 0) + 1;
  }

  #acceptPatchApply(
    builder: TurnBuilder,
    payload: Record<string, unknown>,
    source: CodexSourceLocation,
  ): void {
    const success = payload.success === true;
    const changes = payload.changes;
    let occurrence = 0;
    if (isObject(changes)) {
      for (const [rawPath, rawChange] of Object.entries(changes)) {
        const originalPath = normalizeRepoPath(this.#session?.workspaceRoot, rawPath);
        if (!originalPath || isGeneratedBarbaroPath(originalPath)) continue;
        const change = isObject(rawChange) ? rawChange : {};
        const rawType = stringField(change, "type") ?? "unknown";
        const movePath = stringField(change, "move_path");
        const normalizedMovePath = movePath
          ? normalizeRepoPath(this.#session?.workspaceRoot, movePath)
          : undefined;
        if (movePath && (!normalizedMovePath || isGeneratedBarbaroPath(normalizedMovePath))) {
          continue;
        }
        const operation = normalizedMovePath
          ? "move" as const
          : rawType === "add"
          ? "create" as const
          : rawType === "delete"
            ? "delete" as const
            : rawType === "update" || rawType === "modify"
              ? "modify" as const
              : rawType === "move"
                ? "move" as const
                : "unknown" as const;
        const path = normalizedMovePath ?? originalPath;
        const content = stringField(change, "content");
        const diffCounts = countUnifiedDiff(stringField(change, "unified_diff"));
        builder.actions.push({
          action_id: createActionId(
            builder.barbaroTurnId,
            sourceIdentity(source, stringField(payload, "call_id")),
            occurrence,
          ),
          kind: "file_change",
          outcome: success ? "success" : "failed",
          operation,
          path,
          ...(operation === "move" ? { previous_path: originalPath } : {}),
          ...(operation === "create" && content
            ? { added_lines: countLines(content) }
            : {}),
          ...(diffCounts.added > 0 ? { added_lines: diffCounts.added } : {}),
          ...(diffCounts.removed > 0 ? { removed_lines: diffCounts.removed } : {}),
          source_refs: [sourceRef(source, nativeIds(payload))],
        });
        occurrence += 1;
      }
    }

    if (!success && occurrence === 0) {
      const errorText = [stringField(payload, "stderr"), stringField(payload, "stdout")]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n");
      builder.actions.push({
        action_id: createActionId(
          builder.barbaroTurnId,
          sourceIdentity(source, stringField(payload, "call_id")),
          0,
        ),
        kind: "tool",
        outcome: "failed",
        tool_name: "apply_patch",
        ...(errorText ? { summary: redactedExcerptContent(errorText, 4096) } : {}),
        source_refs: [sourceRef(source, nativeIds(payload))],
      });
    }
  }

  #acceptNamedTool(
    builder: TurnBuilder,
    toolName: string,
    payload: Record<string, unknown>,
    source: CodexSourceLocation,
    options: {
      readonly summaryField?: string;
      readonly outcome?: BarbaroActionOutcome;
      readonly failureText?: string;
    } = {},
  ): void {
    const summary = options.summaryField
      ? stringField(payload, options.summaryField)
      : undefined;
    builder.actions.push({
      action_id: createActionId(
        builder.barbaroTurnId,
        sourceIdentity(source, stringField(payload, "call_id")),
        0,
      ),
      kind: "tool",
      outcome:
        options.outcome ??
        (payload.success === true
          ? "success"
          : payload.success === false
            ? "failed"
            : "unknown"),
      tool_name: toolName,
      ...(options.failureText
        ? { summary: redactedExcerptContent(options.failureText, 4_096) }
        : summary
          ? { summary: verbatimContent(summary) }
          : {}),
      source_refs: [sourceRef(source, nativeIds(payload))],
    });
  }

  #acceptMcpTool(
    builder: TurnBuilder,
    payload: Record<string, unknown>,
    source: CodexSourceLocation,
  ): void {
    const invocation = isObject(payload.invocation) ? payload.invocation : {};
    const server =
      stringField(invocation, "server") ??
      stringField(payload, "server") ??
      stringField(payload, "server_name");
    const tool =
      stringField(invocation, "tool") ??
      stringField(payload, "tool") ??
      stringField(payload, "tool_name");
    const name = [server, tool].filter((entry): entry is string => Boolean(entry)).join(".");
    this.#acceptNamedTool(
      builder,
      name || "mcp",
      payload,
      source,
      mcpToolOutcome(payload.result),
    );
  }

  #acceptSubagentActivity(
    builder: TurnBuilder,
    payload: Record<string, unknown>,
    source: CodexSourceLocation,
    occurredAt: string,
  ): void {
    const agentId = stringField(payload, "agent_thread_id");
    if (!agentId) return;
    const agentPath = stringField(payload, "agent_path");
    const role = agentPath?.split("/").filter(Boolean).at(-1) ?? "subagent";
    const kind = stringField(payload, "kind") ?? "unknown";
    let subagent = builder.subagents.get(agentId);
    if (!subagent) {
      const evidenceId = createEvidenceId(
        builder.barbaroTurnId,
        sourceIdentity(source, stringField(payload, "event_id") ?? agentId),
        0,
      );
      subagent = {
        agentId,
        role,
        outcome: "unknown",
        evidenceIds: [evidenceId],
        activityCount: 0,
        source: structuredClone(source),
        occurredAt,
      };
      builder.subagents.set(agentId, subagent);
      builder.evidenceIds.push(evidenceId);
    }
    subagent.lastActivity = kind;
    subagent.activityCount += 1;
    subagent.occurredAt = occurredAt;
    if (/fail|error/i.test(kind)) subagent.outcome = "failed";
    if (/complete|closed|finished/i.test(kind)) subagent.outcome = "success";
  }

  #flushDeferredEvidence(builder: TurnBuilder): BarbaroEvidenceV1[] {
    const evidence: BarbaroEvidenceV1[] = [];
    if (builder.latestUsage) {
      evidence.push(
        this.#usageEvidence(
          builder,
          builder.latestUsage.payload,
          builder.latestUsage.source,
          builder.latestUsage.occurredAt,
        ),
      );
      delete builder.latestUsage;
    }
    for (const subagent of builder.subagents.values()) {
      const evidenceId = subagent.evidenceIds[0];
      if (!evidenceId || !subagent.source || !subagent.occurredAt) continue;
      evidence.push({
        schema: "barbaro.evidence.v1",
        evidence_id: evidenceId,
        turn_id: builder.barbaroTurnId,
        provider: "codex",
        session_id: this.#requiredSession().barbaroSessionId,
        agent_id: subagent.agentId,
        parent_turn_id: builder.barbaroTurnId,
        parent_link: { method: "native", native_key: subagent.agentId },
        // A parent rollout's `sub_agent_activity` rows describe lifecycle
        // only. The actual child interaction lives in its own rollout and is
        // the only artifact that may become `kind: "subagent_turn"`.
        kind: "provider_event",
        occurred_at: subagent.occurredAt,
        content: {
          event: "subagent_activity_rollup",
          role: subagent.role,
          activity: subagent.lastActivity ?? "unknown",
          activity_count: subagent.activityCount,
          outcome: subagent.outcome,
        },
        source_refs: [sourceRef(subagent.source, [subagent.agentId])],
      });
    }
    return evidence;
  }

  #usageEvidence(
    builder: TurnBuilder,
    payload: Record<string, unknown>,
    source: CodexSourceLocation,
    occurredAt: string,
  ): BarbaroEvidenceV1 {
    const evidenceId = createEvidenceId(
      builder.barbaroTurnId,
      sourceIdentity(source),
      0,
    );
    builder.evidenceIds.push(evidenceId);
    const content: Record<string, unknown> = {};
    for (const key of ["info", "rate_limits", "model_context_window"]) {
      if (payload[key] !== undefined) content[key] = payload[key];
    }
    return {
      schema: "barbaro.evidence.v1",
      evidence_id: evidenceId,
      turn_id: builder.barbaroTurnId,
      provider: "codex",
      session_id: this.#requiredSession().barbaroSessionId,
      agent_id: builder.agentId,
      kind: "usage",
      occurred_at: occurredAt,
      content,
      source_refs: [sourceRef(source)],
    };
  }

  #finishTurn(
    builder: TurnBuilder,
    endedAt: string,
    terminalSource: CodexSourceLocation,
    outcome: BarbaroTurnOutcome,
    terminal: TurnTerminalMetadata,
  ): BarbaroTurnV1 {
    for (const pending of builder.pendingCalls.values()) {
      this.#materializeCall(builder, pending);
    }
    builder.pendingCalls.clear();
    builder.emitted = true;
    if (this.#currentTurnId === builder.nativeTurnId) this.#currentTurnId = undefined;
    const session = this.#requiredSession();
    const actions = [...builder.actions].sort(
      (left, right) => actionSourceOrder(left) - actionSourceOrder(right),
    );
    return {
      schema: "barbaro.turn.v1",
      turn_id: builder.barbaroTurnId,
      provider: "codex",
      session_id: session.barbaroSessionId,
      sequence: builder.sequence,
      agent_id: builder.agentId,
      started_at: builder.startedAt,
      ended_at: endedAt,
      outcome,
      request: verbatimContent(builder.request ?? ""),
      ...(builder.response !== undefined
        ? { response: verbatimContent(builder.response) }
        : {}),
      actions,
      subagents: buildSubagentRollup(builder.subagents),
      evidence_refs: uniqueSorted(builder.evidenceIds),
      source_refs: [
        {
          trace_id: builder.startSource.traceId,
          ...(builder.startSource.tracePath
            ? { trace_path: builder.startSource.tracePath }
            : {}),
          line_start: builder.startSource.lineNumber,
          line_end: terminalSource.lineNumber,
          native_record_ids: compactIds(
            builder.nativeTurnId,
            builder.requestNativeId,
            builder.responseNativeId,
          ),
        },
      ],
      extensions: {
        codex: {
          native_turn_id: builder.nativeTurnId,
          ...(session.producerVersion
            ? { producer_cli_version: session.producerVersion }
            : {}),
          history_mode: session.historyMode,
          terminal_event: terminal.terminalEvent,
          ...(terminal.terminalError ? { terminal_error: true } : {}),
          ...(terminal.abortReason ? { abort_reason: terminal.abortReason } : {}),
          ...(session.threadSource ? { thread_source: session.threadSource } : {}),
          ...(session.threadSource === "subagent"
            ? { native_thread_id: session.nativeThreadId, agent_path: session.actorId }
            : {}),
        },
      },
    };
  }

  #requiredSession(): CanonicalSession {
    if (!this.#session) throw new Error("Canonical Codex session metadata is unavailable");
    return this.#session;
  }
}

function emptyBatch(): CodexNormalizationBatch {
  return { turns: [], evidence: [] };
}

function mcpToolOutcome(result: unknown): {
  readonly outcome: BarbaroActionOutcome;
  readonly failureText?: string;
} {
  if (!isObject(result)) return { outcome: "unknown" };
  for (const key of ["Err", "err"] as const) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const error = result[key];
    return {
      outcome: "failed",
      ...(typeof error === "string" && error.length > 0
        ? { failureText: error }
        : {}),
    };
  }
  const ok = Object.prototype.hasOwnProperty.call(result, "Ok")
    ? result.Ok
    : Object.prototype.hasOwnProperty.call(result, "ok")
      ? result.ok
      : undefined;
  if (ok === undefined) return { outcome: "unknown" };
  if (!isObject(ok)) return { outcome: "unknown" };
  if (ok.is_error !== true) return { outcome: "success" };
  const failureText = Array.isArray(ok.content)
    ? ok.content
        .map((item) => (isObject(item) ? stringField(item, "text") : undefined))
        .filter((text): text is string => Boolean(text))
        .join("\n")
    : undefined;
  return {
    outcome: "failed",
    ...(failureText ? { failureText } : {}),
  };
}

function imageGenerationOutcome(
  payload: Record<string, unknown>,
): BarbaroActionOutcome {
  if (payload.failure !== undefined && payload.failure !== null) return "failed";
  const status = stringField(payload, "status")?.toLowerCase();
  if (!status) return "unknown";
  if (["completed", "success", "succeeded"].includes(status)) return "success";
  if (["failed", "error", "rejected"].includes(status)) return "failed";
  if (["cancelled", "canceled", "interrupted"].includes(status)) {
    return "interrupted";
  }
  return "unknown";
}

function assertSource(source: CodexSourceLocation): void {
  if (!source.traceId) throw new TypeError("source.traceId is required");
  if (!Number.isSafeInteger(source.lineNumber) || source.lineNumber < 1) {
    throw new RangeError("source.lineNumber must be a positive safe integer");
  }
}

function sourceRef(
  source: CodexSourceLocation,
  ids: readonly string[] = [],
): BarbaroSourceRef {
  return {
    trace_id: source.traceId,
    ...(source.tracePath ? { trace_path: source.tracePath } : {}),
    line_start: source.lineNumber,
    line_end: source.lineNumber,
    ...(ids.length > 0 ? { native_record_ids: uniqueInOrder(ids) } : {}),
  };
}

function nativeIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["id", "call_id", "turn_id", "event_id", "agent_thread_id"]) {
    const value = stringField(payload, key);
    if (value) ids.push(value);
  }
  return uniqueInOrder(ids);
}

function compactIds(...values: readonly (string | undefined)[]): string[] {
  return uniqueInOrder(
    values.filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

/**
 * The command a reader recognizes from a `CommandExecution` item's argv. A
 * `<shell> -lc <script>` triple is the script; anything else is the argv
 * joined by spaces; a string is itself.
 */
function renderCommandArray(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (
    !Array.isArray(value) ||
    !value.every((part): part is string => typeof part === "string")
  ) {
    return undefined;
  }
  if (value.length === 3 && /^-l?c$/.test(value[1]!)) {
    return value[2]!.length > 0 ? value[2]! : undefined;
  }
  const joined = value.join(" ");
  return joined.length > 0 ? joined : undefined;
}

function callSourceIdentity(call: PendingCall): string {
  if (call.nativeId) return `response_item:id:${call.nativeId}`;
  if (call.callId) return `call_id:${call.callId}`;
  return `line:${call.source.lineNumber}`;
}

function sourceIdentity(source: CodexSourceLocation, nativeId?: string): string {
  return nativeId
    ? `${source.traceId}:native:${nativeId}:line:${source.lineNumber}`
    : `${source.traceId}:line:${source.lineNumber}`;
}

function inspectToolOutput(value: unknown): {
  readonly exitCode?: number;
  readonly text?: string;
} {
  let decoded = value;
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      decoded = value;
    }
  } else if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      if (isObject(block) && typeof block.text === "string") parts.push(block.text);
    }
    if (parts.length > 0) text = parts.join("\n");
  }

  if (isObject(decoded)) {
    const exitCode = decoded.exit_code;
    const output = typeof decoded.output === "string"
      ? decoded.output
      : typeof decoded.stderr === "string"
        ? decoded.stderr
        : text;
    return {
      ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode)
        ? { exitCode }
        : {}),
      ...(output ? { text: output } : {}),
    };
  }
  return text ? { text } : {};
}

function explicitToolOutcome(
  payload: Record<string, unknown> | undefined,
): "success" | "failed" | "denied" | "interrupted" | "unknown" {
  if (!payload) return "unknown";
  if (payload.success === true) return "success";
  if (payload.success === false) return "failed";
  const status = stringField(payload, "status")?.toLowerCase();
  if (status === "failed" || status === "error") return "failed";
  if (status === "denied") return "denied";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "success" || status === "succeeded") return "success";
  return "unknown";
}

function isGeneratedBarbaroReadCommand(command: string): boolean {
  if (!/(?:^|[\s"'])\.barbaro\/(?:feed|evidence|active)(?:\/|\b)/.test(command)) {
    return false;
  }
  const trimmed = command.trim();
  if (!/^(?:cat|rg|grep|find|ls|sed|awk|head|tail|wc|jq)\b/.test(trimmed)) {
    return false;
  }
  return !/(?:^|[|;&\s])(?:tee|rm|mv|cp|install|touch|mkdir|truncate)\b|>{1,2}/.test(trimmed);
}

function isGeneratedBarbaroReadTool(call: PendingCall): boolean {
  if (!/(?:read|grep|glob|search|list)/i.test(call.name)) return false;
  const encoded = call.argumentsJson ?? call.input;
  if (!encoded) return false;
  return /(?:^|[\/"'])\.barbaro[\/](?:feed|evidence|active)(?:[\/"']|$)/.test(encoded);
}

function abortedOutcome(reason: string, builder: TurnBuilder): BarbaroTurnOutcome {
  if (reason === "budget_limited") {
    const successfulAction = builder.actions.some((action) => action.outcome === "success");
    return builder.response || successfulAction ? "partial" : "cancelled";
  }
  if (["interrupted", "replaced", "review_ended"].includes(reason)) {
    return "cancelled";
  }
  return /user|cancel|interrupt/i.test(reason) ? "cancelled" : "unknown";
}

/**
 * Decode Codex's canonical numeric event time. Hook enrollment uses the same
 * helper so a membership move and the turn it belongs to share one exact
 * `started_at` boundary.
 */
export function timestampFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function actionSourceOrder(action: BarbaroAction): number {
  return action.source_refs[0]?.line_start ?? Number.MAX_SAFE_INTEGER;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  let lines = 1;
  for (const character of value) if (character === "\n") lines += 1;
  return value.endsWith("\n") ? lines - 1 : lines;
}

function countUnifiedDiff(value: string | undefined): {
  readonly added: number;
  readonly removed: number;
} {
  if (!value) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of value.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function buildSubagentRollup(
  subagents: ReadonlyMap<string, MutableSubagent>,
): BarbaroSubagentRollup {
  const roleCounts = new Map<string, number>();
  const outcomes: Partial<Record<BarbaroTurnOutcome, number>> = {};
  const evidenceIds: string[] = [];
  for (const subagent of subagents.values()) {
    roleCounts.set(subagent.role, (roleCounts.get(subagent.role) ?? 0) + 1);
    outcomes[subagent.outcome] = (outcomes[subagent.outcome] ?? 0) + 1;
    evidenceIds.push(...subagent.evidenceIds);
  }
  return {
    total: subagents.size,
    by_role: [...roleCounts.entries()]
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([role, count]) => ({ role, count })),
    outcomes,
    changed_paths: [],
    evidence_refs: uniqueSorted(evidenceIds),
  };
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function mapToSortedRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...values.entries()].sort(([left], [right]) =>
      compareUtf16CodeUnits(left, right)
    ),
  );
}

function restoreDiagnostics(
  target: MutableDiagnostics,
  source: CodexNormalizerDiagnostics,
): void {
  for (const [name, value] of [
    ["records", source.records],
    ["invalid_envelopes", source.invalid_envelopes],
    ["repeated_session_meta", source.repeated_session_meta],
    ["orphan_turn_records", source.orphan_turn_records],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Codex normalizer diagnostic ${name} is invalid`);
    }
  }
  target.records = source.records;
  target.invalidEnvelopes = source.invalid_envelopes;
  target.repeatedSessionMeta = source.repeated_session_meta;
  target.orphanTurnRecords = source.orphan_turn_records;
  restoreCountMap(target.unknownRootTypes, source.unknown_root_types);
  restoreCountMap(target.unknownEventTypes, source.unknown_event_types);
  restoreCountMap(target.unknownResponseTypes, source.unknown_response_types);
}

function restoreCountMap(
  target: Map<string, number>,
  source: Readonly<Record<string, number>>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (!key || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Codex normalizer diagnostic count map is invalid");
    }
    target.set(key, value);
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}
