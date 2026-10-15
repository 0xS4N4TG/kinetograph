# Kinetograph: technical handoff

Written 2026-10-14 at the end of the design session that produced the idea. Nothing is built yet. This file holds
the decisions and the reasoning behind them; `RESEARCH.md` holds the evidence (competitor scan, Blitz audit,
reference video breakdown).

"Kinetograph" is a placeholder name (Edison's first motion-picture camera). The crate name `kinetograph` was free on
crates.io on 2026-10-14. `zoetrope` is taken.

## 1. What it is

A programmatic video engine: agents write TypeScript, a Rust core renders it on the GPU, no browser anywhere.

Pitch: **"Your agent's existing video and audio code, rendered natively."** Remotion's API for visuals, the Web Audio
API for sound, a GPU compositor underneath, and a CLI/MCP surface built for agents that cannot watch video.

Target output: one-to-one papercut-style reels (the user's existing Remotion pipeline in
`$KINETOGRAPH_CORPUS/lib/papercut/`) and After Effects-style motion graphics
like `docs/reference/rajz-reference.mp4`.

## 2. Who writes the code

Agents write everything. Human familiarity with React or Rust does not matter. What matters:

- **First-try correctness.** Models write Remotion, React and Web Audio code from memory. A novel API needs a skill
  loaded every session and fails more often on the first draft.
- **Fix-loop speed.** TS running in Node hot-reloads in milliseconds. A Rust authoring API (fframes)
  needs a cargo build per edit and has borrow-checker/lifetime errors as an extra failure mode.

Both claims are hypotheses. Phase 0 measures them (section 8).

## 3. How it differs from fframes (the closest existing project)

fframes (github.com/dmtrKovalenko/fframes, MIT, ~2.7k stars, active) already does: Rust + SVG per frame via an
`svgr!` macro, Skia GPU rendering on Metal/Vulkan, SkSL/Shadertoy shader layers, linked libav, an agent skill, and
agent CLI commands (`inspect`, `strip`, `onion`, `frame`, `snapshot`, `audio analyze`, `--json`), a native preview
window and a WASM editor. Read its code before building anything; steal its CLI design.

Kinetograph's differences, ranked by how defensible they are:

1. **Remotion-shaped TS/TSX authoring with hot reload.** `useCurrentFrame`, `interpolate`, `spring`, `Easing`,
   `random`, `<Sequence>`, `<Series>`, `<AbsoluteFill>`, `<Img>`, `<Audio>`, `delayRender`, `staticFile`. No compile
   step.
2. **Runs existing Remotion projects** (compat mode), with automatic fallback to Remotion's own Chrome renderer for
   frame ranges that use unsupported features, and a `doctor` command that reports what fell back and why.
3. **Built-in Web Audio synthesis.** fframes mixes files and analyses loudness but cannot synthesise (its own audio
   guide says to use `sox` for placeholder sounds). Kinetograph ships the Web Audio API through
   `node-web-audio-api` (the npm build of `web-audio-api-rs`), so the oscillator/envelope/filter code Claude already writes runs unchanged
   and offline, sample-accurate to frames.
4. **Compositor built-ins**: blend modes, track mattes and masks, 2.5D camera, motion blur and an effect graph as
   first-class primitives, not hand-written shaders.

Decided 2026-10-14: own the engine, built from scratch, not on top of fframes. Point 4 needs a compositor fframes'
SVG-per-frame model doesn't have. fframes stays a reference for CLI design and pipeline ideas (no code copied).
Phase 0's fframes runs are recorded in `phase0/` as evidence, not as a gate.

## 4. Architecture

```
TS/TSX project (Remotion-shaped API, Web Audio API)
        │
        ▼
Node (or Bun) runs it, via `npx kinetograph …`
  - @kinetograph/core TS package: remotion shim (frame clock, interpolate, spring, random, Sequence...),
    react-reconciler ──► scene graph (layers, props, effects) per frame,
    determinism shim (Date, Math.random, timers driven by the frame)
  - node-web-audio-api (npm build of web-audio-api-rs) ──► OfflineAudioContext
  - three.js WebGPURenderer on the `webgpu` npm package (Dawn) ──► 3D layer texture (unverified, section 4)
        │  scene graph per frame, through N-API (napi-rs); pixels never cross
        ▼
Rust core, shipped as a prebuilt N-API addon (kinetograph.node)
  layout:     taffy (flex/grid)
  text:       parley + swash + fontique (shaping, wrapping, fallback); glyph positions exposed for kinetic type
  vector:     vello → textures   (SVG via usvg → vello_svg)
  lottie:     ThorVG via LottieFiles' dotlottie-rs → CPU buffer → texture
  compositor: layer tree → render targets → effect graph → blend, linear light, f16 textures
  effects:    WGSL shaders
  3D:         2.5D camera, layers as textured quads, depth sort, optional DOF (glam for maths)
  motion blur: N sub-frames accumulated
        │
        ▼
Media: ffmpeg-next (libav) decode/encode, VideoToolbox/NVENC; symphonia for audio decode
Pipeline threads: decode → render → async GPU readback → encode
        │
        ├── CLI + MCP server (TS)      agent surface
        └── kinetograph studio (TS)    local web server + browser UI; preview frames rendered by the addon
```

Decisions and why:

- **Node hosts the engine; the engine is an N-API addon** (decided 2026-10-14, replacing the embedded-runtime
  plan). Kinetograph is a general-purpose agentic editor, so JS coverage and usability decide: in Node every npm
  package, `Intl`, `fetch`, `Buffer` and the Web APIs just work, and `react-reconciler` and `node-web-audio-api`
  exist as packages instead of bindings we write. Deno announced on 2026-10-09 that development of its runtime
  ends after one year (rusty_v8 continues under Cloudflare, `deno_core`/`deno_runtime` unaddressed), which removed
  the embedded-V8 option; rquickjs and Boa lose on coverage; Bun cannot be embedded but loads the same addon
  (its Node-API coverage is ~95%), so `bunx kinetograph` works too. Node is foundation-governed, and Phase 5's
  Chrome fallback is a Node program anyway. Costs: no single self-contained binary (users need Node); prebuilt
  addons per platform via napi-rs CI; determinism moves into the TS shim, which overrides `Date`, `Math.random`
  and timers exactly as Remotion's contract already does. Measured on the M4 (2026-10-14): JS stage (React render
  + real Remotion `interpolate`/`spring`, 80 layers, Node 26) 0.78 ms/frame; GPU raster + composite + readback
  ~24 ms/frame (Phase 1 bench minus PNG); VideoToolbox H.264 encode at 1080x1920 ~4.1 ms/frame. Serial ~29 ms
  (5.4x Remotion's 157 ms), overlapped ~24 ms (6.5x); `still` 160–184 ms cold against Remotion's ~2 s (~11x).
  The addon handoff is the one unmeasured stage.
- **Not CSS/DOM as the core model.** The reference video is layer compositing (gradient maps, halftone, backdrop blur,
  3D card stacks, motion blur). A web-page renderer cannot produce it, and Blitz's gaps are exactly the motion-design
  features (see RESEARCH.md §2). CSS compatibility is a later, optional layer.
- **Not a Tauri webview as the renderer.** WKWebView (macOS) and WebKitGTK (Linux) have no CDP; `takeSnapshot` is
  slow, async and per-OS; no headless mode; output differs per OS; `<video>` seeking is unreliable. The UI is a
  browser page that only shows frames the addon rendered.
- **The UI is a local web server, like Remotion Studio, not a desktop app** (decided 2026-10-14, replacing the Tauri
  editor with a WASM + WebGPU preview). `npx kinetograph studio` starts a Node server and opens `localhost`; the addon
  renders the preview frames on the GPU and streams them to the page (half size while scrubbing, full size when
  paused), and esbuild watches the TSX and reloads the composition on save. Why: the preview is the render, drawn by
  the same binary, so they match pixel for pixel with nothing to keep in sync; ffmpeg, fonts and Lottie work as in
  `render` (a WASM build would need WebCodecs and web ports of each); nothing to package or sign; and it works over
  SSH from a machine with a GPU. Cost: scrubbing waits on the server, which on a laptop is local. Full-size frames
  take ~40 ms on the M4 (2c), so ~25 fps; draft speed is unmeasured. A WASM preview stays possible later (WGSL runs
  in browsers through WebGPU) for hosting without a GPU server, and Tauri can wrap the same UI if a desktop app is
  ever wanted.
- **Studio UI stack** (decided 2026-10-14): React + Vite, styled only with Tailwind CSS utilities, and built from
  shadcn/ui components (default style, zinc base colour, dark theme: the zinc-950 background shadcn ships). Use a
  shadcn component wherever one fits (buttons, sliders, tabs, dialogs, menus, resizable panels, scroll areas,
  tooltips) and keep its defaults; no other component library and no hand-written CSS files. The timeline and the
  preview canvas are the only custom components, and they are styled with Tailwind too.
- **wgpu + Vello + WGSL, not Skia.** WGSL runs natively through wgpu and in the browser through WebGPU, so a later
  in-browser preview could share the shaders and match the native render pixel for pixel. Skia (skia-safe native,
  CanvasKit on the web) is the more mature fallback if Vello's text or filter quality falls short.
- **Stand on existing crates; write only the glue.** Text shaping, line breaking, bidi and font fallback must not be
  hand-written. Most bugs will live in text and layout edge cases; treat them as test-and-fix work.
- **Scene graph is the source of truth**, so agents query it (`inspect`) instead of looking at pixels.
- **Lottie through ThorVG (LottieFiles' `dotlottie-rs`), not velato** (decided 2026-10-14). Kinetograph is a
  general-purpose agentic editor, so agents will use arbitrary files from LottieFiles and After Effects exports.
  velato (Linebender, draws through Vello) lacks split positions and rotations (After Effects "Separate
  Dimensions", very common), text layers, embedded images, stroke dash, correct gradient stops and most layer
  effects. dotlottie-rs is the format owner's own player: MIT, active (v0.1.58, 2026-06), with ThorVG features for
  expressions, text (TTF/OTF) and embedded PNG/JPG/WebP. Its crates.io release is a stale 2024 alpha, so depend on a
  pinned git tag. It builds ThorVG (C++) from a submodule, so a C++ toolchain is needed. ThorVG's CPU renderer
  fills a pixel buffer that we upload as a texture; its own WebGPU engine (`tvg-wg`) can't share our wgpu device.
  Determinism: animation time comes from the frame number, and any randomness in expressions must be seeded.
  Before relying on it, measure coverage: a few hundred popular LottieFiles animations rendered through it and
  compared with lottie-web.
- **Real 3D: real Three.js first, kiss3d as backup** (revised 2026-10-14 with the Node decision; superseded
  2026-10-15: Three.js compatibility is dropped for now and the engine gets its own 3D layer, see "3D layer" in §8).
  With Node as host,
  Three.js can run as written: its `WebGPURenderer` on the `webgpu` npm package (Dawn, Google's WebGPU
  implementation, 0.6.2 released 2026-10-02), rendering offscreen to a texture that becomes a compositor layer.
  That is coverage-first by definition: react-three-fiber, drei and `@remotion/three` code runs unchanged.
  Limits: `WebGPURenderer` does not run GLSL `ShaderMaterial`/`RawShaderMaterial` (WebGL only); TSL and WGSL
  shaders work. Unverified: no documented recipe for Three.js headless on Dawn in Node was found; forum reports
  show blank output, and `WebGPURenderer` silently falls back to WebGL2 when no adapter exists, so the spike must
  assert the backend. Pixels cross from Dawn to the Rust addon through a CPU readback (~2 ms at 1080x1920 by the
  Phase 1 readback number) unless the two can share a device. Determinism: Three's clock and any `Math.random`
  come from the frame shim. Backup if the spike fails: kiss3d 0.47 (dimforge, wgpu 30 like Vello, accepts an
  external device via `Context::init`) with the reconciler mapping the r3f vocabulary onto it. Checked in its
  source: scene graph, box/sphere/cylinder/cone/capsule/plane/custom meshes, metallic-roughness PBR, transmission,
  point/directional/spot lights (max 8), shadows, perspective and orthographic cameras, glTF with animation,
  skinning and morph targets, bloom, DOF, SSAO, FXAA, tone mapping; missing and cheap to add ourselves: Torus,
  TorusKnot, Ring, polyhedra, Lathe, Tube, Extrude generators; auto-exposure and raytracer accumulation must be
  off. Rejected: `three` crate (dead since 2019, gfx/OpenGL), three-d (OpenGL, can't share wgpu textures), Bevy
  (a whole game engine). First step either way: a one-day spike rendering a glTF model and a code-built torus
  knot headless, plus a count of how many r3f / `@remotion/three` examples render unchanged.

## 5. Authoring API sketch (not final)

```tsx
export const Card = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14 } });
  return (
    <Layer z={interpolate(frame, [0, 30], [-400, 0])} rotateY={(1 - s) * 25}
           effects={[motionBlur({ samples: 8 }), dropShadow({ y: 12, blur: 24 })]}>
      <Image src={staticFile('model.jpg')} fit="cover" />
      <Text font="Inter" size={64} fill={linearGradient(['#f9a', '#fc6'])}>gets better</Text>
    </Layer>
  );
};
```

Native elements: `<Layer>`, `<Shape>`/`<Path>`, `<Text>`, `<Image>`, `<Video>`, `<Svg>`, `<Lottie>`, `<Camera>`,
`<Audio>`. Flexbox props on containers. Effects as an ordered array. Shape the API like SVG, Canvas 2D and CSS
property names so models write it without a skill.

Remotion packages beyond the core API. "Shim" means reimplemented in the TS layer from Remotion's documented
behaviour on top of engine primitives; "fallback" means compat mode renders it through Chrome.

| Package | Plan | Needs from the engine | Phase |
|---|---|---|---|
| `remotion` core (`Sequence`, `Series`, `Loop`, `interpolate`, `spring`, …) | shim | frame clock, layer visibility | 3 |
| `@remotion/transitions` (fade, slide, wipe, flip, iris, clockWipe) | shim | opacity, transforms, clip paths | 3 |
| `@remotion/motion-blur` (`Trail`, `CameraMotionBlur`) | shim | sub-frame motion blur | 3 |
| `@remotion/noise`, `paths`, `shapes`, `layout-utils`, `animation-utils` | shim (pure JS/TS) | path and shape layers | 3 |
| `@remotion/google-fonts` | shim | font registration | 3 |
| `@remotion/lottie` | native `<Lottie>` via ThorVG (dotlottie-rs, section 4) | texture layer | 3 |
| `@remotion/gif`, `<Video>`, `<OffthreadVideo>` | native | ffmpeg decode | 4 |
| `@remotion/three` | dropped for now (2026-10-15): `doctor` reports it; the engine's own 3D layer replaces it (§8, "3D layer") | 3D layer | deferred |
| `@remotion/captions` | shim | per-glyph text | 3 |
| Anything else (arbitrary HTML/CSS) | fallback | `doctor` | 5 |

Audio:

```ts
onFrame(42, (ctx, t) => {            // ctx is a Web Audio OfflineAudioContext slice
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.frequency.setValueAtTime(3000, t); o.frequency.exponentialRampToValueAtTime(4500, t + 0.055);
  g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.06);
});
```

The user's pipeline already has 79 synthesised SFX in
`$KINETOGRAPH_CORPUS/lib/audio/sfx/*.js` (e.g. `birds.js` uses a
`K.tone(freq, t, dur, {g, f2})` helper). They are the first real test corpus for the synth.

## 6. Effects the engine must ship

From the reference video (RESEARCH.md §3) and the papercut kit audit (RESEARCH.md §2):

| Effect | Needed by |
|---|---|
| Gaussian blur (position-stable; dual Kawase was tried and snapped small layers to a grid), backdrop blur (frosted glass) | reference, papercut `RackFocus` |
| Drop shadow, inset shadow | papercut (21 drop-shadow, 47 box-shadow uses) |
| Blend modes: multiply, screen, soft-light, plus the rest | papercut grain on every frame, reference |
| Gradient map / LUT, cross-fade between graded and real | reference thermal look |
| Halftone, ordered/random dither, dot-matrix reveal | reference clouds and portrait |
| Turbulence + displacement (torn/rough paper edges) | papercut `url(#torn)`, `url(#rough)`; fixed seeds 7 and 11 |
| Colour: saturate, contrast, brightness, grayscale, sepia | papercut (~16 uses) |
| Masks (gradient), track mattes, clip paths (polygon, inset, path, ellipse) | papercut (91 clip-path uses), reference |
| Linear, radial, conic, repeating gradients; animated mesh gradient | both |
| Grain, noise, glow, chromatic aberration | both |
| 2.5D camera: perspective, rotateX/Y, translateZ, depth sort | reference card stacks, papercut `OrbitCamera` |
| Corner-pin (perspective quad warp) | reference |
| Motion blur (sub-frame accumulation) | reference whip transitions |
| Per-glyph text animation, gradient text fill, inline images in text, typing cursor | reference |
| Custom effects: a user-written WGSL fragment shader gets the layer texture, frame, time and uniforms | anything not in this table (fframes has SkSL/Shadertoy layers) |

## 7. Agent surface

CLI first (`npx kinetograph …`, TS, calling the addon), MCP server wrapping the same commands. Every command takes `--json`.

| Command | Output |
|---|---|
| `still <comp> <frame>` | PNG |
| `strip <comp> -n 12` | labelled contact sheet |
| `onion <range> -n 6` | blended frames showing a motion path |
| `inspect <comp> [--frame N]` | scene graph as JSON: layers, bounds, resolved styles |
| `lint` | text overflow, off-canvas layers, overlaps, missing fonts/assets, with frame and layer |
| `render [--range a..b] [--draft]` | video; draft = half size, fast |
| `audio analyze` | LUFS, true peak, clipping, silence per scene |
| `snapshot` | diff against approved PNGs |
| `effects` | list of effects and their parameters |
| `doctor` | compat-mode report: what fell back to Chrome and why |
| `bench` | ms/frame per stage (JS, layout, raster, readback, encode) |
| `studio` | local web server and browser UI: preview, timeline, props, render queue (Phase 4) |

Ship an agent skill alongside (fframes does `npx skills add https://fframes.studio`).

## 8. Roadmap

**Phase 0: validate before building (do this first).**
1. Install fframes, add its skill, and have an agent rebuild 5 seconds of `docs/reference/rajz-reference.mp4` (pick the
   3D card stack + "you … create" segment, ~21–25 s) and one papercut scene (ep 13 S04, see RESEARCH.md §2).
   Record iterations, tokens, wall time, and where it hit walls (3D layers, motion blur, blend modes, synth).
2. Read fframes' `render_frame` path and backends. Decide: build the TS layer on top of fframes, or own the engine.
   **Decided 2026-10-14: own the engine (see §3).**
3. Benchmark baseline: time the user's Remotion render of the same papercut scene (ms/frame, total) with
   `lib/tools/render.sh` in the papercut project.

**Phase 1: core.** Rust workspace; compositor with image/text/shape layers, blur, blend modes; PNG output; CLI `still`.
**Done 2026-10-14.** `still` and `bench` work; papercut-card example at 1080x1920 renders in ~46 ms warm (release, M4, frame 30).
**Phase 2: effects.** Every row of section 6 except the per-glyph text items, which need the authoring API. Split in
two so each half is reviewable:
- **2a: compositing basics** (what papercut and transitions lean on most). Masks and clip paths first (polygon,
  inset, ellipse, path; gradient masks; track mattes), then drop and inset shadow, colour filters (saturate,
  contrast, brightness, grayscale, sepia), linear/radial/conic/repeating gradients as fills for shapes and text,
  backdrop blur, glow, chromatic aberration, custom WGSL effects. **Done 2026-10-14** (PR #2, merged): tests and
  goldens pass on the M4.
- **2b: looks, camera and video.** Gradient map / LUT, halftone, dither, dot-matrix reveal, turbulence +
  displacement (seeded), grain and noise, animated mesh gradient, corner-pin, 2.5D camera (perspective,
  rotateX/Y, translateZ, depth sort), motion blur, ffmpeg encode (`render`). **Done 2026-10-14** (PR #3, merged):
  tests and goldens pass on the M4.
- **2c: performance.** **Done 2026-10-14** (PR #4, with #5 stacked on it and merged in): tested and benched on the
  M4. Every pixel is within 2 levels of 2b's goldens, and two runs give byte-identical frames. Kept:
  - Effect passes scissored to the layer's bounds plus each effect's reach; layer textures sized to that box and
    pooled by size class; closed-form (erf) drop shadows for a `rect`, `roundedRect` or `ellipse` when the shadow is
    the first effect; bilinear blur taps; a layer cache for layers that did not change since the previous frame
    (`render` and `bench --range`); motion-blur sub-frames rasterised at the moving layer's bounds; groups that need no
    buffer drawn straight into their parent.
  - From #5: the leaves that do not overlap are drawn in one Vello render per "page" and cut out of it; all compositor
    passes go into one command encoder per submit; uniforms packed into shared buffers; `render` starts frame N+1
    before it reads frame N back. Output byte-identical to 2c before it.
  - Rejected: 8x MSAA changed edges by up to 168 levels and saved under 1 ms per frame (§10); blurring shadows at
    lower resolution gained nothing measurable once closed-form shadows drew most of them.
  - Numbers on the M4: diorama `render` 294 (2b) → 36.5 ms/frame. The ep 13 S04Meter papercut scene, hand-ported to
    scene JSON (89 frames, 1080x1920): 3.95–4.14 s for the whole `render`, ~40 ms/frame, against 16.1–16.8 s in
    Remotion 4.0.530 (with `--concurrency` 1 or 5): **about 4.1x**. 200 small rects without effects: 167 → 40 ms.
  - Not yet at Phase 3's 5x on that scene: 16.3 s / 5 = 3.26 s, so ~32 ms/frame after ~0.45 s of GPU setup. Next,
    all byte-identical: cut out a whole page in one pass, merge consecutive blends of layers that do not overlap,
    closed-form inset shadows for rect shapes. These need the M4 to measure, so they are not cloud work.
  - **Corrected 2026-10-15: the GPU is the limit, not the CPU.** Splitting S04 across 2 processes takes as long as 1
    (2.91 vs 2.92 s), and 3–4 take longer. `bench --passes` on S04 (89 frames): ~278 passes a frame, and a pass costs
    ~140–300 µs of GPU time whatever its size (a `blend` averages 0.16 Mtexels and 200 µs), so the cost is per pass, not
    per pixel. By kind: `blend` 82 passes and 16.7 ms, `to linear` 83 and 15.5 ms, the blur steps 5.1 + 2.5 ms,
    `shadow spread` 27 and 4.0 ms, `inset shadow` 27 and 3.6 ms, `displace` 8.5 and 2.1 ms. Fewer passes is the lever.
    Re-time Remotion in the same session as Kinetograph: Low Power Mode or battery changes both, by different amounts
    (S04 in Remotion 16.1–16.8 s with it on, 9.2–9.5 s off; Kinetograph ~4.3 and ~2.9 s).
  - **Fewer passes, done 2026-10-15 (stream 5, `perf/gpu-passes`, all byte-identical).** S04 went from 278 passes a
    frame to 113, and from 2.68–2.92 s for the whole `render` to **1.25–1.28 s** (min and median of 4 rounds,
    load 3–6), against Remotion 8.86 s min and 8.96 s median timed in the same rounds: **7.0–7.1x** (the 5x bar of Phase 3
    is met).
    The decoded frames of the two renders are identical (89 frame md5s). Per stage, `frame_hashes --times` ms a frame
    (min / median of 5, interleaved, load 8–16 from other jobs): before 25.8 / 26.9; inset shadow with no blur or spread
    in one pass 24.7 / 25.7; a leaf is cut out of its Vello page when it is wanted 21.7 / 22.7; runs of blends in one
    pass (`blend_many`) 17.8 / 18.1; pages drawn only as far as their leaves reach and packed by colouring 17.0 / 17.1;
    a leaf with a sharp inset shadow cut out in the same pass 15.9 / 17.4; Vello's dispatches in one compute pass
    12.2 / 13.3; a plain leaf blended straight from its page 11.4 / 11.8. Every one of them is byte-identical to the
    build before it on all 34 test scenes, S04's 89 frames included. Details, what was rejected and what is next: ENGINE.md
    §11.
**Phase 3: authoring + agents.** The N-API addon (napi-rs) exposing the Rust core; the `@kinetograph/core` TS
package: Remotion shim, `react-reconciler` host config emitting the scene graph, determinism shim; Web Audio via
`node-web-audio-api`; the `kinetograph` CLI in TS and the MCP server; the Remotion package table in section 5;
per-glyph text animation. Open with two spikes: (1) the addon handoff cost per frame in `bench`; (2) Three.js
`WebGPURenderer` headless on Dawn in Node (section 4), which decides Three.js vs kiss3d for the 3D layer.
Rebuild the 5-second reference and the papercut scene. Compare frames and timing against Remotion. Go/no-go here:
if it isn't clearly faster (5x+) and visually matching, rethink the wedge.
**Built 2026-10-14 in one cloud session** (draft PR from `feat/node-authoring`, the five stream branches merged into it
and kept): the contract is `docs/AUTHORING.md`; the TSX rebuild of the reference segment is `examples/rajz-cards/`. CPU
checks green; nothing has rendered on a GPU yet. On the M4: the seven new goldens, the addon's GPU tests, spike 1
(`crates/node/spike/handoff.mjs`), spike 2 (`spikes/three-dawn`), the reference rebuild, then the papercut port and
the go/no-go timing.
**Tested on the M4 and merged into `main` 2026-10-15** (PR #11). Fixed on the branch: a ThorVG use-after-free across threads (the
Lottie tests crashed about half the runs), transform origins measured from the box's top-left corner, the seven new
goldens. `cargo test` and the GPU npm tests pass except `renderer_reuse` (#12).
- Spike 1: handoff 0.58 ms a frame on the papercut card, 1.6–2.9 ms on the S04 port. Spike 2: Three.js
  `WebGPURenderer` runs on Dawn (Metal), ~0.44 ms a frame at 512², 1.3–1.4 ms with readback. Three.js it is.
- Go/no-go: the S04Meter TSX port matches the JSON port byte for byte on all 89 frames. Timed back to back with
  Remotion on battery, Low Power Mode off (the earlier 3.6–4.5x had Low Power Mode on, which slows Remotion more):
  Remotion 9.2–9.5 s, the JSON port 2.72–2.74 s (3.4–3.5x), the TSX port 2.86–2.92 s (3.2–3.3x). Below the 5x bar,
  accepted for now (decided 2026-10-15); fewer GPU passes is the next lever. No `bench` regression against `main`.
- The reference rebuild works but is slow (429 ms a frame) and matches loosely (#17).
- Merge blockers #12–#15, fixed in the cloud (see "Phase 3 fixes in a cloud session") and tested on the M4 as PRs
  #18–#21 before #11 merged. Open: #16 (`kinetograph check`), #17.
**3D layer (after Phase 3).** Decided 2026-10-15: the engine gets its own 3D, and Three.js compatibility
(`@remotion/three`, react-three-fiber, drei, pixi) is dropped for now. Spike 2 showed Three.js runs on Dawn, but
running it means a second GPU API in the process, a pixel readback per frame and a browser library's behaviour to
match; our own layer is native, shares the wgpu device and stays a pure function of the frame.
- A `3d` scene layer drawn in Rust on the compositor's wgpu device, no readback. kiss3d 0.47 (section 4) is the
  starting point to evaluate; its feature list (meshes, metallic-roughness PBR, lights, shadows, glTF) is the scope.
- Authoring: our own components (`<Scene3D>`, `<Mesh>`, primitives, `<Model src="x.glb">`, lights, a camera), not
  the Three.js API. Their names may follow react-three-fiber's where that costs nothing, so agents guess right.
- Extruded text and SVG paths as meshes, since the motion-graphics use is mostly 3D type and logos.
- Projects that import `three` or `@remotion/three` are reported by `doctor`; nothing falls back to Chrome.
**Phase 4: studio.** `kinetograph studio` (section 4): a local web server and browser UI in React, Tailwind CSS and
shadcn/ui (zinc, dark). Composition list, preview streamed from the addon with play, scrub and frame step, timeline
of sequences and layers, scene tree from `inspect`, props panel, render queue calling `render`, hot reload on save.
Plus video layers (`<Video>`, `<OffthreadVideo>`, `@remotion/gif`, section 5).
**Built 2026-10-15 in one cloud session** (draft PR from `feat/studio-video`, the four stream branches merged into it
and kept): the contract is `docs/AUTHORING.md` §11, SCENE.md's `video` and `gif`, and `packages/studio/src/protocol.ts`;
the example is `examples/video-overlay/`. CPU checks green; nothing has rendered on a GPU yet. On the M4: the list in
"Phase 4 in a cloud session" below.
**Phase 5: Remotion compat mode.** CSS subset mapped onto layers (possibly via Blitz/Stylo), Chrome fallback per frame
range, `doctor`.
**Built 2026-10-15 in the same cloud session** (draft PR from `feat/remotion-compat` against `feat/studio-video`, the
four stream branches merged into it and kept): the contract is `docs/COMPAT.md`; the example is `examples/compat/`,
where `doctor` reports 126 of 150 frames native and one Chrome run (96..119, the `textDecoration` it uses on purpose).
CPU checks green, plus a Chromium-on-CPU integration test of the fallback; nothing has rendered on a GPU yet. On the
M4: the list in "Phase 5 in the same cloud session" below.

**Building a phase in a Claude Code cloud session** (Phase 2 onwards). The cloud session writes code; all testing
happens on the user's M4.
- In the cloud, run only what needs no GPU: `cargo build`, `cargo fmt --check`, `cargo clippy --all-targets -- -D
  warnings`, `cargo test --lib` (unit tests are CPU-only). Do not run the integration tests in
  `crates/core/tests/`, `still` or `bench`, and never set `UPDATE_GOLDEN`.
- For every new effect, still write the test scene (`crates/core/tests/scenes/`) and the golden or pixel test. The
  golden PNG is generated on the M4 after a visual check, not in the cloud.
- Commit per logical change and push the branch. On the M4: pull, `cargo test`, render and look at each new
  scene, `UPDATE_GOLDEN=1` for new goldens, `bench` for any speed claim.
- Install ffmpeg (dev libraries) in the cloud environment before the encode work; compiling against it needs no GPU.
- The repo will be public. Name branches after the work, not the phase (`feat/compositing-effects` was Phase 2a,
  `feat/looks-camera-video` is 2b); the phase goes in the PR title. Keep session links and `Claude-Session:`
  trailers out of commit messages and PR descriptions. Renaming a branch on GitHub closes its open PR rather than
  moving it (PR #1 for 2a), so pick the name before opening the PR.
- **2b and 2c run back to back in one cloud session, and neither merges before the M4 tests them** (decided
  2026-10-14). 2b goes on `feat/looks-camera-video`. 2c goes on `perf/layer-bounds`, branched from 2b's tip, not from
  `main`, with one commit per work item (blur, MSAA, texture sizing, layer cache, frame-range render) so any item that
  does not pay off can be reverted alone. Open both as draft PRs: 2b against `main`, 2c against
  `feat/looks-camera-video`, so each diff shows only its own phase.
- On the M4, test 2b at its own tip first: `cargo test`, look at each new scene, `UPDATE_GOLDEN=1`, then a `bench`
  baseline on the papercut diorama. Only then go through 2c commit by commit, with `bench` and the goldens after each.
  2b's goldens must come from 2b's code, so a 2c regression shows up as a golden failure instead of being recorded
  as correct. Fixes to 2b go on its branch and are merged into the 2c branch. Merge 2b into `main` first, then change
  the 2c PR's base to `main` by hand.
- **Keep each phase's branch after it merges** (decided 2026-10-14): never delete on merge, so every phase stays
  checkable at its own tip. 2b merged as PR #3 on 2026-10-14; `perf/layer-bounds` merges `main` before 2c resumes and
  opens its PR against `main`.

**Phase 3 in a cloud session** (decided 2026-10-14). One Opus 5.5 orchestrator at high effort with five Sonnet 5.5
subagents at high effort, started with the Agent tool as ordinary subagents (not a Workflow). The cloud rules above
still hold, plus:
- Install Node 22+ and a C++ toolchain (dotlottie-rs builds ThorVG) as well as the ffmpeg dev libraries. The CPU-only
  checks add `npm ci`, `npm run build` and `npm test` for the TS packages. The addon may be loaded in Node, but
  nothing in the cloud calls a function that opens a GPU device.
- The orchestrator goes first: it branches `feat/node-authoring` from `main` and commits the scaffolding (npm
  workspaces under `packages/`, a napi-rs crate `crates/node`) and `docs/AUTHORING.md`, the contract the five streams
  build against: package names and layout, the addon's JS API (signatures and errors), and how each element and effect
  helper maps to `docs/SCENE.md` JSON. Then it pushes and starts the five subagents.
- Each subagent works in its own git worktree, on its own branch cut from that commit, and opens a draft PR against
  `feat/node-authoring`. Streams that need another stream's API stub it from the contract rather than wait.
  1. `feat/napi-addon`: `crates/node`. A `Renderer` with one GPU setup; `still(scene, frame)` returning a PNG
     `Buffer`; `render(scene, range, output)` through the existing encoder; `bench`; `inspect` (the resolved scene as
     JSON). Scenes go in as JSON strings; pixels stay in Rust. A `bench` stage for the handoff cost (spike 1, run on
     the M4).
  2. `feat/remotion-shim`: `packages/core`. The frame clock and Remotion core API (`useCurrentFrame`,
     `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`, `Easing`, `random`, `Sequence`, `Series`, `Loop`,
     `Freeze`, `AbsoluteFill`, `staticFile`, `delayRender`), the determinism shim (`Date`, `Math.random`,
     `performance.now`, timers and `requestAnimationFrame` driven by the frame), and the pure-TS packages of §5
     (transitions, motion-blur, noise, paths, shapes, layout-utils, animation-utils, captions, google-fonts), written
     from Remotion's documented behaviour (§9). Unit tests, including `random`'s exact values for the seeds the
     papercut kit uses.
  3. `feat/reconciler`: the `react-reconciler` host config and the native elements of §5, emitting SCENE.md JSON per
     frame; TS types for the whole scene schema and the effect helpers; snapshot tests of the emitted JSON.
  4. `feat/layout-glyphs`: Rust core. taffy flexbox layout for container layers; per-glyph text animation (glyph
     positions exposed, per-glyph transform, opacity and fill); `<Lottie>` through dotlottie-rs at a pinned git tag
     (§4). Test scenes and golden entries; the goldens are made on the M4.
  5. `feat/cli-audio-mcp`: the TS CLI (`npx kinetograph`, the §7 commands, calling the addon), the MCP server wrapping
     it, and Web Audio through `node-web-audio-api` (`onFrame`, an `OfflineAudioContext` render, muxed into the
     `render` output; `audio analyze`). Plus spike 2: a script that renders a glTF model and a torus knot with Three.js
     `WebGPURenderer` headless on Dawn in Node and asserts the backend is WebGPU, run on the M4.
- The orchestrator reviews each stream PR, runs the CPU checks on it, merges it into `feat/node-authoring` and resolves
  conflicts. Then it writes a TSX rebuild of the 5-second reference segment (`docs/reference/`, ~21–25 s) under
  `examples/`, for rendering and comparison on the M4, and opens `feat/node-authoring` as a draft PR against `main`
  titled Phase 3. The TSX port of ep 13 S04Meter is done on the M4, where the papercut source is.
  Nothing merges into `main` before the M4 tests it. The stream branches are kept after they merge.

**Phase 3 fixes in a cloud session** (decided 2026-10-15). The four merge blockers found on the M4, each on its own
branch with a draft PR against `feat/node-authoring` (PR #11). The cloud rules above hold; nothing merges, and
`main` is not touched. PR titles start "Phase 3 fix:" and the body says "Fixes #N".
- **#12 `fix/image-atlas-offset`.** Vello 0.11 keeps an image atlas across renders, and `fine.wgsl` adds the atlas
  offset before splitting the sample position into texel and fraction (`atlas_uv = atlas_uv + image.atlas_offset`,
  around lines 1328 and 1347), so image and Lottie pixels move by a level with what the renderer drew before. Vendor
  `vello_shaders` 0.11.0 under `vendor/vello_shaders`, wire it with `[patch.crates-io]`, and take the floor and
  fraction of the image-local position before adding the integer offset. Smallest possible shader diff; a README in
  `vendor/` names the upstream file, version and change so it can be offered upstream. Tests: `renderer_reuse` must
  pass, plus a new one that renders `tests/scenes/lottie.json` frames 0–59 in order on one `Renderer` and checks each
  against `render_still`. Image goldens may move by a level; the M4 looks and regenerates.
- **#13 `fix/displace-margin`.** Make `displace` independent of the margin (SCENE.md says its noise is in layer
  space), with a GPU test that renders one displace scene at two margins and asserts identical pixels. Then stop the
  margin changing per frame in TSX renders, so textures are not rebuilt: an explicit `margin` on `<Composition>` and
  in the scene JSON, or another design that does not depend on frame order (a renderer keeping "the largest margin so
  far" does, unless pixels are proven margin-independent). Justify the choice in the PR; update SCENE.md and
  AUTHORING.md.
- **#14 `feat/composition-background`**, branched from `fix/displace-margin` with its PR against that branch (same
  `<Composition>` props and `frame-loop.tsx`). A `background` colour prop on `<Composition>` passed into every frame's
  scene in place of the hard-coded `'transparent'` in `packages/core/src/frame-loop.tsx`; default transparent;
  documented in AUTHORING §7; a unit test on the emitted JSON.
- **#15 `fix/lint-visibility`.** In `packages/cli/src/lint.ts`, skip a layer for a frame when its opacity times its
  ancestors' is 0, and for off-canvas checks when a clip hides it. CLI tests: text past the edge at `opacity={0}`, the
  same inside a group at opacity 0 (no finding), and at opacity 1 (finding). Update `packages/cli/skill/SKILL.md` if
  it describes lint's output.
- When done: push every branch, open the four draft PRs, and report the PR links, each CPU check's result, what the
  M4 must run per PR (test targets, scenes to look at, goldens that may need `UPDATE_GOLDEN=1`, any `bench`), and
  any decision the issue left open, especially #13's margin design. On the M4, #12 is tested first since it can
  move image goldens; then #13 and #14 together, then #15. Merge the fixes into `feat/node-authoring`, then #11 into
  `main`.

**Phase 4 in a cloud session** (decided 2026-10-15). Phases 4 and 5 run back to back in one cloud session (Phase 5
below); the GPU-pass performance work waits until after both, on the M4.
Same shape as Phase 3: one Opus 5.5 orchestrator at high effort and four Sonnet 5.5 subagents at high effort, started
with the Agent tool (not a Workflow), each in its own git worktree. The cloud rules above hold: code and CPU checks
only (`cargo build`, `fmt --check`, `clippy --all-targets -D warnings`, `cargo test --lib`, `npm ci`, `npm run build`,
`npm test`); no integration tests in `crates/core/tests/`, `still`, `render`, `bench` or `UPDATE_GOLDEN`; nothing
opens a GPU device. Install Node 22+, a C++ toolchain and the ffmpeg dev libraries (the decoder links them).
- The orchestrator goes first: branches `feat/studio-video` from `main`, and commits the contract the streams build
  against:
  - `docs/SCENE.md`: the `video` and `gif` layer types (fields, defaults, errors).
  - `docs/AUTHORING.md`: the `<Video>`, `<OffthreadVideo>` and `<Gif>` props and their mapping to that JSON; the
    addon's new functions; and the studio server's HTTP and WebSocket API (routes, message shapes, errors).
  - The `packages/studio` workspace skeleton.

  Then it pushes and starts the four subagents. Each cuts its branch from that commit and opens a draft PR against
  `feat/studio-video`. A stream that needs another stream's API stubs it from the contract.
  1. `feat/video-layers` (Rust core). The `video` layer: frames decoded with `ffmpeg-next` (already a dependency
     of the CLI), the source time from the layer's frame, `trimBefore`, `trimAfter`, `playbackRate` and `loop`, and
     the frame shown being the last one whose timestamp is at or before that time. Frames are uploaded like an
     image (same `fit` rules).
     - Purity: a frame's pixels must not depend on what was decoded before. Keep a decoder per source that
       decodes forward and seeks on a jump back or a big jump forward. Add a test that renders frames out of
       order and in order and gets the same bytes.
     - The `gif` layer: the `image` crate's GIF decoder, with the frame picked from the summed frame delays.
     - Test clips: generated with ffmpeg's `testsrc` and kept tiny. No real footage, because the repo is public.
     - Test scenes and golden entries; the goldens are made on the M4.
  2. `feat/video-elements` (TS):
     - `<Video>`, `<OffthreadVideo>` (the same element here), and `<Gif>` as the `@remotion/gif` subpath, written
       from Remotion's documented props.
     - `getVideoMetadata` through the addon (an ffprobe-like call: duration, fps, size).
     - A video's audio track: mixed into the `render` output by `packages/audio`, honouring `volume`, `muted`, the
       trims and `playbackRate`.
     - Snapshot tests of the emitted JSON.
  3. `feat/studio-server` (`packages/studio` server, CLI and addon):
     - `kinetograph studio <entry>` starts a Node server on localhost and opens the browser.
     - esbuild watches the entry and pushes a reload over the WebSocket on save.
     - Preview frames come from the addon: a new addon call returns JPEG or PNG at a `scale`, downsampled from
       the full render so the pixels are the render's. Half size while scrubbing, full size when paused.
     - Routes for the composition list, the scene tree (`inspect`) and timeline data. The reconciler records each
       `Sequence` and `Series` item's name, `from` and duration in the frame loop's output.
     - A render queue that runs `render` jobs and streams their progress.
  4. `feat/studio-ui` (`packages/studio/ui`): React + Vite, Tailwind only, shadcn/ui (default style, zinc, dark;
     §4 "Studio UI stack").
     - Panels: the composition list; the preview canvas; transport controls (play, pause, frame step, scrub, loop,
       fps readout); the timeline of sequences and layers; the scene tree; the props panel (edit the composition's
       `defaultProps`, re-rendering the preview); and the render queue.
     - Built against the contract with a mock server until stream 3 lands. Component tests with vitest and
       Testing Library.
- The orchestrator reviews each PR, runs the CPU checks, and merges it into `feat/studio-video`, resolving
  conflicts.
  - Then it adds `examples/video-overlay/`: a generated clip with captions, a lower third and a `<Gif>`, for
    rendering and comparison on the M4.
  - Then it opens `feat/studio-video` as a draft PR against `main`, titled Phase 4.
  - Nothing merges into `main` before the M4 tests it. Stream branches are kept.
- On the M4:
  - `cargo test`; the npm GPU tests; look at the new scenes, then `UPDATE_GOLDEN=1`.
  - The out-of-order video test.
  - Run `kinetograph studio` on `examples/rajz-cards` and the S04 port, driven in a browser.
  - Time a footage-heavy scene against Remotion with the same clip, since this is where the speed gain should be
    smallest.

**Phase 5 in the same cloud session** (decided 2026-10-15): Remotion compat mode, so an unported Remotion project
renders without a hand port. It runs after Phase 4's four streams are merged, the way 2c followed 2b.
- Branch: `feat/remotion-compat`, cut from the tip of `feat/studio-video`, with a draft PR against
  `feat/studio-video` so the diff shows only Phase 5. Neither phase merges before the M4 tests it. Phase 4 is
  tested first, and fixes to it are merged into the Phase 5 branch.
- Scope comes from the first real corpus, the papercut kit (38 `.tsx` files). It uses inline `style` objects only
  (no `className`, no stylesheets), about 500 `<div>`s, `AbsoluteFill`, `<span>`, `<svg>` and `<path>`, `Img` and
  one `OffthreadVideo`. The CSS properties that need work: `filter`, `transform`, `clipPath`, `boxShadow`,
  `mixBlendMode` and `backgroundImage`, then `maskImage`/`WebkitMaskImage`, `textShadow` and `perspective`.
  Inline styles and SVG come first; `className` and stylesheets (Tailwind) are out of scope for this pass.
- Decided: the mapping is done in TS, onto the layers the engine already has, with taffy (§4.1 of AUTHORING) for
  flexbox and absolute positioning. No Blitz/Stylo for now; revisit it only if the subset falls short on real
  projects.
- The orchestrator goes first again. It commits the contract in `docs/COMPAT.md`:
  - which elements and CSS properties map to which SCENE.md layers and effects;
  - what counts as unsupported;
  - the fallback rule.

  Then it starts four Sonnet 5.5 subagents at high effort, one worktree each, with draft PRs against
  `feat/remotion-compat`.
  1. `feat/compat-css` (TS, pure functions with unit tests): parse inline style values into layer props.
     - Colours, lengths (px, %, em), `transform` lists, `boxShadow` lists (drop and inset), `filter` lists (blur,
       drop-shadow, brightness, contrast, saturate, hue-rotate, grayscale, sepia, invert, opacity).
     - `mixBlendMode`, `clipPath` (inset, circle, ellipse, polygon, path), and `backgroundImage` (linear,
       radial and conic gradients, `url()`).
     - `maskImage`, `opacity`, `borderRadius`, `border`, `overflow`, and the text properties.
     - Anything it cannot map is reported, not dropped silently.
  2. `feat/compat-dom` (TS): the reconciler accepts DOM host elements: `div`, `span`, `p`, `h1`–`h6`, `img`,
     `svg` and its children, and `video` (mapped to Phase 4's video layer).
     - It lays them out with flex layers and absolute positioning, as Chrome would for these styles, using stream 1
       for the values.
     - SVG is turned into path layers (`usvg` in Rust if parsing in TS falls short).
     - `@remotion` components that render DOM (`AbsoluteFill`, `Img`) work unchanged.
  3. `feat/chrome-fallback`: frames the native path cannot draw are rendered in headless Chrome.
     - Uses puppeteer-core with a pinned Chrome for Testing: a browser bundle of the project with React DOM and
       this repo's Remotion shim, the frame set through the frame clock, and a screenshot.
     - Written from the documented behaviour of Remotion's renderer, not its source (§9).
     - `render` splits the range into native and Chrome runs and feeds both to one encoder, in order. The rule is
       per frame, never per scene (§9).
     - Chrome may run in the cloud on the CPU for unit tests; its pixel comparisons happen on the M4.
  4. `feat/doctor`: `kinetograph doctor <entry>` (`--json` too).
     - Lists each unsupported element or property with the frame ranges it appears in and the share of frames
       that will render natively.
     - `--compare N` renders N sampled frames both ways and reports the pixel difference (run on the M4).
     - It is also wired into `lint` and the MCP server.
- The orchestrator merges the four, adds a Remotion-style example under `examples/compat/` written for the repo
  (none of the papercut source, which is private), and opens `feat/remotion-compat` as a draft PR titled Phase 5.
- On the M4:
  - The CPU and GPU tests.
  - `doctor` on the papercut ep 13 project.
  - Render S04 straight from its Remotion source in compat mode. Compare it with Remotion's output (`--compare`
    and a look at the frames) and with the hand port, then time all three back to back.

### Deferred: browser APIs the engine does not have yet (logged 2026-10-15)

Remotion projects work unchanged when their effects are CSS, SVG or plain JS. These do not, and `doctor` reports
them. Each is to be ported natively (no Chrome), one stream each, tested against Chrome as the oracle only.
1. **CSS gaps** (smallest). `line-clamp`: cut the shaped lines at N and add the ellipsis. Floats and tables: check
   whether a newer Blitz lays them out before writing our own (an upgrade also means redoing the fontique patch).
   `@container`: Stylo parses container queries; lay out once for the container sizes, restyle, lay out again. CSS
   transitions: a transition starts when a value changes, which depends on the previous frame; to stay a pure
   function of the frame, look back over the transition's duration for the frame the value changed and
   interpolate from there.
2. **Canvas 2D** (medium; the most common custom drawing in Remotion projects). A `CanvasRenderingContext2D` shim
   records each frame's calls (paths, fill/stroke, gradients, `drawImage`, `fillText`, transforms, clips,
   `globalAlpha`, `globalCompositeOperation`); Rust draws them as one canvas layer with Vello, whose model maps
   almost one to one. `getImageData`/`toDataURL` need pixels at once, so those draw on the CPU.
3. **WebGL fragment shaders** (shader transitions, Shadertoy ports): the slice of WebGL they use (one full-screen
   quad, uniforms, textures, `drawArrays`), with their GLSL ES translated to WGSL by naga and run as a `shader`
   pass. naga reads desktop GLSL, so GLSL ES 100 / 300 es probably needs a small rewrite step first.
4. **Three.js and pixi**: dropped for now, see "3D layer" above. If they come back, the path is a WebGPU API in Node
   on wgpu (`deno_webgpu`) so both run their WebGPU renderers unmodified, with GLSL materials through item 3.

User shaders today are `shader({ code, uniforms })` in WGSL (SCENE.md, "shader"). Its limits, also to lift later:
it sees only its own layer (no backdrop), runs one pass, samples no other texture, and takes only `f32` uniforms.

## 9. Rules for the build

- `random(seed)` must be bit-exact with Remotion's implementation (the papercut kit seeds all jitter with it), but
  reimplement Remotion APIs from their public behaviour. Remotion's licence restricts copying its source.
- Rendering is a pure function of (project, frame). Nothing reads the wall clock.
- Never measure text before fonts are registered (the papercut pipeline had a banner jitter bug from this).
- Speed claims are measured, never assumed. `bench` exists from Phase 1.
- Fallback must work per frame range, not per scene: transitions overlap two scenes.

## 10. Open questions

- 3D layer: kiss3d on the shared wgpu device, or our own renderer (§8, "3D layer"). Three.js is dropped for now.
- `react-reconciler` host config details: which React features (Suspense, context, portals) the scene graph needs.
- Vello's filter/text quality vs Skia. Test early with the papercut grain + torn edge.
- Licence for Kinetograph itself (MIT/Apache-2.0 matches the ecosystem; fframes is MIT).
- Blend space. The compositor blends in linear light (section 4). CSS, and so Remotion, blends in sRGB space, so
  `multiply`, `screen` and `softLight` will look different from a Remotion render of the same layers. Decide before
  Phase 3's comparison whether Remotion-compat needs an sRGB blend path.
- Anti-aliasing. Vello's analytic `Area` mode gave frames that differed by a level or two between runs (GPU thread
  timing changes the order coverage is summed in), so the renderer uses 16x MSAA, which is repeatable. Revisit if edge
  quality matters more than exact repeatability, or when Vello fixes the ordering. 8x MSAA was tried in 2c and
  rejected: it moved edge pixels by up to 168 levels and saved under 1 ms per frame.
- Final name.
