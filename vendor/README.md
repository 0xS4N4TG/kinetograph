# Vendored crates

Each crate keeps its own upstream licence, not Kinetograph's (`LICENSE.md`). Our changes to it are under the same licence. `stylo` is MPL-2.0; the others are MIT OR Apache-2.0. `blitz-dom/LICENSE-*` and `stylo/LICENSE` were added from upstream on 2026-10-16, because the crates.io packages did not include them.

The crates are wired in by `[patch.crates-io]` in the root `Cargo.toml`. `rive` is not on crates.io, so `crates/rive` depends on it by path.

## Updating a copy

1. Copy the new release in. Leave out cargo's `.cargo-ok` marker and keep the licence files.
2. Commit it unchanged. Take the version and commit from `.cargo_vcs_info.json`, and update this file.
3. Reapply the changes below in a separate `fix(vendor)` commit, so that diff is the whole change.

## vello_shaders 0.11.0

Upstream: crates.io `vello_shaders` 0.11.0 (`linebender/vello`, commit `f3000c8d9e7a9c7e6abb09b9587238bf8b4860ff`). Licence: Apache-2.0 OR MIT. An image's `atlas_offset` depends on what the renderer drew before, and adding it to an f32 sample position lost precision. The same image drew differently on a reused renderer (#12).

- `shader/fine.wgsl`, bilinear (`IMAGE_QUALITY_MEDIUM`): the position stays image-local, the clamp is `0 .. extents - 1`, and `atlas_offset` is added to the four texel indices.
- `shader/fine.wgsl`, nearest (`IMAGE_QUALITY_LOW`): same clamp; `atlas_offset` is added to the truncated texel index.
- `shader/fine.wgsl`, bicubic (`IMAGE_QUALITY_HIGH`): `bicubic_sample` takes the image-local position and builds `coords` as `atlas_offset + floor(p - 0.5) + 0.5`.

Drop when a `vello_shaders` release does the same.

## fontique 0.12.0

Upstream: crates.io `fontique` 0.12.0 (`linebender/parley`, commit `6e1143dda817360dd3a2a64f9133c6e5dfabd881`). Licence: Apache-2.0 OR MIT. A project registers a variable font under one weight (`Inter:800`). fontique sets the `wght` axis to the requested weight, but a browser clamps it to the `@font-face` weight.

- `src/font.rs`: `FontInfoOverride` has a new `pin_weight: bool`. When set, `synthesis()` takes the `wght` value from the face, and sets `embolden` if the request is more than 200 heavier.
- `crates/dom/src/fonts.rs` (our code): registers every project font with the flag.

Drop when fontique can hold an axis at the face's weight.

## vello 0.11.0

Upstream: crates.io `vello` 0.11.0 (same commit as `vello_shaders`). Licence: Apache-2.0 OR MIT. `run_recording` began a compute pass per dispatch, about 340 Metal compute encoders a frame on S04.

- `src/wgpu_engine.rs`: consecutive dispatches share one compute pass (`open_pass`), ended before anything else uses the encoder. All 34 test scenes render byte-identically.
- `src/render.rs`: `make_mask_lut_16` is computed once (`OnceLock`) instead of per `render_to_texture`.
- `src/lib.rs`: `Renderer::unregister_texture` calls `evict_image` (see `vello_encoding`).

Drop when a vello release does the same.

## vello_encoding 0.11.0

Upstream: crates.io `vello_encoding` 0.11.0 (same commit as `vello_shaders`). Licence: Apache-2.0 OR MIT. Canvas 2D shadows and filters are new pictures every frame, and Vello kept each in its atlas for two more renders. The atlas filled up and Vello dropped some without an error.

- `src/image_cache.rs`: new `ImageCache::evict` and `ImageCache::resident_atlas`, with tests.
- `src/resolve.rs`: new `Resolver::evict_image` frees an image's atlas place at once; `Scene::draw_image` images are not touched.
- `src/resolve.rs`: `Resolver::resolve` keeps the atlas for a solid-paths-only scene when images are resident. Before, a later scene drew a resident image blank (seen at `render --concurrency 4`).

Drop when `unregister_texture` frees the atlas place itself and a solid-paths-only resolve keeps the atlas.

## stylo 0.22.0

Upstream: crates.io `stylo` 0.22.0 (`servo/stylo`, commit `34d25f741765a0bdb894f8271852e633299352d8`). Licence: MPL-2.0. The Servo build does not parse `@container`, the `container` shorthand or the `cq*` units, because they are `cfg(feature = "gecko")`.

- `stylesheets/rule_parser.rs`: `@container` takes the `layout.container-queries.enabled` pref.
- `values/specified/length.rs`: the six `cq*` units take the same pref.
- `properties/shorthands.rs`, `properties/shorthands.toml`: the `container` shorthand uses `servo_pref` instead of `engine = "gecko"`.
- `properties/properties.mako.rs`: new `ComputedValues::same_values_except(other, except)`, used by `IslandCache` to repaint transform-only edits.

Drop when a stylo release parses `@container` without Gecko. `same_values_except` can move to `kinetograph-dom`.

## blitz-dom 0.3.0-beta.3

Upstream: crates.io `blitz-dom` 0.3.0-beta.3 (`DioxusLabs/blitz`, commit `5890fab3afb087d8c0c5b0652b8b635f161f3a13`). Licence: MIT OR Apache-2.0. Blitz answered no container query, mis-laid inline text beside floats, shared table width equally between columns, and restyled whole subtrees on a `style` edit.

- `src/stylo.rs`, `src/node/node.rs`: `query_container_size` returns the content box of the node's last layout (`Node::container_size`).
- `src/resolve.rs`: `resolve` loops, restyling nodes whose size differs from what their queries saw, up to `MAX_CONTAINER_PASSES` (4). Not done: `contain: inline-size`.
- `src/layout/inline.rs`: a line wider than a float-narrowed slot is reverted (`BreakLines::revert_to`) and laid out again below; block height is at least its last line's bottom.
- `src/layout/table.rs`: `auto_columns` implements the automatic table layout algorithm; captions are laid out as blocks above or below the grid.
- `src/layout/table.rs`, `src/layout/mod.rs`: a cell's `height` is its border box's and a minimum for its row. Not done: percentage widths on `<col>`.
- `src/mutator.rs`: a `style` change no longer adds `restyle_subtree()` on the element and its parent.

Drop when Blitz answers container queries and restyles a `style` change on its own element.

## rive (rive-rs and the C++ it builds)

Upstream: `rive-app/rive-rs` at `3d26aa1c3865260e5ef9751ad0172dcc197ff8eb`, with its submodules `rive-app/rive-runtime` at `24c6b5db10b458f179a8abc3b91d2824ecd96042`, `rive-app/harfbuzz` branch `rive_10.1.0` (pruned to the files `harfbuzz.cc` includes), `rive-app/yoga` branch `rive_changes_v2_0_1_1` and `Tehreer/SheenBidi` v2.6. Licences: MIT (rive-rs, rive-runtime, yoga), harfbuzz's `COPYING`, Apache-2.0 (SheenBidi). About 14 MB. The repository's own submodule pins do not build together, and a git dependency cannot choose other submodule revisions. So the matching sources are copied here.

- `rive-rs/Cargo.toml`: no `vello` feature or dependencies; `publish = false`.
- `rive-rs/build.rs`: finds the C++ beside the crate (`../rive-cpp`, `../yoga`, `../harfbuzz`, `../sheenbidi`).
- `rive-rs/src/artboard/mod.rs`, `src/state_machine/mod.rs`: `'_` on five returned types, so `cargo clippy -D warnings` passes.
- `rive-rs/src/lib.rs`, `src/file.rs`: no `vello` module; `Error` implements `core::error::Error`.
- `rive-rs/src/ffi.cpp`, `src/ffi.rs`, `src/scene.rs`: new `Scene::view_transform` for any fit and alignment.

Drop when a rive-rs release builds. Then replace this directory with a dependency on it.
