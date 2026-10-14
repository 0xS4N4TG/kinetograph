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
- **Fix-loop speed.** TS running in an embedded JS engine hot-reloads in milliseconds. A Rust authoring API (fframes)
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
   guide says to use `sox` for placeholder sounds). Kinetograph exposes the Web Audio API, backed by
   `web-audio-api-rs`, to the JS runtime, so the oscillator/envelope/filter code Claude already writes runs unchanged
   and offline, sample-accurate to frames.
4. **Compositor built-ins**: blend modes, track mattes and masks, 2.5D camera, motion blur and an effect graph as
   first-class primitives, not hand-written shaders.

Decided 2026-10-14: own the engine, built from scratch, not on top of fframes. Point 4 needs a compositor fframes'
SVG-per-frame model doesn't have. fframes stays a reference for CLI design and pipeline ideas (no code copied).
Phase 0's fframes runs are recorded in `phase0/` as evidence, not as a gate.

## 4. Architecture

```
TS/TSX project (Remotion-shaped API, Web Audio API)
        │  bundled with esbuild
        ▼
Embedded JS runtime (deno_core/V8, or rquickjs)
  - remotion shim (frame clock, interpolate, spring, random, Sequence...)
  - custom React reconciler  ──►  scene graph (layers, props, effects) per frame
  - Web Audio API bindings   ──►  web-audio-api-rs OfflineAudioContext
        │
        ▼
Rust core
  layout:     taffy (flex/grid)
  text:       parley + swash + fontique (shaping, wrapping, fallback); glyph positions exposed for kinetic type
  vector:     vello → textures   (SVG via usvg → vello_svg, Lottie via velato)
  compositor: layer tree → render targets → effect graph → blend, linear light, f16 textures
  effects:    WGSL shaders
  3D:         2.5D camera, layers as textured quads, depth sort, optional DOF (glam for maths)
  motion blur: N sub-frames accumulated
        │
        ▼
Media: ffmpeg-next (libav) decode/encode, VideoToolbox/NVENC; symphonia for audio decode
Pipeline threads: decode → render → async GPU readback → encode
        │
        ├── CLI + MCP server (rmcp)    agent surface
        └── Tauri editor               preview; same core compiled to WASM + WebGPU in the webview
```

Decisions and why:

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
| Gaussian blur (dual Kawase), backdrop blur (frosted glass) | reference, papercut `RackFocus` |
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

## 7. Agent surface

CLI first, MCP server (`rmcp`) wrapping the same commands. Every command takes `--json`.

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
**Phase 2: effects.** Gradient map, halftone, dither, displacement, grain; 2.5D camera; motion blur; ffmpeg encode.
**Phase 3: authoring + agents.** Embedded JS runtime, Remotion shim, reconciler, Web Audio bindings, MCP server.
Rebuild the 5-second reference and the papercut scene. Compare frames and timing against Remotion. Go/no-go here:
if it isn't clearly faster (5x+) and visually matching, rethink the wedge.
**Phase 4: editor.** Tauri shell, WASM + WebGPU preview, timeline, video layers.
**Phase 5: Remotion compat mode.** CSS subset mapped onto layers (possibly via Blitz/Stylo), Chrome fallback per frame
range, `doctor`.

## 9. Rules for the build

- `random(seed)` must be bit-exact with Remotion's implementation (the papercut kit seeds all jitter with it), but
  reimplement Remotion APIs from their public behaviour. Remotion's licence restricts copying its source.
- Rendering is a pure function of (project, frame). Nothing reads the wall clock.
- Never measure text before fonts are registered (the papercut pipeline had a banner jitter bug from this).
- Speed claims are measured, never assumed. `bench` exists from Phase 1.
- Fallback must work per frame range, not per scene: transitions overlap two scenes.

## 10. Open questions

- deno_core (V8, fast, big binary) vs rquickjs (small, slower) for the runtime.
- Own reconciler vs `react-dom` on a DOM shim. Own reconciler is likely simpler for native elements.
- Vello's filter/text quality vs Skia. Test early with the papercut grain + torn edge.
- Licence for Kinetograph itself (MIT/Apache-2.0 matches the ecosystem; fframes is MIT).
- Blend space. The compositor blends in linear light (section 4). CSS, and so Remotion, blends in sRGB space, so
  `multiply`, `screen` and `softLight` will look different from a Remotion render of the same layers. Decide before
  Phase 3's comparison whether Remotion-compat needs an sRGB blend path.
- Anti-aliasing. Vello's analytic `Area` mode gave frames that differed by a level or two between runs (GPU thread
  timing changes the order coverage is summed in), so the renderer uses 16x MSAA, which is repeatable. Revisit if edge
  quality matters more than exact repeatability, or when Vello fixes the ordering.
- Final name.
