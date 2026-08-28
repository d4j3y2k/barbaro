import { createHash } from "node:crypto";

import { HORSE_RIDERLESS_COMPACT_FRAMES } from "./horse-frames.js";

/**
 * The motion study's static form: an ordered labeled F01/F04/F07/F10
 * contact strip (§7). It is a separate deterministic asset regenerated as a
 * unit from the checked-in 36×8 riderless frames by the comfort design
 * round's reducer — never four squeezed live plates, never hand-edited
 * phases, never chosen from a clock. The 64-column variant below is byte
 * normative via the indexed comfort keyframes; the 56-column variant is its
 * fixed deterministic reduction. `STRIP_SOURCE_HASH` ties both to the
 * source frames and reducer version so a regenerated asset is detectable.
 */

export const STRIP_REDUCER_VERSION = "comfort-strip.v1" as const;

export const STRIP_PHASES = ["F01", "F04", "F07", "F10"] as const;

/** Four 13-column, four-row thumbnails for the 64×28 card. */
export const STRIP_64_THUMBS: readonly (readonly string[])[] = [
  ["    ░▓██▒    ", " ░▒▓██████▓  ", " ▒░ ██████▒  ", "   ░▓▒░ ░█▒  "],
  ["    ░▓██▒    ", " ░▒▓██████▓  ", " ▒░ ██████▒  ", "  ░▓▒  ░█▒░  "],
  ["    ░▓██▒    ", " ░▒▓██████▓  ", " ▒░ ██████▒  ", "   ░▓░▒ ░█   "],
  ["    ░▓██▒    ", " ░▒▓██████▓  ", " ▒░ ██████▒  ", "  ░▓▒░   ░█▒ "],
];

/**
 * Four 11-column, three-row thumbnails for the 56×22 sub-card: the fixed
 * reduction drops the small head row and trims one column from each side.
 */
export const STRIP_56_THUMBS: readonly (readonly string[])[] =
  STRIP_64_THUMBS.map((thumb) =>
    thumb.slice(1).map((row) => row.slice(1, 12)),
  );

export const STRIP_64_CELLS = 13;
export const STRIP_56_CELLS = 11;
export const STRIP_GUTTER_CELLS = 2;

/** sha256 over the source frames plus the reducer version. */
export const STRIP_SOURCE_HASH: string = createHash("sha256")
  .update(JSON.stringify(HORSE_RIDERLESS_COMPACT_FRAMES))
  .update(STRIP_REDUCER_VERSION)
  .digest("hex");

/**
 * Lay one strip variant into full interior rows: a centered label row, then
 * the art rows, thumbnails left to right with two-cell gutters. The result
 * is plain text; walls and styling belong to the caller.
 */
export function stripRows(
  thumbs: readonly (readonly string[])[],
  thumbCells: number,
  interiorCells: number,
): string[] {
  const artRows = thumbs[0]!.length;
  const used =
    thumbs.length * thumbCells + (thumbs.length - 1) * STRIP_GUTTER_CELLS;
  const left = Math.floor((interiorCells - used) / 2);
  const gutter = " ".repeat(STRIP_GUTTER_CELLS);

  const label = thumbs
    .map((_, index) => centerLabel(STRIP_PHASES[index]!, thumbCells))
    .join(gutter);
  const rows = [pad(label, left, interiorCells)];
  for (let row = 0; row < artRows; row += 1) {
    rows.push(
      pad(thumbs.map((thumb) => thumb[row]!).join(gutter), left, interiorCells),
    );
  }
  return rows;
}

/** The normative 64-card strip rows (label + four art rows, 62 cells). */
export function stripRows64(): string[] {
  return stripRows(STRIP_64_THUMBS, STRIP_64_CELLS, 62);
}

/** The sub-card strip rows (label + three art rows, 54 cells). */
export function stripRows56(): string[] {
  return stripRows(STRIP_56_THUMBS, STRIP_56_CELLS, 54);
}

function centerLabel(label: string, widthCells: number): string {
  const spare = widthCells - label.length;
  const left = Math.floor(spare / 2);
  return " ".repeat(left) + label + " ".repeat(spare - left);
}

function pad(row: string, left: number, interiorCells: number): string {
  const line = " ".repeat(left) + row;
  return line + " ".repeat(interiorCells - line.length);
}
