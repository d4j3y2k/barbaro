import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { BarbaroContent, BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { createSessionId, createTurnId } from "../../src/core/id.js";
import {
  SessionParticipationStore,
  type ParticipatingProvider,
} from "../../src/hooks/participation.js";

function content(text: string): BarbaroContent {
  return {
    text,
    fidelity: "verbatim",
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

export async function currentWorkstreamId(
  projectRoot: string,
  provider: ParticipatingProvider,
  nativeSessionId: string,
): Promise<string> {
  const participation = await new SessionParticipationStore(projectRoot).read(
    provider,
    nativeSessionId,
  );
  if (participation?.workstream_id === undefined) {
    throw new Error("test session has no current workstream");
  }
  return participation.workstream_id;
}

export async function appendPeerTurn(options: {
  readonly projectRoot: string;
  readonly workstreamId: string;
  readonly sequence: number;
  readonly response: string;
  readonly provider?: ParticipatingProvider;
  readonly nativeSessionId?: string;
  readonly endedAt?: string;
}): Promise<BarbaroTurnV1> {
  const provider = options.provider ?? "claude";
  const nativeSessionId = options.nativeSessionId ?? "nudge-peer";
  const sessionId = createSessionId(provider, nativeSessionId);
  const endedAt = options.endedAt ??
    `2099-08-23T10:00:${options.sequence.toString().padStart(2, "0")}.000Z`;
  const turn: BarbaroTurnV1 = {
    schema: "barbaro.turn.v1",
    turn_id: createTurnId(
      provider,
      nativeSessionId,
      "main",
      `peer-turn-${options.sequence}`,
    ),
    provider,
    session_id: sessionId,
    workstream_id: options.workstreamId,
    sequence: options.sequence,
    agent_id: "main",
    started_at: "2099-08-23T10:00:00.000Z",
    ended_at: endedAt,
    outcome: "success",
    request: content(`peer request ${options.sequence}`),
    response: content(options.response),
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [],
  };
  const path = join(
    options.projectRoot,
    ".barbaro",
    "feed",
    provider,
    `${sessionId}.jsonl`,
  );
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(turn)}\n`, "utf8");
  return turn;
}
