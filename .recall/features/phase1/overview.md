# phase1

**Status:** stable
**Paths:** `crates/**`, `examples/**`, `assets/**`, `packages/cli/skills/kinetograph/references/SCENE.md`
**Last touched:** 2026-10-14

## What this is
HANDOFF §8 Phase 1: Rust workspace, GPU compositor with shape/text/image/group layers, blur, blend modes, PNG `still`, `bench`. Input is a JSON scene graph (packages/cli/skills/kinetograph/references/SCENE.md), the shape Phase 3's reconciler will emit.

## Current state
- crates/core (kinetograph-core), crates/cli (binary `kinetograph`: `still`, `bench`, both `--json`).
- Pins: vello 0.11.0, parley 0.12.0, wgpu 30.0.1 (via vello::wgpu), image 0.25.10, clap 4.6.7.
- Pipeline: Vello rasterises each leaf to Rgba8 (sRGB) → WGSL converts to linear premultiplied Rgba16Float → effects → W3C blend (all 16 modes) ping-pong → sRGB encode → readback → PNG.
- Blur: position-stable Gaussian (tent downsample, separable Gaussian, bilinear upsample). Dual Kawase was built first and rejected: small layers snapped to a coarse grid.
- Determinism: byte-identical across processes. Needed AaConfig::Msaa16 (Vello's Area AA was nondeterministic at a few text edge pixels).
- Bench (release, M4, papercut-card frame 30, 10 runs): total mean 46.3 ms; raster 18.6, composite 27.2, readback 1.8, png 22.0 (stages GPU-synced, so they sum above total). Setup 69 ms per process. Remotion baseline: ~157 ms/frame, ~2 s per still.
- Tests: 17 unit, blend 1, blur 4, golden 3, render 6. Goldens exact-match, M4/Metal only; UPDATE_GOLDEN=1 regenerates.

## Open threads
- [ ] Vello 0.11 image-atlas bug: workaround is a second vello::Renderer for image layers. Report upstream to linebender/vello.
- [ ] Missing image file only detected at render time; error lacks resolved path (final review minor).
- [ ] Blur allocates textures/bind groups per call, bypassing pool. Measured 2026-10-14: peak RSS of `bench papercut-card` grows 169 MB (5 runs) → 282 (20) → 370 (60, plateau); basic.json (no blur) stays 75 MB. Fix in Phase 2a (pool reuse).
- Memory vs Remotion (same M4, 2026-10-14, process-tree peak RSS): our still 128 MB vs Remotion still 1053 MB (8x); our bench steady state 370 MB vs Remotion S04 render 967 MB at concurrency 1, 1624 MB at 4 (2.6–4.4x). Different scenes (papercut-card vs ep13 S04); Node host will add ~50–80 MB to ours.
- [ ] Every leaf is a full-canvas texture + 2 passes; composite is the largest stage. Optimise when Phase 2 adds more layers.
- [ ] Unknown JSON keys silently ignored (serde flatten + tagged enum).
- [x] HANDOFF roadmap rewritten (user approved 2026-10-14): Phase 2 split 2a (masks/clip paths first, shadows, colour, gradients, backdrop blur, glow, chromatic aberration, custom WGSL) / 2b (looks, 2.5D camera, motion blur, ffmpeg); Phase 3 runtime benchmark + §5 Remotion package table; cloud-session rules in §8.
- [x] Phase 2a runs in a Claude Code cloud session (user's call): cloud writes code and runs only build/fmt/clippy/`cargo test --lib`; GPU tests, goldens, still, bench on the M4 after pull.
- [x] 3D plan in HANDOFF §4: Three.js first (Node host), kiss3d 0.47 backup with r3f vocabulary mapping; `three` crate dead (2019).
- [x] Runtime decided 2026-10-14: Node hosts, Rust engine as N-API addon (napi-rs). Deno runtime ends dev in a year (2026-10-09 news); rquickjs/Boa lose on coverage; Bun loads the addon. Measured: JS 0.78 ms/frame, GPU ~24, encode ~4.1 → ~29 ms serial (5.4x Remotion). 3D: real Three.js on Dawn (`webgpu` npm) first, kiss3d backup; headless unverified. Lottie: ThorVG via dotlottie-rs. All in HANDOFF §4/§8/§10.

## Key files
- crates/core/src/{scene,resolve,anim,render,compositor,blur,text}.rs, crates/core/src/shaders/
- examples/papercut-card.json, crates/core/tests/golden/
- packages/cli/skills/kinetograph/references/SCENE.md
