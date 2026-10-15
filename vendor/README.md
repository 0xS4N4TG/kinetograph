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

## vello 0.11.0

- Upstream: crates.io `vello` 0.11.0 (same commit as `vello_shaders`). Licence: Apache-2.0 OR MIT, both kept.
- Wired in by `[patch.crates-io]` in the root `Cargo.toml`. The unchanged copy was committed first.
- Changed file: `src/wgpu_engine.rs`.

### Why

`WgpuEngine::run_recording` began a compute pass for each dispatch, about 17 for each `render_to_texture`, and S04
draws about 20 pages a frame: some 340 Metal compute encoders a frame, each with its creation cost on the CPU.

### The change

Consecutive dispatches share one compute pass (`open_pass`). The pass is ended before anything that puts a command on
the encoder itself (a buffer clear, a texture copy, a draw, a download), and before a bind group is made while a clear
is pending, since making one can clear a buffer. Dispatches in one pass are ordered, and storage writes of one are
seen by the next, so the output is the same: all 34 test scenes render byte-identically. The `wgpu-profiler` code in
that file is adjusted but not built (the feature is off).

### Dropping the patch

Remove `vendor/vello`, its `[patch.crates-io]` entry and this section once a vello release does the same.

The same file's `render.rs` also keeps the MSAA mask tables: `make_mask_lut_16` was computed again for every
`render_to_texture` (a twentieth of a frame's CPU time on a busy scene), and is now computed once (`OnceLock`).

## stylo 0.22.0

- Upstream: crates.io `stylo` 0.22.0 (`servo/stylo`, `style`, commit `34d25f741765a0bdb894f8271852e633299352d8` per
  `.cargo_vcs_info.json`). Licence: MPL-2.0. Wired in by `[patch.crates-io]` in the root `Cargo.toml`, so `blitz-dom` and
  `kinetograph-dom` build against it. The unchanged copy was committed first.
- Changed files: `stylesheets/rule_parser.rs`, `values/specified/length.rs`, `properties/shorthands.rs`,
  `properties/shorthands.toml`.

### Why

Stylo's Servo build parses the `container-type` and `container-name` properties (behind the
`layout.container-queries.enabled` pref) but not `@container`, the `container` shorthand or the container length units
(`cqw`, `cqh`, `cqi`, `cqb`, `cqmin`, `cqmax`): those are `cfg(feature = "gecko")`. The matching code
(`stylesheets/container_rule.rs`, the stylist, the cascade) is built in both and asks the embedder for a container's size
through `TElement::query_container_size`.

### The change

The three gates take the same pref the properties use: `@container` in `AtRuleType::from_name`, the six `cq*` units in
`LengthUnit::from_name`, and the `container` shorthand (its `engine = "gecko"` line becomes `servo_pref`, and its
`pub mod container` loses the `cfg`). `kinetograph-dom` switches the pref on (`document::enable_css_features`).

### Dropping the patch

Remove `vendor/stylo`, its `[patch.crates-io]` entry and this section once a stylo release parses `@container` without
Gecko. The change is small enough to offer upstream.

## blitz-dom 0.3.0-beta.3

- Upstream: crates.io `blitz-dom` 0.3.0-beta.3 (`DioxusLabs/blitz`, `packages/blitz-dom`, commit
  `5890fab3afb087d8c0c5b0652b8b635f161f3a13` per `.cargo_vcs_info.json`). Licence: MIT OR Apache-2.0. Wired in by
  `[patch.crates-io]` in the root `Cargo.toml`. The unchanged copy was committed first.
- Changed files: `src/stylo.rs`, `src/resolve.rs`, `src/node/node.rs` (container queries), `src/layout/inline.rs`
  (floats).

### Why

`TElement::query_container_size` returned `Default::default()` ("FIXME: Implement container queries"), so no
`@container` condition could be evaluated.

Floats: inline layout beside a float broke each line at the width of the slot beside the float and let an unbreakable
word that is wider than the slot overflow it ("TODO: revert state and retry layout if a line doesn't fit"), so a line
that CSS 2.1 9.5 moves down past the float stayed beside it, on top of it. Parley's layout height is the sum of the
lines' heights, so the gap above a line that had moved down was not part of its block's height.

### The change (floats)

- `inline.rs`: each line's slot and the state at its start (or at the last float placed in it) are remembered; when a
  line's content is wider than a float-narrowed slot, the breaker is reverted (`BreakLines::revert_to`) and the line is
  laid out again in the next slot below that is wide enough, or below the last float. A line that fits is untouched.
- The block's height is at least the bottom of its last line box (`block_max_coord`), not only Parley's sum.

### The change (container queries)

- `query_container_size` returns the content box of the node's last layout (`Node::container_size`), and remembers it in
  `Node::container_size_seen`.
- `BaseDocument::resolve` is now `resolve_pass` plus a loop: after a pass, each node whose content box is not the size
  its queries saw has its subtree restyled (`RestyleHint::restyle_subtree`) and the tree is laid out again, until none
  changes or `MAX_CONTAINER_PASSES` (4) is reached. A document without a container query pays for one scan of the node
  slab. The first style pass sees empty containers; the loop corrects it.
- Not done: `contain: inline-size` does not make a container's own width ignore its content (an `inline-block` container
  without a width is as wide as its text, where Chrome has it 0 wide).

### Dropping the patch

Remove `vendor/blitz-dom`, its `[patch.crates-io]` entry and this section once Blitz answers container queries. The change
is small enough to offer upstream.
