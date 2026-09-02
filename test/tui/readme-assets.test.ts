import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  brandedHeroHorseFrame,
  HORSE_STANDARD_FRAME_INDEX,
} from "../../src/tui/horse.js";

const projectRoot = process.cwd();
const assetsDirectory = join(projectRoot, "docs", "assets");
const generatorUrl = pathToFileURL(
  join(projectRoot, "scripts", "generate-readme-assets.mjs"),
).href;

interface ReadmeAssetGenerator {
  readonly escapeXml: (value: string) => string;
  readonly renderReadmeAssets: () => Promise<Map<string, Buffer>>;
  readonly sanitizeSnapshot: (content: string) => string[];
}

test("checked-in README assets are byte-identical to their sources", async () => {
  const generator = (await import(generatorUrl)) as ReadmeAssetGenerator;
  const expected = await generator.renderReadmeAssets();
  assert.deepEqual([...expected.keys()], ["barbaro-horse.svg", "tui-once.svg"]);
  for (const [name, bytes] of expected) {
    assert.deepEqual(
      await readFile(join(assetsDirectory, name)),
      bytes,
      `${name} must be regenerated with npm run docs:assets`,
    );
  }
});

test("the GitHub hero is one literal full-size terminal horse still", async () => {
  const generator = (await import(generatorUrl)) as ReadmeAssetGenerator;
  const svg = await readFile(join(assetsDirectory, "barbaro-horse.svg"), "utf8");

  assert.match(svg, /width="826" height="414" viewBox="0 0 826 414"/u);
  assert.match(svg, /font-size="24px"/u);
  assert.match(svg, /font-weight="400"/u);
  assert.match(svg, /fill="#e2e2e2"/u);
  assert.match(
    svg,
    /font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"/u,
  );
  assert.match(svg, /<rect width="826" height="414" fill="#1e212b"\/>/u);
  assert.equal(svg.match(/b a r b a r o/gu)?.length, 1);
  assert.doesNotMatch(svg, /B A R B A R O/u);
  const rows = brandedHeroHorseFrame(HORSE_STANDARD_FRAME_INDEX);
  assert.equal(svg.match(/<tspan /gu)?.length, rows.length);
  for (const [rowIndex, row] of rows.entries()) {
    assert.ok(
      svg.includes(
        `x="12" y="${27 + rowIndex * 30}" textLength="812" lengthAdjust="spacing">${generator.escapeXml(row)}</tspan>`,
      ),
      `hero row ${rowIndex + 1} must match the TUI verbatim`,
    );
  }
  assert.doesNotMatch(svg, /PLATE|data-frame|@keyframes|animation|<animate/u);
  assert.match(svg, /barbaro\.readme-assets\.v4/u);
  assert.match(svg, /source-sha256=[a-f0-9]{64}/u);
  assert.ok(Buffer.byteLength(svg) < 64 * 1024, "hero stays lightweight for GitHub");

  assert.doesNotMatch(
    svg.replace("http://www.w3.org/2000/svg", ""),
    /<!DOCTYPE|<!ENTITY|<script|<animate|<foreignObject|<image|\bon[a-z]+=|https?:\/\//iu,
  );
  assert.doesNotMatch(svg, /\b(?:href|xlink:href)=/iu);
  assert.doesNotMatch(svg, /url\(/iu);
});

test("the snapshot SVG is the literal fixture without invented product chrome", async () => {
  const generator = (await import(generatorUrl)) as ReadmeAssetGenerator;
  const snapshot = await readFile(join(assetsDirectory, "tui-once.svg"), "utf8");
  const fixture = await readFile(
    join(
      projectRoot,
      "test",
      "tui",
      "fixtures",
      "dashboard-once-still-64x28.txt",
    ),
    "utf8",
  );
  const rows = generator.sanitizeSnapshot(fixture);

  assert.match(snapshot, /<title id="title">[^<]+<\/title>/u);
  assert.match(snapshot, /<desc id="desc">[^<]+<\/desc>/u);
  assert.match(snapshot, /barbaro\.readme-assets\.v4/u);
  assert.match(snapshot, /source-sha256=[a-f0-9]{64}/u);
  assert.equal(snapshot.match(/<tspan /gu)?.length, rows.length);
  for (const row of rows) {
    assert.ok(
      snapshot.includes(`>${generator.escapeXml(row)}</tspan>`),
      "snapshot must contain every fixture row verbatim",
    );
  }
  assert.match(snapshot, /Project · barbaro · root \/workspace\/demo/u);
  assert.doesNotMatch(snapshot, /B A R B A R O|BARBARO TUI · --ONCE|#39d2c0/u);
  assert.doesNotMatch(snapshot, /<line\b|\brx=|stroke=/u);
  assert.doesNotMatch(
    snapshot.replace("http://www.w3.org/2000/svg", ""),
    /<!DOCTYPE|<!ENTITY|<script|<animate|<foreignObject|<image|\bon[a-z]+=|https?:\/\/|\/Users\/|\/home\/|\/private\/|[A-Z]:\\|\\Users\\|\u001b/iu,
  );
  assert.equal(generator.escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
});

test("README embeds only the checked-in docs assets", async () => {
  const readme = await readFile(join(projectRoot, "README.md"), "utf8");
  for (const asset of [
    "docs/assets/barbaro-horse.svg",
    "docs/assets/tui-once.svg",
  ]) {
    const tag = new RegExp(
      `<img[^>]+src="${asset.replaceAll(".", "\\.")}"[^>]*>`,
      "u",
    ).exec(readme)?.[0];
    assert.notEqual(tag, undefined, `README must embed ${asset}`);
    assert.match(tag!, /\balt="[^"]+"/u, `${asset} must have useful alt text`);
  }
  assert.doesNotMatch(readme, /tui-contact-strip\.svg/u);
  assert.doesNotMatch(readme, /\.github\/assets\//u);
});

test("packaging refuses dirty or stale README asset inputs", async () => {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  ) as { readonly scripts?: Readonly<Record<string, string>> };
  assert.equal(
    manifest.scripts?.prepack,
    "npm run check:release && node scripts/prepare-package.mjs && npm run build:package && node scripts/generate-readme-assets.mjs --check",
  );
  const preparation = await readFile(
    join(projectRoot, "scripts", "prepare-package.mjs"),
    "utf8",
  );
  assert.match(preparation, /"scripts\/generate-readme-assets\.mjs"/u);
  assert.match(preparation, /"scripts\/check-release-version\.mjs"/u);
  assert.match(
    preparation,
    /"test\/tui\/fixtures\/dashboard-once-still-64x28\.txt"/u,
  );
  const attributes = await readFile(join(projectRoot, ".gitattributes"), "utf8");
  assert.match(attributes, /test\/tui\/fixtures\/\*\.txt text eol=lf/u);
  assert.match(attributes, /docs\/assets\/\*\.svg text eol=lf/u);
  assert.doesNotMatch(attributes, /docs\/assets\/\*\.gif/u);
});
