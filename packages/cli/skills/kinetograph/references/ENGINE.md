# The full engine (Phase 6)

Decided 2026-10-15 (approved by the user the same day): compat mode stops
parsing CSS in TypeScript. A DOM island is handed to Rust, styled by Stylo, laid out by taffy and Parley through
Blitz's DOM (`blitz-dom` 0.3.0-beta.3, which uses the same Parley 0.12 and taffy 0.15 as the core), and painted by our
own compositor. Blitz's painter (`blitz-paint`) is not used. No Chrome in the render path, ever (the Phase 5
Chrome fallback was removed on 2026-10-16); Chrome for Testing is used only by tests and tools to make reference
images.

Success, measured on the M4:
- The tiny-agent episode 13 papercut project (`$KINETOGRAPH_CORPUS/tiny-agent/episodes/13-mods/papercut/src/index.ts`,
  `ModsPapercut`, 988 frames) renders with every frame native, today 0 of 988.
- Each frame looks like Chrome's: the golden cases and `scripts/corpus.mjs --reference` against Chrome and Remotion references within a per-pixel threshold (text and
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
  frame loop, render: every frame is drawn by the addon; unsupported items are warned about, `--strict` fails (the Remotion compatibility docs, `/docs/compat/`)
```

Readback (`getBoundingClientRect`, `offsetWidth`, `getComputedStyle`, `ResizeObserver`) goes through the same
document: `domLayoutBoxes(json)` in the addon (stream 1) answers for the island's current host tree; the TS DOM shim
(stream 4) calls it lazily and caches by tree generation.

## 2. The contract

`crates/dom/src/request.rs` is the contract and is owned by the orchestrator: streams may add optional fields;
changing an existing one goes through the orchestrator. In short:

- `IslandRequest { root: DomNode, stylesheets, viewport, fonts, baseDir, publicDir?, time, path, history? }` (`history`: earlier tree states, for CSS transitions, §7.12).
- `DomNode` = `element { tag, path, attrs, style, children }` | `text { text }` | `native { path, width?, height? }`.
  `style` is CSS declaration text (`width: 10px; opacity: 0.5`), serialized by TS with React's rules.
- `IslandOutput { layers: LayerJson[], unsupported: Unsupported[], camera }`, the shape of `IslandResult`.
  A `{"type": "native", "path", "x", "y", "width", "height"}` layer marks where a native element's layers go.
- Layer ids: derived from the node's explicit `id` attribute if it is a valid layer id, else its `path`, with the
  suffixes the painter needs (`.bg`, `.border`, `.text`, …), unique per island.
- Addon functions (stream 1): `renderDomIsland(requestJson: string, pass?: number): string` and
  `domLayoutBoxes(requestJson: string): string` → `{ [path]: { x, y, width, height, rect: {x,y,width,height},
  client: {width,height}, scroll: {width,height} } }` (offset box in island coordinates; `rect` is the transformed
  bounding box, as `getBoundingClientRect` gives).
- `pass` numbers the renders of one frame (its own and its motion-blur sub-frames'; compat's `beginSamplePass`). In a
  pass an island's document is edited from its last render instead of built again, and a render after the island's
  first in the pass answers `"delta": true` with `layers` written against that first one's: `{"$same": i}` is the
  first's layer `i` at that place, and a group with `"$base": i` has its own fields and its children written against
  the children of the first's layer `i` (`request::delta`). compat puts the layers back together, sharing the first's.
  `startDomIsland(requestJson, pass): number` queues a render behind the ones before it and `finishDomIsland(ticket)`
  waits for its output, so a sub-frame's islands are drawn while the next sub-frame renders.

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

Shared files (`crates/core/src/scene.rs`, `compositor.rs`, `packages/cli/skills/kinetograph/references/SCENE.md`, `crates/node/src/lib.rs`): add new
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

## 9. Stream 3 notes (SVG)

Two functions in `crates/dom/src/paint/svg/mod.rs` are what the box painter (stream 2) calls. Both take the
styled, laid-out `BaseDocument` and the `IslandRequest` (for fonts and asset directories).

```rust
pub fn paint_svg(doc: &BaseDocument, request: &IslandRequest, node_id: NodeId, size: [f64; 2],
                 id: &str, path: &str) -> SvgPaint;          // SvgPaint { layer: Option<Value>, unsupported }
pub fn filter_graph(doc: &BaseDocument, request: &IslandRequest, fragment: &str, bbox: [f64; 4],
                    id: &str, path: &str) -> Option<FilterEffect>;  // FilterEffect { effect: Value, unsupported }
```

- `paint_svg` paints an `<svg>` element's content only. `size` is the content box in CSS pixels; `viewBox` and
  `preserveAspectRatio` map into it. It returns one `group` layer (id `id`) with (0, 0) at the content box's top-left
  corner and a clip to the viewport (the UA's `overflow: hidden` on `<svg>`). It sets no `transform`, `opacity`,
  `blendMode`, `effects`, `clip` or `mask` on that group: the CSS box is the caller's, so the caller adds those, and
  `transform.x`/`.y` to put the box in its parent. That includes the CSS `rotate`, `scale`, `translate` and
  `transform` properties of the `<svg>` element itself. Properties of the elements inside (`<g>`, `<path>`, ...)
  are handled here.
- `filter_graph` returns `{"type": "filterGraph", ...}` for `filter: url(#id)`, to be pushed onto the `effects` of
  the filtered layer (in the order the CSS `filter` list has them). `fragment` is `#id`, `url(#id)` or `id`; the
  `<filter>` can be anywhere in the document. `bbox` is `[x, y, width, height]` of the element's object bounding box
  in the coordinates of the layer the effect goes on (an HTML box: its border box and everything painted inside it, as Chrome
  takes it, see 10.5), used for `objectBoundingBox`
  units and the default region (-10%, -10%, 120%, 120%). It returns `None` for an id that names no `<filter>`
  (CSS ignores the reference then). A filter of the wrong kind of element is `None` too.
- Both return `Unsupported` items for what they could not draw as Chrome would.
- The `filterGraph` effect is documented in `packages/cli/skills/kinetograph/references/SCENE.md` ("filterGraph").

## 7. Stream 1 notes (front: Blitz document, fonts, files, animations, readback)

## 10. Stream 4 notes (runtime)

What the TypeScript side does around the addon, as built on `engine/runtime`. Code is under `packages/compat`,
`packages/react`, `packages/core` and `packages/cli`.

### 10.1 The request

`mapDomIsland` (`compat/src/dom/index.ts`) builds an `IslandRequest` (`compat/src/request/`), calls the addon's
`renderDomIsland`, and fills the `native` placeholders in the answer. Rules:

- **Paths.** An element's `path` is its place in the host tree: its index among the elements of its parent (DOM and
  `kg-*` alike, text counts for nothing, a `<Sequence>` is transparent), under the parent's path; top-level ones are
  `$0`, `$1`. Native elements inside an island count in the numbering, so the paths of Rust's answer and of TypeScript
  agree.
- **Attributes** follow React DOM: `className` is `class`, `htmlFor` is `for`, SVG presentation props are hyphenated
  (`strokeWidth` is `stroke-width`, `clipPath` is `clip-path`, `xlinkHref` is `xlink:href`) while SVG's camelCase
  attributes keep their case (`viewBox`, `gradientUnits`, `stdDeviation`); HTML names are lower-cased; `true` is `""`
  for boolean attributes, `false` leaves them out; handlers, `ref`, `key` and `children` are not attributes.
- **`style`** is CSS declaration text by React's rules: numbers get `px` except `0`, custom properties and the unitless
  properties (`opacity`, `zIndex`, `flexGrow`, `lineHeight`, `fontWeight`, `scale`, `order`, `aspectRatio`,
  `strokeWidth`, … and their `Webkit`/`Moz`/`ms`/`O` prefixed forms); camelCase becomes kebab-case, `WebkitX` becomes
  `-webkit-x`, `msX` `-ms-x`, `cssFloat` `float`; null, booleans and `''` leave the declaration out.
- **`<style>`, `<link rel=stylesheet href>` and `.css` imports** are the document's stylesheets, the same for every
  island of the tree (a `<style>` in one island applies in another, as in one document), in this order: imports (in
  import order), then every `<style>` element and local `<link>` in tree order. The `<style>` element itself stays in
  the request, empty, so sibling positions do not move.
- **`dangerouslySetInnerHTML`** is parsed by a small forgiving HTML parser (`request/html.ts`) into children; on a
  `<style>` it is the stylesheet.
- **Native elements** are `{ "kind": "native", path, width, height }`: a layer's own `width`/`height` (a `<Layer>`'s
  `layout` size, a `<Text>`'s `maxWidth` and measured height; a path or a group without a layout is 0 by 0; an animated
  size is its first value). Rust leaves a `{"type": "native", path, x, y, …}` layer where the box went; TypeScript
  replaces it with `emitNative`'s layers moved there (the layer's own `x`/`y` are an offset from the box, its anchor
  shifts it, as before), at any depth. A native element that makes no layer (`<Camera>`, `<Audio>`) is dropped. A
  `<Layer>`, shape, canvas, 3D scene or video is an overlay (absolute, at the corner of its positioned ancestor, no room
  in the flow); an `<Image>`, GIF, Lottie, `<GlslShader>` and text are in the flow, a replaced box of their own size.
- **Top-level layers** of an island get `layoutItem: { position: 'absolute' }`, so a native flex parent does not
  place them again.
- **`fonts`** is `getFonts()` as it is: keys are the scene's `fontKey`s (`Inter`, `Inter:800`, `Inter:400i`), not the
  `family:weight:style` the comment in `request.rs` says.
- **`time`** is the virtual clock in seconds (`performance.now() / 1000`, which is `frame / fps`, and the sub-frame time
  on a motion-blur sub-frame). `baseDir` is the entry's directory, `publicDir` the project's `public/`
  (`setDomEnvironment`, from the CLI; `KINETOGRAPH_BASE_DIR` and `KINETOGRAPH_PUBLIC_DIR` before the project loads).
- An island whose root is `<style>`, `<script>`, `<link>`, `<meta>`, `<title>`, `<head>` or `<template>` draws nothing
  and is not sent.
- **`<AbsoluteFill>`** is a layer mapping when everything inside it is native (the hand ports render as before), and
  the `div` it is in Remotion (`position: absolute; inset: 0; display: flex; flex-direction: column`, the author's style
  on top) when anything inside it is DOM: the layer's `domFill` prop says so, `emit` swaps it, and a fill inside a fill
  is part of the same `div` tree. Without this, `justifyContent` and `alignItems` on a fill would not place its DOM
  children.
- One call per island per frame: the frame loop renders with `SceneRoot.update` and emits once, with `snapshot()`.
- `KINETOGRAPH_DOM_MAPPER=legacy` selects the Phase 5 TypeScript mapping (`compat/src/dom/legacy.ts`, `compat/src/css`)
  until it is removed.

### 10.2 `.css` imports

The CLI's bundler (`cli/src/css.ts`) no longer drops `.css`: each import becomes a module that calls
`registerStylesheet(text, file)` when the project loads.

- Local `@import`s are inlined (an `@import` with a media query becomes an `@media` block, cycles are cut); relative
  `url()`s that name an existing file become absolute paths; remote ones are left alone.
- `@font-face` rules (in imports, `<style>` elements and linked files) register their file with the font registry,
  as `new FontFace(...)` does (the first local `url()`, `unicode-range` as for `FontFace`); a remote source is a note.
- `*.module.css`: class names are scoped (`.title` becomes `.title_<hash>`), the default export and the named exports
  map them; `:global(...)` is left alone.
- **Tailwind.** A file with `@tailwind` directives or `@import "tailwindcss"` is built by the project's own Tailwind,
  tried in this order: its `tailwindcss` CLI (`node_modules/.bin`, v3 or `@tailwindcss/cli` v4; `-i file -o out` in the
  project root), Tailwind 4's `compile()` from the installed `tailwindcss` package (stylesheets resolved from the
  package, class candidates scanned from the project's `.ts/.tsx/.js/.jsx/.html/.md(x)` files; about 0.25 s for the
  papercut episode), PostCSS with `@tailwindcss/postcss` or v3's plugin. If none works the file is registered as it
  is, the bundle warns, and `doctor` prints a "stylesheets:" note.
- A project's already-built CSS file is any other stylesheet.

### 10.3 Readback

React refs to DOM host elements are `DomElement` objects (`compat/src/shim/element.ts`), made by the reconciler's
`getPublicInstance`. They answer from the addon, for the element's island (`react/src/readback.ts`): the island is the
outermost run of DOM elements above the element (a native element ends it; a fill that is a `div` starts it), sent as
the same request a frame is drawn from, and `domLayoutBoxes` / `domComputedStyle` answer for it. Answers are cached
until the tree changes (`generation`: bumped by every commit, before layout effects run, and by a script's writes).

- `getBoundingClientRect`, `getClientRects`, `offsetWidth/Height/Left/Top/Parent`, `clientWidth/Height/Left/Top`,
  `scrollWidth/Height` (offsets relative to the nearest positioned ancestor, else the island's origin);
  `getComputedStyle(el)` (also the global) reads one property per question (`domComputedStyle`); without the addon
  function it reads the inline style.
- `matches`, `closest`, `querySelector(All)`, `getElementsBy…`, `contains`, `parentElement`, `children`, `textContent`,
  `classList`, `dataset`, `getAttribute/setAttribute/removeAttribute`, `style` (read, and write: a script's changes are
  laid over the props and are part of the next request, as in a DOM) and event listeners (nothing fires them).
  `document.querySelector/getElementById/…` search every root.
- SVG: `getTotalLength`, `getPointAtLength` and `getBBox` of `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
  `polygon` use the path functions of `@kinetographdev/core/paths` (handed over by `web/install`); a group's `getBBox` is
  the union of its children's, with their `transform` attributes applied.
- `ResizeObserver` and `IntersectionObserver` deliver after React's work is done and layout is settled: a callback that
  sets state makes the root render again before the frame is emitted; resize observers fire when the border-box
  size differs from the last one delivered (an element that is 0 by 0 is not reported first, as in the spec), and
  carry `contentRect`, `borderBoxSize`, `contentBoxSize`. Everything is intersecting, ratio 1, reported once.
  `MutationObserver` never fires. Observer rounds are capped at 8 per settle.
- **Measure-then-render.** A `useLayoutEffect` or `useEffect` that measures and sets state re-renders within the
  frame; the root settles until nothing is pending. A ninth tree generation measured within one frame (or the ninth
  pass of a passive-effect loop) is an error that says an effect keeps measuring and setting state.
- `measureText` and `fitText` (`@remotion/layout-utils`) put the text in a `span` (`white-space: pre`, out of flow) in
  the DOM engine and read its box, as Remotion reads Chrome's: the line rounds as the DOM rounds it,
  `letterSpacing`, `textTransform` and `additionalStyles` apply by CSS. Without the addon the text engine's own measure
  answers.

### 10.4 Web APIs and time

`@kinetographdev/core/web/install` (imported by the Node bundle after the determinism shim) puts
these on the global object where they are missing:

- `window` (is `globalThis`), `self`, `innerWidth/Height` and `outerWidth/Height` (the composition's size, set by
  `createSceneRoot({ viewport })`), `devicePixelRatio` 1, `screen`, `location` (`http://localhost/`), `history`,
  `localStorage` and `sessionStorage` (in memory, empty at every start), `requestIdleCallback`;
- `matchMedia`: `screen`, `width`/`height` features and their `min-`/`max-` forms, `orientation`, `aspect-ratio`,
  `prefers-reduced-motion: no-preference`, `prefers-color-scheme: light`, `hover: none`, 1x resolution; `not`, `and`
  and comma lists; `change` never fires;
- `new Image()`: `src` of a project file (absolute, relative to the entry, or in `public/`), a `data:` URL or an
  in-memory blob; `naturalWidth/Height` from the file's header (PNG, JPEG, GIF, WebP, BMP, SVG), `onload`, `onerror`
  (with `message`), `addEventListener`, `decode()`; a missing file, a non-image or a remote URL is an `error`;
- `fetch` of project files (the same lookup; `staticFile()` URLs are absolute paths), `data:` and `blob:` URLs; a
  remote URL rejects with "remote URLs are not available: Kinetograph renders offline"; the font downloads keep the real
  `fetch` (explicit, cached);
- `URL.createObjectURL` for blobs is Node's own;
- `document`: `createElement` (a detached node, never drawn), `createElement('canvas')` (a canvas outside the tree with
  a recording 2D context, and a recording WebGL context for `getContext('webgl')`, AUTHORING.md §6.5 and §6.7),
  `body`/`documentElement` with the composition's size, queries over the host tree, `fonts` (the `FontFace` shim);
- `Element`, `HTMLElement`, `SVGElement`, `HTMLImageElement`, `HTMLCanvasElement`, `OffscreenCanvas`, `Path2D`,
  `ImageData`, `DOMRect`, the three observers.
- `crypto.getRandomValues` and `randomUUID` draw from the seeded `Math.random` generator.

Time: `Date`, `performance.now`, timers and `requestAnimationFrame` were already driven by the frame
(`core/src/determinism.ts`); `requestAnimationFrame` callbacks run once per frame with the frame time, after the frame
renders (the callbacks the render asked for, then what they set is in that frame's scene; what they ask for waits for the
next frame). Motion-blur sub-frames run none. CSS `@keyframes` animations and transitions read `request.time`; nothing in TypeScript reads a wall clock.

### 10.5 doctor and the corpus harness

`doctor` reports the unsupported items Rust returns, plus a "stylesheets" note for what the bundle could not do.
(`doctor --compare`, which drew sampled frames natively and in the Chrome fallback, went with the fallback.)

`scripts/corpus.mjs` runs `doctor` on the episode 13 papercut project and prints: frames with nothing unsupported of
the total, the unsupported items with their frame counts, and with `--reference` (default every 30th frame) the
per-frame differences from a real Remotion render (pixels more than 2 levels apart and, separately, more than 48:
what is left after anti-aliasing and text rasterisation); it writes `out/corpus/report.json` and the pictures.

#### Numbers (2026-10-15, M4)

First run, then the current one. Both: `node scripts/corpus.mjs --reference --every 30` (33 sampled frames of 988).

**Current**: the four streams merged (`feat/full-engine`), after the fixes below. About 63 s for the whole run.

The first run after the merge was worse than `engine/runtime` had measured (5 312 576 pixels more than 48 levels apart
against 2 470 423): whole props were missing (the barrier arm with the DELETE GUARD sign, the file cards, the toothed
chute, the trench coat's badges) and a `</>` strip sat on the whole of one scene. Causes, all found from the pictures
(`doctor` reports nothing for them):

1. `filter: url(#rough)` takes its region from the box of the element, and the kit's `Paper` is a `div` of `inset: 0`
   inside a `width: 0; height: 0` wrapper, so the region was empty and the prop drew nothing. Chrome takes the element's box
   and everything painted inside it, through the descendants' transforms and up to an `overflow` clip (the critter's cap and
   arm stick out of its body). `Painter::filter_bbox` does the same. This was the main loss (2.5 million pixels).
2. `filter: url(#torn)` alone (the tape corners, the strip) is not in Stylo's filter list, so the element made no stacking
   context and the filter was dropped. `is_sc` now reads the mirrored `--kg-filter`.
3. A text layer's box was its longest line, but a centred line sits inside the content box, so the compositor (and the
   filter on the banner) cut off the end of the line ("COMMAND", "DELET"). The box is now the wider of the two.
4. `TransitionSeries` kept a transition's presentation mounted at rest; `tapePull` draws its `</>` strip at every
   progress, so it covered the whole of the scene before the cut. The wrapper is now added only inside the transition's
   window, as the published package does.
5. A group with no buffer of its own (a `div` that only turns) holding a pass-through SVG group with a `multiply` inside
   blended with the page: the red marker ring came out nearly black. `needs_no_buffer` now sees a blend passed through a
   pass-through group.

The `native` placeholder was not the cause: stream 2's content-box version (`replaced.rs`) is the same box as stream 4's
for a `kg-*` element without padding, and it comes before the empty-box return, so zero-size natives (`Sequence`,
`Camera`) still get one.

- **Native frames: 988 of 988** (Chrome frames 0; no Chrome fallback exists any more, and the count is the same after its removal). This counts frames, not fidelity: the painter reports no
  unsupported item on any frame yet.
- **Against the real Remotion render** (`out/mods-papercut.mp4` in the project; same sources and frame count; H.264, so
  a few levels of noise everywhere): mean difference 3.1 to 15.3 levels (median 3.8), PSNR 17.8 to 33.6 dB, 2919 to
  353 257 pixels (0.1% to 17%) more than 48 levels apart, **1 276 162 summed** over the 33 frames (2 470 423 on
  `engine/runtime`, 5 312 576 right after the merge). Best: frames 840 (2919), 150 to 450 and 630 to 810 (4 to 14
  thousand). Worst: 600 (353 257), 0, 90, 120 and 480 to 570 (56 to 118 thousand). Those are the frames with a 3D
  camera. Both leftovers are fixed (`fix/corpus-leftovers`), **291 511 summed** now (mean 3.1 to 5.5 levels, PSNR 27.6 to
  33.6 dB, 2909 to 23 969 pixels a frame):

  | frame | 0 | 60 | 90 | 120 | 480 | 510 | 540 | 570 | 600 |
  |---|---|---|---|---|---|---|---|---|---|
  | before | 91 868 | 65 480 | 118 266 | 98 150 | 90 298 | 56 130 | 92 155 | 113 277 | 353 257 |
  | after | 8 929 | 15 485 | 11 399 | 23 969 | 6 870 | 8 730 | 12 956 | 10 934 | 6 507 |

  1. Frame 600 (the crab-track slide in the gallery): the left 250 px of the scene was black, because the wall's mirrored
     copy lies at layer x below 0 and a layer turned in 3D (`perspective()` in a `Depth`) was drawn flat in a canvas-sized
     texture first, then warped, so what lay off the canvas was lost. `Renderer::source_shift` now draws the flat layer
     shifted by whole pixels so that the part of its plane the warp maps onto the canvas (the canvas pulled back through
     the homography, cut at the vanishing line: `warp::source_shift`) lies on the texture, and `place` undoes the shift in
     the homography; `plan_pages` takes the same shift, so the leaves still come from their pages. A part wider than the
     texture (a camera pulled far back) is left as it was, and a layer that reads the backdrop is not shifted.
  2. The 3D-camera frames (0, 60 to 120, 480 to 570; the backdrop's perspective slope was 1.8 times the mp4's, the props
     off by tens of pixels): the cause was the painter writing a layer's `matrix3d` rounded to four decimals
     (`num4`). Its `w` terms are `sin(angle) / perspective`, about 5e-5 for a `Depth` at `perspective(1600px)`, so 5.5e-5
     came out as 1e-4 and a gentler slope as a steeper one. Chrome's own picture of the same page agreed with the mp4
     (the first suspicion, another camera setting, was wrong); native against it, frames 0 and 90: 90 138 and 116 265
     pixels more than 48 levels apart before, 7970 and 10 397 after. The matrix is written with every digit now
     (`num_exact`). The goldens of `preserve_3d`, `transforms` and `paint_order` changed by a few hundred pixels (their
     perspective is 400 to 500 px, where the rounding was a few percent); each is closer to or as close to Chrome's
     picture of the case as before (more than 48 levels apart: 62 to 1, 0 to 0, 23 to 23; mean 0.22 to 0.13, 0.28 to
     0.22, 0.17 to 0.17), so they are updated.
- **Against the Chrome fallback's own picture** (`--compare --every 120`, 9 frames; a page of our own, not Remotion's; the option is removed with the fallback):
  pixels more than 48 levels apart 2 204 458 summed, mostly frame 840 (1 595 312), where that page is shifted down by half
  the height (its `Sequence` wrapper is a zero-size positioned `div`); the others 8 thousand to 267 thousand.
- **JS stage** (React, emit, request, Rust style/layout/paint, JSON) for all 988 frames through `doctor`: about 60 s, 60
  ms a frame. Frames 30 to 50: 224 ms a frame, 138 ms of it in `renderDomIsland` (3 islands a frame, 430 KB of request and
  480 KB of answer); frames 500 to 520: 133 ms, 84 ms in Rust. Rust is about 65%; React in development mode is about
  25 ms of the rest (`NODE_ENV=production` would save roughly half of that, at the price of React's minified error
  messages, so it is not set). Drawing a corpus frame on the GPU takes 5 to 10 s (6661 layers at frame 30): the
  compositor's, not this stream's.

**First run** (`engine/paint@6fa5b1c`, same placeholder patch): native 988 of 988; mean 4.2 to 28 levels, PSNR 15.8 to
29.0 dB, 8755 to 384 196 pixels more than 48 apart, 3 559 263 summed.

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
  (`-webkit-line-clamp`, floats, `<table>` and `@container` were on this list and are done, §7.12; a table's rows,
  row groups and columns still have no box of their own in `domLayoutBoxes`;)
  `::first-line`/`::first-letter` styles do not change layout;
  a block-level `::before`/`::after` on an element with text children is dropped;
  `aspect-ratio` with `max-height` and a definite width shrinks the width;
  `display: inline-flex|inline-grid` sits lower than Chrome's first-baseline alignment (7 px in the zoo);
  `vertical-align: sub|super|<length>` on text; `<br>` has a zero box; SVG child elements (`rect`, `path`) have a zero
  box in `domLayoutBoxes` (the TypeScript shim answers `getBBox`); form controls (`button`, `input`) have Gecko's
  default size, not Chrome's; text widths differ from Chrome's by up to 1.5 px on a long line (Parley against Skia).

### 7.11 Notes for the other streams

- Find an element's path from a node with `data-kg-path`, or the maps in `IslandDocument`; the painter receives only
  `&BaseDocument`, so use the attribute (the island root is the element whose `data-kg-path` equals `request.path`).
- The container `<div data-kg-island>` is in the document; its box is the composition. Stylesheet `<style>` elements and
  `kg-spacer`s are in the document and paint nothing. A tree whose root is an `<html>` (a HyperFrames page) is a page:
  its `html` and `body` are the document's own (no container; the `head` of stylesheets is put in its `html`), so
  `:root`, `html > body`, `rem` and the canvas background are a browser page's. The compat shim then answers
  `document.documentElement` and `document.body` with them (`setPageDocument`).
- Image pixels come from `node.element_data().special_data` (`SpecialElementData::Image`) and `background_images` /
  `mask_images` as Blitz fills them; the pixel `Arc` is shared across frames.
- `tests/common/mod.rs` (JSON request helpers, `bounds`) is meant to be shared: stream 2's golden tests can use it.

What to fix first, from the pictures (not from `doctor`, which has nothing yet): `filter: url(#...)` on the tape banners
and signs (the text is clipped to the filter region, "DELET" and "GUAR"; fixed, see 10.5), the SVG filters (`rough`, `torn`), the grain
texture and multiply blend of the paper, and the rip transition's clip.

What is drawn (stream 3, as built):

- **SVG** (`paint_svg`): usvg resolves the subtree (shapes, `use`/`symbol`, nested `<svg>` with `viewBox` and
  `preserveAspectRatio`, gradients with `gradientTransform` and focus, text to paths with the request's fonts only,
  markers, `currentColor` from Stylo, `<style>` rules from the request's stylesheets); we map it to layers: paths with
  fill, fill rule, stroke width, caps, joins, miter limit and dashes (also `pathLength`), gradient and pattern paints
  (a pattern is its tile drawn once, repeated by `feTile`, cut to the shape by a matte), strokes with a gradient or
  under a stretched matrix as filled outlines, clip paths (one plain path is the scene's `clip`, anything else a
  matte), masks (`srgbLuminance` matte), `opacity` and `mix-blend-mode` on groups, `<image>` (PNG and JPEG, as `data:`
  URLs, nothing written to disk), CSS `transform`, `rotate`, `scale`, `translate`, `transform-origin` on inner elements
  (`transform-box: view-box` only), and `filter="url(#id)"` on any element, including a `<filter>` defined in another
  `<svg>` of the page. The group returned is `passThrough` (no clip, no isolation) unless something reaches outside
  the box, so a `mix-blend-mode` inside blends with what is behind the `<svg>`.
- **The page's cascade reaches the SVG** (`serialize.rs`, `cascaded`): Stylo styles the elements inside an `<svg>` like
  any others, so a rule that crosses from the HTML into it (`[data-composition-id="x"] .bar { fill: #5c5c5c }`,
  `.chart circle { stroke: red }`, `div > svg rect[data-k]`) applies, and a class a script toggles between frames
  restyles the shapes on the next frame. (`text-anchor`, `shape-rendering`, `paint-order`, `clip-rule` and
  `dominant-baseline` are computed because `vendor/stylo` enables them in its Servo build.) Stylo does not read SVG presentation attributes, so a computed value that
  differs from the parent's (from the initial one, for `opacity` and `display`) is the cascade's and is written on the
  element as style, where it beats the attribute; one that equals the parent's is inheritance, which usvg does too, and
  an attribute stands. Properties: `fill`, `stroke` and their `-width`, `-opacity`, `-linecap`, `-linejoin`,
  `-miterlimit`, `-dasharray`, `-dashoffset`, `fill-opacity`, `fill-rule`, `font-family|size|weight|style`,
  `letter-spacing`, `word-spacing`, `text-rendering`, `text-anchor`, `shape-rendering`, `paint-order`, `clip-rule`,
  `dominant-baseline`, `visibility`, `opacity`, `display: none`, `mix-blend-mode`. The
  root takes what the HTML around it passes down (`fill`, the font). Families go through `font-family` as Stylo
  prints them (double quotes and all, escaped as XML); `@font-face` and Google families the page loaded are in the
  request's fonts, so text in the `<svg>` finds them. A `fill`, `stroke`, `stop-color`, `flood-color` or
  `lighting-color` usvg cannot read (`var(--x)`, `oklch()`, `oklab()`, `color-mix()`, `rgb(r g b / a)`, `rebeccapurple`)
  goes through Stylo's colour parser, as an HTML colour does, and is written as a plain `rgb` (`svg/color.rs`); one
  that cannot be resolved is an `Unsupported` item. Tests: `crates/dom/tests/svg_cascade.rs`.
- **Filters** (`filterGraph`, `filter_graph`): all 17 primitives but `feImage`, which becomes a transparent flood and an
  `Unsupported` item. CSS filter functions on an element inside an `<svg>` are `Unsupported` (the box painter does
  them for HTML boxes).
- `Unsupported` items: `feImage`; CSS filter functions on SVG elements; `transform-box` other than `view-box`; a
  skewed or mirrored pattern, image, or filtered element (drawn unturned for the filter); a GIF or WebP `<image>`;
  text when the request registers no font.
- Reads of files (`<image href>`) are limited to `base_dir` and `public_dir`: relative, no `..`, canonical path
  inside the root.
- **Checked against Chrome for Testing 154** (mean difference over the picture, of 255; a pixel counts as different
  above 16): `filterGraph` sheet of 39 filters, per tile 0.0 to 1.9 (the noise ones 1.2 to 2.9; Chrome rounds noise
  positions to whole pixels, and so do we); the same on turned and scaled layers 1.0 to 6.0; the papercut `torn` and
  `rough` filters on `div`s 0.06; the SVG pages: shapes 1.9, features 2.6, text and transforms 1.7. What is left is
  edge anti-aliasing and **blending in linear light**: a translucent layer over another (an `opacity` of 0.93 with
  `multiply`, a mask's fade, the soft edge of a shape) is mixed in linear light here and in sRGB by Chrome, which
  darkens or lightens it by up to 20 levels. That is the engine's rule for layers (`SCENE.md`), not the SVG painter's;
  it needs a compositor-level option to go away.
- `crates/dom/tests/svg_golden.rs` and `crates/core/tests/{filter,svg_paint,golden}.rs` hold the tests; the goldens
  are in `crates/dom/tests/golden` and `crates/core/tests/golden`. `cargo run -p kinetograph-dom --example svg_scene
  -- page.html scene.json W H` makes a scene from the `<svg>`s of an HTML page, to compare with a browser.

### 7.12 CSS gaps: line clamp, floats, tables, containers, transitions

Branch `feat/css-gaps` (2026-10-16). All of it is checked against Chrome for Testing 154 as an oracle (golden cases in
`crates/dom/tests/features.rs`, numbers from `getBoundingClientRect` in `crates/dom/tests/css_gaps.rs`).

**Two vendored crates** (`vendor/README.md` has the details and how to drop each patch):
- `stylo` parses `@container`, the container length units and the `container` shorthand in its Servo build (they were
  `cfg(feature = "gecko")`; the properties were already there behind the `layout.container-queries.enabled` pref).
- `blitz-dom` answers a container's size, restyles the subtree of a container whose size changed (`resolve` is now a
  loop of passes, at most 4 extra), breaks lines around floats as CSS 2.1 9.5 says, and does the table work below.

**`-webkit-line-clamp`** (`crate::clamp`, `paint::ellipsis`). Chrome's legacy box: `display: -webkit-box`,
`-webkit-box-orient: vertical`, `-webkit-line-clamp: N` (nothing else clamps; the unprefixed `line-clamp` does nothing
in Chrome 154 either). The shim mirrors the three properties; after the first layout `clamp::settle` makes the box a
block formatting context (Chrome's `flow-root`), counts lines across its in-flow block children, and gives the box a
`height` that is the bottom of the Nth line when its height is `auto`. The lines after the Nth are still laid out and
painted, as in Chrome (the box's `overflow` hides them). The line that ends the text is recorded in `data-kg-clamp`.
`text-overflow: ellipsis` on a box that clips uses the same code (`Painter::line_cut`): the line is cut at a cluster
boundary (trailing spaces dropped, right-to-left lines not cut and reported) until the ellipsis (`…`, or three full
stops if the font has no `…`) fits, in the font and colour of the text it follows; the decoration stops before it.

**Floats.** Blitz (`floats` feature) already laid floats out; the zoo's "one line more in Chrome" no longer shows. What
was missing: a line whose first unbreakable word is wider than the gap beside a float now moves down to the next gap
that fits or below the floats, and a block's height includes that gap.

**Tables.**
- Layout (vendored `blitz-dom`, `table.rs`): `auto_columns` is the CSS automatic table layout algorithm (what is
  asked, how a span asks, how the width is shared, percentages); captions are laid out inside the table's box, above
  and below the grid, as wide as the grid; a cell's `height` is its border box's and a minimum for its row.
- Collapsed borders (`crate::collapse`): after the first layout `collapse::settle` resolves every grid line's border
  (hidden, width, style, element; cell, row, row group, column, column group, table), gives each cell
  `border-*-width: 0` and half of its resolved sides added to its `padding-*` (and the table half of its outer
  borders as padding), which is Chrome's geometry (a 1 px grid is 1 px shared, a 4 px table border over 2 px cells
  makes the table and the cell take half each), and keeps the resolved borders on the table (`data-kg-cborders`, JSON).
- Painting (`paint::table`): a cell paints the backgrounds of its column group, column, row group and row under its
  own, each in its part's box and cut to the cell (Chrome paints them per cell, so the gap between separate cells
  shows the table's background); the table paints one segment per stretch of grid line, snapped to whole pixels;
  dashed, dotted, double, groove, ridge, inset and outset segments use the box painter's border styles.
- A caption wider than the grid widens the table. Not done: `<colgroup>` and row-group borders only apply at
  the places CSS lists (their group's edges); `domLayoutBoxes` gives rows and groups no box; `empty-cells: hide` is
  not applied.

**`@container`.** Size queries (`width`, `height`, `inline-size`, `block-size`, `aspect-ratio`, range syntax, `and`/`or`/
`not`, named containers, nested containers) and the units `cqw cqh cqi cqb cqmin cqmax` are Stylo's own; the
document gives it the content box of a container's last layout, so the first style pass sees an empty box and the
pass loop in `resolve` corrects it. `container-type: inline-size` does not make a container's own width ignore its
content (an `inline-block` container without a width is as wide as its text; Chrome has it 0 wide). `style()` container
queries are not evaluated.

**CSS transitions.** A transition starts when a style value changes, and a frame is built from nothing, so there is no
"before". The choice: **the caller supplies the past.** `IslandRequest.history` is an ordered list of earlier tree states
of the island (`{ time, root }`, seconds), and `document::resolve` replays them: the document is built from the oldest,
each later state (the request's own last) is applied to it as attribute, `style` and text edits and styled at its time,
so Stylo starts a transition at the **time of the first state that shows the new value** (plus `transition-delay`) and
its progress at `request.time` is a function of the clock alone. A state that adds, removes or retags an element
restarts the replay from it (a new element does not transition, as in a browser). The request is still a pure
function: the same request gives the same frame, whatever was rendered before. Without a history nothing
transitions and every value is its final one (what the engine did before). A history needs only the states where the
island's tree changed within the longest `delay + duration` before `time`, plus the state at the start of that
window. **TypeScript fills it** (`packages/compat/src/dom/history.ts`, `packages/core/src/frame-loop.tsx`): `mapDomIsland`
reads the `transition` times out of the island's CSS (the window is twice the longest time seen) and, while the frame
loop has recording on, keeps the island's request root whenever it differs from the last one kept. The loop renders
every frame with recording on; a sequential render keeps the trail it has, and any other frame (the first, a jump back,
a repeat) renders the frames of the window before it again with the addon off (`warm`), so a frame's history is the
same whichever frames were rendered before it. A project with no `transition` in its CSS pays nothing; one with
transitions renders the window's frames again for a frame that is not the next one. Motion-blur sub-frames use the
frame's history and record nothing. Checked end to end in `packages/core/test/css-transitions.test.tsx` (in order,
alone, backwards, out of order: the same mid-transition values). `@starting-style` entry transitions are not run
(Stylo does not apply starting styles to a first style computation in this build), and a transition that is running when
the style stops declaring one is not cancelled.

## 8. Stream 2 notes (paint)

`crates/dom/src/paint/` turns a styled, laid-out Blitz document into scene layers. `paint(doc, request)` returns the
`IslandOutput`: `layers`, `unsupported`, `camera` (never set: perspective is folded into matrices), and two new
optional fields, `margin` (the least scene `margin`: how far its blurs reach, so a shadow near the canvas edge is
blurred from real pixels) and `blendSpace` (always `"srgb"`: **the scene that holds the island's layers must set
`blendSpace: "srgb"`**, see below).

### What the front half must do

- Every element carries `data-kg-path` (done). The painter takes the layer id from an explicit `id` attribute, else the
  path, and adds `.bg`, `.border`, `.text`, `.shadowN`, `.marker`, ... suffixes, unique per island.
- Run every stylesheet and `style` attribute through `paint::shim_css` and call `paint::register_properties(&mut doc)`
  once per document (`document.rs` does both). This Stylo is the Servo build: it drops `filter: url()`,
  `background-clip: text`, `-webkit-text-stroke`, `-webkit-text-fill-color` and `paint-order` as invalid. The shim
  writes the same value into a non-inherited custom property (`--kg-filter`, ...) that the painter reads back.
  `-webkit-text-stroke` and `paint-order` inherit in CSS, so `paint/text_stroke.rs` takes the nearest ancestor's
  declaration. The stroke is a `stroke` and `paintOrder` on the text layer (SCENE.md, "Text stroke"), drawn by Skia as the
  glyph outlines stroked with a miter join (Chrome's, checked against Chrome for Testing); a text shadow of stroked
  text is stroked too.
- Fonts: a glyph run needs the font file. The painter matches a run's font bytes to a file of `request.fonts` (once per
  font), or to a path registered with `paint::register_font_path(blob_id, path)`.
- Fallback fonts: a character the stack lacks falls back to Noto Sans Symbols 2, Noto Sans Math and Noto Emoji, embedded
  in `kinetograph-core` (`fallback_fonts.rs`, `crates/core/fonts/`, WOFF2). They are registered in every Parley
  collection (`fonts::font_context`, `TextEngine::new`) as the fallback of the common scripts, after the project's own
  families, and in the SVG font database. A glyph run names one `builtin:<name>` instead of a file. A glyph id 0 left
  after fallback is reported by the painter (`font-family`, "no glyph for U+XXXX ...") and by `inspect` (`missingChars`).
  The fallback covers symbols, arrows, maths and monochrome emoji, applied one character at a time to HTML text, SVG
  `<text>`, text layers, Text3D and canvas `fillText`. CJK, Arabic and other scripts are not bundled: load a font that
  has them (`doctor` and `--strict` report the code point until then). `monospace` and `ui-monospace` use a
  registered fixed-pitch font (the `post` table's flag) if there is one, else the bundled JetBrains Mono Regular
  (`fallback_fonts::monospace_face`, SIL OFL 1.1; bold and italic are synthesised). `/docs/known-issues/`.
- SVG files as pictures: `<Img src={staticFile('a.svg')}>`, `<img src>`, `background-image: url(a.svg)`, `image` layers
  and `data:` URLs draw natively (`crates/core/src/svg_picture.rs`), sized from the file's `width`, `height` and
  `viewBox` (300 x 150 with none) and painted at the size they are drawn at. Text inside such a picture is left out and
  warned about (a browser sets it in none of the page's fonts); an unreadable file is reported by `doctor`.
- A DOM measurement the engine cannot answer (`getComputedStyle`, `getBoundingClientRect`) is a warning and the script
  gets the element's own style; `--strict` makes it an error. An element with `transform-style: preserve-3d` that also
  has `opacity`, a filter, `clip-path`, `mask`, `mix-blend-mode`, `isolation`, `contain: paint`, `backdrop-filter` or
  `overflow: hidden` is flattened (as CSS Transforms 2 does) and drawn as a flat group with its effect.
- A canvas (2D, WebGL or WebGPU) starts empty each frame; `preserveDrawingBuffer` does not carry a frame into the next.
  WebGPU on a canvas (buffers, WGSL render and compute pipelines, storage buffers and textures) replays on the engine's
  GPU device; its gaps are in `/docs/known-issues/#webgpu`. `<Video datamosh>` is AUTHORING.md §11.8. Libraries and
  HyperFrames: AUTHORING.md §11.10 and §11.11.

### Paint order

The walk in `paint/mod.rs` is CSS 2.1 Appendix E over Blitz's own paint tree (`paint_children`, `stacking_context`): each
stacking context collects, in `Phases`, block backgrounds, floats, inline content (glyphs, atomic inline boxes, flex
items, replaced content), normal-flow layers (blocks that clip their overflow, painted after the parent's content as
Chrome's paint layers are), outlines, then positioned boxes and z-index lists. Floats, inline-blocks, flex items and
positioned boxes are painted whole. A stacking context is an element Blitz says is one, plus `mix-blend-mode`,
`perspective`, `preserve-3d` and `backdrop-filter`. Positioned boxes and z-indexed contexts inside an `overflow`
container stay inside its clip. The canvas takes the root's (or the body's) background.

### CSS to scene

| CSS | Scene |
|---|---|
| box background colour, solid uniform opaque border | one `shape` with `fill` and `stroke` (centre line) |
| background colour / images, `background-blend-mode` | shapes per layer; a `group` (isolated) when a layer blends |
| `background-size/position/repeat/clip/origin` | `Paint::Image` fill (tiles repeat in the image sampler); one shape per tile for `space`, gradients tiles (up to 150) |
| gradients (linear, radial incl. ellipse, conic, repeating, hints) | scene gradients; an ellipse is a circle with `transform` |
| `background-clip: text` | the layers get a `matte` whose source is white glyph runs |
| `box-shadow` outer / inset | a blurred shape of the shadow colour, cut with `clip` to outside the border box / inside the padding box |
| `border` per side, radii (elliptical), `double`, `groove`, `ridge`, `inset`, `outset`, `dashed`, `dotted` | filled ring paths, side shapes cut by mitre polygons, dashes made with kurbo |
| `border-image` | nine slices as shapes with an image or gradient fill (stretch, repeat, round, space) |
| `outline`, `outline-offset` | a ring outside the border box |
| text, `letter-spacing`, `white-space`, `vertical-align`, inline-block | `text` layers with `runs` (Blitz's Parley glyph positions) |
| `text-shadow`, `text-decoration` | blurred copies of the run; decoration lines as shapes |
| `transform`, `translate`, `rotate`, `scale`, `transform-origin`, `perspective`, `preserve-3d`, `backface-visibility` | `transform.matrix` about the origin; parent perspective folded into the child's matrix; `preserve3d` group; `backfaceHidden` |
| `opacity`, `mix-blend-mode`, `filter`, `backdrop-filter: blur()` | group fields, effects, a see-through shape with `backdropBlur` |
| `filter: url(#id)` | `svg::filter_graph` |
| `clip-path` (inset, circle, ellipse, polygon, `path()`, geometry boxes), `overflow` | scene `clip` (path / polygon / ellipse) |
| `mask-image` (gradients, pictures, size/position/repeat/origin/clip/mode) | a source group of the mask layers and a `matte` |
| `<img>`, `object-fit`, `object-position`, `<video>` | `image` / `video` layers sized and clipped to the content box |
| `<svg>` | `svg::paint_svg` |
| list markers | disc, circle, square as shapes sized as Chrome does; numbers as glyph runs |
| `kg-native` | `{"type": "native", ...}` at the content box |

A last pass (`opt.rs`) drops layers that draw nothing, flattens stacking-context groups that only move their children,
and turns a group of one leaf into the leaf: 280 layers become 200 on a page of 60 transformed cards and 20 boxes.

### `<canvas>`

A canvas is drawn from what its 2D context recorded (AUTHORING.md §6.5): the TS side writes the commands as JSON in
the element's `data-kg-canvas` attribute, and `replaced.rs` makes one `canvas` layer (SCENE.md, "canvas") of them, the
size of the canvas's `width` x `height` attributes (300 x 150 without them) at the content box. A box of another size
stretches it with a flat matrix, so the commands are drawn sharp at the box's size; a rounded box puts the layer in a
group that carries the clip. A canvas nothing was drawn on draws nothing and is not reported. The cases of
`crates/dom/tests/canvas.rs` are Canvas 2D scripts (`tests/canvas/*.js`) that Chrome runs and the engine draws from
the recorded commands (`node crates/dom/tools/canvas-cases.mjs` makes the `.json` files): paths 0.35, gradients, a
clip, composite operations, nested canvases and text 1.96, a stretched rounded canvas 3.4, shadows (soft, hard, under a
transform and an alpha) and each `filter` function 0.80 mean levels from Chrome. A command that carries a `url()`
filter (`unsupportedFilter`, which the context writes because the renderer does not draw it) is reported as an
unsupported `filter` of the canvas, also when it is inside a canvas the first draws.

A canvas with a WebGL context is the same with `data-kg-webgl` and a `glsl` layer (SCENE.md, "glsl"). The core
translates each program once (`crates/core/src/glsl.rs`: a token-level rewrite of GLSL ES 100 and 300 es to the Vulkan
flavour naga's GLSL frontend reads, then naga's IR goes to wgpu directly, with no WGSL text in between, which would
not keep the uniform array strides), and `compositor/glsl.rs` replays the draws into an Rgba8 drawing buffer
(`shaders/glsl_blit.wgsl` then places it on the canvas in linear light). Findings: naga cannot lay out a `matCx2` in a
uniform block, and Metal packs arrays of floats and `vec2`s tighter than the block's 16 bytes an element, so those
travel as `vec4`s; bools are not allowed in a block, so they travel as ints; wgpu bounds each vertex by a whole stride
from the start of its binding, so an interleaved attribute's offset goes in the vertex, not in the binding.
A framebuffer's texture is a second kind of target: the replay makes one render pass for each run of draws to the same
target, in the order recorded. GL's rows count up from the bottom and a texture's first row is its bottom one, so a
program that draws into a texture is translated upside down (`flip_y`: the vertex shader negates `gl_Position.y`,
`gl_FragCoord.y` is wgpu's own) with the viewport, scissor and front face turned to match, and sampling needs
nothing. A frame starts every target zeroed (wgpu's lazy clear), so a target is a function of the frame's own ops.
`crates/dom/tests/webgl.rs` runs four cases (`tests/webgl/*.js`; `node crates/dom/tools/webgl-cases.mjs` records
them) in Chrome for Testing on SwiftShader and natively: gradient 0.004, noise 0.0, texture sampling 0.05 and two
render-to-texture passes 0.002 mean levels from Chrome, none more than 1 level off.
Points, instancing and the copies between buffers are made of the same pieces (`tests/glsl.rs` pins each). A point is
one instance of a six-vertex quad: its attributes advance for each instance (indexed points gather them in the order
of the list first), and the vertex shader's wrapper places the quad after `main` ran, `gl_PointSize` pixels across in
the viewport, clamped to 1..511, with `gl_PointCoord` as a varying at location 15; a point whose centre is outside
the clip volume is dropped, as GL does, and culling does not apply. `gl_VertexID` is wgpu's `vertex_index` (which
counts from the draw's `first`), or the instance index in a draw of points; `gl_InstanceID` is the instance index. An
attribute with `vertexAttribDivisor(1)` is a vertex buffer of step mode `Instance`. `blitFramebuffer` is an op of its
own, one pass (`shaders/glsl_copy.wgsl`) that stretches the source rectangle over the destination with `textureLoad`
(NEAREST) or the bilinear sampler (LINEAR), keeping the rows of the drawing buffer (top first) and of a target
(GL's bottom first) apart; the replay keeps a canvas draw that a blit reads even when a later clear would have
dropped it. `texSubImage2D` into a target is an `upload` op: a pass of its own that submits what is recorded and
then `write_texture`s, so it lands between the draws around it. A frame is a function of its own calls: the context
empties its drawing buffer before each frame, `preserveDrawingBuffer` or not. `renderCanvas` (the addon) keeps one renderer, so a call no longer
opens the GPU: about 31 ms a small canvas before, 1.1 ms after.

A canvas with a WebGPU context (`getContext('webgpu')`, with `navigator.gpu`) is the same again: `packages/scene/src/webgpu.ts`
records the device (buffers, WGSL modules, bind group layouts, render and compute pipelines, bind groups, command encoders with render
and compute passes into `getCurrentTexture()` or into a 2D texture, textures, views and samplers, `queue.writeBuffer`, `writeTexture`,
`copyExternalImageToTexture`, `submit`) and the canvas context writes the `webgpu` part of the
`glsl` layer (`WebGpuContent`, `data-kg-webgl`). A buffer's bytes are shadowed on the JS side and snapshotted when a command
buffer that draws from it is submitted, ids come from content, and the first submit after `resetState()` starts the drawing
afresh, so a frame is the same whichever frames were drawn before it.

A texture is never shadowed: it is the steps that wrote it (a render pass into it, an upload, a copy), in the order the queue
ran them, kept on the device across frames in one log with the canvas's own passes. A step that writes a whole level drops
the earlier steps of that level that nothing read in between, so the log of a page that redraws its textures each frame is
one frame long and a frame is the same alone and in a sequence (a texture drawn with `loadOp: 'load'` each frame is the
exception). Each step carries its own tables; the canvas's recording is the union, with texture ids `t<n>` from creation
order and data (`blobs`) by content hash. Pictures are not decoded on the JS side: an upload names a file, a video file and
time (`VIDEO_FRAME` on the `<video>`, read at `currentTime`), a layer of the shader group, or pixels of an `ImageData` or a
rasterised canvas. `webgpu::validate` (core) bounds-checks every texture size, level, origin and rectangle and the frame's
texture memory (512 MiB, 4096 steps) before anything is made; the JS side checks the same at the call. `compositor/glsl/webgpu.rs`
makes textures from the table, replays steps in order into one command buffer (an upload is a staging buffer copy, so it is
ordered with the passes), decodes pictures (kept by file) and video frames (`VideoDecoder::picture` at
`VideoInfo::media_time`, the same pictures a video layer shows), copies a layer from the group's input texture, and makes the pipelines
(kept by id), builds the buffers from the recording and replays the passes in a command buffer of its own, inside a
validation error scope, into the Rgba8 drawing buffer that `glsl_blit.wgsl` places (a bgra8 canvas is the same colours; the
buffer is flushed first because earlier glsl layers' place passes read it). The dom painter reads every module with naga
(`webgpu::check`) and reports a module that is wrong, a texture out of range, and each call the recorder does not draw (query sets, bundles, depth, multisampling, readback, `rgba16float` canvas range), as an unsupported `webgpu` item of the canvas, every frame; `--strict` fails on them.
A module wgpu then refuses is a warning on stderr and a transparent canvas, never a panic.

WebGPU compute. `createComputePipeline` and `createComputePipelineAsync` record a `computePipelines` entry (module, entry point,
layout ids); a compute pass is a `compute` step (`pipeline`, `bind`, `dispatch` commands) in the same log as the render
passes, uploads and copies, so a frame replays them in the order the page submitted them, in one command buffer
(`webgpu_compute` in `compositor/glsl/webgpu.rs`). A buffer is a shadow of its bytes until a pass writes it (a `storage`
binding in the page's layout, or `var<storage, read_write>` / `texture_storage_2d<_, write | read_write>` in the WGSL of a
`layout: 'auto'` pipeline: `writtenBindings`), then `device.promote` makes it a buffer the GPU writes: its first bytes become a
`writeBuffer` step and from then on `writeBuffer`, `copyBufferToBuffer` and `clearBuffer` are steps too (`gpuBuffers`, ids
`B<n>`), zeroed at replay like a texture. Each log step names what it reads and what it writes (a level or a buffer, whole or
part). A step that writes all of a level or buffer drops the earlier steps it covers when nothing read them in between;
the recording of a frame (`liveStepsFor`) is then walked back from the canvas's passes and keeps only the steps that write
something it reads. A compute pass writes an unknown part of what it binds, so it never covers; a part-write reads what it
leaves, so a page that wants its frame to be the same alone clears (a render pass `clear`, a whole write) what its kernels
write at the start of the frame. A step that an earlier frame (not the first, which is the page's setup) made and that this
frame's picture still depends on is reported in `WebGpuContent.impure`, once for each frame that reads it, as WebGPU state a
page carries from frame to frame; the frame is then drawn from the replayed history in a sequence, and differs alone.
`webgpu::validate_with` bounds-checks every buffer step, bind group entry (usage by layout, size, offset alignment,
format against the layout's `sampleType` or storage format, one level for a storage texture), layout (storage formats and
access, stages, counts against the limits) and dispatch (each dimension; at most 4096 dispatches and 2^26 workgroups in a
frame), and `check_with` reads the workgroup size of each compute entry point with naga; the page side throws for the same.
`device.limits` and `adapter.limits` are `webgpu::device_info` of the engine's device (the `webgpuDeviceInfo` function of
the addon opens the GPU once), `float32-filterable` is requested of the adapter so that 32-bit float textures can be
filtered where the hardware does, and a `requestDevice` for better limits is refused. A texture is made with
`STORAGE_BINDING` only when the recording has a compute pipeline, a storage texture layout or a `texture_storage_` module,
and only the usages its format allows. Atomics whose result depends on the order invocations run in are not made
deterministic by the engine. HyperFrames' runtime
(`core/src/hyperframes/runtime.tsx`) dispatches `hf-seek {time, waitUntil}` each frame and holds the frame on a
`delayRender` until the page's promise settles; that is how the `shaders.iife.js` blocks (shaders.com on TypeGPU, which draw
one full-screen triangle with a uniform buffer) are driven from the frame number. Measured against HyperFrames' own stills,
`ripples` and `swirl` are identical at 0, 25, 50, 75 and 100 % of the run (mean absolute difference 0.0, 0 % of pixels more
than 16 off); a frame drawn alone, in sequence and by two workers has one hash.

### Not drawn (reported as `Unsupported`, `audit.rs`)

`image-rendering`, `background-attachment: fixed`, `box-decoration-break: clone`, non-horizontal
`writing-mode`, multi-column, the old `clip`, `list-style-image`,
form controls, iframes, `evenodd` clip paths, `shape()`,
`mask-composite` other than add, `backdrop-filter` functions other than `blur()`, a `margin-box` clip reference, a
`conic-gradient` in a colour space other than sRGB, remote URLs, fonts that are not project font files, inside list
markers in the bundled bullet font.

### Against Chrome (`crates/dom/tests/features.rs`, `target/paint-tests`)

Each case renders the same HTML in our painter and in Chrome for Testing 154 (a test oracle only) and prints the mean
per-pixel largest-channel difference (0 to 255) over the whole picture; text and anti-aliasing differ by design.
With `blendSpace: srgb`: blend modes 0.35, clip paths 0.21, preserve-3d cubes and backface 0.22, paint order 0.17,
clipped positioned boxes 0.16, transforms 0.28, tiled backgrounds 0.38, shadows 0.55, filters 1.1, lists and outline
1.3, gradients 1.6, border images 2.6, borders 3.6 (dotted dot spacing), `background-clip: text` 5.0 (synthetic bold),
text 13 (Chrome's heavier text rendering), masks 22 (Chrome blocks a `file:` mask picture, so the other three agree).
The same cases blended in linear light were 3 to 15 times worse for anything translucent (shadows 8.4, filters 4.6).

### Scene changes

`TextLayer.runs` / `boxWidth` / `boxHeight`, `Transform.matrix` / `backfaceHidden`, `Paint::Image`, scene
`blendSpace` (all in packages/cli/skills/kinetograph/references/SCENE.md, "Boxes from the DOM painter"), `data:` URLs as image sources, `Gradient.transform`
(stream 3's, also used here). Core goldens are unchanged byte for byte.

### Known gaps and findings

- Gradient tiles and `space` tiles are one layer each, limited to 150; a CSS grid made of `linear-gradient` tiles over a
  big box is reported. A tile pattern needs a pattern paint of a rendered tile.
- `blendSpace: srgb` converts at every composite (a power function per pixel in the blend pass); blurs and colour filters
  stay in linear light, so a blurred translucent shape is not exactly Chrome's.
- Synthetic bold is a stroke of a 48th of the size; Chrome's is a little heavier.
- A hoisted z-index context inside a context that Blitz does not know (`mix-blend-mode` only) is listed in the nearest
  context Blitz does know.

## 11. Stream 5 notes

> **History.** This section and section 12 were written when Vello drew the 2D layers: its pages, to-linear passes,
> vendored patches and numbers describe that renderer, which has been removed (Oct 2026). Skia (Graphite on Metal, or
> Vulkan on Linux and Windows) now draws every 2D layer, and the wgpu path draws what Skia cannot (scene3d, GLSL,
> mesh gradients, `preserve3d` groups). The compositor passes, the layer cache and frame reuse below still apply.

Branch `perf/gpu-passes` (from `perf/gpu-pass-timing`, `feat/full-engine` merged in). Compositor internals only; every
change below draws the same bytes as the build before it, checked on 34 scenes (`crates/core/tests/scenes`,
`examples`, the S04 JSON port, all frames; `examples/frame_hashes.rs` prints a hash per frame) against the build
before the stream, and by the goldens.

### Results (M4, 2026-10-15)

S04 (89 frames, 1080x1920), whole `kinetograph render`, interleaved rounds, load average 3–6 (other jobs share the
machine; mins and medians of 4 rounds):

| | min | median |
|---|---|---|
| Remotion 4.0.530, `--gl=angle`, on AC power | 8.86 s | 8.96 s |
| Kinetograph before the stream | 2.68 s | 2.72 s |
| Kinetograph after | **1.25 s** | **1.28 s** |
| speedup against Remotion | 7.1x | 7.0x |

The two videos decode to the same 89 frames (md5 of the frame md5s). Per frame (`frame_hashes --times`, min of 5): 25.8
to 11.4 ms. Passes a frame (`bench --passes`): 278 to 113. The first of
the four rounds was a cold start for all three (Remotion 11.13 s, before 2.92 s, after 2.51 s); the others were 8.86–9.15
s, 2.68–2.74 s and 1.25–1.41 s.

### What was done

1. **Inset shadow with no blur and no spread, one pass** (`fs_inset_inverted`): the spread pass only inverted the alpha;
   the shadow pass inverts where it reads. Byte-identical needs the half-float store emulated: **Apple GPUs round a
   float to Rgba16Float towards zero, not to the nearest** (`examples/f16_probe.rs` checks a million values against the
   hardware), so `store_f16` (shaders/f16.wgsl) steps down when `pack2x16float` rounded up. Outside the canvas
   texture the inverted alpha is 0, as the texture it replaces ended there.
2. **Leaves cut out of their Vello page when wanted**, each page with its own target texture (pooled by size, kept
   for the frame): no to-linear for a leaf the layer cache supplies, no submit before a page is drawn. This replaces
   the plan's "one to-linear pass per page" (see Rejected).
3. **`blend_many`**: drawn layers wait in a list and are composited up to seven to a pass, each pixel in order, the
   canvas rounded to half floats (`store_f16`) between layers as the textures of separate passes were. Flushed
   when the canvas is wanted as it is (a backdrop blur, a preserve3d group), at 16 waiting and at the end of the list.
   A pass is not built when its box would be more than twice what its layers cover plus 64x64.
4. **Pages** drawn from the canvas's top left corner only as far as their leaves reach (the tile grid and the
   transforms do not move, so the pixels are the same; a translated draw would round differently), and leaves packed by
   DSATUR colouring (largest area first past 600 leaves).
5. **A leaf with a sharp inset shadow** is cut out and shadowed in one pass (`fs_inset_page`); a clipped leaf is cut
   out and masked in one (`fs_leaf_clip`); **a plain leaf** (no effects, mask, matte, any separable blend mode) is
   blended straight from its page, with its clip's page if it has one: `blend_many` slots take a texture or a page leaf.
   Such a leaf has no texture for the layer cache, which is told only what it was made from (`LayerCache::note`); a
   leaf that is unchanged the next frame is drawn the old way and cached from its third frame on.
6. **Vello** (vendored, `vendor/README.md`): its dispatches share one compute pass instead of a pass each (about 17
   a page), and its MSAA mask table is computed once.
7. **Clip shapes are page leaves** (white, packed with the others), a command buffer is finished and submitted in
   pieces of 512 passes (one of thousands is rejected by the driver with no error), and page targets are sized to
   their area.

`Renderer::set_pass_fusion(false)` turns 1, 3 and 5 off; `tests/fusion.rs` renders `tests/scenes/passes.json`,
`blend-runs.json` and six seeds of 150 random shapes (strokes, alphas down to 3, rotations, clips, sharp inset shadows,
blend modes, opacities, groups, drop shadows) with it on and off and compares the bytes.

### Rejected or not done

- **One to-linear pass per page** (the plan): a page's leaves would land in one shared texture, and every consumer
  that reads past a texture's bounds (blur, shadows) would see the other leaves' pixels; copying them out costs a
  copy each. Converting only what is wanted, and fusing the conversion into its consumer, removed the pass instead
  (S04: 82.8 to 1.9 a frame).
- **Closed-form inset shadows for rect shapes** (erf): S04's are all blur 0, where the exact path above is a single
  pass for any shape (paths included) and byte-identical; an erf form would only be within tolerance. Not built.
  Inset shadows with a blur or a spread still take the spread, blur and shadow passes.
- **Hardware blending for `blend`**: its result is not bit-for-bit the shader's (the shader unpremultiplies and
  multiplies back), so not byte-identical.
- **Translating a page's draw** to its leaves' box: Vello's f32 transform rounds differently, flipping a few
  samples of the 16 a frame.
- **Finishing command encoders on other threads** (wgpu encodes to Metal at `finish`): no change in time on the
  papercut frame, and holding many finished buffers before submitting made wgpu report a buffer invalid. Reverted.
- **Fusing blur's pad pass into its first Gaussian pass**: the blur reads through the hardware's bilinear filter, whose
  8-bit weights cannot be reproduced exactly.

### What is next

S04's remaining cost: 113 passes (22 `blend`, 16 + 8 + 3 blur, 8 displace, 8 drop shadow, 26 inset shadow), about 20
Vello pages a frame at 0.3–0.5 ms each, and the encoder cost per Metal render pass (about 25 µs of CPU each, in
wgpu's `finish`). Fewer pages needs fewer overlapping leaf boxes; the painter can help (below). The inset shadow with a
blur or a spread, and groups with `displace` + `dropShadow` (full-canvas filtered passes), are the next passes to merge.

### The papercut frame (episode 13, frame 30, 6,828 layers)

Scene JSON from `engine/runtime`'s CLI (`source.frame(30).sceneJson`), measured with `engine/runtime` merged into a
scratch branch of this one. `frame_hashes --no-cache`, ms a frame, load 5: **990 before the clip and page-blend work
(which is this stream's S04 work already on it) to 500**, same bytes (hash `b9f451ea436b688e`). The "5 to 10 s" stream 4
saw was a frame on a machine with a load average of 20–30 from other jobs; at load 1 the frame took 1.4 s before this
work. Where the time went: 1,098 layers have a clip, and each had a Vello render of its own over the whole canvas and
a mask pass (1,098 extra renders, 80% of the main thread); 3,749 to-linear passes, 1,803 blends; 9,135 passes in all,
4,615 now. The deepest stack of leaf boxes at one pixel is 404, so there are about 450 Vello pages however they are
packed.

What the painter could change (stream 2, `crates/dom/src/paint`), in order of what it saves:

1. **Inset box shadows are emitted as a ring path with a clip** (`...insetshadow0`: an outer rectangle 2 px past the
   box, an inner rounded rectangle for the hole, clipped to the padding box): 962 of the frame's 4,847 leaves, each
   with a clip leaf. Emit them as an `insetShadow` effect on the box's background layer (blur 0, the offset, the colour;
   the compositor draws that in the pass that cuts the background out), or as one path already cut to the box. That is
   about 1,900 leaves and 960 clips fewer, and the page depth falls with them.
2. **Groups with no effect, clip or opacity** (1,978 here) could be left out; the compositor flattens them, but
   each still costs a walk and a cache key.
3. **Per-element clips that equal the layer's own box** (the 260 `M0 0 L60 0 L60 18 L0 18 Z` clips on rings) are the
   same shape as the ring's hole boundary and could go with item 1.

**Tried (`fix/corpus-leftovers`, same frame 30, M4, load 5 to 10; `frame_hashes --no-cache --times 0 5`, ms a frame
over six frames, min of interleaved runs, two series run at different loads):**

| | ms a frame | groups | shapes | picture |
|---|---|---|---|---|
| before | 681.7 (series 1, 6 runs) | 3204 | 4187 | hash `6770cdbe1afd638d` |
| groups left out (item 2; kept) | 683.9 (series 1), 656.5 (series 2, 5 runs) | 2564 | 4187 | same hash |
| and inset shadows as effects (item 1; not kept) | 655.9 (series 2) | 2564 | 3381 | 149 825 pixels differ, 12 484 by more than 2 levels, at most 31 |

(The frame costs 650 to 700 ms here against the 500 above because of the machine's load.)

- **Groups.** `paint/opt.rs` drops a group that has only `id`, `type`, `children` and possibly an `x`/`y` move (the
  move is added to the children's positions) when no child blends, is matted, or is a pass-through or `preserve3d`
  group, and the group is not a matte source. 640 of the 3204 go. Most of the 1,978 cannot: 968 are the `bg` groups
  that isolate the `background-blend-mode: multiply` of the grain over the colour, and 795 have a 2D matrix of scale
  and move that would have to be composed into every child. The picture is the same bytes and the time is the same:
  the compositor already drew these groups without a buffer, so a walk and a cache key were all they cost, too little
  to see in 680 ms. Kept because it is exact; drop the commit if the code is not worth it.
- **Inset shadows.** Of the 962, 806 sit on a box with no border, an opaque colour that fills it, no spread and no
  blur (`inset 1.5px 1.5px 0 #ffffff38`), so they can be an `insetShadow` effect of the box's `bg` (a group: the
  colour and the grain, which blends). Tried: 806 ring shapes (and their clips) fewer, 3381 shapes instead of 4187,
  and the time within noise (the two interleaved series have pairs from 43 ms faster to 112 ms slower; the mins differ
  by 0.6 ms). The picture is not the same: 12 484 pixels differ by more than 2 levels, along the edges of the laptop
  and the cards (the likely causes, not checked: the effect's reach raises the scene's margin, which moves what the blur
  and displace passes sample, and the effect shades from a coverage texture sampled at a fractional offset). Not kept.
  The other shape the note allowed, a ring whose outer outline is the padding box so that no clip is needed, only
  fits a centred shadow (no offset, spread at least 0); the corpus' are offset, a crescent that needs the clip. So the
  leaf count (a stack of 404 leaf boxes at one pixel, about 450 Vello pages) is not what the 680 ms is made of: cutting
  800 leaves did not cut the time. The next measurement should be a profile of `start_frame`, not another painter
  change.

## 12. Incremental frames (`perf/incremental`, 2026-10-22)

Goal: stop redoing what did not change between frames. What was found, measured on the M4 with `KINETOGRAPH_PROFILE`
(per-frame stage rows; `n_*` are the DOM island thread's stages, `cache_hits`/`cache_misses` the layer cache's):

- **The island documents** were thrown away every frame (`IslandCache` was emptied at each pass). Passes in sequence
  now carry them over (`IslandCache::resolve`: pass `n+1` after `n` keeps the islands `n` rendered, any other number
  empties the cache; `compat/dom`'s `breakSamplePasses` skips a number when a frame does not follow the one before).
  97% of island renders edit a kept document (`n_built` 1.63 -> 0.12 a frame); the island thread's work falls from
  5.8 to 2.9 ms a frame. `KINETOGRAPH_NO_INCREMENTAL=1` turns it off. This exposed two bugs in the edit path that
  a fresh build never hits: `repaint_transforms` updated one group of an element painted as two (see below), and
  layer ids made from Blitz's node id (`n4294967481`) change when a restyle makes a node again; nodes with no
  `data-kg-path` are now named by their place under the nearest ancestor that has one (`$0.0!a0.text`).
- **Video decode** moved off the render thread: after a frame takes a picture, a thread decodes and converts the next
  one (`VideoDecoder::prefetch`), so frames 300-400's `plan_pages` falls from 1.4 to 1.0 ms a frame on average (the
  11 ms spikes were video leaves). `KINETOGRAPH_NO_PREFETCH=1` turns it off.
- **Overlap.** `Renderer.startFrame` and `VideoWriter.pushFrame` queue the scene parse and the GPU start on a thread of
  their own, so the JS of frame N+1 runs while N is started (`KINETOGRAPH_SYNC_START=1` gives the old order). Worth
  0.5-1.6 s of wall at one worker, nothing measurable at four. Errors of a queued frame come from `finishFrame`, or
  from the next `pushFrame` or `finish` (packages/cli/skills/kinetograph/references/AUTHORING.md).
- **The layer cache cannot do more here.** In frames 140-150, 158 of 167 layers are byte-identical to the frame before,
  yet 1-3 of 140-200 lookups a frame hit: the groups around them animate a scale (`matrix`) every frame, and a group's
  children are rasterised at the final matrix, so the parent matrix is in every key. No group changed by a
  translation alone in either shot, so a whole-pixel-translate reuse would find nothing; and a Vello draw moved by a
  translation rounds differently in f32 (section 11, "Translating a page's draw"). In the blur shot (frames 800-1000)
  the `wall` group (321 children) zooms with 10 motion-blur samples: every sample is a new draw, and 22 islands a frame
  are rendered for the samples (JS 40 ms, `start_frame` 20 ms). Samples of an island often differ only in a transform;
  `request::delta` (comparing every layer with the first sample's) is about as costly as the island's resolve there.

**A third edit-path bug: baselines lost to taffy's cache** (fixed). Launch film frames 180 and 181 drew the caption word
`screenshotting` differently when frame 179 had been drawn just before (a document edited) than when the render started
at 180 (a document built). Only the SVG doodle beside the word changed between frames (a `stroke-dashoffset` on a path);
the word's own box did not. The edit restyles the `<svg>` and clears the layout caches of its ancestors, but the cache
of the sibling inline-block that holds the text stays. Taffy's size-only cache (`ComputeSize` entries) keeps a box's
size and drops its baselines, so when the parent's inline layout measured that sibling again it got a hit with no
baseline, put the box on the line as if it had none, and the line, the flex row round it (`align-items: baseline`) and
everything under it came out 5 px taller (the box sat on the baseline by its bottom edge, and the line's own descent
came below it). A fresh document has empty caches, so
the first measure computes the baseline and nothing is wrong. Fix: `layout/inline.rs` in the vendored `blitz-dom`
(`vendor/README.md`): an inline box measured with no baselines is laid out in `PerformLayout` mode, which the cache
keeps whole. Test: `an_edited_svg_beside_text_leaves_the_line_as_fresh` (`crates/dom/tests/samples.rs`).

**An element painted twice** (not fixed): an inline-block with a stacking context (a `transform`, say) in a line of text
is painted twice, as `$0.0.1` and `$0.0.1~2`, identical layers, so its antialiased edge is drawn at double alpha and it
costs double. Cause: `Painter::walk` (`paint/mod.rs`, the children loop) paints a child with `is_sc` (or `positioned`)
through `paint_context` (`paint_atomic`) into `pos` before it looks at `inline_level`, and `paint_inline_root`
(`paint/text.rs`, the `InlineBox` arm) paints the same box again into `pos` while walking the lines. A line-level box
without a context is painted only from the lines. Reproduce: a `div` with text `ab` and a `span` with
`display: inline-block; transform: scale(0.5)` gives `["$0.0.text","$0.0.1","$0.0.1~2"]`. The end card of the launch film
(`kinetograph.` with a scaled full stop, frames 1386-1520) has it.

## 13. HyperFrames colour grade and readback caching

**`colorGrade` effect.** A DOM element can carry a per-element colour pass. `data-kg-grade` (JSON, written by
`core/src/hyperframes/grading.ts` from `data-color-grading`) makes the element a stacking-context group; the painter
(`paint/grade.rs`) pushes `{"type": "colorGrade", ..., "box": <content box>}` first on the group's effects.
`crates/core/src/grade.rs` normalises it and builds the 1024 x 3 RGBA8 table of curves, hue curves and secondaries the way
HyperFrames does (8-bit rounding included); `shaders/color_grade.wgsl` is HyperFrames' fragment shader in one pass: primary grade, wheels, RGB
curves, hue curves, secondaries, `.cube` LUT (3D texture, shared with the `lut` effect's upload; its trilinear blend is HyperFrames' own and stays, the `lut` effect's `interpolation: 'tetrahedral'` is not used here), the mix by `intensity`, grain, vignette. The
vignette and grain are laid out on `box` in layer space, with HyperFrames' bottom-up `gl_FragCoord`. The grain seed is
`hash(element id | src | tag:index) + floor(time * 60)`, computed in TS, so a frame does not depend on the frames before it. A
layer with this effect leaves Skia's path (`own_gaps`) for the wgpu compositor. A LUT path is resolved by the painter against the project
(unreadable files drop the `lut` and report). Measured against HyperFrames' Chrome stills (`hf-grade` chart, 3 frames): basic 0.027, tonal 0.028, curves 0.022, hue curves
0.029, secondaries 0.019, LUT 0.114, vignette + grain 0.024 mean levels, 0 % of pixels more than 16 off. The `effects` list is not drawn.

**Readback caching.** `domComputedStyle` and `domLayoutBoxes` (`crates/node/src/dom.rs`, `with_readback_island`) keep the island of
the last call per island thread: the same request text is answered from the kept document (no parse, no restyle); a changed
one is edited to the new tree through `IslandCache` (`changes`/`apply`), as motion-blur samples are. `claude-exchange` frame 0:
12.5 s before, 1.7 s after (release build), same pixels.

## 14. Motion tracking (`crates/libmv-sys`, `crates/track`)

Blender's tracker, not a new one: libmv's `AutoTrack` with Ceres and Eigen, copied unchanged from Blender 4.5 LTS
(`vendor/libmv`, vendor/README.md) and built by the `cc` crate into the addon (about 1.2 MB). Blender's own C API around
libmv is GPL and not used; `crates/libmv-sys/csrc/kt_libmv.{h,cc}` is ours (MIT-clean), and `kinetograph-track` drives it
the way Blender's `tracking_auto.cc` drives libmv (reimplemented from that behaviour): markers placed with Blender's
pattern and search squares, frames handed over bottom row first as Blender's image buffers are, grayscale from the 8-bit
RGB of the search region only, keyframe or previous-frame matching, the margin check before each step, a failed step
ending the track. Frames come from `kinetograph_core::video::VideoDecoder`, the render's own decode path, with a small
LRU (the keyframe stays; backwards runs decode forwards in chunks of up to 16 frames, one seek each).

It is precomputed: `kinetograph track` writes `<video>.track.json`, and `useTrack()` (packages/core/src/track.ts) only
reads it, so a frame is still a pure function of (project, frame). Repeatable bit for bit on a platform
(`crates/track/tests/golden.rs`, a golden per platform); not bit-equal across platforms. Parity against Blender run
headless: `scripts/track-parity/`.

Two more of Blender's tracking tools, rebuilt the same way (from the manual and from running Blender; its GPL code is
not used), each over libmv's MIT code:

- **Detect Features** (`crates/track/src/detect.rs`): `libmv::Detect` with the Harris detector
  (`vendor/libmv/libmv/simple_pipeline/detect.cc`, built without FAST). The C API (`kt_detect_harris`) takes the frame
  as Blender's image buffer holds it, RGBA rows bottom first, each byte over 255; libmv makes it grey. The operator's
  defaults (margin 16, threshold 0.5 passed as 0.5 / 100000 in f32, minimum distance 120), features turned into
  normalised positions `(x + 0.5) / size` and added in the reverse of libmv's order, and the annotation placement as an
  even-odd polygon test in normalised f32.
- **Plane tracks** (`crates/track/src/plane.rs`): the corners start as the bounding box of the tracks' patterns at the
  placing frame (f32), or as given; then frame by frame, forwards and then backwards, libmv's
  `EstimateHomography2DFromCorrespondences` (default options, `kt_homography`) over the tracks' normalised f32
  positions on both frames, the matrix rounded to f32 and each corner multiplied by it unfused in f32, as Blender
  stores both. Blender keeps the estimate whether or not Ceres calls it usable, and so does this. The point pairs
  include the disabled markers Blender leaves at a track's ends (`Normalised` in `lib.rs`: one frame before the placed
  marker, the frame after the last marker, and one more after a failed match but not after the margin check), which
  is why Blender's planes reach a frame past each end of the tracked range; frames outside the clip are left out.
  Corners are written as f64 (exactly Blender's f32 times the frame size).

`track_clip` (`kinetograph track`) runs them in Blender's order: detect at the placing frame, track every point, make
the planes. Blender parity: detected features identical in position and order, plane corners bit-equal on every frame.

