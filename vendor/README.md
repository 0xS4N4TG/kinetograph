# Vendored crates

Each crate keeps its own upstream licence, not Kinetograph's (`LICENSE.md`). Our changes to it are under the same licence. `stylo` is MPL-2.0; the others are MIT OR Apache-2.0. `blitz-dom/LICENSE-*` and `stylo/LICENSE` were added from upstream on 2026-10-16, because the crates.io packages did not include them.

The crates are wired in by `[patch.crates-io]` in the root `Cargo.toml`. `rive` is not on crates.io, so `crates/rive` depends on it by path.

## Updating a copy

1. Copy the new release in. Leave out cargo's `.cargo-ok` marker and keep the licence files.
2. Commit it unchanged. Take the version and commit from `.cargo_vcs_info.json`, and update this file.
3. Reapply the changes below in a separate `fix(vendor)` commit, so that diff is the whole change.

## fontique 0.12.0

Upstream: crates.io `fontique` 0.12.0 (`linebender/parley`, commit `6e1143dda817360dd3a2a64f9133c6e5dfabd881`). Licence: Apache-2.0 OR MIT. A project registers a variable font under one weight (`Inter:800`). fontique sets the `wght` axis to the requested weight, but a browser clamps it to the `@font-face` weight.

- `src/font.rs`: `FontInfoOverride` has a new `pin_weight: bool`. When set, `synthesis()` takes the `wght` value from the face, and sets `embolden` if the request is more than 200 heavier.
- `crates/dom/src/fonts.rs` (our code): registers every project font with the flag.

Drop when fontique can hold an axis at the face's weight.

## stylo 0.22.0

Upstream: crates.io `stylo` 0.22.0 (`servo/stylo`, commit `34d25f741765a0bdb894f8271852e633299352d8`). Licence: MPL-2.0. The Servo build does not parse `@container`, the `container` shorthand or the `cq*` units, because they are `cfg(feature = "gecko")`.

- `stylesheets/rule_parser.rs`: `@container` takes the `layout.container-queries.enabled` pref.
- `values/specified/length.rs`: the six `cq*` units take the same pref.
- `properties/shorthands.rs`, `properties/shorthands.toml`: the `container` shorthand uses `servo_pref` instead of `engine = "gecko"`.
- `properties/longhands.toml`: `text-anchor`, `shape-rendering`, `paint-order`, `clip-rule` and `dominant-baseline` lose `engine = "gecko"`, so the Servo build parses and computes them; the SVG painter reads them from the cascade (`paint/svg/serialize.rs`).
- `properties/properties.mako.rs`: new `ComputedValues::same_values_except(other, except)`, used by `IslandCache` to repaint transform-only edits.
- `properties/longhands.toml`: `offset-path`, `offset-distance`, `offset-rotate`, `offset-anchor` and `offset-position` lose `engine = "gecko"` / `servo_pref`, so the Servo build parses and computes them; `crates/dom/src/motion.rs` follows the path.

Drop when a stylo release parses `@container` without Gecko and computes the SVG properties above in its Servo build. `same_values_except` can move to `kinetograph-dom`.

## blitz-dom 0.3.0-beta.3

Upstream: crates.io `blitz-dom` 0.3.0-beta.3 (`DioxusLabs/blitz`, commit `5890fab3afb087d8c0c5b0652b8b635f161f3a13`). Licence: MIT OR Apache-2.0. Blitz answered no container query, mis-laid inline text beside floats, shared table width equally between columns, and restyled whole subtrees on a `style` edit.

- `src/stylo.rs`, `src/node/node.rs`: `query_container_size` returns the content box of the node's last layout (`Node::container_size`).
- `src/resolve.rs`: `resolve` loops, restyling nodes whose size differs from what their queries saw, up to `MAX_CONTAINER_PASSES` (4). Not done: `contain: inline-size`.
- `src/layout/inline.rs`: a line wider than a float-narrowed slot is reverted (`BreakLines::revert_to`) and laid out again below; block height is at least its last line's bottom.
- `src/layout/table.rs`: `auto_columns` implements the automatic table layout algorithm; captions are laid out as blocks above or below the grid.
- `src/layout/table.rs`, `src/layout/mod.rs`: a cell's `height` is its border box's and a minimum for its row. Not done: percentage widths on `<col>`.
- `src/mutator.rs`: a `style` change no longer adds `restyle_subtree()` on the element and its parent.
- `src/layout/inline.rs`: an inline box measured in `ComputeSize` mode that comes back without baselines is laid out in `PerformLayout` mode to get them, because taffy's size-only cache hit keeps no baselines.

Drop when Blitz answers container queries and restyles a `style` change on its own element, and when taffy's measure cache keeps baselines.

## parley 0.12.0

Upstream: crates.io `parley` 0.12.0 (`linebender/parley`). Licence: Apache-2.0 OR MIT. An inline box (an `inline-block`) ahead of any text ignored `white-space: nowrap` on its container, because the line breaker took the wrap mode only from text atoms, so a nowrap row of inline-blocks wrapped.

- `src/layout/line_break.rs`: `BreakLines::new` starts the line's wrap mode from the root style.

Only this file differs from upstream 0.12.0 (5 added lines). Upstream it, then drop the copy when Parley's inline boxes follow the container's `text-wrap-mode`.

## rive (rive-rs and the C++ it builds)

Upstream: `rive-app/rive-rs` at `3d26aa1c3865260e5ef9751ad0172dcc197ff8eb`, with its submodules `rive-app/rive-runtime` at `24c6b5db10b458f179a8abc3b91d2824ecd96042`, `rive-app/harfbuzz` branch `rive_10.1.0` (pruned to the files `harfbuzz.cc` includes), `rive-app/yoga` branch `rive_changes_v2_0_1_1` and `Tehreer/SheenBidi` v2.6. Licences: MIT (rive-rs, rive-runtime, yoga), harfbuzz's `COPYING`, Apache-2.0 (SheenBidi). About 14 MB. The repository's own submodule pins do not build together, and a git dependency cannot choose other submodule revisions. So the matching sources are copied here.

- `rive-rs/Cargo.toml`: no `vello` feature or dependencies; `publish = false`.
- `rive-rs/build.rs`: finds the C++ beside the crate (`../rive-cpp`, `../yoga`, `../harfbuzz`, `../sheenbidi`).
- `rive-rs/src/artboard/mod.rs`, `src/state_machine/mod.rs`: `'_` on five returned types, so `cargo clippy -D warnings` passes.
- `rive-rs/src/lib.rs`, `src/file.rs`: no `vello` module; `Error` implements `core::error::Error`.
- `rive-rs/src/ffi.cpp`, `src/ffi.rs`, `src/scene.rs`: new `Scene::view_transform` for any fit and alignment.

Drop when a rive-rs release builds. Then replace this directory with a dependency on it.

## libmv (with Ceres and Eigen)

Blender's motion tracker, as Blender 4.5 LTS ships it (tag `v4.5.9`, commit `8bf95cbd38d1456c94e9d751f3804eea4d5b137b`). Built by `crates/libmv-sys` with the `cc` crate; no CMake.

- `libmv/`: `intern/libmv/libmv/{autotrack,base,image,logging,multiview,numeric,tracking}` without `*_test.cc`, and `simple_pipeline/detect.{h,cc}` (the feature detector behind Blender's Detect Features; the rest of `simple_pipeline` is the camera solver, not used yet). `detect.cc` is built with `LIBMV_NO_FAST_DETECTOR`, so the FAST detector, which needs `third_party/fast`, is left out; Blender's operator uses Harris. Licence: MIT (`libmv/LICENSE`, from the standalone libmv repository; every file carries the same notice). Blender's C API around it (`intern/libmv/intern/*`, `libmv-capi.h`) is GPL-2.0-or-later and is **not** copied; `crates/libmv-sys/csrc/kt_libmv.cc` is our own C API over the same C++ classes.
- `ceres/`: `extern/ceres` (Ceres Solver 2.2.0, identical to upstream's tag), without the CUDA `.cc` files, tests, benchmarks and the template generator scripts, plus `internal/ceres/miniglog` from upstream 2.2.0 (Blender links real glog instead). Licence: BSD-3-Clause (`ceres/LICENSE`); `include/ceres/internal/fixed_array.h` and `memory.h` come from Abseil under Apache-2.0, whose text is in the same LICENSE file. `config/ceres/internal/config.h` and `export.h` are ours (CMake generates them upstream): no sparse back ends, no LAPACK, no CUDA, static linking.
- `eigen/Eigen`: `extern/Eigen3/Eigen` (Eigen 3.4.0). Licence: MPL-2.0 (`eigen/COPYING.MPL2`, from upstream 3.4.0); the MKL/LAPACKE glue headers (not used) and `Geometry/AlignedBox.h` also carry BSD notices (`eigen/COPYING.BSD`), and `EigenSolver.h`/`RealSchur.h` are JAMA-derived public domain. Built with `EIGEN_MPL2_ONLY`, so a non-MPL-2.0 header fails the build.

Not changed. To update, copy the same directories from a newer Blender LTS tag, rerun the tracker's repeatability test (`cargo test --release -p kinetograph-track`; a changed golden needs `KT_UPDATE_GOLDENS=1` and a reason) and the Blender parity script against that Blender (`node scripts/track-parity/compare.mjs`).
