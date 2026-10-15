# Vendored crates

## vello_shaders 0.11.0

- Upstream: crates.io `vello_shaders` 0.11.0 (`linebender/vello`, `research/vello_shaders`, commit
  `f3000c8d9e7a9c7e6abb09b9587238bf8b4860ff` per `.cargo_vcs_info.json`). Licence: Apache-2.0 OR MIT; both licence
  files are kept.
- Wired in by `[patch.crates-io]` in the root `Cargo.toml`, so `vello` builds against it. `cargo tree -i
  vello_shaders` shows the path source.
- The only file left out is cargo's `.cargo-ok` extraction marker. The copy was committed unchanged first, so the
  `fix(vendor)` commit on top of it is the whole change.
- Changed file: `shader/fine.wgsl`. Nothing else differs from the release.

### Why

Vello keeps one image atlas inside each `vello::Renderer` and reuses it across renders, so an image's `atlas_offset`
(an integer position in the atlas, in texels) depends on which images that renderer drew before. `fine.wgsl` added
the offset to the f32 sample position before splitting it into a texel and a fraction:

```wgsl
atlas_uv = atlas_uv + image.atlas_offset - vec2(0.5);
...
let uv_frac = fract(atlas_uv);
```

An f32 near 1000 has about 2^-14 of resolution, so the fraction (the bilinear weight) and, close to a texel edge, the
texel itself changed with the offset. The same image drew up to a level apart (and, close to texel edges, drew from a
neighbouring texel) depending on what the renderer had drawn before: `renderer_reuse` (a scene after another) and
Lottie frames drawn in order on one renderer differed from a fresh renderer (#12).

### The change

Each quality path now works in image-local coordinates (the position after `extend_mode`) and adds the integer
offset only to texel indices, which are exact in f32.

- `IMAGE_QUALITY_MEDIUM` (bilinear, vello's default): the position is no longer offset before `fract` and `floor`.
  The clamp is against `0 .. extents - 1` instead of `atlas_offset .. atlas_max`, and `atlas_offset` is added to
  `uv_quad`, the four texel indices, after `floor` and `ceil`.
- `IMAGE_QUALITY_LOW` (nearest): same clamp; `atlas_offset` is added to the truncated texel index. The weights do not
  exist here, but the texel chosen could still differ across a texel edge, so it is changed too.
- `IMAGE_QUALITY_HIGH` (bicubic): `bicubic_sample` took the offset position and took `fract` of it. It now takes the
  image-local position, and builds its `coords` as `atlas_offset + floor(p - 0.5) + 0.5`, so the 16 taps are
  `atlas_offset + floor(p - 0.5) + {-1, 0, 1, 2}` (exact integers) and the fraction is `fract(p - 0.5)`. Its 16
  `textureLoad` lines are unchanged. `fract(p + 0.5)` and `fract(p - 0.5)` are the same number; the latter is used so
  the fraction and the taps come from the same `floor`.

With `atlas_offset == 0` every path is the old arithmetic (only the order of the rounding steps in the bicubic
fraction differs), and all three clamp to the same texels as before. Nothing else in the shader reads `atlas_offset`:
`atlas_max` is still used for the bicubic clamp.

CPU check (f32, numpy, 200 000 random positions in a 200-texel image): with offsets 7, 1000 and 3000 the old arithmetic
gave fractions up to 1 apart from the offset-0 result, and a different texel on 8 to 19 positions in 200 000; the new
arithmetic gave exactly the offset-0 fractions and texels at every offset. Build-time check: `vello_shaders`'s
`build.rs` parses and validates every shader with naga, and `cargo build` passes.

### Dropping the patch

Remove `vendor/vello_shaders`, the `[patch.crates-io]` entry and this file once a `vello_shaders` release does the
same. The change is small enough to offer upstream as a pull request against `research/vello_shaders/shader/fine.wgsl`.

## fontique 0.12.0

- Upstream: crates.io `fontique` 0.12.0 (`linebender/parley`, `fontique`, commit
  `6e1143dda817360dd3a2a64f9133c6e5dfabd881` per `.cargo_vcs_info.json`). Licence: Apache-2.0 OR MIT; both licence files
  are kept.
- Wired in by `[patch.crates-io]` in the root `Cargo.toml`, so `parley` (and Blitz's text) build against it. The copy was
  committed unchanged first, so the commit on top of it is the whole change.
- Changed file: `src/font.rs`. Nothing else differs from the release.

### Why

A project registers a font file under one weight (`fontKey`: `Inter:800`). Google's files for such a weight are
variable fonts (a `wght` axis from 100 to 900, default 400). fontique's `FontInfo::synthesis` sets the axis to the
*requested* weight, so text at `font-weight: 400` shows the 400 instance of a file registered as 800. A browser does
not: `@font-face { font-weight: 800; src: url(inter-800.woff2) }` clamps the used `wght` to the descriptor, so the same
text is drawn at 800 (and gets the faux bold if it asks for 600 or more over a lighter face). The papercut project
asks Inter for 400, 800 and 900 with only the 800 file registered.

### The change

`FontInfoOverride` has a new field `pin_weight: bool` (default false); `FontInfo` remembers it. When set,
`synthesis()` takes the weight for the `wght` axis from the face (the override's weight) instead of the request, and
sets `embolden` when the request is more than 200 heavier than the face, as it already does for fonts without the
axis. Fonts without a `wght` axis and every font registered without the flag behave as before. `kinetograph-dom`
registers every project font with the flag (`crates/dom/src/fonts.rs`).

### Dropping the patch

Remove `vendor/fontique`, the `[patch.crates-io]` entry and this section once fontique can hold an axis at the face's
weight. The change is small enough to offer upstream.
