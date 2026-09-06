import { stat } from "node:fs/promises";
import { join } from "node:path";

import { ActiveLeaseStore } from "../active/store.js";
import { projectWriteClaims, projectClaimOverlaps, claimOverlapIdentity } from "../active/conflicts.js";
import type { ActiveLeaseV1 } from "../active/types.js";
import type { BarbaroTurnV1 } from "../contracts/v1.js";
import { iterateJsonlForward } from "../core/jsonl-reader.js";
import { listIncidents } from "../hooks/incidents.js";
import {
  participationMemberships,
  SessionParticipationStore,
} from "../hooks/participation.js";
import { projectTurn } from "../reader/projection.js";
import {
  isTurnV1,
  listFeedFiles,
  type BarbaroFeedFile,
} from "../reader/store.js";

import {
  DEFAULT_WATCH_TURN_BYTE_BUDGET,
  WATCH_EVENT_SCHEMA,
  WATCH_MAX_CONSECUTIVE_ERRORS,
  WATCH_WAKE_MARKER,
  type WatchArmedEvent,
  type WatchErrorEvent,
  type WatchEvent,
  type WatchStaleEvent,
  type WatchTurnEvent,
} from "./types.js";

const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;
const WORKSTREAM_ID_PATTERN = /^ws_[0-9a-f]{32}$/;

/**
 * Ceiling for retrying a turn whose minimum projection exceeds the normal
 * per-event budget; a turn that cannot fit even here is left to the error
 * path rather than silently dropped.
 */
const FALLBACK_TURN_BYTE_BUDGET = 64 * 1024;

export interface WatchEngineOptions {
  readonly projectRoot: string;
  /** Stable session id whose own publications are never events. */
  readonly selfSessionId?: string;
  /**
   * Scope to one workstream: turn, join, and stale events are delivered only
   * for sessions stamped with this id, and incidents only when they name
   * this workstream or none. Unset means project-wide, as before.
   */
  readonly workstreamId?: string;
  /** Injectable wall clock, primarily for deterministic tests. */
  readonly clock?: () => Date;
  /** Byte budget for each turn event's bounded projection. */
  readonly turnByteBudget?: number;
}

/**
 * A wake-up notification republished as a turn carries the arming Monitor's
 * description in its request text. Such a turn exists only because a watcher
 * fired, so no watcher may emit it: watcher A waking on watcher B's wake
 * response — and B then waking on A's — would otherwise ping-pong forever.
 */
export function isWatchWakeRequest(requestText: string): boolean {
  return (
    requestText.includes("<task-notification>") &&
    requestText.includes(WATCH_WAKE_MARKER)
  );
}

/**
 * Answering a wake-up publishes a turn of its own, stamped
 * `task-notification` by the provider because no human asked for it.
 * Self-exclusion stops a session echoing itself, not a pair echoing each
 * other, so the provenance stamp is what breaks the loop: a machine-driven
 * turn is the echo, never the news, while `structural` and `origin` are
 * human and always reported — even one that quotes the wake marker. A turn
 * with no stamp at all (Codex writes none) falls back to the marker its
 * request text would carry, so an unstamped watcher response still cannot
 * restart the loop, while an unstamped human turn is emitted rather than
 * dropped.
 */
export function isEchoTurn(turn: BarbaroTurnV1): boolean {
  const method = turnStartMethod(turn);
  if (method !== undefined) return method === "task-notification";
  return isWatchWakeRequest(turn.request.text);
}

function turnStartMethod(turn: BarbaroTurnV1): string | undefined {
  const turnStart = turn.extensions?.["claude"]?.["turn_start"];
  if (
    turnStart === null ||
    typeof turnStart !== "object" ||
    Array.isArray(turnStart)
  ) {
    return undefined;
  }
  const method = (turnStart as Record<string, unknown>)["method"];
  return typeof method === "string" ? method : undefined;
}

export function watchErrorEvent(
  error: unknown,
  consecutive: number,
  now: Date = new Date(),
): WatchErrorEvent {
  return {
    schema: WATCH_EVENT_SCHEMA,
    kind: "error",
    observed_at: now.toISOString(),
    message: error instanceof Error ? error.message : String(error),
    consecutive,
    limit: WATCH_MAX_CONSECUTIVE_ERRORS,
  };
}

/**
 * Incremental scanner over the derived Barbaro store. `prime()` swallows all
 * existing history as the baseline; each `poll()` then returns only what
 * changed, reading feed files from a byte cursor so cost tracks new bytes
 * rather than project history. Routine `active/` renewal is never an
 * event: a peer publishes a lease revision per tool call, and what earns an
 * interrupt is a completed turn, a join, a fresh incident, or a lease that
 * lapses while still holding work, or a changed cross-workstream path overlap.
 *
 * Every read goes through the supported stores — the lease store, the
 * participation store, the incident list, and the boundary-verified feed
 * listing — rather than raw directory scans with hand-rolled filtering.
 */
export class WatchEngine {
  readonly #projectRoot: string;
  readonly #self: string | undefined;
  readonly #workstream: string | undefined;
  readonly #clock: () => Date;
  readonly #turnByteBudget: number;
  readonly #activeStore: ActiveLeaseStore;
  readonly #participationStore: SessionParticipationStore;

  /** Path → first unread byte, always at the start of a physical line. */
  readonly #feedCursors = new Map<string, number>();
  readonly #seenIncidents = new Set<string>();
  /** provider/session/current-workstream tuples already observed. */
  readonly #knownSessions = new Set<string>();
  /** provider/session → its workstream, or undefined for an unscoped session. */
  readonly #sessionWorkstream = new Map<string, string | undefined>();
  readonly #leases = new Map<
    string,
    { readonly updatedAt: string; readonly reported: boolean }
  >();
  #primed = false;
  #conflicts = new Set<string>();

  constructor(options: WatchEngineOptions) {
    if (options.projectRoot.length === 0) {
      throw new TypeError("projectRoot must not be empty");
    }
    if (
      options.selfSessionId !== undefined &&
      !SESSION_ID_PATTERN.test(options.selfSessionId)
    ) {
      throw new TypeError(
        `Invalid selfSessionId: ${JSON.stringify(options.selfSessionId)}`,
      );
    }
    if (
      options.workstreamId !== undefined &&
      !WORKSTREAM_ID_PATTERN.test(options.workstreamId)
    ) {
      throw new TypeError(
        `Invalid workstreamId: ${JSON.stringify(options.workstreamId)}`,
      );
    }
    this.#projectRoot = options.projectRoot;
    this.#self = options.selfSessionId;
    this.#workstream = options.workstreamId;
    this.#clock = options.clock ?? (() => new Date());
    this.#turnByteBudget =
      options.turnByteBudget ?? DEFAULT_WATCH_TURN_BYTE_BUDGET;
    this.#activeStore = new ActiveLeaseStore(
      join(options.projectRoot, ".barbaro", "active"),
    );
    this.#participationStore = new SessionParticipationStore(
      options.projectRoot,
    );
  }

  /** Baseline scan: existing history becomes known, not news. */
  async prime(): Promise<WatchArmedEvent> {
    const now = this.#clock();
    await this.#scanJoins(undefined);
    await this.#scanFeeds(undefined);
    await this.#scanIncidents(undefined);
    await this.#scanLeases(undefined, now);
    this.#primed = true;

    const live = new Set<string>();
    for (const lease of await this.#activeStore.listActive({ now })) {
      if (lease.session_id === this.#self) continue;
      if (!this.#inScope(lease.workstream_id)) continue;
      live.add(lease.session_id);
    }
    let enrolled = 0;
    for (const [key, workstream] of this.#sessionWorkstream) {
      if (key.endsWith(`/${this.#self}`)) continue;
      if (!this.#inScope(workstream)) continue;
      enrolled += 1;
    }
    return {
      schema: WATCH_EVENT_SCHEMA,
      kind: "armed",
      observed_at: now.toISOString(),
      live_sessions: live.size,
      enrolled_sessions: enrolled,
      ...(this.#self === undefined ? {} : { self_session_id: this.#self }),
      ...(this.#workstream === undefined
        ? {}
        : { workstream_id: this.#workstream }),
    };
  }

  /**
   * An unscoped watcher sees the whole project. A scoped one sees its own
   * workstream only; records without a stamp (pre-workstream sessions) are
   * outside every scope.
   */
  #inScope(workstreamId: string | undefined): boolean {
    return this.#workstream === undefined || workstreamId === this.#workstream;
  }

  /** One tick: everything that became true since the previous scan. */
  async poll(): Promise<WatchEvent[]> {
    if (!this.#primed) {
      throw new Error("WatchEngine.poll() requires a prior prime()");
    }
    const now = this.#clock();
    const events: WatchEvent[] = [];
    await this.#scanJoins(events);
    await this.#scanFeeds(events);
    await this.#scanIncidents(events);
    await this.#scanLeases(events, now);
    return events;
  }

  async #scanJoins(sink: WatchEvent[] | undefined): Promise<void> {
    for (const participation of await this.#participationStore.list()) {
      const sessionKey = `${participation.provider}/${participation.session_id}`;
      const key = `${sessionKey}/${participation.workstream_id ?? "unscoped"}`;
      this.#sessionWorkstream.set(sessionKey, participation.workstream_id);
      if (this.#knownSessions.has(key)) continue;
      this.#knownSessions.add(key);
      if (sink === undefined || participation.session_id === this.#self) {
        continue;
      }
      if (!this.#inScope(participation.workstream_id)) continue;
      sink.push({
        schema: WATCH_EVENT_SCHEMA,
        kind: "join",
        observed_at: this.#clock().toISOString(),
        provider: participation.provider,
        session_id: participation.session_id,
        ...(participation.workstream_id === undefined
          ? {}
          : { workstream_id: participation.workstream_id }),
        joined_at:
          participationMemberships(participation).at(-1)?.from ??
          participation.joined_at,
        initiated_by: participation.initiated_by,
      });
    }
  }

  async #scanFeeds(sink: WatchEvent[] | undefined): Promise<void> {
    const files = await listFeedFiles(this.#projectRoot);
    const seen = new Set<string>();
    for (const file of files) {
      if (file.sessionId === this.#self) continue;
      seen.add(file.path);
      const cursor = this.#feedCursors.get(file.path) ?? 0;
      try {
        const size = (await stat(file.path)).size;
        if (size < cursor) {
          // The file shrank beneath the cursor: it was rebuilt, not appended
          // to. Replaying the rebuilt history would flood the consumer with
          // turns it already saw, so re-baseline silently instead.
          this.#feedCursors.set(
            file.path,
            await this.#consumeFeed(file, 0, undefined),
          );
          continue;
        }
        this.#feedCursors.set(
          file.path,
          await this.#consumeFeed(file, cursor, sink),
        );
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) continue;
        throw error;
      }
    }
    for (const path of this.#feedCursors.keys()) {
      if (!seen.has(path)) this.#feedCursors.delete(path);
    }
  }

  /**
   * Consume complete lines from a byte offset, returning the next cursor.
   * Events reach the sink only after the whole read succeeds, so a failed
   * read never advances the cursor past turns it half-delivered.
   */
  async #consumeFeed(
    file: BarbaroFeedFile,
    startOffset: number,
    sink: WatchEvent[] | undefined,
  ): Promise<number> {
    const pending: WatchTurnEvent[] = [];
    const iterator = iterateJsonlForward<unknown>(file.path, { startOffset });
    while (true) {
      const result = await iterator.next();
      if (result.done) {
        if (sink !== undefined) sink.push(...pending);
        return result.value.checkpointOffset;
      }
      const line = result.value;
      if (line.kind !== "record") continue;
      const value = line.value;
      if (!isTurnV1(value)) continue;
      if (
        value.provider !== file.provider ||
        value.session_id !== file.sessionId
      ) {
        continue;
      }
      if (sink === undefined) continue;
      if (isEchoTurn(value)) continue;
      if (!this.#inScope(value.workstream_id)) continue;
      pending.push(this.#turnEvent(value));
    }
  }

  #turnEvent(turn: BarbaroTurnV1): WatchTurnEvent {
    let projection;
    try {
      projection = projectTurn(turn, { byteBudget: this.#turnByteBudget });
    } catch (error) {
      // A turn whose omission metadata alone outgrows the normal budget (for
      // example a very wide subagent rollup) still deserves an event.
      if (!(error instanceof RangeError)) throw error;
      projection = projectTurn(turn, { byteBudget: FALLBACK_TURN_BYTE_BUDGET });
    }
    return {
      schema: WATCH_EVENT_SCHEMA,
      kind: "turn",
      observed_at: this.#clock().toISOString(),
      provider: turn.provider,
      session_id: turn.session_id,
      ...(turn.workstream_id === undefined
        ? {}
        : { workstream_id: turn.workstream_id }),
      turn: projection,
    };
  }

  async #scanIncidents(sink: WatchEvent[] | undefined): Promise<void> {
    for (const record of await listIncidents(this.#projectRoot)) {
      const key = `${record.incident.provider}/${record.incident_id}`;
      if (this.#seenIncidents.has(key)) continue;
      this.#seenIncidents.add(key);
      if (sink === undefined) continue;
      // A marker that names a workstream belongs to it; an unscoped marker
      // (a dormant session, a pre-workstream failure) is project news that
      // every watcher hears.
      const incidentWorkstream = record.incident.workstream_id;
      if (
        incidentWorkstream !== undefined &&
        !this.#inScope(incidentWorkstream)
      ) {
        continue;
      }
      // The filename is a per-condition dedup digest, so a new file is a
      // distinct condition rather than a repeat of one already reported.
      sink.push({
        schema: WATCH_EVENT_SCHEMA,
        kind: "incident",
        observed_at: this.#clock().toISOString(),
        provider: record.incident.provider,
        incident_id: record.incident_id,
        incident_kind: record.incident.kind,
        ...(record.incident.event === undefined
          ? {}
          : { event: record.incident.event }),
        ...(incidentWorkstream === undefined
          ? {}
          : { workstream_id: incidentWorkstream }),
        occurred_at: record.incident.occurred_at,
      });
    }
  }

  async #scanLeases(sink: WatchEvent[] | undefined, now: Date): Promise<void> {
    const nowMs = now.getTime();
    const snapshots = await this.#activeStore.listSnapshots();
    const conflicts = new Set<string>();
    for (const overlap of projectClaimOverlaps(projectWriteClaims(this.#projectRoot, snapshots, now), this.#workstream)) {
      const identity = claimOverlapIdentity(overlap);
      conflicts.add(identity);
      if (sink !== undefined && !this.#conflicts.has(identity)) {
        sink.push({ schema: WATCH_EVENT_SCHEMA, kind: "conflict", observed_at: now.toISOString(), overlap });
      }
    }
    // Deletions/expiry remove current conflicts silently. A later reappearance
    // is new information; timestamps and watcher read activity are not.
    this.#conflicts = conflicts;

    // Sessions whose main actor still holds an unexpired lease. A subagent
    // lease that stops being renewed under a live main has simply finished —
    // Codex subagents never write an idle tombstone, so their leases always
    // lapse mid-`working` — whereas one lapsing under a dead main went down
    // with its session.
    const presentSessions = new Set<string>();
    for (const lease of snapshots) {
      if (lease.agent_id !== "main") continue;
      const expiresMs = Date.parse(lease.expires_at);
      if (Number.isFinite(expiresMs) && expiresMs > nowMs) {
        presentSessions.add(lease.session_id);
      }
    }

    const seen = new Set<string>();
    for (const lease of snapshots) {
      if (lease.session_id === this.#self) continue;
      seen.add(lease.lease_id);
      const expiresMs = Date.parse(lease.expires_at);
      if (!Number.isFinite(expiresMs)) continue;

      const prior = this.#leases.get(lease.lease_id);
      const renewed = prior !== undefined && prior.updatedAt !== lease.updated_at;
      let reported = renewed ? false : (prior?.reported ?? false);

      if (!reported && nowMs > expiresMs) {
        // Only a lease watched from live to expired is news; one found
        // already expired is leftover from before the watcher armed. An idle
        // tombstone that stops renewing is a session saying goodbye — its
        // final turn already arrived as a TURN event. A lease that lapses
        // still holding work is the opposite: nothing has renewed the claim.
        const sessionGone = !presentSessions.has(lease.session_id);
        const worthTelling =
          lease.state !== "idle" &&
          (lease.agent_id === "main" || sessionGone);
        if (
          sink !== undefined &&
          prior !== undefined &&
          worthTelling &&
          this.#inScope(lease.workstream_id)
        ) {
          sink.push(this.#staleEvent(lease, nowMs - expiresMs, now));
        }
        reported = true;
      }
      this.#leases.set(lease.lease_id, {
        updatedAt: lease.updated_at,
        reported,
      });
    }
    for (const leaseId of this.#leases.keys()) {
      if (!seen.has(leaseId)) this.#leases.delete(leaseId);
    }
  }

  #staleEvent(
    lease: ActiveLeaseV1,
    lapsedMs: number,
    now: Date,
  ): WatchStaleEvent {
    if (lease.state === "idle") {
      throw new TypeError("Idle tombstones never lapse into stale events");
    }
    return {
      schema: WATCH_EVENT_SCHEMA,
      kind: "stale",
      observed_at: now.toISOString(),
      provider: lease.provider,
      session_id: lease.session_id,
      ...(lease.workstream_id === undefined
        ? {}
        : { workstream_id: lease.workstream_id }),
      agent_id: lease.agent_id,
      last_state: lease.state,
      updated_at: lease.updated_at,
      expires_at: lease.expires_at,
      lapsed_ms: lapsedMs,
      claims: lease.claims.length,
      unknown_write_scope: lease.unknown_write_scope,
      ...(lease.current_action === undefined
        ? {}
        : {
            current_action: {
              kind: lease.current_action.kind,
              ...(lease.current_action.tool_name === undefined
                ? {}
                : { tool_name: lease.current_action.tool_name }),
            },
          }),
    };
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
