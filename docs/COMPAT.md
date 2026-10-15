# Remotion compat mode (Phase 5)

Written 2026-10-15 by the Phase 5 orchestrator (`HANDOFF.md` §8, "Phase 5 in the same cloud session"). It is the
contract the four Phase 5 streams build against. It covers:

- which DOM elements and inline CSS properties map onto which `SCENE.md` layers and effects;
- what counts as unsupported;
- the rule that sends a frame to headless Chrome instead.

`AUTHORING.md` §1's rules hold. The stubs committed with this file have final names and types; streams fill their
bodies and may add exports. Changes to this file go through the orchestrator.

Compat mode is not a switch. The reconciler accepts DOM host elements (`div`, `span`, `img`, `svg`, …) next to the
native `kg-*` ones, so an unported Remotion project renders as it is. What this file maps is drawn natively; a frame
holding anything it does not map is drawn by Chrome.

Scope comes from the first real corpus, the papercut kit: inline `style` objects and SVG. `className`, stylesheets
(Tailwind, CSS modules, styled-components) and `<style>` elements are out of scope for this pass. They are reported as
unsupported.

## 1. Layout and ownership

| Path | Owner | What |
|---|---|---|
| `packages/compat` (`@kinetograph/compat`): `src/types.ts`, `src/runs.ts`, `src/index.ts` | orchestrator (complete) | `Unsupported`, `DomNode`, the run planner (§6.1) |
| `packages/compat/src/css/` (`@kinetograph/compat/css`) | stream 1 `feat/compat-css` | pure parsers: inline style values → typed values and diagnostics (§3). `css/types.ts` is committed with this file. |
| `packages/compat/src/dom/` (`/dom`); the DOM parts of `packages/react/src/{root,emit}.ts`; `packages/core/src/fill.tsx`; `crates/core/src/dom_layout.rs`; `crates/node/src/dom.rs` | stream 2 `feat/compat-dom` | DOM host elements → layers (§4), the addon's `layoutDom` (§5) |
| `packages/compat/src/browser/` (`/browser`); `packages/cli/src/fallback/`; the `--compat` option of `render`, `still`, `strip`; `crates/node/src/raw.rs` | stream 3 `feat/chrome-fallback` | the Chrome bundle and driver, `videoFrame`, `VideoWriter.pushRgba`, the split render (§6) |
| `packages/compat/src/doctor.ts`; `packages/cli/src/commands/doctor.ts`; the `lint` and MCP wiring | stream 4 `feat/doctor` | `kinetograph doctor` (§7) |

Dependencies point one way: `scene` ← `compat` ← `react` ← `core`. `compat` imports no React and no addon; the
addon's `layoutDom` is handed to it with `setLayoutDom`, as `layoutText` is handed to core. `/browser` takes `react`
and `react-dom` as peers.

## 2. The pipeline

```
React tree with DOM host elements (div, span, svg, …) and native ones (kg-*)
  reconciler (root.ts): DOM elements become host nodes keeping their props, as kg-* ones do
  emit, per frame: each outermost run of DOM nodes is a DOM island, handed to mapDomIsland (compat/dom):
     css:    parseStyle(style) for each node                        (stream 1, §3)
     layout: layoutDom(island) in the addon, taffy + Parley         (stream 2, §5)
     map:    the laid-out boxes → plain layers with constant numbers (stream 2, §4)
     report: every element, property and value the map cannot draw → RenderedTree.unsupported
  frame loop: FrameResult.unsupported
  render: frames with no unsupported item → the addon; the others → Chrome (stream 3, §6); one encoder, in order
```

```ts
// @kinetograph/compat (types.ts)
type DomNode = { kind: 'element'; type: string; props: Record<string, any>; children: DomNode[] } | { kind: 'text'; text: string };
interface IslandContext {
  path: string;                                   // the island root's host-tree index path ($0.2)
  viewport: { width: number; height: number };    // the composition's size
  fonts: Record<string, string>;                  // getFonts()
  /** Emits a native (kg-*) element found inside the island, as the reconciler would at that path. */
  emitNative(node: DomNode, path: string): LayerJson | null;
}
interface IslandResult { layers: LayerJson[]; unsupported: Unsupported[]; camera: CameraJson | null }
function mapDomIsland(root: DomNode, context: IslandContext): IslandResult;      // compat/dom, stream 2
```

- **What a project brings with it.** A Remotion project is bundled as it is, with these allowances:
  - `import './index.css'` (Tailwind's entry, say) bundles to nothing: stylesheets are not read, so a `className`
    draws nothing.
  - The entry runs even when the project's package.json lists `"sideEffects"` without it, as Remotion's templates do.
  - `staticFile` reads `public/` beside the entry, else `public/` beside the nearest package.json (Remotion's place,
    with the entry in `src/`).
  - `@remotion/media`'s `<Audio>` and `<Video>` are the engine's.
  - `new FontFace(family, "url(...)", { weight, style, unicodeRange })` with `document.fonts.add(face)` registers the
    file (`registerFont`). One file is kept per family, weight and style; of a face split by `unicodeRange`, the one
    covering basic Latin. WOFF and WOFF2 files are unpacked by the text engine (`wuff`).
- **The containing box.** A DOM island is laid out as CSS would lay it out in a box the composition's size, as
  Remotion's root `div` is. A layout box from an enclosing native `<Layer layout>` is not known in TS (taffy computes
  it in Rust at resolve time), so an island inside one is laid out in the composition's box all the same.
  Every top-level layer an island emits carries `layoutItem: { position: 'absolute' }`, so a native flex parent
  (`AbsoluteFill`'s column, for one) does not move it again.
- **Native elements inside DOM.** A native element inside a DOM element is a replaced box of its own box's size. A
  layer without a box (a group without `layout`) is 0 × 0. It is placed by CSS and drawn as it is.
- **Constants.** Every number the mapping emits is a constant. DOM styles are read at the frame, so animation comes
  from the component re-rendering, as in Remotion.
- **Ids.** The layers a DOM node expands into have ids derived from the node's id. That id is the explicit `id` prop
  if it is a valid layer id, else the host-tree index path (AUTHORING §6.3). The suffixes are listed in §4.

## 3. CSS values (stream 1)

`@kinetograph/compat/css`: pure functions, no dependencies, unit tests per property. The value types are in
`src/css/types.ts`, committed with this file: `Length`, `Rgba`, `TransformOp`, `BoxShadow`, `FilterOp`, `ClipShape`,
`BackgroundImage`, `ParsedStyle`. Stream 1 may add fields. A change to an existing field goes through the
orchestrator, since stream 2 reads them.

```ts
interface Diagnostic { property: string; value: string; reason: string }
function parseStyle(style: Record<string, unknown>): { style: ParsedStyle; unsupported: Diagnostic[] };
function parseColor(value: string): Rgba | null;   // named colours, #rgb[a], #rrggbb[aa], rgb[a](), hsl[a](), transparent, currentcolor
function parseLength(value: unknown): Length | null;
function parseTransform(value: string): TransformOp[] | Diagnostic;
function parseBoxShadow(value: string): BoxShadow[] | Diagnostic;   // drop and inset, comma lists
function parseFilter(value: string): FilterOp[] | Diagnostic;
function parseClipPath(value: string): ClipShape | Diagnostic;      // inset(), circle(), ellipse(), polygon(), path()
function parseBackgroundImage(value: string): BackgroundImage[] | Diagnostic;   // linear/radial/conic gradients, repeating ones, url()
function resolveLength(length: Length, context: { percentOf: number; fontSize: number; rootFontSize: number;
                                                  viewport: { width: number; height: number } }): number;
```

`parseStyle` reads every property of §4's tables. Each parser takes the value as React passes it (a number for
unitless or px values, a string otherwise). It returns a value or a `Diagnostic`; nothing is dropped silently. Rules:

- **Names.** Properties use React's camelCase names. `Webkit`-prefixed names fold into the unprefixed one.
- **Shorthands** are expanded: `margin`, `padding`, `inset`, `border` (and `borderTop`, …), `borderRadius` (with `/`
  for elliptical radii), `background`, `flex`, `font`, `gap`, `overflow`, `transformOrigin`.
- **Unitless numbers.** For lengths they are px (React's rule). For `opacity`, `zIndex`, `flexGrow`, `flexShrink`,
  `fontWeight`, `order` and `aspectRatio` they are plain numbers; for `lineHeight` a multiple of the font size.
- **Angles** take `deg`, `rad`, `grad` and `turn`, and are converted to degrees.
- **Not in this pass:** `calc()`, `var()`, `env()` and `attr()` are unsupported values. `!important` is ignored.
  Times are not parsed, since there are no CSS animations or transitions (Remotion forbids them).
- **Failures.** A value that does not parse is a `Diagnostic` whose `reason` says why, never a default. A property
  that is not in §4 is a `Diagnostic` with the reason "not supported", unless §4.1 lists it as ignored.

## 4. Elements and properties (stream 2)

### 4.1 Elements

| Element | Maps to |
|---|---|
| `div`, `section`, `article`, `header`, `footer`, `main`, `nav`, `aside`, `figure`, `p`, `h1`–`h6`, `blockquote`, `ul`, `ol`, `li` | a box (§4.2), `display: block` by default. `p`, `h*`, `blockquote`, `ul`, `ol` and `li` take the margins, font sizes and weights of Chrome's default stylesheet; `li` has no marker. |
| `span`, `b`, `strong`, `i`, `em`, `small`, `a`, `br` | inline content of the text block they are in (§4.4). A `span` with `display` `block`, `flex` or `inline-block` is a box. |
| text (strings and numbers) | a `text` layer (§4.4) |
| `img` | a box whose content is an `image` layer `.img`: `src`, `objectFit` → `fit`; `objectPosition` only `center` (or `50% 50%`) |
| `video` | a box whose content is a `video` layer `.video` (§4.6) |
| `svg` and its children | §4.5 |

`AbsoluteFill` and `Img` keep their Phase 3 mapping (AUTHORING §7.1) when their `style` uses only the keys that
mapping reads, so the hand ports render byte for byte as before. If the style has any other key, they render as the
DOM element they are in Remotion, mapped through this file instead of warning:

- `AbsoluteFill`: a `div` with `position: absolute; inset: 0; display: flex; flex-direction: column`;
- `Img`: an `img`.

**Unsupported:**
- elements not in the table: `canvas`, `iframe`, `input`, `table`, `foreignObject`, custom elements, …;
- `className`, `dangerouslySetInnerHTML` and `<style>`.

**Ignored:**
- event handlers, `ref`, `key`, `title`, `alt`, `role`, `aria-*`, `data-*`, `tabIndex`, `draggable`;
- the style properties `pointerEvents`, `cursor`, `userSelect`, `willChange`, `contain`, `isolation` (every group is
  isolated already), `backfaceVisibility`, `fontDisplay`, `WebkitFontSmoothing`, `MozOsxFontSmoothing`,
  `textRendering`, `imageRendering`.

`id` is used as the layer id when it is a valid one.

### 4.2 Boxes

A box is a `group` (id `<node>`) at its border box's top-left corner, holding these children, bottom first. Each is
a layer with constant numbers:

| Id | Layer | From |
|---|---|---|
| `<node>.bg` | `shape` of the border box: a `rect`, a `roundedRect` (one uniform radius), or a `path` (per-corner or elliptical radii). Filled with `backgroundColor`, or transparent, with one `dropShadow` effect per outer `boxShadow`, last first (as CSS paints them). Left out when it has no fill and no shadow. | `backgroundColor`, `borderRadius`, `boxShadow` without `inset` |
| `<node>.bg-N` | for each `backgroundImage` layer, last first: the border-box shape filled with a gradient (box units over the background positioning area), or an `image` layer clipped to the padding box for `url()` | `backgroundImage`; `backgroundSize` (`auto`, `cover`, `contain`, lengths); `backgroundPosition`; `backgroundRepeat: no-repeat` (other repeats unsupported); `backgroundClip` / `backgroundOrigin` `border-box` or `padding-box` |
| (on `<node>.bg`) | one `insetShadow` effect per inset shadow, after its drop shadows. The engine keeps an inset shadow inside where the layer is opaque, so this is supported only on a box with an opaque `backgroundColor`, no border and no background image; an outer `boxShadow` likewise needs an opaque `backgroundColor`. Anything else is unsupported. | `boxShadow` with `inset` |
| `<node>.border` | the border-box shape shrunk by half the border width, stroked at that width | `border*` when all four sides have one width, one colour and style `solid` (or no border) |
| children | the box's content, at their laid-out positions | |

Fields on the group:

- `opacity`.
- `mixBlendMode` → `blendMode`.
- `filter` → `effects`, in order: `blur` → `blur`, `drop-shadow` → `dropShadow`, `brightness`, `contrast`,
  `saturate`, `hue-rotate` → `hueRotate`, `grayscale`, `sepia`, `invert`. An `opacity()` filter is multiplied into
  `opacity`.
- `transform` and `transformOrigin` (§4.3).
- `clipPath` → `clip`: `inset()`, `circle()` → `ellipse`, `ellipse()`, `polygon()`, `path()`. Percentages are of
  the border box; a reference box other than `border-box` is unsupported.
- `overflow` `hidden` or `clip` → a `path` clip of the padding box with its inner radii, on a sub-group
  `<node>.content` holding the children, so the box's own border and shadows are not cut.
- `maskImage` / `WebkitMaskImage`: a gradient → `mask` (box units); a `url()` → an `image` layer `<node>.mask` and a
  group `<node>.masked` holding everything the box paints, with an alpha `matte` on the mask.
- `visibility: hidden` draws nothing but keeps the box; `display: none` makes no box.

Layout properties (§5):

- `display`: `block`, `flex`, `inline-block`, `inline-flex` (as `flex`), `none`.
- `position`: `static`, `relative`, `absolute`; `fixed` acts as `absolute` to the composition.
- Offsets and sizes: `top`, `right`, `bottom`, `left`, `inset`, `width`, `height`, the `min*` and `max*` sizes,
  `aspectRatio`, `boxSizing`.
- Spacing: `margin*` (with `auto`), `padding*`, `border*Width`.
- Flex: `flex`, `flexDirection`, `flexWrap`, `flexGrow`, `flexShrink`, `flexBasis`, `justifyContent`,
  `alignItems`, `alignSelf`, `alignContent`, `gap`, `rowGap`, `columnGap`, `order`.
- `zIndex` (§5.2).

Unsupported in this pass: `display` `grid`, `inline` on a box with a background, `table*` and `contents`; `float`;
`position: sticky`; `borderStyle` other than `solid`, and sides that differ in width or colour; `outline`.

### 4.3 Transforms

`transform` is a list applied right to left about `transformOrigin`, which defaults to `50% 50%` as in CSS.

It maps onto the layer transform when the list reduces to one translation, one uniform scale and rotations, applied
in the order the layer transform applies them (SCENE.md "Layers": rotate Z, then rotateX, rotateY, then translate Z):
- `x` and `y` are the box position plus the translation; `translate` percentages are of the border box;
- `scale`, `rotation`, `rotateX`, `rotateY` and `z` come from the list;
- `transformOrigin` becomes the pivot through `anchorX`/`anchorY` (and the matching shift of `x`, `y`), since a group
  without a `layout` has no box for `originX`/`originY` to measure.

Unsupported: non-uniform scale, `skew`, `matrix` and `matrix3d` (unless they decompose to the above), a rotation
order the layer transform cannot express, and the `perspective()` function.

`perspective` (the property) maps to the scene `camera`, but only on the one element in the tree that has it:
`perspective` is its value, at the element's `perspectiveOrigin` on the canvas. Two elements with different
perspectives are unsupported. `transformStyle: preserve-3d` sets `preserve3d` on the group, with its limits
(SCENE.md).

### 4.4 Text

A text block is a box whose in-flow content is only text and inline elements. It becomes one `text` layer
`<node>.text` in its content box:

- `text` is the content's characters, with whitespace collapsed as `white-space: normal` does and `br` as a line
  break.
- `maxWidth` is the content box width, so the engine breaks lines at the width Chrome's layout gave the box.

From the block's style:

- `fontFamily`: the first family in the list that is registered, as `fontKey(family, fontWeight, fontStyle)`. None
  registered is unsupported; generic families (`sans-serif`, …) are not registered fonts.
- `fontSize`, `fontWeight` (`normal` 400, `bold` 700, numbers; `bolder` and `lighter` from the parent), `fontStyle`.
- `lineHeight`: `normal` is 1.2.
- `color`.
- `textAlign`: `left`, `start`, `center`, `right`, `end`.
- `textTransform` (`uppercase`, `lowercase`, `capitalize`) is applied to the text.
- `textShadow` → `dropShadow` effects.

Inline elements may change only `color` and `opacity`, which go into `chars`.

Unsupported in this pass:

- inline elements that change the font, size, weight or style, `letterSpacing` or `wordSpacing`, or that have
  their own background, border or padding;
- `letterSpacing`, `wordSpacing`, `textDecoration` and `verticalAlign` anywhere;
- `textAlign: justify`;
- `whiteSpace` other than `normal`, `nowrap` (no `maxWidth`) and `pre-line`;
- `WebkitTextStroke`, `textOverflow`, `WebkitLineClamp`, `writingMode`, `direction: rtl`, and gradient text
  (`backgroundClip: text`).

### 4.5 SVG

An `svg` is a box: its `width` and `height` attributes, or its style. Inside it is a `group` `<node>.view` that maps
the `viewBox` onto the box: `preserveAspectRatio` `xMidYMid meet` by default, `none`, and the other `meet` and
`slice` alignments (`slice` clips to the box). Children:

| Element or attribute | Maps to |
|---|---|
| `g` | `group` (`transform`, `opacity`) |
| `path` (`d`), `rect` (`x`, `y`, `width`, `height`, `rx`, `ry`), `circle`, `ellipse`, `line`, `polyline`, `polygon` | `shape` `path`, the element converted to path data |
| `fill`, `fillOpacity`, `stroke`, `strokeWidth`, `strokeOpacity`, `opacity` (as attributes or style; `currentColor` is the CSS `color`) | `fill`, `stroke`, `opacity` |
| `linearGradient`, `radialGradient` in `defs`, used as `fill="url(#id)"` | gradient fills (`gradientUnits`, `gradientTransform` without skew, `spreadMethod`) |
| `transform` on any element | the layer transform when it reduces as in §4.3, else the path data is transformed in TS |

Unsupported:

- the elements `text`, `image`, `use`, `symbol`, `clipPath`, `mask`, `pattern`, `filter`, `marker` and
  `foreignObject`;
- `strokeDasharray`, `strokeLinecap` other than `butt`, `strokeLinejoin` other than `miter`, `fillRule: evenodd`
  and `paintOrder`.

If parsing in TS falls short, stream 2 may flatten the subtree through `usvg` in the addon instead. This file fixes
what is drawn, not how.

### 4.6 Video

A `video` element, and `Video` / `OffthreadVideo` rendered inside a DOM island, is a box whose content is a `video`
layer (AUTHORING §11.3). The layer takes `src` and `objectFit`, and `from` from the timeline; the element's own
`currentTime` is not read. The `muted`, `volume` and `loop` attributes behave as the `<Video>` props.

## 5. Layout (stream 2)

### 5.1 `layoutDom` in the addon

CSS block and flex layout with absolute positioning, CPU only:

- taffy, with its `block_layout` and `flexbox` features, in `crates/core/src/dom_layout.rs`;
- text measured by the renderer's own text engine (Parley, as in `layoutText`);
- exposed through `crates/node/src/dom.rs`.

```ts
export function layoutDom(requestJson: string): string;     // DomLayoutRequest in, DomLayoutBox out, both JSON

interface DomLayoutRequest { root: DomLayoutNode; available: { width: number; height: number };
                             fonts: Record<string, string>; baseDir?: string }
interface DomLayoutNode {
  /** taffy's style in CSS names; lengths are px numbers, { percent: n } or 'auto'. */
  style: Record<string, unknown>;
  /** A leaf measured as text (TextLayoutRequest's fields but `fonts`, plus `whiteSpace`) or of an intrinsic size. */
  measure?: { text: Omit<TextLayoutRequest, 'fonts' | 'baseDir'> & { whiteSpace?: string } } | { width: number; height: number };
  children?: DomLayoutNode[];
}
interface DomLayoutBox {
  x: number; y: number; width: number; height: number;    // the border box, in the parent's border-box space
  padding: [number, number, number, number];               // top right bottom left, px
  border: [number, number, number, number];
  children: DomLayoutBox[];                                 // one per DomLayoutNode child, in order
}
```

The tree crosses as one JSON string per island per frame. Fonts are registered before any text is measured
(HANDOFF §9). In compat, `setLayoutDom(fn)` hands the addon's function over; the CLI's synthetic entry re-exports it
next to `setLayoutText`, as it does `setMediaProbe`.

### 5.2 Paint order

- Children paint in tree order, positioned boxes (`relative`, `absolute`) after in-flow ones.
- `zIndex` sorts positioned siblings, negative values first.
- A box with any of the following is a stacking context and paints as one group: a `zIndex`, `opacity` below 1, a
  `transform`, a `filter`, a `mixBlendMode`, a `clipPath` or a mask.
- A `zIndex` that would reach out of its stacking context to interleave with another one is unsupported.

## 6. Chrome fallback (stream 3)

### 6.1 The rule

A frame is drawn natively when its `FrameResult.unsupported` is empty, and by Chrome otherwise. The decision is per
frame, never per scene (HANDOFF §9).

```ts
// @kinetograph/scene
interface Unsupported {
  path: string;            // the element's host-tree path and tag: '$0.2.1 <div>'
  element: string;         // 'div', 'svg > text', …
  property: string | null; // 'transform'; null for an unsupported element
  value: string | null;
  reason: string;
}
// @kinetograph/compat (runs.ts, complete)
type RenderPath = 'native' | 'chrome';
type CompatMode = 'auto' | 'native' | 'chrome';
interface Run { first: number; last: number; path: RenderPath }
function pathFor(unsupported: readonly Unsupported[], mode: CompatMode): RenderPath;
function planRuns(frames: readonly { frame: number; unsupported: readonly Unsupported[] }[], mode: CompatMode): Run[];
```

- **`render`.** It splits its range into runs with `planRuns` and feeds both kinds, in frame order, into one
  `VideoWriter`.
- **`--compat`.** `auto` is the default and does the above. `native` draws every frame natively, leaving out what
  is unsupported, and lists it on stderr. `chrome` draws every frame in Chrome.
- **Other commands.** `still` and `strip` follow the same rule per frame, with the same option. `bench`, `onion` and
  the studio preview are native only; the studio shows a frame's unsupported items as a warning.
- **What counts.** An unsupported item counts only on frames where its element is in the tree. Subtrees with
  `display: none` and boxes with `visibility: hidden` are not checked.

### 6.2 The browser render

This is written from the documented behaviour of Remotion's renderer, never from its source (HANDOFF §9).

- **Chrome.** `puppeteer-core` drives Chrome for Testing at a pinned version, installed with `@puppeteer/browsers`
  into `~/.cache/kinetograph/chrome`. `KINETOGRAPH_CHROME` overrides the executable; the cloud uses it with the
  pre-installed Chromium for unit tests. Chrome runs headless at `deviceScaleFactor` 1 with a viewport the
  composition's size. GPU compositing is off (`--disable-gpu`), so pixels do not depend on the machine's GPU, and
  the sRGB colour profile is forced.
- **The bundle.** esbuild bundles the project for the browser: React DOM and this repo's `@kinetograph/core`, with
  `@kinetograph/react` aliased to `@kinetograph/compat/browser`. Its native elements render DOM:
  - `Layer` → a positioned `div` with CSS transforms;
  - shapes → `svg`;
  - `Text` → a `div` with the font;
  - `Image` → `img`;
  - `Video` → an `img` of the picture the engine would show, served by the driver's local server from the addon's
    `videoFrame`;
  - `Lottie` → an error naming the frame (no Lottie in Chrome in this pass);
  - effects that CSS has → `filter` and `box-shadow`; the others are left out with one warning each.

  The determinism shim is installed in the page before the project.
- **Fonts** are the registered ones (`getFonts()`). The driver serves them and loads them with `@font-face` before
  the first frame.
- **Per frame.** `window.__kinetograph.setFrame(f)` renders the composition at `f` and resolves once `delayRender`
  handles and fonts are done. The driver then takes a PNG screenshot of the viewport (`omitBackground` when the
  composition's background is transparent) and decodes it to straight-alpha RGBA.
- **Encoding.** Chrome frames go into the writer with `VideoWriter.pushRgba`, in order with the native `pushFrame`s.

```ts
// @kinetograph/native additions (stream 3, crates/node/src/raw.rs)
/** CPU: the picture a video layer shows at `time` seconds after the stream's first picture (SCENE.md "video"). */
export function videoFrame(path: string, time: number, baseDir?: string): RgbaFrame;
class VideoWriter {
  /** Queues an already-drawn frame: straight-alpha sRGB RGBA8 of the writer's size. Same ordering rule as pushFrame. */
  pushRgba(rgba: Buffer, width: number, height: number, frame: number): void;
}
```

- **The driver** is `openChromeRenderer(source, options)` in `packages/cli/src/fallback/index.ts` (typed stub committed
  with this file): `frame(f)` gives straight-alpha RGBA, `close()` stops Chrome. `render`, `still`, `strip` and
  `doctor --compare` use it, and `FrameOutput.unsupported` (`packages/cli/src/source.ts`) carries each frame's items.
- **The cloud.** Chrome may run in the cloud on the CPU, for unit tests only. Pixel comparisons between the two
  paths happen on the M4.
- **Blend space.** Chrome blends in sRGB and the engine in linear light (HANDOFF §10), so frames that use
  `mixBlendMode` differ between the paths. `doctor --compare` shows by how much.

As built (Phase 5 merge):

- `render` decides each frame's path with `pathFor` as it renders, in one pass, so the JS stage runs once per frame;
  `planRuns` builds the summary.
- Chrome starts only at the first frame that needs it, and `videoFrame` also serves `gif` pictures (by the gif
  rule).
- `@kinetograph/compat/browser` keeps its own copy of the timeline context, since `compat` cannot import
  `@kinetograph/react`.
- Chrome for Testing is pinned at 154.0.8037.57; puppeteer-core is 25.12.0 and @puppeteer/browsers 3.2.3.
- Left out of Chrome frames, with one warning each: `mask`, `matte`, `motionBlur`, `insetShadow`, `glow` without a
  colour, conic gradients, gradient text, `noise` and `meshGradient` layers. `lottie` fails the frame.

## 7. `doctor` (stream 4)

`kinetograph doctor <entry> [--comp] [--props] [--range] [--json] [--compare N]` runs the JS stage for every frame of
the range (no GPU) and reports:

```ts
// @kinetograph/compat (doctor.ts)
interface DoctorReport {
  comp: string; first: number; last: number; frames: number;
  nativeFrames: number; chromeFrames: number; nativeShare: number;   // 0..1
  runs: Run[];                                                        // planRuns(…, 'auto')
  issues: DoctorIssue[];                                              // most frames first
  compare?: { frame: number; path: RenderPath; maxDiff: number; meanDiff: number; differingPixels: number }[];
}
interface DoctorIssue {
  element: string; property: string | null; reason: string;   // the group key
  values: string[];                                          // distinct values seen, at most 5
  paths: string[];                                           // distinct element paths, at most 5
  ranges: [first: number, last: number][];                   // inclusive, ascending
  frames: number;
}
function summarize(comp: string, frames: readonly { frame: number; unsupported: readonly Unsupported[] }[]): DoctorReport;
```

- **`--compare N`** renders N frames sampled evenly over the range, both natively and in Chrome, and reports the
  per-channel difference: `maxDiff` and `meanDiff` in 0..255 levels, and the number of pixels with any difference
  above 2 levels. It runs on the M4, since it opens a GPU.
- **`lint`** adds one finding per issue group, rule `compat`, severity `warning`: a Chrome frame still renders.
- **MCP.** The MCP server gets a `doctor` tool with the same arguments.
