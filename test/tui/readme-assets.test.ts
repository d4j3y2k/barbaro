import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { frameBottom, frameLine, frameTop } from "../../src/tui/cells.js";
import {
  brandedHeroHorseFrame,
  HORSE_FRAME_COUNT,
  HORSE_FRAME_INTERVAL_MS,
} from "../../src/tui/horse.js";
import { stripRows64 } from "../../src/tui/strip.js";

const projectRoot = process.cwd();
const assetsDirectory = join(projectRoot, "docs", "assets");
const generatorUrl = pathToFileURL(
  join(projectRoot, "scripts", "generate-readme-assets.mjs"),
).href;

interface ReadmeAssetGenerator {
  readonly escapeXml: (value: string) => string;
  readonly renderReadmeAssets: () => Promise<Map<string, Buffer>>;
}

test("checked-in README assets are byte-identical to their sources", async () => {
  const generator = (await import(generatorUrl)) as ReadmeAssetGenerator;
  const expected = await generator.renderReadmeAssets();
  assert.deepEqual([...expected.keys()], [
    "barbaro-horse.svg",
    "tui-contact-strip.svg",
    "tui-once.svg",
  ]);
  for (const [name, bytes] of expected) {
    assert.deepEqual(
      await readFile(join(assetsDirectory, name)),
      bytes,
      `${name} must be regenerated with npm run docs:assets`,
    );
  }
});

test("the GitHub hero is the literal full-size terminal gallop", async () => {
  const generator = (await import(generatorUrl)) as ReadmeAssetGenerator;
  const svg = await readFile(join(assetsDirectory, "barbaro-horse.svg"), "utf8");

  assert.match(svg, /width="826" height="452" viewBox="0 0 826 452"/u);
  assert.match(svg, /font-size: 24px/u);
  assert.match(svg, /font-weight: 400/u);
  assert.match(svg, /color: #e2e2e2/u);
  assert.match(
    svg,
    /font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace/u,
  );
  assert.match(svg, /<rect width="826" height="452" fill="#1e212b"\/>/u);
  assert.equal(svg.match(/data-frame="\d+"/gu)?.length, HORSE_FRAME_COUNT);
  assert.equal(svg.match(/b a r b a r o/gu)?.length, HORSE_FRAME_COUNT);
  assert.doesNotMatch(svg, /B A R B A R O/u);

  for (let index = 0; index < HORSE_FRAME_COUNT; index += 1) {
    const plate = `${index + 1}`.padStart(2, "0");
    const match = new RegExp(
      `<g id="plate-${plate}"[^>]*>([\\s\\S]*?)<\\/g>`,
      "u",
    ).exec(svg);
    assert.notEqual(match, null, `plate ${plate} must exist`);
    const group = match![1]!;
    const rows = [
      frameTop(`PLATE ${plate} OF ${HORSE_FRAME_COUNT}`, 58),
      ...brandedHeroHorseFrame(index).map((row) => frameLine(row, 56)),
      frameBottom(58),
    ];
    assert.equal(group.match(/<tspan /gu)?.length, rows.length);
    for (const [rowIndex, row] of rows.entries()) {
      assert.ok(
        group.includes(
          `x="12" y="${27 + rowIndex * 30}" textLength="812" lengthAdjust="spacing">${generator.escapeXml(row)}</tspan>`,
        ),
        `plate ${plate} row ${rowIndex + 1} must match the TUI verbatim`,
      );
    }
  }

  assert.match(
    svg,
    new RegExp(
      `animation: gallop ${HORSE_FRAME_COUNT * HORSE_FRAME_INTERVAL_MS * 3}ms step-end 1 forwards`,
      "u",
    ),
  );
  assert.match(svg, /96\.969697% \{ transform: translateY\(-4520px\); \}/u);
  assert.match(svg, /100% \{ transform: translateY\(-1356px\); \}/u);
  assert.match(svg, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(svg, /animation: none/u);
  assert.match(svg, /barbaro\.readme-assets\.v2/u);
  assert.match(svg, /source-sha256=[a-f0-9]{64}/u);
  assert.ok(Buffer.byteLength(svg) < 64 * 1024, "hero stays lightweight for GitHub");

  assert.doesNotMatch(
    svg.replace("http://www.w3.org/2000/svg", ""),
    /<!DOCTYPE|<!ENTITY|<script|<foreignObject|<image|\bon[a-z]+=|https?:\/\//iu,
  );
  assert.doesNotMatch(svg, /\b(?:href|xlink:href)=/iu);
  assert.doesNotMatch(svg, /url\((?!#viewport\))/iu);
});

test("static README SVGs are accessible, local, and source-shaped", async () => {
  const generator = (await import(generatorUrl)) as ReadmeAssetGenerator;
  const contactStrip = await readFile(
    join(assetsDirectory, "tui-contact-strip.svg"),
    "utf8",
  );
  const snapshot = await readFile(join(assetsDirectory, "tui-once.svg"), "utf8");

  for (const [name, svg] of [
    ["contact strip", contactStrip],
    ["snapshot", snapshot],
  ] as const) {
    assert.match(svg, /<title id="title">[^<]+<\/title>/u, name);
    assert.match(svg, /<desc id="desc">[^<]+<\/desc>/u, name);
    assert.match(svg, /barbaro\.readme-assets\.v2/u, name);
    assert.match(svg, /source-sha256=[a-f0-9]{64}/u, name);
    assert.doesNotMatch(
      svg.replace("http://www.w3.org/2000/svg", ""),
      /<!DOCTYPE|<!ENTITY|<script|<animate|<foreignObject|<image|\bon[a-z]+=|https?:\/\//iu,
      name,
    );
  }

  for (const row of stripRows64()) {
    assert.ok(
      contactStrip.includes(`>${generator.escapeXml(row)}</tspan>`),
      "contact strip must contain every normative strip row verbatim",
    );
  }
  assert.match(snapshot, /BARBARO TUI · --ONCE · 64×28/u);
  assert.match(snapshot, /Project · barbaro · root \/workspace\/demo/u);
  assert.doesNotMatch(
    snapshot,
    /\/Users\/|\/home\/|\/private\/|[A-Z]:\\|\\Users\\|\u001b/iu,
  );
  assert.equal(generator.escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
});

test("README embeds only the checked-in docs assets", async () => {
  const readme = await readFile(join(projectRoot, "README.md"), "utf8");
  for (const asset of [
    "docs/assets/barbaro-horse.svg",
    "docs/assets/tui-contact-strip.svg",
    "docs/assets/tui-once.svg",
  ]) {
    const tag = new RegExp(
      `<img[^>]+src="${asset.replaceAll(".", "\\.")}"[^>]*>`,
      "u",
    ).exec(readme)?.[0];
    assert.notEqual(tag, undefined, `README must embed ${asset}`);
    assert.match(tag!, /\balt="[^"]+"/u, `${asset} must have useful alt text`);
  }
  assert.doesNotMatch(readme, /\.github\/assets\//u);
});

test("packaging refuses dirty or stale README asset inputs", async () => {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  ) as { readonly scripts?: Readonly<Record<string, string>> };
  assert.equal(
    manifest.scripts?.prepack,
    "node scripts/prepare-package.mjs && npm run build:package && node scripts/generate-readme-assets.mjs --check",
  );
  const preparation = await readFile(
    join(projectRoot, "scripts", "prepare-package.mjs"),
    "utf8",
  );
  assert.match(preparation, /"scripts\/generate-readme-assets\.mjs"/u);
  assert.match(
    preparation,
    /"test\/tui\/fixtures\/dashboard-once-strip-64x28\.txt"/u,
  );
  const attributes = await readFile(join(projectRoot, ".gitattributes"), "utf8");
  assert.match(attributes, /test\/tui\/fixtures\/\*\.txt text eol=lf/u);
  assert.match(attributes, /docs\/assets\/\*\.svg text eol=lf/u);
  assert.doesNotMatch(attributes, /docs\/assets\/\*\.gif/u);
});
