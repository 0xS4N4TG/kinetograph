# Vendored crates

Each crate here keeps its own upstream licence, not Kinetograph's (`LICENSE.md`): its licence files are in its
directory, and our changes to it are under the same licence as the crate. `stylo` is MPL-2.0 (`stylo/LICENSE`); the
others are MIT OR Apache-2.0. `blitz-dom/LICENSE-*` and `stylo/LICENSE` were added on 2026-10-16 from upstream
(`DioxusLabs/blitz`, mozilla.org/MPL/2.0); the crates.io packages did not include them.

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

## stylo 0.22.0

- Upstream: crates.io `stylo` 0.22.0 (`servo/stylo`, `style`, commit `34d25f741765a0bdb894f8271852e633299352d8` per
  `.cargo_vcs_info.json`). Licence: MPL-2.0. Wired in by `[patch.crates-io]` in the root `Cargo.toml`, so `blitz-dom` and
  `kinetograph-dom` build against it. The unchanged copy was committed first.
- Changed files: `stylesheets/rule_parser.rs`, `values/specified/length.rs`, `properties/shorthands.rs`,
  `properties/shorthands.toml` (container queries), `properties/properties.mako.rs` (`same_values_except`).

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

### The change (`same_values_except`)

`ComputedValues::same_values_except(other, except)` is new: whether two styles have the same value for every longhand
but the ones in `except` (each style struct the two share is skipped), the same custom properties, flags, writing mode,
zoom, pseudo-element and visited style. It is generated over the longhands, so it cannot miss one. A restyle can make
a new `ComputedValues` with the same values as the old one (a sibling restyled by invalidation), and pointers cannot
tell those apart: `kinetograph-dom`'s `IslandCache` uses it to check that an edit to an island changed nothing but
transforms before it paints the island from its last paint (`paint::repaint_transforms`).

### Dropping the patch

Remove `vendor/stylo`, its `[patch.crates-io]` entry and this section once a stylo release parses `@container` without
Gecko, and `same_values_except` has a stand-in (it can move to `kinetograph-dom` over the style structs' `PartialEq`).
The changes are small enough to offer upstream.

## blitz-dom 0.3.0-beta.3

- Upstream: crates.io `blitz-dom` 0.3.0-beta.3 (`DioxusLabs/blitz`, `packages/blitz-dom`, commit
  `5890fab3afb087d8c0c5b0652b8b635f161f3a13` per `.cargo_vcs_info.json`). Licence: MIT OR Apache-2.0. Wired in by
  `[patch.crates-io]` in the root `Cargo.toml`. The unchanged copy was committed first.
- Changed files: `src/stylo.rs`, `src/resolve.rs`, `src/node/node.rs` (container queries), `src/layout/inline.rs`
  (floats), `src/layout/table.rs` and `src/layout/mod.rs` (tables), `src/mutator.rs` (style attribute edits).

### Why

`TElement::query_container_size` returned `Default::default()` ("FIXME: Implement container queries"), so no
`@container` condition could be evaluated.

Floats: inline layout beside a float broke each line at the width of the slot beside the float and let an unbreakable
word that is wider than the slot overflow it ("TODO: revert state and retry layout if a line doesn't fit"), so a line
that CSS 2.1 9.5 moves down past the float stayed beside it, on top of it. Parley's layout height is the sum of the
lines' heights, so the gap above a line that had moved down was not part of its block's height.

Tables: a table is a taffy grid of its cells, so its `auto` columns shared the free width equally where CSS (and
Chrome) share it in proportion to what the columns want; a `<caption>` was dropped; a cell's `height` was its content
box's and fixed the cell's size, so a rowspan cell did not fill its rows.

### The change (tables)

- `auto_columns` (`table.rs`): the automatic layout algorithm gives the grid fixed column widths. Each cell is measured
  for its min-content and max-content width (`compute_child_layout`, `ContentSize`); a column needs the widest min and
  wants the widest max, a cell or `<col>` width fixes what it wants (never below what it needs), a spanning cell asks
  the columns without a width for what they lack. The table's width (given, or shrink-to-fit) is shared: the minimums
  if it is no more, the minimums plus an equal share of each range if it is less than the wants, the wants plus the
  rest in proportion to the wants (to the columns without a given width first) if it is more; a percentage column
  takes its share first. Fixed layout is untouched.
- Captions (`measure_captions`, `place_captions`): taken out of the cells, laid out as blocks as wide as the grid
  box above (`caption-side: top`) and below it, the grid's cells and row tracks moved down by those above, the table's
  box taking them in (`TableContext::captions`, `caption_extent`).
- A cell's `height` is its border box's and a minimum for its row (`min_size`), as in Chrome; the cell's own `width`
  and `height` no longer size it (`SizingMode::ContentSize`), its column and row do.
- `TableCell::colspan` and `TableContext::is_fixed` are new fields. A caption wider than the grid widens the table
  (`caption_min_width`). Not done: percentage widths on `<col>`.

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

### The change (style attribute edits)

- `DocumentMutator::set_attribute` gave every attribute change `RestyleHint::restyle_subtree()` on the element and on
  its parent ("TODO: make this fine grained"), so a new `style` on the root of an island restyled every element in it,
  selector matching included. For `style` it now leaves those two hints out: the element is restyled by the
  `RESTYLE_STYLE_ATTRIBUTE` it already got (Stylo puts the new declarations in its rule node and cascades again), its
  children when what they inherit changes (Stylo's own rule), and the snapshot taken before the change still
  invalidates the selectors that read the attribute (`[style*=...]`, and the siblings and descendants they reach). The
  element still gets `ALL_DAMAGE`. Other attributes are as before. `IslandCache` (motion-blur samples, the renders of one
  frame) edits styles this way; `crates/dom/tests/samples.rs` checks an edited document against a fresh one.

### Dropping the patch

Remove `vendor/blitz-dom`, its `[patch.crates-io]` entry and this section once Blitz answers container queries and
restyles a `style` change on its own element. The changes are small enough to offer upstream.

## rive (rive-rs and the C++ it builds)

- Upstream: `rive-app/rive-rs` at `3d26aa1c3865260e5ef9751ad0172dcc197ff8eb` (the crate, `rive-rs/`), whose submodules
  are `rive-app/rive-runtime` at `24c6b5db10b458f179a8abc3b91d2824ecd96042` (`rive-cpp/`: `include/` and `src/`),
  `rive-app/harfbuzz` branch `rive_10.1.0` (`harfbuzz/src`, pruned to the files `harfbuzz.cc` includes),
  `rive-app/yoga` branch `rive_changes_v2_0_1_1` (`yoga/yoga`) and `Tehreer/SheenBidi` v2.6 (`sheenbidi/`). Licences:
  MIT for rive-rs, rive-runtime and yoga, harfbuzz's own `COPYING` (MIT-style) and SheenBidi's Apache-2.0; each is kept
  beside its code. About 14 MB.
- Not wired in by `[patch.crates-io]`: the crate is not on crates.io. `crates/rive` depends on it by path.

### Why vendored and not a git dependency

The repository's own submodule pins do not build together: `rive-runtime` at the pinned commit calls
`hb_face_create_or_fail`, which the pinned `harfbuzz` submodule does not have (it wants the `rive_10.1.0` branch), and
`layout` (on by default) needs a `submodules/yoga` that `.gitmodules` does not list. The mirror's last commit is July
2025. A git dependency cannot choose other submodule revisions, so the matching sources are copied here.

### The changes

- `rive-rs/Cargo.toml`: no `vello` feature or dependencies (it builds against an old Vello; `crates/rive` implements
  the renderer trait itself), `publish = false`.
- `rive-rs/build.rs`: the C++ is found beside the crate (`../rive-cpp`, `../yoga`, `../harfbuzz`, `../sheenbidi`).
- `rive-rs/src/artboard/mod.rs`, `src/state_machine/mod.rs`: `'_` on five returned types, so that `cargo clippy -D warnings`
  at the workspace root passes.
- `rive-rs/src/lib.rs`, `src/file.rs`: no `vello` module; `Error` implements `core::error::Error`.
- `rive-rs/src/ffi.cpp`, `src/ffi.rs`, `src/scene.rs`: `Scene::view_transform` (the runtime's `computeAlignment` with
  the artboard's bounds, for any fit and alignment; the crate only had `contain`, centred).

### Dropping the patch

Replace this directory with a dependency on a rive-rs release that builds, if one appears.
