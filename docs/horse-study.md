# Terminal horse study

Barbaro's terminal horse adapts Eadweard Muybridge's public-domain 1878
*Sallie Gardner at a Gallop* frames into precomputed `█▓▒░` shading. The
dashboard may animate the sequence while shown work is active; static product
views use one representative full-horse pose.

The source checkout includes a comparison tool for maintainers and visual
reviewers:

```sh
npm run build
npm run study:horse
```

The preview shows the original source treatment beside the per-frame riderless
derivative. Press Space to pause, use the left and right arrows to inspect
frames, `s` to switch scale, `v` to cycle original/riderless/comparison views,
`w` to toggle the body wordmark, and `q` to exit.

For a noninteractive comparison:

```sh
npm run study:horse -- \
  --once --frame 6 --scale compact --variant compare
```

The installed npm package also ships the preview runtime:

```sh
npm --prefix "$(npm root --global)/barbaro" run study:horse -- \
  --once --frame 6 --scale compact --variant compare
```

The generated frame source records its public-domain provenance and SHA-256.
Rider removal is stored as per-frame source-pixel mask data in the generator,
not as hand-edited terminal glyphs. Regeneration is an optional source-checkout
task requiring Python and Pillow; neither is a Barbaro runtime dependency.

From a built source checkout, regenerate or verify the GitHub assets with:

```sh
npm run docs:assets
npm run docs:assets:check
```

The README hero is intentionally a single unboxed frame. It does not invent a
motion-study header or other chrome that the product does not render.
