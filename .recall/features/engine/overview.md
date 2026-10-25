# engine

**Status:** active
**Paths:** `crates/**`, `vendor/**`, `packages/core/**`, `packages/compat/**`, `packages/cli/src/**`, `packages/cli/skills/kinetograph/references/ENGINE.md`
**Last touched:** 2026-10-25

## What this is
The renderer: Rust compositor (Skia/Graphite default, Vello fallback), DOM islands (vendored blitz/stylo/taffy), the TS frame loop and CLI.

## Current state
- main a5baead7: PRs #5 datamosh (Skia mosh_image), #7 GSAP, #8 text fixes (glyph-ink-sized text layers keep descenders/glow; -webkit-text-stroke + paint-order), #9 WebGL gaps merged. Main's addon rebuilt 15:44 with all of them.
- Determinism holds: launch film lossless identical c1 vs c4 and across runs after every merge (PR #8 changed 498/1194 frames on purpose: glow/descender edges).
- Toolchain trap: Homebrew /opt/homebrew/bin/rustc aborts (missing libz3). Build with PATH=/opt/homebrew/opt/rustup/bin:$PATH (~/.cargo/bin has no rustc on this Mac). CARGO_TARGET_DIR=<repo>/target shared; per-agent target-* dirs deleted when done.
- In flight: fix/svg-cascade (SVG styled from the page CSS cascade + @font-face in svg text + audio decode for moov-at-end MP4; replaces HyperFrames TS workarounds svg-style.ts/pinSvgFonts); feat/webgpu (WebGPU recording shim replayed on our wgpu device).
- Worker scaling: launch film ~28-30 s at any --concurrency; scale-out plan parked below.
- 8 pre-existing clippy lints in crates/core; 2 pre-existing tsc errors in packages/cli/test (render-parallel.test.ts, fixtures/seq-media) also on main.
- Machine: parallel cargo builds + renders caused SIGKILL 137 on renders (memory pressure); disk ~21 GB free.

## Open threads
- [ ] Clean the 8 crates/core clippy lints
- [ ] CLI should log which backend/device it uses (GPU Skia vs CPU Skia vs Vello)
- [ ] Audio test off-by-one (squareA 11917 vs 11918); cli test tsc errors fixed in #22; scene test tsc errors (test/webgpu.test.ts:50-55) still on main
- [ ] 45 Skia "non-invertible transform" warnings on papercut ep 13 (unchecked)
- [ ] Profile why launch film does not scale with workers
- [ ] FUTURE (user asked 2026-10-25 to park it): scale-out rendering pipeline, in this order:
  1. Chunked rendering: split frames into ranges, render + encode each range separately (machine/container/Lambda), join losslessly with ffmpeg concat (same encoder settings, keyframe at each chunk start), mix audio once. Deterministic frames mean seams cannot drift.
  2. Local parallel CPU encode: libx264 per chunk instead of one VideoToolbox session (VT caps ~218 fps and does not scale with sessions; Linux/Windows have no VT).
  3. Cloud: a `kinetograph render --chunk` primitive, then AWS Lambda and Cloud Run wrappers (no Chrome layer, so a much smaller bundle than Remotion/HyperFrames).
  Context: Remotion scales via --concurrency Chrome tabs + Lambda chunks; HyperFrames via `render --workers N` + AWS Lambda/Cloud Run chunk stitching (packages/aws-lambda, gcp-cloud-run). Ours: launch film ~28-30 s at any --concurrency (encoder + memory bandwidth + shared GPU bound).
- [ ] UNDECIDED (user 2026-10-25: both options still to choose from, not started): drawing the HyperFrames `effects` list (18 effects in `data-color-grading`: blur, bloom, kuwahara, chromaBleed, pixelate, halftone, twoInkPrint, ascii, dither, monoScreen, scanlines, chromaticAberration, crtCurvature, engraving, crosshatch, digitalGlitch, tapeDamage, filmArtifacts). Today they are reported, not drawn. The effect code lives in HyperFrames' player (heygen-com/hyperframes `packages/core/src/runtime/colorGrading.ts`, 4313 lines, Apache-2.0; plain WebGL), not in projects, and our loader replaces that player. Start after feat/hf-grading-fast-styles merges.
  - Option A, "pinned copy": save their effects file in our repo exactly as at one HF version and run it unchanged on our WebGL, for elements with `effects` only (keep our native grading pass). Needs: video frames into WebGL textures, `requestVideoFrameCallback` on the frame clock, drawing the canvas it inserts in place of the video, glue in packages/core/src/hyperframes/runtime.tsx, Apache LICENSE + NOTICE. Updating = a script copies their newer file in, then run the 18 effect tests vs HF renders. Hand work only if they rename what our glue calls. Exact by construction; a bit slower (WebGL path).
  - Option B, "porting script" (user's idea): each update, a script pulls their shaders out and converts GLSL to WGSL (naga) into our native GPU pass. The code around the shaders (which setting feeds which shader, pass order, multi-pass blur/bloom) cannot be converted reliably, so it is re-ported by hand when they change it. Fully native and fastest; no WebGL video work needed.
  - I recommended A (less hand re-porting). Both run the same tests vs HyperFrames' own renders.

## Key files
- `vendor/blitz-dom/src/layout/inline.rs` (baseline fix; noted in vendor/README.md)
- `crates/core/src/render/skia/vulkan.rs:97`
- `crates/dom/src/paint/svg/serialize.rs` (computed_font), `crates/dom/src/paint/svg/mod.rs` (font warnings)
- `packages/core/src/frame-loop.tsx:118` (drawFrame: sequential vs replay, breakSamplePasses)
- `packages/compat/src/dom/index.ts:57` (samplePass, incremental islands; KINETOGRAPH_NO_INCREMENTAL=1)

## Recent sessions
- 2026-10-25-pipeline-expansion — datamosh, GSAP, text fixes, WebGL merged; svg-cascade + WebGPU in flight; rustup PATH trap
- 2026-10-25-release-and-fixes — Skia default; launch film now identical at 1 vs 4 workers (island baseline fix); workers do not speed the launch film
