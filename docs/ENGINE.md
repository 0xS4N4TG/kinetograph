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
  shifts it, as before), at any depth. A native element that makes no layer (`<Camera>`, `<Audio>`) is dropped.
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
- The Chrome fallback bundle puts the same text in `<style>` elements, so `doctor --compare` references have the CSS.

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
  `polygon` use the path functions of `@kinetograph/core/paths` (handed over by `web/install`); a group's `getBBox` is
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

`@kinetograph/core/web/install` (imported by the Node bundle after the determinism shim; not in the Chrome bundle) puts
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
- `document`: `createElement` (a detached node, never drawn), `createElement('canvas')` and `getContext` throw
  "canvas is not supported yet", `body`/`documentElement` with the composition's size, queries over the host tree,
  `fonts` (the `FontFace` shim);
- `Element`, `HTMLElement`, `SVGElement`, `HTMLImageElement`, `DOMRect`, the three observers.
- `crypto.getRandomValues` and `randomUUID` draw from the seeded `Math.random` generator.

Time: `Date`, `performance.now`, timers and `requestAnimationFrame` were already driven by the frame
(`core/src/determinism.ts`); `requestAnimationFrame` callbacks run once per frame with the frame time, before the frame
renders. CSS `@keyframes` animations and transitions read `request.time`; nothing in TypeScript reads a wall clock.

### 10.5 doctor and the corpus harness

`doctor` reports the unsupported items Rust returns, plus a "stylesheets" note for what the bundle could not do.
`--compare-every N` samples the first frame of the range and every Nth after it; `--compare-dir DIR` writes each sampled
frame's native picture, Chrome's, and their difference (x4) as PNGs; the comparison counts pixels more than 2 levels
apart and, separately, more than 48 (what is left after anti-aliasing and text rasterisation).

`scripts/corpus.mjs` runs `doctor` on the episode 13 papercut project and prints: native frames of the total, the
unsupported items with their frame counts, and with `--compare` (default every 30th frame) the per-frame differences;
it writes `out/corpus/report.json` and the pictures.

#### First numbers (2026-10-15, M4)

Measured with `engine/runtime` plus `engine/paint@6fa5b1c` (which has `engine/front` and `engine/svg` merged in), and
one local change in `crates/dom/src/paint` that is not in any branch yet: the painter did not leave the
`{"type": "native", ...}` placeholder layers the contract promises (`kg-native` nodes are replaced boxes: emit
`{"type":"native","path","x","y","width","height"}` from `replaced_content`), without which every frame with a
`<Sequence>`, `<Audio>` or other native element inside DOM loses its content. `node scripts/corpus.mjs --reference
--every 30`, 199 s:

- **Native frames: 988 of 988.** This number means little yet: the painter reports no unsupported item on any frame
  (`unsupported` is empty everywhere), so it counts frames, not fidelity. Chrome frames: 0.
- **JS stage** (React render, emit, request, Rust style/layout/paint, JSON), the whole episode through `doctor`: about
  60 s, 60 ms a frame (frames 30 to 50: 224 ms a frame, 138 ms of it in `renderDomIsland`, 3 islands a frame, 430 KB
  of request and 480 KB of answer; frames 500 to 520: 133 ms, 84 ms in Rust). Rust is about 65% of it; React in
  development mode is about 25 ms of the rest (`NODE_ENV=production` would save roughly half of that, at the price of
  React's minified error messages, so it is not set). A native frame of the corpus, drawn by the GPU, takes 5 to 10 s
  (6661 layers at frame 30): the compositor's, not this stream's.
- **Against the real Remotion render** (`out/mods-papercut.mp4` in the project, the same 988 frames and sources, H.264
  so a few levels of noise everywhere): mean difference 4.2 to 28 levels (median 5.9), PSNR 15.8 to 29.0 dB, 8755 to
  384196 pixels (0.4% to 18.5% of 2 073 600) more than 48 levels apart, 3 559 263 summed over the 33 sampled frames. The
  worst frames are 600 and 630 to 810 (the S08 rip and S09 scenes: the native frame has the crack and a cream panel
  at the left that the Remotion frame does not; the Chrome fallback's picture has the crack too, so the mp4 may not be
  frame-exact there). The best are 840 (8755), 210 to 330 and 900 to 960 (14 860 to 37 426).
- **Against the Chrome fallback's own picture** (`--compare`, a page of our own, not Remotion's) the differences were
  larger and mean little: its `Sequence` wrapper is a zero-size positioned `div`, so at frame 840 its picture is
  shifted down by half the height.

What to fix first, from the pictures (not from `doctor`, which has nothing yet): `filter: url(#...)` on the tape banners
and signs (the text is clipped to the filter region, "DELET" and "GUAR"), the SVG filters (`rough`, `torn`), the
grain texture and multiply blend of the paper, and the rip transition's clip.
