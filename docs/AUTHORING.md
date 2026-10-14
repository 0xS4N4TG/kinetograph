# Authoring contract (Phase 3)

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
/** Parses and validates scene JSON (SCENE.md); asset paths resolve against `baseDir` (default: cwd). */
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
  id: string; type: string;                  // 'shape' | 'text' | 'image' | 'group' | 'noise' | 'meshGradient' | 'lottie'
  opacity: number; blendMode: string;
  transform: { x: number; y: number; scale: number; rotation: number; anchorX: number; anchorY: number;
               rotateX: number; rotateY: number; z: number };   // resolved, after layout (§4.1)
  matrix: [number, number, number, number, number, number];     // a b c d e f: the layer's 2D matrix on the canvas
  box: { x: number; y: number; width: number; height: number } | null;    // layer space (the `inset` box)
  bounds: { x: number; y: number; width: number; height: number } | null; // canvas px, transform and effect reach
  effects: string[];                         // effect types, in order
  clip: string | null; mask: boolean; matte: { layer: string; mode: string } | null; matteSource: boolean;
  motionBlur: { samples: number; shutter: number } | null;
  text?: { text: string; font: string; size: number; width: number; height: number; maxWidth: number | null;
           lines: { text: string; top: number; bottom: number; baseline: number }[] };
  src?: string;                              // image, lottie
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
knowing its size. The 3D turn uses the same pivot. A layer without a box (a group without `layout`) ignores them.
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
| `<Lottie>` | `src` or `animationData` (parsed JSON, written once to a content-addressed cache file), `width?`, `height?`, `loop?`, `playbackRate?` (default 1) | `lottie` with `time = frame / fps * playbackRate` from the timeline |
| `<Camera>` | `perspective`, `x?`, `y?` | the scene's `camera` (at most one per tree; anywhere in it) |
| `<Audio>` | Remotion's: `src`, `volume` (number or `(frame) => number`), `trimBefore`/`trimAfter` (and the older `startFrom`/`endAt`), `playbackRate`, `loop`, `muted` | an `AudioClipJson` in `RenderedTree.audio`, not a layer |

Raw text outside `<Text>` is an error naming the parent element. Duplicate explicit ids are an error naming the id.

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
}
```

A clip appears in the tree of every frame it plays in; the CLI joins them by `id` into one clip with a volume per
frame (§8).

## 7. `@kinetograph/core` (stream 2)

### 7.1 Remotion core API

Exported from `@kinetograph/core` (and so from `remotion` through the CLI's alias), behaving as Remotion documents
them: `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`, `measureSpring`, `Easing`,
`random`, `Sequence`, `Series`, `Loop`, `Freeze`, `AbsoluteFill`, `Img`, `Audio` (re-exported from react), `staticFile`,
`delayRender`, `continueRender`, `cancelRender`, `Composition`, `Still`, `Folder`, `registerRoot`, `getInputProps`.
`random(seed)` is bit-exact with Remotion's; the rest match its documented behaviour, tested against values recorded
from the published package (§10).

Mapping onto the engine:

- `Sequence` renders its children inside a plain `<Layer>` (no layout), only while `from <= frame < from +
  durationInFrames`, and shifts the timeline by `from`. It does not lay its children out (Remotion's
  `layout="absolute-fill"` wraps them in a flex box; here native elements keep their own positions). `name` becomes
  nothing; `layout="none"` is accepted.
- `AbsoluteFill` is `<Layer layout={{ flexDirection: 'column', width, height }} layoutItem={{ position: 'absolute' }}>`
  covering the composition, so its children stack in a column as in CSS and it overlays its siblings. `style` maps
  `backgroundColor`/`background` (a colour) to a full-size rect drawn first, `opacity`, and the flex properties
  (`display`, `flexDirection`, `justifyContent`, `alignItems`, `flexWrap`, `gap`, `padding`) to `layout`; other keys
  are ignored with one `console.warn` per key.
- `Img` is `<Image>` with `style.width`, `style.height`, `style.objectFit` mapped to `width`, `height`, `fit`.
- `staticFile(name)` is the absolute path of `name` in the public directory, `setPublicDir(dir)` (default
  `<entry directory>/public`, set by the CLI).
- `delayRender(label?)` returns a handle; `renderFrame` waits until every handle is continued, failing after 30 s
  (real time, used only for the error) with the labels still open. `cancelRender(err)` fails the frame.

### 7.2 Compositions and fonts

```ts
export interface CompositionInfo { id: string; width: number; height: number; fps: number; durationInFrames: number;
                                   defaultProps: Record<string, unknown> }
export function getCompositions(): CompositionInfo[];         // after registerRoot ran
export function registerFont(font: { family: string; path: string; weight?: number | string; style?: 'normal' | 'italic' }): void;
export function getFonts(): Record<string, string>;           // fontKey → absolute path, every font registered
export function setPublicDir(dir: string): void;
```

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
composition's `width`, `height`, `fps`, `durationInFrames`, `background: "transparent"`, `fonts: getFonts()`, the
tree's `camera` and `layers`.

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
- Nothing else is patched (`setImmediate`, promises and I/O are real).

### 7.5 Remotion packages (subpath exports)

| Subpath | Remotion package | Notes |
|---|---|---|
| `@kinetograph/core/transitions` (+ `/transitions/fade`, `/slide`, `/wipe`, `/flip`, `/clock-wipe`, `/iris`, `/none`) | `@remotion/transitions` | `TransitionSeries`, `linearTiming`, `springTiming`; presentations render `<Layer>`s with opacity, transforms and clips |
| `@kinetograph/core/motion-blur` | `@remotion/motion-blur` | `Trail`; `CameraMotionBlur` is `<Layer motionBlur={{ samples, shutter: shutterAngle / 360 }}>` |
| `@kinetograph/core/noise` | `@remotion/noise` | `noise2D/3D/4D(seed, …)` |
| `@kinetograph/core/paths` | `@remotion/paths` | pure path maths |
| `@kinetograph/core/shapes` | `@remotion/shapes` | `make*` functions; components render `<Path>` |
| `@kinetograph/core/layout-utils` | `@remotion/layout-utils` | `measureText`, `fitText`, `fillTextBox` through `layoutText` (§3), fonts from `getFonts()` |
| `@kinetograph/core/animation-utils` | `@remotion/animation-utils` | `interpolateStyles`, `makeTransform` |
| `@kinetograph/core/captions` | `@remotion/captions` | `parseSrt`, `serializeSrt`, `createTikTokStyleCaptions` |
| `@kinetograph/core/google-fonts` | `@remotion/google-fonts/*` | §7.2 |
| `@kinetograph/core/fonts` | `@remotion/fonts` | §7.2 |
| `@kinetograph/core/lottie` | `@remotion/lottie` | re-exports `<Lottie>` |
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
| `still <entry> <frame> -o out.png` | one PNG |
| `render <entry> -o out.mp4 [--range a..b] [--encoder] [--draft]` | video with audio; `--draft` renders at half size |
| `strip <entry> -n 12 -o sheet.png` | contact sheet of evenly spaced frames, labelled, built as a scene and rendered by the engine |
| `onion <entry> <range> -n 6 -o onion.png` | frames of the range blended over one another |
| `inspect <entry> [--frame N]` | `InspectResult` |
| `lint <entry>` | text overflowing its box or the canvas, layers off the canvas, overlapping text, missing fonts or assets, with frame and layer id |
| `bench <entry> [--frame N --runs K \| --range a..b]` | stages: `js` (renderFrame), `stringify`, then the addon's (`handoff`, `resolve`, `raster`, `composite`, `readback`), `total`. Spike 1 |
| `audio analyze <entry> [--range]` | `AudioAnalysis` per Sequence-free whole and per `--scenes` |
| `snapshot <entry> [--frames 0,30,60] [--update]` | compares PNGs in `__snapshots__/` next to the entry, max channel difference 2 |
| `effects` | `effectCatalog` |
| `doctor` | reports that compat mode is not built yet (Phase 5) |
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
