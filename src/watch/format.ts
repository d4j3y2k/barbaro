import type { ReaderContentSummary } from "../reader/types.js";
import type {
  WatchArmedEvent,
  WatchEvent,
  WatchIncidentEvent,
  WatchJoinEvent,
  WatchStaleEvent,
  WatchTurnEvent,
} from "./types.js";

const EXCERPT_LIMIT = 160;
const CHANGED_PATHS_SHOWN = 4;

/** A session id is long; its first 12 characters identify it in a line. */
function short(id: string): string {
  return id.slice(0, 12);
}

/** ` ws=7a3f45e1` for a stamped record; nothing for an unscoped one. */
function scope(workstreamId: string | undefined): string {
  return workstreamId === undefined ? "" : ` ws=${workstreamId.slice(3, 11)}`;
}

function excerpt(text: string, limit: number = EXCERPT_LIMIT): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

/**
 * A turn can legitimately carry no text: a prompt that was nothing but
 * harness injection normalizes to empty while keeping its pre-strip byte
 * count. Rendering that as a blank line spends a wake-up on nothing, so say
 * which kind of empty it is.
 */
function describeContent(
  content: ReaderContentSummary | undefined,
  absent: string,
): string {
  if (content === undefined) return absent;
  const text = excerpt(content.text);
  if (text.length > 0) return text;
  const bytes = content.utf8_bytes.original;
  return bytes > 0 ? `(${bytes} bytes, no publishable text)` : absent;
}

function formatArmed(event: WatchArmedEvent): string {
  const self =
    event.self_session_id === undefined
      ? ""
      : ` self=${short(event.self_session_id)}`;
  return (
    `WATCH armed${self}${scope(event.workstream_id)} live=${event.live_sessions} ` +
    `enrolled=${event.enrolled_sessions} — turns, joins, incidents, stale leases`
  );
}

function formatTurn(event: WatchTurnEvent): string {
  const turn = event.turn.value;
  const head = [
    `TURN [${event.provider} ${short(event.session_id)}${scope(event.workstream_id)}] ` +
      `seq=${turn.sequence} ${turn.outcome}`,
  ];
  if (turn.subagents.total > 0) head.push(`subagents=${turn.subagents.total}`);

  // A path both sessions are editing is the one fact worth interrupting for,
  // so it rides in the headline rather than waiting for `barbaro context`.
  const changed = new Set<string>(turn.subagents.changed_paths.items);
  for (const action of turn.actions.items) {
    if (action.kind === "file_change" && action.path !== undefined) {
      changed.add(action.path);
    }
  }
  const hiddenPaths =
    turn.subagents.changed_paths.total - turn.subagents.changed_paths.shown;
  if (changed.size > 0 || hiddenPaths > 0) {
    const shown = [...changed].slice(0, CHANGED_PATHS_SHOWN);
    const extra = changed.size - shown.length + hiddenPaths;
    const suffix =
      extra > 0 ? `${shown.length > 0 ? "," : ""}+${extra}` : "";
    head.push(`changed=${shown.join(",")}${suffix}`);
  }

  // What it did survives even when what it said does not.
  const tools = new Map<string, number>();
  for (const action of turn.actions.items) {
    const name = action.tool_name ?? action.kind;
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  const hiddenActions = turn.actions.total - turn.actions.shown;
  if (tools.size > 0) {
    const tally = [...tools]
      .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
      .join(",");
    head.push(`did=${tally}${hiddenActions > 0 ? `,+${hiddenActions}` : ""}`);
  } else if (hiddenActions > 0) {
    head.push(`did=+${hiddenActions}`);
  }

  return [
    head.join(" "),
    `  req: ${describeContent(turn.request, "(none)")}`,
    `  say: ${describeContent(turn.response, "(no response recorded)")}`,
  ].join("\n");
}

function formatJoin(event: WatchJoinEvent): string {
  return (
    `JOIN [${event.provider} ${short(event.session_id)}${scope(event.workstream_id)}] ` +
    `at=${event.joined_at} via=${event.initiated_by}`
  );
}

function formatIncident(event: WatchIncidentEvent): string {
  const parts = [
    `INCIDENT [${event.provider} ${event.incident_kind}${scope(event.workstream_id)}]`,
  ];
  if (event.event !== undefined) parts.push(`event=${event.event}`);
  parts.push(`at=${event.occurred_at}`);
  return parts.join(" ");
}

function formatStale(event: WatchStaleEvent): string {
  const parts = [
    `STALE [${event.provider} ${short(event.session_id)}/${event.agent_id}${scope(event.workstream_id)}]`,
    `lease expired ${Math.round(event.lapsed_ms / 1000)}s ago`,
    `last_state=${event.last_state}`,
    `claims=${event.claims}`,
  ];
  if (event.current_action !== undefined) {
    const tool =
      event.current_action.tool_name === undefined
        ? ""
        : `:${event.current_action.tool_name}`;
    parts.push(`action=${event.current_action.kind}${tool}`);
  }
  if (event.unknown_write_scope) parts.push("write_scope=unknown");
  // Expiry only means nothing renewed the claim — a paused laptop or a
  // stalled hook looks identical to a crash, so the line never says "died".
  parts.push("— nothing renewed it; its claims are no longer current");
  return parts.join(" ");
}

export function formatWatchEvent(event: WatchEvent): string {
  switch (event.kind) {
    case "armed":
      return formatArmed(event);
    case "turn":
      return formatTurn(event);
    case "join":
      return formatJoin(event);
    case "incident":
      return formatIncident(event);
    case "stale":
      return formatStale(event);
    case "error":
      return (
        `WATCH-ERROR ${excerpt(event.message, 200)} ` +
        `(${event.consecutive}/${event.limit})`
      );
  }
}
