# The full engine (Phase 6)

Decided 2026-10-15 (`DECISION_RENDERING_CRITICAL.md` §6, approved by the user the same day): compat mode stops
parsing CSS in TypeScript. A DOM island is handed to Rust, styled by Stylo, laid out by taffy and Parley through
Blitz's DOM (`blitz-dom` 0.3.0-beta.3, which uses the same Parley 0.12 and taffy 0.15 as the core), and painted by our
own compositor. Blitz's painter (`blitz-paint`) is not used. No Chrome in the render path, ever; Chrome for Testing
may be used only by tests and `doctor --compare` to make reference images.

Success, measured on the M4:
- The tiny-agent episode 13 papercut project (`$KINETOGRAPH_CORPUS/tiny-agent/episodes/13-mods/papercut/src/index.ts`,
  `ModsPapercut`, 988 frames) renders with every frame native, today 0 of 988.
- Each frame looks like Chrome's: `doctor --compare` against Chrome references within a per-pixel threshold (text and
  anti-aliasing differ; byte equality is not the goal).
- `cargo test`, clippy, fmt and every npm suite pass; `bench` does not regress against `feat/remotion-compat`.

## 1. Pipeline

```
React tree (DOM host elements + native kg-* ones)
  emit (packages/react/src/emit.ts), per frame: each outermost run of DOM nodes is an island
    TS  (stream 4): DomNode tree → IslandRequest JSON: tags, attributes, style as CSS text, stylesheets, time
    addon renderDomIsland(json)  (crates/node/src/dom.rs)
      Rust (stream 1): IslandRequest → blitz_dom::BaseDocument; fonts, images; resolve(time): Stylo + layout
      Rust (stream 2): paint(doc) → scene layers in CSS paint order; core gains what boxes need
      Rust (stream 3): <svg> subtrees and filter graphs → scene layers and a filterGraph effect
    → IslandOutput JSON: layers, unsupported, camera
  frame loop, render: unchanged (frames with unsupported items still go to Chrome until the fallback is removed)
```

Readback (`getBoundingClientRect`, `offsetWidth`, `getComputedStyle`, `ResizeObserver`) goes through the same
document: `domLayoutBoxes(json)` in the addon (stream 1) answers for the island's current host tree; the TS DOM shim
(stream 4) calls it lazily and caches by tree generation.

## 2. The contract

`crates/dom/src/request.rs` is the contract and is owned by the orchestrator: streams may add optional fields;
changing an existing one goes through the orchestrator. In short:

- `IslandRequest { root: DomNode, stylesheets, viewport, fonts, baseDir, publicDir?, time, path }`.
- `DomNode` = `element { tag, path, attrs, style, children }` | `text { text }` | `native { path, width?, height? }`.
  `style` is CSS declaration text (`width: 10px; opacity: 0.5`), serialized by TS with React's rules.
- `IslandOutput { layers: LayerJson[], unsupported: Unsupported[], camera }`, the shape of `IslandResult`.
  A `{"type": "native", "path", "x", "y", "width", "height"}` layer marks where a native element's layers go.
- Layer ids: derived from the node's explicit `id` attribute if it is a valid layer id, else its `path`, with the
  suffixes the painter needs (`.bg`, `.border`, `.text`, …), unique per island.
- Addon functions (stream 1): `renderDomIsland(requestJson: string): string` and
  `domLayoutBoxes(requestJson: string): string` → `{ [path]: { x, y, width, height, rect: {x,y,width,height},
  client: {width,height}, scroll: {width,height} } }` (offset box in island coordinates; `rect` is the transformed
  bounding box, as `getBoundingClientRect` gives).

## 3. Streams and ownership

Each stream works on its own branch off `feat/full-engine`, in its own worktree, and commits often (Conventional
Commits). The orchestrator merges them into `feat/full-engine`.

| Stream | Branch | Owns |
|---|---|---|
| 1 front | `engine/front` | `crates/dom/src/{lib.rs,document.rs,fonts.rs,net.rs,readback.rs}` and new non-paint modules; `crates/dom/Cargo.toml`; `crates/node/src/dom.rs` and the addon exports; CSS animation clock; UA stylesheet |
| 2 paint | `engine/paint` | `crates/dom/src/paint/**` except `svg/`; core additions for boxes: 2D/3D matrices per layer, per-element `perspective`/`preserve-3d`/`backface-visibility`, tiled and sized background images, `background-blend-mode`, `mix-blend-mode` and `isolation` on any layer, per-side borders and border styles, `border-image`, inset and outer shadows of any shape, `text-shadow`, every CSS filter function, `backdrop-filter`, `mask-*`, every `clip-path`, glyph runs from Blitz's Parley layouts |
| 3 svg | `engine/svg` | `crates/dom/src/paint/svg/**`; core additions for SVG: stroke dashes, caps, joins, miter limit, markers, patterns, SVG masks and clip paths, and the `filterGraph` effect (all `fe*` primitives); the lookup stream 2 calls for `filter: url(#id)` |
| 4 runtime | `engine/runtime` | `packages/**`: DomNode → IslandRequest (React style serialization, `className`, `<style>`, `.css` imports as text), switch `mapDomIsland` to the addon, readback DOM shim and the `useLayoutEffect` measure loop, frame-driven CSS animation time, web APIs (`Image`, `fetch` of project files, `requestAnimationFrame`, `matchMedia`, `window.inner*`), doctor wiring, the episode 13 corpus harness |
| 5 perf | `perf/gpu-passes` (from `perf/gpu-pass-timing`) | compositor internals only: one to-linear pass per Vello page, merged blends of layers that do not overlap, closed-form inset shadows for rect shapes, anything else `bench --passes` shows; output byte-identical |

Shared files (`crates/core/src/scene.rs`, `compositor.rs`, `docs/SCENE.md`, `crates/node/src/lib.rs`): add new
items in new places (new enum variants, new functions), do not reorder or reformat existing ones. The orchestrator
resolves merge conflicts.

## 4. Painting (stream 2)

Walk the laid-out document in CSS paint order (stacking contexts, `z-index`, positioned, floats, inline), as CSS 2.1
Appendix E says. Each box becomes the fewest layers that draw it: a group for a stacking context (opacity, transform,
filter, blend, isolation, clip, mask), and inside it background, border, content, outline. Text comes from the
Parley layouts Blitz made, so lines break where Blitz measured. Images and video keep the core's image and video
layers. Anything not drawn as Chrome would draw it is an `Unsupported` item, never silently wrong.

## 5. SVG (stream 3)

An `<svg>` element is a replaced box; its subtree is painted as path layers (usvg may be used to resolve shapes,
`use`, gradients, patterns, text to paths), with Stylo's computed values for presentation properties. Filters
become one `filterGraph` effect: the primitives, their inputs (`SourceGraphic`, `SourceAlpha`, named results),
`filterUnits`/`primitiveUnits`, and regions. Seeded turbulence and displacement already exist as effects; reuse their
shaders.

## 6. Rules for every stream

- Rendering is a pure function of (project, frame). No system fonts, no network, no wall clock.
- Reimplement from the specs (CSS, SVG, Filter Effects, Compositing); do not copy Chromium or Remotion source.
- Every feature gets a test: unit tests on the CPU side, and a golden for anything drawn (`crates/core/tests/golden`
  or a new `crates/dom/tests/golden`), checked by eye against Chrome's rendering of the same HTML.
- Build with the rustup toolchain: `export PATH=$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH`.
- Disk is tight (about 35 GB free): all worktrees share `CARGO_TARGET_DIR=<main checkout>/target`; never
  `cargo clean`.

## 7. Stream 1 notes (front: Blitz document, fonts, files, animations, readback)

What `engine/front` built. Code: `crates/dom/src/{document,fonts,net,ua,inline,transform,readback}.rs`,
`crates/node/src/dom.rs`, the vendored `vendor/fontique`, and `crates/dom/tools/`. Tests: `crates/dom/tests/*.rs` and
the island tests in `crates/node/test/cpu.test.cjs`.

### 7.1 API

```rust
// kinetograph_dom::document
pub fn resolve(request: &IslandRequest) -> Result<IslandDocument, BuildError>;  // build + style + layout at request.time
pub fn build(request: &IslandRequest) -> Result<(IslandDocument, Arc<LocalFiles>), BuildError>;  // DOM only
pub struct IslandDocument {
    pub doc: blitz_dom::BaseDocument,            // styled and laid out
    pub paths: BTreeMap<String, NodeId>,         // host-tree path -> node, elements and native placeholders
    pub node_paths: HashMap<NodeId, String>,
    pub container: NodeId,                       // <div data-kg-island>, the viewport-sized containing box
    pub root: Option<NodeId>,                    // the node of request.root
    pub missing: Vec<String>,                    // files that could not be read, with why
}
pub const PATH_ATTR: &str = "data-kg-path";      // every element carries its path in this attribute

// kinetograph_dom::readback
pub fn layout_boxes(island: &IslandDocument) -> BTreeMap<String, ElementBox>;   // domLayoutBoxes
pub fn computed_style(island: &IslandDocument, path: &str, properties: &[String]) -> Option<Vec<String>>;
// kinetograph_dom::inline
pub fn fragments(doc: &BaseDocument, id: NodeId) -> Option<Vec<Fragment>>;       // see 7.6
// kinetograph_dom::transform
pub fn local_transform(node: &Node, size: (f32, f32)) -> Option<Matrix>;         // 4x4, see 7.8
pub fn perspective_matrix(node: &Node, size: (f32, f32)) -> Option<Matrix>;
```

The addon (`crates/node/src/dom.rs`, declared in `crates/node/index.d.ts`):

```ts
renderDomIsland(requestJson: string): string                       // IslandOutput JSON: build -> resolve -> paint::paint(&doc, &request)
domLayoutBoxes(requestJson: string): string                        // { [path]: { x, y, width, height, rect, client, scroll } }
domComputedStyle(requestJson: string, path: string, properties: string[]): string[]
```

A request is parsed, a document built and resolved, and the answer made; nothing is kept between calls, so each is a
pure function of its request. `renderDomIsland` appends one `unsupported` item (`element: "resource"`, the reason
naming the file) for every image, stylesheet or font the island named that could not be read. A panic inside Stylo or
Blitz is a `RENDER` error, a bad request `INVALID_ARG`, a font file that cannot be read `RENDER`.

### 7.2 The document

```
<html> <head> <style>request.stylesheets[0]</style> … </head>
       <body>                                         margin 0 (ua.rs)
         <div data-kg-island style="position: relative; display: block; width: Wpx; height: Hpx">
           …the DomNode tree…
```

- **Containing box.** The island is laid out as CSS lays out a child of a `position: relative` block of the
  composition's size: percentages, `auto` margins, `inset: 0` and `vw`/`vh` of the root resolve against the composition.
  `Viewport` is the same size, so `@media (min-width)` and `vw` units use the composition.
- **Elements.** `tag` is lower-cased unless the element is in SVG (`<svg>` and everything below it except under
  `foreignObject`), where it keeps its case and is in the SVG namespace; attribute names likewise (`xlink:href` gets the
  XLink namespace). `style` is the `style` attribute (it wins over `attrs.style`); `<script>` is dropped. A `native`
  node is `<kg-native>` (`display: block`, `width`/`height` as given or 0).
- **Stylesheets.** `request.stylesheets` become `<style>` elements in `<head>`, in order, before the tree's own
  `<style>` elements, so source order is document order. Blitz decodes HTML entities in `<style>` text; `&` is escaped
  to survive that. `<link rel=stylesheet>` and `@import` load from the project's files (7.4).
- **UA stylesheet** (`ua.rs`): Blitz's `default.css` (Gecko's `html.css`: Chrome's block/inline defaults, heading and
  list margins, `b`/`i`, `[hidden]`) plus: `html, body { margin: 0 }`, Chrome's `overflow: hidden` for non-root
  `svg`, `kg-native { display: block }`, `kg-spacer` (7.6). Form controls keep Gecko's look, not Chrome's.
- **CSS switched on** (Stylo ships them off): `:has()`, `:nth-child(of S)`, `@container` (parsed; Blitz does not
  evaluate container sizes, so it never applies), `@scope`, `@starting-style`. `@layer`, `@supports`, `@media`,
  `calc()`/`min()`/`clamp()`, custom properties, nesting, `color-mix()`, grid, multicol, `:is`, `:where` work as they are.
- **Threading.** Style traversal runs sequentially in the calling thread (`StyleThreading::Sequential`), so concurrent
  calls from Node workers are safe.

### 7.3 Fonts

`request.fonts` maps a font key to a file; **the keys are `fontKey` of `@kinetograph/scene`** (`Inter` for 400 normal,
`Inter:800`, `Inter:400i`), not `family:weight:style`. Each file (relative paths resolve against `baseDir`) is read,
unpacked if WOFF or WOFF2 (`blitz_dom::decode_font_bytes`, `wuff`) and registered in Parley under the key's family name,
weight and style. CSS font matching then does the rest: the `font-family` stack in order, names case-insensitive, the
weight search of CSS Fonts 4 (700 and 900 go to a registered 800; 300 and 500 to a registered 400), `italic` to an
italic face. The old "no registered font at weight 800" cases were a matching bug of the TypeScript path.

- **No system fonts.** A generic family (`sans-serif`, `serif`, `monospace`, `system-ui`, …) and a stack that names
  nothing registered fall back to the registered families in key order, never to a font of the machine; `monospace`
  and `ui-monospace` try the fixed-pitch fonts first (the `post` table's flag), the others try them last.
- **A face stays at its weight.** Google serves a font for one weight as a variable file (`inter-800-latin.woff2` has a
  `wght` axis, default 400). fontique set the axis to the requested weight, so `font-weight: 400` text drew the 400
  instance of a file registered as 800; a browser clamps to the `@font-face` weight and draws 800. `vendor/fontique`
  (see `vendor/README.md`) adds `FontInfoOverride::pin_weight`, and `fonts.rs` sets it for every registered font: the
  axis stays at the key's weight, and a request more than 200 heavier than the face gets the faux bold. This is the one
  patched dependency of this stream; `[patch.crates-io] fontique` in the root `Cargo.toml` wires it.
- Decoded font bytes are cached by path, size and modification time (`fonts.rs`), so a frame does not unpack WOFF2
  again; registering is lazy in Parley (0.01 ms).
- `@font-face` in a stylesheet works too (`url()` resolved like images; registered by the descriptor's family, weight
  and style).

### 7.4 Files: images, stylesheets, fonts

`net.rs` is the document's `NetProvider`. No network: `http(s):` is "not available" (listed in `missing`). A `file:`
URL names a file as it is; if there is none, the same path read against `publicDir`, then `baseDir`
(`/logo.png`, `logo.png`, `./logo.png`, `fonts/x.woff2` all work). `data:` URLs work. Relative URLs in markup and CSS
resolve against `baseDir` (the document's base URL is `file://<baseDir>/`).

- Requests are answered synchronously in the calling thread, so `<img>` has its intrinsic size when layout runs.
  `background-image: url()` and `mask-image: url()` are found while styles are computed, so `resolve` runs the style
  and layout pass again (incrementally) when a request was answered during one, up to 4 times.
- **Images are decoded once** and kept between documents, keyed by path, size and modification time (at most 512 MB
  of pixels, then the cache starts over). Decoding the papercut's 512 px grain texture took about 4 ms of a 5 ms frame
  before this. A cached picture is the same `Arc<Vec<u8>>` in every frame's document, which the painter can use as a key.
  Rasters decode as Blitz does (`image` crate, straight RGBA8); SVG images parse with usvg and **no system fonts**
  (Blitz would load the machine's).
- A file that cannot be read stays in `IslandDocument::missing` and becomes an `unsupported` item (7.1).

### 7.5 CSS animations and transitions

`resolve(time)` of Blitz is Stylo's clock: nothing reads the wall clock. A document is new for every frame, and
Stylo starts an animation at the clock of the first style pass, so `document::resolve` styles at 0 and then moves to
`request.time`: the animation's progress is the time. Stylo moves an animation on by one iteration per style pass, so
reaching the Nth iteration takes N passes; the count comes from the computed `animation-*` values and is capped at
2000 passes. Tested: `@keyframes` on `width`, `opacity`, easing, delay, `both` fill, `infinite`, `alternate`, 2.5
iterations, out of order and repeated times. **Transitions do not run**: a transition needs a style change between two
style passes, and a frame has one style. Remotion forbids CSS transitions and animations for this reason; an
animation is the way to make CSS move.

### 7.6 Inline elements: edges and boxes

Blitz lays an inline element (`span`, `b`, `a`) out as a style span of its inline root's text and **ignores its
horizontal margin, border and padding** (text after a span with `padding: 0 20px` sat 66 px from where Chrome has
it). `inline::add_edge_spacers` runs after the last style pass and gives the text those widths with zero-height
`inline-block`s, `<kg-spacer style="width: Npx">`: the margin of each side outside the element, its border plus padding
inside it (swapped for `direction: rtl`). Then `resolve` once more. Lines break and the following text moves as in
Chrome; on a wrapped inline the left edge is on its first line and the right on its last (`box-decoration-break: slice`).

**For the painter (stream 2):**
- `inline::fragments(doc, id) -> Option<Vec<Fragment { rect, baseline }>>` returns the pieces of a non-atomic inline,
  one per line, in document coordinates, as `getClientRects()` does: x from the glyphs and spacers inside the element
  (so the rect **already includes the left/right padding and border** on the lines that have them; do not add them
  again), y from the content area of the element's font (ascent and descent rounded to whole pixels, as Chrome rounds
  them) grown by the vertical padding and border, no hanging whitespace at a line end. Blitz's own
  `Node::inline_fragment_boxes` is the line box and ignores all of this.
- A node named `kg-spacer` paints nothing and has no path; skip it. Elements with `data-kg-path` are the ones the
  request had.
- `inline::edges(node, basis) -> Edges` gives the margin/border/padding of an element in CSS pixels (`border-style:
  none` is 0 width, which Stylo's computed `border-width` does not do).
- Known gaps: a break opportunity exists between a spacer and the first word (an inline can start a line with only its
  padding at the end of the previous one, rarely); collapsible whitespace at the start of a padded inline does not
  collapse with the one before it; `vertical-align: sub|super|<length>` on text spans does nothing (Parley); a
  block-level `::before`/`::after` on an element whose other content is text is dropped from layout (Blitz).

### 7.7 Readback

`domLayoutBoxes` answers `{ [path]: ElementBox }` for every element and native placeholder (`display: none` and
`display: contents` are all zeros):

| Field | Meaning |
|---|---|
| `x`, `y`, `width`, `height` | the border box where layout put it, in island coordinates (the container is the origin), ignoring `transform`s; fractional (taffy's unrounded layout) |
| `rect` | the bounding box of that box through every `transform`/`translate`/`rotate`/`scale`/`perspective` up the containing-block chain, as `getBoundingClientRect` gives (3D included, 7.8) |
| `client` | `clientWidth`/`clientHeight`, whole pixels (0 for inlines) |
| `scroll` | `scrollWidth`/`scrollHeight`, whole pixels |

A non-atomic inline's `x..height` and `rect` are the union of `inline::fragments`. `domComputedStyle` is Blitz's
`resolved_style_value`: Stylo's computed value, or the used value for `width`, `height`, margins, paddings, insets,
`transform-origin` and grid tracks; names are CSS (`font-size`, `--accent`) or React's (`fontSize`, `WebkitMask…`);
`""` for an unknown property; `transform` is `matrix(…)`/`matrix3d(…)`.

### 7.8 Transforms

Blitz resolves only the 2D subset of `transform` (it drops `rotateX`, `perspective()`, `translateZ`). `transform.rs`
builds the whole thing for readback and for anyone who needs the matrix: `local_transform` is `translate(origin) ·
translate · rotate · scale · transform · translate(-origin)` as an euclid `Transform3D<f64>` (row-vector convention,
`a.then(&b)` applies `a` first), `perspective_matrix` is what an element's `perspective`/`perspective-origin` gives its
children, `preserves_3d` and `flatten` follow `transform-style`. The chain in `readback::ctm` multiplies them up the
containing blocks and flattens at every parent that is not `preserve-3d`, as CSS Transforms 2 says.

### 7.9 Performance

Per frame, release build, M4, with other agents loading the machine (load average 20 to 37, so these are upper bounds):

| Island | Nodes | JSON | parse | build | build + resolve | `layout_boxes` |
|---|---|---|---|---|---|---|
| synthetic papercut-shaped, 10 slabs | 47 | 11 KB | 0.04 ms | 0.5 ms | 0.8 ms | 0.02 ms |
| 40 slabs | 181 | 42 KB | 0.14 ms | 0.9 ms | 1.7 ms | 0.06 ms |
| 120 slabs | 537 | 126 KB | 0.41 ms | 2.0 ms | 4.1 ms | 0.18 ms |
| 400 slabs | 1789 | 420 KB | 1.4 ms | 6.3 ms | 13.3 ms | 0.60 ms |

(`cargo run --release -p kinetograph-dom --example perf [slabs…]`; the island is slabs with a grain `background-image`,
`background-blend-mode`, `rotate`, inset shadows, text pills in Inter 800, `<img>`, `<svg>`.) About 7 µs per node, of
which the document build is half. An empty island costs 0.45 ms (a document with Blitz's 1100-line UA stylesheet).

On the real corpus, the 988 frames of the episode 13 papercut (1976 islands, mean 32 KB of request each, almost all of
it the 26 KB Tailwind stylesheet; the painter was a stub): **mean 2.65 ms per `renderDomIsland`, median 1.9 ms,
p95 5.6 ms**, 94 ms for the first call (cold: fonts, the first image decodes). The request's JSON stringify on the
TypeScript side adds 0.2 ms. 4000 consecutive calls leave the process at a flat 83 MB.

The plan said to keep the document between calls above 5 ms. It is not needed: rebuilding is under 5 ms up to about 600
nodes, and a kept document would put Stylo's caches and animation sets in the way of "a frame is a pure function of its
request". The one cost worth removing later is parsing the same 26 KB stylesheet every frame (about 1 ms of the 2.65);
a parsed sheet belongs to its document's lock, so it needs a persistent document to share.

### 7.10 Against Chrome

`crates/dom/tools/chrome-compare.mjs <island.json | dir>` builds an island's tree in Chrome for Testing (body margin 0, a
`position: relative` box of the viewport's size, `@font-face` per registered font, `<base>` at `baseDir`) and compares
`getBoundingClientRect` of every element with `domLayoutBoxes`'s `rect`. `crates/dom/tools/zoo.mjs <dir>` writes layout
islands for it. Chrome is for the tools only; the engine never starts one.

- **The papercut corpus**: 40 islands sampled from the 988 frames of episode 13 (791 elements): 2 differ by more than
  1 px, the worst by 1.3 px (a text width: Chrome's "Claude" is 289.7 px wide, Parley's 290.7).
- **The zoo** (48 islands, 363 elements: margins and collapsing, headings/lists/`pre`, inline text and inline-blocks,
  text properties (letter/word-spacing, `nowrap`+ellipsis, `pre-wrap`, rtl, justify, `text-wrap: balance`, Inter/
  Archivo/JetBrains Mono), flex row/column/nested/wrap, grid (areas, auto-fill, `minmax`, spans, dense, alignment),
  positioning, units (`vw`, `ch`, `lh`, `calc`, `clamp`, `var`), overflow, transforms (2D, skew, 3D, perspective,
  individual properties, nested), multicolumn, `contain`, `zoom`, `font` shorthand, drop caps, bidi, CJK, combining
  marks, `vertical-align` keywords, selectors and at-rules): 32 islands match everywhere within 1 px (margins, text
  blocks, text properties, all of flex, positioning, units, overflow, transforms, the `misc-*` features not listed
  below, captions, centred full-frame layouts). The other 16 differ for the reasons below, or by 1.2 to 3 px in a text
  width.
- **Known differences** (each found by this tool; none occurs in the papercut corpus):
  `-webkit-line-clamp` (not implemented in Blitz: the box is as tall as all the lines);
  text wrapping around floats (one line more in Chrome: float margins are not all counted);
  `<table>`: rows have no box and auto column widths are distributed differently;
  `::first-line`/`::first-letter` styles do not change layout;
  a block-level `::before`/`::after` on an element with text children is dropped;
  `@container` queries never match;
  `aspect-ratio` with `max-height` and a definite width shrinks the width;
  `display: inline-flex|inline-grid` sits lower than Chrome's first-baseline alignment (7 px in the zoo);
  `vertical-align: sub|super|<length>` on text; `<br>` has a zero box; SVG child elements (`rect`, `path`) have a zero
  box in `domLayoutBoxes` (the TypeScript shim answers `getBBox`); form controls (`button`, `input`) have Gecko's
  default size, not Chrome's; text widths differ from Chrome's by up to 1.5 px on a long line (Parley against Skia).

### 7.11 Notes for the other streams

- Find an element's path from a node with `data-kg-path`, or the maps in `IslandDocument`; the painter receives only
  `&BaseDocument`, so use the attribute (the island root is the element whose `data-kg-path` equals `request.path`).
- The container `<div data-kg-island>` is in the document; its box is the composition. Stylesheet `<style>` elements and
  `kg-spacer`s are in the document and paint nothing.
- Image pixels come from `node.element_data().special_data` (`SpecialElementData::Image`) and `background_images` /
  `mask_images` as Blitz fills them; the pixel `Arc` is shared across frames.
- `tests/common/mod.rs` (JSON request helpers, `bounds`) is meant to be shared: stream 2's golden tests can use it.
