import { basename, resolve } from "node:path";

import {
  readProjectCatalogue,
  type ReaderCatalogueWorkstream,
} from "../reader/catalogue.js";
import { readProjectStoreHealth } from "../reader/health.js";
import { readProjectContext } from "../reader/store.js";

import {
  chooseCard,
  composeMatte,
  trueSizeNotice,
  COMFORT_CARD,
} from "./geometry.js";
import {
  dashboardTurnFact,
  hubProjectionWarning,
  reduceDashboard,
  reduceHub,
  clockHHMM,
  outcomeWord,
  shortSessionId,
  type DashboardTurnFact,
} from "./reduce.js";
import { renderComfortCard, renderSubCard } from "./render-card.js";
import { padCells } from "./cells.js";
import type { CardView } from "./view.js";
import {
  COMFORT_BYTE_BUDGET,
  COMFORT_TURNS_PER_SESSION,
} from "./defaults.js";

export const ONCE_DEFAULT_WIDTH = COMFORT_CARD.width;
export const ONCE_DEFAULT_HEIGHT = COMFORT_CARD.height;

/**
 * `--once` (§8): one pinned reader snapshot, one reference time, and a
 * deterministic byte-for-byte composition. No ANSI, OSC 52, clipboard
 * discovery, cursor commands, alternate screen, terminal probing, phase
 * clock, or live wording appears; a working art tier carries one fixed,
 * full-size horse pose so repeated snapshots remain byte-identical.
 */

export interface OnceReaders {
  readonly readHealth: typeof readProjectStoreHealth;
  readonly readCatalogue: typeof readProjectCatalogue;
  readonly readContext: typeof readProjectContext;
}

export interface OnceOptions {
  readonly projectRoot: string;
  readonly workstreamId?: string;
  readonly width?: number;
  readonly height?: number;
  readonly motionOff?: boolean;
  readonly byteBudget?: number;
  readonly turnsPerSession?: number;
  /** The pinned snapshot time; defaults to one sample of the real clock. */
  readonly now?: Date;
  readonly readers?: Partial<OnceReaders>;
}

/** `2026-08-25 02:07:00Z`: the snapshot stamp used on bench and key line. */
export function onceTimestamp(reference: Date): string {
  return `${reference.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/**
 * Compose one complete `--once` frame: the largest complete card that fits
 * the requested dimensions, centered in deterministic matte, plus the final
 * newline. Below the 12×6 floor the output is the exact true-size notice.
 */
export function assembleOnce(
  view: CardView,
  width: number,
  height: number,
): string {
  const card = chooseCard(width, height);
  if (card === undefined) {
    const notice = trueSizeNotice(width, height);
    return notice.length === 0 ? "" : `${notice.join("\n")}\n`;
  }
  if (card.tier === "comfort" || card.tier === "sub") {
    const lines =
      card.tier === "comfort" ? renderComfortCard(view) : renderSubCard(view);
    return `${composeMatte(lines, card, width, height).join("\n")}\n`;
  }
  // Text and floor tiers page the same facts in plain words.
  const words = [
    `Barbaro snapshot`,
    view.location,
    view.truth,
    view.keyLine,
  ].map((line) => padCells(line, card.width));
  while (words.length < card.height) words.push(" ".repeat(card.width));
  return `${composeMatte(words.slice(0, card.height), card, width, height).join("\n")}\n`;
}

export async function renderOnceSnapshot(
  options: OnceOptions,
): Promise<string> {
  const projectRoot = resolve(options.projectRoot);
  const width = options.width ?? ONCE_DEFAULT_WIDTH;
  const height = options.height ?? ONCE_DEFAULT_HEIGHT;
  const readers: OnceReaders = {
    readHealth: options.readers?.readHealth ?? readProjectStoreHealth,
    readCatalogue: options.readers?.readCatalogue ?? readProjectCatalogue,
    readContext: options.readers?.readContext ?? readProjectContext,
  };
  const reference = options.now ?? new Date();
  const stamp = onceTimestamp(reference);
  const byteBudget = options.byteBudget ?? COMFORT_BYTE_BUDGET;
  const projectLine = `Project · ${basename(projectRoot)} · root ${projectRoot}`;

  const health = await readers.readHealth(projectRoot, {
    byteBudget,
    now: reference,
  });
  if (health.value.presence === "absent") {
    return assembleOnce(
      {
        location: "Snapshot",
        truth: "No film loaded",
        frame: {
          kind: "intertitle",
          title: "No film loaded",
          lines: ["No film loaded", "This project has no Barbaro store yet."],
        },
        bench: [projectLine, `Snapshot · ${stamp}`],
        keyLine: `Snapshot · captured ${stamp}`,
      },
      width,
      height,
    );
  }

  const catalogue = await readers.readCatalogue(projectRoot, {
    byteBudget,
    now: reference,
    turnsPerSession: options.turnsPerSession ?? COMFORT_TURNS_PER_SESSION,
    ...(options.workstreamId === undefined
      ? {}
      : { workstreamId: options.workstreamId }),
  });

  if (options.workstreamId === undefined) {
    const reduced = reduceHub(catalogue.value, undefined, undefined, "open");
    const warning = hubProjectionWarning(catalogue.value, "open");
    return assembleOnce(
      {
        location: "Home · Open · snapshot",
        truth: reduced.truth,
        frame: reduced.frame,
        bench: [
          ...(warning === undefined ? [] : [warning]),
          projectLine,
          `Snapshot · ${stamp}`,
        ],
        keyLine: `Snapshot · open workstreams · captured ${stamp}`,
      },
      width,
      height,
    );
  }

  const item = catalogue.value.workstreams.items.find(
    (candidate) => candidate.record.workstream_id === options.workstreamId,
  );
  if (item === undefined) {
    return assembleOnce(
      {
        location: "Snapshot",
        truth: "The workstream record was not readable",
        frame: {
          kind: "intertitle",
          title: "Snapshot",
          lines: ["The workstream record was not readable"],
        },
        bench: [projectLine, `Snapshot · ${stamp}`],
        keyLine: `Snapshot · captured ${stamp}`,
      },
      width,
      height,
    );
  }

  const context = await readers.readContext(projectRoot, {
    byteBudget,
    turnsPerSession: options.turnsPerSession ?? COMFORT_TURNS_PER_SESSION,
    workstreamId: options.workstreamId,
  });
  const turns: DashboardTurnFact[] =
    context.value.turns.items.map(dashboardTurnFact);

  const reduced = reduceDashboard(item, turns, {
    kind: "snapshot",
    motionOff: options.motionOff === true,
  });
  const scopeName =
    item.record.status === "completed"
      ? `${item.record.name} · completed`
      : item.record.name;
  return assembleOnce(
    {
      location: `${scopeName} · snapshot`,
      truth: reduced.truth,
      frame: reduced.frame,
      bench: onceBench(item, stamp, projectLine),
      keyLine: `Snapshot · ${item.record.name} · captured ${stamp}`,
    },
    width,
    height,
  );
}

function onceBench(
  item: ReaderCatalogueWorkstream,
  stamp: string,
  projectLine: string,
): string[] {
  const lines: string[] = [];
  const roll = item.rolls.items[0];
  if (roll !== undefined) {
    const identity = shortSessionId(roll.provider, roll.session_id);
    const working = roll.state_counts.working > 0;
    lines.push(
      `${identity} · ${working ? "working at snapshot" : "at snapshot"}`,
    );
    if (roll.last_turn !== undefined) {
      lines.push(
        `Latest shown exposure · #${roll.last_turn.sequence} · ${outcomeWord(
          roll.last_turn.outcome,
        ).toLowerCase()} · ${clockHHMM(roll.last_turn.ended_at)}`,
      );
    }
    const unread = item.unread?.items.find(
      (summary) =>
        summary.key.provider === roll.provider &&
        summary.key.session_id === roll.session_id,
    );
    if (unread !== undefined && unread.status === "ready" && unread.unread_count > 0) {
      lines.push(`News ${unread.unread_count} for ${identity}`);
    }
    const publish = item.publish?.items.find(
      (summary) =>
        summary.provider === roll.provider &&
        summary.session_id === roll.session_id,
    );
    lines.push(
      publish?.state === "clear"
        ? "Publication clear"
        : publish?.state === "blocked"
          ? "Publish blocked"
          : publish?.state === "pending"
            ? "Publication pending"
            : "Publish state is unknown",
    );
  }
  lines.push(`Snapshot · ${stamp}`);
  lines.push(projectLine);
  return lines;
}
