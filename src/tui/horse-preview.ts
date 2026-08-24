#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  HORSE_FRAME_COUNT,
  HORSE_FRAME_INTERVAL_MS,
  renderHorseStudyFrame,
  runHorseStudy,
  type HorseScalePreference,
  type HorseStudyVariant,
  type HorseWordmark,
} from "./horse.js";

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options.once) {
    process.stdout.write(
      `${renderHorseStudyFrame({
        width: process.stdout.columns ?? 80,
        height: process.stdout.rows ?? 24,
        frameIndex: options.frame,
        scale: options.scale,
        variant: options.variant,
        wordmark: options.wordmark,
        style: false,
        interactive: false,
      })}\n`,
    );
    return 0;
  }
  await runHorseStudy({
    intervalMs: options.intervalMs,
    scale: options.scale,
    variant: options.variant,
    wordmark: options.wordmark,
    style: process.env["NO_COLOR"] === undefined,
  });
  return 0;
}

interface PreviewOptions {
  readonly once: boolean;
  readonly frame: number;
  readonly intervalMs: number;
  readonly scale: HorseScalePreference;
  readonly variant: HorseStudyVariant;
  readonly wordmark: HorseWordmark;
}

function parseOptions(argv: readonly string[]): PreviewOptions {
  let once = false;
  let frame = 0;
  let intervalMs = HORSE_FRAME_INTERVAL_MS;
  let scale: HorseScalePreference = "compact";
  let variant: HorseStudyVariant = "compare";
  let wordmark: HorseWordmark = "spaced-lower";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--once") {
      once = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`Missing value for ${argument}`);
    if (argument === "--frame") {
      frame = integer(value, "--frame", 0, HORSE_FRAME_COUNT - 1);
    } else if (argument === "--fps") {
      const fps = integer(value, "--fps", 1, 30);
      intervalMs = Math.round(1_000 / fps);
    } else if (argument === "--scale") {
      if (value !== "auto" && value !== "hero" && value !== "compact") {
        throw new TypeError("--scale must be auto, hero, or compact");
      }
      scale = value;
    } else if (argument === "--variant") {
      if (value !== "original" && value !== "riderless" && value !== "compare") {
        throw new TypeError("--variant must be original, riderless, or compare");
      }
      variant = value;
    } else if (argument === "--wordmark") {
      if (
        value !== "none"
        && value !== "spaced-lower"
      ) {
        throw new TypeError(
          "--wordmark must be none or spaced-lower",
        );
      }
      wordmark = value;
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
    index += 1;
  }
  return { once, frame, intervalMs, scale, variant, wordmark };
}

function integer(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

const invokedPath = process.argv[1];
if (invokedPath && isExecutedModule(import.meta.url, invokedPath)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

function isExecutedModule(moduleUrl: string, invokedPath: string): boolean {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath);
  } catch {
    return fileURLToPath(moduleUrl) === invokedPath;
  }
}
