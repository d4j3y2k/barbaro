import {
  HORSE_COMPACT_FRAMES,
  HORSE_HERO_FRAMES,
  HORSE_RIDERLESS_COMPACT_FRAMES,
  HORSE_RIDERLESS_HERO_FRAMES,
} from "./horse-frames.js";

const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[H\u001b[2J";

export const HORSE_FRAME_INTERVAL_MS = 100;
export const HORSE_FRAME_COUNT = HORSE_HERO_FRAMES.length;

export type HorseScale = "hero" | "compact";
export type HorseScalePreference = HorseScale | "auto";
export type HorseVariant = "original" | "riderless";
export type HorseStudyVariant = HorseVariant | "compare";
export type HorseWordmark =
  | "none"
  | "spaced-lower";

export interface HorseStudyFrameOptions {
  readonly width: number;
  readonly height: number;
  readonly frameIndex: number;
  readonly scale?: HorseScalePreference;
  readonly variant?: HorseStudyVariant;
  readonly wordmark?: HorseWordmark;
  readonly paused?: boolean;
  readonly style?: boolean;
  readonly interactive?: boolean;
}

export interface HorseStudyOptions {
  readonly intervalMs?: number;
  readonly scale?: HorseScalePreference;
  readonly variant?: HorseStudyVariant;
  readonly wordmark?: HorseWordmark;
  readonly style?: boolean;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
}

/** Return one raw, fixed-size density frame with a stable modulo index. */
export function horseFrame(
  frameIndex: number,
  scale: HorseScale,
  variant: HorseVariant = "original",
): readonly string[] {
  if (!Number.isSafeInteger(frameIndex)) {
    throw new TypeError("frameIndex must be an integer");
  }
  const frames = variant === "riderless"
    ? scale === "hero"
      ? HORSE_RIDERLESS_HERO_FRAMES
      : HORSE_RIDERLESS_COMPACT_FRAMES
    : scale === "hero"
      ? HORSE_HERO_FRAMES
      : HORSE_COMPACT_FRAMES;
  return frames[modulo(frameIndex, frames.length)]!;
}

/** Resolve an animation frame using elapsed time rather than render count. */
export function horseFrameIndex(
  elapsedMs: number,
  intervalMs: number = HORSE_FRAME_INTERVAL_MS,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("elapsedMs must be a non-negative finite number");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive integer");
  }
  return Math.floor(elapsedMs / intervalMs) % HORSE_FRAME_COUNT;
}

/** Render the standalone motion study without terminal lifecycle escape codes. */
export function renderHorseStudyFrame(
  options: HorseStudyFrameOptions,
): string {
  const width = dimension(options.width, "width");
  const height = dimension(options.height, "height");
  const variant = options.variant ?? "riderless";
  const wordmark = options.wordmark ?? "none";
  const scale = resolveScale(options.scale ?? "auto", width, height, variant);
  const study = variant === "compare"
    ? comparisonStudy(options.frameIndex, scale, wordmark)
    : singleStudy(
        options.frameIndex,
        scale,
        variant,
        wordmark,
      );
  const contentWidth = visibleLength(study.lines[0] ?? "");
  const requiredHeight = study.artHeight + 8;
  if (width < contentWidth || height < requiredHeight) {
    return renderTooSmall(width, height, contentWidth, requiredHeight);
  }

  const plate = modulo(options.frameIndex, HORSE_FRAME_COUNT) + 1;
  const subtitle = variant === "compare"
    ? `THE HORSE IN MOTION · PLATE ${plate.toString().padStart(2, "0")} OF ${HORSE_FRAME_COUNT}`
    : "THE HORSE IN MOTION";
  const lines = [
    styled("B A R B A R O", "bold", options.style !== false),
    styled(subtitle, "dim", options.style !== false),
    "",
    ...study.lines,
    styled(
      variant === "original"
        ? "EADWEARD MUYBRIDGE · SALLIE GARDNER · 19 JUNE 1878"
        : variant === "riderless"
          ? "SALLIE GARDNER · 1878 · RIDER REMOVED FROM SOURCE"
          : "SALLIE GARDNER · 1878 · RIGHT: RIDER REMOVED FROM SOURCE",
      "dim",
      options.style !== false,
    ),
    options.interactive === false
      ? `motion study · static frame${wordmark === "none" ? "" : ` · ${wordmarkLabel(wordmark)}`}`
      : `${options.paused === true ? "PAUSED" : "GALLOPING"} · q quit · space pause · ←/→ step · s scale · v view · w mark`,
  ];
  const topPadding = Math.max(0, Math.floor((height - lines.length) / 2));
  const rendered = [
    ...Array<string>(topPadding).fill(""),
    ...lines.map((line) => center(line, width)),
  ];
  while (rendered.length < height) rendered.push("");
  return rendered.slice(0, height).join("\n");
}

/** Animate the motion study until q or Ctrl-C, restoring terminal state. */
export async function runHorseStudy(
  options: HorseStudyOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("the horse motion study requires an interactive terminal");
  }
  const intervalMs = options.intervalMs ?? HORSE_FRAME_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive integer");
  }

  let scale = options.scale ?? "auto";
  let variant = options.variant ?? "riderless";
  let wordmark = options.wordmark ?? "none";
  let frameIndex = 0;
  let paused = false;
  let closed = false;
  let finish: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const wasRaw = input.isRaw ?? false;
  const draw = (): void => {
    output.write(
      `${CLEAR_SCREEN}${renderHorseStudyFrame({
        width: output.columns ?? 80,
        height: output.rows ?? 24,
        frameIndex,
        scale,
        variant,
        wordmark,
        paused,
        ...(options.style === undefined ? {} : { style: options.style }),
        interactive: true,
      })}`,
    );
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    finish?.();
  };
  const onData = (chunk: Buffer | string): void => {
    const key = chunk.toString("utf8");
    if (key.includes("q") || key.includes("\u0003")) {
      close();
      return;
    }
    if (key.includes(" ")) {
      paused = !paused;
      draw();
    }
    if (key.includes("\u001b[D")) {
      paused = true;
      frameIndex = modulo(frameIndex - 1, HORSE_FRAME_COUNT);
      draw();
    }
    if (key.includes("\u001b[C")) {
      paused = true;
      frameIndex = modulo(frameIndex + 1, HORSE_FRAME_COUNT);
      draw();
    }
    if (key.includes("s")) {
      scale = nextScale(
        scale,
        output.columns ?? 80,
        output.rows ?? 24,
        variant,
      );
      draw();
    }
    if (key.includes("v")) {
      variant = nextVariant(variant);
      draw();
    }
    if (key.includes("w")) {
      wordmark = nextWordmark(wordmark);
      draw();
    }
  };
  const onResize = (): void => draw();

  output.write(ENTER_SCREEN);
  try {
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    output.on("resize", onResize);
    draw();
    await new Promise<void>((done) => {
      finish = done;
      timer = setInterval(() => {
        if (paused || closed) return;
        frameIndex = modulo(frameIndex + 1, HORSE_FRAME_COUNT);
        draw();
      }, intervalMs);
    });
  } finally {
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    input.off("data", onData);
    output.off("resize", onResize);
    input.setRawMode(wasRaw);
    if (!wasRaw) input.pause();
    output.write(LEAVE_SCREEN);
  }
}

function resolveScale(
  preference: HorseScalePreference,
  width: number,
  height: number,
  variant: HorseStudyVariant,
): HorseScale {
  if (preference !== "auto") return preference;
  if (variant === "compare") {
    return width >= 118 && height >= 23 ? "hero" : "compact";
  }
  return width >= 58 && height >= 23 ? "hero" : "compact";
}

function nextScale(
  scale: HorseScalePreference,
  width: number,
  height: number,
  variant: HorseStudyVariant,
): HorseScale {
  const resolved = resolveScale(scale, width, height, variant);
  return resolved === "hero" ? "compact" : "hero";
}

function nextVariant(variant: HorseStudyVariant): HorseStudyVariant {
  if (variant === "original") return "riderless";
  return variant === "riderless" ? "compare" : "original";
}

function nextWordmark(wordmark: HorseWordmark): HorseWordmark {
  return wordmark === "none" ? "spaced-lower" : "none";
}

interface HorseStudyArt {
  readonly lines: readonly string[];
  readonly artHeight: number;
}

function singleStudy(
  frameIndex: number,
  scale: HorseScale,
  variant: HorseVariant,
  wordmark: HorseWordmark,
): HorseStudyArt {
  const rawArt = horseFrame(frameIndex, scale, variant);
  const art = variant === "riderless"
    ? applyWordmark(rawArt, scale, wordmark, frameIndex)
    : rawArt;
  const artWidth = visibleLength(art[0] ?? "");
  const plate = modulo(frameIndex, HORSE_FRAME_COUNT) + 1;
  return {
    artHeight: art.length,
    lines: [
      panelTop(artWidth, `PLATE ${plate.toString().padStart(2, "0")} OF ${HORSE_FRAME_COUNT}`),
      ...art.map((line) => `│${line}│`),
      panelBottom(artWidth),
    ],
  };
}

function comparisonStudy(
  frameIndex: number,
  scale: HorseScale,
  wordmark: HorseWordmark,
): HorseStudyArt {
  const original = horseFrame(frameIndex, scale, "original");
  const riderless = applyWordmark(
    horseFrame(frameIndex, scale, "riderless"),
    scale,
    wordmark,
    frameIndex,
  );
  const artWidth = visibleLength(original[0] ?? "");
  const artHeight = Math.max(original.length, riderless.length);
  const padOriginal = artHeight - original.length;
  const padRiderless = artHeight - riderless.length;
  const rows = Array.from({ length: artHeight }, (_, index) => {
    const originalLine = index < padOriginal
      ? " ".repeat(artWidth)
      : original[index - padOriginal]!;
    const riderlessLine = index < padRiderless
      ? " ".repeat(artWidth)
      : riderless[index - padRiderless]!;
    return `│${originalLine}│  │${riderlessLine}│`;
  });
  return {
    artHeight,
    lines: [
      `${panelTop(artWidth, "ORIGINAL")}  ${panelTop(artWidth, "RIDERLESS")}`,
      ...rows,
      `${panelBottom(artWidth)}  ${panelBottom(artWidth)}`,
    ],
  };
}

function applyWordmark(
  art: readonly string[],
  scale: HorseScale,
  wordmark: HorseWordmark,
  frameIndex: number,
): readonly string[] {
  if (wordmark === "none") return art;
  const rowIndex = scale === "compact" ? 3 : 5;
  const center = (scale === "compact" ? 15 : 23) + 2;
  const text = wordmarkText(wordmark, frameIndex);
  const glyphs = Array.from(text);
  const start = center - Math.floor(glyphs.length / 2);
  return art.map((line, index) => {
    if (index !== rowIndex) return line;
    const cells = Array.from(line);
    cells.splice(start, glyphs.length, ...glyphs);
    return cells.join("");
  });
}

function wordmarkText(wordmark: HorseWordmark, frameIndex: number): string {
  void frameIndex;
  if (wordmark === "spaced-lower") return "b a r b a r o";
  return "";
}

function wordmarkLabel(wordmark: HorseWordmark): string {
  return wordmarkText(wordmark, 0);
}

function panelTop(width: number, label: string): string {
  const prefix = `─ ${label} `;
  return `┌${prefix}${"─".repeat(Math.max(0, width - visibleLength(prefix)))}┐`;
}

function panelBottom(width: number): string {
  return `└${"─".repeat(width)}┘`;
}

function renderTooSmall(
  width: number,
  height: number,
  requiredWidth: number,
  requiredHeight: number,
): string {
  const lines = [
    "",
    "B A R B A R O",
    "",
    `Horse study needs ${requiredWidth}×${requiredHeight}.`,
    `This terminal is ${width}×${height}.`,
  ];
  return lines
    .slice(0, height)
    .map((line) => center(line, width))
    .join("\n");
}

function center(text: string, width: number): string {
  const plainLength = visibleLength(text);
  if (plainLength >= width) return truncateStyled(text, width);
  return `${" ".repeat(Math.floor((width - plainLength) / 2))}${text}`;
}

function visibleLength(text: string): number {
  return Array.from(text.replace(/\u001b\[[0-9;]*m/gu, "")).length;
}

function truncateStyled(text: string, width: number): string {
  const plain = text.replace(/\u001b\[[0-9;]*m/gu, "");
  return Array.from(plain).slice(0, width).join("");
}

function styled(text: string, kind: "bold" | "dim", enabled: boolean): string {
  if (!enabled) return text;
  return `${kind === "bold" ? "\u001b[1m" : "\u001b[2m"}${text}\u001b[0m`;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function dimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
