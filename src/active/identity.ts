import { createHash } from "node:crypto";

import type { ActiveActorKey } from "./types.js";

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function framedHash(domain: string, parts: readonly string[]): Buffer {
  const framedParts = parts.map((part) => `${utf8Length(part)}:${part}`);
  const input = [domain, ...framedParts].join("\0");
  return createHash("sha256").update(input, "utf8").digest();
}

/** Implements the typed-hash framing from the Barbaro v1 identity contract. */
export function deriveLeaseId(
  provider: string,
  nativeSessionId: string,
  agentId: string,
): string {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new TypeError(`Invalid provider: ${JSON.stringify(provider)}`);
  }
  if (nativeSessionId.length === 0) {
    throw new TypeError("nativeSessionId must not be empty");
  }
  if (agentId.length === 0) {
    throw new TypeError("agentId must not be empty");
  }

  const digest = framedHash("barbaro-id-v1\0lease", [
    provider,
    nativeSessionId,
    agentId,
  ]);
  return `lease_${digest.subarray(0, 16).toString("hex")}`;
}

/**
 * Returns a filesystem-safe, opaque actor filename. Raw actor and session IDs
 * never become path components, and actors named `main` in different sessions
 * cannot collide.
 */
export function activeActorFilename(actor: ActiveActorKey): string {
  if (!PROVIDER_PATTERN.test(actor.provider)) {
    throw new TypeError(`Invalid provider: ${JSON.stringify(actor.provider)}`);
  }
  if (!SESSION_ID_PATTERN.test(actor.session_id)) {
    throw new TypeError(`Invalid session_id: ${JSON.stringify(actor.session_id)}`);
  }
  if (actor.agent_id.length === 0) {
    throw new TypeError("agent_id must not be empty");
  }

  const digest = framedHash("barbaro-active-actor-file-v1", [
    actor.provider,
    actor.session_id,
    actor.agent_id,
  ]).toString("hex");

  return `actor_${digest}.json`;
}

export const ACTIVE_ACTOR_FILENAME_PATTERN = /^actor_[0-9a-f]{64}\.json$/;
