import { normalizeRepoPath } from "../core/content.js";
import { compareUtf16CodeUnits, stableStringify } from "../core/stable-json.js";
import type { ActiveLeaseV1 } from "./types.js";

/** Advisory project-relative claim. Null path explicitly means unknown scope. */
export interface ProjectWriteClaim {
  readonly lease_id: string;
  readonly provider: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly workstream_id: string | null;
  readonly path: string | null;
  readonly confidence: "exact" | "inferred" | "unknown";
  readonly unknown_write_scope: boolean;
  readonly expires_at: string;
}

export interface ProjectClaimOverlap {
  readonly local: ProjectWriteClaim;
  readonly foreign: ProjectWriteClaim;
  readonly confidence: "exact" | "inferred";
  readonly advisory: true;
}

/** Same lexical POSIX normalization used by the hooks, without filesystem IO. */
export function claimPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function projectWriteClaims(
  projectRoot: string,
  leases: readonly ActiveLeaseV1[],
  now: Date,
): ProjectWriteClaim[] {
  const claims: ProjectWriteClaim[] = [];
  for (const lease of leases) {
    if (lease.state === "idle" || Date.parse(lease.expires_at) <= now.getTime()) continue;
    const paths = new Map<string, "exact" | "inferred">();
    let unknown = lease.unknown_write_scope;
    for (const claim of lease.claims) {
      const path = normalizeRepoPath(projectRoot, claim.path);
      if (path === undefined) { unknown = true; continue; }
      // Duplicate claims never inflate overlap counts; keep weaker confidence.
      paths.set(path, paths.get(path) === "inferred" ? "inferred" : claim.confidence);
    }
    const owner = {
      lease_id: lease.lease_id,
      provider: lease.provider,
      session_id: lease.session_id,
      agent_id: lease.agent_id,
      workstream_id: lease.workstream_id ?? null,
      unknown_write_scope: unknown,
      expires_at: lease.expires_at,
    };
    for (const [path, confidence] of paths) claims.push({ ...owner, path, confidence });
    if (unknown && paths.size === 0) claims.push({ ...owner, path: null, confidence: "unknown" });
  }
  return claims.sort((a, b) => compareUtf16CodeUnits(claimIdentity(a), claimIdentity(b)));
}

function claimIdentity(claim: ProjectWriteClaim): string {
  return stableStringify([claim.workstream_id, claim.provider, claim.session_id, claim.agent_id, claim.path]);
}

/** Renewal, tool activity and expiry extensions are not material changes. */
export function claimOverlapIdentity(overlap: ProjectClaimOverlap): string {
  return stableStringify([overlap.local, overlap.foreign].map(({ expires_at: _expiry, ...claim }) => claim));
}

/** Only cross-workstream known paths overlap; unknown scope is never a collision. */
export function projectClaimOverlaps(
  claims: readonly ProjectWriteClaim[],
  workstreamId?: string,
): ProjectClaimOverlap[] {
  const overlaps: ProjectClaimOverlap[] = [];
  for (let i = 0; i < claims.length; i += 1) {
    const left = claims[i]!;
    if (left.path === null) continue;
    for (let j = i + 1; j < claims.length; j += 1) {
      const right = claims[j]!;
      if (right.path === null || left.workstream_id === right.workstream_id) continue;
      if (left.provider === right.provider && left.session_id === right.session_id) continue;
      if (workstreamId !== undefined && left.workstream_id !== workstreamId && right.workstream_id !== workstreamId) continue;
      if (!claimPathsOverlap(left.path, right.path)) continue;
      const [local, foreign] = workstreamId === right.workstream_id ? [right, left] : [left, right];
      overlaps.push({
        local, foreign, advisory: true,
        confidence: left.confidence === "exact" && right.confidence === "exact" && left.path === right.path ? "exact" : "inferred",
      });
    }
  }
  return overlaps;
}
