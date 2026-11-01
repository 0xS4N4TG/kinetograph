# Authoring contract

The package layout, the addon's JS API, the authoring API, and how
every element and helper maps to `SCENE.md` JSON.

## 1. Layout

npm workspaces (root `package.json`), ESM TypeScript 5.9, Node 22+. Each package builds `src/` to `dist/` with `tsc`
and tests `test/` with vitest 5 (`*.test.ts`, `*.test.tsx`); the addon's CPU tests are `node --test`. Workspace packages import each other by package name (resolved through `dist/`), so build
before testing. Relative imports carry `.js` extensions (`moduleResolution: NodeNext`).

| Path | Package | What |
|---|---|---|
| `crates/node` | `@kinetographdev/native` | napi-rs addon over `kinetograph-core` and the `kinetograph-cli` encoder (§3) |
| `crates/core`, `crates/cli` | Rust | scene features, renderer reuse, `inspect.rs`, the encoder (§4) |
| `packages/scene` | `@kinetographdev/scene` | TS types of the whole SCENE.md schema, effect and paint helpers, motion-blur JSON helpers (§5) |
| `packages/react` | `@kinetographdev/react` | `react-reconciler` host config, native elements, `TimelineContext` (§6) |
| `packages/core` | `@kinetographdev/core` | Remotion core API, frame loop, determinism shim, the pure-TS Remotion packages as subpaths (§7) |
| `packages/audio` | `@kinetographdev/audio` | `onFrame`, offline mix through `node-web-audio-api`, loudness analysis (§8) |
| `packages/cli` | `kinetograph` (bin `kinetograph`) | the CLI commands, the MCP server, project bundling (§9) |

Dependencies point one way: `scene` ← `react` ← `core`; `cli` uses `core`, `audio`, `native`; `core` uses `native` only
for text measurement (`layout-utils`). `react` and `react-reconciler` are peer dependencies of `@kinetographdev/react` and
`@kinetographdev/core`, so a project has one React.

These determinism rules hold everywhere: rendering is a pure function of (project, frame); nothing
reads the wall clock (benchmarks aside) or calls an unseeded random generator; fonts are registered before any text is
measured; Remotion APIs are written from Remotion's documentation, never from its source.

## 2. One frame, end to end

```
kinetograph render src/index.tsx -o out.mp4
  cli: esbuild bundles the entry (aliases `remotion` → @kinetographdev/core, …), installs the determinism shim, imports it
  user code: registerRoot(Root) with <Composition id="Main" component={Main} …/>
  core: createFrameRenderer("Main") → for each frame f: renderFrame(f)
          sets the virtual clock to f, renders <TimelineContext.Provider frame=f><Main/></…> into a SceneRoot,
          waits for delayRender handles, renders the sub-frames that motion blur needs,
          returns { scene: SceneJson (SCENE.md, every number constant), audio: AudioClipJson[] }
  cli: writer.pushFrame(JSON.stringify(result.scene), f)        ← the handoff; pixels never cross into JS
  native: parse + validate, swap the scene into the warm Renderer (one GPU setup), render, read back, encode
  cli: after the last frame, mixes audio (onFrame synth + <Audio> clips) and passes the PCM to writer.finish()
```

A `.json` scene (the scene format) skips the JS stages: the CLI hands the file's text to the addon.

Each frame's scene is a complete SCENE.md document whose `durationInFrames` is the composition's and whose numbers are
the values at that frame, and it is rendered *at that frame number* (so `grain`, `dither` and shaders see the real
frame). Keyframe lists remain legal in it.

## 3. `@kinetographdev/native`

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
  /** An ffmpeg H.264 encoder; default as the Rust CLI (h264_videotoolbox on macOS, else libx264 from the bundled ffmpeg program, then libopenh264). */
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
   * pushed is time 0. The scene's size and fps must match the writer's. The call returns once the frame is queued: a
   * thread of the writer parses and draws it while the caller goes on to the next frame, and the GPU renders frame N+1
   * while N is encoded. An order error is thrown by the call; a frame that cannot be drawn (a wrong size, a missing
   * file) ends the video and is thrown by the next `pushFrame` or by `finish`. */
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

All additions keep old scenes rendering byte for byte.

### 4.1 Flex layout (taffy)

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
- The layout-aware resolve is `Scene::resolve_with_text(&self, frame: u32, text: &mut TextEngine)
  -> Result<ResolvedScene>`; `Renderer` and `inspect` use it.

### 4.2 Transform origin

`transform.originX`, `transform.originY` (animatable, default `0`): a point of the layer's box as a fraction of its
size. Like CSS's `transform-origin`, it moves the pivot and not the layer: with `(ox, oy)` the origin in pixels the
matrix is `translate(x + ox, y + oy) * rotate * scale * translate(-(anchorX + ox), -(anchorY + oy))`, so with no turn
or scale the layer sits where it would without an origin, and `0.5, 0.5` scales and turns it about its centre without
knowing its size. `(ox, oy)` is measured from the box's top-left corner, which for a path is its bounding box's,
not `0, 0` (fixed on the M4: a path at x 300–360 with origin `0.5` turned about x 30). The 3D turn uses the same
pivot. A layer without a box (a group without `layout`) ignores them.
(Not "added to the anchor", which would move every layer given `origin: 'center'`
by half its size; see SCENE.md, Transform origin.)

### 4.3 Text: `align` and per-character styles

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

### 4.4 Lottie (dotlottie-rs at a pinned git tag)

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

### 4.5 Smaller additions

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
  `motionBlur` is ignored, its effects count in the margin. A wrong count or a type mismatch is a load error naming
  the layer.
- **Motion-blur changes**: `motionBlur.changes`, the same sub-frames as `frames` written as what each changes in the
  layer's tree (SCENE.md, "Sub-frame changes"): `samples` lists of layers, each standing in for the layer of its id at
  that sub-frame, a group optionally keeping its children. It is what the authoring layer emits for motion blur
  (§5.3); a scene with `frames` still loads.

### 4.6 Renderer reuse and inspect

- `Renderer` gets a way to take a new `Scene` while keeping its device, queue, Skia context, compositor pipelines
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

## 5. `@kinetographdev/scene`

Pure TypeScript, no dependencies.

### 5.1 Types

`SceneJson`, `LayerJson` (a union over `type`), `Transform`, `Effect` (a union over all 23 SCENE.md effect types),
`Paint`, `Gradient`, `Clip`, `Mask`, `Matte`, `MotionBlurJson`, `CameraJson`, `Layout`, `LayoutItem`, `CharStyle`,
`Num` (`number | Keyframe[]`), `KeyframeEasing` (named so it cannot clash with Remotion's `Easing` when
`@kinetographdev/core` re-exports this package), `ColorString`, `BlendMode`, plus `AudioClipJson` (§6.4). Field names, optionality and
literal unions follow SCENE.md and §4 exactly. A JSON value that type-checks as `SceneJson` should load.

### 5.2 Helpers

Every effect has a helper named after its `type` that takes the effect's fields without `type`, e.g.
`dropShadow({ y: 12, blur: 24 })`, `shader({ code, uniforms })`. Effects whose one required field is a number also
take it bare: `blur(24)`, `glow(16)`, `backdropBlur(16)`, `saturate(1.5)`, `contrast(1.2)`, `brightness(0.8)`,
`grayscale(1)`, `sepia(1)`, `invert(1)`, `hueRotate(90)` (the `angle`), `chromaticAberration(4)`; `grain(amount, {
seed, … })` and `dither(levels, { … })` take their main field first. Each returns the plain SCENE.md object.

`motionBlur({ samples, shutter })` returns a marker that may sit in an `effects` array; the reconciler moves it to
the layer's `motionBlur`.

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
collectMotionLayers(layers: LayerJson[], frame: number): Set<string>        // the ids of those outermost blurred layers
attachMotionChanges(layers: LayerJson[], frame: number, treesAt: ReadonlyMap<number, LayerJson[]>): LayerJson[]
//   new layers with motionBlur.changes filled from the trees rendered at those times, matched by id and type:
//   for each sub-frame, the layers of the blurred tree whose values differ from the frame's own;
//   a layer missing (or of another type) at a time becomes itself with opacity 0 there
attachMotionFrames(layers: LayerJson[], frame: number, treesAt: ReadonlyMap<number, LayerJson[]>): LayerJson[]
//   the same as whole copies in motionBlur.frames
```

## 6. `@kinetographdev/react`

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

### 6.2 Timeline context (`timeline.ts`)

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
| `<Image>` | `src` (PNG, JPEG, GIF, WebP, or an SVG file or `data:` URL, drawn sharp at its drawn size; text inside an SVG picture is left out and warned about), `width?`, `height?`, `fit?` | `image` |
| `<Noise>` | `width`, `height`, `turbulence`, `channels` | `noise` |
| `<MeshGradient>` | `width`, `height`, `columns`, `rows`, `points`, `colors` | `meshGradient` |
| `<Canvas>` | `width`, `height` (whole numbers, not animated), `draw(context)` | `canvas`: `draw` is called with a fresh, empty `CanvasContext2D` (§6.5) each time the tree is read, and the commands it drew are the layer's `commands` |
| `<Lottie>` | `src` or `animationData` (parsed JSON, written once to a content-addressed cache file), `width?`, `height?`, `loop?`, `playbackRate?` (default 1) | `lottie` with `time = frame / fps * playbackRate` from the timeline |
| `<Camera>` | `perspective`, `x?`, `y?` | the scene's `camera` (at most one per tree; anywhere in it) |
| `<Audio>` | Remotion's: `src`, `volume` (number or `(frame) => number`), `trimBefore`/`trimAfter` (and the older `startFrom`/`endAt`), `playbackRate`, `loop`, `muted` | an `AudioClipJson` in `RenderedTree.audio`, not a layer |

Raw text outside `<Text>` is an error naming the parent element. Duplicate explicit ids are an error naming the id.

### 6.5 Canvas 2D

A Canvas 2D context that records instead of rasterising (`createCanvasContext` of `@kinetographdev/scene`,
`packages/scene/src/canvas.ts`). It keeps the canvas's state as a browser's does (transform, `fillStyle` and the
other styles, line and text state, `save`/`restore`, clips) and writes each drawing call as a `canvas` layer command
with the state it is drawn in (SCENE.md, "canvas"); Rust draws the commands with Skia. Nothing in it reads a clock,
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
| Styles | `fillStyle`, `strokeStyle` as CSS colours (named, hex, `rgb()`, `hsl()`; no `lab()`, `oklch()`, `color()`: such an assignment is ignored, as an invalid one is), `createLinearGradient`, `createRadialGradient`, `createConicGradient`, `createPattern` of an image, `ImageData` or another canvas (any number of tiles, in fills, strokes and text), `globalAlpha`, `globalCompositeOperation` (all 26 plus `clear` for `clearRect`), `lineWidth`, `lineCap`, `lineJoin`, `miterLimit`, `setLineDash`, `lineDashOffset`, `imageSmoothingEnabled` |
| Transform | `scale`, `rotate`, `translate`, `transform`, `setTransform` (six numbers or a matrix), `resetTransform`, `getTransform`, `save`, `restore`, `reset` |
| Text | `fillText`, `strokeText` (with `maxWidth`), `measureText` (width from the text engine; the other metrics from the line's ascent and descent), `font` (the shorthand: style, weight, size in `px`, `pt`, `em`, `%` or a keyword, a family list), `textAlign`, `textBaseline` |
| Pictures | `drawImage` (three forms) of an `<img>`, `new Image()` (a project file or a `data:` URL), a `<video>` (the frame at its `currentTime`), the frame `<Video onVideoFrame>` hands over (§11.3), another canvas (`<canvas>`, `document.createElement('canvas')`, `OffscreenCanvas`: its commands, drawn as a whole) or `ImageData`; `createImageData`, `putImageData` (with a dirty rectangle), `getImageData` |
| Elsewhere | `canvas.width`/`height` (setting either empties the canvas and resets the context), `toDataURL()` (always PNG), `toBlob`, `OffscreenCanvas`, `Path2D`, `ImageData`, `CanvasGradient`, `CanvasPattern`, `CanvasRenderingContext2D` as globals |

Kept and drawn with nothing (reading back what was set works): `letterSpacing`, `wordSpacing`, `fontKerning`,
`fontStretch`, `fontVariantCaps`, `textRendering`, `direction`, `imageSmoothingQuality`. `isPointInPath` answers
with the fill rule, and `isPointInStroke` with the line width, caps, joins, miter limit and dashes in the current
transform, as Chrome does (checked against Chrome on every pixel of twelve cases: straight edges agree exactly, a
curve's to a tenth of a pixel).

Shadows and filters are drawn (SCENE.md, "canvas"; checked against Chrome by `crates/dom/tests/canvas/canvas_effects.js`):

- **Shadows.** `shadowColor`, `shadowBlur`, `shadowOffsetX/Y` shadow what `fill`, `stroke`, `fillText`, `strokeText`,
  `fillRect`, `strokeRect` and `drawImage` draw, as the spec has it: while the colour has alpha and the blur or an offset
  is not 0, the shape casts a shadow under itself, blurred with a deviation of half `shadowBlur` and offset by
  `shadowOffsetX/Y`, which the transform does not change. `globalAlpha`, `globalCompositeOperation` and the clip apply
  to the shadow and to the shape.
- **`filter`.** `none`, or a list of `blur()`, `brightness()`, `contrast()`, `drop-shadow()`, `grayscale()`,
  `hue-rotate()`, `invert()`, `opacity()`, `saturate()` and `sepia()`, with CSS's units (`px`, `pt`, `em` as 16 px,
  `%` or a number, `deg`, `rad`, `grad`, `turn`). It runs over each command's drawing before its shadow is cast. A value
  that is not a filter list is ignored. A `url(#id)` naming an SVG `<filter>` of the page is drawn in its place in the
  list, its `objectBoundingBox` units over the canvas's box, as in Chrome (`crates/dom/tests/canvas/canvas_url_filter.js`);
  one that names nothing, or is on a `<Canvas>` component (no page to find it in), is reported as unsupported and the
  rest of the list is drawn. `clearRect` and `putImageData` are not filtered, nor do they cast shadows.
- A command with either costs GPU passes of its own (drawn alone, blurred, drawn again as a picture), so a canvas with
  hundreds of shadowed shapes is slower than one without. `getContext('webgl')` and
`'webgl2'` return a recording WebGL context (§6.7); `'webgpu'` returns a recording WebGPU context (ENGINE.md, "WebGPU"), compute passes, storage buffers and storage textures included. A page whose compute passes build on what an earlier frame left is replayed from that history and reported; to make a frame the same alone, clear or rewrite what the kernels write at the start of the frame; another context type returns `null`.

- **Fonts.** `font` is matched against the registered fonts (`registerFont`, `loadFont`, `@font-face`) by family
  (the first of the list that has a face), then the nearest weight and the right style of it; a family with no face
  registered gives the key a `<Text>` of that font would (`'Unknown:700'`), which the scene then lacks, like a `<Text>`.
  The text engine measures and draws with the same face, so `measureText` is what is drawn.
- **`getImageData`, `toDataURL`, `toBlob`.** They need the pixels of what has been drawn, so they ask the addon to draw
  the commands on a transparent canvas (`renderCanvas`) and read it back; without the addon they throw. The first call
  in a process opens the GPU (25 to 100 ms measured on the M4); the device is kept, so a later call costs the draw and
  the readback (about 3 ms at 1080p, plus the decode when the picture is a video frame). A canvas drawn into another
  with `drawImage` is not drawn to pixels: its commands are copied in, which keeps it sharp.
- **A picture drawn many times.** The same `OffscreenCanvas`, canvas or `ImageData` drawn by many commands (a sheet as
  hundreds of clipped, transformed triangles) is written once per layer, in the layer's `sources` table (SCENE.md
  "canvas"), and the renderer decodes it, or records its commands, once and replays that for every draw. It is the
  same object while nothing is drawn on it (a canvas's log only grows, so its length is its version); after more is
  drawn, or `canvas.width` is set, it is a new picture, and the pictures already drawn keep what they were. An
  `ImageData` is hashed to see that its `data` was written to: once for each frame it is drawn in (a frame begins
  when a context is made, or one in the tree is reset for a new frame), and at every draw when it is up to 128 x 128. So a
  write to a large `ImageData` between two draws of it in the same frame is not seen by the second; draw a copy
  (`new ImageData(new Uint8ClampedArray(data), w, h)`) when one buffer is written and drawn in a loop. The base64
  encoding is made once for each content, not at each draw.
- **Reading a picture without the GPU.** When the canvas holds one plain `drawImage` (after any `clearRect`) of a
  picture file or a video frame, `getImageData` does not draw: the addon's `readCanvasPicture` answers it on the CPU
  from the decoder's cache, resampled like the renderer's bilinear filter (within 1 level of the GPU draw; the same
  bytes at 1:1), so reading a frame per video frame needs no GPU and no device start-up. It applies when the draw has
  no shadow, filter, alpha or composite operation, only a scale and shift in the transform, and a destination box on
  whole pixels; with `imageSmoothingEnabled = false` also when the picture is not shrunk. Anything else, including a
  canvas that has been drawn on after the picture, is drawn by the renderer as before (same bytes, the GPU cost).
  `texImage2D` of a frame reads it the same way.
- **Images.** `drawImage` of an `<img>` or `new Image()` names the file; it is read when the renderer is built, as an
  `<Image>` layer's is. `drawImage` of a `<video>` or of an `onVideoFrame` frame names the file and the instant
  (`{ kind: 'video' }`, SCENE.md "canvas") and the renderer decodes that picture with the decoder a `<Video>` layer
  uses; a frame is the same bytes whichever frames were drawn before it. `putImageData` replaces what is under it (it ignores the transform, alpha and composite
  operation, but not an open clip).
- **Sizes.** The bitmap is `width` x `height` (300 x 150 by default); CSS stretches it to the element's box as
  `object-fit: fill` does. The commands are drawn at the box's size, not resampled from the bitmap, so a stretched canvas
  is sharp where Chrome's is blurred (ENGINE.md §4, "`<canvas>`").

### 6.6 The 3D layer

`<Scene3D width height msaa? environment?>` is a `scene3d` layer (SCENE.md, "scene3d"); it takes the common layer props
(`x`, `rotateY`, `effects`, `blendMode`, ...) and these children, all of which must be inside it:

| Element | Props |
|---|---|
| `<Camera3D>` | `type`, `fov`, `height`, `near`, `far`, `position`, `target`, `up`. At most one. |
| `<AmbientLight>`, `<DirectionalLight>`, `<PointLight>` | `color`, `intensity`; `direction`, `castShadow`, `shadow`; `position`, `range`. |
| `<Mesh geometry material?>` | `geometry` is `{ kind: 'box' \| 'sphere' \| 'plane' \| 'cylinder' \| 'torus', ... }`. |
| `<Model src material? animation? time? loop?>` | A glTF or GLB file. `animation` is the name or position of one of its clips; `time` is seconds into the clip (default `frame / fps`), `loop` (default true) says what a clip does at its end. |
| `<Text3D font size depth align lineHeight material>` | The text is the children (strings and numbers); `weight` and `fontStyle` pick the font key as for `<Text>`. |
| `<Extrude path size depth fillRule material>` | SVG path data. |
| `<Group3D>` | Objects that move together. |

`environment` is the path of an equirectangular `.hdr`, `.png` or `.jpg` that lights the scene (image-based lighting), or
`{ src, intensity, rotation, background, backgroundIntensity, backgroundBlur }` (SCENE.md, "scene3d", "environment").

Every object takes `position`, `rotation` (degrees), `scale` (a number or `[x, y, z]`), `visible` and `id`; `<Mesh>`,
`<Model>`, `<Text3D>` and `<Extrude>` also take `castShadow` and `receiveShadow`, which do something under a
`<DirectionalLight castShadow shadow={{ mapSize, bias, normalBias, radius }}>` (SCENE.md, "scene3d"). Every
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
  fragment, ... })` of `@kinetographdev/scene` returns the recording, and `glslLayer(context, layer)` makes a layer from
  any context.
- **`canvas.getContext('webgl' | 'webgl2' | 'experimental-webgl')`** in a Remotion project (`<canvas>`,
  `document.createElement('canvas')`): a `WebGLRenderingContext` that records. A project's own WebGL code (shader
  transitions, Shadertoy ports) runs as it is: `createShader`, `createProgram`, `bindAttribLocation`, buffers,
  vertex arrays, `vertexAttribPointer`, the `uniform*` calls, `texImage2D` from an image, a canvas, `ImageData` or an
  array, `texParameteri`, `generateMipmap`, `activeTexture`, `pixelStorei` (flip and premultiply), `viewport`,
  `scissor`, `enable` (`BLEND`, `CULL_FACE`, `SCISSOR_TEST`), `blendFunc` and the rest of blending, `colorMask`,
  `clearColor`, `clear`, `drawArrays` and `drawElements` of triangles and of points (`gl_PointSize` pixels, 1 to 511, with
  `gl_PointCoord`; 511 is also what Chrome reports on Apple silicon), `gl_VertexID`, and in WebGL 2
  `drawArraysInstanced`, `drawElementsInstanced`, `vertexAttribDivisor(i, 1)` (`gl_InstanceID`), `clearBuffer*`, and
  `blitFramebuffer` of colour, depth and stencil (colour `NEAREST` or `LINEAR`, mirrored by reversed corners; depth
  and stencil texel for texel; with `antialias`, as in Chrome, nothing is blitted into the canvas and it is read only
  into a rectangle of its own bounds). The stencil test is drawn: `enable(STENCIL_TEST)`, `stencilFunc`, `stencilOp`,
  `stencilMask` and their `Separate` forms, `clearStencil`, on a canvas made with `stencil: true` and on a framebuffer
  with a stencil buffer. `getShaderParameter(COMPILE_STATUS)` is true: a shader naga cannot read fails when the scene
  loads, naming the line. `getExtension('OES_standard_derivatives')` and, in WebGL 1, `'WEBGL_depth_texture'` answer;
  other extensions return `null`.
- **Framebuffers** (multi-pass shaders: render to a texture, then sample it; ping-pong; blur passes):
  `createFramebuffer`, `bindFramebuffer` (`FRAMEBUFFER`, and in WebGL 2 `DRAW_FRAMEBUFFER` and `READ_FRAMEBUFFER`),
  `framebufferTexture2D` of an RGBA, `UNSIGNED_BYTE` `TEXTURE_2D` (any level with storage, in WebGL 2) to
  `COLOR_ATTACHMENT0` and, in WebGL 2, `COLOR_ATTACHMENT1` to 7 with `drawBuffers` (fragment outputs at
  `layout(location = n)`); a depth texture (`DEPTH_COMPONENT16/24/32F`, `DEPTH24_STENCIL8`, or `DEPTH_COMPONENT` with
  `WEBGL_depth_texture`) to `DEPTH_ATTACHMENT` or `DEPTH_STENCIL_ATTACHMENT`, which later draws sample as its depth;
  `renderbufferStorage` of colour (`RGBA4`, `RGB565`, `RGB5_A1`, `RGBA8`, each drawn as RGBA8), depth, `STENCIL_INDEX8`
  or depth-and-stencil formats with `framebufferRenderbuffer`; `checkFramebufferStatus`, `readBuffer`,
  `invalidateFramebuffer`, `deleteFramebuffer`, `isFramebuffer`; binding `null` returns to the canvas. Draws, `clear`
  and `viewport` act on the bound framebuffer's attachments, in GL's orientation (a texture's first row is the bottom
  one), and its textures can then be sampled by later draws. Call `viewport` after binding a framebuffer, as GL needs.
  Allocate a texture with `texImage2D(..., null)` (or `texStorage2D`, with levels); one that holds uploaded pixels, or
  is not RGBA, cannot be drawn into. A framebuffer with no attachment, or one not yet specified, is incomplete:
  `checkFramebufferStatus` says so and a draw or clear sets `INVALID_FRAMEBUFFER_OPERATION`. A draw that samples a
  texture attached to the framebuffer it draws into sets `INVALID_OPERATION` and draws nothing. A render is a function
  of its own frame: every framebuffer texture starts a frame transparent black (a depth buffer at 1, a stencil buffer
  at 0), so a pass reading what an earlier frame left reads black. A texture drawn into cannot be given
  `generateMipmap`; `texSubImage2D` of a canvas, `ImageData`, an array of pixels, an image or a layer's picture patches
  it in order with the draws (and lays a picture over a texture made from an image or a layer); sample it with
  `LINEAR` or `NEAREST`, or set `TEXTURE_MAX_LEVEL` to the levels it has (a mipmapped minification filter without
  complete levels is incomplete, and reads black).
- The drawing buffer is emptied before every frame (a frame is a function of its own calls, so the frames can be made
  in any order), `preserveDrawingBuffer` or not, and a frame that draws nothing draws nothing. A canvas has one kind of context for good; `getContext('2d')` after `getContext('webgl')`
  returns `null`.
- Anything outside the list throws a `WebGLUnsupportedError` (message starting `unsupported:`) saying what to do:
  multisampled renderbuffers, `readPixels`, lines, instanced points, cube and float textures, attachments of different
  sizes in one framebuffer, `getContext('webgpu')`, and drawing or `toDataURL`-ing a WebGL canvas.
  The depth test is drawn: `enable(DEPTH_TEST)`, `depthFunc`, `depthMask`, `depthRange`, `clearDepth`, `clear(DEPTH_BUFFER_BIT)` and
  `polygonOffset` on the canvas (the `depth` attribute, true by default) and on a framebuffer with a depth
  renderbuffer or depth texture; framebuffers that attach one depth buffer share it.

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
  hfFx?: HfAudioFxJson;  // a HyperFrames element's audio effects (below); `volume` is then the gain after its chain
}

interface HfAudioFxJson {
  track: string;         // the element: its clips are one input to its chain
  start: number;         // composition seconds of the element's time 0 (the clock of its lanes)
  end: number;           // composition seconds it ends at; an effect tail plays on, at most 5 s
  chain: string | null;  // its data-fx-chain, or null without an effect in the path
  automation: string | null; // its data-automation (the fx.* lanes)
  pre: number;           // the gain ahead of the chain (data-volume when the chain has effects)
  after: number;         // the gain after the chain from `end` on (0 after a fade-out)
  group: { id: string; chain: string; automation: string | null; volume: number } | null; // its <hf-audio-group> bus, when that has effects: fader = volume x its volume lane, on composition time
  master: string | null; // the root composition's data-fx-chain, run over the whole mix
}
```

`hfFx` is set by the HyperFrames runtime (`<Audio hfFx={(frame) => ...}>`, internal). The mixer (§8) plays each
element with effects on its own: its sound at `pre`, through its chain in an `OfflineAudioContext` of
node-web-audio-api with its lanes on its clock, then `volume` per frame; a group's members summed through the group's
chain and fader (held between its members, as HyperFrames bakes it); the master chain over the sum (`packages/audio/src/hf-fx/`, ported from HyperFrames, Apache-2.0).

`toneFrequency` is Remotion's prop of `<Audio>` and `<Video>`: the pitch is multiplied by it (0.01 to 2, anything
else throws) and the speed is not. The mixer shifts each file once per value: a WSOLA time stretch by the factor
(windows of 1024 samples, half overlapping, each moved up to 256 samples to line up with the last, the same positions
for every channel), then a linear resample back to the original length. It is plain arithmetic on the samples, so
the same file and value always give the same sound. A change of `toneFrequency` starts a new clip timeline (§8).

A clip appears in the tree of every frame it plays in; the CLI joins them by `id` into one clip with a volume per
frame (§8).

## 7. `@kinetographdev/core`

### 7.1 Remotion core API

Exported from `@kinetographdev/core` (and so from `remotion` through the CLI's alias), behaving as Remotion documents
them: `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`, `measureSpring`, `Easing`,
`random`, `Sequence`, `Series` (and `TransitionSeries`: children wrapped in a `React.Fragment`, nested ones too, are flattened, so a `.map()` can emit a Transition and Sequence pair), `Loop`, `Freeze`, `AbsoluteFill`, `Img`, `Audio` (re-exported from react), `staticFile`,
`delayRender`, `continueRender`, `cancelRender`, `getRemotionEnvironment`, `Composition`, `Still`, `Folder`,
`registerRoot`, `getInputProps`.
`random(seed)` is bit-exact with Remotion's; the rest match its documented behaviour, tested against values recorded
from the published package (§10).

Mapping onto the engine:

- `Sequence` renders its children inside a `<Layer>` (no layout), only while `from <= frame < from +
  durationInFrames`, and shifts the timeline by `from`. `name` becomes nothing; `layout="none"` is accepted. With
  DOM elements inside it, or around it, that layer is Remotion's wrapper, an `AbsoluteFill` `div`, in the same CSS tree
  as the DOM around it (the Remotion compatibility docs, `/docs/compat/`; ENGINE.md §10.1); a `Sequence` of native elements keeps its own positions.
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
  The output range can also be numeric tuples (one number per component), CSS strings (scale `'1 2'`, translate
  `'0px 10%'`, rotate `'45deg'` or `'x 45deg'`, transform-origin `'left top'`; units are kept and must agree per axis),
  font weights (`outputType: 'font-weight'`: `'normal'`, `'bold'`, a number), and words or booleans, which step with
  `easing: Easing.step1`. `output: 'perceptual-scale'` blends the area of a scale, so a zoom looks even; `outputType`
  names what the strings are and rejects other kinds. `Easing.step0`, `Easing.step1` and `Easing.spring({ allowTail })`
  exist for these. Recorded from `remotion@4.0.530` (`test/fixtures/interpolate-values.json`).
- The components Remotion's Studio edits, `Track` and `Interactive` (`Interactive.Div`, `.Span`, `.Svg`, `.Circle`, …
  and `Interactive.create()`, `withSchema()`): each is a `<Sequence layout="none">` around the element, so it shows from
  `from` for `durationInFrames` under the name `<Interactive.Div>` (or `name`), is drawn from its props, and takes
  `hidden`, `freeze` and the four `crop*` props (a `clip-path: inset(…)`, rounded to the element's `border-radius`;
  recorded from the published package). `trimBefore`, `playbackRate` and `loop` are the `<Sequence>`'s own: the
  children's frame is `(frame - from) * playbackRate + trimBefore`, they are on screen for `durationInFrames /
  playbackRate`, and `loop` (which needs a finite `durationInFrames`) starts them again at `trimBefore` each time it
  ends. Only the frame clock changes: an `<Audio>` or `<Video>` inside does not take the rate or trim. `premountFor` and the like are the preview's and a render ignores them as
  Remotion does. `Interactive.create({ Component, layout: 'absolute-fill' })` puts the component in a clipped `div` of
  the `width` and `height` props. The field tables (`Interactive.baseSchema`, …, and `absoluteFillSchema`) are
  Remotion's data, unused in a render.
- Canvas components. Remotion runs its effects and `<HtmlInCanvas>` on browser canvases; here they run on recording
  canvases, whose drawing the renderer replays (SCENE.md, "Shader groups" and "Canvas passes"):
  - `createEffect(definition)` returns the factory and its descriptors (key with the `disabled` flag, schema with the
    `disabled` field; recorded from the published package). `validateParams` runs in the factory, as in Remotion.
  - `<Solid>`, `<CanvasImage>`, `<AnimatedImage>` and `<HtmlInCanvas>` run their `effects` as `runEffectChain` does: the
    element is drawn as a layer, effect 1 is handed its picture as `source` and draws on `target` (a `2d` or `webgl2`
    context), effect N is handed what effect N-1 drew, the last picture is what the element shows. `disabled` effects
    are skipped. `width` and `height` are the canvas's pixels (`ceil(size * pixelDensity)`, or `effectsOutputSize`),
    and `flipSourceY` is `true` (every source is a canvas as the DOM holds it): upload with
    `gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipSourceY)`. WebGL 2 targets are made as Remotion's pool makes them
    (`premultipliedAlpha`, `preserveDrawingBuffer`, `UNPACK_PREMULTIPLY_ALPHA_WEBGL` on). A 2D effect draws the source
    with `ctx.drawImage(source, ...)`, filters, shadows, clips and composite operations included; `getImageData` of the
    source is not available. **State:** a frame is a function of the frame, so `setup(target)`, `apply` and
    `cleanup(state)` run in that order for every frame on a canvas that starts empty; Remotion keeps `setup`'s state from
    frame to frame, which differs only for an effect whose picture depends on what earlier frames left in it. A
    `webgpu` effect runs on a recording device (`gpuDevice`) and canvas: copy the picture with
    `queue.copyExternalImageToTexture({ source }, ...)` into an `rgba8unorm` texture and sample it. One that makes a call that
    is not drawn (query sets, depth, readback, ...) is drawn without, with a warning once and an unsupported item, so
    `--strict` fails.
  - `<Solid width height color>` is a box of that size and colour; `<CanvasImage src width height fit>` the picture
    fitted into it (an image layer when nothing needs CSS, an `img` with the `object-fit` and crop when it does). With
    an enabled effect either is a `div` (the canvas box: its `className`, `style` and crop, clipped to its size)
    holding the chain's layers.
  - `<HtmlInCanvas width height onPaint onInit effects>`: the children are drawn as a layer and `elementImage` is its
    picture, `ctx.drawElementImage(elementImage, dx, dy[, dw, dh])` on a `2d` canvas context and
    `gl.texElementImage2D(..., elementImage)` on a `webgl2` or `webgl` one draw it. `canvas` is a recorder of the size
    in pixels, `element` has the size of the element (`clientWidth`, `getBoundingClientRect()`), `pixelDensity` is the
    prop. For every frame `onInit` runs first, then `onPaint` (with no `onPaint` the picture is drawn on a 2D context,
    as Remotion's default does), then the cleanup `onInit` returned (it must return one, as in Remotion). What follows
    is the effect chain over what `onPaint` drew. An `async` `apply`, `onInit` or `onPaint` holds the frame until its
    promise settles (`delayRender`), so what it draws after an `await` is in the frame; a rejection is reported for the
    frame and the picture is drawn without that stage. A `webgpu` context runs (a call that is not drawn shows the children
    and is reported as unsupported). `isHtmlInCanvasSupported()` is true; `isHtmlInCanvasNestingSupported()` is false (an
    `<HtmlInCanvas>` in the children of another is not tried).
  - `<IFrame>` is the `iframe` element, which the CSS engine reports as unsupported (`--strict` fails on it).
  - `<Artifact>` draws nothing and records its file (`getArtifacts()`); `kinetograph render` writes the ones recorded
    in the frames it rendered into the folder of the video (text and bytes as they are, `Artifact.Thumbnail` as the PNG
    of its frame) and lists them in `artifacts` of the result. A filename must stay inside that folder.
  They take `from`, `durationInFrames`, `name`, `hidden`, `freeze` and the crop props as `Interactive` does.
- `<AnimatedImage src width height fit loopBehavior playbackRate>` (`loopBehavior`: `loop`, `pause-after-finish`,
  `clear-after-finish`). A GIF is a native `gif` layer (§11.3) shown at the picture Remotion's `ImageDecoder` path picks
  for that time: of the picture that has started and the next, the one whose start is nearer (so a picture changes
  half its delay early), with the next on an exact tie. The pictures' starts are read from the file's graphic control
  extensions (a delay of 10 ms or less shows for 100 ms, as in the `gif` layer; checked against the engine's
  `probeMedia` on the repository's GIFs). `playbackRate` scales the time and shortens `durationInFrames`; a `loop`
  without a `durationInFrames` is `loopBehavior="loop"`. With `className`, `style` or a crop the layer sits in a `div`.
  A file that is not animated (a PNG or WebP without animation) is drawn as a still (`Img`); an animated GIF, APNG or WebP
  plays through the `gif` layer.
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

`registerFont` is also behind `@kinetographdev/core/fonts` as `loadFont({ family, url, weight, style })` (Remotion's
`@remotion/fonts`, with `url` a path). `@kinetographdev/core/google-fonts` provides `makeGoogleFont(familyName)`, which
returns the module Remotion's `@remotion/google-fonts/<Family>` exports (`loadFont(style?, { weights, subsets })`,
`fontFamily`); it downloads TTFs once into `~/.cache/kinetograph/fonts` and registers them, and the frame loop waits
for downloads before the first frame. The CLI maps `@remotion/google-fonts/<Family>` imports onto it.

`@kinetographdev/core/fonts` also exports `makeWebFont(cssUrl, options?)` for any `@font-face` stylesheet URL, the
fonts that are not on Google (Fontshare, Bunny Fonts, a font host's own CSS). It returns `{ fontFamily, loadFont(style?,
{ weights }) }`, the same shape as the Google module: `makeWebFont(FONTSHARE_CSS).loadFont('italic', { weights: ['700'] })`
where `FONTSHARE_CSS` is `https://api.fontshare.com/v2/css?f[]=switzer@400,401,700,701&display=swap`. Use it instead
of pinning file links (`cdn.fontshare.com/wf/<hash>/...ttf`), which change with each release; the stylesheet URL is
stable and lists the current files. A project's own `fetch` is blocked during a render (ENGINE.md §10), so this is
the way to look a font up by its stylesheet. It reads the stylesheet (cached in `~/.cache/kinetograph/fonts`), keeps
the blocks of the style and weights asked for (every weight by default), downloads one file per block once, and
registers it with that block's weight and style under the stylesheet's `font-family` (which `fontFamily` reads, once,
with the thread blocked). A block that lists several formats gives its TrueType or OpenType file when it has one,
else its first (the renderer reads WOFF and WOFF2 too); `//cdn...` links take the scheme of the stylesheet's URL. If
a file answers 404 (the host released new files), the stylesheet is downloaded again past the cache, replacing the
cached copy, and the file is taken from its new answer; files already in the cache are used as they are. The files
come from the host into the user's cache, so a font whose licence forbids redistributing it (Fontshare's) is not
shipped with the project.

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
times and calls `attachMotionChanges`, so a layer's own animated props blur too. A sub-frame's tree is only read for
the blurred layers, so its emit leaves out what cannot hold one: a DOM island with no native element in it and a
native element other than a `<Layer>`, outside the blurred layers (`EmitOptions.subFrameLayers`). The frame's own
render and its sub-frames are one pass of the DOM islands (compat/dom `beginSamplePass`): an island's document is
edited from one render to the next, and a later render's layers that are the same as the island's first are the same
objects. A sub-frame's islands are queued (`startDomIsland`) and drawn on the island thread while the next sub-frame
renders; `finishIslands` puts their layers in, in the order they were drawn. The result's `scene` has the
composition's `width`, `height`, `fps`, `durationInFrames`, its `background` (`"transparent"` without one),
`fonts: getFonts()`, the composition's `margin` when it has one, the tree's `camera` and `layers`.

### 7.4 Determinism shim

`@kinetographdev/core/determinism` exports `installDeterminism()` and `setVirtualFrame(frame, fps)`.
`@kinetographdev/core/determinism/install` is a side-effect module that calls `installDeterminism()`; the CLI's bundle
imports it before the project (ESM evaluates imports in order, so a call in the entry's body would come too late).
Once installed:

- `Math.random()` is a seeded generator, reseeded from the frame number at each `setVirtualFrame`, and from a fixed
  seed before the first.
- `Date.now()`, `new Date()` with no arguments and `performance.now()` return the virtual time: `Date` from
  `2026-01-01T00:00:00Z` plus `frame / fps` seconds, `performance.now()` `frame / fps * 1000`.
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` and `requestAnimationFrame` run on the virtual clock:
  callbacks fire, in due order, when `setVirtualFrame` moves the clock past their time; `requestAnimationFrame`
  callbacks run once per frame with the virtual `performance.now()`, after the frame has rendered (so a library that
  draws in one, such as Motion's render step, shows that frame). The shim keeps the real functions for itself.
- `crypto.getRandomValues()` and `crypto.randomUUID()` draw from the same seeded generator.
- Nothing else is patched (`setImmediate`, promises and I/O are real).

`@kinetographdev/core/web/install` (imported by the Node bundle right after it) adds the
browser globals a project commonly touches: `window` and its sizes (the composition's), `matchMedia`, `new Image()` for
project files, `fetch` of project files (remote URLs fail saying Kinetograph renders offline), `document` queries over
the host tree, `getComputedStyle`, `ResizeObserver`, `IntersectionObserver` and `MutationObserver`, and `<canvas>`, `OffscreenCanvas`,
`Path2D` and `ImageData` (§6.5). Remote files the engine reads (an `img`/`video` `src`, CSS `url(https://…)`, an SVG
`image`, `<Img>`, `<Image>`, `<Video>`) and a remote `new FontFace(…, 'url(https://…)')` or `@font-face` are downloaded once into
`~/.cache/kinetograph/assets` (fonts: `~/.cache/kinetograph/fonts`) and read from there, so a render after the first is
offline; a download that fails is a note in `doctor` and `lint`. `fetch()` and `new Image().src` of a remote URL stay
refused. The tree is mutable from a script (`appendChild`, `prepend`, `insertBefore`, `replaceChildren`, `textContent`,
`innerHTML`, `cloneNode`, `document.createElement`, `document.head` (a `<style>` there is a stylesheet) and `document.body` (the
top level of the root), `MutationObserver`, `document.createRange()` with `getBoundingClientRect()`, `getNumberOfChars()` and
`getStartPositionOfChar()` on SVG text), on the reconciler's own host tree, so React's insertions and a library's nodes share a parent
as in a browser. Refs to DOM elements answer `getBoundingClientRect`, `offsetWidth`, … from the CSS
engine (ENGINE.md §10.3).

### 7.5 Remotion packages (subpath exports)

| Subpath | Remotion package | Notes |
|---|---|---|
| `@kinetographdev/core/transitions` (+ `/transitions/fade`, `/slide`, `/wipe`, `/flip`, `/clock-wipe`, `/iris`, `/none`, and the shader ones: `/blur-slide`, `/book-flip`, `/cross-zoom`, `/crosswarp`, `/dissolve`, `/dreamy-zoom`, `/film-burn`, `/linear-blur`, `/push-cut`, `/ripple`, `/swap`, `/zoom-blur`, `/zoom-in-out`) | `@remotion/transitions` | `TransitionSeries`, `linearTiming`, `springTiming`, `useTransitionProgress`, `makeHtmlInCanvasPresentation`; presentations render `<Layer>`s with opacity, transforms and clips; a shader presentation is a recorded WebGL shader over the two scenes, run as a shader group (SCENE.md, "Shader groups"; `effects` of a shader presentation are ignored) |
| `@kinetographdev/core/light-leaks`, `/starburst` | `@remotion/light-leaks`, `@remotion/starburst` | `<LightLeak>`, `<Starburst>` (a recorded WebGL draw; of `style` only `opacity` and `mixBlendMode` apply) and the `lightLeak()` and `starburst()` effects (native `shader` effects, for `<Layer effects>`) |
| `@kinetographdev/core/motion-blur` | `@remotion/motion-blur` | `Trail`; `CameraMotionBlur` is `<Layer motionBlur={{ samples, shutter: shutterAngle / 360 }}>` |
| `@kinetographdev/core/noise` | `@remotion/noise` | `noise2D/3D/4D(seed, …)` |
| `@kinetographdev/core/paths` | `@remotion/paths` | pure path maths: `parsePath`, `serializeInstructions`, `reduceInstructions`, `normalizePath`, `getLength`, `getBoundingBox`, `scalePath`, `interpolatePath`, `interpolatePaths(input, inputRange, paths, { easing, posterize, extrapolateLeft, extrapolateRight })`, `warpPath(path, transformer, { interpolationThreshold })`, …; the blends and the warp match the published package digit for digit (arcs aside) |
| `@kinetographdev/core/shapes` | `@remotion/shapes` | `make*` functions (`makeRect`, `makeCircle`, `makeEllipse`, `makeTriangle`, `makeStar`, `makePolygon`, `makePie`, `makeHeart`, `makeArrow`, `makeCallout`, `makeSpark`) and the `Instruction` type; components render `<Path>`. `makeArrow`, `makeCallout` and `makeSpark` match the published package's paths exactly |
| `@kinetographdev/core/layout-utils` | `@remotion/layout-utils` | `measureText`, `fitText`, `fillTextBox`, `fitTextOnNLines` through `layoutText` (§3), fonts from `getFonts()`; the box filling and the size search follow the published package step by step and give its results on a recorded set of texts |
| `@kinetographdev/core/animation-utils` | `@remotion/animation-utils` | `interpolateStyles`, `makeTransform` |
| `@kinetographdev/core/captions` | `@remotion/captions` | `parseSrt`, `serializeSrt`, `createTikTokStyleCaptions` |
| `@kinetographdev/core/google-fonts` | `@remotion/google-fonts/*` | §7.2 |
| `@kinetographdev/core/fonts` | `@remotion/fonts` | §7.2 |
| `@kinetographdev/core/lottie` | `@remotion/lottie` | re-exports `<Lottie>`; `getLottieMetadata(animationData)` (`{ fps, durationInSeconds, durationInFrames, width, height }` or null, as the published package) |
| `@kinetographdev/core/media` | `@remotion/media` | `Audio` and `Video` (also as `experimental_Audio` and `experimental_Video`), `getTargetSampleRate()` (48000) |
| `@kinetographdev/core/sfx` | `@remotion/sfx` | the 32 sound-effect URLs of the package (`whip`, `ding`, …), for `<Audio src>`. The mix downloads each once into `~/.cache/kinetograph/sfx` (`resolveSoundSource`, `@kinetographdev/core/sound-source`), so a render after the first is offline; the CLI's `render` and `audio analyze` pass it to `renderAudio` as `resolveSource`, and `lint` does not look for these URLs on disk |
| `@kinetographdev/core/zod-types` | `@remotion/zod-types` | `zColor`, `zMatrix`, `zTextarea` and `ZodZypesInternals`: zod schemas with Remotion's brands in their descriptions, accepting and refusing what the published ones do (a colour is any string Remotion's colour parser reads, `lab()`, `oklch()` and `hwb()` included). `zod` 4 is an optional peer dependency of the core. `<Composition schema>` is accepted and not validated |
| `@kinetographdev/core/timeline-utils` (+ `/timeline-utils/audio-waveform-worker`) | `@remotion/timeline-utils` | the Studio timeline's helpers, 33 exports. Pure ones (`getLoopDisplaySegments`, `sliceWaveformPeaks`, `calculateTimestampSlots`, …), `drawBars` into a canvas, `loadWaveformPeaks` and `subscribeToWaveformPeaks` (a path, decoded by the addon at 48 kHz, no worker) and the frame cache work, each against values recorded from the published package. `extractFrames`, `resizeVideoFrame` with a scale other than 1, and `renderFrameStripToCanvas` for frames not in the cache throw `UnsupportedApiError` (`@kinetographdev/core`'s `unsupported.ts`): the addon decodes video inside the renderer and has no call that returns a picture |
| `@kinetographdev/core/media-parser` (+ `/media-parser/node`, `/web`, `/universal`, `/node-writer`, `/worker`, `/server-worker`, `/worker-web-entry`, `/worker-server-entry`) | `@remotion/media-parser` | `parseMedia` and `downloadAndParseMedia` for a **local file** (a path, a `file:` URL; a URL to the network is the "renders offline" error), `mediaParserController`, the errors (`IsAnImageError`, `IsAPdfError`, `IsAnUnsupportedFileTypeError`, `MediaParserAbortError`), readers and `nodeWriter`. FFmpeg reads the container through the addon's `probeStreams` and `scanStreams` (`crates/node/src/streams.rs`), so every field of the published parser is answered, checked against it on MP4, WebM, transport-stream, MP3, AAC, FLAC and WAV files (test/media-parser.test.ts). Known differences: MP4's `trackMediaTimeOffsetInTrackTimescale` is 0; the `slow*` bitrates and durations are within a few percent; raw AAC gets a correct `AudioSpecificConfig`; metadata keys follow FFmpeg's names except for Matroska (lower case), MP3 (ID3 frame ids) and WAV (RIFF chunk ids). Throws `UnsupportedApiError`: `slowStructure` (the box tree), `onAudioTrack` / `onVideoTrack` (encoded samples), a `Blob` source, M3U8 playlists, `simulateSeek`; `seek()` and `seekingHints` change nothing. `MediaParserInternals` has `Log`, `createAacCodecPrivate`, `internalParseMedia` and `fieldsNeedSamplesMap` only |
| `@kinetographdev/core/webcodecs` (+ `/webcodecs/buffer`, `/web-fs`, `/worker`) | `@remotion/webcodecs` | works: the container and codec lists, `canCopy*`/`canReencode*`, the default track handlers, `getPartialAudioData`, `convertMedia` of a local file's sound to `container: 'wav'` (decoded by the addon's FFmpeg), `bufferWriter`, `webcodecsController`. Throws `UnsupportedApiError`: every other `convertMedia` output (the addon has no video or audio encoder to hand frames to), `onVideoFrame`/`onAudioData` (WebCodecs objects), `createVideoDecoder`/`createAudioDecoder`/`createVideoEncoder`/`createAudioEncoder`, `convertAudioData`, `extractFrames`, `extractFramesOnWebWorker`, `webFsWriter` |
| `@kinetographdev/core/canvas` | `@remotion/canvas` | the Studio editor's canvas (an overlay of `@remotion/player` with pointer selection, hover and keyframe dragging), not a drawing API. Every name is exported and throws `UnsupportedApiError` when called or rendered, so a project that imports it bundles; for drawing, see §6.5. The published package is at 4.0.532 |
| `@kinetographdev/core/rive` | `@remotion/rive` | `RemotionRiveCanvas`, §7.6 |
| `@kinetographdev/core/skia` (+ `/skia/enable`) | `@remotion/skia`, `@shopify/react-native-skia` | `SkiaCanvas`, `Canvas` and RN-Skia's components on real Skia in the optional `@kinetographdev/skia` addon, §7.7 |
| `@kinetographdev/core/determinism`, `/determinism/install` | none | §7.4 |

`@kinetographdev/core` also re-exports every element of §6.3 and every helper and type of §5, so a project imports from
one place.

### 7.6 `@remotion/rive`

`import { RemotionRiveCanvas } from '@remotion/rive'` (also `@kinetographdev/core/rive`). Remotion plays a `.riv` file with
Rive's WebAssembly runtime in a `<canvas>`; Kinetograph plays it with Rive's own C++ runtime, built into the addon from
`rive-rs` (`vendor/rive`, licences in `vendor/README.md`), and the component hands the runtime's draw calls to the
`<canvas>`'s 2D context as commands, so the element is laid out and styled like the DOM element it is in Remotion and is
drawn natively with Skia.

| Prop | |
|---|---|
| `src` | a `.riv` path or `staticFile(...)`; a URL is an error (a frame must not depend on the network) |
| `artboard`, `animation` | by name or position; the default artboard and its first animation (else its default state machine) when left out |
| `stateMachine` | not in Remotion's props: plays a state machine instead, from its start, stepped at 1/60 s |
| `stateMachineInputs` | not in Remotion's props: the machine's inputs, `{ name: true \| false \| number \| 'fire' }` from the start, or `(frame) => ({ ... })` for each frame; a change is set at its frame's time as the machine is replayed, a trigger fires on each frame whose value is `true` or `'fire'`; an unknown name or a value of the wrong type is an error naming the input |
| `fit`, `alignment` | as Remotion's: `contain`, `cover`, `fill`, `fit-width`, `fit-height`, `none`, `scale-down`; nine alignments |
| `from`, `durationInFrames`, `name` | as `<Sequence>`'s |
| `className`, `style` | on the `<canvas>`, which is as large as the composition |
| `ref` | `getCanvas()` is the `<canvas>` element, `getArtboard()` the artboard played (`name`, `width`, `height`, `bounds`, its animations and state machines by index or name), `getAnimationInstance()` the animation (or state machine) and its `time` at the frame; `getRenderer()` is `null` (the drawing is the canvas's commands) |
| `onLoad` | called with the file (`artboardCount()`, `artboardByIndex`, `artboardByName`, `defaultArtboard()`, the same objects as `getArtboard`) when the canvas renders |
| `assetLoader` | `(asset, bytes) => boolean`, called once per file for each asset (`name`, `uniqueFilename`, `fileExtension`, `cdnUuid`, `isImage`, `isFont`, `isAudio`; `bytes` is empty): `asset.decode(bytes)`, or `asset.setRenderImage(await decodeImage(bytes))` / `setFont(await decodeFont(bytes))` (both exported), uses those bytes; a promise is waited for (`delayRender`) |
| `effects`, `effectsOutputSize` | run over the canvas as for `<AnimatedImage>` (§7.5) |
| `enableRiveAssetCdn` | accepted; an asset on Rive's CDN is not fetched |

A frame is played from the file's start to `frame / fps`, never from what was played before, so a frame is a pure function
of the file, the inputs given for each frame up to it and the frame number. Pictures embedded in a file are decoded and
written as PNGs under `~/.cache/kinetograph/rive` for the commands to name; fonts embedded in the file are shaped by the
runtime. An asset outside the file (a referenced picture or font) is what `assetLoader` gave for it, else the file of its
name beside the `.riv` (`name-id.ext`, as the Rive editor exports referenced assets, or the asset's own name); one found
in neither (an asset on Rive's CDN) is reported (a warning; `--strict` fails) and what uses it is drawn without it.
`riveInfo` in the addon describes a file. The test files under `crates/rive/tests/assets` are from
`rive-app/rive-runtime` (MIT).

### 7.7 `@remotion/skia` and `@shopify/react-native-skia`

Real Skia (`skia-safe`, Skia's CPU rasteriser) in an **optional** addon, `@kinetographdev/skia` (`crates/skia/node`). It
is its own Cargo workspace (`crates/skia`), not a member of the root one, so `cargo build`, `cargo test` and
`cargo clippy` at the root and the default `npm run build`/`npm test` never compile or link Skia. The npm package has no
`build` or `test` script for the same reason; build and test it with

```
npm run build:addon:release -w crates/skia/node     # downloads skia-safe's prebuilt Skia binary on the first build
npm run test:addon -w crates/skia/node
cargo test --manifest-path crates/skia/Cargo.toml    # the pixel tests of the primitives, filters, SkSL and text
```

The CLI maps `@remotion/skia`, `@remotion/skia/enable` and `@shopify/react-native-skia` to `@kinetographdev/core/skia`.
The addon is loaded the first time a frame draws a canvas, so a project that never imports Skia does not need it. If it
is not installed, the first Skia canvas fails with `npm install @kinetographdev/skia`.

How a frame is drawn:

1. `<Canvas>` (or `<SkiaCanvas width height>`) renders its children with a react-reconciler host of its own
   (`skia/host.ts`) into a tree of `{ type, props, children }` nodes, fresh each frame. The timeline context is passed
   in, so `useCurrentFrame()` works inside, as do hooks, context and user components. Colours become floats, `transform`
   becomes a list, Skia objects serialise themselves (`SkPath`, `SkPaint`, `SkImage`, `SkFont`, `SkRuntimeEffect`).
2. The addon's `renderSkia` draws the tree on Skia's raster backend with the rules of RN-Skia's own renderer (a node
   with paint props or declaration children pushes a copy of the paint it inherits; shaders, colour filters, image
   filters, mask filters and path effects collect from the children; `<Paint>` children repeat the drawing). It writes
   the picture as a PNG named by the hash of its pixels under `~/.cache/kinetograph/skia` (at most 600 files are kept,
   the oldest removed first) and the component renders an `<img>` of it, so the canvas lays out and composites like any
   image. A frame is a pure function of the tree and the files it names; the raster backend gives the same pixels on any
   machine, with no GPU.

Supported (RN-Skia's names): `Canvas`, `Group` (`transform`, `origin`, `matrix`, `clip`, `invertClip`, `layer`, `opacity`,
`blendMode`, paint props), `Fill`, `Rect`, `RoundedRect`, `Circle`, `Oval`, `Line`, `Points`, `DiffRect`, `Path` (`start`,
`end`, `stroke`, `fillType`), `Box`/`BoxShadow`, `Vertices`, `Image` (`fit`, `sampling`), `Text`, `TextPath`, `Paragraph`,
`Atlas`, `Patch`, `Glyphs`, `TextBlob`, `Picture`, `ImageSVG`, `Mask`, `BackdropFilter`/`BackdropBlur`, `Paint`;
shaders `Shader` (SkSL, run by Skia), `ImageShader`, `ColorShader`, the
four gradients, `Turbulence`, `FractalNoise`, `Blend`; image filters `Blur`, `Shadow`, `Offset`, `Morphology`,
`DisplacementMap`, `RuntimeShader`; colour filters `ColorMatrix`, `BlendColor`, `Lerp`, `LumaColorFilter` and the two gamma
ones; `BlurMask`; path effects `DashPathEffect`, `CornerPathEffect`, `DiscretePathEffect`, `SumPathEffect`, and the 1D and
2D ones. `Skia.Path.Make()` builds a path (`moveTo`, `lineTo`, `quadTo`, `cubicTo`, relative forms, `arcToOval`,
`arcToRotated`, `addRect`, `addCircle`, `addOval`, `addRRect`, `addArc`, `addPath`, `close`), and Skia answers `op`,
`simplify`, `trim`, `dash`, `stroke`, `transform`, `getBounds`, `contains`; `Skia.Color`, `Skia.XYWHRect`,
`Skia.RRectXY`, `Skia.Matrix`, `Skia.Paint`, `Skia.RuntimeEffect.Make` (null and Skia's message logged on a compile
error), `Skia.ParagraphBuilder.Make`, `Skia.TextBlob.MakeFromText`/`MakeFromGlyphs`/`MakeFromRSXform`/`MakeFromRSXformGlyphs`,
`Skia.RSXform`/`RSXformFromRadians`, `Skia.PictureRecorder` and `createPicture` (the canvas it records takes the `SkCanvas`
calls for shapes, paths, images, text, blobs, glyphs, atlases, patches, clips and transforms), `Skia.SVG.MakeFromString`
(null if it does not parse); hooks `useImage`, `useFont`, `useSVG`, `matchFont`, `useCanvasRef`; the enums as strings.

Fonts are files, as everywhere: `matchFont` and `Paragraph` find only fonts registered with `loadFont()`/`registerFont()`
(no system fonts, so text is the same on every machine); `useFont(staticFile('a.ttf'), size)` reads a file. Pictures are
read from the project or its `public` directory. Everything a render reads is read when the frame is drawn.

Also drawn, each frame-pure:

- **Reanimated values.** `react-native-reanimated` maps to `@kinetographdev/core/skia/reanimated`: `useSharedValue`,
  `useDerivedValue` (worked out each time it is read), `makeMutable`, `isSharedValue`, `useAnimatedReaction`,
  `useFrameCallback` (called once for the frame, with its time), `runOnJS`/`runOnUI`, `interpolate`, `Extrapolation`,
  `interpolateColor`, `Easing`. A shared value is a prop's value when the frame is drawn, after the effects ran. Every frame
  renders the tree afresh, so a value lives for one frame: drive it from `useCurrentFrame()`. `withTiming`, `withSpring`,
  `withDecay`, `withRepeat`, `withDelay` and `withSequence` run on the wall clock: the value jumps to its end and it is
  reported. RN-Skia's `useClock` (the frame's time in ms), `usePathInterpolation`, `useVectorInterpolation`,
  `usePathValue`, `useRectBuffer` and `useRSXformBuffer` work on them.
- **`FitBox`**, `fitbox(fit, src, dst, rotation?)`, `rect2rect`, `fitRects`.
- **Offscreen drawing.** `Skia.Surface.Make(w, h)` and `MakeOffscreen(w, h)` give a canvas whose
  `makeImageSnapshot(bounds?)` is an `SkImage`; `drawAsImage(element, size)` and `drawAsPicture(element, bounds?)` draw
  Skia components into one. The addon rasterises them on the CPU when they are drawn, so they are the same on every
  machine (RN-Skia's offscreen surface is a GPU one).
- **Data and pictures.** `Skia.Data.fromBytes`, `fromBase64` and `fromURI` (a project file or a `data:` URI; a URL is an
  error), `Skia.Image.MakeImageFromEncoded(data)` (null if it is not a picture), `Skia.Image.MakeImage(info, data,
  bytesPerRow)` (`ColorType` `RGBA_8888`, `BGRA_8888`, `Alpha_8`, `Gray_8`, `RGBA_F16`, `RGBA_F32`; `AlphaType`), and on
  an `SkImage` `readPixels`, `encodeToBytes`/`encodeToBase64` (PNG), `makeShaderOptions`, `makeShaderCubic`. Bytes go
  to the addon once (`putData`) and a tree names them by their content.
- **Typefaces.** `Skia.Typeface.MakeFreeTypeFaceFromData(data)`, `Skia.Font(typeface, size)`, `Skia.FontMgr.System()`
  (`countFamilies`, `getFamilyName`, `matchFamilyStyle`: the registered fonts), `Skia.TypefaceFontProvider.Make()`
  (`registerFont(typeface, family)`, for `Skia.ParagraphBuilder.Make(style, provider)`), `useTypeface`, `useFonts`.
  `Skia.Font()` without a typeface uses the first registered font (or the built-in fallback) and is reported.
- **Animated pictures.** `useAnimatedImageValue(source, paused?)` is the GIF or WebP frame for the time of the frame
  being rendered, looping by the file's frame durations (the first frame while `paused`); `useAnimatedImage` and
  `Skia.AnimatedImage.MakeAnimatedImageFromEncoded` give an `SkAnimatedImage` (`getFrameCount`, `decodeNextFrame`,
  `currentFrameDuration`, `getCurrentFrame`). Frames are decoded once.
- **Paragraph measurement.** After `paragraph.layout(width)`: `getHeight`, `getMaxWidth`, `getLongestLine`,
  `getMinIntrinsicWidth`, `getMaxIntrinsicWidth`, the baselines, `didExceedMaxLines`, `getLineMetrics`,
  `getRectsForRange`, `getGlyphPositionAtCoordinate`, measured by Skia's text layout with the paragraph's fonts;
  `paragraph.paint(canvas, x, y)` on a recording canvas.
- **Paints with shaders and filters.** `Skia.Shader.*` (the gradients, `MakeTurbulence`, `MakeFractalNoise`,
  `MakeBlend`, `MakeColor`), `effect.makeShader(uniforms)` and `makeShaderWithChildren`, `Skia.ColorFilter.*`,
  `Skia.ImageFilter.*` (`MakeBlur`, `MakeOffset`, `MakeDropShadow(Only)`, `MakeErode`, `MakeDilate`, `MakeColorFilter`,
  `MakeShader`, `MakeCompose`, `MakeBlend`, `MakeDisplacementMap` of a `MakeShader`, `MakeRuntimeShader`),
  `Skia.MaskFilter.MakeBlur` and `Skia.PathEffect.*` set on a `Skia.Paint()` draw as the matching JSX children do. A drop
  shadow blurs by its x sigma.
- **Text in an SVG.** `ImageSVG` draws `<text>` with the registered fonts: for each `font-family` the SVG names, the
  first family of its list that is registered, else the built-in fallback font (a generic family such as `sans-serif`
  goes to the fallback silently; a named family that is not registered is reported). Characters the font lacks are not
  drawn.

`Atlas` is `canvas.drawAtlas` (`colorBlendMode` combines a sprite, the source, with its colour, the destination; default
`dstOver`), `Patch` is `drawPatch` (corners clockwise from the top left, `c1` the control point on the edge that arrives
at the corner and `c2` on the one that leaves it), `Glyphs` and `TextBlob` draw glyphs of a registered font, `Picture` is
recorded again by Skia's own recorder and drawn once, whatever paints are declared around it, and `ImageSVG` is Skia's SVG
DOM: an SVG with a size of its own is fitted whole and centred into `width` by `height`, one sized by percentages is laid
out in them. An SVG has no system fonts, so its `<text>` is left out and reported (a warning; `--strict` fails).

- **Video.** `useVideo(source, { paused, looping, seek, playbackSpeed })` gives `currentFrame` (a shared value of the
  picture the file shows at the frame's time, times `playbackSpeed`, from `seek` ms, looping unless `looping: false`;
  `seek` while `paused`), `currentTime` (ms), `duration` (ms), `framerate`, `size` and `rotation`. The picture is decoded
  by the engine's video decoder on the CPU (`readCanvasPicture`, as `onVideoFrame` frames are read). Its sound is not
  played (a `volume` above 0 is reported): add an `<Audio>` of the file.

Not provided (an import of one fails the bundle, naming the export): `makeImageFromView` and
`Skia.Image.MakeImageFromViewTag` (there are no React Native views), `Skia.SVG.MakeFromData`, touch handling, and
Reanimated's `Animated` components.

**Why the CPU.** Drawing `@remotion/skia` through the main renderer's Skia (Graphite on Metal) was measured and not done:
skia-safe 0.153.3 publishes no prebuilt Skia with `graphite`, `metal`, `textlayout` and `svg` together (the main renderer's
build is `graphite-metal-pdf`, the addon's `textlayout-svg-webp`), so it would mean compiling Skia from source on every
platform; GPU rasterising does not give the same pixels as Skia's CPU rasteriser, nor the same pixels on every machine;
and at 1920 x 1080 a busy canvas costs the CPU addon 9.9 ms a frame to draw, read back and hash, plus 8.0 ms to write a new
PNG (0.39 MB).

## 8. `@kinetographdev/audio`

```ts
export type OnFrameCallback = (ctx: OfflineAudioContext, time: number) => void;
/** Registers synthesis to start at `frame` (absolute). Call at module level; the registry is global
 *  (`globalThis[Symbol.for('kinetograph.audio')]`) so the project's copy and the CLI's agree. */
export function onFrame(frame: number, callback: OnFrameCallback): void;
export function clearOnFrame(): void;

export interface AudioClipTimeline extends Omit<AudioClipJson, 'volume'> { volumes: Map<number, number> /* frame → volume */ }
export function joinClips(frames: { frame: number; audio: AudioClipJson[] }[]): AudioClipTimeline[];
export function renderAudio(options: { fps: number; first: number; last: number; sampleRate?: number /* 48000 */;
                                       clips: AudioClipTimeline[]; baseDir?: string;
                                       resolveSource?: (src: string) => string | Promise<string> }): Promise<AudioPcm>;
export interface AudioAnalysis {
  integratedLufs: number; truePeakDb: number; clippedSamples: number;
  silences: { start: number; end: number }[];    // seconds, below -60 dBFS for at least 0.5 s
  scenes?: { from: number; to: number; integratedLufs: number; truePeakDb: number }[];
}
export function analyzeAudio(pcm: AudioPcm, options?: { scenes?: [number, number][] /* seconds */ }): AudioAnalysis;
```

`renderAudio` builds one `OfflineAudioContext` for the range (time 0 = frame `first`), calls each `onFrame` callback in
the range with `time = (frame - first) / fps`, plays each clip (decoded with `decodeAudioData`, or by FFmpeg when that refuses the file, as it does an MP4 whose `moov` atom is at the end) with its trim, rate,
loop and a gain stepped per frame, and returns the mix. Loudness follows ITU-R BS.1770-4 (K-weighting, gating) and
true peak uses 4x oversampling.

## 9. `kinetograph` CLI and MCP

`npx kinetograph <command> <entry> …`; `<entry>` is a project file (`.tsx`, `.ts`, `.jsx`, `.js`) or a `.json` scene.
Every command takes `--json` (one JSON object on stdout; errors as `{ "error": { "code", "message" } }` and exit code
1), `--comp <id>` (default: the first composition) and `--props <json>`.

| Command | Does |
|---|---|
| `compositions <entry>` | lists compositions |
| `still <entry> <frame> -o out.png [--strict] [--dev-react]` | one PNG; unsupported content is drawn without and warned about on stderr, `--strict` fails instead (the Remotion compatibility docs, `/docs/compat/`) |
| `render <entry> -o out.mp4 [--range a..b] [--scale N] [--codec C] [--crf N \| --video-bitrate R] [--concurrency N] [--strict] [--dev-react] …` | video with audio; the export options are below; `--draft` is `--scale 0.5`; `--concurrency N` draws N frames at once (default half the cores, at most 4; below); unsupported content is drawn without and warned about, `--strict` fails on the first frame that has some (the Remotion compatibility docs, `/docs/compat/`); React runs in production mode unless `--dev-react` (below) |
| `strip <entry> -n 12 -o sheet.png [--strict]` | contact sheet of evenly spaced frames, labelled, built as a scene and rendered by the engine |
| `onion <entry> <range> -n 6 -o onion.png` | frames of the range blended over one another |
| `inspect <entry> [--frame N]` | `InspectResult` |
| `lint <entry>` | text overflowing its box or the canvas, layers off the canvas, overlapping text, missing fonts or assets, type errors (`type-error`, no frame), with frame and layer id |
| `check <entry>` | `tsc --noEmit` on the project (the nearest `tsconfig.json`, else the entry alone): `{ ok, checked, tsconfig, errors, diagnostics: [{ file, line, column, code, message }] }`, exit 1 on errors. Rendering never type-checks (esbuild strips types), so this is how an agent sees a misspelled prop that §6.3 would otherwise ignore |
| `bench <entry> [--frame N --runs K \| --range a..b]` | stages: `js` (renderFrame), `stringify`, then the addon's (`handoff`, `resolve`, `raster`, `composite`, `readback`), `total` |
| `audio analyze <entry> [--range]` | `AudioAnalysis` per Sequence-free whole and per `--scenes` (frame ranges `a..b`, as `--range`; each scene is reported in both units: `fromFrame`/`toFrame` and `from`/`to` in seconds) |
| `snapshot <entry> [--frames 0,30,60] [--update]` | compares PNGs in `__snapshots__/` next to the entry, max channel difference 2 |
| `effects` | `effectCatalog` |
| `track <video> [--point x,y ...] [--detect [--detect-threshold T ...]] [--plane all\|p1,p2,p3,p4 [--plane-corners ...]] [--model M] [--pattern N --search N] [--match keyframe\|previous] [--from F --to F] [--backwards] [-o out.json]` | tracks points (placed, or found by Blender's Detect Features) and plane tracks with Blender's tracker and writes `<video>.track.json` for `useTrack()` and `usePlaneTrack()` (§11.12); takes a video, not an entry |
| `doctor [entry] [--range]` | without an entry, the install report (it lists the renderer; `render` and `still` print `renderer: Skia GPU (Metal)`, `Skia CPU (no GPU found)`, `Skia CPU (GPU unusable)` or `Skia CPU (KINETOGRAPH_SKIA_CPU=1)` as progress; when the GPU was unusable, doctor also gives `rendererReason`, with the device, driver and what is missing); with one, how many frames have nothing unsupported, and every unsupported element or property with its frame ranges (the Remotion compatibility docs, `/docs/compat/`) |
| `studio <entry>` | the studio (§11.5) |
| `mcp` | MCP server on stdio |

**React mode.** `render` and `still` run React's production build: they set `NODE_ENV=production` before the project's
bundle first imports React (in the main thread, and in each render worker, which sets it itself before it opens the
bundle). The development build checks prop types and keeps extra bookkeeping, and costs more per frame on a heavy
composition; the frames are identical. `--dev-react` keeps the development build, for the warnings React prints
(a missing `key`, a hook called in the wrong order). The studio and `bench` are not changed and run the development build
unless `NODE_ENV` is set in the environment (`NODE_ENV=production kinetograph bench …` times production mode).

**Export options** (`render`; the names are Remotion's). The flags are checked before the project is bundled, and each
refusal says what to change.

| Flag | Does |
|---|---|
| `--scale N` | Output size multiplier, above 0 and at most 8: `0.5` renders 1080p as 540p, `2` renders it as 4K. The compositor draws at the scaled size (the layers sit in a group scaled by N on a smaller or larger canvas), so nothing is resampled afterwards. Each side is `floor(side x N)` rounded down to an even number, at least 2, because 4:2:0 video needs even sizes: `--scale 0.3` of 64x36 is 18x10. `--draft` is `--scale 0.5` (both together is an error). Not given: `--width` and `--height`, which in Remotion re-lay the composition out at another size and would need the project to be opened at it |
| `--codec h264\|h265\|prores\|vp9\|gif` | Default `h264`, except that a `.webm` path means `vp9` and a `.gif` path means `gif`. The extension must fit the codec: `.mp4` or `.mov` for h264 and h265, `.mov` for prores, `.webm` for vp9, `.gif` for gif |
| `--crf N` or `--video-bitrate R` | Constant quality or a bit rate such as `8M` or `2500k`; giving both is an error. CRF is 0 to 51 for h264 and h265 and 0 to 63 for vp9, lower is better. Not for prores (its quality is the profile) or gif. Without either, the quality is as it always was: libx264 `crf 18`, VP9 `crf 30`, x265 `crf 28`, and 0.2 bits per pixel per frame for the VideoToolbox encoders |
| `--prores-profile` | `proxy`, `light`, `standard`, `hq` (default), `4444`, `4444-xq`. The 4444 profiles are 4:4:4 10-bit; the others 4:2:2 10-bit. The alpha channel is dropped, as for every codec |
| `--pixel-format` | `yuv420p` (default), `yuv422p`, `yuv444p`, `yuv420p10le`, `yuv422p10le`, `yuv444p10le`. ProRes takes the one its profile needs. Players handle 4:2:2, 4:4:4 and 10-bit H.264 and H.265 unevenly; 4:2:0 8-bit plays everywhere |
| `--audio-codec aac\|opus\|pcm` | The container decides: `.mp4` takes `aac`; `.mov` takes `aac` or `pcm` (16-bit; the default for prores); `.webm` takes `opus` (the default there). A GIF has no sound |
| `--audio-bitrate R` | Total audio bit rate, e.g. `320k`; default 96 kbit/s a channel. Not for `pcm` |
| `--every-nth-frame N` | gif only: draws every Nth frame of the range and plays them at the frame rate over N, so the GIF keeps its length with fewer frames. A project only (a `.json` scene is drawn whole) |
| `--encoder NAME` | An ffmpeg encoder for the codec, in place of the choice below. Any encoder the built-in ffmpeg lacks runs in a separate ffmpeg program (`KINETOGRAPH_FFMPEG`, else the platform package's `bin/ffmpeg`, else `ffmpeg` on the `PATH` when it lists libx264 or the VAAPI/QSV encoder asked for). So `KINETOGRAPH_FFMPEG=$(which ffmpeg)` lets you use your system ffmpeg's encoders: `libx264`, and `h264_vaapi`, `hevc_vaapi`, `h264_qsv`, `hevc_qsv` on Intel and AMD GPUs (Linux; 4:2:0 only, HEVC also 10-bit; they must open a test encode, else the error says why). Decoding always uses the built-in ffmpeg |

Encoder choice, when `--encoder` is not given. On macOS, ffmpeg's hardware encoders are used when it has them and they
can do what was asked: `h264_videotoolbox`, `hevc_videotoolbox` (8-bit 4:2:0 only, so another `--pixel-format` selects
the software encoder) and `prores_videotoolbox`. Otherwise, for H.264, the first of `libx264`, `libopenh264`, `h264_mf`,
`h264_nvenc` and `h264_amf` that is available (and, for the last three, that opens on this machine). The ffmpeg linked
into the addon is LGPL-only and has no `libx264` or `libx265`; the platform packages ship a separate GPL `ffmpeg`
program (`bin/ffmpeg`) that has them, and the addon runs it as a child process (raw pictures on a pipe, a video-only
file out; the sound is muxed in by the linked ffmpeg). `KINETOGRAPH_FFMPEG=/path/to/ffmpeg` names another program and
is tried before the bundled one (an encoder is looked up in each program in turn); with neither, an `ffmpeg` on the
`PATH` is used if it lists libx264. Then `libx265`, `prores_ks` and `libvpx-vp9` (linked on macOS and Linux); `gif` has
one. See `/docs/ffmpeg-license/`.

Intel and AMD GPU encoders on Linux: `h264_vaapi`, `hevc_vaapi` (VAAPI, any Intel or AMD GPU with a driver) and
`h264_qsv`, `hevc_qsv` (Intel Quick Sync, oneVPL) run in a system ffmpeg that has them, never in the linked one (it
cannot link libva without failing to load where libva is missing). Name one with `--encoder` and point
`KINETOGRAPH_FFMPEG` at the ffmpeg, e.g. `KINETOGRAPH_FFMPEG=$(which ffmpeg) kinetograph render scene.json -o out.mp4
--encoder h264_vaapi`. They are never the default: the output differs by driver and GPU, and the default must not.
VAAPI uses the first `/dev/dri/renderD*` (`KINETOGRAPH_VAAPI_DEVICE=/dev/dri/renderD129` picks another; for QSV it
names the render node the Quick Sync device is derived from). They take 4:2:0 (`yuv420p`, and `yuv420p10le` for
`hevc_*`) only. `--crf N` becomes VAAPI's constant QP (`-qp`, rounded) and Quick Sync's ICQ (`-global_quality`, at
least 1): the same 0 to 51 scale as libx264's CRF, not the same picture quality. `--video-bitrate R` is `-b:v`;
without either, 0.2 bits per pixel per frame as for the other hardware encoders. Before one is accepted, a four-picture
test encode must open (first as it is, then with `-low_power 1`, which the newest Intel GPUs need for some codecs); if it
does not, the error carries ffmpeg's own words and the usual fix (the driver package, the `render` group, `vainfo`).
The error for any encoder no ffmpeg has says to set `KINETOGRAPH_FFMPEG`. VideoToolbox has no CRF, so `--crf` is mapped to its 0 to 100 quality (`-q:v`): `quality = round(100 x (51 - crf) / 51)`,
at least 1, which makes CRF 18 quality 65, CRF 23 quality 55 and CRF 0 quality 100. That is a straight line through the
ends of the CRF scale, not a measured match; for a quality that is the same on every machine pass `--encoder libx264`.
H.265 in `.mp4` and `.mov` is tagged `hvc1`, which QuickTime and Safari need. GIF frames are reduced to the fixed 3-3-2
colour cube with ordered dithering, one global palette, no per-frame palette search. The summary names the codec, the
encoder and the pixel format it used.

With `--concurrency N` every option applies: each worker draws at the scaled size and converts to the pixel format the
encoder takes (`rgbaToYuv(…, pixelFormat)`), the main thread feeds the one encoder, and `--every-nth-frame` numbers the
frames drawn so the chunks stay contiguous. The file decodes to the same frames as `--concurrency 1` for every codec.

`render --concurrency N` (a project; a `.json` scene is drawn whole by the addon) starts N worker threads. Each opens the
composition itself (the bundle is built once), runs its JS for a chunk of 60 frames at a time, draws them with a renderer
of its own (its own GPU device, layer cache and video decoders) and converts them to `yuv420p`; the main thread puts
the frames in order and feeds the one encoder, and mixes the audio at the end from the clips each frame reported. Rendering
is a pure function of (project, frame), so the file decodes to the same frames and audio as `--concurrency 1`, which
draws every frame in the main thread as before. Chunks are handed out in order and none starts more than (N+1) x 60
frames past the next frame the encoder needs, which bounds the frames held in memory. Frames are not equally dear (a
motion-blur stretch costs several times a plain one), so a worker that has no chunk it may take asks the busy worker
furthest back to stop its chunk early, and draws the rest of it. Each worker is a full renderer, so memory grows with N
(0.5 to 1 GB a worker on the launch film). `<Artifact>` files are collected from the workers; thumbnails are drawn by the
main thread. `KINETOGRAPH_CHUNK`, `KINETOGRAPH_WINDOW` and `KINETOGRAPH_MINSPLIT` (frames) override the chunk size, the
window and the smallest chunk that is split, for tuning and tests.

A frame that is the same as the frame before it (a hold, a still end card) is not drawn: the renderer compares the
frame's resolved scene with the previous frame's, exactly, and when they are equal, and no file it draws from changed
in between, it skips the GPU work, the readback and the colour conversion, and the encoder gets the previous picture
again (README, "Frame reuse"). Anything that moves with time is in the resolved scene (shader time, grain, a video's
picture, a GIF's or Lottie's time, canvas commands, WebGL uniforms, motion blur samples), so such a frame is drawn. With
`--concurrency N` a worker compares a frame only with the one before it in its chunk and always draws a chunk's first
frame, so the output is the same however the chunks were shared out. The summary says how many frames were repeats
(`repeated`); `KINETOGRAPH_NO_REUSE=1` draws every frame.

Bundling: esbuild bundles the entry with a synthetic entry that imports `@kinetographdev/core/determinism/install` first,
then the project, and re-exports `@kinetographdev/core`, so the CLI drives frames through the same core and React instance the
project uses. Aliases: `remotion` → `@kinetographdev/core`, `@remotion/<pkg>[/sub]` → `@kinetographdev/core/<pkg>[/sub]`,
`@remotion/google-fonts/<Family>` → a virtual module calling `makeGoogleFont`. `@kinetographdev/native` stays external.
The bundle is written under `node_modules/.cache/kinetograph/`. An `import tex from './tex.jpg'` of a `.png`, `.jpg`,
`.jpeg`, `.webp`, `.gif`, `.avif` or `.svg` file is the file's absolute path (resolved where the importing file looks
for it, in a project or a plugin), which `<Img>` and `new Image().src` (so a canvas's `drawImage`) load; a `new URL('./tex.jpg', import.meta.url)` points into the cache, where the file is not. A `url()` in
a stylesheet is read by the CSS plugin as before.

The MCP server (`@modelcontextprotocol/sdk`, stdio) exposes one tool per command with the same arguments; each call
runs the CLI as a child process with `--json`, so the server process never installs the determinism shim. `still`,
`strip` and `onion` also return the PNG as image content. An agent skill (`packages/cli/skills/kinetograph/SKILL.md`) explains the
loop: write TSX, `still`/`strip`, `inspect`/`lint`, fix, `render`.

## 10. Testing

- Without a GPU: `cargo build`, `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test --lib`, `npm ci`, `npm run build`, `npm test`. Never the integration tests in `crates/core/tests/`,
  `still`, `render` or `bench`, nothing that opens a GPU, never `UPDATE_GOLDEN`.
- GPU tests in TS are skipped unless `KINETOGRAPH_GPU_TESTS=1`.
- Rust scene additions get test scenes in `crates/core/tests/scenes/` and golden entries; the goldens are made on an
  Apple M4.
- Values that must match Remotion (`random` bit-exact; `interpolate`, `spring`, `Easing`, `interpolateColors`,
  `noise*`) are tested against fixtures recorded from the published `remotion` packages, run as black boxes in a
  scratch directory outside the repo (never added as dependencies, never read). The fixture file says how it was
  recorded.
- `@kinetographdev/react` has snapshot tests of the emitted JSON; `@kinetographdev/core` renders small compositions to
  `FrameResult`s and checks them; the CLI's GPU-free paths (bundling, `compositions`, `inspect`, `lint`, `effects`,
  argument parsing) are tested without a GPU.

## 11. Video layers and the studio

| Path | What |
|---|---|
| `crates/core` (`video.rs`, `gif.rs`, scene, resolve, render, inspect), `crates/core/tests/` | the `video` and `gif` layers of SCENE.md; `ffmpeg-next` 9 becomes a dependency of `kinetograph-core`, and `image` gets its `gif` feature |
| `crates/node/src/media.rs` | `probeMedia`, `decodeAudio` (§11.2) |
| `packages/react` (`<Video>`, `<OffthreadVideo>`, `<Gif>`), `packages/core` (`/gif`, `/media-utils`), `packages/audio` (video sound) | §11.3 |
| `crates/node/src/preview.rs`, `packages/studio/src/` but `protocol.ts`, the CLI's `studio` command, `kg-sequence` in `packages/react` and its use in `packages/core` | §11.2 `preview`, §11.4, §11.5 |
| `packages/studio/ui` | §11.6 |

### 11.1 Scene: `video` and `gif` layers

As SCENE.md's [video](SCENE.md#video) and [gif](SCENE.md#gif) sections, typed as `VideoLayer` and `GifLayer` in
`@kinetographdev/scene`. `InspectLayer.type` gains `'video' | 'gif'`; both have `src`, and `media: { time: number }`,
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
/** What the container of any file FFmpeg opens says (`MediaStreams`: format, duration, start, tags, and per stream the
 *  codec, ids, time base, size, rotation, colour, rate and channels, the codec's private data, a cover picture), nothing
 *  decoded; files with no video stream are fine. `IO` for a missing file, `INVALID_ARG` for one FFmpeg cannot open. For
 *  `@remotion/media-parser` (§7.5). */
export function probeStreams(path: string, baseDir?: string): MediaStreams;
/** Every packet of a file, not decoded, totalled per stream (`StreamScan`: count, bytes, first dts, first and last time,
 *  the keyframes with position and size). For the "slow" fields of `parseMedia`. */
export function scanStreams(path: string, baseDir?: string): StreamScan[];
/** The first audio stream of any file FFmpeg reads, decoded and resampled (swresample) to `sampleRate`, keeping its
 *  channel count (mono or stereo; more channels are downmixed to stereo). null when the file has no audio stream. */
export function decodeAudio(path: string, sampleRate: number, baseDir?: string): AudioPcm | null;
/** What a glTF or GLB model uses that the 3D layer does not read (SCENE.md, "scene3d", "glTF"), one entry for each
 *  kind of thing; empty for a file that uses nothing of the kind. `IO`/render error for a file that cannot be read. */
export function modelUnsupported(src: string, baseDir?: string): { feature: string; reason: string }[];
/** Tracks points through a video with Blender's tracker and returns the `.track.json` text (§11.12): Detect Features
 *  first with `detect`, plane tracks after with `planes`. Every field but `points` defaults to Blender's. `IO` for a missing file, `INVALID_ARG` for anything else wrong.
 *  CPU only; `kinetograph track` calls it, a render never does. */
export function track(path: string, request: {
  points: { name?: string; x: number; y: number }[];   // may be empty with `detect`
  detect?: { margin?: number; threshold?: number; minDistance?: number; inside?: number[][]; outside?: number[][] };
  planes?: { name?: string; tracks?: string[]; corners?: number[] }[];   // corners: 8 numbers, x,y TL TR BR BL
  model?: string; pattern?: number; search?: number; minCorrelation?: number; margin?: number;
  normalize?: boolean; brute?: boolean; match?: string; from?: number; to?: number; backwards?: boolean;
}, baseDir?: string): string;

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

### 11.3 `<Video>`, `<OffthreadVideo>`, `<Gif>`

Written from Remotion's documented props. Exported from `@kinetographdev/react` and re-exported by `@kinetographdev/core`
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
| `datamosh` | `datamosh` (a Kinetograph prop, §11.8) |
| `onVideoFrame(frame)` (Remotion 4.0.190+; `<Video>`, `<OffthreadVideo>`, `<Html5Video>`) | called once for each composition frame the video is shown in (not before `from`), after the frame's effects have run so a canvas ref is set, with a `VideoFramePicture` (`width`, `height`, `displayWidth`, `videoWidth`, `timestamp` in microseconds, `close()`): the frame the layer shows there, chosen by the layer's own clock (`trimBefore`, `playbackRate`, `loop`, `<Sequence>`, `<Freeze>`). It is a `CanvasImageSource` for `drawImage` (all forms), `createPattern`, WebGL's `texImage2D` and WebGPU's `copyExternalImageToTexture`; `getImageData` of the canvas it was drawn on returns its pixels (alpha included: a ProRes 4444 matte keeps its alpha). Nothing is decoded until a canvas draws or reads it |
| `transparent`, `toneMapped`, `pauseWhenBuffering`, `acceptableTimeShiftInSeconds`, `onError`, `showInTimeline`, `name`, `delayRenderTimeoutInMilliseconds` | accepted and ignored |

`AudioClipJson` gains `video?: boolean`. `renderAudio` (§8) decodes a clip with `video: true` through
`decodeAudio(src, sampleRate)` instead of `decodeAudioData`; a file without sound plays silence. Volume, mute,
trims, rate, loop and `<Freeze>` work as for `<Audio>`.

`@kinetographdev/core/gif` is `@remotion/gif`: `Gif` (`src`, `width`, `height`, `fit` (default `fill`), `style`,
`playbackRate` (default 1), `loopBehavior`: `loop` (default), `pause-after-finish`, `unmount-after-finish`; `onLoad`,
`onError` accepted) emits a `gif` layer with `time = frame / fps * playbackRate` (the native element also takes a
`time`, which `<AnimatedImage>` sets) and `loop = loopBehavior === 'loop'`, and renders nothing past the GIF's duration
with `unmount-after-finish`. `getGifDurationInSeconds(src): Promise<number>`. `preloadGif(src)` probes the file now and
returns `{ waitUntilDone, free }`: `waitUntilDone()` resolves, or rejects with what is wrong with the file, and `free()`
does nothing. `@kinetographdev/core/media-utils` is `@remotion/media-utils`' `getVideoMetadata(src): Promise<{
durationInSeconds, width, height, aspectRatio, isRemote: false, fps }>`. Both read `probeMedia`, which the host passes
in as it does `layoutText`: `setMediaProbe(native.probeMedia)` from `@kinetographdev/core/media-utils`, which the CLI's
synthetic entry re-exports next to `setLayoutText`.

### 11.4 Timeline data

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

### 11.5 The studio server

`kinetograph studio <entry> [--port 3000] [--host 127.0.0.1] [--no-open] [--props <json>]` (the CLI command loads
`@kinetographdev/studio` with a dynamic import) calls `startStudio({ entry, port, host, open, props })` from
`@kinetographdev/studio`, which resolves to `{ url, close() }`. A taken port is an `INVALID_ARG` error.

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
- **Thumbnails.** `/api/thumbnail` draws a small JPEG of a frame for the timeline's clips through the preview worker,
  one at a time and only once no preview frame has been asked for in 250 ms, so playback and scrubbing never wait for
  one. Thumbnails are kept (400, by the build they were drawn from, composition, frame, props and size). The answer's
  `X-Build` is the build drawn; when it is the `build` the address names, the answer is `immutable`, else `no-store`
  (the project was rebuilt while it waited).
- **Chat.** The server keeps the conversation with the coding agent (the user's messages, what the agent sent, the
  permissions answered). When the window that began it closes, the agent waits 30 s (`agentReclaimMs`) for it to come
  back: the next window to connect takes it over and is sent `agent.history`, which the chat replays. Starting over,
  choosing another agent, or a window that does not come back drops it. At most 5,000 records and 4 MB are kept
  (streamed text is one record per paragraph); past that whole turns go from the start, so a replay begins at one of
  the user's messages.
- **Names and source.** The studio bundles a project with esbuild's dev JSX transform, so each Sequence and layer
  (`/api/timeline`, `/api/inspect`) can carry optional `label` (a person's name for it: the Sequence `name`, the
  element `id`, `Component · “text…”`, the tag and class, or its kind), `component` (the nearest user component) and
  `source` (`{ file, line, column }` of the JSX, relative to the directory the studio started in). The path id stays
  the layer's `id`. A render's bundle has none of this and draws the same pixels.
- The UI's built files (`packages/studio/ui/dist`) are served at `/`, with `index.html` for unknown non-API paths.

The routes and messages are typed in `packages/studio/src/protocol.ts`; that file is the contract:

| Route | Answer |
|---|---|
| `GET /api/project` | `ProjectInfo` |
| `GET /api/compositions` | `CompositionInfo[]` (§7.2) |
| `GET /api/frame?comp&frame&scale&format&props` | the image (`Content-Type` its mime, headers `X-Build`, `X-Frame`) |
| `GET /api/inspect?comp&frame&props` | `InspectResult` (§3) |
| `GET /api/timeline?comp&props` | `TimelineData` |
| `GET /api/thumbnail?comp&frame&height&build&props` | a JPEG `height` px tall (8 to 120), drawn when the preview is idle |
| `GET /api/renders` | `RenderJob[]`, oldest first |
| `POST /api/renders` (`RenderRequest`) | `RenderJob`, status 201 |
| `DELETE /api/renders/:id` | `RenderJob` (cancelled; a finished job is left as it is) |
| `WS /ws` | `ServerMessage`s out, `ClientMessage`s in |

`props` is URL-encoded JSON merged over the composition's `defaultProps` (as `--props`). Errors are a JSON
`{ error: StudioError }` with status 400 (`INVALID_ARG`), 404 (`NOT_FOUND`: route, composition or job), 409
(`BUILD`: no good build yet) or 500 (anything else, with the addon's or CLI's code).

### 11.6 The studio UI

`packages/studio/ui` (`@kinetographdev/studio-ui`, private): React 19 + Vite, Tailwind CSS v4 utilities only (no
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
  a ruler in frames; clicking a row selects that layer in the scene tree. A clip at least 64 px wide shows a picture of
  its first frame (`/api/thumbnail`, loaded lazily). Siblings that share a name are numbered ("Card", "Card 2", "Card 3")
  in the timeline, the scene tree, the preview and the chat's context.
- Scene tree: the `InspectResult` of the current frame; selecting a layer shows its resolved fields.
- Props panel: a form for the composition's `defaultProps` (strings, numbers, booleans, colours as text; nested
  objects as JSON); an edit re-renders the preview with the new `props`; reset restores the defaults.
- Render queue: start a render of the current composition (range, output, props), the job list with progress, ETA
  from `msPerFrame`, cancel, and the output path when done.
- A `reload` message refetches compositions and re-renders the current frame; `buildError` shows the error over the
  preview until the next good build.
- Built by `vite build` into `ui/dist`. Tests: vitest + Testing Library + jsdom against the mock server.

### 11.7 Audio data (`@remotion/media-utils`)

`@kinetographdev/core/media-utils` also has the audio half of `@remotion/media-utils`, for audio-reactive visuals:

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

### 11.8 Datamosh (`<Video datamosh>`)

A datamosh is the look of a video whose keyframe was dropped: the old picture stays on screen and the new shot's
motion pushes it around, so pixels smear and melt along the movement. It is a prop of `<Video>`, drawn by the engine
(the scene's `datamosh`, SCENE.md "video: datamosh"), not a baked clip:

```tsx
<Video src={staticFile('pig.mp4')} width={1920} height={1080} fit="cover"
  datamosh={{ from: 0, to: 45, hold: { src: staticFile('clouds.mp4'), frame: 90 }, mix: 0.2 }} />
```

```ts
interface DatamoshOptions {
  from: number;                                   // first frame of the window; it shows the held picture
  to: number;                                     // the clip plays again from here; to - from <= 600
  hold?: 'previous' | { src: string; frame: number }; // default 'previous': the clip's own frame from - 1
  mix?: number;                                   // 0 to 1, default 0: share of the new picture's detail added back
}
```

- `from` and `to` are frames of the enclosing Sequence (what `useCurrentFrame()` returns), as `<Video from>` is. The
  component moves them to the composition's timeline.
- `hold: 'previous'` melts the clip against itself. `hold: { src, frame }` is the classic transition: clip B's motion
  moves clip A's pixels (`frame` is a frame of that file at the composition's rate). Put the video of clip B in a
  Sequence that starts when the cut should be.
- `mix` 0 only moves the old picture; 1 adds the full residual of the new shot, so its detail rides on the old colour.
- Needs motion vectors: H.264 and MPEG-4 (the MPEG family). Another codec is drawn plain and reported as
  unsupported (`--strict` fails; core's `<Video>` check reads the file's codec). A `<Video>` with CSS style or `className` (laid out by the DOM engine) cannot take `datamosh`:
  use `width`, `height` and `fit`.
- Deterministic and the same at any `--concurrency`. A render pays one decode and step per frame since `from` the
  first time it enters a window, then one per frame (about 15 ms at 1080p with `mix`, 7 ms without, plus the decode),
  so the window is capped at 600 frames.
- `examples/datamosh/` is a composition with a transition mosh, a self mosh and a `mix` comparison.

### 11.9 GSAP

GSAP (core and the free plugins, `Flip` too) runs on the page's HTML and SVG. Build a paused timeline in a layout
effect and `seek(frame / fps)` it in a second one. A tween that plays by itself (`gsap.to` in a `useEffect`) works
as well: GSAP's root clock is moved with the frame, and a jump to a later frame renders the frames it skips so a
tween an effect makes at frame 30 starts there (about 0.1 ms per skipped frame). Stop such a tween in the effect's
cleanup. Such a tween is warned about once: Remotion's and HyperFrames' own renderers do not move GSAP's root clock
with the frame, so it renders differently there. Motion-blur sub-frames sample it at their own time (`onUpdate` runs,
`onComplete` and the other callbacks do not). `ScrollTrigger` and `Draggable` need scrolling and dragging, which a
render does not have. What works and the gaps are on the site at `/docs/compat/#gsap`.

### 11.10 Animation libraries and their plugins

A library that runs its own clock or randomness must show what the frame number says. Four optional plugins seek the
library to `frame / fps`; the library stays a peer dependency (`npm install @kinetographdev/<name> <library>`). Sources:
`packages/plugins/*/src`; use and checks: `/docs/libraries/`.

| Package | Exports | For |
|---|---|---|
| `@kinetographdev/gsap` | `useGsapTimeline(build)`, `<GsapTimeline build>` | a paused timeline seeked to the frame (§11.9); put every tween on the `tl` it passes; the returned ref scopes string selectors |
| `@kinetographdev/anime` | `useAnimeTimeline(build)`, `<AnimeTimeline build>` | a paused anime.js v4 timeline seeked to `frame / fps * 1000` ms; an `animate()` off the timeline is warned about |
| `@kinetographdev/motion` | `<MotionFrame>`, `useMotionTime()`, `useSpringAt({ to, stiffness, damping, mass, delay })`, `useAnimateAt(() => animate(...))` | Motion: `motion.*` components inside `<MotionFrame>`; `animate()` paused at `frame / fps`; a spring or `MotionValue` that is a pure function of the frame |
| `@kinetographdev/p5-brush` | `<BrushCanvas seed draw origin background width height>` | p5.brush: clears, seeds and draws every frame in `draw(brush, frame, { width })`; `origin="top-left"` moves p5.brush's centre origin; needs the WebGL support |

Libraries that need no plugin, only frame-pure use (details and snippets in `/docs/libraries/`, status in
`/docs/compat/#libraries`): Recharts (`isAnimationActive={false}`, fixed `width`/`height`), d3 scales and shapes and
`d3-selection` into a ref (no `d3-transition`/`d3-timer`), anime.js, Motion `animate()` (on the Web Animations API,
which runs on the frame clock: `element.animate()`, `KeyframeEffect`, `Animation`, `getAnimations()`), Paper.js (clear and redraw each
frame), Bklit UI, rough.js (pass `seed`), Chart.js (`animation: false`, `update('none')`), Observable Plot, Vega, visx,
Matter.js and Rapier (step the world to the frame). Shiki is close: `monospace` is the bundled JetBrains Mono unless you
load a monospace font (ENGINE.md "Fonts"). Mermaid 12 draws with its default HTML labels (a `<foreignObject>` of `<div>`s: flowchart,
class, state and ER checked) and with text labels (sequence, pie); load the font its labels use before `mermaid.render`, so the
boxes are measured with it. Load a font before Chart.js or Recharts measure text.

### 11.11 HyperFrames projects

`kinetograph render|still|doctor|studio <index.html|dir>` takes a HyperFrames project as it is (nested compositions,
`window.__timelines` seeked per frame, `data-hidden`, `data-color-grading`, speed ramps, volume lanes, its 18 embedded
fonts, WebGPU shader backgrounds); the loader is `packages/core/src/hyperframes/`. A frame never touches the network:
before frame 0, `render|still|doctor|studio` download whatever the page loads from the web (CDN scripts, ES modules and
their imports, data, media, fonts, remote pictures) into the cache and pin it in `kinetograph.lock.json` beside the entry
(sha256 and size per URL; commit it). You do not need to run `fetch-deps` first. `--offline` never downloads (a missing
file is the error it always was: it names the URL and the command). `kinetograph fetch-deps <entry>` runs the download on
its own; `--update` downloads again and rewrites the lock, the way to accept a file that changed (a changed file otherwise
stops the run). https only; `--allow-host a.com,b.com` adds hosts, `--url` adds a file a scan missed, `--max-media-mb N`;
each file is hash-checked against the cache and the lock on every read. `<script type="importmap">` and
`<script type="module">` (inline or `src`, relative or CDN imports, bare names through the map) are bundled into classic
scripts that run after the page's classic scripts (an `import()` of a computed specifier is answered from the cache at run time; the pre-pass runs the first frames to find them, so keep them to what frame 0 or a few sampled frames ask for, or expect a note and a one-time download in the render). A Remotion project's remote `<Img>`, `<Video>` and CSS `url()` files are
found by scanning its bundle, downloaded the same way and locked in the same file; one first requested during a render is
fetched once, added to the lock and noted. In the studio the download step runs again when a file of the project changes (a dependency added in a sub-composition or a local module needs no restart). Three.js is unsupported and reported. Full list:
`/docs/compat/#hyperframes-projects`, `/docs/known-issues/#hyperframes-projects`.

### 11.12 Motion tracking (`kinetograph track`, `useTrack`, `usePlaneTrack`)

Blender's tracker, run ahead of time. `kinetograph track` follows points through a video with libmv, the tracker
Blender's "Track Markers" uses (built into the addon from Blender 4.5 LTS's copy, `vendor/libmv`), and writes
`<video>.track.json`. A component reads it with `useTrack()`. Tracking never runs during a render: the render only reads
the file, so it stays a pure function of the frame.

```sh
kinetograph track public/clip.mp4 --point 980,800 --point sign=1690,640 [--model loc] [--pattern 21 --search 71] \
  [--match keyframe|previous] [--min-correlation 0.75] [--margin 0] [--from F --to F] [--backwards] [-o out.json]
```

- `--point x,y` (repeat for more; `name=x,y` names it, default `p1`, `p2`, ...) is in **video pixels of the first frame
  tracked, y down, (0, 0) the top-left corner of the frame** (the centre of the top-left pixel is (0.5, 0.5)): where
  the point is in a still of that frame, as CSS `left`/`top` would place it. Blender's normalised marker position
  `(u, v)` (v up) is `(u * width, (1 - v) * height)`.
- The settings are Blender's for a new track, and its defaults: `--model loc|locrot|locscale|locrotscale|affine|perspective`
  (default `loc`), `--pattern 21` and `--search 71` (square sizes in px), `--match keyframe` (each frame is matched
  against the placed marker's pattern; `previous` matches the frame before, which drifts but follows a changing
  look), `--min-correlation 0.75`, `--margin 0`, brute-force pre-pass on, normalisation off.
- `--from` / `--to` bound the frames (default the whole clip); the points are placed at `--from`, or at `--to` with
  `--backwards`, which tracks towards frame 0.
- A track stops where Blender's would: the match falls under the minimum correlation or out of the search area, or the
  pattern reaches the frame edge (the margin check). That frame is listed in `lost`.
- Frames are decoded by the renderer's own ffmpeg path, so frame `n` is the picture a `<Video>` shows at `n / fps` of
  the clip. Grayscale is Blender's (0.2126 R + 0.7152 G + 0.0722 B of the 8-bit values).

The file:

```ts
interface TrackFile {
  version: 1;
  clip: { width: number; height: number; fps: number; frames: number };
  tracks: {
    name: string;
    model: string;
    frames: { frame: number; center: [x, y]; corners: [[x, y], [x, y], [x, y], [x, y]]; correlation: number }[];
    lost: number[]; // the frame where the track stopped before the end of the range, if it did
  }[];
}
```

`frames` is in increasing frame order whichever way it was tracked. `corners` is the pattern quad, top-left, top-right,
bottom-right, bottom-left, in the same video pixels; `correlation` is 1 at the placed frame.

```tsx
import { useTrack } from '@kinetographdev/core';
import { OffthreadVideo, staticFile } from 'remotion';

const Label = () => {
  const { x, y, rotation, scale } = useTrack('clip.mp4.track.json', 'sign'); // a public/ name, or a staticFile() path
  return <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})` }}>Hi</div>;
};

// <OffthreadVideo src={staticFile('clip.mp4')} /> and <Label /> in the same Sequence, the video at its own size.
```

- `useTrack(file, trackName?)` returns `{ x, y, scale, rotation, corners, frame, tracked }` for `useCurrentFrame()`.
  No track name: the first track.
- The composition frame `f` is the clip frame `floor(f * clip.fps / fps)` (the clip starts at frame 0 of the Sequence,
  as a `<Video>` without trims does). The value is that frame's marker; before the first marker it is the first, after
  the last (and after the track is lost) the last one holds. `tracked` is false when the value is held.
- `scale` is the square root of the pattern quad's area over the first frame's; `rotation` is the degrees the quad's
  horizontal edges have turned clockwise since the first frame, unwrapped (it can pass 180). Both are 1 and 0 with
  `--model loc`. `corners` is a corner pin.
- Coordinates are the video's pixels: a video drawn at another size or position needs the same scale and offset
  applied to them.
- The file is read with `staticFile()` rules and read again when it changes on disk (the studio picks up a new track).
  `trackAt(file, clipFrame, trackName?)` and `readTrackFile(file)` are the same reads outside a component.

**Detect Features.** `--detect` places points the way Blender's "Detect Features" (`bpy.ops.clip.detect_features`)
does, with libmv's Harris detector, on the frame the points are placed at (`--from`, or `--to` with `--backwards`),
and then tracks them with the rest:

```sh
kinetograph track public/clip.mp4 --detect [--detect-threshold 0.5] [--detect-distance 120] [--detect-margin 16] \
  [--detect-inside x,y,x,y,... | --detect-outside x,y,x,y,...] [--point x,y ...]
```

- The defaults are the operator's: threshold 0.5 (Blender's units; libmv gets it over 100000, so 0.05 finds about ten
  times as many corners), minimum distance 120 px between features (a better one wins), margin 16 px from the frame
  edge. Detection runs on the whole frame, Blender's `FRAME` placement.
- `--detect-inside` / `--detect-outside` (repeatable, at least three x,y pairs in video pixels) keep the features inside
  any of the polygons or outside all of them: Blender's `INSIDE_GPENCIL` / `OUTSIDE_GPENCIL`, whose polygons are the
  strokes of the clip's annotation. Not both.
- Detected points come after the `--point` ones, named on from them (`p<n>`), in the order Blender adds their tracks
  (libmv lists the strongest corner first; Blender, and so the file, has it last). Each is at the centre of the pixel
  libmv found, `(x + 0.5, y + 0.5)`. The command prints how many it placed.
- The tracks get the same settings as `--point` tracks (`--model`, `--pattern`, ...), as Blender's new tracks get the
  clip's defaults.

**Plane tracks.** `--plane` makes a plane track from four or more point tracks, as Blender's "Create Plane Track" does
after tracking: four corners carried through the clip by the homography of the points (libmv's
`EstimateHomography2DFromCorrespondences`), for a corner pin.

```sh
kinetograph track public/clip.mp4 --point 820,540 --point 1250,430 --point 820,360 --point 200,600 \
  --plane all [--plane screen=p1,p2,p3,p4] [--plane-corners screen=x,y,x,y,x,y,x,y]
```

- `--plane all` uses every track; `--plane p1,p2,p3,p4` names them (at least 4, no three on a line); `name=...` names
  the plane (default `plane1`, `plane2`, ...). Repeat for more planes.
- The plane is made at the frame the points are placed at. Its corners start as Blender's do, the bounding box of the
  tracks' pattern squares there, or as `--plane-corners` gives them: x,y of top-left, top-right, bottom-right,
  bottom-left in video pixels on that frame (Blender: dragging the corners into place). `name=` picks the plane;
  without it, the first.
- From that frame the corners are carried forwards, then backwards, one frame at a time: the tracks with a marker on
  both frames give the point pairs, and each corner is moved by their homography, in Blender's f32 arithmetic. It stops
  where fewer than four tracks have markers on both frames. Like Blender it counts the disabled markers a track leaves
  at its ends (one frame before the placed marker, the frame it was lost, the frame after a failed match, one past the
  range), so a plane usually reaches a frame past the tracked range at each end, holding still there.

The file gains `planes`, left out when there are none (so a file without planes is unchanged):

```ts
interface TrackFile {
  // ... as above, and:
  planes?: {
    name: string;
    tracks: string[];                                    // the point tracks it follows
    frames: { frame: number; corners: [[x, y], [x, y], [x, y], [x, y]] }[]; // top-left, top-right, bottom-right, bottom-left
  }[];
}
```

Plane corners are written as f64: Blender's f32 normalised corners times the frame size, exactly.

```tsx
import { Image, cornerPin, usePlaneTrack } from '@kinetographdev/core';
import { AbsoluteFill, OffthreadVideo, staticFile } from 'remotion';

const Screen = () => {
  const { pin } = usePlaneTrack('clip.mp4.track.json', 'screen');
  // The picture's box (any size) is pinned to the plane's corners, in the video's pixels.
  return <Image src={staticFile('poster.png')} width={1280} height={720} effects={[cornerPin(pin)]} />;
};

export const Shot = () => (
  <AbsoluteFill>
    <OffthreadVideo src={staticFile('clip.mp4')} />
    <AbsoluteFill>
      <Screen />
    </AbsoluteFill>
  </AbsoluteFill>
);
```

- `usePlaneTrack(file, planeName?)` returns `{ corners, pin, frame, tracked }` for `useCurrentFrame()`, with frames
  matched and held as `useTrack` does (no name: the first plane). `pin` is `{ topLeft, topRight, bottomRight,
  bottomLeft }`, what the `cornerPin` effect (SCENE.md, "cornerPin") takes; the corners are in the layer's own space,
  so the pinned layer's box must start at the video's top-left corner with the video drawn at its own size (or the
  same scale and offset applied). `planeAt(file, clipFrame, planeName?)` is the same read outside a component.

Parity with Blender (`node scripts/track-parity/compare.mjs`: Blender run headless on the same clips, points and
settings, all six models, both matches, backwards): the same frames are tracked and lost, and every marker agrees to
within 2e-4 px, the f32 rounding of Blender's normalised marker coordinates (many are equal). That needs the marker
placed through the same f32 steps as Blender's, and the same decoded pixels (they are: Blender's frames and ours were
compared byte for byte). Detect Features finds the same features in the same order (positions bit-equal), with the
defaults, other thresholds, distances and margins, another frame, and inside and outside polygons; plane corners are
bit-equal to Blender's on every frame (0 px), over the same frames, for planes made at the first frame, mid-clip and
tracking backwards, from 4, 5 and 24 tracks. Repeatability: the same inputs give the same bits on a platform
(`crates/track/tests/golden.rs`, a golden per platform); platforms are not bit-equal with each other.
