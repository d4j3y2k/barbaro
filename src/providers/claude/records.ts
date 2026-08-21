/**
 * Claude Code JSONL record decoding.
 *
 * Only the stable outer envelope is decoded here. Unknown record types and
 * unknown fields are preserved rather than rejected, because the on-disk format
 * is a private, versioned implementation detail that drifts every few weeks.
 * See docs/claude-code-jsonl-schema.md.
 */

export interface ClaudeEnvelope {
  readonly type: string;
  readonly uuid?: string;
  readonly parentUuid?: string;
  /** Set on compact_boundary records, where parentUuid is null. */
  readonly logicalParentUuid?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly version?: string;
  readonly isSidechain: boolean;
  readonly isMeta: boolean;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ClaudeEnvelopeResult =
  | { readonly ok: true; readonly envelope: ClaudeEnvelope }
  | { readonly ok: false; readonly reason: string };

/**
 * Record types that carry no uuid and no timestamp. They are session-scoped
 * state rewritten in place (last-write-wins), not timeline events, so they are
 * folded into a session header rather than placed on the timeline.
 */
export const CLAUDE_SIDECAR_TYPES: ReadonlySet<string> = new Set([
  "mode",
  "permission-mode",
  "ai-title",
  "custom-title",
  "agent-name",
  "last-prompt",
  "bridge-session",
  "file-history-snapshot",
  "file-history-delta",
  "pr-link",
  "queue-operation",
  "frame-link",
  // Workflow journal bookkeeping; only ever present in journal.jsonl.
  "started",
  "result",
]);

export function decodeClaudeEnvelope(value: unknown): ClaudeEnvelopeResult {
  if (!isObject(value)) {
    return { ok: false, reason: "claude record is not an object" };
  }
  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, reason: "claude record type is missing or invalid" };
  }

  const timestamp = stringField(value, "timestamp");
  if (timestamp !== undefined && !isIsoDateTime(timestamp)) {
    return { ok: false, reason: "claude record timestamp is invalid" };
  }

  // session_id is a snake_case duplicate present on roughly half of records.
  const sessionId =
    stringField(value, "sessionId") ?? stringField(value, "session_id");

  const envelope: ClaudeEnvelope = {
    type,
    isSidechain: value.isSidechain === true,
    isMeta: value.isMeta === true,
    raw: value,
    ...optional("uuid", stringField(value, "uuid")),
    ...optional("parentUuid", stringField(value, "parentUuid")),
    ...optional("logicalParentUuid", stringField(value, "logicalParentUuid")),
    ...optional("sessionId", sessionId),
    ...optional("timestamp", timestamp),
    ...optional("cwd", stringField(value, "cwd")),
    ...optional("gitBranch", stringField(value, "gitBranch")),
    ...optional("version", stringField(value, "version")),
    ...optional("agentId", stringField(value, "agentId")),
    ...optional("requestId", stringField(value, "requestId")),
  };
  return { ok: true, envelope };
}

/** The effective DAG edge: compaction severs parentUuid and moves it here. */
export function effectiveParentUuid(
  envelope: ClaudeEnvelope,
): string | undefined {
  return envelope.parentUuid ?? envelope.logicalParentUuid;
}

export interface ClaudeMessage {
  readonly id?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly content: readonly ClaudeContentBlock[];
  readonly usage?: Readonly<Record<string, unknown>>;
  /** True when message.content was a bare string rather than a block array. */
  readonly contentWasString: boolean;
}

export type ClaudeContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking" }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly isError: boolean | undefined;
      readonly text: string | undefined;
    }
  | { readonly type: "other"; readonly blockType: string };

export function decodeClaudeMessage(value: unknown): ClaudeMessage | undefined {
  if (!isObject(value)) return undefined;
  const message = value.message;
  if (!isObject(message)) return undefined;

  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return {
      content: [{ type: "text", text: rawContent }],
      contentWasString: true,
      ...optional("id", stringField(message, "id")),
      ...optional("model", stringField(message, "model")),
      ...optional("stopReason", stringField(message, "stop_reason")),
      ...(isObject(message.usage) ? { usage: message.usage } : {}),
    };
  }
  if (!Array.isArray(rawContent)) return undefined;

  const content: ClaudeContentBlock[] = [];
  for (const block of rawContent) {
    if (!isObject(block)) continue;
    const blockType = stringField(block, "type");
    if (blockType === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (blockType === "thinking") {
      // Hidden reasoning is excluded from Barbaro at every tier; the block is
      // recorded as present but its content is never read.
      content.push({ type: "thinking" });
    } else if (blockType === "tool_use") {
      const id = stringField(block, "id");
      const name = stringField(block, "name");
      if (id && name) {
        content.push({
          type: "tool_use",
          id,
          name,
          input: isObject(block.input) ? block.input : {},
        });
      }
    } else if (blockType === "tool_result") {
      const toolUseId = stringField(block, "tool_use_id");
      if (toolUseId) {
        content.push({
          type: "tool_result",
          toolUseId,
          isError:
            typeof block.is_error === "boolean" ? block.is_error : undefined,
          text: toolResultText(block.content),
        });
      }
    } else if (blockType) {
      content.push({ type: "other", blockType });
    }
  }

  return {
    content,
    contentWasString: false,
    ...optional("id", stringField(message, "id")),
    ...optional("model", stringField(message, "model")),
    ...optional("stopReason", stringField(message, "stop_reason")),
    ...(isObject(message.usage) ? { usage: message.usage } : {}),
  };
}

function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Provenance of a user record. `origin.kind === "human"` is high precision but
 * incomplete: version 2.1.220 emits human prompts both with and without it, so
 * a structural fallback is mandatory or ~16% of turn starts vanish.
 */
export type ClaudePromptProvenance =
  | { readonly kind: "human"; readonly method: "origin"; readonly promptSource?: string }
  | { readonly kind: "human"; readonly method: "structural"; readonly reason: "no-origin" }
  | { readonly kind: "sdk" }
  | { readonly kind: "task-notification" }
  | { readonly kind: "unknown-provenance"; readonly promptSource: string }
  | { readonly kind: "tool-result" }
  | { readonly kind: "not-a-prompt" };

export interface ClassifyOptions {
  /**
   * True when the file being read is a subagent trace. Every record there is
   * isSidechain, and its DAG-root user record is the subagent's own prompt,
   * so sidechain records must be accepted rather than rejected.
   */
  readonly isSubagentTrace?: boolean;
}

export function classifyUserRecord(
  envelope: ClaudeEnvelope,
  message: ClaudeMessage | undefined,
  options: ClassifyOptions = {},
): ClaudePromptProvenance {
  if (envelope.type !== "user" || message === undefined) {
    return { kind: "not-a-prompt" };
  }
  if (message.content.some((block) => block.type === "tool_result")) {
    return { kind: "tool-result" };
  }
  if (envelope.isMeta) return { kind: "not-a-prompt" };
  if (envelope.isSidechain && !options.isSubagentTrace) {
    return { kind: "not-a-prompt" };
  }

  const raw = envelope.raw;
  const origin = isObject(raw.origin) ? raw.origin : undefined;
  const originKind = origin ? stringField(origin, "kind") : undefined;
  const promptSource = stringField(raw, "promptSource");

  if (originKind === "human") {
    return {
      kind: "human",
      method: "origin",
      ...optional("promptSource", promptSource),
    };
  }
  if (originKind === "task-notification") return { kind: "task-notification" };
  if (promptSource === "sdk") return { kind: "sdk" };
  if (promptSource === "system") return { kind: "task-notification" };

  // A promptSource we do not recognize is not evidence of a human. Guessing
  // would attach machine-driven work to whatever human turn came before it.
  if (promptSource !== undefined && !HUMAN_PROMPT_SOURCES.has(promptSource)) {
    return { kind: "unknown-provenance", promptSource };
  }

  // No provenance fields at all: fall back to structure. This is the branch
  // that recovers human prompts on versions/entrypoints that omit `origin`.
  return { kind: "human", method: "structural", reason: "no-origin" };
}

/** promptSource values that denote a real person driving the session. */
export const HUMAN_PROMPT_SOURCES: ReadonlySet<string> = new Set([
  "typed",
  "queued",
  "suggestion_accepted",
]);

/**
 * An async subagent reports completion as a task notification naming the
 * tool_use that launched it, not by anything written into its own file.
 */
export function taskNotificationToolUseId(
  text: string | undefined,
): string | undefined {
  if (!text) return undefined;
  const match = /<tool-use-id>([^<\s]+)<\/tool-use-id>/.exec(text);
  return match?.[1];
}

/**
 * The harness names its own background tasks. A notification carrying a
 * `<task-id>` is a structured report from the harness's task machinery; free
 * prose that merely mentions a background task is not, and stays foreign.
 *
 * Observed on Claude Code 2.1.233. It is a format, not a documented contract.
 *
 * Unlike `<tool-use-id>`, this does NOT identify the issuing call: a watcher's
 * only link back is prose inside a tool result, which is not a contract.
 */
export function taskNotificationTaskId(
  text: string | undefined,
): string | undefined {
  if (!text) return undefined;
  const match = /<task-id>([^<\s]+)<\/task-id>/.exec(text);
  return match?.[1];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function isIsoDateTime(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}
