import { measureCells, padCells } from "./cells.js";

/**
 * The comfort card ladder (§8). Every tier is one fixed card centered in
 * the terminal; a larger terminal adds deterministic empty matte and never
 * more columns, rows of records, panels, or metrics.
 */

export type ComfortTier = "comfort" | "sub" | "text" | "floor";

export interface CardGeometry {
  readonly tier: ComfortTier;
  readonly width: number;
  readonly height: number;
}

export interface ComfortAnatomy {
  readonly topStripRows: number;
  readonly frameRows: number;
  readonly benchRows: number;
  /** Interior cells between the frame walls. */
  readonly interiorCells: number;
}

export const COMFORT_CARD: CardGeometry = {
  tier: "comfort",
  width: 64,
  height: 28,
};
export const SUB_CARD: CardGeometry = { tier: "sub", width: 56, height: 22 };
export const TEXT_CARD: CardGeometry = { tier: "text", width: 40, height: 12 };
export const FLOOR_CARD: CardGeometry = { tier: "floor", width: 12, height: 6 };

/** 2 + 1 + 16 + 1 + 6 + 1 + 1 = 28 (gate 2). */
export const COMFORT_ANATOMY: ComfortAnatomy = {
  topStripRows: 2,
  frameRows: 16,
  benchRows: 6,
  interiorCells: 62,
};

/** 2 + 1 + 12 + 1 + 4 + 1 + 1 = 22 (gate 3). */
export const SUB_ANATOMY: ComfortAnatomy = {
  topStripRows: 2,
  frameRows: 12,
  benchRows: 4,
  interiorCells: 54,
};

/**
 * Choose the first ladder tier whose minimums both hold; undefined means
 * the terminal is below the 12×6 safety floor and gets the true-size
 * notice. Dimensions are never independently clamped upward: a 120×24
 * terminal takes the 56×22 sub-card.
 */
export function chooseCard(
  width: number,
  height: number,
): CardGeometry | undefined {
  for (const card of [COMFORT_CARD, SUB_CARD, TEXT_CARD, FLOOR_CARD]) {
    if (width >= card.width && height >= card.height) return card;
  }
  return undefined;
}

/** Deterministic centering: spare space splits left/top-heavy-last. */
export function matteOffsets(
  terminalWidth: number,
  terminalHeight: number,
  card: CardGeometry,
): { readonly left: number; readonly top: number } {
  return {
    left: Math.floor((terminalWidth - card.width) / 2),
    top: Math.floor((terminalHeight - card.height) / 2),
  };
}

/**
 * Compose one complete terminal frame: the card centered in space-filled
 * matte at exactly the requested dimensions. Every line measures exactly
 * `terminalWidth` cells; the caller owns newline joining.
 */
export function composeMatte(
  cardLines: readonly string[],
  card: CardGeometry,
  terminalWidth: number,
  terminalHeight: number,
): string[] {
  if (cardLines.length !== card.height) {
    throw new RangeError("card lines do not match the card height");
  }
  for (const line of cardLines) {
    if (measureCells(line) !== card.width) {
      throw new RangeError("card line does not measure the card width");
    }
  }
  const { left, top } = matteOffsets(terminalWidth, terminalHeight, card);
  const blank = " ".repeat(terminalWidth);
  const lines: string[] = [];
  for (let row = 0; row < terminalHeight; row += 1) {
    const cardRow = row - top;
    if (cardRow < 0 || cardRow >= card.height) {
      lines.push(blank);
      continue;
    }
    const line = `${" ".repeat(left)}${cardLines[cardRow]!}`;
    lines.push(line + " ".repeat(terminalWidth - measureCells(line)));
  }
  return lines;
}

/**
 * The exact true-size notice for a terminal below the 12×6 floor. Rendered
 * against actual geometry, never clamped; zero width or height emits no
 * cells at all.
 */
export function trueSizeNotice(
  width: number,
  height: number,
  keyLine = "q quit",
): string[] {
  if (width <= 0 || height <= 0) return [];
  // The exact geometry leads so it survives clipping at any legal width.
  const message = [`${width}x${height} small`, "Need 12x6", keyLine];
  const lines: string[] = [];
  for (let row = 0; row < height; row += 1) {
    lines.push(padCells(message[row] ?? "", width));
  }
  return lines;
}
