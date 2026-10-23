# Kinetograph

A programmatic video engine with no browser in it. You (or an agent) write a video in TypeScript with Remotion's API,
CSS, SVG, Canvas 2D, WebGL shaders and Web Audio; Node runs the code; a Rust GPU compositor, loaded into Node as an
N-API addon, draws every frame. Existing Remotion projects render as they are: `remotion` and `@remotion/*` imports
resolve to Kinetograph's own implementation of them.

**Status (2026-10-16):** the core renderer, effects, authoring layer, studio, Remotion compatibility on a native DOM
engine (CSS, SVG, Canvas 2D, WebGL fragment shaders) and an own 3D layer are built. The papercut test project renders
all 988 of its frames natively, and a reference scene renders 7.0x faster than Remotion (1.28 s against 8.96 s, median,
on an Apple M4). What is left is listed under known issues on the kinetograph site (`/docs/known-issues/`).

- [The DOM engine](docs/ENGINE.md), and Remotion compatibility on the kinetograph site (`/docs/compat/`)
- [Authoring contract](docs/AUTHORING.md): the TS packages, the addon's API and how elements map to scenes
- [Scene format](docs/SCENE.md)

## Architecture

```mermaid
flowchart TB
  subgraph project["Your project (TSX)"]
    P["Remotion API · CSS / SVG · Canvas 2D · WebGL · Web Audio<br/>native elements and effects from @kinetograph/core"]
  end

  subgraph node["Node: the kinetograph CLI, studio and MCP server"]
    B["esbuild bundle<br/>remotion, @remotion/* → @kinetograph/core"]
    D["determinism shim<br/>Date, Math.random, timers, rAF driven by the frame"]
    R["@kinetograph/react: React reconciler<br/>runs the tree once per frame"]
    S["browser shims: DOM readback, Canvas 2D and WebGL<br/>contexts that record their calls"]
    A["@kinetograph/audio<br/>node-web-audio-api, OfflineAudioContext"]
    E["emit: native elements → scene layers<br/>runs of HTML/SVG → DOM islands"]
    B --> D --> R --> E
    R <--> S
  end

  subgraph rust["Rust: the @kinetograph/native addon (napi-rs)"]
    DOM["kinetograph-dom: DOM engine<br/>blitz-dom + Stylo (CSS) + taffy (layout) + Parley (text),<br/>usvg (SVG); painted into scene layers"]
    C["kinetograph-core: compositor on wgpu<br/>Vello (vectors, text, Canvas 2D), WGSL effects,<br/>GLSL via naga (WebGL), scene3d (glTF, PBR),<br/>ThorVG (Lottie), 2.5D camera, motion blur, layer cache"]
    M["media: FFmpeg decode and encode<br/>(VideoToolbox / libx264)"]
    DOM --> C
    M <--> C
  end

  P --> B
  E -- "scene JSON per frame" --> C
  E -- "island JSON" --> DOM
  A -- "PCM" --> M
  C --> OUT["MP4 / MOV / PNG<br/>studio preview frames"]
```

**One frame, start to finish.**

1. **Bundle.** The CLI bundles the project with esbuild. `remotion` and `@remotion/*` imports are rewritten to
   `@kinetograph/core`, so the project's code runs unchanged; `@remotion/google-fonts` families are downloaded once and
   cached.
2. **Run the frame.** Node imports the bundle with a determinism shim installed: `Date`, `Math.random`, timers and
   `requestAnimationFrame` all follow the frame number, so a frame is a pure function of (project, frame) and nothing
   reads the wall clock. Kinetograph's React reconciler renders the tree for that frame.
3. **Split the tree.** Native elements (`<Image>`, `<Text>`, `<Shape>`, effects, `<Scene3D>`, …) become scene layers
   directly. Each run of plain HTML and SVG becomes a *DOM island*: its tags, attributes, inline style, stylesheets and
   the time are sent to the addon as JSON. `<canvas>` 2D and WebGL contexts are recording contexts: each call becomes a
   command, and the commands become one layer.
4. **Style, lay out and paint the DOM in Rust.** `kinetograph-dom` builds a Blitz document from the island, styles it
   with Stylo (Firefox's CSS engine), lays it out with taffy and Parley, and paints it, in CSS paint order, into the same
   scene layers native elements use. Readback that a component needs (`getBoundingClientRect`, `getComputedStyle`,
   `ResizeObserver`) is answered from the same document. Anything it cannot draw is reported, and `--strict` fails on
   it.
5. **Composite on the GPU.** `kinetograph-core` draws the layer tree with wgpu: Vello for vectors, text and Canvas 2D;
   WGSL passes for blends, masks, blurs, shadows, filters and the rest of the effects; WebGL shaders translated from
   GLSL by naga; the `scene3d` renderer for meshes and glTF models; ThorVG for Lottie. Layers that did not change since
   the last frame are reused.
   Skia (Graphite on Metal, or on Vulkan elsewhere) draws the 2D layers by default; layers it cannot draw fall back to
   Vello and wgpu. `KINETOGRAPH_BACKEND=vello` selects Vello for the whole run, and a build with
   `--no-default-features` has Vello only. If Skia cannot start on the GPU, one warning is printed and Vello draws.
6. **Encode.** Frames go to FFmpeg (VideoToolbox on macOS) on another thread while the GPU draws the next one; the
   project's audio, rendered offline with the Web Audio API, is mixed and muxed at the end.

**Where the code is.**

| Path | What it is |
|---|---|
| `crates/core` | `kinetograph-core`: scene format, compositor, effects, text, Canvas 2D, GLSL, 3D, Lottie, video |
| `crates/dom` | `kinetograph-dom`: the DOM engine (Blitz document, CSS, layout, paint, SVG, readback) |
| `crates/node` | `@kinetograph/native`: the N-API addon over both |
| `crates/cli` | the Rust `kinetograph` binary for JSON scenes (`still`, `render`, `bench`) |
| `packages/scene` | scene types, effect helpers, the recording Canvas 2D and WebGL contexts |
| `packages/react` | the reconciler, native elements, DOM-island emit |
| `packages/core` | Remotion's API and `@remotion/*` packages, the frame loop, the determinism shim |
| `packages/compat` | browser shims (DOM, readback, web APIs) and `doctor` |
| `packages/audio` | Web Audio rendering and mixing |
| `packages/cli` | the `kinetograph` CLI and MCP server (the agent surface) |
| `packages/studio` | `kinetograph studio`: a local web UI whose preview frames are rendered by the addon |
| `vendor/` | patched copies of Vello, Stylo, blitz-dom and fontique (each patch explained in `vendor/README.md`) |

**Decisions behind it.** No Chrome anywhere in rendering, including canvas and WebGL: every CSS, SVG and canvas feature
is ported natively, and Chrome for Testing is used only by tests, as a reference to compare against. Node hosts the
engine so every npm package and Web API is there; the engine is a native addon so pixels never cross into JavaScript.
Existing crates do text shaping, layout, CSS and rasterising; Kinetograph writes the glue.

## Projects in TSX

Node 22 or later. The npm workspaces are `@kinetograph/scene` (scene types and effect helpers), `@kinetograph/react`
(the reconciler and native elements), `@kinetograph/core` (Remotion's API and packages, the frame loop, the
determinism shim), `@kinetograph/audio`, the `kinetograph` CLI, and `@kinetograph/native` (the addon, `crates/node`).

```sh
npm ci
npm run build                                   # TS packages and a debug addon
npm run build:release -w @kinetograph/native    # the addon for timing

npx kinetograph still examples/rajz-cards/index.tsx 60 -o out/rajz-60.png
npx kinetograph strip examples/rajz-cards/index.tsx -n 12 -o out/rajz-strip.png
npx kinetograph render examples/rajz-cards/index.tsx -o out/rajz-cards.mp4
npx kinetograph inspect examples/rajz-cards/index.tsx --frame 60 --json
```

A project imports from `remotion` and `@remotion/*` as it would for Remotion (the CLI maps them onto
`@kinetograph/core`) and from `@kinetograph/core` for the native elements and effects. Every command takes `--json`;
`npx kinetograph mcp` serves the same commands over MCP; [Use with agents](packages/site/content/docs/guides/agents.mdx)
has the client setup and the agent skill. `npm test` runs the CPU tests; the GPU ones run with
`KINETOGRAPH_GPU_TESTS=1`.

## Build and run

Use the rustup toolchain (stable, edition 2024). It needs a GPU that wgpu supports (Metal on macOS); no window or
display is required. The CLI links FFmpeg for `render`, so building it needs the FFmpeg development libraries (see
[Rendering video](#rendering-video)).

```sh
# If Homebrew's rustc is first on PATH and fails to start, put rustup's first:
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"

cargo build --release

# Render frame 30 of the example scene to a PNG (add --json for machine-readable output)
./target/release/kinetograph still examples/papercut-card.json 30 -o out/card.png

# Render the whole scene (or a range) to an H.264 video; see "Rendering video" below
./target/release/kinetograph render examples/papercut-card.json -o out/card.mp4 --range 0..60

# Time one frame: two warm-up renders, then K runs; per-stage mean/min/max in ms
./target/release/kinetograph bench examples/papercut-card.json --frame 30 --runs 10

# Time successive frames in order, with the layer cache on (see "Layer cache" below)
./target/release/kinetograph bench examples/bench-diorama.json --range 40..90
```

### Rendering video

`kinetograph render <scene> -o out.mp4 [--range a..b | a..=b] [--encoder NAME] [--json]` renders frames of a scene and
encodes them to H.264 with FFmpeg (the `ffmpeg-next` crate, linked against the FFmpeg development libraries: install
FFmpeg with `libx264` and `pkg-config`, and `libclang` for the bindings; `brew install ffmpeg` on macOS, `libavcodec-dev
libavformat-dev libswscale-dev libavutil-dev libclang-dev` on Debian and Ubuntu).

- **Range.** `10..40` is frames 10 to 39 and `10..=40` is 10 to 40, as in Rust; either start or the end of `..` may be
  left out. The default is the whole scene. A range that is empty or runs past `durationInFrames` is an error.
- **Encoder.** `--encoder` names any ffmpeg H.264 encoder. Without it, `h264_videotoolbox` is used on macOS when ffmpeg
  has it, and `libx264` everywhere else. `libx264` runs at `crf 18`, `preset medium`; the other encoders get a bit rate
  of 0.2 bits per pixel per frame (about 12.4 Mbit/s for 1080p30). The Node `kinetograph render` also writes H.265,
  ProRes, VP9 and GIF, with `--scale`, `--crf` and the rest (docs/AUTHORING.md §9).
- **Container.** From the output's extension, `.mp4` or `.mov`; both are written with `+faststart` (the index first, so
  they play while downloading).
- **Format.** RGBA is converted to `yuv420p` by swscale with BT.709 coefficients, limited range, and the stream is tagged
  BT.709. The width and height must both be even (a clear error otherwise). **Alpha is dropped**, not composited: give
  the scene an opaque `background`, since where it is clear the video shows the renderer's straight colours (black for
  empty pixels).
- **Frame rate.** `fps` becomes an exact fraction: whole rates are `n/1`, and 23.976, 29.97 and 59.94 are
  `24000/1001`, `30000/1001` and `60000/1001`. Frame `first` of the range is time 0 in the file.
- **Speed.** One renderer (one GPU setup) renders the whole range, and finished frames go through a channel that holds
  two to an encoder thread, so the GPU work for frame N+1 overlaps the encoding of frame N. Layers that did not change
  since the previous frame are not drawn again (see [Layer cache](#layer-cache)), and a frame that is the same as the
  previous one is not drawn at all (see [Frame reuse](#frame-reuse)). No sound yet: the file has a video
  stream only.
- **Output.** Text mode prints a progress line to stderr and a one-line summary. `--json` prints
  `{output, encoder, width, height, fps, frames, first, last, ms, ms_per_frame, repeated}` (`last` inclusive; `ms` covers
  rendering and encoding the range, not GPU setup). On failure the partial file is deleted.

### Layer cache

A layer that has not changed since the previous frame is not drawn again: the renderer keeps the finished texture a
layer was blended from and blends it again. (A group keeps its whole subtree's, so a group of still layers is one blend.)
A kept texture is used only when everything it was made from is equal to what it is made from now, compared exactly:
the layer and everything in it as resolved for the frame (motion blur samples included, and the frame that grain,
dither and custom shaders read), its parent's matrix, its matte source, and the camera if something in it is moved in
3D. The layer's own `opacity` and `blendMode` are not part of that, since they are applied when it is blended, so a
fading layer is not redrawn. A layer with a `backdropBlur` (or whose matte source has one) is never kept, because its
texture is made from the canvas under it, and nor are the layers inside a motion-blurred layer, of which only the
average is kept. Frames are byte-identical with the cache on or off. What a frame does not use is dropped when it ends,
and no more than 1 GiB of textures is kept.

- `render` turns the cache on. `still` renders one frame, so it has nothing to reuse. In the library, a new `Renderer`
  has the cache off; `Renderer::set_layer_cache(true)` turns it on and `layer_cache_counts()` says how many layers have
  come from it.
- `bench --frame` renders the same frame over and over, so it runs with the cache off (on, every run after the first
  would only time the cache). `bench --range a..b` (the syntax of `render --range`) times the frames in order with the
  cache on, as `render` runs them: a line per frame with its time and how many layers came from the cache (`reused`)
  and how many were drawn and kept (`drawn`), then the stage means, minimums and maximums over the frames. The range is
  rendered twice from an empty cache, first the whole frames and then the stages (which wait for the GPU after every
  step, so they cannot also be the frame's time). `--range` cannot be combined with `--frame` or `--runs`.
- `bench --passes` (with either form) renders the frames once more with a GPU timestamp around every compositing pass
  and groups the passes by kind (`blend`, `to linear`, each blur step and shadow, `displace`, `clear`, …): passes per
  frame, their GPU time, time per pass and the texels drawn into. Passes can overlap on the GPU, so their sum is not
  the frame's time. Vello's rasterising and copies between textures cannot be timed this way and are not in it.

### Frame reuse

A frame that is provably the same as the frame before it is not drawn: no rasterising, compositing, readback or colour
conversion. The encoder is given the previous frame's converted picture again, so the file is the same as one with every
frame drawn. The proof is the layer cache's, for the whole frame: the frame's resolved scene (every keyframed value at
the frame, the motion blur samples, and each input that moves with time without a keyframe: a custom shader's `frame`
and `time`, grain and dither frames, a video's picked picture, a GIF's or Lottie's time, Canvas 2D commands, WebGL
recordings with their uniforms, 3D scenes) must equal the previous frame's, compared exactly (`PartialEq`, no hash), and
the renderer must have read no new or changed file (fonts, images, videos, tables, by path, size and modification time)
and kept the same size, margin, blend space, frame rate, fonts and asset directory since. Only the frame number is not
compared, since no pass reads it. Anything else is drawn; a NaN never equals itself, so a frame holding one is drawn.

- `render` (and the addon's `Renderer`, so a project's `render` at any `--concurrency`) turns it on; the summary says
  how many frames were repeats (`repeated` in `--json`). With `--concurrency N` a frame is only compared with the one
  before it in the same worker's chunk, and a chunk's first frame is always drawn, so the output does not depend on how
  the frames were shared out.
- `KINETOGRAPH_NO_REUSE=1` turns it off, to compare or debug. `bench` always draws every frame.
- In the library a new `Renderer` has it off: `Renderer::set_frame_reuse(true)`; `start_frame` then returns a
  `PendingFrame` with `is_repeat()` true for a frame it did not draw, `finish_frame` gives that frame the earlier pixels,
  `forget_frame()` makes the next frame be drawn, and `repeated_frames()` counts the repeats (`crates/core/src/reuse.rs`).

Checks: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. The golden-image tests compare
against PNGs in `crates/core/tests/golden/` made on an Apple M4; regenerate them with
`UPDATE_GOLDEN=1 cargo test --test golden` after checking the difference by eye. The example images are regenerated with
`cargo run -p kinetograph-core --example gen_test_image` and `--example gen_papercut_assets`.

`docs/reference/rajz-reference.mp4` is not in the repo. It is a third-party video and must be placed there locally
to run the reference comparisons.

## License

[PolyForm Small Business License 1.0.0](LICENSE.md): free for individuals, non-profits, and companies with fewer than
100 people and under 1,000,000 USD (2019) revenue. Larger companies need a commercial licence; see
[COMMERCIAL.md](COMMERCIAL.md). Vendored crates keep their own licences ([vendor/README.md](vendor/README.md)).

Required Notice: Copyright 2026 Sanat Gupta (https://github.com/0xS4N4TG)
