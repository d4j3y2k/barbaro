import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ActiveLeaseStore, deriveLeaseId, idleLeaseUpdate } from "../active/index.js";
import type { BarbaroTurnV1 } from "../contracts/v1.js";
import { classifyAwaitCommand, isDigestExcludedBarbaroCommand } from "../core/barbaro-command.js";
import { isGeneratedBarbaroPath } from "../core/content.js";
import { createSessionId } from "../core/id.js";
import { readContextGuidance } from "../nudge/read-guidance.js";
import { claimHookNudgeDelivery } from "../nudge/delivery.js";
import { commitHookReadOutput, discardHookRead, stageHookReadOutput } from "../nudge/read-commit.js";
import { reserveHookRead, type HookReadOptions } from "../nudge/read-invocation.js";
import { appendUniqueJsonl } from "../output/jsonl-store.js";
import { agyProjectRoot } from "../providers/agy/project-root.js";
import { WorkstreamStore } from "../workstreams/store.js";
import { activeTools, toolActivity } from "../providers/agy/active-tools.js";
import { agyTurnId, editPath, finalStep, fullTracePath, nativeCall, normalizeAgyTurn, object, readAgyTurns, safeText, type AgyCall, type AgyTurn } from "../providers/agy/transcript.js";
import { observeHookRead } from "./read-observation.js";
import { admitHookSession, parseBarbaroInvocation, participationMemberships, SessionParticipationStore } from "./participation.js";

const provider = "agy";
const agent_id = "main";
const pass = (event: string) => event === "PreToolUse" ? { decision: "allow" } : {};
const inject = (messages: string[]) => messages.length ? {
  injectSteps: [{ systemMessage: { systemMessage: messages.join("\n") } }],
} : {};

async function projectFor(input: Record<string, unknown>): Promise<{ projectRoot: string; cwd: string } | undefined> {
  if (!Array.isArray(input.workspacePaths) || !input.workspacePaths.length ||
      typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return undefined;
  const cwd = await realpath(input.cwd);
  const workspacePaths = input.workspacePaths;
  const roots: string[] = [];
  for (const p of workspacePaths) {
    if (typeof p !== "string" || !isAbsolute(p)) return undefined;
    const root = await realpath(p);
    const child = relative(root, cwd);
    if (child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))) roots.push(root);
  }
  const workspace = roots.sort((a, b) => b.length - a.length)[0];
  if (!workspace) return undefined;
  return { projectRoot: await agyProjectRoot(workspace), cwd };
}

function readActor(projectRoot: string, nativeSessionId: string, turnId: string, cwd: string, stepIdx: number, call?: AgyCall) {
  const toolCwd = typeof call?.args.Cwd === "string" ? call.args.Cwd : cwd;
  return { projectRoot, provider, nativeSessionId, workingDirectory: toolCwd,
    turn: { kind: "agy" as const, turn_id: turnId }, toolName: "Bash", toolUseId: String(stepIdx),
    toolInput: { command: call?.args.CommandLine } } as const;
}

async function reserveAgyRead(actor: HookReadOptions): Promise<boolean> {
  const result = await reserveHookRead(actor);
  if (result.reserved) await observeHookRead(actor, "reserved", "reserved");
  else if (result.reason !== "unrecognized") await observeHookRead(actor, "refused", "reservation_refused");
  return result.reserved;
}

/** 1.5.18 writes the command result after PostToolUse. Only a following
 * PreInvocation proves the model has received this foreground tool step.
 * A batched call, async handle, clipped result or malformed envelope cannot ack. */
async function reconcileRead(projectRoot: string, id: string, turnId: string, cwd: string, turn: AgyTurn, readStep: number) {
  const called = turn.steps.find((step) => step.index === readStep - 1);
  const result = turn.steps.find((step) => step.index === readStep);
  const call = called?.calls[0];
  const actor = readActor(projectRoot, id, turnId, cwd, readStep, call);
  if (!called || called.type !== "PLANNER_RESPONSE" || called.source !== "MODEL" || called.status !== "DONE" ||
      called.callCount !== 1 || call?.name !== "run_command" ||
      result?.source !== "MODEL" || result.type !== "GENERIC" || result.status !== "DONE" || !result.content) {
    await observeHookRead(actor, "refused", "unsupported_producer_or_shape");
    return;
  }
  const envelope = /^(?:Created At: [0-9TZ.:+-]+\nCompleted At: [0-9TZ.:+-]+\n){1,2}Command exited with code 0\.\n\nCommand output:\n([^\r\n]+)\r?\n$/u.exec(result.content)?.[1];
  if (envelope === undefined || Buffer.byteLength(envelope) + 1 > 8192 || !await stageHookReadOutput(actor, envelope)) {
    await observeHookRead(actor, "refused", "output_not_eligible");
  } else {
    await observeHookRead(actor, "staged", "candidate_staged");
    const result = await commitHookReadOutput(actor, envelope);
    if (result.committed) {
      await observeHookRead(actor, "committed", "model_delivery_verified");
      return;
    }
    await observeHookRead(actor, "refused", "commit_not_verified");
  }
  await discardHookRead(actor);
}

async function publish(project: string, id: string, stream: string, turn: AgyTurn, outcome: BarbaroTurnV1["outcome"], cwd: string) {
  const record = normalizeAgyTurn(turn, id, project, stream, outcome, cwd);
  if (!record) return false;
  const result = await appendUniqueJsonl(join(project, ".barbaro", "feed", provider, record.session_id + ".jsonl"),
    [record], (row) => row.turn_id);
  if (result.conflicted) throw new Error("Antigravity native turn differs from its published digest");
  return true;
}

function stopOutcome(input: Record<string, unknown>): BarbaroTurnV1["outcome"] | undefined {
  if (input.fullyIdle !== true || input.continuationActive === true) return undefined;
  const reason = typeof input.terminationReason === "string" ? input.terminationReason.toUpperCase() : "";
  if (/CANCEL|INTERRUPT/u.test(reason)) return "cancelled";
  if (input.error || /ERROR|FAIL/u.test(reason)) return "failed";
  if (/MAX_STEP|LIMIT/u.test(reason)) return "partial";
  return ["NO_TOOL_CALL", "MODEL_STOP"].includes(reason) ? "success" : undefined;
}

/** Global hook. Only an explicit user submission may enroll a conversation. */
export async function handleAgyHook(event: string, value: unknown, options: { brainRoot?: string } = {}): Promise<object> {
  const fallback = pass(event);
  if (!["PreInvocation", "PreToolUse", "PostToolUse", "Stop"].includes(event) || !object(value) ||
      (value.hookEventName !== undefined && event !== value.hookEventName) ||
      typeof value.conversationId !== "string" || typeof value.lastUserInput !== "string") return fallback;
  const id = value.conversationId;
  const project = await projectFor(value);
  if (!project) return fallback;
  const { projectRoot, cwd } = project;
  const first = event === "PreInvocation" && value.invocationNum === 0;
  const invocation = first ? parseBarbaroInvocation(value.lastUserInput) : undefined;
  const explicit = invocation !== undefined;
  const membership = await new SessionParticipationStore(projectRoot).read(provider, id);
  if (!membership && !explicit) return fallback;
  const path = await fullTracePath(id, value.transcriptPath, options.brainRoot);
  if (!path) return fallback;
  const session_id = createSessionId(provider, id);
  const actor = { provider, agent_id, session_id, lease_id: deriveLeaseId(provider, id, agent_id) } as const;
  const leases = new ActiveLeaseStore(join(projectRoot, ".barbaro", "active"));
  const snapshot = await leases.readSnapshot(actor);
  const oldStep = snapshot?.extensions?.agy?.input_step;
  const read = () => readAgyTurns(path, typeof oldStep === "number" ? oldStep : undefined);
  let turns = await read();
  const outcome = event === "Stop" ? stopOutcome(value) : undefined;
  if (event === "Stop" && !outcome) return fallback;
  if (outcome === "success" && turns.current && !finalStep(turns.current)) {
    // Native teardown may call Stop while the writer is flushing its last row.
    for (const ms of [40, 90, 180, 360]) {
      await delay(ms);
      turns = await read();
      if (turns.current && finalStep(turns.current)) break;
    }
  }
  const current = turns.current;
  if (!current || current.prompt !== value.lastUserInput) return fallback;
  const index = current.input.index;
  const turnId = agyTurnId(id, index);
  if (typeof oldStep === "number" && oldStep > index) return fallback;
  const already = snapshot?.turn_id === turnId;
  if ((event !== "PreInvocation" && !already) || (already && snapshot.state === "idle")) return fallback;
  if (!already && membership) {
    const epoch = participationMemberships(membership).at(-1);
    const epochSecond = Math.floor(Date.parse(epoch?.from ?? membership.joined_at) / 1000);
    const inputSecond = Math.floor(Date.parse(current.input.time) / 1000);
    if (inputSecond < epochSecond) return fallback;
    // An idle lease can be reaped. With only whole-second native timestamps
    // a rewound, unbound prompt in the enrollment second is ambiguous. The
    // only recoverable retry is an explicit enrollment in that same stream.
    if (!snapshot && inputSecond === epochSecond) {
      if (!epoch || !invocation || invocation.kind === "bare") return fallback;
      const room = await new WorkstreamStore(projectRoot).get(epoch.workstream_id);
      if (room?.name !== invocation.name) return fallback;
    }
  }
  // PreInvocation also carries initialNumSteps, which bounds this invocation
  // when an old hook is replayed after an identical subsequent prompt.
  if (event === "PreInvocation" && (!Number.isSafeInteger(value.initialNumSteps) || Number(value.initialNumSteps) <= index)) return fallback;
  const admission = explicit && !already ? await admitHookSession({ projectRoot, provider, nativeSessionId: id,
    event: "UserPromptSubmit", prompt: current.prompt, now: new Date(current.input.time) }) : undefined;
  const messages: string[] = [];
  if (admission?.message) messages.push(admission.message);
  const stream = already ? snapshot.workstream_id : (admission?.participation ?? membership)?.workstream_id;
  if (!stream) return event === "PreInvocation" ? inject(messages) : fallback;
  // Restored sessions may no longer have their enrollment primer in context.
  if (first && !already && (!admission?.message || !admission.message.includes("barbaro read context")))
    messages.push("Barbaro workstream " + stream + ". To read completed peer turns, " +
      readContextGuidance(provider, session_id, stream, projectRoot) + ".");
  const prior = turns.admitted;
  const tool = nativeCall(value.toolCall);
  const step = value.stepIdx;
  if ((event === "PreToolUse" || event === "PostToolUse") &&
      (!tool || typeof step !== "number" || !Number.isSafeInteger(step) || step <= index)) return fallback;
  const identity = { ...actor, workstream_id: stream, turn_id: turnId };
  const command = tool?.name === "run_command" && typeof tool.args.CommandLine === "string" ? tool.args.CommandLine : undefined;
  const waiting = command !== undefined ? classifyAwaitCommand(command) : undefined;
  await leases.update(actor, async (previous) => {
    const marker = previous?.extensions?.agy;
    if (typeof marker?.input_step === "number" && marker.input_step > index ||
        previous?.turn_id === turnId && previous.state === "idle") return { ignore: "stale event" };
    if (prior && prior.input.index !== index && previous?.turn_id === agyTurnId(id, prior.input.index) &&
        previous.state !== "idle" && previous.workstream_id && finalStep(prior))
      await publish(projectRoot, id, previous.workstream_id, prior, "success", typeof marker?.cwd === "string" ? marker.cwd : cwd);
    const originalCwd = previous?.turn_id === turnId && typeof marker?.cwd === "string" ? marker.cwd : cwd;
    const extensions = { agy: { input_step: index, cwd: originalCwd } };
    const base = { ...identity, extensions, intent: safeText(current.prompt, 512),
      state: "working" as const, claims: [], unknown_write_scope: false };
    if (event === "PreInvocation") {
      if (previous?.turn_id === turnId && typeof marker?.read_step === "number")
        await reconcileRead(projectRoot, id, turnId, cwd, current, marker.read_step);
      const nudge = await claimHookNudgeDelivery({ projectRoot, provider, nativeSessionId: id, workingDirectory: cwd,
        marker: first ? "user_prompt" : "tool_boundary", turn: { kind: "agy", turn_id: turnId } });
      if (nudge) messages.push(nudge.text);
      return { write: base };
    }
    if (previous?.turn_id !== turnId || previous.workstream_id !== stream) return { ignore: "unadmitted turn" };
    if (event === "Stop") {
      if (!outcome || !await publish(projectRoot, id, stream, current, outcome, originalCwd)) return { ignore: "incomplete transcript" };
      return { write: idleLeaseUpdate({ ...identity, extensions }) };
    }
    if (!tool || typeof step !== "number") return { ignore: "missing tool" };
    const pending = activeTools(marker?.tools);
    const found = pending.find((entry) => entry.step === step);
    if (event === "PostToolUse") {
      if (!found || found.name !== tool.name) return { ignore: "unmatched tool" };
      const remaining = pending.filter((entry) => entry.step !== step);
      const next = { ...extensions.agy, tools: remaining };
      if (found.reserved) {
        if (value.error == null || value.error === "")
          return { write: { ...base, ...toolActivity(remaining), extensions: { agy: { ...next, read_step: step } } } };
        const actor = readActor(projectRoot, id, turnId, cwd, step, tool);
        await discardHookRead(actor);
        await observeHookRead(actor, "refused", "command_failed");
      }
      return { write: { ...base, ...toolActivity(remaining), extensions: { agy: next } } };
    }
    if (found || current.steps.some((row) => row.index === step && row.type === "GENERIC" && row.status === "DONE"))
      return { ignore: "replayed tool" };
    const path = editPath(tool, projectRoot, cwd);
    const claim = path && !isGeneratedBarbaroPath(path) ? path : undefined;
    const planner = current.steps.find((row) => row.index === step - 1 && row.type === "PLANNER_RESPONSE");
    const reserved = command && planner?.callCount === 1 && planner.calls[0]?.name === tool.name &&
      planner.calls[0]?.args.CommandLine === command &&
      isAbsolute(typeof tool.args.Cwd === "string" ? tool.args.Cwd : cwd) &&
      await reserveAgyRead(readActor(projectRoot, id, turnId, cwd, step, tool));
    const unknown = command ? !isDigestExcludedBarbaroCommand(command)
      : !["view_file", "list_dir", "grep_search", "find_by_name", "read_file", "search_web", "ask_question"].includes(tool.name);
    const next = [...pending, { step, name: tool.name, ...(claim ? { path: claim } : {}),
      waiting: Boolean(waiting || tool.name === "ask_question"), unknown: !path && unknown, reserved: Boolean(reserved) }];
    return { write: { ...base, ...toolActivity(next, command ? safeText(command, 512) : undefined),
      extensions: { agy: { ...extensions.agy, tools: next } } } };
  }, waiting ? { ttlMs: waiting.leaseTtlMs } : {});
  return event === "PreInvocation" ? inject(messages) : fallback;
}
