/**
 * The comfort card's one sanitized, cell-measured text pipeline.
 *
 * Every framed interior line — art, rolls, ledger, intertitles, form,
 * results, Help — passes through this module before a wall is painted, so
 * the right wall's position never depends on untrusted content. The width
 * table below is the single normative table shared by the renderer and the
 * golden validator; the checked-in study-plate glyphs are all narrow.
 */

export const COMFORT_CELL_TABLE_VERSION = "comfort-cells.v1" as const;

/** Replacement for a control, format, or otherwise unmeasurable character. */
export const CELL_REPLACEMENT = "·";

/**
 * Cells one code point occupies: 0 for combining marks, 2 for East Asian
 * wide and fullwidth ranges (emoji included), 1 for everything else that
 * survives sanitization.
 */
export function charCells(codePoint: number): 0 | 1 | 2 {
  if (isCombining(codePoint)) return 0;
  if (isWide(codePoint)) return 2;
  return 1;
}

/**
 * Replace every C0/C1 control, NUL, and format character with one visible
 * narrow placeholder. Sanitization never deletes: a hostile name cannot
 * shrink to look like a different one.
 */
export function sanitizeCells(text: string): string {
  let out = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    out += isForbidden(codePoint) ? CELL_REPLACEMENT : character;
  }
  return out;
}

/** Measured cell width of already-sanitized text. */
export function measureCells(text: string): number {
  let cells = 0;
  for (const character of text) {
    cells += charCells(character.codePointAt(0)!);
  }
  return cells;
}

/**
 * Clip sanitized text to at most `maximumCells`, never splitting a wide
 * character; a wide character that does not fit is dropped entirely.
 */
export function clipCells(text: string, maximumCells: number): string {
  if (maximumCells <= 0) return "";
  let out = "";
  let cells = 0;
  for (const character of text) {
    const width = charCells(character.codePointAt(0)!);
    if (cells + width > maximumCells) break;
    out += character;
    cells += width;
  }
  return out;
}

/**
 * Sanitize and flatten prose, then clip it with an explicit ellipsis. When
 * possible the cut backs up to whitespace so a bench sentence or subtitle
 * never ends as an unexplained partial word. A single overlong token keeps a
 * bounded prefix because replacing the entire value with dots would hide it.
 */
export function clipWords(text: string, maximumCells: number): string {
  if (maximumCells <= 0) return "";
  const flat = sanitizeCells(text.replace(/\s+/gu, " ").trim());
  if (measureCells(flat) <= maximumCells) return flat;

  const ellipsis = clipCells("...", maximumCells);
  const available = maximumCells - measureCells(ellipsis);
  if (available <= 0) return ellipsis;

  const clipped = clipCells(flat, available);
  const remainder = flat.slice(clipped.length);
  const cutInsideWord =
    remainder.length > 0 &&
    !/^\s/u.test(remainder) &&
    !/\s$/u.test(clipped);
  const boundary = clipped.lastIndexOf(" ");
  const kept =
    cutInsideWord && boundary > 0
      ? clipped.slice(0, boundary).trimEnd()
      : clipped.trimEnd();
  return `${kept}${ellipsis}`;
}

/**
 * Sanitize, clip, and space-pad to exactly `widthCells` cells. This is the
 * only way content enters a fixed-width interior buffer.
 */
export function padCells(text: string, widthCells: number): string {
  const clipped = clipCells(sanitizeCells(text), widthCells);
  return clipped + " ".repeat(widthCells - measureCells(clipped));
}

/** Center sanitized text inside exactly `widthCells` cells. */
export function centerCells(text: string, widthCells: number): string {
  const clipped = clipCells(sanitizeCells(text), widthCells);
  const spare = widthCells - measureCells(clipped);
  const left = Math.floor(spare / 2);
  return " ".repeat(left) + clipped + " ".repeat(spare - left);
}

/** One interior line between two independently painted walls. */
export function frameLine(interior: string, interiorCells: number): string {
  return `│${padCells(interior, interiorCells)}│`;
}

/** `┌─ Title ────┐`: the top border with a sanitized measured title. */
export function frameTop(title: string, widthCells: number): string {
  return titledBorder("┌", "┐", title, widthCells, "left");
}

/** `└─ Position ─┘`: a plain or titled bottom border. */
export function frameBottom(
  widthCells: number,
  title: string = "",
): string {
  return titledBorder("└", "┘", title, widthCells, "right");
}

function titledBorder(
  leftCorner: string,
  rightCorner: string,
  title: string,
  widthCells: number,
  titleSide: "left" | "right",
): string {
  const interior = widthCells - 2;
  if (title.length === 0) {
    return `${leftCorner}${"─".repeat(interior)}${rightCorner}`;
  }
  const label = clipCells(sanitizeCells(title), interior - 4);
  const used = measureCells(label);
  const fill = "─".repeat(interior - used - 3);
  return titleSide === "left"
    ? `${leftCorner}─ ${label} ${fill}${rightCorner}`
    : `${leftCorner}${fill} ${label} ─${rightCorner}`;
}

function isForbidden(codePoint: number): boolean {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return true;
  }
  // Format characters (bidi controls, ZWJ/ZWNJ, BOM) can reorder or hide
  // content; they are never worth a cell.
  if (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  ) {
    return true;
  }
  return false;
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
