import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  BarbaroEvidenceV1,
  BarbaroSubagentTurnContentV1,
  BarbaroTurnV1,
} from "../contracts/v1.js";
import {
  createEvidenceId,
  createJsonlCheckpoint,
  createSessionId,
  fileIdentityEquals,
  iterateJsonlForward,
  readJsonlForward,
  resolveJsonlCheckpoint,
} from "../core/index.js";
import { withDirectoryLock } from "../output/directory-lock.js";
import { appendUniqueJsonl } from "../output/jsonl-store.js";
import {
  CodexTurnNormalizer,
  type CodexNormalizerStateV1,
} from "../providers/codex/normalizer.js";
import {
  readCodexRunnerState,
  writeCodexRunnerState,
  type CodexRunnerStateV1,
} from "./state.js";

export interface RunCodexTraceOptions {
  readonly tracePath: string;
  readonly projectRoot: string;
  readonly barbaroDirectory?: string;
  /** Fail before publishing when a hook's asserted owner disagrees with the trace. */
  readonly expectedNativeSessionId?: string;
  readonly reset?: boolean;
}

export interface CodexTraceIdentity {
  readonly nativeSessionId: string;
  readonly nativeThreadId: string;
  readonly historyMode: string;
  readonly workspaceRoot?: string;
}

export interface RunCodexTraceResult {
  readonly trace_id: string;
  readonly checkpoint_status: string;
  readonly input: {
    readonly complete_lines: number;
    readonly parsed_lines: number;
    readonly malformed_lines: number;
    readonly partial_final_line: boolean;
  };
  readonly output: {
    readonly turns_appended: number;
    readonly turns_skipped: number;
    readonly evidence_appended: number;
    readonly evidence_skipped: number;
    /**
     * IDs already published with different content. Conflicts are non-fatal at
     * the storage layer so one bad record cannot wedge publishing, which means
     * the count is the ONLY signal that determinism broke. Dropping it here
     * would let Codex keep stale content, advance its checkpoint, and report
     * success — trading an outage for silent corruption.
     */
    readonly conflicted: number;
    readonly conflicted_ids: readonly string[];
    readonly terminal_native_turn_ids: readonly string[];
  };
  readonly diagnostics: ReturnType<CodexTurnNormalizer["diagnostics"]>;
}

export async function runCodexTrace(
  options: RunCodexTraceOptions,
): Promise<RunCodexTraceResult> {
  const tracePath = resolve(options.tracePath);
  if (tracePath.endsWith(".zst")) {
    throw new Error("Compressed .jsonl.zst rollouts are not supported yet");
  }
  const projectRoot = resolve(options.projectRoot);
  const defaultBarbaroDirectory = join(projectRoot, ".barbaro");
  const barbaroDirectory = resolve(
    options.barbaroDirectory ?? defaultBarbaroDirectory,
  );
  if (barbaroDirectory !== defaultBarbaroDirectory) {
    throw new Error("Barbaro v1 output directory must be <projectRoot>/.barbaro");
  }
  assertInsideProject(projectRoot, barbaroDirectory);
  const statePath = join(
    barbaroDirectory,
    "state",
    "codex",
    `${hashKey(`path:${tracePath}`)}.json`,
  );

  return withDirectoryLock(`${statePath}.ingest`, async () => {
    const saved = options.reset ? undefined : await readCodexRunnerState(statePath);
  const resolution = await resolveJsonlCheckpoint(tracePath, saved?.checkpoint);
  if (resolution.status === "missing") {
    throw new Error(`Codex trace does not exist: ${tracePath}`);
  }
  const savedSession = saved?.normalizer.session;
  const savedNativeSessionId = savedSession?.nativeSessionId;
  const savedNativeThreadId = savedSession?.nativeThreadId;
  const expectedSavedTraceId = savedNativeSessionId && savedNativeThreadId
    ? codexTraceId(savedNativeSessionId, savedNativeThreadId)
    : undefined;
  const canResume =
    resolution.status === "resume" &&
    saved !== undefined &&
    expectedSavedTraceId !== undefined &&
    saved.trace_id === expectedSavedTraceId;
  const canonicalSession = canResume
      ? {
        nativeSessionId: savedNativeSessionId!,
        nativeThreadId: savedNativeThreadId!,
        historyMode: saved!.normalizer.session?.historyMode ?? "legacy",
      }
    : await readCodexTraceIdentity(tracePath);
  if (!canonicalSession) {
    throw new Error("Codex trace has no complete valid session_meta record");
  }
  if (
    options.expectedNativeSessionId !== undefined &&
    canonicalSession.nativeSessionId !== options.expectedNativeSessionId
  ) {
    throw new Error(
      "Codex hook session_id does not match transcript session_meta.session_id",
    );
  }
  if (canonicalSession.historyMode !== "legacy") {
    throw new Error(
      `Unsupported Codex history_mode: ${canonicalSession.historyMode}; ` +
        "this runner currently supports legacy histories only",
    );
  }
  const nativeSessionId = canonicalSession.nativeSessionId;
  const traceId = codexTraceId(
    nativeSessionId,
    canonicalSession.nativeThreadId,
  );
  const normalizer = canResume
    ? CodexTurnNormalizer.restore(saved!.normalizer)
    : new CodexTurnNormalizer();
  const turns: BarbaroTurnV1[] = [];
  const evidence: BarbaroEvidenceV1[] = [];

  const summary = await readJsonlForward(
    tracePath,
    (event) => {
      if (event.kind === "malformed") return;
      const batch = normalizer.accept(event.value, {
        traceId,
        lineNumber: event.lineNumber,
        byteStart: event.byteStart,
        byteEndExclusive: event.byteEndExclusive,
      });
      turns.push(...batch.turns);
      evidence.push(...batch.evidence);
    },
    {
      startOffset: canResume ? resolution.startOffset : 0,
      nextLineNumber: canResume ? resolution.nextLineNumber : 1,
    },
  );
  if (
    resolution.snapshot &&
    !fileIdentityEquals(summary.fileIdentity, resolution.snapshot.identity)
  ) {
    throw new Error("Codex trace changed identity during ingestion; retry from a fresh checkpoint");
  }

  const normalizerState = normalizer.snapshot();
  const canonicalRoot = normalizerState.session?.workspaceRoot;
  if (canonicalRoot && resolve(canonicalRoot) !== projectRoot) {
    throw new Error(
      `Trace project ${resolve(canonicalRoot)} does not match requested project ${projectRoot}`,
    );
  }

  const { feedTurns, evidenceRecords } = routeSubagentTurns(
    turns,
    evidence,
    normalizerState,
    traceId,
  );
  const sessionId = normalizerState.session
    ? createSessionId("codex", normalizerState.session.nativeSessionId)
    : undefined;
  if (
    sessionId &&
    normalizerState.session?.barbaroSessionId !== sessionId
  ) {
    throw new Error("Codex normalizer state contains a mismatched derived session ID");
  }
  if (!sessionId && (feedTurns.length > 0 || evidenceRecords.length > 0)) {
    throw new Error("Codex output was produced before canonical session metadata");
  }

  // Evidence is published first so a crash can leave only harmless orphan
  // evidence, never a visible digest with dangling evidence_refs.
  const evidenceResult = sessionId
    ? await appendUniqueJsonl(
        join(barbaroDirectory, "evidence", "codex", `${sessionId}.jsonl`),
        evidenceRecords,
        (item) => item.evidence_id,
      )
    : { appended: 0, skipped: 0, conflicted: 0, conflictedIds: [] };
  const turnResult = sessionId
    ? await appendUniqueJsonl(
        join(barbaroDirectory, "feed", "codex", `${sessionId}.jsonl`),
        feedTurns,
        (turn) => turn.turn_id,
      )
    : { appended: 0, skipped: 0, conflictedIds: [], conflicted: 0 };

  const runnerState: CodexRunnerStateV1 = {
    schema: "barbaro.codex-runner-state.v1",
    trace_id: traceId,
    checkpoint: createJsonlCheckpoint(summary),
    normalizer: normalizerState,
  };
  await writeCodexRunnerState(statePath, runnerState);

    return {
      trace_id: traceId,
      checkpoint_status: resolution.status,
      input: {
        complete_lines: summary.completeLines,
        parsed_lines: summary.parsedLines,
        malformed_lines: summary.malformedLines,
        partial_final_line: summary.partialFinalLine !== undefined,
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
        terminal_native_turn_ids: turns
          .map((turn) => turn.extensions?.codex?.native_turn_id)
          .filter((turnId): turnId is string => typeof turnId === "string"),
      },
      diagnostics: normalizer.diagnostics(),
    };
  });
}

function routeSubagentTurns(
  turns: readonly BarbaroTurnV1[],
  evidence: readonly BarbaroEvidenceV1[],
  state: CodexNormalizerStateV1,
  traceId: string,
): { feedTurns: BarbaroTurnV1[]; evidenceRecords: BarbaroEvidenceV1[] } {
  if (state.session?.threadSource !== "subagent") {
    return { feedTurns: [...turns], evidenceRecords: [...evidence] };
  }
  const evidenceRecords = [...evidence];
  for (const turn of turns) {
    const content: BarbaroSubagentTurnContentV1 = {
      role: codexSubagentRole(state.session.actorId),
      sequence: turn.sequence,
      outcome: turn.outcome,
      started_at: turn.started_at,
      ended_at: turn.ended_at,
      request: turn.request,
      ...(turn.response === undefined ? {} : { response: turn.response }),
      actions: turn.actions,
    };
    evidenceRecords.push({
      schema: "barbaro.evidence.v1",
      evidence_id: createEvidenceId(
        turn.turn_id,
        childTurnSourceIdentity(turn, traceId),
        0,
      ),
      turn_id: turn.turn_id,
      provider: "codex",
      session_id: turn.session_id,
      agent_id: turn.agent_id,
      parent_link: {
        method: "unresolved",
        native_key: state.session.nativeThreadId,
      },
      kind: "subagent_turn",
      occurred_at: turn.ended_at,
      content,
      source_refs: turn.source_refs,
      ...(turn.extensions === undefined ? {} : { extensions: turn.extensions }),
    });
  }
  return { feedTurns: [], evidenceRecords };
}

/** A trace ID names one physical rollout artifact, not the whole session. */
function codexTraceId(
  nativeSessionId: string,
  nativeThreadId: string,
): string {
  return `codex:${nativeSessionId}:thread:${nativeThreadId}`;
}

function childTurnSourceIdentity(
  turn: BarbaroTurnV1,
  fallbackTraceId: string,
): string {
  const source = turn.source_refs[0];
  const nativeId = source?.native_record_ids?.[0];
  if (nativeId) return `native:${nativeId}`;
  if (source?.line_start !== undefined) {
    return `${source.trace_id}:line:${source.line_start}`;
  }
  // `turn_id` is already stable and unique. This fallback is reachable only
  // for a future producer that supplies neither a native record ID nor a line.
  return `${fallbackTraceId}:turn:${turn.turn_id}`;
}

function codexSubagentRole(actorId: string): string {
  return actorId.split("/").filter(Boolean).at(-1) ?? "subagent";
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

export async function readCodexTraceIdentity(
  tracePath: string,
): Promise<CodexTraceIdentity | undefined> {
  for await (const event of iterateJsonlForward(tracePath)) {
    // session_meta is the first canonical rollout record. Bound a malformed or
    // adversarial prefix so a synchronous hook never scans an arbitrary file.
    if (event.byteEndExclusive > 256 * 1024 || event.lineNumber > 64) {
      return undefined;
    }
    if (event.kind !== "record" || !isObject(event.value)) continue;
    if (event.value.type !== "session_meta" || !isObject(event.value.payload)) continue;
    const sessionId = nonEmptyString(event.value.payload.session_id)
      ?? nonEmptyString(event.value.payload.id);
    if (sessionId) {
      return {
        nativeSessionId: sessionId,
        nativeThreadId:
          nonEmptyString(event.value.payload.id) ?? sessionId,
        historyMode:
          nonEmptyString(event.value.payload.history_mode) ?? "legacy",
        ...(nonEmptyString(event.value.payload.cwd) === undefined
          ? {}
          : { workspaceRoot: nonEmptyString(event.value.payload.cwd)! }),
      };
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
