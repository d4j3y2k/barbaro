import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { BarbaroAction, BarbaroActionOutcome, BarbaroContent, BarbaroSourceRef, BarbaroTurnV1 } from "../../contracts/v1.js";
import { isDigestExcludedBarbaroCommand } from "../../core/barbaro-command.js";
import { isGeneratedBarbaroPath, normalizeRepoPath, redactedExcerptContent, verbatimContent } from "../../core/content.js";
import { createActionId, createSessionId, createTurnId } from "../../core/id.js";
import { readJsonlForward } from "../../core/jsonl-reader.js";

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface AgyCall { readonly name: string; readonly args: Record<string, unknown> }
export function nativeCall(value: unknown): AgyCall | undefined {
  if (!object(value) || typeof value.name !== "string" || !/^[\w.-]{1,180}$/u.test(value.name) || !object(value.args)) return undefined;
  return { name: value.name, args: value.args };
}

export function safeText(text: string, maxBytes: number): BarbaroContent {
  const copied = redactedExcerptContent(text, maxBytes);
  return copied.truncated || copied.redactions.length ? copied : verbatimContent(text);
}

export function editPath(call: AgyCall, projectRoot: string, cwd: string): string | undefined {
  let path: unknown;
  if (["write_file", "edit_file"].includes(call.name)) path = call.args.Path;
  else if (["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(call.name)) path = call.args.TargetFile;
  if (typeof path !== "string" || !path) return undefined;
  return normalizeRepoPath(projectRoot, resolve(cwd, path));
}

export function agyTurnId(id: string, step: number): string {
  return createTurnId("agy", id, "main", String(step));
}

export async function fullTracePath(id: string, supplied: unknown,
  brainRoot = join(homedir(), ".gemini", "antigravity-cli", "brain")): Promise<string | undefined> {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id) || typeof supplied !== "string") return undefined;
  const logs = join(resolve(brainRoot), id, ".system_generated", "logs");
  if (dirname(supplied) !== logs || !["transcript.jsonl", "transcript_full.jsonl"].includes(basename(supplied))) return undefined;
  // This file belongs to exactly one native conversation. Do not follow links
  // out of its brain directory, including through intermediate directories.
  if (await realpath(logs) !== join(await realpath(brainRoot), id, ".system_generated", "logs")) return undefined;
  return join(logs, "transcript_full.jsonl");
}

export interface AgyStep {
  readonly index: number;
  readonly line: number;
  readonly time: string;
  readonly source: string;
  readonly type: string;
  readonly status: string;
  readonly content?: string;
  readonly calls: readonly AgyCall[];
  readonly hasCalls: boolean;
  readonly callCount: number;
}

export interface AgyTurn {
  readonly input: AgyStep;
  readonly prompt: string;
  readonly sequence: number;
  readonly steps: AgyStep[];
}

/** Keep only the latest user segment and the specific previously admitted turn
 * that may need to be finalized after a missed Stop. Ignore private thoughts. */
export async function readAgyTurns(path: string, admittedStep?: number): Promise<{
  current?: AgyTurn; admitted?: AgyTurn;
}> {
  let current: AgyTurn | undefined;
  let admitted: AgyTurn | undefined;
  let sequence = 0;
  let lastIndex = -1;
  let valid = true;
  const read = await readJsonlForward(path, (line) => {
    if (line.kind !== "record") return;
    const row = line.value;
    if (!object(row) || typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index) ||
        row.step_index <= lastIndex || typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
        typeof row.source !== "string" || typeof row.type !== "string" || typeof row.status !== "string") { valid = false; return; }
    lastIndex = row.step_index;
    const calls = Array.isArray(row.tool_calls) ? row.tool_calls.map(nativeCall).filter((v): v is AgyCall => v !== undefined) : [];
    const step: AgyStep = { index: lastIndex, line: line.lineNumber, time: new Date(row.created_at).toISOString(),
      type: row.type, source: row.source, status: row.status,
      ...(typeof row.content === "string" ? { content: row.content } : {}),
      calls, callCount: Array.isArray(row.tool_calls) ? row.tool_calls.length : 0,
      hasCalls: row.tool_calls !== undefined && (!Array.isArray(row.tool_calls) || row.tool_calls.length > 0) };
    if (step.type === "USER_INPUT") {
      current = undefined;
      if (step.source !== "USER_EXPLICIT" || step.status !== "DONE") return;
      sequence++;
      const prompt = /^<USER_REQUEST>\r?\n([\s\S]*)\r?\n<\/USER_REQUEST>(?:\r?\n<|\s*$)/u.exec(step.content ?? "")?.[1];
      if (prompt === undefined) return;
      current = { input: step, prompt, sequence, steps: [] };
      if (step.index === admittedStep) admitted = current;
    } else current?.steps.push(step);
  }, { noFollow: true, requireSingleLink: true, pinEnd: true,
    maxFileBytes: 256 * 1024 * 1024, maxLineBytes: 16 * 1024 * 1024 });
  if (!valid || read.malformedLines || read.partialFinalLine) return {};
  return { ...(current ? { current } : {}), ...(admitted ? { admitted } : {}) };
}

function sourceRef(id: string, first: AgyStep, last = first): BarbaroSourceRef {
  return { trace_id: `agy:${id}:main`, line_start: first.line, line_end: last.line,
    native_record_ids: first.index === last.index ? [String(first.index)] : [String(first.index), String(last.index)] };
}

export function finalStep(turn: AgyTurn): AgyStep | undefined {
  // Never select an earlier assistant message when a later tool call or error
  // ended the turn. System metadata may follow the final model response.
  const last = [...turn.steps].reverse().find((s) => s.source === "MODEL" || s.status === "ERROR");
  return last?.type === "PLANNER_RESPONSE" && last.status === "DONE" && !last.hasCalls && last.content?.trim() ? last : undefined;
}

export function normalizeAgyTurn(turn: AgyTurn, id: string, project: string, stream: string,
  outcome: BarbaroTurnV1["outcome"], cwd: string): BarbaroTurnV1 | undefined {
  const final = finalStep(turn);
  if (!final && outcome === "success") return undefined;
  const last = final ?? turn.steps.at(-1) ?? turn.input;
  const turnId = agyTurnId(id, turn.input.index);
  const actions: BarbaroAction[] = [];
  const subagents = new Map<string, number>();
  for (const [position, step] of turn.steps.entries()) {
    if (step.type !== "PLANNER_RESPONSE" || step.source !== "MODEL") continue;
    const results = turn.steps.slice(position + 1, position + 1 + step.callCount);
    // A complete contiguous native result batch lets us pair call N with
    // result N. Incomplete/interleaved batches still report the attempted tool.
    const paired = results.length === step.callCount && step.calls.length === step.callCount &&
      results.every((row, n) => row.index === step.index + n + 1 && row.type === "GENERIC" && row.source === "MODEL");
    for (const [n, call] of step.calls.entries()) {
      const result = paired ? results[n] : undefined;
      const exit = call.name === "run_command" && result?.status === "DONE"
        ? /^(?:Created At: [0-9TZ.:+-]+\nCompleted At: [0-9TZ.:+-]+\n){1,2}Command exited with code (-?\d+)\./u.exec(result.content ?? "")?.[1]
        : undefined;
      const exitCode = exit !== undefined && Number.isSafeInteger(Number(exit)) ? Number(exit) : undefined;
      let actionOutcome: BarbaroActionOutcome = "unknown";
      if (result?.status === "ERROR" || (exitCode !== undefined && exitCode !== 0)) actionOutcome = "failed";
      else if (result?.status === "DONE" && (call.name !== "run_command" || exitCode === 0)) actionOutcome = "success";
      const base = { action_id: createActionId(turnId, String(step.index), n), outcome: actionOutcome,
        source_refs: [sourceRef(id, step, result ?? step)] };
      const path = editPath(call, project, cwd);
      if (path) {
        if (!isGeneratedBarbaroPath(path)) {
          const operation = ["edit_file", "replace_file_content", "multi_replace_file_content"].includes(call.name) ? "modify" as const : "unknown" as const;
          actions.push({ ...base, kind: "file_change", operation, path });
        }
      } else if (call.name === "run_command" && typeof call.args.CommandLine === "string") {
        if (!isDigestExcludedBarbaroCommand(call.args.CommandLine))
          actions.push({ ...base, kind: "command", command: safeText(call.args.CommandLine, 8192),
            ...(exitCode === undefined ? {} : { exit_code: exitCode }) });
      } else {
        actions.push({ ...base, kind: "tool", tool_name: call.name });
        if (call.name === "invoke_subagent" && actionOutcome === "success") {
          const role = typeof call.args.Role === "string" && /^[\w.-]{1,80}$/u.test(call.args.Role) ? call.args.Role : "unknown";
          subagents.set(role, (subagents.get(role) ?? 0) + 1);
        }
      }
    }
  }
  return { schema: "barbaro.turn.v1", provider: "agy", agent_id: "main", session_id: createSessionId("agy", id),
    workstream_id: stream, turn_id: turnId, sequence: turn.sequence, started_at: turn.input.time,
    ended_at: last.time, outcome, request: safeText(turn.prompt, 1024 * 1024),
    ...(final?.content ? { response: safeText(final.content, 1024 * 1024) } : {}), actions,
    subagents: { total: [...subagents.values()].reduce((total, n) => total + n, 0),
      by_role: [...subagents].map(([role, count]) => ({ role, count })), outcomes: {}, changed_paths: [], evidence_refs: [] },
    evidence_refs: [], source_refs: [sourceRef(id, turn.input, last)] };
}
