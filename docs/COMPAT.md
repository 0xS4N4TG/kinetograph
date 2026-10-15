# Remotion compat mode (Phase 5)

Written 2026-10-15 by the Phase 5 orchestrator (`HANDOFF.md` §8, "Phase 5 in the same cloud session").

**Status (2026-10-15, the full engine, `ENGINE.md`).** DOM elements are no longer mapped onto layers in TypeScript. A
DOM island is handed to the addon as an `IslandRequest` and styled, laid out and painted in Rust (Stylo, taffy,
Parley through Blitz's DOM, our compositor): `className`, stylesheets, `<style>`, Tailwind, `calc()`, `var()`, grid,
selectors and everything else the CSS engine knows are drawn or reported by it. What this file still defines is the
compat contract around that: the pipeline (§2), the Chrome fallback (§6) and `doctor` (§7). The old §3 to §5, the
TypeScript mapping with its tables of supported properties, are **removed**: `packages/compat/src/css` and
`src/dom/{box,map,paint,svg,text,…}.ts` were deleted on `engine/runtime` (the last commit that has them is
`feat/full-engine`'s parent, `e082bad`). What the Rust side draws and what it reports is in `ENGINE.md` §4 and §5
and in the painter's own notes; how the TypeScript side builds the request, reads the answer and answers refs is
`ENGINE.md` §10.

`AUTHORING.md` §1's rules hold.

Compat mode is not a switch. The reconciler accepts DOM host elements (`div`, `span`, `svg`, …) next to the native
`kg-*` ones, so an unported Remotion project renders as it is. What the engine draws natively is drawn natively; while
the Chrome fallback exists, a frame holding anything it reports as unsupported is drawn by Chrome.

## 1. Layout and ownership

| Path | Owner | What |
|---|---|---|
| `packages/compat` (`@kinetograph/compat`): `src/types.ts`, `src/runs.ts`, `src/index.ts` | orchestrator (complete) | `Unsupported`, `DomNode`, the run planner (§6.1) |
| `packages/compat/src/css/` | stream 1 `feat/compat-css` | removed (the CSS parsers of the TypeScript mapping) |
| `packages/compat/src/dom/` (`/dom`), `src/request/`, `src/shim/`; the DOM parts of `packages/react/src/{root,emit,readback}.ts`; `packages/core/src/{fill,web-install}.tsx` | stream 2 `feat/compat-dom`, then `engine/runtime` | DOM host elements → `IslandRequest` → the addon (`ENGINE.md` §10); the addon's old `layoutDom` is no longer called from TypeScript |
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
     request: DomNode tree → IslandRequest JSON (tags, attributes, style as CSS text, stylesheets, time)   (ENGINE.md §10.1)
     addon:   renderDomIsland(json): Stylo + taffy + Parley, painted as scene layers                      (Rust)
     fill:    the `native` placeholders in the answer → the kg-* elements' own layers at those boxes
     report:  what the painter could not draw → RenderedTree.unsupported
  frame loop: FrameResult.unsupported
  render: frames with no unsupported item → the addon; the others → Chrome (§6); one encoder, in order
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
  time?: number; baseDir?: string; publicDir?: string; stylesheets?: readonly string[];   // see ENGINE.md §10.1
}
interface IslandResult { layers: LayerJson[]; unsupported: Unsupported[]; camera: CameraJson | null; margin?: number }
function mapDomIsland(root: DomNode, context: IslandContext): IslandResult;      // compat/dom
```

- **What a project brings with it.** A Remotion project is bundled as it is, with these allowances:
  - `import './index.css'` (Tailwind's entry, say) is read: the file's text, with its local `@import`s inlined, becomes
    one of the document's stylesheets; Tailwind is built with the project's own (`ENGINE.md` §10.2); `*.module.css` files
    export their scoped class names.
  - The entry runs even when the project's package.json lists `"sideEffects"` without it, as Remotion's templates do.
  - `staticFile` reads `public/` beside the entry, else `public/` beside the nearest package.json (Remotion's place,
    with the entry in `src/`).
  - `@remotion/media`'s `<Audio>` and `<Video>` are the engine's.
  - `new FontFace(family, "url(...)", { weight, style, unicodeRange })` with `document.fonts.add(face)`, and `@font-face`
    rules of stylesheets, register the file (`registerFont`). One file is kept per family, weight and style; of a face
    split by `unicodeRange`, the one covering basic Latin. WOFF and WOFF2 files are unpacked by the text engine (`wuff`).
- **The containing box.** A DOM island is laid out as CSS would lay it out in a box the composition's size, as
  Remotion's root `div` is. An `<AbsoluteFill>` or `<Sequence>` wrapper with DOM inside it is the absolutely positioned
  column-flex `div` it is in Remotion, in the same island as the DOM around it (`ENGINE.md` §10.1). A DOM island inside
  a native `<Layer>` is laid out in the composition's box, and the layer's own layout box is not known to it.
  Every top-level layer an island emits carries `layoutItem: { position: 'absolute' }`, so a native flex parent does not
  move it again.
- **Native elements inside DOM.** A native element inside a DOM element is a replaced box of its own box's size. A
  layer without a box (a group without `layout`) is 0 × 0. It is placed by CSS and drawn as it is.
- **Constants.** DOM styles are read at the frame, so animation comes from the component re-rendering, as in Remotion;
  CSS `@keyframes` read the frame's time.
- **Ids.** The layers a DOM node expands into have ids derived from the node's id: the explicit `id` attribute if it is
  a valid layer id, else the host-tree index path (AUTHORING §6.3), with the painter's suffixes.

## 3. to 5. CSS values, elements, properties and layout (removed)

These sections described the TypeScript mapping: the CSS value parsers (`@kinetograph/compat/css`), the element and
property tables, the `layoutDom` request and the paint order rules. They are replaced by Stylo (CSS values, cascade,
selectors), taffy and Parley (layout, text) and the painter in Rust (`ENGINE.md` §1 to §5). The unsupported items of a
frame are now whatever the painter reports (`IslandOutput.unsupported`), with the same shape as before (§6.1).

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

`kinetograph doctor <entry> [--comp] [--props] [--range] [--json] [--compare N | --compare-every N] [--compare-dir DIR]` runs the JS stage for every frame of
the range (no GPU) and reports:

```ts
// @kinetograph/compat (doctor.ts)
interface DoctorReport {
  comp: string; first: number; last: number; frames: number;
  nativeFrames: number; chromeFrames: number; nativeShare: number;   // 0..1
  runs: Run[];                                                        // planRuns(…, 'auto')
  issues: DoctorIssue[];                                              // most frames first
  compare?: { frame: number; path: RenderPath; maxDiff: number; meanDiff: number; differingPixels: number;
              largeDiffPixels?: number; files?: { native: string; chrome: string; diff: string } }[];
  notes?: string[];   // problems with the project's stylesheets that no frame shows (Tailwind that could not be built, …)
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
  above 2 levels (`largeDiffPixels`: above 48, what is left after anti-aliasing and text rasterisation). It runs on
  the M4, since it opens a GPU. `--compare-every N` samples the range's first frame and every Nth after it instead, and
  `--compare-dir DIR` writes each sampled frame's native picture, Chrome's and their difference (x4) there as PNGs.
  `scripts/corpus.mjs` runs this on the papercut episode (`ENGINE.md` §10.5).
- **`lint`** adds one finding per issue group, rule `compat`, severity `warning`: a Chrome frame still renders.
- **MCP.** The MCP server gets a `doctor` tool with the same arguments.
