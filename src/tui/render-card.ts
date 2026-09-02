import {
  charCells,
  centerCells,
  clipCells,
  clipWords,
  frameBottom,
  frameLine,
  frameTop,
  measureCells,
  padCells,
  sanitizeCells,
} from "./cells.js";
import {
  COMFORT_ANATOMY,
  COMFORT_CARD,
  SUB_ANATOMY,
  SUB_CARD,
  type CardGeometry,
  type ComfortAnatomy,
} from "./geometry.js";
import {
  HORSE_RIDERLESS_COMPACT_FRAMES,
} from "./horse-frames.js";
import {
  HORSE_FRAME_COUNT,
  brandedHeroHorseFrame,
  horseFrame,
} from "./horse.js";
import type {
  BootTextView,
  BootView,
  CardView,
  FrameView,
  HelpFrameView,
  HubFrameView,
  IdleFrameView,
  IntertitleFrameView,
  RollLineView,
  TraversalFrameView,
  WorkingFrameView,
} from "./view.js";

/**
 * The pure comfort renderer: one view model in, one exact card out. Every
 * interior line passes the sanitized cell buffer; the walls, stops, and
 * breathing rows below are the normative keyframe layout. Rendering never
 * reads, never mutates, and depends on nothing but its arguments.
 */

/** One-based card column 38 → interior index 36; sub-card 26 → 24. */
const DETAIL_STOP_64 = 36;
const DETAIL_STOP_56 = 24;
const LEDGER_INDENT = 2;
const COMPACT_HORSE_ROWS = 8;
const COMPACT_HORSE_CELLS = 36;
const IDLE_ROLL_CAPACITY_64 = 5;
const IDLE_ROLL_CAPACITY_56 = 2;
const HELP_MEANING_STOP = 19;

export function renderComfortCard(view: CardView): string[] {
  return renderCard(view, COMFORT_CARD, COMFORT_ANATOMY);
}

export function renderSubCard(view: CardView): string[] {
  return renderCard(view, SUB_CARD, SUB_ANATOMY);
}

/** The only large house film: a bounded startup splash, outside card chrome. */
export function renderBootSplash(
  view: BootView,
  card: CardGeometry,
): string[] {
  if (card.tier !== "comfort" && card.tier !== "sub") {
    throw new TypeError("the boot splash requires a framed card tier");
  }
  const scale = card.tier === "comfort" && view.scale === "hero"
    ? "hero"
    : "compact";
  const art = scale === "hero"
    ? brandedHeroHorseFrame(view.frameIndex)
    : horseFrame(view.frameIndex, scale, "riderless");
  const artWidth = scale === "hero" ? 56 : 36;
  const plate = `${(view.frameIndex % HORSE_FRAME_COUNT) + 1}`.padStart(2, "0");
  const content = [
    ...(scale === "hero" ? [] : ["B A R B A R O"]),
    "THE HORSE IN MOTION",
    "",
    frameTop(`PLATE ${plate} OF ${HORSE_FRAME_COUNT}`, artWidth + 2),
    ...art.map((row) => frameLine(row, artWidth)),
    frameBottom(artWidth + 2),
    view.telemetry,
    "Starting Barbaro · q quit",
  ];
  const top = Math.max(0, Math.floor((card.height - content.length) / 2));
  const lines = [
    ...Array<string>(top).fill(" ".repeat(card.width)),
    ...content.map((line) => centerCells(line, card.width)),
  ];
  while (lines.length < card.height) lines.push(" ".repeat(card.width));
  return lines.slice(0, card.height);
}

/** Art-free startup for --no-motion and the text/floor card tiers. */
export function renderBootTextPage(
  view: BootTextView,
  card: CardGeometry,
): string[] {
  const content =
    card.tier === "floor"
      ? ["BARBARO", "Starting", view.elapsed, view.projected, "", "q quit"]
      : [
          "B A R B A R O",
          "",
          "Starting",
          "",
          view.phase,
          `Elapsed ${view.elapsed}`,
          `Projected ${view.projected}`,
          "",
          "q quit",
        ];
  const top =
    card.tier === "floor"
      ? 0
      : Math.max(0, Math.ceil((card.height - content.length) / 2));
  const page = [
    ...Array<string>(top).fill(" ".repeat(card.width)),
    ...content.map((line) => centerCells(line, card.width)),
  ];
  while (page.length < card.height) page.push(" ".repeat(card.width));
  return page.slice(0, card.height);
}

function renderCard(
  view: CardView,
  card: CardGeometry,
  anatomy: ComfortAnatomy,
): string[] {
  const lines: string[] = [];
  lines.push(topStripRow("Barbaro", view.location, card.width));
  lines.push(padCells(clipWords(view.truth, card.width), card.width));
  lines.push(" ".repeat(card.width));

  const layout = frameInterior(view.frame, card, anatomy);
  lines.push(frameTop(sanitizeCells(view.frame.title), card.width));
  for (const row of layout.rows) {
    lines.push(frameLine(row, anatomy.interiorCells));
  }
  lines.push(frameBottom(card.width, layout.bottomTitle));

  lines.push(" ".repeat(card.width));
  for (let row = 0; row < anatomy.benchRows; row += 1) {
    lines.push(
      padCells(clipWords(view.bench[row] ?? "", card.width), card.width),
    );
  }
  lines.push(" ".repeat(card.width));
  lines.push(padCells(fitKeyLine(view.keyLine, card.width), card.width));
  return lines;
}

/** Preserve whole key promises; shed secondary controls before primary ones. */
function fitKeyLine(keyLine: string, width: number): string {
  const clean = sanitizeCells(keyLine).trim();
  if (measureCells(clean) <= width) return clean;
  const segments = clean.split(/\s+·\s+/u).filter((part) => part.length > 0);
  const quit = segments.at(-1) === "q quit" ? segments.pop() : undefined;
  const fitted = [...segments];
  const render = (): string =>
    [...fitted, ...(quit === undefined ? [] : [quit])].join(" · ");
  while (fitted.length > 0 && measureCells(render()) > width) {
    let dropIndex = -1;
    let dropPriority = Number.POSITIVE_INFINITY;
    for (let index = 0; index < fitted.length; index += 1) {
      const priority = keyLineDropPriority(fitted[index]!);
      if (priority < dropPriority) {
        dropIndex = index;
        dropPriority = priority;
      }
    }
    // Unknown controls retain the old right-edge drop behavior.
    if (!Number.isFinite(dropPriority)) dropIndex = fitted.length - 1;
    fitted.splice(dropIndex, 1);
  }
  const result = render();
  return result.length === 0 ? clipWords(clean, width) : result;
}

function keyLineDropPriority(segment: string): number {
  if (segment === "r" || segment === "r refresh") return 0;
  if (segment === "n new") return 1;
  if (segment === "Space" || segment.startsWith("Space ")) return 2;
  if (segment === "?" || segment === "? help") return 3;
  return Number.POSITIVE_INFINITY;
}

function topStripRow(left: string, right: string, width: number): string {
  const leftCells = clipCells(sanitizeCells(left), width);
  const rightCells = clipCells(
    sanitizeCells(right),
    width - measureCells(leftCells) - 1,
  );
  const spare = width - measureCells(leftCells) - measureCells(rightCells);
  return `${leftCells}${" ".repeat(spare)}${rightCells}`;
}

function frameInterior(
  frame: FrameView,
  card: CardGeometry,
  anatomy: ComfortAnatomy,
): FrameInterior {
  const layout = ((): FrameInterior => {
    switch (frame.kind) {
      case "hub":
        return hubRows(frame, card, anatomy);
      case "working":
        return plainFrame(workingRows(frame, card, anatomy));
      case "idle":
        return plainFrame(idleRows(frame, card, anatomy));
      case "help":
        return plainFrame(helpRows(frame));
      case "intertitle":
        return plainFrame(intertitleRows(frame, anatomy));
      case "traversal":
        return plainFrame(traversalRows(frame, card, anatomy));
      case "form":
        return plainFrame(formRows(frame));
      case "created":
        return plainFrame(createdRows(frame, anatomy));
    }
  })();
  const interior: string[] = layout.rows.slice(0, anatomy.frameRows - 2);
  while (interior.length < anatomy.frameRows - 2) interior.push("");
  return { ...layout, rows: interior };
}

interface FrameInterior {
  readonly rows: string[];
  readonly bottomTitle?: string;
}

function plainFrame(rows: string[]): FrameInterior {
  return { rows };
}

/** Home: one-line entries, an honest viewport, and a positional border. */
function hubRows(
  frame: HubFrameView,
  card: CardGeometry,
  anatomy: ComfortAnatomy,
): FrameInterior {
  const capacity = anatomy.frameRows - 2;
  const stop = card.tier === "comfort" ? DETAIL_STOP_64 : DETAIL_STOP_56;

  let prefixRows = 1;
  let visibleQuiet = frame.quietLine !== undefined;
  let visibleUnknown = [...(frame.unknownNames ?? [])];
  let afterEntries =
    visibleQuiet || visibleUnknown.length > 0 ? 1 : 0;
  let afterQuiet =
    visibleQuiet && visibleUnknown.length > 0 ? 1 : 0;
  const minimumEntries = frame.entries.length === 0 ? 0 : 1;

  const reservedRows = (): number =>
    prefixRows +
    afterEntries +
    (visibleQuiet ? 1 + afterQuiet : 0) +
    (visibleUnknown.length === 0
      ? 0
      : 1 + visibleUnknown.length);

  while (capacity - reservedRows() < minimumEntries) {
    if (prefixRows > 0) {
      prefixRows -= 1;
    } else if (afterEntries > 0) {
      afterEntries = 0;
    } else if (afterQuiet > 0) {
      afterQuiet = 0;
    } else if (visibleUnknown.length > 0) {
      visibleUnknown = visibleUnknown.slice(0, -1);
    } else if (visibleQuiet) {
      visibleQuiet = false;
    } else {
      break;
    }
  }

  const entryCapacity = Math.max(0, capacity - reservedRows());
  const selectedIndex = Math.max(
    0,
    frame.entries.findIndex((entry) => entry.selected),
  );
  const visibleEntryCount = Math.min(entryCapacity, frame.entries.length);
  const maximumStart = Math.max(0, frame.entries.length - visibleEntryCount);
  const start = Math.min(
    Math.max(0, selectedIndex - visibleEntryCount + 1),
    maximumStart,
  );
  const entries = frame.entries.slice(start, start + visibleEntryCount);

  const rows: string[] = [];
  for (let row = 0; row < prefixRows; row += 1) rows.push("");
  for (const entry of entries) {
    rows.push(stopLine(entry.selected, entry.name, entry.detail, stop));
  }
  for (let row = 0; row < afterEntries; row += 1) rows.push("");
  if (visibleQuiet && frame.quietLine !== undefined) {
    rows.push(`${" ".repeat(LEDGER_INDENT)}${frame.quietLine}`);
    for (let row = 0; row < afterQuiet; row += 1) rows.push("");
  }
  if (visibleUnknown.length > 0) {
    rows.push(
      `${" ".repeat(LEDGER_INDENT)}${frame.unknownHeader ?? "Activity unknown"}`,
    );
    for (const name of visibleUnknown) {
      rows.push(`${" ".repeat(LEDGER_INDENT)}${name}`);
    }
  }

  return {
    rows,
    bottomTitle: frame.bottomTitle,
  };
}

function workingRows(
  frame: WorkingFrameView,
  card: CardGeometry,
  anatomy: ComfortAnatomy,
): string[] {
  const rows: string[] = [];
  const horse = frame.horse;
  if (horse.kind === "gallop") {
    const plate = HORSE_RIDERLESS_COMPACT_FRAMES[horse.frameIndex];
    if (plate === undefined) {
      throw new RangeError(`no horse frame ${horse.frameIndex}`);
    }
    const offset = Math.floor(
      (anatomy.interiorCells - COMPACT_HORSE_CELLS) / 2,
    );
    for (const artRow of plate) {
      rows.push(`${" ".repeat(offset)}${artRow}`);
    }
  } else {
    const blank = Math.floor((COMPACT_HORSE_ROWS - 1) / 2);
    for (let row = 0; row < blank; row += 1) rows.push("");
    rows.push(centerCells(horse.text, anatomy.interiorCells));
    for (let row = blank + 1; row < COMPACT_HORSE_ROWS; row += 1) rows.push("");
  }
  if (card.tier === "comfort" && horse.kind === "gallop") {
    rows.push(centerCells(frame.telemetry ?? "", anatomy.interiorCells));
  }
  const capacity = anatomy.frameRows - 2;
  // Spend a spare interior row on separation, but reclaim it at the tier's
  // maximum roster capacity instead of hiding a session.
  if (
    horse.kind === "gallop" &&
    frame.rolls.length > 0 &&
    rows.length + 1 + frame.rolls.length <= capacity
  ) {
    // Move spare tail room to the boundary between instrumentation and roster.
    rows.push("");
  }
  const stop = card.tier === "comfort" ? DETAIL_STOP_64 : DETAIL_STOP_56;
  for (const roll of frame.rolls) {
    rows.push(stopLine(roll.selected, roll.identity, roll.detail, stop));
  }
  return rows;
}

function idleRows(
  frame: IdleFrameView,
  card: CardGeometry,
  anatomy: ComfortAnatomy,
): string[] {
  const capacity = anatomy.frameRows - 2;
  const rollCapacity =
    card.tier === "comfort"
      ? IDLE_ROLL_CAPACITY_64
      : IDLE_ROLL_CAPACITY_56;
  const rolls = selectedViewport(frame.rolls, rollCapacity);
  const exposureCapacity = Math.max(0, capacity - rolls.length - 1);
  const exposures =
    exposureCapacity === 0
      ? []
      : frame.exposures.slice(-exposureCapacity);

  let spare = capacity - exposures.length - rolls.length - 1;
  const allExposuresFit = exposures.length === frame.exposures.length;
  const gapBeforeSummary = allExposuresFit && spare-- > 0;
  const gapAfterSummary = allExposuresFit && spare-- > 0;
  const leadingBreath = allExposuresFit && spare-- > 0;
  const sequenceCells = Math.max(
    2,
    ...exposures.map((exposure) => `${exposure.sequence}`.length + 1),
  );

  const rows: string[] = [];
  if (leadingBreath) rows.push("");
  for (const exposure of exposures) {
    rows.push(exposureLine(exposure, sequenceCells, anatomy.interiorCells));
  }
  if (gapBeforeSummary) rows.push("");
  rows.push(`${" ".repeat(LEDGER_INDENT)}${frame.summaryLine}`);
  if (gapAfterSummary) rows.push("");

  const stop = card.tier === "comfort" ? DETAIL_STOP_64 : DETAIL_STOP_56;
  for (const roll of rolls) {
    rows.push(stopLine(roll.selected, roll.identity, roll.detail, stop));
  }
  return rows;
}

function exposureLine(
  exposure: IdleFrameView["exposures"][number],
  sequenceCells: number,
  interiorCells: number,
): string {
  const sequence = `#${exposure.sequence}`.padEnd(sequenceCells);
  const prefix = `${exposure.selected ? ">" : " "} ${sequence}  ${exposure.time}  `;
  const exception =
    exposure.exception === undefined ? "" : `! ${exposure.exception} · `;
  const source =
    exposure.excerptTruncated && !exposure.excerpt.trimEnd().endsWith("...")
      ? `${exposure.excerpt.trimEnd()}...`
      : exposure.excerpt;
  const available = Math.max(0, interiorCells - measureCells(prefix));
  return `${prefix}${clipWords(`${exception}${source}`, available)}`;
}

function selectedViewport<T extends { readonly selected: boolean }>(
  items: readonly T[],
  capacity: number,
): readonly T[] {
  const count = Math.min(Math.max(0, capacity), items.length);
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

function helpRows(frame: HelpFrameView): string[] {
  const rows: string[] = [];
  for (const row of frame.keyRows) {
    rows.push(termLine(row.term, row.meaning));
  }
  rows.push("");
  for (const row of frame.wordRows) {
    rows.push(termLine(row.term, row.meaning));
  }
  return rows;
}

function intertitleRows(
  frame: IntertitleFrameView,
  anatomy: ComfortAnatomy,
): string[] {
  const rows: string[] = [];
  const content = frame.lines.length;
  const lead = Math.max(
    0,
    Math.floor((anatomy.frameRows - 2 - content) / 2),
  );
  for (let row = 0; row < lead; row += 1) rows.push("");
  for (const line of frame.lines) {
    rows.push(centerCells(line, anatomy.interiorCells));
  }
  return rows;
}

/** Keep the house chrome still while one horse pass crosses its interior. */
function traversalRows(
  frame: TraversalFrameView,
  card: CardGeometry,
  anatomy: ComfortAnatomy,
): string[] {
  if (
    !Number.isFinite(frame.progress) ||
    frame.progress < 0 ||
    frame.progress > 1
  ) {
    throw new RangeError("traversal progress must be from 0 to 1");
  }

  const comfort = card.tier === "comfort";
  const art = comfort
    ? brandedHeroHorseFrame(frame.frameIndex)
    : horseFrame(frame.frameIndex, "compact", "riderless");
  const artWidth = comfort ? 56 : COMPACT_HORSE_CELLS;
  const left = Math.round(
    -artWidth + frame.progress * (anatomy.interiorCells + artWidth),
  );
  const rows = art.map((row) =>
    translatedRow(row, left, anatomy.interiorCells)
  );
  if (!comfort && rows.length < anatomy.frameRows - 2) {
    rows.unshift(centerCells("B A R B A R O", anatomy.interiorCells));
  }
  return rows;
}

const FORM_FIELD_OPEN = 2;
const FORM_FIELD_CLOSE = 55;

/**
 * The create form (§5): exactly one underscore appears as the editor cursor
 * in the focused field, painted here and excluded from every canonical
 * value, writer argument, bench line, and Punch Out payload.
 */
function formRows(
  frame: import("./view.js").CreateFormFrameView,
): string[] {
  const rows: string[] = [""];
  for (const field of frame.fields) {
    rows.push(
      `${field.focused ? ">" : " "} ${sanitizeCells(field.label)}`,
    );
    const cursor = field.focused && frame.showCursor ? "_" : "";
    const content = clipCells(
      `${sanitizeCells(field.value)}${cursor}`,
      FORM_FIELD_CLOSE - FORM_FIELD_OPEN - 2,
    );
    const open = `${" ".repeat(FORM_FIELD_OPEN)}[ ${content}`;
    rows.push(
      `${open}${" ".repeat(FORM_FIELD_CLOSE - measureCells(open))}]`,
    );
    rows.push("");
  }
  for (const hint of frame.hints) {
    rows.push(`${" ".repeat(LEDGER_INDENT)}${sanitizeCells(hint)}`);
  }
  rows.push("");
  rows.push(`${" ".repeat(LEDGER_INDENT)}${sanitizeCells(frame.status)}`);
  return rows;
}

function createdRows(
  frame: import("./view.js").CreatedFrameView,
  anatomy: ComfortAnatomy,
): string[] {
  const rows: string[] = [""];
  rows.push(centerCells(frame.name, anatomy.interiorCells));
  if (frame.subtitle !== undefined) {
    rows.push(
      centerCells(
        clipWords(frame.subtitle, anatomy.interiorCells),
        anatomy.interiorCells,
      ),
    );
  }
  rows.push(centerCells(frame.idLine, anatomy.interiorCells));
  rows.push("");
  for (const command of frame.commands) {
    rows.push(`${" ".repeat(LEDGER_INDENT)}${sanitizeCells(command.heading)}`);
    const text = sanitizeCells(command.text);
    if (command.selected && command.manualHighlight) {
      rows.push(`> [ ${text} ]`);
    } else if (command.selected) {
      rows.push(`> ${text}`);
    } else {
      rows.push(`  ${text}`);
    }
    rows.push("");
  }
  return rows;
}

/** `> name` at card column 2/4, detail at the tier's fixed stop. */
function stopLine(
  selected: boolean,
  identity: string,
  detail: string,
  stop: number,
): string {
  const marker = selected ? ">" : " ";
  const name = clipCells(sanitizeCells(identity), stop - LEDGER_INDENT - 1);
  const head = `${marker} ${name}`;
  return `${head}${" ".repeat(Math.max(1, stop - measureCells(head)))}${sanitizeCells(detail)}`;
}

function termLine(term: string, meaning: string): string {
  const head = `${" ".repeat(LEDGER_INDENT)}${clipCells(sanitizeCells(term), HELP_MEANING_STOP - LEDGER_INDENT - 1)}`;
  return `${head}${" ".repeat(Math.max(1, HELP_MEANING_STOP + LEDGER_INDENT - measureCells(head)))}${sanitizeCells(meaning)}`;
}

/** Paint a row at a signed cell position without emitting partial glyphs. */
function translatedRow(text: string, left: number, width: number): string {
  let output = "";
  let outputCells = 0;
  let sourceCell = left;
  let previousVisible = false;
  for (const character of sanitizeCells(text)) {
    const characterWidth = charCells(character.codePointAt(0)!);
    if (characterWidth === 0) {
      if (previousVisible) output += character;
      continue;
    }

    const start = sourceCell;
    const end = start + characterWidth;
    sourceCell = end;
    if (end <= 0) {
      previousVisible = false;
      continue;
    }
    if (start < 0) {
      // A glyph straddling the left edge cannot be painted partially.
      previousVisible = false;
      continue;
    }
    if (start >= width || end > width) break;
    if (outputCells < start) {
      output += " ".repeat(start - outputCells);
      outputCells = start;
    }
    output += character;
    outputCells = end;
    previousVisible = true;
  }
  return padCells(output, width);
}
