import type { IdleFrameView, WorkingFrameView } from "./view.js";

export const SELECTED_HUB_ROW_COLOR = "\u001b[36m";
export const SESSION_PROVENANCE_DIM = "\u001b[2m";
export const SGR_RESET = "\u001b[0m";

/**
 * Accent the selected Home row only after plain card geometry has been
 * validated and centered. Only the selector and workstream identity receive
 * the accent; status and age details deliberately remain at the terminal's
 * default foreground. The reset therefore lands before the detail column.
 */
export function accentSelectedHubRow(
  cardLines: readonly string[],
  terminalLines: readonly string[],
  matteTop: number,
): readonly string[] {
  const cardRow = cardLines.findIndex((line) => line.startsWith("│> "));
  if (cardRow === -1) return terminalLines;

  const terminalRow = matteTop + cardRow;
  const line = terminalLines[terminalRow];
  if (line === undefined) return terminalLines;
  const marker = line.indexOf("│> ");
  const rightWall = line.lastIndexOf("│");
  if (marker === -1 || rightWall <= marker + 1) return terminalLines;

  const textStart = marker + 1;
  const identityEnd = line.indexOf(" ", marker + 3);
  if (identityEnd === -1 || identityEnd >= rightWall) return terminalLines;
  const styled = [...terminalLines];
  styled[terminalRow] =
    `${line.slice(0, textStart)}${SELECTED_HUB_ROW_COLOR}` +
    `${line.slice(textStart, identityEnd)}${SGR_RESET}${line.slice(identityEnd)}`;
  return styled;
}

/**
 * Link the selected dashboard roll to its completed exposures after plain
 * geometry has been validated. This stays color-only and motion-free: the
 * discarded scrolling-preview idea must not reappear as ticker motion.
 */
export function styleDashboardProvenanceRows(
  cardLines: readonly string[],
  terminalLines: readonly string[],
  matteTop: number,
  frame: IdleFrameView | WorkingFrameView,
): readonly string[] {
  if (!frame.rolls.some((roll) => roll.selected)) return terminalLines;

  const styled = [...terminalLines];
  const exposureRows =
    frame.kind === "idle"
      ? matchingRows(cardLines, (line) => /^│[ >] #\d+/u.test(line))
      : [];
  if (frame.kind === "idle") {
    const visibleExposures = frame.exposures.slice(-exposureRows.length);
    for (const [index, cardRow] of exposureRows.entries()) {
      const provenance = visibleExposures[index]?.provenance;
      if (provenance === undefined) continue;
      paintFramedInterior(
        styled,
        matteTop + cardRow,
        provenance === "selected-session"
          ? SELECTED_HUB_ROW_COLOR
          : SESSION_PROVENANCE_DIM,
      );
    }
  }

  const contentRows = matchingRows(cardLines, (line) => {
    if (!line.startsWith("│") || !line.endsWith("│")) return false;
    return line.slice(1, -1).trim().length > 0;
  });
  const rollRows =
    frame.kind === "idle"
      ? contentRows
          .filter((row) => row > (exposureRows.at(-1) ?? -1))
          .slice(1)
      : contentRows.slice(-frame.rolls.length);
  const visibleRolls = selectedViewport(frame.rolls, rollRows.length);
  for (const [index, cardRow] of rollRows.entries()) {
    const roll = visibleRolls[index];
    if (roll === undefined) continue;
    paintFramedInterior(
      styled,
      matteTop + cardRow,
      roll.selected ? SELECTED_HUB_ROW_COLOR : SESSION_PROVENANCE_DIM,
    );
  }
  return styled;
}

function matchingRows(
  lines: readonly string[],
  matches: (line: string) => boolean,
): number[] {
  const rows: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (matches(line)) rows.push(index);
  }
  return rows;
}

function selectedViewport<T extends { readonly selected: boolean }>(
  items: readonly T[],
  visibleCount: number,
): readonly T[] {
  const count = Math.min(Math.max(0, visibleCount), items.length);
  if (count === items.length) return items;
  if (count === 0) return [];
  const selected = Math.max(
    0,
    items.findIndex((item) => item.selected),
  );
  const maximumStart = Math.max(0, items.length - count);
  const start = Math.min(Math.max(0, selected - count + 1), maximumStart);
  return items.slice(start, start + count);
}

function paintFramedInterior(
  lines: string[],
  row: number,
  opening: string,
): void {
  const line = lines[row];
  if (line === undefined) return;
  const leftWall = line.indexOf("│");
  const rightWall = line.lastIndexOf("│");
  if (leftWall === -1 || rightWall <= leftWall) return;
  lines[row] =
    `${line.slice(0, leftWall + 1)}${opening}` +
    `${line.slice(leftWall + 1, rightWall)}${SGR_RESET}` +
    line.slice(rightWall);
}
