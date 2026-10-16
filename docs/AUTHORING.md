# Authoring contract (Phases 3 and 4)

Written 2026-10-14 by the Phase 3 orchestrator. This is the contract the five Phase 3 streams build against
(`HANDOFF.md` §8, "Phase 3 in a cloud session"): the package layout, the addon's JS API, the authoring API, and how
every element and helper maps to `SCENE.md` JSON. A stream that needs another stream's API codes against this file
and the typed stubs committed with it, never against the other branch. Changes to this file go through the
orchestrator.

## 1. Layout and ownership

npm workspaces (root `package.json`), ESM TypeScript 5.9, Node 22+. Each package builds `src/` to `dist/` with `tsc`
and tests `test/` with vitest 5 (`*.test.ts`, `*.test.tsx`); the addon's CPU tests are `node --test`. Workspace packages import each other by package name (resolved through `dist/`), so build
before testing. Relative imports carry `.js` extensions (`moduleResolution: NodeNext`).

| Path | Package | Owner | What |
|---|---|---|---|
| `crates/node` | `@kinetograph/native` | stream 1 `feat/napi-addon` | napi-rs addon over `kinetograph-core` and the `kinetograph-cli` encoder (§3) |
| `crates/core`, `crates/cli` | Rust | stream 1 (renderer reuse, `inspect.rs`, encoder) and stream 4 (scene features) | §4 |
| `packages/scene` | `@kinetograph/scene` | stream 3 `feat/reconciler` | TS types of the whole SCENE.md schema, effect and paint helpers, motion-blur JSON helpers (§5) |
| `packages/react` | `@kinetograph/react` | stream 3 | `react-reconciler` host config, native elements, `TimelineContext` (§6) |
| `packages/core` | `@kinetograph/core` | stream 2 `feat/remotion-shim` | Remotion core API, frame loop, determinism shim, the pure-TS Remotion packages as subpaths (§7) |
| `packages/audio` | `@kinetograph/audio` | stream 5 `feat/cli-audio-mcp` | `onFrame`, offline mix through `node-web-audio-api`, loudness analysis (§8) |
| `packages/cli` | `kinetograph` (bin `kinetograph`) | stream 5 | the §7 commands of HANDOFF, the MCP server, project bundling (§9) |
| `spikes/three-dawn` | not a workspace | stream 5 | spike 2 (§9) |
| stream 4 `feat/layout-glyphs` | Rust only | stream 4 | flex layout, per-character text, Lottie and the smaller scene additions of §4 |

Dependencies point one way: `scene` ← `react` ← `core`; `cli` uses `core`, `audio`, `native`; `core` uses `native` only
for text measurement (`layout-utils`). `react` and `react-reconciler` are peer dependencies of `@kinetograph/react` and
`@kinetograph/core`, so a project has one React.

Files committed by the orchestrator with this contract are stubs: exported names and types are final, bodies throw
`not implemented`. Each stream replaces the bodies in the packages it owns and may add exports; it does not rename or
remove exports, and does not edit another stream's files. `packages/react/src/timeline.ts` is complete and belongs to
the orchestrator.

Determinism rules from `HANDOFF.md` §9 hold everywhere: rendering is a pure function of (project, frame); nothing
reads the wall clock (benchmarks aside) or calls an unseeded random generator; fonts are registered before any text is
measured; Remotion APIs are written from Remotion's documentation, never from its source.

## 2. One frame, end to end

```
kinetograph render src/index.tsx -o out.mp4
  cli: esbuild bundles the entry (aliases `remotion` → @kinetograph/core, …), installs the determinism shim, imports it
  user code: registerRoot(Root) with <Composition id="Main" component={Main} …/>
  core: createFrameRenderer("Main") → for each frame f: renderFrame(f)
          sets the virtual clock to f, renders <TimelineContext.Provider frame=f><Main/></…> into a SceneRoot,
          waits for delayRender handles, renders the sub-frames that motion blur needs,
          returns { scene: SceneJson (SCENE.md, every number constant), audio: AudioClipJson[] }
  cli: writer.pushFrame(JSON.stringify(result.scene), f)        ← the handoff; pixels never cross into JS
  native: parse + validate, swap the scene into the warm Renderer (one GPU setup), render, read back, encode
  cli: after the last frame, mixes audio (onFrame synth + <Audio> clips) and passes the PCM to writer.finish()
```

A `.json` scene (the Phase 1–2 format) skips the JS stages: the CLI hands the file's text to the addon.

Each frame's scene is a complete SCENE.md document whose `durationInFrames` is the composition's and whose numbers are
the values at that frame, and it is rendered *at that frame number* (so `grain`, `dither` and shaders see the real
frame). Keyframe lists remain legal in it.

## 3. `@kinetograph/native` (stream 1)

`crates/node`, built with `@napi-rs/cli` (`npm run build` debug, `npm run build:release` for benchmarks). `napi build`
generates the loader `index.js` and `index.d.ts` from `src/lib.rs`; both are committed. The scaffold's `src/lib.rs`
declares every export below with its final signature, so the committed `index.d.ts` is the exact TypeScript shape
(where it differs in form from the sketch below, e.g. `parseRange` returning `number[]` of length 2, it wins).

```ts
/** Thrown errors are `Error`s with `code` set to one of these and the Rust error's text as `message`. */
export type ErrorCode = 'SCENE_INVALID' | 'IO' | 'FRAME_OUT_OF_RANGE' | 'RENDER' | 'ENCODE' | 'INVALID_ARG';

export function version(): string;

// ---- CPU only: safe anywhere, never open a GPU device ----

export interface SceneInfo { width: number; height: number; fps: number; durationInFrames: number; margin: number }
/** Parses and validates scene JSON (SCENE.md); asset paths resolve against `baseDir` (default: cwd).
 *  `margin` is the margin the scene renders with: the scene's `margin` field or what its effects reach, if more. */
export function validateScene(sceneJson: string, baseDir?: string): SceneInfo;

/** The scene resolved at `frame`, as an `InspectResult` JSON string (below). Loads fonts (for text boxes), not images. */
export function inspect(sceneJson: string, frame: number, baseDir?: string): string;

export interface TextLayoutRequest {
  text: string; font: string; size: number; lineHeight?: number; maxWidth?: number;
  align?: 'left' | 'center' | 'right';
  /** Family key → font file, as a scene's `fonts`. Only these fonts exist. */
  fonts: Record<string, string>; baseDir?: string;
}
export interface TextLayout {
  width: number; height: number;
  lines: { top: number; bottom: number; baseline: number; start: number; end: number }[]; // start/end: code point indices
  glyphs: { charIndex: number; line: number; x: number; y: number; advance: number }[];  // x: origin, y: baseline
}
/** Shapes text with the renderer's own text engine (Parley). Engines are cached per `fonts` map. */
export function layoutText(request: TextLayoutRequest): TextLayout;

/** `"10..40"` (10 to 39) or `"10..=40"`; either end may be left out. Same rules as the Rust CLI. Inclusive result. */
export function parseRange(range: string, durationInFrames: number): [first: number, last: number];

// ---- GPU: everything below opens or uses a GPU device ----

export interface RendererOptions { /** Default true: reuse textures of unchanged layers across frames. */ layerCache?: boolean }
export interface Stats { mean: number; min: number; max: number }
export interface BenchResult {
  frame: number | null; runs: number;
  /** ms. `handoff` is parsing + validating the JSON and swapping it into the renderer. */
  stages: { handoff: Stats; resolve: Stats; raster: Stats; composite: Stats; readback: Stats; total: Stats };
  /** With `range`: one entry per frame, as the Rust `bench --range`. */
  frames?: { frame: number; totalMs: number; layersReused: number; layersDrawn: number }[];
}
export interface AudioPcm { sampleRate: number; /** One Float32Array per channel, equal lengths, samples in -1..1. */ channels: Float32Array[] }
export interface VideoOptions {
  width: number; height: number; fps: number;
  /** An ffmpeg H.264 encoder; default as the Rust CLI (h264_videotoolbox on macOS, else libx264). */
  encoder?: string;
}
export interface RenderSummary {
  output: string; encoder: string; width: number; height: number; fps: number;
  frames: number; first: number; last: number; ms: number; msPerFrame: number; audio: boolean;
}

/** One GPU setup, reused for every scene and frame given to it. Scenes may differ from call to call: the renderer
 * keeps fonts, images, LUTs and shader pipelines it has loaded, and its layer cache, across scenes. */
export class Renderer {
  constructor(options?: RendererOptions);
  /** One frame as a PNG. */
  still(sceneJson: string, frame: number, baseDir?: string): Buffer;
  /** One frame as straight-alpha sRGB RGBA8, `width * height * 4` bytes. */
  rgba(sceneJson: string, frame: number, baseDir?: string): { width: number; height: number; data: Buffer };
  /** Times one frame (`frame`, `runs`, defaults 0 and 10) or successive frames (`range`), as the Rust `bench`. */
  bench(sceneJson: string, options: { frame?: number; runs?: number; range?: string }, baseDir?: string): BenchResult;
  /** A whole JSON scene (keyframes and all) to a video, as the Rust `render`. */
  render(sceneJson: string, output: string, options?: { range?: string; encoder?: string; audio?: AudioPcm; baseDir?: string }): RenderSummary;
  /** A video built frame by frame, for projects whose scene changes every frame. The container comes from the
   * extension (.mp4, .mov). The partial file is deleted if `finish` is not reached. */
  beginVideo(output: string, options: VideoOptions): VideoWriter;
}
export class VideoWriter {
  /** Renders `frame` of this scene and queues it for encoding. Frames must come in increasing order; the first one
   * pushed is time 0. The scene's size and fps must match the writer's. The GPU renders frame N+1 while N is encoded. */
  pushFrame(sceneJson: string, frame: number, baseDir?: string): void;
  /** Flushes, muxes `audio` (AAC) if given, closes the file. */
  finish(audio?: AudioPcm): RenderSummary;
  /** Stops and deletes the partial file. */
  abort(): void;
}
```

`InspectResult` (what `inspect` returns, parsed):

```ts
interface InspectResult {
  width: number; height: number; fps: number; durationInFrames: number; frame: number; margin: number;
  camera: { perspective: number; x: number; y: number } | null;
  layers: InspectLayer[];                    // bottom first, as in the scene
}
interface InspectLayer {
  id: string; type: string;                  // 'shape' | 'text' | 'image' | 'group' | 'noise' | 'meshGradient' | 'lottie' | 'video' | 'gif'
  opacity: number; blendMode: string;
  transform: { x: number; y: number; scale: number; rotation: number; anchorX: number; anchorY: number;
               rotateX: number; rotateY: number; z: number };   // resolved, after layout (§4.1)
  matrix: [number, number, number, number, number, number];     // a b c d e f: the layer's 2D matrix on the canvas
  box: { x: number; y: number; width: number; height: number } | null;    // layer space (the `inset` box)
  bounds: { x: number; y: number; width: number; height: number } | null; // canvas px, transform and effect reach
  effects: string[];                         // effect types, in order
  clip: string | null;                       // clip kind
  clipBounds: { x: number; y: number; width: number; height: number } | null; // canvas px, the clip shape's box, placed like bounds (zero area if it keeps nothing)
  mask: boolean; matte: { layer: string; mode: string } | null; matteSource: boolean;
  motionBlur: { samples: number; shutter: number } | null;
  text?: { text: string; font: string; size: number; width: number; height: number; maxWidth: number | null;
           lines: { text: string; top: number; bottom: number; baseline: number }[] };
  src?: string;                              // image, lottie, video, gif
  media?: { time: number };                  // video, gif: the source time in seconds (§11.1)
  children?: InspectLayer[];                 // group
}
```

Errors: `SCENE_INVALID` (JSON or validation; `message` is the Rust text, e.g. `invalid scene: layer "card": …`),
`IO` (a file), `FRAME_OUT_OF_RANGE`, `RENDER` (GPU, font, image), `ENCODE` (ffmpeg), `INVALID_ARG` (a bad argument
from JS: a negative frame, a bad range, mismatched video size).

Tests that open a GPU are skipped unless `KINETOGRAPH_GPU_TESTS=1` (set on the M4 only).

## 4. Scene additions in the Rust core

All additions keep old scenes rendering byte for byte. SCENE.md is updated by the stream that adds each one.

### 4.1 Flex layout (stream 4, taffy)

A `group` may have `layout`; any layer may have `layoutItem`. Field names and values are CSS's.

```json
{ "id": "row", "type": "group",
  "layout": { "flexDirection": "row", "justifyContent": "center", "alignItems": "center", "gap": 24,
              "padding": [0, 40, 0, 40], "width": 1080, "height": 400 },
  "children": [
    { "id": "a", "type": "shape", "shape": { "kind": "rect", "width": 200, "height": 120 }, "fill": "#f00" },
    { "id": "b", "type": "text", "text": "hi", "font": "DM Sans", "size": 64, "color": "#fff",
      "layoutItem": { "flexGrow": 1, "margin": 8 } },
    { "id": "badge", "type": "shape", "shape": { "kind": "ellipse", "width": 20, "height": 20 }, "fill": "#0f0",
      "layoutItem": { "position": "absolute" } } ] }
```

| `layout` field | Default | Values |
|---|---|---|
| `display` | `flex` | `flex` (the only one for now) |
| `flexDirection` | `row` | `row`, `column`, `row-reverse`, `column-reverse` |
| `flexWrap` | `nowrap` | `nowrap`, `wrap`, `wrap-reverse` |
| `justifyContent` | `flex-start` | `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly` |
| `alignItems` | `stretch` | `flex-start`, `flex-end`, `center`, `baseline`, `stretch` |
| `alignContent` | `stretch` | as `justifyContent`, plus `stretch` |
| `gap` | `0` | number, or `[row, column]` |
| `padding` | `0` | number, or `[top, right, bottom, left]` |
| `width`, `height` | from content | number, the container's box |

| `layoutItem` field | Default | Values |
|---|---|---|
| `position` | `relative` | `relative`: in the flow. `absolute`: out of the flow, placed by its transform alone. |
| `flexGrow`, `flexShrink` | `0`, `1` | numbers |
| `flexBasis` | `auto` | number or `auto` |
| `alignSelf` | `auto` | `auto` or an `alignItems` value |
| `margin` | `0` | number or `[top, right, bottom, left]` |
| `width`, `height` | the layer's box | numbers: the size the layout uses for this layer |

Numbers in both are animatable. Semantics:

- Layout runs per frame, at resolve time, after fonts are registered. A child's size is its box (the `inset` box:
  a shape's width × height, a path's bounding box, an image's or lottie's box, a text layer's laid-out box, a group
  with `layout` its computed size); `layoutItem.width`/`height` override it; a group without `layout` and without
  them is 0 × 0. Leaves are never resized: a stretched or grown leaf keeps its own size, only its position changes.
  A child group that has `layout` gets the size the layout gives it.
- The layout gives each child a position `(left, top)` in the container's space. The child is drawn as if its
  transform's `x`, `y` were `x + left − box.x + anchor.x` and `y + top − box.y + anchor.y`, so with `x = y = 0` its box's
  top-left corner lands at the position and scale and rotation pivot about its anchor. Its own `x`, `y` are an offset
  from the laid-out place, as a CSS `transform: translate()` is.
- A group with `layout` has a box: `(0, 0, width, height)` of its computed size, so `inset` clips, `sweep`
  dot matrices, `cornerPin` and box-unit gradients work on it.
- `inspect` and everything downstream (bounds, cache, margins) see the laid-out transform.
- Stream 4 exposes the layout-aware resolve as `Scene::resolve_with_text(&self, frame: u32, text: &mut TextEngine)
  -> Result<ResolvedScene>`; `Renderer` and `inspect` use it.

### 4.2 Transform origin (stream 4)

`transform.originX`, `transform.originY` (animatable, default `0`): a point of the layer's box as a fraction of its
size. Like CSS's `transform-origin`, it moves the pivot and not the layer: with `(ox, oy)` the origin in pixels the
matrix is `translate(x + ox, y + oy) * rotate * scale * translate(-(anchorX + ox), -(anchorY + oy))`, so with no turn
or scale the layer sits where it would without an origin, and `0.5, 0.5` scales and turns it about its centre without
knowing its size. `(ox, oy)` is measured from the box's top-left corner, which for a path is its bounding box's,
not `0, 0` (fixed on the M4: a path at x 300–360 with origin `0.5` turned about x 30). The 3D turn uses the same
pivot. A layer without a box (a group without `layout`) ignores them.
(Changed at stream 4's merge from "added to the anchor", which would have moved every layer given `origin: 'center'`
by half its size; see SCENE.md, Transform origin.)

### 4.3 Text: `align` and per-character styles (stream 4)

- `align`: `left` (default), `center`, `right`. Lines align within `maxWidth`, or within the widest line without it.
- `chars`: an array with one entry per Unicode code point of `text` (JavaScript `Array.from(text)`, so `\n` has an
  entry, which is ignored). An entry is `null` or an object of animatable numbers and a colour, all optional:

| Field | Default | Meaning |
|---|---|---|
| `x`, `y` | `0` | Offset of the character in text-box pixels. |
| `scale` | `1` | About the character's centre. |
| `rotation` | `0` | Degrees clockwise about the character's centre. |
| `opacity` | `1` | 0..1, multiplies the layer. |
| `color` | the layer's | A colour string; replaces the layer's `color` (colour or gradient) for this character. |

  The character's centre is the middle of its glyph's advance, horizontally, and the middle of its line box,
  vertically. A cluster of several code points (a ligature, a combining mark) takes the first one's entry. Entries
  past the end of the text are ignored. The text box (for `inset`, layout, `sweep`) is the box without the offsets.
  Glyph positions are what `layoutText` returns; `charIndex` in it indexes `chars`.

### 4.4 Lottie (stream 4, dotlottie-rs at a pinned git tag)

```json
{ "id": "confetti", "type": "lottie", "src": "anims/confetti.json", "width": 400, "height": 400, "time": 1.2, "loop": true }
```

| Field | Default | Meaning |
|---|---|---|
| `src` | required | A Lottie `.json` or a `.lottie` file, relative to the scene like an image's `src`; read when the renderer loads the scene. |
| `width`, `height` | the animation's own size | The box. The animation is fitted inside it, centred, keeping its aspect ratio (lottie-web's `xMidYMid meet`). |
| `time` | the frame's time, `frame / fps` | Animatable, seconds into the animation. |
| `loop` | `false` | Past the end, `false` holds the last frame and `true` wraps. |

Rasterised by ThorVG's CPU renderer at the pixel size the layer is drawn at, uploaded and drawn like an image. Pure
function of `time`: expressions that use randomness must be seeded. Counts nothing in the margin.

### 4.5 Smaller additions (stream 4)

- **Images**: `width` and `height` become optional: both left out is the file's pixel size, one left out keeps the
  aspect ratio. `fit`: `fill` (default, stretch to the box, as now), `contain`, `cover` (centred; `cover` is cut to
  the box).
- **Gradient units**: a gradient may have `"units": "box"` (default `"user"`). Its coordinates are then fractions of
  the painted layer's box, with `(0, 0)` its top-left and `(1, 1)` its bottom-right, and the gradient stretches with
  the box (a radial one becomes an ellipse), as SVG's `objectBoundingBox`. Applies to `fill`, text `color` and `mask`.
  A box-unit gradient on a layer without a box is a load error naming the layer.
- **Motion-blur frames**: `motionBlur.frames`, an optional array of exactly `samples` complete layer objects of the
  same `type`, one per sub-frame in time order. When present the renderer uses `frames[i]` as sub-frame `i` (resolved
  at that sub-frame's time) instead of resolving the layer itself there. Each copy is validated like a layer, its own
  `motionBlur` is ignored, its effects count in the margin, and it is what the authoring layer emits for motion blur
  (§5.3). A wrong count or a type mismatch is a load error naming the layer.

### 4.6 Renderer reuse and inspect (stream 1)

- `Renderer` gets a way to take a new `Scene` while keeping its device, queue, Vello renderers, compositor pipelines
  and layer cache: fonts, images, LUTs and shader pipelines are loaded only when the new scene has ones not seen yet;
  size-dependent textures are rebuilt only when the size or margin changes. Frames are byte-identical to a fresh
  `Renderer` on the same scene.
- A scene may carry `margin`, a whole number of pixels, the least margin to render with (SCENE.md "Canvas margin"): the
  margin is `max(margin, the effects' reach)`. The reach follows each TSX frame's constants, so without it the margin
  changes from frame to frame (one frame of a port had a 44 pixel shadow reach among frames of 43), and every change
  rebuilds the textures and empties the layer cache. `displace` no longer depends on the margin, so the pixels do not
  change either way; only the time does.
- `crates/core/src/inspect.rs`: the CPU-only `InspectResult` of §3, from the resolve that the renderer uses.
- `kinetograph-cli`'s `render` takes a `Scene` (not only a path) so the addon can drive it, and the encoder can mux an
  AAC audio stream from PCM.

## 5. `@kinetograph/scene` (stream 3)

Pure TypeScript, no dependencies.

### 5.1 Types

`SceneJson`, `LayerJson` (a union over `type`), `Transform`, `Effect` (a union over all 22 SCENE.md effect types),
`Paint`, `Gradient`, `Clip`, `Mask`, `Matte`, `MotionBlurJson`, `CameraJson`, `Layout`, `LayoutItem`, `CharStyle`,
`Num` (`number | Keyframe[]`), `KeyframeEasing` (named so it cannot clash with Remotion's `Easing` when
`@kinetograph/core` re-exports this package), `ColorString`, `BlendMode`, plus `AudioClipJson` (§6.4). Field names, optionality and
literal unions follow SCENE.md and §4 exactly. A JSON value that type-checks as `SceneJson` should load.

### 5.2 Helpers

Every effect has a helper named after its `type` that takes the effect's fields without `type`, e.g.
`dropShadow({ y: 12, blur: 24 })`, `shader({ code, uniforms })`. Effects whose one required field is a number also
take it bare: `blur(24)`, `glow(16)`, `backdropBlur(16)`, `saturate(1.5)`, `contrast(1.2)`, `brightness(0.8)`,
`grayscale(1)`, `sepia(1)`, `invert(1)`, `hueRotate(90)` (the `angle`), `chromaticAberration(4)`; `grain(amount, {
seed, … })` and `dither(levels, { … })` take their main field first. Each returns the plain SCENE.md object.

`motionBlur({ samples, shutter })` returns a marker that may sit in an `effects` array; the reconciler moves it to
the layer's `motionBlur` (so the HANDOFF §5 sketch works).

Paints and geometry:

```ts
linearGradient(colors: (ColorString | [offset: number, ColorString])[], options?: { angle?: number; extend?: Extend }): Gradient
//   box units; angle in degrees as CSS (0 = to top, 90 = to right; default 180 = to bottom); bare colours spread evenly
radialGradient(colors, options?: { cx?: number; cy?: number; r?: number; extend?: Extend }): Gradient   // box units, default 0.5 0.5 0.5
conicGradient(colors, options?: { cx?: number; cy?: number; angle?: number; extend?: Extend }): Gradient // box units
gradient(json: Gradient): Gradient                                 // the raw SCENE.md object, user units
fontKey(family: string, weight?: number | string, style?: 'normal' | 'italic'): string
//   'Inter' for 400 normal, else 'Inter:700', 'Inter:400i', 'Inter:700i'
```

`effectCatalog: EffectInfo[]` lists every effect with its fields (`name`, `type`, `default`, one-line `description`),
for `kinetograph effects`.

### 5.3 Motion-blur helpers

Used by the frame loop (§7.3):

```ts
motionTimes(frame: number, samples: number, shutter: number): number[]   // SCENE.md's t_i formula
collectMotionTimes(layers: LayerJson[], frame: number): number[]          // distinct times any outermost motionBlur needs, sorted
attachMotionFrames(layers: LayerJson[], frame: number, treesAt: ReadonlyMap<number, LayerJson[]>): LayerJson[]
//   new layers with motionBlur.frames filled from the trees rendered at those times, matched by id and type;
//   a layer missing (or of another type) at a time becomes a copy of itself with opacity 0 there
```

## 6. `@kinetograph/react` (stream 3)

### 6.1 Root

```ts
export interface RenderedTree { layers: LayerJson[]; camera: CameraJson | null; audio: AudioClipJson[] }
export interface SceneRoot {
  /** Renders `element` synchronously (effects flushed) and returns the emitted tree. */
  render(element: React.ReactNode): RenderedTree;
  /** The tree as it is now, after state updates since the last render (delayRender data arriving). */
  snapshot(): RenderedTree;
  unmount(): void;
}
export function createSceneRoot(): SceneRoot;
```

One root per composition, kept across frames like a Remotion tab keeps its page. The reconciler emits plain
SCENE.md JSON objects; it never resolves time itself.

### 6.2 Timeline context (`timeline.ts`, orchestrator's)

```ts
export interface VideoConfig { id: string; width: number; height: number; fps: number; durationInFrames: number;
                               defaultProps: Record<string, unknown>; props: Record<string, unknown> }
export interface TimelineState {
  frame: number;            // as components here see it (Sequence-relative; fractional on motion-blur sub-frames)
  absoluteFrame: number;    // of the composition
  durationInFrames: number; // of the innermost Sequence, else the composition
  config: VideoConfig;
  frozen: boolean;          // inside an active <Freeze>; <Audio> is silent there
}
export const TimelineContext: React.Context<TimelineState | null>;
export function useTimeline(): TimelineState;   // throws outside a composition
```

Remotion's hooks (`useCurrentFrame`, `useVideoConfig`) are thin readers of this context, so the core shim, the
native elements and the motion-blur sub-frames agree on time.

### 6.3 Elements

All elements take the common props; none needs a `key` beyond React's usual rules.

| Common prop | JSON |
|---|---|
| `id` | `id`. Default: an automatic id, `$` + the host-tree index path (`$0.2.1`), stable while the tree's shape is. Ids beginning with `$` are reserved. Give an `id` to matte sources and to layers whose ids must survive structural changes. |
| `x`, `y`, `scale`, `rotation`, `anchorX`, `anchorY`, `rotateX`, `rotateY`, `z`, `originX`, `originY` | `transform.*` |
| `origin` | `'center'` → `originX = originY = 0.5`; `[ox, oy]` |
| `opacity`, `blendMode`, `effects`, `clip`, `mask`, `matte`, `layoutItem` | same name |
| `motionBlur` | `{ samples?, shutter? }` → `motionBlur` (the frame loop fills `frames`, §7.3) |

Numbers may be plain numbers or keyframe lists (they pass through). Unknown props are ignored.

| Element | Props | JSON |
|---|---|---|
| `<Layer>` | `preserve3d`, `layout`, children | `group` |
| `<Shape>` | `kind` (`rect`, `roundedRect`, `ellipse`, `path`), `width`, `height`, `radius`, `d`, `fill`, `stroke` (`{ color, width }`) | `shape` |
| `<Rect>` | `width`, `height`, `radius?`, `fill`, `stroke` | `shape` `rect`, or `roundedRect` when `radius > 0` |
| `<Ellipse>` | `width`, `height`, `fill`, `stroke` | `shape` `ellipse` |
| `<Path>` | `d`, `fill`, `stroke` | `shape` `path` |
| `<Text>` | children (strings and numbers, concatenated), `font`, `weight`, `fontStyle`, `size`, `color` or `fill`, `lineHeight`, `maxWidth`, `align`, `chars` | `text`, `font: fontKey(font, weight, fontStyle)`; `chars` may be an array or `(char, index, count) => CharStyle \| null`, evaluated to the array |
| `<Image>` | `src`, `width?`, `height?`, `fit?` | `image` |
| `<Noise>` | `width`, `height`, `turbulence`, `channels` | `noise` |
| `<MeshGradient>` | `width`, `height`, `columns`, `rows`, `points`, `colors` | `meshGradient` |
| `<Canvas>` | `width`, `height` (whole numbers, not animated), `draw(context)` | `canvas`: `draw` is called with a fresh, empty `CanvasContext2D` (§6.5) each time the tree is read, and the commands it drew are the layer's `commands` |
| `<Lottie>` | `src` or `animationData` (parsed JSON, written once to a content-addressed cache file), `width?`, `height?`, `loop?`, `playbackRate?` (default 1) | `lottie` with `time = frame / fps * playbackRate` from the timeline |
| `<Camera>` | `perspective`, `x?`, `y?` | the scene's `camera` (at most one per tree; anywhere in it) |
| `<Audio>` | Remotion's: `src`, `volume` (number or `(frame) => number`), `trimBefore`/`trimAfter` (and the older `startFrom`/`endAt`), `playbackRate`, `loop`, `muted` | an `AudioClipJson` in `RenderedTree.audio`, not a layer |

Raw text outside `<Text>` is an error naming the parent element. Duplicate explicit ids are an error naming the id.

### 6.5 Canvas 2D

A Canvas 2D context that records instead of rasterising (`createCanvasContext` of `@kinetograph/scene`,
`packages/scene/src/canvas.ts`). It keeps the canvas's state as a browser's does (transform, `fillStyle` and the
other styles, line and text state, `save`/`restore`, clips) and writes each drawing call as a `canvas` layer command
with the state it is drawn in (SCENE.md, "canvas"); Rust draws the commands with Vello. Nothing in it reads a clock,
so what a context holds is a function of the calls it was given.

Two ways to draw:

- **`<Canvas width height draw={(ctx) => …} />`** is the native element: `draw` gets a fresh context each time the
  tree is read, so the canvas is a function of its props and the frame `draw` closes over.
- **`<canvas ref>` with `getContext('2d')`**, as a Remotion project writes it (usually in a `useEffect`). The host
  element keeps its context across frames, as a browser's canvas keeps its bitmap, and the commands reach the painter in
  the element's `data-kg-canvas` attribute (ENGINE.md §4), so CSS sizes, rounds, clips and transforms the canvas box like
  any element's. A project redraws every frame: `clearRect(0, 0, w, h)` (or an opaque `fillRect` of the whole canvas)
  empties the command list, so it never grows past one frame's drawing. Before each frame the frame loop puts every
  context's **state** back to a new canvas's (open clips are closed, `save`d states dropped) and keeps what was drawn, so
  a project that forgets a `restore()` does not make a frame depend on the frame rendered before it.

The context and the globals around it:

| API | Support |
|---|---|
| Paths | `beginPath`, `closePath`, `moveTo`, `lineTo`, `bezierCurveTo`, `quadraticCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`, `fill(rule)`, `stroke`, `clip(rule)`, `Path2D` (SVG path data, `addPath` with a matrix) as an argument to all three. Each point is taken through the transform in force when it was added, as the spec has it. |
| Rectangles | `fillRect`, `strokeRect`, `clearRect` |
| Styles | `fillStyle`, `strokeStyle` as CSS colours (named, hex, `rgb()`, `hsl()`; no `lab()`, `oklch()`, `color()`: such an assignment is ignored, as an invalid one is), `createLinearGradient`, `createRadialGradient`, `createConicGradient`, `createPattern` of an image or `ImageData`, `globalAlpha`, `globalCompositeOperation` (all 26 plus `clear` for `clearRect`), `lineWidth`, `lineCap`, `lineJoin`, `miterLimit`, `setLineDash`, `lineDashOffset`, `imageSmoothingEnabled` |
| Transform | `scale`, `rotate`, `translate`, `transform`, `setTransform` (six numbers or a matrix), `resetTransform`, `getTransform`, `save`, `restore`, `reset` |
| Text | `fillText`, `strokeText` (with `maxWidth`), `measureText` (width from the text engine; the other metrics from the line's ascent and descent), `font` (the shorthand: style, weight, size in `px`, `pt`, `em`, `%` or a keyword, a family list), `textAlign`, `textBaseline` |
| Pictures | `drawImage` (three forms) of an `<img>`, `new Image()` (a project file or a `data:` URL), another canvas (`<canvas>`, `document.createElement('canvas')`, `OffscreenCanvas`: its commands, drawn as a whole) or `ImageData`; `createImageData`, `putImageData` (with a dirty rectangle), `getImageData` |
| Elsewhere | `canvas.width`/`height` (setting either empties the canvas and resets the context), `toDataURL()` (always PNG), `toBlob`, `OffscreenCanvas`, `Path2D`, `ImageData`, `CanvasGradient`, `CanvasPattern`, `CanvasRenderingContext2D` as globals |

Kept and drawn with nothing (reading back what was set works): `letterSpacing`, `wordSpacing`, `fontKerning`,
`fontStretch`, `fontVariantCaps`, `textRendering`, `direction`, `imageSmoothingQuality`. `isPointInPath` and
`isPointInStroke` return `false`.

Shadows and filters are drawn (SCENE.md, "canvas"; checked against Chrome by `crates/dom/tests/canvas/canvas_effects.js`):

- **Shadows.** `shadowColor`, `shadowBlur`, `shadowOffsetX/Y` shadow what `fill`, `stroke`, `fillText`, `strokeText`,
  `fillRect`, `strokeRect` and `drawImage` draw, as the spec has it: while the colour has alpha and the blur or an offset
  is not 0, the shape casts a shadow under itself, blurred with a deviation of half `shadowBlur` and offset by
  `shadowOffsetX/Y`, which the transform does not change. `globalAlpha`, `globalCompositeOperation` and the clip apply
  to the shadow and to the shape.
- **`filter`.** `none`, or a list of `blur()`, `brightness()`, `contrast()`, `drop-shadow()`, `grayscale()`,
  `hue-rotate()`, `invert()`, `opacity()`, `saturate()` and `sepia()`, with CSS's units (`px`, `pt`, `em` as 16 px,
  `%` or a number, `deg`, `rad`, `grad`, `turn`). It runs over each command's drawing before its shadow is cast. A value
  that is not a filter list is ignored, and a `url()` reference is kept and reported as unsupported (the rest of the
  list is drawn). `clearRect` and `putImageData` are not filtered, nor do they cast shadows.
- A command with either costs GPU passes of its own (drawn alone, blurred, drawn again as a picture), so a canvas with
  hundreds of shadowed shapes is slower than one without, and one frame may not make more than 50 million pixels of
  such pictures per canvas layer (SCENE.md, "canvas"). `getContext('webgl')` and
`'webgl2'` return a recording WebGL context (§6.7); `'webgpu'` throws `unsupported:`; another context type returns `null`.

- **Fonts.** `font` is matched against the registered fonts (`registerFont`, `loadFont`, `@font-face`) by family
  (the first of the list that has a face), then the nearest weight and the right style of it; a family with no face
  registered gives the key a `<Text>` of that font would (`'Unknown:700'`), which the scene then lacks, like a `<Text>`.
  The text engine measures and draws with the same face, so `measureText` is what is drawn.
- **`getImageData`, `toDataURL`, `toBlob`.** They need the pixels of what has been drawn, so they ask the addon to draw
  the commands on a transparent canvas (`renderCanvas`: it opens the GPU on each call, about 100 ms, so not in a per-frame
  loop) and read it back; without the addon they throw. A canvas drawn into another with `drawImage` is not drawn to
  pixels: its commands are copied in, which keeps it sharp.
- **Images.** `drawImage` of an `<img>` or `new Image()` names the file; it is read when the renderer is built, as an
  `<Image>` layer's is. `putImageData` replaces what is under it (it ignores the transform, alpha and composite
  operation, but not an open clip).
- **Sizes.** The bitmap is `width` x `height` (300 x 150 by default); CSS stretches it to the element's box as
  `object-fit: fill` does. The commands are drawn at the box's size, not resampled from the bitmap, so a stretched canvas
  is sharp where Chrome's is blurred (ENGINE.md §4, "`<canvas>`").

### 6.6 The 3D layer

`<Scene3D width height msaa?>` is a `scene3d` layer (SCENE.md, "scene3d"); it takes the common layer props
(`x`, `rotateY`, `effects`, `blendMode`, ...) and these children, all of which must be inside it:

| Element | Props |
|---|---|
| `<Camera3D>` | `type`, `fov`, `height`, `near`, `far`, `position`, `target`, `up`. At most one. |
| `<AmbientLight>`, `<DirectionalLight>`, `<PointLight>` | `color`, `intensity`; `direction`; `position`, `range`. |
| `<Mesh geometry material?>` | `geometry` is `{ kind: 'box' \| 'sphere' \| 'plane' \| 'cylinder' \| 'torus', ... }`. |
| `<Model src material?>` | A glTF or GLB file. |
| `<Text3D font size depth align lineHeight material>` | The text is the children (strings and numbers); `weight` and `fontStyle` pick the font key as for `<Text>`. |
| `<Extrude path size depth fillRule material>` | SVG path data. |
| `<Group3D>` | Objects that move together. |

Every object takes `position`, `rotation` (degrees), `scale` (a number or `[x, y, z]`), `visible` and `id`. Every
number is an animatable `Num`, so a frame-driven value is `useCurrentFrame()` arithmetic or `interpolate`d, as anywhere.

```tsx
const frame = useCurrentFrame();
<Scene3D id="hero" width={960} height={540} effects={[dropShadow({ x: 0, y: 12, blur: 16 })]}>
  <Camera3D fov={40} position={[0, 2, 8]} target={[0, 0.5, 0]} />
  <AmbientLight intensity={0.3} />
  <DirectionalLight direction={[-1, -1, -1]} intensity={1.6} />
  <Mesh geometry={{ kind: 'torus' }} material={{ color: '#c77dff', roughness: 0.3 }} rotation={[60, frame * 3, 0]} />
  <Text3D font="DM Sans" size={1} depth={0.3} position={[0, 1.6, 0]}>Hello</Text3D>
</Scene3D>
```

Names follow react-three-fiber's where it costs nothing (`position`, `rotation`, `scale`, `visible`, `Mesh`, `Group`);
materials and geometries are plain props, not child elements, and there is no Three.js API behind them. The element
mapping is in `emit.ts` (`scene3d`, `object3d`); a 3D element outside a `<Scene3D>`, or a 2D one inside, is an error
naming both.

### 6.7 WebGL and GLSL shaders

A WebGL context records, as a Canvas 2D one does, and the renderer replays the recording on the GPU with the page's
own GLSL ES, translated to WGSL by naga (SCENE.md, "glsl"). No browser is involved.

- **`<GlslShader width height fragment uniforms textures>`** (native): a full-screen fragment shader, GLSL ES 100 or
  300 es. `vertex` is optional (the default covers the box with `a_position` in clip space). `uniforms` are the values
  of the shader's uniforms by name (a number, or an array for a vector, a column-major matrix or an array of them);
  work them out from the frame (`useCurrentFrame()`), as the shader has no clock. `textures` maps `sampler2D` names to
  a project file or `{ src, filter: 'linear' | 'nearest', wrap: 'clamp' | 'repeat' | 'mirror' }`. `gl_FragCoord`
  counts up from the bottom row, as in a browser. The same thing outside React: `glslShader({ width, height,
  fragment, ... })` of `@kinetograph/scene` returns the recording, and `glslLayer(context, layer)` makes a layer from
  any context.
- **`canvas.getContext('webgl' | 'webgl2' | 'experimental-webgl')`** in a Remotion project (`<canvas>`,
  `document.createElement('canvas')`): a `WebGLRenderingContext` that records. A project's own WebGL code (shader
  transitions, Shadertoy ports) runs as it is: `createShader`, `createProgram`, `bindAttribLocation`, buffers,
  vertex arrays, `vertexAttribPointer`, the `uniform*` calls, `texImage2D` from an image, a canvas, `ImageData` or an
  array, `texParameteri`, `generateMipmap`, `activeTexture`, `pixelStorei` (flip and premultiply), `viewport`,
  `scissor`, `enable` (`BLEND`, `CULL_FACE`, `SCISSOR_TEST`), `blendFunc` and the rest of blending, `colorMask`,
  `clearColor`, `clear`, `drawArrays` and `drawElements` of triangles. `getShaderParameter(COMPILE_STATUS)` is true:
  a shader naga cannot read fails when the scene loads, naming the line. `getExtension('OES_standard_derivatives')`
  answers (derivatives always work); other extensions return `null`.
- **Framebuffers** (multi-pass shaders: render to a texture, then sample it; ping-pong; blur passes):
  `createFramebuffer`, `bindFramebuffer` (`FRAMEBUFFER`, and in WebGL 2 `DRAW_FRAMEBUFFER` and `READ_FRAMEBUFFER`),
  `framebufferTexture2D` of an RGBA, `UNSIGNED_BYTE` `TEXTURE_2D` to `COLOR_ATTACHMENT0`, `checkFramebufferStatus`,
  `deleteFramebuffer`, `isFramebuffer`; binding `null` returns to the canvas. Draws, `clear` and `viewport` act on the
  bound framebuffer's texture, in GL's orientation (its first row is the bottom one), and the texture can then be
  sampled by later draws. Call `viewport` after binding a framebuffer, as GL needs. Allocate the texture with
  `texImage2D(..., null)` (or `texStorage2D`); one that holds uploaded pixels, or is not RGBA, cannot be drawn into. A
  framebuffer with no texture, or a texture not yet specified, is incomplete: `checkFramebufferStatus` says so and a
  draw or clear sets `INVALID_FRAMEBUFFER_OPERATION`. A draw that samples the texture it draws into sets
  `INVALID_OPERATION` and draws nothing. A render is a function of its own frame: every framebuffer texture starts a
  frame transparent black, so a pass reading what an earlier frame left reads black. A texture drawn into cannot be
  given `generateMipmap` or `texSubImage2D`; sample it with `LINEAR` or `NEAREST` (a mipmapped minification filter
  without levels is incomplete, and reads black).
- The drawing buffer is a browser's: the first draw or clear after a frame starts it afresh, and a frame that draws
  nothing keeps the picture. A canvas has one kind of context for good; `getContext('2d')` after `getContext('webgl')`
  returns `null`.
- Anything outside the list throws a `WebGLUnsupportedError` (message starting `unsupported:`) saying what to do:
  renderbuffers and depth and stencil attachments, depth and stencil tests, `readPixels`, points and lines,
  instancing, cube and float textures, `getContext('webgpu')`, and drawing or `toDataURL`-ing a WebGL canvas.
  Enabling the depth test is accepted but
  the first draw with it on throws, because a flat quad does not need it and a scene that does is drawn wrongly
  without it.

### 6.4 Audio clips

```ts
interface AudioClipJson {
  id: string;            // the element's id
  src: string;           // file path, as given (staticFile paths are absolute)
  from: number;          // absolute composition frame at which the clip's own frame 0 falls
  trimBefore: number;    // frames skipped at the start of the file
  trimAfter: number | null;
  playbackRate: number;
  volume: number;        // at this frame (a volume callback evaluated at the clip's own frame)
  loop: boolean;
  muted: boolean;        // `muted`, or inside a <Freeze>
  video?: boolean;       // the sound of a <Video> (§11.3)
  toneFrequency?: number; // left out when 1
}
```

`toneFrequency` is Remotion's prop of `<Audio>` and `<Video>`: the pitch is multiplied by it (0.01 to 2, anything
else throws) and the speed is not. The mixer shifts each file once per value: a WSOLA time stretch by the factor
(windows of 1024 samples, half overlapping, each moved up to 256 samples to line up with the last, the same positions
for every channel), then a linear resample back to the original length. It is plain arithmetic on the samples, so
the same file and value always give the same sound. A change of `toneFrequency` starts a new clip timeline (§8).

A clip appears in the tree of every frame it plays in; the CLI joins them by `id` into one clip with a volume per
frame (§8).

## 7. `@kinetograph/core` (stream 2)

### 7.1 Remotion core API

Exported from `@kinetograph/core` (and so from `remotion` through the CLI's alias), behaving as Remotion documents
them: `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`, `measureSpring`, `Easing`,
`random`, `Sequence`, `Series`, `Loop`, `Freeze`, `AbsoluteFill`, `Img`, `Audio` (re-exported from react), `staticFile`,
`delayRender`, `continueRender`, `cancelRender`, `getRemotionEnvironment`, `Composition`, `Still`, `Folder`,
`registerRoot`, `getInputProps`.
`random(seed)` is bit-exact with Remotion's; the rest match its documented behaviour, tested against values recorded
from the published package (§10).

Mapping onto the engine:

- `Sequence` renders its children inside a `<Layer>` (no layout), only while `from <= frame < from +
  durationInFrames`, and shifts the timeline by `from`. `name` becomes nothing; `layout="none"` is accepted. With
  DOM elements inside it, or around it, that layer is Remotion's wrapper, an `AbsoluteFill` `div`, in the same CSS tree
  as the DOM around it (COMPAT.md §2, ENGINE.md §10.1); a `Sequence` of native elements keeps its own positions.
- `AbsoluteFill` is `<Layer layout={{ flexDirection: 'column', width, height }} layoutItem={{ position: 'absolute' }}>`
  covering the composition, so its children stack in a column as in CSS and it overlays its siblings, as long as
  everything inside it is a native element. `style` maps `backgroundColor`/`background` (a colour) to a full-size rect
  drawn first, `opacity`, and the flex properties (`display`, `flexDirection`, `justifyContent`, `alignItems`,
  `flexWrap`, `gap`, `padding`) to `layout`. With any other style key, a value the layers cannot take (a gradient
  `background`, `display: grid`, a `gap` in `em`), a `className`, or DOM elements anywhere inside it, it is the `div` it is in Remotion (`position: absolute; inset: 0; display: flex; flex-direction: column`, the
  author's style on top), drawn by the CSS engine.
- `Img` is `<Image>` with `style.width`, `style.height`, `style.objectFit` mapped to `width`, `height`, `fit`; with any
  other style key, a percentage size, an `objectFit` the image layer lacks, or a `className` it is an `img`.
- `staticFile(name)` is the absolute path of `name` in the public directory, `setPublicDir(dir)` (default
  `<entry directory>/public`, set by the CLI).
- `delayRender(label?)` returns a handle; `renderFrame` waits until every handle is continued, failing after 30 s
  (real time, used only for the error) with the labels still open. `cancelRender(err)` fails the frame.
  `useDelayRender()` returns the same three functions.
- Every frame is a render, so the hooks that read the Studio's or the Player's state answer what a render sees:
  `useRemotionEnvironment()` is `getRemotionEnvironment()` (`isRendering` only), `useCurrentScale()` and
  `usePixelDensity()` are 1 (there is no render `scale` option, and `devicePixelRatio` is 1), `useBufferState()`
  hands out a `delayPlayback()` whose `unblock()` does nothing, and `useIsInsideNonPremountFreeze()` is whether a
  `<Freeze>` is active around the component.
- The public folder: `getStaticFiles()` lists it (`{ src, name, sizeInBytes, lastModified }`, by name, hidden files
  left out); `watchStaticFile()` is the Studio's reload hook and does nothing, saying so once; `prefetch(src)`
  resolves at once with `src` minus its `#` fragment, as it does in a Remotion render, and throws the offline error
  for a remote URL.
- `interpolate` takes `easing` as one function or an array with one per segment, and `posterize` (the input is held
  at the last multiple of it, so the output steps); `assertValidInterpolateEasingOption` and
  `assertValidInterpolatePosterizeOption` are the checks it runs. Its values are recorded from the published package.
  Not yet: string, tuple and boolean output ranges, `output: 'perceptual-scale'` and `outputType`.
- The components Remotion's Studio edits, `Track` and `Interactive` (`Interactive.Div`, `.Span`, `.Svg`, `.Circle`, …
  and `Interactive.create()`, `withSchema()`): each is a `<Sequence layout="none">` around the element, so it shows from
  `from` for `durationInFrames` under the name `<Interactive.Div>` (or `name`), is drawn from its props, and takes
  `hidden`, `freeze` and the four `crop*` props (a `clip-path: inset(…)`, rounded to the element's `border-radius`;
  recorded from the published package). `trimBefore`, `playbackRate` and `loop` are accepted with a warning that
  `<Sequence>` does not apply them yet; `premountFor` and the like are the preview's and a render ignores them as
  Remotion does. `Interactive.create({ Component, layout: 'absolute-fill' })` puts the component in a clipped `div` of
  the `width` and `height` props. The field tables (`Interactive.baseSchema`, …, and `absoluteFillSchema`) are
  Remotion's data, unused in a render.
- Canvas components. A browser canvas is what Remotion runs its effects, `<HtmlInCanvas>` and `<Artifact>` on, and there
  is none, so these are accepted, draw what they can, and warn once about what they leave out:
  - `createEffect(definition)` returns the factory and its descriptors (key with the `disabled` flag, schema with the
    `disabled` field; recorded from the published package). An `effects` prop with an enabled effect draws the picture
    without it.
  - `<Solid width height color>` is the `div` of that size and colour; `<CanvasImage src width height fit>` is the `Img`
    (an image layer when nothing needs CSS, an `img` with the `object-fit` and crop when it does).
  - `<HtmlInCanvas width height>` shows its children in a clipped box of its size, which is what its canvas shows when
    nothing paints over it; `onPaint` and `onInit` are not run. `isHtmlInCanvasSupported()` is false, so a project can
    take another path; `getHtmlInCanvasUnsupportedMessage()` and `HTML_IN_CANVAS_UNSUPPORTED_MESSAGE` say why.
  - `<IFrame>` is the `iframe` element, which the CSS engine reports as unsupported (`--strict` fails on it).
  - `<Artifact>` draws nothing and says that its file is not written: a render produces the video only.
  They take `from`, `durationInFrames`, `name`, `hidden`, `freeze` and the crop props as `Interactive` does.
- `<AnimatedImage src width height fit loopBehavior playbackRate>` (`loopBehavior`: `loop`, `pause-after-finish`,
  `clear-after-finish`). A GIF is a native `gif` layer (§11.3) shown at the picture Remotion's `ImageDecoder` path picks
  for that time: of the picture that has started and the next, the one whose start is nearer (so a picture changes
  half its delay early), with the next on an exact tie. The pictures' starts are read from the file's graphic control
  extensions (a delay of 10 ms or less shows for 100 ms, as in the `gif` layer; checked against the engine's
  `probeMedia` on the repository's GIFs). `playbackRate` scales the time and shortens `durationInFrames`; a `loop`
  without a `durationInFrames` is `loopBehavior="loop"`. With `className`, `style` or a crop the layer sits in a `div`.
  A file that is not an animated GIF is drawn as a still (`Img`); an animated PNG or WebP is that too, with a warning,
  because the engine decodes GIF animation only.
- Names that exist so a project bundles: `Html5Audio` and `Html5Video` are `Audio` and `Video`; `MediaPlaybackError`
  is Remotion's error class; `Experimental.Clipper` and `Experimental.Null` throw when rendered (Remotion removed them
  in 4.0.228) and `Experimental.useIsPlayer()` is false; `Config.*` calls do nothing and say once that there is no
  `remotion.config.ts`.
- `getRemotionEnvironment()` always reports `isRendering: true` and every other flag false: the studio preview and the
  output file come from the same render path, so a component that branches on it draws the same frame in both.

### 7.2 Compositions and fonts

```ts
export interface CompositionInfo { id: string; width: number; height: number; fps: number; durationInFrames: number;
                                   defaultProps: Record<string, unknown> }
/** <Composition> also takes `margin?: number` and `background?: string`: see "Pinning the margin" and "Background"
    below. */
export function getCompositions(): CompositionInfo[];         // after registerRoot ran
export function registerFont(font: { family: string; path: string; weight?: number | string; style?: 'normal' | 'italic' }): void;
export function getFonts(): Record<string, string>;           // fontKey → absolute path, every font registered
export function setPublicDir(dir: string): void;
```

**Pinning the margin.** Each frame is its own scene, so its margin is the reach of the effects at that frame's values
(SCENE.md "Canvas margin"), and when it differs from the previous frame's, the renderer rebuilds its size-dependent
textures and empties the layer cache. `<Composition margin={44}>` (also `<Still>`; a whole number of pixels, not
negative, checked when the composition is found) puts `margin: 44` in every frame's scene. It is a floor: the margin
is `max(44, reach)`, so no effect is ever cut off, and a frame that reaches further than the prop says still renders
correctly, only with a rebuild. Set it to the largest reach of any frame. To find that, leave the prop off and read
`margin` from `kinetograph inspect <entry> --frame N` at the frames with the biggest shadows, glows and displacements
(or, for an empty-layer trick like `dropShadow({ x: 44, blur: 0 })` that pins it, replace the trick with the prop).
It depends on nothing but the composition, so any frame, in any order or range, is the same scene as in a full
render. When the reach depends on the input props (a shadow size passed in), `calculateMetadata` can return `margin`
as well, checked the same way; it wins over the prop, and like the prop it is the same for every frame.

**Background.** `<Composition background="#14161c">` (also `<Still>`; a colour string as SCENE.md's `background`
takes it, checked to be a non-empty string when the composition is found, its syntax by the engine) puts that
`background` in every frame's scene. Default `"transparent"`. Prefer it to a full-size rect at the bottom: the
background also fills the margin, which `backdropBlur` and the other effects that read past the canvas edge see, and a
rect does not.

`registerFont` is also behind `@kinetograph/core/fonts` as `loadFont({ family, url, weight, style })` (Remotion's
`@remotion/fonts`, with `url` a path). `@kinetograph/core/google-fonts` provides `makeGoogleFont(familyName)`, which
returns the module Remotion's `@remotion/google-fonts/<Family>` exports (`loadFont(style?, { weights, subsets })`,
`fontFamily`); it downloads TTFs once into `~/.cache/kinetograph/fonts` and registers them, and the frame loop waits
for downloads before the first frame. The CLI maps `@remotion/google-fonts/<Family>` imports onto it.

### 7.3 Frame loop

```ts
export interface FrameResult { scene: SceneJson; audio: AudioClipJson[] }
export interface FrameRenderer {
  readonly config: VideoConfig;
  renderFrame(frame: number): Promise<FrameResult>;
  dispose(): void;
}
export function createFrameRenderer(compositionId: string, options?: { inputProps?: Record<string, unknown> }): FrameRenderer;
```

`renderFrame(f)`: sets the virtual clock to `f` (§7.4) and runs due timers, renders the composition at `f` through
one `SceneRoot`, waits for open `delayRender` handles and font downloads (rendering again from `snapshot()` after
they close), then, if `collectMotionTimes(layers, f)` is not empty, renders the whole composition at each of those
times and calls `attachMotionFrames`, so a layer's own animated props blur too. The result's `scene` has the
composition's `width`, `height`, `fps`, `durationInFrames`, its `background` (`"transparent"` without one),
`fonts: getFonts()`, the composition's `margin` when it has one, the tree's `camera` and `layers`.

### 7.4 Determinism shim

`@kinetograph/core/determinism` exports `installDeterminism()` and `setVirtualFrame(frame, fps)`.
`@kinetograph/core/determinism/install` is a side-effect module that calls `installDeterminism()`; the CLI's bundle
imports it before the project (ESM evaluates imports in order, so a call in the entry's body would come too late).
Once installed:

- `Math.random()` is a seeded generator, reseeded from the frame number at each `setVirtualFrame`, and from a fixed
  seed before the first.
- `Date.now()`, `new Date()` with no arguments and `performance.now()` return the virtual time: `Date` from
  `2026-01-01T00:00:00Z` plus `frame / fps` seconds, `performance.now()` `frame / fps * 1000`.
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` and `requestAnimationFrame` run on the virtual clock:
  callbacks fire, in due order, when `setVirtualFrame` moves the clock past their time; `requestAnimationFrame`
  callbacks run once per frame with the virtual `performance.now()`. The shim keeps the real functions for itself.
- `crypto.getRandomValues()` and `crypto.randomUUID()` draw from the same seeded generator.
- Nothing else is patched (`setImmediate`, promises and I/O are real).

`@kinetograph/core/web/install` (imported by the Node bundle right after it) adds the
browser globals a project commonly touches: `window` and its sizes (the composition's), `matchMedia`, `new Image()` for
project files, `fetch` of project files (remote URLs fail saying Kinetograph renders offline), `document` queries over
the host tree, `getComputedStyle`, `ResizeObserver` and `IntersectionObserver`, and `<canvas>`, `OffscreenCanvas`,
`Path2D` and `ImageData` (§6.5). Refs to DOM elements answer `getBoundingClientRect`, `offsetWidth`, … from the CSS
engine (ENGINE.md §10.3).

### 7.5 Remotion packages (subpath exports)

| Subpath | Remotion package | Notes |
|---|---|---|
| `@kinetograph/core/transitions` (+ `/transitions/fade`, `/slide`, `/wipe`, `/flip`, `/clock-wipe`, `/iris`, `/none`) | `@remotion/transitions` | `TransitionSeries`, `linearTiming`, `springTiming`; presentations render `<Layer>`s with opacity, transforms and clips |
| `@kinetograph/core/motion-blur` | `@remotion/motion-blur` | `Trail`; `CameraMotionBlur` is `<Layer motionBlur={{ samples, shutter: shutterAngle / 360 }}>` |
| `@kinetograph/core/noise` | `@remotion/noise` | `noise2D/3D/4D(seed, …)` |
| `@kinetograph/core/paths` | `@remotion/paths` | pure path maths: `parsePath`, `serializeInstructions`, `reduceInstructions`, `normalizePath`, `getLength`, `getBoundingBox`, `scalePath`, `interpolatePath`, `interpolatePaths(input, inputRange, paths, { easing, posterize, extrapolateLeft, extrapolateRight })`, `warpPath(path, transformer, { interpolationThreshold })`, …; the blends and the warp match the published package digit for digit (arcs aside) |
| `@kinetograph/core/shapes` | `@remotion/shapes` | `make*` functions (`makeRect`, `makeCircle`, `makeEllipse`, `makeTriangle`, `makeStar`, `makePolygon`, `makePie`, `makeHeart`, `makeArrow`, `makeCallout`, `makeSpark`) and the `Instruction` type; components render `<Path>`. `makeArrow`, `makeCallout` and `makeSpark` match the published package's paths exactly |
| `@kinetograph/core/layout-utils` | `@remotion/layout-utils` | `measureText`, `fitText`, `fillTextBox`, `fitTextOnNLines` through `layoutText` (§3), fonts from `getFonts()`; the box filling and the size search follow the published package step by step and give its results on a recorded set of texts |
| `@kinetograph/core/animation-utils` | `@remotion/animation-utils` | `interpolateStyles`, `makeTransform` |
| `@kinetograph/core/captions` | `@remotion/captions` | `parseSrt`, `serializeSrt`, `createTikTokStyleCaptions` |
| `@kinetograph/core/google-fonts` | `@remotion/google-fonts/*` | §7.2 |
| `@kinetograph/core/fonts` | `@remotion/fonts` | §7.2 |
| `@kinetograph/core/lottie` | `@remotion/lottie` | re-exports `<Lottie>`; `getLottieMetadata(animationData)` (`{ fps, durationInSeconds, durationInFrames, width, height }` or null, as the published package) |
| `@kinetograph/core/media` | `@remotion/media` | `Audio` and `Video` (also as `experimental_Audio` and `experimental_Video`), `getTargetSampleRate()` (48000) |
| `@kinetograph/core/determinism`, `/determinism/install` | none | §7.4 |

`@kinetograph/core` also re-exports every element of §6.3 and every helper and type of §5, so a project imports from
one place.

## 8. `@kinetograph/audio` (stream 5)

```ts
export type OnFrameCallback = (ctx: OfflineAudioContext, time: number) => void;
/** Registers synthesis to start at `frame` (absolute). Call at module level; the registry is global
 *  (`globalThis[Symbol.for('kinetograph.audio')]`) so the project's copy and the CLI's agree. */
export function onFrame(frame: number, callback: OnFrameCallback): void;
export function clearOnFrame(): void;

export interface AudioClipTimeline extends Omit<AudioClipJson, 'volume'> { volumes: Map<number, number> /* frame → volume */ }
export function joinClips(frames: { frame: number; audio: AudioClipJson[] }[]): AudioClipTimeline[];
export function renderAudio(options: { fps: number; first: number; last: number; sampleRate?: number /* 48000 */;
                                       clips: AudioClipTimeline[]; baseDir?: string }): Promise<AudioPcm>;
export interface AudioAnalysis {
  integratedLufs: number; truePeakDb: number; clippedSamples: number;
  silences: { start: number; end: number }[];    // seconds, below -60 dBFS for at least 0.5 s
  scenes?: { from: number; to: number; integratedLufs: number; truePeakDb: number }[];
}
export function analyzeAudio(pcm: AudioPcm, options?: { scenes?: [number, number][] /* seconds */ }): AudioAnalysis;
```

`renderAudio` builds one `OfflineAudioContext` for the range (time 0 = frame `first`), calls each `onFrame` callback in
the range with `time = (frame - first) / fps`, plays each clip (decoded with `decodeAudioData`) with its trim, rate,
loop and a gain stepped per frame, and returns the mix. Loudness follows ITU-R BS.1770-4 (K-weighting, gating) and
true peak uses 4x oversampling.

## 9. `kinetograph` CLI and MCP (stream 5)

`npx kinetograph <command> <entry> …`; `<entry>` is a project file (`.tsx`, `.ts`, `.jsx`, `.js`) or a `.json` scene.
Every command takes `--json` (one JSON object on stdout; errors as `{ "error": { "code", "message" } }` and exit code
1), `--comp <id>` (default: the first composition) and `--props <json>`.

| Command | Does |
|---|---|
| `compositions <entry>` | lists compositions |
| `still <entry> <frame> -o out.png [--strict]` | one PNG; unsupported content is drawn without and warned about on stderr, `--strict` fails instead (COMPAT.md §6) |
| `render <entry> -o out.mp4 [--range a..b] [--encoder] [--draft] [--strict]` | video with audio; `--draft` renders at half size; unsupported content is drawn without and warned about, `--strict` fails on the first frame that has some (COMPAT.md §6) |
| `strip <entry> -n 12 -o sheet.png [--strict]` | contact sheet of evenly spaced frames, labelled, built as a scene and rendered by the engine |
| `onion <entry> <range> -n 6 -o onion.png` | frames of the range blended over one another |
| `inspect <entry> [--frame N]` | `InspectResult` |
| `lint <entry>` | text overflowing its box or the canvas, layers off the canvas, overlapping text, missing fonts or assets, type errors (`type-error`, no frame), with frame and layer id |
| `check <entry>` | `tsc --noEmit` on the project (the nearest `tsconfig.json`, else the entry alone): `{ ok, checked, tsconfig, errors, diagnostics: [{ file, line, column, code, message }] }`, exit 1 on errors. Rendering never type-checks (esbuild strips types), so this is how an agent sees a misspelled prop that §6.3 would otherwise ignore |
| `bench <entry> [--frame N --runs K \| --range a..b]` | stages: `js` (renderFrame), `stringify`, then the addon's (`handoff`, `resolve`, `raster`, `composite`, `readback`), `total`. Spike 1 |
| `audio analyze <entry> [--range]` | `AudioAnalysis` per Sequence-free whole and per `--scenes` |
| `snapshot <entry> [--frames 0,30,60] [--update]` | compares PNGs in `__snapshots__/` next to the entry, max channel difference 2 |
| `effects` | `effectCatalog` |
| `doctor [entry] [--range]` | without an entry, the install report; with one, how many frames have nothing unsupported, and every unsupported element or property with its frame ranges (COMPAT.md §7) |
| `studio <entry>` | the studio (§11.5) |
| `mcp` | MCP server on stdio |

Bundling: esbuild bundles the entry with a synthetic entry that imports `@kinetograph/core/determinism/install` first,
then the project, and re-exports `@kinetograph/core`, so the CLI drives frames through the same core and React instance the
project uses. Aliases: `remotion` → `@kinetograph/core`, `@remotion/<pkg>[/sub]` → `@kinetograph/core/<pkg>[/sub]`,
`@remotion/google-fonts/<Family>` → a virtual module calling `makeGoogleFont`. `@kinetograph/native` stays external.
The bundle is written under `node_modules/.cache/kinetograph/`.

The MCP server (`@modelcontextprotocol/sdk`, stdio) exposes one tool per command with the same arguments; each call
runs the CLI as a child process with `--json`, so the server process never installs the determinism shim. `still`,
`strip` and `onion` also return the PNG as image content. An agent skill (`packages/cli/skill/SKILL.md`) explains the
loop: write TSX, `still`/`strip`, `inspect`/`lint`, fix, `render`.

Spike 2 (`spikes/three-dawn`, its own `package.json`, not a workspace): renders a torus knot built in code and a glTF
model (made in the script with `GLTFExporter`, then loaded with `GLTFLoader`, so no third-party asset) with Three.js
`WebGPURenderer` on the `webgpu` package (Dawn) in Node, headless, asserts the backend is WebGPU (not the WebGL
fallback), writes PNGs and prints timings as JSON. Run on the M4.

## 10. Testing

- Cloud (CPU only): `cargo build`, `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test --lib`, `npm ci`, `npm run build`, `npm test`. Never the integration tests in `crates/core/tests/`,
  `still`, `render` or `bench`, nothing that opens a GPU, never `UPDATE_GOLDEN`.
- GPU tests in TS are skipped unless `KINETOGRAPH_GPU_TESTS=1`.
- Rust scene additions get test scenes in `crates/core/tests/scenes/` and golden entries; the goldens are made on the
  M4.
- Values that must match Remotion (`random` bit-exact; `interpolate`, `spring`, `Easing`, `interpolateColors`,
  `noise*`) are tested against fixtures recorded from the published `remotion` packages, run as black boxes in a
  scratch directory outside the repo (never added as dependencies, never read). The fixture file says how it was
  recorded.
- `@kinetograph/react` has snapshot tests of the emitted JSON; `@kinetograph/core` renders small compositions to
  `FrameResult`s and checks them; the CLI's GPU-free paths (bundling, `compositions`, `inspect`, `lint`, `effects`,
  argument parsing) are tested in the cloud.

## 11. Phase 4: video layers and the studio

Written 2026-10-15 by the Phase 4 orchestrator (`HANDOFF.md` §8, "Phase 4 in a cloud session"). §1's rules hold:
the stubs committed with this section have final names and types; streams fill the bodies, may add exports, and do
not edit another stream's files. `packages/studio/src/protocol.ts` is complete and belongs to the orchestrator.

| Path | Owner | What |
|---|---|---|
| `crates/core` (`video.rs`, `gif.rs`, scene, resolve, render, inspect), `crates/core/tests/` | stream 1 `feat/video-layers` | the `video` and `gif` layers of SCENE.md; `ffmpeg-next` 9 becomes a dependency of `kinetograph-core`, and `image` gets its `gif` feature |
| `crates/node/src/media.rs` | stream 1 | `probeMedia`, `decodeAudio` (§11.2) |
| `packages/react` (`<Video>`, `<OffthreadVideo>`, `<Gif>`), `packages/core` (`/gif`, `/media-utils`), `packages/audio` (video sound) | stream 2 `feat/video-elements` | §11.3 |
| `crates/node/src/preview.rs`, `packages/studio/src/` but `protocol.ts`, the CLI's `studio` command, `kg-sequence` in `packages/react` and its use in `packages/core` | stream 3 `feat/studio-server` | §11.2 `preview`, §11.4, §11.5 |
| `packages/studio/ui` | stream 4 `feat/studio-ui` | §11.6 |

`crates/node/src/lib.rs` declares the new exports with their final signatures, calling `media.rs` and `preview.rs`,
whose committed bodies return a `not implemented` error; `index.d.ts` is regenerated from it.

### 11.1 Scene: `video` and `gif` layers

As SCENE.md's [video](SCENE.md#video) and [gif](SCENE.md#gif) sections, typed as `VideoLayer` and `GifLayer` in
`@kinetograph/scene`. `InspectLayer.type` gains `'video' | 'gif'`; both have `src`, and `media: { time: number }`,
the source time in seconds that SCENE.md's rules give at the inspected frame (computed, nothing decoded).
`inspect` and `validateScene` read containers (sizes, durations) but never decode a picture.

### 11.2 Addon additions

```ts
// ---- CPU only ----
export interface MediaInfo {
  kind: 'video' | 'gif';
  width: number; height: number;           // the stream's coded size; a GIF's logical screen
  durationInSeconds: number;               // video: the stream's, else the container's; gif: the sum of the delays
  fps: number | null;                      // video: the stream's average frame rate; gif: null
  frames: number | null;                   // video: the container's count if it has one; gif: the picture count
  hasAudio: boolean;                       // gif: false
  videoCodec: string | null;               // FFmpeg's codec name ('h264'); gif: 'gif'
  audioCodec: string | null;
}
/** Reads a video's or GIF's header (no decoding). `IO` for a missing file, `INVALID_ARG` for one that is neither. */
export function probeMedia(path: string, baseDir?: string): MediaInfo;
/** The first audio stream of any file FFmpeg reads, decoded and resampled (swresample) to `sampleRate`, keeping its
 *  channel count (mono or stereo; more channels are downmixed to stereo). null when the file has no audio stream. */
export function decodeAudio(path: string, sampleRate: number, baseDir?: string): AudioPcm | null;

// ---- GPU ----
export interface PreviewOptions {
  /** 0 < scale <= 1, default 1. The output is round(width * scale) x round(height * scale), at least 1 x 1. */
  scale?: number;
  /** Default 'jpeg'. JPEG is flattened over black; PNG keeps alpha. */
  format?: 'jpeg' | 'png';
  /** JPEG quality 1..=100, default 80. */
  quality?: number;
}
export interface PreviewImage { width: number; height: number; mime: 'image/jpeg' | 'image/png'; data: Buffer }
class Renderer {
  /** One frame rendered at full size, exactly as `rgba`, then box-filtered down to `scale` (premultiplied sRGB
   *  values averaged over each output pixel's footprint) and encoded. Pixels are the render's. */
  preview(sceneJson: string, frame: number, options?: PreviewOptions, baseDir?: string): PreviewImage;
}
```

Errors are §3's codes: a bad `scale`, `format` or `quality` is `INVALID_ARG`. As in §3, the committed `index.d.ts`
wins where its form differs from this sketch: there a `null` above is an absent field, and the string unions are
`string`.

### 11.3 `<Video>`, `<OffthreadVideo>`, `<Gif>` (stream 2)

Written from Remotion's documented props. Exported from `@kinetograph/react` and re-exported by `@kinetograph/core`
(so `remotion`'s `Video` and `OffthreadVideo` resolve to them); `<OffthreadVideo>` is the same component.

| Prop | JSON |
|---|---|
| common props of §6.3 | as there |
| `src` | `src` (a `staticFile` path is absolute) |
| `width`, `height`, `fit`, or `style.width`, `style.height`, `style.objectFit` (as `Img`) | `width`, `height`, `fit` |
| (the timeline) | `from` = the absolute frame of the clip's frame 0 (as `<Audio>`); `frame` = the absolute frame, set only inside a `<Freeze>` |
| `trimBefore`, `trimAfter` (and the older `startFrom`, `endAt`) | `trimBefore`, `trimAfter` |
| `playbackRate` | `playbackRate` |
| `loop` | `loop` |
| `volume` (number or `(frame) => number`), `muted` | not in the layer: an `AudioClipJson` with `video: true` in `RenderedTree.audio`, with the same `id` |
| `transparent`, `toneMapped`, `pauseWhenBuffering`, `acceptableTimeShiftInSeconds`, `onError`, `showInTimeline`, `name`, `delayRenderTimeoutInMilliseconds` | accepted and ignored |

`AudioClipJson` gains `video?: boolean`. `renderAudio` (§8) decodes a clip with `video: true` through
`decodeAudio(src, sampleRate)` instead of `decodeAudioData`; a file without sound plays silence. Volume, mute,
trims, rate, loop and `<Freeze>` work as for `<Audio>`.

`@kinetograph/core/gif` is `@remotion/gif`: `Gif` (`src`, `width`, `height`, `fit` (default `fill`), `style`,
`playbackRate` (default 1), `loopBehavior`: `loop` (default), `pause-after-finish`, `unmount-after-finish`; `onLoad`,
`onError` accepted) emits a `gif` layer with `time = frame / fps * playbackRate` (the native element also takes a
`time`, which `<AnimatedImage>` sets) and `loop = loopBehavior === 'loop'`, and renders nothing past the GIF's duration
with `unmount-after-finish`. `getGifDurationInSeconds(src): Promise<number>`. `preloadGif(src)` probes the file now and
returns `{ waitUntilDone, free }`: `waitUntilDone()` resolves, or rejects with what is wrong with the file, and `free()`
does nothing. `@kinetograph/core/media-utils` is `@remotion/media-utils`' `getVideoMetadata(src): Promise<{
durationInSeconds, width, height, aspectRatio, isRemote: false, fps }>`. Both read `probeMedia`, which the host passes
in as it does `layoutText`: `setMediaProbe(native.probeMedia)` from `@kinetograph/core/media-utils`, which the CLI's
synthetic entry re-exports next to `setLayoutText`.

### 11.4 Timeline data (stream 3)

`<Sequence>` (and so `Series`, `Loop` and `TransitionSeries`) records itself in the tree whether or not it is
showing, as a `kg-sequence` host element:

```ts
interface SequenceJson {
  key: string;              // `${parent key ?? ''}/${name ?? 'Sequence'}@${from}+${durationInFrames}`, stable across frames
  name: string | null;      // the `name` prop
  from: number;             // the absolute frame of the Sequence's frame 0
  durationInFrames: number; // clamped to what is left of the parent's, so always finite
  parent: string | null;    // key of the enclosing Sequence
  layer: string | null;     // id of the group its children are in on this frame; null when not showing or layout="none"
}
```

`TimelineState` gains `sequence?: string | null` (the enclosing Sequence's key; unset or null outside one). `RenderedTree` and `FrameResult`
gain `sequences: SequenceJson[]` (tree order). Automatic ids do not change: `kg-sequence` elements of Sequences that
are not showing take no place in the index path, a showing one takes the place its `<Layer>` took, and one with
`layout="none"` passes its children's places to its parent. Sequences of a Sequence that is not showing are not
rendered, so a whole timeline is the union over frames; two entries with one `key` are one.

### 11.5 The studio server (stream 3)

`kinetograph studio <entry> [--port 3000] [--host 127.0.0.1] [--no-open] [--props <json>]` (the CLI command loads
`@kinetograph/studio` with a dynamic import) calls `startStudio({ entry, port, host, open, props })` from
`@kinetograph/studio`, which resolves to `{ url, close() }`. A taken port is an `INVALID_ARG` error.

- **Isolation.** The project runs in a `worker_threads` worker, so the determinism shim patches only the worker's
  globals; the server thread keeps real timers. The worker owns the preview `Renderer` (one GPU setup) and a
  `FrameRenderer` per (composition, props). Render jobs run in a second worker, one job at a time, with their own
  `Renderer`, so preview stays live while a job runs.
- **Build and reload.** esbuild (the CLI's `bundleProject` options, in watch mode) rebuilds on every save of a file
  the bundle reads. Each successful build gets the next `buildId` (from 1); the worker is replaced by one loading the
  new bundle, then `reload` is broadcast. A failed build keeps the last good one running and broadcasts
  `buildError`; the next good build clears it.
- **Frames.** Preview frames come from `Renderer.preview`: the UI asks for scale 0.5 JPEG while playing or
  scrubbing and scale 1 PNG when paused. Per connection, a frame request that has not started when a newer one
  arrives is dropped without a reply (latest wins).
- **Timeline.** `/api/timeline` runs the JS stage for every frame of the composition (no addon) and returns the
  union of `sequences` and each layer's frame ranges, cached per (buildId, composition, props).
- The UI's built files (`packages/studio/ui/dist`) are served at `/`, with `index.html` for unknown non-API paths.

The routes and messages are typed in `packages/studio/src/protocol.ts`; that file is the contract:

| Route | Answer |
|---|---|
| `GET /api/project` | `ProjectInfo` |
| `GET /api/compositions` | `CompositionInfo[]` (§7.2) |
| `GET /api/frame?comp&frame&scale&format&props` | the image (`Content-Type` its mime, headers `X-Build`, `X-Frame`) |
| `GET /api/inspect?comp&frame&props` | `InspectResult` (§3) |
| `GET /api/timeline?comp&props` | `TimelineData` |
| `GET /api/renders` | `RenderJob[]`, oldest first |
| `POST /api/renders` (`RenderRequest`) | `RenderJob`, status 201 |
| `DELETE /api/renders/:id` | `RenderJob` (cancelled; a finished job is left as it is) |
| `WS /ws` | `ServerMessage`s out, `ClientMessage`s in |

`props` is URL-encoded JSON merged over the composition's `defaultProps` (as `--props`). Errors are a JSON
`{ error: StudioError }` with status 400 (`INVALID_ARG`), 404 (`NOT_FOUND`: route, composition or job), 409
(`BUILD`: no good build yet) or 500 (anything else, with the addon's or CLI's code).

### 11.6 The studio UI (stream 4)

`packages/studio/ui` (`@kinetograph/studio-ui`, private): React 19 + Vite, Tailwind CSS v4 utilities only (no
hand-written CSS beyond the Tailwind entry and shadcn's theme variables), shadcn/ui components (default style, zinc
base colour, dark theme) under `src/components/ui/`, used wherever one fits; the timeline and the preview canvas are
the only custom components. It imports the protocol types from `../src/protocol.ts` (type-only) and talks to the
server through one client module (`src/api.ts`), so tests swap in a mock server.

- Layout (shadcn resizable panels): composition list (left), preview with transport controls (centre), scene tree
  and props panel (right, tabs), timeline (bottom), render queue (a tab or a dialog).
- Transport: play and pause (space), frame step (arrow keys, shift for 10), scrub on the timeline ruler, loop
  toggle, a frame counter and timecode, and the fps the preview actually reaches. Playing paces frames at the
  composition's fps and skips frames the server cannot keep up with; it never shows a frame older than the last.
- Timeline: one row per Sequence (nested under its parent, labelled with `name`) and layer rows below, a playhead,
  a ruler in frames; clicking a row selects that layer in the scene tree.
- Scene tree: the `InspectResult` of the current frame; selecting a layer shows its resolved fields.
- Props panel: a form for the composition's `defaultProps` (strings, numbers, booleans, colours as text; nested
  objects as JSON); an edit re-renders the preview with the new `props`; reset restores the defaults.
- Render queue: start a render of the current composition (range, output, props), the job list with progress, ETA
  from `msPerFrame`, cancel, and the output path when done.
- A `reload` message refetches compositions and re-renders the current frame; `buildError` shows the error over the
  preview until the next good build.
- Built by `vite build` into `ui/dist`. Tests: vitest + Testing Library + jsdom against the mock server.

### 11.7 Audio data (`@remotion/media-utils`)

`@kinetograph/core/media-utils` also has the audio half of `@remotion/media-utils`, for audio-reactive visuals:

- `getAudioData(src)`, `useAudioData(src)`, `useWindowedAudioData({ src, frame, fps, windowInSeconds })` and
  `getAudioDurationInSeconds(src)`. The file is decoded once by the addon's `decodeAudio` (ffmpeg: any file with an
  audio stream, video files included) at 48 kHz and kept per `src`. Decoding is synchronous, so `useAudioData` returns
  the data on the first frame (Remotion's is null until it loads), and the windowed hook's window is the whole file
  with `dataOffsetInSeconds: 0`. The host passes the decoder in with `setAudioDecoder`, as it does `setMediaProbe`.
- `visualizeAudio({ audioData, frame, fps, numberOfSamples, smoothing, dataOffsetInSeconds })`: `numberOfSamples`
  (a power of two) values 0..1, low frequencies first, in equal bands from 0 Hz to half the sample rate. Each is the
  peak magnitude in its band of a 2048-sample (or `2 × numberOfSamples`, if more) Hann-windowed FFT of the channels'
  average, centred on the frame's time and scaled so a full-scale sine reads 1. `smoothing` (default true) averages
  the frames before and after. `optimizeFor` is accepted and changes nothing. This follows Remotion's documented
  behaviour, not its numbers: bars from the two have the same shape, not the same values.
- `getWaveformPortion({ audioData, startTimeInSeconds, durationInSeconds, numberOfSamples, channel, outputRange,
  dataOffsetInSeconds, normalize })`: `numberOfSamples` bars `{ index, amplitude }` of one `channel` (default 0), each
  the mean absolute sample of its block; scaled so the loudest is 1 unless `normalize` is false (default true);
  `outputRange: 'minus-one-to-one'` makes every other bar negative; a window outside the file is silence. Matches the
  published package on recorded windows, errors included.
- `visualizeAudioWaveform({ audioData, frame, fps, windowInSeconds, numberOfSamples, channel, dataOffsetInSeconds,
  normalize })`: `getWaveformPortion` over the window centred on the frame, as `numberOfSamples` numbers from -1 to 1
  to draw as a line (`normalize` default false); a window with fewer samples than bars is an error.
- `getAudioDuration` is `getAudioDurationInSeconds` under its old name. `getImageDimensions(src)` reads the size of a
  PNG, JPEG, GIF, WebP, BMP or SVG file (or `data:` URL) from its header. `createSmoothSvgPath({ points })` is the
  cubic path through the points, and `audioBufferToDataUrl(buffer)` the 32-bit float WAV of an `AudioBuffer` as a
  `data:` URL (stereo interleaved; both match the published package digit for digit).

