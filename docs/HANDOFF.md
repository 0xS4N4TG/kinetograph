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
        └── Tauri editor               preview; same core compiled to WASM + WebGPU in the webview
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
  slow, async and per-OS; no headless mode; output differs per OS; `<video>` seeking is unreliable. Tauri is only the
  editor shell.
- **wgpu + Vello + WGSL, not Skia.** WGSL runs natively through wgpu and in the browser through WebGPU, so the WASM
  preview and the native render share shaders and match pixel for pixel. Skia (skia-safe native, CanvasKit on the
  web) is the more mature fallback if Vello's text or filter quality falls short.
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
- **Real 3D: real Three.js first, kiss3d as backup** (revised 2026-10-14 with the Node decision). With Node as host,
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
| `@remotion/three` | real Three.js on `WebGPURenderer` + Dawn (section 4); kiss3d mapping as backup; GLSL `ShaderMaterial` falls back | 3D layer | after 3 |
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
  rotateX/Y, translateZ, depth sort), motion blur, ffmpeg encode (`render`).
- **2c: performance** (before Phase 3's comparison, whose go/no-go needs 5x+ over Remotion). A papercut diorama
  using the 2a effects (1080x1920, 34 layers, 30 effects, most layers with two drop shadows) measured 213–313 ms per
  frame in `bench` on the M4 (2026-10-14, two runs of frame 60), of which composite was ~234 ms, raster ~64 ms and
  PNG encode ~36 ms. Rendering 90 frames with one `still` process per frame took 37 s (~410 ms/frame). Work items:
  - Run each effect pass only over the layer's bounding box plus the effect's reach, not the whole padded canvas.
    Today a 200 px layer's shadow blurs as many pixels as a full-screen layer's.
  - Blur shadows at lower resolution.
  - Cache layers that stop changing (the diorama's hills are still from frame 41 but are re-rasterised and
    re-blurred every frame).
  - Frame-range rendering that keeps one GPU setup and overlaps encoding with the next frame (fold into 2b's
    `render`).
  - Phase 1's three costly choices, each kept for a reason that any replacement must still meet:
    - **16x MSAA** (chosen over Vello's `Area` mode for byte-identical frames, see §10). Try 8x MSAA (Vello has an
      `msaa8` config) and keep it if frames stay byte-identical and the goldens pass by eye; rasterise only each
      layer's bounds (follows from the per-layer textures below); revisit `Area` if Vello makes its coverage order
      deterministic.
    - **The resampled Gaussian blur** (replaced dual Kawase in `139171a` because Kawase snapped small moving layers to
      a coarse grid). Halve the taps with the bilinear trick (one fetch between two texels weighted for both);
      draw the shadow of a `rect`, `roundedRect` or `ellipse` with no blur at all, as a closed-form Gaussian (an erf
      expression in the fragment shader, exact for rectangles and close for rounded ones), which covers most papercut
      shadows; blur only the layer's bounds plus reach.
    - **A full padded-canvas texture per layer** (the pool hands out one size, canvas plus twice the margin). Size
      each layer texture to its bounds plus its effects' reach and composite it at an offset; pool by size class;
      skip the separate buffer for a group that does not need one (normal blend, opacity 1, no effects, clip, mask
      or matte) and draw its children straight into the parent.
  Measure each change with `bench` before and after, and keep the blur position and sigma tests (`tests/blur.rs`) and
  the goldens passing; none of the gains above are measured yet.
**Phase 3: authoring + agents.** The N-API addon (napi-rs) exposing the Rust core; the `@kinetograph/core` TS
package: Remotion shim, `react-reconciler` host config emitting the scene graph, determinism shim; Web Audio via
`node-web-audio-api`; the `kinetograph` CLI in TS and the MCP server; the Remotion package table in section 5;
per-glyph text animation. Open with two spikes: (1) the addon handoff cost per frame in `bench`; (2) Three.js
`WebGPURenderer` headless on Dawn in Node (section 4), which decides Three.js vs kiss3d for the 3D layer.
Rebuild the 5-second reference and the papercut scene. Compare frames and timing against Remotion. Go/no-go here:
if it isn't clearly faster (5x+) and visually matching, rethink the wedge.
**3D layer (after Phase 3).** Three.js on Dawn, or the kiss3d mapping if the spike fails (section 4).
**Phase 4: editor.** Tauri shell, WASM + WebGPU preview, timeline, video layers.
**Phase 5: Remotion compat mode.** CSS subset mapped onto layers (possibly via Blitz/Stylo), Chrome fallback per frame
range, `doctor`.

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

## 9. Rules for the build

- `random(seed)` must be bit-exact with Remotion's implementation (the papercut kit seeds all jitter with it), but
  reimplement Remotion APIs from their public behaviour. Remotion's licence restricts copying its source.
- Rendering is a pure function of (project, frame). Nothing reads the wall clock.
- Never measure text before fonts are registered (the papercut pipeline had a banner jitter bug from this).
- Speed claims are measured, never assumed. `bench` exists from Phase 1.
- Fallback must work per frame range, not per scene: transitions overlap two scenes.

## 10. Open questions

- Three.js `WebGPURenderer` headless on Dawn in Node: unverified (section 4). Decides Three.js vs kiss3d.
- `react-reconciler` host config details: which React features (Suspense, context, portals) the scene graph needs.
- Vello's filter/text quality vs Skia. Test early with the papercut grain + torn edge.
- Licence for Kinetograph itself (MIT/Apache-2.0 matches the ecosystem; fframes is MIT).
- Blend space. The compositor blends in linear light (section 4). CSS, and so Remotion, blends in sRGB space, so
  `multiply`, `screen` and `softLight` will look different from a Remotion render of the same layers. Decide before
  Phase 3's comparison whether Remotion-compat needs an sRGB blend path.
- Anti-aliasing. Vello's analytic `Area` mode gave frames that differed by a level or two between runs (GPU thread
  timing changes the order coverage is summed in), so the renderer uses 16x MSAA, which is repeatable. Revisit if edge
  quality matters more than exact repeatability, or when Vello fixes the ordering.
- Final name.
