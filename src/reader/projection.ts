import type {
  BarbaroAction,
  BarbaroActiveLeaseV1,
  BarbaroContent,
  BarbaroEvidenceV1,
  BarbaroSubagentTurnEvidenceV1,
  BarbaroTurnV1,
} from "../contracts/v1.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";

import {
  assertReaderByteBudget,
  assertReaderNonNegativeInteger,
  maximizeReaderBudget,
  readerProjectionFits,
  truncateReaderUtf8,
  utf8Bytes,
  wrapReaderProjection,
} from "./budget.js";
import {
  READER_CONTEXT_SCHEMA,
  READER_EVIDENCE_SCHEMA,
  type ReaderActionSummary,
  type ReaderActiveSummary,
  type ReaderBoundedItems,
  type ReaderContentSummary,
  type ReaderContextV1,
  type ReaderDiagnostics,
  type ReaderEvidenceV1,
  type ReaderJsonExcerpt,
  type ReaderProjection,
  type ReaderProjectionOptions,
  type ReaderSubagentEvidenceSummary,
  type ReaderSubagentSummary,
  type ReaderTurnSummary,
} from "./types.js";

const DEFAULT_REQUEST_EXCERPT_BYTES = 1024;
const DEFAULT_RESPONSE_EXCERPT_BYTES = 2048;
const DEFAULT_ACTION_EXCERPT_BYTES = 256;

interface ProjectionLimits {
  readonly byteBudget: number;
  readonly requestExcerptBytes: number;
  readonly responseExcerptBytes: number;
  readonly actionExcerptBytes: number;
}

function projectionLimits(options: ReaderProjectionOptions): ProjectionLimits {
  assertReaderByteBudget(options.byteBudget);
  const requestExcerptBytes =
    options.requestExcerptBytes ?? DEFAULT_REQUEST_EXCERPT_BYTES;
  const responseExcerptBytes =
    options.responseExcerptBytes ?? DEFAULT_RESPONSE_EXCERPT_BYTES;
  const actionExcerptBytes =
    options.actionExcerptBytes ?? DEFAULT_ACTION_EXCERPT_BYTES;
  assertReaderNonNegativeInteger(requestExcerptBytes, "requestExcerptBytes");
  assertReaderNonNegativeInteger(responseExcerptBytes, "responseExcerptBytes");
  assertReaderNonNegativeInteger(actionExcerptBytes, "actionExcerptBytes");
  return {
    byteBudget: options.byteBudget,
    requestExcerptBytes,
    responseExcerptBytes,
    actionExcerptBytes,
  };
}

export function projectReaderContent(
  content: BarbaroContent,
  maximumTextBytes: number,
): ReaderContentSummary {
  assertReaderNonNegativeInteger(maximumTextBytes, "maximumTextBytes");
  const canonicalBytes = utf8Bytes(content.text);
  const text = truncateReaderUtf8(content.text, maximumTextBytes);
  const shownBytes = utf8Bytes(text);
  return {
    text,
    fidelity: content.fidelity,
    truncated: {
      canonical: content.truncated,
      projection: shownBytes < canonicalBytes,
    },
    utf8_bytes: {
      shown: shownBytes,
      canonical: canonicalBytes,
      original: content.original_utf8_bytes ?? canonicalBytes,
    },
    redactions: [...content.redactions].sort((left, right) =>
      compareUtf16CodeUnits(left.kind, right.kind) || left.count - right.count,
    ),
  };
}

export function projectReaderAction(
  action: BarbaroAction,
  maximumTextBytes: number,
): ReaderActionSummary {
  const common = {
    action_id: action.action_id,
    kind: action.kind,
    outcome: action.outcome,
    source_refs: action.source_refs.length,
  } as const;

  switch (action.kind) {
    case "file_change":
      return {
        ...common,
        operation: action.operation,
        path: action.path,
        ...(action.previous_path === undefined
          ? {}
          : { previous_path: action.previous_path }),
        ...(action.added_lines === undefined
          ? {}
          : { added_lines: action.added_lines }),
        ...(action.removed_lines === undefined
          ? {}
          : { removed_lines: action.removed_lines }),
      };
    case "command":
      return {
        ...common,
        command: projectReaderContent(action.command, maximumTextBytes),
        ...(action.exit_code === undefined ? {} : { exit_code: action.exit_code }),
        ...(action.failure_excerpt === undefined
          ? {}
          : {
              failure_excerpt: projectReaderContent(
                action.failure_excerpt,
                maximumTextBytes,
              ),
            }),
      };
    case "test":
      return {
        ...common,
        command: projectReaderContent(action.command, maximumTextBytes),
        ...(action.exit_code === undefined ? {} : { exit_code: action.exit_code }),
        ...(action.passed === undefined ? {} : { passed: action.passed }),
        ...(action.failed === undefined ? {} : { failed: action.failed }),
        ...(action.failure_excerpt === undefined
          ? {}
          : {
              failure_excerpt: projectReaderContent(
                action.failure_excerpt,
                maximumTextBytes,
              ),
            }),
      };
    case "tool":
      return {
        ...common,
        tool_name: action.tool_name,
        ...(action.summary === undefined
          ? {}
          : { summary: projectReaderContent(action.summary, maximumTextBytes) }),
      };
    case "other":
      return {
        ...common,
        summary: projectReaderContent(action.summary, maximumTextBytes),
      };
  }
}

function boundedItems<T>(
  all: readonly T[],
  shown: number,
  project: (item: T, index: number) => T = (item) => item,
  nextCursor?: string,
): ReaderBoundedItems<T> {
  return {
    shown,
    total: all.length,
    items: all.slice(0, shown).map(project),
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
}

function emptySubagents(turn: BarbaroTurnV1): ReaderSubagentSummary {
  return {
    total: turn.subagents.total,
    by_role: [...turn.subagents.by_role].sort((left, right) =>
      compareUtf16CodeUnits(left.role, right.role) || left.count - right.count,
    ),
    outcomes: { ...turn.subagents.outcomes },
    changed_paths: boundedItems(turn.subagents.changed_paths, 0),
    evidence_refs: boundedItems(turn.subagents.evidence_refs, 0),
  };
}

export function projectTurn(
  turn: BarbaroTurnV1,
  options: ReaderProjectionOptions,
): ReaderProjection<ReaderTurnSummary> {
  const limits = projectionLimits(options);
  let requestBytes = 0;
  let responseBytes = 0;
  let actionCount = 0;
  let actionTextBytes: readonly number[] = [];
  let evidenceCount = 0;
  let changedPathCount = 0;
  let subagentEvidenceCount = 0;

  const build = (): ReaderTurnSummary => {
    const subagents = emptySubagents(turn);
    return {
      turn_id: turn.turn_id,
      provider: turn.provider,
      session_id: turn.session_id,
      sequence: turn.sequence,
      ...(turn.workstream_id === undefined
        ? {}
        : { workstream_id: turn.workstream_id }),
      agent_id: turn.agent_id,
      ...(turn.parent_turn_id === undefined
        ? {}
        : { parent_turn_id: turn.parent_turn_id }),
      started_at: turn.started_at,
      ended_at: turn.ended_at,
      outcome: turn.outcome,
      request: projectReaderContent(turn.request, requestBytes),
      ...(turn.response === undefined
        ? {}
        : { response: projectReaderContent(turn.response, responseBytes) }),
      actions: {
        shown: actionCount,
        total: turn.actions.length,
        items: turn.actions.slice(0, actionCount).map((action, index) =>
          projectReaderAction(action, actionTextBytes[index] ?? 0),
        ),
      },
      evidence_refs: boundedItems(turn.evidence_refs, evidenceCount),
      subagents: {
        ...subagents,
        changed_paths: boundedItems(
          turn.subagents.changed_paths,
          changedPathCount,
        ),
        evidence_refs: boundedItems(
          turn.subagents.evidence_refs,
          subagentEvidenceCount,
        ),
      },
      source_refs: turn.source_refs.length,
    };
  };

  // This establishes a deterministic minimum containing all omission metadata.
  wrapReaderProjection(build(), limits.byteBudget);

  requestBytes = maximizeReaderBudget(limits.requestExcerptBytes, (candidate) => {
    requestBytes = candidate;
    return readerProjectionFits(build(), limits.byteBudget);
  });
  if (requestBytes < 0) requestBytes = 0;

  if (turn.response !== undefined) {
    responseBytes = maximizeReaderBudget(
      limits.responseExcerptBytes,
      (candidate) => {
        responseBytes = candidate;
        return readerProjectionFits(build(), limits.byteBudget);
      },
    );
    if (responseBytes < 0) responseBytes = 0;
  }

  for (let index = 0; index < turn.actions.length; index += 1) {
    actionCount = index + 1;
    const nextTextBytes = maximizeReaderBudget(
      limits.actionExcerptBytes,
      (candidate) => {
        actionTextBytes = [...actionTextBytes, candidate];
        const fits = readerProjectionFits(build(), limits.byteBudget);
        actionTextBytes = actionTextBytes.slice(0, -1);
        return fits;
      },
    );
    if (nextTextBytes < 0) {
      actionCount = index;
      break;
    }
    actionTextBytes = [...actionTextBytes, nextTextBytes];
  }

  evidenceCount = appendWhileFits(
    turn.evidence_refs.length,
    evidenceCount,
    (candidate) => {
      evidenceCount = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  changedPathCount = appendWhileFits(
    turn.subagents.changed_paths.length,
    changedPathCount,
    (candidate) => {
      changedPathCount = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  subagentEvidenceCount = appendWhileFits(
    turn.subagents.evidence_refs.length,
    subagentEvidenceCount,
    (candidate) => {
      subagentEvidenceCount = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );

  return wrapReaderProjection(build(), limits.byteBudget);
}

export function projectActiveLease(
  lease: BarbaroActiveLeaseV1,
  options: ReaderProjectionOptions,
): ReaderProjection<ReaderActiveSummary> {
  const state = lease.state;
  if (state === "idle") {
    throw new TypeError("Idle tombstones are not peer-visible active leases");
  }
  const limits = projectionLimits(options);
  let intentBytes = 0;
  let commandBytes = 0;
  let claimCount = 0;

  const build = (): ReaderActiveSummary => ({
    lease_id: lease.lease_id,
    provider: lease.provider,
    session_id: lease.session_id,
    ...(lease.workstream_id === undefined
      ? {}
      : { workstream_id: lease.workstream_id }),
    ...(lease.turn_id === undefined ? {} : { turn_id: lease.turn_id }),
    agent_id: lease.agent_id,
    state,
    ...(lease.intent === undefined
      ? {}
      : { intent: projectReaderContent(lease.intent, intentBytes) }),
    ...(lease.current_action === undefined
      ? {}
      : {
          current_action: {
            kind: lease.current_action.kind,
            ...(lease.current_action.tool_name === undefined
              ? {}
              : { tool_name: lease.current_action.tool_name }),
            ...(lease.current_action.path === undefined
              ? {}
              : { path: lease.current_action.path }),
            ...(lease.current_action.command === undefined
              ? {}
              : {
                  command: projectReaderContent(
                    lease.current_action.command,
                    commandBytes,
                  ),
                }),
            ...(lease.current_action.started_at === undefined
              ? {}
              : { started_at: lease.current_action.started_at }),
          },
        }),
    claims: boundedItems(lease.claims, claimCount),
    unknown_write_scope: lease.unknown_write_scope,
    revision: lease.revision,
    updated_at: lease.updated_at,
    expires_at: lease.expires_at,
    source_refs: lease.source_refs?.length ?? 0,
  });

  wrapReaderProjection(build(), limits.byteBudget);
  if (lease.intent !== undefined) {
    intentBytes = maximizeReaderBudget(
      limits.requestExcerptBytes,
      (candidate) => {
        intentBytes = candidate;
        return readerProjectionFits(build(), limits.byteBudget);
      },
    );
    if (intentBytes < 0) intentBytes = 0;
  }
  if (lease.current_action?.command !== undefined) {
    commandBytes = maximizeReaderBudget(
      limits.actionExcerptBytes,
      (candidate) => {
        commandBytes = candidate;
        return readerProjectionFits(build(), limits.byteBudget);
      },
    );
    if (commandBytes < 0) commandBytes = 0;
  }
  claimCount = appendWhileFits(
    lease.claims.length,
    claimCount,
    (candidate) => {
      claimCount = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  return wrapReaderProjection(build(), limits.byteBudget);
}

export function projectContext(
  active: readonly BarbaroActiveLeaseV1[],
  turns: readonly BarbaroTurnV1[],
  diagnostics: ReaderDiagnostics,
  options: ReaderProjectionOptions & { readonly workstreamId?: string },
): ReaderProjection<ReaderContextV1> {
  const limits = projectionLimits(options);
  let activeItems: ReaderActiveSummary[] = [];
  let turnItems: ReaderTurnSummary[] = [];
  const build = (): ReaderContextV1 => ({
    schema: READER_CONTEXT_SCHEMA,
    ...(options.workstreamId === undefined
      ? {}
      : { workstream_id: options.workstreamId }),
    active: {
      shown: activeItems.length,
      total: active.length,
      items: activeItems,
    },
    turns: {
      shown: turnItems.length,
      total: turns.length,
      items: turnItems,
    },
    diagnostics,
  });

  wrapReaderProjection(build(), limits.byteBudget);
  for (const lease of active) {
    const item = largestNestedProjection(
      limits.byteBudget,
      (byteBudget) => projectActiveLease(lease, { ...options, byteBudget }).value,
      (candidate) => {
        const previous = activeItems;
        activeItems = [...activeItems, candidate];
        const fits = readerProjectionFits(build(), limits.byteBudget);
        activeItems = previous;
        return fits;
      },
    );
    if (item === undefined) break;
    activeItems = [...activeItems, item];
  }

  for (const turn of turns) {
    const item = largestNestedProjection(
      limits.byteBudget,
      (byteBudget) => projectTurn(turn, { ...options, byteBudget }).value,
      (candidate) => {
        const previous = turnItems;
        turnItems = [...turnItems, candidate];
        const fits = readerProjectionFits(build(), limits.byteBudget);
        turnItems = previous;
        return fits;
      },
    );
    if (item === undefined) break;
    turnItems = [...turnItems, item];
  }
  return wrapReaderProjection(build(), limits.byteBudget);
}

export function projectEvidence(
  evidence: BarbaroEvidenceV1,
  options: ReaderProjectionOptions & { readonly actionCursor?: string },
): ReaderProjection<ReaderEvidenceV1> {
  const limits = projectionLimits(options);
  if (evidence.kind !== "subagent_turn") {
    if (options.actionCursor !== undefined) {
      throw new TypeError("actionCursor is valid only for subagent_turn evidence");
    }
    return projectGeneralEvidence(evidence, limits);
  }
  return projectSubagentEvidence(evidence, options.actionCursor, limits);
}

function projectGeneralEvidence(
  evidence: Exclude<BarbaroEvidenceV1, BarbaroSubagentTurnEvidenceV1>,
  limits: ProjectionLimits,
): ReaderProjection<ReaderEvidenceV1> {
  const canonical = stableStringify(evidence.content);
  let contentBytes = 0;
  const build = (): ReaderEvidenceV1 => ({
    ...evidenceEnvelope(evidence),
    content: jsonExcerpt(canonical, contentBytes),
  });
  wrapReaderProjection(build(), limits.byteBudget);
  contentBytes = maximizeReaderBudget(
    limits.responseExcerptBytes,
    (candidate) => {
      contentBytes = candidate;
      return readerProjectionFits(build(), limits.byteBudget);
    },
  );
  if (contentBytes < 0) contentBytes = 0;
  return wrapReaderProjection(build(), limits.byteBudget);
}

function projectSubagentEvidence(
  evidence: BarbaroSubagentTurnEvidenceV1,
  cursor: string | undefined,
  limits: ProjectionLimits,
): ReaderProjection<ReaderEvidenceV1> {
  const offset = parseActionCursor(cursor, evidence.content.actions.length);
  let requestBytes = 0;
  let responseBytes = 0;
  let actionsShown = 0;
  let actionTextBytes: readonly number[] = [];
  const build = (): ReaderEvidenceV1 => ({
    ...evidenceEnvelope(evidence),
    content: {
      role: evidence.content.role,
      sequence: evidence.content.sequence,
      outcome: evidence.content.outcome,
      started_at: evidence.content.started_at,
      ended_at: evidence.content.ended_at,
      request: projectReaderContent(evidence.content.request, requestBytes),
      ...(evidence.content.response === undefined
        ? {}
        : {
            response: projectReaderContent(
              evidence.content.response,
              responseBytes,
            ),
          }),
      actions: {
        shown: actionsShown,
        total: evidence.content.actions.length,
        items: evidence.content.actions
          .slice(offset, offset + actionsShown)
          .map((action, index) =>
            projectReaderAction(action, actionTextBytes[index] ?? 0),
          ),
        ...(offset + actionsShown >= evidence.content.actions.length
          ? {}
          : { next_cursor: `a:${offset + actionsShown}` }),
      },
    },
  });

  wrapReaderProjection(build(), limits.byteBudget);
  const appendAction = (index: number): boolean => {
    actionsShown = index - offset + 1;
    const nextTextBytes = maximizeReaderBudget(
      limits.actionExcerptBytes,
      (candidate) => {
        actionTextBytes = [...actionTextBytes, candidate];
        const fits = readerProjectionFits(build(), limits.byteBudget);
        actionTextBytes = actionTextBytes.slice(0, -1);
        return fits;
      },
    );
    if (nextTextBytes < 0) {
      actionsShown -= 1;
      return false;
    }
    actionTextBytes = [...actionTextBytes, nextTextBytes];
    return true;
  };

  // A page with a continuation cursor must always make forward progress.
  if (
    offset < evidence.content.actions.length &&
    !appendAction(offset)
  ) {
    actionsShown = 1;
    actionTextBytes = [0];
    return wrapReaderProjection(build(), limits.byteBudget);
  }

  requestBytes = maximizeReaderBudget(limits.requestExcerptBytes, (candidate) => {
    requestBytes = candidate;
    return readerProjectionFits(build(), limits.byteBudget);
  });
  if (requestBytes < 0) requestBytes = 0;
  if (evidence.content.response !== undefined) {
    responseBytes = maximizeReaderBudget(
      limits.responseExcerptBytes,
      (candidate) => {
        responseBytes = candidate;
        return readerProjectionFits(build(), limits.byteBudget);
      },
    );
    if (responseBytes < 0) responseBytes = 0;
  }

  for (
    let index = offset + actionsShown;
    index < evidence.content.actions.length;
    index += 1
  ) {
    if (!appendAction(index)) break;
  }
  return wrapReaderProjection(build(), limits.byteBudget);
}

function evidenceEnvelope(evidence: BarbaroEvidenceV1): Omit<ReaderEvidenceV1, "content"> {
  return {
    schema: READER_EVIDENCE_SCHEMA,
    evidence_id: evidence.evidence_id,
    kind: evidence.kind,
    turn_id: evidence.turn_id,
    provider: evidence.provider,
    session_id: evidence.session_id,
    ...(evidence.workstream_id === undefined
      ? {}
      : { workstream_id: evidence.workstream_id }),
    agent_id: evidence.agent_id,
    ...(evidence.parent_turn_id === undefined
      ? {}
      : { parent_turn_id: evidence.parent_turn_id }),
    ...(evidence.parent_link === undefined
      ? {}
      : { parent_link: { ...evidence.parent_link } }),
    occurred_at: evidence.occurred_at,
    source_refs: evidence.source_refs.length,
  };
}

function jsonExcerpt(canonical: string, maximumBytes: number): ReaderJsonExcerpt {
  const text = truncateReaderUtf8(canonical, maximumBytes);
  return {
    text,
    truncated: text.length !== canonical.length,
    utf8_bytes: {
      shown: utf8Bytes(text),
      original: utf8Bytes(canonical),
    },
  };
}

function parseActionCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  const match = /^a:(0|[1-9][0-9]*)$/u.exec(cursor);
  if (match === null) {
    throw new TypeError("actionCursor must have the form a:<non-negative integer>");
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset > total) {
    throw new RangeError("actionCursor is beyond the evidence action list");
  }
  return offset;
}

function appendWhileFits(
  total: number,
  initial: number,
  tryCount: (candidate: number) => boolean,
): number {
  let shown = initial;
  while (shown < total) {
    const candidate = shown + 1;
    if (!tryCount(candidate)) break;
    shown = candidate;
  }
  return shown;
}

function largestNestedProjection<T>(
  outerBudget: number,
  project: (byteBudget: number) => T,
  fitsOuter: (candidate: T) => boolean,
): T | undefined {
  const preferred = [
    Math.min(outerBudget, 8192),
    Math.min(outerBudget, 4096),
    Math.min(outerBudget, 2048),
    Math.min(outerBudget, 1024),
    Math.min(outerBudget, 768),
    Math.min(outerBudget, 512),
    Math.min(outerBudget, 384),
    Math.min(outerBudget, 256),
  ];
  const budgets = [...new Set(preferred)].sort((left, right) => right - left);
  for (const byteBudget of budgets) {
    if (byteBudget <= 0) continue;
    try {
      const candidate = project(byteBudget);
      if (fitsOuter(candidate)) return candidate;
    } catch (error: unknown) {
      if (error instanceof RangeError) continue;
      throw error;
    }
  }
  return undefined;
}
