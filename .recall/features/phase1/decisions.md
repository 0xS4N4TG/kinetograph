# phase1 — decisions

## JSON scene graph as Phase 1 input
**Date:** 2026-10-14
**Call:** Scenes are JSON with keyframed numbers; same shape the Phase 3 reconciler will emit.
**Why:** No JS runtime until Phase 3; nothing thrown away.

## Linear-light compositing
**Date:** 2026-10-14
**Call:** Blend in linear f16 per HANDOFF §4. CSS/Remotion blend in sRGB, so multiply/screen/soft-light differ; logged in HANDOFF §10, no setting added.

## MSAA16 instead of Vello Area AA
**Date:** 2026-10-14
**Call:** AaConfig::Msaa16. **Why:** Area AA produced two different outputs for the same frame; determinism rule wins. Same speed in bench.

## Position-stable Gaussian instead of dual Kawase
**Date:** 2026-10-14
**Call:** Replace dual Kawase. **Why:** Reviewer showed small blurred layers snapping by tens of px and sigma 20-25% low; new blur: centre error <0.05 px, sigma within ~4%.

## Third-party video crops stay local
**Date:** 2026-10-14
**Call:** phase0 p*.jpg and compare/ gitignored, like the mp4. Test images are procedural with fixed seeds.

## Real 3D via kiss3d, not Three.js
**Date:** 2026-10-14
**Call:** User: "kiss3d should be good". Map r3f vocabulary onto kiss3d 0.47 (wgpu 30, shares our device); write missing geometry generators (torus, torus knot, ring, polyhedra, lathe, tube, extrude) ourselves.
**Why:** Three.js needs WebGL/WebGPU inside the JS runtime. `three` crate dead (2019, gfx/OpenGL); three-d is OpenGL; Bevy too heavy; raw wgpu has no meshes/materials/lights.
**Tradeoff:** custom GLSL shaders and imperative THREE code don't port.

## Node hosts the engine as an N-API addon
**Date:** 2026-10-14
**Call:** Node (or Bun) runs agent TS; Rust core ships as a napi-rs addon. Replaces embedded runtime (rquickjs/deno_core).
**Why:** User: coverage and usability over binary size. Deno runtime ending (Cloudflare, 2026-10-09). react-reconciler and node-web-audio-api exist as packages.
**Tradeoff:** needs Node installed; determinism shim in TS; prebuilt addons per platform.

## Lottie via ThorVG (dotlottie-rs), 3D via real Three.js on Dawn
**Date:** 2026-10-14
**Call:** velato rejected (missing split positions, text, images, dash). Three.js WebGPURenderer on `webgpu` npm first; kiss3d backup pending headless spike.
