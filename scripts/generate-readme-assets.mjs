#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "docs", "assets");
const fixturePath = join(
  projectRoot,
  "test",
  "tui",
  "fixtures",
  "dashboard-once-strip-64x28.txt",
);
const GENERATOR_VERSION = "barbaro.readme-assets.v2";
const HERO_WIDTH = 826;
const HERO_HEIGHT = 452;
const HERO_LINE_HEIGHT = 30;
const HERO_FIRST_BASELINE = 27;
const HERO_TEXT_LENGTH = 812;
const HERO_REST_FRAME_INDEX = 3;
const HERO_PASSES = 3;

export async function renderReadmeAssets() {
  const [horseModule, stripModule, cellsModule] = await Promise.all([
    import(pathToFileURL(join(projectRoot, "dist", "src", "tui", "horse.js")).href),
    import(pathToFileURL(join(projectRoot, "dist", "src", "tui", "strip.js")).href),
    import(pathToFileURL(join(projectRoot, "dist", "src", "tui", "cells.js")).href),
  ]);
  const {
    brandedHeroHorseFrame,
    HORSE_FRAME_COUNT,
    HORSE_FRAME_INTERVAL_MS,
  } = horseModule;
  const { stripRows64 } = stripModule;
  const { frameBottom, frameLine, frameTop } = cellsModule;
  const frames = Array.from({ length: HORSE_FRAME_COUNT }, (_, index) =>
    brandedHeroHorseFrame(index),
  );
  validateFrames(frames, HORSE_FRAME_COUNT);

  const strip = stripRows64();
  const snapshot = sanitizeSnapshot(await readFile(fixturePath, "utf8"));
  const sourceHash = createHash("sha256")
    .update(GENERATOR_VERSION)
    .update("\0")
    .update(JSON.stringify(frames))
    .update("\0")
    .update(strip.join("\n"))
    .update("\0")
    .update(snapshot.join("\n"))
    .digest("hex");

  return new Map([
    [
      "barbaro-horse.svg",
      Buffer.from(
        renderHeroSvg({
          frames,
          intervalMs: HORSE_FRAME_INTERVAL_MS,
          sourceHash,
          frameBottom,
          frameLine,
          frameTop,
        }),
      ),
    ],
    [
      "tui-contact-strip.svg",
      Buffer.from(
        renderTerminalSvg({
          title: "Barbaro motion-study contact strip",
          description:
            "The deterministic F01, F04, F07, and F10 riderless horse phases used by a working TUI snapshot.",
          heading: "THE HORSE IN MOTION · STATIC CONTACT STRIP",
          lines: strip,
          width: 720,
          sourceHash,
        }),
      ),
    ],
    [
      "tui-once.svg",
      Buffer.from(
        renderTerminalSvg({
          title: "Barbaro plain TUI snapshot",
          description:
            "A plain non-ANSI 64 by 28 Barbaro workstream snapshot with the deterministic four-phase horse strip.",
          heading: "BARBARO TUI · --ONCE · 64×28",
          lines: snapshot,
          width: 820,
          sourceHash,
        }),
      ),
    ],
  ]);
}

function validateFrames(frames, expectedCount) {
  if (frames.length !== 11 || frames.length !== expectedCount) {
    throw new Error(`expected 11 hero frames, received ${frames.length}`);
  }
  const glyphs = /^[ █▓▒░▀▄baro]+$/u;
  for (const [frameIndex, frame] of frames.entries()) {
    if (frame.length !== 13) {
      throw new Error(`frame ${frameIndex + 1} must contain 13 rows`);
    }
    for (const [rowIndex, row] of frame.entries()) {
      if (Array.from(row).length !== 56 || !glyphs.test(row)) {
        throw new Error(
          `frame ${frameIndex + 1} row ${rowIndex + 1} has invalid geometry or glyphs`,
        );
      }
    }
    if (!frame.some((row) => row.includes("b a r b a r o"))) {
      throw new Error(`frame ${frameIndex + 1} is missing the Barbaro wordmark`);
    }
  }
}

function sanitizeSnapshot(content) {
  if (!content.endsWith("\n")) {
    throw new Error("snapshot fixture must end with a newline");
  }
  let projectRows = 0;
  const lines = content
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const rootMarker = " · root ";
      const markerIndex = line.indexOf(rootMarker);
      if (line.startsWith("Project · ") && markerIndex !== -1) {
        projectRows += 1;
        return `${line.slice(0, markerIndex + rootMarker.length)}/workspace/demo`.padEnd(64);
      }
      return line;
    });
  if (
    projectRows !== 1 ||
    lines.length !== 28 ||
    lines.some((line) => Array.from(line).length !== 64)
  ) {
    throw new Error("snapshot fixture must contain one 64×28 project-root row");
  }
  return lines;
}

function renderHeroSvg({
  frames,
  intervalMs,
  sourceHash,
  frameBottom,
  frameLine,
  frameTop,
}) {
  const frameRows = frames.map((frame, index) => [
    frameTop(
      `PLATE ${(index + 1).toString().padStart(2, "0")} OF ${frames.length}`,
      58,
    ),
    ...frame.map((row) => frameLine(row, 56)),
    frameBottom(58),
  ]);
  const keyframes = renderHeroKeyframes(frames.length);
  const plates = frameRows
    .map((rows, frameIndex) => {
      const textRows = rows
        .map(
          (row, rowIndex) =>
            `        <tspan x="12" y="${HERO_FIRST_BASELINE + rowIndex * HERO_LINE_HEIGHT}" textLength="${HERO_TEXT_LENGTH}" lengthAdjust="spacing">${escapeXml(row)}</tspan>`,
        )
        .join("\n");
      return `      <g id="plate-${(frameIndex + 1).toString().padStart(2, "0")}" data-frame="${frameIndex + 1}" transform="translate(0 ${frameIndex * HERO_HEIGHT})">
        <text xml:space="preserve" aria-hidden="true">
${textRows}
        </text>
      </g>`;
    })
    .join("\n");
  const duration = frames.length * intervalMs * HERO_PASSES;
  const restOffset = HERO_REST_FRAME_INDEX * HERO_HEIGHT;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/generate-readme-assets.mjs. Do not hand-edit. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${HERO_WIDTH}" height="${HERO_HEIGHT}" viewBox="0 0 ${HERO_WIDTH} ${HERO_HEIGHT}" role="img" aria-labelledby="title desc">
  <title id="title">Barbaro terminal horse</title>
  <desc id="desc">The full-size branded riderless terminal horse gallops through eleven boxed motion-study plates, then rests on plate four.</desc>
  <metadata>${GENERATOR_VERSION} source-sha256=${sourceHash}</metadata>
  <style>
    .motion {
      animation: gallop ${duration}ms step-end 1 forwards;
      color: #e2e2e2;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
      font-size: 24px;
      font-variant-ligatures: none;
      font-weight: 400;
    }
    @keyframes gallop {
${keyframes}
    }
    @media (prefers-reduced-motion: reduce) {
      .motion {
        animation: none;
        transform: translateY(-${restOffset}px);
      }
    }
  </style>
  <rect width="${HERO_WIDTH}" height="${HERO_HEIGHT}" fill="#1e212b"/>
  <defs>
    <clipPath id="viewport"><rect width="${HERO_WIDTH}" height="${HERO_HEIGHT}"/></clipPath>
  </defs>
  <g clip-path="url(#viewport)" fill="currentColor">
    <g class="motion">
${plates}
    </g>
  </g>
</svg>
`;
}

function renderHeroKeyframes(frameCount) {
  const steps = frameCount * HERO_PASSES;
  const lines = [];
  for (let step = 0; step < steps; step += 1) {
    const frameIndex = step % frameCount;
    lines.push(
      `      ${formatNumber((step / steps) * 100)}% { transform: translateY(-${frameIndex * HERO_HEIGHT}px); }`,
    );
  }
  lines.push(
    `      100% { transform: translateY(-${HERO_REST_FRAME_INDEX * HERO_HEIGHT}px); }`,
  );
  return lines.join("\n");
}

function formatNumber(value) {
  return Number(value.toFixed(6)).toString();
}

function renderTerminalSvg({ title, description, heading, lines, width, sourceHash }) {
  const lineHeight = 17;
  const top = 78;
  const height = top + lines.length * lineHeight + 36;
  const textRows = lines
    .map(
      (line, index) =>
        `    <tspan x="${width / 2}" y="${top + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/generate-readme-assets.mjs. Do not hand-edit. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <metadata>${GENERATOR_VERSION} source-sha256=${sourceHash}</metadata>
  <rect width="${width}" height="${height}" rx="12" fill="#0d1117"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="11" fill="none" stroke="#30363d"/>
  <text x="24" y="34" fill="#e6edf3" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace" font-size="16" font-weight="700">B A R B A R O</text>
  <text x="24" y="55" fill="#39d2c0" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace" font-size="12">${escapeXml(heading)}</text>
  <line x1="24" y1="64" x2="${width - 24}" y2="64" stroke="#30363d"/>
  <text xml:space="preserve" text-anchor="middle" fill="#e6edf3" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace" font-size="13">
${textRows}
  </text>
</svg>
`;
}

export function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function main(args) {
  const check = args.length === 1 && args[0] === "--check";
  if ((!check && args.length !== 0) || (check && args.length !== 1)) {
    throw new Error("usage: node scripts/generate-readme-assets.mjs [--check]");
  }
  const assets = await renderReadmeAssets();
  if (check) {
    const stale = [];
    for (const [name, expected] of assets) {
      const path = join(outputDirectory, name);
      let actual;
      try {
        actual = await readFile(path);
      } catch (error) {
        if (error?.code === "ENOENT") {
          stale.push(name);
          continue;
        }
        throw error;
      }
      if (!actual.equals(expected)) stale.push(name);
    }
    let actualNames = [];
    try {
      actualNames = await readdir(outputDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const unexpected = actualNames.filter((name) => !assets.has(name));
    if (stale.length > 0 || unexpected.length > 0) {
      const details = [
        ...(stale.length === 0 ? [] : [`stale: ${stale.join(", ")}`]),
        ...(unexpected.length === 0
          ? []
          : [`remove unexpected entries explicitly: ${unexpected.join(", ")}`]),
      ];
      throw new Error(
        `README assets are not current (${details.join("; ")}). ` +
          "Run npm run docs:assets to regenerate stale files.",
      );
    }
    process.stdout.write(`README assets are current (${assets.size}).\n`);
    return;
  }
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, bytes] of assets) {
    await writeFile(join(outputDirectory, name), bytes);
  }
  process.stdout.write(`Generated ${assets.size} README assets in docs/assets/.\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main(process.argv.slice(2));
}
